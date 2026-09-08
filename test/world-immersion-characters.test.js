/* Real sprite masters drive padding/stride measurements. Recording contexts exercise rendering
   geometry, state restoration and cache lifetimes; they do NOT pretend to rasterize Canvas blends
   or certify art quality. The integrated browser remains the proof for silhouette/color results. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const SpriteLoadPlan = require('../frontend/js/sprite-load-plan.js');

const frontend = path.join(__dirname, '..', 'frontend');
const source = fs.readFileSync(path.join(frontend, 'js', 'assets.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(frontend, 'assets', 'sprites', 'manifest.json'), 'utf8'));
const decoded = new Map();
const close = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-8, `${label}: ${a} vs ${b}`);

class RecordingContext {
  constructor(canvas) { this.canvas = canvas; this.reset(); }
  reset() {
    this.draws = []; this.ellipses = []; this.fills = []; this.gradients = [];
    this.globalAlpha = 1; this.fillStyle = '#000'; this.globalCompositeOperation = 'source-over';
    this.imageSmoothingEnabled = false; this.imageSmoothingQuality = 'low'; this.lost = false;
  }
  drawImage(image, ...args) {
    this.draws.push({ image, args, alpha: this.globalAlpha, composite: this.globalCompositeOperation,
      smoothing: this.imageSmoothingEnabled, quality: this.imageSmoothingQuality });
  }
  getImageData() {
    // Production readbacks here only measure a single untouched master, never a composited frame.
    const draw = this.draws.at(-1);
    assert.ok(draw && draw.image.pixels && draw.args.length === 2 && draw.args.every(v => v === 0),
      'foot/stride reads must come from an actual native PNG at the origin');
    return { data: draw.image.pixels };
  }
  createLinearGradient(...coords) {
    if (this.failGradient) throw new Error('offscreen context unavailable');
    const gradient = { coords, stops: [], addColorStop(at, color) { this.stops.push({ at, color }); } };
    this.gradients.push(gradient); return gradient;
  }
  fillRect(...args) { this.fills.push({ args, composite: this.globalCompositeOperation, style: this.fillStyle }); }
  beginPath() {}
  ellipse(...args) { this.ellipses.push({ args, alpha: this.globalAlpha, color: this.fillStyle }); }
  fill() {}
  getTransform() { return { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }; }
  isContextLost() { return this.lost; }
}
class RecordingCanvas {
  constructor() { this._width = this._height = 0; this.context = new RecordingContext(this); }
  set width(v) { this._width = v; this.context.reset(); }
  get width() { return this._width; }
  set height(v) { this._height = v; this.context.reset(); }
  get height() { return this._height; }
  getContext() { return this.context; }
}
async function harness() {
  const { decodePNG } = await import('../scripts/lib/png.mjs');
  class SpriteImage {
    set src(src) {
      this.path = src;
      try {
        if (!decoded.has(src)) decoded.set(src, decodePNG(fs.readFileSync(path.join(frontend, src))));
        const data = decoded.get(src);
        assert.equal(data.channels, 4, 'sprite master is RGBA');
        this.width = data.width; this.height = data.height; this.pixels = data.pixels;
        queueMicrotask(() => this.onload());
      } catch (error) { queueMicrotask(() => this.onerror(error)); }
    }
  }
  const canvases = [];
  const document = {
    failGradient: false,
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = new RecordingCanvas(); canvases.push(canvas);
      Object.defineProperty(canvas.context, 'failGradient', { get: () => document.failGradient });
      return canvas;
    }
  };
  const context = vm.createContext({
    DATA: { DEFAULT_SKIN: 'blank', SKINS: { blank: { set: 'blank', scale: 0.4 }, skeleton: { set: 'skeleton', scale: 0.4 } } },
    SpriteLoadPlan, document, Image: SpriteImage,
    fetch: async () => ({ ok: true, json: async () => manifest }),
    console: { log() {}, warn(...args) { throw new Error(args.join(' ')); } }
  });
  vm.runInContext(source + '\nglobalThis.testSprites = SPRITES;', context);
  const sprites = context.testSprites;
  await sprites.init(); await sprites.ensureSkin('blank'); await sprites.ensureSkin('skeleton');
  return { sprites, document, canvases };
}
function body(extra) {
  return { id: 'crew-1', skin: 'blank', px: 80.25, py: 70.25, dir: 'south', state: 'idle', aph: 1, ...extra };
}
function draw(sprites, b, time, appearance) {
  const ctx = new RecordingCanvas().getContext('2d');
  const geometry = sprites.drawBody(ctx, b, time, appearance);
  return { ctx, geometry, frame: ctx.draws.at(-1) };
}
function padFor(image) {
  for (let y = image.height - 1; y >= 0; y--) {
    for (let x = 0; x < image.width; x++) {
      if (image.pixels[(y * image.width + x) * 4 + 3] > 16) return image.height - 1 - y;
    }
  }
  throw new Error('empty production sprite');
}
const appearance = { light: { color: [96, 168, 240], strength: 0.5, dx: 1, dy: 0 } };

test('standing breath fixes the real measured foot line, keeps native masters and restores sampling state', async () => {
  const { sprites } = await harness();
  const b = body(); const frames = [1000, 2200, 4000].map(t => draw(sprites, b, t, {}).frame);
  const image = frames[0].image;
  assert.equal(image.width, 92); assert.equal(image.height, 92);
  const pad = padFor(image);
  for (const frame of frames) {
    const [x, y, w, h] = frame.args;
    close(w, 92 * 0.4, 'original width/scale');
    close(x, Math.round((b.px - w / 2) * 2) / 2, 'device-pixel x snap');
    close(y + h * (1 - pad / image.height), Math.round((b.py - 3) * 2) / 2, 'planted feet');
    assert.ok(Math.abs(h - 92 * 0.4) < 0.5, 'quiet breath cannot swell the silhouette');
    assert.equal(frame.smoothing, true); assert.equal(frame.quality, 'high');
  }
  assert.notEqual(frames[0].args[3], frames[1].args[3], 'standing has a subtle breath');
  const result = draw(sprites, body(), 1000, {});
  assert.equal(result.ctx.imageSmoothingEnabled, false); assert.equal(result.ctx.imageSmoothingQuality, 'low');
  close(result.geometry.h, result.frame.args[3], 'overlay height follows the rendered body');
  assert.equal(sprites.bodyAppearanceStats().builds, 0, 'unlit bodies allocate no appearance frames');
});

test('legacy calls and existing state tracks keep their motion, seat padding and distance phase', async () => {
  const { sprites } = await harness();
  const base = draw(sprites, body(), 1000);
  const [x, y, w, h] = base.frame.args;
  const pad = padFor(base.frame.image) * 0.4;
  close(y, Math.round((70.25 - h - 3 + Math.sin(1000 / 600 + 1) * 0.7 + pad) * 2) / 2,
    'three-argument idle geometry remains compatible');
  close(w, 36.8, 'master still drawn at established scale');
  assert.ok(Number.isFinite(x));
  for (const extra of [
    { state: 'walk', odo: 12, faceA: Math.PI / 2 },
    { working: true }, { sitting: true, seatLift: 8, skin: 'skeleton', dir: 'east' },
    { speaking: true }, { state: 'social', sitting: true, hasCan: true },
    { seated: true }, { sleeping: true }, { state: 'sleep' }, { noShadow: true },
    { glance: { until: 2000, dir: 'north' } }, { meet: { until: 2000 } },
    { _rA: 0, _rW: 0, _rAt: 900, _turnAng: 0 }
  ]) {
    const oldBody = body(extra), newBody = body(extra);
    const oldFrame = draw(sprites, oldBody, 1000).frame;
    const litFrame = draw(sprites, newBody, 1000, appearance).frame;
    assert.deepEqual(litFrame.args, oldFrame.args, JSON.stringify(extra) + ' keeps its geometry');
    assert.equal(newBody._pose, oldBody._pose, JSON.stringify(extra) + ' keeps its real track');
  }
  const walker = body({ state: 'walk', odo: 12, faceA: Math.PI / 2 });
  const start = draw(sprites, walker, 1000, {}).frame;
  const sameDistance = draw(sprites, walker, 1900, {}).frame;
  assert.equal(start.image, sameDistance.image, 'a wall-clock tick cannot invent a walking step');
  walker.odo += 6;
  assert.notEqual(draw(sprites, walker, 1900, {}).frame.image, start.image, 'real traveled distance advances the gait');
  const sitter = draw(sprites, body({ sitting: true, seatLift: 8, skin: 'skeleton', dir: 'east' }), 1000, {});
  const [sx, sy, sw, sh] = sitter.frame.args;
  close(sy, Math.round((70.25 - sh - 3 + padFor(sitter.frame.image) * 0.4 - 8) * 2) / 2,
    'raised seating uses the actual sitting track padding');
  assert.ok(Number.isFinite(sx + sw));
});

test('reduced motion freezes decorative breath/gesture/spill without inventing or freezing real work', async () => {
  const { sprites } = await harness();
  const b = body({ aph: 0 });
  const first = draw(sprites, b, 0, { reducedMotion: true });
  const second = draw(sprites, b, 600, { reducedMotion: true });
  assert.equal(b._pose, 'blank.rot.south');
  assert.deepEqual(first.frame.args, second.frame.args, 'idle has no bob or breath under reduced motion');
  const worker = body({ working: true });
  const work1 = draw(sprites, worker, 1000, { reducedMotion: true });
  const work2 = draw(sprites, worker, 1250, { reducedMotion: true });
  assert.equal(worker._pose, 'blank.type.north');
  assert.notEqual(work1.frame.image, work2.frame.image, 'working still follows its real typing track');
  assert.deepEqual(Object.keys(worker).filter(k => !Object.hasOwn(body({ working: true }), k)).sort(),
    ['_pose', '_rA', '_rAt', '_rD8', '_rW', '_turnAng'], 'only established render telemetry is added');
  const spill1 = draw(sprites, body({ id: 'ULTRON' }), 1000, { reducedMotion: true }).ctx.ellipses;
  const spill2 = draw(sprites, body({ id: 'ULTRON' }), 2200, { reducedMotion: true }).ctx.ellipses;
  assert.deepEqual(spill1, spill2, 'leader spill stops pulsing under reduced motion');
});

test('local lighting reuses native-size frames across agents and leaves the drawing context intact', async () => {
  const { sprites } = await harness();
  const ctx = new RecordingCanvas().getContext('2d');
  ctx.globalAlpha = 0.37; ctx.fillStyle = 'fuchsia'; ctx.globalCompositeOperation = 'destination-over';
  sprites.drawBody(ctx, body(), 1000, appearance);
  const first = ctx.draws.at(-1).image;
  assert.ok(first instanceof RecordingCanvas); assert.equal(first.width, 92); assert.equal(first.height, 92);
  assert.equal(sprites.bodyAppearanceStats().builds, 1);
  const second = draw(sprites, body({ id: 'another-crew' }), 1000, {
    light: { color: [97, 169, 239], strength: 0.501, dx: 100, dy: 0.01 }
  }).frame.image;
  assert.equal(second, first, 'small light changes and a different agent share the native frame');
  assert.equal(sprites.bodyAppearanceStats().builds, 1, 'cache fact: repeated draw made no new bitmap');
  assert.equal(ctx.globalAlpha, 0.37); assert.equal(ctx.fillStyle, 'fuchsia');
  assert.equal(ctx.globalCompositeOperation, 'destination-over');
  assert.equal(ctx.imageSmoothingEnabled, false); assert.equal(ctx.imageSmoothingQuality, 'low');
  assert.ok(ctx.ellipses[0].args[0] < 80.25, 'east light casts its body shadow west');
  const surface = first.getContext('2d');
  assert.ok(surface.fills.every(fill => fill.composite === 'source-atop'), 'light paint is clipped to the master alpha');
  assert.equal(surface.draws.at(-1).composite, 'source-atop', 'inner rim cannot paint outside the master silhouette');
  const west = draw(sprites, body(), 1000, { light: { ...appearance.light, dx: -1 } });
  assert.notEqual(west.frame.image, first, 'opposite source direction gets a distinct lighting frame');
  assert.ok(west.ctx.ellipses[0].args[0] > 80.25, 'west light casts its body shadow east');
  const sceneGrounding = draw(sprites, body(), 1000, { ...appearance, skipGroundShadow: true });
  assert.equal(sceneGrounding.ctx.ellipses.length, 0, 'scene grounding has one authoritative shadow pass');
  assert.equal(sceneGrounding.frame.image, first, 'scene grounding keeps the cached native lighting');
  assert.deepEqual(sceneGrounding.frame.args, ctx.draws.at(-1).args, 'skipping the shadow does not disable planted breathing');
  const leader = draw(sprites, body({ id: 'ULTRON' }), 1000, appearance);
  const groundedLeader = draw(sprites, body({ id: 'ULTRON' }), 1000, { ...appearance, skipGroundShadow: true });
  const authoredSpill = leader.ctx.ellipses.filter(ellipse => ellipse.color === '#ff4a3d');
  assert.ok(authoredSpill.length > 0, 'leader has its established emissive spill');
  assert.deepEqual(groundedLeader.ctx.ellipses, authoredSpill,
    'scene grounding skips native cast/contact shadows while preserving the complete authored spill');
  const portrait = draw(sprites, body({ id: 'ULTRON', noShadow: true }), 1000, { ...appearance, skipGroundShadow: true });
  assert.equal(portrait.ctx.ellipses.length, 0, 'off-floor portraits still suppress all ground cues');
});

test('appearance LRU bounds live bitmaps and rebuilds a lost context instead of keeping a blank body', async () => {
  const { sprites } = await harness();
  let first, latest, light;
  for (let i = 0; i < 150; i++) {
    light = { color: [(i % 11) * 24, (Math.floor(i / 11) % 11) * 24, Math.floor(i / 121) * 24], strength: 0.5, dx: 1, dy: 0 };
    latest = draw(sprites, body(), 1000, { light }).frame.image;
    if (!i) first = latest;
    assert.ok(sprites.bodyAppearanceStats().cachedFrames <= 128);
  }
  assert.equal(sprites.bodyAppearanceStats().cachedFrames, 128);
  assert.equal(sprites.bodyAppearanceStats().builds, 150);
  assert.equal(first.width, 1); assert.equal(first.height, 1, 'eviction releases the bitmap backing store');
  latest.context.lost = true;
  const rebuilt = draw(sprites, body(), 1000, { light }).frame.image;
  assert.notEqual(rebuilt, latest); assert.equal(rebuilt.width, 92);
  assert.equal(latest.width, 1); assert.equal(sprites.bodyAppearanceStats().cachedFrames, 128);
  assert.equal(sprites.bodyAppearanceStats().builds, 151);
});

test('missing/zero light and offscreen failures keep the original master visible', async () => {
  const { sprites, document } = await harness();
  const master = draw(sprites, body(), 1000, {}).frame.image;
  for (const light of [null, {}, { color: [90, 120, 150], strength: 0 }, { color: [1, 2], strength: 1 }]) {
    assert.equal(draw(sprites, body(), 1000, { light }).frame.image, master);
  }
  assert.equal(sprites.bodyAppearanceStats().builds, 0);
  document.failGradient = true;
  assert.equal(draw(sprites, body(), 1000, appearance).frame.image, master, 'failed appearance falls back to real art');
  assert.equal(sprites.bodyAppearanceStats().cachedFrames, 0, 'failed frames are never memoized as successful');
  document.failGradient = false;
  assert.notEqual(draw(sprites, body(), 1000, appearance).frame.image, master, 'a later healthy context recovers');
});
