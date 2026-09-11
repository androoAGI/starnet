'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const workers = [], timers = new Map(); let timerId = 0;
class Bitmap { close() { this.closed = (this.closed || 0) + 1; } }
class Worker {
  constructor() { this.sent = []; workers.push(this); }
  postMessage(data) { this.sent.push(data); }
  terminate() { this.terminated = true; }
  reply(data) { this.onmessage({ data }); }
}
const box = { URL, Worker, OffscreenCanvas: class {}, ImageBitmap: Bitmap,
  document: { currentScript: { src: 'http://localhost/app/backdrop-bake.js' } },
  setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) };
vm.createContext(box);
vm.runInContext(fs.readFileSync('frontend/app/backdrop-bake.js', 'utf8') + ';this.api=BackdropBake;', box);
const api = box.api, accepted = [];
const accept = data => { accepted.push(data.token); api.release(data); };
api.request('ground', 'first', { width: 500 }, accept);
const ground = workers[0];
for (let i = 0; i < 500; i++) api.request('ground', 'view-' + i, { width: 500 + i }, accept);
assert.equal(ground.sent.length, 1, 'rapid panning keeps one active job');
const first = new Bitmap(); ground.reply({ token: ground.sent[0].token, bitmap: first });
assert.equal(first.closed, 1); assert.equal(accepted.length, 1, 'intermediate completed views do not starve movement');
assert.equal(ground.sent.length, 2); assert.equal(ground.sent[1].width, 999, 'only the newest queued view is baked');
api.request('sky', 'city', {}, accept); assert.equal(workers.length, 2, 'sky and ground have independent bounded lanes');
api.cancel('ground'); assert.equal(ground.terminated, true);
const stale = new Bitmap(); ground.reply({ token: ground.sent[1].token, bitmap: stale });
assert.equal(stale.closed, 1); assert.equal(accepted.length, 1, 'a cancelled recovery epoch cannot revive old artwork');
const same = new Bitmap(); api.release({ a: same, b: [same] }); assert.equal(same.closed, 1, 'shared bitmap references close once');
const sky = workers[1]; sky.reply({ token: sky.sent[0].token, failed: true });
assert.equal(api.request('sky', 'ocean', {}, accept), false, 'failed worker requests use compatibility rendering');
api.cancel('sky'); api.request('sky', 'retry', {}, accept);
const timeout = [...timers.values()][0]; timeout();
assert.equal(api.request('sky', 'late', {}, accept), false, 'a hung bake cannot grow a request queue');

// Exercise the real ground dispatcher, not a copy of its cache-key logic.
const requests = [], blits = []; let cancelled = 0, released = 0;
function context() { return { fillRect() {}, setTransform() {}, drawImage(...args) { blits.push(args); } }; }
const terrainBox = { console, Math, Map, Set, ArrayBuffer, window: { devicePixelRatio: 1 },
  document: { createElement: () => ({ width: 0, height: 0, getContext: context }) },
  BackdropBake: { request(kind, key, params, cb) { requests.push({ kind, key, params, cb }); return true; }, cancel() { cancelled++; }, release() { released++; } } };
vm.createContext(terrainBox);
vm.runInContext(fs.readFileSync('frontend/app/terrain.js', 'utf8') + ';this.api=Terrain;', terrainBox);
const terrain = terrainBox.api, ctx = context(), station = { x: 0, y: 0, w: 600, h: 600 };
terrain.setGround('forest'); terrain.draw(ctx, { scale: 1, panX: 0, panY: 0 }, 1920, 1080, station);
assert.equal(requests.length, 1, 'cold terrain submits a worker bake without generating sprites on the UI thread');
requests[0].cb({ bitmap: {} });
const coldBlits = blits.length;
for (let i = 0; i < 100; i++) terrain.draw(ctx, { scale: 1, panX: i / 2, panY: 0 }, 1920, 1080, station);
assert.equal(requests.length, 1, 'small pans reuse the overscanned plate');
assert.equal(blits.length - coldBlits, 100, 'one ground blit per frame replaces per-tree drawing');
terrain.draw(ctx, { scale: 2, panX: 0, panY: 0 }, 1920, 1080, station);
assert.equal(requests.length, 2, 'zoom requests full-resolution artwork at the new scale');
terrain.draw(ctx, { scale: 1, panX: 0, panY: 0 }, 1920, 1080, { ...station, x: 40 });
assert.equal(requests.length, 3, 'refit footprint changes invalidate the clearing');
terrain.setGround('moon'); requests[2].cb({ bitmap: {} });
assert.equal(terrain._dbgBakeState().ready, false, 'late forest reply cannot replace the moon');
terrain.invalidate(); assert.equal(cancelled, 1); assert.equal(terrain._dbgBakeState().width, 0);
assert.ok(released >= 2);
console.log('backdrop-bake: bounded queues, cancellation, fallback, bitmap disposal, cached pans, zoom and clearing invalidation passed');
