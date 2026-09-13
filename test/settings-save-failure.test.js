'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(require.resolve('../frontend/app/stationui.js'), 'utf8');
const start = src.indexOf('  let lastSaveOk = true;');
const end = src.indexOf('  /* ---------- CUSTOM PHOSPHOR', start);
let fail = true, writes = 0;
const warnings = [];
const ctx = vm.createContext({ KEY: 'settings', store: { theme: 'amber' },
  localStorage: { setItem() { if (fail) throw new Error('quota'); writes++; } },
  notify: (...args) => warnings.push(args), clearTimeout() {}, setTimeout: () => 1 });
vm.runInContext(src.slice(start, end) + '\nthis.api = { save, flashSaved };', ctx);
const elm = { textContent: '', className: '', isConnected: true };
assert.equal(ctx.api.save(), false);
ctx.api.flashSaved(elm);
assert.match(elm.textContent, /Could not save/); assert.equal(elm.className, 'msg bad');
assert.equal(warnings.length, 1);
ctx.api.save(); assert.equal(warnings.length, 1, 'repeat write failures do not flood notifications');
ctx.api.flashSaved(elm, undefined, true); assert.equal(elm.textContent, '✓ saved', 'independent OS preference acknowledgement has its own truth');
fail = false; assert.equal(ctx.api.save(), true); ctx.api.flashSaved(elm);
assert.equal(writes, 1); assert.equal(elm.textContent, '✓ saved');
console.log('local settings: storage failure is visible; retry and independent persistence are truthful');
