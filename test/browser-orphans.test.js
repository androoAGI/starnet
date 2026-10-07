/* node test/browser-orphans.test.js — #61: the station browser recovers from an orphaned Chromium whose network proxy
   died with an earlier sidecar, and a navigation that never loaded is no longer reported as an "unsafe redirect".
   Hermetic: a fake process table, fake kill, fake profile files and fake CDP sockets. Nothing real is listed or
   killed (every real effect in browser-orphans.js is injected here). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const O = require('../sidecar/tools/builtin/browser-orphans.js');
const { makeBrowserTools, _internals: T } = require('../sidecar/tools/builtin/browser.js');

const PROFILE_WIN = 'C:\\Users\\Ann Lee\\AppData\\Roaming\\ai.skynet.harness\\workspaces\\.browser-profile';
const CHROME = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';
const SELF = 100;

// A process table shaped like the one the 0.12.5 report described: OUR live station browser, an ORPHAN on the same
// profile whose parent sidecar is gone, the Commander's own Chrome, a look-alike profile path, and a bare Chrome.
function table() {
  return [
    { pid: SELF, ppid: 1, cmd: 'node.exe sidecar/index.js' },
    { pid: 200, ppid: SELF, cmd: CHROME + ' --remote-debugging-port=61001 "--user-data-dir=' + PROFILE_WIN + '" --proxy-server=http://127.0.0.1:61002 about:blank' },
    { pid: 201, ppid: 200, cmd: CHROME + ' --type=renderer "--user-data-dir=' + PROFILE_WIN + '" --lang=en-US' },
    { pid: 300, ppid: 999, cmd: CHROME + ' --remote-debugging-port=61898 "--user-data-dir=' + PROFILE_WIN + '" --proxy-server=http://127.0.0.1:61899 --headless=new about:blank' },
    { pid: 301, ppid: 300, cmd: CHROME + ' --type=gpu-process "--user-data-dir=' + PROFILE_WIN + '"' },
    { pid: 302, ppid: 300, cmd: CHROME + ' --type=crashpad-handler "--user-data-dir=' + PROFILE_WIN.toUpperCase() + '"' },
    { pid: 400, ppid: 50, cmd: CHROME + ' "--user-data-dir=C:\\Users\\Ann Lee\\AppData\\Local\\Google\\Chrome\\User Data"' },
    { pid: 500, ppid: 51, cmd: CHROME + ' "--user-data-dir=' + PROFILE_WIN + '-old"' },
    { pid: 600, ppid: 52, cmd: CHROME + ' --no-first-run' }
  ];
}

function fakeFs(files) {
  const present = new Set(files);
  return {
    present,
    lstatSync(f) { if (!present.has(path.basename(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return {}; },
    unlinkSync(f) { if (!present.delete(path.basename(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } }
  };
}

(async () => {
  /* ---- identity: the --user-data-dir on the command line, parsed for every shape the OS reports ---- */
  A.eq(O.profileArg(table()[1].cmd), PROFILE_WIN, 'Windows: the whole argument quoted by Node spawn (path with a space)');
  A.eq(O.profileArg('chrome --user-data-dir="C:\\a b\\p" --x'), 'C:\\a b\\p', 'a quoted VALUE');
  A.eq(O.profileArg('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/a/Library/Application Support/ai.skynet.harness/workspaces/.browser-profile --proxy-server=http://127.0.0.1:1 about:blank'),
    '/Users/a/Library/Application Support/ai.skynet.harness/workspaces/.browser-profile', 'macOS ps output: unquoted path WITH spaces stops at the next flag');
  A.eq(O.profileArg('chromium --user-data-dir=/tmp/p about:blank'), '/tmp/p', 'a trailing start URL is not part of the path');
  A.eq(O.profileArg('chrome --no-first-run'), null, 'no profile flag: no identity');
  A.ok(O.sameDir(PROFILE_WIN + '\\', PROFILE_WIN.toLowerCase(), 'win32'), 'Windows compare ignores case and a trailing separator');
  A.ok(!O.sameDir(PROFILE_WIN + '-old', PROFILE_WIN, 'win32'), 'a look-alike profile path is NOT the station profile (no prefix match)');

  /* ---- classify: ours vs orphans; the Commander's own Chrome never appears at all ---- */
  const c = O.classify(table(), PROFILE_WIN, { selfPid: SELF, platform: 'win32' });
  A.eq(c.ours.map(p => p.pid), [200, 201], 'the browser THIS sidecar launched (and its helper) is ours');
  A.eq(c.orphans.map(p => p.pid).sort(), [300, 301, 302], 'the browser whose parent sidecar is gone (and its helpers) are the orphans');
  A.ok(!c.procs.some(p => [400, 500, 600].includes(p.pid)), "the Commander's Chrome, a look-alike profile and a bare Chrome never match");
  A.eq(c.orphans.filter(p => p.browser).map(p => p.pid), [300], 'only pid 300 is a browser root (helpers carry --type=)');

  /* ---- sweep: end ONLY the orphans, confirm by re-listing, leave our live browser and the locks alone ---- */
  {
    let rows = table();
    const killed = [];
    const kill = async pid => { killed.push(pid); rows = rows.filter(r => r.pid !== pid && r.ppid !== pid); };
    const ffs = fakeFs(['lockfile', 'DevToolsActivePort']);
    const r = await O.sweep({ profileDir: PROFILE_WIN, platform: 'win32', selfPid: SELF, listProcesses: async () => rows, kill, sleep: async () => {}, fs: ffs });
    A.eq(killed[0], 300, 'the orphan browser ROOT is ended first');
    A.ok(!killed.some(p => [SELF, 200, 201, 400, 500, 600].includes(p)), 'nothing of ours and nothing of the Commander is ever killed');
    A.ok(r.ok && r.found === 3 && r.survivors.length === 0, 'receipt: 3 orphan processes found, none survive');
    A.eq(r.ours, [200, 201], 'receipt names our own live browser');
    A.eq(r.locks.removed, [], 'locks are NOT cleared while our own browser still runs on the profile');
    A.ok(ffs.present.has('lockfile'), 'lockfile left in place');
  }
  {
    // the 0.12.5 shape exactly: ONLY an orphan holds the profile (the sidecar that started it is gone)
    let rows = table().filter(r => r.pid !== 200 && r.pid !== 201);
    const kill = async pid => { rows = rows.filter(r => r.pid !== pid && r.ppid !== pid); };
    const ffs = fakeFs(['lockfile', 'DevToolsActivePort', 'SingletonLock']);
    const r = await O.sweep({ profileDir: PROFILE_WIN, platform: 'win32', selfPid: SELF, listProcesses: async () => rows, kill, sleep: async () => {}, fs: ffs });
    A.ok(r.ok, 'orphan ended');
    A.eq(r.locks.removed.sort(), ['DevToolsActivePort', 'SingletonLock', 'lockfile'], 'with nothing left on the profile its stale locks (and the dead DevTools port file) are cleared');
    A.ok(/ended 3 of 3 orphaned station-browser processes/.test(O.describeSweep(r)), 'receipt text says what happened: ' + O.describeSweep(r));
  }
  {
    // a kill that does not take: the survivor is REPORTED, never assumed gone, and the locks are not touched
    const rows = table();
    const ffs = fakeFs(['lockfile']);
    const r = await O.sweep({ profileDir: PROFILE_WIN, platform: 'win32', selfPid: SELF, listProcesses: async () => rows, kill: async () => {}, sleep: async () => {}, fs: ffs, confirmAttempts: 2 });
    A.ok(!r.ok, 'a surviving orphan makes the receipt NOT ok');
    A.eq(r.survivors.sort(), [300, 301, 302], 'survivors listed by pid');
    A.eq(r.killed, [], 'nothing is claimed as killed');
    A.ok(/still running/.test(O.describeSweep(r)), 'the text says it is still running');
  }
  {
    // the process listing fails (CIM denied / timed out): kill NOTHING and say so
    let killedAny = false;
    const r = await O.sweep({ profileDir: PROFILE_WIN, platform: 'win32', selfPid: SELF, listProcesses: async () => { throw new Error('timeout'); }, kill: async () => { killedAny = true; }, sleep: async () => {} });
    A.ok(!r.ok && !killedAny && /could not list processes/.test(r.error), 'a failed listing kills nothing and reports the failure');
    A.ok(/nothing was ended/.test(O.describeSweep(r)), 'and the text is honest about it');
  }

  /* ---- profileHeld: cheap lock checks that decide whether a launch needs the sweep at all ---- */
  {
    const busy = { lstatSync() { return {}; }, unlinkSync() { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } };
    A.ok(O.profileHeld('X', { platform: 'win32', fs: busy }).held, 'Windows: a lockfile that cannot be deleted means the profile is held');
    const free = fakeFs(['lockfile']);
    A.ok(!O.profileHeld('X', { platform: 'win32', fs: free }).held && !free.present.has('lockfile'), 'Windows: a deletable lockfile is stale and is removed');
    A.ok(!O.profileHeld('X', { platform: 'win32', fs: fakeFs([]) }).held, 'Windows: no lockfile, not held');
    A.ok(O.profileHeld('/p', { platform: 'darwin', readlink: () => 'mac-4242', hostname: 'mac', alive: () => true }).held, 'macOS: SingletonLock owner alive on this host = held');
    A.ok(!O.profileHeld('/p', { platform: 'darwin', readlink: () => 'mac-4242', hostname: 'mac', alive: () => { throw new Error('ESRCH'); } }).held, 'macOS: owner gone = not held');
    A.ok(!O.profileHeld('/p', { platform: 'linux', readlink: () => 'otherbox-1', hostname: 'mac', alive: () => true }).held, "another host's lock is not ours to judge");
  }

  /* ---- the launch path: a held persistent profile is healed BEFORE Chromium is spawned ---- */
  function fakeLaunchRig(extra) {
    const order = [];
    class OkWS {
      constructor() { this.h = {}; setTimeout(() => this.fire('open', {}), 0); }
      addEventListener(n, f) { (this.h[n] = this.h[n] || []).push(f); }
      fire(n, v) { for (const f of this.h[n] || []) f(v); }
      send(raw) {
        const m = JSON.parse(raw);
        const result = m.method === 'Runtime.evaluate' ? { result: { value: 'https://example.com/' } } : {};
        setTimeout(() => this.fire('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
      }
      close() {}
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-orphan-launch-'));
    const d = T.makeCdpDriver(Object.assign({
      chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: false, timeoutMs: 400, cdpPort: 9371,
      profileDir: dir, profileIsPersistent: true,
      fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://ok' }] }),
      WebSocketImpl: OkWS,
      spawn: () => { order.push('spawn'); let onClose = null; return { pid: 7, on(ev, fn) { if (ev === 'close') onClose = fn; }, kill() { if (onClose) queueMicrotask(() => onClose(0)); } }; }
    }, extra(order, dir)));
    return { d, order, dir };
  }
  {
    const { d, order, dir } = fakeLaunchRig(order => ({
      profileHeld: () => ({ held: true, how: 'lockfile in use' }),
      orphanSweep: async o => { order.push('sweep:' + path.basename(o.profileDir)); return { ok: true, found: 1, killed: [300], survivors: [], ours: [], locks: { removed: ['lockfile'], failed: [] }, error: null }; }
    }));
    await d.navigate('https://example.com/');
    A.eq(order, ['sweep:' + path.basename(dir), 'spawn'], 'a held station profile is swept for orphans BEFORE the new browser is spawned');
    A.ok(d.lastOrphanSweep() && d.lastOrphanSweep().killed[0] === 300, 'the driver keeps the sweep receipt');
    await d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const { d, order, dir } = fakeLaunchRig(order => ({
      profileHeld: () => ({ held: false, how: 'no lockfile' }),
      orphanSweep: async () => { order.push('sweep'); return { ok: true }; }
    }));
    await d.navigate('https://example.com/');
    A.eq(order, ['spawn'], 'a free profile launches with no process listing at all (no cost on the normal path)');
    await d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const { d, order, dir } = fakeLaunchRig(order => ({
      profileIsPersistent: false,
      profileHeld: () => ({ held: true }),
      orphanSweep: async () => { order.push('sweep'); return { ok: true }; }
    }));
    await d.navigate('https://example.com/');
    A.eq(order, ['spawn'], 'a per-run temporary profile is never swept (it cannot be an earlier process\'s)');
    await d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ---- a navigation that never loaded is a LOAD FAILURE, not an "unsafe redirect" (the Etsy report) ---- */
  {
    const keepAlive = setInterval(() => {}, 50);
    class ProxyDownWS {
      constructor() { this.h = {}; setTimeout(() => this.fire('open', {}), 0); }
      addEventListener(n, f) { (this.h[n] = this.h[n] || []).push(f); }
      fire(n, v) { for (const f of this.h[n] || []) f(v); }
      send(raw) {
        const m = JSON.parse(raw);
        let result = {};
        if (m.method === 'Page.navigate') result = { frameId: 'F', loaderId: 'L', errorText: 'net::ERR_PROXY_CONNECTION_FAILED' };
        if (m.method === 'Runtime.evaluate') result = { result: { value: 'about:blank' } };   // the tab never left about:blank
        setTimeout(() => this.fire('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
      }
      close() {}
    }
    const d = T.makeCdpDriver({
      chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: false, timeoutMs: 400, cdpPort: 9372,
      fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://down' }] }),
      WebSocketImpl: ProxyDownWS,
      spawn: () => { let onClose = null; return { pid: 8, on(ev, fn) { if (ev === 'close') onClose = fn; }, kill() { if (onClose) queueMicrotask(() => onClose(0)); } }; }
    });
    let err = null;
    try { await d.navigate('https://www.etsy.com/listing/123'); } catch (e) { err = e; }
    A.ok(err && err.code === 'STATION_PROXY_DOWN', 'Page.navigate errorText is read: the proxy failure is named');
    A.ok(err && /could not load www\.etsy\.com: net::ERR_PROXY_CONNECTION_FAILED/.test(err.message), 'the message names the host and the real network error: ' + (err && err.message));
    A.ok(err && !/unsafe redirect|only http\(s\)/.test(err.message), 'and it is NOT reported as an unsafe redirect');
    A.ok(!d.alive(), 'a browser whose proxy is down reads as dead, so the session starts a fresh browser + proxy');
    await d.close();
    clearInterval(keepAlive);
  }

  /* ---- session: the redirect guard's verdicts, case by case ---- */
  function sessionReturning(finalUrl) {
    const drv = { navigate: async () => finalUrl, alive: () => true, close: async () => {} };
    return T.makeBrowserSession({ driver: drv, lookup: null });
  }
  async function verdict(finalUrl) {
    try { await sessionReturning(finalUrl).navigate('https://www.etsy.com/listing/123'); return 'ok'; }
    catch (e) { return String(e.message); }
  }
  A.ok(/^could not load www\.etsy\.com: the page never loaded/.test(await verdict('about:blank')), 'about:blank after a navigation = the page never loaded (was: "blocked unsafe redirect")');
  A.ok(!/unsafe redirect/.test(await verdict('about:blank')), 'about:blank is not called a redirect');
  A.eq(await verdict('https://www.etsy.com/listing/123?ref=x'), 'ok', 'a normal landing passes');
  A.eq(await verdict('HTTPS://WWW.ETSY.COM/listing/123'), 'ok', 'an UPPERCASE scheme/host is normalized by URL, not refused');
  A.ok(/blocked unsafe redirect: only http\(s\) URLs are allowed/.test(await verdict('data:text/html,<h1>x</h1>')), 'a real data: destination is still refused');
  A.ok(/blocked unsafe redirect/.test(await verdict('file:///C:/Windows/win.ini')), 'file: is still refused');
  A.ok(/blocked unsafe redirect/.test(await verdict('chrome://settings/')), 'chrome: is still refused');
  A.ok(/blocked unsafe redirect/.test(await verdict('etsy://listing/123')), 'a custom app scheme is still refused');
  A.ok(/blocked unsafe redirect: refusing to navigate to private/.test(await verdict('http://127.0.0.1/admin')), 'a redirect to loopback is still refused');
  // Location-header shapes the issue asked about: they are resolved against the page URL before the guard sees them
  // (web.js: new URL(res.loc, u.href)); the guard only ever receives an absolute URL.
  A.eq(T.assertSafeUrl(new URL('/listing/9', 'https://www.etsy.com/listing/1').href).href, 'https://www.etsy.com/listing/9', 'a relative Location resolves and passes');
  A.eq(T.assertSafeUrl(new URL('//i.etsystatic.com/x.jpg', 'https://www.etsy.com/listing/1').href).host, 'i.etsystatic.com', 'a protocol-relative Location inherits https and passes');
  A.throws(() => T.assertSafeUrl(new URL('//localhost/x', 'https://www.etsy.com/').href), 'a protocol-relative Location to loopback is still refused');

  /* ---- session: a dead proxy is healed ONCE, transparently ---- */
  {
    const made = [];
    const makeDriver = o => {
      const n = made.length; made.push(o);
      let dead = false;
      return {
        navigate: async url => {
          if (n === 0) { dead = true; const e = new Error('could not load www.etsy.com: net::ERR_PROXY_CONNECTION_FAILED'); e.code = 'STATION_PROXY_DOWN'; throw e; }
          return url;
        },
        alive: () => !dead, ownedPid: () => null, close: async () => {}
      };
    };
    const s = T.makeBrowserSession({ makeDriver, lookup: null, forceHeadless: true });
    const at = await s.navigate('https://www.etsy.com/listing/123');
    A.eq(at, 'https://www.etsy.com/listing/123', 'the navigation succeeds on a fresh browser after the proxy failure');
    A.eq(made.length, 2, 'exactly one fresh browser was started');
    A.ok(made[1].reclaimProfile === true, 'the fresh browser reclaims the profile from the dead one');
  }

  /* ---- a plain failed load keeps the one retry a just-started browser always had, then says what failed ---- */
  {
    let n = 0;
    const failing = times => ({
      navigate: async url => { n++; if (n <= times) { const e = new Error('could not load www.etsy.com: net::ERR_CONNECTION_RESET'); e.code = 'NAVIGATION_FAILED'; throw e; } return url; },
      alive: () => true, close: async () => {}
    });
    const s1 = T.makeBrowserSession({ driver: failing(1), lookup: null });
    A.eq(await s1.navigate('https://www.etsy.com/listing/123'), 'https://www.etsy.com/listing/123', 'one transient load failure is retried once and succeeds');
    n = 0;
    const s2 = T.makeBrowserSession({ driver: failing(5), lookup: null });
    let msg = '';
    try { await s2.navigate('https://www.etsy.com/listing/123'); } catch (e) { msg = e.message; }
    A.ok(/ERR_CONNECTION_RESET/.test(msg) && !/unsafe redirect/.test(msg), 'a persistent failure reaches the agent as the real network error: ' + msg);
    A.eq(n, 2, 'exactly one retry');
  }

  /* ---- browser.reset: the supported recovery tool (agents were refused with no path forward) ---- */
  {
    const closed = [];
    const swept = [];
    const tools = makeBrowserTools({
      makeDriver: () => ({ navigate: async u => u, alive: () => true, close: async () => { closed.push(1); } }),
      lookup: null, forceHeadless: true,
      persistentProfile: { dir: PROFILE_WIN, acquire: () => true, release: () => {} },
      orphanSweep: async o => { swept.push(o.profileDir); return { ok: true, found: 1, killed: [300], survivors: [], ours: [], locks: { removed: ['lockfile'], failed: [] }, error: null }; }
    });
    const reset = tools.tools.find(t => t.name === 'browser.reset');
    A.ok(reset && reset.requiresConsent === false && reset.capability === 'web', 'browser.reset exists on the web capability, no consent card');
    await tools.session.navigate('https://example.com/');
    const out = await reset.run({}, {});
    A.eq(closed.length, 1, "reset closed this run's own browser");
    A.eq(swept, [PROFILE_WIN], 'and swept the STATION profile for orphans');
    A.ok(/Closed this run's browser/.test(out.content) && /ended 1 of 1 orphaned/.test(out.content) && /cleared stale profile lock/.test(out.content), 'receipt text: ' + out.content);
    A.eq(out.summary, 'browser reset', 'summary says reset');
    const again = await tools.session.navigate('https://example.com/again');
    A.eq(again, 'https://example.com/again', 'the next call starts a fresh browser');
  }
  {
    const tools = makeBrowserTools({
      makeDriver: () => ({ navigate: async u => u, alive: () => true, close: async () => {} }),
      lookup: null, forceHeadless: true,
      persistentProfile: { dir: PROFILE_WIN, acquire: () => true, release: () => {} },
      orphanSweep: async () => ({ ok: false, found: 1, killed: [], survivors: [300], ours: [], locks: { removed: [], failed: [] }, error: null })
    });
    const out = await tools.tools.find(t => t.name === 'browser.reset').run({}, {});
    A.eq(out.summary, 'browser reset incomplete', 'a surviving orphan is never reported as a clean reset');
    A.ok(/still running \(pid 300\)/.test(out.content) && /RESET STATION BROWSER/.test(out.content), 'and the agent is told the human recovery path: ' + out.content);
  }

  A.report('browser-orphans.test');
})();
