'use strict';
// Exercise actual loader/renderer behavior, including a failed optional shell.
const fs = require('node:fs'), vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require.resolve('../frontend/app/industrialtextures.js'), 'utf8');
async function pack(missing = '', classic = false) {
  const draws = [];
  class Image {
    constructor() { this.width = this.height = 1254; }
    set src(value) { this.url = value; queueMicrotask(() => value.endsWith(missing + '.png') && missing ? this.onerror() : this.onload()); }
  }
  function canvas() {
    const cv = { width: 0, height: 0 };
    const g = { canvas: cv, save() {}, restore() {}, fillRect() {},
      drawImage(im, ...args) { draws.push({ im, args }); },
      getImageData() { return { data: new Uint8ClampedArray([60, 60, 60, 180, 120, 120, 120, 255]) }; },
      putImageData(data) { cv.tint = Array.from(data.data); },
      createLinearGradient() { return { addColorStop() {} }; }
    };
    cv.getContext = () => g; return cv;
  }
  const context = { Image, URLSearchParams, location: { search: classic ? '?textures=classic' : '' },
    document: { createElement: canvas, documentElement: { dataset: {} } }, module: { exports: {} } };
  vm.runInNewContext(source, context);
  const textures = context.module.exports;
  await textures.ready;
  return { textures, draws, ctx: canvas().getContext('2d') };
}
(async () => {
  const { textures: t, draws, ctx } = await pack();
  assert.equal(t.enabled(), true);
  const ids = ['monocoque', 'timber', 'clapboard', 'shingle', 'brick', 'stone', 'stucco', 'curtain', 'hedge', 'thermal', 'insulation', 'heatsink'];
  for (const id of ids) {
    assert.ok(t.status().assets.includes('shell-' + id), id + ' loads');
    assert.equal(t.shellPlate(ctx, 0, 0, 96, 96, id, '#403020'), true);
    assert.equal(t.shell(ctx, 3, 40, -17, -9, [0, 2, 5], id, '#403020'), true);
  }
  t.shellPlate(ctx, 0, 0, 96, 96, 'brick', '#603020');
  const red = draws.at(-1).im.tint;
  t.shellPlate(ctx, 0, 0, 96, 96, 'brick', '#203060');
  const blue = draws.at(-1).im.tint;
  assert.ok(red[0] > red[2] && blue[2] > blue[0], 'saved paint changes actual texture pixels');
  assert.ok(red[4] > red[0], 'authored relief survives tinting');
  assert.equal(red[3], 255, 'material alpha cannot punch holes in the hull');
  const cached = draws.at(-1).im;
  t.shellPlate(ctx, 0, 0, 96, 96, 'brick', '#203060');
  assert.equal(draws.at(-1).im, cached, 'repeated bakes reuse tinted material');
  assert.equal(t.shell(ctx, 1, 10, 0, 0, null, 'unknown'), false);
  const failed = await pack('shell-brick');
  assert.equal(failed.textures.enabled(), true, 'optional failure preserves main pack');
  assert.equal(failed.textures.shellPlate(failed.ctx, 0, 0, 96, 96, 'brick'), false);
  assert.equal(failed.textures.shellPlate(failed.ctx, 0, 0, 96, 96, 'timber'), true);
  for (const id of ['flightdeck', 'lunar', 'maggrid', 'habitat']) {
    assert.equal(t.floor(ctx, 0, 0, 12, -1, -2, id, '#603020'), true);
    const im = draws.at(-1).im;
    assert.ok(im.tint[0] > im.tint[2], id + ' follows paint hue');
    assert.equal(im.tint[3], 255);
    assert.equal(draws.at(-1).args[0], im.width * 7 / 8, 'negative floor X wraps');
    assert.equal(draws.at(-1).args[1], im.height * 6 / 8, 'negative floor Y wraps');
    const missing = await pack('floor-' + id);
    assert.equal(missing.textures.enabled(), true);
    assert.equal(missing.textures.floor(missing.ctx, 0, 0, 12, 0, 0, id), false);
  }
  for (const id of ['pressure', 'radiator', 'utility', 'acoustic']) {
    assert.equal(t.wall(ctx, 0, 0, 12, 30, -1, id, '#203060'), true);
    const im = draws.at(-1).im;
    assert.ok(im.tint[2] > im.tint[0], id + ' follows paint hue');
    const strip = t.wallStrip(30, id, '#203060');
    assert.equal(draws.at(-1).im, im, 'straight and corner faces use identical artwork');
    assert.equal(t.wallStrip(30, id, '#203060'), strip, 'strip cache is reusable');
    assert.notEqual(t.wallStrip(30, id, '#603020'), strip, 'paint owns a separate strip');
    const missing = await pack('wall-' + id);
    assert.equal(missing.textures.enabled(), true);
    assert.equal(missing.textures.wall(missing.ctx, 0, 0, 12, 30, 0, id), false);
    assert.equal(missing.textures.wallStrip(30, id), null);
  }
  assert.equal(t.wall(ctx, 0, 0, 12, 30, 0, 'viewport'), false, 'windows remain geometry-owned');
  assert.equal(t.wallStrip(30, 'viewport'), null);
  const old = await pack('', true);
  assert.equal(old.textures.enabled(), false);
  assert.equal(old.textures.shellPlate(old.ctx, 0, 0, 96, 96, 'brick'), false);
  const core = await pack('floor');
  assert.equal(core.textures.enabled(), false, 'core asset failure preserves full classic fallback');
  console.log('industrial-shells: loader, shells, floors and walls, paint, relief, cache, failure isolation, classic PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
