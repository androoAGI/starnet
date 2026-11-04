/* Actual LineJobs normalization/retention and existing domain-store roundtrip.
   This does not enable or claim a host resume route or paid-dispatch recovery. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const J = require('../sidecar/routing/linejobs.js');
const C = require('../sidecar/routing/line-continuation.js');
const { makeDomainStore } = require('../sidecar/domain-store.js');
const { fixture, clone, digest } = require('./helpers/line-continuation.js');
const { job, continuation } = fixture();
const start = J.start({ jobs: [] }, Object.assign({}, job, { at: 100 }));
const held = J.checkpoint(start.state, job.id, 0, continuation);
A.eq([held.job.status, held.job.outcome, held.job.endedAt], ['held', 'blocked', null], 'valid saved hold has its own nonterminal lifecycle');
A.eq(start.job.status, 'running', 'checkpoint mutation leaves original admission state unchanged');
A.eq(J.boot(held.state, 500), { state: held.state, changed: false }, 'held work survives boot without reaping or automatic approval');
A.eq(J.mark(held.state, job.id, 'running').job, null, 'step-test mark cannot adopt a human hold');
A.throws(() => J.finish(held.state, job.id, { status: 'delivered', output: 'fake' }), 'ordinary finish cannot bypass continuation settlement');
A.throws(() => J.start(held.state, Object.assign({}, job, { at: 600 })), 'same job ID cannot be reused for a second admission');
const summary = J.list(held.state, {})[0];
A.eq(summary.continuation, { version: 1, revision: 1, phase: 'held' }, 'list exposes bounded proven state, not the heavy continuation payload');
A.ok(!JSON.stringify(summary).includes('draft before review'), 'list does not leak the entire saved draft');

const terminal = J.finish(start.state, job.id, { status: 'problem', outcome: 'blocked', stop: { code: 'blocked', why: 'unmet caller contract' },
  at: 120, output: 'execution succeeded', usd: 0.125, runs: [] });
A.ok(terminal.job.status === 'problem' && !Object.prototype.hasOwnProperty.call(terminal.job, 'continuation'), 'existing terminal postcondition-blocked is not a resumable human hold');
A.throws(() => J.checkpoint(terminal.state, job.id, 0, continuation), 'terminal blocked record cannot acquire approval authority');
const paused = J.mark(start.state, job.id, 'paused');
A.eq(J.boot(paused.state, 500).state.jobs[0].status, 'paused', 'step-test pause keeps its existing lifecycle');
A.throws(() => J.checkpoint(paused.state, job.id, 0, continuation), 'schema path does not steal the step-test cursor');

const future = JSON.parse('{"version":7,"__proto__":{"polluted":true},"walk":{"secretlyNew":"preserve this future draft"}}');
const unknown = J.normalizeAll({ jobs: [Object.assign({}, job, { status: 'held', continuation: future })] });
A.eq(unknown.jobs[0].continuation, future, 'future payload survives LineJobs normalization opaquely');
A.ok(unknown.jobs[0].status === 'interrupted' && unknown.jobs[0].continuationIssue.code === 'unsupported_version', 'future data cannot advertise resumable held authority');
A.ok(({}).polluted === undefined, 'normalizing unknown data does not change prototypes');
for (const rows of [
  [Object.assign({}, job, { id: 'invalid/id', continuation: future })],
  [Object.assign({}, job, { continuation: future }), Object.assign({}, job, { continuation })],
  [Object.assign({}, job), Object.assign({}, job, { continuation: future })]
]) {
  const guarded = J.normalizeAll({ jobs: rows });
  A.ok(guarded.continuationIssue && guarded.continuationIssue.readOnly, 'invalid/duplicate enclosing record is a store-level preservation refusal');
  A.ok(!J.boot(guarded, 500).changed, 'normalizer cannot hide preserved raw before boot decides to rewrite');
  A.throws(() => J.start(guarded, Object.assign({}, job, { id: 'job-different1', at: 600 })), 'new admission cannot overwrite the unnormalizable original');
  A.throws(() => J.assertWritable(guarded), 'strict host writer has an explicit preservation guard');
  A.ok(J.normalizeAll(guarded) === guarded, 'normalizing an already guarded state cannot discard its original source marker');
}
const finishedRows = Array.from({ length: J.MAX_JOBS + 10 }, (_, i) => Object.assign({}, job, {
  id: 'job-finished' + String(i).padStart(8, '0'), line: 'busy-line', status: 'delivered', startedAt: 200 + i, endedAt: 201 + i
}));
const retained = J.normalizeAll({ jobs: held.state.jobs.concat(unknown.jobs.map(j => Object.assign({}, j, { id: 'job-futurehold1' })), finishedRows) });
A.eq(retained.jobs.length, J.MAX_JOBS, 'ordinary finished retention remains bounded');
A.ok(retained.jobs.some(j => j.id === job.id) && retained.jobs.some(j => j.id === 'job-futurehold1'), 'old held and unknown records cannot be evicted by completed work');
const onlyHeld = Array.from({ length: J.MAX_JOBS + 1 }, (_, i) => {
  const j = clone(held.job); j.id = 'job-hold' + String(i).padStart(8, '0'); j.continuation.binding.jobId = j.id; return j;
});
A.eq(J.normalizeAll({ jobs: onlyHeld }).jobs.length, J.MAX_JOBS + 1, 'no hidden aggregate/live-job eviction is introduced');

const request = { token: 'decision-1', revision: 1, action: 'approve', note: 'continue this draft', at: 200 };
const claimed = J.claimDecision(held.state, job.id, request);
A.ok(claimed.job.status === 'held' && claimed.receipt.state === 'accepted', 'pure decision does not claim that a run started');
A.ok(J.claimDecision(claimed.state, job.id, request).replayed, 'same durable decision can be read back after response loss');
A.throws(() => J.claimDecision(claimed.state, job.id, Object.assign({}, request, { token: 'decision-2' })), 'competing stale decision cannot adopt another walk');
const ready = clone(claimed.job.continuation); ready.revision++; ready.phase = 'ready'; ready.hold = null; ready.decisions[0].state = 'adopted';
const running = J.checkpoint(claimed.state, job.id, 2, ready);
A.eq([running.job.status, running.job.outcome, running.job.stop || null, running.job.error], ['running', 'running', null, ''], 'adopted ready projection clears stale blocked current state');
A.eq(running.job.continuation.decisions[0].hold, continuation.hold, 'prior blocked facts remain immutable decision history');
const intent = clone(ready); intent.revision++; intent.phase = 'intent';
intent.attempts.push({ ordinal: 2, runId: 'run-next', node: { agentId: 'publisher', dockId: 'dock-publisher' }, branchId: null,
  workitemId: 'crate-next', state: 'intent', inputDigest: 'a'.repeat(64), outputDigest: null, usd: null, usageMissing: true, outcome: null, at: 300, endedAt: null });
const intended = J.checkpoint(running.state, job.id, 3, intent);
A.eq([intended.job.status, intended.job.outcome, intended.job.stop || null, intended.job.error], ['running', 'running', null, ''], 'persisted next intent stays nonterminal with no stale hold');
const uncertain = clone(intent); uncertain.revision++; uncertain.phase = 'uncertain'; uncertain.attempts[1].state = 'uncertain';
const unsure = J.checkpoint(intended.state, job.id, 4, uncertain);
A.ok(unsure.job.status === 'interrupted' && unsure.job.outcome === 'interrupted' && unsure.job.stop.code === 'restart'
  && /no confirmed terminal/.test(unsure.job.error) && unsure.job.endedAt === null, 'ready-to-intent-to-uncertain projects recovery need without a false completed result');
const booted = J.boot(running.state, 700);
A.ok(booted.changed && booted.state.jobs[0].status === 'interrupted' && booted.state.jobs[0].endedAt === null, 'interrupted continuation is recovery-required, not automatically rerun or terminally discarded');
A.eq(booted.state.jobs[0].continuation, ready, 'boot does not regenerate cursor, IDs, receipt or spend');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-continuation-'));
try {
  const file = path.join(dir, 'line-jobs.json');
  let failReadback = false, failAfterWrite = false, landed = 0;
  const faultFs = Object.create(fs);
  faultFs.readFileSync = (p, ...rest) => {
    if (failReadback && path.resolve(String(p)) === file) { const e = new Error('fixture readback unavailable'); e.code = 'EIO'; throw e; }
    return fs.readFileSync(p, ...rest);
  };
  faultFs.renameSync = (from, to) => {
    fs.renameSync(from, to);
    if (failAfterWrite && path.resolve(String(to)) === file) { landed++; failReadback = true; }
  };
  const store = makeDomainStore({ fs: faultFs, path, file, version: 1, defaults: () => ({ jobs: [] }),
    normalize: J.normalizeAll, encode: value => ({ jobs: value.jobs }), decode: envelope => envelope.jobs ? { jobs: envelope.jobs } : undefined });
  store.save(held.state);
  A.eq(store.load().value.jobs[0].continuation, continuation, 'actual disk domain-store roundtrip preserves full held state');
  store.save(claimed.state);
  const restarted = store.load().value;
  A.ok(J.claimDecision(restarted, job.id, request).replayed, 'decision retry after disk reload uses original receipt');
  failAfterWrite = true;
  A.throws(() => store.save(running.state), 'write-lands/readback-fails never reports durable success');
  failAfterWrite = false; failReadback = false;
  A.eq(landed, 1, 'failure is armed only after the actual atomic rename of the intended main file');
  A.eq(JSON.parse(fs.readFileSync(file, 'utf8')).jobs[0].continuation, ready, 'fault really occurred after the new bytes landed');
  A.eq(store.load().value.jobs[0].continuation, ready, 'explicit later read establishes which exact revision landed');
  store.save(unknown);
  A.eq(store.load().value.jobs[0].continuation, future, 'unsupported version/prototype-spelled data survives actual disk roundtrip');
  for (const rows of [[Object.assign({}, job, { id: 'bad/id', continuation: future })],
    [Object.assign({}, job), Object.assign({}, job, { continuation: future })]]) {
    const originalRows = JSON.stringify({ version: 1, jobs: rows }, null, 2);
    fs.writeFileSync(file, originalRows);
    const loaded = store.load().value;
    A.ok(loaded.continuationIssue && !J.boot(loaded, 800).changed, 'actual load retains a refusal for an invalid/duplicate enclosing record');
    A.throws(() => J.note(loaded, job.id, { kind: 'example', text: 'must not erase raw' }), 'ordinary mutation cannot erase the protected raw row after actual load');
    A.eq(digest(fs.readFileSync(file, 'utf8')), digest(originalRows), 'invalid enclosing raw file bytes stay exactly unchanged');
  }

  const oversized = clone(continuation); oversized.walk.product.text = 'x'.repeat(C.MAX_BYTES);
  const original = JSON.stringify({ version: 1, jobs: [Object.assign({}, job, { continuation: oversized }), Object.assign({}, job, { id: 'job-otherlive1' })] }, null, 2);
  fs.writeFileSync(file, original);
  const blocked = store.load().value;
  A.ok(blocked.jobs[0].continuationIssue.readOnly, 'oversized existing payload is explicitly read-only');
  A.ok(!J.boot(blocked, 900).changed, 'boot cannot rewrite the original just to repair another running row');
  for (const [name, action] of [
    ['start', () => J.start(blocked, Object.assign({}, job, { id: 'job-newadmission', at: 901 }))],
    ['finish', () => J.finish(blocked, 'job-otherlive1', { status: 'stopped' })],
    ['mark', () => J.mark(blocked, 'job-otherlive1', 'paused')],
    ['note', () => J.note(blocked, job.id, { kind: 'example', text: 'new note' })],
    ['link', () => J.link(blocked, job.id, { line: 'other', jobId: 'job-otherline1' })],
    ['again', () => J.again(blocked, job.id, 902)],
    ['checkpoint', () => J.checkpoint(blocked, job.id, 1, ready)],
    ['decision', () => J.claimDecision(blocked, job.id, request)]
  ]) A.throws(action, name + ' refuses an erasing rewrite beside oversized original data');
  A.eq(digest(fs.readFileSync(file, 'utf8')), digest(original), 'every refused mutation leaves exact original file bytes intact');
} finally {
  const resolved = path.resolve(dir), temp = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('line-continuation-')) throw new Error('unexpected fixture cleanup target');
  fs.rmSync(resolved, { recursive: true, force: true });
}
A.report('linejobs.continuation');
