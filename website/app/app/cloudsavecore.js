/* STARNET — cloudsavecore.js : the pure, testable brain of the durable-mirror sync.

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

  /* WHY THE NEWEST SAVE IS NOT IN THE STATION FILE (wave-1 save-latch-kill; gh#121, starnet-releases#4). One name per failed
     attempt, read by the save light, the update drain and diagnostics alike. Taken ONLY from what the station answered, or
     from the fact that it did not answer: the disk is named only when the station said ENOSPC (diskFull) or EPERM/EACCES
     (diskDenied) — every failure streak used to read "check disk space" on machines with plenty of disk.
       offline           no answer (network, timeout, a reply that did not parse)
       forbidden         401/403: the station refused this window's connection
       tooLarge          413: the save is over the 16 MiB the station file takes (sidecar/save-wire.js)
       diskFull          the write failed with ENOSPC
       diskDenied        the write failed with EPERM / EACCES
       writeFailed       the write failed with another errno (a locked file, …): never called the disk
       unreadable        the station file could not be read, so it was not overwritten
       conflict          refused as another window's change
       degraded          the workspace was written by a newer StarNet
       growthStale       refused until this window catches up on rating history
       growthUnavailable the rating history could not be read
       refused           any other refusal (an answer without ok:true) */
  const CAUSES = Object.freeze(['offline', 'forbidden', 'tooLarge', 'diskFull', 'diskDenied', 'writeFailed', 'unreadable', 'conflict', 'degraded', 'growthStale', 'growthUnavailable', 'refused']);
  function isCause(c) { return CAUSES.indexOf(c) !== -1; }
  // o: { answered: did the station reply at all, status: its HTTP status, body: its parsed JSON (or null) }
  function causeOf(o) {
    o = o || {};
    if (!o.answered) return 'offline';
    const status = Number(o.status) || 0;
    const b = o.body && typeof o.body === 'object' ? o.body : {};
    if (b.conflict === true) return 'conflict';
    if (b.degraded === true) return 'degraded';
    if (status === 413 || b.tooLarge === true) return 'tooLarge';
    if (b.cause === 'diskFull' || b.code === 'ENOSPC') return 'diskFull';
    if (b.cause === 'diskDenied' || b.code === 'EPERM' || b.code === 'EACCES') return 'diskDenied';
    if (b.unreadable === true) return 'unreadable';
    if (b.growthStale === true) return 'growthStale';
    if (b.growthUnavailable === true) return 'growthUnavailable';
    if (status === 401 || status === 403) return 'forbidden';
    if (typeof b.code === 'string' && /^E[A-Z0-9]{2,20}$/.test(b.code)) return 'writeFailed';
    return 'refused';
  }
  // the cause in words — ONE table for the save light (stationui.js) and the update drain (updates.js). The disk is named only
  // for diskFull / diskDenied.
  function describeCause(cause) {
    switch (cause) {
      case 'tooLarge': return 'this station is too large to save: the station file takes up to 16 MiB';
      case 'diskFull': return 'the disk that holds the station file is full';
      case 'diskDenied': return 'the station file’s folder refused the write (check its permissions)';
      case 'writeFailed': return 'the station file could not be written';
      case 'unreadable': return 'the station file could not be read right now, so it was not overwritten';
      case 'forbidden': return 'StarNet refused this window’s connection — reload the window';
      case 'growthStale': return 'this window is catching up on rating history first';
      case 'growthUnavailable': return 'the rating history could not be read';
      case 'degraded': return 'this station’s data was written by a newer StarNet';
      case 'conflict': return 'another window saved newer station changes';
      case 'refused': return 'the station refused the save';
      default: return 'StarNet’s station service did not answer';
    }
  }

  /* STRUCTURAL EQUALITY of two JSON values (save-latch-kill review: the in-session merge compares a window's save with the
     one the station took from it, session by session). No stringify, no allocation: a station of thousands of sessions is
     compared in place. Keys whose value is undefined count as absent, as JSON.stringify would drop them. */
  function deepEq(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return (typeof a === 'number' && typeof b === 'number' && a !== a && b !== b);
    const arr = Array.isArray(a);
    if (arr !== Array.isArray(b)) return false;
    if (arr) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i])) return false;
      return true;
    }
    let n = 0;
    for (const k in a) {
      if (!Object.prototype.hasOwnProperty.call(a, k) || a[k] === undefined) continue;
      n++;
      if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEq(a[k], b[k])) return false;
    }
    for (const k in b) if (Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined) n--;
    return n === 0;
  }

  /* WHAT THIS WINDOW CHANGED SINCE THE STATION LAST TOOK ITS WORK (save-latch-kill review). A window that another window has
     saved past keeps its own view, and every save it makes after that is MERGED into the station file (sidecar/save-merge.js,
     POST /api/save with _saveMerge) instead of written over it. The merge is three-way: it needs what this window's view was
     when the station last took it (`base`: the save the station accepted or merged from this window, or the station save the
     window opened on), and this module names, without sending the whole base again, what changed since:
       top   [{ k, b? }]          a save field (not the sessions) this window changed, with its value in the base (none: added)
       rows  [{ id, b?, bLen? }]  a session this window changed or added: b = the session as the base had it (none: new). When
                                  the base's turns are the start of this window's turns (it only added turns), b goes without
                                  its history and bLen = how many turns the base had.
       gone  [id]                 a session the base had and this window no longer has (deleted)
     Unchanged sessions are not listed: the station keeps its own copy of them, with whatever another window did to them.
     `unsure` ({ doc, ids } | null): saves sent since `base` whose answer never came — the station may hold them, or not. A
     session any of them held that this window no longer has is listed gone (deleted after it was sent: a delete of something
     the station never got is nothing), and a field or session this window set back to the base after sending it is listed
     against what it sent, so a change the station may have taken is undone too (review 10-27 seeded run: a merge whose
     answer was lost, then a delete of the session it added, came back). */
  const MERGE_OWN = ['_saveRevision', '_saveClient', '_saveDirty', '_saveMerge', '_saveRestore', '_saveAdoptBy', 'updatedAt', 'workstreams'];
  function sessions(doc) { return doc && Array.isArray(doc.workstreams) ? doc.workstreams.filter(w => w && typeof w === 'object' && typeof w.id === 'string' && w.id) : []; }
  function turns(w) { return Array.isArray(w && w.history) ? w.history : []; }
  function mergeDelta(base, mine, unsure) {
    const top = [], rows = [], gone = [];
    const b = base && typeof base === 'object' ? base : {}, m = mine && typeof mine === 'object' ? mine : {};
    const u = unsure && unsure.doc && typeof unsure.doc === 'object' ? unsure.doc : null;
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
    const keys = new Set(Object.keys(b).concat(Object.keys(m), u ? Object.keys(u) : []));
    for (const k of keys) {
      if (MERGE_OWN.indexOf(k) !== -1) continue;
      if (!deepEq(b[k], m[k])) top.push(has(b, k) ? { k, b: b[k] } : { k });
      else if (u && !deepEq(u[k], m[k])) top.push(has(u, k) ? { k, b: u[k] } : { k });   // set back after it was sent
    }
    const before = new Map(sessions(b).map(w => [w.id, w]));
    const sent = u ? new Map(sessions(u).map(w => [w.id, w])) : null;
    const seen = new Set();
    for (const w of sessions(m)) {
      seen.add(w.id);
      const was = before.get(w.id);
      if (!was) { rows.push({ id: w.id }); continue; }
      if (deepEq(was, w)) { const s = sent && sent.get(w.id); if (s && !deepEq(s, w)) rows.push({ id: w.id, b: s }); continue; }
      const bh = turns(was), mh = turns(w);
      let p = 0;
      while (p < bh.length && p < mh.length && deepEq(bh[p], mh[p])) p++;
      if (p === bh.length) { const row = Object.assign({}, was); delete row.history; rows.push({ id: w.id, b: row, bLen: p }); }
      else rows.push({ id: w.id, b: was });
    }
    const had = new Set(before.keys());
    if (unsure && unsure.ids) for (const id of unsure.ids) had.add(id);
    for (const id of had) if (!seen.has(id)) gone.push(id);
    return { v: 1, top, rows, gone };
  }
  /* A REFUSED MERGE, BY KIND: 'permanent' — asking again cannot help (another station, a copy from before a reset, a newer
     save format, a workspace written by a newer StarNet): the window stops merging and its saves take the plain path, where
     a refusal stands as a conflict, as before; 'tooLarge' — this save, merged, is over the 16 MiB the station file takes:
     said as "too large" and asked again with the backoff (a smaller save can land; a whole-save boot merge treats it as
     permanent); 'absent' — there is no station file: the plain save puts this window's save there; anything else is passing
     (a locked file, the station moving mid-merge, a failed write): asked again with the backoff, never latched (review: one
     Windows file lock brought the wedge back). */
  function mergeRefusal(body, status) {
    const b = body && typeof body === 'object' ? body : {};
    if (Number(status) === 413 || b.tooLarge === true) return 'tooLarge';
    if (b.degraded === true || b.otherStation === true || b.predatesReset === true || b.newerFormat === true || b.mergeRefused) return 'permanent';
    if (b.absent === true) return 'absent';
    return 'passing';
  }

  // a fresh health record: nothing pushed yet, no failures.
  function freshHealth() {
    return { lastPushOkAt: 0, lastPushFailAt: 0, consecutiveFailures: 0, nextRetryAt: 0, cause: null };
  }

  // normalize any prior health (from another module / a partial object) into the full shape.
  function hydrate(h) {
    h = (h && typeof h === 'object') ? h : {};
    return {
      lastPushOkAt: num(h.lastPushOkAt),
      lastPushFailAt: num(h.lastPushFailAt),
      consecutiveFailures: Number.isFinite(h.consecutiveFailures) && h.consecutiveFailures > 0 ? Math.floor(h.consecutiveFailures) : 0,
      nextRetryAt: num(h.nextRetryAt),
      cause: h.consecutiveFailures > 0 && isCause(h.cause) ? h.cause : null
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
    return { lastPushOkAt: num(now), lastPushFailAt: h.lastPushFailAt, consecutiveFailures: 0, nextRetryAt: 0, cause: null };
  }

  // record a FAILED push at `now`: bumps the streak, stamps lastPushFailAt, schedules the next retry. `cause` (CAUSES): why
  // this attempt failed; an unnamed failure is 'offline' (nothing the station said can name it).
  function recordFailure(h, now, cause) {
    h = hydrate(h);
    const streak = h.consecutiveFailures + 1;
    return { lastPushOkAt: h.lastPushOkAt, lastPushFailAt: num(now), consecutiveFailures: streak, nextRetryAt: num(now) + backoffFor(streak), cause: isCause(cause) ? cause : 'offline' };
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
      stale: isStale(h, now),
      cause: h.cause
    };
  }

  return {
    RETRY_BASE_MS, RETRY_MAX_MS, STALE_AFTER_MS, WARN_AFTER_FAILURES,
    CAUSES, causeOf, describeCause, freshHealth, hydrate, backoffFor, recordSuccess, recordFailure, retryDue, isStale, isWarn, snapshot,
    deepEq, mergeDelta, mergeRefusal
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CloudSaveCore;
