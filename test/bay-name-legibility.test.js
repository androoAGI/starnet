'use strict';
const assert = require('node:assert/strict');
const PS = require('../frontend/app/propsprites.js');
function paint(props, zoom, dpr = 1) {
  const text = [], boxes = [];
  const ctx = {
    save() {}, restore() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillRect(x, y, w, h) { boxes.push({ x, y, w, h }); },
    measureText(s) { return { width: Array.from(s).length * parseFloat(this.font) * .5 }; },
    fillText(s, x, y) { text.push({ s, x, y, fontPx: parseFloat(this.font) * zoom / dpr }); },
  };
  PS.setCtx(ctx); PS.drawBayNames(props, zoom, dpr);
  return { text, boxes };
}
const bay = { t: 'bay', x: 10, y: 10, w: 2, h: 2, agentId: 'agent-one', dockName: 'ULTRON' };
for (const dpr of [1, 1.25, 2]) for (const zoom of [.5, 1, 2, 4, 8]) {
  const out = paint([bay], zoom, dpr);
  assert.equal(out.text.map(t => t.s).join(''), 'ULTRON', 'the sixth character is not silently discarded');
  assert.equal(out.text[0].fontPx, 7 * zoom / dpr, 'the physical tag shrinks with the bay; there is no screen-size floor');
  assert.deepEqual(out.boxes, paint([bay], 1).boxes, 'zoom and DPI never enlarge or move the tag in station space');
}
assert.equal(paint([{ ...bay, dockName: 'Nova' }], 2).text[0].s, 'NOVA', 'rename reads current roster projection');
assert.equal(paint([{ ...bay, agentId: 'tg_other', dockName: null }], 2).text[0].s, 'OTHER', 'missing roster name uses the real binding');
assert.equal(paint([{ ...bay, agentId: null }], 2).text.length, 0, 'unassigned bay never claims an agent');
const nearby = paint([bay, { ...bay, x: 12, agentId: 'two', dockName: 'RESEARCHER' }, { ...bay, x: 14, agentId: 'three', dockName: 'RESEARCHER TWO' }], .5);
assert.ok(nearby.boxes.every(box => box.y === nearby.boxes[0].y), 'dense tags stay anchored above their bays instead of stacking into a floating list');
for (let i = 0; i < nearby.boxes.length; i++) for (let j = i + 1; j < nearby.boxes.length; j++) {
  const a = nearby.boxes[i], b = nearby.boxes[j];
  assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'adjacent names do not overprint');
}
const long = paint([{ ...bay, dockName: 'A very long research specialist name that cannot fit on a bay' }], 1);
assert.equal(long.text.length, 1); assert.ok(long.text[0].s.endsWith('…'), 'overlong names stay on one compact line with an honest ellipsis');
assert.ok(long.boxes[0].w <= bay.w * PS.TILE, 'a tag never grows wider than its bay');
assert.equal(long.boxes[0].h, paint([bay], 1).boxes[0].h, 'long names never grow a taller card');
console.log('bay-name-legibility: compact tags, proportional zoom/DPI, rename, binding, fixed anchors and bounded long names PASS');
