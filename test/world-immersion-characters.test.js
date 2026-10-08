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
  save() {
    (this.states ||= []).push({ globalAlpha: this.globalAlpha, fillStyle: this.fillStyle,
      globalCompositeOperation: this.globalCompositeOperation, imageSmoothingEnabled: this.imageSmoothingEnabled,
      imageSmoothingQuality: this.imageSmoothingQuality });
  }
  restore() { Object.assign(this, this.states.pop()); }
  rect(...args) { (this.rects ||= []).push(args); }
  clip() { this.clipCount = (this.clipCount || 0) + 1; }
  beginPath() {}
  clearRect() { this.draws = []; }
  setTransform() {}
  ellipse(...args) { this.ellipses.push({ args, alpha: this.globalAlpha, color: this.fillStyle }); }
  fill() {}
  getTransform() { return { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }; }
  isContextLost() { return this.lost; }
}
class RecordingCanvas {
  constructor() { this._width = this._height = 0; this.context = new RecordingContext(this); this.on = {}; }
  addEventListener(name, fn) { (this.on[name] ||= []).push(fn); }
  emit(name) { for (const fn of this.on[name] || []) fn(); }
  set width(v) { this._width = v; this.context.reset(); }
  get width() { return this._width; }
  set height(v) { this._height = v; this.context.reset(); }
  get height() { return this._height; }
  getContext() { return this.context; }
}
async function harness(production = false) {
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
  if (production) {
    vm.runInContext(fs.readFileSync(path.join(frontend, 'app/data-shim.js'), 'utf8'), context);
    vm.runInContext('globalThis.catalog = DATA.SKINS;', context);
  }
  vm.runInContext(source + '\nglobalThis.testSprites = SPRITES;', context);
  const sprites = context.testSprites;
  await sprites.init(); await sprites.ensureSkin('blank'); await sprites.ensureSkin('skeleton');
  return { sprites, document, canvases, catalog: context.catalog };
}
function body(extra) {
  return { id: 'crew-1', skin: 'blank', px: 80.25, py: 70.25, dir: 'south', state: 'idle', aph: 1, ...extra };
}
function draw(sprites, b, time, appearance) {
  const ctx = new RecordingCanvas().getContext('2d');
  const geometry = sprites.drawBody(ctx, b, time, appearance);
  return { ctx, geometry, frame: ctx.draws.at(-1) };
}
function drawings(frame) {
  const inner = frame.image && frame.image.context && frame.image.context.draws;
  return inner ? inner.map(d => d.image.path + '@' + d.alpha.toFixed(3) + ':' + d.composite).join('|') : frame.image.path;
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

test('normal desktop roster renders the selected refresh without preview flags, with planted walking feet', async () => {
  const selected = JSON.parse(fs.readFileSync(path.join(frontend, 'assets/skin-study-0914/runtime-motion.json')));
  const { sprites, catalog } = await harness(true);
  assert.equal(Object.keys(catalog).length, 51);
  for (const skin of selected.skins) {
    assert.equal(catalog[skin.skin].set, skin.renderSet, skin.skin + ' keeps its saved ID');
    await sprites.ensureSkin(skin.skin);
    assert.equal(sprites.isSkinReady(skin.skin), true);
    const b = body({ skin: skin.skin, id: skin.skin === 'ultron' ? 'ULTRON' : skin.skin });
    assert.equal(sprites.setForBody(b), skin.renderSet);
    close(sprites.bodyScale(b), selected.standingHeight / skin.sourceStandingHeight, skin.skin + ' selected scale');
    for (const dir of ['south', 'east', 'north', 'west']) {
      const walking = body({ ...b, state: 'walk', dir });
      for (let i = 0; i < 16; i++) {
        const { frame } = draw(sprites, walking, i * 100, {});
        assert.ok(frame, skin.skin + ' real master drawn');
        assert.equal(walking._pose, skin.renderSet + '.walk.' + dir);
        // Selected masters meet the floor at a quarter-unit inset, within half a snapped pixel.
        assert.ok(Math.abs(walking._renderGroundGap - 0.25) <= 0.51, skin.skin + ' measured feet remain planted');
      }
    }
    for (const [key, frames] of Object.entries(selected.sprites).filter(([key]) => key.startsWith(skin.renderSet + '.'))) {
      assert.equal(manifest.sprites[key]?.length, frames.length, key + ' complete track');
      frames.forEach((frame, i) => assert.ok(
        fs.readFileSync(path.join(frontend, 'assets/sprites', frame)).equals(
          fs.readFileSync(path.join(frontend, 'assets/sprites', manifest.sprites[key][i]))), key + ' approved bytes/order'));
    }
  }
  assert.equal(catalog.minionchar, catalog.station_minion, 'retired duplicate remains readable in existing saves');
  assert.equal(sprites.setForBody(body({ skin: 'unknown' })), 'approved_android', 'unknown/default skin uses refresh');
});

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
  // signatures are taken at draw time: an in-between lives on one shared scratch canvas
  const start = drawings(draw(sprites, walker, 1000, {}).frame);
  const sameDistance = drawings(draw(sprites, walker, 1900, {}).frame);
  assert.equal(start, sameDistance, 'a wall-clock tick cannot invent a walking step');
  walker.odo += 6;
  assert.notEqual(drawings(draw(sprites, walker, 1900, {}).frame), start, 'real traveled distance advances the gait');
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
  const worker = body({ working: true, sitting: true, dir: 'north' });
  const work1 = draw(sprites, worker, 1000, { reducedMotion: true });
  const work2 = draw(sprites, worker, 1250, { reducedMotion: true });
  assert.equal(worker._pose, 'blank.type.north');
  assert.notEqual(work1.frame.image, work2.frame.image, 'working still follows its real typing track');
  assert.deepEqual(Object.keys(worker).filter(k => !Object.hasOwn(body({ working: true, sitting: true, dir: 'north' }), k)).sort(),
    ['_pose', '_poseLast', '_rA', '_rAt', '_rD8', '_rW', '_renderCycleUnits', '_renderFrame', '_renderGroundGap', '_renderPoseFade', '_renderSpeechAccent', '_renderStandingHeight', '_renderTravelError', '_renderWalkTween', '_speechAt', '_speechEase', '_turnAng'], 'only render telemetry and pose/speech interpolation state are added');
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

// a distinct quantized light per index (colour steps of 24 on three channels), so every index is its own cache pair;
// reduced motion holds one master (no blink), so a pair's identity is the light alone
const lightN = i => ({ reducedMotion: true, light: { color: [(i % 11) * 24, (Math.floor(i / 11) % 11) * 24, Math.floor(i / 121) * 24], strength: 0.5, dx: 1, dy: 0 } });

test('appearance cache: a walker\'s one-off frames recycle a bounded ring and allocate nothing (2026-10-07 lag)', async () => {
  const { sprites, canvases } = await harness();
  for (let i = 0; i < 300; i++) draw(sprites, body(), 1000 + i * 33, lightN(i));   // every draw a pair never asked for again
  const warm = canvases.length;
  for (let i = 300; i < 900; i++) draw(sprites, body(), 1000 + i * 33, lightN(i));
  const st = sprites.bodyAppearanceStats();
  assert.equal(st.builds, 900);
  assert.equal(st.kept, 0, 'a pair drawn once is never promoted');
  assert.ok(st.probation <= 96, 'probation is a bounded ring');
  assert.equal(canvases.length - warm, 0, 'once the ring is full, 600 more one-off builds allocate no canvas at all');
  assert.ok(st.recycled >= 600, 'recycled ' + st.recycled);
});

test('appearance cache: a frame still drawn after BODY_LIGHT_PROMOTE_MS is kept, and no walker churn evicts it', async () => {
  const { sprites } = await harness();
  const idle = lightN(500);
  const a = draw(sprites, body(), 20000, idle).frame.image;
  assert.equal(draw(sprites, body(), 20033, idle).frame.image, a, 'the next draw is served from probation');
  assert.equal(sprites.bodyAppearanceStats().kept, 0, '...without promoting a pair seen for 33ms');
  assert.equal(draw(sprites, body(), 20700, idle).frame.image, a, 'still drawn 700ms later: promoted, same bitmap');
  assert.equal(sprites.bodyAppearanceStats().kept, 1);
  for (let i = 0; i < 300; i++) draw(sprites, body(), 21000 + i * 33, lightN(i));
  assert.equal(draw(sprites, body(), 32000, idle).frame.image, a, 'a kept frame survives any amount of walker churn');
  assert.equal(sprites.bodyAppearanceStats().builds, 301, '...and was never rebuilt');
});

test('appearance cache: a GPU reset (restored, blank contexts) drops every cached frame so no body draws as nothing', async () => {
  const { sprites } = await harness();
  const idle = lightN(42);
  const a = draw(sprites, body(), 1000, idle).frame.image;
  draw(sprites, body(), 1700, idle);
  assert.equal(sprites.bodyAppearanceStats().kept, 1);
  a.emit('contextrestored');
  const st = sprites.bodyAppearanceStats();
  assert.equal(st.kept + st.probation, 0, 'both tiers are flushed');
  assert.equal(a.width, 1, 'the blank bitmap is released');
  const b = draw(sprites, body(), 1800, idle).frame.image;
  assert.notEqual(b, a); assert.equal(b.width, 92, 'the next draw rebuilds the lit frame');
  assert.equal(sprites.bodyAppearanceStats().builds, 2);
});

test('appearance cache: kept frames are bounded by pixels, release their bitmap on eviction, and a lost context rebuilds', async () => {
  const { sprites } = await harness();
  let first = null, latest = null;
  for (let i = 0; i < 600; i++) {
    draw(sprites, body(), 1000 + i * 1000, lightN(i));
    latest = draw(sprites, body(), 1000 + i * 1000 + 700, lightN(i)).frame.image;   // drawn again 700ms on: kept
    if (!i) first = latest;
    const st = sprites.bodyAppearanceStats();
    assert.ok(st.pixels <= st.pixelLimit, 'kept bitmaps stay inside the pixel budget');
  }
  const st = sprites.bodyAppearanceStats();
  assert.equal(st.kept, Math.floor(st.pixelLimit / (92 * 92)), 'the budget holds as many 92px frames as fit');
  assert.equal(st.builds, 600);
  assert.equal(first.width, 1); assert.equal(first.height, 1, 'eviction releases the bitmap backing store');
  latest.context.lost = true;
  const rebuilt = draw(sprites, body(), 900000, lightN(599)).frame.image;
  assert.notEqual(rebuilt, latest); assert.equal(rebuilt.width, 92);
  assert.equal(latest.width, 1, 'the lost bitmap is released, never redrawn blank');
  assert.equal(sprites.bodyAppearanceStats().builds, 601);
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


test('working bodies face their desk and unreachable workers stand on the floor', async () => {
  const { sprites } = await harness();
  for (const dir of ['north', 'south', 'east', 'west']) {
    const seated = body({ working: true, sitting: true, dir });
    draw(sprites, seated, 1000, {});
    assert.equal(seated._pose.split('.').at(-1), dir, 'seated work faces ' + dir);
    const standing = body({ working: true, sitting: false, dir });
    draw(sprites, standing, 1000, {});
    assert.equal(standing._pose, 'blank.rot.' + dir, 'unreachable worker stands facing ' + dir);
  }
});

test('a POSE change dissolves over ~110ms; a walk-cycle frame advance never does', async () => {
  const { sprites } = await harness();
  const b = body({ state: 'walk', dir: 'south', odo: 0, _resolvedTravelHeading: Math.PI / 2 });
  draw(sprites, b, 1000, {});
  b.odo = 6;
  const stride = draw(sprites, b, 1016, {});
  assert.equal(stride.ctx.draws.length, 1, 'a walk-cycle advance is one body draw, never a pose dissolve');
  b._resolvedTravelHeading = 0; b.dir = 'east';
  const turn = draw(sprites, b, 1032, {});
  assert.notEqual(b._pose, 'blank.walk.south', 'regression setup: the body really changed pose');
  assert.equal(turn.ctx.draws.length, 2, 'the outgoing pose is drawn beneath the incoming one');
  assert.equal(turn.ctx.draws[0].alpha, 1, 'the dissolve begins from the full outgoing pose (no pop to half-strength)');
  assert.equal(turn.ctx.draws[1].alpha, 1, 'the incoming pose is always drawn at full strength');
  assert.notEqual(turn.ctx.draws[0].image, turn.ctx.draws[1].image, 'the dissolve blends two different drawings');
  const mid = draw(sprites, b, 1032 + 60, {});
  assert.ok(mid.ctx.draws.length === 2 && mid.ctx.draws[0].alpha < turn.ctx.draws[0].alpha, 'the outgoing pose keeps fading');
  assert.equal(draw(sprites, b, 1032 + 130, {}).ctx.draws.length, 1, 'the dissolve ends and releases the old pose');
  const still = body({ state: 'walk', dir: 'south', odo: 0, _resolvedTravelHeading: Math.PI / 2 });
  draw(sprites, still, 1000, { reducedMotion: true });
  still._resolvedTravelHeading = 0; still.dir = 'east';
  assert.equal(draw(sprites, still, 1016, { reducedMotion: true }).ctx.draws.length, 1, 'reduced motion keeps the hard cut');
});

test('the walk cycle draws IN-BETWEENS: neighbouring drawings crossfade by the continuous stride phase', async () => {
  const { sprites } = await harness();
  const track = manifest.sprites['blank.walk.south'];
  const b = body({ state: 'walk', dir: 'south', odo: 0, aph: 1, _resolvedTravelHeading: Math.PI / 2 });
  draw(sprites, b, 1000, {});
  const stride = b._renderCycleUnits / track.length;
  const at = (odo, appearance) => { b.odo = odo; return draw(sprites, b, 1016, appearance || {}); };
  const onKey = at(2 * stride * (1 + 1e-9));           // phase 3.0: the authored drawing, crisp
  assert.ok(onKey.frame.image.path.endsWith(track[3]), 'on a key phase the authored drawing is drawn as-is');
  assert.equal(b._renderWalkTween, null);
  const mid = at(2.5 * stride);                       // phase 3.5: halfway from drawing 3 to drawing 4
  const inner = mid.frame.image.context.draws;
  assert.equal(inner.length, 2, 'an in-between composes exactly two drawings');
  assert.ok(inner[0].image.path.endsWith(track[3]) && inner[1].image.path.endsWith(track[4]), 'only NEIGHBOURING drawings of one cycle blend');
  assert.ok(Math.abs(inner[0].alpha + inner[1].alpha - 1) < 1e-9 && Math.abs(inner[1].alpha - 0.5) < 1e-6, 'weights follow the phase and sum to one');
  assert.equal(inner[1].composite, 'lighter', 'premultiplied sum, so the body never turns see-through mid-blend');
  assert.equal(mid.ctx.draws.length, 1, 'one body draw: no ghost pose layered under it');
  close(mid.frame.args[0], onKey.frame.args[0], 'an in-between never moves the body');
  const early = at(2.1 * stride).frame.image.context.draws;
  assert.ok(early[1].alpha < 0.05, 'eased: an authored drawing holds crisp around its own phase');
  const still = at(2.5 * stride, { reducedMotion: true });
  assert.ok(!still.frame.image.context, 'reduced motion keeps the hard cuts');
  b.state = 'idle'; b.odo = 2.5 * stride;
  assert.ok(!draw(sprites, b, 1016, {}).frame.image.context, 'standing poses never tween');
});
