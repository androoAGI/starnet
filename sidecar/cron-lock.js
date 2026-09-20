/* sidecar/cron-lock.js — the cross-process advisory lock that makes cron fire EXACTLY ONCE (G4.3).

   The problem (mirrors the reference harness' .tick.lock / .jobs.lock): the in-process tickInFlight guard
   (cron-driver.applyTick) stops a re-entrant tick in ONE process, but two sidecars sharing one
   WORKSPACES dir — or a second sidecar booting and running its resume-reconcile while the first's
   timer fires — would BOTH read the same due store and BOTH launch the run (double-fire), and a CRUD
   save in one process can clobber an advance persisted by the other (last-write-wins on the jobs
   mirror). This module serializes every cron WRITE (applyTick AND each CRUD saveCronJobs/setJobs)
   behind one advisory lockfile so at most one writer is ever in the critical section.

   Windows has NO flock, so this is the PORTABLE O_EXCL + pid:nonce + READ-BACK-VERIFY path with an
   mtime-based stale break (mirrors the cron lease ceiling) so a crashed holder never wedges cron
   forever:

     ACQUIRE
       1. open(lockfile, 'wx')  — O_EXCL create. If it succeeds, write our `pid:nonce`, close, then
          READ IT BACK and verify it is byte-for-byte ours (defends against a torn write / a racer
          that O_EXCL-won between our create and our read). Verified -> we hold it.
       2. EEXIST -> the lock is held. stat it: if mtimeMs is within maxRunMs the holder is LIVE ->
          we do NOT acquire (the caller's tick/write is a no-op this pass). If it is STALE (older than
          maxRunMs, a crashed holder), RECLAIM it atomically:

       ATOMIC RECLAIM (the TOCTOU bug this lock exists to prevent — a SINGLE atomic step, the loser
       no-ops): rename(lockfile -> lockfile + '.' + pid + '.' + nonce + '.reclaim'). renameSync over
       an existing source is atomic and exactly ONE of two racers can move the ORIGINAL stale file —
       the loser's rename gets ENOENT (the file is already gone) and NO-OPS (returns not-acquired).
       The winner then O_EXCL-creates the fresh lockfile with our pid:nonce, reads it back, verifies,
       and unlinks the stamped reclaim file. Two processes both observing the stale lock can NOT both
       proceed: only the rename WINNER ever reaches the O_EXCL create.

     RELEASE  — unlink the lockfile, but ONLY if it still carries OUR pid:nonce (a later stale sweep
       may have reclaimed+replaced it; we must not unlink a successor's lock).

   Determinism: pure injected I/O. now() and the nonce are INJECTED (the nonce defaults to a lazy
   node:crypto only when not supplied), pid is injected-or-process.pid — there is NO Date.now /
   new Date() / Math.random literal here, so it passes lint-determinism.js (same shape as
   durable-write.js).

   makeCronLock({ fs, path, lockfile, now, maxRunMs, pid?, nonce?, reclaimByAge? }) -> { withLock(fn), release, _internals }
     fs       : node:fs (needs openSync/writeSync/closeSync/readFileSync/statSync/renameSync/unlinkSync).
     path     : node:path (unused today; accepted for symmetry / future dir work).
     lockfile : absolute path to the advisory lockfile (e.g. WORKSPACES/cron.lock).
     now      : () -> ms wall clock — used only for the stale-age comparison against statSync mtime.
     maxRunMs : a lock older than this is STALE and reclaimable (mirror the cron lease ceiling).
     reclaimByAge: defaults true for bounded cron work. Set false for an unbounded critical section
                (workspace recovery) where a live holder must NEVER be stolen merely because it is old.
     pid      : optional holder id (defaults to process.pid). nonce: optional ()->string (defaults
                to a crypto random hex) — pid:nonce is the holder stamp written + read-back-verified. */
'use strict';

function defaultNonce() {
  try { return require('node:crypto').randomBytes(8).toString('hex'); }
  catch (_) { try { return require('crypto').randomBytes(8).toString('hex'); } catch (__) { return 'x'; } }
}

// isPidAlive — default liveness probe: process.kill(pid, 0) throws ESRCH when the pid is gone (reclaimable),
// but EPERM means the process EXISTS under another owner (alive — do NOT reclaim). A non-numeric/zero/self pid,
// or any environment without process.kill, is treated conservatively as ALIVE so we never steal a live lock.
function defaultPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return true;               // no/garbage pid stamp -> can't prove dead -> alive
  if (typeof process === 'undefined' || typeof process.kill !== 'function') return true;
  if (typeof process.pid === 'number' && n === process.pid) return true;   // our own pid is obviously alive
  try { process.kill(n, 0); return true; }                        // signal 0 = existence probe; no throw -> alive
  catch (e) {
    return !(e && e.code === 'ESRCH');                          // only absence proves death; unknown errors stay busy
  }
}

function makeCronLock(deps) {
  const d = deps || {};
  const fs = d.fs;
  const lockfile = d.lockfile;
  const now = typeof d.now === 'function' ? d.now : function () { return 0; };
  const maxRunMs = d.maxRunMs || (8 * 60 * 1000);
  const reclaimByAge = d.reclaimByAge !== false;
  const pid = (d.pid != null) ? d.pid : (typeof process !== 'undefined' && process.pid) || 0;
  // injected-or-console diagnostic line (a release that cannot unlink must never be silent).
  const warn = typeof d.warn === 'function' ? d.warn : function (m) { try { console.warn('[cron-lock] ' + m); } catch (_) {} };
  const nonceFn = typeof d.nonce === 'function' ? d.nonce : defaultNonce;
  /* bootedAt: wall-clock ms of the current OS boot — OPT-IN, exactly like workspace-owner.js (the factory
     default is inert so injected fake clocks in tests are never compared against the real machine's boot).
     WHY THIS EXISTS (the DEAD-END SCREENS law, 2026-08-22: PIDs RESET AT BOOT): with reclaimByAge:false the
     pid probe was the ONLY reclaim path, and after crash + reboot the stamped pid usually belongs to some
     unrelated live process — kill(pid,0) then says ALIVE FOREVER, the lock never breaks, and the recovery
     caller exits 73 on every launch. A lockfile whose mtime predates this boot cannot have a live holder
     (every pre-boot process is dead by definition), torn/malformed stamps included. 60s slack absorbs
     os.uptime() skew so a holder that locked seconds after boot is never misjudged. */
  const bootedAt = typeof d.bootedAt === 'function' ? d.bootedAt : function () { return 0; };
  const BOOT_SLACK_MS = 60 * 1000;
  function predatesBoot() {
    const b = Number(bootedAt()) || 0;
    if (!(b > 0)) return false;
    try {
      const st = fs.statSync(lockfile);
      const m = (st && typeof st.mtimeMs === 'number') ? st.mtimeMs : (st && st.mtime ? st.mtime.getTime() : 0);
      return m > 0 && m < (b - BOOT_SLACK_MS);
    } catch (_) { return false; }
  }
  // injected for tests; defaults to the process.kill(pid,0) probe. Returns true when the holder pid is (or may be)
  // alive, false only when we can PROVE the holder process is gone.
  const pidAlive = typeof d.pidAlive === 'function' ? d.pidAlive : defaultPidAlive;
  if (!fs || typeof fs.openSync !== 'function' || typeof fs.renameSync !== 'function') {
    throw new Error('cron-lock: an injected fs with openSync/renameSync is required');
  }
  if (!lockfile) throw new Error('cron-lock: a lockfile path is required');

  // our holder stamp for the CURRENT acquisition (set on acquire, cleared on the OUTERMOST release).
  let heldStamp = null;
  // re-entrancy depth: nested withLock/acquire+release pairs in the SAME instance (e.g. applyTick wrapped
  // in the lock calling setJobs -> saveCronJobs, itself lock-wrapped) must NOT drop the lock until the
  // OUTERMOST release. Each acquire that finds the lock already held bumps the depth; each release decrements
  // and only the one that hits zero unlinks. This makes the lock a re-entrant mutex within one process.
  let depth = 0;

  function stamp(n) { return pid + ':' + n; }

  // O_EXCL-create the lockfile with our stamp, then READ IT BACK and verify it's ours. Returns the
  // stamp on success, null if the create lost the race (EEXIST) or the read-back is not ours.
  function tryCreateOwn() {
    const n = nonceFn();
    const mine = stamp(n);
    let fd = null;
    try {
      fd = fs.openSync(lockfile, 'wx');     // O_EXCL | O_CREAT | O_WRONLY — fails EEXIST if present
      fs.writeSync(fd, mine);
    } catch (e) {
      if (fd != null) {
        try { fs.closeSync(fd); } catch (_) {}
        // The O_EXCL create SUCCEEDED (fd is ours) but the stamp write failed (ENOSPC/EIO): the file on disk
        // is OUR empty/torn orphan. Leaving it blocked every acquirer for a full maxRunMs (fresh mtime, no
        // parseable pid -> neither reclaim path fires) — and FOREVER for reclaimByAge:false callers. Remove
        // what we created; a racer cannot own this inode (wx guarantees it is ours).
        try { fs.unlinkSync(lockfile); } catch (e2) { warn('could not remove own torn lockfile (' + ((e2 && e2.code) || e2) + ') — own-pid reclaim will recover it'); }
      }
      return null;                          // EEXIST (someone holds it) or a write error -> not ours
    }
    try { fs.closeSync(fd); } catch (_) {}
    // READ-BACK VERIFY: confirm the bytes on disk are exactly ours (no torn write / no racer clobber).
    let back = '';
    try { back = String(fs.readFileSync(lockfile, 'utf8')); } catch (_) { return null; }
    return back === mine ? mine : null;
  }

  // Is the existing lockfile STALE (older than maxRunMs)? A missing file is treated as not-stale here
  // (the EEXIST branch only runs when the create saw it present); a stat error is conservatively
  // treated as NOT stale so we never reclaim a lock we cannot prove is dead.
  function isStale() {
    try {
      const st = fs.statSync(lockfile);
      const mtime = (st && typeof st.mtimeMs === 'number') ? st.mtimeMs : (st && st.mtime ? st.mtime.getTime() : 0);
      return (now() - mtime) > maxRunMs;
    } catch (_) { return false; }
  }

  // deadHolder — is the CURRENT lockfile held by a pid we can prove is no longer alive? Reads the stamp
  // (pid:nonce), parses the pid, and probes it. A missing/unreadable/malformed lockfile, OR a live/unprovable
  // pid, returns false (fall back to the mtime stale break — never reclaim a lock we can't prove is dead).
  // This closes the gap where a crash-killed sidecar's lock would otherwise mute cron for the full maxRunMs.
  function deadHolder() {
    if (predatesBoot()) return true;                // a pre-boot lockfile's holder is gone by definition (torn stamp included)
    let raw = '';
    try { raw = String(fs.readFileSync(lockfile, 'utf8')); } catch (_) { return false; }
    const i = raw.indexOf(':');
    if (i <= 0) return false;                       // no pid segment -> can't prove dead
    const holderPid = Number(raw.slice(0, i));
    if (!Number.isInteger(holderPid) || holderPid <= 0) return false;
    // OUR OWN pid stamped while THIS instance believes it holds nothing = a leaked self-lock (a release whose
    // unlink failed — EBUSY from an AV/indexer is live on the Windows path this module exists for). Without
    // this the pid probe says "alive" (it's us!) and we lock OURSELVES out of cron for a full maxRunMs.
    // Safe: one lock instance per lockfile per process (the composition root), so no live acquisition of
    // this file can exist in-process while heldStamp is null.
    if (holderPid === Number(pid) && !heldStamp) return true;
    return !pidAlive(holderPid);                    // proven-dead pid -> reclaimable NOW (don't wait for mtime)
  }

  // claimStaleRename — the SINGLE atomic mutual-exclusion step of a stale reclaim: rename the stale
  // lockfile OUT of the way to OUR uniquely-stamped reclaim name. renameSync of the ORIGINAL stale
  // inode can succeed for exactly ONE racer; every other racer's rename of that same source gets ENOENT
  // (it is already gone) and returns null (no-op). This is the TOCTOU-safe claim: two processes that
  // BOTH passed the stale check can NOT both move the original — only the winner gets a reclaim path.
  function claimStaleRename() {
    const reclaimPath = lockfile + '.' + pid + '.' + nonceFn() + '.reclaim';
    try {
      fs.renameSync(lockfile, reclaimPath);   // <-- the one atomic step; the loser hits ENOENT
      return reclaimPath;
    } catch (e) {
      return null;                            // lost the race (the original was already moved) -> no-op
    }
  }

  // tryReclaimStale — claim the stale lock atomically (above), then, ONLY as the rename winner, O_EXCL-
  // create a fresh lock under our stamp (read-back-verified) and drop the stamped stale file. Returns
  // our stamp on success, null if we lost the rename race OR the fresh create itself lost a brand-new
  // race (caller no-ops either way).
  function tryReclaimStale() {
    const reclaimPath = claimStaleRename();
    if (!reclaimPath) return null;            // we did NOT move the original stale inode -> no-op
    const mine = tryCreateOwn();              // O_EXCL fresh lock; a concurrent recreate serializes here
    try { fs.unlinkSync(reclaimPath); } catch (_) {}   // best-effort cleanup of the stamped stale file
    return mine;
  }

  // acquire() -> true if we now hold the lock (heldStamp set), false otherwise (caller no-ops this pass).
  // Re-entrant: a second acquire by the SAME instance that already holds it bumps the depth and succeeds.
  function acquire() {
    if (heldStamp) { depth++; return true; }   // already held by this instance -> re-entrant (depth-counted)
    let mine = tryCreateOwn();
    if (!mine) {
      // Bounded cron work may reclaim at its explicit age ceiling; unbounded callers disable that path.
      // Every caller may reclaim a PROVABLY dead holder immediately. With reclaimByAge:false, a LIVE or
      // unprovable holder is respected forever rather than risking concurrent entry.
      if ((reclaimByAge && isStale()) || deadHolder()) mine = tryReclaimStale();
    }
    if (mine) { heldStamp = mine; depth = 1; return true; }
    return false;
  }

  // release() -> decrement the re-entrancy depth; only the OUTERMOST release (depth -> 0) actually drops the
  // lock, and only if it still carries OUR stamp (a stale sweep may have reclaimed+replaced it with a
  // successor's — never unlink that).
  function release() {
    if (!heldStamp) return;
    if (depth > 1) { depth--; return; }   // an inner (nested) release — keep the lock for the outer scope
    const mine = heldStamp;
    heldStamp = null; depth = 0;
    let cur = null;
    try { cur = String(fs.readFileSync(lockfile, 'utf8')); } catch (_) { return; /* already gone — nothing to release */ }
    if (cur !== mine) return;                        // a stale sweep replaced it — never unlink a successor's lock
    try { fs.unlinkSync(lockfile); }
    catch (e) {
      // A FAILED unlink is the OPPOSITE of "nothing to release": our own live-pid stamp stays on disk and
      // blocks every later acquire (self-heals via the own-pid deadHolder branch, but say it out loud —
      // silent here meant "ticks stopped for 8 minutes" with no log line explaining why).
      warn('cron-lock: release could not unlink ' + lockfile + ' (' + ((e && e.code) || e) + ') — own-pid reclaim will recover it');
    }
  }

  // withLock(fn) — acquire, run fn() if acquired (else NO-OP this pass), always release on the way out.
  // Returns { ran:bool, result } so callers can tell an executed write from a no-op (lock-held) pass.
  function withLock(fn) {
    if (!acquire()) return { ran: false, result: undefined };
    let result, threw = null;
    try { result = (typeof fn === 'function') ? fn() : undefined; }
    catch (e) { threw = e; }
    finally { release(); }
    if (threw) throw threw;
    return { ran: true, result: result };
  }

  return { withLock: withLock, release: release, _internals: { acquire: acquire, release: release, tryCreateOwn: tryCreateOwn, claimStaleRename: claimStaleRename, tryReclaimStale: tryReclaimStale, isStale: isStale, deadHolder: deadHolder } };
}

module.exports = { makeCronLock, _internals: { defaultPidAlive } };
