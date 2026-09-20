'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeRemoteGoals } = require('../sidecar/remote-goals');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function settled(driver) {
  for (let i = 0; i < 300; i++) { if (!driver.list().some(g => g.running)) return; await sleep(5); }
  throw new Error('goal did not settle');
}
test('server goal completes multiple turns without a viewer and retains its verdict across restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-goal-'));
  let turns = 0, judges = 0;
  const run = async ({ judge }) => judge
    ? { reason: 'done', text: JSON.stringify({ verdict: ++judges === 2 ? 'done' : 'continue', reason: 'mock verification' }) }
    : { runId: 'run-' + ++turns, text: 'Produced step ' + turns, reason: 'done' };
  const driver = makeRemoteGoals({ root, now: () => 1000, run });
  try {
    assert.deepEqual(driver.list(), []);
    driver.command({ streamId: 'session', agentId: 'agent', text: 'Build two steps' });
    assert.throws(() => driver.command({ streamId: 'session', agentId: 'agent', text: 'Replace' }), /already owns/);
    await settled(driver);
    assert.equal(turns, 2); assert.equal(driver.list()[0].goal.status, 'done');
    const reloaded = makeRemoteGoals({ root, now: () => 1000, run });
    assert.equal(reloaded.list()[0].goal.turnsUsed, 2); assert.equal(turns, 2);
  } finally { await driver.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('pause cancels the active operation; restart never resumes uncertain work; corrupted storage is refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-goal-stop-'));
  let aborted = false;
  const driver = makeRemoteGoals({ root, now: () => 1000, run: async ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => { aborted = true; resolve({ reason: 'stopped', text: '' }); }, { once: true });
  }) });
  try {
    driver.command({ streamId: 'session', agentId: 'agent', text: 'Wait' });
    let calls = 0;
    const reloaded = makeRemoteGoals({ root, now: () => 1000, run: async () => { calls++; } });
    assert.equal(reloaded.list()[0].goal.status, 'paused'); assert.equal(calls, 0);
    await driver.stop('session'); assert.equal(aborted, true); assert.equal(driver.list()[0].goal.status, 'paused');
    fs.writeFileSync(path.join(root, '.remote-goals/session.json'), '{bad');
    assert.throws(() => makeRemoteGoals({ root, now: () => 1000, run: async () => {} }));
  } finally { await driver.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('failed verdicts stop at the inherited parse budget; user criteria remain bounded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-goal-budget-'));
  let turns = 0;
  const driver = makeRemoteGoals({ root, now: () => 1000, run: async ({ judge }) => ({ reason: 'done', text: judge ? 'malformed' : 'step ' + ++turns }) });
  try {
    driver.command({ streamId: 'session', agentId: 'agent', text: 'Work' }); await settled(driver);
    assert.equal(turns, 3); assert.equal(driver.list()[0].goal.status, 'paused');
    driver.command({ streamId: 'session', agentId: 'agent', kind: 'subgoal', text: 'Include proof' });
    assert.deepEqual(driver.list()[0].goal.subgoals, ['Include proof']);
    assert.throws(() => driver.command({ streamId: '../bad', agentId: 'agent', text: 'x' }), /Invalid/);
  } finally { await driver.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('stopping the judge cannot queue another paid work turn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-goal-judge-stop-'));
  let turns = 0;
  const driver = makeRemoteGoals({ root, now: () => 1000, run: async ({ judge }) => judge ? { reason: 'stopped', text: '' } : { reason: 'done', text: 'step ' + ++turns } });
  try {
    driver.command({ streamId: 'session', agentId: 'agent', text: 'Work' }); await settled(driver);
    assert.equal(turns, 1); assert.equal(driver.list()[0].goal.status, 'paused');
  } finally { await driver.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
