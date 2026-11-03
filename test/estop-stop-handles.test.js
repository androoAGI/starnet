/* node test/estop-stop-handles.test.js — E-STOP reaches every run runOnce drives by its id (QA 0930, quick win 1).

   Every id'd run runOnce drives holds a stop: a routine fire, a hop, a line trigger, the step test, a channel hub, a /v1
   run. /api/cancel reached them by id, but E-STOP (handleHalt) and the process-fault quiesce killed only `runs` plus the
   hub maps — so a /v1 run or a routine hop kept spending through an E-STOP whose toast said it had stopped everything.
   Since run-table S3 that stop is the run's RUN-TABLE ENTRY's, joined at admission (a turn still queued behind its
   conversation included), and E-STOP, the quiesce and the update drain stop them through the table. The behaviour is proven through the real sidecar by
   test/run-registry-coverage.http.test.js (estop-stops-v1) and test/run-lifecycle.invariants.http.test.js; these lock the order.

   Locks:
   1. the table's owned-stop phase preserves the legacy owner-attempt count; its final stopAll counts only fresh
      joined aborts after the hub/subsystem kills. The retired standalone helper is not a second oracle;
   2. runOnce joins the run's signal with its entry's stop at admission, ahead of its conversation queue;
   3. handleHalt stops the run table AFTER its other kills and adds the count to `halted` (the toast's count);
   4. quiesceForProcessFault stops it in its own containment. */
'use strict';
const A = require('./_assert.js');
const { sidecarFunctionSource, sidecarTopLevelFunction, sidecarSourceFiles } = require('./helpers/source');
const { killAll } = require('../sidecar/halt.js');
const RunTable = require('../sidecar/run-table.js');

// ---- 1. production table + actual hub kill: two phases, no external stop-handle registry ----
{
  const t = RunTable.makeRunTable(), leases = [], signals = [];
  const ac = new AbortController(); let ownerCalls = 0;
  leases.push(t.admit({ runId: 'interactive' }, { signal: ac.signal, stop: () => { ownerCalls++; ac.abort(); } }));
  const join = (id, signal) => { const lease = t.admit({ runId: id }); leases.push(lease); const joined = lease.join(signal); signals.push(joined); return joined; };
  join('interactive', ac.signal);
  const hubOwner = new AbortController();
  const hub = { runId: 'hub', abort: hubOwner };
  let reasonAtAbort; hubOwner.signal.addEventListener('abort', () => { reasonAtAbort = hub.endReason; });
  join('hub', hubOwner.signal);
  const scheduled = new AbortController(); join('scheduled', scheduled.signal);
  join('hop'); join('api');
  A.eq(t.stopOwners('estop'), 1, 'owner phase counts the interactive owner, not ownerless scheduled/hub/API cores');
  A.eq(ownerCalls, 1, 'owner bookkeeping runs in that phase');
  A.eq(killAll(null, new Map([['chat', hub]])), 1, 'hub kill still counts its own inflight record');
  A.ok(hub.endReason === 'halted' && reasonAtAbort === 'halted' && hubOwner.signal.aborted, 'hub markers precede its real controller abort');
  scheduled.abort();   // cron lease phase, between owner/hub stops and final table stop
  A.eq(t.stopAll('estop'), 2, 'final table phase counts only the hop and API run untouched by the earlier kills');
  A.ok(signals.every(signal => signal.aborted), 'every joined signal is aborted, counted here or earlier');
  A.eq(t.stopAll('estop'), 0, 'a repeated final phase counts no fresh aborts');
  for (const lease of leases) lease.release();
  A.eq([t.stopOwners('estop'), t.stopAll('estop')], [0, 0], 'empty table has no owner attempts or fresh stops');
}

// ---- 1b. failures are isolated and reported by the table itself ----
const runTableSrc = (sidecarSourceFiles().find(f => f.rel === 'sidecar/run-table.js') || { text: '' }).text;
{
  const noted = [], t = RunTable.makeRunTable({ note: (tag, error) => noted.push([tag, error.message]) });
  const bad = t.admit({ runId: 'bad' }); bad.join();
  bad.entry.stopper.abort = () => { throw new Error('boom'); };
  const good = t.admit({ runId: 'good' }); const signal = good.join();
  A.eq(t.stopAll('fault'), 1, 'one throwing core stop never prevents the next run stopping and is not counted fresh');
  A.ok(signal.aborted, 'the next run really stopped');
  A.eq(noted, [['runtable.stop.fault', 'boom']], 'failure is recorded under its actual stop cause');
  bad.release(); good.release();
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
const ownersAt = halt.indexOf("runTable.stopOwners('estop')"), hubsAt = halt.indexOf('killAll(null,');
A.ok(ownersAt > 0 && hubsAt > ownersAt, 'registered owners stop before the hub marker/kill phase');
for (const earlier of ['killAll(null,', 'cronDriver.abortAllLeases()', 'nightshiftDriver.abortBeat()', 'loopDriver.abortAllLeases()']) {
  const i = halt.indexOf(earlier);
  A.ok(i > ownersAt && i < at, 'final table stop follows ' + earlier + ', so its fresh count excludes earlier stops');
}
A.ok(/tableAborted = runTable\.stopAll\('estop'\); \} catch \(e\) \{ failNote\('run-table\.estop', e\); \}/.test(halt), 'its count is kept, and a failed stop is noted');
A.ok(/halted: halted \+ phoneAborted \+ tableAborted,/.test(halt), 'and added to the halted total the E-STOP toast shows');

// ---- 4. the process-fault quiesce reaches them too, in its own containment ----
const quiesce = sidecarTopLevelFunction('quiesceForProcessFault');
A.ok(quiesce.length > 1000 && quiesce.length < 20000, 'one bounded quiesceForProcessFault');
A.ok(/contain\('run-table', \(\) => runTable\.stopAll\('fault'\)\);/.test(quiesce), 'the fault quiesce stops every run-table entry in its own containment');
const faultHubAt = quiesce.indexOf('killAll(null,');
A.ok(faultHubAt > 0 && quiesce.indexOf("contain('run-table'") > faultHubAt, 'after hub fault markers and their kill');

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
  // both routine-hop profiles read it (line-runner.js): the scheduled fire's advanceChain seam and RUN NOW's line (handleCronRun)
  const runNow = sidecarTopLevelFunction('handleCronRun');
  A.ok(/LineRunner\.profiles\.manual\(\{[\s\S]*stoppedSaid: hopStoppedSaid/.test(runNow), 'RUN NOW\'s line hop words its stop through hopStoppedSaid');
  const { readSidecarSource } = require('./helpers/source');
  // the module-level cron driver config (not a named function): sliced between its advanceChain and the boot reconcile
  // comment that follows it, both required and in one slice, so the lock is about that hop's profile alone
  const idx = readSidecarSource();
  const a = idx.indexOf('advanceChain: (o) => lineRunner.runLineJob({');
  const b = idx.indexOf('// A crash can land after markRun durably commits', a);
  A.ok(a > 0 && b > a, 'found the scheduled fire\'s advanceChain line');
  const fire = idx.slice(a, b);
  A.ok(/LineRunner\.profiles\.schedule\(\{[\s\S]*stoppedSaid: hopStoppedSaid/.test(fire) && !/'stopped by you'/.test(fire), 'the scheduled fire\'s hop words its stop through hopStoppedSaid');
}
// …and the ONE hop executor words a hop whose own run ended 'cancelled' with exactly what its profile's stoppedSaid answers
const { makeLineRunner, profiles } = require('../sidecar/routing/line-runner.js');
const cancelled = makeLineRunner({ runOnce: async o => { o.emit('agent.run.end', { runId: o.runId, reason: 'cancelled' }); } });
const routineSeams = { config: () => ({}), system: () => '', station: () => null, stoppedSaid: () => 'the station hit an internal fault and stopped this run', stoppedByYou: () => false };
Promise.all([profiles.schedule(routineSeams), profiles.manual(routineSeams)].map(p => cancelled.hopRunner(p)({ agentId: 'b', text: 'hand-off' }))).then(rs => {
  for (const r of rs) A.ok(r.error === 'the station hit an internal fault and stopped this run' && r.stopped === false, 'a routine hop the fault stopped says the fault, and is not "stopped by you": ' + JSON.stringify(r.error));
  A.report('estop-stop-handles.test');
}).catch(e => { console.error(e); process.exit(1); });
