'use strict';
const A = require('./_assert.js');
const { schedulerState, nextFireOf, holdOf } = require('../sidecar/scheduler-state.js');

const EARLY = '2026-01-01T10:00:00.000Z', LATE = '2026-01-01T11:00:00.000Z';
for (const enabled of [false, true]) for (const halted of [false, true]) for (const degraded of [false, true]) {
  for (const jobEnabled of [false, true]) {
    const job = { id: 'routine', enabled: jobEnabled, nextRunAt: EARLY };
    const state = schedulerState({ enabled, halted, degraded, jobs: [job] });
    const expected = enabled && !halted && !degraded && jobEnabled ? EARLY : null;
    const label = JSON.stringify({ enabled, halted, degraded, jobEnabled });
    A.eq([state.nextFireAt, nextFireOf(state, job)], [expected, expected], label + ': aggregate and individual clocks share authority');
    A.eq([state.enabled, state.halted, state.degraded], [enabled, halted, degraded], label + ': intent, halt and damage stay distinct');
    A.eq(job.nextRunAt, EARLY, label + ': projection never rewrites the stored schedule');
  }
}
const jobs = [null, { enabled: true, nextRunAt: 'invalid' }, { enabled: false, nextRunAt: '2020-01-01T00:00:00Z' },
  { id: 'later', enabled: true, nextRunAt: LATE }, { id: 'earlier', enabled: true, nextRunAt: EARLY }];
A.eq(schedulerState({ enabled: true, jobs }).nextFireAt, EARLY, 'the soonest eligible fire wins regardless of job order');
A.eq(schedulerState({ enabled: true, jobs: jobs.slice().reverse() }).nextFireAt, EARLY, 'reversed rows have the same clock');
A.eq(schedulerState({ enabled: true, jobs: [] }).nextFireAt, null, 'an empty scheduler has no next fire');
A.eq(schedulerState({}).nextFireAt, null, 'missing scheduler state supplies no fire authority');
A.eq(nextFireOf({ enabled: true }, { nextRunAt: EARLY }), EARLY, 'legacy jobs lacking an enabled field retain their default');
A.eq(holdOf({ enabled: true, halted: true, degraded: true }), 'halted', 'E-STOP remains explicit even alongside degraded storage');
A.eq(holdOf({ enabled: false, degraded: true }), 'off', 'the off switch remains explicit alongside degraded storage');
A.eq(holdOf({ enabled: true, degraded: true }), 'degraded', 'an armed but degraded scheduler cannot promise a fire');
A.report('scheduler-state.test');
