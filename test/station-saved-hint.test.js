'use strict';
// Private owner comparison, not a posted-plan route or page activation proof.
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), Module = require('node:module');
const WM = require('../frontend/app/worldmodel.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { makeSaveStore } = require('../sidecar/savestore.js');
const ownerPath = require.resolve('../sidecar/station-store.js');
let owner = require(ownerPath);
if (process.env.SAVED_HINT_OWNER_CONTROL) {
  const code = fs.readFileSync(process.env.SAVED_HINT_OWNER_CONTROL, 'utf8');
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  if (hash !== process.env.SAVED_HINT_OWNER_SHA256) throw new Error('saved owner control hash mismatch');
  console.log('CONTROL_SOURCE station-store SHA256=' + hash);
  const loaded = new Module(ownerPath, module); loaded.filename = ownerPath; loaded.paths = Module._nodeModulePaths(path.dirname(ownerPath));
  loaded._compile(code, ownerPath); owner = loaded.exports;
}
A.eq(typeof owner.makeSavedFloorHint, 'function', 'existing station owner exposes the new private comparison API');
// The exact old owner has no such API. This is an availability control, not a
// claim that a prior public endpoint accepted a tampered plan.
if (typeof owner.makeSavedFloorHint !== 'function') A.report('station-saved-hint API availability control');
const clone = v => JSON.parse(JSON.stringify(v));
const canonical = raw => { const model = WM.deserialize(raw); model.projectGeometry(); return model.serialize(); };
// Key order is compiler input (belts are walked in insertion order and plan.hash is taken over it) but is never
// authority to the comparison. Every order below is fixed, so the family is the same on every run.
function shuffled(list, seed) {
  let s = seed >>> 0; const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const j = (s >>> 8) % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
// every object in v re-keyed in the order pick() gives (arrays keep their order: that one is data)
function rekey(v, pick) {
  if (Array.isArray(v)) return v.map(item => rekey(item, pick));
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const key of pick(Object.keys(v))) out[key] = rekey(v[key], pick);
  return out;
}
const reversed = keys => keys.slice().reverse();
function floor() {
  const doc = WM.defaultDoc(); doc.meta.createdAt = 1;
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
function pageHint(doc) {
  // Use the same existing compiler and per-dock room grants as compileRouting;
  // only the explicit links companion is new. No fixture-owned plan compiler.
  const model = WM.deserialize(doc), plan = Pipeline.compileRoutingPlan(model.projectGeometry());
  for (const bay of plan.bays || []) bay.objects = model.bayObjects(bay.agentId, bay.propId);
  for (const bay of plan.dockBays || []) bay.objects = model.bayObjects(bay.agentId, bay.propId);
  A.ok(!Object.keys(plan).includes('links'), 'actual compiler links are not enumerable JSON plan fields');
  return clone({ version: 1, plan, compilerLinks: plan.links || null });
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-hint-'));
const primary = path.join(root, 'agent.save.json');
let now = 1, unreadable = false, loads = 0, stamps = 0;
const io = Object.create(fs);
io.readFileSync = (file, ...args) => {
  if (unreadable && path.resolve(String(file)) === primary) throw Object.assign(new Error('fixture locked primary'), { code: 'EACCES' });
  return fs.readFileSync(file, ...args);
};
const open = () => makeSaveStore({ fs: io, pathMod: path, root, clock: { now: () => now++ } });
let store = open();
const source = extra => Object.assign({ agentId: 'agent',
  stamp: () => { stamps++; return store.stamp('agent'); },
  loadPrimaryState: () => { loads++; return store.loadPrimaryState('agent'); } }, extra);
const compare = owner.makeSavedFloorHint(source()), project = owner.makeSavedFloorProjection(source());
const write = station => {
  const previous = store.loadPrimaryState('agent');
  return store.save('agent', { schema: 'starnet.save', version: require('../frontend/app/save.js').CURRENT, updatedAt: now++,
    _saveRevision: previous.status === 'ok' ? previous.wrapper.revision : 0, _saveClient: 'saved-hint-test',
    _saveDirty: true, agent: { id: 'agent' }, station }, { compareRevision: true });
};
const signature = () => fs.readFileSync(primary);
try {
  A.eq([compare(null).status, compare(null).sourceStatus], ['unavailable', 'absent'], 'missing saved authority takes precedence over any hint');
  const station = floor(), hint = pageHint(station);
  A.ok(write(station).ok, 'real save owner writes the actual floor');
  const baseline = project(), bytes = signature(), hintBytes = JSON.stringify(hint);
  loads = 0; stamps = 0;
  const matched = compare(hint);
  A.eq([matched.status, matched.matched, matched.routingOk], ['ok', true, true], 'whole page JSON envelope exactly matches saved routable facts');
  A.eq([loads, stamps], [1, 2], 'one fresh owner projection checks the primary stamp on both sides');
  A.eq([matched.identity, matched.revision, matched.stamp], [baseline.identity, baseline.revision, baseline.stamp], 'receipt identity comes only from the saved owner');
  A.ok(Object.isFrozen(matched), 'comparison receipt is immutable');
  A.eq(signature(), bytes, 'successful hint comparison writes no saved bytes');
  A.eq(JSON.stringify(hint), hintBytes, 'comparison never enriches or mutates the posted hint');
  A.eq(compare({ compilerLinks: hint.compilerLinks, plan: hint.plan, version: 1 }), matched, 'JSON object key order has no semantic authority');
  store = open();
  // not the stamp: it begins with the process write count, so a restarted owner stamps the same bytes differently
  const restarted = compare(hint);
  A.eq([restarted.status, restarted.matched, restarted.identity, restarted.revision], [matched.status, matched.matched, matched.identity, matched.revision], 'new real save owner after restart proves the same exact hint');
  for (const [label, mutate] of [
    ['brief', d => { d.props.find(p => p.id === 'b1').brief = 'Different exact brief'; }],
    ['capabilities', d => { d.props.push({ id: 'gear', t: 'rack', x: 18, y: 0, w: 1, h: 1 }); }],
    ['limits', d => { d.props.find(p => p.id === 'i1').limits = { maxHops: 8, maxUsdPerMessage: 0.25, maxUsdPerDay: 2 }; }],
    ['name', d => { d.props.find(p => p.id === 'i1').label = 'RENAMED'; }],
    ['projectRoot', d => { d.props.find(p => p.id === 'i1').projectRoot = 'C:/work/two'; }],
    ['SEND TO', d => { d.props.find(p => p.id === 'o1').sendTo = 'i2'; }]
  ]) {
    write(station);
    const changed = clone(station); mutate(changed);
    const saved = canonical(changed), nextHint = pageHint(saved), before = signature();
    A.eq(nextHint.plan.hash, baseline.topologyHash, label + ': actual compiler topology stays the same');
    A.eq(compare(nextHint).status, 'pending', label + ': unsaved page facts never install authority');
    A.eq(signature(), before, label + ': refused hint leaves current primary unchanged');
    A.ok(write(saved).ok, label + ': existing save owner commits changed facts');
    A.eq(compare(hint).status, 'pending', label + ': stale same-topology hint is not acknowledged');
    const next = compare(nextHint);
    A.eq([next.status, next.matched], ['ok', true], label + ': exact new saved facts are acknowledged');
    A.ok(next.identity !== baseline.identity, label + ': receipt includes full semantic change');
    A.eq(next.identity, project().identity, label + ': no posted hash substitutes for saved identity');
  }
  // HINT EQUIVALENCE OVER KEY ORDER. The same belts in another order are another plan.hash, so the owner has to
  // compile every saved floor in the order it was drawn and saved (a key-sorted copy compiles a plan no page drew):
  // the page's hint for that exact floor matches, and a hint compiled from any other belt order is pending.
  const drawn = Object.keys(station.belts);
  const redrawn = order => { const d = clone(station); d.belts = {}; for (const k of order) d.belts[k] = station.belts[k]; return d; };
  const family = [['drawn', drawn], ['sorted', drawn.slice().sort()], ['reversed', reversed(drawn)], ['rotated', drawn.slice(5).concat(drawn.slice(0, 5))],
    ['shuffled-1', shuffled(drawn, 1)], ['shuffled-2', shuffled(drawn, 2)], ['shuffled-3', shuffled(drawn, 3)]]
    .map(([name, order]) => { const saved = redrawn(order); return { name, saved, page: pageHint(saved) }; });
  A.eq(new Set(family.map(f => f.page.plan.hash)).size, family.length, 'the family is not vacuous: every belt order is its own compiled topology');
  const identities = new Set();
  for (const f of family) {
    A.ok(write(f.saved).ok, f.name + ': existing save owner commits the floor in this belt order');
    A.eq(Object.keys(JSON.parse(signature()).doc.station.belts), Object.keys(f.saved.belts), f.name + ': the primary keeps the order the floor was drawn in');
    const owned = project(), receipt = compare(f.page), before = signature();
    A.eq(owned.topologyHash, f.page.plan.hash, f.name + ': the owner compiles the saved floor in its drawn order, to the page\'s own topology hash');
    A.eq([receipt.status, receipt.matched, receipt.identity, receipt.revision], ['ok', true, owned.identity, owned.revision], f.name + ': the page hint for this exact floor is acknowledged, identity from the owner alone');
    identities.add(owned.identity);
    for (const g of family) {
      if (g === f) continue;
      const refused = compare(g.page);
      A.eq([refused.status, refused.matched, refused.identity, refused.revision, refused.stamp], ['pending', false, null, null, null], f.name + ': a hint compiled from the ' + g.name + ' belt order is pending');
      A.ok(!JSON.stringify(refused).includes(g.page.plan.hash), f.name + ': the receipt never echoes the posted ' + g.name + ' hash');
    }
    A.eq(signature(), before, f.name + ': refused hints leave the primary unchanged');
  }
  A.eq(identities.size, family.length, 'each belt order is its own saved identity');
  // any other object key order is neither compiler input nor identity: only the belts' order is part of the floor
  write(station);
  const home = project().identity;
  for (const [name, pick] of [['reversed', reversed], ['shuffled-1', keys => shuffled(keys, 11)], ['shuffled-2', keys => shuffled(keys, 12)]]) {
    const saved = Object.assign(rekey(station, pick), { belts: station.belts });
    A.ok(JSON.stringify(saved) !== JSON.stringify(station), name + ': the saved floor really is in another key order');
    A.ok(write(saved).ok, name + ': existing save owner commits the floor in this object key order');
    const receipt = compare(pageHint(saved));
    A.eq([receipt.status, receipt.matched, receipt.identity], ['ok', true, home], name + ': object key order other than the belts is not part of the saved identity');
  }
  // and when every object, belts included, is re-keyed, page and owner still compile the one same plan
  for (const [name, pick] of [['reversed', reversed], ['shuffled', keys => shuffled(keys, 21)]]) {
    const saved = rekey(station, pick), page = pageHint(saved);
    A.ok(write(saved).ok, 'every object ' + name + ': existing save owner commits the floor');
    const owned = project(), receipt = compare(page);
    A.eq(owned.topologyHash, page.plan.hash, 'every object ' + name + ': page and owner compile one topology');
    A.eq([receipt.status, receipt.matched, receipt.identity], ['ok', true, owned.identity], 'every object ' + name + ': the page hint is acknowledged');
  }
  // the posted JSON's own key order is not authority at any depth, not even inside plan.belts
  write(station);
  const settled = compare(hint);
  for (const [name, pick] of [['reversed', reversed], ['shuffled-1', keys => shuffled(keys, 31)], ['shuffled-2', keys => shuffled(keys, 32)]]) {
    const posted = rekey(hint, pick);
    A.ok(JSON.stringify(posted) !== JSON.stringify(hint), name + ': the posted JSON really is in another key order');
    A.eq(compare(posted), settled, name + ': object key order of the posted JSON has no authority at any depth');
  }
  write(station);
  const stable = signature();
  for (const [label, mutate] of [
    ['missing links', h => { delete h.compilerLinks; }],
    ['wrong links', h => { h.compilerLinks = []; }],
    ['extra link', h => { h.compilerLinks.push({ id: 'invented-link' }); }],
    ['missing plan field', h => { delete h.plan.lineLimits; }],
    ['extra plan field', h => { h.plan.syntheticAuthority = true; }],
    ['tampered plan hash', h => { h.plan.hash = '00000000'; }],
    ['posted identity', h => { h.identity = baseline.identity; }],
    ['future envelope', h => { h.version = 2; }]
  ]) {
    const modified = clone(hint); mutate(modified); const result = compare(modified);
    A.eq([result.status, result.matched, result.identity, result.revision, result.stamp], ['pending', false, null, null, null], label + ': incomplete or extra facts cannot acquire saved authority');
    A.eq(signature(), stable, label + ': rejected hint cannot rewrite the primary');
  }
  for (const bad of [hint.plan, null, [], {}, { version: 1, plan: null, compilerLinks: [] }]) {
    A.eq(compare(bad).status, 'pending', 'bare or malformed hint is pending instead of installing a default plan');
  }
  const circular = clone(hint); circular.plan.circular = circular;
  A.eq(compare(circular).status, 'pending', 'unencodable hint is a typed refusal');
  // the snapshot walk was rewritten to keep key order: every refusal it always had is still its own, not a mismatch by luck
  for (const [label, mutate] of [
    ['sparse array', h => { h.compilerLinks = new Array(2); }],
    ['accessor', h => { Object.defineProperty(h.plan, 'sneaky', { get: () => 1, enumerable: true, configurable: true }); }],
    ['non-plain object', h => { h.plan.when = new Date(0); }],
    ['NaN', h => { h.plan.n = NaN; }],
    ['Infinity', h => { h.plan.n = Infinity; }],
    ['undefined', h => { h.plan.n = undefined; }],
    ['function', h => { h.plan.n = () => 1; }],
    ['nesting past its bound', h => { let deep = {}; for (let i = 0; i < 60; i++) deep = { deep }; h.plan.deep = deep; }],
    ['nodes past their bound', h => { h.plan.many = new Array(500000).fill(0); }],
    ['bytes past their bound', h => { h.plan.big = 'x'.repeat(16 * 1024 * 1024 + 1); }]
  ]) {
    const bad = clone(hint); mutate(bad); const result = compare(bad);
    A.eq([result.status, result.reason, result.identity], ['pending', 'invalid-hint', null], label + ': refused by the snapshot walk itself');
  }
  const cyclic = clone(station);
  Object.assign(cyclic.belts, { '18,5': 'E', '19,5': 'S', '19,6': 'W', '18,6': 'N' }); delete cyclic.links;
  const brokenFloor = canonical(cyclic); write(brokenFloor);
  const blocked = compare(pageHint(brokenFloor)), blockedProjection = project();
  A.eq([blocked.status, blocked.matched, blocked.routingOk], ['unroutable', false, false], 'exact compiler-blocked floor is never a ready acknowledgement');
  A.eq(blocked.identity, blockedProjection.identity, 'unroutable identity is still proved by the saved owner');
  A.eq(compare(hint).status, 'pending', 'different hint does not hide behind saved compiler refusal');
  write(station);
  const good = signature(), wrapper = JSON.parse(good);
  for (const [label, mutate, expected] of [
    ['future', w => { w.version = 2; }, 'future'],
    ['invalid', w => { w.agentId = 'other'; }, 'invalid']
  ]) {
    const changed = clone(wrapper); mutate(changed); fs.writeFileSync(primary, JSON.stringify(changed));
    const before = signature(), result = compare(hint);
    A.eq([result.status, result.sourceStatus, result.identity], ['unavailable', expected, null], label + ': no last-good authority');
    A.eq(signature(), before, label + ': comparison leaves held bytes intact');
  }
  fs.writeFileSync(primary + '.bak', good); fs.writeFileSync(primary, '{broken');
  A.eq([compare(hint).status, compare(hint).sourceStatus], ['unavailable', 'corrupt'], 'valid backup cannot replace corrupt primary');
  A.eq(fs.readFileSync(primary, 'utf8'), '{broken', 'comparison does not recover corrupt primary');
  fs.unlinkSync(primary);
  A.eq([compare(hint).status, compare(hint).sourceStatus], ['unavailable', 'absent'], 'valid backup cannot replace missing primary');
  A.eq(fs.existsSync(primary), false, 'comparison does not recreate missing primary');
  fs.writeFileSync(primary, good); unreadable = true;
  A.eq(compare(hint).sourceStatus, 'unreadable', 'locked primary is an explicit source failure'); unreadable = false;
  let tick = 0;
  const racing = owner.makeSavedFloorHint(source({ stamp: () => String(++tick) }));
  A.eq([racing(hint).status, racing(hint).sourceStatus], ['unavailable', 'changed'], 'moving saved identity is never acknowledged');
  A.eq(compare(hint).status, 'ok', 'restored primary is re-proved without replacing comparison owner');
} finally {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('saved-hint-')) throw new Error('fixture cleanup escaped owned root');
  fs.rmSync(target, { recursive: true, force: true });
}
A.report('station-saved-hint');
