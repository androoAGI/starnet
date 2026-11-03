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

function rig() {
  let time = T0, seq = 0, depth = 0, failStart = false, failFinish = false, writes = 0;
  let jobs = { jobs: [] };
  let routines = [cronStore.makeJob({ id: 'routine', agentId: 'researcher', prompt: 'research the moon', runsLine: true,
    schedule: cron.parseSchedule('every 1m', T0) }, { id: 'routine', now: T0 })];
  const events = [], rows = new Map(), runs = [];
  const save = r => { jobs = r.state; return r.job; };
  const lineRunner = makeLineRunner({ runOnce: async () => {}, now: () => time, newId: () => String(++seq).padStart(12, '0'),
    jobs: { get: id => J.get(jobs, id), start: o => { if (failStart) throw new Error('job start disk fault'); return save(J.start(jobs, o)); },
      finish: (id, o) => { if (failFinish) throw new Error('job finish disk fault'); writes++; return save(J.finish(jobs, id, o)); } },
    runRow: id => rows.get(id), emit: (name, payload) => events.push({ name, payload }) });
  const host = { lineRunner, cronItems: new Map(), crypto: { randomUUID: () => 'crate-' + (++seq) },
    router: { dockOf: () => 'bay', lineOfAgent: () => 'line' }, QUEUE_CAP: 64,
    bumpQueue: (_a, d) => (depth += d), chanEmit: (name, payload) => events.push({ name, payload }), failNote: () => {} };
  vm.runInNewContext(sidecarTopLevelFunction('placeCronWorkitem') + '\n' + sidecarTopLevelFunction('settleCronWorkitem'), host);
  const driver = makeCronDriver({ getJobs: () => routines, setJobs: v => { routines = v; return true; },
    now: () => time, newId: () => 'run-' + (++seq), newAbort: () => new AbortController(),
    getKey: () => 'test-key', defaultModel: 'test-model', emit: (name, payload) => events.push({ name, payload }), warn: () => {},
    placeWorkitem: host.placeCronWorkitem, settleWorkitem: host.settleCronWorkitem,
    runOnce: o => new Promise(resolve => runs.push({ o, resolve })),
    advanceChain: async o => {
      const item = host.cronItems.get(o.runId);
      const line = { agentId: 'researcher', outboxId: 'outbox', text: 'finished work', hops: [], stopped: null };
      if (item && item.job) item.job.lastLine = line;
      return line;
    } });
  return { driver, host, events, runs, jobs: () => jobs, depth: () => depth, writes: () => writes,
    startFault: v => { failStart = v; }, finishFault: v => { failFinish = v; },
    tick: at => { time = at; return driver.applyTick(time); },
    async complete() {
      const run = runs[0];
      if (!run) return;
      const row = { runId: run.o.runId, agentId: 'researcher', reason: 'done', outcome: 'succeeded', usd: 0.1 };
      rows.set(row.runId, row); run.o.emit('agent.token', { delta: 'finished work' }); run.o.emit('agent.run.end', row);
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
  const manual = sidecarTopLevelFunction('handleCronRun');
  A.ok(/try\s*\{\s*placeCronWorkitem\([\s\S]*?\);\s*pressed = await runOnce\(/.test(manual), 'Run Now places its authoritative job inside the same guarded block before its provider call');
  A.ok(!manual.includes('settleCronWorkitem(') && manual.includes('cronDriver.settleRun(job.id, runId, state, null)'), 'Run Now finishes once through the same retryable driver boundary');
  A.report('line-job-cron-durability.test');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
