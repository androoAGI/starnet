/* node test/e2e.mcp-session-expiry.test.js — REAL sidecar proof for Mcp-Session-Id expiry (GitHub #5 residue).

   Boots the actual sidecar against a fake streamable-HTTP MCP server that assigns a session id on initialize and
   answers any request carrying an EXPIRED session id with HTTP 404 (the spec's "start a new session" signal), plus
   a fake OpenRouter whose model calls the connector tool once per run. Two agents run CONCURRENTLY right after the
   server expires the live session, so both in-flight tools/call requests 404 together.

   Before: each 404 counted toward CALL_FAIL_LIMIT (three idle-expired calls flipped a healthy connector to
   "connector unreachable") and every expired call FAILED for the model. After: the manager re-initializes ONCE
   (shared by both callers) and retries; both tool results succeed and /api/connectors stays `up`. */
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

function readJsonBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
  });
}

/* the fake MCP server: one live session at a time; /ctl {expire:true} retires the live session so the NEXT
   request(s) carrying it 404 until a new initialize hands out a fresh id. */
function startSessionMcp() {
  const stats = { inits: 0, calls: 0, notFound: 0 };
  let live = null, retired = new Set(), seq = 0;
  const expiredRace = [];
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.url === '/ctl' && req.method === 'POST') {
        const b = await readJsonBody(req);
        if (b.expire && live) { retired.add(live); live = null; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, stats }));
        return;
      }
      if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const msg = await readJsonBody(req);
      const sid = req.headers['mcp-session-id'];
      const reply = (result, status, extra) => {
        const headers = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
        res.writeHead(status || 200, headers);
        if ((status || 200) === 202) { res.end(); return; }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'initialize') {
        stats.inits++;
        live = 'sess-' + (++seq);
        reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'session-mcp' } }, 200, { 'Mcp-Session-Id': live });
        return;
      }
      if (!sid || sid !== live) {
        // expired / unknown session: the streamable-HTTP contract says 404 -> the client must re-initialize
        stats.notFound++;
        // Make the recovery race deterministic: both old-session calls leave before either 404,
        // then the second response arrives after the first caller can finish its new handshake.
        if (sid === 'sess-1' && msg.method === 'tools/call') {
          await new Promise(resolve => {
            expiredRace.push(resolve);
            if (expiredRace.length === 2) { expiredRace[0](); setTimeout(expiredRace[1], 250); }
          });
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_not_found' }));
        return;
      }
      if (msg.method === 'notifications/initialized') { reply({}, 202); return; }
      if (msg.method === 'tools/list') {
        reply({ tools: [{ name: 'lookup', description: 'Lookup demo data', annotations: { readOnlyHint: true },
          inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } }] });
        return;
      }
      if (msg.method === 'tools/call') {
        stats.calls++;
        // hold the reply briefly so two concurrent runs' calls genuinely overlap on the wire
        await new Promise(r => setTimeout(r, 150));
        const q = msg.params && msg.params.arguments && msg.params.arguments.query;
        reply({ content: [{ type: 'text', text: 'lookup result for ' + q + ' on ' + sid }], isError: false });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } }));
    });
    server.listen(0, HOST, () => resolve({ server, stats, url: 'http://' + HOST + ':' + server.address().port + '/mcp', ctl: 'http://' + HOST + ':' + server.address().port + '/ctl' }));
  });
}

function startMockOpenRouter() {
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
          const hasToolResult = msgs.some(m => m && m.role === 'tool');
          const hasMcpTool = (parsed.tools || []).some(t => t && t.function && t.function.name === 'mcp__demo__lookup');
          const who = (msgs.find(m => m && m.role === 'user') || {}).content || 'x';
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (!hasToolResult && hasMcpTool) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'mcp_lookup', type: 'function', function: { name: 'mcp__demo__lookup', arguments: JSON.stringify({ query: String(who).slice(0, 24) }) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          } else {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: hasToolResult ? 'MCP answer delivered' : 'no connector tool offered' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          }
          res.write('data: [DONE]\n\n');
          res.end();
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
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port), STARNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port, log: () => out }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

(async () => {
  const mcp = await startSessionMcp();
  const llm = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-mcp-sess-'));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-mcp-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-mcp-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model'
  };
  const booted = await boot(await allocatePort(), env, 20);
  const child = booted.child;
  const B = 'http://' + HOST + ':' + booted.port;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const status = async () => ((await (await fetch(B + '/api/connectors', { headers })).json()).connectors || []).find(c => c.id === 'demo') || null;

    const upsert = await (await fetch(B + '/api/connectors', { method: 'POST', headers,
      body: JSON.stringify({ id: 'demo', label: 'Demo MCP', transport: 'http', url: mcp.url, token: 'mcp-secret-token' }) })).json();
    A.eq(upsert.state, 'up', 'connector connects (session ' + mcp.stats.inits + ')');

    async function drive(who, input, decision) {
      const res = await fetch(B + '/api/run', { method: 'POST', headers,
        body: JSON.stringify({ key: 'sk-or-v1-mcp-fake', model: 'test/model', agentId: who, isTask: true, messages: [{ role: 'user', content: input }] }) });
      const reader = res.body.getReader(); const dec = new TextDecoder();
      let buf = '', runId = '';
      const calls = [], results = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
          if (ev.name === 'agent.run.start') runId = ev.payload.runId;
          if (ev.name === 'agent.tool_call' && ev.payload.name === 'mcp__demo__lookup') calls.push(ev.payload);
          if (ev.name === 'agent.tool_result') results.push(ev.payload);
          if (ev.name === 'permission.prompt') fetch(B + '/api/consent', { method: 'POST', headers, body: JSON.stringify({ runId, promptId: ev.payload.promptId, decision }) }).catch(() => {});
        }
      }
      return { calls, results };
    }

    // warm both agents to Full Access on a live session so the race below is pure connector traffic
    const w1 = await drive('agent-a', 'warm a', 'full');
    const w2 = await drive('agent-b', 'warm b', 'full');
    A.ok(w1.results.some(r => r.ok === true) && w2.results.some(r => r.ok === true), 'both agents can call the connector on a live session');
    const initsBefore = mcp.stats.inits, notFoundBefore = mcp.stats.notFound;

    // ── the race: expire the live session, then two agents call the connector at the same moment ──
    await fetch(mcp.ctl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expire: true }) });
    const [ra, rb] = await Promise.all([drive('agent-a', 'race a', 'full'), drive('agent-b', 'race b', 'full')]);
    A.eq(ra.calls.length, 1, 'agent A made one connector call');
    A.eq(rb.calls.length, 1, 'agent B made one connector call');
    A.ok(ra.results.some(r => r.ok === true), 'agent A call SUCCEEDS across the expired session: ' + JSON.stringify(ra.results.map(r => ({ ok: r.ok, err: r.error || r.detail || '' }))));
    A.ok(rb.results.some(r => r.ok === true), 'agent B call SUCCEEDS across the expired session: ' + JSON.stringify(rb.results));
    A.ok(mcp.stats.notFound - notFoundBefore >= 1, 'the server really answered 404 for the expired session (' + (mcp.stats.notFound - notFoundBefore) + ')');
    A.eq(mcp.stats.inits - initsBefore, 1, 'exactly ONE re-initialize served both concurrent 404s (shared reconnect)');
    let s = await status();
    A.eq(s && s.state, 'up', '/api/connectors stays up after the expired-session race (detail: ' + (s && s.detail) + ')');
    A.eq(s && s.authRequired, false, 'no reauth flag from a session expiry');

    // ── three more expiries in a row: before the fix this was "connector unreachable (3 consecutive call failures)" ──
    for (let i = 0; i < 3; i++) {
      await fetch(mcp.ctl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expire: true }) });
      const r = await drive('agent-a', 'expiry ' + i, 'full');
      A.ok(r.results.some(x => x.ok === true), 'expiry #' + (i + 1) + ' recovered transparently');
    }
    s = await status();
    A.eq(s && s.state, 'up', 'still up after four consecutive session expiries (was: unreachable after three)');
    A.ok(!/unreachable/.test((s && s.detail) || ''), 'never labelled unreachable');
    A.ok(!/connector unreachable/.test(booted.log()), 'the sidecar log never recorded an unreachable flip');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mcp.server.close(); } catch (_) {}
    try { llm.server.close(); } catch (_) {}
  }
  A.report('e2e.mcp-session-expiry');
})().catch(e => { console.error(e); process.exit(1); });
