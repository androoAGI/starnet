/* node test/goals.test.js — GROWTH Tier 2: the PURE GOAL-TREE engine (frontend/app/goals.js).

   Understanding → direction: a flat dossier goals-belief becomes a structured, persisted PATH — one goal
   decomposed into 3-5 milestones, the next OPEN one the actionable front, real chaining as work completes, an
   HONEST progress meter (done/total, nothing synthetic), evidence written back, and drift retiring the tree.
   Mirrors quests.test.js / dossier.test.js: deterministic (injected clock), value-floor + cap + redaction on the
   parse, fail-open on garbage, and the projection into the shared Quests shape. */
'use strict';
const A = require('./_assert.js');
const G = require('../frontend/app/goals.js');

/* ============================ 1. DECOMPOSITION DIRECTIVE + PARSE ============================ */

// the directive is deterministic + carries the goal text + the 3-5 milestone constraint
const dir = G.buildDirective('ship a local-first agent harness');
A.eq(dir, G.buildDirective('ship a local-first agent harness'), 'buildDirective is deterministic');
A.ok(dir.indexOf('ship a local-first agent harness') >= 0, 'the directive carries the goal text');
A.ok(/between 3 and 5 milestones/i.test(dir), 'the directive states the 3-5 milestone constraint');
A.ok(dir.indexOf('Do not run any tools') >= 0, 'the directive is reason-only (no tools)');

// parse: numbered/bulleted lines → clean milestone strings; framing/floored lines dropped
const raw = '1. Set up the local runtime\n2. Wire the event bus\n3. Build the first agent loop\n- ship the UI shell';
const ms = G.parseDecomposition(raw);
A.eq(ms.length, 4, 'four valid milestone lines parsed (ordinals/bullets stripped)');
A.eq(ms[0], 'Set up the local runtime', 'the leading ordinal is stripped from a milestone');
A.eq(ms[3], 'ship the UI shell', 'a bulleted line is parsed too');

// framing headers + trivia + run-narration are dropped by the floor; a too-short path returns []
const framed = 'Here is the plan:\nMilestones:\n1. do a\n2. ok\n3. we discussed node today\n4. build the real pipeline end to end';
const fp = G.parseDecomposition(framed);
A.ok(fp.indexOf('Here is the plan:') < 0 && fp.indexOf('Milestones:') < 0, 'framing header lines are dropped');
A.ok(fp.indexOf('ok') < 0, 'a value-floored trivial line is dropped');
A.ok(fp.every(t => !/we discussed node today/.test(t)), 'a run-narration line is dropped by the floor');

// the 3-milestone FLOOR: fewer than MIN → [] (an under-decomposed goal is not worth a confirm)
A.eq(G.parseDecomposition('1. only one\n2. and two').length, 0, 'fewer than 3 usable milestones → [] (never a partial tree)');
// the 5-milestone CAP
A.eq(G.parseDecomposition('1. step alpha one\n2. step beta two\n3. step gamma three\n4. step delta four\n5. step epsilon five\n6. step zeta six\n7. step eta seven').length, 5, 'the milestone count is capped at 5');
// near-exact dedup (a repeated step is not doubled)
A.eq(G.parseDecomposition('1. build the loop\n2. build the loop\n3. wire the bus\n4. ship the shell').length, 3, 'a repeated milestone is deduped');
// garbage in → [] (never throws)
A.eq(G.parseDecomposition(null).length, 0, 'null reply → [] (fail-open)');
A.eq(G.parseDecomposition('').length, 0, 'empty reply → []');

// REDACTION: a secret-shaped milestone is scrubbed before it can be stored (always-on floor, even with no inject)
const leak = G.parseDecomposition('1. use the key sk-or-v1-0123456789abcdef0123456789\n2. wire the bus properly\n3. ship the shell now');
A.ok(leak.length >= 3 && leak.every(t => t.indexOf('sk-or-v1') < 0), 'a raw key shape is scrubbed from a milestone');
A.ok(G.scrubSecrets('token ghp_0123456789abcdefghij redacted?').indexOf('ghp_') < 0, 'a github token shape is scrubbed');
// a host-injected redact runs too (composed with the floor)
const both = G.parseDecomposition('1. call NAME the runtime\n2. wire the bus\n3. ship the shell', { redact: s => s.replace(/NAME/g, 'X') });
A.ok(both[0].indexOf('NAME') < 0, 'an injected redact is applied on top of the secret floor');

/* ============================ 2. MAKE GOAL + PROGRESS MATH ============================ */

const goal = G.makeGoal('ship the harness', ['step one now', 'step two here', 'step three too'], 'cd_5', 1000);
A.ok(goal && goal.id === 'goal_1000', 'makeGoal ids the goal from the injected clock (deterministic)');
A.eq(goal.status, 'active', 'a new goal is active');
A.eq(goal.sourceBeliefId, 'cd_5', 'the goal binds to its source belief id');
A.eq(goal.milestones.length, 3, 'the goal holds its milestones');
A.eq(goal.milestones[0].id, 'goal_1000:m1', 'milestone ids are deterministic (goalId:mN)');
A.eq(goal.milestones[0].status, 'open', 'a new milestone is open');
// the floor is enforced in makeGoal too (a hand-edited too-short path can't create a degenerate goal)
A.eq(G.makeGoal('g', ['only one', 'and two'], 'cd_1', 1), null, 'makeGoal returns null on a sub-3 path (floor enforced)');

// PROGRESS = done/total, honest, nothing synthetic
A.eq(G.progress(goal), { done: 0, total: 3, pct: 0 }, 'a fresh goal reads 0/3/0%');
A.eq(G.progress(null), { done: 0, total: 0, pct: 0 }, 'a null goal reads 0/0/0 (never a divide-by-zero)');
A.eq(G.nextMilestone(goal).id, 'goal_1000:m1', 'nextMilestone is the first open one');

/* ============================ 3. CHAINING + EVIDENCE FOLD ============================ */

// bind a real work quest to the front milestone, then complete it → the milestone folds done + advances the bar
A.eq(G.bindMilestoneQuest(goal, 'goal_1000:m1', 'wq:7'), true, 'the front milestone binds to a work quest');
A.eq(G.bindMilestoneQuest(goal, 'goal_1000:m2', 'wq:8'), true, 'a later milestone can bind too');
const hit = G.milestoneForQuest([goal], 'wq:7');
A.ok(hit && hit.milestone.id === 'goal_1000:m1', 'milestoneForQuest finds the OPEN milestone bound to a quest');

let r = G.foldMilestoneDone(goal, 'goal_1000:m1', 'shipped the runtime', 2000);
A.eq(r.changed, true, 'folding a bound milestone done changes it');
A.eq(r.goalDone, false, 'the goal is not done yet (more milestones open)');
A.eq(goal.milestones[0].status, 'done', 'the milestone is now done');
A.eq(goal.milestones[0].doneAt, 2000, 'doneAt is stamped from the injected clock');
A.ok(goal.milestones[0].evidence.indexOf('shipped the runtime') >= 0, 'the evidence is written onto the node');
A.eq(G.progress(goal), { done: 1, total: 3, pct: 33 }, 'progress advances to 1/3/33% (honest math)');
A.eq(G.nextMilestone(goal).id, 'goal_1000:m2', 'the NEXT open milestone surfaces (real chaining)');

// idempotent: re-folding a done milestone is a no-op
A.eq(G.foldMilestoneDone(goal, 'goal_1000:m1', 'x', 3000).changed, false, 're-folding a done milestone is a no-op');
// milestoneForQuest no longer matches the done one (only OPEN milestones)
A.eq(G.milestoneForQuest([goal], 'wq:7'), null, 'a done milestone is no longer matched by its quest');

// completing the LAST milestone completes the whole GOAL
G.foldMilestoneDone(goal, 'goal_1000:m2', 'shipped the bus', 4000);
const last = G.foldMilestoneDone(goal, 'goal_1000:m3', 'shipped the shell', 5000);
A.eq(last.goalDone, false, 'the last planned step cannot prove a life outcome');
A.eq(last.planDone, true, 'all planned actions are complete');
A.eq(goal.status, 'active', 'the goal awaits explicit outcome confirmation');
A.eq(G.progress(goal), { done: 3, total: 3, pct: 100 }, 'a done goal reads 3/3/100%');
A.eq(G.nextMilestone(goal), null, 'a done goal surfaces no next milestone');
// a done goal never moves again (a fold on it is inert)
A.eq(G.foldMilestoneDone(goal, 'goal_1000:m3', 'x', 6000).changed, false, 'a done goal is immutable to further folds');

/* ============================ 4. DRIFT / RETIRE PROPAGATION ============================ */

// The outcome confirmation path owns this transition; ordinary milestone folds cannot do it.
goal.status = 'done';

const active = G.makeGoal('a live goal', ['aa now', 'bb here', 'cc too'], 'cd_9', 100);
A.eq(G.retireBySource(active, 'cd_9', 200), true, 'retireBySource retires the goal whose source belief was forgotten');
A.eq(active.status, 'retired', 'the drifted goal is retired (kept for history)');
A.eq(G.nextMilestone(active), null, 'a retired goal surfaces no milestone (hidden from the active log)');
A.eq(G.retireBySource(active, 'cd_9', 300), false, 'retiring an already-retired goal is a no-op');
// a retire only touches the matching source; a done goal is never "drift" (it stays a trophy)
A.eq(G.retireBySource(active, 'cd_other', 400), false, 'retireBySource ignores a non-matching source');
A.eq(G.retireBySource(goal, 'cd_5', 500), false, 'a DONE goal never retires on drift (a shipped goal is not drift)');
// a retired goal's milestones never fold either
const active2 = G.makeGoal('g2', ['a1 now', 'b1 here', 'c1 too'], 'cd_x', 1);
G.retireBySource(active2, 'cd_x', 2);
A.eq(G.foldMilestoneDone(active2, active2.milestones[0].id, 'x', 3).changed, false, 'a retired goal never advances');

/* ============================ 5. ACTIVE GOAL + PROJECTION ============================ */

// activeGoal = the most-recent ACTIVE goal (a fresh decomposition supersedes an older arc); ignores done/retired
const g1 = G.makeGoal('older goal', ['o1 now', 'o2 here', 'o3 too'], 'cd_a', 100);
const g2 = G.makeGoal('newer goal', ['n1 now', 'n2 here', 'n3 too'], 'cd_b', 200);
A.eq(G.activeGoal([g1, g2, goal, active]).id, g2.id, 'activeGoal is the most-recent ACTIVE goal (done/retired ignored)');
A.eq(G.activeGoal([goal, active]), null, 'no active goal → null (all done/retired)');
A.eq(G.activeGoal([]), null, 'empty → null');

// PROJECT: a header (arc-goal, meter) + one row per milestone (arc-step), the next OPEN one the actionable front
G.foldMilestoneDone(g2, 'goal_200:m1', 'did n1', 250);
const proj = G.project([g1, g2]);
A.eq(proj[0].kind, 'arc-goal', 'the projection leads with the goal header');
A.eq(proj[0].arcGoalId, g2.id, 'the header is for the ACTIVE goal (newest)');
A.ok(/1 of 3/.test(proj[0].desc), 'the header desc carries the honest progress (1 of 3)');
A.eq(proj[0].pct, 33, 'the header carries the progress pct');
const steps = proj.filter(q => q.kind === 'arc-step');
A.eq(steps.length, 3, 'one arc-step per milestone');
A.eq(steps[0].status, 'done', 'the completed milestone renders done');
A.ok(steps[0].desc.indexOf('did n1') >= 0, 'a done step shows its evidence');
A.eq(steps[1].isNext, true, 'the first OPEN milestone is flagged the actionable front');
A.eq(steps[2].isNext, false, 'a later open milestone is NOT the front (honest chaining, never gating)');
A.ok(steps.every(s => s.arcGoalId === g2.id && s.milestoneId), 'each step carries its goal + milestone id (the accept route)');
// a done / retired-only set projects nothing (the arc lives in the trophy case / history)
A.eq(G.project([goal]).length, 0, 'a done-only goal projects no active arc');
A.eq(G.project([active]).length, 0, 'a retired-only goal projects no active arc');
A.eq(G.project([]).length, 0, 'no goals → [] (absent-input safe)');

/* ---- IN-FLIGHT render state (review fix 2): a live-bound front milestone reads "in progress" (no Accept) ---- */
G.bindMilestoneQuest(g2, 'goal_200:m2', 'wq:9');
const projLive = G.project([g2], { questLive: ref => ref === 'wq:9' });
const front = projLive.filter(q => q.kind === 'arc-step').find(s => s.isNext);
A.eq(front.inFlight, true, 'a front milestone with a LIVE bound quest is flagged inFlight');
A.ok(/in progress/.test(front.desc), 'an in-flight step reads "in progress" (never a second Accept)');
const projDead = G.project([g2], { questLive: () => false });
const front2 = projDead.filter(q => q.kind === 'arc-step').find(s => s.isNext);
A.eq(front2.inFlight, false, 'a dead/stalled/dismissed binding is NOT in flight — Accept re-offers (recovery path)');
A.eq(G.project([g2]).filter(q => q.kind === 'arc-step').find(s => s.isNext).inFlight, false, 'no questLive input → never inFlight (absent-input safe, older callers unchanged)');

/* ---- resolveConfirmChoice (review fix 3): the tested home for Confirm / ✎-Edit / Not-now routing ---- */
const basePath = ['step one now', 'step two here', 'step three too', 'step four also', 'step five more'];
A.eq(G.resolveConfirmChoice({ value: 'confirm' }, basePath), { action: 'confirm', path: basePath }, 'an explicit Confirm keeps the proposed path');
A.eq(G.resolveConfirmChoice({ value: 'other', skip: true }, basePath).action, 'decline', 'not-now declines');
A.eq(G.resolveConfirmChoice(null, basePath).action, 'decline', 'no choice declines (panel dismissed)');
// a VALID edit (≥3 steps, ; or newline separated, ordinals stripped) confirms the EDITED path
const edited = G.resolveConfirmChoice({ custom: true, value: '1. do alpha first; 2. do beta second; 3. do gamma third' }, basePath);
A.eq(edited.action, 'confirm', 'a valid 3-step edit confirms');
A.eq(edited.path, ['do alpha first', 'do beta second', 'do gamma third'], 'the EDITED path replaces the model path (ordinals stripped)');
// an over-long edit is capped at MAX
A.eq(G.resolveConfirmChoice({ custom: true, value: 'a1 x; b2 x; c3 x; d4 x; e5 x; f6 x' }, basePath).path.length, 5, 'an edited path is capped at 5');
// THE FIX: a too-short edit is a REJECTION — decline, never silently persist the unedited model tree
const short = G.resolveConfirmChoice({ custom: true, value: 'just do X' }, basePath);
A.eq(short.action, 'decline', 'an edit under the 3-step floor DECLINES (the Commander rejected the tree)');
A.eq(G.resolveConfirmChoice({ custom: true, value: '' }, basePath).action, 'decline', 'an empty edit declines too');

// A chosen next step survives projection without rewriting the plan or completed history.
const flexible = G.makeGoal('Make a useful app', ['Build the app', 'Prepare feedback', 'Review responses'], null, 100);
const originalOrder = flexible.milestones.map(m => m.id);
A.ok(G.chooseNext(flexible, originalOrder[1], 200, () => false), 'Commander can choose a later open step');
A.eq(G.nextMilestone(flexible).id, originalOrder[1], 'chosen step becomes next');
A.eq(flexible.milestones.map(m => m.id), originalOrder, 'choosing next preserves original plan order');
A.eq(G.project([flexible]).find(q => q.isNext).milestoneId, originalOrder[1], 'quest projection follows the chosen next step');
flexible.milestones[1].questRef = 'live-work';
A.eq(G.chooseNext(flexible, originalOrder[2], 300, () => true), false, 'cannot move the next step away from an accepted build');
G.foldMilestoneDone(flexible, originalOrder[1], 'Prepared a feedback form', 400);
A.eq(G.nextMilestone(flexible).id, originalOrder[0], 'after chosen completion returns to remaining plan');
A.eq(G.chooseNext(flexible, originalOrder[1], 500, () => false), false, 'completed step cannot be selected again');
A.eq(G.chooseNext(flexible, 'missing', 500, () => false), false, 'unknown step cannot be selected');
const brief = G.briefing([flexible], () => false);
A.eq(brief.latest.evidence, 'Prepared a feedback form', 'return briefing preserves actual evidence');
A.eq(brief.progress.done, 1, 'return briefing counts completed plan steps');
A.eq(flexible.status, 'active', 'work progress never confirms the overall outcome');
flexible.status = 'done'; flexible.outcomeEvidence = 'Five people reported using it'; flexible.updatedAt = 600;
A.eq(G.briefing([flexible]).completedGoal.outcomeEvidence, 'Five people reported using it', 'completed goal remains a readable chapter');
A.eq(G.briefing([]).completedGoal, null, 'new Commander gets no invented history');
A.report('goals.test');
