/* node test/freshstart.test.js — unreachable-screen reset ordering and browser-state scope. */
'use strict';
const A = require('./_assert.js');
const FreshStart = require('../frontend/app/freshstart.js');

function storage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] || null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    removeItem(k) { map.delete(k); },
    snapshot() { return Object.fromEntries(map); }
  };
}

(async () => {
  const store = storage({
    'starnet.save': 'station',
    'starnet.dev.pullFault': 'unreachable',
    'skynet.save': 'legacy',
    'starnet_arcade_hi': '9',
    'skynet_arcade_scores': '[]',
    'unrelated.host.preference': 'keep'
  });
  let sawCacheBeforeNative = false;
  const result = await FreshStart.resetDesktop({
    async invoke(command) {
      A.eq(command, 'starnet_start_fresh', 'uses the native path that works without sidecar HTTP');
      sawCacheBeforeNative = store.getItem('starnet.save') === 'station';
      return { ok: true, listening: true, quarantine: 'safe-copy' };
    }
  }, store);
  A.eq(sawCacheBeforeNative, true, 'durable quarantine succeeds before browser cache is cleared');
  A.eq(result.listening, true, 'native listening truth is returned to the gate');
  A.eq(result.browserDataCleared, true, 'the renderer proves its fallback browser clear');
  A.eq(result.browserKeysCleared, 5, 'dot and legacy underscore StarNet namespaces are cleared');
  A.eq(store.snapshot(), { 'unrelated.host.preference': 'keep' }, 'unrelated origin state is untouched');

  const refused = storage({ 'starnet.save': 'last-readable-copy' });
  let error = '';
  try {
    await FreshStart.resetDesktop({ async invoke() { throw new Error('workspace still owned'); } }, refused);
  } catch (e) { error = String(e && e.message || e); }
  A.ok(error.includes('workspace still owned'), 'native refusal reaches the user');
  A.eq(refused.getItem('starnet.save'), 'last-readable-copy', 'failed preservation never clears the browser fallback');

  const blocked = {
    get length() { return 1; },
    key() { return 'starnet.save'; },
    removeItem() { throw new Error('storage locked'); }
  };
  const incomplete = await FreshStart.resetDesktop({
    async invoke() { return { ok: true, listening: true, quarantine: 'safe-copy', browserDataCleared: false }; }
  }, blocked);
  A.eq(incomplete.browserDataCleared, false, 'native and renderer clear failure is reported instead of claiming a fresh station');
  A.ok(incomplete.browserClearError.includes('storage locked'), 'the truthful browser-clear failure reaches the gate');

  let unlocked = false, present = true;
  const transient = {
    get length() { return present ? 1 : 0; },
    key() { return present ? 'starnet.save' : null; },
    removeItem() { if (!unlocked) throw new Error('storage locked'); present = false; }
  };
  let nativeResets = 0;
  const firstTry = await FreshStart.resetDesktop({
    async invoke() { nativeResets++; return { ok: true, listening: true, quarantine: 'original-station', browserDataCleared: false }; }
  }, transient);
  A.eq(firstTry.browserDataCleared, false, 'precondition: the first browser clear is blocked after preservation');
  unlocked = true;
  const retried = FreshStart.retryBrowserClear(firstTry, transient);
  A.eq(retried.browserDataCleared, true, 'a later browser-only retry can finish the reset');
  A.eq(retried.quarantine, 'original-station', 'the retry keeps the exact original-station preservation receipt');
  A.eq(nativeResets, 1, 'browser-clear retry never quarantines the clean generation a second time');

  const nativeProof = await FreshStart.resetDesktop({
    async invoke() { return { ok: true, listening: true, quarantine: 'safe-copy', browserDataCleared: true }; }
  }, blocked);
  A.eq(nativeProof.browserDataCleared, true, 'native WebView clearing is authoritative when renderer storage is unavailable');

  A.report('freshstart.test');
})().catch(e => { console.log('FAIL: unhandled — ' + (e && e.stack || e)); process.exit(1); });
