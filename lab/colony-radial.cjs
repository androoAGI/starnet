'use strict';

// Geometry-only refit. Reuses native multi-rectangle rooms and the existing compiler.
// No agents, identities, pipeline IDs, prompts, models or histories are rewritten.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const { client } = require('./workflow.cjs');
const TARGETS = { Lifestruct: [0, -78, 45], Ashveil: [-68, 42, 45], HomeStackR: [68, 42, 45], ORCHESTRATOR: [0, 0, 16] };
const inside = (room, x, y) => room.rects.some(r => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2);

function bubble(cx, cy, radius) {
  // Three-tile bands satisfy the native builder's minimum room dimensions.
  const rects = [];
  for (let y = -radius; y < radius; y += 3) {
    const half = Math.max(2, Math.floor(Math.sqrt(Math.max(0, radius * radius - (y + 1) ** 2))));
    rects.push({ x1: cx - half, x2: cx + half, y1: cy + y, y2: cy + y + 2 });
  }
  return rects;
}

function prepare(save) {
  const next = structuredClone(save), doc = next.station;
  const old = structuredClone(doc);
  assert.equal(Object.keys(doc.rooms).length, 4, 'Refuse unknown/additional rooms');
  const original = WM.create(old);
  const beforePlan = P.compileRoutingPlan(original.projectGeometry());
  assert(P.ok(beforePlan), 'Existing routing must compile before refit');
  const moves = new Map();
  for (const r of Object.values(old.rooms)) {
    assert(TARGETS[r.name], 'Unknown room: ' + r.name);
    const [cx, cy, radius] = TARGETS[r.name];
    const xs = r.rects.flatMap(q => [q.x1, q.x2]), ys = r.rects.flatMap(q => [q.y1, q.y2]);
    const dx = cx - Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
    const dy = cy - Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
    moves.set(r.id, { dx, dy });
    doc.rooms[r.id].rects = bubble(cx, cy, radius);
    const paint = {};
    for (const [key, value] of Object.entries(r.floorPaint || {})) {
      const [x, y] = key.split(',').map(Number);
      paint[[x + dx, y + dy].join(',')] = value;
    }
    doc.rooms[r.id].floorPaint = paint;
  }
  const owner = (x, y) => {
    const rooms = Object.values(old.rooms).filter(r => inside(r, x, y));
    assert.equal(rooms.length, 1, 'Every content tile must belong to exactly one original room');
    return rooms[0].id;
  };
  for (const prop of doc.props) {
    const rid = owner(prop.x, prop.y), { dx, dy } = moves.get(rid);
    for (let y = prop.y; y < prop.y + (prop.h || 1); y++) for (let x = prop.x; x < prop.x + (prop.w || 1); x++) {
      assert.equal(owner(x, y), rid, 'Refuse props straddling rooms');
      assert(inside(doc.rooms[rid], x + dx, y + dy), 'Bubble would cut a prop');
    }
    prop.x += dx; prop.y += dy;
  }
  const translated = {};
  for (const [key, value] of Object.entries(old.belts)) {
    const [x, y] = key.split(',').map(Number), rid = owner(x, y), { dx, dy } = moves.get(rid);
    assert(inside(doc.rooms[rid], x + dx, y + dy), 'Bubble would cut a belt');
    translated[[x + dx, y + dy].join(',')] = value;
  }
  doc.belts = translated;
  for (const link of doc.links || []) {
    const source = old.props.find(p => p.id === link.from.prop);
    const rid = owner(source.x, source.y), move = moves.get(rid);
    for (const tile of link.path || []) {
      assert.equal(owner(tile.x, tile.y), rid, 'Refuse cross-room conveyor path');
      tile.x += move.dx; tile.y += move.dy;
    }
  }
  // Native corridor tiles form three separate spokes, not a ring between brands.
  for (const name of ['Lifestruct', 'Ashveil', 'HomeStackR']) {
    const [cx, cy] = TARGETS[name], cells = new Set();
    for (let i = 0; i <= 200; i++) {
      const x = Math.round(cx * i / 200), y = Math.round(cy * i / 200);
      for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
        const tx = x + ox, ty = y + oy;
        if (!Object.values(doc.rooms).some(r => inside(r, tx, ty))) cells.add(tx + ',' + ty);
      }
    }
    const rows = new Map();
    for (const key of cells) { const [x, y] = key.split(',').map(Number); if (!rows.has(y)) rows.set(y, []); rows.get(y).push(x); }
    const rects = [];
    for (const [y, xs] of [...rows].sort((a, b) => a[0] - b[0])) {
      xs.sort((a, b) => a - b);
      let start = xs[0], end = start;
      for (const x of xs.slice(1)) { if (x === end + 1) end = x; else { rects.push({ x1: start, x2: end, y1: y, y2: y }); start = end = x; } }
      rects.push({ x1: start, x2: end, y1: y, y2: y });
    }
    const id = 'r' + doc._nid++;
    doc.rooms[id] = { id, kind: 'corridor', name: 'Verbindung · ' + name, rects, floorStyle: 'oak', floorMat: 'parquet', wallStyle: 'bone', wallMat: 'courses', hullStyle: null, hullMat: 'stone', tier: 0, floorPaint: {} };
    doc.order.push(id);
  }
  // Spawn/camera anchor follows the new centre; previous room identities remain intact.
  doc.meta.spawnRoomId = Object.values(doc.rooms).find(r => r.name === 'ORCHESTRATOR').id;
  doc.meta.trunkRoomId = doc.meta.spawnRoomId;
  doc.meta.colonyLayout = 'radial-v1';
  const st = WM.create(doc), plan = P.compileRoutingPlan(st.projectGeometry());
  assert(P.ok(plan), 'Refitted routing must compile: ' + JSON.stringify(plan.errors));
  assert.deepEqual(plan.agentOfDock, beforePlan.agentOfDock, 'Pipeline agent assignments must remain identical');
  const occupied = new Map();
  for (const r of Object.values(doc.rooms)) for (const q of r.rects) for (let y = q.y1; y <= q.y2; y++) for (let x = q.x1; x <= q.x2; x++) {
    const key = x + ',' + y;
    assert(!occupied.has(key), 'Overlapping room tiles: ' + key);
    occupied.set(key, r.id);
  }
  // Whole station (including spokes) must be one four-neighbour connected floor.
  const seen = new Set(), queue = [occupied.keys().next().value];
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i]; if (seen.has(key)) continue; seen.add(key);
    const [x, y] = key.split(',').map(Number);
    for (const n of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) { const k = n.join(','); if (occupied.has(k) && !seen.has(k)) queue.push(k); }
  }
  assert.equal(seen.size, occupied.size, 'Disconnected station floor');
  const coords = [...occupied.keys()].map(k => k.split(',').map(Number));
  for (const axis of [0, 1]) { const values = coords.map(p => p[axis]); assert(Math.max(...values) - Math.min(...values) + 1 <= 240, 'Station span limit'); }
  assert.deepEqual(next.agents, save.agents);
  assert.deepEqual(next.colonyInstallation, save.colonyInstallation);
  return { save: next, plan, report: { rooms: 4, spokes: 3, propsPreserved: doc.props.length, linksPreserved: doc.links.length, beltsPreserved: Object.keys(doc.belts).length, connectedTiles: seen.size, routingValid: true } };
}

async function main() {
  const request = await client('http://127.0.0.1:8790', { allowLiveAuthoring: true });
  const current = (await request('/api/save')).save;
  const result = prepare(current);
  if (!process.argv.includes('--apply')) return { applied: false, ...result.report };
  const backup = path.resolve(__dirname, '../.lab-state/authoring-backups/before-radial-' + Date.now() + '.json');
  fs.writeFileSync(backup, JSON.stringify(current), { flag: 'wx', mode: 0o600 });
  result.save.updatedAt = Math.max(Date.now(), current.updatedAt + 1);
  const saved = await request('/api/save', result.save);
  await request('/api/routing', result.plan);
  return { applied: true, revision: saved.revision, backup, ...result.report };
}
module.exports = { prepare, bubble };
if (require.main === module) main().then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
