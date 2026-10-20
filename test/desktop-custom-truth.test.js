/* node test/desktop-custom-truth.test.js — the desktop CUSTOM connection tells the truth (GitHub #111).

   Executes the REAL harness.js hasStoredCredential and setBaseUrl in a sandbox:
     · desktop: getKey is '' by design (the key lives in the OS keychain), so a CUSTOM key the keychain reports is a
       stored credential, and a keyless CUSTOM endpoint still is not one
     · browser: unchanged — a CUSTOM row with no key in this browser is never a stored credential
     · desktop: a rejected endpoint store no longer vanishes; it resolves { engine: { ok:false, error } } (the shape
       SETTINGS and onboarding already warn on) and never rejects; a successful store passes its own answer through */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const harness = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'harness.js'), 'utf8');
const slice = (from, to) => {
  const a = harness.indexOf(from), b = harness.indexOf(to, a + 1);
  A.ok(a >= 0 && b > a, 'harness.js still has ' + from.trim().slice(0, 48));
  return harness.slice(a, b);
};
const helpers = slice('  function normalizeProviderId(provider) {', '  function providerNeedsKey(provider) {');
const credential = slice('  function hasStoredCredential(provider) {', '  // getKey() returns the real key in the browser');
const baseUrl = slice('  function desktopEndpointFailed(p, e) {', '  function defaultReasoningEffortForProvider(provider) {');

function sandbox(opts) {
  const store = new Map(Object.entries(opts.storage || {}));
  const invokes = [], warns = [];
  const scope = {
    JSON, Promise, Set, Array, String, Number, Math, Object,
    DESKTOP: !!opts.desktop, DEVMODE: false, DEV: null, DEV_HOST_KEY: false, selectionRevision: 0,
    LS: { key: 'starnet.byok.key', baseUrl: 'starnet.byok.baseUrl', prov: 'starnet.byok.prov' },
    _configured: false, _configuredByProvider: Object.assign({}, opts.configured || {}),
    getProv: () => 'openrouter',
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => { store.delete(k); } },
    getKey: p => opts.desktop ? '' : (store.get('starnet.byok.key.' + p) || ''),
    syncEngineKey: () => Promise.resolve({ ok: true }),
    invoke: (cmd, args) => { invokes.push({ cmd, args }); return opts.invoke ? opts.invoke(cmd, args) : Promise.resolve(true); },
    console: { warn: m => warns.push(String(m)), log() {} }
  };
  const api = vm.runInNewContext(helpers + credential + baseUrl + '\n({ hasStoredCredential, setBaseUrl })', scope);
  return { api, store, invokes, warns };
}

(async () => {
  // desktop CUSTOM key: the keychain map is the truth
  A.eq(sandbox({ desktop: true, configured: { custom: true } }).api.hasStoredCredential('custom'), true,
    'desktop: a CUSTOM key the OS keychain reports is a stored credential');
  A.eq(sandbox({ desktop: true, configured: { custom: false } }).api.hasStoredCredential('custom'), false,
    'desktop: a keyless CUSTOM endpoint is still not a credential');
  A.eq(sandbox({ desktop: true, configured: {} }).api.hasStoredCredential('custom'), false,
    'desktop: an unknown CUSTOM keychain state is not a credential');
  // browser: unchanged
  A.eq(sandbox({ desktop: false, storage: { 'starnet.byok.baseUrl.custom': 'http://localhost:1234/v1' } }).api.hasStoredCredential('custom'), false,
    'browser: a keyless CUSTOM endpoint is not a credential');
  A.eq(sandbox({ desktop: false, storage: { 'starnet.byok.key.custom': 'sk-local' } }).api.hasStoredCredential('custom'), true,
    'browser: a CUSTOM key saved in this browser is a credential');
  A.eq(sandbox({ desktop: true, configured: { ollama: true } }).api.hasStoredCredential('ollama'), false,
    'an Ollama endpoint is never a credential');

  // desktop endpoint store failure surfaces instead of vanishing
  {
    const s = sandbox({ desktop: true, invoke: () => Promise.reject(new Error('keychain locked')) });
    let rejected = false, res = null;
    try { res = await s.api.setBaseUrl('http://localhost:1234/v1', 'custom'); } catch (_) { rejected = true; }
    A.eq(rejected, false, 'a failed desktop endpoint store never rejects');
    A.ok(res && res.engine && res.engine.ok === false && /could not apply it to the station/.test(res.engine.error),
      'a failed desktop endpoint store resolves the failure in the { engine } shape SETTINGS warns on');
    A.eq(s.store.get('starnet.byok.baseUrl.custom'), 'http://localhost:1234/v1', 'the endpoint stays saved in this window');
    A.eq(s.invokes.length, 1, 'the desktop store was attempted once');
    A.eq([s.invokes[0].cmd, s.invokes[0].args.provider, s.invokes[0].args.baseUrl], ['harness_store_provider_key', 'custom', 'http://localhost:1234/v1'],
      'the desktop store carries the provider and its endpoint');
    A.ok(s.warns.some(w => /desktop endpoint store failed: keychain locked/.test(w)), 'the failure is logged, never swallowed');
  }
  {
    const answer = { ok: true };
    const s = sandbox({ desktop: true, invoke: () => Promise.resolve(answer) });
    A.eq(await s.api.setBaseUrl('http://localhost:1234/v1', 'custom'), answer, 'a successful desktop store passes its own answer through');
    A.eq(s.warns.length, 0, 'a successful store warns nothing');
  }
  A.report('desktop-custom-truth.test');
})().catch(e => { console.error(e); process.exit(1); });
