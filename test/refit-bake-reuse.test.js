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
  cache: null, cacheGeo: null, bakeDirty: true, bakeDirtyRects: null, projectionDirty: false,
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

// Execute the actual edit listener, so coalesced invalidations cannot turn a
// floor/airlock edit into a prop-only frame (including a pending pan bake).
Object.assign(editor, { clearLineFields() {}, bumpGeo() {}, updateUndoRedo() {},
  renderSelection() {}, renderEquipmentInfo() {}, tool: 'select' });
const listenerStart = build.indexOf('    unsub = station.onChange(p => {');
const listenerEnd = build.indexOf('    const worldBake =', listenerStart);
vm.runInContext('this.edit = p => {' + build.slice(listenerStart, listenerEnd)
  .split('station.onChange(p => {')[1].replace(/\}\);\s*$/, '') + '};', editor);
const reset = () => Object.assign(editor, { bakeDirty: false, planDirty: false,
  projectionDirty: false, bakeDirtyRects: null, bakeDirtyRectsGlobal: false, bakeVisibleOnly: false });
const propPatch = { staticBakeUnchanged: true, dirtyRects: [{x1:2,y1:2,x2:3,y2:3}] };
reset(); editor.edit(propPatch);
assert.equal(editor.bakeDirty, false, 'ordinary prop keeps environment pixels');
assert.equal(editor.projectionDirty, true, 'prop refreshes collision geometry');
assert.equal(editor.planDirty, true, 'prop refreshes capability routing');
const priorCalls=calls, priorProjections=projections;
editor.rebake();
assert.equal(calls, priorCalls, 'prop-only frame never repaints environment');
assert.equal(projections, priorProjections+1, 'prop-only frame gets fresh geometry');
assert.equal(editor.projectionDirty, false);
for (const edits of [[{global:true},propPatch],[propPatch,{global:true}],
  [{dirtyRects:propPatch.dirtyRects},propPatch],[propPatch,{dirtyRects:propPatch.dirtyRects}]]) {
  reset(); editor.bakeVisibleOnly=true;
  for(const patch of edits)editor.edit(patch);
  assert.equal(editor.bakeDirty,true,'mixed edits retain the environment bake');
  assert.equal(editor.bakeVisibleOnly,false,'real edit cancels pan-only mode');
  if(edits.some(p=>p.global))assert.equal(editor.bakeDirtyRects,null,'global invalidation stays global');
}

const WM=require('../frontend/app/worldmodel.js');
const st=WM.create(); let patch;
st.onChange(p=>{patch=p;});
const added=st.addProp({t:'plant',x:4,y:4,w:1,h:1});
assert.ok(added.ok); assert.equal(patch.staticBakeUnchanged,true);
for(const change of [()=>st.moveProp(added.id,1,0),()=>st.rotateProp(added.id,1),
  ()=>st.mirrorProp(added.id),()=>st.removeProp(added.id)]){
  assert.ok(change().ok);assert.equal(patch.staticBakeUnchanged,true);
}
st.undo();assert.equal(patch.staticBakeUnchanged,undefined,'undo conservatively rebakes');
st.redo();assert.equal(patch.staticBakeUnchanged,undefined,'redo conservatively rebakes');
const door=st.addProp({t:'airlock',door:'closed',x:6,y:4,w:1,h:1});
assert.ok(door.ok);assert.equal(patch.staticBakeUnchanged,undefined,'airlock can change doorways');
for(const change of [()=>st.moveProp(door.id,1,0),()=>st.rotateProp(door.id,1),
  ()=>st.mirrorProp(door.id),()=>st.removeProp(door.id)]){
  assert.ok(change().ok);assert.equal(patch.staticBakeUnchanged,undefined);
}
st.setFloor(st.rooms()[0].id,'cobalt');
assert.equal(patch.staticBakeUnchanged,undefined,'floor changes still rebake');
console.log('refit placement: prop-only pixels, fresh geometry/routing, mixed edits, airlock and history PASS');
