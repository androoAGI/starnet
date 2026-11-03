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
  const stageOne = runNow.slice(runNow.indexOf('await runOnce({'), runNow.indexOf('lineRunner.runLineJob('));
  A.ok(stageOne.length > 500 && /\.\.\.routineRunIdentity\(job, firedAt\)/.test(stageOne), 'Run Now\'s run carries the same identity: recipe + scope + routine id');
  A.ok(/if \(runsAsCommand\(assembledPrompt, job\.script\)\)/.test(runNow), 'Run Now applies the scheduled command rule (a script routine is a model run)');
  A.ok(!/if \(assembledPrompt\.charAt\(0\) === '\/'\)/.test(runNow), 'and no longer its own looser one');
  const src = readSidecarSource();
  const at = src.indexOf('const cronDriver = makeCronDriver({');
  const wrapper = src.slice(src.indexOf('runOnce: (opts) => {', at), src.indexOf('// TRUTHFUL SNAPSHOT: register the scheduled run', at));
  A.ok(/runsAsCommand\(first, opts\.cronScript\)/.test(wrapper), 'the scheduled command redirect is the same rule');
}

// ---- D. Run Now says it was PRESSED (trigger 'manual', run-wire-resolver lane) and still runs the routine's unattended path ----
{
  const { isRoutineTrigger } = require('../sidecar/routine-identity.js');
  A.eq(['schedule', 'manual', 'directive', 'event', 'loop', 'nightshift', '', undefined].map(isRoutineTrigger),
    [true, true, false, false, false, false, false, false], "a routine's run is the clock's ('schedule') or a Run Now press ('manual'), nothing else");
  const runNow = sidecarTopLevelFunction('handleCronRun');
  const stageOne = runNow.slice(runNow.indexOf('await runOnce({'), runNow.indexOf('lineRunner.runLineJob('));
  // (its line hops: the one hop executor's manual profile, trigger 'manual' by construction — driven in test/line-runner.test.js)
  A.ok(/surface: 'autonomous', trigger: 'manual'/.test(stageOne) && /LineRunner\.profiles\.manual\(\{/.test(runNow) && !/trigger: 'schedule'/.test(runNow), "Run Now's run, its line hops and its command path are labelled 'manual', never 'schedule'");
  A.ok(/runSlashRoutine\(assembledPrompt, \{[^}]*trigger: 'manual' \}\)/.test(runNow), "...its command routine's run.start too");
  A.ok(/unattendedGrants: Array\.isArray\(job\.unattendedGrants\)/.test(stageOne), '...on the same unattended posture and grants as the scheduled fire');
  // every routine-only rule asks isRoutineTrigger, so a 'manual' run keeps routine.notepad, the widget grant, the images hint
  // and its routine history row (cronJobId) — while the clock-driven paths still say 'schedule'
  const core = sidecarTopLevelFunction('runOnceCore');
  A.ok(core.length > 10000 && !/trigger === 'schedule'/.test(core), 'runOnceCore has no schedule-only routine rule left');
  // (authority-census: the withheld-routine remedy and the routine-run availability fact moved into the run's projection)
  const projection = sidecarSourceFiles().find(f => f.rel === 'sidecar/capability/project-tools.js');
  const routineRules = (core.match(/isRoutineTrigger\(trigger\)/g) || []).length + ((projection && projection.text.match(/isRoutineTrigger\(trigger\)/g)) || []).length;
  A.ok(routineRules >= 8 && !/trigger === 'schedule'/.test((projection && projection.text) || ''), 'every routine rule in runOnceCore and its tool projection reads isRoutineTrigger');
  const driver = require('fs').readFileSync(require('path').join(__dirname, '..', 'sidecar', 'cron-driver.js'), 'utf8');
  A.ok(/trigger: 'schedule', provider: provider/.test(driver), "the scheduled tick still says 'schedule'");
  const memcore = require('../sidecar/memcore.js');
  const originOf = memcore.originOf || (memcore._internals && memcore._internals.originOf);
  if (typeof originOf === 'function') A.eq(originOf({ trigger: 'manual' }), 'schedule', "a Run Now's memory is stamped origin schedule, like the fire it is");
  else A.ok(/trigger === 'schedule' \|\| trigger === 'manual'\) return 'schedule'/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'sidecar', 'memcore.js'), 'utf8')), "a Run Now's memory is stamped origin schedule, like the fire it is");
}

A.report('routine-identity.test');
