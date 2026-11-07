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
     V3 a .git FILE (a worktree's gitfile) is a checkout, like a .git directory; only a probe that says ABSENT
        (ENOENT, ENOTDIR) is no checkout, any other probe error (EACCES, EPERM, EBUSY, a real ERR_INVALID_ARG_VALUE,
        one with no code) is a checkout, noted;
     V4 in a checkout a failed git attempt (timed out, exit 128, could not start, exit 0 printing nothing) is never
        final: it is noted and retried with backoff, and a later success reads 'git' with the describe string;
     V5 a checkout whose git keeps failing never reads 'pkg': it reads 'unknown', stays bounded (attempts and time:
        an attempt starts only while minAttemptMs of the budget is left, checked when it would START), says so in a
        note, is not cached, and asks git again after the cool-down;
     V6 HEAD is supplementary (Codex VD99-01): a describe answer is published at once, rev-parse never runs under a
        valid env BUILD_SHA, an exhausted rev-parse reads unknown (not final) and is asked again after the cool-down;
     V8 asking never blocks: read() is synchronous over state, git runs through async execFile (no shell), and a
        caller waits only for the boot's FIRST describe attempt, bounded (apiWaitMs for /api/version, half the CLI
        attach probe's timeout), never after a failure, a retry or an exhausted budget;
     V13 a run never waits (VD-HANDOVER-01, a diagnostic never holds a run): runOnceCore takes no wait on the version
        source before its [RUNTIME] block, which names runtimeHarness() read at once: the build once it is known,
        RESOLVING while a checkout's git is still being asked (the first attempt or a retry), '' (unknown) when
        nothing is known. Gate 10-31: the run wait (up to 1 s for the first describe attempt) made every run that
        started at boot late, and test/desktop-endpoint-handover.e2e failed its launch catch-up steps every time;
     V14 the checkout's git never takes .git/index.lock (VD-LOCK-01): an attempt is `git describe --always --tags`,
        never --dirty (it creates index.lock on every run, GIT_OPTIONAL_LOCKS or not, and a forced kill while it
        holds it leaves the checkout locked), then `git --no-optional-locks status --porcelain --untracked-files=no`
        for the -dirty mark; a status failure fails the attempt (noted, retried, never published unmarked), and a
        stop() during the status ends the resolution, bounded. With real git, in a scratch repo, the index is never
        written and no index.lock appears (witnessed by a watcher on .git that sees describe --dirty's own lock in
        each state: no watcher, no such claim), and the build reads what describe --dirty reads: stat-only clean,
        an edit or a staged change dirty, untracked files ignored;
     V9 shutdown reaps the git child in flight (a real child process dies) and starts nothing more;
     V10 a failure note never carries a fragment of a known secret (Codex VD99-03): redaction runs over the whole
        raw text before it is cut, through the real failopen.note + context.redact seam;
     V11 the git child's kill matches its launch (Codex VD4CE-01, makeOwnedGit): POSIX launches git detached and
        kills the group of that leader (-pid, SIGTERM), falling back to git alone only when the group cannot be
        signalled; win32 never detaches, runs windowsHide and kills with taskkill /pid <pid> /T /F; the attempt
        timeout takes the same kill; a real launched child and its grandchild both die at stop();
     V12 a shutdown waits for its kill to land (final review 1 of f884cced3): kill() returns a settle that never
        rejects (win32: when taskkill answers, which stays referenced until then; POSIX: at once), stop() returns it
        (once), and gracefulShutdown exits only after it, inside afterBrowser's 2500 ms bound. A real child station
        that stops and exits the way gracefulShutdown does leaves no git child or grandchild running: before the
        settle it exited at once, which ended its own taskkill, and the win32 grandchild lived on;
     V15 spawnExecFile, the launch POSIX git really takes: execFile's answer on spawn, and a detached child that leads a group;
     V7 the composed /api/version surface (computeVersionSurface sliced from the sidecar) holds V4-V6 and keeps the
        BUILD_SHA / BUILD_DIRTY env stamps exactly as before; the sidecar wires the stat probe, the redactor, the
        owned git launch and kill (makeOwnedGit), the boot kick and the shutdown stop. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const A = require('./_assert.js');
const { sidecarTopLevelFunction, readSidecarIndex } = require('./helpers/source.js');

const REPO = path.join(os.tmpdir(), 'version-source-fake-repo');
const DESC = 'v0.14.2-3-gabc1234-dirty';
const SHA = 'abc1234'.padEnd(40, '0');
const SOURCES = ['env', 'git', 'pkg', 'unknown'];   // the documented harnessSource set; nothing new is added

let VS = null, loadError = '';
try { VS = require('../sidecar/version-source.js'); } catch (e) { loadError = (e && e.message) || String(e); }

const enoent = () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
const tick = () => new Promise(r => setImmediate(r));
async function until(pred, n) { for (let i = 0; i < (n || 400); i++) { if (pred()) return true; await tick(); } return !!pred(); }
// a wait that could hang is bounded in real time, so a hang is a reported failure, not a drained event loop
async function within(p, ms) { let t; const hung = new Promise(r => { t = setTimeout(() => r('HUNG'), ms || 5000); }); try { return await Promise.race([p, hung]); } finally { clearTimeout(t); } }

// one fake world per scenario: a virtual clock, a scripted git, a recording note
function world(opts) {
  opts = opts || {};
  // the dirty check (git status) prints nothing unless scripted: a clean tree
  const w = { t: 1000, calls: [], notes: [], sleeps: [], kills: [], script: { describe: (opts.describe || []).slice(), status: (opts.status || [{ stdout: '' }]).slice(), 'rev-parse': (opts.revParse || []).slice() } };
  w.now = () => w.t;
  w.sleep = (ms) => { w.sleeps.push(ms); w.t += ms; return new Promise(r => setImmediate(r)); };
  w.note = (tag, err) => { w.notes.push({ tag, message: String((err && err.message) || err) }); };
  w.execFile = (file, args, o, cb) => {
    const step = args.find(a => !/^-/.test(a)) || args[0];   // the git command after any global option
    w.calls.push({ file, args: args.slice(), opts: Object.assign({}, o) });
    const list = w.script[step] || [];
    const out = list.length > 1 ? list.shift() : (list[0] || { exit: 1, stderr: 'unscripted' });
    if (out.spawnThrow) throw Object.assign(new Error(out.message || 'spawn git ENOMEM'), { code: out.code || 'ENOMEM' });
    let done = false;
    const finish = (e, so, se) => { if (done) return; done = true; cb(e, so, se); };
    const killedErr = () => Object.assign(new Error('Command failed: git ' + args.join(' ')), { killed: true, signal: 'SIGTERM', code: null });
    const proc = { pid: 4000 + w.calls.length, kill: () => { w.kills.push(proc.pid); setImmediate(() => finish(killedErr(), '', '')); return true; } };
    if (out.hang) return proc;
    setImmediate(() => {
      if (out.advance) w.t += out.advance;   // a git run that took this long on the virtual clock
      if (out.timeout) { w.t += o.timeout; return finish(killedErr(), '', ''); }
      if (out.rawError) return finish(new Error(out.rawError), '', '');   // no code, no signal: the generic branch
      if (out.overflow) return finish(Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), out.stdout || '', '');
      if (out.exit != null) return finish(Object.assign(new Error('Command failed: git ' + args.join(' ') + '\n' + (out.stderr || '')), { code: out.exit }), '', out.stderr || '');
      finish(null, out.stdout, '');
    });
    return proc;
  };
  w.exists = opts.exists || ((p) => p === path.join(REPO, '.git'));
  w.deps = Object.assign({
    repoRoot: REPO, join: path.join, stat: (p) => { if (!w.exists(p)) throw enoent(); return {}; }, execFile: w.execFile,
    envDescribe: () => opts.env || '', envSha: () => opts.envSha || '', pkgVersion: () => '0.0.0',
    now: w.now, sleep: w.sleep, note: w.note, redact: (s) => s
  }, opts.deps || {});
  w.src = VS ? VS.makeVersionSource(w.deps, Object.assign({ attemptTimeoutMs: 12000, backoffMs: [500, 1000, 2000], maxAttempts: 5, budgetMs: 60000, retryAfterMs: 300000 }, opts.config || {})) : null;
  return w;
}
const ok = (stdout) => ({ stdout: stdout + '\n' });
const TIMEOUT = { timeout: true };
const HANG = { hang: true };
const DIE = { exit: 128, stderr: 'fatal: Out of memory, malloc failed (tried to allocate 1048576 bytes)\n' };
const steps = (w, step) => w.calls.filter(c => (c.args.find(a => !/^-/.test(a)) || c.args[0]) === step);

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
  A.ok(!w.notes.some(n => n.tag === 'version.checkout'), 'V2 an absent .git (ENOENT) is not a failure to note');
  const bad = world({ exists: () => false, deps: { pkgVersion: () => { throw new Error('no package.json'); } } });
  const rb = bad.src.read();
  A.eq([rb.harness, rb.harnessSource], ['', 'unknown'], 'V2 an unreadable package.json reads unknown, never a made-up version');
  A.ok(bad.notes.some(n => n.tag === 'version.pkg'), 'V2 the unreadable package.json is noted (version.pkg)');
});

// ---- V3 a .git FILE (worktree) and a .git directory are both checkouts, on the real fs; probe ambiguity ----
scenario('V3 a gitfile worktree is a checkout; only ENOENT/ENOTDIR mean no checkout', async () => {
  const roots = [];
  try {
    for (const kind of ['file', 'dir', 'none']) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'version-source-' + kind + '-'));
      roots.push(root);
      if (kind === 'file') fs.writeFileSync(path.join(root, '.git'), 'gitdir: ../main/.git/worktrees/lane\n');
      if (kind === 'dir') fs.mkdirSync(path.join(root, '.git'));
      const w = world({ describe: [ok(DESC)], revParse: [ok(SHA)], deps: { repoRoot: root, stat: fs.statSync } });
      const r = w.src.read();
      if (kind === 'none') {
        A.eq([r.harnessSource, w.calls.length], ['pkg', 0], 'V3 a work tree with no .git (real fs.statSync ENOENT) is pkg and spawns no git');
        A.ok(!w.notes.some(n => n.tag === 'version.checkout'), 'V3 a real ENOENT is not noted');
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
  // the probe distinguishes ABSENT from CANNOT TELL (the old fs.existsSync answered false to both)
  for (const code of ['EACCES', 'EPERM', 'EBUSY', undefined]) {
    const odd = world({ describe: [ok(DESC)], revParse: [ok(SHA)], deps: { stat: () => { throw Object.assign(new Error((code || 'unknown') + ' stat .git'), code ? { code } : {}); } } });
    const r = odd.src.read();
    A.ok(r.harnessSource !== 'pkg' && odd.calls.length === 1, 'V3 a .git probe failing ' + (code || 'with no code') + ' is a checkout (git is asked), never pkg');
    A.ok(odd.notes.some(n => n.tag === 'version.checkout'), 'V3 the ambiguous ' + (code || 'code-less') + ' probe is noted (version.checkout)');
  }
  const notDir = world({ deps: { stat: () => { throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' }); } } });
  A.eq([notDir.src.read().harnessSource, notDir.calls.length], ['pkg', 0], 'V3 ENOTDIR (the root is not a directory) is absent: pkg, no git');
  // a REAL non-ENOENT error from the real fs: existsSync hides it as false, statSync throws ERR_INVALID_ARG_VALUE
  const badRoot = path.join(os.tmpdir(), 'version-source-bad\u0000root');
  A.eq(fs.existsSync(path.join(badRoot, '.git')), false, 'V3 (premise) fs.existsSync never throws: it reads a real probe error as absent');
  const real = world({ describe: [ok(DESC)], revParse: [ok(SHA)], deps: { repoRoot: badRoot, stat: fs.statSync } });
  const rr = real.src.read();
  A.ok(rr.harnessSource !== 'pkg' && real.calls.length === 1, 'V3 a real fs.statSync error that is not ENOENT is a checkout, never pkg');
  const rn = real.notes.find(n => n.tag === 'version.checkout');
  A.ok(rn && /ERR_INVALID_ARG|null bytes|must be a string/i.test(rn.message), 'V3 the real probe error is noted: ' + (rn && rn.message));
  const comp = readSidecarIndex();   // index.js's own composition of the version source (pinned here on purpose)
  const at = comp.indexOf("require('./version-source.js').makeVersionSource(");
  const block = at >= 0 ? comp.slice(at, comp.indexOf('\n});', at)) : '';
  A.ok(/stat:\s*\(p\)\s*=>\s*fs\.statSync\(p\)/.test(block) && !/existsSync/.test(block), 'V3 the sidecar injects fs.statSync as the .git probe, not fs.existsSync (which never throws)');
});

// ---- V4 a failed attempt is retried ----
scenario('V4 first describe times out, the retry answers', async () => {
  const w = world({ describe: [TIMEOUT, ok(DESC)], revParse: [ok(SHA)] });
  const r0 = w.src.read();
  A.eq([r0.harness, r0.harnessSource, r0.final], ['', 'unknown', false], 'V4 while git runs the interim is harness "" + unknown, not final');
  await w.src.idle();
  const r = w.src.read();
  A.eq([r.harness, r.harnessSource, r.head, r.final], [DESC, 'git', SHA, true], 'V4 a timed-out first attempt is retried: git + the describe string + HEAD');
  const describes = steps(w, 'describe');
  A.eq(describes.length, 2, 'V4 exactly one retry after the timeout');
  A.eq(describes[0].args, ['describe', '--always', '--tags'], 'V4 describe names the build (its -dirty mark comes from a lock-free status, V14)');
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

scenario('V4 git exits 0 but prints nothing: a failure, retried, noted', async () => {
  const w = world({ describe: [{ stdout: '' }, { stdout: '  \r\n  ' }, ok(DESC)], revParse: [ok(SHA)] });
  w.src.read();
  await w.src.idle();
  const r = w.src.read();
  A.eq([r.harness, r.harnessSource, r.final], [DESC, 'git', true], 'V4 an empty (or whitespace-only) describe is never the answer: the retry gives the describe string');
  A.eq(steps(w, 'describe').length, 3, 'V4 each empty output is retried');
  const msgs = w.notes.filter(x => x.tag === 'version.git.attempt').map(x => x.message);
  A.eq(msgs.length, 2, 'V4 both empty outputs are noted');
  A.ok(msgs.every(m => /printed nothing/.test(m)), 'V4 the note says git printed nothing: ' + msgs.join(' | '));
  const never = world({ describe: [{ stdout: '' }] });
  never.src.read(); await never.src.idle();
  const rn = never.src.read();
  A.eq([rn.harness, rn.harnessSource, rn.final], ['', 'unknown', false], 'V4 a git that only ever prints nothing reads unknown, never git with a blank harness');
});

// ---- V5 git keeps failing ----
scenario('V5 git keeps failing: unknown, bounded, noted, asked again later', async () => {
  const w = world({ describe: [DIE] });
  w.src.read();
  const t0 = w.t;
  await w.src.idle();
  const r = w.src.read();
  A.eq([r.harness, r.harnessSource, r.final], ['', 'unknown', false], 'V5 a checkout whose git keeps failing reads unknown, never a plain pkg, and is not final');
  const attempts = steps(w, 'describe').length;
  A.ok(attempts >= 2 && attempts <= 5, 'V5 bounded retries: ' + attempts + ' attempts (max 5)');
  A.ok(w.t - t0 <= 60000, 'V5 bounded time: ' + (w.t - t0) + ' ms of a 60000 ms budget');
  A.eq(w.notes.filter(x => x.tag === 'version.git.attempt').length, attempts, 'V5 every failed attempt is noted');
  const ex = w.notes.filter(x => x.tag === 'version.git.exhausted');
  A.eq(ex.length, 1, 'V5 the exhausted budget is noted once');
  A.ok(ex[0] && /exit 128/.test(ex[0].message) && /unknown/.test(ex[0].message), 'V5 the exhausted note names the last cause and the answer given: ' + (ex[0] && ex[0].message));
  w.src.read(); w.src.read();
  A.eq(steps(w, 'describe').length, attempts, 'V5 inside the cool-down a read does not respawn git');
  w.t += 300000;
  w.script.describe = [ok(DESC)]; w.script['rev-parse'] = [ok(SHA)];
  const again = w.src.read();
  A.eq([again.harnessSource, again.final], ['unknown', false], 'V5 after the cool-down a read asks git again (still unknown meanwhile)');
  await w.src.idle();
  const healed = w.src.read();
  A.eq([healed.harness, healed.harnessSource, healed.final], [DESC, 'git', true], 'V5 the failed answer was never cached: once git answers the source is git');
});

scenario('V5 the budget is checked when an attempt would START (Codex VD99-02)', async () => {
  // a backoff sleep that wakes late: by `late` ms past what it asked for (a busy loop, a forward clock jump)
  const lateWorld = (late) => {
    const w = world({ describe: [DIE], config: { budgetMs: 60000, minAttemptMs: 1000 } });
    let once = true;
    w.deps.sleep = (ms) => { w.sleeps.push(ms); w.t += ms + (once ? late : 0); once = false; return tick(); };
    w.src = VS.makeVersionSource(w.deps, { attemptTimeoutMs: 12000, backoffMs: [500, 1000, 2000], maxAttempts: 5, budgetMs: 60000, minAttemptMs: 1000, retryAfterMs: 300000 });
    return w;
  };
  // woke past the deadline: no attempt may start
  const past = lateWorld(61000);
  past.src.read(); await past.src.idle();
  A.eq(steps(past, 'describe').length, 1, 'V5 a backoff that wakes past the budget starts no further attempt (got ' + steps(past, 'describe').length + ')');
  const ex = past.notes.find(n => n.tag === 'version.git.exhausted');
  A.ok(ex && /no attempt fits/.test(ex.message) && /exit 128/.test(ex.message), 'V5 the exhausted note says no attempt fits and keeps the last git cause: ' + (ex && ex.message));
  A.eq([past.src.read().harnessSource, past.src.read().final], ['unknown', false], 'V5 that is the honest exhausted interim, not final');
  // woke with less than minAttemptMs left (800 ms): not started either (the old code gave it a 1000 ms timeout)
  const short = lateWorld(60000 - 500 - 800);
  short.src.read(); await short.src.idle();
  A.eq(steps(short, 'describe').length, 1, 'V5 a wake that leaves 800 ms (< minAttemptMs 1000) starts no attempt');
  // woke with 1500 ms left: the attempt starts, and its timeout ends at the budget, not past it
  const tight = lateWorld(60000 - 500 - 1500);
  tight.src.read(); await tight.src.idle();
  const d2 = steps(tight, 'describe');
  A.eq(d2.length, 2, 'V5 a wake that leaves 1500 ms starts one more attempt');
  A.eq(d2[1] && d2[1].opts.timeout, 1500, 'V5 that attempt is timed to the budget left (1500 ms), never past it');
});

// ---- V6 HEAD is supplementary (Codex VD99-01) ----
scenario('V6 a describe answer is published at once; HEAD has its own unknown, retries and re-ask', async () => {
  const w = world({ describe: [ok(DESC)], revParse: [DIE] });
  w.src.read();
  const published = await until(() => w.src.read().harnessSource === 'git');
  A.ok(published, 'V6 the describe answer is readable while rev-parse is still running');
  const mid = w.src.read();
  const rp = steps(w, 'rev-parse').length;
  A.ok(rp >= 1 && rp < 5, 'V6 describe is published while rev-parse is still in its first attempts (' + rp + ' of 5), not after them');
  A.eq([mid.harness, mid.harnessSource, mid.head, mid.final, mid.pending], [DESC, 'git', null, false, false], 'V6 while HEAD is unknown: harness git, head null, not final (not cached), nothing to wait for');
  await w.src.idle();
  const ex = w.src.read();
  A.eq([ex.harness, ex.harnessSource, ex.head, ex.final], [DESC, 'git', null, false], 'V6 an exhausted rev-parse keeps the harness and leaves HEAD unknown, NOT final (never frozen blank)');
  A.ok(w.notes.some(n => n.tag === 'version.head.exhausted' && /buildSha reads blank/.test(n.message)), 'V6 the exhausted HEAD is noted on its own tag');
  const spawned = w.calls.length;
  w.src.read(); w.src.read();
  A.eq(w.calls.length, spawned, 'V6 inside the cool-down a read does not respawn rev-parse');
  w.t += 300000;
  w.script['rev-parse'] = [ok(SHA)];
  w.src.read();
  A.eq(steps(w, 'describe').length, 1, 'V6 the HEAD re-ask never re-runs describe');
  A.ok(w.calls.length === spawned + 1 && w.calls[spawned].args[0] === 'rev-parse', 'V6 after the cool-down a read asks rev-parse HEAD again');
  await w.src.idle();
  const healed = w.src.read();
  A.eq([healed.harness, healed.head, healed.final], [DESC, SHA, true], 'V6 once HEAD answers the whole answer is final');
});

scenario('V6 a valid env BUILD_SHA skips rev-parse entirely', async () => {
  const w = world({ envSha: 'E'.repeat(40), describe: [ok(DESC)], revParse: [HANG] });
  w.src.read();
  A.ok(await within(w.src.idle()) !== 'HUNG', 'V6 with a valid env BUILD_SHA the resolution ends at describe (nothing waits on a rev-parse)');
  const r = w.src.read();
  A.eq(steps(w, 'rev-parse').length, 0, 'V6 a valid env BUILD_SHA: rev-parse HEAD never runs');
  A.eq([r.harness, r.harnessSource, r.head, r.final], [DESC, 'git', null, true], 'V6 the describe answer is final at once (the env stamp supplies the SHA)');
  const bad = world({ envSha: 'not-a-sha', describe: [ok(DESC)], revParse: [ok(SHA)] });
  bad.src.read(); await bad.src.idle();
  A.eq([steps(bad, 'rev-parse').length, bad.src.read().head], [1, SHA], 'V6 an invalid env BUILD_SHA does not count: rev-parse runs');
});

// ---- V8 waiting: bounded, only for the first describe attempt (RUN STALL, CLI ATTACH, SETTLE vs ATTEMPT) ----
scenario('V8 settled() waits only for the boot\'s first describe attempt, bounded', async () => {
  const w = world({ describe: [HANG] });
  const r = w.src.read();
  A.eq([r.harnessSource, r.pending], ['unknown', true], 'V8 read() returns at once while the first attempt runs (pending)');
  let guard;
  const hung = new Promise(res => { guard = setTimeout(() => res('HUNG'), 3000); });
  const got = await Promise.race([w.src.settled(5000), hung]);
  clearTimeout(guard);
  A.ok(got !== 'HUNG' && got && got.harnessSource === 'unknown' && got.final === false, 'V8 settled(5000) answers the honest interim while git hangs (no hang)');
  A.ok(w.sleeps.indexOf(5000) >= 0, 'V8 the wait is the bound it was given');
  const dflt = world({ describe: [HANG] });
  dflt.src.read(); await dflt.src.settled();
  A.ok(dflt.sleeps.indexOf(VS.DEFAULTS.apiWaitMs) >= 0, 'V8 settled() with no argument waits the shipped apiWaitMs (' + VS.DEFAULTS.apiWaitMs + ')');
  const quick = world({ describe: [ok(DESC)], revParse: [HANG], deps: { sleep: () => new Promise(() => {}) } });
  const q = await within(quick.src.settled(10000));
  A.eq([q.harnessSource, q.harness], ['git', DESC], 'V8 settled() returns as soon as describe answers, not at the bound, and not after HEAD');
  const resolved = await world({ env: 'v1' }).src.settled(10000);
  A.eq(resolved.harnessSource, 'env', 'V8 settled() on a final answer returns it');
  for (const v of [r, got, q, resolved]) A.ok(SOURCES.indexOf(v.harnessSource) >= 0, 'V8 harnessSource stays in the documented set: ' + v.harnessSource);
});

scenario('V8 nobody waits after a failure, a retry, an exhausted budget or a cool-down re-ask', async () => {
  const BOUND = 7777;
  const settleWaited = (w) => w.sleeps.indexOf(BOUND) >= 0;
  // a permanently failing git (fails at once): the first wait ends at the first failure, not at the bound
  const fast = world({ describe: [DIE], deps: { sleep: () => new Promise(() => {}) } });   // no timer ever fires
  let guard;
  const hung = new Promise(res => { guard = setTimeout(() => res('HUNG'), 3000); });
  const first = await Promise.race([fast.src.settled(BOUND), hung]);
  clearTimeout(guard);
  A.ok(first !== 'HUNG' && first.harnessSource === 'unknown', 'V8 the first wait ends at the first attempt\'s failure (a failing git costs a caller nothing)');
  A.eq(fast.src.read().pending, false, 'V8 after a failed attempt nothing is pending, though retries go on');
  // during the retries
  const retry = world({ describe: [DIE, HANG] });
  retry.src.read();
  await until(() => steps(retry, 'describe').length === 2);
  A.eq(retry.src.read().pending, false, 'V8 during a retry nothing is pending');
  await within(retry.src.settled(BOUND));
  A.ok(!settleWaited(retry), 'V8 during a retry settled() does not wait');
  retry.src.stop();
  // exhausted, then the cool-down re-ask
  const ex = world({ describe: [DIE] });
  ex.src.read(); await ex.src.idle();
  await ex.src.settled(BOUND);
  A.ok(!settleWaited(ex), 'V8 with the budget exhausted settled() does not wait');
  ex.t += 300000;
  ex.script.describe = [HANG];
  const before = steps(ex, 'describe').length;
  const again = ex.src.read();
  A.eq(steps(ex, 'describe').length, before + 1, 'V8 (premise) the cool-down re-asked git');
  A.eq(again.pending, false, 'V8 a cool-down re-ask is never waited for');
  await ex.src.settled(BOUND);
  A.ok(!settleWaited(ex), 'V8 after a cool-down settled() does not wait');
  ex.src.stop();
  // HEAD pending: the harness is answered, nothing to wait for
  const hp = world({ describe: [ok(DESC)], revParse: [HANG] });
  hp.src.read(); await until(() => hp.src.read().harnessSource === 'git');
  await within(hp.src.settled(BOUND));
  A.ok(!settleWaited(hp) && hp.src.read().pending === false, 'V8 a pending HEAD is never waited for');
  hp.src.stop();
});

scenario('V8 the bounds: /api/version answers well inside every CLI timeout; a run never waits', async () => {
  const D = VS.DEFAULTS;
  const bin = fs.readFileSync(path.join(__dirname, '..', 'bin', 'starnet.js'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'bin', 'lib', 'dashboard.js'), 'utf8');
  const timeouts = [];
  const attach = /request\('GET', '\/api\/version', null, \{ timeoutMs: (\d+) \}\)/.exec(bin);
  if (attach) timeouts.push(Number(attach[1]));
  A.ok(!!attach, 'V8 found the CLI attach probe\'s /api/version timeout in bin/starnet.js');
  if (/request\('GET', '\/api\/version'\)/.test(bin)) {   // status: the client default
    const dflt = /o\.timeoutMs \|\| (\d+)/.exec(bin);
    A.ok(!!dflt, 'V8 found the CLI client\'s default timeout'); if (dflt) timeouts.push(Number(dflt[1]));
  }
  if (/get\('\/api\/version'\)/.test(dash)) {
    const g = /const get = \(p, t\) => client\.request\('GET', p, null, \{ timeoutMs: t \|\| (\d+) \}\)/.exec(dash);
    A.ok(!!g, 'V8 found the dashboard /version timeout'); if (g) timeouts.push(Number(g[1]));
  }
  const shortest = Math.min.apply(null, timeouts.length ? timeouts : [0]);
  A.ok(D.apiWaitMs > 0 && D.apiWaitMs * 2 <= shortest, 'V8 apiWaitMs (' + D.apiWaitMs + ') is at most half the shortest CLI timeout on /api/version (' + shortest + ' of ' + timeouts.join('/') + ')');
  const lim = VS.makeVersionSource({}, {}).limits;
  A.ok(!('runWaitMs' in D) && JSON.stringify(Object.keys(lim)) === '["apiWaitMs"]', 'V13 no run bound exists: /api/version is the one bounded wait (limits ' + JSON.stringify(lim) + ')');
  A.ok(D.attemptTimeoutMs > 2000 && D.attemptTimeoutMs > D.apiWaitMs && D.budgetMs >= D.attemptTimeoutMs && D.maxAttempts >= 2 && D.minAttemptMs > 0,
    'V8 an attempt (background) is generous and longer than any wait; the waits end at the first answer or failure (see above)');
  const modText = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'version-source.js'), 'utf8');
  A.ok(!/\b(execSync|execFileSync|spawnSync)\b/.test(modText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'V8 version-source.js never runs a synchronous child process');
});

// ---- V13 a run never waits (VD-HANDOVER-01): its [RUNTIME] build is read at once ----
scenario('V13 a run reads its build at once and says when git is still resolving (VD-HANDOVER-01)', async () => {
  const rt = require('../sidecar/runtimeinfo.js');
  const line = (harness) => rt.runtimeIdentityBlock({ harness }).split('\n').find(l => /^StarNet harness build at run start: /.test(l)) || '';
  // the first describe attempt runs (git hangs): the build is named at once, with no wait, as still resolving
  const w = world({ describe: [HANG] });
  const label = typeof w.src.runtimeHarness === 'function' ? w.src.runtimeHarness() : '(no runtimeHarness)';
  A.eq(label, VS.RESOLVING || '(no RESOLVING label)', 'V13 while the first describe attempt runs, a run names its build as still resolving');
  A.eq(w.sleeps.length, 0, 'V13 ...at once: no wait was taken');
  const r = w.src.read();
  A.eq([r.pending, r.resolving, r.harnessSource], [true, true, 'unknown'], 'V13 read() says git is resolving; harnessSource stays in the documented set');
  A.eq(line(label), 'StarNet harness build at run start: ' + VS.RESOLVING, 'V13 the [RUNTIME] line carries the whole label');
  w.src.stop();
  if (typeof w.src.runtimeHarness !== 'function') return;
  // a failed first attempt, then a retry in flight: nothing is pending (nobody waits), git is still being asked
  const retry = world({ describe: [DIE, HANG] });
  retry.src.read();
  await until(() => steps(retry, 'describe').length === 2);
  const rr = retry.src.read();
  A.eq([rr.pending, rr.resolving, retry.src.runtimeHarness()], [false, true, VS.RESOLVING], 'V13 during a retry nothing is pending and a run still says resolving');
  retry.src.stop();
  // describe answered, HEAD still asked: the build, at once
  const done = world({ describe: [ok(DESC)], revParse: [HANG] });
  done.src.read();
  await until(() => done.src.read().harnessSource === 'git');
  A.eq(done.src.runtimeHarness(), DESC, 'V13 once describe answered, a run names that build (HEAD still being asked)');
  done.src.stop();
  // an exhausted budget: nothing is known, so the line says unknown (never resolving, never pkg)
  const ex = world({ describe: [DIE] });
  ex.src.read(); await ex.src.idle();
  A.eq([ex.src.runtimeHarness(), ex.src.read().resolving], ['', false], 'V13 an exhausted budget names no build and is not resolving');
  A.eq(line(ex.src.runtimeHarness()), 'StarNet harness build at run start: unknown', 'V13 ...so its [RUNTIME] line says unknown');
  // a stopped source is not resolving
  const st = world({ describe: [HANG] });
  st.src.read(); st.src.stop();
  A.eq([st.src.runtimeHarness(), st.src.read().resolving], ['', false], 'V13 a stopped source names no build and is not resolving');
  // an env stamp and a packaged app: their answer at once, and no git
  const env = world({ env: 'v0.14.2-env' });
  A.eq([env.src.runtimeHarness(), env.calls.length], ['v0.14.2-env', 0], 'V13 an env stamp is named at once');
  const pkg = world({ exists: () => false });
  A.eq([pkg.src.runtimeHarness(), pkg.calls.length], ['0.0.0', 0], 'V13 a packaged app names its package version at once');
});

// ---- V14 the checkout's git never takes .git/index.lock (VD-LOCK-01) ----
scenario('V14 an attempt is describe without --dirty, then a lock-free status for the -dirty mark', async () => {
  const STATUS = ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'];
  const NAME = 'v0.14.2-3-gabc1234';
  const attemptNotes = (w) => w.notes.filter(n => n.tag === 'version.git.attempt').map(n => n.message);
  // a clean tree: the describe name; status runs after describe, in the repo root, bounded, never through a shell
  const clean = world({ describe: [ok(NAME)], revParse: [ok(SHA)] });
  clean.src.read(); await clean.src.idle();
  A.eq([clean.src.read().harness, clean.src.read().harnessSource], [NAME, 'git'], 'V14 a status that prints nothing is a clean tree: the build is the describe name');
  A.eq(clean.calls.map(c => c.args), [['describe', '--always', '--tags'], STATUS, ['rev-parse', 'HEAD']], 'V14 describe (never --dirty), then the lock-free status, then HEAD');
  A.ok(clean.calls.every(c => c.file === 'git' && !c.opts.shell && c.opts.cwd === REPO && c.opts.timeout > 0 && c.opts.timeout <= 12000), 'V14 every git run is direct, in the repo root, and bounded');
  A.eq(attemptNotes(clean), [], 'V14 an empty status is not a failure (an empty describe is)');
  // a status line marks the name as describe --dirty would
  const dirty = world({ describe: [ok(NAME)], status: [ok(' M sidecar/index.js')], revParse: [ok(SHA)] });
  dirty.src.read(); await dirty.src.idle();
  A.eq(dirty.src.read().harness, NAME + '-dirty', 'V14 a status line: the build carries the -dirty mark');
  // a status that printed past maxBuffer is dirty: what it printed is a change
  const big = world({ describe: [ok(NAME)], status: [{ overflow: true, stdout: ' M a\n M b\n' }], revParse: [ok(SHA)] });
  big.src.read(); await big.src.idle();
  A.eq([big.src.read().harness, attemptNotes(big)], [NAME + '-dirty', []], 'V14 a status past maxBuffer reads dirty, not a failure');
  // a failing status fails the whole attempt: noted with its cause, retried from describe, never published unmarked
  const flaky = world({ describe: [ok(NAME)], status: [DIE, TIMEOUT, ok(' M x')], revParse: [ok(SHA)] });
  flaky.src.read();
  A.eq(flaky.src.read().harnessSource, 'unknown', 'V14 (premise) nothing is published before the status answers');
  await flaky.src.idle();
  A.eq([flaky.src.read().harness, steps(flaky, 'describe').length, steps(flaky, 'status').length], [NAME + '-dirty', 3, 3], 'V14 each failed status is retried with its describe, then the build is published marked');
  const fm = attemptNotes(flaky);
  A.ok(fm.length === 2 && /dirty check \(git status\) exit 128: fatal: Out of memory/.test(fm[0]) && /dirty check \(git status\) timed out after \d+ ms/.test(fm[1]), 'V14 a status failure is noted with its cause: ' + fm.join(' | '));
  // a status that never answers: the first attempt is still pending (nothing published), and stop() kills it
  const hung = world({ describe: [ok(NAME)], status: [HANG] });
  hung.src.read();
  await until(() => steps(hung, 'status').length === 1);
  A.eq([hung.src.read().harnessSource, hung.src.read().pending, hung.src.runtimeHarness()], ['unknown', true, VS.RESOLVING], 'V14 while the status runs, the first attempt is pending and a run says resolving');
  hung.src.stop();
  A.ok(await within(hung.src.idle()) !== 'HUNG', 'V14 stop() ends the resolution while its status is in flight (bounded, not HUNG)');
  A.eq([hung.src.read().harnessSource, hung.kills.length, attemptNotes(hung).length], ['unknown', 1, 0], 'V14 stop() kills the status in flight, publishes nothing and notes no failure');
  // a describe that used the budget up: no status fits, the attempt fails, nothing is published unmarked
  const late = world({ describe: [{ stdout: NAME + '\n', advance: 59500 }], config: { minAttemptMs: 1000 } });
  late.src.read(); await late.src.idle();
  A.eq([late.src.read().harnessSource, steps(late, 'status').length], ['unknown', 0], 'V14 a describe that left no time for the status publishes nothing');
  A.ok(/no dirty check fits/.test(attemptNotes(late)[0] || ''), 'V14 ...and says so: ' + attemptNotes(late)[0]);
});

scenario('V14 real git: no .git/index.lock and no index write, and the verdict describe --dirty gives (VD-LOCK-01)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'version-source-lock-'));
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) if (/^GIT_/i.test(k)) delete env[k];   // a hook's GIT_DIR / GIT_INDEX_FILE must not redirect it
  const git = (args) => cp.execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  const host = VS.makeOwnedGit({
    platform: process.platform, spawn: (f, a, o) => cp.spawn(f, a, Object.assign({ env }, o)), execFile: (f, a, o, cb) => cp.execFile(f, a, Object.assign({ env }, o), cb),
    signal: (pid, sig) => process.kill(pid, sig), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t), note: () => {}
  });
  const indexFile = path.join(root, '.git', 'index');
  const digest = () => require('crypto').createHash('sha256').update(fs.readFileSync(indexFile)).digest('hex');
  // the index.lock witness: a watcher on .git. A count nobody feeds reads 0 by construction, so a row claims that no lock
  // appeared only while the watcher runs (Codex VD-FA2-ORACLE-01), and each state proves it live on describe --dirty's lock
  let locks = 0, watcher = null, watchFailed = '';
  const watching = () => !!watcher && !watchFailed;
  const pause = (ms) => new Promise(r => setTimeout(r, ms));
  // the events of the git runs before a measurement (the last reference describe --dirty, a git add or reset) are all in
  const quiet = async () => { for (let i = 0, seen = -1; i < 50 && seen !== locks; i++) { seen = locks; await pause(100); } };
  // the version source as the sidecar composes it (a valid env BUILD_SHA: rev-parse is not the subject here)
  async function resolve() {
    const notes = [];
    const src = VS.makeVersionSource({
      repoRoot: root, join: path.join, stat: fs.statSync, execFile: host.execFile, kill: host.kill,
      envDescribe: () => '', envSha: () => 'a'.repeat(40), pkgVersion: () => '0.0.0',
      now: () => Date.now(), sleep: (ms) => new Promise(r => setTimeout(r, ms)), note: (t, e) => notes.push(t + ': ' + ((e && e.message) || e))
    }, { attemptTimeoutMs: 30000, maxAttempts: 2 });
    src.read();
    const end = await within(src.idle(), 60000);
    src.stop();
    return { r: src.read(), notes, hung: end === 'HUNG' };
  }
  async function state(label, expected) {
    await quiet();
    locks = 0;
    const before = digest();
    const got = await resolve();
    await pause(150);   // let the watcher deliver
    A.eq([got.r.harness, got.r.harnessSource, got.hung, got.notes], [expected, 'git', false, []], 'V14 real git, ' + label + ': the build reads ' + expected);
    A.eq([digest() === before, watching(), locks], [true, true, 0], 'V14 real git, ' + label + ': the index is not written and no index.lock appears');
    A.eq(git(['describe', '--always', '--dirty', '--tags']), expected, 'V14 real git, ' + label + ': describe --dirty gives the same verdict');
    for (let i = 0; i < 500 && !locks; i++) await pause(10);
    A.ok(watching() && locks > 0, 'V14 real git, ' + label + ': the watcher sees the index.lock describe --dirty takes, so its 0 above is an observation');
  }
  try {
    git(['init', '-q']);
    git(['config', 'user.name', 'version-source']); git(['config', 'user.email', 'version-source@example.invalid']); git(['config', 'core.autocrlf', 'false']);
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(root, 'f' + i + '.txt'), 'file ' + i + '\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'init']); git(['tag', 'v1.0.0']);
    try {
      watcher = fs.watch(path.join(root, '.git'), (type, name) => { if (String(name || '') === 'index.lock') locks++; });
      watcher.on('error', (e) => { watchFailed = watchFailed || String((e && e.message) || e); });
    } catch (e) { watcher = null; watchFailed = String((e && e.message) || e); }
    A.ok(watching(), 'V14 real git: a watcher on .git runs (no watcher, no claim that no index.lock appeared): ' + (watchFailed || 'watching'));
    const f7 = path.join(root, 'f7.txt');
    const past = new Date(Date.now() - 3600e3);
    fs.utimesSync(f7, past, past);   // its stat no longer matches the index: describe --dirty would rewrite the index here
    await state('a file whose stat changed (same bytes)', 'v1.0.0');
    fs.writeFileSync(f7, 'file 7 changed\n'); fs.utimesSync(f7, past, past);
    await state('a work-tree edit', 'v1.0.0-dirty');
    git(['add', 'f7.txt']);
    await state('a staged change', 'v1.0.0-dirty');
    git(['reset', '-q', '--hard']); fs.writeFileSync(path.join(root, 'untracked.txt'), 'new\n');
    await state('an untracked file only', 'v1.0.0');
  } finally {
    if (watcher) { try { watcher.close(); } catch (_) {} }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { console.log('cleanup ' + root + ': ' + e.message); }
  }
});

// ---- V9 shutdown ----
scenario('V9 stop() kills the git child in flight and starts nothing more', async () => {
  const w = world({ describe: [HANG, ok(DESC)], revParse: [ok(SHA)] });
  let killedWith = null;
  w.deps.kill = (c) => { killedWith = c; c.kill(); };
  w.src = VS.makeVersionSource(w.deps, { attemptTimeoutMs: 12000, backoffMs: [500], maxAttempts: 5, budgetMs: 60000, retryAfterMs: 300000 });
  w.src.read();
  A.eq(w.calls.length, 1, 'V9 (premise) a describe is in flight');
  w.src.stop();
  A.ok(killedWith && killedWith.pid === 4001, 'V9 stop() hands the git child in flight to the injected (tree) kill');
  await w.src.idle();
  A.eq(w.calls.length, 1, 'V9 after stop() no retry starts');
  A.ok(!w.notes.some(n => n.tag === 'version.git.attempt' || n.tag === 'version.git.exhausted'), 'V9 the shutdown kill is not reported as a git failure');
  w.t += 300000; w.src.read();
  A.eq(w.calls.length, 1, 'V9 after stop() a read never kicks git again, not even after the cool-down');
  // a real child process, killed through the module's own default (child.kill)
  const pids = [];
  const realExec = (file, args, o, cb) => { const c = cp.execFile(process.execPath, ['-e', 'setTimeout(function(){}, 60000)'], { timeout: o.timeout, windowsHide: true }, cb); pids.push(c.pid); return c; };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  try {
    const real = VS.makeVersionSource({ repoRoot: os.tmpdir(), join: path.join, stat: () => ({}), execFile: realExec, now: () => 0, sleep: () => tick(), note: () => {} }, { attemptTimeoutMs: 30000 });
    real.read();
    A.ok(pids.length === 1 && alive(pids[0]), 'V9 (premise) a real child is running');
    real.stop();
    let guard;
    const hung = new Promise(res => { guard = setTimeout(() => res('HUNG'), 10000); });
    const out = await Promise.race([real.idle().then(() => 'done'), hung]);
    clearTimeout(guard);
    A.eq(out, 'done', 'V9 the resolution ends once its child is killed');
    A.ok(await until(() => !alive(pids[0]), 2000), 'V9 the real child process is gone after stop()');
    A.eq(pids.length, 1, 'V9 no further child was started');
  } finally {
    for (const pid of pids) { try { process.kill(pid); } catch (e) { if (e.code !== 'ESRCH') console.log('cleanup pid ' + pid + ': ' + e.message); } }
  }
});

// ---- V11 the git child's kill matches its launch (Codex VD4CE-01) ----
// an injected host for makeOwnedGit: records every launch, group signal, direct kill, taskkill and timer
function ownedHost(platform, opts) {
  opts = opts || {};
  const h = { launched: [], signals: [], alone: [], killers: [], timers: [], cleared: [], notes: [] };
  h.host = {
    platform,
    execFile: (file, args, o, cb) => {
      if (file === 'taskkill') {
        h.killers.push({ args: args.slice(), opts: Object.assign({}, o), cb });
        if (opts.taskkillThrows) throw Object.assign(new Error('spawn taskkill ENOENT'), { code: 'ENOENT' });
        return { unref: () => { h.killerUnref = true; } };
      }
      const proc = { pid: 'pid' in opts ? opts.pid : 4321, kill: (sig) => { h.alone.push({ pid: proc.pid, sig }); return true; } };
      h.launched.push({ file, args: args.slice(), opts: Object.assign({}, o), cb, proc });
      return proc;
    },
    signal: (pid, sig) => { h.signals.push([pid, sig]); if (opts.signalThrows) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); return true; },
    setTimer: (fn, ms) => { const t = { fn, ms }; h.timers.push(t); return t; },
    clearTimer: (t) => { h.cleared.push(t); },
    note: (tag, err) => { h.notes.push({ tag, message: String((err && err.message) || err) }); }
  };
  h.og = VS.makeOwnedGit(h.host);
  return h;
}
// alive in real time: a zombie (Linux /proc state Z) is dead; EPERM is a live process we may not signal
function alivePid(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  if (process.platform !== 'linux') return true;
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8')); } catch (_) { return false; }
}
async function waitReal(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise(r => setTimeout(r, 25)); }
  return !!pred();
}

scenario('V11 the git child is killed as the tree its launch made, on each platform shape', async () => {
  const OPTS = { cwd: REPO, timeout: 12000, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 20 };
  const DESCRIBE = ['describe', '--always', '--dirty', '--tags'];
  // POSIX: detached at launch, and the kill is the group of that leader
  const px = ownedHost('linux');
  const c = px.og.execFile('git', DESCRIBE, OPTS, () => {});
  const L = px.launched[0];
  A.ok(L && L.opts.detached === true, 'V11 POSIX: git is launched detached, the leader of its own process group');
  A.eq([L.file, L.args, L.opts.cwd, L.opts.encoding, L.opts.maxBuffer, L.opts.windowsHide], ['git', DESCRIBE, REPO, 'utf8', 1 << 20, true], 'V11 POSIX: the file, args and other options pass through');
  A.ok(!('timeout' in L.opts), "V11 the attempt timeout is not execFile's own (that signals git alone)");
  A.ok(c === L.proc, 'V11 execFile returns the launched child (stop() holds it)');
  px.og.kill(c);
  A.eq(px.signals, [[-4321, 'SIGTERM']], 'V11 POSIX: kill signals the process group of the launched leader (-pid), SIGTERM so git drops its locks');
  A.eq([px.alone.length, px.notes.length], [0, 0], 'V11 POSIX: the group kill is the kill; git alone is not the path');
  const gone = ownedHost('darwin', { signalThrows: true });
  gone.og.kill(gone.og.execFile('git', DESCRIBE, OPTS, () => {}));
  A.eq([gone.signals, gone.alone], [[[-4321, 'SIGTERM']], [{ pid: 4321, sig: 'SIGTERM' }]], 'V11 POSIX: a group that cannot be signalled falls back to git itself');
  A.ok(gone.notes.some(n => n.tag === 'version.kill.fallback' && /ESRCH/.test(n.message)), 'V11 POSIX: that fallback is noted with its cause');
  for (const pid of [1, 0, -7, undefined]) {
    const g = ownedHost('linux', { pid });
    g.og.kill(g.og.execFile('git', DESCRIBE, OPTS, () => {}));
    A.eq([g.signals.length, g.alone.length], [0, 1], 'V11 POSIX: pid ' + pid + ' never becomes a group kill (-1 would signal every process this user owns)');
  }
  // win32: never detached, windowsHide, and the kill is taskkill /T on the launched pid
  const wn = ownedHost('win32');
  const wc = wn.og.execFile('git', DESCRIBE, Object.assign({ detached: true }, OPTS), () => {});
  const WL = wn.launched[0];
  A.ok(WL && !('detached' in WL.opts) && WL.opts.windowsHide === true, 'V11 win32: git is never detached (that opens a console window) and runs windowsHide');
  wn.og.kill(wc);
  A.eq(wn.killers.map(k => k.args), [['/pid', '4321', '/T', '/F']], 'V11 win32: kill runs taskkill /pid <launched pid> /T /F (its tree)');
  A.ok(wn.killers[0].opts.windowsHide === true && wn.killers[0].opts.timeout === 15000, 'V11 win32: taskkill runs hidden and bounded by its own timeout (V12: it stays referenced until it answers)');
  A.eq([wn.signals.length, wn.alone.length], [0, 0], 'V11 win32: no POSIX group signal, and git alone is not the path while taskkill runs');
  wn.killers[0].cb(Object.assign(new Error('taskkill exited 128'), { code: 128 }));
  A.eq(wn.alone, [{ pid: 4321, sig: 'SIGTERM' }], 'V11 win32: a failed taskkill falls back to git itself');
  A.ok(wn.notes.some(n => n.tag === 'version.kill.fallback' && /taskkill \/T failed \(128\)/.test(n.message)), 'V11 win32: that fallback is noted with its cause');
  const wt = ownedHost('win32', { taskkillThrows: true });
  wt.og.kill(wt.og.execFile('git', DESCRIBE, OPTS, () => {}));
  A.eq(wt.alone.length, 1, 'V11 win32: a taskkill that cannot start falls back to git itself');
  // the attempt timeout takes the same kill, and still reads as a timeout
  const tm = ownedHost('linux');
  const res = [];
  tm.og.execFile('git', DESCRIBE, OPTS, (e) => res.push(e));
  A.eq(tm.timers.map(t => t.ms), [12000], 'V11 the attempt timeout is armed at its bound');
  tm.timers[0].fn();
  A.eq(tm.signals, [[-4321, 'SIGTERM']], 'V11 a timed-out attempt is killed as the group too');
  tm.launched[0].cb(Object.assign(new Error('Command failed: git describe'), { code: null, signal: 'SIGTERM' }), '', '');
  A.ok(res[0] && res[0].killed === true, 'V11 a timed-out attempt still reads killed, so its note says timed out');
  const fin = ownedHost('linux');
  const done = [];
  fin.og.execFile('git', DESCRIBE, OPTS, (e, so) => done.push([e, so]));
  fin.launched[0].cb(null, DESC + '\n', '');
  A.eq([fin.cleared.length, done[0] && done[0][0], done[0] && done[0][1]], [1, null, DESC + '\n'], 'V11 an answered attempt clears its timer and passes its output through');
  const own = ownedHost('linux');
  const why = [];
  own.og.execFile('git', DESCRIBE, OPTS, (e) => why.push(e));
  own.launched[0].cb(Object.assign(new Error('Command failed'), { code: 128 }), '', 'fatal');
  A.ok(why[0] && !why[0].killed && own.signals.length === 0, 'V11 a git that failed on its own is not read as timed out, and nothing is killed');
  let bare = null;
  VS.makeOwnedGit({ platform: 'linux', execFile: (f, a, o) => { bare = o; return { pid: 9 }; }, signal: () => {} }).execFile('git', DESCRIBE, OPTS, () => {});
  A.ok(bare && bare.timeout === 12000 && bare.detached === true, 'V11 with no injected timer the attempt keeps execFile\'s own timeout (still bounded)');
  // composed as the sidecar composes it: stop() kills exactly what the source launched, on each platform shape
  for (const platform of ['linux', 'win32']) {
    const hh = ownedHost(platform);
    const w = world({ describe: [HANG] });
    const src = VS.makeVersionSource(Object.assign({}, w.deps, { execFile: hh.og.execFile, kill: hh.og.kill }), { attemptTimeoutMs: 12000 });
    src.read();
    const at = hh.launched[0];
    A.ok(at && at.file === 'git' && at.args[0] === 'describe', 'V11 ' + platform + ' (premise) the source launched git describe through makeOwnedGit');
    src.stop();
    if (platform === 'win32') A.eq([at.opts.detached, hh.killers.map(k => k.args.join(' ')), hh.signals], [undefined, ['/pid ' + at.proc.pid + ' /T /F'], []], 'V11 win32: stop() taskkills the tree of the very pid it launched');
    else A.eq([at.opts.detached, hh.signals, hh.killers.length], [true, [[-at.proc.pid, 'SIGTERM']], 0], 'V11 POSIX: stop() signals the group of the very leader it launched detached');
    at.cb(Object.assign(new Error('Command failed: git describe'), { code: null, signal: 'SIGTERM' }), '', '');
    A.eq(await within(src.idle().then(() => 'done'), 5000), 'done', 'V11 ' + platform + ': the resolution ends once its child is killed');
    A.ok(!w.notes.some(n => /^version\.git\./.test(n.tag)), 'V11 ' + platform + ': the shutdown kill is not reported as a git failure');
  }
  // a REAL tree on this host: the launched child starts a grandchild, and stop() through makeOwnedGit reaps both.
  // On win32 libuv puts a node child in a kill-on-close job, so a plain node grandchild would die with its node
  // parent whatever the kill; it breaks away (detached) to outlive its parent the way git's own children do, so only
  // taskkill /T reaps it. On POSIX it stays in its parent's process group, as git's children do.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-source-tree-'));
  const pidFile = path.join(dir, 'grandchild.pid');
  const kid = "var c=require('child_process').spawn(process.execPath,['-e','setInterval(function(){},1000)'],{stdio:'ignore',windowsHide:true,detached:process.platform==='win32'});" +
    'require(\'fs\').writeFileSync(' + JSON.stringify(pidFile) + ',String(c.pid));setInterval(function(){},1000);';
  const launched = [];
  const realOg = VS.makeOwnedGit({
    platform: process.platform,
    spawn: (file, args, o) => { const ch = cp.spawn(process.execPath, ['-e', kid], o); launched.push(ch.pid); return ch; },   // POSIX, as the sidecar wires it
    execFile: (file, args, o, cb) => {
      if (file === 'taskkill') return cp.execFile(file, args, o, cb);
      const ch = cp.execFile(process.execPath, ['-e', kid], o, cb);
      launched.push(ch.pid);
      return ch;
    },
    signal: (pid, sig) => process.kill(pid, sig), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t), note: () => {}
  });
  let gpid = 0;
  try {
    const real = VS.makeVersionSource({ repoRoot: dir, join: path.join, stat: () => ({}), execFile: realOg.execFile, kill: realOg.kill, now: () => 0, sleep: () => tick(), note: () => {} }, { attemptTimeoutMs: 30000 });
    real.read();
    const started = await waitReal(() => { try { gpid = Number(fs.readFileSync(pidFile, 'utf8')) || 0; } catch (_) { gpid = 0; } return gpid > 0; }, 10000);
    A.ok(started && launched.length === 1 && alivePid(launched[0]) && alivePid(gpid), 'V11 (premise) a real launched child and its grandchild are running');
    real.stop();
    A.eq(await within(real.idle().then(() => 'done'), 20000), 'done', 'V11 the real resolution ends once its child is killed');
    A.ok(await waitReal(() => !alivePid(launched[0]) && !alivePid(gpid), 10000), 'V11 stop() reaped the launched child AND its grandchild (' + process.platform + ')');
  } finally {
    const left = launched.concat(gpid > 0 ? [gpid] : []);
    for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') console.log('cleanup pid ' + pid + ': ' + e.message); } }
    await waitReal(() => left.every(pid => !alivePid(pid)), 5000);   // a process still dying holds its cwd (win32 EBUSY)
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) { console.log('cleanup ' + dir + ': ' + e.message); }
  }
});

// ---- V15 the POSIX launch: execFile's answer on spawn, because execFile drops `detached` (first Linux CI run, 2026-11-06) ----
scenario('V15 spawnExecFile answers as execFile does, and its detached child really leads a group', async () => {
  const run = VS.spawnExecFile(cp.spawn);
  const go = (script, o) => new Promise((res) => {
    run(process.execPath, ['-e', script], Object.assign({ windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 20 }, o), (error, stdout, stderr) => res({ error, stdout, stderr }));
  });
  const fine = await go("process.stdout.write('out'); process.stderr.write('err');");
  A.eq([fine.error, fine.stdout, fine.stderr], [null, 'out', 'err'], 'V15 a clean exit answers null and both streams, decoded');
  const bad = await go("process.stderr.write('why'); process.exit(3);");
  A.eq([bad.error && bad.error.code, bad.error && bad.error.killed, bad.error && bad.error.signal, bad.stderr], [3, false, null, 'why'], 'V15 a failed exit answers its code, not killed, with its stderr');
  const gone = await new Promise((res) => run(path.join(os.tmpdir(), 'no-such-program-' + process.pid), [], { windowsHide: true }, (error, stdout) => res({ error, stdout })));
  A.eq([gone.error && gone.error.code, gone.stdout], ['ENOENT', ''], 'V15 a program that cannot start answers ENOENT');
  const big = await go("process.stdout.write('x'.repeat(5000)); setInterval(function(){},1000);", { maxBuffer: 100 });
  A.eq([big.error && big.error.code, big.stdout.length], ['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 100], 'V15 past maxBuffer: killed, the Node code, and the stdout that fitted (the -dirty verdict reads it)');
  const slow = await go('setInterval(function(){},1000);', { timeout: 200 });
  A.ok(slow.error && slow.error.killed === true, 'V15 past its timeout a child is killed and reads killed');
  if (process.platform !== 'win32') {
    let leader = false;
    const held = await new Promise((res) => {
      const ch = run(process.execPath, ['-e', 'setInterval(function(){},1000);'], { detached: true }, (error) => res({ error }));
      setTimeout(() => { try { process.kill(-ch.pid, 0); leader = true; process.kill(-ch.pid, 'SIGTERM'); } catch (_) { ch.kill('SIGKILL'); } }, 150);
    });
    A.ok(leader, 'V15 POSIX: a detached launch leads its own process group (execFile drops the option)');
    A.eq(held.error && held.error.signal, 'SIGTERM', 'V15 POSIX: the group signal ended it, and its answer says so');
  }
  A.ok(/makeOwnedGit\(\{\s*platform: process\.platform, spawn: \(file, args, opts\) => stationChildProcess\.spawn\(/.test(require('./helpers/source.js').readSidecarSource()), 'V15 the sidecar gives makeOwnedGit its guarded spawn, so POSIX git leads its group');
});

// ---- V12 a shutdown waits for its kill to land (final review 1 of f884cced3: the win32 taskkill race) ----
// settledYet(p): true once p settled, read after the microtasks and immediates queued so far have run
async function settledYet(p) { let s = false; Promise.resolve(p).then(() => { s = true; }, () => { s = true; }); await tick(); await tick(); return s; }
scenario('V12 the shutdown kill is a settle the station waits for, inside its bound', async () => {
  const OPTS = { cwd: REPO, timeout: 12000, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 20 };
  const DESCRIBE = ['describe', '--always', '--dirty', '--tags'];
  // win32: the settle is pending while taskkill runs and lands at its answer, also after a failed one
  const wn = ownedHost('win32');
  const p = wn.og.kill(wn.og.execFile('git', DESCRIBE, OPTS, () => {}));
  A.ok(p && typeof p.then === 'function', 'V12 win32: kill() returns its settle');
  A.eq(await settledYet(p), false, 'V12 win32: the settle is pending while taskkill /T runs');
  A.ok(wn.killers.length === 1 && wn.killerUnref !== true, 'V12 win32: taskkill stays referenced until it answers, so a draining station does not exit first');
  if (wn.killers[0]) wn.killers[0].cb(null);
  A.eq(await settledYet(p), true, 'V12 win32: the settle lands when taskkill answers');
  const wf = ownedHost('win32');
  const pf = wf.og.kill(wf.og.execFile('git', DESCRIBE, OPTS, () => {}));
  if (wf.killers[0]) wf.killers[0].cb(Object.assign(new Error('taskkill exited 128'), { code: 128 }));
  A.ok(pf && await settledYet(pf) && wf.alone.length === 1, 'V12 win32: after a failed taskkill the settle lands once git itself was killed');
  const wt = ownedHost('win32', { taskkillThrows: true });
  const pt = wt.og.kill(wt.og.execFile('git', DESCRIBE, OPTS, () => {}));
  A.ok(pt && await settledYet(pt) && wt.alone.length === 1, 'V12 win32: a taskkill that cannot start settles once git itself was killed');
  // POSIX: the group signal is delivered when it is sent, so the settle lands at once
  const px = ownedHost('linux');
  const pp = px.og.kill(px.og.execFile('git', DESCRIBE, OPTS, () => {}));
  A.ok(pp && typeof pp.then === 'function' && await settledYet(pp) && px.signals.length === 1, 'V12 POSIX: kill() returns a settle that lands at once, after the group signal');
  const pg = ownedHost('darwin', { signalThrows: true });
  const pgs = pg.og.kill(pg.og.execFile('git', DESCRIBE, OPTS, () => {}));
  A.ok(pgs && await settledYet(pgs) && pg.alone.length === 1, 'V12 POSIX: a group that cannot be signalled settles after git itself was killed');
  const p1 = ownedHost('linux', { pid: 1 });
  const s1 = p1.og.kill(p1.og.execFile('git', DESCRIBE, OPTS, () => {}));
  A.ok(s1 && typeof s1.then === 'function' && await settledYet(s1), 'V12 a pid that never becomes a group kill still gives a settle');
  // composed: stop() returns the kill's settle, never rejects, and a stop with nothing in flight settles at once
  const hh = ownedHost('win32');
  const w = world({ describe: [HANG] });
  const src = VS.makeVersionSource(Object.assign({}, w.deps, { execFile: hh.og.execFile, kill: hh.og.kill }), { attemptTimeoutMs: 12000 });
  src.read();
  const st = src.stop();
  A.ok(st && typeof st.then === 'function', 'V12 stop() returns the settle of its kill');
  A.eq(await settledYet(st), false, 'V12 win32: stop() is not settled while taskkill /T is still running');
  if (hh.killers[0]) hh.killers[0].cb(null);
  A.eq(await settledYet(st), true, 'V12 win32: stop() settles once taskkill answered');
  A.ok(st && src.stop() === st, 'V12 a second stop() gives the same settle (the kill is not repeated)');
  A.eq(hh.killers.length, 1, 'V12 the second stop() ran no second taskkill');
  const thr = world({ describe: [HANG], deps: { kill: () => { throw new Error('kill blew up'); } } });
  thr.src.read();
  const ts = thr.src.stop();
  A.ok(ts && typeof ts.then === 'function' && await settledYet(ts) && thr.notes.some(n => n.tag === 'version.stop'), 'V12 a kill that throws still gives a settled stop(), noted');
  // the rejection is marked handled here, so a stop() that drops it fails this assertion instead of crashing the file
  const rejecting = () => { const r = Promise.reject(new Error('kill rejected')); r.then(null, () => {}); return r; };
  const rej = world({ describe: [HANG], deps: { kill: rejecting } });
  rej.src.read();
  let rejected = false;
  const rs = rej.src.stop();
  if (rs && rs.then) rs.then(null, () => { rejected = true; });
  A.ok(rs && await settledYet(rs) && !rejected && rej.notes.some(n => n.tag === 'version.stop'), 'V12 a kill whose settle rejects gives a stop() that resolves, noted');
  const none = world({ env: 'v0.14.2-env' });
  none.src.read();
  const ns = none.src.stop();
  A.ok(ns && typeof ns.then === 'function' && await settledYet(ns), 'V12 a stop() with no git in flight settles at once');
  // a REAL station: a child process composes makeOwnedGit and the version source, waits for git's grandchild, then
  // shuts down the way gracefulShutdown does (it exits once the stop's settle lands, bounded at 2500 ms by an unref'd
  // timer, with nothing else holding its loop). Before the settle existed it exited at once, libuv's kill-on-close
  // job ended the taskkill it had just started, and on win32 the grandchild (outside that job, as git's own
  // children are) outlived the station. On POSIX the group signal lands when it is sent, before or after.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-source-station-'));
  const kidPidFile = path.join(dir, 'child.pid');
  const gpFile = path.join(dir, 'grandchild.pid');
  const kid = "var c=require('child_process').spawn(process.execPath,['-e','setInterval(function(){},1000)'],{stdio:'ignore',windowsHide:true,detached:process.platform==='win32'});" +
    'require(\'fs\').writeFileSync(' + JSON.stringify(gpFile) + ',String(c.pid));setInterval(function(){},1000);';
  const station = [
    "var cp = require('child_process'), fs = require('fs'), path = require('path');",
    'var VS = require(' + JSON.stringify(path.join(__dirname, '..', 'sidecar', 'version-source.js')) + ');',
    'var og = VS.makeOwnedGit({ platform: process.platform,',
    '  spawn: function (file, args, o) { var ch = cp.spawn(process.execPath, ["-e", ' + JSON.stringify(kid) + '], o); fs.writeFileSync(' + JSON.stringify(kidPidFile) + ', String(ch.pid)); return ch; },',
    "  execFile: function (file, args, o, cb) { if (file === 'taskkill') return cp.execFile(file, args, o, cb);",
    '    var ch = cp.execFile(process.execPath, ["-e", ' + JSON.stringify(kid) + '], o, cb); fs.writeFileSync(' + JSON.stringify(kidPidFile) + ', String(ch.pid)); return ch; },',
    '  signal: function (pid, sig) { return process.kill(pid, sig); }, setTimer: function (fn, ms) { return setTimeout(fn, ms); }, clearTimer: function (t) { clearTimeout(t); }, note: function () {} });',
    // git's cwd is the temp root, not dir: a grandchild that outlived a red run must not hold dir (win32 EBUSY)
    'var src = VS.makeVersionSource({ repoRoot: ' + JSON.stringify(os.tmpdir()) + ', join: path.join, stat: function () { return {}; }, execFile: og.execFile, kill: og.kill,',
    '  now: function () { return 0; }, sleep: function () { return new Promise(function (r) { setImmediate(r); }); }, note: function () {} }, { attemptTimeoutMs: 30000 });',
    'src.read();',
    'var poll = setInterval(function () { if (!fs.existsSync(' + JSON.stringify(gpFile) + ')) return; clearInterval(poll);',
    '  var stopped = Promise.resolve(src.stop());',
    '  var bound = new Promise(function (r) { var t = setTimeout(r, 2500); t.unref(); });',
    '  var exit = function () { process.exit(0); };',
    '  Promise.race([Promise.all([Promise.resolve(), stopped]), bound]).then(exit, exit);',
    '}, 25);'
  ].join('\n');
  const readPid = (f) => { try { return Number(fs.readFileSync(f, 'utf8')) || 0; } catch (_) { return 0; } };
  let kidPid = 0, gpid = 0, stationPid = 0;
  try {
    const ch = cp.spawn(process.execPath, ['-e', station], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    stationPid = ch.pid;
    let err = '';
    ch.stderr.on('data', (b) => { err += b; });
    const exited = new Promise((r) => ch.on('exit', (code) => { stationPid = 0; r(code); }));   // an exited station's pid is not ours to kill
    const code = await within(exited, 20000);
    kidPid = readPid(kidPidFile); gpid = readPid(gpFile);
    A.ok(code === 0 && kidPid > 0 && gpid > 0, 'V12 (premise) the station launched its git stand-in and grandchild, then shut down (exit ' + code + (err ? ', ' + err.trim().slice(0, 200) : '') + ')');
    const reaped = await waitReal(() => !alivePid(kidPid) && !alivePid(gpid), 2000);
    A.ok(reaped, 'V12 a station that exits as gracefulShutdown does leaves no git child or grandchild running (' + process.platform +
      ': child ' + (alivePid(kidPid) ? 'alive' : 'gone') + ', grandchild ' + (alivePid(gpid) ? 'alive' : 'gone') + ')');
  } finally {
    const left = [stationPid, kidPid, gpid].filter(pid => pid > 0);
    for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') console.log('cleanup pid ' + pid + ': ' + e.message); } }
    await waitReal(() => left.every(pid => !alivePid(pid)), 5000);   // a process still dying holds its cwd (win32 EBUSY)
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch (e) { console.log('cleanup ' + dir + ': ' + e.message); }
  }
});

// ---- V10 failure notes never carry a fragment of a known secret (Codex VD99-03), through the real seam ----
scenario('V10 redaction runs over the whole raw text before it is cut', async () => {
  const ctx = require('../sidecar/context.js');
  const failopen = require('../sidecar/failopen.js');
  // 64 characters with no vendor or credential-assignment shape: only the known-value layer can catch it
  const SECRET = 'plover-quintet-marigold-harbor-tundra-violet-ember-saffron-orbit';
  A.eq(SECRET.length, 64, 'V10 (premise) the known secret is 64 characters');
  A.ok(ctx.redact('x ' + SECRET.slice(0, 24) + ' y').indexOf(SECRET.slice(0, 24)) >= 0, 'V10 (premise) a fragment of it has no shape redact() could catch');
  const warns = [];
  const origWarn = console.warn;
  ctx.setKnownSecretSource(() => [SECRET]);
  failopen.resetForTests();
  console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
  try {
    const w = world({
      describe: [
        { exit: 128, stderr: 'fatal: ' + 'a'.repeat(169) + SECRET + '\n' },                       // the stderr line crosses 200
        { spawnThrow: true, code: 'EACCES', message: 'spawn git EACCES ' + 'b'.repeat(120) + SECRET }, // the message crosses 160
        { rawError: 'c'.repeat(180) + SECRET },                                                     // the generic branch crosses 200
        ok(DESC)
      ],
      revParse: [ok(SHA)],
      deps: { note: failopen.note, redact: ctx.redact }
    });
    w.src.read(); await w.src.idle();
    A.eq(w.src.read().harnessSource, 'git', 'V10 (premise) the three failures were retried to git');
  } finally { console.warn = origWarn; ctx.setKnownSecretSource(null); failopen.resetForTests(); }
  const said = warns.filter(s => /version\.git\.attempt/.test(s));
  A.eq(said.length, 3, 'V10 the three failed attempts reached console.warn through failopen.note');
  const leaks = [];
  for (let i = 0; i + 12 <= SECRET.length; i++) { const frag = SECRET.slice(i, i + 12); if (said.some(s => s.indexOf(frag) >= 0)) leaks.push(frag); }
  A.eq(leaks.slice(0, 3), [], 'V10 no 12-character fragment of the known secret reaches a warning');
  A.ok(said.every(s => /\[redacted-secret\]/.test(s)), 'V10 each note quoted the text, redacted whole (not just dropped)');
  // no redactor injected: the note keeps the structured class and code, and quotes no raw text
  const bare = world({ describe: [{ exit: 128, stderr: 'fatal: ' + SECRET + '\n' }, ok(DESC)], revParse: [ok(SHA)], deps: { redact: undefined } });
  bare.src.read(); await bare.src.idle();
  const m = bare.notes.find(n => n.tag === 'version.git.attempt');
  A.ok(m && /exit 128/.test(m.message) && m.message.indexOf('fatal') < 0 && m.message.indexOf(SECRET.slice(0, 12)) < 0, 'V10 with no redactor a note gives the exit code only: ' + (m && m.message));
  const comp = readSidecarIndex();
  const at = comp.indexOf("require('./version-source.js').makeVersionSource(");
  const block = at >= 0 ? comp.slice(at, comp.indexOf('\n});', at)) : '';
  A.ok(/\bredact:\s*redact\b/.test(block), 'V10 the sidecar injects context.redact into the version source');
});

// ---- V7 the composed surface, sliced from the sidecar ----
function composed(opts) {
  opts = opts || {};
  const src = sidecarTopLevelFunction('computeVersionSurface');
  const sync = [];
  const envExtra = opts.envExtra || {};
  const w = world({ describe: opts.describe || [TIMEOUT, ok(DESC)], revParse: opts.revParse || [ok(SHA)], env: opts.env, envSha: envExtra.BUILD_SHA });
  let describeCalls = 0;
  const syncFake = (cmd) => {
    sync.push(String(cmd));
    if (/describe/.test(cmd)) { describeCalls++; if (describeCalls === 1 && !opts.env) throw Object.assign(new Error('spawnSync C:\\Windows\\system32\\cmd.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }); return DESC + '\n'; }
    if (/rev-parse/.test(cmd)) return SHA + '\n';
    return '';
  };
  const env = Object.assign({ APP_VERSION: '9.9.9-test', BUILD_DESCRIBE: opts.env || '' }, envExtra);
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
});

scenario('V7 composed: HEAD is supplementary on the /api/version surface (Codex VD99-01)', async () => {
  // a valid env BUILD_SHA: describe answers, rev-parse would hang, and it never runs
  const g = composed({ describe: [ok(DESC)], revParse: [HANG], envExtra: { BUILD_SHA: 'E'.repeat(40), BUILD_DIRTY: '0' } });
  g.fn(); await within(g.w.src.idle());
  const sg = g.fn();
  A.eq([sg.harness, sg.harnessSource, sg.buildSha, sg.buildDirty], [DESC, 'git', 'e'.repeat(40), false], 'V7 an env BUILD_SHA wins over git HEAD, with its BUILD_DIRTY, and the describe answer is not withheld');
  A.eq(steps(g.w, 'rev-parse').length, 0, 'V7 with a valid env BUILD_SHA the surface spawns no rev-parse');
  A.ok(g.fn() === g.fn(), 'V7 that surface is final and cached');
  // no env SHA, rev-parse keeps failing: the harness is there at once, buildSha is unknown, nothing is cached
  const h = composed({ describe: [ok(DESC)], revParse: [DIE] });
  h.fn();
  await until(() => h.fn().harnessSource === 'git');
  const mid = h.fn();
  A.eq([mid.harness, mid.harnessSource, mid.buildSha, mid.buildDirty], [DESC, 'git', '', null], 'V7 while rev-parse retries, /api/version already names the build (buildSha unknown)');
  await h.w.src.idle();
  const ex = h.fn();
  A.eq([ex.harness, ex.harnessSource, ex.buildSha, ex.buildDirty], [DESC, 'git', '', null], 'V7 an exhausted rev-parse keeps harness git with buildSha unknown');
  A.ok(h.fn() !== h.fn(), 'V7 a surface with HEAD unknown is not cached');
  h.w.t += 300000;
  h.w.script['rev-parse'] = [ok(SHA)];
  h.fn(); await h.w.src.idle();
  const healed = h.fn();
  A.eq([healed.buildSha, healed.buildDirty], [SHA, true], 'V7 after the cool-down HEAD is asked again and reaches the surface');
  A.ok(h.fn() === h.fn(), 'V7 then the surface is cached');
});

scenario('V7 wiring: the boot kick, the bounded waits, the tree kill and the shutdown stop', async () => {
  const hv = sidecarTopLevelFunction('handleVersion');
  A.ok(/^async function handleVersion\(/.test(hv) && /await versionSource\.settled\(versionSource\.limits\.apiWaitMs\)/.test(hv), 'V7 handleVersion waits at most apiWaitMs before it answers');
  const run = sidecarTopLevelFunction('runOnceCore');
  const use = run.indexOf('const runtimeVersion = computeVersionSurface()');
  const waits = (run.match(/await[^;\n]*versionSource|versionSource\.(settled|idle)\(/g) || []);
  A.ok(use > 0 && waits.length === 0, 'V13 a run never waits for the version source before its [RUNTIME] block (VD-HANDOVER-01): ' + (waits.join(' | ') || 'no wait'));
  A.ok(/runtimeIdentityBlock\(\{[^\n]*\bharness: runtimeVersion\.harness \|\| versionSource\.runtimeHarness\(\),/.test(run.slice(use)),
    'V13 [RUNTIME] names the build as it stands: the answer, or still resolving while git has not answered');
  A.ok(!/execSync\(\s*'git/.test(sidecarTopLevelFunction('computeVersionSurface')), 'V7 computeVersionSurface no longer shells out to git');
  const gs = sidecarTopLevelFunction('gracefulShutdown');
  A.ok(/versionSource\.stop\(\)/.test(gs), 'V7 gracefulShutdown stops the version source (reaps a git in flight)');
  // V12: the exit waits for that stop's settle, inside the existing bounded wait (afterBrowser, 2500 ms < the 3 s deadline)
  A.ok(/versionStopped\s*=\s*Promise\.resolve\(versionSource\.stop\(\)\)\.catch\(e => failNote\('version\.shutdown', e\)\)/.test(gs), 'V12 gracefulShutdown keeps the version stop\'s settle (a rejection is noted, never thrown)');
  const ab = gs.match(/const afterBrowser = fn => Promise\.race\(\[Promise\.all\(\[([^\]]*)\]\), new Promise\(r => \{ const t = setTimeout\(r, (\d+)\)/);
  A.ok(ab && /\bversionStopped\b/.test(ab[1]) && Number(ab[2]) <= 2500, 'V12 gracefulShutdown exits only once that settle landed, inside afterBrowser\'s bound (' + (ab ? ab[1] + ', ' + ab[2] + ' ms' : 'afterBrowser not found') + ')');
  A.ok(gs.indexOf('versionStopped = ') >= 0 && gs.indexOf('versionStopped = ') < gs.indexOf('const afterBrowser'), 'V12 the stop runs before the exit wait is built');
  const idx = readSidecarIndex();   // index.js's own boot sequence and composition (pinned here on purpose)
  const listen = idx.search(/server\.listen\(PORT, '127\.0\.0\.1', (?:async )?\(\) => \{/);
  const boot = listen >= 0 ? idx.slice(listen, listen + 1500) : '';
  A.ok(/versionSource\.read\(\)/.test(boot), 'V7 the listen callback kicks the version resolution at boot');
  const at = idx.indexOf("require('./version-source.js').makeVersionSource(");
  const block = at >= 0 ? idx.slice(at, idx.indexOf('\n});', at)) : '';
  A.ok(/execFile:\s*versionGit\.execFile\b/.test(block) && /kill:\s*versionGit\.kill\b/.test(block) && !/stopTerminalTree/.test(block), 'V7 git is launched and killed through makeOwnedGit, so the kill matches the launch (not the PTY group kill on a plain execFile child)');
  const og = idx.indexOf("const versionGit = require('./version-source.js').makeOwnedGit(");
  const ogBlock = og >= 0 ? idx.slice(og, idx.indexOf('\n});', og)) : '';
  A.ok(og >= 0 && og < at, 'V7 makeOwnedGit is composed before the version source');
  A.ok(/platform:\s*process\.platform\b/.test(ogBlock) && /signal:\s*\(pid, sig\)\s*=>\s*process\.kill\(pid, sig\)/.test(ogBlock) && /execFile:\s*\(file, args, opts, cb\)\s*=>\s*stationChildProcess\.execFile\(/.test(ogBlock), 'V7 makeOwnedGit gets the real platform, process.kill and the station-env execFile');
  A.ok(/setTimer:/.test(ogBlock) && /clearTimer:/.test(ogBlock) && /note:\s*failNote\b/.test(ogBlock), 'V7 makeOwnedGit gets timers (the attempt timeout takes the tree kill) and failNote');
  A.ok(/envSha:\s*\(\)\s*=>\s*ENV\('BUILD_SHA'\)/.test(block), 'V7 the env BUILD_SHA reaches the version source');
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
