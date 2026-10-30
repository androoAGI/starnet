/* node test/loop.grace-no-tools.test.js — the grace turn past the iteration cap never executes a tool.

   Audit probe (2026-09-22): maxIters 2 -> 3 dispatches, a file written past the cap, returned text "". The grace
   turn was tool-free only in its <iteration_limit> prose; tools stayed on the request (correctly — dropping them
   breaks providers whose history carries tool_use blocks) and whatever the model called was dispatched. This pins
   Hermes parity: calls emitted on the grace turn are dropped before the turn is persisted, never executed or
   announced, the model's text is the final answer, the transcript stays provider-valid, and the run ends
   max_iters — never 'done' — with or without text. A text-only grace turn still ends 'done' (grace.test.js).
   Scripted provider, no network, no sidecar. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { runAgentLoop } = require('../sidecar/loop.js');

const priceOf = () => ({ in: 1, out: 2 });
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
const WRITE_SCHEMA = { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } };
const TOOLS = [{ type: 'function', function: { name: 'fs_write', description: '', parameters: { type: 'object', properties: {} } } }];

function scripted(turns, inspect) {
  let calls = 0;
  return {
    async *stream(req) {
      const index = calls++;
      if (inspect) inspect(req, index);
      const turn = turns[index] || [{ type: 'done', finishReason: 'stop' }];
      for (const ev of turn) yield ev;
    },
    priceOf, contextLimit: () => 8000, callCount: () => calls
  };
}
const writeTurn = (i, text, rawArgs) => {
  const t = [];
  if (text) t.push({ type: 'text', delta: text });
  t.push({ type: 'tool_start', index: 0, id: 'w' + i, name: 'fs_write' });
  t.push({ type: 'tool_args', index: 0, chunk: rawArgs || JSON.stringify({ path: 'out/step' + i + '.js', content: 'step ' + i }) });
  t.push({ type: 'done', finishReason: 'tool_calls' });
  return t;
};
function pairedTranscript(messages) {
  const open = new Map();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) open.set(tc.id, (open.get(tc.id) || 0) + 1);
    if (m.role === 'tool') {
      if (!open.get(m.tool_call_id)) return false;
      open.set(m.tool_call_id, open.get(m.tool_call_id) - 1);
    }
  }
  return Array.from(open.values()).every(n => n === 0);
}

async function run(turns, extra) {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  const requests = [];
  const provider = scripted(turns, (req) => requests.push({ tools: (req.tools || []).length, messages: req.messages.slice() }));
  const writes = [];
  const reg = makeRegistry();
  reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => { writes.push(a.path); return 'wrote ' + a.path; } });
  const checkpoints = [];
  const messages = [{ role: 'user', content: 'build it' }];
  const res = await runAgentLoop(Object.assign({
    messages, provider, emit, cost: makeCostEngine({ priceOf }), model: 'm', agentId: 'a', runId: 'r',
    tools: TOOLS, limits: { maxIters: 2, verifyOnStop: false },
    dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(),
    onCheckpoint: (cp) => { checkpoints.push({ phase: cp.phase, messages: JSON.parse(JSON.stringify(cp.messages)) }); }
  }, extra || {}));
  return { res, seq, writes, requests, checkpoints, messages, provider };
}

(async () => {
  // ---- 1. THE AUDIT PROBE: cap 2, the model keeps writing -> exactly 2 dispatches, max_iters, grace text kept ----
  {
    const { res, seq, writes, requests, checkpoints, messages, provider } = await run([
      writeTurn(1), writeTurn(2), writeTurn(3, 'Best answer so far: steps 1 and 2 are written.')
    ]);
    A.eq(provider.callCount(), 3, 'the grace turn itself still happens (one model call past the cap)');
    A.eq(writes, ['out/step1.js', 'out/step2.js'], 'exactly 2 dispatches — nothing is written past the cap');
    A.eq(res.reason, 'max_iters', 'a grace turn that asked for tools ends max_iters, never done');
    A.eq(res.text, 'Best answer so far: steps 1 and 2 are written.', 'the grace turn\'s text is returned as the final answer');
    A.eq(seq.filter(e => e.name === 'agent.tool_call').length, 2, 'telemetry announces only the 2 real dispatches');
    A.ok(!seq.some(e => e.name === 'agent.tool_call' && e.payload.callId === 'w3'), 'the dropped grace call is never announced');
    A.eq(seq.filter(e => e.name === 'agent.run.end').map(e => e.payload.reason), ['max_iters'], 'agent.run.end says max_iters');
    A.ok(pairedTranscript(res.messages), 'the returned transcript is provider-valid (no unpaired tool_calls)');
    A.ok(!messages.some(m => Array.isArray(m.tool_calls) && m.tool_calls.some(tc => tc.id === 'w3')), 'the grace call never reaches the transcript');
    const last = messages[messages.length - 1];
    A.ok(last.role === 'assistant' && !last.tool_calls, 'the transcript ends on the plain grace answer');
    A.eq(requests[2] && requests[2].tools, 1, 'tools stay on the wire for the grace turn (provider-compatibility law)');
    A.ok(requests[2] && requests[2].messages.some(m => m.role === 'system' && /<iteration_limit>/.test(String(m.content))), 'the grace request carries the iteration-limit note');
    const lastCp = checkpoints[checkpoints.length - 1];
    A.ok(lastCp && lastCp.phase === 'assistant' && pairedTranscript(lastCp.messages), 'the durable checkpoint of the grace turn is provider-valid too');
  }

  // ---- 2. grace turn with calls and NO text -> still max_iters, empty text (never 'done' / 'empty') ----
  {
    const { res, writes } = await run([writeTurn(1), writeTurn(2), writeTurn(3)]);
    A.eq(writes.length, 2, 'no-text grace turn: still exactly 2 dispatches');
    A.eq(res.reason, 'max_iters', 'no-text grace turn ends max_iters');
    A.eq(res.text, '', 'with nothing to say, the returned text is honestly empty');
    A.ok(pairedTranscript(res.messages), 'and the transcript is still provider-valid');
  }

  // ---- 3. a CUT-OFF call on the grace turn is neither repaired, announced, nor run ----
  {
    const { res, seq, writes } = await run([writeTurn(1), writeTurn(2), writeTurn(3, 'Stopping here.', '{"path":"out/x.js","content":"par')]);
    A.eq(writes.length, 2, 'the truncated grace call does not run');
    A.eq(seq.filter(e => e.name === 'tool.args.repaired').length, 0, 'nothing is claimed repaired on the grace turn');
    A.eq(res.reason, 'max_iters', 'still max_iters');
  }

  // ---- 4. unchanged: a text-only grace turn delivers and ends done ----
  {
    const { res, writes } = await run([writeTurn(1), writeTurn(2), [{ type: 'text', delta: 'Here is the summary.' }, { type: 'done', finishReason: 'stop' }]]);
    A.eq(writes.length, 2, 'text-only grace: 2 dispatches');
    A.eq(res.reason, 'done', 'a tool-free grace answer still ends done');
    A.eq(res.text, 'Here is the summary.', 'with its text');
  }

  // ---- 5. unchanged: grace disabled -> hard stop at the cap, no third model call ----
  {
    const { res, writes, provider } = await run([writeTurn(1), writeTurn(2), writeTurn(3)], { limits: { maxIters: 2, grace: false, verifyOnStop: false } });
    A.eq(provider.callCount(), 2, 'grace:false -> no extra model call');
    A.eq(writes.length, 2, 'grace:false -> 2 dispatches');
    A.eq(res.reason, 'max_iters', 'grace:false -> max_iters');
  }

  A.report('loop.grace-no-tools.test');
})().catch(e => { console.log('FAIL: loop.grace-no-tools.test threw -- ' + (e && e.stack || e)); process.exit(1); });
