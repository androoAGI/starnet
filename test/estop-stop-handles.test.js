/* node test/estop-stop-handles.test.js — E-STOP reaches every run runOnce drives by its id (QA 0930, quick win 1).

   Every id'd run runOnce drives holds a stop: a routine fire, a hop, a line trigger, the step test, a channel hub, a /v1
   run. /api/cancel reached them by id, but E-STOP (handleHalt) and the process-fault quiesce killed only `runs` plus the
   hub maps — so a /v1 run or a routine hop kept spending through an E-STOP whose toast said it had stopped everything.
   Since run-table S3 that stop is the run's RUN-TABLE ENTRY's, joined at admission (a turn still queued behind its
   conversation included), and E-STOP, the quiesce and the update drain stop them all with runTable.stopAll, which is
   halt.js killStopHandles over the entries' stops. The behaviour is proven through the real sidecar by
   test/run-registry-coverage.http.test.js (estop-stops-v1) and test/run-lifecycle.invariants.http.test.js; these lock the order.

   Locks:
   1. halt.js killStopHandles aborts EVERY handle and counts only the runs no other kill had reached yet (a handle's
      runSignal = its owner's signal OR the handle), so the toast never counts one run twice;
   2. runOnce joins the run's signal with its entry's stop at admission, ahead of its conversation queue;
   3. handleHalt stops the run table AFTER its other kills and adds the count to `halted` (the toast's count);
   4. quiesceForProcessFault stops it in its own containment. */
'use strict';
const A = require('./_assert.js');
const { sidecarFunctionSource, sidecarTopLevelFunction, sidecarSourceFiles } = require('./helpers/source');
const { killAll, killStopHandles } = require('../sidecar/halt.js');

// ---- 1. the counting rule, on real AbortSignal.any handles shaped exactly as runOnceTracked builds them ----
function handle(ownerSignal) {
  const kc = new AbortController();
  kc.runSignal = ownerSignal ? AbortSignal.any([ownerSignal, kc.signal]) : kc.signal;
  return kc;
}
{
  const ownerOfA = new AbortController();
  const handles = new Map([
    ['a', handle(ownerOfA.signal)],   // a hub run: its owner's abort reaches it first
    ['b', handle(new AbortController().signal)],   // a hop whose owner nothing stops
    ['c', handle(null)]               // a /v1 run with no owner signal at all
  ]);
  ownerOfA.abort();                   // the other E-STOP kills ran first
  const n = killStopHandles(handles);
  A.eq(n, 2, 'only the runs no other kill had reached are counted');
  A.ok([...handles.values()].every(kc => kc.signal.aborted && kc.runSignal.aborted), 'every handle is aborted, counted or not');
  A.eq(killStopHandles(handles), 0, 'a second E-STOP counts nothing that is already stopped');
  A.eq(killStopHandles(null), 0, 'no map: 0, never a throw');
  const boom = new Map([['x', { abort() { throw new Error('boom'); } }], ['y', handle(null)]]);
  const noted = [];
  A.eq(killStopHandles(boom, e => noted.push(e.message)), 1, 'one throwing handle never stops the rest, and is not counted as a stop');
  A.eq(noted, ['boom'], 'its error goes to the host\'s failNote, never swallowed');
  // and the same run in `runs` AND a stop handle (an interactive run is both) is counted once across the two kills
  const ac = new AbortController();
  const runs = new Map([['r', ac]]);
  const both = new Map([['r', handle(ac.signal)]]);
  A.eq(killAll(runs) + killStopHandles(both), 1, 'a run in `runs` with a stop handle is counted once');
}

// ---- 1b. the run table's stopAll IS that rule, over its entries' stops (sidecar/run-table.js) ----
const runTableSrc = (sidecarSourceFiles().find(f => f.rel === 'sidecar/run-table.js') || { text: '' }).text;
{
  const RunTable = require('../sidecar/run-table.js');
  const t = RunTable.makeRunTable({ now: () => 0, note: () => {} });
  const ownerOfA = new AbortController();
  const a = t.admit(RunTable.metaOf({ runId: 'a', agentId: 'agent' })); a.join(ownerOfA.signal);   // a hub run
  const b = t.admit(RunTable.metaOf({ runId: 'b', agentId: 'agent' })); b.join(new AbortController().signal);   // a hop
  const c = t.admit(RunTable.metaOf({ runId: 'c', agentId: 'agent', taskSource: 'api' })); c.join(undefined);   // a /v1 run
  ownerOfA.abort();                   // the other E-STOP kills ran first
  A.eq(t.stopAll('estop'), 2, 'runTable.stopAll: only the runs no other kill had reached are counted');
  A.eq(t.stopAll('estop'), 0, 'and a second E-STOP counts nothing');
  for (const h of [a, b, c]) h.release();
  A.ok(/return killStopHandles\(stops, /.test(runTableSrc), 'stopAll is halt.js killStopHandles over the entries\' stops (one counting rule)');
}

// ---- 2. runOnce joins the run's signal with its entry's stop at admission: the combined signal the count reads ----
const once = sidecarFunctionSource('runOnce');
A.ok(once.length > 200 && once.length < 6000, 'one bounded runOnce');
const admitAt = once.indexOf('runTable.admit(');
const joinAt = once.indexOf('{ const joined = run.join(o.signal); if (joined !== o.signal) o.signal = joined; }');
const queueAt = once.indexOf('try { return await runOnceQueued(o, run); }');
A.ok(admitAt > 0 && joinAt > admitAt && queueAt > joinAt, 'runOnce joins the run\'s signal with its entry\'s stop right after admission, before its conversation queue');
A.ok(!/await/.test(once.slice(admitAt, queueAt)), 'with nothing awaited between: a turn waiting in its queue is already stoppable');
A.ok(/entry\.stopper\.runSignal = out;/.test(runTableSrc), 'the joined signal is recorded on the entry\'s stop (what the count reads)');

// ---- 3. E-STOP stops the run table after its other kills and counts it in `halted` ----
const halt = sidecarTopLevelFunction('handleHalt');
A.ok(halt.length > 1000 && halt.length < 20000, 'one bounded handleHalt');
const at = halt.indexOf("runTable.stopAll('estop')");
A.ok(at > 0, 'handleHalt stops every run-table entry');
for (const earlier of ['killAll(runs,', 'cronDriver.abortAllLeases()', 'nightshiftDriver.abortBeat()', 'loopDriver.abortAllLeases()']) {
  const i = halt.indexOf(earlier);
  A.ok(i > 0 && i < at, 'the run table is stopped after ' + earlier + ', so the count holds only runs it missed');
}
A.ok(/tableAborted = runTable\.stopAll\('estop'\); \} catch \(e\) \{ failNote\('run-table\.estop', e\); \}/.test(halt), 'its count is kept, and a failed stop is noted');
A.ok(/halted: halted \+ phoneAborted \+ tableAborted,/.test(halt), 'and added to the halted total the E-STOP toast shows');

// ---- 4. the process-fault quiesce reaches them too, in its own containment ----
const quiesce = sidecarTopLevelFunction('quiesceForProcessFault');
A.ok(quiesce.length > 1000 && quiesce.length < 20000, 'one bounded quiesceForProcessFault');
A.ok(/contain\('run-table', \(\) => runTable\.stopAll\('fault'\)\);/.test(quiesce), 'the fault quiesce stops every run-table entry in its own containment');
A.ok(quiesce.indexOf("contain('run-table'") > quiesce.indexOf("contain('runs'"), 'after the run and hub kills');

// ---- 5. a routine hop the FAULT stopped names the fault, never "stopped by you" (review of quick win 1) ----
// The quiesce disarms cron but never aborts its leases, so the stop-handle kill above is what stops an in-flight routine
// hop; its sink reads agent.run.end 'cancelled' and its record said "stopped by you" for a stop the Commander never made.
{
  const said = sidecarFunctionSource('hopStoppedSaid');
  A.ok(said.length > 40 && said.length < 800, 'one bounded hopStoppedSaid');
  const run = (processFaultQuiesced, cronHalted) => new Function('processFaultQuiesced', 'cronHalted', said + '\nreturn hopStoppedSaid();')(processFaultQuiesced, cronHalted);
  A.eq(run(true, false), 'the station hit an internal fault and stopped this run', 'a hop stopped by the fault quiesce says the station\'s fault');
  A.eq(run(false, false), 'stopped by you', 'a hop the Commander stopped (STOP by id) still says so');
  A.eq(run(false, true), 'stopped by you', 'and an E-STOP is theirs');
  A.eq(run(true, true), 'stopped by you', 'a fault after their own E-STOP stays theirs (the trigger and hand-off runners\' faulted() reading)');
  // both routine-hop sinks read it: the scheduled fire's advanceChain hop and RUN NOW's chain hop (handleCronRun)
  const runNow = sidecarTopLevelFunction('handleCronRun');
  A.ok(/error: hopError\(hs, hs\.stopped \? hopStoppedSaid\(\) : ''\)/.test(runNow), 'RUN NOW\'s chain hop words its stop through hopStoppedSaid');
  const { readSidecarSource } = require('./helpers/source');
  // the module-level cron driver config (not a named function): sliced between its advanceChain and the boot reconcile
  // comment that follows it, both required and in one slice, so the lock is about that hop sink alone
  const idx = readSidecarSource();
  const a = idx.indexOf('advanceChain: (o) => chainRunner.advance({');
  const b = idx.indexOf('// A crash can land after markRun durably commits', a);
  A.ok(a > 0 && b > a, 'found the scheduled fire\'s advanceChain hop sink');
  const fire = idx.slice(a, b);
  A.ok(/error: hopError\(hs, hs\.stopped \? hopStoppedSaid\(\) : ''\)/.test(fire) && !/'stopped by you'/.test(fire), 'the scheduled fire\'s hop words its stop through hopStoppedSaid');
}

A.report('estop-stop-handles.test');
