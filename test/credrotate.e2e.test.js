/* node test/credrotate.e2e.test.js — production wiring for primary-key cooldown.

   Boots the real sidecar against a local fake OpenRouter. KEYA rejects every request, KEYB
   succeeds. The first run must rotate A -> B; the next run, inside the cooldown, must start
   directly on B. This closes the gap left by credrotate.test.js's pure-module/source locks. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function requestKey(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

function startMock() {
  const calls = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.includes('/chat/completions')) {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          let lastUser = '';
          try {
            const body = JSON.parse(raw);
            const messages = Array.isArray(body.messages) ? body.messages : [];
            const message = [...messages].reverse().find((entry) => entry && entry.role === 'user');
            lastUser = String((message && message.content) || '');
          } catch (_) {}
          const key = requestKey(req);
          calls.push({ key, lastUser });
          if (key === 'KEYA') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'fake primary rejected' } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'backup completed' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
          res.end('data: [DONE]\n\n');
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, HOST, () => resolve({ server, calls, base: `http://${HOST}:${server.address().port}/api/v1` }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let settled = false;
    const onData = (data) => {
      output += data.toString();
      if (!settled && output.includes(`http://${HOST}:${port}`)) {
        settled = true;
        resolve({ child, port });
      } else if (!settled && BIND_REFUSED.test(output)) {
        settled = true;
        try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => {
      if (!settled) { settled = true; reject(error); }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill(); } catch (_) {}
        reject(new Error('boot timeout:\n' + output));
      }
    }, 12000);
  });
}

async function drive(B, token, marker) {
  const response = await fetch(B + '/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
    body: JSON.stringify({ provider: 'openrouter', model: 'test/model', agentId: 'credrotate-e2e', isTask: false, messages: [{ role: 'user', content: marker }] })
  });
  A.eq(response.status, 200, marker + ' streams through the real /api/run route');
  const reader = response.body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

(async () => {
  const mock = await startMock();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-credrotate-'));
  const { child, port } = await boot(await allocatePort(), {
    SKYNET_WORKSPACES: workspace,
    SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'KEYA',
    SKYNET_KEY_POOL_OPENROUTER: 'KEYB',
    SKYNET_QUEST_REFRESH: '0',
    SKYNET_SKILL_REVIEW: '0',
    SKYNET_SKILL_CURATOR: '0'
  }, 20);
  const B = `http://${HOST}:${port}`;
  try {
    const token = await bootToken(B, B);
    const firstMarker = 'CREDROTATE-E2E-FIRST';
    const secondMarker = 'CREDROTATE-E2E-SECOND';
    await drive(B, token, firstMarker);
    await drive(B, token, secondMarker);

    const firstKeys = mock.calls.filter((call) => call.lastUser.includes(firstMarker)).map((call) => call.key);
    const secondKeys = mock.calls.filter((call) => call.lastUser.includes(secondMarker)).map((call) => call.key);
    A.ok(firstKeys.length >= 2, 'first run reached both primary and backup credentials');
    A.eq(firstKeys[0], 'KEYA', 'first run starts on the configured primary');
    A.eq(firstKeys[firstKeys.length - 1], 'KEYB', 'first run rotates to the working backup');
    A.eq(secondKeys, ['KEYB'], 'next run starts directly on the warm backup while primary is cooling');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('credrotate.e2e.test');
})().catch((error) => {
  console.log('FAIL: credrotate.e2e.test threw - ' + (error && error.stack || error));
  process.exit(1);
});
