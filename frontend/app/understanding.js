/* AGENT OS — understanding.js : the PURE "how well the station understands its Commander" engine.

   The unifying CONFIDENCE layer over the Commander Dossier (dossier.js). Where dossier.summary()
   reports BREADTH (fraction of dimensions with any belief — dossier.js:166) and profile.summary()
   reports work-observation DEPTH (samples/24 — profile.js:114), this engine reports how well-GROUNDED
   the station's belief in each dimension is — folding belief count, provenance (Commander-authored /
   pinned vs study-observed), recency (stale beliefs decay, so drift lowers confidence on its own), and
   corroboration from real work. It rolls those into one honest `overall` understanding ∈ [0,1],
   weighted toward the north-star-critical dims (goals / ambition / pain), and names the single
   `weakest` dimension (highest weight × lowest confidence): the value-of-information target a rare
   earned question should aim at.

   TRUTHFUL TELEMETRY (the product's core law): understanding is derived ONLY from beliefs the station
   actually holds, decayed by staleness — it never fabricates certainty the harness can't prove. A cold
   station reads 0; a station whose beliefs have gone stale reads DOWN, never up. No autonomous belief
   revision happens here — this is a READ-MODEL over state that already persists (the dossier).

   PURE + testable, mirroring profile.js / dossier.js / xp.js: an `Understanding` global in the browser,
   module.exports under node. The clock is ALWAYS injected (`now`) — no Date.now / Math.random here — so
   decay is deterministic and node tests can fast-forward time. The browser wiring supplies Date.now()
   at the edge. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Understanding = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- tunables (one place to retune the whole feel) ----
  // the dossier's dimensions, in a DETERMINISTIC weight-desc order (ties broken by this order) so `weakest`
  // and `overall` are byte-stable for identical state. north-star-critical dims (what the star points AT)
  // weigh more, because "understanding" is defined relative to the goal — a crisp `stack` with a blank
  // `goals` is NOT a well-understood Commander.
  const DIMS = [
    { key: 'goals',           weight: 3 },
    { key: 'ambition',        weight: 3 },
    { key: 'pain',            weight: 2 },
    { key: 'identity',        weight: 1 },
    { key: 'stack',           weight: 1 },
    { key: 'style',           weight: 1 },
    { key: 'standing_orders', weight: 1 },
    { key: 'people',          weight: 1 },
    { key: 'schedule',        weight: 1 }
  ];
  const DIM_KEYS = DIMS.map(d => d.key);
  const WEIGHT = DIMS.reduce((m, d) => (m[d.key] = d.weight, m), {});

  const HALF_LIFE_MS = 60 * 24 * 60 * 60 * 1000;  // a belief's freshness halves every ~60 days of silence. Longer
                                                  // than profile.js's 14d: goals/ambition drift slower than work-mix,
                                                  // but they DO drift — this is the structural staleness signal (P4).
  // provenance weight: a Commander-authored (or onboarding-seeded) belief is asserted truth; a study-OBSERVED
  // belief is an inference that counts less until real work corroborates it. Matches the consent-gated learning model.
  const SOURCE_WEIGHT = { commander: 1, onboarding: 1, study: 0.6 };
  // Evidence weight is the newer, more precise authority. In particular a mechanical onboarding seed may inform
  // a prompt but must not inflate the visible FAMILIARITY meter while the readiness gate correctly rejects it.
  const EVIDENCE_WEIGHT = { stated: 1, synth: 0.8, observed: 0.6, seed: 0 };
  const DEFAULT_SOURCE_WEIGHT = 0.8;              // an unknown/legacy source: between authored and observed
  const CORROB_UNIT = 0.5;                        // each corroborating run (P2) is worth ~half a fresh authored belief
  const DEPTH_SAT = 1.4;                          // evidence→confidence saturation: 1 fresh authored belief ≈ 0.51,
                                                  // ~1.4 ≈ 0.63, ~2.8 ≈ 0.86 — diminishing, never a hard 1.
  const CALIBRATING = 0.35;                       // overall below this reads as "still getting to know you"

  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : 0; }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function sourceWeight(src) {
    if (src && Object.prototype.hasOwnProperty.call(SOURCE_WEIGHT, src)) return SOURCE_WEIGHT[src];
    return DEFAULT_SOURCE_WEIGHT;
  }
  function beliefStrength(b) {
    if (b && typeof b.weight === 'string' && Object.prototype.hasOwnProperty.call(EVIDENCE_WEIGHT, b.weight)) return EVIDENCE_WEIGHT[b.weight];
    return sourceWeight(b && b.source);
  }

  // a belief's freshness ∈ [0,1], exponentially decayed by the silence since it was last touched. A PINNED belief
  // is Commander-asserted-durable and never decays (freshness 1). A belief with no usable timestamp is treated as
  // fresh (unknown age is not evidence of staleness — never penalize a hydrated legacy belief we can't date).
  function freshness(belief, now) {
    if (!belief || belief.pinned) return 1;
    const t = num(belief.updatedAt) || num(belief.createdAt);
    if (t <= 0) return 1;
    const dt = Math.max(0, num(now) - t);
    return Math.pow(0.5, dt / HALF_LIFE_MS);
  }

  // total EVIDENCE for one dimension = Σ (sourceWeight × freshness) over its beliefs, plus SIGNED corroboration
  // from real work (R2: a 👍 rating corroborates the current model; a 👎 is honest counter-evidence — "our model
  // of how they like work done is less certain" — which LOWERS confidence and re-aims the VOI question there).
  // Floored at 0 for the whole dim: counter-evidence can erase confidence, never mint negative certainty.
  function dimEvidence(beliefs, corrob, now) {
    let ev = 0;
    for (const b of (Array.isArray(beliefs) ? beliefs : [])) {
      if (!b || typeof b.text !== 'string' || !b.text) continue;
      ev += beliefStrength(b) * freshness(b, now);
    }
    ev += num(corrob) * CORROB_UNIT;
    return Math.max(0, ev);
  }

  // evidence → confidence ∈ [0,1): saturating, so more (or fresher, or Commander-confirmed) evidence always helps
  // but never asserts a hard 1 (the station is never "certain" — truthful telemetry).
  function confFromEvidence(ev) { return 1 - Math.exp(-Math.max(0, ev) / DEPTH_SAT); }

  // read the beliefs for a dimension out of a dossier blob (the dossier.js shape: { dims: { key: [belief] } }).
  function beliefsOf(dossier, key) {
    return (dossier && dossier.dims && Array.isArray(dossier.dims[key])) ? dossier.dims[key] : [];
  }

  /* ---------- the read ----------
     understanding(dossier, opts) → {
       dims: { key: { conf, weight, beliefs, evidence, blank } },
       overall,       // 0..1, weight-blended across dims
       clarity,       // alias of overall (the north-star surface reads this)
       weakest,       // { dim, conf, weight, gap } — the value-of-information target for the next earned question
       blanks,        // [key] with zero beliefs (breadth gaps)
       calibrating,   // overall < CALIBRATING
       workSamples    // honest passthrough of Profile.summary().samples (learned-from-N-runs), when supplied
     }
     opts: { now?, corroboration?: { key: count }, workSamples? } — all optional; a bare call is a cold read. */
  function understanding(dossier, opts) {
    opts = opts || {};
    const now = num(opts.now);
    const corroboration = opts.corroboration || {};

    const dims = {};
    let wSum = 0, wConf = 0;
    let weakest = null;
    for (const d of DIMS) {
      const beliefs = beliefsOf(dossier, d.key);
      const ev = dimEvidence(beliefs, corroboration[d.key], now);
      const conf = clamp01(confFromEvidence(ev));
      dims[d.key] = { conf, weight: d.weight, beliefs: beliefs.length, evidence: ev, blank: beliefs.length === 0 };
      wSum += d.weight;
      wConf += d.weight * conf;
      // value of information = how much resolving this dim would move understanding = weight × remaining gap.
      // DIMS order (weight-desc) breaks ties deterministically: the earlier, higher-weight dim wins.
      const gap = d.weight * (1 - conf);
      if (!weakest || gap > weakest.gap) weakest = { dim: d.key, conf, weight: d.weight, gap };
    }

    const overall = wSum > 0 ? clamp01(wConf / wSum) : 0;
    const blanks = DIM_KEYS.filter(k => dims[k].blank);
    return {
      dims,
      overall,
      clarity: overall,
      weakest,
      blanks,
      calibrating: overall < CALIBRATING,
      workSamples: Number.isFinite(opts.workSamples) ? Math.max(0, opts.workSamples | 0) : null
    };
  }

  /* ---------- READINESS — the one shared recommendation gate (ONBOARDING V3 §6) ----------
     The station may only RECOMMEND (pitch / suggest / scout-mint / quest-refresh / starter-chip) once it
     honestly knows enough about its Commander. This predicate is that single source of truth — every
     proactive surface asks it, none carries a private variant. Below it, surfaces are structurally OFF
     (hunt mode owns the gap); it never fabricates readiness a blitzed onboarding didn't earn.

     GROUNDED evidence = a belief whose weight is stated/synth/observed (dossier.js weightOf) — the
     Commander's words, a synthesis of them, or observed real work. 'seed' (doc-copied, incl. the fallback
     purpose picker's canned line) informs prompts but can never open this gate.

     ready = grounded(goals OR ambition)      — a real direction to aim recommendations at
           AND grounded(pain OR identity)     — a real person/pressure to aim them FOR
           AND familiarity ≥ READY_MIN_FAMILIARITY  — minimum breadth (any-belief dims / all dims)
     Thresholds are principled defaults, kept here (one place) and surfaced honestly in the reasons array —
     expect live-onboarding tuning (§9). */
  const READY_MIN_FAMILIARITY = 0.33;
  const READY_DIRECTION_DIMS = ['goals', 'ambition'];
  const READY_PERSON_DIMS = ['pain', 'identity'];

  // a belief's weight, honoring dossier.js's inference for legacy records (kept dependency-free: this engine
  // never requires dossier.js — the two stay independently loadable, so the rule is mirrored, tiny, and tested).
  function beliefWeightOf(b) {
    if (b && typeof b.weight === 'string' && ['stated', 'synth', 'observed', 'seed'].indexOf(b.weight) >= 0) return b.weight;
    if (b && (b.observedAt || b.source === 'study')) return 'observed';
    return 'stated';
  }
  function groundedCount(beliefs) {
    let n = 0;
    for (const b of (Array.isArray(beliefs) ? beliefs : [])) {
      if (!b || typeof b.text !== 'string' || !b.text) continue;
      if (beliefWeightOf(b) !== 'seed') n++;
    }
    return n;
  }

  // readiness(dossier) → { ready, reasons:[why-not], grounded:{dim:count}, familiarity } — honest telemetry:
  // an open gate has reasons:[], a shut one names every unmet requirement (the panel renders these verbatim).
  function readiness(dossier) {
    const grounded = {};
    let knownAny = 0;
    for (const k of DIM_KEYS) {
      const arr = beliefsOf(dossier, k);
      grounded[k] = groundedCount(arr);
      // Breadth is evidence breadth, not field occupancy. A canned/document seed may inform a prompt, but it
      // cannot be the third dimension that silently tips familiarity over the recommendation threshold.
      if (grounded[k] > 0) knownAny++;
    }
    const familiarity = DIM_KEYS.length ? knownAny / DIM_KEYS.length : 0;
    const reasons = [];
    if (!READY_DIRECTION_DIMS.some(k => grounded[k] > 0)) reasons.push('no-direction');
    if (!READY_PERSON_DIMS.some(k => grounded[k] > 0)) reasons.push('no-person');
    if (familiarity < READY_MIN_FAMILIARITY) reasons.push('too-thin');
    return { ready: reasons.length === 0, reasons, grounded, familiarity };
  }

  return {
    understanding, readiness,
    // exposed for tests + downstream tuning (never mutate)
    freshness, dimEvidence, confFromEvidence, groundedCount, beliefWeightOf,
    DIMS, DIM_KEYS, WEIGHT, HALF_LIFE_MS, SOURCE_WEIGHT, EVIDENCE_WEIGHT, DEPTH_SAT, CORROB_UNIT, CALIBRATING,
    READY_MIN_FAMILIARITY, READY_DIRECTION_DIMS, READY_PERSON_DIMS
  };
});
