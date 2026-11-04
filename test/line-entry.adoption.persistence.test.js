'use strict';
/* Actual extracted host owners and canonical domain stores. The trusted
   authority is explicitly synthetic; no saved-floor/public/provider proof. */
const A = require('./_assert.js'), fs = require('node:fs');
const { allocated, J, attempt } = require('./helpers/line-accounting-host.js');
const { C, clone, data } = require('./helpers/line-entry-adoption.js');
const digest = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
function setup(env, usd) {
  const f = data();
  env.host.mutate(s => J.start(s, Object.assign({}, f.job, { at: f.receipt.at })));
  f.receipt.ledgerId = env.host.enroll().ledgerId;
  f.entry.ledgerId = f.receipt.ledgerId;
  if (usd !== undefined) f.entry.observation.usd = usd;
  env.host.prepare(f.job.id, f.receipt);
  env.host.checkpoint(f.job.id, f.receipt.revision, f.entry);
  env.f.writes.length = 0;
  const phases = [], authority = q => { phases.push(q.phase); return q.entry.binding.planHash === f.plan.hash
    && q.entry.binding.lineId === f.job.line && q.entry.binding.intakeId === f.job.intakeId; };
  return Object.assign(f, { phases, authority, adapter: env.host.adoption(authority, f.chain) });
}
const countLedger = env => env.f.writes.filter(w => w.file === env.spendFile).length;
for (const usd of [0, 0.125]) allocated(env => {
  const f = setup(env, usd), accepted = f.adapter.adopt(f.job.id, f.entry.revision);
  A.eq(accepted.confirmed, true, 'canonical exact pair is confirmed');
  A.eq(f.phases, ['before-ledger', 'before-job-write'], 'trusted current authority checked at both required boundaries');
  A.eq(accepted.entry, f.entry, 'original observed evidence survives exact adoption');
  A.eq(accepted.continuation.accounting.dayReceipts, [{ runId: 'run-entry', day: 0, usd }], 'positive and zero costs each have their exact original-day receipt');
  A.eq(env.raw(env.spendFile).lines['line-a'].usd, 5 + usd, 'same-day bucket charges exactly the actual observed amount');
  A.eq(f.adapter.adopt(f.job.id, f.entry.revision).replayed, true, 'same job replay returns only its saved adoption');
  A.eq(countLedger(env), 1, 'same-job repetition cannot charge twice');
  const restarted = env.loadHost(), retry = restarted.adoption(f.authority, f.chain).adopt(f.job.id, f.entry.revision);
  A.eq(retry.entry, f.entry, 'restart retains full immutable entry');
  A.eq(retry.job.status, 'interrupted', 'restart/replayed adoption does not pretend the walk resumed');
  A.eq(countLedger(env), 1, 'restart ACK reproof never charges again');
  A.eq(env.raw(env.jobFile).jobs[0].continuation, retry.continuation, 'returned continuation is canonical exact readback');
});
for (const owner of ['spendFile', 'jobFile']) for (const mode of ['before', 'after']) allocated(env => {
  const f = setup(env), target = env[owner]; env.f[mode] = target;
  const refused = attempt(() => f.adapter.adopt(f.job.id, f.entry.revision));
  A.ok(refused.error, owner + '/' + mode + ': unconfirmed primary write returns no adoption ACK');
  A.eq(env.raw(env.jobFile).jobs[0].entryAdmission, f.entry, 'storage fault preserves actual entry evidence');
  env.f.before = ''; env.f.after = ''; env.f.readsBlocked.clear();
  const restarted = env.loadHost(), retry = restarted.adoption(f.authority, f.chain).adopt(f.job.id, f.entry.revision);
  A.eq(retry.confirmed, true, owner + '/' + mode + ': restart retries only exact receipt/CAS');
  A.eq(env.raw(env.spendFile).lines['line-a'].usd, 5.125, 'fault/restart never duplicates cost');
  A.eq(countLedger(env), 1, 'only one ledger write lands across either lost ACK');
  A.eq(env.raw(env.jobFile).jobs[0].entryAdmission, f.entry, 'retry cannot replace original run/input/output');
});
allocated(env => {
  const f = setup(env), saved = [];
  env.f.onWrite = (target, written) => {
    if (target !== env.jobFile || !written.jobs[0].continuation) return;
    const value = env.raw(env.jobFile); value.jobs[0].continuation.walk.lastHanded = 'contradictory but structurally valid draft';
    A.ok(C.inspectEntryPair(value.jobs[0].entryAdmission, value.jobs[0].continuation, value.jobs[0]).ok, 'fault really installs another valid pair, not malformed JSON');
    env.write(env.jobFile, value); saved.push(digest(fs.readFileSync(env.jobFile)));
  };
  A.ok(attempt(() => f.adapter.adopt(f.job.id, f.entry.revision)).error, 'different valid landed cursor cannot become an exact ACK');
  env.f.onWrite = null;
  A.ok(attempt(() => f.adapter.adopt(f.job.id, f.entry.revision)).error, 'retry cannot overwrite the contradictory canonical cursor');
  A.eq(digest(fs.readFileSync(env.jobFile)), saved[0], 'contradictory landed bytes remain untouched');
  A.eq(env.raw(env.spendFile).lines['line-a'].usd, 5.125, 'contradictory job evidence does not rebook money');
});
allocated(env => {
  const f = setup(env);
  env.f.onWrite = (target, written) => {
    if (target !== env.jobFile || !written.jobs[0].continuation) return;
    env.f.onWrite = null;
    const error = new Error('fixture exact landed job ACK lost'); error.code = 'EIO'; throw error;
  };
  const accepted = f.adapter.adopt(f.job.id, f.entry.revision);
  A.eq(accepted.confirmed, true, 'exact landed job with lost ACK reconciles only by fresh canonical pair');
  A.ok(accepted.storageError, 'reconciled ACK still exposes the actual storage incident');
  A.eq(accepted.entry, f.entry, 'lost ACK cannot substitute terminal evidence');
  A.eq(countLedger(env), 1, 'exact job ACK reconciliation never reruns accounting');
});
allocated(env => {
  const f = setup(env); let calls = 0;
  const adapter = env.host.adoption(() => ++calls === 1, f.chain);
  A.ok(attempt(() => adapter.adopt(f.job.id, f.entry.revision)).error, 'current ownership revocation before job write refuses');
  A.ok(!env.raw(env.jobFile).jobs[0].continuation, 'no cursor publishes after authority loss');
  A.eq(env.raw(env.spendFile).lines['line-a'].usd, 5.125, 'already observed cost receipt survives ownership refusal');
  A.eq(f.adapter.adopt(f.job.id, f.entry.revision).confirmed, true, 'explicit later retry can prove the same exact receipt');
  A.eq(countLedger(env), 1, 'later authority recovery never recharges the entry');
});
allocated(env => {
  const f = setup(env), before = digest(fs.readFileSync(env.spendFile));
  for (const authority of [null, () => false, () => Promise.resolve(true)]) {
    A.ok(attempt(() => env.host.adoption(authority, f.chain).adopt(f.job.id, f.entry.revision)).error, 'absent/false/async authority cannot authorize private adoption');
  }
  A.eq(digest(fs.readFileSync(env.spendFile)), before, 'refused initial authority buys no ledger write');
  A.ok(!env.raw(env.jobFile).jobs[0].continuation, 'refused initial authority never creates a cursor');
});
for (const kind of ['missing', 'recovered', 'unreadable', 'foreign']) allocated(env => {
  const f = setup(env), before = digest(fs.readFileSync(env.jobFile));
  if (kind === 'missing') { env.f.hidden.add(env.spendFile); env.f.hidden.add(env.spendFile + '.bak'); }
  if (kind === 'recovered') { fs.copyFileSync(env.spendFile, env.spendFile + '.bak'); fs.writeFileSync(env.spendFile, '{broken fixture'); }
  if (kind === 'unreadable') env.f.readsBlocked.add(env.spendFile);
  if (kind === 'foreign') { const value = env.raw(env.spendFile); value.continuationAccounting.ledgerId = 'foreign-ledger'; env.write(env.spendFile, value); }
  A.ok(attempt(() => f.adapter.adopt(f.job.id, f.entry.revision)).error, kind + ': no canonical matching accounting pair means no adoption');
  A.eq(digest(fs.readFileSync(env.jobFile)), before, kind + ': original job bytes preserved');
  A.eq(env.f.writes.length, 0, kind + ': no attempted owner mutation');
});
for (const mode of ['missing-usage', 'failed', 'files', 'wrong-day']) allocated(env => {
  const f = setup(env), raw = env.raw(env.jobFile);
  if (mode === 'missing-usage') raw.jobs[0].entryAdmission.observation.usageMissing = true;
  if (mode === 'failed') raw.jobs[0].entryAdmission.observation.outcome = 'failed';
  if (mode === 'files') raw.jobs[0].entryAdmission.observation.files = [{ unproved: true }];
  if (mode === 'wrong-day') raw.jobs[0].entryAdmission.observation.endedAt = 86400000 + 100;
  env.write(env.jobFile, raw);
  const before = digest(fs.readFileSync(env.spendFile));
  A.ok(attempt(() => f.adapter.adopt(f.job.id, f.entry.revision)).error, mode + ': refused before cursor publication');
  A.eq(digest(fs.readFileSync(env.spendFile)), before, mode + ': unavailable observation cannot charge a chosen amount');
});
allocated(env => {
  const f = setup(env); f.adapter.adopt(f.job.id, f.entry.revision);
  env.f.now = 2 * 86400000;
  env.host.ledger.note('line-a', 0.5);
  const before = clone(env.raw(env.spendFile));
  A.eq(f.adapter.adopt(f.job.id, f.entry.revision).receipt.day, 0, 'cross-day replay retains its original day');
  A.eq(env.raw(env.spendFile), before, 'later day bucket and retained receipts stay byte-equivalent on replay');
});
allocated(env => {
  const f = setup(env); env.f.now = 2 * 86400000;
  env.host.ledger.note('line-a', 0.5);
  const before = digest(fs.readFileSync(env.spendFile));
  A.ok(attempt(() => f.adapter.adopt(f.job.id, f.entry.revision)).error, 'newer bucket with no historical receipt is obsolete/unconfirmed, not a proof');
  A.eq(digest(fs.readFileSync(env.spendFile)), before, 'obsolete entry never charges today');
  A.ok(!env.raw(env.jobFile).jobs[0].continuation, 'unconfirmed old cost never produces ready cursor');
});
(async () => {
  await allocated(async env => {
    const f = setup(env), results = await Promise.all([0, 1].map(() => Promise.resolve().then(() => f.adapter.adopt(f.job.id, f.entry.revision))));
    A.eq(results.map(r => r.replayed), [false, true], 'concurrent same-job requests select one canonical adoption and exact replay');
    A.eq(countLedger(env), 1, 'concurrent callers share the original run receipt');
    const other = clone(f.job); other.id = 'job-conflict0001';
    env.host.mutate(s => J.start(s, Object.assign(other, { at: 200 })));
    const request = clone(f.receipt); request.binding.jobId = other.id;
    const observation = clone(f.entry); observation.binding.jobId = other.id;
    env.host.prepare(other.id, request); env.host.checkpoint(other.id, request.revision, observation);
    A.ok(attempt(() => f.adapter.adopt(other.id, observation.revision)).error, 'another job cannot claim the same paid run receipt');
    A.eq(countLedger(env), 1, 'conflicting job receipt cannot charge or steal the original run');
  });
  A.report('line-entry.adoption.persistence');
})().catch(error => { console.error(error); process.exitCode = 1; });
