/* node test/cron-store.test.js — the PURE cron-job lifecycle reducer (CRON Commit 2).
   Proves create/update/pause/resume/markRun/remove are pure (input never mutated), deterministic, and
   injected-clock, and that the load-bearing run-lifecycle invariants hold: advance-before-run is not
   clobbered by markRun, one-shots finalize once, transient failures back off (bounded) without losing
   the occurrence, recurring errors stay enabled, finite repeats exhaust, and the store load is fail-closed.
   Driven by makeClock — no wall-clock read — exactly like cron / loop.replay / permissions. */
'use strict';
const A = require('./_assert.js');
const { makeClock } = require('../shared/clock-rng.js');
const cron = require('../sidecar/cron.js');
const store = require('../sidecar/cron-store.js');

const T0 = 1700000000000;
const HOUR = 3600000, MIN = 60000;
const iso = cron._internals.iso;

// ---- 1. createJob: normalize an interval job, compute the initial fire, default the record ----
{
  const jobs = store.createJob([], {
    id: 'j1', name: 'hourly', prompt: 'do the thing',
    schedule: cron.parseSchedule('every 1h', T0), agentId: 'cron_j1'
  }, { now: T0 });
  A.eq(jobs.length, 1, 'createJob appends one job');
  const j = jobs[0];
  A.eq(j.id, 'j1', 'id carried through');
  A.eq(j.enabled, true, 'default enabled');
  A.eq(j.state, 'scheduled', 'enabled -> state scheduled');
  A.eq(j.deliver, 'local', 'default deliver = local');
  A.eq(j.model, null, 'default model null (host default)');
  A.eq(j.repeat.times, null, 'interval -> forever (times null)');
  A.eq(j.repeat.completed, 0, 'completed starts at 0');
  A.eq(j.retryCount, 0, 'retryCount starts at 0');
  A.eq(j.nextRunAt, iso(T0 + HOUR), 'interval nextRunAt = now + period');
  A.eq(j.createdAt, iso(T0), 'createdAt = now');
  A.eq(j.lastRunAt, null, 'no last run yet');
}

// ---- 2. createJob: a one-shot is times:1 and arms at its runAt ----
{
  const sched = cron.parseSchedule('in 2h', T0);
  const jobs = store.createJob([], { id: 'once1', schedule: sched }, { now: T0 });
  A.eq(jobs[0].repeat.times, 1, 'one-shot -> times 1');
  A.eq(jobs[0].nextRunAt, iso(T0 + 2 * HOUR), 'one-shot arms at its runAt');
}

// ---- 2b. createJob: a cron job is recurring and arms at its next matching minute ----
{
  const base = Date.parse('2026-06-19T08:58:00Z');
  const sched = cron.parseSchedule('0 9 * * *', base);
  const jobs = store.createJob([], { id: 'cron1', schedule: sched }, { now: base });
  A.eq(jobs[0].repeat.times, null, 'cron -> forever by default');
  A.eq(jobs[0].nextRunAt, iso(Date.parse('2026-06-19T09:00:00Z')), 'cron arms at its next matching time');
}

// ---- 3. createJob: invalid + duplicate ids are rejected; disabled spec -> paused ----
{
  A.throws(() => store.createJob([], { id: 'bad id!', schedule: null }, { now: T0 }), 'invalid id rejected');
  A.throws(() => store.createJob([], { schedule: null }, { now: T0 }), 'missing id rejected');
  const jobs = store.createJob([], { id: 'dup', schedule: null }, { now: T0 });
  A.throws(() => store.createJob(jobs, { id: 'dup', schedule: null }, { now: T0 }), 'duplicate id rejected');
  const paused = store.createJob([], { id: 'p1', enabled: false, schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
  A.eq(paused[0].state, 'paused', 'enabled:false -> paused');
  A.eq(paused[0].nextRunAt, null, 'a paused job is not armed');
}

// ---- 4. createJob does NOT mutate the input array (purity) ----
{
  const before = [];
  const after = store.createJob(before, { id: 'x', schedule: null }, { now: T0 });
  A.eq(before.length, 0, 'input array untouched');
  A.ok(after !== before, 'returns a new array');
}

// ---- 5. updateJob: patch editable fields; id immutable; schedule change re-anchors nextRunAt ----
{
  let jobs = store.createJob([], { id: 'u1', name: 'old', schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
  jobs = store.updateJob(jobs, 'u1', { name: 'new', id: 'hacked' }, { now: T0 });
  A.eq(store.getJob(jobs, 'u1').name, 'new', 'name patched');
  A.eq(store.getJob(jobs, 'hacked'), null, 'id is immutable (patch.id ignored)');

  const now2 = T0 + 10 * MIN;
  jobs = store.updateJob(jobs, 'u1', { schedule: cron.parseSchedule('every 30m', now2) }, { now: now2 });
  A.eq(store.getJob(jobs, 'u1').schedule.minutes, 30, 'schedule replaced');
  A.eq(store.getJob(jobs, 'u1').nextRunAt, iso(now2 + 30 * MIN), 'schedule change re-anchors nextRunAt at now');
}

// ---- 6. pause / resume: resume re-anchors the next fire at now ----
{
  let jobs = store.createJob([], { id: 'pr', schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
  jobs = store.pauseJob(jobs, 'pr');
  A.eq(store.getJob(jobs, 'pr').enabled, false, 'paused -> disabled');
  A.eq(store.getJob(jobs, 'pr').state, 'paused', 'paused -> state paused');
  const later = T0 + 5 * HOUR;
  jobs = store.resumeJob(jobs, 'pr', { now: later });
  A.eq(store.getJob(jobs, 'pr').enabled, true, 'resumed -> enabled');
  A.eq(store.getJob(jobs, 'pr').nextRunAt, iso(later + HOUR), 'resume re-anchors nextRunAt at now + period');
}

// ---- 7. markRun success on a recurring job: stamps last-run, increments completed, LEAVES nextRunAt ----
{
  // simulate the host having advanced nextRunAt before launch (advance-before-run)
  let jobs = store.createJob([], { id: 'm1', schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
  const advanced = iso(T0 + 2 * HOUR);
  jobs = store.updateJob(jobs, 'm1', {}, { now: T0 });          // no-op patch
  jobs = jobs.map(j => j.id === 'm1' ? Object.assign({}, j, { nextRunAt: advanced }) : j);
  const runAt = T0 + HOUR;
  jobs = store.markRun(jobs, 'm1', { runId: 'r1', status: 'ok', reason: 'done' }, { now: runAt });
  const j = store.getJob(jobs, 'm1');
  A.eq(j.lastRunAt, iso(runAt), 'lastRunAt stamped at now');
  A.eq(j.lastStatus, 'ok', 'lastStatus ok');
  A.eq(j.lastReason, 'done', 'lastReason carried');
  A.eq(j.lastRunId, 'r1', 'lastRunId carried');
  A.eq(j.repeat.completed, 1, 'completed incremented');
  A.eq(j.nextRunAt, advanced, 'success does NOT clobber the pre-advanced nextRunAt (advance-before-run honored)');
  A.eq(j.state, 'scheduled', 'recurring success stays scheduled');
}

// ---- 8. markRun on a one-shot: finalize once (disabled, completed, no next) ----
{
  let jobs = store.createJob([], { id: 'os', schedule: cron.parseSchedule('in 1h', T0) }, { now: T0 });
  jobs = store.markRun(jobs, 'os', { runId: 'r', status: 'ok', reason: 'done' }, { now: T0 + HOUR });
  const j = store.getJob(jobs, 'os');
  A.eq(j.enabled, false, 'one-shot disabled after running');
  A.eq(j.state, 'completed', 'one-shot -> completed');
  A.eq(j.nextRunAt, null, 'one-shot has no next fire');
  A.eq(j.repeat.completed, 1, 'one-shot completed count = 1');
}

// ---- 9. markRun transient failure: back off, stay eligible, do NOT consume the occurrence ----
{
  let jobs = store.createJob([], { id: 't1', schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
  const failAt = T0 + HOUR;
  jobs = store.markRun(jobs, 't1', { runId: 'r', status: 'error', error: 'network', transient: true },
    { now: failAt, backoffMs: 90000 });
  const j = store.getJob(jobs, 't1');
  A.eq(j.retryCount, 1, 'transient failure increments retryCount');
  A.eq(j.lastRunAt, null, 'transient failure does NOT stamp lastRunAt (occurrence not consumed)');
  A.eq(j.repeat.completed, 0, 'transient failure does NOT increment completed');
  A.eq(j.nextRunAt, iso(failAt + 90000), 'transient failure backs off to now + backoff');
  A.eq(j.state, 'error', 'transient failure is visible as error (still scheduled)');
  // PHASE-SHIFT GUARD: the backoff rewinds nextRunAt, but the SCHEDULE's own occurrence must survive it —
  // advancing the interval from the backoff instant walked an hourly routine +90s per transient, forever.
  A.eq(j.retryAnchorAt, iso(failAt), 'the anchored occurrence survives the backoff rewind');
  const plan = cron.dueJobs([j], failAt + 90000);
  const adv = plan.advanced.find(n => n.jobId === 't1');
  A.eq(adv && adv.nextAt, T0 + 2 * HOUR, 'the retry advance lands back on the interval GRID, not backoff+period');
  jobs = store.markRun(jobs, 't1', { runId: 'r2', status: 'ok', reason: 'done' }, { now: failAt + 91000 });
  A.eq(store.getJob(jobs, 't1').retryAnchorAt, null, 'a settled occurrence drops the retry anchor');
}

// ---- 9b. every path that re-anchors nextRunAt also drops the retry anchor ----
// updateJob/resumeJob/triggerJob rewrite nextRunAt; a surviving retryAnchorAt would override the
// re-anchored schedule in planTick and phase-lock the routine to the abandoned old grid ("I changed
// the schedule and it ignored me").
{
  const mkStuck = () => {
    let js = store.createJob([], { id: 'ra', schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
    js = store.markRun(js, 'ra', { runId: 'r', status: 'error', error: 'net', transient: true, idempotencyScope: 'cron:ra:1' }, { now: T0 + HOUR, backoffMs: 90000 });
    A.ok(store.getJob(js, 'ra').retryAnchorAt, 'fixture: a retry anchor is stamped');
    A.eq(store.getJob(js, 'ra').occurrenceScope, 'cron:ra:1', 'fixture: the occurrence scope is kept (GHSA-2hpj #9)');
    return js;
  };
  let js = store.updateJob(mkStuck(), 'ra', { schedule: cron.parseSchedule('every 15m', T0 + HOUR) }, { now: T0 + HOUR + 60000 });
  A.eq(store.getJob(js, 'ra').retryAnchorAt, null, 'a schedule EDIT clears the retry anchor');
  A.eq(store.getJob(js, 'ra').occurrenceScope, null, 'and the occurrence scope');
  js = store.resumeJob(store.pauseJob(mkStuck(), 'ra'), 'ra', { now: T0 + HOUR + 60000 });
  A.eq(store.getJob(js, 'ra').retryAnchorAt, null, 'pause -> RESUME clears the retry anchor');
  A.eq(store.getJob(js, 'ra').occurrenceScope, null, 'and the occurrence scope');
  js = store.triggerJob(mkStuck(), 'ra', { now: T0 + HOUR + 60000 });
  A.eq(store.getJob(js, 'ra').retryAnchorAt, null, 'a manual TRIGGER clears the retry anchor');
  A.eq(store.getJob(js, 'ra').occurrenceScope, null, 'and the occurrence scope');
  // a second transient keeps the FIRST fire's scope, whatever the retry reports; a settlement drops it
  js = store.markRun(mkStuck(), 'ra', { runId: 'r2', status: 'error', error: 'net', transient: true, idempotencyScope: 'cron:ra:2' }, { now: T0 + HOUR + 100000, backoffMs: 90000 });
  A.eq(store.getJob(js, 'ra').occurrenceScope, 'cron:ra:1', 'a later retry keeps the occurrence scope of the first fire');
  js = store.markRun(js, 'ra', { runId: 'r3', status: 'ok', reason: 'done' }, { now: T0 + HOUR + 400000 });
  A.eq(store.getJob(js, 'ra').occurrenceScope, null, 'a settled occurrence drops its scope');
}

// ---- 10. transient retries are BOUNDED: after maxRetries it finalizes ----
{
  let jobs = store.createJob([], { id: 't2', schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
  // simulate retryCount already at the cap
  jobs = jobs.map(j => j.id === 't2' ? Object.assign({}, j, { retryCount: 3 }) : j);
  jobs = store.markRun(jobs, 't2', { status: 'error', error: 'network', transient: true }, { now: T0 + HOUR, maxRetries: 3 });
  const j = store.getJob(jobs, 't2');
  A.eq(j.lastRunAt, iso(T0 + HOUR), 'retries exhausted -> occurrence finalized (lastRunAt stamped)');
  A.eq(j.retryCount, 0, 'retryCount reset after finalize');
  A.eq(j.enabled, true, 'recurring job stays enabled after a finalized error');
  A.eq(j.state, 'error', 'finalized error is visible');
}

// ---- 11. permanent error on a recurring job: stays enabled, re-armed, state error ----
{
  let jobs = store.createJob([], { id: 'pe', schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
  const failAt = T0 + HOUR;
  jobs = store.markRun(jobs, 'pe', { status: 'error', error: 'bad model', transient: false }, { now: failAt });
  const j = store.getJob(jobs, 'pe');
  A.eq(j.enabled, true, 'recurring permanent-error job is NEVER silently disabled');
  A.eq(j.state, 'error', 'state reflects the error');
  A.eq(j.nextRunAt, iso(failAt + HOUR), 'permanent error re-arms one period out');
  A.eq(j.repeat.completed, 1, 'permanent error consumes the occurrence');
}

// ---- 12. finite-repeat interval exhaustion: completes after `times` runs ----
{
  let jobs = store.createJob([], { id: 'fin', schedule: cron.parseSchedule('every 1h', T0), repeat: { times: 2 } }, { now: T0 });
  A.eq(jobs[0].repeat.times, 2, 'finite times honored on create');
  jobs = store.markRun(jobs, 'fin', { status: 'ok', reason: 'done' }, { now: T0 + HOUR });
  A.eq(store.getJob(jobs, 'fin').enabled, true, 'still running after 1/2');
  jobs = store.markRun(jobs, 'fin', { status: 'ok', reason: 'done' }, { now: T0 + 2 * HOUR });
  const j = store.getJob(jobs, 'fin');
  A.eq(j.repeat.completed, 2, '2 of 2 completed');
  A.eq(j.enabled, false, 'finite repeat exhausted -> disabled');
  A.eq(j.state, 'completed', 'finite repeat exhausted -> completed');
}

// ---- 13. removeJob ----
{
  let jobs = store.createJob([], { id: 'rm', schedule: null }, { now: T0 });
  jobs = store.createJob(jobs, { id: 'keep', schedule: null }, { now: T0 });
  jobs = store.removeJob(jobs, 'rm');
  A.eq(jobs.length, 1, 'removeJob deletes one');
  A.eq(jobs[0].id, 'keep', 'the other job survives');
}

// ---- 14. loadEnvelope: fail-closed + drops malformed records + parses a string ----
{
  A.eq(store.loadEnvelope(null), { version: 1, jobs: [] }, 'null -> empty store (fail-closed)');
  A.eq(store.loadEnvelope('not json'), { version: 1, jobs: [] }, 'garbage string -> empty store');
  A.eq(store.loadEnvelope({ jobs: 'nope' }), { version: 1, jobs: [] }, 'jobs not an array -> empty store');
  const env = store.loadEnvelope({ version: 1, jobs: [{ id: 'good' }, { id: 'bad id!' }, null, { noId: true }] });
  A.eq(env.jobs.length, 1, 'malformed job records dropped');
  A.eq(env.jobs[0].id, 'good', 'the valid record survives');
  const parsed = store.loadEnvelope(JSON.stringify({ version: 1, jobs: [{ id: 'fromstring' }] }));
  A.eq(parsed.jobs[0].id, 'fromstring', 'a JSON string is parsed');
}

// ---- 15. END-TO-END with planTick: create -> plan fires -> apply advance -> markRun -> no double-fire ----
{
  const c = makeClock(T0);
  let jobs = store.createJob([], { id: 'e2e', schedule: cron.parseSchedule('every 1h', c.now()) }, { now: c.now() });
  A.eq(cron.planTick(jobs, c.now()).fire.length, 0, 'not due at t0');
  c.advance(HOUR);
  const plan = cron.planTick(jobs, c.now());
  A.eq(plan.fire.length, 1, 'due after one period -> fires');
  // host applies the advance BEFORE launching (advance-before-run)
  jobs = jobs.map(j => j.id === 'e2e' ? Object.assign({}, j, { nextRunAt: iso(plan.next[0].nextAt) }) : j);
  A.eq(cron.planTick(jobs, c.now()).fire.length, 0, 'after advance, the same instant does not double-fire');
  // run completes -> markRun (success leaves the advanced nextRunAt)
  jobs = store.markRun(jobs, 'e2e', { runId: 'r', status: 'ok', reason: 'done' }, { now: c.now() });
  A.eq(store.getJob(jobs, 'e2e').nextRunAt, iso(plan.next[0].nextAt), 'markRun preserves the advanced next-fire');
  c.advance(HOUR);
  A.eq(cron.planTick(jobs, c.now()).fire.length, 1, 'fires again at the next period');
}

// ---- 16. R3 provenance: meta.recipeId round-trips through create -> update -> markRun -> envelope ----
{
  // create with a meta bag: it is normalized to a plain object and carried on the record.
  let jobs = store.createJob([], {
    id: 'prov1', name: 'from a recipe', schedule: cron.parseSchedule('0 9 * * *', Date.parse('2026-06-19T08:00:00Z')),
    meta: { recipeId: 'morning-brief', extra: 'kept' }
  }, { now: Date.parse('2026-06-19T08:00:00Z') });
  A.eq(store.getJob(jobs, 'prov1').meta.recipeId, 'morning-brief', 'meta.recipeId is carried onto the created job');
  A.eq(store.getJob(jobs, 'prov1').meta.extra, 'kept', 'other meta keys are preserved (shallow clone)');

  // a job with NO meta loads as null (never breaks an existing/pre-R3 job).
  const noMeta = store.createJob([], { id: 'nom', schedule: null }, { now: T0 });
  A.eq(store.getJob(noMeta, 'nom').meta, null, 'a job with no meta -> meta:null (tolerated absence)');

  // garbage meta is rejected to null (not an object / an array / empty).
  A.eq(store.makeJob({ id: 'g1', meta: 'nope' }, { now: T0 }).meta, null, 'a string meta -> null');
  A.eq(store.makeJob({ id: 'g2', meta: [1, 2] }, { now: T0 }).meta, null, 'an array meta -> null');
  A.eq(store.makeJob({ id: 'g3', meta: {} }, { now: T0 }).meta, null, 'an empty meta object -> null');

  // meta survives an editable-field update (updateJob copies the record; meta is not an editable field but persists).
  jobs = store.updateJob(jobs, 'prov1', { name: 'renamed' }, { now: T0 });
  A.eq(store.getJob(jobs, 'prov1').meta.recipeId, 'morning-brief', 'meta survives an updateJob (name edit)');

  // meta survives a markRun settlement.
  jobs = store.markRun(jobs, 'prov1', { runId: 'r', status: 'ok', reason: 'done' }, { now: Date.parse('2026-06-19T09:00:00Z') });
  A.eq(store.getJob(jobs, 'prov1').meta.recipeId, 'morning-brief', 'meta survives a markRun');

  // meta survives a persist round-trip (toEnvelope -> JSON -> loadEnvelope).
  const round = store.loadEnvelope(JSON.parse(JSON.stringify(store.toEnvelope(jobs))));
  const back = round.jobs.find(j => j.id === 'prov1');
  A.eq(back.meta.recipeId, 'morning-brief', 'meta.recipeId round-trips through the persistence envelope');

  // a legacy record with a meta field already on disk loads intact (loadEnvelope keeps well-formed rows verbatim).
  const legacy = store.loadEnvelope({ version: 1, jobs: [{ id: 'legacy', meta: { recipeId: 'x' } }] });
  A.eq(legacy.jobs[0].meta.recipeId, 'x', 'an on-disk record carrying meta loads intact');
}

// ---- MISFIRE + DELIVERY OUTCOME (2026-07-15 reliability audit) ----
{
  const T = 1700000000000;
  const mk = (spec) => store.makeJob(Object.assign({ id: 'm1', prompt: 'p', schedule: { kind: 'interval', minutes: 60, display: 'every 1h' } }, spec || {}), { id: 'm1', now: T });

  // misfire normalizes at creation: valid values kept, garbage -> null (schedule-derived default at plan time).
  A.eq(mk().misfire, null, 'misfire defaults to null (derive from the schedule)');
  A.eq(mk({ misfire: 'fire_once' }).misfire, 'fire_once', 'misfire fire_once persists');
  A.eq(mk({ misfire: 'skip' }).misfire, 'skip', 'misfire skip persists');
  A.eq(mk({ misfire: 'bogus' }).misfire, null, 'an unknown misfire value can never persist');

  // misfire is editable and re-normalized on update.
  let jobs = [mk()];
  jobs = store.updateJob(jobs, 'm1', { misfire: 'fire_once' }, { now: T });
  A.eq(store.getJob(jobs, 'm1').misfire, 'fire_once', 'updateJob sets misfire');
  jobs = store.updateJob(jobs, 'm1', { misfire: 'whatever' }, { now: T });
  A.eq(store.getJob(jobs, 'm1').misfire, null, 'updateJob normalizes a bogus misfire to null');

  // markDelivery records the last notification attempt separately from the run outcome.
  A.eq(store.getJob(jobs, 'm1').lastDeliveryOk, null, 'fresh job has no delivery record');
  jobs = store.markDelivery(jobs, 'm1', { ok: true, channel: 'telegram' }, { now: T + 1000 });
  let j = store.getJob(jobs, 'm1');
  A.eq([j.lastDeliveryOk, j.lastDeliveryError], [true, null], 'a delivered ping records ok with no error');
  A.ok(j.lastDeliveryAt, 'delivery timestamp stamped');
  jobs = store.markDelivery(jobs, 'm1', { ok: false, error: 'rate limited', channel: 'discord' }, { now: T + 2000 });
  j = store.getJob(jobs, 'm1');
  A.eq(j.lastDeliveryOk, false, 'a failed ping records ok:false');
  A.ok(/rate limited/.test(j.lastDeliveryError) && /discord/.test(j.lastDeliveryError), 'the failure carries the error + channel');
  A.eq(store.markDelivery(jobs, 'nope', { ok: true }, { now: T }), jobs.map(x => x), 'markDelivery on an absent job is a no-op');
}

/* ---- triggerJob: make a job due on the NEXT tick, and never lie about when that is -------------------
   The bug this locks was live: routine.manage's run_now originally used resumeJob, which re-anchors the
   SCHEDULE rather than stamping a due time. For `0 9 * * *` that recomputes 09:00 tomorrow — the same value
   it already held — so the tool reported "queued to fire within a tick" about a fire a day away. */
{
  const T = Date.parse('2026-07-27T10:00:00.000Z');
  let jobs = [];
  jobs = store.createJob(jobs, { name: 'Morning', prompt: 'p', schedule: cron.parseSchedule('0 9 * * *', T), agentId: 'a' }, { id: 'tg1', now: T });
  const armed = store.getJob(jobs, 'tg1').nextRunAt;
  A.eq(armed, '2026-07-28T09:00:00.000Z', 'a 09:00 cron job created at 10:00 is armed for TOMORROW 09:00');

  // resumeJob is NOT a trigger — it recomputes the same wall-clock occurrence.
  A.eq(store.getJob(store.resumeJob(jobs, 'tg1', { now: T }), 'tg1').nextRunAt, armed,
    'resumeJob re-anchors the schedule and yields the SAME next occurrence (this is why it cannot be a trigger)');

  // triggerJob stamps NOW, which planTick reads back as already-due.
  const fired = store.triggerJob(jobs, 'tg1', { now: T });
  A.eq(store.getJob(fired, 'tg1').nextRunAt, '2026-07-27T10:00:00.000Z', 'triggerJob stamps the next fire at NOW');
  A.eq(store.getJob(fired, 'tg1').state, 'scheduled', 'a triggered job is scheduled');
  A.eq(store.getJob(fired, 'tg1').enabled, true, 'a triggered job is enabled');
  A.eq(cron.planTick(fired, T, {}).fire.map(f => f.jobId), ['tg1'], 'the triggered job is DUE on the very next tick');
  A.eq(cron.planTick(jobs, T, {}).fire.length, 0, 'the untriggered job is not due at the same instant');

  // a PAUSED job asked to fire is un-paused rather than silently doing nothing
  {
    const paused = store.pauseJob(jobs, 'tg1');
    A.eq(store.getJob(paused, 'tg1').enabled, false, 'precondition: paused');
    const t = store.triggerJob(paused, 'tg1', { now: T });
    A.eq(store.getJob(t, 'tg1').enabled, true, 'triggering a paused routine un-pauses it (never a silent no-op)');
    A.eq(cron.planTick(t, T, {}).fire.map(f => f.jobId), ['tg1'], 'and it then actually fires');
  }

  // a SETTLED one-shot can never fire again — do not promise it will
  {
    let once = store.createJob([], { name: 'One', prompt: 'p', schedule: cron.parseSchedule('in 1h', T), agentId: 'a' }, { id: 'tg2', now: T });
    once = store.markRun(once, 'tg2', { ok: true, runId: 'r1' }, { now: T + 1000 });
    A.ok(store.getJob(once, 'tg2').lastRunAt, 'precondition: the one-shot has settled');
    const t = store.triggerJob(once, 'tg2', { now: T + 2000 });
    A.eq(store.getJob(t, 'tg2').nextRunAt, store.getJob(once, 'tg2').nextRunAt,
      'a settled one-shot is left untouched — planTick would never fire it, so stamping it due would be a false promise');
    A.eq(cron.planTick(t, T + 2000, {}).fire.length, 0, 'and it stays not-due');
  }

  A.eq(store.triggerJob(jobs, 'nope', { now: T }), jobs.map(x => x), 'triggerJob on an absent job is a no-op');
}

/* ---- the HOST TIMEZONE reaches the persisted first fire -------------------------------------------
   armAt dropped the tz, so cron.js resolved a tz-less schedule against 'UTC'. The DRIVER plans with the real
   host zone and planTick's dueAtOf PREFERS the persisted nextRunAt, so the UTC-anchored stamp became the real
   FIRST fire instant: on America/New_York, "every morning" (0 9 * * *) was previewed for today 09:00 and
   persisted as tomorrow 05:00 local — it fired ~20 hours late at 5am and only settled onto the correct local
   09:00 from the SECOND fire onward. Every tz-less creation path hit it (marketplace MAKE ROUTINE,
   routine.create without `timezone`, the /routine action), plus every un-pause and error re-arm. */
{
  const TZ = 'America/New_York';
  const now = Date.parse('2026-07-28T12:00:00Z');
  const sched = cron.parseSchedule('0 9 * * *', now);        // exactly what POST /api/cron produces with no body.tz
  const preview = cron.nextFireAt(sched, null, now, { defaultTz: TZ });   // what the picker shows the user

  const jobs = store.createJob([], { id: 'tz1', name: 'brief', prompt: 'x', schedule: sched }, { id: 'tz1', now, defaultTz: TZ });
  A.eq(Date.parse(jobs[0].nextRunAt), preview, 'the PERSISTED first fire equals the preview the user was shown');
  A.eq(new Date(jobs[0].nextRunAt).toISOString(), '2026-07-28T13:00:00.000Z', 'which is 09:00 EDT TODAY, not 05:00 tomorrow');

  // un-pause re-anchors with the zone too
  const paused = store.pauseJob(jobs, 'tz1');
  const resumed = store.resumeJob(paused, 'tz1', { now, defaultTz: TZ });
  A.eq(Date.parse(store.getJob(resumed, 'tz1').nextRunAt), preview, 'resumeJob re-anchors on the HOST zone');

  // and a schedule re-anchor through updateJob
  const updated = store.updateJob(jobs, 'tz1', { schedule: cron.parseSchedule('0 9 * * *', now) }, { now, defaultTz: TZ });
  A.eq(Date.parse(store.getJob(updated, 'tz1').nextRunAt), preview, 'updateJob re-anchors on the HOST zone');

  // an EXPLICIT schedule tz still wins over the host default (it always did — prove it did not regress)
  const explicit = cron.parseSchedule('0 9 * * *', now, 'Europe/Berlin');
  const ej = store.createJob([], { id: 'tz2', name: 'b', prompt: 'x', schedule: explicit }, { id: 'tz2', now, defaultTz: TZ });
  A.eq(Date.parse(ej[0].nextRunAt), cron.nextFireAt(explicit, null, now, { defaultTz: TZ }), 'an explicit schedule.tz is unaffected by the host default');

  // a caller that injects nothing is byte-identical to before (UTC) — no silent behavior change for them
  const utc = store.createJob([], { id: 'tz3', name: 'b', prompt: 'x', schedule: sched }, { id: 'tz3', now });
  A.eq(new Date(utc[0].nextRunAt).toISOString(), '2026-07-29T09:00:00.000Z', 'with no injected zone the old UTC anchor is unchanged');
}

// ---- Runtime parity fields are normalized, durable, and output is data rather than editable config. ----
{
  let jobs = store.createJob([], {
    id: 'runtime1', schedule: cron.parseSchedule('every 1h', T0), noAgent: true, script: 'check.js',
    skills: ['Research', 'Research', '', '../bad'], contextFrom: ['upstream', 'upstream', 'bad id'],
    enabledToolsets: ['web', 'web', 'cabinet'], attachToSession: true,
    origin: { channel: 'dev', chatId: 'chat-1', threadId: 'topic-2' }
  }, { now: T0 });
  const j = jobs[0];
  A.eq(j.noAgent, true, 'script-only mode persists');
  A.eq(j.skills, ['Research'], 'skills are bounded/deduplicated and unsafe refs dropped');
  A.eq(j.contextFrom, ['upstream'], 'context refs are valid ids and deduplicated');
  A.eq(j.enabledToolsets, ['web', 'cabinet'], 'per-job toolsets preserve explicit restriction');
  A.eq(j.origin.threadId, 'topic-2', 'delivery origin preserves topic routing');
  jobs = store.markRun(jobs, 'runtime1', { runId: 'r1', status: 'ok', reason: 'done', output: 'upstream result' }, { now: T0 + HOUR });
  A.eq(store.getJob(jobs, 'runtime1').lastOutput, 'upstream result', 'successful final output persists for context pipelines');
}

// ---- G7 monitor/config/notepad receipts are bounded, pure, and survive the envelope. ----
{
  let jobs = store.createJob([], {
    id: 'g7', schedule: cron.parseSchedule('every 1h', T0), monitorMode: true, contextFrom: ['source']
  }, { now: T0 });
  A.eq(jobs[0].monitorMode, true, 'monitor mode is durable opt-in state');
  A.eq(jobs[0].monitorHash, null, 'a new monitor has no claimed source hash');
  jobs = store.markBlockedConfig(jobs, 'g7', { fingerprint: 'fp1', reason: 'connect provider', alerted: true }, { now: T0 + 1 });
  A.eq(jobs[0].state, 'blocked_config', 'configuration failure gets a distinct durable state');
  A.ok(jobs[0].blockedConfig.alertedAt, 'the first actionable alert is durably receipted');
  const firstAlert = jobs[0].blockedConfig.alertedAt;
  jobs = store.markBlockedConfig(jobs, 'g7', { fingerprint: 'fp1', reason: 'connect provider', alerted: false }, { now: T0 + 2 });
  A.eq(jobs[0].blockedConfig.alertedAt, firstAlert, 'the same configuration fingerprint preserves one alert receipt');
  jobs = store.clearBlockedConfig(jobs, 'g7');
  A.eq(jobs[0].blockedConfig, null, 'valid configuration clears the block');
  jobs = store.setNotepad(jobs, 'g7', 'x'.repeat(9000), { now: T0 + 3 });
  A.eq(jobs[0].notepad.length, 8000, 'job notepad is hard-bounded');
  jobs = store.markRun(jobs, 'g7', { runId: 'g7-run', status: 'ok', reason: 'done', output: 'changed', monitorHash: 'sha256:new' }, { now: T0 + HOUR });
  A.eq(jobs[0].monitorHash, 'sha256:new', 'only a successful settlement commits the observed source hash');
  const loaded = store.loadEnvelope(JSON.stringify(store.toEnvelope(jobs))).jobs[0];
  A.eq({ monitorHash: loaded.monitorHash, note: loaded.notepad, blocked: loaded.blockedConfig },
    { monitorHash: 'sha256:new', note: 'x'.repeat(8000), blocked: null }, 'monitor and isolated scratch state survive restart loading');
}

// ---- SETTLED ONE-SHOT HONESTY (bug-sweep 2026-08-28) ----
// resumeJob must NOT re-arm a completed one-shot: planTick permanently rejects it on lastRunAt, so the old
// re-arm promised "scheduled · next <past>" about a fire that could never happen. An explicit NEW once
// schedule via updateJob IS a fresh commitment and re-arms honestly.
{
  const sched = cron.parseSchedule('in 1m', T0);
  let jobs = store.createJob([], { id: 'os1', name: 'one', prompt: 'p', schedule: sched }, { id: 'os1', now: T0 });
  jobs = store.markRun(jobs, 'os1', { runId: 'r1', status: 'ok', reason: 'done', output: 'done!' }, { now: T0 + MIN });
  A.eq({ enabled: jobs[0].enabled, state: jobs[0].state }, { enabled: false, state: 'completed' }, 'the one-shot settled');

  const resumed = store.resumeJob(jobs, 'os1', { now: T0 + HOUR });
  A.eq(resumed[0], jobs[0], 'resumeJob leaves a settled one-shot untouched (no dead "scheduled" promise)');

  const fresh = cron.parseSchedule('in 2h', T0 + HOUR);
  let regened = store.updateJob(jobs, 'os1', { schedule: fresh }, { now: T0 + HOUR });
  A.eq(regened[0].lastRunAt, null, 'an explicit NEW once schedule clears the settled bar (fresh commitment)');
  A.eq(regened[0].fireClaim, null, 'the old fire-claim cannot suppress the new commitment');
  A.eq(regened[0].state, 'paused', 'still disabled -> honestly paused (re-armable), never a stale completed');
  regened = store.resumeJob(regened, 'os1', { now: T0 + HOUR });
  A.eq(regened[0].enabled, true, 'resume after a real reschedule re-arms');
  A.eq(regened[0].nextRunAt, iso(T0 + HOUR + 2 * HOUR), 'and the new time is the one that arms');
  A.eq(cron.planTick(regened, T0 + HOUR + 2 * HOUR + 1).fire.length, 1, 'planTick fires the recommitted one-shot');
}

// ---- armAt NaN safety (bug-sweep 2026-08-28): a corrupt schedule arms to null, never throws iso(NaN) ----
{
  const bad = { kind: 'interval', minutes: NaN, display: 'every NaN' };
  let jobs = store.createJob([], { id: 'nn1', name: 'n', prompt: 'p', schedule: bad }, { id: 'nn1', now: T0 });
  A.eq(jobs[0].nextRunAt, null, 'a NaN-period schedule arms to null instead of throwing');
  const resumed = store.resumeJob(jobs, 'nn1', { now: T0 + MIN });
  A.eq(resumed[0].nextRunAt, null, 'resume over the corrupt schedule also arms to null, no throw');
  A.eq(cron.isFireable(bad), false, 'isFireable now rejects the schedule (visible as unfireable, not idle-forever)');
}

{
  let jobs = store.createJob([], { id: 'delivery-proof', schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
  jobs = store.markRun(jobs, 'delivery-proof', { status: 'ok', runId: 'a', output: 'first' }, { now: T0 });
  jobs = store.markDelivery(jobs, 'delivery-proof', { ok: false, runId: 'a', deliveredTargets: ['good'] }, { now: T0 });
  jobs = store.markRun(jobs, 'delivery-proof', { status: 'ok', runId: 'b', output: 'second' }, { now: T0 + 1000 });
  jobs = store.markDelivery(jobs, 'delivery-proof', { ok: true }, { now: T0 + 2000 });
  A.eq(store.pendingDeliveries(jobs[0]).length, 2, 'an uncorrelated notifier cannot acknowledge pending receipts');
  jobs = store.loadEnvelope(JSON.stringify(store.toEnvelope(jobs))).jobs;
  A.eq(jobs[0].deliveryBacklog[0].deliveredTargets, ['good'], 'partial fanout acknowledgements survive restart');
  A.eq(jobs[0].deliveryBacklog[0].nextAttemptAt, iso(T0 + MIN), 'delivery retry deadline survives restart');
  jobs = store.markDelivery(jobs, 'delivery-proof', { ok: true, runId: 'a' }, { now: T0 + MIN });
  A.eq(store.pendingDeliveries(jobs[0]).map(f => f.runId), ['b'], 'acknowledgement affects only the matching occurrence');
}

A.report('cron-store');
