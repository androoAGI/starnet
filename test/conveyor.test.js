/* test/conveyor.test.js — headless tests for the belt MODEL (worldmodel belts) + the transport
   SIM (conveyor.js). Neither needs a DOM: the model is pure, and Conveyor.tick() takes injected
   time and a belt list (drawing is the only ctx-dependent part, exercised in-browser). */
'use strict';
const A = require('./_assert.js');
global.U = global.U || { shade: c => c, hash: s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; } };
const WM = require('../frontend/app/worldmodel.js');
const Conveyor = require('../frontend/app/conveyor.js');

/* ---------- belt model ---------- */
const s = WM.create();                                   // HAB-01 {0..17,0..10}
const r = s.roomById(s.spawnRoomId()).rects[0];
A.eq(s.belts().length, 0, 'fresh station has no belts');

const run = s.placeBeltRun({ tx: r.x1 + 2, ty: r.y1 + 2 }, { tx: r.x1 + 6, ty: r.y1 + 2 });
A.ok(run.ok && run.dir === 'E' && run.count === 5, 'an eastward run lays 5 E belts');
A.eq(s.beltAt(r.x1 + 4, r.y1 + 2), 'E', 'beltAt reads the laid direction');

// a perpendicular run sharing the end tile re-aims that corner tile
const run2 = s.placeBeltRun({ tx: r.x1 + 6, ty: r.y1 + 2 }, { tx: r.x1 + 6, ty: r.y1 + 5 });
A.ok(run2.ok && run2.dir === 'S', 'a downward run lays S belts');
A.eq(s.beltAt(r.x1 + 6, r.y1 + 2), 'S', 'the shared corner tile is re-aimed to the new direction');
A.eq(s.belts().length, 8, 'L-run shares the corner tile (5 + 4 - 1 = 8)');

A.ok(!s.placeBeltRun({ tx: 500, ty: 500 }, { tx: 503, ty: 500 }).ok, 'a run off the deck is rejected');
A.eq(s.placeBeltRun({ tx: 500, ty: 500 }, { tx: 503, ty: 500 }).error, 'OFF_DECK', '...with OFF_DECK');
A.ok(!s.setBelt(r.x1 + 2, r.y1 + 2, 'X').ok, 'a bad direction is rejected');

// belts are WALKABLE (floor machinery) — never block pathing
const g = s.projectGeometry();
A.eq(g.belts.length, 8, 'projectGeometry emits belts in the local frame');
A.ok(g.walkable(r.x1 + 4 - g.origin.tx, r.y1 + 2 - g.origin.ty), 'a belt tile stays walkable (agents cross it)');

// a belt can't sit on a blocking prop
const sp = WM.create(); const sr = sp.roomById(sp.spawnRoomId()).rects[0];
sp.addProp({ t: 'desk', x: sr.x1 + 2, y: sr.y1 + 2, w: 2, h: 1, block: true });
A.eq(sp.setBelt(sr.x1 + 2, sr.y1 + 2, 'E').error, 'ON_PROP', 'a belt is blocked by a solid prop');

// remove + undo/redo + serialize round-trip
A.ok(s.removeBelt(r.x1 + 2, r.y1 + 2).ok, 'removeBelt drops a tile');
A.eq(s.belts().length, 7, 'belt count drops after remove');
s.undo();
A.eq(s.belts().length, 8, 'undo restores the removed belt');
const doc = s.serialize();
A.eq(JSON.stringify(WM.deserialize(doc).serialize()), JSON.stringify(doc), 'belts serialize round-trip identically');

// batch removeBelts: a RECLAIM drag clears many tiles in ONE undo slot (mirrors placeBeltRun)
const before = s.belts().length;                          // 8 — the L-run is fully restored here
const rb = s.removeBelts([[r.x1 + 3, r.y1 + 2], [r.x1 + 4, r.y1 + 2], [r.x1 + 5, r.y1 + 2], [999, 999]]);
A.ok(rb.ok && rb.count === 3, 'removeBelts clears the 3 real belt tiles and skips the empty one');
A.eq(s.belts().length, before - 3, 'batch remove drops exactly the hit tiles');
s.undo();
A.eq(s.belts().length, before, 'ONE undo restores the whole batch (single snapshot)');
A.ok(!s.removeBelts([[999, 999], [998, 998]]).ok, 'removeBelts on all-empty tiles is a no-op fail (caller flags "no belts")');

// migrate() drops malformed belt entries without crashing
const mig = WM.deserialize({ schema: 'starnet.station', version: 1,
  rooms: { rA: { id: 'rA', kind: 'hab', name: 'A', rects: [{ x1: 0, y1: 0, x2: 5, y2: 5 }] } }, order: ['rA'],
  belts: { '1,1': 'E', 'bad': 'E', '2,2': 'Z', '3,3': 'N' } });
A.eq(mig.belts().length, 2, 'migrate keeps only well-formed "int,int"->E|W|N|S belt entries');

/* ---------- transport sim ---------- */
// L-shaped belt: E from (0,0)->(3,0) then S (3,0)->(3,2). Open end past (3,2).
const belts = [{ x: 0, y: 0, dir: 'E' }, { x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' },
               { x: 3, y: 0, dir: 'S' }, { x: 3, y: 1, dir: 'S' }, { x: 3, y: 2, dir: 'S' }];

// belts NEVER auto-spawn decorative cargo — an idle belt with no enqueued work stays EMPTY
const cvidle = Conveyor.create();
let now = 0;
for (let i = 0; i < 200; i++) { now += 16; cvidle.tick(16, now, belts); }
A.eq(cvidle.boxCount(), 0, 'an idle belt never auto-spawns boxes (quiet until real work rides)');

// an enqueued work-item rounds the corner — adopts each tile’s direction (E→S)
const cv = Conveyor.create();
now = 0; let sawCornerS = false;
cv.enqueueAt(0, 0, { workitemId: 'c1' });
for (let i = 0; i < 400 && !sawCornerS; i++) {
  now += 16; cv.tick(16, now, belts);
  if (cv.peekBoxes().some(b => b.x === 3 && b.y >= 1 && b.dir === 'S')) sawCornerS = true;
}
A.ok(sawCornerS, 'an enqueued box rounds the corner — adopts the next tile’s direction (E→S)');

// a box sinks (despawns) at the open end — the belt drains to empty, never accumulates
const cv2 = Conveyor.create();
const tiny = [{ x: 0, y: 0, dir: 'E' }];   // one tile: source AND open end
cv2.enqueueAt(0, 0, { workitemId: 't1' });
now = 0; let drained = false;
for (let i = 0; i < 200; i++) { now += 16; cv2.tick(16, now, tiny); if (i > 3 && cv2.boxCount() === 0) drained = true; }
A.ok(drained, 'an enqueued box sinks off an open end (the belt drains)');

// pulling the belt out from under a box sinks it (no orphan rides)
const cv3 = Conveyor.create();
cv3.enqueueAt(0, 0, { workitemId: 'o1' }); cv3.enqueueAt(1, 0, { workitemId: 'o2' });
now = 0; for (let i = 0; i < 20; i++) { now += 16; cv3.tick(16, now, belts); }
const had = cv3.boxCount();
for (let i = 0; i < 40; i++) { now += 16; cv3.tick(16, now, []); }   // belts gone
A.ok(had > 0 && cv3.boxCount() === 0, 'removing all belts sinks every riding box');

/* ---------- payload work-items (enqueueAt + onDeliver) ---------- */
// a real work-item box, enqueued at a source, rides to the open end and is delivered exactly once.
const line = [{ x: 0, y: 0, dir: 'E' }, { x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }];
const delivered = [];
const cvp = Conveyor.create({ onDeliver: (bx, x, y) => delivered.push({ id: bx.id, payload: bx.payload, x, y }) });
cvp.enqueueAt(0, 0, { workitemId: 'W1', preview: 'hello' });
cvp.tick(16, 16, line);                                   // first tick drains the pending work-item (no auto-spawn)
const pay = cvp.peekBoxes().filter(b => b.payload);
A.eq(pay.length, 1, 'enqueueAt creates exactly one payload box');
A.eq(cvp.boxCount(), 1, 'and no decorative box rides alongside it (belts are quiet)');
A.ok(pay[0].x === 0 && pay[0].y === 0 && pay[0].payload.workitemId === 'W1', 'the payload box starts at the source carrying its work-item');
now = 16;
for (let i = 0; i < 200 && !delivered.length; i++) { now += 16; cvp.tick(16, now, line); }
A.eq(delivered.length, 1, 'onDeliver fires exactly once for the payload box (ambient cargo never delivers)');
A.eq(delivered[0].payload.workitemId, 'W1', 'onDeliver receives the work-item payload');
A.ok(delivered[0].x === 2 && delivered[0].y === 0, 'delivery happens at the last belt tile (the sink end)');

// enqueueAt on a tile with no belt creates no box and never delivers (no belt path → no crate, work still ran)
let deliveredN = 0;
const cvn = Conveyor.create({ onDeliver: () => deliveredN++ });
cvn.enqueueAt(9, 9, { workitemId: 'W2' });
now = 0; for (let i = 0; i < 50; i++) { now += 16; cvn.tick(16, now, [{ x: 0, y: 0, dir: 'E' }]); }
A.eq(cvn.peekBoxes().filter(b => b.payload).length, 0, 'enqueueAt on a non-belt tile creates no payload box');
A.eq(deliveredN, 0, 'no delivery fires when there is no belt under the work-item');

/* ---------- Stage 2: backpressure spacing + supersede drop ---------- */
const bp = [{ x: 0, y: 0, dir: 'E' }, { x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }, { x: 3, y: 0, dir: 'E' }, { x: 4, y: 0, dir: 'E' }];
// a trailing work-item holds a backpressure gap behind the leader (crates stack, never overlap)
const cvbp = Conveyor.create();
cvbp.enqueueAt(0, 0, { workitemId: 'A' });
now = 0; for (let i = 0; i < 40; i++) { now += 16; cvbp.tick(16, now, bp); }   // A rides ahead
cvbp.enqueueAt(0, 0, { workitemId: 'B' });
for (let i = 0; i < 30; i++) { now += 16; cvbp.tick(16, now, bp); }
const A_ = cvbp.peekBoxes().find(b => b.payload && b.payload.workitemId === 'A');
const B_ = cvbp.peekBoxes().find(b => b.payload && b.payload.workitemId === 'B');
A.ok(A_ && B_, 'both work-items are riding the belt');
A.ok((A_.x + A_.prog) - (B_.x + B_.prog) >= 0.6, 'the trailing work-item keeps a backpressure gap (no stacking)');

// supersede drop: dropWorkitem early-sinks exactly that box, and it never delivers
const dropped = [];
const cvsd = Conveyor.create({ onDeliver: bx => dropped.push(bx.payload.workitemId) });
cvsd.enqueueAt(0, 0, { workitemId: 'S1' });
now = 0; for (let i = 0; i < 10; i++) { now += 16; cvsd.tick(16, now, bp); }   // S1 riding mid-belt
A.ok(cvsd.peekBoxes().some(b => b.payload && b.payload.workitemId === 'S1' && b.sink <= 0), 'S1 is riding before the drop');
A.ok(cvsd.dropWorkitem('S1'), 'dropWorkitem finds and sinks the riding box');
A.ok(cvsd.peekBoxes().find(b => b.payload && b.payload.workitemId === 'S1').sink > 0, 'S1 is now sinking (dropped off the belt)');
for (let i = 0; i < 40; i++) { now += 16; cvsd.tick(16, now, bp); }   // let it fade out
A.eq(dropped.filter(id => id === 'S1').length, 0, 'a dropped (superseded) box NEVER fires onDeliver');
A.ok(!cvsd.dropWorkitem('S1'), 'dropWorkitem on an already-gone work-item is a no-op');

// PENDING PURGE (the supersede-races-spawn seam, conveyor.js dropWorkitem's first loop): a work-item
// whose crate has NOT been born yet — still waiting in `pending` for a clear source tile — must be
// purged by dropWorkitem, or the aborted run gets a ghost crate that rides and DELIVERS later.
const ghost = [];
const cvpp = Conveyor.create({ onDeliver: bx => ghost.push(bx.payload.workitemId) });
// (1) queued, zero ticks — dropped before it was ever born
cvpp.enqueueAt(0, 0, { workitemId: 'P1' });
A.eq(cvpp.boxCount(), 0, 'P1 is queued, not yet born');
cvpp.dropWorkitem('P1');
now = 0; for (let i = 0; i < 40; i++) { now += 16; cvpp.tick(16, now, bp); }
A.ok(!cvpp.peekBoxes().some(b => b.payload && b.payload.workitemId === 'P1'), 'a purged pending item is never born');
// (2) the race: a burst holds P3 in the queue behind P2 (same source tile, MIN_GAP not yet open);
// drop P3 while it WAITS — P2 must still ride, P3 must never spawn.
cvpp.enqueueAt(0, 0, { workitemId: 'P2' });
cvpp.enqueueAt(0, 0, { workitemId: 'P3' });
now += 16; cvpp.tick(16, now, bp);                       // P2 born; P3 waiting on the occupied source tile
A.ok(cvpp.peekBoxes().some(b => b.payload && b.payload.workitemId === 'P2'), 'P2 was born from the burst');
A.ok(!cvpp.peekBoxes().some(b => b.payload && b.payload.workitemId === 'P3'), 'P3 still waits in pending');
cvpp.dropWorkitem('P3');                                  // supersede lands while P3 has no box yet
for (let i = 0; i < 250; i++) { now += 16; cvpp.tick(16, now, bp); }   // enough for the full 5-tile ride + sink
A.ok(!cvpp.peekBoxes().some(b => b.payload && b.payload.workitemId === 'P3'), 'the purged waiter never spawns after the tile clears');
A.eq(ghost.filter(id => id === 'P1' || id === 'P3').length, 0, 'neither purged pending item ever fires onDeliver');
A.ok(ghost.indexOf('P2') >= 0, 'the untouched burst-mate still rides to delivery');

/* ---------- Stage 4: splitter junction (round-robin fan-out = real parallelism) ---------- */
// source (0,0)→E into a SPLITTER at (1,0); two out-lanes — E to (2,0)+ and S to (1,1)+.
const sbelts = [{ x: 0, y: 0, dir: 'E' }, { x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }, { x: 3, y: 0, dir: 'E' },
                { x: 1, y: 1, dir: 'S' }, { x: 1, y: 2, dir: 'S' }, { x: 1, y: 3, dir: 'S' }];
const sjunc = new Map([['1,0', { kind: 'split' }]]);
const cvsp = Conveyor.create();
const seq = [];
now = 0;
for (let n = 0; n < 4; n++) {                              // one box at a time so each routing decision is unambiguous
  cvsp.enqueueAt(0, 0, { workitemId: 'sp' + n });
  let lane = '?';
  for (let i = 0; i < 200 && lane === '?'; i++) {
    now += 16; cvsp.tick(16, now, sbelts, sjunc);
    const b = cvsp.peekBoxes().find(x => x.payload && x.payload.workitemId === 'sp' + n);
    if (b && b.sink <= 0 && (b.x >= 2 || b.y >= 1)) lane = (b.y === 0) ? 'E' : 'S';
  }
  seq.push(lane);
  for (let i = 0; i < 200 && cvsp.boxCount() > 0; i++) { now += 16; cvsp.tick(16, now, sbelts, sjunc); }  // drain before next
}
A.eq(seq.join(''), 'ESES', 'a splitter round-robins boxes across its out-lanes (deterministic: ' + seq.join('') + ')');

// junctions are OPT-IN: the same belt with no junction map routes a box straight through
const cvst = Conveyor.create();
cvst.enqueueAt(0, 0, { workitemId: 'straight' });
now = 0; let wentStraight = false;
for (let i = 0; i < 200 && !wentStraight; i++) {
  now += 16; cvst.tick(16, now, sbelts);                   // no junctions arg
  const b = cvst.peekBoxes().find(x => x.payload);
  if (b && b.x >= 2 && b.y === 0) wentStraight = true;
}
A.ok(wentStraight, 'with no junction map a box follows the belt straight through (routing is opt-in)');

/* ---------- Stage 5: FILTER junction (content-routing by payload.tag) ---------- */
// source (0,0)→E into a FILTER at (1,0); out-lanes E→(2,0)+ and S→(1,1)+.
const fbelts = [{ x: 0, y: 0, dir: 'E' }, { x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }, { x: 3, y: 0, dir: 'E' },
                { x: 1, y: 1, dir: 'S' }, { x: 1, y: 2, dir: 'S' }, { x: 1, y: 3, dir: 'S' }];
function filterLane(payload, junc) {
  const cv = Conveyor.create();
  cv.enqueueAt(0, 0, payload);
  let lane = '?', t = 0;
  for (let i = 0; i < 300 && lane === '?'; i++) {
    t += 16; cv.tick(16, t, fbelts, junc);
    const b = cv.peekBoxes().find(x => x.payload && x.payload.workitemId === payload.workitemId);
    if (b && b.sink <= 0 && (b.x >= 2 || b.y >= 1)) lane = (b.y === 0) ? 'E' : 'S';
  }
  return lane;
}
const fj = new Map([['1,0', { kind: 'filter', routes: { code: 'S', research: 'E' }, def: 'E' }]]);
A.eq(filterLane({ workitemId: 'f1', tag: 'code' }, fj), 'S', 'a FILTER routes a code-tagged box down its configured S lane');
A.eq(filterLane({ workitemId: 'f2', tag: 'research' }, fj), 'E', 'a FILTER routes a research-tagged box down the E lane');
A.eq(filterLane({ workitemId: 'f3', tag: 'general' }, fj), 'E', 'a FILTER sends an unmatched tag down its default lane');
A.eq(filterLane({ workitemId: 'f4' }, fj), 'E', 'a FILTER treats a tagless box as general -> the default lane');
// never-drop: a route pointing at a NON-EXISTENT lane falls back to the default (work is never lost at a filter)
const fjBad = new Map([['1,0', { kind: 'filter', routes: { code: 'N' }, def: 'E' }]]);
A.eq(filterLane({ workitemId: 'f5', tag: 'code' }, fjBad), 'E', 'a FILTER route to a missing lane falls back to default (never dropped)');
// the LAST rung of the never-drop ladder: no matching route AND no default -> the FIRST lane (LANE_ORDER),
// the exact fallback that makes FILTER_NO_DEFAULT a warn rather than a blocker (a def-less filter never drops work)
const fjNoDef = new Map([['1,0', { kind: 'filter', routes: { code: 'N' } }]]);
A.eq(filterLane({ workitemId: 'f7', tag: 'code' }, fjNoDef), 'E', 'no routable lane and NO default -> the first out-lane carries the box (never dropped)');
// replay-stable: identical input -> identical lane
A.eq(filterLane({ workitemId: 'f6', tag: 'code' }, fj), filterLane({ workitemId: 'f6', tag: 'code' }, fj), 'FILTER routing is replay-stable');

// the onAdvance seam (what world.js wires to emit('workitem.advanced')) fires the routing decision
const adv = [];
const cva = Conveyor.create({ onAdvance: (bx, info) => adv.push(info) });
cva.enqueueAt(0, 0, { workitemId: 'a1', tag: 'code' });
let at = 0; for (let i = 0; i < 200 && !adv.length; i++) { at += 16; cva.tick(16, at, fbelts, fj); }
A.ok(adv.some(i => i.kind === 'filter' && i.lane === 'S' && i.tag === 'code'), 'onAdvance reports a filter routing decision (telemetry seam)');

/* ---------- Stage 5b: MERGER junction = a LANE FUNNEL, never a combiner (2026-07-26 audit) ----------
   It used to buffer K crates, ABSORB the first K-1 and send the K-th on with a combined `merged` id list.
   No consumer ever read that list, and the harness has no batching concept — resolveTarget dispatches every
   work-item on its own, so K messages were always K paid runs. The floor was animating a barrier the server
   never performed, and work below the threshold was swallowed outright. It must now conserve crates. */
const mbelts = [{ x: 0, y: 0, dir: 'E' }, { x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }, { x: 3, y: 0, dir: 'E' }];
const mj = new Map([['2,0', { kind: 'merge', bufferSize: 2 }]]);   // a legacy K rides along; it must be ignored
function mergeRun(junc) {
  const del = [];
  const cv = Conveyor.create({ onDeliver: bx => del.push(bx.payload) });
  cv.enqueueAt(0, 0, { workitemId: 'm1' });
  let t = 0; for (let i = 0; i < 30; i++) { t += 16; cv.tick(16, t, mbelts, junc); }  // m1 leads
  cv.enqueueAt(0, 0, { workitemId: 'm2' });
  for (let i = 0; i < 400; i++) { t += 16; cv.tick(16, t, mbelts, junc); }
  return { del, remaining: cv.boxCount() };
}
const mr = mergeRun(mj);
A.eq(mr.del.length, 2, 'a MERGER delivers BOTH inbound work-items — it never eats one');
A.eq(mr.del.map(p => p.workitemId).sort().join(','), 'm1,m2', '...each arriving as itself');
A.ok(!mr.del.some(p => p.merged || p.mergeCount), 'no crate claims a combine the harness never performed');
A.eq(mr.remaining, 0, 'the belt drains fully');
// a legacy bufferSize must change NOTHING (old saves carry K; it configures nothing now)
const mrNoK = mergeRun(new Map([['2,0', { kind: 'merge' }]]));
A.eq(JSON.stringify(mr.del.map(p => p.workitemId).sort()), JSON.stringify(mrNoK.del.map(p => p.workitemId).sort()),
  'a merger with a legacy K behaves identically to one without');
// a merger is behaviourally a plain belt tile: same deliveries as no junction at all
const mrPlain = mergeRun(null);
A.eq(JSON.stringify(mr.del.map(p => p.workitemId).sort()), JSON.stringify(mrPlain.del.map(p => p.workitemId).sort()),
  'a merger conserves crates exactly like an unjunctioned tile (it funnels LANES, not jobs)');

// the real shape: two lanes converging on one merge tile — every crate from both lanes gets through
{
  const yb = [{ x: 0, y: 0, dir: 'E' }, { x: 1, y: 0, dir: 'E' },       // lane A east into (2,0)
              { x: 2, y: 2, dir: 'N' }, { x: 2, y: 1, dir: 'N' },       // lane B north into (2,0)
              { x: 2, y: 0, dir: 'E' }, { x: 3, y: 0, dir: 'E' }, { x: 4, y: 0, dir: 'E' }];
  const yj = new Map([['2,0', { kind: 'merge' }]]);
  const del = [];
  const cv = Conveyor.create({ onDeliver: bx => del.push(bx.payload.workitemId) });
  for (let i = 0; i < 3; i++) { cv.enqueueAt(0, 0, { workitemId: 'A' + i }); cv.enqueueAt(2, 2, { workitemId: 'B' + i }); }
  let t = 0, worst = Infinity;
  for (let i = 0; i < 3000 && del.length < 6; i++) {
    t += 16; cv.tick(16, t, yb, yj);
    const bs = cv.peekBoxes().filter(b => b.sink <= 0);
    for (let a = 0; a < bs.length; a++) for (let b = a + 1; b < bs.length; b++)
      if (bs[a].x === bs[b].x && bs[a].y === bs[b].y) worst = Math.min(worst, Math.abs(bs[a].prog - bs[b].prog));
  }
  A.eq(del.slice().sort().join(','), 'A0,A1,A2,B0,B1,B2', 'six crates converge through a merger and all six arrive');
  A.ok(worst === Infinity || worst >= 0.8, 'converging crates never overlap on the merge tile (worst ' + (worst === Infinity ? 'n/a' : worst.toFixed(3)) + ')');
}

/* ---------- DOCK STOPS (crate-physics truth): inbound crates are consumed at their dock ---------- */
{
  // one straight lane E from (0,0) to (5,0); dock (bound-bay hookup) at (2,0); open end past (5,0)
  const lane = [0, 1, 2, 3, 4, 5].map(x => ({ x, y: 0, dir: 'E' }));
  const stops = { '2,0': 'coder' };
  const runLane = payload => {
    const del = [];
    const cv = Conveyor.create({ onDeliver: (bx, x, y) => del.push({ x, y, p: bx.payload }) });
    cv.enqueueAt(0, 0, payload);
    let t = 0; for (let i = 0; i < 400; i++) { t += 16; cv.tick(16, t, lane, null, stops); }
    return del;
  };
  const un = runLane({ workitemId: 'u1' });
  A.eq(un.length, 1, 'an UNOWNED inbound crate delivers exactly once');
  A.ok(un[0].x === 2 && un[0].y === 0, '...AT the first dock — it never rides past it');
  const own = runLane({ workitemId: 'o1', agentId: 'coder' });
  A.ok(own.length === 1 && own[0].x === 2, 'a crate addressed to the dock owner stops at ITS dock');
  const other = runLane({ workitemId: 'o2', agentId: 'scout' });
  A.ok(other.length === 1 && other[0].x === 5, 'a crate addressed to SOMEONE ELSE rides past the dock to the open end');
  const outb = runLane({ workitemId: 'o3', outbound: true, agentId: 'coder' });
  A.ok(outb.length === 1 && outb[0].x === 5, 'an OUTBOUND crate ignores docks entirely (it is shipping out)');
  // born ON a dock tile: an outbound crate starting at its own dock is never instantly consumed
  const cv2del = [];
  const cv2 = Conveyor.create({ onDeliver: (bx, x, y) => cv2del.push({ x, y }) });
  cv2.enqueueAt(2, 0, { workitemId: 'b1' });   // inbound born on the dock — birth tile never consumes
  let t2 = 0; for (let i = 0; i < 400; i++) { t2 += 16; cv2.tick(16, t2, lane, null, stops); }
  A.ok(cv2del.length === 1 && cv2del[0].x === 5, 'a crate born ON a dock tile is not consumed at birth');

  // A DOCK NEVER EATS ITS OWN OUTPUT (handoff physics): a chain crate produced by A, riding A's OTHER ring
  // tiles on the way to B, rides past every one of them and is consumed only at B's dock. The birth-tile
  // check alone can't cover this — a multi-tile hookup puts A's dock under tiles the crate never spawned on.
  const hoLane = [0, 1, 2, 3, 4, 5].map(x => ({ x, y: 0, dir: 'E' }));
  const hoStops = { '1,0': 'alpha', '2,0': 'alpha', '4,0': 'beta' };   // alpha owns TWO ring tiles; beta downstream
  const hoDel = [];
  const cvho = Conveyor.create({ onDeliver: (bx, x, y) => hoDel.push({ x, y }) });
  cvho.enqueueAt(0, 0, { workitemId: 'h1', agentId: 'beta', fromAgentId: 'alpha', box: 'product' });
  let t3 = 0; for (let i = 0; i < 400; i++) { t3 += 16; cvho.tick(16, t3, hoLane, null, hoStops); }
  A.eq(hoDel.length, 1, 'a handoff crate delivers exactly once');
  A.ok(hoDel[0].x === 4, "…at the RECEIVER's dock — it rode past both of its producer's ring tiles (x=" + hoDel[0].x + ')');
  // and an UNOWNED crate from the same producer still refuses the producer's dock but stops at the first foreign one
  const hoDel2 = [];
  const cvho2 = Conveyor.create({ onDeliver: (bx, x, y) => hoDel2.push({ x, y }) });
  cvho2.enqueueAt(0, 0, { workitemId: 'h2', fromAgentId: 'alpha' });
  let t4 = 0; for (let i = 0; i < 400; i++) { t4 += 16; cvho2.tick(16, t4, hoLane, null, hoStops); }
  A.ok(hoDel2.length === 1 && hoDel2[0].x === 4, "an unowned crate skips its OWN producer's dock and stops at the first foreign dock");
}

/* ---------- ADDRESSED CRATES RIDE HOME through junctions (owners beat tag routing) ---------- */
{
  // T: feed E (0,0)->(2,0 junction); E lane on to (4,0); S lane (2,1)->(2,3)
  const tb = [{ x: 0, y: 0, dir: 'E' }, { x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }, { x: 3, y: 0, dir: 'E' }, { x: 4, y: 0, dir: 'E' },
              { x: 2, y: 1, dir: 'S' }, { x: 2, y: 2, dir: 'S' }, { x: 2, y: 3, dir: 'S' }];
  const jt = new Map([['2,0', { kind: 'filter', routes: { code: 'S' }, def: 'E', owners: { E: ['nova'], S: ['coder'] } }]]);
  const ride = payload => {
    const cv = Conveyor.create();
    cv.enqueueAt(0, 0, payload);
    let t = 0, lane = '?';
    for (let i = 0; i < 300 && lane === '?'; i++) {
      t += 16; cv.tick(16, t, tb, jt);
      const b = cv.peekBoxes().find(x => x.payload && x.payload.workitemId === payload.workitemId);
      if (b && b.sink <= 0 && (b.x > 2 || b.y >= 1)) lane = (b.y === 0) ? 'E' : 'S';
    }
    return lane;
  };
  A.eq(ride({ workitemId: 'a1', tag: 'code' }), 'S', 'an UNOWNED code crate follows the filter route (S)');
  A.eq(ride({ workitemId: 'a2', tag: 'code', agentId: 'nova' }), 'E', "an ADDRESSED code crate ignores the tag and rides HOME (nova's E lane)");
  A.eq(ride({ workitemId: 'a3', tag: 'research', agentId: 'coder' }), 'S', 'addressed routing works both ways (coder rides S despite def E)');
}

/* ---------- SOURCE BACKPRESSURE: a burst never spawns a stacked pile (2026-07-26 audit) ---------- */
{
  const lane = Array.from({ length: 40 }, (_, x) => ({ x, y: 0, dir: 'E' }));
  const del = new Set();
  const cv = Conveyor.create({ onDeliver: bx => del.add(bx.payload.workitemId) });
  for (let i = 0; i < 12; i++) cv.enqueueAt(0, 0, { workitemId: 'burst' + i });   // ONE tick, twelve work-items
  let t = 0; cv.tick(16, (t += 16), lane);
  A.eq(cv.peekBoxes().length, 1, 'a burst of 12 births exactly ONE crate on the source tile (the rest queue)');

  // ride the whole burst out and watch for any two crates sharing a tile inside MIN_GAP
  let worst = Infinity;
  for (let i = 0; i < 4000 && (del.size < 12); i++) {
    t += 16; cv.tick(16, t, lane);
    const bs = cv.peekBoxes().filter(b => b.sink <= 0);
    for (let a = 0; a < bs.length; a++) for (let b = a + 1; b < bs.length; b++)
      if (bs[a].x === bs[b].x && bs[a].y === bs[b].y) worst = Math.min(worst, Math.abs(bs[a].prog - bs[b].prog));
  }
  A.ok(worst === Infinity || worst >= 0.8, 'no two crates ever ride the same tile inside MIN_GAP (worst ' + (worst === Infinity ? 'n/a' : worst.toFixed(3)) + ')');
  A.eq(del.size, 12, 'every queued work-item is still delivered — the queue delays crates, it never drops them');
}

// a busy source must not stall a DIFFERENT source's lane (per-tile FIFO, not one global queue)
{
  const two = [{ x: 0, y: 0, dir: 'E' }, { x: 1, y: 0, dir: 'E' }, { x: 0, y: 4, dir: 'E' }, { x: 1, y: 4, dir: 'E' }];
  const cv = Conveyor.create();
  for (let i = 0; i < 5; i++) cv.enqueueAt(0, 0, { workitemId: 'a' + i });   // burst on lane A
  cv.enqueueAt(0, 4, { workitemId: 'b0' });                                  // one item on lane B, enqueued LAST
  cv.tick(16, 16, two);
  A.ok(cv.peekBoxes().some(b => b.payload.workitemId === 'b0'), "lane B's crate is born immediately despite lane A's backlog");
}

// the pending queue is bounded (a runaway feed can't grow without limit)
{
  const lane = [{ x: 0, y: 0, dir: 'E' }, { x: 1, y: 0, dir: 'E' }];
  const cv = Conveyor.create();
  for (let i = 0; i < 900; i++) cv.enqueueAt(0, 0, { workitemId: 'flood' + i });
  let t = 0; for (let i = 0; i < 60; i++) { t += 16; cv.tick(16, t, lane); }
  A.ok(cv.boxCount() <= 3, 'a 900-item flood still puts at most a couple of crates on a 2-tile lane');
}

// two crates at IDENTICAL progress on one tile separate instead of riding as a pile
{
  const lane = [{ x: 0, y: 0, dir: 'E' }, { x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }, { x: 3, y: 0, dir: 'E' }];
  const cv = Conveyor.create();
  cv.enqueueAt(0, 0, { workitemId: 'tie1' });
  let t = 0; cv.tick(16, (t += 16), lane);
  cv.enqueueAt(0, 0, { workitemId: 'tie2' });
  for (let i = 0; i < 120; i++) { t += 16; cv.tick(16, t, lane); }
  const bs = cv.peekBoxes().filter(b => b.sink <= 0);
  let overlapped = false;
  for (let a = 0; a < bs.length; a++) for (let b = a + 1; b < bs.length; b++)
    if (bs[a].x === bs[b].x && bs[a].y === bs[b].y && Math.abs(bs[a].prog - bs[b].prog) < 0.8) overlapped = true;
  A.ok(!overlapped, 'crates never settle on top of each other (leaderDist breaks progress ties by id)');
}

/* ---------- crate-mass honesty: weightForUsd maps RECONCILED spend -> product-crate mass ---------- */
A.eq(Conveyor.weightForUsd(undefined), 0, 'no reconciled cost -> weight 0 (the back-compat light look)');
A.eq(Conveyor.weightForUsd(0), 0, 'a zero-cost run ships a weightless crate');
A.eq(Conveyor.weightForUsd(-1), 0, 'a negative usd can never weigh a crate');
A.eq(Conveyor.weightForUsd(NaN), 0, 'NaN is not a cost');
A.eq(Conveyor.weightForUsd(0.25), 0.25, '25 cents reads as a quarter-mass crate (linear to $1)');
A.eq(Conveyor.weightForUsd(1.0), 1, 'a $1 run reads full-mass');
A.eq(Conveyor.weightForUsd(7.5), 1, 'mass clamps at 1 — a pricier run cannot overflow the art');
A.eq(Conveyor.weightForUsd(0.004), 0.004, 'a sub-cent run reads as a near-weightless crate, never estimated up');

/* ---------- FRAME SHIFT (origin-move truth, 2026-08-11 audit #4): a floor edit that grows the
   station bounds re-frames every belt tile; riding boxes and queued pending items must ride the
   SAME shift or tick() reads "belt pulled out" and sinks paid work mid-ride. */
{
  const laneAt = dy => [0, 1, 2, 3, 4, 5].map(x => ({ x, y: dy, dir: 'E' }));
  const del = [];
  const cv = Conveyor.create({ onDeliver: (bx, x, y) => del.push({ id: bx.payload.workitemId, x, y }) });
  cv.enqueueAt(0, 0, { workitemId: 'ride' });   // will be riding when the frame moves
  let t = 0; for (let i = 0; i < 30; i++) { t += 16; cv.tick(16, t, laneAt(0)); }
  cv.enqueueAt(0, 0, { workitemId: 'wait' });   // still queued when the frame moves
  A.ok(cv.peekBoxes().some(b => b.payload.workitemId === 'ride' && b.sink <= 0), 'a crate is riding pre-shift');
  cv.shiftFrame(2, 3);                          // a room grew the bounds: every belt moved +2,+3 in the local frame
  const shifted = laneAt(3).map(b => ({ x: b.x + 2, y: b.y, dir: b.dir }));
  for (let i = 0; i < 400; i++) { t += 16; cv.tick(16, t, shifted, null, { '5,3': 'dockowner' }); }
  A.eq(del.length, 2, 'BOTH the riding crate and the queued waiter survive the origin shift and deliver');
  A.ok(del.every(d => d.y === 3), '...in the NEW frame (no orphan ride on old-frame tiles)');
  // the dock consumed them mid-lane — spawnTile shifted too, so the own-birth-tile exemption stayed true
  A.ok(del.every(d => d.x === 5), 'delivery lands at the shifted mid-lane dock, not the open end');
  A.eq(cv.boxCount(), 0, 'nothing was sunk as an orphan');
  // a no-op shift is free
  cv.shiftFrame(0, 0);
  A.ok(true, 'shiftFrame(0,0) is a no-op');
}

/* ---- LOOP GATE lanes come from the COMPILED cfg (2026-08-30 sweep) ----
   The sim used to re-derive `back` as "first non-done lane"; on a THREE-lane gate LANE_ORDER put the
   escalation wire first, so the crate you watched rode the escape while the dispatcher looped it
   upstream — visual ≠ dispatch. jt is plan.junctions[tile] on both surfaces; the sim must obey it. */
{
  const B = (x, y, d) => ({ x, y, dir: d });
  const gateBelts = [B(0, 2, 'E'), B(1, 2, 'E'), B(2, 2, 'E'),
    B(2, 1, 'N'), B(2, 0, 'N'),          // back lane (compiled: N)
    B(2, 3, 'S'), B(2, 4, 'S'),          // escalation lane (compiled: S)
    B(3, 2, 'E'), B(4, 2, 'E')];         // done lane (E); the gate sits on 2,2
  const cfg = { kind: 'loop', max: 3, done: 'E', back: 'N', esc: 'S' };
  const ride = (iteration) => {
    const c = Conveyor.create({});
    c.enqueueAt(0, 2, { workitemId: 'g' + iteration, iteration });
    let t = 0; const j = new Map([['2,2', cfg]]);
    for (let i = 0; i < 40; i++) c.tick(64, (t += 64), gateBelts, j, null);
    const b = c.peekBoxes()[0];
    return b ? b.x + ',' + b.y : 'gone';
  };
  A.eq(ride(0), '2,0', 'an under-cap crate rides the COMPILED back lane (N), never the escalation wire');
  A.eq(ride(3), '2,4', 'an exhausted crate rides the ESCALATION lane (S), not the done lane');
  // a cfg-less legacy caller keeps the old first-non-done fallback (two-lane gate: unambiguous)
  const c2 = Conveyor.create({});
  const twoLane = [B(0, 2, 'E'), B(1, 2, 'E'), B(2, 2, 'E'), B(2, 1, 'N'), B(2, 0, 'N'), B(3, 2, 'E'), B(4, 2, 'E')];
  c2.enqueueAt(0, 2, { workitemId: 'legacy', iteration: 0 });
  let t2 = 0; const j2 = new Map([['2,2', { kind: 'loop', max: 3, done: 'E' }]]);
  for (let i = 0; i < 40; i++) c2.tick(64, (t2 += 64), twoLane, j2, null);
  A.eq(c2.peekBoxes()[0].x + ',' + c2.peekBoxes()[0].y, '2,0', 'a bare {kind:loop} cfg still loops a two-lane gate');
}

A.report('conveyor');
