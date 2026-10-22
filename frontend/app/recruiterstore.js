/* AGENT OS — recruiterstore.js : the live read surface that joins the adaptive-recruitment inputs and runs the
   pure Recruiter matcher (engine in recruiter.js).

   The browser glue between the persisted models and the two delivery surfaces (the bay's CURATED shelf +
   the one earned recruit beat). It owns NO state and NEVER emits on U.bus — it just READS, on demand:
     • the capability histogram   — WorkSignalStore.model()   (the raw signal + an injected clock)
     • the interest profile        — ProfileStore              (score(tags) — only when learning is ON)
     • the Commander dossier        — DossierStore.beliefs('goals'|'pain'|'ambition')  (belief texts)
     • the live roster              — App.agents()             (occupied specialtyIds — a class already on the crew)
     • the catalog                  — Specialties.builtins()
   and hands them to Recruiter.recommend(). Because it derives everything live from persisted counters, the shelf
   and the beat READ THE SAME SOURCE — so they can never disagree (same top pick, same why), as the task requires.

   Gated on the profile's learning-enabled flag (the SAME glass-box switch worksignal folding respects): learning
   OFF → no curation (the bay falls back to today's honest lineup). node-exportable for symmetry (no test needed —
   the pure matcher owns the logic; this is thin live glue). */
'use strict';
const RecruiterStore = (() => {
  const now = () => (typeof Date !== 'undefined' ? Date.now() : 0);
  const learningOn = () => (typeof ProfileStore !== 'undefined' && ProfileStore.enabled) ? ProfileStore.enabled() : true;
  // ONE recommendation gate: tool use proves workflow, not direction or who the work serves. Personalized and
  // proactive hiring waits for the dossier-owned readiness verdict; a missing read fails closed.
  function recommendationsReady() {
    try {
      const r = (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.readiness) ? UnderstandingStore.readiness() : null;
      return !!(r && r.ready);
    } catch (_) { return false; }
  }

  // the occupied specialtyIds — a class already represented on the crew is never re-recommended.
  function rosterIds() {
    try {
      if (typeof App !== 'undefined' && App.agents) return App.agents().map(a => a && a.specialtyId).filter(Boolean);
    } catch (_) {}
    return [];
  }

  // the dossier's stated-direction belief texts, per dim.
  function beliefTexts(dim) {
    try {
      if (typeof DossierStore !== 'undefined' && DossierStore.beliefs) return (DossierStore.beliefs(dim) || []).map(b => b && b.text).filter(Boolean);
    } catch (_) { }
    return [];
  }

  // run the matcher against the LIVE inputs. Returns { warm, items:[{ classId, why, confidence, evidence }] }.
  // Empty (warm:false) when: the engine/catalog is missing, learning is OFF, or the signal is below the floor —
  // every one an HONEST reason for the bay to fall back to the cold-start lineup.
  function recommend() {
    if (typeof Recruiter === 'undefined' || typeof Specialties === 'undefined' || !Specialties.builtins) return { warm: false, items: [] };
    if (!learningOn()) return { warm: false, items: [] };
    if (!recommendationsReady()) return { warm: false, items: [] };
    const sig = (typeof WorkSignalStore !== 'undefined' && WorkSignalStore.model) ? WorkSignalStore.model() : null;
    if (!sig) return { warm: false, items: [] };
    const profile = (typeof ProfileStore !== 'undefined') ? ProfileStore : null;   // Recruiter uses profile.score(tags)
    return Recruiter.recommend({
      worksignal: sig,
      profile: profile,
      dossier: { goals: beliefTexts('goals'), pain: beliefTexts('pain'), ambition: beliefTexts('ambition') },
      roster: rosterIds(),
      catalog: Specialties.builtins(),
      preferenceModel: (typeof ProspectStore !== 'undefined' && ProspectStore.preferenceModel) ? ProspectStore.preferenceModel() : null,
      now: now()
    });
  }

  /* the INTEREST GAP read: warm learned topics NOBODY on the crew covers (engine: Recruiter.interestGaps).
     Separate from recommend() by design — that one can only ever surface classes whose kit the Commander's work
     already touches, so it structurally cannot recommend a capability the station lacks. Same glass-box gate:
     learning OFF → nothing (the Commander opted out of being modelled, and this reads the learned histogram).
     Topics come from the SERVER's histogram via ProspectStore (GET /api/scout) — never invented here; with no
     read yet, or nothing warm, this returns [] and the bay renders exactly what it renders today. */
  function interestGaps() {
    if (typeof Recruiter === 'undefined' || !Recruiter.interestGaps) return { items: [] };
    if (typeof Specialties === 'undefined' || !Specialties.builtins) return { items: [] };
    if (!learningOn()) return { items: [] };
    if (!recommendationsReady()) return { items: [] };
    let topics = [];
    try { topics = (typeof ProspectStore !== 'undefined' && ProspectStore.interests) ? (ProspectStore.interests() || []) : []; } catch (_) { topics = []; }
    if (!topics.length) return { items: [] };
    return Recruiter.interestGaps({
      topics: topics,
      roster: rosterIds(),
      rosterSpecs: rosterSpecs(),
      catalog: Specialties.builtins()
    });
  }

  // the crew's REAL class specs — the catalog record for a rostered class, plus any CUSTOM class the catalog
  // never held (a custom specialist absolutely counts as covering its topic). Coverage is tested against these.
  function rosterSpecs() {
    const out = [];
    try {
      const agents = (typeof App !== 'undefined' && App.agents) ? (App.agents() || []) : [];
      for (const a of agents) {
        if (!a) continue;
        let spec = null;
        try { spec = (a.specialtyId && Specialties.get) ? Specialties.get(a.specialtyId) : null; } catch (_) { spec = null; }
        if (spec) out.push(spec);
        else if (a.name || a.purpose) out.push({ name: a.name || '', tagline: a.tagline || '', blurb: a.blurb || '', purpose: a.purpose || '', tags: a.tags || {} });
      }
    } catch (_) {}
    return out;
  }

  // the single best NEW hire (the beat proposes exactly one), or null when the signal is cold/thin — so the beat
  // NEVER fires on unearned data. { classId, spec, why, confidence } (spec = the full catalog record).
  function topPick() {
    const res = recommend();
    if (!res.warm || !res.items.length) return null;
    const top = res.items[0];
    const spec = (typeof Specialties !== 'undefined' && Specialties.get) ? Specialties.get(top.classId) : null;
    if (!spec) return null;
    return { classId: top.classId, spec, why: top.why, confidence: top.confidence, evidence: top.evidence };
  }

  return { recommend, topPick, interestGaps, recommendationsReady };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { RecruiterStore };
