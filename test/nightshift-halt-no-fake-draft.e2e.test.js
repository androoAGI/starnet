/* node test/nightshift-halt-no-fake-draft.e2e.test.js — an E-STOP mid-beat never lands as a "delivered" draft
   (sweep/autonomy 2026-10-20).

   THE LIE (found live): a reason-only night-shift beat is propose -> do -> critique, each a runOnce call through
   nightshiftChat. nightshiftChat read only agent.token and agent.run.error and never the TERMINAL reason, so a call
   the E-STOP cancelled (no error event, end reason 'cancelled') came back as a successful reply made of whatever
   had streamed so far. The do step's one streamed token ("Working on it") became the deliverable, the critique call
   (signal already aborted) came back empty -> default 'ship', and the station recorded a DELIVERED draft, ledgered
   outcome delivered:true and served it to the morning report — about work the Commander had just stopped.
   Now only a run that ended 'done' is a reply; a cancelled/budget/limit end is an error and the beat stands down.
   Real sidecar; the mock answers the propose call with one grounded job, then hangs the do call after one token. */
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
const PROPOSE = 'JOB: Automate the release notes\nKIND: kill-pain\nGROUNDS: manual release notes eat my fridays\nSPEC: draft a script that collects merged changes into release notes\nCONFIDENCE: high\n';

function startMock() {
  return new Promise(resolve => {
    const state = { calls: 0, hung: [] };
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
          if (state.calls === 1) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: PROPOSE } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 30, total_tokens: 35 } }) + '\n\n');
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Working on it' } }] }) + '\n\n');
          state.hung.push(res);   // the DO call wedges mid-body
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
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-nsnofake-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-nsnofake-fake', SKYNET_DEFAULT_MODEL: 'test/model',
    SKYNET_NIGHTSHIFT_AWAY_MS: '1', SKYNET_NIGHTSHIFT_TICK_MS: '300', SKYNET_NIGHTSHIFT_BEAT_MS: '600000', SKYNET_QUEST_REFRESH: '0' };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const now = Date.now();
    const b = t => [{ text: t, createdAt: now, updatedAt: now }];
    const hot = { known: ['goals', 'pain', 'stack', 'ambition'], beliefs: { goals: b('ship the StarNet beta to 100 users'), pain: b('manual release notes eat my fridays'), stack: b('node and a pixel-art canvas'), ambition: b('a living agent station people watch') } };
    await fetch(B + '/api/autonomy/posture', { method: 'POST', headers, body: JSON.stringify({ posture: { initiative: 'leash', reach: 'observe', leashPerDay: 5 }, beliefs: hot }) });
    for (let i = 0; i < 80 && mock.state.calls < 2; i++) await sleep(100);
    A.eq(mock.state.calls, 2, 'the driver beat proposed (call 1 answered) and is mid-DO (call 2 wedged)');
    const halt = await (await fetch(B + '/api/halt', { method: 'POST', headers })).json();
    A.ok(halt && halt.beatAborted >= 1, 'the E-STOP reached the in-flight beat');
    let st = null;
    for (let i = 0; i < 40; i++) { st = await (await fetch(B + '/api/nightshift/status', { headers })).json(); if (!st.inFlight) break; await sleep(100); }
    A.eq(st.inFlight, false, 'the beat settled');
    await sleep(300);
    const drafts = (await (await fetch(B + '/api/nightshift/drafts', { headers })).json()).drafts || [];
    A.eq(drafts.length, 0, 'NO DRAFT IS RECORDED from the cancelled DO call (got ' + JSON.stringify(drafts.map(d => d.body)) + ')');
    const led = (await (await fetch(B + '/api/autonomy/ledger?limit=50&source=nightshift', { headers })).json()).entries || [];
    const outcome = led.find(e => e.detail && e.detail.phase === 'outcome');
    A.ok(outcome && outcome.detail.delivered === false, 'the ledger records the halted beat as NOT delivered (got ' + JSON.stringify(outcome && outcome.reason) + ')');
    A.eq(mock.state.calls, 2, 'and no further model call (critique) was bought after the stop');
  } finally {
    for (const h of mock.state.hung) { try { h.destroy(); } catch (_) {} }
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('nightshift-halt-no-fake-draft.e2e.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
