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

async function uploadFixture(closeError, serverError) {
  const calls = [], errors = [], removed = [];
  const simulatedProcess = { exitCode: 0 };
  const bodyError = new Error('injected fixture action failure');
  const server = {
    listen(port, host, cb) { calls.push('listen'); cb(); }, address: () => ({ port: 12345 }),
    close(cb) { calls.push('server.close'); cb(serverError); }, closeAllConnections() { calls.push('server.connections.close'); }
  };
  const driver = { allowLocal() {}, async close() { calls.push('driver.close'); if (closeError) throw closeError; } };
  const scope = {
    process: simulatedProcess,
    console: { log() {}, error(...args) { errors.push(args); } },
    require(id) {
      if (id === './_assert.js') return { report() { calls.push('report'); } };
      if (id === 'node:fs') return { mkdtempSync: prefix => prefix + 'owned', mkdirSync() {}, writeFileSync() {}, rmSync(p) { removed.push(p); } };
      if (id === 'node:fs/promises') return {};
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
  return { calls, errors, removed, simulatedProcess, bodyError, scratch, stagingRoot: EgressFiles.defaultStagingRoot(path, path.join(scratch, 'workspaces')) };
}

(async () => {
  const stuck = rig({ fallback: true });
  const error = await rejection(() => stuck.close());
  A.ok(error && /owned Chromium did not exit/.test(error.message), 'unproved exit still rejects with the shutdown error');
  A.eq(stuck.calls, ['cdp.close', 'kill', 'proxy.close'], 'proxy cleanup runs after the failed owned-process wait');
  A.eq(stuck.removed, [], 'neither primary nor fallback profile is deleted on failure');
  A.eq(stuck.pid(), 4242, 'failed close retains the owned process handle');
  A.eq(stuck.timers, [8000], 'production exit timeout is unchanged (only the test scheduler is accelerated)');
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
  // the run's OWN browser takes its staged upload copies with it when it closes, in a finally: a close that rejects
  // (the stuck-Chromium path above) still releases them; the host also releases at run end (sidecar/index.js)
  A.ok(/if \(!deps\.session && session && typeof session\.close === 'function'\) \{\s*const closeSession = session\.close;\s*session\.close = async function \(\) \{ try \{ return await closeSession\.apply\(session, arguments\); \} finally \{ await releaseUploads\(\); \} \};/.test(source),
    'closing the run\'s own browser releases its staged uploads even when the close fails');
  A.ok(/const releaseUploads = \(\) => unstageAll\(Array\.from\(stagedUploads\)\);/.test(source), 'releaseUploads unstages every copy this browser was handed');

  for (const [closeFailure, serverFailure] of [[new Error('owned close failed'), null], [new Error('owned close failed'), new Error('server close failed')], [null, new Error('server close failed')], [null, null]]) {
    const r = await uploadFixture(closeFailure, serverFailure);
    A.eq(r.calls, ['listen', 'driver.close', 'server.close', 'server.connections.close'], 'fixture always closes its server and never reaches the success report after failure');
    A.eq(r.simulatedProcess.exitCode, 1, 'fixture failure remains nonzero');
    A.eq(r.removed.filter(p => p === r.scratch).length, closeFailure || serverFailure ? 0 : 1, 'cleanup failure retains scratch; confirmed cleanup permits removal');
    A.ok(/starnet-upload-staging-[0-9a-f]{16}$/.test(r.stagingRoot) && path.dirname(r.stagingRoot) === path.resolve(os.tmpdir()), 'the fixture\'s upload staging root is the station root under os.tmpdir(), outside scratch');
    A.eq(r.removed.filter(p => p === r.stagingRoot).length, 1, 'the fixture clears its own upload staging root on every exit, so no staged copy outlives it');
    A.eq(r.removed.filter(p => p !== r.scratch && p !== r.stagingRoot), [], 'the fixture removes nothing but its scratch and its own staging root');
    const terminal = r.errors[r.errors.length - 1][0];
    A.ok(String(terminal).includes((closeFailure || serverFailure || r.bodyError).message), 'fixture reports its primary failure');
    if (serverFailure && closeFailure) A.ok(r.errors[0][1] === serverFailure, 'secondary fixture cleanup failure is also visible');
  }
  A.report('browser-close-cleanup.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
