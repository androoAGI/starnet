'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { enabled, attach } = require('../frontend/js/lab-mobile-ui.js');
const { fnBody } = require('../test/_assert.js');

test('mobile policy is limited to small touchscreens and has an opt-out', () => {
  const win = (matches, search = '') => ({ location: { search }, matchMedia: () => ({ matches }) });
  assert.equal(enabled(win(true)), true);
  assert.equal(enabled(win(false)), false);
  assert.equal(enabled(win(true, '?lab-mobile=off')), false);
  assert.equal(enabled(null), false);
});

test('menu controller pauses only with a visible menu, resumes on resize, and disposes safely', async () => {
  let menu = false, mobile = true, change;
  const observers = [], updates = [], classes = new Set();
  const terms = {};
  const media = { get matches() { return mobile; }, addEventListener: (_, f) => { change = f; }, removeEventListener() {} };
  const win = { location: { search: '' }, matchMedia: () => media, World: { setMenuPaused: on => updates.push(on) }, MutationObserver: class {
    constructor(fn) { this.fn = fn; observers.push(this); }
    observe() {}
    disconnect() {}
  } };
  const doc = { body: { classList: { toggle(k, on) { on ? classes.add(k) : classes.delete(k); }, remove(k) { classes.delete(k); } } },
    querySelector: () => menu ? {} : null, getElementById: () => terms, querySelectorAll: () => [] };
  const ui = attach(win, doc);
  assert.equal(ui.paused(), false);
  menu = true;
  observers[0].fn([{ target: terms }]);
  await Promise.resolve();
  assert.equal(ui.paused(), true);
  assert.equal(classes.has('lab-mobile-menu-open'), true);
  mobile = false; change(); await Promise.resolve();
  assert.equal(ui.paused(), false);
  mobile = true; change(); await Promise.resolve();
  assert.equal(ui.paused(), true);
  menu = false; ui.sync();
  assert.equal(ui.paused(), false);
  menu = true; observers[0].fn([{ target: terms }]);
  ui.dispose(); await Promise.resolve();
  assert.equal(updates.at(-1), false, 'an already-queued observer must not re-pause after dispose');
});

test('scene pause cancels draws, preserves the lifecycle state and never restarts a stopped world', () => {
  const source = fs.readFileSync(require.resolve('../frontend/app/world.js'), 'utf8');
  const methods = ['setMenuPaused(on)', 'scheduleFrame(pace)', 'paceWake()'].map(sig => fnBody(source, 'function ' + sig)).join('\n');
  const events = [];
  const sandbox = { performance: { now: () => 1000 }, requestAnimationFrame: () => { events.push('raf'); return 1; },
    setTimeout: () => 1, clearTimeout() {}, events };
  vm.createContext(sandbox);
  vm.runInContext('let running=true, menuPaused=false, last=0, raf=0, paceTimer=0, lastDrawnAt=0; const PACE_TIMER_MIN_MS=100; function frame() {} function paceMs(){ return 17; } function cancelScheduled(){ events.push("cancel"); raf=paceTimer=0; }\n' + methods +
    '\nthis.api={setMenuPaused,scheduleFrame,paceWake,state:()=>({running,menuPaused,last}),stop:()=>{running=false}};', sandbox);
  const a = sandbox.api;
  a.setMenuPaused(true);
  assert.equal(a.state().running, true, 'render pause is not lifecycle stop');
  a.scheduleFrame(17); a.paceWake();
  assert.deepEqual(events, ['cancel']);
  a.setMenuPaused(false);
  assert.equal(a.state().last, 1000, 'resume does not catch up minutes of idle animation');
  assert.deepEqual(events, ['cancel', 'raf']);
  a.setMenuPaused(true); a.stop(); a.setMenuPaused(false);
  assert.equal(a.state().running, false);
  assert.deepEqual(events, ['cancel', 'raf', 'cancel']);
});
