/* node test/loops-stall.e2e.test.js — LIVE proof of the two runaway-spend rails added 2026-09-17.

   The incident: a customer's agent ("Pops") ran 98 overnight passes on a full-access loop. Every pass
   re-confirmed that the previous pass's files existed, reported it as work, and was auto-approved. Nothing
   changed, ~$98 was spent, and nothing in the station stood between the loop and the card: every spend cap
   shipped at 0 (ungoverned), and the loop's only convergence signal was the model choosing to say NOTHING-TO-DO.

   This walks the REAL sidecar against a mock OpenRouter and proves, end to end:
     · a fresh station (no env, nothing saved) reports the shipped $25/day rail on /api/budget/status, marked
       as an environment default (not a saved value) — and it is a soft rail the Commander can dial to 0
     · a full-access loop whose passes keep reporting the same "verified the files exist" text parks itself
       PAUSED after stallStopAfter passes, with the reason in words, and then spends NOTHING more
     · the next pass's prompt carried the stall nudge before it parked (the loop was told, not just stopped)
     · RESUME lifts the park with a clean streak and the record intact, and the park survives a restart

   Mirrors loops.e2e.test.js (same mock, same boot, same polling-on-observed-state discipline). */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startMockOpenRouter(defaultReply) {
  const prompts = [];
  const script = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const user = (parsed.messages || []).filter(m => m.role === 'user').map(m => String(m.content || '')).join('\n');
            prompts.push(user);
          } catch (_) { prompts.push(''); }
          const reply = script.length ? script.shift() : defaultReply;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, prompts, script, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 12000);
  });
}

async function until(B, headers, pred, label, ms) {
  const deadline = Date.now() + (ms || 15000);
  let last = null;
  while (Date.now() < deadline) {
    const r = await fetch(B + '/api/loops', { headers });
    last = await r.json();
    if (pred(last)) return last;
    await sleep(200);
  }
  A.ok(false, 'timed out waiting for: ' + label + ' — last state ' + JSON.stringify(last && last.loops && last.loops[0]));
  return last;
}

(async () => {
  // THE POPS REPLY. Every pass says the same thing: it looked, everything is there, nothing to change.
  const POPS = 'Verified that all the project files exist and everything is in place. The structure is confirmed and ready.';
  const mock = await startMockOpenRouter(POPS);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-loops-stall-e2e-'));
  // NOTE: no SKYNET_BUDGET_* in this env — the point is what a fresh install ships with.
  const env = {
    SKYNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-stall-fake',
    SKYNET_DEFAULT_MODEL: 'test/model',
    SKYNET_LOOP_TICK_MS: '1000',
    SKYNET_FULL_ACCESS: '1'
  };
  // scrub any inherited budget env so the assertion is about the shipped default, not this machine's shell
  for (const k of Object.keys(process.env)) if (/^(SKYNET|STARNET)_BUDGET_/.test(k)) env[k] = '';
  let child, port;
  try {
    const OBJ = 'keep the release folder complete and correct';
    const loopCalls = () => mock.prompts.filter(p => p.indexOf(OBJ) === 0).length;

    ({ child, port } = await boot(await allocatePort(), env, 20));
    let B = 'http://' + HOST + ':' + port;
    let token = await bootToken(B, B);
    let headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    // ---- RAIL 1: the shipped day cap is real, visible, honest about its source, and dial-able --------------
    const bs = await (await fetch(B + '/api/budget/status', { headers })).json();
    A.eq(bs.envDefaults.perDay, 25, 'a fresh install ships a $25/day rail (no env, nothing saved)');
    A.eq(bs.caps.perDay, 25, 'and it is the EFFECTIVE cap the governor enforces');
    A.eq(bs.saved.perDay, undefined, 'it is not presented as something the user saved');
    A.eq(bs.day && bs.day.cap, 25, 'the governor\'s live day pool carries it');
    A.eq(bs.envDefaults.perRun, 0, 'per-run stays off');
    A.eq(bs.envDefaults.perAgent, 0, 'per-agent stays off');
    A.eq(bs.envDefaults.global, 0, 'global stays off');
    // the Commander can switch it off — a rail, not a wall
    const off = await fetch(B + '/api/budget/caps', { method: 'POST', headers, body: JSON.stringify({ perDay: 0 }) });
    A.eq(off.status, 200, 'saving perDay=0 is accepted');
    const after = await (await fetch(B + '/api/budget/status', { headers })).json();
    A.eq(after.caps.perDay, 0, 'and the rail is OFF (0 = ungoverned)');
    A.eq(after.day, null, 'the governor drops the day pool entirely');
    // …and back to the default by clearing the saved value
    const back = await fetch(B + '/api/budget/caps', { method: 'POST', headers, body: JSON.stringify({ perDay: null }) });
    A.eq(back.status, 200, 'clearing the saved value is accepted');
    A.eq((await (await fetch(B + '/api/budget/status', { headers })).json()).caps.perDay, 25, 'and the shipped rail is back');

    // ---- RAIL 2: the stall breaker, on the exact shape of the incident --------------------------------------
    // full-access (auto) loop, no workdir (so text is its only output): the echo signal is what must catch it.
    const created = await fetch(B + '/api/loops', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'pops', objective: OBJ, gate: 'auto', queueCap: 5, model: 'test/model', provider: 'openrouter' })
    });
    A.eq(created.status, 200, 'the loop was created');
    const cj = await created.json();
    const loopId = cj.loop.id;
    A.eq(cj.loop.stallStopAfter, 3, 'the shipped stall ceiling is 3 passes');
    A.eq(cj.loop.stallStreak, 0, 'and a new loop has a clean streak');

    const st = await until(B, headers, s => s.loops[0] && s.loops[0].state === 'paused', 'the loop to park itself', 30000);
    const L = st.loops[0];
    A.eq(L.state, 'paused', 'THE LOOP PARKED ITSELF — it never got to pass 98');
    A.eq(L.binding, 'paused', 'and the binding names the quiet state');
    A.ok(/changed nothing/.test(L.stopReason || ''), 'the reason says what happened in words: ' + L.stopReason);
    A.eq(L.stallStreak, 3, 'after exactly the ceiling');
    // pass 1 is a plain candidate (nothing to echo yet); passes 2–4 are echoes → 3 stalls → park at iteration 4
    A.eq(L.iterationCount, 4, 'four passes total: one first pass, then three echoes');
    A.eq(L.recent.filter(r => r.stall === 'echo').length, 3, 'each stalled pass is marked on its own row');
    A.eq(L.recent[0].stall, null, 'and the first pass is not (there was nothing to repeat yet)');
    A.eq(L.approvedCount, 4, 'the auto gate recorded every pass honestly — they DID run; they just changed nothing');

    // the loop was TOLD before it was stopped: the nudge rode the prompt of the pass after the first stall
    const told = mock.prompts.filter(p => p.indexOf(OBJ) === 0);
    A.ok(told.length >= 3 && /CHANGED NOTHING/.test(told[2]), 'the third pass\'s prompt carried the stall nudge');
    A.ok(/Checking that files exist is not work/.test(told[2]), 'naming the exact loop it was in');
    A.ok(/NOTHING-TO-DO/.test(told[2]), 'and offering the honest exit');

    // ---- THE MONEY GUARD: a parked loop spends nothing ------------------------------------------------------
    const callsAtPark = loopCalls();
    await sleep(3500);   // several tick periods
    A.eq(loopCalls(), callsAtPark, 'no further model call after the park');
    const still = (await (await fetch(B + '/api/loops', { headers })).json()).loops[0];
    A.eq(still.state, 'paused', 'and it stayed parked');
    A.eq(still.iterationCount, 4, 'with not one new iteration');

    // ---- the park survives a restart ------------------------------------------------------------------------
    try { child.kill(); } catch (_) {}
    await sleep(600);
    ({ child, port } = await boot(port, env, 20));
    B = 'http://' + HOST + ':' + port;
    token = await bootToken(B, B); headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const revived = (await (await fetch(B + '/api/loops', { headers })).json()).loops[0];
    A.eq(revived.state, 'paused', 'a restart does not quietly resume a parked loop');
    A.eq(revived.stallStreak, 3, 'the streak is durable');
    A.eq(revived.iterationCount, 4, 'and so is the record');
    const callsAfterBoot = loopCalls();
    await sleep(2500);
    A.eq(loopCalls(), callsAfterBoot, 'and it spends nothing after the restart either');

    // ---- RESUME: the Commander's call, with a clean streak and the memory intact ----------------------------
    mock.script.push('I swept the release folder. NOTHING-TO-DO');
    const resumed = await fetch(B + '/api/loops/control', { method: 'POST', headers, body: JSON.stringify({ id: loopId, action: 'resume' }) });
    A.eq(resumed.status, 200, 'resume accepted');
    const rl = (await resumed.json()).loop;
    A.eq(rl.state, 'idle', 'resume lifts the park');
    A.eq(rl.stallStreak, 0, 'with a clean streak');
    A.eq(rl.recent.filter(r => r.stall).length, 3, 'and the stalled rows still on the record');
    const next = await until(B, headers, s => s.loops[0].iterationCount >= 5, 'the resumed loop to run one more pass', 15000);
    A.ok(next.loops[0].iterationCount >= 5, 'it ran again once the Commander said so');
  } finally {
    try { if (child) child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('loops-stall (live: shipped day rail + stall breaker)');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
