/* Real cron driver + lifted production crate boundary + real job book/store. A refused job write cannot buy stage one
   or publish success. Retrying persistence must settle the same completed work without another provider call. */
'use strict';
const A = require('./_assert.js');
const vm = require('node:vm');
const { sidecarTopLevelFunction } = require('./helpers/source.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const J = require('../sidecar/routing/linejobs.js');
const { makeLineRunner } = require('../sidecar/routing/line-runner.js');
const T0 = Date.parse('2026-01-01T00:00:00Z');
const flush = () => new Promise(r => setImmediate(r));

function rig(options) {
  const opts = options || {};
  let time = T0, seq = 0, depth = 0, failStart = false, failFinish = false, failRoutineFinish = false, writes = 0, nextLine = null;
  let jobs = { jobs: [] };
  let routines = [cronStore.makeJob({ id: 'routine', agentId: 'researcher', prompt: 'research the moon', runsLine: true,
    schedule: cron.parseSchedule('every 1m', T0), meta: opts.contract ? { postconditions: { requirements: [{ type: 'artifact_exists', path: 'required.txt' }] } } : undefined }, { id: 'routine', now: T0 })];
  const events = [], rows = new Map(), runs = [];
  const save = r => { jobs = r.state; return r.job; };
  const lineRunner = makeLineRunner({ runOnce: async () => {}, now: () => time, newId: () => String(++seq).padStart(12, '0'),
    jobs: { get: id => J.get(jobs, id), start: o => { if (failStart) throw new Error('job start disk fault'); return save(J.start(jobs, o)); },
      finish: (id, o) => { if (failFinish) throw new Error('job finish disk fault'); writes++; return save(J.finish(jobs, id, o)); } },
    runRow: id => rows.get(id), emit: (name, payload) => events.push({ name, payload }) });
  const host = { lineRunner, cronItems: new Map(), crypto: { randomUUID: () => 'crate-' + (++seq) },
    admit: { dockOf: () => 'bay', lineOfAgent: () => 'line' }, QUEUE_CAP: 64, processFaultQuiesced: false, cronHalted: false,
    bumpQueue: (_a, d) => (depth += d), chanEmit: (name, payload) => events.push({ name, payload }), failNote: () => {} };
  vm.runInNewContext(sidecarTopLevelFunction('placeCronWorkitem') + '\n' + sidecarTopLevelFunction('settleCronWorkitem'), host);
  const driver = makeCronDriver({ getJobs: () => routines, setJobs: v => { if (failRoutineFinish && v.some(j => j.lastRunAt)) return false; routines = v; return true; },
    now: () => time, newId: () => 'run-' + (++seq), newAbort: () => new AbortController(),
    getKey: () => 'test-key', defaultModel: 'test-model', emit: (name, payload) => events.push({ name, payload }), warn: () => {},
    placeWorkitem: host.placeCronWorkitem, settleWorkitem: host.settleCronWorkitem,
    runOnce: o => new Promise(resolve => runs.push({ o, resolve })),
    advanceChain: async o => {
      const item = host.cronItems.get(o.runId);
      const line = nextLine || { agentId: 'researcher', outboxId: 'outbox', text: 'finished work', hops: [], stopped: null };
      if (item && item.job) item.job.lastLine = line;
      return line;
    } });
  return { driver, host, events, runs, rows, routines: () => routines, jobs: () => jobs, depth: () => depth, writes: () => writes,
    line: value => { nextLine = value; },
    startFault: v => { failStart = v; }, finishFault: v => { failFinish = v; }, routineFinishFault: v => { failRoutineFinish = v; },
    tick: at => { time = at; return driver.applyTick(time); },
    async cap() {
      const run = runs[0];
      const lineStop = { code: 'day_limit', why: 'The line reached its $1.00 daily limit - raise its LINE BUDGET or try again tomorrow.' };
      run.o.emit('agent.run.error', { runId: run.o.runId, message: lineStop.why });
      run.o.emit('agent.run.end', { runId: run.o.runId, reason: 'budget', usd: 0 });
      run.resolve({ text: '', reason: 'budget', outcome: 'out_of_budget', lineStop });
      await flush(); await flush(); await flush();
    },
    halt(cause) { host.processFaultQuiesced = cause === 'fault'; host.cronHalted = cause === 'user'; driver.abortAllLeases(); },
    async complete(completionVerdict) {
      const run = runs[0];
      if (!run) return;
      const row = { runId: run.o.runId, agentId: 'researcher', reason: 'done', outcome: 'succeeded', usd: 0.1 };
      rows.set(row.runId, row); run.o.emit('agent.token', { delta: 'finished work' });
      if (opts.contract) run.o.emit('agent.run.end', { runId: 'foreign-worker', reason: 'done', completionVerdict: 'completed_verified' });
      run.o.emit('agent.run.end', Object.assign({}, row, completionVerdict ? { completionVerdict } : null));
      run.resolve({ reason: 'done', outcome: 'succeeded', text: 'finished work' });
      await flush(); await flush(); await flush();
    } };
}
async function main() {
  {
    const r = rig(); r.startFault(true); r.tick(T0 + 60000);
    await flush();
    A.eq(r.runs.length, 0, 'failed durable job start never calls the provider');
    A.eq(r.jobs().jobs.length, 0, 'failed start advertises no durable job');
    A.eq(r.depth(), 0, 'failed start places no cosmetic queue crate');
    A.ok(!r.events.some(e => e.name === 'cron.result' && e.payload.outcome === 'ok'), 'failed start never publishes routine success');
    if (r.runs.length) await r.complete();   // old-source control leaves a run; finish it so the test has no unresolved work
  }
  {
    const r = rig(); r.finishFault(true); r.tick(T0 + 60000); await r.complete();
    A.eq(r.runs.length, 1, 'fixture bought one real driver run');
    A.eq(r.jobs().jobs[0] && r.jobs().jobs[0].status, 'running', 'refused finish leaves the previous durable job state');
    A.eq(r.events.filter(e => e.name === 'cron.result').length, 0, 'failed finish publishes no routine result');
    A.eq(r.events.filter(e => e.name === 'workitem.delivered').length, 0, 'failed finish publishes no OUTBOX crate');
    A.ok(r.driver.leases.get('routine') && r.driver.leases.get('routine').settlement, 'failed finish retains a settlement lease for retry');
    A.eq(r.host.cronItems.size, 1, 'failed finish retains its host job handle');
    r.finishFault(false); r.tick(T0 + 60001); await flush(); await flush();
    A.eq(r.runs.length, 1, 'persistence recovery never reexecutes the paid run');
    A.eq(r.jobs().jobs[0] && r.jobs().jobs[0].outcome, 'delivered', 'recovery commits the same completed job');
    A.eq(r.events.filter(e => e.name === 'cron.result' && e.payload.outcome === 'ok').length, 1, 'recovery publishes exactly one successful routine result');
    A.eq(r.events.filter(e => e.name === 'workitem.delivered').length, 1, 'recovery publishes exactly one OUTBOX crate');
    A.eq([r.writes(), r.host.cronItems.size, r.depth()], [1, 0, 0], 'one durable finish releases its host handle and queue slot');
    r.tick(T0 + 60002); await flush();
    A.eq(r.events.filter(e => e.name === 'workitem.delivered').length, 1, 'later ticks cannot duplicate publication');
  }
  // The actual driver and host finish boundary must preserve a cap, but a later owned STOP/fault wins,
  // including after the first finish write failed. No repeated provider execution or publication on retry.
  for (const when of ['before-completion', 'during-finish-refusal']) for (const cause of ['user', 'fault']) {
    const r = rig(); r.tick(T0 + 60000);
    if (when === 'before-completion') r.halt(cause);
    else r.finishFault(true);
    await r.cap();
    if (when === 'during-finish-refusal') {
      A.eq(r.jobs().jobs[0].status, 'running', cause + ': cap has no new durable outcome while finish is refused');
      r.halt(cause); r.finishFault(false); r.tick(T0 + 60001); await flush(); await flush();
    }
    const row = r.jobs().jobs[0];
    A.eq([row.outcome, row.stop && row.stop.code, row.runs.length], ['stopped', cause === 'fault' ? 'station_fault' : 'stopped', 0], when + ': host ' + cause + ' supersedes prior cap at durable settlement');
    const routine = r.routines()[0], receipt = r.events.find(e => e.name === 'cron.result');
    A.eq([routine.lastStatus, routine.lastOutcome, routine.lastReason], ['stopped', 'stopped', 'cancelled'], when + ': routine record matches its durable stopped job');
    A.eq(routine.lastLine && routine.lastLine.stopCode, cause === 'fault' ? 'station_fault' : 'stopped', when + ': routine retains exact host stop cause');
    A.eq(receipt && [receipt.payload.outcome, receipt.payload.runOutcome, receipt.payload.reason], ['stopped', 'stopped', 'cancelled'], when + ': cron.result agrees with both durable records');
    A.ok(!/daily limit/.test(row.error + ' ' + routine.lastError), when + ': superseded cap is not a STOP/fault reason');
    if (cause === 'fault') A.ok(/internal fault/.test(row.error) && /internal fault/.test(routine.lastError), when + ': real fault words survive both records');
    A.eq(r.events.filter(e => e.name === 'workitem.delivered').length, 0, when + ': a capped and stopped fire never publishes a crate');
    A.eq([r.runs.length, r.writes()], [1, 1], when + ': no rerun or duplicate durable finish');
  }
  for (const retainRow of [false, true]) {
    const r = rig(); r.tick(T0 + 60000);
    if (retainRow) r.rows.set(r.runs[0].o.runId, { runId: r.runs[0].o.runId, agentId: 'researcher', reason: 'done', outcome: 'succeeded', usd: 0.25 });
    await r.cap();
    const row = r.jobs().jobs[0];
    A.eq([row.outcome, row.stop && row.stop.code, row.runs.length], ['stopped_short', 'day_limit', retainRow ? 1 : 0], 'cap retains every existing durable row and invents none');
    A.eq(row.usd, retainRow ? 0.25 : 0, 'known preflight metadata never erases proved spend');
    A.eq(r.events.filter(e => e.name === 'workitem.delivered').length, 0, 'cap never becomes a delivered crate');
  }
  for (const accepted of ['cap', 'fault']) {
    const r = rig(); r.tick(T0 + 60000); r.routineFinishFault(true);
    if (accepted === 'fault') r.halt('fault');
    await r.cap();
    const acceptedRow = JSON.stringify(r.jobs().jobs[0]);
    A.eq(r.host.cronItems.size, 0, 'LineJob is durable before routine write refusal');
    A.ok(r.driver.leases.get('routine').settlement, 'routine write refusal retains the accepted job decision');
    A.eq(r.events.filter(e => e.name === 'cron.result').length, 0, 'no routine event before its own durable row');
    r.halt('user'); r.routineFinishFault(false); r.tick(T0 + 60001); await flush(); await flush();
    const routine = r.routines()[0], receipt = r.events.find(e => e.name === 'cron.result');
    A.eq(JSON.stringify(r.jobs().jobs[0]), acceptedRow, 'later STOP cannot rewrite an already durable LineJob');
    A.eq([routine.lastStatus, routine.lastLine && routine.lastLine.stopCode], accepted === 'fault' ? ['stopped', 'station_fault'] : ['error', 'day_limit'], 'routine retry preserves the accepted job cause');
    A.eq(receipt && receipt.payload.outcome, accepted === 'fault' ? 'stopped' : 'failed', 'event retry preserves the accepted job outcome');
    A.eq([r.runs.length, r.writes()], [1, 1], 'second-store recovery never reruns or rewrites LineJob');
  }
  for (const verdict of ['incomplete', 'verification_required', 'not_assessed', undefined]) {
    const r = rig({ contract: true }); r.finishFault(true); r.tick(T0 + 60000); await r.complete(verdict);
    A.eq(r.jobs().jobs[0].status, 'running', 'contract hold does not outrun failed job persistence: ' + verdict);
    A.eq(r.events.filter(e => e.name === 'cron.result').length, 0, 'uncommitted contract hold emits no routine result');
    r.finishFault(false); r.tick(T0 + 60001); await flush(); await flush();
    const job = r.jobs().jobs[0], routine = r.routines()[0], event = r.events.find(e => e.name === 'cron.result');
    A.eq([job.outcome, job.stop && job.stop.code, job.runs[0].outcome], ['blocked', 'blocked', 'succeeded'], 'own terminal evidence holds contract while preserving execution: ' + verdict);
    A.eq([routine.lastStatus, routine.lastReason, routine.lastOutcome, routine.lastLine && routine.lastLine.stopCode], ['error', 'blocked', 'blocked', 'blocked'], 'routine retry commits the same hold');
    A.eq([routine.lastError, routine.lastLine && routine.lastLine.blocked, event.payload.runOutcome], [job.error, job.error, 'blocked'], 'hold words and typed event agree');
    A.eq([r.runs.length, r.writes(), r.host.cronItems.size, r.depth(), r.driver.leases.size], [1, 1, 0, 0, 0], 'held work retries persistence once and releases all ownership');
    A.eq(r.events.filter(e => e.name === 'workitem.delivered').length, 0, 'unverified work publishes no crate');
  }
  for (const when of ['before-completion', 'during-finish-refusal']) for (const cause of ['user', 'fault']) {
    const r = rig({ contract: true }); r.tick(T0 + 60000);
    if (when === 'before-completion') r.halt(cause); else r.finishFault(true);
    await r.complete('incomplete');
    if (when === 'during-finish-refusal') { r.halt(cause); r.finishFault(false); r.tick(T0 + 60001); await flush(); await flush(); }
    const job = r.jobs().jobs[0], routine = r.routines()[0], event = r.events.find(e => e.name === 'cron.result');
    A.eq([job.outcome, job.stop && job.stop.code, routine.lastStatus, routine.lastReason, event.payload.runOutcome], ['stopped', cause === 'fault' ? 'station_fault' : 'stopped', 'stopped', 'cancelled', 'stopped'], when + ': owned ' + cause + ' supersedes uncommitted completion hold');
    A.ok(!/Verification required/.test(job.error + routine.lastError), 'superseded hold is not the STOP/fault cause');
    A.ok(!/Verification required/.test(String(routine.lastLine && routine.lastLine.blocked || '')), 'lastLine does not retain a superseded acceptance hold');
    A.eq([r.runs.length, r.writes(), r.events.filter(e => e.name === 'workitem.delivered').length], [1, 1, 0], 'late stop/fault never reruns or publishes held work');
  }
  {
    const r = rig({ contract: true }); r.routineFinishFault(true); r.tick(T0 + 60000); await r.complete('incomplete');
    const accepted = JSON.stringify(r.jobs().jobs[0]);
    A.eq(r.host.cronItems.size, 0, 'durable contract hold releases its host item before the second store retries');
    r.halt('user'); r.routineFinishFault(false); r.tick(T0 + 60001); await flush(); await flush();
    A.eq(JSON.stringify(r.jobs().jobs[0]), accepted, 'later STOP cannot rewrite a committed acceptance hold');
    const routine = r.routines()[0], event = r.events.find(e => e.name === 'cron.result');
    A.eq([routine.lastReason, routine.lastOutcome, event.payload.runOutcome], ['blocked', 'blocked', 'blocked'], 'second-store retry preserves accepted hold');
    A.eq([r.runs.length, r.writes(), r.driver.leases.size], [1, 1, 0], 'second-store retry neither duplicates work nor leaks lease');
  }
  {
    const r = rig();
    r.line({ agentId: 'researcher', text: 'reviewed draft', hops: [], stopped: 'reviewer held the draft', blocked: 'reviewer held the draft',
      unapproved: 'approval is still pending', partial: 'one branch did not finish', stop: { code: 'blocked', why: 'reviewer held the draft' } });
    r.tick(T0 + 60000); await r.complete();
    const routine = r.routines()[0], job = r.jobs().jobs[0], receipt = r.events.find(e => e.name === 'cron.result');
    A.eq([job.outcome, routine.lastStatus, routine.lastOutcome, receipt && receipt.payload.outcome, receipt && receipt.payload.runOutcome], ['blocked', 'error', 'blocked', 'failed', 'blocked'], 'accepted stop facts cannot erase a reviewer hold and turn its routine green');
    A.eq([routine.lastLine.blocked, routine.lastLine.partial, routine.lastLine.unapproved], ['reviewer held the draft', 'one branch did not finish', 'approval is still pending'], 'accepted stop projection preserves previously folded line facts');
    A.eq(r.events.filter(e => e.name === 'workitem.delivered').length, 0, 'blocked line still has no delivered crate');
  }
  const manual = sidecarTopLevelFunction('handleCronRun');
  A.ok(/try\s*\{\s*placeCronWorkitem\([\s\S]*?\);\s*pressed = await runOnce\(/.test(manual), 'Run Now places its authoritative job inside the same guarded block before its provider call');
  A.ok(!manual.includes('settleCronWorkitem(') && manual.includes('cronDriver.settleRun(job.id, runId, state, null)'), 'Run Now finishes once through the same retryable driver boundary');
  A.report('line-job-cron-durability.test');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
