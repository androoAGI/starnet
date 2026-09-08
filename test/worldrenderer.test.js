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
console.log('worldrenderer: depth order, camera geometry, lifecycle and measured-only statistics passed');
