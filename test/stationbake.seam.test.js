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

A.report('stationbake.seam');
