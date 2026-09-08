'use strict';

const A = require('./_assert.js');
const Light = require('../frontend/app/worldlight.js');

// Two enclosed 3x3 rooms. Their common wall has one actual passable threshold;
// closing it models projectGeometry's sealed airlock (canStep is the authority).
function station(open) {
  const COLS = 8, ROWS = 5, zoneGrid = new Array(COLS * ROWS).fill(null);
  for (let y = 1; y <= 3; y++) for (let x = 1; x <= 6; x++) zoneGrid[y * COLS + x] = x <= 3 ? 'left' : 'right';
  return { COLS, ROWS, TILE: 12, W: 96, H: 60, zoneGrid,
    allRects: [{ x1: 1, y1: 1, x2: 6, y2: 3 }],
    canStep: (x, y, nx, ny) => zoneGrid[y * COLS + x] === zoneGrid[ny * COLS + nx] ||
      (open && y === 2 && ny === 2 && Math.abs(x - nx) === 1) };
}

const open = Light.buildSegments(station(true)), closed = Light.buildSegments(station(false));
const source = { x: 30, y: 30, r: 90, a: 0.8, c: [255, 190, 100] };
A.eq(open.length, 6, 'long exterior walls merge; only the two jambs split the common wall');
A.eq(closed.length, 5, 'closing the threshold produces one continuous internal wall');
A.ok(Light.visibleAt(source, 65, 30, open), 'light passes through the actual open threshold');
A.ok(!Light.visibleAt(source, 65, 30, closed), 'sealed airlock blocks the same sightline');
A.ok(!Light.visibleAt(source, 65, 13, open), 'wall blocks a ray that misses the doorway');
A.ok(!Light.visibleAt(source, 90, 30, open), 'light cannot escape the outer hull');
A.ok(Light.visibleAt(source, 35, 16, closed), 'light reaches its own room');
A.ok(!Light.visibleAt(source, 30, 140, []), 'finite reach applies without any walls');

const wall = { x1: 48, y1: 12, x2: 48, y2: 48 };
A.eq(Light.rayDistance(30, 30, 1, 0, wall), 18, 'ray hits the exact wall plane');
A.eq(Light.rayDistance(30, 30, -1, 0, wall), Infinity, 'a wall behind the source does not block the ray');
A.eq(Light.rayDistance(48, 5, 0, 1, wall), 7, 'a collinear ray cannot pass through a wall endpoint');
const polygon = Light.visibilityPolygon(source, closed, 64);
A.ok(polygon.length >= 64, 'visibility retains a smooth radial contour as well as corner rays');
A.ok(polygon.every(p => p.x <= 48 + 0.00001 && p.x >= 12 - 0.00001 && p.y >= 12 - 0.00001 && p.y <= 48 + 0.00001),
  'every polygon point stays inside the enclosed source room');
const angles = polygon.map(p => (Math.atan2(p.y - source.y, p.x - source.x) + Math.PI * 2) % (Math.PI * 2));
A.ok(angles.every((a, i) => i === 0 || a + 0.00001 >= angles[i - 1]), 'corner rays keep one winding with no wraparound self-intersection');

A.eq(Light.falloff(0), 1, 'source has full normalized intensity');
A.eq(Light.falloff(1), 0, 'light fades fully at its finite radius');
A.ok(Light.falloff(0.3) > Light.falloff(0.6), 'illumination falls with distance');
A.eq(Light.normalizeLight({ x: 0, y: 0, r: 10, c: [1, 2, 3], a: 0 }, false), null,
  'a source with no supplied energy stays off');
A.eq(Light.normalizeLight({ x: 0, y: 0, r: Infinity, c: [1, 2, 3], a: 1 }, false).r, 768,
  'oversized radii are bounded before allocation');
A.eq(Light.normalizeLight({ x: 'invalid', y: 0, r: 10 }, true), null, 'malformed positions never reach canvas');
const legacyFixture = Light.normalizeLight({ x: 30, y: 30, r: 110, rgb: '255,192,104', gain: 0.22 }, true);
A.eq(legacyFixture.a, 0.86, 'replacement restores room fixture energy formerly supplied by a separate diffuse pass');
A.eq(legacyFixture.r, 110, 'replacement preserves the bake radius and its existing two-axis coverage');
A.eq(Light.normalizeLight({ x: 30, y: 30, r: 110, gain: 0 }, true), null, 'zero fixture gain remains off');
A.eq(Light.normalizeLight({ x: 30, y: 30, r: 110, gain: 0.5 }, true).a, 0.43, 'nonlegacy fixture gains retain their intended relative strength');
A.eq(Light.normalizeLight({ x: 30, y: 30, r: 110, gain: 0.22, a: 0 }, true), null,
  'legacy gain compensation never revives an explicitly unlit source');
A.eq(Light.lightAt(65, 30, [source], closed).strength, 0, 'sample is dark across a sealed wall');
A.ok(Light.lightAt(65, 30, [source], open).strength > 0, 'sample measures actual transmission through the door');
const shadow = Light.shadowFor({ x: 35, y: 30, width: 8, height: 20 }, [source], closed);
A.ok(shadow.dx > 0 && Math.abs(shadow.dy) < 0.001, 'ground shadow points away from the visible source');

const northWalls = [{ x1: 0, y1: 36, x2: 200, y2: 36 }, { x1: 108, y1: 36, x2: 108, y2: 100 }];
const raised = { x: 102, y: 31.6, r: 26, c: [255, 220, 170], a: 0.22 };
A.ok(!Light.visibleAt(raised, 102, 51.6, northWalls), 'regression setup: raised visual source appears outside its room plane');
const mounted = Light.normalizeLight(Object.assign({}, raised, { originX: 102, originY: 42 }), false);
A.ok(Light.visibleAt(mounted, 102, 51.6, northWalls), 'a mounted north-wall lamp illuminates its own floor from its planar origin');
A.ok(!Light.visibleAt(mounted, 114, 42, northWalls), 'a mounted lamp still cannot illuminate through the adjacent wall');
A.eq(mounted.y, 31.6, 'floor-plane visibility preserves the visible emitter position');
A.ok(Math.abs(Light.lightAt(102, 51.6, [mounted], northWalls).strength - 0.22 * Light.falloff(20 / 26)) < 0.00001,
  'mounted lamp falloff remains centered on the visible emitter');
A.ok(Light.visibilityPolygon(mounted, northWalls, 64).every(p => p.y >= 36 - 0.00001 && p.x <= 108 + 0.00001),
  'mounted source visibility polygon respects wall planes while covering the visible falloff bounds');

// A Canvas command adapter checks invalidation and lifecycle, not raster appearance.
// Pixel and performance proof belongs to the integrated seeded app.
let allocations = 0;
const surfaces = [], draws = [];
function canvasFactory(w, h) {
  allocations++;
  const listeners = {}, stack = [], context = {
    globalAlpha: 0.3, globalCompositeOperation: 'multiply', imageSmoothingEnabled: true,
    lost: false, isContextLost() { return this.lost; },
    setTransform() {}, clearRect() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {},
    closePath() {}, fillRect() {}, fill() {}, drawImage(...args) { draws.push(args); },
    createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }),
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation, this.imageSmoothingEnabled]); },
    restore() { [this.globalAlpha, this.globalCompositeOperation, this.imageSmoothingEnabled] = stack.pop(); }
  };
  const canvas = { width: w, height: h, getContext: () => context,
    addEventListener(name, fn) { listeners[name] = fn; },
    removeEventListener(name, fn) { if (listeners[name] === fn) delete listeners[name]; },
    emit(name, event) { if (listeners[name]) listeners[name](event || {}); }, listeners };
  surfaces.push(canvas); return canvas;
}
const engine = Light.create({ canvasFactory }), output = canvasFactory(96, 60).getContext('2d');
engine.setGeometry(station(true));
const frame = { fixtures: [{ x: 30, y: 30, r: 50, rgb: '255,192,104' }], lights: [source], ambient: 0.82 };
A.ok(engine.render(output, frame), 'renderer accepts the station geometry and existing source shapes');
const first = engine.stats(), allocBefore = allocations;
engine.render(output, frame);
A.eq(engine.stats().staticBuilds, first.staticBuilds, 'steady fixtures reuse their composed map');
A.eq(engine.stats().dynamicBuilds, first.dynamicBuilds, 'steady prop lights reuse their composed map');
A.eq(allocations, allocBefore, 'a steady frame allocates no canvas surfaces');
A.eq(output.globalAlpha, 0.3, 'illumination restores the caller alpha');
A.eq(output.globalCompositeOperation, 'multiply', 'illumination restores the caller blend mode');

engine.render(output, Object.assign({}, frame, { lights: [Object.assign({}, source, { a: 0.5 })] }));
A.eq(engine.stats().visibilityBuilds, first.visibilityBuilds, 'emission changes reuse visibility and gradient stamps');
A.eq(engine.stats().dynamicBuilds, first.dynamicBuilds + 1, 'emission changes update the visible map');
engine.render(output, { lights: [], fixtures: [], ambient: 0.62 });
A.eq(engine.sample(30, 30).strength, 0, 'removed sources immediately disappear from the renderer state');
A.ok(Math.abs(engine.stats().ambient - 0.58) < 0.00001, 'high room brightness maps to the new readable exposure');
engine.render(output, { lights: [], fixtures: [], ambient: 0.82 });
A.ok(Math.abs(engine.stats().ambient - 0.70) < 0.00001, 'low room brightness remains darker without crushing to the old .82');

engine.setGeometry(station(false)); engine.render(output, { lights: [source] });
A.eq(engine.sample(65, 30).strength, 0, 'geometry invalidation closes light paths as soon as a door seals');
engine.configure({ quality: 'low' });
const huge = Object.assign(station(true), { W: 12000, H: 8000 });
engine.setGeometry(huge);
A.ok(engine.stats().resolution < 0.1, 'large worlds reduce map resolution to respect the pixel budget');
A.ok(engine.stats().cacheBytes <= 600000 * 16 + 100000, 'large-world map allocation stays bounded');
engine.dispose();
A.eq(engine.stats().sources, 0, 'dispose releases source state');
A.eq(engine.stats().cachedStamps, 0, 'dispose releases the light stamp cache');
A.eq(engine.render(output, frame), false, 'disposed engines do not draw');

const recovery = Light.create({ canvasFactory }); recovery.setGeometry(station(true));
const lostMap = surfaces[surfaces.length - 4]; recovery.render(output, frame);
let prevented = false;
lostMap.getContext('2d').lost = true;
lostMap.emit('contextlost', { preventDefault() { prevented = true; } });
A.ok(prevented, 'canvas context loss requests restoration rather than abandoning the renderer');
A.ok(recovery.render(output, frame), 'lost cached map is recreated and rendered from the same source state');
A.eq(recovery.stats().contextRecoveries, 1, 'resource recovery has a measured receipt');
A.eq(recovery.stats().geometryRevision, 2, 'resource recovery invalidates geometry-bound visibility and maps');
A.ok(recovery.sample(30, 30).strength > 0, 'sources survive recovery without a fabricated lighting transition');
A.eq(Object.keys(lostMap.listeners).length, 0, 'released maps detach their event handlers');
const lostStamp = surfaces[surfaces.length - 1]; lostStamp.getContext('2d').lost = true;
A.ok(recovery.render(output, frame), 'isContextLost catches a lost stamp even without a delivered event');
A.eq(recovery.stats().contextRecoveries, 2, 'silent stamp loss triggers another rebuild');
const restoredMap = surfaces[surfaces.length - 6]; restoredMap.emit('contextrestored');
recovery.render(output, frame);
A.eq(recovery.stats().contextRecoveries, 3, 'restoration invalidates cached pixels even when context reports healthy');
recovery.dispose();

const chunkEngine = Light.create({ canvasFactory }), chunkA = canvasFactory(48, 60), chunkB = canvasFactory(48, 60);
const floorA = canvasFactory(48, 60), floorB = canvasFactory(48, 60);
chunkEngine.setGeometry(station(true), { surfaceChunks: [
  { baseCv: chunkA, interiorCv: floorA, x: 0, y: 0, w: 48, h: 60 },
  { baseCv: chunkB, interiorCv: floorB, x: 48, y: 0, w: 48, h: 60 }
] });
const beforeChunk = draws.length;
A.ok(chunkEngine.render(output, frame), 'REFIT can illuminate chunked station geometry without a whole-station mask');
const chunkDraws = draws.slice(beforeChunk);
A.ok(chunkDraws.some(d => d[0] === chunkA && d[1] === 0) && chunkDraws.some(d => d[0] === chunkB && d[1] === 48),
  'architecture silhouette retains each chunk world offset');
A.ok(chunkDraws.some(d => d[0] === floorA) && chunkDraws.some(d => d[0] === floorB),
  'both exact curved floor masks contribute to the illumination union');
const chunkBuilds = chunkEngine.stats().visibilityBuilds;
chunkEngine.render(output, Object.assign({}, frame, { lights: [Object.assign({}, source, { originX: 31, originY: 30 })] }));
A.ok(chunkEngine.stats().visibilityBuilds > chunkBuilds, 'changing the planar origin invalidates a cached light polygon');
chunkEngine.dispose();

A.report('WorldLight spatial illumination');
