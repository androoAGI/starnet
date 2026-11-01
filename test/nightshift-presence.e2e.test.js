/* node test/nightshift-presence.e2e.test.js — a LIVE user-initiated run counts as PRESENCE (idle-detection bug,
   2026-07-17).

   THE BUG: /api/run stamped the away clock ONCE at run start. A long "watch the model work" session (the
   Commander commissioning real work and watching it stream) had no pointer/keyboard input in the StarNet window,
   so 15 minutes into their OWN run the sidecar flipped away:true and night-shift beats started firing WHILE the
   Commander sat there working — "starnet constantly thinks I'm idle when clearly I'm working".

   THE FIX (this test pins it over HTTP against the real sidecar + a mocked provider):
     · while an interactive /api/run is streaming, GET /api/nightshift/status reports away:false no matter how
       stale the start-stamp is (the driver's lastActivity dep treats an in-flight interactive run as activity-now);
     · when the run ENDS, the away clock restarts from run END (the finally re-stamp) — so "do a task ~N minutes
       after the user stops interacting" measures from when their work finished, not when it began;
     · once the threshold elapses AFTER the run, away flips true again (the night shift still works). */
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
const AWAY_MS = 700;   // tiny away threshold so the mid-run window is provably PAST it
const sleep = ms => new Promise(r => setTimeout(r, ms));

// a mock OpenRouter: /models -> minimal catalog; /chat/completions -> a SLOW stream (~3s) so the run is
// provably in flight long after the away threshold has elapsed since its start-stamp.
function startMockOpenRouter() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' } }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          let i = 0;
          const t = setInterval(() => {
            try {
              if (res.writableEnded || res.destroyed) { clearInterval(t); return; }
              if (i < 20) { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'work ' } }] }) + '\n\n'); i++; }
              else {
                clearInterval(t);
                res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 20, total_tokens: 24 } }) + '\n\n');
                res.write('data: [DONE]\n\n'); res.end();
              }
            } catch (_) { clearInterval(t); }
          }, 150);
          res.on('close', () => clearInterval(t));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) { settled = true; try { child.kill(); } catch (_) {} if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}
function kill(child) { return new Promise(r => { try { child.on('exit', () => r()); child.kill(); } catch (_) { r(); } setTimeout(r, 3000); }); }

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-nspresence-ws-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base, SKYNET_NIGHTSHIFT_AWAY_MS: String(AWAY_MS) };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const status = async () => (await fetch(B + '/api/nightshift/status', { headers })).json();

    // arm the shift by raising the dial (the same call a live station makes).
    const arm = await (await fetch(B + '/api/autonomy/posture', { method: 'POST', headers, body: JSON.stringify({ posture: { initiative: 'leash', reach: 'sandbox', leashPerDay: 3 } }) })).json();
    A.ok(arm.ok === true, 'raising the dial armed the night shift');

    // ===== 0. baseline sanity: with NO activity, the away threshold flips away:true =====
    await sleep(AWAY_MS + 300);
    let s = await status();
    A.eq(s.away, true, 'baseline: no activity past the threshold reads as away');

    // ===== 1. a streaming interactive run is PRESENCE, even after its start-stamp goes stale =====
    const runP = fetch(B + '/api/run', {
      method: 'POST', headers,
      body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'e2e', messages: [{ role: 'user', content: 'build my game' }] })
    }).then(async r => { const rd = r.body.getReader(); while (!(await rd.read()).done) { /* drain */ } });
    await sleep(AWAY_MS + 600);   // well past the away threshold, measured from the run's START stamp
    s = await status();
    A.eq(s.away, false, 'mid-run: an in-flight interactive run reads as PRESENT (the Commander is watching their own work)');
    A.eq(s.binding, 'present', 'mid-run: the binding gate is "present" — no beat may fire while the user\'s run streams');
    /* The same guarantee the old assertion made, under the name that actually says it: `awayAt` is the FUTURE
       instant away flips true, so mid-run it is still ahead of now (telemetry agrees with the driver).
       `awaySince` now means what "since" means — the PAST instant the idle window opened — because
       frontend/app/nightreport.js documents its own `awaySince` as "the epoch the away window OPENED" and
       filters `ts >= awaySince` with it. Wiring this route in under the old meaning would have scoped every
       night-shift decision OUT of the morning report and rendered a blank morning. */
    A.ok(s.awayAt > Date.now(), 'mid-run: awayAt is in the future (telemetry agrees with the driver)');
    A.ok(s.awaySince <= Date.now(), 'mid-run: awaySince is a PAST boundary — a "since" is never in the future');
    A.eq(s.awayAt - s.awaySince, s.awayAfterMs, 'awayAt is exactly awaySince + the disclosed away threshold');

    // ===== 2. the away clock restarts at run END, then flips honestly after the threshold =====
    await runP;   // the mock stream ends (~3s total); the route's finally re-stamps activity
    s = await status();
    A.eq(s.away, false, 'immediately after the run ends: still present (the clock starts at run END, not run start)');
    await sleep(AWAY_MS + 400);
    s = await status();
    A.eq(s.away, true, 'threshold after run end: away flips true again (the night shift still works)');
  } finally {
    await kill(child);
    try { mock.server.close(); } catch (_) {}
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('nightshift-presence.e2e.test');
})().catch(e => { console.error('nightshift-presence.e2e.test FAILED:', e); process.exit(1); });
