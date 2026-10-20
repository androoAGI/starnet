'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const { create, edit, inspect } = require('./workflow.cjs');
const spec = require('./fixtures/lifestruct.json');
const agents = new Set(['agent', 'life_content', 'life_review']);

test('external author creates a real three-step Lifestruct graph', () => {
  const st = WM.create(WM.starterDoc());
  const made = create(st, spec, agents);
  const { plan, valid } = inspect(st);
  assert.equal(valid, true);
  assert.equal(st.propById(made.intake).label, spec.name);
  assert.deepEqual(made.steps.map(id => st.propById(id).agentId), [...agents]);
  assert.ok(inspect(st).steps.every(s => s.hasCompute));
  assert.equal(P.chainStepDock(plan, made.steps[0], { tag: 'general', lineId: P.lineOfDock(plan, made.steps[0]) }, () => 0).dockId, made.steps[1]);
  assert.equal(P.chainStepDock(plan, made.steps[1], { tag: 'general', lineId: P.lineOfDock(plan, made.steps[1]) }, () => 0).dockId, made.steps[2]);
  assert.ok(st.serialize());
});

test('external edits keep geometry and routing, and undo works', () => {
  const st = WM.create(WM.starterDoc());
  const made = create(st, spec, agents);
  const geometry = st.props().map(p => [p.id, p.x, p.y]);
  const before = st.propById(made.steps[1]).brief;
  edit(st, made.steps[1], { brief: 'Nur drei Test-Pins vorbereiten.' });
  assert.equal(st.propById(made.steps[1]).brief, 'Nur drei Test-Pins vorbereiten.');
  assert.deepEqual(st.props().map(p => [p.id, p.x, p.y]), geometry);
  assert.equal(inspect(st).valid, true);
  st.undo();
  assert.equal(st.propById(made.steps[1]).brief, before);
});

test('invalid specifications and unknown agents do not touch station', () => {
  const st = WM.create(WM.starterDoc());
  const before = st.serialize();
  assert.throws(() => create(st, { ...spec, steps: [{ ...spec.steps[0], agentId: 'unknown' }] }, agents), /Unknown/);
  assert.throws(() => create(st, { ...spec, steps: [{ ...spec.steps[0], role: 'MAGIC' }] }, agents), /Unknown/);
  assert.deepEqual(st.serialize(), before);
});

test('duplicate creation and unsupported edits fail without modifying station', () => {
  const st = WM.create(WM.starterDoc());
  const made = create(st, spec, agents);
  const before = st.serialize();
  assert.throws(() => create(st, spec, agents), /already exists/);
  assert.throws(() => edit(st, made.steps[0], { agentId: 'unknown' }), /Only/);
  assert.throws(() => edit(st, 'missing', { brief: 'test' }), /Unknown/);
  assert.deepEqual(st.serialize(), before);
});
