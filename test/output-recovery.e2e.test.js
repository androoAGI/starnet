/* node test/output-recovery.e2e.test.js — a real sidecar run must not lose a verified mutation or late command
   receipt when earlier tool output fills the run-wide context allowance. Full output is parked once, mutations
   carry exact read-back receipts, and both artifacts survive a real sidecar restart. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

function startProvider() {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/output-recovery', context_length: 500000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch (_) {}
        requests.push(body);
        const toolResults = (body.messages || []).filter(message => message && message.role === 'tool');
        let call = null; let final = '';
        if (toolResults.length === 0) {
          call = { id: 'brief_1', name: 'brief_proceed', args: { objective: 'prove the late command result survives output pressure', deliverable: 'a verified command receipt', assumptions: ['Use the trusted workspace shell'] } };
        } else if (toolResults.length === 1) {
          call = { id: 'mutate_1', name: 'fs_write', args: { path: 'mutation-receipt.txt', content: 'MUTATION_OK\n' } };
        } else if (toolResults.length === 2) {
          call = { id: 'flood_1', name: 'shell_exec', args: { cmd: (process.platform === 'win32' ? 'type' : 'cat') + ' flood-a.txt' } };
        } else if (toolResults.length === 3) {
          call = { id: 'flood_2', name: 'shell_exec', args: { cmd: (process.platform === 'win32' ? 'type' : 'cat') + ' flood-b.txt' } };
        } else if (toolResults.length === 4) {
          call = { id: 'check_1', name: 'shell_exec', args: { cmd: 'node -e "console.log(\'CHECK_OK\')"' } };
        } else {
          final = 'The check passed from the retained exit receipt.';
        }

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (call) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
        } else {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: final } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
        }
        res.end('data: [DONE]\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}

(async () => {
  const provider = await startProvider();
  const fixture = SidecarFixture.create({
    prefix: 'starnet-output-recovery-',
    timeoutMs: 12000,
    env: {
      SKYNET_OPENROUTER_BASE: provider.baseUrl,
      STARNET_OPENROUTER_BASE: provider.baseUrl,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-output-recovery-fake',
      STARNET_OPENROUTER_KEY: 'sk-or-v1-output-recovery-fake',
      SKYNET_DEFAULT_MODEL: 'test/output-recovery',
      STARNET_DEFAULT_MODEL: 'test/output-recovery',
      // Pin the per-run tool-output budget: the production cap scales with the model's context window
      // (window-blind fake provider => 128k cold-catalog default => ~341KB), which the two 61KB floods
      // could never cross. An explicit env value is absolute, restoring the deterministic 120KB seam.
      SKYNET_MAX_TOOL_BYTES: '120000',
      STARNET_MAX_TOOL_BYTES: '120000'
    }
  });
  try {
    await fixture.start();
    const roster = await fixture.json('POST', '/api/roster', {
      updatedAt: 100,
      agents: [{ agentId: 'receipt', name: 'RECEIPT', system: 'Use tools and report only proven outcomes.', provider: 'openrouter', model: 'test/output-recovery', approvalMode: 'full', executionProfile: 'trusted-project' }]
    });
    A.ok(roster.body && roster.body.ok === true, 'the real sidecar accepts the full-access test agent');
    const agentWorkspace = path.join(fixture.workspace, 'receipt');
    fs.mkdirSync(agentWorkspace, { recursive: true });
    fs.writeFileSync(path.join(agentWorkspace, 'flood-a.txt'), 'A'.repeat(61000), 'utf8');
    fs.writeFileSync(path.join(agentWorkspace, 'flood-b.txt'), 'B'.repeat(61000), 'utf8');

    const response = await fixture.request('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'sk-or-v1-output-recovery-fake', provider: 'openrouter', model: 'test/output-recovery',
        agentId: 'receipt', streamId: 'output-recovery', isTask: true,
        messages: [{ role: 'user', content: 'Write the mutation receipt file, run the two large diagnostics, then run the small final check and report only proven outcomes.' }]
      })
    });
    A.eq(response.status, 200, 'the production /api/run path streams the pressured run');
    const events = (await response.text()).split('\n').map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    A.ok(events.some(event => event.name === 'agent.run.end' && event.payload && event.payload.reason === 'done'), 'the run finishes normally after the cap is reached');

    const last = provider.requests[provider.requests.length - 1] || {};
    const resultMessages = (last.messages || []).filter(message => message && message.role === 'tool');
    const mutation = resultMessages.find(message => message.tool_call_id === 'mutate_1');
    A.ok(mutation, 'the final provider turn receives the workspace mutation result');
    A.ok(/mutation receipt: read-back-verified/.test(mutation.content), 'the mutation is not reported successful until exact read-back verification');
    A.ok(/attempted 12 bytes; written 12; verified 12/.test(mutation.content), 'the live mutation receipt reports exact attempted, written, and verified sizes');
    const mutationPath = path.join(agentWorkspace, 'mutation-receipt.txt');
    A.eq(fs.readFileSync(mutationPath, 'utf8'), 'MUTATION_OK\n', 'independent disk read confirms the exact live mutation bytes');
    const check = resultMessages.find(message => message.tool_call_id === 'check_1');
    A.ok(check, 'the final provider turn receives the late command result');
    const resultLengths = resultMessages.map(message => message.tool_call_id + ':' + String(message.content || '').length).join(',');
    A.ok(/Tool result receipt: exit 0/.test(check.content), 'the late result retains authoritative exit-zero evidence; lengths=' + resultLengths + '; flood=' + String((resultMessages.find(message => message.tool_call_id === 'flood_1') || {}).content).slice(0, 500) + '; got=' + String(check.content).slice(0, 500));
    A.ok(!/tool output omitted/.test(check.content), 'the model no longer receives the generic suppression dead end');
    const match = String(check.content).match(/saved to (\.output\/[A-Za-z0-9_.-]+\.txt)/);
    A.ok(match, 'the receipt exposes a workspace-relative recovery path');
    const saved = match ? fs.readFileSync(path.join(fixture.workspace, 'receipt', match[1]), 'utf8') : '';
    A.ok(/CHECK_OK/.test(saved) && /\[exit 0\]/.test(saved), 'the parked file read-back contains the complete command output and exit line');
    A.ok(new Set((check.content.match(/\.output\/[A-Za-z0-9_.-]+\.txt/g) || [])).size === 1, 'the late result names one stable parked artifact');

    await fixture.restart();
    A.eq(fs.readFileSync(mutationPath, 'utf8'), 'MUTATION_OK\n', 'the read-back-verified workspace mutation survives a real sidecar restart');
    const savedAfterRestart = match ? fs.readFileSync(path.join(fixture.workspace, 'receipt', match[1]), 'utf8') : '';
    A.eq(savedAfterRestart, saved, 'the complete parked output remains byte-identical after restart');
  } finally {
    await fixture.dispose();
    await new Promise(resolve => provider.server.close(resolve));
  }
  A.report('output-recovery.e2e.test');
})().catch(error => { console.log('FAIL: output-recovery.e2e.test threw — ' + (error && error.stack || error)); process.exit(1); });
