/* node test/learning-cooldown.e2e.test.js — W1.4 LEARNING-PASS COOLDOWNS, end to end (cost lane, 2026-11-09).

   THE COST THIS CLOSES: reflection, failure review, study and thread mining each armed their window only when a
   proposal survived ("a floored or all-dedup run never blocks the next one"), so a pass whose model replied NONE fired
   again on the very next run. Four quick tool runs paid eight one-shot passes (reflection + study after every run) and
   kept nothing. Against the REAL sidecar and a mock OpenRouter that records every model call and answers every
   learning pass NONE (unless a case asks for a productive one):

     I1 THE INVARIANT — four quick tool-using runs of one agent spend at most 4 one-shot passes in all, and none on
        runs 3-4 (base e316231d7: 8, two after every run).
     I2 a correction cue in the Commander's own words ("always use tabs") inside the window still gets reflection.
     I3 a productive pass arms its window exactly as before: the next quick run gets no reflection.
     I4 two failed runs of one failure class inside the 5 min window get ONE failure review (base: two).
     I5 a NEW failure class inside that window still gets its review.
     I6 a thumbs verdict opens the windows once: the next run reflects, the run after it does not (base: every run).
     I7 the NONE backoff: with a 5 s reflection window, a run after two NONE replies gets no reflection although the
        5 s base window has passed (base: it reflects).
     I8 study's attempt stamp survives a sidecar restart (study.state.json): the first run after it gets no study.
   The orderings (a verdict or a cue that lands while a pass is still running, a reset mid-pass) are
   test/learning-cooldown.race.e2e.test.js: a separate step, so each stays well inside the runner's 120 s cap.

   Zero network, zero real key (the fake key routes to the mock). Prints the measured counts on one line. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const MODEL = 'test/model';
const KEY = 'sk-or-v1-learning-cooldown-fake';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// the four LEARNING passes and the scout, told apart by their own system prompts (sidecar/index.js run* functions)
function kindOf(sys) {
  if (/reflecting right after finishing a task/.test(sys)) return 'reflection';
  if (/reviewing a task run of yours that FAILED/.test(sys)) return 'failure-review';
  if (/durable profile of your Commander/.test(sys)) return 'study';
  if (/surface ideas the Commander raised/.test(sys)) return 'threadmine';
  if (/recurring, specific work topics/.test(sys)) return 'scout';
  return 'other';
}
const ONE_SHOT = new Set(['reflection', 'failure-review', 'study', 'threadmine', 'scout']);

// ~250 chars: with the tool turn it clears every salience floor (reflect/study: tool use; thread mining: 200+ chars)
const DONE_TEXT = 'Done. I inspected the station and wrote the short note you asked for into the workspace root, numbered in ' +
  'sequence with the earlier ones so it is easy to find later. Nothing else in the workspace changed, and there is no ' +
  'follow-up needed from you for this one.';
const FACT = 'FACT: The Commander keeps numbered plain-text notes in the workspace root.';

const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && (p.text || '')) || '').join('') : '';

function sse(res, deltas, finishReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const delta of deltas) res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

/* mock OpenRouter. MAIN calls (the only ones carrying the runtime system prompt) make one real tool turn
   (station_inspect), then finish DONE_TEXT — or fail when the directive says so: LC-FAIL-SHAPE a fatal 400
   (provider_stream / format_error), LC-FAIL-IMAGE a 404 "No endpoints found that support image input"
   (provider_stream / model_not_found on a request part, still reviewable). Every other call is an aux pass: NONE,
   except a reflection over the LC-PRODUCTIVE run, which keeps one FACT. */
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
        const main = raw.indexOf('[RUNTIME]') >= 0;
        const rec = { at: Date.now(), main, kind: main ? 'main' : kindOf(sys), chars: raw.length };
        state.calls.push(rec);
        if (!main) return sse(res, [{ content: rec.kind === 'reflection' && raw.indexOf('LC-PRODUCTIVE') >= 0 ? FACT : 'NONE' }]);
        // the newest user turn that carries a case marker is this run's directive
        const said = messages.filter(m => m && m.role === 'user').map(m => textOf(m.content)).reverse().find(t => /\[LC /.test(t)) || '';
        if (!messages.some(m => m && m.role === 'tool')) {
          return sse(res, [{ tool_calls: [{ index: 0, id: 'inspect_' + state.calls.length, type: 'function', function: { name: 'station_inspect', arguments: '{}' } }] }], 'tool_calls');
        }
        if (said.indexOf('LC-FAIL-SHAPE') >= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'main stream rejected (test fault injection)', code: 400 } }));
          return;
        }
        if (said.indexOf('LC-FAIL-IMAGE') >= 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'No endpoints found that support image input', code: 404 } }));
          return;
        }
        sse(res, [{ content: DONE_TEXT }]);
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
  // the default aux budget (2) and the default windows; the skill review and quest refresh stay out of the count
  return Object.assign(env, { SKYNET_OPENROUTER_BASE: mockBase, SKYNET_FULL_ACCESS: '1', SKYNET_QUEST_REFRESH: '0', SKYNET_SKILL_REVIEW: '0',
    STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CLOUD_URL: '', SKYNET_CLOUD_URL: '' });
}

async function drive(fixture, agentId, text) {
  const r = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, model: MODEL, agentId, isTask: true, messages: [{ role: 'user', content: text }] })
  });
  A.eq(r.status, 200, 'the real /api/run stream opened for ' + agentId);
  const events = (await r.text()).split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const end = events.filter(e => e.name === 'agent.run.end').pop();
  return { reason: end && end.payload && end.payload.reason, runId: end && end.payload && end.payload.runId };
}

// wait until the fire-and-forget passes of the run that just ended have landed (no new call for stableMs)
async function settle(state, stableMs, maxMs) {
  const until = Date.now() + (maxMs || 15000);
  let last = -1, stableSince = Date.now();
  while (Date.now() < until) {
    if (state.calls.length !== last) { last = state.calls.length; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= (stableMs || 1500)) break;
    await sleep(150);
  }
}

async function runAndCount(fixture, mock, agentId, text) {
  const from = mock.state.calls.length;
  const out = await drive(fixture, agentId, text);
  await settle(mock.state);
  const aux = mock.state.calls.slice(from).filter(c => !c.main);
  const oneShot = aux.filter(c => ONE_SHOT.has(c.kind));
  const of = kind => oneShot.filter(c => c.kind === kind);
  return Object.assign(out, { aux, oneShot, of, kinds: aux.map(c => c.kind) });
}

(async () => {
  const mock = await startMock();
  const fixture = SidecarFixture.create({ prefix: 'sk-learncool-', env: hermeticEnv(mock.base) });
  await fixture.start();
  const report = {};
  try {
    // ---- I1 THE INVARIANT: four quick tool-using runs, every learning pass answers NONE ----
    const burst = [];
    for (let n = 1; n <= 4; n++) {
      burst.push(await runAndCount(fixture, mock, 'lc-burst', 'Please inspect the station and save note ' + n + ' as a short plain-text file in the workspace root, numbered in sequence with the earlier notes. [LC burst ' + n + ']'));
    }
    burst.forEach((r, i) => A.eq(r.reason, 'done', 'I1: burst run ' + (i + 1) + ' finished done'));
    const perRun = burst.map(r => r.oneShot.length);
    const total = perRun.reduce((a, b) => a + b, 0);
    report.burst = perRun;
    report.burstKinds = burst.map(r => r.kinds.join('+') || '-');
    report.burstPromptChars = burst.map(r => r.oneShot.reduce((a, c) => a + c.chars, 0));
    A.ok(perRun[0] >= 1, 'I1 (non-vacuous): the first run of the burst does spend learning passes (' + report.burstKinds[0] + ')');
    A.ok(total <= 4, 'I1: four quick NONE runs spend at most 4 one-shot passes in all (got ' + total + ' ' + JSON.stringify(perRun) + ': ' + report.burstKinds.join(' | ') + ')');
    A.eq(perRun[2] + perRun[3], 0, 'I1: runs 3-4 of the burst spend no one-shot pass (' + report.burstKinds.slice(2).join(' | ') + ')');

    // ---- I2 a correction cue in the Commander's own words still reflects inside the window ----
    {
      const r = await runAndCount(fixture, mock, 'lc-burst', 'Inspect the station again and save note 5. From now on always use tabs for indentation in these notes. [LC burst 5]');
      A.eq(r.reason, 'done', 'I2: the cue run finished done');
      report.cue = r.kinds.join('+') || '-';
      A.eq(r.of('reflection').length, 1, 'I2: a cue ("always", "from now on") inside the window still gets its reflection (' + report.cue + ')');
      A.ok(/\[learning\] reflection may spend inside its window: agent=lc-burst \(cue\)/.test(fixture.output()), 'I2: ...because of the cue, inside the window (the sidecar log says so)');
    }

    // ---- I3 a productive pass arms its window exactly as before ----
    {
      const first = await runAndCount(fixture, mock, 'lc-prod', 'Please inspect the station and save the first note in the workspace root. LC-PRODUCTIVE [LC prod 1]');
      A.eq(first.of('reflection').length, 1, 'I3: the first run reflects (' + (first.kinds.join('+') || '-') + ')');
      const recs = await fixture.json('GET', '/api/memory/records?agent=lc-prod');
      A.ok((recs.body.records || []).some(x => /numbered plain-text notes/.test(String(x.body || x.content || ''))), 'I3: the productive reflection kept its fact');
      const second = await runAndCount(fixture, mock, 'lc-prod', 'Please inspect the station and save the second note in the workspace root. [LC prod 2]');
      report.productive = [first.kinds.join('+') || '-', second.kinds.join('+') || '-'];
      A.eq(second.of('reflection').length, 0, 'I3: a productive reflection arms its window as before: the next quick run gets none (' + report.productive[1] + ')');
    }

    // ---- I4 / I5 failure review: one class twice -> one review; a new class -> its own review ----
    {
      const a = await runAndCount(fixture, mock, 'lc-fail', 'Inspect the station, then push the registry update. LC-FAIL-SHAPE [LC fail 1]');
      const b = await runAndCount(fixture, mock, 'lc-fail', 'Inspect the station, then push the registry update again. LC-FAIL-SHAPE [LC fail 2]');
      A.eq([a.reason, b.reason], ['error', 'error'], 'I4: both runs really failed');
      report.failSame = [a.of('failure-review').length, b.of('failure-review').length];
      A.eq(a.of('failure-review').length, 1, 'I4: the first failed run gets its failure review');
      A.eq(b.of('failure-review').length, 0, 'I4: a second failure of the same class inside 5 min gets none (the NONE review stamped the window)');
      const c = await runAndCount(fixture, mock, 'lc-fail', 'Inspect the station, then read the screenshot it took. LC-FAIL-IMAGE [LC fail 3]');
      A.eq(c.reason, 'error', 'I5: the third run really failed');
      report.failNew = c.of('failure-review').length;
      A.eq(c.of('failure-review').length, 1, 'I5: a NEW failure class (model_not_found on a request part) inside the window still gets its review');
      A.ok(/\[learning\] failure-review may spend inside its window: agent=lc-fail \(new-failure-class\)/.test(fixture.output()), 'I5: ...because the class is new (the sidecar log says so)');
    }

    // ---- I6 a thumbs verdict opens every window once ----
    {
      const one = await runAndCount(fixture, mock, 'lc-verdict', 'Please inspect the station and draft the weekly status note. [LC verdict 1]');
      A.eq(one.reason, 'done', 'I6: the rated run finished done');
      const rated = await fixture.json('POST', '/api/growth/ratings', { runId: one.runId, verdict: 'miss', epoch: 1 });
      A.ok(rated.status === 200 && rated.body && rated.body.ok, 'I6: the thumbs-down verdict was recorded (' + JSON.stringify(rated.body) + ')');
      const two = await runAndCount(fixture, mock, 'lc-verdict', 'Please inspect the station and draft the weekly status note again. [LC verdict 2]');
      const three = await runAndCount(fixture, mock, 'lc-verdict', 'Please inspect the station and file the weekly status note. [LC verdict 3]');
      report.verdict = [one, two, three].map(r => r.kinds.join('+') || '-');
      A.eq(two.of('reflection').length, 1, 'I6: the run after a thumbs verdict reflects inside the window (' + report.verdict[1] + ')');
      A.ok(/\[learning\] reflection may spend inside its window: agent=lc-verdict \(feedback\)/.test(fixture.output()), 'I6: ...because of the verdict, stored as feedback (the sidecar log says so)');
      A.eq(three.of('reflection').length, 0, 'I6: the verdict opens the window once: the run after that gets no reflection (' + report.verdict[2] + ')');
    }

    // ---- I7 the NONE backoff, live: a 5 s base window, x4 after the second NONE reply ----
    {
      const set = await fixture.json('POST', '/api/memory/config', { reflectCooldownMs: 5000 });
      A.eq(set.status, 200, 'I7: the reflection window is set to 5 s');
      const lastReflection = () => mock.state.calls.filter(c => c.kind === 'reflection').pop();
      const one = await runAndCount(fixture, mock, 'lc-ladder', 'Please inspect the station and log the first reading. [LC ladder 1]');
      A.eq(one.of('reflection').length, 1, 'I7: the first run reflects (NONE)');
      const t1 = lastReflection().at;
      while (Date.now() - t1 < 6000) await sleep(100);
      const two = await runAndCount(fixture, mock, 'lc-ladder', 'Please inspect the station and log the second reading. [LC ladder 2]');
      A.eq(two.of('reflection').length, 1, 'I7: after one NONE the window is the base 5 s: the run 6 s later reflects (NONE again)');
      const t2 = lastReflection().at;
      while (Date.now() - t2 < 6500) await sleep(100);
      const three = await runAndCount(fixture, mock, 'lc-ladder', 'Please inspect the station and log the third reading. [LC ladder 3]');
      const ended = Date.now() - t2;
      report.ladder = [one, two, three].map(r => r.kinds.join('+') || '-');
      A.ok(ended < 19000, 'I7 (precondition): the third run ended inside the backed-off 20 s window (' + ended + ' ms after the second reflection)');
      A.eq(three.of('reflection').length, 0, 'I7: after two NONE replies the window backs off (x4): a run 6.5 s later gets no reflection although the 5 s base window has passed (' + report.ladder[2] + ')');
    }

    // ---- I8 study's attempt stamp round-trips a sidecar restart ----
    {
      await fixture.restart();
      const r = await runAndCount(fixture, mock, 'lc-burst', 'Please inspect the station and save note 6 in the workspace root. [LC burst 6]');
      A.eq(r.reason, 'done', 'I8: the run after the restart finished done');
      report.afterRestart = r.kinds.join('+') || '-';
      A.eq(r.of('study').length, 0, 'I8: study\'s 30 min window, stamped by a NONE attempt before the restart, still holds after it (' + report.afterRestart + ')');
    }
  } finally {
    console.log('[learning-cooldown.e2e] ' + JSON.stringify(report));
    await fixture.dispose();
    try { mock.server.close(); } catch (_) {}
  }
  A.report('learning-cooldown.e2e.test');
})().catch(e => { console.log('FAIL: learning-cooldown.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
