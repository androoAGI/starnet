/* node test/unreachable-browser-mode.test.js — the STATION DATA UNREACHABLE gate is not a dead end in browser mode.

   showSaveUnreachableGate (frontend/app/app.js) hid RESTART and START COMPLETELY FRESH whenever there was no
   Tauri core, leaving a plain-browser user (`npm start`) nothing but the 5s poll and no hint where the service
   lives. The gate is DOM+timer driven inside the App IIFE (no jsdom here), so this is a SOURCE-LOCK over the
   function body — the house pattern for app.js gates — plus a genuine unit of the browser clear it reuses. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const FreshStart = require('../frontend/app/freshstart.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
const body = A.fnBody(src, 'showSaveUnreachableGate');
A.ok(body.length > 2000, 'showSaveUnreachableGate body located (' + body.length + ' chars)');

/* ---- browser-mode copy: says where the service lives, on the subtitle and on every poll line ---- */
A.ok(body.includes("if you launched with `npm start`, check that terminal; otherwise open the desktop app."), 'browser-mode hint names npm start and the desktop app');
A.ok(/const core = tauriCore\(\);/.test(body) && body.split('const core = tauriCore();').length === 2, 'the Tauri core is resolved exactly once, before the browser-mode branch');
A.ok(/if \(!core\) \{[\s\S]*?setStatus\(BROWSER_HINT\);/.test(body), 'without a shell the initial status line IS the hint');
A.ok(/retrying every 5s \(attempt ' \+ attempts \+ '\)\. Your save is untouched\.' \+ \(core \|\| unreadable \|\| cacheFailed \? '' : ' ' \+ BROWSER_HINT\)/.test(body), 'browser network failures retain the terminal hint; known file/cache failures retain their specific diagnosis');
A.ok(body.includes('SAVE-CACHE · LOCAL RESTORE FAILED'), 'local cache failures have a distinct truthful recovery code');
A.ok(body.includes('SAVE-READ · STATION FILE UNAVAILABLE') && body.includes("const unreadable = r.reason === 'unreadable'"), 'read failures retain a specific recovery code across retries');
A.ok(body.includes("'station service not answering (browser mode)'"), 'subtitle states browser mode');

/* ---- the retry loop and the desktop exits are untouched ---- */
A.ok(/timer = setInterval\(\(\) => \{\s*attempt\(\);/.test(body), 'the 5s retry loop is kept');
A.ok(/if \(core && core\.invoke\) \{ restartBtn\.hidden = false;/.test(body) && /else restartBtn\.hidden = true;/.test(body), 'RESTART STATION SERVICE still shows only with a shell (browser has nothing to restart)');
A.ok(/if \(core && core\.invoke && typeof FreshStart !== 'undefined'\) \{[\s\S]*?FreshStart\.resetDesktop\(core\)/.test(body), 'the desktop START COMPLETELY FRESH path (native quarantine first) is unchanged');

/* ---- the browser-mode exit: scoped to browser state, two clicks, reuses FreshStart.clearBrowserState ---- */
A.ok(/else if \(!core && typeof FreshStart !== 'undefined' && FreshStart\.clearBrowserState\) \{/.test(body), 'browser mode gets its own START FRESH branch, gated on no core + FreshStart present');
const browserBranch = body.slice(body.indexOf('else if (!core && typeof FreshStart'), body.indexOf('} else freshBtn.hidden = true;'));
A.ok(browserBranch.includes("'✦ START FRESH (CLEAR BROWSER STATE)'"), 'the label is honest about scope (browser state, not the desktop quarantine)');
A.ok(/if \(!armed\) \{[\s\S]*?armed = true;[\s\S]*?CONFIRM — CLEAR BROWSER STATE/.test(browserBranch), 'two-click arm/confirm, same shape as the desktop path');
A.ok(/The station service\\'s own save files are not touched\./.test(browserBranch), 'copy promises only what the clear does (truthful telemetry)');
A.ok(/const n = FreshStart\.clearBrowserState\(\);[\s\S]*?location\.reload\(\)/.test(browserBranch), 'confirm clears browser-owned StarNet keys then reloads');
A.ok(/catch \(error\) \{[\s\S]*?setStatus\('nothing was cleared — '/.test(browserBranch), 'a failed clear says nothing was cleared and re-enables the exits');
A.ok(!/resetDesktop|starnet_start_fresh|core\.invoke/.test(browserBranch), 'the browser branch never calls the native shell');

/* ---- genuine unit: the clear this branch reuses removes only StarNet-owned keys ---- */
function storage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return { get length() { return map.size; }, key(i) { return Array.from(map.keys())[i] || null; }, getItem(k) { return map.has(k) ? map.get(k) : null; }, removeItem(k) { map.delete(k); }, snapshot() { return Object.fromEntries(map); } };
}
const store = storage({ 'starnet.dev.pullFault': 'unreachable', 'starnet.textsize': 'huge', 'skynet_arcade_hi': '3', 'host.pref': 'keep' });
A.eq(FreshStart.clearBrowserState(store), 3, 'clears the StarNet namespaces (incl. a stale dev fault flag that would re-open this very gate)');
A.eq(store.snapshot(), { 'host.pref': 'keep' }, 'foreign origin keys survive');

A.report('unreachable-browser-mode');
