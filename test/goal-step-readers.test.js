/* node test/goal-step-readers.test.js — EVERY history reader shows a goal-loop step as the station's line (org P29-sys wiring,
   2026-10-14).

   A /goal continuation rides ws.history as a user-role turn (that wire text is the model's input and stays unchanged), but the
   Commander never typed it. COMMS already renders it as one station line; this locks the OTHER readers of the same history onto
   the same shared predicate (GoalLoop.stepOfTurn), so none of them shows the internal prompt as the Commander's words:
     1. the rail row's excerpt   — '↻ Goal step: <goal>', never 'You: [Continuing toward…'
     2. export                   — the Markdown names it '## Station', never '## Commander'; JSON keeps the record + names the step
     3. the HUD's run task       — the goal, not the marker prompt
     4. the desk screen's task   — the goal, not the marker prompt
   (station.read_session is locked in station-commands.test.js; COMMS replay + /history in comms-system-register.test.js.) */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const GoalLoop = require('../frontend/app/goalloop.js');
global.GoalLoop = GoalLoop;   // the page global every reader probes by bare identifier

const STEP = GoalLoop.continuationPrompt(GoalLoop.create('ship the landing page', { now: 1 }));
const LEGACY = '[Continuing toward your standing goal]\nGoal: fix the build\n\nContinue working toward this goal. Take the next concrete step.';

/* ---------- 0. the shared predicate ---------- */
A.eq(GoalLoop.stepOfTurn({ role: 'user', content: STEP }), 'ship the landing page', 'a stored goal step names its goal');
A.eq(GoalLoop.stepOfTurn({ role: 'user', content: LEGACY }), 'fix the build', 'a pre-org-pass step too');
A.eq(GoalLoop.stepOfTurn({ role: 'user', content: STEP, from: 'nova' }), null, 'a delegated brief keeps its own speaker');
A.eq(GoalLoop.stepOfTurn({ role: 'assistant', content: STEP }), null, 'only a user-role turn can be a step');
A.eq(GoalLoop.stepOfTurn({ role: 'user', content: 'ship the landing page' }), null, 'the Commander\'s own words are not a step');
A.eq(GoalLoop.stepOfTurn(null), null, 'nothing is not a step');

/* ---------- 1. the rail excerpt ---------- */
{
  const app = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
  const src = A.fnBody(app, 'function railExcerpt(');
  A.ok(src.length > 100, 'railExcerpt sliced');
  const railExcerpt = new Function('GoalLoop', src + '\nreturn railExcerpt;')(GoalLoop);
  A.eq(railExcerpt({ role: 'user', content: STEP }), '↻ Goal step: ship the landing page', 'a goal step reads as the station\'s line, no "You:"');
  A.eq(railExcerpt({ role: 'user', content: LEGACY }), '↻ Goal step: fix the build', '…an old saved one too');
  A.ok(railExcerpt({ role: 'user', content: GoalLoop.continuationPrompt(GoalLoop.create('x'.repeat(400), { now: 1 })) }).length <= 160, 'a long goal clamps to the row');
  A.eq(railExcerpt({ role: 'user', content: 'check the build. then deploy' }), 'You: check the build.', 'the Commander\'s own turn still reads "You:"');
  A.eq(railExcerpt({ role: 'assistant', content: 'Green.' }), 'Green.', 'the agent\'s reply is unchanged');
}

/* ---------- 2. export ---------- */
{
  const W = require('../frontend/app/workstreams.js');
  W.reset();
  const w = W.create('Launch');
  w.history.push(
    { role: 'user', content: 'set up the launch' },
    { role: 'user', content: STEP },
    { role: 'assistant', content: 'Drafted the hero.' }
  );
  const md = W.exportConversation(w.id, 'markdown', { exportedAt: 1 }).text;
  A.ok(/## Commander\n\nset up the launch\n/.test(md), 'the Commander\'s own turn exports under Commander');
  A.ok(/## Station\n\nGoal step: ship the landing page\n/.test(md), 'a goal step exports as the station\'s line');
  A.ok(md.indexOf('[Continuing toward') < 0, '…never the internal prompt as the Commander\'s words');
  const json = W.exportConversation(w.id, 'json', { exportedAt: 1 });
  A.eq(json.doc.messages[1].goalStep, 'ship the landing page', 'JSON names the step');
  A.eq(json.doc.messages[1].content, STEP, '…and keeps the record (what the model received)');
  A.eq(json.doc.messages[0].goalStep, undefined, 'a real turn carries no step name');
  A.eq(JSON.parse(json.text).messages.length, 3, 'the JSON still carries every turn');
}

/* ---------- 3. the HUD's run task ---------- */
{
  const H = require('../frontend/app/hudmode.js');
  const streams = [{ id: 's1', title: 'Launch', runIds: ['r1'], history: [{ role: 'user', content: 'set up the launch' }, { role: 'user', content: STEP }] }];
  A.eq(H.taskOfRun('r1', streams, '').task, 'ship the landing page', 'a goal step run\'s task is its goal');
  const legacy = [{ id: 's2', title: 'Fix', runIds: ['r2'], history: [{ role: 'user', content: LEGACY }] }];
  A.eq(H.taskOfRun('r2', legacy, '').task, 'fix the build', '…an old saved step too');
  const plain = [{ id: 's3', title: 'Plain', runIds: ['r3'], history: [{ role: 'user', content: 'check the build' }] }];
  A.eq(H.taskOfRun('r3', plain, '').task, 'check the build', 'a Commander turn is still the task');
}

/* ---------- 4. the desk screen's task ---------- */
{
  const W = require('../frontend/app/workstreams.js');
  W.reset();
  const w = W.create('Launch');
  w.history.push({ role: 'user', content: STEP });
  global.Workstreams = W;
  global.Channels = { runIdOf: id => (id === w.id ? 'rd1' : null) };
  const D = require('../frontend/app/deskscreen.js');
  const t = D._taskOf({ runId: 'rd1', trigger: 'directive', task: '' });
  A.eq(t, { text: 'ship the landing page', known: true }, 'the desk screen names the goal as the task');
  delete global.Workstreams; delete global.Channels;
}

A.report('goal-step-readers.test');
