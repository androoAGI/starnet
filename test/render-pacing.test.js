/* node test/render-pacing.test.js — #69 "Windows laggy after leaving starnet open".

   StarNet is meant to stay open all day so routines run. Measured on the seeded station (headless Chromium on the
   real GPU, 240 Hz panel, window visible but NOT focused — the reporter's exact state):
       before   world drawn 237-240x/s, GPU process ~1.12 cores, renderer ~0.65 cores (10 min soak)
       after    world drawn 4.9x/s, GPU process 0.05-0.09 cores, renderer 0.03-0.04 cores
   Two costs, two locks:
     1. RENDER PACING (world.js): the world loop draws at most 30x/s focused, PACE_BLUR_MS apart when visible but
        unfocused, and the simulation advances in real-time slices while throttled so nothing walks slower.
     2. The compositor: an `infinite` CSS animation repaints the window every vsync. The 7s screen flicker on
        #screen-game becomes a one-shot dip on a clock, and StationUI's MOTION REST holds decorative infinite
        loops still while the window is unfocused and untouched.

   The world is a browser-flow IIFE (no module.exports), so the pacing helpers are lifted out of the source and run
   in a vm sandbox — behaviour, not prose. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const world = fs.readFileSync(path.join(root, 'frontend/app/world.js'), 'utf8');
const stationui = fs.readFileSync(path.join(root, 'frontend/app/stationui.js'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'frontend/css/app.css'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'frontend/css/style.css'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

// ---- 1. the pacing helpers, lifted and run ----------------------------------------------------------------
const from = world.indexOf('  const PACE_FOCUS_MS'), to = world.indexOf('  function renderPace()');
A.ok(from > 0 && to > from && to - from < 8000, 'world.js still carries the RENDER PACING block before renderPace()');
const env = { focused: true, now: 1000, rafs: 0, timers: [] };
const sandbox = {
  document: { hasFocus: () => env.focused },
  performance: { now: () => env.now },
  requestAnimationFrame: () => ++env.rafs,
  cancelAnimationFrame: () => {},
  setTimeout: (fn, ms) => { env.timers.push({ fn, ms }); return env.timers.length; },
  clearTimeout: () => {},
};
vm.createContext(sandbox);
vm.runInContext('let frameCapMs = 0, lastDrawnAt = 0, running = true, raf = 0; function frame() {}\n' + world.slice(from, to) +
  '\nthis.api = { paceMs, simSlices, easeK, scheduleFrame, paceWake, paceEngage, noteDrawCost, budgetMs, resetBudget: () => { drawCostMs = 0; },' +
  ' set: o => { if ("cap" in o) frameCapMs = o.cap; if ("low" in o) paceLowRate = o.low; if ("drawn" in o) lastDrawnAt = o.drawn; if ("raf" in o) raf = o.raf; },' +
  ' timer: () => paceTimer, consts: { PACE_FOCUS_MS, PACE_BLUR_MS, SIM_SLICE_MS, SIM_CATCHUP_MAX_MS, BUDGET_SHARE, BUDGET_MIN_FPS } };', sandbox);
const W = sandbox.api;

A.eq(Math.round(W.paceMs(env.now)), 33, 'focused: the world is drawn at most 30x a second');
env.focused = false;
A.eq(W.paceMs(env.now), W.consts.PACE_BLUR_MS, 'visible but unfocused: the low rate');
A.ok(W.consts.PACE_BLUR_MS >= 100 && W.consts.PACE_BLUR_MS <= 500, 'the low rate is "a few fps", not a stop');
W.paceEngage();
A.eq(Math.round(W.paceMs(env.now)), 33, 'a pointer/key on an unfocused window brings full pace back at once');
env.now += 3000;
A.eq(W.paceMs(env.now), W.consts.PACE_BLUR_MS, '...and the low rate returns once the hand has been gone a while');
W.set({ cap: 48 });
A.eq(W.paceMs(env.now), 48, "a caller's frame cap (HUD widget) is its stated intent and wins over the blur rate");
W.set({ cap: 0 });

// simulation truth: a throttled draw must still advance real time, in steps the engine was built for
W.set({ low: true });
const sl = W.simSlices(200, 5000), sum = sl.reduce((s, [d]) => s + d, 0);
A.ok(Math.abs(sum - 200) < 1e-9, 'low rate: the slices add up to the real elapsed time (no slow-motion world)');
A.ok(sl.every(([d]) => d <= W.consts.SIM_SLICE_MS + 1e-9 && d < 64), 'every slice stays under the 64ms step clamp');
A.eq(sl[sl.length - 1][1], 5000, 'the last slice lands on this frame\'s own timestamp');
A.ok(sl.every(([, t], i) => i === 0 || t > sl[i - 1][1]), 'slice timestamps move forward');
A.eq(W.simSlices(30000, 5000).length, 1, 'a long gap (the page was hidden) keeps the old freeze — no catch-up teleport');
A.eq(W.simSlices(30000, 5000)[0][0], 64, '...as one clamped 64ms step');
W.set({ low: false });
A.eq(JSON.stringify(W.simSlices(200, 5000)), JSON.stringify([[64, 5000]]), 'at draw rate the step is the old single clamped dt (focused behaviour unchanged)');
A.eq(JSON.stringify(W.simSlices(16, 5000)), JSON.stringify([[16, 5000]]), 'a normal frame is one step of its own dt');

// FRAME BUDGET (2026-10-07): an expensive draw stretches the interval so the world keeps at most BUDGET_SHARE of the
// main thread; a cheap one changes nothing; one stall cannot park the loop; the floor never drops below BUDGET_MIN_FPS
env.focused = true; env.now += 10000;
for (let i = 0; i < 60; i++) W.noteDrawCost(10);
A.eq(Math.round(W.paceMs(env.now)), 33, 'a 10ms draw: the 30 fps pace is untouched (budget 14ms < 33ms)');
for (let i = 0; i < 60; i++) W.noteDrawCost(30);
A.ok(Math.abs(W.paceMs(env.now) - 30 / W.consts.BUDGET_SHARE) < 0.5, 'a 30ms draw: the interval stretches to drawCost / share');
A.ok(30 / W.paceMs(env.now) <= W.consts.BUDGET_SHARE + 0.01, '...so the world holds at most its share of the thread');
for (let i = 0; i < 200; i++) W.noteDrawCost(500);
A.ok(Math.abs(W.paceMs(env.now) - 1000 / W.consts.BUDGET_MIN_FPS) < 1e-9, 'a pathological draw cost still draws BUDGET_MIN_FPS times a second');
W.resetBudget(); for (let i = 0; i < 60; i++) W.noteDrawCost(10);
W.noteDrawCost(5000);
A.ok(W.paceMs(env.now) < 40, 'one 5s stall (a restore from minimized) nudges the budget, it does not park the loop');
W.resetBudget(); for (let i = 0; i < 80; i++) W.noteDrawCost(56);
A.ok(W.budgetMs() > 64, 'a budget past the 64ms step clamp...');
W.set({ low: false });
const bs = W.simSlices(80, 9000);
A.ok(bs.length > 1 && Math.abs(bs.reduce((t, [d]) => t + d, 0) - 80) < 1e-9, '...advances the simulation in real-time slices (no slow motion)');
W.resetBudget();
A.eq(JSON.stringify(W.simSlices(200, 5000)), JSON.stringify([[64, 5000]]), 'with no budget the focused step is the old clamped dt again');

// a per-frame ease tuned at 60 Hz keeps its wall-clock speed at any draw rate
A.ok(Math.abs(W.easeK(0.08, 1000 / 60) - 0.08) < 1e-12, 'easeK at 60 Hz is the original constant');
const two60 = 1 - Math.pow(1 - 0.08, 2);
A.ok(Math.abs(W.easeK(0.08, 2000 / 60) - two60) < 1e-12, 'one 30 fps frame eases as far as two 60 Hz frames');

// scheduling: the low rate waits in a timer (no 240 Hz rAF spin); the draw rate books rAF; a wake skips the wait
env.timers.length = 0; env.rafs = 0;
W.set({ drawn: env.now, raf: 0 });
W.scheduleFrame(W.consts.PACE_BLUR_MS);
A.eq(env.timers.length, 1, 'low rate books a timer...');
A.eq(env.rafs, 0, '...not a rAF');
A.ok(env.timers[0].ms > 150 && env.timers[0].ms <= W.consts.PACE_BLUR_MS, 'the timer waits out the pace interval');
W.paceWake();
A.eq(env.rafs, 1, 'a wake (focus/input/visible) drops the wait and books the next vsync');
A.eq(W.timer(), 0, '...with no timer left behind');
W.set({ raf: 0 });
W.scheduleFrame(1000 / 30);
A.eq(env.rafs, 2, 'draw rate books rAF directly');

// ---- 2. the loop is wired through the pacer ------------------------------------------------------------------
const code = strip(world);
const frameSrc = A.fnBody(code, 'function frame(now, force)');
A.ok(frameSrc && frameSrc.length < 3000, 'frame(now, force) is the paced loop entry');
A.ok(!/requestAnimationFrame\(frame\)/.test(frameSrc), 'frame() never books raw rAF itself — scheduleFrame owns the booking');
A.ok(frameSrc.lastIndexOf('scheduleFrame(pace)') > 0 && frameSrc.lastIndexOf('scheduleFrame(pace)') < frameSrc.indexOf('frameBody(now)'),
  'the next frame is booked BEFORE the body runs (a throwing frame cannot kill the loop)');
const bodySrc = A.fnBody(code, 'function frameBody(now)');
A.ok(/simSlices\(gap, now\)/.test(bodySrc), 'frameBody derives its simulation steps from simSlices');
A.ok(/for \(const \[d, t\] of slices\) \{ fnow = t; tick\(d, t\); \}/.test(bodySrc), 'a throttled draw ticks every slice');
A.ok(/drawScene\(now, dt, slices\)/.test(bodySrc), 'the conveyor sim gets the same slices');
const sceneSrc = A.fnBody(code, 'function drawScene(now, dt, slices)');
A.ok(/for \(const \[d, t\] of slices\) convey\.tick\(d, t,/.test(sceneSrc), 'crates ride in real time while throttled');
A.ok(/redrawNow\(\)\s*\{[\s\S]{0,120}cancelScheduled\(\);\s*frame\(performance\.now\(\), true\)/.test(code), 'a resize repaint is forced through the pacer and cancels any booking');
A.ok(/function stop\(\)\s*\{[^}]*cancelScheduled\(\)/.test(code), 'stop() cancels a pending low-rate timer too');
A.ok(/addEventListener\('focus', paceWake\)/.test(code) && /if \(!document\.hidden\) paceWake\(\)/.test(code), 'focus and becoming visible wake the loop');
A.ok(/\['pointermove', 'pointerdown', 'wheel', 'keydown'\]\) window\.addEventListener\(ev, paceEngage/.test(code), 'input on the window engages full pace');
A.ok(/renderPace,/.test(code), 'World.renderPace() is exported for live verification');
A.ok(/finally \{\s*noteDrawCost\(performance\.now\(\) - drawStart\)/.test(frameSrc) && frameSrc.indexOf('const drawStart = performance.now()') < frameSrc.indexOf('frameBody(now)'),
  'every draw (a throwing one included) reports its real cost to the frame budget');

// ---- 3. compositor: no infinite full-screen flicker; decorative loops rest while unfocused --------------------
const appCode = strip(appCss);
A.ok(!/#screen-game\.active\s*\{[^}]*animation:[^}]*infinite/.test(appCode), 'the station screen carries no infinite animation');
A.ok(/body:not\(\.no-flicker\) #screen-game\.active \{ isolation: isolate; \}/.test(appCode), 'flicker-on keeps the stacking context the running animation always made');
A.ok(/#screen-game\.active\.flick-dip \{ animation: flick-dip 280ms 1; \}/.test(appCode), 'the dip is a one-shot');
A.ok(/@keyframes flick-dip \{ 0%,100% \{ opacity: 1; \} 25% \{ opacity: 0\.84; \} 50% \{ opacity: 0\.95; \} \}/.test(styleCss), 'flick-dip is the old 96..100% tail (same opacities)');
const ui = strip(stationui);
const clock = A.fnBody(ui, 'function armFlickerClock()');
A.ok(/setInterval\([\s\S]*7000\)/.test(clock) && /classList\.add\('flick-dip'\)/.test(clock) && /no-flicker/.test(clock), 'the flicker clock plays one dip per 7s and honours SCREEN FLICKER off');
const sweep = A.fnBody(ui, 'function motionSweep()');
A.ok(/t\.iterations !== Infinity\) continue/.test(sweep), 'MOTION REST only ever holds INFINITE loops (one-shots that others await always finish)');
A.ok(/isConnected\) restingAnims\.delete/.test(sweep), 'a held loop whose node left the page is dropped, not kept alive all day');
A.ok(/!document\.hasFocus\(\)/.test(A.fnBody(ui, 'function motionAtRest()')), 'rest is gated on the window being unfocused');
A.ok(/addEventListener\('focus', motionEngage\)/.test(ui), 'focus resumes every held loop');
A.ok(/armFlickerClock\(\); armMotionRest\(\);/.test(ui), 'applySettings arms both clocks');

A.report('render pacing (#69)');
