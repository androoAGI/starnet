'use strict';
/* node test/version-source.test.js — GET /api/version names a git build id whenever git can give one, and asking
   git never stalls the sidecar's event loop for long.

   THE HOLE THIS CLOSES (guardian triage, 2026-10-28): computeVersionSurface ran ONE `git describe --always --dirty
   --tags` with a 2s timeout. On a loaded machine it lost, the surface fell to the package.json '0.0.0' placeholder
   (harnessSource 'pkg'), and that answer was cached for the life of the process — so test/sidecar.http.test.js's
   "harnessSource is git in a checkout" went red with no product change. The first repair gave `--dirty` the whole
   10s budget, synchronously, and re-ran it every 60s: a hung `--dirty` still starved the fallbacks, and a slow git
   froze every request for ~10s once a minute.

   Laws (run on the real function, extracted through test/helpers/source.js, with a scripted execSync/execFile; a
   scripted TIMEOUT advances the fake clock by the timeout it was given, so a hang costs what a real one costs):
     V1 the synchronous path is bounded: every probe stays inside its own cap and the whole synchronous git work,
        rev-parse HEAD included, stays inside VERSION_SYNC_BUDGET_MS (4s, the old 2s + 2s worst case);
     V2 a HUNG --dirty still leaves time for `describe --always --tags`, then `rev-parse --short HEAD`, and
        buildDirty stays null (only --dirty can prove a clean tree);
     V3 a 'pkg' answer caused by a git TIMEOUT is re-asked in the BACKGROUND (async execFile), at once, and the cache
        becomes git when git answers; git is never run synchronously again after the first answer;
     V4 a background re-ask that times out again backs off (60s, then 5m), so a slow machine is not hammered;
     V5 a 'pkg' answer with no git at all (the packaged app) is cached for good: no re-ask, sync or async;
     V6 the happy path is unchanged: one --dirty call, harnessSource 'git', buildDirty from the suffix;
     V7 resource exhaustion at spawn (EAGAIN / ENOMEM / EMFILE / ENFILE, a RAM-starved box) is NOT final: it is
        re-asked in the background and backs off exactly like a timeout, and git wins once it answers;
     V8 git running and saying no (a non-zero exit, 128 not-a-repo) IS final, sync and async alike;
     V9 a background refresh that rejects is noted (failNote 'version.refresh') and re-asked on the backoff, never
        silently pinned to 'pkg';
     V10 buildDirty comes from the --dirty answer itself, so it survives a failed rev-parse HEAD, an env BUILD_SHA
        (which skips the sha step) and the async refresh's sha step failing. */
const vm = require('node:vm');
const path = require('node:path');
const A = require('./_assert.js');
const { locateSidecarFunction, sidecarFunctionSource, sidecarSourceFiles } = require('./helpers/source.js');

const at = locateSidecarFunction('computeVersionSurface');
A.ok(at, 'computeVersionSurface exists in the sidecar');
const fileText = sidecarSourceFiles().find(f => f.rel === at.rel).text;
const stateAt = fileText.lastIndexOf('let _versionCache', at.index);
A.ok(stateAt >= 0, 'its cache state is declared just above it');
const program = fileText.slice(stateAt, at.index) + sidecarFunctionSource('computeVersionSurface') +
  '\nthis.computeVersionSurface = computeVersionSurface; this.SYNC_BUDGET = VERSION_SYNC_BUDGET_MS;';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const TIMEOUT = Symbol('timeout'), NOGIT = Symbol('nogit'), NOTREPO = Symbol('notrepo');
const noGitErr = () => Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });
// A resource error at spawn: a code string, no exit status (the child never ran).
const RESOURCE = (code) => ({ resource: code });
const resourceErr = (code) => Object.assign(new Error('spawn git ' + code), { code, errno: -11 });
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

// script(cmd) -> a string answer, TIMEOUT (a real hang: the clock moves by the timeout given) or NOGIT (fails fast).
function load(script, clock, opts) {
  opts = opts || {};
  const notes = [];
  const sync = [], async_ = [];
  const execSync = (cmd, opts) => {
    const timeout = opts && opts.timeout;
    sync.push({ cmd, timeout, at: clock.t });
    const r = script(cmd);
    if (r === TIMEOUT) { clock.t += timeout; throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' }); }
    if (r === NOGIT) throw noGitErr();
    if (r === NOTREPO) throw Object.assign(new Error('Command failed: ' + cmd), { status: 128, signal: null });
    if (r && r.resource) throw resourceErr(r.resource);
    return Buffer.from(r + '\n');
  };
  const execFile = (file, args, opts, cb) => {
    const cmd = file + ' ' + args.join(' ');
    async_.push({ cmd, timeout: opts && opts.timeout });
    const r = script(cmd);
    setImmediate(() => {
      if (r === TIMEOUT) { clock.t += opts.timeout; return cb(Object.assign(new Error('git timed out'), { killed: true, signal: 'SIGTERM', code: null }), '', ''); }
      if (r === NOGIT) return cb(noGitErr(), '', '');
      if (r === NOTREPO) return cb(Object.assign(new Error('Command failed: ' + cmd), { code: 128, killed: false, signal: null }), '', '');
      if (r && r.resource) return cb(resourceErr(r.resource), '', '');
      cb(null, r + '\n', '');
    });
  };
  const sandbox = {
    stationChildProcess: { execSync, execFile }, path, __dirname: path.join(path.resolve(__dirname, '..'), 'sidecar'),
    ENV: (k) => String((opts.env || {})[k] || ''),
    failNote: (tag, e) => { notes.push(tag); if (opts.onNote) opts.onNote(tag, e); }, process: { version: process.version },
    require: (m) => { if (/package\.json$/.test(m)) return { version: '0.0.0' }; throw noGitErr(); },
    Date: { now: () => clock.t }
  };
  vm.createContext(sandbox);
  vm.runInContext(program, sandbox);
  return { fn: sandbox.computeVersionSurface, sync, async: async_, notes, budget: sandbox.SYNC_BUDGET, t0: clock.t };
}

// V1: checked on every scenario's synchronous calls. The worst case is every call running to its own timeout, so
// each call's deadline (when it started + the timeout it was given) must fall inside the budget from the first call.
function syncBounded(h, label) {
  const worst = Math.max(0, ...h.sync.map(c => c.at + c.timeout - h.t0));
  A.ok(h.budget > 0 && h.budget <= 4000, label + ': the sync budget is no worse than the old 2s + 2s (' + h.budget + 'ms)');
  A.ok(worst <= h.budget, label + ': all synchronous git work fits the sync budget (worst case ' + worst + 'ms of ' + h.budget + 'ms)');
  A.ok(h.sync.every(c => c.timeout > 0), label + ': every synchronous probe gets a positive timeout');
  const dirty = h.sync.find(c => /--dirty/.test(c.cmd));
  if (dirty) A.ok(dirty.timeout < h.budget, label + ': --dirty never gets the whole budget (' + dirty.timeout + 'ms)');
}

(async () => {
  // V6 + V1
  {
    const clock = { t: 1e6 };
    const h = load(cmd => cmd === 'git rev-parse HEAD' ? SHA : 'v0.9.0-4-gabc1234-dirty', clock);
    const v = h.fn();
    A.eq(v.harnessSource, 'git', 'happy path: git');
    A.eq(v.harness, 'v0.9.0-4-gabc1234-dirty', 'harness is the --dirty describe');
    A.eq(v.buildDirty, true, 'buildDirty from the -dirty suffix');
    A.eq(v.buildSha, SHA, 'buildSha from rev-parse HEAD');
    A.eq(h.sync[0].cmd, 'git describe --always --dirty --tags', 'asks --dirty first');
    A.eq(h.sync.length, 2, 'one describe + one rev-parse');
    syncBounded(h, 'happy path');
    h.fn(); await flush();
    A.eq(h.sync.length + h.async.length, 2, 'and the git answer is cached: no more git');
  }

  // V2 — --dirty HANGS (the clock moves by its whole cap)
  {
    const clock = { t: 1e6 };
    const h = load(cmd => cmd === 'git describe --always --dirty --tags' ? TIMEOUT
      : cmd === 'git rev-parse HEAD' ? SHA : 'v0.9.0-4-gabc1234', clock);
    const v = h.fn();
    A.eq(v.harnessSource, 'git', 'a hung --dirty still resolves via git');
    A.eq(v.harness, 'v0.9.0-4-gabc1234', 'from describe --always --tags');
    A.eq(h.sync[1] && h.sync[1].cmd, 'git describe --always --tags', 'the second probe ran');
    A.eq(v.buildDirty, null, 'buildDirty is unknown, not a claimed clean tree');
    syncBounded(h, 'hung --dirty');
  }
  {
    const clock = { t: 1e6 };
    const h = load(cmd => /^git describe/.test(cmd) ? TIMEOUT : cmd === 'git rev-parse --short HEAD' ? 'abc1234' : SHA, clock);
    const v = h.fn();
    A.eq(v.harness, 'abc1234', 'both describes hanging still leaves time for rev-parse --short HEAD');
    A.eq(v.harnessSource, 'git', 'still git');
    syncBounded(h, 'both describes hung');
  }
  {
    const clock = { t: 1e6 };
    const h = load(cmd => /^git describe/.test(cmd) ? NOGIT : cmd === 'git rev-parse --short HEAD' ? 'abc1234' : SHA, clock);
    A.eq(h.fn().harness, 'abc1234', 'describe failing fast falls to rev-parse --short HEAD');
  }

  // V3 — every sync probe hangs; git comes back in the background
  {
    const clock = { t: 1e6 };
    let slow = true;
    const h = load(cmd => slow ? TIMEOUT : cmd === 'git rev-parse HEAD' ? SHA : 'v1.0.0', clock);
    A.eq(h.fn().harnessSource, 'pkg', 'every git probe timing out falls to pkg');
    syncBounded(h, 'all hung');
    const nSync = h.sync.length;
    A.ok(h.async.length >= 1, 'a timeout-caused pkg is re-asked in the background at once');
    slow = false;
    await flush();
    const v = h.fn();
    A.eq(v.harnessSource, 'git', 'the background answer turns the cache into git');
    A.eq(v.harness, 'v1.0.0', 'with the real describe');
    A.eq(v.buildSha, SHA, 'and the full sha');
    clock.t += 3600000; h.fn(); await flush();
    A.eq(h.sync.length, nSync, 'git never runs synchronously after the first answer');
  }

  // V4 — the background re-ask backs off while git stays slow
  {
    const clock = { t: 1e6 };
    const h = load(() => TIMEOUT, clock);
    h.fn(); await flush();
    const nSync = h.sync.length, first = h.async.length;
    A.ok(first >= 1, 'first background re-ask ran');
    clock.t += 30000; h.fn(); await flush();
    A.eq(h.async.length, first, 'no re-ask inside the first 60s');
    clock.t += 31000; h.fn(); await flush();
    const second = h.async.length;
    A.ok(second > first, 'a re-ask after 60s');
    clock.t += 120000; h.fn(); await flush();
    A.eq(h.async.length, second, 'then it backs off: none 2 minutes later');
    clock.t += 300000; h.fn(); await flush();
    A.ok(h.async.length > second, 'and re-asks once 5 minutes have passed');
    A.eq(h.sync.length, nSync, 'none of it on the synchronous path');
  }

  // V5
  {
    const clock = { t: 1e6 };
    const h = load(() => NOGIT, clock);
    A.eq(h.fn().harnessSource, 'pkg', 'no git at all -> pkg');
    const n = h.sync.length;
    clock.t += 3600000;
    h.fn(); await flush();
    A.eq(h.sync.length, n, 'a no-git pkg answer is cached for good');
    A.eq(h.async.length, 0, 'and never re-asked in the background');
  }

  // V7 — resource exhaustion is retryable, every flavour of it, sync and async
  for (const code of ['EAGAIN', 'ENOMEM', 'EMFILE', 'ENFILE']) {
    const clock = { t: 1e6 };
    let mode = 'starved';
    const h = load(cmd => mode === 'starved' ? RESOURCE(code)
      : cmd === 'git rev-parse HEAD' ? SHA : 'v2.0.0', clock);
    A.eq(h.fn().harnessSource, 'pkg', code + ' on every sync probe falls to pkg');
    syncBounded(h, code);
    await flush();
    const first = h.async.length;
    A.ok(first >= 1, code + ' at spawn is re-asked in the background, not pinned to pkg (' + first + ' git calls)');
    clock.t += 30000; h.fn(); await flush();
    A.eq(h.async.length, first, code + ' in the background backs off: no re-ask inside 60s');
    mode = 'ok';
    clock.t += 31000; h.fn(); await flush();
    A.ok(h.async.length > first, code + ': re-asked after the backoff');
    const v = h.fn();
    A.eq(v.harnessSource, 'git', code + ': git wins once the machine recovers');
    A.eq(v.harness, 'v2.0.0', code + ': with the real describe');
  }

  // V8 — not a repository: git ran and said no. Final, sync and async.
  {
    const clock = { t: 1e6 };
    const h = load(() => NOTREPO, clock);
    A.eq(h.fn().harnessSource, 'pkg', 'not-a-repo -> pkg');
    clock.t += 3600000; h.fn(); await flush();
    A.eq(h.async.length, 0, 'a non-zero git exit is final: never re-asked');
  }
  {
    const clock = { t: 1e6 };
    let calls = 0;   // the three synchronous probes hang; every background probe gets exit 128
    const h = load(() => ++calls <= 3 ? TIMEOUT : NOTREPO, clock);
    h.fn();
    await flush();
    const n = h.async.length;
    A.ok(n >= 1, 'a timeout-caused pkg is re-asked');
    clock.t += 3600000; h.fn(); await flush();
    A.eq(h.async.length, n, 'and a background answer of exit 128 makes it final');
  }

  // V9 — the backstop notes and keeps re-asking
  {
    const clock = { t: 1e6 };
    let mode = 'slow';
    // A rejection out of refreshVersionFromGit is a bug path; drive it by making the sha step's note throw.
    const h = load(cmd => mode === 'slow' ? TIMEOUT : cmd === 'git rev-parse HEAD' ? TIMEOUT : 'v3.0.0', clock,
      { onNote: (tag) => { if (tag === 'version.refresh.sha' && mode === 'boom') throw new Error('note sink exploded'); } });
    h.fn();
    mode = 'boom';
    await flush();
    A.ok(h.notes.includes('version.refresh'), 'a rejected background refresh is NOTED, not swallowed (' + h.notes.join(',') + ')');
    const n = h.async.length;
    mode = 'ok';
    clock.t += 61000; h.fn(); await flush();
    A.ok(h.async.length > n, 'and it is re-asked on the backoff instead of pinning pkg forever');
    A.eq(h.fn().harnessSource, 'git', 'which then lands git');
  }

  // V10 — buildDirty does not depend on the sha step
  {
    const clock = { t: 1e6 };
    const h = load(cmd => cmd === 'git rev-parse HEAD' ? TIMEOUT : 'v0.9.0-4-gabc1234-dirty', clock);
    const v = h.fn();
    A.eq(v.buildSha, '', 'rev-parse HEAD hung: no sha');
    A.eq(v.buildDirty, true, 'but buildDirty still comes from the --dirty answer');
    A.ok(h.notes.includes('version.sha'), 'and the lost sha is noted, not swallowed');
    syncBounded(h, 'sha hung');
  }
  {
    const clock = { t: 1e6 };
    const h = load(cmd => cmd === 'git rev-parse HEAD' ? NOTREPO : 'v0.9.0-4-gabc1234', clock);
    A.eq(h.fn().buildDirty, false, 'rev-parse HEAD failing outright: a clean --dirty answer still proves clean');
  }
  {
    const clock = { t: 1e6 };
    const h = load(() => 'v0.9.0-4-gabc1234-dirty', clock, { env: { BUILD_SHA: SHA } });
    const v = h.fn();
    A.eq(v.buildSha, SHA, 'env BUILD_SHA is used');
    A.eq(h.sync.length, 1, 'and the sha step is skipped');
    A.eq(v.buildDirty, true, 'yet buildDirty still comes from the --dirty answer');
  }
  {
    const clock = { t: 1e6 };
    let calls = 0;   // the three synchronous probes hang; in the background --dirty answers and rev-parse HEAD hangs
    const h = load(cmd => ++calls <= 3 ? TIMEOUT : cmd === 'git rev-parse HEAD' ? TIMEOUT : 'v4.0.0-dirty', clock);
    h.fn();
    await flush();
    const v = h.fn();
    A.eq(v.harnessSource, 'git', 'async refresh landed git');
    A.eq(v.buildSha, '', 'its sha step timed out');
    A.eq(v.buildDirty, true, 'and buildDirty still comes from the background --dirty answer');
  }

  A.report('version-source.test');
})().catch(e => { console.log('FAIL: version-source.test threw -- ' + (e && e.stack || e)); process.exit(1); });
