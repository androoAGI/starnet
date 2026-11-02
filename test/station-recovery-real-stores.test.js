/* node test/station-recovery-real-stores.test.js - what a restore switches off, proved on files the real store writers
   wrote and read back through the real store readers. The safety test's fixtures are hand-written, so a renamed key in
   a store would leave them green while the switch-off silently skipped the real file. Temp folders only; no sidecar. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const Recovery = require('../sidecar/station-recovery.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const loopStore = require('../sidecar/loopjob-store.js');
const LineTriggers = require('../sidecar/routing/triggers.js');
const { makeDomainStore } = require('../sidecar/domain-store.js');
const { makeOverseer } = require('../sidecar/overseer.js');
const { makeSubagentManager } = require('../sidecar/subagents.js');

const T0 = Date.parse('2026-01-05T09:00:00Z');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-recovery-real-'));
const ws = path.join(root, 'source');
const target = path.join(root, 'target');
const writeJson = (dir, rel, value) => fs.writeFileSync(path.join(dir, rel), JSON.stringify(value));

// the same wiring as index.js (const triggerStore)
const triggersAt = dir => makeDomainStore({
  fs, path, file: path.join(dir, 'triggers.json'), version: 1,
  defaults: () => ({ triggers: [] }),
  normalize: value => LineTriggers.normalizeAll(value),
  encode: value => ({ triggers: value.triggers }),
  decode: envelope => (envelope && Array.isArray(envelope.triggers)) ? { triggers: envelope.triggers } : undefined
});
let serial = 0;
const saved = { generalId: 'home', workstreams: [{ id: 'home', title: null, agentId: 'agent' }], deletedIds: [] };
const overseerAt = dir => makeOverseer({ fs, path, file: path.join(dir, 'overseer.json'), now: () => T0 + (++serial),
  newId: () => 'thread_' + (++serial), sessions: () => saved, hasAgent: id => id === 'agent' || id === 'researcher' });
const workersAt = dir => makeSubagentManager({ fs, pathMod: path, file: path.join(dir, 'subagents.json'),
  clock: { now: () => T0 + (++serial) }, newId: () => 'worker_' + (++serial) });
const settle = () => new Promise(res => setImmediate(res));
const pendingOf = o => o.reviews().filter(r => r.status === 'pending');

(async () => {
  fs.mkdirSync(ws, { recursive: true });
  writeJson(ws, 'agent.save.json', { doc: { agent: { id: 'agent' }, station: { rooms: ['r'], props: ['p'] } } });

  // ---- written by the real writers
  writeJson(ws, 'loops.json', loopStore.toEnvelope(loopStore.createLoop([], { id: 'l1', name: 'Real loop', objective: 'keep going' }, { now: T0 })));
  const schedule = cron.parseSchedule('every 1h', T0);
  let jobs = cronStore.createJob([], { id: 'sends', name: 'Sends', schedule }, { now: T0 });
  jobs = cronStore.createJob(jobs, { id: 'quiet', name: 'Quiet', schedule }, { now: T0 });
  jobs = cronStore.markRun(jobs, 'sends', { status: 'ok', runId: 'a', output: 'unsent' }, { now: T0 });
  A.eq(cronStore.pendingDeliveries(cronStore.getJob(jobs, 'sends')).length, 1, 'the real writer left a result waiting to be sent');
  writeJson(ws, 'cron.jobs.json', cronStore.toEnvelope(jobs));
  triggersAt(ws).save({ triggers: [
    { id: 'trg_folder0001', lineId: 'line1', kind: 'folder', name: 'Inbox', enabled: true, config: { path: path.join(root, 'inbox'), task: 'x' }, createdAt: T0, updatedAt: T0, fires: 0, recent: [] },
    { id: 'trg_hook00001', lineId: 'line1', kind: 'webhook', name: 'Hook', enabled: true, config: { task: 'x' }, createdAt: T0, updatedAt: T0, fires: 0, recent: [] }
  ] });
  A.eq(triggersAt(ws).load().value.triggers.length, 2, 'the real trigger store kept both');

  const srcOverseer = overseerAt(ws), srcWorkers = workersAt(ws);
  const child = srcOverseer.create({ title: 'Research', agentId: 'researcher', parentStreamId: 'home', requestId: 'create_1' });
  const finish = result => async () => ({ status: 'done', reason: 'done', result });
  const start = (result, parentRunId) => srcWorkers.start({ leadId: 'agent', agentId: 'researcher', parentStreamId: 'home', streamId: child.id, parentRunId }, result);
  const queued = start(finish('Queued findings'), 'lead-a');
  await settle();
  srcOverseer.collect(srcWorkers.list());
  A.eq(pendingOf(srcOverseer).length, 1, 'the real overseer queued a report');
  const owed = start(finish('Owed findings'), 'lead-b');
  const running = start(() => new Promise(() => {}), 'lead-c');
  const notLead = srcWorkers.start({ leadId: 'researcher', agentId: 'researcher', parentStreamId: 'home', streamId: child.id }, finish('Specialist'));
  await settle();
  A.eq(srcWorkers.get(running.id).status, 'running', 'one worker is still running at backup time');

  const bundle = Recovery.capture({ workspaceRoot: ws, now: T0, omitUnavailableCredentialStores: true });

  // the control: a plain reboot of the source really does owe these reports, and a plain reboot keeps the loop live
  const rebootedOverseer = overseerAt(ws), rebootedWorkers = workersAt(ws);
  rebootedOverseer.collect(rebootedWorkers.list());
  A.ok(pendingOf(rebootedOverseer).length >= 2, 'control: without a restore these workers are owed reports (' + pendingOf(rebootedOverseer).length + ')');

  // ---- restored, and read back through the real readers
  const receipt = Recovery.restore({ bundle, targetRoot: target, browserSink: {}, allowNoAgents: true, nonce: 'real-stores' });
  A.eq(receipt.ok, true, 'the bundle restores');
  const read = rel => fs.readFileSync(path.join(target, rel), 'utf8');
  const has = (kind, id) => receipt.reauthentication.some(x => x.kind === kind && x.id === id);

  const loop = loopStore.loadEnvelope(read('loops.json')).loops[0];
  A.eq(loop.enabled, false, 'the loop store reads the loop as off');
  A.eq(loop.state, 'paused', 'and paused');
  A.eq(loopStore.resumeLoop([loop], 'l1', { now: T0 + 1 })[0].enabled, true, 'and the real resume brings it back');
  A.ok(has('loop', 'l1'), 'and it is listed');

  const loadedJobs = cronStore.loadEnvelope(read('cron.jobs.json')).jobs;
  const sends = cronStore.getJob(loadedJobs, 'sends');
  A.eq(cronStore.deliveriesHeld(sends), true, 'the cron store holds the unsent result back');
  A.eq(cronStore.pendingDeliveries(sends).length, 1, 'and still has it');
  A.ok(has('routine', 'sends'), 'and it is listed');
  A.eq(cronStore.getJob(loadedJobs, 'quiet').state === 'paused', false, 'a routine with nothing to send is left to cron.armed.json');

  for (const t of triggersAt(target).load().value.triggers) {
    A.eq(t.enabled, false, 'the trigger store reads it as off: ' + t.id);
    A.ok(has('trigger', t.id), 'and it is listed: ' + t.id);
  }
  A.eq(triggersAt(target).load().value.triggers.length, 2, 'both triggers are still there');

  const backOverseer = overseerAt(target), backWorkers = workersAt(target);
  A.eq(pendingOf(backOverseer).length, 0, 'no queued report survives');
  A.ok(backOverseer.reviews().some(r => r.status === 'interrupted'), 'the queued one reads interrupted');
  const before = backOverseer.reviews().length;
  backOverseer.collect(backWorkers.list());
  A.eq(pendingOf(backOverseer).length, 0, 'the first tick queues no report for any restored worker');
  A.eq(backOverseer.reviews().length, before, 'and adds no row');
  A.ok(has('overseer-report', 'subagents.json'), 'and that is listed');
  A.eq(backWorkers.get(queued.id).result, 'Queued findings', 'a worker\'s own record stays readable');
  A.eq(backWorkers.get(owed.id).result, 'Owed findings', 'and one that was owed a report');
  A.eq(backWorkers.list().find(w => w.id === owed.id).result, 'Owed findings', 'through the listing too');
  A.eq(backWorkers.get(running.id).status, 'stale', 'a worker running at backup time reads stale');
  A.eq(backWorkers.get(notLead.id).noReportRun, undefined, 'a worker no report could come from is not stamped');

  // a person resuming a worker is a new run: that one reports as usual
  const again = backWorkers.list().find(w => w.id === owed.id);
  backOverseer.collect([Object.assign({}, again, { runId: 'resumed-run' })]);
  A.eq(pendingOf(backOverseer).length, 1, 'a worker a person resumes reports as usual');

  // a second pass over stamped workers leaves their bytes alone and writes no row
  const stamped = Buffer.from(bundle.files.find(x => x.path === 'subagents.json').data, 'base64');
  const passRows = [], passData = {};
  const pass = Recovery._internals.restorePlan({ files: [{ path: 'subagents.json', data: stamped.toString('base64') }] }, row => { passData[row.rel] = row.data; });
  passRows.push(...pass.reauth);
  A.eq(passData['subagents.json'].toString(), stamped.toString(), 'a pass over stamped workers leaves the bytes unchanged');
  A.eq(passRows.length, 0, 'and lists nothing new');

  // ---- every store: a shape nobody knows stays byte-identical
  const unknown = '{ "renamed": [ {"id":"a", "enabled":true, "status":"pending", "state":"idle"} ],\n  "enabled": true }';
  for (const name of ['loops.json', 'triggers.json', 'overseer.json', 'subagents.json', 'cron.jobs.json']) {
    const landed = {};
    const plan = Recovery._internals.restorePlan({ files: [{ path: name, data: Buffer.from(unknown).toString('base64') }] }, row => { landed[row.rel] = row.data; });
    A.eq(landed[name].toString(), unknown, 'an unknown shape stays byte-identical: ' + name);
    A.eq(plan.reauth.length, 0, 'and earns no row: ' + name);
  }

  fs.rmSync(root, { recursive: true, force: true });
  A.report('station-recovery-real-stores.test');
  process.exit(0);   // the worker that never finishes holds nothing, but this test owns no reason to wait on it
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
