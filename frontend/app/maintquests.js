/* STARNET — maintquests.js : the PURE maintenance-quest generator (G1c) — wasted spend, turned into direction.

   SlagLog (slaglog.js) already diagnoses every unproductive run into a plain-English { reason, title, cause,
   fix } post-mortem and keeps a small ring of the recent ones. Those diagnoses go nowhere today. This engine
   folds that ring into playable direction: when the SAME cause bites REPEATEDLY, the station mints ONE
   maintenance quest carrying the diagnosis + the actionable fix:

     "⚑ 3 runs died on max_iters — split the task or raise the iteration budget"

   The honest-quest + XP laws, encoded so they can't rot:
     • THRESHOLD-GATED — a one-off failure never nags. A cause must appear at least MIN_HITS (default 2) times
       in the live ring before it mints (a real, recurring problem, not a blip).
     • ONE OPEN QUEST PER CAUSE — the same recurring reason never duplicates (dedup key = the reason).
     • DISMISSAL = STOP FOREVER — a waved-off maintenance quest never re-renders and never re-fires, even if
       the cause keeps biting (the anti-nag law: the station suggests a fix, it never pushes).
     • HONEST COMPLETION — no claim button. A minted quest completes the instant the SIGNAL CLEARS: the cause's
       count in the live ring falls back below MIN_HITS. This is provable from the ring alone (a bounded window
       of the most-recent post-mortems): as clean/other runs push the failing runs out of the ring, the count
       falls — the operator genuinely fixed the line. (We pick this over an N-clean-runs counter because it
       reads straight off the same ring the mint reads, so mint and completion can never disagree.)
     • NO XP — a maintenance quest pays out the real fix landing on the floor + the shared celebration, never
       points.

   Also home to a small non-slag maintenance source: a repeatedly-SKIPPED cron routine (feature 4a's JAM). The
   store folds a jam signal in via record() with a synthetic reason ('cron-jam:<jobId>') so it rides the exact
   same dedup + projection + dismissal as a slag cause — one quest shape, never a parallel system.

   PURE + node-testable (mirrors stationquests.js / queststate.js): no Date.now / Math.random — the caller
   injects the clock and the live ring/counts. The browser store (maintqueststore.js) owns the live reads
   (World.slagPostmortems, the cron-jam tally); this file owns only the deterministic fold + the projection
   into the shared Quests shape. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.MaintQuests = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_HITS = 2;   // a cause must bite at least this many times in the live ring before it mints (anti-blip)

  function fresh() { return { v: 1, quests: {} }; }

  // the stable id for a maintenance cause — the dedup key AND the quest id the QuestState engine folds through
  // (so completion rides G1a's celebration for free). Sanitized so a hand-edited save or a weird reason can't
  // inject a broken id.
  const clean = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_.\-:]/g, '_').slice(0, 64);
  function causeId(cause) { return 'mq:' + clean(cause); }

  // defensively rebuild a persisted slice: every entry re-validated, junk dropped (never a crash on a bad save).
  function hydrate(raw) {
    const s = fresh();
    if (!raw || typeof raw !== 'object') return s;
    const quests = (raw.quests && typeof raw.quests === 'object') ? raw.quests : {};
    for (const id of Object.keys(quests)) {
      const r = quests[id];
      if (!id || !r || typeof r !== 'object') continue;
      const first = Number(r.firstSeenAt);
      if (!Number.isFinite(first)) continue;
      const cause = clean(r.cause);
      if (!cause) continue;
      // null must round-trip as null — Number(null) is 0 (finite!), which would resurrect an open quest as
      // "completed/dismissed at epoch". Guard the null case explicitly before coercing (the stationquests trap).
      const comp = r.completedAt == null ? NaN : Number(r.completedAt);
      const dis = r.dismissedAt == null ? NaN : Number(r.dismissedAt);
      s.quests[id] = {
        cause,
        title: String(r.title || '').slice(0, 80),
        fix: String(r.fix || '').slice(0, 320),
        hits: Math.max(0, Number(r.hits) | 0),
        firstSeenAt: first,
        completedAt: Number.isFinite(comp) ? comp : null,
        dismissedAt: Number.isFinite(dis) ? dis : null
      };
    }
    return s;
  }

  /* fold a freshly detected recurring cause into the state (in place, like StationQuests.record). Called by the
     store ONLY once a cause has crossed the threshold in the live ring (the store owns the tally; a caller may
     pass hits so the card can read "N runs died on …"). d = { cause, title, fix, hits }. Rules:
       • one entry per cause — a repeat NEVER duplicates (idempotent update of the human-facing labels + hits
         only; firstSeenAt / completion history is preserved).
       • a DISMISSED cause is never re-created — waved off = stop forever, even if it keeps biting.
       • recording a cause that's ALREADY done (its signal cleared, then bit again) RE-OPENS it — a genuinely
         new recurrence is a new problem worth surfacing again (unlike a one-time gap that stays fixed once the
         prop is placed; a maintenance issue can recur). A fresh firstSeenAt is stamped so the card reads current.
     Returns the entry's id (so the store can log), or null when nothing was recorded (dismissed / invalid). */
  function record(state, d, now) {
    if (!state || !state.quests || !d) return null;
    const cause = clean(d.cause);
    if (!cause) return null;
    const id = causeId(cause);
    const existing = state.quests[id];
    if (existing && existing.dismissedAt != null) return null;   // dismissed = stop forever
    const hits = Math.max(0, Number(d.hits) | 0);
    if (existing) {
      if (d.title) existing.title = String(d.title).slice(0, 80);
      if (d.fix) existing.fix = String(d.fix).slice(0, 320);   // 160 cut the errored-run fix mid-word ("…and repo")
      if (hits) existing.hits = hits;
      if (existing.completedAt != null) {           // a cleared cause bit again → re-open it (a new recurrence)
        existing.completedAt = null;
        existing.firstSeenAt = now;
      }
      return id;
    }
    state.quests[id] = {
      cause,
      title: String(d.title || '').slice(0, 80),
      fix: String(d.fix || '').slice(0, 320),
      hits: hits,
      firstSeenAt: now,
      completedAt: null,
      dismissedAt: null
    };
    return id;
  }

  /* re-check every OPEN quest against the live signal and flip the newly-cleared ones done. `active(entry)` is
     the store's predicate — "is this cause STILL recurring (≥ threshold in the live ring)?". Completion is the
     real signal clearing (the operator fixed the line), never a claim. Returns the entries that transitioned
     this refresh (so the store can log); the open→done CELEBRATION rides QuestState's fold over the projection
     — this engine never plays sound, exactly like stationquests.js. */
  function refresh(state, active, now) {
    const closed = [];
    if (!state || !state.quests || typeof active !== 'function') return closed;
    for (const id of Object.keys(state.quests)) {
      const e = state.quests[id];
      if (!e || e.dismissedAt != null || e.completedAt != null) continue;
      let still = true;
      try { still = !!active(e); } catch (_) { still = true; }   // on a read error assume still-active (never a false "fixed!")
      if (!still) { e.completedAt = now; closed.push(e); }
    }
    return closed;
  }

  // wave a cause off forever. Returns true only when it actually took (a known, not-already-dismissed quest).
  // Always dismissible — a fix-it suggestion the Commander waves off must stop nagging (the sandbox law).
  function dismiss(state, id, now) {
    if (!state || !state.quests || !id) return false;
    const e = state.quests[id];
    if (!e || e.dismissedAt != null) return false;
    e.dismissedAt = now;
    return true;
  }

  const isDismissed = (state, id) => !!(state && state.quests && id && state.quests[id] && state.quests[id].dismissedAt != null);

  /* project the state into the shared Quests shape (kind 'maintenance'), so these ride the EXACT same quest-log
     render + QuestState fold (→ G1a celebration) as every other quest — one quest shape, never a second parallel
     system. A dismissed cause is omitted entirely (stop forever). Open quests carry the diagnosis + the fix; done
     quests read as cleared. Deterministic ordering: open before done, then by firstSeenAt (stable). Every quest
     names a REAL reward (the line running clean again) and gates nothing. */
  function project(state) {
    if (!state || !state.quests) return [];
    const entries = Object.keys(state.quests).map(id => Object.assign({ id }, state.quests[id]))
      .filter(e => e.dismissedAt == null);
    entries.sort((a, b) => {
      const ad = a.completedAt != null ? 1 : 0, bd = b.completedAt != null ? 1 : 0;
      if (ad !== bd) return ad - bd;                 // open first
      return (a.firstSeenAt || 0) - (b.firstSeenAt || 0);
    });
    return entries.map(e => {
      const done = e.completedAt != null;
      const title = e.title || 'a run kept failing';
      return {
        id: e.id,
        kind: 'maintenance',
        title: done ? ('fixed — ' + title) : ('⚑ ' + title),
        desc: done
          ? 'the line is running clean again — the signal cleared.'
          : (e.fix || 'review the run and adjust the task or the bay.'),
        reward: 'the line running clean again',
        status: done ? 'done' : 'open'
      };
    });
  }

  // how many maintenance quests are currently OPEN (drives the MISSION BOARD pin count). Dismissed + done excluded.
  function openCount(state) {
    if (!state || !state.quests) return 0;
    let n = 0;
    for (const id of Object.keys(state.quests)) {
      const e = state.quests[id];
      if (e && e.dismissedAt == null && e.completedAt == null) n++;
    }
    return n;
  }

  // tally how many times each cause (reason) appears in a SlagLog ring — the store's threshold input. A diagnosis
  // is { reason, title, cause, fix }; we group by `reason` (the stable machine cause) so wording variance in
  // `cause`/`title` can't split one recurring problem into two. Returns { reason -> { count, title, fix } } using
  // the MOST RECENT diagnosis's wording for the card.
  function tally(ring) {
    const out = {};
    const arr = Array.isArray(ring) ? ring : [];
    for (const d of arr) {
      if (!d || d.reason == null) continue;
      const r = String(d.reason);
      if (!out[r]) out[r] = { count: 0, title: '', fix: '' };
      out[r].count++;
      // the ring is oldest→newest, so the last write wins = the freshest wording for the card.
      out[r].title = String(d.title || out[r].title || '');
      out[r].fix = String(d.fix || out[r].fix || '');
    }
    return out;
  }

  return { fresh, hydrate, causeId, record, refresh, dismiss, isDismissed, project, openCount, tally, MIN_HITS };
});
