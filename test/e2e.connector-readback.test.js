/* node test/e2e.connector-readback.test.js — real-sidecar proof of the TYPED CONNECTOR READ-BACK (2026-08-22).

   Boots the actual sidecar with a fake MCP server (one WRITE tool, one READ tool that reflects what was written)
   and a fake model that writes once and claims done WITHOUT ever reading. Proves through the real granted Run Now
   path: the HOST performs the fresh read-back itself and the run reaches completed_verified; a contract the world
   does not satisfy sends the model back with the named check and ends incomplete; and a contract that names the
   WRITE tool as its check is refused — the host never executes a mutation as proof. */
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function readJsonBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
  });
}

function startMockMcp() {
  const calls = [], sent = [];
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
        reply({ tools: [
          { name: 'send_message', description: 'Send a message (WRITE)', inputSchema: { type: 'object', required: ['to', 'body'], properties: { to: { type: 'string' }, body: { type: 'string' } } } },
          { name: 'search_messages', description: 'Search sent messages (READ)', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } } }
        ] });
        return;
      }
      if (msg.method === 'tools/call') {
        const a = (msg.params && msg.params.arguments) || {};
        if (msg.params.name === 'send_message') { sent.push(a); reply({ content: [{ type: 'text', text: 'sent to ' + a.to + ' id=msg-' + sent.length }], isError: false }); return; }
        if (msg.params.name === 'search_messages') {
          const hits = sent.filter(m => String(m.body || '').indexOf(String(a.q || '')) >= 0 || String(m.to || '').indexOf(String(a.q || '')) >= 0);
          reply({ content: [{ type: 'text', text: hits.length ? hits.map((m, i) => 'msg-' + (i + 1) + ' to=' + m.to + ' body=' + m.body).join('; ') : 'no messages match ' + a.q }], isError: false }); return;
        }
        reply({ content: [{ type: 'text', text: 'unknown tool' }], isError: true }); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } }));
    });
    server.listen(0, HOST, () => resolve({ server, calls, sent, url: 'http://' + HOST + ':' + server.address().port + '/mcp' }));
  });
}

// the model: send ONCE, then claim done — it never calls the read tool; the HOST must.
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
          if (hasTool && toolResults < 1) {
            const args = { to: 'ops@example.com', body: 'Invoice #42 is ready' };
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
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-readback-e2e-'));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-rb-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-rb-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model'
  };
  const booted = await boot(9260 + (process.pid % 50), env, 20);
  const child = booted.child;
  const B = 'http://' + HOST + ':' + booted.port;
  const reads = () => mcp.calls.filter(c => c.msg && c.msg.method === 'tools/call' && c.msg.params && c.msg.params.name === 'search_messages');
  try {
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const get = (u) => fetch(B + u, { headers: { 'X-StarNet-Token': token, Origin: B } }).then(r => r.json());
    const upsert = await fetch(B + '/api/connectors', { method: 'POST', headers, body: JSON.stringify({ id: 'demo', label: 'Demo MCP', transport: 'http', url: mcp.url, token: 'mcp-secret-token' }) });
    A.eq((await upsert.json()).toolCount, 2, 'both connector tools discovered');

    const routine = async (name, postconditions) => {
      const create = await fetch(B + '/api/cron', { method: 'POST', headers, body: JSON.stringify({ name, prompt: 'send the invoice notice to ops', schedule: 'every 1h', agentId: 'rb-agent', model: 'test/model', provider: 'openrouter', unattendedGrants: ['connectors'], meta: { recipeId: 'custom-recipe-x', postconditions } }) });
      A.eq(create.status, 200, 'created routine ' + name);
      const job = (await create.json()).job;
      A.ok(job.meta && job.meta.postconditions, 'the contract rides the routine meta bag');
      const run = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) });
      const panel = await readNdjson(run);
      const runId = ((panel.find(e => e.name === 'agent.run.start') || {}).payload || {}).runId;
      const rows = await get('/api/runs?agent=rb-agent&runId=' + encodeURIComponent(runId));
      return { panel, row: (rows.runs || [])[0] };
    };

    // ---- 1. MATCH: the model sends once and says done; the HOST reads back and the run is completed_verified ----
    const matchContract = { schemaVersion: 'starnet.task-postconditions.v1', authority: 'commander', requirements: [
      { id: 'sop-1', type: 'connector_readback', connector: 'demo', tool: 'search_messages', args: { q: 'Invoice #42' }, contains: 'Invoice #42 is ready' }
    ] };
    const readsBefore = reads().length;
    const m = await routine('Readback match', matchContract);
    A.ok(m.panel.some(e => e.name === 'agent.tool_call' && e.payload.name === 'mcp__demo__send_message'), 'the model performed the write');
    A.ok(!m.panel.some(e => e.name === 'agent.tool_call' && e.payload.name === 'mcp__demo__search_messages'), 'the model NEVER called the read tool');
    A.ok(reads().length > readsBefore, 'the HOST performed the fresh read-back through the connector');
    const ce = m.row && m.row.completionEvidence;
    A.eq(ce && ce.checks.map(c => c.id + ':' + c.status + ':' + c.code).join(','), 'sop-1:passed:connector_readback_matched', 'the durable row records the matched read-back');
    A.eq(ce && ce.effectVerdict, 'mechanically_verified', 'the connector write was SETTLED by the typed read-back');
    A.eq(ce && ce.completionVerdict, 'completed_verified', 'an external-write workflow reached completed_verified');
    A.ok(ce && ce.effects.some(e => e.tool === 'mcp__demo__send_message' && e.state === 'mechanically_verified'), 'the durable effect row for the write is settled');
    A.eq(ce && ce.contract.requirements[0].connector + '/' + ce.contract.requirements[0].tool, 'demo/search_messages', 'the durable contract names what was read back');

    // ---- 2. MISMATCH: same workflow, a contract the world does not satisfy -> nudge fires, verdict incomplete ----
    const missContract = { schemaVersion: 'starnet.task-postconditions.v1', authority: 'commander', requirements: [
      { id: 'sop-1', type: 'connector_readback', connector: 'demo', tool: 'search_messages', args: { q: 'Invoice #42' }, contains: 'PAID IN FULL' }
    ] };
    const llmBefore = llm.requests.length;
    const x = await routine('Readback mismatch', missContract);
    // the fenced host message, wherever the wire put it (provider.js projectRoles: user-side on a chat wire)
    const nudged = llm.requests.slice(llmBefore).some(r => loopNotes(r.messages, 'acceptance_before_done').some(n => /sop-1 \[connector_readback demo\/search_messages\]: connector_readback_mismatch/.test(n)));
    A.ok(nudged, 'the model was sent back once with the named connector check + mismatch code');
    const ce2 = x.row && x.row.completionEvidence;
    A.eq(ce2 && ce2.checks[0].code, 'connector_readback_mismatch', 'mismatch recorded');
    A.eq(ce2 && ce2.completionVerdict, 'incomplete', 'the run is honestly incomplete');
    A.eq(ce2 && ce2.effectVerdict, 'judgment_required', 'and the write stays unsettled');

    // ---- 3. SAFETY: a contract naming the WRITE tool as its check is refused, never executed ----
    const sentBefore = mcp.sent.length;
    const badContract = { schemaVersion: 'starnet.task-postconditions.v1', authority: 'commander', requirements: [
      { id: 'sop-1', type: 'connector_readback', connector: 'demo', tool: 'send_message', args: { to: 'victim@example.com', body: 'oops' }, contains: 'sent' }
    ] };
    const b = await routine('Readback bad tool', badContract);
    const ce3 = b.row && b.row.completionEvidence;
    A.eq(ce3 && ce3.checks[0].code, 'connector_tool_not_readonly', 'a mutation named as a check is refused with its own code');
    A.ok(!mcp.sent.some(s => s.to === 'victim@example.com'), 'and the host never sent the "check" message');
    A.eq(mcp.sent.length, sentBefore + 1, 'only the model\'s own one legitimate send happened in that run');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mcp.server.close(); } catch (_) {}
    try { llm.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('e2e.connector-readback');
})().catch(e => { console.log('FAIL: e2e.connector-readback threw - ' + (e && e.stack || e)); process.exit(1); });
