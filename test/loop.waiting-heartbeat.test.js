/* node test/loop.waiting-heartbeat.test.js — LIVE WAIT HEARTBEAT (2026-09-23, live-events lane).

   A model call that shows nothing yet — a slow first byte, a silent reasoning stream, a backoff between ladder
   rungs — used to be indistinguishable from a dead run. loop.js now emits agent.waiting on every tick of an
   INJECTED ticker (o.waitTicker(beat) -> disarm) with sinceMs read from the INJECTED clock, and stops the moment
   the Commander sees output. Locked here:

     · first_byte: nothing received yet -> one beat per tick, sinceMs counting from when the call went out
     · the first visible token silences it; later ticks emit nothing until tool arguments start streaming,
       which re-arms it (a new silence, sinceMs from its start); the attempt settling disarms the ticker
     · streaming: a stream that is open but shows nothing (reasoning, streaming tool arguments) keeps beating
     · retry_backoff: beats during the ladder's sleep; the retried attempt announces itself at once (sinceMs 0)
     · the ticker is always disarmed when the attempt settles (success, fatal error)
     · no ticker, or a ticker without a clock -> nothing armed, nothing emitted (existing callers byte-identical)
     · a throwing emit inside a beat never escapes into the host's timer

   Deterministic: hand-driven clock and ticker, a gated hand-rolled provider, the real validating emitter. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');

const priceOf = () => ({ in: 1, out: 2 });
const flush = async (n) => { for (let i = 0; i < (n || 5); i++) await new Promise(r => setImmediate(r)); };
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const tail = text => [
  { type: 'text', delta: text },
  { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  { type: 'done', finishReason: 'stop' }
];
function harness(extra) {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const dropped = [];
  const emit = makeEmitter(bus, e => dropped.push(e));
  let T = 5000000;
  const clock = { now: () => T };
  const armed = new Set();
  let armCount = 0;
  const waitTicker = beat => { armed.add(beat); armCount++; return () => armed.delete(beat); };
  const tick = ms => { T += ms; for (const b of Array.from(armed)) b(); };
  const base = { messages: [{ role: 'user', content: 'x' }], emit, cost: makeCostEngine({ priceOf }), model: 'fixture-model', agentId: 'a', runId: 'r', clock, waitTicker, random: () => 0.5 };
  return { seq, dropped, armed, tick, advance: ms => { T += ms; }, arms: () => armCount, opts: p => Object.assign({}, base, { provider: p }, extra || {}) };
}
const waits = seq => seq.filter(e => e.name === 'agent.waiting').map(e => e.payload);

(async () => {
  // ---- 1. a slow first byte: a beat per tick, then silence once the first token lands ----
  {
    const h = harness();
    const g = gate();
    const provider = { stream: async function* () { await g.p; for (const ev of tail('hello')) yield ev; } };
    const done = runAgentLoop(h.opts(provider));
    await flush();
    A.eq(h.armed.size, 1, 'the model call armed exactly one ticker');
    h.tick(15000);
    h.tick(15000);
    A.eq(waits(h.seq), [
      { agentId: 'a', runId: 'r', phase: 'first_byte', sinceMs: 15000, model: 'fixture-model' },
      { agentId: 'a', runId: 'r', phase: 'first_byte', sinceMs: 30000, model: 'fixture-model' }
    ], 'first_byte beats, sinceMs counted from when the call went out');
    g.open();
    const res = await done;
    A.eq(res.reason, 'done', 'the slow call completed');
    A.eq(h.armed.size, 0, 'the first token disarmed the ticker');
    h.tick(15000);
    A.eq(waits(h.seq).length, 2, 'no beat after the output started');
    const iLastWait = h.seq.map(e => e.name).lastIndexOf('agent.waiting'), iTok = h.seq.findIndex(e => e.name === 'agent.token');
    A.ok(iLastWait < iTok, 'every heartbeat precedes the first token');
    A.eq(h.dropped.length, 0, 'every heartbeat passed the frozen contract');
  }

  // ---- 2. an open stream that shows nothing (reasoning) keeps beating as `streaming` ----
  {
    const h = harness();
    const g = gate();
    const provider = { stream: async function* () { h.advance(2000); yield { type: 'reasoning', block: { type: 'thinking', thinking: '…' } }; await g.p; for (const ev of tail('thought it through')) yield ev; } };
    const done = runAgentLoop(h.opts(provider));
    await flush();
    h.tick(13000);
    A.eq(waits(h.seq).map(w => [w.phase, w.sinceMs]), [['streaming', 15000]], 'streaming phase; sinceMs still counts from the call going out');
    g.open(); await done;
    A.eq(h.armed.size, 0, 'disarmed after the answer');
  }

  // ---- 2b. a QUIET open stream says so: once the provider has sent nothing for 30 s a streaming beat names the
  //          silence after the adapter's note; any provider event (a wait note included) restarts that count ----
  {
    const h = harness();
    const g1 = gate(), g2 = gate();
    const provider = { stream: async function* () {
      yield { type: 'waiting', phase: 'streaming', note: 'reasoning' };
      await g1.p;
      yield { type: 'waiting', phase: 'streaming', note: 'reasoning' };
      await g2.p;
      for (const ev of tail('done thinking')) yield ev;
    } };
    const done = runAgentLoop(h.opts(provider));
    await flush();
    h.tick(15000);
    h.tick(15000);
    h.tick(15000);
    g1.open(); await flush();
    h.tick(15000);
    A.eq(waits(h.seq).map(w => [w.phase, w.sinceMs, w.note]), [
      ['streaming', 0, 'reasoning'],
      ['streaming', 15000, 'reasoning'],
      ['streaming', 30000, 'reasoning · no stream event for 30s'],
      ['streaming', 45000, 'reasoning · no stream event for 45s'],
      ['streaming', 45000, 'reasoning'],
      ['streaming', 60000, 'reasoning']
    ], 'the note beats at once; the silence is named from 30 s and cleared by the next provider event');
    g2.open(); await done;
    A.eq(h.dropped.length, 0, 'every beat passed the frozen contract');
  }

  // ---- 3. streaming tool arguments show nothing (agent.tool_call fires after the stream): still waiting ----
  {
    const h = harness();
    const g = gate();
    let call = 0;
    const provider = { stream: async function* () {
      call++;
      if (call === 1) {
        yield { type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' };
        yield { type: 'tool_args', index: 0, chunk: '{"path":"a.txt",' };
        await g.p;
        yield { type: 'tool_args', index: 0, chunk: '"content":"x"}' };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      for (const ev of tail('wrote it')) yield ev;
    } };
    const o = Object.assign(h.opts(provider), {
      tools: [{ type: 'function', function: { name: 'fs_write', parameters: { type: 'object' } } }],
      dispatch: async () => ({ content: 'written', isError: false, summary: 'ok' }),
      capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }
    });
    const done = runAgentLoop(o);
    await flush();
    h.tick(15000);
    A.eq(waits(h.seq).map(w => w.phase), ['streaming'], 'a long tool-argument stream still reads as waiting');
    g.open(); await done;
    const iCall = h.seq.findIndex(e => e.name === 'agent.tool_call');
    A.ok(iCall > h.seq.findIndex(e => e.name === 'agent.waiting'), 'the heartbeat came before the tool call surfaced');
    A.eq(h.armed.size, 0, 'nothing left armed');
  }

  // ---- 4. retry backoff beats, and the retried attempt announces itself at once ----
  {
    const h = harness({ sleep: async ms => { h.tick(10000); } });
    const g = gate();
    let call = 0;
    const provider = { stream: async function* () { call++; if (call === 1) throw httpErr(503, 'upstream overloaded'); await g.p; for (const ev of tail('back')) yield ev; } };
    const done = runAgentLoop(h.opts(provider));
    await flush();
    const got = h.seq.filter(e => e.name === 'provider.retry' || e.name === 'agent.waiting').map(e => e.name === 'provider.retry' ? ['retry', e.payload.attempt] : [e.payload.phase, e.payload.sinceMs]);
    A.eq(got, [['retry', 1], ['retry_backoff', 10000], ['first_byte', 0]], 'retry announced, backoff beat, then the retry going out');
    h.tick(15000);
    A.eq(waits(h.seq).slice(-1)[0].sinceMs, 15000, 'the retried attempt keeps its own heartbeat');
    g.open();
    A.eq((await done).reason, 'done', 'recovered');
    A.eq(h.armed.size, 0, 'backoff and attempt tickers both disarmed');
  }

  // ---- 5. a fatal failure disarms too ----
  {
    const h = harness();
    const provider = { stream: async function* () { throw httpErr(401, 'invalid api key'); } };
    const res = await runAgentLoop(h.opts(provider));
    A.eq(res.reason, 'error', 'fatal');
    A.eq(h.armed.size, 0, 'no ticker survives a fatal attempt');
    A.eq(h.arms(), 1, 'exactly one wait was opened');
  }

  // ---- 6. absent injection = nothing armed, nothing emitted ----
  {
    const h = harness({ waitTicker: undefined });
    const res = await runAgentLoop(h.opts({ stream: async function* () { for (const ev of tail('hi')) yield ev; } }));
    A.eq(res.reason, 'done', 'runs as before');
    A.eq(waits(h.seq).length, 0, 'no ticker -> no agent.waiting');
    let armedWithoutClock = 0;
    const h2 = harness({ clock: undefined, waitTicker: () => { armedWithoutClock++; return () => {}; } });
    await runAgentLoop(h2.opts({ stream: async function* () { for (const ev of tail('hi')) yield ev; } }));
    A.eq(armedWithoutClock, 0, 'a ticker without a clock is never armed (sinceMs would be a guess)');
  }

  // ---- 7. a throwing emit inside a beat never escapes into the host timer ----
  {
    const h = harness();
    const g = gate();
    const o = h.opts({ stream: async function* () { await g.p; for (const ev of tail('ok')) yield ev; } });
    const realEmit = o.emit;
    o.emit = (n, p) => { if (n === 'agent.waiting') throw new Error('socket gone'); return realEmit(n, p); };
    const done = runAgentLoop(o);
    await flush();
    let threw = null;
    try { h.tick(15000); } catch (e) { threw = e; }
    A.eq(threw, null, 'the beat swallowed (and noted) the emit failure');
    g.open();
    A.eq((await done).reason, 'done', 'the run is unaffected');
  }

  // ---- 8. a sentence, then a long tool-argument stream: the heartbeat pauses on the text and RE-ARMS for the args ----
  {
    const h = harness();
    const g1 = gate(), g2 = gate();
    let call = 0;
    const provider = { stream: async function* () {
      call++;
      if (call === 1) {
        yield { type: 'text', delta: 'Writing the report now.' };
        await g1.p;
        yield { type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' };
        yield { type: 'tool_args', index: 0, chunk: '{"path":"report.md",' };
        await g2.p;
        yield { type: 'tool_args', index: 0, chunk: '"content":"x"}' };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      for (const ev of tail('done')) yield ev;
    } };
    const o = Object.assign(h.opts(provider), {
      tools: [{ type: 'function', function: { name: 'fs_write', parameters: { type: 'object' } } }],
      dispatch: async () => ({ content: 'written', isError: false, summary: 'ok' }),
      capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }
    });
    const done = runAgentLoop(o);
    await flush();
    h.tick(15000);
    A.eq(waits(h.seq).length, 0, 'visible text: no beat while the Commander is watching output');
    g1.open(); await flush();
    h.tick(15000);
    h.tick(15000);
    A.eq(waits(h.seq).map(w => [w.phase, w.sinceMs]), [['streaming', 15000], ['streaming', 30000]],
      'tool arguments streaming after the text beat again, sinceMs counting from when the new silence began');
    g2.open();
    A.eq((await done).reason, 'done', 'the run completed');
    A.eq(h.armed.size, 0, 'nothing left armed');
    A.eq(h.dropped.length, 0, 'every beat passed the frozen contract');
  }

  A.report('loop.waiting-heartbeat');
})().catch(e => { console.error(e); process.exit(1); });
