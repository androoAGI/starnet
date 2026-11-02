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

  // ---- the unreachable screen's status line, through its own handler and the real FreshStart ----
  const fs = require('node:fs');
  const path = require('node:path');
  const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
  const from = app.indexOf("const freshBtn = el('btn-unreachable-fresh');");
  const to = app.indexOf('} else if (!core && typeof FreshStart', from);
  A.ok(from > 0 && to > from, 'fixture: the unreachable screen\'s START COMPLETELY FRESH block is found in app.js');
  const screen = async (native) => {
    const page = { status: '', reloads: 0, later: [], btn: { textContent: '', hidden: true, disabled: false, onclick: null } };
    const body = 'let resetting = false, browserResetBlocked = false, preservedReset = null;' + app.slice(from, to) + '}}';
    const core = { async invoke() { return native; } };
    new Function('el', 'SFX', 'core', 'FreshStart', 'setStatus', 'btn', 'restartBtn', 'setTimeout', 'location', 'localStorage', body)(
      id => id === 'btn-unreachable-fresh' ? page.btn : null, {}, core, FreshStart, t => { page.status = t; }, null, null,
      (fn, ms) => { page.later.push({ fn, ms }); return 1; }, { reload() { page.reloads++; } }, storage({}));
    await page.btn.onclick();   // arms
    await page.btn.onclick();   // confirms
    return page;
  };
  const kept = await screen({ ok: true, listening: true, quarantine: 'safe-copy', browserDataCleared: true });
  A.ok(/account link and purchased credits were kept/.test(kept.status), 'a carried link keeps the promise (' + kept.status + ')');
  A.eq(kept.reloads, 1, 'and the screen reopens at once');
  const left = await screen({ ok: true, listening: true, quarantine: 'safe-copy', browserDataCleared: true, creditsLeftAside: true });
  A.eq(/were kept/.test(left.status), false, 'a link left behind is never promised kept (' + left.status + ')');
  A.ok(/could not be carried over/.test(left.status) && /link your account again/i.test(left.status), 'the status line says it stayed behind and what to do');
  A.ok(/safe-copy/.test(left.status), 'and where the old station is');
  A.eq(left.reloads, 0, 'the reload waits long enough to read it');
  left.later.filter(row => row.ms === 8000).forEach(row => row.fn());
  A.eq(left.reloads, 1, 'then it reopens');
  const stuck = await screen({ ok: true, listening: false, quarantine: 'safe-copy', browserDataCleared: true, creditsLeftAside: true });
  A.ok(/still blocked/.test(stuck.status) && /could not be carried over/.test(stuck.status), 'a clean station that is still blocked says it too');

  A.report('freshstart.test');
})().catch(e => { console.log('FAIL: unhandled — ' + (e && e.stack || e)); process.exit(1); });
