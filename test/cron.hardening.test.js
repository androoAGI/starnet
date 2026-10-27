/* node test/cron.hardening.test.js — routine reliability hardening (2026-08-21), four properties:
     1. CONSECUTIVE-FAILURE AUTO-PAUSE: a recurring job that fails terminally N times in a row (default 5,
        ctx/host-overridable) is disabled with disabledReason:'consecutive-failures'; the counter is durable,
        resets on ok/silent, and resumeJob clears it. The delivery text tells the Commander it was paused.
     3. MALFORMED-SCHEDULE VISIBILITY: a job whose schedule can never fire is marked ONCE (lastError
        'schedule-unfireable', lastStatus 'error') and emits ONE cron.result — never re-marked per tick.
     4. INTERVAL DRIFT: an in-grace interval fire advances from the SCHEDULED instant (dueAt + period), not the
        tick instant, so an hourly routine never walks later by a tick per fire; stale-catch-up semantics intact.
   (2. EMPTY-STORE FAIL-LOUD is a boot-level property — see test/cron.degraded.e2e.test.js.)
   Pure: fake clock, fake runOnce, in-memory store. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const { makeClock } = require('../shared/clock-rng.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');

const T0 = 1700000000000;
const MIN = 60000;
const flush = () => new Promise(r => setImmediate(r));

function setup(jobs, runOnceFake, opts) {
  opts = opts || {};
  const clock = makeClock(opts.t0 || T0);
  let store = (jobs || []).slice();
  const events = [], runs = [], deliveries = [];
  let idN = 0;
  const driver = makeCronDriver({
    getJobs: () => store,
    setJobs: (j) => { store = j; return true; },
    runOnce: (o) => { runs.push(o); return Promise.resolve(runOnceFake ? runOnceFake(o) : undefined); },
    emit: (name, payload) => { events.push({ name, payload }); },
    placeWorkitem: () => {},
    newId: () => 'run-' + (++idN),
    newAbort: () => new AbortController(),
    now: () => clock.now(),
    getKey: () => 'sk-test',
    deliverResult: (job, result) => { deliveries.push({ job, result }); return { ok: true }; },
    defaultModel: 'test/model',
    persona: 'PERSONA',
    maxRunMs: 480000,
    maxConsecutiveFailures: opts.maxConsecutiveFailures
  });
  return { driver, clock, events, runs, deliveries, getJobs: () => store, getJob: (id) => cronStore.getJob(store, id),
    setStore: (j) => { store = j; } };
}
const countOf = (events, name) => events.filter(e => e.name === name).length;
const lastOf = (events, name) => { const l = events.filter(e => e.name === name); return l.length ? l[l.length - 1].payload : undefined; };

function intervalJob(id, everyStr) {
  const schedule = cron.parseSchedule(everyStr, T0);
  return cronStore.makeJob({ id, prompt: 'do ' + id, agentId: 'cron_' + id, schedule }, { id, now: T0 });
}
const okRun = (o) => { o.emit('agent.token', { delta: 'fine' }); o.emit('agent.run.end', { agentId: 'a', runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
const failRun = (o) => { o.emit('agent.run.error', { agentId: 'a', runId: o.runId, message: 'boom', transient: false }); o.emit('agent.run.end', { agentId: 'a', runId: o.runId, reason: 'error', turns: 1, usd: 0 }); };

(async function () {

  // ---- 1. consecutive-failure auto-pause (store-level, pure reducer) ----
  {
    let jobs = [intervalJob('f1', 'every 1h')];
    const ctx = (n) => ({ now: T0 + n * 3600000, maxConsecutiveFailures: 3 });
    jobs = cronStore.markRun(jobs, 'f1', { runId: 'r1', status: 'error', error: 'e1', transient: false }, ctx(1));
    A.eq(cronStore.getJob(jobs, 'f1').consecutiveFailures, 1, 'first terminal failure -> consecutiveFailures 1');
    A.eq(cronStore.getJob(jobs, 'f1').enabled, true, 'still enabled after 1 failure');
    jobs = cronStore.markRun(jobs, 'f1', { runId: 'r2', status: 'error', error: 'e2', transient: false }, ctx(2));
    jobs = cronStore.markRun(jobs, 'f1', { runId: 'r3', status: 'ok', output: 'recovered' }, ctx(3));
    A.eq(cronStore.getJob(jobs, 'f1').consecutiveFailures, 0, 'an ok settlement RESETS the streak');
    for (let i = 4; i <= 6; i++) jobs = cronStore.markRun(jobs, 'f1', { runId: 'r' + i, status: 'error', error: 'e' + i, transient: false }, ctx(i));
    const paused = cronStore.getJob(jobs, 'f1');
    A.eq(paused.consecutiveFailures, 3, 'three failures in a row counted');
    A.eq(paused.enabled, false, 'at the ceiling the recurring job is DISABLED (no longer re-armed forever)');
    A.eq(paused.disabledReason, 'consecutive-failures', 'governed disabledReason');
    A.ok(paused.disabledAt, 'disabledAt stamped');
    A.eq(paused.nextRunAt, null, 'no next fire while auto-paused');
    A.eq(paused.state, 'error', 'state stays error (visible)');
    A.ok(/Routine paused after 3 consecutive failures/.test(paused.finalization.error), 'the finalization (delivery) text tells the Commander it was paused');
    A.ok(/e6/.test(paused.finalization.error), 'the delivery text still carries the underlying error');
    // a transient failure with retries left does NOT count (the occurrence isn't finalized)
    let t = [intervalJob('t1', 'every 1h')];
    t = cronStore.markRun(t, 't1', { runId: 'x', status: 'error', error: 'flaky', transient: true }, { now: T0 + 1 });
    A.eq(cronStore.getJob(t, 't1').consecutiveFailures, undefined, 'a transient backoff does not count toward the streak');
    // resume clears the streak + reason
    jobs = cronStore.resumeJob(jobs, 'f1', { now: T0 + 7 * 3600000 });
    const resumed = cronStore.getJob(jobs, 'f1');
    A.eq(resumed.enabled, true, 'resume re-enables');
    A.eq(resumed.consecutiveFailures, 0, 'resume clears the counter');
    A.eq(resumed.disabledReason, null, 'resume clears disabledReason');
    A.ok(resumed.nextRunAt, 'resume re-arms');
    // ceiling 0 = never auto-pause
    let z = [intervalJob('z1', 'every 1h')];
    for (let i = 1; i <= 8; i++) z = cronStore.markRun(z, 'z1', { runId: 'r' + i, status: 'error', error: 'e', transient: false }, { now: T0 + i * 3600000, maxConsecutiveFailures: 0 });
    A.eq(cronStore.getJob(z, 'z1').enabled, true, 'maxConsecutiveFailures:0 disables the ceiling');
    // default ceiling is 5
    let d = [intervalJob('d1', 'every 1h')];
    for (let i = 1; i <= 4; i++) d = cronStore.markRun(d, 'd1', { runId: 'r' + i, status: 'error', error: 'e', transient: false }, { now: T0 + i * 3600000 });
    A.eq(cronStore.getJob(d, 'd1').enabled, true, 'default: still enabled after 4');
    d = cronStore.markRun(d, 'd1', { runId: 'r5', status: 'error', error: 'e', transient: false }, { now: T0 + 5 * 3600000 });
    A.eq(cronStore.getJob(d, 'd1').enabled, false, 'default ceiling is 5 (cronStore.DEFAULT_MAX_CONSECUTIVE_FAILURES)');
    A.eq(cronStore.DEFAULT_MAX_CONSECUTIVE_FAILURES, 5, 'exported default = 5');
  }

  // ---- 1b. through the driver: the cron.result reason says it paused; delivery carries the pause text ----
  {
    const s = setup([intervalJob('g1', 'every 1h')], failRun, { maxConsecutiveFailures: 2 });
    for (let i = 1; i <= 2; i++) {
      // the store re-arms one period after the failed fire; step the clock onto each next fire instant
      const due = Date.parse(s.getJob('g1').nextRunAt);
      s.clock.set(due);
      s.driver.applyTick(s.clock.now());
      await flush();
    }
    A.eq(s.runs.length, 2, 'two fires attempted');
    const g = s.getJob('g1');
    A.eq(g.enabled, false, 'driver path: paused after 2 terminal failures');
    A.eq(g.disabledReason, 'consecutive-failures', 'driver path: governed reason');
    const last = lastOf(s.events, 'cron.result');
    A.eq(last.outcome, 'failed', 'last cron.result is failed');
    A.ok(/paused: consecutive-failures x2/.test(last.reason), 'cron.result reason announces the auto-pause: ' + last.reason);
    A.eq(s.deliveries.length, 2, 'both failures were delivered through deliverResult');
    A.ok(/Routine paused after 2 consecutive failures/.test(s.deliveries[1].result.error), 'the delivered error text says the routine was paused');
    // a subsequent tick does nothing with the paused job (no fire, no re-arm)
    s.clock.set(s.clock.now() + 3600000 * 3);
    s.driver.applyTick(s.clock.now());
    await flush();
    A.eq(s.runs.length, 2, 'a paused routine never fires again until re-enabled');
  }

  // ---- 3. malformed schedule: marked once, one event, never re-marked ----
  {
    const bad = cronStore.makeJob({ id: 'm1', prompt: 'x', agentId: 'cron_m1', schedule: { kind: 'lunar', display: '??' } }, { id: 'm1', now: T0 });
    const good = intervalJob('m2', 'every 1m');
    const s = setup([bad, good], okRun);
    s.driver.applyTick(s.clock.now());
    await flush();
    let m = s.getJob('m1');
    A.eq(m.lastError, 'schedule-unfireable', 'unfireable schedule marked with lastError schedule-unfireable');
    A.eq(m.lastStatus, 'error', 'lastStatus error');
    A.eq(m.state, 'error', 'state error (visible on the panel)');
    A.eq(m.enabled, true, 'not disabled — the user decides; it is just visible now');
    A.eq(countOf(s.events, 'cron.result'), 1, 'exactly one cron.result emitted for the mark');
    A.eq(lastOf(s.events, 'cron.result').reason, 'schedule-unfireable', 'reason = schedule-unfireable');
    const markedAt = m.lastErrorAt;
    for (let i = 1; i <= 3; i++) { s.clock.set(T0 + i * MIN); s.driver.applyTick(s.clock.now()); await flush(); }
    m = s.getJob('m1');
    A.eq(m.lastErrorAt, markedAt, 'NOT re-marked on later ticks');
    A.eq(s.events.filter(e => e.name === 'cron.result' && e.payload.jobId === 'm1').length, 1, 'NOT re-emitted on later ticks');
    A.ok(s.runs.length >= 1, 'the healthy sibling still fired');
    // a disabled unfireable job is left alone
    const off = cronStore.makeJob({ id: 'm3', prompt: 'x', agentId: 'a', schedule: { kind: 'nope' }, enabled: false }, { id: 'm3', now: T0 });
    const s2 = setup([off], okRun);
    s2.driver.applyTick(T0);
    A.eq(s2.getJob('m3').lastError, null, 'a disabled unfireable job is not marked (no noise for a paused job)');
    // reducer idempotence: same reference when already marked
    const once = cronStore.markUnfireable([bad], 'm1', { now: T0 });
    A.eq(cronStore.markUnfireable(once, 'm1', { now: T0 + 1 }) === once, true, 'markUnfireable returns the same array when already marked');
  }

  // ---- 4. interval drift: the advance anchors on the SCHEDULED instant ----
  {
    const j = intervalJob('h1', 'every 1h');                   // nextRunAt = T0 + 1h
    const due = T0 + 3600000;
    const late = due + 37000;                                  // noticed 37s late (inside grace)
    const plan = cron.planTick([j], late);
    A.eq(plan.fire.length, 1, 'in-grace fire');
    A.eq(plan.fire[0].scheduledFor, due, 'scheduledFor is the scheduled instant');
    A.eq(plan.next[0].nextAt, due + 3600000, 'next fire = scheduled + period (NOT tick instant + period)');
    // over many late ticks the fire instants stay on the hour grid
    let jobs = [j];
    const fires = [];
    for (let k = 1; k <= 5; k++) {
      const nowMs = T0 + k * 3600000 + 40000 + k * 7000;        // each tick lands 40–75s late
      const p = cron.planTick(jobs, nowMs);
      if (p.fire.length) fires.push(p.fire[0].scheduledFor);
      for (const n of p.next) jobs = jobs.map(x => x.id === n.jobId ? Object.assign({}, x, { nextRunAt: new Date(n.nextAt).toISOString() }) : x);
    }
    A.eq(fires, [1, 2, 3, 4, 5].map(k => T0 + k * 3600000), 'five late ticks -> five fires exactly on the hour grid (zero drift)');
    // stale (beyond grace) still fast-forwards to the next FUTURE occurrence on the grid
    const stale = cron.planTick([j], due + 3 * 3600000 + 5000);
    A.eq(stale.next[0].nextAt, due + 4 * 3600000, 'stale catch-up lands on the next future grid instant');
    A.eq(stale.fire.length, 1, 'hourly default misfire policy fire_once -> one catch-up run, no burst');
    // cron-kind schedules are unchanged (wall-clock anchored)
    const c = cronStore.makeJob({ id: 'c1', prompt: 'x', agentId: 'a', schedule: cron.parseSchedule('0 * * * *', T0) }, { id: 'c1', now: T0 });
    const cDue = Date.parse(c.nextRunAt);
    const cp = cron.planTick([c], cDue + 30000);
    A.eq(cp.next[0].nextAt, cDue + 3600000, 'cron-kind next fire is the next wall-clock match');
  }

  // ---- a routine script that TIMES OUT: its error is clipped like the non-zero-exit path (last 4000 chars) ----
  {
    const { clipScriptError, SCRIPT_ERROR_TAIL } = require('../sidecar/cron-driver.js');
    A.eq(SCRIPT_ERROR_TAIL, 4000, 'the same 4000-char tail the non-zero-exit path keeps');
    const head = 'TIMEOUT: the command did not finish within its 30000ms timeout, so the host KILLED it (the whole process tree). Output captured before the kill:\n';
    const big = head + 'x'.repeat(64000) + '\nLAST LINE\n[exit -1 — KILLED (timed out after 30000ms)]';
    const c = clipScriptError(big);
    A.ok(c.startsWith(head), 'the explanatory TIMEOUT head is kept');
    A.ok(/LAST LINE\n\[exit -1/.test(c), 'the tail (the part that explains the failure) is kept');
    A.ok(c.length <= head.length + 1 + 4000, 'and the 64KB body is clipped to 4000 chars (' + c.length + ')');
    A.eq(clipScriptError('short failure'), 'short failure', 'a short message passes through untouched');
    const src = readSidecarSource();
    const fn = src.slice(src.indexOf('async function executeCronScript('), src.indexOf('async function executeCronScript(') + 1500);
    A.ok(/catch \(e\)[\s\S]*clipScriptError\(/.test(fn), 'executeCronScript routes a thrown script failure through clipScriptError');
  }

  A.report('cron.hardening');
})();
