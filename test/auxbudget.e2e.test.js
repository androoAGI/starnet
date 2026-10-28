/* node test/auxbudget.e2e.test.js — TRUE end-to-end proof of the AUX-SPEND JOINT CEILING (aux-budget lane).

   THE GAP THIS CLOSES: after ONE hot task run the sidecar run-end can fire up to SIX aux model passes
   (reflection · study · thread-mine · scout-cycle · skill-review · skill-curator). Each owns its own gate, but
   NO suite verified how many actually fire on a single run-end — the audit's exact finding. This suite boots the
   REAL sidecar with a mock OpenRouter that COUNTS every model call, drives ONE substantial task run (a ~6 KB
   assistant reply clears every salience floor + shouldReviewRun's 5 KB bar on a fresh workspace where all
   cooldowns are cold), and asserts the JOINT bound at the live seam:

     ARM A — governor OFF (SKYNET_AUX_BUDGET=0): the harness fires MANY aux calls (> the on-arm budget). This is
             the NON-VACUOUS / fail-first control: it proves the run genuinely wants to spend, so a passing
             ARM B is real bounding and not "nothing fired anyway." Remove/neuter the governor and ARM B would
             match this count and fail its ceiling assertion.
     ARM B — governor ON (SKYNET_AUX_BUDGET=2): at most 2 aux model calls fire for the same run — and strictly
             fewer than ARM A. The joint ceiling holds live.

   ZERO network, zero real key (the run key is a fake routed to the mock). Ports live in the 8964 range. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// a ~6 KB plain-text assistant reply: no tool calls, finish 'stop' -> the MAIN run is exactly ONE model call,
// and its length clears reflect/study/threadmine salience (>=200 chars) AND skillReview.shouldReviewRun (>=5000).
const LONG_REPLY = ('I dug through the deploy pipeline and rebuilt the staging rollback path end to end. ' +
  'Here is the substantive write-up with the reasoning, the tradeoffs, and the follow-ups worth remembering. ')
  .repeat(40);   // ~5.9 KB

/* mock OpenRouter: streams a reply to every /chat/completions and COUNTS the calls. The MAIN run gets the long
   reply (drives salience); every other call (the aux passes) gets a terse 'ok, done.' We count TOTAL calls — the
   main run is exactly one, so auxCalls = total - 1. */
function startMock() {
  const state = { total: 0, bodies: [] };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          state.total++;
          state.bodies.push(body.slice(0, 200));
          // the MAIN task run is the ONLY call carrying the full '[RUNTIME]' agent system prompt; the aux passes
          // all build their own short system prompts. So '[RUNTIME]' uniquely tags the main run -> the long reply.
          const isMain = body.indexOf('[RUNTIME]') >= 0;
          if (isMain) state.mainCalls = (state.mainCalls || 0) + 1;
          const reply = isMain ? LONG_REPLY : 'ok, done.';
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } }) + '\n\n');
          res.write('data: [DONE]\n\n'); res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

async function driveRun(B, token, agentId, text) {
  const r = await fetch(B + '/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
    body: JSON.stringify({ key: 'sk-or-v1-auxbudget-fake', model: 'test/model', agentId, isTask: true, messages: [{ role: 'user', content: text }] })
  });
  const rd = r.body.getReader(); while (true) { const { done } = await rd.read(); if (done) break; }   // drain to run end
}

// wait for the fire-and-forget aux passes to settle: poll the mock counter until it is stable for `stableMs`,
// or the max window elapses. Returns the final total.
async function settle(state, stableMs, maxMs) {
  const until = Date.now() + (maxMs || 10000);
  let last = -1, stableSince = Date.now();
  while (Date.now() < until) {
    if (state.total !== last) { last = state.total; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= (stableMs || 1300)) break;
    await sleep(200);
  }
  return state.total;
}

// aux passes not under test contribute NO model calls; quest-refresh (not one of the six) is silenced so it can
// never contaminate the count. curator LLM stays default-off (no SKYNET_SKILL_CURATOR_LLM), so it adds 0 calls.
const COMMON = { SKYNET_QUEST_REFRESH: '0' };

async function runArm(label, budgetEnv, envName) {
  const mock = await startMock();
  const fixture = SidecarFixture.create({
    prefix: 'sk-auxbudget-',
    env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base, [envName || 'SKYNET_AUX_BUDGET']: budgetEnv }, COMMON)
  });
  await fixture.start();
  const B = fixture.baseUrl;
  try {
    const token = fixture.token;
    // ONE substantial run on a FRESH workspace: every aux cooldown is cold, so every gate that its salience
    // clears becomes a candidate this single run-end.
    await driveRun(B, token, 'auxbudget-e2e', 'MAIN-RUN-SENTINEL rebuild the staging deploy rollback path and write up what changed and why');
    const total = await settle(mock.state);
    const main = mock.state.mainCalls || 0;
    const aux = total - main;   // every non-'[RUNTIME]' call is an aux pass model call
    return { aux, total, main, bodies: mock.state.bodies.slice() };
  } finally {
    await fixture.dispose();
    try { mock.server.close(); } catch (_) {}
  }
}

(async () => {
  // ARM A — governor OFF: the run WANTS to spend on many aux passes (the non-vacuous control).
  const off = await runArm('off', '0');
  if (process.env.AUXDEBUG) { console.error('OFF markers:'); off.bodies.forEach((b, i) => console.error('  #' + i + ': ' + b.replace(/\s+/g, ' ').slice(0, 120))); }
  A.ok(off.main === 1, 'the main run made exactly one model call (so aux = total - main is exact)');
  A.ok(off.total >= 1, 'the main run itself made at least one model call');
  A.ok(off.aux > 2, 'governor OFF: the single run-end fires MORE than 2 aux model calls (aux=' + off.aux + ') — proves the bound is non-vacuous');

  // ARM B — governor ON at budget 2: the SAME run is bounded to <= 2 aux model calls, strictly fewer than OFF.
  const on = await runArm('on', '2');
  A.ok(on.aux <= 2, 'governor ON (budget 2): at most 2 aux model calls fire on one run-end (aux=' + on.aux + ')');
  A.ok(on.aux >= 1, 'governor ON still lets the top-priority passes spend (aux=' + on.aux + ')');
  A.ok(on.aux < off.aux, 'the governor DEMONSTRABLY cut aggregate aux spend (' + on.aux + ' < ' + off.aux + ')');

  // ARM C — the STARNET_ spelling of the knob (GitHub #105, quick win 32): the aux knobs read process.env.SKYNET_* directly,
  // so STARNET_AUX_BUDGET=0 was silently ignored and the default budget of 2 still capped the run. Through ENV() it is honoured.
  const starnetOff = await runArm('starnet-off', '0', 'STARNET_AUX_BUDGET');
  A.ok(starnetOff.aux > 2, 'STARNET_AUX_BUDGET=0 turns the governor off exactly as SKYNET_AUX_BUDGET=0 does (aux=' + starnetOff.aux + ')');

  console.log('[auxbudget.e2e] aux-calls OFF=' + off.aux + ' ON(budget2)=' + on.aux + ' STARNET-OFF=' + starnetOff.aux + ' (main+aux total OFF=' + off.total + ' ON=' + on.total + ')');
  A.report('auxbudget.e2e.test');
})().catch(e => { console.log('FAIL: auxbudget.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
