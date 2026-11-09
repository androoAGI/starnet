/* node test/loop.batch-order.test.js — A HOST-CHOSEN RUN ORDER FOR A SEQUENTIAL BATCH (cost audit W1.2, 2026-11-08).

   The Task Brief gate reads state that another call in the SAME batch changes, so the order a model listed its calls in one
   response decided whether its write was held (and paid for again on the next request). loop.js now runs a sequential
   batch in the order the host injects (o.batchOrder; index.js wires TaskBriefPolicy.settleFirst). These pin the loop half:
   the injected order is what runs, the model's view never moves (assistant turn and tool results stay in listed order,
   visible tool events too), anything that is not an exact permutation falls back to the listed order, no injected order is
   byte-identical to before, and a parallel batch has no order to choose. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop, _internals } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
const SCHEMA = { type: 'object', properties: { path: { type: 'string' } } };

// One turn that calls `names` together (ids c0..cN in listed order), then a turn that stops.
function batchFixture(names) {
  const turn = [];
  names.forEach((n, i) => {
    turn.push({ type: 'tool_start', index: i, id: 'c' + i, name: n });
    turn.push({ type: 'tool_args', index: i, chunk: JSON.stringify({ path: 'f' + i }) });
  });
  turn.push({ type: 'done', finishReason: 'tool_calls' });
  return { turns: [turn, [{ type: 'text', delta: 'ok' }, { type: 'done', finishReason: 'stop' }]] };
}
// settle unlocks work_x (a stand-in for brief_proceed and a gated write); read_a / read_b are plain reads
function registry(ran, state) {
  const reg = makeRegistry();
  reg.register({ impact: 'none', name: 'settle', schema: SCHEMA, run: async () => { ran.push('settle'); state.settled = true; return 'settled'; } });
  reg.register({ impact: 'none', name: 'work_x', schema: SCHEMA, run: async () => { ran.push('work_x'); if (!state.settled) throw new Error('held: settle first'); return 'worked'; } });
  reg.register({ impact: 'none', name: 'pause', schema: SCHEMA, run: async () => { ran.push('pause'); return { content: 'paused', control: { final: true, reason: 'done', text: 'PAUSED' } }; } });
  for (const n of ['read_a', 'read_b']) reg.register({ impact: 'none', name: n, schema: SCHEMA, run: async () => { ran.push(n); return n; } });
  return reg;
}
async function run(o) {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  const provider = makeReplayProvider(o.fixture);
  const ran = [];
  const state = { settled: false };
  const reg = registry(ran, state);
  const res = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], provider, emit,
    cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: 'a', runId: 'r', tools: [],
    limits: { maxIters: 5, grace: false },
    dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(),
    clock: { now: () => Date.now() },
    hiddenTools: o.hiddenTools || [],
    parallelSafe: o.parallelSafe,
    batchOrder: o.batchOrder
  });
  return { res, seq, ran };
}
const settleFirst = calls => calls.filter(c => c.name === 'settle').concat(calls.filter(c => c.name !== 'settle'));
const toolIds = res => res.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id).join(',');
const toolText = (res, id) => String((res.messages.find(m => m.role === 'tool' && m.tool_call_id === id) || {}).content || '');
const callIds = res => ((res.messages.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls)) || {}).tool_calls || []).map(c => c.id).join(',');
const evIds = (seq, type) => seq.filter(e => e.name === type).map(e => e.payload.callId).join(',');

(async () => {
  // ---- 1. THE INJECTED ORDER RUNS; THE MODEL'S VIEW NEVER MOVES ----
  {
    const { res, seq, ran } = await run({ fixture: batchFixture(['work_x', 'read_a', 'settle']), batchOrder: settleFirst, hiddenTools: ['settle'] });
    A.eq(res.reason, 'done', 'the run completes normally');
    A.eq(ran.join(','), 'settle,work_x,read_a', 'the settle ran first, then the rest in listed order');
    A.eq(toolText(res, 'c0'), 'worked', 'so the call it unlocks went through in the SAME turn (no held retry)');
    A.eq(callIds(res), 'c0,c1,c2', 'the assistant turn keeps its calls exactly as the model listed them');
    A.eq(toolIds(res), 'c0,c1,c2', 'the tool results are appended in the listed order, not the run order');
    A.eq(evIds(seq, 'agent.tool_call'), 'c0,c1', 'visible calls are announced in listed order (the hidden settle draws nothing)');
    A.eq(evIds(seq, 'agent.tool_result'), 'c0,c1', 'visible results are reported in listed order');
  }

  // ---- 2. NO INJECTED ORDER = the listed order, byte-identical to before (the held write the audit measured) ----
  {
    const { res, ran } = await run({ fixture: batchFixture(['work_x', 'settle']) });
    A.eq(ran.join(','), 'work_x,settle', 'with no batchOrder the batch runs as listed');
    A.ok(/held: settle first/.test(toolText(res, 'c0')), 'and the write listed first is held, as on e316231d7');
    A.eq(toolIds(res), 'c0,c1', 'results in listed order');
  }

  // ---- 3. ANYTHING BUT AN EXACT PERMUTATION FALLS BACK TO THE LISTED ORDER (never drops, adds or repeats a call) ----
  {
    const bad = {
      'drops a call': calls => calls.slice(1),
      'repeats a call': calls => [calls[1], calls[1]],
      'invents a call': calls => [calls[1], Object.assign({}, calls[0])],
      'is not an array': () => 'settle first',
      'throws': () => { throw new Error('order boom'); }
    };
    for (const [why, fn] of Object.entries(bad)) {
      const { res, ran } = await run({ fixture: batchFixture(['work_x', 'settle']), batchOrder: fn });
      A.eq(ran.join(','), 'work_x,settle', 'an order that ' + why + ' is ignored: the listed order runs');
      A.eq(toolIds(res), 'c0,c1', 'an order that ' + why + ': every call still has exactly one paired result');
      A.eq(res.reason, 'done', 'an order that ' + why + ': the run is unharmed');
    }
  }

  // ---- 4. A FINAL CONTROL STOPS THE REST IN RUN ORDER; the skipped calls still pair, in listed order ----
  {
    const pauseFirst = calls => calls.filter(c => c.name === 'pause').concat(calls.filter(c => c.name !== 'pause'));
    const { res, ran } = await run({ fixture: batchFixture(['work_x', 'pause']), batchOrder: pauseFirst });
    A.eq(ran.join(','), 'pause', 'the pause ran first and nothing ran after it');
    A.ok(/^ERROR: skipped: the Task Brief paused/.test(toolText(res, 'c0')), 'the call after it is skipped, not run: ' + toolText(res, 'c0'));
    A.eq(toolIds(res), 'c0,c1', 'results still pair in the listed order');
  }

  // ---- 5. A PARALLEL BATCH HAS NO ORDER TO CHOOSE: the hook is never consulted ----
  {
    let asked = 0;
    const { res } = await run({ fixture: batchFixture(['read_a', 'read_b']), parallelSafe: n => /^read_/.test(n), batchOrder: c => { asked++; return c.slice().reverse(); } });
    A.eq(asked, 0, 'an all-safe concurrent batch never asks for a run order');
    A.eq(toolIds(res), 'c0,c1', 'and still reports in listed order');
  }

  // ---- 6. the pure helpers, directly ----
  {
    const { batchRunOrder, inCallOrder } = _internals;
    const c = (id) => ({ id, name: id });
    const calls = [c('a'), c('b'), c('c')];
    A.ok(batchRunOrder(calls, null) === calls, 'no hook: the listed array');
    A.ok(batchRunOrder([c('x')], () => []) .length === 1, 'a single call is never reordered');
    A.eq(batchRunOrder(calls, l => [l[2], l[0], l[1]]).map(x => x.id).join(','), 'c,a,b', 'an exact permutation is accepted');
    A.ok(batchRunOrder(calls, l => l) === calls, 'the same array back: the listed array');
    A.eq(inCallOrder([{ callId: 'c' }, { callId: 'a' }, { callId: 'b' }], calls).map(r => r.callId).join(','), 'a,b,c', 'results sort back to the listed order');
  }

  A.report('loop.batch-order.test');
})().catch(e => { console.log('FAIL: loop.batch-order.test threw -- ' + (e && e.stack || e)); process.exit(1); });
