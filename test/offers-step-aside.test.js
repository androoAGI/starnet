/* node test/offers-step-aside.test.js — THE MID-GAME PANELS ARE OFFERS THAT STEP ASIDE (wave-1 comms-owner-arbiter).

   Besides the first-task hand-off (gh#158, test/first-task-handoff-yields.test.js), two more mid-game panels opened over the whole
   of COMMS with no offer: the First Pitch (pitchstore.js fire) and the routine proposals (autojobstore.js propose). Both waited on
   a model call with the message box covered. Executed with the REAL dialogue.js, pitch.js/pitchstore.js and
   autojobs.js/autojobstore.js on a small COMMS column, a model that answers only when told:
     the First Pitch — opens as an offer (message box usable); stepping aside mid-call ABORTS the call, closes the panel and leaves
       it un-pitched; stepping aside on the pitch itself is unanswered (un-pitched, nothing built); Esc on it is its own
       "something else" (pitched, nothing built);
     the routine proposals — open as an offer; stepping aside mid-call aborts it and leaves the proactive offer unspent; stepping
       aside on a proposal records no answer for the Commander (its ledger row stays 'shown'), says no done-line over what the
       Commander went to, schedules nothing;
   and the review fixes (10-27):
     never a nag loop — an offer that stepped aside is not offered again this session: later run ends make no model call
       (a pitch that reached the screen also spends its unit of the session ask budget);
     the honest done-line survives — Esc on a later proposal leaves "scheduling is OFF" on screen to be read, and a step-aside
       after something was scheduled leaves that line in the transcript; an offer answered in part is spent. */
'use strict';
const A = require('./_assert.js');
const vm = require('node:vm');
const { station, settle } = require('./helpers/comms-dom.js');

const wait = ms => new Promise(r => setTimeout(r, ms));
// a model that answers when told; an aborted call rejects the way fetch does
function slowModel() {
  const m = { calls: [], answer: null };
  m.chat = args => { const call = { args, done: null }; m.calls.push(call);
    return new Promise((resolve, reject) => {
      call.done = resolve;
      if (args.signal) args.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }, { once: true });
      if (m.answer) resolve(m.answer);
    }); };
  m.configured = () => true;
  return m;
}
const memStore = () => { const mem = {}; return { mem, ls: { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } } }; };

function pitchRig() {
  const model = slowModel(), store = memStore(), built = [], asks = [];
  const bus = A.makeBus();
  const s = station({
    sources: ['frontend/app/pitch.js', 'frontend/app/pitchstore.js'],
    globals: { localStorage: store.ls, U: { bus }, Harness: model, Chat: { isBusy: () => false, isComposerEngaged: () => false, clearNudge() {}, spendAsk() { asks.push(1); }, askBudgetSpent: () => false },
      DossierStore: { summary: () => ({ known: ['goals', 'identity'], blank: [] }) }, UnderstandingStore: { readiness: () => ({ ready: true, reasons: [] }) },
      Recipes: { list: () => [], get: () => null } }
  });
  const PitchStore = vm.runInContext('PitchStore', s.ctx);
  PitchStore.init({ getSystem: () => 'SYS', getName: () => 'NOVA', getCaps: () => [], getRecentTask: () => 'wrote a file', launchDirective: t => built.push(t), launchRecipe: r => built.push(r), settleMs: 5 });
  return { s, model, PitchStore, built, bus, asks };
}
const PITCH = 'PITCH: a custom invoice sorter\nWHY: you do it by hand\nBUILD: workflow\nGAP: where the invoices live';

(async () => {
  /* ---------- the First Pitch ---------- */
  {
    const t = pitchRig();
    const fired = t.PitchStore._fire({ reason: 'done', agentId: 'agent', runId: 'r1' });
    await wait(320); await settle();   // the latency line auto-advances, then the model call goes out
    A.ok(t.s.panel() && t.s.panel().classList.contains('fnv-offer'), 'the First Pitch opens as an OFFER');
    A.ok(t.s.inputUsable(), 'the message box stays usable while it thinks');
    A.eq(t.model.calls.length, 1, 'the reason-only call is out');
    const sig = t.model.calls[0] && t.model.calls[0].args.signal;
    A.ok(sig && typeof sig.aborted === 'boolean', 'the call carries an abort signal');
    A.eq(t.s.D.preempt('session'), true, 'the Commander picking a conversation steps it aside');
    await Promise.race([fired, wait(200)]); await settle();
    A.ok(sig && sig.aborted, 'the model call still in flight is ABORTED (no tokens spent on a pitch nobody will see)');
    A.eq(t.s.D.isOpen(), false, 'the panel is gone');
    A.eq(t.PitchStore.done(), false, 'un-pitched: a later run end offers it again');
    A.eq(t.built, [], 'nothing built');
  }
  {
    const t = pitchRig();
    t.model.answer = { text: PITCH };
    const fired = t.PitchStore._fire({ reason: 'done', agentId: 'agent', runId: 'r2' });
    await wait(320); await settle();
    A.ok(t.s.find('fnv-opt').some(e => /let.s build it/.test(e.textContent)), 'the pitch is on screen with its keys');
    A.eq(t.s.D.preempt('ask'), true, 'an approval reaching the Commander steps the pitch aside');
    await Promise.race([fired, wait(200)]); await settle();
    A.eq(t.s.D.isOpen(), false, 'the panel is gone');
    A.eq(t.PitchStore.done(), false, 'unanswered is not a decline: still un-pitched');
    A.eq(t.built, [], 'nothing built');
    A.eq(t.asks.length, 1, 'a pitch that reached the screen spends its unit of the session ask budget, answered or not');
    // NEVER A NAG LOOP: the hero's next task run ends: this session it is not pitched again (no model call, no panel)
    for (let n = 0; n < 3; n++) { t.bus.emit('agent.run.end', { reason: 'done', agentId: 'agent', runId: 'later' + n }); await wait(30); await settle(); }
    await wait(400); await settle();   // long enough for a re-fire's latency line to end and its model call to go out
    A.eq(t.PitchStore._decide({ reason: 'done', agentId: 'agent', runId: 'x' }).reason, 'stepped-aside', 'decide: a pitch stepped aside this session stands down');
    A.eq(t.model.calls.length, 1, 'three later run ends make no new model call');
    A.eq(t.s.D.isOpen(), false, 'and open no panel');
    A.eq(await t.PitchStore.offerAtHandoff('later0'), false, 'the tour-close door honours it too');
    t.PitchStore.reset();
    A.ok(t.PitchStore._decide({ reason: 'done', agentId: 'agent', runId: 'x' }).reason !== 'stepped-aside', 'a new hero (reset) starts a fresh session latch');
  }
  {
    const t = pitchRig();
    t.model.answer = { text: PITCH };
    const fired = t.PitchStore._fire({ reason: 'done', agentId: 'agent', runId: 'r3' });
    await wait(320); await settle();
    const ev = t.s.key('Escape');
    A.eq(ev.defaultPrevented, true, 'Esc on the pitch is the offer’s');
    await Promise.race([fired, wait(200)]); await settle();
    A.eq(t.s.D.isOpen(), false, 'Esc closes it');
    A.eq(t.PitchStore.done(), true, 'as its own "something else": the one-time pitch was delivered and answered');
    A.eq(t.built, [], 'nothing built');
  }

  /* ---------- the routine proposals ---------- */
  const TWO = ['JOB: Standup draft', 'WHY: kills the standup pain', 'GROUNDS: manual standups', 'CADENCE: morning', 'RUN: Draft the standup from what you know.',
    '', 'JOB: Ship nudge', 'WHY: advances the goal', 'GROUNDS: ship StarNet', 'CADENCE: weekly', 'RUN: Draft the next ship step.'].join('\n');
  function jobsRig(o) {
    o = o || {};
    const model = slowModel(), store = memStore(), scheduled = [], ledger = [], lines = [];
    const bus = A.makeBus();
    model.apiFetch = (url, o2) => { ledger.push(JSON.parse(o2.body)); return Promise.resolve({ ok: true }); };
    const s = station({
      sources: ['frontend/app/autopilot.js', 'frontend/app/autojobs.js', 'frontend/app/autojobstore.js'],   // autopilot.js: the grounding veto
      globals: { localStorage: store.ls, U: { bus }, Harness: model, Chat: { clearNudge() {}, localLine: l => lines.push(l) },
        DossierStore: { summary: () => ({ known: ['goals', 'pain'], blank: [] }) }, PitchStore: { done: () => true }, AutonomyStore: { summary: () => ({ enabled: true }) } }
    });
    const AutoJobStore = vm.runInContext('AutoJobStore', s.ctx);
    AutoJobStore.init({ getSystem: () => 'SYS', getName: () => 'NOVA', readiness: () => ({ ready: true, reasons: [] }),
      getBeliefs: () => ({ goals: ['ship StarNet'], pain: ['manual standups'] }), getExistingJobs: () => Promise.resolve([]),
      scheduleJob: b => { scheduled.push(b); return Promise.resolve({ ok: true }); }, boardPlaced: () => false, schedulerArmed: () => (o.armed === undefined ? true : o.armed) });
    return { s, model, AutoJobStore, scheduled, ledger, store, bus, lines };
  }
  const onScreen = (t, re) => t.s.find('fnv-dialogue').some(e => re.test(e.textContent));
  {
    const t = jobsRig();
    const p = t.AutoJobStore.propose({ proactive: true });
    await wait(320); await settle();
    A.ok(t.s.panel() && t.s.panel().classList.contains('fnv-offer'), 'the routine proposals open as an OFFER');
    A.ok(t.s.inputUsable(), 'the message box stays usable while it thinks');
    const sig = t.model.calls[0] && t.model.calls[0].args.signal;
    A.ok(sig, 'the call carries an abort signal');
    A.eq(t.s.D.preempt('turn'), true, 'the Commander’s own turn steps it aside');
    const r = await Promise.race([p, wait(200).then(() => 'still waiting')]);
    A.ok(sig && sig.aborted, 'the model call is aborted');
    A.eq(r && r.scheduled, 0, 'nothing scheduled');
    A.eq(t.s.D.isOpen(), false, 'the panel is gone');
    A.eq(t.AutoJobStore._state().proposed, false, 'the proactive offer is not spent: a later session can offer it');
    // NEVER A NAG LOOP (review 10-27): the hero's later run ends this session do not re-fire it
    for (let n = 0; n < 3; n++) { t.bus.emit('agent.run.end', { reason: 'done', agentId: 'agent', runId: 'later' + n }); await wait(30); await settle(); }
    await wait(400); await settle();   // long enough for a re-fire's latency line to end and its model call to go out
    A.eq(t.AutoJobStore._decide({ reason: 'done', agentId: 'agent' }).reason, 'stepped-aside', 'decide: an offer stepped aside this session stands down');
    A.eq(t.model.calls.length, 1, 'three later run ends make no new model call');
    A.eq(t.s.D.isOpen(), false, 'and open no panel');
    t.AutoJobStore.reset();
    A.ok(t.AutoJobStore._decide({ reason: 'done', agentId: 'agent' }).reason !== 'stepped-aside', 'a new hero (reset) starts a fresh session latch');
  }
  {
    const t = jobsRig();
    t.model.answer = { text: TWO };
    const p = t.AutoJobStore.propose({ proactive: true });
    await wait(320); await settle();
    t.s.key(' ');   // the Commander reads the intro line on
    await wait(30); await settle();
    A.ok(t.s.find('fnv-opt').some(e => /schedule it/.test(e.textContent)), 'the first proposal is on screen');
    A.eq(t.s.D.preempt('session'), true, 'picking another conversation steps the proposals aside');
    const r = await Promise.race([p, wait(300).then(() => 'still waiting')]);
    A.eq(r && r.scheduled, 0, 'nothing scheduled');
    A.eq(t.s.D.isOpen(), false, 'the panel is gone, with no done-line over the conversation the Commander chose');
    A.ok(t.ledger.some(l => l.surface === 'routine' && !l.state), 'the proposal on screen was recorded as shown');
    A.eq(t.ledger.filter(l => l.state).map(l => l.state), [], 'and NO answer is recorded for the Commander: not deferred, not declined (the row stays shown)');
    A.eq(t.lines, [], 'nothing was scheduled, so nothing is left in the transcript');
    A.eq(t.AutoJobStore._state().proposed, false, 'the proactive offer is not spent');
  }
  /* the honest done-line survives Esc: schedule the first, Esc on the second, scheduling OFF */
  {
    const t = jobsRig({ armed: false });
    t.model.answer = { text: TWO };
    const p = t.AutoJobStore.propose({ proactive: true });
    await wait(320); await settle();
    t.s.key(' '); await wait(30); await settle();   // read the intro line on
    const yes = t.s.find('fnv-opt').find(e => /schedule it/.test(e.textContent));
    A.ok(!!yes, 'proposal 1 is on screen');
    if (yes) yes.click();
    await wait(30); await settle();
    A.eq(t.scheduled.length, 1, 'proposal 1 is scheduled');
    A.ok(t.s.find('fnv-opt').some(e => /schedule it/.test(e.textContent)), 'proposal 2 is on screen');
    const ev = t.s.key('Escape');
    A.eq(ev.defaultPrevented, true, 'Esc on proposal 2 is the offer’s "leave it — not now"');
    await wait(80); await settle();
    A.eq(t.s.D.isOpen(), true, 'the panel stays to say what happened (it used to close at once)');
    A.ok(onScreen(t, /scheduling is OFF/), 'the honest line is on screen: saved, but scheduling is OFF so it won’t run yet');
    const r = await Promise.race([p, wait(60).then(() => 'still waiting')]);
    A.eq(r, 'still waiting', 'and waits for the Commander to read it');
    t.s.key(' '); await wait(30); await settle();
    const r2 = await Promise.race([p, wait(200).then(() => 'still waiting')]);
    A.eq(r2 && r2.scheduled, 1, 'read on, it closes: one routine scheduled');
    A.eq(t.s.D.isOpen(), false, 'the panel is gone');
    A.eq(t.AutoJobStore._state().proposed, true, 'a delivered offer is spent');
  }
  /* ...and survives a step-aside: schedule the first, a session pick on the second, scheduling OFF */
  {
    const t = jobsRig({ armed: false });
    t.model.answer = { text: TWO };
    const p = t.AutoJobStore.propose({ proactive: true });
    await wait(320); await settle();
    t.s.key(' '); await wait(30); await settle();
    const yes = t.s.find('fnv-opt').find(e => /schedule it/.test(e.textContent));
    if (yes) yes.click();
    await wait(30); await settle();
    A.eq(t.s.D.preempt('session'), true, 'the Commander picks another conversation on proposal 2');
    const r = await Promise.race([p, wait(200).then(() => 'still waiting')]);
    A.eq(r && r.scheduled, 1, 'one routine scheduled');
    A.eq(t.s.D.isOpen(), false, 'the panel is gone over the conversation they chose');
    A.eq(t.lines.length, 1, 'the done-line is left in the transcript instead of never being said');
    A.ok(/scheduling is OFF/.test(t.lines[0] || ''), 'and it is the honest one: ' + (t.lines[0] || ''));
    A.eq(t.AutoJobStore._state().proposed, true, 'an offer answered in part was delivered: spent, so its declined or scheduled jobs are not offered again');
  }

  A.report('offers-step-aside');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
