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
  A.eq(killStopHandles(boom), 1, 'one throwing handle never stops the rest');
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
const at = halt.indexOf('killStopHandles(runStopHandles)');
A.ok(at > 0, 'handleHalt kills every stop handle');
for (const earlier of ['killAll(runs,', 'cronDriver.abortAllLeases()', 'nightshiftDriver.abortBeat()', 'loopDriver.abortAllLeases()']) {
  const i = halt.indexOf(earlier);
  A.ok(i > 0 && i < at, 'the stop handles are killed after ' + earlier + ', so the count holds only runs it missed');
}
A.ok(/handleAborted = killStopHandles\(runStopHandles\)/.test(halt), 'their count is kept');
A.ok(/halted: halted \+ phoneAborted \+ handleAborted,/.test(halt), 'and added to the halted total the E-STOP toast shows');

// ---- 4. the process-fault quiesce reaches them too, in its own containment ----
const quiesce = sidecarTopLevelFunction('quiesceForProcessFault');
A.ok(quiesce.length > 1000 && quiesce.length < 20000, 'one bounded quiesceForProcessFault');
A.ok(/contain\('stop-handles', \(\) => killStopHandles\(runStopHandles\)\);/.test(quiesce), 'the fault quiesce kills every stop handle in its own containment');
A.ok(quiesce.indexOf("contain('stop-handles'") > quiesce.indexOf("contain('runs'"), 'after the run and hub kills');

A.report('estop-stop-handles.test');
