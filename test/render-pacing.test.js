/* node test/render-pacing.test.js — #69 "Windows laggy after leaving starnet open".

   StarNet is meant to stay open all day so routines run. Measured on the seeded station (headless Chromium on the
   real GPU, 240 Hz panel, window visible but NOT focused — the reporter's exact state):
       before   world drawn 237-240x/s, GPU process ~1.12 cores, renderer ~0.65 cores (10 min soak)
       after    world drawn 4.9x/s, GPU process 0.05-0.09 cores, renderer 0.03-0.04 cores
   Two costs, two locks:
     1. RENDER PACING (world.js): the world loop draws at most 60x/s while visible (focused or not), up to 144x/s while
        the user moves the camera, and stops when hidden. Andrew 2026-10-13 on 0.13.5: the old 5 fps unfocused tier
        ("less than 5 FPS when you're not clicked in") and the 30 fps cap (camera judder on a 239 Hz panel) were the lag.
        A slow draw still stretches the interval (FRAME BUDGET) and the simulation advances in real-time slices.
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
const from = world.indexOf('  const PACE_VISIBLE_MS'), to = world.indexOf('  function renderPace()');
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
vm.runInContext('let frameCapMs = 0, lastDrawnAt = 0, running = true, menuPaused = false, raf = 0, camUserAt = 0; function frame() {}\n' + world.slice(from, to) +
  '\nthis.api = { paceMs, simSlices, easeK, scheduleFrame, paceWake, userActive, cameraMoved, camUser: () => camUserAt, noteDrawCost, budgetMs, resetBudget: () => { drawCostMs = 0; },' +
  ' noteStrain, strain: () => ({ strained, strainProbe, strainDraws }), strainConsts: { STRAIN_ENTER_MS, STRAIN_EXIT_MS, STRAIN_SETTLE_DRAWS, STRAIN_PROBE_DRAWS, STRAIN_EXIT_PROBES },' +
  ' set: o => { if ("cap" in o) frameCapMs = o.cap; if ("low" in o) paceLowRate = o.low; if ("drawn" in o) lastDrawnAt = o.drawn; if ("raf" in o) raf = o.raf; },' +
  ' timer: () => paceTimer, consts: { PACE_VISIBLE_MS, PACE_MOTION_MS, PACE_MOTION_HOLD_MS, SIM_SLICE_MS, SIM_CATCHUP_MAX_MS, BUDGET_SHARE, BUDGET_MIN_FPS } };', sandbox);
const W = sandbox.api;

A.eq(Math.round(W.paceMs(env.now)), 17, 'visible and focused: the world is drawn at most 60x a second');
env.focused = false;
A.eq(Math.round(W.paceMs(env.now)), 17, 'visible but NOT focused: the same 60x a second (Andrew 10-13: no 5 fps when you are not clicked in)');
W.cameraMoved();
A.ok(W.paceMs(env.now) < 8 && Math.abs(W.paceMs(env.now) - W.consts.PACE_MOTION_MS) < 1e-9, 'moving the camera draws up to the motion pace (~144x a second)');
env.now += W.consts.PACE_MOTION_HOLD_MS + 1;
A.eq(Math.round(W.paceMs(env.now)), 17, '...and the visible 60x pace returns once the hand stops');
env.now += 5000;
W.userActive();
A.eq(W.camUser(), env.now, 'any hand on the window re-stamps the idle-camera clock: the auto-director never takes the camera while you work');
A.eq(Math.round(W.paceMs(env.now)), 17, '...without changing the pace (only moving the camera lifts it)');
W.set({ cap: 48 });
A.eq(W.paceMs(env.now), 48, "a caller's frame cap (HUD widget) is its stated intent and wins over the visible pace");
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
A.eq(Math.round(W.paceMs(env.now)), 17, 'a 10ms draw: the 60 fps pace is untouched (budget 14ms < 17ms)');
for (let i = 0; i < 60; i++) W.noteDrawCost(30);
A.ok(Math.abs(W.paceMs(env.now) - 30 / W.consts.BUDGET_SHARE) < 0.5, 'a 30ms draw: the interval stretches to drawCost / share');
A.ok(30 / W.paceMs(env.now) <= W.consts.BUDGET_SHARE + 0.01, '...so the world holds at most its share of the thread');
for (let i = 0; i < 200; i++) W.noteDrawCost(500);
A.ok(Math.abs(W.paceMs(env.now) - 1000 / W.consts.BUDGET_MIN_FPS) < 1e-9, 'a pathological draw cost still draws BUDGET_MIN_FPS times a second');
W.resetBudget(); for (let i = 0; i < 60; i++) W.noteDrawCost(10);
W.noteDrawCost(5000);
A.ok(W.paceMs(env.now) < 60, 'one 5s stall (a restore from minimized) nudges the budget, it does not park the loop');
for (let i = 0; i < 30; i++) W.noteDrawCost(10);
A.eq(Math.round(W.paceMs(env.now)), 17, '...and thirty cheap draws (about half a second) later the 60 fps pace is back');
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

// scheduling: a budget-floor rate (a very slow machine) waits in a timer (no 240 Hz rAF spin); the draw rate books rAF;
// a wake skips the wait
const FLOOR_MS = 1000 / W.consts.BUDGET_MIN_FPS;
env.timers.length = 0; env.rafs = 0;
W.set({ drawn: env.now, raf: 0 });
W.scheduleFrame(FLOOR_MS);
A.eq(env.timers.length, 1, 'the budget-floor rate books a timer...');
A.eq(env.rafs, 0, '...not a rAF');
A.ok(env.timers[0].ms > 150 && env.timers[0].ms <= FLOOR_MS, 'the timer waits out the pace interval');
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
A.ok(/\['pointermove', 'pointerdown', 'wheel', 'keydown'\]\) window\.addEventListener\(ev, userActive/.test(code), 'any input on the window counts as the user being here');
A.ok(!/pageFocused|hasFocus|PACE_BLUR|engagedUntil/.test(A.fnBody(code, 'function paceMs(now)')), 'the pace never depends on window focus (visible = full pace)');
A.ok(!/'blur'/.test(A.fnBody(code, 'function renderPace()')), 'renderPace has no blur mode any more');
A.ok((code.match(/cameraMoved\(\);/g) || []).length >= 2, 'a wheel zoom and a drag pan both lift the pace to the motion rate');
A.ok(/vsyncMs/.test(frameSrc) && /pace - Math\.max\(1, Math\.min\(vsyncMs/.test(frameSrc), 'frame() rounds the pace to the nearest whole vsync (60 on a 144 Hz panel is 72, not 48)');
A.ok(/renderPace,/.test(code), 'World.renderPace() is exported for live verification');
A.ok(/finally \{\s*if \(cache === bakedBefore\) \{\s*noteDrawCost\(performance\.now\(\) - drawStart\);\s*noteStrain\(performance\.now\(\) - drawStart\);/.test(frameSrc)
  && frameSrc.indexOf('const drawStart = performance.now(), bakedBefore = cache') < frameSrc.indexOf('frameBody(now)'),
  'every draw that did not bake the station (a throwing one included) reports its real cost to the frame budget and the strain band');

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

// ---- 3. STRAINED DETAIL (2026-10-10, "1 frame per hour — can't navigate") ----------------------------------------
// a floor draw that can't hold the budget sheds the crew's extra passes; full detail returns only on measured proof
{
  const S = W.strainConsts;
  // the draw costs what the mode it ran in costs: `full` at full detail (and on a probe), `lite` while strained
  const run = (n, full, lite) => { let probes = 0; for (let i = 0; i < n; i++) { const st = W.strain(), ms = st.strained && !st.strainProbe ? lite : full; if (st.strained && st.strainProbe) probes++; W.noteDrawCost(ms); W.noteStrain(ms); } return probes; };
  W.resetBudget();
  run(200, 14, 14);
  A.eq(W.strain().strained, false, 'a healthy station (14 ms a draw) never sheds detail');
  A.ok(S.STRAIN_ENTER_MS > 20 && S.STRAIN_ENTER_MS < 33, 'strain begins where the budget would hold the floor under ~25-30 fps');
  run(10, 120, 50);
  A.eq(W.strain().strained, true, 'a weak machine (120 ms a draw) sheds detail');
  const probes = run(S.STRAIN_PROBE_DRAWS * 6, 120, 50);
  A.ok(probes >= 5 && probes <= 7, 'while strained, one draw in STRAIN_PROBE_DRAWS is a timed full-detail probe');
  A.eq(W.strain().strained, true, '...and a probe that is still too slow keeps it strained (no flapping on the cheap draws)');
  A.ok(S.STRAIN_EXIT_MS > 22 && S.STRAIN_EXIT_MS < S.STRAIN_ENTER_MS * 0.95, 'the exit line lets a 22 ms floor back but stays clear of the entry line');
  run(S.STRAIN_PROBE_DRAWS * 4, 26.5, 12);   // freed up, but a full draw (26.5 ms) is still within 10% of the entry line
  A.eq(W.strain().strained, true, 'a full draw just under the entry line is not proof enough: it stays strained');
  A.ok(S.STRAIN_EXIT_PROBES >= 2, 'one lucky probe is never enough to leave');
  run(S.STRAIN_PROBE_DRAWS * (S.STRAIN_EXIT_PROBES + 1), 12, 8);    // the machine freed up (a scan finished, a window closed)
  A.eq(W.strain().strained, false, 'full-detail probes in a row that fit comfortably bring full detail back');
  W.resetBudget(); run(200, 14, 14);
  A.eq(W.strain().strained, false, '...and it stays back');
}

// ---- 4. A STATION BAKE IS NOT THE FLOOR'S DRAW COST (review world-render-01) -------------------------------------
// The boot bake (and every room/font/recovery re-bake) is a one-off ~2.5 s on a big floor. Fed into the budget it seeded the
// EMA at the 250 ms cap, STRAINED DETAIL switched on at draw 11, and a floor whose full draw is 22 ms (fine at 30 fps, but over
// the 19.6 ms exit line) never earned its way back: crew lost walk frames, pose dissolve and body light for the session.
// The real frame() and rebake() run here against a clock the stubs advance.
const rebakeSrc = A.fnBody(code, 'function rebake()');
A.ok(rebakeSrc && /StationBake\.bake\(geo\)/.test(rebakeSrc), 'rebake() is the one place the station bake runs');
// a floor whose every draw (full detail, lite or probe) costs clk.drawMs, and whose station bake costs 2.5 s
function floorSim() {
  const clk = { now: 0, drawMs: 22 };
  const sb = { document: { hasFocus: () => true }, performance: { now: () => clk.now }, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    setTimeout: () => 1, clearTimeout: () => {}, console, clk,
    StationBake: { bake: () => { clk.now += 2500; return { doorOccluders: [] }; } } };
  vm.createContext(sb);
  vm.runInContext('let frameCapMs = 0, lastDrawnAt = 0, running = true, menuPaused = false, raf = 0, renderFaults = 0, lastFaultMsg = "", reviewParts = null, reviewStamp = 0;\n' +
    'const RENDER_FAULT_LIMIT = 30, reviewPerformance = { enabled: false, samples: [] };\n' +
    'let station = {}, geo = {}, cache = null, geoDirty = false, bakeDirty = true, bakedAnchorKey = null, handedBake = null;\n' +
    'function buildHoldsFloor() { return false; } function rederive() {} function fixtureAnchorKey() { return ""; } function recordBakeProbe() {} function drawRenderFault() {}\n' +
    'function frameBody(now) { if (bakeDirty || !cache) rebake(); clk.now += clk.drawMs; }\n' +
    world.slice(from, to) + '\n' + rebakeSrc + '\n' + frameSrc +
    '\nthis.F = { frame, strained: () => strained, cost: () => drawCostMs, edit: () => { bakeDirty = true; } };', sb);
  const F = sb.F;
  return { clk, F, draw: n => { for (let i = 0; i < n; i++) F.frame(clk.now, true); } };
}
{
  const { clk, F, draw } = floorSim();
  draw(1);
  A.ok(F.cost() < 30, 'the boot frame that baked the station does not seed the frame budget (' + F.cost().toFixed(1) + ' ms)');
  draw(200);
  A.eq(F.strained(), false, 'a 22 ms floor after a 2.5 s boot bake keeps full detail');
  A.ok(Math.abs(F.cost() - 22) < 0.5, '...and its budget is its real draw cost');
  F.edit(); draw(1); draw(60);
  A.eq(F.strained(), false, 'a room edit that re-bakes mid-session does not tip it into STRAINED DETAIL either');
  clk.drawMs = 60; draw(40);
  A.eq(F.strained(), true, 'a floor that really draws slowly still sheds detail (the bake exclusion hides nothing else)');
}

// ---- 5. A HITCH IS NOT A SLOW FLOOR (review world-render-01 follow-up) -------------------------------------------
// One non-bake frame of 83 ms or more (a GC pause, a page-in after a restore from minimized, a props-only edit's
// rederive, a texture pyramid built on the first zoom-out) lifted the EMA of a 22 ms floor over the entry line. Its
// probes then measured 22 ms, never under the 19.6 ms exit line, so the crew stayed strained for the session.
{
  const { clk, F, draw } = floorSim();
  draw(201);
  A.eq(F.strained(), false, 'a 22 ms floor boots at full detail');
  let shed = 0;
  const watch = n => { for (let i = 0; i < n; i++) { draw(1); if (F.strained()) shed++; } };
  clk.drawMs = 250; watch(1); clk.drawMs = 22; watch(200);
  A.eq(shed, 0, 'one 250 ms frame that baked nothing does not shed detail even for a moment (no blink of crew light)');
  clk.drawMs = 250; draw(5); clk.drawMs = 22;   // a stall five frames long: the floor really was slow for a moment
  A.eq(F.strained(), true, 'a stall several frames long does shed detail');
  draw(200);
  A.eq(F.strained(), false, '...and probes at the floor\'s own 22 ms bring full detail back');
  shed = 0; watch(3000);
  A.eq(shed, 0, '...for good');
}

A.report('render pacing (#69)');
