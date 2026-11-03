'use strict';
/* Common old/current operations: a prepared marker is seeded as disk data, then
   actual pre-existing mutation/legacy APIs must preserve it. No missing-method red. */
const A = require('./_assert.js');
const { J, Spend, metadata, allocated } = require('./helpers/line-accounting-host.js');
const { fixture, clone } = require('./helpers/line-continuation.js');
const meta = metadata(), data = fixture();
function seed() { return Object.assign(J.start({ jobs: [] }, Object.assign({}, data.job, { at: 100 })).state, { continuationAccounting: clone(meta) }); }
const id = data.job.id;
const cases = [
  ['normalize', s => J.normalizeAll(s)],
  ['start', s => J.start(s, { id: 'job-retentionnext', line: 'line-a', streamId: 'next-stream', at: 200 }).state],
  ['finish', s => J.finish(s, id, { status: 'failed', outcome: 'error', at: 200, usd: 0, output: '', runs: [] }).state],
  ['mark', s => J.mark(s, id, 'paused').state],
  ['note', s => J.note(s, id, { kind: 'fix', text: 'saved change', at: 200 }).state],
  ['link', s => J.link(s, id, { line: 'line-b', jobId: 'job-retentionnext' }).state],
  ['again', s => J.again(s, id, 200).state],
  ['boot', s => J.boot(s, 200).state],
  ['checkpoint', s => J.checkpoint(s, id, 0, data.continuation).state],
  ['claimDecision', s => {
    const held = J.checkpoint(s, id, 0, data.continuation).state;
    // Seed independently so the claim control is not only a consequence of checkpoint's defect.
    held.continuationAccounting = clone(meta);
    return J.claimDecision(held, id, { token: 'keep-enrollment', revision: 1, action: 'approve', note: '', at: 200 }).state;
  }]
];
for (const [name, operation] of cases) A.eq(operation(seed()).continuationAccounting, meta, name + ' preserves permanent root enrollment');

let retained = Object.assign({ jobs: [] }, { continuationAccounting: clone(meta) });
for (let i = 0; i < J.MAX_JOBS + 8; i++) {
  const jobId = 'job-' + String(i).padStart(12, '0');
  retained = J.start(retained, { id: jobId, line: 'line-a', at: i + 1 }).state;
  retained = J.finish(retained, jobId, { status: 'failed', outcome: 'error', at: i + 2, usd: 0, runs: [] }).state;
}
A.eq(retained.jobs.length, J.MAX_JOBS, 'existing fair retention still bounds completed jobs');
A.ok(!J.get(retained, 'job-000000000000'), 'the original completed job really aged out');
A.eq(J.normalizeAll(retained).continuationAccounting, meta, 'enrollment outlives the complete job that happened to exist when it was written');

for (const raw of [null, { version: 2, ledgerId: 'future', state: 'confirmed', opaque: { keep: ['exact', 3] } },
  { version: 1, ledgerId: 'ledger-fixture', state: 'confirmed', extra: 'do not erase' },
  JSON.parse('{"version":2,"__proto__":{"polluted":true},"opaque":[1,2]}')]) {
  const input = seed(); input.continuationAccounting = raw;
  const normalized = J.normalizeAll(input);
  A.eq(normalized.continuationAccounting, raw, 'unknown enrollment is retained opaquely by normalization');
  A.throws(() => J.note(normalized, id, { kind: 'fix', text: 'must refuse' }), 'ordinary job mutation cannot erase unknown enrollment');
  A.eq(Object.prototype.polluted, undefined, 'opaque metadata never assigns prototype keys');
}

allocated(({ host, raw, spendFile, jobFile, f }) => {
  A.eq(host.ledger.spentToday('line-a'), 5, 'enrolled ledger retains its existing five-dollar floor');
  host.ledger.note('line-a', 0.25);
  A.eq(raw(spendFile).continuationAccounting, meta, 'actual host legacy note preserves root enrollment');
  A.eq(raw(spendFile).lines['line-a'].usd, 5.25, 'legacy note still adds exactly its observed amount');
  A.ok(!Object.hasOwn(raw(spendFile).lines, 'continuationAccounting'), 'metadata is never a synthetic line bucket');
  f.now += Spend.DAY_MS;
  host.ledger.note('line-a', 0.5);
  A.eq([raw(spendFile).continuationAccounting, raw(spendFile).lines['line-a']], [meta, { day: 1, usd: 0.5 }], 'day rollover preserves enrollment and existing bucket semantics');
  host.mutate(s => J.start(s, { id: 'job-rootmutator1', line: 'line-a', at: 500 }));
  A.eq(raw(jobFile).continuationAccounting, meta, 'actual host codec and ordinary mutation preserve job-root enrollment');
}, ({ write, jobFile, spendFile }) => {
  write(jobFile, { version: 1, jobs: [], continuationAccounting: meta });
  write(spendFile, { version: 1, lines: { 'line-a': { day: 0, usd: 5 } }, continuationAccounting: meta });
});

for (const kind of ['load/save', 'read/write']) {
  let value = { 'line-a': { day: 0, usd: 5 } };
  const save = v => { value = clone(v); };
  const ledger = Spend.makeLineSpend(Object.assign({ now: () => 1000 }, kind === 'load/save'
    ? { load: () => value, save } : { read: () => ({ status: 'ok', value }), write: save }));
  A.eq(ledger.note('line-a', 0.25), 5.25, kind + ' injected legacy contract still adds actual spend');
  A.eq(value, { 'line-a': { day: 0, usd: 5.25 } }, kind + ' callback still receives a flat line table');
  A.eq(ledger.snapshot(), value, kind + ' snapshot stays the established flat projection');
}
A.report('line-accounting.retention');
