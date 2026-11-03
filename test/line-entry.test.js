'use strict';
const A = require('./_assert.js'), C = require('../sidecar/routing/line-continuation.js');
const { fixture, clone } = require('./helpers/line-entry.js');
const { job, receipt, observed } = fixture();
const prepare = () => C.prepareEntry(undefined, job, receipt).receipt;
const next = (before, state) => Object.assign(clone(before), { revision: before.revision + 1, state });
A.ok(C.inspectEntry(receipt, job).ok, 'original typed intent is valid without invented output/cost');
A.eq(C.prepareEntry(undefined, job, receipt).replayed, false, 'initial intent is distinct from replay');
const uncertain = C.checkpointEntry(prepare(), job, 1, next(receipt, 'uncertain')).receipt;
const done = C.checkpointEntry(uncertain, job, 2, observed(uncertain)).receipt;
for (const prior of [receipt, uncertain, done]) {
  const replay = C.prepareEntry(prior, job, clone(receipt));
  A.eq(replay.receipt, prior, 'prepare replay returns actual saved state, never a fresh intent');
  A.eq(replay.replayed, true, 'prepare retry is labeled as a receipt replay');
}
A.eq(C.checkpointEntry(done, job, 2, clone(done)).replayed, true, 'lost observation ACK re-proves the exact result');
A.throws(() => C.checkpointEntry(uncertain, job, 1, observed(uncertain)), 'a stale transition cannot overwrite a newer revision');
A.throws(() => C.checkpointEntry(uncertain, job, 2, next(uncertain, 'intent')), 'uncertainty never resets to dispatchable intent');
A.throws(() => C.checkpointEntry(done, job, 3, Object.assign(clone(done), { revision: 4 })), 'observed receipt is immutable');
for (const edit of [r => { r.ledgerId = 'other'; }, r => { r.binding.entryRunId = 'other'; },
  r => { r.binding.workitemId = 'other'; }, r => { r.binding.planHash = 'cafefeed'; },
  r => { r.input.text = 'another request'; r.inputDigest = C.entryInputDigest(r.input); },
  r => { r.limits.maxUsd = 1000; }, r => { r.limits.maxUsdPerDay = null; },
  r => { r.restriction.hostPowerWithheld = false; }, r => { r.at++; }]) {
  const changed = clone(receipt); edit(changed);
  A.throws(() => C.prepareEntry(receipt, job, changed), 'conflicting prepare cannot replace original work or ceilings');
  changed.revision = 2; changed.state = 'uncertain';
  A.throws(() => C.checkpointEntry(receipt, job, 1, changed), 'transition cannot change original identity/input/restrictions');
}
for (const edit of [r => { r.binding.jobId = 'job-another01'; }, r => { r.binding.intakeId = null; },
  r => { r.binding.streamId = 'foreign'; }, r => { r.binding.lineId = 'foreign'; },
  r => { r.inputDigest = '0'.repeat(64); }, r => { r.revision = Number.MAX_SAFE_INTEGER + 1; },
  r => { r.at = -1; }, r => { r.observation = observed().observation; }]) {
  const changed = clone(receipt); edit(changed);
  A.ok(!C.inspectEntry(changed, job).ok, 'invalid binding/revision/input cannot become an intent');
}
for (const edit of [r => { r.observation.usd = -1; }, r => { r.observation.usd = Infinity; },
  r => { r.observation.endedAt = 99; }, r => { r.observation.product.producer.runId = 'foreign'; },
  r => { r.observation.outputDigest = '0'.repeat(64); }, r => { r.observation.files[0].producerRunId = 'foreign'; },
  r => { r.observation.product.taints = []; r.observation.outputDigest = C.entryOutputDigest(r.observation.product); },
  r => { r.observation.files = []; }]) {
  const changed = observed(); edit(changed);
  A.ok(!C.inspectEntry(changed, job).ok, 'unproved cost/output/producer/file/taint cannot be accepted');
}
const zero = observed(); zero.observation.usd = 0;
A.ok(C.inspectEntry(zero, job).ok, 'completed zero-USD work has a real observed receipt');
const missing = observed(receipt, true);
A.ok(C.inspectEntry(missing, job).ok, 'observed missing-usage fact is retained as uncertainty, not fabricated cost proof');
A.eq(C.demandEntry(missing, job).observation.usageMissing, true, 'schema never cleans missing usage into a confirmed amount');
const withInput = clone(receipt), inputFile = clone(observed().observation.files[0]);
inputFile.producerRunId = 'run-upstream'; inputFile.ref = C.fileRef(inputFile);
withInput.files = [inputFile]; withInput.input.fileRefs = [inputFile.ref]; withInput.inputDigest = C.entryInputDigest(withInput.input);
A.ok(C.inspectEntry(withInput, job).ok, 'input keeps the real earlier producer receipt');
const combined = observed(withInput);
combined.observation.product.files.unshift(inputFile.ref); combined.observation.outputDigest = C.entryOutputDigest(combined.observation.product);
A.ok(C.inspectEntry(combined, job).ok, 'observed output may reference the exact union of immutable input and produced files');
const conflicted = clone(combined), otherFile = clone(inputFile);
otherFile.digest = '1'.repeat(64); otherFile.ref = C.fileRef(otherFile);
conflicted.files.push(otherFile); conflicted.input.fileRefs.push(otherFile.ref); conflicted.inputDigest = C.entryInputDigest(conflicted.input);
A.ok(!C.inspectEntry(conflicted, job).ok, 'one producer/path cannot claim two conflicting content receipts');
const duplicateFile = clone(combined);
duplicateFile.observation.files.push(clone(duplicateFile.observation.files[0]));
A.ok(!C.inspectEntry(duplicateFile, job).ok, 'the full receipt union cannot duplicate file identity');
const atLimit = clone(receipt);
atLimit.files = Array.from({ length: C.MAX_FILES - 1 }, (_, i) => {
  const f = Object.assign(clone(inputFile), { path: '/fixture/input-' + i + '.txt' }); f.ref = C.fileRef(f); return f;
});
atLimit.input.fileRefs = atLimit.files.map(f => f.ref); atLimit.inputDigest = C.entryInputDigest(atLimit.input);
A.ok(C.inspectEntry(observed(atLimit), job).ok, '64 total input/output receipts fit the shared executable bound');
const overLimit = clone(atLimit), extra = Object.assign(clone(inputFile), { path: '/fixture/one-too-many.txt' });
extra.ref = C.fileRef(extra); overLimit.files.push(extra); overLimit.input.fileRefs.push(extra.ref); overLimit.inputDigest = C.entryInputDigest(overLimit.input);
A.ok(!C.inspectEntry(observed(overLimit), job).ok, 'separate input/output arrays cannot bypass the total 64-file bound');
const maximum = clone(receipt); maximum.revision = Number.MAX_SAFE_INTEGER;
A.throws(() => C.checkpointEntry(maximum, job, maximum.revision, observed(maximum)), 'safe-integer overflow cannot produce a next revision');
for (const raw of [{ version: 2, opaque: { keep: [1, 2] } }, null, JSON.parse('{"version":2,"__proto__":{"polluted":true}}')]) {
  const inspected = C.inspectEntry(raw, job);
  A.ok(!inspected.ok, 'future/malformed entry is never executable');
  A.eq(inspected.value, raw, 'bounded opaque entry is retained losslessly');
}
A.eq(Object.prototype.polluted, undefined, 'opaque data never assigns prototype keys');
let invoked = false;
const accessor = Object.defineProperty({}, 'text', { get() { invoked = true; return 'no'; }, enumerable: true });
A.ok(C.inspectEntry(accessor, job).readOnly, 'non-JSON authority makes the store read-only');
A.eq(invoked, false, 'capture never invokes saved accessors');
const oversized = { version: 2, data: 'x'.repeat(C.MAX_BYTES) };
const large = C.inspectEntry(oversized, job);
A.ok(large.readOnly && large.value === oversized, 'oversized raw entry remains original and cannot authorize erasing rewrite');
A.report('line-entry');
