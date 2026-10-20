'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const WM = require('../frontend/app/worldmodel.js');
const { create } = require('./workflow.cjs');
const { prepare: homeStackR } = require('./homestackr.cjs');
const { prepare, topology, AGENT_ID } = require('./orchestrator.cjs');
const life = require('./fixtures/lifestruct.json');

function fixture() {
  const st = WM.create(WM.starterDoc());
  create(st, life, new Set(life.steps.map(s => s.agentId)));
  return homeStackR({ agent: { id: 'agent', name: 'Lifestruct Analyst', role: 'orchestrator', model: '', provider: 'custom' },
    agents: [{ id: 'life_content', model: 'lab/no-model' }, { id: 'life_review', model: 'lab/no-model' }],
    station: st.serialize(), _saveRevision: 52, updatedAt: 100, workstreams: [{ id: 'existing', messages: ['keep'] }] }).save;
}

test('small occupied room is between BUs; all four pipelines, agents and sessions survive', () => {
  const input = fixture(), before = structuredClone(input);
  const { save, report } = prepare(input), st = WM.create(save.station), old = WM.create(input.station);
  assert.deepEqual(input, before);
  assert.equal(report.valid, true);
  assert.equal(report.executionStarted, false);
  assert.equal(report.automationEnabled, false);
  assert.equal(st.rooms().length, 3);
  const room = st.roomById(report.roomId), r = room.rects[0];
  assert.equal(r.x2 - r.x1 + 1, 9);
  assert.equal(r.y2 - r.y1 + 1, 7);
  for (let y = r.y1; y <= r.y2; y++) {
    assert.equal(st.roomAt(r.x1 - 1, y), 'r1');
    assert.equal(st.roomById(st.roomAt(r.x2 + 1, y)).name, 'HomeStackR');
  }
  const desk = st.propById(report.deskId);
  assert.equal(desk.agentId, AGENT_ID);
  assert.equal(st.roomAt(desk.x, desk.y), room.id);
  assert.equal(st.roomAt(desk.x, desk.y + 1), room.id);
  assert.equal(st.propAt(desk.x, desk.y + 1), null, 'chair has a free tile');
  assert.deepEqual(topology(st), topology(old));
  assert.equal(topology(st).length, 4);
  for (const p of old.props().filter(p => p.t === 'bay')) assert.ok(st.bayObjects(p.agentId, p.id).includes('computer'));
  assert.deepEqual(save.agent, input.agent);
  assert.deepEqual(save.agents.slice(0, input.agents.length), input.agents);
  assert.deepEqual(save.workstreams, input.workstreams);
  assert.equal(save._saveRevision, input._saveRevision);
  const a = save.agents.at(-1);
  assert.equal(a.id, AGENT_ID);
  assert.equal(a.role, 'specialist', 'do not create another undeletable global founder');
  assert.equal(a.workshop, false);
  assert.equal(a.approvalMode, 'ask');
});

test('duplicate insertion and an unexpected room arrangement leave input untouched', () => {
  const save = prepare(fixture()).save, before = structuredClone(save);
  assert.throws(() => prepare(save), /already exists/);
  assert.deepEqual(save, before);
  const unexpected = fixture(), st = WM.create(unexpected.station);
  const home = st.rooms().find(r => r.name === 'HomeStackR');
  assert.equal(st.moveRoom(home.id, 5, 0).ok, true);
  unexpected.station = st.serialize();
  const unchanged = structuredClone(unexpected);
  assert.throws(() => prepare(unexpected), /not adjacent/);
  assert.deepEqual(unexpected, unchanged);
});

test('a prop straddling the rooms refuses rather than leaving furniture/workflow behind', () => {
  const save = fixture(), st = WM.create(save.station);
  assert.equal(st.addProp({ t: 'desk', x: 17, y: 2, w: 2, h: 1 }).ok, true);
  save.station = st.serialize();
  const before = structuredClone(save);
  assert.throws(() => prepare(save), /straddles/);
  assert.deepEqual(save, before);
});
