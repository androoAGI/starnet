/* node test/reach-fence.e2e.test.js — THE REACH FENCE (2026-11-08): Full Access + TRUSTED PROJECT never asks inside the
   approved folders and never reaches outside them; Full Access + THIS COMPUTER still reaches the whole host.

   Drives the real sidecar with a scripted model (one tool call per run):
     1. fenced: shell inside the workspace          -> runs, ZERO permission cards (no-asking survives the fence)
     2. fenced: fs.read of a file outside every project -> a folder-trust card on this watched run; denied -> the secret never reaches the model
     3. fenced: shell with a parent-directory escape -> refused by the workspace floor, no shell card
     4. control, THIS COMPUTER + Full Access: the same outside read -> succeeds with no card (the fence is the only variable) */
'use strict';

const A = require('./_assert.js');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { seedActiveStation } = require('./helpers/station.js');

const SECRET = 'FENCE_SECRET_' + Math.random().toString(36).slice(2);
let nextCall = null;   // { name, args } the model makes on the next run

function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function startMockProvider() {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch (_) {}
        requests.push(body);
        const toolResults = (body.messages || []).filter(m => m && m.role === 'tool');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const usage = { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 };
        if (toolResults.length === 0) {
          const args = { objective: 'probe the reach fence', deliverable: 'the tool result', assumptions: ['none'] };
          sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'brief_1', type: 'function', function: { name: 'brief_proceed', arguments: JSON.stringify(args) } }] } }] });
          sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage });
        } else if (toolResults.length === 1 && nextCall) {
          sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'probe_1', type: 'function', function: { name: nextCall.name, arguments: JSON.stringify(nextCall.args) } }] } }] });
          sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage });
        } else {
          sse(res, { choices: [{ delta: { content: 'done.' } }] });
          sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage });
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}

// one watched /api/run; every card is answered `decision` (default deny). Returns the stream's events.
async function drive(fixture, call, decision) {
  nextCall = call;
  const response = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: 'sk-or-v1-reach-fence-fake', provider: 'openrouter', model: 'test/model',
      agentId: 'forge', streamId: 'reach-fence-' + Date.now(), isTask: true,
      placed: [], messages: [{ role: 'user', content: 'REACH_FENCE probe' }]
    })
  });
  A.eq(response.status, 200, 'real /api/run admitted the probe');
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buf = '', runId = ''; const events = [];
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      events.push(ev);
      if (ev.name === 'agent.run.start') runId = ev.payload.runId;
      if (ev.name === 'permission.prompt') await fixture.json('POST', '/api/consent', { runId, promptId: ev.payload.promptId, decision: decision || 'deny' });
    }
  }
  return events;
}
const prompts = (events) => events.filter(e => e.name === 'permission.prompt');
const probeResult = (events) => events.find(e => e.name === 'agent.tool_result' && e.payload && e.payload.callId === 'probe_1');
const modelSaw = (provider, from) => JSON.stringify(provider.requests.slice(from).flatMap(r => (r.messages || []).filter(m => m && m.role === 'tool')));
const diag = (events) => JSON.stringify(events.filter(e => /permission|tool_result/.test(e.name)).map(e => ({ name: e.name, payload: e.payload })));

async function setAgent(fixture, executionProfile, at) {
  const r = await fixture.json('POST', '/api/roster', {
    updatedAt: at,
    agents: [{ agentId: 'forge', system: 'You are FORGE.', name: 'FORGE', provider: 'openrouter', model: 'test/model', approvalMode: 'full', executionProfile }]
  });
  A.ok(r.body && r.body.ok === true, 'FORGE saved as Full Access + ' + executionProfile);
}

(async () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-fence-outside-'));
  const outsideFile = path.join(outsideDir, 'private.txt');
  fs.writeFileSync(outsideFile, SECRET + '\n');
  const provider = await startMockProvider();
  const fixture = SidecarFixture.create({
    prefix: 'sk-reach-fence-',
    env: {
      SKYNET_OPENROUTER_BASE: provider.baseUrl, STARNET_OPENROUTER_BASE: provider.baseUrl,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-reach-fence-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-reach-fence-fake',
      SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
      SKYNET_CONSENT_TIMEOUT_MS: '3000', STARNET_CONSENT_TIMEOUT_MS: '3000'
    }
  });
  try {
    seedActiveStation(fixture.workspace);
    await fixture.start();
    await setAgent(fixture, 'trusted-project', 100);

    // 1. inside: Full Access keeps its no-asking under the fence
    const inside = await drive(fixture, { name: 'shell_exec', args: { cmd: 'node -e "console.log(\'FENCE_INSIDE_OK\')"' } });
    A.eq(prompts(inside).length, 0, 'fenced Full Access runs a workspace shell command with ZERO cards; events=' + diag(inside));
    A.ok(probeResult(inside) && probeResult(inside).payload.ok === true, 'the inside shell command succeeds; events=' + diag(inside));

    // 2. outside: a file in no approved project asks on this watched run, and the denial keeps the bytes out
    let from = provider.requests.length;
    const outside = await drive(fixture, { name: 'fs_read', args: { path: outsideFile } }, 'deny');
    const cards = prompts(outside);
    A.eq(cards.length, 1, 'the outside read raises exactly one card on a watched run; events=' + diag(outside));
    A.ok(cards.length === 1 && /path\.trust/.test(JSON.stringify(cards[0].payload)), 'that card is the folder-trust ask, not a tool approval: ' + JSON.stringify(cards[0] && cards[0].payload));
    A.ok(probeResult(outside) && probeResult(outside).payload.ok === false, 'the denied outside read fails; events=' + diag(outside));
    A.ok(modelSaw(provider, from).indexOf(SECRET) < 0, 'the outside file\'s bytes never reach the model under the fence');

    // 3. the terminal keeps the workspace floor: a parent-directory escape is refused without a shell card
    from = provider.requests.length;
    const escape = await drive(fixture, { name: 'shell_exec', args: { cmd: 'node ../reach-fence-probe.js' } });
    A.eq(prompts(escape).length, 0, 'the fenced shell escape raises no card (it is refused, never offered); events=' + diag(escape));
    A.ok(probeResult(escape) && probeResult(escape).payload.ok === false, 'the parent-directory shell escape is refused; events=' + diag(escape));
    A.ok(/parent-directory/.test(modelSaw(provider, from)), 'the model is told the workspace floor refused it: ' + modelSaw(provider, from).slice(0, 400));

    // 4. control: THIS COMPUTER + Full Access still reads the same file, with no card
    await setAgent(fixture, 'this-computer', Date.now() + 10000);
    from = provider.requests.length;
    const host = await drive(fixture, { name: 'fs_read', args: { path: outsideFile } });
    A.eq(prompts(host).length, 0, 'THIS COMPUTER + Full Access reads a host file with ZERO cards; events=' + diag(host));
    A.ok(probeResult(host) && probeResult(host).payload.ok === true, 'THIS COMPUTER + Full Access reads the outside file; events=' + diag(host));
    A.ok(modelSaw(provider, from).indexOf(SECRET) >= 0, 'and its bytes reach the model: the fence is the only variable');
  } finally {
    await fixture.dispose();
    await new Promise(resolve => provider.server.close(resolve));
    try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('reach-fence.e2e.test');
})().catch(e => { console.log('FAIL: reach-fence.e2e.test threw — ' + (e && e.stack || e)); process.exit(1); });
