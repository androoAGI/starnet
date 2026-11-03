/* node test/cron.delivery-backlog.test.js — the first boot after an upgrade never floods a chat with stale routine results.

   0.13.x sent a routine's reply as ONE message. Every digest past Telegram's 4096 characters was refused ("message is
   too long") on the fire and on every retry, so it stayed `pending` in cron.jobs.json for good, and each later fire
   queued another one behind it (up to 100 per routine). 0.14 splits long replies, so ALL of them became deliverable at
   once: the first boot sent weeks of old digests, several routines' parts interleaved in one chat.

   This loads a 0.13.5-shaped cron.jobs.json (the exact receipt shape 0.13.5's markRun/markDelivery wrote) into the
   real driver and proves, off the deliveries the host is asked to make:
     1. a routine's backlog for one chat collapses to its NEWEST result, delivered once, carrying how many earlier
        results it replaces; the older receipts are closed as superseded and never sent;
     2. a routine the Commander PAUSED sends nothing until it is resumed — then one result, not its backlog; but (2b, review 7.1) a
        RUN NOW the Commander pressed on it while paused delivers its result at once, and retries it while the routine stays paused;
     3. a completed one-shot (not paused) still delivers its result;
     4. a result whose send is already in flight is never superseded (it may already have landed);
     5. a supersede that cannot reach disk sends nothing (retried on a later pass);
     6. a [SILENT] fire never swallows a real result still waiting before it (a monitor's alert in backoff);
     7. a send already in flight never takes over an older result that then fails: the older one is retried;
     8. a failure notice never replaces a real result (both reach the chat, the result first);
     9. a chat that refuses every message still holds the routine back at MAX_PENDING_DELIVERIES: one collapsed
        receipt stands for every result it superseded, so the routine stops spending instead of firing forever. */
'use strict';
const A = require('./_assert.js');
const { makeClock } = require('../shared/clock-rng.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');

const DAY = 86400000;
const T0 = Date.parse('2026-10-23T09:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const flush = () => new Promise(r => setImmediate(r));
const LONG = n => 'DIGEST ' + n + '\n' + Array.from({ length: 160 }, (_, i) => 'item ' + i + ' of the overnight digest with its details').join('\n');

// One receipt exactly as 0.13.5 left it after weeks of "message is too long".
function receipt(jobId, runId, daysAgo, origin) {
  return {
    id: runId + ':final', runId: runId, state: 'pending', outcome: 'ok', result: LONG(runId), error: null, usd: 0.02,
    deliver: 'origin', origin: origin,
    deliveryContext: { name: jobId, prompt: 'digest', agentId: 'agent', noAgent: false, attachToSession: false },
    destination: 'origin', committedAt: iso(T0 - daysAgo * DAY), attempts: 40,
    deliveredAt: null, lastError: 'Bad Request: message is too long', deliveredTargets: [],
    nextAttemptAt: iso(T0 - daysAgo * DAY + 900000)
  };
}
function job(id, backlog, extra) {
  const base = cronStore.makeJob({ id, name: id, prompt: 'digest', agentId: 'agent', schedule: cron.parseSchedule('0 9 * * *', T0 - 40 * DAY), deliver: 'origin', origin: CHAT }, { id, now: T0 - 40 * DAY });
  const all = backlog.slice();
  return Object.assign(base, { deliveryBacklog: all.slice(0, -1), finalization: all[all.length - 1] || null, lastDeliveryOk: false, lastDeliveryError: 'Bad Request: message is too long' }, extra || {});
}
const CHAT = { target: null, channel: 'telegram', chatId: '777', threadId: null, sessionId: null, streamId: null, sessionTitle: null };

function seed() {
  const jobs = [
    job('daily', [receipt('daily', 'd-21', 21, CHAT), receipt('daily', 'd-14', 14, CHAT), receipt('daily', 'd-1', 1, CHAT)]),
    job('market', [receipt('market', 'm-9', 9, CHAT), receipt('market', 'm-2', 2, CHAT)]),
    job('paused', [receipt('paused', 'p-30', 30, CHAT), receipt('paused', 'p-29', 29, CHAT)], { enabled: false, state: 'paused', disabledReason: 'paused', nextRunAt: null }),
    job('once', [receipt('once', 'o-5', 5, CHAT)], { schedule: cron.parseSchedule('in 1m', T0 - 6 * DAY), enabled: false, state: 'completed', nextRunAt: null, lastRunAt: iso(T0 - 5 * DAY) })
  ];
  // through the real envelope round trip, the way the sidecar boots it off disk
  return cronStore.loadEnvelope(JSON.stringify({ version: 1, jobs })).jobs;
}

function setup(jobs, opts) {
  opts = opts || {};
  const clock = makeClock(T0);
  let store = jobs.slice();
  let failPersist = false;
  const sent = [];
  const driver = makeCronDriver({
    getJobs: () => store,
    setJobs: (j) => { if (failPersist) return false; store = j; return true; },
    runOnce: () => Promise.resolve(),
    emit: () => {}, newId: () => 'run-x', newAbort: () => new AbortController(), now: () => clock.now(),
    getKey: () => 'sk-test', defaultModel: 'test/model', persona: 'PERSONA',
    // mirrors index.js deliverCronResult: a silent outcome sends nothing and acknowledges
    deliverResult: opts.deliverResult || ((j, result) => { if (result.outcome === 'silent') return { ok: true, skipped: true }; sent.push({ jobId: j.name, runId: result.runId, superseded: result.superseded, text: result.text }); return { ok: true, deliveredTargets: ['@origin'] }; })
  });
  return { driver, clock, sent, getJob: id => cronStore.getJob(store, id), setStore: fn => { store = fn(store); }, setFailPersist: v => { failPersist = v; } };
}

(async function () {
  // ---- 1-3. the upgrade boot: one current result per routine, paused routines wait ----
  {
    const s = setup(seed());
    await s.driver.recoverFinalizations(); await flush();
    const byJob = id => s.sent.filter(x => x.jobId === id);
    A.eq(byJob('daily').map(x => x.runId), ['d-1'], 'a routine with three stuck digests delivers only its newest one');
    A.eq(byJob('daily')[0] && byJob('daily')[0].superseded, 2, 'and that delivery knows two earlier results are not coming');
    A.eq(byJob('market').map(x => x.runId), ['m-2'], 'a second routine to the same chat also delivers only its newest result');
    A.eq(byJob('market')[0] && byJob('market')[0].superseded, 1, 'naming the one it replaces');
    A.eq(byJob('once').map(x => x.runId), ['o-5'], 'a completed one-shot (not paused) still delivers its result');
    A.eq(byJob('once')[0] && byJob('once')[0].superseded, 0, 'with nothing superseded');
    A.eq(byJob('paused').length, 0, 'a routine the Commander paused sends nothing on boot');
    A.eq(s.sent.length, 3, 'three sends in total, not one per stuck digest (' + s.sent.length + ')');

    const daily = s.getJob('daily');
    A.eq(cronStore.pendingDeliveries(daily).length, 0, 'the daily routine has nothing left to deliver');
    A.eq(daily.deliveryBacklog.length, 0, 'its superseded receipts leave the outbox');
    A.eq(daily.finalization.state, 'delivered', 'the newest receipt is durably delivered');
    A.eq(cronStore.pendingDeliveries(s.getJob('paused')).length, 2, 'the paused routine keeps both of its results');

    // later passes (every scheduler tick) send nothing more
    s.clock.set(T0 + 3600000);
    await s.driver.recoverFinalizations(); await flush();
    A.eq(s.sent.length, 3, 'later recovery passes send nothing more');

    // the Commander resumes the paused routine: one result, not its backlog
    s.setStore(jobs => cronStore.resumeJob(jobs, 'paused', { now: s.clock.now() }));
    await s.driver.recoverFinalizations(); await flush();
    A.eq(byJob('paused').map(x => x.runId), ['p-29'], 'a resumed routine delivers only its newest held result');
    A.eq(byJob('paused')[0] && byJob('paused')[0].superseded, 1, 'naming the earlier one');
  }

  // ---- 2b. RUN NOW on a routine the Commander had already paused (review 7.1): the ROUTINES button stays live on a paused routine, and
  //      that press's result is the Commander's to see now — its receipt (pausedAtStart) goes out on the settlement and, when that send
  //      failed, on the scheduler's recovery pass, while the routine's held results (another chat here) keep waiting for the resume ----
  {
    const OTHER = Object.assign({}, CHAT, { chatId: '888' });
    const s = setup([job('paused2', [receipt('paused2', 'p-30', 30, OTHER)], { enabled: false, state: 'paused', disabledReason: 'paused', nextRunAt: null })]);
    let refuse = true;
    const sends = [];
    const r = setup([job('paused3', [receipt('paused3', 'p-30', 30, OTHER)], { enabled: false, state: 'paused', disabledReason: 'paused', nextRunAt: null })], {
      deliverResult: (j, result) => { sends.push(result.runId); return refuse && result.runId === 'press' ? { ok: false, error: 'chat unreachable' } : { ok: true }; }
    });
    // the press settles through the driver with the lease handleCronRun writes for a paused routine
    s.driver.leases.set('paused2', { runId: 'press', startedAt: T0, heartbeatAt: T0, ac: new AbortController(), isOnce: false, pausedAtStart: true });
    s.driver.settleRun('paused2', 'press', { reason: 'done', buf: 'the press result' }, null);
    await flush(); await flush();
    const p2 = s.getJob('paused2');
    A.eq([p2.enabled, p2.state, p2.disabledReason], [false, 'paused', 'paused'], 'a RUN NOW pressed on a paused routine leaves the pause standing');
    A.eq(s.sent.map(x => x.runId), ['press'], 'and its result goes out at once, the held one still waits');
    A.eq(cronStore.pendingDeliveries(p2).map(f => f.runId), ['p-30'], 'the routine\'s held result stays pending for the resume');
    // its first send failed: the recovery pass retries it while the routine stays paused, never the held result
    r.driver.leases.set('paused3', { runId: 'press', startedAt: T0, heartbeatAt: T0, ac: new AbortController(), isOnce: false, pausedAtStart: true });
    r.driver.settleRun('paused3', 'press', { reason: 'done', buf: 'the press result' }, null);
    await flush(); await flush();
    A.eq(cronStore.pendingDeliveries(r.getJob('paused3')).map(f => f.runId).sort(), ['p-30', 'press'], 'a press whose send failed stays pending');
    refuse = false;
    r.clock.set(T0 + 3600000);
    await r.driver.recoverFinalizations(); await flush();
    A.eq(sends, ['press', 'press'], 'the recovery pass retries the press on the paused routine, and only the press');
    A.eq(cronStore.pendingDeliveries(r.getJob('paused3')).map(f => f.runId), ['p-30'], 'once it lands, only the held result waits');
    A.eq(cronStore.deliveriesHeld({ enabled: false, state: 'paused' }, { pausedAtStart: true }), false, 'a press on the paused routine is never held');
  }

  // ---- 1b. the direct path: a NEW run settling over an old backlog replaces it, never queues behind it ----
  {
    const s = setup(seed().filter(j => j.id === 'daily'));
    s.driver.leases.set('daily', { runId: 'fresh', startedAt: T0, heartbeatAt: T0, ac: new AbortController(), isOnce: false });
    s.driver.settleRun('daily', 'fresh', { reason: 'done', buf: 'fresh digest' }, null);
    await flush(); await flush();
    A.eq(s.sent.map(x => x.runId), ['fresh'], 'the fresh result is the only delivery');
    A.eq(s.sent[0] && s.sent[0].superseded, 3, 'and it says three earlier results are not coming');
    A.eq(cronStore.pendingDeliveries(s.getJob('daily')).length, 0, 'nothing stale stays queued');
  }

  // ---- 4. a result whose send is in flight is never superseded ----
  {
    const seen = [], releases = [];
    const hang = (j, result) => { seen.push(result.runId); return new Promise(r => { releases.push(r); }); };
    // the OLDER receipt is due while a newer one waits out its backoff: the older one is superseded, never sent
    const s = setup(seed().filter(j => j.id === 'market'), { deliverResult: hang });
    s.setStore(js => js.map(j => Object.assign({}, j, { finalization: Object.assign({}, j.finalization, { nextAttemptAt: iso(T0 + DAY) }) })));
    await s.driver.deliverFinalization(s.getJob('market'), s.getJob('market').deliveryBacklog[0]);
    A.eq(seen, [], 'an older idle result is superseded before it sends');
    A.eq(s.getJob('market').deliveryBacklog.length, 0, 'superseded, it leaves the outbox');

    // the older send is ALREADY in flight (it started before the newer result existed): it must not be superseded
    const s2 = setup(seed().filter(j => j.id === 'market'), { deliverResult: hang });
    s2.setStore(js => js.map(j => Object.assign({}, j, { finalization: null, deliveryBacklog: [j.deliveryBacklog[0]] })));
    const first = s2.driver.deliverFinalization(s2.getJob('market'), s2.getJob('market').deliveryBacklog[0]);
    await flush();
    A.eq(seen, ['m-9'], 'the older result is sending');
    s2.setStore(js => js.map(j => Object.assign({}, j, { finalization: receipt('market', 'm-2', 2, CHAT) })));
    const pass = s2.driver.recoverFinalizations(); await flush();
    A.eq(cronStore.pendingDeliveries(s2.getJob('market')).map(f => f.runId), ['m-9', 'm-2'], 'an in-flight send is never superseded');
    for (const r of releases) r({ ok: true });
    await first; await flush();
    for (const r of releases) r({ ok: true });
    await pass; await flush();
  }

  // ---- 5. a supersede that cannot reach disk sends nothing ----
  {
    const s = setup(seed().filter(j => j.id === 'daily'));
    s.setFailPersist(true);
    await s.driver.recoverFinalizations(); await flush();
    A.eq(s.sent.length, 0, 'no send while the collapse is not durable');
    A.eq(cronStore.pendingDeliveries(s.getJob('daily')).length, 3, 'the backlog is untouched');
    s.setFailPersist(false);
    await s.driver.recoverFinalizations(); await flush();
    A.eq(s.sent.map(x => x.runId), ['d-1'], 'the next pass collapses and sends the newest once');
  }

  // ---- 6. a [SILENT] fire never swallows the alert still waiting before it ----
  {
    // the alert's first send hit a transient error; it waits out its 1-minute backoff when the next fire finds nothing new
    const alert = Object.assign(receipt('mon', 'alert', 0, CHAT), { result: 'PRICE DROPPED 40% - act now', attempts: 1, lastError: 'ETIMEDOUT', nextAttemptAt: iso(T0 + 60000) });
    const s = setup([job('mon', [alert])]);
    s.driver.leases.set('mon', { runId: 'quiet', startedAt: T0, heartbeatAt: T0, ac: new AbortController(), isOnce: false });
    s.driver.settleRun('mon', 'quiet', { reason: 'done', buf: '[SILENT]' }, null);
    await flush(); await flush();
    const j = s.getJob('mon');
    A.eq(j.finalization.runId + '/' + j.finalization.outcome + '/' + j.finalization.state, 'quiet/silent/delivered', 'the quiet fire is acknowledged on its own');
    A.ok(!j.finalization.superseded, 'and carries no count: it said nothing, so it replaced nothing');
    A.eq(cronStore.pendingDeliveries(j).map(f => f.runId), ['alert'], 'the alert still waits for the chat');
    s.clock.set(T0 + 61000);
    await s.driver.recoverFinalizations(); await flush();
    A.eq(s.sent.map(x => x.text), ['PRICE DROPPED 40% - act now'], 'the alert reaches the chat once its backoff ends');
    A.eq(cronStore.pendingDeliveries(s.getJob('mon')).length, 0, 'nothing left waiting');
  }

  // ---- 7. a send already in flight never takes over an older result that fails behind it ----
  {
    const calls = [], waiters = {};
    const deliverResult = (j, r) => {
      calls.push({ runId: r.runId, superseded: r.superseded });
      if (calls.length > 2) return { ok: true, deliveredTargets: ['@origin'] };
      return new Promise(res => { waiters[r.runId] = res; });
    };
    const old = Object.assign(receipt('one', 'O', 1, CHAT), { attempts: 0, nextAttemptAt: iso(T0 - 1000) });
    const s = setup([job('one', [old])], { deliverResult });
    const sendingO = s.driver.deliverFinalization(s.getJob('one'), s.getJob('one').finalization);
    await flush();
    // a fresh fire settles while O is sending: O may land, so N leaves it alone and composes with no count
    s.driver.leases.set('one', { runId: 'N', startedAt: T0, heartbeatAt: T0, ac: new AbortController(), isOnce: false });
    s.driver.settleRun('one', 'N', { reason: 'done', buf: 'result N' }, null);
    await flush(); await flush();
    A.eq(calls.map(c => c.runId + ':' + c.superseded), ['O:0', 'N:0'], 'both are sending, N with no count');
    waiters.O({ ok: false, error: 'telegram http 502' }); await sendingO; await flush();   // O fails -> back to pending
    s.clock.set(T0 + 30000);
    const pass = s.driver.recoverFinalizations(); await flush();                        // a tick while N still sends
    A.eq(cronStore.pendingDeliveries(s.getJob('one')).map(f => f.runId), ['O', 'N'], 'a result already on the wire never takes over the failed one');
    waiters.N({ ok: true, deliveredTargets: ['@origin'] }); await pass; await flush(); await flush();
    A.ok(!s.getJob('one').finalization.superseded, 'the delivered result never claimed a count it could not say');
    s.clock.set(T0 + 3600000);
    await s.driver.recoverFinalizations(); await flush();
    A.eq(calls.map(c => c.runId), ['O', 'N', 'O'], 'the failed result is retried, not silently dropped');
    A.eq(cronStore.pendingDeliveries(s.getJob('one')).length, 0, 'and nothing is left waiting');
  }

  // ---- 8. a failure notice never replaces a real result ----
  {
    const failed = (runId, days) => Object.assign(receipt('mix', runId, days, CHAT), { outcome: 'failed', result: '', error: 'provider down ' + runId });
    const s = setup([job('mix', [receipt('mix', 'r-2', 2, CHAT), failed('f-1', 1)])]);
    await s.driver.recoverFinalizations(); await flush();
    A.eq(s.sent.map(x => x.runId), ['r-2', 'f-1'], 'the stuck result and the newer failure notice both reach the chat, the result first');
    A.eq(s.sent.map(x => x.superseded), [0, 0], 'neither replaced the other');
  }

  // ---- 9. a chat that refuses every message holds the routine back at the cap ----
  {
    const clock = makeClock(T0);
    let store = [Object.assign(cronStore.makeJob({ id: 'blocked', prompt: 'price', agentId: 'agent', schedule: cron.parseSchedule('every 1m', T0), deliver: 'origin', origin: CHAT }, { id: 'blocked', now: T0 }), { model: 'test/model' })];
    let fires = 0, n = 0, refuse = true;
    const driver = makeCronDriver({
      getJobs: () => store, setJobs: j => { store = j; return true; },
      runOnce: (o) => { fires++; o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'result ' + fires }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0.05 }); return Promise.resolve(); },
      emit: () => {}, newId: () => 'run-' + (++n), newAbort: () => new AbortController(), now: () => clock.now(),
      getKey: () => 'sk', defaultModel: 'test/model', persona: 'P',
      deliverResult: () => (refuse ? { ok: false, error: 'Forbidden: bot was blocked by the user' } : { ok: true, deliveredTargets: ['@origin'] })
    });
    let deferredTicks = 0;
    for (let i = 1; i <= cronStore.MAX_PENDING_DELIVERIES + 20; i++) {
      clock.set(T0 + i * 60000);
      const t = driver.applyTick(clock.now());
      if (t && t.deferred && t.deferred.length) deferredTicks++;
      await flush(); await flush(); await flush();
    }
    const j = cronStore.getJob(store, 'blocked');
    A.eq(fires, cronStore.MAX_PENDING_DELIVERIES, 'the routine stops paying for runs once ' + cronStore.MAX_PENDING_DELIVERIES + ' results are undelivered (' + fires + ' fires)');
    A.ok(deferredTicks >= 10, 'and later due ticks are held back by backpressure (' + deferredTicks + ')');
    A.eq(cronStore.pendingDeliveries(j).length, 1, 'one receipt waits for the chat');
    A.eq(cronStore.undeliveredCount(j), cronStore.MAX_PENDING_DELIVERIES, 'standing for every undelivered result');
    // the chat accepts messages again: the newest result lands (with its count) and the routine resumes
    refuse = false;
    clock.set(clock.now() + 900000);
    await driver.recoverFinalizations(); await flush();
    A.eq(cronStore.undeliveredCount(cronStore.getJob(store, 'blocked')), 0, 'once the newest result lands the count is spent');
    const before = fires;
    clock.set(Date.parse(cronStore.getJob(store, 'blocked').nextRunAt));
    driver.applyTick(clock.now()); await flush(); await flush(); await flush();
    A.eq(fires, before + 1, 'and the routine runs again');
  }

  // ---- the pure reducer: one destination's backlog never supersedes another destination's result ----
  {
    const other = Object.assign({}, CHAT, { chatId: '888' });
    const jobs = [job('split', [receipt('split', 's-3', 3, CHAT), receipt('split', 's-2', 2, other), receipt('split', 's-1', 1, CHAT)])];
    const next = cronStore.supersedeDeliveries(jobs, 'split', { now: T0 });
    A.eq(cronStore.pendingDeliveries(next[0]).map(f => f.runId), ['s-2', 's-1'], 'each chat keeps its own newest result');
    A.eq(next[0].finalization.superseded, 1, 'the newest for chat 777 replaces only chat 777\'s older one');
    A.ok(cronStore.supersedeDeliveries(next, 'split', { now: T0 }) === next, 'nothing left to collapse returns the same store');
    const again = [Object.assign({}, next[0], { deliveryBacklog: next[0].deliveryBacklog.concat([next[0].finalization]), finalization: receipt('split', 's-0', 0, CHAT) })];
    A.eq(cronStore.supersedeDeliveries(again, 'split', { now: T0 })[0].finalization.superseded, 2, 'a result superseded again hands on the count it carried');
    A.eq(cronStore.deliveriesHeld({ enabled: false, state: 'paused' }), true, 'paused by the Commander holds');
    // who replaces whom
    const failed = (runId, days) => Object.assign(receipt('mix', runId, days, CHAT), { outcome: 'failed', result: '', error: 'down' });
    const silent = (runId, days) => Object.assign(receipt('mix', runId, days, CHAT), { outcome: 'silent', result: '[SILENT]' });
    const mixed = [job('mix', [failed('f-4', 4), receipt('mix', 'r-3', 3, CHAT), silent('s-2', 2), failed('f-1', 1), failed('f-0', 0)])];
    const m = cronStore.supersedeDeliveries(mixed, 'mix', { now: T0 })[0];
    A.eq(cronStore.pendingDeliveries(m).map(f => f.runId), ['r-3', 's-2', 'f-0'], 'keepers: the newest result, the newest failure after it; a silent result is left alone');
    const byRun = id => cronStore.pendingDeliveries(m).find(f => f.runId === id) || {};
    A.eq([byRun('r-3').superseded, byRun('f-0').superseded, byRun('s-2').superseded], [1, 1, undefined], 'each superseded receipt goes to its nearest newer keeper; a silent one never counts');
    const quiet = [job('mix', [receipt('mix', 'r-1', 1, CHAT), silent('s-0', 0)])];
    A.ok(cronStore.supersedeDeliveries(quiet, 'mix', { now: T0 }) === quiet, 'a newer [SILENT] result never supersedes a real one');
    const resultThenFailure = [job('mix', [receipt('mix', 'r-1', 1, CHAT), failed('f-0', 0)])];
    A.ok(cronStore.supersedeDeliveries(resultThenFailure, 'mix', { now: T0 }) === resultThenFailure, 'a newer failure notice never supersedes a real result');
    const two = [job('mix', [receipt('mix', 'r-1', 1, CHAT), receipt('mix', 'r-0', 0, CHAT)])];
    A.ok(cronStore.supersedeDeliveries(two, 'mix', { now: T0, busy: ['r-0'] }) === two, 'a busy newest result takes over nothing (its text is already on the wire)');
    A.ok(cronStore.supersedeDeliveries(two, 'mix', { now: T0, busy: ['r-1'] }) === two, 'a busy older result is never superseded');
    A.eq(cronStore.undeliveredCount(cronStore.supersedeDeliveries(two, 'mix', { now: T0 })[0]), 2, 'undeliveredCount counts the superseded result with its keeper');
    A.eq(cronStore.deliveriesHeld({ enabled: false, state: 'error', disabledReason: 'consecutive-failures' }), false, 'an auto-paused routine still tells the Commander');
    A.eq(cronStore.deliveriesHeld({ enabled: false, state: 'completed' }), false, 'a completed one-shot still delivers');
  }

  A.report('cron.delivery-backlog');
})().catch(e => { console.error(e); process.exit(1); });
