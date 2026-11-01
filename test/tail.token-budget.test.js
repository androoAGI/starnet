/* node test/tail.token-budget.test.js — Step 2 wave 2, audit F2: the verbatim tail is a TOKEN budget, and the per-run
   tool-output budget is re-armed only by a fold that really freed space.

   The bug (audit probe 09-22, 64k window, production run cap): the tail was 6 TURNS. With ~79k-char tool results six
   turns weigh ~120k tokens — more than the whole window — so a fold could only fold what the tail did not hold: one
   fold freed 0.6%, yet it re-armed the tool-byte budget, full-size results came straight back, and the run ended
   error/context_overflow at 82,200 tokens. Now the tail is 20% of the window (never less than the newest assistant
   turn and its results, never splitting a call from its result), and the budget re-arms only when agent.compact
   shows >= 10% freed (foldFreedEnough — the predicate index.js runOnce uses).

   Real runAgentLoop + makeContext(RUN_CONTEXT_DEFAULTS) + the real run-execution budget (makeRunExecutionState,
   toolBytesCapFor), wired to agent.compact exactly like index.js loopEmit. The provider ENFORCES the window. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext, RUN_CONTEXT_DEFAULTS, foldFreedEnough } = require('../sidecar/context.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { makeRunExecutionState, toolBytesCapFor } = require('../sidecar/run-execution-state.js');

const READ_TOOL = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }];

(async () => {
  // ---- 0. the re-arm predicate (same unit on both sides: agent.compact's local before/after) ----
  A.eq(foldFreedEnough({ beforeTokens: 59847, afterTokens: 59493 }), false, 'the probe\'s 0.6% fold does NOT re-arm');
  A.eq(foldFreedEnough({ beforeTokens: 41883, afterTokens: 22224 }), true, 'a 47% fold re-arms');
  A.eq(foldFreedEnough({ beforeTokens: 1000, afterTokens: 900 }), true, 'exactly 10% re-arms');
  A.eq(foldFreedEnough({ beforeTokens: 1000, afterTokens: 901 }), false, 'just under 10% does not');
  A.eq(foldFreedEnough({ beforeTokens: 0, afterTokens: 0 }), false, 'an unmeasured fold does not');
  A.eq(foldFreedEnough(null), false, 'no payload does not');

  // ---- 1. the tail planner: token-sized, floored at the newest assistant turn, pairing-safe ----
  {
    const ctx = makeContext(Object.assign({ contextLimit: 10000 }, RUN_CONTEXT_DEFAULTS));   // tail budget 2,000 tokens
    A.eq(ctx.tailBudgetTokens(), 2000, 'tail budget = 20% of the window');
    const big = (k) => 'B' + k + ' ' + 'b'.repeat(12000);   // ~3,000 tokens each: bigger than the whole tail budget
    const call = (id) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }] });
    const h = [{ role: 'user', content: 'u' }, call('c1'), { role: 'tool', tool_call_id: 'c1', content: big(1) }, call('c2'), { role: 'tool', tool_call_id: 'c2', content: big(2) }];
    let p = ctx.planCompaction(h);
    A.eq(p.tail.length, 2, 'an over-budget newest turn is still kept whole (the floor)');
    A.eq(p.tail[0], h[3], 'the tail starts at the newest assistant call');
    A.eq(p.older.length, 3, 'everything older folds');
    // a screenshot-style user turn after the newest call rides with it
    const h2 = h.concat([{ role: 'user', content: [{ type: 'text', text: '[BEGIN EXTERNAL SCREEN CAPTURE x]' }] }]);
    p = ctx.planCompaction(h2);
    A.eq(p.tail[0], h[3], 'the floor spans from the newest assistant turn through everything after it');
    // small turns: many fit the budget, and the cut never lands on a tool result
    const small = [{ role: 'user', content: 'start' }];
    for (let k = 0; k < 40; k++) { small.push(call('s' + k)); small.push({ role: 'tool', tool_call_id: 's' + k, content: 'r'.repeat(400) }); }
    p = ctx.planCompaction(small);
    A.ok(p.tail.length >= 20 && p.tail.length < small.length, 'small turns: the tail holds many turns under the budget (' + p.tail.length + ' messages)');
    A.ok(p.tail[0].role === 'assistant', 'the tail never begins with an orphan tool result');
    A.ok(ctx.estimateMessages(p.tail) <= 2000 + 200, 'the tail respects the token budget (' + ctx.estimateMessages(p.tail) + ')');
    // window unknown -> the legacy turn count (keepTailTurns) applies
    const cold = makeContext(Object.assign({ contextLimit: 0 }, RUN_CONTEXT_DEFAULTS));
    A.eq(cold.planCompaction(small).tail.length, 12, 'unknown window: the legacy 6-turn tail (6 call+result pairs)');
  }

  // ---- 2. 64k window, 79k-char results, the production run cap: the run COMPLETES, never over the window ----
  {
    const WIN = 64000;
    const ctx = makeContext(Object.assign({ contextLimit: WIN }, RUN_CONTEXT_DEFAULTS));
    const st = makeRunExecutionState({});
    const cap = toolBytesCapFor(WIN, 120000);
    const compacts = [], sizes = [];
    let turn = 0, resets = 0, bounded = 0;
    const provider = { priceOf: () => null, contextLimit: () => WIN, stream: async function* (req) {
      turn++;
      const est = ctx.estimateMessages(req.messages) + 3000;   // + the system prompt / schemas the provider counts
      sizes.push(est);
      if (est > WIN) { const e = new Error("openai http 400 - This model's maximum context length is " + WIN + ' tokens. However, your messages resulted in ' + est + ' tokens.'); e.status = 400; throw e; }
      if (turn <= 12) {
        yield { type: 'tool_start', index: 0, id: 'c' + turn, name: 'read' }; yield { type: 'tool_args', index: 0, chunk: '{}' };
        yield { type: 'usage', usage: { prompt_tokens: est, completion_tokens: 10, total_tokens: est + 10 } }; yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'FINAL' }; yield { type: 'usage', usage: { prompt_tokens: est, completion_tokens: 5, total_tokens: est + 5 } }; yield { type: 'done', finishReason: 'stop' };
    } };
    const res = await runAgentLoop({
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'read 12 big logs' }], provider,
      // index.js loopEmit: re-arm only on a fold that freed >= 10%
      emit: (n, p) => { if (n === 'agent.compact') { compacts.push(p); if (foldFreedEnough(p)) { st.resetToolBytes(); resets++; } } },
      cost: makeCostEngine({ priceOf: () => null }), tools: READ_TOOL,
      dispatch: async (c) => { const r = st.boundToolResult({ ok: true, content: 'LOG ' + c.id + ' ' + 'L'.repeat(79000), summary: 'ok' }, cap, { omitted: '[tool output omitted — run budget]' }); if (r.outputBounded) bounded++; return r; },
      context: ctx, summarize: async (o) => ({ summary: 'S(' + o.length + ')', usd: 0, tokens: 0 }),
      model: 'm', agentId: 'a', runId: 'r', approxTokens: 50, contextLimit: WIN, limits: { maxIters: 20 }
    });
    A.eq(res.reason, 'done', 'the 12-read run completes instead of dying context_overflow (requests: ' + sizes.join(',') + ')');
    A.ok(Math.max.apply(null, sizes) <= WIN, 'no request exceeded the 64k window (max ' + Math.max.apply(null, sizes) + ')');
    A.ok(compacts.length >= 1, 'folds happened (' + compacts.map(p => p.reason + ':' + p.beforeTokens + '->' + p.afterTokens).join(', ') + ')');
    A.ok(compacts.every(p => (p.beforeTokens - p.afterTokens) / p.beforeTokens >= 0.10), 'every fold freed >= 10% (the token tail leaves something to fold)');
    A.ok(resets >= 1 && resets === compacts.filter(foldFreedEnough).length, 'the budget re-armed exactly on the folds that freed >= 10% (' + resets + ')');
    A.eq(bounded, 0, 'every 79k result reached the model in full (the re-arm tracked the real freed context)');
    A.ok(res.messages.some(m => m.role === 'assistant' && m.content === 'FINAL'), 'the final answer landed');
  }

  // ---- 3. a fold that frees < 10% does NOT re-arm: the exhausted budget stays exhausted ----
  {
    const st = makeRunExecutionState({});
    const ctx = {   // injected context whose folds barely shrink: 100 -> 96 (4%)
      shouldCompact: () => true, estimateMessages: (arr) => arr.length > 3 ? 100 : 96,
      planCompaction: (arr) => ({ older: arr.slice(0, 1), tail: arr.slice(1) })
    };
    const compacts = []; let resets = 0; const results = [];
    let n = 0;
    const provider = { priceOf: () => null, stream: async function* () {
      n++;
      if (n <= 4) { yield { type: 'tool_start', index: 0, id: 'k' + n, name: 'read' }; yield { type: 'tool_args', index: 0, chunk: '{}' }; yield { type: 'usage', usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 } }; yield { type: 'done', finishReason: 'tool_calls' }; return; }
      yield { type: 'text', delta: 'end' }; yield { type: 'done', finishReason: 'stop' };
    } };
    await runAgentLoop({ messages: [{ role: 'user', content: 'd' }, { role: 'user', content: 'older note' }, { role: 'assistant', content: 'ack' }], provider,
      emit: (nm, p) => { if (nm === 'agent.compact') { compacts.push(p); if (foldFreedEnough(p)) { st.resetToolBytes(); resets++; } } },
      cost: makeCostEngine({ priceOf: () => null }), tools: READ_TOOL, context: ctx, summarize: async () => ({ summary: 'S', usd: 0, tokens: 0 }),
      dispatch: async () => { const r = st.boundToolResult({ ok: true, content: 'y'.repeat(800), summary: 'ok' }, 1000, { omitted: '[omitted]' }); results.push(r.content.length); return r; },
      model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 10 } });
    A.ok(compacts.length >= 1, 'low-savings folds were emitted (' + compacts.length + ')');
    A.eq(resets, 0, 'none of them re-armed the budget');
    // an unconditional re-arm (the old wiring) would have reset the budget at the top of turn 2 and let result #2 in whole
    A.ok(results.length >= 3 && results[1] < 800 && results[2] < 800, 'with the budget spent and no qualifying fold, results #2 and #3 stayed bounded (' + results.join(',') + ')');
  }

  // ---- 4. index.js runOnce wires exactly this policy (the production seam, not a test double) ----
  {
    const src = readSidecarSource();
    A.ok(/makeContext\(Object\.assign\(\{ contextLimit: [^}]+\}, RUN_CONTEXT_DEFAULTS\)\)/.test(src), 'runOnce builds its context manager from RUN_CONTEXT_DEFAULTS');
    A.ok(/if \(name === 'agent\.compact' && foldFreedEnough\(payload\)\) execution\.resetToolBytes\(\);/.test(src), 'runOnce re-arms the tool budget only through foldFreedEnough');
    A.ok(!/if \(name === 'agent\.compact'\) execution\.resetToolBytes\(\);/.test(src), 'the unconditional re-arm is gone');
    A.ok(RUN_CONTEXT_DEFAULTS.tailShare > 0 && RUN_CONTEXT_DEFAULTS.tailShare <= 0.25, 'the tail is a share of the window (' + RUN_CONTEXT_DEFAULTS.tailShare + ')');
  }

  // ---- 5. the tail budget is in REAL tokens: when the provider counts far more than the local estimator sees (an
  //         image part estimates at ~8 tokens), the planner is told the ratio and the history still folds ----
  {
    const ctx = makeContext(Object.assign({ contextLimit: 200000 }, RUN_CONTEXT_DEFAULTS));
    const hist = [];
    for (let k = 0; k < 16; k++) hist.push({ role: k % 2 ? 'assistant' : 'user', content: 'history turn ' + k + ' ' + 'h'.repeat(200) });
    hist.push({ role: 'assistant', content: '', tool_calls: [{ id: 'i1', type: 'function', function: { name: 'inspect', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'i1', content: 'ok' });
    A.eq(ctx.planCompaction(hist).older.length, 0, 'unscaled, a locally-small history all fits the 40k tail (nothing to fold)');
    const scaled = ctx.planCompaction(hist, { scale: 70 });
    A.ok(scaled.older.length > 0 && scaled.tail[0].role === 'assistant', 'scaled by the real/local ratio, the older turns fold and the tail starts on a call');

    // through the loop: the provider reports 140k prompt tokens for a ~1.5k-token (local) history on a 200k window
    let n = 0; const log = [];
    const provider = { priceOf: () => null, contextLimit: () => 200000, stream: async function* () {
      n++; log.push('request');
      if (n === 1) { yield { type: 'tool_start', index: 0, id: 'i1', name: 'read' }; yield { type: 'tool_args', index: 0, chunk: '{}' }; yield { type: 'usage', usage: { prompt_tokens: 140000, completion_tokens: 4, total_tokens: 140004 } }; yield { type: 'done', finishReason: 'tool_calls' }; return; }
      yield { type: 'text', delta: 'done' }; yield { type: 'usage', usage: { prompt_tokens: 900, completion_tokens: 1, total_tokens: 901 } }; yield { type: 'done', finishReason: 'stop' };
    } };
    const res = await runAgentLoop({ messages: hist.slice(0, 16).concat([{ role: 'user', content: 'finish after inspecting' }]), provider, tools: READ_TOOL,
      dispatch: async () => ({ ok: true, content: 'inspected' }), cost: makeCostEngine({ priceOf: () => null }), context: ctx,
      emit: (nm, p) => { if (nm === 'agent.compact') log.push('compact:' + p.reason); }, summarize: async () => { log.push('summarize'); return 'S'; },
      model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 5 } });
    A.eq(res.reason, 'done', 'the run completes');
    A.ok(log.indexOf('compact:context') > log.indexOf('request') && log.indexOf('compact:context') < log.lastIndexOf('request'), 'a real fold happened before request 2 (' + log.join(' > ') + ')');
  }

  A.report('tail.token-budget.test');
})().catch(e => { console.error(e); process.exit(1); });
