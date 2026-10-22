/* AGENT OS — understandingstore.js : the live wiring around the pure understanding engine (understanding.js).

   The browser half of the "how well the station understands its Commander" read-model, modelled on
   goalstore.js / dossierstore.js: a READ-ONLY citizen of the event spine (subscribes to agent.run.end,
   NEVER emits — the frozen shared/events.js contract is owned elsewhere). It holds NO state of its own —
   it composes the pure Understanding.understanding() read from state that already persists:
     • the Commander dossier beliefs (DossierStore.beliefs per dimension) — the confidence substrate,
     • the work-observation count (ProfileStore.summary().samples) — the honest "learned from N runs",
     • the active goal + real milestone progress (GoalStore.activeGoal → Goals.progress) — what the star
       points AT (the PROGRESS axis, distinct from understanding's CLARITY axis).
   After a clean hero run it recomputes and flags whether understanding ROSE (so the ambient surface can
   pulse — the "you just got clearer" moment), then notifies subscribers. Date.now() lives here (the
   injection edge); the engine stays clock-pure. node-exportable for its test. */
'use strict';
const UnderstandingStore = (() => {
  const KEY = 'starnet.understanding.v1';
  const CORROB_CLAMP = 6;   // signed per-dim corroboration is bounded (±): a run of 👍 can warm a dim, a run of
                            // 👎 can drain it, but neither can pin the model forever — beliefs stay the substrate.
  let bound = false;
  let last = null;          // the last composed read (the surface reads this)
  let prevOverall = 0;      // baseline to detect a post-run RISE
  let deps = {};
  let corrob = {};          // R2: SIGNED per-dim corroboration from real usage (ratings now, probes next) —
                            // the ONLY state this store owns; persisted so a 👎's honest doubt survives reload.
  const listeners = [];     // surfaces subscribe here; notified on every refresh

  const now = () => { try { if (typeof deps.now === 'function') return deps.now(); } catch (_) {} return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; };
  const hasEngine = () => typeof Understanding !== 'undefined' && Understanding && typeof Understanding.understanding === 'function';

  // build the dossier-shaped input the pure engine expects ({ dims: { key: [belief] } }) from the live store.
  function dossierShape() {
    const dims = {};
    const keys = hasEngine() ? Understanding.DIM_KEYS : [];
    for (const k of keys) {
      let arr = [];
      try { if (typeof DossierStore !== 'undefined' && DossierStore.beliefs) arr = DossierStore.beliefs(k) || []; } catch (_) {}
      dims[k] = arr;
    }
    return { dims };
  }

  // the honest work-observation count (learned-from-N-runs), or null when the profile is absent/cold.
  function workSamples() {
    try {
      if (typeof ProfileStore !== 'undefined' && ProfileStore.summary) {
        const s = ProfileStore.summary();
        if (s && Number.isFinite(s.samples)) return s.samples;
      }
    } catch (_) {}
    return null;
  }

  // the active goal the star points at + its REAL milestone progress (null when no goal is set — the star
  // then reads "no heading set yet", never a fabricated target).
  function goalRead() {
    try {
      if (typeof GoalStore !== 'undefined' && GoalStore.activeGoal && typeof Goals !== 'undefined' && Goals.progress) {
        const g = GoalStore.activeGoal();
        if (g) {
          const pr = Goals.progress(g);
          const nx = (typeof Goals.nextMilestone === 'function') ? Goals.nextMilestone(g) : null;
          return { text: g.text, done: pr.done, total: pr.total, pct: pr.pct, next: nx ? nx.text : null };
        }
      }
    } catch (_) {}
    return null;
  }

  /* ---------- R2: signed corroboration from real usage (persisted; the store's only owned state) ---------- */
  function loadCorrob() {
    try { const raw = localStorage.getItem(KEY); if (raw) { const s = JSON.parse(raw); if (s && s.corrob && typeof s.corrob === 'object') return hydrateCorrob(s.corrob); } } catch (_) {}
    return {};
  }
  function saveCorrob() { try { localStorage.setItem(KEY, JSON.stringify({ v: 1, corrob })); } catch (_) {} }
  function hydrateCorrob(raw) {
    const out = {};
    const keys = hasEngine() ? Understanding.DIM_KEYS : Object.keys(raw);
    for (const k of keys) {
      const n = Number(raw[k]);
      if (Number.isFinite(n) && n !== 0) out[k] = Math.max(-CORROB_CLAMP, Math.min(CORROB_CLAMP, n));
    }
    return out;
  }
  // fold one piece of signed evidence into a dimension (+ corroborates, − is counter-evidence), clamped,
  // persisted, and folded into the next read. The shared mechanism behind ratings (R2) and probes (R3).
  function noteEvidence(dim, delta) {
    if (!hasEngine() || Understanding.DIM_KEYS.indexOf(dim) < 0 || !Number.isFinite(delta) || !delta) return null;
    corrob[dim] = Math.max(-CORROB_CLAMP, Math.min(CORROB_CLAMP, (Number(corrob[dim]) || 0) + delta));
    if (!corrob[dim]) delete corrob[dim];
    saveCorrob();
    refresh(true);
    return corrob[dim] || 0;
  }
  // R2: a rate-the-work verdict is honest signal about the STYLE model ("how they want work done").
  // 👍 corroborates it; 👎 is counter-evidence (confidence sags → the VOI question re-aims at style);
  // 👌 is a shrug, not evidence. Called DIRECTLY from chat.rateWork (the established sibling-store idiom —
  // the verdict never rides the frozen event contract).
  function noteRating(verdict) {
    if (verdict === 'great') return noteEvidence('style', +1);
    if (verdict === 'miss') return noteEvidence('style', -1);
    return null;
  }
  // R3: a suggestion aimed at a specific dimension is a silent belief probe — accepting corroborates the
  // dimension it was aimed at; declining is counter-evidence. Zero new asks; drift detection as a byproduct.
  function noteProbe(dim, accepted) { return noteEvidence(dim, accepted ? +1 : -1); }
  // R3: the probe target — among the north-star-critical dims that HOLD beliefs but whose confidence has
  // SAGGED (staleness decay or 👎 counter-evidence), the lowest-confidence one, with its leading belief text
  // for the directive to aim at. null when all are well-grounded (a normal suggestion — most sessions) or
  // none hold beliefs (nothing to probe; blank dims belong to curiosity). 0.45 sits just under a single
  // fresh authored belief (≈0.51), so a probe only fires once real doubt exists — never as a tic.
  function probeTarget() {
    const u = read();
    if (!u || !u.dims) return null;
    let best = null;
    for (const k of ['goals', 'ambition', 'pain']) {
      const d = u.dims[k];
      if (!d || d.blank || d.conf >= 0.45) continue;
      if (!best || d.conf < best.conf) best = { dim: k, conf: d.conf };
    }
    if (!best) return null;
    let text = '', belief = null;
    try { const arr = (typeof DossierStore !== 'undefined' && DossierStore.beliefs) ? (DossierStore.beliefs(best.dim) || []) : []; if (arr[0] && arr[0].text) { text = String(arr[0].text); belief = arr[0]; } } catch (_) {}
    // `belief` is the WHOLE record (rec perfection W2), additively: a caller aiming an unspoken pitch at this
    // belief must be able to ask whether it is STALE, and staleness is read from the record's own timestamps —
    // which a {dim, text} pair cannot carry. Existing callers see the same two fields they always did.
    return text ? { dim: best.dim, text, belief } : null;
  }

  // V3 §6: the live recommendation-gate read — the shared Understanding.readiness predicate over the live
  // dossier. null when the engine is absent (callers treat null as NOT ready: a station that can't prove
  // readiness doesn't recommend — fail-closed, matching truthful telemetry).
  function readiness() {
    if (!hasEngine() || typeof Understanding.readiness !== 'function') return null;
    try { return Understanding.readiness(dossierShape()); } catch (_) { return null; }
  }

  // compose the full read (understanding + the goal it points at). null only if the engine isn't loaded.
  function compute() {
    if (!hasEngine()) return null;
    let u;
    try { u = Understanding.understanding(dossierShape(), { now: now(), workSamples: workSamples(), corroboration: corrob }); }
    catch (_) { return null; }
    u.goal = goalRead();
    return u;
  }

  // recompute, remember, and (when markRise) flag whether understanding climbed since the last run-driven
  // read — the ambient surface uses `rose` to pulse. Always notifies subscribers.
  function refresh(markRise) {
    const u = compute();
    if (!u) return last;
    u.rose = markRise ? (u.overall > prevOverall + 1e-6) : false;
    prevOverall = u.overall;
    last = u;
    for (const fn of listeners) { try { fn(u); } catch (_) {} }
    return u;
  }

  function read() { return last || refresh(false); }

  // subscribe to reads (returns the current read immediately so a late subscriber isn't blank).
  function subscribe(fn) {
    if (typeof fn === 'function') { listeners.push(fn); try { fn(read()); } catch (_) {} }
    return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }

  function onRunEnd(p) {
    if (!p || p.reason !== 'done') return;               // only a clean run can have sharpened understanding
    if ((p.agentId || 'agent') !== 'agent') return;      // hero runs only (a summoned worker never moves the model)
    refresh(true);
  }
  function bind() {
    if (bound) return;
    if (typeof U !== 'undefined' && U.bus && U.bus.on) { U.bus.on('agent.run.end', onRunEnd); bound = true; }
  }

  function init(opts) {
    deps = opts || {};
    prevOverall = 0;
    corrob = (typeof localStorage !== 'undefined') ? loadCorrob() : {};
    refresh(false);   // baseline on enter/resume — never pulses on a resumed save
    bind();
  }
  // a brand-new hero starts with no learned corroboration (own key; mirrors the sibling growth stores).
  function reset() { corrob = {}; try { localStorage.removeItem(KEY); } catch (_) {} prevOverall = 0; refresh(false); }

  return { init, reset, read, refresh, subscribe, readiness, noteRating, noteProbe, noteEvidence, probeTarget, _onRunEnd: onRunEnd, _compute: compute };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { UnderstandingStore };
