/* sidecar/insights.js — usage insights folded from the durable run history (H3.3).

   The reference harness has an InsightsEngine (overview, per-model, activity-over-time, notable sessions) wired to
   its `insights` command; StarNet had no aggregate usage surface at all. This is the pure fold behind GET
   /api/insights: given the run-history rows (runstore — each carries reason, usd, tokens, model, agentId, ts),
   it computes an overview + per-model spend + outcome breakdown + per-agent + a runs/spend-over-time series.

   Pure: rows in, plain object out (no I/O, no clock — the caller passes nowMs + bucketMs). Tool-usage ranking is
   intentionally NOT here — a noted follow-on, not faked. (The original blocker — "tool calls aren't persisted" —
   no longer holds: runstore rows now carry toolTrace. The fold just hasn't been built yet; whoever builds it
   should read toolTrace off the same rows this fold already receives.)
   TYPED OUTCOMES (review 4.1): a row counts by its OUTCOME-aware reason (RunOutcome.reasonOf), never its bare reason — a reply the
   provider cut ends 'done' too, and was counted a success in "NN% success" (the LOGBOOK, COMMS /insights, the terminal dashboard)
   while every per-run surface said it did not finish. A cut row is 'cut_short' (decided, never a success), a 'done' end the run's own
   error outranked is 'error', a question it asked is 'clarifying' (no attempt), and a row with NO reason is 'error' — nothing proves
   it finished (it used to default to 'done').
   UMD: window.SK.insights in the browser, module.exports under node — unit-testable. */
'use strict';
(function (root, factory) {
  const api = factory((typeof require === 'function') ? require('../frontend/app/runoutcome.js') : (root.RunOutcome || null));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).insights = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (RunOutcome) {
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

    let totalUsd = 0, totalTokens = 0, meteredRuns = 0, unmeteredRuns = 0, unmeteredTokens = 0, spendUnknownRuns = 0, unpricedRuns = 0, usageMissingRuns = 0;
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
      // UNPRICED: tokens no provider cost or catalog rate priced. Its usd is a floor (often 0), never a proven $0 —
      // counted and labelled, and a $0 one is not a metered run (it would drag avgUsdPerRun toward a fake zero).
      const unpriced = !spendUnknown && !unmetered && !!(r && r.unpriced === true);
      const metered = !spendUnknown && !unmetered && !(unpriced && usd === 0);
      // USAGE MISSING (80de2a75): a Stop cut a call off mid-stream before its usage arrived. What WAS booked is known and
      // counts in every total, as a floor — the run is neither unknown (that would drop real dollars) nor unpriced.
      const usageMissing = !spendUnknown && !unmetered && !!(r && r.usageMissing === true);
      if (unpriced) unpricedRuns++;
      if (usageMissing) usageMissingRuns++;
      totalUsd += meteredUsd; totalTokens += tok;
      if (spendUnknown) spendUnknownRuns++;
      else if (unmetered) { unmeteredRuns++; unmeteredTokens += tok; } else if (metered) { meteredRuns++; }
      const reason = RunOutcome ? RunOutcome.reasonOf(r) : (str(r.reason) || 'error');   // 'done' only for a SUCCEEDED run (see the header)
      byReason[reason] = (byReason[reason] || 0) + 1;
      const m = str(r.model) || '(unknown)';
      const mm = modelMap.get(m) || { model: m, usd: 0, tokens: 0, runs: 0, meteredRuns: 0, unmeteredRuns: 0, unmeteredTokens: 0, spendUnknownRuns: 0, unpricedRuns: 0, usageMissingRuns: 0 };
      mm.usd += meteredUsd; mm.tokens += tok; mm.runs++;
      if (unpriced) mm.unpricedRuns++;
      if (usageMissing) mm.usageMissingRuns++;
      if (spendUnknown) mm.spendUnknownRuns++;
      else if (unmetered) { mm.unmeteredRuns++; mm.unmeteredTokens += tok; } else if (metered) { mm.meteredRuns++; }
      modelMap.set(m, mm);
      const a = str(r.agentId) || '(unknown)';
      const am = agentMap.get(a) || { agentId: a, usd: 0, tokens: 0, runs: 0, meteredRuns: 0, unmeteredRuns: 0, unmeteredTokens: 0, spendUnknownRuns: 0 };
      am.usd += meteredUsd; am.tokens += tok; am.runs++;
      if (spendUnknown) am.spendUnknownRuns++;
      else if (unmetered) { am.unmeteredRuns++; am.unmeteredTokens += tok; } else if (metered) { am.meteredRuns++; }
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

    // decided: a run that finished or failed at its task — a cut reply is decided too (it did not finish); a question it asked is not, and
    // neither is a run SOMEONE STOPPED (review r7: every Stop lowered "% success" as if it were a failure; the track record and XP skip it)
    const decided = num(byReason.done) + num(byReason.error) + num(byReason.budget) + num(byReason.max_iters) + num(byReason.refusal) + num(byReason.cut_short);
    const products = num(byReason.done);   // byReason.done is outcome-aware: only SUCCEEDED runs
    const byUsdDesc = (a, b) => b.usd - a.usd || b.runs - a.runs;
    return {
      totalRuns: rows.length,
      meteredRuns: meteredRuns,
      unmeteredRuns: unmeteredRuns,
      spendUnknownRuns: spendUnknownRuns,   // interrupted runs whose spend was never settled — excluded from every $ figure
      unpricedRuns: unpricedRuns,           // runs with tokens no published rate priced — their $ is a floor, not a fact
      usageMissingRuns: usageMissingRuns,   // runs stopped mid-answer before a call's usage arrived — counted, their $ is a floor
      totalUsd: round(totalUsd),
      totalTokens: totalTokens,
      unmeteredTokens: unmeteredTokens,
      avgUsdPerRun: meteredRuns ? round(totalUsd / meteredRuns) : 0,
      successPct: decided ? Math.round((products / decided) * 100) : null,   // null = no decided runs yet (honest unknown)
      byReason: byReason,
      byModel: Array.from(modelMap.values()).map(m => ({
        model: m.model, usd: round(m.usd), tokens: m.tokens, runs: m.runs,
        meteredRuns: m.meteredRuns, unmeteredRuns: m.unmeteredRuns, unmeteredTokens: m.unmeteredTokens, spendUnknownRuns: m.spendUnknownRuns,
        unpricedRuns: m.unpricedRuns, usageMissingRuns: m.usageMissingRuns,
        unmetered: m.unmeteredRuns > 0 && m.meteredRuns === 0,
        spendLabel: (m.unmeteredRuns > 0 && m.meteredRuns === 0) ? 'subscription / unmetered'
          : m.unpricedRuns > 0 ? (m.usd > 0 ? 'partly unpriced (no published price for some tokens)' : 'no published price')
          : m.usageMissingRuns > 0 ? 'at least — ' + m.usageMissingRuns + ' stopped mid-answer before usage arrived' : ''
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
