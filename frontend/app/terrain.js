/* STARNET — terrain.js : THE GROUND. What the station is standing ON.

   THIS IS NOT A BACKDROP, AND THE DIFFERENCE IS THE WHOLE POINT.

   spacebg.js draws things at a DISTANCE, in screen space, deliberately not zooming — correct for
   a starfield or a sea a long way below. Terrain is at the SAME PLANE as the station: it must pan
   AND zoom with it, or the illusion dies on the first scroll-wheel tick. The camera zooms 0.5x to
   6x (world.js MINZ/MAXZ), a 12x range, so faking that in screen space would fall apart violently.

   So the ground is drawn in WORLD space, between world.js's setTransform() and the station bake.
   At that seam the camera transform is already applied, which means panning, zooming and the
   station's own coordinate frame all come for free — no parallax maths, no toroidal wrap, no
   camera plumbing.

   THREE layers, because they fail differently:
     1. THE PATCH — soil, moss, litter. Fine texture, tiled with createPattern (ONE fillRect, not
        hundreds of drawImage). Fine texture can repeat every few hundred pixels invisibly.
     2. THE FIELD — a world-space value noise that decides how much grows WHERE. This is what the
        first forest lacked: it scattered trees at a flat 38% everywhere, so the eye read an even
        stipple with no groves, no glades and no edges. Density variation is structure, and
        structure is most of what "detailed" actually means.
     3. THE SCATTER — trees, logs, ferns, boulders. These CANNOT tile: a repeating tree is
        instantly legible as wallpaper. They are placed by hashing world cell coordinates, which
        gives an infinite non-repeating field with no stored map, drawn from pre-rendered sprites
        so a crown costs one drawImage rather than four hundred stamps every frame.

   The station stands in a CLEARING: scatter is suppressed inside the station's world rect plus a
   margin, and thickened just outside it, because a real clearing has a dense edge.

   WHY THE FIRST FOREST WAS SCRAPPED (2026-07-24, Andrew: "too blurry… just looks like an outline
   of a forest") and what is different here:
     - Crowns were 8 overlapping anti-aliased arcs. A blob with a lit rim IS an outline. Crowns are
       now built from hundreds of hard 1-3px LEAF STAMPS lit by a dome+sun term, with holes punched
       through them, so the mass has interior texture and the ground shows through it.
     - One species. There are now five silhouettes (broadleaf, conifer, birch, snag, sapling) and a
       conifer does not read as a maple from any distance.
     - No layering. Items are y-sorted and overlap, which is the only cue that says "canopy" rather
       than "stickers".
     - Flat lighting. A tiled DAPPLE pass now puts sun through the canopy onto the floor, so the
       floor has large-scale light structure instead of uniform noise. */
'use strict';

const Terrain = (typeof document === 'undefined') ? { active: () => false } : (() => {

  /* ---------------------------------------------------------------- shared helpers ---- */

  const TAU = Math.PI * 2;
  const mkCv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const rgba = (c, a) => 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + (+a).toFixed(3) + ')';
  const rgb = c => 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

  /* Sample a colour RAMP (array of rgb triples) at t in [0,1] — quantized to the ramp's own
     entries, never interpolated. Interpolation is what makes pixel art look like a photograph:
     every neighbouring pixel differs slightly, so nothing has an edge. Flat bands have edges. */
  const ramp = (R, t) => R[Math.max(0, Math.min(R.length - 1, Math.round(clamp01(t) * (R.length - 1))))];

  /* Sample a ramp with HASH DITHERING between the two adjacent steps.
     Rounding to the nearest step draws a hard contour wherever the underlying field crosses a
     boundary, and those contours are shaped like the field's low-frequency octave — which is
     exactly how a grey plain turns into CAMOUFLAGE. Dithering replaces each contour with a
     probabilistic mix of the two neighbouring colours: the palette stays quantized (still pixel
     art, still flat bands) but the band EDGES stop being drawn. It is the oldest trick in the
     medium and it is the difference between regolith and a pattern of continents. */
  function dither(R, t, x, y, k) {
    const f = clamp01(t) * (R.length - 1);
    let i = Math.floor(f);
    if (h01(x, y, k) < f - i) i++;
    return R[Math.max(0, Math.min(R.length - 1, i))];
  }

  /* HARD-EDGE a sprite: snap every pixel's alpha to fully on or fully off.
     Canvas path fills (arc, ellipse) are ALWAYS anti-aliased — there is no flag to turn it off —
     so anything drawn from paths carries a soft fringe, and the world transform then blows that
     fringe up by the zoom factor. At 4x a one-pixel fringe becomes a four-pixel smear, which is
     exactly the "blurry" this exists to kill. Everything a sprite wants to keep must be drawn
     OPAQUE — anything translucent is erased by this pass, by design. */
  function hardEdge(cv) {
    const c = cv.getContext('2d');
    const img = c.getImageData(0, 0, cv.width, cv.height), d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
    c.putImageData(img, 0, 0);
    return cv;
  }

  function mulberry32(seed) {
    let a = seed | 0;
    return () => {
      a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* A stable hash of a world CELL -> [0,1). ALLOCATION-FREE on purpose: the draw loop calls this
     tens of thousands of times a frame at low zoom, and the old closure-per-cell version handed
     the GC a bag of garbage every frame for no reason. */
  function h01(cx, cy, k) {
    let h = Math.imul(cx | 0, 374761393) ^ Math.imul(cy | 0, 668265263) ^ Math.imul(k | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /* Value noise over the INFINITE world lattice (not a wrapping tile). This is THE FIELD: it says
     where the forest is thick and where it opens out. Smoothstep interpolation, hashed corners —
     nothing stored, identical every visit. */
  function vnoise(x, y, k) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = h01(ix, iy, k), b = h01(ix + 1, iy, k);
    const c = h01(ix, iy + 1, k), d = h01(ix + 1, iy + 1, k);
    const top = a + (b - a) * sx, bot = c + (d - c) * sx;
    return top + (bot - top) * sy;
  }

  /* value noise on an N x N lattice, WRAPPING — for anything that must tile seamlessly (the patch,
     the dapple, per-sprite hole masks). Seamless by construction, never by touch-up. */
  function noiseField(N, rnd) {
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

  /* THE SUN. One direction for every shadow, every lit rim, every facet, in every ground. Light
     comes from the top-left, which is what the station's own props already assume. */
  const SUN = { x: -0.7071, y: -0.7071 };

  /* ------------------------------------------------------------------ GROUND: FOREST ---- */
  /* FOREST v5 — the DETAIL pass on v4 (Andrew, 2026-09-10, on v4: "no trees and the wilderness need
     more detail it can be definitely wayyyy more detailed"). The key stays: dark, mysterious,
     realistic, an aerial map of old growth (v4's brief: "dark, mysterious gorgeous forest vibe,
     like ur looking down from a map of a forest. Realistic" — after v3's flat-tone crowns, lit
     grass and flowers were rejected as "a cartoon world").

     THE FORESTS BEFORE IT, and what each taught:
       v1 (07-24): anti-aliased arcs — "too blurry... an outline of a forest". Edges must be hard.
       v2 (07-24 → 09-09): hard leaf stamps over dark duff. Right key; at play zoom, 2x2 confetti.
       v3 (09-09): flat four-tone crowns on lit grass — legible, and a cartoon.
       v4 (09-10): dome-shaded crowns through dithered satellite-green ramps, black gaps, dark
           floor, black water. Right key and right read — and every crown was one smooth dome,
           the floor bare, the undergrowth thin. Detail is where realism actually lives.

     WHAT DETAIL MEANS HERE (all of it hard pixels, all of it dark-keyed):
       1. A CROWN IS CLUSTERS OF CLUSTERS. Two levels of sub-domes — big lobes and small lobelets —
          each with its own lit side, so a crown is a cauliflower of leaf masses, not a ball. Where
          two big lobes meet there is a dark SEAM (the branch gap between them), and on the sun side
          of the lobelets the top ramp step sparkles: individual lit leaf clusters. The outline is
          roughened by a fine noise so no crown edge is ever a clean curve.
       2. CONIFERS SHOW THEIR WHORLS. A spruce from above is a wheel of branches: the sawtooth
          outline now carries the same rhythm INSIDE — ridges lit, valleys dark — round a bright apex.
       3. THE WILDERNESS IS THICK. Undergrowth density is doubled and varied — ferns, dark bushes,
          saplings, fallen branches, mossed logs, stumps, boulders, mushroom clusters — and it now
          grows in the station's clearing margin too (never under the floor plan), because play
          zoom looks at exactly that ground.
       4. THE FLOOR IS A FLOOR. Leaf litter with shape, pine-needle drifts, small plants, moss with
          texture, roots, twigs, stones, puddles in the wet — under a dark key, in a narrow range.
       5. THE RIVER HAS BANKS: gravel, rocks breaking the surface, a faint sheen.
     Scale reference (measured, unchanged): an agent body is ~35 world px, ONE WORLD PIXEL ≈ 5cm. */

  const FOREST = {
    label: 'FOREST',
    blurb: 'Landed in old growth. Dark canopy, black water, no one around.',
    base: '#0c130e',
    PATCH: 512,                       // world px of the tiling floor texture
    CELL: 48,                         // world px per scatter cell — dense canopy needs a fine grid
    BODY_PX: 35.42,                   // an agent body, world px — the yardstick for everything here
    STREAM: { W: 320, H: 320, LANE: 1100, P: 0.4 },   // lane 0 always runs; the rest are rare

    LIGHT: {
      /* eight-step ramps, dark end to lit top. Shade is cool, the lit top faintly warm. The range
         is the read: near-black gaps, climbing tops, a low mean. */
      LEAF: [[8, 14, 10], [13, 22, 15], [19, 32, 21], [27, 45, 28], [37, 60, 35], [50, 78, 43], [66, 98, 52], [88, 124, 64]],
      CONIFER: [[4, 10, 10], [8, 17, 16], [13, 26, 23], [18, 36, 30], [25, 47, 39], [34, 60, 48], [46, 76, 58], [64, 98, 72]],
      ASH: [[11, 18, 12], [18, 28, 18], [26, 41, 25], [37, 56, 34], [50, 74, 43], [64, 94, 52], [82, 116, 62], [106, 142, 76]],
      DEAD: [[18, 16, 13], [30, 26, 20], [44, 39, 30], [60, 53, 41]],
      SHADOW: [5, 9, 7],                                           // cast shade: near-black, green-cold
      DUFF: [[8, 10, 7], [12, 14, 10], [16, 20, 13], [21, 26, 16], [27, 33, 20], [34, 42, 25]],
      MOSS: [[14, 24, 14], [19, 32, 18], [25, 42, 23], [32, 52, 28], [40, 62, 33]],
      LITTER: [[24, 19, 13], [34, 27, 18], [46, 37, 24], [60, 48, 30], [76, 60, 36]],
      NEEDLE: [[16, 18, 12], [22, 25, 16], [30, 33, 21]],
      PLANT: [[16, 30, 16], [24, 44, 22], [34, 58, 28], [46, 74, 34]],
      ROOT: [[22, 18, 13], [34, 28, 20], [48, 40, 28]],
      STONE: [[26, 28, 26], [40, 42, 40], [56, 58, 54], [74, 76, 70]],
      TRUNK: [34, 26, 18], TRUNK_HI: [50, 40, 28], PALE: [76, 72, 62], CAP: [112, 100, 84],
      WATER: [[8, 14, 20], [14, 24, 32], [22, 38, 50]], SHEEN: [44, 68, 84], PUDDLE: [12, 18, 24],
      BANK: [12, 16, 11], BANK_WET: [26, 22, 15], GRAVEL: [[34, 32, 28], [48, 45, 38], [62, 58, 48]],
    },

    /* ---- the tiling floor: shaded duff, moss, litter, needles, plants, roots, stones, puddles ---- */
    buildPatch(rnd) {
      const P = FOREST.PATCH, LT = FOREST.LIGHT;
      const cv = mkCv(P, P), c = cv.getContext('2d');
      const img = c.createImageData(P, P), D = img.data;
      const idx = (x, y) => (((((y | 0) % P) + P) % P) * P + ((((x | 0) % P) + P) % P)) * 4;
      const put = (x, y, col) => { const i = idx(x, y); D[i] = col[0]; D[i + 1] = col[1]; D[i + 2] = col[2]; };
      const shade = (x, y, f) => { const i = idx(x, y); D[i] *= f; D[i + 1] *= f + (1 - f) * 0.25; D[i + 2] *= f; };
      // 1. duff: three octaves and a hash, dithered onto the ramp — tooth, no banding
      const g1 = noiseField(5, rnd), g2 = noiseField(17, rnd), g3 = noiseField(53, rnd);
      const wet = noiseField(7, rnd), mclump = noiseField(41, rnd), ndrift = noiseField(9, rnd), nang = noiseField(5, rnd);
      let p = 0;
      for (let y = 0; y < P; y++) {
        for (let x = 0; x < P; x++, p += 4) {
          const u = x / P, v = y / P;
          const t = g1(u, v) * 0.40 + g2(u, v) * 0.30 + g3(u, v) * 0.18 + h01(x, y, 5) * 0.12;
          const col = dither(LT.DUFF, t * 1.15 - 0.08, x, y, 13);
          D[p] = col[0]; D[p + 1] = col[1]; D[p + 2] = col[2]; D[p + 3] = 255;
        }
      }
      // 2. moss, stippled where it is damp, with clump texture — density fades to nothing
      for (let y = 0; y < P; y++) {
        for (let x = 0; x < P; x++) {
          const u = x / P, v = y / P, dens = clamp01((wet(u, v) - 0.48) * 3.0);
          if (dens <= 0) continue;
          const cl = mclump(u, v);
          if (h01(x, y, 29) > dens * (0.3 + 0.9 * cl)) continue;
          put(x, y, dither(LT.MOSS, 0.15 + cl * 0.7 + (h01(x, y, 31) - 0.5) * 0.5, x, y, 33));
        }
      }
      // 3. surface roots: few, broad, low-contrast relief
      for (let i = 0; i < 8; i++) {
        let x = rnd() * P, y = rnd() * P, a = rnd() * TAU;
        const steps = 120 + ((rnd() * 220) | 0), w0 = 1.8 + rnd() * 2.6;
        for (let s = 0; s < steps; s++) {
          a += (rnd() - 0.5) * 0.12; x += Math.cos(a); y += Math.sin(a);
          const w = Math.max(1, w0 * (1 - (s / steps) * 0.6)), nx = -Math.sin(a), ny = Math.cos(a), lim = Math.ceil(w) + 1;
          for (let k = -lim; k <= lim; k++) {
            const e = k / (w + 0.001), px = Math.round(x + nx * k), py = Math.round(y + ny * k);
            const face = (k < 0 ? -1 : 1) * (nx * SUN.x + ny * SUN.y);
            if (Math.abs(e) > 1) { if (face < -0.1 && Math.abs(e) < 2) shade(px, py, 0.7); continue; }
            put(px, py, dither(LT.ROOT, 0.2 + 0.2 * (1 - e * e) + 0.25 * face, px, py, 37));
          }
        }
      }
      // 4. NEEDLE DRIFTS — conifer litter lying one way, in mats; the shared heading is the tell
      for (let i = 0; i < 7000; i++) {
        const x = rnd() * P, y = rnd() * P, u = x / P, v = y / P;
        if (rnd() > clamp01((ndrift(u, v) - 0.52) * 3.2)) continue;
        const a = nang(u, v) * TAU + (rnd() - 0.5) * 0.5, len = 1 + ((rnd() * 2) | 0), col = ramp(LT.NEEDLE, rnd());
        for (let s = 0; s < len; s++) put(Math.round(x + Math.cos(a) * s), Math.round(y + Math.sin(a) * s), col);
      }
      // 5. twigs: dark sticks with a contact shadow
      for (let i = 0; i < 420; i++) {
        const x = rnd() * P, y = rnd() * P, a = rnd() * TAU, len = 3 + ((rnd() * 9) | 0);
        const col = ramp(LT.ROOT, 0.3 + rnd() * 0.5);
        for (let s = 0; s <= len; s++) {
          const px = x + Math.cos(a) * s, py = y + Math.sin(a) * s;
          shade(Math.round(px - SUN.x * 1.5), Math.round(py - SUN.y * 1.5), 0.6);
          put(Math.round(px), Math.round(py), col);
        }
      }
      // 6. LEAF LITTER with shape: oriented 2-4px lozenges on a contact shadow, gathered by the
      //    low octave, a rare pale one for the top of the floor's range
      for (let i = 0; i < 9000; i++) {
        const x = rnd() * P, y = rnd() * P;
        if (rnd() > Math.pow(clamp01((g1(x / P, y / P) - 0.28) * 1.7), 2.2)) continue;
        const L = 1.6 + Math.pow(rnd(), 2) * 2.6, W = L * (0.45 + rnd() * 0.3), a = rnd() * TAU, ca = Math.cos(a), sa = Math.sin(a);
        const pale = rnd() < 0.06, col = ramp(LT.LITTER, pale ? 0.75 + rnd() * 0.25 : rnd() * 0.55);
        for (let pass = 0; pass < 2; pass++) {
          const ox = pass ? 0 : -SUN.x * 1.1, oy = pass ? 0 : -SUN.y * 1.1;
          for (let tt = -L / 2; tt <= L / 2; tt += 0.55) {
            const wq = (W / 2) * Math.sqrt(Math.max(0, 1 - (tt / (L / 2)) * (tt / (L / 2))));
            for (let ss = -wq; ss <= wq; ss += 0.55) {
              const px = Math.round(x + tt * ca - ss * sa + ox), py = Math.round(y + tt * sa + ss * ca + oy);
              if (pass) put(px, py, col); else shade(px, py, 0.66);
            }
          }
        }
      }
      // 7. small plants: dark rosettes of 3-5 leaves where it is damp — the floor's own greenery
      for (let i = 0; i < 700; i++) {
        const x = rnd() * P, y = rnd() * P;
        if (rnd() > clamp01((wet(x / P, y / P) - 0.42) * 2.6)) continue;
        for (let k = 0, n = 3 + ((rnd() * 3) | 0); k < n; k++) {
          const a = (k / n) * TAU + rnd() * 0.5, len = 1.5 + rnd() * 2;
          for (let s = 0.5; s <= len; s += 0.6) put(Math.round(x + Math.cos(a) * s), Math.round(y + Math.sin(a) * s), ramp(LT.PLANT, 0.3 + (s / len) * 0.6));
        }
        shade(Math.round(x + 1), Math.round(y + 1), 0.7);
      }
      // 8. stones: lobed, a lit top and a shadow
      for (let i = 0; i < 90; i++) {
        const x = rnd() * P, y = rnd() * P, Rr = 0.9 + Math.pow(rnd(), 2) * 2.6, lim = Math.ceil(Rr) + 2;
        const m = 3 + ((rnd() * 3) | 0), ph = rnd() * TAU, amp = 0.15 + rnd() * 0.15;
        for (let pass = 0; pass < 2; pass++) {
          for (let dy = -lim; dy <= lim; dy++) {
            for (let dx = -lim; dx <= lim; dx++) {
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d > Rr * (1 + amp * Math.sin(Math.atan2(dy, dx) * m + ph))) continue;
              if (pass) put(Math.round(x + dx), Math.round(y + dy), ramp(LT.STONE, 0.25 + 0.5 * ((dx * SUN.x + dy * SUN.y) / Rr) + (rnd() - 0.5) * 0.25));
              else shade(Math.round(x + dx - SUN.x * 1.6), Math.round(y + dy - SUN.y * 1.6), 0.6);
            }
          }
        }
      }
      // 9. puddles in the wettest hollows: a dark still disc with one lighter rim pixel up-sun
      for (let i = 0; i < 26; i++) {
        const x = rnd() * P, y = rnd() * P;
        if (wet(x / P, y / P) < 0.66) continue;
        const Rr = 3 + rnd() * 5, sq = 0.5 + rnd() * 0.4, lim = Math.ceil(Rr) + 1;
        for (let dy = -lim; dy <= lim; dy++) for (let dx = -lim; dx <= lim; dx++) {
          const d = Math.hypot(dx, dy / sq) / Rr;
          if (d > 1 + (h01(dx, dy, 71) - 0.5) * 0.25) continue;
          put(Math.round(x + dx), Math.round(y + dy), d > 0.85 && (dx * SUN.x + dy * SUN.y) > 0 ? LT.SHEEN : LT.PUDDLE);
        }
      }
      c.putImageData(img, 0, 0);
      return cv;
    },

    /* ---- THE CROWN: clusters of clusters. Big lobes and small lobelets, each a lit sub-dome; dark
            seams where big lobes meet; sparkle on the sun side of the lobelets; a roughened edge.
            `o.teeth` = conifer outline + internal whorls; `o.boost` shifts the whole ramp. ---- */
    crown(c, cx, cy, R, pal, rnd, opt) {
      const o = opt || {}, LT = FOREST.LIGHT;
      const K = 96, rad = new Float32Array(K);
      if (o.teeth) {
        const jag = 0.26 + rnd() * 0.12, ph = rnd() * TAU;
        for (let i = 0; i < K; i++) {
          const th = (i / K) * TAU, saw = Math.abs(((th * o.teeth + ph) / Math.PI) % 2 - 1);
          rad[i] = R * (1 - jag * saw) * (0.92 + 0.14 * h01(i, o.teeth, 3));
        }
      } else {
        const a1 = 0.08 + rnd() * 0.10, a2 = 0.05 + rnd() * 0.07, a3 = 0.03 + rnd() * 0.05;
        const p1 = rnd() * TAU, p2 = rnd() * TAU, p3 = rnd() * TAU;
        const m1 = 3 + ((rnd() * 2) | 0), m2 = 5 + ((rnd() * 3) | 0), m3 = 9 + ((rnd() * 6) | 0);
        for (let i = 0; i < K; i++) {
          const th = (i / K) * TAU;
          rad[i] = R * (1 - a1 - a2 - a3 + a1 * (1 + Math.sin(th * m1 + p1)) + a2 * (1 + Math.sin(th * m2 + p2)) + a3 * (1 + Math.sin(th * m3 + p3)));
        }
      }
      const radAt = th => {
        const f = ((th % TAU) + TAU) % TAU / TAU * K, i0 = Math.floor(f) % K, i1 = (i0 + 1) % K, t = f - Math.floor(f);
        return rad[i0] + (rad[i1] - rad[i0]) * t;
      };
      const teethPh = rnd() * TAU;
      // two levels of sub-domes
      const big = [], small = [];
      for (let i = 0, n = o.lobes == null ? 5 + ((rnd() * 5) | 0) : o.lobes; i < n; i++) {
        const a = rnd() * TAU, d = Math.pow(rnd(), 0.6) * R * 0.7;
        big.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d, R * (0.3 + rnd() * 0.32)]);
      }
      for (let i = 0, n = Math.round(R * 1.1) + 6; i < n; i++) {
        const a = rnd() * TAU, d = Math.pow(rnd(), 0.5) * R * 0.92;
        small.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d, Math.max(1.6, R * (0.10 + rnd() * 0.12))]);
      }
      const leaf = noiseField(9, rnd);                       // per-crown clump texture
      const B = Math.ceil(R * 1.4) + 3, S = R * 2.2;
      // 1. cast shadow, opaque, down-sun, ragged edge — the dark gap between crowns
      if (o.shadow !== false) {
        const ox = -SUN.x * R * 0.34, oy = -SUN.y * R * 0.40;
        c.fillStyle = rgb(LT.SHADOW);
        for (let y = -B; y <= B; y++) {
          for (let x = -B; x <= B; x++) {
            const d = Math.hypot(x - ox, y - oy), e = radAt(Math.atan2(y - oy, x - ox)) * 1.02;
            if (d > e) continue;
            if (d > e - 3 && h01(x, y, 41) > 0.4) continue;
            c.fillRect(Math.round(cx + x), Math.round(cy + y), 1, 1);
          }
        }
      }
      // 2. the crown
      for (let y = -B; y <= B; y++) {
        for (let x = -B; x <= B; x++) {
          const th = Math.atan2(y, x), d = Math.hypot(x, y);
          const e = radAt(th) * (1 + (h01(x, y, 43) - 0.5) * 0.18 + (h01(x >> 1, y >> 1, 45) - 0.5) * 0.10);   // leafy edge
          if (d > e) continue;
          const k = d / e, dome = Math.sqrt(Math.max(0, 1 - k * k));
          const side = (x * SUN.x + y * SUN.y) / R;                 // +1 toward the sun (up-left)
          let h1 = 0, h2 = 0, side1 = 0;
          for (const [lx, ly, lr] of big) {
            const dd = Math.hypot(cx + x - lx, cy + y - ly) / lr;
            if (dd >= 1) continue;
            const hgt = Math.sqrt(1 - dd * dd);
            if (hgt > h1) { h2 = h1; h1 = hgt; side1 = ((cx + x - lx) * SUN.x + (cy + y - ly) * SUN.y) / lr; }
            else if (hgt > h2) h2 = hgt;
          }
          let s1 = 0, sside = 0;
          for (const [lx, ly, lr] of small) {
            const dd = Math.hypot(cx + x - lx, cy + y - ly) / lr;
            if (dd >= 1) continue;
            const hgt = Math.sqrt(1 - dd * dd);
            if (hgt > s1) { s1 = hgt; sside = ((cx + x - lx) * SUN.x + (cy + y - ly) * SUN.y) / lr; }
          }
          const clump = leaf((x + R) / S, (y + R) / S);
          let lit = 0.06 + 0.36 * dome + 0.38 * side + 0.12 * h1 + 0.16 * side1 + 0.10 * s1 + 0.18 * sside + (clump - 0.5) * 0.26 + (o.boost || 0);
          if (h1 > 0 && h2 > 0 && h1 - h2 < 0.10) lit -= 0.20;      // the SEAM where two leaf masses meet
          if (side < -0.35) lit -= 0.14;                             // the crown's own shade on its far side
          if (o.teeth) {                                             // conifer whorls: the outline's rhythm, inside
            const saw = Math.abs(((th * o.teeth + teethPh) / Math.PI) % 2 - 1);
            lit += (0.5 - saw) * 0.22 * (0.4 + 0.6 * k);
            if (d < R * 0.12) lit += 0.25;                           // the lit apex
          }
          if (sside > 0.6 && s1 > 0.7 && lit > 0.55 && h01(x, y, 49) > 0.55) lit += 0.18;   // leaf sparkle
          c.fillStyle = rgb(dither(pal, lit, Math.round(cx + x), Math.round(cy + y), 47));
          c.fillRect(Math.round(cx + x), Math.round(cy + y), 1, 1);
        }
      }
    },

    /* ---- the scatter sprites: pre-rendered once, then one drawImage per instance ---- */
    buildSprites(rnd) {
      const LT = FOREST.LIGHT;
      const out = [];
      const add = (kind, cv, ox, oy, R) => out.push({ kind, cv: hardEdge(cv), ox, oy, R });
      const sprite = (R, mult) => { const S = Math.ceil(R * (mult || 3.2)), cv = mkCv(S, S); return [cv, cv.getContext('2d'), S / 2]; };

      // BROADLEAF — twelve variants ordered dark -> lit, the bulk of the canopy
      for (let v = 0; v < 12; v++) {
        const R = 10 + Math.round(rnd() * 16), [cv, c, m] = sprite(R);
        FOREST.crown(c, m, m, R, LT.LEAF, rnd, { boost: -0.10 + v * 0.016 });
        add('tree', cv, m, m, R);
      }
      // EMERGENTS — the giants that stand above the canopy and catch the most light
      for (let v = 0; v < 4; v++) {
        const R = 28 + Math.round(rnd() * 12), [cv, c, m] = sprite(R, 3.0);
        FOREST.crown(c, m, m, R, LT.LEAF, rnd, { boost: 0.0 + v * 0.03, lobes: 11 });
        add('emergent', cv, m, m, R);
      }
      // CONIFER — spiked, whorled, near-black blue-green; they gather in stands
      for (let v = 0; v < 8; v++) {
        const R = 8 + Math.round(rnd() * 12), [cv, c, m] = sprite(R, 3.0);
        FOREST.crown(c, m, m, R, LT.CONIFER, rnd, { teeth: 8 + ((rnd() * 6) | 0), lobes: 3, boost: -0.06 + v * 0.02 });
        add('conifer', cv, m, m, R);
      }
      // ASH — the paler crown, one in ten, the only lift in the canopy
      for (let v = 0; v < 5; v++) {
        const R = 9 + Math.round(rnd() * 12), [cv, c, m] = sprite(R);
        FOREST.crown(c, m, m, R, LT.ASH, rnd, { boost: -0.04 + v * 0.025 });
        add('ash', cv, m, m, R);
      }
      // SNAG — bare forking limbs, long shadow, the pale dead wood
      for (let v = 0; v < 3; v++) {
        const R = 9 + Math.round(rnd() * 7), [cv, c, m] = sprite(R, 3.0);
        const limbs = [];
        for (let i = 0, n = 5 + ((rnd() * 4) | 0); i < n; i++) limbs.push({ a: (i / n) * TAU + rnd() * 0.6, len: R * (0.55 + 0.45 * rnd()), fork: rnd() < 0.6 });
        const drawLimbs = (ox, oy, style) => {
          c.strokeStyle = style; c.lineCap = 'butt';
          for (const L of limbs) {
            c.lineWidth = Math.max(1.4, R * 0.11);
            c.beginPath(); c.moveTo(ox, oy); c.lineTo(ox + Math.cos(L.a) * L.len, oy + Math.sin(L.a) * L.len); c.stroke();
            if (!L.fork) continue;
            c.lineWidth = Math.max(1, R * 0.06);
            for (const s of [-1, 1]) {
              const bx = ox + Math.cos(L.a) * L.len * 0.62, by = oy + Math.sin(L.a) * L.len * 0.62;
              c.beginPath(); c.moveTo(bx, by); c.lineTo(bx + Math.cos(L.a + s * 0.7) * L.len * 0.38, by + Math.sin(L.a + s * 0.7) * L.len * 0.38); c.stroke();
            }
          }
        };
        drawLimbs(m - SUN.x * R * 0.5, m - SUN.y * R * 0.55, rgb(LT.SHADOW));
        drawLimbs(m, m, rgb(LT.DEAD[2]));
        c.fillStyle = rgb(LT.DEAD[3]); c.fillRect(Math.round(m) - 1, Math.round(m) - 1, 2, 2);
        add('snag', cv, m, m, R);
      }
      // UNDERSTORY — small dark crowns in the gaps (hazel, holly), and SAPLINGS of the canopy species
      for (let v = 0; v < 6; v++) {
        const R = 4 + Math.round(rnd() * 5), [cv, c, m] = sprite(R, 3.4);
        FOREST.crown(c, m, m, R, v < 3 ? LT.CONIFER : LT.LEAF, rnd, { lobes: 3, boost: -0.08, shadow: v % 2 === 0 });
        add('bush', cv, m, m, R);
      }
      // FERNS — dark rosettes of arcing fronds, pinnae along both edges
      for (let v = 0; v < 6; v++) {
        const R = 5 + Math.round(rnd() * 6), [cv, c, m] = sprite(R, 3.2);
        for (let i = 0, n = 6 + ((rnd() * 5) | 0); i < n; i++) {
          const a0 = rnd() * TAU, len = R * (0.65 + 0.35 * rnd()), bow = (rnd() < 0.5 ? -1 : 1) * (0.3 + rnd() * 0.4);
          const lit = 0.22 + 0.36 * clamp01(0.5 + (Math.cos(a0) * SUN.x + Math.sin(a0) * SUN.y) * 0.5);
          for (let s = 0; s <= len; s += 0.6) {
            const t = s / len, a = a0 + bow * t * t, px = m + Math.cos(a) * s, py = m + Math.sin(a) * s;
            c.fillStyle = rgb(ramp(LT.LEAF, lit + 0.18 * t));
            c.fillRect(Math.round(px), Math.round(py), 1, 1);
            const wid = Math.max(0, 1 - Math.abs(t - 0.35) / (t < 0.35 ? 0.4 : 0.7)) * (0.8 + R * 0.09);
            for (const sgn of [-1, 1]) {
              if (wid * (0.55 + 0.45 * ((s * 2) % 2 < 1 ? 1 : 0.5)) < 0.7) continue;
              c.fillStyle = rgb(ramp(LT.LEAF, lit + 0.18 * t + (sgn > 0 ? 0.12 : -0.08)));
              c.fillRect(Math.round(px + Math.cos(a + sgn * 1.57) * wid), Math.round(py + Math.sin(a + sgn * 1.57) * wid), 1, 1);
            }
          }
        }
        add('fern', cv, m, m, R);
      }
      // LOGS — dark bark with ridges along the grain, a lit flank, moss, broken end grain
      for (let v = 0; v < 5; v++) {
        const len = 24 + Math.round(rnd() * 34), rad = 2 + Math.round(rnd() * 3), ang = rnd() * Math.PI;
        const S = Math.ceil(len * 1.5), cv = mkCv(S, S), c = cv.getContext('2d'), m = S / 2;
        c.save(); c.translate(m, m); c.rotate(ang);
        c.fillStyle = rgb(LT.SHADOW); c.fillRect(-len / 2 + 2, -rad + 3, len, rad * 2);
        c.fillStyle = rgb(LT.TRUNK); c.fillRect(-len / 2, -rad, len, rad * 2);
        c.fillStyle = rgb(LT.TRUNK_HI); c.fillRect(-len / 2, -rad, len, Math.max(1, rad - 1));
        for (let i = 0; i < len * 1.4; i++) { c.fillStyle = rgb(rnd() < 0.5 ? LT.ROOT[0] : LT.TRUNK_HI); c.fillRect(Math.round(-len / 2 + rnd() * len), Math.round(-rad + rnd() * rad * 2), 1 + ((rnd() * 3) | 0), 1); }
        for (let i = 0; i < len * 0.6; i++) { c.fillStyle = rgb(LT.MOSS[1 + ((rnd() * 3) | 0)]); c.fillRect(Math.round(-len / 2 + rnd() * len), Math.round(-rad + rnd() * rad), 1 + ((rnd() * 2) | 0), 1); }
        c.fillStyle = rgb(LT.PALE); c.fillRect(-len / 2 - 1, -rad, 2, rad * 2);
        if (rnd() < 0.6) { c.fillStyle = rgb(LT.TRUNK); c.fillRect(len * 0.1, -rad - 3, 2, 3); c.fillRect(-len * 0.2, rad, 2, 3); }   // stubs of branches
        c.restore();
        add('log', cv, m, m, len / 2);
      }
      // FALLEN BRANCHES — a forked stick with a shadow; the cheap thing that fills open floor
      for (let v = 0; v < 4; v++) {
        const R = 8 + Math.round(rnd() * 8), [cv, c, m] = sprite(R, 2.6);
        const a = rnd() * TAU, len = R * 1.8;
        const line = (ox, oy, style, w) => {
          c.strokeStyle = style; c.lineWidth = w; c.lineCap = 'butt';
          c.beginPath(); c.moveTo(ox - Math.cos(a) * len / 2, oy - Math.sin(a) * len / 2); c.lineTo(ox + Math.cos(a) * len / 2, oy + Math.sin(a) * len / 2); c.stroke();
          const bx = ox + Math.cos(a) * len * 0.15, by = oy + Math.sin(a) * len * 0.15;
          c.beginPath(); c.moveTo(bx, by); c.lineTo(bx + Math.cos(a + 0.8) * len * 0.35, by + Math.sin(a + 0.8) * len * 0.35); c.stroke();
        };
        line(m - SUN.x * 1.6, m - SUN.y * 1.6, rgb(LT.SHADOW), 1.6);
        line(m, m, rgb(LT.ROOT[0]), 1.4);
        add('branch', cv, m, m, R);
      }
      // STUMPS — the one man-made mark
      for (let v = 0; v < 2; v++) {
        const R = 4 + Math.round(rnd() * 3), [cv, c, m] = sprite(R, 4);
        c.fillStyle = rgb(LT.SHADOW); c.beginPath(); c.ellipse(m - SUN.x * R * 0.4, m - SUN.y * R * 0.4, R * 1.05, R * 0.9, 0, 0, TAU); c.fill();
        c.fillStyle = rgb(LT.TRUNK); c.beginPath(); c.arc(m, m, R, 0, TAU); c.fill();
        c.fillStyle = rgb(LT.PALE); c.beginPath(); c.arc(m, m, R * 0.75, 0, TAU); c.fill();
        c.strokeStyle = rgb(LT.TRUNK_HI); c.lineWidth = 1; c.beginPath(); c.arc(m, m, R * 0.4, 0, TAU); c.stroke();
        add('stump', cv, m, m, R);
      }
      // BOULDERS — faceted, cool grey, mossed, hard shadow
      for (let v = 0; v < 5; v++) {
        const R = 6 + Math.round(rnd() * 8), [cv, c, m] = sprite(R, 3.2);
        c.fillStyle = rgb(LT.SHADOW); c.beginPath(); c.ellipse(m - SUN.x * R * 0.45, m - SUN.y * R * 0.5, R * 0.95, R * 0.66, 0, 0, TAU); c.fill();
        const NF = 7, vr = [];
        for (let i = 0; i < NF; i++) vr.push(R * (0.78 + 0.30 * h01(i, v, 17)));
        for (let i = 0; i < NF; i++) {
          const a0 = (i / NF) * TAU, a1 = ((i + 1) / NF) * TAU, am = (a0 + a1) / 2;
          c.fillStyle = rgb(ramp(LT.STONE, 0.3 + 0.5 * (Math.cos(am) * SUN.x + Math.sin(am) * SUN.y)));
          c.beginPath();
          c.moveTo(m + Math.cos(am) * R * 0.12, m + Math.sin(am) * R * 0.12);
          c.lineTo(m + Math.cos(a0) * vr[i], m + Math.sin(a0) * vr[i]);
          c.lineTo(m + Math.cos(a1) * vr[(i + 1) % NF], m + Math.sin(a1) * vr[(i + 1) % NF]);
          c.closePath(); c.fill();
        }
        for (let i = 0, n = Math.round(R * R * 0.35); i < n; i++) { const a = rnd() * TAU, d = R * Math.pow(rnd(), 0.7) * 0.7; c.fillStyle = rgb(rnd() < 0.7 ? LT.MOSS[1 + ((rnd() * 3) | 0)] : LT.STONE[1]); c.fillRect(Math.round(m + Math.cos(a) * d + SUN.x * R * 0.2), Math.round(m + Math.sin(a) * d + SUN.y * R * 0.2), 1, 1); }
        add('rock', cv, m, m, R);
      }
      // MUSHROOMS — a cluster of pale caps on the dark floor, each on its own dark foot
      for (let v = 0; v < 3; v++) {
        const R = 3 + Math.round(rnd() * 3), [cv, c, m] = sprite(R, 3.4);
        for (let i = 0, n = 3 + ((rnd() * 5) | 0); i < n; i++) {
          const x = Math.round(m + (rnd() - 0.5) * R * 2), y = Math.round(m + (rnd() - 0.5) * R * 1.6), s = rnd() < 0.3 ? 2 : 1;
          c.fillStyle = rgb(LT.SHADOW); c.fillRect(x, y + s, s + 1, 1);
          c.fillStyle = rgb(LT.CAP); c.fillRect(x, y, s, s);
          c.fillStyle = rgb(LT.PALE); c.fillRect(x, y, 1, 1);
        }
        add('shroom', cv, m, m, R);
      }
      return out;
    },

    /* ---- THE RIVER: chained segments carrying a near-black channel through their centre at
            START/END levels from {-1,0,+1}, so the placer's per-column hash makes it wander. ---- */
    buildRidges(rnd) {
      const LT = FOREST.LIGHT, ST = FOREST.STREAM, W = ST.W, H = ST.H, STEP = H * 0.16, out = [];
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const cv = mkCv(W, H), c = cv.getContext('2d');
          const img = c.createImageData(W, H), D = img.data;
          const put = (x, y, col) => { if (x < 0 || x >= W || y < 0 || y >= H) return; const i = (y * W + x) * 4; D[i] = col[0]; D[i + 1] = col[1]; D[i + 2] = col[2]; D[i + 3] = 255; };
          const bulge = (H * 0.08) * (rnd() - 0.5) * 2, wob = rnd() * TAU;
          const halfW = 14;                                  // SHARED: width must match at the joins
          const rocks = [];
          for (let i = 0, n = 6 + ((rnd() * 6) | 0); i < n; i++) rocks.push([rnd() * W, (rnd() - 0.5) * 1.6, 1 + ((rnd() * 2) | 0)]);
          for (let x = 0; x < W; x++) {
            const u = x / W, s = u * u * (3 - 2 * u);
            const centre = H / 2 + (a * STEP) + (b - a) * STEP * s + bulge * Math.sin(u * Math.PI) * (0.7 + 0.3 * Math.sin(u * Math.PI * 3 + wob));
            const wdt = halfW * (0.72 + 0.28 * Math.sin(u * Math.PI * 2 + 1.3)) + (h01(x >> 2, a * 3 + b, 61) - 0.5) * 3;
            const cy = Math.round(centre);
            for (let k = -Math.ceil(wdt) - 6; k <= Math.ceil(wdt) + 6; k++) {
              const y = cy + k, t = Math.abs(k) / wdt;
              if (t > 1) {                                       // banks: wet earth, gravel, then a dark lip
                if (t < 1 + 2 / wdt) put(x, y, h01(x, y, 65) > 0.55 ? ramp(LT.GRAVEL, h01(x, y, 66)) : LT.BANK_WET);
                else if (t < 1 + 4 / wdt && h01(x, y, 63) > 0.35) put(x, y, h01(x, y, 68) > 0.8 ? LT.GRAVEL[0] : LT.BANK);
                else if (t < 1 + 6 / wdt && h01(x, y, 69) > 0.7) put(x, y, LT.BANK);
                continue;
              }
              let col = t < 0.5 ? LT.WATER[0] : t < 0.85 ? LT.WATER[1] : LT.WATER[2];
              if (t > 0.15 && t < 0.75 && ((k + 100) % 3 === 0) && ((x + k * 7) % 12) < 7) col = LT.WATER[2];
              if (t < 0.7 && h01(x, y, 67) > 0.975) col = LT.SHEEN;
              put(x, y, col);
            }
            // rocks breaking the surface, with a lit top and a dark eddy downstream
            for (const [rx, ry, rs] of rocks) {
              if (Math.abs(x - rx) > rs) continue;
              const y = cy + Math.round(ry * wdt * 0.6);
              for (let yy = -rs; yy <= rs; yy++) put(x, y + yy, yy < 0 ? LT.STONE[2] : LT.STONE[0]);
              put(x + rs + 1, y, LT.WATER[0]);
            }
          }
          c.putImageData(img, 0, 0);
          out.push({ kind: 'ridge', cv, ox: 0, oy: H / 2, R: W, W, H, a, b, z: -1 });
        }
      }
      return out;
    },

    /* ---- WHERE THINGS GROW — a pure function of the cell, infinite and stored nowhere ---- */
    place(push, x0, y0, x1, y1, clr, scale, pools) {
      const C = FOREST.CELL, ST = FOREST.STREAM;
      const ridges = pools.ridge;
      if (ridges && ridges.length) {
        const W = ridges[0].W || ST.W, LANE = ST.LANE, HALF = 100;
        const level = (lane, sx) => ((h01(sx, lane, 94) * 3) | 0) - 1;
        for (let lane = Math.floor(y0 / LANE) - 1; lane <= Math.ceil(y1 / LANE); lane++) {
          if (lane !== 0 && h01(lane, 0, 91) > ST.P) continue;   // lane 0 always runs: the station's own river
          let laneY = lane * LANE + h01(lane, 1, 92) * LANE * 0.8;
          if (clr) {   // never through the pad — shove the lane just clear of it, so it hugs the clearing
            const top = clr.y - C * 0.5 - HALF, bot = clr.y + clr.h + C * 0.5 + HALF;
            if (laneY > top && laneY < bot) laneY = (laneY - top < bot - laneY) ? top : bot;
          }
          for (let sx = Math.floor(x0 / W) - 1; sx <= Math.ceil(x1 / W); sx++) {
            const a = level(lane, sx), b = level(lane, sx + 1);
            push(ridges.find(r => r.a === a && r.b === b) || ridges[0], sx * W, laneY);
          }
        }
      }
      /* the station's own footprint (the bake rect) is the clearing MINUS its margin: nothing at
         all goes there; low undergrowth may grow in the margin band around it. */
      const stn = clr ? { x: clr.x + C * 0.5, y: clr.y + C * 0.5, w: clr.w - C, h: clr.h - C } : null;
      const inRect = (r, x, y) => r && x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;
      const cx0 = Math.floor(x0 / C), cx1 = Math.ceil(x1 / C), cy0 = Math.floor(y0 / C), cy1 = Math.ceil(y1 / C);
      const clutter = scale >= 0.55;
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const wx0 = cx * C, wy0 = cy * C;
          /* THE FIELD: where the canopy is closed and where it opens. Old growth from above is
             MOSTLY CROWN — most cells carry two or three — with real glades cut by the low octave
             and conifer STANDS where the second field runs cold. */
          const dens = vnoise(wx0 / 420, wy0 / 420, 3) * 0.55 + vnoise(wx0 / 160, wy0 / 160, 11) * 0.45;
          const cold = vnoise(wx0 / 300, wy0 / 300, 7);
          const edgeBoost = clr ? nearClearing(clr, wx0, wy0, C) : 0;
          const want = dens * 1.1 + edgeBoost * 0.4;
          const nTree = want > 0.42 ? (h01(cx, cy, 1) < 0.55 + want * 0.5 ? (h01(cx, cy, 2) < want * 0.7 ? 3 : 2) : 1) : (want > 0.30 && h01(cx, cy, 1) < 0.35 ? 1 : 0);
          for (let k = 0; k < nTree; k++) {
            const wx = wx0 + h01(cx, cy, 20 + k) * C, wy = wy0 + h01(cx, cy, 30 + k) * C;
            if (inRect(clr, wx, wy)) continue;
            const pick = h01(cx, cy, 40 + k);
            const conif = cold > 0.58 ? 0.75 : 0.18;                 // stands, not a sprinkle
            const pool = pick < 0.03 ? 'emergent' : pick < 0.03 + conif ? 'conifer' : pick < 0.13 + conif ? 'ash' : pick < 0.142 + conif ? 'snag' : 'tree';
            const arr = pools[pool] || pools.tree;
            if (!arr || !arr.length) continue;
            /* THE LIGHT FIELD: a slow noise decides which variant a cell gets — every pool's variants
               run dark -> lit, so whole hillsides of canopy read brighter or deeper. */
            const light = clamp01(vnoise(wx / 700, wy / 700, 17) * 0.7 + vnoise(wx / 240, wy / 240, 19) * 0.3 + (h01(cx, cy, 50 + k) - 0.5) * 0.35);
            push(arr[Math.min(arr.length - 1, (light * arr.length) | 0)], wx, wy);
          }
          if (!clutter) continue;
          /* THE WILDERNESS: undergrowth in every gap, THICK. Bushes and saplings, ferns, fallen
             branches, logs, stone, mushrooms — densest at the clearing's rim and in the glades,
             and present in the margin around the station where play zoom actually looks. */
          const open = clamp01(1 - dens * 1.3) + edgeBoost * 1.2;
          const nSmall = Math.round(open * 4.2 * (0.4 + h01(cx, cy, 5)));
          for (let k = 0; k < nSmall; k++) {
            const wx = wx0 + h01(cx, cy, 60 + k) * C, wy = wy0 + h01(cx, cy, 70 + k) * C;
            if (inRect(stn, wx, wy)) continue;
            const pick = h01(cx, cy, 80 + k);
            /* ⛔ DEADFALL IS AN EVENT. At a quarter of the scatter, branches and logs read as
               matchsticks strewn over the whole canopy; the green things carry the density. */
            const pool = pick < 0.32 ? 'bush' : pick < 0.62 ? 'fern' : pick < 0.68 ? 'branch' : pick < 0.74 ? 'log' : pick < 0.88 ? 'rock' : pick < 0.96 ? 'shroom' : 'stump';
            const arr = pools[pool];
            if (!arr || !arr.length) continue;
            push(arr[(h01(cx, cy, 90 + k) * arr.length) | 0], wx, wy);
          }
        }
      }
    },
  };

  /* -------------------------------------------------------------------- GROUND: MOON ---- */
  /* A landed station on a mare plain. The forest's problem was making an organic mass legible;
     the moon's is the opposite — there is exactly ONE material out here, so every scrap of
     interest has to come from FORM. Which is lucky, because form is what a crater is.

     THREE THINGS CARRY IT:
       1. THE SUN IS LOW AND THERE IS NO AIR. Shadows are long, hard and BLACK — no atmospheric
          fill light, no colour bounce, no falloff. That single fact is most of the drama, and it
          is why the shadow colour here is nearly (0,0,0) while the forest's is a dark green.
       2. CRATERS ARE HOLES, NOT DOMES, and the difference is which side is lit. In a bowl the FAR
          wall (down-sun) catches the light and the near wall is in shadow — precisely inverted
          from a boulder. Get that backwards and the whole plain inflates into bubble wrap; it is
          the classic failure of every procedural moon.
       3. SCALE HIERARCHY. Real regolith is craters inside craters inside craters, over five
          orders of magnitude. Three placement grids (basins, craters, pits) plus micro-pits baked
          into the tiling patch is enough to fake that, and it is what keeps the plain from reading
          as a texture with dots on it. */

  const MOON = {
    label: 'THE MOON',
    blurb: 'Landed on a mare plain. Long shadows, no air, no one coming.',
    base: '#0a0a0b',
    PATCH: 768,
    DAPPLE: 1024,                      // broad albedo swathes — ray material, not sunlight
    /* The ray pass reads as CAMOUFLAGE if you can see its blobs. It is meant to be the faintest
       possible hint that some of this dust came from somewhere else — felt, not seen. At 0.06 its
       lumps were legible as lumps and the plain looked stained. */
    OVERLAY_ALPHA: 0.05,
    CELL: 96,

    LIGHT: {
      /* Mare basalt is DARK — albedo around 0.07, one of the least reflective surfaces in the
         solar system. The moon looks bright to us only because it sits against black sky. Ramping
         it up to "moon white" would both be wrong and break the law that the station is the
         brightest thing on screen. */
      /* TEN STEPS, NOT SIX, AND A DUOTONE (2026-09-09). At six steps of ~12 units the hash dither
         between adjacent steps was a ±12 salt-and-pepper over the whole plain, and at play zoom
         (every pixel a 2x2 block) that read as TV STATIC — Andrew's "need significantly way
         better". Finer steps halve the dither amplitude for the same tonal range. The ramp also
         runs cool in the dark end and warm in the light end: shade on the moon is lit by nothing,
         sunlit dust is lit by a yellow star, and that one hue shift is what stops a monochrome
         plain from reading as a grey texture swatch. Still one material. */
      REG: [[18, 17, 22], [25, 24, 28], [32, 31, 34], [40, 39, 41], [48, 47, 48], [57, 55, 55], [66, 63, 62], [76, 72, 69], [86, 81, 76], [97, 91, 84], [108, 101, 91], [118, 110, 98]],
      RIM: [[132, 124, 112], [164, 154, 140], [200, 190, 172]],     // sun-struck crater rims, brightest thing out here
      DARK: [[16, 16, 17], [22, 22, 23]],                          // shaded regolith
      /* SHADOW IS NOT BLACK, and this is the single biggest correction in this pass. "Airless, so
         the shadows are black" is true of the PHOTOGRAPH and false of the picture: an Apollo frame
         is black in shade because the film had eight stops and spent them all on the sunlit ground.
         The eye standing there sees into the shade fine, because the sunlit far wall of the bowl is
         a huge grey reflector aimed straight into it. Filling shade with near-zero turned every
         crater into a punched hole and every bowl into a silhouette — the plain read as pegboard. */
      SHADOW: [12, 11, 16],
      BOUNCE: [38, 36, 42],                                        // shade lit by the far wall, not by the sun
      DUST: [104, 100, 92],                                        // ray ejecta, used additively
    },

    /* ---- the tiling regolith: grain, micro-pits, and the odd bright chip ---- */
    buildPatch(rnd) {
      const P = MOON.PATCH, LT = MOON.LIGHT;
      const cv = mkCv(P, P), c = cv.getContext('2d');
      /* n0 is NEW: broad albedo swathes at the screen scale — a mare is not one value, it is
         darker basalt flows and paler ejecta blankets hundreds of px across, and that low octave
         is the only composition the plain has at zoom-out. The high octave is cut back: at play
         zoom it was doing nothing but feeding the static. */
      const n0 = noiseField(2, rnd), n1 = noiseField(3, rnd), n2 = noiseField(8, rnd), n3 = noiseField(21, rnd);
      const img = c.createImageData(P, P), D = img.data;
      let p = 0;
      for (let y = 0; y < P; y++) {
        for (let x = 0; x < P; x++) {
          const u = x / P, v = y / P;
          /* regolith is churned powder: broad tonal drift, then a hard 1px hash on top. The hash
             is doing most of the work — dust has no structure at any scale you can see from here,
             only tooth. */
          const soft = n0(u, v) * 0.30 + n1(u, v) * 0.18 + n2(u, v) * 0.26 + n3(u, v) * 0.26;
          const col = dither(LT.REG, soft * 0.70 + 0.30, x, y, 17);
          D[p] = col[0]; D[p + 1] = col[1]; D[p + 2] = col[2]; D[p + 3] = 255;
          p += 4;
        }
      }
      c.putImageData(img, 0, 0);

      const stamp = (x, y, w, h, style) => {
        c.fillStyle = style;
        for (const ox of [-P, 0, P]) for (const oy of [-P, 0, P]) c.fillRect(x + ox, y + oy, w, h);
      };
      /* MICRO-PITS: the smallest craters, too small to be sprites, baked straight into the tile.
         Each is two pixels — a lit crumb up-sun and a black crumb down-sun. That two-pixel pair is
         the entire language of this ground, repeated at every scale above it. */
      /* FEWER, and read against the plain rather than shouting over it: at 1500 pairs plus 260
         chips the tile was a field of speckle, and at play zoom speckle IS static. */
      for (let i = 0; i < 520; i++) {
        const x = (rnd() * P) | 0, y = (rnd() * P) | 0, s = 1 + ((rnd() * 2) | 0);
        stamp(x, y, s, s, rgba(LT.SHADOW, 0.45 + 0.35 * rnd()));
        stamp(x + Math.round(SUN.x * (s + 1)), y + Math.round(SUN.y * (s + 1)), s, 1, rgba(LT.RIM[0], 0.25 + 0.30 * rnd()));
      }
      for (let i = 0; i < 140; i++) {                     // fresh chips of unweathered rock
        const x = (rnd() * P) | 0, y = (rnd() * P) | 0;
        stamp(x, y, 1, 1, rgba(LT.RIM[1], 0.30 + 0.40 * rnd()));
      }
      return cv;
    },

    /* ---- broad ray material: the pale swathes thrown across a mare by distant impacts ---- */
    buildOverlay(rnd) {
      const P = MOON.DAPPLE, LT = MOON.LIGHT;
      const cv = mkCv(P, P), c = cv.getContext('2d');
      const big = noiseField(3, rnd), mid = noiseField(7, rnd);
      const img = c.createImageData(P, P), D = img.data;
      let p = 0;
      for (let y = 0; y < P; y++) {
        for (let x = 0; x < P; x++) {
          const u = x / P, v = y / P;
          /* STRETCHED ALONG ONE AXIS ON PURPOSE. A ray is a splash from somewhere else, so it is
             directional; sampling the noise anisotropically turns round blobs into streaks and is
             the difference between "rays" and "clouds". */
          const n = big(u * 0.42 + v * 0.30, v * 1.5) * 0.6 + mid(u * 0.5 + v * 0.36, v * 1.8) * 0.4;
          const t0 = clamp01((n - 0.54) * 3.0);
          const q = t0 * 3;
          let qi = Math.floor(q); if (h01(x, y, 31) < q - qi) qi++;
          const step = [0, 0.42, 0.72, 1][Math.max(0, Math.min(3, qi))];
          D[p] = LT.DUST[0] * step; D[p + 1] = LT.DUST[1] * step; D[p + 2] = LT.DUST[2] * step;
          D[p + 3] = 255;
          p += 4;
        }
      }
      c.putImageData(img, 0, 0);
      return cv;
    },

    /* ---- THE CRATER ----
       Built strictly in the order light hits it: ejecta, then the bowl, then the shadow the near
       rim throws INTO the bowl, then the rim itself, then whatever stands in the middle. */
    crater(c, cx, cy, R, rnd, opt) {
      const o = opt || {}, LT = MOON.LIGHT;
      const fresh = o.fresh !== false;
      const pop = (o.ghost ? 0.10 : 1) * clamp01((R - 7) / 38);   // 0 = a pit or a ghost, 1 = a proper crater
      /* K is the rim's own resolution: each band is stroked segment by segment, so too few
         segments makes a 12px-wide band out of 9px chords and the crater comes out FACETED. */
      const K = 144, rad = new Float32Array(K);
      const a1 = 0.010 + rnd() * 0.014, a2 = 0.006 + rnd() * 0.012;
      const p1 = rnd() * TAU, p2 = rnd() * TAU;
      const m1 = 9 + ((rnd() * 4) | 0), m2 = 15 + ((rnd() * 7) | 0);
      for (let i = 0; i < K; i++) {
        const th = (i / K) * TAU;
        rad[i] = R * (1 + a1 * Math.sin(th * m1 + p1) + a2 * Math.sin(th * m2 + p2));
      }
      const ring = (scale, style) => {
        c.fillStyle = style;
        c.beginPath();
        for (let i = 0; i <= K; i++) {
          const th = (i / K) * TAU, r = rad[i % K] * scale;
          const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
          i ? c.lineTo(x, y) : c.moveTo(x, y);
        }
        c.closePath(); c.fill();
      };

      // 1. EJECTA — the apron of overturned material, brighter than the plain and only on the young.
      //    Radial streaks, not a scatter: ejecta is thrown OUT, and the direction is the whole tell.
      if (fresh && R >= 15) {
        for (let i = 0, n = Math.round(R * R * 0.40); i < n; i++) {
          const th = rnd() * TAU;
          const d = R * (1.03 + Math.pow(rnd(), 2.6) * 0.55);      // dense at the rim, thinning out
          const x = cx + Math.cos(th) * d, y = cy + Math.sin(th) * d;
          const len = 1 + ((rnd() * 3) | 0);
          c.fillStyle = rgb(ramp(LT.REG, 0.42 + rnd() * 0.30));
          c.fillRect(Math.round(x), Math.round(y), Math.abs(Math.cos(th)) > 0.5 ? len : 1,
            Math.abs(Math.cos(th)) > 0.5 ? 1 : len);
        }
      }

      /* 1b. EJECTA BOULDERS — the blocks a young impact throws just past its rim. Each is a lit chip
         with a hard shadow down-sun; without them a fresh crater reads as a stamp on the plain. */
      if (fresh && R >= 26) {
        for (let i = 0, n = 5 + ((rnd() * 8) | 0); i < n; i++) {
          const th = rnd() * TAU, d = R * (1.06 + rnd() * 0.5);
          const x = Math.round(cx + Math.cos(th) * d), y = Math.round(cy + Math.sin(th) * d), s = 1 + ((rnd() * 2) | 0);
          c.fillStyle = rgb(LT.SHADOW); c.fillRect(x - Math.round(SUN.x * (s + 1)), y - Math.round(SUN.y * (s + 1)), s + 1, s);
          c.fillStyle = rgb(ramp(LT.REG, 0.62 + rnd() * 0.3)); c.fillRect(x, y, s, s);
          c.fillStyle = rgb(LT.RIM[0]); c.fillRect(x, y, 1, 1);
        }
      }

      /* 2. THE BOWL. Base tone first, then the lit inner wall as a CRESCENT hugging the down-sun
         rim — an arc, not a disc. Filling the lit wall as a circle (the first two cuts) drops a
         grey coin into the hole; a bowl is a rim you see the inside of, so the light belongs on
         the wall, and the wall is a band. */
      /* THE FLOOR IS DARKER THAN THE PLAIN. At 0.46 the bowl base was the same value as the regolith
         around it, so a crater was a ring drawn ON the ground rather than a hole IN it — flat as a
         coin, whatever the rim did. A bowl is shaded by its own walls even where no shadow falls. */
      ring(0.98, rgb(ramp(LT.REG, o.ghost ? 0.40 : fresh ? 0.34 : 0.30)));
      c.save();
      c.beginPath();
      for (let i = 0; i <= K; i++) {
        const th = (i / K) * TAU, r = rad[i % K] * 0.99;
        const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.closePath(); c.clip();
      /* The lit inner wall runs ALL THE WAY ROUND with its brightness varying by angle — the same
         law the rim had to learn. Stroking it only from `down-1.25` to `down+1.25` leaves two butt
         ends inside the bowl, and a bright band that stops dead reads as a strip of tape stuck to
         the crater floor. It was visible on every mid-size crater in the previous pass. */
      /* STIPPLED, NOT STROKED. A stroked band has two hard edges, and inside a bowl that reads as
         a rubber gasket seated in the crater — visible on every mid-size crater until now. Stamping
         the wall as grain whose density fades to nothing at both edges gives the same lighting with
         no boundary anywhere, and it lands in the same tooth as the plain. */
      const wallHi = fresh ? 0.92 : 0.72;
      for (let i = 0, n = Math.round(R * R * 1.5); i < n; i++) {
        const th = rnd() * TAU;
        const t = rnd();                                       // 0 at the floor edge, 1 at the rim
        const d = R * (0.66 + t * 0.34);
        if (rnd() > Math.sin(t * Math.PI) * 0.92) continue;    // density profile = the soft edge
        const facing = -(Math.cos(th) * SUN.x + Math.sin(th) * SUN.y);   // +1 down-sun, -1 up-sun
        const lit = 0.32 + (wallHi - 0.32) * clamp01(0.5 + facing * 0.72) + (rnd() - 0.5) * 0.22;
        c.fillStyle = rgb(ramp(LT.REG, lit));
        c.fillRect(Math.round(cx + Math.cos(th) * d), Math.round(cy + Math.sin(th) * d),
          1 + ((rnd() * 2) | 0), 1);
      }
      /* GRAIN INSIDE THE BOWL. Flat fills are the tell of vector art, and a crater made of three
         smooth regions reads as a logo. The same hashed tooth that carries the plain has to run
         through the bowl too, or the two surfaces are visibly different materials. */
      for (let i = 0, n = Math.round(R * R * 0.55); i < n; i++) {
        const th = rnd() * TAU, d = R * Math.sqrt(rnd());
        const x = cx + Math.cos(th) * d, y = cy + Math.sin(th) * d;
        const lit = 0.42 + 0.34 * (-(Math.cos(th) * SUN.x + Math.sin(th) * SUN.y)) * (d / R);
        c.fillStyle = rgb(ramp(LT.REG, lit + (rnd() - 0.5) * 0.30));
        c.fillRect(Math.round(x), Math.round(y), 1 + ((rnd() * 2) | 0), 1);
      }
      c.restore();

      /* 3. THE SHADOW INSIDE THE BOWL — the near (up-sun) rim throws it across the near wall and
         part of the floor. THIS IS THE WHOLE ILLUSION: shade the up-sun interior and the crater is
         a hole; shade the down-sun interior instead and the identical shape inflates into a dome.
         The shadow's edge is a GENTLE ARC, cut by a circle far larger than the crater — a small
         circle centred just inside the bowl (the first cut) swallows nearly the whole interior and
         leaves a black coin, which is what m1 looked like. */
      c.save();
      c.beginPath();
      for (let i = 0; i <= K; i++) {
        const th = (i / K) * TAU, r = rad[i % K] * 0.98;
        const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.closePath(); c.clip();
      const Rs = R * 2.4, chord = R * ((o.deep ? 0.14 : 0.28) + (1 - pop) * 0.30);   // shallow pits, less shade
      const sx = cx + SUN.x * (Rs + chord), sy = cy + SUN.y * (Rs + chord);
      /* THE TERMINATOR WOBBLES. A perfect arc is the one edge in the picture that could only have
         been made by a machine — it turned the shaded half into a crisp leaf shape sitting in the
         bowl. The line where a rim's shadow lands is the PROFILE OF THAT RIM projected across the
         floor, so it inherits every notch the rim has. Perturbing the cutting circle with the same
         two harmonics that lumped the rim ties the two together for almost nothing. */
      c.fillStyle = rgb(LT.SHADOW);
      c.beginPath();
      for (let i = 0; i <= K; i++) {
        const th = (i / K) * TAU;
        const wob = 1 + 0.030 * Math.sin(th * m1 + p1) + 0.022 * Math.sin(th * m2 * 1.7 + p2);
        const x = sx + Math.cos(th) * Rs * wob, y = sy + Math.sin(th) * Rs * wob;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.closePath(); c.fill();
      // ...and a stippled band just outside it, so the terminator crumbles instead of cutting
      for (let i = 0, n = Math.round(R * 22); i < n; i++) {
        const a = rnd() * TAU, d = Rs + rnd() * R * 0.16;
        const x = sx + Math.cos(a) * d, y = sy + Math.sin(a) * d;
        if (rnd() > 0.55) continue;
        c.fillRect(Math.round(x), Math.round(y), 1, 1);
      }
      /* BOUNCE. The lit far wall is a large grey reflector pointed into the shade, so the shadowed
         floor is brightest right where it meets the light and falls away from there. Without this
         the shadow is a flat stencil of one value — the exact thing that reads as a hole rather
         than as the inside of something. Stippled from the terminator inward so it has no edge. */
      for (let i = 0, n = Math.round(R * R * 0.5); i < n; i++) {
        const a = rnd() * TAU, t = Math.pow(rnd(), 1.7);          // 0 at the terminator, 1 deep in shade
        const d = Rs - t * R * 0.78;
        const x = sx + Math.cos(a) * d, y = sy + Math.sin(a) * d;
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > R * R * 0.94) continue;   // stay in the bowl
        if (rnd() > (1 - t) * 0.85) continue;                     // density falls off with depth
        c.fillStyle = rgb(mix(LT.SHADOW, LT.BOUNCE, (1 - t) * (0.55 + rnd() * 0.45)));
        c.fillRect(Math.round(x), Math.round(y), 1 + ((rnd() * 2) | 0), 1);
      }
      c.restore();

      /* 4. THE RIM IS A RIDGE, AND A RIDGE HAS TWO SLOPES.
         Drawing it as ONE band whose brightness varies by angle — the previous cut — gives a bright
         circle with a dark circle opposite: a DONUT, an outline of a crater rather than a crater.
         What makes a raised rim read as raised is that its two slopes disagree. On the up-sun side
         the OUTER slope faces the sun (bright) while the INNER slope faces away (dark); on the
         down-sun side both are exactly reversed. So the two bands are lit by the same term with
         OPPOSITE sign, and it is that disagreement — a light/dark pair crossing the ring — that the
         eye reads as relief. */
      /* THE DONUT SURVIVED THE LAST PASS, in a subtler form. Two bands lit with opposite sign IS
         the right model, but both were stroked at FULL WIDTH all the way round. So the outer band
         put a bright arc on the up-sun side and the inner band put a bright arc on the down-sun
         side — at two radii 14% apart, which at any real zoom is the same circle. The sum of two
         correct half-rings was one wrong full ring, and the plain came out as pegboard.

         A ridge does not have constant width in the picture: seen from above, a slope only SHOWS
         where it turns toward or away from the light, and the two points where the ridge runs
         parallel to the sun show nothing at all. So the band's WIDTH tapers with the same term that
         drives its brightness, and at the two poles perpendicular to the sun both bands vanish and
         the rim is simply plain-coloured. That gap is what stops the ring from closing. */
      const RIMPAL = [LT.DARK[0], LT.DARK[1], LT.REG[2], LT.REG[3], LT.REG[4], LT.REG[5], LT.RIM[0], LT.RIM[1]];
      const gain = 0.14 + 0.20 * pop * (fresh ? 1 : 0.62);      // young rims are sharper and brighter
      const band = (rScale, sign, width) => {
        c.lineCap = 'round'; c.lineJoin = 'round';
        for (let i = 0; i < K; i++) {
          const th0 = (i / K) * TAU, th1 = ((i + 1) / K) * TAU;
          const facing = -(Math.cos(th0) * SUN.x + Math.sin(th0) * SUN.y);   // +1 down-sun, -1 up-sun
          const show = Math.abs(facing);                                     // 0 at the poles, 1 at the ends
          if (show < 0.42) continue;                                         // the ring is OPEN here
          c.lineWidth = Math.max(1, R * width * (0.14 + 0.86 * show));
          const lit = 0.5 + sign * facing * (0.26 + gain) + (h01(i, R | 0, 77) - 0.5) * 0.10;
          c.strokeStyle = rgb(ramp(RIMPAL, lit));
          c.beginPath();
          c.moveTo(cx + Math.cos(th0) * rad[i] * rScale, cy + Math.sin(th0) * rad[i] * rScale);
          c.lineTo(cx + Math.cos(th1) * rad[(i + 1) % K] * rScale, cy + Math.sin(th1) * rad[(i + 1) % K] * rScale);
          c.stroke();
        }
      };
      band(1.06, -1, 0.085);       // outer slope: bright where it faces the sun
      band(0.94, +1, 0.075);       // inner slope: dark there, bright on the far side

      /* 4b. DUST THE RIM. The lip is drawn as a stroke, and a stroke has a clean edge — the one
         thing nothing else on this plain has. Scattering the ramp's own grain across the rim band
         breaks that edge into the same tooth as the regolith, which is what stops the crater
         reading as a sticker laid on top of the ground. */
      for (let i = 0, n = Math.round(R * R * 0.16); i < n; i++) {
        const th = rnd() * TAU;
        const d = R * (0.97 + rnd() * 0.14);
        const x = cx + Math.cos(th) * d, y = cy + Math.sin(th) * d;
        const sun = -(Math.cos(th) * SUN.x + Math.sin(th) * SUN.y);        // +1 down-sun, -1 up-sun
        const lit = 0.52 - sun * 0.40 + (rnd() - 0.5) * 0.26;
        c.fillStyle = rgb(ramp(LT.REG, lit));
        c.fillRect(Math.round(x), Math.round(y), 1 + ((rnd() * 2) | 0), 1);
      }

      // 5. CENTRAL PEAK — only big craters rebound one, and it is lit like a boulder: the OPPOSITE
      //    side from the bowl, which is exactly what sells the bowl as a bowl.
      if (R >= 62) {
        /* NOT A BALL. Three concentric circles with a near-white cap put a bright DOT in the middle
           of every basin, and at any zoom below 1x the dot was the only thing left of the crater —
           the plain read as a field of fried eggs. A rebound peak is a shattered massif: an angular
           silhouette, a couple of facets that disagree, and a value well below the sunlit rim,
           because it stands in a bowl that is itself in shade. */
        const pr = R * (0.12 + rnd() * 0.05);
        const massif = (r, squash, style) => {
          c.fillStyle = style;
          c.beginPath();
          for (let i = 0, n = 7 + ((rnd() * 3) | 0); i <= n; i++) {
            const a = (i / n) * TAU, rr = r * (0.68 + 0.44 * h01(i, R | 0, 63));
            const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * squash;
            i ? c.lineTo(x, y) : c.moveTo(x, y);
          }
          c.closePath(); c.fill();
        };
        c.save();
        massif(pr * 1.15, 0.72, rgb(LT.SHADOW));                        // the peak's own shadow, down-sun
        c.translate(SUN.x * pr * 0.30, SUN.y * pr * 0.30);
        massif(pr, 0.78, rgb(ramp(LT.REG, 0.40)));                      // the shaded body
        c.translate(SUN.x * pr * 0.34, SUN.y * pr * 0.34);
        massif(pr * 0.52, 0.80, rgb(ramp(LT.REG, 0.74)));               // one sunlit facet, and no more
        c.restore();
      }

      /* NO TERRACES. Slumped walls are real, but two concentric arcs inside a 60px bowl read as
         pen strokes on every frame they appeared in — a detail that only survives at a scale this
         camera never reaches is a decoration, not a detail. */

      /* 6. RAYS — the splash of fresh material a young impact throws for many crater diameters.
         This is the one lunar feature that operates at a LARGER scale than the crater itself, and
         it is why a real mare never looks like an evenly-pocked field: a couple of ray systems cut
         right across everything and give the plain a direction. Only the young get them, and each
         ray is stippled, not filled — it is dust thrown thin, and the ground shows through it. */
      if (o.rays) {
        const nRay = 9 + ((rnd() * 7) | 0);
        for (let r = 0; r < nRay; r++) {
          const a0 = rnd() * TAU;
          const spread = 0.05 + rnd() * 0.10;
          const reach = R * (2.0 + rnd() * 1.9);
          for (let i = 0, n = Math.round(R * 16); i < n; i++) {
            const t = Math.pow(rnd(), 0.7);                       // dense near the rim, thin far out
            const d = R * 1.12 + t * (reach - R * 1.12);
            const a = a0 + (rnd() - 0.5) * spread * (0.4 + t);    // the wedge widens with distance
            if (rnd() > 1 - t * 0.86) continue;                   // thins out rather than stopping
            const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
            c.fillStyle = rnd() < 0.3 ? rgb(LT.RIM[0]) : rgb(ramp(LT.REG, 0.72 + rnd() * 0.28));
            c.fillRect(Math.round(x), Math.round(y), 1 + ((rnd() * 2) | 0), 1);
          }
        }
      }
    },

    /* ---- WRINKLE RIDGES — the large-scale relief a mare actually has ----
       A plain of nothing but craters reads as a texture with dots on it: every feature is the same
       size and roughly round, so there is no composition at any scale bigger than one crater. Real
       mare basalt is crossed by wrinkle ridges — long, low, sinuous swells, hundreds of px of gentle
       rise, and under a low sun they are the most legible thing out there.

       BUILT AS CHAINABLE SEGMENTS, not drawn per frame. Stamping a ridge pixel by pixel in world
       space would be twenty thousand fillRects a frame; instead each segment sprite carries its
       crest through the vertical CENTRE at both its left and right edges, so any two segments in
       any order join seamlessly and a lane of them is one continuous ridge for the cost of four
       drawImage calls. */
    buildRidges(rnd) {
      /* CHAINED BY ENDPOINT LEVEL, so a lane is not a straight line.
         The first cut gave every segment the same crest height at both edges, which chains
         perfectly — and produces a dead-horizontal ridge running the full width of the world.
         Two of those across a frame read as seams, not landforms. Instead each segment declares a
         START level and an END level from {-1,0,+1}; the placer picks the level per column with a
         hash, so segment N's end always matches segment N+1's start and the lane wanders diagonally
         with no discontinuity anywhere. Wang tiles, essentially, in one dimension. */
      const LT = MOON.LIGHT, W = 320, H = 320, STEP = H * 0.16, out = [];
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const cv = mkCv(W, H), c = cv.getContext('2d');
          const bulge = (H * 0.10) * (rnd() - 0.5) * 2;
          /* WIDER THAN IT LOOKS LIKE IT SHOULD BE. At 42 the swell came out as a dark hairline with
             a faint light edge — a scratch across the plain, not a landform. A wrinkle ridge is a
             low, BROAD buckle: hundreds of metres of rise spread over kilometres, so what makes it
             read is a wide gentle value change, and a narrow one just looks like a crack. */
          const halfW = 74;                                  // SHARED: width must match at the joins
          const wob = rnd() * TAU;
          for (let x = 0; x < W; x++) {
            const u = x / W;
            const s = u * u * (3 - 2 * u);                      // smoothstep between the two levels
            const crest = H / 2 + (a * STEP) + (b - a) * STEP * s
              + bulge * Math.sin(u * Math.PI) * (0.7 + 0.3 * Math.sin(u * Math.PI * 3 + wob));
            const w = halfW * (0.66 + 0.34 * Math.sin(u * Math.PI * 2));   // = 0.66 at both ends
            for (let k = -w; k <= w; k++) {
              const t = k / w;                                 // -1 up-sun flank, +1 down-sun flank
              const edge = 1 - Math.abs(t);
              /* DITHERED FALLOFF. A ridge with an edge is a wall; the swell has to fade into the
                 plain, and the only way to fade without drawing a contour is to thin the stipple. */
              const yy = Math.round(crest + k);
              if (yy < 0 || yy >= H) continue;
              if (h01(x, yy, 98 + a * 3 + b) > edge * 0.92) continue;
              /* the tone runs to the PLAIN'S OWN VALUE at the band's edge, so the thinning stipple
                 there is invisible instead of a scatter of dark specks (which at play zoom read as
                 dirt thrown across the ground, not relief) */
              const lit = 0.65 + (0.12 - t * 0.42) * edge + (h01(x, yy, 55) - 0.5) * 0.12;
              c.fillStyle = rgb(ramp(LT.REG, lit));
              c.fillRect(x, yy, 1, 1);
            }
          }
          out.push({ kind: 'ridge', cv, ox: 0, oy: H / 2, R: W, W, H, a, b, z: -1 });
        }
      }
      return out;
    },

    buildSprites(rnd) {
      const LT = MOON.LIGHT;
      const out = [];
      const add = (kind, cv, ox, oy, R) => out.push({ kind, cv: hardEdge(cv), ox, oy, R });

      /* AGE IS THE VARIABLE THAT MATTERS. A plain where every crater is equally deep and equally
         fresh reads as a stamp repeated, however good the stamp is — and that was the last thing
         wrong with this ground. A real mare holds the whole sequence at once: yesterday's sharp
         bright ray crater, a middle-aged bowl, and a ghost whose rim has been sandblasted almost
         flat. So depth, rim gain, ejecta and rays all ride one `age` value per variant. */

      /* BASINS — the rare big ones, with a rebound peak. One in three is a young ray system. */
      for (let v = 0; v < 4; v++) {
        const R = 62 + Math.round(rnd() * 34);
        const rays = v === 0;
        const S = Math.ceil(R * (rays ? 8.2 : 4.6)), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        MOON.crater(c, cx, cy, R, rnd, { fresh: v < 2, deep: v % 2 === 0, rays });
        add('basin', cv, cx, cy, R);
      }
      /* CRATERS — the everyday size, across the whole age range. */
      for (let v = 0; v < 14; v++) {
        const R = 17 + Math.round(rnd() * 42);
        const rays = v === 1;
        const S = Math.ceil(R * (rays ? 8.2 : 4.6)), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        MOON.crater(c, cx, cy, R, rnd, { fresh: v % 3 !== 2, deep: v % 3 === 0, rays });
        add('crater', cv, cx, cy, R);
      }
      /* GHOSTS — old craters nearly buried: a trace of rim, no shadow worth the name. They are what
         makes the sharp ones look sharp. */
      for (let v = 0; v < 6; v++) {
        const R = 24 + Math.round(rnd() * 48);
        const S = Math.ceil(R * 3.4), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        MOON.crater(c, cx, cy, R, rnd, { fresh: false, ghost: true });
        add('ghost', cv, cx, cy, R);
      }
      /* PITS — small, sharp, everywhere. These are what make the plain feel worked over. */
      for (let v = 0; v < 11; v++) {
        const R = 5 + Math.round(rnd() * 13);
        const S = Math.ceil(R * 4.2), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        MOON.crater(c, cx, cy, R, rnd, { fresh: v % 3 !== 0 });
        add('pit', cv, cx, cy, R);
      }

      /* BOULDERS — lit on the sun side with a LONG hard shadow. They are the counter-evidence to
         the craters: same plain, same light, opposite shading, which is what makes both read. */
      /* THE TADPOLES. These boulders were the worst single feature on the plain: a near-white ball
         with a long thin spike of shadow tapering to a point behind it. Scattered across a mare at
         play zoom they read as tadpoles, or pins stuck in a board. Three separate mistakes:
           - the shadow ran to a POINT. A rock's shadow is a rock-shaped blob dragged sideways; it
             keeps the width of the thing casting it. A triangle to a vertex is a tail.
           - it ran 2.2-4x the rock's radius. Long, but not THAT long, and length is what made it
             a tail rather than a shadow.
           - the cap was LT.RIM[2] — the brightest colour in the ground's whole palette — used on a
             6px object. The brightest thing on a mare is a sunlit crater rim a hundred px across,
             never a pebble, and a bright dot at that scale is just a highlight with no form.
         Now: a swept blob the width of the rock, and a lit facet that is a FACET — angular, sharing
         the rock's own silhouette — so what reads is a chip of stone, not a bead. */
      for (let v = 0; v < 6; v++) {
        const R = 3 + Math.round(rnd() * 6);
        const S = Math.ceil(R * 7), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        const len = R * (1.5 + rnd() * 1.1);
        /* the rock's outline, reused for the body AND the shadow AND the lit facet, so all three
           agree about what shape is standing there */
        const nF = 6 + ((rnd() * 3) | 0), fr = [];
        for (let i = 0; i < nF; i++) fr.push(R * (0.74 + 0.34 * h01(i, v, 29)));
        const poly = (ox, oy, k, squash, style) => {
          c.fillStyle = style;
          c.beginPath();
          for (let i = 0; i <= nF; i++) {
            const a = (i / nF) * TAU, r = fr[i % nF] * k;
            /* squash ACROSS the sun line, not across the screen — a shadow narrows in the direction
               it is thrown, and rotating the squash into the light's frame is what keeps it from
               being an axis-aligned smear. */
            const px = Math.cos(a) * r, py = Math.sin(a) * r * squash;
            const ux = -SUN.x, uy = -SUN.y;                  // down-sun unit vector
            const x = cx + ox + px * ux - py * uy, y = cy + oy + px * uy + py * ux;
            i ? c.lineTo(x, y) : c.moveTo(x, y);
          }
          c.closePath(); c.fill();
        };
        /* ONE TAPERED SHADOW, NOT A STACK. Smearing the silhouette in six equal steps built a
           rounded slab of constant width — the boulders came out as grey PILLS with a brick of
           shadow behind them, which is worse than the tadpoles they replaced. A cast shadow keeps
           the caster's width at the caster and narrows as it runs out, and its far end is ragged
           because the thing throwing it is ragged. Three overlapping polys, each smaller and each
           squashed harder, give exactly that for three fills. */
        for (let s = 3; s >= 1; s--) {
          const t = s / 3;
          poly(-SUN.x * len * t, -SUN.y * len * t, 1 - 0.30 * t, 1 - 0.42 * t, rgb(LT.SHADOW));
        }
        poly(0, 0, 1, 1, rgb(ramp(LT.REG, 0.34)));           // the rock: faceted, never round
        poly(SUN.x * R * 0.32, SUN.y * R * 0.32, 0.56, 1, rgb(ramp(LT.REG, 0.60)));  // the sun-struck facet
        add('rock', cv, cx, cy, R);
      }

      return out;
    },

    /* ---- WHERE THE CRATERS ARE ----
       Three grids at three scales, because a cratered plain IS a scale hierarchy and one grid can
       only ever produce one size of thing evenly spread — the definition of a texture. */
    place(push, x0, y0, x1, y1, clr, scale, pools) {
      /* THE RIDGES FIRST — chained left to right along their lane. Each segment's crest passes
         through its own vertical centre at both edges, so consecutive segments join exactly and
         the lane reads as one ridge running off both sides of the screen. They carry z = -1, so
         the sort paints every crater and boulder over them. */
      const ridges = pools.ridge;
      if (ridges && ridges.length) {
        const W = ridges[0].W || 320, LANE = 880;
        /* the level a lane sits at in column sx — a pure hash, so the segment placed at sx always
           ENDS where the segment at sx+1 STARTS, no matter which column the scan begins from. */
        const level = (lane, sx) => ((h01(sx, lane, 94) * 3) | 0) - 1;
        for (let lane = Math.floor(y0 / LANE) - 1; lane <= Math.ceil(y1 / LANE); lane++) {
          if (h01(lane, 0, 91) > 0.52) continue;               // not every lane carries one
          const laneY = lane * LANE + h01(lane, 1, 92) * LANE * 0.8;
          for (let sx = Math.floor(x0 / W) - 1; sx <= Math.ceil(x1 / W); sx++) {
            const a = level(lane, sx), b = level(lane, sx + 1);
            const sp = ridges.find(r => r.a === a && r.b === b) || ridges[0];
            push(sp, sx * W, laneY);
          }
        }
      }

      /* THE LOD CULL WAS DRAWING THE PEGBOARD. Pits were held back until scale 0.75 and rocks until
         1.1, which is defensible as a cost decision and ruinous as a composition one: zoomed out —
         the view where you can actually see the plain as a place — every small feature vanished and
         all that was left was basins, ghosts and craters, three pools whose sizes overlap. Every
         object on screen was then within a factor of two of every other, which is the definition of
         a texture rather than a landscape. A real size distribution is a power law and its whole
         character lives in the small end, so the small end is exactly the wrong thing to cull.
         Pits now survive to 0.4 (about 200 sprites in a far view — a rounding error next to the
         forest's scatter) and the big pools thin out to make room. */
      const grids = [
        { C: 620, key: 'basin', p: 0.20, salt: 1, lod: 0 },
        { C: 300, key: 'ghost', p: 0.34, salt: 5, lod: 0 },
        { C: 190, key: 'crater', p: 0.36, salt: 2, lod: 0 },
        { C: 74, key: 'pit', p: 0.50, salt: 3, lod: 0.4 },
        { C: 92, key: 'rock', p: 0.30, salt: 4, lod: 0.7 },
      ];
      for (const g of grids) {
        if (scale < g.lod) continue;
        const arr = pools[g.key];
        if (!arr || !arr.length) continue;
        const cx0 = Math.floor(x0 / g.C), cx1 = Math.ceil(x1 / g.C);
        const cy0 = Math.floor(y0 / g.C), cy1 = Math.ceil(y1 / g.C);
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            if (h01(cx, cy, g.salt) > g.p) continue;
            const wx = (cx + h01(cx, cy, g.salt + 40)) * g.C;
            const wy = (cy + h01(cx, cy, g.salt + 50)) * g.C;
            /* THE PAD: the station sits on cleared, graded ground. Craters are suppressed under it
               for the same reason trees are — a rim running through the floor plan reads as a
               drawing laid over a picture. */
            if (clr && wx > clr.x && wx < clr.x + clr.w && wy > clr.y && wy < clr.y + clr.h) continue;
            push(arr[(h01(cx, cy, g.salt + 60) * arr.length) | 0], wx, wy);
          }
        }
      }
    },
  };

  /* ---------------------------------------------------------------------- registry ---- */

  const GROUNDS = { forest: FOREST, moon: MOON };
  const ORDER = ['forest', 'moon'];
  const has = id => Object.prototype.hasOwnProperty.call(GROUNDS, id);

  /* ---------------------------------------------------------------------- dispatch ---- */

  let curId = null;                          // null == no ground; the station is flying, spacebg owns the frame
  let st = null, builtId = '';

  function build(id) {
    const G = GROUNDS[id];
    const rnd = mulberry32(0x0FE57);         // fixed: the ground is a place, not a dice roll
    const patchCv = G.buildPatch(rnd);
    const dappleCv = G.buildOverlay ? G.buildOverlay(rnd) : null;
    const sprites = G.buildSprites(rnd).concat(G.buildRidges ? G.buildRidges(rnd) : []);
    const pools = {};
    for (const s of sprites) (pools[s.kind] || (pools[s.kind] = [])).push(s);
    st = { patchCv, dappleCv, pattern: null, dapplePat: null, sprites, pools };
    builtId = id;
  }

  /* THROW THE BUILT GROUND AWAY so the next draw() rebuilds it — the SpaceBG.invalidate story,
     for the landed case. The deck patch, the dapple overlay and every tree/ridge sprite are
     offscreen canvases built once; a GPU reset zeroes their pixels without touching the objects,
     and the two CanvasPatterns cached on `st` keep pointing at the now-blank plates, so the floor
     fills with nothing and the station stands on the void. Dropping `st` drops the patterns with
     it, which is why this is a null and not a per-canvas repaint. */
  function invalidate() {
    st = null; builtId = '';
  }

  // verify/test hook — the SpaceBG._dbgLosePixels story: zero every built plate in place
  // (objects and sizes intact, pixels gone) to reproduce a GPU reset without one.
  function _dbgLosePixels() {
    let n = 0;
    if (!st) return n;
    const wipe = c => {
      if (!c || typeof HTMLCanvasElement === 'undefined' || !(c instanceof HTMLCanvasElement)) return;
      try { const g = c.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height); n++; } catch (_) {}
    };
    wipe(st.patchCv); wipe(st.dappleCv);
    for (const s of (st.sprites || [])) wipe(s && s.cv);
    return n;
  }

  /* one scatter item, reused: the draw loop fills a pooled array rather than allocating
     thousands of objects per frame. */
  const ITEMS = [];
  let itemN = 0;
  const pushItem = (sp, x, y) => {
    const it = ITEMS[itemN] || (ITEMS[itemN] = { sp: null, x: 0, y: 0 });
    it.sp = sp; it.x = x; it.y = y; itemN++;
  };

  /* Draw the ground under the CURRENT world transform. Callers must already have applied
     setTransform(scale,0,0,scale,panX,panY) — that is what makes this pan and zoom for free.
     `station` is the bake's world rect and may be null before the first bake, in which case
     nothing is cleared and the ground simply closes over. */
  function draw(ctx, cam, cw, ch, station) {
    const id = curId;
    if (!id || !has(id)) return;
    if (builtId !== id || !st) build(id);
    const G = GROUNDS[id];

    const s = (cam && cam.scale) || 1;
    const px = (cam && cam.panX) || 0, py = (cam && cam.panY) || 0;
    const pad = G.CELL * 3;
    const x0 = -px / s - pad, y0 = -py / s - pad;
    const x1 = (cw - px) / s + pad, y1 = (ch - py) / s + pad;

    // 1. THE FLOOR — one fill through a repeating pattern, in the current transform space, so it
    // scales with the world exactly like the station bake does.
    if (!st.pattern) st.pattern = ctx.createPattern(st.patchCv, 'repeat');
    if (st.pattern) { ctx.fillStyle = st.pattern; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }
    else { ctx.fillStyle = G.base; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }

    // 2. THE OVERLAY — light that lands ON the floor (canopy dapple, ray ejecta), additive and
    // drawn before anything stands on it.
    if (st.dappleCv) {
      if (!st.dapplePat) st.dapplePat = ctx.createPattern(st.dappleCv, 'repeat');
      if (st.dapplePat) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = G.OVERLAY_ALPHA || 0.34;
        ctx.fillStyle = st.dapplePat; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.restore();
      }
    }

    /* the CLEARING: the station's footprint plus a margin, kept free of anything tall. The rect is
       passed in rather than assumed at the origin — world.js blits the bake at (0,0) but REFIT
       blits it at cache.origin, and a clearing in the wrong place is worse than none. */
    const clr = station ? {
      x: (station.x || 0) - G.CELL * 0.5, y: (station.y || 0) - G.CELL * 0.5,
      w: station.w + G.CELL, h: station.h + G.CELL,
    } : null;

    // 3. THE SCATTER. Hashed per cell — no stored map, no growth over time, and stable: the same
    // cell always yields the same thing, so panning away and back finds the place unchanged. Each
    // ground owns its own placement rules; a forest and a cratered plain share nothing but the
    // hash, the pools and the y-sort.
    itemN = 0;
    G.place(pushItem, x0, y0, x1, y1, clr, s, st.pools);

    /* Y-SORT. Overlap is the only cue that says "canopy" instead of "stickers on a table": a near
       crown must cover the one behind it, and undergrowth must sit under the tree it grows beside.
       Sorting by world y is exactly the painter's order for a top-down-with-a-tilt camera. */
    const view = ITEMS.slice(0, itemN);
    /* z first, then y: a wrinkle ridge is RELIEF IN the ground, so anything that stands ON the
       ground must paint over it regardless of where it sits. */
    view.sort((a, b) => ((a.sp.z || 0) - (b.sp.z || 0)) || (a.y - b.y));
    for (let i = 0; i < view.length; i++) {
      const it = view[i], sp = it.sp;
      ctx.drawImage(sp.cv, Math.round(it.x - sp.ox), Math.round(it.y - sp.oy));
    }
  }

  /* how close a cell is to the clearing's edge, 0..1 — used to thicken the undergrowth around the
     station. A real clearing has a wall of growth at its rim; a hard cut with nothing at the edge
     reads as a mask, which is what it is. */
  function nearClearing(clr, wx, wy, C) {
    const dx = Math.max(clr.x - wx, 0, wx - (clr.x + clr.w));
    const dy = Math.max(clr.y - wy, 0, wy - (clr.y + clr.h));
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= 0 || d > C * 2.5) return 0;
    return 1 - d / (C * 2.5);
  }

  /* set the ground. Anything that is not a known ground id (a SKY id, or nothing) turns the layer
     OFF — spacebg then owns the frame, which is what "the station is flying" means. */
  function setGround(id) { curId = has(id) ? id : null; return curId; }
  const getGround = () => curId;
  const active = () => !!(curId && has(curId));
  const baseColor = () => (active() ? GROUNDS[curId].base : '#040302');
  const list = () => ORDER.map(id => ({ id, label: GROUNDS[id].label, blurb: GROUNDS[id].blurb || '', ground: true }));

  /* The picker's swatch: the REAL renderer, never a stand-in, so a preview cannot promise a place
     the station won't deliver.

     BUILT AT A REFERENCE SIZE AND SCALED DOWN, which is the same law the sky swatches learned:
     drawing straight into a 112x63 chip shows one third of one tree crown, because the features
     are sized in WORLD px and the chip is a tiny window onto the world — not a small picture of
     it. Rendering a proper 4x view and shrinking it shows the place instead of a close-up of its
     dirt.

     MEMOISED, because a sample costs a whole ground BUILD. `st = null` below forces build(id) to
     regenerate the patch, the overlay and every sprite pool before it can draw one chip — measured
     live on a seeded station at 112x63: moon 400ms, forest 150ms, and SETTINGS repainted all six
     swatches on EVERY build of the panel (open, tab swap, any rerender). The inputs are fully
     deterministic (fixed seed 0x0FE57, no camera, no clock, no theme), so the cached chip is
     bit-identical to a fresh render — this caches the REAL renderer's output, it does not stand in
     for it, and the honesty law is intact. Keyed by id+size+zoom so a differently-sized picker
     still renders its own. */
  const sampleChips = new Map();
  function paintSample(ctx, w, h, id, zoom) {
    if (!has(id)) return;
    const z = zoom || 0.9;
    const key = id + '|' + w + '|' + h + '|' + z;
    let chip = sampleChips.get(key);
    if (!chip) {
      const keep = curId, keepSt = st, keepId = builtId;
      curId = id; st = null; builtId = '';
      const RW = Math.max(w, 448), RH = Math.round(RW * h / w);
      const ref = mkCv(RW, RH), rc = ref.getContext('2d');
      rc.fillStyle = GROUNDS[id].base; rc.fillRect(0, 0, RW, RH);
      rc.imageSmoothingEnabled = false;
      rc.setTransform(z, 0, 0, z, 0, 0);
      draw(rc, { scale: z, panX: 0, panY: 0 }, RW, RH, null);
      rc.setTransform(1, 0, 0, 1, 0, 0);
      chip = mkCv(w, h);
      const cc = chip.getContext('2d');
      cc.imageSmoothingEnabled = true;                 // a smooth downscale, per the sprite law
      cc.drawImage(ref, 0, 0, RW, RH, 0, 0, w, h);
      sampleChips.set(key, chip);
      curId = keep; st = keepSt; builtId = keepId;
    }
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(chip, 0, 0);
    ctx.restore();
  }

  return { draw, setGround, getGround, active, baseColor, list, paintSample, invalidate, _dbgLosePixels, GROUNDS };
})();
