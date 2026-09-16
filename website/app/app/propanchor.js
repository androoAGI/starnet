/* STARNET — propanchor.js : where an agent STANDS or SITS to use a prop.

   The gen prop model (worldmodel.js) stores props as pure rectangles; a blocking
   prop's whole footprint is unwalkable, so an agent can never path ONTO a couch/
   arcade/TV — only to an adjacent floor tile. This module derives that approach
   tile + the facing dir, porting v7's standNearFurn (agents.js): prefer the front
   (south) edge, then the other sides; the first walkable, non-blocked tile wins.

   PURE: depends on nothing but a `geo` exposing walkable(lx,ly,extra). No DOM, no
   time, no RNG — so it is unit-tested headlessly (test/propanchor.test.js). Both
   the live world (world.js, global PropAnchor) and Node tests (require) use it. */
'use strict';

const PropAnchor = (() => {

  /* facing dir from an approach tile INTO the prop — perpendicular to the edge the
     tile sits on (so a sitter at the front of a wide couch faces straight at it, not
     diagonally toward its far end). Tiles only ever come from sideTiles (edge-adjacent). */
  function facingToward(tx, ty, prop) {
    const x = prop.x, y = prop.y, w = prop.w || 1, h = prop.h || 1;
    if (ty >= y + h) return 'north';   // approaching from the south → face north into the prop
    if (ty < y) return 'south';        // from the north
    if (tx >= x + w) return 'west';    // from the east
    if (tx < x) return 'east';         // from the west
    return 'north';
  }

  /* the row/column of tiles immediately outside one edge of the footprint */
  function sideTiles(prop, side) {
    const x = prop.x, y = prop.y, w = prop.w || 1, h = prop.h || 1, out = [];
    if (side === 'south') for (let i = 0; i < w; i++) out.push({ tx: x + i, ty: y + h });
    else if (side === 'north') for (let i = 0; i < w; i++) out.push({ tx: x + i, ty: y - 1 });
    else if (side === 'east') for (let j = 0; j < h; j++) out.push({ tx: x + w, ty: y + j });
    else if (side === 'west') for (let j = 0; j < h; j++) out.push({ tx: x - 1, ty: y + j });
    return out;
  }

  const ORDER = ['south', 'north', 'east', 'west'];   // front, back, then the two flanks — in the UNTURNED frame

  /* ---- orientation: which way is this prop's FRONT? ----
     A prop carries `r` = quarter turns CLOCKWISE (worldmodel; 0 = the shipped south-facing art).
     Turning the prop turns the side an agent is meant to walk up to, so the approach order has to
     turn with it — otherwise an armchair aimed west would still be approached from the south and
     its user would stand at its flank. That is what makes rotation gameplay-real rather than a paint
     job. `m` (mirror) is deliberately ignored: a flip swaps handedness, never facing.
     One CW turn maps a side's outward normal (x,y) -> (-y,x): south(0,1)->west, west->north, etc. */
  const CW = { south: 'west', west: 'north', north: 'east', east: 'south' };
  function turnSide(side, r) {
    let s = side;
    for (let i = (r | 0) & 3; i > 0; i--) s = CW[s] || s;
    return s;
  }
  const frontOf = prop => {
    const face=turnSide('south',prop&&prop.r);
    return prop&&prop.m ? (face==='west'?'east':face==='east'?'west':face) : face;
  };

  /* CENTRE-OUT ordering of one edge's tiles. deriveAnchor used to take sideTiles' first walkable tile,
     which is always the WEST-most one — so on a 2-wide workstation the chair (and the body sitting in
     it) parked at the desk's far-left corner while the monitor and keyboard sit right of centre. An
     agent should approach the MIDDLE of a desk/couch/bar and fan outward only if the middle is blocked.
     Ties on an even-width prop break toward the higher index, so the pick sits just right of the centre
     line; world.js then nudges the render onto the true centre for even widths. */
  function centreOut(tiles) {
    const mid = (tiles.length - 1) / 2;
    return tiles
      .map((t, i) => ({ t: t, i: i }))
      .sort((a, b) => (Math.abs(a.i - mid) - Math.abs(b.i - mid)) || (b.i - a.i))
      .map(o => o.t);
  }

  /* deriveAnchor(prop, geo, opts) -> {tx,ty,face,sit} | null
       prop : { x, y, w, h, r? } in the geo's LOCAL tile frame (a geo.props entry)
       geo  : { walkable(lx,ly,extra) }
       opts : { approach:'south'|'north'|'east'|'west'|'auto'|'front', sit:bool, extra:Set }
     Returns the first walkable tile adjacent to the footprint (preferred side first),
     or null when the prop is walled in with no reachable approach tile.
     A named compass side is an ABSOLUTE world direction and is NOT turned; only the prop's own
     notion of "front" turns, and the fallback chain turns with it, so "then try the back, then the
     flanks" keeps meaning the same thing relative to the furniture. With r absent/0 every result
     here is identical to the pre-rotation behaviour. */
  function deriveAnchor(prop, geo, opts) {
    opts = opts || {};
    const extra = opts.extra || null, sit = !!opts.sit;
    const req = opts.approach || 'south';
    const approach = (req === 'front') ? frontOf(prop) : req;
    const turned = (prop && prop.r) ? ORDER.map(s => turnSide(s, prop.r)) : ORDER;
    const sides = approach === 'auto'
      ? turned.slice()
      : [approach].concat(turned.filter(s => s !== approach));
    for (const side of sides) {
      for (const t of centreOut(sideTiles(prop, side))) {
        if (geo.walkable(t.tx, t.ty, extra)) {
          return { tx: t.tx, ty: t.ty, face: facingToward(t.tx, t.ty, prop), sit };
        }
      }
    }
    return null;
  }

  return { deriveAnchor, facingToward, sideTiles, centreOut, frontOf, turnSide };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PropAnchor;
