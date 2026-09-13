/* STARNET — workquests.js : the PURE work-quest generator (G1c) — an accepted idea becomes a trackable build.

   When the Commander says "build it" to a First Pitch or an ongoing idea (pitchstore/suggeststore doBuild),
   that acceptance is a real commitment worth tracking. This engine turns it into a multi-step WORK quest whose
   steps are REAL progress, never invented busywork:
     • a RECIPE build with param-gaps → one step per still-missing required param (each answered gap ticks a
       step) + a final "launch it" step. Filling the gap and launching are the real thing happening.
     • a RECIPE build that's already runnable, or an AGENT-CAPABILITY (workflow) build → a single step: the
       launched run COMPLETING. Run-completion is the honest done-signal (no claim button).

   The honest-quest + XP laws (same as stationquests/maintquests):
     • completion is the REAL build happening (the recipe launched / the run finished) — never a claim.
     • DISMISSAL = STOP FOREVER (the Commander changed their mind; the anti-nag law).
     • NO XP — the payout is the real build, plus the shared celebration. XP still flows only from rating the
       finished work (xp.js law).
   If the accepted idea was SEEDBORN, the store passes a credit line (G3a SeedCredit) which the card carries —
   the mint→pitch→build loop, spoken on the quest card.

   PURE + node-testable (mirrors stationquests.js): no Date.now / Math.random — the caller injects the clock and
   the live "which required params are still missing?" list. The browser store (workqueststore.js) owns the live
   reads (the recipe's requiredMissing, the run lifecycle) + persistence; this file owns the deterministic fold +
   the projection into the shared Quests shape. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.WorkQuests = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fresh() { return { v: 1, seq: 0, quests: {} }; }

  const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

  // defensively rebuild a persisted slice: every entry re-validated, junk dropped (never a crash on a bad save).
  function hydrate(raw) {
    const s = fresh();
    if (!raw || typeof raw !== 'object') return s;
    s.seq = Math.max(0, Number(raw.seq) | 0);
    const quests = (raw.quests && typeof raw.quests === 'object') ? raw.quests : {};
    for (const id of Object.keys(quests)) {
      const r = quests[id];
      if (!id || !r || typeof r !== 'object') continue;
      const first = Number(r.firstSeenAt);
      if (!Number.isFinite(first)) continue;
      const steps = Array.isArray(r.steps) ? r.steps.map(st => ({
        key: clip(st && st.key, 40),
        label: clip(st && st.label, 80),
        done: !!(st && st.done)
      })).filter(st => st.key) : [];
      const comp = r.completedAt == null ? NaN : Number(r.completedAt);
      const dis = r.dismissedAt == null ? NaN : Number(r.dismissedAt);
      // stalled = a bound run ended without finishing (error/budget/max_iters/refusal). Null must round-trip
      // as null (Number(null) is a finite 0 — a stall "at epoch" would falsely mark a clean build stalled).
      const stall = r.stalledAt == null ? NaN : Number(r.stalledAt);
      s.quests[id] = {
        title: clip(r.title, 80),
        credit: clip(r.credit, 160),
        recipeId: r.recipeId == null ? null : clip(r.recipeId, 64),
        runId: r.runId == null ? null : clip(r.runId, 80),
        stalledReason: r.stalledReason == null ? null : clip(r.stalledReason, 24),
        steps,
        firstSeenAt: first,
        completedAt: Number.isFinite(comp) ? comp : null,
        dismissedAt: Number.isFinite(dis) ? dis : null,
        stalledAt: Number.isFinite(stall) ? stall : null
      };
    }
    return s;
  }

  /* mint a work quest from an accepted idea (in place). d = {
       title    — the idea's one-line title (the quest name)
       recipeId — the recipe being built (or null for an agent-capability/workflow build)
       gaps     — [ { key, label } ] the still-missing required params → one step each (recipe builds)
       credit   — an optional G3a seed-credit line the card carries (seedborn ideas)
     }. Shapes the steps:
       • gaps present → one step per gap ('gap:<key>') + a final 'launch' step.
       • no gaps (runnable recipe or workflow build) → a single 'run' step (the launched run completing).
     Returns the new quest id. Mint is intentionally NOT deduped by title: two genuine "build it"s are two real
     commitments (unlike a capability GAP, which is one wall). A brand-new id keeps them distinct + trackable. */
  function mint(state, d, now) {
    if (!state || !state.quests || !d) return null;
    d = d || {};
    const id = 'wq:' + (++state.seq);
    const gaps = Array.isArray(d.gaps) ? d.gaps.filter(g => g && g.key) : [];
    let steps;
    if (gaps.length) {
      steps = gaps.map(g => ({ key: 'gap:' + clip(g.key, 34), label: clip(g.label || g.key, 80), done: false }));
      steps.push({ key: 'launch', label: 'launch the build', done: false });
    } else {
      steps = [{ key: 'run', label: 'the build runs to completion', done: false }];
    }
    state.quests[id] = {
      title: clip(d.title || 'a build', 80),
      credit: clip(d.credit || '', 160),
      recipeId: d.recipeId == null ? null : clip(d.recipeId, 64),
      runId: null,
      stalledReason: null,
      steps,
      firstSeenAt: now,
      completedAt: null,
      dismissedAt: null,
      stalledAt: null
    };
    return id;
  }

  // tick a NAMED step done (in place). Returns true if it flipped a previously-open step (idempotent otherwise).
  // Marking the last open step completes the quest (completedAt stamped) — the open→done edge QuestState folds.
  function tickStep(state, id, stepKey, now) {
    const q = state && state.quests && state.quests[id];
    if (!q || q.dismissedAt != null || q.completedAt != null) return false;
    const st = q.steps.find(s => s.key === stepKey);
    if (!st || st.done) return false;
    st.done = true;
    if (q.stalledAt != null) { q.stalledAt = null; q.stalledReason = null; }   // fresh progress un-stalls a re-run
    if (q.steps.every(s => s.done)) q.completedAt = now;
    return true;
  }

  // bind the launched run's id to a quest (so run.end can find the quest to complete on a 'run' build).
  // A re-launch of a stalled build re-binds cleanly — binding a run clears the stall (the build is live again).
  function bindRun(state, id, runId) {
    const q = state && state.quests && state.quests[id];
    if (!q || q.dismissedAt != null || q.completedAt != null) return false;
    q.runId = String(runId == null ? '' : runId) || null;
    if (q.runId && q.stalledAt != null) { q.stalledAt = null; q.stalledReason = null; }
    return !!q.runId;
  }

  /* STALL a build whose bound run ended without finishing (reason ∈ error|budget|max_iters|refusal — never
     'done', never 'cancelled'). This is the honesty fix: a non-clean run end must resolve the quest, never
     orphan it open with no feedback — but it must NOT mark any unfinished step complete. We stamp stalledAt +
     the reason (for the card copy), release the run binding (so a stale/reused runId can't later "complete"
     this quest via questForRun), and leave the steps exactly as they were. A later re-launch re-binds + un-
     stalls (bindRun/tickStep above). Returns true only when it actually flipped an open, non-stalled quest. */
  function stall(state, id, reason, now) {
    const q = state && state.quests && state.quests[id];
    if (!q || q.dismissedAt != null || q.completedAt != null || q.stalledAt != null) return false;
    q.stalledAt = now;
    q.stalledReason = clip(reason || 'error', 24) || 'error';
    q.runId = null;   // release the binding — the failed run is done; only a fresh launch re-claims this build
    return true;
  }

  // the OPEN quest bound to a given runId (or null) — the store's hook for a run finishing/failing.
  function questForRun(state, runId) {
    if (!state || !state.quests || runId == null) return null;
    const rid = String(runId);
    for (const id of Object.keys(state.quests)) {
      const q = state.quests[id];
      if (q && q.dismissedAt == null && q.completedAt == null && q.runId === rid) return id;
    }
    return null;
  }

  // wave a build off forever. Returns true only when it actually took (a known, not-already-dismissed quest).
  function dismiss(state, id, now) {
    const q = state && state.quests && state.quests[id];
    if (!q || q.dismissedAt != null) return false;
    q.dismissedAt = now;
    return true;
  }

  const isDismissed = (state, id) => !!(state && state.quests && id && state.quests[id] && state.quests[id].dismissedAt != null);

  /* project into the shared Quests shape (kind 'work'). A dismissed build is omitted (stop forever). The desc
     names the step progress ("2 of 3 — fill: <next gap>") so the card reads as real, trackable direction. The
     seed-credit line rides the desc when present. Deterministic ordering: open before done, then firstSeenAt. */
  function project(state) {
    if (!state || !state.quests) return [];
    const entries = Object.keys(state.quests).map(id => Object.assign({ id }, state.quests[id]))
      .filter(e => e.dismissedAt == null);
    entries.sort((a, b) => {
      const ad = a.completedAt != null ? 1 : 0, bd = b.completedAt != null ? 1 : 0;
      if (ad !== bd) return ad - bd;
      return (a.firstSeenAt || 0) - (b.firstSeenAt || 0);
    });
    return entries.map(e => {
      const done = e.completedAt != null;
      const stalled = !done && e.stalledAt != null;
      const total = e.steps.length, doneN = e.steps.filter(s => s.done).length;
      const next = e.steps.find(s => !s.done);
      const prog = total > 1 ? (doneN + ' of ' + total + ' — ') : '';
      const credit = e.credit ? (' ' + e.credit) : '';
      // a stalled build is NOT done — no false completion, no gold celebration. It reads honestly as "stalled"
      // (with the run's end reason) and stays re-runnable: another "build it" starts a fresh run.
      const stallWord = e.stalledReason === 'budget' ? 'the run hit its budget'
        : e.stalledReason === 'max_iters' ? 'the run looped out without finishing'
        : e.stalledReason === 'refusal' ? 'the model declined the run'
        : 'the run errored out';
      return {
        id: e.id,
        kind: 'work',
        runId: e.runId || null,
        stalled: stalled,   // Tier 2 (additive): consumers tracking a bound build (goalstore.questLive) need stalled-vs-in-flight without parsing the title
        title: (done ? 'built — ' : (stalled ? '⚑ stalled: ' : '⚑ build: ')) + (e.title || 'a build'),
        desc: done
          ? ('done — the build ran.' + credit)
          : stalled
            ? (stallWord + ' — run it again when you\'re ready.' + credit)
            : (prog + (next ? next.label : 'in progress') + credit),
        reward: 'a real, working build',
        status: done ? 'done' : 'open'
      };
    });
  }

  function openCount(state) {
    if (!state || !state.quests) return 0;
    let n = 0;
    for (const id of Object.keys(state.quests)) {
      const e = state.quests[id];
      if (e && e.dismissedAt == null && e.completedAt == null) n++;
    }
    return n;
  }

  return { fresh, hydrate, mint, tickStep, bindRun, stall, questForRun, dismiss, isDismissed, project, openCount };
});
