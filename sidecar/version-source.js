'use strict';
/* sidecar/version-source.js — WHERE the harness build id comes from, resolved without blocking and never guessed.

   The chain, decided on the first read:
     1. an env stamp (STARNET_BUILD_DESCRIBE, from the build/release pipeline) wins: harnessSource 'env';
     2. no <repo>/.git at all — a packaged app — is the package.json version at once: harnessSource 'pkg'. A .git
        directory and a .git FILE (a worktree's gitfile) both count as a checkout;
     3. a checkout asks `git describe --always --dirty --tags` (then `git rev-parse HEAD`) through async execFile,
        no shell, each attempt with a bounded timeout. EVERY failure (timed out, a non-zero exit such as 128, git's
        generic die incl. out of memory, a spawn that throws) is noted and retried with backoff, inside a bounded
        number of attempts and a bounded total time. Success is final: harnessSource 'git'.

   WHY (gate 298473720, 10-30): the old one-shot execSync with a 2 s timeout timed out on a loaded box (--dirty
   refreshes the index over the whole work tree), its empty catch read that as "no git", the 0.0.0 placeholder came
   back as 'pkg', and the surface cached it for the life of the process.

   THE HONEST INTERIM: while a checkout's git has not answered — or after the budget ran out — read() gives
   harness '' and harnessSource 'unknown' (the documented set stays 'env' | 'git' | 'pkg' | 'unknown'), with
   final:false so the caller does not cache it. A checkout never reads 'pkg'. An exhausted budget is noted
   (version.git.exhausted) and a read after the cool-down (retryAfterMs) asks git again.

   NEVER BLOCKS: read() is synchronous over state and only starts work. settled(maxWaitMs) is the bounded wait a
   caller may take: it resolves when the resolution in flight ends or after the bound, whichever is first, with
   whatever read() says then; it never rejects. idle() (tests, diagnostics) resolves when nothing is in flight.

   Pure: no ambient clock, fs or child process. The host injects repoRoot, join, exists, execFile, envDescribe,
   pkgVersion, now, sleep and note (failopen.note). */

const DEFAULTS = Object.freeze({
  attemptTimeoutMs: 15000,                 // per attempt; the old 2000 ms was exceeded by a loaded --dirty refresh (1.1-7 s measured 10-30 with a gate running)
  backoffMs: Object.freeze([500, 1000, 2000, 4000, 8000]),   // wait before attempt n+1 (the last step repeats)
  maxAttempts: 6,                          // per step (describe, rev-parse): bounded even if the clock lies
  budgetMs: 60000,                         // per step, total: no attempt starts after it
  minAttemptMs: 1000,                      // a retry that would get less than this is not started
  retryAfterMs: 300000,                    // after an exhausted budget, a read this much later asks git again
  settleMs: 10000                          // settled()'s default bound
});

function oneLine(s, max) {
  const line = String(s == null ? '' : s).split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';
  return line.slice(0, max || 200);
}

// a measured, one-line cause for a failed git run (the old empty catch logged nothing: no exit code, timeout or stderr)
function failureCause(r, timeoutMs) {
  const e = r.error;
  const err = oneLine(r.stderr);
  if (!e) return 'printed nothing';
  if (typeof e.code === 'string') return 'could not run git: ' + e.code + (e.message ? ' (' + oneLine(e.message, 160) + ')' : '');   // ENOENT, ENOMEM, maxBuffer
  if (e.killed) return 'timed out after ' + timeoutMs + ' ms (killed' + (e.signal ? ', ' + e.signal : '') + ')';
  if (typeof e.code === 'number') return 'exit ' + e.code + (err ? ': ' + err : '');
  if (e.signal) return 'killed by ' + e.signal;
  return oneLine(e.message || e, 200) || 'failed';
}

function makeVersionSource(deps, config) {
  const d = deps || {};
  const cfg = Object.assign({}, DEFAULTS, config || {});
  const backoff = Array.isArray(cfg.backoffMs) && cfg.backoffMs.length ? cfg.backoffMs : DEFAULTS.backoffMs;
  const now = () => { const t = Number(typeof d.now === 'function' ? d.now() : NaN); return Number.isFinite(t) ? t : 0; };
  const note = (tag, err) => { if (typeof d.note === 'function') d.note(tag, err); };   // failopen.note: never throws
  const sleep = (ms) => (typeof d.sleep === 'function' ? Promise.resolve(d.sleep(ms)) : Promise.resolve());
  const repoRoot = String(d.repoRoot || '');

  let decided = null;    // the env / pkg answer, or { checkout: true }
  let phase = 'idle';    // checkout only: idle | resolving | resolved | failed
  let resolved = null;   // { harness, head } once git answered
  let failedAt = null;
  let inFlight = null;   // the promise of the resolution in flight

  function decide() {
    const env = String((typeof d.envDescribe === 'function' ? d.envDescribe() : '') || '').trim();
    if (env) return { harness: env, harnessSource: 'env', head: null, final: true };
    let checkout = true;
    try { checkout = !!d.exists(d.join(repoRoot, '.git')); }
    catch (e) { note('version.checkout', e); checkout = true; }   // cannot tell: ask git (it retries and says why), never assume pkg
    if (checkout) return { checkout: true };
    try { return { harness: String(d.pkgVersion() || ''), harnessSource: 'pkg', head: null, final: true }; }
    catch (e) { note('version.pkg', e); return { harness: '', harnessSource: 'unknown', head: null, final: true }; }
  }

  function runGit(args, timeoutMs) {
    return new Promise((resolve) => {
      try {
        d.execFile('git', args, { cwd: repoRoot, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 20 },
          (error, stdout, stderr) => resolve({ error: error || null, stdout: String(stdout || ''), stderr: String(stderr || '') }));
      } catch (e) { resolve({ error: e, stdout: '', stderr: '' }); }   // a spawn that throws (EMFILE, ENOMEM) is one more failed attempt
    });
  }

  // one step with retries: the trimmed stdout, or { exhausted: lastCause } once the attempts or the budget run out
  // (each failed attempt noted with its measured cause)
  async function attempts(step, args) {
    const deadline = now() + cfg.budgetMs;
    let last = '';
    for (let n = 1; n <= cfg.maxAttempts; n++) {
      const timeoutMs = Math.max(cfg.minAttemptMs, Math.min(cfg.attemptTimeoutMs, deadline - now()));
      const r = await runGit(args, timeoutMs);
      const out = r.error ? '' : r.stdout.trim();
      if (out) return out;
      last = failureCause(r, timeoutMs);
      note('version.git.attempt', new Error('git ' + step + ' attempt ' + n + '/' + cfg.maxAttempts + ' failed: ' + last));
      const wait = backoff[Math.min(n - 1, backoff.length - 1)];
      if (n >= cfg.maxAttempts || now() + wait + cfg.minAttemptMs > deadline) break;
      await sleep(wait);
    }
    return { exhausted: last || 'failed' };
  }

  async function resolveGit() {
    const desc = await attempts('describe', ['describe', '--always', '--dirty', '--tags']);
    if (typeof desc !== 'string') {
      phase = 'failed'; failedAt = now();
      note('version.git.exhausted', new Error('git describe gave no build id within the retry budget (last: ' + desc.exhausted +
        '); harnessSource reads unknown, and a read after ' + cfg.retryAfterMs + ' ms asks git again'));
      return;
    }
    const head = await attempts('rev-parse', ['rev-parse', 'HEAD']);
    if (typeof head !== 'string') note('version.git.exhausted', new Error('git rev-parse HEAD failed within the retry budget (last: ' + head.exhausted + '); buildSha stays blank'));
    resolved = { harness: desc, head: typeof head === 'string' ? head : null };
    phase = 'resolved';
  }

  function kick() {
    if (inFlight) return inFlight;
    phase = 'resolving';
    inFlight = resolveGit()
      .catch((e) => { phase = 'failed'; failedAt = now(); note('version.git.exhausted', e); })
      .then(() => { inFlight = null; });
    return inFlight;
  }

  function read() {
    if (!decided) decided = decide();
    if (!decided.checkout) return Object.assign({}, decided);
    if (phase === 'resolved') return { harness: resolved.harness, harnessSource: 'git', head: resolved.head, final: true };
    if (phase === 'idle' || (phase === 'failed' && now() - failedAt >= cfg.retryAfterMs)) kick();
    return { harness: '', harnessSource: 'unknown', head: null, final: false };
  }

  function settled(maxWaitMs) {
    const first = read();
    if (first.final || !inFlight) return Promise.resolve(first);
    const bound = Number.isFinite(Number(maxWaitMs)) && Number(maxWaitMs) >= 0 ? Number(maxWaitMs) : cfg.settleMs;
    return Promise.race([inFlight, sleep(bound)]).then(() => read(), (e) => { note('version.settle', e); return read(); });
  }

  function idle() { return inFlight ? inFlight.then(() => undefined) : Promise.resolve(); }

  return { read, settled, idle };
}

module.exports = { makeVersionSource, DEFAULTS };
