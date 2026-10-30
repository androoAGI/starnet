/* node test/loop.parallel-tools.test.js — CONCURRENT TOOL BATCHES.

   A model that asks to read four files in one turn used to wait four round trips for them; the batch could
   have taken as long as its slowest member. These assertions pin the three things that make the optimization
   safe rather than merely fast: an all-or-nothing safety rule, an EMIT STREAM that stays in call order even
   though the work does not, and byte-identical behavior everywhere the rule says no. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop, _internals } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
const SCHEMA = { type: 'object', properties: { ms: { type: 'number' }, path: { type: 'string' } } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// One turn that calls `names` together, then a turn that stops.
function batchFixture(names) {
  const turn = [];
  names.forEach((n, i) => {
    turn.push({ type: 'tool_start', index: i, id: 'c' + i, name: n });
    turn.push({ type: 'tool_args', index: i, chunk: JSON.stringify({ ms: 60, path: 'f' + i }) });
  });
  turn.push({ type: 'done', finishReason: 'tool_calls' });
  return { turns: [turn, [{ type: 'text', delta: 'ok' }, { type: 'done', finishReason: 'stop' }]] };
}
function registry(order, overlap) {
  const reg = makeRegistry();
  const slow = (name) => async (a) => {
    overlap.active++;
    overlap.max = Math.max(overlap.max, overlap.active);
    try { await sleep(Number(a.ms) || 50); order.push(name); return name + ':' + a.path; }
    finally { overlap.active--; }
  };
  for (const n of ['read_a', 'read_b', 'read_c', 'write_x']) reg.register({ impact: 'none', name: n, schema: SCHEMA, run: slow(n) });
  return reg;
}
async function run(o) {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  const provider = makeReplayProvider(o.fixture);
  const order = [];
  const overlap = { active: 0, max: 0 };
  const reg = registry(order, overlap);
  const res = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], provider, emit,
    cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: 'a', runId: 'r', tools: [],
    limits: { maxIters: 5, grace: false },
    dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(),
    clock: { now: () => Date.now() },
    parallelSafe: o.parallelSafe
  });
  return { res, seq, order, maxInFlight: overlap.max };
}
const namesOf = (seq, type) => seq.filter(e => e.name === type).map(e => e.payload.callId);

(async () => {
  const readsOnly = (n) => /^read_/.test(n);

  // ---- 1. AN ALL-SAFE BATCH OVERLAPS. Observe active work, not wall time on a busy host. ----
  {
    const { res, maxInFlight } = await run({ fixture: batchFixture(['read_a', 'read_b', 'read_c']), parallelSafe: readsOnly });
    A.eq(res.reason, 'done', 'the run completes normally');
    A.eq(maxInFlight, 3, 'all three read-only calls are in flight together');
  }

  // ---- 2. THE EMIT STREAM STAYS IN CALL ORDER even though the work finished out of order. ----
  {
    // c0 is the SLOWEST, so completion order is the reverse of call order.
    const f = { turns: [[
      { type: 'tool_start', index: 0, id: 'c0', name: 'read_a' }, { type: 'tool_args', index: 0, chunk: '{"ms":90,"path":"a"}' },
      { type: 'tool_start', index: 1, id: 'c1', name: 'read_b' }, { type: 'tool_args', index: 1, chunk: '{"ms":40,"path":"b"}' },
      { type: 'tool_start', index: 2, id: 'c2', name: 'read_c' }, { type: 'tool_args', index: 2, chunk: '{"ms":5,"path":"c"}' },
      { type: 'done', finishReason: 'tool_calls' }
    ], [{ type: 'text', delta: 'ok' }, { type: 'done', finishReason: 'stop' }]] };
    const { seq, order, res } = await run({ fixture: f, parallelSafe: readsOnly });
    A.eq(order.join(','), 'read_c,read_b,read_a', 'the WORK really did finish out of order (proof the batch overlapped)');
    A.eq(namesOf(seq, 'agent.tool_call').join(','), 'c0,c1,c2', 'every call is announced in call order');
    A.eq(namesOf(seq, 'agent.tool_result').join(','), 'c0,c1,c2', 'results are REPORTED in call order, not completion order');
    // The transcript the model sees must also pair in call order.
    const toolMsgs = res.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id);
    A.eq(toolMsgs.join(','), 'c0,c1,c2', 'the tool_result messages are appended in call order');
  }

  // ---- 3. ONE UNSAFE CALL SENDS THE WHOLE BATCH DOWN THE SEQUENTIAL PATH ----
  {
    const { order, maxInFlight } = await run({ fixture: batchFixture(['read_a', 'write_x', 'read_b']), parallelSafe: readsOnly });
    A.eq(order.join(','), 'read_a,write_x,read_b', 'a mixed batch runs strictly in order');
    A.eq(maxInFlight, 1, 'a mixed batch has only one active call');
  }

  // ---- 4. NO PREDICATE = the old behavior, byte-identical. Every existing caller lands here. ----
  {
    const { order, maxInFlight } = await run({ fixture: batchFixture(['read_a', 'read_b', 'read_c']) });
    A.eq(order.join(','), 'read_a,read_b,read_c', 'with no parallelSafe injected the batch stays sequential');
    A.eq(maxInFlight, 1, 'with no predicate only one call is active');
  }

  // ---- 5. the pure planner, directly ----
  {
    const { parallelizable } = _internals;
    const call = (name, extra) => Object.assign({ id: name, name, args: {}, argsRaw: '{}', parseError: null }, extra || {});
    A.eq(parallelizable([call('read_a'), call('read_b')], readsOnly), true, 'two safe calls parallelize');
    A.eq(parallelizable([call('read_a')], readsOnly), false, 'a single call is never worth a batch');
    A.eq(parallelizable([call('read_a'), call('write_x')], readsOnly), false, 'one unsafe member disqualifies the batch');
    A.eq(parallelizable([call('read_a'), call('read_b')], null), false, 'no predicate -> never parallel');
    A.eq(parallelizable([call('read_a'), call('read_b', { parseError: 'bad json' })], readsOnly), false,
      'a call with broken arguments keeps the whole batch on the simple path');
  }

  A.report('loop.parallel-tools.test');
})().catch(e => { console.log('FAIL: loop.parallel-tools.test threw -- ' + (e && e.stack || e)); process.exit(1); });
