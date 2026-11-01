/* node test/batch-models.test.js — fix lane batch-models-1023: a batch-only model id (OpenRouter's '<id>:batch')
   is never offered for chat, and an id an older build saved runs on its base model.

   THE DEFECT (StarNet Cloud proxy log 2026-10-23, three runs 45 minutes apart): a station sent
   'anthropic/claude-haiku-4.5:batch' to the managed proxy and got 404 "… cannot be used with the chat/completions
   endpoint (adapter AnthropicBatchAdapter)". OpenRouter's /models lists 75 such rows beside their base rows at half
   the price, the managed /v1/models passes them through, and nothing in the app filtered them, so every picker, the
   CLI's model question and the channel /model suggestions offered them, and a saved one failed every run.

   Locked here by executing the REAL code: provider.js's rule, the sidecar's model-list route and catalog snapshots
   (sliced out of index.js into a vm), the run seam's mapping (source lock: runOnceCore is not sliceable), the model
   dock (modeldock.js required against stub globals) and Harness.listModels (sliced out of harness.js). */
'use strict';
const { readSidecarSource, locateSidecarFunction, sidecarSourceFiles, sidecarFunctionSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const provider = require('../sidecar/providers/provider.js');

// A slice of the real 2026-10-23 OpenRouter catalog shape: base rows, their batch rows, a ':free' variant.
const CATALOG = [
  { id: 'anthropic/claude-haiku-4.5', name: 'Anthropic: Claude Haiku 4.5', supported_parameters: ['tools'] },
  { id: 'anthropic/claude-haiku-4.5:batch', name: 'Anthropic: Claude Haiku 4.5 (batch)', supported_parameters: ['tools'] },
  { id: 'openai/gpt-6-sol', name: 'OpenAI: GPT-6 Sol', supported_parameters: ['tools'] },
  { id: 'openai/gpt-6-sol:batch', name: 'OpenAI: GPT-6 Sol (batch)', supported_parameters: ['tools'] },
  { id: 'meta-llama/llama-5-8b:free', name: 'Meta: Llama 5 8B (free)', supported_parameters: ['tools'] }
];
const ids = list => list.map(m => m.id);

/* function a top-level function of index.js, cut at the next top-level `}` line */
function sliceTop(src, marker, label) {
  const start = src.indexOf(marker);
  A.ok(start >= 0, 'index.js still contains ' + label);
  const end = src.indexOf('\n}\n', start);
  A.ok(end > start, label + ' has a locatable end');
  return src.slice(start, end + 3);
}

module.exports = (async () => {
  /* ---------- 1. the rule itself (provider.js) ---------- */
  {
    A.eq(typeof provider.isBatchOnlyModel, 'function', 'provider.js exports isBatchOnlyModel');
    A.eq(typeof provider.chatModelId, 'function', 'provider.js exports chatModelId');
    A.ok(provider.isBatchOnlyModel('openrouter', 'anthropic/claude-haiku-4.5:batch'), 'an OpenRouter :batch row is batch-only');
    A.ok(provider.isBatchOnlyModel('starnet', 'anthropic/claude-haiku-4.5:batch'), 'a managed (StarNet) :batch row is batch-only');
    A.ok(!provider.isBatchOnlyModel('openrouter', 'anthropic/claude-haiku-4.5'), 'the base row is a chat model');
    A.ok(!provider.isBatchOnlyModel('openrouter', 'meta-llama/llama-5-8b:free'), 'a :free variant still runs on chat/completions');
    A.ok(!provider.isBatchOnlyModel('ollama', 'mymodel:batch'), 'an Ollama tag that happens to read :batch is a local model, untouched');
    A.ok(!provider.isBatchOnlyModel('custom', 'x/y:batch'), 'a custom endpoint keeps its own ids');
    A.eq(provider.chatModelId('starnet', 'anthropic/claude-haiku-4.5:batch'), 'anthropic/claude-haiku-4.5', 'a saved managed :batch id runs on its base model');
    A.eq(provider.chatModelId('openrouter', 'openai/gpt-6-sol:batch'), 'openai/gpt-6-sol', 'a saved OpenRouter :batch id runs on its base model');
    A.eq(provider.chatModelId('openrouter', 'openai/gpt-6-sol'), 'openai/gpt-6-sol', 'a chat id passes through unchanged');
    A.eq(provider.chatModelId('ollama', 'mymodel:batch'), 'mymodel:batch', 'another provider\'s id passes through unchanged');
    A.eq(provider.chatModelId('openrouter', ''), '', 'an empty id stays empty');
  }

  /* ---------- 2. the sidecar's model-list route + catalog snapshots (sliced out of index.js) ---------- */
  const index = readSidecarSource();
  /* The provider.js helpers a slice may call are exactly the names index.js IMPORTS (review 2026-10-23): a sandbox
     handed provider.isBatchOnlyModel directly stayed green after the import was dropped, while the real route threw
     a ReferenceError (strict mode) and every picker showed "catalog unavailable". */
  const helpers = {};
  {
    // the import of the module that declares listModelsForProvider (index.js today), not the first such import anywhere
    const home = locateSidecarFunction('listModelsForProvider');
    const homeSrc = home ? sidecarSourceFiles().find(f => f.rel === home.rel).text : '';
    const imp = /const \{([^}]*)\} = require\('\.\/providers\/provider\.js'\)/.exec(homeSrc);
    A.ok(!!imp, 'index.js destructures its provider.js helpers in one require');
    for (const part of (imp ? imp[1].split(',') : [])) {
      const [from, as] = part.split(':').map(s => s.trim());
      if (from && typeof provider[from] === 'function') helpers[as || from] = provider[from];
    }
    A.ok(typeof helpers.isBatchOnlyModel === 'function' && typeof helpers.chatModelId === 'function',
      'index.js imports isBatchOnlyModel and chatModelId from provider.js: ' + Object.keys(helpers).join(', '));
  }
  {
    const region = sliceTop(index, 'async function listModelsForProvider(providerId, opts) {', 'listModelsForProvider');
    const listed = providerId => vm.runInNewContext(region + '\nlistModelsForProvider(' + JSON.stringify(providerId) + ', {});', Object.assign({}, helpers, {
      normalizeProvider: p => String(p || 'openrouter'),
      getProviderProfile: () => ({}),
      providerRuntimeBaseUrl: () => 'https://example.invalid/v1',
      providerRuntimeKey: () => 'k',
      providerRequiresKey: () => false,
      providerRequiresBaseUrl: () => false,
      providerCredentialError: () => 'not configured',
      extraAccountProviderFor: () => null,
      providerUsesCodex: () => false,
      providerUsesDeviceOAuth: () => false,
      selectProvider: () => ({ listModels: async () => CATALOG.map(m => Object.assign({}, m)).concat([{ id: 'mymodel:batch' }]) }),
      ImageTask: require('../sidecar/image-task.js')
    }));
    const managed = await listed('starnet');
    A.ok(!ids(managed).some(id => /:batch$/.test(id)), 'GET /api/models/starnet offers no :batch row: ' + ids(managed).join(', '));
    A.ok(ids(managed).indexOf('anthropic/claude-haiku-4.5') >= 0 && ids(managed).indexOf('meta-llama/llama-5-8b:free') >= 0, 'base rows and :free variants stay offered');
    const routed = await listed('openrouter');
    A.ok(!ids(routed).some(id => /\/.*:batch$/.test(id)), 'GET /api/models/openrouter offers no :batch row (the pickers and the CLI read this route)');
    const local = await listed('ollama');
    A.ok(ids(local).indexOf('mymodel:batch') >= 0, 'a local provider keeps a model tagged :batch');
  }
  {
    const region = sliceTop(index, 'function warmModelCatalog() {', 'warmModelCatalog') +
      sliceTop(index, 'async function warmModelCatalogSet() {', 'warmModelCatalogSet');
    const sandbox = Object.assign({}, helpers, {
      orModelCatalogIds: [], _modelCatalogWarming: false,
      makeOpenRouterProvider: () => ({ listModels: async () => CATALOG.map(m => Object.assign({}, m)) }),
      providerRuntimeBaseUrl: () => '', OPENROUTER_BASE: 'https://openrouter.ai/api/v1'
    });
    vm.runInNewContext('var orModelCatalogIds = [], _modelCatalogWarming = false;\n' + region + '\nthis.warmModelCatalog = warmModelCatalog; this.warmModelCatalogSet = warmModelCatalogSet; this.snap = () => orModelCatalogIds;', sandbox);
    await sandbox.warmModelCatalog();
    const snap = sandbox.snap();
    A.ok(snap.length > 0 && !snap.some(id => /:batch$/.test(id)), 'the channel /model catalog (validation + "did you mean") holds no :batch id: ' + snap.join(', '));
    const set = await sandbox.warmModelCatalogSet();
    A.ok(set && set.has('openai/gpt-6-sol') && !set.has('openai/gpt-6-sol:batch'), 'the fallback-chain validation catalog holds no :batch id, so saving one warns');
  }

  /* ---------- 3. the run seam: a saved :batch id runs on its base model (runOnceCore is too big to slice whole) ---------- */
  {
    const core = index.indexOf('async function runOnceCore(o) {');
    A.ok(core >= 0, 'index.js still defines runOnceCore');
    const at = index.indexOf("let model = String((o && o.model) || '').trim() || (rosterIdent && rosterIdent.model", core);
    A.ok(at > core, 'runOnceCore still resolves its model in one place');
    const mapAt = index.indexOf('\n  model = chatModelId(providerId, model);', at);
    A.ok(mapAt > at && mapAt - at < 1600, 'runOnceCore maps a batch-only id to its base model right after resolving it');
    // the first thing that names the model to the page is the run's agent.run.start: searched over the WHOLE body
    const firstStart = index.indexOf("emit('agent.run.start'", core);
    A.ok(firstStart > mapAt, 'the mapping happens before runOnceCore\'s first agent.run.start names the model (start at ' + firstStart + ', map at ' + mapAt + ')');
    A.ok(index.slice(core, mapAt).indexOf('emit(') < 0, 'no event leaves runOnceCore before the model is mapped');

    // the fallback chains, EXECUTED: the statements cut out of runOnceCore and run against each chain source
    const fbStart = index.indexOf('  const fallbackModels = (Array.isArray(o.fallbackModels) ? o.fallbackModels : effectiveFallbackChain())', core);
    const fbEnd = index.indexOf("? fallbackModels.splice(0).map(m => ({ provider: 'openrouter', model: m })) : [];", fbStart);
    A.ok(fbStart > core && fbEnd > fbStart && fbEnd - fbStart < 1200, 'the run still builds its fallback chain in one place');
    const chainSrc = index.slice(fbStart, fbEnd + "? fallbackModels.splice(0).map(m => ({ provider: 'openrouter', model: m })) : [];".length);
    const chain = (providerId, o, saved, env) => vm.runInNewContext(
      chainSrc + '\n({ fallbackModels, savedProviderFallbacks });',
      Object.assign({}, helpers, { providerId, o, fallbackSaved: saved, effectiveFallbackChain: () => (saved != null ? saved : env) }));
    let r = chain('anthropic', {}, ['anthropic/claude-haiku-4.5:batch'], []);
    A.eq(JSON.stringify(r.savedProviderFallbacks), JSON.stringify([{ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }]),
      'a non-OpenRouter station\'s SAVED chain (OpenRouter routes) runs its :batch id on the base model');
    r = chain('starnet', {}, ['openai/gpt-6-sol:batch', 'openai/gpt-6-sol'], []);
    A.eq(JSON.stringify(r.fallbackModels), JSON.stringify(['openai/gpt-6-sol', 'openai/gpt-6-sol']), 'a managed station\'s saved chain maps too');
    r = chain('starnet', { fallbackModels: ['anthropic/claude-haiku-4.5:batch'] }, null, []);
    A.eq(JSON.stringify(r.fallbackModels), JSON.stringify(['anthropic/claude-haiku-4.5']), 'a per-run chain on a managed run maps by the run\'s provider');
    r = chain('ollama', { fallbackModels: ['mymodel:batch'] }, null, []);
    A.eq(JSON.stringify(r.fallbackModels), JSON.stringify(['mymodel:batch']), 'a per-run chain on a local provider keeps its own tags');
    r = chain('ollama', {}, null, ['mymodel:batch']);
    A.eq(JSON.stringify(r.fallbackModels), JSON.stringify(['mymodel:batch']), 'an env default chain on a local provider keeps its own tags');

    // a provider fallback (the voice route's agent route, a /api/run fallbackProviders entry) runs its base model too
    const pfStart = index.indexOf('    const fbProviderId = normalizeProvider(fb.provider || providerId);', core);
    const pfEnd = index.indexOf('\n', index.indexOf('    const fbModel = ', pfStart));
    A.ok(pfStart > core && pfEnd > pfStart && pfEnd - pfStart < 400, 'the provider-fallback loop still resolves each entry\'s model in one place');
    const pf = (fb, providerId) => vm.runInNewContext(index.slice(pfStart, pfEnd) + '\n({ fbProviderId, fbModel });',
      Object.assign({}, helpers, { fb, providerId, normalizeProvider: p => String(p || '').toLowerCase() }));
    A.eq(pf({ provider: 'starnet', model: 'anthropic/claude-haiku-4.5:batch' }, 'openrouter').fbModel, 'anthropic/claude-haiku-4.5', 'a provider fallback\'s :batch id runs on its base model');
    A.eq(pf({ provider: 'ollama', model: 'mymodel:batch' }, 'openrouter').fbModel, 'mymodel:batch', 'a local provider fallback keeps its tag');
  }

  /* ---------- 3b. the one-shot paths that read the roster without runOnceCore (review 2026-10-23), EXECUTED ----------
     Telegram agent-bot setup (probeChannelRunConfig), NOT RIGHT? / SET IT UP FOR ME (stationOneShot), skill evaluation
     and restored verdict reviews (sampleRunConfigFor) all resolve the model through channelRunConfigFor or, with no
     roster, devHubSecrets, then hand it straight to provider.stream. A fake adapter answers ':batch' with the real 404. */
  {
    const sent = [];
    const fakeProvider = {
      priceOf: () => null,
      async *stream(req) {
        sent.push(req.model);
        if (/:batch$/.test(req.model)) { const e = new Error('404 ' + req.model + ' cannot be used with the chat/completions endpoint (adapter AnthropicBatchAdapter).'); e.code = 'model_not_found'; throw e; }
        yield { type: 'text', delta: 'OK' }; yield { type: 'done' };
      }
    };
    const roster = new Map();
    const env = {};
    const region = ['function stationDefaultFor(id, ident) {', 'function channelRunConfigFor(agentId, candidate) {',
      'async function probeChannelRunConfig(config, timeoutMs) {', 'function devHubSecrets() {', 'function sampleRunConfigFor(agentId) {',
      'function providerForRunConfig(c, reasoningEffort) {', 'async function stationOneShot(prompt, tag, failLead) {']
      .map(m => sliceTop(index, m, m.replace(/\(.*$/, ''))).join('\n')
      + '\n' + sidecarFunctionSource('ENV');   // devHubSecrets reads its default model through the real ENV() (STARNET_ first)
    const sb = Object.assign({}, helpers, {
      agentRoster: roster, process: { env }, AbortController, setTimeout, clearTimeout, crypto: require('crypto'),
      normalizeProvider: p => String(p || 'openrouter').toLowerCase(),
      providerRuntimeKey: () => 'k', providerRuntimeBaseUrl: () => '', providerHasCredential: () => true,
      providerCredentialError: () => 'not configured', resolveReasoningEffort: (p, v) => v || 'medium',
      extraAccountProviderFor: () => null, providerUsesCodex: () => false, providerUsesDeviceOAuth: () => false,
      selectProvider: () => fakeProvider, redact: s => s,
      budget: { check: () => null }, stationOneShots: new Set(), makeCostEngine: () => ({ reconcile: () => ({ usd: 0 }) }),
      ledger: { record() {} }, getProviderProfile: () => ({}), failNote() {}
    });
    vm.runInNewContext(region + '\nthis.api = { channelRunConfigFor, probeChannelRunConfig, sampleRunConfigFor, stationOneShot };', sb);
    const api = sb.api;
    roster.set('agent', { provider: 'starnet', model: 'anthropic/claude-haiku-4.5:batch', name: 'Overseer' });
    roster.set('cypher', { provider: 'openrouter', model: 'openai/gpt-6-sol:batch', name: 'Cypher' });
    roster.set('scout', { provider: 'openrouter', model: '', name: 'Scout' });   // unpinned: follows the station default
    roster.set('local', { provider: 'ollama', model: 'mymodel:batch', name: 'Local' });

    A.eq(api.channelRunConfigFor('cypher').model, 'openai/gpt-6-sol', 'a pinned agent\'s :batch roster model resolves to its base model');
    A.eq(api.channelRunConfigFor('scout').model, 'anthropic/claude-haiku-4.5', 'an unpinned agent following a :batch station default resolves to the base model');
    A.eq(api.channelRunConfigFor('local').model, 'mymodel:batch', 'a local model tagged :batch is untouched');

    const probe = await api.probeChannelRunConfig(api.channelRunConfigFor('cypher'), 5000);
    A.ok(probe.ok === true && probe.model === 'openai/gpt-6-sol', 'Telegram agent-bot setup proves the base model instead of refusing setup: ' + JSON.stringify(probe));
    A.eq(sent[sent.length - 1], 'openai/gpt-6-sol', 'the setup probe sends the base id to chat/completions');

    const one = await api.stationOneShot({ system: 's', user: 'u' }, 'notright', 'the fix suggestion failed');
    A.ok(one.ok === true && one.model === 'anthropic/claude-haiku-4.5', 'NOT RIGHT? / SET IT UP FOR ME run on the base station model, never a 502: ' + JSON.stringify(one));
    A.eq(sent[sent.length - 1], 'anthropic/claude-haiku-4.5', 'the station one-shot sends the base id');
    A.eq(api.sampleRunConfigFor('agent').model, 'anthropic/claude-haiku-4.5', 'skill evaluation and restored verdict reviews read the base model (sampleRunConfigFor)');

    // a headless host with no roster falls back to the environment default
    roster.clear();
    env.SKYNET_DEFAULT_MODEL = 'anthropic/claude-haiku-4.5:batch';
    A.eq(api.sampleRunConfigFor('agent').model, 'anthropic/claude-haiku-4.5', 'a headless host\'s :batch env default model resolves to its base model');
    A.ok(!sent.some(m => /:batch$/.test(m)), 'no one-shot ever sent a :batch id: ' + sent.join(', '));
  }

  /* ---------- 3c. LIVE DOCTOR probes the model a run really uses; the voice route resolves like runOnceCore ---------- */
  {
    const ld = index.indexOf('async function handleLiveDoctor(req, res) {');
    A.ok(ld >= 0, 'index.js still defines handleLiveDoctor');
    const s = index.indexOf('  const providerId = normalizeProvider((rec && rec.provider)', ld);
    const e = index.indexOf('\n', index.indexOf('  const model = ', s));
    A.ok(s > ld && e > s && e - s < 600, 'LIVE DOCTOR resolves its selected model in one place');
    const doctor = rec => vm.runInNewContext(index.slice(s, e) + '\n({ providerId, model });',
      Object.assign({}, helpers, { rec, runtimeKey: 'k', codexTokens: null, normalizeProvider: p => String(p || '').toLowerCase() }));
    A.eq(doctor({ provider: 'starnet', model: 'anthropic/claude-haiku-4.5:batch' }).model, 'anthropic/claude-haiku-4.5', 'LIVE DOCTOR probes the base model a real run uses, never reports the :batch id as failing');
    A.eq(doctor({ provider: 'ollama', model: 'mymodel:batch' }).model, 'mymodel:batch', 'LIVE DOCTOR keeps a local tag');
    const body = index.slice(ld, ld + 4000);
    A.ok(/provider\.stream\(\{ model, messages: \[\{ role: 'user', content: 'Reply exactly OK\.' \}\]/.test(body), 'the doctor\'s probe streams that same resolved model');

    const region = sliceTop(index, 'async function applyVoiceTurnRoute(o) {', 'applyVoiceTurnRoute');
    const voiceRoster = new Map([['agent', { provider: 'starnet', model: 'anthropic/claude-haiku-4.5:batch' }]]);
    const voice = (setting) => vm.runInNewContext(region + '\napplyVoiceTurnRoute({ agentId: "agent", messages: [] });', Object.assign({}, helpers, {
      effectiveVoiceChat: () => require('../sidecar/voice-chat-route.js').cleanSetting(setting), agentRoster: voiceRoster,
      normalizeProvider: p => String(p || 'openrouter').toLowerCase(), providerUsesCodex: () => false, CODEX_DEFAULT_MODEL: 'gpt-x', CRON_DEFAULT_MODEL: 'cron-x',
      providerRuntimeKey: () => 'k', providerRuntimeBaseUrl: () => '', getProviderProfile: () => ({}), providerHasCredential: () => true,
      voiceCatalogEntry: async () => null, makeContext: () => ({ estimateMessages: () => 0, estimateTokens: () => 0 }), RUN_CONTEXT_DEFAULTS: {},
      voiceChatRoute: require('../sidecar/voice-chat-route.js'), console: { warn() {}, log() {} },
      promptTierCeiling: require('../sidecar/providers/prices.js').promptTierCeiling   // the price-tier window cap applyVoiceTurnRoute reads (context-cost lane)
    }));
    const swapped = await voice({ provider: 'openrouter', model: 'openai/gpt-6-sol' });
    A.eq(swapped.fallbackProviders && swapped.fallbackProviders[0] && swapped.fallbackProviders[0].model, 'anthropic/claude-haiku-4.5',
      'a voice turn\'s agent-route fallback names the base model, not the :batch id that would 404');
    const same = await voice({ provider: 'starnet', model: 'anthropic/claude-haiku-4.5' });
    A.ok(!same.voiceRoute.used && same.voiceRoute.model === 'anthropic/claude-haiku-4.5', 'a voice model equal to the agent\'s base model stays on the agent route: ' + JSON.stringify(same.voiceRoute));
  }

  /* ---------- 4. the model dock (modeldock.js, executed) ---------- */
  const dockPath = path.join(root, 'frontend', 'app', 'modeldock.js');
  function loadDock(opts) {
    let prov = opts.provider || 'starnet', model = opts.model || '', revision = 0;
    const el = id => ({ id, hidden: true, textContent: '', innerHTML: '', style: {}, dataset: {}, isConnected: true,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, getAttribute: () => null,
      removeAttribute() {}, addEventListener() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [], focus() {}, contains: () => false });
    const els = { 'model-dock': el('model-dock'), 'model-dock-toggle': el('model-dock-toggle') };
    const old = { document: global.document, localStorage: global.localStorage, Harness: global.Harness, U: global.U };
    global.document = { getElementById: id => els[id] || null, querySelector: () => null, addEventListener() {}, createElement: () => el(''), createDocumentFragment: () => ({ appendChild() {} }) };
    global.localStorage = { getItem: () => '1', setItem() {} };
    global.U = { esc: s => String(s) };
    global.Harness = {
      getSelectionRevision: () => revision,
      getProv: () => prov, setProv: v => { revision++; prov = v; },
      getModel: () => model, setModel: v => { revision++; model = v; },
      getReasoningEffort: () => 'medium', setReasoningEffort() {}, normalizeReasoningEffort: v => String(v || 'medium'),
      configured: p => p === prov, getKey: () => '', getBaseUrl: () => '', listModels: async () => [],
      apiFetch: async url => url === '/api/models/' + prov
        ? new Response(JSON.stringify({ provider: prov, models: opts.catalog }), { status: 200 })
        : new Response(JSON.stringify({ models: [], error: 'not configured', connected: false }), { status: 200 })
    };
    delete require.cache[require.resolve(dockPath)];
    const dock = require(dockPath);
    return { dock, state: () => ({ provider: prov, model }), restore: () => { delete require.cache[require.resolve(dockPath)]; Object.assign(global, old); } };
  }
  {
    const t = loadDock({ catalog: CATALOG });
    try {
      const keep = t.dock._internals.isAgentModel;
      A.ok(!keep({ id: 'anthropic/claude-haiku-4.5:batch', provider: 'starnet' }), 'the dock never offers a managed :batch row');
      A.ok(!keep({ id: 'openai/gpt-6-sol:batch', provider: 'openrouter' }), 'the dock never offers an OpenRouter :batch row');
      A.ok(keep({ id: 'anthropic/claude-haiku-4.5', provider: 'starnet' }) && keep({ id: 'meta-llama/llama-5-8b:free', provider: 'openrouter' }), 'base rows and :free variants stay offered');
      A.ok(keep({ id: 'mymodel:batch', provider: 'ollama' }), 'a local model tagged :batch stays offered');
      const eqv = t.dock._internals.catalogEquivalent;
      const offered = CATALOG.filter(m => keep(Object.assign({ provider: 'starnet' }, m)));
      A.eq(eqv('anthropic/claude-haiku-4.5:batch', 'starnet', offered), 'anthropic/claude-haiku-4.5', 'a saved :batch id maps to its base row when the catalog lists it');
      A.eq(eqv('anthropic/claude-haiku-9:batch', 'starnet', offered), '', 'never a base the catalog lacks');
      A.eq(eqv('mymodel:batch', 'ollama', [{ id: 'mymodel' }]), '', 'a local tag is never rewritten');
    } finally { t.restore(); }
  }
  {
    // A 0.13.x station whose dock model is the batch row: the confirmed catalog moves it to the base row (persisted
    // as a catalog_reconcile), never clears it to "no model".
    const t = loadDock({ model: 'anthropic/claude-haiku-4.5:batch', catalog: CATALOG });
    const applied = [];
    try {
      t.dock.init({ apply: c => applied.push(c), identity: () => 'agent' });
      for (let i = 0; i < 100 && !applied.length; i++) await sleep(5);
      A.eq(t.state().model, 'anthropic/claude-haiku-4.5', 'the saved :batch dock model becomes its base model');
      A.eq(applied[0] && applied[0].reason, 'catalog_reconcile', 'it is a reconcile with the old id named, never catalog_unavailable');
      A.eq(applied[0] && applied[0].previousModel, 'anthropic/claude-haiku-4.5:batch', 'the reconcile names the id it replaced');
    } finally { t.restore(); }
  }

  /* ---------- 5. Harness.listModels (sliced out of harness.js, like ctx-model-catalog.test.js) ---------- */
  {
    const source = read('frontend', 'app', 'harness.js');
    const fnRegion = (label, marker) => {
      const start = source.indexOf(marker);
      A.ok(start >= 0, 'harness.js still contains ' + label);
      const end = source.indexOf('\n  }\n', start);
      return source.slice(start, end + 4);
    };
    const stateStart = source.indexOf('  let totals = { tokens: 0, cost: 0, calls: 0 };');
    const stateEnd = ['  /* CONTEXT OCCUPANCY IS PER CONVERSATION', '  // Per-agent context-window occupancy'].map(a => source.indexOf(a)).find(i => i >= 0);
    A.ok(stateStart >= 0 && stateEnd > stateStart, 'the harness catalog state region can be isolated');
    const region = fnRegion('normalizeProviderId', '  function normalizeProviderId(provider) {') + source.slice(stateStart, stateEnd) +
      fnRegion('listModels', '  async function listModels(provider) {');
    let direct = false;
    const sandbox = {
      console: { warn() {}, log() {} }, OR: 'https://openrouter.ai/api/v1', getProv: () => 'openrouter', getBaseUrl: () => '',
      fetchModelCatalog: async url => {
        if (url.indexOf('/api/models/') === 0) { if (direct) throw new Error('station unreachable'); return CATALOG.map(m => Object.assign({}, m)); }
        return CATALOG.map(m => Object.assign({}, m));   // the direct OpenRouter fallback: the raw upstream list
      }
    };
    const api = vm.runInNewContext(region + '\n({ listModels });', sandbox);
    A.ok(!ids(await api.listModels('starnet')).some(id => /:batch$/.test(id)), 'Harness.listModels(starnet) offers no :batch row');
    direct = true;
    const raw = ids(await api.listModels('openrouter'));
    A.ok(raw.length > 0 && !raw.some(id => /:batch$/.test(id)), 'the direct OpenRouter fallback (sidecar unreachable) offers no :batch row either: ' + raw.join(', '));
  }
  A.report('batch-models.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
