'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const M = require('../frontend/app/worldmodel.js');
const T = require('../frontend/app/stationtemplates.js');
const P = require('../frontend/app/propsprites.js');
const app = fs.readFileSync(require.resolve('../frontend/app/app.js'), 'utf8');
const start = app.indexOf('  let unsubscribeStationSave = null;');
const end = app.indexOf('  /* ---------- connect screen', start);
assert.ok(start > 0 && end > start, 'production autosave and persistence functions exist');
assert.match(app, /pendingStationDoc = null;\s+watchStationSave\(\);/, 'every loaded station is subscribed');
const cache = new Map(), pushed = [], notices = [];
let fail = false, flashes = 0;
const c = vm.createContext({ console: { warn() {} }, queueMicrotask,
  localStorage: { getItem: k => cache.get(k) || null, setItem(k, v) { if (fail) throw Error('quota'); cache.set(k, v); } },
  station: M.create(), agent: { id: 'agent', name: 'NOVA' }, agents: new Map(),
  liveAgents: () => [], Harness: { totals: () => ({}) }, Workstreams: { serialize: () => ({ workstreams: [{ id: 'keep-session' }] }) },
  rosterPushFailed: false, CloudSave: { revision: () => 7, push: d => pushed.push(d) },
  StationUI: { flashSave: () => flashes++, notify: (...a) => notices.push(a) }
});
vm.runInContext(fs.readFileSync(require.resolve('../frontend/app/save.js'), 'utf8'), c);
vm.runInContext(app.slice(start, end), c);
const watch = () => vm.runInContext('watchStationSave()', c);
const tick = () => new Promise(resolve => queueMicrotask(resolve));
const stored = () => JSON.parse(cache.get('starnet.save'));
async function check(label, action) {
  const before = pushed.length;
  const result = action(); assert.notEqual(result && result.ok, false, label + ': valid mutation');
  await tick();
  assert.equal(pushed.length, before + 1, label + ': queued for durable write without closing Build');
  assert.deepEqual(stored().station, c.station.serialize(), label + ': complete station round-trip');
  assert.equal(stored().workstreams[0].id, c.Workstreams.serialize().workstreams[0].id);
  assert.deepEqual(M.deserialize(stored().station).serialize(), c.station.serialize(), label + ': reload retains design');
}
(async () => {
  watch();
  const room = c.station.spawnRoomId();
  await check('rename', () => c.station.renameRoom(room, 'Saved workshop'));
  await check('floor', () => c.station.setFloor(room, 'cobalt'));
  await check('walls', () => c.station.setWalls(room, { style: 'hull' }));
  await check('hull', () => c.station.setHull(room, { style: 'cobalt' }));
  let prop;
  await check('placement', () => { const r = c.station.addProp({ t: 'plant', x: 3, y: 3, w: 1, h: 1 }); prop = r.id; return r; });
  await check('move', () => c.station.moveProp(prop, 1, 0));
  await check('remove', () => c.station.removeProp(prop));
  await check('undo', () => c.station.undo());
  await check('redo', () => c.station.redo());
  await check('preset', () => c.station.replaceLayout(T.build('retreat', M, P, 1000)));
  await check('burst', () => { c.station.renameRoom(c.station.spawnRoomId(), 'One'); c.station.renameRoom(c.station.spawnRoomId(), 'Two'); });
  const previous = c.station;
  c.station = M.deserialize(stored().station); watch(); watch();
  const count = pushed.length; previous.renameRoom(previous.spawnRoomId(), 'Detached'); await tick();
  assert.equal(pushed.length, count, 'replaced stations cannot trigger saves');
  await check('reentry has one subscription', () => c.station.renameRoom(c.station.spawnRoomId(), 'Current'));
  const lastGood = cache.get('starnet.save'), flashCount = flashes;
  fail = true;
  c.station.renameRoom(c.station.spawnRoomId(), 'Quota failure'); await tick();
  assert.equal(cache.get('starnet.save'), lastGood, 'failed cache write preserves previous save');
  assert.equal(flashes, flashCount, 'failed write cannot flash saved');
  assert.match(notices[0][0], /Could not save station/);
  assert.equal(vm.runInContext('persist()', c), false);
  assert.equal(notices.length, 1, 'storage failures do not flood notifications');
  fail = false; assert.equal(vm.runInContext('persist()', c), true);
  assert.equal(stored().station.rooms[c.station.spawnRoomId()].name, 'Quota failure', 'retry saves retained in-memory design');
  const noOpCount = pushed.length;
  assert.equal(c.station.removeProp('not-a-prop').ok, false);
  await tick(); assert.equal(pushed.length, noOpCount, 'rejected edits do not schedule a save');
  const burstCount = pushed.length;
  for (let i = 0; i < 500; i++) c.station.renameRoom(c.station.spawnRoomId(), 'Rapid edit ' + i);
  await tick();
  assert.equal(pushed.length, burstCount + 1, 'large synchronous edit burst causes one save');
  assert.equal(stored().station.rooms[c.station.spawnRoomId()].name, 'Rapid edit 499');
  const departing = c.station, reentryCount = pushed.length;
  departing.renameRoom(departing.spawnRoomId(), 'Queued before reentry');
  c.station = M.create(); watch();
  c.station.renameRoom(c.station.spawnRoomId(), 'Replacement station');
  await tick();
  assert.equal(pushed.length, reentryCount + 1, 'pending old callback and new edit coalesce across reentry');
  assert.deepEqual(stored().station, c.station.serialize(), 'queued save cannot resurrect the replaced model');
  const hero = { id: 'agent', name: 'NOVA' }, crew = { id: 'crew', name: 'VEGA' };
  c.agent = crew; c.agents = new Map([['agent', hero], ['crew', crew]]);
  c.liveAgents = () => [hero, crew]; c.serializeAgentLite = a => ({ ...a });
  c.Workstreams = { serialize: () => ({ workstreams: [{ id: 'new-session', draft: 'keep my draft' }], activeId: 'new-session' }) };
  await check('build while crew and another session are focused', () => c.station.renameRoom(c.station.spawnRoomId(), 'Crew editing'));
  assert.equal(stored().agent.id, 'agent', 'autosave retains the hero as the save root');
  assert.equal(stored().agents.length, 2, 'autosave retains the crew roster');
  assert.equal(stored().activeId, 'new-session', 'autosave retains the active session');
  assert.equal(stored().workstreams[0].draft, 'keep my draft', 'autosave retains session content');
  console.log('station-autosave: edits, undo/redo, presets, coalescing, reentry and storage failure PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
