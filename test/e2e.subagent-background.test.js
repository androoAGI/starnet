/* node test/e2e.subagent-background.test.js - real sidecar proof for watchable background subagents.

   Boots the actual sidecar with a mock OpenRouter. The lead model calls team.spawn
   with background:true, returns immediately, and the spawned worker completes into
   /api/subagents while task/lifecycle events are visible on the SSE bus. */
'use strict';

const A = require('./_assert.js');
const { hostText } = require('./helpers/host-notes.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function agentIdFrom(messages) {
  // [RUNTIME] (Agent id) rides the per-run <run_context> note since lean-prompt (2026-10-12), not messages[0] (user-side on this chat wire)
  const sys = hostText(messages || []);
  const m = sys.match(/Agent id:\s*([^\n]+)/);
  return m ? m[1].trim() : '';
}

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
          const agentId = agentIdFrom(msgs);
          const hasToolResult = msgs.some(m => m && m.role === 'tool');
          requests.push({ agentId, body: parsed });

          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const tool = (id, name, args) => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          };
          const text = (t) => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          };
          if (agentId === 'agent') {
            if (!hasToolResult) tool('spawn_bg', 'team_spawn', { tasks: [{ prompt: 'work quietly in the background', label: 'bg-proof' }], background: true });
            else text('background worker started');
          } else if (/^sub-/.test(agentId)) {
            // Hold the worker open long enough to inspect the authoritative reconnect snapshot between
            // its frozen run.start and run.end. This is the exact window where the CREW rail used to flip IDLE.
            setTimeout(() => { text('background subagent done'); res.write('data: [DONE]\n\n'); res.end(); }, 900);
            return;
          } else {
            text('unexpected agent ' + agentId);
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

async function waitUntil(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(25);
  }
  throw new Error('timed out waiting for ' + label);
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-subagent-bg-e2e-'));
  const env = {
    SKYNET_WORKSPACES: ws,
    STARNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: mock.base,
    STARNET_OPENROUTER_BASE: mock.base,
    SKYNET_DEFAULT_MODEL: 'test/model',
    STARNET_DEFAULT_MODEL: 'test/model',
    // team.spawn is consent-gated (2026-07-14, same as team.summon) and this e2e is headless — bypass via the
    // full-auto posture exactly like e2e.summon.test; the APPROVAL prompt path is covered by the consent suites.
    SKYNET_FULL_ACCESS: '1'
  };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    sse = await startSseCollector(B + '/api/channels/events?' + require('./_httpToken.js').sseQuery(token));

    const res = await fetch(B + '/api/run', {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'sk-or-v1-subagent-fake', model: 'test/model', agentId: 'agent', isTask: true, messages: [{ role: 'user', content: 'spawn a background helper' }] })
    });
    A.eq(res.status, 200, 'POST /api/run streams (200)');
    const panel = await readNdjson(res);
    A.ok(panel.some(e => e.name === 'agent.tool_call' && e.payload && /^team[._]spawn$/.test(e.payload.name || '')), 'lead called team.spawn');
    A.ok(panel.some(e => e.name === 'agent.tool_result' && e.payload && e.payload.summary && /spawned 1 subagent/.test(e.payload.summary)), 'lead received a background subagent handle');
    A.ok(panel.some(e => e.name === 'agent.token' && e.payload && /background worker started/.test(e.payload.delta || '')), 'lead completed after starting the background worker');

    await sse.waitFor(events => events.some(e => e.name === 'task' && e.payload && e.payload.kind === 'subagent' && e.payload.status === 'running'), 5000, 'subagent task running');
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.start' && e.payload && /^sub-/.test(e.payload.agentId || '')), 5000, 'subagent run start');
    const startedEvent = sse.events.find(e => e.name === 'agent.run.start' && e.payload && /^sub-/.test(e.payload.agentId || ''));
    const liveSnapshot = await (await fetch(B + '/api/state/snapshot', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.ok((liveSnapshot.runs || []).some(r => r.runId === startedEvent.payload.runId && r.agentId === startedEvent.payload.agentId && r.source === 'subagent'),
      'reconnect snapshot includes the confirmed background worker while its provider run is still live');
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.end' && e.payload && /^sub-/.test(e.payload.agentId || '')), 5000, 'subagent run end');
    await sse.waitFor(events => events.some(e => e.name === 'task' && e.payload && e.payload.kind === 'subagent' && e.payload.status === 'done'), 5000, 'subagent task done');

    const done = await waitUntil(async () => {
      const j = await (await fetch(B + '/api/subagents?leadId=agent', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      const rows = (j && j.records) || [];
      return rows.find(r => r.status === 'done' && String(r.result || '').indexOf('background subagent done') >= 0);
    }, 5000, 'durable background subagent completion');
    A.ok(done && done.id, '/api/subagents exposes the completed background worker');
    A.ok(Array.isArray(done.events) && done.events.some(e => e.name === 'agent.run.start') && done.events.some(e => e.name === 'agent.run.end'), 'subagent record keeps watchable lifecycle events');
    const settledSnapshot = await (await fetch(B + '/api/state/snapshot', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.ok(!(settledSnapshot.runs || []).some(r => r.runId === done.runId), 'reconnect snapshot drops the background worker after its run.end');
    A.ok(mock.requests.some(r => r.agentId === 'agent') && mock.requests.some(r => /^sub-/.test(r.agentId || '')), 'mock provider saw both lead and background worker calls');
  } finally {
    if (sse) sse.close();
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('e2e.subagent-background.test');
})().catch(e => { console.log('FAIL: e2e.subagent-background.test threw - ' + (e && e.stack || e)); process.exit(1); });
