'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/app/world.js'), 'utf8');
const start = source.indexOf('  function layoutRoutingNagLabels(');
const end = source.indexOf('  function drawRoutingNags(', start);
const layout = vm.runInNewContext(source.slice(start, end) + '\nlayoutRoutingNagLabels');
const room = { x: 120, y: 60, w: 144, h: 108 };
const viewport = { x: 0, y: 0, w: 300, h: 180 };
const options = { tile: 12, zoom: 1, viewport, containerFor: () => room, selected: null, measure: s => Array.from(s).length * 4 };
const nags = [
  { x: 20, y: 12, w: 2, h: 2, label: 'CUSTOM — OPERATES THE ENTIRE LONG WORKFLOW — CLICK', warn: false },
  { x: 20, y: 12, w: 2, h: 2, label: 'NO COMPUTE — ADD A PC', warn: true },
  { x: 18, y: 12, w: 2, h: 2, label: 'NO FEED — CLICK', warn: true }
];
const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const overview = layout(nags, options);
assert.equal(overview.length, 1);
assert.equal(overview[0].lines[0], '3 ISSUES', 'aggregate counts real findings, including two on one prop');
assert.equal(overview[0].warn, false, 'a blocker never becomes a warning when aggregated');
assert.ok(inside(overview[0], room), 'bottom-right overview text stays inside the room');
assert.equal(layout([], options).length, 0, 'no label without actual findings');
const close = layout(nags, { ...options, zoom: 2 });
assert.equal(close.length, 2, 'multiple findings on the same prop share a concise label');
assert.ok(close.some(x => x.lines[0] === 'CUSTOM +1'));
assert.ok(close.some(x => x.lines[0] === 'NO FEED'));
assert.ok(close.every(x => inside(x, room)));
assert.ok(!overlap(close[0], close[1]), 'adjacent warnings do not overprint');
const selected = layout(nags, { ...options, selected: '20,12' });
const detail = selected.find(x => x.detail);
assert.equal(detail.lines.join(''), nags[0].label + nags[1].label, 'selection preserves complete original instructions');
assert.ok(inside(detail, viewport));
assert.ok(selected.filter(x => !x.detail).every(x => !overlap(x, detail)));
const edge = layout(nags, { ...options, viewport: { x: 240, y: 140, w: 45, h: 26 } });
assert.ok(edge.every(x => inside(x, room) && inside(x, { x: 240, y: 140, w: 45, h: 26 })), 'pan clips layout to both room and viewport');
assert.equal(layout(nags, { ...options, viewport: { x: 600, y: 600, w: 50, h: 50 } }).length, 0, 'offscreen props do not float a label onto screen');
const tiny = layout(nags, { ...options, containerFor: () => ({ x: 240, y: 144, w: 8, h: 8 }) });
assert.equal(tiny.length, 0, 'no unbounded escape when room has no label space; bracket pass remains separate');
const huge = layout([{ ...nags[0], label: 'A'.repeat(2000) }], { ...options, selected: '20,12' });
assert.ok(inside(huge[0], viewport));
assert.ok(huge[0].lines.at(-1).includes('REFIT'), 'extreme authored detail truncation is explicit');
for (const zoom of [.5, 1, 2]) {
  const out = layout(nags, { ...options, zoom, viewport: { x: 0, y: 0, w: 600 / zoom, h: 400 / zoom }, selected: '20,12' });
  assert.ok(out.find(x => x.detail).font * zoom >= 12, 'selected instructions retain readable screen size at overview');
}
assert.match(source, /feedState\.known && !feedState\.fed/, 'server-proven feed condition remains intact');
assert.match(source, /if \(ub && onBayAssign\) \{ onBayAssign\(ub.id\)/, 'assignment click-through remains intact');
// Exercise the actual draw adapter, including local/world origin translation and
// device-pixel zoom; testing the pure packer alone would miss a misplaced room.
const drawEnd = source.indexOf('  // the hover-glance tag over a clickable OUTBOX:', end);
const paints = [], strokes = [];
const ctx = {
  save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
  stroke() { strokes.push(true); },
  measureText(s) { return { width: Array.from(s).length * parseFloat(this.font) / 2 }; },
  fillRect(x, y, w, h) { paints.push({ x, y, w, h }); }, fillText() {}
};
const adapter = vm.runInNewContext(source.slice(start, drawEnd) + '\ndrawRoutingNags', {
  routingNags: nags, T: 12, scale: 2, panX: 0, panY: 0, cv: { width: 600, height: 360 }, ctx,
  NAG_FONT: "8px 'VT323'", selectedRoutingTile: null, window: { devicePixelRatio: 2 },
  geo: { origin: { tx: 100, ty: 200 } }, roomOfLocalTile: () => 'r1',
  station: { roomById: () => ({ rects: [{ x1: 110, y1: 205, x2: 121, y2: 213 }] }) }
});
adapter(0);
assert.equal(strokes.length, nags.length, 'every real finding keeps its warning bracket even at overview');
assert.equal(paints.length, 1, 'DPI-adjusted overview uses one aggregate, not long per-prop labels');
assert.ok(inside(paints[0], room), 'room bounds convert world coordinates back to local station coordinates');
console.log('routing-label-layout: overview aggregation, truthful counts, selection details, bounded pan/zoom and collisions PASS');
