/* node test/nightshift-beat-halt.e2e.test.js — E-STOP reaches a WEDGED force-fired night-shift beat (EL-11 P0).

   THE ESCAPE (found live 2026-07-08): POST /api/nightshift/beat created an AbortController that was never
   registered anywhere killAll/handleHalt reaches (killAll walks `runs`; the driver's abortBeat covers only the
   driver's OWN beat) and was never aborted on request close. A beat wedged on a hung provider held the agent's
   run mutex (concurrencyGate) FOREVER: every follow-up run on that agent was refused with "already running",
   and even the E-STOP could not clear it.

   This boots the ACTUAL sidecar against a mock OpenRouter whose FIRST completion call hangs (SSE headers + one
   token, then byte-silence, never ends) and proves, over HTTP, at the exact seam that was broken:
     · the wedged beat is counted + aborted by POST /api/halt (its AC now lives in `runs` like every other run),
     · the wedged beat request SETTLES (delivered:false — never a fake success) instead of hanging forever,
     · the agent mutex is FREED: a follow-up beat is ACCEPTED (its model run is not refused with
       "already running"), which is exactly concurrencyGate.inFlight(agentId) === 0 observed over HTTP. */
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

// mock OpenRouter: completion call #1 WEDGES (headers + one token, then silence); every later call answers a
// harmless text turn (no JOB block → the beat stands down honestly — settling AT ALL is what we assert).
function startMockOpenRouter() {
  return new Promise((resolve) => {
    const state = { calls: 0, hung: [] };
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          state.calls++;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (state.calls === 1) {
            // THE WEDGE: one real token, then the provider goes silent forever (no [DONE], no end).
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'tok' } }] }) + '\n\n');
            state.hung.push(res);   // keep the socket open; cleanup destroys it
            return;
          }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'nothing to do tonight' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

async function readNdjson(res) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', events = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) { try { events.push(JSON.parse(line)); } catch (_) {} } } }
  return events;
}

// a HOT dossier snapshot so the beat clears the readiness gate and actually reaches the (hung) model.
function hotBeliefs(now) {
  const b = t => [{ text: t, createdAt: now, updatedAt: now }];
  return {
    known: ['goals', 'pain', 'stack', 'ambition'],
    beliefs: {
      goals: b('ship the StarNet beta to 100 users'),
      pain: b('manual release notes eat my fridays'),
      stack: b('node and a pixel-art canvas'),
      ambition: b('a living agent station people watch')
    }
  };
}

async function fireBeat(B, headers) {
  const res = await fetch(B + '/api/nightshift/beat', { method: 'POST', headers, body: JSON.stringify({ agentId: 'agent' }) });
  const stream = await readNdjson(res);
  return ((stream.find(e => e.name === 'nightshift.beat.result') || {}).payload || {});
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-nsbhalt-e2e-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-nsbhalt-fake', SKYNET_DEFAULT_MODEL: 'test/model' };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    // reach 'observe' keeps the beat on the reason-only path — the propose chat is the model call that wedges.
    await fetch(B + '/api/autonomy/posture', { method: 'POST', headers, body: JSON.stringify({ posture: { initiative: 'leash', reach: 'observe', leashPerDay: 12 }, beliefs: hotBeliefs(Date.now()) }) });

    // ===== 1. WEDGE a force-fired beat on the hung provider (do NOT await it yet). =====
    const wedged = fireBeat(B, headers);
    let waited = 0;
    while (mock.state.calls < 1 && waited < 8000) { await sleep(50); waited += 50; }
    A.ok(mock.state.calls >= 1, 'the beat reached the (hung) mock provider — the wedge is live');
    await sleep(150);   // let the one token stream back so the run is mid-body, not mid-connect

    // ===== 2. E-STOP: /api/halt must REACH the beat's AbortController (the exact seam that was broken). =====
    const halt = await (await fetch(B + '/api/halt', { method: 'POST', headers })).json();
    A.ok(typeof halt.halted === 'number' && halt.halted >= 1, 'the wedged beat is COUNTED by the E-STOP (halted=' + halt.halted + ' — it lives in `runs` now, not in an unreachable local AC)');
    // the honest-count fix (EL-11 FIX 3): the response names EVERYTHING the E-STOP aborted — run controllers,
    // cron leases, AND the driver-path beat (additive field) — so the HALT toast can never under-report.
    A.ok(typeof halt.cronAborted === 'number' && typeof halt.beatAborted === 'number', 'the halt response carries all its honest counts (cronAborted + beatAborted)');

    // ===== 3. the wedged request SETTLES honestly — never a hang, never a fake success. =====
    const result = await Promise.race([wedged, sleep(10000).then(() => null)]);
    A.ok(result !== null, 'the wedged beat request settled after the halt (it used to hang until the process died)');
    A.ok(result && result.delivered === false, 'the halted beat reports delivered:false — an aborted beat can never read as success (got ' + JSON.stringify(result) + ')');

    // ===== 4. the agent MUTEX is FREED: a follow-up beat is ACCEPTED (concurrencyGate.inFlight === 0). =====
    // Pre-fix, beat #1 still held the same-agent run mutex, so this beat's model run was refused with
    // "already running" (that refusal text is the observable face of concurrencyGate.inFlight(agentId) > 0).
    const callsBefore = mock.state.calls;
    const second = await Promise.race([fireBeat(B, headers), sleep(10000).then(() => null)]);
    A.ok(second !== null, 'a follow-up beat settles (the mutex is not wedged)');
    A.ok(!/already running/i.test(String((second && second.reason) || '')), 'the follow-up run was ADMITTED — no "already running" mutex refusal (reason: ' + ((second && second.reason) || '?') + ')');
    A.ok(mock.state.calls > callsBefore, 'the follow-up beat actually reached the provider (its model call was accepted, so inFlight was 0)');
  } finally {
    try { for (const r of mock.state.hung) { try { r.destroy(); } catch (_) {} } } catch (_) {}
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('nightshift-beat-halt.e2e.test');
})().catch(e => { console.log('FAIL: nightshift-beat-halt.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
