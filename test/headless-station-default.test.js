/* node test/headless-station-default.test.js — a headless client runs on the station default (GitHub #96 follow-up, quick win 13).

   GET /api/runtime/agent is what an out-of-process client (the ACP editor bridge, a script) reads before it drives
   POST /api/run. It resolved provider 'openrouter' + STARNET_DEFAULT_MODEL whatever the station runs on, so a station
   whose agent runs on a ChatGPT sign-in (no OpenRouter key) answered "configured: false" and the editor refused to run.
   And the bridge sent no persona, so the run was a bare model with no identity.

   Locks:
   1. the route resolves through stationDefaultFor — the record every unpinned agent follows (the hero's model and
      provider) — and only a station whose hero has no model falls back to the bare headless env rule;
   2. the ACP bridge's /api/run body asks for the roster persona (rosterSystem: true) and runs on what the route said.
   The route runs from its own source (requiring sidecar/index.js would boot a sidecar); the bridge runs for real as
   a child process against a fake station on loopback. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { sidecarFunctionSource } = require('./helpers/source');

// ---- 1. GET /api/runtime/agent resolves the station default ----
const route = sidecarFunctionSource('handleRuntimeAgent');
const sdf = sidecarFunctionSource('stationDefaultFor');
A.ok(route.length > 200 && route.length < 6000 && sdf.length > 40 && sdf.length < 1000, 'bounded handleRuntimeAgent + stationDefaultFor');
function runtimeAgent(roster, env, credentialFor) {
  const agentRoster = new Map(Object.entries(roster));
  const deps = {
    agentRoster, agentRosterRaw: new Map(),
    normalizeProvider: p => String(p || 'openrouter'),
    providerRuntimeKey: (id) => (id === 'openrouter' && env.orKey) || '',
    providerRuntimeBaseUrl: () => '',
    providerHasCredential: (id, key) => credentialFor(id, key),
    ENV: suffix => env[suffix],
    computeVersionSurface: () => ({ harness: 'test' })
  };
  const fn = new Function(...Object.keys(deps), sdf + '\n' + route + '\nreturn handleRuntimeAgent;')(...Object.values(deps));
  let body = '';
  fn({}, { writeHead() {}, end(s) { body = s; } });
  return JSON.parse(body);
}
const signedInChatGPT = id => id === 'codex';
{
  const r = runtimeAgent({ agent: { name: 'NOVA', model: 'gpt-5.5', provider: 'codex' } }, {}, signedInChatGPT);
  A.eq([r.provider, r.model, r.configured], ['codex', 'gpt-5.5', true], 'a ChatGPT-only station: the route reports the hero\'s ChatGPT model, and that a run can start');
  const pinned = runtimeAgent({ agent: { model: 'anthropic/claude-sonnet-5', provider: 'openrouter' }, researcher: { model: 'gpt-5.5', provider: 'codex' } }, { orKey: 'sk-or' }, (id, key) => id === 'openrouter' && !!key);
  A.eq([pinned.provider, pinned.model, pinned.configured], ['openrouter', 'anthropic/claude-sonnet-5', true], 'the station default is the hero\'s, never another agent\'s pin');
  const signedOut = runtimeAgent({ agent: { model: 'gpt-5.5', provider: 'codex' } }, {}, () => false);
  A.eq([signedOut.provider, signedOut.configured], ['codex', false], 'a signed-out station default says it cannot run, on its own provider');
  const bare = runtimeAgent({}, { DEFAULT_MODEL: 'test/model', orKey: 'sk-or' }, (id, key) => id === 'openrouter' && !!key);
  A.eq([bare.provider, bare.model, bare.configured], ['openrouter', 'test/model', true], 'a roster-less headless station keeps the bare env rule');
  const modelless = runtimeAgent({ agent: { name: 'NOVA', provider: 'codex' } }, { DEFAULT_MODEL: 'test/model' }, () => false);
  A.eq([modelless.provider, modelless.model], ['openrouter', 'test/model'], 'a hero with no model yet falls back to the env rule');
  A.eq(r.agents.map(a => a.agentId), ['agent'], 'the roster still rides along');
}

// ---- 2. the ACP bridge sends the roster persona and runs on what the route said ----
(async () => {
  const runs = [];
  const station = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/api/runtime/agent') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, provider: 'codex', model: 'gpt-5.5', configured: true, agents: [{ agentId: 'agent', name: 'NOVA', model: 'gpt-5.5', provider: 'codex' }] }));
      }
      if (req.method === 'POST' && req.url === '/api/run') {
        let body = null; try { body = JSON.parse(raw); } catch (_) {}
        runs.push({ body, token: req.headers['x-starnet-token'] });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ name: 'agent.run.start', payload: { runId: 'r1', agentId: 'agent' } }) + '\n');
        res.write(JSON.stringify({ name: 'agent.token', payload: { runId: 'r1', delta: 'hello from NOVA' } }) + '\n');
        res.write(JSON.stringify({ name: 'agent.run.end', payload: { runId: 'r1', reason: 'done' } }) + '\n');
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise(r => station.listen(0, '127.0.0.1', r));
  const port = station.address().port;
  const bridge = spawn(process.execPath, [path.join(__dirname, '..', 'sidecar', 'acp', 'serve.js'), '--port=' + port, '--host=127.0.0.1', '--token=test-token'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = [];
  bridge.stderr.on('data', d => stderr.push(String(d)));
  let buf = '', nextId = 0;
  const pending = new Map();
  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let msg = null; try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg && msg.method === undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out; bridge stderr: ' + stderr.join(''))); }, 20000);
    pending.set(id, m => { clearTimeout(timer); resolve(m); });
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'headless-default-test', version: '1' } });
    const s = await send('session/new', { cwd: process.cwd(), mcpServers: [] });
    const sessionId = s.result && s.result.sessionId;
    A.ok(sessionId, 'the bridge opened a session');
    const p = await send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'who are you?' }] });
    A.ok(p.result && p.result.stopReason === 'end_turn', 'the turn ran to its end: ' + JSON.stringify(p).slice(0, 200));
    A.eq(runs.length, 1, 'exactly one /api/run was started');
    const body = (runs[0] && runs[0].body) || {};
    A.eq(body.rosterSystem, true, 'the bridge asks the station to run the agent as its roster entry defines it');
    A.ok(!body.system, 'and sends no persona of its own');
    A.eq([body.agentId, body.model, body.provider, body.isTask], ['agent', 'gpt-5.5', 'codex', true], 'on the model and provider the station reported');
  } finally {
    try { bridge.kill(); } catch (_) {}
    await new Promise(r => station.close(r));
  }
  A.report('headless-station-default.test');
})().catch(e => { console.log('FAIL: headless-station-default.test threw — ' + (e && e.stack || e)); process.exit(1); });
