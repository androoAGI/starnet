'use strict';
const assert = require('assert');
const { makeHistoricalEvidenceHost } = require('../sidecar/historical-evidence-host');

(async () => {
  const host = makeHistoricalEvidenceHost({ readRuns: () => [
    { runId: 'email-run', goalId: 'goal_1793146919407', milestoneId: 'goal_1793146919407:m2', agentId: 'agent', reason: 'done', artifacts: ['qa.md'], validation: { outcome: 'passed' } },
    { runId: 'same-topic-no-id', title: 'Email Responder QA', reason: 'done' },
    { runId: 'yt-failed', association: { goalId: 'goal_1793148657080', milestoneId: 'goal_1793148657080:m1' }, reason: 'failed', validation: { outcome: 'failed' } }
  ], readDeliverables: () => [] });
  const snapshot = await host.snapshot();
  assert.strictEqual(snapshot.readOnly, true);
  assert.strictEqual(snapshot.items.length, 2);
  assert.ok(snapshot.items.some(x => x.runId === 'email-run'));
  assert.ok(snapshot.items.some(x => x.runId === 'yt-failed' && x.status === 'failed'));
  assert.ok(snapshot.items.every(x => x.completion === false));
  assert.strictEqual(snapshot.safety.canonicalMutationPerformed, false);
  const unavailable = await makeHistoricalEvidenceHost({ readRuns: () => { throw new Error('unavailable'); } }).snapshot();
  assert.deepStrictEqual(unavailable.items, []);
  console.log('historical-evidence-host.test.js: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
