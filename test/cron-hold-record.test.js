/* node test/cron-hold-record.test.js — a HELD scheduled fire leaves a receipt on the routine's record (ops-1115 T1, W6).

   The W3.1 unattended hold returned before markRun, so a held routine's card kept its last green ok and nothing on the
   record said it had been held. Now the held fire writes the additive job.lastHold = { at, binding, say } (cron-store
   markHeld; a one-shot's in the same releaseHeldOnce write), and the next real fire removes it (markRun). lastStatus, the
   failure streak, nextRunAt and NEEDS YOU are untouched: a hold is not a failure.

   Red at 45e7ee302 (no lastHold); green after. The real cron-driver and cron-store, the unattended-hold.test.js tickAt
   shape (admitUnattended returning the host's hold shape). */
'use strict';
const A = require('./_assert.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');

const T0 = Date.UTC(2026, 10, 9, 8, 0, 0), MIN = 60000;
const iso = ms => new Date(ms).toISOString();
const HOLD = { ok: false, binding: 'window-reserve', say: 'held: the 5-hour window is at 92%' };
const flush = () => new Promise(r => setImmediate(r));

// ONE driver over `jobs`; tick(at) runs a pass at `at`. hold() decides each fire's admission (null admits).
function rig(jobs, hold) {
  const s = { jobs, runs: [], admits: [], writes: 0 };
  let n = 0, at = T0;
  s.hold = hold;
  s.driver = makeCronDriver({
    getJobs: () => s.jobs, setJobs: (j) => { s.writes++; s.jobs = j; return true; },
    runOnce: (o) => { s.runs.push(o); return s.settle ? s.settle(o) : new Promise(() => {}); },
    emit: () => {}, newId: () => 'fire-' + (++n), newAbort: () => new AbortController(), now: () => at,
    getKey: () => 'sk', defaultModel: 'm', persona: 'P', maxRunMs: 8 * MIN,
    admitUnattended: (job) => { s.admits.push(job.id); return s.hold ? s.hold(job) : null; }
  });
  s.tick = (ms) => { at = ms; const w = s.writes; const r = s.driver.applyTick(ms); r.writes = s.writes - w; return r; };
  s.job = (id) => cronStore.getJob(s.jobs, id) || {};
  return s;
}
const hourlyJob = () => cronStore.makeJob({ id: 'hourly', prompt: 'tidy the inbox', agentId: 'agent', schedule: cron.parseSchedule('every 1h', T0) }, { id: 'hourly', now: T0 });
const okRun = (o) => { o.emit('agent.token', { delta: 'tidied' }); o.emit('agent.run.end', { runId: o.runId, reason: 'done', outcome: 'succeeded' }); return Promise.resolve({ text: 'tidied' }); };

(async () => {
  /* ---- RED: a held tick writes lastHold and leaves the routine's result, streak and schedule as the advance left them ---- */
  {
    const seed = Object.assign(hourlyJob(), { lastStatus: 'ok', lastRunAt: iso(T0 - 30 * MIN), consecutiveFailures: 0 });
    const free = rig([seed], () => null);   // the same tick, admitted: the advance-before-run values
    free.tick(T0 + 60 * MIN);
    const held = rig([seed], () => HOLD);
    const r = held.tick(T0 + 60 * MIN);
    A.eq([r.fired, held.admits], [0, ['hourly']], 'the fire was asked and held');
    A.eq(held.job('hourly').lastHold, { at: iso(T0 + 60 * MIN), binding: 'window-reserve', say: 'held: the 5-hour window is at 92%' }, 'the record says it was held, when, and by what');
    A.eq([held.job('hourly').lastStatus, held.job('hourly').consecutiveFailures, held.job('hourly').nextRunAt],
      ['ok', 0, free.job('hourly').nextRunAt], 'lastStatus, the failure streak and nextRunAt are exactly the advance-before-run values');
    A.eq(held.job('hourly').lastRunAt, iso(T0 - 30 * MIN), 'a hold is no run: lastRunAt is untouched');
  }

  /* ---- LIVENESS: an identical recurring hold writes once; a different hold writes again ---- */
  {
    const s = rig([hourlyJob()], () => HOLD);
    const a = s.tick(T0 + 60 * MIN), b = s.tick(T0 + 120 * MIN), c = s.tick(T0 + 180 * MIN);
    A.eq([a.writes - b.writes, b.writes - c.writes], [1, 0], 'liveness: the first hold costs one extra write; an identical recheck none (' + [a.writes, b.writes, c.writes] + ')');
    A.eq(s.job('hourly').lastHold.at, iso(T0 + 60 * MIN), 'liveness: an identical hold keeps its first time');
    s.hold = () => ({ ok: false, binding: 'rail', say: 'held: unattended work used its daily allowance' });
    const d = s.tick(T0 + 240 * MIN);
    A.eq(d.writes, a.writes, 'liveness: a different hold is written once more');
    A.eq([s.job('hourly').lastHold.binding, s.job('hourly').lastHold.at], ['rail', iso(T0 + 240 * MIN)], 'liveness: and the record names the new hold');
  }

  /* ---- LIVENESS: a later real fire removes lastHold (the key is absent) ---- */
  {
    const s = rig([hourlyJob()], () => HOLD);
    s.tick(T0 + 60 * MIN);
    A.ok(!!s.job('hourly').lastHold, 'held first');
    s.hold = () => null;
    s.settle = okRun;
    s.tick(T0 + 120 * MIN);
    for (let i = 0; i < 10; i++) await flush();
    A.eq(s.job('hourly').lastStatus, 'ok', 'liveness: the next fire ran and settled ok');
    A.eq(Object.prototype.hasOwnProperty.call(s.job('hourly'), 'lastHold'), false, 'liveness: its settlement removed lastHold (absent, not null)');
  }

  /* ---- LIVENESS: a v0.15.0 job (no lastHold) loads and fires, and its settlement adds no lastHold key ---- */
  {
    const v150 = { version: 1, jobs: [{
      id: 'old', name: 'old routine', prompt: 'summarise', agentId: 'agent', schedule: { kind: 'interval', minutes: 60, display: 'every 1h' },
      scheduleDisplay: 'every 1h', enabled: true, state: 'scheduled', createdAt: iso(T0), nextRunAt: iso(T0 + 60 * MIN),
      lastRunAt: null, lastStatus: null, lastError: null, retryCount: 0, consecutiveFailures: 0, repeat: { times: null, completed: 0 },
      fireClaim: null, heartbeatAt: null, skills: [], unattendedGrants: [], meta: null } ] };
    const loaded = cronStore.loadEnvelope(JSON.stringify(v150));
    A.eq(loaded.jobs.length, 1, 'liveness: the v0.15.0 store loads');
    const s = rig(loaded.jobs, () => null);
    s.settle = okRun;
    const r = s.tick(T0 + 60 * MIN);
    for (let i = 0; i < 10; i++) await flush();
    A.eq(r.fired, 1, 'liveness: it fires');
    A.eq(s.job('old').lastStatus, 'ok', 'liveness: and settles ok');
    A.eq(Object.prototype.hasOwnProperty.call(s.job('old'), 'lastHold'), false, 'liveness: a record that never held carries no lastHold key');
    const back = cronStore.loadEnvelope(JSON.stringify(cronStore.toEnvelope(cronStore.markHeld(s.jobs, 'old', HOLD, { now: T0 + 2 * 60 * MIN }))));
    A.eq(cronStore.getJob(back.jobs, 'old').lastHold.binding, 'window-reserve', 'liveness: lastHold round-trips the store envelope');
  }

  /* ---- LIVENESS: a held ONE-SHOT rechecked on three consecutive minutes writes lastHold once, inside the release write ---- */
  {
    const once = cronStore.makeJob({ id: 'once', prompt: 'write the note', agentId: 'agent', schedule: cron.parseSchedule('in 5m', T0) }, { id: 'once', now: T0 });
    const base = rig([once], () => HOLD);
    const a = base.tick(T0 + 5 * MIN);
    A.eq([a.fired, base.job('once').fireClaim, base.job('once').nextRunAt], [0, null, iso(T0 + 6 * MIN)], 'liveness: the held one-shot is released and rechecked in a minute, as before');
    A.eq(base.job('once').lastHold, { at: iso(T0 + 5 * MIN), binding: 'window-reserve', say: 'held: the 5-hour window is at 92%' }, 'the held one-shot names its hold');
    const b = base.tick(T0 + 6 * MIN), c = base.tick(T0 + 7 * MIN);
    A.eq([a.writes, b.writes, c.writes], [2, 2, 2], 'liveness: each recheck is the claim and the release, no extra write for the receipt');
    A.eq(base.job('once').lastHold.at, iso(T0 + 5 * MIN), 'liveness: three identical holds keep the first time');
  }

  /* ---- reducers: markHeld clips, dedupes and leaves other jobs alone ---- */
  {
    const jobs = [hourlyJob(), cronStore.makeJob({ id: 'other', prompt: 'x', agentId: 'agent', schedule: cron.parseSchedule('every 1h', T0) }, { id: 'other', now: T0 })];
    const long = cronStore.markHeld(jobs, 'hourly', { binding: 'b'.repeat(100), say: 's'.repeat(400) }, { now: T0 });
    A.eq([cronStore.getJob(long, 'hourly').lastHold.binding.length, cronStore.getJob(long, 'hourly').lastHold.say.length], [60, 240], 'markHeld clips binding to 60 and say to 240');
    A.eq(Object.prototype.hasOwnProperty.call(cronStore.getJob(long, 'other'), 'lastHold'), false, 'markHeld touches only its job');
    const again = cronStore.markHeld(long, 'hourly', { binding: 'b'.repeat(100), say: 's'.repeat(400) }, { now: T0 + MIN });
    A.ok(cronStore.getJob(again, 'hourly') === cronStore.getJob(long, 'hourly'), 'markHeld returns the job unchanged for the same hold');
  }

  A.report('cron-hold-record');
})().catch(e => { console.error(e); process.exitCode = 1; A.report('cron-hold-record'); });
