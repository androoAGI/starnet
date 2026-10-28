/* node test/estop-stop-handles.test.js — E-STOP reaches every run runOnce drives by its id (QA 0930, quick win 1).

   runOnceTracked gives every id'd run a stop handle (runStopHandles): a routine fire, a hop, a line trigger, the step
   test, a channel hub, a /v1 run. /api/cancel reached them by id, but E-STOP (handleHalt) and the process-fault quiesce
   killed only `runs` plus the hub maps — so a /v1 run or a routine hop kept spending through an E-STOP whose toast said
   it had stopped everything.

   Locks:
   1. halt.js killStopHandles aborts EVERY handle and counts only the runs no other kill had reached yet (a handle's
      runSignal = its owner's signal OR the handle), so the toast never counts one run twice;
   2. runOnceTracked stamps that combined signal on the handle;
   3. handleHalt kills the handles AFTER its other kills and adds them to `halted` (the toast's count);
   4. quiesceForProcessFault kills them in their own containment. */
'use strict';
const A = require('./_assert.js');
const { sidecarFunctionSource, sidecarTopLevelFunction } = require('./helpers/source');
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

// ---- 2. runOnceTracked stamps the combined signal the count reads ----
const tracked = sidecarFunctionSource('runOnceTracked');
A.ok(tracked.length > 200 && tracked.length < 4000, 'one bounded runOnceTracked');
A.ok(/o\.signal = o\.signal \? AbortSignal\.any\(\[o\.signal, kc\.signal\]\) : kc\.signal;\s*kc\.runSignal = o\.signal;/.test(tracked),
  'runOnceTracked records the run\'s combined signal on its stop handle');

// ---- 3. E-STOP kills the stop handles after its other kills and counts them in `halted` ----
const halt = sidecarTopLevelFunction('handleHalt');
A.ok(halt.length > 1000 && halt.length < 20000, 'one bounded handleHalt');
const at = halt.indexOf('killStopHandles(runStopHandles, ');
A.ok(at > 0, 'handleHalt kills every stop handle');
for (const earlier of ['killAll(runs,', 'cronDriver.abortAllLeases()', 'nightshiftDriver.abortBeat()', 'loopDriver.abortAllLeases()']) {
  const i = halt.indexOf(earlier);
  A.ok(i > 0 && i < at, 'the stop handles are killed after ' + earlier + ', so the count holds only runs it missed');
}
A.ok(/handleAborted = killStopHandles\(runStopHandles, e => failNote\('stop-handles\.estop', e\)\)/.test(halt), 'their count is kept, and a handle that fails to abort is noted');
A.ok(/halted: halted \+ phoneAborted \+ handleAborted,/.test(halt), 'and added to the halted total the E-STOP toast shows');

// ---- 4. the process-fault quiesce reaches them too, in its own containment ----
const quiesce = sidecarTopLevelFunction('quiesceForProcessFault');
A.ok(quiesce.length > 1000 && quiesce.length < 20000, 'one bounded quiesceForProcessFault');
A.ok(/contain\('stop-handles', \(\) => killStopHandles\(runStopHandles, e => failNote\('process-fault\.quiesce\.stop-handles', e\)\)\);/.test(quiesce), 'the fault quiesce kills every stop handle in its own containment, noting a failed abort');
A.ok(quiesce.indexOf("contain('stop-handles'") > quiesce.indexOf("contain('runs'"), 'after the run and hub kills');

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
  A.ok(/error: hs\.errMsg \|\| \(hs\.stopped \? hopStoppedSaid\(\) : null\)/.test(runNow), 'RUN NOW\'s chain hop words its stop through hopStoppedSaid');
  const { readSidecarSource } = require('./helpers/source');
  // the module-level cron driver config (not a named function): sliced between its advanceChain and the boot reconcile
  // comment that follows it, both required and in one slice, so the lock is about that hop sink alone
  const idx = readSidecarSource();
  const a = idx.indexOf('advanceChain: (o) => chainRunner.advance({');
  const b = idx.indexOf('// A crash can land after markRun durably commits', a);
  A.ok(a > 0 && b > a, 'found the scheduled fire\'s advanceChain hop sink');
  const fire = idx.slice(a, b);
  A.ok(/error: hs\.errMsg \|\| \(hs\.stopped \? hopStoppedSaid\(\) : null\)/.test(fire) && !/'stopped by you'/.test(fire), 'the scheduled fire\'s hop words its stop through hopStoppedSaid');
}

A.report('estop-stop-handles.test');
