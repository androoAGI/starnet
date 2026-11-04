/* Actual host writer block + real domain-store/LineJobs, with allocated filesystem faults.
   The old control retains its original value-taking call contract; current takes a mutation
   closure. No provider, public resume, alternate store or successful fake save is involved. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const A = require('./_assert.js');
const J = require('../sidecar/routing/linejobs.js');
const { makeDomainStore } = require('../sidecar/domain-store.js');
const { fixture, clone, digest } = require('./helpers/line-continuation.js');
// Pins the index's actual private writer/boot declarations, not a positive substring anywhere.
const source = process.env.LINE_JOBS_HOST_CONTROL ? fs.readFileSync(process.env.LINE_JOBS_HOST_CONTROL, 'utf8')
  : require('./helpers/source.js').readSidecarIndex();
const start = source.indexOf('const LINE_JOBS_FILE = '), end = source.indexOf('/* GET /api/line-jobs?line=', start);
if (start < 0 || end <= start) throw new Error('actual host writer block not found');
const block = source.slice(start, end);
const handlers = A.fnBody(source, 'function handleLineJobsList(') + '\n' + A.fnBody(source, 'async function handleLineJobId(');
if (handlers.length < 100 || handlers.length > 9000) throw new Error('actual LineJob handler extraction escaped its boundary');
const old = !!process.env.LINE_JOBS_HOST_CONTROL;
const { job, continuation } = fixture();
const held = J.checkpoint(J.start({ jobs: [] }, Object.assign({}, job, { at: 100 })).state, job.id, 0, continuation).job;
const request = { token: 'persist-decision', revision: 1, action: 'approve', note: 'this exact saved draft', at: 200 };
function attempt(fn) { try { return { value: fn() }; } catch (error) { return { error }; } }
function sandbox(seed, configure) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linejobs-host-'));
  const file = path.join(dir, 'line-jobs.json');
  const faults = { mode: '', landed: 0, readback: false, hide: false };
  const proxy = Object.create(fs);
  proxy.readFileSync = (p, ...args) => {
    const target = path.resolve(String(p));
    if (faults.hide && (target === file || target === file + '.bak')) { const e = new Error('fixture temporarily absent'); e.code = 'ENOENT'; throw e; }
    if (target === file && faults.readback) { const e = new Error('fixture canonical readback refused'); e.code = 'EIO'; throw e; }
    const value = fs.readFileSync(p, ...args);
    if (target === file && faults.mode === 'remove-after-readback' && faults.landed) {
      faults.mode = ''; fs.unlinkSync(file); // generic save has its bytes; the host's fresh main proof cannot succeed
    }
    return value;
  };
  proxy.renameSync = (from, to) => {
    if (path.resolve(String(to)) === file && faults.mode === 'before-write') { const e = new Error('fixture write refused'); e.code = 'EIO'; throw e; }
    fs.renameSync(from, to);
    if (path.resolve(String(to)) === file) { faults.landed++; if (faults.mode === 'land-readback') faults.readback = true; }
  };
  try {
    if (seed !== undefined) fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: seed }, null, 2));
    if (configure) configure({ faults, file, dir });
    const notes = [];
    const context = { fs: proxy, path, WORKSPACES: dir, makeDomainStore, LineJobs: J, writeFileDurable: undefined,
      LineEntryInvocation: require('../sidecar/routing/line-entry-invocation.js'),
      LineEntryAdoption: require('../sidecar/routing/line-entry-adoption.js'), chainRunner: require('../sidecar/routing/chain.js').makeChainRunner({}),
      Date: { now: () => 900 }, failNote: (tag, error) => notes.push([tag, String(error && error.message)]),
      reportDomainStoreIssue: tag => status => notes.push([tag, status]), URL,
      readBody: async req => JSON.stringify(req.body || {}), respondJson: (res, status, body) => Object.assign(res, { status, body }) };
    const adapter = old ? '(change, strict) => lineJobsSet(change(lineJobs), !!strict)' : 'change => lineJobsSet(change)';
    vm.runInNewContext(block + '\n' + handlers + '\nglobalThis.owner = { mutate: ' + adapter + ', value: () => lineJobs, directSave: value => lineJobStore.save(value), status: () => '
      + (old ? '({ ready: true })' : 'lineJobsStorageStatus()') + ', list: handleLineJobsList, handle: handleLineJobId };', context);
    return { dir, file, faults, notes, owner: context.owner,
      disk: () => JSON.parse(fs.readFileSync(file, 'utf8')),
      close() {
        const resolved = path.resolve(dir);
        if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('linejobs-host-')) throw new Error('fixture cleanup escaped allocated directory');
        fs.rmSync(resolved, { recursive: true, force: true });
      } };
  } catch (error) {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('linejobs-host-')) fs.rmSync(resolved, { recursive: true, force: true });
    throw error;
  }
}
function withStore(seed, run, configure) { const fx = sandbox(seed, configure); try { run(fx); } finally { fx.close(); } }

withStore([held], fx => {
  const before = digest(fs.readFileSync(fx.file, 'utf8'));
  fx.faults.mode = 'before-write';
  const r = attempt(() => fx.owner.mutate(state => J.note(state, job.id, { kind: 'example', text: 'unconfirmed note', at: 200 })));
  A.ok(r.error, 'actual host refuses a non-strict legacy note when its real write fails');
  A.eq(fx.owner.value().jobs[0].notes, [], 'failed note never becomes published memory');
  A.eq(digest(fs.readFileSync(fx.file, 'utf8')), before, 'pre-write fault preserves original canonical bytes');
  A.ok(!fx.owner.status().ready, 'write refusal is explicit in bounded storage status');
});

withStore([held], fx => {
  fx.faults.mode = 'land-readback';
  const r = attempt(() => fx.owner.mutate(state => J.claimDecision(state, job.id, request), true));
  A.ok(r.error, 'landed write with failed readback is not acknowledged');
  A.eq(fx.faults.landed, 1, 'control reaches the real canonical rename exactly once');
  A.eq(fx.owner.value().jobs[0].continuation.revision, 1, 'unconfirmed landed decision is not published as accepted');
  A.eq(fx.disk().jobs[0].continuation.revision, 2, 'the decision actually landed on disk');
  fx.faults.mode = ''; fx.faults.readback = false;
  const acceptedDisk = fx.disk().jobs[0].continuation;
  const invalidOld = clone(continuation); invalidOld.revision++;
  const beforeRetry = fx.faults.landed;
  A.ok(attempt(() => fx.owner.mutate(state => J.checkpoint(state, job.id, 1, invalidOld))).error, 'stale revision is checked after canonical reconciliation');
  A.eq(fx.faults.landed, beforeRetry, 'stale retry cannot overwrite the landed decision');
  A.eq(fx.owner.value().jobs[0].continuation, acceptedDisk, 'fresh canonical acceptance becomes the retry authority');
  A.ok(fx.owner.status().ready, 'revision refusal does not falsely diagnose a storage outage');
  const same = attempt(() => fx.owner.mutate(state => J.claimDecision(state, job.id, request), true));
  A.eq(same.value && same.value.continuation.decisions.length, 1, 'same-token retry retains one decision receipt');
  A.eq(same.value && same.value.continuation.decisions[0].token, request.token, 'retry returns the original token authority');
});

withStore(undefined, fx => {
  fx.faults.mode = 'land-readback';
  const first = attempt(() => fx.owner.mutate(state => J.start(state, Object.assign({}, job, { at: 1000 })), true));
  A.ok(first.error && fx.faults.landed === 1, 'first-store creation really lands before readback fails');
  const raw = digest(fs.readFileSync(fx.file, 'utf8'));
  fx.faults.mode = ''; fx.faults.readback = false; fx.faults.hide = true;
  let computed = 0;
  const next = attempt(() => fx.owner.mutate(state => { computed++; return J.start(state, Object.assign({}, job, { id: 'job-nextfixture1', at: 1001 })); }));
  A.ok(next.error, 'absence after possible first creation is uncertainty, never a fresh empty store');
  A.eq(computed, 0, 'uncertain absence buys no mutation computation');
  A.eq(digest(fs.readFileSync(fx.file, 'utf8')), raw, 'uncertain absence cannot erase the first landed receipt');
});

withStore([held], fx => {
  fx.faults.mode = 'remove-after-readback';
  const r = attempt(() => fx.owner.mutate(state => J.note(state, job.id, { kind: 'example', text: 'new note', at: 200 })));
  A.ok(r.error, 'generic save proof followed by missing canonical main is not host success');
  A.eq(fx.owner.value().jobs[0].notes, [], 'a recovered old backup cannot become publication authority');
  A.ok(!fx.owner.status().ready, 'canonical-main uncertainty stays visible');
});

const legacyRunning = Object.assign({}, job, { id: 'job-bootfixture1', status: 'running', startedAt: 100, endedAt: null });
withStore([legacyRunning, held], fx => {
  A.eq(fx.owner.value().jobs.find(j => j.id === legacyRunning.id).status, 'running', 'failed boot save does not publish unverified interrupted state');
  A.ok(!fx.owner.status().ready, 'boot save refusal is visible');
  fx.faults.mode = '';
  const active = Object.assign({}, legacyRunning, { id: 'job-currentfixture1', startedAt: 901 });
  fs.writeFileSync(fx.file, JSON.stringify({ version: 1, jobs: [legacyRunning, held, active] }));
  fx.owner.mutate(state => J.note(state, job.id, { kind: 'example', text: 'after recovery', at: 902 }));
  const rows = fx.disk().jobs;
  A.eq(rows.find(j => j.id === legacyRunning.id).status, 'interrupted', 'boot retry settles its original run identity');
  A.ok(rows.some(j => j.id === active.id && j.status === 'running'), 'boot retry never interrupts or erases a later active identity');
}, ({ faults }) => { faults.mode = 'before-write'; });

for (const rows of [
  [Object.assign({}, held, { id: 'invalid/id' })],
  [held, clone(held)]
]) withStore(rows, fx => {
  const before = digest(fs.readFileSync(fx.file, 'utf8'));
  const guarded = J.normalizeAll(fx.disk());
  A.ok(attempt(() => fx.owner.directSave(guarded)).error, 'actual domain encode refuses a protected enclosing record');
  A.eq(digest(fs.readFileSync(fx.file, 'utf8')), before, 'direct save cannot erase opaque raw rows before reporting failure');
});

const future = JSON.parse('{"version":99,"opaque":{"__proto__":{"keep":"data"}},"steps":["never execute"]}');
withStore([Object.assign({}, held, { continuation: future })], fx => {
  const kept = fx.owner.mutate(state => J.note(state, job.id, { kind: 'example', text: 'retain unknown data', at: 200 }));
  A.eq(kept.continuation, future, 'a bounded unknown version stays exact opaque data through a real host note');
  A.eq(fx.disk().jobs[0].continuation, future, 'saved future continuation is never replaced by an executable or empty prefix');
  A.ok(kept.status === 'interrupted' && !!kept.continuationIssue, 'unknown continuation remains explicitly non-runnable');
});

withStore([held], fx => {
  const before = digest(fs.readFileSync(fx.file, 'utf8'));
  let computed = 0;
  const r = attempt(() => fx.owner.mutate(state => { computed++; return J.start(state, Object.assign({}, job, { id: 'job-unreadfixture1', at: 1001 })); }, true));
  A.ok(r.error, 'an unreadable initial document cannot grant new-store admission');
  A.eq(computed, 0, 'unreadable initial storage refuses before a new job is calculated');
  A.eq(digest(fs.readFileSync(fx.file, 'utf8')), before, 'unreadable initial original bytes survive unchanged');
  fx.faults.readback = false;
  const recovered = {};
  fx.owner.list({ url: 'http://127.0.0.1/api/line-jobs' }, recovered);
  A.ok(recovered.status === 200 && recovered.body.jobs.some(j => j.id === job.id), 'explicit later read restores the actual held record, not empty defaults');
}, ({ faults }) => { faults.readback = true; });

withStore([held], fx => {
  fx.owner.mutate(state => J.note(state, job.id, { kind: 'example', text: 'confirmed', at: 200 }));
  fs.unlinkSync(fx.file); fs.unlinkSync(fx.file + '.bak');
  let computed = 0;
  A.ok(attempt(() => fx.owner.mutate(state => { computed++; return J.start(state, Object.assign({}, job, { id: 'job-nextfixture1', at: 1001 })); })).error, 'known store absence does not reinitialize forgotten history');
  A.eq(computed, 0, 'known missing storage refuses before calculating another mutation');
  A.ok(!fs.existsSync(fx.file), 'refusal does not silently recreate a known missing store');
});
async function routes() {
  const fx = sandbox([held]);
  try {
    fx.faults.mode = 'before-write';
    const res = {};
    await fx.owner.handle({ method: 'POST', body: { kind: 'example', text: 'must not be acknowledged' } }, res, ['', job.id, '/note']);
    A.eq(res.status, 503, 'actual note handler reports a refused write as503');
    A.ok(res.body && res.body.ok === false, 'actual note response never acknowledges the failed mutation');
    A.eq(fx.owner.value().jobs[0].notes, [], 'actual note handler leaves published notes unchanged');
    fx.faults.mode = 'land-readback';
    attempt(() => fx.owner.mutate(state => J.claimDecision(state, job.id, request), true));
    const blocked = {};
    fx.owner.list({ url: 'http://127.0.0.1/api/line-jobs' }, blocked);
    A.ok(blocked.status === 503 && blocked.body.storage && !blocked.body.storage.ready, 'actual GET distinguishes unresolved storage from an empty successful history');
    fx.faults.mode = ''; fx.faults.readback = false;
    const recovered = {};
    await fx.owner.handle({ method: 'GET' }, recovered, ['', job.id, '']);
    A.ok(recovered.status === 200 && recovered.body.storage && recovered.body.storage.ready, 'a later explicit GET can prove the canonical revision after the fault clears');
    A.eq(recovered.body.job && recovered.body.job.continuation.revision, 2, 'GET recovery names the landed decision revision, not stale memory');
    A.eq(fx.disk().jobs[0].continuation.decisions.length, 1, 'read recovery never reexecutes a decision');
  } finally { fx.close(); }
  A.report('linejobs.persistence');
}
routes().catch(error => { console.error(error && error.stack || error); process.exit(1); });
