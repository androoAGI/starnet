/* node test/ctx-model-catalog.test.js — regression guard for the CONTEXT-GAUGE CATALOG WIPE (fix 1fa14b35).

   THE DEFECT. Harness kept ONE shared `modelMap` for every provider. ModelDock warms ~17 providers in
   parallel (modeldock.js fetchModels) and every listModels(p) reset that one map, so whichever provider
   resolved LAST — usually an unconfigured one handing back an EMPTY list — wiped the ACTIVE provider's
   catalog. contextLimitOf()/priceOf() then returned 0 for the live model, CtxGauge computed known:false,
   and the bottom-bar CTX gauge sat at '—' with ten hollow cells forever. The occupancy reading itself was
   correct the whole time (a real turn measured 10903 prompt tokens against limit 0), which is exactly why
   this survived: nothing looked broken except the one number a user reads.

   WHY THIS IS BEHAVIOURAL AND NOT A SOURCE LOCK. The bug is a write-ordering race between two providers,
   so a grep for `modelsByProv` would pass on any code that merely names it. This test runs the REAL
   listModels / contextLimitOf / priceOf / catalogModel bodies sliced out of harness.js in a vm sandbox
   (the idiom from dossier-reliability.test.js / agent-config-target.test.js — harness.js is browser-flow
   and not node-loadable as a whole) and replays the actual 17-provider warm. The slice is anchored on
   names that exist in BOTH the fixed and the pre-fix source, so reverting the fix makes this fail on a
   VALUE (0 instead of 200000) rather than on a missing symbol. Verified: red against 1fa14b35^1. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'frontend', 'app', 'harness.js');
const source = fs.readFileSync(SRC, 'utf8');

/* ---------- slice the real bodies out of harness.js ---------- */

// a function that lives directly inside the Harness IIFE closes at a 2-space `}` on its own line
function fnRegion(label, startMarker) {
  const start = source.indexOf(startMarker);
  A.ok(start >= 0, 'harness.js still contains ' + label);
  const end = source.indexOf('\n  }\n', start);
  A.ok(end > start, label + ' has a locatable end');
  return source.slice(start, end + '\n  }\n'.length);
}

// the catalog STATE declaration — `let modelMap = {}` before the fix, `modelsByProv` + catalogModel after.
// Anchored on two markers present in both versions so the revert fails on behaviour, not on a slice miss.
// The CLOSING anchor is whichever comment opens the context-occupancy state that follows the catalog
// state. That comment was rewritten when occupancy moved from per-agent to per-conversation keying
// (2026-08-03), so both spellings are accepted: the newer one first, the pre-2026-08-03 one as fallback,
// which keeps this test red against 1fa14b35^1 exactly as it was verified to be.
const stateStart = source.indexOf('  let totals = { tokens: 0, cost: 0, calls: 0 };');
const OCCUPANCY_ANCHORS = ['  /* CONTEXT OCCUPANCY IS PER CONVERSATION', '  // Per-agent context-window occupancy'];
const stateEnd = OCCUPANCY_ANCHORS.map(a => source.indexOf(a)).find(i => i >= 0);
A.ok(stateStart >= 0 && stateEnd > stateStart, 'the catalog state region can be isolated from harness.js');
const stateRegion = source.slice(stateStart, stateEnd);

const region =
  fnRegion('normalizeProviderId', '  function normalizeProviderId(provider) {') +
  stateRegion +
  fnRegion('priceOf', '  function priceOf(id) {') +
  fnRegion('contextLimitOf', '  function contextLimitOf(id) {') +
  fnRegion('listModels', '  async function listModels(provider) {');

/* ---------- run it for real, with the ambient browser bits stubbed ---------- */

let activeProv = 'openrouter';          // what getProv() would read out of localStorage
let catalogFor = () => [];              // what the sidecar hands back for a given provider

const sandbox = {
  console: { warn() {}, log() {} },
  OR: 'https://openrouter.ai/api/v1',
  getProv: () => activeProv,
  getBaseUrl: () => '',
  fetchModelCatalog: async (url) => {
    // /api/models/<provider> — pull the provider back out the way the real call encodes it
    const m = /\/api\/models\/([^?]+)/.exec(url);
    return catalogFor(m ? decodeURIComponent(m[1]) : 'openrouter');
  },
};

const api = vm.runInNewContext(
  region + '\n({ listModels, contextLimitOf, priceOf });',
  sandbox,
  { filename: 'harness.js#catalog' }
);

/* ---------- fixtures ---------- */

const OPUS = {
  id: 'claude-opus-5',
  name: 'Claude Opus 5',
  context_length: 200000,
  pricing: { prompt: '0.000015', completion: '0.000075' },
};
// the same id served by OpenRouter, with a DIFFERENT window and price — a real situation (direct slug
// vs an openrouter-prefixed catalog entry), and the reason the resolver must prefer the ACTIVE provider
const OPUS_VIA_OR = {
  id: 'claude-opus-5',
  name: 'Claude Opus 5 (OpenRouter)',
  context_length: 100000,
  pricing: { prompt: '0.00003', completion: '0.00015' },
};

// every provider ModelDock warms; only anthropic is configured here
const ALL_PROVIDERS = ['openrouter', 'openai', 'anthropic', 'gemini', 'codex', 'grok', 'kimi', 'xai',
  'groq', 'mistral', 'deepseek', 'together', 'cerebras', 'qwencloud', 'fireworks', 'perplexity', 'ollama', 'custom'];

(async () => {
  /* 1. the ACTIVE provider's catalog warms and is readable */
  activeProv = 'anthropic';
  catalogFor = (p) => (p === 'anthropic' ? [OPUS] : []);
  await api.listModels('anthropic');
  A.eq(api.contextLimitOf('claude-opus-5'), 200000, 'the active provider\'s context window is known after its own warm');
  A.ok(api.priceOf('claude-opus-5') !== null, 'the active provider\'s pricing is known after its own warm');

  /* 2. ⛔ THE DEFECT: one unconfigured provider warming AFTER it must not wipe that catalog.
        Pre-fix this single line dropped the window to 0 and the gauge went to '—' forever. */
  await api.listModels('openai');                       // resolves to an EMPTY list
  A.eq(api.contextLimitOf('claude-opus-5'), 200000,
    'an unconfigured provider\'s EMPTY warm does not wipe the active provider\'s catalog');
  A.ok(api.priceOf('claude-opus-5') !== null,
    'pricing survives an unconfigured provider\'s empty warm');

  /* 3. the real ModelDock shape: all ~17 warmed in PARALLEL, anthropic resolving FIRST so that
        every one of the other 16 lands after it. This is the ordering that actually shipped. */
  await Promise.all(ALL_PROVIDERS.map(p => api.listModels(p)));
  A.eq(api.contextLimitOf('claude-opus-5'), 200000,
    'the window survives a full 17-provider parallel warm where 16 hand back nothing');
  const price = api.priceOf('claude-opus-5');
  A.ok(price && price.in > 0, 'per-million input price survives the full parallel warm');

  /* 4. the gauge can therefore compute a KNOWN occupancy — the user-visible point of the fix */
  const used = 10903;                                    // the real measurement from the bug report
  const limit = api.contextLimitOf('claude-opus-5');
  A.ok(limit > 0, 'a measured turn has a non-zero limit to divide by (known:false is what broke)');
  A.eq(Math.round((used / limit) * 100), 5, '10903 tokens against a 200k window reads as 5%, not "—"');

  /* 5. the SAME id under two providers resolves to the ACTIVE one's window, not whichever was warmed
        last — otherwise the gauge would quietly measure against the wrong window */
  catalogFor = (p) => (p === 'anthropic' ? [OPUS] : p === 'openrouter' ? [OPUS_VIA_OR] : []);
  await api.listModels('anthropic');
  await api.listModels('openrouter');
  activeProv = 'anthropic';
  A.eq(api.contextLimitOf('claude-opus-5'), 200000, 'with anthropic active, the anthropic window wins');
  activeProv = 'openrouter';
  A.eq(api.contextLimitOf('claude-opus-5'), 100000, 'with openrouter active, the openrouter window wins');

  /* 6. a genuinely unknown id is still unknown — the fix must not invent a window.
        An errored/absent catalog reading 0 is honest here; only a WIPED known one was the bug. */
  activeProv = 'anthropic';
  A.eq(api.contextLimitOf('no-such-model'), 0, 'an unknown model has no window, and none is invented');
  A.eq(api.priceOf('no-such-model'), null, 'an unknown model has no price, and none is invented');

  /* 7. an alias must not open a second catalog that shadows the canonical one: normalizeProviderId
        folds 'claude' onto 'anthropic', so warming under the alias is the SAME bucket */
  catalogFor = (p) => (p === 'anthropic' ? [OPUS] : []);
  await api.listModels('claude');
  activeProv = 'anthropic';
  A.eq(api.contextLimitOf('claude-opus-5'), 200000, 'a provider ALIAS warms the canonical bucket, not a shadow one');

  /* 8. the web build ships the same panel — a fix in one copy is a fix half the users never get */
  const web = fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'app', 'harness.js'), 'utf8');
  A.eq(web.indexOf('let modelsByProv') >= 0, true, 'the website mirror carries the per-provider catalog too');
  A.eq(/function catalogModel/.test(web), true, 'the website mirror carries the catalogModel resolver too');

  A.report('ctx-model-catalog');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
