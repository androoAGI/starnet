'use strict';
const A = require('./_assert.js'), fs = require('node:fs');
const { allocated, J, attempt } = require('./helpers/line-accounting-host.js');
const { data } = require('./helpers/line-entry-adoption.js');
function setup(env, usd) {
  const f = data();
  env.host.mutate(s => J.start(s, Object.assign({}, f.job, { at: 100 })));
  f.receipt.ledgerId = env.host.enroll().ledgerId; f.entry.ledgerId = f.receipt.ledgerId;
  f.entry.observation.usd = usd;
  env.host.prepare(f.job.id, f.receipt); env.host.checkpoint(f.job.id, 1, f.entry);
  return Object.assign(f, { adapter: env.host.adoption(() => true, f.chain) });
}
function removeReceipt(env) {
  const value = env.raw(env.spendFile);
  value.lines['line-a'].receipts = []; // valid shape, same marker/day/exact bucket USD
  env.write(env.spendFile, value);
  return fs.readFileSync(env.spendFile, 'utf8');
}
for (const usd of [0, 0.125]) for (const restart of [false, true]) allocated(env => {
  const f = setup(env, usd), accepted = f.adapter.adopt(f.job.id, 2);
  A.eq(accepted.confirmed, true, 'positive/zero initial exact adoption is established');
  const before = removeReceipt(env), jobBefore = fs.readFileSync(env.jobFile, 'utf8');
  const host = restart ? env.loadHost() : env.host;
  const bootedJob = fs.readFileSync(env.jobFile, 'utf8');
  const replay = attempt(() => host.adoption(() => true, f.chain).adopt(f.job.id, 2));
  A.ok(replay.error, 'saved-pair receipt disappearance refuses replay, same-process and restart');
  A.eq(env.raw(env.spendFile).lines['line-a'].usd, 5 + usd, 'receipt disappearance cannot double-charge the known bucket');
  A.eq(fs.readFileSync(env.spendFile, 'utf8'), before, 'read-only proof does not recreate even a zero-dollar receipt');
  A.eq(fs.readFileSync(env.jobFile, 'utf8'), restart ? bootedJob : jobBefore, 'refused replay preserves canonical job after its separate boot reconciliation');
});
for (const lostAck of [false, true]) allocated(env => {
  const f = setup(env, 0.125); let missingBytes;
  env.f.onWrite = (target, value) => {
    if (target !== env.jobFile || !value.jobs[0].continuation) return;
    env.f.onWrite = null; missingBytes = removeReceipt(env);
    if (lostAck) { const error = new Error('fixture lost ACK after receipt disappeared'); error.code = 'EIO'; throw error; }
  };
  const result = attempt(() => f.adapter.adopt(f.job.id, 2));
  A.ok(result.error, 'receipt loss during actual job rename cannot become an adoption ACK');
  A.ok(!!env.raw(env.jobFile).jobs[0].continuation, 'fault really landed the paired job before receipt loss');
  A.ok(attempt(() => f.adapter.adopt(f.job.id, 2)).error, 'paired retry after during-write loss remains refused');
  A.eq(fs.readFileSync(env.spendFile, 'utf8'), missingBytes, 'post-readback/lost-ACK proof never repairs the missing receipt by charging again');
});
allocated(env => {
  const f = setup(env, 0.125); f.adapter.adopt(f.job.id, 2);
  const observed = { jobId: f.job.id, runId: 'run-entry', endedAt: f.entry.observation.endedAt };
  A.eq(env.host.ledger.receiptProof('line-a', 0.125, observed, f.entry.ledgerId).confirmed, true, 'existing owner exposes exact read-only primary proof');
  const before = fs.readFileSync(env.spendFile, 'utf8'), writes = env.f.writes.length;
  for (const [line, usd, record, ledgerId] of [
    ['other-line', 0.125, observed, f.entry.ledgerId], ['line-a', 0.25, observed, f.entry.ledgerId],
    ['line-a', 0.125, Object.assign({}, observed, { jobId: 'job-foreign001' }), f.entry.ledgerId],
    ['line-a', 0.125, Object.assign({}, observed, { endedAt: 86400001 }), f.entry.ledgerId],
    ['line-a', 0.125, observed, 'foreign-ledger']
  ]) A.ok(attempt(() => env.host.ledger.receiptProof(line, usd, record, ledgerId)).error, 'read proof binds ledger/line/job/day/amount exactly');
  A.eq(env.f.writes.length, writes, 'read-only mismatches perform no canonical write');
  A.eq(fs.readFileSync(env.spendFile, 'utf8'), before, 'read-only mismatches preserve the exact ledger');
});
A.report('line-entry.adoption-receipts');
