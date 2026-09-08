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
A.eq(Light.lightAt(65, 30, [source], closed).strength, 0, 'sample is dark across a sealed wall');
A.ok(Light.lightAt(65, 30, [source], open).strength > 0, 'sample measures actual transmission through the door');
const shadow = Light.shadowFor({ x: 35, y: 30, width: 8, height: 20 }, [source], closed);
A.ok(shadow.dx > 0 && Math.abs(shadow.dy) < 0.001, 'ground shadow points away from the visible source');

// A Canvas command adapter checks invalidation and lifecycle, not raster appearance.
// Pixel and performance proof belongs to the integrated seeded app.
let allocations = 0;
function canvasFactory(w, h) {
  allocations++;
  const stack = [], context = {
    globalAlpha: 0.3, globalCompositeOperation: 'multiply', imageSmoothingEnabled: true,
    setTransform() {}, clearRect() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {},
    closePath() {}, fillRect() {}, fill() {}, drawImage() {},
    createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }),
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation, this.imageSmoothingEnabled]); },
    restore() { [this.globalAlpha, this.globalCompositeOperation, this.imageSmoothingEnabled] = stack.pop(); }
  };
  return { width: w, height: h, getContext: () => context };
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

A.report('WorldLight spatial illumination');
