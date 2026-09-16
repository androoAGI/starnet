/* test/propanchor.test.js — headless tests for frontend/app/propanchor.js (pure
   anchor/seat derivation) + a regression guard that the prop CATALOG still carries
   the `use` descriptors the idle leisure behaviour depends on.

   deriveAnchor needs only a geo.walkable(x,y,extra), so the movement cases run
   against a synthetic geo (a blocked-tile Set) with no DOM / WorldModel / RNG. */
'use strict';
const A = require('./_assert.js');
const PA = require('../frontend/app/propanchor.js');

/* a geo that mimics projectGeometry's walkability: in-bounds, not a blocked tile,
   not in the caller's `extra` set. Prop footprints are pre-added to `blocked`
   (real geo blocks every blocking-prop footprint tile). */
function makeGeo(blocked, cols, rows) {
  return {
    COLS: cols, ROWS: rows,
    walkable(x, y, extra) {
      if (x < 0 || y < 0 || x >= cols || y >= rows) return false;
      const k = x + ',' + y;
      return !blocked.has(k) && !(extra && extra.has(k));
    }
  };
}
function footprint(prop) {
  const s = new Set();
  for (let yy = prop.y; yy < prop.y + (prop.h || 1); yy++)
    for (let xx = prop.x; xx < prop.x + (prop.w || 1); xx++) s.add(xx + ',' + yy);
  return s;
}
const adjacentToFootprint = (t, prop) => {
  // orthogonally adjacent to at least one footprint tile, and not inside the footprint
  for (let yy = prop.y; yy < prop.y + (prop.h || 1); yy++)
    for (let xx = prop.x; xx < prop.x + (prop.w || 1); xx++)
      if (Math.abs(t.tx - xx) + Math.abs(t.ty - yy) === 1) return true;
  return false;
};

/* ---- facingToward: an approach tile faces toward the prop centre ---- */
const couch = { x: 5, y: 5, w: 5, h: 1 };
A.eq(PA.facingToward(5, 6, couch), 'north', 'tile south of a prop faces north');
A.eq(PA.facingToward(5, 4, couch), 'south', 'tile north of a prop faces south');
const unit = { x: 5, y: 5, w: 1, h: 1 };
A.eq(PA.facingToward(6, 5, unit), 'west', 'tile east of a prop faces west');
A.eq(PA.facingToward(4, 5, unit), 'east', 'tile west of a prop faces east');

/* ---- sideTiles: correct perimeter rows/cols ---- */
A.eq(PA.sideTiles(couch, 'south').length, 5, 'south side of a 5-wide prop is 5 tiles');
A.eq(PA.sideTiles({ x: 5, y: 5, w: 1, h: 2 }, 'east').length, 2, 'east side of a 1x2 prop is 2 tiles');
A.eq(PA.sideTiles(unit, 'south')[0], { tx: 5, ty: 6 }, 'south tile sits one row below the footprint');

/* ---- deriveAnchor: south (front) preferred on open floor ---- */
{
  const g = makeGeo(footprint(couch), 40, 40);
  const a = PA.deriveAnchor(couch, g, { approach: 'south', sit: true });
  A.ok(a, 'open couch yields an anchor');
  A.eq(a.ty, 6, 'anchor is on the south (front) row');
  A.eq(a.face, 'north', 'agent faces north toward the couch');
  A.eq(a.sit, true, 'sit flag carried through');
  A.ok(g.walkable(a.tx, a.ty), 'anchor tile is genuinely walkable');
  A.ok(adjacentToFootprint(a, couch), 'anchor is orthogonally adjacent to the footprint');
}

/* ---- deriveAnchor: falls back to another side when the front is blocked ---- */
{
  const blocked = footprint(couch);
  for (const t of PA.sideTiles(couch, 'south')) blocked.add(t.tx + ',' + t.ty); // wall off the front
  const g = makeGeo(blocked, 40, 40);
  const a = PA.deriveAnchor(couch, g, { approach: 'south', sit: true });
  A.ok(a, 'still finds an anchor when the front is blocked');
  A.eq(a.ty, 4, 'falls back to the north (rear) row');
  A.eq(a.face, 'south', 'rear approach faces south toward the couch');
}

/* ---- deriveAnchor: null when fully walled in ---- */
{
  const blocked = new Set();
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) blocked.add(x + ',' + y); // everything blocked
  const g = makeGeo(blocked, 12, 12);
  A.eq(PA.deriveAnchor({ x: 5, y: 5, w: 1, h: 1 }, g, { approach: 'south' }), null, 'no reachable tile → null');
}

/* ---- deriveAnchor: honours the caller's `extra` blocked set ---- */
{
  const g = makeGeo(footprint(couch), 40, 40);
  const extra = new Set(PA.sideTiles(couch, 'south').map(t => t.tx + ',' + t.ty)); // e.g. the desk footprint
  const a = PA.deriveAnchor(couch, g, { approach: 'south', extra });
  A.ok(a, 'anchor still found with the front in `extra`');
  A.eq(a.ty, 4, 'extra-blocked front is skipped to the rear');
}

/* ---- deriveAnchor: off-grid sides are skipped (prop flush to the west edge) ---- */
{
  const edgeProp = { x: 0, y: 5, w: 1, h: 1 };
  const g = makeGeo(footprint(edgeProp), 40, 40);
  const a = PA.deriveAnchor(edgeProp, g, { approach: 'west' }); // west tile is x=-1 (off-grid)
  A.ok(a, 'flush-to-edge prop still yields an anchor from a valid side');
  A.ok(a.tx >= 0 && a.ty >= 0, 'anchor never lands off-grid');
  A.ok(g.walkable(a.tx, a.ty), 'edge anchor is walkable');
}

/* ---- 'auto' approach: tries south first, then the rest ---- */
{
  const g = makeGeo(footprint(couch), 40, 40);
  const a = PA.deriveAnchor(couch, g, { approach: 'auto' });
  A.eq(a.ty, 6, 'auto still prefers the south front when open');
}

/* ---- CATALOG regression: the lounge props the idle behaviour uses still carry `use` ---- */
global.U = global.U || { shade: c => c, hash: () => 0, clamp: (v, a, b) => (v < a ? a : v > b ? b : v), irnd: a => a };
const PropSprites = require('../frontend/app/propsprites.js');
const INTERACTIVE = ['couch', 'tv', 'arcade', 'arcade2', 'jukebox', 'bar'];
for (const id of INTERACTIVE) {
  const sp = PropSprites.spec(id);
  A.ok(sp && sp.use, 'catalog prop ' + id + ' carries a use descriptor');
  A.ok(sp.use && typeof sp.use.sit === 'boolean', id + '.use.sit is a boolean');
  A.ok(sp.use && typeof sp.use.approach === 'string', id + '.use.approach is a string');
  A.ok(sp.use && typeof sp.use.kind === 'string', id + '.use.kind is a string');
}
A.eq(PropSprites.spec('arcade').use.sit, false, 'arcade is stand-and-play (sit:false)');
/* SEAT LAW (2026-08-04): the sit sprite is a CHAIR pose, so `use.sit` may only be true where a seat is
   really under the body — the single-tile seats. Couch/bed/beanbag used to carry it and rendered a body
   parked bolt-upright on the furniture. This walks the WHOLE catalog so a future `sit: true` on some new
   sofa fails here rather than in the world.
   ⛔ NOT a list of everything a body sits on. The RECLINER pair (2026-08-17) is genuinely sat IN and is
      still false here, because this flag governs one route only — the generic PropAnchor path. A profile
      seat is couch-kind, so planCouchSit + world.js SIDE_SEAT own its anchor, facing and occlusion, and
      test/recliner-side-seat.test.js is what locks that. Flipping a recliner true would reopen exactly
      the bed/sofa route this law closed and change nothing on screen. */
const SITTABLE = new Set(['stool', 'chair', 'dinerchair', 'podchair']);   // 2026-08-17: two more 1x1 seats, same pose as chair
for (const sp of PropSprites.CATALOG) {
  if (!sp.use) continue;
  A.eq(!!sp.use.sit, SITTABLE.has(sp.id), 'SEAT LAW: ' + sp.id + '.use.sit === ' + SITTABLE.has(sp.id));
  if (SITTABLE.has(sp.id)) A.eq(sp.use.kind, 'seat', sp.id + ' uses kind:seat (planSeat claims + renders ON it)');
}
for (const id of SITTABLE) A.ok(PropSprites.spec(id) && PropSprites.spec(id).use, 'seat prop ' + id + ' still carries a use descriptor');
A.eq(PropSprites.spec('couch').use.sit, false, 'couch is stand-at (SEAT LAW)');
A.eq(PropSprites.spec('bunk').use.sit, false, 'bed is stand-beside (SEAT LAW — the reported bug)');
A.ok(!(PropSprites.spec('desk').use), 'work desk is NOT a leisure prop (no use descriptor)');
A.ok(!(PropSprites.spec('crate').use), 'storage crate is NOT a leisure prop');

for(const [r,face] of [[0,'south'],[1,'east'],[2,'north'],[3,'west']]){
  A.eq(PA.frontOf({r,m:true}),face,'mirrored facing '+r+' follows horizontal artwork flip');
}
A.report('propanchor.test');
