/* node test/sample-verdict.test.js — a sample job that did not reach its OUTBOX says the LINE's own reason (quick win 26).

   The sample route (RUN ONE REAL JOB / SEND IT A JOB / station.test_line) held the hub's line outcome — "editor failed:
   provider 500", "the line ran past its hop ceiling" — and answered "a step did not finish cleanly" / "sample job did not
   complete cleanly" over it. sidecar/routing/sample-verdict.js now picks the words, the line's reason before the generic
   one, and runSampleJob (index.js) asks it for both the job record and the route answer. */
'use strict';
const A = require('./_assert.js');
const { sampleProblem } = require('../sidecar/routing/sample-verdict.js');
const { sidecarTopLevelFunction } = require('./helpers/source.js');

const done = (n) => Array.from({ length: n }, (_, i) => ({ runId: 'r' + i, reason: 'done' }));

// ---- A. the line's own stop reason is said, before the generic sentence ----
{
  const p = sampleProblem({ onLine: true, runs: done(2), lineStopped: 'editor failed: provider 500' });
  A.eq(p.jobError, 'the line stopped early: editor failed: provider 500', 'the job record names the line\'s real stop reason');
  A.eq(p.routeError, 'sample job stopped early: editor failed: provider 500', 'and so does the route answer');
  const ceiling = sampleProblem({ onLine: true, runs: done(3), lineStopped: 'the line ran past its hop ceiling' });
  A.ok(/hop ceiling/.test(ceiling.jobError) && /hop ceiling/.test(ceiling.routeError), 'a ceiling stop with every row "done" is named, not called unclean');
}

// ---- B. the order of the old verdict is unchanged around it ----
{
  A.eq(sampleProblem({ onLine: true, runs: [{ reason: 'error' }] }).jobError, 'a step did not finish cleanly', 'no line reason: the generic sentence stands');
  A.eq(sampleProblem({ onLine: true, runs: [{ reason: 'error' }] }).routeError, 'sample job did not complete cleanly', '...on the route too');
  A.eq(sampleProblem({ stoppedByUser: true, onLine: true, runs: done(1), lineStopped: 'stopped' }).jobError, 'you stopped this job', 'the Commander\'s STOP is said as a stop');
  A.eq(sampleProblem({ stoppedByUser: true, stopCause: 'fault', onLine: true, runs: done(1) }).jobError, 'the station hit an internal fault and stopped this job', 'a fault stop is said as the fault');
  A.eq(sampleProblem({ onLine: true, runs: done(1), lineStopped: 'stopped' }).jobError, 'a step did not finish cleanly', 'a bare abort ("stopped") is never re-said as "the line stopped early: stopped"');
  A.eq(sampleProblem({ onLine: false, line: 'L1', runs: done(1), lineStopped: 'x failed' }).routeError, 'sample job did not enter through line "L1"', 'a job that missed its line says so first');
  A.eq(sampleProblem({ onLine: true, runs: done(2), partial: 'writer failed', lineStopped: 'y' }).jobError, 'the joiner sent on without every branch (writer failed)', 'a partial join is still said as partial');
  A.eq(sampleProblem({ onLine: true, runs: [], refusedSaid: 'the line reached its $1.00 daily limit' }).routeError, 'the line reached its $1.00 daily limit', 'a refusal before any step ran is the hub\'s own words');
  A.eq(sampleProblem({ onLine: true, runs: [] }).routeError, 'sample job produced no durable run outcome', 'nothing ran and nothing said: the old words');
  A.eq(sampleProblem({ onLine: true, runs: [] }).jobError, 'no step ran', '...and on the record');
}

// ---- C. runSampleJob asks it (sliced: the one function this is about) ----
{
  const body = sidecarTopLevelFunction('runSampleJob');
  A.ok(body.length > 2000, 'fixture: runSampleJob is sliced');
  A.ok(/sampleProblem\(\{[^}]*lineStopped: sampleLineOutcome && sampleLineOutcome\.stopped/.test(body), 'runSampleJob hands the hub\'s line stop reason to sampleProblem');
  A.ok(!/'a step did not finish cleanly'/.test(body) && !/'sample job did not complete cleanly'/.test(body), 'and no longer writes the generic sentence itself');
}

A.report('sample-verdict.test');
