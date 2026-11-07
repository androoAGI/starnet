/* node test/context-allowance.e2e.test.js — a long research run must not go blind on the run-wide tool-output budget.

   The bug (user report 2026-11-01): the budget charged bytes the prompt never carried, so it emptied under the fold line.
   From then on every result was a receipt, the prompt stopped growing, the fold that re-arms the budget never fired, a
   14-byte read came back as a 331-character receipt, and reading the file a receipt named parked yet another copy.

   Real sidecar, real /api/run, real tools; the fake provider reports a realistic prompt_tokens. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const MODEL = 'test/context-allowance';
const KEY = 'sk-or-v1-context-allowance-fake';
const FLOOD_LINE = 'research finding lorem ipsum dolor sit amet consectetur adipiscing elit sed do\n';
const PARALLEL_FLOOD = 6;

function startProvider(nextCalls) {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 200000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch (_) {}
        requests.push(body);
        const tools = (body.messages || []).filter(message => message && message.role === 'tool');
        const chars = (body.messages || []).reduce((n, message) => n + JSON.stringify(message).length, 0) + JSON.stringify(body.tools || []).length;
        const promptTokens = Math.ceil(chars / 4);
        const usage = { prompt_tokens: promptTokens, completion_tokens: 4, total_tokens: promptTokens + 4 };
        const calls = tools.length ? nextCalls(tools) : [{ id: 'brief_1', name: 'brief_proceed', args: { objective: 'research', deliverable: 'a report', assumptions: ['none'] } }];
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (calls) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }) + '\n\n');
        } else {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'done' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\n');
        }
        res.end('data: [DONE]\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}

function floodTurn(turn, count) {
  return Array.from({ length: count }, (_, i) => ({ id: 'flood_' + turn + '_' + i, name: 'shell_exec', args: { cmd: (process.platform === 'win32' ? 'type' : 'cat') + ' flood-' + turn + '-' + i + '.txt' } }));
}

async function runScenario(name, env, turns, files, inspect) {
  let step = 0;
  const provider = await startProvider((tools) => {
    const entry = turns[step++];
    return typeof entry === 'function' ? entry(tools) : (entry || null);
  });
  const fixture = SidecarFixture.create({
    prefix: 'starnet-context-allowance-', timeoutMs: 60000,
    env: Object.assign({
      SKYNET_OPENROUTER_BASE: provider.baseUrl, STARNET_OPENROUTER_BASE: provider.baseUrl,
      SKYNET_OPENROUTER_KEY: KEY, STARNET_OPENROUTER_KEY: KEY,
      SKYNET_DEFAULT_MODEL: MODEL, STARNET_DEFAULT_MODEL: MODEL
    }, env)
  });
  try {
    await fixture.start();
    const roster = await fixture.json('POST', '/api/roster', { updatedAt: 100, agents: [{ agentId: 'rs', name: 'RS', system: 'Research.', provider: 'openrouter', model: MODEL, approvalMode: 'full', executionProfile: 'trusted-project' }] });
    A.ok(roster.body && roster.body.ok === true, name + ': the real sidecar accepts the agent');
    const workspace = path.join(fixture.workspace, 'rs');
    fs.mkdirSync(workspace, { recursive: true });
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(workspace, file), text, 'utf8');
    const response = await fixture.request('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: KEY, provider: 'openrouter', model: MODEL, agentId: 'rs', streamId: 'allowance', isTask: true, messages: [{ role: 'user', content: 'Research the flood files.' }] })
    });
    const events = (await response.text()).split('\n').map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    A.ok(events.some(event => event.name === 'agent.run.end' && event.payload && event.payload.reason === 'done'), name + ': the run finishes normally');
    const last = provider.requests[provider.requests.length - 1] || {};
    const results = new Map((last.messages || []).filter(message => message && message.role === 'tool').map(message => [message.tool_call_id, String(message.content || '')]));
    inspect({ results, events, workspace, parkedFiles: () => fs.readdirSync(path.join(workspace, '.output')).length, requests: provider.requests });
  } finally {
    await fixture.dispose();
    await new Promise(resolve => provider.server.close(resolve));
  }
}

function floodFiles(turns) {
  const files = { 'small.txt': 'TINY_FACT\n' };
  for (let t = 0; t < turns; t++) for (let i = 0; i < PARALLEL_FLOOD; i++) files['flood-' + t + '-' + i + '.txt'] = FLOOD_LINE.repeat(1100);
  return files;
}

(async () => {
  // ---- 1. production budget: parallel floods charge 480k a turn but only ~200k reach the prompt. Nothing goes blind ----
  await runScenario('production budget', {}, [
    floodTurn(0, PARALLEL_FLOOD), floodTurn(1, PARALLEL_FLOOD),
    [{ id: 'tiny_early', name: 'fs_read', args: { path: 'small.txt' } }],
    floodTurn(2, PARALLEL_FLOOD),
    [{ id: 'tiny_late', name: 'fs_read', args: { path: 'small.txt' } }]
  ], floodFiles(3), ({ results, events, requests }) => {
    A.ok(requests.every(request => !(request.messages || []).some(message => message.role === 'tool' && /reached its context allowance/.test(String(message.content || '')))), 'no request ever carried a budget receipt while the prompt was under the fold line');
    A.ok(/^TINY_FACT/.test(results.get('tiny_late') || ''), 'a tiny read after three flood turns arrives whole (' + String(results.get('tiny_late')).slice(0, 120) + ')');
    A.ok(events.some(event => event.name === 'agent.compact'), 'the prompt really grew to the fold line and folded');
  });

  // ---- 2. an explicit pin stays absolute, and even an exhausted budget still delivers what a receipt promises ----
  const small = 'TINY_FACT\n';
  let parkedPath = '', parkedBefore = -1;
  await runScenario('pinned budget', { SKYNET_MAX_TOOL_BYTES: '120000', STARNET_MAX_TOOL_BYTES: '120000' }, [
    floodTurn(0, 1), floodTurn(1, 1),
    [{ id: 'tiny', name: 'fs_read', args: { path: 'small.txt' } }],
    (tools) => {
      const receipt = tools.map(tool => String(tool.content || '').match(/saved to (\.output\/\S+?\.txt)/)).filter(Boolean)[0];
      parkedPath = receipt ? receipt[1] : '';
      return [{ id: 'focused', name: 'fs_read', args: { path: parkedPath, offset: 0, limit: 500 } }];
    },
    () => [{ id: 'wide_parked', name: 'fs_read', args: { path: parkedPath, offset: 0, limit: 3000 } }],
    [{ id: 'big_read', name: 'fs_read', args: { path: 'mid.txt' } }],
    [{ id: 'nested', name: 'code_run', args: { code: "const out = await tool('fs.read', { path: 'mid.txt' }); return { nestedChars: String(out).length };" } }]
  ], Object.assign(floodFiles(2), { 'mid.txt': FLOOD_LINE.repeat(70) }), ({ results, workspace, parkedFiles }) => {
    A.ok(/receipt/i.test(results.get('flood_1_0') || '') && /saved to \.output\//.test(results.get('flood_1_0') || ''), 'the pin still clips: the over-budget flood carries a receipt');
    A.eq(results.get('tiny'), small, 'a tiny read on an exhausted budget arrives byte-identical, with no receipt');
    A.ok(parkedPath && results.get('focused').startsWith('research finding'), 'a focused read of the parked file returns its text, not another receipt (' + String(results.get('focused')).slice(0, 120) + ')');
    A.ok(!/saved to/.test(results.get('focused')), 'and names no new file to chase');
    const bigRead = results.get('big_read') || '';
    A.ok(bigRead.startsWith('research finding') && bigRead.length < FLOOD_LINE.length * 70, 'an over-floor read keeps its head and is still clipped');
    A.ok(/Only the first \d+ characters are shown/.test(bigRead), 'and says how much was kept and what size always arrives');
    const wide = results.get('wide_parked') || '';
    A.ok(wide.startsWith('research finding') && /saved file \.output\//.test(wide) && /narrower range/.test(wide), 'an over-floor read of the parked file keeps its head and points back at the same file (' + wide.slice(-300) + ')');
    A.eq((wide.match(/\.output\/[A-Za-z0-9_.-]+\.txt/g) || []).join(','), parkedPath, 'it names only that file');
    A.ok(new RegExp('"?nestedChars"?\\s*:\\s*' + FLOOD_LINE.repeat(70).length).test(results.get('nested') || ''), 'a nested code.run read reaches the child whole, not at the clipped size (' + String(results.get('nested')).slice(0, 160) + ')');
    A.ok(fs.existsSync(path.join(workspace, parkedPath)), 'the parked file named by the receipt exists');
    parkedBefore = parkedFiles();
    A.ok(parkedBefore >= 1, 'the run parked real output (' + parkedBefore + ' files)');
  });

  A.report('context-allowance.e2e.test');
})().catch(error => { console.log('FAIL: context-allowance.e2e.test threw — ' + (error && error.stack || error)); process.exit(1); });
