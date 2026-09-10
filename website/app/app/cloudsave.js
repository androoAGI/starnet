/* STARNET — cloudsave.js : write the agent through to the durable sidecar, and pull it back on boot.

   localStorage is a fast CACHE that a browser wipe can erase. The sidecar's <workspaces>/<id>.save.json is the
   DURABLE copy (app-data dir, survives a cache wipe / different browser). This module keeps them in sync:

     • push(doc)      — debounced best-effort POST /api/save on every persist; coalesces bursts of turns.
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
  let revision = 0, conflict = null, latestLocal = null;
  let timer = null;                    // debounce timer for a fresh push
  let retryTimer = null;               // backoff timer scheduling the next attempt after a failure
  let pending = null;                  // newest doc awaiting a flush (older queued docs are superseded)
  const activeFlushes = new Set();      // confirmable writes currently waiting on the sidecar
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

  function now() { return Date.now(); }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function isSave(d) { return !!(d && typeof d === 'object' && d.schema === 'starnet.save' && d.agent && typeof d.agent === 'object'); }

  // this build's readable schema ceiling. A save/remote whose version exceeds this was written by a NEWER
  // StarNet and MUST NOT be adopted into the cache (that would clobber the local doc with fields this code
  // can't read). Mirror Save.CURRENT when available; fall back to a literal only if Save hasn't loaded yet.
  function currentVersion() { return (typeof Save !== 'undefined' && Number.isFinite(Save.CURRENT)) ? Save.CURRENT : 5; }
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
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc)
    });
  }

  // record a push outcome into the health brain + drive the one-warn-per-state-change console policy.
  // Kept fail-soft: a missing Core (order-of-load) just no-ops the telemetry, never throws.
  function markOk() {
    if (Core) health = Core.recordSuccess(health, now());
    else health = { lastPushOkAt: now(), lastPushFailAt: health.lastPushFailAt, consecutiveFailures: 0, nextRetryAt: 0 };
    if (warnedStale) { warnedStale = false; try { console.info('[cloudsave] durable mirror sync recovered.'); } catch (_) {} }
  }
  function markFail() {
    if (Core) health = Core.recordFailure(health, now());
    else health = { lastPushOkAt: health.lastPushOkAt, lastPushFailAt: now(), consecutiveFailures: health.consecutiveFailures + 1, nextRetryAt: 0 };
    // warn EXACTLY once when we first cross into stale territory — not once per attempt (no console spam,
    // no throw into callers). The UI save-dot carries the ongoing signal; this is just a dev breadcrumb.
    const stale = Core ? Core.isStale(health, now()) : false;
    if (stale && !warnedStale) {
      warnedStale = true;
      try { console.warn('[cloudsave] durable mirror has not synced; retrying with backoff. Local cache is intact.'); } catch (_) {}
    }
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
    const doc = pending; pending = null;
    if (!isSave(doc)) return Promise.resolve(false);
    const attempt = postNow(doc)
      .then(async r => {
        // a non-ok HTTP status (e.g. 409 stale, 500) is a FAILURE, not a success — fetch only rejects on
        // network error, so we must inspect r.ok ourselves or we'd stamp health OK on a rejected write.
        if (r && r.ok === false) { throw new Error('save HTTP ' + r.status); }
        // EL-11 FIX 1 ("the worst lie class"): the sidecar answers REFUSALS as HTTP 200 { ok:false, ... }
        // (degraded workspace / stale stamp / unreadable prior) — the status line alone is NEVER proof the
        // write landed. Parse the body: ok:false is a FAILED push, and degraded:true latches its own state.
        // A non-JSON 200 (older sidecar / dev shim) still counts as landed — same trust as before.
        let body = null;
        try { body = await r.json(); } catch (_) { body = null; }
        if (body && typeof body === 'object') {
          degraded = (body.ok === false && body.degraded === true);   // any parsed answer re-proves (or clears) the degraded verdict
          if (body.conflict) { conflict = body; markFail(); return false; }
          if (body.ok && Number.isInteger(body.revision)) {
            revision = body.revision;
            if (pending) pending._saveRevision = revision;
            try { const cached = JSON.parse(localStorage.getItem('starnet.save')); if (!pending && cached && JSON.stringify({ ...cached, _saveClient: undefined }) === JSON.stringify({ ...doc, _saveClient: undefined })) { cached._saveRevision = revision; cached._saveDirty = false; if (Number.isFinite(body.updatedAt)) cached.updatedAt = body.updatedAt; localStorage.setItem('starnet.save', JSON.stringify(cached)); } } catch (_) {}
          }
          if (body.ok === false) throw new Error('save refused: ' + (body.error || (body.unreadable ? 'existing record unreadable' : body.stale ? 'stale write' : 'unknown')));
        }
        markOk();
        return true;
      })
      .catch(() => {
        markFail();
        // re-queue the newest doc (newest-wins: a fresher push during the attempt already replaced it) and
        // arm the backoff retry. Fail soft — the cache is still authoritative locally, nothing throws out.
        if (!isSave(pending)) pending = doc;
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
  function push(doc) {
    if (!isSave(doc)) return;
    doc = JSON.parse(JSON.stringify(doc));
    doc._saveRevision = revision;
    doc._saveClient = clientId;
    latestLocal = doc;
    pending = doc;                     // keep only the newest
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
      .then(r => {
        if (!r.ok) {
          // an auth refusal is its own truth — the sidecar is ALIVE but rejected us (lost/stale launch token).
          lastPullOutcome = (r.status === 401 || r.status === 403) ? 'forbidden' : 'unreachable';
          return null;
        }
        lastPullOutcome = 'empty';   // a 200 with no save below stays 'empty'; a real save upgrades it
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
        }
        const s = j && j.save;
        if (isSave(s)) { lastPullOutcome = 'save'; return s; }
        return null;
      })
      .catch(() => { lastPullOutcome = 'unreachable'; return null; })   // network fail/timeout/bad JSON -> we proved NOTHING
      .then(v => { if (t) clearTimeout(t); return v; });
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
      revision = num(local && local._saveRevision);
      if (isSave(local)) push(local);   // 'empty': seed the server; otherwise best-effort (fails soft, retries)
      return local;
    }
    // FORWARD-VERSION GUARD (P0.3): a durable remote from a NEWER build must NOT be adopted into the cache —
    // setItem-ing it and re-migrating would clobber the local doc with fields this build can't read (silent
    // contamination, brutal to debug). Leave localStorage byte-unchanged and raise the honest update gate.
    if (isFutureSave(remote)) return futureSentinel(num(remote.version));
    revision = num(remote._saveRevision);
    if (isSave(local) && local._saveDirty) {
      // Offline edits are still based on their original revision. Preserve them through the
      // same conflict receipt; never relabel a stale local snapshot with the remote revision.
      revision = num(local._saveRevision);
      push(local);   // preserve asynchronously; a stalled POST must never block local boot
      return local;
    }
    if (!isSave(local) || num(local._saveRevision) !== revision || num(remote.updatedAt) > num(local.updatedAt)) {
      // adopt remote into the cache, then re-read it through Save.load() so the MIGRATION LADDER runs on it.
      // The durable mirror is designed to outlive the cache and survive app updates, so it can legitimately be
      // an OLDER schema (v1/v2) than this build. resumeInto() assumes a current-schema doc (reads .workstreams,
      // expects .agent.stats); adopting a raw v1/v2 remote would silently drop history + skip the XP seed.
      const priorLocalRaw = (() => { try { return localStorage.getItem('starnet.save'); } catch (_) { return null; } })();
      try { localStorage.setItem('starnet.save', JSON.stringify(remote)); } catch (_) {}
      try {
        // re-validate through Save.load(): it re-checks the forward-version guard on the just-adopted doc and
        // runs the migration ladder. A migrated, current-schema save is the only thing we hand back.
        const migrated = (typeof Save !== 'undefined' && Save.load) ? Save.load() : null;
        if (isSave(migrated) && num(migrated.version) <= currentVersion()) return migrated;
      } catch (_) {}
      // adoption produced no readable current-schema doc (Save unavailable, or the re-read failed the guard).
      // NEVER return the raw, unmigrated remote — resumeInto() would misread it. Roll the cache back to the
      // prior local and prefer it; if there was no prior local, fall through to null (boot onboards cleanly).
      try { if (priorLocalRaw != null) localStorage.setItem('starnet.save', priorLocalRaw); else localStorage.removeItem('starnet.save'); } catch (_) {}
      try { console.warn('[cloudsave] adopted remote did not re-validate; kept prior local cache.'); } catch (_) {}
      return isSave(local) ? local : null;
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
  //   1. The beacon aims at the ABSOLUTE sidecar endpoint and authenticates via ?token= (the sidecar accepts
  //      the query token for POST /api/save exactly like GET /api/file — apiauth.queryTokenRoute).
  //   2. The blob is text/plain so the cross-origin beacon stays a CORS-simple request (an application/json
  //      blob demands a preflight sendBeacon never performs); the sidecar parses body BYTES, not content type.
  //   3. Dispatch is NEVER success: `pending` stays queued and health stays untouched. The beacon is purely a
  //      bonus copy for the dying-page case; the confirmable fetch flush below is the only path allowed to
  //      claim the write landed (a duplicate landing twice is harmless — the store accepts an equal updatedAt).
  function beaconUrl() {
    let base = '', token = '';
    try { if (typeof window !== 'undefined' && window.__STARNET_API__) base = String(window.__STARNET_API__); } catch (_) {}
    try { if (typeof window !== 'undefined' && window.__STARNET_API_TOKEN__) token = String(window.__STARNET_API_TOKEN__); } catch (_) {}
    return base + ENDPOINT + (token ? '?token=' + encodeURIComponent(token) : '');
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
      : { lastPushOkAt: health.lastPushOkAt, lastPushFailAt: health.lastPushFailAt, consecutiveFailures: health.consecutiveFailures, nextRetryAt: 0, warn: false, stale: false };
    s.conflict = conflict;
    s.degraded = degraded;   // EL-11 FIX 1: refused-by-newer-StarNet is its own persistent, renderable state
    return s;
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
  return { localSnapshot: () => latestLocal, reloadCurrent, revision: () => revision, push, pull, reconcile, flush, flushForUpdate, installUnloadFlush, health: healthNow, isFutureSentinel, isUnknownSentinel, markDegraded, recoveryNotice, lineage, ackRecovery, pullOutcome: () => lastPullOutcome, _isSave: isSave, _isFutureSave: isFutureSave };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CloudSave;
