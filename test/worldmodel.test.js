/* test/worldmodel.test.js — headless tests for the pure Station model (frontend/app/worldmodel.js).
   The model has no DOM / no ambient time/RNG, so it loads with a plain require(). */
'use strict';
const A = require('./_assert.js');
const WM = require('../frontend/app/worldmodel.js');

/* ---- default station: one spawn HAB room ---- */
const s = WM.create();
A.eq(s.rooms().length, 1, 'default station seeds exactly one room');
A.ok(s.spawnRoomId(), 'spawn room id is set');
const hab = s.rooms()[0];
A.eq(hab.kind, 'hab', 'seed room is a hab');
A.eq(s.spawnRoomId(), hab.id, 'seed room is the spawn room');

/* ---- addRoom: valid, overlap, too-small ---- */
const ok1 = s.addRoom({ kind: 'lab', rect: { x1: 20, y1: 0, x2: 26, y2: 8 } });
A.ok(ok1.ok, 'non-overlapping addRoom succeeds');
A.eq(s.rooms().length, 2, 'two rooms after add');
const labId = ok1.id;

const over = s.addRoom({ kind: 'lab', rect: { x1: 0, y1: 0, x2: 5, y2: 5 } });
A.ok(!over.ok && over.error === 'OVERLAP', 'overlapping addRoom rejected with OVERLAP');

const tiny = s.addRoom({ kind: 'lab', rect: { x1: 40, y1: 40, x2: 41, y2: 41 } });
A.ok(!tiny.ok && tiny.error === 'TOO_SMALL', 'too-small room rejected with TOO_SMALL');
A.eq(s.rooms().length, 2, 'rejected adds do not mutate the doc');

/* normRect tolerance: reversed corners still place ---- */
const rev = s.addRoom({ kind: 'storage', rect: { x1: 26, y1: 24, x2: 20, y2: 18 } });
A.ok(rev.ok, 'reversed-corner rect is normalised and placed');
s.removeRoom(rev.id); // keep the rest of the test tidy

/* ---- hallway bridges the 2-tile gap between hab (x≤17) and lab (x≥20) ---- */
const hw = s.placeHallway({ rect: { x1: 18, y1: 3, x2: 19, y2: 4 } });
A.ok(hw.ok, 'hallway placed in the gap');
A.eq(s.rooms().length, 3, 'three zones: hab + lab + corridor');

/* ---- projectGeometry: the MAP-shaped contract the bake consumes ---- */
const g = s.projectGeometry();
A.eq(g.TILE, 12, 'geometry TILE = 12');
A.ok(g.COLS > 0 && g.ROWS > 0, 'geometry has a positive size');
A.eq(g.W, g.COLS * 12, 'W = COLS*TILE');
A.ok(g.H > g.ROWS * 12, 'H carries hull headroom below the grid');
A.eq(g.ROOM_IDS.length, 2, 'ROOM_IDS excludes the corridor (hab + lab)');
A.eq(g.allRects.length, 3, 'allRects covers every footprint rect');
A.ok(g.isCorridor(hw.id) === true, 'isCorridor true for the corridor zone');
A.ok(g.isCorridor(hab.id) === false, 'isCorridor false for a room zone');

const lx = hab.rects[0].x1 - g.origin.tx, ly = hab.rects[0].y1 - g.origin.ty;
A.eq(g.zoneGrid[g.idx(lx, ly)], hab.id, 'hab corner tile stamped into zoneGrid (local frame)');
A.ok(g.doorDefs.length > 0, 'auto-doors derived between abutting zones');
const d = g.doorDefs[0];
A.ok(g.canStep(d[0], d[1], d[2], d[3]), 'canStep crosses a derived door');
A.ok(!g.canStep(0, 0, -1, 0), 'canStep false off the grid');
A.ok(typeof g.baseColorOf(hab.id, lx, ly) === 'string', 'baseColorOf returns a colour');
A.ok(g.chamfers.length > 0, 'rooms get chamfered (void-exposed) corners');

/* ---- roomAt in world coords ---- */
A.eq(s.roomAt(hab.rects[0].x1, hab.rects[0].y1), hab.id, 'roomAt finds the hab');
A.eq(s.roomAt(10000, 10000), null, 'roomAt over void returns null');

/* ---- moveRoom: empty target ok; overlap rejected ---- */
const mv = s.moveRoom(labId, 0, 30);
A.ok(mv.ok, 'moveRoom into empty space succeeds');
const mvBack = s.moveRoom(labId, -100, 0); // far away, still empty
A.ok(mvBack.ok, 'moveRoom far into empty space succeeds');
const mvOver = s.moveRoom(labId, 100, -30); // back onto hab/corridor region
// not asserting overlap here (depends on exact geometry); just ensure it returns a result shape
A.ok(typeof mvOver.ok === 'boolean', 'moveRoom returns a result shape');

/* ---- paint / floor styles ---- */
const pf = s.setFloor(hab.id, 'cobalt');
A.ok(pf.ok, 'setFloor to a known style succeeds');
A.eq(s.roomById(hab.id).floorStyle, 'cobalt', 'room floorStyle updated');
const pfBad = s.setFloor(hab.id, 'nope');
A.ok(!pfBad.ok && pfBad.error === 'BAD_STYLE', 'unknown floor style rejected');

/* ---- removeRoom: spawn protected, others removable ---- */
const rmSpawn = s.removeRoom(s.spawnRoomId());
A.ok(!rmSpawn.ok && rmSpawn.error === 'SPAWN_ROOM', 'spawn room is protected from reclaim');
const cntBefore = s.rooms().length;
const rmHall = s.removeRoom(hw.id);
A.ok(rmHall.ok, 'a non-spawn zone is removable');
A.eq(s.rooms().length, cntBefore - 1, 'removal drops the count by one');

/* ---- undo / redo round-trip ---- */
A.ok(s.canUndo(), 'history has undoable steps');
s.undo();
A.eq(s.rooms().length, cntBefore, 'undo restores the removed corridor');
s.redo();
A.eq(s.rooms().length, cntBefore - 1, 'redo re-applies the removal');

/* ---- onChange fires with a monotonic seq ---- */
let last = null;
const off = s.onChange(p => { last = p; });
const seq0 = s.getSeq();
s.addRoom({ kind: 'quarters', rect: { x1: 0, y1: 30, x2: 8, y2: 38 } });
A.ok(last && last.seq === seq0 + 1, 'onChange fired with an incremented seq');
off();

/* ---- serialize round-trips byte-identically ---- */
const doc = s.serialize();
const s2 = WM.deserialize(doc);
A.eq(s2.rooms().length, s.rooms().length, 'deserialize preserves the room count');
A.eq(JSON.stringify(s2.serialize()), JSON.stringify(doc), 'serialize → deserialize → serialize is identical');

/* ---- multi-rect / L-shaped footprints + self-overlap rejection ---- */
const s3 = WM.create();
const lshape = s3.addRoom({ kind: 'storage', rects: [{ x1: 40, y1: 40, x2: 46, y2: 46 }, { x1: 44, y1: 47, x2: 50, y2: 52 }] });
A.ok(lshape.ok, 'L-shaped multi-rect room places');
const selfOver = s3.addRoom({ kind: 'storage', rects: [{ x1: 60, y1: 60, x2: 66, y2: 66 }, { x1: 63, y1: 63, x2: 69, y2: 69 }] });
A.ok(!selfOver.ok && selfOver.error === 'OVERLAP', 'self-overlapping multi-rect footprint rejected');

/* ---- a rejected mutation must not touch history ---- */
const s4 = WM.create();
s4.addRoom({ kind: 'lab', rect: { x1: 30, y1: 0, x2: 36, y2: 6 } });
const canU = s4.canUndo();
A.ok(!s4.addRoom({ kind: 'lab', rect: { x1: 0, y1: 0, x2: 4, y2: 4 } }).ok, 'overlapping add rejected');
A.eq(s4.canUndo(), canU, 'a rejected mutation leaves the undo stack untouched');

/* ---- no-op mutations must not consume an undo slot or wipe redo ---- */
const s5 = WM.create();
const hid = s5.rooms()[0].id;
s5.setFloor(hid, 'cobalt');
s5.undo();
A.ok(s5.canRedo(), 'redo available after undo');
A.ok(s5.setFloor(hid, s5.roomById(hid).floorStyle).ok, 'no-op setFloor returns ok');
A.ok(s5.canRedo(), 'a no-op mutation does not wipe the redo stack');
s5.setFloor(hid, 'rust');
A.ok(!s5.canRedo(), 'a real mutation after undo clears redo');

/* ---- floorPaint survives moveRoom + a serialize round-trip ---- */
const s6 = WM.create();
const pid = s6.rooms()[0].id;
s6.paintTiles(pid, [[2, 2], [3, 3]], 'crimson');
s6.moveRoom(pid, 5, 5);                       // painted tile (2,2) -> world (7,7)
let g6 = s6.projectGeometry();
const lx6 = 7 - g6.origin.tx, ly6 = 7 - g6.origin.ty;
A.eq(g6.baseColorOf(pid, lx6, ly6), s6.FLOOR_STYLES.crimson.base, 'painted tile follows a moveRoom');
g6 = WM.deserialize(s6.serialize()).projectGeometry();
A.eq(g6.baseColorOf(pid, lx6, ly6), s6.FLOOR_STYLES.crimson.base, 'floorPaint survives serialize round-trip');

/* ---- name-counter determinism + canStep same-zone ---- */
const s7 = WM.create();
const a7 = s7.addRoom({ kind: 'lab', rect: { x1: 20, y1: 0, x2: 28, y2: 6 } });
A.eq(s7.roomById(a7.id).name, 'LAB-02', 'auto-name uses the deterministic doc id counter');
const g7 = s7.projectGeometry(), hz = g7.zones[s7.spawnRoomId()];
A.ok(g7.canStep(hz.x1, hz.y1, hz.x1 + 1, hz.y1), 'canStep true within the same zone');

/* ---- migrate() is total over a partial / legacy doc ---- */
const partial = WM.deserialize({ schema: 'starnet.station', version: 1,
  rooms: { rX: { id: 'rX', kind: 'hab', name: 'X', rects: [{ x1: 0, y1: 0, x2: 5, y2: 5 }] } } });
A.eq(partial.rooms().length, 1, 'deserialize backfills a missing order[] from rooms{}');
A.eq(partial.spawnRoomId(), 'rX', 'deserialize re-derives spawnRoomId for a partial doc');

/* ---- walkability + pathfinding over the projected geometry ---- */
const s8 = WM.create();                                  // HAB-01 {0..17,0..10}
s8.addRoom({ kind: 'lab', rect: { x1: 20, y1: 0, x2: 28, y2: 8 } });
s8.placeHallway({ rect: { x1: 18, y1: 3, x2: 19, y2: 4 } });  // bridges hab <-> lab
const g8 = s8.projectGeometry();
const ox8 = g8.origin.tx, oy8 = g8.origin.ty;
const L = (wx, wy) => [wx - ox8, wy - oy8];              // world -> local
const habT = L(3, 5), labT = L(24, 5);
A.ok(g8.walkable(habT[0], habT[1]), 'hab interior tile is walkable');
A.ok(g8.walkable(labT[0], labT[1]), 'lab interior tile is walkable');
A.ok(!g8.walkable(-1, -1), 'off-grid is not walkable');
A.ok(!g8.walkable(0, 0), 'a margin/void tile is not walkable');
const cz = g8.chamfers[0];
A.ok(cz && !g8.walkable(cz[0], cz[1]), 'a rounded-corner (chamfer) tile is not walkable');

const p = g8.path(habT[0], habT[1], labT[0], labT[1]);
A.ok(p && p.length > 0, 'a path from hab to lab exists');
A.ok(p[p.length - 1].x === labT[0] && p[p.length - 1].y === labT[1], 'path ends at the target tile');
A.eq(g8.path(habT[0], habT[1], 0, 0), null, 'no path to a void tile');
const extra = new Set();
for (let wx = 18; wx <= 19; wx++) for (let wy = 3; wy <= 4; wy++) extra.add((wx - ox8) + ',' + (wy - oy8));
A.eq(g8.path(habT[0], habT[1], labT[0], labT[1], extra), null, 'blocking the only corridor severs the path');

/* ---- footprint span cap (the far-room canvas-explosion guard) ---- */
const s9 = WM.create();
A.ok(!s9.addRoom({ kind: 'lab', rect: { x1: 800, y1: 600, x2: 806, y2: 606 } }).ok, 'a far-flung room is rejected');
A.eq(s9.addRoom({ kind: 'lab', rect: { x1: 800, y1: 600, x2: 806, y2: 606 } }).error, 'TOO_FAR', '...with TOO_FAR');
A.ok(s9.addRoom({ kind: 'lab', rect: { x1: 22, y1: 0, x2: 28, y2: 6 } }).ok, 'a nearby room is still fine');

/* ---- migrate() is total over corrupt docs (ghost order id / missing rects) ---- */
A.notThrows(() => {
  const g = WM.deserialize({ schema: 'starnet.station', version: 1,
    rooms: { rA: { id: 'rA', kind: 'hab', name: 'A', rects: [{ x1: 0, y1: 0, x2: 5, y2: 5 }] } },
    order: ['rA', 'rGHOST'], meta: { spawnRoomId: 'rGHOST' } });
  g.projectGeometry(); g.bounds(); g.canPlaceRoom([{ x1: 9, y1: 9, x2: 13, y2: 13 }], 'lab');
}, 'a doc with a ghost order id does not crash any read path');
A.notThrows(() => {
  const g = WM.deserialize({ schema: 'starnet.station', version: 1,
    rooms: { rB: { id: 'rB', kind: 'hab', name: 'B' } }, order: ['rB'] });   // room with no rects
  g.projectGeometry(); g.rooms();
}, 'a room with no rects[] is repaired, not crashed');

/* ---- props (furniture): place / validate / block-walk / move / reclaim / persist ---- */
const sp = WM.create();                                   // HAB-01 {0..17,0..10}
const spId = sp.spawnRoomId();
A.eq(sp.props().length, 0, 'a fresh station has no props');

const addP = sp.addProp({ t: 'desk', x: 4, y: 2, w: 2, h: 1 });
A.ok(addP.ok && addP.id, 'addProp onto the deck succeeds');
A.eq(sp.props().length, 1, 'one prop after add');
A.eq(sp.propAt(4, 2), addP.id, 'propAt finds the placed prop');
A.eq(sp.propAt(15, 9), null, 'propAt over bare deck returns null');

const offDeck = sp.addProp({ t: 'desk', x: 500, y: 500, w: 2, h: 1 });
A.ok(!offDeck.ok && offDeck.error === 'OFF_DECK', 'a prop off the deck is rejected');
const overlapP = sp.addProp({ t: 'tv', x: 5, y: 2, w: 3, h: 1 });
A.ok(!overlapP.ok && overlapP.error === 'OVERLAP', 'a prop overlapping another prop is rejected');
const noType = sp.addProp({ t: '', x: 8, y: 5, w: 1, h: 1 });
A.ok(!noType.ok && noType.error === 'NO_TYPE', 'a typeless prop is rejected');
A.eq(sp.props().length, 1, 'rejected prop adds do not mutate the doc');

/* wall mounts are a placement constraint only: the prop stays in its own deck tile, but every
   footprint tile must touch the visible north wall. Lock both add and move so a future builder
   change cannot silently place a wall-only prop in open floor. */
WM.setPropRules(t => t === 'weaponrack' ? { mount: 'wall' } : {});
const sw = WM.create();
const wallMid = sw.addProp({ t: 'weaponrack', x: 3, y: 3, w: 3, h: 1, block: false });
A.ok(!wallMid.ok && wallMid.error === 'NEEDS_WALL', 'a wall-mounted prop is refused in open floor');
const wallEdge = sw.addProp({ t: 'weaponrack', x: 3, y: 0, w: 3, h: 1, block: false });
A.ok(wallEdge.ok && wallEdge.id, 'the same prop places against the visible north wall');
const wallMove = sw.moveProp(wallEdge.id, 0, 2);
A.ok(!wallMove.ok && wallMove.error === 'NEEDS_WALL', 'moving a wall-mounted prop off the wall is refused');
A.eq(sw.propById(wallEdge.id).y, 0, 'a refused wall move leaves the mounted prop in place');
WM.setPropRules(null);

/* props block walkability in the projected geometry (the furniture seam) */
const gp = sp.projectGeometry();
A.ok(gp.props && gp.props.length === 1, 'projectGeometry emits props in the local frame');
const pl = gp.props[0];
A.eq(pl.t, 'desk', 'projected prop keeps its type');
A.ok(!gp.walkable(pl.x, pl.y), 'a prop footprint tile is NOT walkable (agents route around it)');
A.ok(gp.walkable(pl.x, pl.y + 2), 'the deck below the prop is still walkable');

/* move + reclaim + undo */
A.ok(sp.moveProp(addP.id, 0, 4).ok, 'moveProp to free deck succeeds');
A.eq(sp.propById(addP.id).y, 6, 'moveProp updates the prop position');
sp.undo();
A.eq(sp.propById(addP.id).y, 2, 'undo restores the prop position');
sp.redo();
A.eq(sp.propById(addP.id).y, 6, 'redo re-applies the move');
A.ok(sp.removeProp(addP.id).ok, 'removeProp succeeds');
A.eq(sp.props().length, 0, 'prop count drops after reclaim');
sp.undo();
A.eq(sp.props().length, 1, 'undo restores a reclaimed prop');

/* props survive a serialize round-trip */
const spDoc = sp.serialize();
const sp2 = WM.deserialize(spDoc);
A.eq(sp2.props().length, 1, 'deserialize preserves props');
A.eq(JSON.stringify(sp2.serialize()), JSON.stringify(spDoc), 'props serialize round-trips identically');

/* ---- moveRoom carries its contents: props + belts ride, straddlers stay ---- */
const mc = WM.create();                                   // HAB-01 {0..17,0..10}
const mcRoom = mc.spawnRoomId();
const deskM = mc.addProp({ t: 'desk', x: 4, y: 2, w: 2, h: 1 });
A.ok(deskM.ok, 'contents test: desk placed');
A.ok(mc.setBelt(6, 6, 'E').ok, 'contents test: belt laid');
A.ok(mc.moveRoom(mcRoom, 0, 30).ok, 'moveRoom with contents succeeds');
A.eq(mc.propById(deskM.id).x, 4, 'prop x untouched by a pure-Y move');
A.eq(mc.propById(deskM.id).y, 32, 'a prop wholly inside the room rides the move');
A.eq(mc.beltAt(6, 36), 'E', 'a belt tile inside the room rides the move');
A.eq(mc.beltAt(6, 6), null, 'no belt is left behind on the old tiles');
mc.undo();
A.eq(mc.propById(deskM.id).y, 2, 'undo restores the riding prop (one slot for the whole move)');
A.eq(mc.beltAt(6, 6), 'E', 'undo restores the riding belt');

/* a machine straddling a flush join belongs to neither room: it stays, and a rider that would
   land on it vetoes the whole move (all-or-nothing) */
const ms = WM.create();
const msHab = ms.spawnRoomId();
A.ok(ms.addRoom({ kind: 'lab', rect: { x1: 18, y1: 0, x2: 25, y2: 10 } }).ok, 'flush lab placed beside the hab');
const strad = ms.addProp({ t: 'desk', x: 17, y: 5, w: 2, h: 1 });   // one tile in each room
A.ok(strad.ok, 'straddling desk placed across the join');
const rider = ms.addProp({ t: 'tv', x: 17, y: 0, w: 1, h: 1 });
A.ok(rider.ok, 'rider placed inside the hab');
const veto = ms.moveRoom(msHab, 0, 5);                    // rider would land exactly on the straddler
A.ok(!veto.ok && veto.error === 'OVERLAP', 'a rider landing on a straddler vetoes the move');
A.eq(ms.roomById(msHab).rects[0].y1, 0, 'a vetoed move leaves the room where it was');
A.eq(ms.propById(rider.id).y, 0, 'a vetoed move leaves the riders where they were');
A.ok(ms.moveRoom(msHab, 0, 30).ok, 'a clear move away still succeeds');
A.eq(ms.propById(rider.id).y, 30, 'the rider rode the clear move');
A.eq(ms.propById(strad.id).y, 5, 'the straddler stayed behind (it belongs to neither room)');

/* block:false decor (rugs / wall panels) is drawn but never blocks walkability */
const sd = WM.create();
const rugRoom = sd.spawnRoomId(), rz = sd.roomById(rugRoom).rects[0];
const rug = sd.addProp({ t: 'rug', x: rz.x1 + 2, y: rz.y1 + 2, w: 2, h: 1, block: false });
A.ok(rug.ok, 'a non-blocking prop places');
const gd = sd.projectGeometry();
A.ok(gd.props[0].block === false, 'projected decor carries block:false');
A.ok(gd.walkable(rz.x1 + 2 - gd.origin.tx, rz.y1 + 2 - gd.origin.ty), 'a rug tile stays walkable (decor never blocks)');
A.eq(JSON.stringify(WM.deserialize(sd.serialize()).props()[0].block), 'false', 'block:false survives a round-trip');

/* migrate(): legacy doc with no props[] and a partial prop blob is repaired, not crashed */
A.notThrows(() => {
  const g = WM.deserialize({ schema: 'starnet.station', version: 1,
    rooms: { rP: { id: 'rP', kind: 'hab', name: 'P', rects: [{ x1: 0, y1: 0, x2: 5, y2: 5 }] } }, order: ['rP'],
    props: [{ t: 'tv', x: 1, y: 1 }, { nope: true }] });   // one valid (no id/w/h), one junk
  const pr = g.props();
  A.eq(pr.length, 1, 'migrate keeps the valid prop and drops the junk one');
  A.ok(pr[0].id && pr[0].w >= 1 && pr[0].h >= 1, 'migrate backfills id + default footprint');
  g.projectGeometry();
}, 'a legacy/partial props blob is repaired without crashing');

/* ---- Phase B: BAY agent-binding (additive prop.agentId — who runs at this belt endpoint) ---- */
const sb = WM.create();
const bz = sb.roomById(sb.spawnRoomId()).rects[0];
const bayA = sb.addProp({ t: 'bay', x: bz.x1 + 2, y: bz.y1 + 2, w: 2, h: 2, agentId: 'coder' });
A.ok(bayA.ok, 'a BAY prop places');
A.eq(sb.propById(bayA.id).agentId, 'coder', 'addProp carries opts.agentId onto the prop');
const deskP = sb.addProp({ t: 'desk', x: bz.x1 + 6, y: bz.y1 + 2, w: 2, h: 1 });
A.eq(sb.propById(deskP.id).agentId, undefined, 'a prop placed without agentId is unbound');
// projectGeometry carries it into the local frame; unbound props project agentId:null
const gb = sb.projectGeometry();
A.eq(gb.props.find(p => p.t === 'bay').agentId, 'coder', 'projectGeometry carries the bay agentId');
A.eq(gb.props.find(p => p.t === 'desk').agentId, null, 'an unbound prop projects agentId:null');
// agentId survives a serialize/deserialize round-trip (migrate must preserve it, not whitelist it away)
const sbDoc = sb.serialize();
A.eq(WM.deserialize(sbDoc).propById(bayA.id).agentId, 'coder', 'prop.agentId survives serialize/deserialize');
A.eq(JSON.stringify(WM.deserialize(sbDoc).serialize()), JSON.stringify(sbDoc), 'a doc with bound props round-trips identically');
// an OLD save (bay with no agentId) loads UNBOUND — backward compatible
const legacy = WM.deserialize({ schema: 'starnet.station', version: 1,
  rooms: { rH: { id: 'rH', kind: 'hab', name: 'H', rects: [{ x1: 0, y1: 0, x2: 8, y2: 8 }] } }, order: ['rH'],
  props: [{ id: 'p9', t: 'bay', x: 2, y: 2, w: 2, h: 2 }] });
A.eq(legacy.propById('p9').agentId, undefined, 'a legacy bay (no agentId) loads unbound');
// legacy walkable-dock repair: docks (intake/bay/outbox) shipped block:false for a while — migrate
// strips the stale flag so old stations heal on load (docks are SOLID; agents route around them).
const legacyDock = WM.deserialize({ schema: 'starnet.station', version: 1,
  rooms: { rH: { id: 'rH', kind: 'hab', name: 'H', rects: [{ x1: 0, y1: 0, x2: 8, y2: 8 }] } }, order: ['rH'],
  props: [{ id: 'pB', t: 'bay', x: 2, y: 2, w: 2, h: 2, block: false }] });
A.eq(legacyDock.propById('pB').block, undefined, 'migrate strips block:false from a legacy dock (bay is solid)');
const gld = legacyDock.projectGeometry();
A.ok(!gld.walkable(2 - gld.origin.tx, 2 - gld.origin.ty), 'a healed legacy bay footprint tile is NOT walkable');
// assignPropAgent: validate, bind, unbind
A.ok(!sb.assignPropAgent('nope', 'x').ok, 'assignPropAgent on a missing prop fails');
A.eq(sb.assignPropAgent(deskP.id, 'bad agent!').error, 'BAD_AGENT', 'assignPropAgent rejects a malformed agentId');
A.ok(sb.assignPropAgent(deskP.id, 'writer').ok && sb.propById(deskP.id).agentId === 'writer', 'assignPropAgent binds a valid agentId');
A.ok(sb.assignPropAgent(deskP.id, '').ok && sb.propById(deskP.id).agentId === undefined, 'assignPropAgent with "" unbinds');
sb.undo();
A.eq(sb.propById(deskP.id).agentId, 'writer', 'undo restores a prior binding (assignPropAgent snapshots)');
// queries
A.eq(sb.propsByType('bay').length, 1, 'propsByType("bay") finds the bay');
A.eq(sb.propsByAgent('coder')[0].id, bayA.id, 'propsByAgent("coder") finds the coder bay');
A.eq(sb.agentRoomId('coder'), sb.spawnRoomId(), 'agentRoomId returns the room the coder bay sits in (capability seam)');
A.eq(sb.agentRoomId('nobody'), null, 'agentRoomId for an unbound agent is null');

/* ---- Phase B4: FILTER/MERGER junction config carried like agentId (routes/def/bufferSize, sanitized) ---- */
const jc = WM.create();
const jr = jc.roomById(jc.spawnRoomId()).rects[0];
const jx = jr.x1 + 2, jy = jr.y1 + 2;
const filtP = jc.addProp({ t: 'filter', x: jx, y: jy, w: 1, h: 1, block: false, routes: { code: 'E', research: 'S' }, def: 'E' });
A.ok(filtP.ok, 'a filter prop places');
A.eq(JSON.stringify(jc.propById(filtP.id).routes), JSON.stringify({ code: 'E', research: 'S' }), 'addProp carries filter routes');
A.eq(jc.propById(filtP.id).def, 'E', 'addProp carries the filter default lane');
// sanitize: a route to a non-lane and a bad default are dropped (a hand-edited save can't inject a bad dir)
const filtBad = jc.addProp({ t: 'filter', x: jx + 2, y: jy, w: 1, h: 1, block: false, routes: { code: 'X', research: 'S' }, def: 'Z' });
A.eq(JSON.stringify(jc.propById(filtBad.id).routes), JSON.stringify({ research: 'S' }), 'a route to a bad lane is sanitized out');
A.eq(jc.propById(filtBad.id).def, undefined, 'a bad default lane is dropped');
const mrgP = jc.addProp({ t: 'merger', x: jx, y: jy + 2, w: 1, h: 1, block: false, bufferSize: 3 });
A.eq(jc.propById(mrgP.id).bufferSize, 3, 'addProp carries the merger bufferSize');
const mrgBad = jc.addProp({ t: 'merger', x: jx + 2, y: jy + 2, w: 1, h: 1, block: false, bufferSize: 1 });
A.eq(jc.propById(mrgBad.id).bufferSize, undefined, 'a bufferSize < 2 is dropped (the engine default K applies)');
// projectGeometry carries the config into the local frame (so the bake/pipeline can route by it)
const gj = jc.projectGeometry();
const gf = gj.props.find(p => p.id === filtP.id);
A.eq(JSON.stringify(gf.routes), JSON.stringify({ code: 'E', research: 'S' }), 'projectGeometry carries filter routes');
A.eq(gf.def, 'E', 'projectGeometry carries the filter default lane');
A.eq(gj.props.find(p => p.id === mrgP.id).bufferSize, 3, 'projectGeometry carries the merger bufferSize');
// survives serialize/deserialize (migrate must preserve it, not whitelist it away)
const jDoc = jc.serialize();
const reF = WM.deserialize(jDoc).propById(filtP.id);
A.eq(JSON.stringify(reF.routes), JSON.stringify({ code: 'E', research: 'S' }), 'filter routes survive serialize/deserialize');
A.eq(reF.def, 'E', 'filter def survives serialize/deserialize');
A.eq(WM.deserialize(jDoc).propById(mrgP.id).bufferSize, 3, 'merger bufferSize survives serialize/deserialize');
// configureJunction: set / replace wholesale / clear, with undo
A.ok(!jc.configureJunction('nope', { def: 'E' }).ok, 'configureJunction on a missing prop fails');
A.ok(jc.configureJunction(filtP.id, { routes: { code: 'S' }, def: 'S' }).ok, 'configureJunction sets new config');
A.eq(jc.propById(filtP.id).def, 'S', 'configureJunction replaced the default lane');
A.eq(JSON.stringify(jc.propById(filtP.id).routes), JSON.stringify({ code: 'S' }), 'configureJunction replaced the routes wholesale');
A.ok(jc.configureJunction(filtP.id, null).ok && jc.propById(filtP.id).routes === undefined && jc.propById(filtP.id).def === undefined, 'configureJunction(null) clears the config');
jc.undo();
A.eq(jc.propById(filtP.id).def, 'S', 'undo restores a prior junction config (configureJunction snapshots)');

/* ---- Phase B5: bayObjects — the cap-props sharing a bay's room become that agent's capability objectTypes ---- */
const cap = WM.create();
const cr = cap.roomById(cap.spawnRoomId()).rects[0];
const cbx = cr.x1 + 2, cby = cr.y1 + 2;
const capBay = cap.addProp({ t: 'bay', x: cbx, y: cby, w: 2, h: 2, block: false });
cap.assignPropAgent(capBay.id, 'coder');
A.eq(JSON.stringify(cap.bayObjects('coder')), '[]', 'a bare bay grants no capability objects');
cap.addProp({ t: 'console', x: cbx + 3, y: cby, w: 2, h: 1, block: true });       // a workstation -> compute
cap.addProp({ t: 'war_intelcab', x: cbx, y: cby + 3, w: 1, h: 2, block: true });  // a cabinet -> files
A.eq(cap.bayObjects('coder').slice().sort().join(','), 'cabinet,computer', 'cap-props in the bay room map to their capability objectTypes');
cap.addProp({ t: 'desk', x: cbx + 3, y: cby + 2, w: 2, h: 1, block: true });      // a 2nd workstation
A.eq(cap.bayObjects('coder').filter(o => o === 'computer').length, 1, 'duplicate compute objects de-dupe');
A.eq(JSON.stringify(cap.bayObjects('nobody')), '[]', 'an agent with no bay -> no capability objects');
// decor in the room never grants reach
const cap2 = WM.create();
const cr2 = cap2.roomById(cap2.spawnRoomId()).rects[0];
const b2 = cap2.addProp({ t: 'bay', x: cr2.x1 + 2, y: cr2.y1 + 2, w: 2, h: 2, block: false });
cap2.assignPropAgent(b2.id, 'r');
cap2.addProp({ t: 'plant', x: cr2.x1 + 5, y: cr2.y1 + 2, w: 1, h: 1, block: false });
A.eq(JSON.stringify(cap2.bayObjects('r')), '[]', 'decor (a plant) grants no capabilities');

/* ---- per-agent PC: a SHARED room (multiple bays) demands a DEDICATED computer per agent (the true rule) ---- */
const pcm = WM.create();
const pcr = pcm.roomById(pcm.spawnRoomId()).rects[0];
const bx = pcr.x1 + 2, by = pcr.y1 + 1;
const bayCo = pcm.addProp({ t: 'bay', x: bx, y: by, w: 2, h: 2, block: false });
const bayWr = pcm.addProp({ t: 'bay', x: bx, y: by + 3, w: 2, h: 2, block: false });
pcm.assignPropAgent(bayCo.id, 'coder');
pcm.assignPropAgent(bayWr.id, 'writer');
const sharedPc = pcm.addProp({ t: 'console', x: bx + 3, y: by, w: 2, h: 1, block: true });   // UNBOUND PC, 2 bays in the room
A.eq(pcm.bayObjects('coder').indexOf('computer'), -1, 'shared room + UNBOUND PC -> ambiguous, grants compute to nobody');
A.eq(pcm.bayObjects('writer').indexOf('computer'), -1, 'the roommate also gets no compute from an unbound PC');
pcm.assignPropAgent(sharedPc.id, 'coder');                                                    // dedicate it to coder
A.ok(pcm.bayObjects('coder').indexOf('computer') >= 0, 'a PC BOUND to coder gives coder compute');
A.eq(pcm.bayObjects('writer').indexOf('computer'), -1, "coder's dedicated PC does NOT grant the roommate compute");
const pcWr = pcm.addProp({ t: 'desk', x: bx + 3, y: by + 3, w: 2, h: 1, block: true });
pcm.assignPropAgent(pcWr.id, 'writer');
A.ok(pcm.bayObjects('writer').indexOf('computer') >= 0, 'writer gets compute once it has its OWN bound PC');
A.ok(pcm.bayObjects('coder').indexOf('computer') >= 0, 'coder still has compute — each agent now has a dedicated PC');

/* ---- REMOTE BAY (2026-08-14 ruling): a bay is a TRIGGER, placeable anywhere on the station —
        capabilities resolve from the agent's own DESK room, falling back to the bay's room only
        when the agent owns no seat workstation ---- */
const rb = WM.deserialize({
  rooms: {
    rOff: { id: 'rOff', kind: 'hab', name: 'OFFICE', rects: [{ x1: 0, y1: 0, x2: 8, y2: 8 }] },
    rMach: { id: 'rMach', kind: 'hab', name: 'MACHINES', rects: [{ x1: 12, y1: 0, x2: 20, y2: 8 }] } },
  order: ['rOff', 'rMach'],
  props: [
    { id: 'rbBay', t: 'bay', x: 14, y: 2, w: 2, h: 2, agentId: 'coder' },       // the remote dock
    { id: 'rbDesk', t: 'desk', x: 2, y: 2, w: 2, h: 1, agentId: 'coder' },      // the agent's real desk
    { id: 'rbCabO', t: 'war_intelcab', x: 6, y: 6, w: 1, h: 2 },                // office cabinet -> files
    { id: 'rbCabM', t: 'war_intelcab', x: 18, y: 6, w: 1, h: 2 }] });           // machine-room cabinet (must NOT grant)
A.eq(rb.agentRoomId('coder'), 'rOff', "remote bay: the capability room is the DESK's room, not the bay's");
A.eq(rb.bayObjects('coder').slice().sort().join(','), 'cabinet,computer', 'remote bay: tools come from the desk room (own desk = dedicated PC + the office cabinet; the machine-room cabinet does not grant)');
rb.assignPropAgent('rbDesk', '');
A.eq(rb.agentRoomId('coder'), 'rMach', 'a DESKLESS bay falls back to the bay room (legacy behavior, byte-for-byte)');
A.eq(rb.bayObjects('coder').slice().sort().join(','), 'cabinet', 'deskless fallback grants the bay room objects');
rb.assignPropAgent('rbDesk', 'coder');
// the solo-room census counts agents by their CAPABILITY room: writer's bay parks in coder's office,
// so the office hosts TWO agents and an unbound console there is ambiguous — grants compute to neither
const rbBayW = rb.addProp({ t: 'bay', x: 2, y: 6, w: 2, h: 2, block: false });
rb.assignPropAgent(rbBayW.id, 'writer');
const rbPc = rb.addProp({ t: 'console', x: 6, y: 2, w: 2, h: 1, block: true });
A.eq(rb.bayObjects('writer').indexOf('computer'), -1, 'shared capability room + unbound PC -> ambiguous, no compute (census counts capability rooms, not bay props)');
A.ok(rb.bayObjects('coder').indexOf('computer') >= 0, 'coder keeps compute — its own BOUND desk is its dedicated PC');
A.eq(rbPc.ok, true, 'the unbound console placed (census assertion above is real)');

/* ---- connector portal: a per-instance, BOUND capability — bayObjects emits its {objectType,connectorId} only when bound ---- */
const cc = WM.create();
const ccr = cc.roomById(cc.spawnRoomId()).rects[0];
const ccx = ccr.x1 + 2, ccy = ccr.y1 + 2;
const ccBay = cc.addProp({ t: 'bay', x: ccx, y: ccy, w: 2, h: 2, block: false });
cc.assignPropAgent(ccBay.id, 'ops');
const portal = cc.addProp({ t: 'connector_portal', x: ccx + 3, y: ccy, w: 1, h: 2, block: true });
A.ok(portal.ok && portal.id, 'a connector portal places in the bay room');
A.eq(JSON.stringify(cc.bayObjects('ops')), '[]', 'an UNBOUND connector portal grants nothing');
A.ok(!cc.bindConnector('nope', 'x').ok, 'bindConnector on a missing prop fails');
A.ok(cc.bindConnector(portal.id, 'github').ok && cc.propById(portal.id).connectorId === 'github', 'bindConnector sets the connectorId');
A.eq(JSON.stringify(cc.bayObjects('ops')), JSON.stringify([{ objectType: 'connector', connectorId: 'github' }]), 'a BOUND portal emits its per-instance connector object (NOT a deduped string)');
cc.addProp({ t: 'console', x: ccx, y: ccy + 3, w: 2, h: 1, block: true });   // also a workstation in the room
A.ok(cc.bayObjects('ops').indexOf('computer') >= 0, 'the bound connector object coexists with the generic cap strings');
A.ok(cc.bindConnector(portal.id, '').ok && cc.propById(portal.id).connectorId === undefined, 'bindConnector("") unbinds the portal');
A.eq(cc.bayObjects('ops').filter(o => o && o.objectType === 'connector').length, 0, 'an unbound portal again emits no connector object');

/* ---- Polish P1: a PLACED filter, configured via configureJunction, compiles DEPLOYABLE (the editor's path) ---- */
const PL = require('../frontend/app/pipeline.js');
const fp = WM.create();
const fpr = fp.roomById(fp.spawnRoomId()).rects[0];
const fx = fpr.x1 + 2, fy = fpr.y1 + 2;
fp.addProp({ t: 'intake', x: fx - 1, y: fy - 1, w: 1, h: 1, block: false });
fp.placeBeltRun({ tx: fx, ty: fy }, { tx: fx + 5, ty: fy });             // E lane -> coder bay
fp.placeBeltRun({ tx: fx + 2, ty: fy + 1 }, { tx: fx + 2, ty: fy + 3 }); // S lane -> researcher bay
const fJunc = fp.addProp({ t: 'filter', x: fx + 2, y: fy, w: 1, h: 1, block: false });
const fcoder = fp.addProp({ t: 'bay', x: fx + 6, y: fy - 1, w: 2, h: 2, block: false });
const fres = fp.addProp({ t: 'bay', x: fx + 1, y: fy + 4, w: 2, h: 2, block: false });
fp.assignPropAgent(fcoder.id, 'coder');
fp.assignPropAgent(fres.id, 'researcher');
// FILTER_NO_DEFAULT is a WARN (2026-08-04): a def-less filter never drops work (routed -> def -> first lane),
// so the un-configured floor deploys with a nag rather than refusing wholesale.
const fplan0 = PL.compileRoutingPlan(fp.projectGeometry());
A.ok(fplan0.errors.some(e => e.code === 'FILTER_NO_DEFAULT' && e.warn), 'a placed filter with NO routes nags FILTER_NO_DEFAULT (warn)');
A.ok(PL.ok(fplan0), '...and the floor still deploys (a def-less filter falls back, never drops work)');
A.ok(fp.configureJunction(fJunc.id, { routes: { code: 'E', research: 'S' }, def: 'E' }).ok, 'configureJunction sets the filter routes (the editor path)');
const fplan = PL.compileRoutingPlan(fp.projectGeometry());
A.ok(PL.ok(fplan), 'after configuring routes the placed-filter floor is DEPLOYABLE');
A.ok(!fplan.errors.some(e => e.code === 'FILTER_NO_DEFAULT'), 'the configured filter clears the nag');
A.eq(PL.resolveTarget(fplan, { tag: 'code' }), 'coder', 'code routes to the coder bay');
A.eq(PL.resolveTarget(fplan, { tag: 'research' }), 'researcher', 'research routes to the researcher bay');

/* ---- Doors / worktree isolation: a SEALED airlock drops its room's boundary doors (canStep can't cross) ---- */
const dr = WM.create();                                    // HAB-01 {0..17,0..10} = spawn = trunk
const habR = dr.spawnRoomId();
const labR = dr.addRoom({ kind: 'lab', rect: { x1: 18, y1: 0, x2: 26, y2: 8 } }).id;  // abuts the hab (shared seam)
const g0 = dr.projectGeometry();
const Ld = (wx, wy) => [wx - g0.origin.tx, wy - g0.origin.ty];     // world -> local
const habTile = Ld(3, 5), labTile = Ld(22, 5);
A.ok(g0.path(habTile[0], habTile[1], labTile[0], labTile[1]), 'rooms are connected before any airlock');
const doors0 = g0.doorDefs.length;
A.ok(doors0 > 0, 'auto-doors exist along the abutting seam');

// a SEALED airlock in the lab cuts it off
const al = dr.addProp({ t: 'airlock', x: 20, y: 4, w: 1, h: 1, block: false, door: 'closed' });
A.ok(al.ok, 'an airlock prop places on the deck');
A.eq(dr.propById(al.id).door, 'closed', 'addProp carries opts.door onto the airlock');
const g1 = dr.projectGeometry();
A.ok(g1.doorDefs.length < doors0, 'sealing the lab drops its boundary doors');
A.eq(g1.path(habTile[0], habTile[1], labTile[0], labTile[1]), null, 'a sealed room is unreachable (isolation via the existing pathing)');
A.ok(g1.walkable(labTile[0], labTile[1]), 'the sealed room is still walkable INSIDE (the agent is just sealed in)');
A.eq(g1.props.find(p => p.id === al.id).door, 'closed', 'projectGeometry carries the door state to the renderer');

// reopen -> reconnected, and 'open' clears the field so docs stay clean
A.ok(dr.setDoorState(al.id, 'open').ok && dr.propById(al.id).door === undefined, 'setDoorState open clears the field (= default)');
const g2 = dr.projectGeometry();
A.ok(g2.path(habTile[0], habTile[1], labTile[0], labTile[1]), 'reopening reconnects the room');
A.eq(g2.doorDefs.length, doors0, 'reopening restores every boundary door');

// jammed (a merge conflict) also seals
A.ok(dr.setDoorState(al.id, 'jammed').ok && dr.propById(al.id).door === 'jammed', 'setDoorState jammed sets the field');
A.eq(dr.projectGeometry().path(habTile[0], habTile[1], labTile[0], labTile[1]), null, 'a jammed room is sealed too');

// validation + undo (setDoorState snapshots)
A.ok(!dr.setDoorState('nope', 'open').ok, 'setDoorState on a missing prop fails');
A.eq(dr.setDoorState(al.id, 'ajar').error, 'BAD_STATE', 'setDoorState rejects an unknown state');
dr.setDoorState(al.id, 'closed'); dr.undo();
A.eq(dr.propById(al.id).door, 'jammed', 'undo restores a prior door state');

// the TRUNK room never seals — the integration hub can't be severed from the station
const tr = WM.create();
const trZ = tr.roomById(tr.spawnRoomId()).rects[0];        // freshDoc made the spawn room the trunk
tr.addRoom({ kind: 'lab', rect: { x1: 18, y1: 0, x2: 26, y2: 8 } });
const trDoors = tr.projectGeometry().doorDefs.length;
tr.addProp({ t: 'airlock', x: trZ.x1 + 2, y: trZ.y1 + 2, w: 1, h: 1, block: false, door: 'closed' });
A.eq(tr.projectGeometry().doorDefs.length, trDoors, 'a closed airlock in the trunk room does NOT seal it');

// door state survives serialize/deserialize; bad/legacy door values are sanitized; trunkRoomId backfills
const drDoc = dr.serialize();
A.eq(WM.deserialize(drDoc).propById(al.id).door, 'jammed', 'prop.door survives serialize/deserialize');
A.eq(JSON.stringify(WM.deserialize(drDoc).serialize()), JSON.stringify(drDoc), 'a doc with airlocks round-trips identically');
const legacyDoor = WM.deserialize({ schema: 'starnet.station', version: 1,
  rooms: { rD: { id: 'rD', kind: 'hab', name: 'D', rects: [{ x1: 0, y1: 0, x2: 8, y2: 8 }] } }, order: ['rD'],
  props: [{ id: 'pA', t: 'airlock', x: 2, y: 2, w: 1, h: 1, door: 'ajar' }] });   // junk door value
A.eq(legacyDoor.propById('pA').door, undefined, 'migrate drops an invalid door value');
A.eq(legacyDoor.doc().meta.trunkRoomId, 'rD', 'migrate backfills trunkRoomId to the spawn room');

/* ---- Session 2: PipelineEdge persists, migrates, sanitizes, and participates in undo ---- */
const pe = WM.create();
A.eq(JSON.stringify(pe.pipelineEdges()), '[]', 'a fresh station has no PipelineEdge entries');
A.ok(pe.addPipelineEdge({ from: 'lead', to: 'worker', whenKind: 'handoff', lane: 'primary' }).ok, 'addPipelineEdge accepts a valid PipelineEdge');
A.eq(JSON.stringify(pe.pipelineEdges()), JSON.stringify([{ from: 'lead', to: 'worker', whenKind: 'handoff', lane: 'primary' }]), 'pipelineEdges returns the persisted edge');
const peDoc = pe.serialize();
A.eq(JSON.stringify(WM.deserialize(peDoc).pipelineEdges()), JSON.stringify(pe.pipelineEdges()), 'PipelineEdge survives serialize/deserialize');
pe.undo();
A.eq(JSON.stringify(pe.pipelineEdges()), '[]', 'undo removes the added PipelineEdge');
pe.redo();
A.eq(pe.pipelineEdges().length, 1, 'redo restores the PipelineEdge');
A.eq(pe.addPipelineEdge({ from: 'lead', to: 'lead', whenKind: 'handoff' }).error, 'BAD_EDGE', 'self PipelineEdge is rejected');
A.ok(pe.removePipelineEdge({ from: 'lead', to: 'worker', whenKind: 'handoff', lane: 'primary' }).ok, 'removePipelineEdge removes the matching edge');
A.eq(JSON.stringify(pe.pipelineEdges()), '[]', 'edge list is empty after removal');
const legacyEdges = WM.deserialize({ schema: 'starnet.station', version: 1,
  rooms: { rE: { id: 'rE', kind: 'hab', name: 'E', rects: [{ x1: 0, y1: 0, x2: 8, y2: 8 }] } }, order: ['rE'],
  edges: [{ from: 'a', to: 'b', whenKind: 'handoff' }, { from: 'bad agent', to: 'b', whenKind: 'handoff' }, { from: 'a', to: 'a', whenKind: 'handoff' }] });
A.eq(JSON.stringify(legacyEdges.pipelineEdges()), JSON.stringify([{ from: 'a', to: 'b', whenKind: 'handoff' }]), 'migrate keeps only valid PipelineEdge entries');
const oldNoEdges = WM.deserialize({ schema: 'starnet.station', version: 1,
  rooms: { rOld: { id: 'rOld', kind: 'hab', name: 'Old', rects: [{ x1: 0, y1: 0, x2: 8, y2: 8 }] } }, order: ['rOld'] });
A.eq(JSON.stringify(oldNoEdges.pipelineEdges()), '[]', 'legacy docs without edges migrate to []');
A.eq(JSON.stringify(WM.deserialize({ rooms: {}, order: [], props: [], edges: [{ from: 'a', to: 'b', whenKind: 'handoff', lane: 'bad lane' }] }).pipelineEdges()), '[]', 'malformed edge lanes are dropped during migration');

/* ---- ensureWorkstation: the overseer's starter desk is a REAL prop (2026-07-05 NO COMPUTE bug) ---- */
{
  const st = WM.create();
  const r1 = st.ensureWorkstation('agent');
  A.ok(r1.ok && !r1.existing, 'fresh station: ensureWorkstation seeds a desk');
  const desks = st.props().filter(p => p.t === 'desk' && p.agentId === 'agent');
  A.eq(desks.length, 1, 'exactly one hero-assigned desk seeded');
  A.eq(st.roomAt(desks[0].x, desks[0].y), st.spawnRoomId(), 'seeded desk sits in the spawn room');
  const r2 = st.ensureWorkstation('agent');
  A.ok(r2.ok && r2.existing, 'second call is a no-op (idempotent)');
  A.eq(st.props().filter(p => p.t === 'desk').length, 1, 'no duplicate desk on re-seed');

  // THE BUG ITSELF: a bay bound to the hero, in the same room as the starter PC, must grant compute
  const bay = st.addProp({ t: 'bay', x: 8, y: 4, w: 2, h: 2, block: false });
  st.assignPropAgent(bay.id, 'agent');
  A.ok(st.bayObjects('agent').indexOf('computer') >= 0, 'bay beside the STARTER desk sees a computer (no more NO COMPUTE lie)');
}
{
  // canonical spot occupied → the desk still lands on the nearest valid spawn-room tile
  const st = WM.create();
  st.addProp({ t: 'vault', x: 8, y: 1, w: 3, h: 2, block: true });   // squat on the north-wall spot
  const r = st.ensureWorkstation('agent');
  A.ok(r.ok, 'occupied canonical spot: seeding falls back to a nearby valid tile');
  A.eq(st.props().filter(p => p.t === 'desk' && p.agentId === 'agent').length, 1, 'fallback still seeds exactly one desk');
}
{
  // an agent that already OWNS a workstation is never re-seeded
  const st = WM.create();
  const c = st.addProp({ t: 'console', x: 3, y: 6, w: 2, h: 1, block: true });
  st.assignPropAgent(c.id, 'agent');
  const r = st.ensureWorkstation('agent');
  A.ok(r.ok && r.existing, 'existing assigned console counts — no desk added');
  A.eq(st.props().filter(p => p.t === 'desk').length, 0, 'no desk seeded next to an owned console');
  A.eq(r.id, c.id, 'the existing-workstation report names the prop the agent already owns');
  A.ok(!st.ensureWorkstation('').ok, 'blank agent id refused');
}
/* ---- SUMMON SEEDING: a specialist created on request arrives WITH its desk (2026-07-27) ---- */
{
  // every summoned crew member gets its OWN desk, distinct from the hero's, all seat-approachable
  const st = WM.create();
  const hero = st.ensureWorkstation('agent');
  A.eq(hero.x + ',' + hero.y, '8,1', 'the hero seed still lands on the canonical north-wall spot');
  const seeded = ['scout-2', 'coder-3', 'ops-4'].map(id => st.ensureWorkstation(id));
  A.ok(seeded.every(r => r.ok && !r.existing), 'each summoned agent seeds its own workstation');
  const ids = new Set(seeded.map(r => r.id).concat(hero.id));
  A.eq(ids.size, 4, 'four agents = four distinct desk props (never a shared desk)');
  A.ok(seeded.every(r => r.roomId === st.spawnRoomId()), 'crew desks land in the spawn room beside the hero');
  A.ok(seeded.every(r => r.y === hero.y), 'crew desks line up on the hero\'s own desk row, not under the north wall face');
  // the whole point of a desk: somewhere to sit. The row below each desk must hold a reachable tile.
  for (const r of seeded.concat(hero)) {
    const free = [r.x, r.x + 1].some(sx => {
      if (!st.roomAt(sx, r.y + 1)) return false;
      const pid = st.propAt(sx, r.y + 1);
      const p = pid ? st.propById(pid) : null;
      return !p || p.block === false;
    });
    A.ok(free, 'seeded desk ' + r.id + ' has a free seat tile in front of it');
  }
  A.ok(st.ensureWorkstation('scout-2').existing, 'a summoned agent is never given a second desk');
}
{
  // a desk spot whose seat row is walled off is passed over in favour of a seatable one
  const st = WM.create();
  const rect = st.roomById(st.spawnRoomId()).rects[0];
  A.eq(rect.y1, 0, 'starter room begins at y=0 (the wall-row assumption below)');
  // wall off the seat row under the whole of row 1 except one gap, then seed: the desk must take the gap
  for (let x = 0; x <= 17; x++) if (x !== 6 && x !== 7) st.addProp({ t: 'rack', x, y: 2, w: 1, h: 1, block: true });
  const r = st.ensureWorkstation('scout-2');
  A.ok(r.ok, 'a mostly-blocked seat row still seeds a desk');
  A.eq(r.y, 1, 'the desk stays on the desk row');
  A.ok([r.x, r.x + 1].some(sx => sx === 6 || sx === 7), 'the desk straddles the one gap whose seat tile is actually free');
}
{
  // the spawn room is full → the seed spills into another room rather than stranding the agent deskless
  const st = WM.create();
  const rect = st.roomById(st.spawnRoomId()).rects[0];
  const other = st.addRoom({ kind: 'hab', name: 'ANNEX', rect: { x1: rect.x2 + 2, y1: 0, x2: rect.x2 + 9, y2: 6 } });
  A.ok(other.ok, 'annex room built for the overflow case');
  for (let y = rect.y1; y <= rect.y2; y++) for (let x = rect.x1; x <= rect.x2; x++) st.addProp({ t: 'rack', x, y, w: 1, h: 1, block: true });
  const r = st.ensureWorkstation('scout-2');
  A.ok(r.ok && !r.existing, 'a packed spawn room does not strand a summoned agent deskless');
  A.eq(r.roomId, other.id, 'the overflow desk lands in the next room with space');
  A.eq(st.props().filter(p => p.t === 'desk' && p.agentId === 'scout-2').length, 1, 'still exactly one desk for the agent');
}
{
  // ADOPTION: an UNBOUND workstation in the spawn room is taken over, never duplicated beside
  const st = WM.create();
  st.ensureWorkstation('agent');
  const spare = st.addProp({ t: 'console', x: 2, y: 5, w: 2, h: 1, block: true });   // Commander built it, never bound it
  const r = st.ensureWorkstation('scout-2');
  A.ok(r.ok && r.adopted, 'a free workstation in the spawn room is adopted rather than duplicated');
  A.eq(r.id, spare.id, 'the adopted prop is the one that was already standing there');
  A.eq(st.props().filter(p => p.t === 'desk').length, 1, 'no second desk is built beside a usable free one');
  A.eq(st.propById(spare.id).agentId, 'scout-2', 'the free workstation is now bound to the summoned agent');
}
{
  // the summon -> delete -> summon cycle must not litter the floor (deleteAgent UNBINDS, never demolishes)
  const st = WM.create();
  st.ensureWorkstation('agent');
  for (let i = 0; i < 4; i++) {
    const r = st.ensureWorkstation('temp-' + i);
    A.ok(r.ok, 'cycle ' + i + ' seats the agent');
    // mirror deleteAgent: unbind every prop assigned to the removed specialist
    for (const p of st.propsByAgent('temp-' + i)) st.assignPropAgent(p.id, '');
  }
  A.eq(st.props().filter(p => p.t === 'desk').length, 2, 'four summon/delete cycles leave ONE reusable desk, not four');
}
{
  // a free desk in ANOTHER room is left alone — the specialist is not exiled to a far lab
  const st = WM.create();
  st.ensureWorkstation('agent');
  const rect = st.roomById(st.spawnRoomId()).rects[0];
  const lab = st.addRoom({ kind: 'hab', name: 'LAB', rect: { x1: rect.x2 + 2, y1: 0, x2: rect.x2 + 9, y2: 6 } });
  const remote = st.addProp({ t: 'console', x: rect.x2 + 3, y: 2, w: 2, h: 1, block: true });
  const r = st.ensureWorkstation('scout-2');
  A.ok(r.ok && !r.adopted, 'a free desk in a distant room is NOT adopted');
  A.eq(r.roomId, st.spawnRoomId(), 'the summoned agent is seated in the spawn room instead');
  A.eq(st.propById(remote.id).agentId, undefined, 'the Commander\'s unbound lab console is left untouched');
}
{
  // no space anywhere → an honest failure, never a phantom desk
  const st = WM.create();
  const rect = st.roomById(st.spawnRoomId()).rects[0];
  for (let y = rect.y1; y <= rect.y2; y++) for (let x = rect.x1; x <= rect.x2; x++) st.addProp({ t: 'rack', x, y, w: 1, h: 1, block: true });
  const r = st.ensureWorkstation('scout-2');
  A.ok(!r.ok, 'a station with nowhere to put a desk reports failure');
  A.eq(r.error, 'NO_ROOM_FOR_DESK', 'and names the reason so the caller can stay honest about it');
  A.eq(st.props().filter(p => p.t === 'desk').length, 0, 'no desk prop is invented on failure');
}

/* ---- connectBelt: CLICK TWO MACHINES, the path lays itself (2026-07-05 connect-mode UX) ---- */
{
  const Pipeline = require('../frontend/app/pipeline.js');
  const st = WM.create();   // 18x11 starter room
  const inbox = st.addProp({ t: 'intake', x: 0, y: 4, w: 2, h: 2, block: false });
  const bay = st.addProp({ t: 'bay', x: 8, y: 4, w: 2, h: 2, block: false });
  st.assignPropAgent(bay.id, 'agent');
  const c1 = st.connectBelt(inbox.id, bay.id);
  A.ok(c1.ok && c1.count >= 5, 'INBOX→BAY connects across free floor (' + c1.count + ' belts laid)');
  const plan = Pipeline.compileRoutingPlan(st.projectGeometry());
  A.eq(plan.errors.length, 0, 'the auto-laid line compiles clean (source hooked, bay hooked, reachable)');
  A.eq(plan.reach.agent, true, 'the bay is reachable from the inbox along the auto path');
  A.ok(Object.keys(Pipeline.liveTiles(plan)).length >= c1.count, 'the whole auto lane glows live');
  // outbound leg: BAY → OUTBOX also auto-connects, and both legs stay clean
  const obox = st.addProp({ t: 'outbox', x: 14, y: 4, w: 2, h: 2, block: false });
  const c2 = st.connectBelt(bay.id, obox.id);
  A.ok(c2.ok && c2.count >= 2, 'BAY→OUTBOX connects (' + c2.count + ' belts)');
  const plan2 = Pipeline.compileRoutingPlan(st.projectGeometry());
  A.eq(plan2.errors.length, 0, 'inbound + outbound legs coexist clean');
  // one undo removes the whole second connection
  const beltsBefore = st.belts().length;
  st.undo();
  A.eq(st.belts().length, beltsBefore - c2.count, 'one undo removes the ENTIRE connection (single snapshot)');
  st.redo();
  // guards
  A.ok(!st.connectBelt(inbox.id, inbox.id).ok, 'same machine twice is refused');
  A.ok(!st.connectBelt('nope', bay.id).ok, 'unknown prop is refused');
  const desk = st.addProp({ t: 'desk', x: 4, y: 9, w: 2, h: 1, block: true });
  A.ok(!st.connectBelt(inbox.id, desk.id).ok, 'a workstation is not a belt endpoint (belts never run to desks)');
}
{
  // NO_PATH: a full-height wall of blocking props separates the two machines
  const st = WM.create();
  const a = st.addProp({ t: 'intake', x: 0, y: 4, w: 2, h: 2, block: false });
  for (let y = 0; y <= 10; y++) st.addProp({ t: 'rack', x: 5, y: y, w: 2, h: 1, block: true });
  const b = st.addProp({ t: 'bay', x: 10, y: 4, w: 2, h: 2, block: false });
  st.assignPropAgent(b.id, 'agent');
  const r = st.connectBelt(a.id, b.id);
  A.ok(!r.ok && r.error === 'NO_PATH', 'a walled-off destination fails with NO_PATH (never a partial lane)');
  A.eq(st.belts().length, 0, '...and lays nothing');
}
{
  // a FILTER already ON a line branches from a free neighbor — the junction out-lane forms naturally
  const Pipeline = require('../frontend/app/pipeline.js');
  const st = WM.create();
  const inbox = st.addProp({ t: 'intake', x: 0, y: 2, w: 2, h: 2, block: false });
  const bay1 = st.addProp({ t: 'bay', x: 10, y: 2, w: 2, h: 2, block: false });
  st.assignPropAgent(bay1.id, 'agent');
  A.ok(st.connectBelt(inbox.id, bay1.id).ok, 'main line laid');
  // drop the filter ON the line (a mid-lane tile), then connect it to a second bay below
  const mid = st.belts()[Math.floor(st.belts().length / 2)];
  const filt = st.addProp({ t: 'filter', x: mid.x, y: mid.y, w: 1, h: 1, block: false });
  const bay2 = st.addProp({ t: 'bay', x: Math.max(0, mid.x - 1), y: 8, w: 2, h: 2, block: false });
  st.assignPropAgent(bay2.id, 'coder');
  const br = st.connectBelt(filt.id, bay2.id);
  A.ok(br.ok, 'FILTER→BAY branch connects from the on-line junction');
  st.configureJunction(filt.id, { routes: { code: 'S' }, def: 'E' });
  const plan = Pipeline.compileRoutingPlan(st.projectGeometry());
  A.eq(plan.reach.agent, true, 'main-lane bay reachable');
  A.eq(plan.reach.coder, true, 'branch bay reachable through the junction');
}

/* ---- connectBelt can wire a 1x1 JUNCTION (2026-08-22 stranded-user sweep) ----
   The old path picked ANY pathable ring tile of a junction (diagonal corners included) and never laid a belt
   on the junction's own tile, so "CONNECTED" chimed while the compiler reported SPLIT_ONE_LANE /
   JOIN_ONE_LANE / BAY_NOT_FED. The proof is the compiler's verdict on a floor built PURELY by click-connect. */
{
  const Pipeline = require('../frontend/app/pipeline.js');
  const st = WM.create();
  const add = (t, x, y, w, h) => st.addProp({ t, x, y, w, h, block: false });
  // INBOX -> SPLITTER -> (A | B) -> JOINER -> C -> OUTBOX
  const inbox = add('intake', 0, 4, 2, 2), sp = add('splitter', 3, 5, 1, 1), a = add('bay', 5, 1, 2, 2), b = add('bay', 5, 8, 2, 2);
  const jn = add('joiner', 9, 5, 1, 1), c = add('bay', 11, 4, 2, 2), ob = add('outbox', 15, 4, 2, 2);
  st.assignPropAgent(a.id, 'A'); st.assignPropAgent(b.id, 'B'); st.assignPropAgent(c.id, 'C');
  for (const [f, t] of [[inbox, sp], [sp, a], [sp, b], [a, jn], [b, jn], [jn, c], [c, ob]]) {
    const r = st.connectBelt(f.id, t.id);
    A.ok(r.ok, f.t + ' -> ' + t.t + ' connects (' + JSON.stringify(r) + ')');
  }
  A.ok(!!st.beltAt(3, 5), 'the lane runs THROUGH the splitter tile (a belt lies under it)');
  A.ok(!!st.beltAt(9, 5), 'the lane runs THROUGH the joiner tile');
  const plan = Pipeline.compileRoutingPlan(st.projectGeometry());
  A.eq(JSON.stringify(plan.errors), '[]', 'a split/join floor built purely by click-connect compiles with NO findings');
  const js = Object.values(plan.junctions);
  const split = js.find(j => j.kind === 'split'), join = js.find(j => j.kind === 'join');
  A.eq(split && split.fanout, true, 'the splitter compiles as a fan-out split (two real out-lanes, joiner downstream)');
  A.eq(join && join.expect, 2, 'the joiner counts TWO in-lanes');
  A.eq(plan.chains.A.next.join(','), 'C', 'A chains through the joiner to C');
  A.eq(plan.chains.B.next.join(','), 'C', 'B chains through the joiner to C');
  A.eq(plan.reach.A && plan.reach.B, true, 'both branches are reachable from the INBOX');
  // the joiner's own arrow points at its exit, never into an in-lane
  const jb = st.beltAt(9, 5);
  A.eq(jb, 'E', 'the joiner tile aims at its out-lane (' + jb + ')');
  // the honest failure: a junction boxed in on all four sides cannot be entered — no chime, a message that says so
  const st2 = WM.create();
  const i2 = st2.addProp({ t: 'intake', x: 0, y: 4, w: 2, h: 2, block: false });
  const s2 = st2.addProp({ t: 'splitter', x: 8, y: 5, w: 1, h: 1, block: false });
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) st2.addProp({ t: 'rack', x: 8 + dx, y: 5 + dy, w: 1, h: 1, block: true });
  const r2 = st2.connectBelt(i2.id, s2.id);
  A.ok(!r2.ok && /SPLITTER/.test(r2.msg || ''), 'a boxed-in junction refuses honestly and names the machine (' + JSON.stringify(r2) + ')');
  A.eq(st2.belts().length, 0, '...and lays nothing (never a corner lane the compiler cannot count)');
}
{
  // writer -> reviewer -> LOOP (done -> OUTBOX, back -> writer): the draft/review loop built by click-connect
  const Pipeline = require('../frontend/app/pipeline.js');
  const st = WM.create();
  const add = (t, x, y, w, h) => st.addProp({ t, x, y, w, h, block: false });
  const inbox = add('intake', 0, 0, 2, 2), w = add('bay', 1, 4, 2, 2), r = add('bay', 6, 4, 2, 2), lp = add('loop', 10, 5, 1, 1), ob = add('outbox', 13, 4, 2, 2);
  st.assignPropAgent(w.id, 'writer'); st.assignPropAgent(r.id, 'reviewer');
  for (const [f, t] of [[inbox, w], [w, r], [r, lp], [lp, ob], [lp, w]]) {
    const res = st.connectBelt(f.id, t.id);
    A.ok(res.ok, f.t + ' -> ' + t.t + ' connects (' + JSON.stringify(res) + ')');
  }
  const plan = Pipeline.compileRoutingPlan(st.projectGeometry());
  A.ok(!plan.errors.some(e => e.code === 'CHAIN_CYCLE' || e.code === 'CYCLE'), 'a review loop through a LOOP gate is not a cycle: ' + JSON.stringify(plan.errors));
  A.eq(JSON.stringify(plan.errors), '[]', 'the loop floor compiles with no findings (no LOOP_NO_DONE / LOOP_NO_BACK nag)');
  const gate = Object.values(plan.junctions).find(j => j.kind === 'loop');
  A.ok(gate && gate.back && gate.done && gate.done !== gate.back, 'the gate has distinct done and back lanes');
  A.eq(gate.backTo, 'writer', 'the back lane re-enters the WRITER (the lane does not brush the reviewer ring on its way back)');
  A.eq(st.propById(lp.id).done, gate.done, 'connecting LOOP -> OUTBOX named that lane the done lane on the prop');
  A.eq(plan.chains.reviewer.next.length, 0, 'the reviewer is statically terminal (done lane -> OUTBOX)');
  const step = Pipeline.chainStep(plan, 'reviewer', { lineId: Pipeline.lineOf(plan, 'reviewer') });
  A.ok(step && step.loop && step.backTo === 'writer' && step.next === null, 'the chain runner will meet the loop gate from the reviewer (' + JSON.stringify(step) + ')');
  // a second connect of the same pair does not re-route: the first lane is already there
  A.eq(plan.reach.writer, true, 'the writer is fed by the INBOX');
}

/* ---- A STATION HAS A DURABLE IDENTITY (2026-08-07 conveyor audit) ----
   `meta.createdAt` is the id every per-station REFIT one-shot namespaces its localStorage on (the first
   ride, the ORDERS dismissal, the finish-the-line registry — build.js stationKeyOf). Nothing ever stamped
   it: freshDoc wrote `createdAt || 0` and no caller passed one, so the key was the constant 'default' and
   every "per-station" latch was in fact GLOBAL — a brand-new station inherited the first one's
   dismissals, never saw its first ride, and had its first line retired before the card was ever shown. */
{
  const a = WM.defaultDoc();
  A.ok(a.meta.createdAt > 0, 'a new station is stamped with a real id, never 0');
  const b = WM.defaultDoc();
  A.ok(b.meta.createdAt >= a.meta.createdAt, 'the stamp is a monotonic clock reading');
  A.eq(WM.defaultDoc(12345).meta.createdAt, 12345, 'an explicit id is honoured (deterministic for importers/tests)');

  // the id SURVIVES the persistence seam — that is the whole point of it
  const st = WM.create();
  const id = st.serialize().meta.createdAt;
  A.ok(id > 0, 'a live station carries its id');
  A.eq(WM.deserialize(st.serialize()).serialize().meta.createdAt, id, 'and a save/load round-trip keeps it EXACTLY (never re-rolls)');

  // legacy docs are backfilled ONCE, non-destructively — an existing stamp is never overwritten
  const legacy = st.serialize(); legacy.meta.createdAt = 0;
  const healed = WM.deserialize(legacy).serialize().meta.createdAt;
  A.ok(healed > 0, 'a doc saved before station identity existed is backfilled on migrate');
  const stamped = st.serialize(); stamped.meta.createdAt = 777;
  A.eq(WM.deserialize(stamped).serialize().meta.createdAt, 777, '…and a doc that already has one keeps it untouched');

  // two stations must not answer the same id, or the latches collide exactly as before
  A.ok(WM.defaultDoc(1).meta.createdAt !== WM.defaultDoc(2).meta.createdAt, 'two stations are distinguishable');
}

/* ---- A HALLWAY CORNER IS ROUNDED IN ART AND STILL WALKABLE (2026-08-10) ----
   Chamfers used to be computed for rooms only, which left every hallway's convex corner a raw right
   angle — the tall north face colliding with the flat side band with nothing between them. Hallways
   emit chamfers now, but ONLY rooms may block the tile: a chamfer tile is unwalkable, MIN_HALL
   allows 2 wide, and blocking both corners of a 2-wide end row severs the hall. A 2x2 hallway would
   have all four corners blocked and become an impassable hole — silently, on saves that already
   exist. These two assertions are the pair; neither alone catches the regression that matters. */
{
  const st = WM.create(WM.defaultDoc());
  const room = st.addRoom({ kind: 'hab', rects: [{ x1: 60, y1: 60, x2: 71, y2: 68 }] });
  const hall = st.placeHallway({ rects: [{ x1: 64, y1: 69, x2: 65, y2: 76 }] });
  A.ok(room && room.id && hall && hall.id, 'room + hallway placed clear of the default station');
  const geo = st.projectGeometry();

  const key = c => c[0] + ',' + c[1];
  const hallRect = geo.allRects.find(r => r.z === hall.id);
  const inHall = c => c[0] >= hallRect.x1 && c[0] <= hallRect.x2 && c[1] >= hallRect.y1 && c[1] <= hallRect.y2;
  const hallCh = geo.chamfers.filter(inHall);
  A.ok(hallCh.length > 0, 'a hallway s void-exposed corners ARE chamfered (the art fix)');

  // …and not one of them costs the hallway a walkable tile
  const blocked = hallCh.filter(c => !geo.walkable(c[0], c[1]));
  A.eq(blocked.length, 0, 'no hallway chamfer tile is blocked — corridor walkability is unchanged');

  // the room's own chamfers still block, exactly as before
  const roomRect = geo.allRects.find(r => r.z === room.id);
  const roomCh = geo.chamfers.filter(c => c[0] >= roomRect.x1 && c[0] <= roomRect.x2 && c[1] >= roomRect.y1 && c[1] <= roomRect.y2);
  A.ok(roomCh.length > 0, 'a room still chamfers its void-exposed corners');
  A.ok(roomCh.every(c => !geo.walkable(c[0], c[1])), '…and a room chamfer is still an unwalkable tile');

  // the shape that would have been severed outright: a 2x2 hallway must keep every tile
  const st2 = WM.create(WM.defaultDoc());
  st2.addRoom({ kind: 'hab', rects: [{ x1: 60, y1: 60, x2: 71, y2: 68 }] });
  const tiny = st2.placeHallway({ rects: [{ x1: 64, y1: 69, x2: 65, y2: 70 }] });
  if (tiny && tiny.id) {
    const g2 = st2.projectGeometry(), tr = g2.allRects.find(r => r.z === tiny.id);
    let walk = 0;
    for (let y = tr.y1; y <= tr.y2; y++) for (let x = tr.x1; x <= tr.x2; x++) if (g2.walkable(x, y)) walk++;
    A.eq(walk, 4, 'a 2x2 hallway keeps all four tiles walkable (it would be a sealed hole otherwise)');
  }
  void key;
}

/* ---- LINE BUDGET: an INBOX's limits normalize, clamp, persist through serialize/migrate, project ---- */
{
  const lb = WM.create();
  const ib = lb.addProp({ t: 'intake', x: 2, y: 2, w: 1, h: 1 });
  const dk = lb.addProp({ t: 'desk', x: 8, y: 2, w: 2, h: 1 });
  A.ok(ib.ok && dk.ok, 'an INBOX and a desk place');
  A.ok(!lb.setPropLimits(dk.id, { maxHops: 2 }).ok, 'only an INBOX carries a line budget');
  const r1 = lb.setPropLimits(ib.id, { maxHops: 99, maxUsdPerMessage: '3', maxUsdPerDay: 10 });
  A.ok(r1.ok, 'setPropLimits on an INBOX succeeds');
  A.eq(r1.limits.maxHops, 24, 'maxHops is clamped to the ceiling on the way into the doc');
  A.eq(r1.clamped[0], 'maxHops>24', 'and the clamp is reported');
  A.eq(r1.limits.maxUsdPerMessage, 3, 'a numeric string normalizes');
  const back = WM.deserialize(JSON.parse(JSON.stringify(lb.serialize())));
  const ip = back.propById(ib.id);
  A.eq(JSON.stringify(ip.limits), JSON.stringify({ maxHops: 24, maxUsdPerMessage: 3, maxUsdPerDay: 10 }), 'limits survive serialize -> migrate -> deserialize');
  const geoP = back.projectGeometry().props.find(q => q.id === ib.id);
  A.eq(geoP.limits.maxUsdPerDay, 10, 'and project onto the geometry the plan compiles from');
  A.ok(lb.setPropLimits(ib.id, null).ok && !lb.propById(ib.id).limits, 'null clears the budget (station defaults)');
  A.ok(lb.setPropLimits(ib.id, { maxHops: 'x' }).ok && !lb.propById(ib.id).limits, 'garbage clears rather than stores garbage');
}

{
  const starter = WM.create(WM.starterDoc());
  const desk = starter.ensureWorkstation('agent');
  A.ok(desk.ok, 'composed starter has an approachable real agent desk');
  A.ok(starter.canPlaceProp('intake', 4, 4, 2, 2).ok, 'starter leaves the central workflow lane free');
  const restored = WM.deserialize(JSON.parse(JSON.stringify(starter.serialize())));
  A.eq(restored.props().length, starter.props().length, 'starter furniture survives a save round-trip without duplicates');
  A.eq(restored.ensureWorkstation('agent').id, desk.id, 'reload retains the assigned desk');
  const old = WM.create();
  const before = JSON.stringify(old.serialize().rooms);
  A.eq(JSON.stringify(WM.deserialize(old.serialize()).serialize().rooms), before, 'existing station dimensions are never recomposed');
}

/* ---- new deck catalogs use the existing placement, palette and persistence paths ---- */
{
  const oldMaterials = ['spine', 'alloy', 'runner', 'treadway', 'meshway', 'plate', 'diamond', 'cargo', 'panel', 'tile', 'ceramic', 'resin', 'tread', 'soft', 'grate', 'hex', 'plank', 'turf', 'basalt', 'parquet', 'rubber'];
  const additions = { basalt: 'BASALT', parquet: 'PARQUET', rubber: 'RUBBER', slotted: 'SLOTTED', terrazzo: 'TERRAZZO', octile: 'OCTILE' };
  A.eq(WM.MAT_ORDER.slice(0, oldMaterials.length), oldMaterials, 'new decks retain all 21 previous picker entries in their original order');
  A.eq(WM.MAT_ORDER.slice(oldMaterials.length), ['slotted', 'terrazzo', 'octile'], 'the three new material choices append to the existing catalog');
  A.eq(new Set(WM.MAT_ORDER).size, WM.MAT_ORDER.length, 'the material picker has no duplicate entries');
  for (const [mid, label] of Object.entries(additions)) {
    const st = WM.create(), id = st.spawnRoomId(), def = st.FLOOR_MATERIALS[mid];
    A.ok(def && st.MAT_ORDER.includes(mid), mid + ' appears in the catalog-backed surface picker');
    A.eq(def.label, label, mid + ' has its named material swatch');
    A.ok(st.FLOOR_STYLES[def.suggest], mid + ' suggests a real, overridable picker hue');
    st.setFloor(id, 'cobalt');
    st.paintTiles(id, [[2, 2]], 'crimson');
    const paint = JSON.stringify(st.roomById(id).floorPaint), previous = st.matOfRoom(id);
    A.ok(st.setMaterial(id, mid).ok, mid + ' can be applied through the material-only action');
    A.eq(st.roomById(id).floorStyle, 'cobalt', mid + ' never forces its suggested colour into the model');
    A.eq(JSON.stringify(st.roomById(id).floorPaint), paint, mid + ' preserves existing tile paint');
    A.eq(st.projectGeometry().matOf(id), mid, mid + ' reaches the renderer geometry');
    st.undo(); A.eq(st.matOfRoom(id), previous, mid + ' material selection undoes');
    st.redo(); A.eq(st.matOfRoom(id), mid, mid + ' material selection redoes');
    const restored = WM.deserialize(JSON.parse(JSON.stringify(st.serialize())));
    A.eq(restored.roomById(id).floorMat, mid, mid + ' persists as its explicit material ID');
    A.eq(restored.projectGeometry().matOf(id), mid, mid + ' remains the renderer material after reload');
    A.eq(JSON.stringify(restored.roomById(id).floorPaint), paint, mid + ' keeps tile paint after reload');
    const beforeDeck = JSON.stringify(restored.roomById(id));
    A.ok(restored.setDeck(id, { mat: mid, style: def.suggest }).ok, mid + ' accepts the surface picker deck action');
    A.eq(restored.roomById(id).floorStyle, def.suggest, mid + ' applies the explicitly selected hue');
    A.eq(restored.roomById(id).floorPaint, {}, mid + ' whole-deck action clears per-tile paint');
    restored.undo();
    A.eq(JSON.stringify(restored.roomById(id)), beforeDeck, mid + ' whole-deck action restores hue and paint in one undo');
    const placed = st.addRoom({ kind: 'lab', floorMat: mid, rect: { x1: 24, y1: 0, x2: 32, y2: 8 } });
    A.ok(placed.ok, mid + ' is accepted when placing a room');
    A.eq(st.projectGeometry().matOf(placed.id), mid, mid + ' survives new-room projection');
  }
  // Catalog extension must not reinterpret existing saves or inherited defaults.
  for (const mid of oldMaterials) {
    const doc = WM.defaultDoc(1), id = doc.meta.spawnRoomId;
    doc.rooms[id].floorMat = mid;
    const restored = WM.deserialize(JSON.parse(JSON.stringify(doc)));
    A.eq(restored.roomById(id).floorMat, mid, mid + ' existing saved ID is retained');
    A.eq(restored.matOfRoom(id), mid, mid + ' existing save keeps its effective material');
  }
  const defaults = { hab: 'spine', bridge: 'panel', lab: 'tile', factory: 'tread', quarters: 'soft', storage: 'tread', corridor: 'spine' };
  for (const [kind, mid] of Object.entries(defaults)) {
    const doc = WM.defaultDoc(1), id = doc.meta.spawnRoomId;
    doc.rooms[id].kind = kind; doc.rooms[id].floorMat = null;
    const restored = WM.deserialize(doc);
    A.eq(restored.matOfRoom(id), mid, kind + ' inherited deck stays unchanged');
    A.eq(restored.roomById(id).floorMat, null, kind + ' inherited deck is not rewritten as an override');
  }
}

A.report('worldmodel');
