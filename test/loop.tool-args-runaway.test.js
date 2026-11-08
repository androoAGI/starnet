/* node test/loop.tool-args-runaway.test.js — A RUNAWAY TOOL CALL ENDS.

   The #178 report's last run: "cancelled with the model stream open but nothing shown yet for 8m 31s (writing todo
   arguments)". Streamed tool arguments show nothing, and every chunk resets the provider's idle watchdog, so one call whose
   arguments never ended ran, and billed, until it was cancelled. Locked here, against the loop (zero network) and through the
   real codex adapter:
     · one call's arguments past the size ceiling stop the call: the attempt's signal aborts, the call is never run, the
       run ends 'error' / tool_args_runaway naming the tool and the size, and the same runaway is never retried;
     · on a hosted model, one call's arguments still streaming after the time ceiling (10 minutes by default, on the
       injected clock) stop the same way, naming how long;
     · a local runtime is not timed (a slow local model writing a real file), only sized;
     · a call under both ceilings runs as before, and while its arguments stream the wait line says how much is written;
     · through the real codex adapter, the abort cancels the response body: the provider stops sending. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeCodexProvider } = require('../sidecar/providers/codex.js');

const priceOf = () => ({ in: 1, out: 2 });
const openCtx = signal => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office', signal });
const TODO = { name: 'todo', schema: { type: 'object', properties: { todos: { type: 'array' } } } };

async function run(provider, o) {
  const bus = A.makeBus(), seq = A.collectBus(bus, events.names()), emit = makeEmitter(bus, () => {});
  const ac = new AbortController(), reg = makeRegistry(), ran = [];
  reg.register({ impact: 'none', name: TODO.name, schema: TODO.schema, run: async args => { ran.push(args); return 'noted'; } });
  const res = await runAgentLoop({
    messages: [{ role: 'user', content: 'plan it' }], provider, emit, cost: makeCostEngine({ priceOf }),
    model: 'm/model', agentId: 'a', runId: 'r', tools: [{ type: 'function', function: { name: TODO.name, parameters: TODO.schema } }],
    limits: Object.assign({ maxIters: 3, grace: false }, o.limits), signal: ac.signal,
    dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(ac.signal), clock: o.clock || { now: () => Date.now() },
    waitTicker: () => () => {}
  });
  const errors = seq.filter(e => e.name === 'agent.run.error').map(e => e.payload);
  const waits = seq.filter(e => e.name === 'agent.waiting').map(e => e.payload);
  return { res, ran, errors, waits };
}

// a provider whose first call opens a `todo` call and then writes its arguments chunk after chunk until its signal aborts
// (or `total` chunks, then closes the call properly); every later call answers in text. tick() runs before each chunk.
function runawayProvider(o) {
  const seen = { calls: 0, chunks: 0, abortedAt: -1, signals: [] };
  const chunk = '{"todos":["' + 'x'.repeat(o.chunk - 11);
  const provider = {
    priceOf, contextLimit: () => 0, localRuntime: o.local ? { kind: 'ollama' } : undefined,
    stream(req) {
      const call = ++seen.calls;
      seen.signals.push(req.signal);
      return (async function* () {
        if (call > 1) { yield { type: 'text', delta: 'done' }; yield { type: 'done', finishReason: 'stop' }; return; }
        yield { type: 'tool_start', index: 0, id: 'c1', name: 'todo' };
        for (let i = 0; o.total == null || i < o.total; i++) {
          if (req.signal.aborted) { seen.abortedAt = seen.chunks; return; }
          if (o.tick) o.tick();
          seen.chunks++;
          yield { type: 'tool_args', index: 0, chunk: i === 0 ? chunk : 'y'.repeat(o.chunk) };
          if (i > 2000) throw new Error('the runaway was never stopped');
        }
        // a call that finished: valid arguments and a proper end
        yield { type: 'tool_args', index: 0, chunk: '"]}' };
        yield { type: 'tool_done', index: 0 };
        yield { type: 'done', finishReason: 'tool_calls' };
      })();
    }
  };
  return { provider, seen };
}

(async () => {
  // ---- 1. the size ceiling --------------------------------------------------------------------------------------------------
  {
    const { provider, seen } = runawayProvider({ chunk: 4 * 1024 });
    const { res, ran, errors } = await run(provider, { limits: { toolArgsMaxChars: 200 * 1024 } });
    A.eq([res.reason, res.failureCode], ['error', 'tool_args_runaway'], 'one call past the size ceiling ends the run as a runaway');
    A.ok(seen.abortedAt >= 0 && seen.chunks <= 52, 'the attempt\'s own signal aborted the call right after the ceiling (' + seen.chunks + ' chunks)');
    A.ok(seen.signals[0] && seen.signals[0].aborted === true, 'the provider saw its request signal abort');
    A.eq(ran.length, 0, 'the half-written call is never run');
    A.eq(seen.calls, 1, 'and the same runaway is never retried');
    const error = errors[0] || {};
    A.ok(error.failureCode === 'tool_args_runaway' && error.transient === false && /`todo`/.test(error.message) && /more than 200 KB/.test(error.message),
      'the run says which tool and how much: ' + error.message);
  }
  // ---- 2. the time ceiling on a hosted model (the default 10 minutes, on the injected clock) --------------------------------
  {
    let now = 1000000;
    const { provider, seen } = runawayProvider({ chunk: 512, tick: () => { now += 60 * 1000; } });
    const { res, ran, errors } = await run(provider, { clock: { now: () => now } });
    A.eq([res.reason, res.failureCode], ['error', 'tool_args_runaway'], 'a call whose arguments are still streaming after 10 minutes ends as a runaway');
    A.ok(seen.chunks >= 10 && seen.chunks <= 12, 'at the ten-minute ceiling, not before (' + seen.chunks + ' one-minute chunks)');
    A.eq(ran.length, 0, 'never run');
    A.ok(/kept writing the arguments of one `todo` call for 1[01]m/.test((errors[0] || {}).message || ''), 'the run says how long: ' + (errors[0] || {}).message);
  }
  // ---- 3. a local runtime is sized, not timed ------------------------------------------------------------------------------
  {
    let now = 1000000;
    const { provider, seen } = runawayProvider({ chunk: 512, total: 15, local: true, tick: () => { now += 60 * 1000; } });
    const { res, ran } = await run(provider, { clock: { now: () => now } });
    A.ok(res.reason === 'done' && seen.chunks === 15, 'a slow local model writing for 15 minutes is not stopped (' + res.reason + ', ' + seen.chunks + ' chunks)');
    A.eq(ran.length, 1, 'its call runs');
  }
  // ---- 4. a call under both ceilings runs, and the wait line says how much is written -------------------------------------
  {
    const { provider, seen } = runawayProvider({ chunk: 16 * 1024, total: 5 });
    const { res, ran, waits } = await run(provider, {});
    A.ok(res.reason === 'done' && seen.calls === 2, 'an ordinary call is untouched (' + res.reason + ')');
    A.eq(ran.length, 1, 'and runs');
    A.ok(waits.some(w => /writing todo arguments · (64|80) KB written/.test(w.note || '')), 'the wait line counts the arguments written: ' + JSON.stringify(waits.map(w => w.note).filter(Boolean)));
  }
  // ---- 5. through the real codex adapter, the abort cancels the response body -------------------------------------------------
  {
    let pulled = 0, cancelled = false;
    const enc = new TextEncoder();
    const line = obj => enc.encode('data: ' + JSON.stringify(obj) + '\n\n');
    const fetch = async () => new Response(new ReadableStream({
      pull(controller) {
        pulled++;
        if (pulled === 1) { controller.enqueue(line({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'todo', call_id: 'c1', arguments: '' } })); return; }
        if (pulled > 5000) { controller.error(new Error('the body was never cancelled')); return; }
        controller.enqueue(line({ type: 'response.function_call_arguments.delta', output_index: 0, delta: 'z'.repeat(8192) }));
      },
      cancel() { cancelled = true; }
    }, { highWaterMark: 0 }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    const codex = makeCodexProvider({ fetch, token: 'acc' });
    const { res, ran } = await run(codex, { limits: { toolArgsMaxChars: 128 * 1024 } });
    A.eq([res.reason, res.failureCode], ['error', 'tool_args_runaway'], 'the real codex adapter: a runaway todo call ends the run');
    A.ok(cancelled, 'the response body was cancelled: the provider stops sending');
    A.ok(pulled < 40, 'shortly after the ceiling (' + pulled + ' chunks pulled)');
    A.eq(ran.length, 0, 'never run');
  }
  A.report('loop.tool-args-runaway');
})().catch(error => { A.ok(false, error.stack); A.report('loop.tool-args-runaway'); });
