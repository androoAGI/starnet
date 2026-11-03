/* node test/loopjob.test.js — the PURE LOOP core (standing objectives, S1).

   Proves the two halves of the determinism split hold their invariants under an injected clock:
     loopjob.js       — the GATE (decide), the convergence reader, the ledger digest
     loopjob-store.js — the record lifecycle (iterations, verdicts, streaks, budget, envelope)

   The four invariants that actually matter for a loop that spends real money 24/7:
     1. THE VERDICT ADVANCES IT — a full review queue parks the loop; a verdict frees it. No clock involved.
     2. THE STACKING LAW — rejecting #n cascades 'discarded' to every un-approved candidate above it.
     3. CONVERGENCE IS REAL — N honest NOTHING-TO-DO passes park the loop DORMANT instead of burning forever.
     4. NOTHING GOES QUIET UNNAMED — decide() always names a binding when it refuses to fire.

   Everything is driven from a fixed epoch; no wall-clock read anywhere (same discipline as cron.test.js). */
'use strict';
const A = require('./_assert.js');
const LJ = require('../sidecar/loopjob.js');
const S = require('../sidecar/loopjob-store.js');

// A fixed ms epoch, deliberately aligned to UTC MIDNIGHT (2023-11-15T00:00:00Z). The budget bucket rolls on
// the UTC day boundary, so an unaligned epoch makes "T0 + 2 hours" silently cross into tomorrow and hand a
// test a fresh daily allowance. Keep this aligned or the budget assertions below stop meaning what they say.
const T0 = 1700006400000;
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

const mk = (spec, at) => S.createLoop([], Object.assign({ id: 'l1', name: 'sweep', objective: 'find bugs' }, spec), { now: at == null ? T0 : at });
const one = (loops) => S.getLoop(loops, 'l1');

// a full iteration cycle: claim -> start -> settle. `res` shapes the outcome.
function cycle(loops, res, at) {
  loops = S.claimFire(loops, 'l1', { now: at });
  loops = S.startIteration(loops, 'l1', { runId: res.runId, now: at });
  return S.settleIteration(loops, 'l1', res, { now: at + MIN });
}

// ---- 1. makeLoop: safe defaults (a beginners product must not default to "spend freely") ----
{
  const l = one(mk());
  A.eq(l.gate, 'review', 'default gate is REVIEW — nothing is applied without a click');
  A.eq(l.state, 'idle', 'a new loop is idle and armed (no arm-it-later ceremony)');
  A.eq(l.enabled, true, 'a new loop is enabled — no gating law');
  A.eq(l.queueCap, LJ.QUEUE_CAP_DEFAULT, 'queueCap defaults to the shipped cap');
  A.eq(l.iterationCount, 0, 'no iterations yet');
  A.eq(l.iterations, [], 'ledger starts empty');
  A.eq(l.budget.spentTodayUsd, 0, 'daily spend starts at zero');
  A.eq(one(mk({ gate: 'auto' })).gate, 'auto', 'gate:auto is honored when explicitly asked for');
  A.eq(one(mk({ gate: 'nonsense' })).gate, 'review', 'an unknown gate value falls back to REVIEW, never auto');
  A.throws(() => S.createLoop([], { id: '../escape', objective: 'x' }, { now: T0 }), 'a path-escaping id is refused');
}

// ---- 2. decide: every refusal is NAMED (invariant 4) ----
{
  const live = mk();
  A.eq(LJ.decide(one(live), {}, { now: T0 }).fire, true, 'a fresh enabled loop fires');
  A.eq(LJ.decide(one(live), {}, { now: T0 }).binding, null, 'a firing loop has no binding');

  A.eq(LJ.decide(one(live), { halted: true }, { now: T0 }).binding, 'halted', 'E-STOP binds first');
  A.eq(LJ.decide(one(live), { agentBusy: true }, { now: T0 }).binding, 'concurrency', 'a busy agent binds');
  A.eq(LJ.decide(one(live), { inFlight: true }, { now: T0 }).binding, 'in-flight', 'an in-flight iteration binds');
  A.eq(LJ.decide(one(live), { precheck: { ok: false, reason: 'no key' } }, { now: T0 }).binding, 'precheck',
    'a local precheck failure binds BEFORE any spend');
  A.eq(LJ.decide(one(live), { precheck: { ok: false, reason: 'no key' } }, { now: T0 }).detail, 'no key',
    'the precheck reason is carried through to the UI');

  A.eq(LJ.decide(one(S.pauseLoop(live, 'l1', 'by hand', { now: T0 })), {}, { now: T0 }).binding, 'paused', 'paused binds');
  A.eq(LJ.decide(one(S.stopLoop(live, 'l1', 'done', { now: T0 })), {}, { now: T0 }).binding, 'stopped', 'stopped binds');

  const capped = one(mk({ maxIterations: 2 }));
  A.eq(LJ.decide(Object.assign({}, capped, { iterationCount: 2 }), {}, { now: T0 }).binding, 'max-iterations',
    'the iteration ceiling binds');

  // every binding decide can produce is a declared gate name — no ad-hoc strings leaking to the UI
  for (const b of ['halted', 'disabled', 'stopped', 'dormant', 'paused', 'max-iterations', 'budget', 'in-flight', 'queue-full', 'concurrency', 'precheck']) {
    A.ok(LJ.GATES.indexOf(b) >= 0, 'binding "' + b + '" is a declared gate');
  }
}

// ---- 3. the durable fire-claim: crash-safe, but never a permanent wedge ----
{
  let loops = S.claimFire(mk(), 'l1', { now: T0 });
  A.eq(LJ.decide(one(loops), {}, { now: T0 + MIN, staleMs: 10 * MIN }).binding, 'in-flight',
    'a fresh claim suppresses re-fire across a restart (no double-spend)');
  A.eq(LJ.decide(one(loops), {}, { now: T0 + 30 * MIN, staleMs: 10 * MIN }).fire, true,
    'a ZOMBIE claim past staleMs is reclaimed — a dead holder never wedges the loop forever');

  const beat = S.renewHeartbeat(loops, 'l1', { now: T0 + 25 * MIN });
  A.eq(LJ.decide(one(beat), {}, { now: T0 + 30 * MIN, staleMs: 10 * MIN }).binding, 'in-flight',
    'a live heartbeat keeps a long-but-real iteration from being declared a zombie');
}

// ---- 4. INVARIANT 1: the queue parks the loop, the VERDICT frees it (not a clock) ----
{
  let loops = mk({ queueCap: 2 });
  loops = cycle(loops, { runId: 'r1', status: 'ok', text: 'fixed the null deref', title: 'fix null deref' }, T0);
  A.eq(one(loops).state, 'idle', '1 pending under a cap of 2 -> loop keeps working (stacking, not blocking)');
  A.eq(LJ.decide(one(loops), {}, { now: T0 + HOUR }).fire, true, 'and it may fire again immediately');

  loops = cycle(loops, { runId: 'r2', status: 'ok', text: 'fixed the off-by-one', title: 'fix off-by-one' }, T0 + HOUR);
  A.eq(one(loops).state, 'waiting', '2 pending at a cap of 2 -> the loop parks itself');
  A.eq(LJ.decide(one(loops), {}, { now: T0 + 2 * HOUR }).binding, 'queue-full', 'and names the queue as the reason');
  A.eq(one(loops).stopReason, '2 waiting on your review', 'the park reason is human-readable, not a spinner');

  loops = S.recordVerdict(loops, 'l1', 1, 'approved', { now: T0 + 3 * HOUR });
  A.eq(one(loops).state, 'idle', 'a VERDICT frees the queue — this is the loop trigger');
  A.eq(LJ.decide(one(loops), {}, { now: T0 + 3 * HOUR }).fire, true, 'the next iteration may start at once');
  A.eq(LJ.pendingReviews(one(loops)).length, 1, 'only the un-ruled candidate is still pending');
}

// ---- 5. queueCap 1 = strictly blocking (the conservative shape, still reachable) ----
{
  let loops = mk({ queueCap: 1 });
  loops = cycle(loops, { runId: 'r1', status: 'ok', text: 'did a thing', title: 'a thing' }, T0);
  A.eq(LJ.decide(one(loops), {}, { now: T0 + HOUR }).binding, 'queue-full',
    'queueCap 1 blocks after a single candidate — one un-reviewed thing at a time');
}

// ---- 6. INVARIANT 2: THE STACKING LAW — rejection cascades to everything built on top ----
{
  let loops = mk({ queueCap: 5 });
  for (let i = 1; i <= 4; i++) {
    loops = cycle(loops, { runId: 'r' + i, status: 'ok', text: 'work ' + i, title: 'work ' + i }, T0 + i * HOUR);
  }
  A.eq(LJ.pendingReviews(one(loops)).length, 4, '4 candidates stacked');
  A.eq(LJ.stackedAbove(one(loops), 2).map(it => it.n), [3, 4], 'stackedAbove(2) names exactly what a reject would cost');

  loops = S.recordVerdict(loops, 'l1', 2, 'rejected', { now: T0 + 9 * HOUR, note: 'do not touch the build config' });
  const its = one(loops).iterations;
  A.eq(its.find(it => it.n === 1).verdict, null, '#1 (below the rejection) is untouched — still awaiting review');
  A.eq(its.find(it => it.n === 2).verdict, 'rejected', '#2 is rejected');
  A.eq(its.find(it => it.n === 2).verdictNote, 'do not touch the build config', 'the reason is durable');
  A.eq(its.find(it => it.n === 3).verdict, 'discarded', '#3 was built on #2 -> discarded');
  A.eq(its.find(it => it.n === 4).verdict, 'discarded', '#4 too');
  A.eq(its.find(it => it.n === 4).verdictNote, 'discarded — built on top of rejected #2',
    'a discarded row says WHY it died, so the UI never shows unexplained vanished work');
  A.eq(LJ.pendingReviews(one(loops)).length, 1, 'only #1 remains reviewable');

  // approval must NEVER cascade — it is not a claim about work the Commander has not seen
  let ok2 = mk({ queueCap: 5 });
  for (let i = 1; i <= 3; i++) ok2 = cycle(ok2, { runId: 'q' + i, status: 'ok', text: 'w' + i, title: 'w' + i }, T0 + i * HOUR);
  ok2 = S.recordVerdict(ok2, 'l1', 1, 'approved', { now: T0 + 9 * HOUR });
  A.eq(LJ.pendingReviews(one(ok2)).map(it => it.n), [2, 3], 'approving #1 leaves #2 and #3 pending — no silent auto-approve');
}

// ---- 7. INVARIANT 3: convergence is real (and honest) ----
{
  A.eq(LJ.nextOutcomeFor('all clear, NOTHING-TO-DO here'), 'noop', 'the declared marker is read anywhere in the text');
  A.eq(LJ.nextOutcomeFor('nothing-to-do'), 'noop', 'and case-insensitively');
  A.eq(LJ.nextOutcomeFor('there was nothing much to do'), 'candidate',
    'ordinary prose about having little to do is NOT convergence — only the exact token counts');
  A.eq(LJ.nextOutcomeFor(''), 'candidate', 'an empty reply is not a convergence claim');

  let loops = mk({ dryStopAfter: 3, queueCap: 5 });
  loops = cycle(loops, { runId: 'd1', status: 'ok', text: 'NOTHING-TO-DO' }, T0);
  A.eq(one(loops).dryStreak, 1, 'a dry pass counts');
  A.eq(one(loops).state, 'idle', 'but one dry pass does not park the loop');
  loops = cycle(loops, { runId: 'd2', status: 'ok', text: 'NOTHING-TO-DO' }, T0 + HOUR);
  loops = cycle(loops, { runId: 'd3', status: 'ok', text: 'NOTHING-TO-DO' }, T0 + 2 * HOUR);
  A.eq(one(loops).state, 'dormant', '3 honest dry passes -> DORMANT, not an infinite burn');
  A.eq(one(loops).enabled, false, 'a dormant loop is disabled, so it cannot spend');
  A.eq(LJ.decide(one(loops), {}, { now: T0 + DAY }).binding, 'dormant', 'and stays bound a day later');
  A.ok(/nothing left to do/.test(one(loops).stopReason), 'the dormant reason states the truth plainly');

  // real work resets the streak — a loop that finds something is not converging
  let mixed = mk({ dryStopAfter: 2, queueCap: 5 });
  mixed = cycle(mixed, { runId: 'm1', status: 'ok', text: 'NOTHING-TO-DO' }, T0);
  mixed = cycle(mixed, { runId: 'm2', status: 'ok', text: 'found one', title: 'found one' }, T0 + HOUR);
  A.eq(one(mixed).dryStreak, 0, 'a real candidate resets the dry streak');
  A.eq(one(mixed).state, 'idle', 'and the loop stays live');

  // resuming a dormant loop clears the streak (the Commander looked and said keep going)
  const woke = one(S.resumeLoop(cycle(cycle(mk({ dryStopAfter: 2 }), { runId: 'z1', status: 'ok', text: 'NOTHING-TO-DO' }, T0),
    { runId: 'z2', status: 'ok', text: 'NOTHING-TO-DO' }, T0 + HOUR), 'l1', { now: T0 + DAY }));
  A.eq(woke.state, 'idle', 'resume lifts DORMANT');
  A.eq(woke.dryStreak, 0, 'and clears the streak so it does not instantly re-park');
  A.eq(woke.iterationCount, 2, 'but the loop KEEPS its memory across a resume');
}

// ---- 8. failure streak parks the loop instead of retrying forever ----
{
  let loops = mk();
  loops = cycle(loops, { runId: 'f1', status: 'error', error: 'provider 500' }, T0);
  A.eq(one(loops).failStreak, 1, 'a failure counts');
  A.eq(one(loops).state, 'idle', 'one failure is survivable');
  loops = cycle(loops, { runId: 'f2', status: 'error', error: 'provider 500' }, T0 + HOUR);
  loops = cycle(loops, { runId: 'f3', status: 'error', error: 'provider 500' }, T0 + 2 * HOUR);
  A.eq(one(loops).state, 'paused', '3 failures in a row park the loop');
  A.ok(/provider 500/.test(one(loops).stopReason), 'and the stop reason quotes the real error');

  // a success clears the streak
  let rec = mk();
  rec = cycle(rec, { runId: 'g1', status: 'error', error: 'blip' }, T0);
  rec = cycle(rec, { runId: 'g2', status: 'ok', text: 'fine', title: 'fine' }, T0 + HOUR);
  A.eq(one(rec).failStreak, 0, 'a success clears the failure streak');

  // review 8.1: a pass that did not FINISH (cut short, a limit) counts toward the same pause, in a row — a success between clears it, and a
  // failed and an unfinished pass do not clear each other; the reason says what the run held
  const U = (id) => ({ runId: id, status: 'error', unfinished: 'out_of_budget', error: 'budget limit reached' });
  const F = (id) => ({ runId: id, status: 'error', error: 'provider 500' });
  const C = (id) => ({ runId: id, status: 'ok', text: 'found one', title: 'found one' });
  const play = (steps) => steps.reduce((acc, step, i) => cycle(acc, step('p' + i), T0 + i * HOUR), mk({ queueCap: 9 }));
  const apart = one(play([U, C, U, C, U, C, U]));
  A.eq(apart.state, 'idle', 'unfinished passes a success sits between never park the loop');
  A.eq(apart.unfinishedStreak, 1, 'a success clears the unfinished streak');
  const after = one(play([U, U, C]));
  A.eq(after.unfinishedStreak, 0, 'a candidate after two unfinished passes clears the streak');
  const three = one(play([U, U, U]));
  A.eq(three.state, 'paused', '3 unfinished passes in a row park the loop');
  A.ok(/^3 passes in a row did not finish: budget limit reached$/.test(three.stopReason), 'said as passes that did not finish (got ' + three.stopReason + ')');
  const mixedRun = one(play([F, U, F]));
  A.eq(mixedRun.state, 'paused', 'a failed, an unfinished and a failed pass in a row park the loop, as three failed passes did before r8');
  A.ok(/^3 passes in a row did not succeed \(2 failed, 1 did not finish\)/.test(mixedRun.stopReason) && !/failed in a row/.test(mixedRun.stopReason),
    'and the reason says the mix, never "3 iterations failed in a row" (got ' + mixedRun.stopReason + ')');
  const brokenUp = one(play([F, U, C, F, U]));
  A.eq(brokenUp.state, 'idle', 'a success between resets both counts');
  A.eq(brokenUp.failStreak + brokenUp.unfinishedStreak, 2, 'so only the passes since the success count');
  const dry = one(play([U, U, (id) => ({ runId: id, status: 'ok', text: 'NOTHING-TO-DO' })]));
  A.eq(dry.unfinishedStreak, 0, 'a noop pass clears the unfinished streak too');
}

// ---- 9. budget: daily cap binds, rolls at the UTC day boundary ----
{
  let loops = mk({ perDayUsd: 1.0, queueCap: 9 });
  loops = cycle(loops, { runId: 'b1', status: 'ok', text: 'w', title: 'w', usd: 0.6 }, T0);
  A.eq(one(loops).budget.spentTodayUsd, 0.6, 'iteration cost accrues to the day bucket');
  A.eq(LJ.decide(one(loops), {}, { now: T0 + HOUR }).fire, true, '$0.60 of $1.00 still fires');
  loops = cycle(loops, { runId: 'b2', status: 'ok', text: 'w', title: 'w', usd: 0.5 }, T0 + HOUR);
  A.eq(LJ.decide(one(loops), {}, { now: T0 + 2 * HOUR }).binding, 'budget', 'over the daily cap the loop stops spending');
  A.ok(/daily cap/.test(LJ.decide(one(loops), {}, { now: T0 + 2 * HOUR }).detail), 'and says so in dollars');
  A.eq(LJ.decide(one(loops), {}, { now: T0 + DAY + HOUR }).fire, true, 'the bucket rolls at the next UTC day');
  A.eq(LJ.budgetLeft(one(mk({ perDayUsd: 0 })), { now: T0 }), null, 'perDayUsd 0 = UNGOVERNED (never "block everything")');
}

// ---- 10. gate:'auto' — applies its own work, never queues ----
{
  let loops = mk({ gate: 'auto', queueCap: 1 });
  loops = cycle(loops, { runId: 'a1', status: 'ok', text: 'merged it', title: 'merged it', commit: 'abc1234' }, T0);
  const it = one(loops).iterations[0];
  A.eq(it.verdict, 'approved', 'an auto loop stamps its own verdict at settle');
  A.ok(/full access to merge/.test(it.verdictNote), 'and the record says WHY it was approved — no fake review');
  A.eq(it.commit, 'abc1234', 'the commit it produced is recorded');
  A.eq(LJ.pendingReviews(one(loops)).length, 0, 'nothing queues');
  loops = cycle(loops, { runId: 'a2', status: 'ok', text: 'merged again', title: 'again' }, T0 + HOUR);
  A.eq(LJ.decide(one(loops), {}, { now: T0 + 2 * HOUR }).fire, true, 'an auto loop is never parked by a queue it cannot build');
}

// ---- 11. the digest: the loop's MEMORY (without this it re-finds bug #1 forever) ----
{
  let loops = mk({ queueCap: 5 });
  loops = cycle(loops, { runId: 'x1', status: 'ok', text: 'w', title: 'fixed the login redirect' }, T0);
  loops = cycle(loops, { runId: 'x2', status: 'ok', text: 'w', title: 'rewrote the build config' }, T0 + HOUR);
  loops = cycle(loops, { runId: 'x3', status: 'ok', text: 'NOTHING-TO-DO' }, T0 + 2 * HOUR);
  // rule oldest-first, which is the only order the FIFO queue offers: approving #1 leaves #2 reviewable,
  // and rejecting #2 then has nothing above it to cascade onto.
  loops = S.recordVerdict(loops, 'l1', 1, 'approved', { now: T0 + 3 * HOUR });
  loops = S.recordVerdict(loops, 'l1', 2, 'rejected', { now: T0 + 4 * HOUR, note: 'never touch the build config' });

  const d = LJ.digest(one(loops), {});
  A.ok(/never touch the build config/.test(d), 'the REJECTION REASON is in the digest — the highest-value signal');
  A.ok(d.indexOf('REJECTED') < d.indexOf('ALREADY DONE'), 'rejections lead — a boundary must not be buried under history');
  A.ok(/fixed the login redirect/.test(d), 'approved work is listed as already done');
  A.ok(/NOTHING-TO-DO/.test(d), 'the convergence escape hatch is offered every iteration');
  A.ok(/Do NOT invent busywork/.test(d), 'and inventing work is explicitly forbidden');
  A.ok(/iteration="4"/.test(d), 'the digest announces which iteration this is');
  A.eq(LJ.digest(one(mk()), {}), '', 'a loop with no history injects NOTHING (no empty ceremony block)');
}

// ---- 12. settlement fencing + ledger integrity ----
{
  let loops = S.startIteration(S.claimFire(mk(), 'l1', { now: T0 }), 'l1', { runId: 'r1', now: T0 });
  const stale = S.settleIteration(loops, 'l1', { runId: 'OTHER', status: 'ok', text: 'w' }, { now: T0 + MIN });
  A.eq(one(stale).iterations[0].outcome, 'running', 'a settlement from a DIFFERENT run is fenced out');

  const settled = S.settleIteration(loops, 'l1', { runId: 'r1', status: 'ok', text: 'w', title: 't' }, { now: T0 + MIN });
  A.eq(one(settled).iterations[0].outcome, 'candidate', 'the matching run settles');
  A.eq(one(settled).fireClaim, null, 'settlement clears the fire-claim');
  const twice = S.settleIteration(settled, 'l1', { runId: 'r1', status: 'ok', text: 'w' }, { now: T0 + 2 * MIN });
  A.eq(one(twice).iterations.length, 1, 'a double settlement does not duplicate the row');

  // a verdict can only be cast once, and only on a real candidate
  let v = S.recordVerdict(settled, 'l1', 1, 'approved', { now: T0 + HOUR });
  v = S.recordVerdict(v, 'l1', 1, 'rejected', { now: T0 + 2 * HOUR, note: 'changed my mind' });
  A.eq(one(v).iterations[0].verdict, 'approved', 'a settled verdict is immutable — no silent re-rule');
  A.eq(one(S.recordVerdict(settled, 'l1', 99, 'approved', { now: T0 })).iterations[0].verdict, null,
    'a verdict on a non-existent iteration is a no-op');

  // iterationCount advances at START, so a crashed iteration still burns its slot
  const crashed = S.startIteration(mk({ maxIterations: 1 }), 'l1', { runId: 'c1', now: T0 });
  A.eq(one(crashed).iterationCount, 1, 'the slot is taken at start');
  A.eq(LJ.decide(one(crashed), {}, { now: T0 + DAY, staleMs: MIN }).binding, 'max-iterations',
    'a crash mid-iteration cannot silently replay past the ceiling');
}

// ---- 13. cancellation costs neither streak ----
{
  let loops = cycle(mk(), { runId: 'k1', status: 'error', cancelled: true }, T0);
  A.eq(one(loops).iterations[0].outcome, 'cancelled', 'an E-STOPped iteration is recorded as cancelled');
  A.eq(one(loops).failStreak, 0, 'a cancellation is not a failure');
  A.eq(one(loops).dryStreak, 0, 'nor a convergence signal');
}

// ---- 14. envelope: fail-closed, and a hand-edited file cannot NaN its way into firing ----
{
  A.eq(S.loadEnvelope(null).loops, [], 'null -> empty store');
  A.eq(S.loadEnvelope('not json').loops, [], 'garbage -> empty store');
  A.eq(S.loadEnvelope({ loops: [{ id: 'ok', gate: 'auto' }, { id: '../bad' }, null] }).loops.length, 1,
    'malformed / path-escaping records are dropped');
  const poisoned = S.loadEnvelope({ loops: [{ id: 'p', budget: { perDayUsd: 'free', spentTodayUsd: null }, iterationCount: 'lots' }] }).loops[0];
  A.eq(poisoned.budget.perDayUsd, 0, 'a non-numeric cap normalizes to ungoverned, not NaN');
  A.eq(poisoned.iterationCount, 0, 'a non-numeric counter normalizes to 0');
  A.eq(S.loadEnvelope({ loops: [{ id: 'p', gate: 'whatever' }] }).loops[0].gate, 'review',
    'a corrupted gate value can never load as AUTO — the store fails toward asking');

  const round = S.loadEnvelope(JSON.stringify(S.toEnvelope(mk({ gate: 'auto', perDayUsd: 5 }))));
  A.eq(round.loops[0].gate, 'auto', 'a real auto loop survives a persist round-trip');
  A.eq(round.loops[0].budget.perDayUsd, 5, 'and so does its cap');
}

// ---- 15. ledger retention never evicts un-reviewed work ----
{
  let loops = mk({ queueCap: 999, dryStopAfter: 999 });
  // one real candidate, then a flood of settled noops well past the cap
  loops = cycle(loops, { runId: 'keep', status: 'ok', text: 'w', title: 'the one that matters' }, T0);
  for (let i = 0; i < S.ITER_CAP + 20; i++) {
    loops = cycle(loops, { runId: 'n' + i, status: 'ok', text: 'NOTHING-TO-DO' }, T0 + (i + 2) * MIN);
  }
  const l = one(loops);
  A.ok(l.iterations.length <= S.ITER_CAP, 'the ledger is capped');
  A.eq(LJ.pendingReviews(l).length, 1, 'the un-reviewed candidate SURVIVED the prune');
  A.eq(LJ.pendingReviews(l)[0].title, 'the one that matters', 'and it is the right one');
}

// ---- 16. summarize: the UI projection is provable, never a spinner over an unknown ----
{
  let loops = mk({ queueCap: 1, perDayUsd: 2 });
  loops = cycle(loops, { runId: 's1', status: 'ok', text: 'w', title: 'a fix', usd: 0.25 }, T0);
  const s = LJ.summarize(one(loops), { now: T0 + HOUR });
  A.eq(s.state, 'waiting', 'state is reported');
  A.eq(s.binding, 'queue-full', 'and WHY it is quiet');
  A.eq(s.pendingCount, 1, 'pending count matches the ledger');
  A.eq(s.pending[0].title, 'a fix', 'the pending item carries what the agent actually did');
  A.eq(s.budget.spentTodayUsd, 0.25, 'spend is real, not estimated');
  A.eq(s.budget.leftTodayUsd, 1.75, 'and headroom is derived from it');
  A.eq(s.wouldFire, false, 'wouldFire agrees with the binding');
  // provenance must survive into the projection — without it every template-born loop renders as "custom"
  // and the panel falls back to a generic cycle instead of that shape's own steps.
  A.eq(LJ.summarize(one(mk({ meta: { templateId: 'research' } })), { now: T0 }).meta, { templateId: 'research' },
    'meta rides the projection so the panel can name the shape and draw its cycle');
  A.ok(s.binding !== null || s.wouldFire === true, 'a quiet loop ALWAYS has a named binding (invariant 4)');
}

// ---- 17. THE HOST-RUN CHECK: a red check feeds forward, it is not a review item ------------------------
{
  const chk = (o) => Object.assign({ ran: true, passed: false, summary: '2 failing', note: 'check failed — 2 failing', tampered: false, tamperedPaths: [], trusted: false, gitProven: true, mustReview: false }, o);

  let loops = mk({ exitOn: 'check-green', checkCmd: 'npm test', queueCap: 5 });
  loops = cycle(loops, { runId: 'c1', status: 'ok', text: 'tried a fix', title: 'a fix', check: chk() }, T0);
  const it1 = one(loops).iterations[0];
  A.eq(it1.outcome, 'red', 'a failing check makes the iteration RED, not a candidate');
  A.eq(LJ.pendingReviews(one(loops)).length, 0, 'a red iteration NEVER enters the review queue — you are not asked to approve broken work');
  A.eq(one(loops).redStreak, 1, 'the red streak advances');
  A.eq(one(loops).failStreak, 0, 'but a red check is NOT an error — the agent just has not fixed it yet');
  A.eq(one(loops).state, 'idle', 'so the loop stays live and tries again');
  A.eq(it1.check.summary, '2 failing', 'the check result is durable on the iteration');

  // THE FEEDBACK LOOP: the failure output must reach the next iteration
  const d = LJ.digest(one(loops), {});
  A.ok(/FAILED THE PROJECT'S OWN CHECK/.test(d), 'the next iteration is told its work failed the check');
  A.ok(/2 failing/.test(d), 'and is given the actual failure output — this is what makes it a loop, not a retry');
  A.ok(/you cannot see/.test(d), 'and is told the check is not its to see or change');
  A.ok(/does NOT count as passing/.test(d), 'editing the tests is explicitly ruled out in the prompt');
}

// ---- 18. exitOn:'check-green' — a TRUSTED green completes the objective --------------------------------
{
  const green = { ran: true, passed: true, summary: '42 passing', note: '42 passing', tampered: false, tamperedPaths: [], trusted: true, gitProven: true, mustReview: false };
  let loops = mk({ exitOn: 'check-green', checkCmd: 'npm test' });
  loops = cycle(loops, { runId: 'g1', status: 'ok', text: 'fixed it', title: 'fixed it', check: green }, T0);
  A.eq(one(loops).state, 'done', 'a trusted green ENDS the loop — the objective is met');
  A.ok(/objective met/.test(one(loops).stopReason), 'and says so, distinctly from "nothing left to do"');
  A.eq(LJ.decide(one(loops), {}, { now: T0 + DAY }).binding, 'done', 'a done loop is bound as done, not "disabled"');
  A.eq(one(loops).redStreak, 0, 'and the streaks are cleared');

  // an UNTRUSTED green must never complete the objective
  const untrusted = Object.assign({}, green, { trusted: false, mustReview: true, tampered: true, tamperedPaths: ['package.json'] });
  let sneaky = mk({ exitOn: 'check-green', checkCmd: 'npm test', queueCap: 5 });
  sneaky = cycle(sneaky, { runId: 's1', status: 'ok', text: 'done!', title: 'done!', check: untrusted }, T0);
  A.ok(one(sneaky).state !== 'done', 'a TAMPERED green does NOT complete the objective');
  A.eq(LJ.pendingReviews(one(sneaky)).length, 1, 'it goes to a human instead');
}

// ---- 19. THE AUTO-GATE EXCEPTION: full access is not an override on evidence ---------------------------
{
  const tamperedGreen = { ran: true, passed: true, summary: '0 tests', note: 'changed the check itself (package.json)', tampered: true, tamperedPaths: ['package.json'], trusted: false, gitProven: true, mustReview: true };
  const cleanGreen = { ran: true, passed: true, summary: '42 passing', note: '42 passing', tampered: false, tamperedPaths: [], trusted: true, gitProven: true, mustReview: false };

  let auto = mk({ gate: 'auto', exitOn: 'never', queueCap: 5 });
  auto = cycle(auto, { runId: 'a1', status: 'ok', text: 'w', title: 'honest work', check: cleanGreen }, T0);
  A.eq(one(auto).iterations[0].verdict, 'approved', 'a full-access loop auto-approves an honest green');

  auto = cycle(auto, { runId: 'a2', status: 'ok', text: 'w', title: 'rewrote the tests', check: tamperedGreen }, T0 + HOUR);
  const sneaked = one(auto).iterations[1];
  A.eq(sneaked.verdict, null, 'but it does NOT auto-approve an iteration that edited the check itself');
  A.eq(LJ.pendingReviews(one(auto)).length, 1, 'that one is forced in front of a human');
  A.eq(sneaked.check.tampered, true, 'with the tampering recorded');
  A.eq(sneaked.check.tamperedPaths, ['package.json'], 'and the offending path named');
  A.ok(/modified the check itself/.test(LJ.digest(one(auto), {})), 'and the model is told it was caught');
}

// ---- 20. the red ceiling: a loop that can never go green must stop -------------------------------------
{
  const red = { ran: true, passed: false, summary: 'still 2 failing', note: 'check failed', tampered: false, tamperedPaths: [], trusted: false, gitProven: true, mustReview: false };
  let loops = mk({ exitOn: 'check-green', checkCmd: 'npm test', redStopAfter: 3 });
  for (let i = 1; i <= 3; i++) loops = cycle(loops, { runId: 'r' + i, status: 'ok', text: 'attempt', title: 'attempt', check: red }, T0 + i * HOUR);
  A.eq(one(loops).state, 'paused', '3 red iterations in a row park the loop');
  A.ok(/red for 3 iterations/.test(one(loops).stopReason), 'and the reason names the real problem');
  A.eq(LJ.decide(one(loops), {}, { now: T0 + DAY }).fire, false, 'so it stops spending on a fight it is losing');

  // a green anywhere in the run resets the streak
  let mixed = mk({ exitOn: 'never', checkCmd: 'npm test', redStopAfter: 3, queueCap: 9 });
  mixed = cycle(mixed, { runId: 'm1', status: 'ok', text: 'w', title: 'w', check: red }, T0);
  mixed = cycle(mixed, { runId: 'm2', status: 'ok', text: 'w', title: 'w', check: { ran: true, passed: true, trusted: true, summary: 'ok', tamperedPaths: [] } }, T0 + HOUR);
  A.eq(one(mixed).redStreak, 0, 'a green resets the red streak');
}

// ---- 21. a corrupt exitOn can never load as check-green ------------------------------------------------
{
  A.eq(S.loadEnvelope({ loops: [{ id: 'x', exitOn: 'check-green' }] }).loops[0].exitOn, 'check-green', 'a real exit mode survives a round-trip');
  A.eq(S.loadEnvelope({ loops: [{ id: 'x', exitOn: 'whatever' }] }).loops[0].exitOn, 'never',
    'a corrupt exit mode falls back to never — a loop must not declare itself finished on a value nobody wrote');
  A.eq(one(mk({ exitOn: 'nonsense' })).exitOn, 'never', 'and the same at creation');
}

// ---- 22. THE DIGEST PROTOCOL — the signal the loop templates actually ask the model for ------------------
// REGRESSION: the shipped templates instructed "DIGEST: 0 findings" while this parser only understood
// "NOTHING-TO-DO", so Sweep & Fix and Research could never converge and would run until the budget stopped
// them. Asking a model to CONCEDE fails; asking it to FILE A REPORT works. Both signals are honoured now.
{
  A.eq(LJ.readDigest('DIGEST: 0 findings — nothing new').filed, true, 'a well-formed digest is read');
  A.eq(LJ.readDigest('DIGEST: 0 findings — nothing new').count, 0, 'and its count is extracted');
  A.eq(LJ.readDigest('did stuff\nDIGEST: 3 findings — fixed three').count, 3, 'a non-zero count reads too');
  A.eq(LJ.readDigest('DIGEST:12 findings').count, 12, 'spacing is forgiving');
  A.eq(LJ.readDigest('nothing here').filed, false, 'no digest = not filed');
  A.eq(LJ.readDigest('the digest showed no findings').filed, false,
    'PROSE ABOUT a digest is not a filed digest — the count must be a bare number after the marker');
  A.eq(LJ.readDigest('DIGEST: lots of findings').filed, false, 'a countless digest is malformed, not zero');
  A.eq(LJ.readDigest('DIGEST: lots of findings').malformed, true, 'and is flagged as malformed rather than ignored');

  A.eq(LJ.nextOutcomeFor('DIGEST: 0 findings — nothing new'), 'noop', 'a zero-finding report IS convergence');
  A.eq(LJ.nextOutcomeFor('DIGEST: 2 findings — fixed two'), 'candidate', 'a non-zero report is real work');
  A.eq(LJ.nextOutcomeFor('NOTHING-TO-DO'), 'noop', 'the explicit override still works');
  A.eq(LJ.nextOutcomeFor('I could not find anything at all'), 'candidate',
    'prose that merely SOUNDS finished is never convergence — only a filed signal counts');

  // end to end: a research-shaped loop now actually reaches DORMANT on filed zero-reports
  let loops = mk({ exitOn: 'empty-digests', dryStopAfter: 2, queueCap: 5 });
  loops = cycle(loops, { runId: 'd1', status: 'ok', text: 'looked around.\nDIGEST: 0 findings — nothing new' }, T0);
  A.eq(one(loops).iterations[0].outcome, 'noop', 'pass 1 counted as empty');
  loops = cycle(loops, { runId: 'd2', status: 'ok', text: 'DIGEST: 0 findings — nothing new' }, T0 + HOUR);
  A.eq(one(loops).state, 'dormant', 'TWO filed zero-reports park the loop — the bug that shipped made this impossible');
}

// ---- 23. the closing instruction must match what the loop MEASURES --------------------------------------
// The shipped digest block told EVERY loop to say NOTHING-TO-DO, contradicting the template's own protocol.
{
  const seed = (spec) => { let l = mk(spec); return cycle(l, { runId: 'x', status: 'ok', text: 'w', title: 'w' }, T0); };

  const soft = LJ.digest(one(seed({ exitOn: 'empty-digests', queueCap: 5 })), {});
  A.ok(/DIGEST: <n> findings/.test(soft), 'a digest-measured loop is asked for a DIGEST line');
  A.ok(!/NOTHING-TO-DO and stop/.test(soft), 'and is NOT simultaneously told to say NOTHING-TO-DO');

  const hard = LJ.digest(one(seed({ exitOn: 'check-green', checkCmd: 'npm test', queueCap: 5 })), {});
  A.ok(/You do not declare this task finished/.test(hard), 'a check-measured loop is told the CHECK decides');
  A.ok(!/DIGEST: <n>/.test(hard), 'and is not asked for a digest it does not need');
  A.ok(!/NOTHING-TO-DO and stop/.test(hard), 'nor invited to self-declare a finish the check has not granted');

  const open = LJ.digest(one(seed({ exitOn: 'never', queueCap: 5 })), {});
  A.ok(/NOTHING-TO-DO/.test(open), 'an open-ended loop keeps the explicit escape hatch');
}

// ---- 24. a loop that stops FILING reports cannot converge — say so ---------------------------------------
{
  let loops = mk({ exitOn: 'empty-digests', dryStopAfter: 3, queueCap: 9 });
  loops = cycle(loops, { runId: 'n1', status: 'ok', text: 'did a thing, forgot the report', title: 'a thing' }, T0);
  A.eq(one(loops).noDigestStreak, 1, 'a pass with no readable digest is counted');
  loops = cycle(loops, { runId: 'n2', status: 'ok', text: 'again no report', title: 'again' }, T0 + HOUR);
  A.eq(one(loops).noDigestStreak, 2, 'and the streak grows');
  const s = LJ.summarize(one(loops), { now: T0 + 2 * HOUR });
  A.eq(s.expectsDigest, true, 'the projection says this loop needs reports to finish');
  A.eq(s.noDigestStreak, 2, 'and how long it has gone without one — a silent non-reporting loop looks healthy otherwise');
  A.ok(/did not include a readable DIGEST/.test(LJ.digest(one(loops), {})), 'and the model is told directly');

  loops = cycle(loops, { runId: 'n3', status: 'ok', text: 'DIGEST: 1 findings — fixed it', title: 'fixed' }, T0 + 3 * HOUR);
  A.eq(one(loops).noDigestStreak, 0, 'filing one resets the streak');
  A.eq(LJ.summarize(one(mk({ exitOn: 'check-green' })), { now: T0 }).expectsDigest, false,
    'a check-measured loop does not expect digests, so it is never flagged for missing them');
}

// ---- 25. THE REVIEW DIFF: held while reviewable, dropped the moment it is decided -----------------------
// "Deliverable = OPEN, not read" — a review gate you cannot see through is theatre. But a diff per pass across
// a 200-entry ledger would bloat the durable file without limit, so it lives exactly as long as it is useful.
{
  const DIFF = [
    '--- a/src/cart.js',
    '+++ b/src/cart.js',
    '@@ -12,1 +12,1 @@',
    '-  return a / b;',
    '+  return b === 0 ? 0 : a / b;'
  ].join('\n');
  let loops = mk({ queueCap: 5 });
  loops = cycle(loops, { runId: 'd1', status: 'ok', text: 'w', title: 'guard the divide', diff: DIFF, files: [{ path: 'src/cart.js' }] }, T0);
  A.eq(one(loops).iterations[0].diff, DIFF, 'the pass stores its diff');
  const s = LJ.summarize(one(loops), { now: T0 + HOUR });
  A.eq(s.pending[0].diff, DIFF, 'and it rides the projection so the card can render it');
  A.eq(s.pending[0].files[0].path, 'src/cart.js', 'alongside the file list');

  loops = S.recordVerdict(loops, 'l1', 1, 'approved', { now: T0 + HOUR });
  A.eq(one(loops).iterations[0].diff, null, 'ONCE DECIDED the diff is dropped — it was for deciding');
  A.eq(one(loops).iterations[0].title, 'guard the divide', 'but the durable record of what happened remains');
  A.eq(one(loops).iterations[0].files.length, 1, 'including which files it touched');

  // a rejection cascade must drop the diffs it discards too, or they linger forever unreviewable
  let st = mk({ queueCap: 5 });
  for (let i = 1; i <= 3; i++) st = cycle(st, { runId: 'x' + i, status: 'ok', text: 'w', title: 'w' + i, diff: DIFF }, T0 + i * HOUR);
  st = S.recordVerdict(st, 'l1', 1, 'rejected', { now: T0 + 9 * HOUR, note: 'no' });
  A.eq(one(st).iterations.filter(it => it.diff).length, 0, 'a cascade drops the discarded passes diffs as well');

  // gate:'auto' never queues, so holding a diff for a review that will not happen is pure bloat
  let au = mk({ gate: 'auto', queueCap: 5 });
  au = cycle(au, { runId: 'a1', status: 'ok', text: 'w', title: 'auto', diff: DIFF }, T0);
  A.eq(one(au).iterations[0].verdict, 'approved', 'an auto pass self-approves');
  A.eq(one(au).iterations[0].diff, null, 'and holds no diff for a review nobody will open');

  // an oversized diff is clamped rather than allowed to bloat the durable file
  let big = mk({ queueCap: 5 });
  big = cycle(big, { runId: 'b1', status: 'ok', text: 'w', title: 'huge', diff: 'x'.repeat(50000) }, T0);
  A.ok(one(big).iterations[0].diff.length <= 12000, 'a huge diff is capped at DIFF_CAP');

  // a non-git project simply has none — the card falls back to the file list rather than inventing one
  let nog = mk({ queueCap: 5 });
  nog = cycle(nog, { runId: 'n1', status: 'ok', text: 'w', title: 'no git' }, T0);
  A.eq(one(nog).iterations[0].diff, null, 'no diff is invented when none was captured');
}

// ---- 26. RESTART CONTEXT: an interrupted pass is never silently forgotten -------------------------------
{
  let loops = S.startIteration(S.claimFire(mk(), 'l1', { now: T0 }), 'l1', { runId: 'lost-run', now: T0 });
  loops = S.settleIteration(loops, 'l1', {
    runId: 'lost-run', status: 'error', cancelled: true, error: 'interrupted by sidecar restart'
  }, { now: T0 + MIN });
  const d = LJ.digest(one(loops), {});
  A.ok(/INTERRUPTED/.test(d), 'the next pass is told that prior work was interrupted');
  A.ok(/inspect|verify/i.test(d), 'the next pass is told to inspect current state before repeating actions');
  A.ok(/#1/.test(d), 'the durable interrupted iteration number anchors the warning');
  A.ok(!/ALREADY DONE AND APPROVED/.test(d), 'an interrupted pass is never represented as completed work');
}

// ---- 27. THE STALL BREAKER: a loop that claims work the ledger cannot see parks itself ----------------------
// The 2026-09-17 customer incident: 98 overnight passes on a full-access loop, each "verified the files exist",
// each filed as a candidate, each auto-approved, none changing anything. dryStreak never moved (the model never
// conceded) and the review queue never filled (gate:'auto'). The breaker reads the LEDGER instead of the mood.
{
  // (a) the pure signal — what counts as "changed nothing"
  const git = { workdir: 'C:\\proj', iterations: [] };
  A.eq(LJ.stallSignal(git, { outcome: 'candidate', files: [], commit: null, summary: 'verified all files exist' }), 'no-change',
    'a git loop pass with no files, no commit and no findings is a no-change stall');
  A.eq(LJ.stallSignal(git, { outcome: 'candidate', files: ['a.js'], commit: null, summary: 'x' }), null, 'a touched file is real work');
  A.eq(LJ.stallSignal(git, { outcome: 'candidate', files: [], commit: 'abc123', summary: 'x' }), null, 'a landed commit is real work');
  A.eq(LJ.stallSignal(git, { outcome: 'candidate', files: [], commit: null, digest: { filed: true, count: 2 } }), null,
    'a filed digest with findings is real work even with no diff (a report is the deliverable)');
  A.eq(LJ.stallSignal(git, { outcome: 'noop', files: [], commit: null }), null, 'a noop is convergence, not a stall (own counter)');
  A.eq(LJ.stallSignal(git, { outcome: 'failed', files: [], commit: null }), null, 'a failure is not a stall (own counter)');

  // a loop with no workdir produces TEXT — that alone is never a stall; the SAME text again is
  const txt = { workdir: null, iterations: [{ n: 1, outcome: 'candidate', summary: 'Verified that all the project files exist and everything is in place as expected.' }] };
  A.eq(LJ.stallSignal(txt, { n: 2, outcome: 'candidate', files: [], commit: null, summary: 'Verified that all project files exist, everything is in place as expected.' }), 'echo',
    'a text loop repeating its previous summary is an echo stall');
  A.eq(LJ.stallSignal(txt, { n: 2, outcome: 'candidate', files: [], commit: null, summary: 'Drafted the pricing section with three tiers and a comparison table.' }), null,
    'a text loop saying something NEW is real work');
  A.eq(LJ.stallSignal({ workdir: null, iterations: [] }, { n: 1, outcome: 'candidate', files: [], commit: null, summary: 'first pass' }), null,
    'the first pass of a text loop has nothing to echo');
  A.ok(LJ.similarity('Fixed lint errors in foo.js and bar.js today', 'Fixed lint errors in baz.js and qux.js today') < LJ.ECHO_THRESHOLD,
    'two genuinely different fixes with shared scaffolding words are NOT an echo');
  A.eq(LJ.similarity('ok done', 'ok done'), 1, 'short summaries compare by exact match');
  A.eq(LJ.similarity('ok done', 'all done'), 0, 'and a short near-miss is not an echo (overlap on two words is a coin toss)');

  // (b) the store: three no-change passes in a row park a FULL-ACCESS git loop as paused, with the reason spelled out
  const stalled = (loops, id, at, summary) => cycle(loops, { runId: id, status: 'ok', text: summary, title: summary, summary: summary, files: [], commit: null }, at);
  let loops = mk({ gate: 'auto', workdir: 'C:\\proj', queueCap: 5 });
  loops = stalled(loops, 's1', T0, 'Verified the files exist. Everything is in place.');
  A.eq(one(loops).stallStreak, 1, 'one no-change pass counts');
  A.eq(one(loops).iterations[0].stall, 'no-change', 'and is stamped on the row for the panel');
  A.eq(one(loops).iterations[0].verdict, 'approved', 'the auto gate still recorded it honestly (it did run)');
  A.eq(one(loops).state, 'idle', 'one stall does not park — the nudge gets a chance first');
  const nudged = LJ.digest(one(loops), {});
  A.ok(/CHANGED NOTHING/.test(nudged), 'the next pass is told its last pass changed nothing');
  A.ok(/Checking that files exist is not work/.test(nudged), 'and named the exact loop it is in');
  A.ok(/NOTHING-TO-DO/.test(nudged), 'with the honest exit still on the table');
  loops = stalled(loops, 's2', T0 + MIN * 2, 'Confirmed all files are present. Everything is in place.');
  A.eq(one(loops).stallStreak, 2, 'a second no-change pass extends the streak');
  loops = stalled(loops, 's3', T0 + MIN * 4, 'Verified the files exist again. Everything is in place.');
  const parked = one(loops);
  A.eq(parked.stallStreak, 3, 'the third stall reaches the ceiling');
  A.eq(parked.state, 'paused', 'and PARKS the loop — the 98-pass overnight burn cannot happen');
  A.eq(parked.enabled, false, 'disabled, so decide() refuses to fire');
  A.ok(/3 passes in a row changed nothing/.test(parked.stopReason), 'with the count in the reason');
  A.eq(LJ.decide(parked, {}, { now: T0 + HOUR }).fire, false, 'a parked loop does not fire');
  A.eq(LJ.decide(parked, {}, { now: T0 + HOUR }).binding, 'paused', 'and the binding names the quiet state');
  const s = LJ.summarize(parked, { now: T0 + HOUR });
  A.eq(s.stallStreak, 3, 'the projection carries the streak');
  A.eq(s.stallStopAfter, 3, 'and the shipped ceiling');
  A.eq(s.recent.filter(r => r.stall === 'no-change').length, 3, 'and marks every stalled row for the panel');

  // (c) real work resets the streak; a stall after real work starts over
  let mixed = mk({ gate: 'auto', workdir: 'C:\\proj', queueCap: 5 });
  mixed = stalled(mixed, 'm1', T0, 'Verified the files exist.');
  mixed = stalled(mixed, 'm2', T0 + MIN * 2, 'Verified the files exist.');
  mixed = cycle(mixed, { runId: 'm3', status: 'ok', text: 'Fixed the null check', title: 'Fixed the null check', files: ['auth.js'], commit: 'c1' }, T0 + MIN * 4);
  A.eq(one(mixed).stallStreak, 0, 'a pass that changed a file resets the streak');
  A.eq(one(mixed).iterations[2].stall, undefined, 'and carries no stall mark');
  mixed = stalled(mixed, 'm4', T0 + MIN * 6, 'Verified the files exist.');
  A.eq(one(mixed).stallStreak, 1, 'a later stall starts a fresh count, not the old one');
  A.eq(one(mixed).state, 'idle', 'so the loop is still live');

  // (d) a REVIEW-gated git loop stalls the same way (the breaker is not an auto-only rule)
  let rev = mk({ gate: 'review', workdir: 'C:\\proj', queueCap: 5 });
  for (let i = 0; i < 3; i++) rev = stalled(rev, 'r' + i, T0 + i * MIN * 2, 'Verified the files exist.');
  A.eq(one(rev).state, 'paused', 'a review loop that only looks is parked too, before the queue fills with nothing');

  // (e) a text loop (no workdir) that does new work every pass is never touched
  let research = mk({ gate: 'auto', queueCap: 5 });
  const findings = ['Three competitors price at $29, $49 and $99 per seat with annual discounts.', 'Their onboarding funnels lose most users at the credential step, per public reviews.', 'Two of the three ship a free tier; the third gates everything behind a demo call.'];
  findings.forEach((f, i) => { research = cycle(research, { runId: 'q' + i, status: 'ok', text: f, title: f.slice(0, 40), summary: f, files: [] }, T0 + i * MIN * 2); });
  A.eq(one(research).stallStreak, 0, 'a research loop producing new text each pass has no stall streak');
  A.eq(one(research).state, 'idle', 'and stays live');
  // …but the same text three times is the echo case, and it parks
  let echo = mk({ gate: 'auto', queueCap: 5 });
  for (let i = 0; i < 3; i++) echo = cycle(echo, { runId: 'e' + i, status: 'ok', text: 'x', title: 'Verified', summary: 'Verified that every deliverable file exists and everything is in place.', files: [] }, T0 + i * MIN * 2);
  A.eq(one(echo).iterations[0].stall, undefined, 'the first pass cannot be an echo');
  A.eq(one(echo).iterations[1].stall, 'echo', 'the second is');
  A.eq(one(echo).iterations[2].stall, 'echo', 'and the third');
  A.eq(one(echo).stallStreak, 2, 'two echoes so far');
  A.eq(one(echo).state, 'idle', 'not yet parked (the ceiling counts stalls, and the first pass was not one)');
  echo = cycle(echo, { runId: 'e3', status: 'ok', text: 'x', title: 'Verified', summary: 'Verified that every deliverable file exists and everything is in place.', files: [] }, T0 + 6 * MIN * 2);
  A.eq(one(echo).state, 'paused', 'the third echo parks it');
  A.ok(/CHANGED NOTHING/.test(LJ.digest(one(echo), {})) && /repeated the pass before it/.test(LJ.digest(one(echo), {})), 'the nudge says WHY it counted (the report repeated itself)');

  // (f) the ceiling is editable and clamped; RESUME clears the streak but keeps the marked rows
  A.eq(LJ.stallStopOf({ stallStopAfter: 0 }), 1, 'a zero ceiling clamps to 1 (never "off" — off is the 98-pass burn)');
  A.eq(LJ.stallStopOf({ stallStopAfter: 999 }), 20, 'and to the max');
  A.eq(LJ.stallStopOf({}), 3, 'default 3');
  A.eq(one(S.updateLoop(mk(), 'l1', { stallStopAfter: 7 }, { now: T0 })).stallStopAfter, 7, 'the ceiling is patchable');
  const woke = one(S.resumeLoop(loops, 'l1', { now: T0 + DAY }));
  A.eq(woke.state, 'idle', 'resume lifts the park');
  A.eq(woke.stallStreak, 0, 'and clears the streak so it does not instantly re-park');
  A.eq(woke.iterations.filter(it => it.stall).length, 3, 'but the record keeps what happened');

  // (g) a pre-breaker record loads with the shipped ceiling and a clean streak (no upgrade step needed)
  const old = S.loadEnvelope({ version: 1, loops: [{ id: 'old1', name: 'legacy', objective: 'o', iterations: [] }] });
  A.eq(old.loops[0].stallStreak, 0, 'a legacy record has a clean stall streak');
  A.eq(old.loops[0].stallStopAfter, 3, 'and the shipped ceiling');
}

A.report('loopjob (pure LOOP core)');
