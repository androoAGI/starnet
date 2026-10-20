'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const { create, client } = require('./workflow.cjs');
const { prepare } = require('./homestackr.cjs');
const life = require('./fixtures/lifestruct.json');
const hsr = require('./fixtures/homestackr.json');

function fixture() {
  const st = WM.create(WM.starterDoc());
  create(st, life, new Set(life.steps.map(s => s.agentId)));
  return {
    agent: { id: 'agent', name: 'Lifestruct Analyst', model: '', provider: 'custom' },
    agents: [{ id: 'life_content', name: 'Lifestruct Content', skin: 'base', model: 'lab/no-model' }, { id: 'life_review', name: 'Lifestruct Review', model: 'lab/no-model' }],
    station: st.serialize(), _saveRevision: 47, updatedAt: 100,
    workstreams: [{ id: 'existing-session', messages: ['must stay intact'] }]
  };
}

test('adds a connected HomeStackR room, three native pipelines and nine dedicated computers', () => {
  const input = fixture(), before = structuredClone(input);
  const { save, report, plan } = prepare(input);
  assert.deepEqual(input, before, 'preparation must not mutate its input');
  assert.equal(report.existingPreserved, true);
  assert.equal(report.executionStarted, false);
  assert.equal(P.ok(plan), true);
  const st = WM.create(save.station), room = st.roomById(report.roomId);
  assert.equal(room.name, 'HomeStackR');
  assert.equal(st.rooms().length, 2);
  const r = room.rects[0];
  assert.equal(st.roomAt(r.x1 - 1, 5), 'r1', 'room is directly connected, not floating');
  assert.equal(room.floorStyle, 'oak');
  assert.equal(room.floorMat, 'parquet');
  assert.deepEqual(save.agent, before.agent);
  assert.deepEqual(save.agents.slice(0, before.agents.length), before.agents);
  assert.deepEqual(save.workstreams, before.workstreams);
  assert.equal(save._saveRevision, before._saveRevision, 'keep the revision for server compare-and-swap');
  assert.equal(report.lines.length, 3);
  for (const [i, line] of report.lines.entries()) {
    const graph = st.lineGraph(line.intake).graph;
    assert.equal(graph.nodes.filter(n => n.t === 'outbox').length, 1);
    assert.equal(graph.nodes.filter(n => n.t === 'bay').length, 3);
    assert.deepEqual(line.steps.map(id => st.propById(id).agentId), hsr.lines[i].steps.map(s => s.agentId));
    const lineId = P.lineOfDock(plan, line.steps[0]);
    for (let j = 0; j < 2; j++) assert.equal(P.chainStepDock(plan, line.steps[j], { tag: 'general', lineId }, () => 0).dockId, line.steps[j + 1]);
    for (const id of line.steps) {
      const p = st.propById(id);
      assert.equal(st.roomAt(p.x, p.y), room.id);
      assert.ok(st.bayObjects(p.agentId, id).includes('computer'));
      assert.match(p.brief, /[Kk]ein/);
    }
    assert.ok(graph.nodes.filter(n => n.t === 'outbox').every(n => !n.sendTo));
    assert.ok(!st.propById(line.intake).projectRoot, 'no connection to the production repo');
  }
  const agents = save.agents.filter(a => a.id.startsWith('hsr_'));
  assert.equal(agents.length, 9);
  assert.ok(agents.every(a => a.approvalMode === 'ask' && a.workshop === false));
  assert.ok(agents.every(a => a.model === 'deepseek-v4.1-flash-free' && a.provider === 'custom'));
});

test('duplicate room or colliding agent IDs fail without changing the input', () => {
  const built = prepare(fixture()).save, before = structuredClone(built);
  assert.throws(() => prepare(built), /already exists/);
  assert.deepEqual(built, before);
  const collision = fixture();
  collision.agents.push({ id: 'hsr_writer' });
  const unchanged = structuredClone(collision);
  assert.throws(() => prepare(collision), /ID already exists/);
  assert.deepEqual(collision, unchanged);
});

test('unknown target room is rejected before native mutations', () => {
  const st = WM.create(WM.starterDoc()), before = st.serialize();
  assert.throws(() => create(st, life, new Set(life.steps.map(s => s.agentId)), { roomId: 'missing' }), /Unknown target room/);
  assert.deepEqual(st.serialize(), before);
});

test('live configuration requires opt-in and rejects execution and credential routes before fetch', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    requests.push([init.method || 'GET', pathname]);
    if (pathname === '/api/lab/status') return { json: async () => ({ lab: true, live: true, offline: false, execution: true }) };
    if (pathname === '/') return { text: async () => 'window.__STARNET_API_TOKEN__="fixture-token"' };
    return { ok: true, json: async () => ({ ok: true }) };
  });
  await assert.rejects(client('http://127.0.0.1:8790'), /offline lab guard/);
  await assert.rejects(client('https://example.com', { allowLiveAuthoring: true }), /Only a local/);
  const request = await client('http://127.0.0.1:8790', { allowLiveAuthoring: true });
  for (const route of ['/api/run', '/api/routing/send', '/api/providers/validate-key', '/api/roster']) {
    await assert.rejects(request(route, {}), /route denied/);
  }
  await assert.rejects(request('/api/save?other=1'), /route denied/);
  assert.ok(requests.every(([, p]) => ['/', '/api/lab/status'].includes(p)));
  await request('/api/save');
  await request('/api/save', { _saveRevision: 47 });
  await request('/api/routing', {});
  assert.deepEqual(requests.slice(-3), [['GET', '/api/save'], ['POST', '/api/save'], ['POST', '/api/routing']]);
});
