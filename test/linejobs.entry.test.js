'use strict';
const A = require('./_assert.js'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), crypto = require('node:crypto');
const C = require('../sidecar/routing/line-continuation.js');
const { fixture, clone } = require('./helpers/line-entry.js');
const original = process.env.LINE_ENTRY_CONTROL_JOBS;
let J = require('../sidecar/routing/linejobs.js');
if (original) {
  const source = fs.readFileSync(original, 'utf8'), hash = crypto.createHash('sha256').update(source).digest('hex');
  console.log('CONTROL_SOURCE ' + original + ' SHA256=' + hash);
  if (hash !== String(process.env.LINE_ENTRY_CONTROL_JOBS_SHA256 || '').toLowerCase()) throw new Error('entry control source hash mismatch');
  const file = require.resolve('../sidecar/routing/linejobs.js'), mod = new Module(file, module);
  mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file)); mod._compile(source, file); J = mod.exports;
}
const { job, receipt, observed, continuation } = fixture();
function base() {
  const state = J.start({ jobs: [] }, Object.assign({}, job, { at: 100 })).state;
  state.continuationAccounting = { version: 1, state: 'confirmed', ledgerId: receipt.ledgerId };
  return state;
}
function seeded(raw) { const s = base(); s.jobs[0].entryAdmission = raw === undefined ? clone(receipt) : raw; return s; }
for (const [name, op] of [
  ['normalize', s => J.normalizeAll(s)], ['note', s => J.note(s, job.id, { kind: 'fix', text: 'retain receipt', at: 110 }).state],
  ['link', s => J.link(s, job.id, { line: 'line-b', jobId: 'job-linked001' }).state]
]) A.eq(J.get(op(seeded()), job.id).entryAdmission, receipt, name + ' preserves exact entry authority');
A.throws(() => J.start(seeded(), Object.assign({}, job, { at: 200 })), 'a repeated admission cannot erase its paid entry intent');
A.throws(() => J.finish(seeded(), job.id, { status: 'failed', outcome: 'error', at: 200, runs: [] }), 'ordinary finish cannot settle an unresolved entry');
const booted = J.boot(seeded(), 200);
A.eq(booted.state.jobs[0].entryAdmission && booted.state.jobs[0].entryAdmission.state, 'uncertain', 'boot marks an unresolved entry uncertain instead of replayable');
A.eq(booted.state.jobs[0].entryAdmission && booted.state.jobs[0].entryAdmission.binding, receipt.binding, 'boot preserves every original entry identity');
A.eq(booted.state.jobs[0].endedAt, null, 'boot does not fabricate a terminal entry time');
const future = { version: 2, preserve: ['opaque', 3] };
A.eq(J.normalizeAll(seeded(future)).jobs[0].entryAdmission, future, 'future entry data survives normal loading');
const broken = seeded(); broken.jobs[0].id = 'bad job';
A.throws(() => J.assertWritable(J.normalizeAll(broken)), 'invalid enclosing record cannot erase entry authority on rewrite');
const duplicate = seeded(); duplicate.jobs.push(clone(duplicate.jobs[0]));
A.throws(() => J.assertWritable(J.normalizeAll(duplicate)), 'duplicate enclosing record cannot choose one paid receipt silently');
const large = seeded({ version: 2, bytes: 'x'.repeat(C.MAX_BYTES) });
A.throws(() => J.assertWritable(J.normalizeAll(large)), 'oversized entry remains an existing-owner write refusal');
const prunable = seeded(); prunable.jobs[0].status = 'failed'; prunable.jobs[0].endedAt = 110;
for (let n = 0; n < J.MAX_JOBS + 5; n++) {
  const id = 'job-' + String(n).padStart(12, '0');
  const row = J.start({ jobs: [] }, { id, line: job.line, at: n + 200 }).job;
  row.status = 'failed'; row.endedAt = n + 201; prunable.jobs.push(row);
}
A.ok(J.retain(prunable.jobs).some(j => j.id === job.id), 'ordinary completed-job pruning cannot discard unreconciled entry authority');

if (!original) {
  const prepared = J.prepareEntry(base(), job.id, receipt);
  A.eq(prepared.job.entryAdmission, receipt, 'pure preparation writes to the same job');
  const b = J.boot(prepared.state, 200, new Set([job.id]));
  A.eq(b.state.jobs[0].entryAdmission.revision, 2, 'boot uncertainty is a real CAS transition');
  const again = J.boot(b.state, 300, new Set([job.id]));
  A.eq(again.changed, false, 'another boot never resets the uncertain attempt');
  const noOwner = J.boot(prepared.state, 200, new Set());
  A.eq(noOwner.changed, false, 'a newly active ID outside the original boot set is untouched');
  const done = J.checkpointEntry(prepared.state, job.id, 1, observed(receipt, true));
  A.eq(done.job.entryAdmission.observation.usageMissing, true, 'missing usage remains unresolved on the saved observed receipt');
  A.throws(() => J.checkpoint(done.state, job.id, 0, continuation), 'observed entry cannot bypass its unimplemented adoption/cost reconciliation');
  const stopped = J.boot(done.state, 300);
  A.eq([stopped.state.jobs[0].status, stopped.state.jobs[0].entryAdmission.state], ['interrupted', 'observed'], 'restart preserves observed work without claiming a live walker');
  A.eq(J.prepareEntry(done.state, job.id, receipt).replayed, true, 'prepare replay cannot reset observed state');
  A.eq(J.checkpointEntry(done.state, job.id, 1, observed(receipt, true)).replayed, true, 'exact observation ACK replay is idempotent');
  for (const enrolled of [null, { version: 1, ledgerId: receipt.ledgerId, state: 'prepared' }, { version: 1, ledgerId: 'other', state: 'confirmed' }]) {
    const s = base(); if (enrolled) s.continuationAccounting = enrolled; else delete s.continuationAccounting;
    A.throws(() => J.prepareEntry(s, job.id, receipt), 'every entry transition needs the exact confirmed root enrollment');
  }
}
A.report('linejobs.entry');
