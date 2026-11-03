/* node test/world-idle-renderer.test.js — THE IDLE RENDERER (wave 5, behind a flag: gh#69, gh#114, bug 9256a771, email E55).

   An idle station should cost close to nothing, without lowering the visible frame rate. Two classes, each executed on the
   real code, each failing on the commit below it (c9a51fa73, and 0b8441064), where the auto-director trailed walkers for as
   long as a window was left open and every material was painted into its own canvas at boot:

     1. THE CINECAM RESTS — with the flag on, a station nobody has touched for the takeover time plus CINE_REST_MS, with no
        run live for CINE_REST_MS, has its auto-director stand down and stay down; a hand on the window or a live run brings
        it back on its own rules. With the flag off (the default) the director is exactly what it was. Nothing here caps a
        frame rate: the visible and motion paces are untouched.
     2. LAZY ART — with the flag on, no material is painted at boot; one is painted the first time something draws it, at
        most ART_LRU_MAX are held, least recently used out first, and an evicted one is painted again on its next draw. With
        the flag off every material is painted at boot, as before. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), A = require('./_assert');
const ROOT = path.join(__dirname, '..');
const world = fs.readFileSync(path.join(ROOT, 'frontend/app/world.js'), 'utf8');
const texSrc = fs.readFileSync(path.join(ROOT, 'frontend/app/industrialtextures.js'), 'utf8');

/* ---- 1. THE CINECAM RESTS (the real cinecamTick, cineRested and liveRunCount) ---- */
const sliceW = header => { const b = A.fnBody(world, header); A.ok(b.length > 40 && b.length < 8000, header + ' is sliced'); return b; };
const directorSrc = sliceW('  function cinecamTick(') + '\n' + sliceW('  function cineRested(') + '\n' + sliceW('  function liveRunCount(');
const restMs = Number((world.match(/const CINE_REST_MS = ([\d *]+);/) || [])[1] ? eval(world.match(/const CINE_REST_MS = ([\d *]+);/)[1]) : NaN);
A.ok(restMs >= 60000, 'CINE_REST_MS is a real rest (' + restMs + ' ms), not a hair-trigger');
function director(flagOn) {
  return new Function('flagOn', 'REST', `
    const MINZ = 0.5, MAXZ = 6, clampz = (v, a, b) => v < a ? a : v > b ? b : v, U = { irnd: (a, b) => a };
    let camLock = null, camAnim = null, camLerp = null, awakeFrozen = false, cache = {}, chatFocusId = null;
    let camUserAt = 0, cineIdleMs = 120000, cineHoldUntil = 0, cineWalkAt = 0;
    const CINE_REST_MS = REST, reduceMotion = () => false;
    let idleRenderer = flagOn, runSeenAt = 0, cineRestMs = REST;
    const liveRunsByAgent = new Map();
    const crew = [{ id: 'b', agentId: 'b', state: 'walk' }], agent = { id: 'a', agentId: 'a', state: 'idle' };
    const bodyForAgent = id => id === 'a' ? agent : crew.find(c => c.agentId === id) || null;
    ${directorSrc}
    return {
      tick: now => cinecamTick(now), mode: () => camLock ? camLock.source : 'manual',
      touch: now => { camUserAt = now; camLock = null; },
      sessionLock: () => { camLock = { id: 'a', sc: 2, source: 'session' }; }, clearLock: () => { camLock = null; },
      runStart: () => liveRunsByAgent.set('a', new Map([['r1', 0]])), runEnd: () => liveRunsByAgent.delete('a')
    };`)(flagOn, restMs);
}
{
  const MIN = 60000, takeover = 120000;
  const off = director(false);
  off.tick(takeover + 1);
  A.eq(off.mode(), 'cine', 'flag off: the director takes the camera after the hands-off time, as before');
  for (let t = takeover; t < 4 * 3600 * 1000; t += 10 * MIN) off.tick(t);
  A.eq(off.mode(), 'cine', 'flag off: four hours left open, the director is still trailing (nothing changed by default)');

  const on = director(true);
  on.tick(takeover + 1);
  A.eq(on.mode(), 'cine', 'flag on: the director still takes over after the hands-off time (the crew is shown living)');
  on.tick(takeover + restMs - 1);
  A.eq(on.mode(), 'cine', 'flag on: ...and keeps the shot until the rest time has passed');
  on.tick(takeover + restMs + 1);
  A.eq(on.mode(), 'manual', 'flag on: truly idle (no hand, no run) — the director stands down; the camera stays where it is');
  for (let t = takeover + restMs; t < 4 * 3600 * 1000; t += 10 * MIN) on.tick(t);
  A.eq(on.mode(), 'manual', 'flag on: and stays down for as long as the station stays idle (no full-pace camera motion)');
  on.sessionLock(); on.tick(4 * 3600 * 1000);
  A.eq(on.mode(), 'session', 'a session lock still owns the camera outright: the rest never releases it');
  on.clearLock();

  let t = 3 * 3600 * 1000;
  on.runStart(); on.tick(t);
  A.eq(on.mode(), 'cine', 'a live run ends the rest: the director comes back to show the work');
  on.runEnd(); on.tick(t + restMs - 1);
  A.eq(on.mode(), 'cine', 'after the run, the rest waits its full time again');
  on.tick(t + restMs + 1);
  A.eq(on.mode(), 'manual', '...then the floor rests again');

  t += 2 * restMs; on.touch(t); on.tick(t + 1000);
  A.eq(on.mode(), 'manual', 'a hand on the window: the manual camera, as always');
  on.tick(t + takeover + 1);
  A.eq(on.mode(), 'cine', 'and the director takes over again on its own hands-off rule');
}
{
  // the flag: off unless asked; the query wins over the stored value; setIdleRenderer persists it and wakes the floor
  A.ok(/idleRenderer = q != null \? \(q === '1' \|\| q === 'on'\) : \(typeof localStorage !== 'undefined' && localStorage\.getItem\('starnet\.idleRenderer'\) === '1'\);/.test(world), 'world.js: the flag is off unless ?idleRenderer=1 or the stored opt-in');
  const set = sliceW('  function setIdleRenderer(');
  A.ok(/localStorage\.setItem\('starnet\.idleRenderer'/.test(set) && /motionWake\(\);/.test(set), 'setIdleRenderer persists the choice and wakes the floor to judge itself');
  A.ok(/setIdleRenderer, idleRendererOn: \(\) => idleRenderer,/.test(world), 'World exposes the switch for the A/B');
  // never lower the visible frame rate: the paces are the approved ones and the idle code books no cap
  A.ok(/const PACE_VISIBLE_MS = 1000 \/ 60, PACE_MOTION_MS = 1000 \/ 144/.test(world), 'the visible pace stays 60 and the motion pace 144');
  const idleCode = sliceW('  function cineRested(') + sliceW('  function setIdleRenderer(');
  A.ok(!/setFrameCap|frameCapMs|PACE_/.test(idleCode), 'the idle renderer touches no pace and books no frame cap');
}

/* ---- 2. LAZY ART (the real industrialtextures.js in a vm) ---- */
function loadTextures(search, stored) {
  const created = [];
  const canvas = () => {
    const cv = { width: 0, height: 0, getContext: () => ({ filter: 'none', drawImage() {}, fillRect() {}, setTransform() {}, clearRect() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }) }) };
    created.push(cv); return cv;
  };
  class Image { constructor() { this.width = 8; this.height = 8; } set src(v) { this._src = v; Promise.resolve().then(() => this.onload && this.onload()); } get src() { return this._src; } }
  const store = new Map(stored ? [['starnet.idleRenderer', stored]] : []);
  const ctx = vm.createContext({
    console, Image, Promise, Map, Set, Object, Array, Math, Number, String, JSON, Proxy, Uint8ClampedArray, URLSearchParams,
    location: { search }, localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) },
    document: { createElement: () => canvas(), documentElement: { dataset: {} } }
  });
  vm.runInContext(texSrc + '\nthis.__T = IndustrialTextures;', ctx, { filename: 'industrialtextures.js' });
  return { T: ctx.__T, created };
}
(async () => {
  const lru = Number((texSrc.match(/const ART_LRU_MAX = (\d+);/) || [])[1]);
  A.ok(lru >= 8 && lru <= 64, 'ART_LRU_MAX bounds the painted canvases (' + lru + ')');

  const eager = loadTextures('', null);
  await eager.T.ready;
  const all = eager.T.status().assets;
  A.ok(all.length > lru + 4, 'flag off: every material is painted at boot, as before (' + all.length + ')');
  A.eq(eager.T.status().lazyArt, false, 'flag off is the default');

  const lazy = loadTextures('', '1');
  await lazy.T.ready;
  const st0 = lazy.T.status();
  A.eq([st0.lazyArt, st0.artHeld, st0.artPainted], [true, 0, 0], 'flag on: nothing is painted at boot');
  A.eq(lazy.T.enabled(), true, '...and the pack still reports loaded (the originals are in)');
  A.ok(lazy.T._dbgArtTouch(all[0]) && lazy.T.status().artPainted === 1, 'the first draw of a material paints it');
  lazy.T._dbgArtTouch(all[0]);
  A.eq(lazy.T.status().artPainted, 1, 'a second draw reuses the painted canvas');
  for (const name of all) lazy.T._dbgArtTouch(name);
  const st1 = lazy.T.status();
  A.eq(st1.artHeld, lru, 'drawing every material holds at most ART_LRU_MAX painted canvases');
  A.eq(st1.artEvicted, all.length - lru, 'the rest were let go, least recently used first');
  A.eq(lazy.T.status().assets.length, all.length, 'status().assets still names every material loaded (the leak probe and the audit read it)');
  lazy.T._dbgArtTouch(all[all.length - 1]);
  A.eq(lazy.T.status().artPainted, all.length, 'the newest use is still held (no repaint)');
  A.ok(lazy.T._dbgArtTouch(all[0]) && lazy.T.status().artPainted === all.length + 1, 'the oldest went out first: it is painted again on its next draw');
  A.eq(lazy.T._dbgArtTouch('constructor'), false, 'a prototype name is never a material');
  A.eq(lazy.T._dbgArtTouch('no-such-material'), false, 'an unknown material is still absent (callers keep their fallback)');
  lazy.T.restoreMaterials();
  A.eq(lazy.T.status().artHeld, 0, 'a GPU-loss restore drops the painted canvases; they come back as they are drawn');
  const paintedBefore = eager.T.status().assets.length;
  eager.T.restoreMaterials();
  A.eq(eager.T.status().assets.length, paintedBefore, 'flag off: a restore repaints every material, as before');

  // a material whose paint fails at draw time is a failed material, as a failed paint at load was (the pack turns off if it is a base one)
  const broken = loadTextures('', '1');
  await broken.T.ready;
  broken.created.length = 0;
  const realCreate = broken.created.push.bind(broken.created);
  broken.created.push = cv => { cv.getContext = () => { throw new Error('context lost'); }; return realCreate(cv); };
  A.eq(broken.T._dbgArtTouch('floor'), false, 'a paint that throws gives no canvas');
  A.ok(broken.T.status().failed.includes('floor') && broken.T.enabled() === false, '...it is recorded failed, and a lost base material turns the pack off (callers take their fallback, never a half-drawn frame)');
  A.eq(broken.T._dbgArtTouch('floor'), false, 'and it is not retried on every draw');

  const query = loadTextures('?idleRenderer=0', '1');
  await query.T.ready;
  A.eq(query.T.status().lazyArt, false, '?idleRenderer=0 wins over a stored opt-in');
  A.report('world-idle-renderer');
})().catch(e => { console.error(e); process.exit(1); });
