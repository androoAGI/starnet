/* node test/channels.station-key.test.js — a channel record never holds the STATION'S key, so a per-run endpoint never
   carries it anywhere (review r5, the major).

   The bug: the Telegram/Discord/generic connect, the owner-revoke restart and the env auto-starts saved the key the station
   RESOLVED (the keychain/runtime push, the operator's env key) into channelSecrets.<ch>.key. That copy then counted as "the
   caller's own" key: a later connect naming { baseUrl: <anywhere> } and no key was honoured and saved, and every inbound
   message sent the station's key there. It also froze the endpoint of the day the bot connected, and on a headless station
   wrote the env key into secrets.json in plaintext.

   Everything below runs the REAL sidecar source, lifted by name (test/helpers/source.js): the resolvers
   (providerRuntimeKey, providerOperatorKey, pageCopyRidesWith, providerRuntimeBaseUrl), the three connect handlers and the
   connect gate (stationHubConnectError -> stationHubRunConfig -> channelRunConfigFor), each start function's own per-message
   secrets() block, the owner-revoke restart, the boot auto-start block and the load-time scrub. The start functions are
   stood in for by their own persistence line, which a source lock below pins. Every section fails on the commit before. */
'use strict';
const A = require('./_assert.js');
const { sidecarFunctionSource, sidecarTopLevelFunction } = require('./helpers/source.js');
const Reg = require('../sidecar/providers/registry.js');
const SecretsMod = require('../sidecar/channels/secrets.js');

const lift = name => { const s = sidecarFunctionSource(name); A.ok(s.length > 20, 'fixture: ' + name + ' is lifted'); return s; };
const top = name => { const s = sidecarTopLevelFunction(name); A.ok(s.length > 20, 'fixture: ' + name + ' is lifted'); return s; };

const STATION_OR = 'sk-or-STATION-KEYCHAIN';
const EVIL = 'https://collector.example/v1';
const PROXY = 'https://commander-proxy.example/v1';

// ---- the start functions persist exactly the key and endpoint they are handed (the stand-ins below copy this line) ----
{
  const tg = top('startTelegram'), dc = top('startDiscord'), gen = top('startGenericChannel');
  A.ok(/telegram: \{\n\s+token: token, key: key, model: model, provider: provider, baseUrl: cfg\.baseUrl \|\| cfg\.base_url \|\| '',/.test(tg), 'startTelegram saves the key and endpoint it is handed');
  A.ok(/discord: \{\n\s+token: token, key: key, model: model, provider: provider, baseUrl: cfg\.baseUrl \|\| cfg\.base_url \|\| '',/.test(dc), 'startDiscord saves the key and endpoint it is handed');
  A.ok(/token: token \|\| undefined, key: key, model: model, provider: provider,\n\s+baseUrl: cfg\.baseUrl \|\| cfg\.base_url \|\| '',/.test(gen), 'startGenericChannel saves the key and endpoint it is handed');
}

// the per-message secrets() block of each start function, executed against the saved record
function secretsBlock(fn) {
  const m = /\n\s+secrets: \(\) => \{\n([\s\S]*?\n\s+return \{ key[^\n]*\};)\n\s+\},\n/.exec(top(fn));
  A.ok(!!m, 'fixture: ' + fn + "'s per-message secrets() is sliced");
  return m ? m[1] : 'return {};';
}
const SECRETS = { telegram: secretsBlock('startTelegram'), discord: secretsBlock('startDiscord'), slack: secretsBlock('startGenericChannel') };

const RESOLVERS = ['providerRuntimeKey', 'providerOperatorKey', 'pageCopyRidesWith', 'providerRuntimeBaseUrl', 'normalizeProviderId'];
const HELPERS = ['unknownProviderError', 'channelConnectCredential'].map(n => sidecarFunctionSource(n)).filter(Boolean);
const HANDLERS = ['channelRunConfigFor', 'stationHubRunConfig', 'stationHubConnectError', 'handleChannelConnect', 'handleDiscordConnect',
  'handleGenericChannelConnect', 'handleChannelSync', 'handleDiscordSync', 'handleGenericChannelSync', 'handleTelegramBotAdd',
  'restartTelegramAfterOwnerRevoke', 'channelKeyIsStationHeld', 'scrubChannelStationKeys'];

/* One station: its runtime keys/endpoints (the desktop push), operator env, page copy, roster, saved channel records. */
function station(opts) {
  const o = opts || {};
  const env = Object.assign({}, o.env || {});
  const roster = new Map(Object.entries(o.roster || { agent: { name: 'NOVA', model: 'openai/gpt-5', provider: 'openrouter' } }));
  const deps = {
    normalizeProvider: v => Reg.normalizeProviderId(v, 'openrouter'),
    normalizeProviderIdFromRegistry: Reg.normalizeProviderId,
    getProviderProfile: Reg.getProviderProfile,
    registryProviderUsesCodex: id => id === 'codex',
    providerUsesCodex: p => Reg.normalizeProviderId(p, 'openrouter') === 'codex',
    resolveCreditsConfig: () => ({ url: '', apiKey: '' }),
    envFirst: names => { for (const n of names || []) if (env[n]) return env[n]; return ''; },
    engineKeys: { get: id => (o.pageCopy && o.pageCopy[id]) || null },
    agentRoster: roster,
    runWireFor: id => { const a = roster.get(String(id || 'agent')) || roster.get('agent'); return { ok: true, provider: a.provider, model: a.model, source: 'agent', reasoningEffort: 'medium' }; },
    chatModelId: (p, m) => m,
    resolveReasoningEffort: (p, e) => e || 'medium',
    normalizeReasoningEffort: e => String(e || 'medium'),
    providerHasCredential: (p, k, b) => !!String(b || '').trim() && (Reg.getProviderProfile(p).keyRequired === false || !!String(k || '').trim()),
    providerCredentialError: p => 'connect a ' + p + ' API key',
    expiredSignInNote: () => '',
    readBody: null, CHANNEL_BODY_MAX: 1 << 20, channelBodyError: () => 'bad json',
    channelToken: (id, t, s) => String(t || '').trim() || (s && s.token) || 'tok-' + id,
    channelTokenRuntime: { telegram: 'tok-telegram', discord: 'tok-discord', slack: 'xoxb-1 xapp-1' },
    parseSlackTokens: () => ({ botToken: 'xoxb-1', appToken: 'xapp-1' }),
    issueTelegramOwnerPairing: () => ({ ok: true, code: 'PAIR', expiresAt: 0 }),
    withOwnerPairing: (id, out) => out,
    saveChannelSecrets: () => { saves.n++; return true; },
    telegram: {}, stopTelegram: () => {},
    console: { warn: m => warns.push(String(m)), log() {} },
    channelSecretsMod: SecretsMod
  };
  const saves = { n: 0 }, warns = [];
  const names = Object.keys(deps);
  const body = `
    let channelSecrets = ${JSON.stringify(o.secrets || {})};
    const runtimeKeys = Object.assign(Object.create(null), ${JSON.stringify(o.runtimeKeys || {})});
    const runtimeBaseUrls = Object.assign(Object.create(null), ${JSON.stringify(o.runtimeBaseUrls || {})});
    let runtimeKey = String(runtimeKeys.openrouter || '');
    const telegramStatus = { connected: false, state: 'connecting' }, discordStatus = { connected: false, state: 'connecting' }, genericStatus = {};
    const started = [];
    // the start functions' own persistence line (pinned by the source lock above)
    function startTelegram(token, key, model, cfg) { started.push({ ch: 'telegram', key }); channelSecrets = Object.assign({}, channelSecrets, { telegram: { token: token, key: key, model: model, provider: normalizeProvider(cfg.provider), baseUrl: cfg.baseUrl || cfg.base_url || '', enabled: true, agentId: cfg.agentId || undefined } }); return { secretsPersisted: true }; }
    function startDiscord(token, key, model, cfg) { started.push({ ch: 'discord', key }); channelSecrets = Object.assign({}, channelSecrets, { discord: { token: token, key: key, model: model, provider: normalizeProvider(cfg.provider), baseUrl: cfg.baseUrl || cfg.base_url || '', enabled: true, agentId: cfg.agentId || undefined } }); return { secretsPersisted: true }; }
    function startGenericChannel(id, token, key, model, cfg) { started.push({ ch: id, key }); const p = {}; p[id] = { token: token || undefined, key: key, model: model, provider: normalizeProvider(cfg.provider), baseUrl: cfg.baseUrl || cfg.base_url || '', enabled: true, agentId: cfg.agentId || undefined }; channelSecrets = Object.assign({}, channelSecrets, p); return { secretsPersisted: true }; }
    function startTelegramBot() {}
    ${RESOLVERS.map(lift).join('\n')}
    ${HELPERS.join('\n')}
    ${HANDLERS.map(n => sidecarFunctionSource(n)).join('\n')}
    const perMessage = {
      telegram: () => { ${SECRETS.telegram} },
      discord: () => { ${SECRETS.discord} },
      slack: () => { const id = 'slack'; ${SECRETS.slack} }
    };
    return {
      providerRuntimeKey, providerRuntimeBaseUrl, stationHubRunConfig, restartTelegramAfterOwnerRevoke,
      handleChannelConnect, handleDiscordConnect, handleGenericChannelConnect, handleChannelSync, handleDiscordSync, handleGenericChannelSync, handleTelegramBotAdd,
      scrubChannelStationKeys: typeof scrubChannelStationKeys === 'function' ? scrubChannelStationKeys : null,
      unknownProviderError: typeof unknownProviderError === 'function' ? unknownProviderError : null,
      perMessage, started, runtimeBaseUrls, runtimeKeys,
      get: () => channelSecrets, set: v => { channelSecrets = v; }
    };`;
  let reqBody = {};
  deps.readBody = async () => JSON.stringify(reqBody);
  const api = new Function(...names, body)(...names.map(n => deps[n]));
  api.saves = saves; api.warns = warns;
  api.call = async (handler, b, ...extra) => {
    reqBody = b; let status = 0, out = '';
    try { await api[handler]({}, { writeHead(s) { status = s; }, end(t) { out = String(t || ''); } }, ...extra); }
    catch (e) { return { status: 'threw: ' + ((e && e.message) || e), body: {} }; }   // the caller's assertion reports it
    let j = {}; try { j = JSON.parse(out); } catch (_) { j = {}; }
    return { status, body: j };
  };
  return api;
}

(async () => {
  // ================================ (b) the resolver: a station-held key never rides a per-run endpoint =================
  {
    const s = station({ runtimeKeys: { openrouter: STATION_OR, custom: 'sk-custom-KEYCHAIN' }, runtimeBaseUrls: { custom: 'http://lan-llm:8000/v1' },
      env: { ANTHROPIC_API_KEY: 'sk-ant-OPERATOR' } });
    A.eq(s.providerRuntimeBaseUrl('openrouter', EVIL, undefined, STATION_OR), 'https://openrouter.ai/api/v1',
      'the keychain key handed back as "the caller\'s own" never follows a per-run endpoint');
    A.eq(s.providerRuntimeBaseUrl('openrouter', EVIL, STATION_OR, STATION_OR), 'https://openrouter.ai/api/v1', '...nor when it is the run key too');
    A.eq(s.providerRuntimeBaseUrl('anthropic', EVIL, undefined, 'sk-ant-OPERATOR'), s.providerRuntimeBaseUrl('anthropic', ''),
      "the operator's env key handed back never follows a per-run endpoint: it goes to the configured anthropic endpoint");
    // controls: a caller's OWN key (not one the station holds) and a keyless run still take their endpoint
    A.eq(s.providerRuntimeBaseUrl('openrouter', PROXY, undefined, 'sk-or-CALLER-OWN'), PROXY, "a caller's own key still rides its own endpoint");
    const keyless = station({});
    A.eq(keyless.providerRuntimeBaseUrl('custom', 'http://127.0.0.1:1234/v1', undefined, ''), 'http://127.0.0.1:1234/v1', 'a keyless run still rides the endpoint it names');
    // the DESKTOP CUSTOM flow: the keychain key + the endpoint the window handed over (runtime push / provider-endpoints)
    // is the station's CONFIGURED endpoint, so it serves whether a body names it (no key: /api/run on the desktop) or a
    // record hands the keychain key back
    A.eq(s.providerRuntimeBaseUrl('custom', 'http://lan-llm:8000/v1', 'sk-custom-KEYCHAIN', ''), 'http://lan-llm:8000/v1', 'desktop CUSTOM: /api/run (no key) runs on the handed-over endpoint');
    A.eq(s.providerRuntimeBaseUrl('custom', 'http://lan-llm:8000/v1', undefined, 'sk-custom-KEYCHAIN'), 'http://lan-llm:8000/v1', 'desktop CUSTOM: the keychain key handed back still runs on the configured endpoint');
    A.eq(s.providerRuntimeBaseUrl('custom', 'http://elsewhere/v1', undefined, 'sk-custom-KEYCHAIN'), 'http://lan-llm:8000/v1', '...and never on another endpoint a record or body names');
    // the BROWSER page copy (engine-credential.js: the page's key and endpoint, one credential) keeps riding its own key
    const page = station({ pageCopy: { custom: { key: 'sk-page', baseUrl: 'http://page-llm/v1' } } });
    A.eq(page.providerRuntimeBaseUrl('custom', 'http://page-llm/v1', 'sk-page', 'sk-page'), 'http://page-llm/v1', 'browser: the page key with its own endpoint runs there');
    A.eq(page.providerRuntimeBaseUrl('custom', '', undefined, ''), 'http://page-llm/v1', 'browser: an unattended run on the page copy runs on its endpoint');
    A.eq(page.providerRuntimeBaseUrl('custom', 'http://other/v1', 'sk-page', 'sk-page'), 'http://other/v1', "browser: the page key is the caller's own (a per-run endpoint the page names rides it)");
  }

  // ================================ (a) two connects through the real handlers ==========================================
  for (const [handler, ch, extra] of [['handleChannelConnect', 'telegram', []], ['handleDiscordConnect', 'discord', []], ['handleGenericChannelConnect', 'slack', ['slack']]]) {
    const s = station({ runtimeKeys: { openrouter: STATION_OR } });
    const first = await s.call(handler, { token: 'tok', provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', baseUrl: '' }, ...extra);
    A.eq(first.status, 200, ch + ': the desktop connect (no key in the body; the keychain holds it) is accepted');
    A.eq(s.get()[ch].key, '', ch + ': the record keeps no station key');
    A.eq(s.get()[ch].baseUrl, '', ch + ': ...and no endpoint the station resolves on its own');
    A.eq(s.started[s.started.length - 1].key, '', ch + ': the start function is handed no station key');
    const second = await s.call(handler, { provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', baseUrl: EVIL }, ...extra);
    A.eq(second.status, 200, ch + ': a later connect naming an endpoint and no key is accepted');
    A.ok(s.get()[ch].baseUrl !== EVIL && !s.get()[ch].key, ch + ': ...and its endpoint is not saved, nor any key: ' + JSON.stringify({ key: s.get()[ch].key, baseUrl: s.get()[ch].baseUrl }));
    const live = s.stationHubRunConfig('agent', s.get()[ch]);
    A.eq([live.key, live.baseUrl], [STATION_OR, 'https://openrouter.ai/api/v1'], ch + ': every inbound message runs the station key on the configured endpoint (stationHubRunConfig)');
    const msg = s.perMessage[ch]();
    A.eq([msg.key, msg.baseUrl], [STATION_OR, 'https://openrouter.ai/api/v1'], ch + ": ...and on the hub's own secrets() resolution");
    // the stale endpoint: the Commander points OpenRouter at their own proxy after the bot connected
    s.runtimeBaseUrls.openrouter = PROXY;
    A.eq(s.stationHubRunConfig('agent', s.get()[ch]).baseUrl, PROXY, ch + ': a proxy configured later is followed (no endpoint frozen at connect)');
    A.eq(s.perMessage[ch]().baseUrl, PROXY, ch + ": ...by the hub's secrets() too");
    delete s.runtimeBaseUrls.openrouter;
    // a browser connect hands its OWN key and endpoint: kept together, and honoured
    const own = await s.call(handler, { token: 'tok', provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', key: 'sk-or-CALLER-OWN', baseUrl: PROXY }, ...extra);
    A.eq(own.status, 200, ch + ': a connect with its own key and endpoint is accepted');
    A.eq([s.get()[ch].key, s.get()[ch].baseUrl], ['sk-or-CALLER-OWN', PROXY], ch + ": the caller's own key and endpoint are saved together");
    A.eq(s.stationHubRunConfig('agent', s.get()[ch]).baseUrl, PROXY, ch + ": ...and its messages run there on the caller's key");
    // a later connect naming another endpoint without a key keeps the saved pair (a body endpoint goes only with the body's key)
    await s.call(handler, { provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', baseUrl: EVIL }, ...extra);
    A.eq([s.get()[ch].key, s.get()[ch].baseUrl], ['sk-or-CALLER-OWN', PROXY], ch + ": a keyless body endpoint never re-points the caller's saved key");
    // ...on a station that holds NO key of its own too: the body endpoint is checked against the key the run goes out on
    // (the saved one), never the station's empty resolution, so the saved key never follows it
    const bare = station({ secrets: { [ch]: { token: 'tok', key: 'sk-or-CALLER-OWN', model: 'openai/gpt-5', provider: 'openrouter', baseUrl: PROXY, agentId: 'agent' } } });
    await bare.call(handler, { provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', baseUrl: EVIL }, ...extra);
    A.eq([bare.get()[ch].key, bare.get()[ch].baseUrl], ['sk-or-CALLER-OWN', PROXY], ch + ': a keyless station: a body endpoint never carries the saved key');
    A.ok(bare.perMessage[ch]().baseUrl !== EVIL, ch + ': ...nor do its messages');
    // a NEW key in the body never inherits the endpoint an earlier connect saved for another key
    await bare.call(handler, { provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', key: 'sk-or-NEW' }, ...extra);
    A.eq([bare.get()[ch].key, bare.get()[ch].baseUrl], ['sk-or-NEW', ''], ch + ': a new key is saved without the endpoint the old key was saved with');
  }

  // ================================ the owner-revoke restart hands over the record's key only ===========================
  {
    const s = station({ runtimeKeys: { openrouter: STATION_OR } });
    s.restartTelegramAfterOwnerRevoke({ token: 'tok', model: 'openai/gpt-5', provider: 'openrouter', key: '', agentId: 'agent' });
    A.eq(s.started[0] && s.started[0].key, '', 'owner revoke: the restart saves no station key');
    A.eq(s.get().telegram.key, '', 'owner revoke: the record still holds no key');
    s.restartTelegramAfterOwnerRevoke({ token: 'tok', model: 'openai/gpt-5', provider: 'openrouter', key: 'sk-or-CALLER-OWN', agentId: 'agent' });
    A.eq(s.get().telegram.key, 'sk-or-CALLER-OWN', "owner revoke: a caller's own key is kept");
  }

  // ================================ the env auto-starts: the env key resolves live, never into secrets.json ============
  {
    const SRC = require('./helpers/source.js').readSidecarSource();
    const from = SRC.indexOf('  // auto-start a previously-connected Telegram bot');
    const to = SRC.indexOf('  // Restore EVERY saved connector into the manager');
    A.ok(from > 0 && to > from && to - from < 8000, 'fixture: the boot auto-start block is sliced');
    const block = SRC.slice(from, to);
    const handed = [];
    const ENVV = { STARNET_OPENROUTER_KEY: 'sk-or-ENV-OPERATOR', STARNET_DEFAULT_MODEL: 'openai/gpt-5' };
    const run = new Function('channelSecrets', 'channelToken', 'ENV', 'providerHasStoredCredential', 'providerRuntimeKey', 'providerRuntimeBaseUrl', 'channelFollowsReady',
      'startTelegram', 'startDiscord', 'startGenericChannel', 'startTelegramBot', 'telegramBotRecords', 'channelTokenRuntime', 'GENERIC_CHANNEL_IDS', 'console', block);
    run({}, () => '', k => ENVV['STARNET_' + k], () => false, () => '', () => '', () => false,
      (tok, key) => handed.push(['telegram', key]), (tok, key) => handed.push(['discord', key]), (id, tok, key) => handed.push([id, key]),
      () => {}, () => ({}), { telegram: 'tg-env', discord: 'dc-env', slack: 'xoxb-env xapp-env', matrix: 'mx-env' }, ['slack', 'matrix', 'signal'], { log() {}, warn() {} });
    A.eq(handed.map(h => h[0]), ['telegram', 'discord', 'slack'], 'fixture: the env-provided bots auto-start');
    A.ok(handed.every(h => h[1] === ''), 'an env auto-start hands its start function no key (the start saves what it is handed): ' + JSON.stringify(handed));
    const s = station({ runtimeKeys: { openrouter: 'sk-or-ENV-OPERATOR' } });
    s.set({ telegram: { token: 'tg-env', key: '', model: 'openai/gpt-5', provider: 'openrouter', baseUrl: '' } });
    A.eq(s.perMessage.telegram().key, 'sk-or-ENV-OPERATOR', '...and its messages still run on the env key, resolved live');
  }

  // ================================ (c) the load-time scrub: a saved station key is dropped, the bot keeps running ======
  {
    const legacy = {
      telegram: { token: 'tg', key: STATION_OR, model: 'openai/gpt-5', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: true, agentId: 'agent' },
      discord: { token: 'dc', key: 'sk-or-CALLER-OWN', model: 'openai/gpt-5', provider: 'openrouter', baseUrl: PROXY, enabled: true },
      slack: { token: 'xoxb', key: 'sk-ant-OPERATOR', model: 'claude-x', provider: 'anthropic', baseUrl: EVIL, enabled: true },
      telegramBots: { 42: { token: 'bot', key: STATION_OR, provider: 'openrouter', agentId: 'agent' } },
      notifyAutonomous: true
    };
    const pure = typeof SecretsMod.scrubStationKeys === 'function' ? SecretsMod.scrubStationKeys(legacy, (p, k) => k === STATION_OR || k === 'sk-ant-OPERATOR') : null;
    A.ok(pure && pure.changed, 'scrubStationKeys reports the change');
    A.eq(pure && pure.scrubbed, ['telegram', 'slack', 'telegramBots:42'], 'it names every record it scrubbed');
    A.ok(pure && !('key' in pure.config.telegram) && !('key' in pure.config.slack) && !('key' in pure.config.telegramBots['42']), 'the station keys are gone');
    A.eq(pure && pure.config.discord.key, 'sk-or-CALLER-OWN', "a caller-supplied key stays");
    A.eq(legacy.telegram.key, STATION_OR, 'the input is not mutated');
    const s = station({ runtimeKeys: { openrouter: STATION_OR }, env: { ANTHROPIC_API_KEY: 'sk-ant-OPERATOR' }, secrets: legacy });
    A.ok(typeof s.scrubChannelStationKeys === 'function', 'fixture: the load-time scrub is declared');
    const res = s.scrubChannelStationKeys ? s.scrubChannelStationKeys() : {};
    A.eq(res.scrubbed, ['telegram', 'slack', 'telegramBots:42'], 'at load, the records holding the keychain or operator key are scrubbed');
    A.eq(s.saves.n, 2, 'saved twice, so the recovery copy (.bak) holds the scrubbed records too');
    A.ok(s.warns.some(w => /dropped the station's own provider key from telegram, slack, telegramBots:42/.test(w)), 'and said once in the log');
    A.ok(!JSON.stringify(s.get()).includes(STATION_OR) && !JSON.stringify(s.get()).includes('sk-ant-OPERATOR'), 'no station key is left in any record');
    A.eq(s.get().discord.key, 'sk-or-CALLER-OWN', "the caller's own key is kept");
    // no bot stops working: each scrubbed record resolves the station key live, on the configured endpoint
    A.eq([s.perMessage.telegram().key, s.perMessage.telegram().baseUrl], [STATION_OR, 'https://openrouter.ai/api/v1'], 'the scrubbed Telegram bot runs on the station key, resolved live');
    const slackMsg = s.perMessage.slack();
    A.ok(slackMsg.key === 'sk-ant-OPERATOR' && slackMsg.baseUrl !== EVIL && slackMsg.configured, 'the scrubbed Slack bot runs on the operator key, never on the endpoint its old record named: ' + JSON.stringify({ baseUrl: slackMsg.baseUrl }));
    A.eq(s.stationHubRunConfig('agent', s.get().discord).baseUrl, PROXY, "the caller's own pair still runs where it was saved for");
    A.ok(/scrubChannelSecretsBak\(\);\n  \} catch \(e\) \{ console\.warn\('\[channels\] secret migration skipped:'[^\n]*\n\}\)\(\);\n[\s\S]{0,2400}?\nscrubChannelStationKeys\(\);\nconst channelStore = /.test(require('./helpers/source.js').readSidecarIndex()), 'the scrub runs once at load, right after the keychain migration');
  }
  // ...and (b) alone guards a legacy record the scrub has not reached: its saved station key never carries its endpoint
  {
    const s = station({ runtimeKeys: { openrouter: STATION_OR }, secrets: { telegram: { token: 'tg', key: STATION_OR, model: 'openai/gpt-5', provider: 'openrouter', baseUrl: EVIL, agentId: 'agent' } } });
    A.eq(s.stationHubRunConfig('agent', s.get().telegram).baseUrl, 'https://openrouter.ai/api/v1', 'a legacy record holding the station key never sends it to its saved endpoint (stationHubRunConfig)');
    A.eq(s.perMessage.telegram().baseUrl, 'https://openrouter.ai/api/v1', '...nor through secrets()');
  }

  A.report('channels.station-key: a channel record never holds the station key, and a per-run endpoint never carries it');
})().catch(e => { A.ok(false, 'channels.station-key threw: ' + ((e && e.stack) || e)); A.report('channels.station-key'); });
