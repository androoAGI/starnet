'use strict';

// Geometry-only refinement of the installed star layout. No contents are moved.
const fs = require('node:fs');
const path = require('node:path');
const A = require('node:assert/strict');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const { bubble } = require('./colony-radial.cjs');
const { client } = require('./workflow.cjs');
const CENTRES = { Lifestruct: [0, -78], Ashveil: [-68, 42], HomeStackR: [68, 42], ORCHESTRATOR: [0, 0] };
const inside = (room, x, y) => room.rects.some(r => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2);

function prepare(save, centres = CENTRES, hubRadius = 12) {
  const next = structuredClone(save), d = next.station, before = WM.create(save.station);
  A.equal(d.meta.colonyLayout, 'radial-v1', 'Requires the installed radial layout');
  const rooms = Object.values(d.rooms).filter(r => r.kind !== 'corridor');
  const halls = Object.values(d.rooms).filter(r => r.kind === 'corridor');
  A.equal(rooms.length, 4); A.equal(halls.length, 3);
  for (const room of rooms) {
    A(centres[room.name], 'Unknown room');
    const [cx, cy] = centres[room.name], points = [];
    for (const p of d.props) if (before.roomAt(p.x, p.y) === room.id) {
      for (let y = p.y; y < p.y + (p.h || 1); y++) for (let x = p.x; x < p.x + (p.w || 1); x++) points.push([x, y]);
    }
    for (const k of Object.keys(d.belts)) { const [x, y] = k.split(',').map(Number); if (before.roomAt(x, y) === room.id) points.push([x, y]); }
    A(points.length, 'Refuse empty room without a content-derived size');
    if (room.name === 'ORCHESTRATOR') room.rects = bubble(cx, cy, hubRadius);
    else {
      const hw = Math.max(10, ...points.map(([x]) => Math.abs(x - cx))) + 3;
      const hh = Math.max(10, ...points.map(([, y]) => Math.abs(y - cy))) + 3;
      const x1 = cx - hw, x2 = cx + hw, y1 = cy - hh, y2 = cy + hh;
      // Native raster bevel: shallow three-tile corner rounding, no renderer fork.
      room.rects = [{ x1: x1 + 3, x2: x2 - 3, y1, y2: y1 + 2 },
        { x1, x2, y1: y1 + 3, y2: y2 - 3 }, { x1: x1 + 3, x2: x2 - 3, y1: y2 - 2, y2 }];
    }
    for (const [x, y] of points) A(inside(room, x, y), 'Refit would cut room contents');
    // Floor paint is also user work: retain painted tiles even when not furnished.
    for (const k of Object.keys(room.floorPaint || {})) { const [x, y] = k.split(',').map(Number); A(inside(room, x, y), 'Refit would cut painted floor'); }
  }
  const hallTiles = new Set();
  for (const hall of halls) {
    const name = hall.name.replace('Verbindung · ', '');
    A(centres[name] && name !== 'ORCHESTRATOR', 'Unknown corridor');
    const [cx, cy] = centres[name], cells = new Map();
    for (let i = 0; i <= 300; i++) {
      const x = Math.round(cx * i / 300), y = Math.round(cy * i / 300);
      for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
        const tx = x + ox, ty = y + oy;
        const key = tx + ',' + ty;
        if (!rooms.some(r => inside(r, tx, ty)) && !hallTiles.has(key)) {
          if (!cells.has(ty)) cells.set(ty, new Set()); cells.get(ty).add(tx);
          hallTiles.add(key);
        }
      }
    }
    hall.rects = [];
    for (const [y, values] of cells) {
      const xs = [...values].sort((a, b) => a - b); let start = xs[0], end = start;
      for (const x of xs.slice(1)) { if (x === end + 1) end = x; else { hall.rects.push({ x1: start, x2: end, y1: y, y2: y }); start = end = x; } }
      hall.rects.push({ x1: start, x2: end, y1: y, y2: y });
    }
  }
  const tiles = new Set();
  for (const room of Object.values(d.rooms)) for (const r of room.rects) for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) {
    const k = x + ',' + y; A(!tiles.has(k), 'Rooms overlap at ' + k + ' (' + room.name + ')'); tiles.add(k);
  }
  const st = WM.create(d);
  for (const p of d.props) for (let y = p.y; y < p.y + (p.h || 1); y++) for (let x = p.x; x < p.x + (p.w || 1); x++) A.equal(st.roomAt(x, y), before.roomAt(x, y), 'Prop lost its room');
  for (const k of Object.keys(d.belts)) A(tiles.has(k), 'Off-floor conveyor');
  for (const l of d.links) for (const t of l.path || []) A(tiles.has(t.x + ',' + t.y), 'Off-floor link');
  const seen = new Set(), queue = [tiles.values().next().value];
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i]; if (seen.has(k)) continue; seen.add(k);
    const [x, y] = k.split(',').map(Number);
    for (const n of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) { const key = n.join(','); if (tiles.has(key) && !seen.has(key)) queue.push(key); }
  }
  A.equal(seen.size, tiles.size, 'Disconnected floor');
  const plan = P.compileRoutingPlan(st.projectGeometry()), oldPlan = P.compileRoutingPlan(before.projectGeometry());
  A(P.ok(plan) && P.ok(oldPlan), 'Invalid routing'); A.deepEqual(plan.agentOfDock, oldPlan.agentOfDock);
  for (const field of ['props', 'belts', 'links', 'edges']) A.deepEqual(d[field], save.station[field]);
  return { save: next, plan, report: { routingValid: true, connectedTiles: tiles.size,
    rooms: rooms.map(r => ({ name: r.name, width: Math.max(...r.rects.map(q => q.x2)) - Math.min(...r.rects.map(q => q.x1)) + 1,
      height: Math.max(...r.rects.map(q => q.y2)) - Math.min(...r.rects.map(q => q.y1)) + 1 })) } };
}

function pack(save, hubRadius = 12, targets = null) {
  const next = structuredClone(save), d = next.station;
  const centres = targets || { Lifestruct: [0, -62], Ashveil: [-44, 28], HomeStackR: [44, 28], ORCHESTRATOR: [0, 0] };
  const rooms = Object.values(d.rooms).filter(r => r.kind !== 'corridor');
  const moves = new Map(), propMoves = new Map();
  for (const room of rooms) {
    A(centres[room.name], 'Unknown room');
    const [cx, cy] = centres[room.name];
    const mid = axis => Math.round((Math.min(...room.rects.map(r => r[axis + '1'])) + Math.max(...room.rects.map(r => r[axis + '2']))) / 2);
    moves.set(room.id, { dx: cx - mid('x'), dy: cy - mid('y') });
  }
  const movement = (x, y) => {
    const room = rooms.find(r => inside(r, x, y));
    A(room, 'Refuse content outside business rooms');
    return moves.get(room.id);
  };
  for (const prop of d.props) {
    const m = movement(prop.x, prop.y); propMoves.set(prop.id, m);
    for (let y = prop.y; y < prop.y + (prop.h || 1); y++) for (let x = prop.x; x < prop.x + (prop.w || 1); x++) A.equal(movement(x, y), m, 'Straddling prop');
    prop.x += m.dx; prop.y += m.dy;
  }
  const belts = {};
  for (const [key, value] of Object.entries(d.belts)) { const [x, y] = key.split(',').map(Number), m = movement(x, y); belts[[x + m.dx, y + m.dy].join(',')] = value; }
  d.belts = belts;
  for (const link of d.links) {
    const m = propMoves.get(link.from.prop); A(m, 'Unknown link source');
    A.deepEqual(propMoves.get(link.to.prop), m, 'Refuse cross-room conveyor');
    for (const t of link.path || []) { A.deepEqual(movement(t.x, t.y), m, 'Cross-room conveyor path'); t.x += m.dx; t.y += m.dy; }
  }
  for (const room of rooms) {
    const { dx, dy } = moves.get(room.id);
    room.rects = room.rects.map(r => ({ x1: r.x1 + dx, x2: r.x2 + dx, y1: r.y1 + dy, y2: r.y2 + dy }));
    const paint = {};
    for (const [key, value] of Object.entries(room.floorPaint || {})) { const [x, y] = key.split(',').map(Number); paint[[x + dx, y + dy].join(',')] = value; }
    room.floorPaint = paint;
  }
  const result = prepare(next, centres, hubRadius);
  A.deepEqual(result.save.agents, save.agents);
  A.deepEqual(result.save.agent, save.agent);
  A.deepEqual(result.save.colonyInstallation, save.colonyInstallation);
  result.report.closerTogether = true;
  return result;
}

function shortHalls(save) {
  // Derive landing positions from the ACTUAL room envelopes, not their earlier
  // large-room centres. Keep a five-tile gap to the hub/upper business room.
  const rooms = Object.values(save.station.rooms);
  const half = name => {
    const r = rooms.find(r => r.name === name); A(r, 'Missing business room');
    return { x: Math.ceil((Math.max(...r.rects.map(q => q.x2)) - Math.min(...r.rects.map(q => q.x1))) / 2),
      y: Math.ceil((Math.max(...r.rects.map(q => q.y2)) - Math.min(...r.rects.map(q => q.y1))) / 2) };
  };
  const life = half('Lifestruct'), left = half('Ashveil'), right = half('HomeStackR'), hub = half('ORCHESTRATOR');
  const gap = 5;
  const targets = { ORCHESTRATOR: [0, 0], Lifestruct: [0, -(life.y + hub.y + gap)],
    Ashveil: [-(left.x + hub.x + gap), Math.max(left.y, right.y) - hub.y + gap],
    HomeStackR: [right.x + hub.x + gap, Math.max(left.y, right.y) - hub.y + gap] };
  const result = pack(save, 6, targets);
  for (const room of rooms.filter(r => r.kind !== 'corridor')) {
    const after = result.save.station.rooms[room.id];
    const size = r => [Math.max(...r.rects.map(q => q.x2)) - Math.min(...r.rects.map(q => q.x1)), Math.max(...r.rects.map(q => q.y2)) - Math.min(...r.rects.map(q => q.y1))];
    A.deepEqual(size(after), size(room), 'Shortening corridors must not resize rooms');
  }
  result.report.shortCorridors = true;
  return result;
}

function snug(save) {
  const next = structuredClone(save), d = next.station;
  const original = WM.create(save.station);
  let movedDesks = 0;
  for (const room of Object.values(d.rooms).filter(r => r.kind !== 'corridor' && r.name !== 'ORCHESTRATOR')) {
    const props = d.props.filter(p => original.roomAt(p.x, p.y) === room.id);
    const desks = props.filter(p => p.t === 'desk');
    const points = [];
    const add = p => points.push([p.x, p.y], [p.x + (p.w || 1) - 1, p.y + (p.h || 1) - 1]);
    props.filter(p => p.t !== 'desk').forEach(add);
    for (const key of Object.keys(d.belts)) { const [x, y] = key.split(',').map(Number); if (original.roomAt(x, y) === room.id) points.push([x, y]); }
    A(points.length, 'No pipeline/furniture footprint to size the room against');
    // Painted floor is preserved too, rather than silently cropped to machines.
    for (const key of Object.keys(room.floorPaint || {})) points.push(key.split(',').map(Number));
    const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
    let x = minX, y = Math.max(...points.map(p => p[1])) + 3, rowHeight = 0;
    // Previously distant desk rows were holding large empty floor areas open.
    // Place them in a compact working row below the pipelines, keeping every ID.
    for (const desk of desks) {
      if (x > minX && x + (desk.w || 1) - 1 > maxX) { x = minX; y += rowHeight + 1; rowHeight = 0; }
      desk.x = x; desk.y = y;
      x += (desk.w || 1) + 1; rowHeight = Math.max(rowHeight, desk.h || 1);
      add(desk); movedDesks++;
    }
    // Temporary bounding footprint lets pack() carry the content together and
    // recenter it at the existing star positions before rebuilding short spokes.
    room.rects = [{ x1: Math.min(...points.map(p => p[0])) - 3, x2: Math.max(...points.map(p => p[0])) + 3,
      y1: Math.min(...points.map(p => p[1])) - 3, y2: Math.max(...points.map(p => p[1])) + 3 }];
  }
  const result = pack(next, 6);
  A.equal(result.save.station.props.length, save.station.props.length);
  const withoutXY = ({ x, y, ...rest }) => rest;
  for (const prop of result.save.station.props) A.deepEqual(withoutXY(prop), withoutXY(save.station.props.find(p => p.id === prop.id)));
  result.report.movedDesks = movedDesks;
  result.report.contentMargin = 3;
  return result;
}

async function main() {
  const request = await client('http://127.0.0.1:8790', { allowLiveAuthoring: true });
  const current = (await request('/api/save')).save;
  const result = process.argv.includes('--short-halls') ? shortHalls(current) : process.argv.includes('--snug') ? snug(current) : process.argv.includes('--pack') ? pack(current) : prepare(current);
  if (!process.argv.includes('--apply')) return { applied: false, ...result.report };
  const backup = path.resolve(__dirname, '../.lab-state/authoring-backups/before-compact-' + Date.now() + '.json');
  fs.writeFileSync(backup, JSON.stringify(current), { mode: 0o600, flag: 'wx' });
  result.save.updatedAt = Math.max(Date.now(), Number(current.updatedAt || 0) + 1);
  const saved = await request('/api/save', result.save);
  await request('/api/routing', result.plan);
  return { applied: true, revision: saved.revision, backup, ...result.report };
}
module.exports = { prepare, pack, snug, shortHalls };
if (require.main === module) main().then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
