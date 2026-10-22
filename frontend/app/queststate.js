/* AGENT OS — queststate.js : the PURE durable-quest-memory engine behind the quest log.

   quests.js projects the CURRENT truth (open/done) and is deliberately stateless; this engine gives that
   projection a PAST. It folds successive projections into a small durable record:
     • firstSeenAt / completedAt per quest id — when a quest entered the log and when it REALLY finished
       (the future TROPHY CASE reads completedAt, so it is recorded from day one).
     • dismissal — the Commander waved a quest off. Dismissed = STOP FOREVER (the anti-nag law, same as
       curiosity questions): it never re-renders and never re-fires, even if the underlying thing later
       completes. Only suggestion-class quests are dismissible (dossier "get to know you" asks); milestones
       are achievements — an achievement can't nag, so it can't be dismissed.
     • completion detection = a STATUS DIFF between projections: a quest last seen open that is now done
       has genuinely completed (the real thing happened), and that edge is worth exactly one celebration.
       A quest FIRST seen already done is backfilled (completedAt recorded); whether it ALSO celebrates
       turns on ONE discriminator — was the whole state fresh (seen empty) before this fold?
         · FRESH state (first ever sync): backfill SILENTLY. Resuming a save / a first boot must not fire a
           celebration storm for old history (and a brand-new quest kind that ships already-earned lands here).
         · EXISTING state: a quest that appears already-done is a completion the Commander earned WHILE AWAY
           (an open→done edge we never got to observe live) — celebrate it exactly once. The persistent notify
           record is its receipt; an away completion must never vanish unseen.

   THE LAW (inherited from xp.js): quests never mint XP. A completion pays out sound + toast + flourish
   (the store's job) — leveling stays locked to user feedback on real built work.

   PURE + node-testable (mirrors quests.js): no Date.now / Math.random — the caller injects the clock. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.QuestState = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fresh() { return { v: 1, seen: {}, dismissed: {} }; }

  // defensively rebuild a persisted slice: every entry re-validated, junk dropped (never a crash on a bad save).
  function hydrate(raw) {
    const s = fresh();
    if (!raw || typeof raw !== 'object') return s;
    const seen = (raw.seen && typeof raw.seen === 'object') ? raw.seen : {};
    for (const id of Object.keys(seen)) {
      const r = seen[id];
      if (!id || !r || typeof r !== 'object') continue;
      const first = Number(r.firstSeenAt);
      if (!Number.isFinite(first)) continue;
      // null/undefined must round-trip as null — Number(null) is 0 (finite!), which would resurrect a
      // never-completed quest as "completed at epoch" (a 1969 trophy). Guard the null case before coercing,
      // mirroring stationquests.js's hydrate. A stored 0 from the pre-fix bug window ALSO reads as null here:
      // the trophy case then renders it "completed, date unknown" rather than 1969 (the migration choice —
      // an honest completion with no knowable date beats a fabricated one).
      const comp = (r.completedAt == null || r.completedAt === 0) ? NaN : Number(r.completedAt);
      s.seen[id] = {
        firstSeenAt: first,
        completedAt: Number.isFinite(comp) ? comp : null,
        lastStatus: r.lastStatus === 'done' ? 'done' : 'open'
      };
    }
    const dis = (raw.dismissed && typeof raw.dismissed === 'object') ? raw.dismissed : {};
    for (const id of Object.keys(dis)) {
      const t = Number(dis[id]);
      if (id && Number.isFinite(t)) s.dismissed[id] = t;
    }
    return s;
  }

  // which quests QuestState MAY wave off (GB-24 — dismiss everywhere). QuestState is the denylist for every
  // kind that has NO external per-store denylist of its own: the dossier "get to know you" asks, milestone
  // achievements, and the station-arc rows all fall to it. The kinds EXCLUDED here are excluded on purpose:
  //   • station-gap / work / maintenance / ledger own their OWN durable denylist (their store's dismiss) — the
  //     panel routes those there, never here, so a double-denylist can't disagree.
  //   • idea — its cadence is owned by SuggestStore in COMMS; dismissing it here would fight that store's budget.
  //   • arc-goal / arc-step — a coupled, persisted GOAL PATH (retires only on real drift), not a standalone nag,
  //     and it carries no dismiss affordance; waving off one step would fracture the chain.
  function dismissible(q) {
    if (!q || !q.kind) return false;
    switch (q.kind) {
      case 'station-gap': case 'work': case 'maintenance': case 'ledger': return false;
      case 'idea': case 'arc-goal': case 'arc-step': return false;
      default: return true;   // dossier, milestone, station — QuestState is their permanent denylist
    }
  }

  // fold ONE projection into the state (in place, like Dossier.upsert). Returns the quests that made an
  // open→done transition THIS fold — the celebratable completions. A quest already done when first seen
  // backfills completedAt; it ALSO celebrates iff the state pre-existed (an away completion we never saw),
  // and stays silent iff the state was fresh (first-boot history must not storm — see the header note).
  function fold(state, quests, now) {
    const completions = [];
    if (!state || !state.seen) return { state, completions };
    // the D3 discriminator, sampled ONCE before the loop: a truly-fresh state (no prior seen entries) is a
    // first sync — its already-done quests are old history and backfill silently. A pre-existing state that
    // now shows a first-seen-done quest is an AWAY completion (open→done we never got to observe) → celebrate.
    const wasFresh = Object.keys(state.seen).length === 0;
    const arr = Array.isArray(quests) ? quests : [];
    for (const q of arr) {
      if (!q || !q.id) continue;
      if (state.dismissed[q.id] != null) continue;   // dismissed = stop forever: no tracking, no celebration
      const status = q.status === 'done' ? 'done' : 'open';
      const rec = state.seen[q.id];
      if (!rec) {
        state.seen[q.id] = { firstSeenAt: now, completedAt: status === 'done' ? now : null, lastStatus: status };
        // first-seen-already-done on an EXISTING state = a completion the Commander earned while away — the
        // fold never saw the open→done edge, but it IS a completion (the notify record is the receipt).
        if (status === 'done' && !wasFresh) completions.push(q);
        continue;
      }
      if (rec.lastStatus !== 'done' && status === 'done') { rec.completedAt = now; completions.push(q); }
      rec.lastStatus = status;   // done→open regressions (e.g. a forgotten belief) keep the LAST completedAt; a later re-completion is a genuinely new edge and celebrates again
    }
    return { state, completions };
  }

  // wave a quest off forever. Returns true only when the dismissal actually took (dismissible kind).
  function dismiss(state, quest, now) {
    if (!state || !state.dismissed || !quest || !quest.id || !dismissible(quest)) return false;
    if (state.dismissed[quest.id] != null) return false;   // already gone — idempotent
    state.dismissed[quest.id] = now;
    return true;
  }

  const isDismissed = (state, id) => !!(state && state.dismissed && id && state.dismissed[id] != null);

  // the render filter: a dismissed quest NEVER re-renders.
  function visible(state, quests) {
    const arr = Array.isArray(quests) ? quests : [];
    if (!state || !state.dismissed) return arr;
    return arr.filter(q => q && q.id && state.dismissed[q.id] == null);
  }

  // the per-quest durable record (or null): { firstSeenAt, completedAt, lastStatus, dismissedAt }.
  function stateOf(state, id) {
    if (!state || !id) return null;
    const rec = state.seen && state.seen[id];
    const dismissedAt = (state.dismissed && state.dismissed[id] != null) ? state.dismissed[id] : null;
    if (!rec && dismissedAt == null) return null;
    return {
      firstSeenAt: rec ? rec.firstSeenAt : null,
      completedAt: rec ? rec.completedAt : null,
      lastStatus: rec ? rec.lastStatus : null,
      dismissedAt: dismissedAt
    };
  }

  return { fresh, hydrate, fold, dismiss, dismissible, isDismissed, visible, stateOf };
});
