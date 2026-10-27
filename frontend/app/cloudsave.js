/* STARNET — cloudsave.js : write the agent through to the durable sidecar, and pull it back on boot.

   localStorage is a fast CACHE that a browser wipe can erase. The sidecar's <workspaces>/<id>.save.json is the
   DURABLE copy (app-data dir, survives a cache wipe / different browser). This module keeps them in sync:

     • push(doc)      — debounced best-effort POST /api/save on every persist; coalesces bursts of turns. Called even
                        when the cache write failed (#121, { cacheFailed }): the station file is the store of record.
     • pull()         — GET /api/save?agent=agent → the stored envelope (or null).
     • reconcile(local) — on boot, adopt whichever of {local, remote} is NEWER (by updatedAt), write the winner
                          back into the localStorage cache, and nudge the server if local was ahead. This is
                          what restores the agent after a cache wipe: local is gone, remote brings it back.
     • installUnloadFlush() — a pagehide/visibility beacon so the LAST debounced save isn't lost on close.

   Best-effort throughout: if the sidecar is unreachable (e.g. the UI-only dev preview), every call fails soft
   and the localStorage cache still works exactly as before. No secret crosses the wire — the save envelope
   never contains the API key/tokens. */
'use strict';

const CloudSave = (() => {
  const AGENT_ID = 'agent';            // single agent per save today; mirrors the rest of the app
  const DEBOUNCE_MS = 1200;
  const ENDPOINT = '/api/save';        // same-origin: the sidecar serves the frontend in the real app

  // pure retry/health brain — see cloudsavecore.js (unit-tested in Node). Fail soft if it's absent
  // (order-of-load safety): a null-object Core keeps the old best-effort behavior with no retry/health.
  const Core = (typeof CloudSaveCore !== 'undefined') ? CloudSaveCore
    : (typeof require !== 'undefined' ? (() => { try { return require('./cloudsavecore.js'); } catch (_) { return null; } })() : null);

  const clientId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  let revision = 0, conflict = null, latestLocal = null, seeded = null;
  let timer = null;                    // debounce timer for a fresh push
  let retryTimer = null;               // backoff timer scheduling the next attempt after a failure
  let pending = null;                  // newest doc awaiting a flush (older queued docs are superseded)
  /* the exact string `pending` was cloned from (push's opts.raw), or null. It travels WITH the doc — into the flush that
     sends it and back into `pending` if that attempt fails — and nowhere else, so once the ACK has used it the string is
     garbage: never a second whole-save copy pinned beside latestLocal for the life of the page (idle CPU piece 3). */
  let pendingRaw = null;
  const activeFlushes = new Set();      // confirmable writes currently waiting on the sidecar
  // #121 BROWSER CACHE FULL. The whole save lives under one browser-storage key; past the browser's per-site cap its
  // write throws. persist() still queues that envelope here (write-through), flagged cacheFailed. While the newest
  // save is NOT in the cache, this module holds it in memory (memoryDoc) so re-entry never resumes the stale cache.
  let pendingCacheFailed = false;      // the doc in `pending` could not be written to the browser cache
  let cacheFailed = false;             // this page's newest save is not in the browser cache
  let cacheFailedConfirmed = false;    // ...and the station file has confirmed exactly that save (nothing newer queued)
  let memoryDoc = null;                // that newest save, while cacheFailed
  let cacheFailedReason = null;        // the browser's error name for that failure ('QuotaExceededError' = the cap)
  // push order, so a confirmation knows whether the cache entry is older than the save it confirms. Two saves can carry
  // the same millisecond updatedAt, so the stamp alone cannot tell a superseded entry from a newer queued one.
  let pushSeq = 0, pendingSeq = 0;     // the newest push, and the push that put `pending` there
  let cacheOkSeq = 0;                  // the newest push whose doc the browser cache DID hold
  let health = Core ? Core.freshHealth() : { lastPushOkAt: 0, lastPushFailAt: 0, consecutiveFailures: 0, nextRetryAt: 0 };
  let warnedStale = false;             // ONE console warn per failing↔healthy transition, never per attempt
  // EL-11 FIX 1: the sidecar REFUSES writes when the workspace was stamped by a NEWER StarNet — as an HTTP 200
  // body { ok:false, degraded:true }. That refusal gets its OWN persistent state (the save-dot renders it and
  // stationui explains it); it is NOT a transient network failure and must never stamp health OK.
  let degraded = false;
  // EL-11 FIX 2/3: the persisted quarantine/recovery marker the sidecar returned on the last pull (GET /api/save
  // carries `recovery`). The boot path reads it via recoveryNotice() and acks it after showing the honest notice.
  let lastRecovery = null;
  let lastLineage = null;
  // SAVE-UNKNOWN HONESTY: what the last pull() actually PROVED. 'empty' means the sidecar answered 200 and
  // definitively holds no save; 'forbidden' (auth 401/403) and 'unreachable' (network/timeout/5xx) mean we
  // could not ask — states that must NEVER be presented to the boot path as "no save exists".
  let lastPullOutcome = 'unreachable';   // until a pull settles, we have proven nothing
  // starnet-releases#4 Blocker 2: the catch-up a growthStale refusal asked for (resolves true once the re-synced save is queued)
  let staleCatchUp = null;
  // a restore into the station was accepted and this page is reloading onto it: it saves nothing more (restoreConflict)
  let retired = false;
  /* IN-SESSION MERGE (wave-1 save-latch-kill; gh#153, #121, starnet-releases#4 — "a desktop window plus a browser tab"). A
     conflict refusal used to LATCH: every later save of this window was refused and preserved, the station file froze for
     the rest of the session, and the banner never cleared until the Commander reloaded and so dropped this window's view.
     Now the station merges this window's NEWEST state the way it merges a reopening window's unsent save at boot (POST
     /api/save/adopt, sidecar handleSaveAdopt: additive, the station file the base whenever it can name its writer, this
     window's whole save kept beside it) and the window RE-ENTERS onto the merge (a reload onto the station file).
     NEVER SENT ON TOP OF THE MERGE: this window's in-memory view is the pre-merge one, so after a merge it sends nothing
     more and its revision stays the one it had — a change it persists before the reload lands in its browser copy as a
     dirty save on that OLD revision, which the next boot merges in turn. Sending that view at the merged revision would land
     and drop the other window's work; the station's revision check (CAS) is never relaxed for it.
     A change queued while the merge is on its way is merged too before the window re-enters. Only a merge the station
     REFUSES (another station, a reset, too large, …) leaves the conflict standing exactly as before — and this window then
     stops asking (mergeRefused); a merge that got no answer is asked again on the next refused save. A restore-armed save
     (RESTORE BACKUP) and a reset's refusals are never merged: they keep their own answers. */
  let mergeRefused = false;
  // the one boot save that is preserved, never merged: a dirty cache found while ANOTHER live tab shares it (reconcile's
  // liveTab) may be that tab's view, and merging it would move the station under the live tab (re-review 10-25)
  let preserveOnlySeq = 0;
  // an in-session merge reloads the page: its notice (app.js boot, mergeNotice) rides sessionStorage across that one reload
  const MERGE_NOTE_KEY = 'starnet.save.merged';
  /* WHERE THIS PAGE'S NEWEST SAVE IS (review 10-23 #1): the push seq of the newest doc the station file accepted, and of the
     newest doc a conflict refusal preserved beside it (in conflict.recovery). A restore may only retire this page when its
     newest push is in one of the two: otherwise the reload would drop it. */
  let landedSeq = 0, preservedSeq = 0;
  /* RESTORE BACKUP (backup.js importFile) asked to put a station back: the saves from that import on carry _saveRestore, so a
     reset generation's empty station file takes the Commander's chosen backup (savestore: explicitRestore). Only until the
     station ANSWERS one of them (review 10-23 r2 #1): landed, refused as a conflict (the file was not empty, so there was
     nothing to put back), or refused for any other reason. A page armed for its whole life could otherwise write a pre-reset
     station over a fresh one long after a later START FRESH. A send that got no answer (an outage) keeps it armed. */
  let restoreArmed = false, restoreSeq = 0;
  /* WHOSE WORK A CACHED SAVE IS (support reports 10-15…10-25: one window, the station "went back"). Every save this page
     writes names its window (`_saveClient`), in the browser cache too, so a page that died after its save landed but before
     the next one was sent left that next save in the cache NAMED. The reopened page continues that window's work: it sends
     under the dead window's id (`inherited`), which the station file names as its head's writer, so a newer save from it
     lands (savestore ownHead) — until the station gives one of those saves a REAL answer. Accepted: the station holds this
     page's line on its own revision, later saves are this page's own. Refused as a conflict: someone else wrote since, and
     this page is behind for real (hostile review 10-25 #3). A passing refusal (a locked file, a growth catch-up, an outage)
     keeps it, or the save that replaces the refused one would be sent as a stranger on the old revision (re-review N1). */
  let inherited = null;
  let lastHead = null;                 // GET /api/save's `head`: { client, requestUpdatedAt, revision } when the store can prove it
  const CLIENT_RE = /^[A-Za-z0-9_-]{1,80}$/;
  function writerId() { return inherited || clientId; }
  // the browser-cache key this page's save lives under
  function cacheKey() { return (typeof Save !== 'undefined' && Save && typeof Save.key === 'function') ? Save.key() : 'starnet.save'; }
  /* ANOTHER LIVE STARNET PAGE IN THIS BROWSER (re-review 10-25): two tabs share one browser cache, so a tab reopened while
     another runs is not a crash recovery. Every page answers a reopening page's "anyone here?"; a reopening page that hears an
     answer neither resends nor merges a dirty cache (that would move the station under the live tab): its save is preserved,
     as before. No BroadcastChannel (an old webview, a test) = nobody answers. */
  let pagesChannel = null;
  try {
    if (typeof BroadcastChannel === 'function') {
      pagesChannel = new BroadcastChannel('starnet-pages');
      pagesChannel.addEventListener('message', e => { const m = e && e.data; if (m && m.ping && m.from !== clientId && !retired) { try { pagesChannel.postMessage({ pong: m.ping, from: clientId }); } catch (_) {} } });
    }
  } catch (_) { pagesChannel = null; }
  function anotherPageOpen(ms) {
    if (!pagesChannel) return Promise.resolve(false);
    return new Promise(resolve => {
      const ping = clientId + ':' + now();
      let done = false, t = null;
      const on = e => { if (e && e.data && e.data.pong === ping) finish(true); };
      const finish = v => { if (done) return; done = true; if (t) clearTimeout(t); try { pagesChannel.removeEventListener('message', on); } catch (_) {} resolve(v); };
      try { pagesChannel.addEventListener('message', on); pagesChannel.postMessage({ ping, from: clientId }); } catch (_) { finish(false); return; }
      t = setTimeout(() => finish(false), ms);
    });
  }

  function now() { return Date.now(); }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function isSave(d) { return !!(d && typeof d === 'object' && d.schema === 'starnet.save' && d.agent && typeof d.agent === 'object'); }

  // this build's readable schema ceiling. A save/remote whose version exceeds this was written by a NEWER
  // StarNet and MUST NOT be adopted into the cache (that would clobber the local doc with fields this code
  // can't read). Mirror Save.CURRENT when available; fall back to a literal only if Save hasn't loaded yet.
  // The literal IS save.js CURRENT (test/cloudsave-version-fallback.test.js): a stale one called this build's own saves newer.
  function currentVersion() { return (typeof Save !== 'undefined' && Number.isFinite(Save.CURRENT)) ? Save.CURRENT : 6; }
  function isFutureSave(d) { return isSave(d) && num(d.version) > currentVersion(); }
  // the sentinel reconcile hands the boot path when a durable remote is from a newer build. Distinct object
  // (never a real save envelope) so the boot path can raise the honest "update the app" gate. localStorage is
  // left byte-unchanged — we never setItem a future remote.
  function futureSentinel(version) { return { __futureSave: true, version: num(version) }; }
  // SAVE-UNKNOWN sentinel: no local cache AND the durable side could not be READ (unreachable or auth-refused).
  // The boot path must gate on this — presenting the first-run creation ceremony here would assert "you have no
  // save" when the harness proved no such thing (the July-19 incident: a 403'd pull rendered genesis over an
  // intact 200KB save). Distinct object, never a real save envelope.
  function unknownSentinel(reason) { return { __saveUnknown: true, reason: String(reason || 'unreachable') }; }

  // NOTE: no `keepalive` here — browsers cap a keepalive body at 64KB, and a save with workstreams + station
  // can exceed that. The normal debounced flush is a plain fetch; the unload path uses sendBeacon instead.
  function postNow(doc) {
    const controller = new AbortController();
    let deadline;
    // Bound headers AND acknowledgement parsing. A hung body must release the serial
    // write queue, and its eventual late reply may not mark an expired attempt saved.
    const request = fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
      signal: controller.signal
    }).then(async response => ({ response, body: await response.json().catch(() => null) }));   // an unparseable body is still an answer: its status names the cause
    return Promise.race([request, new Promise((_, reject) => {
      deadline = setTimeout(() => {
        reject(new Error('save acknowledgement timed out'));
        controller.abort();
      }, 15000);
    })]).finally(() => clearTimeout(deadline));
  }

  // record a push outcome into the health brain + drive the one-warn-per-state-change console policy.
  // Kept fail-soft: a missing Core (order-of-load) just no-ops the telemetry, never throws.
  function markOk() {
    if (Core) health = Core.recordSuccess(health, now());
    else health = { lastPushOkAt: now(), lastPushFailAt: health.lastPushFailAt, consecutiveFailures: 0, nextRetryAt: 0 };
    if (warnedStale) { warnedStale = false; try { console.info('[cloudsave] durable mirror sync recovered.'); } catch (_) {} }
  }
  // cause: why this attempt failed, by name (CloudSaveCore.causeOf) — the save light and the update drain say it
  function markFail(cause) {
    if (Core) health = Core.recordFailure(health, now(), cause);
    else health = { lastPushOkAt: health.lastPushOkAt, lastPushFailAt: now(), consecutiveFailures: health.consecutiveFailures + 1, nextRetryAt: 0, cause: cause || 'offline' };
    // warn EXACTLY once when we first cross into stale territory — not once per attempt (no console spam,
    // no throw into callers). The UI save-dot carries the ongoing signal; this is just a dev breadcrumb.
    const stale = Core ? Core.isStale(health, now()) : false;
    if (stale && !warnedStale) {
      warnedStale = true;
      try { console.warn('[cloudsave] durable mirror has not synced; retrying with backoff. Local cache is intact.'); } catch (_) {}
    }
  }

  // GROWTH-STALE REFUSAL (starnet-releases#4 Blocker 2). The station refuses a save whose rating watermark
  // (stationStats.ratingSyncAt) trails its rating ledger, so a stale tab cannot erase acknowledged XP. That refusal is
  // right, and resending the same save can never pass it: only a rating catch-up advances the watermark. Ask XpStore for
  // one; on success it persists a fresh save (App.persist -> push), and THAT save is what the next attempt sends. Nothing
  // here touches the watermark, so the station's check still decides. Resolves true once the re-synced save is queued.
  function requestRatingCatchUp() {
    if (typeof XpStore === 'undefined' || !XpStore || typeof XpStore.catchUpRatings !== 'function') return null;
    try { return Promise.resolve(XpStore.catchUpRatings()).then(r => !!r && !r.failed, () => false); }
    catch (_) { return null; }
  }

  // (re)arm the backoff retry so a dropped push is never silently abandoned. Newest-wins: whatever is
  // in `pending` when the timer fires is what gets sent, so a burst during backoff still coalesces to one.
  function scheduleRetry() {
    if (retryTimer || !isSave(pending)) return;
    const delay = Core ? Math.max(0, num(health.nextRetryAt) - now()) : 5000;
    try { retryTimer = setTimeout(() => { retryTimer = null; flush(); }, delay); } catch (_) { retryTimer = null; }
  }

  // flush(opts) — attempt one POST of the newest pending doc.
  //   opts.force (default false): bypass the backoff-hold window. The normal debounced/retry path HONORS the
  //   backoff (a live failure streak that isn't due yet holds `pending` and re-arms). The pre-update-install
  //   drain (updates.js) has no future — the app is about to be killed by the NSIS installer — so it passes
  //   { force:true } for a single immediate best-effort attempt regardless of the backoff clock. It still
  //   fails soft (re-queues on failure like any flush), so if the install is somehow aborted the mirror keeps
  //   trying; the caller bounds the wait with its own timeout so a dead sidecar can never hang the update.
  function flush(opts) {
    // Keep one confirmed write at a time so our own queued snapshots share a causal revision.
    if (activeFlushes.size) return Promise.all(Array.from(activeFlushes)).then(() => flush(opts));
    const force = !!(opts && opts.force);
    if (timer) { clearTimeout(timer); timer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    // honor the backoff window — if a failure streak is live and the next attempt isn't due yet, hold the
    // doc in `pending` and re-arm rather than hammering the sidecar every debounce. `force` skips this hold.
    if (!force && Core && isSave(pending) && !Core.retryDue(health, now())) { scheduleRetry(); return Promise.resolve(false); }
    const doc = pending, docCacheFailed = pendingCacheFailed, docSeq = pendingSeq, sentRaw = pendingRaw; pending = null; pendingRaw = null; pendingCacheFailed = false;
    if (!isSave(doc) || retired) return Promise.resolve(false);
    const armed = restoreArmed && docSeq >= restoreSeq;
    // WHY this attempt failed, by name, from what the station answered (null until it fails; no answer at all = 'offline')
    let cause = null;
    const causeOf = (status, body) => Core && Core.causeOf ? Core.causeOf({ answered: true, status, body }) : 'refused';
    const attempt = postNow(armed ? Object.assign({}, doc, { _saveRestore: true }) : doc)
      .then(({ response: r, body }) => {
        // a non-ok HTTP status (e.g. 409 stale, 500) is a FAILURE, not a success — fetch only rejects on
        // network error, so we must inspect r.ok ourselves or we'd stamp health OK on a rejected write.
        // The body still names it: a 413 is "too large", an errno write failure carries its code (sidecar/save-wire.js).
        if (r && r.ok === false) { cause = causeOf(r.status, body); throw new Error('save HTTP ' + r.status); }
        // EL-11 FIX 1 ("the worst lie class"): the sidecar answers REFUSALS as HTTP 200 { ok:false, ... }
        // (degraded workspace / stale stamp / unreadable prior) — the status line alone is NEVER proof the
        // write landed. Parse the body: ok:false is a FAILED push, and degraded:true latches its own state.
        // Malformed replies prove nothing. Keep the snapshot pending until an explicit ok:true.
        if (body && typeof body === 'object') {
          if (armed && typeof body.ok === 'boolean') restoreArmed = false;   // the station answered the import's save: disarmed
          degraded = (body.ok === false && body.degraded === true);   // any parsed answer re-proves (or clears) the degraded verdict
          if (body.conflict) {
            inherited = null; if (body.recovery) preservedSeq = Math.max(preservedSeq, docSeq); markFail('conflict');
            // merged in-session and re-entered, never latched — unless the station already said it will not merge this page,
            // or the refusal is one a merge cannot answer (a RESET station file, erased work, a restore of a backup)
            if (!armed && !mergeRefused && !retired && docSeq !== preserveOnlySeq && body.reset !== true && body.predatesReset !== true) return mergeInSession(doc, docSeq, docCacheFailed, body);
            conflict = body; return false;
          }
          if (body.ok && Number.isInteger(body.revision)) {
            revision = body.revision;
            landedSeq = Math.max(landedSeq, docSeq);
            inherited = null;   // the station holds this page's line on its own revision now: later saves are this page's own
            // bug 5c019483: the station file was missing (no save, no backup) and THIS window's copy became it. Latched
            // for the save light, which says so once: the station is back on disk because this window held it.
            if (body.seeded === true) seeded = { revision: body.revision, at: now() };
            if (pending) pending._saveRevision = revision;
            try {
              const cachedRaw = localStorage.getItem('starnet.save');
              /* SERIALIZE ONCE (idle CPU piece 3, 2026-10-20). The cache still holds the very string this doc was cloned
                 from (push's raw): it is this doc, so mark it clean without re-parsing it and stringifying both sides
                 to compare. The bytes written are exactly what the compare path below writes: the same keys in the same
                 order, _saveRevision = the ACK's revision, _saveDirty false, the ACK's updatedAt when it sent one. Any
                 other cache content takes the compare path, unchanged. */
              const same = !pending && !!sentRaw && cachedRaw === sentRaw;
              const cached = same ? null : JSON.parse(cachedRaw);
              // A preceding ACK advances the queued document's revision before it is sent. Its localStorage
              // twin still has the older revision. Compare the actual document, not that transport metadata,
              // or the final successful save stays dirty and creates a false conflict on the next restart.
              const payload = d => JSON.stringify({ ...d, _saveClient: undefined, _saveRevision: undefined });
              if (same) {
                localStorage.setItem('starnet.save', JSON.stringify({ ...doc, _saveRevision: revision, _saveDirty: false,
                  ...(Number.isFinite(body.updatedAt) ? { updatedAt: body.updatedAt } : {}) }));
              } else if (!pending && cached && payload(cached) === payload(doc)) {
                cached._saveRevision = revision; cached._saveDirty = false;
                if (Number.isFinite(body.updatedAt)) cached.updatedAt = body.updatedAt;
                localStorage.setItem('starnet.save', JSON.stringify(cached));
              } else if (docCacheFailed && cacheOkSeq < docSeq && cached && num(cached.updatedAt) <= num(doc.updatedAt)) {
                // #121: the station file now holds a save NEWER than anything the cache could take. The cached copy is
                // a superseded ancestor; left in place, the next boot (or a re-entry) would resume it and revert the
                // station. removeItem cannot hit the storage cap. This holds even with a newer save queued: a queued
                // save the cache DID hold is itself the entry (cacheOkSeq), never dropped here; a queued save it could
                // not hold lives in memory meanwhile. (A cache entry newer than this doc came from another window and
                // is not ours to drop.)
                localStorage.removeItem('starnet.save');
              }
            } catch (_) {}
            // the station file confirmed this page's newest save while the cache could not hold it
            if (!pending && docCacheFailed && doc === memoryDoc) cacheFailedConfirmed = true;
          }
          staleCatchUp = (body.ok === false && body.growthStale === true) ? requestRatingCatchUp() : null;
          if (body.ok === false) { cause = causeOf(r && r.status, body); throw new Error('save refused: ' + (body.error || (body.unreadable ? 'existing record unreadable' : body.stale ? 'stale write' : 'unknown'))); }
        }
        if (!body || body.ok !== true) { cause = 'refused'; throw new Error('save acknowledgement missing'); }
        markOk();
        return true;
      })
      .catch(() => {
        markFail(cause || 'offline');   // no answer (network, the 15 s deadline) proves only that the station did not answer
        // re-queue the newest doc (newest-wins: a fresher push during the attempt already replaced it) and
        // arm the backoff retry. Fail soft — the cache is still authoritative locally, nothing throws out.
        // the string is dropped on a failure: an outage must not pin a second whole-save copy (the retry compares the old way)
        if (!isSave(pending)) { pending = doc; pendingRaw = null; pendingCacheFailed = docCacheFailed; pendingSeq = docSeq; }
        scheduleRetry();
        return false;
      });
    activeFlushes.add(attempt);
    attempt.then(() => { activeFlushes.delete(attempt); });
    return attempt;
  }

  // flush() returns false both when there was nothing pending (safe) and when a real pending write failed
  // (unsafe). Update installation needs that distinction so it can fail closed on an unproved newest save.
  async function flushForUpdate() {
    const hadPending = isSave(pending) || activeFlushes.size > 0 || !!conflict;
    let confirmed = true;
    // Drain dynamically, not from one snapshot: another debounced/explicit flush can start while an older
    // request is settling. Update preparation must not race any write that was already in flight.
    while (activeFlushes.size) {
      const outcomes = await Promise.all(Array.from(activeFlushes));
      confirmed = outcomes.every(ok => ok === true);
    }
    // A rejected active write re-queues its document, and a newer push may also have arrived while it was in
    // flight. Force one final, confirmable write of that newest pending state before the installer advances.
    if (isSave(pending)) confirmed = await flush({ force: true }) === true;
    // A growth-stale refusal asked for a rating catch-up: once it has queued the re-synced save, send that ONE time.
    // A catch-up that fails leaves the refusal standing, and the install stays paused.
    const catchUp = staleCatchUp; staleCatchUp = null;
    if (!confirmed && catchUp && await catchUp && isSave(pending)) confirmed = await flush({ force: true }) === true;
    // A flush may have started while the forced write was awaited. Settle it too, and fail closed if any caller
    // queued an even newer document that has not begun its durable write yet.
    while (activeFlushes.size) {
      const outcomes = await Promise.all(Array.from(activeFlushes));
      confirmed = confirmed && outcomes.every(ok => ok === true);
    }
    confirmed = confirmed && !isSave(pending) && !conflict;
    return { ok: !hadPending || confirmed, hadPending, flushed: hadPending && confirmed };
  }

  // queue a write-through; coalesces a burst of persists into one POST after the debounce settles.
  //   opts.cacheFailed (#121): the browser cache could not hold this doc. It is queued all the same (the station file is
  //   the store of record) and held in memory until a later doc lands in the cache again. opts.cacheError: the
  //   browser's error name, so the UI says "full" only when the browser reported its quota.
  //   opts.raw (idle CPU piece 3, 2026-10-20): the exact string Save.write produced for this doc. The clone is then one parse
  //   of it instead of a stringify + parse, and the ACK can tell the cache still holds this doc by comparing strings.
  //   opts.restore: RESTORE BACKUP's write of the chosen backup (see restoreArmed).
  function push(doc, opts) {
    if (!isSave(doc) || retired) return;
    if (opts && opts.restore === true) { restoreArmed = true; restoreSeq = pushSeq + 1; }   // this push and every later one
    const raw = opts && typeof opts.raw === 'string' ? opts.raw : null;
    doc = raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(doc));
    doc._saveRevision = revision;
    doc._saveClient = writerId();
    latestLocal = doc;
    pending = doc;                     // keep only the newest
    pendingRaw = raw;                  // …with the string it was cloned from (null: the old compare path)
    pendingCacheFailed = !!(opts && opts.cacheFailed);
    pendingSeq = ++pushSeq;
    if (!pendingCacheFailed) cacheOkSeq = pendingSeq;   // callers push without cacheFailed only for a doc the cache holds
    cacheFailed = pendingCacheFailed; cacheFailedConfirmed = false;
    memoryDoc = cacheFailed ? doc : null;
    cacheFailedReason = cacheFailed ? (String((opts && opts.cacheError) || '') || null) : null;
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, DEBOUNCE_MS);
  }

  // bounded so a hung/slow sidecar can never block boot — on timeout we abort and fall back to the local cache.
  function pull() {
    // DEV-ONLY fault injection (stranded-user testing law): with a SKYNET_DEV seed loaded, a localStorage flag
    // forces the pull outcome so the save-unknown gate's failure states can be WALKED in the live app.
    // Inert in production: __STARNET_DEV__ is only ever injected by a SKYNET_DEV=1 sidecar.
    try {
      if (typeof window !== 'undefined' && window.__STARNET_DEV__) {
        const f = localStorage.getItem('starnet.dev.pullFault');
        if (f === 'forbidden' || f === 'unreachable') { lastPullOutcome = f; return Promise.resolve(null); }
      }
    } catch (_) {}
    let ctl = null, t = null;
    try { ctl = new AbortController(); t = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, 2500); } catch (_) {}
    return fetch(ENDPOINT + '?agent=' + encodeURIComponent(AGENT_ID), { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(async r => {
        if (!r.ok) {
          // an auth refusal is its own truth — the sidecar is ALIVE but rejected us (lost/stale launch token).
          lastPullOutcome = (r.status === 401 || r.status === 403) ? 'forbidden' : 'unreachable';
          if (r.status === 503) {
            try { if ((await r.json()).unreadable === true) lastPullOutcome = 'unreadable'; } catch (_) {}
          }
          return null;
        }
        lastPullOutcome = 'unreachable'; // status alone cannot prove a readable or empty station
        return r.json();
      })
      .then(j => {
        if (j && typeof j === 'object') {
          // EL-11 FIX 1 (GB-9): the sidecar tells us at boot-read time the workspace is degraded — latch it
          // so the save-dot is honest from the first frame, not only after the first refused write.
          if (j.degraded === true) degraded = true;
          // EL-11 FIX 2/3: capture the persisted quarantine/recovery marker for the boot path's disclosure.
          if (j.recovery && typeof j.recovery === 'object') lastRecovery = j.recovery;
          if (j.lineage && typeof j.lineage === 'object') lastLineage = j.lineage;
          lastHead = (j.head && typeof j.head === 'object' && CLIENT_RE.test(String(j.head.client || '')) && Number.isInteger(j.head.revision)) ? j.head : null;
        }
        if (!j || typeof j !== 'object' || Array.isArray(j) || j.ok === false || j.error ||
            !Object.prototype.hasOwnProperty.call(j, 'save')) return null;
        const s = j.save;
        if (isSave(s)) { lastPullOutcome = 'save'; return s; }
        if (s === null) lastPullOutcome = 'empty';
        return null;
      })
      .catch(() => { lastPullOutcome = 'unreachable'; return null; })   // network fail/timeout/bad JSON -> we proved NOTHING
      .then(v => { if (t) clearTimeout(t); return v; });
  }

  // POST /api/save/adopt (sidecar handleSaveAdopt): merge a reopening window's unsent save into the station before the
  // window resumes. The cached save goes as it is (its own _saveClient, or none from an old build: the station decides
  // the base from it); the station writes the merge as `adopt-<this page's id>` (_saveAdoptBy), never as this page or that
  // window, so no later save of either one can pass for the merge's own writer. Bounded (a multi-MiB
  // station takes a moment): the answer { ok, revision, doc, base, added, extended, copied, backup, kept }, { refused: true }
  // when the station answered no, or null when no answer came (the merge may still have landed: reconcile reads again).
  let lastMerge = null;
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage) {
      const carried = sessionStorage.getItem(MERGE_NOTE_KEY);
      if (carried) { sessionStorage.removeItem(MERGE_NOTE_KEY); const m = JSON.parse(carried); if (m && typeof m === 'object') lastMerge = m; }
    }
  } catch (_) {}
  function adoptMerge(local) {
    let ctl = null, t = null;
    try { ctl = new AbortController(); t = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, 15000); } catch (_) {}
    return fetch(ENDPOINT + '/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, local, { _saveAdoptBy: clientId })), signal: ctl ? ctl.signal : undefined })
      .then(r => (r && r.ok) ? r.json() : null)
      .then(j => (j && j.ok === true && Number.isInteger(j.revision) && isSave(j.doc) && !isFutureSave(j.doc)) ? j : (j && j.ok === false) ? { refused: true } : null)
      .catch(() => null)
      .then(v => { if (t) clearTimeout(t); return v; });
  }

  // adoptMerge with the lost-answer recovery the boot merge has always had (re-review N3): no answer -> ask once more (safe to
  // repeat: it finds nothing to add, or this page's own merge); still none -> read the station and take a merge written as
  // this page (lastHead adopt-<this page>) past `before` as the answer. null = no answer and no proof it landed.
  async function adoptWithRecovery(local, before) {
    const answer = (await adoptMerge(local)) || (await adoptMerge(local));
    if (answer) return answer;
    let again = null;
    try { again = await pull(); } catch (_) { again = null; }
    if (isSave(again) && !isFutureSave(again) && lastHead && lastHead.client === 'adopt-' + clientId && num(again._saveRevision) > num(before))
      return { ok: true, doc: again, revision: num(again._saveRevision), base: 'unknown', late: true };
    return null;
  }
  function noteOf(m, inSession) {
    return { base: m.base, added: num(m.added), extended: num(m.extended), copied: num(m.copied), backup: m.backup || null, kept: m.kept || null, late: !!m.late, at: now(), ...(inSession ? { inSession: true } : {}) };
  }
  // the in-session merge (see mergeRefused above). Resolves false: the refused save did not land as it was.
  function mergeInSession(doc, seq, docCacheFailed, refusal) {
    return (async () => {
      let newest = doc, newestSeq = seq, newestCacheFailed = docCacheFailed, before = num(refusal && refusal.revision), merged = null;
      // every save is this window's WHOLE state, so a newer queued one supersedes the refused one: merge that instead
      const takeNewer = () => {
        if (!isSave(pending) || pendingSeq <= newestSeq) return false;
        newest = pending; newestSeq = pendingSeq; newestCacheFailed = pendingCacheFailed;
        pending = null; pendingRaw = null; pendingCacheFailed = false;
        return true;
      };
      takeNewer();
      let mergedSeq = 0;
      for (let round = 0; round < 4; round++) {
        const answer = await adoptWithRecovery(newest, before);
        if (!answer || answer.refused) {
          if (answer && answer.refused) mergeRefused = true;
          conflict = refusal;   // the old answer: the refused save is preserved on the station, the banner offers its ways out
          // a newer state taken off the queue was never sent: queue it again (the refused one is already preserved)
          if (newestSeq > seq && !isSave(pending)) { pending = newest; pendingSeq = newestSeq; pendingCacheFailed = newestCacheFailed; scheduleRetry(); }
          return false;
        }
        merged = answer; mergedSeq = newestSeq; before = num(answer.revision);
        // nothing newer was queued while it merged: the merge holds this window's newest state. Otherwise merge that too —
        // a state is only ever taken off the queue to be merged (never on the last round: it stays queued, below)
        if (!(isSave(pending) && pendingSeq > mergedSeq) || round === 3) break;
        takeNewer();
      }
      if (isSave(pending) && pendingSeq > mergedSeq) {
        // changes keep arriving faster than they merge: the merges so far stand; keep the newest queued and ask again
        try { setTimeout(() => flush(), 1000); } catch (_) {}
        return false;
      }
      // RE-ENTER the merge. From here this window sends nothing (retired) and its revision stays the pre-merge one (above).
      lastMerge = noteOf(merged, true);
      conflict = null;
      retired = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      // the browser copy becomes the merge, unless a newer change of this window is already in it (the next boot merges that)
      if (pushSeq === mergedSeq) {
        const at = cacheKey();
        try { localStorage.setItem(at, JSON.stringify(Object.assign({}, merged.doc, { _saveDirty: false }))); }
        catch (_) { try { localStorage.removeItem(at); } catch (_) {} }   // could not hold it: the station file has it
      }
      try { if (typeof sessionStorage !== 'undefined' && sessionStorage) sessionStorage.setItem(MERGE_NOTE_KEY, JSON.stringify(lastMerge)); } catch (_) {}
      try { if (typeof location !== 'undefined' && location && typeof location.reload === 'function') location.reload(); } catch (_) {}
      return false;
    })();
  }

  // pick the newer of local/remote, refresh the local cache to match, and push local up if it was ahead.
  // Returns the winning doc (or local/null) for the boot path to resume from.
  async function reconcile(local) {
    // FORWARD-VERSION GUARD (P0.3): a local cache written by a NEWER build must never be pushed up or resumed
    // by this older code. Surface the gate before we even pull — the boot path stops here and asks to update.
    if (isFutureSave(local)) return futureSentinel(num(local.version));
    let remote = null;
    try { remote = await pull(); } catch (_) { remote = null; }
    if (!isSave(remote)) {
      // No durable doc came back. WHY matters: 'empty' is the sidecar's definitive "no save here" (seed it
      // from local / genuinely first run). 'forbidden'/'unreachable' proved NOTHING — with no local cache
      // either, hand boot the save-unknown sentinel so it gates instead of onboarding over a possibly-intact
      // durable save it simply couldn't read.
      if (lastPullOutcome !== 'empty' && !isSave(local)) return unknownSentinel(lastPullOutcome);
      // 'empty': seed the server. The copy keeps its own revision: the station file has none, and savestore takes a copy
      // over a truly missing file at a revision no other window holds (bug 5c019483), unless this computer's station was reset after
      // the copy's station was founded (then the reply is a conflict with reset:true). Otherwise best-effort (fails soft, retries).
      revision = num(local && local._saveRevision);
      if (isSave(local)) push(local);
      return local;
    }
    // FORWARD-VERSION GUARD (P0.3): a durable remote from a NEWER build must NOT be adopted into the cache —
    // setItem-ing it and re-migrating would clobber the local doc with fields this build can't read (silent
    // contamination, brutal to debug). Leave localStorage byte-unchanged and raise the honest update gate.
    if (isFutureSave(remote)) return futureSentinel(num(remote.version));
    revision = num(remote._saveRevision);
    // The unload beacon may land after the old page can receive its ACK. On reload the
    // cache is still dirty, but an identical durable payload proves that exact edit landed.
    // Ignore only transport metadata; any changed station, roster, or conversation still
    // takes the conflict-preserving path below.
    const content = d => JSON.stringify({ ...d, updatedAt: undefined, _saveRevision: undefined, _saveClient: undefined, _saveDirty: undefined });
    if (isSave(local) && local._saveDirty && content(local) === content(remote)) {
      local = { ...local, updatedAt: remote.updatedAt, _saveRevision: revision, _saveDirty: false };
      try { localStorage.setItem('starnet.save', JSON.stringify(local)); } catch (_) {}
      return local;
    }
    // A DIRTY CACHE BEHIND THE STATION FILE, WRITTEN BY THE WINDOW THAT WROTE THE STATION FILE'S HEAD: that window saved,
    // then died before its ACK and its next save met (support reports 10-15…10-25). Its own saves are ordered, so a cache
    // saved after the head's request is that window's newer work: sent ONCE as that window (savestore ownHead takes it),
    // never this page's later saves. Anything else (a cache that reads as older — the clock can step back — or one this
    // proof does not cover) goes to the station's merge below, which keeps every side's work.
    const writer = isSave(local) && local._saveDirty && CLIENT_RE.test(String(local._saveClient || '')) ? local._saveClient : null;
    const founded = d => Number(d && d.agent && d.agent.createdAt);   // the same station (never a cache of another one)
    const ownHeadBehind = !!writer && !!lastHead && lastHead.client === writer && lastHead.revision === revision && num(local._saveRevision) < revision
      && (founded(local) === founded(remote) || (Number.isNaN(founded(local)) && Number.isNaN(founded(remote))));
    const dirtyBehind = isSave(local) && local._saveDirty && num(local._saveRevision) !== revision;
    const liveTab = dirtyBehind && await anotherPageOpen(250);   // a second tab, not a crash recovery: preserved as before
    if (!liveTab && ownHeadBehind && num(local.updatedAt) > num(lastHead.requestUpdatedAt)) {
      revision = num(local._saveRevision);
      inherited = writer;   // this page continues that window's work until the station answers one of its saves for real
      push(local);          // sent now: a stalled POST must never block local boot
      flush({ force: true });
      return local;
    }
    // A DIRTY CACHE ON ANOTHER REVISION THAT CANNOT LAND AS IT IS (a cache from 0.14.0 or earlier, which never named its
    // window; a head written by another window or a terminal; a cache that reads older than its own window's head):
    // refusing it froze the station file for the whole session, every save after it refused too. The station merges it
    // instead (POST /api/save/adopt: the station file is the base unless it cannot name its writer and the window saved
    // last; the other side's sessions come back into it; the station file is copied aside and the window's whole save kept)
    // and this window resumes the merge. When no answer came, the merge may still have landed: read the station again and
    // resume it if it did. Only a refused merge takes the old path: the save is preserved as a conflict copy.
    let merged = null;
    if (dirtyBehind && !liveTab) {
      const before = revision;
      // no answer: ask once more — safe to repeat (it finds nothing to add, or this page's own merge), and the only way to
      // learn of a merge that wrote nothing (re-review N3)
      const answer = await adoptWithRecovery(local, before);
      if (answer && !answer.refused) merged = answer;
      else if (answer && answer.refused) mergeRefused = true;   // the station said no: the in-session merge never asks again
      if (merged) { remote = merged.doc; revision = num(merged.revision); lastMerge = noteOf(merged, false); }
    }
    if (isSave(local) && local._saveDirty && !merged) {
      // Offline edits are still based on their original revision. Preserve them through the
      // same conflict receipt; never relabel a stale local snapshot with the remote revision.
      revision = num(local._saveRevision);
      push(local);   // preserve asynchronously; a stalled POST must never block local boot
      if (liveTab) preserveOnlySeq = pushSeq;
      return local;
    }
    if (merged || !isSave(local) || num(local._saveRevision) !== revision || num(remote.updatedAt) > num(local.updatedAt)) {
      // adopt remote into the cache, then re-read it through Save.load() so the MIGRATION LADDER runs on it.
      // The durable mirror is designed to outlive the cache and survive app updates, so it can legitimately be
      // an OLDER schema (v1/v2) than this build. resumeInto() assumes a current-schema doc (reads .workstreams,
      // expects .agent.stats); adopting a raw v1/v2 remote would silently drop history + skip the XP seed.
      const priorLocalRaw = (() => { try { return localStorage.getItem('starnet.save'); } catch (_) { return null; } })();
      let adopted = false, adoptError = null;
      try {
        const raw = JSON.stringify(remote);
        localStorage.setItem('starnet.save', raw);
        adopted = localStorage.getItem('starnet.save') === raw;
      } catch (e) { adoptError = String((e && (e.name || e.code)) || 'error') + (e && e.message ? ': ' + e.message : ''); }
      try {
        // re-validate through Save.load(): it re-checks the forward-version guard on the just-adopted doc and
        // runs the migration ladder. A migrated, current-schema save is the only thing we hand back.
        const migrated = adopted && (typeof Save !== 'undefined' && Save.load) ? Save.load() : null;
        if (isSave(migrated) && num(migrated.version) <= currentVersion()) return migrated;
      } catch (_) {}
      // #121: the cache could not take the station file's save (the browser's per-site storage cap). Resume it IN
      // MEMORY instead — validated, a newer format refused, migrated on a copy — with its own revision (set above), so
      // the next autosave builds on it. Never the stale local copy, never the save-unreachable screen. The local copy
      // here is clean (a dirty one returned above) and the station file holds newer: drop it, so neither a re-entry
      // nor the next boot can resume it.
      if (!adopted && typeof Save !== 'undefined' && Save.fromDoc) {
        let mem = null;
        try { mem = Save.fromDoc(remote); } catch (_) { mem = null; }
        if (mem && mem.status === 'ok' && isSave(mem.doc) && num(mem.doc.version) <= currentVersion()) {
          if (priorLocalRaw != null) { try { localStorage.removeItem('starnet.save'); } catch (_) {} }
          cacheFailed = true; cacheFailedConfirmed = true; memoryDoc = mem.doc;   // it came FROM the station file
          cacheFailedReason = adoptError;
          try { console.warn('[cloudsave] browser storage cannot hold this station; resumed it from the station file.'); } catch (_) {}
          return JSON.parse(JSON.stringify(mem.doc));
        }
      }
      // adoption produced no readable current-schema doc (Save unavailable, or the re-read failed the guard).
      // NEVER return the raw, unmigrated remote — resumeInto() would misread it. Roll the cache back to the
      // prior local and prefer it. Without one, a failed adoption cannot justify first-run onboarding.
      try { if (priorLocalRaw != null) localStorage.setItem('starnet.save', priorLocalRaw); else localStorage.removeItem('starnet.save'); } catch (_) {}
      try { console.warn('[cloudsave] adopted remote did not re-validate; kept prior local cache.'); } catch (_) {}
      // We kept the old document, so keep its causal revision too. Giving it the remote
      // revision would let the next autosave overwrite newer durable edits without conflict.
      revision = num(local && local._saveRevision);
      return isSave(local) ? local : unknownSentinel('cache');
    }
    if (num(local.updatedAt) > num(remote.updatedAt)) push(local);   // local is ahead — let the server catch up
    return local;
  }

  // the boot path uses this to tell reconcile()'s future-save sentinel apart from a normal winning doc.
  function isFutureSentinel(d) { return !!(d && typeof d === 'object' && d.__futureSave === true); }
  // …and this to tell the save-unknown sentinel (no local + durable side unreadable) apart from a real doc.
  function isUnknownSentinel(d) { return !!(d && typeof d === 'object' && d.__saveUnknown === true); }

  // a close/hide can land before the debounce fires; beacon the pending doc so the last save is never dropped.
  //
  // DESKTOP REALITY (July-22 data-loss incident): the page runs on the tauri.localhost origin and the shell
  // rewrites ONLY window.fetch to the sidecar's real loopback URL — a relative sendBeacon posts into the
  // bundled-asset protocol and VANISHES (and sendBeacon cannot set the X-StarNet-Token header anyway). The old
  // code then treated sendBeacon's `true` ("queued for dispatch") as a confirmed 200: it nulled `pending` and
  // stamped health OK, so the newest save silently evaporated on EVERY desktop close/minimize while the
  // save-dot claimed "backed up". Three rules now:
  //   1. The beacon aims at the ABSOLUTE sidecar endpoint and authenticates via a SINGLE-USE save ticket
  //      (?ticket=, minted synchronously per beacon by ApiTicket — the master token never rides a URL).
  //   2. The blob is text/plain so the cross-origin beacon stays a CORS-simple request (an application/json
  //      blob demands a preflight sendBeacon never performs); the sidecar parses body BYTES, not content type.
  //   3. Dispatch is NEVER success: `pending` stays queued and health stays untouched. The beacon is purely a
  //      bonus copy for the dying-page case; the confirmable fetch flush below is the only path allowed to
  //      claim the write landed (a duplicate landing twice is harmless — the store accepts an equal updatedAt).
  function beaconUrl() {
    if (typeof ApiTicket !== 'undefined' && ApiTicket.saveBeaconUrl) return ApiTicket.saveBeaconUrl();
    let base = '';
    try { if (typeof window !== 'undefined' && window.__STARNET_API__) base = String(window.__STARNET_API__); } catch (_) {}
    return base + ENDPOINT;   // no ticket minter loaded: an unauthenticated beacon (refused) beats a leaked master token
  }
  function installUnloadFlush() {
    const beacon = () => {
      if (!isSave(pending)) return;
      try {
        const blob = new Blob([JSON.stringify(pending)], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon) navigator.sendBeacon(beaconUrl(), blob);
      } catch (_) {}
      // confirmable path: if the page survives (minimize / hide-to-tray), this fetch lands, clears `pending`,
      // and honestly stamps health. force:true — a hide is a potential death, not a moment to honor backoff.
      flush({ force: true });
    };
    try {
      window.addEventListener('pagehide', beacon);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') beacon(); });
    } catch (_) {}
  }

  // live durability health for the UI (save-dot) + diagnostics. `stale` is the TRUTHFUL verdict the
  // dot renders: persists are landing locally but the durable backup hasn't confirmed a write in > 60 min
  // AND there's a live failure streak. Never asserts "backed up" the harness can't prove.
  function healthNow() {
    const s = Core ? Core.snapshot(health, now())
      : { lastPushOkAt: health.lastPushOkAt, lastPushFailAt: health.lastPushFailAt, consecutiveFailures: health.consecutiveFailures, nextRetryAt: 0, warn: false, stale: false, cause: health.consecutiveFailures > 0 ? (health.cause || 'offline') : null };
    s.conflict = conflict;   // conflict.reset: the station file is empty because this computer's station was RESET
    s.seeded = seeded;       // { revision, at } once this window's copy re-seeded a missing station file (bug 5c019483)
    s.degraded = degraded;   // EL-11 FIX 1: refused-by-newer-StarNet is its own persistent, renderable state
    // #121: the browser cache could not hold this page's newest save, so the station file is its only durable copy.
    // cacheFailedConfirmed is true only once the station file acknowledged exactly that save with nothing newer queued.
    s.cacheFailed = cacheFailed;
    s.cacheFailedConfirmed = cacheFailed && cacheFailedConfirmed && !isSave(pending) && !activeFlushes.size;
    s.cacheFailedReason = cacheFailed ? cacheFailedReason : null;
    return s;
  }

  // #121: the newest save this page holds ONLY in memory (the browser cache could not take it), as a fresh copy; null
  // when the cache holds the newest save. Re-entry resumes from this instead of the stale or removed cache.
  function memorySave() {
    if (!cacheFailed || !isSave(memoryDoc)) return null;
    try { return JSON.parse(JSON.stringify(memoryDoc)); } catch (_) { return null; }
  }

  // EL-11 FIX 1: other write paths (app.js pushRoster) hit the SAME degraded refusal — let them latch the
  // shared verdict so the save-dot tells one coherent story regardless of which write was refused first.
  function markDegraded() { degraded = true; }

  // EL-11 FIX 2/3: the quarantine/recovery marker seen on the last pull (null if none), and the one-shot ack
  // that clears it server-side after the honest notice has been shown. Ack is best-effort (boolean promise).
  function recoveryNotice() { return lastRecovery; }
  function lineage() { return lastLineage; }
  function ackRecovery() {
    const rec = lastRecovery; lastRecovery = null;
    if (!rec) return Promise.resolve(false);
    return fetch('/api/save/recovery-ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: AGENT_ID }) })
      .then(r => !!(r && r.ok)).catch(() => false);
  }

  async function reloadCurrent() {
    if (typeof App !== 'undefined' && App.persist) App.persist();
    const confirmed = await flush({ force: true });
    if (pending || activeFlushes.size) throw new Error('This window changed while saving. Try reloading again after your work finishes.');
    if (!confirmed && !conflict) throw new Error('Could not preserve this window. Download its save before reloading.');
    localStorage.removeItem('starnet.save');
    location.reload();
  }

  // PRESERVED WINDOW SAVES (support report 2026-10-21): what a refused save left on the station, newest first, each with
  // how many sessions a restore would bring back; the station stops at the first one that would bring any back. `after`
  // (ms): the newest copy this page said "Not now" to — nothing saved at or before it is offered again (review 10-23 r2
  // #6). The list's `more` is true when the station stopped reading for time before it found one: ask again. [] when the
  // station cannot say (never a guess).
  async function conflicts(after) {
    try {
      const since = Math.floor(Number(after) || 0);
      const r = await fetch(ENDPOINT + '/conflicts' + (since > 0 ? '?after=' + since : ''), { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      const list = j && Array.isArray(j.conflicts) ? j.conflicts : [];
      list.more = !!(j && j.more === true);
      return list;
    } catch (_) { return []; }
  }
  /* bring that preserved save's sessions into the station (the sidecar adds, never removes), then reload onto it. After the
     station accepts, this page writes nothing more: its snapshot predates the restore (`retired`).
     NEVER AT THE COST OF THIS WINDOW'S OWN WORK (review 10-23 #1): this window's newest state is always sent first, and the
     restore goes ahead only when that save landed in the station file or was preserved beside it (its own conflict file).
     A refused save that preserved nothing (a growth-stale refusal, an outage) stops the restore, as reloadCurrent() does:
     the browser cache and the queued save are kept. */
  async function restoreConflict(file) {
    if (typeof App !== 'undefined' && App.persist) App.persist();
    let confirmed = await flush({ force: true });
    // a growth-stale refusal asked for a rating catch-up: once it has queued the re-synced save, send that once
    const catchUp = staleCatchUp; staleCatchUp = null;
    if (!confirmed && catchUp && await catchUp && isSave(pending)) confirmed = await flush({ force: true });
    if (activeFlushes.size) throw new Error('This window changed while saving. Try restoring again after your work finishes.');
    const newest = pushSeq;
    const safe = !isSave(pending) && (newest === 0 || landedSeq >= newest || (preservedSeq >= newest && !!(conflict && conflict.recovery)));
    if (!safe) throw new Error('Could not save this window first, so nothing was restored and nothing was lost. Download this window’s save, or try again in a moment.');
    const r = await fetch(ENDPOINT + '/conflicts/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) });
    const j = await r.json().catch(() => null);
    if (!j || j.ok !== true) throw new Error((j && j.error) || 'The station could not restore that save.');
    // NOTHING CAME BACK (review 10-23 r2 #2): the station already holds everything in that copy that may come back (or it was
    // deleted or cleared on purpose). This window is not retired or reloaded and keeps its browser copy: a restore that
    // brought nothing back is never the moment this window's own work is dropped.
    if (!(num(j.added) + num(j.extended) + num(j.copied))) throw new Error('Nothing was restored: the station already has every session in that save that can come back (a session deleted or cleared on purpose stays that way). This window was left as it is.');
    retired = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    // a change made WHILE the restore ran is in no file yet: keep its browser copy, which the reload preserves as this
    // window's work (a dirty copy on an older revision is pushed and kept beside the station, never dropped)
    if (pushSeq === newest) { pending = null; pendingRaw = null; try { localStorage.removeItem('starnet.save'); } catch (_) {} }
    location.reload();
    return j;
  }
  return { localSnapshot: () => latestLocal, writerId, mergeNotice: () => lastMerge, memorySave, reloadCurrent, conflicts, restoreConflict, revision: () => revision, push, pull, reconcile, flush, flushForUpdate, installUnloadFlush, health: healthNow, isFutureSentinel, isUnknownSentinel, markDegraded, recoveryNotice, lineage, ackRecovery, pullOutcome: () => lastPullOutcome, _isSave: isSave, _isFutureSave: isFutureSave };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CloudSave;
