/* STARNET — queststore.js : the thin, STATELESS read-join behind the QUEST LOG panel.

   No state, no persistence, no bus subscription — it just gathers the live, honest progress the station
   already tracks and hands it to the pure Quests engine:
     • the STATION xp rollup (XpStore.stationStats → Xp.compute meter + Xp.milestones) — real achievements,
     • the Commander dossier's known/blank dimensions (DossierStore) — get-to-know-you quests,
     • whether a tailored idea is currently due (SuggestStore.willSuggest) — one actionable quest.

   A projection, not an owner (mirrors the dossierstore read-surface idiom). NEVER emits on U.bus. Every read
   is guarded so a missing subsystem degrades to "fewer quests", never a crash. node-exportable for its test. */
'use strict';
const QuestStore = (() => {
  function gather() {
    const sStats = (typeof XpStore !== 'undefined' && XpStore.stationStats) ? XpStore.stationStats() : null;
    const meter = (typeof Xp !== 'undefined' && sStats) ? Xp.compute(sStats) : null;
    const milestones = (typeof Xp !== 'undefined' && sStats) ? Xp.milestones(sStats) : [];
    const sum = (typeof DossierStore !== 'undefined' && DossierStore.summary) ? DossierStore.summary() : null;
    const dimDefs = (typeof DossierStore !== 'undefined' && DossierStore.dims) ? DossierStore.dims() : [];
    const known = (sum && Array.isArray(sum.known)) ? sum.known : [];
    const dossierDims = (Array.isArray(dimDefs) ? dimDefs : []).map(d => ({ key: d.key, label: d.label, known: known.indexOf(d.key) >= 0 }));
    const pendingIdea = (typeof SuggestStore !== 'undefined' && SuggestStore.willSuggest) ? !!SuggestStore.willSuggest() : false;
    // the STATION ARC inputs (recruit → belts → portals): honest live counts. The arc only exists when the
    // floor source (World) is actually present — a missing subsystem means NO arc (fewer quests, never a
    // crash, and never an arc claiming a floor we can't read).
    const counts = (typeof World !== 'undefined' && World.stationCounts) ? World.stationCounts() : null;
    const crew = (typeof App !== 'undefined' && App.crewCount) ? App.crewCount() : 0;
    const station = counts ? { crew, belts: counts.belts || 0, connectors: counts.connectors || 0, liveRoute: counts.liveRoute || 0 } : null;
    // G1b — the station-quest generator's fix-it quests (capdenied/capability-gap → "place a DISH in its bay").
    // Already fully shaped by the pure StationQuests engine (the store owns the live reads); a missing store
    // just means no station-gap quests (fewer quests, never a crash — the read-surface degradation idiom).
    const stationGaps = (typeof StationQuestStore !== 'undefined' && StationQuestStore.quests) ? StationQuestStore.quests() : [];
    // G1c — accepted-idea WORK quests (multi-step, ride the QuestState celebration) + MAINTENANCE quests
    // (recurring slag causes + jammed routines). Both pre-shaped by their pure engines; a missing store just
    // means fewer quests (never a crash — the same read-surface degradation idiom as stationGaps).
    const workQuests = (typeof WorkQuestStore !== 'undefined' && WorkQuestStore.quests) ? WorkQuestStore.quests() : [];
    const maintQuests = (typeof MaintQuestStore !== 'undefined' && MaintQuestStore.quests) ? MaintQuestStore.quests() : [];
    // Tier 2 — the ACTIVE GOAL arc (header + progress meter + milestone steps). Pre-shaped by the pure Goals
    // engine (GoalStore owns the live reads + the drift/reconcile sync); a missing store just means no arc (fewer
    // quests, never a crash — the same read-surface degradation idiom as stationGaps).
    const arcQuests = (typeof GoalStore !== 'undefined' && GoalStore.quests) ? GoalStore.quests() : [];
    const relatedWork = (typeof GoalStore !== 'undefined' && GoalStore.relatedWork) ? GoalStore.relatedWork() : [];
    // QUEST V2 §C — the HARNESS LEDGER (sidecar-owned /api/quests). QuestLedgerStore holds the last-good poll
    // and hands the shaped, non-dismissed ledger quests here; a missing/absent store just means no ledger quests
    // (fewer quests, never a crash — the same read-surface degradation idiom as stationGaps).
    const ledgerQuests = (typeof QuestLedgerStore !== 'undefined' && QuestLedgerStore.quests) ? QuestLedgerStore.quests() : [];
    return { meter, milestones, dossierDims, pendingIdea, station, stationGaps, workQuests, maintQuests, arcQuests, relatedWork, ledgerQuests };
  }

  // the whole panel read: the station meter + the ordered quest list + open/done counts.
  function view() {
    const g = gather();
    const quests = (typeof Quests !== 'undefined') ? Quests.build({ milestones: g.milestones, dossierDims: g.dossierDims, pendingIdea: g.pendingIdea, station: g.station, stationGaps: g.stationGaps, workQuests: g.workQuests, maintQuests: g.maintQuests, arcQuests: g.arcQuests, relatedWork: g.relatedWork, ledgerQuests: g.ledgerQuests }) : [];
    const summary = (typeof Quests !== 'undefined') ? Quests.summary(quests) : { open: 0, done: 0, total: 0 };
    return { meter: g.meter, quests: quests, summary: summary };
  }

  return { view };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { QuestStore };
