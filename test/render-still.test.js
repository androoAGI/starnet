/* node test/render-still.test.js — the STILL tier of RENDER PACING (world.js).

   Andrew, 2026-10-21 (approved): "draw 30/s while nothing on screen moves, snap back to 60 the instant anything moves
   (144 while panning)". The installed 0.13.5 idled at 178% of a core, 96% of it DRAWING an unchanged station 60x a second.
   The contract this file locks:
     1. a still scene is redrawn 30x a second, waiting in a timer (no per-vsync rAF spin) — and mode 'still' says so;
     2. anything that moves is drawn at the normal pace from the very next vsync: 60, or 144 while the hand pans;
     3. motion that STARTS between still frames never waits out the 33 ms tick — a body whose idle clock, fidget or talk
        turn comes due mid-interval, a decision whose first step lands on the next tick, and a wake from outside the
        frame (input, a harness event, a World API call) all land on the next vsync;
     4. every motion source the frame knows about flips the still flag (unsure is motion: a prop whose art moves on its
        clock, a bobbing body, a meteor, a bubble sliding with its body even off screen), the ambient ones (an off-screen
        body with nothing over it, float dust, a static speech bubble, a planted body's sub-pixel breath, a cold belt) do
        not, and every clock the inner life gates on is either due in the verdict or exempt for a reason;
     5. the wait costs ONE rAF callback per draw (4f): stillBookAt books the vsync that draws, from a timer a Windows tick late
        too, and the verdict books again from its own answer, so a due change a vsync or two out no longer spins rAF;
     6. ...on every panel, not just 60 Hz (4g): the margin a timer is allowed to be late is MEASURED from the still timers
        (the whole tick until they have been seen), so a clock on time costs one callback a draw at 144 and 239 Hz too, and a
        clock a tick late still never costs a draw its vsync.
   The world is a browser IIFE: the pacer block, the verdict block and frame() are lifted out of the source and run in a vm
   sandbox on a fake vsync clock — behaviour, not prose. The prop / sky / sprite readouts the verdict reads are proven by
   test/render-still-readouts.test.js. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const world = fs.readFileSync(path.join(root, 'frontend/app/world.js'), 'utf8');
const assets = fs.readFileSync(path.join(root, 'frontend/js/assets.js'), 'utf8');
const ghostline = fs.readFileSync(path.join(root, 'frontend/app/ghostline.js'), 'utf8');
const util = fs.readFileSync(path.join(root, 'frontend/js/util.js'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
const code = strip(world);

// ---- the lifted source --------------------------------------------------------------------------------------------
const pFrom = world.indexOf('  const PACE_VISIBLE_MS'), pTo = world.indexOf('  function renderPace()');
const vFrom = world.indexOf('  /* STILL VERDICT'), vTo = world.indexOf('  // ---- end STILL VERDICT');
A.ok(pFrom > 0 && pTo > pFrom && pTo - pFrom < 16000, 'world.js carries the RENDER PACING block before renderPace()');   // a slicing sanity bound (+ THE TIMER MARGIN)
A.ok(vFrom > pTo && vTo > vFrom && vTo - vFrom < 24000, 'world.js carries the STILL VERDICT block after renderPace()');
const renderPaceSrc = A.fnBody(world, '  function renderPace()');
const frameSrc = A.fnBody(code, 'function frame(now, force)');
const isTalkKindSrc = A.fnBody(code, 'function isTalkKind(kind)');
A.ok(renderPaceSrc && frameSrc && frameSrc.length < 3000 && isTalkKindSrc, 'renderPace(), the paced frame(now, force) and isTalkKind are found');
// the inner-life constants the verdict reads, taken from world.js itself (never re-typed here)
const num = name => {
  const m = world.match(new RegExp('\\b' + name + ' = ([0-9][0-9 *+/.]*)[;,]'));
  A.ok(!!m, name + ' is a world.js constant');
  return m ? Function('return (' + m[1] + ')')() : NaN;
};
const K = {};
for (const n of ['TALK_SLOT_MS', 'TALK_SPEAK_MS', 'GATHER_SPEAK_MS', 'GATHER_GAP_MS', 'GATHER_QUIET_MS', 'OVERSEER_BREAK_MS', 'CURSOR_FRESH_MS', 'LINK_STALE_MS']) K[n] = num(n);

// the world state the verdict reads, as sandbox globals (var = settable from the test)
const PRELUDE = `
var frameCapMs = 0, lastDrawnAt = 0, running = true, raf = 0, camUserAt = 0;
var renderFaults = 0, lastFaultMsg = '', reviewParts = null, reviewStamp = 0, cache = {};
var RENDER_FAULT_LIMIT = 30, reviewPerformance = { enabled: false, samples: [] };
var scale = 2, panX = 0, panY = 0, cv = { width: 800, height: 600 }, T = 12;
var agent = null, crew = [], camAnim = null, camLerp = null, camLock = null, geo = null, beltLiveSet = null;
var convey = null, ghost = null, handoffBoxes = [], sendCrates = [], deskFlash = new Map(), dockFlashes = new Map();
var pinFlourishAt = -1e9, firstShipPulse = null, awakeFrozen = false, arrivalScene = null, kindleArmed = false, kindleP = 0, floodAt = 0;
var wakeDark = 0, wakeDarkTarget = 0, dawnAt = 0, sparkAt = 0, bornAt = 0, truthPulseAt = 0, wakeAt = 0, levelUpAt = 0;
var cineHoldUntil = 0, cineWalkAt = -1e9, cineIdleMs = 120000, socialBeat = null, gathering = null;
var FLASH_MS = 950, HANDOFF_GRACE_MS = 8000;
var activity = 'idle', lastCursor = { wx: 0, wy: 0, t: -1e9 }, gatherGateUntil = -1e9, stationBusyAt = -1e9, gatherRollAt = -1e9;
var chatFocusId = null, chatWarmUntil = -1e9, stillPass = null, linkStaleDim = false, lastSseEventAt = 0, rmOn = false;
var overlaysOn = true, hoverAgent = null, palletPopAt = -1e9;
${Object.entries(K).map(([k, v]) => 'var ' + k + ' = ' + v + ';').join(' ')}
function reduceMotion() { return rmOn; }
${isTalkKindSrc}
var bodyPosX = b => b ? (b.seated ? b.seatPx : b.px) : 0, bodyPosY = b => b ? (b.seated ? b.seatPy : b.py) : 0;
var propUse = p => (p && p.use) || null;
var scene = { step() {} };
function drawRenderFault() {}
function frameBody(now) { stillBegin(); scene.step(now); stillVerdict(now); }
`;
const EXPOSE = `
this.W = { paceMs, scheduleFrame, paceWake, motionWake, userActive, cameraMoved, renderPace, stillBegin, stillVerdict, stillMove, noteDue, frame,
  noteDrawCost, resetBudget: () => { drawCostMs = 0; },
  yieldToUi, stillBookAt, noteTimerLate: typeof noteTimerLate === 'function' ? noteTimerLate : null, setBook: o => { if ('vsyncMs' in o) vsyncMs = o.vsyncMs; if ('stillDue' in o) stillDue = o.stillDue; if ('lastDrawnAt' in o) lastDrawnAt = o.lastDrawnAt; },
  st: () => ({ stillNow, stillWhy, stillDue, paceTimer, inputAt, motionUntil, vsyncMs, stillFrames }),
  consts: { PACE_VISIBLE_MS, PACE_MOTION_MS, PACE_STILL_MS, PACE_MOTION_HOLD_MS, INPUT_HOLD_MS, BODY_CLOCKS } };`;

// opts.timerLate: every setTimeout fires this many ms late (a Windows / WebView2 system tick is ~15.6 ms); a function of the wall
// time at booking makes the lateness change mid-run · opts.timerTick: a quantised clock - a timer fires on the first system tick
// (this many ms apart) at or after its time · opts.pacer(src) / opts.verdict(src): rewrite the lifted pacer / verdict block (a
// mutation check: the old rule must fail) · opts.extra: more real world.js source (lifted functions + their stubs), run in the same sandbox
function makeWorld(hz, opts) {
  opts = opts || {};
  const env = { now: 0, rafQ: [], timers: [], tid: 0, rafCalls: 0, draws: [], hz };
  const P = 1000 / hz, lateAt = typeof opts.timerLate === 'function' ? opts.timerLate : () => opts.timerLate || 0, tick = opts.timerTick || 0;
  const sb = {
    console, Map, Set, Math, Object, Infinity, NaN,
    document: { hasFocus: () => true },
    performance: { now: () => env.now },
    requestAnimationFrame: fn => { env.rafQ.push(fn); return env.rafQ.length + 1000; },
    cancelAnimationFrame: () => { env.rafQ.length = 0; },
    setTimeout: (fn, ms) => {
      const id = ++env.tid, due = env.now + Math.max(0, ms);
      env.timers.push({ id, at: tick ? Math.ceil(due / tick - 1e-9) * tick : due + lateAt(env.now), fn }); return id;
    },
    clearTimeout: id => { env.timers = env.timers.filter(t => t.id !== id); },
  };
  vm.createContext(sb);
  const pacer = opts.pacer ? opts.pacer(world.slice(pFrom, pTo)) : world.slice(pFrom, pTo);
  const verdict = opts.verdict ? opts.verdict(world.slice(vFrom, vTo)) : world.slice(vFrom, vTo);
  vm.runInContext(PRELUDE + pacer + '\n' + renderPaceSrc + '\n' + verdict + '\n' + frameSrc + '\n' + (opts.extra || '') + '\n' + EXPOSE, sb);
  const W = sb.W;
  // the event loop: timers fire at their time; rAF callbacks run on the next vsync boundary (k * P)
  const actions = [];   // test-side events at a wall time: { at, fn }
  let vk = 1;           // the index of the next vsync to deliver (counted, so an event landing ON a boundary can't skip it)
  function runUntil(t) {
    for (let guard = 0; guard < 1e6; guard++) {
      const nextV = vk * P;
      let nextT = Infinity, ti = -1;
      for (let i = 0; i < env.timers.length; i++) if (env.timers[i].at < nextT) { nextT = env.timers[i].at; ti = i; }
      let nextA = Infinity, ai = -1;
      for (let i = 0; i < actions.length; i++) if (actions[i].at < nextA) { nextA = actions[i].at; ai = i; }
      const next = Math.min(nextV, nextT, nextA);
      if (next > t) { env.now = t; return; }
      env.now = next;
      if (next === nextA) { const a = actions.splice(ai, 1)[0]; a.fn(); continue; }
      if (next === nextT && nextT < nextV) { const tm = env.timers.splice(ti, 1)[0]; tm.fn(); continue; }
      vk++;
      const q = env.rafQ.splice(0);
      for (const fn of q) { env.rafCalls++; fn(env.now); }
    }
    throw new Error('event loop did not settle');
  }
  // run on to the next draw and stop just after it: the returned time is that draw, and the clock is within 0.5 ms of it
  function toNextDraw() { const n = env.draws.length; while (env.draws.length === n) runUntil(env.now + 0.5); return env.draws[env.draws.length - 1]; }
  const firstVsyncAtOrAfter = t => Math.ceil(t / P - 1e-9) * P;
  return { sb, W, env, P, runUntil, toNextDraw, firstVsyncAtOrAfter, at: (t, fn) => actions.push({ at: t, fn }) };
}
const count = (arr, a, b) => arr.filter(t => t >= a && t < b).length;

// a body the scene sim moves: idle until its clock comes due, then walks 30 world px/s; drawBody's readouts held constant.
// glanceCd: Infinity — a hero whose glance cooldown is far off (a lapsed one rolls every tick: motion, see section 7)
function body(over) {
  return Object.assign({ id: 'a', px: 200, py: 150, dir: 'south', state: 'idle', idleUntil: Infinity, glanceCd: Infinity, _pose: 'set.rot.south', _renderFrame: 0 }, over || {});
}
function walkerScene(w, b) {
  let last = 0;
  w.sb.scene = { step(now) {
    w.env.draws.push(now);
    const dt = last ? now - last : 0; last = now;
    if (b.state === 'idle' && now >= b.idleUntil) { b.state = 'walk'; b.walkFrom = now; }
    if (b.state === 'walk') b.px += 0.03 * dt;
  } };
}

// ---- 1. a still scene is drawn 30x a second, from a timer --------------------------------------------------------
{
  const w = makeWorld(60), b = body();
  w.sb.agent = b; walkerScene(w, b);
  w.W.frame(0);
  w.runUntil(1000);
  const raf0 = w.env.rafCalls;
  w.runUntil(2000);
  const n = count(w.env.draws, 1000, 2000);
  A.ok(n >= 29 && n <= 31, 'a still station is redrawn 30x a second (' + n + ' draws in 1 s on a 60 Hz panel)');
  A.ok(w.env.rafCalls - raf0 <= 31, '...each one booked from a timer: no per-vsync rAF spin while still (' + (w.env.rafCalls - raf0) + ' callbacks)');
  const rp = w.W.renderPace();
  A.eq(rp.mode, 'still', "renderPace().mode reads 'still' — the bench and telemetry can prove the tier");
  A.ok(Math.abs(rp.paceMs - 33.3) < 0.1 && rp.still === true && rp.stillWhy === null, '...at the 30/s pace, with no motion source named');
  A.ok(rp.stillFrames >= 29 && typeof rp.stillWhyCounts === 'object', '...and it counts the frames it judged still (' + rp.stillFrames + '), for a bench window');
  // the wait between still draws (THE STILL TICK'S TIMER): a timer to just past the vsync before the draw, then the one booked
  // rAF that lands it — the rAF tail is part of the wait (one callback, at the draw), never a spin
  let inTimer = 0, inTail = 0;
  for (let i = 0; i < 100; i++) { w.runUntil(w.env.now + 1); if (w.W.renderPace().timerWait) inTimer++; else if (w.sb.raf) inTail++; }
  A.ok(inTimer >= 45 && inTimer + inTail >= 99, '...waiting between draws: in a timer ' + inTimer + '% of the time, then in the one booked rAF that lands the draw (' + inTail + '%)');
  A.ok(Math.abs(w.W.st().vsyncMs - 1000 / 60) < 0.5, 'a timer-booked callback is never learned as a vsync (vsyncMs stays ' + w.W.st().vsyncMs.toFixed(2) + ' ms)');
}

// ---- 1b. exactly 30/s while still, even when the timers run late (Andrew approved exactly 30/s) -------------------------
// Windows / WebView2 timers can fire a ~15.6 ms system tick late. The still tick's timer wakes a vsync early and rAF lands
// the draw, so the still pace holds; with on-time timers it books one rAF callback per still draw, as before.
{
  const stillRate = (hz, opts) => {
    const w = makeWorld(hz, opts), b = body();
    w.sb.agent = b; walkerScene(w, b);
    w.W.frame(0); w.runUntil(1000);
    const d0 = w.env.draws.length, r0 = w.env.rafCalls;
    w.runUntil(3000);
    return { per: (w.env.draws.length - d0) / 2, cb: (w.env.rafCalls - r0) / 2, mode: w.W.renderPace().mode };
  };
  for (const lag of [4, 15.6]) {
    const r = stillRate(60, { timerLate: lag });
    A.ok(r.per >= 28 && r.per <= 31 && r.mode === 'still', 'timers ' + lag + ' ms late, 60 Hz: a still station is still drawn ~30x a second (' + r.per + '/s)');
    A.ok(r.cb <= r.per + 0.5, '...with one rAF callback per still draw (' + r.cb + ' callbacks/s)');
  }
  // (144 Hz: the vsync nearest 33.3 ms is the 5th, 34.7 ms — frame()'s half-vsync rule — so ~28.8/s there, as before)
  for (const hz of [60, 144]) {
    const r = stillRate(hz);
    A.ok(r.per >= (hz === 60 ? 29 : 28) && r.per <= 31 && r.cb <= r.per + 0.5, 'on-time timers, ' + hz + ' Hz: ~30 still draws/s (' + r.per + ') and no extra rAF callbacks (' + r.cb + '/s)');
  }
  // the timer aims at the vsync frame() itself draws on: its slack is frame()'s skip rule, byte for byte
  const slack = (world.slice(pFrom, pTo).match(/function drawSlackMs\(\) \{ return (Math\.max\(1, Math\.min\(vsyncMs \|\| 2, 17\) \/ 2\)); \}/) || [])[1];
  A.ok(!!slack && frameSrc.includes('now - lastDrawnAt < pace - ' + slack + ')'), "the still tick timer's slack (drawSlackMs) is frame()'s own skip rule (" + slack + ')');
  // MUTATION CHECK: the old tick timer (2 ms before the draw) loses a vsync to any timer over 2 ms late
  const OLD_TICK = src => src.replace('still ? stillBookAt(pace) - now : 0', 'still ? lastDrawnAt + pace - 2 - now : 0');
  A.ok(OLD_TICK(world.slice(pFrom, pTo)) !== world.slice(pFrom, pTo), '(the mutation check finds the still tick timer in scheduleFrame)');
  const old = stillRate(60, { timerLate: 4, pacer: OLD_TICK });
  A.ok(old.per < 25, 'MUTATION CHECK — the old tick timer, timers 4 ms late: the still pace fell to ' + old.per + '/s');
}

// ---- 2. motion is drawn at the normal pace ------------------------------------------------------------------------
{
  const w = makeWorld(60), b = body({ idleUntil: 0 });
  w.sb.agent = b; walkerScene(w, b);
  w.W.frame(0);
  w.runUntil(2000);
  const n = count(w.env.draws, 1000, 2000);
  A.ok(n >= 59 && n <= 61, 'a walking body is drawn 60x a second (' + n + ')');
  A.eq(w.W.renderPace().mode, 'visible', "...in the 'visible' mode");
  A.eq(w.W.st().stillWhy, 'body', "...and the verdict names the body as the motion");
  const c = w.W.renderPace().stillWhyCounts;
  A.ok(c.body >= 100, '...and counts the frames the body kept moving (' + JSON.stringify(c) + ')');
}

// ---- 3. the hand panning: 144x a second, then back to still --------------------------------------------------------
{
  const w = makeWorld(144), b = body();
  w.sb.agent = b; walkerScene(w, b);
  w.W.frame(0);
  w.runUntil(1000);
  A.eq(w.W.renderPace().mode, 'still', 'a 144 Hz panel at rest is still');
  for (let t = 1000; t < 2000; t += 3) w.at(t, () => { w.sb.panX += 1; w.W.cameraMoved(); });   // a drag: mousemove every 3 ms
  w.runUntil(2000);
  const n = count(w.env.draws, 1100, 2000);
  A.ok(n >= 128 && n <= 131, 'while the hand pans, the floor is drawn 144x a second (' + n + ' in 0.9 s on a 144 Hz panel)');
  A.eq(w.W.renderPace().mode, 'motion', "...in the 'motion' mode");
  w.runUntil(2000 + w.W.consts.PACE_MOTION_HOLD_MS + 500);
  const t0 = w.env.now; w.runUntil(t0 + 1000);
  const s = count(w.env.draws, t0, t0 + 1000);
  A.ok(s >= 27 && s <= 31, 'the hand lets go, the hold runs out, and the still scene drops back to ~30/s (' + s + ')');
  A.eq(w.W.renderPace().mode, 'still', "...in the 'still' mode");
}

// ---- 4. a body whose idle clock comes due MID-INTERVAL walks on the next vsync ------------------------------------------
{
  const w = makeWorld(60), b = body();
  w.sb.agent = b; walkerScene(w, b);
  w.W.frame(0);
  w.runUntil(1000);
  A.ok(w.W.st().stillNow, 'the floor is still before the walk');
  const L = w.toNextDraw();
  // the decision is set on the scene (the inner life's idleUntil) BEFORE the next still frame, due between two still ticks
  b.idleUntil = L + 45;   // still ticks would land at L+33.3 and L+66.7; the first vsync at/after the clock is L+50
  w.runUntil(L + 200);
  const after = w.env.draws.filter(t => t > L + 34);
  A.ok(Math.abs(after[0] - (L + 50)) < 0.01, 'the body starts walking ON the first vsync after its clock (drawn at +' + (after[0] - L).toFixed(1) + ' ms, not +66.7)');
  A.ok(b.state === 'walk' && b.walkFrom === after[0], '...and that very draw is the one that shows it walking');
  const gaps = after.slice(1, 6).map((t, i) => t - after[i]);
  A.ok(gaps.every(g => Math.abs(g - 1000 / 60) < 0.01), '...followed at the normal 60/s pace (' + gaps.map(g => g.toFixed(1)).join(' ') + ')');
}

// ---- 4b. what else starts between still frames: a fidget, a talk turn, a decision whose step lands next tick ------------
{
  // (a) the hero at a prop: maybeGlance's fidget comes due 3 ms after a still draw → drawn on the first vsync (+16.7, not +33.3).
  // The inner life arms it inside a tick (a frame), as maybeGlance does: here, the draw at/after armAt sets nextFidget = now + 3.
  const w = makeWorld(60), b = body({ goal: 'use', glanceCd: 0, nextFidget: Infinity });
  w.sb.agent = b;
  let armAt = Infinity, L = null;
  w.sb.scene = { step(now) {
    w.env.draws.push(now);
    if (b.goal === 'use' && now >= b.nextFidget) { b.dir = 'west'; b.fidgetAt = now; b.nextFidget = now + 4000; }
    if (now >= armAt && L == null) { L = now; b.nextFidget = now + 3; }
  } };
  w.W.frame(0); w.runUntil(1000);
  A.ok(w.W.st().stillNow, 'the hero standing at a prop, fidget not due, is still');
  armAt = w.env.now;
  w.runUntil(armAt + 200);
  const next = w.env.draws.find(t => t > L);
  A.ok(Math.abs(next - (L + 1000 / 60)) < 0.01 && b.fidgetAt === next, 'a fidget due 3 ms after a still draw is drawn on the first vsync (+' + (next - L).toFixed(1) + ' ms; the still tick is +33.3)');
}
{
  // (b) a talking huddle: the next speaker's turn opens between still frames → its mouth moves on that vsync
  const w = makeWorld(60), hero = body({ id: 'h' }), mate = body({ id: 'm', px: 220 });
  w.sb.agent = hero; w.sb.crew = [mate];
  const S = K.TALK_SLOT_MS, SP = K.TALK_SPEAK_MS;
  let setupAt = null;
  w.sb.scene = { step(now) {
    w.env.draws.push(now);
    if (setupAt == null && now >= 500) {   // the encounter settles into its hold: slot 0's mouth time is already over
      setupAt = now;
      w.sb.socialBeat = { startedAt: now - SP - 10, until: now + 1e6, lastArrivalAt: now - SP - 10 };
      for (const [i, bd] of [hero, mate].entries()) bd.social = { phase: 'hold', kind: 'huddle', holdAt: now - SP - 10, holdLen: 1e6, seat: i };
    }
    const sbt = w.sb.socialBeat;
    if (sbt) for (const bd of [hero, mate]) {   // talkTurn: seat k talks for the first SPEAK ms of every k-th slot
      const e = now - sbt.startedAt, k = Math.floor(e / S);
      bd.talking = bd.speaking = (k % 2) === bd.social.seat && e - k * S < SP;
      if (bd.talking && bd.talkFrom == null) bd.talkFrom = now;
    }
  } };
  w.W.frame(0); w.runUntil(900);
  const open = w.sb.socialBeat.startedAt + S;   // slot 1 (the mate's) opens here
  A.ok(open > 900 && hero.talkFrom == null && mate.talkFrom == null, 'the huddle sits in the silence between turns (slot 1 opens at ' + open.toFixed(1) + ')');
  A.ok(w.W.st().stillNow, '...and the silence is still');
  w.runUntil(open + 100);
  A.ok(Math.abs(mate.talkFrom - w.firstVsyncAtOrAfter(open)) < 0.01, "the mate's mouth moves on the first vsync of its turn (+" + (mate.talkFrom - open).toFixed(1) + ' ms after the slot opens)');
}
{
  // (c) a decision frame: the encounter is DECIDED on a due vsync (only goal + plan change); stepSocial paths it on the NEXT tick
  const w = makeWorld(60), b = body({ goal: null });
  w.sb.agent = b;
  let last = 0, decidedAt = null;
  w.sb.scene = { step(now) {
    w.env.draws.push(now);
    const dt = last ? now - last : 0; last = now;
    if (b.state === 'walk') b.px += 0.03 * dt;
    if (b.goal === 'social' && b.social.phase === 'walk' && b.state !== 'walk') { b.state = 'walk'; b.target = { x: 400, y: 150 }; b.walkFrom = now; }
    if (b.goal == null && now >= b.idleUntil) { b.goal = 'social'; b.social = { phase: 'walk' }; b.idleUntil = Infinity; decidedAt = now; }
  } };
  w.W.frame(0); w.runUntil(1000);
  const L = w.toNextDraw();
  b.idleUntil = L + 45;
  const x0 = b.px;
  w.runUntil(L + 300);
  A.ok(Math.abs(decidedAt - (L + 50)) < 0.01, 'the encounter is decided on the first vsync after its clock (+' + (decidedAt - L).toFixed(1) + ' ms)');
  A.ok(Math.abs(b.walkFrom - (decidedAt + 1000 / 60)) < 0.01, '...and the walk it starts is drawn the very next vsync (+' + (b.walkFrom - decidedAt).toFixed(1) + ' ms after the decision; the still tick is +33.3)');
  const firstStep = w.env.draws.find(t => t > b.walkFrom);
  A.ok(Math.abs((firstStep - b.walkFrom) - 1000 / 60) < 0.01, '...at the normal pace from its first step (' + (firstStep - b.walkFrom).toFixed(1) + ' ms, so no step covers two ticks of ground)');
  A.ok(b.px > x0, '(the body really walked)');
}

// ---- 4c. what the 10-21 review found the tier slowing or delaying ------------------------------------------------------
{
  // (a) a crew body walking OFF screen with its speech bubble up: drawBubble clamps the bubble to the canvas edge and it slides
  // with the body (setActivityFor's 'working…' lasts 4.2 s while a summoned body walks to an off-camera desk) → normal pace
  const w = makeWorld(60), mate = body({ id: 'm', px: -400, py: 100, state: 'walk', say: { text: 'working…', until: 1e9 } });
  w.sb.crew = [mate];
  let last = 0;
  w.sb.scene = { step(now) { w.env.draws.push(now); const dt = last ? now - last : 0; last = now; mate.py += 0.03 * dt; } };
  w.W.frame(0); w.runUntil(1000); w.runUntil(2000);
  const n = count(w.env.draws, 1000, 2000);
  A.ok(n >= 59 && n <= 61 && w.W.st().stillWhy === 'speech', 'a body walking off screen with its bubble up is drawn 60x a second (' + n + ', ' + w.W.st().stillWhy + '): the clamped bubble slides along the edge');
  mate.say = { text: '', until: 0 };
  w.runUntil(3000);
  A.eq(w.W.renderPace().mode, 'still', '...and once the bubble is gone the off-screen walker changes nothing you can see: still');
}
{
  // (b) an OFF-SCREEN initiator's decision starts an ON-SCREEN partner walking (planHuddle / a border meeting write the
  // partner's plan): its clock comes due mid-interval, and the partner's first step is drawn on the first vsync after it
  const w = makeWorld(60);
  const init = body({ id: 'off', px: -60, py: 150 });   // 60 world px past the left edge (the pad is 48), inside SOCIAL_NEAR_RADIUS
  const partner = body({ id: 'on', px: 20, py: 150 });
  w.sb.crew = [init, partner];
  let last = 0, decidedAt = null;
  w.sb.scene = { step(now) {
    w.env.draws.push(now);
    const dt = last ? now - last : 0; last = now;
    if (now >= init.idleUntil && decidedAt == null) { decidedAt = now; init.idleUntil = Infinity; partner.state = 'walk'; partner.walkFrom = now; }
    if (partner.state === 'walk') partner.px += 0.03 * dt;
  } };
  w.W.frame(0); w.runUntil(1000);
  A.ok(w.W.st().stillNow, 'an off-screen initiator and its idle on-screen partner are still');
  const L = w.toNextDraw();
  init.idleUntil = L + 45;   // still ticks: L+33.3, L+66.7; the first vsync at/after the clock is L+50
  w.runUntil(L + 200);
  A.ok(Math.abs(decidedAt - (L + 50)) < 0.01, "the off-screen initiator's decision lands on the first vsync after its clock (+" + (decidedAt - L).toFixed(1) + ' ms, not +66.7)');
  A.ok(partner.walkFrom === decidedAt && w.env.draws.includes(decidedAt), '...and that draw shows the on-screen partner starting to walk');
}
{
  // (c) the hero's voice starts 3 ms after a still draw: voice.js flips isSpeaking from the audio element's 'play' callback and
  // calls World.voiceChanged (→ motionWake), so the talk track is drawn on the next vsync, not the next still tick
  const w = makeWorld(60), hero = body({ id: 'hero' });
  let speaking = false, mouthAt = null;
  w.sb.agent = hero; w.sb.Voice = { isListening: () => false, isSpeaking: () => speaking };
  w.sb.scene = { step(now) { w.env.draws.push(now); if (speaking && mouthAt == null) mouthAt = now; } };
  w.W.frame(0); w.runUntil(1000);
  A.ok(w.W.st().stillNow, 'a quiet hero is still');
  const L = w.toNextDraw();
  w.at(L + 3, () => { speaking = true; w.W.motionWake(); });   // Voice.onSpeakStart → setSpeaking → World.voiceChanged()
  w.runUntil(L + 200);
  A.ok(Math.abs(mouthAt - (L + 1000 / 60)) < 0.01, 'the voice starting between frames is drawn on the next vsync (+' + (mouthAt - L).toFixed(1) + ' ms; the still tick is +33.3)');
  const L2 = w.toNextDraw();
  A.eq(w.W.st().stillWhy, 'speech', '...and the floor keeps the normal pace while it speaks');
  w.at(L2 + 4, () => { speaking = false; w.W.motionWake(); });   // onSpeakEnd: the mouth stops and a voice-held bubble vanishes
  w.runUntil(L2 + 100);
  const after = w.env.draws.find(t => t > L2 + 4);
  A.ok(Math.abs(after - (L2 + 1000 / 60)) < 0.01, '...and its end is drawn on the next vsync too (+' + (after - L2).toFixed(1) + ' ms)');
  const wcode = strip(world);
  A.ok(/voiceChanged: \(\) => \{ motionWake\(\); \}/.test(wcode), 'World.voiceChanged is the wake voice.js calls (test/render-still-wakes.test.js boots the real voice.js)');
}
{
  // (d) a planted body breathing (the hero standing idle in the default view): the sub-pixel breath is _renderDrift, not
  // motion — the scene is still at 30/s, and every one of those frames draws the breath at its true phase
  const w = makeWorld(60), hero = body({ id: 'hero', _renderDrift: true, _renderLive: false });
  w.sb.agent = hero; walkerScene(w, hero);
  w.W.frame(0); w.runUntil(1000); w.runUntil(2000);
  const n = count(w.env.draws, 1000, 2000);
  A.ok(n >= 29 && n <= 31 && w.W.renderPace().mode === 'still', 'a hero standing and breathing is drawn 30x a second (' + n + ') — it was 60, so the tier never engaged with a body on screen');
  hero.say = { text: 'hello', until: 2600 };
  w.runUntil(2500);
  const m = count(w.env.draws, 2050, 2500);
  A.ok(m >= 26 && w.W.st().stillWhy === 'speech', '...but with a bubble over its head (which rounds to whole px as the head swells) it keeps the normal pace (' + m + ' draws in 450 ms)');
}

// ---- 4d. a due change is met by rAF, never by a timer that can fire a Windows tick late (final fixes 10-21) ------------
// The scene arms a body's idle clock d ms after a draw (inside the frame, as the inner life does); its walk must be drawn on
// the first vsync at/after the clock, whatever the timers do. WebView2 on Windows can fire a timer a whole ~15.6 ms system
// tick late: the old rule (a timer 2 ms before the change) then missed the vsync and drew the change a frame late.
// The mutation helpers below rewrite the lifted source back to a rule the booking replaced (4d's pre-10-21 rule, 4f's checks).
const BOOK_EXPR = 'still ? stillBookAt(pace) - now : 0';
const REBOOK_FROM = 'const booked = performance.now();', REBOOK_TO = 'scheduleFrame(paceMs(booked)); }';
const rebookText = src => { const a = src.indexOf(REBOOK_FROM), b = src.indexOf(REBOOK_TO); return a > 0 && b > a ? src.slice(a, b + REBOOK_TO.length) : null; };
const MUTE = {
  // the pre-10-21 rule: the still wait's timer aims 2 ms before the change (inside the last vsync too), and a frame's verdict
  // re-books only a timer that would fire after the change
  old: {
    pacer: src => src.replace(BOOK_EXPR, 'still ? Math.min(lastDrawnAt + pace, stillDue) - now - 2 : 0'),
    verdict: src => { const t = rebookText(src); return t ? src.replace(t, 'if (paceTimer && paceTimerAt && (!stillNow || stillDue < paceTimerAt)) paceWake();') : src; },
  },
  // stillBookAt without the due branch: only the 30/s tick is booked, so a change due before it waits for the tick
  noDue: { pacer: src => src.replace('if (kD <= kT) aimK', 'if (false) aimK') },
  // the verdict books nothing: the callback frame() booked before the draw, from the previous verdict, stands
  noRebook: { verdict: src => src.replace('else if (paceTimer ? paceTimerAt : raf) { cancelScheduled(); scheduleFrame(paceMs(booked)); }', '') },
};
function dueRun(d, opts) {
  const w = makeWorld(60, opts), b = body();
  w.sb.agent = b;
  let last = 0, armAt = Infinity, L = null;
  w.sb.scene = { step(now) {
    w.env.draws.push(now);
    const dt = last ? now - last : 0; last = now;
    if (b.state === 'idle' && now >= b.idleUntil) { b.state = 'walk'; b.walkFrom = now; }
    if (b.state === 'walk') b.px += 0.03 * dt;
    if (now >= armAt && L == null) { L = now; b.idleUntil = now + d; }
  } };
  w.W.frame(0); w.runUntil(1000);
  armAt = w.env.now;
  w.runUntil(armAt + d + 200);
  return { w, L, at: b.walkFrom, want: w.firstVsyncAtOrAfter(L + d) };
}
{
  const OLD = MUTE.old;
  A.ok(OLD.pacer(world.slice(pFrom, pTo)) !== world.slice(pFrom, pTo) && OLD.verdict(world.slice(vFrom, vTo)) !== world.slice(vFrom, vTo),
    "(the mutation check finds the still booking in scheduleFrame and the verdict's re-book)");
  // +60 ms: the change is known a still tick ahead, so the draw before it books the wait toward it
  const old = dueRun(60, Object.assign({ timerLate: 15.6 }, OLD));
  A.ok(old.at - old.want > 1, 'MUTATION CHECK — the old rule, timers 15.6 ms late: a change due +60 ms is drawn a vsync late (+' + (old.at - old.L).toFixed(1) + ' ms; its vsync is +' + (old.want - old.L).toFixed(1) + ')');
  A.ok(old.w.W.renderPace().dueLate === 1, "...and renderPace's dueLate counts it (the readout catches a miss)");
  for (const d of [60, 10]) {
    const r = dueRun(d, { timerLate: 15.6 });
    A.ok(Math.abs(r.at - r.want) < 0.01, 'timers 15.6 ms late: a change due +' + d + ' ms lands on its vsync (+' + (r.at - r.L).toFixed(1) + ' ms) — rAF, not a timer, covers the last vsync before it');
    const rp = r.w.W.renderPace();
    A.ok(rp.dueDraws === 1 && rp.dueLate === 0 && rp.dueLatMaxMs <= 1000 / 60 && rp.dueLatAvgMs === rp.dueLatMaxMs, '...and renderPace reads it: one due change drawn, none late (latency ' + rp.dueLatMaxMs + ' ms)');
  }
  const miss = [], lateCount = [];
  for (const lag of [0, 4, 15.6]) for (let d = 1; d <= 400; d += d < 60 ? 2.3 : 17.9) {
    const x = dueRun(d, { timerLate: lag });
    if (!(Math.abs(x.at - x.want) < 0.01)) miss.push(lag + 'ms late, due +' + d.toFixed(1) + ' → drawn +' + (x.at - x.L).toFixed(1) + ' (want +' + (x.want - x.L).toFixed(1) + ')');
    if (x.w.W.renderPace().dueLate) lateCount.push(lag + '/' + d.toFixed(1));
  }
  A.ok(!miss.length, 'SWEEP — due +1..400 ms, timers on time, 4 ms and 15.6 ms late: every change lands on the first vsync at/after it' + (miss.length ? ' — missed: ' + miss.slice(0, 6).join('; ') : ''));
  A.ok(!lateCount.length, '...and renderPace counts none of them late' + (lateCount.length ? ' — ' + lateCount.slice(0, 6).join(', ') : ''));
  // the long still wait stays a timer: a still floor with nothing due spins no rAF, even with late timers
  const w = makeWorld(60, { timerLate: 15.6 }), b = body();
  w.sb.agent = b; walkerScene(w, b);
  w.W.frame(0); w.runUntil(1000);
  const d0 = w.env.draws.length, r0 = w.env.rafCalls;
  w.runUntil(3000);
  const dn = w.env.draws.length - d0, rn = w.env.rafCalls - r0;
  A.ok(rn <= dn + 1 && w.W.renderPace().mode === 'still', 'the long still wait is still a timer: one rAF callback per still draw, no spin (' + rn + ' callbacks, ' + dn + ' draws in 2 s, timers 15.6 ms late)');
  // the lead on a due change is j vsyncs, derived: a timer STILL_TIMER_LATE_MS late (one Windows tick) must still land its rAF
  // before the vsync that draws the change, and j is the fewest vsyncs that does it (1 at 60 Hz; the panels above it ride rAF
  // for the last j - 1 vsyncs, as the old lead window did). Asked of the real stillBookAt, with the change due AT the tick's vsync, per panel.
  const late = num('STILL_TIMER_LATE_MS'), after = num('TICK_AFTER_VSYNC_MS');
  A.ok(late === 15.6 && after === 0.5, 'a timer is assumed up to 15.6 ms late (one Windows system tick) and wakes 0.5 ms past its vsync (' + late + ', ' + after + ')');
  const jOf = { 60: 1, 75: 2, 120: 2, 144: 3, 240: 4 };
  for (const hz of Object.keys(jOf)) {
    const P = 1000 / hz, bw = makeWorld(60).W, PACE_STILL = bw.consts.PACE_STILL_MS;
    bw.setBook({ vsyncMs: P, lastDrawnAt: 5000 });
    const kT = Math.ceil((PACE_STILL - Math.max(1, P / 2)) / P - 1e-9), kD = kT;   // the change is due AT the tick's vsync: the due branch books it
    bw.setBook({ stillDue: 5000 + (kD - 0.5) * P });
    // (0 = no timer: j reaches the draw's own vsync, so a bare rAF now rides every vsync up to it — 75 Hz books its tick that way)
    const aim = bw.stillBookAt(PACE_STILL), fire = aim === 0 ? 5000 : aim, j = kD - (aim === 0 ? 0 : Math.round((aim - 0.5 - 5000) / P));
    A.eq(j, jOf[hz], hz + ' Hz: the due change is booked ' + jOf[hz] + ' vsync(s) early (' + j + ')');
    A.ok(fire + late < 5000 + kD * P, '...so a timer ' + late + ' ms late still fires before the vsync that draws it (fires at +' + (fire + late - 5000).toFixed(1) + ' ms, the vsync is +' + (kD * P).toFixed(1) + ')');
    A.ok(j === 1 || fire + P + late >= 5000 + kD * P, '...and no earlier than that needs: one vsync later would let it miss');
    bw.setBook({ stillDue: Infinity });
    A.ok(Math.abs(bw.stillBookAt(PACE_STILL) - (5000 + (kT - 1) * P + after)) < 1e-6, '...and with nothing due the tick alone is booked: a hair past the vsync before it');
  }
}

// ---- 4f. ONE rAF PER DRAW: the still floor books the vsync that draws, not every vsync it waited out (idle renderer) ------
// P7 (the idle station, ?idleRenderer on) booked ~2 rAF callbacks per drawn still frame: 59 + 27 rAF/s for 30.5 draws/s. A scene
// that books a due change d ms after EVERY draw (a clock-driven pose, a blink, a twinkle step: noteDue) reproduces it, from two causes:
//  (a) frame() books the next frame BEFORE the draw, from the previous verdict. After a due draw that verdict's stillDue is already
//      past, so the booking was a bare rAF at the next vsync that the pace check only skipped;
//  (b) within a vsync + 4 ms of a due change the rule was rAF every vsync, and the timer aimed a whole vsync before the one that draws.
// stillBookAt now aims the timer at the vsync before the one that draws, and the verdict books again from the fresh verdict.
const dueScene = (w, d) => { w.sb.scene = { step(now) { w.env.draws.push(now); w.W.noteDue(now + d, now); } }; };
function rafRun(hz, lag, d, opts) {
  const w = makeWorld(hz, Object.assign({ timerLate: lag }, opts || {}));
  w.sb.agent = body(); dueScene(w, d);
  w.W.frame(0); w.runUntil(1000);
  const d0 = w.env.draws.length, r0 = w.env.rafCalls, rp0 = w.W.renderPace();
  w.runUntil(5000);
  const rp = w.W.renderPace(), n = w.env.draws.length - d0;
  return { w, n, perS: n / 4, rafPerDraw: (w.env.rafCalls - r0) / n, skipped: rp.skippedFrames - rp0.skippedFrames, dueLate: rp.dueLate - rp0.dueLate, mode: rp.mode };
}
const rafRow = (lag, d, r) => lag + ' ms late, due +' + d + ': ' + r.perS + ' draws/s, ' + r.rafPerDraw.toFixed(2) + ' rAF/draw, ' + r.skipped + ' skipped, ' + r.dueLate + ' late';
{
  const book = A.fnBody(code, 'function scheduleFrame(pace)');
  A.ok(book && /still \? stillBookAt\(pace\) - now : 0/.test(book) && !/dueLeadMs|DUE_LEAD_SLACK_MS|stillTickTimerAt/.test(code),
    'scheduleFrame books the still wait with stillBookAt; the old lead window (dueLeadMs) and tick timer are gone');
  A.ok(/now < yieldUntil \? yieldUntil - now : pace >= PACE_TIMER_MIN_MS \? lastDrawnAt \+ pace - now - 2/.test(book) && /\n\s*else raf = requestAnimationFrame\(frame\);/.test(book),
    'the yield, the >= 100 ms timer and the non-still branches (plain rAF at a draw-rate pace) are untouched');
  const D = [20, 30, 40, 55, 66, 100, 400];
  // THE INVARIANT: whatever is due, the 30/s floor costs one callback per draw, and the change still lands on its own vsync
  for (const lag of [0, 4, 15.6]) {
    const rows = D.map(d => [d, rafRun(60, lag, d)]);
    const bad = rows.filter(([, r]) => !(r.perS >= 29 && r.perS <= 31 && r.rafPerDraw <= 1.05 && r.skipped <= 0.02 * r.n && r.dueLate === 0));
    const worst = Math.max(...rows.map(([, r]) => r.rafPerDraw));
    A.ok(!bad.length, '60 Hz, timers ' + lag + ' ms late, a change due +20..+400 ms after every draw: ~30 draws/s, ONE rAF per draw (worst ' + worst.toFixed(2) + '), none skipped, none late'
      + (bad.length ? ' — ' + bad.slice(0, 3).map(([d, r]) => rafRow(lag, d, r)).join('; ') : ''));
  }
  // a change due inside one vsync is drawn at the normal pace from the next vsync: 60 draws/s, one callback each, nothing waits
  for (const lag of [0, 15.6]) for (const d of [8, 15]) {
    const r = rafRun(60, lag, d);
    A.ok(r.perS >= 59 && r.perS <= 61 && r.rafPerDraw <= 1.05 && r.dueLate === 0 && r.skipped <= 0.02 * r.n, '60 Hz, timers ' + lag + ' ms late, a change due +' + d + ' ms after every draw: 60 draws/s, one rAF each — ' + rafRow(lag, d, r));
  }
  // 144 Hz: until the timers have been seen the last vsyncs before a due change ride rAF (j = 3 at most), never worse than the old lead
  // window; the change lands on time. (This first second is the seed: 4g proves the margin then comes down to ONE rAF a draw.)
  for (const lag of [0, 4]) {
    const rows = [8, 15].concat(D).map(d => [d, rafRun(144, lag, d)]);
    const bad = rows.filter(([, r]) => !(r.dueLate === 0 && r.rafPerDraw <= 3.05 && r.perS >= 28));
    A.ok(!bad.length, '144 Hz, timers ' + lag + ' ms late: every due change lands on its vsync (none late), at most 3 rAF per draw, the 30/s tick holds'
      + (bad.length ? ' — ' + bad.slice(0, 3).map(([d, r]) => rafRow(lag, d, r)).join('; ') : ''));
  }
  {   // (the corner nobody fixes: a timer a whole system tick late on a 144 Hz panel already cost the old rule its 30/s tick, 20.5/s; this one is no worse)
    const rows = [8, 15].concat(D).map(d => [d, rafRun(144, 15.6, d)]);
    const bad = rows.filter(([, r]) => !(r.perS >= 20 && r.rafPerDraw <= 3.05));
    A.ok(!bad.length, '144 Hz, timers 15.6 ms late: never worse than the old rule (>= 20 draws/s, <= 3 rAF per draw)' + (bad.length ? ' — ' + bad.slice(0, 3).map(([d, r]) => rafRow(15.6, d, r)).join('; ') : ''));
  }
  // exactly one booking is alive after every draw: one timer or one rAF, never both, never none
  for (const [lag, d] of [[0, 8], [0, 30], [15.6, 55], [4, 400]]) {
    const w = makeWorld(60, { timerLate: lag }); w.sb.agent = body(); dueScene(w, d);
    w.W.frame(0); w.runUntil(1000);
    let bad = 0, timers = 0;
    for (let i = 0; i < 60; i++) { w.toNextDraw(); const alive = w.env.rafQ.length + w.env.timers.length; if (alive !== 1) bad++; if (w.env.timers.length) timers++; }
    A.ok(bad === 0, 'after each of 60 still draws (timers ' + lag + ' ms late, due +' + d + '): exactly one booking is alive (' + bad + ' draws with none or two; ' + timers + ' booked a timer)');
  }
  // a wake from outside the frame, right after a re-booked draw, lands on the next vsync whatever the re-booked callback is (a bare rAF, or a timer it drops)
  for (const [d, lag, want] of [[8, 0, 'rAF'], [20, 0, 'timer'], [20, 15.6, 'timer'], [100, 15.6, 'timer'], [400, 0, 'timer']]) {
    const w = makeWorld(60, { timerLate: lag }); w.sb.agent = body(); dueScene(w, d);
    w.W.frame(0); w.runUntil(1000);
    const L = w.toNextDraw(), kind = w.W.renderPace().timerWait ? 'timer' : w.sb.raf ? 'rAF' : 'none';
    w.at(L + 5, () => w.W.motionWake());
    w.runUntil(L + 100);
    const next = w.env.draws.find(t => t > L);
    A.ok(kind === want && Math.abs(next - (L + 1000 / 60)) < 0.01, 'a wake 5 ms after a re-booked draw (due +' + d + ', timers ' + lag + ' ms late; booked: ' + kind + ') is drawn on the next vsync (+' + (next - L).toFixed(1) + ' ms)');
  }
  // motion is untouched: a walking body is 60 draws/s with ONE callback each and none skipped; a panning hand 144/s the same way
  {
    const w = makeWorld(60), b = body({ idleUntil: 0 }); w.sb.agent = b; walkerScene(w, b);
    w.W.frame(0); w.runUntil(1000);
    const d0 = w.env.draws.length, r0 = w.env.rafCalls, s0 = w.W.renderPace().skippedFrames;
    w.runUntil(3000);
    const n = w.env.draws.length - d0, rp = w.W.renderPace();
    A.ok(n >= 119 && n <= 121 && w.env.rafCalls - r0 <= n + 1 && rp.skippedFrames === s0, 'a walking body: 60 draws/s, one rAF callback per draw, none skipped (' + n + ' draws, ' + (w.env.rafCalls - r0) + ' callbacks in 2 s)');
    const w2 = makeWorld(144), b2 = body(); w2.sb.agent = b2; walkerScene(w2, b2);
    w2.W.frame(0); w2.runUntil(1000);
    for (let t = 1000; t < 2000; t += 3) w2.at(t, () => { w2.sb.panX += 1; w2.W.cameraMoved(); });
    w2.runUntil(1200);
    const e0 = w2.env.draws.length, q0 = w2.env.rafCalls, k0 = w2.W.renderPace().skippedFrames;
    w2.runUntil(2000);
    const m = w2.env.draws.length - e0, rp2 = w2.W.renderPace();
    A.ok(m >= 114 && m <= 116 && w2.env.rafCalls - q0 <= m + 1 && rp2.skippedFrames === k0, 'a panning hand on a 144 Hz panel: 144 draws/s, one rAF callback per draw, none skipped (' + m + ' draws, ' + (w2.env.rafCalls - q0) + ' callbacks in 0.8 s)');
  }
  // a heavy MOTION draw (20 ms, over a vsync) is drawn exactly as it is without the verdict's re-book: frame() still books its
  // next callback before it draws, and the re-book never touches a moving floor (the fake clock is pushed on inside the draw)
  {
    const heavy = opts => {
      const w = makeWorld(60, opts), b = body({ idleUntil: 0 }); w.sb.agent = b;
      let last = 0;
      w.sb.scene = { step(now) { w.env.draws.push(now); const dt = last ? now - last : 0; last = now; b.px += 0.03 * dt; b.state = 'walk'; w.env.now += 20; } };
      w.W.frame(0); w.runUntil(3000);
      return [w.env.draws.length, w.env.rafCalls, w.W.renderPace().skippedFrames].join('/');
    };
    const real = heavy(), plain = heavy({ verdict: MUTE.noRebook.verdict });
    A.ok(real === plain, 'a 20 ms motion draw: the same draws, callbacks and skips with and without the verdict re-book (' + real + ' vs ' + plain + ')');
  }
  // skippedFrames counts what the pace check sent back: a 48 ms caller cap at 60 Hz books rAF every vsync, two of three skipped
  {
    const w = makeWorld(60), b = body({ idleUntil: 0 }); w.sb.agent = b; walkerScene(w, b); w.sb.frameCapMs = 48;
    w.W.frame(0); w.runUntil(1000);
    const d0 = w.env.draws.length, s0 = w.W.renderPace().skippedFrames;
    w.runUntil(3000);
    const n = w.env.draws.length - d0, s = w.W.renderPace().skippedFrames - s0;
    A.ok(typeof w.W.renderPace().skippedFrames === 'number' && n >= 38 && n <= 42 && s >= n * 1.9 && s <= n * 2.1, 'renderPace().skippedFrames counts the callbacks the pace check sent back (a 48 ms cap: ' + s + ' skipped for ' + n + ' draws)');
  }
  // the verdict books again only for a floor on the still pace: a capped floor is never re-booked (no rAF cancelled and rebooked),
  // and a UI-first hold that begins INSIDE a still draw (a window opening from the draw's own callbacks) is kept to the vsync
  {
    const w = makeWorld(60); let cancels = 0; const cancel0 = w.sb.cancelAnimationFrame;
    w.sb.cancelAnimationFrame = id => { cancels++; return cancel0(id); };
    w.sb.agent = body(); dueScene(w, 400); w.sb.frameCapMs = 48;
    w.W.frame(0); w.runUntil(3000);
    A.ok(w.W.renderPace().mode === 'capped' && w.W.renderPace().stillFrames > 20 && cancels === 0, 'a capped floor judged still is never re-booked: the plain rAF it booked stands (' + cancels + ' booking(s) cancelled in 3 s)');
    const h = makeWorld(60), hold = 140; h.sb.agent = body();   // (not a whole number of vsyncs: a timer ON a vsync boundary fires after it)
    let armed = false, at = 0;
    h.sb.scene = { step(now) { h.env.draws.push(now); h.W.noteDue(now + 20, now); if (armed && !at) { at = now; h.W.yieldToUi(hold); } } };
    h.W.frame(0); h.runUntil(1000); armed = true; h.runUntil(1500);
    const next = h.env.draws.find(t => t > at), want = h.firstVsyncAtOrAfter(at + hold);
    A.ok(at > 0 && Math.abs(next - want) < 0.01 && h.env.draws.filter(t => t > at && t < want).length === 0, 'a hold begun inside a still draw stands: no draw until it ends (' + hold + ' ms), then the first vsync (+' + (next - at).toFixed(1) + ' ms)');
  }
  // MUTATION CHECKS: each half of the fix, alone removed, is caught
  const stillRun = (m, hz, lag, d) => rafRun(hz, lag, d, m);
  A.ok(MUTE.noDue.pacer(world.slice(pFrom, pTo)) !== world.slice(pFrom, pTo) && MUTE.noRebook.verdict(world.slice(vFrom, vTo)) !== world.slice(vFrom, vTo),
    '(the mutation checks find the due branch of stillBookAt and the verdict re-book)');
  const m1 = stillRun(MUTE.noDue, 60, 0, 8);
  A.ok(m1.dueLate > 0 || m1.perS < 55, 'MUTATION CHECK — stillBookAt without the due branch: a change due +8 ms waits for the 30/s tick (' + rafRow(0, 8, m1) + ')');
  const m2 = stillRun(MUTE.noRebook, 60, 0, 30);
  A.ok(m2.rafPerDraw > 1.5, 'MUTATION CHECK — no verdict re-book: the stale booking is back, ~2 rAF per draw (' + rafRow(0, 30, m2) + ')');
  const m3 = stillRun(MUTE.old, 60, 15.6, 30);
  A.ok(m3.rafPerDraw > 1.5 || m3.dueLate > 0 || m3.perS < 29, 'MUTATION CHECK — the pre-10-21 rule (a timer 2 ms before the change) fails the same invariant (' + rafRow(15.6, 30, m3) + ')');
}

// ---- 4g. THE LATE-TIMER MARGIN IS MEASURED, NOT ASSUMED: one rAF per draw above 60 Hz too (idle renderer review) -------------
// 4f proves one rAF per draw at 60 Hz, where a whole Windows tick (15.6 ms) is shorter than a vsync and the lead is one vsync. Above
// 60 Hz the lead came from a constant: a due change was booked j = ceil((15.6 + 0.5) / vsync) vsyncs early whatever the timers really
// did (144 Hz: 3, 239 Hz: 4), so the last j - 1 vsyncs before every due draw rode bare rAF callbacks - 3 to 4 a draw on the panels the
// P7 budget line (rafPerDraw <= 1.25) is judged on - and 4f tested nothing above 144 Hz. The margin is now what the still timers have
// really been late: the worst of the last TIMER_LATE_SAMPLES of them (clamped to the tick), and the whole tick until they have been seen.
// THE CLASS: every panel x every timer lateness x every due distance. Once the timers have been seen:
//   (a) a due change is drawn on its own vsync (the margin changes what a wait COSTS, never when anything is drawn);
//   (b) the draw costs ONE rAF callback - or, when its vsync is within j of the last draw (a timer that late cannot be aimed there),
//       the kD callbacks of the vsyncs it must ride, never more. j is what a timer `lag` late needs: ceil((lag + 0.5) / vsync).
{
  const SAMPLES = num('TIMER_LATE_SAMPLES'), TICK = num('STILL_TIMER_LATE_MS');
  const C = makeWorld(60).W.consts;
  // (100, not 75 or 90: there the 30/s tick or the visible pace falls EXACTLY on a vsync, and frame()'s strict compare decides it by float noise)
  const HZ = [60, 100, 120, 144, 240], LAGS = [0, 4, TICK], DS = [20, 26, 30, 100, 400];
  for (let d = 1; d <= 70; d += 3) DS.push(d);
  // what frame() and the booking owe a due change d ms after every draw, per panel: kT = the vsync the 30/s tick draws on, kD = the
  // vsync a change d out draws on (never before the visible pace), j = the vsyncs a timer `lag` late (woken 0.5 ms past its vsync) needs.
  // A floor that has never booked a timer - every wait within jSeed vsyncs of its draw rides rAF - has nothing to measure with and
  // keeps the tick as its margin (kD callbacks a draw, as before); any other floor learns the clock and pays one.
  const owed = (hz, lag, d) => {
    const P = 1000 / hz, slack = Math.max(1, Math.min(P, 17) / 2);
    const kT = Math.max(1, Math.ceil((C.PACE_STILL_MS - slack) / P - 1e-9)), kD = Math.max(1, Math.ceil(Math.max(d, C.PACE_VISIBLE_MS - slack) / P - 1e-9));
    const j = Math.max(1, Math.ceil((lag + 0.5) / P - 1e-9)), jSeed = Math.max(1, Math.ceil((TICK + 0.5) / P - 1e-9)), due = kD <= kT;
    return { P, kT, kD, j, jSeed, due, callbacks: due && kD <= jSeed ? kD : 1 };
  };
  // one run: 3 s for the margin to settle (more than TIMER_LATE_SAMPLES timers), then 3 s measured
  const settled = (hz, lag, d, opts) => {
    const w = makeWorld(hz, Object.assign({ timerLate: lag }, opts || {}));
    w.sb.agent = body(); dueScene(w, d);
    w.W.frame(0); w.runUntil(3000);
    const i0 = w.env.draws.length - 1, r0 = w.env.rafCalls;
    w.runUntil(6000);
    const draws = w.env.draws.slice(i0), n = draws.length - 1;
    return { w, n, ivs: draws.slice(1).map((t, i) => t - draws[i]), rafPerDraw: (w.env.rafCalls - r0) / n };
  };
  A.ok(SAMPLES >= 16 && SAMPLES <= 64 && TICK === 15.6, 'the margin is the worst of the last ' + SAMPLES + ' still timers, and at most one Windows tick (' + TICK + ' ms)');
  const rows = [];
  for (const hz of HZ) for (const lag of LAGS) for (const d of DS) rows.push([hz, lag, d, owed(hz, lag, d), settled(hz, lag, d)]);
  const fmt = ([hz, lag, d, o, r]) => hz + ' Hz, timers ' + lag + ' ms late, due +' + d + ': ' + r.rafPerDraw.toFixed(2) + ' rAF/draw (owed ' + o.callbacks + ')';
  // (b) THE INVARIANT, RED on a constant margin: one callback per draw wherever a timer can be aimed at the draw's own vsync
  const heavy = rows.filter(([, , , o, r]) => !(r.rafPerDraw <= o.callbacks * 1.05 + 0.02));
  A.ok(!heavy.length, 'EVERY panel (60-240 Hz) x timer lateness (0, 4, 15.6 ms) x due distance (+1..+400 ms): a draw costs ONE rAF callback, or the kD it must ride when no timer has ever been aimable'
    + ' - ' + rows.length + ' runs' + (heavy.length ? ' - over: ' + heavy.length + ', e.g. ' + heavy.slice(0, 3).map(fmt).join('; ') : ''));
  const worst = hz => Math.max(...rows.filter(([h, l, d, o]) => h === hz && l === 0 && o.due && o.callbacks === 1).map(([, , , , r]) => r.rafPerDraw));
  A.ok(HZ.every(hz => worst(hz) <= 1.05), '...so with timers on time the 30/s floor with a change due +20..+70 ms reads ' + HZ.map(hz => hz + ' Hz ' + worst(hz).toFixed(2)).join(', ') + ' rAF per draw (the P7 line wants <= 1.25)');
  // (a) nothing is drawn late for it: every interval between draws is the vsync the change is due on (the tick-only draws too, on time timers)
  const late = rows.filter(([, lag, , o, r]) => (o.due || lag === 0) && !r.ivs.every(iv => Math.abs(iv - (o.due ? o.kD : o.kT) * o.P) < 0.01));
  A.ok(!late.length, '...and every change is still drawn on its own vsync (no interval but kD vsyncs)' + (late.length ? ' - late: ' + late.length + ', e.g. ' + late.slice(0, 3).map(fmt).join('; ') : ''));
  A.ok(rows.every(([, , , , r]) => r.n >= 25), '...a station that draws (>= 8 draws a second) in every one of those runs');

  // THE SEED: before any timer has been seen the whole tick is assumed, so a timer a tick late costs no draw its vsync from the first
  // draw on - the margin is the worst case until the evidence is in
  for (const hz of [120, 144, 240]) for (const d of [20, 30]) {
    const o = owed(hz, TICK, d), w = makeWorld(hz, { timerLate: TICK });
    w.sb.agent = body(); dueScene(w, d); w.W.frame(0); w.runUntil(500);
    const ivs = w.env.draws.slice(1).map((t, i) => t - w.env.draws[i]).slice(3), rp = w.W.renderPace();   // (not the first three: the vsync is still being learned)
    A.ok(ivs.length >= 10 && ivs.every(iv => Math.abs(iv - o.kD * o.P) < 0.01) && rp.timerSamples < SAMPLES && rp.timerLateMs === TICK,
      hz + ' Hz, timers a whole tick late from the first draw, due +' + d + ': the first ' + ivs.length + ' changes land on their vsync (the margin still ' + rp.timerLateMs + ' ms after ' + rp.timerSamples + ' timers)');
  }

  // THE FOLLOW: a clock that gets worse is believed at once (one draw in flight pays for it, none after); one that gets better only once
  // the worst timers have turned over - the margin is a window, not a mood
  {
    const hz = 240, d = 30, o = owed(hz, 0, d);
    const worse = makeWorld(hz, { timerLate: t => (t < 3000 ? 0 : TICK) });
    worse.sb.agent = body(); dueScene(worse, d); worse.W.frame(0); worse.runUntil(3000);
    const mid = worse.W.renderPace().timerLateMs, i0 = worse.env.draws.length - 1;
    worse.runUntil(6000);
    const draws = worse.env.draws.slice(i0), lateDraws = draws.slice(1).filter((t, i) => Math.abs(t - draws[i] - o.kD * o.P) > 0.01).length;
    A.ok(mid < 1 && lateDraws <= 1 && worse.W.renderPace().timerLateMs === TICK,
      '240 Hz, timers on time and then a whole tick late: the margin goes from ' + mid + ' to ' + worse.W.renderPace().timerLateMs + ' ms at the first late timer - ' + lateDraws + ' draw late, none after');
    const better = makeWorld(hz, { timerLate: t => (t < 3000 ? TICK : 0) });
    better.sb.agent = body(); dueScene(better, d); better.W.frame(0); better.runUntil(3300);
    const soon = better.W.renderPace().timerLateMs;
    better.runUntil(7000);
    A.ok(soon === TICK && better.W.renderPace().timerLateMs === 0, '240 Hz, timers a tick late and then on time: still ' + soon + ' ms 0.3 s later (trusted only once the late ones have turned over), ' + better.W.renderPace().timerLateMs + ' ms in the end');
  }
  // ...a stall is not a clock: one timer 250 ms late (the main thread was busy) cannot push the margin past the tick, and the window forgets it
  {
    const w = makeWorld(240, { timerLate: t => (t >= 3000 && t < 3040 ? 250 : 0) });
    w.sb.agent = body(); dueScene(w, 30); w.W.frame(0); w.runUntil(3400);
    const during = w.W.renderPace().timerLateMs;
    w.runUntil(6000);
    A.ok(during === TICK && w.W.renderPace().timerLateMs === 0, 'one timer 250 ms late (a stall) reads as one tick (' + during + ' ms), never more, and is forgotten after ' + SAMPLES + ' timers (' + w.W.renderPace().timerLateMs + ' ms)');
  }
  // ...and what a timer can report is read defensively: early (a delay the browser rounds down) is on time, an unreadable lateness is
  // the worst case, never a good one
  {
    const w = makeWorld(240).W, margin = () => w.renderPace().timerLateMs;
    A.ok(typeof w.noteTimerLate === 'function', 'the pacer takes a still timer\'s lateness through noteTimerLate');
    if (typeof w.noteTimerLate === 'function') {
      for (let i = 0; i < SAMPLES; i++) w.noteTimerLate(0);
      const quiet = margin();
      w.noteTimerLate(-0.7); const early = margin();
      w.noteTimerLate(NaN); const nan = margin();
      for (let i = 0; i < SAMPLES; i++) w.noteTimerLate(1.25);
      const mid = margin();
      w.noteTimerLate(Infinity); const inf = margin();
      A.eq([quiet, early, nan, mid, inf], [0, 0, TICK, 1.3, TICK], 'a timer reports its lateness defensively: early reads 0, an unreadable value or Infinity reads the whole tick (margin ' + [quiet, early, nan, mid, inf].join(', ') + ')');
    }
  }
  // a quantised clock (Windows without a high-resolution timer: a timer fires on the next 15.625 ms system tick, so it is late by anything
  // from 0 to a tick, unpredictably): the margin is the whole tick, nothing is drawn late - before or after the margin has settled - and
  // the cost is no worse than the constant it replaces
  for (const hz of [60, 120, 144, 240]) for (const d of [20, 26, 30, 55]) {
    const o = owed(hz, TICK, d), w = makeWorld(hz, { timerTick: 15.625 });
    w.sb.agent = body(); dueScene(w, d); w.W.frame(0); w.runUntil(6000);
    const ivs = w.env.draws.slice(1).map((t, i) => t - w.env.draws[i]).slice(3), rp = w.W.renderPace(), perDraw = w.env.rafCalls / w.env.draws.length, most = o.due ? Math.min(o.kD, o.j) : 1;
    A.ok((!o.due || ivs.every(iv => Math.abs(iv - o.kD * o.P) < 0.01)) && rp.timerLateMs >= 12 && perDraw <= most * 1.05 + 0.02,
      hz + ' Hz, a 15.625 ms quantised timer clock, due +' + d + ': every change on its vsync, the margin ' + rp.timerLateMs + ' ms, ' + perDraw.toFixed(2) + ' rAF/draw (at most ' + most + ')');
  }

  // THE READOUT the bench prints beside the P7 verdict: the margin in use and how many timers it has seen
  {
    const w = makeWorld(240, { timerLate: 4 }); w.sb.agent = body(); dueScene(w, 30);
    const rp0 = w.W.renderPace();
    w.W.frame(0); w.runUntil(4000);
    const rp = w.W.renderPace();
    A.ok(rp0.timerLateMs === TICK && rp0.timerSamples === 0 && rp.timerLateMs === 4 && rp.timerSamples >= SAMPLES,
      "renderPace() reads the margin in use (timerLateMs: " + rp0.timerLateMs + ' -> ' + rp.timerLateMs + ') and the timers it has seen (timerSamples: ' + rp0.timerSamples + ' -> ' + rp.timerSamples + ')');
  }

  // THE MARGIN CARRIES OVER: a floor whose waits all ride rAF (a change due within jSeed vsyncs of every draw: 240 Hz, +8 ms) books no
  // timer, so it cannot measure the clock - and a probe armed beside the rAF chain would read it with the thread kept awake. But the
  // station that has been quiet first (the app's day: boot, then the 30/s floor) has measured it, and keeps what it learned
  {
    const run = (dAt, ms) => {
      const w = makeWorld(240, { timerLate: 0 }); w.sb.agent = body();
      w.sb.scene = { step(now) { w.env.draws.push(now); w.W.noteDue(now + dAt(now), now); } };
      w.W.frame(0); w.runUntil(ms[0]);
      const i0 = w.env.draws.length - 1, r0 = w.env.rafCalls;
      w.runUntil(ms[1]);
      return { w, rafPerDraw: (w.env.rafCalls - r0) / (w.env.draws.length - 1 - i0), rp: w.W.renderPace() };
    };
    const quietFirst = run(now => (now < 3000 ? 400 : 8), [4000, 6000]), fresh = run(() => 8, [4000, 6000]);
    A.ok(quietFirst.rafPerDraw <= 1.05 && quietFirst.rp.timerLateMs === 0, '240 Hz, quiet for 3 s and then a change due +8 ms after every draw: the margin it learned is kept (' + quietFirst.rp.timerLateMs + ' ms), ' + quietFirst.rafPerDraw.toFixed(2) + ' rAF per draw');
    A.ok(fresh.rafPerDraw > 3.5 && fresh.rp.timerLateMs === TICK && fresh.rp.timerSamples === 0, '...while a floor that never booked a timer keeps the tick (' + fresh.rp.timerLateMs + ' ms, ' + fresh.rp.timerSamples + ' timers seen): the 4 vsyncs ride rAF as before (' + fresh.rafPerDraw.toFixed(2) + ' a draw)');
  }

  // MUTATION CHECKS: the pre-fix rule (a constant margin) and a margin that starts at zero are both caught
  const CONST_MARGIN = src => src.replace('(timerLateMax + TICK_AFTER_VSYNC_MS)', '(STILL_TIMER_LATE_MS + TICK_AFTER_VSYNC_MS)');
  const ZERO_SEED = src => src.replace('.fill(STILL_TIMER_LATE_MS)', '.fill(0)');
  const pacerSrc = world.slice(pFrom, pTo);
  A.ok(CONST_MARGIN(pacerSrc) !== pacerSrc && ZERO_SEED(pacerSrc) !== pacerSrc, '(the mutation checks find the margin in stillBookAt and its starting window)');
  const m1 = settled(240, 0, 26, { pacer: CONST_MARGIN });
  A.ok(m1.rafPerDraw > 3.5, 'MUTATION CHECK - the constant margin (the rule before this fix), 240 Hz, timers on time, a change due +26 ms: ' + m1.rafPerDraw.toFixed(2) + ' rAF per draw (the invariant above wants 1)');
  {
    const o = owed(240, TICK, 30), w = makeWorld(240, { timerLate: TICK, pacer: ZERO_SEED });
    w.sb.agent = body(); dueScene(w, 30); w.W.frame(0); w.runUntil(1000);
    const lateOnes = w.env.draws.slice(1).filter((t, i) => Math.abs(t - w.env.draws[i] - o.kD * o.P) > 0.01).length;
    A.ok(lateOnes >= 1, 'MUTATION CHECK - a margin that starts at zero: the first timers, a tick late, cost ' + lateOnes + ' draw(s) their vsync');
  }
}

// ---- 4e. the final fixes' wakes, through the real pacer: a camera cut from a timer, a layout edit, start stamps ------------
const WAKE_SRC = (world.match(/  const WAKE_API = new Set\(\[[\s\S]*?\]\);/) || [''])[0] + '\n' + A.fnBody(code, 'function wakeOnCall(api)');
A.ok(/const WAKE_API/.test(WAKE_SRC) && /function wakeOnCall\(api\)/.test(WAKE_SRC), 'world.js carries WAKE_API and wakeOnCall (lifted below)');
{
  // (a) frameReviewRoom: stationcommands.js frames what the builder built from a setTimeout (700 ms after the build) — the real
  // function, wrapped by the real wakeOnCall, cuts the camera on the next vsync; unwrapped (before the fix) it waited out a still tick
  const extra = WAKE_SRC + '\n' + A.fnBody(code, 'function frameReviewRoom(id)') + '\n' + A.fnBody(code, 'function fitCamera()') + `
var MINZ = 0.5, MAXZ = 8, fitW = 0, fitH = 0, StationBake = { WALL: { up: 24, skirt: 6 } };
function clampz(v, a, b) { return Math.max(a, Math.min(b, v)); }
var station = { serialize: () => ({ rooms: { r1: { rects: [{ x1: 2, y1: 2, x2: 9, y2: 7 }] } } }) };
this.API = wakeOnCall({ frameReviewRoom }); this.rawFrameReviewRoom = frameReviewRoom;`;
  const run = (fn) => {
    const w = makeWorld(60, { extra }), b = body();
    w.sb.agent = b; w.sb.cache = { W: 400, H: 300 }; w.sb.geo = { origin: { tx: 0, ty: 0 } };
    const seen = [];
    w.sb.scene = { step(now) { w.env.draws.push(now); seen.push([now, w.sb.scale]); } };
    w.W.frame(0); w.runUntil(1000);
    const L = w.toNextDraw(), s0 = w.sb.scale, c0 = w.W.renderPace().stillWhyCounts;
    w.at(L + 5, () => fn(w));
    w.runUntil(L + 120);
    const cut = seen.find(([t, s]) => t > L && s !== s0), c1 = w.W.renderPace().stillWhyCounts;
    return { w, L, cut, moved: (c1.wake || 0) + (c1.camera || 0) - (c0.wake || 0) - (c0.camera || 0) };
  };
  const ok = run(w => w.sb.API.frameReviewRoom('r1'));
  A.ok(ok.cut && Math.abs(ok.cut[0] - (ok.L + 1000 / 60)) < 0.01, "World.frameReviewRoom from a timer between still frames: the camera cut is drawn on the next vsync (+" + (ok.cut ? (ok.cut[0] - ok.L).toFixed(1) : '?') + ' ms)');
  A.ok(ok.moved >= 1 && ok.w.W.renderPace().mode === 'still', '...that frame is judged moving (' + ok.moved + '), and the new framing then goes still again');
  const raw = run(w => w.sb.rawFrameReviewRoom('r1'));
  A.ok(raw.cut && raw.cut[0] - raw.L > 30, 'MUTATION CHECK — unwrapped (before the fix), the same cut waited out the still tick (+' + (raw.cut ? (raw.cut[0] - raw.L).toFixed(1) : '?') + ' ms)');
}
{
  // (b) station.onChange: a layout edit that lands after an await (a builder step, a restyle, an undo) wakes a still floor — the
  // real subscriber from loadStation
  const sub = (A.fnBody(code, 'function loadStation(st)').match(/if \(station && station\.onChange\) unsub = station\.onChange\(p => \{[^\n]*\}\);/) || [''])[0];
  A.ok(/motionWake\(\); \}\);$/.test(sub), "loadStation's station.onChange subscriber ends in motionWake()");
  const extra = 'var geoDirty = false, bakeEditPending = false, unsub = null, onEdit = null;\nvar station = { onChange(fn) { onEdit = fn; return () => {}; } };\n' + sub + '\nthis.edit = p => onEdit(p); this.dirty = () => geoDirty;';
  const w = makeWorld(60, { extra }), b = body();
  w.sb.agent = b; walkerScene(w, b);
  w.W.frame(0); w.runUntil(1000);
  const L = w.toNextDraw();
  w.at(L + 4, () => w.sb.edit({ staticBakeUnchanged: true }));   // a prop placed after an await
  w.runUntil(L + 100);
  const next = w.env.draws.find(t => t > L);
  A.ok(w.sb.dirty() && Math.abs(next - (L + 1000 / 60)) < 0.01, 'a layout edit between still frames is drawn on the next vsync (+' + (next - L).toFixed(1) + ' ms; the still tick is +33.3)');
}
{
  // (c) animation start stamps set between frames read the wall clock, never the last frame's fnow (up to 33 ms old on a still
  // floor, so the flash / ripple would start part-way through): the real dockArrival, onWorkitemDeliver and spawnAgent
  const extra = A.fnBody(code, 'function dockArrival(p)') + '\n' + A.fnBody(code, 'function onWorkitemDeliver(bx)') + '\n' + A.fnBody(code, 'function spawnAgent(a)') + `
var fnow = 0, routingPlan = { dockBays: [{ propId: 'bay1', agentId: 'm' }], bayTileToAgent: {} }, U = { irnd: (a) => a };
function bodyForAgent(id) { return crew.find(x => x.agentId === id) || null; }
function wakeIn() { wakeAt = performance.now(); }
function workerFoot() { return { x: 300, y: 150 }; }
function crewColor() { return '#fff'; }
function makeCrewBody(id, name, color, x, y) { return { id: 'c_' + id, agentId: id, name, px: x, py: y, dir: 'south', state: 'idle', idleUntil: Infinity, glanceCd: Infinity, _pose: 'p', _renderFrame: 0 }; }
function greetNewcomer() {}
this.dock = dockArrival; this.deliver = onWorkitemDeliver; this.spawn = spawnAgent;`;
  const w = makeWorld(60, { extra }), mate = body({ id: 'm1', agentId: 'm', px: 260 });
  w.sb.agent = body(); w.sb.crew = [mate];
  w.sb.scene = { step(now) { w.env.draws.push(now); w.sb.fnow = now; } };   // frameBody: fnow = now
  w.W.frame(0); w.runUntil(1000);
  const L = w.toNextDraw();
  w.runUntil(L + 30);   // 30 ms into a still interval: fnow is still L
  w.sb.dock({ agentId: 'm' });
  A.ok(w.sb.dockFlashes.get('bay1') === L + 30 && mate.wakeAt === L + 30, 'dockArrival between frames: the dock flash and the ripple start on the wall clock (+30 ms), not the stale fnow (' + (w.sb.dockFlashes.get('bay1') - L) + ', ' + (mate.wakeAt - L) + ')');
  w.runUntil(L + 2000); const L2 = w.toNextDraw(); w.runUntil(L2 + 25);
  w.sb.deliver({ x: 1, y: 1, payload: { agentId: 'm' } });
  A.ok(mate.wakeAt === L2 + 25, 'a crate delivered to a crew body: its wake ripple starts on the wall clock (+' + (mate.wakeAt - L2) + ' ms)');
  w.runUntil(L2 + 2000); const L3 = w.toNextDraw(); w.runUntil(L3 + 21);
  w.sb.spawn({ id: 'newbie', name: 'NEW' });
  const nb = w.sb.crew.find(x => x.agentId === 'newbie');
  A.ok(nb && nb.wakeAt === L3 + 21, 'a summoned body materializing between frames: its ripple starts on the wall clock (+' + (nb ? nb.wakeAt - L3 : '?') + ' ms)');
  A.ok(/firstShipPulse = \{ at: \(typeof performance !== 'undefined'\) \? performance\.now\(\) : fnow, tiles: receipt\.tiles \};/.test(A.fnBody(code, 'function noteFirstShip(p)')),
    "noteFirstShip's pulse starts on the wall clock (test/first-ship-receipt.test.js drives it)");
}

// ---- 5. a wake from outside the frame (input, a harness event, a World API call) lands on the next vsync ------------
{
  const w = makeWorld(60), b = body();
  w.sb.agent = b; walkerScene(w, b);
  w.W.frame(0);
  w.runUntil(1000);
  const L = w.toNextDraw();
  w.at(L + 5, () => { b.state = 'walk'; w.W.motionWake(); });   // e.g. World.setActivity → the body walks, from outside the frame
  w.runUntil(L + 100);
  const next = w.env.draws.find(t => t > L);
  A.ok(Math.abs(next - (L + 1000 / 60)) < 0.01, 'a wake 5 ms into a still interval is drawn on the very next vsync (+' + (next - L).toFixed(1) + ' ms)');
  A.eq(w.W.st().stillWhy, 'body', '...and the floor stays at the normal pace while the body walks');

  const w2 = makeWorld(60), b2 = body();
  w2.sb.agent = b2; walkerScene(w2, b2);
  w2.W.frame(0); w2.runUntil(1000);
  const L2 = w2.toNextDraw();
  w2.at(L2 + 3, () => w2.W.userActive());   // a pointermove on the window
  w2.runUntil(L2 + 100);
  const next2 = w2.env.draws.find(t => t > L2);
  A.ok(Math.abs(next2 - (L2 + 1000 / 60)) < 0.01, 'a hand on the window wakes a still floor on the next vsync');
  A.eq(w2.W.st().stillWhy, 'input', '...and holds the normal pace while the hand is there (hover tags, glances)');
  w2.runUntil(L2 + w2.W.consts.INPUT_HOLD_MS + 300);
  A.eq(w2.W.renderPace().mode, 'still', '...and the floor goes still again once the hand has been away INPUT_HOLD_MS');
}

// ---- 6. the caller cap and the budget keep their meaning ------------------------------------------------------------
{
  const w = makeWorld(60), b = body();
  w.sb.agent = b; walkerScene(w, b);
  w.W.frame(0); w.runUntil(1000);
  w.sb.frameCapMs = 48;
  A.eq(w.W.paceMs(w.env.now), 48, "a caller's frame cap (HUD widget) is its stated intent: the still tier never overrides it");
  A.eq(w.W.renderPace().mode, 'capped', "...and renderPace says 'capped'");
  w.sb.frameCapMs = 0;
  for (let i = 0; i < 80; i++) w.W.noteDrawCost(40);
  A.ok(Math.abs(w.W.paceMs(w.env.now) - 40 / 0.7) < 0.5, 'a slow floor stretches past the still pace by its budget (the budget still wins)');
  A.eq(w.W.renderPace().mode, 'budget', "...and renderPace says 'budget'");
  w.W.resetBudget();
}

// ---- 7. every motion source flips the still flag; ambient ones do not ---------------------------------------------------
{
  const w = makeWorld(60), sb = w.sb, W = w.W;
  const hero = body({ id: 'hero' }), mate = body({ id: 'mate', px: 300 });
  sb.agent = hero; sb.crew = [mate];
  let now = 5000;
  const verdict = (inFrame) => { W.stillBegin(); if (inFrame) inFrame(); W.stillVerdict(now); return W.st(); };
  const settle = () => { verdict(); return verdict(); };
  A.ok(settle().stillNow, 'a settled scene with two idle bodies is still');
  const flip = (why, label, mutate, revert, inFrame) => {
    mutate();
    const s = verdict(inFrame);
    A.ok(!s.stillNow && s.stillWhy === why, label + ' → not still (' + why + ')' + (s.stillWhy !== why ? ' [got ' + s.stillWhy + ']' : ''));
    if (revert) revert();
    now += 2000;   // past every hold window
    A.ok(settle().stillNow, '...and still again once it stops (' + label + ')');
  };
  const calm = (label, mutate, revert) => {
    mutate();
    const s = settle();
    A.ok(s.stillNow, label + ' → still (ambient)' + (s.stillNow ? '' : ' [got ' + s.stillWhy + ']'));
    if (revert) revert();
    settle();
  };
  // wake
  flip('wake', 'motionWake during the frame (a bus event, a World API call)', () => {}, null, () => W.motionWake());
  // camera
  flip('camera', 'a pan', () => { sb.panX += 7; });
  flip('camera', 'a zoom', () => { sb.scale *= 1.1; });
  flip('camera', 'a focus ease running', () => { sb.camLerp = { scale: 3, panX: 0, panY: 0 }; }, () => { sb.camLerp = null; });
  // the ease's own gate (frameBody: camLerp && !camAnim && !camLock): under a follow-lock a camLerp is dormant — it moves nothing
  calm('a focus ease left dormant under a follow-lock (the lock owns the camera; the ease runs only once it lets go)',
    () => { sb.camLerp = { scale: 3, panX: 0, panY: 0 }; sb.camLock = { id: 'hero', sc: 3, source: 'session' }; }, () => { sb.camLerp = null; sb.camLock = null; });
  flip('camera', 'a scripted camera move', () => { sb.camAnim = { t: 0 }; }, () => { sb.camAnim = null; });
  flip('camera', 'the hand hold after a drag', () => { sb.performance.now = () => now; W.cameraMoved(); }, null);
  // input
  flip('input', 'a hand on the window', () => { W.userActive(); }, null);
  flip('input', "the hero's mic listening", () => { sb.Voice = { isListening: () => true, isSpeaking: () => false }; }, () => { delete sb.Voice; });
  flip('speech', "the hero's voice speaking", () => { sb.Voice = { isListening: () => false, isSpeaking: () => true }; }, () => { delete sb.Voice; });
  // bodies (hero and crew alike)
  flip('body', 'a body walking', () => { mate.state = 'walk'; }, () => { mate.state = 'idle'; });
  flip('body', 'a body moved', () => { hero.px += 1; });
  flip('body', 'a body turned', () => { mate.dir = 'west'; });
  flip('body', 'a body changed pose (a blink)', () => { hero._pose = 'set.blink.south'; });
  flip('body', 'a body changed drawn frame', () => { mate._renderFrame = 1; });
  flip('body', 'a body pivoting', () => { hero._rW = 3; }, () => { hero._rW = 0; });
  flip('body', 'a pose dissolving', () => { mate._renderPoseFade = 0.4; }, () => { mate._renderPoseFade = null; });
  flip('body', 'a body working (typing; its desk shows the run)', () => { hero.working = true; }, () => { hero.working = false; });
  flip('body', 'a body speaking', () => { mate.speaking = true; }, () => { mate.speaking = false; });
  flip('body', 'a body talking (silent exchange)', () => { mate.talking = true; }, () => { mate.talking = false; });
  flip('body', 'a wake ripple', () => { mate.wakeAt = now; });
  flip('body', 'a level-up surge', () => { mate.levelUpAt = now; });
  flip('body', 'a summoned worker glowing', () => { mate.workUntil = now + 900; });
  flip('body', "a body's drawn geometry moving on the clock (the idle bob, the speech accent easing out: _renderLive)", () => { mate._renderLive = true; }, () => { mate._renderLive = false; });
  flip('body', 'a decision: the goal changed (what it starts shows next tick)', () => { mate.goal = 'inspect'; });
  flip('body', 'a decision: the state changed', () => { hero.state = 'social'; }, () => { hero.state = 'idle'; });
  flip('body', 'a body holding a walk target (about to step)', () => { mate.target = { x: 1, y: 1 }; }, () => { mate.target = null; });
  flip('body', 'a social plan still to walk (stepSocial paths it next tick)', () => { mate.social = { phase: 'walk' }; }, () => { mate.social = null; });
  flip('body', 'a gather plan still to walk (stepGather paths it next tick)', () => { mate.gather = { arrived: false }; }, () => { mate.gather = null; });
  flip('body', 'a chase due to repath toward the cursor', () => { mate.chase = { phase: 'pursue', repathAt: now - 1 }; }, () => { mate.chase = null; });
  flip('body', "the hero's glance roll pending (maybeGlance rolls every tick once glanceCd lapses)", () => { hero.glanceCd = now - 1; }, () => { hero.glanceCd = Infinity; });
  flip('body', "the hero at a prop with its fidget lapsed", () => { hero.goal = 'use'; hero.glanceCd = 0; hero.nextFidget = now - 1; }, () => { hero.goal = null; hero.glanceCd = Infinity; hero.nextFidget = 0; });
  flip('speech', 'a peer-chatter line', () => { mate.chatter = { until: now + 800 }; }, () => { mate.chatter = null; });
  // a canvas-clamped overlay follows its body (review 10-21): drawBubble / drawNameplate clamp to the canvas and track the head
  const offWalk = (over) => () => { Object.assign(mate, { px: -400, py: 100 }, over); mate.px -= 3; };   // off the left edge, and it moved this frame
  const homeMate = () => { Object.assign(mate, { px: 300, py: 150, say: null, state: 'idle' }); sb.hoverAgent = null; };
  flip('speech', 'a body walking OFF screen with its speech bubble up (the bubble slides along the canvas edge)', offWalk({ state: 'walk', say: { text: 'working…', until: now + 4200 } }), homeMate);
  flip('speech', 'the hero walking off screen with its bubble up', () => {
    Object.assign(hero, { px: -400, py: 100, say: { text: 'on my way', until: now + 3000 } }); hero.px -= 3;
  }, () => { Object.assign(hero, { px: 200, py: 150, say: null }); });
  flip('speech', 'the hovered body walking off screen (its nameplate is clamped to the canvas too)', () => { offWalk({ state: 'walk' })(); sb.hoverAgent = mate; }, homeMate);
  flip('speech', 'an off-screen body with its bubble up whose drawn geometry bobs (_renderLive)', () => { Object.assign(mate, { px: -400, py: 100, say: { text: 'hm', until: now + 3000 }, _renderLive: true }); verdict(); }, () => { mate._renderLive = false; homeMate(); });
  flip('speech', "a planted body breathing under its bubble (the bubble rounds to whole px: _renderDrift)", () => { mate.say = { text: 'ok', until: now + 3000 }; mate._renderDrift = true; }, () => { mate._renderDrift = false; mate.say = null; });
  flip('speech', 'the hovered body breathing under its nameplate', () => { sb.hoverAgent = mate; mate._renderDrift = true; }, () => { mate._renderDrift = false; sb.hoverAgent = null; });
  // the floor's movers
  flip('crate', 'a crate riding', () => { sb.convey = { boxCount: () => 1 }; }, () => { sb.convey = null; });
  flip('crate', 'a ghost projection riding', () => { sb.geo = { belts: [] }; sb.ghost = { nextChange: n => n }; }, () => { sb.ghost = null; sb.geo = null; });
  flip('crate', 'a hand-off box in flight', () => { sb.handoffBoxes.push({}); }, () => { sb.handoffBoxes.length = 0; });
  flip('crate', 'a SEND TO crate in flight', () => { sb.sendCrates.push({ t0: now, born: now - 100 }); }, () => { sb.sendCrates.length = 0; });
  flip('crate', 'a queue jam bobbing (drawQueueJam)', () => {}, null, () => W.stillMove('crate'));
  flip('prop', 'a prop with live content (the prop pass)', () => {}, null, () => W.stillMove('prop'));
  flip('prop', "a drawn prop whose art moves on its clock (PropSprites.clockNext: a native draw, fish, a screen's sweep)", () => { sb.PropSprites = { clockNext: () => now }; }, () => { delete sb.PropSprites; });
  flip('prop', 'a harness pulse decaying (a tool-fire surge, a connector packet: PropSprites.pulsing)', () => { sb.PropSprites = { pulsing: () => true, clockNext: () => Infinity }; }, () => { delete sb.PropSprites; });
  flip('sky', 'a meteor crossing the sky (SpaceBG.nextChange)', () => { sb.SpaceBG = { nextChange: n => n }; }, () => { delete sb.SpaceBG; });
  flip('belt', 'an energized belt in frame (no plan: every tile live)', () => { sb.geo = { belts: [{ x: 4, y: 4 }] }; sb.beltLiveSet = null; }, () => { sb.geo = null; });
  flip('belt', 'an energized belt in frame (on the compiled live route)', () => { sb.geo = { belts: [{ x: 4, y: 4 }, { x: 5, y: 4 }] }; sb.beltLiveSet = { '5,4': true }; }, () => { sb.geo = null; sb.beltLiveSet = null; });
  // canvas overlays and ceremonies
  flip('fx', 'the CRT roll bar sweeping (drawCRT)', () => {}, null, () => W.stillMove('fx'));
  flip('fx', 'a desk flash', () => { sb.deskFlash.set('a', { at: now }); }, () => sb.deskFlash.clear());
  flip('fx', 'a dock flash', () => { sb.dockFlashes.set('p', now); }, () => sb.dockFlashes.clear());
  flip('fx', 'the pin flourish', () => { sb.pinFlourishAt = now; });
  flip('fx', 'the FIRST SHIP pulse', () => { sb.firstShipPulse = { at: now }; }, () => { sb.firstShipPulse = null; });
  flip('fx', "a SHIPPED pallet's newest crate popping in (drawPallet's 900 ms lift and glint)", () => { sb.palletPopAt = now - 850; });
  flip('fx', 'the awakening', () => { sb.awakeFrozen = true; }, () => { sb.awakeFrozen = false; });
  flip('fx', 'the arrival', () => { sb.arrivalScene = {}; }, () => { sb.arrivalScene = null; });
  flip('fx', 'the kindling', () => { sb.kindleArmed = true; }, () => { sb.kindleArmed = false; });
  flip('fx', 'the flood', () => { sb.floodAt = now; }, () => { sb.floodAt = 0; });
  flip('fx', 'the dawn veil easing', () => { sb.wakeDark = 0.4; }, () => { sb.wakeDark = 0; });
  flip('fx', 'the dawn bloom', () => { sb.dawnAt = now; });
  flip('fx', 'the ignition spark', () => { sb.sparkAt = now; });
  flip('fx', 'color-into-being', () => { sb.bornAt = now; });
  flip('fx', 'a truth flare', () => { sb.truthPulseAt = now; });
  flip('fx', "the hero's wake ripple", () => { sb.wakeAt = now; });
  flip('fx', "the hero's level surge", () => { sb.levelUpAt = now; });
  // ambient — none of these is motion
  calm('a body nudged by float dust (< 0.01 px)', () => { hero.px += 0.001; });
  calm('a body walking OFF screen', () => { mate.px = -5000; mate.state = 'walk'; }, () => { mate.state = 'idle'; mate.px = 300; });
  calm('a cold belt (not on the live route)', () => { sb.geo = { belts: [{ x: 4, y: 4 }] }; sb.beltLiveSet = { '9,9': true }; }, () => { sb.geo = null; sb.beltLiveSet = null; });
  calm('an energized belt out of frame', () => { sb.geo = { belts: [{ x: 400, y: 400 }] }; sb.beltLiveSet = null; }, () => { sb.geo = null; });
  calm('a ghost waiting to spawn', () => { sb.geo = { belts: [] }; sb.ghost = { nextChange: () => now + 2500 }; }, () => { sb.ghost = null; sb.geo = null; });
  calm('a desk flash that has run its course (its pass skipped: overlays off)', () => { sb.deskFlash.set('a', { at: now - 5000 }); sb.dockFlashes.set('p', now - 5000); sb.firstShipPulse = { at: now - 5000 }; }, () => { sb.deskFlash.clear(); sb.dockFlashes.clear(); sb.firstShipPulse = null; });
  calm('a static speech bubble', () => { hero.say = { text: 'hello', until: now + 3000 }; }, () => { hero.say = null; });
  calm("a planted body's breath (_renderDrift: a sub-pixel swell every still frame draws at its true phase)", () => { hero._renderDrift = true; mate._renderDrift = true; }, () => { hero._renderDrift = false; mate._renderDrift = false; });
  calm('a static speech bubble over a body standing off screen (clamped, but nothing moves it)', () => { Object.assign(mate, { px: -400, py: 100, say: { text: 'hm', until: now + 3000 } }); }, () => { Object.assign(mate, { px: 300, py: 150, say: null }); });
  calm('a body walking off screen whose bubble has run its time', () => { Object.assign(mate, { px: -5000, state: 'walk', say: { text: 'bye', until: now - 10 } }); }, () => { Object.assign(mate, { px: 300, state: 'idle', say: null }); });
  calm('a bubble over a walker off screen with overlays off (the HUD widget shows only the world)', () => { sb.overlaysOn = false; Object.assign(mate, { px: -5000, state: 'walk', say: { text: 'hm', until: now + 3000 } }); }, () => { sb.overlaysOn = true; Object.assign(mate, { px: 300, state: 'idle', say: null }); });
  calm('a pallet pop that has run its course', () => { sb.palletPopAt = now - 5000; }, () => { sb.palletPopAt = -1e9; });
  calm('every drawn prop static, alpha-only glow or frozen (clockNext Infinity, no pulse)', () => { sb.PropSprites = { clockNext: () => Infinity, pulsing: () => false }; }, () => { delete sb.PropSprites; });
  calm('a sky with nothing crossing (drift and twinkle are ambient)', () => { sb.SpaceBG = { nextChange: () => Infinity }; }, () => { delete sb.SpaceBG; });
  calm('a meteor on a LANDED station (no sky is drawn there)', () => { sb.SpaceBG = { nextChange: n => n }; sb.Terrain = { active: () => true }; }, () => { delete sb.SpaceBG; delete sb.Terrain; });
  calm('a meteor during a still render (no sky in it)', () => { sb.SpaceBG = { nextChange: n => n }; sb.stillPass = { fill: '#000' }; }, () => { delete sb.SpaceBG; sb.stillPass = null; });
  calm("an asleep hero with its glance cooldown lapsed (maybeGlance skips sleep)", () => { hero.goal = 'sleep'; hero.glanceCd = 0; }, () => { hero.goal = null; hero.glanceCd = Infinity; });
  calm('a crew body with its glance cooldown lapsed (crew have no maybeGlance)', () => { mate.glanceCd = 0; }, () => { mate.glanceCd = Infinity; });
  calm('a talk encounter in the silence between turns', () => {
    sb.socialBeat = { startedAt: now - K.TALK_SPEAK_MS - 100, until: now + 1e6, lastArrivalAt: now - 5000 };
    mate.social = { phase: 'hold', kind: 'huddle', holdAt: now - 5000, holdLen: 1e6 };
  }, () => { sb.socialBeat = null; mate.social = null; });

  // ---- the changes the frame can see coming: stillDue -------------------------------------------------------------
  const due = (label, mutate, at, revert, inFrame) => {
    mutate();
    verdict(inFrame); const s = verdict(inFrame);
    A.ok(s.stillNow && Math.abs(s.stillDue - at) < 1e-6, label + ' sets stillDue (+' + (s.stillDue - now).toFixed(0) + ' ms' + (s.stillNow ? '' : ', got motion: ' + s.stillWhy) + ')');
    if (revert) revert();
    settle();
  };
  due("an idle body's next decision (idleUntil)", () => { mate.idleUntil = now + 700; }, now + 700, () => { mate.idleUntil = Infinity; });
  due('a glance cooldown ending (glanceCd)', () => { hero.glanceCd = now + 450; }, now + 450, () => { hero.glanceCd = Infinity; });
  due("a glance turning back", () => { hero.glance = { until: now + 380, dir: 'west' }; }, now + 380, () => { hero.glance = null; });
  due("a body's next fidget (nextFidget)", () => { mate.nextFidget = now + 640; }, now + 640, () => { mate.nextFidget = 0; });
  due("the hero at a prop: its fidget, not its lapsed glance cooldown", () => { hero.goal = 'use'; hero.glanceCd = 0; hero.nextFidget = now + 820; }, now + 820, () => { hero.goal = null; hero.glanceCd = Infinity; hero.nextFidget = 0; });
  due("the hero watching a belt: THE LOOK-UP's floor (lookCd), not its lapsed glance cooldown", () => { hero.goal = 'watch'; hero.glanceCd = 0; hero.lookCd = now + 930; }, now + 930, () => { hero.goal = null; hero.glanceCd = Infinity; hero.lookCd = 0; });
  due("the next blink / clock-driven pose frame (drawBody's _renderNextAt)", () => { mate._renderNextAt = now + 120; }, now + 120, () => { mate._renderNextAt = 0; });
  due('a speech bubble vanishing', () => { mate.say = { text: 'ok', until: now + 2600 }; }, now + 2600, () => { mate.say = null; });
  due('an encounter hold ending (from the last arrival)', () => {
    sb.socialBeat = { until: now + 1e6, lastArrivalAt: now - 100 };
    mate.social = { phase: 'hold', kind: 'watch', holdAt: now - 400, holdLen: 900 };
  }, now + 800, () => { sb.socialBeat = null; mate.social = null; });
  due('the next talk turn opening (talkTurn slots)', () => {
    const s0 = now - K.TALK_SLOT_MS - (K.TALK_SPEAK_MS + 150);   // slot 1, past its mouth time: slot 2 opens next
    sb.socialBeat = { startedAt: s0, until: now + 1e6, lastArrivalAt: s0 };
    mate.social = { phase: 'hold', kind: 'huddle', holdAt: s0, holdLen: 1e6 };
  }, now + K.TALK_SLOT_MS - K.TALK_SPEAK_MS - 150, () => { sb.socialBeat = null; mate.social = null; });
  due('a chase stare ending', () => { mate.chase = { phase: 'stare', until: now + 900, endAt: now - 1, hardUntil: now + 5000, repathAt: now - 1 }; }, now + 900, () => { mate.chase = null; });
  due('a chase between repaths', () => { mate.chase = { phase: 'pursue', endAt: now + 3000, hardUntil: now + 9000, repathAt: now + 600 }; }, now + 600, () => { mate.chase = null; });
  due('the cursor going stale under a chase', () => { sb.lastCursor = { wx: 0, wy: 0, t: now - K.CURSOR_FRESH_MS + 300 }; mate.chase = { phase: 'pursue', endAt: now + 3000, hardUntil: now + 9000, repathAt: now + 600 }; }, now + 300, () => { mate.chase = null; sb.lastCursor = { wx: 0, wy: 0, t: -1e9 }; });
  due('a mimic ending', () => { mate.mimic = { until: now + 450 }; }, now + 450, () => { mate.mimic = null; });
  due('a held SEND TO crate releasing at its grace', () => { sb.sendCrates.push({ t0: 0, born: now - 1000 }); }, now + 7000, () => { sb.sendCrates.length = 0; });
  due('a ghost spawn', () => { sb.geo = { belts: [] }; sb.ghost = { nextChange: () => now + 2500 }; }, now + 2500, () => { sb.ghost = null; sb.geo = null; });
  due("a drawn prop's next stepped frame (an occupied screen's beam)", () => { sb.PropSprites = { clockNext: () => now + 210 }; }, now + 210, () => { delete sb.PropSprites; });
  due('the next meteor', () => { sb.SpaceBG = { nextChange: () => now + 2222 }; }, now + 2222, () => { delete sb.SpaceBG; });
  due("a draw pass's own due change (drawCRT: the static grain's next step)", () => {}, now + 66, null, () => W.noteDue(now + 66, now));
  due('the cinecam re-cast', () => { sb.camLock = { id: 'a', source: 'cine' }; sb.cineHoldUntil = now + 900; }, now + 900, () => { sb.camLock = null; });
  due("the cinecam's 3 s still-subject grace", () => { sb.cineWalkAt = now - 1000; }, now + 2000, () => { sb.cineWalkAt = -1e9; });
  due('an encounter ending', () => { sb.socialBeat = { until: now + 1500 }; }, now + 1500, () => { sb.socialBeat = null; });
  due('an assembly converging', () => { sb.gathering = { phase: 'converge', convergeUntil: now + 700, until: now + 1e6 }; }, now + 700, () => { sb.gathering = null; });
  due("the overseer's next line (an assembly holding, between lines)", () => {
    sb.gathering = { phase: 'hold', holdFrom: now - K.GATHER_SPEAK_MS - 400, holdLen: 1e6, until: now + 1e6 };
  }, now + K.GATHER_GAP_MS - 400, () => { sb.gathering = null; });
  due('an assembly breaking up (the overseer leaves last)', () => { sb.gathering = { phase: 'breaking', scatterAt: now - 100, until: now + 1e6 }; }, now + K.OVERSEER_BREAK_MS - 100, () => { sb.gathering = null; });
  due('the next gathering roll (maybeGather, every tick)', () => { sb.gatherRollAt = now + 1234; }, now + 1234, () => { sb.gatherRollAt = -1e9; });
  due('the station going quiet long enough to gather', () => { sb.stationBusyAt = now - K.GATHER_QUIET_MS + 500; }, now + 500, () => { sb.stationBusyAt = -1e9; });
  due('the COMMS stare going cold', () => { sb.chatFocusId = 'hero'; sb.chatWarmUntil = now + 1500; }, now + 1500, () => { sb.chatFocusId = null; sb.chatWarmUntil = -1e9; });
  due('the link going stale (LINK DOWN)', () => { sb.lastSseEventAt = now - K.LINK_STALE_MS + 777; }, now + 777, () => { sb.lastSseEventAt = 0; });
  // an off-screen body's DECISION clock is due too (review 10-21): it can decide for an on-screen partner (a huddle within
  // SOCIAL_NEAR_RADIUS, a border meeting in the next room, a mutual glance) — its own drawn-frame and blink edges are not
  due("an off-screen body's next decision (an initiator past the edge decides for an on-screen partner too)", () => { mate.px = -5000; mate.idleUntil = now + 300; }, now + 300, () => { mate.px = 300; mate.idleUntil = Infinity; });
  due("an off-screen body's cooldown lapsing (neighborGlanceCd: a mutual glance turns an on-screen neighbour)", () => { mate.px = -5000; mate.neighborGlanceCd = now + 410; }, now + 410, () => { mate.px = 300; mate.neighborGlanceCd = 0; });
  calm("an off-screen body's drawn-frame edge (a blink nobody can see)", () => { mate.px = -5000; mate._renderNextAt = now + 120; }, () => { mate.px = 300; mate._renderNextAt = 0; });
  {
    mate.px = -5000; mate._renderNextAt = now + 120; settle();
    const s = settle();
    A.ok(s.stillNow && Math.abs(s.stillDue - (now + 120)) > 1e-6, "...it books nothing: an off-screen body's blink / pose frame is never due");
    mate.px = 300; mate._renderNextAt = 0; settle();
  }
  calm('gathering gates under reduced motion (no assembly ever rolls)', () => { sb.rmOn = true; sb.gatherRollAt = now + 50; }, () => { sb.rmOn = false; sb.gatherRollAt = -1e9; });
  A.ok(settle().stillDue === Infinity || settle().stillDue > now, 'past clocks are never due');
}

{
  const gate = (A.fnBody(code, 'function frameBody(now)').match(/if \((camLerp && !camAnim && !camLock)\) \{/) || [])[1];
  A.ok(!!gate && A.fnBody(code, 'function stillVerdict(now)').includes('(' + gate + ')'), "the verdict's focus-ease term is the ease's own gate in frameBody (" + gate + ')');
}

// ---- 7b. THE PROP LOOP: a body resting on a prop leaves its art as drawn; a body working one is motion (final fixes 10-21) ----
// The real lines of drawScene's prop pass (who holds which prop, its `work`, its `live`, the STILL mark), run per prop on the
// real REST_USE / restingOn, with each prop's use kind read from the real catalog in propsprites.js.
{
  const sceneSrc = A.fnBody(code, 'function drawScene(now, dt, slices)');
  const lp = sceneSrc.indexOf('const leisureProps = new Set();'), lpEnd = sceneSrc.indexOf('\n', sceneSrc.indexOf('for (const body of [agent, ...crew])', lp));
  const wk = sceneSrc.indexOf('const work = ('), wkEnd = sceneSrc.indexOf("stillMove('prop');", wk) + "stillMove('prop');".length;
  A.ok(lp > 0 && lpEnd > lp && wk > lpEnd && wkEnd > wk && wkEnd - wk < 1600, '(the prop pass lines are found in drawScene)');
  const extra = `var outboxLit = false, scanningTiles = new Set();
function bayLit() { return false; } function workstationLit() { return false; } function isWorkstationProp() { return false; }
function heatFor() { return 0; } function deskProgFor() { return null; } function workstationOccupied() { return false; }
function propOnScreen() { return true; }
function propPass(now) { ${sceneSrc.slice(lp, lpEnd)}
  for (const p of (geo && geo.props) || []) { ${sceneSrc.slice(wk, wkEnd)} } }
this.propPass = propPass;`;
  const ps = fs.readFileSync(path.join(root, 'frontend/app/propsprites.js'), 'utf8');
  const kindOf = id => { const m = ps.match(new RegExp('\\{ id: "' + id + '",[^\\n]*?use: \\{ kind: \'(\\w+)\'')); return m ? m[1] : null; };
  const w = makeWorld(60, { extra }), sb = w.sb, W = w.W;
  const hero = body({ id: 'hero' }), mate = body({ id: 'mate', px: 300 });
  sb.agent = hero; sb.crew = [mate];
  const now = 5000;
  const verdict = () => { W.stillBegin(); sb.propPass(now); W.stillVerdict(now); return W.st(); };
  const holding = (id, label, want) => {
    const kind = kindOf(id);
    A.ok(!!kind, '(' + id + ' is in the catalog, use kind ' + kind + ')');
    sb.geo = { props: [{ id: 'p_' + id, t: id, x: 10, y: 10, w: 1, h: 1, use: { kind } }] };
    mate.usingProp = 'p_' + id; verdict();
    const s = verdict();
    A.ok(want ? s.stillWhy === want : s.stillNow, label + ' → ' + (want || 'still') + (s.stillNow ? '' : ' [got ' + s.stillWhy + ']'));
    mate.usingProp = null; sb.geo = null; verdict();
  };
  holding('bunk', 'a body napping in a bunk (kind bed: the quilt breath is the prop clock\'s due edge)', null);
  holding('beanbag', 'a body lounging on a beanbag', null);
  holding('couch', 'a body on a couch', null);
  holding('stool', 'a body perched on a stool', null);
  holding('benchpress', 'a body on the bench press (static art)', null);
  holding('punchbag', 'a body boxing the heavy bag (kind bag: active punching, the bag swings)', 'prop');
  holding('tv', 'a body using the TV (its screen plays)', 'prop');
  A.ok(verdict().stillNow, '...and with no prop held the floor is still');
}

// ---- 8. the wiring in the real world.js ---------------------------------------------------------------------------
const bodySrc = A.fnBody(code, 'function frameBody(now)');
A.ok(/^\s*function frameBody\(now\) \{\s*stillBegin\(\);/.test(bodySrc), 'frameBody judges itself: stillBegin() is its first act');
A.ok(/drawScene\(now, dt, slices\);\s*stillVerdict\(now\);\s*\}$/.test(bodySrc.trim()), '...and stillVerdict(now) its last, after the scene drew');
A.ok(/if \(!cache\) \{[\s\S]{0,400}return;/.test(bodySrc) && bodySrc.indexOf('stillBegin()') < bodySrc.indexOf('if (!cache)'),
  'a frame with no bake (the early return) is never judged still');
A.ok(/function stillBegin\(\) \{[^}]*stillDueAcc = Infinity;/.test(code) && !/function stillVerdict\(now\) \{[\s\S]*?stillDueAcc = Infinity/.test(A.fnBody(code, 'function stillVerdict(now)')),
  "the due accumulator is cleared at the TOP of the frame, so a draw pass's noteDue survives to the verdict");
const sceneSrc = A.fnBody(code, 'function drawScene(now, dt, slices)');
A.ok(/^function drawScene\(now, dt, slices\) \{\s*if \(!slices\) slices = \[\[dt, now\]\];\s*if \(typeof PropSprites !== 'undefined' && PropSprites\.clockBegin\) PropSprites\.clockBegin\(\);/.test(sceneSrc),
  "every scene pass starts the props' clock readout afresh (PropSprites.clockBegin)");
A.ok(/if \(!stillMark && \(\(work && !\(leisureProps\.has\(p\.id\) && restingOn\(p\)\)\) \|\| \(live && \(live\.heat > 0 \|\| live\.prog != null \|\| live\.scanning\)\)\)\s*&& propOnScreen\(p\)\) stillMove\('prop'\);/.test(sceneSrc),
  'the prop pass marks an on-screen prop with live content (work, heat, a progress strip, a scan) as motion');
A.ok(/stillMove\('crate'\);[^\n]*\n\s*for \(let i = 0; i < shown; i\+\+\) drawWaitCrate/.test(A.fnBody(code, 'function drawQueueJam(now)')), 'a standing queue jam (its crates bob) marks the frame moving');
{
  const crt = A.fnBody(code, 'function drawCRT(now)');
  A.ok(/const PER = 16800, SWEEP = 2600, t = now % PER;\s*if \(t < SWEEP\) stillMove\('fx'\); else noteDue\(now - t \+ PER, now\);/.test(crt), "the CRT roll bar is motion while it sweeps, and its next sweep is due");
  A.ok(/const fi = reduceMotion\(\) \? 0 : Math\.floor\(now \/ 66\);\s*if \(!reduceMotion\(\)\) noteDue\(\(fi \+ 1\) \* 66, now\);/.test(crt), "the CRT static's next 66 ms step is due (it lands on its own vsync)");
}
A.ok(/if \(!geom && !\(typeof SPRITES !== 'undefined' && SPRITES\.loading\)\) drawFallback\(now, who\);\s*if \(!geom\) who\._renderLive = !who\.sitting;/.test(A.fnBody(code, 'function drawAgent(now, who)')),
  'a procedural fallback body (it bobs while it stands) reports itself live');
A.ok(/if \(now - pinCheckAt < 400\) \{ if \(\(count \| 0\) > pinnedCount\) noteDue\(pinCheckAt \+ 400, now\); return; \}/.test(A.fnBody(code, 'function maybePinProposal(now, count)')),
  "a pin walk waiting on maybePinProposal's 400 ms re-check is due at it");
A.ok(/if \(typeof U\.bus\.tap === 'function'\) U\.bus\.tap\(motionWake\);/.test(A.fnBody(code, 'function connectChannelBridge()')), 'every harness event on U.bus wakes a still floor');
A.ok(/function setActivityFor\(agentId, kind\) \{\s*motionWake\(\);/.test(code), 'a body summoned or released by the floor itself (a reconcile, the TTL sweep) wakes it');
A.ok(/return wakeOnCall\(\{ init, rebake,/.test(code), 'the World API is returned through the STILL WAKE wrapper');
{
  const m = world.match(/const WAKE_API = new Set\(\[([\s\S]*?)\]\);/);
  const names = m ? m[1].match(/'[^']+'/g).map(s => s.slice(1, -1)) : [];
  const api = code.slice(code.indexOf('return wakeOnCall({'));
  const missing = names.filter(n => !new RegExp('[{,\\s]' + n + '\\s*[,:(]').test(api));
  A.ok(names.length > 30 && !missing.length, 'every WAKE_API name is a real export (' + names.length + ' names' + (missing.length ? '; missing: ' + missing.join(', ') : '') + ')');
  for (const n of ['say', 'setActivity', 'setActivityFor', 'focusAgent', 'focusBody', 'lockBody', 'spawnAgent', 'despawnAgent', 'pulseLevelUp', 'loadStation'])
    A.ok(names.includes(n), 'World.' + n + ' wakes a still floor');
  for (const n of ['renderPace', 'cameraState', 'cameraDbg', 'dbg', 'getActivity', 'crewFrames', 'planStatus'])
    A.ok(!names.includes(n), 'World.' + n + ' is a read: polling it never keeps a still floor at full pace');
  A.ok(names.includes('frameReviewRoom') && names.includes('init'), 'World.frameReviewRoom (the builder\'s camera cut, from a timer) and World.init (its resize re-anchors the pan) wake a still floor');

  // THE CAMERA RATCHET (final fixes 10-21): every exported World function that writes the camera — scale, panX, panY, camLock,
  // camLerp or camAnim, itself or through any world.js function it reaches — is wrapped by wakeOnCall, so a camera API added
  // later can never leave its move waiting out a still interval. Reached = named anywhere in its body (a call, or a value
  // handed on: a callback, a timer); writes inside the frame itself (frame / frameBody / drawScene) are that frame's own,
  // judged by its verdict. EXEMPT names say why.
  const CAM = ['scale', 'panX', 'panY', 'camLock', 'camLerp', 'camAnim'];
  const writeRe = v => new RegExp('(^|[^.\\w$])' + v + '\\s*(?:=(?!=)|\\+=|-=|\\*=|\\/=)', 'g');
  const localRe = v => new RegExp('\\b(?:let|const|var)\\s+(?:[\\w$]+\\s*=[^;,]*,\\s*)*' + v + '\\b|function\\s*[\\w$]*\\s*\\([^)]*\\b' + v + '\\b[^)]*\\)|\\(\\s*\\{[^}]*\\b' + v + '\\b[^}]*\\}\\s*\\)\\s*=>');
  const writes = src => CAM.filter(v => writeRe(v).test(src) && !localRe(v).test(src));
  const decl = {}, range = [];
  for (const m of code.matchAll(/\bfunction ([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (decl[m[1]]) continue;
    decl[m[1]] = A.fnBody(code.slice(m.index), 'function ' + m[1] + '(');
    range.push([m.index, m.index + decl[m[1]].length]);
  }
  const big = Object.keys(decl).filter(n => decl[n].length > code.length / 4);
  A.ok(Object.keys(decl).length > 500 && !big.length, '(the ratchet indexed ' + Object.keys(decl).length + ' world.js functions, none mis-scanned long' + (big.length ? ': ' + big.join(', ') : '') + ')');
  const FRAME = new Set(['frame', 'frameBody', 'drawScene']);
  const refs = src => [...new Set([...src.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)(?![\w$])(?!\s*:)/g)].map(m => m[1]))].filter(n => decl[n] && !FRAME.has(n));
  const Wr = {}, Ed = {};
  for (const n of Object.keys(decl)) { Wr[n] = new Set(writes(decl[n])); Ed[n] = refs(decl[n]).filter(x => x !== n); }
  for (let changed = true; changed;) {
    changed = false;
    for (const n of Object.keys(decl)) for (const g of Ed[n]) for (const v of Wr[g]) if (!Wr[n].has(v)) { Wr[n].add(v); changed = true; }
  }
  // the export object, split at its top-level commas
  const at = code.indexOf('return wakeOnCall({');
  const obj = A.fnBody(code.slice(at), 'return wakeOnCall(');
  const inner = obj.slice(obj.indexOf('{') + 1, obj.lastIndexOf('}'));
  const props = [];
  { let depth = 0, cur = '';
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '"' || c === "'" || c === '`') { let j = i + 1; for (; j < inner.length; j++) { if (inner[j] === '\\') { j++; continue; } if (inner[j] === c) break; } cur += inner.slice(i, j + 1); i = j; continue; }
      if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
      if (c === ',' && depth === 0) { props.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) props.push(cur.trim()); }
  const exportWrites = {};
  const bad = [];
  for (const p of props) {
    const m = p.match(/^([A-Za-z_$][\w$]*)\s*(?::\s*([\s\S]*))?$/);
    if (!m) { bad.push(p.slice(0, 40)); continue; }
    const key = m[1], val = (m[2] == null ? key : m[2]).trim(), bare = /^[A-Za-z_$][\w$]*$/.test(val);
    const s = new Set(bare ? (Wr[val] || []) : writes(val));
    if (!bare) for (const g of refs(val)) for (const v of Wr[g]) s.add(v);
    exportWrites[key] = [...s];
  }
  A.ok(props.length > 120 && !bad.length, '(the ratchet read ' + props.length + ' World exports' + (bad.length ? '; unparsed: ' + bad.join(' | ') : '') + ')');
  // coverage: every write to a camera variable sits in a function the ratchet indexed, or in the export object itself
  const lineAt = i => code.slice(code.lastIndexOf('\n', i) + 1, code.indexOf('\n', i));
  const orphan = [];
  for (const v of CAM) for (const m of code.matchAll(writeRe(v))) {
    const i = m.index + m[1].length;
    if (/^\s*let\b/.test(lineAt(i)) && !range.some(([a, b]) => i > a && i < b)) continue;   // the module's own declaration
    if ((i >= at && i < at + obj.length) || range.some(([a, b]) => i > a && i < b)) continue;
    orphan.push(v + ': ' + lineAt(i).trim().slice(0, 60));
  }
  A.ok(!orphan.length, 'every camera write in world.js is inside a function the ratchet reads' + (orphan.length ? ' — not: ' + orphan.join(' | ') : ''));
  const CAM_EXEMPT = {
    renderStill: 'a still render: it swaps in its own canvas and camera and puts the live ones back in finally — the floor\'s view never changes',
    renderStillOfTiles: 'renderStill, cropped',
    stop: 'stops the loop (running = false): nothing is drawn after it, and start() draws at once',
  };
  const writers = Object.keys(exportWrites).filter(k => exportWrites[k].length);
  A.ok(writers.length >= 15, '(the ratchet finds ' + writers.length + ' camera-writing exports: ' + writers.join(', ') + ')');
  const unwrapped = writers.filter(k => !names.includes(k) && !k.startsWith('_dbg') && !CAM_EXEMPT[k]);
  A.ok(!unwrapped.length, 'every World export that writes the camera wakes a still floor (WAKE_API)' + (unwrapped.length ? ' — not wrapped: ' + unwrapped.map(k => k + ' [' + exportWrites[k].join(',') + ']').join(', ') : ''));
  const staleEx = Object.keys(CAM_EXEMPT).filter(k => !writers.includes(k) || names.includes(k));
  A.ok(!staleEx.length, 'every camera exemption is a real camera writer left unwrapped on purpose' + (staleEx.length ? ' — stale: ' + staleEx.join(', ') : ''));
  A.ok(/const keep = \{ cv, ctx, scale, panX, panY, overlaysOn \};[\s\S]*finally \{[\s\S]*cv = keep\.cv; ctx = keep\.ctx; scale = keep\.scale; panX = keep\.panX; panY = keep\.panY;/.test(A.fnBody(code, 'function renderStill(maxPx, opts)')),
    '(renderStill really does restore the live camera in finally)');
  for (const k of ['frameReviewRoom', 'restoreCamera', 'lockBody', 'focusBody', 'focusAgent', 'camPushIn', 'init'])
    A.ok(writers.includes(k), '(the ratchet sees World.' + k + ' write the camera)');
}

// ---- 8b. THE CLOCK RATCHET: every clock the frame clock is compared against in world.js is due in the verdict, or exempt for
// a stated reason. A gate the verdict does not know is up to 33 ms of latency on every change it gates — so a NEW one fails
// here until it is classified. Gates are `now|fnow <op> X` and `X <op> now|fnow` (X a field path, `X || 0` included), and
// object-qualified: a body field (agent/self/b/body/me/other/who/obs) reads as `body.<field>`, a nested one as `<obj>.<field>`.
{
  const vsrc = strip(world.slice(vFrom, vTo));
  let gcode = world;
  for (const [a, b] of [['  const PACE_VISIBLE_MS', '  function renderPace()'], ['  /* STILL VERDICT', '  // ---- end STILL VERDICT']]) {
    const i = gcode.indexOf(a), j = gcode.indexOf(b, i); gcode = gcode.slice(0, i) + gcode.slice(j);
  }
  gcode = strip(gcode);
  const PATHRE = '[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*|\\.get\\([^)]*\\))*', OPRE = '(?:>=|<=|<|>)';
  const BODY = /^(agent|self|b|body|me|other|who|obs|to)$/;
  const keys = new Set();
  const add = p => {
    if (/^(now|fnow|t|Math|Infinity)$/.test(p)) return;
    const parts = p.replace(/\.get\([^)]*\)/g, '.get').split('.');
    if (parts.length === 1) { keys.add(parts[0]); return; }
    const obj = parts[parts.length - 2], f = parts[parts.length - 1];
    keys.add((BODY.test(obj) && parts.length === 2 ? 'body' : obj) + '.' + f);
  };
  for (const m of gcode.matchAll(new RegExp('\\b(?:now|fnow)\\s*' + OPRE + '\\s*\\(?\\s*(' + PATHRE + ')', 'g'))) add(m[1]);
  for (const m of gcode.matchAll(new RegExp('(' + PATHRE + ')\\s*(?:\\|\\|\\s*0\\s*)?\\)?\\s*' + OPRE + '\\s*(?:now|fnow)\\b', 'g'))) add(m[1]);
  const clocks = new Set(makeWorld(60).W.consts.BODY_CLOCKS);
  // tracked: the verdict must name it (RegExp over the verdict's source)
  const TRACKED = {
    'glance.until': /b\.glance\.until/, 'say.until': /b\.say\.until/, 's.until': /b\.say\.until/, 'chatter.until': /b\.chatter\.until/,
    'ch.until': /noteDue\(ch\.until, now\)|b\.chatter\.until/, 'pl.until': /noteDue\(ch\.until, now\)[\s\S]*noteDue\(b\.mimic\.until, now\)/,
    'pl.endAt': /noteDue\(ch\.endAt, now\)/, 'pl.hardUntil': /noteDue\(ch\.hardUntil, now\)/, 'pl.repathAt': /ch\.repathAt > now[\s\S]*noteDue\(ch\.repathAt, now\)/,
    'holdFrom': /socialBeat\.lastArrivalAt\) \|\| pl\.holdAt \|\| 0\) \+ \(pl\.holdLen \|\| 0\)/,
    'socialBeat.until': /noteDue\(socialBeat\.until, now\)/, 'gathering.until': /noteDue\(gathering\.until, now\)/,
    'gathering.convergeUntil': /noteDue\(gathering\.convergeUntil, now\)/, 'gathering.holdFrom': /noteDue\(h0 \+ \(gathering\.holdLen \|\| 0\), now\)/,
    'gatherGateUntil': /noteDue\(gatherGateUntil, now\)/, 'gatherRollAt': /noteDue\(gatherRollAt, now\)/, 'chatWarmUntil': /noteDue\(chatWarmUntil, now\)/,
    'cineHoldUntil': /noteDue\(cineHoldUntil, now\)/, 'motionUntil': /now < motionUntil/,
  };
  // exempt: why the verdict need not know it
  const DECISION = 'read only inside a decision that a body clock (BODY_CLOCKS) or an event triggers — it starts nothing by itself';
  const EXEMPT = {
    'body.ackScanAt': 'the acknowledgement re-scan gap: it acts only on a body walking past in view — motion already',
    'emote.until': 'a dev readout (World.bodies), never a gate', 'attn.until': DECISION, 'beltWatch.until': DECISION, 'socialPairCd.get': DECISION,
    'socialGateUntil': DECISION, 'crewBeatGateUntil': DECISION, 'chaseGateUntil': DECISION, 'placeCd': DECISION, 'postCd': DECISION, 'lastUntil': DECISION,
    'userReturnUntil': "raises THE LOOK-UP's chance inside maybeGlance, whose pending roll is motion (heroGlanceAt)",
    'plan.until': 'a traffic plan for a body holding a walk target — motion already', 'trafficRetry.get': 'a traffic retry for a body holding a walk target — motion already',
    'forgetAt': 'habituation decay: it changes later decisions, nothing drawn', 'mournCd': 'gates a grief beat that a prop edit queues (an input / World API wake)',
    'dueWatch': "the due-draw readout (THE STILL BOOKING): frame() records how late the verdict's own due change drew — it gates nothing",
  };
  const unknown = [], stale = [];
  for (const k of keys) {
    if (k.startsWith('body.') && clocks.has(k.slice(5))) continue;
    if (TRACKED[k]) { if (!TRACKED[k].test(vsrc)) stale.push(k); continue; }
    if (EXEMPT[k]) continue;
    unknown.push(k);
  }
  A.ok(keys.size > 60, 'the ratchet found the inner life\'s gates (' + keys.size + ' clocks)');
  A.ok(!unknown.length, 'every clock world.js gates on is due in the verdict or exempt for a reason' + (unknown.length ? ' — unclassified: ' + unknown.sort().join(', ') : ''));
  A.ok(!stale.length, 'every clock classified as tracked really is read by the verdict' + (stale.length ? ' — not found: ' + stale.join(', ') : ''));
  const unused = Object.keys(EXEMPT).concat(Object.keys(TRACKED)).filter(k => !keys.has(k));
  A.ok(!unused.length, 'the ratchet table names no clock world.js no longer has' + (unused.length ? ' — remove: ' + unused.join(', ') : ''));
  const bodyUnused = [...clocks].filter(n => !keys.has('body.' + n) && !['hardUntil', 'convergeUntil', 'spokeUntil', 'lastFunUntil', 'barJoinUntil'].includes(n));
  A.ok(!bodyUnused.length, 'every BODY_CLOCKS name is a body clock world.js gates on' + (bodyUnused.length ? ' — not gated: ' + bodyUnused.join(', ') : ''));
}
// ambient stays ambient: the verdict never reads the light map, dust, glows or the backdrop's draw — only the sky's
// one allocation-free readout (SpaceBG.nextChange: a meteor, the bolide, the belt's shower)
{
  const vsrc = strip(world.slice(vFrom, vTo));
  A.ok(!/drawDust|drawGlows|drawNavLights|cache\.flickers|sceneRenderer|drawAtmosphere|SpaceBG\.draw/.test(vsrc), 'the verdict never treats the starfield, glows, dust or nav lights as motion');
  A.ok((vsrc.match(/SpaceBG\.\w+/g) || []).every(s => s === 'SpaceBG.nextChange'), '...and reads the sky only through SpaceBG.nextChange');
  A.ok(!/getImageData|\.slice\(|\.map\(|\.filter\(|\[agent, \.\.\.crew\]|new (?:Map|Set|Array)\(/.test(vsrc.replace(/const BODY_CLOCKS[\s\S]*?\]\);/, '').replace(/const REST_USE[^\n]*/, '')),
    'the verdict reads state, never pixels, and allocates nothing per frame');
}

// ---- 9. the readouts it reads (the prop / sky / remaster ones: test/render-still-readouts.test.js) ---------------------
A.ok(/b\._renderNextAt = clockNext;/.test(assets), "SPRITES.drawBody publishes when a body's drawn frame next changes on the clock (_renderNextAt)");
A.ok(/clockNext = Math\.min\(clockNext, nowMs \+ \(bt < 130 \? 130 - bt : 3300 - bt\)\)/.test(assets), '...the blink edge (eyes open / next shut)');
A.ok(/const q = nowMs \/ \(1000 \/ fps\) \+ aph;\s*clockNext = Math\.min\(clockNext, nowMs \+ \(Math\.floor\(q\) \+ 1 - q\) \* \(1000 \/ fps\)\);/.test(assets),
  '...and the next frame of a clock-driven track, from the same phase the frame index uses');
A.ok(/idx = fixedIdx != null[\s\S]{0,500}: Math\.floor\(nowMs \/ \(1000 \/ fps\) \+ aph\);/.test(assets), '(the frame index really is floor(now / (1000 / fps) + aph))');
{
  // _renderLive: published right after the bob, the breath and the speech accent are final — the bob and the accent's ease are
  // motion; the planted breath is _renderDrift (sub-pixel, drawn at its true phase every still frame: review 10-21, option b)
  const i = assets.indexOf('b._renderLive = bob !== 0 || (planted && !reduced && (b._speechEase || 0) > 1e-3);');
  const j = assets.indexOf('b._renderDrift = breath !== 0 || speech !== 0;');
  A.ok(i > 0 && i > assets.indexOf('if (reduced || planted) bob = 0;') && i > assets.indexOf('const breath = planted && !reduced'),
    "SPRITES.drawBody publishes _renderLive from the final bob and the speech accent's ease (a bobbing or still-mouthing body is motion)");
  A.ok(j > i, '...and _renderDrift from the breath and the accent (an overlay over that head rounds to whole px: motion only under one)');
  A.ok(/const breath = planted && !reduced \? Math\.sin\(nowMs \/ 1050 \+ aph\) \* 0\.12 - speech\*\.18 : 0;/.test(assets),
    '(the breath really is a 0.12 world px sine of period 2π·1050 ms: under 0.004 x zoom device px per 33 ms still interval)');
  const wcode = strip(world), vb = A.fnBody(wcode, 'function bodyStillWhy(b, now)');
  A.ok(/if \(overlaysOn && \(moved \|\| b\._renderLive \|\| b\._renderDrift\) && \(b === hoverAgent \|\| bubbleShown\(b, now\)\)\) return 'speech';\s*if \(!bodyOnScreen\(b\)\) return '';/.test(vb),
    'bodyStillWhy judges a body-anchored overlay BEFORE it drops an off-screen body (the bubble is clamped to the canvas)');
  A.ok(vb.indexOf('noteDue(b[BODY_CLOCKS[i]], now)') < vb.indexOf('if (!bodyOnScreen(b))') && vb.indexOf('noteDue(b._renderNextAt, now)') > vb.indexOf('if (!bodyOnScreen(b))'),
    "...books every placed body's decision clocks before it, and only an on-screen body's drawn-frame edge after it");
  const bub = A.fnBody(wcode, 'function drawBubble(now, who)');
  A.ok(/if \(!s\.text \|\| \(s\.until < now && !speakingNow\)\) \{ drawChatterBubble\(now, who\); return; \}/.test(bub)
    && /const speakingNow = \(who === agent\) && typeof Voice !== 'undefined' && Voice\.isSpeaking && Voice\.isSpeaking\(\);/.test(bub),
    "bubbleShown mirrors drawBubble's own test (a line, until its time, or past it while the hero's voice speaks)");
}
{
  // ghostline.nextChange: the projection's motion and its next spawn, from its own clock
  const sb = { console, Conveyor: undefined };
  vm.createContext(sb);
  vm.runInContext(ghostline + '\nthis.GL = GhostLine;', sb);
  const g = sb.GL.create();
  A.eq(g.nextChange(1000), Infinity, 'an idle ghost projection reports nothing due');
  A.ok(/function nextChange\(nowMs\) \{\s*if \(\(engine && engine\.boxCount\(\) > 0\) \|\| notes\.length \|\| pendingChain\) return nowMs;\s*return cur && nextSpawnAt > 0 \? nextSpawnAt : Infinity;/.test(ghostline),
    'a riding ghost, a fading caption or a pending chain is motion now; otherwise the next spawn is due');
}
{
  // U.bus.tap: fires after an emit that reached a listener, never for one that reached nobody
  const sb = { console, window: {}, document: {}, navigator: {}, setTimeout, clearTimeout };
  vm.createContext(sb);
  vm.runInContext(util + '\nthis.U = U;', sb);
  const seen = [];
  sb.U.bus.tap(ev => seen.push(ev));
  sb.U.bus.on('agent.run.start', () => seen.push('handler'));
  sb.U.bus.emit('agent.run.start', {});
  sb.U.bus.emit('nobody.listens', {});
  A.eq(seen.join(','), 'handler,agent.run.start', 'U.bus.tap runs after the listeners of an emitted event, and not for an event nobody hears');
  sb.U.bus.tap(() => { throw new Error('tap boom'); });
  const err = console.error; console.error = () => {};
  try { A.notThrows(() => sb.U.bus.emit('agent.run.start', {}), 'a throwing tap never breaks the emit'); } finally { console.error = err; }
}

A.report('render still tier (Andrew 2026-10-21)');
