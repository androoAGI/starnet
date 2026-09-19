'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fnBody } = require('./_assert');
const src = fs.readFileSync(require('node:path').join(__dirname, '../frontend/app/stationui.js'), 'utf8');
test('settings refresh defaults to preserving state, explicit navigation keeps its swap', () => {
  const renders = [];
  const rerender = Function('open', fnBody(src, 'function rerender(') + ';return rerender;')({ settings: { _render: swap => renders.push(swap) } });
  rerender('settings'); rerender('settings', false); rerender('settings', true); rerender('closed');
  assert.deepEqual(renders, [false, false, true]);
});
test('an asynchronous content completion preserves the position at completion and never replays it later', () => {
  const pane = { isConnected: true, scrollTop: 1500, scrollLeft: 17 };
  const preserve = Function('document', fnBody(src, 'function preserveScroll(') + ';return preserveScroll;')({ querySelectorAll: () => [pane] });
  preserve(() => { pane.scrollTop = 0; pane.scrollLeft = 0; });
  assert.equal(pane.scrollTop, 1500); assert.equal(pane.scrollLeft, 17);
  pane.scrollTop = 1800;
  preserve(() => { pane.scrollTop = 0; });
  assert.equal(pane.scrollTop, 1800, 'a later reply uses the user\'s new position');
  assert.doesNotMatch(fnBody(src, 'function preserveScroll('), /requestAnimationFrame|setTimeout/);
});
test('account refresh reserves the previous content height until Settings closes', () => {
  const retain = Function(fnBody(src, 'function retainCreditsHeight(') + ';return retainCreditsHeight;')();
  const host = { offsetHeight: 243, style: {} };
  retain(host);
  host.offsetHeight = 24; // asynchronous loading placeholder
  retain(host);
  assert.equal(host.style.minHeight, '243px', 'the scroll range cannot temporarily collapse');
  host.offsetHeight = 320;
  retain(host);
  assert.equal(host.style.minHeight, '320px', 'longer results can expand normally');
});
