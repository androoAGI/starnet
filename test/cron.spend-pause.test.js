/* node test/cron.spend-pause.test.js — B1 (stabilization plan C0-5): a routine fire that StarNet's own spend check paused or
   refused is not a broken routine.

   THE CHAIN THIS CLOSES (candidate-risk §2.1). While spend history is incomplete (an open or damaged spend item), the
   shipped soft rail pauses unattended work (sidecar/budget.js check: paused: true) and a limit the Commander chose refuses
   (strict: no paused). Both end the run 'error' with failureCode spend_history_unavailable (sidecar/loop.js stopForSpend),
   and the cron driver hands only that code on (cron-driver.js sink -> markRun). cron-store markRun then counted each such
   fire toward the consecutive-failure auto-pause, so a station with one stale receipt had its hourly routines switched off
   within about five hours, the note pointed to ROUTINES (no longer a door), and settling the receipt turned nothing back on.

   Now:
     1. markRun: a spend_history_unavailable fire leaves the failure streak exactly as it was (it neither counts nor resets
        it) and never trips the auto-pause; the routine stays ENABLED and re-armed. It is still a FAILURE, never a stop:
        lastStatus / state 'error', its failureCode kept (NEEDS YOU skips a stopped routine row);
     2. through the driver, the real loop and the real budget over one open item, a soft-rail routine fired 6 times stays
        enabled, every fire a failed cron.result naming spend_history_unavailable with no paid call; a strict (chosen) limit
        behaves the same;
     3. each fire's session and its NEEDS YOU row (autosessions.js, needsyou.js) say the way out in the chat's own words
        (friendlyerror.js spendUnknownMessage): COUNT AS;
     4. after COUNT AS settles the item, the next fire runs and succeeds;
     5. an ordinary error still auto-pauses after 5, and the pause note names AUTOMATE › SCHEDULES, where ENABLE is. */
'use strict';
const A = require('./_assert.js');
require('./helpers/frontend-esc.js').installEsc();   // needsyou.js escapes with the production U.esc
const crypto = require('node:crypto');
const { makeClock } = require('../shared/clock-rng.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');
const { makeLedger } = require('../sidecar/ledger.js');
const { makeBudget } = require('../sidecar/budget.js');
const BillingClass = require('../sidecar/billing-class.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCostEngine } = require('../sidecar/cost.js');

const SPEND = 'spend_history_unavailable';
const T0 = 1700000000000, HOUR = 3600000;
const SOFT = () => false, CHOSEN = () => true;
const iso = ms => new Date(ms).toISOString();
const tick = () => new Promise(r => setImmediate(r));
const intervalJob = (id, name) => cronStore.makeJob({ id, name, prompt: 'write the ' + name, agentId: 'agent', schedule: cron.parseSchedule('every 1h', T0) }, { id, now: T0 });

/* ---- the page side, run as shipped: Workstreams, the routine sessions (autosessions.js) and NEEDS YOU (needsyou.js) ---- */
const W = require('../frontend/app/workstreams.js');
global.Workstreams = W;
global.RunOutcome = require('../frontend/app/runoutcome.js');
global.Friendly = require('../frontend/app/friendlyerror.js');   // the page's global (friendlyerror.js UMD)
const busy = new Set();
global.Channels = { begin: id => busy.add(id), end: id => busy.delete(id), setStatus: () => {}, isBusy: id => busy.has(id), busyIds: () => Array.from(busy) };
global.App = { persist: () => {}, refreshRail: () => {}, agentName: id => (id === 'agent' ? 'NOVA' : id) };
global.document = undefined;
let stationJobs = () => [];   // GET /api/cron answers with the station's live records (index.js cronStateSnapshot)
global.fetch = async url => {
  if (url === '/api/cron') return { ok: true, json: async () => ({ jobs: stationJobs() }) };
  if (String(url).indexOf('/api/transcript?') === 0) return { ok: true, json: async () => ({ turns: [] }) };   // a paused run says nothing
  return { ok: false, json: async () => null };
};
const { AutoSessions } = require('../frontend/app/autosessions.js');
const I = AutoSessions._internals;
const NeedsYou = require('../frontend/app/needsyou.js');

/* ---- a station: one open spend item (an interrupted run, no per-run limit: COUNT AS $2.00), the shipped $25/day rail ---- */
function station(strictScope) {
  const clock = makeClock(T0);
  const rows = [{ runId: 'prior', agentId: 'agent', usd: 0.5, ts: T0 - HOUR }];
  const receipts = [{ runId: 'open', agentId: 'agent', ts: T0 - 60000 }];
  const io = { readAll: () => rows.map(r => Object.assign({}, r)), unsettled: () => receipts.map(r => Object.assign({}, r)),
    append: r => rows.push(r), beginRun() {}, finishRun() {} };
  const ledger = makeLedger({ io, clock, nextId: () => crypto.randomUUID() });
  const budget = makeBudget({ caps: { day: 25 }, ledger, clock, strictScope });
  const governor = BillingClass.makeGovernor({ budget, classOfProvider: () => 'metered' });
  let calls = 0, n = 0;
  const provider = { priceOf: () => ({ in: 0, out: 0 }), contextLimit: () => 0,
    stream: async function* () { calls++; yield { type: 'text', delta: 'digest ready' }; yield { type: 'done', finishReason: 'stop' }; } };
  let store = [intervalJob('digest', 'morning digest')];
  const events = [];
  const driver = makeCronDriver({
    getJobs: () => store, setJobs: j => { store = j; return true; },
    // the real loop under the real governor; a routine is work nobody watches (index.js spendAttended() is false for it)
    runOnce: o => runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit: o.emit, signal: o.signal,
      cost: makeCostEngine({ priceOf: () => ({ in: 0, out: 0 }) }), model: 'm', agentId: o.agentId, runId: o.runId,
      budget: { check: spent => governor.admit('run', { providerId: 'openrouter', agentId: o.agentId, runId: o.runId, spentUsd: spent }) } }),
    emit: (name, payload) => events.push({ name, payload }),
    placeWorkitem: () => {}, newId: () => 'fire' + (++n), newAbort: () => new AbortController(), now: () => clock.now(),
    getKey: () => 'sk-test', deliverResult: () => ({ ok: true }), defaultModel: 'test/model', persona: 'PERSONA', maxRunMs: 480000
  });
  return { clock, ledger, driver, events, calls: () => calls, job: () => cronStore.getJob(store, 'digest'), jobs: () => store };
}

// one scheduled fire at T0 + k hours, settled; then the page hears it as it would (cron.fire, then cron.result)
async function fireAt(s, k) {
  const before = s.events.length;
  s.clock.set(T0 + k * HOUR);
  s.driver.applyTick(s.clock.now());
  for (let i = 0; i < 400 && s.driver.leases.size; i++) await tick();
  const fresh = s.events.slice(before);
  const fired = fresh.find(e => e.name === 'cron.fire'), result = fresh.find(e => e.name === 'cron.result');
  stationJobs = () => s.jobs();
  if (fired) I.onFire(fired.payload);
  if (result) await I.onResult(result.payload);
  return { fired: fired && fired.payload, result: result && result.payload };
}
const rowOf = runId => NeedsYou.items().find(i => i.key === 'routine:cron-' + runId) || null;

(async () => {
  /* ---- 1. the reducer (cron-store markRun) ---- */
  {
    const paused = (runId, extra) => Object.assign({ runId, status: 'error', reason: 'error', outcome: 'failed', failureCode: SPEND, transient: false,
      error: 'An earlier call has no settled charge, so StarNet pauses unattended work (routines, lines, background workers) while the daily spending limit can’t be checked. Press COUNT AS $2.00 or enter its charge in SETTINGS › SPENDING LIMITS, or set PER DAY to 0.' }, extra || {});
    let jobs = [intervalJob('r1', 'report')];
    for (let k = 1; k <= 8; k++) jobs = cronStore.markRun(jobs, 'r1', paused('p' + k), { now: T0 + k * HOUR });
    const j = cronStore.getJob(jobs, 'r1');
    A.eq([j.enabled, j.state, j.lastStatus, j.lastFailureCode, j.consecutiveFailures, j.disabledReason || null], [true, 'error', 'error', SPEND, 0, null],
      'eight spend-paused fires: enabled, a visible failure (state error), its code kept, no streak, never auto-paused');
    A.eq(j.nextRunAt, iso(T0 + 9 * HOUR), 're-armed one period after the last fire');
    A.ok(!/consecutive failures/.test(String(j.finalization && j.finalization.error)), 'no auto-pause note on its result');
    A.ok(/COUNT AS \$2\.00/.test(j.lastError), 'the record keeps the fire\'s own way out (lastError)');
    // the streak stands exactly as it was: a spend pause between real failures neither counts nor clears them
    let m = [intervalJob('r2', 'report')];
    const fail = runId => ({ runId, status: 'error', reason: 'error', outcome: 'failed', failureCode: 'run_failure', error: 'boom', transient: false });
    for (let k = 1; k <= 4; k++) m = cronStore.markRun(m, 'r2', fail('f' + k), { now: T0 + k * HOUR });
    m = cronStore.markRun(m, 'r2', paused('p5'), { now: T0 + 5 * HOUR });
    A.eq([cronStore.getJob(m, 'r2').consecutiveFailures, cronStore.getJob(m, 'r2').enabled], [4, true], 'four failures, then a spend pause: the streak stays 4, still enabled');
    m = cronStore.markRun(m, 'r2', fail('f6'), { now: T0 + 6 * HOUR });
    const off = cronStore.getJob(m, 'r2');
    A.eq([off.consecutiveFailures, off.enabled, off.disabledReason], [5, false, 'consecutive-failures'], 'the fifth real failure still auto-pauses it');
    // a streak already at the ceiling (a lowered ceiling) is never tripped by a spend pause
    let c = [Object.assign(intervalJob('r3', 'report'), { consecutiveFailures: 4 })];
    c = cronStore.markRun(c, 'r3', paused('p1'), { now: T0 + HOUR, maxConsecutiveFailures: 2 });
    A.eq([cronStore.getJob(c, 'r3').enabled, cronStore.getJob(c, 'r3').state, cronStore.getJob(c, 'r3').consecutiveFailures], [true, 'error', 4], 'a spend pause never trips the ceiling, even one already reached');
    // it is a failure, not a stop: a stop keeps its own record ('stopped', state scheduled)
    let st = [intervalJob('r4', 'report')];
    st = cronStore.markRun(st, 'r4', { runId: 's1', status: 'stopped', outcome: 'stopped', reason: 'cancelled' }, { now: T0 + HOUR });
    A.eq(cronStore.getJob(st, 'r4').lastStatus, 'stopped', '(a stop is still a stop)');
    // and only the spend code is exempt: an ordinary failure code still counts
    let o = [intervalJob('r5', 'report')];
    o = cronStore.markRun(o, 'r5', fail('f1'), { now: T0 + HOUR });
    A.eq(cronStore.getJob(o, 'r5').consecutiveFailures, 1, 'an ordinary failure counts as before');
  }

  /* ---- 2-4. through the driver, the real loop and the real budget: soft rail, then a chosen (strict) limit ---- */
  for (const [label, strictScope] of [['soft rail (shipped $25/day, paused)', SOFT], ['chosen limit (strict refusal)', CHOSEN]]) {
    W.init(null);
    const s = station(strictScope);
    for (let k = 1; k <= 6; k++) {
      const { fired, result } = await fireAt(s, k);
      A.ok(!!fired, label + ': fire ' + k + ' of 6 happened (the routine was still on)');
      if (!fired || !result) continue;
      const j = s.job();
      A.eq([result.outcome, result.failureCode, result.runOutcome, result.pausedAfter || 0], ['failed', SPEND, 'failed', 0],
        label + ': fire ' + k + ' is a failed cron.result naming the spend check, never an auto-pause');
      A.eq([j.enabled, j.state, j.lastStatus, j.lastFailureCode, j.consecutiveFailures, j.disabledReason || null], [true, 'error', 'error', SPEND, 0, null],
        label + ': after fire ' + k + ' the routine is enabled, a visible failure, with no failure streak');
      A.eq(j.nextRunAt, iso(T0 + (k + 1) * HOUR), label + ': after fire ' + k + ' it is re-armed for the next hour');
      A.ok(/COUNT AS \$2\.00/.test(String(j.lastError)), label + ': fire ' + k + ' records the way out: ' + j.lastError);
      // the page: its session and its NEEDS YOU row (a failure: NEEDS YOU lists it; a stop it would skip)
      const ws = W.get('cron-' + fired.runId);
      A.eq(ws && ws.lastRunOk, false, label + ': fire ' + k + '\'s session settles as failed');
      const marker = ws && ws.history.filter(m => m && m.marker === 'fire-end').pop();
      A.ok(!!marker && /^⚠ Routine failed — /.test(marker.content) && /COUNT AS \$2\.00/.test(marker.content),
        label + ': fire ' + k + '\'s session says the way out: ' + (marker && marker.content));
      const row = rowOf(fired.runId);
      A.ok(!!row && row.kind === 'routine' && row.oc === 'failed', label + ': fire ' + k + ' is a NEEDS YOU row (failed): ' + JSON.stringify(row && { kind: row.kind, oc: row.oc }));
      A.ok(!!row && /COUNT AS \$2\.00/.test(String(row.tip)), label + ': fire ' + k + '\'s NEEDS YOU row names COUNT AS: ' + (row && row.tip));
      A.ok(!!row && /COUNT AS \$2\.00/.test(NeedsYou._internals.html([row], T0)), label + ': ...in the row the rail draws (its hover line)');
    }
    A.eq(s.calls(), 0, label + ': six fires, no paid call');
    const six = s.job();
    A.eq([six.enabled, six.consecutiveFailures, six.state], [true, 0, 'error'], label + ': after 6 fires the routine is still on');
    A.eq(NeedsYou.items().filter(i => i.kind === 'routine').length, 6, label + ': six NEEDS YOU rows, one per fire');
    const strictWords = Friendly.friendlyError(String(six.lastError)).userMessage;
    A.ok(strictScope === SOFT ? /^StarNet paused this unattended run/.test(strictWords) : /^Your spending limits can't be checked/.test(strictWords),
      label + ': the headline is the one for this rail: ' + strictWords);

    // COUNT AS (SETTINGS › SPENDING LIMITS: POST /api/budget/settle mode 'bound' books the row's countAs figure)
    const item = s.ledger.unknownItems().find(i => i.runId === 'open');
    A.eq(item && item.countAs, { usd: 2, source: 'assumed' }, label + ': the open item counts as $2.00');
    s.ledger.settleUnsettled('open', item.countAs.usd, item.countAs.source);
    A.eq(s.ledger.unknownItems().length, 0, label + ': COUNT AS makes the history whole');
    const { fired, result } = await fireAt(s, 7);
    A.ok(!!fired, label + ': the next fire after COUNT AS happens');
    A.eq(result && result.outcome, 'ok', label + ': ...and runs to the end');
    A.eq(s.calls(), 1, label + ': ...making its one paid call');
    const seven = s.job();
    A.eq([seven.enabled, seven.state, seven.lastStatus, seven.consecutiveFailures, seven.lastFailureCode], [true, 'scheduled', 'ok', 0, null], label + ': the routine is back on its schedule');
    A.eq(fired && rowOf(fired.runId), null, label + ': a fire that ran is no NEEDS YOU row');
  }

  /* ---- 5. an ordinary error still auto-pauses after 5; the note names the real place ---- */
  {
    const clock = makeClock(T0);
    let store = [intervalJob('broken', 'broken check')];
    const events = [];
    let n = 0, runs = 0;
    const driver = makeCronDriver({
      getJobs: () => store, setJobs: j => { store = j; return true; },
      runOnce: o => { runs++; o.emit('agent.run.error', { agentId: 'agent', runId: o.runId, message: 'boom', transient: false }); o.emit('agent.run.end', { agentId: 'agent', runId: o.runId, reason: 'error', turns: 1, usd: 0 }); return Promise.resolve(); },
      emit: (name, payload) => events.push({ name, payload }),
      placeWorkitem: () => {}, newId: () => 'b' + (++n), newAbort: () => new AbortController(), now: () => clock.now(),
      getKey: () => 'sk-test', deliverResult: () => ({ ok: true }), defaultModel: 'test/model', persona: 'PERSONA', maxRunMs: 480000
    });
    for (let k = 1; k <= 6; k++) {
      clock.set(T0 + k * HOUR);
      driver.applyTick(clock.now());
      for (let i = 0; i < 100 && driver.leases.size; i++) await tick();
      if (k === 4) A.eq(cronStore.getJob(store, 'broken').enabled, true, 'an ordinary error: still on after 4');
    }
    const b = cronStore.getJob(store, 'broken');
    A.eq([runs, b.enabled, b.disabledReason, b.consecutiveFailures, b.nextRunAt], [5, false, 'consecutive-failures', 5, null], 'an ordinary error still auto-pauses after 5 (the sixth tick fires nothing)');
    const note = String(b.finalization && b.finalization.error);
    A.ok(/Routine paused after 5 consecutive failures\. Fix it, then re-enable it from AUTOMATE › SCHEDULES\./.test(note), 'the pause note names AUTOMATE › SCHEDULES: ' + note);
    A.ok(!/from ROUTINES/.test(note), 'and never ROUTINES, which is no door');
    A.eq(events.filter(e => e.name === 'cron.result').pop().payload.pausedAfter, 5, 'cron.result says it paused after 5');
  }

  A.report('cron.spend-pause');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
