'use strict';

const A = require('./_assert.js');
const Surface = require('../frontend/app/worldsurface.js');

// A small integer rasterizer, sufficient for these pixel-only painters. Comparing
// final pixels (rather than call strings) exercises clipping and chunk boundaries.
function canvas(w, h) {
  const cv = { _w: 0, _h: 0, pixels: new Uint32Array(0) };
  const resize = () => { cv.pixels = new Uint32Array(cv._w * cv._h); };
  Object.defineProperty(cv, 'width', { get: () => cv._w, set: v => { cv._w = Math.max(0, v | 0); resize(); } });
  Object.defineProperty(cv, 'height', { get: () => cv._h, set: v => { cv._h = Math.max(0, v | 0); resize(); } });
  let sx = 0, sy = 0; const stack = [], marks = [];
  const c = {
    fillStyle: '#000000', imageSmoothingEnabled: false,
    save() { stack.push([sx, sy]); }, restore() { [sx, sy] = stack.pop(); },
    translate(x, y) { sx += x; sy += y; },
    fillRect(x, y, rw, rh) {
      marks.push([x + sx, y + sy, rw, rh, c.fillStyle]);
      const color = (0xff000000 | parseInt(c.fillStyle.slice(1), 16)) >>> 0;
      for (let yy = Math.max(0, Math.floor(y + sy)); yy < Math.min(cv._h, y + sy + rh); yy++)
        for (let xx = Math.max(0, Math.floor(x + sx)); xx < Math.min(cv._w, x + sx + rw); xx++)
          cv.pixels[yy * cv._w + xx] = color;
    },
    marks
  };
  cv.width = w; cv.height = h; cv.getContext = () => c; return cv;
}
function tile(mat, tx = 0, ty = 0, opts) {
  const cv = canvas(12, 12);
  Surface.paintFloorTile(cv.getContext('2d'), mat, '#3a3b41', 0, 0, 12, tx, ty, opts);
  return cv;
}
function patch(mat) {
  const cv = canvas(72, 48), ctx = cv.getContext('2d');
  for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++)
    Surface.paintFloorTile(ctx, mat, '#3a3b41', x * 12, y * 12, 12, x - 3, y - 2);
  return cv;
}

const signatures = new Set();
for (const mat of Surface.MATERIALS) {
  const cv = patch(mat), sig = Array.from(cv.pixels).join(',');
  A.ok(cv.pixels.every(p => p !== 0), mat + ' covers every pixel without holes');
  A.eq(Array.from(patch(mat).pixels).join(','), sig, mat + ' repeat rendering is deterministic');
  A.ok(!signatures.has(sig), mat + ' has its own material recipe'); signatures.add(sig);
  const sample = tile(mat, -17, -9), marks = sample.getContext('2d').marks;
  A.ok(marks.every(([x, y, w, h]) => x >= 0 && y >= 0 && x + w <= 12 && y + h <= 12), mat + ' clips negative-coordinate artwork to its tile');
  const flat = tile(mat, 3, 2, { detail: 0 });
  A.eq(new Set(flat.pixels).size, 1, mat + ' respects the flat-material control');
}
A.eq(Array.from(tile('unknown').pixels), Array.from(tile('plate').pixels), 'unknown floors keep a painted fallback');

for (const size of [6, 12, 18, 24]) {
  for (const mat of Surface.MATERIALS) {
    const cv = canvas(size, size);
    Surface.paintFloorTile(cv.getContext('2d'), mat, '#e7e3d9', 0, 0, size, -4, 5);
    A.ok(cv.getContext('2d').marks.every(([x, y, w, h]) => [x, y, w, h].every(Number.isInteger) && x >= 0 && y >= 0 && x + w <= size && y + h <= size), mat + ' has bounded integer marks at scale ' + size);
  }
}

const wallSigs = new Set();
for (const mat of Surface.WALLS) {
  const cv = canvas(48, 39), c = cv.getContext('2d');
  for (let x = 0; x < 4; x++) A.ok(Surface.paintWallTile(c, mat, '#2b3340', x * 12, 0, 12, 39, x), mat + ' owns its wall-face recipe');
  A.ok(cv.pixels.every(p => p !== 0), mat + ' wall is solid');
  const sig = Array.from(cv.pixels).join(',');
  A.ok(!wallSigs.has(sig), mat + ' wall material is distinct'); wallSigs.add(sig);
  A.ok(c.marks.every(([x, y, w, h]) => x >= 0 && y >= 0 && x + w <= 48 && y + h <= 39), mat + ' never paints crown or deck pixels');
  A.eq(new Set(cv.pixels.slice(48 * 38)).size, 1, mat + ' continuous floor-contact row');
  const repeat = canvas(48, 39);
  for (let x = 0; x < 4; x++) Surface.paintWallTile(repeat.getContext('2d'), mat, '#2b3340', x * 12, 0, 12, 39, x + 4);
  A.eq(Array.from(repeat.pixels), Array.from(cv.pixels), mat + ' repeats at the geometry renderer face-strip boundary');
}
for (const mat of ['viewport', 'wainscot', 'hedge', 'unknown']) {
  const cv = canvas(12, 39);
  A.eq(Surface.paintWallTile(cv.getContext('2d'), mat, '#3a3b41', 0, 0, 12, 39, 0), false, mat + ' delegates its specialized geometry');
  A.eq(cv.getContext('2d').marks.length, 0, mat + ' fallback leaves pixels untouched');
}

// Two adjacent rooms with identical paint must be one visual deck. A sealed
// boundary must regain its contact trim, but cannot mutate the geometry itself.
function geometry(origin = { tx: -3, ty: -3 }) {
  const g = { TILE: 12, COLS: 12, ROWS: 10, W: 144, H: 120, origin,
    zoneGrid: Array(120).fill(null), idx: (x, y) => y * 12 + x,
    baseColorOf: (z, x) => x < 6 ? '#3a3b41' : '#2b3340',
    matOf: z => z === 'left' ? 'alloy' : 'hex', canStep: () => true };
  for (let y = 2; y < 8; y++) for (let x = 1; x < 11; x++) g.zoneGrid[g.idx(x, y)] = x < 6 ? 'left' : 'right';
  return g;
}
const g = geometry(), before = g.zoneGrid.slice(), full = Surface.bake(g, { canvasFactory: canvas });
A.eq(full.stats.tiles, 60, 'whole-geometry painter paints each occupied tile once');
A.eq(full.stats.materials, ['alloy', 'hex'], 'painted material inventory comes from the model');
A.eq(g.zoneGrid, before, 'rendering never mutates model tiles');
A.eq(Surface.edgeKind(g, 5, 4, 6, 4), 'open', 'adjacent connected rooms have no invented wall');
A.eq(Surface.edgeKind({ ...g, canStep: () => false }, 5, 4, 6, 4), 'wall', 'sealed rooms receive structural separation');
A.eq(Surface.edgeKind(g, 1, 2, 1, 1), 'wall', 'void edge receives perimeter treatment');
A.eq(Surface.edgeKind(g, 0, 0, 1, 0), 'void', 'empty tile never creates an edge');

// Non-tile-aligned chunks exercise the clipped tile at both ends. They must be
// exact crops of the complete floor, including trim and painted-colour changes.
for (const viewport of [{ x: 17, y: 19, w: 53, h: 47 }, { x: 63, y: 31, w: 77, h: 65 }]) {
  const part = Surface.bake(g, { canvasFactory: canvas, viewport }).baseCv;
  let equal = true;
  for (let y = 0; y < viewport.h; y++) for (let x = 0; x < viewport.w; x++)
    if (part.pixels[y * part.width + x] !== full.baseCv.pixels[(y + viewport.y) * full.W + x + viewport.x]) equal = false;
  A.ok(equal, 'chunk ' + viewport.x + ',' + viewport.y + ' exactly matches monolithic pixels');
}

const join = geometry(); join.matOf = () => 'alloy'; join.baseColorOf = () => '#3a3b41';
const split = Surface.bake(join, { canvasFactory: canvas }).baseCv;
const unified = { ...join, zoneGrid: join.zoneGrid.map(z => z == null ? null : 'one') };
A.eq(Array.from(Surface.bake(unified, { canvasFactory: canvas }).baseCv.pixels), Array.from(split.pixels), 'room IDs cannot draw a seam across a continuous material');

// Adding deck on the north or west shifts local coordinates. Physical pattern
// anchors ride origin: the existing floor must not slide beneath placed props.
for (const mat of Surface.MATERIALS) {
  const a = canvas(12, 12), b = canvas(12, 12);
  Surface.paintFloorTile(a.getContext('2d'), mat, '#3a3b41', 0, 0, 12, 7 + (-3), 8 + (-3));
  Surface.paintFloorTile(b.getContext('2d'), mat, '#3a3b41', 0, 0, 12, 12 + (-8), 11 + (-6));
  A.eq(Array.from(a.pixels), Array.from(b.pixels), mat + ' physical floor anchors survive a local-frame shift');
}

const luma = h => { const n = parseInt(h.slice(1), 16); return 0.2126 * (n >>> 16) + 0.7152 * ((n >>> 8) & 255) + 0.0722 * (n & 255); };
for (const base of ['#3a3b41', '#e7e3d9', '#0e0e12', '#402a1c']) {
  const p = Surface.palette(base);
  A.ok(luma(p.edge) > luma(p.field) && luma(p.field) > luma(p.recess) && luma(p.recess) > luma(p.deep), base + ' material ramp keeps highlights, field and recesses ordered');
}
Surface.invalidate();
A.eq(Array.from(patch('alloy').pixels), Array.from(patch('alloy').pixels), 'discarding color cache preserves deterministic artwork');

function fixtureGeometry(dx = 0, dy = 0) {
  const f = { TILE: 12, COLS: 30 + dx, ROWS: 16 + dy, W: (30 + dx) * 12, H: (16 + dy) * 12,
    origin: { tx: -9 - dx, ty: -7 - dy }, zoneGrid: Array((30 + dx) * (16 + dy)).fill(null),
    idx: (x, y) => y * (30 + dx) + x, wallMatOf: () => 'bulkhead', wallBaseOf: () => '#3a3b41',
    kindOf: z => z === 'right' ? 'lab' : 'hab', isCorridor: () => false,
    chamfers: [[2 + dx, 5 + dy, 'tl'], [25 + dx, 5 + dy, 'tr']] };
  for (let y = 5 + dy; y < 13 + dy; y++) for (let x = 2 + dx; x < 26 + dx; x++)
    f.zoneGrid[f.idx(x, y)] = x < 14 + dx ? 'left' : 'right';
  f.walkable = (x, y) => Surface.zoneAt(f, x, y) != null;
  f.canStep = (x, y, nx, ny) => Surface.zoneAt(f, x, y) != null && Surface.zoneAt(f, nx, ny) != null;
  return f;
}
const fg = fixtureGeometry(), fixtures = Surface.planFixtures(fg), oldGrid = fg.zoneGrid.slice();
A.ok(fixtures.length >= 3 && fixtures.length <= 4, 'long room faces get a restrained practical-fixture rhythm');
A.eq(Surface.planFixtures(fg), fixtures, 'fixture placement is deterministic');
A.eq(fg.zoneGrid, oldGrid, 'fixture planning never mutates station geometry');
for (const f of fixtures) {
  A.eq(Surface.zoneAt(fg, f.tileX, f.tileY - 1), null, 'fixture mount is a solid north face, never a door or open join');
  A.ok(!fg.chamfers.some(c => c[0] === f.tileX && c[1] === f.tileY), 'fixtures never overlap chamfer artwork');
  A.ok(fg.walkable(Math.floor(f.x / 12), Math.floor(f.y / 12)), 'fixture emission sample lands on clear deck');
  A.eq(Surface.zoneAt(fg, Math.floor(f.x / 12), Math.floor(f.y / 12)), f.zone, 'fixture light sample remains in its own room');
  A.ok(f.fixtureY < f.tileY * 12 && f.fixtureY > f.tileY * 12 - 30, 'fixture housing stands below the crown on the vertical face');
}
for (const z of ['left', 'right']) {
  const roomLights = fixtures.filter(f => f.zone === z);
  A.ok(roomLights.every((f, i) => !i || f.tileX - roomLights[i - 1].tileX >= 6), z + ' practical fixtures keep six-tile spacing');
}
A.eq(fixtures.find(f => f.zone === 'left').rgb, '255,222,179', 'hab housings emit warm white');
A.eq(fixtures.find(f => f.zone === 'right').rgb, '215,232,246', 'lab housings emit cool white');
for (const mat of ['viewport', 'hedge', 'wainscot', 'unknown'])
  A.eq(Surface.planFixtures({ ...fg, wallMatOf: () => mat }).length, 0, mat + ' receives no fixtures over specialized wall artwork');
A.eq(Surface.planFixtures(fg, { wallUp: 0 }).length, 0, 'flattened walls have no invented tall fixture mounts');
A.eq(Surface.planFixtures(fixtureGeometry(0, -2), { wallUp: 64 }).length, 0, 'cropped-off fixture hardware cannot emit an invisible practical light');
A.eq(Surface.planFixtures(fg, { maxFixtures: 2 }).length, 2, 'fixture count obeys the explicit budget');
A.eq(Surface.planFixtures(fg, { maxFixtures: 0 }).length, 0, 'zero fixture budget paints no hardware or source');
A.eq(Surface.planFixtures({ ...fg, walkable: () => false }).length, 0, 'inaccessible deck cannot receive a fake reachable emission source');

const painted = canvas(fg.W, fg.H), returned = Surface.paintFixtures(painted.getContext('2d'), fg);
A.eq(returned, fixtures, 'painted fixture records are the actual source-planner output');
for (const f of fixtures) {
  const emitter = painted.pixels[(f.fixtureY + 2) * fg.W + f.fixtureX];
  const rgb = f.rgb.split(',').map(Number), expected = (0xff000000 | rgb[0] << 16 | rgb[1] << 8 | rgb[2]) >>> 0;
  A.eq(emitter, expected, 'source color matches the visible fixture lens');
}
const viewport = { x: 123, y: 26, w: 76, h: 57 }, fixtureChunk = canvas(viewport.w, viewport.h), fc = fixtureChunk.getContext('2d');
fc.translate(-viewport.x, -viewport.y);
A.eq(Surface.paintFixtures(fc, fg, { viewport }), fixtures, 'chunk culling preserves offscreen sources that spill light into the chunk');
let fixtureParity = true;
for (let y = 0; y < viewport.h; y++) for (let x = 0; x < viewport.w; x++)
  if (fixtureChunk.pixels[y * viewport.w + x] !== painted.pixels[(y + viewport.y) * fg.W + x + viewport.x]) fixtureParity = false;
A.ok(fixtureParity, 'fixture hardware has exact chunk/monolithic pixel parity');

const physical = (f, origin) => ({ id: f.id, x: f.x + origin.tx * 12, y: f.y + origin.ty * 12,
  fixtureX: f.fixtureX + origin.tx * 12, fixtureY: f.fixtureY + origin.ty * 12 });
const grown = fixtureGeometry(5, 3);
A.eq(Surface.planFixtures(grown).map(f => physical(f, grown.origin)), fixtures.map(f => physical(f, fg.origin)), 'bounds expansion preserves physical lamps and their source anchors');

const openNorth = fixtureGeometry();
for (let x = 3; x < 14; x++) openNorth.zoneGrid[openNorth.idx(x, 4)] = 'above';
A.ok(Surface.planFixtures(openNorth).every(f => f.zone !== 'left'), 'a north opening cannot receive an invisible wall-mounted lamp');
const stacked = fixtureGeometry();
for (let x = 2; x < 26; x++) stacked.zoneGrid[stacked.idx(x, 3)] = 'upper-deck';
A.ok(Surface.planFixtures(stacked).every(f => f.zone === 'upper-deck'), 'late fixture painting never stamps hardware onto another stacked room deck');
const halls = fixtureGeometry(); halls.isCorridor = () => true;
A.eq(Surface.planFixtures(halls).length, 2, 'long hall faces get only one fixture per run');
const narrow = fixtureGeometry();
for (let y = 0; y < narrow.ROWS; y++) for (let x = 8; x < narrow.COLS; x++) narrow.zoneGrid[narrow.idx(x, y)] = null;
narrow.isCorridor = () => true;
A.eq(Surface.planFixtures(narrow).length, 0, 'short corridor mouths receive no extra light hardware');
A.report('worldsurface');
