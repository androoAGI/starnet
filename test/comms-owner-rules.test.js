/* node test/comms-owner-rules.test.js — THE COMMS OWNER ARBITER (wave-1 B8 comms-owner-arbiter, gh#158).

   The Dialogue panel is the one surface that stands over COMMS, and many modules open it. Before the arbiter, whether it gave
   COMMS back was decided per caller: the goal path stepped aside for an approval, the hand-off never did, the tour yielded only
   to an INBOX click. Now ONE table (Dialogue.OWNER_RULES) answers it for every panel, by the owner kind fixed when it opened:
       ceremony (the awakening)  — holds everything: it IS the conversation;
       tour (the quick tour)     — yields a session pick through its own way out; holds a turn and an ask;
       offer (anything mid-game) — yields all three, unanswered.
   This executes every cell with the REAL dialogue.js on a small COMMS column, then proves the callers route through it:
   chat.js's one step-aside goes to Dialogue.preempt, and every tour beat in tutorial.js opens as the tour and ends quietly when
   the Commander puts another conversation on screen. */
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
    for (const [why, site] of [['ask', /function noteAskLanding\(\) \{ return stepOfferAside\('ask'\); \}/], ['turn', /stepOfferAside\('turn'\);/], ['session', /stepOfferAside\('session'\);/]])
      A.ok(site.test(chat), 'chat.js raises \'' + why + '\' through it');
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
