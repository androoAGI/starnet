/* AGENT OS — cloudsavecore.js : the pure, testable brain of the durable-mirror sync.

   cloudsave.js does the I/O (fetch/beacon/timers); THIS module holds the state machine that
   decides "when do we retry?" and "is the durable mirror stale?" — no browser globals, no
   fetch, no DOM — so it can be unit-tested in Node exactly like updatecore.js.

   Two concerns:
     • Backoff schedule — after a failed flush, WHEN is the next attempt due? Capped exponential
       (5s → 30s → 2m, cap 5m), reset to base on the first success.
     • Health record — lastPushOkAt / lastPushFailAt / consecutiveFailures, plus a derived
       `stale` verdict the save-dot reads: persists are happening but the durable mirror hasn't
       accepted a write in a while AND at least one failure has occurred since. That verdict is
       what makes the UI TRUTHFUL — the dot only claims "backed up" when the backend can prove it.

   Every function is pure: give it the prior state + a clock reading, get the next state back. */
'use strict';

const CloudSaveCore = (() => {
  // backoff ladder: 5s, then double each failure, capped at 5m.
  const RETRY_BASE_MS = 5_000;
  const RETRY_MAX_MS = 5 * 60_000;      // 5 minutes
  // staleness: the durable mirror is "stale" once it has gone this long without a confirmed push
  // WHILE at least one failure has happened since the last success (a healthy quiet period is NOT stale).
  const STALE_AFTER_MS = 60 * 60_000;   // 60 minutes
  // early-warning threshold (EL-11 FIX 4): a live streak of this many consecutive failed pushes flips the
  // save-dot to a warn state IMMEDIATELY — a broken disk (EPERM/full) must not get a 60-minute blind window.
  const WARN_AFTER_FAILURES = 3;

  function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }

  // a fresh health record: nothing pushed yet, no failures.
  function freshHealth() {
    return { lastPushOkAt: 0, lastPushFailAt: 0, consecutiveFailures: 0, nextRetryAt: 0 };
  }

  // normalize any prior health (from another module / a partial object) into the full shape.
  function hydrate(h) {
    h = (h && typeof h === 'object') ? h : {};
    return {
      lastPushOkAt: num(h.lastPushOkAt),
      lastPushFailAt: num(h.lastPushFailAt),
      consecutiveFailures: Number.isFinite(h.consecutiveFailures) && h.consecutiveFailures > 0 ? Math.floor(h.consecutiveFailures) : 0,
      nextRetryAt: num(h.nextRetryAt)
    };
  }

  // the delay before the Nth consecutive failure's retry: base * 2^(n-1), capped. n is 1-based.
  function backoffFor(consecutiveFailures) {
    const n = Math.max(1, Math.floor(consecutiveFailures || 1));
    // 2^(n-1) can overflow for huge n; cap the exponent so we never produce Infinity before the min().
    const exp = Math.min(n - 1, 30);
    return Math.min(RETRY_BASE_MS * Math.pow(2, exp), RETRY_MAX_MS);
  }

  // record a SUCCESSFUL push at `now`: clears the failure streak + retry timer, stamps lastPushOkAt.
  function recordSuccess(h, now) {
    h = hydrate(h);
    return { lastPushOkAt: num(now), lastPushFailAt: h.lastPushFailAt, consecutiveFailures: 0, nextRetryAt: 0 };
  }

  // record a FAILED push at `now`: bumps the streak, stamps lastPushFailAt, schedules the next retry.
  function recordFailure(h, now) {
    h = hydrate(h);
    const streak = h.consecutiveFailures + 1;
    return { lastPushOkAt: h.lastPushOkAt, lastPushFailAt: num(now), consecutiveFailures: streak, nextRetryAt: num(now) + backoffFor(streak) };
  }

  // is a queued doc allowed to attempt a flush now, or is it still inside its backoff window?
  // (No failures yet → always allowed.)
  function retryDue(h, now) {
    h = hydrate(h);
    if (h.consecutiveFailures <= 0) return true;
    return num(now) >= h.nextRetryAt;
  }

  // TRUTHFUL staleness verdict for the save-dot. Stale ONLY when there is a live failure streak
  // AND the last confirmed push is older than STALE_AFTER_MS (or there has NEVER been one while
  // failures are accruing). A clean record — or a quiet period with no failures — is never stale.
  function isStale(h, now) {
    h = hydrate(h);
    if (h.consecutiveFailures <= 0) return false;            // nothing failing right now
    now = num(now);
    if (h.lastPushOkAt <= 0) return true;                    // never once succeeded, yet failing → stale
    return (now - h.lastPushOkAt) >= STALE_AFTER_MS;
  }

  // EARLY-WARNING verdict (EL-11 FIX 4): true once the live failure streak reaches WARN_AFTER_FAILURES,
  // regardless of how recent the last success was. Truthful and cheap: the streak IS the proof (a repeatedly
  // refused/erroring POST — disk full, EPERM, refused write), so the dot may advise within minutes, not after
  // the 60-minute stale line. Cleared by the first success (recordSuccess zeroes the streak).
  function isWarn(h) {
    h = hydrate(h);
    return h.consecutiveFailures >= WARN_AFTER_FAILURES;
  }

  // a stable, JSON-friendly snapshot for CloudSave.health() consumers (UI + tests).
  function snapshot(h, now) {
    h = hydrate(h);
    return {
      lastPushOkAt: h.lastPushOkAt,
      lastPushFailAt: h.lastPushFailAt,
      consecutiveFailures: h.consecutiveFailures,
      nextRetryAt: h.nextRetryAt,
      warn: isWarn(h),
      stale: isStale(h, now)
    };
  }

  return {
    RETRY_BASE_MS, RETRY_MAX_MS, STALE_AFTER_MS, WARN_AFTER_FAILURES,
    freshHealth, hydrate, backoffFor, recordSuccess, recordFailure, retryDue, isStale, isWarn, snapshot
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CloudSaveCore;
