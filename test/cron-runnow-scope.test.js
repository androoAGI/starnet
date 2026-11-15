/* node test/cron-runnow-scope.test.js — a RUN NOW press keeps its idempotency scope through its retry (ops-1115 T1, W9).

   A press runs under routineRunIdentity(job, firedAt) (index.js handleCronRun), but its lease carried no `scope`, so
   finishFire handed markRun no idempotencyScope, the record kept no occurrenceScope, and when the press failed transiently
   the scheduler's retry minted a NEW scope from its own fire time: a connector write the press already made could be
   sent again. Now the lease names the press's scope, so the retry reuses it.

   The lease line is sliced out of the real handleCronRun (the outcome-roundtrip regex) and executed against the real
   driver and store. Red at 45e7ee302 (the lease has no scope: the retry's scope differs); green after. The expected scope
   is computed by routineRunIdentity itself, never hand-built ('cron:<id>:' + epoch ms, routine-identity.js). */
'use strict';
const A = require('./_assert.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');
const { routineRunIdentity } = require('../sidecar/routine-identity.js');
const { sidecarTopLevelFunction } = require('./helpers/source.js');

const T0 = 1700000000000, MIN = 60000;
const FIRED = T0 + 5 * MIN;   // the press's Date.now() in handleCronRun

const RUN_NOW_SRC = sidecarTopLevelFunction('handleCronRun');
const LINE = (/\n  cronDriver\.leases\.set\(job\.id, \{ runId: runId,[^\n]*\);/.exec(RUN_NOW_SRC) || [''])[0];
A.ok(/cronDriver\.leases\.set\(job\.id, \{ runId: runId,/.test(LINE), 'fixture: Run Now\'s lease line is sliced from handleCronRun');

function rig() {
  let clock = FIRED;
  const job0 = cronStore.makeJob({ id: 'rn', prompt: 'post the weekly update', agentId: 'agent', schedule: cron.parseSchedule('every 1d', T0) }, { id: 'rn', now: T0 });
  let store = [Object.assign({}, job0, { enabled: true, nextRunAt: new Date(T0 + 12 * 60 * MIN).toISOString() })];
  const fires = [];
  let n = 0;
  const driver = makeCronDriver({
    getJobs: () => store, setJobs: (j) => { store = j; return true; },
    runOnce: (o) => { fires.push(o); return new Promise(() => {}); },
    emit: () => {}, newId: () => 'fire-' + (++n), newAbort: () => new AbortController(), now: () => clock,
    getKey: () => 'sk', defaultModel: 'm', persona: 'P', maxRunMs: 8 * MIN, maxWallMs: 90 * MIN
  });
  const press = (runId) => {
    const job = cronStore.getJob(store, 'rn');
    const pressScope = routineRunIdentity(job, FIRED).idempotencyScope;   // what handleCronRun computes from its firedAt
    new Function('cronDriver', 'cronStore', 'job', 'runId', 'ac', 'pressScope', 'Date', LINE)(   // eslint-disable-line no-new-func
      driver, cronStore, job, runId, new AbortController(), pressScope, { now: () => clock });
    return pressScope;
  };
  return { driver, fires, press, getJob: () => cronStore.getJob(store, 'rn'), set: (ms) => { clock = ms; }, now: () => clock };
}

/* ---- RED: a press that fails transiently is retried under the press's own scope ---- */
{
  const r = rig();
  const want = r.press('press1');
  A.eq(want, routineRunIdentity(r.getJob(), FIRED).idempotencyScope, 'the press runs under routineRunIdentity(job, firedAt)');
  r.set(FIRED + 2 * MIN);
  r.driver.settleRun('rn', 'press1', { buf: '', errMsg: 'rate limited (429)', reason: 'error', transient: true, usd: 0.02, toolsRan: 2 }, null);
  const j = r.getJob();
  A.eq(j.retryCount, 1, 'the transient press is retried by the schedule');
  A.eq(j.occurrenceScope, want, 'the record keeps the press\'s scope for its retry');
  r.set(Date.parse(j.nextRunAt));
  const t = r.driver.applyTick(r.now());
  A.eq(t.fired, 1, 'the retry fires');
  A.eq(r.fires.length ? r.fires[0].idempotencyScope : '(no fire)', want, 'the retry reuses the press\'s idempotency scope, so a write it already made is not sent again');
}

/* ---- LIVENESS: after a clean ok settle, the next scheduled occurrence mints its own scope ---- */
{
  const r = rig();
  const pressed = r.press('press2');
  r.set(FIRED + MIN);
  r.driver.settleRun('rn', 'press2', { buf: 'posted', reason: 'done', end: { reason: 'done', outcome: 'succeeded' }, usd: 0.01, toolsRan: 1 }, null);
  const j = r.getJob();
  A.eq(j.lastStatus, 'ok', 'liveness: the press settled ok');
  A.eq(j.occurrenceScope == null, true, 'liveness: an ok press leaves no occurrence scope behind');
  const due = Date.parse(j.nextRunAt);
  r.set(due);
  r.driver.applyTick(r.now());
  A.eq(r.fires.length, 1, 'liveness: the next occurrence fires');
  const scope = r.fires.length ? r.fires[0].idempotencyScope : '';
  A.ok(scope !== pressed && scope.indexOf('cron:rn:') === 0, 'liveness: the next occurrence has its own scope: ' + scope);
}

/* ---- LIVENESS: a scheduled fire's retry still reuses its first fire's scope (GHSA-2hpj #9, unchanged) ---- */
{
  const r = rig();
  const due = Date.parse(r.getJob().nextRunAt);
  r.set(due);
  r.driver.applyTick(r.now());
  A.eq(r.fires.length, 1, 'liveness: the scheduled occurrence fired');
  const first = r.fires[0];
  r.set(due + MIN);
  r.driver.settleRun('rn', first.runId, { buf: '', errMsg: 'rate limited (429)', reason: 'error', transient: true, usd: 0 }, null);
  r.set(Date.parse(r.getJob().nextRunAt));
  r.driver.applyTick(r.now());
  A.eq(r.fires.length, 2, 'liveness: its retry fired');
  A.eq(r.fires[1].idempotencyScope, first.idempotencyScope, 'liveness: the scheduled retry keeps its first fire\'s scope');
}

A.report('cron-runnow-scope');
