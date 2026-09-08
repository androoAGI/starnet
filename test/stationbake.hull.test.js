'use strict';

/* HULL materials — the exterior shell behind REFIT ▧ SURFACE → ▥ SHELL.

   Asserted through StationBake.sampleHull rather than a full bake(), for the same reason the deck
   and wall material tests are: the headless canvas mock collapses gradients and stubs source-in /
   destination-out, so a real bake's skirt comes out of it as garbage regardless of what the recipes
   painted. The recipe output itself is what these tests can actually see, and it is what the REFIT
   palette chips draw too.

   Default and legacy station shells inherit white; explicit paint remains authoritative. */

const A = require('./_assert.js');

global.U = {
  hash(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; },
  shade(hex, f) {
    const n = parseInt(String(hex).slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (f >= 0) { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
    else { r *= (1 + f); g *= (1 + f); b *= (1 + f); }
    return '#' + ((1 << 24) | (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)).toString(16).slice(1);
  }
};
global.document = { createElement() { throw new Error('sampleHull must not allocate canvases'); } };

const StationBake = require('../frontend/app/stationbake.js');
const WorldModel = require('../frontend/app/worldmodel.js');

const HULLS = WorldModel.HULL_ORDER;
const TILE = 12;

// a recording 2D context — every mark, in order, as comparable text. Richer than the deck
// recorder because a hull recipe clips its veins pass and translates into the skirt.
function recorder() {
  const st = { fillStyle: '', strokeStyle: '', lineWidth: 1, tx: 0, ty: 0 };
  const stack = [], ops = [];
  const c = {
    get fillStyle() { return st.fillStyle; }, set fillStyle(v) { st.fillStyle = v; },
    get strokeStyle() { return st.strokeStyle; }, set strokeStyle(v) { st.strokeStyle = v; },
    get lineWidth() { return st.lineWidth; }, set lineWidth(v) { st.lineWidth = v; },
    fillRect(x, y, w, h) { ops.push(['f', x + st.tx, y + st.ty, w, h, st.fillStyle]); },
    strokeRect(x, y, w, h) { ops.push(['s', x + st.tx, y + st.ty, w, h, st.strokeStyle]); },
    beginPath() {}, moveTo() {}, lineTo() {}, rect() {}, arc() {}, closePath() {}, fill() {}, clip() {},
    stroke() { ops.push(['k', 0, 0, 0, 0, st.strokeStyle]); },
    save() { stack.push({ ...st }); },
    restore() { if (stack.length) Object.assign(st, stack.pop()); },
    translate(x, y) { st.tx += x; st.ty += y; },
    ops
  };
  return c;
}
const sample = (mid, base, cols, h) => { const c = recorder(); StationBake.sampleHull(c, mid, base, cols || 4, h || 34, TILE); return c.ops; };
const sig = ops => ops.map(o => o.join(' ')).join('|');

/* ---------- the catalog is wired end to end ---------- */

A.ok(HULLS.length >= 8, 'the shell catalog offers a real spread of exteriors (' + HULLS.length + ')');
for (const mid of HULLS) {
  A.ok(!!WorldModel.HULL_MATERIALS[mid], mid + ' is in HULL_MATERIALS');
  A.ok(!!WorldModel.HULL_MATERIALS[mid].label, mid + ' carries a label for the palette');
}
A.eq(HULLS[0], 'station', 'STATION leads the catalog — it is the shell every station launches with');

/* ---------- every material paints, deterministically, and distinctly ---------- */

const sigs = {};
for (const mid of HULLS) {
  const base = '#3b2b20';
  const a = sample(mid, base);
  A.ok(a.length > 0, mid + ' paints marks');
  A.eq(sig(a), sig(sample(mid, base)), mid + ' is deterministic across repeated samples');
  sigs[mid] = sig(a);
}
for (let i = 0; i < HULLS.length; i++) {
  for (let j = i + 1; j < HULLS.length; j++) {
    A.ok(sigs[HULLS[i]] !== sigs[HULLS[j]], HULLS[i] + ' and ' + HULLS[j] + ' render as different shells');
  }
}
// a silent fallback to `station` is the failure mode a new material ships with (unknown id →
// dispatcher default), and on this axis it would look like the feature simply doing nothing.
A.eq(sig(sample('no-such-shell', '#3b2b20')), sigs.station, 'an unknown shell falls back to station');

/* Default and legacy shells use the ordinary white paint path. */

const chan = hex => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

const X = StationBake.HULL_EXPOSURE || 1;
A.eq(sig(sample('station', null, 6, 40)), sig(sample('station', WorldModel.FLOOR_STYLES.white.base, 6, 40)), 'unpainted shell renders exactly like WHITE');
A.eq(WorldModel.FLOOR_STYLES.hull.base, WorldModel.FLOOR_STYLES.white.base, 'saved HULL decks inherit white');
A.eq(WorldModel.FLOOR_STYLES.corridor.base, WorldModel.FLOOR_STYLES.white.base, 'saved DECKING inherits white');
// ...and the skirt FADES (2026-09-06): each stop of the ladder is read at its own exposure down the wall, foot
// first — the same six tones, the light on them falling off from the deck line into the void. The chip's skirt
// is the sampled height minus its plate ring (sampleHull's own split), so the ladder is asked at that height.
const skirtH = 40 - Math.max(6, Math.min(12, Math.round(40 * 0.38)));
const RX = StationBake.hullRampExposure ? StationBake.hullRampExposure(skirtH) : [X, X, X, X, X, X];
A.eq(RX.length, 6, 'the fade answers one exposure per ramp stop');
A.ok(RX.every((k, i) => i === 0 || k >= RX[i - 1] - 1e-9), 'the exposure never rises again on the way down the skirt');
A.ok(RX[0] < RX[5], 'the skirt actually fades — its foot is darker than its top (' + RX[0].toFixed(3) + ' → ' + RX[5].toFixed(3) + ')');
A.ok(Math.abs(RX[5] - X) < 0.05, 'the top of the skirt sits at the deck-line exposure (' + RX[5].toFixed(3) + ' vs ' + X + ')');
// ...and it is genuinely a skin: the same ladder in another colour, which the constants could not be
A.ok(sig(sample('station', null, 6, 40)) !== sig(sample('station', '#2b3340', 6, 40)),
  'a station shell painted COBALT differs from the untouched shell');
const white = sample('station', WorldModel.FLOOR_STYLES.white.base, 6, 40).map(o => o[5])
  .filter(c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c));
A.ok(Math.max(...white.map(c => { const [r, g, b] = chan(c); return 0.299 * r + 0.587 * g + 0.114 * b; })) > 100 * X,
  'STATION in WHITE really is a white hull — the pre-axis shell could only ever be one grey');

/* ---------- NOTHING OUTSIDE A ROOM IS PAINTED FROM A MODULE CONSTANT ----------
   The bug underneath the complaint: the wall pass filled the band between a wall's lit crown and
   the void with `wallDk`, and that band is `pad` wide by contract — exactly the hull plate. So it
   covered the plate, its dressing and its rim on the north, east and west, and a chosen skin
   survived only on the SOUTH skirt. Diffing an un-clad bake against a TIMBER one showed it exactly:
   4882 changed pixels, every one in the 47 rows at the bottom of the room, none anywhere else.
   A source lock, because the headless canvas mock cannot bake a station to measure it (see header).
   If a shell tone is ever needed outside a room again, take it from hullPal(z) — never a constant. */
const SRC = require('fs').readFileSync(require('path').join(__dirname, '..', 'frontend', 'app', 'stationbake.js'), 'utf8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
A.eq(code.indexOf('wallDk'), -1, 'the global shell tone `wallDk` is gone from the code entirely');
A.eq(code.indexOf('#28241b'), -1, 'the chamfer hull rim no longer hard-codes the pre-axis arc tone');
A.ok(/shellEdge/.test(code), 'the exterior band is painted from the room\'s own shell edge');

/* ---------- the VALUE BAND: an ordinary hue is clamped, the bright pole is not ----------
   The hull is the one surface outside the ambient mask, so a FLOOR_STYLES hue used at face value
   renders several times brighter out there than it does inside a room — that is what vacuum() exists
   to clamp. But the clamp must NOT swallow the palette's deliberate bright end: pick WHITE, get a
   white building. Both halves are asserted, because each one breaks the other if it drifts. */
const luma = hex => {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
};
const brightestOf = (mid, base) => Math.max(...sample(mid, base, 4, 40)
  .filter(o => o[0] === 'f' && typeof o[5] === 'string' && /^#[0-9a-f]{6}$/i.test(o[5]))
  .map(o => luma(o[5])));

A.ok(!!WorldModel.FLOOR_STYLES.white, 'WHITE is in the palette');
const ordinary = ['rust', 'cobalt', 'walnut', 'verdant'];
for (const sid of ordinary) {
  const peak = brightestOf('stucco', WorldModel.FLOOR_STYLES[sid].base);
  A.ok(peak > 75 && peak < 110, 'an ordinary hue (' + sid + ') is brighter but stays below white — peak ' + Math.round(peak));
}
for (const sid of ['white', 'bone']) {
  const peak = brightestOf('stucco', WorldModel.FLOOR_STYLES[sid].base);
  A.ok(peak > 110 * X, sid.toUpperCase() + ' actually renders bright on a shell — peak ' + Math.round(peak));
}
// ...and a white shell must still read as WHITE, not as a tint: near-neutral all the way up
{
  const cols = sample('stucco', WorldModel.FLOOR_STYLES.white.base, 4, 40)
    .filter(o => o[0] === 'f' && /^#[0-9a-f]{6}$/i.test(String(o[5]))).map(o => o[5]);
  const top = cols.reduce((a, c) => luma(c) > luma(a) ? c : a, cols[0]);
  const n = parseInt(top.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  A.ok(Math.max(...ch) - Math.min(...ch) < 24, 'a WHITE shell stays achromatic at its brightest (' + top + ')');
}

/* ---------- marks stay inside the patch they were asked for ---------- */

for (const mid of HULLS) {
  const W = 3 * TILE, H = 34;
  const bad = sample(mid, '#3b2b20', 3, H).filter(o => {
    if (o[0] !== 'f') return false;
    const [, x, y, w, h] = o;
    return x < 0 || y < 0 || x + w > W || y + h > H;
  });
  A.eq(bad.map(o => o.join(' ')), [], mid + ' paints nothing outside the sampled patch');
}

/* ---------- the skirt: a shell's whole identity, so it must actually be dressed ----------
   Every recipe's band list has to reach the bottom of the skirt and step upward from there. A list
   that never reaches `skirt` leaves raw plate hanging below the wall; one whose entries don't fall
   toward 1 leaves the top of the skirt unpainted. Both were live bugs while tuning courseBands. */
const RING = (h, ) => Math.max(6, Math.min(12, Math.round(h * 0.38)));
for (const mid of HULLS) {
  const h = 40, ring = RING(h);
  const skirtOps = sample(mid, '#3b2b20', 4, h).filter(o => o[0] === 'f' && o[2] >= ring);
  A.ok(skirtOps.length >= 4, mid + ' dresses its skirt (' + skirtOps.length + ' marks below the plate ring)');
  const reach = Math.max(...skirtOps.map(o => o[2] + o[4]));
  A.eq(reach, h, mid + ' skirt reaches the bottom of the wall (no bare plate hanging below it)');
  const tones = new Set(skirtOps.map(o => o[5]));
  A.ok(tones.size >= 3, mid + ' skirt has depth — at least three tones down the wall, not a flat slab');
}

/* ---------- the model side: the third axis behaves like the other two ---------- */

const st = WorldModel.create();
const room = st.addRoom({ kind: 'lab', rect: { x1: 22, y1: 0, x2: 35, y2: 9 } });
A.ok(room.ok, 'test room placed');
const R = room.id;

A.eq(st.hullMatOfRoom(R), 'station', 'a fresh room wears the station shell');
A.eq(st.projectGeometry().hullBaseOf(R), WorldModel.FLOOR_STYLES.white.base, '...at the default white finish');

A.ok(st.setHull(R, { mat: 'timber' }).ok, 'setHull clads a room in timber');
A.eq(st.hullMatOfRoom(R), 'timber', 'the material stuck');
A.eq(st.hullStyleOfRoom(R), 'walnut', 'and AUTO resolved to the tone TIMBER was drawn for');
A.eq(st.projectGeometry().hullMatOf(R), 'timber', 'projected geometry carries the material to the bake');
A.eq(st.projectGeometry().hullBaseOf(R), WorldModel.FLOOR_STYLES.walnut.base, '...and the hue');

// normalization: never serialize a redundant value, so an untouched doc round-trips unchanged
A.ok(st.setHull(R, { mat: 'timber', style: 'walnut' }).ok, 'picking the material’s own hue is accepted');
A.eq(st.doc().rooms[R].hullStyle, null, '...and normalizes to null rather than pinning the suggestion');
A.ok(st.setHull(R, { mat: 'station' }).ok, 'clading back to station is accepted');
A.eq(st.doc().rooms[R].hullMat, null, '...and normalizes to null, so the doc looks pre-axis again');

A.eq(st.setHull(R, { mat: 'no-such' }).error, 'BAD_MAT', 'an unknown shell material is rejected');
A.eq(st.setHull(R, { style: 'no-such' }).error, 'BAD_STYLE', 'an unknown shell colour is rejected');
A.eq(st.setHull('nope', { mat: 'brick' }).error, 'NOT_FOUND', 'an unknown room is rejected');

// one undo slot for both axes — the same contract setDeck/setWalls hold
const seq = st.canUndo();
A.ok(st.setHull(R, { mat: 'brick', style: 'crimson' }).ok, 'shell re-clad, hue and material together');
A.eq(st.hullMatOfRoom(R), 'brick', 'brick took');
A.ok(st.undo().ok !== false, 'undo runs');
A.eq(st.hullMatOfRoom(R), 'station', 'ONE undo reverses BOTH axes — never half a re-clad');
A.ok(seq === seq, 'undo availability unchanged in shape');

// a no-op must not burn an undo slot (the trap every mutator here has had at least once)
st.setHull(R, { mat: 'stone' });
const before = JSON.stringify(st.doc().rooms[R]);
A.ok(st.setHull(R, { mat: 'stone' }).ok, 'a repeat re-clad is accepted');
A.eq(JSON.stringify(st.doc().rooms[R]), before, '...and changes nothing');

/* a room's shell is ITS OWN — re-clading one may never touch its neighbour. This is the property
   that makes a mixed station read as separate buildings, and it is the one a grouped skirt could
   plausibly break. */
const other = st.addRoom({ kind: 'factory', rect: { x1: 0, y1: 14, x2: 15, y2: 22 } });
A.ok(other.ok, 'neighbour placed');
st.setHull(R, { mat: 'curtain' });
A.eq(st.hullMatOfRoom(other.id), 'station', 'the neighbour keeps its own shell');
A.eq(st.projectGeometry().hullMatOf(other.id), 'station', '...all the way through to the bake');

/* legacy docs: a room written before this axis carries no hull keys at all and must deserialize
   as the station shell rather than as an unknown material */
const legacyDoc = JSON.parse(JSON.stringify(st.doc()));
for (const id of legacyDoc.order) { delete legacyDoc.rooms[id].hullMat; delete legacyDoc.rooms[id].hullStyle; }
const revived = WorldModel.deserialize(legacyDoc);
for (const id of legacyDoc.order) {
  A.eq(revived.hullMatOfRoom(id), 'station', 'a pre-axis room revives wearing the station shell (' + id + ')');
  A.eq(revived.projectGeometry().hullBaseOf(id), WorldModel.FLOOR_STYLES.white.base, '...at the default white finish (' + id + ')');
}

/* ---------- TWO SKINS MAY NOT FIGHT OVER THE SAME SKIRT PIXEL ----------
   Andrew, 2026-08-06: "if you change multiple shells it will break the whole texture system and
   start glitching out other different separate room textures ... sometimes they half render."
   Cause: each hull group was composited with `destination-over`, so THE FIRST GROUP DRAWN won every
   contested pixel and the order was just where rooms sat in G.allRects. A footprint's plate reaches
   `pad` past its floor and its skirt hangs `skirt` further, so on a real station most rooms contend.
   A room's skirt therefore appeared only in the strip its neighbour had not already claimed and
   stopped dead at the boundary — and re-cladding ANY room moved rooms between groups and reshuffled
   the draw, which is why one change appeared to corrupt unrelated rooms.

   Ownership is geometry, not draw order: a skirt pixel belongs to the footprint DIRECTLY ABOVE it,
   the nearer one where two qualify. Proven by pixel diff in dev/shellglitch.mjs (chunk parity and
   incremental re-clad, both 0 across nine simultaneous skins) — a real canvas is required, which the
   headless mock cannot provide, so what is locked here is that the pass exists and that the
   ownership mask, not the composite order, is what separates the groups. */
const HULLSRC = require('fs').readFileSync(require('path').join(__dirname, '..', 'frontend', 'app', 'stationbake.js'), 'utf8');
A.ok(/nearest footprint above/i.test(HULLSRC), 'the skirt ownership pass is present');
A.ok(/destination-in/.test(HULLSRC.slice(HULLSRC.indexOf('function bakeHullExtrusion'))),
  'each hull group is cut back to the pixels it owns before compositing');

A.report('stationbake.hull');
