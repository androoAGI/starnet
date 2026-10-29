/* node test/nightshift-revoke-midbeat.e2e.test.js — lowering the dial to WAIT while a night-shift beat is in flight
   stops that beat (sweep/autonomy 2026-10-20).

   THE HOLE (found live): the dial IS the night shift's consent (initiative >= leash = "act on your own"). Turning it
   down to WAIT mid-beat only changed the NEXT tick's gate: the in-flight beat kept its provider stream open and,
   once it answered, went on to its do + critique model calls (or, at reach >= sandbox, its whole build run) — paid,
   unattended work after the Commander withdrew permission. Only the E-STOP reached the beat. Now a posture write that
   no longer permits acting aborts the driver's in-flight beat, and the ledger records it ending undelivered.
   Real sidecar; mock provider whose completion hangs (headers + one token, then silence). */
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

function startMock() {
  return new Promise(resolve => {
    const state = { calls: 0, hung: [], closedAt: [] };
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; });
        req.on('end', () => {
          state.calls++;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'thinking' } }] }) + '\n\n');
          res.on('close', () => state.closedAt.push(Date.now()));
          state.hung.push(res);
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
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 12000);
  });
}

(async () => {
  const mock = await startMock();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-nsrevoke-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-nsrevoke-fake', SKYNET_DEFAULT_MODEL: 'test/model',
    SKYNET_NIGHTSHIFT_AWAY_MS: '1', SKYNET_NIGHTSHIFT_TICK_MS: '300', SKYNET_NIGHTSHIFT_BEAT_MS: '1000', SKYNET_QUEST_REFRESH: '0' };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const now = Date.now();
    const b = t => [{ text: t, createdAt: now, updatedAt: now }];
    const hot = { known: ['goals', 'pain', 'stack', 'ambition'], beliefs: { goals: b('ship the StarNet beta to 100 users'), pain: b('manual release notes eat my fridays'), stack: b('node and a pixel-art canvas'), ambition: b('a living agent station people watch') } };
    const arm = await (await fetch(B + '/api/autonomy/posture', { method: 'POST', headers, body: JSON.stringify({ posture: { initiative: 'leash', reach: 'observe', leashPerDay: 5 }, beliefs: hot }) })).json();
    A.ok(arm.ok === true && arm.nightshiftArmed === true, 'the dial at leash arms the night shift');
    for (let i = 0; i < 60 && mock.state.calls < 1; i++) await sleep(100);
    A.ok(mock.state.calls >= 1, 'a driver beat fired and reached the (hung) provider');
    const st = await (await fetch(B + '/api/nightshift/status', { headers })).json();
    A.eq(st.inFlight, true, 'the beat is in flight');

    const revokedAt = Date.now();
    const down = await (await fetch(B + '/api/autonomy/posture', { method: 'POST', headers, body: JSON.stringify({ posture: { initiative: 'wait', reach: 'observe', leashPerDay: 5 } }) })).json();
    A.ok(down.ok === true && down.summary && down.summary.actsUnattended === false, 'the dial is lowered to WAIT');
    for (let i = 0; i < 40 && !mock.state.closedAt.length; i++) await sleep(100);
    A.ok(mock.state.closedAt.length >= 1 && mock.state.closedAt[0] - revokedAt < 4000, 'THE IN-FLIGHT BEAT STOPS: its provider stream is closed right after the revoke (closed: ' + JSON.stringify(mock.state.closedAt.map(t => t - revokedAt)) + ')');
    await sleep(800);
    const after = await (await fetch(B + '/api/nightshift/status', { headers })).json();
    A.eq(after.inFlight, false, 'the beat is no longer in flight');
    A.eq(mock.state.calls, 1, 'no further model call was bought after the revoke');
    const led = await (await fetch(B + '/api/autonomy/ledger?limit=50', { headers })).json();
    const rows = (led && (led.entries || led.records)) || [];
    A.ok(rows.some(e => e.source === 'nightshift' && e.detail && e.detail.phase === 'outcome' && e.detail.delivered === false), 'the ledger records the beat ending undelivered');
    A.ok(rows.some(e => e.source === 'nightshift' && e.reason === 'posture-revoked'), 'and names why it stopped (the dial was lowered)');
  } finally {
    for (const h of mock.state.hung) { try { h.destroy(); } catch (_) {} }
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('nightshift-revoke-midbeat.e2e.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
