/* node test/channels.station-key.test.js — a channel record never holds the STATION'S key, so a per-run endpoint never
   carries it anywhere (review r5, the major).

   The bug: the Telegram/Discord/generic connect, the owner-revoke restart and the env auto-starts saved the key the station
   RESOLVED (the keychain/runtime push, the operator's env key) into channelSecrets.<ch>.key. That copy then counted as "the
   caller's own" key: a later connect naming { baseUrl: <anywhere> } and no key was honoured and saved, and every inbound
   message sent the station's key there. It also froze the endpoint of the day the bot connected, and on a headless station
   wrote the env key into secrets.json in plaintext.

   Everything below runs the REAL sidecar source, lifted by name (test/helpers/source.js): the resolvers
   (providerRuntimeKey, providerRuntimeBaseUrl), the three connect handlers and the connect gate (stationHubConnectError ->
   stationHubRunConfig -> channelRunConfigFor), the hubs' per-message read (channelHubSecrets), the owner-revoke restart, the boot
   auto-start block and the boot's channel reconciliation. The start functions are stood in for by their own persistence line,
   which a source lock below pins. Every section fails on the commit before. A record holds a reference since the credential-store
   lane's step S8: each row reads what a bot's reference resolves to (channelCredential), and test/credential-store.channel-ref.e2e
   and channels.secrets section K prove the same on real files and a real station.
   The same station also proves, on the same real source:
     · the connect, sync and bots/connect routes refuse a provider this station does not know (review r5, minor 5);
     · runOnceCore's fallback loop skips a fallback on one, with a run notice (minor 6);
     · handleRun refuses a CUSTOM run whose named endpoint it cannot use, and notes any other endpoint it ignores (minor 3).
   Review r8 (the last three sections, each failing on the commit before):
     · F1 (major): a reconnect that switched provider with no key in the body saved the OLD provider's key under the new one
       (channelConnectCredential read saved.key whatever saved.provider was): an OpenRouter key went to a LAN CUSTOM server or
       to api.anthropic.com. A saved credential is reused only for the provider it was saved for.
     · F2/F3: a key the station already holds (the runtime push, the operator's env key, the #89 page copy) is never written
       into a record (connect, sync, bots/connect), so the record follows it live: a rotated or removed page key strands no old
       copy, and the boot has nothing to drop (no store / scrub / re-store churn: a bot runs the same pair before and after a
       restart, or is refused the same way before and after it: B2, TODO 4).
     · F4: a key that arrived in THIS /api/run body is the caller's own, so the body's endpoint rides with it (the page copy can
       lag the page's last change), in handleRun and in runOnceCore; a key read from a record or held by the station keeps the
       page-copy rule. (engine-credential.test.js runs runOnceCore's own lines.) CLOSED (review r8 minors 1-2, "F4 everywhere"):
       the voice route (applyVoiceTurnRoute: its hop, its catalog reads, the agent's route it builds as the hop's fallback), the
       fallback loop (that fallback and each /api/run body fallback, marked by handleRun), a team.dispatch worker on the lead's
       own key, and /api/providers/probe and /validate pass the provenance too; run-wire.request-key.test.js runs each caller.
       A lock below pins every caller and the exact counts.
     · F6 (i): a desktop run naming an endpoint the station has not been handed yet (its only answer is the provider default)
       is refused for a retry, never run on that default. A sign-in's and StarNet's endpoint is never handed over, so never
       theirs (keptEndpointProvider). A FAILED hand-over is tried again only at the next come-back (a station silence, a
       restart): the retry alone starts none (open: review r8 minor 6). F5 (keptEndpoints names the provider only) and F6 (i) on a real
       desktop sidecar: desktop-endpoint-handover.e2e.test.js; F6 (ii) endpointPersisted:false: set-key-body.test.js; the
       shell's refusal of a starnet key: provider-aliases-parity.test.js.
   TODO — handed to the wave-3 credential-store lane (found here, they predate this lane), now closed:
     1. RESOLVED (S8, decision 3): on the desktop, a channel's OWN provider key (a connect or bots/connect body key the station
        does not hold) lived in memory only, and after a restart the bot quietly ran on whatever the station resolved, or stopped.
        It still lasts for the session, since the OS keychain has no slot for it, but the connect answers keyPersisted: false,
        and after a restart the bot is refused with a sentence that names the exit. It never moves onto the station's key.
     2. RESOLVED (S8): on a browser/headless station that key stayed in plaintext in channels/secrets.json, and a REPLACED one
        survived in secrets.json.bak. It now lives in .secrets/channel-credentials.json, written main + .bak verified as the
        page copy's store is, and the record holds a reference.
     3. RESOLVED (S8): a key handed over while it was the caller's own, which LATER becomes station-held (the page saves the
        same key as its copy), turns its channel into a station reference at once (the store's convertChannels), so a page-copy
        rotation with no channel sync reaches it.
     4. RESOLVED (credential-store lane, S7): on a browser/headless station with the operator's CUSTOM env key E and no env
        URL, E outranked the page copy {K, its endpoint}, so a CUSTOM record that follows the station resolved {E, ''} and was
        refused from the page's sync onward. The station's own choice is a complete pair now: such a record follows the page
        copy's whole pair, K at its endpoint, before and after a restart, and E never goes there (B2). A keyless page URL
        replaces no key: E beside one stays refused, and the refusal names E as the half with no endpoint. */
'use strict';
const A = require('./_assert.js');
const { sidecarFunctionSource, sidecarTopLevelFunction } = require('./helpers/source.js');
const Reg = require('../sidecar/providers/registry.js');
const SecretsMod = require('../sidecar/channels/secrets.js');
const Friendly = require('../frontend/app/friendlyerror.js');
const { sandboxStore } = require('./helpers/credential-store-sandbox.js');

const lift = name => { const s = sidecarFunctionSource(name); A.ok(s.length > 20, 'fixture: ' + name + ' is lifted'); return s; };
const top = name => { const s = sidecarTopLevelFunction(name); A.ok(s.length > 20, 'fixture: ' + name + ' is lifted'); return s; };

const STATION_OR = 'sk-or-STATION-KEYCHAIN';
const EVIL = 'https://collector.example/v1';
const PROXY = 'https://commander-proxy.example/v1';

// ---- the start functions persist the reference they are handed, and no key or endpoint (the stand-ins below copy this line) ----
{
  const tg = top('startTelegram'), dc = top('startDiscord'), gen = top('startGenericChannel');
  A.ok(/telegram: \{\n\s+token: token, model: model, provider: provider, credential: cfg\.credential \|\| undefined,/.test(tg), 'startTelegram saves the reference it is handed');
  A.ok(/discord: \{\n\s+token: token, model: model, provider: provider, credential: cfg\.credential \|\| undefined,/.test(dc), 'startDiscord saves the reference it is handed');
  A.ok(/token: token \|\| undefined, model: model, provider: provider,\n\s+credential: cfg\.credential \|\| undefined,/.test(gen), 'startGenericChannel saves the reference it is handed');
  for (const [fn, text] of [['startTelegram', tg], ['startDiscord', dc], ['startGenericChannel', gen]]) A.ok(!/\bkey: key\b|baseUrl: cfg\./.test(text), fn + ' takes no key or endpoint at all');
}

// (credential-store lane, S1) index.js's resolvers are one-liners over the credential store; the store each station builds below
// from its own stubs (test/helpers/credential-store-sandbox.js) is the real one, so every assertion is the one it was
const RESOLVERS = ['providerRuntimeKey', 'providerRuntimeBaseUrl', 'normalizeProviderId', 'providerEndpointNotHandedOver'];
const HELPERS = ['unknownProviderError', 'channelConnectCredential', 'channelCredential', 'channelKeyLostError', 'channelHubSecrets', 'channelSyncCredential', 'channelCredentialAnswer'].map(n => sidecarFunctionSource(n)).filter(Boolean);
const HANDLERS = ['channelRunConfigFor', 'stationHubRunConfig', 'stationHubConnectError', 'handleChannelConnect', 'handleDiscordConnect',
  'handleGenericChannelConnect', 'handleChannelSync', 'handleDiscordSync', 'handleGenericChannelSync', 'handleTelegramBotAdd',
  'restartTelegramAfterOwnerRevoke', 'channelKeyIsStationHeld', 'reconcileChannelCredentials', 'channelsFollowStation', 'scrubChannelSecretsBak', 'channelFollowsReady'];
const SECRETS_FILE = '/station/.secrets/channels/secrets.json';
const PAGE_KEY = 'sk-or-PAGE-COPY';

/* One station: its runtime keys/endpoints (the desktop push), operator env, page copy, roster, saved channel records. A station boots
   as index.js does: the reconciliation runs over its records, unless o.noBoot (a row about that boot) says otherwise. */
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
    resolveCreditsConfig: () => o.credits || ({ url: '', apiKey: '' }),
    envFirst: names => { for (const n of names || []) if (env[n]) return env[n]; return ''; },
    engineKeys: { get: id => (o.pageCopy && o.pageCopy[id]) || null },
    agentRoster: roster,
    runWireFor: id => { const a = roster.get(String(id || 'agent')) || roster.get('agent'); return { ok: true, provider: a.provider, model: a.model, source: 'agent', reasoningEffort: 'medium' }; },
    chatModelId: (p, m) => m,
    resolveReasoningEffort: (p, e) => e || 'medium',
    normalizeReasoningEffort: e => String(e || 'medium'),
    providerHasCredential: (p, k, b) => !!String(b || '').trim() && (Reg.getProviderProfile(p).keyRequired === false || !!String(k || '').trim()),
    providerHasStoredCredential: (p, k, b) => !!String(b || '').trim() && (Reg.getProviderProfile(p).keyRequired === false || !!String(k || '').trim()),
    providerCredentialError: p => 'connect a ' + p + ' API key',
    expiredSignInNote: () => '',
    readBody: null, CHANNEL_BODY_MAX: 1 << 20, channelBodyError: () => 'bad json',
    channelToken: (id, t, s) => String(t || '').trim() || (s && s.token) || 'tok-' + id,
    channelTokenRuntime: { telegram: 'tok-telegram', discord: 'tok-discord', slack: 'xoxb-1 xapp-1' },
    parseSlackTokens: () => ({ botToken: 'xoxb-1', appToken: 'xapp-1' }),
    issueTelegramOwnerPairing: () => ({ ok: true, code: 'PAIR', expiresAt: 0 }),
    withOwnerPairing: (id, out) => out,
    // saveResilient: the CURRENT main goes to .bak, then the new main is written (nothing is written when it fails)
    saveChannelSecrets: obj => {
      saves.n++;
      if (o.saveFails) return false;
      if (files[SECRETS_FILE] != null) files[SECRETS_FILE + '.bak'] = files[SECRETS_FILE];
      files[SECRETS_FILE] = JSON.stringify(obj);
      return true;
    },
    // the disk the .bak scrub reads and rewrites (writeFileDurable)
    fs: { readFileSync: f => { if (files[f] == null) { const e = new Error('ENOENT: ' + f); e.code = 'ENOENT'; throw e; } return files[f]; } },
    path: require('path'), CHANNEL_SECRETS_FILE: SECRETS_FILE,
    writeFileDurable: (io, f, data) => { if (o.bakWriteFails) throw new Error('EPERM: the disk said no'); files[f] = String(data); },
    // bots/connect (handleTelegramBotAdd): getMe names bot 777; the run probe records the pair it was handed
    makeTelegramTransport: () => ({ getMe: async () => ({ ok: true, id: 777, username: 'nova_bot', name: 'Nova' }) }),
    telegramTransportFetch: () => null, TELEGRAM_API_BASE: 'https://api.telegram.invalid',
    probeChannelRunConfig: async cfg => { probes.push({ key: cfg.key, baseUrl: cfg.baseUrl }); return { ok: true }; },
    telegramOwnerPairing: { issue: () => ({ code: 'PAIR', state: { expiresAt: 0 } }) },
    telegramBots: { get: () => null },
    providerUsesDeviceOAuth: () => false,
    telegram: {}, stopTelegram: () => {},
    console: { warn: (...m) => warns.push(m.join(' ')), log() {} },
    channelSecretsMod: SecretsMod,
    engineCredential: require('../sidecar/engine-credential.js'),
    providerLabelOf: id => (Reg.getProviderProfile(id) || {}).label || id,
    isChannelTokenDurable: () => false,
    // the desktop app's shell hands this station its endpoints (the per-launch IPC token is set)
    SHELL_PUSHES_PROVIDER_CONFIG: !!o.desktop,
    sandboxStore
  };
  const saves = { n: 0 }, warns = [], probes = [];
  const files = Object.assign(Object.create(null), o.files || {});
  if (o.secrets && files[SECRETS_FILE] == null) files[SECRETS_FILE] = JSON.stringify(o.secrets);
  const names = Object.keys(deps);
  const body = `
    let channelSecrets = ${JSON.stringify(Object.assign({}, o.secrets, o.bots ? { telegramBots: o.bots } : {}))};
    const channelSecretsStatus = 'ok';
    const telegramBotRecords = () => channelSecrets.telegramBots || {};
    function saveTelegramBotRecord(id, rec) { channelSecrets = Object.assign({}, channelSecrets, { telegramBots: Object.assign({}, telegramBotRecords(), { [id]: Object.assign({}, telegramBotRecords()[id], rec) }) }); return true; }
    const runtimeKeys = Object.assign(Object.create(null), ${JSON.stringify(o.runtimeKeys || {})});
    const runtimeBaseUrls = Object.assign(Object.create(null), ${JSON.stringify(o.runtimeBaseUrls || {})});
    let runtimeKey = String(runtimeKeys.openrouter || '');
    const credStore = sandboxStore({ runtimeKeys, runtimeBaseUrls, runtimeKey, engineKeys, envFirst, getProviderProfile, normalizeProvider, normalizeProviderIdFromRegistry,
      registryProviderUsesCodex, resolveCreditsConfig, providerHasCredential, SHELL_PUSHES_PROVIDER_CONFIG, console, channelsFollowStation: ids => channelsFollowStation(ids) });
    const telegramStatus = { connected: false, state: 'connecting' }, discordStatus = { connected: false, state: 'connecting' }, genericStatus = {};
    const started = [];
    // the start functions' own persistence line (pinned by the source lock above)
    function startTelegram(token, model, cfg) { started.push({ ch: 'telegram', credential: cfg.credential }); channelSecrets = Object.assign({}, channelSecrets, { telegram: { token: token, model: model, provider: normalizeProvider(cfg.provider), credential: cfg.credential || undefined, enabled: true, agentId: cfg.agentId || undefined } }); return { secretsPersisted: true }; }
    function startDiscord(token, model, cfg) { started.push({ ch: 'discord', credential: cfg.credential }); channelSecrets = Object.assign({}, channelSecrets, { discord: { token: token, model: model, provider: normalizeProvider(cfg.provider), credential: cfg.credential || undefined, enabled: true, agentId: cfg.agentId || undefined } }); return { secretsPersisted: true }; }
    function startGenericChannel(id, token, model, cfg) { started.push({ ch: id, credential: cfg.credential }); const p = {}; p[id] = { token: token || undefined, model: model, provider: normalizeProvider(cfg.provider), credential: cfg.credential || undefined, enabled: true, agentId: cfg.agentId || undefined }; channelSecrets = Object.assign({}, channelSecrets, p); return { secretsPersisted: true }; }
    function startTelegramBot() {}
    ${RESOLVERS.map(lift).join('\n')}
    ${HELPERS.join('\n')}
    ${HANDLERS.map(n => sidecarFunctionSource(n)).join('\n')}
    const perMessage = { telegram: () => channelHubSecrets('telegram'), discord: () => channelHubSecrets('discord'), slack: () => channelHubSecrets('slack') };
    return {
      credStore, providerRuntimeKey, providerRuntimeBaseUrl, stationHubRunConfig, restartTelegramAfterOwnerRevoke, channelFollowsReady, view: channelCredential,
      reconcile: reconcileChannelCredentials, scrubBak: scrubChannelSecretsBak,
      handleChannelConnect, handleDiscordConnect, handleGenericChannelConnect, handleChannelSync, handleDiscordSync, handleGenericChannelSync, handleTelegramBotAdd,
      unknownProviderError: typeof unknownProviderError === 'function' ? unknownProviderError : null,
      providerEndpointNotHandedOver: typeof providerEndpointNotHandedOver === 'function' ? providerEndpointNotHandedOver : (() => false),
      perMessage, started, runtimeBaseUrls, runtimeKeys,
      get: () => channelSecrets, set: v => { channelSecrets = v; }
    };`;
  let reqBody = {};
  deps.readBody = async () => JSON.stringify(reqBody);
  const api = new Function(...names, body)(...names.map(n => deps[n]));
  api.saves = saves; api.warns = warns; api.files = files; api.probes = probes;
  // an own credential saved as a connect saves it, on a record already there
  api.ownPair = (id, pair) => { const own = api.credStore.putChannel(id, pair); api.set(SecretsMod.withCredentials(Object.assign({}, api.get(), { [id]: Object.assign({}, api.get()[id], { provider: pair.provider }) }), { [id]: own.credential })); };
  if (!o.noBoot) { api.reconcile(); saves.n = 0; warns.length = 0; }
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
    // review r7 (m2): the page copy is a STATION-HELD key too (a channel record the page synced hands it back as "its own"):
    // an endpoint it was not saved with is ignored, and it goes to the endpoint it was saved with
    A.eq(page.providerRuntimeBaseUrl('custom', 'http://other/v1', 'sk-page', 'sk-page'), 'http://page-llm/v1', "browser: the page copy's key never rides an endpoint it was not saved with");
    A.eq(page.providerRuntimeBaseUrl('custom', 'http://other/v1', undefined, 'sk-page'), 'http://page-llm/v1', '...whether the run key is passed or resolved');
  }

  // ================================ (a) two connects through the real handlers ==========================================
  for (const [handler, ch, extra] of [['handleChannelConnect', 'telegram', []], ['handleDiscordConnect', 'discord', []], ['handleGenericChannelConnect', 'slack', ['slack']]]) {
    const s = station({ runtimeKeys: { openrouter: STATION_OR } });
    const first = await s.call(handler, { token: 'tok', provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', baseUrl: '' }, ...extra);
    A.eq(first.status, 200, ch + ': the desktop connect (no key in the body; the keychain holds it) is accepted');
    A.eq(s.view(ch).key, '', ch + ': the bot keeps no station key');
    A.eq(s.view(ch).baseUrl, '', ch + ': ...and no endpoint the station resolves on its own');
    A.eq(s.get()[ch].credential, { ref: 'station' }, ch + ': the record is a station reference');
    A.ok(!('key' in s.get()[ch]) && !('baseUrl' in s.get()[ch]), ch + ': ...and holds no key or endpoint');
    A.eq(s.started[s.started.length - 1].credential, { ref: 'station' }, ch + ': the start function is handed that reference');
    const second = await s.call(handler, { provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', baseUrl: EVIL }, ...extra);
    A.eq(second.status, 200, ch + ': a later connect naming an endpoint and no key is accepted');
    A.ok(s.view(ch).baseUrl !== EVIL && !s.view(ch).key, ch + ': ...and its endpoint is not saved, nor any key: ' + JSON.stringify({ key: s.view(ch).key, baseUrl: s.view(ch).baseUrl }));
    const live = s.stationHubRunConfig('agent', s.view(ch));
    A.eq([live.key, live.baseUrl], [STATION_OR, 'https://openrouter.ai/api/v1'], ch + ': every inbound message runs the station key on the configured endpoint (stationHubRunConfig)');
    const msg = s.perMessage[ch]();
    A.eq([msg.key, msg.baseUrl], [STATION_OR, 'https://openrouter.ai/api/v1'], ch + ": ...and on the hub's own secrets() resolution");
    // the stale endpoint: the Commander points OpenRouter at their own proxy after the bot connected
    s.runtimeBaseUrls.openrouter = PROXY;
    A.eq(s.stationHubRunConfig('agent', s.view(ch)).baseUrl, PROXY, ch + ': a proxy configured later is followed (no endpoint frozen at connect)');
    A.eq(s.perMessage[ch]().baseUrl, PROXY, ch + ": ...by the hub's secrets() too");
    delete s.runtimeBaseUrls.openrouter;
    // a browser connect hands its OWN key and endpoint: kept together, and honoured
    const own = await s.call(handler, { token: 'tok', provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', key: 'sk-or-CALLER-OWN', baseUrl: PROXY }, ...extra);
    A.eq([own.status, own.body.keyPersisted], [200, true], ch + ': a connect with its own key and endpoint is accepted, and says the key is kept');
    A.eq([s.view(ch).key, s.view(ch).baseUrl], ['sk-or-CALLER-OWN', PROXY], ch + ": the caller's own key and endpoint are saved together");
    A.eq(s.stationHubRunConfig('agent', s.view(ch)).baseUrl, PROXY, ch + ": ...and its messages run there on the caller's key");
    // a later connect naming another endpoint without a key keeps the saved pair (a body endpoint goes only with the body's key)
    await s.call(handler, { provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', baseUrl: EVIL }, ...extra);
    A.eq([s.view(ch).key, s.view(ch).baseUrl], ['sk-or-CALLER-OWN', PROXY], ch + ": a keyless body endpoint never re-points the caller's saved key");
    // ...on a station that holds NO key of its own too: the body endpoint is checked against the key the run goes out on
    // (the saved one), never the station's empty resolution, so the saved key never follows it
    const bare = station({ secrets: { [ch]: { token: 'tok', key: 'sk-or-CALLER-OWN', model: 'openai/gpt-5', provider: 'openrouter', baseUrl: PROXY, agentId: 'agent' } } });
    await bare.call(handler, { provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', baseUrl: EVIL }, ...extra);
    A.eq([bare.view(ch).key, bare.view(ch).baseUrl], ['sk-or-CALLER-OWN', PROXY], ch + ': a keyless station: a body endpoint never carries the saved key');
    A.ok(bare.perMessage[ch]().baseUrl !== EVIL, ch + ': ...nor do its messages');
    // a NEW key in the body never inherits the endpoint an earlier connect saved for another key
    await bare.call(handler, { provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', key: 'sk-or-NEW' }, ...extra);
    A.eq([bare.view(ch).key, bare.view(ch).baseUrl], ['sk-or-NEW', ''], ch + ': a new key is saved without the endpoint the old key was saved with');
    // minor-5: a provider this station does not know is refused, never re-homed on OpenRouter
    const typo = await s.call(handler, { token: 'tok', provider: 'antrhopic', model: 'claude-x', agentId: 'agent' }, ...extra);
    A.eq(typo.status, 400, ch + ': connect refuses an unknown provider');
    A.ok(/provider "antrhopic" is not a provider this station knows/.test(String(typo.body.error)), ch + ': ...and names it: ' + JSON.stringify(typo.body));
  }

  // ================================ the owner-revoke restart keeps the record's reference ================================
  {
    const s = station({ runtimeKeys: { openrouter: STATION_OR }, secrets: { telegram: { token: 'tok', model: 'openai/gpt-5', provider: 'openrouter', key: '', agentId: 'agent' } } });
    s.restartTelegramAfterOwnerRevoke(s.get().telegram);
    A.eq(s.started[0] && s.started[0].credential, { ref: 'station' }, 'owner revoke: the restart keeps a station reference');
    A.eq(s.view('telegram').key, '', 'owner revoke: the bot still keeps no key');
    const own = station({ secrets: { telegram: { token: 'tok', model: 'openai/gpt-5', provider: 'openrouter', key: 'sk-or-CALLER-OWN', agentId: 'agent' } } });
    own.restartTelegramAfterOwnerRevoke(own.get().telegram);
    A.eq(own.view('telegram').key, 'sk-or-CALLER-OWN', "owner revoke: a caller's own key is kept");
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
    const run = new Function('channelCredential', 'channelToken', 'ENV', 'providerHasStoredCredential', 'providerRuntimeKey', 'providerRuntimeBaseUrl', 'channelFollowsReady',
      'startTelegram', 'startDiscord', 'startGenericChannel', 'startTelegramBot', 'telegramBotRecords', 'channelTokenRuntime', 'GENERIC_CHANNEL_IDS', 'console', block);
    const s0 = station({ runtimeKeys: { openrouter: 'sk-or-ENV-OPERATOR' } });   // the boot admission reads the station's own resolution
    run(s0.view, () => '', k => ENVV['STARNET_' + k], () => false, () => '', () => '', s0.channelFollowsReady,
      (tok, model, cfg) => handed.push(['telegram', cfg]), (tok, model, cfg) => handed.push(['discord', cfg]), (id, tok, model, cfg) => handed.push([id, cfg]),
      () => {}, () => ({}), { telegram: 'tg-env', discord: 'dc-env', slack: 'xoxb-env xapp-env', matrix: 'mx-env' }, ['slack', 'matrix', 'signal'], { log() {}, warn() {} });
    A.eq(handed.map(h => h[0]), ['telegram', 'discord', 'slack'], 'fixture: the env-provided bots auto-start');
    A.ok(handed.every(h => !h[1].credential && !('key' in h[1])), 'an env auto-start hands its start function no credential, so its record follows the station: ' + JSON.stringify(handed));
    const s = station({ runtimeKeys: { openrouter: 'sk-or-ENV-OPERATOR' } });
    s.set({ telegram: { token: 'tg-env', model: 'openai/gpt-5', provider: 'openrouter' } });
    A.eq(s.perMessage.telegram().key, 'sk-or-ENV-OPERATOR', '...and its messages still run on the env key, resolved live');
  }

  // ================================ (c) the boot: a saved station key is dropped, a caller's moves, the bot keeps running ==
  {
    const legacy = {
      telegram: { token: 'tg', key: STATION_OR, model: 'openai/gpt-5', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: true, agentId: 'agent' },
      discord: { token: 'dc', key: 'sk-or-CALLER-OWN', model: 'openai/gpt-5', provider: 'openrouter', baseUrl: PROXY, enabled: true },
      slack: { token: 'xoxb', key: 'sk-ant-OPERATOR', model: 'claude-x', provider: 'anthropic', baseUrl: EVIL, enabled: true },
      telegramBots: { 42: { token: 'bot', key: STATION_OR, provider: 'openrouter', agentId: 'agent' } },
      notifyAutonomous: true
    };
    const s = station({ noBoot: true, runtimeKeys: { openrouter: STATION_OR }, env: { ANTHROPIC_API_KEY: 'sk-ant-OPERATOR' }, secrets: legacy });
    const res = s.reconcile();
    A.eq([res.followers, res.moved], [['telegram', 'telegramBots:42'], ['discord', 'slack']], 'at boot, the records holding the keychain or operator key follow the station, a caller\'s key moves, and an own endpoint stays with no key');
    A.eq(s.saves.n, 1, 'main is saved ONCE');
    s.scrubBak();
    const bak = String(s.files[SECRETS_FILE + '.bak'] || '');
    A.ok(![STATION_OR, 'sk-ant-OPERATOR', 'sk-or-CALLER-OWN', PROXY, EVIL].some(v => bak.includes(v)), 'the .bak the save snapshotted the leaky main into holds no provider key or endpoint: ' + bak.slice(0, 160));
    A.ok(bak.includes('"token":"tg"'), '...and is still a recovery copy of the rest');
    A.ok(![STATION_OR, 'sk-ant-OPERATOR', 'sk-or-CALLER-OWN'].some(v => JSON.stringify(s.get()).includes(v)), 'no provider key is left in any record');
    A.ok(s.warns.some(w => /^\[channels\] discord, slack: /.test(w)), 'and said once in the log, by record id: ' + JSON.stringify(s.warns));
    A.eq(s.view('discord').key, 'sk-or-CALLER-OWN', "the caller's own key is kept");
    // no bot stops working: each record resolves the station key live, on the configured endpoint
    A.eq([s.perMessage.telegram().key, s.perMessage.telegram().baseUrl], [STATION_OR, 'https://openrouter.ai/api/v1'], 'the Telegram bot runs on the station key, resolved live');
    const slackMsg = s.perMessage.slack();
    A.ok(slackMsg.key === 'sk-ant-OPERATOR' && slackMsg.baseUrl !== EVIL && slackMsg.configured, 'the Slack bot runs on the operator key, never on the endpoint its old record named: ' + JSON.stringify({ baseUrl: slackMsg.baseUrl }));
    A.eq(s.stationHubRunConfig('agent', s.view('discord')).baseUrl, PROXY, "the caller's own pair still runs where it was saved for");
    A.eq(s.reconcile().followers.concat(s.reconcile().moved), [], 'running it again changes nothing');
    const idx = require('./helpers/source.js').readSidecarIndex();
    A.ok(/let channelSecrets = loadChannelSecrets\(\);\n[\s\S]{0,4000}?const channelsReconciled = reconcileChannelCredentials\(\);\n[\s\S]{0,2400}?\(function migrateChannelSecretsToKeychain\(\) \{[\s\S]{0,1500}?\}\)\(\);\n[\s\S]{0,400}?if \(!channelsReconciled\.pending\.length\) scrubChannelSecretsBak\(\);\nnameChannelQuarantines\(\);\n/.test(idx),
      'at load: the reconciliation, then the token migration, then the .bak sweep (never while a move is pending)');
  }
  // ...and a record the reconciliation has not reached is never read for a key: the one reader of those fields is the reconciliation
  {
    const s = station({ noBoot: true, runtimeKeys: { openrouter: STATION_OR }, secrets: { telegram: { token: 'tg', key: STATION_OR, model: 'openai/gpt-5', provider: 'openrouter', baseUrl: EVIL, agentId: 'agent' } } });
    A.eq(s.stationHubRunConfig('agent', s.view('telegram')).baseUrl, 'https://openrouter.ai/api/v1', 'a legacy record holding the station key never sends it to its saved endpoint (stationHubRunConfig)');
    A.eq(s.perMessage.telegram().baseUrl, 'https://openrouter.ai/api/v1', '...nor through secrets()');
  }

  // ================================ minor-5: sync and bots/connect refuse an unknown provider ============================
  {
    const s = station({ secrets: { telegram: { token: 'tg', provider: 'anthropic', model: 'claude-x' }, discord: { token: 'dc', provider: 'anthropic' }, slack: { token: 'xoxb', provider: 'anthropic' } } });
    for (const [h, extra] of [['handleChannelSync', []], ['handleDiscordSync', []], ['handleGenericChannelSync', ['slack']], ['handleTelegramBotAdd', []]]) {
      const r = await s.call(h, { provider: 'olama', model: 'llama3', token: 'tok', agentId: 'agent' }, ...extra);
      A.eq(r.status, 400, h + ': an unknown provider is refused');
      A.ok(/provider "olama" is not a provider this station knows/.test(String(r.body.error)), h + ': ...and named: ' + JSON.stringify(r.body));
    }
    A.eq(s.get().telegram.provider, 'anthropic', 'the record keeps its provider (never re-homed on openrouter)');
    const fine = await s.call('handleChannelSync', { provider: 'claude', model: 'claude-y' });
    A.eq([fine.status, s.get().telegram.provider], [200, 'anthropic'], 'a known alias still syncs');
  }

  // ================================ minor-3: a body endpoint /api/run does not use =======================================
  {
    const run = sidecarTopLevelFunction('handleRun');
    const from = run.indexOf('  const key = providerRuntimeKey(runProvider, bodyCredential');
    const to = run.indexOf('\n', run.indexOf('  if (!providerHasCredential(runProvider, key, baseUrl,', from));
    A.ok(from > 0 && to > from && to - from < 4000, "fixture: handleRun's credential lines are sliced");
    const lines = run.slice(from, to);
    const handle = (s, runProvider, body) => {
      let status = 200, text = '';
      const res = { writeHead(c) { status = c; }, end(t) { text = String(t || ''); return 'ended'; } };
      const out = new Function('res', 'body', 'runProvider', 'bodyCredential', 'model', 'oauthLabel', 'getProviderProfile', 'providerRequiresBaseUrl', 'providerHasCredential',
        'providerCredentialError', 'providerRuntimeKey', 'providerRuntimeBaseUrl', 'providerEndpointNotHandedOver', lines + "\nreturn { key, baseUrl, notices: typeof runNotices === 'undefined' ? [] : runNotices };")(
        res, body, runProvider, true, 'some/model', p => p, Reg.getProviderProfile, Reg.providerRequiresBaseUrl,
        (p, k, b) => !!String(b || '').trim() && (Reg.getProviderProfile(p).keyRequired === false || !!String(k || '').trim()), p => 'configure the ' + Reg.getProviderProfile(p).label + ' base URL',
        s.providerRuntimeKey, s.providerRuntimeBaseUrl, s.providerEndpointNotHandedOver);
      return { status, text, out: out === 'ended' ? null : out };
    };
    // the desktop CUSTOM run after a respawn that lost the endpoint: the keychain key is there, the window names an endpoint
    const lost = handle(station({ runtimeKeys: { custom: 'sk-custom-KEYCHAIN' } }), 'custom', { provider: 'custom', baseUrl: 'http://lan-llm:8000/v1' });
    A.eq(lost.status, 400, 'a CUSTOM run whose named endpoint is dropped, with none on the station, is refused');
    A.eq(lost.text, 'missing key/model — the station holds no CUSTOM endpoint for its saved key — re-save the base URL in SETTINGS → AI & MODELS', '...with the reason and the door: ' + lost.text);
    const fe = Friendly.friendlyError(new Error('sidecar http 400: ' + lost.text));
    A.eq([fe.kind, fe.userMessage], ['auth', 'The station holds no CUSTOM endpoint for its saved key — re-save the base URL in SETTINGS → AI & MODELS.'], "the page's friendly line says the same, at the same door");
    A.eq(fe.provider, 'custom', '...and names the provider');
    // a script names another endpoint for a cloud provider on the station's key: the run goes on, and says so once
    const cloud = handle(station({ runtimeKeys: { openrouter: STATION_OR } }), 'openrouter', { provider: 'openrouter', baseUrl: EVIL });
    A.eq(cloud.status, 200, 'a cloud run whose named endpoint is ignored still runs');
    A.eq(cloud.out && cloud.out.baseUrl, 'https://openrouter.ai/api/v1', '...on the configured endpoint');
    A.eq(cloud.out && cloud.out.notices.length, 1, '...with one run notice');
    A.ok(cloud.out && /^the endpoint this run named was not used \(a per-run endpoint goes only with the key sent beside it, and never with a sign-in\): it ran on the station's OPENROUTER endpoint$/.test(cloud.out.notices[0] || ''), '...that says why, without echoing the URL: ' + (cloud.out && cloud.out.notices[0]));
    // the desktop page names the endpoint the station was handed: nothing ignored, no notice
    const same = handle(station({ runtimeKeys: { openrouter: STATION_OR }, runtimeBaseUrls: { openrouter: PROXY } }), 'openrouter', { provider: 'openrouter', baseUrl: PROXY + '/' });
    A.eq([same.status, same.out && same.out.baseUrl, same.out && same.out.notices.length], [200, PROXY, 0], 'a body naming the endpoint the station holds runs there with no notice');
    // the run notice reaches agent.run.start (additive, like voiceRoute)
    const core = sidecarTopLevelFunction('runOnceCore');
    A.ok(/if \(runNotices\.length\) runStartExtra\.notices = runNotices;/.test(core) && /\(runStartExtra\.dockId \|\| runStartExtra\.workitemId \|\| runStartExtra\.notices \|\| runStartExtra\.voiceRoute\)\) payload = Object\.assign\(\{\}, payload, runStartExtra\)/.test(core),
      'runOnceCore carries the notices on agent.run.start');
    A.ok(/trigger: 'directive', internal, evidence, keepEffort, runNotices,/.test(run), 'handleRun hands its notices to the run');
  }

  // ================================ minor-6: an unknown fallback provider is skipped, with a notice ======================
  {
    const core = sidecarTopLevelFunction('runOnceCore');
    const from = core.indexOf('  const providerFallbacks = [];');
    const to = core.indexOf('  const fallbacks = rotationFallbacks', from);
    A.ok(from > 0 && to > from && to - from < 6000, "fixture: runOnceCore's fallback loop is sliced");
    const s = station({ runtimeKeys: { openrouter: STATION_OR }, env: { ANTHROPIC_API_KEY: 'sk-ant-OPERATOR' } });
    const runNotices = [], runStartExtra = {};
    const fbs = new Function('savedProviderFallbacks', 'o', 'normalizeProvider', 'providerId', 'chatModelId', 'model', 'providerRuntimeBaseUrl', 'providerRuntimeKey', 'providerHasCredential',
      'getProviderProfile', 'credits', 'CREDITS_URL', 'managedRun', 'providerUsesCodex', 'providerUsesDeviceOAuth', 'selectProvider', 'reasoningEffort', 'makeCostEngine', 'runCapUsd',
      'effectiveCaps', 'CAPS', 'unknownProviderError', 'runNotices', 'runStartExtra', 'normalizeProviderId', 'runWatch', 'billing',
      core.slice(from, to) + '\nreturn providerFallbacks;')(
      [], { fallbackProviders: [{ provider: 'antrhopic', model: 'claude-typo' }, { provider: 'anthropic', model: 'claude-x' }] }, v => Reg.normalizeProviderId(v, 'openrouter'), 'openrouter', (p, m) => m, 'openai/gpt-5',
      s.providerRuntimeBaseUrl, s.providerRuntimeKey, (p, k, b) => !!k && !!b, Reg.getProviderProfile, { configured: () => false }, '', false, () => false, () => false,
      cfg => ({ id: cfg.provider, priceOf: () => null }), 'medium', () => ({}), Infinity, {}, { maxUnpricedTokens: 1 },
      s.unknownProviderError || (() => ''),
      runNotices, runStartExtra, v => Reg.normalizeProviderId(v, ''), s.credStore.inFlight(), require('../sidecar/billing-class.js').makeBilling({ profileOf: Reg.getProviderProfile }));   // runWatch: the run's watch over its keys (S3)
    A.eq(fbs.map(f => f.providerId + '/' + f.model), ['anthropic/claude-x'], 'a fallback on a provider this station does not know is skipped, never re-homed on openrouter');
    A.eq(runNotices, ['a fallback was skipped: provider "antrhopic" is not a provider this station knows'], '...and the run says so');
    A.eq(runStartExtra.notices, runNotices, '...on agent.run.start');
    A.ok(/const fbUnknown = unknownProviderError\(fb\.provider\);/.test(core), 'the loop uses the one unknown-provider rule (unknownProviderError)');
  }

  // ================================ review r7 MAJOR: a channel SYNC re-pairs the key it is handed ========================
  // /api/channels/<ch>/sync patched record.key from the body and kept record.baseUrl, so a NEW key rode the endpoint an earlier
  // connect saved for ANOTHER key (r7-sync-key-endpoint.js), and the page's own key — which app.js syncChannels posts at every
  // boot — rode the endpoint a script's reconnect had saved for the script's key (r7-sync-swap-attack.js).
  const PROXY2 = 'https://second-proxy.example/v1';
  const OR_DEFAULT = 'https://openrouter.ai/api/v1';
  for (const [connect, sync, ch, extra] of [['handleChannelConnect', 'handleChannelSync', 'telegram', []], ['handleDiscordConnect', 'handleDiscordSync', 'discord', []],
    ['handleGenericChannelConnect', 'handleGenericChannelSync', 'slack', ['slack']]]) {
    const rec = s => s.view(ch);
    const s = station({});   // a browser station: it holds no key of its own
    await s.call(connect, { token: 'tok', provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', key: 'sk-or-A', baseUrl: PROXY }, ...extra);
    A.eq([rec(s).key, rec(s).baseUrl], ['sk-or-A', PROXY], ch + ': fixture: connect saved key A with endpoint E');
    const synced = await s.call(sync, { agentId: 'agent', provider: 'openrouter', model: 'openai/gpt-5', key: 'sk-or-B' }, ...extra);
    A.eq(synced.status, 200, ch + ': sync {key:B} is accepted');
    const live = s.stationHubRunConfig('agent', rec(s));
    A.ok(!(live.key === 'sk-or-B' && live.baseUrl === PROXY), ch + ': key B never reaches the endpoint key A was saved with (stationHubRunConfig): ' + JSON.stringify([live.key, live.baseUrl]));
    A.eq([live.key, live.baseUrl], ['sk-or-B', OR_DEFAULT], ch + ': ...it runs on the endpoint the station resolves for B');
    const msg = s.perMessage[ch]();
    A.ok(!(msg.key === 'sk-or-B' && msg.baseUrl === PROXY), ch + ": ...nor through the hub's secrets(): " + JSON.stringify([msg.key, msg.baseUrl]));
    A.eq([rec(s).key, rec(s).baseUrl], ['sk-or-B', ''], ch + ': the record pairs B with no endpoint (it follows what the station resolves)');
    // the page syncs its key WITH its endpoint: the pair rides together
    await s.call(sync, { agentId: 'agent', provider: 'openrouter', model: 'openai/gpt-5', key: 'sk-or-C', baseUrl: PROXY2 }, ...extra);
    A.eq([rec(s).key, rec(s).baseUrl], ['sk-or-C', PROXY2], ch + ': a synced key and the endpoint sent beside it are saved together');
    A.eq(s.stationHubRunConfig('agent', rec(s)).baseUrl, PROXY2, ch + ': ...and its messages run there');
    // the same key re-synced without an endpoint keeps the endpoint it was saved with; an identity-only sync leaves the pair alone
    await s.call(sync, { agentId: 'agent', provider: 'openrouter', model: 'openai/gpt-5', key: 'sk-or-C' }, ...extra);
    A.eq([rec(s).key, rec(s).baseUrl], ['sk-or-C', PROXY2], ch + ': the same key re-synced keeps its own endpoint');
    await s.call(sync, { agentId: 'agent', system: 'a new voice' }, ...extra);
    A.eq([rec(s).key, rec(s).baseUrl, rec(s).system], ['sk-or-C', PROXY2, 'a new voice'], ch + ': an identity-only sync leaves the credential alone');
    // a provider change with no key: the old provider's key and endpoint never ride the new provider
    s.ownPair(ch, { provider: 'custom', key: 'sk-custom-OWN', baseUrl: 'http://10.0.0.5:8000/v1' });
    await s.call(sync, { agentId: 'agent', provider: 'openrouter' }, ...extra);
    const crossed = s.stationHubRunConfig('agent', rec(s));
    A.ok(rec(s).key !== 'sk-custom-OWN' && rec(s).baseUrl !== 'http://10.0.0.5:8000/v1', ch + ': a sync to another provider drops the old provider\'s key and endpoint: ' + JSON.stringify({ key: rec(s).key, baseUrl: rec(s).baseUrl }));
    A.ok(crossed.key !== 'sk-custom-OWN', ch + ': ...so the CUSTOM key never goes out on openrouter');
    // the swap (r7-sync-swap-attack.js): the Commander's page key on a browser station (#89 page copy), a script reconnects with
    // its own key + endpoint (allowed: a body endpoint rides the body's key), then the Commander's page boots and syncs its key
    const p = station({ pageCopy: { openrouter: { key: PAGE_KEY, keyPool: [], baseUrl: '' } },
      secrets: { [ch]: { token: 'tok', key: PAGE_KEY, model: 'openai/gpt-5', provider: 'openrouter', baseUrl: '', enabled: true, agentId: 'agent' } } });
    const scripted = await p.call(connect, { token: 'tok', provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', key: 'sk-attacker-own', baseUrl: EVIL }, ...extra);
    A.eq([scripted.status, rec(p).key, rec(p).baseUrl], [200, 'sk-attacker-own', EVIL], ch + ': fixture: the script\'s own pair is saved');
    await p.call(sync, { agentId: 'agent', model: 'openai/gpt-5', provider: 'openrouter', key: PAGE_KEY, system: '', agentName: 'NOVA' }, ...extra);
    const swapped = p.stationHubRunConfig('agent', rec(p));
    A.ok(!(swapped.key === PAGE_KEY && swapped.baseUrl === EVIL), ch + ': the page key a sync hands over never reaches the script\'s endpoint: ' + JSON.stringify([swapped.key, swapped.baseUrl]));
    A.ok(p.perMessage[ch]().baseUrl !== EVIL, ch + ": ...nor through the hub's secrets()");
  }

  // ================================ review r7 m2: the PAGE COPY's key is station-held too ================================
  {
    // r7-pagecopy-residue.js: an older build saved { key: <page copy key>, baseUrl: <a script's endpoint> } (the r5 attack)
    const poisoned = { telegram: { token: 'tg', key: PAGE_KEY, provider: 'openrouter', model: 'openai/gpt-5', baseUrl: EVIL, agentId: 'agent', enabled: true },
      slack: { token: 'xoxb', key: 'sk-page-custom', provider: 'custom', model: 'local/m', baseUrl: 'http://page-llm/v1/', enabled: true, agentId: 'agent' },
      discord: { token: 'dc', key: 'sk-or-CALLER-OWN', provider: 'openrouter', model: 'openai/gpt-5', baseUrl: PROXY, enabled: true } };
    const pageCopy = { openrouter: { key: PAGE_KEY, keyPool: [], baseUrl: '' }, custom: { key: 'sk-page-custom', baseUrl: 'http://page-llm/v1' } };
    const s = station({ noBoot: true, pageCopy, secrets: poisoned });
    A.eq(s.stationHubRunConfig('agent', s.view('telegram')).baseUrl, OR_DEFAULT, 'per message, before the boot: the page copy key never goes to the endpoint the record names');
    A.eq(s.perMessage.telegram().baseUrl, OR_DEFAULT, "...nor through the hub's secrets()");
    const res = s.reconcile();
    A.eq(res.followers, ['telegram', 'slack'], 'the boot reaches the records holding the page copy key: ' + JSON.stringify(res));
    A.eq(s.get().telegram.credential, { ref: 'station' }, 'the poisoned record keeps neither the page key nor the endpoint it was never saved with: ' + JSON.stringify(s.get().telegram));
    A.eq(s.get().slack.credential, { ref: 'station' }, "a record holding the page key beside the page copy's OWN endpoint simply follows the page copy");
    A.eq(s.perMessage.slack().baseUrl, 'http://page-llm/v1', "...on that endpoint");
    A.eq([s.view('discord').key, s.view('discord').baseUrl], ['sk-or-CALLER-OWN', PROXY], "a caller's own pair is untouched");
    A.eq([s.perMessage.telegram().key, s.perMessage.telegram().baseUrl], [PAGE_KEY, OR_DEFAULT], 'the bot runs on the page key, resolved live, on its own endpoint');
    s.scrubBak();
    A.ok(!String(s.files[SECRETS_FILE + '.bak'] || '').includes(EVIL), 'the .bak keeps no copy of the poisoned endpoint either');
  }

  // ================================ review r7 m5: the .bak is swept at every boot, on its own ==============================
  {
    // main is clean (an earlier boot rewrote it), but the .bak still holds what it held: that boot's sweep failed, or the
    // station stopped between the two writes
    const clean = { telegram: { token: 'tg', provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', credential: { ref: 'station' } } };
    const leakyBak = { telegram: { token: 'tg', key: STATION_OR, provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent' }, discord: { token: 'dc', key: 'sk-or-CALLER-OWN', provider: 'openrouter' } };
    const s = station({ noBoot: true, runtimeKeys: { openrouter: STATION_OR }, secrets: clean, files: { [SECRETS_FILE + '.bak']: JSON.stringify(leakyBak) } });
    s.reconcile();
    s.scrubBak();
    A.eq(s.saves.n, 0, 'a clean main is not rewritten');
    A.ok(![STATION_OR, 'sk-or-CALLER-OWN'].some(v => String(s.files[SECRETS_FILE + '.bak']).includes(v)), 'the .bak is swept even when main is clean: ' + String(s.files[SECRETS_FILE + '.bak']).slice(0, 160));
    A.ok(s.warns.some(w => /secrets\.json\.bak/.test(w)), 'said: ' + JSON.stringify(s.warns));
    // a .bak that is not there, or not JSON, is never written over
    const none = station({ runtimeKeys: { openrouter: STATION_OR }, secrets: {} });
    none.scrubBak();
    A.ok(none.files[SECRETS_FILE + '.bak'] == null && none.warns.length === 0, 'no .bak: nothing written, nothing said');
    const torn = station({ runtimeKeys: { openrouter: STATION_OR }, secrets: {}, files: { [SECRETS_FILE + '.bak']: '{"telegram":{"key":"' + STATION_OR } });
    torn.scrubBak();
    A.eq(torn.files[SECRETS_FILE + '.bak'], '{"telegram":{"key":"' + STATION_OR, 'a torn .bak is left byte for byte (recovery may need it)');
    A.ok(torn.warns.some(w => /secrets\.json\.bak/.test(w) && /could not/.test(w)), '...and said: ' + JSON.stringify(torn.warns));
    // the .bak cannot be rewritten: said, and the next boot sweeps again
    const failing = station({ noBoot: true, runtimeKeys: { openrouter: STATION_OR }, bakWriteFails: true, secrets: clean, files: { [SECRETS_FILE + '.bak']: JSON.stringify(leakyBak) } });
    failing.scrubBak();
    A.ok(failing.warns.some(w => /\.bak scrub failed/.test(w) && /next boot/.test(w) && /EPERM/.test(w)), 'a failed .bak rewrite is said: ' + JSON.stringify(failing.warns));
    A.ok(!/DESKTOP_SHELL/.test(sidecarFunctionSource('scrubChannelSecretsBak')), 'the .bak sweep runs on every station, not only the desktop');
  }

  // ================================ review r7 m3: fallback notices are bounded and never echo raw input ===================
  {
    const core = sidecarTopLevelFunction('runOnceCore');
    const from = core.indexOf('  const providerFallbacks = [];');
    const to = core.indexOf('  const fallbacks = rotationFallbacks', from);
    const s = station({ runtimeKeys: { openrouter: STATION_OR } });
    const runFallbacks = (list, notices) => {
      const runNotices = notices.slice(), runStartExtra = {};
      new Function('savedProviderFallbacks', 'o', 'normalizeProvider', 'providerId', 'chatModelId', 'model', 'providerRuntimeBaseUrl', 'providerRuntimeKey', 'providerHasCredential',
        'getProviderProfile', 'credits', 'CREDITS_URL', 'managedRun', 'providerUsesCodex', 'providerUsesDeviceOAuth', 'selectProvider', 'reasoningEffort', 'makeCostEngine', 'runCapUsd',
        'effectiveCaps', 'CAPS', 'unknownProviderError', 'runNotices', 'runStartExtra', 'normalizeProviderId', 'runWatch', 'billing', core.slice(from, to) + '\nreturn providerFallbacks;')(
        [], { fallbackProviders: list }, v => Reg.normalizeProviderId(v, 'openrouter'), 'openrouter', (p, m) => m, 'openai/gpt-5',
        s.providerRuntimeBaseUrl, s.providerRuntimeKey, (p, k, b) => !!k && !!b, Reg.getProviderProfile, { configured: () => false }, '', false, () => false, () => false,
        cfg => ({ id: cfg.provider, priceOf: () => null }), 'medium', () => ({}), Infinity, {}, { maxUnpricedTokens: 1 },
        s.unknownProviderError || (() => ''), runNotices, runStartExtra, v => Reg.normalizeProviderId(v, ''), s.credStore.inFlight(), require('../sidecar/billing-class.js').makeBilling({ profileOf: Reg.getProviderProfile }));   // runWatch (S3)
      return { runNotices, runStartExtra };
    };
    const hostile = 'x"><img src=x onerror=alert(1)>\n[FAKE] the run succeeded ' + 'y'.repeat(200);
    const many = [{ provider: hostile, model: 'm' }].concat(['typo-1', 'typo-2', 'typo-3', 'typo-4', 'typo-5', 'typo-6'].map(p => ({ provider: p, model: 'm' })));
    const out = runFallbacks(many, []);
    A.eq(out.runNotices.length, 5, 'seven unknown fallbacks: four lines and one "and N more" line, never seven: ' + JSON.stringify(out.runNotices));
    A.ok(/^and 3 more fallbacks on a provider this station does not know were skipped$/.test(out.runNotices[4] || ''), '...the last line counts the rest: ' + out.runNotices[4]);
    const echoed = (/^a fallback was skipped: provider "([^"]*)" is not a provider this station knows$/.exec(out.runNotices[0] || '') || [])[1];
    A.ok(echoed != null && /^[\w.:-]{1,40}$/.test(echoed), 'the echoed id keeps only [\\w.:-], at most 40 characters: ' + JSON.stringify(out.runNotices[0]));
    A.eq(out.runStartExtra.notices, out.runNotices, '...on agent.run.start');
    // the run already carries notices of its own (the endpoint notice; the entry cap is 4): no skipped line is added past four
    const full = runFallbacks([{ provider: 'typo-a', model: 'm' }, { provider: 'typo-b', model: 'm' }], ['n1', 'n2', 'n3', 'n4']);
    A.eq(full.runNotices, ['n1', 'n2', 'n3', 'n4', 'and 2 more fallbacks on a provider this station does not know were skipped'], 'a run already at four notices gets one count line: ' + JSON.stringify(full.runNotices));
    A.eq(runFallbacks([{ provider: 'antrhopic', model: 'm' }], []).runNotices, ['a fallback was skipped: provider "antrhopic" is not a provider this station knows'], 'one unknown fallback is still said by name');
  }

  // ================================ review r7 m8: StarNet is not the CUSTOM-only refusal ================================
  {
    const run = sidecarTopLevelFunction('handleRun');
    const from = run.indexOf('  const key = providerRuntimeKey(runProvider, bodyCredential');
    const to = run.indexOf('\n', run.indexOf('  if (!providerHasCredential(runProvider, key, baseUrl,', from));
    const lines = run.slice(from, to);
    const handle = (s, runProvider, body) => {
      let status = 200, text = '';
      const res = { writeHead(c) { status = c; }, end(t) { text = String(t || ''); return 'ended'; } };
      const out = new Function('res', 'body', 'runProvider', 'bodyCredential', 'model', 'oauthLabel', 'getProviderProfile', 'providerRequiresBaseUrl', 'providerHasCredential',
        'providerCredentialError', 'providerRuntimeKey', 'providerRuntimeBaseUrl', 'providerEndpointNotHandedOver', lines + "\nreturn { key, baseUrl, notices: typeof runNotices === 'undefined' ? [] : runNotices };")(
        res, body, runProvider, true, 'some/model', p => p, Reg.getProviderProfile, Reg.providerRequiresBaseUrl,
        (p, k, b) => !!String(b || '').trim() && (Reg.getProviderProfile(p).keyRequired === false || !!String(k || '').trim()),
        p => p === 'starnet' ? 'link this station to a StarNet account (SETTINGS -> AI & MODELS -> STARNET MANAGED) to run on credits' : 'configure the base URL',
        s.providerRuntimeKey, s.providerRuntimeBaseUrl, s.providerEndpointNotHandedOver);
      return { status, text, out: out === 'ended' ? null : out };
    };
    // the page's stray starnet baseUrl slot on an UNLINKED station: the refusal is the link one, not "re-save the base URL"
    const unlinked = handle(station({}), 'starnet', { provider: 'starnet', baseUrl: 'http://stray-slot.invalid' });
    A.eq(unlinked.status, 400, 'an unlinked StarNet run is refused');
    A.ok(!/endpoint for its saved key/.test(unlinked.text) && /link this station to a StarNet account/.test(unlinked.text), '...with the link door, not the CUSTOM-only sentence: ' + unlinked.text);
    // a LINKED station: the stray slot is not "an endpoint this run named" (StarNet's endpoint is the linked account's)
    const linked = handle(station({ credits: { url: 'https://cloud.starnet.invalid', apiKey: 'dev-token' } }), 'starnet', { provider: 'starnet', baseUrl: 'http://stray-slot.invalid' });
    A.eq([linked.status, linked.out && linked.out.baseUrl, linked.out && linked.out.notices.length], [200, 'https://cloud.starnet.invalid/v1', 0], 'a linked StarNet run carries no endpoint notice: ' + JSON.stringify(linked.out));
    // review r8 F6 (keptEndpointProvider): the same two on the DESKTOP. The window never hands StarNet's endpoint over (it is
    // the linked account's), so the not-handed-over refusal is never theirs: no 503 retry for either
    const dUnlinked = handle(station({ desktop: true }), 'starnet', { provider: 'starnet', baseUrl: 'http://stray-slot.invalid' });
    A.ok(dUnlinked.status === 400 && /link this station to a StarNet account/.test(dUnlinked.text), 'desktop: an unlinked StarNet run gets the link door, not a retry: ' + JSON.stringify([dUnlinked.status, dUnlinked.text]));
    const dLinked = handle(station({ desktop: true, credits: { url: 'https://cloud.starnet.invalid', apiKey: 'dev-token' } }), 'starnet', { provider: 'starnet', baseUrl: 'http://stray-slot.invalid' });
    A.eq([dLinked.status, dLinked.out && dLinked.out.baseUrl, dLinked.out && dLinked.out.notices.length], [200, 'https://cloud.starnet.invalid/v1', 0], 'desktop: a linked StarNet run with a stray slot runs, no notice, no retry: ' + JSON.stringify(dLinked.out || dLinked.text));
  }

  // ================================ review r7 m9: a bots/connect rebind keeps the bot's own pair ===========================
  {
    // the bot (777) was connected with its own key on its own proxy; the Commander rebinds it with no key in the body
    const s = station({ runtimeKeys: { openrouter: STATION_OR },
      bots: { 777: { token: 'bot-token', key: 'sk-or-BOT-OWN', provider: 'openrouter', model: 'openai/gpt-5', baseUrl: PROXY, agentId: 'agent', ownerId: 1, enabled: true } } });
    const r = await s.call('handleTelegramBotAdd', { token: 'bot-token', agentId: 'agent' });
    A.eq(r.status, 200, 'the rebind is accepted: ' + JSON.stringify(r.body));
    A.eq(s.probes[0], { key: 'sk-or-BOT-OWN', baseUrl: PROXY }, 'the run probe proves the key the record keeps, on the endpoint saved with it (never the station key)');
    A.eq([s.view('telegramBots:777').key, s.view('telegramBots:777').baseUrl], ['sk-or-BOT-OWN', PROXY], "the bot keeps its own pair: " + JSON.stringify(s.get().telegramBots['777']));
    A.ok(!('key' in s.get().telegramBots['777']) && !('baseUrl' in s.get().telegramBots['777']) && s.get().telegramBots['777'].credential.ref === 'channel', '...in the store: its record holds a reference');
    // a bot whose own pair has no endpoint: the record never freezes the endpoint the station resolves today
    const t = station({ runtimeKeys: { openrouter: STATION_OR }, runtimeBaseUrls: { openrouter: PROXY2 },
      bots: { 777: { token: 'bot-token', key: 'sk-or-BOT-OWN', provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', ownerId: 1, enabled: true } } });
    await t.call('handleTelegramBotAdd', { token: 'bot-token', agentId: 'agent' });
    A.eq(t.probes[0], { key: 'sk-or-BOT-OWN', baseUrl: PROXY2 }, "the probe goes out on the bot's own key");
    A.ok(t.view('telegramBots:777').key === 'sk-or-BOT-OWN' && !t.view('telegramBots:777').baseUrl, 'and the bot keeps no endpoint the key would resolve to anyway');
    // a body key still wins, with the endpoint sent beside it
    const u = station({ runtimeKeys: { openrouter: STATION_OR }, bots: { 777: { token: 'bot-token', key: 'sk-or-BOT-OWN', provider: 'openrouter', baseUrl: PROXY, agentId: 'agent', ownerId: 1 } } });
    await u.call('handleTelegramBotAdd', { token: 'bot-token', agentId: 'agent', provider: 'openrouter', key: 'sk-or-NEW', baseUrl: PROXY2 });
    A.eq([u.probes[0], u.view('telegramBots:777').key, u.view('telegramBots:777').baseUrl], [{ key: 'sk-or-NEW', baseUrl: PROXY2 }, 'sk-or-NEW', PROXY2], 'a body key and its endpoint are probed and saved together');
  }

  // ================================ review r8 F1 (MAJOR): a reconnect that switches provider ============================
  // r8-connect-provider-switch*.js: the record holds the page's OpenRouter key; the Commander moves the agent to a keyless LAN
  // CUSTOM server (the operator's env URL), or to Anthropic (an env key), and reconnects with no key in the body.
  const R8 = [['handleChannelConnect', 'handleChannelSync', 'telegram', []], ['handleDiscordConnect', 'handleDiscordSync', 'discord', []],
    ['handleGenericChannelConnect', 'handleGenericChannelSync', 'slack', ['slack']]];
  const recOf = (s, ch) => s.view(ch);
  const s2k = c => (c && c.ok) ? c.key + '|' + c.baseUrl : 'refused: ' + (c && c.error);
  const LAN = 'http://192.168.1.40:1234/v1';
  for (const [connect, , ch, extra] of R8) {
    for (const [provider, model, env, want] of [['custom', 'local/qwen', { CUSTOM_OPENAI_BASE_URL: LAN }, ['', LAN]],
      ['anthropic', 'claude-x', { ANTHROPIC_API_KEY: 'sk-ant-ENV-OPERATOR' }, ['sk-ant-ENV-OPERATOR', 'https://api.anthropic.com/v1']]]) {
      const s = station({ env, roster: { agent: { name: 'NOVA', model, provider } },
        secrets: { [ch]: { token: 'tok', key: 'sk-or-COMMANDER', provider: 'openrouter', model: 'openai/gpt-5', baseUrl: '', enabled: true, agentId: 'agent' } } });
      const tag = ch + ' -> ' + provider;
      const r = await s.call(connect, { provider, model, agentId: 'agent' }, ...extra);
      A.eq([r.status, recOf(s, ch).provider], [200, provider], tag + ': fixture: the reconnect lands: ' + JSON.stringify(r.body));
      A.ok(!recOf(s, ch).key, tag + ': the OpenRouter key is not saved under ' + provider + ': ' + JSON.stringify(recOf(s, ch).key));
      const live = s.stationHubRunConfig('agent', recOf(s, ch)), msg = s.perMessage[ch]();
      A.ok(live.key !== 'sk-or-COMMANDER' && msg.key !== 'sk-or-COMMANDER', tag + ': no message sends the OpenRouter key to ' + (live.baseUrl || msg.baseUrl));
      A.eq([live.key, live.baseUrl], want, tag + ': each message runs what the station holds for ' + provider);
    }
  }

  // ================================ review r8 F2/F3: a key the station holds is never written into a record ============
  // r8-pagecopy-follow.js. A) a BROWSER station's page copy {K_OLD, PROXY}: the page syncs {K_OLD, PROXY}; the record kept
  // K_OLD with no endpoint, so a rotated page key sent K_OLD to the provider default, and a removed one kept it running.
  for (const [connect, sync, ch, extra] of R8) {
    for (const provider of ['openrouter', 'custom']) {
      const page = { [provider]: { key: 'sk-K_OLD', keyPool: [], baseUrl: PROXY } };
      const s = station({ pageCopy: page, roster: { agent: { name: 'NOVA', model: 'openai/gpt-5', provider } },
        secrets: { [ch]: { token: 'tok', provider, model: 'openai/gpt-5', agentId: 'agent', enabled: true } } });
      const tag = ch + ' (' + provider + ')';
      const synced = await s.call(sync, { agentId: 'agent', provider, model: 'openai/gpt-5', key: 'sk-K_OLD', baseUrl: PROXY }, ...extra);
      A.eq(synced.status, 200, tag + ': fixture: the page sync lands');
      A.ok(!recOf(s, ch).key && !recOf(s, ch).baseUrl, tag + ': the page copy key is not written into the record: ' + JSON.stringify({ key: recOf(s, ch).key, baseUrl: recOf(s, ch).baseUrl }));
      const pair = () => { const c = s.stationHubRunConfig('agent', recOf(s, ch)); const m = s.perMessage[ch](); return [c.ok ? c.key : 'refused', c.ok ? c.baseUrl : '', m.configured ? m.key : 'refused']; };
      A.eq(pair(), ['sk-K_OLD', PROXY, 'sk-K_OLD'], tag + ': each message runs the page copy on its own endpoint');
      page[provider] = { key: 'sk-K_NEW', keyPool: [], baseUrl: PROXY };
      A.eq(pair(), ['sk-K_NEW', PROXY, 'sk-K_NEW'], tag + ': the page key rotated with no channel sync: the record follows it (K_NEW at its endpoint)');
      delete page[provider];
      A.ok(pair().every(v => v !== 'sk-K_OLD' && v !== 'sk-K_NEW'), tag + ': the page key removed with no channel sync: no message runs the old key: ' + JSON.stringify(pair()));
      if (provider === 'openrouter') {
        page.openrouter = { key: 'sk-K_OLD', keyPool: [], baseUrl: '' };
        A.eq(pair(), ['sk-K_OLD', 'https://openrouter.ai/api/v1', 'sk-K_OLD'], tag + ': the copy re-saved on the default endpoint: its messages follow it there');
      }
    }
    // the connect hands the page key too (the page's own connect body): nothing written, the record follows the copy
    const page = { openrouter: { key: PAGE_KEY, keyPool: [], baseUrl: PROXY } };
    const c = station({ pageCopy: page });
    await c.call(connect, { token: 'tok', provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', key: PAGE_KEY, baseUrl: PROXY }, ...extra);
    A.ok(!recOf(c, ch).key && !recOf(c, ch).baseUrl, ch + ': a connect handing the page copy key writes neither it nor its endpoint into the record: ' + JSON.stringify(recOf(c, ch)));
    A.eq(c.started[c.started.length - 1].credential, { ref: 'station' }, ch + ': ...and its start function is handed a station reference');
    page.openrouter = { key: 'sk-or-PAGE-ROTATED', keyPool: [], baseUrl: PROXY };
    A.eq([c.stationHubRunConfig('agent', recOf(c, ch)).key, c.perMessage[ch]().key], ['sk-or-PAGE-ROTATED', 'sk-or-PAGE-ROTATED'], ch + ': ...so its messages follow a rotation');
    // the desktop: a body handing the keychain key back is not "the caller's own" either
    const d = station({ runtimeKeys: { openrouter: STATION_OR }, desktop: true });
    await d.call(connect, { token: 'tok', provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', key: STATION_OR }, ...extra);
    A.ok(!recOf(d, ch).key, ch + ': a connect handing the keychain key back writes it into no record');
    // control (r8-fix-sim.js): a caller's OWN key, which the station does not hold, is still saved with its endpoint
    const own = station({});
    await own.call(connect, { token: 'tok', provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', key: 'sk-or-CALLER', baseUrl: PROXY }, ...extra);
    A.eq([recOf(own, ch).key, recOf(own, ch).baseUrl], ['sk-or-CALLER', PROXY], ch + ": a caller's own key and endpoint are still saved together");
  }
  // ...and bots/connect: an agent bot handed the page key keeps none, and runs the copy live
  {
    const s = station({ pageCopy: { openrouter: { key: PAGE_KEY, keyPool: [], baseUrl: PROXY } } });
    const r = await s.call('handleTelegramBotAdd', { token: 'bot-token', agentId: 'agent', provider: 'openrouter', key: PAGE_KEY, baseUrl: PROXY });
    A.eq(r.status, 200, 'bots/connect: fixture: the bot connects: ' + JSON.stringify(r.body));
    A.eq(s.probes[0], { key: PAGE_KEY, baseUrl: PROXY }, 'bots/connect: the probe proves the page copy on its own endpoint');
    A.eq(s.get().telegramBots['777'].credential, { ref: 'station' }, 'bots/connect: the bot keeps neither the page key nor its endpoint: ' + JSON.stringify(s.get().telegramBots['777']));
  }
  // B) the boot churn: the operator's env key E and the page copy K. The record kept K from a sync, the boot scrub dropped it
  // (E ran), the next page sync stored it again (K ran). Now nothing is stored, nothing is scrubbed, and each message runs the
  // station's own resolution — the same before and after a restart, as every routine on this station does.
  for (const [, sync, ch, extra] of R8) {
    const b = station({ env: { OPENROUTER_API_KEY: 'sk-E-ENV' }, pageCopy: { openrouter: { key: 'sk-K-PAGE', keyPool: [], baseUrl: '' } },
      secrets: { [ch]: { token: 'tok', provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent', enabled: true } } });
    const keyOf = () => s2k(b.stationHubRunConfig('agent', recOf(b, ch)));
    await b.call(sync, { agentId: 'agent', provider: 'openrouter', model: 'openai/gpt-5', key: 'sk-K-PAGE' }, ...extra);
    A.ok(!recOf(b, ch).key, ch + ': B) the synced page key is not stored');
    const before = keyOf();
    A.eq(b.reconcile().followers, [], ch + ': B) the boot has nothing to drop');
    A.eq(keyOf(), before, ch + ': B) each message runs the same key after the restart as before it: ' + before);
    await b.call(sync, { agentId: 'agent', provider: 'openrouter', model: 'openai/gpt-5', key: 'sk-K-PAGE' }, ...extra);
    A.eq([before, keyOf()], ['sk-E-ENV|https://openrouter.ai/api/v1', 'sk-E-ENV|https://openrouter.ai/api/v1'], ch + ": B) ...and after the page's next sync: the station's own key (the env key outranks the page copy)");
    // B2) CUSTOM: env key E with no env URL, page copy {K, page-llm}. The record kept K (it ran at page-llm), the boot scrub
    // dropped it and the bot went offline. Now it runs what the station resolves, before and after: E never goes to page-llm.
    // What the station resolves is the page copy's own pair, K at page-llm (header TODO 4, resolved: credential-store S7).
    const c = station({ env: { CUSTOM_OPENAI_KEY: 'sk-E-ENV' }, pageCopy: { custom: { key: 'sk-K-PAGE', keyPool: [], baseUrl: 'http://page-llm/v1' } },
      roster: { agent: { name: 'NOVA', model: 'openai/gpt-5', provider: 'custom' } },
      secrets: { [ch]: { token: 'tok', provider: 'custom', model: 'openai/gpt-5', agentId: 'agent', enabled: true } } });
    await c.call(sync, { agentId: 'agent', provider: 'custom', model: 'openai/gpt-5', key: 'sk-K-PAGE', baseUrl: 'http://page-llm/v1' }, ...extra);
    A.ok(!recOf(c, ch).key && !recOf(c, ch).baseUrl, ch + ': B2) neither the page key nor its endpoint is stored');
    const b2 = s2k(c.stationHubRunConfig('agent', recOf(c, ch)));
    A.eq(c.reconcile().followers, [], ch + ': B2) the boot has nothing to drop');
    A.eq(s2k(c.stationHubRunConfig('agent', recOf(c, ch))), b2, ch + ': B2) the bot is the same after a restart as before it: ' + b2);
    A.ok(b2 !== 'sk-E-ENV|http://page-llm/v1', ch + ": B2) the env key never goes to the page copy's endpoint");
    A.eq(b2, 'sk-K-PAGE|http://page-llm/v1', ch + ": B2) ...a record that follows the station follows the page copy's own pair (TODO 4)");
    A.eq([c.perMessage[ch]().key, c.perMessage[ch]().baseUrl, c.perMessage[ch]().configured], ['sk-K-PAGE', 'http://page-llm/v1', true], ch + ": B2) ...through the hub's secrets() too");
    // ...and a record an older build left holding E: the boot takes it, and E never goes to page-llm
    const hb = station({ env: { CUSTOM_OPENAI_KEY: 'sk-E-ENV' }, pageCopy: { custom: { key: 'sk-K-PAGE', keyPool: [], baseUrl: 'http://page-llm/v1' } },
      roster: { agent: { name: 'NOVA', model: 'openai/gpt-5', provider: 'custom' } },
      secrets: { [ch]: { token: 'tok', key: 'sk-E-ENV', provider: 'custom', model: 'openai/gpt-5', agentId: 'agent', enabled: true } } });
    A.eq([hb.perMessage[ch]().key, hb.perMessage[ch]().baseUrl, hb.perMessage[ch]().configured], ['sk-K-PAGE', 'http://page-llm/v1', true], ch + ": B2) it follows the page copy's own pair, E never at the page copy's endpoint");
    A.eq(s2k(hb.stationHubRunConfig('agent', recOf(hb, ch))), 'sk-K-PAGE|http://page-llm/v1', ch + ': B2) ...and so does its run config');
    // B3) E with a keyless page URL: a keyless pair replaces no key. The bot is refused, the same before and after a restart
    const k = station({ env: { CUSTOM_OPENAI_KEY: 'sk-E-ENV' }, pageCopy: { custom: { keyPool: [], baseUrl: 'http://page-llm/v1' } },
      roster: { agent: { name: 'NOVA', model: 'openai/gpt-5', provider: 'custom' } },
      secrets: { [ch]: { token: 'tok', provider: 'custom', model: 'openai/gpt-5', agentId: 'agent', enabled: true } } });
    A.ok(/^refused: /.test(s2k(k.stationHubRunConfig('agent', recOf(k, ch)))), ch + ': B3) E beside a keyless page URL: the bot is refused: ' + s2k(k.stationHubRunConfig('agent', recOf(k, ch))));
  }
  // ...and the real refusal sentence for that state names the missing endpoint, not a key (the fixture stubs it as "connect a key"):
  // lifted from index.js and run over the store, so the state it names is the store's (resolve().missing, S7)
  {
    const pce = st => new Function('normalizeProvider', 'getProviderProfile', 'providerSignInExpired', 'registryProviderUsesCodex', 'registryProviderUsesDeviceOAuth', 'providerRequiresBaseUrl', 'providerRequiresKey',
      'credStore', 'engineKeyPresence', 'engineCredential', lift('providerCredentialError') + '\nreturn providerCredentialError;')(v => Reg.normalizeProviderId(v, 'openrouter'), Reg.getProviderProfile, () => false, id => id === 'codex',
      Reg.providerUsesDeviceOAuth, Reg.providerRequiresBaseUrl, Reg.providerRequiresKey, st.credStore, id => st.credStore.presence(id), require('../sidecar/engine-credential.js'));
    const G = require('./helpers/credential-store-sandbox.js');
    const refused = G.wiredImpl()({ env: { CUSTOM_OPENAI_KEY: 'sk-E-ENV' }, pushes: [] });
    A.eq(pce(refused)('custom'), 'configure the CUSTOM base URL for CUSTOM_OPENAI_KEY: set CUSTOM_OPENAI_BASE_URL, or save the key next to the URL under SETTINGS → AI & MODELS',
      'B2: a CUSTOM bot refused for {E, \'\'} is told to configure the base URL for that key, with both exits');
    A.eq(Friendly.friendlyError(new Error('sidecar http 400: missing key/model — ' + pce(refused)('custom'))).userMessage, 'The CUSTOM endpoint has no base URL yet — set it under SETTINGS → AI & MODELS.', "...and the page's ladder reads it as it always read that refusal");
    A.eq(pce(G.wiredImpl()({ env: {}, pushes: [] }))('custom'), 'configure the CUSTOM base URL', 'a station with no env key keeps the words it had');
  }

  // ================================ review r8 F4 + F6: /api/run's body key, and a desktop endpoint not handed over yet ===
  {
    const run = sidecarTopLevelFunction('handleRun');
    const from = run.indexOf('  const key = providerRuntimeKey(runProvider, bodyCredential');
    const to = run.indexOf('\n', run.indexOf('  if (!providerHasCredential(runProvider, key, baseUrl,', from));
    const lines = run.slice(from, to);
    const handle = (s, runProvider, body) => {
      let status = 200, text = '';
      const res = { writeHead(c) { status = c; }, end(t) { text = String(t || ''); return 'ended'; } };
      const out = new Function('res', 'body', 'runProvider', 'bodyCredential', 'model', 'oauthLabel', 'getProviderProfile', 'providerRequiresBaseUrl', 'providerHasCredential',
        'providerCredentialError', 'providerRuntimeKey', 'providerRuntimeBaseUrl', 'providerEndpointNotHandedOver', lines + "\nreturn { key, baseUrl, notices: typeof runNotices === 'undefined' ? [] : runNotices };")(
        res, body, runProvider, true, 'some/model', p => p, Reg.getProviderProfile, Reg.providerRequiresBaseUrl,
        (p, k, b) => !!String(b || '').trim() && (Reg.getProviderProfile(p).keyRequired === false || !!String(k || '').trim()), p => 'configure the ' + Reg.getProviderProfile(p).label + ' base URL',
        s.providerRuntimeKey, s.providerRuntimeBaseUrl, s.providerEndpointNotHandedOver);
      return { status, text, out: out === 'ended' ? null : out };
    };
    const OLD = 'http://old-llm:8000/v1', NEW = 'http://new-llm:8001/v1';
    // F4 (r8-run-after-cap.js, BROWSER): the page copy is stale (its engine-key push failed); the page's run sends its key and
    // its new endpoint. The key arrived in THIS body: the endpoint beside it rides with it.
    const page = station({ pageCopy: { custom: { key: 'sk-K', keyPool: [], baseUrl: OLD } } });
    const fresh = handle(page, 'custom', { provider: 'custom', key: 'sk-K', baseUrl: NEW });
    A.eq([fresh.status, fresh.out && fresh.out.key, fresh.out && fresh.out.baseUrl, fresh.out && fresh.out.notices.length], [200, 'sk-K', NEW, 0],
      "F4: a key sent in this run's body runs on the endpoint sent beside it, though the page copy holds another: " + JSON.stringify(fresh.out || fresh.text));
    // ...and the page-copy rule stands for a key the body did NOT send: the station's own copy, a record's
    const keyless = handle(page, 'custom', { provider: 'custom', baseUrl: NEW });
    A.eq([keyless.out && keyless.out.key, keyless.out && keyless.out.baseUrl], ['sk-K', OLD], 'F4: a body with no key runs the page copy on its own endpoint, never the one named');
    A.eq(page.providerRuntimeBaseUrl('custom', NEW, undefined, 'sk-K'), OLD, 'F4: a record handing the page key back (secrets()) keeps the page-copy rule');
    A.eq(page.providerRuntimeBaseUrl('custom', NEW, 'sk-K', 'sk-K'), OLD, '...as does a connect or a sync handing it back');
    const desk = station({ runtimeKeys: { openrouter: STATION_OR } });
    A.eq(handle(desk, 'openrouter', { provider: 'openrouter', baseUrl: EVIL }).out.baseUrl, 'https://openrouter.ai/api/v1', 'F4: the keychain key the body did not send never goes to the endpoint it names');
    A.eq(desk.providerRuntimeBaseUrl('openrouter', EVIL, STATION_OR, STATION_OR, true), EVIL, '...the resolver pairs a held key with a named endpoint only when this request sent that key');
    A.eq(desk.providerRuntimeBaseUrl('openrouter', EVIL, STATION_OR, '', true), 'https://openrouter.ai/api/v1', '...never when it sent no key');
    A.eq(desk.providerRuntimeBaseUrl('openrouter', EVIL, STATION_OR, 'sk-other', true), 'https://openrouter.ai/api/v1', '...nor when the run goes out on another key than the one sent');
    // runOnceCore re-resolves the pair: handleRun tells it the key came from this body, and the callers that re-resolve a key
    // and an endpoint THIS request sent pass that on (F4 everywhere, run-wire.request-key.test.js runs each of them).
    // Counted over the WHOLE sidecar: channels/hub.js and cron-driver.js call runOnce too, and must never claim a body key.
    // runOnceCore also READS the mark twice for the in-flight watch (credential-store lane S3): a key its caller sent in this
    // request, the primary's or a fallback's, is the caller's own and never stopped mid-run.
    const SRC = require('./helpers/source.js').readSidecarSource();
    const F4_FNS = ['handleRun', 'runOnceCore', 'applyVoiceTurnRoute', 'voiceCatalogEntry', 'listModelsForProvider', 'verifyProviderPair', 'turnWindowLimitOf'];
    // All seven owners are multiline top-level functions. This extractor avoids the
    // documented regex-literal overrun in runOnceCore's generic brace scanner.
    const censusBody = sidecarTopLevelFunction;
    const tokens = text => (text.match(/keyInRequest/g) || []).length;
    A.eq([tokens(SRC)].concat(F4_FNS.map(f => tokens(censusBody(f)))), [23, 2, 6, 10, 3, 1, 0, 1],
      'keyInRequest lives in exactly these callers, across every sidecar file (handleRun sets it; the others carry/read it, including the cached-only window endpoint lookup)');
    // ...and only these pass providerRuntimeBaseUrl its 5th argument (inRequest)
    const fifthArgCalls = text => {
      let n = 0;
      const re = /providerRuntimeBaseUrl\(/g;
      for (let m; (m = re.exec(text));) {
        if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;   // the declaration
        let d = 0, args = 1;
        for (let i = m.index + m[0].length; i < text.length; i++) { const ch = text[i]; if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) { if (!d) break; d--; } else if (ch === ',' && !d) args++; }
        if (args >= 5) n++;
      }
      return n;
    };
    A.eq([fifthArgCalls(SRC)].concat(F4_FNS.map(f => fifthArgCalls(censusBody(f)))), [8, 1, 2, 2, 0, 1, 1, 1],
      'only these callers tell the resolver a key came in this request: handleRun; runOnceCore; voice; catalogs; shared verifier; cached-only turn window');
    // each one's provenance is the request's own: the body key (handleRun, probe, validate), else the mark handleRun set
    const voice = sidecarTopLevelFunction('applyVoiceTurnRoute');
    A.ok(/const keyInRequest = callerCredential && o\.keyInRequest === true;/.test(voice) && /next\.keyInRequest = sameProvider && keyInRequest;/.test(voice)
      && /next\.fallbackProviders = \[\{ provider: mainProvider, model: mainModel, key: callerKey, baseUrl: mainBaseUrl, keyInRequest \}\]/.test(voice),
      "the voice route carries the run's own mark: never across providers, and onto the agent's route it falls back to");
    A.ok(/fallbackProviders: Array\.isArray\(fallbackProviders\) \? fallbackProviders\.map\(fb => \(fb && typeof fb === 'object'\) \? Object\.assign\(\{\}, fb, \{ keyInRequest: !!String\(fb\.key \|\| fb\.apiKey \|\| fb\.api_key \|\| ''\)\.trim\(\) \}\) : fb\) : fallbackProviders,/.test(run),
      'handleRun marks each body fallback from its own key, over anything the body named');
    A.ok(/providerRuntimeBaseUrl\(fbProviderId, fb\.baseUrl \|\| fb\.base_url \|\| '', undefined, fb\.key \|\| fb\.apiKey \|\| fb\.api_key \|\| '', fb\.keyInRequest === true\)/.test(sidecarTopLevelFunction('runOnceCore')),
      'the fallback loop reads only that host-set mark');
    A.ok(/runOnce: \(callerCredential && o\.keyInRequest === true && runKey\)\n\s+\? \(wo\) => runOnce\(\(wo && wo\.key === runKey && wo\.provider && normalizeProvider\(wo\.provider\) === providerId\) \? Object\.assign\(\{\}, wo, \{ keyInRequest: true \}\) : wo\)/.test(sidecarTopLevelFunction('runOnceCore')),
      "a team.dispatch worker is marked only while it goes out on the lead's own key and provider");
    A.ok(/const candidate = cleanProviderKey\(body\.key\)/.test(sidecarFunctionSource('verifyProviderPair'))
      && /providerRuntimeBaseUrl\(id, body\.baseUrl \|\| body\.base_url \|\| '', candidateOnly \? candidate : undefined, candidate, !!candidate\)/.test(sidecarFunctionSource('verifyProviderPair'))
      && /providerCheckRoute\(req, res, false\)/.test(sidecarFunctionSource('handleProviderProbe'))
      && /providerCheckRoute\(req, res, true\)/.test(sidecarFunctionSource('handleProviderValidate')),
      'the shared probe/validate verifier marks only the cleaned key its own request carried');
    A.eq((SRC.match(/keyInRequest: true/g) || []).length, 1, 'only the worker hand-off writes a literal true mark (handleRun and probe derive theirs from the body key)');
    A.ok(/ provider: runProvider, baseUrl, keyInRequest: !!\(bodyCredential && String\(\(body && body\.key\) \|\| ''\)\.trim\(\)\), reasoningEffort,/.test(run), 'handleRun hands runOnce keyInRequest only for a key in its body');
    A.ok(/const baseUrl = providerRuntimeBaseUrl\(providerId, callerCredential \? \(o\.baseUrl \|\| o\.base_url \|\| ''\) : '', runKey, callerCredential \? key : '', callerCredential && o\.keyInRequest === true\);/.test(sidecarTopLevelFunction('runOnceCore')),
      "runOnceCore resolves the endpoint with the body's key as the caller's own (and only on the provider the caller named)");

    // F6 (i) (r8-run-after-cap.js, DESKTOP): the window's hand-over has not landed (the 8 s cap fired, or it failed); the page
    // sends no key and its body names the window's endpoint. The station's only answer is the provider default: refused for a
    // retry, never run there.
    const RETRY = "the station has not received this provider's endpoint yet — retry";
    const or = handle(station({ desktop: true, runtimeKeys: { openrouter: STATION_OR } }), 'openrouter', { provider: 'openrouter', baseUrl: PROXY });
    A.eq([or.status, or.text], [503, RETRY], 'F6: a desktop OpenRouter run naming an endpoint the station was never handed is refused for a retry: ' + JSON.stringify(or.out || or.text));
    const an = handle(station({ desktop: true, env: { ANTHROPIC_API_KEY: 'sk-ant-KEYCHAIN' } }), 'anthropic', { provider: 'anthropic', baseUrl: PROXY });
    A.eq([an.status, an.text], [503, RETRY], 'F6: ...an Anthropic one too');
    const fe = Friendly.friendlyError(new Error('sidecar http 503: ' + RETRY));
    A.ok(fe.retryable === true && fe.kind !== 'auth' && fe.kind !== 'provider_server_error', 'F6: the page reads it as a retry, not a key or provider fault: ' + JSON.stringify([fe.kind, fe.retryable]));
    const cu = handle(station({ desktop: true, env: { CUSTOM_OPENAI_KEY: 'sk-c-KEYCHAIN' } }), 'custom', { provider: 'custom', baseUrl: NEW });
    A.ok(cu.status === 400 && /the station holds no CUSTOM endpoint for its saved key/.test(cu.text), 'F6: CUSTOM (it has no default) keeps its own refusal: ' + cu.text);
    const stale = handle(station({ desktop: true, env: { CUSTOM_OPENAI_KEY: 'sk-c-KEYCHAIN' }, runtimeBaseUrls: { custom: OLD } }), 'custom', { provider: 'custom', baseUrl: NEW });
    A.eq([stale.status, stale.out && stale.out.baseUrl, stale.out && stale.out.notices.length], [200, OLD, 1], 'F6: a station holding its own endpoint runs there and says the named one was not used');
    const envUrl = handle(station({ desktop: true, runtimeKeys: { openrouter: STATION_OR }, env: { OPENROUTER_BASE: PROXY2 } }), 'openrouter', { provider: 'openrouter', baseUrl: PROXY });
    A.eq([envUrl.status, envUrl.out && envUrl.out.baseUrl], [200, PROXY2], "F6: ...as does one with the operator's env URL");
    const plain = handle(station({ desktop: true, runtimeKeys: { openrouter: STATION_OR } }), 'openrouter', { provider: 'openrouter' });
    A.eq([plain.status, plain.out && plain.out.baseUrl, plain.out && plain.out.notices.length], [200, 'https://openrouter.ai/api/v1', 0], 'F6: a desktop run naming no endpoint runs on the default as before');
    // a sign-in (Grok, Kimi) resolves its own endpoint and the hand-over never pushes one for it: a run naming one is never
    // refused for a retry; it runs on the sign-in's endpoint and says the named one was not used (keptEndpointProvider)
    for (const id of ['grok', 'kimi']) {
      const so = handle(station({ desktop: true }), id, { provider: id, baseUrl: PROXY });
      A.eq([so.status, so.out && so.out.baseUrl, so.out && so.out.notices.length], [200, Reg.getProviderProfile(id).baseUrl, 1], 'F6: a desktop ' + id + ' sign-in run naming an endpoint is not a 503: ' + JSON.stringify(so.out || so.text));
    }
    const browser = handle(station({ runtimeKeys: { openrouter: STATION_OR } }), 'openrouter', { provider: 'openrouter', baseUrl: PROXY });
    A.eq([browser.status, browser.out && browser.out.notices.length], [200, 1], 'F6: a station no window pushes to (browser, headless) runs on and says so, as before');
  }

  A.report('channels.station-key: a channel record never holds the station key, and a per-run endpoint never carries it');
})().catch(e => { A.ok(false, 'channels.station-key threw: ' + ((e && e.stack) || e)); A.report('channels.station-key'); });
