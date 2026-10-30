/* node test/output-continuation.test.js — semantic max-output continuation, zero network.
   Proves bounded calls, transcript/stream de-duplication, cost accounting, partial-tool safety and cancellation. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const C = require('../sidecar/output-continuation.js');

const priceOf = () => ({ in: 1, out: 2 });
const makeCost = () => makeCostEngine({ priceOf });
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  return { bus, seq, emit: makeEmitter(bus, () => {}) };
}
function scripted(turns, inspect) {
  let calls = 0;
  return {
    async *stream(req) {
      const index = calls++;
      if (inspect) inspect(req, index);
      const turn = turns[index] || [{ type: 'done', finishReason: 'stop' }];
      for (const ev of turn) yield ev;
    },
    priceOf,
    contextLimit: () => 8000,
    callCount: () => calls
  };
}
const usage = (input, output) => ({ type: 'usage', usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } });

(async () => {
  // Pure overlap helper: remove only a meaningful suffix/prefix match and preserve chunk boundaries.
  {
    const r = C.novelText('The answer ends with repeated words.', 'repeated words. Then continues.');
    A.eq(r.text, ' Then continues.', 'a repeated tail is removed from the continuation');
    A.eq(C.novelChunks(['repeated ', 'words. Then ', 'continues.'], r.removed), [' Then ', 'continues.'], 'novel chunks retain provider boundaries after the overlap');
    A.eq(C.novelText('short tail', 'short next').text, 'short next', 'short incidental overlap is not stripped');
    A.eq(C.maxFor({}), 4, 'semantic continuation defaults to four additional calls');
    A.eq(C.maxFor({ outputContinuation: false }), 0, 'the continuation policy can be disabled explicitly');
  }

  // Text continuation: the model repeats its last phrase, but COMMS and the durable message get one coherent answer.
  {
    const { seq, emit } = setup();
    const provider = scripted([
      [{ type: 'text', delta: 'The answer ends with repeated words.' }, usage(10, 5), { type: 'done', finishReason: 'length' }],
      [{ type: 'text', delta: 'repeated ' }, { type: 'text', delta: 'words. Then ' }, { type: 'text', delta: 'continues.' }, usage(12, 4), { type: 'done', finishReason: 'stop' }]
    ]);
    const messages = [{ role: 'user', content: 'continue this' }];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCost(), model: 'm', agentId: 'a', runId: 'r' });
    const visible = seq.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('');
    A.eq(visible, 'The answer ends with repeated words. Then continues.', 'the live token stream contains no repeated tail');
    A.eq(messages.filter(m => m.role === 'assistant').length, 1, 'the multi-call answer is collapsed into one durable assistant turn');
    A.eq(messages.find(m => m.role === 'assistant').content, visible, 'durable transcript and visible stream are byte-identical');
    A.eq(provider.callCount(), 2, 'one semantic continuation call completed the answer');
    A.eq(res.reason, 'done', 'a completed continuation ends done');
    A.eq(res.finishReason, undefined, 'a later clean stop clears the prior length marker');
    A.eq(res.tokens, 31, 'usage from both paid calls is counted');
    A.ok(Math.abs(res.usd - 0.00004) < 1e-12, 'cost from both paid calls is reconciled');
    A.eq(seq.filter(e => e.name === 'agent.cost').length, 2, 'each paid continuation call emits reconciled cost');
  }

  // A provider may restart the complete response, not just its tail. The answer can be larger than
  // the bounded suffix scan and still must remain byte-identical across stream and transcript.
  {
    const { seq, emit } = setup();
    const block = 'A'.repeat(900) + 'B'.repeat(8124);
    const provider = scripted([
      [{ type: 'text', delta: block }, { type: 'done', finishReason: 'length' }],
      [{ type: 'text', delta: block }, { type: 'done', finishReason: 'stop' }]
    ]);
    const messages = [{ role: 'user', content: 'long answer' }];
    await runAgentLoop({ messages, provider, emit, cost: makeCost(), model: 'm', agentId: 'a', runId: 'r' });
    const visible = seq.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('');
    A.eq(visible.length, block.length, 'a full restart beyond the overlap window is not streamed twice');
    A.eq(messages.find(m => m.role === 'assistant').content, block, 'a full restart beyond the overlap window is not persisted twice');
  }

  // Bound: initial response + four continuations, then surface the still-incomplete length stop honestly.
  {
    const { emit } = setup();
    const turns = ['A', 'B', 'C', 'D', 'E'].map(x => [{ type: 'text', delta: x }, usage(1, 1), { type: 'done', finishReason: 'length' }]);
    const provider = scripted(turns);
    const messages = [{ role: 'user', content: 'never stop' }];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCost(), model: 'm', agentId: 'a', runId: 'r' });
    A.eq(provider.callCount(), 5, 'bounded: one initial call plus exactly four continuations');
    A.eq(res.reason, 'done', 'a non-empty capped partial remains a delivered-but-cut-short response');
    A.eq(res.finishReason, 'length', 'the exhausted semantic cap is surfaced honestly');
    A.eq(messages.filter(m => m.role === 'assistant').length, 1, 'all bounded partials collapse into one transcript turn');
    A.eq(messages.find(m => m.role === 'assistant').content, 'ABCDE', 'no partial segment is lost at the cap');
    A.eq(res.tokens, 10, 'every capped call contributes its usage');
  }

  // Partial tool call: do not repair or dispatch it; the next call must reissue a complete call.
  {
    const { seq, emit } = setup();
    const requests = [];
    const provider = scripted([
      [{ type: 'text', delta: 'Preparing the write. ' }, { type: 'tool_start', index: 0, id: 'partial', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"a.txt"' }, usage(3, 3), { type: 'done', finishReason: 'length' }],
      [{ type: 'tool_start', index: 0, id: 'complete', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"a.txt","content":"ok"}' }, usage(4, 2), { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'Written.' }, usage(5, 1), { type: 'done', finishReason: 'stop' }]
    ], (req) => requests.push(req.messages.map(m => ({ role: m.role, content: m.content }))));
    let ran = 0;
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'fs_write', schema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } }, run: async (args) => { ran++; return 'wrote ' + args.path + ':' + args.content; } });
    const messages = [{ role: 'user', content: 'write it' }];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCost(), model: 'm', agentId: 'a', runId: 'r',
      tools: [{ type: 'function', function: { name: 'fs_write', parameters: {} } }], dispatch: (call, ctx) => reg.dispatch(call, ctx), capCtx: openCtx() });
    A.eq(ran, 1, 'only the completely reissued tool call is dispatched');
    A.eq(seq.filter(e => e.name === 'tool.args.repaired').length, 0, 'the cut-off argument string never enters repair');
    A.eq(seq.filter(e => e.name === 'agent.tool_call').length, 1, 'telemetry claims exactly one real tool dispatch');
    A.ok(requests[1].some(m => /NOT executed/.test(String(m.content || ''))), 'the continuation prompt tells the model the partial call was not executed');
    A.ok(!messages.some(m => m.tool_calls && m.tool_calls.some(c => c.id === 'partial')), 'the partial tool call is absent from the replayable transcript');
    A.eq(res.reason, 'done', 'the reissued complete call and final answer finish normally');
  }

  // A TOO-LARGE tool call (2026-10-11): the same oversized fs_write cut off again and again never ran and the run ended
  // a bare 'empty'. Each cut now tells the model to SPLIT using the write tools it has; after TOOL_CUT_MAX (2) nudges
  // the run ends 'error' saying exactly why nothing was written.
  {
    const { seq, emit } = setup();
    const requests = [];
    const cut = [{ type: 'tool_start', index: 0, id: 'big', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"page.html","content":"<html>' }, usage(3, 3), { type: 'done', finishReason: 'length' }];
    const provider = scripted([cut, cut, cut, cut, cut], (req) => requests.push(req.messages.map(m => String(m.content || '')).join('\n')));
    let ran = 0;
    const cutMessages = [{ role: 'user', content: 'write a big page' }];
    const res = await runAgentLoop({ messages: cutMessages, provider, emit, cost: makeCost(), model: 'm', agentId: 'a', runId: 'r',
      tools: [{ type: 'function', function: { name: 'fs.write', parameters: {} } }, { type: 'function', function: { name: 'fs.append', parameters: {} } }],
      dispatch: async () => { ran++; return { ok: true, isError: false, content: 'ok' }; }, capCtx: openCtx() });
    A.eq(ran, 0, 'a cut-off call is never dispatched');
    A.eq(provider.callCount(), 3, 'initial cut + exactly two split nudges, not four blind reissues');
    A.ok(/too large to fit in one reply/.test(requests[1]) && /fs_append/.test(requests[1]), 'the first nudge says split it, naming fs_append (a tool this run has)');
    A.ok(/cut off 2 times in a row/.test(requests[2]), 'the second nudge says the same oversized call was cut off again');
    // review threads-backend-09: one directive, never "reissue the complete call" next to "do NOT re-send it whole"
    A.ok(!/Reissue the complete tool call/i.test(requests[1]), 'the cut nudge never asks for the same oversized call again');
    A.ok(/Do NOT re-send it whole[^]*<\/output_continuation>/.test(requests[1]), 'the split advice sits inside the continuation tag');
    A.eq(res.reason, 'error', 'the run does not pass off a never-written file as done or a bare empty');
    A.eq(res.failureCode, 'output_limit_tool_cut', 'durable failure code names the cause');
    const err = seq.find(e => e.name === 'agent.run.error');
    A.ok(err && /hit the model's output limit while writing a large fs_write call/.test(err.payload.message), 'the user-facing stop says exactly what happened');
    A.ok(err && /smaller parts/.test(err.payload.message), 'and what to do');
    // review threads-backend-10: the explanation persisted into the tail turn is streamed too, so live COMMS and a
    // reloaded transcript show the same message
    const streamed = seq.filter(e => e.name === 'agent.token' && /hit the model's output limit/.test(e.payload.delta));
    A.eq(streamed.length, 1, 'one agent.token carries the explanation');
    const tail = cutMessages[cutMessages.length - 1];
    A.ok(tail && tail.role === 'assistant' && streamed.length === 1 && String(tail.content).endsWith(streamed[0].payload.delta), 'the persisted tail turn ends with exactly the streamed text');
  }
  // …and when the model DOES split after the first cut, the work lands normally.
  {
    const { emit } = setup();
    const cut = [{ type: 'tool_start', index: 0, id: 'big', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"page.html","content":"<html>' }, usage(3, 3), { type: 'done', finishReason: 'length' }];
    const part = (id, name) => [{ type: 'tool_start', index: 0, id, name }, { type: 'tool_args', index: 0, chunk: '{"path":"page.html","content":"x"}' }, usage(3, 3), { type: 'done', finishReason: 'tool_calls' }];
    const provider = scripted([cut, part('p1', 'fs_write'), part('p2', 'fs_append'), [{ type: 'text', delta: 'Wrote page.html in two parts.' }, usage(1, 1), { type: 'done', finishReason: 'stop' }]]);
    let ran = 0;
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'write a big page' }], provider, emit, cost: makeCost(), model: 'm', agentId: 'a', runId: 'r',
      tools: [{ type: 'function', function: { name: 'fs_write', parameters: {} } }, { type: 'function', function: { name: 'fs_append', parameters: {} } }],
      dispatch: async () => { ran++; return { ok: true, isError: false, content: 'ok' }; }, capCtx: openCtx() });
    A.eq(ran, 2, 'both split writes ran');
    A.eq(res.reason, 'done', 'a split write finishes normally');
  }

  // Policy stops are terminal, never continued.
  {
    const { emit } = setup();
    const provider = scripted([[{ type: 'text', delta: 'blocked fragment' }, usage(2, 1), { type: 'done', finishReason: 'content_filter' }]]);
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: makeCost(), model: 'm', agentId: 'a', runId: 'r' });
    A.eq(provider.callCount(), 1, 'content-filter stop makes no continuation call');
    A.eq(res.finishReason, 'content_filter', 'the policy stop remains visible at run end');
  }

  // Wave-2 seam: the optional checkpoint is awaited after assistant append and after tool-result append.
  {
    const { emit } = setup();
    const provider = scripted([
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'read_one' }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }]
    ]);
    const order = [];
    let assistantDurable = false;
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'read_one', schema: { type: 'object', properties: {} }, run: async () => {
      A.eq(assistantDurable, true, 'the assistant checkpoint promise settled before tool dispatch');
      order.push('dispatch');
      return 'one';
    } });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'read' }], provider, emit, cost: makeCost(), model: 'm', agentId: 'a', runId: 'r',
      tools: [{ type: 'function', function: { name: 'read_one', parameters: {} } }], dispatch: (call, ctx) => reg.dispatch(call, ctx), capCtx: openCtx(),
      onCheckpoint: async ({ phase, messages }) => {
        await new Promise(resolve => setTimeout(resolve, 0));
        A.ok(Array.isArray(messages) && messages.length >= 2, 'checkpoint receives the current messages');
        order.push(phase);
        if (phase === 'assistant') assistantDurable = true;
      }
    });
    A.eq(order, ['assistant', 'dispatch', 'tool_results', 'assistant'], 'checkpoint order brackets dispatch and includes the final assistant');
    A.eq(res.reason, 'done', 'the awaited checkpoint seam does not change the run outcome');
  }

  // Abort during a continuation: flush the novel partial, do not count usage that never arrived, and stop cleanly.
  {
    const { seq, emit } = setup();
    const signal = { aborted: false };
    let calls = 0;
    const provider = {
      async *stream() {
        calls++;
        if (calls === 1) {
          yield { type: 'text', delta: 'First complete repeated fragment. ' };
          yield usage(10, 5);
          yield { type: 'done', finishReason: 'length' };
          return;
        }
        yield { type: 'text', delta: 'repeated fragment. Novel partial' };
        signal.aborted = true;
        yield { type: 'done', finishReason: 'stop' };
      }, priceOf, contextLimit: () => 8000
    };
    const messages = [{ role: 'user', content: 'x' }];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCost(), model: 'm', agentId: 'a', runId: 'r', signal });
    A.eq(res.reason, 'cancelled', 'abort during semantic continuation ends cancelled');
    A.eq(res.tokens, 15, 'only the first call with reported usage is charged');
    A.eq(seq.filter(e => e.name === 'agent.cost').length, 1, 'the aborted call emits no invented cost event');
    const visible = seq.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('');
    A.eq(visible, 'First complete repeated fragment. Novel partial', 'the buffered continuation partial is visible on cancel without duplicating the repeated suffix');
    A.eq(messages.filter(m => m.role === 'assistant').length, 1, 'cancelled continuation parts collapse into one durable assistant turn');
    A.eq(messages.find(m => m.role === 'assistant').content, visible, 'cancelled durable transcript and visible stream are byte-identical');
    A.eq(messages.some(m => m.role === 'system' && /output_continuation/.test(String(m.content || ''))), false, 'the internal continuation prompt is removed on cancellation');
  }

  A.report('output-continuation.test');
})();
