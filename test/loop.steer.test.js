/* node test/loop.steer.test.js — LIVE MID-RUN STEERING (slash-parity).
   Proves the additive `steer` hook: notes drained between iterations are injected as <steering_note> system
   messages BEFORE the next model call (at a message boundary, after tool results are paired), surface as an
   agent.token delta, never corrupt the assistant/tool interleave, and are fully inert when absent. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

const WRITE_SCHEMA = { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } };
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });

function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { bus, seq, emit };
}
// a two-turn fixture: turn 1 calls a tool, turn 2 stops. So the loop runs the steer drain once BEFORE turn 2.
function twoTurnFixture() {
  return { turns: [
    [{ type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"a.md","content":"x"}' }, { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }]
  ] };
}
function baseReg() { const reg = makeRegistry(); reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => 'wrote ' + a.path }); return reg; }

(async () => {
  // ---- a steered note lands as a <steering_note> system message before the NEXT model call, and pairing holds ----
  {
    const { seq, emit } = setup();
    const reg = baseReg();
    const provider = makeReplayProvider(twoTurnFixture());
    const messages = [{ role: 'user', content: 'go' }];
    let drained = 0;
    // drain the note exactly once (on the first drain call), so it must land before the 2nd model call.
    const steer = () => { if (drained++) return []; return ['prefer option B']; };
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: [], limits: { maxIters: 4, grace: false },
      dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(), steer });

    A.eq(res.reason, 'done', 'steered run completes cleanly (pairing never violated)');
    const note = messages.find(m => m.role === 'system' && /<steering_note>/.test(String(m.content)));
    A.ok(note, 'a <steering_note> system message was injected');
    A.ok(/prefer option B/.test(note.content), 'the note carries the Commander text');
    // PAIRING INVARIANT: every assistant tool_call is immediately followed by its tool result — the steer
    // injection (a system message at a loop boundary) never splits a tool_call from its result.
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'assistant' && messages[i].tool_calls && messages[i].tool_calls.length) {
        A.eq(messages[i + 1] && messages[i + 1].role, 'tool', 'each tool_call turn is immediately followed by its tool result');
      }
    }
    // the note is surfaced to the live transcript as a token delta so the Commander sees it land.
    const tok = seq.filter(e => e.name === 'agent.token' && /\[steering\]/.test(e.payload.delta || ''));
    A.eq(tok.length, 1, 'exactly one steering token delta surfaced');
  }

  // ---- a note queued AFTER the first tool result lands between the tool result and the next model call ----
  {
    const { emit } = setup();
    const reg = baseReg();
    const provider = makeReplayProvider(twoTurnFixture());
    const messages = [{ role: 'user', content: 'go' }];
    let calls = 0;
    // return the note only on the SECOND drain (i.e. at the top of iteration 2, after turn 1's tool result).
    const steer = () => { calls++; return calls === 2 ? ['now wrap up'] : []; };
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: [], limits: { maxIters: 4, grace: false },
      dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(), steer });
    A.eq(res.reason, 'done', 'mid-run steer completes cleanly');
    const note = messages.find(m => m.role === 'system' && /<steering_note>/.test(String(m.content)));
    A.ok(note, 'the mid-run note was injected');
    const noteIdx = messages.indexOf(note);
    const toolIdx = messages.findIndex(m => m.role === 'tool');
    A.ok(toolIdx >= 0 && noteIdx > toolIdx, 'a mid-run note lands AFTER the paired tool result, at the boundary');
  }

  // ---- multiple queued notes each become their own steering message, in order ----
  {
    const { emit } = setup();
    const reg = baseReg();
    const provider = makeReplayProvider(twoTurnFixture());
    const messages = [{ role: 'user', content: 'go' }];
    let drained = 0;
    const steer = () => { if (drained++) return []; return ['note one', 'note two']; };
    await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: [], limits: { maxIters: 4, grace: false },
      dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(), steer });
    const notes = messages.filter(m => m.role === 'system' && /<steering_note>/.test(String(m.content)));
    A.eq(notes.length, 2, 'each queued note becomes its own steering message');
    A.ok(/note one/.test(notes[0].content) && /note two/.test(notes[1].content), 'notes injected in order');
  }

  // ---- absent/empty steer is fully inert: byte-identical to a run with no hook at all ----
  {
    function run(steerOpt) {
      const { emit } = setup();
      const reg = baseReg();
      const provider = makeReplayProvider(twoTurnFixture());
      const messages = [{ role: 'user', content: 'go' }];
      const o = { messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
        model: 'replay/model', agentId: 'a', runId: 'r', tools: [], limits: { maxIters: 4, grace: false },
        dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx() };
      if (steerOpt) o.steer = steerOpt;
      return runAgentLoop(o).then(() => JSON.stringify(messages));
    }
    const noHook = await run(null);
    const emptyHook = await run(() => []);
    A.eq(noHook, emptyHook, 'an empty steer drain produces a byte-identical message list to no hook');
    A.ok(!/steering_note/.test(noHook), 'no steering note without a note to inject');
  }

  // ---- a whitespace-only note is skipped (no empty steering message) ----
  {
    const { emit } = setup();
    const reg = baseReg();
    const provider = makeReplayProvider(twoTurnFixture());
    const messages = [{ role: 'user', content: 'go' }];
    let drained = 0;
    const steer = () => { if (drained++) return []; return ['   ', '']; };
    await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: [], limits: { maxIters: 4, grace: false },
      dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(), steer });
    A.ok(!messages.some(m => /<steering_note>/.test(String(m.content))), 'blank notes never produce an empty steering message');
  }

  A.report('loop.steer.test');
})();
