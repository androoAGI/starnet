/* node test/steer.final-stream.test.js — A STEER DURING THE FINAL ANSWER IS NOT DROPPED (h1 audit 2026-09-22).

   The probe: POST /api/run/steer accepted a note (and the UI said "it will fold your note in on its next step") while
   the model streamed its FINAL, tool-free answer; the loop drained steers only at the top of an iteration, so the run
   ended with the note still buffered and teardown console-logged it away. Proves, with the host's REAL buffer module
   (sidecar/steer-buffer.js, what index.js's handleRunSteer/drainSteer/closeSteer call) and the real loop:
     1. a note posted mid-final-stream is folded in (same <steering_note> + '[steering]' token as the top-of-loop drain)
        and the model gets ONE more turn whose request contains it; then the run ends 'done';
     2. bounded: a note during every final answer extends at most STEER_EXT_MAX (2) times; the leftover is named in the
        transcript as NOT applied instead of vanishing;
     3. never on a cancelled run, never on the contracted-tool-free grace turn, off with limits.steerExtend:false;
     4. after the loop has ended, the endpoint's answer is an honest non-success (409 ok:false applied:false; 404 after
        teardown) while the in-flight success shape {ok:true, pending} is unchanged.
   Zero network: a hand-rolled streaming provider; sub-second real waits only. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeSteerBuffers } = require('../sidecar/steer-buffer.js');

const priceOf = () => ({ in: 1, out: 2 });
const tick = (ms) => new Promise(r => setTimeout(r, ms || 5));
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { seq, emit };
}
// A provider whose turns are async generators; each request's messages are captured (a deep copy) for assertions.
function streamingProvider(turnFns) {
  const requests = [];
  let n = 0;
  return {
    requests,
    priceOf, contextLimit: () => 0,
    stream(req) {
      requests.push(JSON.parse(JSON.stringify(req.messages || [])));
      const fn = turnFns[Math.min(n, turnFns.length - 1)];
      n++;
      return fn(req, n);
    }
  };
}
const hasNote = (msgs, text) => msgs.some(m => m.role === 'system' && String(m.content) === '<steering_note>' + text + '</steering_note>');
// a host-shaped harness: a runs registry + the real buffer module wired exactly as index.js wires it
function host(runId) {
  const runs = new Set([runId]);
  const bufs = makeSteerBuffers({ maxPending: 8, maxNoteChars: 2000 });
  return {
    runs, bufs,
    post: (text) => bufs.post(runId, text, runs.has(runId)),
    loopOpts: { steer: () => bufs.drain(runId), steerClose: () => bufs.close(runId) },
    teardown: () => { runs.delete(runId); return bufs.drop(runId); }
  };
}

(async () => {
  // ---- 1. a steer posted WHILE the final answer streams gets another turn whose request carries the note ----
  {
    const { seq, emit } = setup();
    const h = host('r1');
    let postedDuringStream = null;
    const provider = streamingProvider([
      async function* () {                      // turn 1: the FINAL, tool-free answer, streamed slowly
        yield { type: 'text', delta: 'The report is in ' };
        await tick(10);
        postedDuringStream = h.post('use metric units');   // the Commander steers mid-stream
        yield { type: 'text', delta: 'imperial units.' };
        yield { type: 'done', finishReason: 'stop' };
      },
      async function* () {                      // turn 2: the model answers the note
        yield { type: 'text', delta: 'Converted: the report is now in metric units.' };
        yield { type: 'done', finishReason: 'stop' };
      }
    ]);
    const messages = [{ role: 'user', content: 'write the report' }];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf }), model: 'm', agentId: 'a', runId: 'r1',
      tools: [], limits: { grace: false }, capCtx: openCtx(), ...h.loopOpts });
    A.eq(postedDuringStream, { status: 200, body: { ok: true, pending: 1 } }, 'the in-flight steer got the UNCHANGED success shape');
    A.eq(provider.requests.length, 2, 'the model got exactly one more turn');
    A.ok(!hasNote(provider.requests[0], 'use metric units'), 'the first request did not have the note (it arrived mid-stream)');
    A.ok(hasNote(provider.requests[1], 'use metric units'), 'the NEXT request the model received contains the <steering_note>');
    const lastReq = provider.requests[1];
    const noteIdx = lastReq.findIndex(m => m.role === 'system' && /steering_note/.test(String(m.content)));
    A.ok(noteIdx > 0 && lastReq[noteIdx - 1].role === 'assistant' && /imperial/.test(String(lastReq[noteIdx - 1].content)), 'the note follows the streamed final answer at a message boundary');
    A.eq(res.reason, 'done', 'then the run ends done');
    A.ok(/metric units/.test(res.text), "the run's terminal text is the steered answer");
    const tok = seq.filter(e => e.name === 'agent.token' && /\[steering\] use metric units/.test(e.payload.delta || ''));
    A.eq(tok.length, 1, 'the same [steering] token telemetry as the top-of-loop drain surfaced once');
    A.ok(!seq.some(e => e.name === 'agent.token' && /NOT applied/.test(e.payload.delta || '')), 'nothing is reported as unapplied when the note was folded');
    // ---- 4. after the loop ended (host not yet torn down): honest 409; after teardown: 404 ----
    const late = h.post('one more thing');
    A.eq(late.status, 409, 'a steer after the loop ended is a non-success (409), not a 200 promise');
    A.eq([late.body.ok, late.body.applied], [false, false], 'the body says ok:false applied:false');
    A.ok(/not applied/.test(late.body.error), 'the error says the note was not applied: ' + late.body.error);
    A.eq(h.bufs.pending('r1'), 0, 'the refused note was not queued');
    A.eq(h.teardown().length, 0, 'teardown finds nothing left to drop');
    A.eq(h.post('after teardown').status, 404, 'after teardown the run is unknown (404, unchanged)');
  }

  // ---- 2. BOUNDED: a steer during EVERY final answer extends at most twice, then the leftover is named ----
  {
    const { seq, emit } = setup();
    const h = host('r2');
    let k = 0;
    const provider = streamingProvider([async function* () {
      yield { type: 'text', delta: 'answer ' + (++k) + ' ' };
      await tick(5);
      h.post('steer #' + k);
      yield { type: 'text', delta: 'done.' };
      yield { type: 'done', finishReason: 'stop' };
    }]);
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider, emit, cost: makeCostEngine({ priceOf }), model: 'm', agentId: 'a', runId: 'r2',
      tools: [], limits: { grace: false }, capCtx: openCtx(), ...h.loopOpts });
    A.eq(provider.requests.length, 3, 'one original final + exactly 2 steer extensions (bounded)');
    A.eq(res.reason, 'done', 'the run still terminates done');
    A.ok(hasNote(provider.requests[1], 'steer #1') && hasNote(provider.requests[2], 'steer #2'), 'each extension carried the note that arrived during the previous final');
    const unapplied = seq.filter(e => e.name === 'agent.token' && /1 steering note arrived as this run was ending and was NOT applied/.test(e.payload.delta || ''));
    A.eq(unapplied.length, 1, 'the third note is named in the transcript as NOT applied (never silently dropped)');
    A.eq(h.post('x').status, 409, 'and the buffer is closed');
  }

  // ---- 3a. never on a CANCELLED run ----
  {
    const { seq, emit } = setup();
    const h = host('r3');
    const ac = new AbortController();
    const provider = streamingProvider([async function* () {
      yield { type: 'text', delta: 'final ' };
      h.post('please also add a chart');
      ac.abort();
      yield { type: 'text', delta: 'more' };
      yield { type: 'done', finishReason: 'stop' };
    }]);
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider, emit, cost: makeCostEngine({ priceOf }), model: 'm', agentId: 'a', runId: 'r3',
      tools: [], limits: { grace: false }, signal: ac.signal, capCtx: openCtx(), ...h.loopOpts });
    A.eq([res.reason, provider.requests.length], ['cancelled', 1], 'a cancelled run is never extended');
    A.ok(seq.some(e => e.name === 'agent.token' && /NOT applied/.test(e.payload.delta || '')), 'its pending note is named as NOT applied');
    A.eq(h.post('late').status, 409, 'and later steers get the honest 409');
  }

  // ---- 3b. never on the GRACE turn (contracted tool-free) ----
  {
    const { emit } = setup();
    const h = host('r4');
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'fs_write', schema: { type: 'object' }, run: async () => 'wrote' });
    const provider = streamingProvider([
      async function* () {
        yield { type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' };
        yield { type: 'tool_args', index: 0, chunk: '{}' };
        yield { type: 'done', finishReason: 'tool_calls' };
      },
      async function* () {                      // the grace turn
        yield { type: 'text', delta: 'best final answer' };
        h.post('late steer on grace');
        yield { type: 'done', finishReason: 'stop' };
      }
    ]);
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider, emit, cost: makeCostEngine({ priceOf }), model: 'm', agentId: 'a', runId: 'r4',
      tools: [], limits: { maxIters: 1 }, dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(), ...h.loopOpts });
    A.eq(provider.requests.length, 2, 'the grace turn is not extended');
    A.eq(res.reason, 'done', 'the grace answer ends the run');
  }

  // ---- 3c. limits.steerExtend:false turns the extension off (the note is still named, never silent) ----
  {
    const { seq, emit } = setup();
    const h = host('r5');
    const provider = streamingProvider([async function* () {
      yield { type: 'text', delta: 'final' };
      h.post('ignored note');
      yield { type: 'done', finishReason: 'stop' };
    }]);
    await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider, emit, cost: makeCostEngine({ priceOf }), model: 'm', agentId: 'a', runId: 'r5',
      tools: [], limits: { grace: false, steerExtend: false }, capCtx: openCtx(), ...h.loopOpts });
    A.eq(provider.requests.length, 1, 'steerExtend:false never extends');
    A.ok(seq.some(e => e.name === 'agent.token' && /NOT applied/.test(e.payload.delta || '')), 'the unread note is still named as NOT applied');
  }

  // ---- 5. no steerClose wired (a worker's generation-bound steer): the extension still works, nothing else changes ----
  {
    const { emit } = setup();
    const pending = [];
    const provider = streamingProvider([
      async function* () { yield { type: 'text', delta: 'worker final' }; pending.push('[from the Commander] narrower scope'); yield { type: 'done', finishReason: 'stop' }; },
      async function* () { yield { type: 'text', delta: 'narrowed' }; yield { type: 'done', finishReason: 'stop' }; }
    ]);
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider, emit, cost: makeCostEngine({ priceOf }), model: 'm', agentId: 'w', runId: 'w1',
      tools: [], limits: { grace: false }, capCtx: openCtx(), steer: () => pending.splice(0) });
    A.eq([provider.requests.length, res.reason], [2, 'done'], 'a worker steer arriving mid-final also gets its turn');
    A.ok(hasNote(provider.requests[1], '[from the Commander] narrower scope'), 'with the identical steering_note format');
  }

  A.report('steer.final-stream.test');
})().catch(e => { console.log('FAIL: steer.final-stream.test threw — ' + (e && e.stack || e)); process.exit(1); });
