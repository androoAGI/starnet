/* node test/skills.learning.e2e.test.js — SKILL LEARNING FIRES (2026-09-28), proven at the live seams.

   Boots the REAL sidecar (hermetic SidecarFixture) against a scripted MOCK OpenRouter that can make the main
   run call tools for N turns, and asserts on what reaches the provider and what the store persists:
     1. FIRST-SKILL LINE — an agent with zero saved skills is told, in the system prompt the provider receives,
        that it has none and to save a non-trivial procedure with skill.manage.
     2. THE NUDGE — turns with skill tools on the wire CARRY across runs and across a sidecar RESTART
        (skill.nudge.json); below the bar no review fork fires; the run that crosses it fires the skill-review
        fork on the RESERVED lane, taking one slot of the aux budget (2) ahead of the higher beats; the count then
        starts over.
     3. USE = LOADED — a skill that is only LISTED in the index gains no use; a run that loads it with skill.view
        gains exactly one; the count survives a restart.
   Zero real network, zero spend (fake key, mocked upstream). */
'use strict';
const A = require('./_assert.js');
const { hostText } = require('./helpers/host-notes.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { makeSkillStore } = require('../sidecar/skillstore.js');
const { digestOf } = require('../sidecar/skills/gate.js');
const skillGuard = require('../sidecar/skills/guard.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REVIEW_MARK = 'skillbase maintenance worker';
// long enough to clear the reflection/study/thread-mine salience floors, so the higher beats really do
// compete for the two budget slots on every run-end (the non-vacuous part of the reserved-lane proof)
const LONG_REPLY = ('I rebuilt the staging rollback path end to end and wrote down each step, the reasoning, the tradeoffs '
  + 'and the follow-ups worth remembering for the next deploy. ').repeat(40);

/* the scripted mock: `plan` (set per run) says how many tool turns the MAIN run takes and which tool it calls;
   every other call (aux passes, titling) gets a terse text reply. Records every request. */
function startMock() {
  const state = { requests: [], plan: { toolTurns: 0, tool: 'skill_list', args: {} } };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); res.end(); return; }
      let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch (_) {}
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        // every system-role message: the run's own skill index is ranked by THIS message, so since lean-prompt (2026-10-12)
        // it rides the per-run <run_context> system note placed with the newest user turn, not the cached system prompt
        const sys = hostText(msgs);   // + the notes that ride user-side on a non-Claude wire
        // the MAIN run carries [RUNTIME] - since lean-prompt (2026-10-12) in its <run_context> system note
        const isMain = sys.indexOf('[RUNTIME]') >= 0;
        const tools = (Array.isArray(body.tools) ? body.tools : []).map(t => t && t.function && t.function.name);
        state.requests.push({ sys, isMain, tools });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const toolResults = msgs.filter(m => m && m.role === 'tool').length;
        if (isMain && toolResults < state.plan.toolTurns) {
          const call = { index: 0, id: 'call_' + state.requests.length, type: 'function', function: { name: state.plan.tool, arguments: JSON.stringify(state.plan.args || {}) } };
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } }) + '\n\n');
        } else {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: isMain ? LONG_REPLY : 'ok, done.' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } }) + '\n\n');
        }
        res.write('data: [DONE]\n\n'); res.end();
      });
    });
    server.listen(0, HOST, () => resolve({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

// wait for the fire-and-forget aux passes to land: the request count must hold still for `stableMs`
async function settle(state, stableMs, maxMs) {
  const until = Date.now() + (maxMs || 12000);
  let last = -1, since = Date.now();
  while (Date.now() < until) {
    if (state.requests.length !== last) { last = state.requests.length; since = Date.now(); }
    else if (Date.now() - since >= (stableMs || 1500)) break;
    await sleep(150);
  }
}

async function run(fixture, mock, agentId, text, plan) {
  mock.state.plan = Object.assign({ toolTurns: 0, tool: 'skill_list', args: {} }, plan || {});
  const start = mock.state.requests.length;
  const r = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'sk-or-v1-learning-fake', model: 'test/model', agentId, isTask: true, placed: ['notebook', 'computer'], messages: [{ role: 'user', content: text }] })
  });
  A.eq(r.status, 200, 'POST /api/run streams (200) for ' + agentId);
  const rd = r.body.getReader(); while (true) { const { done } = await rd.read(); if (done) break; }
  await settle(mock.state);
  const win = mock.state.requests.slice(start);
  const mains = win.filter(q => q.isMain);
  return { mains, system: (mains[0] && mains[0].sys) || '', reviews: win.filter(q => q.sys.indexOf(REVIEW_MARK) >= 0), win };
}

function nudgeCount(fixture, agentId) {
  try { return JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'skill.nudge.json'), 'utf8')).counts[agentId]; }
  catch (_) { return undefined; }
}

// the boot/run log gained no error from this lane's new writes (a fail-open note is a console.warn '[failopen] <tag>')
function cleanLog(fixture, label) {
  const bad = (fixture.output().match(/\[failopen\] (skill\.nudge|skill\.markUsed)[^\n]*|\[skill-nudge\][^\n]*/g) || []);
  A.eq(bad, [], 'clean sidecar log (' + label + '): no skill-nudge / markUsed failure lines');
}

async function skillRow(fixture, agentId, name) {
  const r = await fixture.json('GET', '/api/agent-skills?agent=' + agentId);
  A.eq(r.status, 200, 'GET /api/agent-skills answers for ' + agentId);
  return ((r.body && r.body.skills) || []).filter(s => s.name === name)[0] || null;
}

(async () => {
  const mock = await startMock();
  const fixture = SidecarFixture.create({
    prefix: 'sk-learning-',
    env: { SKYNET_OPENROUTER_BASE: mock.base, SKYNET_AUX_BUDGET: '2', SKYNET_SKILL_REVIEW_EVERY: '5', SKYNET_QUEST_REFRESH: '0', STARNET_DEBUG_CHANNELS: '1' },
    timeoutMs: 20000
  });
  // seed ONE clean saved skill for the "use = loaded" agent, through the REAL store (guard + digest stamps)
  {
    const lines = [];
    const store = makeSkillStore({
      // Fixture only: represent previously active authored versions; production model writes still stage.
      stageReviews: false, io: { readAll() { return []; }, append(e) { lines.push(JSON.stringify(e)); } }, clock: { now: () => Date.now() }, guard: skillGuard, digest: digestOf });
    store.write({ agentId: 'user-three', name: 'Deploy Site', summary: 'build test and ship the site', body: '1. npm ci\n2. npm test\n3. npm run deploy', createdBy: 'agent' });
    fs.writeFileSync(path.join(fixture.workspace, 'skills.jsonl'), lines.join('\n') + '\n', 'utf8');
  }
  await fixture.start();
  try {
    // ---- 1 + 2a. a zero-skill agent: the first-skill line reaches the provider; 3 turns do not reach the bar ----
    let r = await run(fixture, mock, 'learner', 'Rebuild the staging rollback path and write up the steps', { toolTurns: 2 });
    A.ok(r.mains.length === 3, 'the main run took 3 model turns (2 tool turns + the answer), got ' + r.mains.length);
    A.ok(r.mains[0].tools.indexOf('skill_manage') >= 0, 'skill.manage was on the wire (the notebook grants it)');
    A.ok(r.system.indexOf('You have no saved skills yet') >= 0, 'FIRST-SKILL LINE: a zero-skill agent is told it has no saved skills');
    A.ok(r.system.indexOf('skill.manage (action create)') >= 0, 'and to save a non-trivial procedure with skill.manage');
    A.eq(r.reviews.length, 0, 'below the bar (3 < 5): no skill-review fork fired');
    A.eq(nudgeCount(fixture, 'learner'), 3, 'the nudge count (3) is written to skill.nudge.json');

    // ---- 2b. the count survives a restart ----
    cleanLog(fixture, 'first boot');
    await fixture.restart();
    A.eq(nudgeCount(fixture, 'learner'), 3, 'the nudge count is still 3 after a sidecar restart');

    // ---- 2c. the run that crosses the bar fires the review on the RESERVED lane ----
    const logStart = fixture.output().length;
    r = await run(fixture, mock, 'learner', 'Rebuild the production rollback path the same way and write up the steps', { toolTurns: 2 });
    A.eq(r.mains.length, 3, 'the second run also took 3 turns (3 + 3 = 6 >= 5)');
    A.ok(r.reviews.length >= 1, 'THE NUDGE: the run that crossed the bar fired the skill-review fork');
    A.ok(r.reviews.every(q => q.tools.length > 0), 'the review really was a tool loop (skill tools on the wire)');
    const govLine = (fixture.output().slice(logStart).match(/\[aux-governor\][^\n]*agent=learner[^\n]*/) || [''])[0];
    A.ok(/RESERVED\[skill-review\]/.test(govLine), 'the governor line reports skill-review on the RESERVED lane: ' + govLine);
    const spent = ((govLine.match(/spent=\d+\[([^\]]*)\]/) || ['', ''])[1] || '').split(',').filter(Boolean);
    A.ok(spent.length === 2 && spent.includes('skill-review'), 'the review counts: two passes spent on a budget of two (' + spent.join(',') + ')');
    A.ok(/DEFERRED\[[^\]]+\]/.test(govLine), 'NON-VACUOUS: higher beats wanted those slots and one yielded to the review: ' + govLine);
    A.eq(nudgeCount(fixture, 'learner'), 0, 'the count starts over once its review fires');

    // ---- 2d. a team.spawn clone ('sub-' id, never on the roster) keeps no count and buys no review ----
    r = await run(fixture, mock, 'sub-probe01', 'Rebuild the staging rollback path and write up the steps', { toolTurns: 6 });
    A.ok(r.mains.length >= 6, 'the throwaway agent really worked past the bar of 5 turns, got ' + r.mains.length);
    A.eq(r.reviews.length, 0, 'a throwaway sub- agent never fires a skill review');
    A.eq(nudgeCount(fixture, 'sub-probe01'), undefined, 'and leaves no key in skill.nudge.json');

    // ---- 3. use = loaded, not listed ----
    const before = await skillRow(fixture, 'user-three', 'Deploy Site');
    A.ok(before && before.useCount === 0, 'seed precondition: the saved skill starts at useCount 0');
    r = await run(fixture, mock, 'user-three', 'what is on the schedule today', { toolTurns: 0 });
    A.ok(r.system.indexOf('Deploy Site') >= 0, 'the saved skill was LISTED in the index this run');
    A.ok(r.system.indexOf('You have no saved skills yet') < 0, 'an agent WITH skills does not get the first-skill line');
    let row = await skillRow(fixture, 'user-three', 'Deploy Site');
    A.eq(row && row.useCount, 0, 'USE = LOADED: being listed in the index is not a use (was +1 on every run)');
    r = await run(fixture, mock, 'user-three', 'ship the site', { toolTurns: 1, tool: 'skill_view', args: { name: 'Deploy Site' } });
    row = await skillRow(fixture, 'user-three', 'Deploy Site');
    A.eq(row && row.useCount, 1, 'a run that LOADED the skill with skill.view counts exactly one use');
    A.eq(row && row.viewCount, 1, 'and one view');
    cleanLog(fixture, 'second boot');
    await fixture.restart();
    row = await skillRow(fixture, 'user-three', 'Deploy Site');
    A.eq(row && row.useCount, 1, 'the use survives a sidecar restart (markUsed persisted it)');
    cleanLog(fixture, 'third boot');
  } finally {
    await fixture.dispose();
    try { mock.server.close(); } catch (_) {}
  }
  A.report('skills.learning.e2e.test');
})().catch(e => { console.log('FAIL: skills.learning.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
