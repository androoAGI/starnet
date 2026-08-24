/* STARNET — spacebg.js : THE BACKDROP. What the station floats in.

   One shared backdrop for the live world (world.js) AND REFIT (build.js), so entering/exiting
   build mode never jumps the sky. Originally a single hardcoded deep-space field; now a small
   REGISTRY of backdrops the commander picks (station-wide, persisted in the StationUI store).

   THE LAW OF THIS FILE, in order of importance:

   1. THE VOID IS FROZEN. It is the default and it renders byte-identical to what shipped.
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

      /* ---- layer 1: NEBULAS (farthest) ---- */
      const nebCv = mkCv(w, h);
      const nc = nebCv.getContext('2d');
      nc.globalCompositeOperation = 'lighter';         // gas glows additively — overlaps bloom, never mud
      const blobs = area > 2.2e6 ? 4 : 3;
      for (let b = 0; b < blobs; b++) {
        const cx = rnd() * w, cy = h * (0.10 + 0.72 * rnd());
        const R = (0.20 + 0.24 * rnd()) * Math.min(w, h);
        const hue = NEB_HUES[Math.floor(rnd() * NEB_HUES.length) % NEB_HUES.length];
        const acc = NEB_HUES[Math.floor(rnd() * NEB_HUES.length) % NEB_HUES.length];
        for (let p = 0; p < 7; p++) {                  // 7 jittered puffs per cloud → organic, not a perfect disc
          const px = cx + (rnd() - 0.5) * R * 1.3, py = cy + (rnd() - 0.5) * R * 0.9;
          puff(nc, w, px, py, R * (0.35 + 0.45 * rnd()), p < 5 ? hue : acc, 0.06 + 0.05 * rnd());
        }
        puff(nc, w, cx, cy, R * 0.30, hue, 0.16);      // the bright heart of the cloud
        // local star cluster — real nebulas sit in crowded sky
        for (let s = 0, n = 24 + Math.floor(rnd() * 20); s < n; s++) {
          const ang = rnd() * Math.PI * 2, d = rnd() * R;
          nc.fillStyle = 'rgba(220,225,250,' + (0.10 + 0.25 * rnd()).toFixed(3) + ')';
          nc.fillRect(((cx + Math.cos(ang) * d) % w + w) % w, cy + Math.sin(ang) * d * 0.8, 1, 1);
        }
      }
      /* the galactic band: a sine curve periodic in w (wraps seamlessly) — faint glow + dust bias below */
      const bandY = h * (0.22 + 0.5 * rnd()), bandAmp = h * (0.05 + 0.06 * rnd()), bandPh = rnd() * Math.PI * 2;
      const bandHalf = h * 0.11;
      const bandAt = x => bandY + bandAmp * Math.sin((x / w) * Math.PI * 2 + bandPh);
      const bandHue = NEB_HUES[Math.floor(rnd() * NEB_HUES.length) % NEB_HUES.length];
      for (let i = 0; i < 26; i++) {
        const bx = (i / 26) * w + (rnd() - 0.5) * w * 0.03;
        puff(nc, w, bx, bandAt(bx) + (rnd() - 0.5) * bandHalf * 0.8, bandHalf * (1.1 + 0.7 * rnd()), bandHue, 0.028 + 0.022 * rnd());
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
      for (let i = 0; i < nearN; i++) near.push({ x: rnd(), y: rnd(), r: rnd() < 0.6 ? u : u * 2, ph: rnd() * 10, c: pickTint(rnd()), glint: rnd() < 0.08 });

      return { nebCv, dustCv, mid, near };
    },

    draw(ctx, w, h, now, cam, st) {
      const S = VOID_BG.SPD;
      const nx = (now / 1000 * S.neb) % w;             // two-copy wrap scroll, same idiom per layer
      ctx.globalAlpha = 0.9 + 0.1 * Math.sin(now / 7000);   // the gas breathes, slowly
      ctx.drawImage(st.nebCv, nx - w, 0, w, h); ctx.drawImage(st.nebCv, nx, 0, w, h);
      const dx = (now / 1000 * S.dust) % w;
      ctx.globalAlpha = 0.92 + 0.08 * Math.sin(now / 4100);
      ctx.drawImage(st.dustCv, dx - w, 0, w, h); ctx.drawImage(st.dustCv, dx, 0, w, h);
      ctx.globalAlpha = 1;

      for (const s of st.mid) {
        const tw = (0.35 + 0.65 * Math.abs(Math.sin(now / (900 + s.ph * 300) + s.ph))) * VOID_BG.DIM_MID;
        ctx.fillStyle = s.c + tw.toFixed(3) + ')';
        ctx.fillRect((s.x * w + now / 1000 * S.mid) % w, s.y * h, s.r, s.r);
      }
      for (const s of st.near) {
        const tw = (0.35 + 0.65 * Math.abs(Math.sin(now / (900 + s.ph * 300) + s.ph))) * VOID_BG.DIM_NEAR;
        const x = (s.x * w + now / 1000 * S.near) % w, y = s.y * h;
        ctx.fillStyle = s.c + tw.toFixed(3) + ')';
        ctx.fillRect(x, y, s.r, s.r);
        if (s.glint && tw > 0.55) {                    // the brightest few flare into a 4-point glint at twinkle peak
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
  /* A structured emission nebula in a deep, dense starfield.

     THIS IS THE THIRD ATTEMPT AT A SECOND SPACE BACKDROP AND THE FIRST TWO FAILED DIFFERENTLY.
     v1 (DEEP FIELD) reused THE VOID's recipe and bolted on a galaxy and planets — "just the void
     with planets", because that is what it was. v2 over-corrected into a rule: INVERT the void's
     signature. THE VOID is sparse points on black, so v2 filled the frame with gas and cut the
     stars to nine. Andrew, correctly: "it just looks so smudgy... its like purple camo if
     anything. it doesnt look like space."

     He was right on all three counts, and the third is the important one:
       - CAMO is literally what quantized organic noise at a uniform mid-tone looks like. Flat
         bands over a narrow violet palette do not read as gas, they read as fatigues.
       - SMUDGY was the banding. Pixel art renders gradients with DITHER, not flat steps; an
         ordered Bayer threshold gives fine pixel-scale texture where bands give mush.
       - DOES NOT LOOK LIKE SPACE was self-inflicted. Stars are what make space read as space,
         and v2 deleted them to satisfy an abstract rule about being different from the void.

     So the differentiator is NOT the absence of stars or the presence of wall-to-wall gas. It is
     that the nebula is a dramatic, structured SUBJECT with real internal contrast — bright cores,
     hard dark lanes, wispy falloff to black — sitting in a deep starfield, where THE VOID's
     nebulas are faint distant wisps. Black space and stars are part of the look, not the enemy.

     Quality rules this is built on:
       1. STARS FIRST, dense, and gas composites OVER them with per-pixel alpha, so stars shine
          through thin gas and are occluded by dense lanes. That occlusion is a real depth cue.
       2. DITHER, never flat bands (Bayer 4x4 against the quantization step).
       3. WIDE value range — the frame must contain near-black AND near-white, or it is camo.
       4. The gas must NOT cover everything. Falloff to nothing is what gives it a shape. */

  const NURSERY_BG = {
    label: 'THE NURSERY',
    blurb: 'A star factory. Hot cores, cold lanes, and a deep field behind it.',
    base: '#030308',                       // empty space must read BLACK, not faintly violet
    D: { star: 0.012, gas: 0.03, mote: 0.075 },
    // the deep field SWAYS about the framed cloud instead of drifting off it — see draw().
    // x/y are amplitudes in px; sx/sy the periods in seconds (deliberately not a simple ratio).
    SWAY: { x: 46, y: 13, sx: 240, sy: 290 },

    LEVELS: 12,

    /* FIXED TILE — built once, never rebuilt on a resize. The cloud is a legible subject laid out
       in tile-normalised coordinates, so a canvas-sized tile made every resize re-lay it: expanding
       COMMS produced a completely different nebula, and at the new aspect the density peaked over a
       wide area and blew out to white. Square, so aspect never enters into it. Sized to cover the
       display's long edge where it can, which keeps the repeat off-screen at ordinary window sizes;
       the envelope leaves a lot of dark space, so a repeat at the extremes is quiet. */
    fixedTile: () => {
      const scr = (typeof window !== 'undefined' && window.screen) || {};
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const long = Math.max(Number(scr.width) || 0, Number(scr.height) || 0) || 1600;
      return Math.max(1200, Math.min(2048, Math.round(long * Math.min(dpr, 2))));
    },

    LIGHT: {
      // an emission palette with real COLOUR contrast, not one hue at nine brightnesses
      OUT: [13, 9, 27],                   // outermost haze, barely there
      MID: [60, 17, 62],                   // magenta body
      HOT: [125, 38, 69],                  // H-alpha, dense
      /* The top of the GAS ramp is deliberately NOT white. It was [242,214,226] over a band
         starting at t>0.78, and when a density peak covered a wide area the result was a large
         blown-out white patch with the CRT scanlines striping through it. True white belongs only
         to the hot knots and the stars — small, local things. Gas is allowed to be bright; it is
         not allowed to clip. */
      CORE: [164, 123, 139],               // dense ionized core: bright, and still short of white
      TEAL: [23, 80, 97],                 // O-III, a genuinely different hue for contrast
      LANE: [3, 2, 7],                     // cold dust, effectively black
    },

    build(w, h, rnd) {
      const SW = Math.max(1, Math.ceil(w / 2)), SH = Math.max(1, Math.ceil(h / 2));
      const LT = NURSERY_BG.LIGHT, LV = NURSERY_BG.LEVELS;
      const gasCv = mkCv(w, h), gc = gasCv.getContext('2d');

      /* ---- 1. THE DEEP FIELD, on its own FULL-RESOLUTION plate ----
         The gas is built at half res because it is soft and the per-pixel pass is expensive, but
         STARS MUST BE FULL RES. Built at half and upscaled, every star becomes a 2x2 blob instead
         of a crisp point — measurably so: the star detector found ZERO isolated points in a field
         of 5200 stars, because each one had a neighbour of identical value. Soft things can be
         cheap; points of light cannot. */
      const starCv = mkCv(w, h), stc = starCv.getContext('2d');
      stc.fillStyle = '#030308'; stc.fillRect(0, 0, w, h);
      const starN = Math.min(9000, Math.round((w * h) / 165));
      for (let i = 0; i < starN; i++) {
        const x = (rnd() * w) | 0, y = (rnd() * h) | 0;
        const b = rnd();
        if (b < 0.72) {                                   // the faint many
          stc.fillStyle = pickTint(rnd()) + (0.18 + 0.30 * rnd()).toFixed(3) + ')';
          stc.fillRect(x, y, 1, 1);
        } else if (b < 0.965) {                           // the visible few
          stc.fillStyle = pickTint(rnd()) + (0.55 + 0.40 * rnd()).toFixed(3) + ')';
          stc.fillRect(x, y, 1, 1);
        } else {                                          // the bright handful, with spikes
          const a = 0.88 + 0.12 * rnd();
          stc.fillStyle = 'rgba(238,242,255,' + a.toFixed(3) + ')';
          stc.fillRect(x, y, 1, 1);
          stc.fillStyle = 'rgba(238,242,255,' + (a * 0.34).toFixed(3) + ')';
          stc.fillRect(x - 3, y, 7, 1); stc.fillRect(x, y - 3, 1, 7);
        }
      }
      gc.clearRect(0, 0, w, h);                         // the gas plate carries alpha, not a fill

      /* ---- 2. THE NEBULA, composited OVER the stars with per-pixel alpha ----
         Built into its own buffer so it can blend: putImageData replaces pixels and would
         erase the field, so the gas goes onto a scratch canvas and is drawn over. Thin gas
         is translucent (stars shine through), dense gas and lanes are opaque (stars occluded). */
      const d1 = wrapNoise(3, rnd), d2 = wrapNoise(6, rnd), d3 = wrapNoise(13, rnd), d4 = wrapNoise(26, rnd);
      const wxF = wrapNoise(4, rnd), wyF = wrapNoise(4, rnd);
      const shape = wrapNoise(2, rnd);                    // the big envelope: where the cloud IS
      const lane1 = wrapNoise(5, rnd), lane2 = wrapNoise(12, rnd);
      const tealF = wrapNoise(3, rnd);

      /* TWO PASSES, AND THE SECOND ONE IS THE WHOLE FIX (2026-07-25, Andrew: "lets just fix this
         pink nebula" — the screenshot showed a regular cross-hatch mesh over the gas).

         The gas used to be computed AND coloured at half resolution and then blitted up 2x, which
         turned every dither cell into FOUR screen pixels across. At that size an ordered dither
         stops being texture and becomes a window screen. The field itself is smooth and loses
         nothing at half res, so only the quantize/dither/colour step has to be per-screen-pixel:
         one cheap half-res pass does all the noise, one full-res pass does the dither.

         The dither is also now a per-pixel HASH rather than a Bayer matrix. An ordered matrix is
         periodic by construction, so it leaves a visible lattice however small the cell; a hash
         has no repeating structure at any scale and reads as grain, which is what soft gas wants.
         (Ordered dither is still right for hard-edged shading — it is wrong for a smooth volume.)

         Every colour and alpha number below is UNCHANGED from the version in that screenshot.
         Andrew liked everything except the mesh, so the ramp thresholds, the palette and the
         alpha curve are deliberately left alone — this commit must not move the brightness. */
      const fT = new Float32Array(SW * SH), fL = new Float32Array(SW * SH), fC = new Float32Array(SW * SH);
      for (let y = 0, i = 0; y < SH; y++) {
        const v0 = y / SH;
        for (let x = 0; x < SW; x++, i++) {
          const u0 = x / SW;
          const u = u0 + (wxF(u0, v0) - 0.5) * 0.26;      // domain warp -> filaments, not blobs
          const v = v0 + (wyF(u0, v0) - 0.5) * 0.26;
          // ENVELOPE: the cloud has a shape and falls off to nothing. Gas that covers everything
          // is camo; gas with an edge is a subject.
          const env = Math.max(0, Math.min(1, (shape(u0, v0) - 0.54) * 2.4));
          if (env <= 0.001) continue;                     // fT/fL/fC stay 0 here
          const dens = d1(u, v) * 0.46 + d2(u, v) * 0.28 + d3(u, v) * 0.17 + d4(u, v) * 0.09;
          fT[i] = Math.max(0, Math.min(1, (dens - 0.44) * 2.6)) * env;
          fC[i] = Math.max(0, tealF(u * 1.2, v * 1.2) - 0.54) * 2.0;
          fL[i] = Math.max(0, Math.min(1, (lane1(u0 * 1.15, v0 * 1.15) * 0.62 + lane2(u0, v0) * 0.38 - 0.54) * 3.0));
        }
      }
      /* WHERE THE CLOUD IS — so draw() can keep it framed (2026-08-15, Andrew: "the purple nebula
         disappears regularly, can we keep that specifically in frame").
         This tile is deliberately BIGGER than any viewport, so the screen is only ever a window
         onto part of it, and the envelope above leaves a lot of empty tile. Drifting that window
         at 1.1 px/s in x and 0.3 in y meant the subject spent most of a ~107-minute cycle
         completely off-screen: measured over one full cycle at 1440x900, gas coverage of the frame
         ran 0.04 -> 0.35, i.e. stretches of many minutes with nothing but stars.
         The tile is a TORUS, so a plain centroid of the density is meaningless — a cloud straddling
         the seam averages out to the empty middle. Take the CIRCULAR mean instead: read each axis
         as an angle, sum the density as unit vectors, convert the resultant angle back to a
         coordinate. `r` is the resultant LENGTH, i.e. how concentrated the gas is; if a future tune
         ever spreads the gas evenly over the tile there is no subject to frame and draw() falls
         back to the plain offset rather than pinning to a meaningless point. */
      let cxs = 0, sxs = 0, cys = 0, sys = 0, mass = 0;
      for (let y = 0, i = 0; y < SH; y++) {
        const ay = (y / SH) * Math.PI * 2, cay = Math.cos(ay), say = Math.sin(ay);
        for (let x = 0; x < SW; x++, i++) {
          const d = fT[i];
          if (d <= 0) continue;
          const ax = (x / SW) * Math.PI * 2;
          cxs += d * Math.cos(ax); sxs += d * Math.sin(ax);
          cys += d * cay; sys += d * say;
          mass += d;
        }
      }
      const turn = (c, s) => { const a = Math.atan2(s, c); return (a < 0 ? a + Math.PI * 2 : a) / (Math.PI * 2); };
      const focus = mass > 0
        ? { x: turn(cxs, sxs) * w, y: turn(cys, sys) * h,
            r: Math.min(Math.hypot(cxs, sxs), Math.hypot(cys, sys)) / mass }
        : { x: 0, y: 0, r: 0 };

      // deterministic per-pixel dither offset in [-0.5,0.5) — same pixel, same grain, every build
      const dith = (x, y) => {
        let k = Math.imul(x + 0x1F123BB5, 0x27D4EB2D) ^ Math.imul(y + 0x68E31DA4, 0x165667B1);
        k = Math.imul(k ^ (k >>> 15), 0x2C1B3C6D);
        return (((k ^ (k >>> 12)) >>> 0) / 4294967296) - 0.5;
      };
      // bilinear sample of a half-res field, wrapping — the tile is a torus
      const samp = (F, fx, fy) => {
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        const xa = ((x0 % SW) + SW) % SW, ya = ((y0 % SH) + SH) % SH;
        const xb = (xa + 1) % SW, yb = (ya + 1) % SH;
        const top = F[ya * SW + xa] + (F[ya * SW + xb] - F[ya * SW + xa]) * tx;
        const bot = F[yb * SW + xa] + (F[yb * SW + xb] - F[yb * SW + xa]) * tx;
        return top + (bot - top) * ty;
      };

      const scratch = mkCv(w, h), sc2 = scratch.getContext('2d');
      const img = sc2.createImageData(w, h), D = img.data;
      let p = 0;
      for (let y = 0; y < h; y++) {
        const fy = y * 0.5;
        for (let x = 0; x < w; x++) {
          const fx = x * 0.5;
          let t = samp(fT, fx, fy);
          if (t <= 0.035) { D[p + 3] = 0; p += 4; continue; }   // thin gas is NOTHING, not a veil
          t = Math.max(0, Math.min(1, Math.round((t + dith(x, y) / LV) * LV) / LV));
          if (t <= 0) { D[p + 3] = 0; p += 4; continue; }

          // COLOUR: a wide ramp ending near white, plus a teal region for hue contrast
          let col;
          // the core band now opens at 0.88, not 0.78 — the brightest gas is the top TWELVE
          // per cent of the range instead of the top fifth, so it cannot cover a wide area
          if (t < 0.40) col = mix3(LT.OUT, LT.MID, t / 0.40);
          else if (t < 0.88) col = mix3(LT.MID, LT.HOT, (t - 0.40) / 0.48);
          else col = mix3(LT.HOT, LT.CORE, (t - 0.88) / 0.12);
          const teal = samp(fC, fx, fy);
          if (teal > 0) col = mix3(col, LT.TEAL, Math.min(0.7, teal) * (1 - t * 0.5));

          // DUST LANES: hard, near-black, and they bite INTO the cloud. This is the structure.
          const dark = samp(fL, fx, fy);
          /* NO ALPHA FLOOR. It used to be 0.10 + 0.90*t, so every pixel inside the envelope got
             a 10% violet wash whatever its density — 62% of the frame was faint tinted haze and
             the starfield never got any clean black back. Gas now fades to actual nothing. */
          let alpha = t < 0.85 ? t * 1.05 : 0.89 + (t - 0.85) * 0.73;
          if (dark > 0) { col = mix3(col, LT.LANE, dark); alpha = Math.min(1, alpha + dark * 0.55); }

          D[p] = col[0]; D[p + 1] = col[1]; D[p + 2] = col[2];
          D[p + 3] = Math.round(255 * Math.min(1, alpha));
          p += 4;
        }
      }
      sc2.putImageData(img, 0, 0);
      gc.drawImage(scratch, 0, 0);

      /* ---- 3. HOT KNOTS — small, very bright, additive. Young stars still inside their gas.
              These carry the top of the value range and give the eye somewhere to land.

              DIMMED 2026-08-16 (Andrew, pointing at two of them: "i dont like how bright these
              stars are can we dim them a bit"). They read as STARS rather than as ionized cores
              because the placement gate below (shape >= 0.46) is looser than the gas envelope
              (shape >= 0.54 in the density pass), so a knot can land on bare black with no cloud
              around it — and a big additive halo on black is a star, whatever it was meant to be.
              The halo and its white centre are scaled to ~0.6x together, AS A SET: dimming the
              wide halo while leaving the white centre hot would keep the pop-out and just shrink
              the glow, which is the same read at a smaller size. The 1px core stays near-full —
              it is a point of light, and points of light are allowed to be bright (law 3 of this
              backdrop still wants near-white somewhere in the frame). */
      gc.globalCompositeOperation = 'lighter';
      for (let i = 0, n = 5 + Math.floor(rnd() * 5); i < n; i++) {
        const sx = rnd() * w, sy = rnd() * h;
        if (shape(sx / w, sy / h) < 0.46) continue;        // only where the cloud actually is
        const R = Math.min(w, h) * (0.03 + 0.055 * rnd());
        puff9(gc, w, h, sx, sy, R, rnd() < 0.5 ? [190, 110, 130] : [120, 150, 220], 0.10 + 0.06 * rnd());
        puff9(gc, w, h, sx, sy, R * 0.28, [255, 246, 250], 0.13);
        gc.fillStyle = 'rgba(255,250,255,0.88)';
        gc.fillRect(sx | 0, sy | 0, 1, 1);
      }
      gc.globalCompositeOperation = 'source-over';

      /* ---- 4. foreground motes: cold, near, and dark — depth without more bright points ---- */
      const moteCv = mkCv(w, h), mc = moteCv.getContext('2d');
      const moteN = Math.min(1800, Math.round((w * h) / 4200));
      for (let i = 0; i < moteN; i++) {
        mc.fillStyle = 'rgba(2,2,6,' + (0.22 + 0.42 * rnd()).toFixed(3) + ')';
        mc.fillRect((rnd() * w) | 0, (rnd() * h) | 0, rnd() < 0.8 ? 1 : 2, 1);
      }

      return { starCv, gasCv, moteCv, focus };
    },

    draw(ctx, w, h, now, cam, st) {
      const D = NURSERY_BG.D, t = now / 1000;
      /* tileN, not tile2 — the plates are a FIXED square, independent of this canvas, so they have
         to be repeated across whatever viewport they are handed. Field first, cloud over it at the
         SAME offset: they are at one distance and must not slide apart. The gas plate carries
         alpha, so thin gas lets the field through and dense gas and dust lanes occlude it. */
      const TW = st.starCv.width, TH = st.starCv.height;
      /* THE SUBJECT STAYS FRAMED. These plates used to drift (`+ t * 1.1`, `+ t * 0.3`), which on a
         tile larger than the viewport is not "the sky moves" but "the window walks off the cloud" —
         and it took ~107 minutes to walk back. The nebula is the whole point of this backdrop, so
         the offset now PINS its centre (see build()'s focus) to the centre of the frame and only
         SWAYS about it: two slow, out-of-phase waves so the drift never repeats on an obvious beat,
         with peak speeds ~1.2 and ~0.3 px/s — the same rates the old drift ran at, so the motion
         reads exactly as before. It simply stops accumulating.
         Camera parallax is unchanged and still added on top: the field is at a finite distance, so
         panning the station must still slide it (law 2). The motes below keep their own drift —
         they are foreground grain with no subject to lose. */
      const F = st.focus || { x: 0, y: 0, r: 0 };
      const S = NURSERY_BG.SWAY;
      const pinX = F.r > 0.08 ? w / 2 - F.x : 0, pinY = F.r > 0.08 ? h / 2 - F.y : 0;
      const ox = parX(cam, D.gas) + pinX + S.x * Math.sin(t / S.sx * Math.PI * 2);
      const oy = parY(cam, D.gas) + pinY + S.y * Math.sin(t / S.sy * Math.PI * 2);
      tileN(ctx, st.starCv, TW, TH, w, h, ox, oy);
      tileN(ctx, st.gasCv, TW, TH, w, h, ox, oy);
      ctx.globalAlpha = 0.8;
      tileN(ctx, st.moteCv, TW, TH, w, h, parX(cam, D.mote) + t * 5, parY(cam, D.mote) + t * 1.5);
      ctx.globalAlpha = 1;
      drawMeteor(ctx, w, h, now);
      drawBolide(ctx, w, h, now);
    },
  };



  /* ------------------------------------------------------- shared: SURFACE backdrops ---- */
  /* Everything the station can float ABOVE (ocean, city, and whatever comes next) shares the
     same three problems, so they share the same three helpers: a deck of drifting cloud, a
     haze that kills contrast with distance, and the parallax depths that put them in order.

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

  /* One toroidal deck of soft cloud. Returns a canvas to be tiled at SURF.cloud. `dark` builds
     the SHADOW deck instead (the same shapes in negative) — shadows belong to clouds, so the
     two decks drift together and the shadow deck rides the SURFACE depth, not the cloud depth. */
  function buildCloudDeck(w, h, rnd, opts) {
    const o = opts || {};
    const cv = mkCv(w, h), c = cv.getContext('2d');
    const n = Math.max(5, Math.round((w * h) / (o.spread || 190000)));
    const tint = o.tint || [235, 244, 255];
    for (let i = 0; i < n; i++) {
      const cx = rnd() * w, cy = rnd() * h;
      const R = (o.min || 0.06) * Math.min(w, h) + rnd() * (o.vary || 0.10) * Math.min(w, h);
      // a cloud is a clump of puffs, never one disc — 5-9 lobes with a flattened, wind-sheared spread
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
  /* A city at night from altitude: a lattice of light, arterials, and the orange dome of its own
     light pollution. Roads are axis-aligned on purpose — that is both what most cities look like
     from directly above AND the only thing that tiles seamlessly on a torus (a diagonal only
     wraps if its slope is rational in w/h; the river gets the sine treatment instead). */

  const CITY_BG = {
    label: 'NIGHT CITY',
    blurb: 'Somewhere with power. A grid of light, far below.',
    base: '#06050a',

    build(w, h, rnd) {
      const area = w * h;
      const cityCv = mkCv(w, h), c = cityCv.getContext('2d');
      c.fillStyle = '#0a0810'; c.fillRect(0, 0, w, h);

      /* districts: where the light is dense and where it is not. Sampled by everything below,
         so parks, industry and downtown all fall out of one field instead of three systems. */
      const cores = [];
      for (let i = 0, n = 3 + Math.floor(rnd() * 3); i < n; i++) cores.push({ x: rnd() * w, y: rnd() * h, r: (0.18 + 0.20 * rnd()) * Math.min(w, h), s: 0.5 + rnd() });
      const darks = [];
      for (let i = 0, n = 2 + Math.floor(rnd() * 3); i < n; i++) darks.push({ x: rnd() * w, y: rnd() * h, r: (0.06 + 0.10 * rnd()) * Math.min(w, h) });
      // toroidal distance — the field must agree across the seam or the grid density steps at the wrap
      const dt = (a, b, m) => { const d = Math.abs(a - b) % m; return Math.min(d, m - d); };
      function density(x, y) {
        let v = 0.12;
        for (const k of cores) { const d = Math.hypot(dt(x, k.x, w), dt(y, k.y, h)); v += k.s * Math.max(0, 1 - d / k.r); }
        for (const k of darks) { const d = Math.hypot(dt(x, k.x, w), dt(y, k.y, h)); if (d < k.r) v *= 0.10 + 0.9 * (d / k.r); }
        return Math.min(1.4, v);
      }

      /* THE RIVER — one sine band, periodic in w, that the grid refuses to cross. Cities bend
         around water, and that bend is most of what stops a lattice reading as graph paper. */
      const rivY = h * (0.2 + 0.6 * rnd()), rivAmp = h * (0.06 + 0.07 * rnd()), rivPh = rnd() * 7, rivHalf = h * (0.018 + 0.016 * rnd());
      const rivAt = x => rivY + rivAmp * Math.sin((x / w) * Math.PI * 2 + rivPh);
      const inRiver = (x, y) => { const d = Math.abs(((y - rivAt(x)) % h + h * 1.5) % h - h * 0.5); return d < rivHalf; };

      /* ---- the grid: irregular spacing, brightness by district ---- */
      const roadsV = [], roadsH = [];
      for (let x = rnd() * 40; x < w; x += 26 + rnd() * 46) roadsV.push({ p: x, big: rnd() < 0.22 });
      for (let y = rnd() * 40; y < h; y += 26 + rnd() * 46) roadsH.push({ p: y, big: rnd() < 0.22 });

      const lampStep = 7;
      for (const r of roadsV) {
        for (let y = 0; y < h; y += lampStep) {
          if (inRiver(r.p, y)) continue;
          const d = density(r.p, y);
          if (rnd() > d * 0.85) continue;
          const a = Math.min(0.85, (r.big ? 0.42 : 0.24) * d + 0.06);
          c.fillStyle = 'rgba(255,196,120,' + a.toFixed(3) + ')';
          c.fillRect(r.p, y, r.big ? 2 : 1, 2);
        }
      }
      for (const r of roadsH) {
        for (let x = 0; x < w; x += lampStep) {
          if (inRiver(x, r.p)) continue;
          const d = density(x, r.p);
          if (rnd() > d * 0.85) continue;
          const a = Math.min(0.85, (r.big ? 0.42 : 0.24) * d + 0.06);
          c.fillStyle = 'rgba(255,196,120,' + a.toFixed(3) + ')';
          c.fillRect(x, r.p, 2, r.big ? 2 : 1);
        }
      }

      /* ---- windows: the fill light between the roads. Cooler than the sodium streets. ---- */
      const winN = Math.min(20000, Math.round(area / 420));
      for (let i = 0; i < winN; i++) {
        const x = rnd() * w, y = rnd() * h;
        if (inRiver(x, y)) continue;
        const d = density(x, y);
        if (rnd() > d * 0.55) continue;
        const warm = rnd() < 0.72;
        c.fillStyle = warm
          ? 'rgba(255,214,150,' + (0.10 + 0.5 * rnd() * d).toFixed(3) + ')'
          : 'rgba(180,220,255,' + (0.10 + 0.4 * rnd() * d).toFixed(3) + ')';
        c.fillRect(x, y, 1, 1);
      }

      /* ---- the river answers the city back: a dim reflected smear, no lamps of its own ---- */
      for (let x = 0; x < w; x += 3) {
        const y = rivAt(x), d = density(x, y);
        c.fillStyle = 'rgba(120,140,190,' + (0.03 + 0.05 * d * rnd()).toFixed(3) + ')';
        c.fillRect(x, ((y + (rnd() - 0.5) * rivHalf * 1.6) % h + h) % h, 2, 1);
      }

      /* ---- LIGHT POLLUTION: the orange dome over the dense parts. Drawn additively so it
              blooms over the lattice instead of veiling it. ---- */
      const glowCv = mkCv(w, h), gc = glowCv.getContext('2d');
      gc.globalCompositeOperation = 'lighter';
      // two passes: a wide low dome plus a tighter hotter core, so downtown reads hotter than
      // the suburbs instead of the whole map sharing one flat orange.
      for (const k of cores) {
        puff9(gc, w, h, k.x, k.y, k.r * 1.25, [255, 148, 58], 0.10 * k.s);
        puff9(gc, w, h, k.x, k.y, k.r * 0.55, [255, 186, 96], 0.09 * k.s);
      }

      /* ---- cloud deck, underlit by the city (this is the tell that the light is BELOW) ---- */
      const cloudCv = buildCloudDeck(w, h, mulberry32(0xC17914), { spread: 165000, min: 0.05, vary: 0.10, alpha: 0.13, tint: [255, 176, 110] });

      /* ---- TRAFFIC: live dots that run the arterials. The only moving thing down there. ---- */
      const traffic = [];
      const bigV = roadsV.filter(r => r.big), bigH = roadsH.filter(r => r.big);
      const carN = Math.min(180, Math.round(area / 18000));
      for (let i = 0; i < carN; i++) {
        const vert = bigV.length && (!bigH.length || rnd() < 0.5);
        const lane = vert ? bigV[Math.floor(rnd() * bigV.length)] : bigH[Math.floor(rnd() * bigH.length)];
        if (!lane) continue;
        traffic.push({
          vert, p: lane.p, u: rnd(), spd: (0.010 + 0.022 * rnd()) * (rnd() < 0.5 ? -1 : 1),
          warm: rnd() < 0.5,
        });
      }

      /* Distance wash. Deliberately WARM, not the blue-grey a daylight haze would be: the only
         thing lighting this air is the city underneath it, so the veil takes the city's colour.
         A cool wash here measured blue-dominant overall and read as generic night, not sodium. */
      hazeOver(c, w, h, [58, 34, 28], 0.13);

      return { cityCv, glowCv, cloudCv, traffic };
    },

    draw(ctx, w, h, now, cam, st) {
      const t = now / 1000;
      const gx = parX(cam, SURF.deck), gy = parY(cam, SURF.deck);
      tile2(ctx, st.cityCv, w, h, gx, gy);

      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.85 + 0.15 * Math.sin(now / 6000);   // the dome breathes very slightly
      tile2(ctx, st.glowCv, w, h, gx, gy);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;

      // traffic — slow, and only on the arterials. Headlights warm one way, tail-lights red the other.
      for (const car of st.traffic) {
        car.u += car.spd / 1000 * 16;                 // ~frame-rate independent enough for a 1px dot
        if (car.u > 1) car.u -= 1; else if (car.u < 0) car.u += 1;
        const x = car.vert ? car.p : car.u * w, y = car.vert ? car.u * h : car.p;
        const sx = ((x + gx) % w + w) % w, sy = ((y + gy) % h + h) % h;
        ctx.fillStyle = car.warm ? 'rgba(255,236,190,0.85)' : 'rgba(255,120,90,0.75)';
        ctx.fillRect(sx, sy, 1, 1);
      }

      // the underlit cloud deck, close to the station — again, the parallax gap is the altitude
      ctx.globalAlpha = 0.82;
      tile2(ctx, st.cloudCv, w, h, parX(cam, SURF.cloud) + t * 4.5, parY(cam, SURF.cloud) + t * 1.3);
      ctx.globalAlpha = 1;
    },
  };

  /* ---------------------------------------------------------------------- registry ---- */

  const BACKDROPS = { void: VOID_BG, nursery: NURSERY_BG, ocean: OCEAN_BG, city: CITY_BG };
  const ORDER = ["void", "nursery", "ocean", "city"];
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
