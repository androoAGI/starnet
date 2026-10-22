/* AGENT OS — worksignal.js : the PURE capability-usage histogram (the "what work does the Commander actually do"
   substrate for adaptive recruitment).

   The recruiter's fuel. Where profile.js tracks the {code|research|general} INTEREST tag of every task, this
   tracks the CAPABILITY LANE of every real TOOL FIRE — the dish, the cabinet, the workbench, the notebook… — so
   the bay can see "most of your recent work leaned on the dish (web research)" and curate the class that covers it.
   It stores only DERIVED COUNTS per capability lane (never tool args, never prompt text), so it is safe to fold
   silently and it is local-first: this object lives in the user's save and never leaves the machine.

   Structure mirrors profile.js EXACTLY so the two engines share one mental model + one calibration convention:
     • per-lane EWMA-decayed weight + a sample count (14d half-life, like profile), so recency sharpens the read;
     • CALIBRATING_N samples before a lane read is "known" — below the floor the recommender stays silent;
     • the clock is ALWAYS injected (`now`) — no Date.now / Math.random here — so decay is deterministic and node
       tests can fast-forward time. The browser wiring (worksignalstore.js) supplies Date.now() at the edge.

   Additionally (what profile.js does NOT track): per-lane TASK VOLUME by profile tag (code/research/general), so
   the matcher can detect "high volume in a lane whose dominant tag has no rostered specialist". A tool fire folds
   BOTH the capability-lane weight AND — when the caller supplies the run's interest tag — a per-lane tag tally. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.WorkSignal = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- tunables (kept in lock-step with profile.js so the two engines calibrate identically) ----
  const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;  // a lane's weight halves every ~2 weeks of silence (recency)
  const CALIBRATING_N = 3;                         // completed-run observations before the histogram is "known"
  const TAGS = ['code', 'research', 'general'];    // the interest vocabulary (mirrors profile.js / classify.js)

  // the capability lanes tracked — the CAP_REGISTRY objectTypes that class KITS draw on (shared/specialties.js).
  // This is the vocabulary the matcher overlaps a class kit against, so it must mirror the kit objectTypes:
  //   dish · cabinet · notebook · workbench · studio · connector · computer · orchestrator · jukebox
  // The store maps a firing tool NAME to one of these via the same CAP_REGISTRY authority (ToolProps + the
  // kit-lane extension); this engine only ever sees an already-mapped lane string, so it never hand-rolls a map.
  const LANES = ['dish', 'cabinet', 'notebook', 'workbench', 'studio', 'connector', 'computer', 'orchestrator', 'jukebox'];

  function fresh() { return { v: 1, lanes: {}, total: 0 }; }
  function isLane(lane) { return LANES.indexOf(lane) >= 0; }
  function normTag(tag) { return TAGS.indexOf(tag) >= 0 ? tag : 'general'; }

  // a lane's stored weight, exponentially decayed by the silence since it was last touched.
  function decayedW(laneObj, now) {
    if (!laneObj || typeof laneObj.w !== 'number') return 0;
    const dt = Math.max(0, now - (laneObj.t || 0));
    return laneObj.w * Math.pow(0.5, dt / HALF_LIFE_MS);
  }

  // fold one real tool fire. sig = { lane, tag?, weight? }. `lane` MUST be a known capability lane (the store
  // maps the tool name to it); an unmapped/unknown lane is dropped (never coerced) so a tool with its own floor
  // story — shell/compute/connector edge cases the store chooses not to map — can't pollute the histogram. `tag`
  // is the run's interest tag (from classify.js) folded into this lane's per-tag task tally, when the caller has it.
  function observe(signal, sig, now) {
    if (!signal) return signal;
    const lane = sig && sig.lane;
    if (!isLane(lane)) return signal;   // reject anything not a known capability lane — never invent a lane
    const weight = (sig && Number.isFinite(sig.weight) && sig.weight > 0) ? sig.weight : 1;   // reject Infinity/NaN — a poison weight would skew the whole read
    const cur = signal.lanes[lane] || { w: 0, n: 0, t: 0, tags: {} };
    const nextW = decayedW(cur, now) + weight;
    const tags = Object.assign({}, cur.tags);
    if (sig && sig.tag != null) { const tg = normTag(sig.tag); tags[tg] = (tags[tg] || 0) + 1; }   // per-lane task volume by interest tag
    signal.lanes[lane] = { w: nextW, n: (cur.n || 0) + 1, t: now, tags };
    signal.total = (signal.total || 0) + 1;
    return signal;
  }

  // Fold one completed run, independent of how chatty its tool loop was. Each unique lane shares one unit of
  // outcome-weight, while signal.total advances exactly once.
  function observeRun(signal, run, now) {
    if (!signal) return signal;
    const src = run && Array.isArray(run.lanes) ? run.lanes : [];
    const lanes = [];
    for (const lane of src) if (isLane(lane) && lanes.indexOf(lane) < 0) lanes.push(lane);
    if (!lanes.length) return signal;
    const outcomeWeight = (run && Number.isFinite(run.weight) && run.weight > 0) ? run.weight : 1;
    const share = outcomeWeight / lanes.length;
    const tag = run && run.tag != null ? normTag(run.tag) : null;
    for (const lane of lanes) {
      const cur = signal.lanes[lane] || { w: 0, n: 0, t: 0, tags: {} };
      const tags = Object.assign({}, cur.tags);
      if (tag) tags[tag] = (tags[tag] || 0) + 1;
      signal.lanes[lane] = { w: decayedW(cur, now) + share, n: (cur.n || 0) + 1, t: now, tags };
    }
    signal.total = (signal.total || 0) + 1;
    return signal;
  }

  // the normalized capability vector {lane: 0..1}, decayed to `now`. The single source the matcher reads. An empty
  // histogram returns an all-zero vector (fabricates no usage), exactly like profile.vector on a cold profile.
  function vector(signal, now) {
    const dw = {}; let total = 0;
    for (const k of LANES) { const w = signal.lanes[k] ? decayedW(signal.lanes[k], now) : 0; dw[k] = w; total += w; }
    const out = {};
    for (const k of LANES) out[k] = total > 0 ? dw[k] / total : 0;
    return out;
  }

  // the decayed weight of one lane, normalized 0..1 — the matcher's kit-affinity term reads this per kit entry.
  function laneWeight(signal, lane, now) { return isLane(lane) ? (vector(signal, now)[lane] || 0) : 0; }

  // the dominant interest tag OBSERVED IN A LANE (which kind of work the Commander does there), or null when the
  // lane has no tag tally yet. Used to detect "high research volume in the dish, no research specialist rostered".
  function laneTag(signal, lane, now) {
    const lo = signal.lanes && signal.lanes[lane];
    if (!lo || !lo.tags) return null;
    let best = null, bv = 0;
    for (const k of TAGS) { const v = lo.tags[k] || 0; if (v > bv) { bv = v; best = k; } }
    return best;
  }

  // the human/matcher-facing read: the vector, the dominant lane, sample count, calibration state, per-lane tags.
  function summary(signal, now) {
    const v = vector(signal, now);
    const samples = signal.total || 0;
    let dominant = null, best = 0;
    for (const k of LANES) if (v[k] > best) { best = v[k]; dominant = k; }
    const laneTags = {};
    for (const k of LANES) { const t = laneTag(signal, k, now); if (t) laneTags[k] = t; }
    return {
      vector: v,
      dominant: samples > 0 && best > 0 ? dominant : null,   // no signal → no fabricated dominant lane
      samples,
      calibrating: samples < CALIBRATING_N,
      laneTags
    };
  }

  // defensively rebuild a valid signal from a (possibly malformed / old) persisted blob.
  function hydrate(raw) {
    if (!raw || typeof raw !== 'object') return fresh();
    const s = fresh();
    s.total = (typeof raw.total === 'number' && raw.total >= 0) ? raw.total : 0;
    if (raw.lanes && typeof raw.lanes === 'object') {
      for (const k of LANES) {
        const lo = raw.lanes[k];
        if (lo && Number.isFinite(lo.w) && lo.w >= 0) {
          const tags = {};
          if (lo.tags && typeof lo.tags === 'object') for (const tg of TAGS) { const n = lo.tags[tg]; if (Number.isFinite(n) && n >= 0) tags[tg] = n; }
          s.lanes[k] = { w: lo.w, n: Math.max(0, lo.n | 0), t: (Number.isFinite(lo.t) ? lo.t : 0), tags };
        }
      }
    }
    return s;
  }

  // wipe the learned histogram (shares the profile's FORGET button — one glass-box control clears both).
  function forget() { return fresh(); }

  return { fresh, observe, observeRun, vector, laneWeight, laneTag, summary, hydrate, forget, LANES, TAGS, CALIBRATING_N, HALF_LIFE_MS };
});
