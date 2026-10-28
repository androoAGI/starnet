/* node test/first-task-handoff-yields.test.js — THE FIRST-TASK HAND-OFF YIELDS TO THE COMMANDER (gh#158, wave-1 quick win 7).

   The report (v0.14.0, Windows): "Select an existing session … the camera moves to the worker, but the right panel stays on
   'Your first task' instead of opening the conversation. Press Enter with the session selected. The conversation still does not
   open. Create and select a new session. The same onboarding panel remains, with no message box."
   The mechanism: PitchStore.offerHandoff opened the Dialogue with NO offer, so it covered the whole of COMMS (message box
   included), nothing could step it aside, and tutorial.onEnterGame re-showed it on every boot while handoffPending stayed set —
   and a task the Commander then sent from COMMS never cleared it.

   Executed here with the REAL dialogue.js + pitch.js + pitchstore.js on a small COMMS column (test/helpers/comms-dom.js):
     1. the hand-off opens as an OFFER: it ends above the message box, which stays usable;
     2. selecting another conversation (Dialogue.stepAside('session')) or the Commander's own turn steps it aside, unanswered:
        the panel is gone, handoffPending and the draft stay, the draft is in the message box's ↑ recall, nothing was sent;
     3. Esc steps it aside the same way (never the permanent "I'll explore on my own");
     4. it is offered again later (the next boot), with the draft in its box;
     5. a task sent from COMMS completes it (PitchStore.noteCommsTask) and it is not offered again;
   and the wiring, sliced from the real files:
     6. chat.js load() steps an offer aside when ANOTHER conversation goes on screen (never on a re-sync of the same one);
     7. chat.js: only a composer task (never a retry / goal step / send made for them) completes the hand-off;
     8. tutorial.js presentHandoff ends quietly on a step-aside: no Start, no line over the chosen conversation;
   and the review fixes (10-27):
     10. a typed task completes the hand-off only where it can run (a model is configured), the bar Start sets, and clears the draft;
     11. the Commander's own turn steps it aside WITHOUT pushing the old draft over what they just sent in the ↑ recall;
     12. the composer paths that never reach send() — a group conversation, the busy type-ahead queue — step an offer aside and
         complete the hand-off for a typed task, executed through chat.js typedTaskCompletesHandoff. */
'use strict';
const A = require('./_assert.js');
const vm = require('node:vm');
const { station, settle, read } = require('./helpers/comms-dom.js');

function rig(opts) {
  opts = opts || {};
  const mem = {}, recall = [], sent = [];
  const s = station({
    sources: ['frontend/app/pitch.js', 'frontend/app/pitchstore.js'],
    globals: {
      localStorage: { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } },
      U: { bus: A.makeBus() },
      Chat: { isBusy: () => false, rememberSent: t => recall.push(t), prefill() {} },
      Harness: opts.harness || { configured: () => false }
    }
  });
  const PitchStore = vm.runInContext('PitchStore', s.ctx);
  const deps = { getName: () => 'NOVA', getPurpose: () => '', launchDirective: t => { sent.push(t); return true; } };
  PitchStore.init(deps);
  return { s, PitchStore, deps, mem, recall, sent };
}

(async () => {
  /* ---------- 1 + 2. an offer that steps aside for the conversation the Commander picks ---------- */
  {
    const t = rig();
    t.PitchStore.armFirstMove('Sort my inbox into three piles');
    const pending = t.PitchStore.offerHandoff();
    await settle();
    const p = t.s.panel();
    A.ok(t.s.D.isOpen() && p, 'the first-task hand-off opens over COMMS');
    A.ok(p && p.classList.contains('fnv-offer'), 'it opens as an OFFER (gh#158: it used to own the whole of COMMS)');
    A.ok(t.s.inputUsable(), 'the message box stays visible and reachable under it (a click at its centre lands on #chat-input)');
    A.eq(t.PitchStore.handoffPending(), true, 'the hand-off is pending while it is shown');
    const box = t.s.find('fnv-custom-in')[0];
    A.ok(box && box.value === 'Sort my inbox into three piles', 'its box carries the draft');
    A.eq(typeof t.s.D.stepAside === 'function' && t.s.D.stepAside('session'), true, 'selecting another conversation hands the moment back');
    const res = await Promise.race([pending, settle().then(() => 'still waiting')]);
    A.eq(res && res.action, 'aside', 'offerHandoff resolves as stepped aside, unanswered');
    A.eq(t.s.D.isOpen(), false, 'the panel is gone: COMMS shows the conversation the Commander picked');
    A.ok(!t.s.panel(), 'no panel is left over COMMS');
    A.eq(t.PitchStore.handoffPending(), true, 'stepping aside is not a decline: the first task stays pending');
    A.eq(t.sent.length, 0, 'nothing was sent for them');
    A.eq(t.recall, ['Sort my inbox into three piles'], 'the draft is retrievable at once: ↑ in the empty message box brings it back');
    A.eq(t.PitchStore._state().handoffDraft, 'Sort my inbox into three piles', 'and it is kept for the next offer');

    /* 4. offered again (the next boot), the draft still in its box */
    const again = t.PitchStore.offerHandoff();
    await settle();
    A.ok(t.s.D.isOpen() && t.s.panel().classList.contains('fnv-offer'), 'it is offered again later, still as an offer');
    const box2 = t.s.find('fnv-custom-in')[0];
    A.ok(box2 && box2.value === 'Sort my inbox into three piles', 'with the same draft');

    /* 3. Esc steps it aside too (unanswered), never the permanent "I'll explore on my own" */
    const ev = t.s.key('Escape');
    A.eq(ev.defaultPrevented, true, 'an unused Esc is the offer’s');
    const res2 = await Promise.race([again, settle().then(() => 'still waiting')]);
    A.eq(res2 && res2.action, 'aside', 'Esc steps the hand-off aside');
    A.eq(t.PitchStore.handoffPending(), true, 'and keeps the first task pending (Esc is not "explore on my own")');
    A.eq(t.s.D.isOpen(), false, 'the panel is gone');

    /* the Commander's own turn steps it aside the same way */
    const third = t.PitchStore.offerHandoff();
    await settle();
    const recalled = t.recall.length;
    t.s.D.stepAside('turn');
    const res3 = await Promise.race([third, settle().then(() => 'still waiting')]);
    A.eq(res3 && res3.action, 'aside', 'the Commander sending a turn steps the hand-off aside');
    A.eq(res3 && res3.why, 'turn', 'and says why');
    /* 11. …without pushing the old draft into the ↑ recall after the line they just sent */
    A.eq(t.recall.length, recalled, 'their own turn pushes no stale draft into ↑ (↑ right after a send brings back what they sent)');
    A.eq(t.PitchStore._state().handoffDraft, 'Sort my inbox into three piles', 'the draft is still kept for the next offer');

    /* 10. a typed task on a station that cannot run it (no model configured) keeps the first task pending */
    A.eq(t.PitchStore.noteCommsTask('Sort my inbox into three piles, oldest first'), false, 'no model configured: a typed task does not spend the hand-off on a run that cannot start');
    A.eq(t.PitchStore.handoffPending(), true, 'the first task stays pending (the bar Start sets)');
    t.s.ctx.Harness = { configured: () => true };

    /* 5. a task sent from COMMS completes the hand-off */
    A.eq(typeof t.PitchStore.noteCommsTask === 'function' && t.PitchStore.noteCommsTask('Sort my inbox into three piles, oldest first'), true, 'a task sent from COMMS completes the pending hand-off');
    A.eq(t.PitchStore.handoffPending(), false, 'the hand-off is no longer pending');
    A.eq(t.PitchStore._state().handoffDraft, undefined, 'and its draft is cleared: there is nothing left to offer');
    A.eq(await t.PitchStore.offerHandoff(), null, 'and it is never offered over COMMS again');
    A.eq(t.PitchStore.noteCommsTask('another task'), false, 'a later task finds nothing pending');
    t.PitchStore.init(t.deps);
    A.eq(t.PitchStore.handoffPending(), false, 'completion survives a reload (no boot re-show)');
  }
  /* ---------- 9. "Help me choose" is cancellable: its model call is aborted by a step-aside, by its own cap, by a reset ---------- */
  {
    const slow = () => { const m = { calls: [] }; m.configured = () => true;
      m.chat = args => { m.calls.push(args); return new Promise((resolve, reject) => { if (args.signal) args.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }, { once: true }); }); };
      return m; };
    const askHelp = async t => {
      const p = t.PitchStore.offerHandoff();
      await settle();
      const help = t.s.find('fnv-opt').find(b => /Help me choose/.test(b.textContent));
      A.ok(!!help, 'the hand-off shows its "Help me choose a first task" key');
      if (help) help.click();
      await settle();
      return { p };   // wrapped: an async function returning a promise would adopt it and wait for the hand-off to end
    };
    // (a) the Commander picks another conversation while the suggestion is being thought up
    {
      const model = slow();
      const t = rig({ harness: model });
      const { p } = await askHelp(t);
      A.eq(model.calls.length, 1, 'Help me choose asks the model once');
      const sig = model.calls[0] && model.calls[0].signal;
      A.ok(sig && sig.aborted === false, 'the suggestion call carries its own abort signal');
      t.s.D.stepAside('session');
      const res = await Promise.race([p, settle().then(() => 'still waiting')]);
      A.eq(res && res.action, 'aside', 'the hand-off steps aside mid-suggestion');
      A.ok(sig && sig.aborted, 'and the suggestion call is ABORTED, not left running after the hand-off moved on');
    }
    // (b) its own cap: a slow model is stopped, not merely stopped waiting for
    {
      const model = slow();
      const t = rig({ harness: model });
      t.deps.helpCapMs = 40; t.PitchStore.init(t.deps);
      const { p } = await askHelp(t);
      const sig = model.calls[0] && model.calls[0].signal;
      await new Promise(r => setTimeout(r, 90)); await settle();
      A.ok(sig && sig.aborted, 'when the cap passes the call is aborted');
      A.ok(t.s.D.isOpen(), 'and the hand-off is still there for the Commander to type their own task');
      t.s.D.stepAside('session'); await Promise.race([p, settle()]);
    }
    // (c) a new hero (reset) ends a stale suggestion call
    {
      const model = slow();
      const t = rig({ harness: model });
      const { p } = await askHelp(t);
      const sig = model.calls[0] && model.calls[0].signal;
      t.PitchStore.reset();
      A.ok(sig && sig.aborted, 'reset() aborts the previous hero’s suggestion call');
      t.s.D.close(); void p;
    }
  }
  {
    // a task sent with nothing pending never invents a hand-off state; an empty send completes nothing
    const t = rig();
    A.eq(t.PitchStore.noteCommsTask('   '), false, 'an empty send completes nothing');
    A.eq(t.PitchStore.noteCommsTask('hello there'), false, 'nothing pending → nothing to complete');
  }

  /* ---------- 6. chat.js load(): another conversation on screen steps an offer aside ---------- */
  const chat = read('frontend/app/chat.js');
  const load = A.fnBody(chat, '  function load(ws) {');
  A.ok(load.length > 200 && load.length < 20000, 'chat.js load() sliced (' + load.length + ' chars)');
  A.ok(/const prevWs = activeWs;/.test(load), 'load() remembers the conversation that was on screen');
  A.ok(/if \(prevWs && nextWs && prevWs\.id !== nextWs\.id\) stepOfferAside\('session'\);/.test(load), 'load() steps an offer aside only when ANOTHER conversation goes on screen');
  A.ok(load.indexOf("stepOfferAside('session')") < load.indexOf('renderHistory()'), 'before the conversation renders under it');

  /* ---------- 7. chat.js: only a composer task completes the hand-off ---------- */
  const submit = A.fnBody(chat, '  async function submitComposer() {');
  A.ok(/send\(t, \{ attachments: atts, composer: true \}\);/.test(submit), 'the message box marks its own send as the Commander’s (composer: true)');
  const send = A.fnBody(chat, '  async function send(text, opts) {');
  A.ok(send.length > 1000 && send.length < chat.length / 2, 'chat.js send() sliced');
  A.ok(/if \(opts && opts\.composer && isTask && !retry && !goalContinuation && typeof PitchStore !== 'undefined' && PitchStore\.noteCommsTask\)/.test(send),
    'send() completes the hand-off only for a composer task — never a retry, a goal step, or a send made for them');

  /* ---------- 12. the composer paths that never reach send(), executed ---------- */
  {
    const helper = A.fnBody(chat, '  function typedTaskCompletesHandoff(t, ws) {');
    A.ok(helper.length > 200 && helper.length < 2000, 'chat.js typedTaskCompletesHandoff sliced');
    const run = (o) => {
      const noted = [], seen = [];
      const c = vm.createContext({
        PitchStore: { handoffPending: () => o.pending, noteCommsTask: x => { noted.push(x); return true; } },
        Classify: { isTaskDirective: (x, ctx) => { seen.push(ctx && ctx.priorAgentTurn); return /^(sort|draft|make)/i.test(x); } }
      });
      vm.runInContext(helper + '\nthis.f = typedTaskCompletesHandoff;', c);
      const r = c.f(o.text, { history: o.history || [] });
      return { r, noted, seen };
    };
    const a = run({ pending: true, text: 'Sort my inbox', history: [{ role: 'assistant', content: 'want me to sort it?' }] });
    A.ok(a.r === true && a.noted.length === 1, 'a typed task in a group / the queue completes a pending hand-off');
    A.eq(a.seen, ['want me to sort it?'], 'classified with the agent’s last reply as context, like send()');
    A.eq(run({ pending: true, text: 'hello there' }).noted, [], 'chat is not a task: nothing completed');
    A.eq(run({ pending: false, text: 'Sort my inbox' }).noted, [], 'nothing pending: nothing completed');
    const sub = A.fnBody(chat, '  async function submitComposer() {');
    const groupSends = sub.split('await GroupChat.sendText(t,').length - 1;
    A.eq(groupSends, 2, 'submitComposer has its two group send paths');
    A.eq((sub.match(/stepOfferAside\('turn'\);[^\n]*\n\s*const sent = await GroupChat\.sendText\(t,/g) || []).length, 2, 'both group paths step an offer aside right before the send (a group turn never reaches send())');
    A.eq((sub.match(/const sent = await GroupChat\.sendText\(t, [^\n]*\n\s*if \(sent\) typedTaskCompletesHandoff\(t, ws\);/g) || []).length, 2, 'and a sent group task completes the hand-off');
    A.ok(/if \(isBusy\(\)\) \{ if \(t\) \{[^\n]*enqueue\(t\); stepOfferAside\('turn'\); typedTaskCompletesHandoff\(t, activeWs\); \}/.test(sub), 'a task typed while busy (queued) completes it too');
  }

  /* ---------- 8. tutorial.js presentHandoff on a step-aside, executed ---------- */
  {
    const tut = read('frontend/app/tutorial.js');
    const fn = A.fnBody(tut, '  async function presentHandoff(tour) {');
    A.ok(fn.length > 100 && fn.length < 4000, 'tutorial.js presentHandoff sliced');
    const run = async (active) => {
      const log = { finishUp: [], started: 0, lines: [], beat: 0, saves: 0 };
      const c = vm.createContext({
        PitchStore: { offerHandoff: async () => ({ action: 'aside', why: 'session' }), startHandoff: () => { log.started++; return true; } },
        finishUp: (a, b) => log.finishUp.push([a, b]), beatShowAround: () => { log.beat++; }, hasChat: () => true, hasDialogue: () => true,
        Chat: { localLine: l => log.lines.push(l) }, Dialogue: { isOpen: () => false, close() {} }, save: () => { log.saves++; },
        state: {}, active, resumeFirstTask: false
      });
      vm.runInContext(fn + '\nthis.presentHandoff = presentHandoff;', c);
      await c.presentHandoff(false);
      return { log, state: c.state };
    };
    const off = await run(false);
    A.eq(off.log.started, 0, 'a stepped-aside hand-off starts nothing');
    A.eq(off.log.lines, [], 'and says nothing over the conversation the Commander chose');
    A.eq(off.log.finishUp, [], 'outside the tour nothing is finished');
    const on = await run(true);
    A.eq(on.log.finishUp, [[true, true]], 'inside the first-run flow it ends the tour quietly (the task stays pending for the next boot)');
    A.eq(on.log.lines, [], 'still without a line');
  }

  A.report('first-task-handoff-yields');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
