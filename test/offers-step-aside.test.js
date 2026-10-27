/* node test/offers-step-aside.test.js — THE MID-GAME PANELS ARE OFFERS THAT STEP ASIDE (wave-1 comms-owner-arbiter).

   Besides the first-task hand-off (gh#158, test/first-task-handoff-yields.test.js), two more mid-game panels opened over the whole
   of COMMS with no offer: the First Pitch (pitchstore.js fire) and the routine proposals (autojobstore.js propose). Both waited on
   a model call with the message box covered. Executed with the REAL dialogue.js, pitch.js/pitchstore.js and
   autojobs.js/autojobstore.js on a small COMMS column, a model that answers only when told:
     the First Pitch — opens as an offer (message box usable); stepping aside mid-call ABORTS the call, closes the panel and leaves
       it un-pitched; stepping aside on the pitch itself is unanswered (un-pitched, nothing built); Esc on it is its own
       "something else" (pitched, nothing built);
     the routine proposals — open as an offer; stepping aside mid-call aborts it and leaves the proactive offer unspent; stepping
       aside on a proposal defers it (ledger 'deferred'), says no done-line over what the Commander went to, schedules nothing. */
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
  const model = slowModel(), store = memStore(), built = [];
  const s = station({
    sources: ['frontend/app/pitch.js', 'frontend/app/pitchstore.js'],
    globals: { localStorage: store.ls, U: { bus: A.makeBus() }, Harness: model, Chat: { isBusy: () => false, clearNudge() {}, spendAsk() {} },
      DossierStore: { summary: () => ({ known: ['goals', 'identity'], blank: [] }) }, UnderstandingStore: { readiness: () => ({ ready: true, reasons: [] }) },
      Recipes: { list: () => [], get: () => null } }
  });
  const PitchStore = vm.runInContext('PitchStore', s.ctx);
  PitchStore.init({ getSystem: () => 'SYS', getName: () => 'NOVA', getCaps: () => [], getRecentTask: () => 'wrote a file', launchDirective: t => built.push(t), launchRecipe: r => built.push(r) });
  return { s, model, PitchStore, built };
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
  function jobsRig() {
    const model = slowModel(), store = memStore(), scheduled = [], ledger = [];
    model.apiFetch = (url, o) => { ledger.push(JSON.parse(o.body)); return Promise.resolve({ ok: true }); };
    const s = station({
      sources: ['frontend/app/autopilot.js', 'frontend/app/autojobs.js', 'frontend/app/autojobstore.js'],   // autopilot.js: the grounding veto
      globals: { localStorage: store.ls, U: { bus: A.makeBus() }, Harness: model, Chat: { clearNudge() {} },
        DossierStore: { summary: () => ({ known: ['goals', 'pain'], blank: [] }) }, PitchStore: { done: () => true }, AutonomyStore: { summary: () => ({ enabled: true }) } }
    });
    const AutoJobStore = vm.runInContext('AutoJobStore', s.ctx);
    AutoJobStore.init({ getSystem: () => 'SYS', getName: () => 'NOVA', readiness: () => ({ ready: true, reasons: [] }),
      getBeliefs: () => ({ goals: ['ship StarNet'], pain: ['manual standups'] }), getExistingJobs: () => Promise.resolve([]),
      scheduleJob: b => { scheduled.push(b); return Promise.resolve({ ok: true }); }, boardPlaced: () => false, schedulerArmed: () => true });
    return { s, model, AutoJobStore, scheduled, ledger, store };
  }
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
    A.eq(t.AutoJobStore._state().proposed, false, 'the proactive offer is not spent: a later run end can offer it');
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
    A.ok(t.ledger.some(l => l.state === 'deferred'), 'the proposal on screen is deferred (never declined)');
    A.ok(!t.ledger.some(l => l.state === 'declined'), 'and nothing is recorded as declined');
    A.eq(t.AutoJobStore._state().proposed, false, 'the proactive offer is not spent');
  }

  A.report('offers-step-aside');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
