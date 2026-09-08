/* Real-host live doctor proof: actual sidecar + local OpenAI-compatible provider + actual local execution
   backend. No external network, credentials, or channel delivery. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

function readJson(req) {
  return new Promise(resolve => { let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); } }); });
}

function mcpFixture() {
  return new Promise(resolve => {
    const calls = [];
    const server = http.createServer(async (req, res) => {
      if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const msg = await readJson(req); calls.push(msg.method);
      const reply = (result, status) => {
        const headers = { 'Content-Type': 'application/json' };
        if (msg.method === 'initialize') headers['Mcp-Session-Id'] = 'doctor-session';
        res.writeHead(status || 200, headers);
        res.end((status || 200) === 202 ? '' : JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'doctor-mcp' } });
      if (msg.method === 'notifications/initialized') return reply({}, 202);
      if (msg.method === 'tools/list') return reply({ tools: [{ name: 'ping', description: 'safe fixture ping', inputSchema: { type: 'object', properties: {} } }] });
      reply({});
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: 'http://127.0.0.1:' + server.address().port + '/mcp' }));
  });
}

function telegramFixture() {
  return new Promise(resolve => {
    const calls = [], sends = [], waiters = [];
    const respond = (res, value) => { if (!res.writableEnded) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); } };
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const method = String(req.url || '').split('/').pop(); const body = await readJson(req); calls.push(method);
      if (method === 'getMe') return respond(res, { ok: true, result: { id: 42, username: 'doctor_bot', first_name: 'Doctor' } });
      if (method === 'deleteWebhook' || method === 'setMyCommands') return respond(res, { ok: true, result: true });
      if (method === 'getUpdates') {
        if (body.offset === -1) return respond(res, { ok: true, result: [] });
        waiters.push(res);
        return setTimeout(() => { const i = waiters.indexOf(res); if (i >= 0) respond(waiters.splice(i, 1)[0], { ok: true, result: [] }); }, 30);
      }
      if (method === 'sendMessage') sends.push(body);
      respond(res, { ok: true, result: true });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server, calls, sends, baseUrl: 'http://127.0.0.1:' + server.address().port,
      close: () => { while (waiters.length) respond(waiters.shift(), { ok: true, result: [] }); return new Promise(done => server.close(done)); }
    }));
  });
}

async function waitUntil(fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('timed out waiting for live fixture state');
}

function providerFixture() {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'openai/gpt-5', context_length: 8000, supported_parameters: ['reasoning', 'tools'], pricing: { prompt: '0', completion: '0' } }] }));
        return;
      }
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        requests.push(JSON.parse(raw));
        if (requests.at(-1).reasoning?.effort === 'none') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: "Unsupported value: 'none'" } })); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}

test('real host proves selected model and effective execution backend without leaking secrets', async () => {
  const provider = await providerFixture();
  const mcp = await mcpFixture();
  const telegram = await telegramFixture();
  const secret = 'sk-or-v1-live-doctor-fixture-secret';
  const fixture = SidecarFixture.create({ prefix: 'sk-live-doctor-', timeoutMs: 20000, env: {
    SKYNET_OPENROUTER_BASE: provider.baseUrl, STARNET_OPENROUTER_BASE: provider.baseUrl,
    SKYNET_OPENROUTER_KEY: secret, STARNET_OPENROUTER_KEY: secret,
    SKYNET_DEFAULT_MODEL: 'openai/gpt-5', STARNET_DEFAULT_MODEL: 'openai/gpt-5',
    SKYNET_TELEGRAM_API_BASE: telegram.baseUrl, STARNET_TELEGRAM_API_BASE: telegram.baseUrl
  } });
  try {
    await fixture.start();
    const roster = await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{
      agentId: 'doctor', name: 'Doctor', system: 'diagnose', provider: 'openrouter', model: 'openai/gpt-5', reasoningEffort: 'medium', executionProfile: 'trusted-project'
    }] });
    assert.equal(roster.status, 200);
    const connector = await fixture.json('POST', '/api/connectors', { id: 'doctor-mcp', label: 'Doctor MCP', transport: 'http', url: mcp.url, enabled: true });
    assert.equal(connector.status, 200);
    assert.equal(connector.body.connected, true);
    const channel = await fixture.json('POST', '/api/channels/telegram/connect', {
      token: '123456:DOCTOR_FIXTURE', key: secret, model: 'openai/gpt-5', provider: 'openrouter', agentId: 'doctor', agentName: 'Doctor', system: 'diagnose'
    });
    assert.equal(channel.status, 200);
    await waitUntil(async () => (await fixture.json('GET', '/api/channels/telegram/status')).body.connected === true, 5000);

    const refused = await fixture.json('POST', '/api/diagnostics/live', {});
    assert.equal(refused.status, 409);
    assert.equal(provider.requests.length, 0, 'missing consent performs no provider request');

    const result = await fixture.json('POST', '/api/diagnostics/live', { confirmedLiveProbes: true, agentId: 'doctor' });
    assert.equal(result.status, 200, result.text);
    assert.equal(provider.requests.length, 1, 'exactly one selected-model request was made');
    assert.equal(provider.requests[0].reasoning?.effort, 'medium', 'doctor preserves the selected agent reasoning');
    assert.deepEqual(provider.requests[0].messages, [{ role: 'user', content: 'Reply exactly OK.' }]);
    const rows = result.body.report.rows;
    const model = rows.find(r => r.kind === 'provider');
    const execution = rows.find(r => r.kind === 'execution');
    assert.equal(model.state, 'round-trip-proven');
    assert.equal(execution.state, 'round-trip-proven');
    assert.match(execution.detail, /effective local backend executed the sentinel/);
    assert.equal(rows.find(r => r.kind === 'mcp' && r.id === 'doctor-mcp').state, 'round-trip-proven');
    const telegramRow = rows.find(r => r.kind === 'channel' && r.id === 'telegram');
    assert.equal(telegramRow.state, 'refused');
    assert.match(telegramRow.detail, /owner DMs are blocked until \/pair/);
    assert.ok(rows.filter(r => r.kind === 'channel' && r.id !== 'telegram').every(r => r.state === 'not-configured'));
    assert.ok(mcp.calls.filter(x => x === 'initialize').length >= 2, 'doctor performs a fresh MCP initialize after configuration');
    assert.ok(telegram.calls.filter(x => x === 'getMe').length >= 2, 'doctor performs a fresh Telegram authentication request');
    assert.equal(telegram.sends.length, 0, 'doctor sends no Telegram message');
    assert.doesNotMatch(JSON.stringify(result.body), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(result.body.text, /No keys, tokens, prompts, transcripts/);
  } finally {
    await fixture.dispose();
    await new Promise(resolve => provider.server.close(resolve));
    await new Promise(resolve => mcp.server.close(resolve));
    await telegram.close();
  }
});
