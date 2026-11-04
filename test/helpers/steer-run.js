'use strict';
/* One run with SEND NOW notes, through the real owners (turn identity, commit 10). The host's steer buffer (sidecar/steer-buffer.js)
   holds the notes the page posted, the real loop (sidecar/loop.js) drains and folds them at its next message boundary, and the run's
   real transcript writer (sidecar/transcript-run.js, stamping every row) writes the dialogue into the store it is given, at the same
   boundaries index.js wires (onCheckpoint -> checkpoint, run end -> drain). Only the model is a script: each tool turn speaks and calls a
   tool (the tool is where the notes arrive, as they do in a live run), the last turn is the answer. */
const A = require('../_assert.js');
const events = require('../../shared/events.js');
const { makeEmitter } = require('../../shared/emitter.js');
const { makeCostEngine } = require('../../sidecar/cost.js');
const { runAgentLoop } = require('../../sidecar/loop.js');
const { makeReplayProvider } = require('../../sidecar/providers/replay.js');
const { makeRegistry } = require('../../sidecar/tools/registry.js');
const { makeSteerBuffers } = require('../../sidecar/steer-buffer.js');
const { makeRunTranscript } = require('../../sidecar/transcript-run.js');
const Kinds = require('../../frontend/app/turnkinds.js');

const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });

/* steeredLoop({ writer, messages, runId, agentId, notes: [{ text, noteId? }], lead?, reply?, tools?, buffers?, steer?, work? })
   -> { result, events, tokens, buffers }
   The loop over `messages` (already started on `writer`): notes are posted from inside the first tool, the way a page's POST
   /api/run/steer lands while the run works; `tools` is how many tool turns come before the answer (default 1); `work` (async) is the
   rest of what the tool does, where a test lets a channel follow-up arrive. `steer` replaces the loop's drain (a worker's
   generation-bound hook that returns strings); by default it is the host's own: buffers.drainNotes(runId). Nothing is drained at the
   end: the caller drains result.messages once (a run's host line may write its file rows first). `events` are the loop's agent.token and
   agent.tool_call events in order, as the wire would carry them. */
async function steeredLoop(o) {
  const runId = o.runId, agentId = o.agentId || 'agent', buffers = o.buffers || makeSteerBuffers({}), tools = Math.max(1, o.tools || 1);
  const bus = A.makeBus(), seq = A.collectBus(bus, events.names()), emit = makeEmitter(bus, () => {});
  const registry = makeRegistry();
  let calls = 0;
  registry.register({ impact: 'none', name: 'work_step', schema: { type: 'object', properties: {} },
    run: async () => {
      if (!calls++) { for (const n of o.notes || []) buffers.post(runId, n.text, true, n.noteId); if (typeof o.work === 'function') await o.work(buffers); }
      return 'worked';
    } });
  const turns = [];
  for (let i = 0; i < tools; i++) turns.push([{ type: 'text', delta: i ? 'Still on it.' : (o.lead || 'On it.') }, { type: 'tool_start', index: 0, id: 'call-' + runId + '-' + i, name: 'work_step' }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' }]);
  turns.push([{ type: 'text', delta: o.reply || 'Done.' }, { type: 'done', finishReason: 'stop' }]);
  const provider = makeReplayProvider({ turns });
  const result = await runAgentLoop({ messages: o.messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', agentId, runId,
    tools: [], limits: { maxIters: tools + 3, grace: false }, dispatch: (c, ctx) => registry.dispatch(c, ctx), capCtx: openCtx(),
    steer: typeof o.steer === 'function' ? o.steer : () => buffers.drainNotes(runId), steerClose: () => buffers.close(runId),
    onCheckpoint: ({ phase, messages: held }) => o.writer.checkpoint({ phase, messages: held }) });
  const wire = seq.filter(e => e.name === 'agent.token' || e.name === 'agent.tool_call').map(e => ({ name: e.name, payload: e.payload }));
  return { result, events: wire, tokens: wire.filter(e => e.name === 'agent.token').map(e => e.payload.delta), buffers };
}

/* steeredRun(store, { streamId, runId, directive, notes, … steeredLoop's options }) -> { result, tokens, events, buffers, turnId }
   One whole run on its own: the directive, the loop, the drain. */
async function steeredRun(store, o) {
  const runId = o.runId, streamId = o.streamId, agentId = o.agentId || 'agent', turnId = o.turnId || Kinds.runTurnId(runId);
  const writer = makeRunTranscript({ store, streamId, agentId, runId, turnId: () => turnId, stamp: true, onFailure: (_stage, error) => { throw error; } });
  const messages = [{ role: 'user', content: o.directive }];
  writer.setDirective(o.directive);
  store.markPersisted(messages);
  writer.start(messages);
  const out = await steeredLoop(Object.assign({}, o, { writer, messages, agentId }));
  writer.drain(out.result.messages);
  return Object.assign(out, { turnId });
}

module.exports = { steeredRun, steeredLoop };
