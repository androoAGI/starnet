'use strict';

/* Deck MATERIALS (v4) — the per-tile floor recipes behind REFIT ▧ SURFACE.

   These assert the painters directly through StationBake.sampleMaterial rather than through a
   full bake(), on purpose: the bake's room-lighting pass fills over the whole footprint, and in
   a headless canvas mock a gradient fillStyle collapses to one value — which would hide every
   floor mark under it (see the note in stationbake.chunk.test.js).

   The property that actually matters is TILE LOCALITY: a tile's marks must depend only on that
   tile's own coordinates, never on the size or origin of the surface being painted. That is
   exactly what chunk↔monolithic pixel parity rests on, and a material that hashes per-PIXEL
   (grate, hex, turf) is where it would break first. */

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
global.document = { createElement() { throw new Error('sampleMaterial must not allocate canvases'); } };

const StationBake = require('../frontend/app/stationbake.js');
const MATS = ['plate', 'panel', 'tile', 'tread', 'soft', 'grate', 'hex', 'plank', 'turf', 'alloy'];
const TILE = 12;

// a recording 2D context: every mark the painters make, in order, as comparable text
function recorder() {
  const ops = [];
  const c = {
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    fillRect(x, y, w, h) { ops.push('f ' + [x, y, w, h, c.fillStyle].join(' ')); },
    strokeRect(x, y, w, h) { ops.push('s ' + [x, y, w, h, c.strokeStyle].join(' ')); },
    beginPath() { ops.push('bp'); },
    ellipse(x, y, rx, ry) { ops.push('e ' + [x, y, rx, ry, c.fillStyle].join(' ')); },
    fill() { ops.push('fill'); },
    ops
  };
  return c;
}
const sample = (mat, cols, rows) => { const c = recorder(); StationBake.sampleMaterial(c, mat, '#3b2b20', cols, rows, TILE); return c.ops; };

/* every material must paint something, deterministically */
const sigs = {};
for (const mat of MATS) {
  const a = sample(mat, 4, 4);
  A.ok(a.length > 0, mat + ' paints marks');
  A.eq(a.join('|'), sample(mat, 4, 4).join('|'), mat + ' is deterministic across repeated samples');
  sigs[mat] = a.join('|');
}

/* every material must be visually DISTINCT — a silent fallback to plate is the failure mode
   a new material is most likely to ship with (unknown id → dispatcher default). */
for (let i = 0; i < MATS.length; i++) {
  for (let j = i + 1; j < MATS.length; j++) {
    A.ok(sigs[MATS[i]] !== sigs[MATS[j]], MATS[i] + ' and ' + MATS[j] + ' render as different decks');
  }
}

/* TILE LOCALITY — the chunk-parity property. The marks landing inside tile (2,2) must be byte
   identical whether we painted a 4x4 patch or a 7x6 one. A painter that keyed anything on the
   surface size (or on its position within the surface) desyncs here. */
const inTile = (ops, tx, ty) => ops.filter(o => {
  const p = o.split(' ');
  if (p[0] !== 'f' && p[0] !== 's' && p[0] !== 'e') return false;
  const x = +p[1], y = +p[2];
  return x >= tx * TILE && x < (tx + 1) * TILE && y >= ty * TILE && y < (ty + 1) * TILE;
});
for (const mat of MATS) {
  A.eq(inTile(sample(mat, 4, 4), 2, 2).join('|'), inTile(sample(mat, 7, 6), 2, 2).join('|'),
    mat + ' tile (2,2) paints identically regardless of surface size (chunk-parity property)');
}

/* no material may bleed outside the patch it was asked to paint — hex clips half-cells at the
   tile edge by hand, so this is the guard on that arithmetic. */
for (const mat of MATS) {
  const bad = sample(mat, 3, 3).filter(o => {
    const p = o.split(' ');
    if (p[0] !== 'f') return false;
    const x = +p[1], y = +p[2], w = +p[3], h = +p[4];
    return x < 0 || y < 0 || x + w > 3 * TILE || y + h > 3 * TILE;
  });
  A.eq(bad, [], mat + ' paints nothing outside the sampled patch');
}

/* an unknown material falls back to plate rather than painting nothing (the dispatcher default) */
A.eq(sample('no-such-material', 4, 4).join('|'), sigs.plate, 'an unknown material falls back to plate');

/* ---------------- WALL materials ---------------- */

const WALLS = ['plating', 'ribbed', 'panelled', 'viewport', 'pipework', 'wainscot', 'hedge'];
const FACE_H = 23;   // WALL.up 14 + NFACE 9 — the shipped room face height
// the wall recipes also clear (viewport) — record that as a distinct op so a hole is comparable
function wallRecorder() {
  const c = recorder();
  c.clearRect = (x, y, w, h) => c.ops.push('c ' + [x, y, w, h].join(' '));
  return c;
}
const wallSample = (mat, cols, h) => { const c = wallRecorder(); StationBake.sampleWall(c, mat, '#2b3340', cols, h || FACE_H, TILE); return c.ops; };

const wsigs = {};
for (const mat of WALLS) {
  const a = wallSample(mat, 4);
  A.ok(a.length > 0, 'wall ' + mat + ' paints marks');
  A.eq(a.join('|'), wallSample(mat, 4).join('|'), 'wall ' + mat + ' is deterministic');
  wsigs[mat] = a.join('|');
}
for (let i = 0; i < WALLS.length; i++) {
  for (let j = i + 1; j < WALLS.length; j++) {
    A.ok(wsigs[WALLS[i]] !== wsigs[WALLS[j]], 'walls ' + WALLS[i] + ' and ' + WALLS[j] + ' render as different surfaces');
  }
}
A.eq(wallSample('no-such-wall', 4).join('|'), wsigs.plating, 'an unknown wall material falls back to plating');

/* VIEWPORT is the only recipe allowed to CUT the wall — that hole is the whole feature, and it
   must not appear in any other material (a stray clearRect would punch the station open). */
const cuts = mat => wallSample(mat, 4).filter(o => o.startsWith('c ')).length;
A.ok(cuts('viewport') > 0, 'viewport cuts glass out of the wall');
for (const mat of WALLS) if (mat !== 'viewport') A.eq(cuts(mat), 0, 'wall ' + mat + ' never cuts a hole in the station');

/* the shared foot: every recipe must seat itself on the floor line, or the wall floats */
for (const mat of WALLS) {
  const footRow = wallSample(mat, 4).filter(o => { const p = o.split(' '); return p[0] === 'f' && +p[2] === FACE_H - 1; });
  A.ok(footRow.length > 0, 'wall ' + mat + ' paints a contact shadow at the floor line');
}

/* wall marks stay inside the face — nothing may paint above the top (that's the crown's band,
   drawn by the common code) or below the floor line. */
for (const mat of WALLS) {
  const bad = wallSample(mat, 3).filter(o => {
    const p = o.split(' ');
    if (p[0] !== 'f' && p[0] !== 'c') return false;
    const x = +p[1], y = +p[2], w = +p[3], h = +p[4];
    return y < 0 || x < 0 || y + h > FACE_H || x + w > 3 * TILE;
  });
  A.eq(bad, [], 'wall ' + mat + ' paints only within its own face');
}

// New selectable decks keep their authored recipe in the compatibility renderer.
global.WorldSurface = require('../frontend/app/worldsurface.js');
for (const mat of ['basalt', 'parquet', 'rubber', 'slotted', 'terrazzo', 'octile']) {
  global.WorldRenderer = { enabled: () => true };
  const authored = sample(mat, 6, 4);
  global.WorldRenderer = { enabled: () => false };
  A.eq(sample(mat, 6, 4), authored, mat + ' picker keeps the same texture in the compatibility renderer');
  A.ok(authored.join('|') !== sample('plate', 6, 4).join('|'), mat + ' is not a generic plate fallback');
}
delete global.WorldRenderer;
delete global.WorldSurface;
A.report('stationbake.materials');
