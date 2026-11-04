'use strict';
// Private mode, actual save owner and compiler. No host wiring or paid dispatch.
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { isDeepStrictEqual } = require('node:util');
const WM = require('../frontend/app/worldmodel.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { makeSavedFloorProjection } = require('../sidecar/station-store.js');
const { makeSaveStore } = require('../sidecar/savestore.js');
const Save = require('../frontend/app/save.js');   // the saved floor is read only from a save of the page's current format
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = raw => { const model = WM.deserialize(raw); model.projectGeometry(); return model.serialize(); };
function floor() {
  const doc = WM.defaultDoc(); doc.meta.createdAt = 1;
  doc.rooms[doc.order[0]].rects = [{ x1: -2, y1: -2, x2: 25, y2: 10 }];
  doc.props = [
    { id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1, lineId: 'line-one', label: 'ONE', limits: { maxHops: 8, maxUsdPerMessage: 0.5, maxUsdPerDay: 3 } },
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-saved-'));
const primary = path.join(root, 'agent.save.json');
let now = 1, store = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => now++ } });
const read = makeSavedFloorProjection({ agentId: 'agent', stamp: () => store.stamp('agent'), loadPrimaryState: () => store.loadPrimaryState('agent') });
const write = station => {
  const previous = store.loadPrimaryState('agent');
  const result = store.save('agent', { schema: 'starnet.save', version: Save.CURRENT, updatedAt: now++, agent: { id: 'agent' },
    _saveRevision: previous.status === 'ok' ? previous.wrapper.revision : 0, _saveClient: 'router-fixture', _saveDirty: true, station }, { compareRevision: true });
  if (!result.ok) throw new Error('fixture actual save failed');
};
const attempt = fn => { try { return { value: fn() }; } catch (error) { return { code: error.code, error: String(error) }; } };
const held = (fn, status, label) => A.eq(attempt(fn).code, 'EROUTING_SAVED_' + status.toUpperCase().replace(/[^A-Z0-9]/g, '_'), label);
const eq = (fn, expected, label) => {
  const result = attempt(fn), actual = result.code || result.value;
  A.ok(isDeepStrictEqual(actual, expected), label + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
};
try {
  let reads = 0;
  const router = makeRouter({ savedProjection: () => { reads++; return read(); } });
  const calls = {
    setPlan: [null], clearPlan: [], getPlan: [], hasPlan: [], setStation: [null], clearStation: [], getStation: [],
    resolveTarget: [{ lineId: 'line-one' }], resolveDock: [{ lineId: 'line-one' }],
    lineOfAgent: ['alpha', 'b1'], lineOriginFor: ['alpha', 'b1'],
    intakeReceiptFor: [{ agentId: 'alpha', dockId: 'b1', lineId: 'line-one', intakeId: 'i1' }],
    lineLimits: ['line-one'], chainNext: ['alpha', { lineId: 'line-one' }], chainStep: ['alpha', { lineId: 'line-one' }],
    chainPeek: ['alpha', { lineId: 'line-one' }], fanSiblings: ['alpha'], loopGateAfter: ['alpha', 'line-one', 'b1'],
    chainShipsToOutbox: ['beta', 'b2'], stationFor: ['alpha', 'b1'], stageBrief: ['alpha', 'b1'],
    dockOf: ['alpha', 'b1'], dockRef: ['b1', 'line-one'], entryDockOf: ['alpha'], docksOf: ['alpha'], agentOfDock: ['b1'], lineOfDock: ['b1'],
    chainNextDock: ['b1', { lineId: 'line-one' }], chainStepDock: ['b1', { lineId: 'line-one' }],
    chainPeekDock: ['b1', { lineId: 'line-one' }], fanSiblingsDock: ['b1']
  };
  A.eq(Object.keys(calls).sort(), Object.keys(router).sort(), 'every exported reader and mutator participates in authority refusal proof');
  for (const [name, args] of Object.entries(calls)) held(() => router[name](...args), 'absent', name + ': absent authority cannot default');
  const station = floor(); write(station);
  const first = read();
  A.eq([first.status, first.routingOk], ['ok', true], 'actual saved floor is deployable');
  // Also arms the exact old router's ordinary positive path for the paired control.
  held(() => router.setPlan(first.plan), 'read-only', 'posted plan cannot install saved authority');
  eq(() => router.resolveDock({ lineId: 'line-one' }), { agentId: 'alpha', dockId: 'b1' }, 'headless saved intake enters A');
  eq(() => router.chainNextDock('b1', { lineId: 'line-one' }), { agentId: 'beta', dockId: 'b2' }, 'saved A hands to B');
  eq(() => router.chainStepDock('b2', { lineId: 'line-one' }), null, 'known terminal B has genuine null successor');
  eq(() => router.chainShipsToOutbox('beta', 'b2'), true, 'known B ships to saved OUTBOX');
  eq(() => router.stageBrief('alpha', 'b1'), 'First draft', 'brief comes from saved A');
  eq(() => router.lineLimits('line-one').maxUsdPerMessage, 0.5, 'limit comes from saved INBOX');
  eq(() => router.intakeReceiptFor(calls.intakeReceiptFor[0]), { mode: 'line', agentId: 'alpha', dockId: 'b1', lineId: 'line-one', intakeId: 'i1' }, 'canonical intake receipt names same saved decision');
  eq(() => router.stationFor('alpha', 'b1').rooms.bay.objects.some(o => o.objectType === 'computer'), true, 'capability comes from saved room');
  const before = reads; router.stageBrief('alpha', 'b1');
  A.eq(reads - before, 1, 'nested brief/plan/dock reads share exactly one fresh snapshot');
  const planResult = attempt(() => router.getPlan()).value;
  A.ok(planResult && Object.isFrozen(planResult) && Object.isFrozen(planResult.dockBays), 'returned routing plan is immutable');
  A.ok(planResult && !Object.keys(planResult).includes('links') && JSON.stringify(planResult.links) === JSON.stringify(first.compilerLinks), 'runtime retains immutable non-enumerable compiler links');
  eq(() => router.getStation(), station, 'saved station document is the exact immutable canonical document');
  for (const [label, fn, status] of [
    ['unknown agent', () => router.stationFor('gone'), 'unknown-agent'],
    ['removed dock', () => router.dockOf('alpha', 'gone'), 'unknown-dock'],
    ['foreign dock', () => router.stageBrief('alpha', 'b2'), 'unknown-dock'],
    ['removed line', () => router.lineLimits('gone'), 'unknown-line'],
    ['wrong known line', () => router.chainStepDock('b1', { lineId: 'line-two' }), 'line-mismatch'],
    ['bound agent wrong line', () => router.resolveDock({ boundAgentId: 'alpha', lineId: 'line-two' }), 'line-mismatch'],
    ['foreign intake', () => router.intakeReceiptFor({ agentId: 'alpha', dockId: 'b1', lineId: 'line-one', intakeId: 'i2' }), 'unresolved-identity'],
    ['known dock wrong line', () => router.dockRef('b1', 'line-two'), 'unresolved-identity']
  ]) held(fn, status, label + ': no stale identity fallback');
  const multibay = clone(station); multibay.props.find(p => p.id === 'b3').agentId = 'alpha';
  write(canonical(multibay));
  A.eq(read().routingOk, true, 'actual two-line multi-bay floor is deployable');
  eq(() => router.resolveDock({ boundAgentId: 'alpha', dockId: 'b1', lineId: 'line-one' }), { agentId: 'alpha', dockId: 'b1' }, 'matching explicit entry dock remains dispatchable');
  held(() => router.resolveDock({ boundAgentId: 'alpha', dockId: 'b3', lineId: 'line-two' }), 'target-mismatch', 'valid explicit second dock cannot silently become the first dock');
  held(() => router.resolveTarget({ boundAgentId: 'alpha', dockId: 'b3', lineId: 'line-two' }), 'target-mismatch', 'agent-only result cannot hide wrong explicit dock selection');
  eq(() => router.dockRef('alpha', 'line-two'), { agentId: 'alpha', dockId: 'b3' }, 'existing non-dispatch dock lookup still resolves actual second-line dock');
  eq(() => router.chainStepDock('b3', { lineId: 'line-two' }), null, 'known second-line terminal remains a real terminal');
  write(station);
  const changed = clone(station);
  changed.props.find(p => p.id === 'b1').brief = 'Revised saved brief';
  changed.props.find(p => p.id === 'i1').limits.maxUsdPerMessage = 0.1;
  changed.props = changed.props.filter(p => !p.id.startsWith('pc'));
  write(canonical(changed));
  const next = read();
  A.eq(next.topologyHash, first.topologyHash, 'policy-only edits retain dispatch topology');
  A.ok(next.identity !== first.identity, 'same-topology policy edits change full semantic authority');
  eq(() => router.stageBrief('alpha', 'b1'), 'Revised saved brief', 'fresh brief replaces earlier good view without POST');
  eq(() => router.lineLimits('line-one').maxUsdPerMessage, 0.1, 'fresh lower limit replaces earlier good view without POST');
  eq(() => router.stationFor('alpha', 'b1').rooms.bay.objects.some(o => o.objectType === 'computer'), false, 'removed saved compute cannot return via posted/default office');
  const corrupt = clone(JSON.parse(fs.readFileSync(primary, 'utf8'))); corrupt.doc.station.version = 3;
  fs.writeFileSync(primary, JSON.stringify(corrupt));
  for (const [name, args] of Object.entries(calls)) held(() => router[name](...args), 'future', name + ': invalid replacement cannot reuse earlier good floor');
  write(station);
  const cyclic = clone(station); Object.assign(cyclic.belts, { '18,5': 'E', '19,5': 'S', '19,6': 'W', '18,6': 'N' }); delete cyclic.links;
  write(canonical(cyclic));
  A.eq(read().routingOk, false, 'actual compiler marks the cycle undeployable');
  held(() => router.getPlan(), 'unroutable', 'unroutable floor cannot advertise an active dispatch plan');
  held(() => router.resolveDock({ lineId: 'line-one' }), 'unroutable', 'unroutable floor cannot dispatch from prior plan');
  eq(() => router.stageBrief('alpha', 'b1'), 'First draft', 'unroutable floor preserves real brief fact');
  eq(() => router.lineLimits('line-one').maxUsdPerMessage, 0.5, 'unroutable floor preserves real limit fact');
  eq(() => router.stationFor('alpha', 'b1').rooms.bay.objects.some(o => o.objectType === 'computer'), true, 'unroutable floor preserves actual capability facts');
  write(station);
  for (const name of ['setPlan', 'clearPlan', 'setStation', 'clearStation']) held(() => router[name](null), 'read-only', name + ': mutation cannot clear or replace the saved authority');
  store = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => now++ } });
  const restarted = makeRouter({ savedProjection: read });
  eq(() => restarted.resolveDock({ lineId: 'line-one' }), { agentId: 'alpha', dockId: 'b1' }, 'new router/save owner after restart routes solely from primary');
  eq(() => router.resolveDock({ lineId: 'line-one' }), { agentId: 'alpha', dockId: 'b1' }, 'restored primary re-proves without process restart');
  const split = clone(station);
  split.props = [
    { id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1, lineId: 'split-line' },
    { id: 'sp', t: 'splitter', x: 2, y: 0, w: 1, h: 1 },
    { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder', brief: 'Draft' },
    { id: 'br', t: 'bay', x: 1, y: 4, w: 2, h: 2, agentId: 'researcher' }
  ];
  split.belts = { '1,0': 'E', '2,0': 'E', '3,0': 'E', '4,0': 'E', '2,1': 'S', '2,2': 'S', '2,3': 'S' }; delete split.links;
  write(canonical(split));
  const splitProjection = read(), spread = makeRouter({ savedProjection: read });
  A.eq([splitProjection.status, splitProjection.routingOk], ['ok', true], 'real saved splitter compiles');
  attempt(() => spread.setPlan(splitProjection.plan)); // old-router positive setup only; current mode refuses it
  eq(() => spread.resolveTarget({ lineId: 'split-line' }), 'coder', 'saved splitter starts at first lane');
  split.props.find(p => p.id === 'bc').brief = 'Changed policy';
  split.props.find(p => p.id === 'i').limits = { maxHops: 4, maxUsdPerMessage: 0.2, maxUsdPerDay: 1 };
  split.props.push({ id: 'split-gear', t: 'console', x: 12, y: 0, w: 1, h: 1, agentId: 'coder' });
  write(canonical(split));
  A.eq(read().topologyHash, splitProjection.topologyHash, 'saved brief/limit/capability edit leaves splitter topology stable');
  eq(() => spread.stageBrief('coder', 'bc'), 'Changed policy', 'policy read consumes fresh saved view without resetting counters');
  eq(() => spread.resolveTarget({ lineId: 'split-line' }), 'researcher', 'policy-only saved edit preserves the owed second lane');
  eq(() => spread.resolveTarget({ lineId: 'split-line' }), 'coder', 'next dispatch returns to first lane');
  split.belts['5,1'] = 'E'; delete split.links; write(canonical(split));
  A.ok(read().topologyHash !== splitProjection.topologyHash, 'real added belt changes saved topology');
  eq(() => spread.resolveTarget({ lineId: 'split-line' }), 'coder', 'changed saved topology resets splitter balance');
  const bytes = fs.readFileSync(primary); fs.unlinkSync(primary);
  held(() => spread.resolveTarget({}), 'absent', 'missing primary clears prior splitter authority');
  fs.writeFileSync(primary, bytes);
  eq(() => spread.resolveTarget({ lineId: 'split-line' }), 'coder', 'reproved authority after absence starts a fresh splitter sequence');
  const throwing = makeRouter({ savedProjection: () => { throw Error('locked primary'); } });
  held(() => throwing.hasPlan(), 'unreadable', 'read exception cannot claim an absent/default plan');
  const legacy = makeRouter();
  A.ok(legacy.setPlan(clone(first.plan)).ok, 'legacy posted mode remains available');
  A.eq(legacy.dockOf('alpha', 'gone'), 'b1', 'legacy stale-dock behavior is unchanged until its callers migrate');
  A.eq(legacy.resolveTarget({ lineId: 'gone' }), null, 'legacy unresolved route behavior stays unchanged');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
A.report('routing.saved-projection');
