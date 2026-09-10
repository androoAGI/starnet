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
  /* FOREST v3 — a FULL REDESIGN (Andrew, 2026-09-09: "i want a full new redesign of the forest").

     THE TWO FORESTS BEFORE IT, and why neither is the model:
       v1 (07-24) was "too blurry... just looks like an outline of a forest": anti-aliased arcs.
       v2 (07-24 → 09-09) fixed that with hundreds of hard 1-3px LEAF STAMPS per crown over a dark
       duff floor. Correct about every rule, and on a live station it still read as one dark green-
       brown mass: at play zoom every stamp is a 2x2 block of confetti, the crowns had no clean
       silhouette to separate them, and the floor was shade on shade. Lifting the ramps (the first
       pass of this day) made it a brighter mush.

     WHAT THIS IS INSTEAD: an open daylight woodland drawn the way top-down pixel art draws woods.
       1. A CROWN IS A SHAPE, NOT A CLOUD OF LEAVES. Each tree is a lobed silhouette filled with
          FOUR FLAT TONES — deep shade, mid, light, highlight — banded by a dome term (the middle
          of the crown is nearer the sun than its edge) plus the SUN term (top-left), plus a
          cauliflower of sub-lobes so the bands break into leaf clusters. Every band edge is a
          hard pixel step; there is no per-leaf noise for the zoom to smear. A dark contact
          shadow, offset down-sun and dithered at its edge, lifts every crown off the floor and
          off its neighbours.
       2. THE FLOOR IS LIT GRASS. Sunlit woodland floor is grass and bare earth, not duff: a
          five-step green ramp dithered by two octaves, short grass STROKES (the classic pixel
          grass tooth), bare-earth patches with dithered edges, pebbles with their shadow, and a
          few flowers in the open — the only pure hue accents on the ground.
       3. A STREAM. Chained bank-to-bank segments (the moon's wrinkle-ridge Wang-tile trick, one
          dimension): dark wet banks, a two-tone channel, light ripple lines along the flow and a
          few glints. It wanders, it never crosses the station's clearing, and it is the one long
          feature that makes the wood a PLACE rather than a texture.
       4. FIVE SPECIES BY SILHOUETTE AND HUE: broadleaf (green), conifer (blue-green, spiked),
          autumn (rust-gold), birch (pale yellow-green, trunk showing), and dead snags. Bushes,
          ferns, logs, stumps and boulders fill the undergrowth in the same flat-tone language.
     Scale reference (measured, unchanged): an agent body is ~35 world px, ONE WORLD PIXEL ≈ 5cm.
     The station must remain the brightest thing on screen: the floor's mean sits near 45% of the
     station's floor, the highlight tone is the only thing that goes above 60% and it is small. */

  const FOREST = {
    label: 'FOREST',
    blurb: 'Landed in open woodland. Grass, a stream, and the trees closing in.',
    base: '#2c4a26',
    PATCH: 512,                       // world px of the tiling floor texture
    CELL: 64,                         // world px per scatter cell (~5 station tiles)
    BODY_PX: 35.42,                   // an agent body, world px — the yardstick for everything here
    STREAM: { W: 320, H: 320, LANE: 1100, P: 0.4 },   // lane 0 always runs; the rest are rare, so one stream, not a moat

    LIGHT: {
      GRASS: [[34, 62, 30], [44, 78, 36], [56, 96, 42], [70, 114, 50], [88, 132, 58]],
      GRASS_HI: [108, 152, 66], GRASS_LO: [28, 52, 26],
      EARTH: [[64, 48, 30], [86, 64, 40], [108, 82, 50], [132, 104, 64]],
      SHADOW: [24, 46, 28],                                       // cast + contact shade, opaque
      CROWN: [[22, 52, 30], [40, 92, 44], [72, 132, 58], [120, 176, 80]],
      CONIFER: [[14, 40, 34], [24, 66, 50], [42, 96, 68], [76, 128, 92]],
      AUTUMN: [[86, 40, 18], [150, 72, 26], [204, 120, 40], [236, 178, 74]],
      BIRCH: [[60, 96, 40], [104, 146, 62], [150, 186, 86], [198, 216, 122]],
      BUSH: [[26, 60, 32], [46, 100, 48], [80, 138, 62], [124, 178, 84]],
      DEAD: [[46, 38, 28], [78, 66, 48], [116, 100, 74], [150, 134, 104]],
      TRUNK: [78, 56, 36], TRUNK_HI: [124, 96, 64], PALE: [176, 168, 148],
      ROCK: [[58, 62, 58], [92, 96, 90], [126, 130, 122], [164, 168, 156]],
      /* ⛔ WATER MUST BE BRIGHT. The first cut ran [26,70,104]→[72,146,176] and the CRT pass
         crushed it to a brown band nobody could tell from bare earth — 800 blue pixels in a frame
         where the stream crossed it. A stream in the open reflects the SKY: it is the brightest,
         bluest thing on the floor. */
      WATER: [[44, 104, 150], [66, 142, 186], [110, 190, 218]], GLINT: [228, 244, 250],
      BANK: [40, 70, 40], BANK_WET: [104, 88, 58],
      FLOWERS: [[232, 84, 104], [242, 222, 96], [226, 228, 242], [164, 122, 224]],
    },

    /* ---- the tiling floor: lit grass, earth, strokes, pebbles, flowers ---- */
    buildPatch(rnd) {
      const P = FOREST.PATCH, LT = FOREST.LIGHT;
      const cv = mkCv(P, P), c = cv.getContext('2d');
      const img = c.createImageData(P, P), D = img.data;
      const idx = (x, y) => (((((y | 0) % P) + P) % P) * P + ((((x | 0) % P) + P) % P)) * 4;
      const put = (x, y, col) => { const i = idx(x, y); D[i] = col[0]; D[i + 1] = col[1]; D[i + 2] = col[2]; };
      const shade = (x, y, f) => { const i = idx(x, y); D[i] *= f; D[i + 1] *= f + (1 - f) * 0.25; D[i + 2] *= f; };

      // 1. grass: two octaves + a per-pixel hash, dithered onto the five-step ramp
      const g1 = noiseField(6, rnd), g2 = noiseField(19, rnd), earthF = noiseField(4, rnd), tuftF = noiseField(9, rnd);
      let p = 0;
      for (let y = 0; y < P; y++) {
        for (let x = 0; x < P; x++, p += 4) {
          const u = x / P, v = y / P;
          const t = g1(u, v) * 0.55 + g2(u, v) * 0.30 + h01(x, y, 5) * 0.15;
          const col = dither(LT.GRASS, t * 1.1 - 0.05, x, y, 13);
          D[p] = col[0]; D[p + 1] = col[1]; D[p + 2] = col[2]; D[p + 3] = 255;
        }
      }
      // 2. bare earth where the grass gives out — a hard threshold with a DITHERED boundary
      for (let y = 0; y < P; y++) {
        for (let x = 0; x < P; x++) {
          const e = earthF(x / P, y / P) + (h01(x, y, 21) - 0.5) * 0.10;
          if (e < 0.62) continue;
          put(x, y, dither(LT.EARTH, 0.25 + (e - 0.62) * 2.2 + (h01(x, y, 23) - 0.5) * 0.4, x, y, 27));
        }
      }
      // 3. grass STROKES — short 2-3px vertical marks, lighter tip, darker root: the pixel-grass tooth
      for (let i = 0; i < 9000; i++) {
        const x = (rnd() * P) | 0, y = (rnd() * P) | 0;
        if (earthF(x / P, y / P) > 0.60) continue;                  // not on bare earth
        if (rnd() > 0.35 + tuftF(x / P, y / P) * 0.65) continue;   // gathered, not even
        const len = 2 + ((rnd() * 2) | 0);
        for (let k = 0; k < len; k++) put(x, y - k, k === len - 1 ? LT.GRASS_HI : k === 0 ? LT.GRASS_LO : ramp(LT.GRASS, 0.75));
      }
      // 4. pebbles — lit top, shadow below; rare
      for (let i = 0; i < 140; i++) {
        const x = (rnd() * P) | 0, y = (rnd() * P) | 0, s = 1 + ((rnd() * 2) | 0);
        for (let k = 0; k <= s; k++) shade(x + k, y + s, 0.62);
        for (let yy = 0; yy < s; yy++) for (let xx = 0; xx <= s; xx++) put(x + xx, y + yy, ramp(LT.ROCK, yy === 0 ? 0.8 : 0.4));
      }
      // 5. flowers — in the open grass only, a 2px head with a lighter centre; the floor's hue accents
      // ⛔ in CLUMPS of one colour, never single scattered heads — one 2px head per colour at play
      // zoom is a coloured speck the CRT turns into static; three heads together are a plant.
      for (let i = 0; i < 70; i++) {
        const x = (rnd() * P) | 0, y = (rnd() * P) | 0;
        if (earthF(x / P, y / P) > 0.58 || tuftF(x / P, y / P) < 0.45) continue;
        const col = LT.FLOWERS[(rnd() * LT.FLOWERS.length) | 0];
        for (let k = 0, n = 2 + ((rnd() * 3) | 0); k < n; k++) {
          const fx = (x + (rnd() - 0.5) * 9) | 0, fy = (y + (rnd() - 0.5) * 7) | 0;
          put(fx, fy, col); put(fx + 1, fy, col); put(fx, fy + 1, col); put(fx + 1, fy + 1, col);
          put(fx, fy, mix(col, [255, 255, 255], 0.4));
          put(fx, fy + 2, LT.GRASS_LO);
        }
      }
      c.putImageData(img, 0, 0);
      return cv;
    },

    /* ---- THE CROWN: a lobed silhouette in four flat tones ----
       `pal` is [shade, mid, light, hi]; `o.teeth` gives a conifer's spiked outline; `o.lobes` the
       number of sub-domes; `o.shadow` false skips the cast shadow (bushes on the floor). */
    crown(c, cx, cy, R, pal, rnd, opt) {
      const o = opt || {}, LT = FOREST.LIGHT;
      const K = 96, rad = new Float32Array(K);
      if (o.teeth) {
        const jag = 0.28 + rnd() * 0.12, ph = rnd() * TAU;
        for (let i = 0; i < K; i++) {
          const th = (i / K) * TAU;
          const saw = Math.abs(((th * o.teeth + ph) / Math.PI) % 2 - 1);
          rad[i] = R * (1 - jag * saw) * (0.94 + 0.12 * h01(i, o.teeth, 3));
        }
      } else {
        const a1 = 0.10 + rnd() * 0.10, a2 = 0.06 + rnd() * 0.08, a3 = 0.03 + rnd() * 0.05;
        const p1 = rnd() * TAU, p2 = rnd() * TAU, p3 = rnd() * TAU;
        const m1 = 3 + ((rnd() * 2) | 0), m2 = 5 + ((rnd() * 3) | 0), m3 = 9 + ((rnd() * 5) | 0);
        for (let i = 0; i < K; i++) {
          const th = (i / K) * TAU;
          rad[i] = R * (1 - a1 - a2 - a3 + a1 * (1 + Math.sin(th * m1 + p1)) + a2 * (1 + Math.sin(th * m2 + p2)) + a3 * (1 + Math.sin(th * m3 + p3)));
        }
      }
      const radAt = th => {
        const f = ((th % TAU) + TAU) % TAU / TAU * K;
        const i0 = Math.floor(f) % K, i1 = (i0 + 1) % K, t = f - Math.floor(f);
        return rad[i0] + (rad[i1] - rad[i0]) * t;
      };
      // sub-lobes: the cauliflower. Each is a small dome; a pixel takes the nearest lobe's height.
      const lobes = [];
      for (let i = 0, n = o.lobes == null ? 6 + ((rnd() * 5) | 0) : o.lobes; i < n; i++) {
        const a = rnd() * TAU, d = Math.pow(rnd(), 0.6) * R * 0.72;
        lobes.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d, R * (0.28 + rnd() * 0.30)]);
      }
      const B = Math.ceil(R * 1.35) + 3;
      // 1. the cast shadow: the silhouette dragged down-sun, opaque, edge dithered away
      if (o.shadow !== false) {
        const ox = -SUN.x * R * 0.36, oy = -SUN.y * R * 0.42;
        c.fillStyle = rgb(LT.SHADOW);
        for (let y = -B; y <= B; y++) {
          for (let x = -B; x <= B; x++) {
            const d = Math.hypot(x - ox, y - oy), e = radAt(Math.atan2(y - oy, x - ox)) * 0.98;
            if (d > e) continue;
            if (d > e - 2.5 && h01(x, y, 41) > 0.45) continue;   // ragged edge, never a hard disc
            c.fillRect(Math.round(cx + x), Math.round(cy + y), 1, 1);
          }
        }
      }
      // 2. the crown: four flat tones from dome + sun + the nearest sub-lobe
      for (let y = -B; y <= B; y++) {
        for (let x = -B; x <= B; x++) {
          const d = Math.hypot(x, y), e = radAt(Math.atan2(y, x));
          if (d > e) continue;
          const k = d / e, dome = Math.sqrt(Math.max(0, 1 - k * k));
          const side = (x * SUN.x + y * SUN.y) / R;                 // +1 toward the sun (up-left)
          let lobe = 0, lobeSide = 0;
          for (const [lx, ly, lr] of lobes) {
            const dd = Math.hypot(cx + x - lx, cy + y - ly) / lr;
            if (dd < 1) { const hgt = Math.sqrt(1 - dd * dd); if (hgt > lobe) { lobe = hgt; lobeSide = ((cx + x - lx) * SUN.x + (cy + y - ly) * SUN.y) / lr; } }
          }
          let lit = 0.30 + 0.30 * dome + 0.42 * side + 0.22 * lobe + 0.26 * lobeSide + (o.boost || 0);
          lit += (h01(x, y, 47) - 0.5) * 0.10;                      // a whisper of tooth in the bands
          const step = lit < 0.30 ? 0 : lit < 0.55 ? 1 : lit < 0.80 ? 2 : 3;
          c.fillStyle = rgb(pal[step]);
          c.fillRect(Math.round(cx + x), Math.round(cy + y), 1, 1);
        }
      }
      // 3. the down-sun rim: one pixel of the deepest tone just inside the outline, so the crown
      //    separates from whatever its shadow does not cover
      c.fillStyle = rgb(pal[0]);
      for (let i = 0; i < K; i++) {
        const th = (i / K) * TAU, facing = Math.cos(th) * SUN.x + Math.sin(th) * SUN.y;
        if (facing > -0.15) continue;
        const r = rad[i] - 0.8;
        c.fillRect(Math.round(cx + Math.cos(th) * r), Math.round(cy + Math.sin(th) * r), 1, 1);
      }
    },

    /* ---- the scatter sprites: pre-rendered once, then one drawImage per instance ---- */
    buildSprites(rnd) {
      const LT = FOREST.LIGHT;
      const out = [];
      const add = (kind, cv, ox, oy, R) => out.push({ kind, cv: hardEdge(cv), ox, oy, R });
      const sprite = (R, mult) => { const S = Math.ceil(R * (mult || 3.2)), cv = mkCv(S, S); return [cv, cv.getContext('2d'), S / 2]; };

      // BROADLEAF — the money silhouette. Seven variants across a third of the ramp.
      for (let v = 0; v < 7; v++) {
        const R = 16 + Math.round(rnd() * 22), [cv, c, m] = sprite(R);
        FOREST.crown(c, m, m, R, LT.CROWN, rnd, { boost: -0.10 + v * 0.03 });
        add('tree', cv, m, m, R);
      }
      // EMERGENTS — a few giants, so the canopy has a size hierarchy
      for (let v = 0; v < 3; v++) {
        const R = 42 + Math.round(rnd() * 14), [cv, c, m] = sprite(R, 3.0);
        FOREST.crown(c, m, m, R, LT.CROWN, rnd, { boost: 0.06, lobes: 11 });
        add('emergent', cv, m, m, R);
      }
      // CONIFER — spiked outline, cool ramp, lit apex
      for (let v = 0; v < 5; v++) {
        const R = 14 + Math.round(rnd() * 18), [cv, c, m] = sprite(R, 3.0);
        FOREST.crown(c, m, m, R, LT.CONIFER, rnd, { teeth: 11 + ((rnd() * 6) | 0), lobes: 4, boost: -0.04 + v * 0.02 });
        c.fillStyle = rgb(LT.CONIFER[3]); c.fillRect(Math.round(m - R * 0.06) - 1, Math.round(m - R * 0.06) - 1, 2, 2);
        add('conifer', cv, m, m, R);
      }
      // AUTUMN — the warm crown, one in eight trees
      for (let v = 0; v < 4; v++) {
        const R = 16 + Math.round(rnd() * 16), [cv, c, m] = sprite(R);
        FOREST.crown(c, m, m, R, LT.AUTUMN, rnd, { boost: v * 0.03 });
        add('autumn', cv, m, m, R);
      }
      // BIRCH — pale, open, the trunk showing straight down the middle
      for (let v = 0; v < 4; v++) {
        const R = 14 + Math.round(rnd() * 10), [cv, c, m] = sprite(R);
        FOREST.crown(c, m, m, R, LT.BIRCH, rnd, { lobes: 5, boost: 0.04 });
        c.fillStyle = rgb(LT.PALE); c.fillRect(Math.round(m) - 1, Math.round(m) - 1, 3, 3);
        c.fillStyle = rgb(LT.TRUNK); c.fillRect(Math.round(m) + 1, Math.round(m) + 1, 1, 1);
        add('birch', cv, m, m, R);
      }
      // SNAG — a dead tree: bare forking limbs and a long shadow, bone-pale against the green
      for (let v = 0; v < 3; v++) {
        const R = 12 + Math.round(rnd() * 9), [cv, c, m] = sprite(R, 3.0);
        const limbs = [];
        for (let i = 0, n = 5 + ((rnd() * 4) | 0); i < n; i++) limbs.push({ a: (i / n) * TAU + rnd() * 0.6, len: R * (0.55 + 0.45 * rnd()), fork: rnd() < 0.6 });
        const drawLimbs = (ox, oy, style, wmul) => {
          c.strokeStyle = style; c.lineCap = 'butt';
          for (const L of limbs) {
            c.lineWidth = Math.max(1.5, R * 0.11 * wmul);
            c.beginPath(); c.moveTo(ox, oy); c.lineTo(ox + Math.cos(L.a) * L.len, oy + Math.sin(L.a) * L.len); c.stroke();
            if (!L.fork) continue;
            c.lineWidth = Math.max(1, R * 0.06 * wmul);
            for (const s of [-1, 1]) {
              const bx = ox + Math.cos(L.a) * L.len * 0.62, by = oy + Math.sin(L.a) * L.len * 0.62;
              c.beginPath(); c.moveTo(bx, by); c.lineTo(bx + Math.cos(L.a + s * 0.7) * L.len * 0.38, by + Math.sin(L.a + s * 0.7) * L.len * 0.38); c.stroke();
            }
          }
        };
        drawLimbs(m - SUN.x * R * 0.5, m - SUN.y * R * 0.55, rgb(LT.SHADOW), 1);
        drawLimbs(m, m, rgb(LT.DEAD[2]), 1);
        c.fillStyle = rgb(LT.DEAD[3]); c.fillRect(Math.round(m) - 1, Math.round(m) - 1, 3, 3);
        add('snag', cv, m, m, R);
      }
      // BUSHES — small crowns on the floor, no cast shadow of their own worth drawing
      for (let v = 0; v < 5; v++) {
        const R = 5 + Math.round(rnd() * 5), [cv, c, m] = sprite(R, 3.4);
        FOREST.crown(c, m, m, R, LT.BUSH, rnd, { lobes: 4, shadow: v > 1 });
        add('bush', cv, m, m, R);
      }
      // FERNS — a rosette of arcing fronds in two tones, tapered
      for (let v = 0; v < 4; v++) {
        const R = 6 + Math.round(rnd() * 5), [cv, c, m] = sprite(R, 3.2);
        for (let i = 0, n = 6 + ((rnd() * 4) | 0); i < n; i++) {
          const a0 = rnd() * TAU, len = R * (0.65 + 0.35 * rnd()), bow = (rnd() < 0.5 ? -1 : 1) * (0.3 + rnd() * 0.4);
          const lit = (Math.cos(a0) * SUN.x + Math.sin(a0) * SUN.y) > 0 ? 2 : 1;
          for (let s = 0; s <= len; s += 0.6) {
            const t = s / len, a = a0 + bow * t * t, wid = t < 0.7 ? 1 : 0;
            c.fillStyle = rgb(LT.BUSH[lit]);
            c.fillRect(Math.round(m + Math.cos(a) * s), Math.round(m + Math.sin(a) * s), 1 + wid, 1);
          }
        }
        add('fern', cv, m, m, R);
      }
      // LOGS — a lit top flank, a shaded side, the pale end grain, a hard shadow
      for (let v = 0; v < 4; v++) {
        const len = 26 + Math.round(rnd() * 30), rad = 3 + Math.round(rnd() * 2), ang = rnd() * Math.PI;
        const S = Math.ceil(len * 1.5), cv = mkCv(S, S), c = cv.getContext('2d'), m = S / 2;
        c.save(); c.translate(m, m); c.rotate(ang);
        c.fillStyle = rgb(LT.SHADOW); c.fillRect(-len / 2 + 3, -rad + 3, len, rad * 2);
        c.fillStyle = rgb(LT.TRUNK); c.fillRect(-len / 2, -rad, len, rad * 2);
        c.fillStyle = rgb(LT.TRUNK_HI); c.fillRect(-len / 2, -rad, len, Math.max(1, rad));
        c.fillStyle = rgb(LT.PALE); c.fillRect(-len / 2 - 1, -rad, 2, rad * 2);
        for (let i = 0; i < len * 0.4; i++) { c.fillStyle = rgb(LT.BUSH[1]); c.fillRect(Math.round(-len / 2 + rnd() * len), Math.round(-rad + rnd() * rad * 0.9), 1 + ((rnd() * 2) | 0), 1); }
        c.restore();
        add('log', cv, m, m, len / 2);
      }
      // STUMPS — the one man-made mark: a pale disc with rings
      for (let v = 0; v < 2; v++) {
        const R = 5 + Math.round(rnd() * 3), [cv, c, m] = sprite(R, 4);
        c.fillStyle = rgb(LT.SHADOW); c.beginPath(); c.ellipse(m - SUN.x * R * 0.4, m - SUN.y * R * 0.4, R * 1.05, R * 0.9, 0, 0, TAU); c.fill();
        c.fillStyle = rgb(LT.TRUNK); c.beginPath(); c.arc(m, m, R, 0, TAU); c.fill();
        c.fillStyle = rgb(LT.PALE); c.beginPath(); c.arc(m, m, R * 0.8, 0, TAU); c.fill();
        c.strokeStyle = rgb(LT.TRUNK_HI); c.lineWidth = 1;
        for (let k = 1; k <= 2; k++) { c.beginPath(); c.arc(m, m, R * 0.8 * (k / 3), 0, TAU); c.stroke(); }
        add('stump', cv, m, m, R);
      }
      // BOULDERS — faceted, cool grey, with a moss cap and a hard shadow
      for (let v = 0; v < 4; v++) {
        const R = 7 + Math.round(rnd() * 8), [cv, c, m] = sprite(R, 3.2);
        c.fillStyle = rgb(LT.SHADOW); c.beginPath(); c.ellipse(m - SUN.x * R * 0.45, m - SUN.y * R * 0.5, R * 0.95, R * 0.66, 0, 0, TAU); c.fill();
        const NF = 7, vr = [];
        for (let i = 0; i < NF; i++) vr.push(R * (0.78 + 0.30 * h01(i, v, 17)));
        for (let i = 0; i < NF; i++) {
          const a0 = (i / NF) * TAU, a1 = ((i + 1) / NF) * TAU, am = (a0 + a1) / 2;
          const face = Math.cos(am) * SUN.x + Math.sin(am) * SUN.y;
          c.fillStyle = rgb(ramp(LT.ROCK, 0.35 + 0.5 * face));
          c.beginPath();
          c.moveTo(m + Math.cos(am) * R * 0.12, m + Math.sin(am) * R * 0.12);
          c.lineTo(m + Math.cos(a0) * vr[i], m + Math.sin(a0) * vr[i]);
          c.lineTo(m + Math.cos(a1) * vr[(i + 1) % NF], m + Math.sin(a1) * vr[(i + 1) % NF]);
          c.closePath(); c.fill();
        }
        c.fillStyle = rgb(LT.ROCK[3]);
        c.beginPath();
        for (let i = 0; i < NF; i++) { const a = (i / NF) * TAU, r = vr[i] * 0.34; const x = m + SUN.x * R * 0.16 + Math.cos(a) * r, y = m + SUN.y * R * 0.16 + Math.sin(a) * r; i ? c.lineTo(x, y) : c.moveTo(x, y); }
        c.closePath(); c.fill();
        for (let i = 0, n = Math.round(R * R * 0.25); i < n; i++) { const a = rnd() * TAU, d = R * Math.pow(rnd(), 0.7) * 0.7; c.fillStyle = rgb(LT.BUSH[1 + ((rnd() * 2) | 0)]); c.fillRect(Math.round(m + Math.cos(a) * d + SUN.x * R * 0.2), Math.round(m + Math.sin(a) * d + SUN.y * R * 0.2), 1, 1); }
        add('rock', cv, m, m, R);
      }
      return out;
    },

    /* ---- THE STREAM: chained segments (the moon's ridge trick) — each carries its channel through
            the vertical centre at both edges, at a START level and an END level from {-1,0,+1}, so
            the placer's per-column hash makes the lane wander with no discontinuity anywhere. ---- */
    buildRidges(rnd) {
      const LT = FOREST.LIGHT, ST = FOREST.STREAM, W = ST.W, H = ST.H, STEP = H * 0.16, out = [];
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const cv = mkCv(W, H), c = cv.getContext('2d');
          const img = c.createImageData(W, H), D = img.data;
          const put = (x, y, col) => { if (x < 0 || x >= W || y < 0 || y >= H) return; const i = (y * W + x) * 4; D[i] = col[0]; D[i + 1] = col[1]; D[i + 2] = col[2]; D[i + 3] = 255; };
          const bulge = (H * 0.08) * (rnd() - 0.5) * 2, wob = rnd() * TAU;
          const halfW = 13;                                  // SHARED: width must match at the joins
          for (let x = 0; x < W; x++) {
            const u = x / W, s = u * u * (3 - 2 * u);
            const centre = H / 2 + (a * STEP) + (b - a) * STEP * s + bulge * Math.sin(u * Math.PI) * (0.7 + 0.3 * Math.sin(u * Math.PI * 3 + wob));
            const wdt = halfW * (0.72 + 0.28 * Math.sin(u * Math.PI * 2 + 1.3)) + (h01(x >> 2, a * 3 + b, 61) - 0.5) * 3;
            const cy = Math.round(centre);
            for (let k = -Math.ceil(wdt) - 3; k <= Math.ceil(wdt) + 3; k++) {
              const y = cy + k, t = Math.abs(k) / wdt;
              if (t > 1) {                                       // the banks: wet earth, then a dark grass lip
                if (t < 1 + 1.6 / wdt) put(x, y, LT.BANK_WET);
                else if (t < 1 + 3.2 / wdt && h01(x, y, 63) > 0.35) put(x, y, LT.BANK);
                continue;
              }
              let col = t < 0.45 ? LT.WATER[0] : t < 0.8 ? LT.WATER[1] : LT.WATER[2];
              // ripple lines along the flow: light dashes on a few rows, glints on the near bank
              if (t > 0.15 && t < 0.8 && ((k + 100) % 3 === 0) && ((x + k * 7) % 10) < 6) col = LT.WATER[2];
              if (t < 0.85 && h01(x, y, 67) > 0.955) col = LT.GLINT;
              put(x, y, col);
            }
          }
          c.putImageData(img, 0, 0);
          out.push({ kind: 'ridge', cv, ox: 0, oy: H / 2, R: W, W, H, a, b, z: -1 });
        }
      }
      return out;
    },

    /* ---- WHERE THINGS GROW ----
       Pure function of the cell coordinate: the wood is infinite, identical on every visit, and
       stored nowhere. The station stands in a CLEARING with a thickened rim. */
    place(push, x0, y0, x1, y1, clr, scale, pools) {
      const C = FOREST.CELL, ST = FOREST.STREAM;
      // the stream first (z = -1 paints under everything). A lane is skipped where it would run
      // through the clearing — water under the floor plan is a drawing laid over a picture.
      const ridges = pools.ridge;
      if (ridges && ridges.length) {
        const W = ridges[0].W || ST.W, H = ridges[0].H || ST.H, LANE = ST.LANE;
        const level = (lane, sx) => ((h01(sx, lane, 94) * 3) | 0) - 1;
        /* ⛔ THE FIRST CUT DROPPED ANY LANE NEAR THE PAD, using the sprite's full half-height (160)
           as the test — so with the station's seed no stream ever fell in view at any zoom. The
           channel really reaches ~100px from its lane line; lane 0 (the station's own) always
           runs; and a lane that would cross the pad is SHOVED just clear of it instead of dropped,
           so the stream hugs the clearing — right where the eye is. */
        const HALF = 100;
        for (let lane = Math.floor(y0 / LANE) - 1; lane <= Math.ceil(y1 / LANE); lane++) {
          if (lane !== 0 && h01(lane, 0, 91) > ST.P) continue;
          let laneY = lane * LANE + h01(lane, 1, 92) * LANE * 0.8;
          if (clr) {
            const top = clr.y - C * 0.5 - HALF, bot = clr.y + clr.h + C * 0.5 + HALF;
            if (laneY > top && laneY < bot) laneY = (laneY - top < bot - laneY) ? top : bot;
          }
          for (let sx = Math.floor(x0 / W) - 1; sx <= Math.ceil(x1 / W); sx++) {
            const a = level(lane, sx), b = level(lane, sx + 1);
            push(ridges.find(r => r.a === a && r.b === b) || ridges[0], sx * W, laneY);
          }
        }
      }
      const cx0 = Math.floor(x0 / C), cx1 = Math.ceil(x1 / C), cy0 = Math.floor(y0 / C), cy1 = Math.ceil(y1 / C);
      const clutter = scale >= 0.55;
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const wx0 = cx * C, wy0 = cy * C;
          // THE FIELD: two octaves decide groves, glades and edges — wavelengths well under a screen
          const dens = vnoise(wx0 / 380, wy0 / 380, 3) * 0.60 + vnoise(wx0 / 150, wy0 / 150, 11) * 0.40;
          const edgeBoost = clr ? nearClearing(clr, wx0, wy0, C) : 0;
          const inClearing = clr && wx0 + C > clr.x && wx0 < clr.x + clr.w && wy0 + C > clr.y && wy0 < clr.y + clr.h;
          // canopy coverage: open woodland — groves are dense, glades are real, the rim is thick
          const want = dens * 0.95 + edgeBoost * 0.5;
          const nTree = want > 0.30 ? (h01(cx, cy, 1) < 0.25 + want * 0.7 ? (h01(cx, cy, 2) < want * 0.45 ? 2 : 1) : 0) : 0;
          for (let k = 0; k < nTree; k++) {
            const wx = wx0 + h01(cx, cy, 20 + k) * C, wy = wy0 + h01(cx, cy, 30 + k) * C;
            if (clr && wx > clr.x && wx < clr.x + clr.w && wy > clr.y && wy < clr.y + clr.h) continue;
            const pick = h01(cx, cy, 40 + k);
            const pool = pick < 0.06 ? 'emergent' : pick < 0.50 ? 'tree' : pick < 0.74 ? 'conifer' : pick < 0.86 ? 'autumn' : pick < 0.95 ? 'birch' : 'snag';
            const arr = pools[pool] || pools.tree;
            if (!arr || !arr.length) continue;
            push(arr[(h01(cx, cy, 50 + k) * arr.length) | 0], wx, wy);
          }
          if (!clutter) continue;
          // undergrowth lives in the light: bushes and ferns where the canopy opens, logs and rocks rare
          const open = clamp01(1 - dens * 1.3) + edgeBoost * 0.9;
          const nSmall = inClearing ? 0 : Math.round(open * 2.6 * (0.35 + h01(cx, cy, 5)));
          for (let k = 0; k < nSmall; k++) {
            const wx = wx0 + h01(cx, cy, 60 + k) * C, wy = wy0 + h01(cx, cy, 70 + k) * C;
            if (clr && wx > clr.x && wx < clr.x + clr.w && wy > clr.y && wy < clr.y + clr.h) continue;
            const pick = h01(cx, cy, 80 + k);
            const pool = pick < 0.34 ? 'bush' : pick < 0.58 ? 'fern' : pick < 0.74 ? 'log' : pick < 0.88 ? 'rock' : 'stump';
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
