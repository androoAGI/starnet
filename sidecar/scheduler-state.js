/* One projection of the scheduler's authority. Stored nextRunAt is schedule data; nextFireAt is what may
   actually fire while the current scheduler state stands. Pure: the host supplies all state and jobs. */
'use strict';

function holdOf(state) {
  if (state && state.halted === true) return 'halted';
  if (!state || state.enabled !== true) return 'off';
  if (state.degraded) return 'degraded';
  return null;
}

function nextFireOf(state, job) {
  if (holdOf(state) || !job || job.enabled === false) return null;
  const at = job.nextRunAt;
  return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null;
}

function schedulerState(input) {
  const source = input || {};
  const state = { enabled: source.enabled === true, halted: source.halted === true,
    degraded: !!source.degraded, held: null, nextFireAt: null };
  state.held = holdOf(state);
  for (const job of Array.isArray(source.jobs) ? source.jobs : []) {
    const at = nextFireOf(state, job);
    if (at && (!state.nextFireAt || Date.parse(at) < Date.parse(state.nextFireAt))) state.nextFireAt = at;
  }
  return state;
}

module.exports = { schedulerState, nextFireOf, holdOf };
