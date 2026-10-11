/* node test/loop.unbilled-seatbelt.test.js — the loop's SUBSCRIPTION usage seatbelt (2026-10-11).

   A Claude Code subscription turn books $0, so maxCostUsd and the unpriced-token ceiling never fire on it: before this
   lane a subscription run (and every post-run pass) was structurally unbounded. The loop now tallies the WEIGHTED tokens
   of every turn cost.js marks unbilled and:
     A. ends 'budget' / scope 'run' / budgetUnit 'tokens' at limits.maxUnbilledTokens, with a payload that still
        validates against the frozen agent.run.end schema (budgetUnit/budgetTokens/budgetCapTokens are undeclared extras);
     B. hands the budget adapter its live tally — budget.check(spentUsd, { unbilledTokens });
     C. ends 'budget' / scope 'day' / budgetUnit 'tokens' when the adapter answers { unit: 'tokens' } (the daily pool);
     D. leaves unpriced, priced and no-ceiling runs exactly as they were;
     E. takes a fallback entry's own maxUnbilledTokens on a swap;
     F. never buys a steer extension past the ceiling (a note folded into a turn that would stop is read by nobody). */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const schema = require('../shared/schema.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');

function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { seq, emit };
}
const noopTool = [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }];
// one turn = 1000 uncached + 2000 cache write + 30000 cache read + 500 out = 10,500 weighted (the claude-cli shape)
const SUB_USAGE = { prompt_tokens: 33000, completion_tokens: 500, total_tokens: 33500,
  prompt_tokens_details: { cached_tokens: 30000, cache_creation_tokens: 2000 }, reasoning_tokens: 0, cost: 0, subscription: true };
const PER_TURN = 10500;
function burnProvider(usage, opts) {
  opts = opts || {};
  let calls = 0;
  const p = {
    priceOf: () => null, contextLimit: () => 0,
    calls: () => calls,
    stream: async function* () {
      calls++;
      if (opts.text) { yield { type: 'text', delta: 'final answer ' + calls }; yield { type: 'usage', usage }; yield { type: 'done', finishReason: 'stop' }; return; }
      yield { type: 'tool_start', index: 0, id: 'c' + calls, name: 'noop' };
      yield { type: 'tool_args', index: 0, chunk: '{}' };
      yield { type: 'usage', usage };
      yield { type: 'done', finishReason: 'tool_calls' };
    }
  };
  return p;
}
const cost = () => makeCostEngine({ priceOf: () => null });
const base = (provider, extra) => Object.assign({
  messages: [{ role: 'user', content: 'x' }], provider, cost: cost(),
  dispatch: async () => ({ ok: true, content: 'ok' }), tools: noopTool, model: 'sonnet', agentId: 'a', runId: 'r', sleep: async () => {}
}, extra);
const valid = p => schema.validate(events.EVENTS['agent.run.end'], p).ok;

(async () => {
  // ---- A. the per-run ceiling ----
  {
    const { seq, emit } = setup();
    const prov = burnProvider(SUB_USAGE);
    const res = await runAgentLoop(base(prov, { emit, limits: { maxCostUsd: 1.00, maxIters: 10, grace: false, maxUnbilledTokens: 20000 } }));
    A.eq(res.reason, 'budget', 'a subscription run ends budget at its weighted-token ceiling');
    A.eq([res.turns, prov.calls()], [2, 2], 'it stops BEFORE a third paid call (10,500 + 10,500 >= 20,000)');
    A.eq(res.usd, 0, 'spend is honestly $0 — the $ cap alone would never have fired');
    A.eq([res.budgetScope, res.budgetUnit, res.budgetTokens, res.budgetCapTokens, res.unbilledTokens], ['run', 'tokens', 21000, 20000, 21000], 'the return names the token stop');
    A.ok(/21,000/.test(res.budgetNote) && /20,000/.test(res.budgetNote) && /estimate/.test(res.budgetNote), 'budgetNote is a legible sentence and says it is an estimate: ' + res.budgetNote);
    A.eq(res.unpricedModel, undefined, 'it is not dressed up as an unpriced-model stop');
    const end = seq.find(e => e.name === 'agent.run.end').payload;
    A.eq([end.reason, end.budgetScope, end.budgetUnit, end.budgetTokens, end.budgetCapTokens], ['budget', 'run', 'tokens', 21000, 20000], 'agent.run.end carries the token stop');
    A.eq(end.budgetCapUsd, undefined, 'no $ figure is claimed for a token stop');
    A.ok(Number.isInteger(end.budgetTokens) && Number.isInteger(end.budgetCapTokens), 'the token figures are integers');
    A.eq(valid(end), true, 'the payload still validates against the frozen agent.run.end schema');
    A.eq(seq.filter(e => e.name === 'budget.threshold').length, 0, 'no budget.threshold is emitted for tokens (its enum and $ payload are frozen)');
  }

  // ---- B + C. the adapter sees the live tally; a { unit:'tokens' } answer ends day/tokens ----
  {
    const { seq, emit } = setup();
    const seen = [];
    const budget = { check: (spent, live) => {
      seen.push([spent, live && live.unbilledTokens]);
      return (live && live.unbilledTokens >= PER_TURN) ? { scope: 'day', unit: 'tokens', tokens: live.unbilledTokens + 5000, cap: 15000 } : null;
    } };
    const prov = burnProvider(SUB_USAGE);
    const res = await runAgentLoop(base(prov, { emit, budget, limits: { maxCostUsd: 1.00, maxIters: 10, grace: false } }));
    A.eq(seen[0], [0, 0], 'the adapter is consulted before the first paid call with a zero tally');
    A.ok(seen.some(s => s[1] === PER_TURN), 'and receives { unbilledTokens } as the run accrues: ' + JSON.stringify(seen));
    A.eq([res.reason, res.budgetScope, res.budgetUnit, res.budgetTokens, res.budgetCapTokens], ['budget', 'day', 'tokens', 15500, 15000], 'a token answer ends budget/day/tokens');
    A.eq(prov.calls(), 1, 'no further paid call after the pool answered');
    const end = seq.find(e => e.name === 'agent.run.end').payload;
    A.eq([end.budgetScope, end.budgetUnit, end.budgetCapTokens], ['day', 'tokens', 15000], 'the event names the day pool in tokens');
    A.eq(valid(end), true, 'day/tokens payload validates');
    A.ok(/daily usage limit/.test(res.budgetNote) && /estimate/.test(res.budgetNote), 'the day note names the daily usage limit as an estimate');
    // a $ answer still ends exactly as before
    const $ = setup();
    const res$ = await runAgentLoop(base(burnProvider(SUB_USAGE), { emit: $.emit, budget: { check: () => ({ scope: 'day', usd: 30, cap: 25 }) }, limits: { maxCostUsd: 1.00, maxIters: 10, grace: false } }));
    A.eq([res$.reason, res$.budgetScope, res$.budgetCapUsd, res$.budgetUnit], ['budget', 'day', 25, undefined], 'a $ pool stop is unchanged (no budgetUnit)');
  }

  // ---- D. unpriced / priced / no-ceiling runs are unchanged ----
  {
    const up = setup();
    const unpricedUsage = { prompt_tokens: 600000, completion_tokens: 0, total_tokens: 600000 };
    const r1 = await runAgentLoop(base(burnProvider(unpricedUsage), { emit: up.emit, model: 'mystery/model', limits: { maxCostUsd: 1, maxIters: 10, grace: false, maxUnpricedTokens: 1000000, maxUnbilledTokens: 1 } }));
    A.eq([r1.reason, r1.turns, r1.unpricedModel, r1.budgetUnit, r1.unbilledTokens], ['budget', 2, 'mystery/model', undefined, 0], 'an unpriced run stops on the unpriced ceiling, never the unbilled one');
    const pr = setup();
    const priced = { priceOf: () => ({ in: 1, out: 2 }), contextLimit: () => 0, stream: burnProvider({ prompt_tokens: 1000, completion_tokens: 100 }).stream };
    const r2 = await runAgentLoop(base(priced, { emit: pr.emit, cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 2 }) }), limits: { maxCostUsd: 100, maxIters: 3, grace: false, maxUnbilledTokens: 1 } }));
    A.eq([r2.reason, r2.unbilledTokens], ['max_iters', 0], 'a priced (billed) run is never counted against the unbilled ceiling');
    A.ok(r2.usd > 0, 'and its spend is real');
    const ab = setup();
    const r3 = await runAgentLoop(base(burnProvider(SUB_USAGE), { emit: ab.emit, limits: { maxCostUsd: 1, maxIters: 3, grace: false } }));
    A.eq([r3.reason, r3.unbilledTokens], ['max_iters', 3 * PER_TURN], 'no maxUnbilledTokens = no ceiling; the tally is still reported for the ledger');
    const zero = setup();
    const r4 = await runAgentLoop(base(burnProvider(SUB_USAGE), { emit: zero.emit, limits: { maxCostUsd: 1, maxIters: 3, grace: false, maxUnbilledTokens: 0 } }));
    A.eq(r4.reason, 'max_iters', '0 = off (SKYNET_MAX_UNBILLED_TOKENS=0)');
    const inf = setup();
    const r5 = await runAgentLoop(base(burnProvider(SUB_USAGE), { emit: inf.emit, limits: { maxCostUsd: 1, maxIters: 3, grace: false, maxUnbilledTokens: Infinity } }));
    A.eq(r5.reason, 'max_iters', 'Infinity (an exempt provider) = off');
    // a free model reporting $0 WITHOUT the subscription flag is not unbilled use
    const free = setup();
    const r6 = await runAgentLoop(base(burnProvider(Object.assign({}, SUB_USAGE, { subscription: undefined })), { emit: free.emit, limits: { maxCostUsd: 1, maxIters: 3, grace: false, maxUnbilledTokens: 1 } }));
    A.eq([r6.reason, r6.unbilledTokens], ['max_iters', 0], 'cost 0 without the flag never trips the ceiling');
  }

  // ---- E. a fallback entry brings its own ceiling ----
  {
    const fb = setup();
    const overloaded = () => { const e = new Error('http 529 - overloaded'); e.status = 529; return e; };
    const primary = { priceOf: () => null, contextLimit: () => 0, stream: async function* () { throw overloaded(); } };
    const secondary = burnProvider(SUB_USAGE);
    const res = await runAgentLoop(base(primary, { emit: fb.emit, limits: { maxCostUsd: 1, maxIters: 6, grace: false },
      fallbacks: [{ provider: secondary, model: 'model-B', maxUnbilledTokens: 15000 }] }));
    A.eq([res.reason, res.budgetScope, res.budgetUnit, res.budgetCapTokens], ['budget', 'run', 'tokens', 15000], 'after the swap the fallback\'s own ceiling binds');
    A.eq(secondary.calls(), 2, 'it stopped on the second fallback turn (21,000 >= 15,000)');
  }

  // ---- F. the steer extension never runs past the ceiling ----
  {
    const mk = (cap) => {
      let calls = 0;
      const steer = () => { calls++; return calls === 1 ? [] : ['late note']; };
      return { steer, calls: () => calls, cap };
    };
    const capped = mk(10000), s1 = setup();
    const rc = await runAgentLoop(base(burnProvider(SUB_USAGE, { text: true }), { emit: s1.emit, steer: capped.steer, limits: { maxCostUsd: 1, maxIters: 6, grace: false, maxUnbilledTokens: capped.cap } }));
    A.eq(rc.reason, 'done', 'the answer stands when the ceiling is reached on the final turn');
    A.eq(capped.calls(), 1, 'the late steer drain is skipped (only the top-of-turn drain ran) — no extension past the ceiling');
    const open = mk(1e9), s2 = setup();
    await runAgentLoop(base(burnProvider(SUB_USAGE, { text: true }), { emit: s2.emit, steer: open.steer, limits: { maxCostUsd: 1, maxIters: 6, grace: false, maxUnbilledTokens: open.cap } }));
    A.ok(open.calls() >= 2, 'control: with headroom the late note IS drained (the guard, not the fixture, made the difference)');
  }

  A.report('loop.unbilled-seatbelt');
})().catch(e => { console.log('FAIL: loop.unbilled-seatbelt threw - ' + (e && e.stack || e)); process.exit(1); });
