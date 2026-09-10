/* DEV ONLY — composed station for the World Next renderer acceptance scene.
 * node dev/world-next-seed.cjs                 validates, writes nothing
 * node dev/world-next-seed.cjs --write         creates dev/.scratch-workspace
 * node dev/world-next-seed.cjs --write --refresh  resets ONLY this marked fixture
 * Set SKYNET_PORT to the port the seeded sidecar will use. Stop it before writing.
 * Then run the local model and dev/seed.js --keep as printed by --write.
 * No production paths, credentials, process launches, or invented run results.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const WorldModel = require('../frontend/app/worldmodel.js');
const PropSprites = require('../frontend/app/propsprites.js');
const Pipeline = require('../frontend/app/pipeline.js');
const DEV = path.resolve(__dirname);
const SCRATCH = path.join(DEV, '.scratch-workspace');
const FIXTURE = path.join(DEV, 'fixtures', 'seed-workspace');
const MARKER = '.world-next-proof.json';
const MODEL = 'world-proof';

function accepted(result, label) {
  assert.ok(result && result.ok, label + ': ' + JSON.stringify(result));
  return result;
}

function createStation(now = Date.now()) {
  // Start with the canonical schema, then author the spawn room before it becomes mutable.
  const doc = WorldModel.defaultDoc(now);
  doc.meta.name = 'KEPLER / WORLD NEXT';
  const spawn = doc.meta.spawnRoomId;
  Object.assign(doc.rooms[spawn], { name: 'COMMAND', kind: 'bridge',
    rects: [{ x1: 0, y1: 0, x2: 15, y2: 10 }], floorStyle: 'cobalt', floorMat: 'alloy' });
  WorldModel.setPropRules(PropSprites.spec);
  const station = WorldModel.create(doc);
  const workshop = accepted(station.addRoom({ name: 'FABRICATION', kind: 'lab',
    rect: { x1: 20, y1: 0, x2: 38, y2: 10 }, floorStyle: 'rust', floorMat: 'diamond' }), 'workshop').id;
  const garden = accepted(station.addRoom({ name: 'THE CONSERVATORY', kind: 'quarters',
    rect: { x1: 8, y1: 14, x2: 31, y2: 21 }, floorStyle: 'oak', floorMat: 'plank' }), 'conservatory').id;
  for (const [name, rect] of [
    ['TRANSFER', { x1: 16, y1: 4, x2: 19, y2: 6 }],
    ['WEST WALK', { x1: 8, y1: 11, x2: 10, y2: 13 }],
    ['EAST WALK', { x1: 27, y1: 11, x2: 29, y2: 13 }]
  ]) accepted(station.placeHallway({ name, rect, floorStyle: 'teal', floorMat: 'runner' }), name);
  for (const [id, style, material] of [[spawn, 'cobalt', 'panelled'], [workshop, 'rust', 'service'], [garden, 'verdant', 'wainscot']])
    accepted(station.setWalls(id, { style, mat: material }), 'wall palette');

  const put = (t, x, y, agentId) => {
    const spec = PropSprites.spec(t);
    assert.ok(spec, 'catalog prop exists: ' + t);
    const result = accepted(station.addProp({ t, x, y, w: spec.w, h: spec.h, block: !!spec.blocks }), t + '@' + x + ',' + y);
    if (agentId) accepted(station.assignPropAgent(result.id, agentId), 'assign ' + t);
    return result.id;
  };
  // Command: a blue observation room, central holographic table, warm work terminals.
  put('commswall', 2, 0); put('missionboard', 11, 0);
  put('desk', 3, 3, 'agent'); put('desklamp', 5, 3);
  put('holotable', 8, 4); put('shelf', 1, 9); put('plant', 14, 8);
  put('rackV', 14, 1); put('arc_floorlight', 1, 5);
  const intake = put('intake', 1, 6), novaBay = put('bay', 6, 6, 'agent');
  put('trophycase', 12, 8);

  // Fabrication: large negative space through the middle, machinery at the perimeter.
  put('screens', 24, 0); put('shelf', 33, 0);
  put('desk', 24, 3, 'world-ember'); put('workbench', 29, 2);
  put('rackV', 37, 2); put('crate', 34, 4); put('connector_portal', 21, 1);
  put('tank', 30, 0); put('arc_floorlight', 37, 9);
  const emberBay = put('bay', 23, 7, 'world-ember'), outbox = put('outbox', 34, 7);
  const airlock = put('airlock', 20, 5);
  accepted(station.setDoorState(airlock, 'open'), 'open workshop airlock');

  // Conservatory: warm timber underfoot, cool botanical glass, sofa back to camera.
  put('couch', 10, 17); put('rug', 10, 18); put('bar', 17, 15);
  put('stool', 18, 16); put('stool', 20, 16); put('coffee', 21, 15);
  put('plant', 9, 14); put('plant', 15, 14); put('plant', 22, 14);
  put('plant', 30, 14); put('plant', 30, 20); put('terrarium', 22, 18);
  put('tank', 24, 14); put('arcade', 30, 17);
  put('desk', 26, 17, 'world-fern'); put('desklamp', 28, 17);
  const fernBay = put('bay', 26, 19, 'world-fern');
  put('arc_floorlight', 9, 20); put('bunk', 17, 19);

  // Real routes: command intake -> NOVA -> EMBER -> FERN -> dispatch.
  for (const [a, b] of [[intake, novaBay], [novaBay, emberBay], [emberBay, fernBay], [fernBay, outbox]])
    accepted(station.connectBelt(a, b), 'conveyor connection');
  const geo = station.projectGeometry();
  const plan = Pipeline.compileRoutingPlan(geo);
  const fatal = (plan.errors || []).filter(e => !e.warn);
  assert.equal(fatal.length, 0, 'routing errors: ' + JSON.stringify(plan.errors));
  // Prove the authored floor remains connected with the real blocking furniture.
  const local = (x, y) => ({ x: x - geo.origin.tx, y: y - geo.origin.ty });
  const start = local(5, 4);
  for (const [x, y] of [[26, 4], [28, 18]]) {
    const end = local(x, y);
    assert.ok(geo.path(start.x, start.y, end.x, end.y), 'connected crew route to ' + x + ',' + y);
  }
  return { station: station.serialize(), report: { name: doc.meta.name, rooms: 3, corridors: 3,
    grid: [geo.COLS, geo.ROWS], props: geo.props.length, belts: geo.belts.length,
    doorways: geo.doorDefs.length, warnings: plan.errors || [], agentBays: [novaBay, emberBay, fernBay] } };
}

function createSave(now = Date.now()) {
  const wrapper = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'agent.save.json'), 'utf8'));
  const { station, report } = createStation(now);
  const base = wrapper.doc.agent;
  const agents = [
    ['agent', 'NOVA', 'blank_blue', '#80bfd6', 'orchestrator', 'Coordinate real work and keep station telemetry truthful.'],
    ['world-ember', 'EMBER', 'blank_amber', '#efae68', 'specialist', 'Build and verify useful local artifacts in fabrication.'],
    ['world-fern', 'FERN', 'blank_green', '#a2caa0', 'specialist', 'Research and organize notes from the conservatory.']
  ].map(([id, name, skin, color, role, purpose]) => ({ ...structuredClone(base), id, name, skin, color, role, purpose,
    model: MODEL, provider: 'openrouter', reasoningEffort: 'medium', createdAt: now,
    approvalMode: 'ask', executionProfile: 'trusted-project', skills: [],
    docs: { identity: `You are ${name}, a real agent in an explicitly local development fixture.`,
      purpose, manual: 'Report only actual tool results. This fixture uses a scripted local model.',
      context: 'World Next renderer acceptance station. No production data or credentials.' } }));
  Object.assign(wrapper, { updatedAt: now, savedAt: now });
  Object.assign(wrapper.doc, { updatedAt: now, agent: agents[0], agents, station });
  const roster = { version: 1, updatedAt: now, agents: agents.map(a => ({ agentId: a.id, name: a.name,
    system: a.docs.identity + '\n' + a.docs.manual, role: a.role, model: MODEL, provider: 'openrouter' })) };
  return { wrapper, roster, report };
}

function assertScratchPath() {
  assert.equal(path.relative(DEV, SCRATCH), '.scratch-workspace');
  for (const target of [DEV, SCRATCH]) {
    if (fs.existsSync(target)) assert.ok(!fs.lstatSync(target).isSymbolicLink(), 'Refusing linked directory: ' + target);
  }
  assert.equal(fs.realpathSync(DEV), DEV, 'Refusing a linked dev directory');
}

function listening(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}

async function main(args) {
  assert.ok(args.every(a => ['--write', '--refresh'].includes(a)), 'Only --write and --refresh are supported');
  assert.ok(!args.includes('--refresh') || args.includes('--write'), '--refresh requires --write');
  const result = createSave();
  console.log(JSON.stringify(result.report, null, 2));
  if (!args.includes('--write')) { console.log('Validated. No files written. Add --write to create the dev fixture.'); return; }
  assertScratchPath();
  const port = Number(process.env.SKYNET_PORT || 8787);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'Valid SKYNET_PORT required');
  assert.ok(!(await listening(port)), 'Stop the sidecar/listener on SKYNET_PORT ' + port + ' before seeding.');
  if (fs.existsSync(SCRATCH)) {
    const markerPath = path.join(SCRATCH, MARKER);
    assert.ok(args.includes('--refresh') && fs.existsSync(markerPath), 'Existing scratch is preserved; --refresh requires this fixture marker.');
    assert.ok(!fs.lstatSync(markerPath).isSymbolicLink(), 'Refusing linked fixture marker');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.equal(marker.fixture, 'world-next', 'Refusing to overwrite another fixture');
    if (marker.port && marker.port !== port)
      assert.ok(!(await listening(marker.port)), 'Stop the prior fixture listener on port ' + marker.port + ' before refreshing.');
    // Only the scene and roster are refreshed; task outputs and runtime stores stay intact.
  } else {
    fs.mkdirSync(SCRATCH);
    fs.cpSync(FIXTURE, SCRATCH, { recursive: true, force: false, errorOnExist: true });
  }
  for (const [name, value] of [['agent.save.json', result.wrapper], ['agent.roster.json', result.roster],
    [MARKER, { fixture: 'world-next', createdAt: Date.now(), port }]]) {
    const target = path.join(SCRATCH, name);
    if (fs.existsSync(target)) assert.ok(!fs.lstatSync(target).isSymbolicLink(), 'Refusing linked output');
    fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n', { flag: 'w' });
  }
  console.log('Seeded ONLY ' + SCRATCH);
  console.log('Start node dev/world-next-model.cjs, use its printed environment, then node dev/seed.js --keep.');
}

module.exports = { createStation, createSave, assertScratchPath };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
