/* node test/goalstore.test.js — GROWTH Tier 2: the live wiring around the pure GOAL-TREE engine (goalstore.js).

   Decisions live in the pure goals.js (tested separately); this verifies the EDGE: the decomposition confirm flow
   (propose → confirm → persist, not-now → re-offer only on belief change), the milestone → work-quest binding, the
   chaining + evidence fold on a completed build, drift retiring, the sidecar mirror, the feedback-loop hooks, the
   one-beat arbiter discipline (memory wins, study second, arc third — behavioral state assertions on the pure
   beat-slot), and the new-hero reset. Mirrors studystore.test.js / workqueststore.test.js. */
'use strict';
const A = require('./_assert.js');
const G = require('../frontend/app/goals.js');
const S = require('../frontend/app/study.js');

// ---- fakes: localStorage, fetch (captures the sidecar mirror), DossierStore beliefs, WorkQuestStore ----
const mem = {};
global.localStorage = { getItem: k => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
global.Goals = G;

let goalsBeliefs = [{ id: 'cd_5', text: 'ship a local-first agent harness' }];
global.DossierStore = { beliefs: dim => (dim === 'goals' ? goalsBeliefs.slice() : []) };

// a STATEFUL fake WorkQuestStore (mirrors the real projection contract incl. the additive `stalled` field):
// accept() mints an OPEN build; the test flips status/stalled/dismissed to drive liveness.
let wqSeq = 0; const wq = {}; const wqAccepts = [];
global.WorkQuestStore = {
  accept: parsed => { wqAccepts.push(parsed); const id = 'wq:' + (++wqSeq); wq[id] = { status: 'open', stalled: false, dismissed: false }; return id; },
  quests: () => Object.keys(wq).filter(id => !wq[id].dismissed).map(id => ({ id, status: wq[id].status, stalled: wq[id].stalled }))
};
const wqComplete = id => { wq[id].status = 'done'; };

// capture the sidecar mirror + let a POST resolve
const posts = [];
global.fetch = (url, opts) => { posts.push({ url, body: JSON.parse((opts && opts.body) || '{}') }); return Promise.resolve({ ok: true }); };
const journeyPosts = [];
let journeyAvailable = false;
let outcomeAvailable = false;
global.JourneyStore = {
  registerGoal: async () => ({ ok: true }),
  confirmGoal: async () => ({ ok: outcomeAvailable }),
  noteMilestone: async d => { journeyPosts.push(Object.assign({}, d)); return journeyAvailable ? { ok: true } : { ok: false, error: 'offline' }; }
};

// a fake Harness returning a fixed decomposition (COUNTED — the spend-once cache is asserted on this counter)
let harnessReply = '1. Set up the runtime\n2. Wire the event bus\n3. Build the first agent loop';
let chatCalls = 0;
const launches = [];
global.Harness = { chat: async () => { chatCalls++; return { text: harnessReply, error: false }; } };

const { GoalStore } = require('../frontend/app/goalstore.js');

(async () => {
  let clock = 1000;
  GoalStore.init({ now: () => clock, getSystem: () => '', launchDirective: t => launches.push(t) });

  /* ============================ 1. THE DECOMPOSITION CONFIRM FLOW ============================ */

  A.eq(GoalStore.willOfferDecomposition(), true, 'a goals belief with no tree → a decomposition is offerable');
  A.eq(GoalStore.unplannedGoal().text, 'ship a local-first agent harness', 'a saved dossier goal is readable before its path exists');
  const pend = GoalStore.pendingDecomposition();
  A.ok(pend && pend.id === 'cd_5', 'pendingDecomposition returns the belief to decompose');
  const proposed = await GoalStore.proposeDecomposition();
  A.ok(proposed && proposed.texts.length === 3, 'proposeDecomposition runs the model + parses 3 milestones');
  A.eq(proposed.belief.id, 'cd_5', 'the proposal carries its source belief');

  // CONFIRM → the tree persists, bound to the belief, and mirrors to the sidecar
  const goal = GoalStore.confirm(proposed.belief, proposed.texts);
  A.ok(goal && goal.sourceBeliefId === 'cd_5', 'confirm persists a goal tree bound to the belief');
  A.eq(goal.milestones.length, 3, 'the confirmed tree holds its milestones');
  A.ok(posts.some(p => p.url === '/api/goals' && p.body.goal && p.body.goal.text.indexOf('harness') >= 0), 'confirm mirrors the active goal to the sidecar (POST /api/goals)');
  // it is now the active goal + surfaces in the projection
  A.ok(GoalStore.activeGoal() && GoalStore.activeGoal().id === goal.id, 'the confirmed goal is the active goal');
  A.eq(GoalStore.unplannedGoal(), null, 'a goal with an authoritative tree is no longer reported as unplanned');
  const q1 = GoalStore.quests();
  A.eq(q1[0].kind, 'arc-goal', 'the projection leads with the goal header');
  A.eq(q1.filter(q => q.kind === 'arc-step').length, 3, 'three milestone steps project');

  // once a tree exists for the belief, it is NOT re-offered
  A.eq(GoalStore.willOfferDecomposition(), false, 'a belief that already has a tree is not re-offered');

  /* ============================ 2. NOT-NOW → RE-OFFER ONLY ON BELIEF CHANGE ============================ */

  // a fresh belief with no tree, declined → not re-offered until the belief changes
  goalsBeliefs = [{ id: 'cd_9', text: 'launch a public beta' }];
  A.eq(GoalStore.willOfferDecomposition(), true, 'a new belief with no tree is offerable');
  GoalStore.declineDecomposition(GoalStore.pendingDecomposition());
  A.eq(GoalStore.willOfferDecomposition(), false, 'not-now stops the re-offer for THIS belief state (never nag)');
  A.eq(GoalStore.unplannedGoal().text, 'launch a public beta', 'declining decomposition never makes the saved goal disappear from YOUR GOAL');
  // the SAME belief text, unchanged → still not offered
  goalsBeliefs = [{ id: 'cd_9', text: 'launch a public beta' }];
  A.eq(GoalStore.willOfferDecomposition(), false, 'the unchanged belief still does not re-offer');
  // the belief text CHANGES → re-offers (a real change is a new thing to decompose)
  goalsBeliefs = [{ id: 'cd_9', text: 'launch a public beta AND a paid tier' }];
  A.eq(GoalStore.willOfferDecomposition(), true, 'a CHANGED belief re-offers (fingerprint moved)');

  /* ============================ 3. MILESTONE → WORK-QUEST BINDING + CHAINING + EVIDENCE ============================ */

  // accept the front milestone of the active goal (cd_5's) → routes through WorkQuestStore + launches a run
  goalsBeliefs = [{ id: 'cd_5', text: 'ship a local-first agent harness' }];   // restore the tree's live belief
  const m1 = goal.milestones[0].id;
  const accepted = GoalStore.acceptMilestone(goal.id, m1);
  A.ok(accepted && accepted.id === m1, 'acceptMilestone accepts the front milestone');
  A.eq(wqAccepts.length, 1, 'the milestone routed through the work-quest path (WorkQuestStore.accept)');
  A.ok(launches.length >= 1 && launches[launches.length - 1].indexOf(goal.milestones[0].text) >= 0, 'accepting launches a real run for the milestone (no dead gap)');
  A.eq(goal.milestones[0].questRef, 'wq:1', 'the milestone is bound to the work quest');
  // only the CURRENT front milestone is acceptable (honest chaining)
  A.eq(GoalStore.acceptMilestone(goal.id, goal.milestones[1].id), null, 'a non-front milestone cannot be accepted (chaining)');

  // the work quest completes → a clean run.end reconciles: the milestone folds done + writes evidence + chains
  wqComplete('wq:1');
  clock = 2000;
  GoalStore._onRunEnd({ reason: 'done', agentId: 'agent', runId: 'run_a' });
  await new Promise(resolve => setImmediate(resolve));
  A.eq(GoalStore.activeGoal().milestones[0].status, 'done', 'completing the REAL work completes the milestone (never a manual tick)');
  A.ok(GoalStore.activeGoal().milestones[0].evidence, 'evidence is written onto the milestone node');
  A.eq(GoalStore.activeGoal().milestones[0].journeySyncedAt, null, 'a failed journey fold remains durably pending');
  journeyAvailable = true;
  await GoalStore._syncJourneyMilestones();
  A.ok(GoalStore.activeGoal().milestones[0].journeySyncedAt, 'a later sync retries and acknowledges the completed milestone');
  A.eq(journeyPosts.filter(p => p.goalId === goal.id && p.milestoneId === goal.milestones[0].id).length, 2, 'the failed milestone is retried exactly once when service returns');
  const q2 = GoalStore.quests();
  A.ok(/1 of 3/.test(q2[0].desc), 'the arc meter advanced to 1 of 3 (honest)');
  const nextStep = q2.filter(q => q.kind === 'arc-step').find(s => s.isNext);
  A.eq(nextStep.milestoneId, goal.milestones[1].id, 'the NEXT milestone surfaces as the front (real chaining)');
  A.ok(posts.some(p => p.url === '/api/goals' && p.body.goal && p.body.goal.done === 1), 'the advanced progress re-mirrors to the sidecar');

  // complete the remaining two → the goal completes
  GoalStore.acceptMilestone(goal.id, goal.milestones[1].id); wqComplete('wq:2');
  GoalStore._onRunEnd({ reason: 'done', agentId: 'agent', runId: 'run_b' });
  GoalStore.acceptMilestone(goal.id, goal.milestones[2].id); wqComplete('wq:3');
  GoalStore._onRunEnd({ reason: 'done', agentId: 'agent', runId: 'run_c' });
  A.eq(GoalStore.activeGoal().id, goal.id, 'all planned actions complete leaves the life goal active');
  A.eq(GoalStore.quests()[0].pct, 100, 'the plan can be 100% complete without claiming the outcome');
  A.eq((await GoalStore.confirmOutcome(goal.id, 'accepted an offer')).ok, false, 'failed backend confirmation stays failed');
  A.eq(GoalStore.activeGoal().id, goal.id, 'failed confirmation cannot clear the active goal');
  await GoalStore.setSuccessCondition(goal.id, 'accepted a signed offer');
  outcomeAvailable = true;
  await GoalStore.confirmOutcome(goal.id, 'accepted an offer');
  A.eq(GoalStore.activeGoal(), null, 'explicit acknowledged outcome closes the life goal');
  A.eq(GoalStore.quests().length, 0, 'a confirmed goal projects no active arc');

  /* ============================ 4. FEEDBACK-LOOP HOOKS (§5, additive/fail-open) ============================ */

  const studyNotes = []; let suggestBumped = 0;
  global.StudyStore = { noteGoalProgress: n => studyNotes.push(n) };
  global.SuggestStore = { noteGoalProgress: () => { suggestBumped++; } };
  // a fresh goal + a completed milestone → the study salience note + (on goal-done) the suggest bump fire
  goalsBeliefs = [{ id: 'cd_11', text: 'build a second real feature' }];
  harnessReply = '1. draft the plan clearly\n2. build the core module\n3. wire the ui shell in';
  const g3 = GoalStore.confirm(GoalStore.pendingDecomposition(), (await GoalStore.proposeDecomposition()).texts);
  GoalStore.acceptMilestone(g3.id, g3.milestones[0].id); wqComplete('wq:4');
  GoalStore._onRunEnd({ reason: 'done', agentId: 'agent', runId: 'run_d' });
  A.ok(studyNotes.length >= 1 && studyNotes[0].milestoneText, 'a completed milestone bumps Study salience (goal-progress note)');
  // finish the goal → the suggest gate bump
  GoalStore.acceptMilestone(g3.id, g3.milestones[1].id); wqComplete('wq:5');
  GoalStore._onRunEnd({ reason: 'done', agentId: 'agent', runId: 'run_e' });
  GoalStore.acceptMilestone(g3.id, g3.milestones[2].id); wqComplete('wq:6');
  GoalStore._onRunEnd({ reason: 'done', agentId: 'agent', runId: 'run_f' });
  A.eq(suggestBumped, 0, 'finishing the plan does not celebrate a life-goal achievement');
  await GoalStore.confirmOutcome(g3.id, 'the second feature is live and accepted');
  A.ok(suggestBumped >= 1, 'completing the whole goal bumps the suggestion gate (§5 additive OR)');
  delete global.StudyStore; delete global.SuggestStore;

  /* ============================ 5. DRIFT / RETIRE PROPAGATION (through the store) ============================ */

  goalsBeliefs = [{ id: 'cd_20', text: 'a goal that will drift' }];
  harnessReply = '1. first real step now\n2. second real step here\n3. third real step too';
  const g4 = GoalStore.confirm(GoalStore.pendingDecomposition(), (await GoalStore.proposeDecomposition()).texts);
  A.ok(GoalStore.activeGoal() && GoalStore.activeGoal().id === g4.id, 'the new goal is active');
  // the Study engine RETIRES the source belief (dossier.forget) → it's gone from the live beliefs
  goalsBeliefs = [];
  A.eq(GoalStore.syncDrift(), true, 'syncDrift detects the forgotten source belief and retires the goal');
  A.eq(GoalStore.activeGoal(), null, 'a drifted goal is retired (hidden from the active quest log)');
  A.ok(posts.some(p => p.url === '/api/goals' && p.body.goal === null), 'a cleared active arc mirrors null to the sidecar');

  /* ============================ 6. NEW-HERO RESET (own key) ============================ */

  goalsBeliefs = [{ id: 'cd_30', text: 'a goal for the next hero test' }];
  harnessReply = '1. alpha step one\n2. beta step two\n3. gamma step three';
  GoalStore.confirm(GoalStore.pendingDecomposition(), (await GoalStore.proposeDecomposition()).texts);
  A.ok(GoalStore.activeGoal(), 'a goal exists before reset');
  GoalStore.reset();
  A.eq(GoalStore.activeGoal(), null, 'reset clears every goal tree (a new Commander inherits nothing)');
  A.eq(mem['starnet.goals.v1'], undefined, 'reset removes the own localStorage key');

  /* ============================ 7. PERSISTENCE ROUND-TRIP (survives a re-init) ============================ */

  goalsBeliefs = [{ id: 'cd_40', text: 'a persisted goal' }];
  harnessReply = '1. persist step one\n2. persist step two\n3. persist step three';
  const gp = GoalStore.confirm(GoalStore.pendingDecomposition(), (await GoalStore.proposeDecomposition()).texts);
  GoalStore.acceptMilestone(gp.id, gp.milestones[0].id); wqComplete('wq:' + wqSeq);
  clock = 9000; GoalStore._onRunEnd({ reason: 'done', agentId: 'agent', runId: 'run_p' });
  const prBefore = GoalStore.quests()[0].desc;
  GoalStore.init({ now: () => clock, getSystem: () => '', launchDirective: t => launches.push(t) });   // re-hydrate from the own key
  await new Promise(resolve => setImmediate(resolve));
  A.ok(GoalStore.activeGoal() && GoalStore.activeGoal().id === gp.id, 'the goal tree survives a re-init (persisted, own key)');
  A.eq(GoalStore.quests()[0].desc, prBefore, 'progress + evidence round-trip through persistence');
  A.ok(GoalStore.activeGoal().milestones[0].journeySyncedAt, 'journey acknowledgement survives the goal-store persistence round-trip');

  /* ====== 8. THE ONE-BEAT DISCIPLINE — BEHAVIORAL (memory wins, study second, arc third) ======
     The arc confirm beat is the LOWEST-priority participant on the pure beat-slot arbiter (Study.makeBeatSlot):
     memory turn-in and study proposals both win the moment before it. We drive the arbiter through the contested
     scenarios and assert the arc can only take a WHOLLY FREE slot and never coexists with another beat. */

  const slot = S.makeBeatSlot();
  // all three pending: memory wins, study cedes to memory, arc cedes to both
  slot.memoryProposed('run_1');
  A.eq(slot.canStudy(), 'memory', 'reflection in flight → study cedes to memory');
  A.eq(slot.canArc(), 'memory', 'reflection in flight → the arc cedes to memory too');
  A.eq(slot.memoryDeck(), 'render', 'the memory deck renders');
  A.eq(slot.canArc(), 'busy', 'a visible memory deck blocks the arc (never two beats)');
  slot.memoryDone('run_1', false);
  // now only study + arc contend: study takes it, arc cedes to the visible study card
  A.eq(slot.canStudy(), 'free', 'the moment is free for study once memory resolves');
  A.eq(slot.canArc(), 'free', 'the moment is also free for the arc when nothing else wants it');
  slot.studyShown();
  A.eq(slot.canArc(), 'busy', 'a visible study card blocks the arc (study wins over arc)');
  A.eq(slot.visibleBeat(), 'study', 'exactly one visible beat: the study card');
  slot.studyDone(false);
  // now the arc may take a wholly free slot; while it is visible, memory/study never stack on it
  A.eq(slot.canArc(), 'free', 'with memory + study both resolved, the arc may take the free moment');
  slot.arcShown();
  A.eq(slot.visibleBeat(), 'arc', 'the arc confirm is the one visible beat');
  A.eq(slot.canStudy(), 'busy', 'a visible arc panel blocks a study card (never two beats)');
  A.eq(slot.canArc(), 'busy', 'a visible arc panel blocks a second arc offer');
  slot.arcDone();
  A.eq(slot.visibleBeat(), null, 'the moment is free again after the arc confirm resolves');
  A.eq(slot.canStudy(), 'free', 'and the pre-Tier-2 memory/study surface is untouched (still free)');

  /* ====== 8b. REVIEW FIX 1 — the contested arc beat NEVER strands a queued memory deck ======
     A late memory.proposed lands while the arc Dialogue is open (a minutes-long confirm): the deck QUEUES.
     When the arc resolves, arcDone(true) hands the slot STRAIGHT to the queued deck (no gap another beat could
     steal), the deck renders + resolves, pendingMemory clears, and the study/arc lanes are free — never frozen. */
  const slot2 = S.makeBeatSlot();
  slot2.arcShown();
  A.eq(slot2.visibleBeat(), 'arc', 'the arc panel holds the moment');
  slot2.memoryProposed('run_late');                       // reflection lands mid-confirm
  A.eq(slot2.memoryDeck(), 'queue', 'the late memory deck QUEUES behind the visible arc panel (never stacks)');
  A.eq(slot2.canStudy(), 'busy', 'study still cedes while the arc panel is up');
  slot2.arcDone(true);                                    // the arc resolves WITH a deck queued → hand the slot over
  A.eq(slot2.visibleBeat(), 'memory', 'arcDone(true) hands the slot straight to the queued memory deck (no gap)');
  slot2.memoryShown();                                    // renderTurninBatch's idempotent hard-claim (showNextTurnin path)
  slot2.memoryDone('run_late', false);                    // the Commander decides the deck
  A.eq(slot2._pending(), 0, 'pendingMemory cleared — the claim cannot strand the lanes');
  A.eq(slot2.canStudy(), 'free', 'the study lane is free after the drained deck resolves (no freeze)');
  A.eq(slot2.canArc(), 'free', 'the arc lane is free too');
  // and with NOTHING queued, arcDone(false) frees the slot outright
  const slot3 = S.makeBeatSlot();
  slot3.arcShown(); slot3.arcDone(false);
  A.eq(slot3.visibleBeat(), null, 'arcDone(false) frees the slot when nothing queued');

  /* ====== 9. REVIEW FIX 2 — DOUBLE-ACCEPT refused while the bound build is LIVE; re-offer on stall/dismiss ====== */
  goalsBeliefs = [{ id: 'cd_50', text: 'a goal for the double-accept guard' }];
  harnessReply = '1. guard step one\n2. guard step two\n3. guard step three';
  const gd = GoalStore.confirm(GoalStore.pendingDecomposition(), (await GoalStore.proposeDecomposition()).texts);
  const acceptsBefore = wqAccepts.length, launchesBefore = launches.length;
  const mA = GoalStore.acceptMilestone(gd.id, gd.milestones[0].id);
  A.ok(mA, 'the front milestone accepts');
  const boundRef = gd.milestones[0].questRef;
  A.eq(wqAccepts.length, acceptsBefore + 1, 'one work quest minted');
  // the projection now reads IN PROGRESS with no re-accept (render state = the guard's state)
  const front9 = GoalStore.quests().filter(q => q.kind === 'arc-step').find(s => s.isNext);
  A.eq(front9.inFlight, true, 'the accepted front step projects inFlight (renders "in progress", no Accept button)');
  // a stale UI re-click is REFUSED: no duplicate build, no duplicate paid run, the binding untouched
  A.eq(GoalStore.acceptMilestone(gd.id, gd.milestones[0].id), null, 'a re-accept while the bound build is LIVE is refused');
  A.eq(wqAccepts.length, acceptsBefore + 1, 'no duplicate work quest minted');
  A.eq(launches.length, launchesBefore + 1, 'no duplicate run launched (no double-spend)');
  A.eq(gd.milestones[0].questRef, boundRef, 'the original binding is untouched');
  // a DONE-but-not-yet-reconciled build also refuses (one reconcile away from folding — never re-spend)
  wqComplete(boundRef);
  A.eq(GoalStore.acceptMilestone(gd.id, gd.milestones[0].id), null, 'a done-awaiting-reconcile build refuses re-accept too');
  GoalStore.reconcile('');
  A.eq(gd.milestones[0].status, 'done', 'reconcile folds the completed milestone');
  // STALL RECOVERY: the next milestone's build stalls → Accept re-offers → re-accept mints a FRESH build + re-binds
  const mB = GoalStore.acceptMilestone(gd.id, gd.milestones[1].id);
  A.ok(mB, 'the next front milestone accepts');
  const stalledRef = gd.milestones[1].questRef;
  wq[stalledRef].stalled = true;                          // the run errored/budgeted out — the build stalled
  const front9b = GoalStore.quests().filter(q => q.kind === 'arc-step').find(s => s.isNext);
  A.eq(front9b.inFlight, false, 'a STALLED bound build is no longer in flight — Accept re-offers (recovery)');
  const reAccept = GoalStore.acceptMilestone(gd.id, gd.milestones[1].id);
  A.ok(reAccept, 'a stalled binding re-accepts cleanly');
  A.ok(gd.milestones[1].questRef && gd.milestones[1].questRef !== stalledRef, 'the fresh build re-binds the milestone');
  // DISMISSED RECOVERY: the fresh build is dismissed → dead binding → Accept re-offers again
  wq[gd.milestones[1].questRef].dismissed = true;
  A.eq(GoalStore.questLive(gd.milestones[1].questRef), false, 'a dismissed build is not live (dead questRef)');
  A.ok(GoalStore.acceptMilestone(gd.id, gd.milestones[1].id), 'a dismissed/dead binding re-accepts (recovery path)');

  /* ====== 10. REVIEW FIX 3 — a too-short EDIT declines; a valid edit persists the EDITED path ====== */
  goalsBeliefs = [{ id: 'cd_60', text: 'a goal the commander will edit' }];
  harnessReply = '1. model step one\n2. model step two\n3. model step three';
  const prop10 = await GoalStore.proposeDecomposition();
  // the Commander types "just do X" into the ✎ edit box — the resolver DECLINES; routing persists NOTHING
  const dShort = G.resolveConfirmChoice({ custom: true, value: 'just do X' }, prop10.texts);
  A.eq(dShort.action, 'decline', 'a too-short edit resolves to decline (the Commander rejected the tree)');
  const goalsBefore10 = GoalStore._state().goals.length;
  GoalStore.declineDecomposition(prop10.belief);          // the routing chat.js applies on 'decline'
  A.eq(GoalStore._state().goals.length, goalsBefore10, 'NOTHING was persisted — the unedited model tree never lands');
  A.eq(GoalStore.willOfferDecomposition(), false, 'the rejected belief state is marked offered (re-offer only on change)');
  // a VALID edit persists the EDITED milestones, not the model path
  goalsBeliefs = [{ id: 'cd_61', text: 'a goal the commander edits well' }];
  const prop10b = await GoalStore.proposeDecomposition();
  const dGood = G.resolveConfirmChoice({ custom: true, value: 'my alpha step; my beta step; my gamma step' }, prop10b.texts);
  A.eq(dGood.action, 'confirm', 'a valid 3-step edit resolves to confirm');
  const gEdited = GoalStore.confirm(prop10b.belief, dGood.path);
  A.ok(gEdited && gEdited.milestones.map(m => m.text).join('|') === 'my alpha step|my beta step|my gamma step',
    'the EDITED path is what persists (never the model path the Commander replaced)');

  /* ====== 11. REVIEW FIX 6 — the paid decomposition is SPENT ONCE per belief state (cache) ====== */
  goalsBeliefs = [{ id: 'cd_70', text: 'a goal whose proposal must not re-bill' }];
  harnessReply = '1. cache step one\n2. cache step two\n3. cache step three';
  const callsBefore = chatCalls;
  const p1 = await GoalStore.proposeDecomposition();      // the moment is then lost (memory claimed it) — result discarded
  A.eq(chatCalls, callsBefore + 1, 'the first propose pays one aux call');
  const p2 = await GoalStore.proposeDecomposition();      // the next run end re-offers the SAME belief state
  A.eq(chatCalls, callsBefore + 1, 'the re-offer reuses the CACHED path — no second aux spend');
  A.eq(p2.texts, p1.texts, 'the cached path is the same proposal');
  GoalStore.declineDecomposition(p2.belief);              // deciding the belief clears its cache
  goalsBeliefs = [{ id: 'cd_70', text: 'a goal whose proposal must not re-bill, changed' }];
  await GoalStore.proposeDecomposition();
  A.eq(chatCalls, callsBefore + 2, 'a CHANGED belief state is a fresh spend (the cache never leaks across states)');

  /* ====== 11b. THE STUBBORN-BELIEF SPEND LEAK — an undecomposable belief stops re-billing ======
     An unusable reply (parse failure, or a path shorter than the 3 the confirm panel requires) marked NOTHING
     offered so "a later, better reply could still land" — which meant a belief this model simply cannot break
     down re-paid the aux call at EVERY single run end, forever. Two failures on one belief fingerprint is
     evidence enough: mark it offered, so it re-opens only when the belief itself changes. */
  goalsBeliefs = [{ id: 'cd_80', text: 'a goal this model can never decompose properly' }];
  harnessReply = 'I am not sure how to break that down.';        // parses to nothing usable
  const stubbornBefore = chatCalls;
  A.eq(await GoalStore.proposeDecomposition(), null, 'an unparseable reply yields no path');
  A.eq(GoalStore.willOfferDecomposition(), true, 'ONE failure is a hiccup — the belief is still offerable');
  A.eq(await GoalStore.proposeDecomposition(), null, 'the second attempt also fails');
  A.eq(chatCalls, stubbornBefore + 2, 'exactly two aux calls were paid');
  A.eq(GoalStore.willOfferDecomposition(), false, 'after two failures the belief is marked offered — it stops re-billing');
  A.eq(await GoalStore.proposeDecomposition(), null, 'and a later run end does not even reach the model');
  A.eq(chatCalls, stubbornBefore + 2, 'no third aux call is ever paid for this belief state');
  // …but a CHANGED belief is a fresh question, and a good reply clears the failure memory
  goalsBeliefs = [{ id: 'cd_80', text: 'a goal this model can never decompose properly, reworded by hand' }];
  harnessReply = '1. first real step\n2. second real step\n3. third real step';
  const revived = await GoalStore.proposeDecomposition();
  A.ok(revived && revived.texts.length === 3, 'a changed belief re-opens the question and can succeed');
  // a path SHORTER than the confirm panel's floor is a failure here too (it would have been dropped anyway)
  goalsBeliefs = [{ id: 'cd_81', text: 'a goal that decomposes into only two steps somehow' }];
  harnessReply = '1. only step one\n2. only step two';
  const shortBefore = chatCalls;
  A.eq(await GoalStore.proposeDecomposition(), null, 'an under-3-milestone path is unusable, not a proposal');
  A.eq(await GoalStore.proposeDecomposition(), null, 'and it fails again');
  A.eq(GoalStore.willOfferDecomposition(), false, 'two short paths also close the belief (no endless re-spend)');
  A.eq(chatCalls, shortBefore + 2, 'the short-path belief cost exactly two calls, ever');
  harnessReply = '1. Set up the runtime\n2. Wire the event bus\n3. Build the first agent loop';

  /* ====== 12. REVIEW FIX 5 — the offered-fingerprint memory is FIFO-capped (no unbounded growth) ====== */
  for (let i = 0; i < 120; i++) { goalsBeliefs = [{ id: 'cd_cap_' + i, text: 'capped goal number ' + i + ' distinct' }]; GoalStore.declineDecomposition(GoalStore.pendingDecomposition() || goalsBeliefs[0]); }
  A.ok(GoalStore._state().offeredOrder.length <= 100, 'the offered set is FIFO-capped at 100 (bounded localStorage)');
  A.eq(Object.keys(GoalStore._state().offered).length, GoalStore._state().offeredOrder.length, 'the offered map and its order stay in lockstep (evicted keys are deleted)');
  // the cap survives a persistence round-trip
  GoalStore.init({ now: () => clock, getSystem: () => '', launchDirective: t => launches.push(t) });
  A.ok(GoalStore._state().offeredOrder.length <= 100, 'the FIFO cap round-trips through hydrate');

  /* ---- source-locks: the chat.js/stationui glue actually drives the tested seams (idiom of study.test §3) ---- */
  const fs = require('fs');
  const path = require('path');
  const chatSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');
  const iArc = chatSrc.indexOf('async function offerArc');
  A.ok(iArc > 0, 'chat.js defines offerArc');
  const arcBody = chatSrc.slice(iArc, iArc + 4200);
  A.ok(/handoff:\s*\(\) => turninQueue\.length > 0 \? 'memory' : null/.test(arcBody), 'offerArc hands the shared slot to a queued memory deck on resolve');
  A.ok(/if \(turninQueue\.length && !activeTurnin\) showNextTurnin\(\);/.test(arcBody), 'offerArc DRAINS the queued memory deck in its finally (fix 1: never a stranded invisible deck)');
  A.ok(/Goals\.resolveConfirmChoice/.test(arcBody), 'offerArc routes the choice through the PURE resolver (fix 3 lives in tested code)');
  A.ok(/q\.isNext && !q\.inFlight/.test(uiSrc), 'stationui renders Accept only for a NOT-in-flight front step (fix 2 render state)');

  const flexible = await GoalStore.createGoal('Reclaim my evenings', 'My weekly report runs reliably', ['Map the repeated work', 'Draft a report template', 'Test the automation']);
  A.ok(flexible.ok, 'create a user-authored goal');
  const flexibleGoal = GoalStore.activeGoal();
  const selectedId = flexibleGoal.milestones[1].id;
  A.ok(GoalStore.chooseNext(flexibleGoal.id, selectedId), 'choose a useful alternative next step');
  GoalStore.init({ now: () => clock, getSystem: () => '', launchDirective: t => launches.push(t) });
  A.eq(GoalStore.briefing().next.id, selectedId, 'chosen next step survives hydration');
  A.eq(GoalStore.briefing().goal.successCondition, 'My weekly report runs reliably', 'return keeps why the work matters');
  GoalStore.acceptMilestone(flexibleGoal.id, selectedId);
  A.ok(launches[launches.length - 1].includes('My weekly report runs reliably'), 'launched task carries the actual outcome context');
  A.eq(GoalStore.chooseNext(flexibleGoal.id, flexibleGoal.milestones[0].id), false, 'cannot change away from accepted live work');

  // A possibility can become a goal without losing the learning that motivated it.
  GoalStore.reset(); goalsBeliefs = [];
  const ideaId = GoalStore.saveIdea(null, 'Make a short animated film', 'Storyboard a thirty-second scene', 'A tiny cast makes the story clearer.');
  A.ok(ideaId, 'capture an experiment without requiring a goal or success condition');
  const expanded = await GoalStore.createGoal('Make a short animated film', 'Share a finished thirty-second film with three friends', ['Storyboard a thirty-second scene', 'Record the dialogue'], { ideaId, motivation: 'Tell stories with my family', constraints: 'Two evenings, no purchases' });
  A.ok(expanded.ok, 'convert an experiment into a real goal');
  let film = GoalStore.activeGoal();
  A.eq(GoalStore.listIdeas()[0].goalId, film.id, 'the original possibility links to the saved chapter');
  A.ok(film.journal.some(e => e.text.includes('tiny cast')), 'experiment learning carries forward');
  const contextHistory = film.journal.length;
  A.ok(GoalStore.saveContext(film.id, film.motivation, film.constraints), 'saving unchanged context is successful');
  A.eq(film.journal.length, contextHistory, 'unchanged context does not add a history entry');
  A.ok(GoalStore.reviseStep(film.id, film.milestones[1].id, 'Record a scratch dialogue track'), 'revise unaccepted work');
  A.ok(film.journal.some(e => e.text.includes('Record the dialogue →')), 'the previous objective remains in revision history');
  A.ok(GoalStore.reflect(film.id, 'The first scene needs a quieter ending.'), 'record an observation without claiming achievement');
  const reflectionHistory = film.journal.length;
  A.ok(GoalStore.reflect(film.id, 'The first scene needs a quieter ending.'), 'repeated reflection save is acknowledged');
  A.eq(film.journal.length, reflectionHistory, 'repeat click does not duplicate the reflection');
  clock += 6000;
  A.ok(GoalStore.reflect(film.id, 'The first scene needs a quieter ending.'), 'the same observation can be recorded again later');
  A.eq(film.journal.length, reflectionHistory + 1, 'duplicate-click protection does not erase later reflection history');
  A.ok(GoalStore.reviewPrompt(film.id).includes('quieter ending'), 'crew review includes the real reflection');
  const beforeJourneyWrites = journeyPosts.length;
  A.ok(GoalStore.setDisposition(film.id, 'paused', 'Waiting for a free weekend'), 'pause a goal');
  A.eq(GoalStore.activeGoal(), null, 'paused goal no longer claims current focus');
  A.eq(GoalStore.acceptMilestone(film.id, film.milestones[0].id), null, 'paused work cannot launch');
  A.eq(journeyPosts.length, beforeJourneyWrites, 'reflection and pause award no milestone progress');
  GoalStore.init({ now: () => ++clock, launchDirective: t => launches.push(t) });
  film = GoalStore.listGoals()[0];
  A.eq(film.status, 'paused', 'pause survives hydration');
  A.eq(film.constraints, 'Two evenings, no purchases', 'constraints survive hydration');
  A.ok(film.journal.some(e => e.kind === 'paused'), 'the reason for pausing survives hydration');
  A.eq(GoalStore.listIdeas()[0].learning, 'A tiny cast makes the story clearer.', 'experiment notes survive hydration');
  A.ok(GoalStore.setDisposition(film.id, 'active'), 'resume and focus');
  GoalStore.acceptMilestone(film.id, film.milestones[0].id);
  A.ok(launches.at(-1).includes('Two evenings, no purchases'), 'actual execution includes user constraints');
  A.ok(launches.at(-1).includes('quieter ending'), 'actual execution includes latest reflection');
  A.eq(GoalStore.setDisposition(film.id, 'archived'), false, 'cannot hide accepted live work by archiving');
  A.eq(GoalStore.reviseStep(film.id, film.milestones[0].id, 'A different scene'), false, 'accepted work cannot silently change objective');
  wqComplete(film.milestones[0].questRef);
  A.ok(GoalStore.setDisposition(film.id, 'archived', 'Keep the work for next year'), 'reconciles completed work before archiving');
  A.eq(film.milestones[0].status, 'done', 'archiving does not lose a completed step awaiting reconciliation');
  A.eq(film.status, 'archived', 'archive is not an outcome claim');
  A.ok(GoalStore.setDisposition(film.id, 'active'), 'archived work can be resumed');
  outcomeAvailable = true;
  A.ok((await GoalStore.confirmOutcome(film.id, 'Local test: shared the completed film with three friends.')).ok, 'only explicit outcome report finishes the goal');
  A.eq(GoalStore.setDisposition(film.id, 'active'), false, 'a completed chapter is not reopened as another earnable goal');
  A.ok(GoalStore.reviewPrompt(film.id).includes('Saved chapter status: done'), 'a completed chapter review includes its actual status');
  A.ok(GoalStore.reviewPrompt(film.id).includes('Local test: shared the completed film'), 'a completed chapter review includes the reported outcome, not only its older plan');
  const exported = JSON.parse(GoalStore.exportJourney());
  A.eq(exported.goals[0].outcomeEvidence, film.outcomeEvidence, 'export preserves the final outcome evidence');
  A.eq(exported.ideas[0].id, ideaId, 'export includes the original possibility');
  const retained = JSON.parse(mem['starnet.goals.v1']);
  retained.goals = Array.from({ length: 26 }, (_, i) => ({ ...retained.goals[0], id: 'kept_' + i, createdAt: i }));
  mem['starnet.goals.v1'] = JSON.stringify(retained); GoalStore.init({ now: () => ++clock });
  A.eq(GoalStore.listGoals().length, 26, 'growing a journey never evicts earlier completed chapters');
  const beforeSuggestion = GoalStore.exportJourney(), beforeLaunches = launches.length;
  let planningRequest;
  global.Harness.chat = async request => { planningRequest = request; return { text: '```json\n' + JSON.stringify({ successCondition: 'A friend can use the draft', steps: ['Build one small example'] }) + '\n```' }; };
  const suggested = await GoalStore.suggestPlan('I want to try making an app', { constraints: 'One evening' });
  A.ok(suggested.ok && suggested.steps.length === 1, 'uncertain ambition can produce a one-step editable plan');
  A.ok(planningRequest.messages[0].content.includes('One evening'), 'suggestion incorporates the user boundaries');
  A.eq(planningRequest.isTask, false, 'planning uses the existing tool-free model path');
  A.eq(launches.length, beforeLaunches, 'suggesting a plan never launches a work step');
  A.eq(JSON.parse(GoalStore.exportJourney()).goals.length, JSON.parse(beforeSuggestion).goals.length, 'a suggestion never creates a goal');
  for (const invalid of ['not json', '{"successCondition":"fine","steps":[]}', '{"successCondition":"fine","steps":[{}]}', '{"successCondition":"","steps":["Make a draft"]}']) {
    global.Harness.chat = async () => ({ text: invalid });
    A.eq((await GoalStore.suggestPlan('Try a new idea')).ok, false, 'malformed planning output is recoverable without mutating a plan');
  }
  global.Harness.chat = async () => { throw new Error('offline'); };
  A.eq((await GoalStore.suggestPlan('Try a new idea')).ok, false, 'offline planning returns an actionable failure');
  A.report('goalstore.test');
})();
