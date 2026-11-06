/* node test/browser-signin-survives.test.js — the rules behind "a sign-in lasts" (Etsy report, 2026-11-06), hermetic: fake
   files, fake process table, fake drivers. The real Chrome proofs are browser-signin-survives.e2e and .run.e2e. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { sidecarSourceFiles } = require('./helpers/source');
const { makeBrowserTools } = require('../sidecar/tools/builtin/browser.js');
const O = require('../sidecar/tools/builtin/browser-orphans.js');

const source = sidecarSourceFiles().find(f => f.rel === 'sidecar/tools/builtin/browser.js').text;
const cleanStartSource = A.fnBody(source, 'function cleanStart(dir)');
const cookieParamsSource = A.fnBody(source, 'function cookieParams(list)');
if (!cleanStartSource || !cookieParamsSource) throw new Error('source slice not found');

function fakeDriver(extra) {
  return Object.assign({ navigate: async u => u, snapshot: async () => [], back: async () => '', forward: async () => '', getText: async () => 'text', tabs: async () => [], consoleLog: () => [], networkLog: () => [],
    usingPersistentProfile: () => false, close: async () => {} }, extra || {});
}

(async () => {
  // ---- cleanStart: on the durable profile every exit reads as a crash, the one thing that keeps a no-expiry login cookie ----
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-cleanstart-'));
    const run = (dir, persistent) => vm.runInNewContext(cleanStartSource + ';cleanStart(dir)', { dir, P: path, FS: fs, onPersistent: () => persistent, failNote: (t, e) => { throw e; } });
    const prefs = dir => JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'));
    const seed = (name, profile) => { const d = path.join(root, name); fs.mkdirSync(path.join(d, 'Default', 'Sessions'), { recursive: true }); fs.writeFileSync(path.join(d, 'Default', 'Preferences'), JSON.stringify({ profile, keep: 1 })); return d; };

    const clean = seed('durable-clean', { exit_type: 'Normal', exited_cleanly: true });
    run(clean, true);
    A.eq(prefs(clean).profile.exit_type, 'Crashed', 'a clean exit of the durable profile is marked so its login cookies load');
    A.eq(prefs(clean).keep, 1, 'nothing else in the file changes');
    A.eq(fs.existsSync(path.join(clean, 'Default', 'Sessions')), false, 'and the saved tabs go, so no old page comes back');

    const crashed = seed('durable-crashed', { exit_type: 'Crashed', exited_cleanly: false });
    run(crashed, true);
    A.eq([prefs(crashed).profile.exit_type, prefs(crashed).profile.exited_cleanly], ['Crashed', true], 'a real crash stays a crash, with its prompt suppressed');

    const temp = seed('temp', { exit_type: 'Crashed', exited_cleanly: false });
    run(temp, false);
    A.eq(prefs(temp).profile.exit_type, 'Normal', 'a temporary profile has nothing to keep: as it always was');

    const young = path.join(root, 'young');
    fs.mkdirSync(path.join(young, 'Default', 'Network'), { recursive: true });
    fs.writeFileSync(path.join(young, 'Default', 'Network', 'Cookies'), 'x');
    run(young, true);
    A.eq(prefs(young).profile.exit_type, 'Crashed', 'a durable profile whose first run died before it wrote Preferences keeps its first sign-in');

    const blank = path.join(root, 'blank');
    fs.mkdirSync(path.join(blank, 'Default'), { recursive: true });
    run(blank, true);
    A.eq(fs.existsSync(path.join(blank, 'Default', 'Preferences')), false, 'a brand new profile is left for Chromium to set up');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ---- cookieParams: a cookie comes through as itself ----
  {
    const cookieParams = vm.runInNewContext('(' + cookieParamsSource.replace(/^function cookieParams/, 'function') + ')');
    const [session, lasting, partitioned] = JSON.parse(JSON.stringify(cookieParams([
      { name: 'a', value: '1', domain: 'shop.example', path: '/', expires: -1, size: 2, httpOnly: true, secure: true, session: true, sameSite: 'Lax', priority: 'Medium', sourceScheme: 'Secure', sourcePort: 443 },
      { name: 'b', value: '2', domain: '.shop.example', path: '/x', expires: 1900000000, size: 2, httpOnly: false, secure: false, session: false },
      { name: 'c', value: '3', domain: 'shop.example', path: '/', expires: 1900000000, session: false, partitionKey: { topLevelSite: 'https://x.example', hasCrossSiteAncestor: true } },
      null, { name: 'no-domain', value: '4' }
    ])));
    A.eq(session, { name: 'a', value: '1', domain: 'shop.example', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', priority: 'Medium', sourceScheme: 'Secure', sourcePort: 443 }, 'a session cookie stays one, host-only, and carries nothing setCookies refuses');
    A.eq([lasting.expires, lasting.domain, lasting.path], [1900000000, '.shop.example', '/x'], 'a lasting cookie keeps its expiry and its scope');
    A.eq(partitioned.partitionKey.topLevelSite, 'https://x.example', 'a partitioned cookie stays partitioned');
  }

  // ---- the seed reaches only a run on a temporary profile, and browser.eval follows the credentials ----
  {
    const seedCookies = async () => [];
    const lease = (acquired, fallback) => ({ dir: 'C:/tmp/profile', acquire: () => acquired, release: () => {}, fallback: () => fallback, seedCookies });
    const built = [];
    const lost = makeBrowserTools({ makeDriver: d => { built.push(d); return fakeDriver({ holdsSavedSignIns: () => true }); }, lookup: null, persistentProfile: lease(false, true) });
    A.eq(lost.session.evalAllowed().ok, false, 'lost to the station browser, not started yet: eval refused, the sign-ins are about to arrive');
    await lost.session.navigate('https://example.com/');
    A.eq(built[0].seedCookies, seedCookies, 'the temporary browser is handed the saved sign-ins');
    A.eq(built[0].profileIsPersistent, false, 'and stays on a temporary profile');
    A.eq(lost.session.evalAllowed().ok, false, 'eval stays refused where they are');

    const emptied = makeBrowserTools({ makeDriver: () => fakeDriver({ holdsSavedSignIns: () => false }), lookup: null, persistentProfile: lease(false, true) });
    await emptied.session.navigate('https://example.com/');
    A.eq(emptied.session.evalAllowed().ok, true, 'there turned out to be none: eval opens, nothing here to steal');

    const free = [];
    const owner = makeBrowserTools({ makeDriver: d => { free.push(d); return fakeDriver(); }, lookup: null, persistentProfile: lease(true, true) });
    await owner.session.navigate('https://example.com/');
    A.eq(free[0].seedCookies, undefined, 'a run on the durable profile needs no copy');
    A.eq(free[0].profileIsPersistent, true, 'it is on the durable profile');

    let refused = '';
    const another = makeBrowserTools({ makeDriver: () => fakeDriver(), lookup: null, profileWaitMs: 0, persistentProfile: lease(false, false) });
    try { await another.session.navigate('https://example.com/'); } catch (e) { refused = e.message; }
    A.ok(/in use by another agent run/.test(refused), 'lost to another RUN: still refused, no copy');
  }

  // ---- savedCookies: ask the live browser, or read the profile when the window was closed ----
  {
    const lease = { dir: 'C:/tmp/profile', acquire: () => true, release: () => {} };
    const made = [];
    let isAlive = true;
    const station = fakeDriver({ alive: () => isAlive, exportCookies: async () => [{ name: 'live' }], ownedPid: () => null });
    const B = makeBrowserTools({ lookup: null, persistentProfile: lease, makeDriver: d => {
      made.push(d);
      return made.length === 1 ? station : fakeDriver({ exportCookies: async () => [{ name: 'on-disk' }], close: async o => { made.closed = o; } });
    } });
    A.eq(await B.session.savedCookies(), [], 'no lease yet: nothing to give');
    await B.session.navigate('https://example.com/');
    A.eq((await B.session.savedCookies())[0].name, 'live', 'a live browser answers itself');
    A.eq(made.length, 1, 'and starts nothing');
    isAlive = false;
    const [one, two] = await Promise.all([B.session.savedCookies(), B.session.savedCookies()]);
    A.eq([one[0].name, two[0].name], ['on-disk', 'on-disk'], 'its window closed: the durable profile is read');
    A.eq(made.length, 2, 'by one short-lived browser, however many ask');
    A.eq([made[1].profileDir, made[1].profileIsPersistent, made[1].headed, made[1].cleanupProfile], ['C:/tmp/profile', true, false, false], 'hidden, on the durable profile, which is never cleaned up');
    A.eq(made.closed, { keepProfile: true }, 'and closed again, keeping the profile');
  }

  // ---- ask before killing ----
  {
    A.eq(O.debugPortOf('"C:/chrome.exe" --remote-debugging-port=61898 "--user-data-dir=C:/p"'), 61898, 'the port on the command line');
    A.eq(O.debugPortOf('"C:/chrome.exe" --user-data-dir=C:/p'), 0, 'none: nothing to ask');

    const PROFILE = 'C:/Users/Ann/workspaces/.browser-profile';
    const browser = { pid: 300, ppid: 999, cmd: 'chrome.exe --remote-debugging-port=61898 "--user-data-dir=' + PROFILE + '" about:blank' };
    const helper = { pid: 301, ppid: 300, cmd: 'chrome.exe --type=renderer "--user-data-dir=' + PROFILE + '"' };
    const rig = (gentle, afterClose) => {
      const killed = [], asked = [];
      let table = [browser, helper];
      return { killed, asked, opts: { profileDir: PROFILE, platform: 'win32', selfPid: 100, sleep: async () => {}, fs: { rmSync() {}, existsSync: () => false }, confirmAttempts: 2,
        listProcesses: async () => table,
        kill: async pid => { killed.push(pid); table = table.filter(r => r.pid !== pid); },
        closeGently: async browsers => { asked.push(...browsers.map(b => b.pid)); if (gentle instanceof Error) throw gentle; if (gentle) table = afterClose; return gentle; } } };
    };
    const closed = rig(1, []);
    const a = await O.sweep(closed.opts);
    A.eq([closed.asked, closed.killed], [[300], []], 'a browser that closes when asked is never killed');
    A.eq([a.ok, a.found, a.killed.length], [true, 2, 2], 'and the receipt says everything on the profile ended');

    const helperLeft = rig(1, [helper]);
    await O.sweep(helperLeft.opts);
    A.eq(helperLeft.killed, [301], 'a helper it left behind is still ended');

    const stuck = rig(0);
    await O.sweep(stuck.opts);
    A.eq(stuck.killed, [300, 301], 'a stuck browser is killed as before, browser first');

    const broken = rig(new Error('no port answers'));
    const b = await O.sweep(broken.opts);
    A.eq([broken.killed, b.ok], [[300, 301], true], 'asking that fails never stops the kill');

    const bare = { pid: 400, cmd: 'chrome.exe --user-data-dir=C:/p' };
    const dead = new Set();
    const asked = [];
    A.eq(await O.closeGently([browser, bare], { ask: async port => { asked.push(port); dead.add(300); }, alive: pid => !dead.has(pid), sleep: async () => {} }), 1, 'closeGently counts the browsers that really exited');
    A.eq(asked, [61898], 'and asks only over a port the command line names');
    let waits = 0;
    A.eq(await O.closeGently([browser], { ask: async () => {}, alive: () => true, sleep: async () => { waits++; } }), 0, 'one that answers and never exits does not count');
    A.ok(waits > 0 && waits <= 30, 'and the wait for it is bounded');
    A.eq(await O.closeGently([browser], { ask: async () => { throw new Error('refused'); }, alive: () => true, sleep: async () => { throw new Error('nothing to wait for'); } }), 0, 'one that cannot be asked is not waited for');
  }
  A.report('browser-signin-survives.test');
})().catch(e => { console.log('FAIL: browser-signin-survives.test threw - ' + (e && e.stack || e)); process.exit(1); });
