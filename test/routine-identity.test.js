/* node test/routine-identity.test.js — Run Now IS the scheduled fire pressed by hand: same recipe provenance, same idempotency
   scope shape, same command rule (quick win 31). sidecar/routine-identity.js holds each once; both fire paths use it.

   Proves: (A) the helpers; (B) the scheduled fire (the REAL cron driver) hands runOnce the identity — the control the Run Now
   path is held to; (C) Run Now (index.js handleCronRun) and the scheduled command redirect (the cron runOnce wrapper) use the
   same helpers — each lock slices the one function or literal it is about. */
'use strict';
const A = require('./_assert.js');
const { routineRunIdentity, runsAsCommand } = require('../sidecar/routine-identity.js');
const { sidecarTopLevelFunction, readSidecarSource, sidecarSourceFiles } = require('./helpers/source.js');

// ---- A. the helpers ----
{
  const id = routineRunIdentity({ id: 'j1', name: 'brief', meta: { recipeId: 'rec_9' } }, 1700000000000);
  A.eq(id, { cronJobId: 'j1', cronJobName: 'brief', idempotencyScope: 'cron:j1:1700000000000', recipeId: 'rec_9' }, 'identity = job id + name + fire-time scope + recipe');
  A.eq(routineRunIdentity({ id: 'j2' }, 5).recipeId, undefined, 'a plain routine carries no recipeId');
  A.ok(routineRunIdentity({ id: 'j2' }, 5).idempotencyScope !== routineRunIdentity({ id: 'j2' }, 6).idempotencyScope, 'two fires of one routine are two scopes');
  A.eq(runsAsCommand('/usage', null), true, 'a slash prompt runs the command');
  A.eq(runsAsCommand('/usage', 'echo hi'), false, '…unless the routine carries a pre-check script (the scheduled rule)');
  A.eq(runsAsCommand('summarise /var/log', null), false, 'a prompt that merely contains a slash is a model turn');
}

// ---- B. the scheduled fire hands runOnce the identity (the REAL driver) ----
{
  const cron = require('../sidecar/cron.js');
  const cronStore = require('../sidecar/cron-store.js');
  const { makeCronDriver } = require('../sidecar/cron-driver.js');
  const T0 = 1700000000000;
  let now = T0;
  let store = [cronStore.makeJob({ id: 'j1', prompt: 'do it', agentId: 'agent', schedule: cron.parseSchedule('every 1m', T0), meta: { recipeId: 'rec_9' } }, { id: 'j1', now: T0 })];
  const runs = [];
  const driver = makeCronDriver({
    getJobs: () => store, setJobs: (j) => { store = j; return true; },
    runOnce: (o) => new Promise(() => { runs.push(o); }),
    emit: () => {}, newId: () => 'run-1', newAbort: () => new AbortController(), now: () => now,
    getKey: () => 'k', defaultModel: 'm', persona: 'P', maxRunMs: 480000
  });
  now = T0 + 60000;
  driver.applyTick(now);
  A.eq(runs.length, 1, 'fixture: the routine fired');
  A.eq(runs[0].recipeId, 'rec_9', 'the scheduled run carries the recipe');
  A.ok(/^cron:j1:\d+$/.test(runs[0].idempotencyScope || ''), 'and a job + fire-time idempotency scope (' + runs[0].idempotencyScope + ')');
  A.eq([runs[0].cronJobId, runs[0].cronJobName], ['j1', ''], 'and the routine identity');
  const driverSrc = sidecarSourceFiles().find(f => f.rel === 'sidecar/cron-driver.js').text;
  const fire = driverSrc.slice(driverSrc.indexOf('function fireJob('), driverSrc.indexOf('function applyTick('));
  A.ok(/\.\.\.routineRunIdentity\(job, scheduledFor\)/.test(fire), 'the driver takes the identity from the shared helper');
}

// ---- C. Run Now and the scheduled command redirect use the same helpers ----
{
  const runNow = sidecarTopLevelFunction('handleCronRun');
  A.ok(runNow.length > 2000, 'fixture: handleCronRun is sliced');
  const stageOne = runNow.slice(runNow.indexOf('await runOnce({'), runNow.indexOf('chainRunner.advance('));
  A.ok(/\.\.\.routineRunIdentity\(job, firedAt\)/.test(stageOne), 'Run Now\'s run carries the same identity: recipe + scope + routine id');
  A.ok(/if \(runsAsCommand\(assembledPrompt, job\.script\)\)/.test(runNow), 'Run Now applies the scheduled command rule (a script routine is a model run)');
  A.ok(!/if \(assembledPrompt\.charAt\(0\) === '\/'\)/.test(runNow), 'and no longer its own looser one');
  const src = readSidecarSource();
  const at = src.indexOf('const cronDriver = makeCronDriver({');
  const wrapper = src.slice(src.indexOf('runOnce: (opts) => {', at), src.indexOf('// TRUTHFUL SNAPSHOT: register the scheduled run', at));
  A.ok(/runsAsCommand\(first, opts\.cronScript\)/.test(wrapper), 'the scheduled command redirect is the same rule');
}

A.report('routine-identity.test');
