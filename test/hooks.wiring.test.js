/* node test/hooks.wiring.test.js — THE HOOK CALL SITES.

   A spine nothing calls is decoration. These assertions pin WHERE each hook fires and, for pre_tool_call,
   the position that is the entire security argument: it sits AFTER the capability gate and the consent
   broker, so a hook can only ever take away a permission the station had already granted — never add one. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeHooks } = require('../sidecar/hooks.js');

const SCHEMA = { type: 'object', properties: { path: { type: 'string' } } };
const openCtx = (extra) => Object.assign({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }, extra || {});

function toolTurnFixture(name) {
  return { turns: [
    [{ type: 'tool_start', index: 0, id: 'c1', name }, { type: 'tool_args', index: 0, chunk: '{"path":"a.js"}' }, { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }]
  ] };
}
function reg(onRun) {
  const r = makeRegistry();
  r.register({ name: 'fs_write', schema: SCHEMA, requiresConsent: true, run: async (a) => { if (onRun) onRun(a); return 'wrote ' + a.path; } });
  return r;
}
async function run(o) {
  const bus = A.makeBus();
  const emit = makeEmitter(bus, () => {});
  const seq = A.collectBus(bus, events.names());
  const provider = makeReplayProvider(o.fixture || toolTurnFixture('fs_write'));
  const messages = [{ role: 'user', content: 'go' }];
  const res = await runAgentLoop({
    messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: 'a', runId: 'r1', tools: [], limits: { maxIters: 6, grace: false },
    dispatch: (c, ctx) => o.registry.dispatch(c, ctx), capCtx: o.capCtx, hooks: o.hooks, clock: { now: () => Date.now() }
  });
  return { res, messages, seq };
}

(async () => {
  // ---- 1. pre_tool_call CAN DENY: the tool never runs, and the model is told why and by whom ----
  {
    const h = makeHooks();
    h.register('pre_tool_call', (p) => (p.tool_name === 'fs_write' ? { decision: 'block', reason: 'src/ is frozen today' } : null), { name: 'freeze' });
    let ran = false;
    const registry = reg(() => { ran = true; });
    const { messages } = await run({ registry, capCtx: openCtx({ hooks: h, runId: 'r1' }), hooks: h });
    A.eq(ran, false, 'a blocked tool NEVER runs — the block is before execution, not a filter on the result');
    const toolMsg = messages.find(m => m.role === 'tool');
    A.ok(/blocked by your hook/.test(toolMsg.content), 'the model is told a hook blocked it, not that the tool broke');
    A.ok(/`freeze`/.test(toolMsg.content), 'and the hook is NAMED, so the Commander knows which script to edit');
    A.ok(/src\/ is frozen today/.test(toolMsg.content), 'the reason reaches the model so it can adapt instead of retrying');
  }

  // ---- 2. THE POSITION IS THE SECURITY ARGUMENT: hooks run INSIDE the gates ----
  {
    // A capability DENY must return before any hook is consulted — otherwise a hook that answers "allow"
    // would be sitting in front of the gate, which is the escalation hooks.js exists to prevent.
    const h = makeHooks();
    let hookSaw = 0;
    h.register('pre_tool_call', () => { hookSaw++; return { decision: 'allow', approve: true }; }, { name: 'permissive' });
    let ran = false;
    const registry = reg(() => { ran = true; });
    const denied = openCtx({ hooks: h, runId: 'r1', canUse: () => ({ ok: false, reason: 'no cabinet in the room' }) });
    const { messages } = await run({ registry, capCtx: denied, hooks: h });
    A.eq(hookSaw, 0, 'a capability-denied call never even reaches the hook — the gate answered first');
    A.eq(ran, false, 'and the tool still did not run');
    A.ok(/capability denied/.test(messages.find(m => m.role === 'tool').content), 'the gate owns the refusal message');

    // Same for consent: a hook cannot pre-approve something the Commander refused.
    const h2 = makeHooks();
    let seen2 = 0;
    h2.register('pre_tool_call', () => { seen2++; return { decision: 'allow' }; }, { name: 'permissive' });
    let ran2 = false;
    const r2 = reg(() => { ran2 = true; });
    const { messages: m2 } = await run({ registry: r2, capCtx: openCtx({ hooks: h2, runId: 'r1', consent: async () => ({ allow: false, reason: 'the Commander said no' }) }), hooks: h2 });
    A.eq(seen2, 0, 'a consent-denied call never reaches the hook either');
    A.eq(ran2, false, 'and no hook return value can revive it');
    A.ok(/consent denied/.test(m2.find(m => m.role === 'tool').content), 'consent owns its own refusal message');
  }

  // ---- 3. post_tool_call OBSERVES a real result and cannot retract it ----
  {
    const h = makeHooks();
    const seen = [];
    h.register('post_tool_call', (p) => { seen.push(p); return { decision: 'block', reason: 'too late' }; }, { name: 'observer' });
    const { messages } = await run({ registry: reg(), capCtx: openCtx({ hooks: h, runId: 'r1' }), hooks: h });
    A.eq(seen.length, 1, 'post_tool_call fires once per call');
    A.eq(seen[0].extra.status, 'ok', 'it is told whether the call succeeded');
    A.eq(seen[0].extra.result, 'wrote a.js', 'and what the result actually was');
    A.eq(seen[0].tool_input.path, 'a.js', 'plus the input that produced it');
    A.ok(/wrote a\.js/.test(messages.find(m => m.role === 'tool').content), 'its block attempt changed nothing — the result stands');
  }

  // ---- 4. pre_llm_call INJECTS the Commander's standing brief, once, not once per turn ----
  {
    const h = makeHooks();
    let calls = 0;
    h.register('pre_llm_call', () => { calls++; return { context: 'deploy freeze until Friday' }; }, { name: 'brief' });
    const { messages } = await run({ registry: reg(), capCtx: openCtx({ hooks: h, runId: 'r1' }), hooks: h });
    A.eq(calls, 2, 'it fires on every model call');
    const injected = messages.filter(m => m.role === 'system' && /<hook_context>/.test(String(m.content)));
    A.eq(injected.length, 1, 'but an UNCHANGED brief is injected once — not stacked once per turn');
    A.ok(/deploy freeze until Friday/.test(injected[0].content), 'the brief reaches the prompt verbatim');

    // A brief that CHANGES lands again — that is the whole point of a per-turn hook.
    const h2 = makeHooks();
    let n = 0;
    h2.register('pre_llm_call', () => ({ context: 'tick ' + (++n) }), { name: 'ticker' });
    const r2 = await run({ registry: reg(), capCtx: openCtx({ hooks: h2, runId: 'r1' }), hooks: h2 });
    A.eq(r2.messages.filter(m => /<hook_context>/.test(String(m.content))).length, 2, 'changed context is injected each time it changes');
  }

  // ---- 5. pre_llm_call CAN STOP A RUN, and the stop names the hook ----
  {
    const h = makeHooks();
    h.register('pre_llm_call', () => ({ action: 'block', message: 'out of hours' }), { name: 'curfew' });
    const { res, seq } = await run({ registry: reg(), capCtx: openCtx({ hooks: h, runId: 'r1' }), hooks: h });
    A.eq(res.reason, 'error', 'a blocked model call ends the run rather than silently continuing');
    const err = seq.filter(e => e.name === 'agent.run.error').pop();
    A.ok(/curfew/.test(err.payload.message) && /out of hours/.test(err.payload.message), 'the run error names the hook and its reason, so it reads as policy not a fault');
  }

  // ---- 6. post_llm_call fires once per MODEL CALL — including the final, tool-free answer turn ----
  {
    const h = makeHooks();
    const seen = [];
    h.register('post_llm_call', (p) => { seen.push(p.extra); }, { name: 'meter' });
    await run({ registry: reg(), capCtx: openCtx({ hooks: h, runId: 'r1' }), hooks: h });
    A.eq(seen.length, 2, 'both the tool turn AND the final answer turn are observed');
    A.eq(seen[1].finish_reason, 'stop', 'the last one carries the real finish reason');
    A.ok(typeof seen[0].usd === 'number', 'cost is already reconciled when the hook sees it, so the number is honest');
  }

  // ---- 7. NO HOOKS WIRED = byte-identical to before. Every aux loop and every existing test lands here. ----
  {
    let ran = false;
    const { res, messages } = await run({ registry: reg(() => { ran = true; }), capCtx: openCtx({ runId: 'r1' }) });
    A.eq(ran, true, 'the tool runs normally');
    A.eq(res.reason, 'done', 'the run completes normally');
    A.eq(messages.some(m => /<hook_context>/.test(String(m.content))), false, 'and nothing is injected');
  }

  // ---- 8. A BROKEN HOOK AT A CALL SITE MUST NOT TAKE THE RUN DOWN ----
  {
    const h = makeHooks({ onError: () => {} });
    h.register('pre_tool_call', () => { throw new Error('bad script'); }, { name: 'broken' });
    h.register('post_tool_call', () => { throw new Error('also bad'); }, { name: 'broken2' });
    h.register('pre_llm_call', () => { throw new Error('worse'); }, { name: 'broken3' });
    let ran = false;
    const { res } = await run({ registry: reg(() => { ran = true; }), capCtx: openCtx({ hooks: h, runId: 'r1' }), hooks: h });
    A.eq(ran, true, 'the tool still ran');
    A.eq(res.reason, 'done', 'and the run still finished — a throwing hook is fail-open at every site');
  }

  /* ---- 9. NO DEAD EVENTS. The panel offers every event hooks.js declares, so an event that nothing FIRES is
       a menu item whose hook silently never runs — with nothing on screen to say why. That is the exact
       failure mode a hook must never have, and it shipped: subagent_stop and on_memory_write were declared,
       listed in the dropdown, and emitted by nobody. This asserts the two lists match, in the source, so the
       next event added cannot reach the picker without a call site. ---- */
  {
    const { readSidecarSource } = require('./helpers/source');
    // Every sidecar file (today the call sites are loop.js, index.js, tools/registry.js, subagents.js and
    // tools/builtin/notebook.js), so a call site that moves into a new module is still found — a fixed list of five
    // files turned the gate red the moment the code firing on_session_start left index.js. hooks.js is left out: it
    // declares the events and defines invoke(), and an example in its comments must never count as a call site.
    const src = readSidecarSource({ except: ['sidecar/hooks.js'] });
    const declared = require('../sidecar/hooks.js').EVENTS;
    const dead = declared.filter(e => src.indexOf("invoke('" + e + "'") < 0);
    A.eq(dead.join(',') || '(none)', '(none)', 'every declared hook event is fired by a real call site — a dead event is a menu item that silently does nothing');
    A.eq(declared.length, 9, 'the event list is the size the UI and docs describe');
  }

  A.report('hooks.wiring.test');
})().catch(e => { console.log('FAIL: hooks.wiring.test threw -- ' + (e && e.stack || e)); process.exit(1); });
