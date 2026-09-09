/* Integer RGBA raster adapter exercises real canonical prop pixels and overlay
   composition. It is not a substitute for the integrated CRT/world visual check. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app/propsprites.js'), 'utf8');
const hash = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const color = value => {
  if (value.startsWith('#')) {
    let hex = value.slice(1); if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const n = parseInt(hex, 16); return [n >>> 16, (n >>> 8) & 255, n & 255, 1];
  }
  const channels = value.match(/[\d.]+/g).map(Number); return channels.length === 3 ? [...channels, 1] : channels;
};
const multiply = (a, b) => [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
class Canvas {
  constructor(env, width = 0, height = 0) { this.env = env; this.listeners = new Map(); this.width = width; this.height = height; }
  set width(w) { this._w = w; this.reset(); } get width() { return this._w; }
  set height(h) { this._h = h; this.reset(); } get height() { return this._h; }
  reset() { this.pixels = new Uint8ClampedArray((this._w || 0) * (this._h || 0) * 4); this.ctx = new Context(this); }
  getContext() { return this.ctx; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  lose(dispatch = true) { this.ctx.lost = true; if (dispatch && this.listeners.has('contextlost')) this.listeners.get('contextlost')(); }
}
class Context {
  constructor(canvas) {
    this.canvas = canvas; this.matrix = [1,0,0,1,0,0]; this.stack = []; this.draws = [];
    this.fillStyle = '#000000'; this.globalAlpha = 1; this.globalCompositeOperation = 'source-over'; this.imageSmoothingEnabled = true;
  }
  state() { return { matrix: this.matrix.slice(), fillStyle: this.fillStyle, globalAlpha: this.globalAlpha,
    globalCompositeOperation: this.globalCompositeOperation, imageSmoothingEnabled: this.imageSmoothingEnabled }; }
  save() { this.stack.push(this.state()); } restore() { Object.assign(this, this.stack.pop()); }
  transform(...m) { this.matrix = multiply(this.matrix, m); }
  translate(x, y) { this.transform(1,0,0,1,x,y); } scale(x, y) { this.transform(x,0,0,y,0,0); }
  setTransform(...m) { this.matrix = m; }
  blend(x, y, rgba) {
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return;
    const i = (y * this.canvas.width + x) * 4, out = this.canvas.pixels;
    const s = Math.max(0, Math.min(1, rgba[3] * this.globalAlpha)), d = out[i + 3] / 255;
    if (this.globalCompositeOperation === 'source-in') {
      for (let c = 0; c < 3; c++) out[i+c] = rgba[c]; out[i+3] = Math.round(s*d*255); return;
    }
    assert.equal(this.globalCompositeOperation, 'source-over', 'raster supports the actual blend modes used here');
    const a = s + d * (1-s); if (!a) return;
    for (let c = 0; c < 3; c++) out[i+c] = Math.round((rgba[c]*s + out[i+c]*d*(1-s)) / a);
    out[i+3] = Math.round(a*255);
  }
  fillRect(x, y, w, h) {
    if (!(w > 0 && h > 0)) return;
    const m = this.matrix, pt = (x,y) => [m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
    const points = [pt(x,y),pt(x+w,y),pt(x,y+h),pt(x+w,y+h)], xs = points.map(p=>p[0]), ys = points.map(p=>p[1]);
    const rgba = color(this.fillStyle);
    for (let yy = Math.max(0, Math.floor(Math.min(...ys))); yy < Math.min(this.canvas.height, Math.max(...ys)); yy++)
      for (let xx = Math.max(0, Math.floor(Math.min(...xs))); xx < Math.min(this.canvas.width, Math.max(...xs)); xx++) this.blend(xx, yy, rgba);
  }
  clearRect(x, y, w, h) {
    for (let yy = y; yy < y+h; yy++) for (let xx = x; xx < x+w; xx++) this.canvas.pixels.fill(0, (yy*this.canvas.width+xx)*4, (yy*this.canvas.width+xx)*4+4);
  }
  drawImage(image, x, y) {
    if (this.failDraw) throw Error('draw unavailable');
    this.draws.push({ image, x, y, state: this.state() });
    assert.equal(arguments.length, 3, 'light responses are native-size blits');
    const m = this.matrix;
    for (let yy = 0; yy < image.height; yy++) for (let xx = 0; xx < image.width; xx++) {
      const i = (yy*image.width+xx)*4;
      this.blend(Math.round(m[0]*(x+xx)+m[2]*(y+yy)+m[4]),Math.round(m[1]*(x+xx)+m[3]*(y+yy)+m[5]),[...image.pixels.slice(i,i+3),image.pixels[i+3]/255]);
    }
  }
  getImageData() {
    if (this.canvas.env.failRead) throw Error('readback unavailable');
    this.canvas.env.reads++; return { data: this.canvas.pixels.slice() };
  }
  createImageData(w, h) { return { data: new Uint8ClampedArray(w*h*4) }; }
  putImageData(image) { this.canvas.pixels.set(image.data); }
  isContextLost() { return !!this.lost; }
  beginPath() {} closePath() {} moveTo() {} lineTo() {} arc() {} ellipse() {} rect() {} fill() {} stroke() {} clip() {} fillText() {}
  measureText() { return { width: 0 }; }
  createLinearGradient() { return { addColorStop() {} }; }
}
function harness() {
  const env = { reads: 0, canvases: [] };
  const document = { createElement(tag) { assert.equal(tag, 'canvas'); const cv = new Canvas(env); env.canvases.push(cv); return cv; } };
  const context = vm.createContext({ module: { exports: {} }, document, console, U: { hash, shade: c => c } });
  vm.runInContext(source, context);
  const props = context.module.exports, target = new Canvas(env, 220, 180);
  props.setCtx(target.ctx); props.setNow(1400);
  return { props, target, env };
}
const f = extra => ({ t: 'crate', x: 5, y: 7, w: 2, h: 1, id: 'freight', ...extra });
const east = { color: [128,192,240], strength: .75, dx: 1, dy: 0 };

test('optional response paints inside the actual rigid prop without altering its draw or own hues', () => {
  const { props, target, env } = harness(), prop = f(), input = JSON.stringify(prop);
  props.draw(prop, false); const before = target.pixels.slice();
  const state = target.ctx.state();
  assert.equal(props.drawLightResponse(prop, east), true);
  assert.deepEqual(target.ctx.state(), state); assert.equal(JSON.stringify(prop), input);
  let changed = 0, maxDelta = 0;
  for (let i = 0; i < before.length; i += 4) {
    if (!before[i+3]) assert.equal(target.pixels[i+3], 0, 'response cannot grow art into empty pixels');
    assert.equal(target.pixels[i+3], before[i+3], 'overlay preserves actual native coverage');
    for (let c = 0; c < 3; c++) { const delta = Math.abs(target.pixels[i+c]-before[i+c]); if (delta) changed++; maxDelta = Math.max(maxDelta, delta); }
  }
  assert.ok(changed > 100, 'existing furniture visibly receives the supplied practical light');
  assert.ok(maxDelta <= 42, 'low-alpha treatment preserves authored local colour');
  assert.equal(env.reads, 1, 'one native-mask readback on a cold response');
  assert.equal(props.lightResponseStats().draws, 1);
});

test('direction changes the lit side and every bright edge stays one native pixel inside opaque casing', () => {
  const { props, target, env } = harness();
  props.drawLightResponse(f(), east); const right = target.ctx.draws.at(-1).image;
  const mask = env.canvases[0], alpha = mask.pixels, solid = (x,y) => x>=0&&y>=0&&x<mask.width&&y<mask.height&&alpha[(y*mask.width+x)*4+3]>=250;
  let bright = 0;
  for (let y = 0; y < right.height; y++) for (let x = 0; x < right.width; x++) {
    const a = right.pixels[(y*right.width+x)*4+3];
    if (!solid(x,y)) assert.equal(a, 0, 'translucent bloom/contact pixels receive no second halo');
    if (a > 32) { bright++; assert.equal(solid(x+1,y), false, 'bright rim is on the source-facing one-pixel edge'); }
    assert.ok(a <= 42, 'even the lit edge stays restrained');
  }
  assert.ok(bright > 0);
  props.drawLightResponse(f(), { ...east, dx: -1 }); const left = target.ctx.draws.at(-1).image;
  const energy = (cv, side) => {
    let sum = 0; for (let y=0;y<cv.height;y++) for (let x=0;x<cv.width;x++) if (side === (x >= cv.width/2)) {
      const i=(y*cv.width+x)*4; sum+=(cv.pixels[i]+cv.pixels[i+1]+cv.pixels[i+2])*cv.pixels[i+3];
    } return sum;
  };
  assert.ok(energy(right,true)>energy(left,true), 'east light brightens the east-facing furniture side');
  assert.ok(energy(left,false)>energy(right,false), 'west light brightens the west-facing furniture side');
});

test('quantized static responses reuse native overlays across instances, mount height and minor sample jitter', () => {
  const { props, target, env } = harness(); props.drawLightResponse(f(), east);
  const base = target.ctx.draws.at(-1), allocated = env.canvases.length;
  props.drawLightResponse(f({ x: -2, y: 4, mount: 'surface' }), { color: [130,190,241], strength: .76, dx: 1, dy: .01 });
  const mounted = target.ctx.draws.at(-1);
  assert.equal(mounted.image, base.image); assert.equal(env.canvases.length, allocated); assert.equal(env.reads, 1);
  assert.deepEqual([mounted.x,mounted.y], [-2*12-16,4*12-48-8], 'existing eight-pixel surface lift applied exactly once');
  assert.equal(mounted.state.imageSmoothingEnabled, false);
  assert.equal(props.lightResponseStats().hits, 1);
});

test('decals, dynamic silhouettes, missing samples and oversized footprints have zero response cost', () => {
  const { props, target, env } = harness();
  assert.equal(props.canLightResponse(f()), true);
  for (const t of ['rug','cablerun','hazardpad','outbox','bunk','holopet','unknown']) {
    assert.equal(props.canLightResponse(f({ t })), false, 'caller can skip sampling ' + t);
    assert.equal(props.drawLightResponse(f({ t }), east), false, t);
  }
  for (const light of [null, {}, { ...east, strength: 0 }, { ...east, strength: NaN }, { ...east, color: [NaN,2,3] }]) assert.equal(props.drawLightResponse(f(), light), false);
  for (const invalid of [{ w: 1000 }, { h: -1 }, { x: Infinity }, { w: 1.5 }]) assert.equal(props.drawLightResponse(f(invalid), east), false);
  assert.equal(env.canvases.length, 0); assert.equal(target.ctx.draws.length, 0); assert.equal(props.lightResponseStats().bytes, 0);
});

test('entry and pixel budgets evict old responses while steady repeats remain cached', () => {
  const { props } = harness();
  for (let i=0;i<130;i++) props.drawLightResponse(f(), { ...east, color: [(i%16)*16,Math.floor(i/16)*16,128] });
  let stats = props.lightResponseStats(); assert.ok(stats.evictions > 0); assert.ok(stats.entries <= stats.maxEntries); assert.ok(stats.pixels <= stats.maxPixels);
  assert.equal(stats.bytes, stats.pixels*4); assert.ok(stats.bytes <= stats.maxBytes);
  for (let i=0;i<12;i++) props.drawLightResponse(f({ w: 30, h: 3 }), { ...east, color: [i*16,64,128] });
  stats = props.lightResponseStats(); assert.ok(stats.pixels <= stats.maxPixels, 'large authored footprints obey the pixel budget too');
  const builds = stats.builds; props.drawLightResponse(f({ w: 30, h: 3 }), { ...east, color: [11*16,64,128] });
  assert.equal(props.lightResponseStats().builds, builds);
  props.invalidateLightResponse(); stats = props.lightResponseStats(); assert.equal(stats.entries, 0); assert.equal(stats.bytes, 0);
});

test('lost overlay and native mask contexts are rebuilt, and lost main context skips safely', () => {
  const { props, target, env } = harness(); props.drawLightResponse(f(), east);
  const first = target.ctx.draws.at(-1).image; first.lose();
  assert.equal(props.lightResponseStats().entries, 0); assert.equal(props.lightResponseStats().bytes, 0);
  assert.equal(props.drawLightResponse(f(), east), true); assert.notEqual(target.ctx.draws.at(-1).image, first);
  const second = target.ctx.draws.at(-1).image, mask = env.canvases[0]; mask.lose(false);
  assert.equal(props.drawLightResponse(f(), east), true); assert.notEqual(target.ctx.draws.at(-1).image, second);
  const builds = props.lightResponseStats().builds; target.lose();
  assert.equal(props.drawLightResponse(f(), east), false); assert.equal(props.lightResponseStats().builds, builds);
});

test('optional readback/blit failure never poisons the authoritative prop context or later draws', () => {
  const { props, target, env } = harness();
  const before = target.ctx.state(); env.failRead = true;
  assert.equal(props.drawLightResponse(f(), east), false); assert.deepEqual(target.ctx.state(), before);
  env.failRead = false; assert.equal(props.drawLightResponse(f(), east), true);
  target.ctx.failDraw = true; assert.equal(props.drawLightResponse(f(), east), false); assert.deepEqual(target.ctx.state(), before);
  target.ctx.failDraw = false; assert.doesNotThrow(() => props.draw(f(), true, { heat: .6, prog: .2 }));
  assert.equal(props.lightResponseStats().failures, 2);
});

test('cached silhouette lighting leaves real workstation heat and progress content live on every draw', () => {
  const { props, env } = harness(), desk = f({ t: 'desk' });
  const frame = (time, heat, prog) => {
    const cv = new Canvas(env, 220, 180); props.setCtx(cv.ctx); props.setNow(time);
    props.draw(desk, true, { heat, prog });
    assert.equal(props.drawLightResponse(desk, east), true);
    return cv;
  };
  const first = frame(400, .2, .25), builds = props.lightResponseStats().builds;
  const second = frame(1200, .8, .75);
  assert.equal(props.lightResponseStats().builds, builds, 'light cache does not become an animated-art cache');
  assert.notDeepEqual(first.pixels, second.pixels, 'real heat/progress still repaint the canonical desk');
  const i = ((desk.y*12-5)*second.width + desk.x*12+10)*4;
  assert.ok(second.pixels[i+1] > first.pixels[i+1], 'the newly published progress strip remains visibly current');
});
