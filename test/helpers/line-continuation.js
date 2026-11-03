'use strict';
const crypto = require('node:crypto');
const C = require('../../sidecar/routing/line-continuation.js');
const digest = s => crypto.createHash('sha256').update(s).digest('hex');
const clone = x => JSON.parse(JSON.stringify(x));
function fixture() {
  const job = { id: 'job-holdfixture1', line: 'line-a', intakeId: 'intake-a', entry: 'sample', streamId: 'sample-hold',
    status: 'running', startedAt: 100, runs: [], output: '', text: 'write the draft' };
  const node = { agentId: 'reviewer', dockId: 'dock-reviewer' };
  const file = { path: '/fixture/project/draft.txt', producerRunId: 'run-entry', projectRoot: '/fixture/project', digest: digest('draft file'), size: 10 };
  file.ref = C.fileRef(file);
  const product = { text: 'finished draft\nVERDICT: blocked', draft: 'draft before review', verdict: 'blocked',
    files: [file.ref], producer: { kind: 'run', runId: 'run-entry' }, taints: ['upstream agent output'] };
  const continuation = { version: 1, revision: 1, phase: 'held',
    binding: { jobId: job.id, lineId: job.line, intakeId: job.intakeId, streamId: job.streamId, entryRunId: 'run-entry',
      planHash: 'deadbeef', dockMode: true, entryNode: clone(node) }, origin: { kind: 'sample' },
    restriction: { entryUntrusted: true, hostPowerWithheld: true, taints: ['webhook payload'] },
    walk: { current: clone(node), next: { kind: 'gate', node: null, gateId: '12,4', joinId: null, outboxId: null, fromTile: null, via: null },
      product: clone(product), originalText: job.text, lastHanded: 'draft before review', producerVerdict: 'blocked', hop: 0, loopHops: 0, visited: [node.dockId],
      gates: [{ id: '12,4', count: 1, max: 5 }], openLoops: [], fromTile: null, via: null,
      entryOutput: clone(product), branchMode: false, pending: [], forced: null, fan: null, partial: null, unapproved: null },
    barriers: [], accounting: { entryUsd: 0.125, hopUsd: 0, runIds: ['run-entry'], dayReceipts: [{ runId: 'run-entry', day: 0, usd: 0.125 }],
      limits: { maxHops: 24, maxUsd: 2, maxUsdPerDay: 10 } },
    attempts: [{ ordinal: 1, runId: 'run-entry', node: clone(node), branchId: null, workitemId: 'crate-entry', state: 'observed',
      inputDigest: digest(job.text), outputDigest: digest(product.text), usd: 0.125, usageMissing: false, outcome: 'succeeded', at: 100, endedAt: 110 }],
    files: [file], hold: { gateId: '12,4', reason: 'blocked', why: 'the reviewer held this draft', pass: 1, allowed: ['approve', 'send_back', 'stop'] },
    decisions: [], activeDecision: null, terminal: null, publication: null };
  return { job, continuation };
}
module.exports = { fixture, clone, digest };
