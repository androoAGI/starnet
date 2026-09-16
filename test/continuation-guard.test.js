/* node test/continuation-guard.test.js — the announce-without-acting CONTINUATION GUARD (sidecar/loop.js).
   Some models (Kimi K3, live-caught 2026-07-17) end a turn by ANNOUNCING the next action ("Reading main.js
   now — then fixing.") with finish_reason 'stop' and NO tool call; the loop used to read that as a final
   answer and end the run 'done' mid-task. Proves: an announce turn gets ONE system nudge and the run
   continues to a real delivery; the nudge budget is bounded (a narrate-forever model still terminates);
   a genuine final answer (incl. "let me know…") never nudges; limits.continueGuard === false disables;
   no wired tools = no nudge. Replay provider -> zero spend. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');

const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
const okDispatch = async () => ({ ok: true, isError: false, content: 'ok', summary: 'ok' });
const TOOLS = [{ name: 'thing', description: 't', schema: { type: 'object' } }];
function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { seq, emit };
}
const textTurn = (t) => [{ type: 'text', delta: t }, { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, { type: 'done', finishReason: 'stop' }];
const toolTurn = (i) => [
  { type: 'tool_start', index: 0, id: 'c' + i, name: 'thing' },
  { type: 'tool_args', index: 0, chunk: '{}' },
  { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  { type: 'done', finishReason: 'tool_calls' }
];
// scripted provider: replays `turns` in order (repeats the last one if over-called)
function scripted(turns) {
  let n = 0;
  return { async *stream() { const t = turns[Math.min(n, turns.length - 1)]; n++; for (const ev of t) yield ev; },
           priceOf: () => ({ prompt: '0', completion: '0' }), contextLimit: () => 8000, callCount: () => n };
}
const run = (provider, extra) => runAgentLoop(Object.assign({
  messages: [{ role: 'user', content: 'go' }], provider, emit: setup().emit,
  cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model',
  agentId: 'a', runId: 'r', tools: TOOLS, dispatch: okDispatch, capCtx: openCtx()
}, extra || {}));

(async () => {
  // ---- A. announce turn -> ONE nudge -> the model actually works -> clean 'done' delivery ----
  {
    const provider = scripted([
      textTurn('Reading the full main.js now — then fixing immediately.'),   // the Kimi-style premature stop
      toolTurn(0),
      textTurn('All three bugs are fixed; details above.')
    ]);
    const res = await run(provider);
    A.eq(res.reason, 'done', 'nudged run continues to a real delivery');
    A.eq(provider.callCount(), 3, 'announce + tool + final = 3 model calls');
    const nudges = res.messages.filter(m => m.role === 'system' && /<continuation>/.test(m.content));
    A.eq(nudges.length, 1, 'exactly one continuation nudge injected');
    const last = res.messages.filter(m => m.role === 'assistant').pop();
    A.ok(/fixed/.test(String(last.content)), 'the final assistant answer is the delivery, not the announcement');
  }

  // ---- A2. realistic future-work promises cannot end the run as fake done ----
  for (const phrase of [
    "I'll work on that.",
    "I'll take care of it.",
    "I'll get this done over the next few days.",
    "I'm going to work on it."
  ]) {
    const provider = scripted([textTurn(phrase), toolTurn(0), textTurn('The durable work item is created and visible now.')]);
    const res = await run(provider);
    A.eq(provider.callCount(), 3, phrase + ' is nudged into a real tool call before delivery');
    const nudges = res.messages.filter(m => m.role === 'system' && /<continuation>/.test(m.content));
    A.eq(nudges.length, 1, phrase + ' receives exactly one continuation nudge');
    A.ok(/durable routine\/task/.test(nudges[0].content), phrase + ' is told to create durable future work rather than promise it');
  }

  // ---- B. narrate-forever model: nudge budget (default 2) bounds it -> terminates 'done' ----
  {
    const provider = scripted([
      textTurn('Let me read main.js first.'),
      textTurn('Now checking the death path.'),
      textTurn('I will fix the pointer lock next.')   // third announce: budget spent -> ends
    ]);
    const res = await run(provider);
    A.eq(res.reason, 'error', 'a narrate-forever run ends as incomplete, never done');
    A.eq(res.failureCode, 'incomplete_work', 'durable failure identifies the exhausted continuation');
    A.ok(/Work is incomplete/.test(res.text), 'the final transcript explains the stop');
    A.eq(provider.callCount(), 3, 'exactly CG_MAX(2) extra turns, not an unbounded spin');
    const nudges = res.messages.filter(m => m.role === 'system' && /<continuation>/.test(m.content));
    A.eq(nudges.length, 2, 'nudge budget is exactly 2 per run');
  }

  // ---- C. a genuine final answer never nudges — incl. the "let me know" closing pleasantry ----
  {
    const provider = scripted([toolTurn(0), textTurn('Done — the fix is in place. Let me know if anything else breaks.')]);
    const res = await run(provider);
    A.eq(res.reason, 'done', 'clean delivery stays done');
    A.eq(provider.callCount(), 2, 'no nudge fired on a real final answer');
  }

  // ---- D. limits.continueGuard === false restores the old stop-on-text behavior ----
  {
    const provider = scripted([textTurn('Reading the full main.js now.')]);
    const res = await run(provider, { limits: { continueGuard: false } });
    A.eq(res.reason, 'done', 'guard disabled: announce turn ends the run');
    A.eq(provider.callCount(), 1, 'no extra turn when disabled');
  }

  // ---- E. no wired tools = nothing to nudge toward -> never fires ----
  {
    const provider = scripted([textTurn('Let me check the logs now.')]);
    const res = await run(provider, { tools: [] });
    A.eq(res.reason, 'done', 'tool-less run ends normally');
    A.eq(provider.callCount(), 1, 'no nudge without tools');
  }

  // ---- F. guard never overrides the grace turn's tool-free contract ----
  {
    // turn0: tool (hits maxIters:1) -> grace turn announces instead of answering -> must still END, not loop
    const provider = scripted([toolTurn(0), textTurn('Let me read one more file now.')]);
    const res = await run(provider, { limits: { maxIters: 1 } });
    A.eq(res.reason, 'error', 'an announcement on the grace turn cannot assert completion');
    A.eq(provider.callCount(), 2, 'no continuation nudge after grace');
    const nudges = res.messages.filter(m => m.role === 'system' && /<continuation>/.test(m.content));
    A.eq(nudges.length, 0, 'guard is suppressed on the grace turn');
  }

  {
    const provider = scripted([textTurn("I'll work on that.")]);
    const s = setup();
    const res = await run(provider, { emit: s.emit });
    A.eq(provider.callCount(), 3, 'identical promises consume the bounded continuation budget');
    A.eq(res.reason, 'error', 'duplicate detection cannot turn an unfulfilled promise into done');
    A.ok(/Work is incomplete/.test(res.text), 'duplicate exhaustion explains why it stopped');
    A.ok(s.seq.some(e => e.name === 'agent.run.error'), 'the error reaches the normal UI/channel seam');
  }
  {
    const provider = scripted([textTurn("I've saved your design preferences.")]);
    const res = await run(provider, {tools:[{name:'notebook_write',schema:{type:'object'}}]});
    A.eq(res.reason, 'error', 'unsupported save claims cannot pass as done');
    A.eq(res.failureCode, 'memory_write_unverified', 'missing save receipt is a specific failure');
    A.eq(provider.callCount(), 3, 'save verification has bounded retries');
    A.ok(/not confirmed/.test(res.text), 'the final reply corrects the unsupported save claim');
  }
  {
    const provider = scripted([textTurn('The example says "I saved your preferences." It is quoted text.')]);
    const res = await run(provider, {tools:[{name:'notebook_write',schema:{type:'object'}}]});
    A.eq(res.reason, 'done', 'quoted save examples are not first-person receipts');
    A.eq(provider.callCount(), 1, 'quoted examples do not trigger verification');
  }
  console.log('continuation-guard.test: OK');
  // report() settles the assertion counter. The .catch below only fires on a THROWN error, so
  // without this every one of the assertions above could fail and the file would still exit 0.
  A.report('continuation-guard.test');
})().catch(e => { console.error(e); process.exit(1); });
