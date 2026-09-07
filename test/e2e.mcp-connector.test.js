/* node test/e2e.mcp-connector.test.js - real sidecar proof for MCP connectors.

   Boots the actual sidecar with a fake MCP HTTP server and fake OpenRouter.
   Configures the connector through /api/connectors, runs a manual routine, and
   proves the model can call the discovered MCP tool with SSE portal activity. */
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
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const msg = await readJsonBody(req);
      calls.push({ msg, headers: req.headers });
      const reply = (result, status) => {
        const headers = { 'Content-Type': 'application/json' };
        if (msg.method === 'initialize') headers['Mcp-Session-Id'] = 'sess-demo';
        res.writeHead(status || 200, headers);
        if ((status || 200) === 202) { res.end(); return; }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'initialize') {
        reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'demo-mcp' } });
        return;
      }
      if (msg.method === 'notifications/initialized') { reply({}, 202); return; }
      if (msg.method === 'tools/list') {
        reply({ tools: [{
          name: 'lookup',
          description: 'Lookup demo data',
          annotations: { readOnlyHint: true },
          inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } }
        }] });
        return;
      }
      if (msg.method === 'tools/call') {
        const q = msg.params && msg.params.arguments && msg.params.arguments.query;
        reply({ content: [{ type: 'text', text: 'lookup result for ' + q }], isError: false });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } }));
    });
    server.listen(0, HOST, () => resolve({ server, calls, url: 'http://' + HOST + ':' + server.address().port + '/mcp' }));
  });
}

function startMockOpenRouter() {
  const requests = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [
          { id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
          { id: 'test/no-tools', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: [] }
        ] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          let parsed = {}, msgs = [];
          try { parsed = JSON.parse(body); msgs = parsed.messages || []; } catch (_) {}
          const toolResults = msgs.filter(m => m && m.role === 'tool').length;
          const hasToolResult = toolResults > 0;
          const hasMcpTool = (parsed.tools || []).some(t => t && t.function && t.function.name === 'mcp__demo__lookup');
          const hasInspectTool = (parsed.tools || []).some(t => t && t.function && t.function.name === 'station_inspect');
          const wantsInspect = msgs.some(m => m && m.role === 'user' && String(m.content || '').indexOf('SELF_INSPECT') >= 0);
          const messageContent = m => typeof (m && m.content) === 'string' ? m.content : JSON.stringify((m && m.content) || '');
          const hasInspectResult = msgs.some(m => m && m.role === 'tool' && /\"schemaVersion\":1/.test(messageContent(m)) && /\"scheduler\":/.test(messageContent(m)));
          // A conversation carrying this sentinel asks for FOUR connector calls in a row — the shape of the
          // reported repeated-approval bug. Sentinel-gated so every other scenario in this file is untouched.
          const wantsMany = msgs.some(m => m && m.role === 'user' && String(m.content || '').indexOf('FOURLOOKUPS') >= 0);
          requests.push(parsed);

          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (wantsInspect && hasInspectTool && !hasInspectResult) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'station_inspect_1', type: 'function', function: { name: 'station_inspect', arguments: '{}' } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          } else if (wantsInspect && hasInspectResult) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Harness snapshot checked.' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          } else if (wantsMany && hasMcpTool && toolResults < 4) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'mcp_lookup_' + toolResults, type: 'function', function: { name: 'mcp__demo__lookup', arguments: JSON.stringify({ query: 'asset-' + toolResults }) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          } else if (!hasToolResult && hasMcpTool) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'mcp_lookup', type: 'function', function: { name: 'mcp__demo__lookup', arguments: JSON.stringify({ query: 'alpha' }) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          } else if (!hasToolResult) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'MCP unavailable in autonomous run' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          } else {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'MCP answer delivered' } }] }) + '\n\n');
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
    const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/google-future-release.cjs'), INDEX], {
      // This suite deliberately exercises legacy/no-client setup. A locally
      // staged publisher registration must not replace its explicit fixtures.
      // Native Desktop PKCE is covered separately by google-signin.e2e.test.js.
      env: Object.assign({}, process.env, {
        STARNET_GOOGLE_DESKTOP_CLIENT_JSON: '{}',
        STARNET_GOOGLE_OAUTH_CLIENT_ID: '', STARNET_GOOGLE_OAUTH_CLIENT_SECRET: '',
      }, env, { SKYNET_PORT: String(port), STARNET_PORT: String(port) }),
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

async function startSseCollector(url) {
  const ac = new AbortController();
  const events = [];
  const waiters = [];
  const res = await fetch(url, { signal: ac.signal });
  A.eq(res.status, 200, 'SSE feed opens with token');
  const reader = res.body.getReader();
  function notify() {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      try {
        if (w.pred(events)) { waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(events); }
      } catch (e) { waiters.splice(i, 1); clearTimeout(w.timer); w.reject(e); }
    }
  }
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line || line[0] === ':') continue;
          if (line.indexOf('data:') === 0) {
            const raw = line.slice(5).trim();
            try { events.push(JSON.parse(raw)); notify(); } catch (_) {}
          }
        }
      }
    } catch (_) {}
  })();
  return {
    events,
    waitFor(pred, ms, label) {
      if (pred(events)) return Promise.resolve(events);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for ' + label)), ms);
        waiters.push({ pred, resolve, reject, timer });
      });
    },
    close() { try { ac.abort(); } catch (_) {} }
  };
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
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-mcp-e2e-'));
  const env = {
    SKYNET_WORKSPACES: ws,
    STARNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: llm.base,
    STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-mcp-fake',
    STARNET_OPENROUTER_KEY: 'sk-or-v1-mcp-fake',
    SKYNET_DEFAULT_MODEL: 'test/model',
    STARNET_DEFAULT_MODEL: 'test/model'
  };
  let booted = await boot(9020 + (process.pid % 50), env, 20);
  let child = booted.child;
  let port = booted.port;
  let B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    let token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    let headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    // PL-06: a permanently-invalid transport URL is INPUT validation, not a failed connection.
    // It must be rejected before either the config or its bearer token reaches durable storage.
    const invalidSecret = 'mcp-invalid-scheme-secret';
    const invalid = await fetch(B + '/api/connectors', {
      method: 'POST', headers,
      body: JSON.stringify({ id: 'invalid-scheme', label: 'Invalid scheme', transport: 'http', url: 'file:///etc/passwd', token: invalidSecret })
    });
    A.eq(invalid.status, 400, 'non-http(s) connector URL is rejected as bad input');
    const invalidBody = await invalid.json();
    A.ok(invalidBody.ok === false && invalidBody.saved === false && invalidBody.code === 'INVALID_URL', 'invalid URL response explicitly says it was not saved');
    const afterInvalid = await (await fetch(B + '/api/connectors', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.ok(!(afterInvalid.connectors || []).some(c => c.id === 'invalid-scheme'), 'invalid connector is absent from the live/config projection');
    const connectorFile = path.join(ws, 'connectors', 'state.json');
    const invalidDisk = fs.existsSync(connectorFile) ? fs.readFileSync(connectorFile, 'utf8') : '';
    A.ok(invalidDisk.indexOf('invalid-scheme') < 0 && invalidDisk.indexOf(invalidSecret) < 0, 'invalid connector id and secret never reach disk');

    // Custom OAuth is an HTTPS-only HTTP auth mode. Save a deterministic offline target, prove its bearer field is
    // discarded, and prove oauth/start resolves the SAVED id far enough to hit the public-host guard (not catalog-only).
    const insecureOauth = await fetch(B + '/api/connectors', { method: 'POST', headers,
      body: JSON.stringify({ id: 'insecure-oauth', transport: 'http', url: 'http://127.0.0.1:1/mcp', oauth: true, enabled: false }) });
    A.eq(insecureOauth.status, 400, 'custom OAuth refuses an http:// endpoint even when ordinary localhost HTTP is allowed');
    A.eq((await insecureOauth.json()).code, 'OAUTH_HTTPS_REQUIRED', 'custom OAuth HTTPS refusal is a stable input error');
    const oauthCanary = 'custom-oauth-bearer-must-not-persist';
    const customOauth = await fetch(B + '/api/connectors', { method: 'POST', headers,
      body: JSON.stringify({ id: 'custom-oauth', label: 'Custom OAuth', transport: 'http', url: 'https://crew.example.invalid/api/mcp', oauth: true, token: oauthCanary, enabled: false }) });
    A.eq(customOauth.status, 200, 'saved a custom HTTPS OAuth connector through the normal upsert route');
    const oauthList = await (await fetch(B + '/api/connectors', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    const oauthRow = (oauthList.connectors || []).find(c => c.id === 'custom-oauth');
    A.ok(oauthRow && oauthRow.oauth === true && oauthRow.oauthAuthorized === false, 'status distinguishes configured OAuth from a stored grant');
    const customStart = await fetch(B + '/api/connectors/oauth/start', { method: 'POST', headers,
      body: JSON.stringify({ id: 'custom-oauth', attemptId: 'custom-oauth-guard-proof' }) });
    A.eq(customStart.status, 502, 'saved custom OAuth id reaches guarded discovery instead of catalog-only rejection');
    const customStartBody = await customStart.json();
    A.ok(!/unknown catalog connector/i.test(customStartBody.error || '') && /ENOTFOUND|metadata/i.test(customStartBody.error || ''),
      'custom OAuth discovery reports the guarded target failure, not an unknown-catalog error');
    const oauthDisk = fs.readFileSync(connectorFile, 'utf8');
    A.ok(oauthDisk.indexOf(oauthCanary) < 0 && /"oauth"\s*:\s*true/.test(oauthDisk), 'OAuth config persists its mode but never the submitted bearer canary');

    // A syntactically-valid endpoint may simply be offline. Saving that configuration is useful, but the
    // response must state BOTH facts so the panel never turns a successful save into an ambiguous 502.
    const unreachable = await fetch(B + '/api/connectors', {
      method: 'POST', headers,
      body: JSON.stringify({ id: 'offline-demo', label: 'Offline demo', transport: 'http', url: 'http://127.0.0.1:1/mcp', token: 'offline-secret', timeoutMs: 1000 })
    });
    A.eq(unreachable.status, 200, 'valid but unreachable connector returns a saved-state envelope');
    const unreachableBody = await unreachable.json();
    A.ok(unreachableBody.ok === false && unreachableBody.saved === true && unreachableBody.connected === false && unreachableBody.state === 'error', 'offline envelope distinguishes saved from connected');
    A.ok(/saved.*not connected/i.test(unreachableBody.error || ''), 'offline envelope explains saved-but-not-connected in plain language');

    const upsert = await fetch(B + '/api/connectors', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'demo', label: 'Demo MCP', transport: 'http', url: mcp.url, token: 'mcp-secret-token' })
    });
    A.eq(upsert.status, 200, 'configured MCP connector');
    const configured = await upsert.json();
    A.eq(configured.state, 'up', 'connector state is up');
    A.eq(configured.toolCount, 1, 'one MCP tool discovered');
    A.eq(configured.status.hasToken, true, 'connector status reports token presence');
    A.eq('token' in configured.status, false, 'connector status does not leak token value');

    const listed = await (await fetch(B + '/api/connectors', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.ok((listed.connectors || []).some(c => c.id === 'demo' && c.tools && c.tools.indexOf('lookup') >= 0), '/api/connectors lists the discovered MCP tool');

    // HARNESS SELF-KNOWLEDGE: plant all three mutable sources, then make a REAL /api/run call the
    // always-present station.inspect tool. The returned bytes must agree with the same live stores the
    // APIs above use — not a prompt summary or scripted fixture inside the tool.
    const cronCreate = await fetch(B + '/api/cron', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Inspect proof', prompt: 'report station health', schedule: 'every 1h', agentId: 'mcp-agent', model: 'test/model', provider: 'openrouter' })
    });
    A.eq(cronCreate.status, 200, 'planted one real routine for station.inspect');
    const failedRun = await fetch(B + '/api/run', {
      method: 'POST', headers,
      body: JSON.stringify({ key: 'sk-or-v1-mcp-fake', model: 'test/no-tools', agentId: 'inspect-agent', streamId: 'inspect-fail', isTask: true, messages: [{ role: 'user', content: 'plant one diagnostic failure' }] })
    });
    await failedRun.text();
    const inspectRun = await fetch(B + '/api/run', {
      method: 'POST', headers,
      body: JSON.stringify({ key: 'sk-or-v1-mcp-fake', model: 'test/model', agentId: 'inspect-agent', streamId: 'inspect-live', isTask: true, messages: [{ role: 'user', content: 'SELF_INSPECT the harness; do not guess' }] })
    });
    A.eq(inspectRun.status, 200, 'real run admitted the self-inspection request');
    await readNdjson(inspectRun);
    const inspectRequest = llm.requests.find(r => (r.messages || []).some(m => m && m.role === 'tool' && /\"schemaVersion\":1/.test(String(m.content || '')) && /\"scheduler\":/.test(String(m.content || ''))));
    const inspectAdvertised = llm.requests.filter(r => (r.messages || []).some(m => m && m.role === 'user' && String(m.content || '').indexOf('SELF_INSPECT') >= 0))
      .flatMap(r => (r.tools || []).map(t => t && t.function && t.function.name).filter(Boolean));
    const inspectTrace = llm.requests.filter(r => (r.messages || []).some(m => m && m.role === 'user' && String(m.content || '').indexOf('SELF_INSPECT') >= 0))
      .map(r => (r.messages || []).map(m => ({ role: m.role, name: m.name || '', calls: (m.tool_calls || []).map(c => c && c.function && c.function.name), content: String(m.content || '').slice(0, 120) })));
    A.ok(!!inspectRequest, 'the model received station.inspect and called it through the real wire-name boundary (advertised: ' + inspectAdvertised.join(',') + '; trace: ' + JSON.stringify(inspectTrace) + ')');
    A.ok(llm.requests.some(r => (r.tools || []).some(t => t && t.function && t.function.name === 'station_inspect')),
      'station.inspect is advertised under its provider-legal wire name');
    const inspectToolMessage = ((inspectRequest && inspectRequest.messages) || []).find(m => m && m.role === 'tool' && /\"scheduler\":/.test(String(m.content || '')));
    const inspectSnapshot = JSON.parse((inspectToolMessage && inspectToolMessage.content) || '{}');
    A.eq(inspectSnapshot.scheduler.status, 'confirmed', 'scheduler section is confirmed');
    A.eq(inspectSnapshot.scheduler.data.jobCount, 1, 'station.inspect saw the planted real routine');
    A.ok(inspectSnapshot.connectors.data.connected.some(c => c.id === 'demo' && c.state === 'up'), 'station.inspect saw the planted live MCP connector');
    A.ok(inspectSnapshot.diagnostics.data.errorCount >= 1, 'station.inspect saw the planted recorded provider error');
    A.ok(inspectSnapshot.diagnostics.data.recentErrors.some(e => /does not support tool calls/.test(e.message)), 'the planted error detail reached the bounded diagnostic tail');
    A.eq(inspectSnapshot.build.status, 'confirmed', 'the exact build section is confirmed from the version authority');
    A.eq(inspectSnapshot.runtime.data.agentId, 'inspect-agent', 'the snapshot identifies the live inspecting agent');

    // ── connector CATALOG (GET /api/connectors/catalog): the curated one-click browse route ──
    const catRes = await fetch(B + '/api/connectors/catalog', { headers: { 'X-StarNet-Token': token, Origin: B } });
    A.eq(catRes.status, 200, 'catalog route responds 200');
    const cat = await catRes.json();
    A.ok(Array.isArray(cat.groups) && cat.groups.length >= 1, 'catalog returns category groups');
    A.ok(Array.isArray(cat.connectors) && cat.connectors.length >= 10, 'catalog returns the seed connectors');
    const dw = cat.connectors.find(c => c.id === 'deepwiki');
    const notion = cat.connectors.find(c => c.id === 'notion');
    const gmail = cat.connectors.find(c => c.id === 'gmail');
    A.ok(dw && dw.installable === true, 'a no-auth connector (deepwiki) is installable today');
    A.ok(notion && notion.installable === false, 'an oauth connector (notion) is listed but NOT installable yet');
    A.ok(gmail && gmail.url === 'https://gmail.googleapis.com/gmail/v1/users/me' && gmail.needsClient === true, 'direct Gmail is listed and truthfully needs one-time OAuth client setup');
    A.ok(cat.connectors.every(c => !('token' in c)), 'catalog entries never carry a token');
    A.ok(cat.connectors.every(c => c.installed === false), 'nothing marked installed before we add a catalog id');

    // Google has fixed OAuth endpoints but no dynamic client registration. Before setup the start route must
    // fail fast and truthfully; saving the ONE shared Web client then unlocks every Google product card.
    const googleBeforeSetup = await fetch(B + '/api/connectors/oauth/start', {
      method: 'POST', headers, body: JSON.stringify({ id: 'gmail', attemptId: 'google-before-setup' })
    });
    A.eq(googleBeforeSetup.status, 503, 'direct Google sign-in refuses before the one-time app client exists');
    const googleBeforeBody = await googleBeforeSetup.json();
    A.ok(googleBeforeBody.signInAvailable === false && googleBeforeBody.code === 'google_signin_unavailable', 'unconfigured builds assign setup responsibility to StarNet, not the customer');

    const googleMissingSecret = await fetch(B + '/api/connectors/oauth/client', {
      method: 'POST', headers, body: JSON.stringify({ id: 'gmail', clientId: 'fake-client.apps.googleusercontent.com' })
    });
    A.eq(googleMissingSecret.status, 400, 'Google Web client setup requires its client secret');
    A.ok(/client secret/i.test((await googleMissingSecret.json()).error || ''), 'missing Google secret receives actionable guidance');
    const googleWrongEntry = await fetch(B + '/api/connectors/oauth/client', {
      method: 'POST', headers, body: JSON.stringify({ id: 'notion', clientId: 'fake-client.apps.googleusercontent.com', clientSecret: 'fake-google-secret' })
    });
    A.eq(googleWrongEntry.status, 400, 'the static-client route cannot overwrite a DCR connector client');

    const googleClientId = 'fake-client.apps.googleusercontent.com';
    const googleClientSecret = 'fake-google-client-secret';
    const googleSave = await fetch(B + '/api/connectors/oauth/client', {
      method: 'POST', headers, body: JSON.stringify({ id: 'gmail', clientId: googleClientId, clientSecret: googleClientSecret })
    });
    A.eq(googleSave.status, 200, 'Google Web client saves through the protected connector state');
    const googleSaveBody = await googleSave.json();
    A.ok(googleSaveBody.ok === true && googleSaveBody.saved === true && googleSaveBody.authorizationServer === 'https://accounts.google.com', 'Google client save returns only non-secret state');
    A.ok(JSON.stringify(googleSaveBody).indexOf(googleClientId) < 0 && JSON.stringify(googleSaveBody).indexOf(googleClientSecret) < 0, 'Google client save never echoes either credential');

    const catWithGoogle = await (await fetch(B + '/api/connectors/catalog', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    const googleCards = catWithGoogle.connectors.filter(c => ['gmail', 'google-drive', 'google-calendar', 'google-docs', 'google-sheets'].indexOf(c.id) >= 0);
    A.eq(googleCards.length, 5, 'catalog exposes the five direct Google product cards exactly once');
    A.ok(googleCards.every(c => c.needsClient === false), 'one saved Google client unlocks SIGN IN for every Google card');
    A.ok(JSON.stringify(catWithGoogle).indexOf(googleClientId) < 0 && JSON.stringify(catWithGoogle).indexOf(googleClientSecret) < 0, 'catalog never leaks the saved Google OAuth client');

    const googleStart = await fetch(B + '/api/connectors/oauth/start', {
      method: 'POST', headers, body: JSON.stringify({ id: 'gmail', attemptId: 'google-ready-start' })
    });
    A.eq(googleStart.status, 200, 'direct Gmail OAuth starts after client setup without a Zapier detour');
    const googleStartBody = await googleStart.json();
    const googleAuth = new URL(googleStartBody.url);
    A.eq(googleAuth.origin + googleAuth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth', 'direct Gmail opens Google authorization');
    A.eq(googleAuth.searchParams.get('client_id'), googleClientId, 'Google authorization uses the saved client id');
    A.eq(googleAuth.searchParams.get('redirect_uri'), B + '/api/connectors/oauth/callback', 'Google authorization uses the exact live sidecar callback');
    A.eq(googleAuth.searchParams.get('access_type'), 'offline', 'Google authorization requests durable offline access');
    A.eq(googleAuth.searchParams.get('prompt'), 'consent select_account', 'Google authorization requests refresh-token consent and explicit account selection');
    A.ok(/gmail\.readonly/.test(googleAuth.searchParams.get('scope') || '') && /gmail\.compose/.test(googleAuth.searchParams.get('scope') || ''), 'Google authorization requests the Gmail read + draft scopes');
    A.ok(!googleAuth.searchParams.has('resource'), 'Google authorization omits the RFC 8707 resource parameter its endpoint does not use');
    A.ok(googleAuth.searchParams.get('state') && googleAuth.searchParams.get('code_challenge_method') === 'S256', 'Google authorization carries CSRF state and PKCE S256');
    // installing a connector whose id AND url match a catalog entry flips `installed`. Use the entry's REAL url +
    // enabled:false so no network connect happens; the config still records id+url for the cross-ref.
    const dwUrl = (cat.connectors.find(c => c.id === 'deepwiki') || {}).url;
    const addDw = await fetch(B + '/api/connectors', { method: 'POST', headers, body: JSON.stringify({ id: 'deepwiki', label: 'DeepWiki', transport: 'http', url: dwUrl, enabled: false }) });
    A.eq(addDw.status, 200, 'installed a connector by a catalog id+url');
    const cat2 = await (await fetch(B + '/api/connectors/catalog', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.eq((cat2.connectors.find(c => c.id === 'deepwiki') || {}).installed, true, 'catalog marks deepwiki installed after adding its real url (id+url cross-ref)');
    // TRUTHFUL TELEMETRY: a connector that reuses a catalog id but points at a FOREIGN url must NOT flip the vendor card
    await fetch(B + '/api/connectors', { method: 'POST', headers, body: JSON.stringify({ id: 'stripe', label: 'not stripe', transport: 'http', url: 'https://mcp.example.invalid/mcp', enabled: false }) });
    const cat3 = await (await fetch(B + '/api/connectors/catalog', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.eq((cat3.connectors.find(c => c.id === 'stripe') || {}).installed, false, 'a foreign-url id collision does NOT mark the vetted vendor card installed');

    // EL-3 PU-02: disabled connectors are durable MANAGEMENT state. They must remain visible after
    // restart even though they are deliberately absent from the live runtime/tool projection.
    // Before the fix, boot skips disabled configs and GET /api/connectors lists manager state only,
    // so both rows vanish while their config (and possible secret) remains on disk.
    try { child.kill(); } catch (_) {}
    await new Promise(resolve => child.once('exit', resolve));
    booted = await boot(port, env, 20);
    child = booted.child;
    port = booted.port;
    B = 'http://' + HOST + ':' + port;
    token = await bootToken(B, B);
    headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    let afterRestart = { connectors: [] };
    for (let i = 0; i < 50; i++) {
      afterRestart = await (await fetch(B + '/api/connectors', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      if ((afterRestart.connectors || []).some(c => c.id === 'demo' && c.state === 'up')) break;
      await sleep(100);
    }
    const restartedDemo = (afterRestart.connectors || []).find(c => c.id === 'demo');
    const restartedDeepwiki = (afterRestart.connectors || []).find(c => c.id === 'deepwiki');
    const restartedStripe = (afterRestart.connectors || []).find(c => c.id === 'stripe');
    const restartedOffline = (afterRestart.connectors || []).find(c => c.id === 'offline-demo');
    const restartedOauth = (afterRestart.connectors || []).find(c => c.id === 'custom-oauth');
    A.ok(restartedDemo && restartedDemo.state === 'up', 'enabled connector rewarms after restart');
    A.ok(restartedDeepwiki && restartedDeepwiki.enabled === false, 'disabled catalog connector remains listed after restart');
    A.ok(restartedStripe && restartedStripe.enabled === false, 'disabled manual connector remains listed after restart');
    A.ok(restartedOffline && restartedOffline.enabled === true && restartedOffline.state === 'error' && restartedOffline.hasToken === true, 'valid offline connector remains durably saved and truthfully offline after restart');
    A.ok(restartedOauth && restartedOauth.enabled === false && restartedOauth.oauth === true && restartedOauth.oauthAuthorized === false,
      'unsigned custom OAuth config survives restart without claiming an authorization grant');
    A.ok(!(afterRestart.connectors || []).some(c => c.id === 'invalid-scheme'), 'invalid-scheme connector remains absent after restart');
    A.ok(JSON.stringify(afterRestart).indexOf('mcp-secret-token') === -1, 'restart list never leaks a persisted connector token');
    A.ok(JSON.stringify(afterRestart).indexOf(invalidSecret) === -1, 'restart projection never contains the rejected secret');
    const restartDisk = fs.existsSync(connectorFile) ? fs.readFileSync(connectorFile, 'utf8') : '';
    A.ok(restartDisk.indexOf('invalid-scheme') < 0 && restartDisk.indexOf(invalidSecret) < 0, 'restart readback proves invalid connector and token were never persisted');
    const restartCatalog = await (await fetch(B + '/api/connectors/catalog', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    const restartedGoogle = restartCatalog.connectors.filter(c => ['gmail', 'google-drive', 'google-calendar', 'google-docs', 'google-sheets'].indexOf(c.id) >= 0);
    A.ok(restartedGoogle.length === 5 && restartedGoogle.every(c => c.needsClient === false), 'Google OAuth client survives sidecar restart and keeps every direct card sign-in-able');
    A.ok(restartDisk.indexOf(googleClientId) >= 0 && restartDisk.indexOf(googleClientSecret) >= 0, 'restart reads the exact protected Google client credentials from durable connector state');
    A.ok(JSON.stringify(restartCatalog).indexOf(googleClientId) < 0 && JSON.stringify(restartCatalog).indexOf(googleClientSecret) < 0, 'restart catalog still exposes no Google client credential');

    sse = await startSseCollector(B + '/api/channels/events?token=' + encodeURIComponent(token));
    const create = await fetch(B + '/api/cron', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'MCP proof', prompt: 'use the demo connector lookup for alpha', schedule: 'every 1h', agentId: 'mcp-agent', model: 'test/model', provider: 'openrouter' })
    });
    A.eq(create.status, 200, 'created MCP proof routine');
    const job = (await create.json()).job;

    const run = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) });
    A.eq(run.status, 200, 'Run Now returns a stream');
    const panel = await readNdjson(run);
    A.ok(!panel.some(e => e.name === 'agent.tool_call' && e.payload && e.payload.name === 'mcp__demo__lookup'), 'autonomous panel stream never calls an unknown external tool');
    A.ok(panel.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('').indexOf('MCP unavailable in autonomous run') >= 0, 'panel stream truthfully completes without MCP authority');
    A.ok(!mcp.calls.some(c => c.msg && c.msg.method === 'tools/call'), 'autonomous run never reaches the MCP server tool endpoint');
    A.ok(mcp.calls.some(c => c.headers && c.headers.authorization === 'Bearer mcp-secret-token'), 'MCP transport sent bearer token to the configured connector');
    const autonomousRequests = llm.requests.filter(r => (r.messages || []).some(m => m && m.role === 'user' && String(m.content || '').indexOf('use the demo connector lookup for alpha') >= 0));
    A.ok(autonomousRequests.length > 0 && autonomousRequests.every(r => !(r.tools || []).some(t => t.function && t.function.name === 'mcp__demo__lookup')), 'autonomous model request does not expose the unknown MCP tool');

    await sse.waitFor(events => events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.agentId === 'mcp-agent'), 5000, 'SSE run end');

    /* UNATTENDED CONNECTOR GRANT (2026-07-25) — the SAME routine shape, but the Commander ticked "let this
       routine use your connected tools". Everything above proves the ungranted default is unchanged; this
       proves the grant actually reaches the real MCP server, end to end, with nobody watching. */
    const mcpCallsBefore = mcp.calls.filter(c => c.msg && c.msg.method === 'tools/call').length;
    const grantedCreate = await fetch(B + '/api/cron', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'MCP granted', prompt: 'use the demo connector lookup for alpha', schedule: 'every 1h', agentId: 'mcp-agent', model: 'test/model', provider: 'openrouter', unattendedGrants: ['connectors'] })
    });
    A.eq(grantedCreate.status, 200, 'created a connector-granted routine');
    const grantedJob = (await grantedCreate.json()).job;
    A.ok(grantedJob.unattendedGrants.indexOf('connectors') >= 0, 'the connector grant persisted on the job');

    const grantedRun = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: grantedJob.id }) });
    A.eq(grantedRun.status, 200, 'granted Run Now returns a stream');
    const grantedPanel = await readNdjson(grantedRun);
    const grantedCall = grantedPanel.find(e => e.name === 'agent.tool_call' && e.payload && e.payload.name === 'mcp__demo__lookup');
    A.ok(grantedCall, 'a GRANTED unattended run calls the MCP tool');
    const grantedResult = grantedPanel.find(e => e.name === 'agent.tool_result' && e.payload && e.payload.callId === (grantedCall && grantedCall.payload.callId));
    A.ok(grantedResult && grantedResult.payload.ok === true, 'the MCP call SUCCEEDS (not withheld, not consent-denied)');
    A.ok(mcp.calls.filter(c => c.msg && c.msg.method === 'tools/call').length > mcpCallsBefore, 'the granted run genuinely reached the MCP server tool endpoint');
    A.ok(grantedPanel.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('').indexOf('MCP answer delivered') >= 0, 'the granted run completes using the MCP answer');
    // the grant is per-ROUTINE: the earlier ungranted job must still be refused if fired again.
    const reRun = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) });
    const rePanel = await readNdjson(reRun);
    A.ok(!rePanel.some(e => e.name === 'agent.tool_call' && e.payload && e.payload.name === 'mcp__demo__lookup'),
      'the UNGRANTED routine is still refused after a granted one ran (the grant never leaks between routines)');

    /* ── THE WATCHED SURFACE: one popup, not one per call (repeated-approval fix, 2026-07-27) ──────────────
       Reported live: an agent doing four `get_draft_asset` reads asked for approval four times while the user
       kept clicking "Full access". Cause: the host-authority layer prompted per call and collapsed
       once/always/full to a boolean, so the grade was never recorded and the consent broker was skipped
       entirely. This drives the real /api/run stream and answers over the real POST /api/consent. */
    async function driveWatched(who, input, decision) {
      const res = await fetch(B + '/api/run', {
        method: 'POST', headers,
        // isTask:true is what makes the run advertise tools at all; the connector portal itself is
        // account-level, so composeOffice rides it onto the interactive office without a `placed` entry.
        body: JSON.stringify({ key: 'sk-or-v1-mcp-fake', model: 'test/model', agentId: who, isTask: true, messages: [{ role: 'user', content: input }] })
      });
      A.eq(res.status, 200, 'watched /api/run returns a stream');
      const reader = res.body.getReader(); const dec = new TextDecoder();
      let buf = '', runId = '';
      const prompts = [], calls = [], results = [];
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
          if (ev.name === 'permission.prompt') {
            prompts.push(ev.payload);
            fetch(B + '/api/consent', { method: 'POST', headers, body: JSON.stringify({ runId, promptId: ev.payload.promptId, decision }) }).catch(() => {});
          }
        }
      }
      return { prompts, calls, results };
    }

    // Full Access is the durable zero-prompt posture. The first call asks because this agent starts in ASK mode;
    // the answer is persisted before the tool resumes, so later calls — including post-taint calls — never ask.
    const full = await driveWatched('mcp-agent', 'FOURLOOKUPS please read four theme assets', 'full');
    A.eq(full.calls.length, 4, 'the watched run made four connector tool calls');
    A.eq(full.prompts.length, 1, 'Full Access raises exactly one prompt — the card where it was selected');
    A.eq(full.prompts[0].tool, 'mcp__demo__lookup', 'the approval names the connector tool');
    A.eq(full.results.filter(r => r.ok === true).length, 4, 'all four connector calls succeeded with no post-taint re-prompts');

    // A later watched run is entirely zero-prompt; the supplied deny answer is never needed or sent.
    const again = await driveWatched('mcp-agent', 'FOURLOOKUPS read them again', 'deny');
    A.eq(again.calls.length, 4, 'the follow-up run made four connector calls');
    A.eq(again.prompts.length, 0, 'a Full Access agent emits ZERO prompts on the follow-up run');
    A.eq(again.results.filter(r => r.ok === true).length, 4, 'all follow-up connector calls succeed');

    const rosterFile = path.join(ws, 'agent.roster.json');
    const fullRoster = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    A.eq(((fullRoster.agents || []).find(a => a.agentId === 'mcp-agent') || {}).approvalMode, 'full',
      'the permission-card answer persists the canonical per-agent approvalMode:full');

    // Full Access follows the AGENT across surfaces: its unattended routine also runs without a prompt.
    const unattendedBefore = mcp.calls.filter(c => c.msg && c.msg.method === 'tools/call').length;
    const unattendedAfterFull = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) });
    const unattendedAfterFullPanel = await readNdjson(unattendedAfterFull);
    A.ok(unattendedAfterFullPanel.some(e => e.name === 'agent.tool_call' && e.payload && e.payload.name === 'mcp__demo__lookup'),
      'Full Access authorizes the same agent\'s unattended routine');
    A.ok(mcp.calls.filter(c => c.msg && c.msg.method === 'tools/call').length > unattendedBefore,
      'the unattended Full Access routine reaches the real connector endpoint');

    // Revocation uses the same canonical roster setting — no hidden wildcard or second authority exists.
    const askAgents = (fullRoster.agents || []).map(a => a.agentId === 'mcp-agent' ? Object.assign({}, a, { approvalMode: 'ask' }) : a);
    const revokeFullRes = await fetch(B + '/api/roster', {
      method: 'POST', headers, body: JSON.stringify({ agents: askAgents, updatedAt: Date.now() + 1000 })
    });
    const revokeFull = await revokeFullRes.json();
    A.ok(revokeFullRes.status === 200 && revokeFull.ok === true, 'setting canonical approvalMode:ask revokes Full Access');
    const afterRevoke = await driveWatched('mcp-agent', 'FOURLOOKUPS after revoke', 'deny');
    A.ok(afterRevoke.prompts.length >= 1, 'the same watched agent is asked again after REVOKE');
    A.eq(afterRevoke.results.filter(r => r.ok === true).length, 0, 'a denied post-revoke run performs no connector action');

    // A DENY still refuses — the fix records a yes, it never invents one. Fresh agent: no blanket in play.
    const denied = await driveWatched('mcp-agent-deny', 'FOURLOOKUPS deny this one', 'deny');
    A.ok(denied.prompts.length >= 1, 'an ungranted agent is still asked');
    A.eq(denied.results.filter(r => r.ok === true).length, 0, 'no denied connector call ever performed an action');
    A.ok(denied.results.some(r => r.ok === false), 'the denied connector call comes back as a refusal');

    /* "Always" remains visible and revocable for a clean run's first call. It cannot suppress fresh prompts
       after connector-authored content enters context. Runs last: it persists globally. */
    const alwaysRun = await driveWatched('mcp-agent-always', 'FOURLOOKUPS read the four assets again', 'always');
    A.eq(alwaysRun.calls.length, 4, 'the "always" run also made four connector calls');
    A.eq(alwaysRun.prompts.length, 4, '"Always" cannot suppress fresh post-content confirmations');
    A.eq(alwaysRun.results.filter(r => r.ok === true).length, 4, 'all four calls succeeded after exact confirmations');
    const perms = await (await fetch(B + '/api/permissions', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.ok(JSON.stringify(perms).indexOf('mcp:demo') >= 0, 'the "Always" grant is visible in the Permissions panel, so it can be revoked');

    const remove = await fetch(B + '/api/connectors/remove', { method: 'POST', headers, body: JSON.stringify({ id: 'demo' }) });
    const removed = await remove.json();
    A.ok(remove.status === 200 && removed.saved === true && removed.removed === true, 'connector removal returns one verified durable result');
    const removedDisk = JSON.parse(fs.readFileSync(connectorFile, 'utf8'));
    A.ok(!(removedDisk.configs || []).some(c => c.id === 'demo'), 'connector removal read-back has no matching config');
    A.ok(!(removedDisk.oauth && removedDisk.oauth.byId && removedDisk.oauth.byId.demo), 'connector removal read-back has no matching OAuth credential');
    const removalCopies = fs.readFileSync(connectorFile, 'utf8') + fs.readFileSync(connectorFile + '.bak', 'utf8');
    A.ok(removalCopies.indexOf('mcp-secret-token') < 0, 'connector removal scrubs the token from both main and resilient backup');

    // Reset is the bulk credential-deletion surface; prove it also cannot leave a recovery-file copy behind.
    const readd = await fetch(B + '/api/connectors', {
      method: 'POST', headers,
      body: JSON.stringify({ id: 'demo', label: 'Demo MCP', transport: 'http', url: mcp.url, token: 'mcp-secret-token' })
    });
    A.eq(readd.status, 200, 'connector can be re-added before section reset');
    const reset = await fetch(B + '/api/config/reset', { method: 'POST', headers, body: JSON.stringify({ section: 'connectors' }) });
    A.eq(reset.status, 200, 'connector section reset -> 200');
    const resetCopies = fs.readFileSync(connectorFile, 'utf8') + fs.readFileSync(connectorFile + '.bak', 'utf8');
    A.ok(resetCopies.indexOf('mcp-secret-token') < 0, 'connector reset scrubs the token from both main and resilient backup');
  } finally {
    if (sse) sse.close();
    try { child.kill(); } catch (_) {}
    try { mcp.server.close(); } catch (_) {}
    try { llm.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  // An app-shipped Google client is an environment credential, not user connector state. Prove that using it
  // unlocks direct sign-in but an unrelated durable connector save cannot copy either value onto disk.
  const envWs = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-google-env-e2e-'));
  const envClientId = 'env-client.apps.googleusercontent.com';
  const envClientSecret = 'env-google-client-secret';
  let envChild = null;
  try {
    const envBoot = await boot(9080 + (process.pid % 50), {
      SKYNET_WORKSPACES: envWs,
      STARNET_WORKSPACES: envWs,
      STARNET_GOOGLE_OAUTH_CLIENT_ID: envClientId,
      STARNET_GOOGLE_OAUTH_CLIENT_SECRET: envClientSecret
    }, 20);
    envChild = envBoot.child;
    const envBase = 'http://' + HOST + ':' + envBoot.port;
    const envToken = await bootToken(envBase, envBase);
    const envHeaders = { 'Content-Type': 'application/json', 'X-StarNet-Token': envToken, Origin: envBase };
    const envCatalog = await (await fetch(envBase + '/api/connectors/catalog', { headers: { 'X-StarNet-Token': envToken, Origin: envBase } })).json();
    A.eq((envCatalog.connectors.find(c => c.id === 'gmail') || {}).needsClient, false, 'complete app-provided Google credentials unlock direct sign-in');
    const envStart = await fetch(envBase + '/api/connectors/oauth/start', {
      method: 'POST', headers: envHeaders, body: JSON.stringify({ id: 'gmail', attemptId: 'google-env-start' })
    });
    A.eq(envStart.status, 200, 'app-provided Google credentials start the direct OAuth flow');
    A.eq(new URL((await envStart.json()).url).searchParams.get('client_id'), envClientId, 'direct OAuth uses the app-provided client id');
    const unrelatedSave = await fetch(envBase + '/api/connectors', {
      method: 'POST', headers: envHeaders,
      body: JSON.stringify({ id: 'env-proof', label: 'Env proof', transport: 'http', url: 'https://example.com/mcp', enabled: false })
    });
    A.eq(unrelatedSave.status, 200, 'unrelated disabled connector save completes while app Google credentials are active');
    const envDiskPath = path.join(envWs, 'connectors', 'state.json');
    const envDisk = fs.existsSync(envDiskPath) ? fs.readFileSync(envDiskPath, 'utf8') : '';
    A.ok(envDisk.indexOf(envClientId) < 0 && envDisk.indexOf(envClientSecret) < 0, 'app-provided Google credentials are never copied into durable user connector state');
    A.ok(JSON.stringify(envCatalog).indexOf(envClientId) < 0 && JSON.stringify(envCatalog).indexOf(envClientSecret) < 0, 'catalog never exposes app-provided Google credentials');
  } finally {
    try { if (envChild) envChild.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(envWs, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('e2e.mcp-connector.test');
})().catch(e => { console.log('FAIL: e2e.mcp-connector.test threw - ' + (e && e.stack || e)); process.exit(1); });
