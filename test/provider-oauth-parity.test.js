/* node test/provider-oauth-parity.test.js — every device-code OAuth provider the sidecar ships MUST land on
   every frontend provider surface (registry-driven drift lock).

   THE BUG CLASS THIS LOCKS OUT (Andrew's report, 2026-07-20): grok/kimi OAuth shipped end-to-end in the
   sidecar (registry profiles, routes, Settings rows, ModelDock groups) while the genesis brain picker never
   offered them — and harness.js's own normalizeProviderId still folded 'grok' into the API-key 'xai' id
   ('kimi' fell through to 'openrouter'), so even Settings could not actually activate them. The root cause
   was DRIFT: the provider vocabulary lives in several per-file copies with no cross-file check, so a new
   provider can half-land silently.

   This test derives the OAuth provider set FROM THE REGISTRY (the backend source of truth) and asserts each
   surface knows every id. Add a new authType:'oauth_device_code' profile and this test fails on every file
   that hasn't caught up — the failure list IS the checklist. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const registry = require('../sidecar/providers/registry.js');
const OAUTH = registry.listProviderProfiles().filter(p => p.authType === 'oauth_device_code');
const OAUTH_IDS = OAUTH.map(p => p.id);
const EXTRA_IDS = OAUTH_IDS.filter(id => id !== 'codex');   // codex keeps literal paths (its own source-locks)

A.ok(OAUTH_IDS.includes('codex') && OAUTH_IDS.includes('grok') && OAUTH_IDS.includes('kimi'),
  'sanity: the registry ships the known device-OAuth trio (codex/grok/kimi)');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const sidecarSrc = read('sidecar/index.js');
const appSrc = read('frontend/app/app.js');
const harnessSrc = read('frontend/app/harness.js');
const dockSrc = read('frontend/app/modeldock.js');
const keyctaSrc = read('frontend/app/keycta.js');
const stationSrc = read('frontend/app/stationui.js');
const htmlSrc = read('frontend/index.html');

// extract a flat string-array literal (e.g. "const NAME = ['a', 'b']") as a Set
function arrayLiteral(src, name, label) {
  const m = new RegExp(name + "\\s*=\\s*\\[([^\\]]*)\\]").exec(src);
  A.ok(!!m, label + ' still declares ' + name);
  return new Set((m ? m[1] : '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
}
function setEquals(actual, expected, label) {
  const a = [...actual].sort().join(','), e = [...expected].sort().join(',');
  A.ok(a === e, label + ' — expected {' + e + '} got {' + a + '}');
}

/* ---------- sidecar: routes + the generic provider list ---------- */
setEquals(arrayLiteral(sidecarSrc, 'OAUTH_PROVIDER_IDS', 'sidecar/index.js'), new Set(EXTRA_IDS),
  'sidecar OAUTH_PROVIDER_IDS covers exactly the registry\'s non-codex device-OAuth providers');
for (const id of OAUTH_IDS) {
  for (const leg of ['start', 'poll', 'status', 'models', 'logout']) {
    A.ok(sidecarSrc.includes("'/api/auth/" + id + '/' + leg + "'"),
      'sidecar routes /api/auth/' + id + '/' + leg);
  }
}

/* ---------- per-file provider identity: id survives normalize + is keyless ---------- */
// Every frontend normalize copy must return the id for itself, and every providerNeedsKey copy must
// exclude it — the exact two lines whose drift caused the grok→xai activation bug.
const NORMALIZERS = [
  ['frontend/app/app.js', appSrc],
  ['frontend/app/harness.js', harnessSrc],
  ['frontend/app/modeldock.js', dockSrc],
  ['frontend/app/keycta.js', keyctaSrc]
];
for (const [file, src] of NORMALIZERS) {
  for (const id of OAUTH_IDS) {
    A.ok(new RegExp("p === '" + id + "'[^\\n]*return '" + id + "'").test(src),
      file + " normalize keeps '" + id + "' its own provider id");
    if (file !== 'frontend/app/modeldock.js') {
      A.ok(new RegExp("p !== '" + id + "'").test(src),
        file + " providerNeedsKey knows '" + id + "' is keyless (OAuth tokens live sidecar-side)");
    }
  }
  // and the id must never be an alias that normalizes AWAY to another provider (a fold = a line testing the
  // id and returning a DIFFERENT provider id; returning non-provider values, e.g. reasoning-effort defaults
  // like `if (p === 'codex') return 'low'`, is fine)
  const ALL_PROVIDER_IDS = registry.providerIds ? registry.providerIds() : registry.listProviderProfiles().map(x => x.id);
  for (const id of OAUTH_IDS) {
    const others = [...ALL_PROVIDER_IDS].filter(x => x !== id).join('|');
    A.ok(!new RegExp("p === '" + id + "'[^\\n]*return '(" + others + ")'").test(src),
      file + " never folds '" + id + "' into another provider id");
  }
}

/* The quick picker delegates authentication to Harness and no longer owns a key-warning helper.
   Exercise its actual selection handler for every registry OAuth provider, with no browser key API. */
{
  const vm = require('node:vm');
  const Dock = require('../frontend/app/modeldock.js');
  const handler = dockSrc.slice(dockSrc.indexOf('  function applyModel(item)'), dockSrc.indexOf('  function applyEffort(id)'));
  A.ok(handler.includes('function applyModel(item)'), 'quick-picker selection handler is exercised');
  for (const id of OAUTH_IDS) {
    const picked = { id: id + '/catalog-model', provider: id, supportsReasoning: false };
    const state = {};
    const context = {
      provider: () => 'openrouter', normalizeProvider: Dock.labels.normProvider,
      currentEffort: () => 'medium', clampEffortForModel: Dock.efforts.clamp,
      Harness: {
        setProv: value => { state.provider = value; }, setModel: value => { state.model = value; },
        setReasoningEffort: value => { state.effort = value; },
        getKey: () => { throw new Error('OAuth selection must not require a browser key'); }
      },
      opts: { apply: value => { state.applied = value; } },
      reflect() {}, renderList() {}, closeDock: () => { state.closed = true; }
    };
    vm.runInNewContext(handler + '\nthis.choose = applyModel;', context);
    A.notThrows(() => context.choose(picked), 'quick picker accepts ' + id + ' without a browser key');
    A.eq([state.provider, state.model], [id, picked.id], 'quick picker preserves ' + id + ' transport identity');
    A.eq([state.applied?.provider, state.applied?.model, state.applied?.reason], [id, picked.id, 'model'],
      'quick picker persists the ' + id + ' selection');
    A.ok(state.closed, 'quick picker closes after selecting ' + id);
  }
}

/* ---------- genesis picker (the user-visible half of the original report) ----------
   Codex is the DELIBERATE exception since the 2026-08-10 hero swap: ChatGPT sign-in has no chip of its
   own — it lives INSIDE the OPENAI card (two paths, one card). The reachability this test exists to
   guarantee is asserted directly: the OPENAI selection shows the shared sign-in block wired to codex. */
for (const id of EXTRA_IDS) {
  A.ok(new RegExp('data-prov="' + id + '"').test(htmlSrc),
    'genesis picker offers a chip for OAuth provider ' + id);
}
A.ok(!/data-prov="codex"/.test(htmlSrc), 'codex deliberately has no standalone genesis chip (it rides the OPENAI card)');
A.ok(/isOpenAI[\s\S]{0,120}codex-block/.test(appSrc) || /codex-block'\)\.classList\.toggle\('hidden', !\(isOAuth \|\| isOpenAI\)\)/.test(appSrc),
  'the OPENAI selection shows the shared sign-in block (ChatGPT stays reachable at genesis)');
A.ok(/applyOAuthBlockCopy\('codex'\)/.test(appSrc), "the OPENAI card's sign-in half speaks ChatGPT");
{
  // OAUTH_GENESIS is an object literal — extract its top-level keys
  const m = /const OAUTH_GENESIS = Object.freeze\(\{([\s\S]*?)\n  \}\);/.exec(appSrc);
  A.ok(!!m, 'app.js still declares the OAUTH_GENESIS table');
  const keys = new Set([...(m ? m[1] : '').matchAll(/^\s*(\w+):/gm)].map(x => x[1]));
  setEquals(keys, new Set(OAUTH_IDS), 'app.js OAUTH_GENESIS covers exactly the registry\'s device-OAuth providers');
}

/* ---------- Settings PROVIDERS shared path ---------- */
setEquals(arrayLiteral(stationSrc, 'const OAUTH_EXTRA', 'frontend/app/stationui.js'), new Set(EXTRA_IDS),
  'stationui OAUTH_EXTRA covers exactly the registry\'s non-codex device-OAuth providers');

/* ---------- registry aliases must not leak into API-key providers frontend-side ---------- */
for (const p of OAUTH) {
  for (const alias of (p.aliases || [])) {
    // if a frontend normalize mentions the alias at all, it must resolve to the OAuth id
    for (const [file, src] of NORMALIZERS) {
      const line = new RegExp("[^\\n]*'" + alias + "'[^\\n]*").exec(src);
      if (line) A.ok(line[0].includes("return '" + p.id + "'"),
        file + " alias '" + alias + "' resolves to '" + p.id + "' (never another provider)");
    }
  }
}

A.report('provider-oauth-parity.test');
