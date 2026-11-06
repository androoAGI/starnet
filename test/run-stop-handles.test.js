/* node test/run-stop-handles.test.js — which runs a stop or a steer by id reaches (QA 2026-10-02 + review; run-table S3).
   Every run runOnce drives with its own id (routine fires, line hops, hubs, step tests, /v1) is stoppable and steerable by id
   (see test/cancel-host-run.e2e.test.js and test/run-registry-coverage.http.test.js for the live proof). Since run-table S3
   the stop is its run-table entry's, joined at admission. A DELEGATED worker is not: the subagent manager owns its stop
   (interrupt, cancelChildren) and it reads steering from its own buffer — a desk STEER by its id answered "Sent" and was
   never read, and a desk STOP bypassed the manager. */
'use strict';
const { sidecarFunctionSource } = require('./helpers/source');
const A = require('./_assert.js');
const RunTable = require('../sidecar/run-table.js');

// the rule, run: metaOf names a worker delegated, and join() gives it no stop (its signal comes back unchanged)
const t = RunTable.makeRunTable({ now: () => 0, note: () => {} });
const own = new AbortController();
const cases = [
  ['a background worker (its own steer)', { runId: 'bg', parentRunId: 'lead', steer: () => [] }, false],
  ['a foreground worker (a parent run)', { runId: 'fg', parentRunId: 'lead' }, false],
  ['a worker steered without a parent', { runId: 'st', steer: () => [] }, false],
  ['a hub run', { runId: 'hub', trigger: 'event', taskSource: 'telegram' }, true],
  ['a routine hop', { runId: 'hop', trigger: 'schedule' }, true],
  ['a /v1 run', { runId: 'v1', trigger: 'event', taskSource: 'api' }, true]
];
for (const [label, o, stoppable] of cases) {
  const m = RunTable.metaOf(o);
  A.eq(m.delegated, !stoppable, label + ': ' + (stoppable ? 'not delegated' : 'a delegated worker'));
  const sig = t.admit(m).join(own.signal);
  A.eq([sig !== own.signal, t.stoppable(o.runId)], [stoppable, stoppable], label + ': ' + (stoppable ? 'gets a stop, joined to its own signal' : 'gets no stop'));
}

// the host: runOnce joins every run at admission, and STOP / steer by id read the same reach
const once = sidecarFunctionSource('runOnce');
A.ok(once.includes('{ const joined = run.join(o.signal); if (joined !== o.signal) o.signal = joined; }'), 'runOnce joins every run it admits with its entry\'s stop');
A.ok(sidecarFunctionSource('runReachable').includes('runTable.stoppable(id)'), 'a stop or a steer by id reaches only the entry that owns its stop');
A.ok(sidecarFunctionSource('handleRunSteer').includes('steerBufs.post(runId, text, runReachable(runId), body.noteId, body.message)'), 'a steer is accepted only for a run that reads the shared buffer');
A.ok(sidecarFunctionSource('channelSteerRun').includes('steerBufs.post(id, text, runReachable(id))'), 'a channel follow-up joins a run by the same test');
A.ok(sidecarFunctionSource('stopRunById').includes('runTable.stop(id, cause)'), 'a stop by id goes through the entry\'s stop');
A.report('run-stop-handles');
