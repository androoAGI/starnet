/* node test/run-wire.request-key.test.js — F4 everywhere: a key sent in THIS request rides the endpoint sent beside it, on
   every path that re-resolves that key and endpoint, and nowhere else.

   Review r8 F4 made /api/run's body key the caller's own (providerRuntimeBaseUrl's 5th argument, inRequest), but only in
   handleRun and runOnceCore. Every other caller that re-resolves a key and an endpoint the request sent still passed four
   arguments, so a body key EQUAL to the #89 page copy's (the copy lags the page's last change when its push failed) was
   sent to the copy's OLDER endpoint — conversation content, or a key probe, to a service the Commander had moved away from
   (Codex's repro, case 2: the voice route resolved the old endpoint while /api/run resolved the new one). The callers:
     · applyVoiceTurnRoute — the voice hop, its catalog reads (voiceCatalogEntry -> listModelsForProvider) and the agent's
       route it builds as the hop's fallback;
     · runOnceCore's fallback loop — that built fallback, and each /api/run body fallback (handleRun marks them: the mark is
       the host's, never read from the body);
     · a team.dispatch worker on the lead's own key and provider (it inherits the lead's key and endpoint);
     · /api/providers/probe (its catalog read and its credential probe) and /api/providers/validate.
   The rule stays exact: the exemption needs a key THIS request carried that is also the key the call goes out on. A record's
   key, a sync's or a connect's, a key the station holds (the keychain push, the operator's env key, the page copy) keeps
   the page-copy / never-pair rule, and a sign-in's bearer never follows a per-run endpoint.
   Every row runs the REAL sidecar source lifted by name (test/helpers/source.js), against recording transports; each row
   marked DEFECT fails on e732831af (the commit before). The source locks with the exact counts are in
   channels.station-key.test.js (its F4 section). */
'use strict';
const A = require('./_assert.js');
const vm = require('vm');
const { sidecarFunctionSource, sidecarTopLevelFunction } = require('./helpers/source.js');
const RunWire = require('../sidecar/run-wire.js');
const Reg = require('../sidecar/providers/registry.js');
const VoiceRoute = require('../sidecar/voice-chat-route.js');
const { installStore } = require('./helpers/credential-store-sandbox.js');

const K = 'sk-or-PAGE-KEY', OLD = 'https://old-gateway.example/v1', NEW = 'https://new-gateway.example/v1';
const KA = 'sk-ant-PAGE-KEY', OLD_A = 'https://old-anthropic-proxy.example/v1';
const OR_DEFAULT = Reg.getProviderProfile('openrouter').baseUrl, ANT_DEFAULT = Reg.getProviderProfile('anthropic').baseUrl;
const KIMI_DEFAULT = Reg.getProviderProfile('kimi').baseUrl;
const STATION_OR = 'sk-or-STATION-KEYCHAIN', STATION_ANT = 'sk-ant-STATION-KEYCHAIN';

// (credential-store lane, S1) providerRuntimeKey and providerRuntimeBaseUrl are one-liners over the credential store; each station
// below gets the REAL store, built from its own stubs (test/helpers/credential-store-sandbox.js installStore)
const FUNCS = ['providerRuntimeKey', 'providerRuntimeBaseUrl', 'providerHasCredential',
  'runWireEnv', 'runWireFor', 'runWireOfRun', 'voiceCatalogEntry', 'listModelsForProvider', 'applyVoiceTurnRoute',
  'cleanProviderKey', 'verifyProviderPair', 'providerCheckRoute', 'handleProviderProbe', 'handleProviderValidate'];
const LIFTED = FUNCS.map(n => { const s = sidecarFunctionSource(n); A.ok(s.length > 20, 'fixture: ' + n + ' is lifted'); return s; });

/* One station. o.page: the #89 page copies (stale: saved with the OLD endpoints); o.keys: the keychain push; o.voice: the
   voice chat model slot. Every outbound call (a catalog read, a credential probe, a fetch) is recorded with its key and
   endpoint in s.calls. */
function station(o) {
  const opts = o || {};
  const calls = [];
  const env = Object.assign({}, opts.env || {});
  const c = {
    RunWire, voiceChatRoute: VoiceRoute,
    agentRoster: new Map([['agent', { name: 'NOVA', provider: 'openrouter', model: 'main-test' }]]),
    runtimeKeys: Object.assign(Object.create(null), opts.keys || {}), runtimeBaseUrls: Object.create(null), runtimeKey: String((opts.keys || {}).openrouter || ''),
    engineKeys: { get: id => (opts.page && opts.page[id]) || null },
    normalizeProviderId: p => Reg.normalizeProviderId(p, ''), normalizeProvider: p => Reg.normalizeProviderId(p, 'openrouter'),
    normalizeProviderIdFromRegistry: Reg.normalizeProviderId,
    getProviderProfile: Reg.getProviderProfile, registryProviderUsesCodex: Reg.providerUsesCodex, registryProviderUsesDeviceOAuth: Reg.providerUsesDeviceOAuth,
    billing: require('../sidecar/billing-class.js').makeBilling({ profileOf: Reg.getProviderProfile }),   // the route's payer (billing-class.js)
    providerUsesCodex: p => Reg.providerUsesCodex(Reg.normalizeProviderId(p, 'openrouter')), providerUsesDeviceOAuth: p => Reg.providerUsesDeviceOAuth(Reg.normalizeProviderId(p, 'openrouter')),
    providerRequiresKey: Reg.providerRequiresKey, providerRequiresBaseUrl: Reg.providerRequiresBaseUrl,
    ENV: k => env['STARNET_' + k], envFirst: names => { for (const n of names || []) if (env[n]) return env[n]; return ''; },
    codexTokens: null, CODEX_DEFAULT_MODEL: 'gpt-5.5', CRON_DEFAULT_MODEL: 'cron-default',
    oauthProviders: { kimi: { tokens: { access_token: 'synthetic-kimi-bearer' } } }, accountLive: () => true, anyExtraAccountLive: () => false,
    orderedAccountChain: () => [{ id: '' }], oauthPrimaryStatus: id => c.oauthProviders[id] || {},
    providerReadiness: () => ({ unattendedReady: true }),
    providerVerification: require('../sidecar/provider-readiness.js').makeProviderReadiness({ now: () => 1000,
      digest: s => require('crypto').createHash('sha256').update(s).digest('hex') }),
    resolveCreditsConfig: () => ({ url: '', apiKey: '' }),
    chatModelId: (p, m) => m, providerCredentialError: p => 'connect a ' + p + ' key',
    effectiveVoiceChat: () => Object.assign({ provider: '', model: '', reasoningEffort: '' }, opts.voice || {}),
    promptTierCeiling: () => 0, RUN_CONTEXT_DEFAULTS: { compactAt: 0.65 }, makeContext: () => ({ estimateMessages: () => 0, estimateTokens: () => 0 }),
    attachments: { expandForRun: async m => m },
    VOICE_CATALOG_TTL_MS: 600000, VOICE_CATALOG_WAIT_MS: 2500, voiceCatalogCache: new Map(),
    extraAccountProviderFor: () => null, ensureCodexAccessToken: async () => 'synthetic-codex-bearer', forceRefreshCodexAccessToken: async () => '',
    ensureOAuthAccessToken: async () => 'synthetic-kimi-bearer', oauthInferenceHeaders: () => ({}),
    ImageTask: { isAgentModel: () => true }, isBatchOnlyModel: () => false,
    selectProvider: cfg => ({ listModels: async () => { calls.push({ via: 'catalog', provider: cfg.provider, key: cfg.key || cfg.token || '', baseUrl: cfg.baseUrl || '' }); return [{ id: 'main-test' }, { id: 'voice-test' }]; },
      verifyCredential: args => require('../sidecar/providers/factory.js').selectProvider(cfg).verifyCredential(args) }),
    fetch: async (url, init) => {
      const headers = (init || {}).headers || {}, auth = String(headers.Authorization || '');
      calls.push({ via: 'fetch', url: String(url), auth, key: headers['x-api-key'] || auth.replace(/^Bearer /, '') });
      return new Response(JSON.stringify({ data: String(url).endsWith('/auth/key') ? { label: 'fixture' } : [{ id: 'main-test' }] }), { status: 200 });
    },
    readBody: async () => JSON.stringify(c.reqBody || {}),
    noteKeyCheckFailure: () => {}, failNote: () => {}, redact: s => s,
    AbortController, setTimeout, clearTimeout, console: { warn() {}, log() {} }
  };
  vm.createContext(installStore(c));
  for (const s of LIFTED) vm.runInContext(s, c);
  c.calls = calls;
  c.call = async (handler, body) => {
    c.reqBody = body; let out = '';
    await c[handler]({}, { writeHead() {}, end(t) { out = String(t || ''); } });
    return JSON.parse(out || '{}');
  };
  return c;
}
const PAGE = { openrouter: { key: K, keyPool: [], baseUrl: OLD }, anthropic: { key: KA, keyPool: [], baseUrl: OLD_A } };
const ends = calls => calls.map(x => x.via === 'fetch' ? x.url : x.baseUrl);

(async () => {
  // ================================ (a) the voice route: the hop, its catalog reads, the fallback it builds ===============
  {
    // what handleRun hands runOnceCore for a browser page's run: its key and the endpoint it resolved for it (F4: the new one)
    const turn = extra => Object.assign({ agentId: 'agent', provider: 'openrouter', model: 'main-test', key: K, baseUrl: NEW, messages: [{ role: 'user', content: 'hi' }] }, extra || {});
    // same-provider voice model: Codex's case 2
    let s = station({ page: PAGE, voice: { provider: 'openrouter', model: 'voice-test' } });
    let r = await s.applyVoiceTurnRoute(turn({ keyInRequest: true }));
    A.eq([r.voiceRoute.used, r.key, r.baseUrl], [true, K, NEW], 'DEFECT voice: a key sent in THIS body takes the voice hop to the endpoint sent beside it (Codex case 2): ' + JSON.stringify([r.key, r.baseUrl]));
    A.eq(r.keyInRequest, true, '...and the hop keeps the mark, so runOnceCore resolves the same endpoint');
    A.eq(ends(s.calls), [NEW], 'DEFECT voice: the voice model\'s catalog read went out on that key to the new endpoint: ' + JSON.stringify(s.calls));
    A.eq(r.fallbackProviders[0], { provider: 'openrouter', model: 'main-test', key: K, baseUrl: NEW, keyInRequest: true }, 'the agent\'s route it falls back to carries the key, the endpoint and the mark');
    // the same key handed back WITHOUT the mark (a record, a channel voice note on the page key): the copy's endpoint
    s = station({ page: PAGE, voice: { provider: 'openrouter', model: 'voice-test' } });
    r = await s.applyVoiceTurnRoute(turn());
    A.eq([r.key, r.baseUrl, r.keyInRequest], [K, OLD, false], 'voice: the page key the body did not send keeps the endpoint the copy was saved with');
    A.eq(ends(s.calls), [OLD], '...as do its catalog reads');
    A.eq(r.fallbackProviders[0].keyInRequest, false, '...and its fallback carries no mark');
    // the agent's own model with reasoning off: the main route's catalog read (mainEntry)
    s = station({ page: PAGE, voice: { provider: 'openrouter', model: 'main-test', reasoningEffort: 'none' } });
    r = await s.applyVoiceTurnRoute(turn({ keyInRequest: true }));
    A.eq([r.voiceRoute.used, ends(s.calls)], [false, [NEW]], 'DEFECT voice: the agent\'s own route reads its catalog at the endpoint sent with its key: ' + JSON.stringify(s.calls));
    s = station({ page: PAGE, voice: { provider: 'openrouter', model: 'main-test', reasoningEffort: 'none' } });
    await s.applyVoiceTurnRoute(turn());
    A.eq(ends(s.calls), [OLD], '...and the copy\'s endpoint without the mark');
    // a station-held key the body did not send (the desktop keychain) never pairs with the endpoint the body named
    s = station({ keys: { openrouter: STATION_OR }, voice: { provider: 'openrouter', model: 'voice-test' } });
    r = await s.applyVoiceTurnRoute(turn({ key: STATION_OR }));
    A.eq([r.key, r.baseUrl], [STATION_OR, OR_DEFAULT], 'voice: the keychain key never goes to the endpoint a body named');
    A.ok(s.calls.every(x => x.baseUrl !== NEW), '...nor does any catalog read: ' + JSON.stringify(s.calls));
    // a voice model on ANOTHER provider runs that provider's station key on its own endpoint; the mark does not cross
    s = station({ page: PAGE, keys: { anthropic: STATION_ANT }, voice: { provider: 'anthropic', model: 'voice-test' } });
    r = await s.applyVoiceTurnRoute(turn({ keyInRequest: true }));
    A.eq([r.provider, r.key, r.baseUrl, r.keyInRequest], ['anthropic', STATION_ANT, ANT_DEFAULT, false], 'voice: a hop to another provider carries neither the body key, its endpoint nor the mark');
    A.eq(s.calls.map(x => [x.provider, x.key, x.baseUrl]), [['anthropic', STATION_ANT, ANT_DEFAULT]], '...its catalog read too');
    A.eq(r.fallbackProviders[0], { provider: 'openrouter', model: 'main-test', key: K, baseUrl: NEW, keyInRequest: true }, '...while the agent\'s own route it falls back to keeps the body\'s pair');
    // a sign-in's bearer never follows a per-run endpoint, marked or not
    s = station({ voice: { provider: 'kimi', model: 'voice-test' } });
    r = await s.applyVoiceTurnRoute(turn({ provider: 'kimi', model: 'main-test', key: 'sk-kimi-typed', keyInRequest: true }));
    A.eq([r.provider, r.baseUrl], ['kimi', KIMI_DEFAULT], 'voice: a sign-in runs on its own endpoint, never the one the body named');
    A.ok(s.calls.every(x => x.baseUrl === KIMI_DEFAULT), '...and reads its catalog there: ' + JSON.stringify(s.calls));
  }

  // ================================ (b) runOnceCore's fallback loop ========================================================
  {
    const core = sidecarTopLevelFunction('runOnceCore');
    const fromAt = core.indexOf('  const providerFallbacks = [];');
    const toAt = core.indexOf('  const fallbacks = rotationFallbacks', fromAt);
    A.ok(fromAt > 0 && toAt > fromAt && toAt - fromAt < 6000, "fixture: runOnceCore's fallback loop is sliced");
    // runWatch: the run's watch over the keys its adapters send (credential-store.js inFlight, step S3), from this station's store
    const entries = (s, list, runWatch) => new Function('savedProviderFallbacks', 'o', 'normalizeProvider', 'providerId', 'chatModelId', 'model', 'providerRuntimeBaseUrl', 'providerRuntimeKey', 'providerHasCredential',
      'getProviderProfile', 'credits', 'CREDITS_URL', 'managedRun', 'providerUsesCodex', 'providerUsesDeviceOAuth', 'selectProvider', 'reasoningEffort', 'makeCostEngine', 'runCapUsd',
      'effectiveCaps', 'CAPS', 'unknownProviderError', 'runNotices', 'runStartExtra', 'normalizeProviderId', 'runWatch', 'billing', core.slice(fromAt, toAt) + '\nreturn providerFallbacks;')(
      [], { fallbackProviders: list }, s.normalizeProvider, 'openai', (p, m) => m, 'primary-model',
      s.providerRuntimeBaseUrl, s.providerRuntimeKey, s.providerHasCredential, Reg.getProviderProfile, { configured: () => false }, '', false, s.providerUsesCodex, s.providerUsesDeviceOAuth,
      cfg => ({ cfg, priceOf: () => null }), 'medium', () => ({}), Infinity, {}, { maxUnpricedTokens: 1 }, () => '', [], {}, s.normalizeProviderId, runWatch || s.credStore.inFlight(), require('../sidecar/billing-class.js').makeBilling({ profileOf: Reg.getProviderProfile }));
    const loop = (s, list) => entries(s, list).map(f => [f.providerId, f.provider.cfg.key || '', f.provider.cfg.baseUrl]);
    const s = station({ page: PAGE, keys: { anthropic: STATION_ANT } });
    A.eq(loop(s, [{ provider: 'openrouter', model: 'main-test', key: K, baseUrl: NEW, keyInRequest: true }]), [['openrouter', K, NEW]], 'fixture: the loop builds the fallback on the key it was handed');
    const fb = list => loop(s, list).map(r => r[2]);
    A.eq(fb([{ provider: 'openrouter', model: 'main-test', key: K, baseUrl: NEW, keyInRequest: true }]), [NEW], 'DEFECT fallback: the voice route\'s agent route (marked) runs at the endpoint sent with its key');
    A.eq(fb([{ provider: 'openrouter', model: 'main-test', key: K, baseUrl: NEW }]), [OLD], 'fallback: the same key unmarked (a record\'s, a saved chain\'s) runs at the copy\'s endpoint');
    A.eq(fb([{ provider: 'anthropic', model: 'claude-x', baseUrl: NEW, keyInRequest: true }]), [ANT_DEFAULT], 'fallback: a mark with no key of its own never pairs the station key with the named endpoint');
    A.eq(fb([{ provider: 'anthropic', model: 'claude-x', key: STATION_ANT, baseUrl: NEW }]), [ANT_DEFAULT], 'fallback: a station-held key handed back unmarked never follows the named endpoint');
    A.eq(fb([{ provider: 'kimi', model: 'k3', key: 'sk-kimi-typed', baseUrl: NEW, keyInRequest: true }]), [KIMI_DEFAULT], 'fallback: a sign-in never follows a per-run endpoint, marked or not');
    // handleRun marks each body fallback itself, from its own key: a body's own "keyInRequest" is overwritten
    const run = sidecarTopLevelFunction('handleRun');
    const m = /\n\s+fallbackProviders: (Array\.isArray\(fallbackProviders\) \? fallbackProviders\.map\([^\n]+\) : fallbackProviders),\n/.exec(run);
    A.ok(!!m, 'fixture: handleRun\'s body-fallback mark is found');
    const mark = list => m ? new Function('fallbackProviders', 'return (' + m[1] + ');')(list) : list;
    const body = [{ provider: 'anthropic', model: 'claude-x', key: KA, baseUrl: NEW }, { provider: 'anthropic', model: 'claude-y', baseUrl: NEW, keyInRequest: true }, null];
    const marked = mark(body);
    A.eq(marked.map(x => x && x.keyInRequest), [true, false, null], 'handleRun marks a body fallback that carries its own key, and unmarks a forged keyless one');
    A.eq(body[1].keyInRequest, true, '...without mutating the body');
    A.eq(fb(marked.slice(0, 2)), [NEW, ANT_DEFAULT], 'DEFECT fallback: a body fallback\'s own key (equal to the page copy\'s) runs at the endpoint sent beside it; the forged one runs the station key at its own endpoint');
    A.eq(mark(undefined), undefined, 'no body fallbacks: nothing is invented');
    // S3 (decision 7): each fallback adapter is watched on the key it sends, never on a key the body sent itself
    const page = JSON.parse(JSON.stringify(PAGE));
    const sw = station({ page, keys: { anthropic: STATION_ANT } });
    const w = sw.credStore.inFlight();
    const built = entries(sw, mark([{ provider: 'openrouter', model: 'main-test', key: K, baseUrl: NEW }, { provider: 'anthropic', model: 'claude-x', baseUrl: NEW, keyInRequest: true }])
      .concat([{ provider: 'openrouter', model: 'main-test-2', key: K, baseUrl: NEW }]), w);
    A.eq(built.map(f => [f.providerId, f.provider.cfg.key]), [['openrouter', K], ['anthropic', STATION_ANT], ['openrouter', K]],
      'S3 fixture: three fallbacks — the body\'s own key, a forged keyless mark (the station key), the page key handed back unmarked');
    delete page.openrouter;                       // the page REMOVEs its OpenRouter copy while the run goes on
    sw.runtimeKeys.anthropic = 'sk-ant-ROTATED';  // ...and the keychain rotates Anthropic
    A.eq(built.map(f => w.gone(f.provider)), ['', 'anthropic', 'openrouter'],
      'S3: a fallback on the key the body sent is never stopped; the station key behind a forged mark and the page key handed back unmarked stop once their layer lets them go');
  }

  // ================================ (c) a team.dispatch worker on the lead's own key ======================================
  {
    const core = sidecarTopLevelFunction('runOnceCore');
    const w = /\n\s+runOnce: (\(callerCredential && o\.keyInRequest === true && runKey\)\n\s+\? \(wo\) => runOnce\([^\n]+\)\n\s+: runOnce),\n/.exec(core);
    A.ok(!!w, "fixture: the lead's worker runOnce is found");
    const lines = (/\n  const runKey = providerRuntimeKey\(providerId, [^\n]+;\n  const baseUrl = providerRuntimeBaseUrl\(providerId, [^\n]+;/.exec(core) || [])[0] || '';
    A.ok(!!lines, "fixture: runOnceCore's key and endpoint lines are found");
    const s = station({ page: PAGE, keys: { anthropic: STATION_ANT, openrouter: STATION_OR } });
    // the worker's own run resolves its key and endpoint with runOnceCore's own lines
    const resolve = wo => new Function('o', 'key', 'providerId', 'callerCredential', 'providerRuntimeKey', 'providerRuntimeBaseUrl', lines + '\nreturn [runKey, baseUrl];')(
      wo, wo.key, s.normalizeProvider(wo.provider), true, s.providerRuntimeKey, s.providerRuntimeBaseUrl);
    const dispatch = (lead, wo) => {
      let got = null;
      const ro = w ? new Function('runOnce', 'callerCredential', 'o', 'runKey', 'normalizeProvider', 'providerId', 'return (' + w[1] + ');')(x => { got = x; }, true, lead, lead.key, s.normalizeProvider, 'openrouter') : (x => { got = x; });
      ro(wo);
      return resolve(got);
    };
    const LEAD = { key: K, provider: 'openrouter', keyInRequest: true };
    A.eq(dispatch(LEAD, { key: K, provider: 'openrouter', baseUrl: NEW, model: 'worker-model' }), [K, NEW], 'DEFECT worker: a worker on the lead\'s own wire runs where the lead runs (the endpoint sent with its key)');
    A.eq(dispatch(LEAD, { key: STATION_ANT, provider: 'anthropic', baseUrl: ANT_DEFAULT, model: 'claude-x' }), [STATION_ANT, ANT_DEFAULT], 'worker: one on a station key for another provider is never marked');
    A.eq(dispatch(LEAD, { key: STATION_OR, provider: 'openrouter', baseUrl: NEW, model: 'worker-model' }), [STATION_OR, OR_DEFAULT], 'worker: one handed the station\'s own key on the lead\'s provider is never marked: that key never follows the named endpoint');
    A.eq(dispatch({ key: K, provider: 'openrouter' }, { key: K, provider: 'openrouter', baseUrl: NEW, model: 'worker-model' }), [K, OLD], 'worker: a lead whose key the body did not send hands its workers no mark (the copy\'s endpoint)');
  }

  // ================================ (d) /api/providers/probe and /validate ===============================================
  {
    // probe: the page re-checks its saved OpenRouter key at the endpoint it now shows (its copy still holds the old one)
    let s = station({ page: PAGE });
    let out = await s.call('handleProviderProbe', { provider: 'openrouter', key: K, baseUrl: NEW });
    A.eq(ends(s.calls), [NEW + '/auth/key'], 'DEFECT probe: the native credential verifier uses the body\'s endpoint without a catalog detour: ' + JSON.stringify(s.calls));
    A.eq(s.calls[0].auth, 'Bearer ' + K, '...with that key');
    A.eq(out.credentialVerified, true, '...and the probe reports on that pair');
    // a probe naming an endpoint but no key (the desktop: the keychain holds it) never sends the station key there
    s = station({ keys: { openrouter: STATION_OR } });
    await s.call('handleProviderProbe', { provider: 'openrouter', baseUrl: NEW });
    A.eq(ends(s.calls), [OR_DEFAULT + '/auth/key'], 'probe: the keychain key is checked at its own endpoint, never the one the body named');
    // the page key handed to the catalog reader WITHOUT the mark (the voice route for a record key): the copy's endpoint
    s = station({ page: PAGE });
    await s.listModelsForProvider('openrouter', { key: K, baseUrl: NEW });
    A.eq(ends(s.calls), [OLD], 'catalog reader: an unmarked page key keeps the copy\'s endpoint');
    // a sign-in's catalog never follows the endpoint a body names
    s = station({});
    await s.call('handleProviderProbe', { provider: 'kimi', key: 'sk-kimi-typed', baseUrl: NEW });
    A.ok(s.calls.length > 0 && s.calls.every(x => x.url.startsWith(KIMI_DEFAULT)), 'probe: a sign-in verifies on its own endpoint: ' + JSON.stringify(s.calls));

    // validate: the candidate is the only key ever sent, and it came in THIS body
    s = station({ page: PAGE });
    out = await s.call('handleProviderValidate', { provider: 'openrouter', key: K, baseUrl: NEW });
    A.eq([out.ok, ends(s.calls), s.calls[0] && s.calls[0].auth], [true, [NEW + '/auth/key'], 'Bearer ' + K], 'DEFECT validate: a candidate equal to the page copy\'s key is proven at the endpoint sent beside it');
    s = station({ page: PAGE });
    out = await s.call('handleProviderValidate', { provider: 'anthropic', key: KA, baseUrl: NEW });
    A.eq([out.ok, s.calls.map(x => [x.key, x.url])], [true, [[KA, NEW + '/models']]], 'DEFECT validate: native Anthropic verification carries only its paired candidate');
    s = station({ keys: { anthropic: STATION_ANT } });
    out = await s.call('handleProviderValidate', { provider: 'anthropic', baseUrl: NEW });
    A.eq([out.ok, s.calls.length], [false, 0], 'validate: no candidate, nothing sent (a station key is never validated against a named endpoint)');
    s = station({});
    out = await s.call('handleProviderValidate', { provider: 'kimi', key: 'sk-kimi-typed', baseUrl: NEW });
    A.eq([out.ok, s.calls.length], [false, 0], 'validate: a sign-in takes no key, so nothing is sent');
  }

  A.report('run-wire.request-key: a key sent in this request rides the endpoint sent beside it, on every path, and nowhere else');
})().catch(e => { A.ok(false, 'run-wire.request-key threw: ' + ((e && e.stack) || e)); A.report('run-wire.request-key'); });
