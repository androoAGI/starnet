'use strict';
// Exercise the real tutorial entry, choices, timers and event subscriptions without a provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../frontend/app/tutorial.js'), 'utf8');
const essentials = ['cabinet', 'dish', 'workbench', 'notebook', 'studio'];

function fixture(caps = essentials, configured = false, handoff = false) {
  const nodes = [], lines = [], events = {}, timers = new Map(), sent = [];
  let pick, timerId = 0, valueOpens = 0, open = false, activityChanges = 0, handoffOffers = 0;
  let saved = JSON.stringify({ v: 1, firstCommandDone: false, brief: {}, seen: {} });
  const context = vm.createContext({
    console, Promise, AbortController,
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    localStorage: { getItem: () => saved, setItem(_k, v) { saved = v; } },
    App: { heroId: () => 'nova', currentAgent: () => ({ id: 'nova' }) },
    World: { heroCaps() { if (caps === null) throw Error('unavailable'); return caps.map(objectType => ({ objectType })); }, setActivity() { activityChanges++; }, say() {} },
    Build: { open() { throw Error('tour must not open Build'); }, requisition() { throw Error('tour must not place props'); } },
    FirstValue: { open() { valueOpens++; return true; } },
    ...(handoff ? { PitchStore: { handoffPending: () => true, offerHandoff() { handoffOffers++; return handoffOffers === 1 ? Promise.resolve({ action: 'tour' }) : new Promise(() => {}); } } } : {}),
    Harness: { getModel: () => configured ? 'test-model' : '', getProv: () => 'openrouter', configured: () => configured },
    fetch: async () => ({ ok: true, text: async () => 'ok' }),
    Chat: { typeLine(segs, done) { lines.push(segs.map(s => s.text).join('')); if (done) done(); }, localLine(t) { lines.push(t); }, choices() {}, send(t) { sent.push(t); }, isBusy: () => false },
    Dialogue: { open() { open = true; }, close() { open = false; }, isOpen: () => open, setStage() {}, node(n) { nodes.push(n); return new Promise(resolve => { pick = resolve; }); } },
    U: { bus: { on(name, fn) { events[name] = fn; } } },
    document: { querySelector: () => null, getElementById: () => null, body: { contains: () => false, style: {} } },
    window: { addEventListener() {}, removeEventListener() {} }, matchMedia: () => ({ matches: true })
  });
  vm.runInContext(source, context);
  const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  return {
    nodes, lines, sent, timers, events,
    state: () => JSON.parse(saved), valueOpens: () => valueOpens, activityChanges: () => activityChanges, handoffOffers: () => handoffOffers,
    start: () => vm.runInContext('Tutorial.firstCommand({ name: "NOVA" })', context),
    replay: () => vm.runInContext('Tutorial.firstCommand({ name: "NOVA", replay: true })', context),
    async choose(value) { const option = nodes.at(-1).options.find(o => o.value === value); assert.ok(option, 'visible option ' + value); pick(option); await flush(); },
    async fire(ms) { for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); } await flush(); },
    text: () => nodes.at(-1).lines.map(l => l.text).join(''), flush
  };
}

(async () => {
  const full = fixture(); full.start(); await full.choose('tour');
  assert.match(full.text(), /all five essentials are already placed/);
  for (const label of ['FILES', 'WEB', 'TERMINAL', 'MEMORY', 'MEDIA']) assert.ok(full.text().includes(label));
  assert.equal(full.nodes.length, 2, 'welcome goes straight to equipment without repeated narration gates');
  full.events['agent.run.start']({ agentId: 'nova', runId: 'unrelated' });
  full.events['agent.run.end']({ agentId: 'nova', runId: 'unrelated', reason: 'done' });
  assert.equal(full.lines.length, 0, 'ordinary work cannot hijack a tour that did not launch a demo');
  await full.choose('next'); assert.match(full.text(), /Conveyors are optional/);
  assert.match(full.text(), /Esc to cancel/);
  await full.choose('done');
  assert.equal(full.sent.length, 0, 'reading the tour never sends a task');
  assert.equal(full.state().firstCommandDone, true);
  assert.equal(full.state().briefDismissed, true, 'no gear-placement checklist after orientation');
  assert.equal(full.timers.size, 0, 'no delayed connector pitches or build coachmarks');
  assert.equal(full.activityChanges(), 0, 'tour cannot manufacture WORKING or override a real run with IDLE');
  full.replay(); await full.choose('done');
  assert.equal(full.state().brief.command, true, 'replay preserves earned progress');

  for (const caps of [['dish'], [], null]) {
    const f = fixture(caps); f.start(); await f.choose('tour');
    assert.doesNotMatch(f.text(), /all five essentials are already placed/);
    if (caps === null) assert.match(f.text(), /couldn’t read/);
    if (caps && !caps.length) assert.match(f.text(), /no essential equipment in my area/);
    await f.choose('next');
    assert.equal(f.nodes.at(-1).options.some(o => o.value === 'demo'), false, 'file demo only offered with observed file equipment');
    await f.choose('done'); assert.equal(f.timers.size, 0);
  }
  const useful = fixture(); useful.start(); await useful.choose('tour'); await useful.choose('next'); await useful.choose('value');
  assert.equal(useful.valueOpens(), 1); assert.equal(useful.timers.size, 0);
  const unavailable = fixture(); unavailable.start(); await unavailable.choose('tour'); await unavailable.choose('next'); await unavailable.choose('demo');
  assert.equal(unavailable.sent.length, 0); assert.ok(unavailable.lines.some(l => l.includes('hasn’t started')));
  assert.equal(unavailable.state().firstCommandDone, true);

  const demo = fixture(essentials, true); demo.start(); await demo.choose('tour'); await demo.choose('next'); await demo.choose('demo');
  assert.equal(demo.sent.length, 1); assert.match(demo.sent[0], /already exists, read it without changing it/);
  assert.ok(demo.lines.some(l => l.includes('depending on your access settings')));
  demo.events['agent.run.start']({ agentId: 'other', runId: 'other-run' });
  demo.events['agent.run.end']({ agentId: 'other', runId: 'other-run', reason: 'done' });
  assert.equal(demo.state().firstCommandDone, false);
  demo.events['agent.run.start']({ agentId: 'nova', runId: 'demo-run' });
  demo.events['permission.prompt']({ agentId: 'other', promptId: 'other-prompt' });
  demo.events['permission.response']({ promptId: 'other-prompt', decision: 'deny' });
  demo.events['agent.run.end']({ agentId: 'other', runId: 'other-run', reason: 'done' });
  assert.equal(demo.state().firstCommandDone, false, 'other run cannot finish demo');
  demo.events['agent.run.end']({ agentId: 'nova', runId: 'demo-run', reason: 'done' }); await demo.fire(500);
  assert.ok(demo.lines.some(l => l.includes('check the file contents')));
  assert.ok(!demo.lines.some(l => l.includes('denied action')));
  assert.equal(demo.state().firstCommandDone, true);
  assert.equal(demo.timers.size, 0);
  const denied = fixture(essentials, true); denied.start(); await denied.choose('tour'); await denied.choose('next'); await denied.choose('demo');
  denied.events['agent.run.start']({ agentId: 'nova', runId: 'denied-run' });
  denied.events['permission.prompt']({ agentId: 'nova', promptId: 'own-prompt' });
  assert.equal(denied.state().brief.approve, undefined, 'merely seeing a prompt does not earn approval progress');
  denied.events['permission.response']({ promptId: 'own-prompt', decision: 'deny' });
  denied.events['agent.run.end']({ agentId: 'nova', runId: 'denied-run', reason: 'stop' }); await denied.fire(500);
  assert.ok(denied.lines.some(l => l.includes('denied action was blocked')));
  assert.ok(!denied.lines.some(l => l.includes('nothing got written')));
  const stalled = fixture(essentials, true); stalled.start(); await stalled.choose('tour'); await stalled.choose('next'); await stalled.choose('demo'); await stalled.fire(8000);
  assert.ok(stalled.lines.some(l => l.includes('haven’t received a start confirmation')));
  assert.equal(stalled.state().firstCommandDone, true);
  const returning = fixture(essentials, false, true); returning.start(); await returning.flush();
  await returning.choose('next');
  assert.equal(returning.nodes.at(-1).options.some(o => o.value === 'value'), false, 'a pending first task is not replaced by a different form');
  await returning.choose('handoff');
  assert.equal(returning.handoffOffers(), 2, 'tour returns to the existing saved first-task handoff');
  assert.equal(returning.valueOpens(), 0); assert.equal(returning.sent.length, 0, 'returning never auto-starts the saved task');
  console.log('tutorial-equipped-station: equipped/edited/unavailable floors, optional handoffs, quiet completion and demo event ownership PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
