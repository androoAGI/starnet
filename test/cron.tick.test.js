/* node test/cron.tick.test.js — the autonomous TICK DRIVER (CRON Commit 4b).

   Proves the index.js-owned scheduler pass is correct with every ambient dep FAKED (fake clock, fake runOnce,
   capturing emit, in-memory store) — no http server, no real timer, no wall-clock read. Asserts the load-bearing
   safety properties from docs/CRON_INTEGRATION_PLAN.md §3.3/§4b:
     · a due job fires exactly once, surface:'autonomous' + trigger:'schedule' (the unattended-consent keystone)
     · nextRunAt is ADVANCED before the run is launched (at-most-once across a crash) — lastRunAt only on completion
     · cron.fire carries the launched run's runId; the war-room pulse (cron.tick) is silent on an idle/empty tick
     · one-run-per-job: a still-leased job is skipped (cron.skipped{already-running}), the occurrence advanced
     · the SELF-HEALING lease: a run that never ends is reclaimed+aborted after the ceiling (stale-lock-reclaimed)
     · BOOT RESUME: a recurring job whose nextRunAt elapsed while down fires ONE catch-up within grace, else
       fast-forwards+skips (caught-up) — never a backlog burst
     · a throwing run records lastStatus:'error' and does not stop the next job from firing
     · no provider credentials/model -> cron.skipped{no-capability}; OAuth-backed providers do not need a BYOK key
     · the [SILENT] no-spam check is strict-equals-after-trim (an embedded [SILENT] does NOT suppress) */
'use strict';
const A = require('./_assert.js');
const { makeClock } = require('../shared/clock-rng.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');
require('./cron.run-now.test.js');

const T0 = 1700000000000;
const flush = () => new Promise(r => setImmediate(r));   // let the launch->finishFire promise chain settle

// build a store + driver with controllable fakes. runOnce: a fn(opts)->Promise that may use opts.emit to
// simulate the run's events. Returns { driver, store getters, captured runs/events, clock }.
function setup(jobs, runOnceFake, opts) {
  opts = opts || {};
  const clock = makeClock(opts.t0 || T0);
  let store = (jobs || []).slice();
  const events = [];        // every cron.*/forwarded event the driver emitted
  const runs = [];          // every runOnce opts object the driver passed
  const placed = [];        // every placeWorkitem(agentId,prompt,runId) — the conveyor box a fire rides onto the floor
  const deliveries = [];
  let idN = 0;
  let writes = 0;
  const driver = makeCronDriver({
    getJobs: () => store,
    setJobs: (j) => { writes++; if (opts.failWriteAt === writes) return false; store = j; return true; },
    runOnce: (o) => { runs.push(o); return Promise.resolve(runOnceFake ? runOnceFake(o) : undefined); },
    emit: (name, payload) => { events.push({ name, payload }); },
    placeWorkitem: (agentId, prompt, runId) => { placed.push({ agentId, prompt, runId }); },
    newId: () => 'run-' + (++idN),
    newAbort: () => new AbortController(),
    now: () => clock.now(),
    getKey: () => (opts.key !== undefined ? opts.key : 'sk-test'),
    providerForJob: opts.providerForJob,
    hasCredential: opts.hasCredential,
    preflightConfig: opts.preflightConfig,
    contextFor: opts.contextFor,
    hashText: opts.hashText,
    deliverResult: opts.deliverResult || ((job, result) => { deliveries.push({ job, result }); return { ok: true }; }),
    defaultModel: opts.defaultModel !== undefined ? opts.defaultModel : 'test/model',
    identityForAgent: opts.identityForAgent,
    persona: 'PERSONA',
    agentExists: opts.agentExists,       // deleted-agent guard: absent -> pre-guard behavior (every agent passes)
    maxRunMs: opts.maxRunMs || 480000,
    maxParallel: opts.maxParallel,       // G4.4: undefined/zero -> unlimited; a positive number caps in-flight fires
    resolveStation: opts.resolveStation  // B5 parity: absent -> station undefined (default office), like the host
  });
  return { driver, clock, events, runs, placed, deliveries, getJobs: () => store, getJob: (id) => cronStore.getJob(store, id),
    getWrites: () => writes,
    replaceJob: (id, patch) => { store = store.map(j => j && j.id === id ? Object.assign({}, j, patch) : j); } };
}

const evNames = (events) => events.map(e => e.name);
const firstOf = (events, name) => (events.find(e => e.name === name) || {}).payload;
const countOf = (events, name) => events.filter(e => e.name === name).length;

// an interval job armed at T0 (nextRunAt = T0 + period); due once the clock reaches that.
function intervalJob(id, everyStr) {
  const schedule = cron.parseSchedule(everyStr, T0);
  return cronStore.makeJob({ id, prompt: 'do ' + id, agentId: 'cron_' + id, schedule }, { id, now: T0 });
}
function onceJob(id, inStr) {
  const schedule = cron.parseSchedule(inStr, T0);
  return cronStore.makeJob({ id, prompt: 'do ' + id, agentId: 'cron_' + id, schedule }, { id, now: T0 });
}
function cronJob(id, expr, base) {
  const schedule = cron.parseSchedule(expr, base);
  return cronStore.makeJob({ id, prompt: 'do ' + id, agentId: 'cron_' + id, schedule }, { id, now: base });
}

// a runOnce fake that emits a normal short reply then ends 'done'.
const okRun = (text) => (o) => { o.emit('agent.run.start', { agentId: 'a', runId: o.runId, trigger: o.trigger, model: o.model }); o.emit('agent.token', { delta: text == null ? 'all good' : text }); o.emit('agent.run.end', { agentId: 'a', runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };

(async function () {

  // ---- 1. a due job fires exactly once; surface:'autonomous' + trigger:'schedule'; cron.fire carries the runId ----
  {
    const j = intervalJob('j1', 'every 1m');                  // armed nextRunAt = T0 + 60000
    const s = setup([j], okRun());
    s.clock.set(T0 + 60000);                                  // now the interval is due
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary, { fired: 1, skipped: 0, planned: 1, deferred: [] }, 'one job planned + fired (nothing deferred)');
    A.eq(s.runs.length, 1, 'runOnce called exactly once');
    A.eq(s.runs[0].surface, 'autonomous', 'fire passes surface:autonomous (the unattended-consent keystone)');
    A.eq(s.runs[0].trigger, 'schedule', 'fire passes trigger:schedule');
    A.eq(s.runs[0].isTask, true, 'a scheduled run is a task');
    A.eq(s.runs[0].agentId, 'cron_j1', 'fire runs as the job agent');
    A.eq(s.runs[0].streamId, 'cron-' + s.runs[0].runId, 'fire passes streamId=cron-<runId> so the transcript is durable + surfaceable as a session');
    const fire = firstOf(s.events, 'cron.fire');
    A.eq(fire.jobId, 'j1', 'cron.fire jobId');
    A.eq(fire.runId, s.runs[0].runId, 'cron.fire runId == the launched run');
    await flush();
    A.eq(countOf(s.events, 'cron.result'), 1, 'one cron.result after it settles');
    A.eq(firstOf(s.events, 'cron.result').outcome, 'ok', 'a normal reply -> outcome ok');
    A.eq(s.runs[0].station, undefined, 'no resolveStation dep -> station undefined (default office, pre-fix behavior)');
  }

  // ---- 1b. B5 parity: a fire passes the agent's per-bay station from resolveStation (null -> undefined) ----
  {
    const j = intervalJob('sj', 'every 1m');
    const bayStation = { agents: { cron_sj: { id: 'cron_sj', room: 'bay' } }, rooms: { bay: { id: 'bay', objects: ['computer'] } } };
    const s = setup([j], okRun(), { resolveStation: (aid) => (aid === 'cron_sj' ? bayStation : null) });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 1, 'fired once');
    A.eq(s.runs[0].station, bayStation, "the run carries the bay's OWN station — cron gets the same capability isolation as a routed channel message");
    await flush();
  }

  // ---- 1c. B5 parity: resolveStation returning null (agent has no bay) -> station undefined, never null ----
  {
    const j = intervalJob('nj', 'every 1m');
    const s = setup([j], okRun(), { resolveStation: () => null });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs[0].station, undefined, 'a bay-less agent falls back to the default office (undefined, not null)');
    await flush();
  }

  // ---- 1b. a due cron job fires through the same autonomous path and advances to its next cron time ----
  {
    const base = Date.parse('2026-06-19T08:58:00Z');
    const due = Date.parse('2026-06-19T09:00:00Z');
    const j = cronJob('cj1', '0 9 * * *', base);
    const s = setup([j], okRun(), { t0: base });
    s.clock.set(due);
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary, { fired: 1, skipped: 0, planned: 1, deferred: [] }, 'one cron job planned + fired (nothing deferred)');
    A.eq(s.runs[0].agentId, 'cron_cj1', 'cron fire runs as the job agent');
    A.eq(s.getJob('cj1').nextRunAt, cron._internals.iso(Date.parse('2026-06-20T09:00:00Z')), 'cron nextRunAt advanced before launch');
  }

  // ---- 2. advance-before-run: nextRunAt is advanced BEFORE launch; lastRunAt only after completion ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], okRun());
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());                        // run launched but NOT yet settled
    const mid = s.getJob('j1');
    A.eq(mid.nextRunAt, cron._internals.iso(T0 + 60000 + 60000), 'nextRunAt advanced one period BEFORE the run settles');
    A.eq(mid.lastRunAt, null, 'lastRunAt still null until completion (at-most-once on crash)');
    await flush();
    A.ok(s.getJob('j1').lastRunAt != null, 'lastRunAt stamped after completion');
    A.eq(s.getJob('j1').lastStatus, 'ok', 'lastStatus ok after a clean run');
  }

  // ---- 3. one-run-per-job: a still-leased job is skipped on the next due tick (occurrence still advanced) ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], () => new Promise(() => {}));        // runOnce that NEVER settles -> lease stays held
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());                        // fires; lease held
    A.eq(s.driver.leases.size, 1, 'lease held for the in-flight run');
    s.clock.set(T0 + 120000);                                 // its (advanced) nextRunAt is now due again
    s.driver.applyTick(s.clock.now());
    A.eq(countOf(s.events, 'cron.skipped'), 1, 'second tick skipped the still-running job');
    A.eq(firstOf(s.events, 'cron.skipped').reason, 'already-running', 'skip reason already-running');
    A.eq(s.runs.length, 1, 'runOnce was NOT called a second time');
    A.eq(s.getJob('j1').nextRunAt, cron._internals.iso(T0 + 180000), 'the skipped occurrence still advanced (no re-queue)');
  }

  // ---- 4. self-healing lease: a run that never ends is reclaimed + aborted after the ceiling ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], () => new Promise(() => {}), { maxRunMs: 100000 });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());                        // fires at T0+60000, lease.startedAt = T0+60000
    const ac = s.runs[0].signal;
    A.eq(ac.aborted, false, 'run not aborted yet');
    s.clock.set(T0 + 60000 + 100001);                         // older than maxRunMs
    s.driver.applyTick(s.clock.now());
    A.eq(ac.aborted, true, 'the zombie run was aborted by the lease sweep');
    A.ok(s.events.some(e => e.name === 'cron.skipped' && e.payload.reason === 'stale-lock-reclaimed'), 'emitted stale-lock-reclaimed');
    // A RECLAIM IS A REAL OUTCOME (bug-sweep 2026-08-28): the sweep records a TRANSIENT failure — the hang is
    // durable on the record (before this it left NO trace: consecutive-hang routines never tripped auto-disable
    // and a one-shot's fireClaim re-executed forever) — and the job re-fires after the bounded backoff, not
    // silently in the same pass.
    A.eq(s.runs.length, 1, 'the reclaim itself did NOT instantly re-fire (bounded backoff, not a hot loop)');
    const reclaimed = s.getJob('j1');
    A.eq(reclaimed.lastStatus, 'error', 'the reclaim is recorded as a failed run');
    A.ok(String(reclaimed.lastError || '').indexOf('reclaimed') >= 0, 'lastError names the reclaim');
    A.eq(reclaimed.retryCount, 1, 'the reclaim consumed one transient retry');
    // self-heal: past the backoff the job is due again and re-fires with a fresh lease.
    s.clock.set(T0 + 60000 + 100001 + 90001);                 // past the 90s transient backoff
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 2, 'after the backoff the freed job re-fired (no longer wedged)');
    A.ok(s.driver.leases.size === 1 && s.driver.leases.get('j1').runId === s.runs[1].runId, 'a fresh lease tracks the new run');
  }

  // ---- 4b. abortAllLeases (E-STOP hook): aborts every in-flight cron run's controller, returns the count ----
  {
    const a = intervalJob('ja', 'every 1m');
    const b = intervalJob('jb', 'every 1m');
    const s = setup([a, b], () => new Promise(() => {}));     // never-settling -> leases held
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());                        // both fire; two leases held
    A.eq(s.driver.leases.size, 2, 'two leases held for the in-flight cron runs');
    const acs = s.runs.map(r => r.signal);
    A.ok(acs.every(ac => ac.aborted === false), 'runs not aborted before the E-STOP');
    const n = s.driver.abortAllLeases();
    A.eq(n, 2, 'abortAllLeases reports the number of cron runs aborted');
    A.ok(acs.every(ac => ac.aborted === true), 'every in-flight cron run controller was aborted');
    // never-settling runs keep their leases; abort() is idempotent so a repeat call is safe (still counts held leases).
    A.eq(s.driver.abortAllLeases(), 2, 'a repeat E-STOP re-aborts the still-held leases without throwing');
  }

  // ---- 5. BOOT RESUME (within grace): a recurring job whose nextRunAt elapsed while down fires ONE catch-up ----
  {
    // 10m interval => grace = clamp(period/2)=300000 (5m). Persist nextRunAt in the past, then "restart".
    const j = intervalJob('j1', 'every 10m');
    j.nextRunAt = cron._internals.iso(T0);                    // elapsed while the host was down
    j.lastRunAt = null;
    const s = setup([j], okRun(), { t0: T0 });
    s.clock.set(T0 + 200000);                                 // 200s late < grace(300s) -> fire one catch-up
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary.fired, 1, 'resume fires exactly one catch-up within grace');
    A.eq(countOf(s.events, 'cron.fire'), 1, 'exactly one cron.fire (no backlog)');
  }

  // ---- 6. BOOT RESUME (beyond grace): a long-down job fast-forwards + skips, never a backlog burst ----
  {
    const j = intervalJob('j1', 'every 10m');                 // period 600000
    j.nextRunAt = cron._internals.iso(T0);
    j.lastRunAt = null;
    const s = setup([j], okRun(), { t0: T0 });
    s.clock.set(T0 + 5000000);                                // ~83min late >> grace -> fast-forward, do NOT fire
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary.fired, 0, 'beyond grace: nothing fires (no backlog burst)');
    A.eq(firstOf(s.events, 'cron.skipped').reason, 'caught-up', 'fast-forward emits caught-up');
    A.ok(Date.parse(s.getJob('j1').nextRunAt) > s.clock.now(), 'nextRunAt fast-forwarded to a FUTURE occurrence');
  }

  // ---- 7. a throwing run records lastStatus:error and does NOT stop the next job from firing ----
  {
    const a = intervalJob('ja', 'every 1m');
    const b = intervalJob('jb', 'every 1m');
    const s = setup([a, b], (o) => { if (o.agentId === 'cron_ja') throw new Error('boom'); return okRun()(o); });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 2, 'both due jobs were launched (a throw in one does not block the other)');
    await flush();
    A.eq(s.getJob('ja').lastStatus, 'error', 'the throwing job recorded lastStatus error');
    A.eq(s.getJob('jb').lastStatus, 'ok', 'the other job still completed ok');
    A.ok(s.events.some(e => e.name === 'cron.result' && e.payload.jobId === 'ja' && e.payload.outcome === 'failed'), 'failed outcome for the throwing job');
  }

  // ---- 7b. a settlement that cannot persist is retried, never announced or re-fired as completed ----
  {
    const j = onceJob('persist-settle', 'in 1m');
    const s = setup([j], okRun('landed once'), { failWriteAt: 3 }); // claim + first heartbeat persist; settlement fails
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    await flush();
    A.eq(s.runs.length, 1, 'the one-shot ran exactly once before its settlement write failed');
    A.eq(countOf(s.events, 'cron.result'), 0, 'an unpersisted settlement is not announced as a completed result');
    A.eq(s.driver.leases.size, 1, 'the lease retains the pending settlement instead of reopening the fire');
    s.driver.applyTick(s.clock.now() + 1);             // retry the durable settlement; the injected failure was one-shot
    A.eq(s.runs.length, 1, 'retrying settlement does not re-run the routine');
    A.eq(countOf(s.events, 'cron.result'), 1, 'the result is announced exactly once after persistence succeeds');
    A.eq(s.getJob('persist-settle').state, 'completed', 'the recovered settlement durably completes the one-shot');
    A.eq(s.driver.leases.size, 0, 'the lease releases only after settlement is durable');
  }

  // ---- 7c. a cleanly-emitted non-done terminal is still a failed routine outcome ----
  {
    const j = onceJob('cancelled-run', 'in 1m');
    const s = setup([j], (o) => {
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'schedule', model: o.model });
      o.emit('agent.token', { delta: 'partial work' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'cancelled', turns: 1, usd: 0 });
    });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    await flush();
    A.eq(s.getJob('cancelled-run').lastStatus, 'error', 'cancelled work is not persisted as a successful routine');
    A.eq(s.getJob('cancelled-run').lastReason, 'cancelled', 'the durable outcome preserves the real terminal reason');
    A.ok(/cancelled/.test(s.getJob('cancelled-run').lastError || ''), 'the durable error names why work was incomplete');
    A.eq(firstOf(s.events, 'cron.result').outcome, 'failed', 'cancelled work is announced as failed, not ok');
  }

  // ---- 8. no key/model -> one durable blocked_config alert; runOnce is never called ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], okRun(), { key: '' });               // no BYOK key configured
    s.clock.set(T0 + 60000);
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary.fired, 0, 'nothing fires without a key');
    A.eq(s.runs.length, 0, 'runOnce not called');
    A.ok(/^blocked_config:/.test(firstOf(s.events, 'cron.result').reason), 'one actionable blocked_config alert is emitted');
    A.eq(s.getJob('j1').state, 'blocked_config', 'configuration block is durable and visible');
    s.clock.set(T0 + 120000); s.driver.applyTick(s.clock.now());
    A.eq(countOf(s.events, 'cron.result'), 1, 'unchanged missing configuration does not create an alert storm');
    A.eq(s.deliveries.length, 0, 'a configuration block attempts no delivery');
  }

  // ---- 8c. a missing delivery channel blocks before spend, alerts once, then recovers when healthy ----
  {
    const j = intervalJob('channel-block', 'every 1m');
    let healthy = false;
    const s = setup([j], okRun('delivered'), {
      preflightConfig: () => healthy
        ? { ok: true }
        : { ok: false, code: 'channel-unavailable', reason: 'delivery channel "telegram" is not connected; reconnect it' }
    });
    s.clock.set(T0 + 60000); s.driver.applyTick(s.clock.now()); await flush();
    A.eq(s.runs.length, 0, 'a known-missing delivery channel blocks before model spend');
    A.eq(s.deliveries.length, 0, 'a known-missing delivery channel receives no delivery attempt');
    A.eq(countOf(s.events, 'cron.result'), 1, 'the channel configuration receives one actionable alert');
    s.clock.set(T0 + 120000); s.driver.applyTick(s.clock.now()); await flush();
    A.eq(countOf(s.events, 'cron.result'), 1, 'the unchanged channel failure does not repeat the alert');
    healthy = true;
    s.clock.set(T0 + 180000); s.driver.applyTick(s.clock.now()); await flush(); await flush();
    A.eq(s.runs.length, 1, 'the next due occurrence runs after channel configuration recovers');
    A.eq(s.getJob('channel-block').blockedConfig, null, 'successful preflight clears the durable configuration block');
  }

  // ---- 8a. monitor source hashing: unchanged durable source causes no model call or delivery ----
  {
    const source = Object.assign(intervalJob('source', 'every 1h'), { lastStatus: 'ok', lastOutput: 'version one' });
    const monitor = cronStore.makeJob({ id: 'monitor', prompt: 'summarize changes', agentId: 'cron_monitor',
      schedule: cron.parseSchedule('every 1m', T0), contextFrom: ['source'], monitorMode: true }, { id: 'monitor', now: T0 });
    const s = setup([source, monitor], okRun('reported'), {
      contextFor: (_job, jobs) => String(cronStore.getJob(jobs, 'source').lastOutput || ''),
      hashText: text => 'hash:' + text
    });
    s.clock.set(T0 + 60000); s.driver.applyTick(s.clock.now()); await flush(); await flush();
    A.eq(s.runs.length, 1, 'a new monitor source runs once');
    A.eq(s.deliveries.length, 1, 'a new monitor source delivers once');
    A.eq(s.getJob('monitor').monitorHash, 'hash:version one', 'successful run commits the source hash durably');
    s.clock.set(T0 + 120000); s.driver.applyTick(s.clock.now()); await flush();
    A.eq(s.runs.length, 1, 'unchanged source does not call the model again');
    A.eq(s.deliveries.length, 1, 'unchanged source does not deliver again');
    s.replaceJob('source', { lastOutput: 'version two' });
    s.clock.set(T0 + 180000); s.driver.applyTick(s.clock.now()); await flush(); await flush();
    A.eq(s.runs.length, 2, 'changed source calls the model again');
    A.eq(s.deliveries.length, 2, 'changed source delivers again');
    A.eq(s.getJob('monitor').monitorHash, 'hash:version two', 'the successful changed run advances the durable hash');
  }

  // ---- 8aa. restart preserves the hash barrier: unchanged source still spends/delivers nothing ----
  {
    const source = Object.assign(intervalJob('restart-source', 'every 1h'), { lastStatus: 'ok', lastOutput: 'version one' });
    const monitor = cronStore.makeJob({ id: 'restart-monitor', prompt: 'summarize changes', agentId: 'cron_monitor',
      schedule: cron.parseSchedule('every 1m', T0), contextFrom: ['restart-source'], monitorMode: true }, { id: 'restart-monitor', now: T0 });
    const deps = {
      contextFor: (_job, jobs) => String(cronStore.getJob(jobs, 'restart-source').lastOutput || ''),
      hashText: text => 'hash:' + text
    };
    const beforeRestart = setup([source, monitor], okRun('reported before restart'), deps);
    beforeRestart.clock.set(T0 + 60000); beforeRestart.driver.applyTick(beforeRestart.clock.now()); await flush(); await flush();
    const settled = beforeRestart.getJob('restart-monitor');
    A.eq(settled.monitorHash, 'hash:version one', 'pre-restart monitor commits the source hash');
    A.eq(beforeRestart.runs.length, 1, 'pre-restart changed source calls the model once');
    A.eq(beforeRestart.deliveries.length, 1, 'pre-restart changed source delivers once');

    // Model a real process boundary through the exact durable envelope loader, then construct a fresh driver.
    const reloaded = cronStore.loadEnvelope(cronStore.toEnvelope(beforeRestart.getJobs())).jobs;
    const afterRestart = setup(reloaded, okRun('must never run'), Object.assign({ t0: T0 + 60000 }, deps));
    afterRestart.clock.set(T0 + 120000); afterRestart.driver.applyTick(afterRestart.clock.now()); await flush();
    const unchanged = afterRestart.getJob('restart-monitor');
    A.eq(afterRestart.runs.length, 0, 'restart + unchanged source makes zero model calls');
    A.eq(afterRestart.deliveries.length, 0, 'restart + unchanged source makes zero delivery attempts');
    A.eq(unchanged.lastRunId, settled.lastRunId, 'suppressed restart check records no phantom run');
    A.eq(unchanged.monitorHash, settled.monitorHash, 'suppressed restart check keeps the committed hash');
    A.ok(unchanged.monitorLastCheckedAt !== settled.monitorLastCheckedAt, 'suppressed restart check durably advances only its check timestamp');
  }

  // ---- 8b. OAuth-backed providers launch without a BYOK key ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], okRun(), {
      key: '',
      defaultModel: 'gpt-5.3-codex',
      providerForJob: () => 'codex',
      hasCredential: (provider) => provider === 'codex'
    });
    s.clock.set(T0 + 60000);
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary, { fired: 1, skipped: 0, planned: 1, deferred: [] }, 'codex oauth cron fires without an OpenRouter key');
    A.eq(s.runs[0].provider, 'codex', 'cron passes the inherited provider to runOnce');
    A.eq(s.runs[0].key, '', 'codex cron does not fabricate a BYOK key');
  }

  // ---- 9. the [SILENT] no-spam check is strict-equals-after-trim ----
  {
    // a bare "[SILENT]" suppresses (outcome silent); an embedded one does NOT (outcome ok).
    const silent = setup([onceJob('s1', 'in 1m')], (o) => { o.emit('agent.token', { delta: '  [SILENT]  ' }); o.emit('agent.run.end', { agentId: 'a', runId: o.runId, reason: 'done', turns: 1, usd: 0 }); });
    silent.clock.set(T0 + 60000);
    silent.driver.applyTick(silent.clock.now());
    await flush();
    A.eq(firstOf(silent.events, 'cron.result').outcome, 'silent', 'bare [SILENT] -> outcome silent (delivery suppressed)');

    const embedded = setup([onceJob('s2', 'in 1m')], (o) => { o.emit('agent.token', { delta: 'Report: nothing urgent. [SILENT] markers were considered.' }); o.emit('agent.run.end', { agentId: 'a', runId: o.runId, reason: 'done', turns: 1, usd: 0 }); });
    embedded.clock.set(T0 + 60000);
    embedded.driver.applyTick(embedded.clock.now());
    await flush();
    A.eq(firstOf(embedded.events, 'cron.result').outcome, 'ok', 'an embedded [SILENT] does NOT suppress (strict-equals divergence)');
  }

  // ---- 10. the no-op invariant: an empty/idle tick fires nothing and emits NOTHING (no heartbeat spam) ----
  {
    const empty = setup([], okRun());
    const summary = empty.driver.applyTick(empty.clock.now());
    A.eq(summary, { fired: 0, skipped: 0, planned: 0, deferred: [] }, 'empty store -> a pure no-op');
    A.eq(empty.events.length, 0, 'an idle tick emits no events (no cron.tick heartbeat)');

    // a not-yet-due job is also a silent no-op (nextRunAt in the future).
    const future = setup([intervalJob('j1', 'every 1m')], okRun());   // armed at T0+60000, clock still T0
    const sum2 = future.driver.applyTick(future.clock.now());
    A.eq(sum2.planned, 0, 'nothing due yet -> nothing planned');
    A.eq(future.events.length, 0, 'a not-yet-due tick is silent too');
  }

  // ---- 11. a one-shot finalizes (enabled:false, completed) after it fires + settles ----
  {
    const s = setup([onceJob('o1', 'in 1m')], okRun());
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    await flush();
    const job = s.getJob('o1');
    A.eq(job.enabled, false, 'one-shot disabled after firing');
    A.eq(job.state, 'completed', 'one-shot state completed');
    A.eq(job.nextRunAt, null, 'one-shot has no next fire');
  }

  // ---- 12. cron.tick pulse is emitted (with real counts) WHEN something happens ----
  {
    const s = setup([intervalJob('j1', 'every 1m')], okRun());
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    const tick = firstOf(s.events, 'cron.tick');
    A.ok(tick != null, 'cron.tick emitted on an active tick');
    A.eq(tick, { fired: 1, skipped: 0, planned: 1, deferred: 0 }, 'cron.tick carries the real counts (+ NS-0 additive deferred:0 when nothing over-cap)');
  }

  // ---- 13. selected-agent identity: roster system/model are used when the job has no explicit model ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], okRun(), {
      defaultModel: 'fallback/model',
      identityForAgent: (agentId) => agentId === 'cron_j1' ? { system: 'ROSTER SYSTEM', model: 'roster/model' } : null
    });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs[0].model, 'roster/model', 'cron fire uses the selected agent roster model');
    A.eq(s.runs[0].system, 'ROSTER SYSTEM', 'cron fire uses the selected agent roster system prompt');
  }

  // ---- CONVEYOR: a real fire rides a box onto the floor for its agent (workitem.placed plumbing) ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], okRun());
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.placed.length, 1, 'a fired routine rides exactly one conveyor box');
    A.eq(s.placed[0].agentId, 'cron_j1', 'the box is bound for the job agent (server-authoritative)');
    A.eq(s.placed[0].prompt, 'do j1', 'the box carries the routine instruction as its payload');
    A.eq(s.placed[0].runId, s.runs[0].runId, 'the box is stamped with the launched runId (crate<->run correlation)');
  }

  // ---- CONVEYOR: a no-capability skip rides NO box (a crate appears only when a run truly fires) ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], okRun(), { key: '' });            // no key -> no-capability skip
    s.clock.set(T0 + 60000);
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary.fired, 0, 'no run fires without capability');
    A.eq(s.placed.length, 0, 'and no conveyor box rides — the floor never shows phantom work');
  }

  // ---- G4.4 DEFAULT: twenty simultaneously due routines all fire when no cap is configured ----
  {
    const jobs = Array.from({ length: 20 }, (_, i) => intervalJob('u' + (i + 1), 'every 1m'));
    const s = setup(jobs, () => new Promise(() => {}));
    s.clock.set(T0 + 60000);
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary.fired, 20, 'the default routine scheduler starts all twenty due runs');
    A.eq(summary.deferred.length, 0, 'no hidden routine concurrency ceiling defers work');
  }

  // ---- G4.4 CAP: maxParallel caps in-flight fires; the excess due jobs DEFER (stay due next tick) ----
  {
    // 3 interval jobs all due at the same instant, but only ONE may fire (cap=1). The other two are
    // DEFERRED — observable via the return value (summary.deferred) — and MUST stay due (nextRunAt NOT
    // advanced) so the next tick fires them. NS-0: the deferral now ALSO emits cron.skipped{at-capacity}
    // (asserted in the dedicated at-capacity test below); here we assert the return-value contract.
    const a = intervalJob('ca', 'every 1m');
    const b = intervalJob('cb', 'every 1m');
    const c = intervalJob('cc', 'every 1m');
    // never-settling runs so the fired job HOLDS its lease (a real in-flight run counts against the cap).
    const s = setup([a, b, c], () => new Promise(() => {}), { maxParallel: 1 });
    s.clock.set(T0 + 60000);                                // all three are due
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary.fired, 1, 'cap=1 -> exactly one due job fires');
    A.eq(s.runs.length, 1, 'runOnce launched exactly once (the cap held the rest back)');
    A.ok(Array.isArray(summary.deferred), 'summary.deferred is an array (the observable deferral signal)');
    A.eq(summary.deferred.length, 2, 'the two over-cap jobs are reported deferred via the return value');
    A.eq(summary.fired + summary.deferred.length, 3, 'every due job is accounted for: fired + deferred = 3');
    // the fired job advanced (advance-before-run); the two DEFERRED jobs did NOT — they remain due.
    const firedId = s.runs[0].agentId.replace('cron_', '');
    for (const id of ['ca', 'cb', 'cc']) {
      const job = s.getJob(id);
      if (id === firedId) {
        A.eq(job.nextRunAt, cron._internals.iso(T0 + 120000), 'the FIRED job advanced one period (advance-before-run)');
      } else {
        A.ok(summary.deferred.indexOf(id) >= 0, 'the over-cap job ' + id + ' is in summary.deferred');
        A.eq(job.nextRunAt, cron._internals.iso(T0 + 60000), 'a DEFERRED job keeps its old nextRunAt (still DUE)');
      }
    }
    // next tick at the SAME instant: the one freed slot is taken by a deferred job (cap still 1, still in-flight).
    const summary2 = s.driver.applyTick(s.clock.now());
    A.eq(summary2.fired, 0, 'cap=1 and the first run is still in-flight -> nothing new fires next tick');
    A.eq(summary2.deferred.length, 2, 'both deferred jobs still due and still over the cap');
  }

  // ---- G4.4 CAP: with headroom the deferred jobs fire on a later tick once a slot frees ----
  {
    // cap=2, 3 due jobs whose runs settle immediately: 2 fire this tick (deferring 1), and after the leases
    // release the deferred job fires on the next tick — proving deferral is a HOLD, not a drop.
    const a = intervalJob('da', 'every 5m');
    const b = intervalJob('db', 'every 5m');
    const c = intervalJob('dc', 'every 5m');
    const s = setup([a, b, c], okRun(), { maxParallel: 2 });
    s.clock.set(T0 + 300000);                               // all three due (period 5m)
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary.fired, 2, 'cap=2 -> two fire this tick');
    A.eq(summary.deferred.length, 1, 'the third is deferred');
    const deferredId = summary.deferred[0];
    A.eq(s.getJob(deferredId).nextRunAt, cron._internals.iso(T0 + 300000), 'the deferred job is still due (nextRunAt unchanged)');
    await flush();                                          // the two fired runs settle -> leases release
    const summary2 = s.driver.applyTick(s.clock.now());     // same instant, slots now free
    A.eq(summary2.fired, 1, 'the previously-deferred job fires once a slot frees');
    A.eq(s.runs[s.runs.length - 1].agentId, 'cron_' + deferredId, 'the freed slot ran the deferred job');
    A.eq(s.getJob(deferredId).nextRunAt, cron._internals.iso(T0 + 300000 + 300000), 'now it has advanced (it actually fired)');
  }

  // A fresh occurrence at the front of the store must not overtake older deferred work.
  // Persisted due times carry this fairness across a driver restart without a volatile cursor.
  for (const restart of [false, true]) {
    let s = setup([intervalJob('early', 'every 1m'), intervalJob('late', 'every 1m')], okRun(), { maxParallel: 1 });
    s.clock.set(T0 + 60000); s.driver.applyTick(s.clock.now()); await flush();
    A.eq(s.runs[0].agentId, 'cron_early', 'equal deadlines retain stable store order');
    if (restart) s = setup(s.getJobs(), okRun(), { maxParallel: 1 });
    s.clock.set(T0 + 120000); s.driver.applyTick(s.clock.now()); await flush();
    A.eq(s.runs[s.runs.length - 1].agentId, 'cron_late', 'older deferred occurrence precedes fresh recurring work, restart=' + restart);
    A.eq(s.getJob('late').repeat.completed, 1, 'deferred routine actually completes');
  }

  // ---- G4.4 TRANSIENT RETRY (proven end-to-end): transient-once-then-ok backs off, retryCount++, no lastRunAt advance, then succeeds ----
  {
    // The EXISTING retry path (markRun transient backoff) is proven through the REAL driver fire->settle
    // path: the first fire's run reports a TRANSIENT error -> nextRunAt backs off (now+backoffMs),
    // retryCount becomes 1, lastRunAt stays null (occurrence not finalized). The backed-off fire then
    // succeeds -> retryCount resets to 0, lastRunAt stamped, lastStatus ok.
    const BACKOFF = 90000;                                  // cron-store default backoffMs
    let attempt = 0;
    const flaky = (o) => {
      attempt++;
      if (attempt === 1) {
        // a transient run error (the loop signals transient:true; the driver's sink books state.transient)
        o.emit('agent.run.error', { agentId: 'a', runId: o.runId, message: 'rate limited', transient: true });
        o.emit('agent.run.end', { agentId: 'a', runId: o.runId, reason: 'error', turns: 1, usd: 0 });
        return;
      }
      okRun('recovered')(o);                                // second attempt succeeds
    };
    const j = intervalJob('rj', 'every 10m');               // period 600000; armed at T0+600000
    const s = setup([j], flaky);
    s.clock.set(T0 + 600000);                               // due
    s.driver.applyTick(s.clock.now());                      // fire #1
    await flush();                                          // settle -> markRun(transient)
    const afterFail = s.getJob('rj');
    A.eq(afterFail.retryCount, 1, 'transient failure incremented retryCount');
    A.eq(afterFail.lastRunAt, null, 'transient failure did NOT advance lastRunAt (occurrence not finalized)');
    A.eq(afterFail.lastStatus, 'error', 'transient failure recorded lastStatus error (failing-and-retrying)');
    A.eq(afterFail.state, 'error', 'state error while retrying, but still scheduled');
    A.eq(afterFail.nextRunAt, cron._internals.iso(T0 + 600000 + BACKOFF), 'nextRunAt backed off by backoffMs (now + 90s)');
    A.ok(afterFail.enabled !== false, 'a transiently-failing recurring job stays enabled');
    // advance to the backed-off fire time and tick again -> the retry succeeds.
    s.clock.set(T0 + 600000 + BACKOFF);
    s.driver.applyTick(s.clock.now());                      // fire #2 (the retry)
    await flush();
    const afterOk = s.getJob('rj');
    A.eq(attempt, 2, 'the run was attempted exactly twice (one transient, one success)');
    A.eq(afterOk.retryCount, 0, 'a successful retry resets retryCount');
    A.ok(afterOk.lastRunAt != null, 'the successful retry finalized the occurrence (lastRunAt stamped)');
    A.eq(afterOk.lastStatus, 'ok', 'lastStatus ok after the retry succeeds');
  }

  // ---- NS-0 HEARTBEAT (crown jewel): a run that OUTLIVES the old maxRunMs but keeps emitting progress fires
  //      EXACTLY ONCE — no stale-lock reclaim, no duplicate fire (the real-world "AI news radar 4×" incident). ----
  {
    // A run that never resolves BUT keeps emitting progress events. Each event renews the lease heartbeat, so the
    // lease sweep must never declare it a zombie no matter how far past maxRunMs the clock advances.
    let emitProgress = null;
    const liveLongRun = (o) => {
      o.emit('agent.run.start', { agentId: 'a', runId: o.runId, trigger: o.trigger, model: o.model });
      emitProgress = () => { try { o.emit('agent.token', { delta: '.' }); } catch (_) {} };   // a heartbeat pulse
      return new Promise(() => {});                            // never settles (a genuinely long research run)
    };
    const j = intervalJob('hb', 'every 1m');
    const s = setup([j], liveLongRun, { maxRunMs: 100000 });   // old fixed ceiling = 100s
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());                         // fires once, lease held, run in flight
    A.eq(s.runs.length, 1, 'the long run launched exactly once');
    A.eq(s.driver.leases.size, 1, 'its lease is held');
    // advance WELL past the old maxRunMs, pulsing a heartbeat each step (the run keeps proving it is alive).
    for (let k = 1; k <= 10; k++) {
      s.clock.advance(90000);                                  // 90s < staleMs(100s): each pulse keeps it fresh
      emitProgress();                                          // the run emits progress -> heartbeat renews
      s.driver.applyTick(s.clock.now());                       // its (advanced) nextRunAt is due, but lease held
    }
    A.eq(s.runs.length, 1, 'after ~15min of a LIVE heartbeating run it STILL fired exactly once (no duplicate)');
    A.eq(countOf(s.events, 'cron.fire'), 1, 'exactly one cron.fire across the whole long run');
    A.ok(!s.events.some(e => e.name === 'cron.skipped' && e.payload.reason === 'stale-lock-reclaimed'), 'a live heartbeating run is NEVER stale-lock-reclaimed');
    // every re-tick while it was in flight skipped it as already-running (never a second launch).
    A.ok(countOf(s.events, 'cron.skipped') >= 1 && s.events.filter(e => e.name === 'cron.skipped').every(e => e.payload.reason === 'already-running'), 'each due re-tick skipped the still-running job (already-running), never re-fired');
  }

  // ---- NS-0 DURABLE HEARTBEAT: a failed persistence receipt retries on the next progress event. ----
  {
    let emitProgress = null;
    const liveOneShot = (o) => {
      o.emit('agent.run.start', { agentId: 'a', runId: o.runId, trigger: o.trigger, model: o.model });
      emitProgress = () => o.emit('agent.token', { delta: '.' });
      return new Promise(() => {});
    };
    const s = setup([onceJob('heartbeat-retry', 'in 1m')], liveOneShot, { maxRunMs: 100000, failWriteAt: 3 });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());                         // claim + initial durable heartbeat succeed
    const firstDurable = s.getJob('heartbeat-retry').heartbeatAt;
    s.clock.advance(26000);                                    // past the 25s durable-heartbeat throttle
    emitProgress();                                            // write #3 fails and must NOT consume the throttle window
    A.eq(s.getJob('heartbeat-retry').heartbeatAt, firstDurable, 'failed receipt leaves the durable heartbeat unchanged');
    s.clock.advance(1);
    emitProgress();                                            // the next proof of life retries immediately
    A.eq(s.getWrites(), 4, 'the next progress event retries the failed durable write');
    A.eq(s.getJob('heartbeat-retry').heartbeatAt, T0 + 86001, 'the retry persists the fresh liveness timestamp');
  }

  // ---- NS-0 HEARTBEAT: a run whose heartbeat STOPS (a crash mid-run) IS reclaimed after staleMs and refires. ----
  {
    // The run emits an initial progress event then goes silent (its process died). heartbeatAt freezes at that
    // last pulse; once the clock is staleMs past it, the sweep reclaims + aborts + the freed job re-fires.
    const silentAfterStart = (o) => {
      o.emit('agent.run.start', { agentId: 'a', runId: o.runId, trigger: o.trigger, model: o.model });   // one heartbeat, then silence
      return new Promise(() => {});
    };
    const j = intervalJob('hbx', 'every 1m');
    const s = setup([j], silentAfterStart, { maxRunMs: 100000 });   // staleMs defaults to maxRunMs*1 = 100s
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());                         // fires; last heartbeat = T0+60000 (the run.start)
    const ac = s.runs[0].signal;
    A.eq(ac.aborted, false, 'not aborted while heartbeat is fresh');
    s.clock.set(T0 + 60000 + 100001);                          // 100.001s of silence > staleMs(100s)
    s.driver.applyTick(s.clock.now());
    A.eq(ac.aborted, true, 'a crashed (heartbeat-stopped) run is aborted by the sweep');
    A.ok(s.events.some(e => e.name === 'cron.skipped' && e.payload.reason === 'stale-lock-reclaimed'), 'a heartbeat-stale run emits stale-lock-reclaimed');
    // reclaim = recorded transient failure + bounded backoff (bug-sweep 2026-08-28), then the self-heal re-fire.
    A.eq(s.runs.length, 1, 'the reclaim did not instantly re-fire (bounded backoff)');
    s.clock.set(T0 + 60000 + 100001 + 90001);                  // past the 90s transient backoff
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 2, 'after the backoff the freed job re-fired (self-heal)');
  }

  // ---- NS-0 TELEMETRY: an at-capacity deferral now EMITS cron.skipped{at-capacity} + a cron.tick.deferred count. ----
  {
    const a = intervalJob('qa', 'every 1m');
    const b = intervalJob('qb', 'every 1m');
    const s = setup([a, b], () => new Promise(() => {}), { maxParallel: 1 });   // cap 1, both due -> one defers
    s.clock.set(T0 + 60000);
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary.deferred.length, 1, 'one job deferred past the cap');
    A.ok(s.events.some(e => e.name === 'cron.skipped' && e.payload.reason === 'at-capacity'), 'the deferral is EMITTED as cron.skipped{at-capacity} (no longer silent)');
    const tick = firstOf(s.events, 'cron.tick');
    A.eq(tick.deferred, 1, 'cron.tick carries the additive deferred count');
  }

  // ---- NS-0 TELEMETRY: a DISABLED job whose time has come emits cron.skipped{disabled} — ONCE per due window. ----
  {
    const j = intervalJob('dq', 'every 1m');                   // armed nextRunAt = T0+60000
    j.enabled = false; j.state = 'paused';                     // paused but its nextRunAt stays in the (soon) past
    const s = setup([j], okRun());
    s.clock.set(T0 + 120000);                                  // its frozen nextRunAt (T0+60000) is now past-due
    s.driver.applyTick(s.clock.now());
    A.eq(countOf(s.events, 'cron.skipped'), 1, 'a disabled-due job emits exactly one skip');
    A.eq(firstOf(s.events, 'cron.skipped').reason, 'disabled', 'the reason is disabled');
    A.eq(s.runs.length, 0, 'a disabled job never fires');
    // a SECOND tick at the same due window does NOT re-emit (deduped — no per-tick spam).
    s.clock.advance(60000);
    s.driver.applyTick(s.clock.now());
    A.eq(countOf(s.events, 'cron.skipped'), 1, 'the same disabled due-window is not re-reported (deduped, no spam)');
  }

  // ---- DELETED-AGENT GUARD (2026-07-16 resurrect audit): a job whose agent no longer exists is REMOVED, not
  //      fired — an orphaned routine must never keep spending / minting ghost sessions after DELETE AGENT. ----
  {
    const ghost = intervalJob('gj', 'every 1m');               // agentId 'cron_gj' — will be "deleted"
    const alive = intervalJob('aj', 'every 1m');               // agentId 'cron_aj' — still on the roster
    const s = setup([ghost, alive], okRun(), { agentExists: (id) => id !== 'cron_gj' });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 1, 'only the living agent\'s job fired');
    A.eq(s.runs[0].agentId, 'cron_aj', 'the fired run belongs to the living agent');
    A.ok(s.events.some(e => e.name === 'cron.skipped' && e.payload.jobId === 'gj' && e.payload.reason === 'no-capability'),
      'the orphaned job reports an honest skip (governed no-capability reason)');
    A.eq(s.getJob('gj'), null, 'the orphaned job is REMOVED from the durable store (never fires again)');
    A.ok(s.getJob('aj'), 'the living agent\'s job survives untouched');
    A.eq(s.placed.filter(p => p.agentId === 'cron_gj').length, 0, 'no floor crate is placed for a deleted agent');
    // next tick: the removed job stays gone — no re-fire, no repeat skip for it.
    const skipsBefore = s.events.filter(e => e.name === 'cron.skipped').length;
    s.clock.advance(60000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.filter(r => r.agentId === 'cron_gj').length, 0, 'the deleted agent never fires on later ticks');
    A.eq(s.events.filter(e => e.name === 'cron.skipped' && e.payload.jobId === 'gj').length,
      skipsBefore ? 1 : 0, 'the removed job does not re-report every tick (it is gone from the store)');
    // absent agentExists dep -> pre-guard behavior (both fire) — the guard is strictly opt-in for hosts.
    const legacy = setup([intervalJob('lg', 'every 1m')], okRun());
    legacy.clock.set(T0 + 60000);
    legacy.driver.applyTick(legacy.clock.now());
    A.eq(legacy.runs.length, 1, 'a host that injects no agentExists keeps the pre-guard behavior');
  }

  // ---- FIRE-THROW CONTAINMENT (bug-sweep 2026-08-28): one job's throwing fire never eats the tick. ----
  // Step 3 persists EVERY planned job's advance before step 5 launches; before this fix a throw out of
  // fireJob (an injected dep hitting a corrupt record) aborted the loop, and the remaining jobs' already-
  // consumed occurrences were silently lost — forever, when the throw was deterministic.
  {
    const a = intervalJob('ta', 'every 1m');
    const b = intervalJob('tb', 'every 1m');
    const s = setup([a, b], okRun(), {
      identityForAgent: (agentId) => { if (agentId === 'cron_ta') throw new Error('corrupt roster record'); return {}; }
    });
    s.clock.set(T0 + 60000);
    let threw = null;
    try { s.driver.applyTick(s.clock.now()); } catch (e) { threw = e; }
    A.eq(threw, null, 'the tick itself never throws on a single job\'s fire failure');
    A.eq(s.runs.length, 1, 'the OTHER due job still fired');
    A.eq(s.runs[0].agentId, 'cron_tb', 'the surviving fire is the healthy job');
    const broken = s.getJob('ta');
    A.eq(broken.lastStatus, 'error', 'the throwing job records a failed run');
    A.ok(String(broken.lastError || '').indexOf('corrupt roster record') >= 0, 'lastError carries the real cause');
    A.ok(s.events.some(e => e.name === 'cron.result' && e.payload.jobId === 'ta' && e.payload.outcome === 'failed'), 'an honest cron.result{failed} for the throwing job');
    A.ok(!s.driver.leases.has('ta'), 'no orphaned lease is left behind for the failed fire');
    // deterministic throw stays contained on later ticks too — the healthy job keeps firing.
    await flush();                                              // let tb's first run settle (lease released)
    s.clock.set(T0 + 120000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.filter(r => r.agentId === 'cron_tb').length, 2, 'the healthy job fired again next tick (never starved)');
  }

  // ---- ONE-SHOT ZOMBIE RECLAIM CLEARS ITS CLAIM (bug-sweep 2026-08-28): no eternal re-execute loop. ----
  // Before this, a reclaimed one-shot's late settlement was UNOWNED (generation fence) so markRun never ran:
  // fireClaim stayed persisted + lastRunAt stayed null, and planTick re-fired the SAME one-shot every
  // ~maxRunMs forever — real provider spend each cycle. Now the reclaim itself records a transient failure.
  {
    const j = onceJob('oz', 'in 1m');
    const silentRun = (o) => { o.emit('agent.run.start', { agentId: 'a', runId: o.runId, trigger: o.trigger, model: o.model }); return new Promise(() => {}); };
    const s = setup([j], silentRun, { maxRunMs: 100000 });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());                          // fires; fireClaim persisted before launch
    A.ok(s.getJob('oz').fireClaim != null, 'the one-shot fire-claim is stamped at launch');
    s.clock.set(T0 + 60000 + 100001);                           // silence > staleMs -> sweep reclaims
    s.driver.applyTick(s.clock.now());
    const reclaimed = s.getJob('oz');
    A.eq(reclaimed.fireClaim, null, 'the reclaim CLEARS the persisted fire-claim (no zombie re-execute loop)');
    A.eq(reclaimed.heartbeatAt, null, 'the durable heartbeat is cleared with it');
    A.eq(reclaimed.lastStatus, 'error', 'the hang is durable on the record');
    A.eq(reclaimed.retryCount, 1, 'the reclaim consumed one bounded transient retry');
    A.eq(s.runs.length, 1, 'no instant re-fire in the reclaim pass');
    // the bounded retry: past the backoff it re-fires ONCE more (not an unbounded ~maxRunMs loop).
    s.clock.set(T0 + 60000 + 100001 + 90001);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 2, 'the one-shot retries once past the backoff (bounded, visible retry)');
  }

  require('./cron.run-now.test.js');
  A.report('cron.tick');
})();
