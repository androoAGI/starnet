/* STARNET — spacebg.js : THE BACKDROP. What the station floats in.

   One shared backdrop for the live world (world.js) AND REFIT (build.js), so entering/exiting
   build mode never jumps the sky. Originally a single hardcoded deep-space field; now a small
   REGISTRY of backdrops the commander picks (station-wide, persisted in the StationUI store).

   THE LAW OF THIS FILE, in order of importance:

   1. THE VOID IS THE DEFAULT. It was frozen byte-identical from 2026-07-14 until 2026-09-05, when
      Andrew asked for it to be improved in place (structured nebulas, stepped twinkle, sparkle).
      Its CHARACTER is still the law: sparse cold points on real black, faint distant gas, no
      parallax, the same drift. Never decorate it with bodies.
      On 2026-07-14 a galaxy + ringed planet were added to it and Andrew had them reverted
      (514386de: "keep the sky to starfield + nebulas + band + meteor"). That call stands.
      Richer space lives in THE NURSERY, which is opt-in. Never decorate the default.
      Corollary, learned the hard way on 2026-07-24: a NEW backdrop must not be the default
      plus decoration either. The first attempt at richer space reused this file's own
      nebula/dust/twinkle recipe and added bodies on top, and read exactly as what it was —
      "just the void with planets". A backdrop earns its place by INVERTING the default's
      signature, not by extending it.
   2. A BACKDROP IS NOT A WALLPAPER. Anything at a finite distance below the station MUST
      parallax with the camera, or the eye reads "picture behind a picture" instantly. Deep
      space is the one honest exception — it has no near reference, so THE VOID's depths are
      0/0 and it stays nailed to the screen exactly as before.
   3. THE CAMERA NEVER TILTS. Every backdrop is a thing seen from directly above, at altitude.
      No horizon, no sun in frame, no "up". The station floats; you look past it, straight down.

   Structure:
     - shared helpers: seeded PRNG, star tints, wrapped puff stamps, toroidal tile draw
     - shared weather: the rare meteor and the very rare bolide (space backdrops opt in)
     - BACKDROPS registry: each { label, build(w,h,rnd) -> state, draw(ctx,w,h,now,cam,st) }
     - dispatch: variant-aware tile cache, resize settling, public API

   Coordinates are DEVICE pixels (callers pass canvas.width/height) and draw() is called with
   the IDENTITY transform, before the world's setTransform(scale,0,0,scale,panX,panY). The
   camera is handed in separately so each backdrop can parallax by its own per-layer depth.

   Everything is seeded (mulberry32, fixed seed per backdrop) so the same backdrop at the same
   canvas size always grows the same world — a resize re-lays it deterministically instead of
   reshuffling. Pre-rendered tiles wrap: THE VOID wraps horizontally only (3-stamp, its layers
   never move in y); every backdrop that parallaxes vertically wraps in BOTH axes (9-stamp
   author + 2x2 draw), or a vertical pan tears the tile seam straight across the screen.

   Tuning note inherited from the original field: everything here is judged AFTER the barrel
   warp + CRT pass in world.js, which eats roughly half the contrast. Values look too bold in
   isolation on purpose. Never tune a backdrop on a bare canvas. */
'use strict';

const SpaceBG = (() => {
  const SEED = 0x57A2BE7;                            // fixed: the sky is a place, not a dice roll

  /* ---------------------------------------------------------------- shared helpers ---- */

  function mulberry32(seed) {
    let a = seed | 0;
    return () => {
      a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // star tints: mostly pale blue-white, some warm white, rare violet/teal — weights cumulative
  const TINTS = [
    [0.45, 'rgba(180,200,230,'], [0.72, 'rgba(205,218,242,'], [0.87, 'rgba(255,226,188,'],
    [0.95, 'rgba(196,168,255,'], [1.01, 'rgba(150,235,222,'],
  ];
  const pickTint = r => { for (const t of TINTS) if (r < t[0]) return t[1]; return TINTS[0][1]; };

  // nebula hue families [r,g,b] — the station's phosphor palette pushed into the void
  const NEB_HUES = [[150, 90, 255], [255, 90, 190], [90, 200, 255], [90, 255, 200]];

  const rgba = (c, a) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (+a).toFixed(3) + ')';
  // linear blend of two [r,g,b] triples — for ramps written straight into an ImageData buffer
  const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const px1 = () => Math.max(1, Math.round((typeof window !== 'undefined' && window.devicePixelRatio) || 1));

  /* stamp one soft radial puff, wrapped HORIZONTALLY (x-w / x / x+w) — for layers that only
     ever scroll in x. THE VOID uses this; changing it to the 9-stamp below would add puff
     copies at the top/bottom edges and break law 1. */
  function puff(c, w, x, y, r, rgb, a) {
    for (const xo of [x - w, x, x + w]) {
      if (xo + r < 0 || xo - r > w) continue;
      const g = c.createRadialGradient(xo, y, 0, xo, y, r);
      g.addColorStop(0, rgba(rgb, a));
      g.addColorStop(1, rgba(rgb, 0));
      c.fillStyle = g;
      c.fillRect(xo - r, y - r, r * 2, r * 2);
    }
  }

  /* the same puff stamped across a 3x3 neighbourhood — TOROIDAL, so the tile is seamless under
     a pan in both axes. Any backdrop with a non-zero vertical parallax depth must author with
     this, not puff(). */
  function puff9(c, w, h, x, y, r, rgb, a) {
    for (const xo of [x - w, x, x + w]) {
      if (xo + r < 0 || xo - r > w) continue;
      for (const yo of [y - h, y, y + h]) {
        if (yo + r < 0 || yo - r > h) continue;
        const g = c.createRadialGradient(xo, yo, 0, xo, yo, r);
        g.addColorStop(0, rgba(rgb, a));
        g.addColorStop(1, rgba(rgb, 0));
        c.fillStyle = g;
        c.fillRect(xo - r, yo - r, r * 2, r * 2);
      }
    }
  }

  /* draw a pre-rendered tile scrolled to (ox,oy), wrapping in BOTH axes. Four copies always
     cover the viewport: with the offset normalised into [0,w)x[0,h), the copy at (x-w,y-h)
     starts at or before the origin and the copy at (x,y) ends at or after (w,h). Fully
     offscreen copies cost nothing worth measuring. */
  function tile2(ctx, cv, w, h, ox, oy) {
    // SNAP TO WHOLE PIXELS. A parallax offset is depth x pan and lands on fractions constantly;
    // blitting a pixel-art tile to a half-pixel softens every edge and makes the layer shimmer as
    // the camera creeps. Rounding also makes the wrap exact: a layer panned by a whole number of
    // tile widths returns to precisely where it started instead of drifting by float error.
    const x = ((Math.round(ox) % w) + w) % w, y = ((Math.round(oy) % h) + h) % h;
    ctx.drawImage(cv, x - w, y - h, w, h);
    ctx.drawImage(cv, x, y - h, w, h);
    ctx.drawImage(cv, x - w, y, w, h);
    ctx.drawImage(cv, x, y, w, h);
  }

  const mkCv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

  /* Cover a w x h viewport with a tile of a DIFFERENT, fixed size, wrapping in both axes.
     tile2() assumes the tile is exactly the viewport, which forces a rebuild on every resize —
     and a rebuild re-lays the whole sky, because the fields are laid out in coordinates normalised
     to the tile. For a starfield nobody notices; for a structured nebula the entire subject jumps
     (2026-07-25: expanding COMMS produced a completely different cloud, and at the new aspect the
     density peaked over a wide area and blew out to white). A FIXED tile plus this drawer means a
     resize simply reveals more of the same sky, which is what "the sky is a place, not a dice
     roll" has to mean in practice. */
  function tileN(ctx, cv, tw, th, w, h, ox, oy) {
    const x0 = ((Math.round(ox) % tw) + tw) % tw - tw;   // start one tile before the origin
    const y0 = ((Math.round(oy) % th) + th) % th - th;
    for (let y = y0; y < h; y += th) for (let x = x0; x < w; x += tw) ctx.drawImage(cv, x, y, tw, th);
  }

  /* sine by lookup, indexed in TURNS rather than radians. A surface deck evaluates several waves
     per pixel across the whole tile (~3.7M calls at 720p), which is too many real Math.sin calls
     for a rebuild that must not stall a resize. Turns also make the torus exact: an integer wave
     count across w or h wraps by construction, and the power-of-two mask does the modulo. */
  const SIN_N = 2048, SIN_MASK = SIN_N - 1;
  const SIN_LUT = new Float32Array(SIN_N);
  for (let i = 0; i < SIN_N; i++) SIN_LUT[i] = Math.sin((i / SIN_N) * Math.PI * 2);

  /* Value noise on an N x N lattice, WRAPPING. Lattice indices are taken modulo N, so any field
     built from these is seamless on the torus by construction rather than by touch-up — which a
     backdrop that parallaxes in both axes needs. Smoothstep between lattice points, so the field
     is continuous; the CALLER is responsible for quantizing it into bands, because smooth noise
     rendered straight to pixels is what reads as blur. */
  function wrapNoise(N, rnd) {
    const g = new Float32Array(N * N);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    return (u, v) => {
      const fx = u * N, fy = v * N;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const x0 = ((ix % N) + N) % N, y0 = ((iy % N) + N) % N;
      const x1 = (x0 + 1) % N, y1 = (y0 + 1) % N;
      const tx = fx - ix, ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = g[y0 * N + x0], b = g[y0 * N + x1], c = g[y1 * N + x0], d = g[y1 * N + x1];
      const top = a + (b - a) * sx, bot = c + (d - c) * sx;
      return top + (bot - top) * sy;
    };
  }

  /* one horizontal dash, wrapped in x — foam and glitter are short and lie along the surface, and
     a dash that runs off the right edge has to reappear on the left or the tile seam shows. */
  function hdash(c, w, x, y, len, style) {
    c.fillStyle = style;
    const x0 = ((x % w) + w) % w;
    const over = x0 + len - w;
    c.fillRect(x0, y, over > 0 ? len - over : len, 1);
    if (over > 0) c.fillRect(0, y, over, 1);
  }

  /* screen offset for a layer at parallax depth d: 0 = infinitely far (nailed to the screen,
     the old behaviour), 1 = rides exactly with the station. The camera pans the world by
     (panX,panY), so a layer at depth d follows that fraction of it. */
  const parX = (cam, d) => (cam ? cam.panX || 0 : 0) * d;
  const parY = (cam, d) => (cam ? cam.panY || 0 : 0) * d;

  /* reduced-motion: never ADD dramatic motion (the meteor) when the OS asks for less; the gentle
     twinkle/scroll predates this module and stays. Live-read, same idiom as world.js. */
  const _rmq = (typeof window !== 'undefined' && window.matchMedia) ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduceMotion = () => !!(_rmq && _rmq.matches);

  /* ---------------------------------------------------------------- shared weather ---- */
  /* Runtime Math.random on purpose, and deliberately NOT part of any backdrop's seeded build:
     the WORLD is a stable seeded place, weather is weather. State is module-level so it keeps
     its rhythm across a backdrop switch. */

  let meteor = null, nextMeteorAt = 0;
  let bolide = null, nextBolideAt = 0;

  /* THE METEOR — a rare, silent shooting star (one live at a time, ~1-2 per minute).
     Skipped entirely under prefers-reduced-motion (never ADD dramatic motion the OS asked us not to). */
  function drawMeteor(ctx, w, h, now) {
    if (!nextMeteorAt) { nextMeteorAt = now + 20000 + Math.random() * 40000; return; }   // first one 20-60s in
    if (!meteor) {
      if (reduceMotion() || now < nextMeteorAt) return;
      const dirx = Math.random() < 0.5 ? -1 : 1;
      const ang = (0.30 + Math.random() * 0.35) * Math.PI / 2;   // shallow-to-mid diagonal, always downward
      const spd = w * (0.28 + Math.random() * 0.22);             // px/s — crosses ~a third of the sky in its life
      meteor = {
        x: (0.15 + Math.random() * 0.7) * w, y: (0.05 + Math.random() * 0.4) * h,
        vx: Math.cos(ang) * spd * dirx, vy: Math.sin(ang) * spd,
        born: now, life: 900 + Math.random() * 500,
      };
    }
    const t = (now - meteor.born) / meteor.life;
    if (t >= 1) { meteor = null; nextMeteorAt = now + 45000 + Math.random() * 60000; return; }
    const a = Math.sin(Math.PI * t);                             // fade in → streak → fade out
    const el = (now - meteor.born) / 1000;
    const hx = meteor.x + meteor.vx * el, hy = meteor.y + meteor.vy * el;
    for (let k = 0; k < 9; k++) {                                // trail: dimming embers back along the path
      const tx = hx - meteor.vx * k * 0.011, ty = hy - meteor.vy * k * 0.011;
      ctx.fillStyle = 'rgba(220,230,255,' + (a * (1 - k / 9) * 0.85).toFixed(3) + ')';
      ctx.fillRect(tx, ty, k < 2 ? 2 : 1, k < 2 ? 2 : 1);
    }
  }

  /* THE GREAT ONE — an extremely rare bolide: brighter, slower, longer than the common meteor,
     with a glowing head and a long ember trail. First window 30min-3h after boot, then 1-5h
     between sightings — most sessions never see it; the ones that do, remember it. */
  function drawBolide(ctx, w, h, now) {
    if (!nextBolideAt) { nextBolideAt = now + (30 + Math.random() * 150) * 60000; return; }
    if (!bolide) {
      if (reduceMotion() || now < nextBolideAt) return;
      const dirx = Math.random() < 0.5 ? -1 : 1;
      const ang = (0.20 + Math.random() * 0.30) * Math.PI / 2;   // shallow, majestic descent
      const spd = w * (0.16 + Math.random() * 0.08);             // slower than the meteor — it lingers
      bolide = {
        x: (0.2 + Math.random() * 0.6) * w, y: (0.05 + Math.random() * 0.30) * h,
        vx: Math.cos(ang) * spd * dirx, vy: Math.sin(ang) * spd,
        born: now, life: 2400 + Math.random() * 900,
      };
    }
    const t = (now - bolide.born) / bolide.life;
    if (t >= 1) { bolide = null; nextBolideAt = now + (60 + Math.random() * 240) * 60000; return; }
    const a = Math.sin(Math.PI * t);
    const el = (now - bolide.born) / 1000;
    const hx = bolide.x + bolide.vx * el, hy = bolide.y + bolide.vy * el;
    const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, 10);   // the glowing head
    g.addColorStop(0, 'rgba(210,255,240,' + (a * 0.9).toFixed(3) + ')');
    g.addColorStop(0.35, 'rgba(150,240,220,' + (a * 0.35).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(150,240,220,0)');
    ctx.fillStyle = g; ctx.fillRect(hx - 10, hy - 10, 20, 20);
    ctx.fillStyle = 'rgba(240,255,250,' + (a * 0.95).toFixed(3) + ')'; ctx.fillRect(hx - 1, hy - 1, 3, 3);
    for (let k = 1; k < 20; k++) {                               // the long ember trail
      const tx = hx - bolide.vx * k * 0.016, ty = hy - bolide.vy * k * 0.016;
      ctx.fillStyle = 'rgba(190,245,230,' + (a * (1 - k / 20) * 0.7).toFixed(3) + ')';
      ctx.fillRect(tx, ty, k < 5 ? 2 : 1, k < 5 ? 2 : 1);
    }
  }

  /* ------------------------------------------------------------- BACKDROP: THE VOID ---- */
  /* FROZEN (law 1). Interstellar deep space: nebulas → dust → twinkle bands → weather. Depths
     are 0/0 — it does not parallax, because deep space genuinely has no near reference and
     this is the look that shipped and was signed off. Do not add bodies to it; DEEP FIELD is
     where richer space goes. */

  const VOID_BG = {
    label: 'THE VOID',
    blurb: 'Interstellar. Nebulas, dust, and the long dark.',
    base: '#040302',                       // the dispatcher clears to this before draw()
    // px/sec drift per depth layer, far → near (old single layer was 8; old bands 3/8/15).
    SPD: { neb: 1.2, dust: 3, mid: 8, near: 15 },
    DIM_MID: 0.8, DIM_NEAR: 1.0,           // per-band brightness scale (matches old Slice-4 feel)

    build(w, h, rnd) {
      const area = w * h;
      const u = px1();                     // star pixel unit — keeps grain consistent across dpr

      /* ---- layer 1: NEBULAS (farthest) ----
         UNFROZEN 2026-09-05 at Andrew's request: "improve our original default one. give it more
         detail, have the stars twinkle, make the nebulas actually look like nebulas instead of them
         being low detailed fixtures of light." Then, on seeing it: "perfect but make sure it doesnt
         look like some still image ... expand the color beyond purple, try the aurora vibe."

         So the gas is a per-pixel field — domain-warped noise inside a soft envelope, dark lanes
         biting in, a hash dither for grain — and it MOVES: three plates of the SAME clouds (same
         envelope, same hues, same lanes) with the fine structure and the warp shifted, cross-faded
         one into the next on a slow cycle so the filaments visibly drift and reform, plus a slow
         vertical sway and the old breathing. Plate 0 is built here; plates 1 and 2 are generators
         the draw loop advances a few milliseconds at a time, so the extra work never hitches a
         frame. Colour: violet still leads, with aurora green, teal, pink and blue blended in where
         the hue field lands. Built at half res (the field is smooth), dithered and coloured at full
         res (grain must be pixel-sized or it reads as a mesh — THE NURSERY's lesson). Wraps in x by
         construction; a vertical window keeps gas off the top/bottom edge, because the plate wraps
         in y but THE VOID never scrolls in y (a cloud on that seam showed twice). */
      const SW = Math.max(1, Math.ceil(w / 2)), SH = Math.max(1, Math.ceil(h / 2));
      const d1 = wrapNoise(3, rnd), d2 = wrapNoise(7, rnd), d3 = wrapNoise(15, rnd), d4 = wrapNoise(31, rnd), d5 = wrapNoise(67, rnd);
      const wx = wrapNoise(4, rnd), wy = wrapNoise(4, rnd);
      const env = wrapNoise(3, rnd), hueF = wrapNoise(3, rnd);
      const lane1 = wrapNoise(6, rnd), lane2 = wrapNoise(14, rnd);
      const nebDith = (x, y) => {
        let k = Math.imul(x + 0x1F123BB5, 0x27D4EB2D) ^ Math.imul(y + 0x68E31DA4, 0x165667B1);
        k = Math.imul(k ^ (k >>> 15), 0x2C1B3C6D);
        return (((k ^ (k >>> 12)) >>> 0) / 4294967296) - 0.5;
      };
      const samp = (F, fx, fy) => {
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        const xa = ((x0 % SW) + SW) % SW, ya = ((y0 % SH) + SH) % SH, xb = (xa + 1) % SW, yb = (ya + 1) % SH;
        const top = F[ya * SW + xa] + (F[ya * SW + xb] - F[ya * SW + xa]) * tx;
        const bot = F[yb * SW + xa] + (F[yb * SW + xb] - F[yb * SW + xa]) * tx;
        return top + (bot - top) * ty;
      };
      /* the AURORA palette: violet leads (it appears three times in the sequence), with pink,
         green, teal and blue as the splash. The hue field blends CONTINUOUSLY along this sequence
         (a threshold here once drew hard-edged discs). */
      const FAM = [
        { lo: [10, 6, 26], mid: [84, 40, 148], hi: [190, 140, 235] },     // violet
        { lo: [24, 6, 22], mid: [136, 36, 108], hi: [235, 120, 190] },    // pink
        { lo: [10, 6, 26], mid: [84, 40, 148], hi: [190, 140, 235] },     // violet
        { lo: [4, 18, 14], mid: [30, 122, 74], hi: [130, 232, 160] },     // aurora green
        { lo: [6, 18, 26], mid: [28, 110, 130], hi: [120, 225, 228] },    // teal
        { lo: [10, 6, 26], mid: [84, 40, 148], hi: [190, 140, 235] },     // violet
        { lo: [6, 10, 30], mid: [44, 74, 176], hi: [136, 176, 244] },     // blue
      ];
      const LANE = [2, 2, 6], LV = 12;
      // shared (per-cloud) fields: envelope, hue, lanes — identical across the plates
      const fE = new Float32Array(SW * SH), fH = new Float32Array(SW * SH), fL = new Float32Array(SW * SH);
      for (let y = 0, i = 0; y < SH; y++) {
        const v0 = y / SH, vwin = Math.min(1, v0 / 0.14, (1 - v0) / 0.14);
        for (let x = 0; x < SW; x++, i++) {
          const u0 = x / SW;
          fE[i] = Math.max(0, Math.min(1, (env(u0, v0) - 0.52) * 3.0)) * vwin;
          fH[i] = hueF(u0, v0);
          fL[i] = Math.max(0, Math.min(1, (lane1(u0 * 1.1, v0 * 1.1) * 0.6 + lane2(u0, v0) * 0.4 - 0.53) * 3.6));
        }
      }
      let fT0 = null;                                   // plate 0's density, for the overlay below
      /* one plate, as a generator: the density field then the colour pass, yielding every few rows
         so the draw loop can spread plates 1 and 2 across frames. k shifts the warp and the fine
         octaves — the big shapes (d1, d2), the envelope, hues and lanes stay put. */
      function* makePlate(k) {
        const ox = 0.13 * k, oy = 0.09 * k;
        const fT = new Float32Array(SW * SH);
        for (let y = 0, i = 0; y < SH; y++) {
          const v0 = y / SH;
          for (let x = 0; x < SW; x++, i++) {
            const e = fE[i]; if (e <= 0.001) continue;
            const u0 = x / SW;
            const u = u0 + (wx(u0 + ox, v0 + oy) - 0.5) * 0.22, v = v0 + (wy(u0 + ox, v0 + oy) - 0.5) * 0.22;
            const dens = d1(u, v) * 0.36 + d2(u, v) * 0.26 + d3(u + ox, v + oy) * 0.18 + d4(u + ox, v - oy) * 0.12 + d5(u - ox, v + oy) * 0.08;
            fT[i] = Math.max(0, Math.min(1, (dens - 0.42) * 3.8)) * e;
          }
          if ((y & 31) === 31) yield null;
        }
        if (k === 0) fT0 = fT;
        const cv = mkCv(w, h), c = cv.getContext('2d');
        const img = c.createImageData(w, h), D = img.data;
        for (let y = 0, p = 0; y < h; y++) {
          const fy = y * 0.5;
          for (let x = 0; x < w; x++, p += 4) {
            const fx = x * 0.5;
            let t = samp(fT, fx, fy);
            if (t <= 0.03) continue;
            t = Math.max(0, Math.min(1, Math.round((t + nebDith(x, y) / LV) * LV) / LV));
            if (t <= 0) continue;
            const hv = Math.max(0, Math.min(0.999, (samp(fH, fx, fy) - 0.25) * 2)) * (FAM.length - 1), fi = Math.floor(hv), ft = hv - fi;
            const fa = FAM[fi], fb = FAM[fi + 1];
            const lo = mix3(fa.lo, fb.lo, ft), mid = mix3(fa.mid, fb.mid, ft), hi = mix3(fa.hi, fb.hi, ft);
            let col = t < 0.5 ? mix3(lo, mid, t / 0.5) : mix3(mid, hi, (t - 0.5) / 0.5);
            let alpha = 0.05 + t * 0.85;                  // DISTANT: short of opaque, this is THE VOID
            const dark = samp(fL, fx, fy);
            if (dark > 0) { col = mix3(col, LANE, dark); alpha = Math.min(0.8, alpha + dark * 0.35); }
            D[p] = col[0]; D[p + 1] = col[1]; D[p + 2] = col[2]; D[p + 3] = Math.round(255 * alpha);
          }
          if ((y & 63) === 63) yield null;
        }
        c.putImageData(img, 0, 0);
        return cv;
      }
      const g0 = makePlate(0);
      let r0; do { r0 = g0.next(); } while (!r0.done);   // plate 0 now, in full
      const nebPlates = [r0.value];
      const nebJobs = [makePlate(1), makePlate(2)];      // the draw loop finishes these

      /* the STATIC overlay: hot knots and star clusters where plate 0's gas is densest, and (below)
         the galactic band's whisper of glow. Drawn over whichever plates are showing. */
      const nebCv = mkCv(w, h);
      const nc = nebCv.getContext('2d');
      nc.globalCompositeOperation = 'lighter';
      for (let k = 0, n = 4 + Math.floor(rnd() * 4); k < n; k++) {
        const sx = rnd() * w, sy = rnd() * h;
        if (samp(fT0, sx * 0.5, sy * 0.5) < 0.45) continue;
        puff(nc, w, sx, sy, Math.min(w, h) * (0.02 + 0.03 * rnd()), [170, 130, 230], 0.10);
        nc.fillStyle = 'rgba(230,220,255,0.7)'; nc.fillRect(sx | 0, sy | 0, 1, 1);
      }
      for (let b = 0; b < 3; b++) {
        const cx = rnd() * w, cy = rnd() * h;
        if (samp(fT0, cx * 0.5, cy * 0.5) < 0.2) continue;
        const R = Math.min(w, h) * 0.12;
        for (let s = 0, n = 30 + Math.floor(rnd() * 24); s < n; s++) {
          const ang = rnd() * Math.PI * 2, d = rnd() * R;
          nc.fillStyle = 'rgba(220,225,250,' + (0.10 + 0.25 * rnd()).toFixed(3) + ')';
          nc.fillRect(((cx + Math.cos(ang) * d) % w + w) % w, ((cy + Math.sin(ang) * d * 0.8) % h + h) % h, 1, 1);
        }
      }
      /* the galactic band: a sine curve periodic in w (wraps seamlessly) — faint glow + dust bias below */
      const bandY = h * (0.22 + 0.5 * rnd()), bandAmp = h * (0.05 + 0.06 * rnd()), bandPh = rnd() * Math.PI * 2;
      const bandHalf = h * 0.11;
      const bandAt = x => bandY + bandAmp * Math.sin((x / w) * Math.PI * 2 + bandPh);
      const bandHue = NEB_HUES[Math.floor(rnd() * NEB_HUES.length) % NEB_HUES.length];
      for (let i = 0; i < 26; i++) {
        const bx = (i / 26) * w + (rnd() - 0.5) * w * 0.03;
        puff(nc, w, bx, bandAt(bx) + (rnd() - 0.5) * bandHalf * 0.8, bandHalf * (1.1 + 0.7 * rnd()), bandHue, 0.012 + 0.010 * rnd());   // a whisper: the band is its STARS now, not a glow
      }

      /* ---- layer 2: DUST (dense static far field) ---- */
      const dustCv = mkCv(w, h);
      const dc = dustCv.getContext('2d');
      const dustN = Math.min(8000, Math.round(area / 1100));
      for (let i = 0; i < dustN; i++) {
        const x = rnd() * w;
        // 35% of the dust condenses onto the galactic band — the field reads structured, not uniform noise
        const y = rnd() < 0.35
          ? bandAt(x) + (rnd() + rnd() - 1) * bandHalf     // triangular falloff around the curve
          : rnd() * h;
        dc.fillStyle = pickTint(rnd()) + (0.25 + 0.5 * rnd()).toFixed(3) + ')';   // bold enough to survive the CRT pass (scanlines+warp eat ~half)
        dc.fillRect(x, ((y % h) + h) % h, rnd() < 0.88 ? 1 : 2, 1);
      }

      /* ---- layers 3+4: the live twinkle bands (area-scaled, capped for per-frame cost) ---- */
      const mid = [], near = [];
      const midN = Math.min(340, Math.round(area / 11000)), nearN = Math.min(190, Math.round(area / 24000));
      for (let i = 0; i < midN; i++) mid.push({ x: rnd(), y: rnd(), r: rnd() < 0.85 ? u : u * 2, ph: rnd() * 10, c: pickTint(rnd()) });
      for (let i = 0; i < nearN; i++) near.push({ x: rnd(), y: rnd(), r: rnd() < 0.6 ? u : u * 2, ph: rnd() * 10, c: pickTint(rnd()), glint: rnd() < 0.14 });
      /* SPARKLE (2026-09-05): a live set of dust-level stars that blink on and off in the static
         far field, so the whole sky twinkles and not only the two near bands. Cheap: ~1 per 6000px. */
      const spark = [];
      for (let i = 0, n = Math.min(400, Math.round(area / 6000)); i < n; i++) spark.push({ x: rnd(), y: rnd(), ph: rnd() * 10, rate: 500 + rnd() * 1200, c: pickTint(rnd()) });

      return { nebCv, nebPlates, nebJobs, dustCv, mid, near, spark };
    },

    draw(ctx, w, h, now, cam, st) {
      const S = VOID_BG.SPD;
      const nx = (now / 1000 * S.neb) % w;             // two-copy wrap scroll, same idiom per layer
      ctx.globalAlpha = 0.9 + 0.1 * Math.sin(now / 7000);   // the gas breathes, slowly
      /* LIVING GAS (2026-09-05). Finish any pending plate a few ms at a time, then cross-fade: the
         current plate at full, the next fading in over it on a slow cycle (no dip at the crossover,
         because the base stays opaque underneath). A slow vertical sway rides on top. Until plates
         1 and 2 exist, the base is drawn alone — a missing plate falls back to the latest one. */
      if (st.nebJobs && st.nebJobs.length) {
        const hasPerf = typeof performance !== 'undefined' && performance.now;
        const t0 = hasPerf ? performance.now() : 0;
        do {
          const r = st.nebJobs[0].next();
          if (r.done) { st.nebPlates.push(r.value); st.nebJobs.shift(); }
        } while (st.nebJobs.length && hasPerf && performance.now() - t0 < 4);
      }
      const NP = 3, tsec = now / 1000, cyc = tsec / 26;
      const pi = Math.floor(cyc) % NP, pf = cyc - Math.floor(cyc), sf = pf * pf * (3 - 2 * pf);
      const plateAt = i => st.nebPlates[Math.min(i, st.nebPlates.length - 1)];
      const sway = Math.round(5 * Math.sin(tsec / 41 * Math.PI * 2));
      const breathe = ctx.globalAlpha;
      const base = plateAt(pi), next = plateAt((pi + 1) % NP);
      ctx.drawImage(base, nx - w, sway, w, h); ctx.drawImage(base, nx, sway, w, h);
      if (next !== base) {
        ctx.globalAlpha = breathe * sf;
        ctx.drawImage(next, nx - w, sway, w, h); ctx.drawImage(next, nx, sway, w, h);
        ctx.globalAlpha = breathe;
      }
      ctx.drawImage(st.nebCv, nx - w, sway, w, h); ctx.drawImage(st.nebCv, nx, sway, w, h);
      const dx = (now / 1000 * S.dust) % w;
      ctx.globalAlpha = 0.92 + 0.08 * Math.sin(now / 4100);
      ctx.drawImage(st.dustCv, dx - w, 0, w, h); ctx.drawImage(st.dustCv, dx, 0, w, h);
      ctx.globalAlpha = 1;

      /* TWINKLE (2026-09-05, Andrew: "have the stars twinkle"): the old smooth 0.35-1 sine read as
         steady after the CRT pass. Stars now STEP between three levels and go much darker at the
         bottom, so each one visibly blinks; the sparkle set does the same in the far field. */
      const step = ph => ph > 0.45 ? 1 : ph > -0.35 ? 0.55 : 0.15;
      for (const s of st.spark) {
        const lv = step(Math.sin(now / s.rate + s.ph));
        if (lv < 0.2) continue;
        ctx.fillStyle = s.c + (lv * 0.6).toFixed(3) + ')';
        ctx.fillRect((s.x * w + now / 1000 * S.dust) % w, s.y * h, 1, 1);
      }
      for (const s of st.mid) {
        const tw = step(Math.sin(now / (900 + s.ph * 300) + s.ph)) * VOID_BG.DIM_MID;
        ctx.fillStyle = s.c + tw.toFixed(3) + ')';
        ctx.fillRect((s.x * w + now / 1000 * S.mid) % w, s.y * h, s.r, s.r);
      }
      for (const s of st.near) {
        const tw = step(Math.sin(now / (900 + s.ph * 300) + s.ph)) * VOID_BG.DIM_NEAR;
        const x = (s.x * w + now / 1000 * S.near) % w, y = s.y * h;
        ctx.fillStyle = s.c + tw.toFixed(3) + ')';
        ctx.fillRect(x, y, s.r, s.r);
        if (s.glint && tw > 0.9) {                     // the brightest few flare into a 4-point glint at twinkle peak
          ctx.fillStyle = s.c + (tw * 0.30).toFixed(3) + ')';
          ctx.fillRect(x - s.r * 2, y + (s.r >> 1), s.r * 5, 1);
          ctx.fillRect(x + (s.r >> 1), y - s.r * 2, 1, s.r * 5);
        }
      }

      drawMeteor(ctx, w, h, now);
      drawBolide(ctx, w, h, now);
    },
  };

  /* --------------------------------------------------------- BACKDROP: THE NURSERY ---- */
  /* A star factory. REBUILT 2026-09-09 (Andrew: "the nursery ... need significantly way better
     looking"). The version this replaces obeyed every rule below and was still nearly invisible
     on a live station: the gas topped out at [125,38,69] behind a CRT pass that halves contrast,
     the cloud's centroid was pinned to the frame centre — i.e. BEHIND THE STATION — and nothing
     in the field ever twinkled.

     The lessons that still bind (every one learned the hard way on this backdrop):
       - CAMO is quantized organic noise at one mid-tone (v2: "purple camo if anything"). The
         frame needs real black around the cloud and real structure inside it.
       - SMUDGY is a per-pixel gradient. Dither between hard ramp steps; never blend.
       - A BAYER MATRIX IS A WINDOW SCREEN over soft gas (2026-07-25): the dither is a hash.
       - GAS IS ALLOWED TO BE BRIGHT, NEVER TO CLIP. The ramp tops at pale peach; white belongs
         only to points of light (stars, knots). A wide bright patch striped by scanlines is the
         failure this rule exists for.
       - NO ALPHA FLOOR: thin gas is nothing, not a veil. The starfield gets its black back.
       - STARS FIRST, full resolution, and the gas composites OVER them with per-pixel alpha, so
         thin gas lets them through and dense gas and dust occlude them. That is the depth cue.
       - The station stays the brightest thing on screen (post-CRT backdrop/station luma ~0.5-0.7).

     What is NEW, in order of how much it buys:
       1. THE COMPLEX IS A BAND. The cloud runs as a wrapped diagonal across a 2:1 fixed tile
          (it descends exactly one tile-height per tile-width, so it is continuous on the torus),
          lumped and gapped by noise so it is a chain of clouds rather than a stripe. Any window
          onto the tile is crossed by it, and draw() pins its centreline through the upper third
          of the frame — beside the station, never under it. There is nothing left to lose off
          screen; the sway only keeps it breathing.
       2. TWO GAS SPECIES. H-alpha (violet -> magenta -> pink -> peach) carries the mass; O-III
          (deep teal -> cyan) has its OWN density field and shows where the hydrogen is thin, so
          the colour contrast is a second cloud, not a tint on the first.
       3. FILAMENTS. A ridged octave (1 - |2n - 1|) folded into the density draws thin bright
          threads through the mass — what makes emission nebulae look combed instead of blobbed.
       4. IONIZATION FRONTS. Gas near a young cluster is pushed toward gold, and every dust lane
          carries a warm reflected brim instead of a black edge. Colour now says where the heat is.
       5. YOUNG CLUSTERS. Where the gas is densest: tight knots of white/blue points inside a
          local glow, plus amber protostars buried in the dust. The top of the value range, and a
          place for the eye to land.
       6. A LIVE FIELD. Near stars step between three brightness levels and a few big round ones
          pulse — the pixel-honest twinkle ANDROMEDA got and Andrew liked. Foreground motes drift.
     Nothing is smooth-shaded: gas is quantized to LEVELS bands under a hash dither, stars are
     hard pixels, and the only radial gradients are glows sitting under hard points. */

  /* value noise on an NX x NY lattice, wrapping — the nursery tile is 2:1, and an N x N lattice
     on it would stretch every cloud sideways; this keeps the cells square. */
  function wrapNoiseXY(NX, NY, rnd) {
    const g = new Float32Array(NX * NY);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    return (u, v) => {
      const fx = u * NX, fy = v * NY;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const x0 = ((ix % NX) + NX) % NX, y0 = ((iy % NY) + NY) % NY;
      const x1 = (x0 + 1) % NX, y1 = (y0 + 1) % NY;
      const tx = fx - ix, ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = g[y0 * NX + x0], b = g[y0 * NX + x1], c = g[y1 * NX + x0], d = g[y1 * NX + x1];
      const top = a + (b - a) * sx, bot = c + (d - c) * sx;
      return top + (bot - top) * sy;
    };
  }
  /* deterministic per-pixel dither offset in [-0.5,0.5) — same pixel, same grain, every build.
     A hash, not an ordered matrix: a matrix is periodic and leaves a lattice over soft gas. */
  function hashDither(x, y) {
    let k = Math.imul(x + 0x1F123BB5, 0x27D4EB2D) ^ Math.imul(y + 0x68E31DA4, 0x165667B1);
    k = Math.imul(k ^ (k >>> 15), 0x2C1B3C6D);
    return (((k ^ (k >>> 12)) >>> 0) / 4294967296) - 0.5;
  }
  /* bilinear sample of a half-res field on a torus of SW x SH */
  function sampField(F, SW, SH, fx, fy) {
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const xa = ((x0 % SW) + SW) % SW, ya = ((y0 % SH) + SH) % SH;
    const xb = (xa + 1) % SW, yb = (ya + 1) % SH;
    const top = F[ya * SW + xa] + (F[ya * SW + xb] - F[ya * SW + xa]) * tx;
    const bot = F[yb * SW + xa] + (F[yb * SW + xb] - F[yb * SW + xa]) * tx;
    return top + (bot - top) * ty;
  }

  const NURSERY_BG = {
    label: 'THE NURSERY',
    blurb: 'A star factory. Hot cores, cold lanes, and a deep field behind it.',
    base: '#020207',                       // empty space must read BLACK, not faintly violet
    D: { gas: 0.03, near: 0.05, mote: 0.075 },
    // the plates SWAY about the anchor instead of drifting off it — see draw().
    SWAY: { x: 46, y: 13, sx: 240, sy: 290 },
    LEVELS: 14,
    /* where the band's centreline crosses the frame's centre column. High, because at play zoom
       the station covers the middle 55% of the stage: the cloud has to live in the top strip and
       run down one side, or it is behind the floor plan. */
    ANCHOR: { x: 0.5, y: 0.24 },

    /* FIXED 2:1 TILE, built once, never rebuilt on a resize. Twice as wide as tall so the band's
       diagonal is gentle (~27 deg) and still exact on the torus. Sized to the display's long edge
       so the repeat stays off-screen at ordinary window sizes. */
    fixedTile: () => {
      const scr = (typeof window !== 'undefined' && window.screen) || {};
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const long = Math.max(Number(scr.width) || 0, Number(scr.height) || 0) || 1600;
      const tw = Math.max(1400, Math.min(2048, Math.round(long * Math.min(dpr, 2))));
      return [tw, tw >> 1];
    },

    PAL: {
      /* H-alpha: nine hard steps, violet to peach. Tops short of white on purpose. */
      HA: [[20, 9, 40], [44, 16, 74], [80, 24, 102], [122, 34, 118], [166, 50, 122], [204, 80, 128], [230, 122, 140], [244, 166, 160], [250, 204, 186]],
      /* O-III: a genuinely different hue, deep teal to cyan, for the thin regions. */
      O3: [[8, 26, 46], [14, 52, 78], [22, 84, 106], [38, 122, 134], [70, 164, 158], [118, 202, 182]],
      GOLD: [255, 214, 150],               // gas lit by a young cluster
      EDGE: [58, 24, 30],                  // the brim of a dust lane: brown-red, lit from the side
      LANE: [3, 2, 7],                     // cold dust, effectively black
      WHITE: [255, 250, 246], BLUE: [186, 212, 255], PINK: [255, 198, 214], AMBER: [255, 224, 168],
    },

    build(w, h, rnd) {
      const P = NURSERY_BG.PAL, LV = NURSERY_BG.LEVELS, u1 = px1();
      const SW = Math.max(1, Math.ceil(w / 2)), SH = Math.max(1, Math.ceil(h / 2));
      const asp = Math.max(1, w / h);
      const wn = N => wrapNoiseXY(Math.max(2, Math.round(N * asp)), N, rnd);   // square cells on any aspect

      /* ---- 1. THE DEEP FIELD, full resolution (a half-res star is a 2x2 blob, never a point) ---- */
      const starCv = mkCv(w, h), stc = starCv.getContext('2d');
      stc.fillStyle = NURSERY_BG.base; stc.fillRect(0, 0, w, h);
      const starN = Math.min(14000, Math.round((w * h) / 150));
      for (let i = 0; i < starN; i++) {
        const x = (rnd() * w) | 0, y = (rnd() * h) | 0, b = rnd();
        if (b < 0.70) {                                   // the faint many
          stc.fillStyle = pickTint(rnd()) + (0.16 + 0.30 * rnd()).toFixed(3) + ')';
          stc.fillRect(x, y, u1, u1);
        } else if (b < 0.96) {                            // the visible few
          stc.fillStyle = pickTint(rnd()) + (0.50 + 0.45 * rnd()).toFixed(3) + ')';
          stc.fillRect(x, y, u1, u1);
        } else {                                          // the bright handful, with spikes
          const a = 0.85 + 0.15 * rnd();
          const c = rnd() < 0.6 ? P.WHITE : rnd() < 0.5 ? P.BLUE : P.AMBER;
          stc.fillStyle = rgba(c, a); stc.fillRect(x, y, u1, u1);
          stc.fillStyle = rgba(c, a * 0.32);
          stc.fillRect(x - 3 * u1, y, 7 * u1, u1); stc.fillRect(x, y - 3 * u1, u1, 7 * u1);
        }
      }

      /* ---- 2. THE FIELDS, half res — the gas is soft; only the dither has to be per pixel ---- */
      const d1 = wn(3), d2 = wn(6), d3 = wn(12), d4 = wn(24), d5 = wn(48);
      const wxF = wn(4), wyF = wn(4);                     // domain warp -> filaments, not blobs
      const lump = wn(2), wob = wn(2);                    // clumps along the band, and its wander
      const rg1 = wn(9), rg2 = wn(19);                    // ridged octaves: the threads
      const o1 = wn(4), o2 = wn(9), o3 = wn(18);          // O-III has its own cloud
      const l1 = wn(6), l2 = wn(14), l3 = wn(30);         // dust lanes
      const bandPh = rnd() * Math.PI * 2, bandAmp = 0.05 + 0.04 * rnd(), bandW = 0.20 + 0.04 * rnd(), bandY0 = rnd();
      /* THE BAND. Its centreline descends one tile-height per tile-width (continuous on the
         torus), waves once across the tile, and wanders with a coarse noise. Distance to it is
         measured WRAPPED in v, so the band never has a top or bottom edge at the tile seam. */
      const centreY = u => bandY0 + u + bandAmp * Math.sin(u * Math.PI * 2 + bandPh);
      const env = (u, v) => {
        const cy = centreY(u) + (wob(u, v) - 0.5) * 0.24;
        let dy = v - cy; dy -= Math.round(dy);
        const core = 1 - Math.min(1, Math.abs(dy) / bandW);
        return Math.max(0, Math.min(1, core * 1.5 - 0.2 + (lump(u, v) - 0.5) * 0.9));
      };
      const fT = new Float32Array(SW * SH), fO = new Float32Array(SW * SH), fL = new Float32Array(SW * SH);
      for (let y = 0, i = 0; y < SH; y++) {
        const v0 = y / SH;
        for (let x = 0; x < SW; x++, i++) {
          const u0 = x / SW;
          const e = env(u0, v0);
          if (e <= 0.002) continue;                       // fields stay 0 outside the complex
          const u = u0 + (wxF(u0, v0) - 0.5) * 0.20, v = v0 + (wyF(u0, v0) - 0.5) * 0.20;
          const fbm = d1(u, v) * 0.38 + d2(u, v) * 0.26 + d3(u, v) * 0.18 + d4(u, v) * 0.11 + d5(u, v) * 0.07;
          const ridge = 1 - Math.abs(2 * rg1(u, v) - 1) * 0.72 - Math.abs(2 * rg2(u, v) - 1) * 0.28;
          fT[i] = Math.max(0, Math.min(1, (fbm * 0.70 + ridge * 0.36 - 0.44) * 2.4)) * e;
          const o = o1(u, v) * 0.5 + o2(u, v) * 0.3 + o3(u, v) * 0.2;
          fO[i] = Math.max(0, Math.min(1, (o - 0.50) * 2.8)) * e;
          /* LANES ARE THREADS, NOT BLOBS. A plain threshold on smooth noise made one lane a
             smooth-edged black continent beside the station — a hole in the picture. Ridged
             octaves give long thin dust filaments, and only where there is gas to cut. */
          const L = (1 - Math.abs(2 * l1(u0, v0) - 1)) * 0.55 + (1 - Math.abs(2 * l2(u0, v0) - 1)) * 0.30 + l3(u0, v0) * 0.15;
          fL[i] = Math.max(0, Math.min(1, (L - 0.66) * 3.2)) * Math.min(1, e * 2.5);
        }
      }

      /* ---- 3. WHERE THE YOUNG STARS ARE: up to six knots in the densest, cleanest gas, kept
              apart, measured on the torus. They light the gas around them (gold) and carry the
              clusters drawn in step 5. ---- */
      const knots = [], kR = h * 0.10;
      const tdist = (ax, ay, bx, by) => { const dx = Math.abs(ax - bx), dy = Math.abs(ay - by); return Math.hypot(Math.min(dx, w - dx), Math.min(dy, h - dy)); };
      for (let tries = 0; tries < 700 && knots.length < 6; tries++) {
        const x = rnd() * SW, y = rnd() * SH, i = (y | 0) * SW + (x | 0);
        if (fT[i] < 0.60 || fL[i] > 0.15) continue;
        if (knots.some(k => tdist(k.x, k.y, x * 2, y * 2) < kR * 2.2)) continue;
        knots.push({ x: x * 2, y: y * 2, big: rnd() < 0.5 });
      }
      const fG = new Float32Array(SW * SH);               // ionization warmth, half res
      for (let y = 0, i = 0; y < SH; y++) for (let x = 0; x < SW; x++, i++) {
        let g = 0;
        for (const k of knots) { const R = kR * (k.big ? 1.6 : 1.1), d = tdist(x * 2, y * 2, k.x, k.y); if (d < R) g += 1 - d / R; }
        fG[i] = g;
      }

      /* ---- 4. THE GAS PLATE: per-pixel dither + hard ramps, composited over the field ---- */
      const gasCv = mkCv(w, h), gc = gasCv.getContext('2d');
      const scratch = mkCv(w, h), sc2 = scratch.getContext('2d');
      const img = sc2.createImageData(w, h), D = img.data;
      const HA = P.HA, O3 = P.O3, hn = HA.length - 1, on = O3.length - 1;
      let p = 0;
      for (let y = 0; y < h; y++) {
        const fy = y * 0.5;
        for (let x = 0; x < w; x++, p += 4) {
          const fx = x * 0.5;
          const t = sampField(fT, SW, SH, fx, fy), o = sampField(fO, SW, SH, fx, fy);
          if (t <= 0.03 && o <= 0.04) continue;           // thin gas is NOTHING, not a veil
          const dz = hashDither(x, y) / LV;
          const tq = Math.max(0, Math.min(1, Math.round((t + dz) * LV) / LV));
          const oq = Math.max(0, Math.min(1, Math.round((o + dz) * LV) / LV));
          let col = null, alpha = 0;
          if (tq > 0) { col = HA[Math.round(tq * hn)]; alpha = Math.min(1, 0.10 + tq * 1.3); }
          if (oq > 0) {
            const oc = O3[Math.round(oq * on)];
            col = col ? mix3(col, oc, Math.min(1, oq * 1.5) * (1 - tq * 0.8)) : oc;
            alpha = Math.max(alpha, Math.min(1, 0.08 + oq * 1.1));
          }
          if (!col) continue;
          const g = sampField(fG, SW, SH, fx, fy);
          if (g > 0) col = mix3(col, P.GOLD, Math.min(0.62, g * 0.8) * Math.min(1, tq * 1.8));
          const dark = Math.max(0, Math.min(1, Math.round((sampField(fL, SW, SH, fx, fy) + dz * 2) * 6) / 6));
          if (dark > 0) {
            // DUST LANES bite into the cloud. The brim is lit brown-red; the core is near-black,
            // and even the core keeps a few stars: a lane is dust, not a cutout.
            const brim = Math.min(1, dark * 2.2) * (1 - Math.min(1, dark * 1.4));
            col = mix3(col, P.EDGE, brim * 0.7);
            col = mix3(col, P.LANE, Math.min(1, Math.max(0, (dark - 0.2) * 1.4)));
            alpha = Math.min(0.94, alpha + dark * 0.6);
          }
          D[p] = col[0]; D[p + 1] = col[1]; D[p + 2] = col[2]; D[p + 3] = Math.round(255 * Math.min(1, alpha));
        }
      }
      sc2.putImageData(img, 0, 0);
      gc.drawImage(scratch, 0, 0);

      /* ---- 5. YOUNG CLUSTERS + PROTOSTARS, additive, over the gas: they are in FRONT of it ---- */
      gc.globalCompositeOperation = 'lighter';
      const wx = x => ((Math.round(x) % w) + w) % w, wy = y => ((Math.round(y) % h) + h) % h;
      for (const k of knots) {
        const R = kR * (k.big ? 0.9 : 0.6);
        puff9(gc, w, h, k.x, k.y, R, k.big ? [255, 170, 190] : [160, 190, 255], 0.13);
        puff9(gc, w, h, k.x, k.y, R * 0.36, [255, 236, 240], 0.15);
        const n = 8 + Math.floor(rnd() * 9);
        for (let i = 0; i < n; i++) {
          const a = rnd() * Math.PI * 2, d = Math.pow(rnd(), 1.6) * R * 0.55;
          const c = rnd() < 0.55 ? P.WHITE : rnd() < 0.7 ? P.BLUE : P.PINK;
          const s = rnd() < 0.3 ? 2 * u1 : u1;
          gc.fillStyle = rgba(c, 0.95);
          gc.fillRect(wx(k.x + Math.cos(a) * d), wy(k.y + Math.sin(a) * d), s, s);
        }
        for (let i = 0; i < 2; i++) {                     // the two brightest: spikes and a halo
          const a = rnd() * Math.PI * 2, d = rnd() * R * 0.3;
          const sx = wx(k.x + Math.cos(a) * d), sy = wy(k.y + Math.sin(a) * d);
          gc.fillStyle = rgba(P.WHITE, 0.45); gc.fillRect(sx - 4 * u1, sy, 9 * u1, u1); gc.fillRect(sx, sy - 4 * u1, u1, 9 * u1);
          gc.fillStyle = rgba(P.BLUE, 0.35); gc.fillRect(sx - u1, sy - u1, 3 * u1, 3 * u1);
          gc.fillStyle = rgba(P.WHITE, 1); gc.fillRect(sx, sy, u1, u1);
        }
      }
      for (let tries = 0, n = 0; tries < 300 && n < 14; tries++) {   // protostars, buried in the dust
        const x = rnd() * SW, y = rnd() * SH, i = (y | 0) * SW + (x | 0);
        if (fT[i] < 0.42 || fL[i] < 0.28) continue;
        n++;
        puff9(gc, w, h, x * 2, y * 2, 4 + rnd() * 5, [255, 150, 70], 0.40);
        gc.fillStyle = rgba(P.AMBER, 1); gc.fillRect(wx(x * 2), wy(y * 2), u1, u1);
      }
      gc.globalCompositeOperation = 'source-over';

      /* ---- 6. the live field and the foreground motes ---- */
      const near = [];
      for (let i = 0, n = Math.min(260, Math.round((w * h) / 8000)); i < n; i++) {
        near.push({ x: rnd(), y: rnd(), r: rnd() < 0.72 ? u1 : 2 * u1, ph: rnd() * 10, rate: 700 + rnd() * 1100,
          c: rnd() < 0.5 ? P.WHITE : rnd() < 0.6 ? P.BLUE : rnd() < 0.5 ? P.PINK : P.AMBER });
      }
      const big = [];
      for (let i = 0, n = 4 + Math.floor(rnd() * 3); i < n; i++) big.push({ x: rnd(), y: rnd(), ph: rnd() * 10, rate: 1500 + rnd() * 1500, huge: rnd() < 0.25, c: rnd() < 0.7 ? P.WHITE : P.PINK });
      const moteCv = mkCv(w, h), mc = moteCv.getContext('2d');
      const moteN = Math.min(1800, Math.round((w * h) / 4200));
      for (let i = 0; i < moteN; i++) {
        mc.fillStyle = 'rgba(2,2,6,' + (0.22 + 0.42 * rnd()).toFixed(3) + ')';
        mc.fillRect((rnd() * w) | 0, (rnd() * h) | 0, rnd() < 0.8 ? 1 : 2, 1);
      }

      // where the band's centreline crosses the tile's centre column — what draw() pins
      const focusY = ((centreY(0.5) % 1) + 1) % 1;
      return { starCv, gasCv, moteCv, near, big, focusY };
    },

    draw(ctx, w, h, now, cam, st) {
      const D = NURSERY_BG.D, S = NURSERY_BG.SWAY, A = NURSERY_BG.ANCHOR, P = NURSERY_BG.PAL, t = now / 1000;
      const TW = st.starCv.width, TH = st.starCv.height;
      /* THE SUBJECT STAYS FRAMED (2026-08-15, Andrew: "the purple nebula disappears regularly, can
         we keep that specifically in frame"): the band's centreline is pinned through ANCHOR — the
         upper third of the frame, so the station sits beside the cloud instead of on it — and the
         plates only SWAY about that point on two slow out-of-phase waves. Camera parallax rides on
         top: the field is at a finite distance, so panning the station still slides it (law 2). */
      const pinX = w * A.x - 0.5 * TW, pinY = h * A.y - st.focusY * TH;
      const ox = parX(cam, D.gas) + pinX + S.x * Math.sin(t / S.sx * Math.PI * 2);
      const oy = parY(cam, D.gas) + pinY + S.y * Math.sin(t / S.sy * Math.PI * 2);
      tileN(ctx, st.starCv, TW, TH, w, h, ox, oy);
      tileN(ctx, st.gasCv, TW, TH, w, h, ox, oy);

      // the live field, a hair nearer than the gas: big round pulsing stars and three-step twinklers
      const fl = Math.floor;
      const nx0 = parX(cam, D.near) + t * 1.6, ny0 = parY(cam, D.near) + t * 0.5;
      for (const b of st.big) {
        const x = fl(((b.x * w + nx0) % w + w) % w), y = fl(((b.y * h + ny0) % h + h) % h);
        const R = b.huge ? 3 : 2, on = Math.sin(now / b.rate + b.ph) > 0.15;
        for (let yy = -R - 1; yy <= R + 1; yy++) {
          const half = fl(Math.sqrt(Math.max(0, (R + 1) * (R + 1) - yy * yy)));
          const inner = fl(Math.sqrt(Math.max(0, R * R - yy * yy)));
          const core = fl(Math.sqrt(Math.max(0, (R - 1) * (R - 1) - yy * yy)));
          if (on) { ctx.fillStyle = rgba(P.BLUE, 0.5); ctx.fillRect(x - half, y + yy, 2 * half + 1, 1); }
          if (Math.abs(yy) <= R) { ctx.fillStyle = rgba(b.c, 0.95); ctx.fillRect(x - inner, y + yy, 2 * inner + 1, 1); }
          if (Math.abs(yy) <= R - 1) { ctx.fillStyle = rgba(P.WHITE, 1); ctx.fillRect(x - core, y + yy, 2 * core + 1, 1); }
        }
      }
      for (const s of st.near) {
        const ph = Math.sin(now / s.rate + s.ph);
        const lv = ph > 0.45 ? 0.9 : ph > -0.4 ? 0.52 : 0.22;
        ctx.fillStyle = rgba(s.c, lv);
        ctx.fillRect(fl(((s.x * w + nx0) % w + w) % w), fl(((s.y * h + ny0) % h + h) % h), s.r, s.r);
      }

      ctx.globalAlpha = 0.8;
      tileN(ctx, st.moteCv, TW, TH, w, h, parX(cam, D.mote) + t * 5, parY(cam, D.mote) + t * 1.5);
      ctx.globalAlpha = 1;
      drawMeteor(ctx, w, h, now);
      drawBolide(ctx, w, h, now);
    },
  };

  /* ------------------------------------------------------------ BACKDROP: ANDROMEDA ---- */
  /* Built to a REFERENCE Andrew supplied on 2026-09-04 after rejecting two guesses (a face-on
     black-hole disc: "i hate it"; the void sharpened: "just looks like our original but worse").
     The reference: a hard-quantized pixel-art galaxy — pure black, then FOUR blues (navy, blue,
     cyan, white) and nothing else; chunky 2-4px cells; a tilted spiral with a blown-white core
     falling off through cyan and blue to scattered single navy pixels; a dense dust of tiny blue
     stars everywhere; a few big ROUND white stars. His words: "something like this but animated,
     should have space travel actively moving in the background, stars that actually twinkle, and
     a galaxy or maybe even black hole."

     So, the three things the reference does not do on its own and this must:
       1. TRAVEL. The star layers STREAM, continuously and visibly (the void's drift is 3-15 px/s
          and reads as still; this runs 5-30 px/s diagonally, far slow / near fast) and the
          galaxy, being the farthest thing, barely moves at all. That speed ladder IS the travel.
       2. TWINKLE that reads as pixels: the near stars step between three brightness levels
          rather than fading smoothly, and the big stars pulse their halo ring on and off.
       3. THE GALAXY as the subject: a fixed tile (like THE NURSERY) so a resize never re-rolls
          it, pinned to the frame centre with a slow sway, plus a hair of camera parallax.

     Palette law: NOTHING in this backdrop is drawn outside the five-colour ramp below. That is
     what makes it match the reference instead of the void with a galaxy stuck on. */

  const GALAXY_BG = {
    label: 'ANDROMEDA',
    blurb: 'Hard blue pixels, a spiral in frame, and the field streaming past.',
    base: '#000000',
    PAL: {
      NAVY: [0, 14, 74], BLUE: [0, 58, 184], CYAN: [30, 148, 212], WHITE: [200, 228, 245],
      TEAL: [48, 180, 160],
      PALE: [110, 190, 232],               // the galaxy's TOP colour — never white (Andrew: "just dont like the white part")                  // the reference's rare green-cyan speck
    },
    // travel: px/sec per layer along DIR (far → near), and the parallax depth of each
    DIR: [-0.94, 0.34],
    SPD: { far: 5, gal: 0.8, mid: 13, big: 9, near: 28 },
    D: { far: 0.010, gal: 0.020, mid: 0.030, big: 0.035, near: 0.055 },
    SWAY: { x: 30, y: 10, sx: 260, sy: 330 },
    CELL: 1,                                 // galaxy pixel size in device px (was 3: Andrew, "way too pixelated")

    fixedTile: () => {
      const scr = (typeof window !== 'undefined' && window.screen) || {};
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const long = Math.max(Number(scr.width) || 0, Number(scr.height) || 0) || 1600;
      return Math.max(1200, Math.min(2048, Math.round(long * Math.min(dpr, 2))));
    },

    build(w, h, rnd) {
      const P = GALAXY_BG.PAL, u = px1();
      const col = (c, a) => rgba(c, a == null ? 1 : a);
      const hash = (x, y) => {
        let k = Math.imul(x + 0x5BD1E995, 0x27D4EB2D) ^ Math.imul(y + 0x2545F491, 0x165667B1);
        k = Math.imul(k ^ (k >>> 15), 0x2C1B3C6D);
        return ((k ^ (k >>> 12)) >>> 0) / 4294967296;
      };

      /* ---- 1. FAR DUST: the reference's ground texture — thousands of single navy/blue pixels ---- */
      const farCv = mkCv(w, h), fc = farCv.getContext('2d');
      const farN = Math.min(16000, Math.round((w * h) / 190));
      for (let i = 0; i < farN; i++) {
        const r = rnd();
        fc.fillStyle = r < 0.62 ? col(P.NAVY, 0.6) : r < 0.93 ? col(P.BLUE, 0.45) : r < 0.985 ? col(P.CYAN, 0.45) : col(P.TEAL, 0.5);
        fc.fillRect((rnd() * w) | 0, (rnd() * h) | 0, u, u);
      }

      /* ---- 2. THE GALAXY, at cell resolution, hard-quantized ----
         A tilted spiral: elliptical falloff for the disc, a steep core, two log-spiral arms
         modulating the density, and low-frequency noise so the edge is ragged. Quantized to the
         ramp with a per-cell hash dither at the thresholds, so the bands interlock in pixels the
         way the reference's do instead of drawing clean contour lines. Where the density is too
         thin for a band, the cell becomes a SINGLE SCATTERED PIXEL with probability ~ density —
         which is how the reference dissolves its outskirts into the star dust. */
      const galCv = mkCv(w, h), gc = galCv.getContext('2d');
      const C = GALAXY_BG.CELL, GW = Math.ceil(w / C), GH = Math.ceil(h / C);
      const ang = -0.62, ca = Math.cos(ang), sa = Math.sin(ang);
      const A = 0.23 * w, B = 0.085 * w;               // semi-axes (the tile is square) — the reference's galaxy is ~40% of frame
      const cx = w * 0.5, cy = h * 0.5;
      const rag = wrapNoise(9, rnd), rag2 = wrapNoise(23, rnd), rag3 = wrapNoise(47, rnd), rag4 = wrapNoise(101, rnd);
      const mass = { cxs: 0, sxs: 0, cys: 0, sys: 0, m: 0 };
      for (let gy = 0; gy < GH; gy++) {
        for (let gx = 0; gx < GW; gx++) {
          const px = gx * C + C / 2 - cx, py = gy * C + C / 2 - cy;
          const x = px * ca + py * sa, y = -px * sa + py * ca;   // into galaxy frame
          const ex = x / A, ey = y / B;
          const rho = Math.hypot(ex, ey);
          if (rho > 1.9) continue;
          const th = Math.atan2(ey, ex);
          /* DETAIL (Andrew: "the galaxy does not have any detail"). Arms are NARROW (a power on the
             cosine), a dust lane runs just inside each arm, knots of star formation sit on the arm
             crests, and a fourth, fine noise octave gives the disc grain. */
          const sp = 2 * th - 4.6 * Math.log(rho + 0.10);
          const arm = Math.pow(0.5 + 0.5 * Math.cos(sp), 1.9);
          const lane = Math.pow(0.5 + 0.5 * Math.cos(sp + 1.1), 4) * Math.max(0, Math.min(1, (rho - 0.22) * 4)) * Math.max(0, 1 - rho / 1.5);
          const n = rag(gx / GW, gy / GH) * 0.4 + rag2(gx / GW, gy / GH) * 0.25 + rag3(gx / GW, gy / GH) * 0.2 + rag4(gx / GW, gy / GH) * 0.15;
          let d = Math.exp(-rho * 1.9) * (0.28 + 0.72 * arm) + Math.exp(-rho * 8.5) * 0.55;
          d *= 1 - 0.65 * lane;                          // the dust lanes bite in
          d *= 0.55 + 0.90 * n;                          // ragged and lumpy, not a clean ellipse
          d *= Math.max(0, 1 - Math.pow(rho / 1.9, 3));  // and it does end
          const dth = (hash(gx, gy) - 0.5) * 0.08;
          const v = d + dth;
          let c = null, a = 1;
          const knot = arm > 0.7 && rho > 0.28 && rho < 1.45 && hash(gx + 331, gy + 977) < 0.05 * (0.3 + d);
          if (knot) c = hash(gx + 5, gy + 9) < 0.5 ? P.PALE : P.CYAN;
          else if (v > 0.10) {
            // a NINE-step ramp navy → blue → cyan → white, still hard-stepped, so the disc has
            // gradation inside each band instead of four flat pools
            const q = Math.min(1, Math.round(Math.min(1, (v - 0.10) / 0.86) * 8) / 8);
            c = q < 0.4 ? mix3(P.NAVY, P.BLUE, q / 0.4) : q < 0.78 ? mix3(P.BLUE, P.CYAN, (q - 0.4) / 0.38) : mix3(P.CYAN, P.PALE, (q - 0.78) / 0.22);
            c = c.map(Math.round);
          }
          else if (hash(gx + 7919, gy + 104729) < d * 2.8) { c = hash(gx, gy + 31) < 0.7 ? P.NAVY : P.BLUE; a = 0.9; }
          if (!c) continue;
          gc.fillStyle = col(c, a);
          gc.fillRect(gx * C, gy * C, C, C);
          // circular mean of the mass, for the framing pin (torus-safe, as THE NURSERY does it)
          const ax = (gx / GW) * Math.PI * 2, ay = (gy / GH) * Math.PI * 2;
          mass.cxs += d * Math.cos(ax); mass.sxs += d * Math.sin(ax);
          mass.cys += d * Math.cos(ay); mass.sys += d * Math.sin(ay);
          mass.m += d;
        }
      }
      const turn = (c, s) => { const t = Math.atan2(s, c); return (t < 0 ? t + Math.PI * 2 : t) / (Math.PI * 2); };
      const focus = mass.m > 0
        ? { x: turn(mass.cxs, mass.sxs) * w, y: turn(mass.cys, mass.sys) * h, r: Math.min(Math.hypot(mass.cxs, mass.sxs), Math.hypot(mass.cys, mass.sys)) / mass.m }
        : { x: 0, y: 0, r: 0 };

      /* ---- 3. MID STARS: brighter singles, blue/cyan, with the odd 2px ---- */
      const midCv = mkCv(w, h), mc = midCv.getContext('2d');
      const midN = Math.min(3000, Math.round((w * h) / 950));
      for (let i = 0; i < midN; i++) {
        const r = rnd();
        mc.fillStyle = r < 0.5 ? col(P.BLUE, 0.7) : r < 0.9 ? col(P.CYAN, 0.65) : col(P.WHITE, 0.7);
        const s = rnd() < 0.85 ? u : 2 * u;
        mc.fillRect((rnd() * w) | 0, (rnd() * h) | 0, s, s);
      }

      /* ---- 4. LIVE layers: the near twinklers and the big round stars ---- */
      const near = [];
      const nearN = Math.min(260, Math.round((w * h) / 9000));
      for (let i = 0; i < nearN; i++) near.push({ x: rnd(), y: rnd(), r: rnd() < 0.7 ? u : 2 * u, ph: rnd() * 10, rate: 700 + rnd() * 900, c: rnd() < 0.55 ? P.CYAN : P.WHITE });
      const big = [];
      for (let i = 0, n = 9 + Math.floor(rnd() * 4); i < n; i++) big.push({ x: rnd(), y: rnd(), ph: rnd() * 10, rate: 1600 + rnd() * 1400, huge: rnd() < 0.2 });

      return { farCv, galCv, midCv, near, big, focus };
    },

    draw(ctx, w, h, now, cam, st) {
      const S = GALAXY_BG.SPD, D = GALAXY_BG.D, P = GALAXY_BG.PAL, [dx, dy] = GALAXY_BG.DIR;
      const t = now / 1000;
      const TW = st.farCv.width, TH = st.farCv.height;
      const fl = v => Math.floor(v);

      // far dust streams slowest
      tileN(ctx, st.farCv, TW, TH, w, h, parX(cam, D.far) + t * S.far * dx, parY(cam, D.far) + t * S.far * dy);

      // the galaxy: pinned to the frame centre, swaying, creeping along DIR at the slowest rate
      const F = st.focus || { r: 0 }, SW = GALAXY_BG.SWAY;
      // pinned LEFT of centre (Andrew, 2026-09-05: "have the galaxy slightly to the left") so it
      // shows beside the station rather than hiding behind it
      const pinX = F.r > 0.08 ? w * 0.36 - F.x : 0, pinY = F.r > 0.08 ? h * 0.46 - F.y : 0;
      tileN(ctx, st.galCv, TW, TH, w, h,
        parX(cam, D.gal) + pinX + SW.x * Math.sin(t / SW.sx * Math.PI * 2) + t * S.gal * dx,
        parY(cam, D.gal) + pinY + SW.y * Math.sin(t / SW.sy * Math.PI * 2) + t * S.gal * dy);

      tileN(ctx, st.midCv, TW, TH, w, h, parX(cam, D.mid) + t * S.mid * dx, parY(cam, D.mid) + t * S.mid * dy);

      /* the big round stars: a white 3x3 heart with a plus, and a blue halo ring that pulses.
         Stepped: the ring is either on or off, the heart is always on. */
      const bx0 = parX(cam, D.big) + t * S.big * dx, by0 = parY(cam, D.big) + t * S.big * dy;
      for (const b of st.big) {
        const x = fl(((b.x * w + bx0) % w + w) % w), y = fl(((b.y * h + by0) % h + h) % h);
        // a ROUND star, as the reference draws them: a pixel disc of radius 3-5 with a blue rim
        const R = b.huge ? 5 : 3;
        const on = Math.sin(now / b.rate + b.ph) > 0.2;
        for (let yy = -R - 1; yy <= R + 1; yy++) {
          const half = Math.floor(Math.sqrt(Math.max(0, (R + 1) * (R + 1) - yy * yy)));
          const inner = Math.floor(Math.sqrt(Math.max(0, R * R - yy * yy)));
          if (on) { ctx.fillStyle = rgba(P.BLUE, 0.9); ctx.fillRect(x - half, y + yy, 2 * half + 1, 1); }
          if (inner >= 0 && Math.abs(yy) <= R) { ctx.fillStyle = rgba(P.CYAN, 1); ctx.fillRect(x - inner, y + yy, 2 * inner + 1, 1); }
          const core = Math.floor(Math.sqrt(Math.max(0, (R - 1) * (R - 1) - yy * yy)));
          if (Math.abs(yy) <= R - 1) { ctx.fillStyle = rgba(P.WHITE, 1); ctx.fillRect(x - core, y + yy, 2 * core + 1, 1); }
        }
      }

      /* the near twinklers: THREE brightness steps, snapped — a pixel star does not fade */
      const nx0 = parX(cam, D.near) + t * S.near * dx, ny0 = parY(cam, D.near) + t * S.near * dy;
      for (const s of st.near) {
        const ph = Math.sin(now / s.rate + s.ph);
        const lv = ph > 0.45 ? 0.85 : ph > -0.4 ? 0.5 : 0.22;
        ctx.fillStyle = rgba(s.c, lv);
        ctx.fillRect(fl(((s.x * w + nx0) % w + w) % w), fl(((s.y * h + ny0) % h + h) % h), s.r, s.r);
      }

      drawMeteor(ctx, w, h, now);
      drawBolide(ctx, w, h, now);
    },
  };

  /* ------------------------------------------------ shared: the BLUE PIXEL space family ---- */
  /* ANDROMEDA set the language (Andrew's reference, 2026-09-04): black, then navy / blue / cyan
     and nothing else, single-pixel star dust, round white stars that pulse, and the field
     STREAMING so the station reads as travelling. EVENT HORIZON and THE BELT are the same sky
     with a different thing in it, so the field is built and drawn by these shared helpers. */

  function blueField(w, h, rnd, o) {
    const P = GALAXY_BG.PAL, u = px1(), col = (c, a) => rgba(c, a == null ? 1 : a);
    const farCv = mkCv(w, h), fc = farCv.getContext('2d');
    const farN = Math.min(16000, Math.round((w * h) / (o.farDiv || 190)));
    for (let i = 0; i < farN; i++) {
      const r = rnd();
      fc.fillStyle = r < 0.62 ? col(P.NAVY, 0.6) : r < 0.93 ? col(P.BLUE, 0.45) : r < 0.985 ? col(P.CYAN, 0.45) : col(P.TEAL, 0.5);
      fc.fillRect((rnd() * w) | 0, (rnd() * h) | 0, u, u);
    }
    const midCv = mkCv(w, h), mc = midCv.getContext('2d');
    const midN = Math.min(3000, Math.round((w * h) / (o.midDiv || 950)));
    for (let i = 0; i < midN; i++) {
      const r = rnd();
      mc.fillStyle = r < 0.5 ? col(P.BLUE, 0.7) : r < 0.9 ? col(P.CYAN, 0.65) : col(P.WHITE, 0.7);
      const s = rnd() < 0.85 ? u : 2 * u;
      mc.fillRect((rnd() * w) | 0, (rnd() * h) | 0, s, s);
    }
    const near = [];
    const nearN = Math.min(260, Math.round((w * h) / 9000));
    for (let i = 0; i < nearN; i++) near.push({ x: rnd(), y: rnd(), r: rnd() < 0.7 ? u : 2 * u, ph: rnd() * 10, rate: 700 + rnd() * 900, c: rnd() < 0.55 ? P.CYAN : P.WHITE });
    const big = [];
    for (let i = 0, n = (o.bigN || 9) + Math.floor(rnd() * 4); i < n; i++) big.push({ x: rnd(), y: rnd(), ph: rnd() * 10, rate: 1600 + rnd() * 1400, huge: rnd() < 0.2 });
    return { farCv, midCv, near, big };
  }

  /* the live part of the field: round pulsing stars and three-step twinklers, streaming along dir */
  function drawBlueLive(ctx, w, h, now, cam, st, dir, spd, dep) {
    const P = GALAXY_BG.PAL, t = now / 1000, fl = Math.floor, [dx, dy] = dir;
    const bx0 = parX(cam, dep.big) + t * spd.big * dx, by0 = parY(cam, dep.big) + t * spd.big * dy;
    for (const b of st.big) {
      const x = fl(((b.x * w + bx0) % w + w) % w), y = fl(((b.y * h + by0) % h + h) % h);
      const R = b.huge ? 5 : 3;
      const on = Math.sin(now / b.rate + b.ph) > 0.2;
      for (let yy = -R - 1; yy <= R + 1; yy++) {
        const half = Math.floor(Math.sqrt(Math.max(0, (R + 1) * (R + 1) - yy * yy)));
        const inner = Math.floor(Math.sqrt(Math.max(0, R * R - yy * yy)));
        if (on) { ctx.fillStyle = rgba(P.BLUE, 0.9); ctx.fillRect(x - half, y + yy, 2 * half + 1, 1); }
        if (Math.abs(yy) <= R) { ctx.fillStyle = rgba(P.CYAN, 1); ctx.fillRect(x - inner, y + yy, 2 * inner + 1, 1); }
        const core = Math.floor(Math.sqrt(Math.max(0, (R - 1) * (R - 1) - yy * yy)));
        if (Math.abs(yy) <= R - 1) { ctx.fillStyle = rgba(P.WHITE, 1); ctx.fillRect(x - core, y + yy, 2 * core + 1, 1); }
      }
    }
    const nx0 = parX(cam, dep.near) + t * spd.near * dx, ny0 = parY(cam, dep.near) + t * spd.near * dy;
    for (const s of st.near) {
      const ph = Math.sin(now / s.rate + s.ph);
      const lv = ph > 0.45 ? 0.85 : ph > -0.4 ? 0.5 : 0.22;
      ctx.fillStyle = rgba(s.c, lv);
      ctx.fillRect(fl(((s.x * w + nx0) % w + w) % w), fl(((s.y * h + ny0) % h + h) % h), s.r, s.r);
    }
  }

  /* -------------------------------------------------------------- BACKDROP: THE BELT ---- */
  /* A meteor shower, flown through. Andrew, 2026-09-05: "make the belts asteroids a bit smaller,
     make it more like a meteor shower vibe and give it the orange red hue." So: the red family
     (the palette of the Interstellar reference he liked — deep red, red, orange, yellow, with
     purple in the dust and four-point cross stars), SMALL pixel rocks in three parallax layers,
     and the shower itself: a live swarm of fast streaks with fading ember tails crossing the frame
     along the travel direction, plus a fireball — a rock with a burning tail — every so often.
     Rocks occlude the stars; that occlusion is what makes them solid. */

  const BELT_BG = {
    label: 'THE BELT',
    blurb: 'A meteor shower, flown through. Small rocks, fast embers, the odd fireball.',
    base: '#000000',
    PAL: {
      DEEP: [72, 8, 16], RED: [196, 26, 22], ORANGE: [255, 108, 24], YELLOW: [255, 208, 96], HOT: [255, 244, 200],
      DUSTR: [140, 20, 30], DUSTP: [120, 30, 170], DUSTO: [200, 80, 30], STARP: [190, 70, 255], STARR: [255, 80, 60],
      BODY: [58, 16, 14], DARK: [26, 6, 8], BODY2: [92, 30, 18],
    },
    DIR: [-0.94, 0.34],
    SPD: { far: 5, mid: 12, near: 24, rockFar: 16, rockMid: 36, rockNear: 75 },
    D: { far: 0.010, mid: 0.030, near: 0.055, rockFar: 0.06, rockMid: 0.14, rockNear: 0.30 },
    ROCKS: [
      { n: 60, min: 2.5, max: 6 },            // far — grains
      { n: 26, min: 5, max: 11 },             // mid
      { n: 9, min: 10, max: 22 },             // near
    ],
    LIGHT: [-0.55, -0.83],                   // sunward (up-left): where the rims are lit
    STREAKS: 56,                             // live embers in flight at once

    build(w, h, rnd) {
      const P = BELT_BG.PAL, u = px1(), col = (c, a) => rgba(c, a == null ? 1 : a);
      /* ---- the field: red/purple dust, cross stars, near twinklers ---- */
      const farCv = mkCv(w, h), fc = farCv.getContext('2d');
      const farN = Math.min(24000, Math.round((w * h) / 115));
      for (let i = 0; i < farN; i++) {
        const r = rnd();
        fc.fillStyle = r < 0.45 ? col(P.DUSTR, 0.8) : r < 0.85 ? col(P.DUSTP, 0.75) : col(P.DUSTO, 0.65);
        fc.fillRect((rnd() * w) | 0, (rnd() * h) | 0, u, u);
      }
      const midCv = mkCv(w, h), mc = midCv.getContext('2d');
      const midN = Math.min(3400, Math.round((w * h) / 850));
      for (let i = 0; i < midN; i++) {
        const r = rnd();
        mc.fillStyle = r < 0.45 ? col(P.STARR, 0.75) : r < 0.85 ? col(P.STARP, 0.7) : col(P.YELLOW, 0.7);
        const s = rnd() < 0.8 ? u : 2 * u;
        mc.fillRect((rnd() * w) | 0, (rnd() * h) | 0, s, s);
      }
      const near = [];
      for (let i = 0, n = Math.min(220, Math.round((w * h) / 10000)); i < n; i++) near.push({ x: rnd(), y: rnd(), r: rnd() < 0.7 ? u : 2 * u, ph: rnd() * 10, rate: 700 + rnd() * 900, c: rnd() < 0.5 ? P.STARR : rnd() < 0.6 ? P.STARP : P.YELLOW });
      const cross = [];
      for (let i = 0, n = 16 + Math.floor(rnd() * 6); i < n; i++) cross.push({ x: rnd(), y: rnd(), ph: rnd() * 10, rate: 1400 + rnd() * 1600, c: rnd() < 0.5 ? P.STARP : rnd() < 0.7 ? P.STARR : P.YELLOW, big: rnd() < 0.3 });

      /* ---- the rocks: noise-deformed pixel discs, two-tone body, lit rim toward LIGHT ---- */
      const [lx, ly] = BELT_BG.LIGHT;
      const rock = (c, cx, cy, R) => {
        const prof = new Float32Array(32);
        const base = rnd() * 0.3;
        for (let i = 0; i < 32; i++) prof[i] = R * (0.68 + base + 0.32 * rnd());
        for (let i = 1; i < 32; i++) prof[i] = prof[i] * 0.5 + prof[i - 1] * 0.5;
        prof[0] = (prof[0] + prof[31]) * 0.5;
        const at = th => { const f = ((th / (Math.PI * 2)) + 1) % 1 * 32, i = Math.floor(f), t = f - i; return prof[i % 32] * (1 - t) + prof[(i + 1) % 32] * t; };
        const craters = [];
        for (let k = 0, n = R > 12 ? 1 + Math.floor(rnd() * 2) : 0; k < n; k++) {
          const a = rnd() * Math.PI * 2, d = rnd() * R * 0.5;
          craters.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d, R * (0.14 + 0.16 * rnd())]);
        }
        const warm = rnd() < 0.35 ? P.BODY2 : P.BODY;
        const B = Math.ceil(R * 1.05) + 2;
        for (let y = -B; y <= B; y++) for (let x = -B; x <= B; x++) {
          const d = Math.hypot(x, y); if (d < 0.001) { c.fillStyle = col(warm); c.fillRect(cx, cy, 1, 1); continue; }
          const th = Math.atan2(y, x), edge = at(th);
          if (d > edge) continue;
          const facing = (x * lx + y * ly) / d;
          let cc = (facing * (d / edge) < -0.15) ? P.DARK : warm;
          const rimW = Math.max(1.5, R * 0.18);
          if (d > edge - rimW && facing > 0.05) cc = facing > 0.55 && d > edge - rimW * 0.6 ? P.YELLOW : P.ORANGE;
          else if (facing > 0.3 && d > edge * 0.35 && ((x * 7 + y * 13) & 3) === 0) cc = P.RED;
          for (const [kx, ky, kr] of craters) {
            if (Math.hypot(cx + x - kx, cy + y - ky) < kr) cc = P.DARK;
          }
          c.fillStyle = col(cc); c.fillRect(cx + x, cy + y, 1, 1);
        }
      };
      const layers = BELT_BG.ROCKS.map(L => {
        const cv = mkCv(w, h), c = cv.getContext('2d');
        for (let i = 0; i < L.n; i++) {
          const R = L.min + rnd() * (L.max - L.min);
          rock(c, Math.round(R + 2 + rnd() * (w - 2 * R - 4)), Math.round(R + 2 + rnd() * (h - 2 * R - 4)), R);
        }
        return cv;
      });
      // the fireball: one mid-size rock with a burning tail, pre-rendered head only (tail is live)
      const FR = 9 + rnd() * 9, fireCv = mkCv(Math.ceil(FR * 2.2) + 4, Math.ceil(FR * 2.2) + 4);
      rock(fireCv.getContext('2d'), Math.round(FR * 1.1 + 2), Math.round(FR * 1.1 + 2), FR);

      return { farCv, midCv, near, cross, layers, fireCv, fire: null, nextFire: 0, streaks: [], lastT: null };
    },

    draw(ctx, w, h, now, cam, st) {
      const S = BELT_BG.SPD, D = BELT_BG.D, [dx, dy] = BELT_BG.DIR, t = now / 1000, P = BELT_BG.PAL;
      tile2(ctx, st.farCv, w, h, parX(cam, D.far) + t * S.far * dx, parY(cam, D.far) + t * S.far * dy);
      tile2(ctx, st.midCv, w, h, parX(cam, D.mid) + t * S.mid * dx, parY(cam, D.mid) + t * S.mid * dy);
      tile2(ctx, st.layers[0], w, h, parX(cam, D.rockFar) + t * S.rockFar * dx, parY(cam, D.rockFar) + t * S.rockFar * dy);

      // cross stars and twinklers (the red family's live field)
      const cx0 = parX(cam, D.mid) + t * S.mid * dx, cy0 = parY(cam, D.mid) + t * S.mid * dy;
      for (const s of st.cross) {
        const x = Math.floor(((s.x * w + cx0) % w + w) % w), y = Math.floor(((s.y * h + cy0) % h + h) % h);
        const p = 0.5 + 0.5 * Math.sin(now / s.rate + s.ph);
        const arm = (s.big ? 3 : 2) + Math.round(p * (s.big ? 3 : 2));
        ctx.fillStyle = rgba(s.c, 0.55 + 0.35 * p);
        ctx.fillRect(x - arm, y, 2 * arm + 1, 1); ctx.fillRect(x, y - arm, 1, 2 * arm + 1);
        if (s.big) { ctx.fillStyle = rgba(s.c, 0.35 * p); ctx.fillRect(x - 1, y - 1, 3, 3); }
        ctx.fillStyle = rgba(P.HOT, 0.9); ctx.fillRect(x, y, 1, 1);
      }
      const nx0 = parX(cam, D.near) + t * S.near * dx, ny0 = parY(cam, D.near) + t * S.near * dy;
      for (const s of st.near) {
        const ph = Math.sin(now / s.rate + s.ph);
        const lv = ph > 0.45 ? 0.9 : ph > -0.4 ? 0.55 : 0.25;
        ctx.fillStyle = rgba(s.c, lv);
        ctx.fillRect(Math.floor(((s.x * w + nx0) % w + w) % w), Math.floor(((s.y * h + ny0) % h + h) % h), s.r, s.r);
      }

      tile2(ctx, st.layers[1], w, h, parX(cam, D.rockMid) + t * S.rockMid * dx, parY(cam, D.rockMid) + t * S.rockMid * dy);

      /* THE SHOWER: fast embers with fading tails. dt-driven; each respawns off the entering edge
         (DIR points down-left, so they enter from the top and right). Under reduced-motion the
         swarm is empty — this is exactly the dramatic motion that setting asks us not to add. */
      const dt = st.lastT == null ? 0 : Math.min(0.1, t - st.lastT); st.lastT = t;
      const spawn = () => {
        const fromTop = Math.random() < 0.55;
        return {
          x: fromTop ? Math.random() * w * 1.3 : w + 20, y: fromTop ? -20 : Math.random() * h * 0.8,
          spd: 300 + Math.random() * 480, len: 18 + Math.floor(Math.random() * 30), c: Math.random() < 0.6 ? P.ORANGE : Math.random() < 0.5 ? P.YELLOW : P.RED,
          big: Math.random() < 0.28,
        };
      };
      if (!reduceMotion()) while (st.streaks.length < BELT_BG.STREAKS) st.streaks.push(spawn());
      for (let i = st.streaks.length - 1; i >= 0; i--) {
        const s = st.streaks[i];
        s.x += dx * s.spd * dt; s.y += dy * s.spd * dt;
        if (s.x < -s.len * 2 - 30 || s.y > h + 30) { st.streaks[i] = spawn(); continue; }
        const px = Math.round(s.x), py = Math.round(s.y), k = s.big ? 2 : 1;
        // tail: dimming embers back along the direction of travel
        for (let j = 1; j <= s.len; j++) {
          const f = 1 - j / s.len;
          ctx.fillStyle = rgba(j < s.len * 0.3 ? P.YELLOW : j < s.len * 0.6 ? s.c : P.RED, 0.35 + 0.65 * f);
          ctx.fillRect(Math.round(px - dx * j * k), Math.round(py - dy * j * k), k, k);   // one pixel per step: a solid tail, not dots
        }
        ctx.fillStyle = rgba(P.HOT, 1); ctx.fillRect(px, py, k, k);
      }

      tile2(ctx, st.layers[2], w, h, parX(cam, D.rockNear) + t * S.rockNear * dx, parY(cam, D.rockNear) + t * S.rockNear * dy);

      // THE FIREBALL: every 9-25s a rock with a burning tail tears across in ~2s
      if (!st.nextFire) st.nextFire = now + 4000 + Math.random() * 8000;
      if (!st.fire && now > st.nextFire && !reduceMotion()) {
        const spd = Math.max(w, h) * (0.5 + Math.random() * 0.3);
        st.fire = { x: w + 40 + Math.random() * w * 0.3, y: -40 + Math.random() * h * 0.5, vx: dx * spd, vy: dy * spd, born: now };
      }
      if (st.fire) {
        const el = (now - st.fire.born) / 1000;
        const x = st.fire.x + st.fire.vx * el, y = st.fire.y + st.fire.vy * el;
        const cw = st.fireCv.width;
        if (x < -cw - 200 || y > h + cw + 100) { st.fire = null; st.nextFire = now + 9000 + Math.random() * 16000; }
        else {
          for (let j = 1; j <= 26; j++) {                        // the burning tail, widening as it fades
            const f = 1 - j / 26, wdt = 1 + Math.floor(j / 7);
            ctx.fillStyle = rgba(j < 6 ? P.YELLOW : j < 14 ? P.ORANGE : j < 20 ? P.RED : P.DEEP, 0.2 + 0.75 * f);
            ctx.fillRect(Math.round(x + cw / 2 - dx * j * 3.2) - (wdt >> 1), Math.round(y + cw / 2 - dy * j * 3.2) - (wdt >> 1), wdt, wdt);
          }
          ctx.drawImage(st.fireCv, Math.round(x), Math.round(y));
        }
      }

      drawMeteor(ctx, w, h, now);
      drawBolide(ctx, w, h, now);
    },
  };

  /* ------------------------------------------------------- shared: SURFACE backdrops ---- */
  /* Everything the station can float ABOVE (ocean, city, and whatever comes next) shares the
     same three problems, so they share the same three helpers: a deck of cloud, a haze that
     kills contrast with distance, and the parallax depths that put them in order.

     Depth semantics: d is the fraction of the camera pan a layer follows. The station sits at
     d=1. Anything BELOW it follows less — the further down, the smaller d. So a surface at 0.10
     crawls while clouds at 0.40 slide, and the gap between them is what the eye reads as
     altitude. These two numbers are the whole illusion — tune them before tuning any colour. */
  const SURF = { deck: 0.10, cloud: 0.40 };

  /* Atmospheric perspective: everything far below is washed toward the sky's own colour. This
     is why a surface backdrop can never just be a bright picture — without this the deck reads
     as a texture swatch pasted behind the station instead of a place a long way down. */
  function hazeOver(c, w, h, rgb, a) {
    c.fillStyle = rgba(rgb, a);
    c.fillRect(0, 0, w, h);
  }

  /* PIXEL CLOUDS (2026-09-09). The first cloud decks were soft radial puffs at 15% alpha, and on
     a live station they read as smudges on the lens — fog with no shape, which is exactly what a
     puff gradient IS. A cloud seen from above is an OBJECT: a lobed cumulus mass with a hard
     outline, a lit rim on the sun side, a shaded rim on the far side and a flat body between.
     Built from overlapping discs into a coverage field, edged by a hash dither (so the outline is
     ragged at the pixel scale, never anti-aliased), and shaded in THREE flat tones by probing the
     field a few pixels up-light and down-light: a probe that falls outside the cloud on the lit
     side makes the pixel rim, and so on. Toroidal by construction — every write wraps.
       opts: spread (px^2 per cloud) · min/vary (radius as a fraction of min(w,h)) · body/lit/shade
       colours · alpha (0-1) · light [x,y] (direction TOWARD the light) · rim (px) · `edge` makes
       every thin edge take the lit tone (an underlit night cloud glows all round, not on one
       side) · `mask` paints one flat colour from the same shapes — the cloud's SHADOW plate. */
  function buildPixelClouds(w, h, rnd, opts) {
    const o = opts || {};
    const cv = mkCv(w, h), c = cv.getContext('2d');
    const F = new Float32Array(w * h);                       // coverage field, wrapped
    const n = Math.max(3, Math.round((w * h) / (o.spread || 220000)));
    const idx = (x, y) => (((y % h) + h) % h) * w + (((x % w) + w) % w);
    for (let i = 0; i < n; i++) {
      const cx = rnd() * w, cy = rnd() * h;
      const R = (o.min || 0.05) * Math.min(w, h) * (1 + rnd() * (o.vary == null ? 1.2 : o.vary));
      const lobes = [];
      for (let p = 0, L = 7 + Math.floor(rnd() * 8); p < L; p++) {
        // a cauliflower, wind-sheared: lobes bunched near the middle, wider than tall
        const a = rnd() * Math.PI * 2, dd = Math.pow(rnd(), 0.7);
        lobes.push([cx + Math.cos(a) * dd * R * 1.1, cy + Math.sin(a) * dd * R * 0.55, R * (0.34 + 0.42 * rnd()) * (1 - dd * 0.35)]);
      }
      const B = Math.ceil(R * 2.0);
      for (let y = Math.floor(cy - B); y <= cy + B; y++) {
        for (let x = Math.floor(cx - B * 1.3); x <= cx + B * 1.3; x++) {
          let f = 0;
          for (const [lx, ly, lr] of lobes) { const d = 1 - Math.hypot(x - lx, y - ly) / lr; if (d > f) f = d; }
          if (f <= 0) continue;
          const k = idx(x, y);
          if (f > F[k]) F[k] = f;
        }
      }
    }
    const img = c.createImageData(w, h), D = img.data;
    const [lx, ly] = o.light || [-0.6, -0.8];
    const rim = o.rim || 3;
    const A = Math.round(255 * (o.alpha == null ? 0.9 : o.alpha));
    const body = o.body || [180, 188, 202], lit = o.lit || [220, 226, 238], shade = o.shade || [122, 132, 152];
    const out = (x, y) => F[idx(Math.round(x), Math.round(y))] <= 0.02;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const f = F[y * w + x];
        if (f <= 0) continue;
        // dithered outline: the thinner the coverage, the likelier the pixel drops out
        if (f < 0.12 && hashDither(x, y) + 0.5 > f / 0.12) continue;
        let col = body;
        if (o.mask) col = o.mask;
        else if (o.edge) { if (out(x + rim, y) || out(x - rim, y) || out(x, y + rim) || out(x, y - rim)) col = lit; }
        else if (out(x + lx * rim, y + ly * rim)) col = lit;
        else if (out(x - lx * rim, y - ly * rim)) col = shade;
        const p = (y * w + x) * 4;
        D[p] = col[0]; D[p + 1] = col[1]; D[p + 2] = col[2]; D[p + 3] = A;
      }
    }
    c.putImageData(img, 0, 0);
    return cv;
  }

  /* the old soft cloud deck — still used by OCEAN until its rewrite lands; then it goes. */
  function buildCloudDeck(w, h, rnd, opts) {
    const o = opts || {};
    const cv = mkCv(w, h), c = cv.getContext('2d');
    const n = Math.max(5, Math.round((w * h) / (o.spread || 190000)));
    const tint = o.tint || [235, 244, 255];
    for (let i = 0; i < n; i++) {
      const cx = rnd() * w, cy = rnd() * h;
      const R = (o.min || 0.06) * Math.min(w, h) + rnd() * (o.vary || 0.10) * Math.min(w, h);
      for (let p = 0, lobes = 5 + Math.floor(rnd() * 5); p < lobes; p++) {
        const lx = cx + (rnd() - 0.5) * R * 2.1, ly = cy + (rnd() - 0.5) * R * 1.1;
        puff9(c, w, h, lx, ly, R * (0.42 + 0.5 * rnd()), tint, (o.alpha || 0.15) * (0.55 + 0.6 * rnd()));
      }
    }
    return cv;
  }

  /* --------------------------------------------------------------- BACKDROP: OCEAN ---- */
  /* Open water from altitude.

     THE MISTAKE THIS IS A REWRITE OF (2026-07-24, Andrew: "it looks like stars"): the first
     version drew the sea as SPARSE BRIGHT MARKS ON A DARK FIELD and gave the glint the same
     shape as the star twinkle — isolated 1px points, independently fading in and out. That is
     not a description of water, it is the definition of a starfield, so it read as one.

     Water is a CONTINUOUS SURFACE: every pixel is water, and waves are a modulation of it, never
     marks scattered on top of a dark background. So the deck is built as a real wave field —
     four crossing waves summed per pixel through an ImageData buffer, quantized into a handful
     of flat bands so it stays pixel-art rather than turning into a smooth photograph. The finest
     wave deliberately runs fast in y and slow in x, which lays the field into HORIZONTAL STREAKS;
     that anisotropy is what the eye actually reads as a water surface seen from above.

     Foam sits on the crests of that same field and glitter is DENSE and lies on a BRIGHT sheen —
     the two properties a starfield can never have (stars are sparse, independent, and on black).
     The sun is never in frame (law 3); you only see what it does to the water. */

  const OCEAN_BG = {
    label: 'OCEAN',
    blurb: 'Open water, a long way down. Sun on the swell.',
    base: '#05101c',

    /* THE LIGHT BLOCK — every luminance in this backdrop, in one place.
       The station must stay the brightest thing on screen; it is the subject and it is lit from
       within. Measured live at 1440x900, backdrop luma / station luma: THE VOID sits at 0.53,
       NIGHT CITY 0.62, DEEP FIELD 0.45. The first OCEAN came in at 1.25 — BRIGHTER than the
       station — which inverted the composition and made the station read as a dark cutout
       pasted onto a bright picture (Andrew, 2026-07-24: "the lighting is way off compared to
       the station"). Everything below was scaled down together to land near 0.55.

       Scale these AS A SET. Dimming the water while leaving the highlights hot would push the
       pop-out ratio back up and turn the sea into a starfield again — which is the exact bug
       this backdrop was already rebuilt once to fix. */
    LIGHT: {
      DEEP: [3, 13, 23],            // trough
      CREST: [22, 45, 53],          // crest
      FOAM: [58, 76, 83],           // broken water on the highest crests
      SHEEN: [17, 20, 19],          // additive specular boost at the centre of the sun's answer
      FOAM_RGB: '108,130,140', FOAM_A: [0.05, 0.17],
      GLITTER_RGB: '150,182,196', GLITTER_A: 0.38,
      HAZE: [18, 34, 45], HAZE_A: 0.20,
      CLOUD: [100, 113, 132], CLOUD_A: 0.18,
      WISP: [108, 120, 136], WISP_A: 0.08,
      SHADOW: [2, 7, 14], SHADOW_A: 0.14,
    },

    build(w, h, rnd) {
      /* THE SEA IS BUILT AT HALF RESOLUTION and blitted back up by tile2 (which always draws a
         tile at the full w x h, whatever the source size). Two reasons, both good: the per-pixel
         wave pass is 4x cheaper — a full-res 4K build measured 442ms, which is a visible hitch on
         the one-shot resize rebuild — and the 2x upscale gives the water CHUNKIER pixels, which
         sits better beside the station's own art than a fine smooth field does. Toroidality
         survives scaling: the source wraps in its own space, so the blit wraps in ours. */
      const SW = Math.max(1, Math.ceil(w / 2)), SH = Math.max(1, Math.ceil(h / 2));
      const area = SW * SH;
      const seaCv = mkCv(SW, SH), sc = seaCv.getContext('2d');

      /* ---- THE WAVE FIELD ----
         Each wave is an integer number of cycles across the tile, so every one is periodic on the
         torus and the tile cannot seam. The last is the texture wave: many cycles in y, few in x. */
      const wi = (a, b) => a + Math.floor(rnd() * (b - a + 1));
      const waves = [
        { nx: wi(1, 2), ny: wi(1, 2), a: 0.36 },        // the long swell
        { nx: wi(2, 4), ny: -wi(1, 3), a: 0.26 },       // a second swell, crossing
        { nx: wi(5, 8), ny: wi(3, 6), a: 0.20 },        // chop
        { nx: wi(2, 4), ny: wi(22, 34), a: 0.18 },      // TEXTURE: fast in y, slow in x -> streaks
      ];
      // Precompute each wave's phase per column and per row, in LUT units. The inner loop then
      // costs an add, a mask and a table read per wave instead of a Math.sin.
      for (const v of waves) {
        v.px = new Float32Array(SW);
        v.py = new Float32Array(SH);
        const ph = rnd();
        for (let x = 0; x < SW; x++) v.px[x] = (v.nx * x / SW) * SIN_N;
        for (let y = 0; y < SH; y++) v.py[y] = ((v.ny * y / SH) + ph) * SIN_N;
      }

      /* the specular sheen: where the sun answers back. Toroidal distance, so it wraps too. */
      const gx = rnd() * SW, gy = rnd() * SH, gR = Math.min(SW, SH) * (0.34 + 0.12 * rnd());
      const dt = (a, b, m) => { const d = Math.abs(a - b) % m; return Math.min(d, m - d); };

      const LT = OCEAN_BG.LIGHT;
      const DEEP = LT.DEEP, CREST = LT.CREST, FOAM = LT.FOAM, SHEEN = LT.SHEEN;   // NB: not SH — that is the half-res height
      const LEVELS = 7;                                  // quantize into flat bands = pixel art, not a photo

      const img = sc.createImageData(SW, SH), D = img.data;
      const w0 = waves[0], w1 = waves[1], w2 = waves[2], w3 = waves[3];
      let p = 0;
      for (let y = 0; y < SH; y++) {
        const y0 = w0.py[y], y1 = w1.py[y], y2 = w2.py[y], y3 = w3.py[y];
        for (let x = 0; x < SW; x++) {
          const v = w0.a * SIN_LUT[((w0.px[x] + y0) | 0) & SIN_MASK]
                  + w1.a * SIN_LUT[((w1.px[x] + y1) | 0) & SIN_MASK]
                  + w2.a * SIN_LUT[((w2.px[x] + y2) | 0) & SIN_MASK]
                  + w3.a * SIN_LUT[((w3.px[x] + y3) | 0) & SIN_MASK];
          let t = v * 0.5 + 0.5;                         // 0 = trough, 1 = crest
          t = Math.round(t * LEVELS) / LEVELS;           // flat bands

          const sheen = Math.max(0, 1 - Math.hypot(dt(x, gx, SW), dt(y, gy, SH)) / gR);
          const s2 = sheen * sheen;

          let r = DEEP[0] + (CREST[0] - DEEP[0]) * t + SHEEN[0] * s2;
          let g = DEEP[1] + (CREST[1] - DEEP[1]) * t + SHEEN[1] * s2;
          let b = DEEP[2] + (CREST[2] - DEEP[2]) * t + SHEEN[2] * s2;
          if (t > 0.88) {                                // foam breaks on the highest crests only
            const f = (t - 0.88) / 0.12;
            r += (FOAM[0] - r) * f; g += (FOAM[1] - g) * f; b += (FOAM[2] - b) * f;
          }
          D[p] = r; D[p + 1] = g; D[p + 2] = b; D[p + 3] = 255;
          p += 4;
        }
      }
      sc.putImageData(img, 0, 0);

      /* ---- FOAM STREAKS — short bright dashes lying ALONG the surface, on the crests. Drawn as
              dashes rather than dots for the same reason the texture wave is anisotropic. ---- */
      const foamN = Math.min(5200, Math.round(area / 950));
      for (let i = 0; i < foamN; i++) {
        const x = rnd() * SW, y = (rnd() * SH) | 0;
        const v = w0.a * SIN_LUT[(((w0.nx * x / SW) * SIN_N + w0.py[y]) | 0) & SIN_MASK]
                + w3.a * SIN_LUT[(((w3.nx * x / SW) * SIN_N + w3.py[y]) | 0) & SIN_MASK];
        if (v < 0.30) continue;                          // crests only
        const lit = Math.min(1, (v - 0.30) / 0.34);
        hdash(sc, SW, x, y, 1 + Math.round(rnd() * 3 + lit * 2),
          'rgba(' + LT.FOAM_RGB + ',' + (LT.FOAM_A[0] + LT.FOAM_A[1] * lit * rnd()).toFixed(3) + ')');
      }

      /* ---- THE GLITTER — live, and the thing most likely to regress into stars. It stays honest
              because it is DENSE, it is short DASHES not points, and it only exists inside the
              bright sheen. Sparse + isolated + on dark is the starfield look; this is none of it. */
      // normalized against the HALF-res field the sheen was placed in, so the glitter lands on
      // the sheen after the 2x blit rather than a quarter of the way across the tile.
      const sparks = [];
      const sparkN = Math.min(900, Math.round(area / 700));
      for (let i = 0; i < sparkN; i++) {
        const ang = rnd() * Math.PI * 2, rad = Math.sqrt(rnd()) * gR * 0.92;
        sparks.push({
          x: (gx + Math.cos(ang) * rad) / SW, y: (gy + Math.sin(ang) * rad * 0.75) / SH,
          ph: rnd() * 6.283, sp: 0.9 + rnd() * 2.2, len: 2 + Math.round(rnd() * 2),
        });
      }

      /* ---- cloud + shadow decks (same shapes, different depth) ---- */
      const cloudCv = buildCloudDeck(w, h, mulberry32(0x0CEA11), { spread: 118000, min: 0.05, vary: 0.10, alpha: LT.CLOUD_A, tint: LT.CLOUD });
      const shadowCv = buildCloudDeck(w, h, mulberry32(0x0CEA11), { spread: 118000, min: 0.05, vary: 0.10, alpha: LT.SHADOW_A, tint: LT.SHADOW });
      // a second, thinner deck much closer in — two cloud layers moving at different rates is the
      // cheapest honest way to say "there is air between you and the water".
      const wispCv = buildCloudDeck(w, h, mulberry32(0x0CEA22), { spread: 260000, min: 0.09, vary: 0.16, alpha: LT.WISP_A, tint: LT.WISP });

      hazeOver(sc, SW, SH, LT.HAZE, LT.HAZE_A);          // distance wash on the deck only

      return { seaCv, cloudCv, shadowCv, wispCv, sparks };
    },

    draw(ctx, w, h, now, cam, st) {
      const t = now / 1000;
      const sx = parX(cam, SURF.deck) + t * 1.5, sy = parY(cam, SURF.deck) + t * 0.5;
      tile2(ctx, st.seaCv, w, h, sx, sy);

      // cloud SHADOWS lie ON the water (deck depth) but travel on the wind, so they slide across it
      ctx.globalAlpha = 0.8;
      tile2(ctx, st.shadowCv, w, h, parX(cam, SURF.deck) + t * 5.5, parY(cam, SURF.deck) + t * 1.6);
      ctx.globalAlpha = 1;

      /* THE GLITTER. Sea glint snaps rather than breathing, so the twinkle is sharpened with a
         fourth power — but MANY are lit at once, which is what separates a shimmering patch of
         water from a sky full of independent stars. */
      for (const s of st.sparks) {
        const q = Math.sin(now * 0.006 * s.sp + s.ph);
        if (q <= 0) continue;
        const a = q * q * q * q;
        if (a < 0.06) continue;
        const x = ((s.x * w + sx) % w + w) % w, y = ((s.y * h + sy) % h + h) % h;
        ctx.fillStyle = 'rgba(' + OCEAN_BG.LIGHT.GLITTER_RGB + ',' + (a * OCEAN_BG.LIGHT.GLITTER_A).toFixed(3) + ')';
        ctx.fillRect(x, y, s.len, 1);                    // a dash along the surface, never a dot
      }

      // the cloud decks, much closer to the station — the parallax gap here IS the altitude
      ctx.globalAlpha = 0.92;
      tile2(ctx, st.cloudCv, w, h, parX(cam, SURF.cloud) + t * 5.5, parY(cam, SURF.cloud) + t * 1.6);
      ctx.globalAlpha = 0.75;
      tile2(ctx, st.wispCv, w, h, parX(cam, SURF.cloud * 1.55) + t * 13, parY(cam, SURF.cloud * 1.55) + t * 3.6);
      ctx.globalAlpha = 1;
    },
  };

  /* ---------------------------------------------------------- BACKDROP: NIGHT CITY ---- */
  /* A city at night from altitude. REBUILT 2026-09-09 — the first cut had the right idea (an
     axis-aligned lattice of sodium lamps, districts, a river the grid bends around, an orange
     dome) at a tenth of the light: measured live, its lamps sat at 6-40% alpha under a 13% warm
     veil and a CRT pass that halves contrast, so what reached the screen was a faint brown grid
     that read as a texture, not a place. Nobody could see the city.

     What a city looks like from straight above at night, and what this now draws:
       - STREETS ARE LINES OF LAMPS. Bright, regular, continuous — the lattice is the subject.
         Arterials are wider and hotter and BRIDGE the river; side streets stop at the water.
       - BLOCKS ARE BUILDINGS. The grid encloses blocks, and a block is lit by what stands on it:
         downtown blocks carry towers — footprints packed with cool white windows on a 2px
         lattice — dense districts line their streets with warm windows, suburbs scatter a few
         porch lights, parks stay dark. District comes from ONE density field, so downtown,
         suburb and park all fall out of the same map instead of three systems.
       - THE RIVER IS DARK, and it answers the city back: embankment lamps along both banks and
         the bank lights smeared into the water beneath them.
       - THE DOME. Light pollution over the dense parts, additive, breathing slightly.
       - LIVE: traffic runs the arterials as 2px dashes (warm one way, red the other), and a
         dozen red beacons on the tallest towers blink out of phase. Reduced motion holds the
         beacons steady and the cars still.
       - CLOUDS are hard-edged pixel cumulus, UNDERLIT: dark body, every thin edge glowing the
         city's orange. That the light is BELOW the cloud is the strongest altitude cue there is.
     Roads stay axis-aligned on purpose — that is what most cities look like from directly above
     AND the only thing that tiles seamlessly on a torus; the river gets the sine treatment.
     Every mark on the ground plate is a hard pixel written into one wrapped buffer, so a lamp is
     a lamp and not a smear, and the tile seams by construction. */

  const CITY_BG = {
    label: 'NIGHT CITY',
    blurb: 'Somewhere with power. A grid of light, far below.',
    base: '#06050a',
    PAL: {
      GROUND: [10, 9, 15], PARK: [6, 12, 9], WATER: [3, 6, 16], ROOF: [22, 21, 30],
      LAMP: [255, 186, 104], LAMP_HI: [255, 228, 172],
      WIN_W: [255, 220, 156], WIN_C: [170, 218, 255], WIN_HI: [255, 250, 236],
      BEACON: [255, 56, 48], HEAD: [255, 246, 214], TAIL: [255, 80, 60],
      DOME: [255, 148, 58], DOME_HI: [255, 190, 100],
      CLOUD: [66, 46, 46], CLOUD_LIT: [150, 96, 66],
      HAZE: [58, 34, 28], HAZE_A: 0.03,
    },

    build(w, h, rnd) {
      const P = CITY_BG.PAL, area = w * h;
      const cityCv = mkCv(w, h), c = cityCv.getContext('2d');
      const img = c.createImageData(w, h), D = img.data;
      for (let i = 0; i < area; i++) { D[i * 4] = P.GROUND[0]; D[i * 4 + 1] = P.GROUND[1]; D[i * 4 + 2] = P.GROUND[2]; D[i * 4 + 3] = 255; }
      // wrapped, alpha-blended pixel write — every mark on the ground plate goes through this
      const put = (x, y, col, a) => {
        const p = (((((y | 0) % h) + h) % h) * w + ((((x | 0) % w) + w) % w)) * 4;
        D[p] += (col[0] - D[p]) * a; D[p + 1] += (col[1] - D[p + 1]) * a; D[p + 2] += (col[2] - D[p + 2]) * a;
      };
      // toroidal distance — the field must agree across the seam or the grid density steps at the wrap
      const dt = (a, b, m) => { const d = Math.abs(a - b) % m; return Math.min(d, m - d); };

      /* districts: where the light is dense and where it is not. Sampled by everything below. */
      const cores = [];
      for (let i = 0, n = 3 + Math.floor(rnd() * 3); i < n; i++) cores.push({ x: rnd() * w, y: rnd() * h, r: (0.18 + 0.20 * rnd()) * Math.min(w, h), s: 0.5 + rnd() });
      const parks = [];
      for (let i = 0, n = 2 + Math.floor(rnd() * 3); i < n; i++) parks.push({ x: rnd() * w, y: rnd() * h, r: (0.05 + 0.08 * rnd()) * Math.min(w, h) });
      function density(x, y) {
        let v = 0.12;
        for (const k of cores) { const d = Math.hypot(dt(x, k.x, w), dt(y, k.y, h)); v += k.s * Math.max(0, 1 - d / k.r); }
        for (const k of parks) { const d = Math.hypot(dt(x, k.x, w), dt(y, k.y, h)); if (d < k.r) v *= 0.05 + 0.95 * (d / k.r); }
        return Math.min(1.5, v);
      }
      const inPark = (x, y) => parks.some(k => Math.hypot(dt(x, k.x, w), dt(y, k.y, h)) < k.r * 0.9);

      /* THE RIVER — one sine band, periodic in w, that the side streets refuse to cross. Cities
         bend around water, and that bend is most of what stops a lattice reading as graph paper. */
      const rivY = h * (0.2 + 0.6 * rnd()), rivAmp = h * (0.06 + 0.07 * rnd()), rivPh = rnd() * 7, rivHalf = h * (0.02 + 0.016 * rnd());
      const rivAt = x => rivY + rivAmp * Math.sin((x / w) * Math.PI * 2 + rivPh);
      const rivD = (x, y) => Math.abs(((y - rivAt(x)) % h + h * 1.5) % h - h * 0.5);
      const inRiver = (x, y) => rivD(x, y) < rivHalf;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (inPark(x, y)) put(x, y, P.PARK, 0.9);
          const rd = rivD(x, y);
          if (rd < rivHalf + 1) put(x, y, P.WATER, rd < rivHalf ? 1 : 0.5);
        }
      }

      /* ---- the grid: irregular spacing, one in five an arterial ---- */
      const roadsV = [], roadsH = [];
      for (let x = rnd() * 40; x < w - 20; x += 24 + rnd() * 50) roadsV.push({ p: Math.round(x), big: rnd() < 0.2 });
      for (let y = rnd() * 40; y < h - 20; y += 24 + rnd() * 50) roadsH.push({ p: Math.round(y), big: rnd() < 0.2 });

      /* ---- BLOCKS: what stands between the roads. Drawn BEFORE the roads, so the lamps sit on top. ---- */
      const towers = [];
      const xs = roadsV.map(r => r.p), ys = roadsH.map(r => r.p);
      const block = (x0, y0, x1, y1) => {
        const bw = x1 - x0 - 5, bh = y1 - y0 - 5;
        if (bw < 6 || bh < 6) return;
        const bx = x0 + 3, by = y0 + 3, mx = x0 + (x1 - x0) / 2, my = y0 + (y1 - y0) / 2;
        if (inRiver(mx, my) || inPark(mx, my)) return;
        const d = density(mx, my);
        const kind = d > 1.05 && rnd() < 0.8 ? 2 : d > 0.55 ? 1 : 0;
        /* ⛔ ONE PIXEL IS NOT A LIGHT. The first cut of this rebuild scattered 1px windows in two
           colours and the CRT pass (scanlines + chromatic aberration) turned them into coloured
           static — the city read as noise. Every light on this plate is now a 2px DASH, a block
           keeps ONE window colour, and windows sit in ROWS along building edges: structure the
           eye can group, not points it has to average. */
        const dash = (x, y, col, a, vert) => { put(x, y, col, a); put(vert ? x : x + 1, vert ? y + 1 : y, col, a); };
        // a building: a dark roof slab rimmed with windows, the rim brighter on the street side
        const building = (fx0, fy0, fx1, fy1, col, on, gain) => {
          for (let y = fy0; y < fy1; y++) for (let x = fx0; x < fx1; x++) put(x, y, P.ROOF, 1);
          for (let x = fx0 + 1; x < fx1 - 2; x += 3) {
            if (rnd() < on) dash(x, fy0, col, gain * (0.7 + 0.3 * rnd()), false);
            if (rnd() < on) dash(x, fy1 - 1, col, gain * (0.7 + 0.3 * rnd()), false);
          }
          for (let y = fy0 + 1; y < fy1 - 2; y += 3) {
            if (rnd() < on) dash(fx0, y, col, gain * (0.7 + 0.3 * rnd()), true);
            if (rnd() < on) dash(fx1 - 1, y, col, gain * (0.7 + 0.3 * rnd()), true);
          }
        };
        if (kind === 2) {
          // TOWERS: the block is a grid of footprints, cool-white rimmed, a rooftop light on the tall
          const cool = rnd() < 0.8, col = cool ? P.WIN_C : P.WIN_W;
          const cols = Math.max(1, Math.round(bw / 15)), rows = Math.max(1, Math.round(bh / 15));
          const fw = bw / cols, fh = bh / rows;
          for (let r = 0; r < rows; r++) {
            for (let q = 0; q < cols; q++) {
              if (rnd() < 0.10) continue;                           // a vacant lot
              const fx0 = Math.round(bx + q * fw) + 1, fy0 = Math.round(by + r * fh) + 1;
              const fx1 = Math.round(bx + (q + 1) * fw) - 1, fy1 = Math.round(by + (r + 1) * fh) - 1;
              if (fx1 - fx0 < 4 || fy1 - fy0 < 4) continue;
              const tall = rnd() < 0.4;
              building(fx0, fy0, fx1, fy1, col, tall ? 0.85 : 0.6, tall ? 1 : 0.75);
              if (tall) {
                const cx = (fx0 + fx1) >> 1, cy = (fy0 + fy1) >> 1;
                for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) put(cx + ox, cy + oy, P.WIN_HI, 0.9);
                if (rnd() < 0.5) towers.push({ x: cx + 1, y: cy + 1 });
              }
            }
          }
        } else if (kind === 1) {
          // DENSE: low buildings line the streets — a warm rim of windows round the whole block,
          // and a few lit yards inside
          const col = rnd() < 0.9 ? P.WIN_W : P.WIN_C;
          building(bx, by, bx + bw, by + bh, col, 0.45 + 0.45 * Math.min(1, d), 0.95);
          for (let i = 0, n = Math.round(bw * bh / 200 * d); i < n; i++) dash(bx + 2 + rnd() * (bw - 4), by + 2 + rnd() * (bh - 4), col, 0.4 + 0.4 * rnd(), rnd() < 0.5);
        } else {
          // SUBURB: a scatter of warm porch lights, in short rows where a lane runs
          for (let i = 0, n = Math.round(bw * bh / 160 * (0.3 + d)); i < n; i++) dash(bx + rnd() * (bw - 2), by + rnd() * (bh - 2), P.WIN_W, 0.25 + 0.4 * rnd(), false);
        }
      };
      for (let i = 0; i < xs.length; i++) {
        const x0 = xs[i], x1 = i + 1 < xs.length ? xs[i + 1] : xs[0] + w;
        for (let j = 0; j < ys.length; j++) {
          const y0 = ys[j], y1 = j + 1 < ys.length ? ys[j + 1] : ys[0] + h;
          block(x0, y0, x1, y1);
        }
      }

      /* ---- ROADS: the lattice is the subject. A street is a CONTINUOUS line of sodium light (the
              road surface under its lamps — what every satellite night frame actually shows) with
              brighter 2px lamps along it; arterials are two pixels wide, hotter, and bridge the
              river. Side streets stop at the water. Everything dims across parks. ---- */
      const lampStep = 6;
      const lineA = (d, big, park) => Math.min(0.85, (big ? 0.55 : 0.32) * Math.min(1.2, d) + (big ? 0.26 : 0.14)) * (park ? 0.5 : 1);
      const lampA = (d, big, park) => Math.min(1, (big ? 0.80 : 0.65) * Math.min(1.2, d) + (big ? 0.35 : 0.25)) * (park ? 0.5 : 1);
      for (const r of roadsV) {
        const ph = (rnd() * lampStep) | 0;
        for (let y = 0; y < h; y++) {
          if (inRiver(r.p, y) && !r.big) continue;
          const d = density(r.p, y), park = inPark(r.p, y);
          put(r.p, y, P.LAMP, lineA(d, r.big, park)); if (r.big) put(r.p + 1, y, P.LAMP, lineA(d, true, park));
          if ((y + ph) % lampStep === 0) {
            const a = lampA(d, r.big, park);
            put(r.p, y, r.big ? P.LAMP_HI : P.LAMP, a); put(r.p, y + 1, r.big ? P.LAMP_HI : P.LAMP, a * 0.8);
            if (r.big) { put(r.p + 1, y, P.LAMP_HI, a); put(r.p + 1, y + 1, P.LAMP_HI, a * 0.8); }
          }
        }
      }
      for (const r of roadsH) {
        const ph = (rnd() * lampStep) | 0;
        for (let x = 0; x < w; x++) {
          if (inRiver(x, r.p) && !r.big) continue;
          const d = density(x, r.p), park = inPark(x, r.p);
          put(x, r.p, P.LAMP, lineA(d, r.big, park)); if (r.big) put(x, r.p + 1, P.LAMP, lineA(d, true, park));
          if ((x + ph) % lampStep === 0) {
            const a = lampA(d, r.big, park);
            put(x, r.p, r.big ? P.LAMP_HI : P.LAMP, a); put(x + 1, r.p, r.big ? P.LAMP_HI : P.LAMP, a * 0.8);
            if (r.big) { put(x, r.p + 1, P.LAMP_HI, a); put(x + 1, r.p + 1, P.LAMP_HI, a * 0.8); }
          }
        }
      }
      // where two arterials cross: a hot 2x2
      for (const rv of roadsV) {
        if (!rv.big) continue;
        for (const rh of roadsH) {
          if (!rh.big || inRiver(rv.p, rh.p)) continue;
          for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) put(rv.p + ox, rh.p + oy, P.WIN_HI, 0.95);
        }
      }
      // embankments: a lit line along both banks, and the bank lights smeared into the water
      for (let x = 0; x < w; x++) {
        const y = rivAt(x), d = density(x, y);
        for (const s of [-1, 1]) {
          put(x, y + s * (rivHalf + 2), P.LAMP, Math.min(0.7, 0.18 + 0.45 * d));
          if (x % 5 === 0) { put(x, y + s * (rivHalf + 2), P.LAMP_HI, Math.min(0.9, 0.25 + 0.55 * d)); put(x + 1, y + s * (rivHalf + 2), P.LAMP_HI, Math.min(0.9, 0.25 + 0.55 * d) * 0.8); }
        }
      }
      for (let x = 0; x < w; x += 2) {
        const y = rivAt(x), d = density(x, y);
        if (rnd() > 0.5 * d + 0.15) continue;
        const len = 2 + ((rnd() * 4) | 0), s = rnd() < 0.5 ? -1 : 1, col = rnd() < 0.7 ? P.LAMP : P.WIN_C;
        for (let k = 1; k <= len; k++) put(x, y + s * (rivHalf - k), col, (0.10 + 0.14 * d) * (1 - k / (len + 1)));
      }
      c.putImageData(img, 0, 0);

      /* Distance wash. Deliberately WARM, not the blue-grey a daylight haze would be: the only
         thing lighting this air is the city underneath it, so the veil takes the city's colour.
         Thin — the dome below does the glowing; a heavy veil is what buried the first city. */
      hazeOver(c, w, h, P.HAZE, P.HAZE_A);

      /* ---- LIGHT POLLUTION: the orange dome over the dense parts, additive, so it blooms over
              the lattice instead of veiling it. Wide low dome plus a tighter hotter core. ---- */
      const glowCv = mkCv(w, h), gc = glowCv.getContext('2d');
      gc.globalCompositeOperation = 'lighter';
      for (const k of cores) {
        puff9(gc, w, h, k.x, k.y, k.r * 1.3, P.DOME, 0.17 * k.s);
        puff9(gc, w, h, k.x, k.y, k.r * 0.55, P.DOME_HI, 0.13 * k.s);
      }

      /* ---- the cloud deck, underlit by the city (this is the tell that the light is BELOW) ---- */
      const cloudCv = buildPixelClouds(w, h, mulberry32(0xC17914), { spread: 150000, min: 0.035, vary: 1.0, body: P.CLOUD, lit: P.CLOUD_LIT, shade: P.CLOUD, alpha: 0.82, edge: true, rim: 3 });

      /* ---- TRAFFIC on the arterials, and the BEACONS on the tallest towers ---- */
      const traffic = [];
      const bigV = roadsV.filter(r => r.big), bigH = roadsH.filter(r => r.big);
      const carN = Math.min(220, Math.round(area / 15000));
      for (let i = 0; i < carN; i++) {
        const vert = bigV.length && (!bigH.length || rnd() < 0.5);
        const lane = vert ? bigV[Math.floor(rnd() * bigV.length)] : bigH[Math.floor(rnd() * bigH.length)];
        if (!lane) continue;
        traffic.push({ vert, p: lane.p, u: rnd(), spd: (0.010 + 0.022 * rnd()) * (rnd() < 0.5 ? -1 : 1), warm: rnd() < 0.5 });
      }
      const beacons = [];
      for (let i = 0; i < towers.length && beacons.length < 12; i++) {
        const t = towers[Math.floor(rnd() * towers.length)];
        beacons.push({ x: t.x, y: t.y, ph: rnd() * 10, rate: 900 + rnd() * 1800 });
      }

      return { cityCv, glowCv, cloudCv, traffic, beacons };
    },

    draw(ctx, w, h, now, cam, st) {
      const P = CITY_BG.PAL, t = now / 1000;
      const gx = parX(cam, SURF.deck), gy = parY(cam, SURF.deck);
      tile2(ctx, st.cityCv, w, h, gx, gy);

      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.85 + 0.15 * Math.sin(now / 6000);   // the dome breathes very slightly
      tile2(ctx, st.glowCv, w, h, gx, gy);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;

      const still = reduceMotion();
      // traffic — slow, and only on the arterials. Headlights warm one way, tail-lights red the other.
      for (const car of st.traffic) {
        if (!still) { car.u += car.spd / 1000 * 16; if (car.u > 1) car.u -= 1; else if (car.u < 0) car.u += 1; }
        const x = car.vert ? car.p : car.u * w, y = car.vert ? car.u * h : car.p;
        const sx = ((x + gx) % w + w) % w, sy = ((y + gy) % h + h) % h;
        ctx.fillStyle = rgba(car.warm ? P.HEAD : P.TAIL, 0.9);
        ctx.fillRect(sx, sy, car.vert ? 1 : 2, car.vert ? 2 : 1);
      }
      // beacons — out of phase, a red point in a dim halo; steady under reduced motion
      for (const b of st.beacons) {
        if (!still && Math.sin(now / b.rate + b.ph) < 0.35) continue;
        const sx = ((b.x + gx) % w + w) % w, sy = ((b.y + gy) % h + h) % h;
        ctx.fillStyle = rgba(P.BEACON, 0.35); ctx.fillRect(sx - 1, sy - 1, 3, 3);
        ctx.fillStyle = rgba(P.BEACON, 1); ctx.fillRect(sx, sy, 1, 1);
      }

      // the underlit cloud deck, close to the station — again, the parallax gap is the altitude
      ctx.globalAlpha = 0.9;
      tile2(ctx, st.cloudCv, w, h, parX(cam, SURF.cloud) + t * 4.5, parY(cam, SURF.cloud) + t * 1.3);
      ctx.globalAlpha = 1;
    },
  };

  /* ---------------------------------------------------------------------- registry ---- */

  const BACKDROPS = { void: VOID_BG, galaxy: GALAXY_BG, belt: BELT_BG, nursery: NURSERY_BG, ocean: OCEAN_BG, city: CITY_BG };
  const ORDER = ["void", "galaxy", "belt", "nursery", "ocean", "city"];
  const DEFAULT_ID = 'void';

  const has = id => Object.prototype.hasOwnProperty.call(BACKDROPS, id);
  const resolve = id => (has(id) ? id : DEFAULT_ID);

  /* ---------------------------------------------------------------------- dispatch ---- */

  let curId = DEFAULT_ID;
  let st = null;                                     // the built state, or null before first build
  let builtId = '', builtW = 0, builtH = 0;          // WHAT that state was built for
  let pendKey = '', pendAt = 0;                      // resize settling (see draw)

  /* A backdrop may declare `fixedTile()` — a size to build at that ignores the canvas entirely.
     Such a backdrop is built ONCE per session and drawn with tileN(), so a resize reveals more of
     the same sky instead of re-laying it. Use it for anything with a legible SUBJECT (a nebula, a
     body): those layouts are normalised to the tile, so a rebuild moves the subject and a resize
     becomes a re-roll. Fields with no subject (a starfield, a wave deck) can stay canvas-sized —
     re-laying them is invisible, and matching the canvas avoids any repeat. */
  function tileOf(id, w, h) {
    const f = BACKDROPS[id].fixedTile;
    if (!f) return [w, h];
    const s = f();
    // a number is a square tile; a [tw, th] pair is a rectangular one (THE NURSERY's 2:1 band)
    if (Array.isArray(s)) return [Math.max(64, s[0] | 0), Math.max(64, s[1] | 0)];
    return [Math.max(64, s | 0), Math.max(64, s | 0)];
  }

  function rebuild(id, w, h) {
    const [tw, th] = tileOf(id, w, h);
    st = BACKDROPS[id].build(tw, th, mulberry32(SEED));
    builtId = id; builtW = tw; builtH = th;
  }

  /* THROW THE BUILT SKY AWAY so the next draw() re-lays it from scratch.
     Every layer here lives in an offscreen <canvas> built ONCE per session. A GPU/driver reset
     (sleep-wake, display change, TDR, WebView GPU process restart) zeroes the backing store of
     every accelerated 2D canvas in the page — the objects survive at full size, their PIXELS do
     not. Nothing about that is observable from inside `st`, so the cache stays "valid" forever
     and draw() blits transparent plates over the base fill: a starless, nebula-less black sky
     that never recovers. World owns the detection (see its canvas-loss recovery); this is the
     hand-back. Cheap by design — dropping the key is all it takes, the next draw rebuilds. */
  function invalidate() {
    st = null; builtId = ''; builtW = 0; builtH = 0; pendKey = '';
  }

  /* verify/test hook — zero every built plate IN PLACE (objects and sizes intact, pixels gone),
     which is what a GPU reset does and what `invalidate` must be able to undo. Walks whatever
     the backdrop's build() returned, so a new backdrop needs no wiring here. */
  function _dbgLosePixels() {
    let n = 0;
    const seen = new Set();
    const wipe = v => {
      if (!v || seen.has(v) || typeof v !== 'object') return;
      seen.add(v);
      if (typeof HTMLCanvasElement !== 'undefined' && v instanceof HTMLCanvasElement) {
        try { const g = v.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, v.width, v.height); n++; } catch (_) {}
        return;
      }
      if (Array.isArray(v)) { for (const x of v) wipe(x); return; }
      for (const k of Object.keys(v)) wipe(v[k]);
    };
    wipe(st);
    return n;
  }

  /* the whole backdrop, base fill included — callers do NOT pre-fill (identity transform,
     device px). `cam` is the world camera {panX,panY,scale}; omit it and every backdrop
     behaves as if the camera sat at the origin (which is exactly THE VOID's behaviour). */
  function draw(ctx, w, h, now, cam) {
    const id = resolve(curId);
    ctx.fillStyle = BACKDROPS[id].base || '#040302'; ctx.fillRect(0, 0, w, h);
    if (!w || !h) return;

    /* The cache is keyed on the BACKDROP ID as well as the size. Size alone was the original
       design and becomes a trap the moment backdrops are switchable: picking a new one at the
       same canvas size would keep the old tiles and the picker would look broken. */
    if (builtId !== id) {
      // a switch is never a settle case — rebuild now, or the commander watches the old sky
      // sit there for a quarter second after picking a new one.
      rebuild(id, w, h); pendKey = '';
    } else if (BACKDROPS[id].fixedTile) {
      // fixed-tile backdrops never rebuild on a resize — that is the whole point of them
      pendKey = '';
    } else if (builtW !== w || builtH !== h) {
      // a seam-drag streams ResizeObserver sizes — rebuilding the tiles per tick (8k specks +
      // gradients) would jank the drag. Draw the OLD tiles stretched until the size holds ~250ms.
      // But stretching only reads right for SMALL deltas: snapping open from a collapsed stage
      // (canvas floored at 1px) would smear a 1px-wide tile of 'lighter' nebulas + dense dust
      // across the whole sky — a bright flash. Big jumps up (or a degenerate old tile) rebuild NOW.
      const key = w + 'x' + h;
      if (w > builtW * 1.5 || h > builtH * 1.5 || builtW < 48 || builtH < 48) rebuild(id, w, h);
      else if (pendKey !== key) { pendKey = key; pendAt = now; }
      else if (now - pendAt > 250) rebuild(id, w, h);
    } else pendKey = '';

    BACKDROPS[id].draw(ctx, w, h, now, cam, st);
    ctx.globalAlpha = 1;                             // never leak a layer alpha into the world pass
  }

  /* pick the station's backdrop. Returns the id actually in effect (an unknown id falls back
     to the default rather than blanking the sky). Idempotent — re-picking the current one does
     not force a rebuild. */
  function setBackdrop(id) {
    const next = resolve(id);
    if (next !== curId) { curId = next; pendKey = ''; }
    return curId;
  }
  const getBackdrop = () => curId;

  /* the picker's menu, in display order — [{ id, label, blurb }] */
  const list = () => ORDER.map(id => ({ id, label: BACKDROPS[id].label, blurb: BACKDROPS[id].blurb || '' }));

  /* Paint one backdrop into an arbitrary canvas context, off the live selection — this is what
     the picker's swatches use, so a preview is the REAL renderer and can never promise a sky
     the station won't deliver (the same law the deck/wall material swatches follow). Builds a
     throwaway state at the swatch's own size; never touches the live tile cache. */
  /* MEMOISED for the same reason Terrain.paintSample is: every call builds a 960px-wide reference
     sky from scratch, and SETTINGS repaints all six picker swatches on EVERY build of the panel.
     Measured live at 112x63: nursery 54ms, ocean 26ms, city 14ms. The inputs are deterministic
     (fixed SEED, an explicit `now`, no camera, no theme), so a cached chip is bit-identical to a
     fresh render — the swatch is still the REAL renderer's output, never a stand-in. */
  const sampleChips = new Map();
  function paintSample(ctx, w, h, id, now) {
    const bid = resolve(id);
    const bd = BACKDROPS[bid];
    const key = bid + '|' + w + '|' + h + '|' + (now || 0);
    const hit = sampleChips.get(key);
    if (hit) {
      ctx.save();
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(hit, 0, 0);
      ctx.restore();
      ctx.globalAlpha = 1;
      return;
    }
    /* Build at a REFERENCE size and scale DOWN — never build at the swatch's own size. Every
       backdrop scales its content two different ways: counts by area (stars, grain, windows) and
       radii by min(w,h) (nebulas, glint, city cores). Building straight into a 112x63 swatch
       therefore does not produce a miniature, it produces a distorted close-up where a single
       nebula fills the entire sky — measured at mean RGB 85/122/151 against the real void's
       12/13/14. A preview that bright is exactly the lie this function exists to prevent. */
    const RW = 960, RH = Math.max(1, Math.round(RW * (h / w) || RW * 0.5625));
    const off = mkCv(RW, RH), oc = off.getContext('2d');
    oc.fillStyle = bd.base || '#040302';
    oc.fillRect(0, 0, RW, RH);
    bd.draw(oc, RW, RH, now || 0, null, bd.build(RW, RH, mulberry32(SEED)));

    const chip = mkCv(w, h), cc = chip.getContext('2d');
    cc.imageSmoothingEnabled = true;           // a true miniature; NN-crushing a starfield eats the stars
    cc.imageSmoothingQuality = 'high';
    cc.drawImage(off, 0, 0, RW, RH, 0, 0, w, h);
    sampleChips.set(key, chip);

    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(chip, 0, 0);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  return { draw, setBackdrop, getBackdrop, list, paintSample, invalidate, _dbgLosePixels, DEFAULT_ID };
})();
