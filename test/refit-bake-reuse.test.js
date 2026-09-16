'use strict';
// Execute the production cache handoff and rebake functions with renderer spies.
// Real canvas timing/edit/undo coverage lives in scripts/qa/refit-entry.mjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = name => fs.readFileSync(require.resolve('../frontend/app/' + name), 'utf8');
const world = read('world.js'), build = read('build.js');
const handoff = world.match(/refitBake:\s*(st =>[\s\S]*?\? \{ cache, geo \} : null),/);
assert.ok(handoff, 'world exposes its guarded read-only cache handoff');
const station = {}, cache = {}, geo = {};
const context = vm.createContext({ station, cache, geo, geoDirty: false, bakeDirty: false });
vm.runInContext('this.borrow = ' + handoff[1], context);
assert.equal(context.borrow({}), null, 'different station cannot inherit this image');
for (const key of ['geoDirty', 'bakeDirty']) {
  context[key] = true;
  assert.equal(context.borrow(station), null, key + ' rejects stale rendered state');
  context[key] = false;
}
for (const key of ['cache', 'geo']) {
  const prior = context[key]; context[key] = null;
  assert.equal(context.borrow(station), null, 'missing ' + key + ' falls back to baking');
  context[key] = prior;
}
assert.equal(context.borrow(station).cache, cache, 'handoff shares the already-painted image');
assert.equal(context.borrow(station).geo, geo, 'geometry and pixels remain paired');

const openStart = build.indexOf('    const worldBake =');
const openEnd = build.indexOf('    frameFailures = 0;', openStart);
assert.ok(openStart > 0 && openEnd > openStart);
const initialize = build.slice(openStart, openEnd);
const bakeStart = build.indexOf('  function rebake()');
const bakeEnd = build.indexOf('  // A browser animation callback', bakeStart);
assert.ok(bakeStart > 0 && bakeEnd > bakeStart);
let calls = 0, projections = 0;
const editedGeo = { origin: { tx: 5, ty: 8 } }, editedCache = {};
const editor = vm.createContext({
  station: { projectGeometry() { projections++; return editedGeo; } },
  opts: { world: { refitBake() { return { cache, geo }; } } },
  cache: null, cacheGeo: null, bakeDirty: true, bakeDirtyRects: null,
  bakeDirtyRectsGlobal: false, bakeVisibleOnly: false, planDirty: false,
  valPlan: {}, valLive: null, valComps: null, ghost: null, lastStampIds: null,
  maybeFirstRide() {}, renderFinCard() {}, refreshLineFacts() {},
  visibleBakeRect() { return null; }, MAX_REFIT_CHUNKS: 18,
  StationBake: { bakeIncremental(g) { assert.equal(g, editedGeo); calls++; return editedCache; } }
});
vm.runInContext(build.slice(bakeStart, bakeEnd), editor);
const initializeEditor = () => vm.runInContext('{\n' + initialize + '\n}', editor);
for (let trial = 0; trial < 2; trial++) {
  initializeEditor();
  editor.rebake(); // Entry still compiles its routing plan, without painting again.
  assert.equal(calls, 0, 'entry and reopening must not synchronously rebake');
  assert.equal(projections, 0, 'borrowed geometry stays paired with borrowed pixels');
  assert.equal(editor.cache, cache);
  assert.equal(editor.cacheGeo, geo);
  assert.equal(editor.planDirty, false, 'routing plan is refreshed on entry');
}
editor.bakeDirty = true;
editor.rebake();
assert.equal(calls, 1, 'a real edit replaces the borrowed image');
assert.equal(projections, 1);
assert.equal(editor.cache, editedCache);
assert.equal(editor.cacheGeo, editedGeo);
editor.rebake();
assert.equal(calls, 1, 'clean frames do not repeat the edit bake');
editor.opts.world.refitBake = () => null;
initializeEditor(); editor.rebake();
assert.equal(calls, 2, 'missing or stale world image takes the original cold-bake path');
console.log('refit-bake-reuse: same-save handoff, invalidation, entry/reopen and cold fallback PASS');
