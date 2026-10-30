/* node test/version-source.test.js — WHERE the harness build id comes from, and that asking never blocks or lies.

   THE DEFECT (gate 298473720, 10-30; the same assertion on release 192dd3c6e's local http): under memory pressure
   test/sidecar.http.test.js read harnessSource 'pkg' in a git checkout. computeVersionSurface ran
   `git describe --always --dirty --tags` once, through execSync with a 2 s timeout, inside an empty catch: --dirty
   refreshes the index over ~48k files (1.6 s on this box with a gate running), so a loaded box timed out, the
   timeout read as "no git", the 0.0.0 package placeholder came back as harnessSource 'pkg', and the surface cached
   that for the life of the process. Nothing said why.

   The laws this locks (sidecar/version-source.js and its wiring in sidecar/index.js):
     V1 an env stamp (STARNET_BUILD_DESCRIBE) wins, and no git runs;
     V2 no <repo>/.git at all (a packaged app) is 'pkg' at once, and no git runs;
     V3 a .git FILE (a worktree's gitfile) is a checkout, like a .git directory;
     V4 in a checkout a failed git attempt (timed out, exit 128, could not start) is never final: it is noted and
        retried with backoff, and a later success reads 'git' with the describe string and HEAD;
     V5 a checkout whose git keeps failing never reads 'pkg': it reads 'unknown', stays bounded (attempts and time),
        says so in a note, is not cached, and asks git again after the cool-down;
     V6 asking never blocks: read() is synchronous over state, git runs through async execFile (no shell), and the
        bounded settled() wait answers with the honest interim value while git is still running;
     V7 the composed /api/version surface (computeVersionSurface sliced from the sidecar) holds V4-V6 and keeps the
        BUILD_SHA / BUILD_DIRTY env stamps exactly as before. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const { sidecarTopLevelFunction } = require('./helpers/source.js');

const REPO = path.join(os.tmpdir(), 'version-source-fake-repo');
const DESC = 'v0.14.2-3-gabc1234-dirty';
const SHA = 'abc1234'.padEnd(40, '0');
const SOURCES = ['env', 'git', 'pkg', 'unknown'];   // the documented harnessSource set; nothing new is added

let VS = null, loadError = '';
try { VS = require('../sidecar/version-source.js'); } catch (e) { loadError = (e && e.message) || String(e); }

// one fake world per scenario: a virtual clock, a scripted git, a recording note
function world(opts) {
  opts = opts || {};
  const w = { t: 1000, calls: [], notes: [], sleeps: [], script: { describe: (opts.describe || []).slice(), 'rev-parse': (opts.revParse || []).slice() } };
  w.now = () => w.t;
  w.sleep = (ms) => { w.sleeps.push(ms); w.t += ms; return new Promise(r => setImmediate(r)); };
  w.note = (tag, err) => { w.notes.push({ tag, message: String((err && err.message) || err) }); };
  w.execFile = (file, args, o, cb) => {
    const step = args[0];
    w.calls.push({ file, args: args.slice(), opts: Object.assign({}, o) });
    const list = w.script[step] || [];
    const out = list.length > 1 ? list.shift() : (list[0] || { exit: 1, stderr: 'unscripted' });
    if (out.spawnThrow) throw Object.assign(new Error('spawn git ENOMEM'), { code: 'ENOMEM' });
    if (out.hang) return { pid: 1 };
    setImmediate(() => {
      if (out.timeout) { w.t += o.timeout; return cb(Object.assign(new Error('Command failed: git ' + args.join(' ')), { killed: true, signal: 'SIGTERM', code: null }), '', ''); }
      if (out.exit != null) return cb(Object.assign(new Error('Command failed: git ' + args.join(' ')), { code: out.exit }), '', out.stderr || '');
      cb(null, out.stdout, '');
    });
    return { pid: 1 };
  };
  w.exists = opts.exists || ((p) => p === path.join(REPO, '.git'));
  w.deps = Object.assign({
    repoRoot: REPO, join: path.join, exists: (p) => w.exists(p), execFile: w.execFile,
    envDescribe: () => opts.env || '', pkgVersion: () => '0.0.0',
    now: w.now, sleep: w.sleep, note: w.note
  }, opts.deps || {});
  w.src = VS ? VS.makeVersionSource(w.deps, Object.assign({ attemptTimeoutMs: 12000, backoffMs: [500, 1000, 2000], maxAttempts: 5, budgetMs: 60000, retryAfterMs: 300000, settleMs: 10000 }, opts.config || {})) : null;
  return w;
}
const ok = (stdout) => ({ stdout: stdout + '\n' });
const TIMEOUT = { timeout: true };
const DIE = { exit: 128, stderr: 'fatal: Out of memory, malloc failed (tried to allocate 1048576 bytes)\n' };

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

// ---- V1 env stamp wins ----
scenario('V1 env stamp wins and no git runs', async () => {
  const w = world({ env: '  v0.14.2-release  ', describe: [ok(DESC)] });
  const r = w.src.read();
  A.eq([r.harness, r.harnessSource, r.final], ['v0.14.2-release', 'env', true], 'V1 STARNET_BUILD_DESCRIBE wins (trimmed), final');
  A.eq(w.calls.length, 0, 'V1 an env stamp spawns no git');
});

// ---- V2 no .git: a packaged app ----
scenario('V2 no .git is pkg at once', async () => {
  const w = world({ exists: () => false, describe: [ok(DESC)] });
  const r = w.src.read();
  A.eq([r.harness, r.harnessSource, r.final], ['0.0.0', 'pkg', true], 'V2 no <repo>/.git -> the package.json version, harnessSource pkg, final');
  await w.src.settled();
  A.eq(w.calls.length, 0, 'V2 no .git spawns no git, not even after settled()');
  const bad = world({ exists: () => false, deps: { pkgVersion: () => { throw new Error('no package.json'); } } });
  const rb = bad.src.read();
  A.eq([rb.harness, rb.harnessSource], ['', 'unknown'], 'V2 an unreadable package.json reads unknown, never a made-up version');
  A.ok(bad.notes.some(n => n.tag === 'version.pkg'), 'V2 the unreadable package.json is noted (version.pkg)');
});

// ---- V3 a .git FILE (worktree) and a .git directory are both checkouts, on the real fs ----
scenario('V3 a gitfile worktree is a checkout', async () => {
  const roots = [];
  try {
    for (const kind of ['file', 'dir', 'none']) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'version-source-' + kind + '-'));
      roots.push(root);
      if (kind === 'file') fs.writeFileSync(path.join(root, '.git'), 'gitdir: ../main/.git/worktrees/lane\n');
      if (kind === 'dir') fs.mkdirSync(path.join(root, '.git'));
      const w = world({ describe: [ok(DESC)], revParse: [ok(SHA)], deps: { repoRoot: root, exists: fs.existsSync } });
      const r = w.src.read();
      if (kind === 'none') {
        A.eq([r.harnessSource, w.calls.length], ['pkg', 0], 'V3 a work tree with no .git is pkg and spawns no git');
        continue;
      }
      A.eq([r.harnessSource, r.final], ['unknown', false], 'V3 a .git ' + kind + ' is a checkout: git is asked, the interim is unknown (never pkg)');
      await w.src.idle();
      const g = w.src.read();
      A.eq([g.harness, g.harnessSource, g.head, g.final], [DESC, 'git', SHA, true], 'V3 a .git ' + kind + ' resolves through git describe');
      A.eq(w.calls[0] && w.calls[0].opts.cwd, root, 'V3 git runs in the repo root');
    }
  } finally {
    for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch (e) { console.log('cleanup ' + r + ': ' + e.message); } }
  }
  const odd = world({ exists: () => { throw new Error('EPERM stat'); }, describe: [ok(DESC)], revParse: [ok(SHA)] });
  const r = odd.src.read();
  A.ok(r.harnessSource !== 'pkg' && odd.calls.length === 1, 'V3 a .git check that throws is treated as a checkout (git is asked), never as pkg');
  A.ok(odd.notes.some(n => n.tag === 'version.checkout'), 'V3 the failed .git check is noted (version.checkout)');
});

// ---- V4 a failed attempt is retried ----
scenario('V4 first describe times out, the retry answers', async () => {
  const w = world({ describe: [TIMEOUT, ok(DESC)], revParse: [ok(SHA)] });
  const r0 = w.src.read();
  A.eq([r0.harness, r0.harnessSource, r0.final], ['', 'unknown', false], 'V4 while git runs the interim is harness "" + unknown, not final');
  await w.src.idle();
  const r = w.src.read();
  A.eq([r.harness, r.harnessSource, r.head, r.final], [DESC, 'git', SHA, true], 'V4 a timed-out first attempt is retried: git + the describe string + HEAD');
  const describes = w.calls.filter(c => c.args[0] === 'describe');
  A.eq(describes.length, 2, 'V4 exactly one retry after the timeout');
  A.eq(describes[0].args, ['describe', '--always', '--dirty', '--tags'], 'V4 the same describe as before');
  A.eq(describes[0].file, 'git', 'V4 git is run directly (execFile), not through a shell string');
  A.ok(!describes[0].opts.shell, 'V4 no shell');
  A.ok(describes[0].opts.timeout > 2000 && describes[0].opts.timeout <= 12000, 'V4 each attempt has a bounded timeout, more generous than the 2 s that timed out (' + describes[0].opts.timeout + ')');
  A.ok(w.sleeps.length >= 1 && w.sleeps[0] === 500, 'V4 the retry waits the first backoff step');
  const n = w.notes.find(x => x.tag === 'version.git.attempt');
  A.ok(n && /timed out after 12000 ms/.test(n.message) && /attempt 1/.test(n.message), 'V4 the timeout is noted with its attempt and measured cause: ' + (n && n.message));
  A.ok(!w.notes.some(x => x.tag === 'version.git.exhausted'), 'V4 a recovered resolution is not reported as exhausted');
});

scenario('V4 exit 128 and a spawn throw are retried too', async () => {
  const w = world({ describe: [DIE, { spawnThrow: true }, ok(DESC)], revParse: [DIE, ok(SHA)] });
  w.src.read();
  await w.src.idle();
  const r = w.src.read();
  A.eq([r.harness, r.harnessSource, r.head], [DESC, 'git', SHA], 'V4 exit 128 (git die, incl. out of memory) and a spawn throw are retried to git');
  const msgs = w.notes.filter(x => x.tag === 'version.git.attempt').map(x => x.message);
  A.ok(msgs.some(m => /exit 128/.test(m) && /Out of memory/.test(m)), 'V4 the exit code and the first stderr line are noted');
  A.ok(msgs.some(m => /ENOMEM/.test(m)), 'V4 a spawn that throws is noted with its code');
  A.ok(msgs.some(m => /rev-parse/.test(m)), 'V4 a failed rev-parse HEAD is retried and noted too');
});

// ---- V5 git keeps failing ----
scenario('V5 git keeps failing: unknown, bounded, noted, asked again later', async () => {
  const w = world({ describe: [DIE] });
  w.src.read();
  const t0 = w.t;
  await w.src.idle();
  const r = w.src.read();
  A.eq([r.harness, r.harnessSource, r.final], ['', 'unknown', false], 'V5 a checkout whose git keeps failing reads unknown, never a plain pkg, and is not final');
  const attempts = w.calls.filter(c => c.args[0] === 'describe').length;
  A.ok(attempts >= 2 && attempts <= 5, 'V5 bounded retries: ' + attempts + ' attempts (max 5)');
  A.ok(w.t - t0 <= 60000, 'V5 bounded time: ' + (w.t - t0) + ' ms of a 60000 ms budget');
  A.eq(w.notes.filter(x => x.tag === 'version.git.attempt').length, attempts, 'V5 every failed attempt is noted');
  const ex = w.notes.filter(x => x.tag === 'version.git.exhausted');
  A.eq(ex.length, 1, 'V5 the exhausted budget is noted once');
  A.ok(ex[0] && /exit 128/.test(ex[0].message) && /unknown/.test(ex[0].message), 'V5 the exhausted note names the last cause and the answer given: ' + (ex[0] && ex[0].message));
  w.src.read(); w.src.read();
  A.eq(w.calls.filter(c => c.args[0] === 'describe').length, attempts, 'V5 inside the cool-down a read does not respawn git');
  w.t += 300000;
  w.script.describe = [ok(DESC)]; w.script['rev-parse'] = [ok(SHA)];
  const again = w.src.read();
  A.eq([again.harnessSource, again.final], ['unknown', false], 'V5 after the cool-down a read asks git again (still unknown meanwhile)');
  await w.src.idle();
  const healed = w.src.read();
  A.eq([healed.harness, healed.harnessSource, healed.final], [DESC, 'git', true], 'V5 the failed answer was never cached: once git answers the source is git');
});

// ---- V6 never blocks ----
scenario('V6 settled() is bounded while git hangs, and resolves early when git answers', async () => {
  const w = world({ describe: [{ hang: true }] });
  const r = w.src.read();
  A.eq(r.harnessSource, 'unknown', 'V6 read() returns at once while git is running');
  let guard;
  const hung = new Promise(res => { guard = setTimeout(() => res('HUNG'), 3000); });
  const got = await Promise.race([w.src.settled(5000), hung]);
  clearTimeout(guard);
  A.ok(got !== 'HUNG' && got && got.harnessSource === 'unknown' && got.final === false, 'V6 settled(5000) answers the honest interim while git hangs (no hang)');
  A.ok(w.sleeps.indexOf(5000) >= 0, 'V6 the wait is the bound it was given');
  const dflt = world({ describe: [{ hang: true }] });
  dflt.src.read(); await dflt.src.settled();
  A.ok(dflt.sleeps.indexOf(10000) >= 0, 'V6 settled() with no argument waits the configured settleMs');
  const quick = world({ describe: [ok(DESC)], revParse: [ok(SHA)], deps: { sleep: () => new Promise(() => {}) } });
  const q = await quick.src.settled(10000);
  A.eq([q.harnessSource, q.harness], ['git', DESC], 'V6 settled() returns as soon as git answers, not at the bound');
  const resolved = await world({ env: 'v1' }).src.settled(10000);
  A.eq(resolved.harnessSource, 'env', 'V6 settled() on a final answer returns it');
  A.ok(VS.DEFAULTS && VS.DEFAULTS.attemptTimeoutMs > 2000 && VS.DEFAULTS.budgetMs >= VS.DEFAULTS.attemptTimeoutMs && VS.DEFAULTS.settleMs > 0 && VS.DEFAULTS.maxAttempts >= 2,
    'V6 the shipped defaults: a generous attempt timeout inside a bounded budget, a bounded settle wait');
  const modText = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'version-source.js'), 'utf8');
  A.ok(!/\b(execSync|execFileSync|spawnSync)\b/.test(modText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'V6 version-source.js never runs a synchronous child process');
  for (const v of [r, got, q, resolved]) A.ok(SOURCES.indexOf(v.harnessSource) >= 0, 'V6 harnessSource stays in the documented set: ' + v.harnessSource);
});

// ---- V7 the composed surface, sliced from the sidecar ----
function composed(opts) {
  opts = opts || {};
  const src = sidecarTopLevelFunction('computeVersionSurface');
  const sync = [];
  const w = world({ describe: opts.describe || [TIMEOUT, ok(DESC)], revParse: [ok(SHA)], env: opts.env });
  let describeCalls = 0;
  const syncFake = (cmd) => {
    sync.push(String(cmd));
    if (/describe/.test(cmd)) { describeCalls++; if (describeCalls === 1 && !opts.env) throw Object.assign(new Error('spawnSync C:\\Windows\\system32\\cmd.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }); return DESC + '\n'; }
    if (/rev-parse/.test(cmd)) return SHA + '\n';
    return '';
  };
  const env = Object.assign({ APP_VERSION: '9.9.9-test', BUILD_DESCRIBE: opts.env || '' }, opts.envExtra || {});
  const deps = {
    versionSource: w.src,
    stationChildProcess: { execSync: syncFake, execFileSync: (f, a) => syncFake(f + ' ' + (a || []).join(' ')), spawnSync: (f, a) => { sync.push(f + ' ' + (a || []).join(' ')); return { status: 1 }; }, execFile: w.execFile },
    ENV: (k) => env[k],
    path, __dirname: path.join(REPO, 'sidecar'),
    require: (p) => { if (/package\.json$/.test(p)) return { version: '0.0.0' }; if (/tauri\.conf\.json$/.test(p)) return { version: '9.9.9-conf' }; throw new Error('unexpected require ' + p); },
    process: { version: 'v22.0.0', env: {} }
  };
  const fn = new Function(...Object.keys(deps), 'let _versionCache = null;\n' + src + '\nreturn computeVersionSurface;')(...Object.values(deps));
  return { fn, w, sync };
}
scenario('V7 composed: a timed-out first describe still ends at git, without blocking', async () => {
  const c = composed();
  A.ok(/function computeVersionSurface\(\)/.test(sidecarTopLevelFunction('computeVersionSurface')), 'V7 computeVersionSurface is a top-level sidecar function');
  const first = c.fn();
  A.ok(first.harnessSource !== 'pkg', 'V7 the interim surface in a checkout is never pkg (got ' + first.harnessSource + ')');
  if (c.w.src) await c.w.src.idle();
  const s = c.fn();
  A.eq(s.harnessSource, 'git', 'V7 /api/version: a checkout whose first git describe timed out reports git once a retry answers (not a cached pkg)');
  A.eq([s.harness, s.buildSha, s.buildDirty], [DESC, SHA, true], 'V7 the describe string, HEAD and its -dirty flag reach the surface');
  A.eq(c.sync, [], 'V7 computeVersionSurface runs no synchronous child process (the event loop stays free)');
  A.ok(c.fn() === c.fn(), 'V7 a resolved surface is cached');
  const e = composed({ env: 'v0.14.2-env', envExtra: { BUILD_SHA: 'F'.repeat(40), BUILD_DIRTY: '0' } });
  const se = e.fn();
  A.eq([se.harness, se.harnessSource, se.buildSha, se.buildDirty, se.app, se.appSource], ['v0.14.2-env', 'env', 'f'.repeat(40), false, '9.9.9-test', 'env'],
    'V7 env stamps (BUILD_DESCRIBE, BUILD_SHA, BUILD_DIRTY, APP_VERSION) read exactly as before');
  A.eq(e.w.calls.length + e.sync.length, 0, 'V7 an env-stamped build runs no git');
  const g = composed({ describe: [ok(DESC)], envExtra: { BUILD_SHA: 'E'.repeat(40), BUILD_DIRTY: '0' } });
  g.fn(); if (g.w.src) await g.w.src.idle();
  const sg = g.fn();
  A.eq([sg.harnessSource, sg.buildSha, sg.buildDirty], ['git', 'e'.repeat(40), false], 'V7 an env BUILD_SHA still wins over git HEAD, with its BUILD_DIRTY');
});

scenario('V7 wiring: /api/version and a run wait (bounded) instead of blocking', async () => {
  const hv = sidecarTopLevelFunction('handleVersion');
  A.ok(/^async function handleVersion\(/.test(hv) && /await versionSource\.settled\(\)/.test(hv), 'V7 handleVersion awaits versionSource.settled() (bounded) before it answers');
  const run = sidecarTopLevelFunction('runOnceCore');
  const wait = run.indexOf('await versionSource.settled()');
  const use = run.indexOf('const runtimeVersion = computeVersionSurface()');
  A.ok(wait > 0 && use > wait && use - wait < 400, 'V7 a run waits for a still-running git describe before it writes the [RUNTIME] build line');
  A.ok(!/execSync\(\s*'git/.test(sidecarTopLevelFunction('computeVersionSurface')), 'V7 computeVersionSurface no longer shells out to git');
});

(async () => {
  if (!VS) A.ok(false, 'sidecar/version-source.js loads — ' + loadError);
  for (const s of scenarios) {
    const before = A.fails();
    const needsModule = !/^V7/.test(s.name);
    if (needsModule && !VS) { A.ok(false, s.name + ' — not run: sidecar/version-source.js is missing'); continue; }
    try { await s.fn(); }
    catch (e) { A.ok(false, s.name + ' threw: ' + ((e && e.stack) || e)); }
    if (A.fails() > before) console.log('  (in scenario: ' + s.name + ')');
  }
  A.report('version-source');
})();
