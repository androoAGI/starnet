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
       OpenRouter key from the keychain, never a model);
     · an env auto-start never stands in for an ENABLED saved record: it is judged on that record's own agent, so a bound
       agent that cannot run leaves the bot off and its record (agent, persona, name) as it was. Judged on the Overseer, the
       env start replaced the binding with an unbound record (pre-merge review 1). A disabled record, or a roster-less
       station's, holds it back no more than before.
   The multi-bot Telegram auto-start admits on its token alone (its messages say what is missing), as before.

   Everything runs the REAL sidecar source lifted by name (test/helpers/source.js): the credential resolvers, runWireFor on
   sidecar/run-wire.js, channelRunConfigFor, stationHubRunConfig, channelFollowsReady and the boot auto-start block itself,
   executed against synthetic station state. Rows marked DEFECT or REVERSE fail on e732831af (the commit before); rows marked
   BINDING fail on 55544fc8c (RCR-001's tip). */
'use strict';
const A = require('./_assert.js');
const vm = require('vm');
const { sidecarFunctionSource, readSidecarSource } = require('./helpers/source.js');
const RunWire = require('../sidecar/run-wire.js');
const Reg = require('../sidecar/providers/registry.js');
const SecretsMod = require('../sidecar/channels/secrets.js');
const { installStore } = require('./helpers/credential-store-sandbox.js');

const SRC = readSidecarSource();
const from = SRC.indexOf('  // auto-start a previously-connected Telegram bot');
const to = SRC.indexOf('  // Restore EVERY saved connector into the manager', from);
A.ok(from > 0 && to > from && to - from < 8000, 'fixture: the boot auto-start block is sliced');
const BOOT = SRC.slice(from, to);
// (credential-store lane, S1) providerRuntimeKey and providerRuntimeBaseUrl are one-liners over the credential store; each station
// below gets the REAL store, built from its own stubs (test/helpers/credential-store-sandbox.js installStore)
const FUNCS = ['providerRuntimeKey', 'providerRuntimeBaseUrl', 'providerHasCredential',
  'providerSignInExpired', 'providerHasStoredCredential', 'runWireEnv', 'runWireFor', 'channelCredential', 'channelKeyLostError', 'channelRunConfigFor', 'stationHubRunConfig', 'channelFollowsReady'];
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
    oauthPrimaryStatus: id => (id === 'codex' && sc.codex ? { tokens: { access_token: 'synthetic-codex-access' }, dead: sc.codex === 'dead' } : { tokens: null }),
    resolveCreditsConfig: () => ({ url: '', apiKey: '' }),
    chatModelId: (p, m) => m, resolveReasoningEffort: (p, e) => e || 'medium',
    providerCredentialError: p => 'connect a ' + p + ' API key',
    channelSecrets: sc.secrets || {}, channelSecretsMod: SecretsMod,
    engineCredential: require('../sidecar/engine-credential.js'), providerLabelOf: id => (Reg.getProviderProfile(id) || {}).label || id,
    channelTokenRuntime: Object.assign({}, sc.tokens || {}),
    GENERIC_CHANNEL_IDS: ['slack', 'matrix', 'signal'],
    telegramBotRecords: () => sc.bots || {},
    startTelegram: (tok, model, cfg) => { started.push({ ch: 'telegram', model, cfg }); persist('telegram', model, cfg); },
    startDiscord: (tok, model, cfg) => { started.push({ ch: 'discord', model, cfg }); persist('discord', model, cfg); },
    startGenericChannel: (id, tok, model, cfg) => { started.push({ ch: id, model, cfg }); persist(id, model, cfg); },
    startTelegramBot: bid => started.push({ ch: 'telegram:' + bid }),
    console: { log() {}, warn: (...a) => started.push({ ch: 'warn', text: a.join(' ') }) }
  };
  // sc.persist: a start saves the record its real start function saves (startTelegram, startDiscord, startGenericChannel):
  // the agent, persona and name it is handed, and only the owner carried over from the record it replaces
  function persist(ch, model, cfg) {
    if (!sc.persist) return;
    const prev = c.channelSecrets[ch] || {}, o = cfg || {};
    c.channelSecrets = Object.assign({}, c.channelSecrets, { [ch]: { model, provider: o.provider || 'openrouter', credential: o.credential || undefined, enabled: true,
      agentId: o.agentId || undefined, system: o.system || undefined, name: o.name || undefined, ownerId: o.ownerId || prev.ownerId || undefined } });
  }
  // the runtime token (env/keychain) first, then the record's own (index.js channelToken)
  c.channelToken =(id, t, rec) => String(t || '').trim() || c.channelTokenRuntime[id] || (rec && rec.token) || '';
  vm.createContext(installStore(c));
  for (const s of LIFTED) vm.runInContext(s, c);
  const run = vm.runInContext('(function () {\n' + BOOT + '\n})', c);
  c.boot = () => { started.length = 0; run(); const warns = started.filter(x => x.ch === 'warn'); A.eq(warns, [], 'fixture: the boot block ran without a warning'); return started.filter(x => x.ch !== 'warn'); };
  c.live = (ch) => { const r = c.stationHubRunConfig('agent', c.channelCredential(ch)); return r.ok ? r.provider + '/' + r.model : 'refused'; };
  return c;
}
const saved = (ch, rec) => ({ [ch]: Object.assign({ token: 'tok-' + ch, enabled: true, agentId: 'agent' }, rec) });

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
  A.eq(fb.stationHubRunConfig('agent', fb.channelCredential('telegram')).wireSource, 'connect', 'the roster-less fallback runs the saved pair (wireSource connect)');
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
// a browser connect saved the caller's own OpenRouter key: it serves OpenRouter only, so after the switch the bot starts on the
// Anthropic key, never that one
{
  const s = station({ roster: { agent: { name: 'NOVA', provider: 'anthropic', model: 'claude-sonnet-5' } }, keys: { anthropic: 'sk-ant-KEYCHAIN' },
    secrets: saved('telegram', { provider: 'openrouter', model: 'openai/gpt-5' }) });
  s.channelSecrets.telegram.credential = s.credStore.putChannel('telegram', { provider: 'openrouter', key: 'sk-or-CALLER-OWN' }).credential;
  A.eq(s.boot().map(x => x.ch), ['telegram'], 'a bot with its own OpenRouter key starts after the switch');
  A.eq(s.stationHubRunConfig('agent', s.channelCredential('telegram')).key, 'sk-ant-KEYCHAIN', '...and runs the Anthropic key, never its own OpenRouter key');
}
// state 5 (credential-store S8, decision 3): a bot whose own key this station no longer holds, beside a station key for its provider.
// It starts, as a sign-in recorded dead does, so each message says what is wrong; it never moves onto the station's key.
{
  const ROSTER = { agent: { name: 'NOVA', provider: 'openrouter', model: 'openai/gpt-5' } };
  for (const ch of CHANNELS) {
    const s = station({ roster: ROSTER, keys: { openrouter: 'sk-or-STATION' }, secrets: saved(ch, { provider: 'openrouter', model: 'openai/gpt-5', credential: { ref: 'channel', bind: 'gone' } }) });
    A.eq(s.boot().map(x => x.ch), [ch], ch + ': a bot refused for its own key still starts, so its messages can say so');
    const run = s.stationHubRunConfig('agent', s.channelCredential(ch));
    A.eq([run.ok, run.error], [false, 'this bot\'s own OPENROUTER key is no longer saved on this station — reconnect it with its key, or with none to use the station\'s'], ch + ': ...and each message is refused with the sentence, beside a station key');
    // its agent moved to another provider: its own key was for OpenRouter only, so the refusal goes with it
    s.agentRoster.set('agent', { name: 'NOVA', provider: 'anthropic', model: 'claude-sonnet-5' });
    s.runtimeKeys.anthropic = 'sk-ant-KEYCHAIN';
    A.eq(s.stationHubRunConfig('agent', s.channelCredential(ch)).key, 'sk-ant-KEYCHAIN', ch + ': on another provider it runs what the station holds there');
  }
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
    A.ok(got.every(x => !(x.cfg || {}).credential && x.model === (sc.env || {}).STARNET_DEFAULT_MODEL), '...each with no credential saved and the env model as its record\'s: ' + JSON.stringify(got));
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

  // pre-merge review 1: an enabled record bound to an agent that cannot run, on a headless station whose Overseer can. The
  // env start, judged on the Overseer, replaced it with an unbound record (the start saves the agent, persona and name it is
  // handed: none), so the bot answered as the Overseer and the binding stayed lost after the Commander added the key.
  const ROSTER2 = { agent: { name: 'NOVA', provider: 'openrouter', model: 'openai/gpt-5' }, coder: { name: 'CODER', provider: 'anthropic', model: 'claude-sonnet-5' } };
  const BOUND = { enabled: true, agentId: 'coder', name: 'CODER', system: 'coder persona', provider: 'openrouter', model: 'openai/gpt-5', ownerId: '77' };
  const binding = x => [x.model, (x.cfg || {}).agentId || null, (x.cfg || {}).name || null, (x.cfg || {}).system || null];
  for (const ch of CHANNELS) {
    const s = station({ persist: true, tokens: TOKENS, env: ENVV, roster: ROSTER2, secrets: { [ch]: Object.assign({}, BOUND) } });
    const before = JSON.stringify(s.channelSecrets[ch]);
    A.eq([s.stationHubRunConfig('coder', s.channelCredential(ch)).ok, s.stationHubRunConfig('agent', {}).ok], [false, true],
      'fixture (' + ch + '): the bound agent cannot run (no Anthropic key) while the Overseer can (the env OpenRouter key)');
    A.eq(s.boot().filter(x => x.ch === ch).map(binding), [], 'BINDING ' + ch + ': an enabled record bound to an agent that cannot run is not replaced by an env start');
    A.eq(JSON.stringify(s.channelSecrets[ch]), before, 'BINDING ' + ch + ': ...and its record, binding and owner, is unchanged');
    s.runtimeKeys.anthropic = 'sk-ant-KEYCHAIN';
    A.eq(s.boot().filter(x => x.ch === ch).map(binding), [['openai/gpt-5', 'coder', 'CODER', 'coder persona']],
      'BINDING ' + ch + ': once the Commander adds the key, the bot starts from its saved config, bound as it was');
    A.eq(s.stationHubRunConfig('coder', s.channelCredential(ch)).provider, 'anthropic', '...and its messages run the bound agent\'s pair');
  }
  // as at e732831af: a DISABLED record holds the env start back no more than before (it is judged on the Overseer); and on a
  // roster-less station the bound agent has no roster wire, so the pair it would run IS the env pair the start saves
  for (const ch of CHANNELS) {
    const off = station({ tokens: TOKENS, env: ENVV, roster: ROSTER2, secrets: { [ch]: Object.assign({}, BOUND, { enabled: false }) } });
    A.eq(off.boot().filter(x => x.ch === ch).map(binding), [['openai/gpt-5', null, null, null]], 'control ' + ch + ': a disabled record: the env start runs on the Overseer, as before');
    const bare = station({ tokens: TOKENS, env: ENVV, secrets: { [ch]: Object.assign({}, BOUND, { provider: 'anthropic', model: 'claude-sonnet-5' }) } });
    A.eq(bare.boot().filter(x => x.ch === ch).map(binding), [['openai/gpt-5', null, null, null]], 'control ' + ch + ': a roster-less station, a saved pair with no key: the env start runs, as before');
  }
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
  A.eq([...BOOT.matchAll(/channelFollowsReady\(\{ provider: 'openrouter', model: envModel, agentId: ([tdr])\.enabled \? \1\.agentId : undefined \}\)/g)].map(m => m[1]), ['t', 'd', 'r'],
    'each env auto-start is admitted on the record it saves, on an enabled saved record\'s own agent');
  A.eq(count(/channelFollowsReady\(/g), 6, 'and nothing else in the boot block admits a channel');
  A.ok(!/providerHasStoredCredential\(|providerHasCredential\(|providerRuntimeKey\(|providerRuntimeBaseUrl\(|ENV\('OPENROUTER_KEY'\)|envKey/.test(BOOT), 'no boot site judges a saved or env pair of its own');
  const follows = sidecarFunctionSource('channelFollowsReady');
  A.ok(/return stationHubRunConfig\(String\(r\.agentId \|\| ''\)\.trim\(\) \|\| 'agent', r, \{ storedCredential: true \}\)\.ok === true;/.test(follows), 'channelFollowsReady is the live resolution (stationHubRunConfig) on the stored credential');
  A.ok(/const credentialed = o\.storedCredential \? providerHasStoredCredential\(provider, key, baseUrl\) : providerHasCredential\(provider, key, baseUrl\);/.test(sidecarFunctionSource('channelRunConfigFor')),
    'channelRunConfigFor judges the stored credential only when asked (every live caller keeps the live verdict)');
  A.eq((SRC.match(/storedCredential: true/g) || []).length, 1, 'only the boot admission asks for the stored verdict');
}

A.report('channels.boot-admission: a saved channel boots on the pair its messages run');
