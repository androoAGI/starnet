/* sidecar/insights.js — usage insights folded from the durable run history (H3.3).

   The reference harness has an InsightsEngine (overview, per-model, activity-over-time, notable sessions) wired to
   its `insights` command; Agent OS had no aggregate usage surface at all. This is the pure fold behind GET
   /api/insights: given the run-history rows (runstore — each carries reason, usd, tokens, model, agentId, ts),
   it computes an overview + per-model spend + outcome breakdown + per-agent + a runs/spend-over-time series.

   Pure: rows in, plain object out (no I/O, no clock — the caller passes nowMs + bucketMs). Tool-usage ranking is
   intentionally NOT here — a noted follow-on, not faked. (The original blocker — "tool calls aren't persisted" —
   no longer holds: runstore rows now carry toolTrace. The fold just hasn't been built yet; whoever builds it
   should read toolTrace off the same rows this fold already receives.)
   UMD: window.SK.insights in the browser, module.exports under node — unit-testable. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).insights = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HOUR = 3600000;
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function str(v) { return v == null ? '' : String(v); }
  function round(n) { return Math.round(n * 1e6) / 1e6; }

  // rows: runstore entries [{reason, usd, tokens, model, agentId, ts}]. opts: { nowMs, bucketMs?, buckets? }.
  function foldInsights(rows, opts) {
    rows = Array.isArray(rows) ? rows : [];
    opts = opts || {};
    const nowMs = num(opts.nowMs);
    const bucketMs = num(opts.bucketMs) > 0 ? num(opts.bucketMs) : HOUR;
    const nBuckets = num(opts.buckets) > 0 ? num(opts.buckets) : 24;

    let totalUsd = 0, totalTokens = 0, meteredRuns = 0, unmeteredRuns = 0, unmeteredTokens = 0, spendUnknownRuns = 0;
    const byReason = {};
    const modelMap = new Map();   // model -> { model, usd, tokens, runs }
    const agentMap = new Map();   // agentId -> { agentId, usd, tokens, runs }

    for (const r of rows) {
      /* SPEND UNKNOWN (interrupted runs, 2026-09-22). A run the process died inside is listed in history, but its spend
         was never settled (the spend ledger holds an unsettled receipt and refuses to guess $0). Its row carries
         usd 0 + spendUnknown:true — so it must NOT be summed or counted as a metered run, or the panel would
         present a real, unpriced run as free. It still counts as a run and by reason; spendUnknownRuns names it. */
      const spendUnknown = !!(r && r.spendUnknown === true);
      const usd = spendUnknown ? 0 : num(r.usd), tok = spendUnknown ? 0 : num(r.tokens);
      const unmetered = !!(r && r.unmetered);
      const meteredUsd = unmetered ? 0 : usd;
      totalUsd += meteredUsd; totalTokens += tok;
      if (spendUnknown) spendUnknownRuns++;
      else if (unmetered) { unmeteredRuns++; unmeteredTokens += tok; } else { meteredRuns++; }
      const reason = str(r.reason) || 'done';
      byReason[reason] = (byReason[reason] || 0) + 1;
      const m = str(r.model) || '(unknown)';
      const mm = modelMap.get(m) || { model: m, usd: 0, tokens: 0, runs: 0, meteredRuns: 0, unmeteredRuns: 0, unmeteredTokens: 0, spendUnknownRuns: 0 };
      mm.usd += meteredUsd; mm.tokens += tok; mm.runs++;
      if (spendUnknown) mm.spendUnknownRuns++;
      else if (unmetered) { mm.unmeteredRuns++; mm.unmeteredTokens += tok; } else { mm.meteredRuns++; }
      modelMap.set(m, mm);
      const a = str(r.agentId) || '(unknown)';
      const am = agentMap.get(a) || { agentId: a, usd: 0, tokens: 0, runs: 0, meteredRuns: 0, unmeteredRuns: 0, unmeteredTokens: 0, spendUnknownRuns: 0 };
      am.usd += meteredUsd; am.tokens += tok; am.runs++;
      if (spendUnknown) am.spendUnknownRuns++;
      else if (unmetered) { am.unmeteredRuns++; am.unmeteredTokens += tok; } else { am.meteredRuns++; }
      agentMap.set(a, am);
    }

    // runs/spend-over-time: most-recent `nBuckets` windows of width bucketMs, oldest-first, anchored at nowMs.
    const overTime = [];
    if (nowMs > 0) {
      const start = nowMs - (nBuckets - 1) * bucketMs;
      const idx = (t) => Math.floor((t - start) / bucketMs);
      const slot = [];
      for (let i = 0; i < nBuckets; i++) slot.push({ t: start + i * bucketMs, runs: 0, usd: 0, unmeteredRuns: 0 });
      for (const r of rows) {
        const i = idx(num(r.ts));
        if (i >= 0 && i < nBuckets) {
          const unmetered = !!(r && r.unmetered);
          slot[i].runs++;
          if (r && r.spendUnknown === true) { /* counted as a run; its spend is unknown, never $0 */ }
          else if (unmetered) slot[i].unmeteredRuns++; else slot[i].usd += num(r.usd);
        }
      }
      for (const s of slot) overTime.push({ bucketStart: s.t, runs: s.runs, usd: round(s.usd), unmeteredRuns: s.unmeteredRuns });
    }

    const decided = num(byReason.done) + num(byReason.error) + num(byReason.budget) + num(byReason.max_iters) + num(byReason.refusal) + num(byReason.cancelled);
    const products = num(byReason.done);
    const byUsdDesc = (a, b) => b.usd - a.usd || b.runs - a.runs;
    return {
      totalRuns: rows.length,
      meteredRuns: meteredRuns,
      unmeteredRuns: unmeteredRuns,
      spendUnknownRuns: spendUnknownRuns,   // interrupted runs whose spend was never settled — excluded from every $ figure
      totalUsd: round(totalUsd),
      totalTokens: totalTokens,
      unmeteredTokens: unmeteredTokens,
      avgUsdPerRun: meteredRuns ? round(totalUsd / meteredRuns) : 0,
      successPct: decided ? Math.round((products / decided) * 100) : null,   // null = no decided runs yet (honest unknown)
      byReason: byReason,
      byModel: Array.from(modelMap.values()).map(m => ({
        model: m.model, usd: round(m.usd), tokens: m.tokens, runs: m.runs,
        meteredRuns: m.meteredRuns, unmeteredRuns: m.unmeteredRuns, unmeteredTokens: m.unmeteredTokens, spendUnknownRuns: m.spendUnknownRuns,
        unmetered: m.unmeteredRuns > 0 && m.meteredRuns === 0,
        spendLabel: (m.unmeteredRuns > 0 && m.meteredRuns === 0) ? 'subscription / unmetered' : ''
      })).sort(byUsdDesc),
      byAgent: Array.from(agentMap.values()).map(a => ({
        agentId: a.agentId, usd: round(a.usd), tokens: a.tokens, runs: a.runs,
        meteredRuns: a.meteredRuns, unmeteredRuns: a.unmeteredRuns, unmeteredTokens: a.unmeteredTokens, spendUnknownRuns: a.spendUnknownRuns
      })).sort(byUsdDesc),
      overTime: overTime
    };
  }

  return { foldInsights };
});
