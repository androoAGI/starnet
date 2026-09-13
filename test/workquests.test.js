/* node test/workquests.test.js — the PURE work-quest generator (frontend/app/workquests.js).
   Locks the G1c contract: an accepted idea mints a multi-step build; a recipe with param-gaps → one step per
   gap + a launch step; a runnable recipe / workflow build → a single run step; ticking the last open step
   completes the quest (the open→done edge QuestState folds → G1a celebration); a run binds + completes on
   finish; dismissal = STOP FOREVER; the projection rides the shared Quests shape (kind 'work'); no fake
   currency; deterministic (injected clock). */
'use strict';
const A = require('./_assert.js');
const WQ = require('../frontend/app/workquests.js');

/* ---------- defensive ---------- */
A.eq(WQ.project(null), [], 'project(null) → [] — never throws');
A.eq(WQ.openCount(null), 0, 'openCount(null) → 0');
A.eq(WQ.mint(null, { title: 'x' }, 1), null, 'mint on a null state is refused');
A.eq(WQ.tickStep(null, 'wq:1', 'run', 1), false, 'tickStep on a null state is refused');
A.eq(WQ.dismiss(null, 'wq:1', 1), false, 'dismiss on a null state is refused');

/* ---------- mint: a recipe with gaps → gap steps + a launch step ---------- */
const s = WQ.fresh();
const gapId = WQ.mint(s, { title: 'morning brief', recipeId: 'brief', gaps: [{ key: 'topic', label: 'fill: Topic' }, { key: 'window', label: 'fill: Look-back' }] }, 1000);
A.eq(gapId, 'wq:1', 'the first quest id is wq:1');
A.eq(s.quests[gapId].steps.length, 3, 'two gaps + a launch step = three steps');
A.eq(s.quests[gapId].steps[2].key, 'launch', 'the final step is the launch');
A.eq(WQ.openCount(s), 1, 'one open build');

/* ---------- mint: a runnable recipe / workflow build → a single run step ---------- */
const runId = WQ.mint(s, { title: 'price watcher', recipeId: null, gaps: [] }, 1100);
A.eq(runId, 'wq:2', 'two genuine accepts are two distinct quests (mint is NOT deduped by title — each is a real commitment)');
A.eq(s.quests[runId].steps.length, 1, 'no gaps → a single run-completion step');
A.eq(s.quests[runId].steps[0].key, 'run', 'the single step is the run');

/* ---------- projection: shape, step progress in the desc, no fake currency ---------- */
let proj = WQ.project(s);
A.eq(proj.length, 2, 'both open builds project');
A.ok(proj.every(q => q.kind === 'work'), 'kind is work (one quest shape)');
const gapProj = proj.find(q => q.id === gapId);
A.ok(/build: morning brief/.test(gapProj.title), 'the title names the build');
A.ok(/0 of 3/.test(gapProj.desc), 'the desc shows step progress');
A.ok(proj.every(q => !/\bXP\b|points|coins/i.test(q.reward + ' ' + q.desc)), 'no build rewards a fake currency');

/* ---------- ticking steps advances; the last step completes ---------- */
A.eq(WQ.tickStep(s, gapId, 'gap:topic', 2000), true, 'ticking a gap step takes');
A.eq(WQ.tickStep(s, gapId, 'gap:topic', 2001), false, 'ticking it again is idempotent');
A.eq(s.quests[gapId].completedAt, null, 'not done yet — steps remain');
WQ.tickStep(s, gapId, 'gap:window', 2002);
A.eq(s.quests[gapId].completedAt, null, 'still one step (launch) open');
A.eq(WQ.tickStep(s, gapId, 'launch', 2003), true, 'ticking the last open step takes');
A.eq(s.quests[gapId].completedAt, 2003, 'the last step completes the quest (the open→done edge)');
proj = WQ.project(s);
A.ok(/^built —/.test(proj.find(q => q.id === gapId).title), 'a completed build reads as built');

/* ---------- run binding + completion on run.end ---------- */
A.eq(WQ.bindRun(s, runId, 'r-42'), true, 'the launched run binds to the build');
A.eq(WQ.project(s).find(q => q.id === runId).runId, 'r-42', 'goal output links receive the actual bound run identity');
A.eq(WQ.questForRun(s, 'r-42'), runId, 'the run resolves back to its build');
A.eq(WQ.questForRun(s, 'nope'), null, 'an unrelated run resolves to nothing');
WQ.tickStep(s, runId, 'run', 3000);   // the run finished
A.eq(s.quests[runId].completedAt, 3000, 'finishing the run completes the run-build');
A.eq(WQ.questForRun(s, 'r-42'), null, 'a completed build is no longer bound to its run');

/* ---------- seed credit rides the card ---------- */
const seedId = WQ.mint(s, { title: 'the digest', recipeId: null, gaps: [], credit: '(built from a seed you saved)' }, 4000);
A.ok(/built from a seed you saved/.test(WQ.project(s).find(q => q.id === seedId).desc), 'a seedborn build carries the credit line on the card');

/* ---------- dismissal: permanent, survives hydrate ---------- */
A.eq(WQ.dismiss(s, seedId, 5000), true, 'dismissing an open build takes');
A.eq(WQ.project(s).some(q => q.id === seedId), false, 'a dismissed build never re-renders');
const round = WQ.hydrate(JSON.parse(JSON.stringify(s)));
A.eq(WQ.isDismissed(round, seedId), true, 'dismissal survives a hydrate round-trip');
A.eq(round.seq, s.seq, 'the id sequence survives the round-trip (no id reuse after reload)');

A.report('workquests.test');
