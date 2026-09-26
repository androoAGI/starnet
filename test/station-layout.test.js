'use strict';
/* station.layout — the lead's read-only view of the floor. Runs the REAL page verb (stationcommands.js in a vm)
   over a REAL WorldModel station and the REAL Pipeline compiler, through the sidecar tool's bridge, so the
   answer the model reads is the same compiled plan the router runs work on. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { makeStationTools } = require('../sidecar/tools/builtin/station.js');
const WorldModel = require('../frontend/app/worldmodel.js');
const Pipeline = require('../frontend/app/pipeline.js');
const Sprites = require('../frontend/app/propsprites.js');
const Templates = require('../frontend/app/stationtemplates.js');
const commands = fs.readFileSync(require.resolve('../frontend/app/stationcommands.js'), 'utf8');

function boot(app, globals) {
  const acks = [];
  const context = Object.assign({
    App: app, WorldModel, Pipeline,
    fetch: async (url, init) => { acks.push(JSON.parse(init.body)); return { ok: true }; },
    document: { addEventListener: () => {} }, console, setTimeout, clearTimeout
  }, globals || {});
  vm.createContext(context);
  const S = vm.runInContext(commands + '\nStationCommands;', context);
  return makeStationTools({ station: { request: async (verb, args) => {
    await S.run('request-' + acks.length, verb, args);
    return acks.at(-1);
  } } });
}

(async () => {
  const station = WorldModel.create(Templates.build('creative', WorldModel, Sprites));
  const agents = [{ id: 'drafter', name: 'Ada' }, { id: 'reviewer', name: 'Rex' }];
  for (const a of agents) assert.equal(station.ensureWorkstation(a.id).ok, true);
  const guide = Templates.example(station.serialize(), WorldModel, Pipeline);
  // Assign in reverse prop order: the answer must follow the belts, not the saved array.
  assert.equal(station.assignPropAgent(guide.roles[1].propId, 'reviewer').ok, true);
  assert.equal(station.assignPropAgent(guide.roles[0].propId, 'drafter').ok, true);
  const before = JSON.stringify(station.serialize());

  const tools = boot({ station: () => station, agents: () => agents });
  const out = await tools.layoutTool.run();
  assert.doesNotMatch(out.content, /^REFUSED/);
  const layout = JSON.parse(out.content);
  assert.equal(JSON.stringify(station.serialize()), before, 'reading the layout never mutates the station');
  assert.match(out.summary, /^3 room\(s\), 1 assembly line\(s\)$/);

  assert.equal(layout.rooms.length, 3, 'corridors are not rooms');
  const review = layout.rooms.find(r => r.name === 'DRAFT & REVIEW');
  assert.ok(review, 'rooms carry their names');
  assert.equal(review.props.bay, 2);
  assert.equal(review.props.intake, 1);
  assert.equal(review.props.outbox, 1);

  assert.equal(layout.lines.length, 1);
  const line = layout.lines[0];
  assert.equal(line.name, 'CREATIVE · DRAFT & REVIEW', 'the line is named by its Inbox label');
  assert.equal(line.inboxes, 1); assert.equal(line.outboxes, 1);
  assert.deepEqual(line.steps.map(s => s.agent && s.agent.name), ['Ada', 'Rex'], 'steps follow the directed hand-off');
  assert.match(line.steps[0].brief, /^Draft a response/);
  assert.match(line.steps[1].brief, /^Review the incoming draft/);
  assert.equal(line.steps[0].fedByInbox, true);
  assert.deepEqual(line.steps[0].sendsTo, [{ agentId: 'reviewer', name: 'Rex' }]);
  assert.equal(line.steps[0].toOutbox, false);
  assert.equal(line.steps[1].toOutbox, true);
  assert.equal(line.steps[0].room, 'DRAFT & REVIEW');
  assert.deepEqual(line.issues, [], 'a configured line reports no routing issues');

  const desks = layout.assignments.filter(a => a.type === 'desk');
  assert.deepEqual(desks.map(a => a.agent.agentId).sort(), ['drafter', 'reviewer'], 'workstations list their holders');
  assert.ok(desks.every(a => a.grants === 'computer'), 'a desk grants computer access');
  assert.ok(layout.assignments.every(a => a.type !== 'bay'), 'Bays are reported as line steps, not twice');

  // An unassigned step is still listed, with the open issue the floor itself shows.
  const fresh = WorldModel.create(Templates.build('creative', WorldModel, Sprites));
  const bare = JSON.parse((await boot({ station: () => fresh, agents: () => [] }, { Build: { nagLabel: code => 'LABEL:' + code } }).layoutTool.run()).content);
  assert.deepEqual(bare.lines[0].steps.map(s => s.agent), [null, null]);
  assert.deepEqual(bare.lines[0].issues.map(i => i.code), ['UNBOUND_BAY', 'UNBOUND_BAY']);
  assert.equal(bare.lines[0].issues[0].label, 'LABEL:UNBOUND_BAY', 'issues carry the floor\'s own plain-language label');

  // A plain station with no conveyors has rooms and no lines.
  const plain = WorldModel.create(Templates.build('default', WorldModel, Sprites));
  const home = JSON.parse((await boot({ station: () => plain, agents: () => [] }).layoutTool.run()).content);
  assert.equal(home.rooms.length, 1);
  assert.deepEqual(home.lines, []);

  // Refusals are answers, never an empty success.
  assert.match((await boot({ agents: () => [] }).layoutTool.run()).content, /^REFUSED: the station layout is not ready yet/);
  assert.match((await boot({ station: () => station, agents: () => [] }, { Pipeline: undefined }).layoutTool.run()).content, /^REFUSED: workflow routing is not loaded/);
  assert.match((await makeStationTools({}).layoutTool.run()).content, /^REFUSED: .*no station bridge/);

  // The capability registry is an allowlist: the tool is declared read-only and consent-free.
  const registry = fs.readFileSync(require.resolve('../sidecar/capability/registry.js'), 'utf8');
  assert.match(registry, /capId: 'orchestrator', tool: 'station\.layout', scope: 'read', requiresConsent: false/);
  assert.equal(tools.layoutTool.scope, 'read');
  assert.equal(tools.layoutTool.requiresConsent, false);

  console.log('station-layout: rooms, ordered line steps with briefs and hand-offs, workstation holders, issues, read-only, refusals PASS');
})().catch(e => { console.error(e); process.exit(1); });
