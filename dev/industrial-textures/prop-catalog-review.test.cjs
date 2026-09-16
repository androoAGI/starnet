'use strict';
const assert = require('node:assert/strict');
global.IndustrialTextures = { isRemaster: () => true, enabled: () => true, ready: Promise.resolve() };
const P = require('../../frontend/app/propsprites.js'), M = require('../../frontend/app/worldmodel.js');
const F = require('../../frontend/app/prop-catalog-fixture.js'), data = require('../../frontend/app/prop-catalog-data.js');
const expected = P.CATALOG.flatMap(s => P.facings(s.id).map(r => s.id + ':' + ['s', 'w', 'n', 'e'][r]));
assert.equal(data.catalogTypes, 160);
assert.deepEqual(data.views.map(v => v.key).sort(), expected.sort());
assert.equal(new Set(data.views.map(v => v.key)).size, data.views.length);
assert.equal(data.supportedViews, 208);
const starterShape = () => { const doc = M.defaultDoc(); delete doc.meta.createdAt; return JSON.stringify(doc); };
const initial = starterShape(), covered = new Set();
let rooms = 0, mounted = 0;
for (const category of ['', ...data.categories.map(c => c.id)]) {
  const count = F.page(data, { category }).pages;
  for (let page = 0; page < count; page++) {
    const selection = F.page(data, { category, page }), room = F.create(selection.entries, P, M);
    assert.deepEqual(room.violations, [], 'Room placements: ' + category + '/' + page);
    assert.equal(room.anchors.length, 3);
    assert.deepEqual(room.anchors.map(p => p.t), ['desk', 'chair', 'crate']);
    for (const { entry, prop } of room.subjects) {
      covered.add(entry.key);
      assert.deepEqual({ w: prop.w, h: prop.h }, P.footprintAt(prop.t, prop.r));
      if (!prop.r) assert.deepEqual({ w: prop.w, h: prop.h }, { w: P.spec(prop.t).w, h: P.spec(prop.t).h }, 'South footprint changed');
      if (entry.placement === 'wall') assert.equal(prop.y, 0);
      if (entry.placement === 'surface') {
        assert.equal(room.station.mountOf(prop), 'surface', entry.key);
        assert.ok(room.supports.some(h => h.id === room.station.surfaceHostOf(prop))); mounted++;
      }
    }
    // Every room is a disposable model; constructing it cannot mutate the starter document.
    assert.equal(starterShape(), initial); rooms++;
  }
}
assert.equal(covered.size, expected.length);
assert.ok(mounted > 0);
assert.equal(F.page(data, { search: 'no-such-prop' }).entries.length, 0);
assert.equal(F.page(data, { page: -99 }).index, 0);
assert.ok(F.select(data, { mount: 'wall' }).every(v => v.requiredMount === 'wall'));
assert.ok(F.select(data, { facing: 'e' }).every(v => v.r === 3));
assert.equal(F.select(data, { search: 'benchpress_r' }).length, 1);
assert.throws(() => F.create([{ id: 'crate', r: 2, footprint: { w: 2, h: 1 }, placement: 'floor', bounds: { y: 0 } }], P, M), /Unsupported facing/);
console.log(JSON.stringify({ types: 160, supportedDirections: covered.size, roomsChecked: rooms, mountedCases: mounted, savedState: 'untouched' }));
