/* node test/channels.boot-admission.test.js — RCR-001: a saved channel's boot auto-start is judged on the pair its messages
   will run.

   0852b00e5 moved every station hub's messages onto the routed agent's live pair (stationHubRunConfig -> runWireFor); the
   boot auto-start kept judging a channel saved WITH a model on its SAVED provider's credential. Connect a bot under
   OpenRouter, switch its agent to Anthropic, remove the OpenRouter key, restart: every message would run on Anthropic, yet
   the bot stayed offline (Codex independent review, rcr001-boot-matrix). The admission is now ONE helper, channelFollowsReady,
   on the resolution the live path reads (stationHubRunConfig, with storedCredential), for Telegram, Discord, the generic
   channels and their env auto-starts:
     · the roster-less fallback stands: an agent with no roster wire runs the saved pair, so the boot judges that pair;
     · the STORED credential stands: a sign-in recorded dead still starts the bot (it answers with the expired-sign-in error);
     · an env auto-start is judged on the record it saves ({ openrouter, STARNET_DEFAULT_MODEL, no key }), never on
       OPENROUTER_KEY alone: the env model marks the headless deploy (the desktop shell injects the channel token and the
       OpenRouter key from the keychain, never a model).
   The multi-bot Telegram auto-start admits on its token alone (its messages say what is missing), as before.

   Everything runs the REAL sidecar source lifted by name (test/helpers/source.js): the credential resolvers, runWireFor on
   sidecar/run-wire.js, channelRunConfigFor, stationHubRunConfig, channelFollowsReady and the boot auto-start block itself,
   executed against synthetic station state. Rows marked DEFECT or REVERSE fail on e732831af (the commit before). */
'use strict';
const A = require('./_assert.js');
const vm = require('vm');
const { sidecarFunctionSource, readSidecarSource } = require('./helpers/source.js');
const RunWire = require('../sidecar/run-wire.js');
const Reg = require('../sidecar/providers/registry.js');

const SRC = readSidecarSource();
const from = SRC.indexOf('  // auto-start a previously-connected Telegram bot');
const to = SRC.indexOf('  // Restore EVERY saved connector into the manager', from);
A.ok(from > 0 && to > from && to - from < 8000, 'fixture: the boot auto-start block is sliced');
const BOOT = SRC.slice(from, to);
const FUNCS = ['providerRuntimeKey', 'providerOperatorKey', 'pageCopyRidesWith', 'providerRuntimeBaseUrl', 'providerHasCredential',
  'providerSignInExpired', 'providerHasStoredCredential', 'runWireEnv', 'runWireFor', 'channelRunConfigFor', 'stationHubRunConfig', 'channelFollowsReady'];
const LIFTED = FUNCS.map(n => { const s = sidecarFunctionSource(n); A.ok(s.length > 20, 'fixture: ' + n + ' is lifted'); return s; });
const CHANNELS = ['telegram', 'discord', 'slack'];

/* One station: roster, runtime keys (the keychain push), operator env, the ChatGPT sign-in, the saved channel records and the
   runtime channel tokens (the env/keychain ones). boot() runs the real auto-start block and returns the channels it started. */
function station(sc) {
  const env = Object.assign({}, sc.env || {});
  const started = [];
  const c = {
    RunWire, agentRoster: new Map(Object.entries(sc.roster || {})),
    runtimeKeys: Object.assign(Object.create(null), sc.keys || {}), runtimeBaseUrls: Object.create(null),
    runtimeKey: String(env.STARNET_OPENROUTER_KEY || ''),   // index.js seeds it from ENV('OPENROUTER_KEY')
    engineKeys: { get: () => null },
    normalizeProviderId: p => Reg.normalizeProviderId(p, ''), normalizeProvider: p => Reg.normalizeProviderId(p, 'openrouter'),
    getProviderProfile: Reg.getProviderProfile, registryProviderUsesCodex: Reg.providerUsesCodex, registryProviderUsesDeviceOAuth: Reg.providerUsesDeviceOAuth,
    providerRequiresKey: Reg.providerRequiresKey, providerRequiresBaseUrl: Reg.providerRequiresBaseUrl,
    ENV: k => env['STARNET_' + k], envFirst: names => { for (const n of names || []) if (env[n]) return env[n]; return ''; },
    // sc.codex: 'live' (signed in), 'dead' (stored, recorded dead: a relogin-class refresh failure), else none
    codexTokens: sc.codex ? { access_token: 'synthetic-codex-access' } : null, oauthProviders: {}, CODEX_DEFAULT_MODEL: 'gpt-5.5',
    accountLive: () => sc.codex === 'live', anyExtraAccountLive: () => false,
    oauthPrimaryStatus: id => (id === 'codex' && sc.codex ? { tokens: { access_token: 'synthetic-codex-access' } } : { tokens: null }),
    resolveCreditsConfig: () => ({ url: '', apiKey: '' }),
    chatModelId: (p, m) => m, resolveReasoningEffort: (p, e) => e || 'medium',
    providerCredentialError: p => 'connect a ' + p + ' API key',
    channelSecrets: sc.secrets || {},
    channelTokenRuntime: Object.assign({}, sc.tokens || {}),
    GENERIC_CHANNEL_IDS: ['slack', 'matrix', 'signal'],
    telegramBotRecords: () => sc.bots || {},
    startTelegram: (tok, key, model, cfg) => started.push({ ch: 'telegram', key, model, cfg }),
    startDiscord: (tok, key, model, cfg) => started.push({ ch: 'discord', key, model, cfg }),
    startGenericChannel: (id, tok, key, model, cfg) => started.push({ ch: id, key, model, cfg }),
    startTelegramBot: bid => started.push({ ch: 'telegram:' + bid }),
    console: { log() {}, warn: (...a) => started.push({ ch: 'warn', text: a.join(' ') }) }
  };
  // the runtime token (env/keychain) first, then the record's own (index.js channelToken)
  c.channelToken = (id, t, rec) => String(t || '').trim() || c.channelTokenRuntime[id] || (rec && rec.token) || '';
  vm.createContext(c);
  for (const s of LIFTED) vm.runInContext(s, c);
  const run = vm.runInContext('(function () {\n' + BOOT + '\n})', c);
  c.boot = () => { started.length = 0; run(); const warns = started.filter(x => x.ch === 'warn'); A.eq(warns, [], 'fixture: the boot block ran without a warning'); return started.filter(x => x.ch !== 'warn'); };
  c.live = (ch) => { const r = c.stationHubRunConfig('agent', c.channelSecrets[ch] || {}); return r.ok ? r.provider + '/' + r.model : 'refused'; };
  return c;
}
const saved = (ch, rec) => ({ [ch]: Object.assign({ token: 'tok-' + ch, enabled: true, agentId: 'agent', key: '' }, rec) });

// ================================ the Codex boot matrix (rcr001-boot-matrix.cjs), every saved channel ==================
{
  const SAVED = { provider: 'openrouter', model: 'old-openrouter-model' };
  const CHANGED = { agent: { name: 'NOVA', provider: 'anthropic', model: 'new-anthropic-model' } };
  const ROWS = [
    // [id, kind, roster, runtime keys, saved pair, boots, live pair]
    ['defect_old_key_removed_new_key_present', 'DEFECT', CHANGED, { anthropic: 'sk-ant-NEW' }, SAVED, true, 'anthropic/new-anthropic-model'],
    ['control_old_key_retained_new_key_present', 'control', CHANGED, { openrouter: 'sk-or-OLD', anthropic: 'sk-ant-NEW' }, SAVED, true, 'anthropic/new-anthropic-model'],
    ['control_new_key_absent_old_key_also_absent', 'control', CHANGED, {}, SAVED, false, 'refused'],
    ['control_saved_model_empty_uses_current_pair', 'control', CHANGED, { anthropic: 'sk-ant-NEW' }, Object.assign({}, SAVED, { model: '' }), true, 'anthropic/new-anthropic-model'],
    ['control_saved_model_empty_new_key_absent', 'control', CHANGED, {}, Object.assign({}, SAVED, { model: '' }), false, 'refused'],
    ['control_no_roster_saved_pair_fallback', 'control', {}, { openrouter: 'sk-or-OLD' }, SAVED, true, 'openrouter/old-openrouter-model'],
    ['control_no_roster_saved_pair_no_key', 'control', {}, {}, SAVED, false, 'refused'],
    // the reverse mismatch Codex characterized: the saved provider still holds a key, the agent's live pair has none
    ['reverse_old_key_present_new_key_absent', 'REVERSE', CHANGED, { openrouter: 'sk-or-OLD' }, SAVED, false, 'refused']
  ];
  for (const [id, kind, roster, keys, pair, boots, livePair] of ROWS) {
    for (const ch of CHANNELS) {
      const s = station({ roster, keys, secrets: saved(ch, pair) });
      A.eq(s.live(ch), livePair, kind + ' ' + id + ' (' + ch + '): every message runs ' + livePair);
      A.eq(s.boot().map(x => x.ch), boots ? [ch] : [], kind + ' ' + id + ' (' + ch + '): the bot ' + (boots ? 'starts' : 'stays off') + ', as its messages would run');
    }
  }
  // the fallback is the record's pair, labelled as such (the connect level), only while the agent has no roster wire
  const fb = station({ roster: {}, keys: { openrouter: 'sk-or-OLD' }, secrets: saved('telegram', SAVED) });
  A.eq(fb.stationHubRunConfig('agent', fb.channelSecrets.telegram).wireSource, 'connect', 'the roster-less fallback runs the saved pair (wireSource connect)');
}

// ================================ switch, remove, restart (the RCR-001 sequence), every saved channel =====================
for (const ch of CHANNELS) {
  // connected under OpenRouter on the station's own key: the record holds no key (F2) and the agent's pair
  const s = station({ roster: { agent: { name: 'NOVA', provider: 'openrouter', model: 'openai/gpt-5' } }, keys: { openrouter: 'sk-or-KEYCHAIN' },
    secrets: saved(ch, { provider: 'openrouter', model: 'openai/gpt-5' }) });
  A.eq([s.boot().map(x => x.ch), s.live(ch)], [[ch], 'openrouter/openai/gpt-5'], ch + ': connected under OpenRouter, the bot starts');
  // Settings: the agent moves to Anthropic, its key is added, and the old OpenRouter key is removed
  s.agentRoster.set('agent', { name: 'NOVA', provider: 'anthropic', model: 'claude-sonnet-5' });
  s.runtimeKeys.anthropic = 'sk-ant-KEYCHAIN';
  delete s.runtimeKeys.openrouter;
  A.eq(s.live(ch), 'anthropic/claude-sonnet-5', ch + ': after the switch every message runs the Anthropic pair');
  A.eq(s.boot().map(x => x.ch), [ch], 'DEFECT ' + ch + ': ...and after a restart the bot starts on it (it stayed offline: its saved OpenRouter pair had no key)');
  // the Anthropic key is removed too: nothing it runs on is left, and the boot agrees
  delete s.runtimeKeys.anthropic;
  A.eq([s.boot().map(x => x.ch), s.live(ch)], [[], 'refused'], ch + ': with no key for the pair it runs, the bot stays off after a restart');
}
// a browser connect saved the caller's own OpenRouter key in the record: it serves OpenRouter only, so after the switch the
// bot starts on the Anthropic key, never the record's OpenRouter one
{
  const s = station({ roster: { agent: { name: 'NOVA', provider: 'anthropic', model: 'claude-sonnet-5' } }, keys: { anthropic: 'sk-ant-KEYCHAIN' },
    secrets: saved('telegram', { provider: 'openrouter', model: 'openai/gpt-5', key: 'sk-or-CALLER-OWN' }) });
  A.eq(s.boot().map(x => x.ch), ['telegram'], 'a record holding its own OpenRouter key starts after the switch');
  A.eq(s.stationHubRunConfig('agent', s.channelSecrets.telegram).key, 'sk-ant-KEYCHAIN', '...and runs the Anthropic key, never the record\'s OpenRouter key');
}

// ================================ the STORED credential: a sign-in recorded dead still starts the bot ====================
for (const ch of CHANNELS) {
  const CODEX = { agent: { name: 'NOVA', provider: 'codex', model: 'gpt-5.5' } };
  const dead = station({ roster: CODEX, codex: 'dead', secrets: saved(ch, { provider: 'codex', model: 'gpt-5.5' }) });
  A.eq(dead.boot().map(x => x.ch), [ch], ch + ': a ChatGPT sign-in recorded dead still starts the bot (it answers with the expired-sign-in error)');
  A.eq(dead.live(ch), 'refused', '...while its messages are refused on the live verdict until the Commander reconnects');
  const moved = station({ roster: CODEX, codex: 'dead', secrets: saved(ch, { provider: 'openrouter', model: 'openai/gpt-5' }) });
  A.eq(moved.boot().map(x => x.ch), [ch], 'DEFECT ' + ch + ': saved under OpenRouter (no key left), its agent moved to a ChatGPT sign-in recorded dead: the bot starts');
  const none = station({ roster: CODEX, secrets: saved(ch, { provider: 'codex', model: 'gpt-5.5' }) });
  A.eq(none.boot().map(x => x.ch), [], ch + ': no sign-in at all stays off');
  const live = station({ roster: CODEX, codex: 'live', secrets: saved(ch, { provider: 'openrouter', model: 'openai/gpt-5' }) });
  A.eq([live.boot().map(x => x.ch), live.live(ch)], [[ch], 'codex/gpt-5.5'], 'DEFECT ' + ch + ': saved under OpenRouter (no key left), its agent moved to a live ChatGPT sign-in: the bot starts on the pair it runs');
}

// ================================ the env auto-starts (headless deploys): judged on the record they save =================
{
  const TOKENS = { telegram: 'tg-env', discord: 'dc-env', slack: 'xoxb-env xapp-env' };
  const envRow = (label, kind, sc, want, wantLive) => {
    const s = station(Object.assign({ tokens: TOKENS, secrets: {} }, sc));
    const got = s.boot();
    A.eq(got.map(x => x.ch), want, kind + ' env: ' + label);
    A.ok(got.every(x => x.key === '' && x.model === (sc.env || {}).STARNET_DEFAULT_MODEL), '...each with no key saved and the env model as its record\'s: ' + JSON.stringify(got));
    if (wantLive) A.eq(s.stationHubRunConfig('agent', { provider: 'openrouter', model: sc.env.STARNET_DEFAULT_MODEL }).ok ? 'runs' : 'refused', wantLive, '...and its messages ' + wantLive);
  };
  const ENVV = { STARNET_OPENROUTER_KEY: 'sk-or-ENV-OPERATOR', STARNET_DEFAULT_MODEL: 'openai/gpt-5' };
  envRow('a roster-less headless station with OPENROUTER_KEY and DEFAULT_MODEL starts every env bot', 'control', { env: ENVV }, CHANNELS, 'runs');
  envRow('an agent on Anthropic with its key and no OPENROUTER_KEY starts them on the Anthropic pair', 'DEFECT',
    { env: { STARNET_DEFAULT_MODEL: 'openai/gpt-5' }, roster: { agent: { name: 'NOVA', provider: 'anthropic', model: 'claude-sonnet-5' } }, keys: { anthropic: 'sk-ant-KEYCHAIN' } }, CHANNELS, 'runs');
  envRow('an agent on Anthropic with no Anthropic key stays off, though OPENROUTER_KEY is set', 'REVERSE',
    { env: ENVV, roster: { agent: { name: 'NOVA', provider: 'anthropic', model: 'claude-sonnet-5' } } }, [], 'refused');
  envRow('no DEFAULT_MODEL: no env bot starts (the model marks the headless deploy), whatever runs', 'control',
    { env: { STARNET_OPENROUTER_KEY: 'sk-or-ENV-OPERATOR' }, roster: { agent: { name: 'NOVA', provider: 'openrouter', model: 'openai/gpt-5' } } }, []);
  // a saved, enabled record that runs wins over the env start (the env branch is the else)
  const both = station({ tokens: TOKENS, env: ENVV, keys: { anthropic: 'sk-ant-KEYCHAIN' }, roster: { agent: { name: 'NOVA', provider: 'anthropic', model: 'claude-sonnet-5' } },
    secrets: saved('telegram', { provider: 'openrouter', model: 'old-openrouter-model' }) });
  A.eq(both.boot().filter(x => x.ch === 'telegram').map(x => x.model), ['old-openrouter-model'], 'a saved telegram record that runs starts from its saved config, not from env');
}

// ================================ the multi-bot Telegram auto-start: the token alone, as before ===========================
{
  const s = station({ bots: { 42: { token: 'bot-42', agentId: 'agent', provider: 'openrouter' } }, roster: { agent: { name: 'NOVA', provider: 'anthropic', model: 'claude-sonnet-5' } } });
  s.channelTokenRuntime['telegram:42'] = 'bot-42';
  A.eq(s.boot().map(x => x.ch), ['telegram:42'], 'an agent-bound bot starts on its token (no pair is judged at boot, its messages name what is missing)');
}

// ================================ the source shape: one helper at every boot site, on the live resolution =================
{
  const count = re => (BOOT.match(re) || []).length;
  A.eq([count(/if \(t\.enabled && tgTok && channelFollowsReady\(t\)\) \{ startTelegram\(/g), count(/if \(d\.enabled && dcTok && channelFollowsReady\(d\)\) \{ startDiscord\(/g),
    count(/if \(r\.enabled && authOk && channelFollowsReady\(r\)\) \{\n/g)], [1, 1, 1], 'each saved channel is admitted by channelFollowsReady alone');
  A.eq(count(/channelFollowsReady\(\{ provider: 'openrouter', model: envModel \}\)/g), 3, 'each env auto-start is admitted on the record it saves');
  A.eq(count(/channelFollowsReady\(/g), 6, 'and nothing else in the boot block admits a channel');
  A.ok(!/providerHasStoredCredential\(|providerHasCredential\(|providerRuntimeKey\(|providerRuntimeBaseUrl\(|ENV\('OPENROUTER_KEY'\)|envKey/.test(BOOT), 'no boot site judges a saved or env pair of its own');
  const follows = sidecarFunctionSource('channelFollowsReady');
  A.ok(/return stationHubRunConfig\(String\(r\.agentId \|\| ''\)\.trim\(\) \|\| 'agent', r, \{ storedCredential: true \}\)\.ok === true;/.test(follows), 'channelFollowsReady is the live resolution (stationHubRunConfig) on the stored credential');
  A.ok(/const credentialed = o\.storedCredential \? providerHasStoredCredential\(provider, key, baseUrl\) : providerHasCredential\(provider, key, baseUrl\);/.test(sidecarFunctionSource('channelRunConfigFor')),
    'channelRunConfigFor judges the stored credential only when asked (every live caller keeps the live verdict)');
  A.eq((SRC.match(/storedCredential: true/g) || []).length, 1, 'only the boot admission asks for the stored verdict');
}

A.report('channels.boot-admission: a saved channel boots on the pair its messages run');
