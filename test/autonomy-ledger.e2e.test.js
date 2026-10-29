/* node test/autonomy-ledger.e2e.test.js — LIVE proof of the NS-0 autonomy decision ledger.

   Boots the REAL sidecar, creates a routine, fires it (Run Now), then proves the decision is durably recorded:
     · GET /api/autonomy/ledger returns the fire entry with the real jobId/agentId/runId (the route serves it)
     · the durable autonomy.ledger.jsonl exists in the workspaces dir and carries the same real entry (round-trip)
     · a restart of the sidecar over the SAME workspaces dir re-serves the entry (survives a process restart) */
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startMockOpenRouter() {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; });
        req.on('end', () => {
          try { requests.push(JSON.parse(body)); } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'radar swept' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
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
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

async function drainNdjson(res) { await res.text(); }   // consume the Run Now stream to completion

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-autonomy-ledger-'));
  const env = {
    SKYNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-ledger-fake',
    SKYNET_DEFAULT_MODEL: 'test/model'
  };
  let child, port;
  try {
    ({ child, port } = await boot(await allocatePort(), env, 20));
    const B = 'http://' + HOST + ':' + port;
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    // an empty ledger is 200 {entries:[]} (a genuinely-empty log, not an error).
    const empty = await fetch(B + '/api/autonomy/ledger', { headers });
    A.eq(empty.status, 200, 'ledger route responds 200 before any decision');
    A.eq((await empty.json()).entries.length, 0, 'a fresh station has an empty autonomy ledger');

    const create = await fetch(B + '/api/cron', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'AI news radar', prompt: 'sweep AI news', schedule: 'every 1h', agentId: 'radar-agent', model: 'test/model', provider: 'openrouter' })
    });
    A.eq(create.status, 200, 'created routine');
    const job = (await create.json()).job;
    A.ok(job && job.id, 'routine id returned');

    // fire it (a cron FIRE decision) — the run streams NDJSON; drain it so the run settles.
    const run = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) });
    A.eq(run.status, 200, 'Run Now returns a stream');
    await drainNdjson(run);
    await sleep(150);   // let the fsync'd ledger append land

    // (1) the route now serves the fire decision with real identity.
    const after = await fetch(B + '/api/autonomy/ledger', { headers });
    A.eq(after.status, 200, 'ledger route serves entries after a fire');
    const entries = (await after.json()).entries;
    A.ok(entries.length >= 1, 'the fire decision was recorded');
    const fire = entries.find(e => e.kind === 'fire' && e.jobId === job.id);
    A.ok(fire, 'a fire entry for the fired routine is present');
    A.eq(fire.source, 'cron', 'source is cron');
    A.eq(fire.agentId, 'radar-agent', 'the fire entry carries the real agentId');
    A.ok(fire.runId && fire.runId.length > 0, 'the fire entry carries the launched runId');

    // (2) the durable JSONL exists on disk and carries the same real entry (persistence round-trip).
    const ledgerFile = path.join(ws, 'autonomy.ledger.jsonl');
    A.ok(fs.existsSync(ledgerFile), 'autonomy.ledger.jsonl was written to the workspaces dir');
    const diskLines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    A.ok(diskLines.some(l => l.kind === 'fire' && l.jobId === job.id && l.agentId === 'radar-agent'), 'the durable log carries the fire decision');

    // (3) RESTART over the SAME workspaces dir -> the decision survives a process restart.
    try { child.kill(); } catch (_) {}
    await sleep(300);
    ({ child, port } = await boot(await allocatePort(), env, 20));
    const B2 = 'http://' + HOST + ':' + port;
    const token2 = await bootToken(B2, B2);
    const restarted = await fetch(B2 + '/api/autonomy/ledger', { headers: { 'X-StarNet-Token': token2, Origin: B2 } });
    A.eq(restarted.status, 200, 'ledger route responds after restart');
    const survived = (await restarted.json()).entries;
    A.ok(survived.some(e => e.kind === 'fire' && e.jobId === job.id), 'the fire decision SURVIVED a sidecar restart (durable)');
  } finally {
    try { child && child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('autonomy-ledger.e2e.test');
})().catch(e => { console.log('FAIL: autonomy-ledger.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
