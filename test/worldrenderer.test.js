'use strict';
const assert = require('node:assert/strict');
const R = require('../frontend/app/worldrenderer.js');
const queue = [
  { id: 'quilt', y: 24.75 }, { id: 'bed', y: 24 }, { id: 'body', y: 24.5 },
  { id: 'desk', y: 36 }, { id: 'mounted', y: 36.5 }, { id: 'same-row', y: 36 }
];
assert.deepEqual(R.sortedItems(queue).map(x => x.id), ['bed', 'body', 'quilt', 'desk', 'same-row', 'mounted']);
assert.equal(queue[0].id, 'quilt', 'sorting never mutates a caller-owned display list');
assert.deepEqual(R.visibleRect({ scale: 2, panX: -20, panY: 14, width: 800, height: 400 }), { x: 10, y: -7, w: 400, h: 200 });
assert.ok(R.intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 12, y: 0, w: 1, h: 1 }, 3), 'raised art margins remain visible');
assert.ok(!R.intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 12, y: 0, w: 1, h: 1 }, 0));
assert.equal(R.percentile([], .95), null, 'no fabricated performance before sampling');
const packed = (r,g=r,b=r,a=255) => ((a<<24)|(b<<16)|(g<<8)|r)>>>0;
const flat = new Uint32Array(9).fill(packed(67,91,113));
assert.equal(R.sharpenSample(flat,4,3,3,.6),flat[4],'sharpening adds no brightness or tint to a flat surface');
const edge = new Uint32Array([packed(0),packed(40),packed(160),packed(0),packed(130),packed(160),packed(0),packed(40),packed(160)]);
assert.ok((R.sharpenSample(edge,4,3,3,.28)&255)>130,'a soft edge gains local definition');
assert.equal(R.sharpenSample(edge,4,3,3,0),edge[4],'zero strength is pixel-identical');
for(let i=0;i<edge.length;i++) {
  const result=R.sharpenSample(edge,i,3,3,.6);
  assert.ok((result&255)<=160,'clipping prevents overshoot beyond the existing bright edge');
  assert.equal(result>>>24,255,'opaque coverage survives sharpening');
}
const quiet = new Uint32Array(9).fill(packed(40)); quiet[4]=packed(43);
assert.equal(R.sharpenSample(quiet,4,3,3,.6),quiet[4],'faint gradients and noise are below the detail threshold');
const border = new Uint32Array([packed(40),packed(200),packed(40),packed(40)]);
assert.equal(R.sharpenSample(border,2,2,2,.6),border[2],'neighbour taps never wrap across image rows');
const renderer = R.create();
assert.equal(renderer.stats().renderMedianMs, null);
const calls = [];
renderer.begin({ now: 1, geo: { TILE: 12 }, cache: {} });
renderer.drawEntities({}, [{ y: 2, draw: () => calls.push('front') }, { y: 1, draw: () => calls.push('back') }]);
renderer.finish();
assert.deepEqual(calls, ['back', 'front']);
assert.equal(renderer.stats().frames, 1);
assert.equal(renderer.stats().entities, 2);
assert.equal(renderer.drawLight({}, [], {}), false, 'legacy fallback is explicit when lighting engine is absent');
assert.equal(renderer.prepareLight([], {}), false);
assert.equal(renderer.sampleLight(12, 12), null, 'missing light engine retains the native sprite/shadow path');
renderer.dispose();
assert.equal(renderer.stats().samples, 0);

// A physical source disappearing must affect the body in that very depth pass.
// Preparing light after drawing the body leaves a one-frame false work glow.
const vm = require('node:vm');
const fs = require('node:fs');
let prepared = null;
const sequence = [];
const fakeLight = {
  setGeometry() { prepared = null; },
  prepare(frame) { prepared = frame; sequence.push('prepare'); },
  sample(x, y) { return { x, y, sources: prepared.lights.length }; },
  drawGrounding() { sequence.push('ground:' + prepared.lights.length); },
  render() { sequence.push('composite:' + prepared.lights.length); return true; },
  dispose() { prepared = null; }
};
const scope = { module: { exports: {} }, WorldLight: { create: () => fakeLight } };
vm.runInNewContext(fs.readFileSync(require.resolve('../frontend/app/worldrenderer.js'), 'utf8'), scope);
const live = scope.module.exports.create();
const geo = { TILE: 12 }, cache = { W: 48, H: 48, lamps: [{ x: 12 }], wallFixtures: [{ x: 24 }] };
live.begin({ now: 10, geo, cache });
assert.equal(live.sampleLight(10, 10), null, 'never samples stale sources before preparation');
live.prepareLight([{ x: 12, y: 12 }], { emission: .9 });
assert.equal(prepared.fixtures.length, 2, 'both physical fixture collections reach the same sample');
live.drawGrounding({}, [{}]);
live.drawEntities({}, [{ y: 1, draw: () => sequence.push('body:' + live.sampleLight(12, 12).sources) }]);
live.drawLight({}, []);
assert.deepEqual(sequence, ['prepare', 'ground:1', 'body:1', 'composite:1']);
live.begin({ now: 20, geo, cache });
assert.equal(live.sampleLight(12, 12), null);
live.prepareLight([], {});
assert.equal(live.sampleLight(12, 12).sources, 0, 'stopped work removes illumination before the next sprite');
live.dispose();
assert.equal(live.sampleLight(12, 12), null);
const classicScope = { module: { exports: {} }, URLSearchParams, location: { search: '?world=classic' },
  WorldLight: { create() { throw new Error('classic must not initialize replacement light'); } } };
vm.runInNewContext(fs.readFileSync(require.resolve('../frontend/app/worldrenderer.js'), 'utf8'), classicScope);
const classic = classicScope.module.exports.create();
classic.begin({ now: 10, geo, cache });
assert.equal(classic.prepareLight([{ x: 12 }]), false);
assert.equal(classic.sampleLight(12, 12), null, 'classic has no replacement shadow and must use the legacy body appearance');
classic.drawGrounding({}, [{}]);
assert.equal(classic.drawLight({}, [], {}), false);
console.log('worldrenderer: depth order, camera geometry, lifecycle and measured-only statistics passed');
