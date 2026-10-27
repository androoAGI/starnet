/* sidecar/routing/sample-verdict.js — WHY a sample job (RUN ONE REAL JOB / SEND IT A JOB / station.test_line) did not reach
   its OUTBOX, in words, for the job's record and for the route's answer (quick win 26).

   The route knew the line's own stop reason (the hub's line outcome: "editor failed: provider 500", "the line's $1.00
   ceiling was reached before writer", "the line ran past its hop ceiling") and said "a step did not finish cleanly"
   instead — the Commander, the FINISH card and the lead's station.test_line all got the vaguest sentence while the
   precise one sat in sampleLineOutcome.stopped. The order below is the route's own, with the line's reason said before
   the generic one. The Commander's own STOP ('stopped') is never re-said as a line failure: the stop branch says it.

     sampleProblem({ stoppedByUser, stopCause, onLine, line, partial, runs, lineStopped, refusedSaid, firstWarn })
       -> { jobError, routeError }   (both '' never: a call is made only for a job that did not complete) */
'use strict';

function sampleProblem(o) {
  const s = o || {};
  const runs = Array.isArray(s.runs) ? s.runs : [];
  const everyDone = runs.every(r => r && r.reason === 'done');   // (vacuously true with no rows — the job record's rule)
  const partial = s.partial ? String(s.partial) : '';
  const stopped = s.lineStopped && String(s.lineStopped) !== 'stopped' ? String(s.lineStopped).slice(0, 400) : '';
  const nothingRan = String(s.refusedSaid || s.firstWarn || '');
  // the job's record
  let jobError;
  if (s.stoppedByUser) jobError = s.stopCause === 'fault' ? 'the station hit an internal fault and stopped this job' : 'you stopped this job';
  else if (!s.onLine) jobError = 'the job did not enter through this line';
  else if (partial && everyDone) jobError = 'the joiner sent on without every branch (' + partial + ')';
  else if (runs.length) jobError = stopped ? 'the line stopped early: ' + stopped : 'a step did not finish cleanly';
  else jobError = nothingRan || 'no step ran';
  // the route's answer
  let routeError;
  if (s.stoppedByUser) routeError = 'stopped — you stopped this job before it reached the OUTBOX';
  else if (!s.onLine) routeError = 'sample job did not enter through line "' + String(s.line || '') + '"';
  else if (partial && runs.length && everyDone) routeError = 'sample job came out of its joiner partial (' + partial + ')';
  else if (runs.length) routeError = stopped ? 'sample job stopped early: ' + stopped : 'sample job did not complete cleanly';
  else routeError = nothingRan || 'sample job produced no durable run outcome';
  return { jobError, routeError };
}

module.exports = { sampleProblem };
