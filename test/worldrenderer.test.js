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
console.log('worldrenderer: depth order, camera geometry, lifecycle and measured-only statistics passed');
