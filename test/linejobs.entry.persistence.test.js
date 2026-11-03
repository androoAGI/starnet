'use strict';
/* Actual private host blocks + existing canonical stores. No provider/public
   caller/walker exists in this slice; a receipt replay is never dispatch proof. */
const A = require('./_assert.js'), fs = require('node:fs');
const { allocated, J, attempt } = require('./helpers/line-accounting-host.js');
const { fixture, clone } = require('./helpers/line-entry.js');
const { digest } = require('./helpers/line-continuation.js');
function setup(env) {
  const data = fixture();
  env.host.mutate(s => J.start(s, Object.assign({}, data.job, { at: 100 })));
  data.receipt.ledgerId = env.host.enroll().ledgerId;
  env.f.writes.length = 0;
  return data;
}
for (const mode of ['before', 'after']) allocated(env => {
  const { host, f, jobFile, raw } = env, data = setup(env);
  f[mode] = jobFile;
  A.ok(attempt(() => host.prepare(data.job.id, data.receipt)).error, mode + ': unconfirmed intent write has no ACK');
  f.before = ''; f.after = ''; f.readsBlocked.clear();
  const accepted = host.prepare(data.job.id, data.receipt);
  A.eq(accepted.receipt, data.receipt, mode + ': explicit retry retains exact original intent identity/input/limits');
  A.eq(f.writes.length, 1, mode + ': exactly one intent lands across lost ACK');
  A.eq(raw(jobFile).jobs[0].entryAdmission, accepted.receipt, mode + ': returned intent is canonical readback');
  A.eq(host.prepare(data.job.id, data.receipt).replayed, true, 'prepare retries are labeled as replay, never permission');
  A.eq(f.writes.length, 1, 'exact prepare retry performs no new write');
});
for (const mode of ['before', 'after']) allocated(env => {
  const { host, f, jobFile } = env, data = setup(env);
  host.prepare(data.job.id, data.receipt); f.writes.length = 0;
  const observed = data.observed(data.receipt);
  f[mode] = jobFile;
  A.ok(attempt(() => host.checkpoint(data.job.id, 1, observed)).error, mode + ': observed write failure is not acknowledged');
  f.before = ''; f.after = ''; f.readsBlocked.clear();
  const accepted = host.checkpoint(data.job.id, 1, observed);
  A.eq([accepted.receipt, accepted.usageStatus], [observed, 'observed'], mode + ': exact observation survives explicit retry');
  A.eq(f.writes.length, 1, mode + ': observed run is not rewritten after its ACK lands ambiguously');
  A.eq(host.checkpoint(data.job.id, 1, observed).replayed, true, 'exact observation ACK replay returns saved result');
});
allocated(env => {
  const { host, f, jobFile, loadHost, raw } = env, data = setup(env);
  f.after = jobFile;
  A.ok(attempt(() => host.prepare(data.job.id, data.receipt)).error, 'intent lands before its lost readback ACK');
  f.after = ''; f.readsBlocked.clear();
  const restarted = loadHost(), saved = restarted.prepare(data.job.id, data.receipt);
  A.eq([saved.receipt.state, saved.receipt.revision], ['uncertain', 2], 'restart reconciles saved intent to uncertain, not another dispatch');
  A.eq(saved.receipt.binding, data.receipt.binding, 'restart preserves original job/run/intake/stream/workitem IDs');
  A.eq(saved.usageStatus, 'unresolved', 'uncertain intent never implies known cost');
  const complete = restarted.checkpoint(data.job.id, 2, data.observed(saved.receipt));
  A.eq(raw(jobFile).jobs[0].entryAdmission, complete.receipt, 'explicit canonical result reconciliation uses the uncertain revision');
});
allocated(env => {
  const { host, f, spendFile, raw } = env, data = setup(env);
  host.prepare(data.job.id, data.receipt);
  const before = digest(fs.readFileSync(spendFile, 'utf8'));
  const accepted = host.checkpoint(data.job.id, 1, data.observed(data.receipt, true));
  A.eq(accepted.usageStatus, 'unresolved', 'actual private writer exposes observed usageMissing as unresolved cost');
  A.eq(accepted.receipt.observation.usd, 0.125, 'known floor remains recorded without claiming the remainder is known');
  const count = f.writes.length;
  A.ok(attempt(() => host.book(data.job.id, accepted.receipt.revision, 'run-entry')).error, 'missing usage cannot authorize the existing ledger checkpoint bridge');
  A.ok(attempt(() => host.mutate(s => J.checkpoint(s, data.job.id, 0, data.continuation))).error, 'entry cannot manufacture a continuation/adoption or execution permission');
  A.eq([f.writes.length, digest(fs.readFileSync(spendFile, 'utf8'))], [count, before], 'refused advancement buys no write or accounting assertion');
  A.eq(raw(spendFile).lines['line-a'].usd, 5, 'entry bookkeeping never charges the existing day ledger');
});
for (const mode of ['missing', 'recovered', 'mismatch']) allocated(env => {
  const { host, f, spendFile, raw, write, jobFile } = env, data = setup(env);
  host.prepare(data.job.id, data.receipt);
  const before = digest(fs.readFileSync(jobFile, 'utf8')), count = f.writes.length;
  if (mode === 'missing') { f.hidden.add(spendFile); f.hidden.add(spendFile + '.bak'); }
  else if (mode === 'recovered') { fs.copyFileSync(spendFile, spendFile + '.bak'); fs.writeFileSync(spendFile, '{corrupt fixture'); }
  else { const other = raw(spendFile); other.continuationAccounting.ledgerId = 'ledger-other'; write(spendFile, other); }
  A.ok(attempt(() => host.checkpoint(data.job.id, 1, data.observed(data.receipt))).error, mode + ': each transition requires matching canonical primary enrollment');
  A.eq([f.writes.length, digest(fs.readFileSync(jobFile, 'utf8'))], [count, before], mode + ': no result is published or job overwritten without paired proof');
});
allocated(env => {
  const { host, f, loadHost, spendFile, jobFile, raw } = env, data = setup(env);
  host.prepare(data.job.id, data.receipt);
  f.readsBlocked.add(spendFile);
  const count = f.writes.length, restarted = loadHost();
  A.eq([f.writes.length, raw(jobFile).jobs[0].entryAdmission.state], [count, 'intent'], 'failed boot enrollment proof preserves original intent bytes');
  f.readsBlocked.clear();
  const saved = restarted.prepare(data.job.id, data.receipt);
  A.eq(saved.receipt.state, 'uncertain', 'later canonical recovery finishes only the boot-owned uncertainty transition');
  const second = clone(data.job); second.id = 'job-laterentry01';
  restarted.mutate(s => J.start(s, Object.assign({}, second, { at: 300 })));
  const later = clone(data.receipt); later.binding.jobId = second.id; later.binding.entryRunId = 'run-later'; later.binding.workitemId = 'crate-later';
  restarted.prepare(second.id, later);
  restarted.prepare(data.job.id, data.receipt);
  A.eq(raw(jobFile).jobs.find(j => j.id === second.id).entryAdmission.state, 'intent', 'later refresh cannot mark newly active entry as boot-owned');
});
allocated(env => {
  const { host, f } = env, data = setup(env);
  host.prepare(data.job.id, data.receipt);
  const newer = Object.assign(clone(data.receipt), { revision: 2, state: 'uncertain' });
  host.checkpoint(data.job.id, 1, newer);
  const count = f.writes.length;
  A.ok(attempt(() => host.checkpoint(data.job.id, 1, data.observed(data.receipt))).error, 'a stale precomputed result cannot overwrite newer canonical uncertainty');
  A.eq(f.writes.length, count, 'stale CAS refusal leaves canonical state untouched');
});
A.report('linejobs.entry.persistence');
