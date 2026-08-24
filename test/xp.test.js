/* node test/xp.test.js - the AGENT-GROWTH model.
   XP/levels are satisfaction-gated: only explicit positive user turn-in feedback mints XP.
   Operational events still update counters and milestones, but cannot level an agent by themselves.
   Negative feedback calibrates confidence down without subtracting XP or levels. */
'use strict';
const A = require('./_assert.js');
const Xp = require('../frontend/app/xp.js');

// ---- helpers ----
function run(events, start) {
  let s = start ? Xp.clone(start) : Xp.fresh();
  const awards = [];
  for (const e of events) { const r = Xp.applyEvent(s, e); s = r.stats; awards.push(r.awards); }
  return { stats: s, awards };
}
// Production run ids are unique. The helpers generate one per default run while keeping [memUsed(), done()]
// on the same id so buffered memory-reuse credit still commits (or is discarded) correctly.
let helperRunSeq = 0, pendingHelperRun = null;
function nextHelperRun() { return 'helper-' + (++helperRunSeq); }
function endHelperRun(runId) { const id = runId || pendingHelperRun || nextHelperRun(); pendingHelperRun = null; return id; }
const done = (usd, runId) => ({ name: 'agent.run.end', payload: { agentId: 'a', runId: endHelperRun(runId), reason: 'done', turns: 1, usd: usd == null ? 1 : usd } });
const errd = runId => ({ name: 'agent.run.end', payload: { agentId: 'a', runId: endHelperRun(runId), reason: 'error', turns: 1, usd: 0 } });
const ended = (reason, runId) => ({ name: 'agent.run.end', payload: { agentId: 'a', runId: endHelperRun(runId), reason, turns: 1, usd: 0 } });
const memUsed = (id, runId) => {
  const rid = runId || pendingHelperRun || (pendingHelperRun = nextHelperRun());
  return { name: 'memory.used', payload: { agentId: 'a', runId: rid, id: id || 'm1' } };
};
const feedback = (delta, reason) => ({ name: 'memory.feedback', payload: { agentId: 'a', id: 'm1', delta, reason: reason || 'kept' } });
const keep = () => feedback(2, 'kept');
const edit = () => feedback(1, 'edited');
const discard = () => feedback(-1, 'discarded');
const helpful = () => feedback(2, 'helpful');
const unhelpful = () => feedback(-1, 'unhelpful');
const toolOk = runId => ({ name: 'agent.tool_result', payload: { agentId: 'a', runId, callId: 'c', ok: true, isError: false } });
const delivered = () => ({ name: 'workitem.delivered', payload: { agentId: 'a', workitemId: 'w', finalQueueId: 'q' } });

// ---- the curve: cumulative XP to REACH level n = 25*n*(n-1) ----
A.eq(Xp.xpForLevel(1), 0, 'L1 = 0 xp');
A.eq(Xp.xpForLevel(2), 50, 'L2 = 50');
A.eq(Xp.xpForLevel(3), 150, 'L3 = 150');
A.eq(Xp.xpForLevel(5), 500, 'L5 = 500');
A.eq(Xp.xpForLevel(10), 2250, 'L10 = 2250');
A.eq(Xp.xpForLevel(28), 18900, 'L28 = 18900 (the long-haul station number)');

A.eq(Xp.levelForXp(0), 1, '0 xp -> L1');
A.eq(Xp.levelForXp(49), 1, 'just below L2 -> L1');
A.eq(Xp.levelForXp(50), 2, 'at threshold -> L2');
A.eq(Xp.levelForXp(149), 2, 'just below L3 -> L2');
A.eq(Xp.levelForXp(150), 3, 'at threshold -> L3');
A.eq(Xp.levelForXp(2249), 9, 'just below L10 -> L9');
A.eq(Xp.levelForXp(2250), 10, 'at threshold -> L10');

// ---- purity: applyEvent never mutates its input ----
const f0 = Xp.fresh();
const r0 = Xp.applyEvent(f0, done());
A.eq(f0.xp, 0, 'input xp untouched');
A.eq(f0.confidence, 50, 'input confidence untouched');
A.eq(r0.stats.xp, 0, 'done awards no xp without user feedback');
A.eq(r0.stats.counters.tasksDone, 1, 'done still updates the shipped-task counter');

// ---- XP per event: only positive feedback mints XP ----
A.eq(Xp.applyEvent(Xp.fresh(), done(0.2)).stats.xp, 0, 'cheap done still earns no xp');
A.eq(Xp.applyEvent(Xp.fresh(), done(0.9)).stats.xp, 0, 'pricey done still earns no xp');
A.eq(run([errd()]).stats.xp, 0, 'error earns no xp');
A.eq(run([memUsed()]).stats.xp, 0, 'memory.used earns no xp');
A.eq(run([toolOk('r1')]).stats.xp, 0, 'tool success earns no xp');
A.eq(run([delivered()]).stats.xp, 0, 'workitem delivery earns no xp without user feedback');
A.eq(run([{ name: 'channel.delivery', payload: { ok: true } }]).stats.xp, 0, 'channel delivery earns no xp without user feedback');
A.eq(Xp.applyEvent(Xp.fresh(), edit()).awards.xp, 10, 'edited/positive feedback delta 1 awards 10 xp');
A.eq(Xp.applyEvent(Xp.fresh(), keep()).awards.xp, 20, 'kept/positive feedback delta 2 awards 20 xp');
A.eq(Xp.applyEvent(Xp.fresh(), discard()).awards.xp, 0, 'negative feedback awards no xp');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(1000, 'kept')).awards.xp, 50, 'a huge finite kept-feedback delta is capped at +50 xp');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(1000, 'huge')).awards.xp, 0, 'unknown memory.feedback reasons do not award xp');

// ---- task-size is legacy receipt telemetry only; equal Commander verdicts earn equal XP ----
const sized = (delta, reason, size) => ({ name: 'memory.feedback', payload: { agentId: 'a', id: 'w1', delta, reason, size } });
A.eq(Xp.workSize({ tools: 0, usd: 0 }), 'small', 'no tools, no spend -> small');
A.eq(Xp.workSize({ tools: 2, usd: 0.01 }), 'small', 'a couple of tool calls is still small');
A.eq(Xp.workSize({ tools: 3, usd: 0 }), 'medium', '3 successful tools -> medium');
A.eq(Xp.workSize({ tools: 0, usd: 0.08 }), 'medium', 'real spend alone can make medium');
A.eq(Xp.workSize({ tools: 6, usd: 0 }), 'large', '6 successful tools -> large');
A.eq(Xp.workSize({ tools: 0, usd: 0.5 }), 'large', 'heavy spend alone -> large');
A.eq(Xp.workSize(null), 'small', 'missing stash -> small (conservative, never inflating)');
A.eq(Xp.applyEvent(Xp.fresh(), sized(3, 'work_great', 'large')).awards.xp, 30, 'large execution shape cannot inflate a verdict');
A.eq(Xp.applyEvent(Xp.fresh(), sized(3, 'work_great', 'medium')).awards.xp, 30, 'medium execution shape cannot inflate a verdict');
A.eq(Xp.applyEvent(Xp.fresh(), sized(3, 'work_great', 'small')).awards.xp, 30, 'small execution shape earns the same verdict credit');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(3, 'work_great')).awards.xp, 30, 'no size hint earns the same credit');
A.eq(Xp.applyEvent(Xp.fresh(), sized(3, 'work_great', 'gigantic')).awards.xp, 30, 'an unknown size string is ignored');
A.eq(Xp.applyEvent(Xp.fresh(), sized(4, 'work_great', 'large')).awards.xp, 40, 'a four-point verdict stays four-point regardless of size');
A.eq(Xp.applyEvent(Xp.fresh(), sized(8, 'work_great', 'large')).awards.xp, 50, 'the final per-verdict cap still applies');
A.eq(Xp.applyEvent(Xp.fresh(), sized(5, 'work_ok', 'large')).awards.xp, 0, 'work_ok still mints nothing');
A.eq(Xp.applyEvent(Xp.fresh(), sized(5, 'work_miss', 'large')).awards.xp, 0, 'work_miss with a size hint still mints nothing (no penalty either)');
A.eq(Xp.applyEvent(Xp.fresh(), sized(2, 'kept', 'large')).awards.xp, 20, 'legacy size cannot inflate the shared mint path');

const equalCrew = Xp.crewSplit({ leadDelta: 3, leadCost: 100, workers: [{ agentId: 'scribe', usd: 0 }, { agentId: 'builder', usd: 50 }, { agentId: 'scribe', usd: 9 }] });
A.eq(equalCrew.workers.map(w => [w.agentId, w.delta]), [['scribe', 3], ['builder', 3]], 'named contributors receive equal verdict credit regardless spend and duplicates collapse');

// ---- "rate the work" verdicts ride memory.feedback (synthetic id, direct XpStore call): only 👍 mints, none penalize ----
A.eq(Xp.applyEvent(Xp.fresh(), feedback(3, 'work_great')).awards.xp, 30, 'work_great delta 3 awards 30 xp');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(8, 'work_great')).awards.xp, 50, 'work_great big task is capped at +50 xp');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(5, 'work_ok')).awards.xp, 0, 'work_ok (close) never mints xp');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(5, 'work_miss')).awards.xp, 0, 'work_miss never mints xp');
const _wg = Xp.applyEvent(Xp.fresh(), feedback(3, 'work_great'));
A.eq(_wg.stats.counters.positiveFeedback, 1, 'work_great counts as positive feedback (drives APPROVED milestone)');
A.eq((_wg.stats.counters.negativeFeedback || 0), 0, 'work_great is not negative');
const _wo = Xp.applyEvent(Xp.fresh(), feedback(5, 'work_ok'));
A.eq((_wo.stats.counters.positiveFeedback || 0), 0, 'work_ok is neutral — not counted positive');
A.eq((_wo.stats.counters.negativeFeedback || 0), 0, 'work_ok is neutral — not counted negative');
A.eq(_wo.stats.samples, 1, 'work_ok still records one satisfaction sample');
const _wm = Xp.applyEvent(Xp.fresh(), feedback(5, 'work_miss'));
A.eq(_wm.stats.counters.negativeFeedback, 1, 'work_miss counts as negative feedback (confidence down)');
A.ok(_wm.stats.xp === 0 && _wm.stats.lifetimeXp === 0, 'work_miss never subtracts xp (no penalty)');

// ---- confidence: bidirectional EWMA over explicit feedback, honest cold-start ----
A.eq(Xp.compute(Xp.fresh()).known, false, 'fresh agent is calibrating, not known');
A.eq(Xp.compute(Xp.fresh()).confidence, null, 'calibrating exposes no fabricated percent');

const noJudgment = run([done(), toolOk('r1'), memUsed(), delivered()]);
A.eq(noJudgment.stats.samples, 0, 'operational events are not satisfaction samples');
A.eq(noJudgment.stats.confidence, 50, 'operational events leave confidence untouched');

const three = run([keep(), keep(), keep()]);
A.ok(Math.abs(three.stats.confidence - 78.90625) < 1e-6, 'confidence EWMA climbs to 78.90625 over 3 positive feedback samples');
A.eq(Xp.compute(three.stats).known, true, 'known once MIN_SAMPLES feedback samples exist');
A.eq(three.stats.samples, 3, '3 feedback samples');
A.eq(three.stats.counters.positiveFeedback, 3, 'positive feedback counter records approvals');

const dropped = run([discard()], three.stats);
A.ok(dropped.stats.confidence < three.stats.confidence, 'negative feedback LOWERS confidence (moves both ways)');
A.eq(dropped.stats.xp, three.stats.xp, 'negative feedback does not subtract xp');
A.eq(dropped.stats.counters.negativeFeedback, 1, 'negative feedback counter records misses');

const zeroFeedback = run([feedback(0, 'neutral')]);
A.eq(zeroFeedback.stats.samples, 0, 'unknown feedback reason is not a satisfaction sample');
A.eq(zeroFeedback.stats.xp, 0, 'unknown feedback reason awards no xp');

const notebookRatings = run([helpful(), unhelpful()]);
A.eq(notebookRatings.stats.samples, 0, 'notebook feedback ratings are not satisfaction samples');
A.eq(notebookRatings.stats.xp, 0, 'notebook feedback ratings do not mint xp');
A.eq(notebookRatings.stats.counters.positiveFeedback || 0, 0, 'notebook helpful does not count as user approval');
A.eq(notebookRatings.stats.counters.negativeFeedback || 0, 0, 'notebook unhelpful does not count as user rejection');

// cancelled = the user aborted; not a satisfaction verdict -> no xp, no confidence sample
const canc = run([{ name: 'agent.run.end', payload: { reason: 'cancelled', turns: 0, usd: 0 } }]);
A.eq(canc.stats.xp, 0, 'cancelled earns no xp');
A.eq(canc.stats.samples, 0, 'cancelled is not a satisfaction sample');

// ---- levels are monotonic; level-up fires only from positive feedback crossing a threshold ----
const twoKeeps = run([keep(), keep()]);
A.eq(twoKeeps.stats.xp, 40, '2 keeps = 40 xp');
A.eq(twoKeeps.stats.level, 1, '40 xp stays level 1');
const thirdKeep = run([keep()], twoKeeps.stats);
A.eq(thirdKeep.stats.xp, 60, 'third keep crosses the level-2 threshold');
A.eq(thirdKeep.stats.level, 2, '60 xp -> level 2');
A.ok(thirdKeep.awards[0].levelUp === true && thirdKeep.awards[0].levelTo === 2, 'level-up fires crossing 50 xp');

const afterBad = run([errd(), discard(), errd()], thirdKeep.stats);
A.eq(afterBad.stats.level, 2, 'a level is NEVER lost on failure or negative feedback');

// ---- milestones fire exactly once, independently of XP ----
const firstTask = run([done()]);
A.ok(firstTask.awards[0].milestones.indexOf('first_light') !== -1, 'first_light on first shipped task');
A.eq(run([done()], firstTask.stats).awards[0].milestones.indexOf('first_light'), -1, 'first_light does not re-fire');
A.ok(run([keep()]).awards[0].milestones.indexOf('approved') !== -1, 'approved on first positive feedback');
// pack_rat now fires only when the run that recalled memory actually COMPLETES — the operational credit is buffered
// per-run and committed at run.end. So the trophy lands on the run.end award (last event), never on the bare recall.
const packRun = run([memUsed(), done()]);
A.eq(packRun.awards[0].milestones.indexOf('pack_rat'), -1, 'bare memory.used does NOT award pack_rat yet (credit is buffered)');
A.ok(packRun.awards[1].milestones.indexOf('pack_rat') !== -1, 'pack_rat lands when the recalling run completes');
A.eq(packRun.stats.counters.memReused, 1, 'a completed run that recalled memory credits memReused once');

// ---- TRUTHFUL-TELEMETRY REGRESSION (the reproduced bug): a run that recalls memory then produces NOTHING must
//      not mint memory-reuse credit or the PACK RAT trophy. Recall happens at context-assembly, BEFORE the model
//      call — so a 404'd run emitted memory.used ×7 then run.end{error}, and used to award the permanent trophy. ----
// (a) the exact repro: 7 memory.used chunks (one recall of 7 records) then an errored run end.
const deadRun = run([memUsed('m1'), memUsed('m2'), memUsed('m3'), memUsed('m4'), memUsed('m5'), memUsed('m6'), memUsed('m7'), errd()]);
A.eq(deadRun.stats.counters.memReused || 0, 0, 'a run that 404s after recall credits NO memory reuse (was 7 — the bug)');
A.ok(deadRun.awards.every(a => a.milestones.indexOf('pack_rat') === -1), 'no PACK RAT trophy for a recall that never fed a real turn');
A.eq(Xp.milestones(deadRun.stats).find(m => m.id === 'pack_rat').earned, false, 'PACK RAT reads locked after an errored recall run');
// (b) an EMPTY run (degraded provider streamed a zero-tool, zero-text turn) is likewise no work → no credit.
const emptyRun = run([memUsed(), ended('empty')]);
A.eq(emptyRun.stats.counters.memReused || 0, 0, 'an empty run (produced nothing) credits no memory reuse');
A.eq(Xp.milestones(emptyRun.stats).find(m => m.id === 'pack_rat').earned, false, 'PACK RAT stays locked after an empty recall run');
// (c) N-per-recall inflation is gone: a DONE run with a 7-chunk recall credits memReused exactly ONCE (a reuse
//     EVENT, not a chunk tally) — matching the "reuse a memory" trophy copy.
const bigRecall = run([memUsed('m1'), memUsed('m2'), memUsed('m3'), memUsed('m4'), memUsed('m5'), memUsed('m6'), memUsed('m7'), done()]);
A.eq(bigRecall.stats.counters.memReused, 1, 'a completed run crediting memory reuse counts the EVENT once, never 7 chunks');
A.ok(bigRecall.awards[bigRecall.awards.length - 1].milestones.indexOf('pack_rat') !== -1, 'pack_rat awarded once for the completed recall run');
// (d) DEDUP holds across runs: a SECOND completed recall run does not re-award the (already-earned) trophy, and
//     memReused advances by one reuse-event per qualifying run (not per chunk).
const secondRecall = run([memUsed('m1'), memUsed('m2'), done()], bigRecall.stats);
A.eq(secondRecall.awards[secondRecall.awards.length - 1].milestones.indexOf('pack_rat'), -1, 'pack_rat does not re-fire on a later recall run');
A.eq(secondRecall.stats.counters.memReused, 2, 'memReused advances by one PER qualifying run (2 runs → 2), never per chunk');
// (e) partial work still counts: a run that hit its ceiling (max_iters) after recalling DID engage the model, so
//     its reuse credit is kept — withholding provably-real work would be its own dishonesty.
const cappedRecall = run([memUsed(), ended('max_iters')]);
A.eq(cappedRecall.stats.counters.memReused, 1, 'a max_iters run that recalled memory keeps its reuse credit (real work, just capped)');
// (f) buffer isolation across distinct runs: an errored recall run A, then a fresh COMPLETED recall run B, credits
//     exactly the one honest reuse — run A's discarded credit never leaks into run B, and B is not double-counted.
const isolate = run([memUsed('a1', 'runA'), errd('runA'), memUsed('b1', 'runB'), done(1, 'runB')]);
A.eq(isolate.stats.counters.memReused, 1, 'errored run A discarded + completed run B credited = exactly 1 reuse (no leak, no double-count)');

// ---- compute(): render-state for the gauges ----
const g = Xp.compute({ xp: 100, level: 2, lifetimeXp: 100, confidence: 70, samples: 5, counters: { positiveFeedback: 7, negativeFeedback: 2, tasksDone: 3 }, milestones: [] });
A.eq(g.level, 2, 'compute reads level');
A.eq(g.span, 100, 'L2->L3 span = 100');
A.eq(g.inLevel, 50, 'inLevel = 100 - 50');
A.eq(g.toNext, 50, 'toNext = 150 - 100');
A.eq(g.pct, 50, '50% through level 2');
A.eq(g.known, true, 'known with 5 samples');
A.eq(g.confLabel, '70%', 'confLabel renders the percent');
A.eq(g.band, 'reliable', '70% -> reliable band');
A.eq(g.bonus, 30, 'compute exposes the +30% feedback bonus');
A.eq(g.positiveFeedback, 7, 'compute surfaces positive feedback count');
A.eq(g.negativeFeedback, 2, 'compute surfaces negative feedback count');
A.eq(Xp.compute(Xp.fresh()).bonus, 0, 'no feedback bonus while calibrating');

// ---- confidence-scaled feedback XP: satisfied agents grow faster, never a penalty ----
const cal = { xp: 0, level: 1, lifetimeXp: 0, confidence: 90, samples: 5, counters: {}, milestones: [], run: { id: null, toolXp: 0 } };
A.eq(Xp.applyEvent(cal, edit()).awards.xp, 15, 'trusted (90%): feedback 10 base x1.5 = 15');
A.eq(Xp.applyEvent(cal, sized(4, 'work_great', 'large')).awards.xp, 50,
  'trusted feedback remains under the FINAL +50 per-verdict cap; size is irrelevant');
A.eq(Xp.applyEvent(Object.assign({}, cal, { confidence: 70 }), edit()).awards.xp, 13, 'reliable (70%): feedback 10 x1.3 = 13');
A.eq(Xp.applyEvent(Object.assign({}, cal, { confidence: 30 }), edit()).awards.xp, 10, 'low confidence: feedback earns base only, never a penalty');
A.eq(Xp.applyEvent(Object.assign({}, cal, { samples: 1 }), edit()).awards.xp, 10, 'uncalibrated: no bonus regardless of confidence');

// ---- high-frequency tool successes are counters only, not growth ----
let ts = Xp.fresh();
for (let i = 0; i < 15; i++) ts = Xp.applyEvent(ts, toolOk('r1')).stats;
A.eq(ts.xp, 0, '15 tool successes still award 0 xp');
A.eq(ts.samples, 0, 'tool results carry no satisfaction sample');
A.eq(ts.confidence, 50, 'tool results never move confidence');
A.eq(ts.counters.toolsOk, 15, 'tool successes still update operational counters (a real tool_result IS proof — committed immediately, never buffered)');

// ---- expanded milestone table ----
// memWrites / delivered stay IMMEDIATE (the write/delivery event is itself proof of the real action) — only
// memory-REUSE is buffered to run end, because recall happens speculatively at context-assembly (see pack_rat above).
let ms = Xp.fresh();
for (let i = 0; i < 10; i++) ms = Xp.applyEvent(ms, { name: 'memory.write', payload: { agentId: 'a', runId: 'r', id: 'm' + i, kind: 'fact' } }).stats;
A.eq(ms.xp, 0, 'memory writes do not mint xp');
A.ok(ms.milestones.indexOf('archivist') !== -1, 'archivist at 10 memory writes (a real write IS proof — committed immediately)');
const nightShift = Xp.applyEvent(Xp.fresh(), delivered());
A.eq(nightShift.stats.xp, 0, 'delivery milestone does not mint xp');
A.ok(nightShift.awards.milestones.indexOf('night_shift') !== -1, 'night_shift on first external delivery (a real delivery IS proof — immediate)');
const near = { xp: 2249, level: 9, lifetimeXp: 2249, confidence: 50, samples: 0, counters: {}, milestones: [], run: { id: null, toolXp: 0 } };
const vr = Xp.applyEvent(near, keep());
A.eq(vr.stats.level, 10, 'positive feedback crossing 2250 xp -> level 10');
A.ok(vr.awards.milestones.indexOf('veteran') !== -1, 'veteran milestone at level 10');

// ---- defensive: a corrupted / hand-edited save must never poison the meters with NaN/Infinity ----
const bad = { xp: Infinity, level: Infinity, lifetimeXp: NaN, confidence: Infinity, samples: NaN, counters: {}, milestones: [], run: {} };
const cb = Xp.compute(bad);
A.ok(Number.isFinite(cb.level) && Number.isFinite(cb.pct) && Number.isFinite(cb.toNext), 'compute() never emits NaN/Infinity from a corrupted save');
A.eq(cb.confidence, null, 'corrupted confidence -> calibrating null, never NaN');
const rb = Xp.applyEvent(bad, keep());
A.ok(Number.isFinite(rb.stats.xp) && Number.isFinite(rb.stats.confidence) && Number.isFinite(rb.stats.level), 'applyEvent sanitizes non-finite stats');
A.eq(Xp.levelForXp(Infinity), 1, 'levelForXp(Infinity) -> 1, never Infinity');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(Infinity, 'bad')).awards.xp, 0, 'non-finite feedback delta -> 0 xp');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(1000, 'kept')).awards.xp, 50, 'huge finite kept-feedback delta remains capped at +50 xp');

/* ---- S4: THE MID-GAME RUNGS. The catalogue used to fire four badges in session one and then light nothing
        until 25 tasks / Lv 10. These five sit in that gap, and each one must be earned by a counter the
        HARNESS wrote — never by a user tap, and never before the evidence exists. ---- */
// (a) the shipped-task ladder now has a rung at 5 — and it is the SAME rung credential() publishes as a tier,
//     so the trophy and the agent's dispatch briefing gaining a line are one event.
const four = run([done(0, 'r1'), done(0, 'r2'), done(0, 'r3'), done(0, 'r4')]);
A.eq(four.stats.milestones.indexOf('still_here'), -1, 'STILL HERE stays locked at 4 shipped tasks');
A.eq(Xp.credential(four.stats).tier, null, '…and the credential publishes no tier yet either');
const five = run([done(0, 'r5')], four.stats);
A.ok(five.awards[0].milestones.indexOf('still_here') !== -1, 'STILL HERE lights on the 5th shipped task');
A.eq(Xp.credential(five.stats).tier, 5, 'the badge and the credential tier cross on the SAME task — one ladder, not two');
A.eq(five.stats.xp, 0, 'the mid-game rungs mint no XP (they are recognition, never a currency)');

// (b) HANDS ON — the first badge in the catalogue to read toolsOk. Real successful tool calls only.
let hands = Xp.fresh();
for (let i = 0; i < 24; i++) hands = Xp.applyEvent(hands, toolOk('r')).stats;
A.eq(hands.counters.toolsOk, 24, '24 successful tool calls counted');
A.eq(hands.milestones.indexOf('hands_on'), -1, 'HANDS ON stays locked at 24 tool calls');
const hands25 = Xp.applyEvent(hands, toolOk('r'));
A.ok(hands25.awards.milestones.indexOf('hands_on') !== -1, 'HANDS ON lights on the 25th successful tool call');
// a FAILED tool call is not a tool call: toolsOk only counts ok && !isError, so it cannot buy the badge.
let failing = Xp.fresh();
for (let i = 0; i < 30; i++) failing = Xp.applyEvent(failing, { name: 'agent.tool_result', payload: { agentId: 'a', runId: 'r', callId: 'c', ok: false, isError: true } }).stats;
A.eq(failing.milestones.indexOf('hands_on'), -1, '30 FAILED tool calls earn nothing — the badge reads successes only');

// (c) LONG MEMORY — 10 reuse EVENTS, and reuse is credited once per completed run (never once per recalled
//     chunk), so a single 10-chunk recall must not buy it.
const bigOne = run([memUsed('m1'), memUsed('m2'), memUsed('m3'), memUsed('m4'), memUsed('m5'), memUsed('m6'), memUsed('m7'), memUsed('m8'), memUsed('m9'), memUsed('m10'), done()]);
A.eq(bigOne.stats.counters.memReused, 1, 'one run recalling 10 chunks is ONE reuse event');
A.eq(bigOne.stats.milestones.indexOf('long_memory'), -1, 'LONG MEMORY is not bought by a single fat recall');
let habit = Xp.fresh();
for (let i = 1; i <= 10; i++) habit = run([memUsed('m' + i, 'run' + i), done(0, 'run' + i)], habit).stats;
A.eq(habit.counters.memReused, 10, '10 separate recalling runs = 10 reuse events');
A.ok(habit.milestones.indexOf('long_memory') !== -1, 'LONG MEMORY lights after 10 real reuses');

// (d) DEPENDABLE — the harness-observed twin of TRUSTED. It defers to reliability() for the 85% threshold so it
//     can never disagree with the dossier's B2 gauge, and adds a VOLUME floor so it is a mid-game badge and not
//     a sixth session-one one (the band alone reaches 'dependable' at MIN_RUNS = 3).
const threeClean = run([done(0, 'a1'), done(0, 'a2'), done(0, 'a3')]);
A.eq(Xp.reliability(threeClean.stats).band, 'dependable', 'the B2 gauge reads DEPENDABLE after 3 clean runs…');
A.eq(threeClean.stats.milestones.indexOf('dependable'), -1, '…but the BADGE waits for a real body of work');
let sustained = Xp.fresh();
for (let i = 1; i <= 10; i++) sustained = Xp.applyEvent(sustained, done(0, 'd' + i)).stats;
A.ok(sustained.milestones.indexOf('dependable') !== -1, 'DEPENDABLE lights at 10 owned runs held above 85%');
// a shaky agent with the volume but not the finish rate earns nothing…
let shaky = Xp.fresh();
for (let i = 1; i <= 6; i++) shaky = Xp.applyEvent(shaky, done(0, 's' + i)).stats;
for (let i = 1; i <= 6; i++) shaky = Xp.applyEvent(shaky, ended('max_iters', 'x' + i)).stats;
A.eq(Xp.reliability(shaky).pct, 50, 'a 6-of-12 agent reads 50%');
A.eq(shaky.milestones.indexOf('dependable'), -1, 'DEPENDABLE stays locked for a 50% finish rate at 12 runs');
// …and PROVIDER faults never count against it: excluded runs move neither the ratio nor the volume floor.
let faulted = Xp.fresh();
for (let i = 1; i <= 10; i++) faulted = Xp.applyEvent(faulted, done(0, 'f' + i)).stats;
for (let i = 1; i <= 20; i++) faulted = Xp.applyEvent(faulted, errd('e' + i)).stats;
A.ok(faulted.milestones.indexOf('dependable') !== -1, '20 provider failures never revoke or block DEPENDABLE — they were never this agent’s fault');

// (e) SEASONED — the one rung on an otherwise empty Lv1 -> Lv10 ladder. XP-gated, so still user-approval-only.
const nearFive = { xp: 499, level: 4, lifetimeXp: 499, confidence: 50, samples: 0, counters: {}, milestones: [] };
A.eq(Xp.applyEvent(nearFive, done()).stats.milestones.indexOf('seasoned'), -1, 'a run completion cannot buy SEASONED at 499 xp');
const sz = Xp.applyEvent(nearFive, keep());
A.eq(sz.stats.level, 5, 'positive feedback crossing 500 xp -> level 5');
A.ok(sz.awards.milestones.indexOf('seasoned') !== -1, 'SEASONED lights at level 5');

// (f) the catalogue is still internally consistent: unique ids, and every badge carries label + hint + predicate.
const ids = Xp.MILESTONES.map(m => m.id);
A.eq(new Set(ids).size, ids.length, 'every milestone id is unique');
A.ok(Xp.MILESTONES.every(m => m.label && m.hint && typeof m.when === 'function'), 'every milestone has a label, an unlock hint, and a predicate');

/* ---- S4: RECONCILE — light what a save has ALREADY earned, with no event.
        Milestones only ever fired inside applyEvent, so a save written before a badge existed carries the
        record that earns it and none of the credit: the trophy case would show a LOCKED badge whose hint the
        dossier above it has visibly already met. ---- */
const preS4 = { xp: 0, level: 1, lifetimeXp: 0, confidence: 50, samples: 0, counters: { tasksDone: 8, runs: 9, toolsOk: 30 }, milestones: [] };
A.eq(Xp.milestones(preS4).filter(m => m.earned).length, 0, 'the pre-S4 save reads as having earned nothing');
const rec = Xp.reconcile(preS4);
A.eq(rec.earned, ['first_light', 'still_here', 'hands_on'], 'reconcile lights exactly the badges the record already earned');
A.eq(preS4.milestones, [], 'reconcile is PURE — the caller’s save object is not mutated');
A.eq(Xp.reconcile(rec.stats).earned, [], 'reconcile is idempotent — a second boot earns nothing');
A.eq(rec.stats.counters.tasksDone, 8, 'reconcile carries the counters through untouched');
A.eq(rec.stats.xp, 0, 'reconcile mints no XP');
// it can only ADD: a trophy records that you REACHED a bar, so a since-fallen band never revokes one.
const fell = Xp.reconcile({ xp: 0, level: 1, lifetimeXp: 0, confidence: 20, samples: 9, counters: {}, milestones: ['trusted'] });
A.ok(fell.stats.milestones.indexOf('trusted') !== -1, 'a badge already earned survives a reconcile after the meter fell');
A.eq(Xp.reconcile(null).earned, [], 'reconcile(null) is safe and earns nothing');
const corrupt = Xp.reconcile({ xp: Infinity, level: NaN, lifetimeXp: NaN, confidence: Infinity, samples: NaN, counters: { tasksDone: 5 }, milestones: [] });
A.ok(Number.isFinite(corrupt.stats.level) && Number.isFinite(corrupt.stats.xp), 'reconcile sanitizes a corrupted save like applyEvent does');
A.ok(corrupt.stats.milestones.indexOf('still_here') !== -1, '…and still awards what the intact counters prove');

/* ---- S5: PRACTICE — what the agent has actually LEARNED, as opposed to what it has been paid in.
        A FOURTH separately-labelled meter, deliberately NOT a redefinition of level: level is a monotonic,
        user-approval-only ladder every existing save already climbed under that rule. ---- */
const sk = (o) => Object.assign({ state: 'active', createdBy: 'agent', useCount: 0, withheld: false }, o);

// the honesty split that a plain [] cannot express: an unread skillbase is not an empty one.
A.eq(Xp.practice(null).known, false, 'an unread skillbase reports known:false…');
A.eq(Xp.practice(null).label, '—', '…and renders a dash, never a confident 0');
A.eq(Xp.practice([]).known, true, 'a skillbase we DID read reports known — zero is a real answer');
A.eq(Xp.practice([]).count, 0, '…and that answer is 0');
A.eq(Xp.practice([]).band, 'none', 'no procedures -> band none');

// THE ANTI-FARM LINE: authoring a procedure counts for nothing. Only one that was really USED counts.
A.eq(Xp.practice([sk({ useCount: 0 }), sk({ useCount: 0 }), sk({ useCount: 0 })]).count, 0, 'three self-written, never-used skills earn a count of ZERO — writing is not learning');
A.eq(Xp.practice([sk({ useCount: 0 }), sk({ useCount: 0 })]).idle, 2, '…and the unused ones are counted and nameable, not silently dropped');
A.eq(Xp.practice([sk({ useCount: 1 })]).count, 1, 'a procedure the model actually loaded into real work counts');

// each exclusion is a claim we refuse to make.
A.eq(Xp.practice([sk({ useCount: 9, withheld: true })]).count, 0, 'a WITHHELD skill was never handed to the model — it cannot be known');
A.eq(Xp.practice([sk({ useCount: 9, withheld: true })]).withheld, 1, '…and the withheld one is surfaced so the Commander can act on it');
A.eq(Xp.practice([sk({ useCount: 9, createdBy: 'user' })]).count, 0, 'a skill the COMMANDER wrote is given, not learned');
A.eq(Xp.practice([sk({ useCount: 9, createdBy: 'user' })]).given, 1, '…counted separately, never folded in');
A.eq(Xp.practice([sk({ useCount: 9, state: 'archived' })]).count, 0, 'a retired procedure is not carried knowledge');
A.eq(Xp.practice([sk({ useCount: 9, state: 'stale' })]).count, 1, 'a STALE skill is still in force (only archived is retired)');
// every flavour of agent authorship counts; the background passes are the agent distilling too.
for (const by of ['agent', 'reflection', 'background-review', 'agent-created', 'curator']) {
  A.eq(Xp.practice([sk({ useCount: 1, createdBy: by })]).count, 1, 'createdBy ' + by + ' is the agent distilling its own procedure');
}
const practiceMix = Xp.practice([
  sk({ useCount: 3 }), sk({ useCount: 1, createdBy: 'reflection' }), sk({ useCount: 5 }),
  sk({ useCount: 0 }), sk({ useCount: 9, withheld: true }), sk({ useCount: 9, createdBy: 'user' }), sk({ useCount: 9, state: 'archived' })
]);
A.eq(practiceMix.count, 3, 'a practiceMix skillbase counts only the three that were distilled, held, allowed and used');
A.eq(practiceMix.authored, 5, 'authored = everything the agent distilled and still holds (used + idle + withheld)');
A.eq([practiceMix.idle, practiceMix.withheld, practiceMix.given, practiceMix.retired], [1, 1, 1, 1], 'every excluded skill is accounted for by name');
A.eq(practiceMix.band, 'practised', '3 learned -> practised');
A.eq(Xp.practice([sk({ useCount: 1 })]).band, 'forming', '1 learned -> forming');
A.eq(Xp.practice(Array.from({ length: 7 }, () => sk({ useCount: 1 }))).band, 'fluent', '7 learned -> fluent');
// defensive: junk rows and junk counters must never poison the number.
A.eq(Xp.practice([null, undefined, 'nope', 42, sk({ useCount: 1 })]).count, 1, 'junk rows are skipped, not counted');
A.eq(Xp.practice([sk({ useCount: NaN }), sk({ useCount: Infinity }), sk({ useCount: -5 })]).count, 0, 'a non-finite or negative useCount never proves a use');
// PRACTICE is descriptive: it touches neither the ladder nor the other meters.
A.eq(typeof Xp.practice([]).pct, 'undefined', 'practice publishes no percentage — it is a count, not a ratio');
const untouched = run([done(), keep()]).stats;
A.eq(Xp.compute(untouched).level, Xp.compute(Xp.applyEvent(untouched, done()).stats).level, 'nothing about practice can move the level ladder');

// ---- milestone CATALOGUE (render-state for the trophy case): every badge, with earned flags + unlock hints ----
const catFresh = Xp.milestones(Xp.fresh());
A.eq(catFresh.length, Xp.MILESTONES.length, 'catalogue lists every milestone');
A.eq(catFresh.filter(m => m.earned).length, 0, 'a fresh agent has earned none');
A.ok(catFresh.every(m => m.label && m.hint), 'every badge carries a label + unlock hint');
const fl = catFresh.find(m => m.id === 'first_light');
A.eq(fl.label, 'FIRST LIGHT', 'first_light label surfaced for the UI');
A.eq(fl.hint, 'ship 1 task', 'locked first_light shows its unlock hint');
const catEarned = Xp.milestones(run([memUsed(), done(), keep()]).stats);
A.eq(catEarned.find(m => m.id === 'first_light').earned, true, 'first_light reads earned once a task ships');
A.eq(catEarned.find(m => m.id === 'pack_rat').earned, true, 'pack_rat reads earned after a reuse');
A.eq(catEarned.find(m => m.id === 'approved').earned, true, 'approved reads earned after positive feedback');
A.eq(catEarned.find(m => m.id === 'veteran').earned, false, 'unmet milestones stay locked');
A.eq(Xp.milestones(null).filter(m => m.earned).length, 0, 'milestones(null) is safe and all-locked');

// ---- compute() exposes tasksDone + samples + feedback receipts for the dossier ----
const cg = Xp.compute(run([done(), done(), done(), keep(), discard()]).stats);
A.eq(cg.tasksDone, 3, 'compute surfaces shipped-task count');
A.eq(cg.samples, 2, 'compute surfaces the feedback sample count');
A.eq(cg.positiveFeedback, 1, 'compute surfaces positive feedback count');
A.eq(cg.negativeFeedback, 1, 'compute surfaces negative feedback count');
A.eq(Xp.compute(Xp.fresh()).tasksDone, 0, 'fresh agent has 0 tasks done');

/* ---- S2 RELIABILITY: the SECOND axis — what the HARNESS observed, not what the Commander said ----
   The whole point is that it is provable without a single user tap, AND that it never becomes a second XP
   faucet. Every assertion below pairs "the meter moved" with "the ladder did not". */

// calibration honesty, exactly like confidence: no number before there is evidence for one
const rFresh = Xp.reliability(Xp.fresh());
A.eq(rFresh.known, false, 'a fresh agent reports reliability known:false (never a made-up %)');
A.eq(rFresh.pct, null, 'an uncalibrated reliability has NO percentage');
A.eq(rFresh.label, '—', 'an uncalibrated reliability renders as a dash');
A.eq(rFresh.band, 'calibrating', 'an uncalibrated reliability bands as calibrating');
A.eq(rFresh.toKnown, Xp.MIN_RUNS, 'a fresh agent needs MIN_RUNS attributable runs before a % is honest');
A.eq(Xp.reliability(null).known, false, 'reliability(null) is safe and uncalibrated');

// a clean track record
const rAll = Xp.reliability(run([done(), done(), done()]).stats);
A.eq(rAll.known, true, 'MIN_RUNS attributable runs calibrate the meter');
A.eq(rAll.completed, 3, 'completed counts the done runs');
A.eq(rAll.attempted, 3, 'attempted counts the runs the agent owned');
A.eq(rAll.pct, 100, 'three clean runs read 100%');
A.eq(rAll.band, 'dependable', '100% bands as dependable');

// engaged-but-fell-short IS the agent's own outcome and DOES count against it
const rShort = Xp.reliability(run([done(), done(), ended('max_iters')]).stats);
A.eq(rShort.attempted, 3, 'a max_iters run is attributable (the agent engaged and fell short)');
A.eq(rShort.completed, 2, 'a max_iters run is not a completion');
A.eq(rShort.pct, 67, 'two of three reads 67%');
A.eq(rShort.band, 'consistent', '67% bands as consistent');
A.eq(Xp.reliability(run([done(), done(), ended('budget')]).stats).attempted, 3, 'a budget stop is attributable');
A.eq(Xp.reliability(run([done(), done(), ended('refusal')]).stats).attempted, 3, 'a refusal is attributable');

/* THE HONESTY LINE — a provider fault is NOT the agent's failure. This is the case that actually happens: a
   dead model id, a 404, an out-of-credit key. Charging it to the agent would understate every agent on a
   misconfigured station. Excluded runs are still COUNTED so the dossier can name them. */
const rFault = Xp.reliability(run([done(), done(), done(), errd(), errd(), ended('empty')]).stats);
A.eq(rFault.attempted, 3, 'provider faults (error/empty) are EXCLUDED from the denominator');
A.eq(rFault.pct, 100, 'a provider outage cannot drag an agent\'s reliability down');
A.eq(rFault.faulted, 3, 'faulted runs are still counted, so the dossier can name them');
A.eq(rFault.excluded, 3, 'excluded = faulted + neutral');

// a Commander cancel, and a neutral Task Brief question, are likewise not the agent's outcome
const rNeutral = Xp.reliability(run([done(), done(), done(), ended('cancelled'), ended('clarifying')]).stats);
A.eq(rNeutral.attempted, 3, 'cancelled + clarifying are EXCLUDED from the denominator');
A.eq(rNeutral.neutral, 2, 'neutral runs are counted separately from provider faults');
A.eq(rNeutral.pct, 100, 'stopping a run yourself never marks the agent down');

// an unknown FUTURE terminal value falls through to neither bucket — the safe, non-lying default
const rUnknown = run([done(), done(), done(), ended('some_future_reason')]).stats;
A.eq(Xp.reliability(rUnknown).attempted, 3, 'an unrecognised terminal reason is never guessed into a bucket');
A.eq(Xp.reliability(rUnknown).excluded, 0, 'an unrecognised terminal reason is not counted as excluded either');
A.eq(rUnknown.counters.runs, 4, 'but every attempt still increments the raw run count (unchanged meaning)');

/* THE XP LAW HOLDS: reliability reads real outcomes, and NONE of them mint XP, move the level, or touch the
   satisfaction meter. If this ever goes red, the two axes have been blurred back into one. */
const mixed = run([done(), done(), done(), ended('max_iters'), errd(), ended('cancelled')]).stats;
A.eq(mixed.xp, 0, 'S2 outcomes mint NO XP — XP stays explicit-user-approval-only');
A.eq(mixed.level, 1, 'S2 outcomes never move the level ladder');
A.eq(mixed.samples, 0, 'S2 outcomes are not satisfaction samples');
A.eq(Xp.compute(mixed).known, false, 'S2 outcomes never calibrate the CONFIDENCE meter');
A.eq(Xp.reliability(mixed).known, true, '…while the reliability meter IS calibrated by those same runs');

/* LEGACY SAVES: a save written before S2 has no buckets. We report calibrating rather than back-filling from
   runs/tasksDone — `runs` counts provider errors and cancellations too, so a derived number would understate
   every existing agent. Never ship a number you cannot stand behind. */
const legacy = Xp.fresh(); legacy.counters = { runs: 40, tasksDone: 31, toolsOk: 90 };
const rLegacy = Xp.reliability(legacy);
A.eq(rLegacy.known, false, 'a pre-S2 save reads calibrating, not a number derived from the raw run count');
A.eq(rLegacy.pct, null, 'a pre-S2 save shows no fabricated percentage');
A.eq(rLegacy.attempted, 0, 'a pre-S2 save proves NOTHING about reliability — the S2 counters are the only source');
A.eq(Xp.compute(legacy).tasksDone, 31, 'its older, differently-scoped counters are untouched and still surface elsewhere');
// and it recalibrates from real evidence once it runs again, without inheriting the legacy history
const rLegacyRan = Xp.reliability(run([done(), done(), done()], legacy).stats);
A.eq(rLegacyRan.attempted, 3, 'a pre-S2 agent calibrates from its NEW runs only');
A.eq(rLegacyRan.known, true, 'and becomes known after MIN_RUNS real, attributable runs');

/* ---- S3 CREDENTIAL: the coarse, earned-only track record that makes the meters load-bearing ----
   Two properties carry the whole slice: it must say NOTHING about an unproven agent (silence, never a rank),
   and its `key` must be STABLE across ordinary work (or the roster republishes on every event). */

// nothing earned => nothing said. A new specialist must not be described as unproven — that reads as a ranking.
const cFresh = Xp.credential(Xp.fresh());
A.eq(cFresh.text, '', 'a brand-new agent publishes NO track record (silence, never "Lv 1 · unproven")');
A.eq(cFresh.key, '', 'an unearned credential has an empty key, so "has one at all" is a truthiness check');
A.eq(cFresh.tier, null, 'no experience tier before any tasks ship');
A.eq(Xp.credential(null).text, '', 'credential(null) is safe and says nothing');

// each part appears ONLY once its own evidence bar is cleared
const fiveDone = reasons => run(reasons.map((r, i) => ended(r, 'r' + i))).stats;
A.eq(Xp.credential(fiveDone(['done', 'done', 'done', 'done'])).tier, null, 'four shipped tasks is below the first tier — still nothing claimed');
const c5 = Xp.credential(fiveDone(['done', 'done', 'done', 'done', 'done']));
A.eq(c5.tier, 5, 'the first experience tier lands at 5 shipped tasks');
A.ok(/5\+ tasks shipped/.test(c5.text), 'the tier is published as a THRESHOLD, never a live count');
A.eq(c5.confBand, null, 'an unrated agent claims no Commander rating');
A.ok(!/Commander rating/.test(c5.text), '…and the phrase is absent entirely, not empty');
A.eq(c5.relBand, 'dependable', 'five clean runs DO calibrate the harness-observed finish rate');
A.ok(/finish rate: DEPENDABLE/.test(c5.text), 'the finish rate is published once MIN_RUNS attributable runs exist');

// a rated agent adds the Commander's own verdict, and the two stay distinguishable in the text
let rated = fiveDone(['done', 'done', 'done', 'done', 'done']);
for (let i = 0; i < 3; i++) rated = Xp.applyEvent(rated, { name: 'memory.feedback', payload: { agentId: 'a', id: 'm' + i, delta: 2, reason: 'work_great' } }).stats;
const cRated = Xp.credential(rated);
A.ok(/Commander rating: /.test(cRated.text), 'a rated agent publishes the Commander rating');
A.ok(/finish rate: /.test(cRated.text), '…alongside the separately-sourced finish rate');
A.ok(cRated.text.indexOf('Commander rating') < cRated.text.indexOf('finish rate'), 'what you said is listed before what the station saw');

/* THE CHURN GUARD — this is what makes the credential safe to publish into a briefing. Ordinary work must not
   move the key; only a tier crossing or a band flip may. If this goes red, S3 re-POSTs the whole roster
   (every agent's composed system prompt) on essentially every event. */
const base = fiveDone(['done', 'done', 'done', 'done', 'done']);
const keyBefore = Xp.credential(base).key;
let churned = Xp.clone(base);
for (const ev of [ended('done', 'x1'), ended('done', 'x2'), toolOk('x1'), delivered(), memUsed('m', 'x3'), ended('done', 'x3')]) churned = Xp.applyEvent(churned, ev).stats;
A.eq(Xp.credential(churned).key, keyBefore, 'ordinary work does NOT move the credential key (no roster churn)');
A.ok(churned.counters.tasksDone > base.counters.tasksDone, '…even though the underlying task count really did grow');
// …and a genuine crossing DOES move it
let crossed = Xp.clone(base);
for (let i = 0; i < 20; i++) crossed = Xp.applyEvent(crossed, ended('done', 'c' + i)).stats;
A.eq(Xp.credential(crossed).tier, 25, 'crossing into the next tier moves the tier');
A.ok(Xp.credential(crossed).key !== keyBefore, '…and therefore moves the key, so the roster republishes exactly then');
// a band flip alone is also a real change
let flipped = Xp.clone(base);
for (let i = 0; i < 6; i++) flipped = Xp.applyEvent(flipped, ended('max_iters', 'f' + i)).stats;
A.eq(Xp.credential(flipped).relBand, 'uneven', 'a run of shortfalls flips the finish-rate band');
A.ok(Xp.credential(flipped).key !== keyBefore, 'a band flip moves the key even with no tier change');

// the credential is a READOUT — it never mints anything
A.eq(Xp.credential(crossed).text === '' ? 0 : crossed.xp, crossed.xp, 'credential() is pure readout — it mints no XP');

/* ---- LONGEVITY: an earned level is a floor, and replayed facts are idempotent ---- */
const splitBrain = { xp: 10, level: 5, lifetimeXp: 10, confidence: 50, samples: 0, counters: {}, milestones: [] };
const repaired = Xp.reconcile(splitBrain).stats;
A.eq(repaired.level, 5, 'reconcile never demotes an already-earned level');
A.eq(repaired.xp, Xp.xpForLevel(5), 'reconcile restores the minimum XP implied by the saved level');
A.ok(repaired.lifetimeXp >= repaired.xp, 'lifetime XP is repaired to at least the spendable XP total');
const afterRepairRating = Xp.applyEvent(repaired, { name: 'memory.feedback', payload: { agentId: 'a', id: 'work:repair-run', runId: 'repair-run', delta: 2, reason: 'work_great' } }).stats;
A.ok(afterRepairRating.level >= 5, 'the next positive rating cannot demote a repaired veteran');

const onceRun = Xp.applyEvent(Xp.fresh(), done(0, 'receipt-run'));
const twiceRun = Xp.applyEvent(onceRun.stats, done(0, 'receipt-run'));
A.eq(twiceRun.stats.counters.tasksDone, 1, 'a replayed run.end receipt cannot count the same shipped task twice');
A.eq(twiceRun.awards.duplicate, true, 'the duplicate run receipt is explicit to callers');
let partialCrash = Xp.applyEvent(Xp.fresh(), { name: 'agent.tool_result', payload: { agentId: 'a', runId: 'partial-run', callId: 'c1', ok: true, isError: false } }).stats;
partialCrash = Xp.applyEvent(partialCrash, { name: 'agent.run.end', payload: { agentId: 'a', runId: 'partial-run', reason: 'done', _historyToolsOk: 3 } }).stats;
A.eq(partialCrash.counters.toolsOk, 3, 'history catch-up adds only tool successes not already persisted before a mid-run crash');
const ratingEvent = { name: 'memory.feedback', payload: { agentId: 'a', id: 'work:receipt-run', runId: 'receipt-run', delta: 5, reason: 'work_great', size: 'large' } };
const onceRating = Xp.applyEvent(twiceRun.stats, ratingEvent);
const twiceRating = Xp.applyEvent(onceRating.stats, ratingEvent);
A.eq(twiceRating.stats.xp, onceRating.stats.xp, 'a replayed work rating cannot mint XP twice');
A.eq(twiceRating.stats.samples, onceRating.stats.samples, 'a replayed work rating cannot skew confidence twice');
A.eq(twiceRating.awards.duplicate, true, 'the duplicate rating receipt is explicit to callers');

A.report('xp.test');
