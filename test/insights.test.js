/* node test/insights.test.js — usage insights folded from run history (H3.3).
   Proves foldInsights computes the overview (spend/runs/tokens/avg), an honest successPct (null when nothing is
   decided), per-model spend ranked, outcome breakdown, per-agent, and a runs/spend-over-time series anchored at
   nowMs. Pure (rows in, object out). */
'use strict';
const A = require('./_assert.js');
const { foldInsights } = require('../sidecar/insights.js');

const H = 3600000;
const rows = [
  { reason: 'done', usd: 0.02, tokens: 1000, model: 'gpt-5.5', agentId: 'a', ts: 1000 },
  { reason: 'done', usd: 0.03, tokens: 500, model: 'gpt-5.5', agentId: 'a', ts: 1000 + H },
  { reason: 'error', usd: 0.01, tokens: 200, model: 'claude-opus-4.8', agentId: 'b', ts: 1000 + 2 * H },
];
const r = foldInsights(rows, { nowMs: 1000 + 2 * H, bucketMs: H, buckets: 3 });

// ---- overview ----
A.eq(r.totalRuns, 3, 'total runs');
A.eq(r.meteredRuns, 3, 'all fixture runs are metered');
A.eq(r.unmeteredRuns, 0, 'no unmetered runs in base fixture');
A.ok(Math.abs(r.totalUsd - 0.06) < 1e-9, 'total spend sums');
A.eq(r.totalTokens, 1700, 'total tokens sum');
A.ok(Math.abs(r.avgUsdPerRun - 0.02) < 1e-9, 'avg $/run');
A.eq(r.successPct, 67, 'successPct = 2 done / 3 decided -> 67%');

// ---- outcome breakdown ----
A.eq(r.byReason.done, 2, 'done count'); A.eq(r.byReason.error, 1, 'error count');

// ---- per-model spend, ranked by $ ----
A.eq(r.byModel[0].model, 'gpt-5.5', 'top model by spend');
A.ok(Math.abs(r.byModel[0].usd - 0.05) < 1e-9, 'top model spend = 0.02+0.03');
A.eq(r.byModel[0].runs, 2, 'top model run count');
A.eq(r.byModel[1].model, 'claude-opus-4.8', 'second model');

// ---- per-agent ----
A.eq(r.byAgent[0].agentId, 'a', 'top agent by spend');

// ---- runs/spend over time ----
A.eq(r.overTime.length, 3, '3 time buckets');
A.eq(r.overTime.reduce((s, b) => s + b.runs, 0), 3, 'every run lands in a bucket');
A.ok(Math.abs(r.overTime.reduce((s, b) => s + b.usd, 0) - 0.06) < 1e-9, 'bucketed spend sums to total');

// ---- empty: honest, no fabrication ----
const e = foldInsights([], { nowMs: 1000 });
A.eq(e.totalRuns, 0, 'empty: 0 runs');
A.eq(e.successPct, null, 'empty: successPct null (honest unknown, not 0%)');
A.eq(e.byModel.length, 0, 'empty: no models');

// ---- a row with no model folds under (unknown) (never crashes) ----
const u = foldInsights([{ reason: 'done', usd: 0.01, ts: 1000 }], { nowMs: 1000 });
A.eq(u.byModel[0].model, '(unknown)', 'a model-less run folds under (unknown)');

// ---- G6: unmetered/subscription runs count for activity/tokens but are excluded from USD aggregates ----
{
  const mixed = [
    { reason: 'done', usd: 0.04, tokens: 100, model: 'metered-a', agentId: 'a', ts: 1000 },
    { reason: 'done', usd: 123.45, tokens: 900, model: 'gpt-5.3-codex', agentId: 'a', ts: 1000 + H, unmetered: true },
    { reason: 'error', usd: 0.02, tokens: 200, model: 'metered-b', agentId: 'b', ts: 1000 + 2 * H }
  ];
  const x = foldInsights(mixed, { nowMs: 1000 + 2 * H, bucketMs: H, buckets: 3 });
  A.eq(x.totalRuns, 3, 'mixed: unmetered run still counts');
  A.eq(x.meteredRuns, 2, 'mixed: metered run count');
  A.eq(x.unmeteredRuns, 1, 'mixed: unmetered run count');
  A.ok(Math.abs(x.totalUsd - 0.06) < 1e-9, 'mixed: totalUsd excludes unmetered reported dollars');
  A.eq(x.totalTokens, 1200, 'mixed: token totals include unmetered usage');
  A.ok(Math.abs(x.avgUsdPerRun - 0.03) < 1e-9, 'mixed: avg USD divides by metered run count only');
  const codex = x.byModel.find(m => m.model === 'gpt-5.3-codex');
  A.ok(codex && codex.unmetered, 'mixed: Codex row is marked unmetered');
  A.eq(codex.spendLabel, 'subscription / unmetered', 'mixed: Codex row carries subscription label');
  A.eq(codex.usd, 0, 'mixed: Codex row USD excluded');
  A.eq(codex.tokens, 900, 'mixed: Codex row token total retained');
  const agentA = x.byAgent.find(a => a.agentId === 'a');
  A.ok(Math.abs(agentA.usd - 0.04) < 1e-9, 'mixed: byAgent USD excludes unmetered dollars');
  A.eq(agentA.runs, 2, 'mixed: byAgent run count includes unmetered');
  A.eq(agentA.unmeteredRuns, 1, 'mixed: byAgent tracks unmetered runs');
  A.ok(Math.abs(x.overTime.reduce((s, b) => s + b.usd, 0) - 0.06) < 1e-9, 'mixed: overTime USD excludes unmetered dollars');
  A.eq(x.overTime.reduce((s, b) => s + b.unmeteredRuns, 0), 1, 'mixed: overTime tracks unmetered runs separately');
}

// interrupted runs: spend never settled -> excluded from every $ figure and from metered runs, counted as spendUnknownRuns
{
  const H2 = 3600000;
  const rows2 = [
    { reason: 'done', usd: 0.05, tokens: 100, model: 'm1', agentId: 'a', ts: 1000 },
    { reason: 'interrupted', usd: 0, tokens: 0, spendUnknown: true, model: 'm1', agentId: 'a', ts: 1000 }
  ];
  const y = foldInsights(rows2, { nowMs: 1000 + H2, bucketMs: H2, buckets: 2 });
  A.eq(y.totalRuns, 2, 'interrupted: still counted as a run');
  A.eq(y.spendUnknownRuns, 1, 'interrupted: named as a spend-unknown run');
  A.eq(y.meteredRuns, 1, 'interrupted: not counted as a metered (priced) run');
  A.ok(Math.abs(y.avgUsdPerRun - 0.05) < 1e-9, 'interrupted: avg USD is not diluted by an unpriced run');
  A.eq(y.byReason.interrupted, 1, 'interrupted: byReason counts it');
  const m1 = y.byModel.find(m => m.model === 'm1');
  A.eq(m1.spendUnknownRuns, 1, 'interrupted: byModel names the spend-unknown run');
  A.eq(m1.meteredRuns, 1, 'interrupted: byModel metered count excludes it');
  A.eq(y.byAgent.find(a => a.agentId === 'a').spendUnknownRuns, 1, 'interrupted: byAgent names it');
}

// a run STOPPED mid-answer after booking $0.40 over earlier calls (80de2a75): the known $0.40 and its tokens stay in every
// total, as a floor (usageMissing) — never zeroed like an unsettled interrupted run, never called unpriced
{
  const rows3 = [
    { reason: 'done', usd: 0.10, tokens: 100, model: 'm1', agentId: 'a', ts: 1000 },
    { reason: 'cancelled', usd: 0.40, tokens: 30000, usageMissing: true, model: 'm1', agentId: 'a', ts: 1000 }
  ];
  const z = foldInsights(rows3, { nowMs: 1000 + 3600000, bucketMs: 3600000, buckets: 2 });
  A.ok(Math.abs(z.totalUsd - 0.50) < 1e-9, 'stopped mid-answer: its booked $ stays in the total (got ' + z.totalUsd + ')');
  A.eq(z.totalTokens, 30100, 'stopped mid-answer: its booked tokens stay in the total');
  A.eq(z.spendUnknownRuns, 0, 'stopped mid-answer with booked spend: not a spend-unknown run');
  A.eq(z.unpricedRuns, 0, 'stopped mid-answer: not an unpriced run');
  A.eq(z.usageMissingRuns, 1, 'stopped mid-answer: named as a floor');
  A.eq(z.meteredRuns, 2, 'stopped mid-answer: still a metered run');
  const zm = z.byModel.find(m => m.model === 'm1');
  A.ok(Math.abs(zm.usd - 0.50) < 1e-9 && zm.usageMissingRuns === 1, 'stopped mid-answer: byModel keeps the $ and names the floor');
  A.ok(/at least/.test(zm.spendLabel) && !/unpriced|no published price/.test(zm.spendLabel), 'stopped mid-answer: byModel says "at least", never "unpriced": ' + zm.spendLabel);
  A.ok(Math.abs(z.byAgent.find(a => a.agentId === 'a').usd - 0.50) < 1e-9, 'stopped mid-answer: byAgent keeps the $');
}

// TYPED OUTCOMES (review 4.1): the success rate counts a run by its OUTCOME, never its bare reason. A reply the provider cut ends
// 'done' too (finishReason 'length', stamped cut_short); a 'done' end its own error outranked is stamped failed; a row with no reason
// proves no ending. Before 4.1 these three rows read "100% success" (byReason { done: 3 }) with none of them a success.
{
  const cut = { reason: 'done', finishReason: 'length', outcome: 'cut_short', usd: 0.01, model: 'm', agentId: 'a', ts: 1000 };
  const raised = { reason: 'done', outcome: 'failed', failureCode: 'run_failure', usd: 0.01, model: 'm', agentId: 'a', ts: 1000 };
  const bare = { usd: 0.01, model: 'm', agentId: 'a', ts: 1000 };
  const ok = { reason: 'done', outcome: 'succeeded', usd: 0.01, model: 'm', agentId: 'a', ts: 1000 };
  const asked = { reason: 'done', clarifying: true, outcome: 'asked', usd: 0, model: 'm', agentId: 'a', ts: 1000 };
  const none = foldInsights([cut, raised, bare], { nowMs: 1000 });
  A.eq(none.successPct, 0, 'a cut reply, a raised error and a reasonless row are no successes (got ' + none.successPct + '% / ' + JSON.stringify(none.byReason) + ')');
  A.eq(none.byReason.done, undefined, '…and none of them is counted as done');
  A.eq(none.byReason.cut_short, 1, 'a provider-cut reply has its own bucket');
  A.eq(none.byReason.error, 2, 'a raised error and a row that proves no ending count as errors');
  const half = foldInsights([cut, ok], { nowMs: 1000 });
  A.eq(half.successPct, 50, 'a cut row beside a succeeded one reads 50%, never 100% (got ' + half.successPct + ')');
  const q = foldInsights([ok, asked], { nowMs: 1000 });
  A.eq(q.successPct, 100, 'a question the run asked is no attempt: it neither succeeds nor fails (got ' + q.successPct + ')');
  A.eq(q.byReason.clarifying, 1, '…it is counted as a question');
  // a legacy row (no outcome stamp) resolves from its own fields: a provider cut is still cut short
  A.eq(foldInsights([{ reason: 'done', finishReason: 'length', ts: 1000 }], { nowMs: 1000 }).byReason.cut_short, 1, 'a legacy cut row (finishReason only) is cut short');
}

A.report('insights.test');
