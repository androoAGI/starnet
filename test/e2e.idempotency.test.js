/* node test/e2e.idempotency.test.js — real-sidecar proof of CONNECTOR-WRITE IDEMPOTENCY (SOP lane, 2026-08-21).

   Boots the actual sidecar with a fake MCP HTTP server exposing one WRITE tool (send_message) and a fake
   OpenRouter whose model repeats the SAME write twice in one run (the double-send shape). Proves, through the
   real /api/cron Run Now path with a connector grant:
     · the MCP server receives the write EXACTLY ONCE for that run;
     · the second call is answered from the ledger, visibly (agent.tool_result summary 'idempotent-replay');
     · the ledger is durable on disk under the workspace;
     · a NEW run (new work item) of the same routine sends the write again — the scope is the work item,
       never the station. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
let checkScenario = false;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function readJsonBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
  });
}

function startMockMcp() {
  const calls = [];
  let repaired = false;
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const msg = await readJsonBody(req);
      calls.push({ msg });
      const reply = (result, status) => {
        const headers = { 'Content-Type': 'application/json' };
        if (msg.method === 'initialize') headers['Mcp-Session-Id'] = 'sess-idem';
        res.writeHead(status || 200, headers);
        if ((status || 200) === 202) { res.end(); return; }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'initialize') { reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'demo-mcp' } }); return; }
      if (msg.method === 'notifications/initialized') { reply({}, 202); return; }
      if (msg.method === 'tools/list') {
        reply({ tools: [{
          name: 'send_message', description: 'Send a message (WRITE)',
          inputSchema: { type: 'object', required: ['to', 'body'], properties: { to: { type: 'string' }, body: { type: 'string' } } }
        }, { name: 'run_command', description: 'Execute the project check', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
        { name: 'write_file', description: 'Repair the project', inputSchema: { type: 'object', properties: {} } }] });
        return;
      }
      if (msg.method === 'tools/call') {
        const a = (msg.params && msg.params.arguments) || {};
        if (msg.params.name === 'write_file') { repaired = true; reply({ content: [{ type: 'text', text: 'repaired' }], isError: false }); return; }
        if (msg.params.name === 'run_command') { reply({ content: [{ type: 'text', text: JSON.stringify({ exitCode: repaired ? 0 : 7, stdout: repaired ? 'CHECK-PASS' : 'CHECK-FAIL' }) }], isError: false }); return; }
        reply({ content: [{ type: 'text', text: 'sent to ' + a.to + ' id=msg-' + calls.filter(c => c.msg.method === 'tools/call').length }], isError: false });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } }));
    });
    server.listen(0, HOST, () => resolve({ server, calls, url: 'http://' + HOST + ':' + server.address().port + '/mcp' }));
  });
}

// the model: while fewer than two tool results exist, emit the SAME send_message call; then stop.
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
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          let parsed = {}, msgs = [];
          try { parsed = JSON.parse(body); msgs = parsed.messages || []; } catch (_) {}
          requests.push(parsed);
          const toolResults = msgs.filter(m => m && m.role === 'tool').length;
          const hasTool = (parsed.tools || []).some(t => t && t.function && t.function.name === 'mcp__demo__send_message');
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (checkScenario && toolResults < 3) {
            const name = toolResults === 1 ? 'mcp__demo__write_file' : 'mcp__demo__run_command';
            const args = toolResults === 1 ? {} : { name: 'check' };
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'check_' + toolResults, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          } else if (!checkScenario && hasTool && toolResults < 2) {
            // identical arguments both times — deliberately with a different KEY ORDER the second time, so the
            // proof covers canonical-args hashing and not just string equality.
            const args = toolResults === 0 ? { to: 'ops@example.com', body: 'Invoice #42 is ready' } : { body: 'Invoice #42 is ready', to: 'ops@example.com' };
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'send_' + toolResults, type: 'function', function: { name: 'mcp__demo__send_message', arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          } else {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: hasTool ? 'Message sent.' : 'No connector.' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          }
          res.write('data: [DONE]\n\n');
          res.end();
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
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port), STARNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

async function readNdjson(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) { try { events.push(JSON.parse(line)); } catch (_) {} }
    }
  }
  return events;
}

(async () => {
  const mcp = await startMockMcp();
  const llm = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-idem-e2e-'));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    STARNET_FULL_ACCESS: '1', SKYNET_FULL_ACCESS: '1',
    SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-idem-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-idem-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model'
  };
  const booted = await boot(9140 + (process.pid % 50), env, 20);
  const child = booted.child;
  const B = 'http://' + HOST + ':' + booted.port;
  const writeCalls = () => mcp.calls.filter(c => c.msg && c.msg.method === 'tools/call' && c.msg.params && c.msg.params.name === 'send_message');
  try {
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    const upsert = await fetch(B + '/api/connectors', { method: 'POST', headers, body: JSON.stringify({ id: 'demo', label: 'Demo MCP', transport: 'http', url: mcp.url, token: 'mcp-secret-token' }) });
    A.eq(upsert.status, 200, 'configured the MCP connector');
    A.eq((await upsert.json()).toolCount, 3, 'write and command tools were discovered');

    const create = await fetch(B + '/api/cron', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Send invoice notice', prompt: 'send the invoice notice to ops', schedule: 'every 1h', agentId: 'idem-agent', model: 'test/model', provider: 'openrouter', unattendedGrants: ['connectors'] })
    });
    A.eq(create.status, 200, 'created a connector-granted routine');
    const job = (await create.json()).job;

    // ---- run 1: the model repeats the identical write; the server must see it ONCE ----
    const pressed1 = Date.now();
    const run1 = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) });
    A.eq(run1.status, 200, 'Run Now returns a stream');
    const panel1 = await readNdjson(run1);
    const settled1 = Date.now();
    const calls1 = panel1.filter(e => e.name === 'agent.tool_call' && e.payload && e.payload.name === 'mcp__demo__send_message');
    A.eq(calls1.length, 2, 'the model attempted the write twice in one run');
    const results1 = panel1.filter(e => e.name === 'agent.tool_result' && e.payload && calls1.some(c => c.payload.callId === e.payload.callId));
    A.eq(results1.length, 2, 'both attempts produced a tool result');
    A.ok(results1[0].payload.ok === true && results1[0].payload.summary !== 'idempotent-replay', 'the FIRST write executed for real');
    A.ok(results1[1].payload.ok === true && results1[1].payload.summary === 'idempotent-replay', 'the SECOND identical write was answered from the ledger, visibly');
    A.eq(writeCalls().length, 1, 'the MCP server received the write EXACTLY ONCE (no double-send)');
    A.ok(panel1.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('').indexOf('Message sent.') >= 0, 'the run still completed normally');
    A.ok(panel1.some(e => e.name === 'agent.run.end' && e.payload && e.payload.reason === 'done'), 'run 1 ended done');

    // ---- durability: the ledger is on disk under the workspace ----
    const ledgerFile = path.join(ws, 'connector-writes.ledger.json');
    A.ok(fs.existsSync(ledgerFile), 'the ledger file exists under WORKSPACES');
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    const rows = Object.values(ledger.rows || {});
    A.eq(rows.length, 1, 'exactly one write recorded');
    // Run Now is the scheduled fire pressed by hand (quick win 31, sidecar/routine-identity.js): its work item is the
    // routine + THIS press's fire time, 'cron:<jobId>:<firedAt>', the shape a scheduled tick stamps with its scheduledFor
    // (cron-driver.js). A retried/resumed press dedupes under it; the next press is a new fire time, so a new work item.
    A.ok(rows[0].tool === 'mcp__demo__send_message' && rows[0].connector === 'demo' && rows[0].runId, 'the row names the tool and connector');
    const scope1 = new RegExp('^cron:' + job.id + ':(\\d+)$').exec(String(rows[0].scope || ''));
    A.ok(!!scope1, 'the row\'s work-item scope is the routine + its fire time, as a scheduled tick stamps it (' + rows[0].scope + ')');
    A.ok(!!scope1 && Number(scope1[1]) >= pressed1 && Number(scope1[1]) <= settled1, 'the fire time in the scope is THIS press (' + (scope1 && scope1[1]) + ' in [' + pressed1 + ', ' + settled1 + '])');
    A.ok(String(rows[0].content).indexOf('id=msg-1') >= 0, 'the recorded result is the real first result');
    A.ok(fs.readFileSync(ledgerFile, 'utf8').indexOf('mcp-secret-token') < 0, 'the ledger never carries the connector secret');

    // ---- run 2: a NEW work item of the same routine sends again (scope is the work item, not the station) ----
    const run2 = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) });
    A.eq(run2.status, 200, 'second Run Now returns a stream');
    const panel2 = await readNdjson(run2);
    const results2 = panel2.filter(e => e.name === 'agent.tool_result' && e.payload && e.payload.summary === 'idempotent-replay');
    A.eq(results2.length, 1, 'run 2 again dedupes only its OWN repeat');
    A.eq(writeCalls().length, 2, 'the new work item reached the server once more (2 real sends across 2 runs)');
    const scopes2 = Object.values(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).rows || {}).map(r => String(r.scope || ''));
    A.ok(scopes2.length === 2 && scopes2[0] !== scopes2[1] && scopes2.every(s => s.indexOf('cron:' + job.id + ':') === 0), 'each press recorded its write under its OWN fire-time scope (' + scopes2.join(', ') + ')');
    checkScenario = true;
    const checked = await readNdjson(await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) }));
    const executions = mcp.calls.filter(c => c.msg.method === 'tools/call' && c.msg.params.name === 'run_command');
    if (executions.length !== 2) console.log(JSON.stringify(checked.filter(e => /tool_call|tool_result|run.end/.test(e.name))));
    A.eq(executions.length, 2, 'identical failed-check arguments execute again after repair');
    A.ok(llm.requests.some(request => (request.messages || []).some(message => message.role === 'tool' && /CHECK-PASS/.test(message.content))), 'the model receives the fresh passing check after repair');
    A.eq(JSON.stringify(executions[0]?.msg.params.arguments), JSON.stringify(executions[1]?.msg.params.arguments), 'fresh check needs no argument workaround');
    A.eq(checked.filter(e => e.name === 'agent.tool_result' && e.payload.summary === 'idempotent-replay').length, 0, 'the failed command was not replayed as a successful write');
    A.ok(checked.some(e => e.name === 'agent.run.end' && e.payload.reason === 'done'), 'repair and recheck run completes');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mcp.server.close(); } catch (_) {}
    try { llm.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('e2e.idempotency.test');
})().catch(e => { console.log('FAIL: e2e.idempotency.test threw - ' + (e && e.stack || e)); process.exit(1); });
