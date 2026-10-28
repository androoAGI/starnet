/* node test/e2e.acceptance-nudge.test.js — real-sidecar proof of ACCEPTANCE-ON-STOP (SOP lane, 2026-08-22).

   The loop-level test proves the nudge mechanics; this proves the HOST wiring: a real /api/run carrying a typed
   postconditions contract (exactly what an SOP recipe launch sends), a mocked model that claims "done" without
   producing the artifact, and the assertion that the sidecar's probe sent the model back ONE real turn with a
   system message NAMING the failing check — then ended honestly `incomplete` when the model still did nothing. */
'use strict';
const A = require('./_assert.js');
const { loopNotes } = require('./helpers/host-notes.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function startMockOpenRouter() {
  const requests = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          let parsed = null; try { parsed = JSON.parse(body); requests.push(parsed); } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          // the model always just claims it is done — never produces the artifact
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'The invoice is ready.' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } }) + '\n\n');
          res.write('data: [DONE]\n\n'); res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}
function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-accept-e2e-'));
  const { child, port } = await boot(9210 + (process.pid % 50), { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    const contract = { schemaVersion: 'starnet.task-postconditions.v1', authority: 'commander', requirements: [
      { id: 'sop-1', type: 'artifact_contains', path: 'out/acme-invoice.md', text: 'TOTAL' },
      { id: 'sop-2', type: 'verification_passed', command: 'node scripts/check-invoice.js acme' }
    ] };
    const r = await fetch(B + '/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
      body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'sop-e2e', isTask: true,
        messages: [{ role: 'user', content: 'Prepare the invoice for acme.\n\nAcceptance (the host checks these when you finish):\n- out/acme-invoice.md contains "TOTAL"\n- check passes: node scripts/check-invoice.js acme' }],
        postconditions: contract })
    });
    const raw = await r.text();
    const evs = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const end = evs.find(e => e.name === 'agent.run.end');
    A.ok(end, 'the run ended');
    A.eq(mock.requests.length, 2, 'the model was called TWICE: its first "done" was sent back by the acceptance probe');
    const second = mock.requests[1] || {};
    // a fenced host message: its own system message on a native wire, user-side text after the answer on a chat wire
    // (provider.js projectRoles — a strict template refuses a system message after index 0)
    const nudge = loopNotes(second.messages, 'acceptance_before_done')[0];
    A.ok(nudge, 'the second call carries the host acceptance nudge as a fenced host message');
    A.ok(nudge && /sop-1 \[artifact_contains out\/acme-invoice\.md\]: artifact_not_produced_by_run/.test(nudge), 'the nudge names the artifact check and WHY it fails (not produced by this run)');
    A.ok(nudge && /sop-2 \[verification_passed `node scripts\/check-invoice\.js acme`\]: matching_verification_missing/.test(nudge), 'the nudge names the command check and why');
    // NOTE: `turns` reads 1 here, not 2 — the model's repeated identical answer is a DUPLICATE turn and the loop's
    // existing refund accounting gives it back; the two provider requests above are the proof the turn was bought.
    A.ok(evs.some(e => e.name === 'iteration.refunded' && e.payload && e.payload.reason === 'duplicate'), 'the wasted extra turn was refunded as a duplicate (existing accounting)');
    A.eq(end.payload.completionVerdict, 'incomplete', 'the model did nothing on the extra turn, so the host verdict stays incomplete — prose never promotes it');
    const runId = ((evs.find(e => e.name === 'agent.run.start') || {}).payload || {}).runId;
    const rows = await (await fetch(B + '/api/runs?agent=sop-e2e&runId=' + encodeURIComponent(runId), { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    const saved = (rows.runs || [])[0];
    A.eq(saved && saved.completionEvidence.checks.map(c => c.id + ':' + c.status).join(','), 'sop-1:failed,sop-2:failed', 'durable run history keeps both named checks with their outcome');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('e2e.acceptance-nudge');
})().catch(e => { console.log('FAIL: e2e.acceptance-nudge threw - ' + (e && e.stack || e)); process.exit(1); });
