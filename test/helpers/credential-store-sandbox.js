'use strict';
/* test/helpers/credential-store-sandbox.js — the credential store (sidecar/credential-store.js) in a sandbox, two ways.

   1. A REAL STORE FOR THE LIFTED-SOURCE TESTS. Some tests run sidecar functions lifted by name in a vm or a new Function,
      over stubbed free variables (engine-credential, channels.station-key, run-wire.request-key, channels.boot-admission,
      set-key-body). Before the store they lifted index.js's resolvers (providerRuntimeKey, providerRuntimeBaseUrl,
      pageCopyRidesWith …) and stubbed what those read: runtimeKeys, runtimeKeyPools, runtimeBaseUrls, runtimeKey,
      engineKeys, envFirst, ENV, getProviderProfile. Those resolvers now live in the store, and index.js keeps one-line
      functions with the same names that ask `credStore`. sandboxStore(scope) builds that credStore from the SAME stubs, so
      the lifted one-liners resolve through the real store and the tests' assertions stay word for word. The keychain maps
      ARE the scope's objects (a test that edits runtimeKeys or runtimeBaseUrls mid-way edits the store); the rest is read
      from the scope at call time, so a function a vm context defines after the store (providerHasCredential, lifted) is
      the one it calls.
        sandboxStore(scope) -> store       scope names (each optional; a missing one gets the stub those sandboxes used):
          runtimeKeys, runtimeKeyPools, runtimeBaseUrls  the keychain layer (the desktop shell's push)
          runtimeKey                       the legacy OpenRouter alias: seeded into runtimeKeys.openrouter as boot does. It
                                           IS the keychain's OpenRouter key on every station, so a scope that sets the two
                                           to different keys describes no station and is refused
          SPAWN_CREDENTIALS                the desktop shell's adopted keys and pools (adoptSpawnCredentials), seeded at boot
          engineKeys                       the page layer ({ get } is enough)
          envFirst, envFirstName, ENV      the env readers
          getProviderProfile, normalizeProvider, normalizeProviderIdFromRegistry, registryProviderUsesCodex,
          resolveCreditsConfig, providerHasCredential, console
          SHELL_PUSHES_PROVIDER_CONFIG, loadKeptEndpoints(), saveKeptEndpoints(envelope) -> bool   the kept endpoints
          DESKTOP_SHELL, channelsFollowStation(ids)   the channel layer (S8), in memory: no key kept on the desktop, and what a
                                           conversion tells the host; channelFile: { load(), save(envelope), verify(envelope) } to
                                           give that layer a disk of the test's own
        installStore(context) -> context, with context.credStore = sandboxStore(context)
        stationConsumers({ keys?, baseUrls?, page? }) -> a real store's consumerDeps(), for a module test of a dialer (the voice
                                           legs, the web rung): keys and baseUrls are the keychain layer by provider id, page
                                           the page copy's records ({ key?, keyPool?, baseUrl? }). index.js builds these
                                           modules' credential dependencies with the same function, so a key's endpoint comes
                                           from the registry and the store, never from a test's hand-copied host (S6).

   2. THE GOLDEN (test/credential-store.golden.test.js, test/fixtures/credential-store-golden.json). goldenRows(impl) runs
      one fixed table of stations through an implementation of the resolvers and returns its rows: per station, the key,
      endpoint and backup keys of each run shape, what /api/providers' engine-key presence says, which keys count as
      station-held, and for the desktop tables what is kept on disk. Three implementations:
        trunkImpl({ indexText, root })   trunk's OWN functions, cut from that tree's index.js text and run over that tree's
                                         registry and engine-credential.js. This is how the fixture was captured. This file
                                         never reads another tree: its caller hands the text in.
        wiredImpl({ store? })            THIS tree as production wires it: index.js's adoption of the desktop shell's spawn
                                         keys (the statement at its top), its store construction block and its one-line
                                         functions, lifted through test/helpers/source.js, over the store module (or a
                                         mutated copy of it, to prove the golden bites).
        sandboxImpl()                    the store sandboxStore builds — what the lifted-source tests run on.
      heldValues(station, { channelSecrets? }) runs index.js's own held lists (redaction, the helper strip, the prompt scrub)
      over a wiredImpl station (S5; see it below). refusalRows(impl) runs index.js's own refusal sentence
      (engineCredentialError) over every station of the tables that cannot run (S7; trunkImpl and wiredImpl lift it).
      goldenRows(impl, { only?, unmarked?, poolLineBefore? }) runs every table, or the ones `only` names; `unmarked` drops the
      desktop shell's marker from the shell table's stations (STARNET_DESKTOP_SHELL), which is how its golden deltas are told
      from trunk: trunk ignores the marker, and an unmarked station resolves exactly as trunk did. `poolLineBefore` resolves
      each run's pool with runOnceCore's key-pool line as it was before step S4, which with the store's binding undone gives
      the golden as it was before S4 (delta D2).
      channelStation(o) boots index.js's own channel region over a real folder (S8; see it below).
      A run shape is resolved exactly as runOnceCore resolves the pair it was handed (its runKey, baseUrl and key-pool
      lines): runKey = key(p, callerKey); baseUrl(p, callerUrl, runKey, callerKey, inRequest); keyPool(p, the pool sent with a
      key sent in this request (none = []), else [] when the run's endpoint is not the station's own for that key, runKey). */
const path = require('path');
const { functionSourceIn, readSidecarSource, sidecarSourceFiles } = require('./source.js');

const ROOT = path.resolve(__dirname, '..', '..');
const STORE_REL = 'sidecar/credential-store.js';
const req = (root, rel) => require(path.join(root, rel));
const fnOf = v => typeof v === 'function';

/* ================================ 1. the sandbox store ================================ */
function sandboxStore(scope, opts) {
  const s = scope || {};
  const CS = (opts && opts.store) || req(ROOT, STORE_REL);
  const Reg = req(ROOT, 'sidecar/providers/registry.js');
  const SV = req(ROOT, 'sidecar/secret-values.js');
  const keys = s.runtimeKeys || Object.create(null);
  const alias = String(s.runtimeKey || '').trim(), held = String(keys.openrouter || '').trim();
  if (alias && held && alias !== held) throw new Error('credential-store sandbox: runtimeKey and runtimeKeys.openrouter disagree — the alias is the keychain\'s OpenRouter key, so no station holds that');
  return CS.makeCredentialStore({
    profile: id => (fnOf(s.getProviderProfile) ? s.getProviderProfile(id) : Reg.getProviderProfile(id)),
    normalize: v => (fnOf(s.normalizeProvider) ? s.normalizeProvider(v) : Reg.normalizeProviderId(v, 'openrouter')),
    normalizeId: v => (fnOf(s.normalizeProviderIdFromRegistry) ? s.normalizeProviderIdFromRegistry(v, '') : Reg.normalizeProviderId(v, '')),
    usesCodex: id => (fnOf(s.registryProviderUsesCodex) ? s.registryProviderUsesCodex(id) : Reg.providerUsesCodex(id)),
    linked: () => (fnOf(s.resolveCreditsConfig) ? s.resolveCreditsConfig() : { url: '', apiKey: '' }),
    envFirst: names => (fnOf(s.envFirst) ? s.envFirst(names) : ''),
    envName: names => (fnOf(s.envFirstName) ? s.envFirstName(names) : ''),
    env: k => (fnOf(s.ENV) ? s.ENV(k) : undefined),
    page: { get: id => (s.engineKeys && fnOf(s.engineKeys.get) ? s.engineKeys.get(id) : null),
      put: (...a) => s.engineKeys.put(...a) },
    spawn: s.SPAWN_CREDENTIALS || null,
    alias,
    hasCredential: (id, k, u) => (fnOf(s.providerHasCredential) ? s.providerHasCredential(id, k, u) : false),
    readiness: s.providerVerification,
    // what index.js hands it for redaction (S5): the registry's ids and secret-values.js's shapes
    providerIds: () => (fnOf(s.listProviderProfiles) ? s.listProviderProfiles({ includeInactive: true, public: false }) : Reg.listProviderProfiles({ includeInactive: true, public: false })).map(p => p.id),
    shapes: s.SECRET_SHAPES || SV.SECRET_SHAPES,
    keptEndpoints: {
      on: !!s.SHELL_PUSHES_PROVIDER_CONFIG,
      load: () => (fnOf(s.loadKeptEndpoints) ? s.loadKeptEndpoints() : undefined),
      save: envelope => (fnOf(s.saveKeptEndpoints) ? s.saveKeptEndpoints(envelope) : true)
    },
    channels: Object.assign({ keepsKeys: () => !s.DESKTOP_SHELL, follow: ids => (fnOf(s.channelsFollowStation) ? s.channelsFollowStation(ids) : true) }, s.channelFile),
    warn: line => { if (s.console && fnOf(s.console.warn)) s.console.warn(line); },
    keychain: { keys, pools: s.runtimeKeyPools || Object.create(null), baseUrls: s.runtimeBaseUrls || Object.create(null) }
  });
}
function installStore(context) { context.credStore = sandboxStore(context); return context; }
function stationConsumers(o) {
  const c = o || {};
  return sandboxStore({
    runtimeKeys: Object.assign(Object.create(null), c.keys),
    runtimeBaseUrls: Object.assign(Object.create(null), c.baseUrls),
    engineKeys: { get: id => (c.page && c.page[id]) || null }
  }).consumerDeps();
}

/* ================================ 2. the golden ================================ */
const U = { kc: 'http://kc.test/v1', en: 'http://en.test/v1', br: 'http://br.test/v1', sk: 'http://sk.test/v1', pg: 'http://pg.test/v1', ex: 'http://ex.test/v1' };
const LINKED = { url: 'http://li.test//', apiKey: 'li' };
const URL_CODES = Object.assign({ 'http://li.test/v1': 'li' }, Object.fromEntries(Object.entries(U).map(([k, v]) => [v, k])));

const PROFILE_DEPS = Reg => ({
  getProviderProfile: Reg.getProviderProfile,
  listProviderProfiles: Reg.listProviderProfiles,
  normalizeProviderIdFromRegistry: Reg.normalizeProviderId,
  registryProviderUsesCodex: Reg.providerUsesCodex,
  registryProviderUsesDeviceOAuth: Reg.providerUsesDeviceOAuth,
  providerRequiresKey: Reg.providerRequiresKey,
  providerRequiresBaseUrl: Reg.providerRequiresBaseUrl
});
// what every implementation reads besides its own resolvers, built per station from the scenario
function hostOf(sc, root) {
  const Reg = req(root, 'sidecar/providers/registry.js');
  const EC = req(root, 'sidecar/engine-credential.js');
  const kept = sc.kept || {};
  const host = Object.assign(PROFILE_DEPS(Reg), {
    env: Object.fromEntries(Object.entries(sc.env || {}).filter(([, v]) => v !== undefined)),   // process.env holds strings only
    engineCredential: EC,
    engineKeys: EC.makeEngineKeys({ load: () => (sc.page ? { version: 1, providers: sc.page } : undefined), newRev: () => 'r2', persist: () => true, verify: () => true }),
    resolveCreditsConfig: () => Object.assign({ url: '', apiKey: '' }, sc.linked || {}),
    // providerHasCredential's own state: no sign-in on these stations
    codexTokens: null, oauthProviders: {}, accountLive: () => true, anyExtraAccountLive: () => false,
    saves: [], warns: [], loads: 0,
    path, WORKSPACES: '/station',
    // the one module index.js's adoption statement requires inline (the registry's profile list), from this tree
    require: rel => req(root, path.posix.join('sidecar', rel)),
    // the shapes index.js imports from secret-values.js and hands the store (S5); a tree before S5 has none and never reads them
    SECRET_SHAPES: req(root, 'sidecar/secret-values.js').SECRET_SHAPES,
    // the channel layer's host (S8): no file of its own here, so a wired station's channels live in memory
    crypto: require('crypto'), DESKTOP_SHELL: (sc.env || {}).STARNET_DESKTOP_SHELL === '1', readResilient: () => ({ status: 'absent' }), bothCopiesHold: () => true, channelsFollowStation: () => true, channelCredential: null,
    providerVerification: req(ROOT, 'sidecar/provider-readiness.js').makeProviderReadiness({ now: () => 1000, digest: text => require('crypto').createHash('sha256').update(text).digest('hex') })
  });
  host.loadResilient = (file, tag) => { host.loads++; return tag === 'desktop-endpoints' ? (kept.file === undefined ? undefined : JSON.parse(JSON.stringify(kept.file))) : undefined; };
  host.saveCredentialRemovalVerified = (file, value, proof, tag) => { host.saves.push(JSON.stringify(value)); return kept.saveOk !== false; };
  host.console = { warn: (...a) => host.warns.push(a.join(' ')), log() {}, error() {} };
  if (kept.on) host.env.STARNET_IPC_TOKEN = 'ipc';   // the shell's per-launch token: a station whose shell pushes config
  return host;
}

const HOST_NAMES = ['getProviderProfile', 'listProviderProfiles', 'normalizeProviderIdFromRegistry', 'registryProviderUsesCodex', 'registryProviderUsesDeviceOAuth',
  'providerRequiresKey', 'providerRequiresBaseUrl', 'engineCredential', 'engineKeys', 'resolveCreditsConfig', 'codexTokens', 'oauthProviders', 'accountLive',
  'anyExtraAccountLive', 'loadResilient', 'saveCredentialRemovalVerified', 'console', 'path', 'WORKSPACES', 'require', 'SECRET_SHAPES',
  'crypto', 'DESKTOP_SHELL', 'readResilient', 'bothCopiesHold', 'channelsFollowStation', 'channelCredential', 'providerVerification'];
// the host functions every implementation lifts from its own tree: the env readers, normalizeProvider and the credential check
const HOST_FUNCS = ['ENV', 'envFirst', 'normalizeProvider', 'providerHasCredential'];
// ...and this tree's, whose envFirst reads through envFirstName (S2: the readout names the variable a key came from)
const HERE_FUNCS = HOST_FUNCS.concat(['envFirstName']);
function lift(text, name) {
  const src = functionSourceIn(text, name);
  if (src.length < 20) throw new Error('credential-store golden: ' + name + ' is not in this index.js');
  return src;
}
function between(text, from, to, label) {
  const a = text.indexOf(from), b = a < 0 ? -1 : text.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('credential-store golden: ' + label + ' is not in this index.js');
  return text.slice(a, b + to.length);
}
function compile(body, own) {
  // strict, as index.js is; each call is one fresh station. own: host names the body declares itself
  return new Function('sc', 'host', "'use strict';\nconst process = { env: host.env };\nconst { " + HOST_NAMES.filter(n => !(own || []).includes(n)).join(', ') + ' } = host;\n' + body);
}

/* trunk's OWN functions, cut from its index.js text (the capture) */
function trunkImpl(o) {
  const text = o.indexText, root = o.root;
  const state = between(text, 'const runtimeKeys = Object.create(null);', 'if (runtimeKey) runtimeKeys.openrouter = runtimeKey;', 'the keychain state');
  const save = lift(text, 'saveDesktopEndpoints');
  const desktop = between(text, "const DESKTOP_ENDPOINTS_FILE = path.join(WORKSPACES, '.secrets', 'provider-endpoints.json');", save, 'the kept endpoints');
  const fns = HOST_FUNCS.concat(['providerRuntimeKey', 'providerOperatorKey', 'providerRuntimeKeyPool', 'providerFallbackKeyPool', 'pageCopyRidesWith',
    'providerRuntimeBaseUrl', 'setProviderRuntimeConfig', 'engineKeyPresence', 'channelKeyIsStationHeld', 'channelEndpointIsForeign', 'engineCredentialError']).map(n => lift(text, n));
  const factory = compile(fns.join('\n') + '\n' + state + '\n' + desktop + '\nreturn {' +
    ' key: providerRuntimeKey, baseUrl: providerRuntimeBaseUrl, keyPool: providerRuntimeKeyPool, push: setProviderRuntimeConfig,' +
    ' presence: engineKeyPresence, stationHeld: channelKeyIsStationHeld, endpointIsForeign: channelEndpointIsForeign,' +
    ' keptEndpoints: desktopEndpointsHeld, endpointNotHandedOver: providerEndpointNotHandedOver, alias: () => runtimeKey,' +
    ' keychainValues: () => ({ keys: Object.values(runtimeKeys), pools: Object.values(runtimeKeyPools) }), refusal: engineCredentialError };');
  return sc => { const host = hostOf(sc, root); return Object.assign(factory(sc, host), { host }); };
}

/* THIS tree, as production wires it: index.js's adoption of the shell's spawn keys, its store construction block and its
   one-line functions */
function wiredSource() {
  const text = readSidecarSource();
  const adoption = between(text, 'const SPAWN_CREDENTIALS = credentialStore.adoptSpawnCredentials(', '\n});', 'the adoption of the shell\'s spawn keys');
  const block = between(text, "const DESKTOP_ENDPOINTS_FILE = path.join(WORKSPACES, '.secrets', 'provider-endpoints.json');", 'credStore.loadKeptEndpoints();', 'the credential store construction');
  const fns = HERE_FUNCS.concat(['providerRuntimeKey', 'providerRuntimeKeyPool', 'providerRuntimeBaseUrl', 'setProviderRuntimeConfig', 'engineKeyPresence',
    'channelKeyIsStationHeld', 'desktopEndpointsHeld', 'providerEndpointNotHandedOver', 'engineCredentialError']).map(n => lift(text, n));
  return { adoption, block, fns };
}
// o.store: a store module to wire in place of sidecar/credential-store.js; o.transform(text): an edit to the lifted index.js
// text (both are how the golden test shows it catches a change). Beside the golden's readers each station answers holds()
// (the store's, which index.js's runOnceCore asks), for test/credential-store.no-crossing.test.js, and the redaction readers
// (S5): secretValues(o), urlSecretParts(url) and maskedUrl(url), with credStore itself for heldValues() below.
function wiredImpl(o) {
  const store = (o && o.store) || req(ROOT, STORE_REL);
  const { adoption, block, fns } = wiredSource();
  // in index.js's order: the adoption runs first (it empties the station's env of the shell's pairs), then the store is built
  const lifted = adoption + '\n' + fns.join('\n') + '\n' + block;
  const factory = compile('const credentialStore = host.credentialStore;\n' + (o && o.transform ? o.transform(lifted) : lifted) + '\nreturn {' +
    ' key: providerRuntimeKey, baseUrl: providerRuntimeBaseUrl, keyPool: providerRuntimeKeyPool, push: setProviderRuntimeConfig,' +
    ' presence: engineKeyPresence, stationHeld: channelKeyIsStationHeld, endpointIsForeign: (p, k, u) => credStore.endpointIsForeign(p, k, u),' +
    ' keptEndpoints: desktopEndpointsHeld, endpointNotHandedOver: providerEndpointNotHandedOver, alias: () => credStore.alias(),' +
    ' keychainValues: () => credStore.keychainValues(), holds: (p, k) => credStore.holds(p, k),' +
    ' secretValues: o => credStore.secretValues(o), urlSecretParts: u => credStore.urlSecretParts(u), maskedUrl: u => credStore.maskedUrl(u), credStore, refusal: engineCredentialError };');
  return sc => { const host = Object.assign(hostOf(sc, ROOT), { credentialStore: store }); return Object.assign(factory(sc, host), { host }); };
}

/* INDEX.JS'S HELD LISTS over a wired station (S5): its own secretPart, stationSecretValues and
   stationCredentialValues, and the source its setStationSecretSource statement hands child-env.js, lifted through
   test/helpers/source.js and run over that station's credStore. Every other store those read (channel tokens, the sign-ins,
   connectors, service keys) is empty here, and the channel records are o.channelSecrets (default none), so what they return
   is the provider part (and those records' part), built exactly as index.js builds it.
     heldValues(api, o?) -> { known() the redact() list, childEnv { names, values } as index.js hands it to child-env.js,
                              prompt() the prompt-scrub list, notes [tags a part failed with] }   (api: a wiredImpl station) */
function heldValues(api, o) {
  const text = readSidecarSource();
  const stmt = between(text, 'setStationSecretSource({ names:', '});', 'the helper-environment source');
  const body = ['secretPart', 'stationSecretValues', 'stationCredentialValues'].map(n => lift(text, n)).join('\n') +
    '\nlet childEnv = null;\nconst setStationSecretSource = s => { childEnv = s; };\n' + stmt +
    '\nreturn { known: () => stationSecretValues(), childEnv, prompt: () => stationCredentialValues() };';
  const FREE = ['credStore', 'collectSecretValues', 'failNote', 'process', 'CREDITS_TOKEN', 'channelTokenRuntime', 'channelSecrets', 'codexTokens',
    'oauthProviders', 'connectorOauth', 'connectorConfigs', 'gmailImapTransport', 'liveServiceKeys', 'serviceKeysOwnedEnv'];
  const notes = [];
  const out = new Function(...FREE, "'use strict';\n" + body)(api.credStore, req(ROOT, 'sidecar/secret-values.js').collectSecretValues,
    tag => { notes.push(tag); }, { env: api.host.env }, '', {}, (o && o.channelSecrets) || {}, null, {}, null, [], { passwordOf: () => '' }, () => [], {});
  return Object.assign(out, { notes });
}

/* THE CHANNEL BOOT over real files (S8). channelStation boots index.js's OWN text as production orders it: the adoption of the shell's
   spawn keys, the credential store's construction block, then the channel region (the load, the verified persist, the .bak sweep,
   the reconciliation, the token migration), through the real durable store and the real writer, in o.dir. o.fs stands in for
   node:fs (a test's fault injection). A call is one boot: call it again on the same folder for a restart.
     channelStation({ dir, env?, page?, desktop?, fs?, durableTokens? }) -> { credStore, records(), view(id), hub(id), follow(ids), status(), reconciled, push(p, patch),
                                 putPage(p, input), save(), botRecord(botId, patch), warns, files: { secrets, bak, channel, channelBak } }   a view is
                                 channelCredential's, a hub read channelHubSecrets', save() saveChannelSecrets over the records, botRecord the agent-bound
                                 bot route's own record commit (saveTelegramBotRecord: merged, verified, rolled back in memory when not proven) */
function channelStation(o) {
  const text = readSidecarSource();
  const { adoption, block, fns } = wiredSource();
  const region = between(text, "let channelSecretsStatus = 'absent';", 'nameChannelQuarantines();\n', 'the channel boot region');
  const sharedPersist = text.includes("const { quarantineCorrupt, readResilient, loadResilient, saveResilient } = require('./persist/index.js').host(");
  const lifted = (sharedPersist ? ['saveCredentialRemovalVerified', 'bothCopiesHold'] : ['quarantineCorrupt', 'readResilient', 'loadResilient', 'saveResilient', 'saveCredentialRemovalVerified', 'bothCopiesHold']).map(n => lift(text, n)).join('\n');
  const views = ['channelCredential', 'channelKeyLostError', 'channelHubSecrets', 'isChannelTokenDurable', 'telegramBotRecords', 'saveTelegramBotRecord', 'providerLabelOf'].map(n => lift(text, n)).join('\n');
  const sc = { env: Object.assign({}, o.env, o.desktop ? { STARNET_DESKTOP_SHELL: '1' } : {}), page: o.page };
  const host = Object.assign(hostOf(sc, ROOT), { credentialStore: req(ROOT, STORE_REL), WORKSPACES: o.dir, DESKTOP_SHELL: !!o.desktop });
  const DS = req(ROOT, 'sidecar/durable-store.js');
  const fsio = o.fs || require('fs');
  const persistBinding = sharedPersist ? 'const { quarantineCorrupt, readResilient, loadResilient, saveResilient } = persistHost;\n' : '';
  const durable = new Function('persistHost', 'fs', 'path', 'console', 'readJsonResilient', 'writeJsonResilient', 'saveJsonVerified', 'writeFileDurable',
    '"use strict";\nlet _quarantineSeq = 0;\n' + persistBinding + lifted + '\nreturn { readResilient, loadResilient, saveResilient, saveCredentialRemovalVerified, bothCopiesHold };')(
    sharedPersist ? req(ROOT, 'sidecar/persist/index.js').host({ fs: fsio, path, writeDurable: req(ROOT, 'sidecar/durable-write.js').writeFileDurable }) : null,
    fsio, path, host.console, DS.readJsonResilient, DS.writeJsonResilient, DS.saveJsonVerified, req(ROOT, 'sidecar/durable-write.js').writeFileDurable);
  Object.assign(host, durable, { fs: fsio, channelSecretsMod: req(ROOT, 'sidecar/channels/secrets.js'), saveJsonVerified: DS.saveJsonVerified, writeFileDurable: req(ROOT, 'sidecar/durable-write.js').writeFileDurable,
    CHANNELS_DIR: path.join(o.dir, 'channels'), CHANNEL_SECRETS_FILE: path.join(o.dir, 'channels', 'secrets.json'), channelTokenRuntime: {}, channelTokenDurable: Object.assign({}, o.durableTokens),
    failNote: (tag, e) => host.warns.push(tag + ': ' + ((e && e.message) || e)), expiredSignInNote: () => '', resolveReasoningEffort: (p, v) => v || 'medium' });
  const factory = compile('const credentialStore = host.credentialStore;\nconst { fs, channelSecretsMod, saveJsonVerified, saveResilient, writeFileDurable, CHANNELS_DIR, CHANNEL_SECRETS_FILE, channelTokenRuntime, channelTokenDurable, failNote, expiredSignInNote, resolveReasoningEffort } = host;\n' +
    adoption + '\n' + fns.join('\n') + '\n' + block + '\n' + views + '\n' + region +
    '\nreturn { credStore, reconciled: channelsReconciled, status: () => channelSecretsStatus, records: () => channelSecrets, view: channelCredential, hub: channelHubSecrets, save: () => saveChannelSecrets(channelSecrets), botRecord: saveTelegramBotRecord,' +
    ' push: setProviderRuntimeConfig, putPage: (p, input, opts) => credStore.putPage(p, input, opts) };', ['channelsFollowStation', 'channelCredential']);
  return Object.assign(factory(sc, host), { host, warns: host.warns, files: { secrets: host.CHANNEL_SECRETS_FILE, bak: host.CHANNEL_SECRETS_FILE + '.bak',
    channel: path.join(o.dir, '.secrets', 'channel-credentials.json'), channelBak: path.join(o.dir, '.secrets', 'channel-credentials.json.bak') } });
}

/* the store sandboxStore builds, from the host functions lifted out of this tree */
function sandboxImpl() {
  const text = readSidecarSource();
  const factory = compile('let credStore;\n' + HERE_FUNCS.map(n => lift(text, n)).join('\n') + '\nreturn { ' + HERE_FUNCS.join(', ') + ', wireStore: s => { credStore = s; } };');
  return sc => {
    const host = hostOf(sc, ROOT);
    const f = factory(sc, host);
    // what index.js does at its top: the desktop shell's pairs leave the station's env before the store is built
    const spawn = req(ROOT, STORE_REL).adoptSpawnCredentials(host.env, { desktopShell: host.env.STARNET_DESKTOP_SHELL === '1',
      profiles: req(ROOT, 'sidecar/providers/registry.js').listProviderProfiles({ includeInactive: true, public: false }) });
    const store = sandboxStore(Object.assign({}, host, f, {
      SPAWN_CREDENTIALS: spawn,
      runtimeKey: String(f.ENV('OPENROUTER_KEY') || ''),   // what the store seeds the alias from (after the adoption)
      SHELL_PUSHES_PROVIDER_CONFIG: !!(sc.kept && sc.kept.on),
      loadKeptEndpoints: () => host.loadResilient('/station/.secrets/provider-endpoints.json', 'desktop-endpoints'),
      saveKeptEndpoints: envelope => host.saveCredentialRemovalVerified('/station/.secrets/provider-endpoints.json', envelope, null, 'desktop-endpoints')
    }));
    f.wireStore(store);
    store.loadKeptEndpoints();
    return Object.assign({}, store, { host });
  };
}

/* ---- the encoding: every value on a row is a short code, so a row reads as one line ---- */
function encKey(k) { return String(k || '') || '-'; }
function encUrl(u, def) {
  const s = String(u == null ? '' : u);
  if (!s) return '-';
  if (URL_CODES[s]) return URL_CODES[s];
  if (def && s === def) return 'def';
  return s;
}
// o.poolLineBefore: runOnceCore's key-pool line as it was before step S4 (a key sent in this request, with no pool of its own,
// took the station's pool for that key), which is how the golden test undoes S4
function runOf(api, p, def, shape, o) {
  const k = shape.k || '';
  if (shape.raw) return encKey(api.key(p, '')) + '@' + encUrl(api.baseUrl(p, ''), def) + '[' + api.keyPool(p).join(',') + ']';
  const runKey = api.key(p, k);
  const url = api.baseUrl(p, shape.u || '', runKey, k, shape.r === true);
  const sent = shape.r === true && !(o && o.poolLineBefore);
  const pool = api.keyPool(p, Array.isArray(shape.p) ? shape.p : (sent ? [] : (url !== api.baseUrl(p, '', runKey) ? [] : undefined)), runKey);
  return encKey(runKey) + '@' + encUrl(url, def) + '[' + pool.join(',') + ']';
}
function presenceOf(api, id) {
  const x = api.presence(id);
  return x.keySource + '/' + (x.saved.key ? 'k' : '-') + x.saved.alternates + (x.saved.baseUrl ? 'u' : '-') + '/' + (x.unattendedReady ? 'ready' : 'no');
}
// st: the station's own choice as a gate reads it (runKey undefined); the rest: a run handed that caller credential
const SHAPES = [
  ['st', { raw: true }], ['kc', { k: 'kc' }], ['en', { k: 'en' }], ['pg', { k: 'pg' }], ['fo', { k: 'fo', r: true }],
  ['fo+u', { k: 'fo', u: U.ex, r: true }], ['pg+u', { k: 'pg', u: U.ex, r: true }], ['pg+u.rec', { k: 'pg', u: U.ex }],
  ['kc+u.rec', { k: 'kc', u: U.ex }], ['+u', { u: U.ex }]
];
const OR_SHAPES = SHAPES.concat([['br', { k: 'br' }], ['sk', { k: 'sk' }], ['en2', { k: 'en2' }]]);
// the keys a channel record could hold, every layer's key and pool entry among them: which ones count as station-held
const HELD = ['kc', 'en', 'en2', 'br', 'sk', 'pg', 'kc.p', 'en.p', 'pg.p', 'kc.p1', 'en.p1', 'pg.p1', 'fo'];
function probe(api, p, shapes, o) {
  const def = (api.host.getProviderProfile(p) || {}).baseUrl || '';
  const parts = shapes.map(([label, shape]) => label + '=' + runOf(api, p, def, shape, o));
  parts.push('pres=' + presenceOf(api, p));
  const held = HELD.filter(k => api.stationHeld(p, k));
  parts.push('held=' + (held.join(',') || '-'));
  parts.push('foreign=' + [U.ex, U.pg + '/', ''].map(u => (api.endpointIsForeign(p, 'pg', u) ? 'T' : 'F')).join(''));
  return parts.join(' ');
}
function applyPushes(api, pushes) {
  const out = [];
  for (const [p, patch] of pushes || []) { const report = {}; const id = api.push(p, patch, report); out.push(String(id) + ('endpointPersisted' in report ? '/persisted:' + report.endpointPersisted : '')); }
  return out;
}
function subsets(letters) {
  const out = [''];
  for (const ch of letters) for (const s of out.slice()) out.push(s + ch);
  return out.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}

/* TABLE layers: every combination of the three station layers, for a keyed cloud provider, CUSTOM and a keyless local one */
function layersTable() {
  const rows = [];
  for (const p of ['anthropic', 'custom', 'ollama']) {
    const keyEnv = { anthropic: 'ANTHROPIC_API_KEY', custom: 'CUSTOM_OPENAI_KEY', ollama: null }[p];
    const urlEnv = { anthropic: 'ANTHROPIC_BASE_URL', custom: 'CUSTOM_OPENAI_BASE_URL', ollama: 'OLLAMA_BASE_URL' }[p];
    for (const kc of subsets('kup')) for (const en of subsets(keyEnv ? 'kup' : 'up')) for (const pg of ['', 'k', 'u', 'ku', 'kup']) {
      const env = {};
      if (en.includes('k')) env[keyEnv] = 'en';
      if (en.includes('u')) env[urlEnv] = U.en;
      if (en.includes('p')) env['STARNET_KEY_POOL_' + p.toUpperCase()] = 'en.p';
      const patch = {};
      if (kc.includes('k')) patch.key = 'kc';
      if (kc.includes('u')) patch.baseUrl = U.kc;
      if (kc.includes('p')) patch.keyPool = ['kc.p'];
      const rec = {};
      if (pg.includes('k')) rec.key = 'pg';
      if (pg.includes('p')) rec.keyPool = ['pg.p'];
      if (pg.includes('u')) rec.baseUrl = U.pg;
      rows.push({ label: p + ' K:' + (kc || '-') + ' E:' + (en || '-') + ' P:' + (pg || '-'), p,
        sc: { env, page: pg ? { [p]: Object.assign(rec, { rev: 'r1' }) } : undefined, pushes: kc ? [[p, patch]] : [] } });
    }
  }
  return rows;
}
/* TABLE openrouter: the legacy alias (STARNET_/SKYNET_OPENROUTER_KEY seeds the keychain's OpenRouter key at boot on every
   station), the two bare names, a push, a removal, and the page copy */
function openrouterTable() {
  const ENVS = [
    ['-', {}], ['bare', { OPENROUTER_KEY: 'en' }], ['bare2', { OPENROUTER_API_KEY: 'en2' }], ['bare+bare2', { OPENROUTER_KEY: 'en', OPENROUTER_API_KEY: 'en2' }],
    ['STARNET', { STARNET_OPENROUTER_KEY: 'br' }], ['SKYNET', { SKYNET_OPENROUTER_KEY: 'sk' }], ['shell', { STARNET_OPENROUTER_KEY: 'br', SKYNET_OPENROUTER_KEY: 'br' }],
    ['STARNET+SKYNET', { STARNET_OPENROUTER_KEY: 'br', SKYNET_OPENROUTER_KEY: 'sk' }], ['STARNET-empty+SKYNET', { STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: 'sk' }],
    ['STARNET+bare', { STARNET_OPENROUTER_KEY: 'br', OPENROUTER_KEY: 'en' }], ['STARNET+bare2', { STARNET_OPENROUTER_KEY: 'br', OPENROUTER_API_KEY: 'en2' }],
    ['shell+bare2', { STARNET_OPENROUTER_KEY: 'br', SKYNET_OPENROUTER_KEY: 'br', OPENROUTER_API_KEY: 'en2' }],
    ['bare-url', { OPENROUTER_KEY: 'en', OPENROUTER_BASE: U.en }], ['STARNET-url', { STARNET_OPENROUTER_KEY: 'br', STARNET_OPENROUTER_BASE: U.br }],
    ['pool', { STARNET_KEY_POOL_OPENROUTER: 'en.p' }], ['STARNET+pool', { STARNET_OPENROUTER_KEY: 'br', SKYNET_KEY_POOL_OPENROUTER: 'en.p' }]
  ];
  const PUSHES = [['-', []], ['set', [['openrouter', { key: 'kc' }]]], ['remove', [['openrouter', { key: '' }]]],
    ['set+remove', [['openrouter', { key: 'kc' }], ['openrouter', { key: '' }]]]];
  const PAGES = [['-', undefined], ['k', { key: 'pg', rev: 'r1' }], ['kup', { key: 'pg', baseUrl: U.pg, keyPool: ['pg.p'], rev: 'r1' }]];
  const rows = [];
  for (const [el, env] of ENVS) for (const [pl, pushes] of PUSHES) for (const [gl, rec] of PAGES) {
    rows.push({ label: 'openrouter env:' + el + ' push:' + pl + ' page:' + gl, p: 'openrouter', alias: true, shapes: OR_SHAPES,
      sc: { env, page: rec ? { openrouter: rec } : undefined, pushes } });
  }
  return rows;
}
/* TABLE names: which spelling of a provider's own env names the env layer reads first (bare, then STARNET_, then SKYNET_,
   name by name), a deliberately empty STARNET_ spelling, and the desktop shell's spawn shape beside an OS export (R5) */
function namesTable() {
  const rows = [];
  for (const p of ['anthropic', 'gemini', 'custom']) {
    const Reg = req(ROOT, 'sidecar/providers/registry.js');
    const prof = Reg.getProviderProfile(p);
    for (const [kind, names, vals] of [['key', prof.keyEnv, ['ka', 'kb', 'kc2']], ['url', prof.baseUrlEnv, [U.en, U.br, U.sk]]]) {
      const slots = [];
      names.forEach((n, i) => { slots.push([n, i, 'bare'], ['STARNET_' + n, i, 'STARNET'], ['SKYNET_' + n, i, 'SKYNET']); });
      const sets = slots.map(s => [[s]]);
      for (let a = 0; a < slots.length; a++) for (let b = a + 1; b < slots.length; b++) sets.push([[slots[a], slots[b]]]);
      for (const set of sets) {
        const env = {};
        set[0].forEach((s, j) => { env[s[0]] = vals[j]; });
        rows.push({ label: p + ' ' + kind + ' ' + set[0].map(s => s[0] + '=' + (kind === 'key' ? vals[set[0].indexOf(s)] : encUrl(vals[set[0].indexOf(s)]))).join(' '), p, names: true, sc: { env } });
      }
      names.forEach(n => {
        rows.push({ label: p + ' ' + kind + ' STARNET_' + n + '=(empty) SKYNET_' + n + '=' + (kind === 'key' ? vals[0] : encUrl(vals[0])), p, names: true, sc: { env: { ['STARNET_' + n]: '', ['SKYNET_' + n]: vals[0] } } });
        rows.push({ label: p + ' ' + kind + ' ' + n + '=(blank) STARNET_' + n + '=' + (kind === 'key' ? vals[0] : encUrl(vals[0])), p, names: true, sc: { env: { [n]: '   ', ['STARNET_' + n]: vals[0] } } });
      });
    }
  }
  // R5: the desktop shell writes both spellings of the keychain key; a bare OS export of the same name sits beside it
  rows.push({ label: 'anthropic R5 shell STARNET_+SKYNET_=kc ANTHROPIC_API_KEY=os', p: 'anthropic', names: true,
    sc: { env: { STARNET_ANTHROPIC_API_KEY: 'kc', SKYNET_ANTHROPIC_API_KEY: 'kc', ANTHROPIC_API_KEY: 'os' } } });
  rows.push({ label: 'anthropic R5 then the shell pushes REMOVE', p: 'anthropic', names: true,
    sc: { env: { STARNET_ANTHROPIC_API_KEY: 'kc', SKYNET_ANTHROPIC_API_KEY: 'kc', ANTHROPIC_API_KEY: 'os' }, pushes: [['anthropic', { key: '' }]] } });
  rows.push({ label: 'anthropic shell spawn only, then the shell pushes REMOVE', p: 'anthropic', names: true,
    sc: { env: { STARNET_ANTHROPIC_API_KEY: 'kc', SKYNET_ANTHROPIC_API_KEY: 'kc' }, pushes: [['anthropic', { key: '' }]] } });
  // the env KEY_POOL: branded only, comma-separated, blanks dropped, deduplicated, at most 8
  for (const [l, env] of [['STARNET', { STARNET_KEY_POOL_ANTHROPIC: 'p1,p2' }], ['SKYNET', { SKYNET_KEY_POOL_ANTHROPIC: 'p1' }], ['bare', { KEY_POOL_ANTHROPIC: 'p1' }],
    ['STARNET-empty+SKYNET', { STARNET_KEY_POOL_ANTHROPIC: '', SKYNET_KEY_POOL_ANTHROPIC: 'p1' }], ['messy', { STARNET_KEY_POOL_ANTHROPIC: ' p1 , ,p2,p1,  ' }],
    ['ten', { STARNET_KEY_POOL_ANTHROPIC: 'p1,p2,p3,p4,p5,p6,p7,p8,p9,p10' }], ['custom-alias', { STARNET_KEY_POOL_CUSTOM: 'p1' }]]) {
    rows.push({ label: 'pool env ' + l, p: l === 'custom-alias' ? 'custom' : 'anthropic', names: true, sc: { env } });
  }
  return rows;
}
/* TABLE accounts: StarNet's linked account, the ChatGPT sign-in and the device sign-ins, beside junk in every other layer */
function accountsTable() {
  const rows = [];
  const JUNK = [['-', {}], ['push', { pushes: [['P', { key: 'kc', baseUrl: U.kc, keyPool: ['kc.p1'] }]] }], ['page', { page: { P: { key: 'pg', baseUrl: U.pg, keyPool: ['pg.p1'], rev: 'r1' } } }],
    ['env-pool', { env: { STARNET_KEY_POOL_P: 'en.p1' } }], ['all', { pushes: [['P', { key: 'kc', baseUrl: U.kc }]], page: { P: { key: 'pg', baseUrl: U.pg, rev: 'r1' } }, env: { STARNET_KEY_POOL_P: 'en.p1' } }]];
  for (const p of ['starnet', 'codex', 'grok', 'kimi']) {
    for (const [ll, linked] of [['unlinked', undefined], ['linked', LINKED], ['linked-ws', { url: '  http://li.test  ', apiKey: '  li  ' }]]) {
      if (p !== 'starnet' && ll !== 'unlinked') continue;
      for (const [jl, junk] of JUNK) {
        const sub = JSON.parse(JSON.stringify(junk).split('"P"').join(JSON.stringify(p)).split('KEY_POOL_P').join('KEY_POOL_' + p.toUpperCase()));
        rows.push({ label: p + ' ' + ll + ' ' + jl, p, sc: Object.assign({ env: {}, pushes: [] }, sub, { linked }) });
      }
    }
  }
  return rows;
}
/* TABLE desktop: the endpoints a station whose shell pushes provider config keeps across restarts (and a browser station
   that keeps none), as sequences: boot over a saved file, then pushes, each step's kept set, disk writes and answers */
function desktopTable() {
  const FILES = [
    ['none', undefined], ['valid', { version: 1, baseUrls: { custom: U.kc, openrouter: U.br } }],
    ['every-kind', { version: 1, baseUrls: { custom: ' ' + U.kc + ' ', codex: U.br, kimi: U.br, starnet: U.br, nosuch: U.br, 'openai-compatible': U.sk, OLLAMA: U.en, groq: 7, anthropic: '  ' } }],
    ['array', { version: 1, baseUrls: [U.kc] }], ['string', { version: 1, baseUrls: U.kc }], ['no-baseUrls', { version: 1 }], ['not-object', 'x']
  ];
  const STEPS = [
    ['-', []],
    ['set-custom', [['custom', { baseUrl: U.ex }]]],
    ['set-same-again', [['custom', { baseUrl: U.ex }], ['custom', { baseUrl: U.ex }]]],
    ['clear-custom', [['custom', { baseUrl: '' }]]],
    ['sign-in-endpoint', [['grok', { baseUrl: U.ex }], ['codex', { baseUrl: U.ex }]]],
    ['starnet-endpoint', [['starnet', { baseUrl: U.ex }]]],
    ['key-only', [['custom', { key: 'kc' }]]]
  ];
  const rows = [];
  for (const on of [true, false]) for (const [fl, file] of FILES) for (const saveOk of [true, false]) for (const [sl, pushes] of STEPS) {
    if (!on && (fl !== 'valid' || !saveOk)) continue;   // a station no shell pushes to never reads or writes the file
    if (!saveOk && fl !== 'valid' && fl !== 'none') continue;
    rows.push({ label: (on ? 'desktop' : 'browser') + ' file:' + fl + (saveOk ? '' : ' disk:fails') + ' then:' + sl, desktop: true,
      sc: { env: {}, kept: { on, file, saveOk }, pushes } });
  }
  // what else counts as an endpoint of the station's own: the operator's env URL, and the page copy's (keyless or keyed)
  for (const [l, extra] of [['env-url', { env: { CUSTOM_OPENAI_BASE_URL: U.en, OPENROUTER_BASE: U.en } }],
    ['branded-env-url', { env: { STARNET_CUSTOM_OPENAI_BASE_URL: U.br } }],
    ['page-url', { page: { custom: { baseUrl: U.pg, rev: 'r1' }, openrouter: { key: 'pg', baseUrl: U.pg, rev: 'r1' } } }],
    ['page-key-only', { page: { custom: { key: 'pg', rev: 'r1' } } }]]) {
    rows.push({ label: 'desktop file:none ' + l, desktop: true, sc: Object.assign({ env: {}, kept: { on: true, file: undefined, saveOk: true }, pushes: [] }, extra) });
  }
  return rows;
}
/* TABLE push: what the shell's push accepts and how it normalises it (POST /api/key -> setProviderRuntimeConfig) */
function pushTable() {
  const CASES = [
    ['unknown provider', [['nosuch', { key: 'kc' }]]], ['empty provider', [['', { key: 'kc' }]]], ['alias id or', [['or', { key: 'kc' }]]],
    ['alias id openai-compatible', [['openai-compatible', { key: 'kc', baseUrl: U.kc }]]], ['upper-case id', [['ANTHROPIC', { key: 'kc' }]]],
    ['codex key', [['codex', { key: 'kc' }]]], ['starnet key', [['starnet', { key: 'kc', keyPool: ['kc.p1'] }]]],
    ['padded key', [['anthropic', { key: '  kc  ' }]]], ['numeric key', [['anthropic', { key: 123 }]]], ['zero key', [['anthropic', { key: 'kc' }], ['anthropic', { key: 0 }]]],
    ['null patch', [['anthropic', null]]], ['empty patch', [['anthropic', {}]]], ['key then blank', [['anthropic', { key: 'kc' }], ['anthropic', { key: '   ' }]]],
    ['openrouter set', [['openrouter', { key: 'kc' }]]], ['openrouter set then other provider', [['openrouter', { key: 'kc' }], ['anthropic', { key: 'kc2' }]]],
    ['pool messy', [['anthropic', { keyPool: [' p1 ', 'p1', '', 'p2', null, 'p3'] }]]], ['pool not array', [['anthropic', { keyPool: 'p1,p2' }]]],
    ['pool ten', [['anthropic', { keyPool: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'] }]]], ['pool then empty', [['anthropic', { keyPool: ['p1'] }], ['anthropic', { keyPool: [] }]]],
    ['padded url', [['anthropic', { baseUrl: '  ' + U.kc + '  ' }]]], ['url then blank', [['anthropic', { baseUrl: U.kc }], ['anthropic', { baseUrl: ' ' }]]],
    ['all three then remove all', [['custom', { key: 'kc', baseUrl: U.kc, keyPool: ['kc.p1'] }], ['custom', { key: '', baseUrl: '', keyPool: [] }]]],
    ['key removed, pool kept', [['custom', { key: 'kc', keyPool: ['kc.p1'] }], ['custom', { key: '' }]]]
  ];
  return CASES.map(([l, pushes]) => ({ label: l, pushTable: true, sc: { env: {}, pushes } }));
}
/* TABLE shell: the desktop shell's spawn shapes — STARNET_DESKTOP_SHELL=1 and the IPC token, each keychain key and key pool
   written in both spellings with one value (main.rs sidecar_command, set_sidecar_branded_env) — beside a user's own exports
   (one spelling, two values, a bare name, a pair under another of the provider's names), then the shell's pushes: a REMOVE, a
   rotation, a cleared pool. Step S2 adopts the shell's pairs into the keychain layer and deletes them from the environment,
   so this table holds its golden deltas (D1). Trunk ignores the marker; o.unmarked builds the same stations without it,
   which resolve as trunk did. */
function shellTable(o) {
  const Reg = req(ROOT, 'sidecar/providers/registry.js');
  const marked = !(o && o.unmarked);
  const pair = (name, v) => ({ ['STARNET_' + name]: v, ['SKYNET_' + name]: v });
  const rows = [];
  for (const p of ['anthropic', 'openrouter', 'custom', 'gemini']) {
    const names = Reg.getProviderProfile(p).keyEnv;
    const n = names[0], last = names[names.length - 1], pool = 'KEY_POOL_' + p.toUpperCase();
    const ENVS = [
      ['pair', pair(n, 'kc')], ['pair+bare', Object.assign(pair(n, 'kc'), { [n]: 'os' })],
      ['single STARNET_', { ['STARNET_' + n]: 'br' }], ['single SKYNET_', { ['SKYNET_' + n]: 'sk' }],
      ['split', { ['STARNET_' + n]: 'br', ['SKYNET_' + n]: 'sk' }], ['blank pair', pair(n, '')], ['bare', { [n]: 'os' }],
      ['pair+pool', Object.assign(pair(n, 'kc'), pair(pool, 'kc.p1,kc.p2'))], ['pair+single pool', Object.assign(pair(n, 'kc'), { ['STARNET_' + pool]: 'en.p1' })],
      ['pool pair only', pair(pool, 'kc.p1')]
    ];
    if (last !== n) {
      ENVS.push(['pair+bare ' + last, Object.assign(pair(n, 'kc'), { [last]: 'os' })], ['pair on ' + last, pair(last, 'kc')],
        ['pairs on both names', Object.assign(pair(n, 'kc'), pair(last, 'br'))], ['pairs on both names, one value', Object.assign(pair(n, 'kc'), pair(last, 'kc'))]);
    }
    const PUSHES = [['-', []], ['remove', [[p, { key: '' }]]], ['rotate', [[p, { key: 'kc2' }]]], ['pool cleared', [[p, { keyPool: [] }]]]];
    for (const [el, shape] of ENVS) for (const [pl, pushes] of PUSHES) {
      const env = Object.assign({}, shape, p === 'custom' ? { CUSTOM_OPENAI_BASE_URL: U.en } : {}, marked ? { STARNET_DESKTOP_SHELL: '1' } : {});
      rows.push({ label: p + ' ' + el + ' push:' + pl, p, shell: true, sc: { env, kept: { on: true }, pushes } });
    }
  }
  return rows;
}
const TABLES = [['layers', layersTable], ['openrouter', openrouterTable], ['names', namesTable], ['accounts', accountsTable], ['desktop', desktopTable], ['push', pushTable],
  ['shell', shellTable]];

function rowOf(impl, row, o) {
  const api = impl(row.sc);
  const pushed = applyPushes(api, row.sc.pushes);
  if (row.desktop) {
    const ids = ['custom', 'openrouter', 'ollama', 'anthropic', 'groq', 'grok', 'codex', 'starnet'];
    return 'pushes=[' + pushed.join(',') + '] kept=' + JSON.stringify(api.keptEndpoints()) + ' loads=' + api.host.loads + ' saves=' + (api.host.saves.join('|') || '-') +
      ' warns=' + api.host.warns.length + ' notHandedOver=' + (ids.filter(id => api.endpointNotHandedOver(id)).join(',') || '-') +
      ' custom=' + encUrl(api.baseUrl('custom', '')) + ' openrouter=' + encUrl(api.baseUrl('openrouter', ''), 'https://openrouter.ai/api/v1') +
      ' ollama=' + encUrl(api.baseUrl('ollama', ''), 'http://127.0.0.1:11434/v1') + ' grok=' + encUrl(api.baseUrl('grok', ''), 'https://api.x.ai/v1');
  }
  if (row.pushTable) {
    const v = api.keychainValues();
    const ids = ['anthropic', 'openrouter', 'custom', 'codex', 'starnet'];
    return 'pushes=[' + pushed.join(',') + '] alias=' + encKey(api.alias()) + ' keychain=' + JSON.stringify(v) + ' ' +
      ids.map(id => id + '=' + runOf(api, id, (api.host.getProviderProfile(id) || {}).baseUrl || '', { raw: true })).join(' ');
  }
  if (row.names) {
    const def = (api.host.getProviderProfile(row.p) || {}).baseUrl || '';
    return 'st=' + runOf(api, row.p, def, { raw: true }) + ' pres=' + presenceOf(api, row.p) + ' alias=' + encKey(api.alias());
  }
  if (row.shell) {
    const def = (api.host.getProviderProfile(row.p) || {}).baseUrl || '';
    const held = ['kc', 'kc2', 'os', 'br', 'sk', 'kc.p1', 'en.p1'].filter(k => api.stationHeld(row.p, k));
    return 'st=' + runOf(api, row.p, def, { raw: true }) + ' pres=' + presenceOf(api, row.p) + ' held=' + (held.join(',') || '-') +
      (row.p === 'openrouter' ? ' alias=' + encKey(api.alias()) : '');
  }
  return probe(api, row.p, row.shapes || SHAPES, o) + (row.alias ? ' alias=' + encKey(api.alias()) : '');
}

// o.only: the table names to run (default every table); o.unmarked: the shell table's stations without the shell's marker;
// o.poolLineBefore: each run's pool by runOnceCore's key-pool line as it was before step S4 (runOf)
function goldenRows(impl, o) {
  const out = {};
  for (const [name, table] of TABLES) {
    if (o && o.only && !o.only.includes(name)) continue;
    const t = out[name] = {};
    for (const row of table(o)) {
      if (Object.prototype.hasOwnProperty.call(t, row.label)) throw new Error('credential-store golden: two rows are labelled ' + row.label);
      t[row.label] = rowOf(impl, row, o);
    }
  }
  return out;
}
/* THE REFUSALS (S7): for every station of the provider tables that cannot run, the sentence index.js's own engineCredentialError
   says for it, keyed 'table / label' (impl: trunkImpl or wiredImpl). This is what golden delta D4 reads: an unattended run's
   refusal is the one credential outcome the rows above do not show. */
function refusalRows(impl, o) {
  const out = {};
  for (const [name, table] of TABLES) {
    if (name === 'desktop' || name === 'push') continue;   // those ask about endpoints and pushes, not about one provider's run
    for (const row of table(o)) {
      const api = impl(row.sc);
      applyPushes(api, row.sc.pushes);
      if (!api.presence(row.p).unattendedReady) out[name + ' / ' + row.label] = api.refusal(row.p, 'this routine');
    }
  }
  return out;
}
// every row that differs, as 'table / label: want -> got'
function diffRows(want, got) {
  const out = [];
  for (const name of new Set(Object.keys(want).concat(Object.keys(got)))) {
    const a = want[name] || {}, b = got[name] || {};
    for (const label of new Set(Object.keys(a).concat(Object.keys(b)))) {
      if (a[label] !== b[label]) out.push(name + ' / ' + label + ':\n    want ' + a[label] + '\n    got  ' + b[label]);
    }
  }
  return out;
}
// the store module's own source, for a mutation (read through the source helper, as every test reads sidecar source)
function storeSource() { return sidecarSourceFiles().find(f => f.rel === STORE_REL).text; }
function loadStoreFrom(text) {
  const mod = { exports: {} };
  new Function('module', 'exports', text)(mod, mod.exports);
  return mod.exports;
}

module.exports = {
  sandboxStore, installStore, stationConsumers,
  trunkImpl, wiredImpl, sandboxImpl, channelStation, heldValues, goldenRows, refusalRows, diffRows, storeSource, loadStoreFrom,
  U, SHAPES, TABLES: TABLES.map(t => t[0])
};
