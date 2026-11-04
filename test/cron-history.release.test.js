'use strict';
/* Same real reducers and driver, with only persistence acknowledgements and release
   failures controlled. The scheduling cursor is never a publication authority. */
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), crypto = require('node:crypto');
const Kinds = require('../frontend/app/turnkinds.js'), cron = require('../sidecar/cron.js');
function owner(rel, env, dependencies) {
  const file = require.resolve(rel), selected = process.env[env] || file;
  const text = fs.readFileSync(selected, 'utf8');
  if (selected !== file) console.log('CONTROL_SOURCE ' + env + ' SHA256=' + crypto.createHash('sha256').update(text).digest('hex'));
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const original = loaded.require.bind(loaded);
  loaded.require = name => dependencies && Object.prototype.hasOwnProperty.call(dependencies, name) ? dependencies[name] : original(name);
  loaded._compile(text, file); return loaded.exports;
}
const Store = owner('../sidecar/cron-store.js', 'C9_CRON_SCHEMA_SOURCE');
const Driver = owner('../sidecar/cron-driver.js', 'C9_CRON_DRIVER_SOURCE', { './cron-store.js': Store });
const clone = x => JSON.parse(JSON.stringify(x));
const at = Date.parse('2026-11-03T12:00:00Z');
const job = () => Store.makeJob({ name: 'Digest', agentId: 'agent', attachToSession: true, deliver: 'targets:target-a',
  schedule: cron.parseSchedule('every 24h', at) }, { id: 'daily', now: at });
function receipt(runId, target) {
  target = target || 'target-a';
  return { v: 1, target, deliveryId: 'routine:daily:' + runId + ':' + target, channel: 'telegram', chatId: 'room-a',
    streamId: 'stream_a', agentId: 'agent', runId, rowId: 7, turnId: Kinds.runTurnId(runId) };
}
function final(runId, extra) {
  return Object.assign({ id: runId + ':final', runId, state: 'delivered', outcome: 'ok', result: 'answer', deliver: 'targets:target-a',
    deliveryContext: { agentId: 'agent', attachToSession: true }, deliveredTargets: ['target-a'], givenUpTargets: [],
    historyPublications: [receipt(runId)], historyReleased: false }, extra);
}
function releases(j) { return typeof Store.publicationReleases === 'function' ? Store.publicationReleases(j) : []; }
(async () => {
  const older = final('routine-older-123'), base = Object.assign(job(), { finalization: final('routine-current-123', { state: 'pending' }), deliveryBacklog: [older] });
  const next = Store.markDelivery([base], 'daily', { runId: base.finalization.runId, ok: true, deliveredTargets: ['target-a'], historyPublications: base.finalization.historyPublications }, { now: at });
  A.eq(next[0].deliveryBacklog, [older], 'markDelivery retains an earlier completed receipt awaiting release');
  A.eq(releases(next[0]).map(f => f.runId), [older.runId, base.finalization.runId], 'both completed receipts remain available for release maintenance');
  const newer = Store.markRun([base], 'daily', { runId: 'routine-newer-123', status: 'ok', output: 'next answer', reason: 'done' }, { now: at + 1 });
  A.ok(newer[0].deliveryBacklog.some(f => f.runId === older.runId), 'later paid result cannot overwrite the unreleased completed receipt');
  const full = Object.assign(job(), { finalization: null, deliveryBacklog: Array.from({ length: 100 }, (_, i) => final('held-routine-' + String(i).padStart(4, '0'))) });
  const exact = JSON.stringify(full);
  A.eq(Store.undeliveredCount(full), 100, 'held completed receipts consume existing backlog capacity');
  A.throws(() => Store.markRun([full], 'daily', { runId: 'overflow-run-123', status: 'ok', output: 'new' }, { now: at }), '100 retained receipts refuse new accumulation instead of truncating');
  A.eq(JSON.stringify(full), exact, 'cap refusal leaves every prior receipt unchanged');
  const partial = final('partial-run-123', { state: 'pending', deliver: 'targets:target-a,target-b' });
  const collapse = Object.assign(job(), { deliveryBacklog: [partial], finalization: final('later-run-1234', { state: 'pending', deliver: partial.deliver, historyPublications: [] }) });
  const collapsed = Store.supersedeDeliveries([collapse], 'daily', { now: at });
  A.eq(collapsed[0].deliveryBacklog[0]?.state, 'pending', 'already published partial result is not superseded as idle work');
  A.throws(() => Store.markDelivery([Object.assign(job(), { finalization: final('missing-proof-123', { state: 'pending', historyPublications: [] }) })], 'daily',
    { runId: 'missing-proof-123', ok: true, deliveredTargets: ['target-a'] }, { now: at }), 'attached success cannot omit canonical publication proof');
  A.throws(() => Store.markDelivery([base], 'daily', { runId: base.finalization.runId, ok: true, deliveredTargets: ['target-a'], givenUpTargets: ['target-a'],
    historyPublications: base.finalization.historyPublications }, { now: at }), 'given-up transport cannot borrow a publication receipt');
  const conflicting = clone(base); conflicting.finalization.historyPublications[0].rowId++;
  A.throws(() => Store.markDelivery([base], 'daily', { runId: base.finalization.runId, ok: true, deliveredTargets: ['target-a'],
    historyPublications: conflicting.finalization.historyPublications }, { now: at }), 'a newer result cannot replace a saved publication identity');
  for (const [name, mutate] of [
    ['future envelope', raw => { raw.version = 99; }],
    ['future receipt', raw => { raw.jobs[0].finalization.historyPublications[0].v = 99; }],
    ['unknown receipt field', raw => { raw.jobs[0].finalization.historyPublications[0].newAuthority = true; }],
    ['wrong target', raw => { raw.jobs[0].finalization.historyPublications[0].target = 'other'; }],
    ['orphan release marker', raw => { delete raw.jobs[0].finalization.historyPublications; }],
    ['invalid release type', raw => { raw.jobs[0].finalization.historyReleased = 'true'; }],
    ['invalid owning job', raw => { raw.jobs[0].id = 'invalid/id'; }],
    ['missing transport proof', raw => { raw.jobs[0].finalization.deliveredTargets = []; }],
    ['mixed valid and damaged proof', raw => { raw.jobs[0].finalization.historyPublications.push({ v: 1 }); }]
  ]) {
    const raw = { version: 1, jobs: [Object.assign(job(), { finalization: final('schema-run-1234') })] }; mutate(raw);
    const bytes = JSON.stringify(raw);
    A.throws(() => Store.loadEnvelope(raw), name + ' holds the whole saved metadata rather than filtering it');
    A.eq(JSON.stringify(raw), bytes, name + ' preserves the original value');
  }
  A.eq(Store.loadEnvelope({ version: 1, jobs: [{ id: 'bad/id' }, job()] }).jobs.length, 1, 'unrelated malformed legacy job filtering stays unchanged');

  // The first four owners remain unprovable. A scheduling-only cursor must allow
  // the fifth proved receipt to advance on another bounded pass.
  let jobs = [Object.assign(job(), { finalization: null, deliveryBacklog: Array.from({ length: 5 }, (_, i) => final('fair-release-' + i)) })];
  const calls = [], paid = [], transported = [];
  const driver = Driver.makeCronDriver({ getJobs: () => jobs, setJobs: next => { jobs = next; return true; }, now: () => at,
    newId: () => 'unused-run-123', newAbort: () => new AbortController(), runOnce: async () => { paid.push(true); }, emit() {},
    deliverResult: async () => { transported.push(true); return { ok: true }; },
    deliveryRecorded: async (_job, run) => { calls.push(run); return run === 'fair-release-4'; } });
  await driver.recoverFinalizations();
  A.eq(calls.length, 4, 'one maintenance pass attempts at most four exact receipts');
  const before = calls.length;
  await driver.recoverFinalizations();
  A.ok(calls.includes('fair-release-4'), 'fifth release advances despite four permanently held predecessors');
  A.ok(calls.length - before <= 4, 'second pass keeps the same attempt bound');
  A.ok(!jobs[0].deliveryBacklog.some(f => f.runId === 'fair-release-4'), 'only the confirmed completed receipt is removed');
  A.eq(jobs[0].deliveryBacklog.length, 4, 'unprovable predecessors remain retained');
  A.eq(paid.length, 0, 'release maintenance performs no paid work');
  A.eq(transported.length, 0, 'release maintenance performs no transport');
  A.report('cron publication release retention');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
