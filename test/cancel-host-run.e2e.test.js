/* node test/cancel-host-run.e2e.test.js — STOP and STEER reach every run, not only desk runs (QA 2026-10-02).

   A routine's line hop is driven by runOnce with its own run id and AbortController — it never sits in `runs`.
   The desk screen and HUD STOP (POST /api/cancel) answered 200 and aborted nothing; a steer said "already
   finished" to a hop the desk showed WORKING. This boots the real sidecar, holds the hop at the provider, then
   steers and stops it by id and proves it really ends. */

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// a fake provider that can HOLD a chosen request open forever (the hop is "working" until something stops it)
function startMockOpenRouter() {
  let holdPred = null, heldRes = [], heldWaiters = [];
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
          let parsed = {}; try { parsed = JSON.parse(body); } catch (_) {}
          if (holdPred && holdPred(parsed)) { heldRes.push(res); heldWaiters.splice(0).forEach(w => w()); return; }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'AI news found' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({
      server,
      base: 'http://' + HOST + ':' + server.address().port + '/api/v1',
      holdWhen(pred) { holdPred = pred; },
      held() { return heldRes.length ? Promise.resolve() : new Promise(r => heldWaiters.push(r)); },
      release() { holdPred = null; for (const r of heldRes.splice(0)) { try { r.destroy(); } catch (_) {} } }
    }));
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

async function startSseCollector(url, onEvent) {
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
            try { const event = JSON.parse(raw); events.push(event); if (onEvent) await onEvent(event); notify(); } catch (_) {}
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


(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cancel-host-run-'));
  const env = {
    SKYNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-cancel-host-fake',
    SKYNET_DEFAULT_MODEL: 'test/model',
    SKYNET_CRON_TICK_MS: '1000'
  };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const create = await fetch(B + '/api/cron', { method: 'POST', headers,
      body: JSON.stringify({ name: 'AI news', prompt: 'gather relevant AI news', schedule: 'every 1h', agentId: 'research-agent', model: 'test/model', provider: 'openrouter', runsLine: true }) });
    A.eq(create.status, 200, 'created a line routine');
    const job = (await create.json()).job;
    sse = await startSseCollector(B + '/api/channels/events?' + require('./_httpToken.js').sseQuery(token), async event => {
      if (event.name !== 'station.command') return;
      await fetch(B + '/api/station/ack', { method: 'POST', headers, body: JSON.stringify({ id: event.payload.id, ok: true, result: { folded: true } }) });
    });
    const Pipeline = require('../frontend/app/pipeline.js');
    const belt = (x, y, dir) => ({ x, y, dir });
    const plan = Pipeline.compileRoutingPlan({
      props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
              { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research-agent' },
              { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer-agent' },
              { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
    });
    for (const b of plan.bays.concat(plan.dockBays)) b.objects = ['computer'];
    A.eq((await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(plan) })).status, 200, 'the two-stage line deploys');

    // stage two (the writer's LINE HOP) hangs at the provider: it is driven by the chain with its own run id, never in `runs`
    mock.holdWhen(req => (req.messages || []).some(m => m.role === 'user' && String(m.content || '').indexOf('AI news found') >= 0));
    const runNow = fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) }).then(r => r.text()).catch(() => null);
    await sse.waitFor(ev => ev.some(e => e.name === 'agent.run.start' && e.payload && e.payload.agentId === 'writer-agent'), 15000, 'the writer hop starts');
    await mock.held();
    const hop = sse.events.find(e => e.name === 'agent.run.start' && e.payload && e.payload.agentId === 'writer-agent').payload;
    A.ok(hop.runId, 'the hop has its own run id');

    // STEER: a run runOnce is still driving is in flight — the note is accepted, never "already finished"
    const steer = await fetch(B + '/api/run/steer', { method: 'POST', headers, body: JSON.stringify({ runId: hop.runId, text: 'keep it short' }) });
    A.eq(steer.status, 200, 'a steer reaches a live line hop (was 404 "already finished" while the desk said WORKING)');

    // STOP by run id (the desk screen and HUD STOP) really ends it
    const cancel = await fetch(B + '/api/cancel', { method: 'POST', headers, body: JSON.stringify({ runId: hop.runId }) });
    A.eq(cancel.status, 200, 'cancel answers');
    await sse.waitFor(ev => ev.some(e => e.name === 'agent.run.end' && e.payload && e.payload.runId === hop.runId), 8000, 'the stopped hop ends');
    const end = sse.events.find(e => e.name === 'agent.run.end' && e.payload && e.payload.runId === hop.runId).payload;
    A.ok(end.reason !== 'done', 'the stopped hop never reads as done (reason ' + end.reason + ')');
    await runNow;
  } finally {
    if (sse) sse.close();
    try { child.kill(); } catch (_) {}
    try { mock.release(); mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('cancel-host-run.e2e.test');
})().catch(e => { console.log('FAIL: cancel-host-run.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
