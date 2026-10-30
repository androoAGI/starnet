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
        attach probe's timeout; runWaitMs for a run), never after a failure, a retry or an exhausted budget;
     V9 shutdown reaps the git child in flight (a real child process dies) and starts nothing more;
     V10 a failure note never carries a fragment of a known secret (Codex VD99-03): redaction runs over the whole
        raw text before it is cut, through the real failopen.note + context.redact seam;
     V7 the composed /api/version surface (computeVersionSurface sliced from the sidecar) holds V4-V6 and keeps the
        BUILD_SHA / BUILD_DIRTY env stamps exactly as before; the sidecar wires the stat probe, the redactor, the
        tree kill, the boot kick and the shutdown stop. */
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
  const w = { t: 1000, calls: [], notes: [], sleeps: [], kills: [], script: { describe: (opts.describe || []).slice(), 'rev-parse': (opts.revParse || []).slice() } };
  w.now = () => w.t;
  w.sleep = (ms) => { w.sleeps.push(ms); w.t += ms; return new Promise(r => setImmediate(r)); };
  w.note = (tag, err) => { w.notes.push({ tag, message: String((err && err.message) || err) }); };
  w.execFile = (file, args, o, cb) => {
    const step = args[0];
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
      if (out.timeout) { w.t += o.timeout; return finish(killedErr(), '', ''); }
      if (out.rawError) return finish(new Error(out.rawError), '', '');   // no code, no signal: the generic branch
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
const steps = (w, step) => w.calls.filter(c => c.args[0] === step);

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

scenario('V8 the bounds: /api/version answers well inside every CLI timeout; runs wait briefly', async () => {
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
  A.ok(D.runWaitMs > 0 && D.runWaitMs <= 1000 && D.runWaitMs <= D.apiWaitMs, 'V8 a run waits at most 1 s (runWaitMs ' + D.runWaitMs + ')');
  A.ok(D.attemptTimeoutMs > 2000 && D.attemptTimeoutMs > D.apiWaitMs && D.budgetMs >= D.attemptTimeoutMs && D.maxAttempts >= 2 && D.minAttemptMs > 0,
    'V8 an attempt (background) is generous and longer than any wait; the waits end at the first answer or failure (see above)');
  const modText = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'version-source.js'), 'utf8');
  A.ok(!/\b(execSync|execFileSync|spawnSync)\b/.test(modText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'V8 version-source.js never runs a synchronous child process');
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
  const wait = run.indexOf('if (versionSource.read().pending) await versionSource.settled(versionSource.limits.runWaitMs);');
  const use = run.indexOf('const runtimeVersion = computeVersionSurface()');
  A.ok(wait > 0 && use > wait && use - wait < 400, 'V7 a run waits (runWaitMs, only while the first describe attempt is pending) before it writes the [RUNTIME] build line');
  A.ok(!/execSync\(\s*'git/.test(sidecarTopLevelFunction('computeVersionSurface')), 'V7 computeVersionSurface no longer shells out to git');
  const gs = sidecarTopLevelFunction('gracefulShutdown');
  A.ok(/versionSource\.stop\(\)/.test(gs), 'V7 gracefulShutdown stops the version source (reaps a git in flight)');
  const idx = readSidecarIndex();   // index.js's own boot sequence and composition (pinned here on purpose)
  const listen = idx.indexOf("server.listen(PORT, '127.0.0.1', () => {");
  const boot = listen >= 0 ? idx.slice(listen, listen + 1500) : '';
  A.ok(/versionSource\.read\(\)/.test(boot), 'V7 the listen callback kicks the version resolution at boot');
  const at = idx.indexOf("require('./version-source.js').makeVersionSource(");
  const block = at >= 0 ? idx.slice(at, idx.indexOf('\n});', at)) : '';
  A.ok(/kill:\s*\(child\)\s*=>\s*stopTerminalTree\(/.test(block), 'V7 the shutdown kill is the tree kill (git on Windows can be a launcher with a child)');
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
