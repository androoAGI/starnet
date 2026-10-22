/* AGENT OS — curiosity.js : the PURE engine for JUST-IN-TIME CURIOSITY (Commander Dossier, Phase B slice 2).

   The gentle counterpart to the full intake interview: when the station notices it still doesn't know
   something about its Commander that shapes how it works, it asks about ONE thing — once, never naggy. This
   engine is the pure decision: given the dossier's still-blank dimensions, what the user has dismissed, and
   how many times we've already asked this session, pick the single dimension to ask about next (or nothing).

   Anti-nag by construction: a hard per-session cap, dimensions are asked in canonical order, and a dimension
   is never raised again once the Commander DISMISSES it OR once it has been asked-and-ignored enough times
   (stop-forever after ASK_LIMIT unanswered asks — silence reads as "leave it" so we don't loop the same
   question across sessions). PURE + node-testable (a `Curiosity` global in the browser, module.exports under
   node); the session count, the persisted dismissals, and the persisted per-dimension ask counts live in
   curiositystore.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Curiosity = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CAP = 1;        // at most one curiosity nudge per session (the rest of "getting to know you" is the opt-in interview)
  const ASK_LIMIT = 2;  // after this many asked-and-ignored sessions, stop raising a dimension FOR GOOD (anti-loop)
  const MIN_WORK = 3;   // WORK-EARNED gate (beat-fat trim, 2026-07-03): the station must complete this many REAL
                        // task-runs in a session before it has earned the right to ask a get-to-know-you question.
                        // An unearned ask is exactly the "fake and unprompted" texture the Commander flagged.
  // HUNT MODE (ONBOARDING V3 §7): while the station is BELOW the readiness gate it may not recommend — so its
  // standing job is closing the context gap. The hunt profile makes curiosity hungrier: the work-earned floor
  // is waived (the gap IS the reason to ask — there may be no work yet to earn with) and the session budget
  // doubles. Every anti-nag protection that involves the Commander's own signal stays fully in force:
  // dismissed = never again, asked-and-ignored stops at ASK_LIMIT, and asks still ride natural moments only.
  const HUNT_CAP = 2;

  // the persisted shape: which dimensions the Commander has waved off (dismissed → never again), and how many
  // times each blank dimension has been ASKED-and-ignored (asked → stop after ASK_LIMIT, so silence ends the loop).
  function fresh() { return { v: 1, dismissed: {}, asked: {} }; }

  // is this dimension worn out — explicitly dismissed, or asked-and-ignored to the limit?
  function exhausted(dim, dismissed, asked, askLimit) {
    if (dismissed && dismissed[dim]) return true;
    const n = asked && Number.isFinite(asked[dim]) ? asked[dim] : 0;
    return n >= askLimit;
  }

  // the decision. Returns the single dimension key to ask about next, or null for "stay quiet".
  //   blank     — dossier dimensions with no belief yet (canonical order; from Dossier.summary().blank)
  //   dismissed — map of dimension keys the user has waved off ({ stack: true, ... })
  //   asked     — map of dimension key -> times asked-and-not-answered ({ stack: 2, ... }); stop at askLimit
  //   count     — how many nudges already shown THIS session
  //   cap       — the per-session ceiling (defaults to CAP)
  //   askLimit  — the stop-forever ceiling on unanswered asks (defaults to ASK_LIMIT)
  //   work      — completed task-runs THIS session; below minWork the ask is unearned → quiet.
  //               Absent/non-finite = unknown caller (fail-open, no gate) — the live store always passes it.
  //   minWork   — the earned-ask floor (defaults to MIN_WORK)
  //   order     — OPTIONAL preferred ask order (dimension keys, best-first): the value-of-information ranking
  //               from the understanding engine, so the ONE earned question targets the dimension whose answer
  //               most sharpens the station's model of the Commander. Only re-orders — every gate (cap, earned
  //               floor, dismissed, stop-forever) applies unchanged, and a dim NOT in `order` still falls back
  //               to its canonical position after the ordered ones (never silently unaskable).
  function pick(opts) {
    opts = opts || {};
    let blank = Array.isArray(opts.blank) ? opts.blank : [];
    if (Array.isArray(opts.order) && opts.order.length && blank.length) {
      const pos = {}; opts.order.forEach((k, i) => { if (!(k in pos)) pos[k] = i; });
      blank = blank.slice().sort((a, b) => ((a in pos) ? pos[a] : 1e9) - ((b in pos) ? pos[b] : 1e9));
    }
    const dismissed = (opts.dismissed && typeof opts.dismissed === 'object') ? opts.dismissed : {};
    const asked = (opts.asked && typeof opts.asked === 'object') ? opts.asked : {};
    const count = Number.isFinite(opts.count) ? opts.count : 0;
    const hunting = !!opts.hunting;   // V3 hunt profile: below the readiness gate, curiosity is the product's job
    const cap = Number.isFinite(opts.cap) ? opts.cap : (hunting ? HUNT_CAP : CAP);
    const askLimit = Number.isFinite(opts.askLimit) ? opts.askLimit : ASK_LIMIT;
    const minWork = Number.isFinite(opts.minWork) ? opts.minWork : MIN_WORK;
    if (!hunting && Number.isFinite(opts.work) && opts.work < minWork) return null;   // ask not yet earned by real work (waived while hunting — the gap is the earning)
    if (count >= cap) return null;            // budget spent for this session — stay quiet
    for (const dim of blank) if (!exhausted(dim, dismissed, asked, askLimit)) return dim;   // first still-live dimension
    return null;                              // nothing left worth asking
  }

  // defensively rebuild the persisted state from a (possibly malformed / old) blob.
  function hydrate(raw) {
    const s = fresh();
    if (raw && typeof raw === 'object') {
      if (raw.dismissed && typeof raw.dismissed === 'object') {
        for (const k of Object.keys(raw.dismissed)) if (raw.dismissed[k]) s.dismissed[k] = true;
      }
      if (raw.asked && typeof raw.asked === 'object') {
        for (const k of Object.keys(raw.asked)) { const n = Math.floor(Number(raw.asked[k])); if (Number.isFinite(n) && n > 0) s.asked[k] = n; }
      }
    }
    return s;
  }

  return { fresh, pick, hydrate, exhausted, CAP, ASK_LIMIT, MIN_WORK, HUNT_CAP };
});
