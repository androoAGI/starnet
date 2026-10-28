'use strict';

const assert = require('assert');
const { DISPLAY_STATUS, mergeRunRows, projectHistoricalEvidence } = require('../sidecar/historical-evidence-projection');

const target = { goalId: 'goal_1793148657080', milestoneId: 'goal_1793148657080:m1', projectId: 'youtube-channels', projectRoot: 'C:/Projects/YouTube Channels' };
function run(overrides = {}) {
  return { runId: 'run-1', reason: 'done', ts: '2026-10-26T10:00:00Z', projectRoot: target.projectRoot,
    title: 'Execute YouTube task yt-001', deliveryText: '', artifacts: [], completionEvidence: { completionVerdict: 'not_assessed' }, ...overrides };
}

(function testExplicitAssociationAndSafety() {
  const result = projectHistoricalEvidence({ targets: [target], projectRoot: target.projectRoot,
    runs: [run({ deliveryText: `${target.goalId} ${target.milestoneId}` })], tasks: [], controllerLedger: [],
    canonicalProgress: { questId: 'q:5', status: 'open', done: 0, total: 5 } });
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].association.matchType, 'explicit');
  assert.strictEqual(result.items[0].displayStatus, DISPLAY_STATUS);
  assert.strictEqual(result.safety.canonicalMutationPerformed, false);
  assert.strictEqual(result.safety.xpAwarded, false);
  assert.deepStrictEqual(result.canonicalProgress, { questId: 'q:5', status: 'open', done: 0, total: 5 });
})();

(function testIncompleteControllerTaskAndValidation() {
  const result = projectHistoricalEvidence({ targets: [target], projectRoot: target.projectRoot,
    runs: [run({ runId: 'star-net-yt-001', deliveryText: 'yt-001', artifacts: [{ path: 'Research/validation/yt-001-demand-competitor-gap.md' }] })],
    tasks: [{ task_id: 'yt-001', status: 'needs_correction', run_id: 'yt-001-4513d884-ab7b-49fe-8110-95ac7bc70d01', validation_status: 'failed_acceptance_criteria', outputs_path: 'Research/validation/yt-001-demand-competitor-gap.md' }],
    controllerLedger: [{ task_id: 'yt-001', run_id: 'yt-001-4513d884-ab7b-49fe-8110-95ac7bc70d01', validation: { outcome: 'failed_acceptance_criteria' }, result: 'partial_research_artifact' }] });
  const item = result.items.find(x => x.controllerTaskId === 'yt-001');
  assert.ok(item);
  assert.strictEqual(item.validation.controller, 'failed');
  assert.strictEqual(item.association.matchType, 'project-or-task');
  assert.strictEqual(item.displayStatus, DISPLAY_STATUS);
})();

(function testBlockedTaskWithSuccessfulRetrievalDoesNotBecomeCompletion() {
  const result = projectHistoricalEvidence({ targets: [target], projectRoot: target.projectRoot,
    runs: [run({ runId: '39e7b9af-8426-472c-8520-b4d0421e0940', deliveryText: 'yt-004 yt-rkb-011', artifacts: [{ path: 'Research/strategy/yt-004-indexed-research-recommendation.md' }] })],
    tasks: [{ task_id: 'yt-004', status: 'blocked_by_dependency', outputs_path: 'Research/strategy/yt-004-indexed-research-recommendation.md', retrieval_test: { status: 'passed', run_id: '39e7b9af-8426-472c-8520-b4d0421e0940' } }], controllerLedger: [] });
  const item = result.items.find(x => x.sourceType === 'controller-task' && x.controllerTaskId === 'yt-004');
  assert.ok(item);
  assert.strictEqual(item.validation.taskStatus, 'blocked_by_dependency');
  assert.strictEqual(item.validation.retrieval, 'passed');
  assert.strictEqual(item.displayStatus, DISPLAY_STATUS);
})();

(function testDuplicateEvidenceIsCollapsed() {
  const rows = [run({ artifacts: [{ path: 'Research/observed.md' }] }), run({ artifacts: [{ path: 'Research/observed.md' }], deliveryText: 'duplicate dispatch delivery', dispatchDelivery: { text: 'duplicate dispatch delivery' } })];
  const result = projectHistoricalEvidence({ targets: [target], projectRoot: target.projectRoot, runs: rows, tasks: [], controllerLedger: [] });
  assert.strictEqual(mergeRunRows(rows).length, 1);
  assert.strictEqual(result.items.filter(x => x.sourceId === 'run-1').length, 1);
})();

(function testUnrelatedExecutionIsExcluded() {
  const result = projectHistoricalEvidence({ targets: [target], projectRoot: target.projectRoot,
    runs: [run({ runId: 'unrelated', projectRoot: 'C:/Projects/Other', title: 'Other project work' })], tasks: [], controllerLedger: [] });
  assert.strictEqual(result.items.length, 0);
})();

(function testSourceKindsRemainReusable() {
  const result = projectHistoricalEvidence({ targets: [target], projectRoot: target.projectRoot,
    runs: [run({ runId: 'routine-1', cronJobId: 'cron-1', artifacts: [{ path: 'Research/routine.md' }] }),
      run({ runId: 'conveyor-1', lineId: 'line-1', bayId: 'bay-1', artifacts: [{ path: 'Research/conveyor.md' }] })], tasks: [], controllerLedger: [] });
  assert.strictEqual(result.items.find(x => x.sourceId === 'routine-1').sourceKind, 'routine');
  assert.strictEqual(result.items.find(x => x.sourceId === 'conveyor-1').sourceKind, 'conveyor');
  assert.strictEqual(result.safety.historicalEventsInvented, false);
})();

(function testAmbiguousAssociationIsNotSettled() {
  const second = { ...target, goalId: 'goal-other', milestoneId: 'goal-other:m1' };
  const result = projectHistoricalEvidence({ targets: [target, second], projectRoot: target.projectRoot,
    runs: [run({ runId: 'ambiguous', deliveryText: 'goal_1793148657080 goal-other' })], tasks: [], controllerLedger: [] });
  assert.strictEqual(result.items[0].association.matchType, 'ambiguous');
  assert.strictEqual(result.items[0].association.confidence, 'low');
  assert.strictEqual(result.items[0].displayStatus, DISPLAY_STATUS);
})();

console.log('historical-evidence-projection.test.js: PASS');

(function testEmailInterviewGoalExactAssociation() {
  const emailTarget = { goalId: 'goal_email_responder_interview_coach', milestoneId: 'goal_email_responder_interview_coach:m2', projectId: 'email-interview', projectRoot: 'C:/Projects/Email Interview' };
  const result = projectHistoricalEvidence({ targets: [emailTarget], projectRoot: emailTarget.projectRoot,
    runs: [{ runId: 'email-i02-run', reason: 'done', projectRoot: emailTarget.projectRoot, title: 'I-02 pilot', deliveryText: `${emailTarget.goalId} ${emailTarget.milestoneId}`, completionEvidence: { completionVerdict: 'not_assessed' }, artifacts: ['interview-coach-i02-pilot-evidence.md'] },
      { runId: 'unrelated-interview', reason: 'done', projectRoot: 'C:/Projects/Other', title: 'Interview Coach same topic', artifacts: [] }], tasks: [], controllerLedger: [], canonicalProgress: { status: 'open', done: 0, total: 5 } });
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].runId, 'email-i02-run');
  assert.strictEqual(result.items[0].association.matchType, 'explicit');
  assert.strictEqual(result.items[0].displayStatus, DISPLAY_STATUS);
  assert.strictEqual(result.safety.completionSettlementPerformed, false);
})();

console.log('historical-evidence-projection.email-interview.test: PASS');
