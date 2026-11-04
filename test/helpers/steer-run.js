'use strict';
/* One run with SEND NOW notes, through the real owners (turn identity, commit 10). The host's steer buffer (sidecar/steer-buffer.js)
   holds the notes the page posted, the real loop (sidecar/loop.js) drains and folds them at its next message boundary, and the run's
   real transcript writer (sidecar/transcript-run.js, stamping every row) writes the dialogue into the store it is given, at the same
   boundaries index.js wires (onCheckpoint -> checkpoint, run end -> drain). Only the model is a script: turn 1 speaks and calls a
   tool (the tool is where the notes arrive, as they do in a live run), turn 2 is the answer. */
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

/* steeredRun(store, { streamId, runId, directive, notes: [{ text, noteId? }], agentId?, turnId?, lead?, reply?, buffers?, steer?, work? })
   -> { result, tokens, buffers, turnId }
   notes are posted from inside the tool, the way a page's POST /api/run/steer lands while the run works; `work` (async) is the rest of
   what the tool does, where a test lets a channel follow-up arrive. `steer` replaces the loop's drain (a worker's generation-bound hook
   that returns strings); by default it is the host's own: buffers.drainNotes(runId). */
async function steeredRun(store, o) {
  const runId = o.runId, streamId = o.streamId, agentId = o.agentId || 'agent', turnId = o.turnId || Kinds.runTurnId(runId);
  const buffers = o.buffers || makeSteerBuffers({});
  const bus = A.makeBus(), seq = A.collectBus(bus, events.names()), emit = makeEmitter(bus, () => {});
  const writer = makeRunTranscript({ store, streamId, agentId, runId, turnId: () => turnId, stamp: true, onFailure: (_stage, error) => { throw error; } });
  const registry = makeRegistry();
  registry.register({ impact: 'none', name: 'work_step', schema: { type: 'object', properties: {} },
    run: async () => { for (const n of o.notes || []) buffers.post(runId, n.text, true, n.noteId); if (typeof o.work === 'function') await o.work(buffers); return 'worked'; } });
  const provider = makeReplayProvider({ turns: [
    [{ type: 'text', delta: o.lead || 'On it.' }, { type: 'tool_start', index: 0, id: 'call-' + runId, name: 'work_step' }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'text', delta: o.reply || 'Done.' }, { type: 'done', finishReason: 'stop' }]] });
  const messages = [{ role: 'user', content: o.directive }];
  writer.setDirective(o.directive);
  store.markPersisted(messages);
  writer.start(messages);
  const result = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', agentId, runId,
    tools: [], limits: { maxIters: 4, grace: false }, dispatch: (c, ctx) => registry.dispatch(c, ctx), capCtx: openCtx(),
    steer: typeof o.steer === 'function' ? o.steer : () => buffers.drainNotes(runId), steerClose: () => buffers.close(runId),
    onCheckpoint: ({ phase, messages: held }) => writer.checkpoint({ phase, messages: held }) });
  writer.drain(result.messages);
  return { result, tokens: seq.filter(e => e.name === 'agent.token').map(e => e.payload.delta), buffers, turnId };
}

module.exports = { steeredRun };
