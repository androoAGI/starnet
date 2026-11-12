/* node test/loop.tool-args-local-endpoint.test.js — A SLOW LOCAL MODEL ON A CUSTOM CARD IS SIZED, NOT TIMED (review56 R56-1-D1).

   692d5f720 stops one tool call whose arguments keep streaming past 10 minutes (the #178 runaway), and leaves a local
   runtime to the size ceiling alone, because a slow local model writing a real file can take longer than that. It
   recognised a local runtime only by provider.localRuntime, which the adapter sets for the OLLAMA card's native wire. LM
   Studio, vLLM, llama.cpp or Jan on the CUSTOM card at 127.0.0.1 or on the LAN was timed like a hosted API: a 12 KB page
   at about 5 tokens a second ended as tool_args_runaway after 10 minutes, was never written, and an unattended routine
   failed the same way on every fire. The adapter already knows where its endpoint is (endpointFacts(model).local:
   loopback or a private address, endpoint-facts.js), so the loop now asks it too.

   Locked here with the REAL factory and CUSTOM adapter (a fetch that answers in-process: no request leaves this test),
   the REAL loop and an injected clock that moves 30 s per 512-character chunk:
     1. a CUSTOM card at 127.0.0.1 writing for 12 minutes is not stopped: its call runs whole;
     2. the same on a LAN host (192.168.x);
     3. a hosted route is still timed: a CUSTOM card on a public host, and OpenRouter, stop at 10 minutes as before;
     4. the size ceiling still holds on a local CUSTOM card. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const factory = require('../sidecar/providers/factory.js');

const MODEL = 'qwen2.5-7b-instruct';
const TODO = { name: 'todo', schema: { type: 'object', properties: { todos: { type: 'array' } } } };
const openCtx = signal => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office', signal });

/* An in-process OpenAI-compatible server: GET /models lists the model; the first chat call opens a `todo` call and writes its
   arguments one 512-character chunk per read, moving the injected clock 30 s before each, `total` chunks, then closes the
   call; every later chat call answers in text. */
function slowServer(clock, total) {
  const seen = { chats: 0, chunks: 0, cancelled: false };
  const enc = new TextEncoder();
  const line = obj => enc.encode('data: ' + JSON.stringify(obj) + '\n\n');
  const delta = d => line({ choices: [{ index: 0, delta: d }] });
  const fetch = async (url, init) => {
    const u = String(url);
    if (!init || init.body == null || /\/models/.test(u)) {
      return new Response(JSON.stringify({ data: [{ id: MODEL, object: 'model', supported_parameters: ['tools'] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const call = ++seen.chats;
    let i = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (call > 1) {
          controller.enqueue(delta({ content: 'done' }));
          controller.enqueue(line({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        if (i === 0) {
          controller.enqueue(delta({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'todo', arguments: '' } }] }));
          i++;
          return;
        }
        if (i <= total) {
          clock.t += 30 * 1000;
          seen.chunks++;
          const text = i === 1 ? '{"todos":["' + 'x'.repeat(512 - 11) : 'y'.repeat(512);
          controller.enqueue(delta({ tool_calls: [{ index: 0, function: { arguments: text } }] }));
          i++;
          return;
        }
        controller.enqueue(delta({ tool_calls: [{ index: 0, function: { arguments: '"]}' } }] }));
        controller.enqueue(line({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
      cancel() { seen.cancelled = true; }
    }, { highWaterMark: 0 }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fetch, seen };
}

async function run(provider, clock, limits) {
  const bus = A.makeBus(), seq = A.collectBus(bus, events.names()), emit = makeEmitter(bus, () => {});
  const ac = new AbortController(), reg = makeRegistry(), ran = [];
  reg.register({ impact: 'none', name: TODO.name, schema: TODO.schema, run: async args => { ran.push(args); return 'noted'; } });
  const res = await runAgentLoop({
    messages: [{ role: 'user', content: 'write the page' }], provider, emit, cost: makeCostEngine({ priceOf: () => ({ in: 0, out: 0 }) }),
    model: MODEL, agentId: 'a', runId: 'r', tools: [{ type: 'function', function: { name: TODO.name, parameters: TODO.schema } }],
    limits: Object.assign({ maxIters: 3, grace: false }, limits || {}), signal: ac.signal,
    dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(ac.signal), clock: { now: () => clock.t },
    waitTicker: () => () => {}
  });
  const errors = seq.filter(e => e.name === 'agent.run.error').map(e => e.payload);
  return { res, ran, errors };
}

const card = (baseUrl, fetch) => factory.selectProvider({ provider: 'custom', baseUrl, fetch });
const argChars = ran => (ran[0] && Array.isArray(ran[0].todos) && typeof ran[0].todos[0] === 'string') ? ran[0].todos[0].length : -1;

(async () => {
  // ---- 1-2. a CUSTOM card on this computer, and on this network: 24 chunks, 12 minutes on the clock ------------------------
  for (const [label, baseUrl] of [['127.0.0.1', 'http://127.0.0.1:1234/v1'], ['LAN', 'http://192.168.1.50:1234/v1']]) {
    const clock = { t: 1000000 };
    const srv = slowServer(clock, 24);
    const provider = card(baseUrl, srv.fetch);
    A.ok(!provider.localRuntime, label + ': the CUSTOM card on its own /v1 wire carries no localRuntime (the case the timer missed)');
    const facts = typeof provider.endpointFacts === 'function' ? provider.endpointFacts(MODEL) : {};
    A.eq(facts.local, true, label + ': and the adapter knows its endpoint is local (' + facts.scope + ')');
    const { res, ran, errors } = await run(provider, clock);
    A.eq([res.reason, res.failureCode || ''], ['done', ''], label + ': a slow local model writing one call for 12 minutes is not stopped (' + res.reason + ' ' + (res.failureCode || '') + ': ' + ((errors[0] || {}).message || '') + ')');
    A.eq(srv.seen.chunks, 24, label + ': every chunk was read');
    A.eq(ran.length, 1, label + ': its call runs');
    A.eq(argChars(ran), 24 * 512 - 11, label + ': with all of its arguments');
  }

  // ---- 3. a hosted route is still timed ---------------------------------------------------------------------------------------
  for (const [label, make] of [
    ['a CUSTOM card on a public host', f => card('https://llm.example.com/v1', f)],
    ['OpenRouter', f => factory.selectProvider({ provider: 'openrouter', key: 'sk-or-v1-test', fetch: f })]
  ]) {
    const clock = { t: 1000000 };
    const srv = slowServer(clock, 24);
    const provider = make(srv.fetch);
    const facts = typeof provider.endpointFacts === 'function' ? provider.endpointFacts(MODEL) : { local: false };
    A.ok(!facts.local, label + ': the endpoint is not local');
    const { res, ran, errors } = await run(provider, clock);
    A.eq([res.reason, res.failureCode], ['error', 'tool_args_runaway'], label + ': a call still streaming after 10 minutes ends as a runaway');
    A.ok(srv.seen.chunks >= 20 && srv.seen.chunks <= 22, label + ': at the ten-minute ceiling, not before (' + srv.seen.chunks + ' thirty-second chunks)');
    A.eq(ran.length, 0, label + ': never run');
    A.ok(/kept writing the arguments of one `todo` call for 1[01]m/.test((errors[0] || {}).message || ''), label + ': the run says how long: ' + (errors[0] || {}).message);
  }

  // ---- 4. the size ceiling still holds on a local CUSTOM card -----------------------------------------------------------------
  {
    const clock = { t: 1000000 };
    const srv = slowServer(clock, 24);
    const { res, ran, errors } = await run(card('http://127.0.0.1:1234/v1', srv.fetch), clock, { toolArgsMaxChars: 4 * 1024 });
    A.eq([res.reason, res.failureCode], ['error', 'tool_args_runaway'], 'a local CUSTOM card past the size ceiling still ends as a runaway');
    A.ok(srv.seen.chunks <= 10, 'right after the ceiling (' + srv.seen.chunks + ' chunks)');
    A.eq(ran.length, 0, 'never run');
    A.ok(/more than 4 KB/.test((errors[0] || {}).message || ''), 'the run says how much: ' + (errors[0] || {}).message);
  }
  A.report('loop.tool-args-local-endpoint');
})().catch(error => { A.ok(false, error.stack); A.report('loop.tool-args-local-endpoint'); });
