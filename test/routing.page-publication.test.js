/* node test/routing.page-publication.test.js — A PAGE EDIT IS PUBLISHED ONLY AFTER ITS SAVE LANDS
   (invariant publish-only-after-save; lane saved-floor-routing-authority, S4).

   The sidecar routes by the floor the user SAVED (routing/saved-authority.js). The page no longer installs a plan: it posts a HINT,
   {version:1, plan, compilerLinks}, and asks whether that is exactly the floor the station holds. So a floor edit must reach the
   station file before the page may call it published, and until then the honest answer is pending, with the page stale.

   The chain under test is the product's own, with fakes only at the transport edge:
     the shipped poster of frontend/app/world.js, executed from its source as plan-poster.test.js does: the PLAN-POSTER block, the
     page's own wiring (`const planPoster = makePlanPoster({...})`) and its `postRoutingPlan`, with fetch, CloudSave and the clock faked
       -> its save step floorSaved over the REAL frontend/app/cloudsave.js (flushForUpdate)
       -> the REAL /api/save handlers of sidecar/index.js -> the REAL save store on a temp workspace
       -> the REAL saved authority (compareHint) that answers the page's POST /api/routing.
   The page's own compile is the compiler's (WorldModel.projectGeometry + Pipeline.compileRoutingPlan + the per-bay room grants
   World.compileRouting adds), and every edit below is a kind of floor edit the page offers again: topology, the line budget (policy),
   a belt-hooked bay's brief, a lone dock's brief, capabilities, a line's name, its project root and a SEND TO.

   For EVERY kind of edit, in each order a page can reach the post in:
     A  the same turn   the edit's persist is queued at the change (app.js watchStationSave) and the page publishes in that turn
                        (World.syncPlan after a build): the save step runs one turn late, the save lands, then the post. No retry.
     B  the save fails  the station file is unreachable: NOTHING is posted, the page stays stale and records the floor as unsaved;
                        the station comes back, the retry asks the save again, and only then is the floor posted and acknowledged.
     C  post first      the page posts before its persist was queued (nothing pending, so the save step passes): the station answers
                        409 pending for a floor it does not hold, nothing is committed, and the retry after the save commits it.
   and across all of them: the page acknowledges a floor (200, lastHash) only when the station file holds exactly that floor, and
   every post made before it does is answered pending (409). Red at the base: the poster posted the bare plan at once, with no links
   and no wait for the save, so no page floor was ever acknowledged by the saved authority. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const K = require('./_save-restore-kit.js');
const WM = require('../frontend/app/worldmodel.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { makeSavedAuthority } = require('../sidecar/routing/saved-authority.js');
const { canonical, clone, hintFor } = require('./helpers/saved-floor.js');

// ---- the shipped poster block, executed from the source ----
const src = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
const BEGIN = 'PLAN-POSTER-BEGIN', END = 'PLAN-POSTER-END';
const i0 = src.indexOf(BEGIN), i1 = src.indexOf(END);
A.ok(i0 >= 0 && i1 > i0, 'world.js carries the PLAN-POSTER extraction markers');
const block = src.slice(src.indexOf('*/', i0) + 2, src.lastIndexOf('/*', i1));
const lib = eval('(function(){' + block + '\nreturn { makePlanPoster, routingKeyOf: typeof routingKeyOf === "function" ? routingKeyOf : null, floorSaved: typeof floorSaved === "function" ? floorSaved : null };})()');
A.ok(lib.routingKeyOf && lib.floorSaved, 'the block carries the dedupe key and the save step');
// a page without it gets a stand-in, so the family below still runs and reports each way the old poster fails it
const keyOf = lib.routingKeyOf || (plan => String(plan && plan.hash));

// ---- the production wiring, EXECUTED: world.js's own `const planPoster = makePlanPoster({...})` and `function postRoutingPlan`, run with the
// page's globals faked at the transport edge (fetch, CloudSave, the clock). Nothing about the poster's deps is restated in this file.
const sliceOf = (from, to) => { const at = src.indexOf(from); A.ok(at > 0, 'world.js carries ' + from); return at < 0 ? '' : src.slice(at, src.indexOf(to, at) + to.length); };
const WIRING = sliceOf('const planPoster = makePlanPoster({', '\n  });');
const POSTER_FN = sliceOf('function postRoutingPlan(plan) {', '\n  }\n');

// ---- the floor: two lines, a lone dock, consoles for every crew member ----
function baseFloor() {
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
    { id: 'b9', t: 'bay', x: 20, y: 5, w: 1, h: 1, agentId: 'zeta', brief: 'Standing duty' },
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
const EDITS = [
  ['topology', d => {   // a fourth stage on line two: its OUTBOX moves down the belt and a new crew member takes the stage between
    d.props.find(p => p.id === 'o2').x = 13;
    d.props.push({ id: 'b4', t: 'bay', x: 7, y: 5, w: 1, h: 1, agentId: 'delta' }, { id: 'pc4', t: 'console', x: 18, y: 0, w: 1, h: 1, agentId: 'delta' });
    for (const x of [8, 9, 10, 11, 12]) d.belts[x + ',5'] = 'E';
  }],
  ['line budget (policy)', d => { d.props.find(p => p.id === 'i1').limits = { maxHops: 8, maxUsdPerMessage: 0.25, maxUsdPerDay: 2 }; }],
  ['brief', d => { d.props.find(p => p.id === 'b1').brief = 'Draft it tighter'; }],
  ['a lone dock\'s brief', d => { d.props.find(p => p.id === 'b9').brief = 'Standing duty, changed'; }],
  ['capabilities', d => { d.props.push({ id: 'gear', t: 'rack', x: 18, y: 0, w: 1, h: 1 }); }],
  ['line name', d => { d.props.find(p => p.id === 'i1').label = 'RENAMED'; }],
  ['project root', d => { d.props.find(p => p.id === 'i1').projectRoot = 'C:/work/two'; }],
  ['SEND TO', d => { d.props.find(p => p.id === 'o1').sendTo = 'i2'; }]
];

// World.compileRouting: the compiler, then each bay's room grants
function compilePage(doc) {
  const st = WM.deserialize(doc), plan = Pipeline.compileRoutingPlan(st.projectGeometry());
  for (const b of plan.bays || []) b.objects = st.bayObjects(b.agentId, b.propId);
  for (const b of plan.dockBays || []) b.objects = st.bayObjects(b.agentId, b.propId);
  return plan;
}

const tick = () => new Promise(r => setImmediate(r));
// until the poster has its verdict on the floor it is delivering (a pending retry is not a verdict). Bounded by the clock, not by turns:
// the save step and the station's handlers are promise chains over synchronous file work, so this returns within a few turns
async function settled(w) { const until = Date.now() + 20000; while (w.poster.state().inflight && Date.now() < until) await tick(); A.ok(!w.poster.state().inflight, 'the poster reached a verdict'); }

// ---- one page + one station, wired the way the product wires them ----
function makeWorld() {
  const root = K.workspace(), host = K.sidecar(root), store = host.saveStore;
  const cache = new Map();
  const w = { posts: [], warns: [], timers: [], log: [], down: false, pageDoc: null, stamp: 1000 };
  // the transport edge: the page reaches the station through fetch, and the station can be unreachable
  const edge = { fetch: (url, opts) => {
    if (w.down) return Promise.reject(new Error('station unreachable'));
    return host.fetch(url, opts).then(async r => {
      // the station file took a write only when the station SAID so (a 200 can carry a refusal)
      if (opts && opts.method === 'POST' && String(url).split('?')[0] === '/api/save') { const b = await r.json().catch(() => null); if (b && b.ok === true) w.log.push('save'); }
      return r;
    });
  } };
  w.cloud = K.page(edge, cache);
  w.authority = makeSavedAuthority({ read: { agentId: 'agent', stamp: () => store.stamp('agent'), loadPrimaryState: () => store.loadPrimaryState('agent'), hasRecoveryCopy: () => store.hasRecoveryCopy('agent') } });
  const held = () => { const s = store.loadPrimaryState('agent'); return s.status === 'ok' ? s.wrapper.doc.station : null; };
  w.holds = doc => isDeepStrictEqual(held(), doc);
  // App.persist: the live station, queued for the station file (debounced; the page's flush sends it)
  w.persist = () => w.cloud.push(K.stationDoc({ station: clone(w.pageDoc), updatedAt: ++w.stamp, version: require('../frontend/app/save.js').CURRENT }));
  // the page's globals the wiring reaches for, faked at the edge: the station's route, CloudSave, the clock
  const scope = {
    makePlanPoster: lib.makePlanPoster, floorSaved: lib.floorSaved, routingKeyOf: lib.routingKeyOf, CloudSave: w.cloud,
    apiUrl: p => p,
    fetch: (url, init) => {
      A.ok(url === '/api/routing' && init && init.method === 'POST' && /json/.test((init.headers || {})['Content-Type']), 'the page posts JSON to /api/routing');
      const wire = JSON.parse(init.body), verdict = w.authority.compareHint(wire);
      w.posts.push({ wire, status: verdict.httpStatus, saveLanded: w.holds(w.pageDoc), identity: verdict.identity }); w.log.push('post:' + verdict.httpStatus);
      return Promise.resolve({ ok: verdict.httpStatus === 200, status: verdict.httpStatus });
    },
    console: { warn: m => w.warns.push(m) },
    setTimeout: (fn, ms) => { const t = { fn, ms, fired: false }; w.timers.push(t); return t; },
    clearTimeout: t => { if (t) t.fired = true; }
  };
  const real = new Function(...Object.keys(scope), WIRING + '\nreturn planPoster;')(...Object.values(scope));
  // a spy on the key postRoutingPlan offers a floor under
  w.poster = { offer: (plan, key) => { w.offeredKey = key; return real.offer(plan, key); }, state: real.state, flush: real.flush };
  const postRoutingPlan = new Function('planPoster', 'routingKeyOf', 'fetch', POSTER_FN + '\nreturn postRoutingPlan;')(w.poster, lib.routingKeyOf, () => {});
  w.pending = () => w.timers.filter(t => !t.fired);
  w.fire = () => { const t = w.pending()[0]; A.ok(t, 'a retry timer is armed to fire'); t.fired = true; t.fn(); };
  // World.compileRouting -> postRoutingPlan
  w.publish = doc => { const plan = compilePage(doc); postRoutingPlan(plan); return { plan, key: w.offeredKey }; };
  w.reset = () => { w.log.length = 0; };
  w.close = () => K.cleanup();
  return w;
}

// the page draws `doc`, its persist ran at the change (the frame order), the page offers it, and the station acknowledged it
async function acknowledged(w, doc, what) {
  w.pageDoc = doc;
  if (!w.holds(doc)) w.persist();
  const { key } = w.publish(doc);
  await settled(w);
  const s = w.poster.state();
  A.eq([s.lastHash === key, s.stale, s.unsavedHash, w.holds(doc)], [true, false, null, true], what + ': acknowledged, and the station file holds it');
}

(async () => {
  const world = makeWorld();
  const base = baseFloor();
  const everything = [];   // every post of every scenario
  try {
    // the station holds nothing yet: a hint of the page's first floor is pending, never installed
    world.pageDoc = base;
    const first = world.authority.compareHint(hintFor(base));
    A.eq([first.httpStatus, first.sourceStatus], [409, 'unfloored'], 'nothing is saved yet: the page\'s floor is pending');
    await acknowledged(world, base, 'the first floor (persist, then the frame\'s post)');
    const baseKey = keyOf(compilePage(base));
    const baseIdentity = world.authority.status().identity;
    A.ok(/^saved-plan-v1:[a-f0-9]{64}$/.test(baseIdentity || ''), 'the first save routes: the station reports its own identity');

    for (const [kind, edit] of EDITS) {
      const edited = canonical((() => { const d = clone(base); edit(d); return d; })());
      const planE = compilePage(edited), keyE = keyOf(planE);
      A.ok(Pipeline.ok(planE), kind + ': fixture: the edited floor is routable');
      A.ok(keyE !== baseKey, kind + ': the edit moves the dedupe key, so the page offers it again');
      A.eq(world.authority.compareHint(hintFor(edited)).httpStatus, 409, kind + ': before its save the station answers pending for the edited floor');

      // ---- A: the same turn ----
      await acknowledged(world, base, kind + ' / A: back to the saved floor');
      world.reset(); world.posts.length = 0; world.warns.length = 0;
      world.pageDoc = edited;
      queueMicrotask(() => world.persist());                   // app.js watchStationSave: queued at the change, saved before the next event
      const offeredA = world.publish(edited);                  // ...and the page publishes in that very turn (World.syncPlan after a build)
      A.eq(offeredA.key, keyE, kind + ' / A: the page offers the edited floor under its dedupe key');
      A.ok(world.poster.state().lastHash !== keyE && world.poster.state().inflight, kind + ' / A: nothing is acknowledged while the save is awaited');
      await settled(world);
      const sa = world.poster.state(), pa = world.posts;
      A.eq(world.log, ['save', 'post:200'], kind + ' / A: the save landed first, then the post, with no retry');
      A.eq(world.warns.length, 0, kind + ' / A: nothing warned');
      A.eq([sa.lastHash, sa.stale, sa.unsavedHash], [keyE, false, null], kind + ' / A: acknowledged, not stale');
      A.eq(pa.length === 1 && pa[0].wire, hintFor(edited), kind + ' / A: the wire is the hint envelope: the edited plan and its compiler links');
      A.ok(pa.length === 1 && pa[0].saveLanded && pa[0].identity && pa[0].identity !== baseIdentity, kind + ' / A: the receipt is the saved floor\'s own, new identity');
      everything.push(...pa);

      // ---- B: the save fails ----
      await acknowledged(world, base, kind + ' / B: back to the saved floor');
      world.reset(); world.posts.length = 0; world.warns.length = 0;
      world.down = true;                                       // the station file is unreachable
      world.pageDoc = edited; world.persist();
      world.publish(edited);
      await settled(world);
      const sb = world.poster.state();
      A.eq(world.posts.length, 0, kind + ' / B: a floor whose save failed is never posted');
      A.eq([sb.lastHash, sb.stale, sb.unsavedHash], [baseKey, true, keyE], kind + ' / B: the old floor stays the acknowledged one, the page is stale and the edit is recorded as unsaved');
      A.ok(world.warns.length === 1 && /save/.test(world.warns[0]), kind + ' / B: the existing warn says why');
      A.eq(world.authority.compareHint(hintFor(edited)).httpStatus, 409, kind + ' / B: the station still answers pending for it');
      A.eq(world.pending().length, 1, kind + ' / B: a bounded retry is armed');
      world.down = false;                                      // the station is back; the retry asks the save again
      world.fire();
      await settled(world);
      const sb2 = world.poster.state();
      A.eq(world.log, ['save', 'post:200'], kind + ' / B: the retry saved the floor first, then posted it');
      A.eq([sb2.lastHash, sb2.stale, sb2.unsavedHash], [keyE, false, null], kind + ' / B: acknowledged once it was saved');
      everything.push(...world.posts);

      // ---- C: the post comes first ----
      await acknowledged(world, base, kind + ' / C: back to the saved floor');
      world.reset(); world.posts.length = 0; world.warns.length = 0;
      world.pageDoc = edited;                                  // the page drew the edit, but its persist has not been queued yet
      world.publish(edited);
      await settled(world);
      const sc = world.poster.state();
      A.eq(world.log, ['post:409'], kind + ' / C: the post went out first and the station answered pending');
      A.eq([sc.lastHash, sc.stale, sc.unsavedHash], [baseKey, true, keyE], kind + ' / C: a pending answer commits nothing: stale, recorded as unsaved');
      A.ok(world.warns.length === 1 && /not saved yet/.test(world.warns[0]), kind + ' / C: the existing warn says the floor is not saved yet');
      world.persist(); await world.cloud.flushForUpdate();     // the persist is queued and the page's flush sends it
      world.fire();
      await settled(world);
      const sc2 = world.poster.state();
      A.eq(world.log, ['post:409', 'save', 'post:200'], kind + ' / C: pending, then the save, then acknowledged');
      A.eq([sc2.lastHash, sc2.stale, sc2.unsavedHash], [keyE, false, null], kind + ' / C: acknowledged once it was saved');
      everything.push(...world.posts);
    }

    // ---- the invariant, over every post of every kind of edit in every order ----
    const ok = everything.filter(p => p.status === 200), pending = everything.filter(p => p.status === 409);
    A.eq(everything.filter(p => p.status === 200 && !p.saveLanded).length, 0, 'NO floor was acknowledged before the station file held it');
    A.eq(everything.filter(p => !p.saveLanded && p.status !== 409).length, 0, 'EVERY post made before the save landed was answered pending');
    A.eq(everything.filter(p => p.saveLanded && p.status !== 200).length, 0, 'every post made after the save landed was acknowledged');
    A.ok(ok.length >= EDITS.length * 3 && pending.length >= EDITS.length, 'the family is not vacuous (' + ok.length + ' acknowledged, ' + pending.length + ' pending)');
  } finally {
    world.close();
  }
  A.report('routing.page-publication');
})().catch(e => { console.log('FAIL: routing.page-publication.test threw - ' + (e && e.stack || e)); process.exit(1); });
