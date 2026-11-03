/* A sample reads the shared line-job verdict: preserve the walk's own stop, even when every existing row says done. */
'use strict';
const A = require('./_assert.js');
const { outcomeOf } = require('../sidecar/routing/line-runner.js');
const { sidecarTopLevelFunction } = require('./helpers/source.js');
const done = [{ runId: 'r1', reason: 'done', outcome: 'succeeded' }];

for (const stop of [
  { code: 'stage_failed', why: 'editor failed: provider 500' },
  { code: 'hop_limit', why: 'the line ran past its hop ceiling' },
  { code: 'day_limit', why: 'the line reached its $1.00 daily limit' },
  { code: 'blocked', why: 'the reviewer held this work' }
]) {
  const result = outcomeOf({ runs: done, line: { stop, outboxId: 'outbox' } });
  A.eq(result.error, stop.why, stop.code + ': preserves the exact line stop words');
  A.ok(!result.delivered, stop.code + ': existing successful rows cannot override the stop');
}
A.eq(outcomeOf({ stopped: true, runs: done }).outcome, 'stopped', 'a Commander stop is its own outcome');
const fault = outcomeOf({ stopCause: 'fault', runs: done });
A.ok(fault.stop.code === 'station_fault' && /station hit an internal fault/.test(fault.error), 'a station fault never blames the Commander');
A.eq(outcomeOf({ onLine: false, runs: done }).stop.code, 'wrong_line', 'a sample that missed its named line says so');
A.eq(outcomeOf({ runs: done, line: { partial: 'writer failed' } }).stop.code, 'partial_join', 'a missing join branch is not a complete job');
A.eq(outcomeOf({ runs: [], refusedSaid: 'no model is configured' }).error, 'no model is configured', 'a refusal before a run retains the admission words');
A.eq(outcomeOf({ runs: [] }).stop.code, 'stage_incomplete', 'missing durable terminal evidence cannot be called delivered');
A.eq(outcomeOf({ runs: done, line: {} }).stop.code, 'no_outbox', 'successful stages at a dead end did not deliver a line job');
const body = sidecarTopLevelFunction('runSampleJob');
A.ok(body.includes('sampleInFlight.result || lineRunner.settle(') && body.includes('outcome: result.outcome, stop: result.stop'), 'sample response uses its shared job result and exposes the same typed stop');
A.ok(!body.includes('LineJobs.finish(') && !body.includes('chainShipsToOutbox('), 'sample has no second finish or current-floor delivery guess');
A.report('sample-verdict.test');
