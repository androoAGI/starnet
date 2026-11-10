/* node test/skillreview-useful.e2e.test.js — W3.2 THE SKILL REVIEW RUNS ONLY WHEN A RUN GIVES IT SOMETHING TO LEARN FROM
   (cost lane, Andrew's call 2026-11-08: "review only when useful").

   THE COST THIS CLOSES. The background skill review is a tool loop: about 29-33k input-eq a pass on Andrew's claude-cli
   station, 10 points of all his input-eq since v0.15.0 and 79% of the post-run passes. It fired whenever an agent's skill
   nudge reached its bar (skillreview.js NUDGE_EVERY = 10 model turns with skill tools on the wire since the skillbase last
   changed, the 2026-09-28 cadence), and the count clamps at the bar, so once due it fired after nearly every run of 10 or
   more turns, whatever the run held: 1 proposal came out of 3 reviews. Against the REAL sidecar and a mock OpenRouter that
   records every model call, each case is one fresh agent's 12-turn run (11 tool turns and the answer, so the count crosses
   the default bar of 10 inside the run):
     I1 a CLEAN run (it loaded its saved skill, every call succeeded, no correction cue) fires 0 reviews (base: 1), and its
        due count is kept, not spent;
     I2 a run with a TOOL ERROR fires exactly 1;
     I3 a run whose Commander's own words carry a CORRECTION cue (W1.4's cue resolver) fires exactly 1;
     I4 a NEW MULTI-STEP PROCEDURE (several successful calls across two tools, no saved skill loaded) fires exactly 1, and
        the skill it proposes waits for the Commander's approval: a pending candidate, never an active skill;
     I5 a thumbs-down VERDICT on a clean run fires exactly 1 review, the verdict's own, with the verdict in its prompt
        (base: 2, the nudge's review first, blind to the verdict);
     I6 a thumbs-UP on a clean run fires exactly 1 review: the run end holds it, the thumbs-up releases it onto the run it
        praised, with the run end's own prompt (no verdict block), and spends the held count (base: the run end's 1, the
        thumbs-up 0; a verdict always qualifies, and praise rides the cadence floor);
     I7 THE FLOOR: a fresh agent's short runs, under the bar, that each hold a tool error AND a correction cue fire 0
        reviews, and the count grows by their turns; a thumbs-up under the bar fires 0 too (every review but an ok or miss
        rating's needs a due count, the 2026-09-28 cadence as a floor: this case fails the moment the gate stops needing one);
     I8 the clean run's kept count survives a sidecar restart (skill.nudge.json), and the same agent's next run, a short
        one (under the bar on its own) with a tool error, reviews (base: 0, the clean run had spent the count);
     I9 a clean CHAT run (a streamId, so a Task Brief opens) whose first write came before brief_proceed, so the brief held
        it (the host's NOT RUN, NOT FAILED stamp) before it ran once the brief settled, fires 0 reviews and the run end says
        "review held", not "qualifies (tool-error)" (base: 1; the lane before review r2: 1). A held or refused call is not
        a tool error (skillreview.js heldOrRefused); test/skillreview-cause.test.js pins every such stamp.
   Zero network, zero real key (the fake key routes to the mock). Prints the measured counts on one line. */
'use strict';

const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { makeSkillStore } = require('../sidecar/skillstore.js');
const { digestOf } = require('../sidecar/skills/gate.js');
const skillGuard = require('../sidecar/skills/guard.js');
const { TaskIntent } = require('../frontend/app/fork.js');

const HOST = '127.0.0.1';
const MODEL = 'test/model';
const KEY = 'sk-or-v1-review-useful-fake';
const REVIEW_MARK = 'skillbase maintenance worker';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && (p.text || '')) || '').join('') : '';

const SKILL = 'Deploy Site';
const PROPOSED = 'Station Survey';
const ok2 = n => Array.from({ length: n }, (_, i) => i % 2 ? ['fs_list', {}] : ['station_inspect', {}]);
const VIEW = ['skill_view', { name: SKILL }];
const MISS = ['fs_read', { path: 'missing-notes.txt' }];   // no such file: the tool answers with an error
const WRITE = ['fs_write', { path: 'survey-note.txt', content: 'station and workspace agree\n' }];
const BRIEF = ['brief_proceed', { objective: 'survey the station and its workspace and save a short note', deliverable: 'the note file', assumptions: ['save it in the workspace root'] }];
/* the MAIN run's tool calls, by the case marker in the Commander's message. 11 calls + the answer = 12 model turns. */
const PLANS = {
  clean: [VIEW].concat(ok2(10)),
  error: [VIEW].concat(ok2(4), [MISS], ok2(5)),
  cue: [VIEW].concat(ok2(10)),
  fresh: ok2(11),
  verdict: [VIEW].concat(ok2(10)),
  praise: [VIEW].concat(ok2(10)),
  floor: [MISS].concat(ok2(2)),   // 3 tool turns and the answer: a tool error, well under the bar
  short: [MISS],
  // I9: a chat run (streamId, so a Task Brief opens): the first write comes before brief_proceed, so the brief HOLDS it (not
  // run), then the brief settles and the same write runs; every call that ran succeeded
  brief: [VIEW, WRITE, BRIEF, WRITE].concat(ok2(7))
};

function sse(res, deltas, finishReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const delta of deltas) res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}
const toolCall = (id, name, args) => [{ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args || {}) } }] }];

/* mock OpenRouter. MAIN calls (the only ones carrying [RUNTIME]) follow their case's plan. A REVIEW call (the skillbase
   maintenance worker) answers "no change", except the first turn of a review over the FRESH case, which proposes a skill.
   Every other call (reflection, study, thread mining) answers NONE. Every call is recorded. */
function startMock() {
  const state = { calls: [] };
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); res.end(); return; }
      let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch (_) { body = {}; }
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const sys = messages.filter(m => m && m.role === 'system').map(m => textOf(m.content)).join('\n');
        const toolTurns = messages.filter(m => m && m.role === 'tool').length;
        const main = raw.indexOf('[RUNTIME]') >= 0;
        const review = !main && sys.indexOf(REVIEW_MARK) >= 0;
        const rec = { at: Date.now(), main, review, first: toolTurns === 0, prompt: review ? messages.map(m => textOf(m && m.content)).join('\n') : '' };
        state.calls.push(rec);
        if (review) {
          if (rec.first && rec.prompt.indexOf('[RW fresh]') >= 0) {
            return sse(res, toolCall('propose_' + state.calls.length, 'skill_manage', { action: 'create', name: PROPOSED,
              summary: 'survey the station and its workspace before changing anything',
              body: '1. station.inspect for the live harness state\n2. fs.list the workspace\n3. repeat until both agree, then report' }), 'tool_calls');
          }
          return sse(res, [{ content: 'No change: nothing in this run needs a skill update.' }]);
        }
        if (!main) return sse(res, [{ content: 'NONE' }]);
        const said = messages.filter(m => m && m.role === 'user').map(m => textOf(m.content)).reverse().find(t => /\[RW \w+\]/.test(t)) || '';
        const plan = PLANS[(said.match(/\[RW (\w+)\]/) || [])[1]] || [];
        if (toolTurns < plan.length) return sse(res, toolCall('c' + state.calls.length, plan[toolTurns][0], plan[toolTurns][1]), 'tool_calls');
        sse(res, [{ content: 'Done. I surveyed the station and its workspace and everything is where it should be.' }]);
      });
    });
    server.listen(0, HOST, () => resolve({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

// the provider credentials and StarNet knobs of the shell that launched the test never reach the fixture
function hermeticEnv(mockBase) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k) && k !== 'STARNET_CLAUDE_BIN') env[k] = '';
  }
  // the DEFAULT skill nudge (no SKILL_REVIEW_EVERY): the bar of 10 is the cadence under test. The verdict review fires as
  // soon as it is armed (no grace window). Scout, quest refresh and the curator stay out of the count.
  return Object.assign(env, { SKYNET_OPENROUTER_BASE: mockBase, SKYNET_FULL_ACCESS: '1', SKYNET_QUEST_REFRESH: '0', SKYNET_SCOUT: '0',
    SKYNET_SKILL_CURATOR: '0', SKYNET_VERDICT_REVIEW_GRACE_MS: '0',
    STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CLOUD_URL: '', SKYNET_CLOUD_URL: '' });
}

// one saved, active skill per agent that "follows" it, written through the REAL store (guard + digest stamps)
function seedSkills(workspace, agents) {
  const lines = [];
  const store = makeSkillStore({
    // Fixture only: previously active authored versions; production model writes still stage.
    stageReviews: false, io: { readAll() { return []; }, append(e) { lines.push(JSON.stringify(e)); } }, clock: { now: () => Date.now() }, guard: skillGuard, digest: digestOf });
  for (const agentId of agents) store.write({ agentId, name: SKILL, summary: 'survey the station, then the workspace', body: '1. station.inspect\n2. fs.list\n3. repeat until both agree', createdBy: 'agent' });
  fs.writeFileSync(path.join(workspace, 'skills.jsonl'), lines.join('\n') + '\n', 'utf8');
}

// wait until the fire-and-forget passes that follow have landed (no new model call for stableMs)
async function settle(state, stableMs, maxMs) {
  const until = Date.now() + (maxMs || 15000);
  let last = -1, stableSince = Date.now();
  while (Date.now() < until) {
    if (state.calls.length !== last) { last = state.calls.length; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= (stableMs || 1500)) break;
    await sleep(150);
  }
}

// one review = one review LOOP: its first model call (no tool result in it yet)
const reviewsIn = calls => calls.filter(c => c.review && c.first);

async function drive(fixture, mock, agentId, kind, words, streamId) {
  const from = mock.state.calls.length;
  const r = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ key: KEY, model: MODEL, agentId, isTask: true, placed: ['notebook', 'computer'],
      messages: [{ role: 'user', content: '[RW ' + kind + '] ' + (words || 'Survey the station and its workspace and tell me what you find.') }] },
      streamId ? { streamId } : null))   // a chat's streamId opens the run's Task Brief
  });
  A.eq(r.status, 200, 'the real /api/run stream opened for ' + agentId);
  const events = (await r.text()).split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const end = events.filter(e => e.name === 'agent.run.end').pop();
  const p = (end && end.payload) || {};
  A.eq(p.reason, 'done', agentId + ': the run finished');
  await settle(mock.state);
  const win = mock.state.calls.slice(from);
  const results = events.filter(e => e.name === 'agent.tool_result').map(e => e.payload || {});
  return { runId: p.runId, turns: p.turns, mains: win.filter(c => c.main).length, reviews: reviewsIn(win), win, results };
}

function nudgeCount(fixture, agentId) {
  try { return JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'skill.nudge.json'), 'utf8')).counts[agentId]; }
  catch (_) { return undefined; }
}

(async () => {
  const mock = await startMock();
  const fixture = SidecarFixture.create({ prefix: 'sk-review-useful-', env: hermeticEnv(mock.base), timeoutMs: 30000 });
  seedSkills(fixture.workspace, ['rw-clean', 'rw-error', 'rw-cue', 'rw-verdict', 'rw-praise', 'rw-brief']);
  await fixture.start();
  const counts = {};
  try {
    // ---- I1 a clean 12-turn run: nothing to learn, no review; its due count is kept for a run that has something ----
    const clean = await drive(fixture, mock, 'rw-clean', 'clean');
    A.eq([clean.mains, clean.turns], [12, 12], 'fixture: the clean run took 12 model turns (11 tool turns and the answer)');
    counts.clean = clean.reviews.length;
    A.eq(counts.clean, 0, 'I1 a clean 12-turn run (its saved skill loaded, every call succeeded, no correction) fires no skill review');
    A.eq(nudgeCount(fixture, 'rw-clean'), 10, 'I1 its nudge count stays at the bar (10, due): the turn count alone spent nothing');

    // ---- I2 a tool error ----
    const error = await drive(fixture, mock, 'rw-error', 'error');
    A.eq(error.mains, 12, 'fixture: the error run took 12 model turns');
    counts.error = error.reviews.length;
    A.eq(counts.error, 1, 'I2 a run that hit a tool error fires exactly one skill review');

    // ---- I3 a correction cue in the Commander's own words ----
    const cue = await drive(fixture, mock, 'rw-cue', 'cue', 'Survey the station and its workspace. From now on, always list the steps before you run them.');
    A.eq(cue.mains, 12, 'fixture: the correction run took 12 model turns');
    counts.correction = cue.reviews.length;
    A.eq(counts.correction, 1, 'I3 a run whose Commander\'s words carry a correction cue fires exactly one skill review');

    // ---- I4 a new multi-step procedure: no saved skill loaded, several successful calls across two tools ----
    const fresh = await drive(fixture, mock, 'rw-fresh', 'fresh');
    A.eq(fresh.mains, 12, 'fixture: the new-procedure run took 12 model turns');
    counts.procedure = fresh.reviews.length;
    A.eq(counts.procedure, 1, 'I4 a run that worked out a new multi-step procedure fires exactly one skill review');
    const cands = await fixture.json('GET', '/api/agent-skills/candidates?agent=rw-fresh');
    const proposal = ((cands.body && cands.body.candidates) || []).find(c => c && c.name === PROPOSED);
    A.ok(!!proposal && proposal.status === 'pending', 'I4 the review\'s proposal waits for the Commander\'s approval (a pending candidate): ' + JSON.stringify(proposal && { name: proposal.name, status: proposal.status }));
    const listed = await fixture.json('GET', '/api/agent-skills?agent=rw-fresh');
    const active = ((listed.body && listed.body.skills) || []).filter(s => s && s.name === PROPOSED && !s.pendingCandidate);
    A.eq(active.length, 0, 'I4 and it is not an active skill until the Commander approves it');

    // ---- I5 a thumbs-down verdict on a clean run: exactly one review, the verdict's own ----
    const rated = await drive(fixture, mock, 'rw-verdict', 'verdict');
    A.eq(rated.mains, 12, 'fixture: the run to be rated took 12 model turns');
    const from = mock.state.calls.length;
    const verdict = await fixture.json('POST', '/api/growth/ratings', { runId: rated.runId, verdict: 'miss', epoch: 1 });
    A.ok(verdict.status === 200 && verdict.body && verdict.body.ok === true && verdict.body.skillReviewArmed === true, 'fixture: the thumbs-down was saved and armed its review: ' + JSON.stringify(verdict.body).slice(0, 300));
    await settle(mock.state);
    const verdictReviews = reviewsIn(mock.state.calls.slice(from));
    counts.verdict = rated.reviews.length + verdictReviews.length;
    A.eq(counts.verdict, 1, 'I5 a thumbs-down on a clean 12-turn run fires exactly one skill review (run end ' + rated.reviews.length + ', verdict ' + verdictReviews.length + ')');
    A.ok(verdictReviews.length === 1 && verdictReviews[0].prompt.indexOf('COMMANDER VERDICT ON THIS RUN') >= 0, 'I5 the one review is the verdict\'s, with the verdict in its prompt');

    // ---- I6 a thumbs-up on a clean run: the run end holds the review, the thumbs-up releases exactly one, the run's own ----
    const praised = await drive(fixture, mock, 'rw-praise', 'praise');
    A.eq(praised.mains, 12, 'fixture: the run to be praised took 12 model turns');
    A.eq(nudgeCount(fixture, 'rw-praise'), 10, 'fixture: its run end held the due count');
    const fromUp = mock.state.calls.length;
    const up = await fixture.json('POST', '/api/growth/ratings', { runId: praised.runId, verdict: 'great', epoch: 1 });
    A.ok(up.status === 200 && up.body && up.body.ok === true && up.body.skillReviewArmed === true, 'I6 the thumbs-up was saved and says it set a review in motion: ' + JSON.stringify(up.body).slice(0, 300));
    await settle(mock.state);
    const upReviews = reviewsIn(mock.state.calls.slice(fromUp));
    counts.praise = praised.reviews.length + upReviews.length;
    A.eq([praised.reviews.length, upReviews.length], [0, 1], 'I6 a thumbs-up on a clean 12-turn run fires exactly one skill review: none at the run end, one for the thumbs-up');
    A.ok(upReviews.length === 1 && upReviews[0].prompt.indexOf('[RW praise]') >= 0 && upReviews[0].prompt.indexOf('COMMANDER VERDICT') < 0,
      'I6 it reviews the run it praised, with the run end\'s own prompt (no verdict block)');
    A.eq(nudgeCount(fixture, 'rw-praise'), 0, 'I6 and it spends the held count');

    // ---- I7 THE FLOOR: under the bar, a tool error and a correction still fire nothing, and neither does a thumbs-up ----
    const floorWords = 'Survey the station and its workspace. From now on, always list the steps before you run them.';
    const floor1 = await drive(fixture, mock, 'rw-floor', 'floor', floorWords);
    const floor2 = await drive(fixture, mock, 'rw-floor', 'floor', floorWords);
    A.ok(floor1.turns > 0 && floor2.turns > 0 && floor1.turns + floor2.turns < 10, 'fixture: two short runs, under the bar of 10 together (' + floor1.turns + ' + ' + floor2.turns + ' turns)');
    counts.floor = floor1.reviews.length + floor2.reviews.length;
    A.eq(counts.floor, 0, 'I7 THE FLOOR: under the bar, runs that each hold a tool error and a correction cue fire no skill review');
    A.eq(nudgeCount(fixture, 'rw-floor'), floor1.turns + floor2.turns, 'I7 and the count grows by their turns (nothing spent it)');
    const fromFloorUp = mock.state.calls.length;
    const floorUp = await fixture.json('POST', '/api/growth/ratings', { runId: floor2.runId, verdict: 'great', epoch: 1 });
    A.ok(floorUp.status === 200 && floorUp.body && floorUp.body.ok === true && floorUp.body.skillReviewArmed === false, 'I7 a thumbs-up under the bar is saved and sets no review in motion: ' + JSON.stringify(floorUp.body).slice(0, 300));
    await settle(mock.state);
    counts.praiseUnderBar = reviewsIn(mock.state.calls.slice(fromFloorUp)).length;
    A.eq(counts.praiseUnderBar, 0, 'I7 a thumbs-up under the bar fires no skill review (praise rides the cadence floor)');
    A.eq(nudgeCount(fixture, 'rw-floor'), floor1.turns + floor2.turns, 'I7 and spends nothing');

    // ---- I8 the kept count survives a restart, and the clean agent's next run, a short one with a tool error, reviews ----
    await fixture.restart();
    A.eq(nudgeCount(fixture, 'rw-clean'), 10, 'I8 the count the clean run kept survives a sidecar restart (skill.nudge.json)');
    const short = await drive(fixture, mock, 'rw-clean', 'short', 'Read my notes file and tell me what it says.');
    A.ok(short.turns > 0 && short.turns < 10, 'fixture: the follow-up run is short, under the bar of 10 on its own (' + short.turns + ' turns)');
    counts.carried = short.reviews.length;
    A.eq(counts.carried, 1, 'I8 the count the clean run kept fires the review on the next run that holds a tool error');
    A.eq(nudgeCount(fixture, 'rw-clean'), 0, 'I8 and that review starts the count over');

    // ---- I9 the Task Brief's hold is not a tool error: a clean CHAT run whose first write came before brief_proceed ----
    const logFrom = fixture.output().length;
    const held = await drive(fixture, mock, 'rw-brief', 'brief', 'Survey the station and its workspace, save a short note, and tell me what you find.', 'rw-brief-chat');
    A.eq([held.mains, held.turns], [12, 12], 'fixture: the chat run took 12 model turns');
    const heldResults = held.results.filter(r => TaskIntent.isGateHeld(r));
    A.eq(heldResults.length, 1, 'fixture: the Task Brief held the write made before brief_proceed (the host\'s NOT RUN, NOT FAILED stamp): ' + JSON.stringify(held.results.map(r => (r.ok ? 'ok' : 'FAIL') + ':' + r.summary)));
    A.ok(held.results.length >= 10 && held.results.every(r => r.ok === true || TaskIntent.isGateHeld(r)), 'fixture: every call that ran succeeded, the write included once the brief settled');
    counts.briefHeld = held.reviews.length;
    A.eq(counts.briefHeld, 0, 'I9 a clean chat run (its saved skill loaded, every call that ran succeeded, no cue) whose first write the Task Brief held fires no skill review (lane r2: 1)');
    A.eq(nudgeCount(fixture, 'rw-brief'), 10, 'I9 its nudge count stays at the bar (10, due)');
    const gateLines = fixture.output().slice(logFrom).split(/\r?\n/).filter(l => /\[skills\] review (?:qualifies|held)/.test(l) && l.indexOf('agent=rw-brief') >= 0);
    A.ok(gateLines.length === 1 && gateLines[0].indexOf('[skills] review held: no tool error, correction or new procedure in this run') >= 0 && gateLines[0].indexOf('run=' + held.runId) >= 0,
      'I9 the run end says the review is held for that run, not that a tool error qualifies it: ' + JSON.stringify(gateLines));
  } finally {
    await fixture.dispose();
    try { mock.server.close(); } catch (_) {}
  }
  console.log('skill reviews per 12-turn case: ' + JSON.stringify(counts));
  A.report('skillreview-useful.e2e.test');
})().catch(e => { console.log('FAIL: skillreview-useful.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
