/* node test/browser-held-profile.test.js — the station browser when ANOTHER process holds its durable profile.
   Customer report 2026-10-08 (Windows 10, v0.13.1): the station browser never started — every Chromium we spawned
   handed off to whatever held the profile and exited ("spawned Chromium exited before CDP ownership was
   established"), the orphan sweep found nothing it could end, and the raw CDP text reached the BROWSER window.
   Now: ONE relaunch on a fresh temporary profile that says plainly saved sign-ins are not available, and if that
   fails too, an error that names the repair. Hermetic: fake spawn/fetch/WebSocket, an injected profileHeld. */
'use strict';
const A = require('./_assert.js');
const os = require('os'), path = require('path'), fs = require('fs');
const { makeBrowserTools, _internals: T } = require('../sidecar/tools/builtin/browser.js');

function fakeWsClass() {
  return class FakeWs {
    constructor() { this.ls = {}; setTimeout(() => this.emit('open'), 5); }
    addEventListener(ev, fn) { (this.ls[ev] = this.ls[ev] || []).push(fn); }
    emit(ev, arg) { (this.ls[ev] || []).slice().forEach(fn => fn(arg)); }
    send(raw) {
      const m = JSON.parse(raw);
      let result = {};
      if (m.method === 'Runtime.evaluate') result = { result: { type: 'object', value: { url: 'about:blank', title: '' } } };
      if (m.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'F1' } } };
      if (m.method === 'Browser.getVersion') result = { product: 'Chrome/149.0.0.0', userAgent: 'Mozilla/5.0 Chrome/149.0.0.0' };
      setTimeout(() => this.emit('message', { data: JSON.stringify({ id: m.id, result }) }), 1);
    }
    close() { this.emit('close'); }
  };
}

/* A rig: a Chromium launched on a dir `exits(dir)` says is held hands off and exits at once; any other starts. */
function rig(persistentDir, o) {
  const launches = [];
  let current = null;
  const spawn = (bin, args) => {
    const dir = String(args.find(a => a.indexOf('--user-data-dir=') === 0) || '').slice('--user-data-dir='.length);
    const closers = [];
    const proc = { pid: 999999, on: (ev, fn) => { if (ev === 'close') closers.push(fn); }, kill: () => closers.splice(0).forEach(fn => fn()) };
    const exits = o.exits(dir);
    launches.push(dir);
    current = { dir, exits };
    if (exits) setTimeout(() => closers.splice(0).forEach(fn => fn()), 5);
    return proc;
  };
  const fetchImpl = async url => {
    if (!current || current.exits) throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => (/json\/version/.test(url) ? {} : [{ type: 'page', webSocketDebuggerUrl: 'ws://fake/page' }]) };
  };
  const driver = T.makeCdpDriver({ spawn, fetchImpl, WebSocketImpl: fakeWsClass(), chrome: 'fake-chrome', profileDir: persistentDir,
    profileIsPersistent: true, cleanupProfile: false, profileHeld: o.profileHeld, cdpPort: 9556,
    adoptPopups: false, syntheticInputOnly: false, networkProxy: false, timeoutMs: 400, lookup: null });
  return { driver, launches };
}

(async () => {
  const tmpRoot = path.join(os.tmpdir(), 'starnet-browser-');

  // 1. HELD → one temporary-profile launch, and it says so truthfully
  {
    const station = fs.mkdtempSync(path.join(os.tmpdir(), 'held-station-'));
    fs.writeFileSync(path.join(station, 'Cookies'), 'signed-in');
    const r = rig(station, { exits: dir => dir === station, profileHeld: () => ({ held: true, how: 'lockfile in use' }) });
    let err = null;
    try { await r.driver.tabs(); } catch (e) { err = e; }
    A.ok(!err, 'the browser started despite the held profile: ' + (err && err.message));
    A.eq(r.launches.filter(d => d === station).length, 3, 'the persistent profile was tried its usual three times');
    A.eq(r.launches.length, 4, 'then exactly ONE more launch');
    const temp = r.launches[3];
    A.ok(temp !== station && temp.indexOf(tmpRoot) === 0, 'on a fresh temporary profile: ' + temp);
    A.eq(r.driver.usingPersistentProfile(), false, 'the driver no longer claims the signed-in station profile');
    const note = r.driver.profileFallback();
    A.ok(/Saved sign-ins are not available this session/.test(note || ''), 'its note says saved sign-ins are unavailable: ' + note);
    A.ok(/another process is holding the station browser profile/.test(note || ''), 'and why');
    await r.driver.tabs();
    A.eq(r.launches.length, 4, 'a later call reuses the fallback browser');
    await r.driver.close();
    A.ok(!fs.existsSync(temp), 'closing removes the temporary profile');
    A.ok(fs.existsSync(path.join(station, 'Cookies')), 'the durable station profile is never deleted');
    try { fs.rmSync(station, { recursive: true, force: true }); } catch (_) {}
  }

  // 2. HELD and the temporary launch fails too → the concrete repair, no loop
  {
    const station = fs.mkdtempSync(path.join(os.tmpdir(), 'held-station-'));
    const r = rig(station, { exits: () => true, profileHeld: () => ({ held: true, how: 'lockfile in use' }) });
    let err = null;
    try { await r.driver.tabs(); } catch (e) { err = e; }
    A.ok(err, 'the launch fails');
    A.eq(err && err.code, 'BROWSER_PROFILE_HELD', 'with the held-profile code');
    const msg = String(err && err.message);
    A.ok(/another process is holding the station browser's profile/.test(msg), 'naming the cause: ' + msg);
    A.ok(/SETTINGS › BROWSER › RESET STATION BROWSER/.test(msg) && /started as administrator can't be closed by StarNet/.test(msg), 'and the repair');
    A.ok(!/CDP ownership/.test(msg), 'never the raw CDP hand-off text');
    A.eq(r.launches.length, 4, 'three persistent tries + ONE temporary try');
    let err2 = null;
    try { await r.driver.tabs(); } catch (e) { err2 = e; }
    A.eq(err2 && err2.code, 'BROWSER_PROFILE_HELD', 'a later call gets the same answer');
    A.eq(r.launches.length, 4, 'without launching again (bounded, no relaunch loop)');
    A.ok(fs.existsSync(station), 'the durable profile is still there');
    await r.driver.close();
    A.ok(!fs.existsSync(r.launches[3]), 'the failed temporary profile is cleaned up on close');
    try { fs.rmSync(station, { recursive: true, force: true }); } catch (_) {}
  }

  // 3. NOT held (a crash, a bad binary): no fallback, the original error stands
  {
    const station = fs.mkdtempSync(path.join(os.tmpdir(), 'held-station-'));
    const r = rig(station, { exits: () => true, profileHeld: () => ({ held: false, how: 'no lockfile' }) });
    let err = null;
    try { await r.driver.tabs(); } catch (e) { err = e; }
    A.ok(err && /exited before CDP ownership/.test(err.message), 'an unheld failure keeps its real error');
    A.eq(r.launches.length, 3, 'and no temporary-profile launch');
    A.eq(r.driver.profileFallback(), null, 'no fallback note');
    try { fs.rmSync(station, { recursive: true, force: true }); } catch (_) {}
  }

  // 4. THE SESSION tells the truth: a held-profile fallback remembers nothing, even with the station lease held
  {
    const NOTE = 'Saved sign-ins are not available this session: another process is holding the station browser profile, so this browser started on a temporary profile.';
    for (const fellBack of [true, false]) {
      const drv = { alive: () => true, streamStart() {}, streamStop() {}, humanInput() {}, pageInfo() {}, visible: () => true,
        usingPersistentProfile: () => !fellBack, profileFallback: () => (fellBack ? NOTE : null), close: async () => {} };
      const B = makeBrowserTools({ makeDriver: () => drv, persistentProfile: { dir: '/station-profile', acquire: () => true, release() {} } });
      B.session.visible();   // starts the (fake) driver on the leased station profile
      const s = B.session.handoffSurface();
      A.eq(s.remembered, !fellBack, fellBack ? 'a fallback browser is NOT remembered, though the lease is held' : 'the station profile is remembered');
      A.eq(s.profileNote, fellBack ? NOTE : '', 'the surface carries the note');
      A.eq(B.session.profileNote(), fellBack ? NOTE : '', 'session.profileNote() says the same');
    }
  }

  A.report('browser-held-profile.test');
})().catch(e => { console.log('FAIL: browser-held-profile.test threw - ' + (e && e.stack || e)); process.exit(1); });
