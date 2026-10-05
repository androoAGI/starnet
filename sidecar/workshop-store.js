/* sidecar/workshop-store.js — durable per-agent AWAY-WORKSHOP state (grant + backlog + discard denylist).

   The Away Workshop lets an agent BUILD a reviewable deliverable inside its own jailed workspace while the
   Commander is away (see docs/AWAY_WORKSHOP_PLAN.md). Three pieces of per-agent state must survive a sidecar
   restart, so they live in one durable single-file store per agent — `<agentId>.workshop.json` under WORKSPACES:

     grant     — boolean: the Commander's recorded "Build things while I'm away" consent for THIS agent. A
                 recorded yes (never self-granted); flipping it OFF revokes the write refinement AND disarms the
                 shift routine (index.js owns the cron side). NOT an XP unlock — a plain consent toggle.
     backlog   — the ordered queue of things to build: explicit user-queued items + accepted quests only
                 (goal-arc milestones opt-in later). Each item: { id, title, detail, source, ts, decidedRunId? }.
                 An item is POPPED (marked in-flight) when a shift builds it; a built item carries the runId that
                 produced its deliverable so the return-card can find the manifest.
     denylist  — the permanent set of backlogIds the Commander DISCARDED (reuse of the memory-question
                 "discard = never again" pattern) so a discarded item is never silently re-queued/retried.

   Pure over an injected durable store (makeDurableJsonStore from durable-store.js) — crash-safe (fsync + .bak
   last-known-good), concurrency-safe (per-key async mutex + re-read-under-lock in update()), and unit-testable
   against an in-memory fs. The Node host (index.js) injects the real fs/path and the WORKSPACES root. No ambient
   clock/rng in this module: a timestamp is passed in by the caller (now), matching the memory-store discipline. */
'use strict';

const { makeDurableJsonStore } = require('./durable-store.js');

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DENYLIST_CAP = 500;   // FIFO cap on the permanent discarded-backlogId list (per agent)
const BACKLOG_CAP = 200;    // FIFO cap on queued items (oldest un-built drop off if the queue floods)
const MAX_BUILD_ATTEMPTS = 2;   // failed builds per item before it PARKS (never silently retried again)

function agentIdOf(key) {
  const raw = String(key || '').replace(/^workshop:/, '') || 'agent';
  if (!ID_RE.test(raw)) throw new Error('bad workshop agentId');
  return raw;
}

// normalized title key for duplicate-work detection (doctrine: an agent must never re-create work that already
// exists). Lowercase, trim, collapse internal whitespace. An empty normalized key means "no title" — those never
// dedup against each other (they dedup by id only).
function normTitle(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

// the on-disk shape, normalized so a partial/legacy/absent file always loads to a full, safe record.
function normalize(stored) {
  const s = (stored && typeof stored === 'object') ? stored : {};
  return {
    grant: s.grant === true,
    // provenance of the grant decision. grantExplicit=true means the Commander decided via the per-agent
    // "Build things while I'm away" toggle (setGrant) — an explicit yes OR no. grantAuto=true means the grant
    // was recorded as part of raising the autonomy dial to build-capable (grantIfUndecided). An explicit
    // decision is never overridden by the dial path; legacy records (neither flag) count as undecided.
    grantExplicit: s.grantExplicit === true,
    grantAuto: s.grantAuto === true,
    backlog: Array.isArray(s.backlog) ? s.backlog.filter(it => it && typeof it === 'object' && it.id) : [],
    denylist: Array.isArray(s.denylist) ? s.denylist.filter(x => x != null).map(String).filter(Boolean) : [],
    // normalized titles of DISCARDED items — a discarded piece of work can't be re-queued under a fresh id either
    // (doctrine: never re-create work the Commander already rejected). Distinct from `denylist` (by backlogId).
    deniedTitles: Array.isArray(s.deniedTitles) ? s.deniedTitles.filter(x => x != null).map(String).filter(Boolean) : [],
    // SHIFT HEALTH (2026-07-15 UX audit): the last workshop shift's honest outcome, so the away card can say
    // "built X" / "couldn't run — no key" / "nothing queued" instead of the old total silence. Additive; a
    // legacy record simply reads null. Shape: { at, reason, runId?, title?, parkedTitle? } (reason is the
    // runWorkshopShift result reason: built | no-manifest | run-failed | no-capability | empty-backlog | not-granted).
    lastShift: (s.lastShift && typeof s.lastShift === 'object') ? s.lastShift : null
  };
}

function makeWorkshopStore(deps) {
  deps = deps || {};
  const pathMod = deps.path;
  const workspaces = deps.workspaces;
  if (!pathMod || typeof pathMod.join !== 'function') throw new Error('makeWorkshopStore: path module required');
  if (!workspaces) throw new Error('makeWorkshopStore: workspaces path required');

  const durable = makeDurableJsonStore({
    fs: deps.fs,
    path: pathMod,
    fileFor: key => pathMod.join(workspaces, agentIdOf(key) + '.workshop.json'),
    writeDurable: deps.writeDurable,
    onRecover: deps.onRecover,
    onCorrupt: deps.onCorrupt
  });
  const warn = typeof deps.warn === 'function' ? deps.warn : function () {};
  const keyOf = id => 'workshop:' + String(id || 'agent');

  // ---- reads (sync, recovery-aware) ----
  function read(agentId) {
    try { return normalize(durable.get(keyOf(agentId))); }
    catch (e) { warn('[workshop] read failed:', (e && e.message) || e); return normalize(null); }
  }
  function hasGrant(agentId) { return read(agentId).grant === true; }
  // undecided = queued items NOT on the denylist and NOT already built-and-awaiting-decision is handled by
  // the caller (pending manifests come from run dirs); here `backlog` is the raw queue for the driver.
  function backlogOf(agentId) { return read(agentId).backlog.slice(); }
  function isDenied(agentId, backlogId) { return read(agentId).denylist.indexOf(String(backlogId)) >= 0; }

  // ---- writes (serialized per agent via the durable mutex) ----
  // the Commander's EXPLICIT per-agent decision (the "Build things while I'm away" toggle). Marks the record
  // explicitly decided, so the dial's grantIfUndecided path below never overrides it (an explicit OFF stays off).
  function setGrant(agentId, on) {
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      rec.grant = on === true;
      rec.grantExplicit = true;
      rec.grantAuto = false;
      return rec;
    });
  }

  // the AUTONOMY-DIAL path: raising the dial to build-capable (initiative≥leash AND reach≥sandbox) IS the
  // Commander's unattended-build consent, so record the grant — but ONLY when they never explicitly decided
  // (grantExplicit wins, both ways). Idempotent. Resolves { granted, changed } so the caller can ledger an
  // auto-grant honestly (changed=true exactly when this call recorded a new grant).
  function grantIfUndecided(agentId) {
    let changed = false, granted = false;
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      if (!rec.grant && !rec.grantExplicit) { rec.grant = true; rec.grantAuto = true; changed = true; }
      granted = rec.grant === true;
      return rec;
    }).then(() => ({ granted, changed }));
  }

  // add a build request to the queue. item: { id, title, detail?, source? }. now = injected ms. Dedup doctrine —
  // an agent must never re-create work that already exists:
  //   • same backlogId → idempotent add (returns the existing item);
  //   • denylisted backlogId → refused ('discarded');
  //   • same NORMALIZED title as a live backlog item → refused ('duplicate', returns the existing item);
  //   • same NORMALIZED title as a previously DISCARDED item → refused ('discarded').
  // Returns { item, reason } where reason ∈ 'added'|'exists'|'duplicate'|'discarded'. item is null on 'discarded'.
  function queue(agentId, item, now) {
    const it = item || {};
    const id = String(it.id || '').trim();
    if (!id) throw new Error('workshop.queue: item.id required');
    const title = String(it.title || '').slice(0, 200);
    const nt = normTitle(title);
    let out = { item: null, reason: 'added' };
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      if (rec.denylist.indexOf(id) >= 0) { out = { item: null, reason: 'discarded' }; return undefined; }   // discarded id → never re-queue
      // an explicit re-ask for an item that's already lined up is a human "try again" — it UN-PARKS the item
      // (clears failed-build attempts) but never duplicates it.
      const existingById = rec.backlog.find(b => b.id === id);
      if (existingById) { out = { item: existingById, reason: 'exists' }; if (existingById.attempts) { delete existingById.attempts; return rec; } return undefined; }
      if (nt) {
        if (rec.deniedTitles.indexOf(nt) >= 0) { out = { item: null, reason: 'discarded' }; return undefined; }   // that work was discarded before
        const dupByTitle = rec.backlog.find(b => normTitle(b.title) === nt);
        if (dupByTitle) { out = { item: dupByTitle, reason: 'duplicate' }; if (dupByTitle.attempts) { delete dupByTitle.attempts; return rec; } return undefined; }   // already lined up
      }
      const stored = { id: id, title: title, detail: String(it.detail || '').slice(0, 4000), source: String(it.source || 'queued').slice(0, 40), ts: Number(now) || 0 };
      // WHY-THIS provenance (2026-07-17): the grounding quote that justified this job (night-shift GROUNDS,
      // or any caller-supplied ask context). Stored so the delivery card can say WHY it built this in the
      // Commander's own terms — real recorded data, never re-synthesized at render time. Additive; optional.
      if (it.grounds != null && String(it.grounds).trim()) stored.grounds = String(it.grounds).slice(0, 500);
      // PRIOR-WORK provenance (2026-10-05): which night focus this build served, and which earlier build it continues,
      // so later nights can scope "already built" to the same focus and see the iteration chain. Additive; optional.
      if (it.focusRef != null && String(it.focusRef).trim()) stored.focusRef = String(it.focusRef).slice(0, 500);
      if (it.continuesRunId != null && /^[A-Za-z0-9_-]{1,80}$/.test(String(it.continuesRunId))) stored.continuesRunId = String(it.continuesRunId);
      rec.backlog.push(stored);
      while (rec.backlog.length > BACKLOG_CAP) rec.backlog.shift();
      out = { item: stored, reason: 'added' };
      return rec;
    }).then(() => out);
  }

  // ZOMBIE-CLAIM RECLAIM: a shift that crashed (sidecar killed mid-build) leaves an item stamped with a
  // buildingRunId whose run is no longer live. Without a sweep that item is skipped by claimNext FOREVER (it
  // looks perpetually in-flight), silently muting the whole backlog for that agent. `isRunLive(runId)` is the
  // honest liveness source injected by the host (the runs map): a buildingRunId that is NOT live is a zombie ->
  // clear the stamp so the item is claimable again. Mirrors the cron zombie fire-claim reclaim (cron.js G4.5).
  // isRunLive absent/undefined -> conservative no-op (nothing is treated as a zombie), so this is inert unless wired.
  function reapZombieClaims(rec, isRunLive) {
    if (typeof isRunLive !== 'function') return false;
    let changed = false;
    for (const b of rec.backlog) {
      if (b.buildingRunId && !b.builtRunId && !isRunLive(b.buildingRunId)) { delete b.buildingRunId; changed = true; }
    }
    return changed;
  }

  // pop the TOP un-built backlog item for a shift. Returns the item (leaving it in the backlog, stamped with the
  // runId that is building it) or null when the queue is empty. Stamping in-flight lets a completed build map its
  // manifest back to the backlogId and lets the driver skip an item already being built. PARKED items (attempts
  // >= MAX_BUILD_ATTEMPTS after failed builds) are never re-claimed — without this cap a permanently-failing item
  // would be silently retried every shift forever (an invisible token leak). isRunLive (optional) reaps any
  // zombie claim (a buildingRunId whose run is dead) in the SAME locked update before choosing the next item.
  function claimNext(agentId, runId, isRunLive) {
    let claimed = null;
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      const reaped = reapZombieClaims(rec, isRunLive);
      const next = rec.backlog.find(b => !b.buildingRunId && !b.builtRunId && !(Number(b.attempts) >= MAX_BUILD_ATTEMPTS));
      if (!next) { claimed = null; return reaped ? rec : undefined; }   // persist a reap even when nothing is claimable
      next.buildingRunId = String(runId || '');
      claimed = next;
      return rec;
    }).then(() => claimed);
  }

  /* claim ONE NAMED backlog item for a run. claimNext's "top of the queue" rule is right for a shift (which asks
     "what next?") and WRONG for a caller that already knows which item is its own: with a non-empty backlog it
     would stamp somebody ELSE's item with this runId, leaving that item wedged in-flight while the real one was
     never claimed. The Commander-initiated implement build knows its item by id, so it claims by id.
     Returns the claimed item, or null when the id is unknown / already building / already built / parked. */
  function claimById(agentId, id, runId, isRunLive) {
    const want = String(id || '');
    let claimed = null;
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      const reaped = reapZombieClaims(rec, isRunLive);
      const it = rec.backlog.find(b => b.id === want && !b.buildingRunId && !b.builtRunId && !(Number(b.attempts) >= MAX_BUILD_ATTEMPTS));
      if (!it) { claimed = null; return reaped ? rec : undefined; }
      it.buildingRunId = String(runId || '');
      claimed = it;
      return rec;
    }).then(() => claimed);
  }

  // boot sweep: clear every zombie claim for an agent (a buildingRunId whose run is not live) so a crash mid-shift
  // never wedges the backlog. Returns the count of items un-stuck. Host calls this at boot for each granted agent.
  function sweepStaleClaims(agentId, isRunLive) {
    let n = 0;
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      for (const b of rec.backlog) {
        if (b.buildingRunId && !b.builtRunId && (typeof isRunLive !== 'function' || !isRunLive(b.buildingRunId))) { delete b.buildingRunId; n++; }
      }
      return n ? rec : undefined;
    }).then(() => n);
  }

  // mark a claimed item BUILT (a valid manifest landed) — records the runId so the return-card finds the dir,
  // and builtAt (injected ms, matching queue()) so every later surface can show WHEN the work actually landed.
  // Timestamp-honesty law (2026-07-19): before builtAt existed, /pending and /deliverables fell back to the
  // QUEUE time or a fresh Date.now() at poll/adopt — both lies about when the deliverable was produced.
  function markBuilt(agentId, backlogId, runId, now) {
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      const it = rec.backlog.find(b => b.id === String(backlogId));
      if (!it) return undefined;
      delete it.buildingRunId; it.builtRunId = String(runId || '');
      it.builtAt = Number(now) || 0;
      return rec;
    });
  }

  // release a claim without building so the item stays queued for a later shift. opts.failed = the shift RAN and
  // produced no valid deliverable (run threw / manifest missing or invalid) — that counts a build ATTEMPT; at
  // MAX_BUILD_ATTEMPTS the item PARKS (claimNext skips it) so a doomed item can't burn a run every shift forever.
  // A no-capability release (no model/credentials — the build never started) is NOT an attempt and stays free.
  // Returns { parked: item|null } so the caller can surface an honest "tried N times, couldn't build it".
  function releaseClaim(agentId, runId, opts) {
    const failed = !!(opts && opts.failed);
    let parked = null;
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      let changed = false;
      for (const b of rec.backlog) {
        if (b.buildingRunId !== String(runId || '')) continue;
        delete b.buildingRunId; changed = true;
        if (failed) {
          b.attempts = (Number(b.attempts) || 0) + 1;
          if (b.attempts >= MAX_BUILD_ATTEMPTS) parked = b;
        }
      }
      return changed ? rec : undefined;
    }).then(() => ({ parked: parked }));
  }

  // DISCARD: remove the item from the backlog AND denylist its id forever (never silently re-queued/retried).
  function discard(agentId, backlogId) {
    const id = String(backlogId || '');
    if (!id) return Promise.resolve();
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      const gone = rec.backlog.find(b => b.id === id);
      rec.backlog = rec.backlog.filter(b => b.id !== id);
      if (rec.denylist.indexOf(id) < 0) { rec.denylist.push(id); while (rec.denylist.length > DENYLIST_CAP) rec.denylist.shift(); }
      // also denylist the normalized TITLE so the same work can't be re-queued under a fresh id (dedup doctrine).
      const nt = normTitle(gone && gone.title);
      if (nt && rec.deniedTitles.indexOf(nt) < 0) { rec.deniedTitles.push(nt); while (rec.deniedTitles.length > DENYLIST_CAP) rec.deniedTitles.shift(); }
      return rec;
    });
  }

  // COMPLETE (kept): the Commander kept the deliverable — the work is DONE, so the item leaves the backlog and
  // its manifest stops being "pending" (the return-card must never resurrect a kept build on the next session).
  // Unlike discard, the title is NOT denylisted: kept work was good work and may legitimately be asked for again.
  function complete(agentId, backlogId) {
    const id = String(backlogId || '');
    if (!id) return Promise.resolve();
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      if (!rec.backlog.some(b => b.id === id)) return undefined;   // unknown id → no change, no write
      rec.backlog = rec.backlog.filter(b => b.id !== id);
      return rec;
    });
  }

  // UNDO A KEEP (EL-11 #8): a kept deliverable was copied OUT of the jail and its backlog item retired via
  // complete(). If the Commander UNDOES that keep (the route removes the out-of-jail copy), the build returns to
  // PENDING so /pending re-lists it and they can decide again. Additive to the store, idempotent, and honest:
  //   • already pending (an item with this builtRunId is still/again present) → no change, { restored:false, 'exists' };
  //   • an id/title the Commander DISCARDED before → refused, { restored:false, 'denied' } (dedup doctrine holds on
  //     undo too — never silently re-list rejected work);
  //   • otherwise re-inserts the built item (builtRunId set) so handleWorkshopPending shows it again.
  // info: { backlogId?, title?, source? } — reconstructed by the caller from the disk manifest (the archive run
  // dir SURVIVES a keep, so validateWorkshopManifest still resolves title/backlogId). now = injected ms (no
  // ambient clock in this module, matching queue()/setLastShift()).
  function restorePending(agentId, runId, info, now) {
    const rid = String(runId || '');
    info = info || {};
    let out = { restored: false, reason: 'noop', item: null };
    if (!rid) return Promise.resolve(out);
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      if (rec.backlog.some(b => b.builtRunId === rid || b.buildingRunId === rid)) { out = { restored: false, reason: 'exists', item: null }; return undefined; }
      // a valid original backlogId (from the manifest) is reused so re-keep/discard operates on the same identity;
      // a missing/oversized/legacy id falls back to a deterministic, ID_RE-valid 'undo-<runId>' handle.
      const bid = (info.backlogId && ID_RE.test(String(info.backlogId))) ? String(info.backlogId) : ('undo-' + rid.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 34));
      const nt = normTitle(info.title);
      if (rec.denylist.indexOf(bid) >= 0 || (nt && rec.deniedTitles.indexOf(nt) >= 0)) { out = { restored: false, reason: 'denied', item: null }; return undefined; }
      const item = { id: bid, title: String(info.title || 'Workshop deliverable').slice(0, 200), detail: '', source: String(info.source || 'workshop').slice(0, 40), ts: Number(now) || 0, builtRunId: rid };
      // timestamp honesty: an undo returns the SAME build to pending — its builtAt is when it was originally
      // built (caller reads it from the durable lifecycle row / run record), never the undo moment.
      if (Number(info.builtAt) > 0) item.builtAt = Number(info.builtAt);
      rec.backlog.push(item);
      while (rec.backlog.length > BACKLOG_CAP) rec.backlog.shift();
      out = { restored: true, reason: 'restored', item: item };
      return rec;
    }).then(() => out);
  }

  // find the backlog item a given build run produced (by builtRunId or buildingRunId) — used on decide.
  function itemForRun(agentId, runId) {
    const rid = String(runId || '');
    return read(agentId).backlog.find(b => b.builtRunId === rid || b.buildingRunId === rid) || null;
  }

  // REMOVE (2026-07-15 UX audit): take an UN-BUILT item off the queue without the discard denylist — "I changed
  // my mind about queueing this" is not "never propose this work again". A built item is refused here: its files
  // exist, so it must be decided from its delivery session (keep/discard) instead. Resolves { removed, reason }.
  function remove(agentId, backlogId) {
    const id = String(backlogId || '');
    let out = { removed: false, reason: 'not-found' };
    if (!id) return Promise.resolve(out);
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      const it = rec.backlog.find(b => b.id === id);
      if (!it) { out = { removed: false, reason: 'not-found' }; return undefined; }
      if (it.builtRunId) { out = { removed: false, reason: 'built' }; return undefined; }
      rec.backlog = rec.backlog.filter(b => b.id !== id);
      out = { removed: true, reason: 'removed' };
      return rec;
    }).then(() => out);
  }

  // SHIFT HEALTH (2026-07-15 UX audit): record the last shift's honest outcome so the away card can render it.
  // info: { at, reason, runId?, title?, parkedTitle? } — written by runWorkshopShift on EVERY exit path.
  function setLastShift(agentId, info) {
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      rec.lastShift = {
        at: Number(info && info.at) || 0,
        reason: String((info && info.reason) || '').slice(0, 60),
        runId: (info && info.runId) ? String(info.runId).slice(0, 64) : undefined,
        title: (info && info.title) ? String(info.title).slice(0, 200) : undefined,
        parkedTitle: (info && info.parkedTitle) ? String(info.parkedTitle).slice(0, 200) : undefined
      };
      return rec;
    });
  }

  return {
    read, hasGrant, setGrant, grantIfUndecided, backlogOf, isDenied,
    queue, claimNext, claimById, sweepStaleClaims, markBuilt, releaseClaim, discard, complete, restorePending, itemForRun, remove, setLastShift,
    _durable: durable
  };
}

module.exports = { makeWorkshopStore, normalize, _internals: { agentIdOf } };
