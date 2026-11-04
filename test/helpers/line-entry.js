'use strict';
const C = require('../../sidecar/routing/line-continuation.js');
const { fixture: continuationFixture, clone } = require('./line-continuation.js');
function fixture() {
  const old = continuationFixture(), job = old.job, c = old.continuation;
  const input = { text: job.text, fileRefs: [] };
  const receipt = { version: 1, revision: 1, state: 'intent', ledgerId: 'ledger-entry-fixture',
    binding: { jobId: job.id, lineId: job.line, intakeId: job.intakeId, streamId: job.streamId,
      entryRunId: 'run-entry', workitemId: 'crate-entry', entryNode: clone(c.binding.entryNode), planHash: c.binding.planHash },
    origin: clone(c.origin), restriction: clone(c.restriction), input, inputDigest: C.entryInputDigest(input),
    files: [], limits: clone(c.accounting.limits), at: 100, observation: null };
  const product = clone(c.walk.entryOutput);
  product.taints = Array.from(new Set(product.taints.concat(receipt.restriction.taints)));
  const observation = { endedAt: 110, usd: 0.125, usageMissing: false, outcome: 'succeeded', product,
    files: clone(c.files), outputDigest: C.entryOutputDigest(product) };
  const observed = (before, missing) => Object.assign(clone(before || receipt), { revision: (before || receipt).revision + 1,
    state: 'observed', observation: Object.assign(clone(observation), { usageMissing: !!missing }) });
  return { job, receipt, observation, observed, continuation: c };
}
module.exports = { fixture, clone };
