/* node test/loop.stream-cut.test.js — A STOP THAT CUT A CALL OFF MID-STREAM (bug 80de2a75).

   The provider bills a model call from its first streamed byte, but the call's full usage arrives only as its stream
   ends. A cancel that cuts an attempt off after it began streaming leaves that call booked short, so the loop returns
   `streamCut: true` on the cancelled result and the run record says its spend is a floor (index.js usageMissing), or
   unknown when nothing at all was booked. Locked here, against the loop alone (zero network):
     · a Stop while text streams, or after a usage-first (Anthropic message_start) chunk, or one the adapter answers by
       throwing AbortError: streamCut
     · usage arriving in the SAME chunk as the turn's last words (openai-compatible yields usage before text), then a
       Stop while the next call has sent no byte: NOT cut — every streamed call was booked
     · a Stop during a tool call, after the stream closed: NOT cut
     · a run that is not cancelled never carries the field
     · the real claude-cli adapter: a Stop mid-text on a SUBSCRIPTION sign-in is NOT cut (nothing billed per call); on an
       API key it is
     · the real deepseek (openai-compatible) and openrouter adapters: a Stop while the model only reasons IS cut */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { EventEmitter } = require('events');
const { makeClaudeCliProvider } = require('../sidecar/providers/claude-cli.js');
const factory = require('../sidecar/providers/factory.js');

const openCtx = (extra) => Object.assign({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }, extra || {});
const priceOf = () => ({ in: 1, out: 2 });   // $1/$2 per million
function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  return { seq, emit: makeEmitter(bus, () => {}) };
}
const abortErr = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
const NOOP = { name: 'note_x', schema: { type: 'object', properties: { v: { type: 'string' } } } };
// calls: one generator factory per provider call, (ac) => async function* () {...}
async function run(calls, opts) {
  const o = opts || {};
  const { seq, emit } = setup();
  const ac = new AbortController();
  let n = 0;
  const provider = { stream: () => calls[Math.min(n++, calls.length - 1)](ac)(), priceOf, contextLimit: () => 0 };
  const reg = makeRegistry();
  reg.register({ impact: 'none', name: NOOP.name, schema: NOOP.schema, run: async () => { if (o.abortInTool) ac.abort(); return 'noted'; } });
  const res = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], provider, emit, cost: makeCostEngine({ priceOf }),
    model: 'm/model', agentId: 'a', runId: 'r', tools: [{ type: 'function', function: { name: NOOP.name, parameters: NOOP.schema } }],
    limits: { maxIters: 5, grace: false }, signal: ac.signal,
    dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx({ signal: ac.signal }), clock: { now: () => Date.now() }
  });
  return { res, seq, calls: n };
}
// a real adapter through the real loop; `ac` is the run's Stop
async function runWith(provider, ac, model) {
  const { seq, emit } = setup();
  const reg = makeRegistry();
  reg.register({ impact: 'none', name: NOOP.name, schema: NOOP.schema, run: async () => 'noted' });
  const res = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], provider, emit, cost: makeCostEngine({ priceOf }),
    model: model || 'sonnet', agentId: 'a', runId: 'r', tools: [{ type: 'function', function: { name: NOOP.name, parameters: NOOP.schema } }],
    limits: { maxIters: 5, grace: false }, signal: ac.signal,
    dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx({ signal: ac.signal }), clock: { now: () => Date.now() },
    waitTicker: () => () => {}   // arms the wait heartbeat (never ticks): the run records what a Stop interrupted
  });
  return { res, seq };
}
// a fake `claude` child (stream-json): each message it is sent (persistent stdin.write, or one-shot stdin.end) answers
// with `lines`, then it hangs until killed; `onSent` fires once the lines are out
function cliSpawn(lines, onSent) {
  const kids = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    const pipe = () => Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stdout = pipe(); child.stderr = pipe(); child.pid = 5100 + kids.length; child.exitCode = null; child.signalCode = null;
    const close = code => { if (child.exitCode != null || child.signalCode != null) return; child.signalCode = code == null ? 'SIGTERM' : null; child.exitCode = code; child.emit('exit', code); child.emit('close', code); };
    child.kill = () => { setImmediate(() => close(null)); return true; };
    const answer = () => setImmediate(() => { for (const l of lines) child.stdout.emit('data', JSON.stringify(l) + '\n'); onSent(); });
    child.stdin = Object.assign(new EventEmitter(), { write() { answer(); return true; }, end(text) { if (text) answer(); } });
    kids.push(child); return child;
  };
  return { spawn, kids };
}
const cliInit = source => ({ type: 'system', subtype: 'init', apiKeySource: source, tools: [] });
const cliDelta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const toolTurnUsageFirst = () => async function* () {
  yield { type: 'tool_start', index: 0, id: 'c0', name: NOOP.name };
  yield { type: 'tool_args', index: 0, chunk: '{"v":"x"}' };
  // openai-compatible emitFrom: a chunk carrying usage AND text yields the usage first
  yield { type: 'usage', usage: { prompt_tokens: 1000, completion_tokens: 100 } };
  yield { type: 'text', delta: 'Noting it.' };
  yield { type: 'done', finishReason: 'tool_calls' };
};

(async () => {
  // (1) Stop while the answer's text streams, no usage yet: cut, and nothing was booked
  {
    const { res } = await run([ac => async function* () {
      yield { type: 'text', delta: 'Here is the first half' };
      ac.abort();
      yield { type: 'text', delta: ' and the rest' };
      yield { type: 'usage', usage: { prompt_tokens: 1000, completion_tokens: 100 } };
      yield { type: 'done', finishReason: 'stop' };
    }]);
    A.eq(res.reason, 'cancelled', 'text stream: the run ends cancelled');
    A.eq(res.streamCut, true, 'text stream: a Stop mid-stream is a cut call');
    A.eq(res.usd, 0, 'text stream: nothing was booked (the usage never arrived)');
  }
  // (2) Anthropic shape: message_start usage (input) first, then text, then the Stop: cut, with the input booked
  {
    const { res } = await run([ac => async function* () {
      yield { type: 'usage', usage: { prompt_tokens: 1000, completion_tokens: 1 } };
      yield { type: 'text', delta: 'Partial' };
      ac.abort();
      yield { type: 'text', delta: ' more' };
    }]);
    A.eq(res.streamCut, true, 'usage-first stream: still a cut call (its output usage never arrived)');
    A.ok(res.usd > 0, 'usage-first stream: the input that was reported is booked: ' + res.usd);
  }
  // (3) the adapter answers the abort by throwing AbortError mid-stream: cut
  {
    const { res } = await run([ac => async function* () {
      yield { type: 'text', delta: 'Some words' };
      ac.abort();
      throw abortErr();
    }]);
    A.eq(res.reason, 'cancelled', 'thrown abort: the run ends cancelled');
    A.eq(res.streamCut, true, 'thrown abort: a cut call');
  }
  // (4) the adapter returns quietly on the abort (no throw, no more events): still cut
  {
    const { res } = await run([ac => async function* () {
      yield { type: 'text', delta: 'Some words' };
      ac.abort();
    }]);
    A.eq(res.reason, 'cancelled', 'quiet return: the run ends cancelled');
    A.eq(res.streamCut, true, 'quiet return: a cut call');
  }
  // (5) the reviewer's order: call 1's usage came before its last words and was booked; the Stop lands while call 2
  //     has sent no byte. Nothing was cut.
  {
    const { res, seq, calls } = await run([toolTurnUsageFirst, ac => async function* () {
      await new Promise(r => setTimeout(r, 5));
      ac.abort();
      throw abortErr();
    }]);
    A.eq(calls, 2, 'usage-first then silent: the second call went out');
    A.eq(res.reason, 'cancelled', 'usage-first then silent: the run ends cancelled');
    A.ok(res.usd > 0, 'usage-first then silent: call 1 was booked: ' + res.usd);
    A.ok(res.streamCut !== true, 'usage-first then silent: a Stop before the next call\'s first byte cut nothing');
    const names = seq.map(e => e.name);
    A.ok(names.indexOf('cost.estimate') >= 0 && names.indexOf('cost.estimate') < names.indexOf('agent.token'), 'the usage really did come before the text: ' + names.filter(x => /cost|token/.test(x)).join(','));
  }
  // (6) the Stop lands during a tool call, after the stream closed: nothing was cut
  {
    const { res } = await run([toolTurnUsageFirst, () => async function* () {
      yield { type: 'text', delta: 'done' }; yield { type: 'done', finishReason: 'stop' };
    }], { abortInTool: true });
    A.eq(res.reason, 'cancelled', 'Stop in a tool: the run ends cancelled');
    A.ok(res.streamCut !== true, 'Stop in a tool: no call was cut');
  }
  // (7) a run that is not cancelled never carries the field
  {
    const { res } = await run([() => async function* () {
      yield { type: 'text', delta: 'All of it' };
      yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 3 } };
      yield { type: 'done', finishReason: 'stop' };
    }]);
    A.eq(res.reason, 'done', 'a finished run is done');
    A.ok(!('streamCut' in res), 'a finished run has no streamCut field');
  }
  // (8) the REAL claude-cli adapter (one-shot and persistent child): a Commander on a SUBSCRIPTION sign-in (init line
  //     apiKeySource 'none': nothing is billed per call) presses Stop while the first call streams text. That call
  //     cost $0, so it is not a cut call (the run would read "spend unknown" for a provable $0). An API-key sign-in
  //     cut the same way IS a cut call.
  for (const persist of [false, true]) {
    for (const source of ['none', 'ANTHROPIC_API_KEY']) {
      const label = 'claude-cli ' + (persist ? 'persistent' : 'one-shot') + ' ' + (source === 'none' ? 'subscription' : 'API key') + ': ';
      const ac = new AbortController();
      const provider = makeClaudeCliProvider({ spawn: cliSpawn([cliInit(source), cliDelta('Here is the first half')], () => setTimeout(() => ac.abort(), 25)).spawn,
        fs: { statSync: () => ({ isFile: () => true }), writeFileSync() {}, unlinkSync() {} }, bin: 'claude', platform: 'linux', env: { PATH: '' }, persist });
      const { res, seq } = await runWith(provider, ac);
      A.eq(res.reason, 'cancelled', label + 'the run ends cancelled');
      A.ok(seq.some(e => e.name === 'agent.token' && /first half/.test(e.payload.delta)), label + 'the Stop landed mid-answer (text had streamed)');
      A.eq(res.usd, 0, label + 'nothing was booked');
      if (source === 'none') A.ok(res.streamCut !== true, label + 'a call billed nothing per call is not a cut call');
      else A.eq(res.streamCut, true, label + 'a billed call cut mid-stream is a cut call');
    }
  }
  // (9) a REASONING model (deepseek-reasoner via openai-compatible, an OpenRouter reasoning model) streams reasoning (billed
  //     output) before any answer text; a Stop in that phase is a cut call and the wait it interrupted was streaming
  for (const which of ['deepseek', 'openrouter']) {
    const ac = new AbortController();
    const chunk = which === 'deepseek' ? { choices: [{ delta: { role: 'assistant', content: '', reasoning_content: 'Let me think about ' } }] }
      : { choices: [{ delta: { role: 'assistant', content: '', reasoning: 'Let me think about ' } }] };
    const fetch = async (url, init) => {
      if (!(init && init.method === 'POST')) return new Response(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-reasoner', object: 'model' }, { id: 'vendor/reasoner', object: 'model' }] }), { status: 200 });
      const sig = init.signal;
      return new Response(new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(chunk) + '\n\n'));
        setTimeout(() => ac.abort(), 25);   // the Commander presses Stop while the model is still reasoning
        if (sig) sig.addEventListener('abort', () => { try { c.error(abortErr()); } catch (_) {} }, { once: true });
      } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const provider = factory.selectProvider({ provider: which, fetch, key: 'fixture-key', baseUrl: 'https://' + which + '-cut.test/v1' });
    const { res } = await runWith(provider, ac, which === 'deepseek' ? 'deepseek-reasoner' : 'vendor/reasoner');
    A.eq(res.reason, 'cancelled', which + ' reasoning-only: the run ends cancelled');
    A.eq(res.streamCut, true, which + ' reasoning-only: a Stop while the model reasons is a cut call (never a known $0)');
    A.eq(res.cancelledWhile && res.cancelledWhile.phase, 'streaming', which + ' reasoning-only: the interrupted wait was streaming, not first_byte');
  }
  A.report('loop.stream-cut');
})().catch(e => { console.error(e); process.exit(1); });
