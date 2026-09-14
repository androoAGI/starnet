'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const factory = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'utility.js.inc'), 'utf8'));
const fx = factory({});
const recipes = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../docs/station-remaster/batch03/utility/coordinated-recipes.json'), 'utf8'));
function record(id, state) {
  const calls = []; let depth = 0;
  const ctx = new Proxy({}, {
    get(_, key) {
      assert.notEqual(key, 'getImageData', 'No raster readback is allowed');
      return (...args) => {
        for (const a of args) if (typeof a === 'number') assert(Number.isFinite(a), key + ' received nonfinite geometry');
        if (key === 'save') depth++;
        if (key === 'restore') { depth--; assert(depth >= 0, 'context restore underflow'); }
        calls.push([key, ...args]);
      };
    },
    set(_, key, value) { calls.push([key, value]); return true; }
  });
  const handled = fx.draw(ctx, id, state, recipes.props[id]?.views.s || {});
  assert.equal(depth, 0, 'Context state must be restored');
  return { handled, calls };
}
assert.equal(fx.ids.length, 7);
for (const id of fx.ids) {
  const a=record(id,{now:101,work:false}), b=record(id,{now:2843,work:false});
  assert(a.handled); assert.notDeepEqual(a.calls,b.calls,id+' must have actual ambient geometry or emission changes');
  assert.deepEqual(record(id,{now:101,still:true,work:false}),record(id,{now:99999,still:true,work:false}),id+' still must freeze every clock');
  assert.deepEqual(record(id,{now:101,work:false,fired:true,bad:true}),a,id+' must not invent result/failed telemetry');
  const bounds=fx.frameBounds(id); assert.equal(bounds.x,0);assert.equal(bounds.y,0);assert.equal(bounds.width,1);assert.equal(bounds.height,1);
  assert(a.calls.some(c=>c[0]==='clip'),id+' must confine its edits');
}
for (const id of ['etsy_kiln','research_samplecart']) assert.notDeepEqual(record(id,{now:700,work:false}),record(id,{now:700,work:true}),id+' must preserve work intensity response');
for (const id of ['fishtank','lavalamp','plasmaglobe','terrarium','incubator']) assert.deepEqual(record(id,{now:700,work:false}),record(id,{now:700,work:true}),id+' must remain ambient regardless of work');
assert.equal(record('unknown',{now:1}).handled,false);assert.equal(fx.frameBounds('unknown'),null);
console.log('PASS: 7 mechanisms animate, freeze deterministically, restore context, clip, avoid result telemetry and preserve correct work response.');
