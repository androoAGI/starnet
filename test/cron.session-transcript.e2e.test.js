/* node test/cron.session-transcript.e2e.test.js - real sidecar proof that a cron run's output is
   durable + fetchable under its per-run stream id 'cron-<runId>' (the backend half of the
   cron-SESSIONS fix). Boots the actual sidecar with a mock provider, creates a routine, fires it
   via /api/cron/run, captures the runId off the cron.fire SSE event, then GETs
   /api/transcript?stream=cron-<runId> and asserts the routine's REAL reply text is stored there —
   the exact read the frontend autosessions module performs on cron.result to surface the session.

   This is what made the bug invisible: before the streamId fix, the transcript persisted under the
   'global' catch-all stream (no per-run identity), so no UI could ever find a routine's output. */
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
const REPLY = 'Digest ready: 3 items summarized.';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startMockOpenRouter() {
  return new Promise((resolve) => {
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
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: REPLY } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }) + '\n\n');
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
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }),
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

// collect SSE events so we can capture the runId the sidecar minted for the fire (cron.fire.runId).
async function startSseCollector(url) {
  const ac = new AbortController();
  const events = [];
  const res = await fetch(url, { signal: ac.signal });
  A.eq(res.status, 200, 'SSE feed opens with token');
  const reader = res.body.getReader();
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
          if (line.indexOf('data:') === 0) { try { events.push(JSON.parse(line.slice(5).trim())); } catch (_) {} }
        }
      }
    } catch (_) {}
  })();
  return { events, close() { try { ac.abort(); } catch (_) {} } };
}

async function drainNdjson(res) { const reader = res.body.getReader(); const dec = new TextDecoder(); while (true) { const { done } = await reader.read(); if (done) break; } }

(async () => {
  const mock = await startMockOpenRouter();
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cron-session-'));
  const env = {
    SKYNET_WORKSPACES: wsDir,
    SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-session-fake',
    SKYNET_DEFAULT_MODEL: 'test/model'
  };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    const create = await fetch(B + '/api/cron', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Daily Digest', prompt: 'summarize the day', schedule: 'every 1h', agentId: 'digest-agent', model: 'test/model', provider: 'openrouter' })
    });
    A.eq(create.status, 200, 'created routine');
    const job = (await create.json()).job;
    A.ok(job && job.id, 'routine id returned');

    sse = await startSseCollector(B + '/api/channels/events?' + require('./_httpToken.js').sseQuery(token));

    const run = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) });
    A.eq(run.status, 200, 'Run Now returns a stream');
    await drainNdjson(run);   // wait for the run to fully settle (transcript is persisted in runOnce's finally)

    // capture the runId the fire minted (the frontend reads this off cron.fire on U.bus).
    let fire = null;
    for (let i = 0; i < 40 && !fire; i++) { fire = sse.events.find(e => e.name === 'cron.fire' && e.payload && e.payload.jobId === job.id); if (!fire) await sleep(50); }
    A.ok(fire && fire.payload.runId, 'cron.fire carried a runId');
    const runId = fire.payload.runId;
    const stream = 'cron-' + runId;

    // let the async transcript append settle, then perform the EXACT read autosessions.js does.
    let turns = [];
    for (let i = 0; i < 40; i++) {
      const tr = await fetch(B + '/api/transcript?agent=digest-agent&stream=' + encodeURIComponent(stream) + '&limit=200', { headers: { 'X-StarNet-Token': token, Origin: B } });
      A.eq(tr.status, 200, 'transcript route 200');
      turns = ((await tr.json()) || {}).turns || [];
      if (turns.some(t => t.role === 'assistant' && String(t.content || '').indexOf(REPLY) >= 0)) break;
      await sleep(50);
    }

    const userTurn = turns.find(t => t.role === 'user');
    const asstTurn = turns.find(t => t.role === 'assistant');
    A.ok(userTurn && String(userTurn.content).indexOf('summarize the day') >= 0, 'the routine prompt is the durable user turn under cron-<runId>');
    A.ok(asstTurn && String(asstTurn.content).indexOf(REPLY) >= 0, 'the routine REAL reply is durable + fetchable under cron-<runId> (the fix)');

    // negative control: the global catch-all stream must NOT hold this run's dialogue (per-run isolation).
    const g = await fetch(B + '/api/transcript?agent=digest-agent&stream=global&limit=200', { headers: { 'X-StarNet-Token': token, Origin: B } });
    const gTurns = ((await g.json()) || {}).turns || [];
    A.ok(!gTurns.some(t => String(t.content || '').indexOf(REPLY) >= 0), 'the reply is NOT dumped into the unreachable global stream');
  } finally {
    if (sse) sse.close();
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('cron.session-transcript.e2e.test');
})().catch(e => { console.log('FAIL: cron.session-transcript.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
