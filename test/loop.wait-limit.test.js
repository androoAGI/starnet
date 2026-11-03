/* node test/loop.wait-limit.test.js — THE WAIT SAYS ITS LIMIT (local-runtime-profile lane, gap D, 2026-11-03).

   A local server that is loading a model can sit silent for minutes, and StarNet now waits the local ceiling for it once
   (local-runtime-silence.test.js). The wait line showed how long it had waited, never how long it WOULD wait. The adapter
   states its ceiling on its { type:'waiting' } events (limitMs + limitKind: 'connect' counts from the call going out,
   'silence' from the last byte), the loop's agent.waiting beat carries it, and COMMS reads it (comms-wait-line.test.js).
   The ladder's limit already rides provider.retry (waitedMs / patienceMs). Locked here:
     · a beat after the adapter stated a connect ceiling carries limitMs / limitKind, and passes the event contract
     · the connect ceiling ends with the connect phase (the first stream event); a silence ceiling holds for the stream
     · a waiting event without a limit clears it; a wait whose adapter states none (every hosted one) beats as before
     · end to end: the real CUSTOM adapter on a local URL (fake fetch, no server) states the local connect ceiling while
       no headers have arrived, and the idle ceiling once they have
     · a re-send inside the attempt (limitElapsedMs): the connect ceiling counts from that send, not the attempt's start */
'use strict';
process.env.SKYNET_LOCAL_WAIT_NOTE_MS = '20';
process.env.SKYNET_LOCAL_CONNECT_TIMEOUT_MS = '600000';
process.env.SKYNET_PROVIDER_IDLE_MS = '240000';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const factory = require('../sidecar/providers/factory.js');

const priceOf = () => ({ in: 1, out: 2 });
const flush = async (n) => { for (let i = 0; i < (n || 5); i++) await new Promise(r => setImmediate(r)); };
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
const tail = text => [
  { type: 'text', delta: text },
  { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  { type: 'done', finishReason: 'stop' }
];
function harness() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const dropped = [];
  const emit = makeEmitter(bus, e => dropped.push(e));
  let T = 5000000;
  const clock = { now: () => T };
  const armed = new Set();
  const waitTicker = beat => { armed.add(beat); return () => armed.delete(beat); };
  const tick = ms => { T += ms; for (const b of Array.from(armed)) b(); };
  const base = { messages: [{ role: 'user', content: 'x' }], emit, cost: makeCostEngine({ priceOf }), model: 'qwen', agentId: 'a', runId: 'r', clock, waitTicker, random: () => 0.5 };
  return { seq, dropped, tick, opts: p => Object.assign({}, base, { provider: p }) };
}
const waits = seq => seq.filter(e => e.name === 'agent.waiting').map(e => e.payload);
const last = seq => waits(seq)[waits(seq).length - 1] || {};

(async () => {
  // ---- 1. a stated connect ceiling rides the beats, and ends with the connect phase ----
  {
    const h = harness();
    const g1 = gate(), g2 = gate();
    const provider = { stream: async function* () {
      yield { type: 'waiting', phase: 'connect', note: 'no answer yet', limitMs: 300000, limitKind: 'connect' };
      await g1.p;
      yield { type: 'reasoning' };   // the first stream event: the connect phase is over
      await g2.p;
      for (const ev of tail('hi')) yield ev;
    } };
    const done = runAgentLoop(h.opts(provider));
    await flush();
    A.eq(last(h.seq), { agentId: 'a', runId: 'r', phase: 'connect', sinceMs: 0, model: 'qwen', note: 'no answer yet', limitMs: 300000, limitKind: 'connect' },
      'the beat the note fires carries the connect ceiling');
    h.tick(15000);
    A.eq([last(h.seq).sinceMs, last(h.seq).limitMs, last(h.seq).limitKind], [15000, 300000, 'connect'], 'and so does every tick of that wait');
    g1.open(); await flush();
    h.tick(15000);
    A.eq([last(h.seq).phase, 'limitMs' in last(h.seq)], ['streaming', false], 'the first stream event ends the connect ceiling');
    g2.open();
    A.eq((await done).reason, 'done', 'the call completed');
    A.eq(h.dropped.length, 0, 'every beat passed the event contract');
  }

  // ---- 2. a silence ceiling holds through the stream; an event without a limit clears it ----
  {
    const h = harness();
    const g1 = gate(), g2 = gate();
    const provider = { stream: async function* () {
      yield { type: 'waiting', phase: 'streaming', note: '', limitMs: 240000, limitKind: 'silence' };
      await g1.p;
      yield { type: 'reasoning' };
      await g2.p;
      yield { type: 'waiting', phase: 'streaming', note: '' };
      for (const ev of tail('hi')) yield ev;
    } };
    const done = runAgentLoop(h.opts(provider));
    await flush();
    h.tick(15000);
    A.eq([last(h.seq).phase, last(h.seq).limitMs, last(h.seq).limitKind], ['streaming', 240000, 'silence'], 'the idle ceiling rides a quiet open stream');
    g1.open(); await flush();
    h.tick(15000);
    A.eq([last(h.seq).limitMs, last(h.seq).limitKind], [240000, 'silence'], 'and outlives the first stream event');
    g2.open();
    await done;
  }

  // ---- 3. a wait that states no limit beats exactly as before ----
  {
    const h = harness();
    const g = gate();
    const provider = { stream: async function* () { await g.p; for (const ev of tail('hi')) yield ev; } };
    const done = runAgentLoop(h.opts(provider));
    await flush();
    h.tick(15000);
    A.eq(waits(h.seq), [{ agentId: 'a', runId: 'r', phase: 'first_byte', sinceMs: 15000, model: 'qwen' }], 'no limit stated, none carried');
    g.open();
    await done;
  }

  // ---- 4. end to end: the real CUSTOM adapter on a local URL states its ceilings ----
  {
    const h = harness();
    const headers = gate();
    let send = 0;
    let ctl = null;
    const body = new ReadableStream({ start(c) { ctl = c; } });
    const fetch = async (url, init) => {
      if (!init || init.body == null) return new Response('{"data":[]}', { status: 200 });
      send++;
      await headers.p;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const p = factory.selectProvider({ provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', fetch });
    const done = runAgentLoop(h.opts(p));
    // bounded (review minor): code that never states the note fails here in 5 s instead of hanging the file
    const until = Date.now() + 5000;
    while (!waits(h.seq).some(w => w.phase === 'connect') && Date.now() < until) await new Promise(r => setTimeout(r, 5));
    const w = waits(h.seq).find(x => x.phase === 'connect');
    if (!w) { A.ok(false, 'no connect-phase beat within 5 s: the adapter never stated its wait'); A.report('loop.wait-limit.test'); }
    A.eq([w.limitMs, w.limitKind], [600000, 'connect'], 'no headers yet: the local connect ceiling (SKYNET_LOCAL_CONNECT_TIMEOUT_MS)');
    A.ok(/^no answer yet from the model server at 127\.0\.0\.1:1234 on this computer/.test(w.note || ''), 'with the note naming the server: ' + w.note);
    headers.open();
    await flush(20);
    h.tick(15000);
    A.eq([last(h.seq).phase, last(h.seq).limitMs, last(h.seq).limitKind], ['streaming', 240000, 'silence'], 'headers in: the idle ceiling (SKYNET_PROVIDER_IDLE_MS)');
    const enc = new TextEncoder();
    ctl.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    ctl.close();
    A.eq((await done).reason, 'done', 'the turn completed');
    A.eq(send, 1, 'one request');
    A.eq(h.dropped.length, 0, 'every beat passed the event contract');
  }

  // ---- 5. a re-send inside the attempt: the connect ceiling counts from THAT send (review M3) ----
  // The adapter re-sent a busy local request 61 s into this wait; its note says the new send has been out 1 s
  // (limitElapsedMs), so the 300 s ceiling ends 360 s after the wait began — never "giving up" on a fresh send.
  {
    const h = harness();
    const g1 = gate(), g2 = gate();
    const provider = { stream: async function* () {
      yield { type: 'waiting', phase: 'connect', note: 'no answer yet · 1 other StarNet call still open there' };
      await g1.p;
      yield { type: 'waiting', phase: 'connect', note: 'no answer yet', limitMs: 300000, limitKind: 'connect', limitElapsedMs: 1000 };
      await g2.p;
      for (const ev of tail('hi')) yield ev;
    } };
    const done = runAgentLoop(h.opts(provider));
    await flush();
    A.eq('limitMs' in last(h.seq), false, 'a send that would be re-sent states no limit');
    h.tick(61000);
    g1.open(); await flush();
    A.eq([last(h.seq).sinceMs, last(h.seq).limitMs, last(h.seq).limitKind], [61000, 360000, 'connect'], 'the re-send\'s ceiling counts from the re-send');
    g2.open();
    A.eq((await done).reason, 'done', 'the call completed');
    A.eq(h.dropped.length, 0, 'every beat passed the event contract');
  }

  A.report('loop.wait-limit.test');
})();
