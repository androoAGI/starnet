/* node test/browser-signin-survives.e2e.test.js — a sign-in in the station browser lasts, on a REAL Chrome.

   THE REPORT (2026-11-06): "anyone know how my agent can access etsy as it keeps on signing me out and my agent keeps on
   asking me to sign in". Three separate routes signed people out, each measured on Chrome 155 before it was fixed:
     1. a login cookie with no expiry was deleted at every relaunch, even after a clean close;
     2. a browser force-killed right after a sign-in lost every cookie from it, whatever its expiry (the boot sweep did that
        to a browser the last sidecar left running);
     3. a run that lost the durable profile to the open station browser browsed signed out, and stayed signed out after the
        Commander closed the window, because the station session keeps the lease.

   A local "shop" sets one cookie of each kind and answers /me with what it received, so every assertion below is what the
   SITE saw. Real driver, real session, real sweep, real Chrome, a throwaway profile. Skipped where this machine has no
   Chrome. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const A = require('./_assert.js');
const { makeBrowserTools, _internals: Browser } = require('../sidecar/tools/builtin/browser.js');
const Orphans = require('../sidecar/tools/builtin/browser-orphans.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SIGNED_IN = 'lasting=1; session=1';   // sorted: the shop answers in a fixed order

function shop() {
  const server = http.createServer((req, res) => {
    if (req.url === '/login') res.setHeader('Set-Cookie', ['session=1; Path=/; HttpOnly', 'lasting=1; Path=/; Max-Age=31536000; HttpOnly']);
    res.setHeader('Content-Type', 'text/plain');
    const seen = String(req.headers.cookie || 'nothing').split('; ').sort().join('; ');
    res.end(req.url === '/login' ? 'signed in' : 'cookies: ' + seen);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ url: p => 'http://127.0.0.1:' + server.address().port + p, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) })));
}
function driverOn(dir, extra) {
  return Browser.makeCdpDriver(Object.assign({ profileDir: dir, profileIsPersistent: true, cleanupProfile: false, headed: false, forceHeadless: true, syntheticInputOnly: true, cdpPort: 0, networkProxy: false, lookup: null, timeoutMs: 20000 }, extra || {}));
}
async function whatTheShopSees(driver, s) {
  driver.allowLocal(s.url('/me'));
  await driver.navigate(s.url('/me'));
  return String(await driver.getText()).trim();
}

/* THE SIDECAR THAT LEAVES AN ORPHAN: signs in, reports, and is ended with no warning. On Windows a plain child dies with its
   parent (the Job Object Node puts it in: measured gone within 100 ms), so this Chrome is detached to outlive it, the shape of
   the orphans in report #61. On macOS and Linux that is simply what a child does. */
if (process.argv[2] === '--signs-in-then-dies') {
  (async () => {
    const d = driverOn(process.argv[3], { spawn: (exe, args, opts) => spawn(exe, args, Object.assign({}, opts, { detached: true })) });
    d.allowLocal(process.argv[4]);
    await d.navigate(process.argv[4]);
    process.stdout.write('signed-in ' + d.ownedPid() + '\n');
    setInterval(() => {}, 1000);
  })().catch(e => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
  return;
}

(async () => {
  if (!Browser.resolveChrome(false)) { console.log('SKIP: browser-signin-survives.e2e (no Chrome on this machine)'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-signin-'));
  const s = await shop();
  try {
    // ---- 1. a clean close, then a relaunch, three times over ----
    {
      const dir = path.join(root, 'clean');
      let d = driverOn(dir);
      d.allowLocal(s.url('/login'));
      await d.navigate(s.url('/login'));
      await d.close();
      for (let i = 1; i <= 3; i++) {
        d = driverOn(dir);
        A.eq(await whatTheShopSees(d, s), 'cookies: ' + SIGNED_IN, 'relaunch ' + i + ' after a clean close: the shop still sees both cookies');
        await d.close();
      }
      const tabs = driverOn(dir);
      await tabs.navigate('about:blank');
      A.eq((await tabs.tabs()).length, 1, 'keeping the sign-in brings no old tab back');
      await tabs.close();
    }

    // ---- 2. the sidecar dies straight after the sign-in, and the next boot sweeps its browser at once ----
    {
      const dir = path.join(root, 'orphan');
      fs.mkdirSync(dir, { recursive: true });
      const child = spawn(process.execPath, [__filename, '--signs-in-then-dies', dir, s.url('/login')], { stdio: ['ignore', 'pipe', 'inherit'] });
      const pid = await new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', c => { out += c; const m = /signed-in (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
        child.once('exit', code => reject(new Error('the dying sidecar left early: ' + code)));
      });
      child.removeAllListeners('exit');
      child.kill('SIGKILL');
      await new Promise(r => child.once('exit', r));
      A.ok(Orphans.profileProcesses(await Orphans.makeProcessLister({})(), dir).some(p => p.pid === pid), 'its Chrome outlived it, still on the profile');
      const receipt = await Orphans.sweep({ profileDir: dir });
      A.eq([receipt.found > 0, receipt.ok], [true, true], 'the next boot ended it: ' + Orphans.describeSweep(receipt));
      A.ok(!Orphans.profileProcesses(await Orphans.makeProcessLister({})(), dir).some(p => p.pid === pid), 'that browser is gone');
      const d = driverOn(dir);
      A.eq(await whatTheShopSees(d, s), 'cookies: ' + SIGNED_IN, 'a sign-in seconds before the sidecar died survives the sweep');
      await d.close();
    }

    // ---- 3. a run that loses the durable profile to the open station browser is signed in as the station is ----
    {
      const dir = path.join(root, 'station');
      let holder = null;
      const lease = id => ({
        dir,
        acquire: () => { if (holder && holder !== id) return false; holder = id; return true; },
        fallback: () => holder === 'station' && id !== 'station',
        seedCookies: () => station.session.savedCookies(),
        release: () => { if (holder === id) holder = null; }
      });
      const rig = (id, extra) => Object.assign({ forceHeadless: true, syntheticInputOnly: true, cdpPort: 0, networkProxy: false, lookup: null, timeoutMs: 20000,
        profileDir: path.join(root, 'temp-' + id), cleanupProfile: true, persistentProfile: lease(id) }, extra || {});
      const station = makeBrowserTools(rig('station'));
      await station.session.navigate(s.url('/login'), { local: true });

      const run = makeBrowserTools(rig('run'));
      A.eq(run.session.evalAllowed().ok, false, 'browser.eval is refused before the browser even starts: the sign-ins are about to be here');
      await run.session.navigate(s.url('/me'), { local: true });
      A.eq(String(await run.session.getText()).trim(), 'cookies: ' + SIGNED_IN, 'the run on a temporary profile: the shop sees it signed in');
      A.eq(run.session.evalAllowed().ok, false, 'browser.eval stays refused where the sign-ins are');
      A.ok(!fs.existsSync(path.join(root, 'temp-station')), 'the station really runs on the durable profile, not a temporary one');
      A.ok(fs.existsSync(path.join(root, 'temp-run')), 'and the run really runs on a temporary one');
      await run.session.close();
      A.ok(!fs.existsSync(path.join(root, 'temp-run')), 'the copy of the sign-ins leaves with the run');

      // the Commander closes the window: Chrome exits by itself. The lease stays with the station session.
      const browsers = Orphans.profileProcesses(await Orphans.makeProcessLister({})(), dir).filter(p => p.browser);
      A.eq(browsers.length, 1, 'the station browser is one Chrome on the durable profile');
      A.eq(await Orphans.closeGently(browsers), 1, 'and it closes when asked, as a closed window does');
      await sleep(500);
      const late = makeBrowserTools(rig('late'));
      await late.session.navigate(s.url('/me'), { local: true });
      A.eq(String(await late.session.getText()).trim(), 'cookies: ' + SIGNED_IN, 'with the window closed the next run is still signed in');
      await late.session.close();
      await station.session.navigate(s.url('/me'), { local: true });
      A.eq(String(await station.session.getText()).trim(), 'cookies: ' + SIGNED_IN, 'and the station browser reopens signed in');
      await station.session.close();

      // nothing to copy: a run on an empty station keeps the door it always had
      const emptyDir = path.join(root, 'empty');
      let emptyHolder = 'empty-station';
      const emptyStation = { savedCookies: async () => [] };
      const bare = makeBrowserTools({ forceHeadless: true, syntheticInputOnly: true, cdpPort: 0, networkProxy: false, lookup: null, timeoutMs: 20000, profileDir: path.join(root, 'temp-bare'), cleanupProfile: true,
        persistentProfile: { dir: emptyDir, acquire: () => false, fallback: () => !!emptyHolder, seedCookies: () => emptyStation.savedCookies(), release: () => { emptyHolder = null; } } });
      await bare.session.navigate(s.url('/me'), { local: true });
      A.eq(String(await bare.session.getText()).trim(), 'cookies: nothing', 'an empty station seeds nothing');
      A.eq(bare.session.evalAllowed().ok, true, 'and browser.eval is open again: there are no credentials here to steal');
      await bare.session.close();
    }
  } finally {
    await s.close();
    await sleep(500);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('browser-signin-survives.e2e');
  process.exit(process.exitCode || 0);
})().catch(e => { console.log('FAIL: browser-signin-survives.e2e threw - ' + (e && e.stack || e)); process.exit(1); });
