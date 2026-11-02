/* Failed Chromium teardown must release owned servers, retain its error and leave profiles intact.
   Hermetic: executes the production close function and full upload fixture with injected effects. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { sidecarSourceFiles } = require('./helpers/source');
const EgressFiles = require('../sidecar/egress-files.js');
const source = sidecarSourceFiles().find(f => f.rel === 'sidecar/tools/builtin/browser.js').text;
const closeSource = A.fnBody(source, 'async function close(opts)');
const pidSource = A.fnBody(source, 'function ownedPid()');
if (!closeSource || closeSource.length > 6500 || !pidSource || pidSource.length > 300) throw Error('Invalid lifecycle source slice');

function rig(opts = {}) {
  const calls = [], removed = [], notes = [], timers = [];
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const scope = {
    proc: opts.attached ? null : { pid: 4242, kill() { calls.push('kill'); if (opts.exits) exit(); } },
    procExited: false, procClosePromise: opts.attached ? null : exited,
    cdp: { send(method) { calls.push(method); if (opts.graceful) exit(); return Promise.resolve(); }, close() { calls.push('cdp.close'); } },
    onPersistent: () => !!opts.persistent,
    networkProxy: opts.attached ? null : { async close() { calls.push('proxy.close'); if (opts.proxyClose) await opts.proxyClose(); if (opts.proxyError) throw opts.proxyError; } },
    proxyCloseResults: new WeakMap(),
    process: { platform: 'linux' }, spawn() {}, CP: { spawn() {} },
    killTree() { throw Error('No native process effects allowed'); },
    closeExitWaitMs: opts.exitWaitMs || 8000,   // the close body reads it from scope: production default
    failNote: (tag, e) => notes.push({ tag, e }), swallow: () => () => {},
    setTimeout(fn, ms) { timers.push(ms); return setTimeout(fn, 0); }, clearTimeout,
    deps: { cleanupProfile: !opts.attached }, profileDir: '/owned/profile', heldFallbackDir: opts.fallback ? '/owned/fallback' : null,
    FS: { rmSync(p) { removed.push(p); } }
  };
  function exit() { scope.procExited = true; resolveExit(true); }
  vm.runInNewContext(closeSource + ';this.closeDriver=close;' + pidSource + ';this.pid=ownedPid;', scope);
  return { close: scope.closeDriver, pid: scope.pid, exit, calls, removed, notes, timers, proxy: () => scope.networkProxy, replaceProxy: proxy => { scope.networkProxy = proxy; } };
}
async function rejection(fn) { try { await fn(); return null; } catch (e) { return e; } }

// `platform` picks the fixture's scratch-removal branch: win32 retries whole fs.rmSync passes while a file is held, POSIX
// retries whole fsp.rm passes (Linux CI run 40976584893). The fake fs records which call removed what, so both branches are
// pinned on every host (run 41009945105: the fixture had no platform and no fsp.rm, so it failed everywhere after that change).
// `stall` runs the fixture over the PRODUCTION close and ownedPid (rig above), on a fake clock that the fixture's timers move
// as they fire at once. Its Chromium leaves when the clock reaches exitsAfterMs (0: at the first close), and a file in its
// scratch stays held, failing fs.rmSync with busyCode (EBUSY by default), until the clock reaches busyUntilMs.
async function uploadFixture(closeError, serverError, platform, stall) {
  const calls = [], errors = [], logs = [], removed = [], removedVia = [], waits = [];
  let clock = 0;
  const simulatedProcess = { exitCode: 0, platform };
  const bodyError = new Error('injected fixture action failure');
  const server = {
    listen(port, host, cb) { calls.push('listen'); cb(); }, address: () => ({ port: 12345 }),
    close(cb) { calls.push('server.close'); cb(serverError); }, closeAllConnections() { calls.push('server.connections.close'); }
  };
  const owned = stall ? rig({ exits: stall.exitsAfterMs === 0, proxyError: stall.proxyError }) : null;
  const driver = owned
    ? { allowLocal() {}, ownedPid: owned.pid, async close() { calls.push('driver.close'); await owned.close(); } }
    : { allowLocal() {}, async close() { calls.push('driver.close'); if (closeError) throw closeError; } };
  const held = p => stall && clock < stall.busyUntilMs && p.endsWith('starnet-upload-live-owned');
  const scope = {
    process: simulatedProcess,
    console: { log(...args) { logs.push(args.join(' ')); }, error(...args) { errors.push(args); } },
    Date: { now: () => clock },
    setTimeout(fn, ms) { waits.push(ms); clock += ms; if (owned && clock >= stall.exitsAfterMs) owned.exit(); setImmediate(fn); },
    require(id) {
      if (id === './_assert.js') return { report() { calls.push('report'); } };
      if (id === 'node:fs') return { mkdtempSync: prefix => prefix + 'owned', mkdirSync() {}, writeFileSync() {}, rmSync(p) {
        if (held(p)) { const code = stall.busyCode || 'EBUSY'; throw Object.assign(new Error(code + ': injected, a file is held'), { code, path: p + '/chrome/Default/Cache/Cache_Data/sqldb0' }); }
        removed.push(p); removedVia.push(['rmSync', p]);
      } };
      if (id === 'node:fs/promises') return { async rm(p) { removed.push(p); removedVia.push(['rm', p]); } };
      if (id === 'node:path') return path;
      if (id === 'node:os') return os;
      if (id === 'node:http') return { createServer: () => server };
      if (id === '../sidecar/tools/builtin/browser.js') return {
        _internals: { findChrome: () => 'fake-chrome', makeCdpDriver: () => driver },
        makeBrowserTools: () => ({ tools: [{ name: 'browser.upload' }], session: { async navigate() { throw bodyError; } }, async releaseUploads() { calls.push('releaseUploads'); } })
      };
      // the REAL module: defaultStagingRoot only names a path and makeEgressReader touches no filesystem until a read,
      // which the failing navigate never reaches; the fixture's staging-root rmSync still lands in the fake fs above
      if (id === '../sidecar/egress-files.js') return EgressFiles;
      throw Error('Unexpected fixture dependency: ' + id);
    }
  };
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'browser-upload.e2e.test.js'), 'utf8'), scope);
  // what the fixture's fake mkdtempSync handed it, and the station staging root its uploads would have used
  const scratch = path.join(os.tmpdir(), 'starnet-upload-live-') + 'owned';
  return { calls, errors, logs, removed, removedVia, waits, owned, simulatedProcess, bodyError, scratch, stagingRoot: EgressFiles.defaultStagingRoot(path, path.join(scratch, 'workspaces'), path.join(scratch, 'staging')) };
}
const total = ms => ms.reduce((sum, n) => sum + n, 0);

(async () => {
  const stuck = rig({ fallback: true });
  const error = await rejection(() => stuck.close());
  A.ok(error && /owned Chromium did not exit/.test(error.message), 'unproved exit still rejects with the shutdown error');
  A.eq(stuck.calls, ['cdp.close', 'kill', 'proxy.close'], 'proxy cleanup runs after the failed owned-process wait');
  A.eq(stuck.removed, [], 'neither primary nor fallback profile is deleted on failure');
  A.eq(stuck.pid(), 4242, 'failed close retains the owned process handle');
  A.eq(stuck.timers, [8000], 'production exit timeout is unchanged (only the test scheduler is accelerated)');
  A.ok(source.includes('const closeExitWaitMs = Number(deps.closeExitWaitMs) > 0 ? Number(deps.closeExitWaitMs) : 8000;'), 'the limit is 8 s, and injectable');
  const short = rig({ exitWaitMs: 123 });
  await rejection(() => short.close());
  A.eq(short.timers, [123], 'the close uses the limit it was given');
  A.ok(await rejection(() => stuck.close()), 'retry cannot report success while the process is still unconfirmed');
  A.eq(stuck.removed, [], 'retry cannot bypass profile safety');
  A.eq(stuck.calls.filter(c => c === 'proxy.close').length, 1, 'proxy cleanup is not repeated');
  stuck.exit();
  const kills = stuck.calls.filter(c => c === 'kill').length;
  await stuck.close();
  A.eq(stuck.calls.filter(c => c === 'kill').length, kills, 'an exited process ID is never killed again');
  A.eq(stuck.pid(), null, 'confirmed exit clears owned identity');
  A.eq(stuck.removed, ['/owned/profile', '/owned/fallback'], 'confirmed exit permits owned profile cleanup');

  const proxyError = new Error('injected proxy close failure');
  const both = rig({ proxyError });
  const primary = await rejection(() => both.close());
  A.ok(primary && /owned Chromium did not exit/.test(primary.message), 'secondary proxy failure cannot replace the primary shutdown error');
  A.eq(both.notes.map(n => n.tag), ['browser.close.proxy'], 'secondary cleanup failure stays observable');
  A.ok(both.notes[0].e === proxyError, 'the proxy failure is reported');
  A.eq(both.removed, [], 'double failure retains the profile');
  const onlyProxy = rig({ exits: true, proxyError });
  A.ok(await rejection(() => onlyProxy.close()) === proxyError, 'proxy failure alone remains a failure');
  A.eq(onlyProxy.removed, [], 'profile cleanup is skipped when proxy close fails');

  A.ok(onlyProxy.proxy(), 'failed proxy cleanup retains its owned reference');
  A.ok(await rejection(() => onlyProxy.close()) === proxyError, 'repeated close preserves the identical rejected proxy result');
  A.eq(onlyProxy.calls.filter(c => c === 'proxy.close').length, 1, 'failed proxy cleanup is invoked only once');
  A.eq(onlyProxy.removed, [], 'repeated failure cannot delete the profile');
  both.exit();
  A.ok(await rejection(() => both.close()) === proxyError, 'even a later proven Chromium exit cannot bypass failed proxy cleanup');
  A.eq(both.removed, [], 'late process exit still leaves profile intact after proxy failure');

  for (const rejects of [false, true]) {
    let finish, started;
    const held = new Promise((resolve, reject) => { finish = rejects ? () => reject(proxyError) : resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const concurrent = rig({ exits: true, proxyClose: () => { started(); return held; } });
    const ownedProxy = concurrent.proxy();
    const first = concurrent.close(), second = concurrent.close();
    let terminals = 0;
    const results = Promise.allSettled([first, second]);
    first.then(() => { terminals++; }, () => { terminals++; });
    second.then(() => { terminals++; }, () => { terminals++; });
    await entered;
    await new Promise(resolve => setImmediate(resolve));
    A.eq(terminals, 0, 'both concurrent closes await the held proxy cleanup');
    A.eq(concurrent.removed, [], 'pending proxy cleanup prevents profile deletion');
    A.ok(concurrent.proxy() === ownedProxy, 'pending cleanup retains the exact owned proxy');
    finish();
    const outcomes = await results;
    A.eq(outcomes.map(r => r.status), rejects ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled'],
      'concurrent close callers share the cleanup outcome');
    A.eq(concurrent.calls.filter(c => c === 'proxy.close').length, 1, 'concurrent callers invoke proxy cleanup once');
    if (rejects) {
      A.ok(outcomes.every(r => r.reason === proxyError), 'all concurrent failures preserve the same error identity');
      A.ok(await rejection(() => concurrent.close()) === proxyError, 'later close remains failed after concurrent rejection');
      A.eq(concurrent.removed, [], 'failed shared promise cannot delete profiles');
      A.ok(concurrent.proxy() === ownedProxy, 'rejected shared promise retains the owned proxy');
    } else A.eq(concurrent.proxy(), null, 'only successful cleanup releases the proxy reference');
  }
  const mixed = rig({ proxyError });
  const mixedResults = await Promise.allSettled([mixed.close(), mixed.close()]);
  A.ok(mixedResults.every(r => r.status === 'rejected' && /owned Chromium did not exit/.test(r.reason.message)),
    'concurrent Chromium failures retain precedence over the shared proxy failure');
  A.eq(mixed.calls.filter(c => c === 'proxy.close').length, 1, 'concurrent double failure still invokes proxy cleanup once');
  A.eq(mixed.removed, [], 'concurrent double failure never removes the profile');
  const replacement = rig({ exits: true });
  await replacement.close({ keepProfile: true });
  let replacementCloses = 0;
  replacement.replaceProxy({ async close() { replacementCloses++; } });
  await replacement.close({ keepProfile: true });
  A.eq(replacementCloses, 1, 'a new proxy has its own cleanup result after a successful earlier close');

  const graceful = rig({ persistent: true, graceful: true });
  await graceful.close({ keepProfile: true });
  A.eq(graceful.calls, ['Browser.close', 'cdp.close', 'proxy.close'], 'persistent browser flushes and exits without a forced kill');
  A.eq(graceful.removed, [], 'keepProfile still protects the persistent profile');
  const attached = rig({ attached: true, persistent: true });
  await attached.close();
  A.eq(attached.calls, ['cdp.close'], 'attached user browser is neither sent Browser.close nor killed');
  A.eq(attached.removed, [], 'attached profile is never removed');
  /* the run's OWN browser takes its staged upload copies with it when it closes, in a finally: a close that rejects (the
     stuck-Chromium path above) still drops them. The registry is the SESSION's now (run-paths-polish P1,
     upload-stage.js), so this is proven on the real session over a real staging root, not by the source of a wrapper.
     The host's run-end release (releaseUploads) drops a copy whose page is gone or unnamed and KEEPS one whose page is
     alive (the person may still submit it: live walk W-R7 (b)); the browser's close drops that one too. */
  {
    const fsp = require('node:fs/promises');
    const { makeBrowserTools } = require('../sidecar/tools/builtin/browser.js');
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-close-upload-')));
    const ws = path.join(scratch, 'workspaces'), stagingRoot = path.join(scratch, 'staging');
    fs.mkdirSync(path.join(ws, 'agent'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'agent', 'a.txt'), 'A-BYTES');
    try {
      const egress = EgressFiles.makeEgressReader({ fsp, pathMod: path, workspaces: ws, stagingRoot, stagingOwner: null, hardenStagingDir: async () => {} });
      let loader = 'L1', named = true;
      const driver = {
        snapshot: async () => [{ role: 'button', text: 'Choose', x: 1, y: 1, w: 10, h: 10 }],
        upload: async (_n, abs, expected) => Object.assign({ status: 'selected', files: expected, retained: true, events: ['change'] }, named ? { doc: { sid: null, loader } } : {}),
        uploadDocAlive: async doc => doc.loader === loader,
        clearStagedInputs: async () => ({ cleared: 0, paths: [] }),
        close: async () => { throw new Error('injected: owned Chromium did not exit'); }
      };
      const b = makeBrowserTools({ driver, fsp, pathMod: path, root: ws, egress });
      const up = b.tools.find(t => t.name === 'browser.upload');
      const ref = (await b.session.snapshot())[0].ref;
      const copies = () => (fs.existsSync(path.join(stagingRoot, 'agent')) ? fs.readdirSync(path.join(stagingRoot, 'agent')) : []);
      await up.run({ ref, paths: ['a.txt'] }, { agentId: 'agent' });          // its page stays
      await up.run({ ref, paths: ['a.txt'] }, { agentId: 'agent' });
      loader = 'L2';                                                          // ...that page navigated away
      await up.run({ ref, paths: ['a.txt'] }, { agentId: 'agent' });          // a page on L2 (alive)
      named = false;
      await up.run({ ref, paths: ['a.txt'] }, { agentId: 'agent' });          // a page this driver cannot name
      A.eq(copies().length, 2, 'releaseUploads: (control) the copies of the page that navigated away went after that action; two are live');
      await b.releaseUploads();
      A.eq(copies().length, 1, 'releaseUploads drops the copy no page identity was read for and keeps the one whose page is alive');
      const closed = await rejection(() => b.session.close());
      A.ok(closed && /did not exit/.test(closed.message), 'the close failure still propagates');
      A.eq(copies(), [], 'closing the run\'s own browser drops its staged uploads even when the close fails');
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }

  for (const platform of ['win32', 'linux']) for (const [closeFailure, serverFailure] of [[new Error('owned close failed'), null], [new Error('owned close failed'), new Error('server close failed')], [null, new Error('server close failed')], [null, null]]) {
    const r = await uploadFixture(closeFailure, serverFailure, platform);
    if (!closeFailure && !serverFailure) A.eq(r.removedVia.filter(([, p]) => p === r.scratch).map(([via]) => via), [platform === 'win32' ? 'rmSync' : 'rm'],
      'scratch is removed by the ' + platform + ' branch (' + (platform === 'win32' ? 'whole fs.rmSync passes' : 'whole fsp.rm passes') + ')');
    A.eq(r.calls, ['listen', 'driver.close', 'server.close', 'server.connections.close'], 'fixture always closes its server and never reaches the success report after failure');
    A.eq(r.waits, [], 'a close that worked, or failed any way but "did not exit", is not waited on');
    A.eq(r.simulatedProcess.exitCode, 1, 'fixture failure remains nonzero');
    A.eq(r.removed.filter(p => p === r.scratch).length, closeFailure || serverFailure ? 0 : 1, 'cleanup failure retains scratch; confirmed cleanup permits removal');
    // TEST HYGIENE (polish review round 1): the fixture stages in a base of its own scratch, never the user's real
    // per-user base (%LOCALAPPDATA%\StarNet on Windows, os.tmpdir() on POSIX)
    A.ok(/starnet-upload-staging-[0-9a-f]{16}$/.test(r.stagingRoot) && path.dirname(r.stagingRoot) === path.join(r.scratch, 'staging') && path.dirname(r.stagingRoot) !== path.resolve(EgressFiles._internals.stagingBase(path)),
      'the fixture\'s upload staging root is the station root in a base inside its own scratch, never the user\'s real per-user base');
    A.eq(r.removed.filter(p => p === r.stagingRoot).length, 1, 'the fixture clears its own upload staging root on every exit, so no staged copy outlives it');
    A.eq(r.removed.filter(p => p !== r.scratch && p !== r.stagingRoot), [], 'the fixture removes nothing but its scratch and its own staging root');
    const terminal = r.errors[r.errors.length - 1][0];
    A.ok(String(terminal).includes((closeFailure || serverFailure || r.bodyError).message), 'fixture reports its primary failure');
    if (serverFailure && closeFailure) A.ok(r.errors[0][1] === serverFailure, 'secondary fixture cleanup failure is also visible');
  }

  /* A KILLED CHROMIUM SLOW TO LET GO (2026-11-01): on a busy Windows box it outlasted production's 8 s, and a helper then
     kept the profile's files held, and browser-upload.e2e went red with every assertion held. The fixture now waits both
     out, inside one bound. The whole fixture over the production close: a late exit is proved by one more close and never
     killed again, and a Chromium still there at the bound keeps the step red with production's own error and keeps its
     scratch and profile. */
  const BOUND_MS = 300000;
  const scratchGone = r => r.removed.filter(p => p === r.scratch).length === 1;
  const reported = (r, text) => String(r.errors[r.errors.length - 1][0]).includes(text);
  for (const platform of ['win32', 'linux']) {
    for (const exitsAfterMs of [1, 38000, BOUND_MS]) {
      const late = await uploadFixture(null, null, platform, { exitsAfterMs });
      const waited = Math.ceil(exitsAfterMs / 500) * 500;
      A.eq(late.calls, ['listen', 'driver.close', 'driver.close', 'server.close', 'server.connections.close'], 'late exit (' + exitsAfterMs + ' ms): one more close proves it');
      A.eq(total(late.waits), waited, 'late exit (' + exitsAfterMs + ' ms): the fixture waits until it left and no longer');
      A.eq(late.owned.calls.filter(c => c === 'kill').length, 1, 'late exit (' + exitsAfterMs + ' ms): the wait never kills again');
      A.eq(late.owned.timers, [8000, 8000], 'late exit (' + exitsAfterMs + ' ms): production keeps its own 8 s on each close');
      A.eq(late.owned.pid(), null, 'late exit (' + exitsAfterMs + ' ms): ownership ends with the proof');
      A.eq(late.owned.removed, ['/owned/profile'], 'late exit (' + exitsAfterMs + ' ms): the proof permits the owned profile cleanup');
      A.ok(scratchGone(late), 'late exit (' + exitsAfterMs + ' ms): the fixture removes its scratch');
      A.ok(late.logs.some(l => l.includes('[teardown] Chromium left ' + Math.round(waited / 1000) + ' s after driver.close gave up')), 'late exit (' + exitsAfterMs + ' ms): the step log says how long it took');
      A.ok(reported(late, late.bodyError.message), 'late exit (' + exitsAfterMs + ' ms): waiting hides no failure of the body');
    }
    const wedged = await uploadFixture(null, null, platform, { exitsAfterMs: BOUND_MS + 1 });
    A.eq(wedged.calls, ['listen', 'driver.close', 'server.close', 'server.connections.close'], 'wedged: no second close past the bound, and the server still closes');
    A.eq(total(wedged.waits), BOUND_MS, 'wedged: the fixture stops at its bound');
    A.eq(wedged.owned.calls.filter(c => c === 'kill').length, 1, 'wedged: the wait never kills again');
    A.eq(wedged.owned.pid(), 4242, 'wedged: the process is still owned');
    A.eq(wedged.owned.removed, [], 'wedged: the owned profile stays');
    A.eq(wedged.removed.filter(p => p === wedged.scratch).length, 0, 'wedged: the fixture keeps its scratch');
    A.eq(wedged.removed.filter(p => p === wedged.stagingRoot).length, 1, 'wedged: its upload staging root still goes');
    A.ok(reported(wedged, error.message), 'wedged: the step fails with production\'s error: ' + error.message);
    A.eq(wedged.simulatedProcess.exitCode, 1, 'wedged: the step stays red');
    const proxyFailed = new Error('injected proxy close failure after a stall');
    const lateProxy = await uploadFixture(null, null, platform, { exitsAfterMs: 38000, proxyError: proxyFailed });
    A.eq(lateProxy.calls, ['listen', 'driver.close', 'driver.close', 'server.close', 'server.connections.close'], 'late exit with a failed proxy: the proof still runs');
    A.eq(lateProxy.removed.filter(p => p === lateProxy.scratch).length, 0, 'late exit with a failed proxy: the scratch stays');
    A.ok(reported(lateProxy, proxyFailed.message), 'late exit with a failed proxy: that failure is what the step reports');
  }
  // a helper past the browser process keeps a file held (measured: EBUSY on the cache's sqldb0, 58 s past the browser)
  for (const busyCode of ['EBUSY', 'EPERM', 'ENOTEMPTY']) {
    const held = await uploadFixture(null, null, 'win32', { exitsAfterMs: 0, busyUntilMs: 58000, busyCode });
    A.eq(held.calls, ['listen', 'driver.close', 'server.close', 'server.connections.close'], busyCode + ', files held after a clean close: one close is enough');
    A.eq(total(held.waits), 58000, busyCode + ', files held: the removal starts over until they are let go, and no longer');
    A.ok(scratchGone(held), busyCode + ', files held: the scratch goes');
    A.ok(held.logs.some(l => l.includes('[teardown] scratch removed after 58 s: ' + busyCode + ' on ')), busyCode + ', files held: the step log says how long and what held it');
    A.ok(reported(held, held.bodyError.message), busyCode + ', files held: waiting hides no failure of the body');
  }
  const stillHeld = await uploadFixture(null, null, 'win32', { exitsAfterMs: 0, busyUntilMs: BOUND_MS + 1 });
  A.eq(total(stillHeld.waits), BOUND_MS, 'files still held: the removal stops at the bound');
  A.ok(!scratchGone(stillHeld) && reported(stillHeld, 'EBUSY'), 'files still held at the bound: the step fails with that error');
  A.eq(stillHeld.simulatedProcess.exitCode, 1, 'files still held at the bound: the step stays red');
  const otherError = await uploadFixture(null, null, 'win32', { exitsAfterMs: 0, busyUntilMs: BOUND_MS, busyCode: 'ENOTDIR' });
  A.eq(otherError.waits, [], 'any other removal error is not waited on');
  A.ok(!scratchGone(otherError) && reported(otherError, 'ENOTDIR'), 'any other removal error fails the step at once');
  const oneBound = await uploadFixture(null, null, 'win32', { exitsAfterMs: 200000, busyUntilMs: BOUND_MS });
  A.eq(oneBound.calls, ['listen', 'driver.close', 'driver.close', 'server.close', 'server.connections.close'], 'a late exit and then held files: one more close proves the exit');
  A.ok(total(oneBound.waits) === BOUND_MS && scratchGone(oneBound), 'a late exit and then held files, inside the bound: the scratch goes');
  const overBound = await uploadFixture(null, null, 'win32', { exitsAfterMs: 200000, busyUntilMs: BOUND_MS + 1 });
  A.eq(total(overBound.waits), BOUND_MS, 'the exit and the files share one bound: the wait for the exit counts against the removal');
  A.ok(!scratchGone(overBound) && reported(overBound, 'EBUSY'), 'past that one bound the held file fails the step');
  const posixHeld = await uploadFixture(null, null, 'linux', { exitsAfterMs: 0, busyUntilMs: BOUND_MS });
  A.eq(posixHeld.waits, [], 'POSIX keeps its own removal retries: this wait is the Windows branch');
  // the runner's 120 s default would cut that wait off (red runs took up to 214 s on 2026-11-01)
  const runner = await import('../scripts/run-test-list.mjs');
  A.ok(runner.readSteps(path.join(__dirname, 'slow.list')).includes('test/browser-upload.e2e.test.js'), 'browser-upload.e2e is declared slow, so the runner cannot cut its wait off');
  // browser-upload-chooser.e2e copies that teardown: the copy stays exact, it is the one in use, and it is declared slow too
  A.ok(runner.readSteps(path.join(__dirname, 'slow.list')).includes('test/browser-upload-chooser.e2e.test.js'), 'browser-upload-chooser.e2e is declared slow as well');
  const teardownOf = name => {
    const text = fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/\r\n/g, '\n');
    const from = text.indexOf('  const waitToLetGo = async () => {'), end = '    return driver.close();\n  };';
    const to = text.indexOf(end, from);
    return { text, wait: from >= 0 && to > from ? text.slice(from, to + end.length) : null };
  };
  const liveTeardown = teardownOf('browser-upload.e2e.test.js'), chooserTeardown = teardownOf('browser-upload-chooser.e2e.test.js');
  A.ok(liveTeardown.wait, 'the upload e2e still has its teardown wait');
  A.eq(chooserTeardown.wait, liveTeardown.wait, 'the chooser e2e waits out a slow Chromium the same way');
  A.ok(/await closeDriver\(\)/.test(chooserTeardown.text) && !/await driver\.close\(\); *\} *catch \(e\) \{ *closeError/.test(chooserTeardown.text), 'and its teardown closes through that wait');
  A.ok(BOUND_MS + runner.STEP_TIMEOUT_MS <= runner.SLOW_STEP_TIMEOUT_MS, 'the slow step bound holds the whole wait and a default step budget for the rest');
  A.report('browser-close-cleanup.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
