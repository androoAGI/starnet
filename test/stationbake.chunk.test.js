'use strict';

const A = require('./_assert.js');

global.U = {
  hash(s) {
    let h = 2166136261;
    s = String(s);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  },
  shade(c) { return c; }
};

const canvases = [];
function styleHash(style) {
  if (style && typeof style === 'object' && style.__styleId) return style.__styleId;
  const s = String(style == null ? '' : style);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function fakeGradient(...args) {
  const stops = [];
  return {
    get __styleId() { return styleHash('gradient:' + args.join(',') + ':' + stops.join('|')); },
    addColorStop(off, color) { stops.push(off + '=' + color); }
  };
}
function makeCanvas() {
  const c = { _width: 0, _height: 0, _pixels: new Uint32Array(0), getContext() { return fakeCtx(c); } };
  Object.defineProperty(c, 'width', {
    get() { return c._width; },
    set(v) {
      c._width = Math.max(0, Math.floor(v || 0));
      c._pixels = new Uint32Array(c._width * c._height);
    }
  });
  Object.defineProperty(c, 'height', {
    get() { return c._height; },
    set(v) {
      c._height = Math.max(0, Math.floor(v || 0));
      c._pixels = new Uint32Array(c._width * c._height);
    }
  });
  return c;
}
function fakeCtx(canvas) {
  const state = {
    tx: 0, ty: 0, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '',
    textBaseline: '', globalCompositeOperation: 'source-over', imageSmoothingEnabled: false
  };
  const stack = [];
  const writeRect = (x, y, w, h, val) => {
    x = Math.floor(x + state.tx); y = Math.floor(y + state.ty);
    w = Math.ceil(w); h = Math.ceil(h);
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(canvas.width, x + w), y1 = Math.min(canvas.height, y + h);
    for (let yy = y0; yy < y1; yy++) {
      const off = yy * canvas.width;
      for (let xx = x0; xx < x1; xx++) canvas._pixels[off + xx] = val;
    }
  };
  const fillValue = () => state.globalCompositeOperation === 'destination-out' ? 0 : styleHash(state.fillStyle);
  const strokeValue = () => styleHash(state.strokeStyle);
  return {
    get fillStyle() { return state.fillStyle; }, set fillStyle(v) { state.fillStyle = v; },
    get strokeStyle() { return state.strokeStyle; }, set strokeStyle(v) { state.strokeStyle = v; },
    get lineWidth() { return state.lineWidth; }, set lineWidth(v) { state.lineWidth = v; },
    get font() { return state.font; }, set font(v) { state.font = v; },
    get textAlign() { return state.textAlign; }, set textAlign(v) { state.textAlign = v; },
    get textBaseline() { return state.textBaseline; }, set textBaseline(v) { state.textBaseline = v; },
    get globalCompositeOperation() { return state.globalCompositeOperation; }, set globalCompositeOperation(v) { state.globalCompositeOperation = v; },
    get imageSmoothingEnabled() { return state.imageSmoothingEnabled; }, set imageSmoothingEnabled(v) { state.imageSmoothingEnabled = v; },
    beginPath() {}, rect() {}, moveTo() {}, lineTo() {}, arc() {}, ellipse() {}, closePath() {},
    clip() {},
    save() { stack.push({ ...state }); },
    restore() { if (stack.length) Object.assign(state, stack.pop()); },
    translate(x, y) { state.tx += x; state.ty += y; },
    setTransform(a, b, c, d, e, f) { state.tx = e || 0; state.ty = f || 0; },
    fill() {},
    stroke() {},
    fillRect(x, y, w, h) { writeRect(x, y, w, h, fillValue()); },
    clearRect(x, y, w, h) { writeRect(x, y, w, h, 0); },
    strokeRect(x, y, w, h) {
      const v = strokeValue(), lw = Math.max(1, Math.ceil(state.lineWidth || 1));
      writeRect(x, y, w, lw, v); writeRect(x, y + h - lw, w, lw, v);
      writeRect(x, y, lw, h, v); writeRect(x + w - lw, y, lw, h, v);
    },
    drawImage(src, x, y) {
      x = Math.floor(x + state.tx); y = Math.floor(y + state.ty);
      for (let sy = 0; sy < src.height; sy++) {
        const dy = y + sy;
        if (dy < 0 || dy >= canvas.height) continue;
        for (let sx = 0; sx < src.width; sx++) {
          const dx = x + sx;
          if (dx < 0 || dx >= canvas.width) continue;
          const v = src._pixels[sy * src.width + sx];
          if (v || state.globalCompositeOperation !== 'destination-over') canvas._pixels[dy * canvas.width + dx] = v;
        }
      }
    },
    fillText(s, x, y) { writeRect(x, y - 7, Math.max(1, String(s || '').length * 4), 7, fillValue()); },
    measureText(s) { return { width: String(s || '').length * 7 }; },
    createRadialGradient: fakeGradient
  };
}
global.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error('unexpected element ' + tag);
    const c = makeCanvas();
    canvases.push(c);
    return c;
  }
};

const StationBake = require('../frontend/app/stationbake.js');

function composeLayer(baked, layer) {
  const c = document.createElement('canvas');
  c.width = baked.W; c.height = baked.H;
  const ctx = c.getContext('2d');
  if (layer === 'base') StationBake.drawBase(ctx, baked, 0, 0);
  else StationBake.drawLight(ctx, baked, 0, 0);
  return c;
}
function pixelDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let diff = 0;
  for (let i = 0; i < a._pixels.length; i++) if (a._pixels[i] !== b._pixels[i]) diff++;
  return diff;
}

function makeGeo() {
  const TILE = 12, COLS = 75, ROWS = 52;
  const zoneGrid = new Array(COLS * ROWS).fill(null);
  const idx = (x, y) => y * COLS + x;
  for (let y = 2; y <= 40; y++) for (let x = 2; x <= 60; x++) zoneGrid[idx(x, y)] = 'r1';
  return {
    TILE, COLS, ROWS, W: 900, H: 650, origin: { tx: 0, ty: 0 },
    allRects: [{ z: 'r1', x1: 2, y1: 2, x2: 60, y2: 40 }],
    zones: { r1: { x1: 2, y1: 2, x2: 60, y2: 40 } },
    ROOM_IDS: ['r1'], chamfers: [], windows: [], doorDefs: [], zoneGrid, idx,
    isCorridor: () => false,
    canStep: (x1, y1, x2, y2) => zoneGrid[idx(x1, y1)] === zoneGrid[idx(x2, y2)],
    baseColorOf: () => '#30343a',
    nameOf: () => 'HAB-01',
    kindOf: () => 'hab',
    FLOOR_STYLES: { hull: { base: '#30343a' } }
  };
}

// World II's architectural shade is a single coverage field, so adding the
// perpendicular wall cannot multiply several independent bands into black.
const shadeGeo = makeGeo(), shadeBefore = shadeGeo.zoneGrid.slice();
const shadeOptions = { edgeAO: 1, wallShadow: .5, cornerAO: .55, southFoot: 0, wallUp: 30, corUp: 30 };
const shadeEdge = (x, y, side, extra = {}) => ({ x, y, side, z: 'r1', room: true, ...extra });
const shadeEdges = [shadeEdge(31, 2, 'n'), shadeEdge(32, 2, 'n'), shadeEdge(33, 2, 'n'),
  shadeEdge(31, 2, 'w'), shadeEdge(33, 2, 'e')];
const shadeViewport = { x: 360, y: 20, w: 60, h: 44 };
const shade = (edges = shadeEdges, v = shadeViewport, opts = shadeOptions, g = shadeGeo) =>
  StationBake.wallFloorShadow(g, edges, v, opts);
const coverageAt = (field, x, y) => field.alpha[(y - field.y) * field.width + x - field.x];
const combinedShade = shade();
A.ok(combinedShade.alpha.some(a => a > 0), 'wall floor shade keeps real contact depth');
A.ok(Math.max(...combinedShade.alpha) <= 70, 'default corner coverage stays below 28 percent before the spatial light map');
A.eq(shade(shadeEdges.concat(shadeEdges)).alpha, combinedShade.alpha, 'duplicate wall feet do not multiply coverage');
A.eq(shade(shadeEdges.slice().reverse()).alpha, combinedShade.alpha, 'wall ordering does not change corner coverage');
const stressedShade = shade(shadeEdges, shadeViewport, { ...shadeOptions, edgeAO: 100, wallShadow: 100, cornerAO: 100 });
A.ok(Math.max(...stressedShade.alpha) <= 87, 'extreme depth controls still cannot exceed the architectural coverage cap');
const northOnly = shade([shadeEdge(32, 2, 'n')]);
const northProfile = Array.from({ length: 17 }, (_, y) => coverageAt(northOnly, 390, 33 + y));
A.ok(northProfile.every((a, i) => !i || a <= northProfile[i - 1]), 'north cast shade fades monotonically toward the deck');
A.ok(new Set(northProfile.filter(a => a > 0)).size > 8, 'north falloff resolves more than eight native pixel levels instead of four flat bands');
A.ok(northProfile.every((a, i) => !i || northProfile[i - 1] - a <= 8), 'adjacent falloff rows avoid abrupt broad band steps');
A.eq(northProfile.slice(14), [0, 0, 0], 'wall cast falloff ends cleanly at its shortened reach');
for (const v of [{ x: 379, y: 27, w: 39, h: 23 }, { x: 384, y: 33, w: 24, h: 17 }]) {
  const cropped = shade(shadeEdges, v);
  A.ok(cropped.alpha.every((a, i) => a === coverageAt(combinedShade, v.x + i % v.w, v.y + Math.floor(i / v.w))),
    'native shadow falloff is an exact crop across tile and 384px chunk boundaries at ' + v.x);
}
A.ok(shade(shadeEdges, shadeViewport, { ...shadeOptions, edgeAO: 0, wallShadow: 0, cornerAO: 0 }).alpha.every(a => a === 0),
  'turning off architectural depth controls leaves the floor untouched');
for (const excluded of [{ door: true }, { open: true }])
  A.ok(shade(shadeEdges.map(e => ({ ...e, ...excluded }))).alpha.every(a => a === 0), 'openings never acquire invented wall shade');
const roomBoundary = makeGeo();
for (let x = 31; x <= 33; x++) roomBoundary.zoneGrid[roomBoundary.idx(x, 3)] = x === 32 ? null : 'other-room';
const clippedShade = shade(shadeEdges, shadeViewport, shadeOptions, roomBoundary);
A.ok(Array.from({ length: 36 * 12 }, (_, i) => coverageAt(clippedShade, 372 + i % 36, 36 + Math.floor(i / 36))).every(a => a === 0),
  'falloff cannot enter void or another room even when the wall reaches beyond its tile');
const shiftedShadeGeo = { ...shadeGeo, origin: { tx: -4, ty: -6 }, zoneGrid: Array(shadeGeo.zoneGrid.length).fill(null) };
for (let y = 0; y < shadeGeo.ROWS - 6; y++) for (let x = 0; x < shadeGeo.COLS - 4; x++)
  shiftedShadeGeo.zoneGrid[shiftedShadeGeo.idx(x + 4, y + 6)] = shadeGeo.zoneGrid[shadeGeo.idx(x, y)];
A.eq(shade(shadeEdges.map(e => ({ ...e, x: e.x + 4, y: e.y + 6 })),
  { ...shadeViewport, x: shadeViewport.x + 48, y: shadeViewport.y + 72 }, shadeOptions, shiftedShadeGeo).alpha,
  combinedShade.alpha, 'signed-origin frame growth preserves physical shadow coverage');
A.eq(shadeGeo.zoneGrid, shadeBefore, 'shadow coverage cannot mutate geometry or its zone ownership');

// a chunk bake may allocate intermediates up to one skirt-margin taller than the chunk
// (the hull extrusion's silhouette canvases carry WALL.skirt+4 of vertical margin on each
// side so a footprint ending just outside the viewport still drops its skirt into it) —
// but never anything approaching full-world size.
const CHUNK_BOUND_H = StationBake.CHUNK_PX + 2 * (Math.round(StationBake.WALL.skirt) + 4);
const boundedCanvas = c => c.width <= StationBake.CHUNK_PX && c.height <= CHUNK_BOUND_H;

const geo = makeGeo();
canvases.length = 0;
const first = StationBake.bakeIncremental(geo, null, null);
A.ok(first.chunked, 'large bake uses the chunk cache');
A.eq(first.stats.chunkCount, 6, '900x650 bake splits into a 3x2 chunk grid');
A.eq(first.stats.rebakedChunks, 6, 'cold bake renders every chunk once');
A.ok(canvases.every(boundedCanvas),
  'chunk bake never allocates a full-world canvas');

const mono = StationBake.bake(geo);
A.eq(first.flickers.length, mono.flickers.length, 'chunked bake deduplicates flicker anchors to monolithic count');
A.eq(pixelDiff(composeLayer(first, 'base'), mono.baseCv), 0,
  'full chunk base composite matches the monolithic bake baseline');
A.eq(pixelDiff(composeLayer(first, 'light'), mono.lightCv), 0,
  'full chunk light composite matches the monolithic bake baseline');

const reusedBefore = new Map(first.chunkMap);
canvases.length = 0;
const second = StationBake.bakeIncremental(geo, first, [{ x1: 10, y1: 10, x2: 10, y2: 10 }]);
A.eq(second.stats.fullReset, false, 'same bounds/origin allow incremental reuse');
A.eq(second.stats.dirtyChunks, ['0,0'], 'single tile edit maps to the exact dirty chunk');
A.eq(second.stats.rebakedChunks, 1, 'single tile edit rebakes one chunk');
A.eq(second.stats.reusedChunks, 5, 'single tile edit reuses untouched chunks');
A.ok(second.chunkMap.get('1,0') === reusedBefore.get('1,0'), 'untouched chunk object is reused');
A.ok(canvases.every(boundedCanvas),
  'incremental rebake remains bounded to chunk-sized canvases');

const visible = StationBake.visibleChunks(first, { x: 384, y: 0, w: 384, h: 384 });
A.eq(visible.map(c => c.key), ['1,0'], 'visible chunk query returns only chunks intersecting the viewport');
A.eq(StationBake.missingVisibleChunks(first, { x: 384, y: 0, w: 384, h: 384 }), [],
  'complete cache reports no missing visible chunks');

const drawn = [];
const drawCtx = { drawImage(cv, x, y) { drawn.push({ cv, x, y }); } };
StationBake.drawBase(drawCtx, first, 0, 0, { x: 384, y: 0, w: 384, h: 384 });
A.eq(drawn.length, 1, 'drawBase culls chunked composites to the visible viewport');
A.eq(drawn[0].x, 384, 'drawBase preserves chunk world offset when culling');

const fullDrawn = [];
StationBake.drawBase({ drawImage(cv, x, y) { fullDrawn.push({ cv, x, y, w: cv.width, h: cv.height }); } }, first, 0, 0);
A.eq(fullDrawn.map(d => [d.x, d.y, d.w, d.h]), [
  [0, 0, 384, 384], [384, 0, 384, 384], [768, 0, 132, 384],
  [0, 384, 384, 266], [384, 384, 384, 266], [768, 384, 132, 266]
], 'full chunk composite covers the station without gaps, overlaps, or seam offsets');

canvases.length = 0;
const visibleCold = StationBake.bakeIncremental(geo, null, null, {
  visibleRect: { x: 384, y: 0, w: 384, h: 384 },
  maxRetainedChunks: 2
});
A.eq(visibleCold.stats.chunkCount, 1, 'cold visible bake renders only requested chunks');
A.eq(visibleCold.stats.dirtyChunks, ['1,0'], 'cold visible bake reports the rendered visible chunk');
A.eq(visibleCold.stats.evictedChunks, 0, 'cold visible bake does not evict when under the retention cap');
A.eq(StationBake.missingVisibleChunks(visibleCold, { x: 768, y: 0, w: 132, h: 384 }), ['2,0'],
  'visible-only cache reports newly exposed chunks after panning');
const panned = StationBake.bakeIncremental(geo, visibleCold, null, {
  visibleRect: { x: 768, y: 0, w: 132, h: 384 },
  maxRetainedChunks: 2,
  onlyMissingVisible: true
});
A.eq(panned.stats.dirtyChunks, [], 'pan-only visible fill does not dirty the whole station');
A.eq(panned.stats.rebakedChunks, 1, 'pan-only visible fill bakes only the newly exposed chunk');
A.ok(panned.chunkMap.has('2,0'), 'pan-only visible fill caches the newly exposed chunk');

const retained = StationBake.bakeIncremental(geo, first, [{ x1: 4, y1: 4, x2: 4, y2: 4 }], {
  visibleRect: { x: 384, y: 0, w: 384, h: 384 },
  maxRetainedChunks: 2
});
A.eq(retained.stats.chunkCount, 2, 'LRU retention bounds the cached chunk count');
A.ok(retained.chunkMap.has('0,0'), 'dirty chunk is retained even when outside the visible viewport');
A.ok(retained.chunkMap.has('1,0'), 'visible chunk is retained for the current frame');
A.ok(retained.stats.evictedChunks >= 4, 'LRU retention evicts older non-required chunks');

const shiftedGeo = makeGeo();
shiftedGeo.origin = { tx: 1, ty: 0 };
canvases.length = 0;
const reset = StationBake.bakeIncremental(shiftedGeo, first, [{ x1: 10, y1: 10, x2: 10, y2: 10 }], {
  visibleRect: { x: 0, y: 0, w: 384, h: 384 },
  maxRetainedChunks: 2
});
A.eq(reset.stats.fullReset, true, 'origin changes reset chunk metadata instead of reusing stale chunks');
A.eq(reset.stats.chunkCount, 1, 'origin reset can rebuild only the visible chunk');
A.ok(canvases.every(boundedCanvas),
  'origin reset does not allocate full-world base/light canvases');

/* Deck MATERIAL selection rides the same chunk path as everything above; the per-material
   pixel work is asserted in stationbake.materials.test.js instead. It can't be asserted HERE:
   this file's canvas mock resolves a gradient fillStyle to a single value, so the room-lighting
   pass flattens the whole footprint and every floor mark under it becomes invisible. */
const matGeo = mat => { const g = makeGeo(); g.matOf = () => mat; return g; };
for (const mat of ['grate', 'hex', 'plank', 'turf', 'alloy']) {
  const g = matGeo(mat);
  A.eq(pixelDiff(composeLayer(StationBake.bakeIncremental(g, null, null), 'base'), StationBake.bake(g).baseCv), 0,
    mat + ' deck bakes identically chunked and monolithic');
}

// Regression: growing either room axis must add distributed, weaker fixtures.
// Actual coverage is checked by dev/room-lighting-even-proof.mjs; this canvas
// mock cannot represent gradients.
for (const [w, h] of [[9, 7], [14, 9], [15, 14], [18, 18], [24, 16], [12, 24], [40, 30]]) {
  const g = makeGeo(), r = { z: 'r1', x1: 2, y1: 2, x2: w + 1, y2: h + 1 };
  g.allRects = [r]; g.zones.r1 = r; g.zoneGrid.fill(null);
  for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) g.zoneGrid[g.idx(x, y)] = 'r1';
  const lamps = StationBake.bake(g).lamps;
  const cols = Math.ceil(w / 8), rows = Math.ceil(h / 8);
  A.eq(lamps.length, cols * rows, w + 'x' + h + ' distributes fixtures on both axes');
  A.eq(new Set(lamps.map(l => l.x)).size, cols, w + 'x' + h + ' covers the full width');
  A.eq(new Set(lamps.map(l => l.y)).size, rows, w + 'x' + h + ' covers the full height');
  A.ok(lamps.every(l => l.gain > 0 && l.gain <= .25), w + 'x' + h + ' keeps fixture accents below the diffuse fill');

}

// Raised corner faces are part of the interior, including the portion above
// the footprint. The receiver must follow both corner shapes without lighting
// the crown or the void above it.
const savedUp = StationBake.WALL.up, savedN = StationBake.SHAPE.cornerN;
for (const n of [1, 2]) {
  StationBake.SHAPE.cornerN = n;
  const g = makeGeo(), r = {z:'r1',x1:4,y1:6,x2:18,y2:17};
  g.allRects=[r];g.zones.r1=r;g.zoneGrid.fill(null);
  for(let y=r.y1;y<=r.y2;y++)for(let x=r.x1;x<=r.x2;x++)g.zoneGrid[g.idx(x,y)]='r1';
  g.chamfers=[[r.x1,r.y1,'tl'],[r.x2,r.y1,'tr'],[r.x1,r.y2,'bl'],[r.x2,r.y2,'br']];
  for(const up of [14,30,50]) {
    StationBake.WALL.up=up;
    const b=StationBake.bake(g),mask=b.interiorCv;
    const y=r.y1*12-Math.min(10,up-10); // below the crown even on the shallow 14px wall
    for(const x of [r.x1*12+6,(r.x2+1)*12-6]) {
      A.ok(mask._pixels[y*mask.width+x]!==0,'corner '+n+' height '+up+' raised face receives light at '+x);
      A.eq(mask._pixels[(r.y1*12-up-10)*mask.width+x],0,'corner '+n+' height '+up+' leaves sky outside the receiver');
    }
    if(up===30) {
      const chunks=StationBake.bakeIncremental(g,null,null);
      A.eq(pixelDiff(composeLayer(chunks,'light'),b.lightCv),0,'corner '+n+' raised wall lighting matches across chunk and full bake');
    }
  }
}
StationBake.WALL.up=savedUp;StationBake.SHAPE.cornerN=savedN;
A.report('stationbake.chunk');
