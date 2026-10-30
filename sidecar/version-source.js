'use strict';
/* sidecar/version-source.js — WHERE the harness build id comes from, resolved without blocking and never guessed.

   The chain, decided on the first read:
     1. an env stamp (STARNET_BUILD_DESCRIBE, from the build/release pipeline) wins: harnessSource 'env';
     2. no <repo>/.git at all — a packaged app — is the package.json version at once: harnessSource 'pkg'. A .git
        directory and a .git FILE (a worktree's gitfile) both count as a checkout. Only a probe that says the entry
        is ABSENT (ENOENT, ENOTDIR) means no checkout; any other probe error (EACCES, EPERM, EBUSY, one with no code)
        cannot tell, so it is noted (version.checkout) and treated as a checkout, never as 'pkg';
     3. a checkout asks `git describe --always --dirty --tags` through async execFile, no shell, each attempt with
        a bounded timeout. EVERY failure (timed out, a non-zero exit such as 128, git's generic die incl. out of
        memory, exit 0 with nothing printed, a spawn that throws) is noted and retried with backoff, inside a
        bounded number of attempts and a bounded total time. Success is final and published AT ONCE:
        harnessSource 'git'.

   HEAD IS SUPPLEMENTARY. `git rev-parse HEAD` only feeds buildSha, so it never holds the describe answer back. It
   is skipped entirely when a valid env BUILD_SHA (40 hex) is stamped. Otherwise it runs after describe answered,
   with its own bounded retries. While it has not answered, or after its budget ran out (noted,
   version.head.exhausted), read() gives head null with final:false: buildSha '' and buildDirty null mean unknown,
   the surface is not cached, and a read after the cool-down asks rev-parse again. HEAD never changes harness or
   harnessSource.

   WHY (gate 298473720, 10-30): the old one-shot execSync with a 2 s timeout timed out on a loaded box (--dirty
   refreshes the index over the whole work tree), its empty catch read that as "no git", the 0.0.0 placeholder came
   back as 'pkg', and the surface cached it for the life of the process.

   THE HONEST INTERIM: while a checkout's git describe has not answered, or after its budget ran out, read() gives
   harness '' and harnessSource 'unknown' (the documented set stays 'env' | 'git' | 'pkg' | 'unknown'), with
   final:false so the caller does not cache it. A checkout never reads 'pkg'. An exhausted budget is noted
   (version.git.exhausted) and a read after the cool-down (retryAfterMs) asks git again.

   THE BUDGET: an attempt starts only while at least minAttemptMs of its step's budget is left, checked at the moment
   it would START (after a backoff sleep, which may wake late), and its timeout never runs past the budget.

   WAITING, AND THE BOUNDS (one place). read() is synchronous over state and only starts work. The host kicks the
   resolution at boot (one read() after listen), so the first /api/version or run normally finds it answered.
   settled(maxWaitMs) is the bounded wait a caller may take, and it waits ONLY while read().pending: the process's
   FIRST describe attempt is still running. It ends at that attempt's answer, at its failure or at the bound,
   whichever comes first, and never rejects. Once any describe attempt has failed (during the retries, after an
   exhausted budget, for every later cool-down re-ask) nobody waits: callers read the interim at once and the
   retries go on in the background. That is why the waits are deliberately SHORTER than one attempt
   (attemptTimeoutMs is a background bound sized for a loaded box's --dirty refresh): a caller only hopes to catch
   a first answer that is about to land, and never sits through a timeout or a retry.
     apiWaitMs  GET /api/version: at most half the shortest CLI timeout on that route (bin/starnet.js attachClient
                probes it with timeoutMs 5000; test/version-source.test.js reads the bin and holds this);
     runWaitMs  a run's [RUNTIME] build line: short, so a run never pays seconds for version metadata.
   Readers that never wait (diagnostics, the live doctor's build block, the harness snapshot, /v1, the headless
   status) read the interim as it stands: harness '' with harnessSource 'unknown' (their own fallbacks show 'dev' or
   'unknown'), which is the truth at that moment, and they read 'git' once describe answers.

   SHUTDOWN: stop() kills the git child in flight, starts no further attempt and kicks nothing later, so a git
   describe never outlives the sidecar. The host injects execFile and kill from makeOwnedGit (below), so the kill
   addresses the tree that launch made: POSIX launches git detached, the leader of its own process group, and kills
   that group; win32 runs taskkill /T. The attempt timeout goes through the same kill.

   FAILURE NOTES CARRY NO SECRET FRAGMENT: a cause quotes git's stderr or error text only after the injected
   redact() ran over the WHOLE raw text; only then is it cut to one line and a length. With no redact() injected, a
   note gives the structured class and exit code only, no raw text.

   Pure: no ambient clock, fs or child process. The host injects repoRoot, join, stat, execFile, kill, envDescribe,
   envSha, pkgVersion, now, sleep, redact and note (failopen.note); makeOwnedGit gets platform, execFile, signal
   (process.kill), setTimer, clearTimer and note. */

const DEFAULTS = Object.freeze({
  attemptTimeoutMs: 15000,                 // per attempt, in the background; the old 2000 ms was exceeded by a loaded --dirty refresh (1.1-7 s measured 10-30 with a gate running)
  backoffMs: Object.freeze([500, 1000, 2000, 4000, 8000]),   // wait before attempt n+1 (the last step repeats)
  maxAttempts: 6,                          // per step (describe, rev-parse): bounded even if the clock lies
  budgetMs: 60000,                         // per step, total: no attempt starts once less than minAttemptMs of it is left
  minAttemptMs: 1000,                      // an attempt that would get less than this is not started
  retryAfterMs: 300000,                    // after an exhausted budget, a read this much later asks git again
  apiWaitMs: 2500,                         // GET /api/version's wait for the first describe attempt: half the CLI attach probe's 5000 ms
  runWaitMs: 1000                          // a run's wait for the first describe attempt
});

const DESCRIBE = Object.freeze(['describe', '--always', '--dirty', '--tags']);
const REV_PARSE = Object.freeze(['rev-parse', 'HEAD']);
const SHA_RE = /^[0-9a-f]{40}$/i;

function oneLine(s, max) {
  const line = String(s == null ? '' : s).split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';
  return line.slice(0, max || 200);
}

// a measured, one-line cause for a failed git run (the old empty catch logged nothing: no exit code, timeout or
// stderr). clean(raw) redacts the WHOLE raw text first, or gives null (no redactor: quote nothing); only then is
// the text cut to a line and a length, so a known secret is never split into a fragment redact() cannot match.
function failureCause(r, timeoutMs, clean) {
  const e = r.error;
  const quote = (raw, max) => { const c = clean(raw); return c == null ? '' : oneLine(c, max); };
  if (!e) return 'printed nothing';
  if (typeof e.code === 'string') {   // ENOENT, ENOMEM, maxBuffer: a Node error code, not git's text
    const m = quote(e.message, 160);
    return 'could not run git: ' + e.code.replace(/[^A-Za-z0-9_]/g, '').slice(0, 48) + (m ? ' (' + m + ')' : '');
  }
  if (e.killed) return 'timed out after ' + timeoutMs + ' ms (killed' + (e.signal ? ', ' + e.signal : '') + ')';
  if (typeof e.code === 'number') { const err = quote(r.stderr, 200); return 'exit ' + e.code + (err ? ': ' + err : ''); }
  if (e.signal) return 'killed by ' + e.signal;
  return quote(e.message || e, 200) || 'failed';
}

function makeVersionSource(deps, config) {
  const d = deps || {};
  const cfg = Object.assign({}, DEFAULTS, config || {});
  const backoff = Array.isArray(cfg.backoffMs) && cfg.backoffMs.length ? cfg.backoffMs : DEFAULTS.backoffMs;
  const now = () => { const t = Number(typeof d.now === 'function' ? d.now() : NaN); return Number.isFinite(t) ? t : 0; };
  const note = (tag, err) => { if (typeof d.note === 'function') d.note(tag, err); };   // failopen.note: never throws
  const sleep = (ms) => (typeof d.sleep === 'function' ? Promise.resolve(d.sleep(ms)) : Promise.resolve());
  const repoRoot = String(d.repoRoot || '');
  const clean = (raw) => {   // the whole raw text, redacted; null when it cannot be (the note then quotes no text)
    if (typeof d.redact !== 'function') return null;
    try { return String(d.redact(String(raw == null ? '' : raw))); }
    catch (e) { note('version.redact', new Error('redact threw (' + ((e && e.name) || 'Error') + '); the git failure note quotes no text')); return null; }
  };

  let decided = null;     // the env / pkg answer, or { checkout: true, needHead }
  let phase = 'idle';     // describe, checkout only: idle | resolving | resolved | failed
  let harness = '';       // the describe answer once resolved
  let failedAt = null;
  let everFailed = false; // a describe attempt has failed in this process: no caller waits for git again
  let headPhase = 'idle'; // rev-parse HEAD: idle | resolving | resolved | failed | skip (a valid env BUILD_SHA)
  let head = null;
  let headFailedAt = null;
  let inFlight = null;    // the one git job in flight (describe then HEAD, or a HEAD re-ask)
  let child = null;       // its git child process, for stop()
  let stopped = false;
  let gate = null;        // resolves at the first describe attempt's answer or failure: all a waiting caller wants
  let release = () => {};

  function decide() {
    const env = String((typeof d.envDescribe === 'function' ? d.envDescribe() : '') || '').trim();
    if (env) return { harness: env, harnessSource: 'env', head: null, final: true, pending: false };
    let checkout;
    try { d.stat(d.join(repoRoot, '.git')); checkout = true; }   // a directory or a gitfile: both are a checkout
    catch (e) {
      const code = e && e.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') checkout = false;   // the probe says it is absent: a packaged app
      else { note('version.checkout', e); checkout = true; }            // cannot tell: ask git (it retries and says why), never assume pkg
    }
    if (checkout) {
      const sha = String((typeof d.envSha === 'function' ? d.envSha() : '') || '').trim();
      return { checkout: true, needHead: !SHA_RE.test(sha) };
    }
    try { return { harness: String(d.pkgVersion() || ''), harnessSource: 'pkg', head: null, final: true, pending: false }; }
    catch (e) { note('version.pkg', e); return { harness: '', harnessSource: 'unknown', head: null, final: true, pending: false }; }
  }

  function runGit(args, timeoutMs) {
    return new Promise((resolve) => {
      let mine = null;
      try {
        mine = d.execFile('git', args.slice(), { cwd: repoRoot, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 20 },
          (error, stdout, stderr) => {
            if (child === mine) child = null;
            resolve({ error: error || null, stdout: String(stdout || ''), stderr: String(stderr || '') });
          });
        child = mine || null;
      } catch (e) { resolve({ error: e, stdout: '', stderr: '' }); }   // a spawn that throws (EMFILE, ENOMEM) is one more failed attempt
    });
  }

  // one step with retries: the trimmed stdout, { exhausted: lastCause } once no permitted attempt is left, or
  // { stopped: true } after stop(). Each failed attempt is noted with its measured cause, then onFail runs.
  async function attempts(step, args, onFail) {
    const deadline = now() + cfg.budgetMs;
    let last = '';
    for (let n = 1; n <= cfg.maxAttempts; n++) {
      if (stopped) return { stopped: true };
      const left = deadline - now();   // checked when the attempt would START: a late wake from backoff starts nothing past the budget
      if (left < cfg.minAttemptMs) { last = (last ? last + '; ' : '') + 'no attempt fits in the ' + cfg.budgetMs + ' ms budget'; break; }
      const timeoutMs = Math.min(cfg.attemptTimeoutMs, left);
      const r = await runGit(args, timeoutMs);
      if (stopped) return { stopped: true };   // killed by stop(): not a git failure, nothing to note
      const out = r.error ? '' : r.stdout.trim();
      if (out) return out;
      last = failureCause(r, timeoutMs, clean);
      note('version.git.attempt', new Error('git ' + step + ' attempt ' + n + '/' + cfg.maxAttempts + ' failed: ' + last));
      if (onFail) onFail();
      const wait = backoff[Math.min(n - 1, backoff.length - 1)];
      if (n >= cfg.maxAttempts || now() + wait + cfg.minAttemptMs > deadline) break;
      await sleep(wait);
    }
    return { exhausted: last || 'failed' };
  }

  async function headStep() {
    headPhase = 'resolving';
    const h = await attempts('rev-parse', REV_PARSE, null);
    if (typeof h === 'string') { head = h; headPhase = 'resolved'; return; }
    headPhase = 'failed'; headFailedAt = now();
    if (!h.stopped) note('version.head.exhausted', new Error('git rev-parse HEAD gave no commit within the retry budget (last: ' + h.exhausted +
      '); buildSha reads blank (unknown, not cached), and a read after ' + cfg.retryAfterMs + ' ms asks again'));
  }

  async function resolveGit() {
    const desc = await attempts('describe', DESCRIBE, () => { everFailed = true; release(); });
    if (typeof desc !== 'string') {
      phase = 'failed'; failedAt = now();
      if (!desc.stopped) note('version.git.exhausted', new Error('git describe gave no build id within the retry budget (last: ' + desc.exhausted +
        '); harnessSource reads unknown, and a read after ' + cfg.retryAfterMs + ' ms asks git again'));
      return;
    }
    harness = desc; phase = 'resolved';
    release();   // published now: the harness never waits for HEAD
    if (headPhase === 'idle') await headStep();
  }

  // a step that throws past its own handling still ends honestly: describe reads failed (cool-down), HEAD reads failed
  function onThrow() {
    if (phase !== 'resolved') { phase = 'failed'; failedAt = now(); everFailed = true; }
    else if (headPhase === 'resolving') { headPhase = 'failed'; headFailedAt = now(); }
  }
  function track(work) {
    inFlight = work()
      .catch((e) => { onThrow(); note('version.git.exhausted', e); })
      .then(() => { inFlight = null; release(); });
    return inFlight;
  }
  function kickDescribe() {
    phase = 'resolving';
    gate = new Promise((r) => { release = r; });
    return track(resolveGit);
  }

  function read() {
    if (!decided) {
      decided = decide();
      if (decided.checkout && !decided.needHead) headPhase = 'skip';
    }
    if (!decided.checkout) return Object.assign({}, decided);
    const due = (at) => now() - at >= cfg.retryAfterMs;
    if (phase === 'resolved') {
      if (headPhase === 'failed' && !inFlight && !stopped && due(headFailedAt)) track(headStep);
      const headFinal = headPhase === 'resolved' || headPhase === 'skip';
      return { harness, harnessSource: 'git', head: headPhase === 'resolved' ? head : null, final: headFinal, pending: false };
    }
    if (!inFlight && !stopped && (phase === 'idle' || (phase === 'failed' && due(failedAt)))) kickDescribe();
    return { harness: '', harnessSource: 'unknown', head: null, final: false, pending: phase === 'resolving' && !everFailed && !stopped };
  }

  function settled(maxWaitMs) {
    const first = read();
    if (!first.pending || !gate) return Promise.resolve(first);
    const bound = Number.isFinite(Number(maxWaitMs)) && Number(maxWaitMs) >= 0 ? Number(maxWaitMs) : cfg.apiWaitMs;
    return Promise.race([gate, sleep(bound)]).then(() => read(), (e) => { note('version.settle', e); return read(); });
  }

  function idle() { return inFlight ? inFlight.then(() => undefined) : Promise.resolve(); }

  // shutdown: kill the git child in flight (the host's kill reaps its tree), start nothing more, release a waiter
  function stop() {
    stopped = true;
    const c = child; child = null;
    if (c) {
      try { if (typeof d.kill === 'function') d.kill(c); else if (typeof c.kill === 'function') c.kill(); }
      catch (e) { note('version.stop', e); }
    }
    release();
  }

  const limits = Object.freeze({ apiWaitMs: cfg.apiWaitMs, runWaitMs: cfg.runWaitMs });
  return { read, settled, idle, stop, limits };
}

/* THE GIT CHILD IS OWNED AS A TREE, AND ITS KILL MATCHES ITS LAUNCH (Codex VD4CE-01). makeOwnedGit(host) gives the
   execFile and kill the host injects into makeVersionSource.
     POSIX: git is launched detached, so it leads its OWN process group, and kill() signals that group (-pid) with
       SIGTERM (git removes its lock files on SIGTERM; SIGKILL would leave a stale index.lock). Only when the group
       cannot be signalled (noted) does it fall back to git itself. The child is never unref'd: it stays
       referenced, its close is still awaited, and stop() still kills it. Before this, a plain execFile child sat
       in the station's group, the -pid kill (stopTerminalTree, written for PTY group leaders) missed, its
       fallback killed git alone, and a descendant (a configured fsmonitor hook during the --dirty index refresh)
       could outlive the station.
     win32: never detached (that opens a console window); windowsHide, and `taskkill /pid <pid> /T /F` reaps the
       tree, falling back to git itself when taskkill cannot start or fails (noted).
   The attempt timeout takes the same kill: execFile's own timeout signals git alone. A timed-out attempt's error
   still reads killed, so its note still says "timed out". Without an injected timer, execFile's own timeout stays
   (git alone): the attempt is still bounded. */
function makeOwnedGit(host) {
  const h = host || {};
  const win = h.platform === 'win32';
  const note = (tag, err) => { if (typeof h.note === 'function') h.note(tag, err); };
  const timers = typeof h.setTimer === 'function' && typeof h.clearTimer === 'function';
  const why = (e) => String((e && (e.code != null ? e.code : e.message)) || 'error').slice(0, 80);
  function alone(child, reason) {
    try { if (child && typeof child.kill === 'function') child.kill('SIGTERM'); }
    catch (e) { note('version.kill.direct', e); }
    if (reason) note('version.kill.fallback', new Error('git ' + (child && child.pid) + ' was killed alone: ' + reason));
  }
  function kill(child) {
    const pid = Number(child && child.pid);
    // pid > 1 always: a -1 or -0 group would signal every process this user owns, or the station's own group
    if (!Number.isInteger(pid) || pid <= 1) { alone(child, null); return; }
    if (win) {
      try {
        const k = h.execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }, (err) => {
          if (err) alone(child, 'taskkill /T failed (' + why(err) + ')');
        });
        if (k && typeof k.unref === 'function') k.unref();   // the killer only, never git
      } catch (e) { alone(child, 'taskkill could not start (' + why(e) + ')'); }
      return;
    }
    try { h.signal(-pid, 'SIGTERM'); }
    catch (e) { alone(child, 'its process group could not be signalled (' + why(e) + ')'); }
  }
  function execFile(file, args, opts, cb) {
    const o = Object.assign({}, opts || {});
    const bound = Number(o.timeout);
    if (timers) delete o.timeout;   // the attempt timeout takes kill() below: execFile's own would signal git alone
    o.windowsHide = true;
    if (win) delete o.detached; else o.detached = true;   // POSIX: the leader of its own process group
    let child = null, done = false, timedOut = false, timer = null;
    child = h.execFile(file, args, o, (error, stdout, stderr) => {
      done = true;
      if (timer !== null) { h.clearTimer(timer); timer = null; }
      if (error && timedOut) error.killed = true;   // as execFile's own timeout reads: the note says "timed out"
      cb(error, stdout, stderr);
    });
    if (timers && !done && Number.isFinite(bound) && bound > 0) timer = h.setTimer(() => { timer = null; timedOut = true; kill(child); }, bound);
    return child;
  }
  return { execFile, kill };
}

module.exports = { makeVersionSource, makeOwnedGit, DEFAULTS };
