'use strict';
// Durable, bounded continuation ownership. No renderer or browser timers are
// required. A process restart pauses every unfinished goal for explicit review.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { swallow } = require('./failopen');
const GoalLoop = require('../frontend/app/goalloop');
function makeRemoteGoals({ root, run, now }) {
  const dir = path.join(root, '.remote-goals');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const records = new Map(), active = new Map();
  const valid = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
  function persist(record) {
    const target = path.join(dir, record.streamId + '.json'), tmp = target + '.' + crypto.randomUUID() + '.tmp';
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);
    const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  }
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!valid(record.streamId) || file !== record.streamId + '.json' || !valid(record.agentId) || record.agentId.length > 40 || !GoalLoop.normalize(record.goal)) throw new Error('Remote goal storage requires recovery');
    record.goal = GoalLoop.normalize(record.goal);
    if (GoalLoop.isActive(record.goal)) { GoalLoop.pause(record.goal, 'Server restarted. Review the last run before resuming.'); persist(record); }
    records.set(record.streamId, record);
  }
  const view = record => record ? JSON.parse(JSON.stringify({ ...record, running: active.has(record.streamId) })) : null;
  function launch(record) {
    const controller = new AbortController();
    active.set(record.streamId, { controller, promise: null });
    const promise = (async () => {
      try {
        while (GoalLoop.isActive(record.goal) && !controller.signal.aborted) {
          if (record.goal.turnsUsed >= record.goal.maxTurns) { GoalLoop.pause(record.goal, 'Turn budget exhausted'); break; }
          // Persist admission before every paid turn. A crash can never silently
          // resume an uncertain operation; restart always requires user review.
          record.lastStartedAt = now(); persist(record);
          const result = await run({ record: view(record), prompt: GoalLoop.continuationPrompt(record.goal), signal: controller.signal, judge: false });
          record.lastRunId = result.runId || record.lastRunId || null;
          if (!GoalLoop.isActive(record.goal) || controller.signal.aborted) break;
          if (result.reason !== 'done' || !result.text?.trim() || result.clarifying) {
            GoalLoop.pause(record.goal, result.clarifying ? 'Your answer is needed' : 'The last run stopped without completion; review it before resuming'); break;
          }
          let raw = '';
          try {
            const judged = await run({ record: view(record), prompt: GoalLoop.judgeUser(record.goal, result.text, { now: new Date(now()).toISOString() }), system: GoalLoop.judgeSystem(), signal: controller.signal, judge: true });
            if (judged.reason !== 'done') { GoalLoop.pause(record.goal, 'The judge stopped without completion; review before resuming'); break; }
            if (judged.reason === 'done') raw = judged.text || '';
          } catch (error) { if (controller.signal.aborted) throw error; }
          if (!GoalLoop.isActive(record.goal) || controller.signal.aborted) break;
          GoalLoop.evaluate(record.goal, GoalLoop.parseVerdict(raw), { now: now() });
          persist(record);
        }
      } catch (_) {
        GoalLoop.pause(record.goal, controller.signal.aborted ? 'You stopped the goal' : 'The run could not be completed. Review its transcript before resuming.');
      } finally {
        if (controller.signal.aborted) GoalLoop.pause(record.goal, 'You stopped the goal');
        try { persist(record); } finally { active.delete(record.streamId); }
      }
    })();
    // Keep failures observable in status, never an unhandled rejection that kills
    // unrelated work. A disk failure cannot start another continuation.
    promise.catch(swallow('remote.goal.persist'));
    const owner = active.get(record.streamId); if (owner) owner.promise = promise;
  }
  function command({ streamId, agentId, kind = 'goal', text = '' }) {
    if (!valid(streamId) || !valid(agentId) || agentId.length > 40) throw new Error('Invalid session or agent');
    const value = String(text).trim(), action = value.toLowerCase();
    let record = records.get(streamId);
    if (record && record.agentId !== agentId) throw new Error('The session belongs to another agent');
    if (!value || action === 'status') return view(record);
    if (kind === 'subgoal') {
      if (!record || !GoalLoop.hasGoal(record.goal)) throw new Error('Set a goal first');
      if (active.has(streamId)) throw new Error('Pause the goal before changing its criteria');
      if (action === 'clear') record.goal.subgoals = [];
      else if (/^remove\s+\d+$/.test(action)) record.goal.subgoals.splice(Number(action.split(/\s+/)[1]) - 1, 1);
      else if (!GoalLoop.addSubgoal(record.goal, value)) throw new Error('Could not add criterion');
      persist(record); return view(record);
    }
    if (action === 'pause' || action === 'clear') {
      if (!record) throw new Error('No goal to ' + action);
      if (action === 'clear') GoalLoop.clear(record.goal); else GoalLoop.pause(record.goal, 'You paused it');
      active.get(streamId)?.controller.abort(); persist(record); return view(record);
    }
    if (active.has(streamId)) throw new Error('A goal already owns this session; pause it before replacing it');
    if (action === 'resume') {
      if (!record || record.goal.status !== 'paused') throw new Error('No paused goal to resume');
      GoalLoop.resume(record.goal);
    } else {
      const goal = GoalLoop.create(value, { now: now() });
      if (!goal) throw new Error('Enter a goal');
      record = { streamId, agentId, goal }; records.set(streamId, record);
    }
    persist(record); launch(record); return view(record);
  }
  return {
    command, list: () => Array.from(records.values()).map(view),
    owns: id => active.has(id),
    async stop(id) {
      const record = records.get(id), owner = active.get(id);
      if (record && owner) { GoalLoop.pause(record.goal, 'You stopped the goal'); owner.controller.abort(); persist(record); await owner.promise; }
    },
    async close() { await Promise.all(Array.from(active.keys()).map(id => this.stop(id))); }
  };
}
module.exports = { makeRemoteGoals };
