/* node test/browser-chip-wait.test.js — a browser.* tool chip stops asking the station once its run is over
   (idle CPU piece 3, 2026-10-20).

   THE LEAK. A browser.* call's chip checks /api/connectors once a second ("Waiting for browser session…") until it resolves
   or leaves the DOM. A run that ended without that call's result (stopped, failed) left the chip 'pending' inside the
   folded but still connected .run-fold, so it kept reading /api/connectors at 1 Hz until the session was switched.

   GENUINE (executed): the REAL toolChip body is sliced out of chat.js and run with a fake timer queue; the chip, the
   rail and Channels are small stubs. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend/app/chat.js'), 'utf8');
const from = src.indexOf('  function toolChip(ev) {');
const to = src.indexOf('  /* AN APPROVAL NOT GIVEN IS NOT A FAILURE', from);
A.ok(from > 0 && to > from, 'fixture: toolChip is locatable in chat.js');

function fakeChip() {
  const cls = new Set(['tool-chip', 'pending']);
  const stat = { textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  return { isConnected: true, stat, classList: { contains: c => cls.has(c), add: c => cls.add(c), remove: c => cls.delete(c) }, querySelector: s => (s === '.tc-stat' ? stat : null) };
}

(async () => {
  let timers = [], apiCalls = 0, busy = true, waiting = ['r1'];
  const ctx = vm.createContext({
    activeWs: { id: 'ws1' },
    Channels: { isBusy: id => id === 'ws1' && busy },
    Harness: { api: { get: async p => { apiCalls++; A.eq(p, '/api/connectors', 'the chip reads the connectors status'); return { browserSession: { waitingRunIds: waiting } }; } } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    pendingChips: new Map(), autoscroll() {},
    ensureToolRail: () => ({ appendChild() {} }),
    syncRail() {},   // the rail's folded summary (chat.js syncRail) is not under test here
    chipNode: () => fakeChip()
  });
  vm.runInContext(src.slice(from, to) + '\nthis.toolChip = toolChip;', ctx);
  const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
  const step = async () => { const t = timers.shift(); if (!t) return false; await t.fn(); await settle(); return true; };

  // a live run: the chip checks once a second and says when the run waits on the browser session
  const chip = ctx.toolChip({ callId: 'c1', name: 'browser.open', runId: 'r1' });
  A.eq(timers.length, 1, 'a browser.* chip schedules its first check');
  for (let i = 0; i < 3; i++) await step();
  A.eq(apiCalls, 3, 'while its run is live the chip checks every beat');
  A.eq(chip.stat.textContent, 'Waiting for browser session…', 'and says the run is waiting on the browser session');
  A.ok(timers.length === 1 && timers[0].ms === 1000, 'the next check is one second out');

  // the run ends (stopped) without this call's result: the chip is still pending and still connected
  busy = false;
  const before = apiCalls;
  for (let i = 0; i < 10; i++) await step();
  A.ok(apiCalls - before <= 1, 'after the run ended the orphaned chip stopped reading /api/connectors (it read ' + (apiCalls - before) + ' times in 10 beats)');
  A.eq(timers.length, 0, 'no check is left scheduled');
  A.eq(chip.stat.textContent, '', 'nothing claims the run is still waiting on the browser');
  A.ok(chip.classList.contains('pending'), 'the chip itself is left as it was');

  // a chip born on a run that is already over never polls at all
  timers = []; apiCalls = 0;
  ctx.toolChip({ callId: 'c2', name: 'browser.click', runId: 'r2' });
  for (let i = 0; i < 5; i++) await step();
  A.eq(apiCalls, 0, 'a chip whose run is not live never reads the connectors status');

  // nobody looking (PollGate away): the beat keeps going but skips the read; back on screen it reads again
  timers = []; apiCalls = 0; busy = true; let away = true;
  ctx.PollGate = { away: () => away };
  const awayChip = ctx.toolChip({ callId: 'c4', name: 'browser.open', runId: 'r1' });
  for (let i = 0; i < 5; i++) await step();
  A.eq(apiCalls, 0, 'while away the chip does not read /api/connectors');
  A.eq(timers.length, 1, '…but keeps its beat');
  away = false; await step();
  A.eq(apiCalls, 1, 'back on screen the next beat reads again');
  A.eq(awayChip.stat.textContent, 'Waiting for browser session…', '…and says what the run is waiting on');
  delete ctx.PollGate;

  // a non-browser chip never polls
  timers = []; busy = true;
  ctx.toolChip({ callId: 'c3', name: 'fs.read', runId: 'r3' });
  A.eq(timers.length, 0, 'only browser.* chips wait on the browser session');

  A.report('browser-chip-wait.test');
})().catch(e => { console.error(e); process.exit(1); });
