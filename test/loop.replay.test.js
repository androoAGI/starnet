/* node test/loop.replay.test.js — the agentic loop driven by the replay provider (zero spend).
   Proves: exact event sequence, token count, single run.end, cost reconciliation,
   determinism (byte-identical across runs), and cancellation (pre + mid-stream). */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeContext } = require('../sidecar/context.js');

// a minimal write-like tool + an open capCtx, for the L2 tool-call repair cases
const WRITE_SCHEMA = { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } };
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
function brokenArgsFixture(chunk) {
  return { turns: [
    [{ type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: chunk }, { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }]
  ] };
}

function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { bus, seq, emit };
}
const names = seq => seq.map(e => e.name);

function chatFixture() {
  return {
    models: [{ id: 'replay/model', context_length: 8000, pricing: { prompt: '0.000001', completion: '0.000002' }, supportsTools: true }],
    turns: [[
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo,' },
      { type: 'text', delta: ' Commander' },
      { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      { type: 'done', finishReason: 'stop' }
    ]]
  };
}

(async () => {
  // ---- happy path: exact sequence + cost + assistant message ----
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider(chatFixture());
    const cost = makeCostEngine({ priceOf: provider.priceOf });
    const messages = [{ role: 'user', content: 'hi' }];
    const res = await runAgentLoop({ messages, provider, emit, cost, model: 'replay/model', agentId: 'a', runId: 'r1' });

    A.eq(names(seq), ['agent.run.start', 'agent.token', 'agent.token', 'agent.token', 'cost.estimate', 'agent.cost', 'agent.run.end'], 'exact event sequence');
    A.eq(res.reason, 'done', 'loop ends done');
    A.eq(seq.filter(e => e.name === 'agent.token').length, 3, 'token count == fixture chunks');
    A.eq(seq.filter(e => e.name === 'agent.run.end').length, 1, 'run.end emitted exactly once');

    const c = seq.find(e => e.name === 'agent.cost').payload;
    A.eq(c.reconciled, true, 'agent.cost is reconciled');
    A.eq(c.tokensIn, 10, 'reconciled tokensIn');
    A.eq(c.tokensOut, 5, 'reconciled tokensOut');
    A.ok(Math.abs(c.usd - 20 / 1e6) < 1e-12, 'reconciled usd from catalog pricing');

    const last = messages[messages.length - 1];
    A.eq(last.role, 'assistant', 'assistant turn appended');
    A.eq(last.content, 'Hello, Commander', 'full streamed text assembled');
    A.eq(provider.callCount(), 1, 'exactly one model call');
  }

  // ---- preflight tool-support promotion: ordered lifecycle + effective model truth ----
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider(chatFixture());
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'do the task' }], provider, emit,
      cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'tools/model', agentId: 'a', runId: 'promoted',
      initialFallback: { fromModel: 'plain/chat', toModel: 'tools/model', reason: 'tool_support', rotate: false }
    });
    A.eq(names(seq).slice(0, 2), ['agent.run.start', 'provider.fallback'], 'preflight promotion is reported after run start');
    const fb = seq[1].payload;
    A.eq(fb.fromModel, 'plain/chat', 'promotion receipt names the incapable selected model');
    A.eq(fb.toModel, 'tools/model', 'promotion receipt names the effective task model');
    A.eq(fb.reason, 'tool_support', 'promotion receipt distinguishes capability routing from provider failure');
    A.eq(res.model, 'tools/model', 'the loop and final receipt use the promoted model');
  }

  // ---- determinism: byte-identical event stream across runs ----
  {
    const r1 = setup(); const p1 = makeReplayProvider(chatFixture());
    await runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], provider: p1, emit: r1.emit, cost: makeCostEngine({ priceOf: p1.priceOf }), model: 'replay/model' });
    const r2 = setup(); const p2 = makeReplayProvider(chatFixture());
    await runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], provider: p2, emit: r2.emit, cost: makeCostEngine({ priceOf: p2.priceOf }), model: 'replay/model' });
    A.eq(JSON.stringify(r1.seq), JSON.stringify(r2.seq), 'same fixture + inputs -> byte-identical event stream');
  }

  // ---- pre-aborted signal: no model call, no tokens ----
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider(chatFixture());
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', signal: { aborted: true } });
    A.eq(res.reason, 'cancelled', 'pre-aborted -> cancelled');
    A.eq(names(seq), ['agent.run.start', 'agent.run.end'], 'no tokens when pre-aborted');
    A.eq(provider.callCount(), 0, 'no model call when pre-aborted');
  }

  // ---- mid-stream cancel: partial tokens + partial assistant text, no cost ----
  {
    const { bus, seq, emit } = setup();
    const provider = makeReplayProvider(chatFixture());
    const signal = { aborted: false };
    let n = 0;
    bus.on('agent.token', () => { if (++n === 2) signal.aborted = true; });
    const messages = [{ role: 'user', content: 'hi' }];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', signal });
    A.eq(res.reason, 'cancelled', 'mid-stream abort -> cancelled');
    A.eq(seq.filter(e => e.name === 'agent.token').length, 2, 'exactly 2 tokens before cancel');
    A.ok(seq.find(e => e.name === 'agent.cost') === undefined, 'no cost emitted on mid-stream cancel');
    A.eq(messages[messages.length - 1].content, 'Hello,', 'partial assistant text appended');
    A.eq(names(seq)[names(seq).length - 1], 'agent.run.end', 'ends with run.end');
  }

  // ---- no usage event: cost.estimate skipped, agent.cost still emitted with zeros ----
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider({ turns: [[{ type: 'text', delta: 'hi' }, { type: 'done', finishReason: 'stop' }]] });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model' });
    A.eq(res.reason, 'done', 'ends done without usage');
    A.ok(seq.find(e => e.name === 'cost.estimate') === undefined, 'no cost.estimate without a usage event');
    A.eq(seq.find(e => e.name === 'agent.cost').payload.tokensIn, 0, 'agent.cost zeros without usage');
  }

  // ---- no-op refund: an empty/no-assistant/no-tool turn does not consume an effective turn ----
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider({ turns: [[{ type: 'done', finishReason: 'stop' }]] });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', limits: { maxIters: 1, grace: false } });
    A.eq(res.reason, 'empty', 'a final turn with no tool call AND no text ends reason:empty (audit 1.7 — distinct from a clean done so a degraded provider streaming empties is not read as a delivery)');
    A.eq(res.turns, 0, 'empty no-tool turn is refunded to the turn starting count');
    A.eq(seq.find(e => e.name === 'agent.run.end').payload.turns, 0, 'run.end reports the refunded effective turn count');
  }

  // ---- no-op refund never erases earlier productive turns ----
  {
    const { emit } = setup();
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => 'wrote ' + a.path });
    const provider = makeReplayProvider({ turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"a.md","content":"x"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'done', finishReason: 'stop' }]
    ] });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', limits: { maxIters: 2, grace: false }, dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx() });
    A.eq(res.reason, 'empty', 'a productive turn followed by an empty final turn ends reason:empty — the LAST turn produced nothing (audit 1.7)');
    A.eq(res.turns, 1, 'refund restores only the empty turn, not the earlier productive turn');
  }

  // ---- L2: broken tool-call args are repaired, the tool runs, pairing holds ----
  {
    const { seq, emit } = setup();
    let ran = 0, gotArgs = null;
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (args) => { ran++; gotArgs = args; return 'wrote ' + args.path; } });
    const provider = makeReplayProvider(brokenArgsFixture('{"path":"a.md","content":"hi",'));   // trailing comma + unclosed
    const messages = [{ role: 'user', content: 'write a.md' }];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: [], dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx() });

    const rep = seq.filter(e => e.name === 'tool.args.repaired');
    A.eq(rep.length, 1, 'exactly one tool.args.repaired emitted');
    A.eq(rep[0].payload.callId, 'c1', 'repaired event names the call');
    A.eq(rep[0].payload.before, '{"path":"a.md","content":"hi",', 'before = the broken raw args');
    A.notThrows(() => JSON.parse(rep[0].payload.after), 'after is valid JSON');
    A.eq(ran, 1, 'the tool actually ran (the call was NOT discarded)');
    A.eq(gotArgs, { path: 'a.md', content: 'hi' }, 'tool received the repaired args');
    A.eq(seq.find(e => e.name === 'agent.tool_result').payload.isError, false, 'repaired call dispatched without error');
    A.eq(res.reason, 'done', 'loop completes; pairing held (no throw)');
    const asst = messages.find(m => m.role === 'assistant' && m.tool_calls);
    A.notThrows(() => JSON.parse(asst.tool_calls[0].function.arguments), 'replayed assistant tool_call arguments are valid JSON');
  }

  // ---- L2 determinism: the repaired stream is byte-identical across runs ----
  {
    function runOnce() {
      const r = setup();
      const reg = makeRegistry();
      reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => 'ok ' + a.path });
      const provider = makeReplayProvider(brokenArgsFixture('{"path":"a.md","content":"hi",'));
      return runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit: r.emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
        model: 'replay/model', agentId: 'a', runId: 'r', tools: [], dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx() }).then(() => r.seq);
    }
    const s1 = await runOnce(), s2 = await runOnce();
    A.eq(JSON.stringify(s1), JSON.stringify(s2), 'repaired run is byte-identical across runs');
  }

  // ---- L2: UNREPAIRABLE args stay a parseError -> one clean isError result, the tool never runs ----
  {
    const { seq, emit } = setup();
    let ran = 0;
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async () => { ran++; return 'x'; } });
    const provider = makeReplayProvider(brokenArgsFixture('not json at all @@@'));
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: [], dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx() });
    A.eq(seq.filter(e => e.name === 'tool.args.repaired').length, 0, 'no repair event for unrepairable args');
    A.eq(seq.find(e => e.name === 'agent.tool_result').payload.isError, true, 'unrepairable args -> isError result');
    A.eq(ran, 0, 'the tool never ran on unrepairable args');
    A.eq(res.reason, 'done', 'loop recovers and finishes');
  }

  // ---- L3.S3: the stream catch classifies the API error so agent.run.error.transient is honest ----
  // (the replay provider yields fixtures and cannot throw, so this needs a throwing provider helper.)
  {
    const throwingProvider = (err) => ({ async *stream() { throw err; }, priceOf: () => null, contextLimit: () => 0 });
    const httpErr = (s, m) => Object.assign(new Error('openrouter http ' + s + (m ? ' — ' + m : '')), { status: s });
    async function runWithError(err) {
      const r = setup();
      const provider = throwingProvider(err);
      const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit: r.emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', agentId: 'a', runId: 'r' });
      return { res, seq: r.seq };
    }

    const rl = await runWithError(httpErr(429, 'slow down'));
    A.eq(rl.res.reason, 'error', '429 -> run ends error');
    A.eq(rl.seq.find(e => e.name === 'agent.run.error').payload.transient, true, '429 -> transient:true (retryable)');

    const bill = await runWithError(httpErr(402, 'insufficient credits'));
    A.eq(bill.seq.find(e => e.name === 'agent.run.error').payload.transient, false, '402 billing -> transient:false');

    const bad = await runWithError(httpErr(400, 'malformed request'));
    A.eq(bad.seq.find(e => e.name === 'agent.run.error').payload.transient, false, 'malformed 400 -> transient:false');
  }

  // ---- budget guard: a block descriptor from budget.check ends the run as 'budget' BEFORE any paid call ----
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider(chatFixture());
    const blockingBudget = { check: () => ({ scope: 'day', usd: 50, cap: 40 }) };
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', agentId: 'a', runId: 'r', budget: blockingBudget });
    A.eq(res.reason, 'budget', 'a budget block ends the run as budget');
    A.eq(provider.callCount(), 0, 'no model call is made when the budget blocks up front');
    A.eq(names(seq), ['agent.run.start', 'agent.run.end'], 'budget block: start then end, no paid turn');
    // budget-stop legibility (additive): the end event + return name WHICH cap fired and its effective $ cap
    const endEv = seq.find(e => e.name === 'agent.run.end');
    A.eq(endEv.payload.budgetScope, 'day', 'a pool block carries its scope on agent.run.end');
    A.eq(endEv.payload.budgetCapUsd, 40, 'a pool block carries the effective $ cap on agent.run.end');
    A.eq(res.budgetScope, 'day', 'the return value carries the blocked scope too');
    A.eq(res.budgetCapUsd, 40, 'the return value carries the effective $ cap too');
  }

  // ---- per-RUN hard ceiling: maxCostUsd 0 blocks before any paid call, named as scope 'run' ----
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider(chatFixture());
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', agentId: 'a', runId: 'r', limits: { maxCostUsd: 0 } });
    A.eq(res.reason, 'budget', 'spentUsd >= maxCostUsd ends the run as budget');
    A.eq(provider.callCount(), 0, 'no model call is made past the per-run ceiling');
    const endEv = seq.find(e => e.name === 'agent.run.end');
    A.eq(endEv.payload.budgetScope, 'run', 'the per-run hard ceiling is named scope run');
    A.eq(endEv.payload.budgetCapUsd, 0, 'the per-run cap value rides the event');
    // a clean stop must NOT carry the budget fields (additive — absent on every other reason)
    const { seq: seq2, emit: emit2 } = setup();
    const p2 = makeReplayProvider(chatFixture());
    await runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], provider: p2, emit: emit2, cost: makeCostEngine({ priceOf: p2.priceOf }), model: 'replay/model', agentId: 'a', runId: 'r2' });
    const cleanEnd = seq2.find(e => e.name === 'agent.run.end');
    A.eq(cleanEnd.payload.budgetScope, undefined, 'a clean done run omits budgetScope');
    A.eq(cleanEnd.payload.budgetCapUsd, undefined, 'a clean done run omits budgetCapUsd');
  }

  // ---- a permissive budget does not interfere; the loop returns total tokens (for the ledger) ----
  {
    const { emit } = setup();
    const provider = makeReplayProvider(chatFixture());
    let sawSpent = -1;
    const okBudget = { check: (spent) => { sawSpent = spent; return null; } };
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', agentId: 'a', runId: 'r', budget: okBudget });
    A.eq(res.reason, 'done', 'a permissive budget does not interfere');
    A.eq(sawSpent, 0, 'budget.check sees $0 spent before the first turn');
    A.eq(res.tokens, 15, 'the loop returns total tokens (10 in + 5 out) for the ledger');
  }

  // ---- auto-compaction: once the live prompt crosses the threshold, older turns fold into a summary; the tool
  //      turn-group is kept intact in the tail (pairing-safe) and one agent.compact is emitted ----
  {
    const { seq, emit } = setup();
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => 'wrote ' + a.path });
    const fixture = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"a.md","content":"x"}' }, { type: 'usage', usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'final' }, { type: 'usage', usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }, { type: 'done', finishReason: 'stop' }]
    ] };
    const provider = makeReplayProvider(fixture);
    const ctxMgr = makeContext({ contextLimit: 10, compactAt: 0.65, keepTail: 2 });   // 8 prompt tokens > 6.5 -> compact
    let summarizedOlder = null;
    const summarize = async (older) => { summarizedOlder = older; return 'SUMMARY'; };
    // the DIRECTIVE (the run's own request: the only user message) is pinned verbatim through a fold; the two earlier turns
    // after it are the foldable history
    const messages = [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'earlier context' }, { role: 'assistant', content: 'noted' }];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: [], dispatch: (c, ctx2) => reg.dispatch(c, ctx2), capCtx: openCtx(), context: ctxMgr, summarize });

    const comp = seq.filter(e => e.name === 'agent.compact');
    A.eq(comp.length, 1, 'exactly one agent.compact when the prompt crosses the threshold');
    // before/after are measured with the SAME estimator, so `removed` is a real saving. beforeTokens used to
    // be the provider's prompt_tokens while afterTokens was a local estimate — two units subtracted from each
    // other, which both fabricated the emitted `removed` and pinned `savings` near 1.0 so the anti-thrash
    // breaker ("two folds that each free <10% -> stop") could never fire.
    A.ok(typeof comp[0].payload.beforeTokens === 'number' && comp[0].payload.beforeTokens > 0, 'beforeTokens is a real estimate of the pre-fold prompt');
    A.ok(typeof comp[0].payload.afterTokens === 'number' && comp[0].payload.afterTokens >= 0, 'afterTokens is a real estimate');
    A.eq(comp[0].payload.removed, Math.max(0, comp[0].payload.beforeTokens - comp[0].payload.afterTokens),
      'removed is before-minus-after in ONE unit, not a subtraction across two');
    // NOTE: a fold can legitimately GROW a tiny history (the summary note outweighs the turn it replaced) —
    // that is precisely the low-savings case the anti-thrash breaker exists to notice, and it can only notice
    // it now that both ends are measured the same way. `removed` clamps at 0 so the event never reports a
    // negative saving.
    A.eq(comp[0].payload.reason, 'context', 'compaction reason tagged context');
    A.eq(res.reason, 'done', 'the run completes after compacting');
    A.eq(summarizedOlder.length, 2, 'the two earlier turns were folded; the directive and the assistant+tool group stayed verbatim');
    A.eq(messages[0], { role: 'user', content: 'do it' }, 'the directive is pinned byte-identical at the head');
    A.eq(messages[1].role, 'system', 'the summary note follows the pinned directive');
    A.ok(messages[1].content.indexOf('<conversation_summary>') === 0 && messages[1].content.indexOf('SUMMARY') >= 0, 'the summary was folded into the note');
  }

  // ---- compaction summarizer that REPORTS its own {usd,tokens} -> the spend folds into the run total (so the
  //      per-run + budget guards and the ledger see the summarizer's cost, not just at run end) ----
  {
    const { seq, emit } = setup();
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => 'wrote ' + a.path });
    const fixture = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"a.md","content":"x"}' }, { type: 'usage', usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'final' }, { type: 'usage', usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }, { type: 'done', finishReason: 'stop' }]
    ] };
    const provider = makeReplayProvider(fixture);
    const ctxMgr = makeContext({ contextLimit: 10, compactAt: 0.65, keepTail: 2 });
    const summarize = async () => ({ summary: 'SUMMARY', usd: 0.01, tokens: 50 });   // reports its own reconciled cost
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'earlier' }, { role: 'assistant', content: 'noted' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: [], dispatch: (c, ctx2) => reg.dispatch(c, ctx2), capCtx: openCtx(), context: ctxMgr, summarize });
    A.eq(seq.filter(e => e.name === 'agent.compact').length, 1, 'compaction happened');
    A.ok(res.usd > 0.009, "the summarizer's $0.01 folded into the run total (would be ~0 without the fold; got $" + res.usd + ')');
    A.eq(res.tokens, 62, "the summarizer's 50 tokens folded in on top of the 12 main-turn tokens");
  }

  // ---- a summarizer that returns EMPTY does not compact (never a silent context drop) and the run still finishes ----
  {
    const { seq, emit } = setup();
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => 'wrote ' + a.path });
    const fixture = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"a.md","content":"x"}' }, { type: 'usage', usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'final' }, { type: 'usage', usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }, { type: 'done', finishReason: 'stop' }]
    ] };
    const provider = makeReplayProvider(fixture);
    const ctxMgr = makeContext({ contextLimit: 10, compactAt: 0.65, keepTail: 2 });
    let called = 0;
    const summarize = async () => { called++; return ''; };   // degraded model
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'earlier' }, { role: 'assistant', content: 'noted' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: [], dispatch: (c, ctx2) => reg.dispatch(c, ctx2), capCtx: openCtx(), context: ctxMgr, summarize });
    A.eq(seq.filter(e => e.name === 'agent.compact').length, 0, 'empty summary -> no compaction');
    A.ok(called >= 1, 'the summarizer was attempted');
    A.eq(res.reason, 'done', 'the run still completes with the full (uncompacted) history');
  }

  // ---- no context manager -> compaction is a no-op (existing callers byte-identical) ----
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider(chatFixture());
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model' });
    A.eq(res.reason, 'done', 'no context manager -> normal completion');
    A.eq(seq.filter(e => e.name === 'agent.compact').length, 0, 'no agent.compact without a context manager');
  }

  // ---- todo re-injection: a compaction re-appends the active task plan so a long run keeps its list ----
  {
    const { seq, emit } = setup();
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => 'wrote ' + a.path });
    const fixture = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"a.md","content":"x"}' }, { type: 'usage', usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'final' }, { type: 'usage', usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }, { type: 'done', finishReason: 'stop' }]
    ] };
    const provider = makeReplayProvider(fixture);
    const ctxMgr = makeContext({ contextLimit: 10, compactAt: 0.65, keepTail: 2 });
    const messages = [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'earlier' }, { role: 'assistant', content: 'noted' }];   // directive pinned; two foldable turns
    let injectCalls = 0;
    const todoNote = () => { injectCalls++; return '[Your active task list was preserved across context compaction]\n- [>] 1. keep building (in_progress)'; };
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: [], dispatch: (c, ctx2) => reg.dispatch(c, ctx2), capCtx: openCtx(), context: ctxMgr, summarize: async () => 'SUMMARY', todoNote });
    A.eq(seq.filter(e => e.name === 'agent.compact').length, 1, 'compaction happened');
    A.ok(injectCalls >= 1, 'todoNote was consulted during the compaction');
    A.ok(messages.some(m => m.role === 'system' && m.content.indexOf('keep building') >= 0), 'the active task plan was re-appended after the compaction');
    A.eq(res.reason, 'done', 'the run completes with the plan re-injected');
  }

  // ---- no todoNote -> compaction is unchanged (existing callers byte-identical) ----
  {
    const { seq, emit } = setup();
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => 'wrote ' + a.path });
    const fixture = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"a.md","content":"x"}' }, { type: 'usage', usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'final' }, { type: 'usage', usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }, { type: 'done', finishReason: 'stop' }]
    ] };
    const provider = makeReplayProvider(fixture);
    const ctxMgr = makeContext({ contextLimit: 10, compactAt: 0.65, keepTail: 2 });
    const messages = [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'earlier' }, { role: 'assistant', content: 'noted' }];   // directive pinned; two foldable turns
    await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: [], dispatch: (c, ctx2) => reg.dispatch(c, ctx2), capCtx: openCtx(), context: ctxMgr, summarize: async () => 'SUMMARY' });
    A.eq(seq.filter(e => e.name === 'agent.compact').length, 1, 'compaction still happens without todoNote');
    A.ok(!messages.some(m => m.role === 'system' && /task list was preserved/.test(m.content)), 'no plan injected when todoNote is absent');
  }

  // ---- provider fallback: consume errorClass's shouldFallback/shouldRotateCredential to retry the turn ----
  {
    const httpErr = (s, m) => Object.assign(new Error('http ' + s + (m ? ' — ' + m : '')), { status: s });
    const okTurn = [{ type: 'text', delta: 'ok' }, { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }, { type: 'done', finishReason: 'stop' }];
    // ONE provider object (mirrors index.js: same provider + shared priceOf, alternate model). It throws the
    // configured error for a model, else streams a normal text turn — so a fallback to a healthy model recovers.
    function modelAware(failByModel) {
      let calls = 0;
      return {
        async *stream(req) { calls++; const e = failByModel[req.model]; if (e) throw e; for (const ev of okTurn) yield ev; },
        priceOf: () => ({ prompt: '0.000001', completion: '0.000002' }), contextLimit: () => 8000, callCount: () => calls, lastModel: () => null
      };
    }
    async function run(failByModel, fallbacks, extra) {
      const { seq, emit } = setup();
      const provider = modelAware(failByModel);
      const res = await runAgentLoop(Object.assign({
        messages: [{ role: 'user', content: 'hi' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
        model: 'm1', agentId: 'a', runId: 'r', fallbacks: (fallbacks || []).map(m => ({ provider, model: m }))
      }, extra || {}));
      return { seq, res, provider };
    }

    // overloaded primary -> fall back to a healthy model, run completes on it
    {
      const r = await run({ m1: httpErr(503, 'overloaded') }, ['m2']);
      A.eq(r.res.reason, 'done', '503 overloaded -> fell back and completed (not error)');
      A.eq(r.res.model, 'm2', 'loop result returns the actual fallback model used');
      A.eq(r.provider.callCount(), 2, 'one failed attempt + one fallback attempt');
      A.eq(r.seq.find(e => e.name === 'agent.cost').payload.model, 'm2', 'agent.cost reports the fallback model (the visible failover signal)');
      A.eq(r.seq.filter(e => e.name === 'agent.run.error').length, 0, 'no run.error when the fallback recovers');
    }
    // auth failure -> shouldRotateCredential also triggers a fallback
    {
      const r = await run({ m1: httpErr(401, 'bad key') }, ['m2']);
      A.eq(r.res.reason, 'done', '401 auth -> fell back and completed');
      A.eq(r.seq.find(e => e.name === 'agent.cost').payload.model, 'm2', 'auth fallback switched the model');
    }
    // chain exhausted: both models fail -> the run ends error, honestly transient
    {
      const r = await run({ m1: httpErr(503), m2: httpErr(503) }, ['m2']);
      A.eq(r.res.reason, 'error', 'exhausted chain -> error');
      A.eq(r.provider.callCount(), 8, 'primary, the one fallback, then 6 bounded same-provider retries before giving up');
      A.eq(r.seq.find(e => e.name === 'agent.run.error').payload.transient, true, '503 is transient');
    }
    // no fallback configured -> bounded same-provider retries ride out a transient overload before dying.
    // (The old assertion here — give up after ONE attempt — was the field failure that killed codex-only
    // runs at the first "servers overloaded" blip while every other harness rode it out.)
    {
      const r = await run({ m1: httpErr(503) }, []);
      A.eq(r.res.reason, 'error', 'no fallback + persistent 503 -> the run still ends error');
      A.eq(r.provider.callCount(), 7, '1 initial + 6 same-provider retries when there is no chain to burn');
    }
    // a NON-failover error (malformed 400) is fatal immediately — the chain is not burned on a client bug
    {
      const r = await run({ m1: httpErr(400, 'malformed') }, ['m2']);
      A.eq(r.res.reason, 'error', '400 -> fatal, not retried');
      A.eq(r.provider.callCount(), 1, 'fallback NOT consumed on a non-failover error');
      A.eq(r.seq.find(e => e.name === 'agent.run.error').payload.transient, false, '400 is not transient');
    }
    // context_overflow -> compress + retry the SAME turn (zero-config; uses the existing compaction), then succeed
    {
      const { seq, emit } = setup();
      let calls = 0;
      const provider = { async *stream() { calls++; if (calls === 1) throw new Error('prompt is too long'); for (const ev of okTurn) yield ev; },
        priceOf: () => ({ prompt: '0.000001', completion: '0.000002' }), contextLimit: () => 10 };
      const ctxMgr = makeContext({ contextLimit: 1000, compactAt: 0.65, keepTail: 1 });
      let summarized = 0;
      const res = await runAgentLoop({
        messages: [{ role: 'user', content: 'aaa' }, { role: 'assistant', content: 'bbb' }, { role: 'user', content: 'ccc' }],
        provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'm1', agentId: 'a', runId: 'r',
        context: ctxMgr, summarize: async () => { summarized++; return 'SUMMARY'; },
        // 'prompt is too long' classifies as context_overflow by its wording. The loop's window must be one the folded
        // prompt can FIT: the overflow recovery now verifies the fold got under it before re-sending (a 10-token
        // window here made the retry a certain second overflow, which the loop now refuses to send).
        approxTokens: 100, contextLimit: 1000
      });
      A.eq(res.reason, 'done', 'context_overflow -> compacted and retried to completion');
      A.eq(calls, 2, 'one overflow attempt + one post-compaction retry');
      A.ok(summarized >= 1, 'the summarizer ran as part of the overflow recovery');
      A.eq(seq.filter(e => e.name === 'agent.compact').length, 1, 'exactly one compaction during recovery');
    }
    // context_overflow AFTER the summarizer breaker tripped: used to be a dead run (compactionOff -> maybeCompact
    // false -> end 'error'). Now the no-LLM fallback fold shrinks the prompt and the retry proceeds to 'done'.
    {
      const { seq, emit } = setup();
      const reg = makeRegistry();
      reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async () => 'w' });   // tiny results: the free micro tier cannot shrink them, so the paid fold is attempted
      let calls = 0;
      const toolT = (id) => [{ type: 'tool_start', index: 0, id, name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"a.md","content":"x"}' }, { type: 'usage', usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } }, { type: 'done', finishReason: 'tool_calls' }];
      // the breaker trips on the proactive fold attempts before turns 1 and 2 (the preflight counts); the overflow then
      // lands on turn 2 while the older history is still unfolded, so the fallback fold has something to shrink
      const provider = { async *stream() { calls++; if (calls <= 1) { for (const ev of toolT('c' + calls)) yield ev; return; } if (calls === 2) throw new Error('prompt is too long'); for (const ev of okTurn) yield ev; },
        priceOf: () => ({ prompt: '0', completion: '0' }), contextLimit: () => 10 };
      const ctxMgr = makeContext({ contextLimit: 10, compactAt: 0.65, keepTail: 1 });   // 8 > 6.5 -> a proactive fold is attempted at the top of turns 1 and 2
      let attempts = 0;
      const summarize = async () => { attempts++; throw new Error('summarizer down'); };
      const res = await runAgentLoop({
        messages: [{ role: 'user', content: 'directive' }, { role: 'user', content: 'old-a ' + 'x'.repeat(3000) }, { role: 'assistant', content: 'old-b ' + 'y'.repeat(3000) }],   // real-sized history: the fallback digest must actually shrink it
        provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'm1', agentId: 'a', runId: 'r',
        tools: [], dispatch: (c, ctx2) => reg.dispatch(c, ctx2), capCtx: openCtx(),
        // the loop's window is one the fallback-folded prompt fits (the recovery verifies that before re-sending)
        context: ctxMgr, summarize, approxTokens: 100, contextLimit: 100000
      });
      A.eq(attempts, 2, 'the summarizer failed twice -> breaker tripped before the overflow');
      A.eq(res.reason, 'done', 'context_overflow after compactionOff no longer ends the run');
      A.eq(calls, 3, 'the overflowing turn was retried once after the fallback fold');
      const comps = seq.filter(e => e.name === 'agent.compact');
      A.ok(comps.length >= 1 && comps[comps.length - 1].payload.reason === 'fallback', 'the recovery fold is the deterministic fallback (' + comps.map(e => e.payload.reason).join(',') + ')');
      A.eq(seq.filter(e => e.name === 'agent.run.error').length, 0, 'no run error');
    }
  }

  // ---- no default iteration quota: productive work continues past the former 40-turn ceiling ----
  {
    const { emit } = setup();
    let ran = 0;
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async () => { ran++; return 'ok'; } });
    const turns = Array.from({ length: 45 }, (_, i) => [
      { type: 'tool_start', index: 0, id: 'c' + i, name: 'fs_write' },
      { type: 'tool_args', index: 0, chunk: JSON.stringify({ path: 'p' + i + '.md', content: 'x' }) },
      { type: 'done', finishReason: 'tool_calls' }
    ]);
    turns.push([{ type: 'text', delta: 'finished' }, { type: 'done', finishReason: 'stop' }]);
    const provider = makeReplayProvider({ turns });
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'do all 45 steps' }], provider, emit,
      cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model',
      dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx()
    });
    A.eq(res.reason, 'done', 'an uncapped run completes normally after more than forty productive turns');
    A.eq(ran, 45, 'all forty-five tool turns execute');
    A.eq(provider.callCount(), 46, 'the final synthesis call also runs after all forty-five tool turns');
  }

  // ---- unpriced usage evidence: a cold catalog does not pretend the model was free; the host can backfill later ----
  {
    const { emit } = setup();
    const provider = makeReplayProvider({ turns: [[
      { type: 'text', delta: 'hi' },
      { type: 'usage', usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } },
      { type: 'done', finishReason: 'stop' }
    ]] });
    provider.priceOf = () => null;
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'cold/model', agentId: 'a', runId: 'r' });
    A.eq(res.usd, 0, 'cold catalog run has no guessed usd inside the loop');
    A.eq(res.model, 'cold/model', 'loop result keeps the requested model identity');
    A.eq(res.unpricedUsage, [{ model: 'cold/model', tokensIn: 1000, tokensOut: 500 }], 'unpriced usage is returned for final backfill');
  }

  A.report('loop.replay.test');
})();
