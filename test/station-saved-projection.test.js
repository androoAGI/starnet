'use strict';
// Private owner proof only: real save store/compiler, no host dispatch activation.
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const WM = require('../frontend/app/worldmodel.js');
const { makeStationStore, makeSavedFloorProjection } = require('../sidecar/station-store.js');
const { makeSaveStore } = require('../sidecar/savestore.js');
const Save = require('../frontend/app/save.js');   // the page's save format: the projection reads only a save of exactly this version
const clone = v => JSON.parse(JSON.stringify(v));
function canonical(raw) {
  const model = WM.deserialize(raw); model.projectGeometry(); return model.serialize();
}
function floor() {
  const doc = WM.defaultDoc();
  doc.meta.createdAt = 1;
  doc.rooms[doc.order[0]].rects = [{ x1: -2, y1: -2, x2: 25, y2: 10 }];
  doc.props = [
    { id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1, lineId: 'line-one', label: 'ONE', projectRoot: 'C:/work/one' },
    { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'alpha', brief: 'First draft' },
    { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'beta', brief: 'Review draft' },
    { id: 'o1', t: 'outbox', x: 10, y: 0, w: 1, h: 1 },
    { id: 'i2', t: 'intake', x: 0, y: 5, w: 1, h: 1, lineId: 'line-two', label: 'TWO' },
    { id: 'b3', t: 'bay', x: 4, y: 5, w: 1, h: 1, agentId: 'gamma' },
    { id: 'o2', t: 'outbox', x: 7, y: 5, w: 1, h: 1 },
    { id: 'pc1', t: 'console', x: 12, y: 0, w: 1, h: 1, agentId: 'alpha' },
    { id: 'pc2', t: 'console', x: 14, y: 0, w: 1, h: 1, agentId: 'beta' },
    { id: 'pc3', t: 'console', x: 16, y: 0, w: 1, h: 1, agentId: 'gamma' }
  ];
  doc.belts = {};
  for (const x of [1, 2, 3, 5, 6, 8, 9]) doc.belts[x + ',0'] = 'E';
  for (const x of [1, 2, 3, 5, 6]) doc.belts[x + ',5'] = 'E';
  delete doc.links;
  return canonical(doc);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-projection-'));
const primary = path.join(root, 'agent.save.json');
let now = 100, unreadable = false;
const io = Object.create(fs);
io.readFileSync = (file, ...args) => {
  if (unreadable && path.resolve(String(file)) === primary) throw Object.assign(new Error('fixture locked primary'), { code: 'EACCES' });
  return fs.readFileSync(file, ...args);
};
const makeStore = () => makeSaveStore({ fs: io, pathMod: path, root, clock: { now: () => now++ } });
let store = makeStore();
const project = extra => makeSavedFloorProjection(Object.assign({ agentId: 'agent', stamp: () => store.stamp('agent'), loadPrimaryState: () => store.loadPrimaryState('agent') }, extra));
const read = project();
const write = station => {
  const previous = store.loadPrimaryState('agent');
  const revision = previous.status === 'ok' ? previous.wrapper.doc._saveRevision : 0;
  return store.save('agent', { schema: 'starnet.save', version: Save.CURRENT, updatedAt: now++, _saveRevision: revision,
    _saveClient: 'projection-test', _saveDirty: true, agent: { id: 'agent' }, station }, { compareRevision: true });
};
try {
  A.eq(read().status, 'absent', 'no primary is an explicit absence');
  const station = floor();
  A.ok(write(station).ok, 'real save owner writes the canonical floor');
  const baseline = read();
  A.eq([baseline.status, baseline.routingOk], ['ok', true], 'real saved two-stage floor compiles as deployable');
  A.ok(/^saved-plan-v1:[a-f0-9]{64}$/.test(baseline.identity || ''), 'semantic identity is separately versioned');
  A.eq(read(), baseline, 'repeated fresh reads are deterministic');
  A.ok(baseline.plan && baseline.plan.dockBays.every(b => b.objects.some(x => x === 'computer' || x.objectType === 'computer')), 'each dock includes its actual room workstation grant');
  A.ok(baseline.compilerLinks && baseline.compilerLinks.length > 0, 'non-enumerable compiler links survive explicitly');
  let mutated = false;
  try { baseline.plan.dockBays[0].objects.push('fake-capability'); mutated = true; } catch (_) {}
  A.eq(mutated, false, 'returned authority data cannot be mutated after digest');
  store = makeStore();
  A.eq([read().identity, read().revision], [baseline.identity, baseline.revision], 'fresh store after restart proves the same saved projection');
  const uncrewed = clone(station); delete uncrewed.props.find(p => p.id === 'b2').agentId;
  write(canonical(uncrewed));
  const warning = read();
  A.eq([warning.status, warning.routingOk], ['ok', true], 'the compiler keeps an uncrewed dock as a warning rather than a global routing failure');
  A.ok(warning.plan && warning.plan.unboundBays.length > 0, 'the actual uncrewed dock remains explicit for later admission checks');
  const cyclic = clone(station);
  Object.assign(cyclic.belts, { '18,5': 'E', '19,5': 'S', '19,6': 'W', '18,6': 'N' });
  delete cyclic.links; // legacy ring topology: currentLinks retains null when linked adoption would hide the cycle
  write(canonical(cyclic));
  const unroutable = read();
  A.eq([unroutable.status, unroutable.routingOk], ['ok', false], 'the compiler blocking cycle explicitly refuses routing');
  A.ok(unroutable.plan && unroutable.plan.errors.some(e => e.code === 'CYCLE') && unroutable.stationDoc,
    'undeployable floor retains its actual immutable facts instead of an empty/default route');

  for (const [name, edit] of [
    ['brief', d => { d.props.find(p => p.id === 'b1').brief = 'Different exact brief'; }],
    ['limits', d => { d.props.find(p => p.id === 'i1').limits = { maxHops: 8, maxUsdPerMessage: 0.25, maxUsdPerDay: 2 }; }],
    ['capabilities', d => { d.props.push({ id: 'gear', t: 'rack', x: 18, y: 0, w: 1, h: 1 }); }],
    ['name', d => { d.props.find(p => p.id === 'i1').label = 'RENAMED'; }],
    ['project root', d => { d.props.find(p => p.id === 'i1').projectRoot = 'C:/work/two'; }],
    ['SEND TO', d => { d.props.find(p => p.id === 'o1').sendTo = 'i2'; }]
  ]) {
    const changed = clone(station); edit(changed); write(canonical(changed));
    const next = read();
    A.eq([next.status, next.routingOk, next.topologyHash], ['ok', true, baseline.topologyHash], name + ': current saved fact preserves dispatch topology');
    A.ok(next.identity !== baseline.identity, name + ': full semantic identity changes');
  }
  write(station);
  const goodBytes = fs.readFileSync(primary), good = JSON.parse(goodBytes);
  for (const [name, edit, expected] of [
    ['future wrapper', w => { w.version = 2; }, 'future'],
    ['wrong owner', w => { w.agentId = 'someone-else'; }, 'invalid'],
    ['mismatched revision', w => { w.revision++; }, 'invalid'],
    ['mismatched writer', w => { w.client = 'another-window'; }, 'unvouched'],
    ['missing writer', w => { delete w.client; }, 'unvouched'],
    ['future save', w => { w.doc.version = Save.CURRENT + 1; }, 'future'],
    // a save the page has not rewritten since history-by-reference (v7) is held, not read as a floor, until its first v7 save lands
    ['previous-format save (v6)', w => { w.doc.version = 6; }, 'migration-required'],
    ['future station', w => { w.doc.station.version = 3; }, 'future'],
    ['legacy station', w => { w.doc.station.version = 1; }, 'migration-required'],
    ['missing intake identity', w => { delete w.doc.station.props.find(p => p.id === 'i1').lineId; }, 'migration-required'],
    ['duplicate dock identity', w => { w.doc.station.props.find(p => p.id === 'b2').id = 'b1'; }, 'invalid'],
    ['non-string dock identity', w => { w.doc.station.props.find(p => p.id === 'b2').id = 2; }, 'invalid'],
    ['duplicate room identity', w => { w.doc.station.order.push(w.doc.station.order[0]); }, 'invalid'],
    ['malformed limit', w => { w.doc.station.props.find(p => p.id === 'i1').limits = { maxUsdPerMessage: 'unknown' }; }, 'migration-required'],
    ['invalid replacement', w => { w.doc.station.order = []; }, 'unsupported-geometry']
  ]) {
    const changed = clone(good); edit(changed); const bytes = Buffer.from(JSON.stringify(changed)); fs.writeFileSync(primary, bytes);
    const result = read();
    A.eq([result.status, result.routingOk, result.plan, result.identity], [expected, false, null, null], name + ': no last-good/default authority leaks');
    A.eq(fs.readFileSync(primary), bytes, name + ': primary bytes remain untouched');
  }
  for (const [name, change] of [
    ['huge room', d => { d.rooms[d.order[0]].rects[0].x2 = 1000000000; }],
    ['huge prop', d => { d.props[0].w = 1000000000; }],
    ['fractional rectangle', d => { d.rooms[d.order[0]].rects[0].y1 = 0.5; }]
  ]) {
    const changed = clone(good); change(changed.doc.station); fs.writeFileSync(primary, JSON.stringify(changed));
    const deserialize = WM.deserialize;
    let entered = false;
    WM.deserialize = () => { entered = true; throw new Error('fixture blocks unsafe projection before allocation'); };
    try {
      A.eq(read().status, 'unsupported-geometry', name + ': rejected by the bounded owner');
      A.eq(entered, false, name + ': refuses BEFORE WorldModel clone/geometry allocation');
    } finally { WM.deserialize = deserialize; }
  }
  fs.writeFileSync(primary + '.bak', goodBytes);
  fs.writeFileSync(primary, '{broken');
  A.eq([read().status, fs.readFileSync(primary, 'utf8')], ['corrupt', '{broken'], 'corrupt primary is neither replaced nor authorized from backup');
  fs.unlinkSync(primary);
  A.eq(read().status, 'absent', 'valid backup cannot stand in for a missing primary');
  A.eq(fs.existsSync(primary), false, 'strict read does not recover missing primary');
  fs.writeFileSync(primary, goodBytes);
  unreadable = true;
  A.eq(read().status, 'unreadable', 'locked primary is explicit and never served from old projection');
  unreadable = false;
  let stamps = 0;
  A.eq(project({ stamp: () => String(++stamps) })().status, 'changed', 'revision moving across read/compile refuses the snapshot');
  A.eq(project({ stamp: () => '' })().status, 'unstamped', 'unavailable freshness stamp grants no snapshot');
  A.eq(read().status, 'ok', 'restored clean primary re-proves without process restart');
  const legacy = makeStationStore();
  A.ok(legacy.setStation(station).ok, 'legacy installed-store behavior stays available');
  legacy.setStation({ rooms: {}, order: [], props: [] });
  A.ok(legacy.hasStation(), 'private strict projection does not rewrite legacy last-good behavior');
  A.report('station-saved-projection');
} finally {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('saved-projection-')) throw new Error('projection cleanup escaped owned root');
  fs.rmSync(target, { recursive: true, force: true });
}
