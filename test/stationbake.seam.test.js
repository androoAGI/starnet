'use strict';

/* THE SEAM LAW — a threshold is a HOLE IN A WALL (2026-08-05).

   worldmodel opens an auto-door at EVERY orthogonally adjacent tile pair of two different zones,
   so "this edge is a door" stopped meaning "this is a doorway" and started meaning "these two
   zones touch here". Four paint passes had been written against the old meaning and each drew its
   doorway dressing down the WHOLE shared boundary: the threshold track + lit lip, the deck's pale
   guide ticks, a gloss sheen dab, and a bright cut in the ambient mask. Two HAB rooms pushed
   together — same kind, same hue, same deck — got a bar at 98 luma painted down a 48-luma floor.

   The classifier below is what tells the two apart, and every one of those passes now consults it.
   These assertions are on `seamOpenJoins`, which IS that classifier — not a re-implementation — so
   the test cannot drift from the bake. The pixel consequence is verified live (dev/floorseam.mjs
   offscreen through the real StationBake, dev/floorseam-live.mjs on the real #stage canvas). */

const A = require('./_assert.js');

global.U = { hash: s => { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }, shade: c => c };
global.document = { createElement() { throw new Error('seamOpenJoins must not allocate canvases'); } };

const StationBake = require('../frontend/app/stationbake.js');

/*  x→   2        14 15      26 27    33
    y2  ┌──────────┬──────────┐ ╫┌──────┐     A|C abut with no wall on the line   -> OPEN JOIN
        │    A     │    C     │ ╫│  E   │     C|E is SEALED (canStep false)       -> WALL
    y9  └──┬───┬───┴──────────┘ ╫└──────┘     A|H is a 3-tile gap in A's south wall -> DOORWAY
    y10    │ H │
    y14    ├───┤                              H|B is a 3-tile gap in B's north wall -> DOORWAY
    y15 ┌──┴───┴──────────┐
    y22 └─────────────────┘  B                                                          */
const COLS = 40, ROWS = 30;
const zoneGrid = new Array(COLS * ROWS).fill(null);
const idx = (x, y) => y * COLS + x;
const fill = (z, x1, y1, x2, y2) => { for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) zoneGrid[idx(x, y)] = z; };
fill('A', 2, 2, 14, 9);
fill('C', 15, 2, 26, 9);
fill('E', 27, 2, 33, 9);
fill('H', 6, 10, 8, 14);
fill('B', 2, 15, 20, 22);

const SEALED = { C: 1, E: 1 };   // an airlock on E seals it: worldmodel emits no doors across C|E
const geo = {
  COLS, ROWS, idx, zoneGrid,
  canStep: (x1, y1, x2, y2) => {
    if (x2 < 0 || y2 < 0 || x2 >= COLS || y2 >= ROWS) return false;
    const za = zoneGrid[idx(x1, y1)], zb = zoneGrid[idx(x2, y2)];
    if (zb == null) return false;
    if (za === zb) return true;
    return !(SEALED[za] && SEALED[zb]);
  }
};

const open = new Set(StationBake.seamOpenJoins(geo));
const has = k => open.has(k);

/* 1. THE BUG ANDREW DREW A LINE DOWN. Two rooms abutting across their whole face: the seam line
      runs out into void at both ends, so there is no wall for an opening to be a hole in. */
for (let y = 2; y <= 9; y++) {
  A.ok(has('14,' + y + ',e'), 'A|C row ' + y + ' is an OPEN JOIN from A\'s side (no sill painted)');
  A.ok(has('15,' + y + ',w'), 'A|C row ' + y + ' is an OPEN JOIN from C\'s side (no sill painted)');
}

/* 2. A REAL DOORWAY KEEPS ITS SILL. The hallway mouths are 3-tile gaps punched through a room's
      wall — the wall continues past both jambs, so the threshold belongs there and must survive. */
for (let x = 6; x <= 8; x++) {
  A.ok(!has(x + ',9,s'), 'hallway TOP mouth col ' + x + ' stays a DOORWAY (A\'s south wall caps both jambs)');
  A.ok(!has(x + ',10,n'), 'hallway TOP mouth col ' + x + ' stays a DOORWAY from the corridor side');
  A.ok(!has(x + ',14,s'), 'hallway BOTTOM mouth col ' + x + ' stays a DOORWAY');
  A.ok(!has(x + ',15,n'), 'hallway BOTTOM mouth col ' + x + ' stays a DOORWAY from the room side');
}

/* 3. A SEALED seam is wall, not an open join — nothing passable, nothing to classify. */
for (let y = 2; y <= 9; y++) A.ok(!has('26,' + y + ',e'), 'sealed C|E row ' + y + ' is WALL, never an open join');

/* 4. NOTHING ELSE. Exactly the 8 rows of A|C, both sides — an over-eager classifier that swallowed
      the doorways too would still pass 1 and 3, and would silently delete every sill in the game. */
A.eq(open.size, 16, 'the A|C join is the ONLY open join in this station (8 tiles x 2 sides)');

/* 5. ANDREW'S OWN STATION — the geometry that broke the first version of this law, locked verbatim.
      "Capped by wall at both ends" was not enough: the corridor and the room below it sit side by
      side, so the seam under the top room is ONE contiguous 14-tile opening, and it happens to be
      walled at x0..2 and x17. Both ends capped -> the cap test alone called a room's entire face a
      doorway and dressed all 14 tiles, which is the exact line he circled. A doorway must also be
      SHORTER THAN THE WALL IT PIERCES: 14 tiles of gap against 4 of wall is not a door. */
{
  const M = 4, W = 26, H = 27;
  const zg = new Array(W * H).fill(null), ix = (x, y) => y * W + x;
  const put = (z, x1, y1, x2, y2) => { for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) zg[ix(x + M, y + M)] = z; };
  put('r1', 0, 0, 17, 10);      // HAB
  put('r8', 3, 11, 4, 18);      // CORRIDOR, flush against r9
  put('r9', 5, 11, 16, 18);     // HAB
  const real = { COLS: W, ROWS: H, idx: ix, zoneGrid: zg,
    canStep: (a, b, c, d) => (c >= 0 && d >= 0 && c < W && d < H && zg[ix(c, d)] != null) };
  const os = new Set(StationBake.seamOpenJoins(real));
  for (let x = 3; x <= 16; x++) {
    A.ok(os.has((x + M) + ',' + (10 + M) + ',s'), 'live station: seam col ' + x + ' under r1 BLENDS (14-tile gap vs 4 of wall is not a doorway)');
  }
}

/* 6. The classifier is pure: same geometry in, same answer out, and it allocates no canvas
      (global.document above throws if a paint pass ever leaks into this path). */
A.eq(StationBake.seamOpenJoins(geo).join('|'), StationBake.seamOpenJoins(geo).join('|'), 'seam classification is deterministic');


/* Architectural returns follow real exposed wall endpoints, including same-zone
   L/T/cross footprints. Labels, rectangle order and sill decoration are irrelevant. */
function joinGeo(rects, kinds = {}, sealed = []) {
  const COLS = 40, ROWS = 30, TILE = 12, idx = (x, y) => y * COLS + x;
  const zoneGrid = new Array(COLS * ROWS).fill(null), shut = new Set(sealed);
  for (const r of rects) for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) zoneGrid[idx(x, y)] = r.z;
  const at = (x, y) => x < 0 || y < 0 || x >= COLS || y >= ROWS ? null : zoneGrid[idx(x, y)];
  return { COLS, ROWS, TILE, idx, zoneGrid, allRects: rects, chamfers: [], isCorridor: z => kinds[z] === 'corridor',
    canStep: (x, y, nx, ny) => at(x,y) != null && at(nx,ny) != null &&
      (at(x,y) === at(nx,ny) || (!shut.has(at(x,y)) && !shut.has(at(nx,ny)))) };
}
const R = (z, x1, y1, x2, y2) => ({ z, x1, y1, x2, y2 });
const mouthsAt = (g, y) => StationBake.connectionPlan(g).mouths.filter(m => m.y === y);
for (const w of [2, 3, 4]) {
  const g = joinGeo([R('H',6,2,5+w,9), R('R',2,10,18,18)], {H:'corridor'});
  A.eq(mouthsAt(g,10), [{x1:6,x2:5+w,y:10,left:'R',right:'R'}], w+'-tile corridor has two exact room jambs');
}
const variants = [
  {name:'same-zone right L', rects:[R('H',6,2,8,9),R('H',6,10,16,12)], left:null,right:'H'},
  {name:'same-zone left L', rects:[R('H',6,2,8,9),R('H',2,10,8,12)], left:'H',right:null},
  {name:'same-zone T', rects:[R('H',6,2,8,9),R('H',2,10,16,12)], left:'H',right:'H'},
  {name:'same-zone cross', rects:[R('H',6,2,8,20),R('H',2,10,5,12),R('H',9,10,16,12)], left:'H',right:'H'},
  {name:'separate-zone T', rects:[R('H',6,2,8,9),R('B',2,10,16,12)], left:'B',right:'B'}
];
for (const v of variants) {
  const g = joinGeo(v.rects,{H:'corridor',B:'corridor'});
  A.eq(mouthsAt(g,10),[{x1:6,x2:8,y:10,left:v.left,right:v.right}],v.name+' returns only where an actual wall ends');
  A.eq(StationBake.connectionPlan(joinGeo([...v.rects].reverse(),{H:'corridor',B:'corridor'})),StationBake.connectionPlan(g),v.name+' is independent of footprint creation order');
}
const wide = joinGeo([R('A',2,2,16,9),R('B',2,10,18,18)]);
A.ok(new Set(StationBake.seamOpenJoins(wide)).has('16,10,n'),'wide partial join is classified open, not a doorway');
A.eq(mouthsAt(wide,10),[{x1:2,x2:16,y:10,left:null,right:'B'}],'wide partial join still turns its single real wall end');
A.eq(StationBake.connectionPlan(joinGeo([R('A',2,2,18,9),R('B',2,10,18,18)])).mouths,[],
  'fully aligned abutting rooms have no invented entrance frame');
A.eq(mouthsAt(joinGeo([R('H',6,2,8,9),R('R',2,10,18,18)],{H:'corridor'},['R']),10),[],
  'sealed room has no passable throat to repaint or expose');
const cross = joinGeo([R('H',6,2,8,20),R('L',2,10,5,12),R('R',9,10,16,12)],{H:'corridor',L:'corridor',R:'corridor'});
const paintAt = (rects, x, y) => rects.some(r => x >= r.x && y >= r.y && x < r.x+r.w && y < r.y+r.h);
const wire = StationBake.connectionPlan(cross).conduits;
for (let y=10*12;y<13*12;y++) A.ok(!paintAt(wire,6*12+2,y),'cross branch opening row '+y+' has no conduit pixel');
A.ok(paintAt(wire,6*12+2,9*12),'conduit stays on its wall before a branch');
A.ok(paintAt(wire,6*12+2,14*12),'conduit resumes on the same wall after a branch');
const aligned = joinGeo([R('A',6,2,8,9),R('B',6,10,8,20)],{A:'corridor',B:'corridor'});
const alignedWire=StationBake.connectionPlan(aligned).conduits;
for (let y=10*12-2;y<=10*12+2;y++) A.ok(paintAt(alignedWire,6*12+2,y),'aligned hallways keep continuous conduit through row '+y);
const noWall=joinGeo([R('H',6,2,8,20),R('A',2,2,5,20),R('B',9,2,16,20)],{H:'corridor'});
A.eq(StationBake.connectionPlan(noWall).conduits,[],'a corridor open on both sides cannot carry a floating cable');
// Nothing in the read-only decoration planner can change routing or room ownership.
const snapshot=JSON.stringify({grid:cross.zoneGrid,rects:cross.allRects});StationBake.connectionPlan(cross);
A.eq(JSON.stringify({grid:cross.zoneGrid,rects:cross.allRects}),snapshot,'connection dressing leaves saved/model geometry untouched');

A.report('stationbake.seam');
