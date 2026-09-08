'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const Simulation = require('../frontend/world-next/simulation.js');
const Orientation = require('../frontend/world-next/orientation.js');
const WorldModel = require('../frontend/app/worldmodel.js');
const Bridge = require('../frontend/world-next/bridge.js');
const Pipeline = require('../frontend/app/pipeline.js');
const Art = require('../frontend/world-next/art.js');
const root = path.resolve(__dirname, '../frontend/world-next');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const catalog = json(path.join(root, 'catalog.json')).items;
const specs = new Map(catalog.map(s => [s.id, s]));
const copy = value => JSON.parse(JSON.stringify(value));
WorldModel.setPropRules(id => specs.get(id) || null);

// This import is a TEST-ONLY metadata oracle. The actual client dependency graph
// is checked below and cannot load this renderer or any other legacy visual code.
const canonical = require('../frontend/app/propsprites.js');
test('all canonical catalog identities, placement flags and authored facing rules survive the data export', () => {
  assert.equal(specs.size, catalog.length, 'no duplicate catalog identities');
  assert.deepEqual(catalog.map(s => s.id), canonical.CATALOG.map(s => s.id));
  for (const old of canonical.CATALOG) {
    const spec = specs.get(old.id);
    for (const [field, value] of Object.entries(old)) assert.deepEqual(spec[field], value, old.id + '.' + field);
    assert.deepEqual(spec.facings, canonical.facings(old.id), old.id + ' supported facings');
    assert.equal(spec.canRotate, canonical.canRotate(old.id), old.id + ' rotation permission');
    assert.equal(spec.canMirror, canonical.canMirror(old.id), old.id + ' mirror permission');
    assert.equal(typeof spec.blocks, 'boolean', old.id + ' explicit collision metadata');
    assert.equal(Art.getSpec(old.id).placeholder, undefined, old.id + ' has fresh art coverage');
  }
});

test('orientation cycles only legal facings and preserves every canonical rotated footprint', () => {
  for (const spec of catalog) {
    const before = JSON.stringify(spec);
    for (let r = 0; r < 4; r++) {
      assert.deepEqual(Orientation.box(spec, r), canonical.footprintAt(spec.id, r), spec.id + ' box at ' + r);
      assert.equal(Orientation.nextFacing(spec, r), canonical.nextFacing(spec.id, r), spec.id + ' clockwise at ' + r);
      assert.equal(Orientation.nextFacing(spec, r, -1), canonical.nextFacing(spec.id, r, -1), spec.id + ' counterclockwise at ' + r);
    }
    assert.equal(Orientation.canMirror(spec), spec.canMirror);
    assert.equal(JSON.stringify(spec), before, 'orientation does not modify ' + spec.id);
  }
  assert.equal(Orientation.nextFacing(specs.get('desk'), 0), 0, 'fixed desk cannot turn');
  assert.equal(Orientation.nextFacing(specs.get('dinertable'), 0), 3, 'skip unsupported diner-table facings');
  assert.deepEqual(Orientation.box(specs.get('dinertable'), 3), { w: 2, h: 3 });
  assert.deepEqual(Orientation.box(specs.get('arcade'), 1), { w: 1, h: 2 }, 'upright drawing height never becomes width');
  assert.deepEqual(Orientation.box(null), { w: 1, h: 1 });
  assert.equal(Orientation.canMirror(null), false);
});

function station(options = {}) {
  const doc = WorldModel.defaultDoc(123), id = doc.meta.spawnRoomId;
  doc.rooms[id].rects = options.rects || [{ x1: -5, y1: -5, x2: 5, y2: 5 }];
  doc.props = copy(options.props || []);
  return WorldModel.create(doc);
}
function simulation(model = station(), roster = [{ id: 'agent', name: 'NOVA' }]) {
  const sim = Simulation.create(); sim.setStation(model); sim.setRoster(roster);
  return sim;
}
function placeActor(sim, x, y) {
  const actor = sim.actors()[0];
  Object.assign(actor, { x: x + .5, y: y + .5, path: [], wait: 100, moving: false });
  return actor;
}
function finishRoute(sim, actor, label) {
  for (let frame = 0; actor.path.length && frame < 1500; frame++) {
    sim.tick(.025);
    assert.ok(Number.isFinite(actor.x) && Number.isFinite(actor.y), label + ' finite position');
    assert.ok(sim.walkable(Math.floor(actor.x), Math.floor(actor.y)), label + ' crossed blocked tile ' + actor.x + ',' + actor.y);
  }
  assert.equal(actor.path.length, 0, label + ' completed the reachable route');
}

test('catalog collision, wall mounting, table mounting and decals retain real model behavior', () => {
  const m = station({ rects: [{ x1: -8, y1: -8, x2: 8, y2: 8 }] });
  const put = (id, x, y, rotation = 0) => {
    const s = specs.get(id), size = Orientation.box(s, rotation);
    return m.addProp({ t: id, x, y, ...size, r: rotation, block: s.blocks !== false });
  };
  assert.equal(put('rug', -4, -3).ok, true);
  assert.equal(put('crate', -3, -2).ok, true, 'solid furniture may stand on a walkable rug');
  assert.equal(put('weaponrack', 0, 0).ok, false, 'wall fixture needs a real north wall');
  assert.equal(put('weaponrack', 0, -8).ok, true);
  assert.equal(put('plasmaglobe', 3, 3).ok, false, 'table-mounted globe needs a host');
  const table = put('lowtable', 2, 3); assert.equal(table.ok, true);
  const globe = put('plasmaglobe', 3, 3); assert.equal(globe.ok, true);
  assert.equal(m.mountOf(m.propById(globe.id)), 'surface');
  const geo = m.projectGeometry(), at = (x, y) => geo.walkable(x - geo.origin.tx, y - geo.origin.ty);
  assert.equal(at(-4, -3), true, 'unoccupied rug is traversable');
  assert.equal(at(-3, -2), false, 'crate blocks the deck');
  assert.equal(at(0, -8), true, 'wall fixture leaves floor traversable');
});

test('simulation preserves signed coordinates and snaps a blocked click to walkable deck', () => {
  const sim = simulation(station({ props: [{ id: 'solid', t: 'crate', x: 0, y: 0, w: 1, h: 1 }] }));
  const actor = placeActor(sim, -3, -2);
  assert.deepEqual(sim.nearest(-3.1, -2.2), { x: -3.5, y: -2.5 });
  const target = sim.nearest(0, 0);
  assert.ok(sim.walkable(Math.floor(target.x), Math.floor(target.y)));
  assert.equal(sim.move('missing', 0, 0), false);
  assert.equal(sim.move('agent', 0, 0), true);
  finishRoute(sim, actor, 'blocked target recovery');
  assert.ok(Math.hypot(actor.x - target.x, actor.y - target.y) < .081);
});

test('smoothed walking never enters a solid prop at the former .88-anchor clipping case', () => {
  const sim = simulation(station({ props: [{ id: 'solid', t: 'crate', x: 0, y: 0, w: 1, h: 1 }] }));
  const actor = placeActor(sim, -3, -3);
  assert.equal(sim.move('agent', 3, 1), true);
  finishRoute(sim, actor, 'oblique walk past crate');
  assert.ok(Math.hypot(actor.x - 3.5, actor.y - 1.5) < .081);
});

test('mid-walk retargeting remains on deck around props in all approach quadrants', () => {
  const sim = simulation(station({ props: [{ id: 'solid', t: 'crate', x: 0, y: 0, w: 1, h: 1 }] }));
  const cases = [
    [-3,-3, 3,1, -2,3], [3,-3, -3,1, 3,3], [-3,3, 3,-1, -3,-3], [3,3, -3,-1, 3,-3],
    [-3,0, 3,0, 0,-3], [0,-3, 0,3, -3,0], [3,0, -3,0, 0,3], [0,3, 0,-3, 3,0]
  ];
  for (const [sx, sy, tx, ty, rx, ry] of cases) {
    const a = placeActor(sim, sx, sy); assert.equal(sim.move(a.id, tx, ty), true);
    for (let i = 0; i < 7; i++) sim.tick(.05);
    assert.equal(sim.move(a.id, rx, ry), true);
    finishRoute(sim, a, 'retarget from ' + [sx, sy]);
    assert.ok(Math.hypot(a.x - rx - .5, a.y - ry - .5) < .081);
  }
});

test('disconnected rooms refuse walking routes and station edits clear obsolete movement', () => {
  const m = station();
  assert.equal(m.addRoom({ kind: 'lab', rect: { x1: 10, y1: -3, x2: 16, y2: 3 } }).ok, true);
  const sim = simulation(m), actor = placeActor(sim, -3, -3);
  assert.equal(sim.move(actor.id, 12, 0), false, 'unconnected but walkable room is unreachable');
  assert.equal(sim.move(actor.id, 3, 3), true);
  sim.tick(.05);
  const x = Math.floor(actor.x), y = Math.floor(actor.y);
  assert.equal(m.addProp({ t: 'crate', x, y, w: 1, h: 1 }).ok, true);
  sim.setStation(m);
  assert.equal(actor.path.length, 0, 'old path invalidated by geometry edit');
  assert.ok(sim.walkable(Math.floor(actor.x), Math.floor(actor.y)), 'actor relocated out of new solid prop');
  const empty = m.serialize(); empty.rooms = {}; empty.order = []; empty.props = []; empty.meta.spawnRoomId = null;
  sim.setStation(WorldModel.create(empty));
  assert.equal(actor.unplaced, true, 'no floor means no invented position');
  assert.equal(sim.move(actor.id, 0, 0), false);
  sim.setStation(station());
  assert.equal(actor.unplaced, false, 'real deck restoration makes the actor placeable again');
});

test('sealing a real airlock removes the inter-room route while preserving each interior', () => {
  const m = station();
  assert.equal(m.addRoom({ kind: 'lab', rect: { x1: 10, y1: -3, x2: 16, y2: 3 } }).ok, true);
  assert.equal(m.placeHallway({ rect: { x1: 6, y1: -1, x2: 9, y2: 0 } }).ok, true);
  const lock = m.addProp({ t: 'airlock', x: 14, y: 1, w: 1, h: 1, door: 'open', block: false });
  assert.equal(lock.ok, true);
  const sim = simulation(m), actor = placeActor(sim, -3, 0);
  assert.equal(sim.move(actor.id, 12, 0), true, 'open airlock connects the laboratory');
  assert.equal(m.setDoorState(lock.id, 'closed').ok, true); sim.setStation(m);
  assert.equal(sim.move(actor.id, 12, 0), false, 'closed airlock seals the laboratory boundary');
  assert.equal(sim.move(actor.id, -2, 2), true, 'interior movement remains valid');
  assert.equal(m.setDoorState(lock.id, 'open').ok, true); sim.setStation(m);
  assert.equal(sim.move(actor.id, 12, 0), true);
  finishRoute(sim, actor, 'walking through reopened threshold');
});

test('long frames are bounded and presentation timers never invent work', () => {
  const sim = simulation(), actor = placeActor(sim, -3, -3);
  assert.equal(sim.move(actor.id, 3, 3), true);
  const before = { x: actor.x, y: actor.y }; sim.tick(60);
  assert.ok(Math.hypot(actor.x - before.x, actor.y - before.y) <= .106, 'tab suspension cannot jump through the station');
  for (let i = 0; i < 3000; i++) sim.tick(.05);
  assert.equal(actor.working, false, 'ambient movement cannot manufacture harness work');
});

test('work presentation requires an identified live run and a current connected transport', () => {
  const sim = simulation(), a = sim.actors()[0];
  for (const status of ['queued', 'connecting', 'ended', 'done', 'complete', 'failed', 'error', 'cancelled']) {
    sim.updateWork([{ agentId: a.id, runId: 'run1', status }], true);
    assert.equal(a.working, false, status + ' is not active work');
  }
  sim.updateWork([{ agentId: a.id, status: 'working' }], true);
  assert.equal(a.working, false, 'an identity-free status string is not a proven run');
  sim.updateWork([{ agentId: 'another-agent', runId: 'run1', status: 'working' }], true);
  assert.equal(a.working, false, 'another agent cannot light this actor');
  sim.updateWork([{ agentId: a.id, runId: 'run1', status: 'working' }], true);
  assert.equal(a.working, true); assert.equal(a.runId, 'run1');
  sim.updateWork([{ agentId: a.id, runId: 'run1', status: 'working' }], false);
  assert.equal(a.working, false); assert.equal(a.workUnknown, true);
  sim.updateWork([], true);
  assert.equal(a.working, false); assert.equal(a.workUnknown, false);
});

test('waiting and unconfirmed records stay distinct from work, and stale rows cannot hide newer live proof', () => {
  const sim = simulation(), a = sim.actors()[0], row = status => ({ agentId: a.id, runId: status, status });
  for (const status of ['waiting', 'awaiting_approval']) {
    sim.updateWork([row(status)], true);
    assert.equal(a.working, false); assert.equal(a.waiting, true); assert.equal(a.workUnknown, false);
  }
  sim.updateWork([row('unknown')], true);
  assert.equal(a.working, false); assert.equal(a.waiting, false); assert.equal(a.workUnknown, true);
  sim.updateWork([row('unknown'), row('working')], true);
  assert.equal(a.working, true, 'identified live proof outranks an older unconfirmed record');
  assert.equal(a.runId, 'working');
});

test('bridge-confirmed lifecycle reaches the simulation without speculative starts or timed completions', async t => {
  const doc = station().serialize(), sources = [];
  let live = { runs: [], prompts: [], summons: [], queues: [] };
  class Source { constructor() { sources.push(this); } close() {} push(name, payload) { this.onmessage({ data: JSON.stringify({ name, payload }) }); } }
  const reply = value => new Response(JSON.stringify(value));
  const bridge = new Bridge({ token: 'test-only', WorldModel, Pipeline, EventSource: Source,
    pageUrl: 'http://127.0.0.1:9207/world-next/index.html', fetch: async url => {
      switch (new URL(url).pathname) {
        case '/api/runtime/agent': return reply({ ok: true, agents: [{ agentId: 'agent', name: 'NOVA' }] });
        case '/api/save': return reply({ save: { schema: 'starnet.save', agent: { id: 'agent' }, station: doc } });
        case '/api/toolsets': return reply({ objects: [] });
        case '/api/state/snapshot': return reply(live);
        default: throw Error('Unexpected request ' + url);
      }
    } });
  t.after(() => bridge.dispose());
  const sim = simulation(); bridge.subscribe(s => sim.updateWork(s.runs, s.connection.status === 'connected'));
  await bridge.start(); const a = sim.actors()[0], events = sources[0];
  assert.equal(a.working, false);
  events.push('agent.token', { agentId: a.id, runId: 'not-started', delta: 'hello' });
  assert.equal(a.working, false, 'token without confirmed start is not a run');
  events.push('agent.run.start', { agentId: a.id, runId: 'real' });
  assert.equal(a.working, true);
  for (let i = 0; i < 1000; i++) sim.tick(.05);
  assert.equal(a.working, true, 'elapsed presentation time cannot declare a confirmed run complete');
  events.push('permission.prompt', { agentId: a.id, runId: 'real', promptId: 'permission' });
  assert.equal(a.working, false); assert.equal(a.waiting, true);
  events.push('permission.response', { promptId: 'permission' });
  assert.equal(a.working, true);
  events.onerror(); assert.equal(a.working, false); assert.equal(a.workUnknown, true);
  live = { ...live, runs: [{ agentId: a.id, runId: 'real' }] };
  await bridge._reconcile();
  assert.equal(a.working, false, 'snapshot cannot override a disconnected transport');
  events.push('agent.run.start', { agentId: a.id, runId: 'real' });
  assert.equal(a.working, true);
  events.push('agent.run.end', { agentId: a.id, runId: 'real', reason: 'done' });
  assert.equal(a.working, false); assert.equal(a.workUnknown, false);
});

const members = ['nova', 'ember', 'fern'];
const directions = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
const cardinal = ['north', 'south', 'east', 'west'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
test('all three original crew exports contain real 64px eight-facing sprites and four eight-frame walk cycles', () => {
  const identities = new Set(), portraits = new Set();
  for (const name of members) {
    const dir = path.join(root, 'assets/characters', name), meta = json(path.join(dir, 'metadata.json')), state = meta.states[0];
    identities.add(state.character.id);
    assert.equal(state.character.directions, 8, name + ' generated direction count');
    assert.deepEqual(Object.keys(state.frames.rotations).sort(), [...directions].sort());
    const animations = Object.values(state.frames.animations);
    assert.ok(animations.length >= 1, name + ' walk export exists');
    const walk = animations[0]; assert.deepEqual(Object.keys(walk).sort(), [...cardinal].sort());
    const check = relative => {
      const file = path.resolve(dir, relative);
      assert.ok(file.startsWith(dir + path.sep), name + ' sprite stays in its own asset directory');
      const bytes = fs.readFileSync(file);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [64, 64], name + '/' + relative);
      assert.equal(bytes[25], 6, 'sprites have RGBA transparency');
      return hash(bytes);
    };
    const facingHashes = new Set(Object.values(state.frames.rotations).map(check));
    assert.equal(facingHashes.size, 8, name + ' facings are distinct art');
    portraits.add(check(state.frames.rotations.south));
    for (const d of cardinal) {
      assert.equal(walk[d].length, 8, name + ' ' + d + ' has eight frames');
      assert.equal(new Set(walk[d].map(check)).size, 8, name + ' ' + d + ' really animates');
    }
  }
  assert.equal(identities.size, 3, 'three separate generated character identities');
  assert.equal(portraits.size, 3, 'three distinct portraits');
});

async function characterClient(options = {}) {
  const requested = [], imagePaths = [];
  const context = { module: { exports: {} }, console,
    fetch: async url => { requested.push(url); return { ok: !options.badMetadata, json: async () => json(path.join(root, url)) }; },
    Image: class {
      set src(url) {
        this.url = url; imagePaths.push(url);
        queueMicrotask(() => { if (options.badImage || !fs.existsSync(path.join(root, url))) this.onerror(); else this.onload(); });
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'characters.js'), 'utf8'), context, { filename: 'characters.js' });
  return { client: await context.module.exports.create(), requested, imagePaths };
}
test('character loader and renderer select actual facing/animation assets without inventing motion while idle', async () => {
  const { client, requested, imagePaths } = await characterClient();
  assert.equal(requested.length, 3); assert.equal(imagePaths.length, 120);
  assert.equal(new Set(imagePaths).size, 120);
  assert.deepEqual(copy(client.stats()), { ready: true, characters: 3, images: 120, directions: 8, walkDirections: 4, walkFrames: 8 });
  const drawn = [], marks = [], ctx = { save() {}, restore() {}, drawImage: (...args) => drawn.push(args), fillRect: (...args) => marks.push(args) };
  for (let i = 0; i < members.length; i++) {
    const base = 'assets/characters/' + members[i] + '/Idle/';
    const a = { id: 'crew' + i, appearance: i, x: -2.5, y: 4.5, phase: 0, moving: false, working: false };
    assert.equal(client.portrait(i), base + 'rotations/south.png');
    for (const direction of directions) {
      a.dir = direction; client.draw(ctx, a, 0);
      assert.equal(drawn.at(-1)[0].url, base + 'rotations/' + direction + '.png');
      const first = drawn.at(-1)[0].url; client.draw(ctx, a, 4000);
      assert.equal(drawn.at(-1)[0].url, first, 'idle pose is stable');
    }
    a.moving = true;
    for (const direction of cardinal) {
      a.dir = direction; const cycle = [];
      for (let frame = 0; frame < 8; frame++) {
        client.draw(ctx, a, frame * 95); cycle.push(drawn.at(-1)[0].url);
        assert.equal(cycle.at(-1), base + 'animations/animating/' + direction + '/frame_' + String(frame).padStart(3, '0') + '.png');
      }
      assert.equal(new Set(cycle).size, 8);
    }
    a.unplaced = true; const count = drawn.length; client.draw(ctx, a, 0);
    assert.equal(drawn.length, count, 'unplaceable crew do not appear in space');
  }
  assert.equal(marks.length, 0, 'idle/moving sprites alone never display work markers');
});

test('missing character metadata or frames fail loading instead of claiming ready', async () => {
  await assert.rejects(characterClient({ badMetadata: true }), /metadata could not load/);
  await assert.rejects(characterClient({ badImage: true }), /sprite could not load/);
});

test('the executable new entry imports mechanics data modules and exclusively fresh visual modules/assets', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map(m => m[1]);
  assert.ok(scripts.includes('client.js') && scripts.includes('scene.js') && scripts.includes('art.js') && scripts.includes('characters.js'));
  assert.ok(scripts.includes('../app/worldmodel.js') && scripts.includes('../app/pipeline.js'));
  const oldMechanics = new Set(['../app/worldmodel.js', '../app/pipeline.js']);
  for (const relative of scripts) {
    assert.ok(!relative.startsWith('../') || oldMechanics.has(relative), 'unexpected legacy import: ' + relative);
    const file = path.resolve(root, relative); assert.ok(fs.existsSync(file), relative + ' exists');
    if (oldMechanics.has(relative)) continue;
    const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /\b(?:PropSprites|StationBake|WorldSurface|WorldLight|WorldRenderer|MiniSprites|AgentSprites|Skins|Terrain)\b/, relative + ' cannot depend on a former visual global');
    assert.doesNotMatch(source, /(?:src\s*=\s*|(?:require|import|fetch)\s*\()["'][^"']*(?:\.\.\/app\/|assets\/(?:props|skins|agents)\/)/, relative + ' cannot pull legacy visuals dynamically');
  }
  const css = fs.readFileSync(path.join(root, 'world-next.css'), 'utf8');
  assert.doesNotMatch(css, /(?:@import|url\()[^;\n]*\.\.\/app\//, 'stylesheet does not import old visual assets');
});
