'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { freePort } = require('../remote/cli');
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(40); }
  throw new Error('condition timed out');
}
test('real runtime finishes after viewer closes, replays live events, fences retries and honors explicit cancellation', { timeout: 45000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-remote-e2e-'));
  let requests = 0, child, output = '', release, automatic = false, goalTurns = 0, goalJudges = 0;
  const provider = http.createServer((req, res) => {
    if (req.url.includes('/models')) { res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 32000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })); return; }
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      requests++;
      if (automatic) {
        const body = JSON.parse(raw);
        const isJudge = (body.messages || []).some(m => m.role === 'system' && String(m.content).includes('You are a strict judge'));
        const isGoal = (body.messages || []).some(m => m.role === 'user' && String(m.content).startsWith('[Continuing toward your standing goal]'));
        if (isGoal && !isJudge) goalTurns++;
        const text = isJudge ? JSON.stringify({ verdict: ++goalJudges >= 2 ? 'done' : 'continue', reason: 'Mock evidence verified' }) : 'Completed the next concrete step.';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n'); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Still working. ' } }] }) + '\n\n');
      release = () => { res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Finished on Linux.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n'); };
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const runtimePort = await freePort(), base = 'http://127.0.0.1:' + runtimePort;
  const token = crypto.randomBytes(32).toString('hex');
  const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token };
  async function boot() {
    child = spawn(process.execPath, [path.join(ROOT, 'sidecar/index.js')], { env: { ...process.env,
      NODE_PATH: path.join(ROOT, 'remote/node_modules'), STARNET_WORKSPACES: workspace,
      STARNET_OPENROUTER_KEY: 'sk-or-v1-test-only', STARNET_REMOTE: '1', STARNET_PORT: String(runtimePort), STARNET_API_TOKEN: token,
      STARNET_OPENROUTER_BASE: 'http://127.0.0.1:' + provider.address().port,
      SKYNET_THREAD_MINE: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_SCOUT: '0',
      SKYNET_ENV_DISCOVERY: '0', SKYNET_QUEST_REFRESH: '0'
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
    await until(async () => {
      if (child.exitCode !== null) throw new Error(output);
      try { return (await fetch(base + '/api/health')).ok; } catch (_) { return false; }
    });
  }
  async function stop() { if (child?.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
  async function snapshot() { return (await fetch(base + '/api/state/snapshot', { headers })).json(); }
  try {
    await boot();
    const saved = await (await fetch(base + '/api/save', { method: 'POST', headers, body: JSON.stringify({
      version: 5, updatedAt: Date.now(), _saveRevision: 0, agent: { id: 'agent', name: 'TEST' },
      workstreams: [{ id: 'test-session', title: 'Remote test', kind: 'chat', agentId: 'agent', history: [{ role: 'user', content: 'Check continuity.' }] }], activeId: 'test-session', generalId: 'test-session'
    }) })).json();
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const body = { requestId: crypto.randomUUID(), key: 'sk-or-v1-test-only', provider: 'openrouter', model: 'test/model',
      agentId: 'agent', streamId: 'test-session', isTask: false, messages: [{ role: 'user', content: 'Check continuity.' }] };
    const watch = new AbortController();
    const response = await fetch(base + '/api/run', { method: 'POST', headers, body: JSON.stringify(body), signal: watch.signal });
    assert.equal(response.status, 200);
    await response.body.getReader().read();
    const live = await until(async () => { const s = await snapshot(); return s.runs[0] || false; });
    assert.equal(live.streamId, 'test-session');
    await until(() => requests === 1);
    watch.abort(); await sleep(120);
    assert.equal((await snapshot()).runs[0].runId, live.runId, 'closing the entire viewer leaves the same run alive');
    const duplicate = await fetch(base + '/api/run', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(duplicate.status, 409); assert.equal(requests, 1);
    const feed = new AbortController();
    const events = await fetch(base + '/api/channels/events?token=' + token, { signal: feed.signal });
    const reader = events.body.getReader();
    let ready = '';
    await until(async () => { ready += new TextDecoder().decode((await reader.read()).value); return ready.includes('"stream":"ready"'); });
    assert.match(ready, /"stream":"ready"/);
    const cursor = ready.match(/"cursor":"([^"]+)"/)[1];
    release();
    let frames = '';
    await until(async () => {
      frames += new TextDecoder().decode((await reader.read()).value || new Uint8Array());
      return frames.includes('agent.run.end');
    });
    feed.abort();
    await until(async () => (await snapshot()).runs.length === 0);
    const history = await (await fetch(base + '/api/runs?agent=*&limit=20', { headers })).json();
    assert.equal(history.runs[0].reason, 'done');
    assert.match(history.runs[0].deliveryText, /Finished on Linux/);
    const save = await (await fetch(base + '/api/save', { headers })).json();
    assert.match(save.save.workstreams.find(w => w.id === 'test-session').history.at(-1).content, /Finished on Linux/);
    const replayStop = new AbortController();
    const replay = await fetch(base + '/api/channels/events?token=' + token + '&cursor=' + encodeURIComponent(cursor), { signal: replayStop.signal });
    const replayReader = replay.body.getReader();
    let replayed = '';
    await until(async () => { replayed += new TextDecoder().decode((await replayReader.read()).value); return replayed.includes('agent.run.end'); });
    assert.match(replayed, /agent.run.end/); assert.match(replayed, /remoteStreamId/); replayStop.abort();

    const cancelWatch = new AbortController();
    const second = await fetch(base + '/api/run', { method: 'POST', headers, body: JSON.stringify({ ...body, requestId: crypto.randomUUID() }), signal: cancelWatch.signal });
    await second.body.getReader().read();
    const cancelRun = await until(async () => (await snapshot()).runs[0]);
    assert.equal((await fetch(base + '/api/cancel', { method: 'POST', headers, body: JSON.stringify({ runId: cancelRun.runId }) })).ok, true);
    cancelWatch.abort();
    await until(async () => (await snapshot()).runs.length === 0);
    await stop(); await boot();
    assert.equal((await fetch(base + '/api/run', { method: 'POST', headers, body: JSON.stringify(body) })).status, 409);
    assert.equal((await snapshot()).runs.length, 0, 'restart never reruns claimed work');
    automatic = true;
    const roster = await fetch(base + '/api/roster', { method: 'POST', headers, body: JSON.stringify({ agents: [{ agentId: 'agent', name: 'TEST', system: 'Test only.', model: 'test/model', provider: 'openrouter' }] }) });
    assert.equal(roster.ok, true, await roster.text());
    const goalBody = { streamId: 'test-session', requestId: crypto.randomUUID(), text: 'Complete two verified mock steps' };
    const goalStart = await fetch(base + '/api/remote/goals', { method: 'POST', headers, body: JSON.stringify(goalBody) });
    assert.equal(goalStart.status, 200, await goalStart.text());
    assert.equal((await fetch(base + '/api/remote/goals', { method: 'POST', headers, body: JSON.stringify(goalBody) })).status, 409);
    // No viewer/SSE connection exists here. The server drives work AND judging.
    const finished = await until(async () => {
      const j = await (await fetch(base + '/api/remote/goals', { headers })).json();
      return j.goals[0] && !j.goals[0].running ? j.goals[0] : false;
    });
    assert.equal(finished.goal.status, 'done', JSON.stringify(finished));
    assert.equal(goalTurns, 2); assert.equal(goalJudges, 2);
    const transcript = await (await fetch(base + '/api/transcript?agent=agent&stream=test-session', { headers })).json();
    assert.ok(transcript.turns.some(t => String(t.content).includes('Completed the next concrete step.')));
    await stop(); await boot();
    assert.equal((await (await fetch(base + '/api/remote/goals', { headers })).json()).goals[0].goal.status, 'done');
    assert.equal(goalTurns, 2, 'completed goals never restart');
  } finally {
    await stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
