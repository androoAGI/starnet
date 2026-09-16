'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../frontend/app/windows/loops.js'), 'utf8');
const start = source.indexOf("    listEl.addEventListener('click', async ev => {");
const end = source.indexOf('    // ---------- START A LOOP:', start);
(async () => {
  let handler, resolve, calls = 0;
  const notices = [], draft = { value: 'Preserve this reason' };
  const buttons = [{ disabled: false }, { disabled: false }];
  const card = { dataset: { n: '1' }, querySelector: () => draft, querySelectorAll: () => buttons };
  const vb = Object.assign(buttons[0], { dataset: { vact: 'reject-confirm', n: '1' }, closest: () => card });
  const row = { dataset: { id: 'loop' }, querySelectorAll: () => [card] };
  const event = { target: { closest: selector => selector === 'button[data-vact]' ? vb : row } };
  const listEl = { addEventListener: (_, fn) => { handler = fn; }, querySelectorAll: () => [row] };
  const ctx = vm.createContext({ listEl, pendingVerdicts: new Set(), pendingControls: new Set(), refreshGeneration: 0,
    post: () => { calls++; return new Promise(r => { resolve = r; }); },
    sfx() {}, notify: text => notices.push(text), refresh() {}, AbortController, setTimeout, clearTimeout });
  vm.runInContext(source.slice(start, end), ctx);
  const first = handler(event); await handler(event);
  assert.equal(calls, 1, 'a pending review cannot submit twice');
  assert.ok(buttons.every(b => b.disabled));
  resolve({ ok: false, json: async () => ({ error: 'Review busy' }) }); await first;
  assert.ok(buttons.every(b => !b.disabled), 'refusal re-enables the retained card');
  assert.equal(draft.value, 'Preserve this reason'); assert.equal(notices.at(-1), 'Review busy');
  const second = handler(event); resolve({ ok: false, json: async () => ({}) }); await second;
  assert.equal(notices.at(-1), 'could not record this review', 'non-2xx without an error field cannot announce approval');
  assert.ok(buttons.every(b => !b.disabled));
  const retry = handler(event); resolve({ ok: true, json: async () => ({ ok: true }) }); await retry;
  assert.equal(calls, 3); assert.ok(notices.at(-1).startsWith('rejected #1'));
  console.log('loop review controls: duplicate suppression, refused/malformed acknowledgements and retry PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
