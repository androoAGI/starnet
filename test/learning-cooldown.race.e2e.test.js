/* node test/learning-cooldown.race.e2e.test.js — W1.4 LEARNING-PASS COOLDOWNS: the orderings (review r1, 2026-11-09).

   Since W1.4 every learning-pass ATTEMPT arms its window, so feedback has to get through some other way: a stored like
   or dislike (a thumbs verdict, a correction, ...) and a cue in the Commander's own words open every window of the
   agent once. Review round 1 found the orderings the first build lost, where the lane did WORSE than base:
     R1 a thumbs verdict that lands while the rated run's own reflection and study are still running (a slow aux model,
        e.g. a CLI route): those passes ended after it, used the skip up and armed the windows, so the next run got no
        reflection and no study. Now a pass spends a feedback token only when its run ended after the feedback.
     R2 a cue ("from now on always ...") in a run that ends while the previous run's reflection and study still run:
        their in-flight guards held them at the cue run, the older passes then armed the windows, and the next run
        reflected on nothing. Now the cue is a token too, kept for each held pass's next attempt.
   And the reverse ordering the same order numbers close (review nit):
     R3 a memory reset while the hero's passes still run: they ended after it and stamped the windows again (study's
        persisted to study.state.json), so the fresh hero inherited a 30 min study window. Now they arm nothing.
     R4 a correction after the verdict is a stored dislike: it opens the windows again (the one feedback write path).
   Against the REAL sidecar and a mock OpenRouter that HOLDS every learning pass's reply until the test releases it
   (deterministic, no sleeps standing in for a slow model) and answers NONE. R1-R3 FAIL on f052e31e3 (round 1). */
'use strict';

const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const MODEL = 'test/model';
const KEY = 'sk-or-v1-learning-cooldown-race-fake';
const CUE = 'From now on always use tabs for indentation in these notes.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// the four LEARNING passes and the scout, told apart by their own system prompts (sidecar/index.js run* functions)
const LEARNING = ['reflection', 'failure-review', 'study', 'threadmine'];
function kindOf(sys) {
  if (/reflecting right after finishing a task/.test(sys)) return 'reflection';
  if (/reviewing a task run of yours that FAILED/.test(sys)) return 'failure-review';
  if (/durable profile of your Commander/.test(sys)) return 'study';
  if (/surface ideas the Commander raised/.test(sys)) return 'threadmine';
  if (/recurring, specific work topics/.test(sys)) return 'scout';
  return 'other';
}
// ~250 chars: with the tool turn it clears every salience floor (reflect/study: tool use; thread mining: 200+ chars)
const DONE_TEXT = 'Done. I inspected the station and wrote the short note you asked for into the workspace root, numbered in ' +
  'sequence with the earlier ones so it is easy to find later. Nothing else in the workspace changed, and there is no ' +
  'follow-up needed from you for this one.';
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && (p.text || '')) || '').join('') : '';

function sse(res, deltas, finishReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const delta of deltas) res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

/* mock OpenRouter. MAIN calls (the only ones carrying the runtime system prompt) make one real tool turn
   (station_inspect) after the newest user turn, then finish DONE_TEXT. Every other call is an aux pass, answered NONE —
   at once, or, while `hold` is on, only when the test calls release(): a slow aux model the test controls. */
function startMock() {
  const state = { calls: [], held: [], hold: false };
  const release = () => { state.hold = false; for (const answer of state.held.splice(0)) answer(); };
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
        const main = raw.indexOf('[RUNTIME]') >= 0;
        const rec = { at: Date.now(), main, kind: main ? 'main' : kindOf(sys), done: main, readsCue: !main && raw.indexOf('always use tabs') >= 0 };
        state.calls.push(rec);
        if (!main) {
          const answer = () => { rec.done = true; sse(res, [{ content: 'NONE' }]); };
          // only the four learning passes are slow: anything else (the scout, a title) answers at once
          if (state.hold && LEARNING.indexOf(rec.kind) >= 0) state.held.push(answer); else answer();
          return;
        }
        const lastUser = messages.map(m => m && m.role).lastIndexOf('user');
        if (!messages.slice(lastUser + 1).some(m => m && m.role === 'tool')) {
          return sse(res, [{ tool_calls: [{ index: 0, id: 'inspect_' + state.calls.length, type: 'function', function: { name: 'station_inspect', arguments: '{}' } }] }], 'tool_calls');
        }
        sse(res, [{ content: DONE_TEXT }]);
      });
    });
    server.listen(0, HOST, () => resolve({ server, state, release, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

// the provider credentials and StarNet knobs of the shell that launched the test never reach the fixture
function hermeticEnv(mockBase) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k) && k !== 'STARNET_CLAUDE_BIN') env[k] = '';
  }
  // the default aux budget (2) and the default windows; the skill review and quest refresh stay out of the count
  return Object.assign(env, { SKYNET_OPENROUTER_BASE: mockBase, SKYNET_FULL_ACCESS: '1', SKYNET_QUEST_REFRESH: '0', SKYNET_SKILL_REVIEW: '0',
    STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CLOUD_URL: '', SKYNET_CLOUD_URL: '' });
}

async function drive(fixture, agentId, messages) {
  const r = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, model: MODEL, agentId, isTask: true, messages })
  });
  A.eq(r.status, 200, 'the real /api/run stream opened for ' + agentId);
  const events = (await r.text()).split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const end = events.filter(e => e.name === 'agent.run.end').pop();
  return { reason: end && end.payload && end.payload.reason, runId: end && end.payload && end.payload.runId };
}
async function until(pred, label, maxMs) {
  const end = Date.now() + (maxMs || 15000);
  while (!pred()) { if (Date.now() > end) throw new Error('timed out waiting: ' + label); await sleep(50); }
}
// every aux pass sent so far has been answered, and nothing new arrived for stableMs (its finally ran right after its reply)
async function settle(state, stableMs, maxMs) {
  const until = Date.now() + (maxMs || 20000);
  let last = -1, stableSince = Date.now();
  while (Date.now() < until) {
    const open = state.held.length || state.calls.some(c => !c.done);
    if (state.calls.length !== last || open) { last = state.calls.length; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= (stableMs || 1200)) break;
    await sleep(100);
  }
}
const aux = (state, from) => state.calls.slice(from).filter(c => !c.main);
// the aux passes sent between two points, by kind (the report and the failure messages)
const span = (state, from, to) => state.calls.slice(from, to).filter(c => !c.main).map(c => c.kind).join('+') || '-';
const kinds = (state, from) => aux(state, from).map(c => c.kind + (c.readsCue ? '(cue)' : '')).join('+') || '-';
const has = (state, from, kind) => aux(state, from).some(c => c.kind === kind);
const say = (text, history) => (history || []).concat([{ role: 'user', content: text }]);

(async () => {
  const mock = await startMock();
  const st = mock.state;
  const fixture = SidecarFixture.create({ prefix: 'sk-learnrace-', env: hermeticEnv(mock.base) });
  await fixture.start();
  const report = {};
  const logSays = (agent, why) => new RegExp('\\[learning\\] reflection may spend inside its window: agent=' + agent + ' \\(' + why + '\\)').test(fixture.output());
  try {
    // ---- R1 a thumbs verdict lands while the rated run's own reflection and study are still running ----
    {
      const agent = 'lc-race-verdict';
      st.hold = true;
      const a0 = st.calls.length;
      const one = await drive(fixture, agent, say('Please inspect the station and draft the weekly status note. [LC race-verdict 1]'));
      A.eq(one.reason, 'done', 'R1: the rated run finished done');
      await until(() => has(st, a0, 'reflection') && has(st, a0, 'study'), 'run 1\'s reflection and study reach the (slow) model');
      const runningAtVerdict = aux(st, a0).filter(c => !c.done).map(c => c.kind);
      const rated = await fixture.json('POST', '/api/growth/ratings', { runId: one.runId, verdict: 'miss', epoch: 1 });
      A.ok(rated.status === 200 && rated.body && rated.body.ok, 'R1: the thumbs-down verdict was recorded (' + JSON.stringify(rated.body).slice(0, 200) + ')');
      A.eq(rated.body && rated.body.feedbackMemory && rated.body.feedbackMemory.stored, true, 'R1: ...and stored as feedback through the one write path');
      A.ok(runningAtVerdict.includes('reflection') && runningAtVerdict.includes('study') && st.held.length >= 2, 'R1 (precondition): run 1\'s reflection and study were still running when the verdict landed (' + runningAtVerdict.join(',') + ')');
      mock.release();
      await settle(st);
      A.ok(aux(st, a0).every(c => c.done), 'R1 (precondition): run 1\'s passes ended after the verdict, NONE');
      const a1 = st.calls.length;
      const two = await drive(fixture, agent, say('Please inspect the station and draft the weekly status note again. [LC race-verdict 2]'));
      await settle(st);
      const a2 = st.calls.length;
      await drive(fixture, agent, say('Please inspect the station and file the weekly status note. [LC race-verdict 3]'));
      await settle(st);
      report.verdict = { runningAtVerdict, run1: span(st, a0, a1), run2: span(st, a1, a2), run3: span(st, a2) };
      A.eq(two.reason, 'done', 'R1: run 2 finished done');
      A.ok(/reflection/.test(report.verdict.run2) && /study/.test(report.verdict.run2), 'R1: the run after a verdict that landed mid-pass still reflects and studies inside their windows (' + report.verdict.run2 + ')');
      A.ok(logSays(agent, 'feedback'), 'R1: ...because of the stored verdict (the sidecar log says so)');
      A.ok(!/reflection/.test(report.verdict.run3), 'R1: the verdict opens each window once: run 3 gets no reflection (' + report.verdict.run3 + ')');

      // ---- R4 a correction after the verdict is a stored dislike too: it opens the windows again ----
      const corr = await fixture.json('POST', '/api/growth/ratings/correction', { runId: one.runId, text: 'Use tabs, not spaces, in these status notes.', source: 'chip' });
      A.eq(corr.status, 200, 'R4: the correction route answered');
      A.eq(corr.body && corr.body.feedbackMemory && corr.body.feedbackMemory.stored, true, 'R4: the correction was stored as feedback (' + JSON.stringify(corr.body && corr.body.feedbackMemory) + ')');
      const a3 = st.calls.length;
      await drive(fixture, agent, say('Please inspect the station and draft next week\'s status note. [LC race-verdict 4]'));
      await settle(st);
      report.correction = aux(st, a3).map(c => c.kind).join('+') || '-';
      A.ok(/reflection/.test(report.correction), 'R4: the run after a correction reflects inside its (backed-off) window again (' + report.correction + ')');
    }

    // ---- R2 a cue in a run that ends while the previous run's reflection and study are still running ----
    {
      const agent = 'lc-race-cue';
      const uA = 'Please inspect the station and save note 1 as a short plain-text file in the workspace root. [LC race-cue A]';
      const uB = 'Inspect the station again and save note 2. ' + CUE + ' [LC race-cue B]';
      const uC = 'Please inspect the station and save note 3 in the workspace root. [LC race-cue C]';
      const hist = [];
      st.hold = true;
      const a0 = st.calls.length;
      const A1 = await drive(fixture, agent, say(uA, hist));
      hist.push({ role: 'user', content: uA }, { role: 'assistant', content: DONE_TEXT });
      await until(() => has(st, a0, 'reflection') && has(st, a0, 'study'), 'run A\'s reflection and study reach the (slow) model');
      const b0 = st.calls.length;
      const B = await drive(fixture, agent, say(uB, hist));
      hist.push({ role: 'user', content: uB }, { role: 'assistant', content: DONE_TEXT });
      const stillRunning = aux(st, a0).filter(c => st.calls.indexOf(c) < b0 && !c.done).map(c => c.kind);
      A.eq([A1.reason, B.reason], ['done', 'done'], 'R2: runs A and B finished done');
      A.ok(stillRunning.includes('reflection') && stillRunning.includes('study'), 'R2 (precondition): run A\'s reflection and study were still running when the cue run B ended (' + stillRunning.join(',') + ')');
      mock.release();
      await settle(st);
      const afterB = aux(st, b0).map(c => c.kind);
      A.ok(!afterB.includes('reflection') && !afterB.includes('study'), 'R2 (precondition): B\'s own reflection and study were held by their in-flight guards (' + afterB.join('+') + ')');
      const c0 = st.calls.length;
      const C = await drive(fixture, agent, say(uC, hist));
      await settle(st);
      report.cue = { stillRunning, afterB: afterB.join('+') || '-', afterC: kinds(st, c0) };
      A.eq(C.reason, 'done', 'R2: run C finished done');
      const cAux = aux(st, c0);
      A.ok(cAux.some(c => c.kind === 'reflection' && c.readsCue) && cAux.some(c => c.kind === 'study' && c.readsCue), 'R2: the next run\'s reflection and study still get to read the cue (' + report.cue.afterC + ')');
      A.ok(logSays(agent, 'cue'), 'R2: ...because of the cue held for them (the sidecar log says so)');
    }

    // ---- R3 a memory reset while the hero's passes still run: they end after it and arm nothing ----
    {
      const agent = 'lc-race-reset';
      st.hold = true;
      const a0 = st.calls.length;
      const one = await drive(fixture, agent, say('Please inspect the station and log the first reading. [LC race-reset 1]'));
      A.eq(one.reason, 'done', 'R3: the first run finished done');
      await until(() => has(st, a0, 'reflection') && has(st, a0, 'study'), 'run 1\'s reflection and study reach the (slow) model');
      const reset = await fixture.json('POST', '/api/memory/reset', { agent });
      A.ok(reset.status === 200 && reset.body && reset.body.ok, 'R3: the memory reset landed while the passes ran (' + JSON.stringify(reset.body) + ')');
      mock.release();
      await settle(st);
      let lastAt = {};
      try { lastAt = (JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'study.state.json'), 'utf8')) || {}).lastAt || {}; } catch (_) {}
      report.resetStudyKey = Object.prototype.hasOwnProperty.call(lastAt, agent);
      A.eq(report.resetStudyKey, false, 'R3: a study that outlived the reset wrote no window back to study.state.json');
      const a1 = st.calls.length;
      await drive(fixture, agent, say('Please inspect the station and log the second reading. [LC race-reset 2]'));
      await settle(st);
      report.reset = aux(st, a1).map(c => c.kind).join('+') || '-';
      A.ok(/reflection/.test(report.reset) && /study/.test(report.reset), 'R3: the fresh hero\'s next run reflects and studies: no window inherited from before the reset (' + report.reset + ')');
    }
  } finally {
    try { mock.release(); } catch (_) {}
    console.log('[learning-cooldown.race.e2e] ' + JSON.stringify(report));
    await fixture.dispose();
    try { mock.server.close(); } catch (_) {}
  }
  A.report('learning-cooldown.race.e2e.test');
})().catch(e => { console.log('FAIL: learning-cooldown.race.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
