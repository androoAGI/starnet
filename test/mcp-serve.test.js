/* node test/mcp-serve.test.js — real proof for the StarNet MCP messaging-bridge server.

   Boots the actual sidecar (DEV mode on, temp workspace, mock OpenRouter) on an ephemeral port,
   then spawns sidecar/mcp/serve.js as a child and speaks REAL newline-delimited JSON-RPC 2.0 over
   its stdio: initialize -> tools/list (all 11 tool names) -> tools/call conversations_list ->
   events_poll -> channels_list -> permissions_list_open -> messages_send (dev channel round-trip)
   -> and finally a sidecar-DOWN proof (kill the sidecar; a tool returns a structured start-StarNet
   error while the server itself keeps listing tools).

   The bridge never touches store files: everything above is proxied over loopback HTTP to the
   running sidecar with a token the serve.js child discovers out-of-band by scraping the served page. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const SERVE = path.resolve(__dirname, '..', 'sidecar', 'mcp', 'serve.js');
const EXPECTED_TOOLS = [
  'conversations_list', 'conversation_get', 'messages_read', 'attachments_fetch',
  'events_poll', 'events_wait', 'messages_send', 'channels_list',
  'permissions_list_open', 'permissions_respond'
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- a minimal mock OpenRouter so the DEV inbound run can complete without a real provider ------
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
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Acknowledged, Commander.' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 } }) + '\n\n');
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

// ---- boot the real sidecar (mirrors test/e2e.mcp-connector.test.js) -----------------------------
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
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 12000);
  });
}

// ---- a tiny JSON-RPC-over-stdio client for the serve.js child ----------------------------------
function makeRpcClient(child) {
  let nextId = 0;
  const pending = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg = null; try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg && msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'rpc error'), { code: msg.error.code }));
        else p.resolve(msg.result);
      }
    }
  });
  // serve.js logs to stderr only — surface it on failure for debugging.
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { stderr += d; });
  function request(method, params) {
    const id = ++nextId;
    const line = JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('rpc timeout: ' + method + '\nstderr:\n' + stderr)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(line);
    });
  }
  function notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: method, params: params || {} }) + '\n'); }
  return { request, notify, stderrText: () => stderr };
}

// tools/call returns { content:[{type:'text', text}], isError }. Parse the JSON text payload.
function parseToolResult(result) {
  A.ok(result && Array.isArray(result.content) && result.content[0] && result.content[0].type === 'text', 'tool result carries a text content block');
  return { data: JSON.parse(result.content[0].text), isError: !!result.isError };
}

(async () => {
  const llm = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-mcp-serve-'));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    SKYNET_DEV: '1', STARNET_DEV: '1',
    SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-serve-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-serve-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model'
  };
  let booted = await boot(await allocatePort(), env, 20);
  let sidecar = booted.child;
  const port = booted.port;

  // spawn serve.js WITHOUT a token in env — proving it discovers the token by scraping GET /.
  const serve = spawn(process.execPath, [SERVE, '--host=' + HOST, '--port=' + String(port)], {
    env: Object.assign({}, process.env, { STARNET_TOKEN: '', STARNET_API_TOKEN: '', SKYNET_API_TOKEN: '', STARNET_PORT: '', SKYNET_PORT: '' }),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const rpc = makeRpcClient(serve);

  try {
    // ── initialize ─────────────────────────────────────────────────────────────────────────────
    const init = await rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-harness', version: '0' } });
    A.eq(init.protocolVersion, '2025-06-18', 'server echoes the supported protocol version');
    A.eq(init.serverInfo && init.serverInfo.name, 'starnet-harness', 'serverInfo name is starnet-harness');
    A.ok(init.capabilities && init.capabilities.tools, 'server advertises tools capability');
    A.ok(typeof init.instructions === 'string' && init.instructions.length > 20, 'server ships an instructions string');
    rpc.notify('notifications/initialized');

    // ── tools/list: exactly the ref-compatible 11 ─────────────────────────────────────────────
    const listed = await rpc.request('tools/list', {});
    const names = (listed.tools || []).map(t => t.name).sort();
    A.eq(names.length, 10, 'exactly 10 tools are listed (the reference-harness bridge surface)');
    for (const want of EXPECTED_TOOLS) A.ok(names.indexOf(want) >= 0, 'tool present: ' + want);
    A.ok((listed.tools || []).every(t => t.inputSchema && t.inputSchema.type === 'object'), 'every tool carries an object inputSchema');

    // ── ping ─────────────────────────────────────────────────────────────────────────────────────
    const pong = await rpc.request('ping', {});
    A.ok(pong && typeof pong === 'object', 'ping returns an (empty) result object');

    // ── conversations_list: real proxy to GET /api/runs (empty history is a valid, truthful result) ─
    let r = parseToolResult(await rpc.request('tools/call', { name: 'conversations_list', arguments: { limit: 10 } }));
    A.ok(!r.isError, 'conversations_list is not an error against a live sidecar');
    A.ok(typeof r.data.count === 'number' && Array.isArray(r.data.conversations), 'conversations_list returns { count, conversations[] }');

    // ── channels_list: real proxy to GET /api/channels/status ────────────────────────────────────
    r = parseToolResult(await rpc.request('tools/call', { name: 'channels_list', arguments: {} }));
    A.ok(!r.isError && Array.isArray(r.data.channels), 'channels_list returns a channels array from /api/channels/status');

    // ── permissions_list_open: real proxy to GET /api/state/snapshot .prompts[] ───────────────────
    r = parseToolResult(await rpc.request('tools/call', { name: 'permissions_list_open', arguments: {} }));
    A.ok(!r.isError && typeof r.data.count === 'number' && Array.isArray(r.data.approvals), 'permissions_list_open returns { count, approvals[] } (empty is truthful)');

    // ── messages_send to a real platform target: truthful not-supported (no outbound HTTP route) ──
    r = parseToolResult(await rpc.request('tools/call', { name: 'messages_send', arguments: { target: 'telegram:123', message: 'hi' } }));
    A.ok(r.data.ok === false && r.data.supported === false, 'messages_send to a platform channel is truthfully unsupported, not faked');

    // ── messages_send over the DEV channel: a REAL inbound->run->reply round-trip ─────────────────
    r = parseToolResult(await rpc.request('tools/call', { name: 'messages_send', arguments: { target: 'dev:mcpchat', message: 'ping from mcp bridge' } }));
    A.ok(r.data.ok === true && r.data.delivered === true, 'messages_send over dev channel delivered a real inbound message');
    A.ok(Array.isArray(r.data.replies), 'dev messages_send returns the station replies array');

    // ── events_poll: the SSE-fed queue (the dev run above should have produced station events) ────
    r = parseToolResult(await rpc.request('tools/call', { name: 'events_poll', arguments: { after_cursor: 0, limit: 50 } }));
    A.ok(!r.isError && Array.isArray(r.data.events) && typeof r.data.next_cursor === 'number', 'events_poll returns { events[], next_cursor }');
    A.ok(r.data.events.every(e => typeof e.cursor === 'number' && typeof e.type === 'string'), 'each polled event carries a monotonic cursor + type');

    // ── permissions_respond: malformed id fails truthfully (no consent to answer) ─────────────────
    r = parseToolResult(await rpc.request('tools/call', { name: 'permissions_respond', arguments: { id: 'not-a-real-id', decision: 'deny' } }));
    A.ok(typeof r.data.error === 'string' && /invalid approval id/i.test(r.data.error), 'permissions_respond rejects a malformed id truthfully');
    r = parseToolResult(await rpc.request('tools/call', { name: 'permissions_respond', arguments: { id: 'run|prompt', decision: 'maybe' } }));
    A.ok(typeof r.data.error === 'string' && /invalid decision/i.test(r.data.error), 'permissions_respond rejects an illegal decision');

    // ── sidecar DOWN: the server keeps listing tools; a data tool returns a structured start error ─
    try { sidecar.kill(); } catch (_) {}
    await new Promise(res => sidecar.once('exit', res));
    await sleep(300);
    const stillList = await rpc.request('tools/list', {});
    A.eq((stillList.tools || []).length, 10, 'tools/list still works with the sidecar down (server is independent)');
    r = parseToolResult(await rpc.request('tools/call', { name: 'conversations_list', arguments: {} }));
    A.ok(r.isError === true, 'a data tool marks isError when the sidecar is unreachable');
    A.ok(r.data.sidecarReachable === false && /StarNet/i.test(r.data.error), 'the error tells the operator to start StarNet');

    // ⛔ STATION RESTART: THE SCRAPED TOKEN IS PER-LAUNCH AND GOES STALE. StarNet is a desktop app the
    // Commander closes and reopens; every launch mints a NEW api token. This bridge is spawned once by the MCP
    // client and lives for that whole session, so a token cached for the process lifetime meant the FIRST
    // restart killed every tool with "returned HTTP 401" (and left the SSE feed re-presenting the dead token
    // every 3s) until the user knew to restart their MCP client. Boot a fresh sidecar on the SAME port and
    // prove the very next tool call works with no restart of serve.js.
    // attemptsLeft:0 on purpose — a drifted port would silently invalidate the proof (serve.js is pinned to
    // `port`). Windows can hold the just-closed listener for a moment, so retry the SAME port a few times.
    let restarted = null;
    for (let attempt = 0; attempt < 3 && !restarted; attempt++) {
      try { restarted = await boot(port, env, 0); } catch (e) { restarted = null; await sleep(700); }
    }
    A.ok(restarted && restarted.port === port, 'a fresh sidecar came back up on the same port (fixture guard)');
    if (restarted) {
      sidecar = restarted.child;
      await sleep(400);
      r = parseToolResult(await rpc.request('tools/call', { name: 'conversations_list', arguments: { limit: 5 } }));
      A.ok(!r.isError && !/40[13]/.test(String(r.data.error || '')),
        'THE FIX: after a station restart the bridge re-discovers the new token instead of 401ing forever');
      A.ok(Array.isArray(r.data.conversations), 'the re-authenticated call returns real data');
    }

  } finally {
    try { serve.stdin.end(); } catch (_) {}
    try { serve.kill(); } catch (_) {}
    try { sidecar.kill(); } catch (_) {}
    try { llm.server.close(); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('mcp-serve.test');
})().catch(e => { console.log('FAIL: mcp-serve.test threw - ' + (e && e.stack || e)); process.exit(1); });
