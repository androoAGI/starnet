/* test/_assert.js — zero-dep assertion helpers + a fake U.bus, matching the
   err()-counter + process.exit(fail?1:0) convention used by the v7 headless tests.
   Each test file: run assertions, then call report() last. */
'use strict';

let fail = 0, pass = 0;
const err = m => { fail++; console.log('FAIL: ' + m); };

function ok(cond, msg) { if (cond) pass++; else err(msg || 'expected truthy value'); }

function eq(actual, expected, msg) {
  const A = JSON.stringify(actual), B = JSON.stringify(expected);
  if (A === B) pass++; else err((msg || 'eq') + ' — expected ' + B + ', got ' + A);
}

function throws(fn, msg) {
  try { fn(); err((msg || 'throws') + ' — did not throw'); }
  catch (e) { pass++; }
}

function notThrows(fn, msg) {
  try { fn(); pass++; }
  catch (e) { err((msg || 'notThrows') + ' — threw: ' + (e && e.message)); }
}

/* a fake bus mirroring frontend/js/util.js U.bus: handler throws are swallowed. */
function makeBus() {
  const h = {};
  return {
    _h: h,
    on(ev, fn) { (h[ev] = h[ev] || []).push(fn); },
    emit(ev, data) { (h[ev] || []).forEach(fn => { try { fn(data); } catch (e) { /* swallowed, as in U.bus */ } }); }
  };
}

/* subscribe to the given event names; returns an array filled in emit order. */
function collectBus(bus, names) {
  const log = [];
  for (const n of names) bus.on(n, payload => log.push({ name: n, payload }));
  return log;
}

const { fnBody } = require('./_fnbody');   // lives in its own module (node:test files use it without the runner)

let reported = false;

/* A FAILURE OUTSIDE THE COUNTERS IS STILL A FAILURE (2026-11-08). A test whose catch flags the throw with
   process.exitCode = 1 and then reaches report() used to print "OK (n assertions)" and exit 0, because report()
   exits with its own count: forget.phone.http read green that way after it threw before asserting anything. So a
   failing exit code already set when report() runs counts as a problem: no OK, exit 1. */
function report(title) {
  reported = true;
  const prior = process.exitCode;
  if (prior !== undefined && prior !== null && prior !== 0 && prior !== '0') {
    err('the test had already failed outside its assertions (process.exitCode ' + prior + ' before report(): usually a throw its catch flagged'
      + (pass === 0 ? ', before any assertion ran' : '') + ')');
  }
  console.log((title || 'tests') + ': ' + (fail ? (fail + ' problem(s), ' + pass + ' ok') : ('OK (' + pass + ' assertions)')));
  process.exit(fail ? 1 : 0);
}

/* SILENT-EARLY-EXIT GUARD (2026-07-25). Calling report() is necessary but not sufficient: a file can EXIT
   BEFORE reaching it and still leave exit code 0, so the runner scores it green having verified nothing.
   That is not hypothetical — it happened while adding a browser test here. Node's event loop can drain
   mid-await when the only thing outstanding is an unref'd timer (the CDP client unrefs its timeout timers),
   and an un-awaited async IIFE has the same effect. Both look identical to the runner: no output, exit 0.
   So: if any assertion ran and the process leaves with a success code without report() having been called,
   turn it red and say why. A test whose asserts never finished is a failing test, not a passing one. */
process.on('exit', (code) => {
  if (reported || code !== 0) return;
  if (pass === 0 && fail === 0) return;   // a file that asserted nothing is some other lint's problem
  console.log('FAIL: the test process exited before report() was reached — ' + pass + ' assertion(s) had run.');
  console.log('      Exit code 0 here would be scored GREEN having verified nothing. Usual causes: an');
  console.log('      un-awaited async block, or the event loop draining while only unref\'d timers remain');
  console.log('      (hold it open with a setInterval for the duration of the wait).');
  process.exitCode = 1;
});

module.exports = { ok, eq, throws, notThrows, makeBus, collectBus, report, fnBody, fails: () => fail };
