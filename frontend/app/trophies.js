/* AGENT OS — trophies.js : the PURE trophy-surface projection (Game session, Phase G3b / Layer 6).

   The TROPHY CASE prop opens a surface that makes the station's REAL achievements permanent and visible.
   This engine folds the honest signals the station already tracks into a render-agnostic shape:
     • earned MILESTONES + completed QUESTS (dossier / station-arc / capability-gap fix-its) — every quest
       whose real thing genuinely happened. The date comes from the durable QuestState memory (completedAt),
       NEVER invented: a completion with no knowable date renders "date unknown", never 1969.
     • the LIVING TOOLS shelf — Commander-saved seeds with their lifetime reuse counts (fed by the G3b
       seed-reuse aggregate). Honest counts only; a seed that never ran is not a trophy.

   HONESTY RULES (Part 4 laws, inherited from floorstats/pride):
     • A trophy is a REAL completion — the quest view already filtered to status:'done'. We never fabricate one.
     • completedAt is passed through raw (null when unknown) so the caller formats the date; a null renders
       dateless, not epoch-0. This is the whole point of the G3b hydrate fix: no 1969 trophies.
     • An EMPTY case reports empty:true so the surface shows honest dust, not placeholder trophies.
     • NO XP, EVER. Reading trophies is a projection; it mints nothing (the XP law — quests/trophies never
       inflate the ladder). This engine has no XP surface to touch.

   PURE + node-testable (a `Trophies` global in the browser, module.exports under node). No DOM/clock/rng —
   the caller injects the quest list, the per-id stateOf lookup, and the living-tools rows. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Trophies = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const str = v => (v == null ? '' : String(v));
  // a real completion date, or null. Number(null)===0 is finite (the very bug the hydrate fix guards) — so a
  // 0 here is NOT a real date either: it reads as "date unknown", never epoch-0/1969.
  function completedAt(v) {
    if (v == null) return null;
    const n = Number(v);
    return (Number.isFinite(n) && n > 0) ? n : null;
  }

  /* build the trophy surface. input:
       quests   — the QuestStore.view().quests list (open + done, already shaped: {id, kind, title, status}).
       stateOf  — (id) => durable record or null (QuestStateStore.stateOf); we read .completedAt for the date.
       tools    — the living-tools rows: [{ name, runs, sevenDay }] (the seed-reuse aggregate's lifetime counts).
     Returns render-agnostic state: the earned trophies (newest real completion first; dateless ones last),
     the honest counts, and the living-tools shelf. */
  function build(input) {
    input = input || {};
    const quests = Array.isArray(input.quests) ? input.quests : [];
    const stateOf = (typeof input.stateOf === 'function') ? input.stateOf : (() => null);
    const toolsIn = Array.isArray(input.tools) ? input.tools : [];

    const trophies = [];
    for (const q of quests) {
      if (!q || !q.id || q.status !== 'done') continue;   // a trophy is a REAL completion, nothing else
      let at = null;
      try { const rec = stateOf(q.id); at = rec ? completedAt(rec.completedAt) : null; } catch (_) { at = null; }
      trophies.push({
        id: str(q.id),
        kind: str(q.kind) || 'milestone',
        title: str(q.title) || str(q.id),
        reward: str(q.reward),
        completedAt: at,                 // null = honestly "date unknown" (never 1969)
        dateKnown: at != null
      });
    }
    // newest first; a dateless (date-unknown) trophy sinks below every dated one — a stable, honest order.
    trophies.sort((a, b) => {
      const ak = a.dateKnown ? 1 : 0, bk = b.dateKnown ? 1 : 0;
      if (ak !== bk) return bk - ak;                       // known dates above unknown
      if (ak && bk) return b.completedAt - a.completedAt;  // newest first
      return a.title.localeCompare(b.title);               // stable tiebreak for the dateless
    });

    // the living-tools shelf: seeds with a REAL lifetime reuse count (>0). A seed that never ran is not a
    // trophy — silence over a fabricated 0. Sorted by lifetime runs desc, then name.
    const tools = toolsIn
      .filter(t => t && str(t.name) && Number(t.runs) > 0)
      .map(t => ({ name: str(t.name), runs: Math.max(0, Math.floor(Number(t.runs) || 0)), sevenDay: Math.max(0, Math.floor(Number(t.sevenDay) || 0)) }))
      .sort((a, b) => (b.runs - a.runs) || a.name.localeCompare(b.name));

    return {
      trophies,
      tools,
      earned: trophies.length,
      empty: trophies.length === 0 && tools.length === 0
    };
  }

  return { build, _completedAt: completedAt };
});
