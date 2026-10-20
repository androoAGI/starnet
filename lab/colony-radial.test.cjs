'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WM = require('../frontend/app/worldmodel.js');
const { prepare } = require('./colony-radial.cjs');
const compact = require('./colony-compact.cjs');

function fixture() {
  const st = WM.create(WM.starterDoc()).serialize();
  st.rooms = {}; st.order = []; st.props = []; st.links = []; st.edges = []; st.belts = {}; st._nid = 100;
  const rooms = [
    ['r1', 'Lifestruct', -20, 0, 17, 71], ['r17', 'HomeStackR', 27, -7, 64, 64],
    ['r42', 'ORCHESTRATOR', 18, 2, 26, 8], ['r44', 'Ashveil', 65, -4, 102, 67]
  ];
  for (const [id, name, x1, y1, x2, y2] of rooms) {
    st.rooms[id] = { id, name, kind: name === 'ORCHESTRATOR' ? 'bridge' : 'hab', rects: [{ x1, y1, x2, y2 }], floorPaint: {} };
    st.order.push(id);
    st.props.push({ id: 'p' + id, t: 'desk', x: x1 + 3, y: y1 + 3, w: 2, h: 1, agentId: 'agent_' + id });
  }
  st.meta.spawnRoomId = 'r1';
  return { station: st, agent: { id: 'agent', model: 'unchanged' }, agents: [{ id: 'specialist' }], colonyInstallation: { commitId: 'unchanged' } };
}

test('radial refit preserves identities and contents, makes three spokes and a central circular room', () => {
  const save = fixture(), before = structuredClone(save), result = prepare(save);
  assert.deepEqual(save, before, 'Preview must be pure');
  assert.deepEqual(result.save.agent, save.agent);
  assert.deepEqual(result.save.agents, save.agents);
  assert.deepEqual(result.save.colonyInstallation, save.colonyInstallation);
  assert.equal(result.report.spokes, 3);
  assert.equal(result.report.routingValid, true);
  assert(result.report.connectedTiles > 0);
  const hub = result.save.station.rooms.r42;
  assert(hub.rects.length > 1);
  assert(hub.rects.some(r => r.x1 <= 0 && r.x2 >= 0 && r.y1 <= 0 && r.y2 >= 0));
  assert.equal(result.save.station.meta.spawnRoomId, 'r42');
  for (const prop of result.save.station.props) {
    const old = save.station.props.find(p => p.id === prop.id);
    const stripXY = ({ x, y, ...rest }) => rest;
    assert.deepEqual(stripXY(prop), stripXY(old));
  }
});

test('refit refuses off-floor contents, unknown rooms and a second application', () => {
  const bad = fixture(); bad.station.props[0].x = 1000;
  assert.throws(() => prepare(bad));
  const unknown = fixture(); unknown.station.rooms.r1.name = 'Unrelated user room';
  assert.throws(() => prepare(unknown), /Unknown room/);
  assert.throws(() => prepare(prepare(fixture()).save), /unknown\/additional rooms/);
});

test('compact refit keeps positions and all contents, uses shallow rounded rectangles and is idempotent', () => {
  const radial = prepare(fixture()).save, before = structuredClone(radial);
  const result = compact.prepare(radial);
  assert.deepEqual(radial, before);
  for (const field of ['props', 'links', 'belts', 'edges']) assert.deepEqual(result.save.station[field], radial.station[field]);
  for (const field of ['agent', 'agents', 'colonyInstallation']) assert.deepEqual(result.save[field], radial[field]);
  assert.equal(result.save.station.rooms.r1.rects.length, 3);
  assert(result.report.connectedTiles < 20252);
  assert.deepEqual(compact.prepare(result.save).save, result.save);
  const offFloor = structuredClone(radial); offFloor.station.props[0].x = 900;
  assert.throws(() => compact.prepare(offFloor));
  const painted = structuredClone(radial); painted.station.rooms.r1.floorPaint['0,-122'] = 'amber';
  assert.throws(() => compact.prepare(painted), /painted floor/);
});

test('packing retains room sizes and identities, leaves connected corridors and is idempotent', () => {
  const original = compact.prepare(prepare(fixture()).save).save;
  const before = structuredClone(original), result = compact.pack(original);
  assert.deepEqual(original, before);
  assert.deepEqual(result.save.agents, original.agents);
  assert.deepEqual(result.save.colonyInstallation, original.colonyInstallation);
  for (const [id, room] of Object.entries(original.station.rooms)) {
    if (room.kind === 'corridor') continue;
    const size = r => [Math.max(...r.rects.map(q => q.x2)) - Math.min(...r.rects.map(q => q.x1)), Math.max(...r.rects.map(q => q.y2)) - Math.min(...r.rects.map(q => q.y1))];
    assert.deepEqual(size(result.save.station.rooms[id]), size(room));
  }
  assert.equal(result.report.closerTogether, true);
  assert.equal(result.report.routingValid, true);
  assert.deepEqual(compact.pack(result.save).save, result.save);
});

test('snug rooms follow occupied footprints and keep desk identities when repacking furniture', () => {
  const input = fixture();
  for (const room of Object.values(input.station.rooms).filter(r => r.name !== 'ORCHESTRATOR')) {
    const r = room.rects[0];
    input.station.props.push({ id: 'plant_' + room.id, t: 'plant', x: r.x1 + 8, y: r.y1 + 8, w: 1, h: 1 });
  }
  const radial = compact.pack(compact.prepare(prepare(input).save).save).save;
  const before = structuredClone(radial), result = compact.snug(radial);
  assert.deepEqual(radial, before);
  assert.equal(result.report.contentMargin, 3);
  assert.equal(result.report.movedDesks, 3);
  assert.deepEqual(result.save.agents, radial.agents);
  assert.deepEqual(result.save.colonyInstallation, radial.colonyInstallation);
  assert.deepEqual(result.save.station.props.map(p => p.id), radial.station.props.map(p => p.id));
  assert.deepEqual(compact.snug(result.save).save, result.save);
  assert.equal(result.report.routingValid, true);
  const shorter = compact.shortHalls(result.save);
  assert.equal(shorter.report.shortCorridors, true);
  assert.deepEqual(shorter.report.rooms, result.report.rooms, 'Only corridors/positions change, not room sizes');
  assert.deepEqual(compact.shortHalls(shorter.save).save, shorter.save);
});
