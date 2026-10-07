/* node test/datareset.test.js — #65 ERASE EVERYTHING + #61 RESET STATION BROWSER (frontend/app/datareset.js) and the
   desktop wiring they depend on. The erase itself is native (src-tauri/src/erase_all.rs, cargo-tested); this proves the
   page side: the typed+armed confirmation reaches the native command, the window cannot write the OLD station into
   the fresh one while it erases, and every line the UI shows is backed by the shell's receipt. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const DR = require('../frontend/app/datareset.js');

function fakeWindow() {
  const writes = [], beacons = [], fetches = [];
  function Storage() {}
  Storage.prototype.setItem = function (k, v) { writes.push([k, v]); };
  const w = {
    Storage,
    navigator: { sendBeacon: (u, b) => { beacons.push(u); return true; } },
    fetch: async (u, o) => { fetches.push([String(u), (o && o.method) || 'GET']); return { status: 200, json: async () => ({ ok: true }) }; },
    __STARNET_API__: ''
  };
  return { w, writes, beacons, fetches, store: new Storage() };
}

(async () => {
  /* ---- the freeze: the old in-memory station cannot write into the fresh one ---- */
  {
    const f = fakeWindow();
    const lift = DR.freezeWrites(f.w);
    f.store.setItem('skynet.world', '{"old":true}');
    A.eq(f.writes.length, 0, 'localStorage writes are dropped while erasing');
    f.w.navigator.sendBeacon('/api/save', 'old world');
    A.eq(f.beacons.length, 0, 'the unload save beacon is dropped');
    let refused = false;
    try { await f.w.fetch('/api/save', { method: 'POST' }); } catch (e) { refused = /frozen/.test(e.message); }
    A.ok(refused, 'a station API write is refused');
    let refusedAbs = false;
    try { await f.w.fetch('http://127.0.0.1:8787/api/agents', { method: 'POST' }); } catch (e) { refusedAbs = true; }
    A.ok(refusedAbs, 'the rewritten absolute sidecar URL is refused too');
    await f.w.fetch('http://ipc.localhost/starnet_erase_everything', { method: 'POST' });
    A.eq(f.fetches.length, 1, 'non-API traffic (the desktop IPC) still flows');
    A.eq(f.w.__STARNET_ERASING__, true, 'the page is marked as erasing');
    lift();
    f.store.setItem('k', 'v');
    A.eq(f.writes.length, 1, 'lifting the freeze restores storage writes');
    await f.w.fetch('/api/x');
    A.eq(f.fetches.length, 2, 'and API fetches');
  }

  /* ---- eraseDesktop: orphan sweep first, then the native command with the typed word, writes frozen meanwhile ---- */
  {
    const f = fakeWindow();
    const calls = [];
    const core = {
      invoke: async (cmd, args) => {
        calls.push([cmd, args]);
        f.store.setItem('skynet.world', 'old');   // what an unload hook would try mid-erase
        return { ok: true, listening: true, removed: ['/a/ai.skynet.harness/.erasing-station-1'], failed: [], keychainCleared: 41, keychainFailed: [], autostartDisabled: true, browserDataCleared: true };
      }
    };
    const v = await DR.eraseDesktop({ core, win: f.w });
    A.eq(f.fetches[0], ['/api/browser/reset', 'POST'], 'the station browser is reset (orphans ended) before the erase');
    A.eq(calls, [['starnet_erase_everything', { confirm: 'ERASE' }]], 'the native erase is invoked with the typed confirmation word');
    A.eq(f.writes.length, 0, 'no storage write landed during the erase');
    A.ok(v.browserDataCleared === true, 'receipt passed through');
    const s = DR.eraseSummary(v);
    A.ok(s.complete && s.reloadSafe, 'a complete receipt is complete and safe to reload');
    A.ok(/Deleted 1 StarNet data location/.test(s.lines.join(' ')) && /Removed StarNet's saved keys/.test(s.lines.join(' ')), 'summary: ' + s.lines.join(' '));
  }
  {
    // refused before any deletion: the window must work again (freeze lifted) and the error is shown verbatim
    const f = fakeWindow();
    const core = { invoke: async () => { throw new Error('nothing was erased - another StarNet process still owns this station'); } };
    let err = null;
    try { await DR.eraseDesktop({ core, win: f.w }); } catch (e) { err = e; }
    A.ok(err && /^nothing was erased/.test(err.message), 'a refused erase surfaces the shell\'s own words');
    f.store.setItem('k', 'v');
    A.eq(f.writes.length, 1, 'and the freeze is lifted so the station keeps saving');
  }
  {
    // the native WebView clear failed: StarNet's own keys are cleared through the fallback before any reload
    const f = fakeWindow();
    let fallback = 0;
    const core = { invoke: async () => ({ ok: true, listening: true, removed: [], failed: [], keychainFailed: [], browserDataCleared: false }) };
    const v = await DR.eraseDesktop({ core, win: f.w, freshStart: { clearBrowserState: () => { fallback++; return 3; } } });
    A.eq(fallback, 1, 'the namespaced localStorage fallback ran');
    A.ok(v.browserDataCleared === true && v.browserDataClearedBy === 'fallback', 'and the receipt says which layer cleared it');
    const f2 = fakeWindow();
    const v2 = await DR.eraseDesktop({ core, win: f2.w, freshStart: { clearBrowserState: () => { throw new Error('storage blocked'); } } });
    const s2 = DR.eraseSummary(v2);
    A.ok(!s2.reloadSafe, 'when no layer cleared the window, a reload is NOT offered (it would replay the old station)');
    A.ok(/Could NOT clear this window's stored data \(storage blocked\)/.test(s2.lines.join(' ')), 'and the UI says so: ' + s2.lines.join(' '));
  }

  /* ---- the summary never claims more than the receipt ---- */
  {
    const s = DR.eraseSummary({ ok: false, listening: true, browserDataCleared: true, autostartDisabled: false,
      removed: ['a'], failed: [{ path: 'C:/Users/a/AppData/Roaming/ai.skynet.harness/update-snapshots', error: 'Access is denied.' }],
      keychainFailed: ['credits:device: locked'] });
    const t = s.lines.join(' ');
    A.ok(!s.complete && s.reloadSafe, 'partial: not complete, but the fresh station can open');
    A.ok(/Could NOT delete 1: C:\/Users\/a\/AppData\/Roaming\/ai\.skynet\.harness\/update-snapshots \(Access is denied\.\)/.test(t), 'the leftover path and the OS reason are named');
    A.ok(/Could NOT remove 1 saved credential/.test(t) && !/Removed StarNet's saved keys/.test(t), 'a keychain failure is never reported as removed');
    A.ok(/Launch at login could not be turned off/.test(t), 'autostart failure named');
    const dead = DR.eraseSummary({ ok: true, listening: false, browserDataCleared: true, removed: [], failed: [], keychainFailed: [] });
    A.ok(!dead.reloadSafe && /did not start answering/.test(dead.lines.join(' ')), 'a fresh station that is not answering is said plainly');
  }

  /* ---- RESET STATION BROWSER copy follows the sweep receipt ---- */
  {
    const t = DR.browserResetSummary(200, { ok: true, closed: true, sweep: { ok: true, found: 3, killed: [300, 301, 302], survivors: [], ours: [], locks: { removed: ['lockfile'], failed: [] } } });
    A.ok(/Ended 3 of 3 leftover StarNet browser processes/.test(t) && /Cleared its stale profile lock/.test(t) && /sign-ins were kept/.test(t), t);
    const t2 = DR.browserResetSummary(409, { ok: false, closed: true, sweep: { ok: false, found: 1, killed: [], survivors: [300], ours: [], locks: { removed: [], failed: [] } } });
    A.ok(/could not be ended \(pid 300\)/.test(t2) && !/sign-ins were kept/.test(t2), 'a survivor is never a success: ' + t2);
    A.ok(/Stop that run/.test(DR.browserResetSummary(409, { ok: false, driving: { runId: 'r' } })), 'refused while an agent drives');
    A.ok(/No leftover StarNet browser was running/.test(DR.browserResetSummary(200, { ok: true, closed: false, sweep: { ok: true, found: 0, killed: [], survivors: [], ours: [], locks: { removed: [], failed: [] } } })), 'clean case');
  }

  /* ---- wiring contract (static): what the page depends on exists, and the native erase is guarded ---- */
  {
    const root = path.join(__dirname, '..');
    const main = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');
    const erase = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'erase_all.rs'), 'utf8');
    const ui = fs.readFileSync(path.join(root, 'frontend', 'app', 'stationui.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
    A.ok(/fn starnet_erase_everything\(/.test(main) && /generate_handler!\[[\s\S]*starnet_erase_everything/.test(main), 'the native erase command exists and is registered');
    A.ok(/confirm\.trim\(\) != "ERASE"/.test(main), 'the native side re-checks the typed word (the page is not the only gate)');
    A.ok(/set_aside_for_erase[\s\S]{0,1600}nothing was erased/.test(main), 'a failed set-aside deletes nothing and says so');
    A.ok(/stop_sidecar_gracefully\(st\)[\s\S]{0,400}set_aside_for_erase/.test(main), 'the sidecar (and its station browser) stops before any file moves');
    A.ok(main.includes('erase_all::remove_all(&targets)') && main.includes('window.clear_all_browsing_data()'), 'deletion + WebView storage clear are both wired');
    A.ok(/!path\.starts_with\(&install_root\)/.test(main), 'the install folder (and its bundled seed) is never an erase target');
    A.ok(/fn is_starnet_owned/.test(erase) && /refused: not a StarNet-owned location/.test(erase), 'every target passes the StarNet-ownership guard');
    A.ok(/DataReset\.mountErase\(el\)/.test(ui) && /DataReset\.mountBrowserReset\(el\)/.test(ui), 'both doors are mounted in Settings');
    A.ok(html.includes('<script src="app/datareset.js"></script>'), 'the module loads');
    A.ok(html.indexOf('app/armconfirm.js') < html.indexOf('app/datareset.js'), 'after the shared arm/confirm helper');
  }

  A.report('datareset.test');
})().catch(e => { console.log('FAIL: datareset.test threw - ' + (e && e.stack || e)); process.exit(1); });
