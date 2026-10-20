'use strict';
// Synthetic local-provider proof, never a live business/quality acceptance.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { bootToken } = require('./_httpToken.js');

test('real sidecar: L01 revision, PNG review, human manifest, restart and auth; no exterior calls', { timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync('/tmp/opencode/colony-http-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const WM = require('../frontend/app/worldmodel.js');
  const native = structuredClone(require('../dev/fixtures/seed-workspace/agent.save.json').doc);
  const world = WM.create(WM.starterDoc()), life = require('../lab/fixtures/lifestruct.json');
  require('../lab/workflow.cjs').create(world, life, new Set(life.steps.map(s => s.agentId)));
  native.station = world.serialize(); native.agents = [{ ...native.agent, id: 'life_content' }, { ...native.agent, id: 'life_review' }];
  native._saveRevision = 4;
  fs.writeFileSync(path.join(dir, 'agent.save.json'), JSON.stringify({ version: 1, doc: native, updatedAt: native.updatedAt || 1 }));
  const seen = []; let reviews = 0, writes = 0, child;
  const provider = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'mock/model', context_length: 128000 }] })); }
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
      const request = JSON.parse(body); seen.push(request); writes++;
      const content = [...request.messages].reverse().find(x => x.role === 'user').content;
      const text = typeof content === 'string' ? content : content.find(x => x.type === 'text').text;
      let packet; try { packet = JSON.parse(text); } catch (_) { packet = {}; }
      let output;
      if (packet.output?.startsWith('{facts')) output = { facts: [{ text: 'Der Guide kostet 59 EUR.', sourceId: 's1' }], uncertainties: [] };
      else if (packet.output?.startsWith('{pins')) output = { pins: [{ id: 'p1', title: 'Planen mit KI', description: 'Belegter Guide für 59 EUR',
        overlay: reviews ? 'Deinen Alltag mit KI planen' : 'Dein Plan mit KI', url: 'https://example.org/guide', board: 'Planung', sourceIds: ['s1'] }] };
      else { reviews++; output = { passed: reviews > 1, dimensions: { facts: true, brand: true, visual: reviews > 1, complete: true },
        findings: reviews > 1 ? [] : [{ pinId: 'p1', dimension: 'visual', message: 'Overlay konkreter formulieren.' }] }; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(output) } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 70, total_tokens: 100, cost: 0.001 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => new Promise(r => provider.close(r)));
  const socket = http.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(r => socket.close(r)); const base = 'http://127.0.0.1:' + port;
  async function boot() {
    let log = '';
    child = spawn(process.execPath, ['--require', './lab/guard.cjs', 'sidecar/index.js'], {
      cwd: path.resolve(__dirname, '..'), env: { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir,
        STARNET_WORKSPACES: dir, STARNET_PORT: String(port), STARNET_DEV: '1', STARNET_CRON_ENABLED: '0', STARNET_NIGHTSHIFT_ENABLED: '0',
        STARNET_LIVE_PRICES: '0', SKYNET_REFLECT: '0', SKYNET_SKILL_REVIEW: '0', LAB_LIVE: '1', LAB_ALLOW_HOSTS: '127.0.0.1',
        CUSTOM_OPENAI_KEY: 'fixture-not-real', CUSTOM_OPENAI_BASE_URL: 'http://127.0.0.1:' + provider.address().port + '/v1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('boot timeout: ' + log.slice(-1200))), 20000);
      const read = d => { log += d; if (log.includes('Open in your browser:')) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', read); child.stderr.on('data', read);
      child.once('exit', code => { clearTimeout(timer); reject(new Error('boot exit ' + code + ': ' + log.slice(-1800))); });
    });
    return { 'Content-Type': 'application/json', Origin: base, 'X-StarNet-Token': await bootToken(base, base) };
  }
  async function stop() { if (child && child.exitCode === null) { const end = once(child, 'exit'); child.kill(); await end; } }
  t.after(stop);
  let headers = await boot();
  const api = async (url, body) => {
    const res = await fetch(base + url, { headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, value: await res.json() };
  };
  let view = (await api('/api/colony')).value;
  assert.equal(view.revision, 0); assert.equal(view.externalActionsEnabled, false); assert.equal(writes, 0);
  const post = async command => {
    const result = await api('/api/colony/command', { expectedRevision: view.revision, ...command });
    assert.equal(result.status, 200, JSON.stringify(result.value)); view = (await api('/api/colony')).value; return result.value.result;
  };
  const models = Object.fromEntries(['research', 'editorial', 'review'].map(role => ['colony_lifestruct_' + role, { provider: 'custom', model: 'mock/model' }]));
  await post({ type: 'configuration.set', models, enabled: true, poolBudget: { usd: 5, tokens: 100000, ms: 600000 } });
  const task = await post({ type: 'task.create', processId: 'L01', businessUnitId: 'lifestruct', goal: 'Lokaler synthetischer Test',
    account: 'fixture', audience: 'fixture', schedule: '2026-10-22T12:00:00+02:00 Europe/Berlin',
    sources: [{ id: 's1', businessUnitId: 'lifestruct', confirmed: true, version: '1', asOf: '2026-10-19', uri: 'https://example.org/guide', excerpt: 'Der Guide kostet 59 EUR.' }],
    targets: [{ url: 'https://example.org/guide', promise: 'Guide für 59 EUR.' }], boards: ['Planung'], budget: { usd: 2, tokens: 80000, ms: 300000 } });
  const run = await api('/api/colony/run', { taskId: task.id, expectedRevision: view.revision, reserve: { usd: 0.1, tokens: 14000, ms: 30000 } });
  assert.equal(run.status, 200, JSON.stringify(run.value));
  view = (await api('/api/colony')).value;
  const final = view.tasks[task.id];
  assert.equal(final.status, 'ready_for_approval', JSON.stringify(final));
  assert.equal(final.attempts.length, 5); assert.equal(reviews, 2); assert.equal(writes, 5);
  const recorded = fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(recorded.filter(r => r.colony).length >= 5, 'native run log retains task/brand/attempt/role version metadata');
  assert.ok(seen.every(r => !r.tools || r.tools.length === 0), 'native output-only path exposes no bypass tools');
  const visionRequests = seen.filter(r => r.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')));
  assert.equal(visionRequests.length, 2, 'both independent reviews received real PNGs');
  const img = await fetch(base + '/api/colony/image/' + final.artifacts[0].sha256, { headers });
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(view.inbox.length, 1); assert.equal(view.realPilotAccepted, false);
  assert.equal((await api('/api/colony/command', { type: 'task.formal', expectedRevision: view.revision })).status, 403);
  const entry = view.inbox[0];
  const approval = await post({ type: 'approval.decide', taskId: task.id, digest: entry.digest, decision: 'approve', pinIds: ['p1'], actions: ['export'] });
  assert.equal(approval.actor, 'owner'); assert.equal(Object.keys(view.actions).length, 0);
  const unauth = await fetch(base + '/api/colony/command', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' });
  assert.equal(unauth.status, 403);
  const preview = (await api('/api/colony/installation/preview')).value;
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const installed = await api('/api/colony/installation/install', {
    expectedSaveRevision: preview.expectedSaveRevision, expectedStateRevision: preview.expectedStateRevision, previewDigest: preview.previewDigest
  });
  assert.equal(installed.status, 200, JSON.stringify(installed.value)); assert.equal(installed.value.installed, true);
  assert.equal(writes, 5, 'physical room/profile installation makes no model calls');
  assert.equal((await api('/api/save', native)).status, 409, 'old Save cannot undo the installation');
  assert.equal((await api('/api/roster', { agents: [{ agentId: 'agent', model: 'mock/model' }] })).status, 409);
  assert.equal((await api('/api/routing', { agentOfDock: {} })).status, 409);
  const nativeRead = (await api('/api/save')).value.save;
  assert.equal(nativeRead.colonyInstallation.commitId, installed.value.commitId);
  view = (await api('/api/colony')).value;
  assert.ok(view.team.some(a => a.nativeInstalled));
  const second = await post({ type: 'task.create', processId: 'L01', businessUnitId: 'lifestruct', goal: 'Synthetischer nativer Dock-Test',
    account: 'fixture', audience: 'fixture', schedule: '2026-10-22T12:00:00+02:00 Europe/Berlin',
    sources: [{ id: 's1', businessUnitId: 'lifestruct', confirmed: true, version: '1', asOf: '2026-10-19', uri: 'https://example.org/guide', excerpt: 'Der Guide kostet 59 EUR.' }],
    targets: [{ url: 'https://example.org/guide', promise: 'Guide für 59 EUR.' }], boards: ['Planung'], budget: { usd: 2, tokens: 80000, ms: 300000 } });
  const nativeRun = await api('/api/colony/run', { taskId: second.id, expectedRevision: view.revision, reserve: { usd: 0.1, tokens: 14000, ms: 30000 } });
  assert.equal(nativeRun.status, 200, JSON.stringify(nativeRun.value));
  assert.equal(nativeRun.value.result.status, 'ready_for_approval'); assert.equal(writes, 8);
  const dockRows = fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(dockRows.filter(r => r.colony?.taskId === second.id).every(r => r.dockId && r.lineId), 'every managed model run records its actual native dock');
  await stop(); headers = await boot();
  const restored = (await api('/api/colony')).value;
  assert.equal(restored.tasks[task.id].status, 'approved'); assert.equal(writes, 8, 'restart never calls a model');
  assert.equal((await fetch(base + '/colony/index.html')).status, 200);
});
