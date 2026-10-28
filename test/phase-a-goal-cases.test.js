'use strict';
const assert = require('assert');
const { projectHistoricalEvidence } = require('../sidecar/historical-evidence-projection');
const Goals = require('../frontend/app/goals.js');

function target(goalId, milestoneId, projectId, projectRoot) { return { goalId, milestoneId, projectId, projectRoot }; }
function run(runId, t, extra = {}) {
  return { runId, reason: 'done', ts: '2026-10-28T10:00:00Z', projectRoot: t.projectRoot,
    title: 'verified historical execution', artifacts: ['evidence.md'],
    deliveryText: `${t.goalId} ${t.milestoneId}`, completionEvidence: { completionVerdict: 'not_assessed' }, ...extra };
}

(function emailInterviewCase() {
  const t = target('goal_1793146919407', 'goal_1793146919407:m2', 'email-interview', 'C:/Projects/Email Interview');
  const before = { status: 'active', done: 1, total: 5, xp: 0, points: 0 };
  const result = projectHistoricalEvidence({ targets: [t], projectRoot: t.projectRoot,
    runs: [run('email-i02', t, { title: 'Interview Coach I-02 pilot' }), run('email-qa', t, { title: 'Email safety validation' })],
    tasks: [], controllerLedger: [], canonicalProgress: before });
  assert.strictEqual(result.items.length, 2);
  assert.strictEqual(result.canonicalProgress, before);
  assert.ok(result.items.every(item => item.displayStatus.includes('not yet settled')));
  assert.deepStrictEqual(result.safety, { canonicalMutationPerformed: false, xpAwarded: false, commanderPointsAwarded: false, historicalEventsInvented: false, completionSettlementPerformed: false });
  const goal = Goals.makeGoal('Email and Interview', ['Define tests', 'Execute scenarios', 'Document defects'], null, 1);
  const cards = Goals.projectRelatedWork(goal, [{ runId: 'email-i02', goalId: goal.id, milestoneId: goal.milestones[1].id, title: 'I-02' }]);
  assert.strictEqual(cards[0].completion, false);
})();

(function youtubeCase() {
  const t = target('goal_1793148657080', 'goal_1793148657080:m1', 'youtube-channels', 'C:/Projects/YouTube Channels');
  const result = projectHistoricalEvidence({ targets: [t], projectRoot: t.projectRoot,
    runs: [run('yt-001-run', t, { title: 'yt-001', completionEvidence: { completionVerdict: 'failed_acceptance_criteria' } }),
      run('yt-004-run', t, { title: 'yt-004', completionEvidence: { completionVerdict: 'blocked_by_dependency' } })],
    tasks: [{ task_id: 'yt-001', status: 'needs_correction', run_id: 'yt-001-controller' },
      { task_id: 'yt-004', status: 'blocked_by_dependency', run_id: 'yt-004-controller' }],
    controllerLedger: [{ task_id: 'yt-001', run_id: 'yt-001-controller', validation: { outcome: 'failed_acceptance_criteria' } },
      { task_id: 'yt-004', run_id: 'yt-004-controller', validation: { outcome: 'blocked_by_dependency' } }],
    canonicalProgress: { status: 'open', done: 0, total: 5 } });
  assert.ok(result.items.length >= 2);
  assert.ok(result.items.every(item => item.displayStatus.includes('not yet settled')));
  assert.ok(result.items.some(item => item.validation.controller === 'failed'));
  assert.ok(result.items.some(item => item.validation.controller === 'blocked'));
})();

(function goalStoreAllGoalsAndUiShape() {
  const email = { id: 'goal-email', text: 'Email goal', status: 'active', milestones: [{ id: 'goal-email:m1', status: 'done' }, { id: 'goal-email:m2', status: 'open' }] };
  const youtube = { id: 'goal-youtube', text: 'YouTube goal', status: 'active', milestones: [{ id: 'goal-youtube:m1', status: 'open' }, { id: 'goal-youtube:m4', status: 'open' }] };
  const rows = [
    { runId: 'email-run-1', goalId: email.id, milestoneId: 'goal-email:m2', title: 'Email QA', validation: { result: 'pass' }, artifacts: ['email.md'] },
    { runId: 'email-run-1', goalId: email.id, milestoneId: 'goal-email:m2', title: 'duplicate', validation: { result: 'pass' } },
    { runId: 'yt-001', goalId: youtube.id, milestoneId: 'goal-youtube:m1', title: 'yt-001', validation: { result: 'fail' } },
    { runId: 'yt-004', goalId: youtube.id, milestoneId: 'goal-youtube:m4', title: 'yt-004', validation: { result: 'blocked' } }
  ];
  assert.strictEqual(Goals.projectRelatedWork(email, rows).length, 1);
  assert.strictEqual(Goals.projectRelatedWork(youtube, rows).length, 2);
  assert.ok(Goals.projectRelatedWork(youtube, rows).every(card => card.completion === false && card.readOnly === true));
  assert.strictEqual(email.milestones.filter(m => m.status === 'done').length, 1);
  assert.strictEqual(youtube.milestones.filter(m => m.status === 'done').length, 0);
})();

console.log('phase-a-goal-cases.test.js: PASS');
