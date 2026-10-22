/* AGENT OS — floorstats.js : the FACTORY-FLOOR economy readout (pure, testable).

   Folds the harness's already-frozen usage/outcome events into ONE render-agnostic
   snapshot the live floor HUD reads at a glance — so the running station is legible
   the way a Factorio belt is: you look, and you know. Four numbers:
     - RUNS  : real task outcomes observed this session.
     - YIELD : the productive-run rate — products / decisive runs. The "are my agents
               actually finishing useful work, or thrashing?" number.
     - SLAG  : runs that ended without a deliverable (max_iters / budget / error / refusal).
     - CACHE : cachedTokens / promptTokens — the prompt-cache "smelter" signal. A stable
               system-prompt + memory fence runs the cache hot (~10× cheaper input);
               thrash it and this craters. An invisible win, made visible.
     - THRU  : work-items delivered per minute (a 60s window over real delivery events).
     - DWELL : average time a work-item spent riding the line (placed -> delivered), paired
               by workitemId — the latency of the whole INTAKE->bay->OUTBOX round trip.
     - QUEUE : the live backlog (sum of queue.status depths) — rendered as a physical JAM of
               waiting crates at the bay, so a bottleneck's LENGTH is the real pending work.

   Truthful by construction (the workstreams.js telemetry rule): every number is a fold
   of REAL events — agent.cost (reconciled usage + cachedTokens), agent.run.end (the
   decisive reason), workitem.delivered (a real outbound delivery). Nothing is estimated
   or invented; a metric with no samples yet reports known:false so the HUD shows "—"
   instead of a fabricated figure (the same honesty rule ctxgauge.js applies to context).

   Pure + dependency-free (no DOM / time / rng): a `FloorStats` global in the browser,
   module.exports under node — unit-testable headless like ctxgauge.js / classify.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.FloorStats = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // agent.run.end.reason buckets. 'done' banks a PRODUCT; these four ended without a deliverable → SLAG.
  // 'cancelled' is a human stop (not waste) and counts as NEITHER — it never inflates the slag tally.
  const SLAG_REASONS = { max_iters: 1, budget: 1, error: 1, refusal: 1 };

  function num(n) { n = Number(n); return isFinite(n) ? n : 0; }

  const WINDOW = 60000;   // 60s throughput window — a count inside it IS an items/MINUTE rate

  function create() {
    let s = blank();
    let placedAt = new Map();   // workitemId -> placement clock (ms) — paired on delivery to get dwell (time on the line)
    let queues = new Map();     // queueId -> current depth (from queue.status) — the live per-agent backlog
    let inRing = [];            // placement timestamps (inbound items/min)
    let outRing = [];           // delivery timestamps (outbound items/min)
    let lastTms = 0;            // newest event clock seen — the default window anchor when snapshot() gets no nowMs
    function blank() {
      return {
        spendUsd: 0, tokensIn: 0, tokensOut: 0, cachedTokens: 0,
        products: 0, slag: 0, slagUsd: 0, delivered: 0, dwellSum: 0, dwellN: 0,
        failovers: 0, lastFailover: null   // H3.1: provider.fallback — model/credential switches mid-run (was invisible)
      };
    }
    function reset() { s = blank(); placedAt = new Map(); queues = new Map(); inRing = []; outRing = []; lastTms = 0; }

    // a reliable event clock: the caller's injected nowMs (wall-clock, e.g. Date.now()) wins; else the
    // event's own ts; else 0 (untimed — folded into totals but not into the time-windowed rate/dwell).
    function tms(p, nowMs) {
      const n = Number(nowMs); if (isFinite(n) && n > 0) return n;
      const t = p && Number(p.ts); return isFinite(t) && t > 0 ? t : 0;
    }
    // drop entries older than the window so memory stays bounded (hard cap as a backstop).
    function prune(ring, now) {
      let i = 0; while (i < ring.length && now - ring[i] > WINDOW) i++;
      if (i > 0) ring.splice(0, i);
      if (ring.length > 512) ring.splice(0, ring.length - 512);
    }
    function countWithin(ring, now) { let c = 0; for (let i = 0; i < ring.length; i++) if (now - ring[i] <= WINDOW) c++; return c; }

    // Fold ONE bus event into the running totals. nowMs (optional) is a reliable wall-clock for the
    // time-windowed metrics. Unknown names are ignored, so the caller can point the whole firehose at
    // it without filtering. Defensive coercion → never a NaN.
    function onEvent(name, p, nowMs) {
      p = p || {};
      const t = tms(p, nowMs); if (t > lastTms) lastTms = t;
      if (name === 'agent.cost') {
        s.spendUsd += num(p.usd);
        s.tokensIn += num(p.tokensIn);
        s.tokensOut += num(p.tokensOut);
        s.cachedTokens += num(p.cachedTokens);
      } else if (name === 'agent.run.end') {
        if (p.reason === 'done') s.products++;
        else if (SLAG_REASONS[p.reason]) { s.slag++; s.slagUsd += num(p.usd); }
      } else if (name === 'workitem.placed') {
        if (p.workitemId && t) placedAt.set(p.workitemId, t);
        if (t) { inRing.push(t); prune(inRing, t); }
      } else if (name === 'workitem.delivered') {
        if (p.box === 'line-output') return;   // routing authority; the ordinary delivery already owns throughput
        // A routing-line PROOF dispatch (POST /api/routing/sample) marks itself sample:true precisely so
        // consumers can tell a test from customer work — folding it into delivered/items-min told the
        // Commander their five test presses were five real deliveries. The crate still rides the belt
        // (workitem.placed is unmarked visual truth); only the throughput telemetry skips it.
        if (p.sample) { if (p.workitemId) placedAt.delete(p.workitemId); return; }
        s.delivered++;
        if (t) { outRing.push(t); prune(outRing, t); }
        // DWELL: time this work-item spent riding the line, paired by workitemId to its placement.
        if (p.workitemId && placedAt.has(p.workitemId)) {
          const d = t - placedAt.get(p.workitemId);
          if (d >= 0) { s.dwellSum += d; s.dwellN++; }
          placedAt.delete(p.workitemId);
        }
      } else if (name === 'queue.status') {
        // the live per-agent backlog — the source for the physical "jam" of waiting crates at the bay
        if (p.queueId != null) queues.set(p.queueId, Math.max(0, p.depth | 0));
      } else if (name === 'provider.fallback') {
        // H3.1: the loop switched model/credential mid-run (rate-limit/auth/billing). Count it + remember the
        // last one so the operator can SEE failovers (the truthful-telemetry promise) instead of it being silent.
        s.failovers++;
        s.lastFailover = { fromModel: String(p.fromModel || ''), toModel: String(p.toModel || ''), reason: String(p.reason || ''), rotate: !!p.rotate };
      }
    }

    // Render-agnostic snapshot. Honest unknowns: yield/cache/dwell report known:false until they have a
    // real sample, so the HUD shows "—" not a made-up number. nowMs (optional) is the window anchor for
    // throughput — pass a live wall-clock so the rate decays toward 0 when deliveries stop.
    function snapshot(nowMs) {
      const now = (isFinite(Number(nowMs)) && Number(nowMs) > 0) ? Number(nowMs) : lastTms;
      const decided = s.products + s.slag;
      const yieldKnown = decided > 0;
      const cacheKnown = s.tokensIn > 0;
      const dwellKnown = s.dwellN > 0;
      const yieldFrac = yieldKnown ? s.products / decided : 0;
      const cacheFrac = cacheKnown ? s.cachedTokens / s.tokensIn : 0;
      const avgDwellMs = dwellKnown ? s.dwellSum / s.dwellN : 0;
      let queueDepth = 0; for (const d of queues.values()) queueDepth += d;
      return {
        spendUsd: s.spendUsd, slagUsd: s.slagUsd, queueDepth,
        runs: decided, products: s.products, slag: s.slag, delivered: s.delivered,
        tokensIn: s.tokensIn, tokensOut: s.tokensOut, cachedTokens: s.cachedTokens,
        yieldKnown, yieldFrac, yieldPct: Math.round(yieldFrac * 100),
        cacheKnown, cacheFrac, cachePct: Math.round(cacheFrac * 100),
        thruInPerMin: countWithin(inRing, now), thruOutPerMin: countWithin(outRing, now),
        dwellKnown, avgDwellMs, avgDwellSec: avgDwellMs / 1000,
        failovers: s.failovers, lastFailover: s.lastFailover,
        clean: s.slag === 0
      };
    }

    return { onEvent, snapshot, reset };
  }

  // a run's REAL reconciled dollar cost -> a 0..1 visual MASS + a coarse band, for sizing the banked
  // PRODUCT crate (expensive runs bank visibly heavier crates). Log-scaled across the typical
  // ~$0.001..$0.50 run range so a cheap haiku ping stays a pebble and a reasoning-heavy opus run reads
  // as a boulder. Pure + clamped (garbage -> the light floor, never NaN).
  const COST_LO = 0.001, COST_HI = 0.5;
  function costWeight(usd) {
    usd = Number(usd);
    if (!isFinite(usd) || usd <= 0) return { weight: 0.12, band: 'light' };
    let w = (Math.log10(usd) - Math.log10(COST_LO)) / (Math.log10(COST_HI) - Math.log10(COST_LO));
    if (w < 0.12) w = 0.12; if (w > 1) w = 1;
    const band = usd < 0.02 ? 'light' : usd < 0.2 ? 'mid' : 'heavy';
    return { weight: w, band };
  }

  return { create, costWeight };
});
