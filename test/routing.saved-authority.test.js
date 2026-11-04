'use strict';
// The saved authority over the REAL save store and compiler. The only fakes sit at the file edge: a counter on the primary's
// reads and stats, a read that can be locked, a stamp that can be made to move. No host and no router state of its own.
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const WM = require('../frontend/app/worldmodel.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { makeSaveStore } = require('../sidecar/savestore.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { makeSavedFloorProjection } = require('../sidecar/station-store.js');
const { makeSavedAuthority, RoutingHeld, HELD_CODES } = require('../sidecar/routing/saved-authority.js');

const clone = v => JSON.parse(JSON.stringify(v));
const canonical = raw => { const model = WM.deserialize(raw); model.projectGeometry(); return model.serialize(); };
const caught = fn => { try { fn(); return null; } catch (e) { return e; } };
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
// what the page posts: the same compiler and per-dock room grants as compileRouting, plus the links the JSON would drop
function pageHint(doc) {
  const model = WM.deserialize(doc), plan = Pipeline.compileRoutingPlan(model.projectGeometry());
  for (const bay of plan.bays || []) bay.objects = model.bayObjects(bay.agentId, bay.propId);
  for (const bay of plan.dockBays || []) bay.objects = model.bayObjects(bay.agentId, bay.propId);
  return clone({ version: 1, plan, compilerLinks: plan.links || null });
}
const EDITS = [
  ['brief', d => { d.props.find(p => p.id === 'b1').brief = 'Different exact brief'; }],
  ['capabilities', d => { d.props.push({ id: 'gear', t: 'rack', x: 18, y: 0, w: 1, h: 1 }); }],
  ['limits', d => { d.props.find(p => p.id === 'i1').limits = { maxHops: 8, maxUsdPerMessage: 0.25, maxUsdPerDay: 2 }; }],
  ['name', d => { d.props.find(p => p.id === 'i1').label = 'RENAMED'; }],
  ['projectRoot', d => { d.props.find(p => p.id === 'i1').projectRoot = 'C:/work/two'; }],
  ['SEND TO', d => { d.props.find(p => p.id === 'o1').sendTo = 'i2'; }]
];
const RECEIPT = r => [r.httpStatus, r.status, r.matched, r.routingOk, r.sourceStatus, r.identity];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-authority-'));
const spare = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-authority-copies-'));
const primary = path.join(root, 'agent.save.json');
let now = 1, locked = false, reads = 0, stats = 0;
const io = Object.create(fs);
io.readFileSync = (file, ...args) => {
  if (path.resolve(String(file)) === primary) { reads++; if (locked) throw Object.assign(new Error('fixture locked primary'), { code: 'EACCES' }); }
  return fs.readFileSync(file, ...args);
};
io.statSync = (file, ...args) => { if (path.resolve(String(file)) === primary) stats++; return fs.statSync(file, ...args); };
const open = () => makeSaveStore({ fs: io, pathMod: path, root, clock: { now: () => now++ } });
let store = open();
const readOf = extra => Object.assign({ agentId: 'agent',
  stamp: () => store.stamp('agent'),
  loadPrimaryState: () => store.loadPrimaryState('agent'),
  hasRecoveryCopy: () => store.hasRecoveryCopy('agent') }, extra);
const reset = () => { reads = 0; stats = 0; };
const write = station => {
  const previous = store.loadPrimaryState('agent');
  const result = store.save('agent', { schema: 'starnet.save', version: require('../frontend/app/save.js').CURRENT, updatedAt: now++,
    _saveRevision: previous.status === 'ok' ? previous.wrapper.revision : 0, _saveClient: 'saved-authority-test',
    _saveDirty: true, agent: { id: 'agent' }, station }, { compareRevision: true });
  if (!result.ok) throw new Error('fixture real save failed');
  return result;
};
// An edit from OUTSIDE the store, the way a restore, a sync client or an editor makes one. The stamp is an invalidation
// token (size, file id and mtime), so each outside edit is given its own mtime: a same-size rewrite inside one clock tick
// is the documented limit of a stamp, not something this file is here to prove.
let mtime = 1700000000;
const outside = bytes => { fs.writeFileSync(primary, bytes); mtime += 2; fs.utimesSync(primary, mtime, mtime); };
const authority = makeSavedAuthority({ read: readOf() });
const router = makeRouter({ savedProjection: authority.projection });
const held = (status, state) => ({ code: HELD_CODES[status], status, state: state || 'held' });
const typed = e => e && { code: e.code, status: e.status, state: e.state };

try {
  // ---- the interface -------------------------------------------------------------------------------------------------------
  A.eq(Object.keys(authority).sort(), ['HELD_CODES', 'bindingOf', 'checkBinding', 'compareHint', 'projection', 'require', 'status'], 'the published interface, nothing more');
  A.ok(Object.isFrozen(authority) && Object.isFrozen(HELD_CODES) && authority.HELD_CODES === HELD_CODES, 'the interface and its code table are immutable');
  A.throws(() => makeSavedAuthority(), 'a reader is required');
  A.throws(() => makeSavedAuthority({ read: readOf({ hasRecoveryCopy: undefined }) }), 'no recovery probe: a missing primary could not be told from a lost one');
  A.throws(() => makeSavedAuthority({ read: readOf({ stamp: undefined }) }), 'no stamp: no memo and no freshness proof');
  A.throws(() => makeSavedAuthority({ read: readOf({ loadPrimaryState: undefined }) }), 'no primary reader');
  A.throws(() => makeSavedAuthority({ read: readOf({ agentId: '../escape' }) }), 'an exact save owner is required');
  const statuses = Object.keys(HELD_CODES);
  A.eq(statuses.slice().sort(), ['absent', 'changed', 'corrupt', 'future', 'invalid', 'migration-required', 'unavailable', 'unfloored', 'unreadable',
    'unroutable', 'unstamped', 'unsupported-geometry', 'unvouched'], 'every status the authority can report has a typed code');
  for (const s of statuses) A.eq(HELD_CODES[s], 'EROUTING_SAVED_' + s.toUpperCase().replace(/[^A-Z0-9]/g, '_'), s + ': the router\'s own code grammar');
  const sample = new RoutingHeld('corrupt');
  A.ok(sample instanceof Error && sample.name === 'RoutingHeld', 'RoutingHeld is a typed Error');
  A.eq([sample.code, sample.status, sample.state, sample.message], ['EROUTING_SAVED_CORRUPT', 'corrupt', 'held', 'Saved routing authority is held: corrupt'], 'it names the status the way the router does');

  // ---- UNFLOORED vs HELD: a new install is not a lost floor ----------------------------------------------------------------
  const first = authority.status();
  A.eq([first.state, first.status, first.routingOk, first.identity, first.revision, first.stamp, first.topologyHash], ['unfloored', 'unfloored', false, null, null, null, null],
    'no primary and no copy: unfloored, with nothing proved');
  A.ok(Object.isFrozen(first), 'status is immutable');
  A.eq(authority.projection().status, 'unfloored', 'the router is told the same reason');
  A.eq(typed(caught(() => authority.require())), held('unfloored', 'unfloored'), 'unfloored is typed, and tells itself apart from a held floor');
  A.eq(typed(caught(() => authority.bindingOf())), held('unfloored', 'unfloored'), 'nothing to bind a run to');
  A.eq((caught(() => router.resolveDock({ lineId: 'line-one' })) || {}).code, HELD_CODES.unfloored, 'a router over this authority throws the unfloored code');
  const station = floor(), hint = pageHint(station);
  const noFloor = authority.compareHint(hint);
  A.eq([RECEIPT(noFloor), noFloor.reason], [[409, 'pending', false, false, 'unfloored', null], 'unfloored'], 'a hint with nothing saved is pending: the page\'s floor is unsaved');
  A.eq(authority.checkBinding({ planIdentity: 'saved-plan-v1:' + 'a'.repeat(64) }), 'held', 'no floor, so no binding can be current');
  A.ok(!fs.existsSync(primary) && fs.readdirSync(root).length === 0, 'asking never creates, recovers or quarantines anything');

  // ---- the memo: read once on an unchanged stamp, again on a save --------------------------------------------------------
  A.ok(write(station).ok, 'real save owner writes the canonical floor');
  reset();
  const warm = authority.projection();
  A.eq([warm.status, warm.routingOk, reads], ['ok', true, 1], 'the first ask reads the save once');
  A.eq(JSON.stringify(warm), JSON.stringify(makeSavedFloorProjection(readOf())()), 'and is the private projection, unchanged');
  reset();
  for (let i = 0; i < 20; i++) { router.resolveDock({ lineId: 'line-one' }); router.stageBrief('alpha', 'b1'); }
  A.eq([reads, stats], [0, 40], 'forty router calls on an unchanged stamp read the save zero times and stat it once each');
  A.ok(authority.projection() === warm, 'the same immutable projection, not a copy');
  reset();
  const s0 = authority.status(), b0 = authority.bindingOf(), warmIdentity = warm.identity;
  authority.require(); authority.compareHint(hint); authority.checkBinding({ planIdentity: warmIdentity });
  A.eq([reads, stats], [0, 5], 'status, bindingOf, require, compareHint and checkBinding are one stat each on a hit');
  A.eq([s0.state, s0.status, s0.routingOk, s0.identity, s0.revision, s0.stamp, s0.topologyHash],
    ['ok', 'ok', true, warm.identity, warm.revision, warm.stamp, warm.topologyHash], 'status carries only what the saved owner proved');
  A.ok(authority.status() === s0, 'a hit hands back the same frozen status');
  A.eq([Object.keys(b0), Object.isFrozen(b0), b0.planIdentity, b0.topologyHash, b0.revision], [['planIdentity', 'topologyHash', 'revision'], true, warm.identity, warm.topologyHash, warm.revision],
    'the binding is the identity, the topology hash and the revision, and nothing process-local');
  A.ok(/^saved-plan-v1:[a-f0-9]{64}$/.test(b0.planIdentity) && /^[0-9a-f]{8}$/.test(b0.topologyHash), 'versioned identity beside the 8-hex topology hash');
  const revised = clone(station); revised.props.find(p => p.id === 'b1').brief = 'Revised saved brief';
  write(canonical(revised)); reset();
  const afterSave = authority.projection();
  A.eq([reads, afterSave.status], [1, 'ok'], 'a save moves the stamp and the next ask reads once');
  A.ok(afterSave.identity !== warm.identity && afterSave.topologyHash === warm.topologyHash, 'the new brief is a new identity at the same topology');
  A.eq(router.stageBrief('alpha', 'b1'), 'Revised saved brief', 'the router sees the saved brief with no POST');
  for (let i = 0; i < 10; i++) router.stageBrief('alpha', 'b1');
  A.eq(reads, 1, 'and then stays on the memo');
  const hintBytes = JSON.stringify(hint), before = fs.readFileSync(primary);
  authority.compareHint(hint); authority.compareHint(null);
  A.ok(authority.projection() === afterSave && JSON.stringify(hint) === hintBytes && fs.readFileSync(primary).equals(before), 'a hint, matched or not, changes neither the memo, the hint nor the save');
  write(station); reset();
  A.eq([authority.projection().identity, reads], [warm.identity, 1], 'writing the first floor back is the first identity again');
  // a restart is a new store and a new authority over the same primary: the same identity, one read
  store = open();
  const reborn = makeSavedAuthority({ read: readOf() });
  reset();
  A.eq([reborn.status().identity, reborn.status().state, reads], [warm.identity, 'ok', 1], 'after a restart the same saved floor proves the same identity');
  A.eq(reborn.compareHint(hint).httpStatus, 200, 'and the same hint');

  // ---- INVARIANT no-non-ok-routable: the whole held-state table, with the memo warm on a good floor ------------------------
  const goodBytes = fs.readFileSync(primary), good = JSON.parse(goodBytes), goodIdentity = warm.identity, goodHint = hint;
  fs.writeFileSync(primary + '.bak', goodBytes);   // a valid backup is no stand-in for the primary
  const edit = fn => { const w = clone(good); fn(w); return Buffer.from(JSON.stringify(w)); };
  const settle = label => {
    outside(goodBytes);
    const s = authority.status();
    A.eq([s.state, s.identity], ['ok', goodIdentity], label + ': the restored primary re-proves without a restart');
    A.eq((authority.projection() || {}).status, 'ok', label + ': and routes again');
  };
  function heldRow(label, bytes, status, opts) {
    const prior = authority.projection();
    A.eq(prior.identity, goodIdentity, label + ': the memo holds the good floor first');
    if (opts && opts.lock) locked = true;
    outside(bytes);
    const written = fs.readFileSync(primary);
    const s = authority.status(), p = authority.projection();
    A.eq([s.state, s.status, s.routingOk, s.identity, s.revision, s.stamp, s.topologyHash], ['held', status, false, null, null, null, null], label + ': held, with nothing proved');
    A.ok(p !== prior && p.status === status && p.plan === null && p.stationDoc === null && p.identity === null && p.routingOk === false, label + ': no earlier good projection is served');
    A.eq(typed(caught(() => authority.require())), held(status), label + ': the dispatch gate throws the typed code');
    A.eq(typed(caught(() => authority.bindingOf())), held(status), label + ': nothing is bound to a held floor');
    A.eq(RECEIPT(authority.compareHint(goodHint)), [503, 'unavailable', false, false, status, null], label + ': the hint answer is held, never matched');
    A.eq(authority.checkBinding({ planIdentity: goodIdentity }), 'held', label + ': the old identity is not current');
    A.eq(authority.checkBinding({ planHash: warm.topologyHash }), 'legacy-unbound', label + ': a legacy record stays legacy-unbound');
    A.eq((caught(() => router.resolveDock({ lineId: 'line-one' })) || {}).code, HELD_CODES[status], label + ': the router refuses with the same code');
    A.eq((caught(() => router.stageBrief('alpha', 'b1')) || {}).code, HELD_CODES[status], label + ': and so does a brief read, no last-good value');
    A.eq(fs.readFileSync(primary).equals(written) && fs.readFileSync(primary + '.bak').equals(goodBytes), true, label + ': the primary and the backup are untouched');
    locked = false;
    settle(label);
  }
  settle('table start');
  for (const [label, bytes, status] of [
    ['future wrapper', edit(w => { w.version = 2; }), 'future'],
    ['wrong owner', edit(w => { w.agentId = 'someone-else'; }), 'invalid'],
    ['mismatched revision', edit(w => { w.revision++; }), 'invalid'],
    ['mismatched writer', edit(w => { w.client = 'another-window'; }), 'unvouched'],
    ['missing writer', edit(w => { delete w.client; }), 'unvouched'],
    ['future save', edit(w => { w.doc.version = require('../frontend/app/save.js').CURRENT + 1; }), 'future'],
    ['future station', edit(w => { w.doc.station.version = 3; }), 'future'],
    ['legacy station', edit(w => { w.doc.station.version = 1; }), 'migration-required'],
    ['duplicate dock identity', edit(w => { w.doc.station.props.find(p => p.id === 'b2').id = 'b1'; }), 'invalid'],
    ['unsupported geometry', edit(w => { w.doc.station.order = []; }), 'unsupported-geometry'],
    ['corrupt primary', Buffer.from('{broken'), 'corrupt'],
    ['empty primary', Buffer.alloc(0), 'corrupt']
  ]) heldRow(label, bytes, status);
  heldRow('unreadable (a changed file that cannot be read)', Buffer.concat([goodBytes, Buffer.from('\n')]), 'unreadable', { lock: true });
  // a lock that leaves the bytes and the stamp alone does not move authority: the bytes at this stamp are still the proved ones
  authority.projection(); reset(); locked = true;
  A.eq([authority.status().state, authority.status().identity, reads], ['ok', goodIdentity, 0], 'a lock on unchanged bytes does not flap routing (the stamp is the token)');
  locked = false;

  // absent: beside any copy it is a lost floor (held); beside none it is a new install (unfloored)
  for (const copy of ['.bak', '.corrupt-1', '.corrupt', '.corrupt-4242-7', '.unseen-1', '.bak.corrupt-1']) {
    fs.unlinkSync(primary + '.bak');
    authority.projection();
    fs.unlinkSync(primary); fs.writeFileSync(primary + copy, goodBytes);
    const s = authority.status();
    A.eq([s.state, s.status, s.routingOk, s.identity], ['held', 'absent', false, null], 'absent beside ' + copy + ': held, the floor existed');
    A.eq(typed(caught(() => authority.require())), held('absent'), 'absent beside ' + copy + ': typed absent');
    A.eq((caught(() => router.resolveDock({ lineId: 'line-one' })) || {}).code, HELD_CODES.absent, 'absent beside ' + copy + ': the router refuses');
    A.eq(RECEIPT(authority.compareHint(goodHint)), [503, 'unavailable', false, false, 'absent', null], 'absent beside ' + copy + ': the hint answer is held');
    fs.unlinkSync(primary + copy);
    A.eq([authority.status().state, authority.status().status], ['unfloored', 'unfloored'], 'the same absence with the copy gone: unfloored');
    fs.writeFileSync(primary + '.bak', goodBytes);
    settle('absent beside ' + copy);
  }
  fs.unlinkSync(primary); fs.writeFileSync(primary + '.bak', goodBytes);
  const doubtful = makeSavedAuthority({ read: readOf({ hasRecoveryCopy: () => { throw new Error('probe broke'); } }) });
  fs.unlinkSync(primary + '.bak');
  A.eq([doubtful.status().state, doubtful.status().status], ['held', 'absent'], 'a probe that cannot answer is doubt: held, never unfloored');
  A.eq(authority.status().state, 'unfloored', 'the same absence with a working probe');
  fs.writeFileSync(primary + '.bak', goodBytes);
  settle('after the probe');

  // the freshness proof itself: a stamp that cannot be had, cannot be trusted, or will not hold still
  let broken = false, loads = 0;
  const flaky = makeSavedAuthority({ read: readOf({ stamp: () => { if (broken) throw new Error('stat failed'); return store.stamp('agent'); },
    loadPrimaryState: () => { loads++; return store.loadPrimaryState('agent'); } }) });
  A.eq(flaky.projection().status, 'ok', 'a working stamp proves the floor');
  broken = true;
  A.eq([flaky.status().state, flaky.status().status], ['held', 'unreadable'], 'a stamp that throws is never a hit: held unreadable, not the memo');
  broken = false;
  A.eq(flaky.status().state, 'ok', 'and recovers');
  const unstamped = makeSavedAuthority({ read: readOf({ stamp: () => '', loadPrimaryState: () => { loads++; return store.loadPrimaryState('agent'); } }) });
  loads = 0;
  const un = unstamped.status(); unstamped.status();
  A.eq([un.status, un.state, loads], ['unstamped', 'held', 2], 'no stamp, no proof of freshness, and nothing is memoized without one: every ask reads');
  const odd = makeSavedAuthority({ read: readOf({ loadPrimaryState: () => ({ status: 'recovered' }) }) });
  A.eq([odd.status().state, odd.status().status], ['held', 'unavailable'], 'a source that is not plainly ok is held, whatever it is called');

  // a save that lands mid-read is re-read, boundedly, and does not flap into a refusal
  let tick = 0, landed = false;
  loads = 0;
  const moving = makeSavedAuthority({ read: readOf({ stamp: () => String(++tick), loadPrimaryState: () => { loads++; return store.loadPrimaryState('agent'); } }) });
  const m = moving.status();
  A.eq([m.state, m.status, loads], ['held', 'changed', 3], 'a stamp that never holds still is held changed after one read and two re-reads, not a loop');
  A.eq(typed(caught(() => moving.require())), held('changed'), 'changed is typed');
  loads = 0;
  const racing = makeSavedAuthority({ read: readOf({ loadPrimaryState: () => {
    loads++;
    const r = store.loadPrimaryState('agent');
    if (!landed) { landed = true; write(canonical(revised)); }   // a real save lands after the stamp was taken and before it is checked
    return r;
  } }) });
  const landedStatus = racing.status();
  A.eq([landedStatus.state, loads], ['ok', 2], 'a save landing mid-read costs one re-read and the answer is the NEW floor');
  A.eq(landedStatus.identity, makeSavedFloorProjection(readOf())().identity, 'the re-read is the saved floor now, not the one the first read held');
  write(station);

  // ---- an unroutable floor: proved, and still does not route -------------------------------------------------------------
  const cyclic = clone(station); Object.assign(cyclic.belts, { '18,5': 'E', '19,5': 'S', '19,6': 'W', '18,6': 'N' }); delete cyclic.links;
  const blockedFloor = canonical(cyclic), blockedHint = pageHint(blockedFloor);
  write(blockedFloor); reset();
  const u = authority.status(), up = authority.projection();
  A.eq([u.state, u.status, u.routingOk, /^saved-plan-v1:[a-f0-9]{64}$/.test(u.identity), u.revision >= 1], ['unroutable', 'unroutable', false, true, true], 'a compiler-blocked floor is proved and unroutable');
  A.eq([up.status, up.routingOk, up.plan && up.plan.errors.some(e => e.code === 'CYCLE')], ['ok', false, true], 'its capability, brief and limit facts stay readable for the router');
  A.eq(typed(caught(() => authority.require())), held('unroutable', 'unroutable'), 'the dispatch gate refuses it');
  A.eq(typed(caught(() => authority.bindingOf())), held('unroutable', 'unroutable'), 'and nothing is bound to it');
  A.eq(authority.checkBinding({ planIdentity: u.identity }), 'held', 'even its own identity is never current');
  A.eq([RECEIPT(authority.compareHint(blockedHint)), authority.compareHint(blockedHint).reason], [[422, 'unroutable', false, false, 'ok', u.identity], 'saved-floor-unroutable'],
    'an exactly matched blocked floor is 422 unroutable with the saved identity');
  A.eq(RECEIPT(authority.compareHint(goodHint)), [409, 'pending', false, false, 'ok', null], 'a different hint does not hide behind the compiler refusal');
  A.eq((caught(() => router.getPlan()) || {}).code, HELD_CODES.unroutable, 'the router refuses to dispatch it');
  reset();
  A.eq([router.stageBrief('alpha', 'b1'), reads], ['First draft', 0], 'but reads its brief, off the memo');
  write(station);

  // ---- INVARIANT legacy-hash-not-authority, over a family of floors that share one topology -------------------------------
  const family = [['base', station]].concat(EDITS.map(([name, change]) => { const d = clone(station); change(d); return [name, canonical(d)]; }))
    .map(([name, saved]) => { write(saved); return { name, saved, hint: pageHint(saved), binding: authority.bindingOf() }; });
  A.eq(new Set(family.map(f => f.binding.topologyHash)).size, 1, 'the family is not vacuous: every edit keeps the one 8-hex topology hash');
  A.eq(new Set(family.map(f => f.binding.planIdentity)).size, family.length, 'but each edit is its own identity');
  for (const f of family) {
    write(f.saved);
    A.eq(authority.status().topologyHash, family[0].binding.topologyHash, f.name + ': the legacy hash really does equal the current topology hash');
    for (const g of family) {
      const same = f === g, tag = f.name + ' saved, ' + g.name + ' recorded';
      A.eq(authority.checkBinding({ planIdentity: g.binding.planIdentity }), same ? 'current' : 'stale', tag + ': only the exact identity is current');
      A.eq(authority.checkBinding({ planHash: g.binding.topologyHash }), 'legacy-unbound', tag + ': an 8-hex hash alone is legacy-unbound, even when it equals the current one');
      A.eq(authority.checkBinding({ planHash: g.binding.topologyHash, planIdentity: g.binding.planIdentity }), same ? 'current' : 'stale', tag + ': beside an identity the hash decides nothing');
      const receipt = authority.compareHint(g.hint);
      A.eq(RECEIPT(receipt), same ? [200, 'ok', true, true, 'ok', f.binding.planIdentity] : [409, 'pending', false, false, 'ok', null], tag + ': the hint is acknowledged only for the saved floor');
      A.eq([receipt.revision, receipt.stamp], same ? [authority.status().revision, authority.status().stamp] : [null, null], tag + ': revision and stamp come from the saved owner or not at all');
    }
  }
  write(station);
  const cur = authority.bindingOf(), other = 'saved-plan-v1:' + 'b'.repeat(64);
  for (const [label, record, expected] of [
    ['exact identity', { planIdentity: cur.planIdentity }, 'current'],
    ['exact identity, junk hash', { planIdentity: cur.planIdentity, planHash: 'deadbeef' }, 'current'],
    ['another identity', { planIdentity: other }, 'stale'],
    ['8-hex equal to the current topology', { planHash: cur.topologyHash }, 'legacy-unbound'],
    ['8-hex equal to the topology beside a stale identity', { planHash: cur.topologyHash, planIdentity: other }, 'stale'],
    ['empty record', {}, 'legacy-unbound'],
    ['null', null, 'legacy-unbound'],
    ['undefined', undefined, 'legacy-unbound'],
    ['a bare identity string', cur.planIdentity, 'legacy-unbound'],
    ['an array', [cur.planIdentity], 'legacy-unbound'],
    ['a number', 42, 'legacy-unbound'],
    ['an identity that is not a string', { planIdentity: 12345 }, 'legacy-unbound'],
    ['upper-case digest', { planIdentity: 'saved-plan-v1:' + cur.planIdentity.slice(14).toUpperCase() }, 'legacy-unbound'],
    ['short digest', { planIdentity: 'saved-plan-v1:abc' }, 'legacy-unbound'],
    ['a trailing space', { planIdentity: cur.planIdentity + ' ' }, 'legacy-unbound'],
    ['a future identity version', { planIdentity: 'saved-plan-v2:' + cur.planIdentity.slice(14) }, 'legacy-unbound'],
    ['an identity only the prototype carries', Object.create({ planIdentity: cur.planIdentity }), 'legacy-unbound']
  ]) A.eq(authority.checkBinding(record), expected, 'checkBinding: ' + label);
  fs.unlinkSync(primary + '.bak');
  A.eq(authority.checkBinding({ planIdentity: cur.planIdentity }), 'current', 'a backup beside the primary changes nothing');
  A.eq(authority.require().identity, cur.planIdentity, 'require returns the status of a routable floor');

  // ---- savestore.hasRecoveryCopy: what the authority asks to tell a new install from a lost floor --------------------------
  const plain = makeSaveStore({ fs, pathMod: path, root: spare, clock: { now: () => now++ } });
  A.eq(plain.hasRecoveryCopy('agent'), false, 'an empty directory has no copy');
  A.eq(makeSaveStore({ fs, pathMod: path, root: path.join(spare, 'not-yet'), clock: { now: () => now++ } }).hasRecoveryCopy('agent'), false, 'a directory that does not exist has none either');
  for (const name of ['agent.save.json', 'agent.save.json.12345.abcd.tmp', 'agent.save-conflict-1.json', 'agent.save.recovery.json', 'agent.save.json.tmp',
    'other.save.json.bak', 'agent-2.save.json.bak', 'xagent.save.json.corrupt-1', 'agent.save.json.bak2']) {
    fs.writeFileSync(path.join(spare, name), '{}');
    A.eq(plain.hasRecoveryCopy('agent'), false, name + ' is not a copy of this save');
    fs.unlinkSync(path.join(spare, name));
  }
  for (const name of ['agent.save.json.bak', 'agent.save.json.corrupt-1', 'agent.save.json.corrupt', 'agent.save.json.corrupt-4242-7', 'agent.save.json.unseen-3',
    'agent.save.json.bak.corrupt-2']) {
    fs.writeFileSync(path.join(spare, name), '{}');
    A.eq(plain.hasRecoveryCopy('agent'), true, name + ' is a copy of this save');
    A.eq(plain.hasRecoveryCopy('agent-2'), false, name + ' is nobody else\'s copy');
    fs.unlinkSync(path.join(spare, name));
  }
  A.throws(() => plain.hasRecoveryCopy('../escape'), 'the id grammar is checked before any listing');
  const noList = Object.create(fs); noList.readdirSync = undefined;
  A.eq(makeSaveStore({ fs: noList, pathMod: path, root: spare, clock: { now: () => now++ } }).hasRecoveryCopy('agent'), true, 'a host that cannot list answers doubt');
  const failList = Object.create(fs); failList.readdirSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  A.eq(makeSaveStore({ fs: failList, pathMod: path, root: spare, clock: { now: () => now++ } }).hasRecoveryCopy('agent'), true, 'a listing that fails answers doubt');
} finally {
  for (const target of [root, spare].map(p => path.resolve(p))) {
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('saved-authority-')) throw new Error('fixture cleanup escaped owned root');
    fs.rmSync(target, { recursive: true, force: true });
  }
}
A.report('routing.saved-authority');
