/* node test/comms-owner-rules.test.js — THE COMMS OWNER ARBITER (wave-1 B8 comms-owner-arbiter, gh#158).

   The Dialogue panel is the one surface that stands over COMMS, and many modules open it. Before the arbiter, whether it gave
   COMMS back was decided per caller: the goal path stepped aside for an approval, the hand-off never did, the tour yielded only
   to an INBOX click. Now ONE table (Dialogue.OWNER_RULES) answers it for every panel, by the owner kind fixed when it opened:
       ceremony (the awakening)  — holds everything: it IS the conversation;
       tour (the quick tour)     — yields a session pick through its own way out; holds a turn and an ask;
       offer (anything mid-game) — yields all three, unanswered.
   This executes every cell with the REAL dialogue.js on a small COMMS column, then proves the callers route through it:
   chat.js's one step-aside goes to Dialogue.preempt, app.js's pick paths ask it even when the pick lands on the conversation
   already on screen, and every tour beat in tutorial.js opens as the tour and ends quietly when the Commander puts another
   conversation on screen. */
'use strict';
const A = require('./_assert.js');
const vm = require('node:vm');
const { station, settle, read } = require('./helpers/comms-dom.js');

const ACTIONS = ['session', 'turn', 'ask'];
const EXPECT = { ceremony: { session: 'hold', turn: 'hold', ask: 'hold' }, tour: { session: 'yield', turn: 'hold', ask: 'hold' }, offer: { session: 'yield', turn: 'yield', ask: 'yield' } };

(async () => {
  /* ---------- 1. the table ---------- */
  {
    const s = station();
    const R = s.D.OWNER_RULES;
    A.ok(R && typeof s.D.preempt === 'function', 'dialogue.js exports the arbiter (OWNER_RULES + preempt)');
    A.eq(R && Object.keys(R).sort(), ['ceremony', 'offer', 'tour'], 'three owner kinds, no more');
    for (const kind of Object.keys(EXPECT)) A.eq(R && R[kind] && JSON.parse(JSON.stringify(R[kind])), EXPECT[kind], 'the ' + kind + ' row: ' + JSON.stringify(EXPECT[kind]));
    A.ok(R && Object.isFrozen(R) && Object.isFrozen(R.offer), 'the table is frozen: no caller rewrites the rules at run time');
  }

  /* ---------- 2. every cell, executed ---------- */
  const OPTIONS = [{ label: 'NEXT', value: 'next' }, { label: 'Finish tour', value: 'done', skip: true }];
  for (const kind of Object.keys(EXPECT)) {
    for (const action of ACTIONS) {
      const s = station();
      const asides = [];
      const openOpts = kind === 'offer' ? { name: 'NOVA', offer: { notNow() {}, stepAside: w => asides.push(w) } }
        : kind === 'tour' ? { name: 'NOVA', tour: true } : { name: 'NOVA' };
      s.D.open(openOpts);
      let picked = null;
      s.D.node({ lines: 'pick one', options: OPTIONS }).then(r => { picked = r; });
      await settle();
      A.eq(s.D.owner && s.D.owner(), kind, kind + ': the panel knows its owner');
      const yielded = s.D.preempt(action);
      await settle();
      const want = EXPECT[kind][action] === 'yield';
      A.eq(yielded, want, kind + ' × ' + action + ' → ' + EXPECT[kind][action]);
      if (kind === 'offer') A.eq(asides, want ? [action] : [], 'offer × ' + action + ': the caller is told why it stepped aside');
      if (kind === 'tour') {
        if (want) A.ok(picked && picked.skip === true && picked.preempted === action, 'tour × ' + action + ': answered through its own way out, marked preempted: ' + JSON.stringify(picked));
        else A.eq(picked, null, 'tour × ' + action + ': the beat is left unanswered');
      }
      if (kind === 'ceremony') {
        A.eq(picked, null, 'ceremony × ' + action + ': the awakening is never answered for the Commander');
        A.ok(s.D.isOpen() && s.panel(), 'ceremony × ' + action + ': it keeps COMMS');
      }
      s.D.close();
      A.eq(s.D.preempt(action), false, kind + ' × ' + action + ': with nothing open the arbiter is a no-op');
      A.eq(s.D.owner(), null, 'a closed panel has no owner');
    }
  }
  {
    // owner:'tour' (the kit-out beats) is the tour's owner without the tour's layout class
    const s = station();
    s.D.open({ name: 'NOVA', owner: 'tour' });
    A.eq(s.D.owner(), 'tour', 'owner:\'tour\' opens a tour-owned panel');
    A.ok(!s.panel().classList.contains('fnv-tour'), 'without changing its layout (fnv-tour stays the tour:true layout class)');
    let picked = null;
    s.D.node({ lines: 'continue the optional tour?', options: [{ label: '▸ CONTINUE THE TOUR', value: 'go' }, { label: 'Skip for now', value: 'skip', skip: true }] }).then(r => { picked = r; });
    await settle();
    A.eq(s.D.preempt('session'), true, 'a kit-out beat yields a session pick like every tour beat');
    await settle();
    A.ok(picked && picked.preempted === 'session' && picked.skip, 'through its skip key, marked preempted');
    s.D.close();
  }
  {
    // the INBOX door's yieldTour() (no reason) keeps its old meaning: the tour's own way out, NOT a preemption
    const s = station();
    s.D.open({ name: 'NOVA', tour: true });
    let picked = null;
    s.D.node({ lines: 'tour', options: [{ label: '▸ CONTINUE MY FIRST TASK', value: 'handoff', yield: true }] }).then(r => { picked = r; });
    await settle();
    A.eq(s.D.yieldTour(), true, 'yieldTour() still answers the tour’s yield key');
    await settle();
    A.ok(picked && picked.value === 'handoff' && !('preempted' in picked), 'unmarked: the tour goes back to the first task as before');
    s.D.close();
  }
  {
    // a re-open hands COMMS to the new owner: an offer re-opened as a tour beat no longer steps aside for a turn
    const s = station();
    s.D.open({ name: 'NOVA', offer: { notNow() {}, stepAside() {} } });
    s.D.open({ name: 'NOVA', tour: true });
    A.eq(s.D.owner(), 'tour', 'a re-open takes the new owner');
    A.eq(s.D.preempt('turn'), false, 'and the new owner’s rules');
    s.D.close();
  }

  /* ---------- 3. chat.js: the one step-aside routes through the arbiter ---------- */
  {
    const chat = read('frontend/app/chat.js');
    const fn = A.fnBody(chat, '  function stepOfferAside(why) {');
    A.ok(fn.length > 0 && fn.length < 1200, 'chat.js stepOfferAside sliced');
    const calls = [];
    const c = vm.createContext({ Dialogue: { preempt: w => { calls.push(w); return w === 'session'; }, stepAside: () => { calls.push('legacy'); return true; } } });
    vm.runInContext(fn + '\nthis.stepOfferAside = stepOfferAside;', c);
    A.eq(c.stepOfferAside('session'), true, 'stepOfferAside asks the arbiter');
    A.eq(c.stepOfferAside('turn'), false, 'and answers what the arbiter answers');
    A.eq(calls, ['session', 'turn'], 'never the offer-only stepAside when the arbiter is there');
    // each raise, sliced from the function it belongs to (never a match anywhere in the joined file)
    const ask = A.fnBody(chat, '  function noteAskLanding() {');
    const send = A.fnBody(chat, '  async function send(text, opts) {');
    const load = A.fnBody(chat, '  function load(ws) {');
    A.ok(ask.length > 0 && ask.length < 200 && send.length > 1000 && send.length < chat.length / 2 && load.length > 200 && load.length < 20000, 'noteAskLanding, send and load sliced');
    A.ok(/return stepOfferAside\('ask'\);/.test(ask), 'chat.js raises \'ask\' through it (noteAskLanding)');
    A.ok(/\n    stepOfferAside\('turn'\);/.test(send), 'chat.js raises \'turn\' through it (send: the Commander\'s own turn)');
    A.ok(/stepOfferAside\('session'\);/.test(load), 'chat.js raises \'session\' through it (load: another conversation on screen)');
  }

  /* ---------- 3b. app.js: a pick that lands on the conversation already on screen asks the arbiter too (review 10-27) ---------- */
  {
    const app = read('frontend/app/app.js');
    const helper = A.fnBody(app, '  function yieldCommsToPick() {');
    A.ok(helper.length > 0 && helper.length < 400, 'app.js yieldCommsToPick sliced');
    if (helper) {
      const asked = [];
      const c = vm.createContext({ Dialogue: { preempt: w => { asked.push(w); return true; } } });
      vm.runInContext(helper + '\nthis.f = yieldCommsToPick;', c);
      c.f();
      A.eq(asked, ['session'], 'yieldCommsToPick raises the arbiter\'s \'session\' action');
    }
    const picks = [];
    const base = () => ({ picks, yieldCommsToPick: () => picks.push('yield'), Chat: { load: ws => picks.push('load:' + ws.id) }, SFX: { click() {}, open() {} },
      refreshUsage() {}, renderRail() {}, persist() {}, focusAgent() {}, railAgentFilter: null, railView: 'sessions', agents: new Map([['finn', { name: 'FINN' }]]), isGroupWs: () => false });
    // switchWorkstream: re-picking the row already on screen
    {
      const fn = A.fnBody(app, '  function switchWorkstream(id) {');
      A.ok(fn.length > 200 && fn.length < 4000, 'app.js switchWorkstream sliced');
      const c = vm.createContext(Object.assign(base(), { Workstreams: { homeOf: x => x, activeId: () => 'cur', switch: () => null } }));
      vm.runInContext(fn + '\nthis.f = switchWorkstream;', c);
      picks.length = 0; c.f('cur');
      A.eq(picks, ['yield'], 'a click on the session already on screen steps the panel over it aside (it used to return with nothing)');
      picks.length = 0; c.f('other');
      A.eq(picks, [], 'a different session is left to Chat.load (its own step-aside), never asked twice here');
    }
    // newWorkstream: + NEW over an untouched blank returns the session on screen
    {
      const fn = A.fnBody(app, '  function newWorkstream() {');
      A.ok(fn.length > 100 && fn.length < 2000, 'app.js newWorkstream sliced');
      const c = vm.createContext(Object.assign(base(), { Workstreams: { startSession: () => ({ id: 'cur' }), generalId: () => 'gen' } }));
      vm.runInContext(fn + '\nthis.f = newWorkstream;', c);
      picks.length = 0; c.f();
      A.eq(picks, ['yield', 'load:cur'], '+ NEW that reuses the blank on screen still steps the panel aside, before the load');
    }
    // selectAgent: the crew member whose session is already open
    {
      const fn = A.fnBody(app, '  function selectAgent(agentId) {');
      A.ok(fn.length > 200 && fn.length < 5000, 'app.js selectAgent sliced');
      const cur = { id: 'cur', agentId: 'finn', history: [{ role: 'user', content: 'hi' }] };
      const c = vm.createContext(Object.assign(base(), { Workstreams: { active: () => cur, generalId: () => 'gen', list: () => [cur], activeId: () => 'cur', setAgent: () => false, create: () => null },
        switchWorkstream: id => picks.push('switch:' + id) }));
      vm.runInContext(fn + '\nthis.f = selectAgent;', c);
      picks.length = 0;
      A.eq(c.f('finn'), 'cur', 'picking the crew member already on screen stays on its session');
      A.eq(picks, ['yield', 'load:cur'], 'and still steps the panel over COMMS aside');
      picks.length = 0; c.f('nobody');
      A.eq(picks, [], 'an unknown agent is no pick at all');
    }
  }

  /* ---------- 4. tutorial.js: every tour beat is tour-owned and ends quietly when preempted ---------- */
  {
    const tut = read('frontend/app/tutorial.js');
    const opens = tut.match(/Dialogue\.open\(\{[^}]*\}\)/g) || [];
    A.ok(opens.length >= 4, 'tutorial.js opens the panel at its beats (' + opens.length + ')');
    A.eq(opens.filter(o => !/tour: true|owner: 'tour'/.test(o)), [], 'every tutorial panel opens as the tour (tour:true or owner:\'tour\'), never as a ceremony that holds a session pick');
    // each beat's answer handler checks the preemption before it does anything else
    const handlers = tut.split('}).then(res => {').slice(1).map(h => h.slice(0, 220));
    A.eq(handlers.length, 5, 'five tour beats answer through a node');
    A.eq(handlers.filter(h => !/^\s*(\n\s*)?if \(!active\) return;\s*(\n\s*)?if \(res\.preempted\) return tourSteppedAside\(\);/.test(h)).length, 0, 'every one checks res.preempted right after its active guard');
    const fn = A.fnBody(tut, '  function tourSteppedAside() {');
    A.ok(fn.length > 0 && fn.length < 800, 'tourSteppedAside sliced');
    const log = [];
    const c = vm.createContext({ resumeFirstTask: true, finishUp: (a, b) => log.push([a, b]) });
    vm.runInContext(fn + '\nthis.tourSteppedAside = tourSteppedAside;', c);
    c.tourSteppedAside();
    A.eq(log, [[true, true]], 'a preempted tour ends through finishUp(skipped, quiet): no first-task re-offer, no line');
    A.eq(vm.runInContext('resumeFirstTask', c), false, 'and drops the "back to my first task" resume');
  }

  A.report('comms-owner-rules');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
