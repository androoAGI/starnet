/* test/helpers/loop-stall.js — a real event-loop stall, and a wait bounded by loop TURNS, for timer-sensitive tests.

   Why (pending register, 11-01): gate tests went red whenever the box was loaded, on trunk as well as on lanes.
     R4  test/shell.fg-ledger.test.js case 1b slept a fixed 50 ms for a fake command's root exit (5 ms) to be
         stamped by a deferred 10 ms timer. Under a stall both timers and the sleep fall due in one pass and the check
         runs before the stamp: 'expected ["record","exited"], got ["record"]' (wave1-candidate-fast-2.log,
         merge-back-dbe15aef7-fast.log).
     R8  test/run-spend-pool.test.js 'held <shape>, liveness sweep' swept a 150 ms stall threshold every 15 ms on
         the real clock. Under load a worker whose call was only waiting for room was stopped as stalled:
         'expected [], got ["sub-child_7"]' (A/B under load: lane red 4 of 8, trunk 1 of 8).
   A fixed sleep and a real-clock threshold both assume the loop keeps time. These do not:
     stallNow(ms)   blocks THIS thread's event loop for ms with Atomics.wait on a private cell: a real stall that
                    burns no CPU, so every gate run can afford one while other work shares the box. Returns the
                    measured ms.
     stallSoon(ms)  the same stall, fired from a timer (setTimeout 0). Resolves with the measured ms.
     waitFor(cond, { turns = 200, everyMs = 25 })
                    checks cond now and again after each of `turns` timer turns (everyMs 0: setImmediate turns).
                    Resolves true as soon as cond() holds, false when the turns run out. The bound is a COUNT of
                    turns, never a deadline: a stalled loop makes it wait longer, it can never make it give up sooner.
   A case that fires one stallSoon at its weakest point and still asserts its verdict proves, on every run, that the
   verdict does not depend on the loop's timing. */
'use strict';

// Nothing ever notifies this cell, so every wait on it runs to its timeout.
const cell = new Int32Array(new SharedArrayBuffer(4));

function stallNow(ms) {
  const t0 = performance.now();
  Atomics.wait(cell, 0, 0, Math.max(0, Number(ms) || 0));
  return Math.round(performance.now() - t0);
}

function stallSoon(ms) {
  return new Promise((resolve) => { setTimeout(() => resolve(stallNow(ms)), 0); });
}

async function waitFor(cond, opts) {
  const o = opts || {};
  const turns = o.turns != null ? Math.max(0, Math.floor(Number(o.turns) || 0)) : 200;
  const everyMs = o.everyMs != null ? Math.max(0, Number(o.everyMs) || 0) : 25;
  const turn = everyMs > 0
    ? () => new Promise((r) => setTimeout(r, everyMs))
    : () => new Promise((r) => setImmediate(r));
  if (cond()) return true;
  for (let i = 0; i < turns; i++) {
    await turn();
    if (cond()) return true;
  }
  return false;
}

module.exports = { stallNow, stallSoon, waitFor };
