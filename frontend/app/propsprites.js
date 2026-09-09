/* STARNET — propsprites.js : the canonical PROP (furniture) art + catalog.

   v7's sprites.js drew ~85 furniture pieces as detailed PROCEDURAL pixel art — outlined
   casings, 2–3 tone shading, contact shadows, and animated emissive bits (a TV cycling
   channels, console LEDs blinking, screens that light when worked). Tiles are 12px in both
   v7 and gen, so the art ports 1:1 with no rescaling.

   This module is the single source of truth for props:
     - CATALOG  — every placeable prop: id, label, category, default tile footprint, flags
                  (animated, blocks-walk). Drives the builder palette AND the model defaults.
     - F{}      — the procedural draw functions, ported verbatim from v7 (id ↔ F key).
     - draw(f, work) — blit one prop. f = {t, x, y, w, h} in LOCAL tile coords (the bake frame),
                  exactly like world.js's existing F_desk pass. Call setCtx()/setNow() per frame.

   Props ANIMATE, so they are drawn per-frame OVER the static StationBake base and UNDER the
   lightmap (so they're lit) — never baked. Depends only on the global `U` (util.js) + a 2D ctx.
   Headless-safe: requiring the module does nothing until setCtx() is called. */
'use strict';

const PropSprites = (() => {
  const TILE = 12;
  /* MOUNT GEOMETRY — how far above the floor line every table's top plane sits. A prop whose catalog
     row says mount:'surface' is drawn shifted up by exactly this, which is why all tables MUST agree
     on it (see the TABLES section). One constant, no per-table lookup. */
  const SURFACE_RISE = 8;
  let ctx = null, now = 0;

  /* ============ v13 LOCAL COLOUR — one knob over every pixel a prop paints ============
     MEASURED, not guessed (gal/shot.mjs, 29 lounge/decor props on a live seeded station): the
     catalog's MEAN AUTHORED CHROMA is 28/255, and the render pipeline (ambient plate + room cut +
     CRT scan/fade/vig) delivers only **54%** of it to the screen — mean rendered chroma 15. The
     plants are the extreme: monstera authors 44 and renders 8. That is why a room full of props
     whose source really does carry warm oak, brass, deep red and teal still reads as grey-green mud.
     Lifting the LIGHT is a real but bounded lever and it costs brightness that is already dialled
     (ambient 0.82 → 0.55 only recovers 54% → 66%), so the rest has to come from the art's own chroma.

     `CHROMA` scales the SATURATION of every colour a prop paints, holding hue and value exactly.
     Hue and value are what the silhouette and the lighting logic are built on; saturation is the one
     axis with no structural job, which is why it can be a knob at all.
     ⛔ THE TEAL TRAP IS REAL (2026-08-16): amplifying the chroma of a hue that is merely a LITTLE
     cool turns a grey casing green/teal on a warm deck. So the ceiling is hue-dependent — warm local
     colour (wood, brass, terracotta, fabric) is allowed to go saturated, cool machinery is held near
     grey. Machinery is *supposed* to be grey; the defect is a prop with no saturated element at all.
     ⛔ Already-saturated colour is LEFT ALONE (emissives, ACC leds, screen phosphor): boosting a
     colour that is already doing its job only clips it. */
  let CHROMA = 2.6;                                 // 1 = shipped art, untouched · 2.6 = the LOCAL COLOUR candidate
  const CHROMA_SKIP = 0.45;                         // authored saturation at/above this is already local colour
  const _cboost = new Map();
  const chromaOf = (c) => {
    if (CHROMA === 1 || typeof c !== 'string' || c.length !== 7 || c[0] !== '#') return c;
    const hit = _cboost.get(c); if (hit !== undefined) return hit;
    const hsl = _toHsl(c), h = hsl[0], s = hsl[1], l = hsl[2];
    let out = c;
    // near-black is CONTOUR (LINE/ink) and near-white is a spec catch — both carry no local colour
    if (s > 0.001 && s < CHROMA_SKIP && l > 0.055 && l < 0.93) {
      const deg = h * 360;
      const warm = deg < 62 || deg > 328;            // wood / brass / terracotta / warm fabric
      const cap = warm ? 0.52 : 0.20;                // cool machinery stays honestly grey (no teal cast)
      out = _toHex(h, Math.min(cap, s * CHROMA), l);
    }
    _cboost.set(c, out);
    return out;
  };


  /* ================= HUE-SHIFTED SHADING FOR PROPS (2026-09-03 polish) =================
     Every prop derives its bevels, insets, sheens and shadows from a few base tones through U.shade,
     which lerps to white or black — so a desk's shadow side was the same hue with less light, and its
     highlight the same hue washed grey. Painted pixel art hue-shifts: shadow travels cool (toward
     blue-violet) and gains saturation; light travels warm (toward yellow) and thins. This is the same
     helper the station bake uses, at exactly U.shade's lightness, so every tone relationship the
     props were authored on survives; only the colour of the step changes. Cached per (hex, f). */
  const HUE = { darkTo: 250, darkRot: 34, darkSat: 0.18, lightTo: 50, lightRot: 26, lightSat: 0.08 };
  const _shadeCache = new Map();
  const _hsl = (r, g, b) => {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, sat, l];
  };
  const _rgb = (h, sat, l) => {
    if (sat <= 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, p = 2 * l - q;
    const f = t => { t = ((t % 1) + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
  };
  function shade(hex, f) {
    if (!f || typeof hex !== 'string' || hex.length !== 7 || hex[0] !== '#') return U.shade(hex, f);
    const key = hex + '|' + Math.round(f * 1000);
    const hit = _shadeCache.get(key);
    if (hit) return hit;
    const nn = parseInt(hex.slice(1), 16);
    let r = (nn >> 16) & 255, g = (nn >> 8) & 255, b = nn & 255;
    if (f >= 0) { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
    else { r *= (1 + f); g *= (1 + f); b *= (1 + f); }
    let out;
    const hsl = _hsl(r, g, b), l = hsl[2];
    if (l > 0.02 && l < 0.98) {
      const dark = f < 0, amt = Math.min(1, Math.abs(f));
      const to = dark ? HUE.darkTo : HUE.lightTo, cap = amt * (dark ? HUE.darkRot : HUE.lightRot);
      let h = hsl[1] < 0.02 ? to : hsl[0] * 360, sat = hsl[1] < 0.02 ? 0 : hsl[1];
      const d = ((to - h + 540) % 360) - 180;
      h += Math.max(-cap, Math.min(cap, d));
      sat = Math.max(0, Math.min(1, sat + (dark ? amt * HUE.darkSat : -amt * HUE.lightSat) * (hsl[1] < 0.02 ? 0.5 : 1)));
      const c = _rgb(((h % 360) + 360) % 360 / 360, sat, l);
      out = '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1);
    } else {
      out = '#' + ((1 << 24) | (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)).toString(16).slice(1);
    }
    if (_shadeCache.size > 20000) _shadeCache.clear();
    _shadeCache.set(key, out);
    return out;
  }

  /* ================= OWN-HUE OUTLINES (2026-09-03 polish) =================
     Every prop ringed itself in the one universal LINE (#161d22), a near-black soot that Andrew called
     out on the dish ("LESS black on the edges") and the prop-art recipe forbids: the outline is a dark
     tint of the object's OWN hue. The F.* functions cannot be re-authored one by one for this, so the
     outline is resolved at the primitive: the first frame a prop type draws, px() tallies the hues it
     paints (skipping the line itself, near-black and near-white), and from then on every LINE pixel of
     that type paints in an ink derived from its dominant hue at L 0.11. A grey machine stays grey-ink;
     a teal couch gets a teal-black edge. Cached per catalog id, so it costs one frame of counting. */
  const _ink = new Map();            // prop id -> ink hex
  let _inkTally = null;              // { id, h: Float64Array(12), s: number }
  const inkFor = id => _ink.get(id) || LINE;
  function inkBegin(id) { if (!_ink.has(id)) _inkTally = { id, bins: new Float64Array(12), n: 0 }; }
  function inkNote(c) {
    if (!_inkTally || typeof c !== 'string' || c.length !== 7 || c === LINE) return;
    const nn = parseInt(c.slice(1), 16);
    const [h, sat, l] = _hsl((nn >> 16) & 255, (nn >> 8) & 255, nn & 255);
    if (l < 0.10 || l > 0.90 || sat < 0.12) return;
    _inkTally.bins[Math.floor(h * 12) % 12] += sat; _inkTally.n++;
  }
  function inkEnd() {
    const t = _inkTally; _inkTally = null;
    if (!t) return;
    let best = -1, bi = 0;
    for (let i = 0; i < 12; i++) if (t.bins[i] > best) { best = t.bins[i]; bi = i; }
    if (t.n < 4 || best <= 0) { _ink.set(t.id, LINE); return; }
    const c = _rgb((bi + 0.5) / 12, 0.42, 0.11);
    _ink.set(t.id, '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1));
  }

  /* ---- core primitives (verbatim from v7 sprites.js) ---- */
  /* px is the ONE primitive nearly every prop's fill routes through, which is what lets a MIRRORED
     view re-light itself from a single hook: a horizontal flip moves a prop's lit west facets onto
     its shade side, so while MIRROR is set px re-maps the few DIRECTIONAL tones to their partner
     (LSWAP, below the ramps). Nothing sets MIRROR except a deliberately mirrored draw.
     ORDER MATTERS: the mirror swap picks a DIFFERENT AUTHORED tone, then the chroma dial grades
     whatever tone was picked — grading first would hand LSWAP a colour that is not in its table. */
  let _curId = null;
  const px = (x, y, w, h, c) => { if (_inkTally) inkNote(c); if (c === LINE && _curId) c = inkFor(_curId); ctx.fillStyle = chromaOf((MIRROR && LSWAP[c]) || c); ctx.fillRect(x, y, w, h); };
  const blink = (period, phase) => ((now / period + (phase || 0)) % 1) < 0.5;
  const flick = (period, phase) => Math.sin(now / period + (phase || 0) * 7);
  const scrCols = ['#62ff9e', '#3fd07c', '#7adfb0', '#2fa863'];
  // Workstations west of world zero carry a negative x phase. JS remainder keeps the dividend's sign, so during
  // the first seconds after launch the old expression indexed scrCols[-N] and handed undefined to shade().
  // That exception killed REFIT's first animation frame; enough uptime (or DONE + reopen) made the phase positive
  // and the floor mysteriously returned. Normalize the index into [0,n) for every world coordinate and uptime.
  const scr = (ph) => {
    const i = Math.floor(now / 700 + (ph || 0)), n = scrCols.length;
    return scrCols[((i % n) + n) % n];
  };

  /* ---- furniture micro-helpers (verbatim from v7 sprites.js FURNITURE block) ---- */
  const sh = (x, y, w) => { ctx.globalAlpha = 0.22; px(x, y, w, 2, '#000'); ctx.globalAlpha = 1; };
  const glow = (x, y, w, h, c, a) => { ctx.globalAlpha = a; px(x, y, w, h, c); ctx.globalAlpha = 1; };
  // Surface marks are authored BEFORE controls and fittings, so screens stay clean.
  // Short directional strokes read as machining; broad untouched fields carry the form.
  const machined = (x, y, w, h, c) => {
    if (w < 7 || h < 3) return;
    px(x + 1, y + 1, Math.max(2, Math.floor(w * 0.42)), 1, shade(c, 0.055));
    if (h >= 6) {
      px(x + Math.floor(w * 0.48), y + h - 2, Math.max(2, Math.floor(w * 0.32)), 1, shade(c, -0.085));
      px(x + 1, y + h - 2, 1, 1, shade(c, -0.28));
      px(x + 1, y + h - 3, 1, 1, shade(c, 0.16));
    }
    if (w >= 14 && h >= 8) {
      const sx = x + w - 4;
      px(sx, y + 2, 1, h - 4, shade(c, -0.22));
      px(sx + 1, y + 2, 1, h - 4, shade(c, 0.075));
      px(x + 2, y + 2, 2, 1, shade(c, 0.18));
      // A gasketed access leaf, with a short captive latch, on larger castings.
      const pw = Math.min(8, w - 8), ph = Math.min(5, h - 4);
      px(x + 3, y + 2, pw, ph, shade(c, -0.12));
      px(x + 3, y + 2, pw, 1, shade(c, -0.30));
      px(x + 3, y + ph + 1, pw, 1, shade(c, 0.10));
      px(x + pw + 1, y + 3, 1, 2, shade(c, -0.38));
      px(x + pw, y + 3, 1, 1, shade(c, 0.22));
    }
  };
  const box = (x, y, w, h, c) => {              // outlined, shaded casing — 2026-09-03: own-hue outline (LINE resolves to the prop's ink), two-step bevels
    px(x - 1, y - 1, w + 2, h + 2, LINE);
    px(x, y, w, h, c);
    px(x, y, w, 1, shade(c, 0.36));                                  // lit top edge
    if (h > 5) px(x, y + 1, w, 1, shade(c, 0.14));                   // its falloff
    px(x, y + h - 1, w, 1, shade(c, -0.5));                          // shaded bottom edge
    if (h > 5) px(x, y + h - 2, w, 1, shade(c, -0.22));              // its rise
    px(x + w - 1, y + 1, 1, h - 2, shade(c, -0.30));                 // shade side
    px(x, y + 1, 1, h - 2, shade(c, 0.14));                          // lit side
  };
  const inset = (x, y, w, h, c) => {            // recessed panel / screen
    px(x, y, w, h, shade(c, -0.6));
    px(x + 1, y + 1, w - 2, h - 2, c);
    px(x + 1, y + 1, w - 2, 1, shade(c, -0.3));
  };
  const bevel = (x, y, w, h, c) => {            // box + inner 3-tone face
    box(x, y, w, h, c);
    px(x + 1, y + 1, w - 2, h - 2, shade(c, 0.10));
    px(x + 1, y + 1, w - 2, 1, shade(c, 0.30));
    px(x + 1, y + 2, 1, h - 4, shade(c, 0.18));
    px(x + w - 2, y + 2, 1, h - 4, shade(c, -0.18));
    px(x + 1, y + h - 2, w - 2, 1, shade(c, -0.32));
  };
  const seamH = (x, y, w, c) => {               // recessed panel seam (shadow+catch)
    px(x, y, w, 1, shade(c, -0.45));
    px(x, y + 1, w, 1, shade(c, 0.14));
  };
  const rivets = (x, y, w, h, lc, dc) => {      // 4 corner rivets, lit top / dark base
    px(x, y, 1, 1, lc); px(x + w - 1, y, 1, 1, lc);
    px(x, y + h - 1, 1, 1, dc); px(x + w - 1, y + h - 1, 1, 1, dc);
  };
  const wear = (x, y, w, h, n, c) => {          // deterministic scuff/grime speckle
    if (w < 4 || h < 4) return;
    for (let i = 0; i < n; i++) {
      const hx = U.hash('w' + x + ',' + y + ',' + i);
      // `>>>`, not `>>`: U.hash returns a UINT32, and the signed shift makes any hash >= 2^31 negative.
      // JS `%` keeps that sign, so ~2/3 of specks landed ABOVE the rect instead of inside it — visible
      // as stray pixels floating off a prop's top edge. Ported from v7 with the bug; caught 2026-07-24.
      px(x + 1 + (hx % (w - 2)), y + 1 + ((hx >>> 5) % (h - 2)), 1 + (hx % 2), 1, c);
    }
  };
  const scanl = (x, y, w, h, a) => {            // CRT scanlines over a lit screen
    ctx.globalAlpha = a;
    for (let j = 1; j < h; j += 2) px(x, y + j, w, 1, '#000');
    ctx.globalAlpha = 1;
  };

  /* ============ v2 OBLIQUE KIT ============
     One projection law for every prop, matching the station bake (walls = lit TOP band +
     a south-facing FACE): a prop's footprint bottom edge IS its floor contact line; the
     body is drawn as a foreshortened TOP surface + a vertical FRONT face + legs/base that
     touch the floor, under one light (high + slightly west, like the walls). Bodies use
     the shared ramps below; color identity lives in ACCENTS + emissives, not casings. */
  /* Universal silhouette outline. LIGHTENED from #06090c (2026-08-17): at near-black it read as soot
     and every prop looked like a sticker cut out and laid on the deck — most visible on the TV, the
     side table and the pool table. The edge is KEPT, just lifted off pure black to the same tint the
     glow-up props already use, so the whole catalog reads as one room. */
  const LINE = '#161d22';                        // universal silhouette outline
  /* casings are toned DOWN ~15% (sheen rows 20%) from the authoring values so props sit inside the
     station's dim CRT lighting instead of popping against it — a locked pre-merge call. Emissives
     and ACC accents keep full brightness; only the body ramps dim. */
  const dim = (c, k) => {   // module-load-safe darken (U isn't defined under a bare Node require)
    k = k || -0.15;
    const n = parseInt(c.slice(1), 16);
    const r = Math.round(((n >> 16) & 255) * (1 + k)), g = Math.round(((n >> 8) & 255) * (1 + k)), b = Math.round((n & 255) * (1 + k));
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  };
  const RAMP = {
    steel: { top: dim('#4a5862'), face: dim('#39454d'), lit: dim('#5f6f7a'), sheen: dim('#7a8b95', -0.2), dk: dim('#242e35'), ao: dim('#12181d') },
    gun:   { top: dim('#3c4a44'), face: dim('#2e3a36'), lit: dim('#4e5e56'), sheen: dim('#68796f', -0.2), dk: dim('#1d2723'), ao: dim('#0f1512') },
    fabric:{ top: dim('#46565f'), face: dim('#39464e'), lit: dim('#5a6b75'), sheen: dim('#70828c', -0.2), dk: dim('#28323a'), ao: dim('#141b20') },
  };
  /* ============ v12 MATERIAL — the same hue, the WHOLE value range ============
     Measured, not guessed. The crew sprites (assets.js, the art this station already ships and is
     judged against) run a 218-of-255 luma spread. Every prop in this file runs RAMP.steel, whose
     BRIGHTEST stop — `sheen` — is luma 110. So a prop's entire range lives in the bottom 43% of the
     scale, and the near-black LINE it is outlined with has nothing bright to contour. That is why a
     prop reads flat next to an agent: not the outline (already #06090c), not the colour count
     (props carry 61 distinct colours to the crew's 44), but the CEILING.

     MX keeps a material's HUE exactly where it is — steel stays blue-grey steel — and re-spaces its
     VALUES across the crew's range. Chroma RISES into the lights instead of washing toward white,
     because a real surface shows its colour where the light lands; U.shade lerps toward pure white
     and desaturates exactly there, which is the second half of the same flatness. */
  const _toHsl = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l];
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? ((b - r) / d + 2) : ((r - g) / d + 4);
    return [h / 6, s, l];
  };
  const _toHex = (h, s, l) => {
    if (s <= 0) { const v = Math.round(l * 255); return '#' + ((1 << 24) | (v << 16) | (v << 8) | v).toString(16).slice(1); }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    const r = Math.round(f(h + 1 / 3) * 255), g = Math.round(f(h) * 255), b = Math.round(f(h - 1 / 3) * 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  };
  /* Eight stops off one base. `cs` scales chroma (machinery stays honestly grey — the defect was
     never that steel is grey, it is that steel had no highlights; saturated LOCAL colour is carried
     by accent materials, the way Starbound puts a grey hull under coloured panels and brass). */
  const MX = (base, cs) => {
    const hs = _toHsl(base), h = hs[0], s = Math.max(hs[1], 0.02), k = (cs == null ? 1 : cs);
    const L = [0.085, 0.150, 0.235, 0.330, 0.440, 0.560, 0.680, 0.800];
    const S = [1.30, 1.20, 1.12, 1.16, 1.24, 1.28, 1.20, 0.98];
    const st = L.map((l, i) => _toHex(h, Math.min(0.90, s * S[i] * k), l));
    /* ⛔ THE OUTLINE IS A DARK TINT OF THE OBJECT'S OWN HUE, NEVER NEAR-BLACK. A universal #06090c
       contour rings every prop in soot: it reads as a sticker cut out and pasted on the deck, and it
       is the single loudest "cheap" signal in the catalog. `ink` is the material's own colour taken
       down to L 0.13 with its chroma INTACT, which is how a Terraria prop separates from its ground —
       by being darker and MORE saturated at the edge, not by being black. */
    const ink = _toHex(h, Math.min(0.92, s * 1.45 * k), 0.130);
    return { ink: ink, ao: st[0], dk: st[1], face: st[2], top: st[3], mid: st[4], lit: st[5], hi: st[6], sheen: st[7], spec: st[7] };
  };
  /* The v12 material bench. Hues are LIFTED FROM THE SHIPPED PROPS so colour identity is preserved:
     STEEL is RAMP.steel's own #4a5862, GUN is RAMP.gun's #3c4a44. The accents are the saturated
     local colour the catalog never had — used as trim and panels, never as a whole body. */
  const MAT = {
    steel: MX('#4a5862', 1.55),   // the catalog's blue-grey machine steel, full range
    gun:   MX('#3c4a44', 1.55),   // the console family's green-grey
    brass: MX('#a8873f', 1.25),   // fittings, wheel spokes, bolt heads
    amber: MX('#c07a2a', 1.15),   // warm panel trim / hazard bands
    slate: MX('#2b333a', 1.30),   // dark bezels, recessed wells
    /* the couch/soft-furnishing blue-grey, lifted straight from the shipped RAMP.fabric base so the
       lounge keeps the colour it already had. Chroma is left LOW on purpose — this material is meant
       to sit quietly in the room, and the couch is a five-tile mass. */
    fabric: MX('#46565f', 1.00),  // upholstery — the catalog's own blue-grey
    /* ⛔ A WARM BROWN SEAT READS AS WOOD, AND A WOODEN CHAIR HAS NO PLACE ON THIS STATION.
       ⛔ LIGHT SILVER, AND NOT VIA MX (2026-08-16, Andrew's call — the teal is gone entirely).
       This is authored by hand rather than built from MX because MX anchors `face` at L 0.235, and
       `face` is the chair's dominant surface: any base colour run through it comes out DARK, which is
       exactly the failure the teal was papering over. The stops below are shifted bodily into the
       light half so the upholstery sits at L~0.58 and the crown at L~0.87 — light grey, deliberately
       short of white, so it still takes shading instead of blowing out.
       ⛔ SEPARATION IS BY VALUE, NOT HUE. A dark graphite chair landed on the desk's own mid band and
       vanished, which is what sent this to teal in the first place. Sitting ABOVE the desk's band
       solves it the other way round, and keeps the station monochrome.
       ⛔ `ink` STAYS DARK. It is the contour; lifting it with the rest would erase the silhouette. */
    seat: { ink: '#333a3f', ao: '#454d52', dk: '#5b6469', face: '#8f989e', top: '#9ea7ad',
            mid: '#adb6bb', lit: '#bdc5ca', hi: '#ccd3d7', sheen: '#dae0e3', spec: '#dae0e3' },
  };
  const ACC = { work: '#41ff8a', data: '#4ad9ff', flow: '#ffd34a', lounge: '#ff6ad5', mem: '#b44aff', alert: '#ff4a3d' };
  /* ---- v12 surface kit: the Starbound-grade marks, each riding the value structure ---- */
  // a bolt/rivet head: lit crown + dark seat. TWO pixels, but it is the two that make metal read.
  const boltH = (bx, by, r2) => { px(bx, by, 1, 1, r2.hi); px(bx, by + 1, 1, 1, r2.ao); };
  // a panel seam: dark groove with a lit lip ABOVE it (light falls from the north in this station)
  const seamLit = (sx, sy, sw2, r2) => { px(sx, sy, sw2, 1, r2.ao); px(sx, sy - 1, sw2, 1, r2.mid); };
  const seamLitV = (sx, sy, sh2, r2) => { px(sx, sy, 1, sh2, r2.ao); px(sx - 1, sy, 1, sh2, r2.mid); };
  // brushed grain that RIDES the row it lands on instead of replacing it with a fixed tint
  const grain = (gx, gy, gw2, gh2, r2, seed) => {
    for (let j = 0; j < gh2; j++) for (let i = 0; i < gw2; i++) {
      const n = Math.sin((gx + i) * 12.9898 + (gy + j) * 78.233 + (seed || 0)) * 43758.5453;
      const t = n - Math.floor(n);
      if (t > 0.86) px(gx + i, gy + j, 1, 1, r2.mid);
      else if (t < 0.10) px(gx + i, gy + j, 1, 1, r2.face);
    }
  };
  // a louvre/vent stack with real depth: dark slot, lit sill under it
  const louvre = (lx, ly, lw2, n, r2) => {
    for (let i = 0; i < n; i++) { px(lx, ly + i * 2, lw2, 1, r2.ao); px(lx, ly + i * 2 + 1, lw2, 1, r2.mid); }
  };
  // worn edge: chip the top-lit lip so the object has been USED (kept sparse — noise is not wear)
  const chip = (cx2, cy2, cw2, r2, seed) => {
    for (let i = 0; i < cw2; i++) {
      const n = Math.sin((cx2 + i) * 45.164 + (seed || 0)) * 21631.7;
      if (n - Math.floor(n) > 0.82) px(cx2 + i, cy2, 1, 1, r2.dk);
    }
  };
  let buildingShadowSilhouette = false;
  const shadow2 = (x, y, w) => {                 // soft 2-step contact shadow ON the floor line y
    if (buildingShadowSilhouette) return; // contact belongs on the deck, never inside a projected silhouette
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * 0.09; px(x - 1, y - 1, w + 3, 4, '#000');
    ctx.globalAlpha = alpha * 0.18; px(x, y, w, 2, '#000');
    ctx.globalAlpha = alpha * 0.26; px(x + 1, y, Math.max(1, w - 2), 1, '#000');
    ctx.globalAlpha = alpha;
  };
  const topFace = (x, y, w, d, r) => {           // foreshortened top surface, back edge catches light
    px(x - 1, y - 1, w + 2, d + 1, LINE);
    px(x, y, w, d, r.top);
    if (r !== MAT.fabric && r !== MAT.seat && r !== RAMP.fabric) machined(x + 1, y + 1, w - 2, d - 2, r.top);
    px(x, y, w, 1, r.sheen);
    px(x, y + 1, 5, 1, shade(r.sheen, 0.12));  // west-biased sheen streak
    px(x, y + 1, 1, d - 1, r.lit);
    px(x + w - 1, y + 1, 1, d - 1, r.dk);
    px(x, y + d - 1, w, 1, shade(r.top, -0.16)); // front lip of the top
  };
  const frontFace = (x, y, w, fh, r) => {        // vertical south face under a top surface
    px(x - 1, y, w + 2, fh + 1, LINE);
    px(x, y, w, fh, r.face);
    if (r !== MAT.fabric && r !== MAT.seat && r !== RAMP.fabric) machined(x + 1, y + 1, w - 2, fh - 2, r.face);
    px(x, y, w, 1, r.lit);                       // catch under the lip
    px(x, y + 1, 1, fh - 1, shade(r.face, 0.08));
    px(x + w - 1, y + 1, 1, fh - 1, r.dk);
    if (fh > 4) px(x, y + fh - 2, w, 1, shade(r.face, -0.16));   // the AO's rise (2026-09-03 polish)
    px(x, y + fh - 1, w, 1, r.ao);               // floor-line ambient occlusion
  };
  const leg = (x, y, lh, r) => {                 // one 2px leg: lit west column, dark east, foot pad
    px(x - 1, y, 4, lh, LINE);
    px(x, y, 1, lh, r.lit); px(x + 1, y, 1, lh, r.dk);
    px(x, y + lh - 1, 2, 1, r.ao);
    ctx.globalAlpha = 0.30; px(x - 1, y + lh, 4, 1, '#000'); ctx.globalAlpha = 1;
  };
  const underAO = (x, y, w, h2) => {             // shade the open gap under furniture
    ctx.globalAlpha = 0.20; px(x, y, w, h2, '#000'); ctx.globalAlpha = 1;
  };
  /* The locked style law (2026-07-01): projection MIX — low furniture is TOP-BIAS OBLIQUE
     (big visible top, short face, ~10px rise: Pokemon/Zelda), naturally tall props are TALL 3/4
     (full height, may briefly occlude an agent: y-sort handles it). SYSTEMS props read as
     machinery BOLTED to the deck (baseplate + floor cable socket); decor/lounge is freestanding.
     Silhouettes are BOLD — rounded/oval/trapezoid/chamfered, never plain boxes. */
  const rr = (x, y, w, h, c) => {                // rounded rect: 1px corner cuts kill the boxiness
    px(x + 1, y, w - 2, 1, c); px(x, y + 1, w, h - 2, c); px(x + 1, y + h - 1, w - 2, 1, c);
  };
  const deckPlate = (x, y, w, h2) => {           // bolted-to-deck mounting plate under a SYSTEMS prop
    if (w < 4 || h2 < 2) return;
    rr(x, y, w, h2, '#10161a');
    px(x + 1, y, w - 2, 1, '#34434c');           // exposed chamfer
    if (h2 >= 4) {
      px(x + 2, y + 1, w - 4, h2 - 2, '#1c272e');
      px(x + 2, y + h2 - 2, w - 4, 1, '#080f15'); // inset rubber isolation pad
      for (const bx of [x+2,x+w-4]) {
        px(bx,y+1,2,2,'#0b1218');
        px(bx,y+1,2,1,'#566672');
        px(bx+1,y+2,1,1,'#26333d');
      }
    }
    px(x + 1, y + h2 - 1, w - 2, 1, '#080e14'); // grounded underside
    px(x + 1, y + h2 - 1, 2, 1, '#8a7434'); px(x + w - 3, y + h2 - 1, 2, 1, '#8a7434');

  };
  const deckSocket = (x, y, live) => {           // floor conduit socket a machine's cable runs into
    px(x, y, 2, 1, '#0e1418');                   // conduit
    px(x + 2, y - 1, 2, 2, '#1a232a');           // socket box
    px(x + 3, y, 1, 1, live ? ACC.work : '#16302a');
  };

  /* ============ v4 MATERIAL KIT (2026-07-24) ============
     v3 locked PROJECTION and SILHOUETTE and is NOT reopened here. v4 only fixes what v3 left flat —
     MATERIAL and LIGHT — so footprints, the oblique law, and the bolted-to-deck language all stand:
       (1) TWO-TONE LIGHT. A prop lit by one white lamp reads flat no matter how many tones its ramp
           has. Real metal takes a WARM key off the station's ceiling strips (high + west) on its lit
           edges and a COOL sky bounce on its shade edges. keyEdge/rimEdge are 1px washes that add
           that split on top of the existing ramp instead of replacing it.
       (2) FALLOFF EMISSIVES. glow() stamps one flat alpha rect, which reads as a translucent sticker.
           bloom() lays 3 nested rings so light actually falls off, and spill() runs light DOWN a
           surface from an emitter above it (a screen pooling onto a tabletop).
       (3) BOLDER SILHOUETTE. rr() cuts 1px corners — at 12px tiles that still reads as a lozenge.
           chamf() cuts k px (default 2) so a body can be genuinely chamfered, and cable() hangs a
           real sagging line, which is the cheapest way to break a boxy outline. */
  const KEY = '#ffe0b0';                         // warm key — the station's ceiling strips, west-biased
  const SKY = '#7fb4d8';                         // cool sky bounce — fills the shade side
  const keyEdge = (x, y, w, h, a) => { ctx.globalAlpha = a == null ? 0.22 : a; px(x, y, w, h, KEY); ctx.globalAlpha = 1; };
  const rimEdge = (x, y, w, h, a) => { ctx.globalAlpha = a == null ? 0.24 : a; px(x, y, w, h, SKY); ctx.globalAlpha = 1; };

  // Equipment finish: cold rolled steel with a satin face and a bright machined edge.
  // Scoped to workstation/capability bodies; upholstery and decorative furniture keep their ramps.
  const EQUIPMENT = { ink:'#26313b', ao:'#111922', dk:'#29343e', face:'#404d55', top:'#586971', mid:'#7b8c95', lit:'#a6b5bc', hi:'#c9d4d7', sheen:'#dde5e5', spec:'#dde5e5' };
  const INSTRUMENT = { ink:'#1b242e', ao:'#0e141c', dk:'#222f3b', face:'#33434e', top:'#4b5d69', mid:'#697f8b', lit:'#8fa4af', hi:'#b5c6cd', sheen:'#d2dfe3', spec:'#d2dfe3' };
  const panelFinish = (x,y,w,h,r) => {
    if(w<5||h<3)return;
    px(x,y,w,h,r.face);
    px(x,y,w,1,r.mid); px(x,y+1,Math.max(2,Math.floor(w*.6)),1,r.top);
    // A short machined catch, rather than a bright stripe across the whole panel.
    px(x+1,y,Math.min(3,w-3),1,r.lit);
    px(x+w-1,y+1,1,h-1,r.dk); px(x,y+h-1,w,1,r.ao);
    if(h>5){px(x+1,y+2,1,h-4,r.top);px(x+2,y+h-3,Math.min(4,w-3),1,r.dk);}
    if (w >= 9 && h >= 8) {
      // Recessed ventilation with a metal lip; the surrounding face stays satin.
      const vx=x+w-5, vy=y+h-5;
      px(vx-1,vy-1,4,4,r.ao);
      for(let j=0;j<2;j++){px(vx,vy+j*2,3,1,r.dk);px(vx,vy+j*2-1,2,1,r.top);}
      px(x+3,y+h-2,2,1,r.mid); // engraved service index, never a status light
    }
  };
  const captiveBolt = (x,y,r) => {px(x,y,2,2,r.ao);px(x,y,2,1,r.lit);px(x+1,y+1,1,1,r.dk);};
  const equipmentApron = (x,y,w,r) => {
    px(x,y,w,3,r.ink);px(x+1,y,w-2,1,r.mid);
    px(x+2,y+1,w-4,1,r.face);
    // Matte isolation gasket beneath the steel fascia; no specular highlight.
    px(x+2,y+2,w-4,1,r.ao);
    for(const dx of [2,w-4]){px(x+dx,y+1,2,1,r.lit);px(x+dx,y+2,2,1,r.dk);}
    const latch=x+Math.floor(w/2)-2;
    px(latch,y+1,4,1,r.ao);
    px(latch+1,y+1,2,1,r.dk); // recessed pull, flanked by the existing fasteners
    if(w>18){px(x+5,y+1,3,1,r.top);px(x+w-8,y+1,2,1,r.dk);}
  };

  // Shared workstation construction: satin work surface in a folded steel frame.
  // All kit is drawn afterward; this never covers screens, controls or seat anchors.
  const workstationSurface = (x, y, w) => {
    const r = EQUIPMENT, b = INSTRUMENT;
    chamf(x - 1, y - 3, w + 2, 9, r.ink, 2);
    px(x + 1, y - 2, w - 2, 1, r.mid);
    px(x + 2, y - 2, 5, 1, r.lit);
    px(x, y - 1, w, 4, r.top);
    // Replace the pale slab with a dark, inset work mat and a narrow metal rim.
    px(x + 2, y - 1, w - 4, 3, b.face);
    px(x + 3, y, w - 6, 2, b.dk);
    px(x, y, 1, 3, r.mid); px(x + w - 1, y, 1, 3, r.dk);
    px(x + 1, y + 3, w - 2, 1, r.mid);
    px(x + 2, y + 3, 4, 1, r.lit);
    px(x + 1, y + 4, w - 2, 2, r.face);
    px(x + 2, y + 5, w - 4, 1, r.dk);
    // Independent equipment pods leave a clear knee recess between supports.
    for (const dx of [2, w - 7]) {
      px(x + dx, y + 6, 5, 2, r.ink);
      px(x + dx, y + 6, 5, 1, r.face);
      px(x + dx + 1, y + 6, 2, 1, r.mid);
    }
    px(x + w - 4, y + 4, 1, 1, '#9b8766'); // captive brass fastening, never an LED
  };

  /* ============ ORIENTATION ============
     Props were authored facing ONE way — south — because that is what the v3/v4 law bakes in: a
     foreshortened TOP face over a south-facing FRONT face, under ONE fixed light (warm KEY high and
     west, cool SKY rim east). So a facing is NOT a canvas transform in the general case: turning a
     chair 90° would swing its backrest (drawn at y-4, real vertical ELEVATION) out sideways and
     rotate the light with it. Turned views are AUTHORED, one fn per facing (see AUTHORED TURNED
     VIEWS near viewAt).

     Two things ARE derived, and only these:
       DECAL TURN — a prop with no elevation at all (rug, cable run, hazard pad) IS its own top face,
                    so turning its footprint is the correct picture. Exact 90° integer affines keep
                    it pixel-exact.
       MIRROR     — a horizontal flip never changes which way a prop FACES; it swaps handedness,
                    which is what fixes "the lamp is on the wrong side", and it is how a WEST view is
                    derived from an authored EAST one. Geometry mirrors for free; the LIGHT does not,
                    so px() re-maps directional tones through LSWAP.

     LSWAP holds only tones whose meaning is genuinely east/west: each ramp's lit (west) <-> dk
     (east) column, and the warm west KEY <-> the cool east SKY. `sheen` (a NORTH back-edge catch),
     `ao` (downward), `top` and `face` are axis-neutral under a horizontal flip and stay put.
     KNOWN LIMIT: a facet painted as shade(r.face, +k) rather than r.lit is a runtime colour with
     no table entry, so it keeps its original hand — the dominant read (silhouette, top face, front
     face, emissives) is unaffected. Props drawing through raw ctx path ops set fillStyle directly,
     which px() never sees; those are excluded from mirroring (NO_MIRROR) until authored. */
  let MIRROR = false;
  const LSWAP = (() => {
    const m = {};
    const pair = (a, b) => { if (a && b && a !== b) { m[a] = b; m[b] = a; } };
    for (const k in RAMP) pair(RAMP[k].lit, RAMP[k].dk);
    for (const k in MAT) pair(MAT[k].lit, MAT[k].dk);
    pair(EQUIPMENT.lit, EQUIPMENT.dk); pair(INSTRUMENT.lit, INSTRUMENT.dk);
    pair(KEY, SKY);
    return m;
  })();
  const bloom = (x, y, w, h, c, a) => {          // emissive with 3-ring falloff (vs glow's flat rect)
    ctx.globalAlpha = a * 0.28; px(x - 2, y - 2, w + 4, h + 4, c);
    ctx.globalAlpha = a * 0.55; px(x - 1, y - 1, w + 2, h + 2, c);
    ctx.globalAlpha = a;        px(x, y, w, h, c);
    ctx.globalAlpha = 1;
  };
  const spill = (x, y, w, c, a, n) => {          // light pooling DOWN a surface from an emitter above
    n = n || 4;
    for (let i = 0; i < n; i++) {
      const t = 1 - i / n;
      ctx.globalAlpha = a * t * t;
      px(x + i, y + i, w - i * 2, 1, c);
    }
    ctx.globalAlpha = 1;
  };
  const chamf = (x, y, w, h, c, k) => {          // chamfered rect — k px corner cuts (k=2 default)
    k = k == null ? 2 : k;
    for (let j = 0; j < h; j++) {
      const d = Math.min(j, h - 1 - j), i = d < k ? k - d : 0;
      if (w - i * 2 > 0) px(x + i, y + j, w - i * 2, 1, c);
    }
  };
  const cable = (x0, y0, x1, y1, sag, c) => {    // limp sagging cable — breaks a boxy silhouette
    const n = Math.max(2, Math.abs(x1 - x0) + Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      px(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * (sag || 0)), 1, 1, c || '#0b1114');
    }
  };
  const knurl = (x, y, w, h, c) => {             // machined grip texture on a dial / handle
    for (let i = 0; i < w; i += 2) px(x + i, y, 1, h, shade(c, -0.32));
  };
  const dial = (x, y, c, ang) => {               // 3x3 control knob with a pointer mark
    px(x, y, 3, 3, LINE); px(x, y, 3, 1, shade(c, 0.20)); px(x + 1, y + 1, 1, 1, shade(c, -0.32));
    const dx = Math.round(Math.cos(ang)), dy = Math.round(Math.sin(ang));
    px(x + 1 + dx, y + 1 + dy, 1, 1, shade(c, 0.44));   // a soft catch, not a white speck (reads as noise)
  };
  const codeRow = (x, y, wmax, seed, c, hot) => {  // one scrolling line of code on a screen
    const k = (seed + Math.floor(now / 380)) % 6;
    const lw = [7, 4, 9, 3, 6, 5][k], ind = [0, 1, 0, 2, 1, 0][k];
    px(x + ind, y, Math.min(lw, wmax - ind), 1, c);
    if (k === 2 || k === 4) px(x + ind, y, 2, 1, hot);   // a keyword token, brighter
  };

  /* ============ FURNITURE (ported verbatim from v7 sprites.js) ============ */
  const F = {};

  F.bigscreen = (x, y, w, h, f) => {
    // BIG SCREEN (8x1) — v4 rebuild. At 96px this is the widest prop in the game, so it cannot be a
    // scaled-up monitor: it gets the structure a real hall display has — pylon mounts with a cross-tie,
    // a stepped bezel with genuine recess depth, and CONTENT WITH HIERARCHY (header band / left table /
    // centre plot / right tile column) instead of uniform noise. Idle keeps phosphor; f.work drives gain.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const py = y - 12, pH = 18;                                  // panel rides y-12..y+5, pylons carry it down
    const dc = (c, k) => shade(c, on ? 0 : (k == null ? -0.5 : k));   // idle dims content, never kills it
    shadow2(x + 6, y + h - 1, w - 12);
    // TWO PYLONS + A CROSS-TIE. Without the tie a 96px panel reads as balanced on two loose sticks.
    for (const mx of [x + 14, x + w - 22]) {
      px(mx - 1, y + 4, 10, 8, LINE);
      px(mx, y + 5, 8, 6, r.face);
      px(mx, y + 5, 8, 1, r.lit); keyEdge(mx + 1, y + 5, 5, 1, 0.16);
      px(mx, y + 5, 1, 6, shade(r.face, 0.08)); px(mx + 7, y + 5, 1, 6, r.dk);
      rimEdge(mx + 7, y + 5, 1, 6, 0.20);
      px(mx + 3, y + 5, 2, 6, r.ao);                             // cable channel routed up the pylon
      chamf(mx - 4, y + h - 4, 16, 4, LINE, 1);                  // splayed base shoe
      px(mx - 3, y + h - 3, 14, 2, r.face); px(mx - 3, y + h - 3, 14, 1, r.lit);
      px(mx - 3, y + h - 1, 14, 1, r.ao);
      ctx.globalAlpha = 0.30; px(mx - 4, y + h, 16, 1, '#000'); ctx.globalAlpha = 1;
    }
    px(x + 22, y + 7, w - 44, 2, LINE);
    px(x + 22, y + 8, w - 44, 1, shade(r.face, 0.06));         // cross-tie between the pylons
    cable(x + 17, y + 6, x + 13, y + h - 4, 2.6);                // feed lead sagging down the west pylon
    // HEAVY CHAMFERED CARCASS — 3px cuts, big enough to read as machined at this width
    chamf(x - 1, py - 1, w + 2, pH + 2, LINE, 3);
    chamf(x, py, w, pH, r.face, 3);
    px(x + 3, py, w - 6, 1, r.top); keyEdge(x + 3, py, 12, 1, 0.20);   // warm ceiling strip along the crown
    px(x, py + 3, 1, pH - 6, r.lit); px(x + w - 1, py + 3, 1, pH - 6, r.dk);
    rimEdge(x + w - 1, py + 3, 1, pH - 6, 0.22);                 // cool sky bounce down the shade flank
    px(x + 3, py + pH - 1, w - 6, 1, r.ao);
    wear(x + 2, py + 1, w - 4, pH - 2, 5, shade(r.face, -0.10));
    for (const sxx of [x + 3, x + w - 4]) { px(sxx, py + 1, 1, 1, shade(r.top, 0.30)); px(sxx, py + pH - 2, 1, 1, r.ao); }
    // STEPPED BEZEL: an intermediate face set back from the carcass, then the glass well cut into it.
    // Two steps is what sells depth on a big panel; one step reads as a sticker on a plate.
    px(x + 2, py + 2, w - 4, pH - 5, shade(r.face, -0.30));
    px(x + 2, py + 2, w - 4, 1, shade(r.face, -0.55));         // the step's top face lies in its own shadow
    px(x + 2, py + pH - 4, w - 4, 1, shade(r.face, 0.10));
    const gx = x + 4, gy = py + 4, gw = w - 8, gh = pH - 9;      // 88 x 9 of actual glass
    px(gx - 1, gy - 1, gw + 2, gh + 2, '#050a08');
    px(gx, gy, gw, gh, on ? '#08171c' : '#071012');              // glass ground — never dead black
    // --- HEADER BAND: a title block of word-shapes + a right-hand lamp cluster ---
    px(gx, gy, gw, 2, on ? '#0b2630' : '#08181e');
    let tw = gx + 2;
    for (const k of [5, 3, 7, 4]) { px(tw, gy, k, 1, dc(ACC.data, -0.55)); tw += k + 2; }   // "STATION FEED"
    px(gx + 2, gy + 1, 22, 1, dc(shade(ACC.data, -0.45), -0.6));  // subtitle rule under the title
    for (let i = 0; i < 3; i++)
      px(gx + gw - 8 + i * 3, gy, 2, 1, blink(700 + i * 210, i + ph) ? dc(i === 2 ? ACC.flow : ACC.work, -0.5) : '#123028');
    px(gx, gy + 2, gw, 1, '#0a1c1f');                            // rule separating header from the body
    // --- LEFT TABLE: five rows of bar-value pairs. Reads as a manifest, not as noise. ---
    const lx = gx + 2, ly = gy + 4;
    for (let i = 0; i < 5; i++) {
      const v = 4 + ((U.hash('bs' + i) + Math.floor(now / 900 + i)) % 12);
      px(lx, ly + i, 4, 1, dc(shade(ACC.data, -0.5), -0.6));   // row label stub
      px(lx + 5, ly + i, v, 1, dc(i === 2 ? ACC.flow : ACC.work, -0.58));
    }
    px(lx - 1, ly - 1, 20, 1, '#12262a');                        // table header rule
    // --- CENTRE PLOT: graticule, baseline, twin trace (dim echo behind the live one), hot pixel ---
    const cx0 = gx + 24, cw0 = 44, cy0 = gy + 3, ch0 = gh - 3, mid = cy0 + (ch0 >> 1);
    px(cx0, cy0, cw0, ch0, on ? '#061a17' : '#06120f');
    for (let i = 0; i <= cw0; i += 11) px(cx0 + i, cy0, 1, ch0, '#0e2a26');
    for (let j = 0; j < ch0; j += 3) px(cx0, cy0 + j, cw0, 1, '#0c2320');
    px(cx0, mid, cw0, 1, '#154034');                             // baseline
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = on ? '#1d5a63' : '#123338'; ctx.beginPath();
    for (let i = 0; i < cw0; i++) {                              // dim echo pass, one beat behind
      const yy = mid + Math.sin(now / 300 + i * 0.30 + 1.4 + ph) * (on ? 2.6 : 1.4);
      i ? ctx.lineTo(cx0 + i, yy) : ctx.moveTo(cx0 + i, yy);
    }
    ctx.stroke();
    ctx.strokeStyle = on ? ACC.data : shade(ACC.data, -0.55); ctx.beginPath();
    for (let i = 0; i < cw0; i++) {
      const yy = mid + Math.sin(now / 300 + i * 0.30 + ph) * (on ? 3.0 : 1.6);
      i ? ctx.lineTo(cx0 + i, yy) : ctx.moveTo(cx0 + i, yy);
    }
    ctx.stroke();
    ctx.restore();
    const hp = Math.floor((now / 30) % cw0);                     // hot pixel riding the live trace (kept beat)
    px(cx0 + hp, mid + Math.round(Math.sin(now / 300 + hp * 0.30 + ph) * (on ? 3.0 : 1.6)), 1, 1, on ? '#dffaff' : '#3a6a72');
    // --- RIGHT COLUMN: three stacked readout tiles, each a labelled fill gauge ---
    const rx0 = gx + gw - 18;
    for (let i = 0; i < 3; i++) {
      const ty = gy + 3 + i * 2;
      px(rx0, ty, 18, 1, '#0d2126');
      px(rx0, ty, 3, 1, dc(shade(ACC.data, -0.35), -0.6));     // tile label
      const fw = 3 + Math.floor((1 + Math.sin(now / 640 + i * 1.7 + ph)) * (on ? 5.4 : 2.2));
      px(rx0 + 4, ty, fw, 1, dc(i === 1 ? ACC.flow : ACC.work, -0.6));
      px(rx0 + 4 + fw, ty, 1, 1, on ? '#dffaff' : '#20423a');    // gauge head
    }
    px(rx0 - 1, gy + 3, 1, gh - 3, '#12262a');                   // column divider
    // glass finish: scanlines, a drifting refresh band, then falloff bloom over the whole lit area
    scanl(gx, gy, gw, gh, on ? 0.12 : 0.20);
    glow(gx + Math.floor((now / 45) % (gw - 6)), gy, 5, gh, '#dfffe8', on ? 0.06 : 0.03);
    bloom(gx, gy, gw, gh, ACC.data, on ? 0.11 + 0.03 * Math.sin(now / 800) : 0.05);
    px(gx + 1, gy + 1, 6, 1, '#123a42'); px(gx + 1, gy + 2, 3, 1, '#0e2d34'); // ceiling reflection in the glass
    // the panel throws light DOWN its own frame and onto the pylons — the reason it's the room's key
    spill(x + 4, py + pH, w - 8, ACC.data, on ? 0.20 : 0.09, 6);
    for (let i = 0; i < 5; i++)                                  // status row on the frame's bottom rail
      px(x + 8 + i * 9, py + pH - 3, 4, 1, blink(900, i + ph) ? dc(ACC.flow, -0.55) : '#2c3a32');
    for (let i = 0; i < 9; i++) px(x + w - 34 + i * 3, py + pH - 3, 2, 1, '#0c1410'); // exhaust slits, east end
  };

  F.consoleL = (x, y, w, h, f) => {
    /* v45 CONSOLE L (3x1) — the console's big brother: a THREE-PANEL instrument wall on one slab.
       ⛔ ANY PROP WIDER THAN ~3 TILES IS A HORIZON UNLESS YOU BREAK ITS RHYTHM. The bank is split
          into three bays by full-height dividers, and the bays carry UNLIKE kit — glass, a bar-graph
          readout, a switch matrix. Three identical screens would be a wall, not a console. */
    const r = EQUIPMENT, b = INSTRUMENT, s = MAT.seat, on = !!f.work, ph = f.x || 0;
    const G = ACC.work;

    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x - 3, y + h - 3, on);
    cable(x + 1, y + 7, x - 3, y + h - 3, 2);

    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 8, 3, 4, r.ink);
      px(lx, y + 8, 1, 4, r.face); px(lx + 1, y + 8, 1, 4, r.dk);
      px(lx, y + 8, 1, 1, r.mid);
    }
    underAO(x + 6, y + 8, w - 12, 2);

    workstationSurface(x, y, w);

    /* ---- THE BANK: one casting, three bays split by full-height dividers ---- */
    const bX = x + 1, bW = w - 2, bT = y - 11;
    px(bX + 1, bT, bW - 2, 1, b.ink);
    px(bX, bT + 1, bW, 8, b.ink);
    px(bX + 1, bT + 1, bW - 2, 2, b.top);
    px(bX + 2, bT + 1, 6, 1, b.hi);
    px(bX + 1, bT + 3, bW - 2, 1, b.face);
    px(bX + 1, bT + 4, bW - 2, 4, b.face);
    px(bX + 1, bT + 8, bW - 2, 1, r.ao);
    const bayW = Math.floor((bW - 2) / 3);
    for (let k = 1; k < 3; k++) {                                   // dividers
      px(bX + 1 + k * bayW, bT + 4, 1, 4, b.ao);
      px(bX + k * bayW, bT + 4, 1, 4, b.mid);
    }

    /* ---- BAY 1: glass ---- */
    const sx = bX + 2, sy = bT + 4, sw = bayW - 3, sh = 4;
    px(sx - 1, sy - 1, sw + 2, sh + 2, '#050b07');
    if (on) {
      const sc = scr(ph);
      px(sx, sy, sw, sh, shade(sc, -0.68));
      px(sx, sy, sw, 1, shade(sc, 0.28));
      for (let j = 0; j < 2; j++) px(sx + 1, sy + 1 + j, 2 + ((j * 3 + Math.floor(now / 520)) % (sw - 4)), 1, shade(sc, 0.12));
      scanl(sx, sy, sw, sh, 0.18); bloom(sx, sy, sw, sh, sc, 0.16);
    } else { px(sx, sy, sw, sh, '#0a120d'); px(sx, sy, 3, 1, '#16231b'); }

    /* ---- BAY 2: bar-graph readout ---- */
    const gx = bX + 2 + bayW;
    px(gx - 1, bT + 3, bayW - 1, 6, '#050b07');
    for (let i = 0; i < bayW - 3; i++) {
      const v = 1 + Math.floor((1 + Math.sin(now / 260 + i * 0.8 + ph)) * (on ? 1.4 : 0.5));
      px(gx + i, bT + 7 - v, 1, v, on ? shade(G, 0.10) : shade(G, -0.62));
    }
    if (on) bloom(gx, bT + 4, bayW - 3, 4, G, 0.16);

    /* ---- BAY 3: switch matrix ---- */
    const mx = bX + 2 + bayW * 2;
    for (let ry = 0; ry < 2; ry++) for (let rx = 0; rx < 5; rx++)
      px(mx + rx * 2, bT + 4 + ry * 2, 1, 1, blink(600 + rx * 130, rx + ry) ? (rx === 4 ? ACC.flow : G) : '#16241c');
    px(mx, bT + 8, bayW - 3, 1, on ? shade(G, -0.20) : shade(G, -0.66));
    if (on) { bloom(mx, bT + 4, bayW - 3, 5, G, 0.14); spill(bX + 1, bT + 9, bW - 2, scr(ph), 0.16, 4); }

    /* ---- CONTROLS on the working surface ---- */
    dial(x + 3, y, r.top, now / 900 + ph);
    dial(x + 7, y, r.top, -now / 640 + ph);
    for (let i = 0; i < 4; i++) { px(x + 12 + i * 2, y, 1, 2, b.ao); px(x + 12 + i * 2, y, 1, 1, blink(600, i) ? ACC.flow : '#33241a'); }
    px(x + 22, y, 6, 2, b.ink); px(x + 22, y, 6, 1, b.lit);
    knurl(x + 3, y + 3, 18, 1, r.top);

  };

  F.holotable = (x, y, w, h, f) => {
    // HOLOTABLE (4x2) — v4. The other props in this family are LIT SURFACES; this one is a lit VOLUME, so
    // the differentiator is a real emitter ring in the well and a visible projection cone carrying light up
    // to a station hologram floating above the slab. Cyan lives in the light only; the table stays steel.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const g0 = on ? 1 : 0.55;                                      // idle still projects, just weaker
    shadow2(x + 3, y + h - 1, w - 6);
    // fluted central plinth — a column, not a block, so the slab reads as floating on one stem
    chamf(x + 7, y + h - 8, w - 14, 8, LINE, 2);
    px(x + 8, y + h - 7, w - 16, 5, r.face);
    px(x + 8, y + h - 7, w - 16, 1, r.lit); keyEdge(x + 9, y + h - 7, 8, 1, 0.16);
    for (let i = 0; i < 5; i++) px(x + 11 + i * 5, y + h - 6, 1, 4, r.ao);   // flutes
    px(x + 8, y + h - 7, 1, 5, shade(r.face, 0.08)); px(x + w - 9, y + h - 7, 1, 5, r.dk);
    rimEdge(x + w - 9, y + h - 7, 1, 5, 0.20);
    px(x + 8, y + h - 3, w - 16, 1, r.ao);
    underAO(x + 4, y + h - 9, w - 8, 2);                           // dark gap under the overhanging slab
    // short south face of the slab, with the control strip recessed into it
    chamf(x - 1, y + h - 13, w + 2, 6, LINE, 2);
    px(x, y + h - 12, w, 4, r.face);
    px(x, y + h - 12, w, 1, r.lit); keyEdge(x + 2, y + h - 12, 12, 1, 0.15);
    px(x, y + h - 11, 1, 3, shade(r.face, 0.08)); px(x + w - 1, y + h - 11, 1, 3, r.dk);
    rimEdge(x + w - 1, y + h - 11, 1, 3, 0.20);
    px(x, y + h - 9, w, 1, r.ao);
    inset(x + 5, y + h - 11, 10, 2, '#0a1a20');                    // control strip (kept beat)
    for (let i = 0; i < 3; i++)
      px(x + 6 + i * 3, y + h - 10, 1, 1, blink(500, i + ph) ? ACC.data : '#1d4a5a');
    knurl(x + w - 14, y + h - 10, 9, 1, r.face);                   // machined grip along the near edge
    // the big top surface dominates (top-bias oblique)
    chamf(x - 1, y, w + 2, h - 11, LINE, 2);
    chamf(x, y + 1, w, h - 13, r.top, 2);
    px(x + 2, y + 1, w - 4, 1, r.sheen); keyEdge(x + 2, y + 1, 10, 1, 0.28);
    px(x, y + 3, 1, h - 17, r.lit); px(x + w - 1, y + 3, 1, h - 17, r.dk);
    rimEdge(x + w - 1, y + 3, 1, h - 17, 0.20);
    px(x + 2, y + h - 13, w - 4, 1, shade(r.top, -0.18));        // front lip of the top
    wear(x + 1, y + 2, w - 2, h - 15, 3, shade(r.top, -0.08));
    // PROJECTION WELL sunk into the slab, ringed by real emitter studs
    const wx = x + 4, wy = y + 3, ww = w - 8, wh = h - 17;
    inset(wx, wy, ww, wh, '#081820');
    px(wx + 1, wy + 1, ww - 2, wh - 2, '#0a1e26');
    for (let i = 0; i < 5; i++) for (let j = 0; j < 2; j++)        // floor dot grid inside the well
      px(wx + 4 + i * 8, wy + 2 + j * 3, 1, 1, '#12333f');
    px(wx + 2, wy + 3, ww - 4, 1, '#123642'); px(wx + (ww >> 1), wy + 1, 1, wh - 2, '#123642'); // cross axes
    const rim = (0.30 + 0.18 * Math.sin(now / 600 + ph)) * g0;
    bloom(wx + 1, wy, ww - 2, 1, ACC.data, rim);                   // ring emitters, with falloff
    bloom(wx + 1, wy + wh - 1, ww - 2, 1, ACC.data, rim);
    bloom(wx, wy + 1, 1, wh - 2, ACC.data, rim * 0.8);
    bloom(wx + ww - 1, wy + 1, 1, wh - 2, ACC.data, rim * 0.8);
    for (const [ex, ey] of [[wx + 1, wy + 1], [wx + ww - 3, wy + 1], [wx + 1, wy + wh - 2], [wx + ww - 3, wy + wh - 2]])
      px(ex, ey, 2, 1, blink(600, ex + ey + ph) ? '#cdf4ff' : '#1d4a5a');   // corner studs (kept blink)
    spill(wx - 2, y + h - 13, ww + 4, ACC.data, 0.16 * g0, 4);     // well light pooling onto the near face
    // VOLUMETRIC CONE from the well up to the hologram — this is what makes it a volume, not a screen
    const hcx = x + (w >> 1), hcy = y - 5;
    ctx.save();
    ctx.globalAlpha = (0.09 + 0.04 * Math.sin(now / 260 + ph)) * g0; ctx.fillStyle = ACC.data;
    ctx.beginPath(); ctx.moveTo(wx + 4, wy + 1); ctx.lineTo(hcx - 9, hcy + 1);
    ctx.lineTo(hcx + 9, hcy + 1); ctx.lineTo(wx + ww - 4, wy + 1); ctx.closePath(); ctx.fill();
    ctx.restore();
    // the hologram itself: a station core with wings, an orbit ring and one blip running it
    const gA = (0.42 + 0.24 * Math.sin(now / 400 + ph)) * g0;
    ctx.globalAlpha = gA;
    px(hcx - 8, hcy - 1, 16, 2, ACC.data);                         // main ring/hull bar
    px(hcx - 1, hcy - 6, 2, 12, ACC.data);                         // spine
    px(hcx - 5, hcy - 5, 10, 1, '#9aeaff');                        // upper deck, brighter
    px(hcx - 4, hcy + 5, 8, 1, shade(ACC.data, -0.2));           // lower deck in the cone's shadow
    px(hcx - 9, hcy - 1, 1, 1, '#cdf4ff'); px(hcx + 8, hcy - 1, 1, 1, '#cdf4ff');  // wing tips
    ctx.globalAlpha = gA * 0.4;
    ctx.strokeStyle = ACC.data; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(hcx, hcy, 10.5, 4.5, 0, 0, 6.2832); ctx.stroke();
    ctx.globalAlpha = 1;
    const oa = now / 700 + ph;
    px(hcx - 1 + Math.round(Math.cos(oa) * 10), hcy + Math.round(Math.sin(oa) * 4), 1, 1, '#dffaff');
    for (let k = 0; k < 3; k++) {                                  // interference rows sliding up the volume
      const sy = hcy - 6 + Math.floor(((now / 420 + k * 4) % 13));
      glow(hcx - 8, sy, 16, 1, '#cdf4ff', 0.10 * g0);
    }
    bloom(hcx - 8, hcy - 5, 16, 11, ACC.data, (0.05 + 0.03 * Math.sin(now / 400 + ph)) * g0);  // volume haze
  };

  F.screens = (x, y, w, h, f) => {
    // SCREENS (2x1) — v4. Was three identical cells in a row, which is the exact uniformity trap this
    // family has to dodge. Now a real CLUSTER on one column: a wide status head up top, two heads hanging
    // off a crossbar below, each showing a DIFFERENT kind of content. One unit still runs diagnostics.
    // ANCHOR: the cast column runs UNBROKEN from the crossbar into the base plate, and the pair of lower
    // heads hangs low enough to sit in the placed tile — the sweep left a 1px stem and a 7px air gap
    // between the column foot and the base, so the whole cluster floated a tile north of its own footprint.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const g0 = on ? 1 : 0.6;
    shadow2(x + 4, y + h - 1, w - 8);
    // cast base + single column: one stem reads cleaner than two posts at 24px, and separates this
    // prop from the rolling-post props elsewhere in the family
    chamf(x + 4, y + h - 5, w - 8, 5, LINE, 2);
    px(x + 5, y + h - 4, w - 10, 3, r.face);
    px(x + 5, y + h - 4, w - 10, 1, r.lit); keyEdge(x + 6, y + h - 4, 6, 1, 0.16);
    px(x + 5, y + h - 2, w - 10, 1, r.ao);
    px(x + 9, y - 8, 6, h + 7, LINE);                            // cast column, crossbar -> base, real width
    px(x + 10, y - 8, 4, h + 6, r.face);
    px(x + 10, y - 8, 1, h + 6, r.lit); px(x + 13, y - 8, 1, h + 6, r.dk);
    rimEdge(x + 13, y - 6, 1, h + 2, 0.18);
    px(x + 10, y + h - 5, 4, 1, shade(r.face, -0.32));         // cast seam where the neck enters the foot
    cable(x + 14, y - 6, x + 17, y + h - 3, 2.2);                // loom sagging down the shade side
    px(x + 3, y - 8, w - 6, 2, LINE);                            // crossbar the lower heads hang from
    px(x + 4, y - 8, w - 8, 1, shade(r.face, 0.10)); keyEdge(x + 4, y - 8, 6, 1, 0.18);
    // one shared head routine: chamfered bezel, recessed glass, falloff bloom, light spilling below it
    const head = (hx, hy, hw, hh, kind, idx) => {
      const dead = (U.hash('scr' + x + idx) % 7) === 0;           // kept: one unit runs diagnostics
      chamf(hx - 1, hy - 1, hw + 2, hh + 2, LINE, 1);
      chamf(hx, hy, hw, hh, '#161d1a', 1);
      px(hx + 1, hy, hw - 2, 1, '#2c3b33'); keyEdge(hx + 1, hy, 4, 1, 0.24);
      px(hx, hy + 1, 1, hh - 2, '#20302a'); px(hx + hw - 1, hy + 1, 1, hh - 2, '#0d1512');
      rimEdge(hx + hw - 1, hy + 1, 1, hh - 2, 0.20);
      const sx = hx + 1, sy = hy + 1, sw = hw - 2, sh = hh - 2;
      inset(hx, hy, hw, hh, '#07120f');
      px(sx, sy, sw, sh, dead ? '#0d1a16' : (on ? '#08191c' : '#071113'));
      const acc = dead ? '#3a5a50' : (kind === 0 ? ACC.work : ACC.data);
      if (dead) {                                                 // static snow — a unit that lost its feed
        for (let k = 0; k < 6; k++)
          px(sx + (U.hash('st' + idx + k + Math.floor(now / 150)) % sw),
             sy + (U.hash('su' + idx + k + Math.floor(now / 150)) % sh), 1, 1, '#3a5a50');
        px(sx, sy + sh - 1, sw, 1, '#16241f');
      } else if (kind === 0) {                                    // code column
        for (let j = 0; j < sh; j++) codeRow(sx, sy + j, sw, j * 2 + idx + Math.floor(ph), shade(acc, on ? 0 : -0.5), on ? '#eaffe8' : '#2c4a38');
        px(sx + (Math.floor(now / 300) % (sw - 1)), sy + sh - 1, 1, 1, blink(400, ph) ? '#eaffe8' : shade(acc, -0.6));
      } else if (kind === 1) {                                    // bar histogram
        for (let i = 0; i < sw; i += 2) {
          const v = 1 + Math.floor((1 + Math.sin(now / 300 + i * 0.8 + idx + ph)) * (on ? 1.4 : 0.6));
          px(sx + i, sy + sh - v, 1, v, shade(acc, on ? 0 : -0.5));
        }
        px(sx, sy + sh - 1, sw, 1, shade(acc, -0.55));          // baseline
      } else {                                                    // wide status trace + lamp row
        px(sx, sy, sw, 1, shade(acc, on ? -0.2 : -0.62));       // header rule
        for (let i = 0; i < sw; i++)
          px(sx + i, sy + 2 - Math.round(Math.max(0, Math.sin(now / 200 + i * 0.55 + ph))), 1, 1, shade(acc, on ? 0 : -0.5));
        for (let i = 0; i < 4; i++)
          px(sx + 1 + i * 3, sy + sh - 1, 2, 1, blink(800, i + ph) ? shade(on ? ACC.flow : ACC.flow, on ? 0 : -0.5) : '#2c3a32');
      }
      scanl(sx, sy, sw, sh, on ? 0.16 : 0.24);
      bloom(sx, sy, sw, sh, acc, (dead ? 0.07 : 0.15) * g0);
      spill(hx, hy + hh + 1, hw, acc, 0.14 * g0, 3);              // each head lights what's under it
      px(hx + hw - 2, hy + hh - 1, 1, 1, blink(900, idx + ph) ? (on ? '#2ee6c8' : '#1d6a5c') : '#143028'); // bezel LED
    };
    head(x + 5, y - 14, 14, 6, 2, 2);                             // wide status head crowning the column
    head(x, y - 1, 11, 6, 0, 0);                                  // code head, west — hangs INSIDE the tile
    head(x + 13, y - 1, 11, 6, 1, 1);                             // chart head, east
    px(x + 9, y - 9, 6, 1, shade(r.face, -0.35));               // yoke pad under the top head
    px(x + 8, y + 6, 8, 1, LINE); px(x + 9, y + 6, 6, 1, shade(r.face, 0.08));   // clamp yoke: pair -> column
  };

  F.tank = (x, y, w, h, f) => {
    // TANK (2x1) — v4. The one prop in this family that is NOT a display: its light comes from a lamp
    // under the rim shining DOWN THROUGH water, so it gets caustics, a bright surface line and a cool
    // spill onto the stand — never scanlines. Curved glass: the end columns pinch, so it reads cylindrical.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const gTop = y - 7, gBot = y + 8, gh = gBot - gTop;             // glass body
    const aqua = '#7adfd0';
    shadow2(x + 1, y + h - 1, w - 2);
    // low stand with feet + the pump housing on the east end
    chamf(x, y + 8, w, 4, LINE, 1);
    px(x + 1, y + 9, w - 2, 2, r.face);
    px(x + 1, y + 9, w - 2, 1, r.lit); keyEdge(x + 2, y + 9, 7, 1, 0.16);
    px(x + 1, y + 11, 3, 1, r.ao); px(x + w - 4, y + 11, 3, 1, r.ao);   // feet
    px(x + w - 7, y + 9, 5, 2, shade(r.face, -0.2));                  // pump housing
    px(x + w - 6, y + 10, 1, 1, blink(1000, ph) ? '#2ee6c8' : '#143028'); // pump LED (kept beat)
    cable(x + w - 3, y + 9, x + w + 1, y + 11, 1.6);
    // CURVED GLASS: draw the body column by column so the flanks darken toward the silhouette
    px(x - 1, gTop - 1, w + 2, gh + 2, LINE);
    for (let i = 0; i < w; i++) {
      const t = Math.abs((i + 0.5) / w - 0.5) * 2;                 // 0 at the centre, 1 at the flanks
      const k = -0.10 - t * t * 0.42 + (on ? 0.06 : -0.06);        // flanks roll off into the silhouette
      px(x + i, gTop, 1, 5, shade('#155a54', k));                // clear water just under the surface
      px(x + i, gTop + 5, 1, 5, shade('#0f4444', k));            // mid depth
      px(x + i, gTop + 10, 1, gh - 10, shade('#0a2c2e', k));     // murk at the bottom
    }
    px(x, gTop, w, 1, shade('#2a6a62', 0.15));                    // the water line seen through the glass
    for (let i = 0; i < 4; i++) {                                   // caustics rippling across the bottom
      const cwid = 3 + (i % 2), cxp = x + 2 + ((i * 6 + Math.floor(now / 240 + ph)) % (w - 6));
      glow(cxp, gBot - 2, cwid, 1, aqua, (on ? 0.22 : 0.12) - i * 0.02);
    }
    px(x + 1, gTop + 1, 1, gh - 2, shade(aqua, -0.45));           // lit west glass edge
    px(x + w - 2, gTop + 1, 1, gh - 2, '#08201f');                  // dark east glass edge
    rimEdge(x + w - 2, gTop + 2, 1, gh - 5, 0.20);
    glow(x + 3, gTop + 2, 2, gh - 5, '#bffff2', 0.16);              // specular streak on the curve (kept)
    glow(x + w - 6, gTop + 3, 1, gh - 8, '#bffff2', 0.07);          // second faint streak (kept)
    // suspended specimen, bobbing, with a rim light off the surface lamp and a couple of tendrils
    const bob = Math.round(Math.sin(now / 1100 + ph) * 1.5), sx = x + (w >> 1) - 2, sy = y - 1 + bob;
    px(sx, sy, 4, 3, '#16504a'); px(sx + 1, sy - 1, 2, 1, '#16504a');
    px(sx, sy, 4, 1, '#2a7a6e'); px(sx, sy, 1, 3, '#2a7a6e');       // rim light, lit from above-west
    px(sx + 3, sy + 1, 1, 2, '#0d3a36');
    for (let i = 0; i < 2; i++)
      px(sx + 1 + i * 2, sy + 3, 1, 2 + ((Math.floor(now / 420 + i + ph)) % 2), '#123f3c');   // tendrils
    for (let i = 0; i < 3; i++) {                                   // bubbles rising (kept 1:1 beat)
      const bp = (now / (700 + i * 160) + i * 0.7 + ph) % 1;
      px(x + 4 + i * 6, gBot - 1 - Math.floor((1 - bp) * (gh - 3)), 1, 1, aqua);
      px(x + 5 + i * 6, gBot - 1 - Math.floor((1 - ((bp + 0.4) % 1)) * (gh - 3)), 1, 1, '#3a8a80');
    }
    // HEAVY TOP RIM we look down onto — steel, warm-keyed, hiding the lamp that lights the water
    chamf(x - 1, y - 11, w + 2, 5, LINE, 1);
    px(x, y - 10, w, 3, r.top);
    px(x, y - 10, w, 1, r.sheen); keyEdge(x + 1, y - 10, 8, 1, 0.28);
    px(x, y - 8, w, 1, shade(r.top, -0.22));                      // front lip of the rim
    for (let i = 0; i < 3; i++) px(x + 3 + i * ((w - 7) >> 1), y - 10, 1, 1, '#5a8a80');  // cap bolts (kept)
    px(x + 2, y - 8, w - 4, 1, '#2a6a62');                          // liquid surface under the rim
    bloom(x + 2, y - 8, w - 4, 1, aqua, (0.30 + 0.16 * Math.sin(now / 500 + ph)) * (on ? 1 : 0.7));
    spill(x + 1, y - 7, w - 2, aqua, on ? 0.20 : 0.13, 5);          // lamp light pushing down through the water
    spill(x + 1, y + 8, w - 2, aqua, on ? 0.14 : 0.08, 3);          // and pooling out onto the stand
    px(x + 1, y + 8, w - 2, 1, '#143028');                          // seal where glass meets the stand
  };

  F.whiteboard = (x, y, w, h, f) => {
    // WHITEBOARD (4x1) — v4, and deliberately the ANTI-SCREEN of this family: a MATTE dry-erase sheet
    // with no bloom, no scanlines and no emissive at all. Its only light is the ceiling strip raking
    // across the top of the sheet and dying off toward the tray, which is exactly how paper behaves.
    // It also gets the family's only A-frame stand, so its silhouette never confuses with a display.
    const r = RAMP.steel, ph = (f && f.x) || 0;
    const bt = y - 10, bh = 17;                                    // board rides y-10..y+6
    const ink = { red: '#c04640', blue: '#3a6aa0', dk: '#4a5a52' };
    shadow2(x + 3, y + h - 1, w - 6);
    // A-FRAME on casters: raked legs plus a real cross-brace, so the board is carried, not balanced
    for (const s of [-1, 1]) {
      const bx = x + (w >> 1) + s * 9;
      for (let j = 0; j < 6; j++) px(bx + s * j, y + 5 + j, 2, 1, LINE);
      for (let j = 0; j < 6; j++) px(bx + s * j, y + 5 + j, 1, 1, s < 0 ? r.lit : r.dk);
      chamf(bx + s * 6 - 3, y + h - 3, 8, 3, LINE, 1);             // caster yoke
      px(bx + s * 6 - 2, y + h - 2, 6, 1, r.face);
      px(bx + s * 6 - 2, y + h - 1, 2, 1, '#1a1e22'); px(bx + s * 6 + 2, y + h - 1, 2, 1, '#1a1e22');
      ctx.globalAlpha = 0.28; px(bx + s * 6 - 3, y + h, 8, 1, '#000'); ctx.globalAlpha = 1;
    }
    px(x + (w >> 1) - 12, y + 8, 24, 1, LINE);                     // cross-brace tying the legs together
    px(x + (w >> 1) - 12, y + 8, 24, 1, shade(r.face, 0.04));
    px(x + (w >> 1) - 3, y + 5, 6, 2, shade(r.face, -0.2));      // hinge block under the board
    // aluminium frame — light on the crown, cool on the shade flank, corner brackets at all four corners
    chamf(x - 1, bt - 1, w + 2, bh + 2, LINE, 2);
    chamf(x, bt, w, bh, r.face, 2);
    px(x + 2, bt, w - 4, 1, r.top); keyEdge(x + 2, bt, 14, 1, 0.28);
    px(x, bt + 2, 1, bh - 4, r.lit); px(x + w - 1, bt + 2, 1, bh - 4, r.dk);
    rimEdge(x + w - 1, bt + 2, 1, bh - 4, 0.22);
    for (const cx0 of [x + 1, x + w - 3]) {
      px(cx0, bt + 1, 2, 2, shade(r.top, 0.22)); px(cx0, bt + bh - 3, 2, 2, r.ao);
    }
    // THE SHEET — matte, top-lit. Three broad value steps top-to-bottom is all a matte surface gets;
    // any specular streak here would make it read as glass.
    const sx = x + 3, sy = bt + 2, sw = w - 6, sh = bh - 6;
    px(sx - 1, sy - 1, sw + 2, sh + 2, shade(r.face, -0.45));    // the sheet sits proud of the frame
    px(sx, sy, sw, sh, '#c6dccb');
    px(sx, sy, sw, 2, '#dcefe0');                                  // ceiling strip raking the top
    keyEdge(sx, sy, sw, 1, 0.13);
    px(sx, sy + sh - 2, sw, 2, '#aec3b4');                         // falls off toward the tray
    px(sx, sy + sh - 1, sw, 1, '#9db2a4');
    wear(sx + 1, sy + 1, sw - 2, sh - 2, 4 + (ph % 2), '#bcd2c1');  // ghosts of old, badly-erased marker
    px(sx + 24, sy + 3, 8, 3, '#bfd6c5');                          // one broad eraser smudge
    // CONTENT — a real working board: a two-node flow at the left, a bulleted list, a small bar chart.
    px(sx + 2, sy + 1, 12, 1, ink.red); px(sx + 2, sy + 2, 8, 1, shade(ink.red, 0.25));  // heading + rule
    px(sx + 2, sy + 5, 7, 4, '#c6dccb'); rr(sx + 2, sy + 5, 7, 4, ink.blue);               // node A
    px(sx + 3, sy + 6, 5, 2, '#c6dccb');
    px(sx + 14, sy + 5, 7, 4, '#c6dccb'); rr(sx + 14, sy + 5, 7, 4, ink.blue);             // node B
    px(sx + 15, sy + 6, 5, 2, '#c6dccb');
    px(sx + 9, sy + 6, 5, 1, ink.dk); px(sx + 12, sy + 5, 1, 3, ink.dk);                   // arrow A -> B
    for (let i = 0; i < 3; i++) {                                   // bulleted list, centre-right
      px(sx + 24, sy + 6 + i * 2, 1, 1, ink.red);
      px(sx + 26, sy + 6 + i * 2, 8 - i * 2, 1, ink.dk);
    }
    px(sx + 24, sy + 1, 6, 1, ink.blue);                            // list heading
    const chx = sx + sw - 12;                                       // bar chart, top-right
    px(chx, sy + 1, 1, 7, ink.dk); px(chx, sy + 7, 11, 1, ink.dk);
    for (let i = 0; i < 4; i++) px(chx + 2 + i * 2, sy + 7 - (2 + (U.hash('wb' + i) % 4)), 1, 2 + (U.hash('wb' + i) % 4), i === 3 ? ink.red : ink.blue);
    // magnets + sticky notes — paper on paper, held down, nothing lit
    px(sx + 34, sy + 2, 3, 3, '#e8cf5e'); px(sx + 34, sy + 2, 3, 1, '#f4e28c'); px(sx + 35, sy + 3, 2, 1, '#bda347');
    px(sx + 38, sy + 4, 3, 3, '#82c98f'); px(sx + 38, sy + 4, 3, 1, '#a9dcb2'); px(sx + 39, sy + 5, 1, 1, '#4a8a58');
    px(sx + 21, sy + 1, 1, 1, '#b8452e'); px(sx + 33, sy + 8, 1, 1, '#3a6aa0');            // bare magnets
    // marker tray bolted across the frame's bottom rail
    px(x + 3, bt + bh - 3, w - 6, 3, LINE);
    px(x + 4, bt + bh - 2, w - 8, 2, shade(r.face, 0.08));
    px(x + 4, bt + bh - 2, w - 8, 1, r.lit); keyEdge(x + 5, bt + bh - 2, w - 12, 1, 0.13);
    px(x + 7, bt + bh - 3, 5, 1, ink.red); px(x + 14, bt + bh - 3, 5, 1, ink.blue);
    px(x + 21, bt + bh - 3, 4, 1, '#2c8a5a'); px(x + 28, bt + bh - 3, 4, 2, '#8a98a8');    // markers + eraser block
    px(x + 28, bt + bh - 3, 4, 1, '#a8b6c4');
  };

  F.rack = (x, y, w, h, f) => {
    /* v32 DATA RACK (2x1) — rebuilt as a real rack-mount SERVER CABINET. Everything before this was a
       low wide box with three LED strips, which is why it never read as storage.
       ⛔ A SERVER RACK IS COUNTABLE BLADES IN A FRAME. The read comes from repetition with a REVEAL
          between each unit — five separate slabs you could pull out one at a time — not from a
          continuous face with lights on it.
       ⛔ EACH BLADE NEEDS ITS OWN LIGHT-TO-DARK, and the stack needs to fall off down its height, or
          five identical rows are a radiator grille.
       ⛔ The LEDs are the smallest thing on the prop, never the subject. Green = up, one amber drive
          light per blade, and they only bloom when the room is actually working. */
    const r = EQUIPMENT, b = INSTRUMENT, on = !!(f && f.work);
    const base = y + h, top = y - 14;

    shadow2(x + 1, base - 1, w - 2);
    deckPlate(x, base - 4, w, 4);
    deckSocket(x + w + 1, base - 3, on);
    cable(x + w - 2, top + 6, x + w + 2, base - 3, 2.4);           // loom sagging off the east flank

    /* ---- CABINET: lit top plane, uprights with a real return, dark interior ---- */
    px(x, top, w, base - top, r.ink);
    px(x + 1, top + 1, w - 2, 2, r.lit);                           // top plane catching the ceiling
    px(x + 2, top + 1, 7, 1, r.hi);                                // one specular run, west
    px(x + 1, top + 3, w - 2, 1, r.mid);
    px(x + w - 6, top + 1, 3, 1, r.face); // brushed interruption in the cabinet crown                           // front edge of the top
    px(x + 1, top + 4, w - 2, base - top - 6, r.ao);               // the cabinet interior, in shade
    px(x + 1, top + 4, 2, base - top - 6, r.face);                 // west rail, lit
    px(x + w - 3, top + 4, 2, base - top - 6, r.dk);               // east rail, shaded
    for (let i = 0; i < 5; i++) {                                  // rail mounting holes
      px(x + 1, top + 6 + i * 3, 1, 1, r.ao); px(x + w - 2, top + 6 + i * 3, 1, 1, r.ao);
    }
    px(x + 2, base - 3, w - 4, 1, r.ao);                           // plinth
    px(x + 2, base - 4, w - 4, 1, r.mid);

    captiveBolt(x + 1, top + 2, r); captiveBolt(x + w - 3, top + 2, r);
    /* ---- FIVE BLADES, each its own slab, falling off down the stack ---- */
    const tones = [r.top, r.top, r.face, r.face, r.dk];
    for (let i = 0; i < 5; i++) {
      const by = top + 5 + i * 3, t = tones[i];
      px(x + 3, by, w - 6, 2, t);                                  // the blade face
      px(x + 3, by, w - 6, 1, shade(t, 0.26));                   // its own top catch
      px(x + 3, by + 2, w - 6, 1, r.ao);                           // the REVEAL between units
      px(x + 4, by + 1, 4, 1, shade(t, -0.34));                  // drive bay slot
      px(x + w - 7, by, 2, 2, shade(t, 0.14));                   // pull handle
      px(x + w - 7, by, 2, 1, shade(t, 0.40));
      // status: green pair = up, one amber = disk activity
      px(x + 9, by + 1, 1, 1, blink(420 + i * 130, i) ? ACC.work : shade(ACC.work, -0.66));
      px(x + 11, by + 1, 1, 1, blink(420 + i * 130, i + 1) ? ACC.work : shade(ACC.work, -0.66));
      px(x + 13, by + 1, 1, 1, blink(210, i * 1.7) ? ACC.flow : shade(ACC.flow, -0.7));
      if (on) bloom(x + 9, by + 1, 5, 1, ACC.work, 0.14);
    }
    if (on) spill(x + 3, base - 4, w - 6, ACC.work, 0.10, 3);      // the stack pools light onto the deck
  };

  F.rackV = (x, y, w, h, f) => {
    // RACK V (1x2) — TALL 3/4 server tower, the STORAGE family's machine end. Shares the family's
    // language (chamfered cap, warm crown key, cool east rim, hazard-ticked base) but its "contents" are
    // blades instead of cargo. Every LED row / link light / PSU blink is kept, now with real falloff so
    // the lights sit IN the chassis instead of on top of it.
    const r = INSTRUMENT, cw = w, rise = 7, topY = y - rise, botY = y + h - 1, ph = (f && f.x) || 0;
    shadow2(x + 1, botY, cw - 2);
    // silhouette + slim east flank that gives the tower its depth
    chamf(x - 1, topY - 5, cw + 2, botY - topY + 6, LINE, 2);
    px(x + cw - 3, topY - 1, 2, botY - topY, r.dk);
    rimEdge(x + cw - 2, topY + 1, 1, botY - topY - 3, 0.12);          // cool sky bounce down the shade flank
    px(x + 1, topY, cw - 4, (botY - 1) - topY, r.face);               // front chassis
    px(x + 1, topY, 1, (botY - 1) - topY, r.mid);                     // west sheen column
    px(x + 2, topY, cw - 5, 1, shade(r.face, 0.14));
    // chamfered cap we look down onto
    chamf(x, topY - 4, cw - 2, 4, LINE, 1);
    px(x + 1, topY - 3, cw - 4, 3, r.top);
    px(x + 1, topY - 3, cw - 4, 1, r.sheen); keyEdge(x + 1, topY - 3, 4, 1, 0.30);
    px(x + 1, topY - 1, cw - 4, 1, shade(r.top, -0.18));            // cap front lip
    px(x + 2, topY - 3, 1, 1, shade(r.sheen, 0.30)); px(x + cw - 5, topY - 3, 1, 1, r.dk);
    // rail posts framing the rack units
    px(x + 2, topY + 1, 1, (botY - 3) - topY, shade(r.face, 0.20));
    px(x + cw - 4, topY + 1, 1, (botY - 3) - topY, r.dk);
    // 5 rack units: blade body, status LED, label, link light, vent slot
    for (let u = 0; u < 5; u++) {
      const uy = topY + 1 + u * 5;
      px(x + 3, uy, cw - 7, 4, u % 2 ? r.face : r.dk);        // blade body
      px(x + 3, uy, cw - 7, 1, r.top);        // unit top catch
      px(x + 3, uy, 1, 1, r.lit); // latch end catches light, blade face stays matte
      px(x + 6, uy + 2, 2, 1, r.mid); // separate removable blade handle
      px(x + 3, uy + 4, cw - 7, 1, '#0f151b');                        // seam shadow between units
      const st = blink(420 + u * 110, ph + u);
      px(x + 4, uy + 1, 1, 1, st ? '#7fd0ff' : '#16242e');            // status LED
      if (st) bloom(x + 4, uy + 1, 1, 1, '#7fd0ff', 0.26);
      px(x + 5, uy + 1, 2, 1, '#2a3640');                             // label strip
      const lk = blink(700, ph + u * 2);
      px(x + 7, uy + 1, 1, 1, lk ? ACC.work : '#16302a');             // link light
      if (lk) bloom(x + 7, uy + 1, 1, 1, ACC.work, 0.22);
      px(x + 4, uy + 3, cw - 9, 1, '#141b22');                        // vent slot
      px(x + 5, uy + 3, 1, 1, '#1e2832'); px(x + 7, uy + 3, 1, 1, '#1e2832');
    }
    // PSU strip at the base + the hazard ticks that mark it as bolted hardware
    px(x + 3, botY - 3, cw - 7, 2, '#161d24');
    px(x + 3, botY - 3, cw - 7, 1, shade(r.face, -0.10));
    const psu = blink(1300, ph);
    px(x + 4, botY - 2, 2, 1, psu ? '#ff9d2e' : '#33241a');
    if (psu) bloom(x + 4, botY - 2, 2, 1, '#ff9d2e', 0.20);
    px(x + cw - 5, botY - 2, 1, 1, blink(1600, ph + 3) ? ACC.work : '#16302a');
    px(x + 3, botY - 4, 2, 1, '#8a7434');                             // hazard tick, shared storage-family mark
    cable(x + cw - 4, botY - 3, x + cw - 1, botY, 1.4);               // power lead sagging off the back corner
    // freestanding feet + under-gap AO
    px(x + 1, botY - 1, 2, 2, r.dk); px(x + cw - 5, botY - 1, 2, 2, r.dk);
    px(x + 1, botY - 1, 1, 1, r.lit); px(x + cw - 5, botY - 1, 1, 1, r.lit);
    underAO(x + 3, botY, cw - 8, 1);
  };

  F.bench = (x, y, w, h, f) => {
    /* v45 WORK BENCH (4x1) — a long shared bench: TWO unlike stations with genuinely empty deck
       between them, on one continuous top.
       ⛔ 48px OF ANYTHING IS A HORIZON UNLESS YOU BREAK ITS RHYTHM, and the strongest break available
          is EMPTY SPACE. The gap in the middle does more work than any amount of kit would.
       ⛔ THE TWO STATIONS MUST BE UNLIKE — a screen-and-keyboard post at one end, a stacked terminal
          with a bar-graph at the other. Two of the same thing reads as a repeated tile.
       ⛔ FOUR LEGS, and the middle pair carries a stretcher rail, or a bench this long sags visually. */
    const r = EQUIPMENT, b = INSTRUMENT, s = MAT.seat, on = !!f.work, ph = f.x || 0;
    const G = ACC.work;

    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + 7, x + w + 2, y + h - 3, 2.2);

    for (const lx of [x + 2, x + 16, x + 29, x + w - 5]) {
      px(lx, y + 8, 3, 4, r.ink);
      px(lx, y + 8, 1, 4, r.face); px(lx + 1, y + 8, 1, 4, r.dk);
      px(lx, y + 8, 1, 1, r.mid);
    }
    px(x + 17, y + 10, 13, 1, r.ink); px(x + 17, y + 10, 13, 1, r.dk);   // stretcher rail
    underAO(x + 6, y + 8, w - 12, 2);

    /* ---- one continuous top ---- */
    workstationSurface(x, y, w);
    // Three service panels share a worktop without adding tall separators.
    for (const dx of [16, 32]) { px(x + dx, y - 1, 1, 3, r.dk); px(x + dx, y + 4, 1, 1, r.dk); }

    /* ---- STATION A (west): screen on a stand + keyboard ---- */
    const mX = x + 2, mW = 12, mT = y - 13;
    px(mX + 5, y - 4, 2, 3, b.face); px(mX + 5, y - 4, 1, 3, b.top);
    chamf(mX + 2, y - 2, 8, 2, b.ink, 1); px(mX + 3, y - 1, 6, 1, b.top);
    chamf(mX - 1, mT - 1, mW + 2, 11, b.ink, 2);
    panelFinish(mX, mT, mW, 9, b);
    px(mX, mT, mW, 1, b.mid); px(mX + 1, mT, 2, 1, b.lit);
    px(mX, mT + 1, 1, 7, b.top); px(mX + mW - 1, mT + 1, 1, 7, b.dk);
    inset(mX + 1, mT + 1, mW - 2, 7, '#070f0b');
    const sx = mX + 2, sy = mT + 2, sw = mW - 4;
    if (on) {
      const sc = scr(ph);
      px(sx, sy, sw, 5, shade(sc, -0.72));
      for (let j = 0; j < 4; j++) codeRow(sx, sy + j, sw, j * 2 + Math.floor(ph), sc, '#eaffe8');
      scanl(sx, sy, sw, 5, 0.20); bloom(sx, sy, sw, 5, sc, 0.16);
      spill(mX + 1, y - 4, mW - 2, sc, 0.18, 5);
    } else { px(sx, sy, sw, 5, '#0a120d'); px(sx, sy, 3, 1, '#16231b'); }
    chamf(x + 2, y + 1, 10, 4, b.ink, 1);
    px(x + 3, y + 2, 8, 2, b.ao);
    for (let i = 0; i < 8; i += 2) { px(x + 3 + i, y + 2, 1, 1, b.lit); px(x + 4 + i, y + 3, 1, 1, b.top); }

    /* ---- THE GAP (x+17 .. x+31): deliberately empty deck. Only a coil of cable on the top. ---- */
    px(x + 21, y + 1, 5, 1, r.dk); px(x + 22, y, 3, 1, r.mid);

    /* ---- STATION B (east): a stacked terminal with a bar-graph, no keyboard ---- */
    const tX = x + 33, tW = 12, tT = y - 11;
    px(tX, tT, tW, 10, b.ink);
    px(tX + 1, tT + 1, tW - 2, 2, b.lit); px(tX + 2, tT + 1, 4, 1, b.hi);
    px(tX + 1, tT + 3, tW - 2, 1, b.mid);
    px(tX + 1, tT + 4, tW - 2, 5, b.face);
    px(tX + 1, tT + 4, 1, 5, b.top); px(tX + tW - 2, tT + 4, 1, 5, b.dk);
    px(tX + 2, tT + 5, tW - 4, 3, '#050b07');
    for (let i = 0; i < tW - 5; i++) {
      const v = 1 + Math.floor((1 + Math.sin(now / 240 + i * 0.9 + ph)) * (on ? 1.0 : 0.4));
      px(tX + 3 + i, tT + 8 - v, 1, v, on ? shade(G, 0.10) : shade(G, -0.62));
    }
    if (on) { bloom(tX + 2, tT + 5, tW - 4, 3, G, 0.18); spill(tX + 1, y - 2, tW - 2, G, 0.14, 4); }
    px(tX + 2, y - 1, 3, 1, blink(700) ? ACC.flow : shade(ACC.flow, -0.66));

  };

  F.desk = (x, y, w, h, f) => {
    /* Workstation refinement: existing footprint, screen and seat registration.
       The top, computer and monitor remain separate assembled pieces. */
    const r = EQUIPMENT, b = INSTRUMENT, s = MAT.seat, on = !!f.work, ph = f.x || 0;

    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + 7, x + w + 2, y + h - 3, 2.2);

    /* ---- legs, with real deck visible between them ---- */
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 8, 3, 4, r.ink);
      px(lx, y + 8, 1, 4, r.face); px(lx + 1, y + 8, 1, 4, r.dk);
      px(lx, y + 8, 1, 1, r.mid);
    }
    underAO(x + 6, y + 8, w - 12, 2);

    /* ---- the slab ---- */
    workstationSurface(x, y, w);

    /* ---- SMALL PC: closed tower at the west end ---- */
    const pX = x + 1, pY = y - 9;
    chamf(pX - 1, pY - 1, 8, 10, b.ink, 1);
    px(pX, pY, 6, 8, b.face);
    px(pX, pY, 6, 1, b.lit);
    px(pX, pY + 1, 1, 7, b.top); px(pX + 5, pY + 1, 1, 7, b.dk);
    px(pX + 1, pY + 2, 4, 1, b.ao); px(pX + 1, pY + 1, 4, 1, b.mid);   // optical slot + lit sill
    for (let i = 0; i < 3; i++) px(pX + 1, pY + 4 + i * 2, 4, 1, b.ao);
    px(pX + 4, pY + 3, 1, 1, on ? ACC.work : shade(ACC.work, -0.66));
    if (on) {
      bloom(pX + 4, pY + 3, 1, 1, ACC.work, 0.26);
      px(pX + 1, pY + 8, 1, 1, blink(280, ph) ? ACC.flow : shade(ACC.flow, -0.6));
    }

    /* ---- PC SCREEN on a stand ---- */
    const mX = x + 10, mW = 12, mT = y - 13, sx = mX + 2, sy = mT + 2, sw = mW - 4;
    px(mX + 5, y - 4, 2, 3, b.face); px(mX + 5, y - 4, 1, 3, b.top);   // neck
    // A single swivel post and a recessed pivot leave daylight below the monitor.
    px(mX + 4, y - 4, 4, 1, b.dk); px(mX + 5, y - 4, 2, 1, b.mid);
    chamf(mX + 2, y - 2, 8, 2, b.ink, 1); px(mX + 3, y - 1, 6, 1, b.top);
    chamf(mX - 1, mT - 1, mW + 2, 12, b.ink, 2);
    panelFinish(mX, mT, mW, 10, b);
    px(mX, mT, mW, 1, b.mid); px(mX + 1, mT, 3, 1, b.lit);
    px(mX, mT + 1, 1, 8, b.top); px(mX + mW - 1, mT + 1, 1, 8, b.dk);
    rimEdge(mX + mW - 1, mT + 2, 1, 6, 0.18);
    px(mX + 4, mT + 9, 4, 1, b.top);                              // brand strip on the chin
    inset(mX + 1, mT + 1, mW - 2, 8, '#070f0b');
    if (on) {
      const sc = scr(ph);
      px(sx, sy, sw, 6, shade(sc, -0.74));
      for (let j = 0; j < 5; j++) codeRow(sx, sy + j, sw, j * 2 + Math.floor(ph), sc, '#eaffe8');
      px(sx + (Math.floor(now / 300) % (sw - 2)), sy + 5, 1, 1, blink(400, ph) ? '#eaffe8' : shade(sc, -0.6));
      scanl(sx, sy, sw, 6, 0.20);
      bloom(sx, sy, sw, 6, sc, 0.17);
      spill(mX + 1, y - 4, mW - 2, sc, 0.20, 5);
    } else {
      px(sx, sy, sw, 6, '#0a120d');
      px(sx, sy, 4, 1, '#16231b'); px(sx + 1, sy + 1, 2, 1, '#111c15');
      px(sx + sw - 1, sy + 5, 1, 1, blink(1600, ph) ? '#ff9d2e' : '#33241a');
    }

    // Cable channel belongs to the surface, not the floor around the operator.
    px(x + 7, y - 1, 2, 1, b.ao);
    /* ---- KEYBOARD ---- */
    const kX = x + 10;
    chamf(kX - 1, y + 1, 10, 4, b.ink, 1);
    px(kX, y + 2, 8, 2, b.ao);
    px(x + 20, y + 1, 2, 3, b.ink); px(x + 20, y + 1, 1, 2, b.mid);
    for (let i = 0; i < 8; i += 2) { px(kX + i, y + 2, 1, 1, b.lit); px(kX + i + 1, y + 3, 1, 1, b.top); }

    // The world renderer owns the unchanged workstation seat.
  };

  F.desk2 = (x, y, w, h, f) => {
    /* v45 DUAL WORKSTATION (2x1) — the desk's slab and chair, but TWO screens on a shared crossbar
       and no tower. Six props grant COMPUTE and they must differ by what is ON the desk, since the
       slab underneath is the same piece of furniture in every one of them.
       ⛔ TWO SCREENS MUST NOT BE ONE WIDE SCREEN. A visible gap plus separate bezels and a crossbar
          spanning them is the read; butt them together and it is a single panel with a seam. */
    const r = EQUIPMENT, b = INSTRUMENT, s = MAT.seat, on = !!f.work, ph = f.x || 0;

    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + 7, x + w + 2, y + h - 3, 2.2);

    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 8, 3, 4, r.ink);
      px(lx, y + 8, 1, 4, r.face); px(lx + 1, y + 8, 1, 4, r.dk);
      px(lx, y + 8, 1, 1, r.mid);
    }
    underAO(x + 6, y + 8, w - 12, 2);

    workstationSurface(x, y, w);

    /* ---- CROSSBAR + TWO SCREENS, with real deck between them ---- */
    px(x + 4, y - 4, w - 8, 2, b.ink);                              // the bar they hang from
    px(x + 5, y - 3, w - 10, 1, b.mid);
    px(x + 10, y - 3, 3, 3, b.ink); px(x + 11, y - 3, 1, 3, b.top);  // centre post to the slab
    for (let k = 0; k < 2; k++) {
      const mX = x + 1 + k * 12, mW = 10, mT = y - 14;
      px(mX + 4, y - 6, 2, 2, b.face);                              // each screen's own neck
      chamf(mX - 1, mT - 1, mW + 2, 11, b.ink, 2);
      panelFinish(mX, mT, mW, 9, b);
      px(mX, mT, mW, 1, b.mid); px(mX + 1, mT, 2, 1, b.lit);
      px(mX, mT + 1, 1, 7, b.top); px(mX + mW - 1, mT + 1, 1, 7, b.dk);
      inset(mX + 1, mT + 1, mW - 2, 7, '#070f0b');
      const sx = mX + 2, sy = mT + 2, sw = mW - 4;
      if (on) {
        const sc = scr(ph + k * 3);
        px(sx, sy, sw, 5, shade(sc, -0.72));
        for (let j = 0; j < 4; j++) codeRow(sx, sy + j, sw, j * 2 + Math.floor(ph) + k * 5, sc, '#eaffe8');
        scanl(sx, sy, sw, 5, 0.20);
        bloom(sx, sy, sw, 5, sc, 0.16);
      } else {
        px(sx, sy, sw, 5, '#0a120d');
        px(sx, sy, 3, 1, '#16231b');
      }
    }
    if (on) spill(x + 2, y - 4, w - 4, scr(ph), 0.18, 5);

    /* ---- KEYBOARD, centred under the gap ---- */
    const kX = x + 7;
    chamf(kX - 1, y + 1, 11, 4, b.ink, 1);
    px(kX, y + 2, 9, 2, b.ao);
    for (let i = 0; i < 9; i += 2) { px(kX + i, y + 2, 1, 1, b.lit); px(kX + i + 1, y + 3, 1, 1, b.top); }

  };

  F.pixelrig = (x, y, w, h, f) => {
    /* v45 PIXEL RIG (2x1) — the art station. Same slab and chair as the desk; what makes it a
       different prop is the KIT ON IT: one wide screen pushed back, a big TILTED DRAWING TABLET
       taking the whole front of the desk, and a stylus in a cradle.
       ⛔ THE TABLET IS THE TELL AND IT MUST BE TILTED. A flat rectangle on a desk is a mousemat; a
          wedge stepping in one pixel per row is a drawing surface angled toward the user.
       ⛔ ITS ACCENT IS MAGENTA (ACC.lounge), not the workstation green — the one prop in COMPUTE that
          makes pictures should not glow the same colour as the ones that make text. */
    const r = EQUIPMENT, b = INSTRUMENT, s = MAT.seat, on = !!f.work, ph = f.x || 0;
    const P = ACC.lounge;

    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + 7, x + w + 2, y + h - 3, 2.2);

    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 8, 3, 4, r.ink);
      px(lx, y + 8, 1, 4, r.face); px(lx + 1, y + 8, 1, 4, r.dk);
      px(lx, y + 8, 1, 1, r.mid);
    }
    underAO(x + 6, y + 8, w - 12, 2);

    workstationSurface(x, y, w);

    /* ---- WIDE SCREEN pushed to the back of the desk ---- */
    const mX = x + 5, mW = 15, mT = y - 13;
    px(mX + 6, y - 4, 3, 3, b.face); px(mX + 6, y - 4, 1, 3, b.top);
    chamf(mX + 3, y - 2, 9, 2, b.ink, 1); px(mX + 4, y - 1, 7, 1, b.top);
    chamf(mX - 1, mT - 1, mW + 2, 11, b.ink, 2);
    panelFinish(mX, mT, mW, 9, b);
    px(mX, mT, mW, 1, b.mid); px(mX + 1, mT, 3, 1, b.lit);
    px(mX, mT + 1, 1, 7, b.top); px(mX + mW - 1, mT + 1, 1, 7, b.dk);
    inset(mX + 1, mT + 1, mW - 2, 7, '#0d0710');
    const sx = mX + 2, sy = mT + 2, sw = mW - 4;
    if (on) {
      px(sx, sy, sw, 5, shade(P, -0.74));
      px(sx, sy, sw, 1, shade(P, 0.14));                          // canvas title bar
      for (let j = 0; j < 3; j++) {                                 // colour swatch row + strokes
        const rw = 3 + ((j * 4 + Math.floor(now / 700)) % (sw - 6));
        px(sx + 1, sy + 2 + j, rw, 1, shade(P, 0.10 - j * 0.14));
      }
      for (let k = 0; k < 4; k++) px(sx + sw - 5 + k, sy + 1, 1, 1, [P, '#ffd34a', '#4ad9ff', '#41ff8a'][k]);
      scanl(sx, sy, sw, 5, 0.18);
      bloom(sx, sy, sw, 5, P, 0.18);
      spill(mX + 1, y - 4, mW - 2, P, 0.18, 5);
    } else {
      px(sx, sy, sw, 5, '#120a14');
      px(sx, sy, 4, 1, '#241528');
    }

    /* ---- THE DRAWING TABLET: a wedge across the front of the slab ---- */
    for (let i = 0; i < 4; i++) {
      const ty = y + 1 + i, inset2 = 3 - i;
      px(x + 2 + inset2, ty, w - 4 - inset2 * 2, 1, b.ink);
      px(x + 3 + inset2, ty, w - 6 - inset2 * 2, 1, i === 0 ? b.lit : i < 2 ? b.top : b.face);
    }
    px(x + 5, y + 2, w - 10, 2, '#0d0710');                         // the active surface
    if (on) {
      for (let k = 0; k < 3; k++) {
        const t = ((now / 900) + k / 3) % 1;
        px(x + 6 + Math.floor(t * (w - 13)), y + 2 + (k % 2), 1, 1, shade(P, 0.30));
      }
      bloom(x + 5, y + 2, w - 10, 2, P, 0.14);
    }
    px(x + 4, y + 4, 2, 1, on ? P : shade(P, -0.66));             // tablet status lamp
    px(x + w - 6, y + 1, 4, 1, b.ink);                              // stylus in its cradle
    px(x + w - 5, y + 1, 2, 1, r.lit);

  };

  F.coffee = (x, y, w, h, f) => {   // v4 brewer — ONE chamfered column, the hot alcove is the only lit thing
    const r = RAMP.steel, rdy = blink(1200);                    // brew-ready lamp (kept)
    shadow2(x + 2, y + 11, 9);                                  // freestanding decor: contact only, no deckplate
    // waiting mug on the deck, west — the scale cue that tells you this is counter-height, not a server rack
    px(x - 1, y + 8, 4, 4, LINE); px(x, y + 9, 2, 2, '#3a6a62'); px(x, y + 9, 2, 1, '#5aa89c');
    px(x + 2, y + 10, 1, 1, '#2a4a44');
    // the column: one bold chamfered mass. v3 drew a rounded box; the 2px cuts are what stop it reading
    // as a filing cabinet at 3x.
    chamf(x + 2, y - 3, 9, 15, LINE, 2);
    chamf(x + 3, y - 2, 7, 13, r.face, 2);
    px(x + 3, y - 1, 1, 9, r.lit); px(x + 9, y - 1, 1, 9, r.dk);
    rimEdge(x + 9, y - 1, 1, 9, 0.20);                          // cool sky bounce down the shade flank
    px(x + 3, y + 10, 7, 1, r.ao);                              // floor-line AO
    // head cap OVERHANGS the column so the silhouette steps — a straight tube reads as a pipe
    chamf(x + 1, y - 6, 11, 4, LINE, 1);
    chamf(x + 2, y - 5, 9, 3, r.top, 1);
    px(x + 3, y - 5, 7, 1, r.sheen); keyEdge(x + 3, y - 5, 4, 1, 0.30);   // warm key on the water lid
    px(x + 6, y - 5, 1, 3, shade(r.top, -0.26));              // lid seam
    px(x + 9, y - 5, 1, 1, shade(r.top, 0.34));               // hinge catch (soft, not a white speck)
    px(x + 2, y - 3, 9, 1, shade(r.top, -0.24));              // front lip of the cap
    // brew ALCOVE — a real hole cut into the column. Cutting a void into the mass is worth more at 12px
    // than any amount of surface detail: it gives the prop an interior.
    inset(x + 4, y + 1, 5, 7, '#0a0f12');
    px(x + 5, y + 1, 3, 1, '#1a2228'); px(x + 6, y + 2, 1, 1, '#0d1216');   // spout housing + spout
    const lvl = 1 + Math.floor(((now / 4000) % 1) * 3);         // pot slowly fills (kept)
    px(x + 5, y + 3, 3, 1, '#8a98a8');                          // carafe rim
    px(x + 5, y + 4, 3, 3, '#141b1e');
    px(x + 5, y + 7 - lvl, 3, lvl, '#2f4a46'); px(x + 5, y + 7 - lvl, 3, 1, '#4a706a');
    px(x + 5, y + 4, 1, 3, '#2a363c');                          // glass shine, west
    px(x + 8, y + 4, 1, 2, '#6a7888');                          // carafe handle
    if (blink(400)) px(x + 6, y + 2, 1, 1, '#3e5e58');          // drip stream (kept)
    px(x + 4, y + 8, 5, 1, '#241c14'); px(x + 5, y + 8, 2, 1, '#3a2c20');   // drip tray + old stain (kept)
    // control strip. The lamp is 1px, so it earns its read from FALLOFF, not brightness.
    px(x + 4, y, 5, 1, shade(r.face, -0.34));
    px(x + 4, y, 1, 1, rdy ? ACC.work : '#1c2a22');
    px(x + 6, y, 1, 1, '#222c32'); px(x + 8, y, 1, 1, '#222c32');   // buttons (kept)
    if (rdy) { bloom(x + 4, y, 1, 1, ACC.work, 0.34); spill(x + 4, y + 1, 5, ACC.work, 0.10, 3); }
    px(x + 4, y + 9, 2, 1, '#caa84a');                          // serial tag
    if (blink(600)) { px(x + 4, y - 8, 1, 2, '#8a8a8a'); px(x + 7, y - 9, 1, 2, '#6a6a6a'); } // steam (kept)
  };

  F.plant = (x, y, w, h, f) => {   // v4 potted palm — genuinely tapered pot, open fronds lit warm W / cool E
    const r = RAMP.gun;
    shadow2(x + 2, y + 11, 8);
    // POT: a real taper (wide rim -> narrow foot), not a rounded box. The rim is a top surface we look
    // down into, which is what sells the oblique projection on a prop this small.
    for (let j = 0; j < 7; j++) { const i = j >> 1; px(x + 1 + i, y + 5 + j, 10 - i * 2, 1, LINE); }
    for (let j = 0; j < 5; j++) {
      const i = (j + 1) >> 1;
      px(x + 2 + i, y + 6 + j, 8 - i * 2, 1, r.face);
      px(x + 2 + i, y + 6 + j, 1, 1, r.lit);
      px(x + 9 - i, y + 6 + j, 1, 1, r.dk);
    }
    rimEdge(x + 8, y + 6, 1, 4, 0.20);                          // cool sky down the shade side of the pot
    px(x + 4, y + 10, 4, 1, r.ao);                              // foot in shadow
    chamf(x + 1, y + 3, 10, 3, LINE, 1);                        // rim lip, drawn over the body
    px(x + 2, y + 4, 8, 1, '#1d1812');                          // soil in the bowl
    px(x + 4, y + 4, 2, 1, '#2a2218'); px(x + 8, y + 4, 1, 1, '#2a2218');   // clods
    px(x + 2, y + 5, 8, 1, r.sheen); keyEdge(x + 2, y + 5, 4, 1, 0.32);     // rim catches the ceiling strip
    px(x + 9, y + 5, 1, 1, r.dk);
    // FOLIAGE: open palm fronds with real gaps. A solid green mass reads as a bush-shaped blob at 3x;
    // the gaps are the silhouette. West leaves take the warm key, east leaves take the cold sky bounce.
    px(x + 5, y - 2, 2, 6, '#256032');                          // stalk
    px(x + 5, y - 8, 2, 6, '#2e7a3e');                          // centre leaf rises well above the tile
    px(x + 5, y - 8, 1, 2, '#5ec46e'); keyEdge(x + 5, y - 8, 1, 2, 0.30);
    px(x + 3, y - 6, 2, 1, '#3a9a4e'); px(x + 2, y - 5, 2, 2, '#3a9a4e');   // west frond arcs out...
    px(x + 1, y - 3, 2, 2, '#3a9a4e'); px(x + 1, y - 3, 1, 1, '#5ec46e');   // ...and down, tip lit
    keyEdge(x + 1, y - 3, 1, 1, 0.26);
    px(x + 7, y - 6, 2, 1, '#2a6a36'); px(x + 8, y - 5, 2, 2, '#2a6a36');   // east frond (shade side)
    px(x + 9, y - 3, 2, 2, '#2a6a36'); px(x + 10, y - 3, 1, 1, '#4aa45a');
    rimEdge(x + 9, y - 3, 2, 2, 0.20);                          // sky bounce on the shaded fronds
    px(x + 3, y, 2, 2, '#256032'); px(x + 3, y + 2, 1, 2, '#256032');       // west drooper over the rim
    px(x + 8, y, 2, 2, '#1f5228'); px(x + 9, y + 2, 1, 2, '#1f5228');       // east drooper
    px(x + 5, y - 3, 1, 1, '#1f5228'); px(x + 6, y, 1, 3, '#1f5228');       // stem shadows into the pot
    px(x + 8, y + 7, 1, 2, '#56645c');                          // moisture probe — a dead metal stake, never a lamp
    px(x + 8, y + 7, 1, 1, '#3c4a46');                           // its unlit head, read by shape not by glow
  };


  /* ---- DECOR EXPANSION (2026-07-15): theming set, same v2 oblique kit ---- */


  F.lavalamp = (x, y, w, h, f) => {   // v4 lava lamp — tall tapered glass, wax lit from INSIDE with falloff
    const r = RAMP.steel;
    shadow2(x + 3, y + 11, 6);
    // pedestal foot + cap are the only metal; keeping them small is what makes the glass read as glass
    chamf(x + 3, y + 8, 6, 4, LINE, 1);
    px(x + 4, y + 9, 4, 1, r.top); keyEdge(x + 4, y + 9, 2, 1, 0.26);
    px(x + 4, y + 10, 4, 1, r.face); px(x + 4, y + 11, 4, 1, r.ao);
    rimEdge(x + 7, y + 9, 1, 2, 0.20);
    // tapered glass: narrow neck widening to the base, drawn as an outline shell over a dark interior
    px(x + 4, y - 6, 4, 3, LINE); px(x + 3, y - 3, 6, 5, LINE); px(x + 2, y + 2, 8, 7, LINE);
    px(x + 5, y - 5, 2, 3, '#1a0d1c'); px(x + 4, y - 2, 4, 4, '#1a0d1c'); px(x + 3, y + 2, 6, 6, '#1a0d1c');
    px(x + 5, y - 5, 1, 3, '#33203a'); px(x + 4, y - 2, 1, 4, '#33203a'); px(x + 3, y + 2, 1, 6, '#33203a');
    keyEdge(x + 3, y + 3, 1, 4, 0.18);                          // the warm key rides the west curve of the glass
    rimEdge(x + 8, y + 3, 1, 4, 0.24);                          // cold sky on the east curve
    px(x + 4, y - 7, 4, 1, r.top); px(x + 5, y - 8, 2, 1, r.face);   // metal cap
    keyEdge(x + 4, y - 7, 2, 1, 0.26);
    // wax: a hot pool at the bottom and two blobs on offset clocks (kept). The lamp is the light source,
    // so the glow starts INSIDE the glass and falls off outward.
    px(x + 4, y + 5, 4, 3, '#a63d8f'); px(x + 4, y + 5, 4, 1, '#c44ba6');
    bloom(x + 4, y + 5, 4, 3, '#ff6ad5', 0.24);                 // the pool is the brightest thing in the prop
    const b1 = y + 4 - Math.floor(((now / 620) + x) % 11);      // wraps bottom -> top (kept clocks)
    const b2 = y + 4 - Math.floor(((now / 940) + x * 3 + 5) % 11);
    for (const by of [b1, b2]) {
      if (by > y + 4 || by < y - 5) continue;
      const half = (by < y - 2) ? 5 : (by < y + 2 ? 4 : 3);     // keep the blob inside the taper
      px(x + half, by, 2, 2, '#ff6ad5');
      px(x + half, by, 1, 1, '#ffc4ee');                        // blob highlight
      bloom(x + half, by, 2, 2, '#ff6ad5', 0.20);
    }
    bloom(x + 3, y - 3, 6, 11, '#ff6ad5', 0.09 + 0.05 * (flick(1100, x) * 0.5 + 0.5));   // kept breathing haze
  };

  F.crt_pile = (x, y, w, h, f) => {   // v4 scrap stack — two dead CRTs, the top tube still whispering static
    // blocks:true: a genuine solid on the deck, so it keeps its full contact shadow and its mass. The
    // OVERHANG of the top set is the silhouette — a neatly aligned stack reads as a cabinet.
    const r = RAMP.gun;
    shadow2(x + 1, y + 11, 10);
    // bottom CRT, face-on, dead
    chamf(x, y + 4, 11, 8, LINE, 1);
    px(x + 1, y + 5, 9, 6, r.face);
    px(x + 1, y + 5, 9, 1, r.lit); keyEdge(x + 1, y + 5, 5, 1, 0.20);
    px(x + 9, y + 6, 1, 4, r.dk); rimEdge(x + 9, y + 6, 1, 4, 0.20);
    px(x + 1, y + 10, 9, 1, r.ao);
    inset(x + 2, y + 6, 5, 4, '#0a0f12');
    px(x + 3, y + 7, 3, 1, '#161f1a'); px(x + 3, y + 8, 1, 1, '#121a16');   // dead glass keeps a reflection
    px(x + 8, y + 6, 2, 1, '#222c32'); px(x + 8, y + 7, 2, 1, '#222c32');   // vent slits
    px(x + 8, y + 9, 1, 1, '#2a1414');                          // dead power LED
    wear(x + 1, y + 5, 9, 5, 4, shade(r.face, -0.14));
    // top CRT, smaller and shoved askew so the stack looks dumped, not shelved
    chamf(x + 2, y - 4, 9, 9, LINE, 1);
    px(x + 3, y - 3, 7, 7, r.top);
    px(x + 3, y - 3, 7, 1, r.sheen); keyEdge(x + 3, y - 3, 4, 1, 0.28);
    px(x + 9, y - 2, 1, 5, r.dk); rimEdge(x + 9, y - 2, 1, 5, 0.22);
    px(x + 3, y + 3, 7, 1, shade(r.top, -0.30));
    const st = flick(70, x) > 0.55;                             // intermittent static burst (kept)
    inset(x + 4, y - 2, 5, 5, st ? '#16281f' : '#0c1114');
    px(x + 5, y - 1, 3, 1, st ? '#2e5a44' : '#141d18');         // idle is never a black hole
    if (st) {
      px(x + 5 + ((now >> 4) % 3), y, 1, 1, ACC.work);          // wandering hot pixel (kept)
      scanl(x + 5, y - 1, 3, 3, 0.30);
      bloom(x + 5, y - 1, 3, 3, ACC.work, 0.16);
    }
    cable(x + 2, y + 10, x - 1, y + 11, 1.2, '#0e1418');        // dead lead spilling west onto the deck
  };

  F.cablerun = (x, y, w, h, f) => {   // v4 taped floor loom (2x1) — FLAT paint, walk-over, zero rise
    // Agents cross this constantly, so the whole prop lives in the ground plane: no oblique body, no front
    // face, no contact shadow. Depth comes from the strands separating and the tape lying on top of them.
    // v4's three strands were #2c383f / #161d21 / #080c0e — the lower two sit within a couple of values of
    // the deck itself, so two thirds of the bundle was invisible and the prop read as a lone taped box with a
    // blue light on it. Each strand now has its own JACKET COLOUR (that is also what a real loom looks like:
    // you bundle cables so you can still tell them apart) and every one clears the plating.
    const HI = '#7d8b96', MD = '#4a5a54', LO = '#5c4436';
    // three strands, each sagging on its own line so the bundle reads as rope rather than a painted bar
    for (let i = 0; i < 3; i++) {
      const yy = y + 5 + i, c = i === 0 ? HI : (i === 1 ? MD : LO);
      for (let sx = 0; sx < w; sx++) {
        const s = Math.round(Math.sin((sx / w) * Math.PI) * 1.6);
        px(x + sx, yy + s, 1, 1, c);
        px(x + sx, yy + s + 1, 1, 1, shade(c, -0.52));         // each strand's own underside shadow
      }
    }
    // gaffer tape crossings pinning the loom to the deck — painted flat, with a peeling corner
    for (const tx of [x + 5, x + w - 9]) {
      px(tx, y + 4, 4, 6, '#3a3426');
      px(tx, y + 4, 4, 1, '#4c4430'); keyEdge(tx, y + 4, 4, 1, 0.14);
      px(tx + 1, y + 9, 2, 1, '#2a2418');                       // corner lifting off the plate
      wear(tx, y + 4, 4, 6, 2, '#2f2a1e');
    }
    // one frayed strand escaping the bundle, and a flat inline connector block
    px(x + 10, y + 3, 3, 1, '#0e1418'); px(x + 13, y + 2, 2, 1, '#0e1418');
    px(x + 15, y + 5, 4, 3, '#1c2429'); px(x + 15, y + 5, 4, 1, '#2c383f'); px(x + 16, y + 6, 2, 1, '#0a0e11');
    if (blink(2400, x)) { px(x + 15, y + 2, 1, 1, ACC.flow); bloom(x + 15, y + 2, 1, 1, ACC.flow, 0.30); }  // rare stray spark (kept)
    // the PACKET: one live datum running the loom. Flat light on a flat prop — a bloom ring, no rise.
    const pxp = x + 1 + Math.round((now / 14) % (w - 5));
    bloom(pxp, y + 6, 3, 1, ACC.data, 0.34);
    px(pxp, y + 6, 3, 1, shade(ACC.data, -0.10));
  };

  F.hazardpad = (x, y, w, h, f) => {   // v4 hazard decal (2x1) — pure deck PAINT, walk-over, zero rise
    // This is paint on plating and nothing else: no body, no shadow, no lip. Its job is to say "keep clear"
    // and then get walked over without an agent ever appearing to clip through it.
    // v4 painted the stripes onto BARE DECK: there was no pad body, and the alternating band was #141a1e —
    // within a couple of values of the floor itself. So only every other stripe rendered, over nothing, and
    // the prop read as three loose yellow scribbles lying on the plating. The decal now has a real painted
    // ground, and both stripe colours sit clear of the deck's value.
    const Y = '#9a8038', YD = '#6b5827', K = '#232b31';
    px(x + 1, y + 1, w - 2, h - 2, '#1b2227');                  // the painted ground — this is what was missing
    // Parity comes off a COUNTER, never off (i / step): the loop starts negative and only lands on integer
    // multiples when the step happens to divide h, so deriving it from i silently drops every yellow band.
    for (let i = -h, k = 0; i < w; i += 5, k++) {               // diagonal caution bands, clipped to the pad
      const lit = k % 2 === 0;
      for (let j = 2; j < h - 2; j++) {
        const sx = x + i + j, L = Math.max(x + 1, sx), R = Math.min(x + w - 1, sx + 3);
        if (R > L) px(L, y + j, R - L, 1, lit ? (j < h / 2 ? Y : YD) : K);
      }
    }
    px(x + 1, y + 1, w - 2, 1, '#2f3940'); px(x + 1, y + h - 2, w - 2, 1, '#10161a');   // border rails
    px(x + 1, y + 1, 1, h - 2, '#2a343a'); px(x + w - 2, y + 1, 1, h - 2, '#10161a');
    // flat two-temperature split: the ceiling strips fall on the north half, the cold bounce fills the south.
    // On a decal this is the ONLY light cue there is — there are no facets to shade.
    keyEdge(x + 2, y + 2, w - 4, 2, 0.10);
    rimEdge(x + 2, y + h - 5, w - 4, 2, 0.08);
    // WEAR is the whole story of a hazard pad: the stripes get walked off first down the middle
    wear(x + 1, y + 2, w - 2, h - 4, 14, '#242c30');
    ctx.globalAlpha = 0.18; px(x + 4, y + 4, w - 8, 3, '#0c1013'); ctx.globalAlpha = 1;   // traffic scuff track
    ctx.globalAlpha = 0.11; px(x + 6, y + 3, w - 12, 1, '#0c1013'); px(x + 7, y + 7, w - 14, 1, '#0c1013'); ctx.globalAlpha = 1;
    px(x + 2, y + 2, 2, 1, '#242c30'); px(x + w - 4, y + h - 3, 2, 1, '#242c30');   // chipped corners
    px(x + 1, y + 5, 1, 2, '#2a3236'); px(x + w - 2, y + 6, 1, 2, '#2a3236');       // rails scuffed through
  };

  F.tallplant = (x, y, w, h, f) => {   // v4 floor planter (BLOCKS) — heavy barrel + a tower of upright blades
    const r = RAMP.gun, ph = (f && f.x) || 0;
    const sway = flick(1400, ph + x) > 0 ? 1 : 0;                    // slow top-growth sway (kept)
    shadow2(x + 2, y + 11, 8);                                       // real floor contact — this one BLOCKS
    // TOP-BIAS OBLIQUE barrel: soil surface we look down on, short banded face
    chamf(x + 1, y + 3, 10, 9, LINE, 2);
    chamf(x + 2, y + 4, 8, 3, '#241c14', 1);
    px(x + 3, y + 4, 6, 1, '#33281c');                               // back of the soil catches the ceiling strip
    px(x + 4, y + 5, 2, 1, '#1a140e');                               // a dug hollow, so the soil isn't a flat slab
    px(x + 2, y + 6, 8, 1, r.top); keyEdge(x + 2, y + 6, 5, 1, 0.26);
    px(x + 2, y + 7, 8, 4, r.face);
    px(x + 2, y + 7, 1, 4, r.lit); px(x + 9, y + 7, 1, 4, r.dk);
    rimEdge(x + 9, y + 7, 1, 4, 0.22);                               // cool bounce down the shade flank
    px(x + 2, y + 9, 8, 1, shade(r.face, -0.40));                  // barrel band
    px(x + 2, y + 10, 8, 1, r.ao);
    wear(x + 2, y + 7, 8, 4, 3, shade(r.face, -0.14));
    // FOLIAGE = a tight COLUMN of upright blades. Shape is the whole job at 12px: this is the only plant in
    // the batch that reads as a vertical tower, which is how it stays tellable from monstera/bonsai/flytrap.
    const BL = [[3, 9, -2, 1], [4, 13, -1, 2], [5, 18, 0, 2], [7, 14, 2, 2], [8, 10, 3, 1]];
    for (let i = 0; i < BL.length; i++) {
      const b = BL[i], bh = b[1], bw = b[3];
      for (let j = 0; j < bh; j++) {
        const t = j / (bh - 1);
        const sx = x + b[0] + Math.round(t * t * b[2]) + (t > 0.66 ? sway : 0);
        px(sx - 1, y + 3 - j, bw + 2, 1, '#0d1c12');                 // dark edge gives each blade real mass
        px(sx, y + 3 - j, bw, 1, t > 0.72 ? '#3a9a4e' : t > 0.34 ? '#2e7a3e' : '#1f5228');
      }
      const tipX = x + b[0] + Math.round(b[2]) + sway;
      if (i !== 0) px(tipX, y + 4 - bh, 1, 1, '#5ec46e');            // lit blade tips
    }
    keyEdge(x + 4, y - 13, 2, 4, 0.14);                              // warm key down the sunward blades
    rimEdge(x + 9, y - 7, 1, 6, 0.14);                               // cool sky on the shade side of the tower
    px(x + 9, y + 2, 2, 2, '#1f5228'); px(x + 10, y + 4, 1, 2, '#1f5228');   // one tendril flopping over the rim
    // NO status lamp. A blinking cyan "bioluminescent bud" floated one pixel clear of the tallest blade, so it
    // read as a free-standing indicator light hovering over a houseplant. Emissive blinks are this station's
    // TELEMETRY vocabulary (connector state, workbench pulse, cap surges) — spending it on a pot plant both
    // lies about the object and dilutes the lamps that carry real state. The sway is the only motion a planter
    // earns, because air handling is a mechanism that actually exists here.
  };


  F.terrarium = (x, y, w, h, f) => {   // v4 sealed tank (BLOCKS) — glass box on a stand, a moss colony breathing
    const r = RAMP.steel, ph = (f && f.x) || 0;
    shadow2(x + 2, y + 11, 8);                                       // real floor contact — this one BLOCKS
    leg(x + 3, y + 8, 3, r); leg(x + 8, y + 8, 3, r);
    underAO(x + 3, y + 9, 6, 2);
    // GLASS BOX is the whole silhouette — a hard rectangle, which is what keeps it apart from the plants
    chamf(x, y - 5, 11, 13, LINE, 1);
    px(x + 1, y - 3, 9, 10, '#0e1a1c');                              // tank void, never dead black
    px(x + 1, y - 4, 9, 2, r.top); px(x + 2, y - 4, 7, 1, r.sheen);  // sealed lid casting we look down on
    keyEdge(x + 2, y - 4, 5, 1, 0.28);
    px(x + 1, y - 2, 9, 1, shade(r.top, -0.34));                   // lid underside AO onto the glass
    px(x + 1, y - 2, 1, 10, '#31424a');                              // west pane catches the strip
    px(x + 2, y - 2, 1, 4, '#223036');
    px(x + 9, y - 2, 1, 10, '#142024'); rimEdge(x + 9, y - 2, 1, 10, 0.20);   // cool sky down the shade pane
    px(x + 1, y + 7, 9, 1, r.dk);                                    // base channel the panes seat into
    // moss colony: a humped bed, not a flat stripe — the humps are what read as living matter at 12px
    px(x + 2, y + 4, 7, 3, '#12301e');
    px(x + 2, y + 3, 3, 1, '#1d5c34'); px(x + 6, y + 3, 3, 1, '#1d5c34');
    px(x + 3, y + 2, 2, 1, '#2e7a3e'); px(x + 7, y + 2, 1, 1, '#256032');
    px(x + 5, y + 1, 1, 2, '#3a9a4e');                               // one taller frond
    bloom(x + 2, y + 2, 7, 5, ACC.work, 0.10 + 0.07 * (flick(900, ph + x) * 0.5 + 0.5));   // the colony breathing
    spill(x + 2, y + 6, 7, ACC.work, 0.14, 3);                       // its light pooling on the tank floor
    const sy = y + 3 - Math.floor(((now / 800) + ph + x) % 7);       // one spore drifting up (kept behaviour)
    px(x + 3 + Math.floor(((now / 1300) + ph + x) % 5), sy, 1, 1, '#7dffb0');
    px(x + 8, y - 1, 1, 2, '#3a4a52');                               // condensation on the east pane — it sits, it
    px(x + 8, y - 3, 1, 1, '#16302a');                               // does not flash. Seal fitting, unlit: the
    // colony's own glow (the bloom + spore drift above) is this tank's life. A green seal LAMP on top of it was a
    // second, fake voice claiming the lid had a sensor — keep the biology, drop the instrumentation.
  };

  /* ---- DECOR EXPANSION wave 2 (2026-07-15): grime + machinery + glow ---- */


  F.holopet = (x, y, w, h, f) => {   // v4 holo jellyfish — FLUSH deck emitter, walk-over; nothing solid at all
    const ph = (f && f.x) || 0;
    // The emitter is INLAID in the deck (2 rows, no rise) because agents walk straight over this tile; the
    // pet itself is light, so it never gets a contact shadow.
    px(x + 3, y + 8, 6, 2, '#0a0e11');
    px(x + 4, y + 8, 4, 1, '#1a232a'); px(x + 4, y + 9, 4, 1, shade('#1a232a', 0.26));
    px(x + 5, y + 8, 2, 1, blink(900, ph + x) ? ACC.data : shade(ACC.data, -0.55));   // emitter eye (kept)
    bloom(x + 4, y + 8, 4, 2, ACC.data, 0.16);                       // light pooling on the deck plating
    const bob = Math.round(Math.sin(now / 900 + ph + x) * 2);
    const sway = Math.round(Math.sin(now / 700 + ph + x + 1.3));
    const by = y - 2 + bob;
    for (let i = 0; i < 4; i++) {                                    // the projection CONE, widening upward
      ctx.globalAlpha = 0.11 - i * 0.022;
      px(x + 4 - i, y + 6 - i * 2, 2 + i * 2, 2, ACC.data);
    }
    ctx.globalAlpha = 1;
    // BELL: one bold dome is the whole silhouette — tentacles are texture, the bell is the read
    px(x + 4, by - 3, 4, 1, '#2c8ca8');
    px(x + 3, by - 2, 6, 2, '#3fb6d9');
    px(x + 4, by - 2, 2, 1, '#bfeaff');                              // bell highlight, west
    rimEdge(x + 8, by - 2, 1, 2, 0.24);
    px(x + 3, by, 6, 1, '#2c8ca8');                                  // bell rim
    px(x + 5, by - 1, 2, 1, blink(700, ph + x) ? '#ffc4ee' : '#ff6ad5');   // pulsing core (kept)
    bloom(x + 3, by - 3, 6, 4, ACC.data, 0.17);
    for (let i = 0; i < 4; i++) {                                    // four trailing tentacles, lagging drift
      const tx = x + 3 + i * 2 + ((i % 2) ? sway : 0);
      px(tx, by + 1, 1, 2 + (i % 2), '#2c8ca8');
      px(tx, by + 3 + (i % 2), 1, 1, '#1c5a70');
    }
    if (blink(180, ph + x)) px(x + 3 + ((now >> 6) % 6), by, 1, 1, '#0e2a36');   // hologram dropout scanline
  };

  F.plasmaglobe = (x, y, w, h, f) => {   // v5 TABLE globe — plasma orb on a weighted base, mount:'surface'
    const r = RAMP.steel, ph = (f && f.x) || 0;
    // v4 was a wall sconce: cradle ring, stub arm, bulkhead plate, and deliberately no deck contact. That
    // is a fine object but it hung in mid-air wherever it was placed, because nothing checked for a wall
    // behind it — the same mid-air failure the hanging monstera had. It is a TABLE object now, which is
    // what it always wanted to be, so the bracket becomes a real weighted base and the paint runs all the
    // way to the footprint bottom (mount:'surface' seats a prop by its own contact line — see draw()).
    px(x + 3, y + 9, 6, 3, LINE);                                    // base disc, sitting ON the surface
    px(x + 4, y + 10, 4, 1, r.top); keyEdge(x + 4, y + 10, 3, 1, 0.24);
    px(x + 4, y + 11, 4, 1, shade(r.face, -0.34));
    rimEdge(x + 7, y + 10, 1, 2, 0.18);
    px(x + 5, y + 6, 2, 4, LINE); px(x + 5, y + 7, 1, 3, r.lit); px(x + 6, y + 7, 1, 3, r.dk);   // stem
    px(x + 3, y + 5, 6, 2, LINE); px(x + 4, y + 5, 4, 1, r.top); keyEdge(x + 4, y + 5, 3, 1, 0.22);
    px(x + 4, y + 6, 4, 1, shade(r.face, -0.34));                  // cradle ring the sphere seats into
    // the sphere seats DOWN into the cradle now (it used to float two rows clear of the old stub arm)
    const cxp = x + 5.5, cyp = y - 0.5;
    for (let q = y - 6; q <= y + 5; q++) for (let p = x + 1; p <= x + 10; p++) {
      const dx = p + 0.5 - cxp, dy = q + 0.5 - cyp, d = Math.sqrt(dx * dx + dy * dy);
      if (d > 4.9) continue;
      px(p, q, 1, 1, d > 4.2 ? LINE : d > 3.6 ? '#1e1830' : '#140f1e');   // glass shell over a dark interior
    }
    px(x + 2, y - 2, 1, 3, '#3d3059'); px(x + 3, y - 4, 1, 1, '#4b3c69');   // NW glint on the glass
    rimEdge(x + 8, y, 1, 4, 0.22);                                   // cool sky bounce on the shade side
    px(x + 5, y - 1, 2, 2, '#b47aff'); px(x + 5, y - 1, 1, 1, '#f2e6ff');   // electrode core
    const a1 = Math.floor((now / 130) + ph + x) % 4, a2 = Math.floor((now / 190) + (ph + x) * 3) % 4;
    const TIP = [[x + 2, y - 2], [x + 9, y - 1], [x + 3, y + 2], [x + 8, y + 3]];
    for (const pair of [[a1, 1], [a2, 0]]) {                         // two arcs re-rooting on their own clocks
      const t = TIP[pair[0]], mx = (t[0] + x + 5) >> 1, my = (t[1] + y - 1) >> 1;
      px(mx, my, 1, 1, pair[1] ? '#b47aff' : '#8a4ae0');
      px(t[0], t[1], 1, 1, '#f2e6ff');                               // hot tip kissing the glass
    }
    bloom(x + 3, y - 3, 6, 7, '#8a4ae0', 0.15 + 0.07 * (flick(300, ph + x) * 0.5 + 0.5));
    spill(x + 4, y + 6, 4, '#8a4ae0', 0.16, 3);                      // violet pooling down the stem and base
  };


  F.gachapon = (x, y, w, h, f) => {   // v4 capsule machine (BLOCKS) — steel cabinet, DOME of bright capsules
    const r = RAMP.steel, ph = (f && f.x) || 0;
    const CAPS = ['#ff6ad5', '#41ff8a', '#ffd34a', '#4ad9ff', '#b47aff', '#ff8a4a'];
    shadow2(x + 2, y + 11, 8);                                       // real floor contact — this one BLOCKS
    // cabinet stays on the shared ramp: the law puts identity in the accents, so the CAPSULES carry the
    // carnival, not the casing. One red trim band is all the fairground this needs.
    chamf(x + 1, y + 2, 10, 10, LINE, 2);
    chamf(x + 2, y + 3, 8, 8, r.face, 1);
    px(x + 2, y + 3, 8, 1, r.top); keyEdge(x + 2, y + 3, 5, 1, 0.26);
    px(x + 2, y + 4, 1, 6, r.lit); px(x + 9, y + 4, 1, 6, r.dk); rimEdge(x + 9, y + 4, 1, 6, 0.22);
    px(x + 2, y + 5, 8, 1, '#a03448');                               // one carnival trim band, all it needs
    px(x + 2, y + 6, 8, 1, shade('#a03448', -0.45));
    px(x + 2, y + 10, 8, 1, r.ao);
    px(x + 3, y + 7, 1, 2, '#0c1013'); px(x + 3, y + 7, 1, 1, r.sheen);      // coin slot
    px(x + 7, y + 7, 2, 2, '#caa84a'); px(x + 7, y + 7, 1, 1, '#e8d070');    // brass crank
    px(x + 4, y + 8, 3, 2, '#0a0e11'); px(x + 4, y + 8, 3, 1, shade(r.face, 0.18));   // prize flap
    // GLASS DOME — a real dome, not a box lid; the round crown over a square cabinet IS the silhouette
    for (let j = 0; j < 8; j++) {
      const hw = j < 1 ? 2 : j < 2 ? 3 : 4;
      px(x + 5 - hw, y - 5 + j, hw * 2 + 1, 1, j === 0 ? LINE : '#101a1c');
      px(x + 4 - hw, y - 5 + j, 1, 1, LINE); px(x + 6 + hw, y - 5 + j, 1, 1, LINE);
    }
    px(x + 3, y - 4, 1, 4, '#33474f');                               // dome glint, west
    rimEdge(x + 8, y - 2, 1, 4, 0.20);                               // cool sky down the east of the glass
    for (let i = 0; i < 9; i++) {                                    // the capsules ARE the colour identity
      const hx = U.hash('cap' + i + ph + x);
      px(x + 2 + (hx % 7), y - 3 + ((hx >> 4) % 5), 1, 1, CAPS[i % CAPS.length]);
    }
    bloom(x + 3, y - 3, 6, 5, ACC.flow, 0.07 + (blink(1000, ph + x) ? 0.06 : 0));   // marquee twinkle, falls off
    px(x + 1, y + 2, 10, 1, r.top); px(x + 2, y + 2, 8, 1, r.sheen); // dome collar / cabinet crown
    keyEdge(x + 2, y + 2, 5, 1, 0.24);
    const t = ((now / 3400) + (ph + x) * 0.7) % 1;                   // a capsule drops the chute (kept behaviour)
    if (t < 0.22) {
      const cy = Math.min(y - 1 + Math.floor(t * 40), y + 8);
      px(x + 5, cy, 1, 1, CAPS[Math.floor(ph + x + now / 3400) % CAPS.length]);
    }
  };




  /* ---- DECOR EXPANSION wave 3 (2026-07-15): greenery + lounge ---- */


  F.monstera = (x, y, w, h, f) => {   // v5 FLOOR planter — three split paddle leaves standing over a heavy pot
    const ph = (f && f.x) || 0;
    const nod = blink(2000, ph + x) ? 1 : 0;                          // air handling moving the crown leaf
    // v4 hung this from the overhead: basket in the top half, leaf skirt filling the bottom, cords reaching
    // north into nothing. Two things killed it. The cords terminated MID-AIR — this projection draws no
    // ceiling, so there was never anything up there to hang off — and the reading order came out inverted
    // (container above, foliage below), which at 12px is a box with a green beard, not a plant. It stands on
    // the deck now, which is also simply what a monstera is. It still owns a silhouette none of the other
    // greenery has: tallplant is a column of blades, bonsai is flat stacked pads, plant is thin sprigs —
    // this one is BIG PADDLES, and the fenestration slits are what name the species at any size.
    const LF_DK = '#1c4a2a', LF = '#2e7a3e', LF_LIT = '#4aa45a', LF_HI = '#6cc97c', SLIT = '#12301e';
    ctx.globalAlpha = 0.20; px(x + 1, y + 11, 10, 1, '#000'); ctx.globalAlpha = 1;   // contact shadow
    // POT — tapered, so the pot reads as a vessel and not as a crate
    chamf(x + 2, y + 6, 8, 6, LINE, 1);
    for (let j = 0; j < 4; j++) px(x + 3 + (j >> 1), y + 7 + j, 6 - (j >> 1) * 2, 1, '#5e4a34');
    px(x + 3, y + 7, 6, 1, '#7a6044'); keyEdge(x + 3, y + 7, 3, 1, 0.22);
    px(x + 3, y + 7, 1, 3, '#6d5540'); px(x + 8, y + 7, 1, 3, '#3a2c1c'); rimEdge(x + 8, y + 7, 1, 3, 0.20);
    px(x + 2, y + 6, 8, 1, '#3a2c1c'); px(x + 3, y + 6, 6, 1, '#241d14');    // rim, then soil inside it
    px(x + 4, y + 10, 4, 1, '#2a2016');
    // STEMS — two petioles leaning apart out of the soil; a monstera never grows straight up in one line
    px(x + 5, y + 3, 1, 3, LF_DK); px(x + 6, y + 2, 1, 4, LF_DK);
    px(x + 4, y + 5, 1, 1, LF_DK); px(x + 7, y + 5, 1, 1, LF_DK);
    // THREE PADDLES, each cut by a fenestration slit — west, east, then the crown standing above both
    // The three are drawn back-to-front and each is separated by a hard dark edge — without that they merge
    // into one green mass and the prop reads as a hedge, which is the same fusing failure the poker board had.
    px(x, y + 2, 5, 4, LF); px(x, y + 2, 5, 1, LF_LIT); keyEdge(x, y + 2, 3, 1, 0.24);
    px(x + 2, y + 3, 1, 2, SLIT); px(x, y + 5, 4, 1, LF_DK); px(x + 4, y + 3, 1, 3, SLIT);
    px(x + 7, y + 3, 5, 4, LF_DK); px(x + 7, y + 3, 5, 1, LF); px(x + 6, y + 3, 1, 4, SLIT);
    px(x + 9, y + 4, 1, 2, SLIT); px(x + 11, y + 3, 1, 3, LF_DK); rimEdge(x + 11, y + 3, 1, 3, 0.18);
    chamf(x + 2, y - 1 + nod, 8, 4, LF_LIT, 1);                             // the CROWN paddle, leaf-shaped
    px(x + 3, y - 1 + nod, 6, 1, LF_HI); keyEdge(x + 3, y - 1 + nod, 3, 1, 0.20);
    px(x + 4, y + nod, 1, 2, SLIT); px(x + 7, y + nod, 1, 2, SLIT);         // the crown's two slits
    px(x + 3, y + 2 + nod, 6, 1, SLIT);                                     // its shadow, cast onto the two below
  };


  F.fishtank = (x, y, w, h, f) => {
    /* v6 LOUNGE AQUARIUM (2x1) — the angle, made sane.
       v4 was a pure FRONT ELEVATION: no top plane anywhere, the picture you get crouching in front
       of a tank. v5 over-corrected into an almost pure PLAN — ten rows of surface over a three-row
       sliver of glass — and Andrew's read was that it looked weird and made no sense. He is right:
       ⛔⛔⛔ A PLAN VIEW OF A TANK IS A PUDDLE. A glass box at this station's 3/4 camera shows BOTH
       of its faces, and the tank's whole subject lives in the TALLER one:
         · a FORESHORTENED SURFACE PLANE across the top — that is the 3/4, and it is exactly what v4
           had none of: you look DOWN onto the water and onto the hood;
         · the WATER COLUMN through the near glass beneath it — gravel on the floor, plants rooted in
           it, a castle standing on it, fish in SIDE view. That is the picture anyone recognises as
           an aquarium, and it is honest here because the near wall is glass.
       ⛔ THE TWO FACES ARE ONE BODY OF WATER. No steel rail between them; one authored blue ramp
          runs from the far edge of the surface down to the gravel, and the WATERLINE is the only
          marker — a real feature of a tank rather than a seam across the middle of the prop.
       ⛔ AUTHOR THE BLUES, never shade() a mid tone upward: shade() desaturates as it lightens, so
          the lit top of the tank comes out grey and reads as a tank missing its water.
       ⛔ THE HOOD IS ONE ROW. Stacked hardware over the glass reads as a half-empty tank.
       ⛔ GRAVEL BELONGS AT THE BOTTOM — in plan there is no bottom to put it at, which is another
          reason the column has to be the face that carries the content. */
    const EDGE = '#161d22';
    const r = RAMP.steel, ph = (f && f.x) || 0, cold = '#7ad9ff';
    const tt = y - 11;
    const SURF = tt + 2, SURFH = 4;            // the surface plane — the 3/4 half
    const WL = tt + 6;                         // the waterline, its near edge
    const COL = tt + 7, COLH = 8;              // the column through the near glass
    const BED = tt + 12;                       // gravel, 3 rows, on the floor of the tank
    const BOT = tt + 15;                       // the tank's base frame
    const mixc = (c1, c2, t) => {
      t = Math.min(1, Math.max(0, t));
      let o = '#';
      for (let i = 0; i < 3; i++) o += Math.round(c1[i] + (c2[i] - c1[i]) * t).toString(16).padStart(2, '0');
      return o;
    };
    const WFAR = [0x74, 0xd8, 0xea], WNEAR = [0x3a, 0xa4, 0xc2], WDEEP = [0x0e, 0x2e, 0x42];
    const WHT = [0xff, 0xff, 0xff];

    shadow2(x + 2, y + h - 1, w - 4);
    // freestanding cabinet stand — lounge tier, so stub feet on the deck, nothing bolted
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 10, 3, 2, EDGE); px(lx, y + 10, 1, 2, r.lit); px(lx + 1, y + 10, 1, 2, r.dk);
      rimEdge(lx + 2, y + 10, 1, 2, 0.16);
    }
    underAO(x + 5, y + 10, w - 10, 1);
    chamf(x + 1, y + 5, w - 2, 6, EDGE, 1);
    // ⛔ the stand stays UNDER the tank in value, or the prop reads as two stacked boxes
    px(x + 2, y + 5, w - 4, 2, shade(r.face, -0.26));        // cabinet TOP plane, proud of the tank
    px(x + 2, y + 5, 1, 2, shade(r.face, 0.04)); keyEdge(x + 2, y + 5, 1, 2, 0.14);
    px(x + w - 3, y + 5, 1, 2, r.ao);
    px(x + 2, y + 7, w - 4, 3, shade(r.face, -0.40));        // and its short front face
    px(x + 2, y + 7, w - 4, 1, shade(r.face, -0.24));
    px(x + 2, y + 7, 1, 3, shade(r.face, -0.30)); px(x + w - 3, y + 7, 1, 3, r.ao);
    rimEdge(x + w - 3, y + 7, 1, 3, 0.20);
    px(x + (w >> 1) - 1, y + 7, 1, 3, '#141a1e');              // cabinet door seam
    px(x + (w >> 1) + 1, y + 8, 2, 1, shade(r.face, 0.26));  // door pull
    px(x + 2, y + 9, w - 4, 1, r.ao);

    chamf(x - 1, tt - 1, w + 2, 18, EDGE, 1);                  // THE GLASS BOX

    /* ================= THE SURFACE PLANE — what the 3/4 camera adds ================= */
    for (let j = 0; j < SURFH; j++) px(x + 1, SURF + j, w - 2, 1, mixc(WFAR, WNEAR, j / SURFH));
    px(x + 1, SURF, 1, SURFH, mixc(WFAR, WHT, 0.20));          // WEST RAIL — this plane is HORIZONTAL
    // CAUSTICS: a per-column shimmer ON the surface, two beat frequencies so it never reads as a loop
    for (let i = 0; i < w - 2; i++) {
      const sc = Math.sin(now / 620 + i * 0.55 + ph) + 0.7 * Math.sin(now / 410 + i * 0.31);
      const d = Math.max(0, Math.round(sc));
      if (d) { ctx.globalAlpha = 0.40; px(x + 1 + i, SURF, 1, d, '#c8f2fb'); ctx.globalAlpha = 1; }
    }
    px(x + 1, WL, w - 2, 1, mixc(WFAR, WHT, 0.34));            // THE WATERLINE, wet and bright

    /* ================= THE COLUMN, through the near glass ================= */
    for (let j = 0; j < COLH; j++) px(x + 1, COL + j, w - 2, 1, mixc(WNEAR, WDEEP, j / (COLH - 1)));
    // the gravel bed, on the FLOOR of the tank, which is where gravel goes
    px(x + 1, BED, w - 2, 3, '#3a3327');
    px(x + 1, BED, w - 2, 1, '#4d4433');
    px(x + 4, BED, 5, 1, '#5b5039'); px(x + w - 10, BED + 1, 5, 1, '#2c2720');
    for (let i = 0; i < w - 5; i += 3)                         // its crest, broken so it is not a ruled line
      px(x + 2 + i, BED - 1, 2, 1, U.hash('grv' + i) % 2 ? '#3f3829' : '#332e23');
    // planting, rooted in the bed and swaying on the tube's clock
    for (let j = 0; j < 5; j++) {
      const hgt = 3 + (j % 3), gx0 = x + 3 + j * 2;
      for (let k = 0; k < hgt; k++) {
        const sw = Math.round(Math.sin(now / 1100 + j * 0.7 + k * 0.5 + ph) * 1.2);
        px(gx0 + sw, BED - 1 - k, 1, 1, k === hgt - 1 ? '#4fa85f' : (j & 1 ? '#2c7c4a' : '#1d6038'));
      }
    }
    // the castle every crew aquarium is legally required to contain — standing on the bed, front on
    const cx0 = x + w - 9;
    px(cx0, BED - 4, 6, 4, '#5c6a76');
    px(cx0, BED - 4, 6, 1, '#8e9ea9'); px(cx0, BED - 4, 1, 4, '#74838f');
    px(cx0 + 1, BED - 6, 2, 2, '#697783'); px(cx0 + 1, BED - 6, 2, 1, '#9dadb8');    // west turret
    px(cx0 + 4, BED - 6, 2, 2, '#4f5c67'); px(cx0 + 4, BED - 6, 2, 1, '#7c8b96');    // east turret
    px(cx0 + 2, BED - 3, 2, 3, '#1d2a33'); px(cx0 + 2, BED - 3, 2, 1, '#2b3a45');    // the arched gate
    /* FISH, in SIDE view — which is what a fish looks like through glass, and the reason the column
       is the face that carries them. ⛔ Two coloured pixels is a pellet: the read is the taper plus
       a DORSAL fin, an eye, and a caudal that beats on its own fast clock. */
    for (const spec of [[0.0, 2600, '#ffd34a', 4, 1], [3.0, 3400, '#ff7c52', 3, 4], [1.4, 4200, '#e6eef2', 3, 2]]) {
      const t = ((now / spec[1]) + spec[0] + ph) % 2, east = t < 1;
      const c = spec[2], L = spec[3], d = east ? 1 : -1;
      const nx = x + 3 + Math.round((east ? t : 2 - t) * (w - 9));
      const fy = COL + spec[4] + Math.round(1.2 * Math.sin(now / 1900 + spec[0] + ph));
      const back = shade(c, 0.20), belly = shade(c, -0.42), fin = shade(c, -0.16);
      for (let i = 0; i <= L - 1; i++) {                       // body: a lit back over a shaded belly
        px(nx - d * i, fy, 1, 1, back);
        px(nx - d * i, fy + 1, 1, 1, belly);
      }
      px(nx - d * L, fy, 1, 2, fin);                           // the peduncle
      px(nx - d * (L + 1), fy - 1 + (((now / 170 + spec[0]) % 2 < 1) ? 0 : 1), 1, 3, fin);   // caudal, beating
      px(nx - d, fy - 1, 1, 1, fin);                           // dorsal fin
      px(nx, fy, 1, 1, '#12181c');                             // the eye
    }
    // the bubbler off the castle, rising the whole column and popping at the surface
    for (let b = 0; b < 4; b++) {
      const bt = (now / 190 + b * 2.9) % (COLH + 3);
      const by = BED - 4 - Math.floor(bt);
      if (by >= SURF) px(cx0 + 1 + (Math.floor(bt) & 1), by, 1, 1, '#bfeeff');
    }
    // GLASS: a west glint down the column, a cool east rim, and one specular wedge
    px(x + 1, COL, 1, COLH, mixc(WNEAR, WHT, 0.16));
    px(x + w - 2, COL, 1, COLH, mixc(WDEEP, [0, 0, 0], 0.25));
    rimEdge(x + w - 2, COL, 1, COLH, 0.18);
    for (let j = 0; j < 6; j++) {
      ctx.globalAlpha = 0.15 - j * 0.021;
      px(x + 2 + j, COL + j, 5 - (j >> 1), 1, '#dff4ff');
      ctx.globalAlpha = 1;
    }
    px(x + 1, BOT, w - 2, 1, shade(r.face, -0.34));          // the tank's base frame on the cabinet

    /* ================= HOOD: ONE row on the north rim, and the one cold tube ================= */
    chamf(x - 1, tt - 1, w + 2, 3, EDGE, 1);
    px(x, tt, w, 1, r.top);                                    // the hood, near edge-on from up here
    px(x + 1, tt, 1, 1, shade(r.face, 0.20));                // WEST RAIL
    px(x + w - 2, tt, 1, 1, r.dk); rimEdge(x + w - 2, tt, 1, 1, 0.20);
    px(x + 2, tt + 1, w - 4, 1, '#d6f2ff');                    // the tube, right on the tank's rim
    bloom(x + 2, tt + 1, w - 4, 1, cold, 0.16);                // ⛔ a fat bloom bleaches the water below
    spill(x + 3, y + 5, w - 6, cold, 0.09, 2);                 // light pooling out onto the cabinet top
    glow(x + 3, y + 10, w - 6, 2, cold, 0.07 + 0.03 * Math.sin(now / 900 + ph));  // faint cold wash on the deck
  };

  F.pokertable = (x, y, w, h) => {
    /* ⛔ EDGES SOFTENED, NOTHING ELSE — shipped geometry, shading and colour untouched. The
       universal near-black contour becomes a dark tint so the prop stops reading as a sticker
       cut out and laid on the deck. Same EDGE the couch uses, so the lounge reads as one room. */
    const EDGE = '#161d22';
    // v5 POKER (4x2) — TOP-BIAS OBLIQUE. It stays the deliberate OPPOSITE of F.quarters_pooltable on the
    // four axes v4 locked (oval vs rectangle · one pedestal vs four legs · studded black leather vs
    // mahogany-and-diamonds · indigo under low ambient vs green under tungsten), but the art is rebuilt,
    // because v4 lost the read completely — in-game it scanned as a monitor on a mic stand. Four causes:
    //   1. The rail roll was EIGHT px deep on a 48px table, so felt — the one thing that says "card
    //      table" — survived only as a slot. The roll is now a 4px PERPENDICULAR offset off a true
    //      RACETRACK capsule (semicircular ends, straight sides), which is the plan shape of a real
    //      poker table, and felt owns the top surface again.
    //   2. The pedestal was drawn with shade(rail, +0.46). Lightening a NEAR-BLACK desaturates it
    //      toward grey, so the base rendered as brushed steel under a black oval. Dark materials need
    //      AUTHORED lit tones (LEA_MID/LEA_LIT below) — never a large positive shade().
    //   3. Five near-white board cards, two seat stacks, a five-colour chip tray and four pot stacks all
    //      landed inside the middle 20px and fused into one pale block. There are now exactly TWO bright
    //      clusters (board, pot); the seats are gone and everything else is held under the felt's value.
    //   4. There was no front face at all, so the oval floated. A short APRON now carries the table's
    //      edge thickness down to the pedestal, per the top-bias oblique law.
    // NEW: the betting line. A 1px cream racetrack ring printed on the felt is the cheapest unmistakable
    // "poker" signifier there is and it costs no brightness — and it lets the composition be honest, with
    // community cards INSIDE the line and the rail outside it, which is where they actually belong.
    // STATIC by law: nothing here has a mechanism (no dealer, no motor, no emitter), so v4's river-flip
    // clock, its blinking mid-toss chip and its pulsing "ambient" are gone — a lit room does not throb.
    // v6 felt values. v5's #1b2c55 bed was HALF the pool table's felt luminance, and the lightmap
    // multiplies props down ~35% — in-situ the bed went near-black inside a near-black rail and the
    // whole top read as a SCREEN (only the bone cards survived). Indigo stays the identity axis, but
    // it now sits at the pool green's value (#2f5d3a ≈ lum 76 → #2e4a8e ≈ lum 78): same room, same
    // lamps, both felts read as lit cloth.
    const LEA_DK = '#120d10', LEA = '#1e1519', LEA_MID = '#2b2025', LEA_LIT = '#3a2b31';
    const feltDk = '#1b2d5e', felt = '#2e4a8e', feltLit = '#3f5fae';
    const RH = 18, rtop = y - 4, R = (RH - 1) / 2;
    // Racetrack capsule: horizontal inset of the outline lying `o` px (perpendicular) inside the rail's
    // outer edge. Returns null on rows the shape does not reach, which is what lets the ring/band helper
    // below know it is on a flat cap row.
    // The +0.5 on the radius inside the root is not slop: with a true semicircular end the extreme row
    // sits exactly on the pole, so its inset jumps 9px in one row and the outline breaks into a black
    // staircase notch. Half a pixel of extra radius flattens the cap to a 6,4,2,1,1,0 ramp — the same
    // oval, drawn as pixel art rather than as sampled geometry.
    const cap = (o) => {
      const rr = R - o;
      return (j) => {
        const dy = j - R;
        if (Math.abs(dy) > rr) return null;
        return o + Math.round(rr - Math.sqrt(Math.max(0, (rr + 0.5) * (rr + 0.5) - dy * dy)));
      };
    };
    // paint the band between two capsule offsets: the west run, the mirrored east run, or — on a row the
    // inner capsule cannot reach — the full span, which is what closes the top and bottom of a ring.
    // A colour may be a function of the row, which is how the roll takes the key on its north crown and
    // stays in shadow on the south one under a single high light.
    const band = (o0, o1, cWest, cEast) => {
      const a = cap(o0), b = cap(o1);
      const cw = typeof cWest === 'function' ? cWest : () => cWest;
      const ce = cEast == null ? cw : (typeof cEast === 'function' ? cEast : () => cEast);
      for (let j = 0; j < RH; j++) {
        const i0 = a(j); if (i0 == null) continue;
        const i1 = b(j);
        if (i1 == null) { px(x + i0, rtop + j, w - i0 * 2, 1, cw(j)); continue; }
        const t = Math.max(1, i1 - i0);
        px(x + i0, rtop + j, t, 1, cw(j));
        px(x + w - i1, rtop + j, t, 1, ce(j));
      }
    };
    const north = (j) => j < R;                              // which half of the roll the light reaches
    // roll thinned 4 -> 3 in v6: with the outline + shadow ring the old roll cost ~6px of dark border
    // all round, and a bright plane inside a thick dark ring is the anatomy of a SCREEN IN A BEZEL.
    const outer = cap(0), inner = cap(3);
    const pcx = x + (w >> 1);
    shadow2(pcx - 15, y + h - 1, 30);
    // BASE — v6. v5's stack (narrow turned column + splayed cross foot) was the second half of the
    // monitor misread: a slim column under a wide dark oval is a MIC STAND, whatever sits on it.
    // "One pedestal, never four legs" is the locked axis against the pool table — so the pedestal is
    // now a broad upholstered DRUM nearly as wide as the bed, the base a real casino table stands on.
    // Drawn first so the apron and rail overhang it.
    chamf(pcx - 14, y + 17, 28, 7, EDGE, 2);                   // drum plinth
    chamf(pcx - 13, y + 18, 26, 5, LEA_MID, 2);
    px(pcx - 12, y + 18, 24, 1, LEA_LIT); keyEdge(pcx - 12, y + 18, 9, 1, 0.18);
    px(pcx - 13, y + 19, 1, 3, LEA); px(pcx + 12, y + 19, 1, 3, LEA_DK);
    rimEdge(pcx + 12, y + 19, 1, 3, 0.18);
    for (let i = 0; i < 4; i++) px(pcx - 9 + i * 6, y + 20, 1, 2, LEA_DK);   // upholstery fluting
    px(pcx - 12, y + 22, 24, 1, '#0a0d10');                    // toe kick, reads as weight on the deck
    underAO(pcx - 12, y + 16, 24, 2);
    // CURVED SKIRT — v6, replacing v5's narrow rectangular apron. The apron only ran under the bed's
    // middle 20px, so the oval's east/west lobes HOVERED over open floor — half the monitor misread.
    // The skirt is the capsule's own outline dropped 5px: the table's edge thickness follows the oval
    // the whole way round, exactly what topFace+frontFace does for a rectangle.
    for (let j = 0; j <= RH; j++) {
      const i = outer(Math.max(0, Math.min(RH - 1, j)));
      px(x + i - 1, rtop + j + 5, w - i * 2 + 2, 1, EDGE);
    }
    for (let j = (RH >> 1); j < RH; j++) {                     // only the south half shows under the rail
      const i = outer(j);
      px(x + i, rtop + j + 4, w - i * 2, 1, LEA_DK);
      px(x + i + 2, rtop + j + 4, 6, 1, LEA);                  // lit west quarter of the skirt
    }
    // PADDED OVAL RAIL — silhouette halo, base roll, then the roll modelled as three concentric bands:
    // outer wall, lit crown, inner slope falling to the felt.
    for (let j = -1; j <= RH; j++) {
      const i = outer(Math.max(0, Math.min(RH - 1, j)));
      px(x + i - 1, rtop + j, w - i * 2 + 2, 1, EDGE);
    }
    band(0, 3, LEA);                                           // the roll's body
    band(0, 1, (j) => north(j) ? LEA_MID : LEA_DK, LEA_DK);    // outer wall
    band(1, 2, (j) => north(j) ? LEA_LIT : LEA_MID,            // the crown of the padding — 1px, and the
              (j) => north(j) ? LEA_MID : LEA);                // south crown never takes the full key
    band(2, 3, LEA_DK);                                        // inner slope, dropping into the bed
    keyEdge(x + 12, rtop + 1, 14, 1, 0.16);                    // the key lands on the north-west crown
    for (let i = 0; i < 6; i++) {                              // brass upholstery studs — the leather's tell
      px(x + 11 + i * 5, rtop + 1, 1, 1, '#6e5830');
      px(x + 11 + i * 5, rtop + RH - 2, 1, 1, '#3f331d');
    }
    // FELT BED — an inner capsule, ringed by the rail's shadow and lit from the north-west
    for (let j = 0; j < RH; j++) {
      const i = inner(j); if (i == null) continue;
      px(x + i - 1, rtop + j, w - i * 2 + 2, 1, feltDk);       // rail shadow ringing the bed
      px(x + i, rtop + j, w - i * 2, 1, felt);
      const lw = Math.round((w - i * 2) * (0.86 - (j - 4) / 6));  // NW nap, falling off to the south-east
      if (lw > 0) {
        px(x + i, rtop + j, lw, 1, feltLit);
        // dither the nap's trailing edge: a hard diagonal boundary on 10 rows of cloth reads as GLARE
        // on glass; two checker px per row break it into brushed nap
        if (lw + 1 < w - i * 2) px(x + i + lw + (j & 1), rtop + j, 1, 1, feltLit);
        if (lw > 2) px(x + i + lw - 2 + ((j + 1) & 1), rtop + j, 1, 1, felt);
      }
      if (j >= 11) px(x + i, rtop + j, w - i * 2, 1, shade(felt, -0.20));   // bed darkens into the near rail
    }
    // NO betting line. It was tried and cut: the felt is ten rows deep, so an inner ring degenerates into
    // two long horizontal bars across the bed that out-shout the cards — and the racetrack read is already
    // carried, completely, by the rail's own silhouette.
    // THE BOARD — five community cards, inside the betting line where they belong. Two rules earn the
    // read at 48px. (1) Cards are BONE, never white — v4's #f0ece0 blew the felt out of the composition.
    // (2) NO per-card outline: at a 4px pitch the LINE boxes butt together into one continuous black
    // strip and the board turns into a filmstrip. The dark felt is already the separator; each card gets
    // only its own drop shadow, and the gap between them stays felt.
    const cy = y + 2;
    for (let i = 0; i < 5; i++) {
      const cxp = x + 14 + i * 4;
      px(cxp, cy + 1, 3, 4, feltDk);                           // the card's shadow, cast south-east
      px(cxp, cy, 2, 4, '#9c9583');
      px(cxp, cy, 2, 1, '#b2ab98');
      // one pip each, alternating suit colour and riding a different row per card — five identical faces
      // in a row read as piano keys, and the variation costs nothing
      px(cxp, cy + 1 + (i % 3 ? 1 : 0), 1, 1, i % 2 ? '#8e3040' : '#1a1e22');
    }
    // THE POT — three chip stacks east of the board: the second bright cluster, and the only warm one
    for (let s = 0; s < 3; s++) {
      const pxx = x + 35 + s * 3, hgt = [3, 4, 2][s], base = y + 6;
      const c = s === 1 ? '#8e4433' : '#a08a4e';
      px(pxx, base - hgt + 1, 3, hgt, feltDk);
      px(pxx, base - hgt, 2, hgt, shade(c, -0.16));
      px(pxx, base - hgt, 2, 1, shade(c, 0.26));
      px(pxx, base - 1, 2, 1, shade(c, -0.40));
    }
    px(x + 10, y + 5, 3, 2, feltDk);
    px(x + 10, y + 4, 2, 1, '#b0a996'); px(x + 10, y + 5, 2, 1, '#7d7768');   // dealer button, west of the board
    // LIGHT: no pendant here on purpose (that silhouette belongs to the pool table). What lands on the
    // felt is the room's own low warm ambient — steady, because the room's lamps are steady.
    glow(x + 10, y + 1, w - 20, 7, '#ffb84d', 0.05);
    spill(x + 12, rtop + RH, w - 24, KEY, 0.09, 3);            // room light catching under the rail's overhang
  };

  F.commswall = (x, y, w, h, f) => {
    // COMMS WALL (6x1, blocks:FALSE) — v4 REBUILD. The CATALOG says agents walk in FRONT of this, so the old
    // freestanding rack-row on stub feet was simply wrong: it is now a SHALLOW bulkhead unit hung off lugs,
    // casting onto the wall, never touching the deck. 72px is far too long for one motif stamped ten times,
    // so the span carries three DIFFERENT stations west->east — a patch bay where channels land, the QUEUE
    // glass in the middle (the hero, by area not brightness), and a channel stack that dispatches. One packet
    // crosses the whole run on the conduit rail; that is what makes it read as ONE bus instead of three props.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const bt = y - 10, bh = 19;                                   // hangs y-10..y+8 — 3px of air under it
    ctx.globalAlpha = 0.20; px(x + 2, bt + 3, w, bh, '#000'); ctx.globalAlpha = 1;   // cast on the bulkhead
    for (const lx of [x + 6, x + 34, x + w - 9]) {                // wall lugs — no legs, nothing meets the floor
      px(lx, bt - 3, 2, 4, LINE); px(lx, bt - 3, 2, 1, shade(r.top, 0.20));
      rimEdge(lx + 1, bt - 2, 1, 3, 0.18);
    }
    chamf(x - 1, bt - 1, w + 2, bh + 2, LINE, 2);
    chamf(x, bt, w, bh, r.face, 2);
    px(x + 2, bt, w - 4, 1, r.top); keyEdge(x + 2, bt, 16, 1, 0.28);   // warm ceiling strip along the crown
    px(x, bt + 2, 1, bh - 4, r.lit); px(x + w - 1, bt + 2, 1, bh - 4, r.dk);
    rimEdge(x + w - 1, bt + 2, 1, bh - 4, 0.22);                  // cool sky bounce down the shade side
    px(x + 2, bt + bh - 2, w - 4, 1, shade(r.face, -0.26));
    px(x + 2, bt + bh - 1, w - 4, 1, r.ao);                       // shallow underside, NOT a floor line
    // CONDUIT RAIL — the only element that crosses all three stations
    px(x + 2, bt + 2, w - 4, 2, '#0e1a17');
    px(x + 2, bt + 2, w - 4, 1, shade(r.face, -0.42));
    for (let i = 0; i < 4; i++) {                                 // junction boxes at the station seams
      const jx = x + 4 + i * 17;
      px(jx, bt + 1, 4, 4, LINE); px(jx + 1, bt + 2, 2, 2, shade(r.face, 0.10));
      px(jx + 1, bt + 2, 2, 1, r.lit);
    }
    const run = w - 13;
    const pkx = x + 4 + Math.round((now / (on ? 5 : 9) + ph * 20) % run);
    px(pkx, bt + 3, 5, 1, ACC.data); bloom(pkx, bt + 3, 5, 1, ACC.data, on ? 0.34 : 0.20);
    const tkx = x + 4 + Math.round((now / 12 + 90 + ph * 13) % run);
    px(tkx, bt + 3, 3, 1, shade(ACC.data, -0.34)); bloom(tkx, bt + 3, 3, 1, ACC.data, 0.12);
    // WEST — PATCH BAY: cable() sag is what sells this as wiring instead of a printed grid
    const bx0 = x + 3;
    inset(bx0, bt + 5, 18, 12, '#111a18');
    for (let rj = 0; rj < 3; rj++) for (let c = 0; c < 6; c++) {
      const jx = bx0 + 2 + c * 3, jy = bt + 7 + rj * 3;
      px(jx, jy, 2, 2, '#0a1210'); px(jx, jy, 2, 1, shade(r.face, -0.16));
      px(jx, jy + 1, 1, 1, shade(r.face, 0.06));
    }
    const cords = [[0, 0, 3, 1, ACC.work], [1, 2, 4, 0, ACC.data], [2, 1, 5, 2, ACC.flow]];
    for (let i = 0; i < 3; i++) {
      const cd = cords[i];
      cable(bx0 + 2 + cd[0] * 3, bt + 8 + cd[1] * 3, bx0 + 2 + cd[2] * 3, bt + 8 + cd[3] * 3, 2.4, shade(cd[4], -0.58));
      const liveJ = blink(900, i * 0.4);                          // the plug lights as its channel carries
      px(bx0 + 2 + cd[0] * 3, bt + 7 + cd[1] * 3, 2, 2, liveJ ? cd[4] : shade(cd[4], -0.66));
      if (liveJ) bloom(bx0 + 2 + cd[0] * 3, bt + 7 + cd[1] * 3, 2, 2, cd[4], 0.20);
    }
    // CENTRE — QUEUE GLASS. Messages march EAST and one clears off the end; idle keeps phosphor, never a hole.
    const qx = x + 23, qw = 30, qy = bt + 5, qh = 12;
    inset(qx, qy, qw, qh, '#06100f');
    px(qx + 1, qy + 1, qw - 2, qh - 2, shade(ACC.data, on ? -0.80 : -0.88));
    const off = Math.floor((now / (on ? 26 : 60)) % 6);
    for (let rj = 0; rj < 4; rj++) for (let k = -1; k < 6; k++) {
      const cxp = qx + 2 + k * 6 + off + (rj & 1);
      if (cxp < qx + 1 || cxp + 4 > qx + qw - 1) continue;
      const head = ((k + rj * 2) % 3) === 0;
      px(cxp, qy + 2 + rj * 2, 4, 1, head ? shade(ACC.data, 0.10) : shade(ACC.data, -0.46));
    }
    const disp = (now % 1800) / 1800;                             // one message clears the queue every 1.8s
    if (disp < 0.30) {
      const dx = qx + 2 + Math.round((disp / 0.30) * (qw - 8));
      px(dx, qy + 1, 5, 1, '#dbf7ff'); bloom(dx, qy + 1, 5, 1, ACC.data, 0.36 * (1 - disp / 0.30));
    }
    scanl(qx + 1, qy + 1, qw - 2, qh - 2, 0.20);
    bloom(qx + 1, qy + 1, qw - 2, qh - 2, ACC.data, on ? 0.15 : 0.07);
    spill(qx, qy + qh, qw, ACC.data, on ? 0.16 : 0.08, 3);
    // EAST — CHANNEL STACK. Names are dash plates, not text: 14px would give VT323 ~4 characters of mush.
    const chx = x + 55;
    inset(chx, bt + 5, 14, 12, '#0d1512');
    for (let i = 0; i < 4; i++) {
      const cy = bt + 7 + i * 3;
      const up = blink(700 + i * 210, i * 0.6);
      px(chx + 1, cy, 1, 1, up ? ACC.work : '#14291f');
      if (up) bloom(chx + 1, cy, 1, 1, ACC.work, 0.22);
      px(chx + 3, cy, 5, 1, shade(r.face, 0.12));               // channel name plate
      px(chx + 3, cy + 1, 4, 1, shade(r.face, -0.34));
      for (let b = 0; b < 3; b++) {                               // signal meter, jittering
        const lvl = 1 + Math.floor((1 + Math.sin(now / 240 + i * 1.7 + b)) * (on ? 0.9 : 0.45));
        px(chx + 9 + b, cy + 1 - (lvl - 1), 1, lvl, shade(ACC.data, b < 2 ? 0 : -0.3));
      }
    }
    rivets(x + 2, bt + 1, w - 4, bh - 2, shade(r.top, 0.22), r.ao);
    wear(x + 2, bt + 1, w - 4, bh - 2, 6, shade(r.face, -0.10));
  };

  F.console = (x, y, w, h, f) => {
    /* v45 OPS CONSOLE (2x1) — the instrument station. The thing that separates it from the desk is
       that its readout is BUILT IN, not stood on top: a raised instrument bank across the back of
       the slab, a recessed CRT sunk into that bank, and physical dials and toggles on the working
       surface. A desk is furniture you put a monitor ON; a console IS the instrument.
       ⛔ THE BANK NEEDS ITS OWN DARKER MATERIAL. Bank and slab on one ramp is a single pale box —
          the instrument case runs on MAT.slate so it reads as a separate casting bolted down.
       ⛔ PHYSICAL CONTROLS ARE WHAT SAY "CONSOLE": two dials, a toggle bank, a knurled grip. They
          cost four rows and they do more than any amount of screen. */
    const r = EQUIPMENT, b = INSTRUMENT, s = MAT.seat, on = !!f.work, ph = f.x || 0;
    const G = ACC.work;

    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x - 3, y + h - 3, on);
    cable(x + 1, y + 7, x - 3, y + h - 3, 2);

    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 8, 3, 4, r.ink);
      px(lx, y + 8, 1, 4, r.face); px(lx + 1, y + 8, 1, 4, r.dk);
      px(lx, y + 8, 1, 1, r.mid);
    }
    underAO(x + 6, y + 8, w - 12, 2);

    /* ---- SLAB ---- */
    workstationSurface(x, y, w);

    /* ---- THE INSTRUMENT BANK: its own casting, raised across the back ---- */
    // Raised end housings protect the inset controls and break up the flat desk profile.
    chamf(x, y - 1, 3, 6, r.ink, 1); px(x + 1, y, 1, 3, r.lit);
    chamf(x + w - 3, y - 1, 3, 6, r.ink, 1); px(x + w - 2, y, 1, 3, r.mid);
    const bX = x + 1, bW = w - 2, bT = y - 11;
    px(bX + 1, bT, bW - 2, 1, b.ink);
    px(bX, bT + 1, bW, 8, b.ink);
    px(bX + 1, bT + 1, bW - 2, 2, b.top);                          // the bank's lit crown
    px(bX + 2, bT + 1, 5, 1, b.hi);
    px(bX + 1, bT + 3, bW - 2, 1, b.face);
    px(bX + 1, bT + 4, bW - 2, 4, b.face);
    px(bX + 1, bT + 4, 1, 4, b.top); px(bX + bW - 2, bT + 4, 1, 4, b.dk);
    px(bX + 1, bT + 8, bW - 2, 1, r.ao);                           // the bank's shadow on the slab

    /* ---- recessed CRT sunk into the bank ---- */
    const sx = bX + 2, sy = bT + 4, sw = 12, sh = 4;
    px(sx - 1, sy - 1, sw + 2, sh + 2, '#050b07');
    if (on) {
      const sc = scr(ph);
      px(sx, sy, sw, sh, shade(sc, -0.68));
      px(sx, sy, sw, 1, shade(sc, 0.28));
      for (let j = 0; j < 2; j++) {
        const rw = 3 + ((j * 4 + Math.floor(now / 520)) % (sw - 5));
        px(sx + 1, sy + 1 + j, rw, 1, shade(sc, 0.12));
      }
      for (let i = 0; i < sw - 2; i++)                              // a live trace along the bottom
        px(sx + 1 + i, sy + sh - 1 - Math.round(Math.max(0, Math.sin(now / 190 + i * 0.8))), 1, 1, ACC.data);
      scanl(sx, sy, sw, sh, 0.18);
      bloom(sx, sy, sw, sh, sc, 0.16);
      spill(bX + 1, bT + 9, bW - 2, sc, 0.16, 4);
    } else {
      px(sx, sy, sw, sh, '#0a120d');
      px(sx, sy, 4, 1, '#16231b');
      px(sx + sw - 1, sy + sh - 1, 1, 1, blink(1600, ph) ? '#ff9d2e' : '#33241a');
    }
    /* ---- the bank's own readout strip, east of the glass ---- */
    for (let i = 0; i < 8; i++) {
      const v = 1 + Math.floor((1 + Math.sin(now / 260 + i * 0.9 + ph)) * (on ? 1.0 : 0.4));
      px(bX + 15 + i, bT + 7 - v, 1, v, on ? shade(G, 0.10) : shade(G, -0.62));
    }
    if (on) bloom(bX + 15, bT + 5, 8, 3, G, 0.16);

    /* ---- PHYSICAL CONTROLS on the working surface ---- */
    dial(x + 3, y, r.top, now / 900 + ph);
    dial(x + 7, y, r.top, -now / 640 + ph);
    for (let i = 0; i < 3; i++) {                                  // toggle bank, amber collars
      px(x + 12 + i * 2, y, 1, 2, b.ao);
      px(x + 12 + i * 2, y, 1, 1, blink(600, i) ? ACC.flow : '#33241a');
    }
    px(x + 18, y, 4, 2, b.ink); px(x + 18, y, 4, 1, b.lit);        // a small keypad block
    knurl(x + 3, y + 3, 12, 1, r.top);                             // machined grip along the front

  };

  F.crate = (x, y, w, h) => {
    /* v69 CRATE (2x1) — a METAL freight crate. Timber is retired here: the gold crate already owns the
       "chest" read, so the plain one becomes plain galvanised steel and the two separate by MATERIAL
       rather than by decoration.
       ⛔ NO SCREENS, NO STENCIL, NO LIT MARK. This is a dumb box. Every panel it has is structural —
          ribs, banding, brackets, a latch. A glowing chit on a container claims a state the harness
          cannot prove, and it was also the thing that made it read as an appliance.
       ⛔ RIBS RUN VERTICALLY, BANDS RUN HORIZONTALLY. That crossing is the whole language of a shipping
          container; either one alone reads as a louvre bank.
       ⛔ COOL STEEL, NOT BRASS. Brass belongs to the gold crate. Anything warm here collapses the pair. */
    const EDGE = '#12181d';
    const ST = '#5c666e', ST_L = '#828d95', ST_HI = '#a9b3ba', ST_D = '#39424a', ST_DK = '#242c33';
    const bT = y - 2, bH = 12;

    shadow2(x + 1, y + h - 1, w - 2);

    /* ---- FRONT FACE, in three clean zones so nothing competes: band / ribbed field / band.
       A first pass ran ribs, rivets, corner brackets and wear speckle through the same eight rows and
       the face turned to mud — at 22px wide a plane can carry ONE texture, and here that is the ribs. */
    px(x, bT, w, bH, EDGE);
    px(x + 1, bT + 1, w - 2, bH - 2, ST);
    px(x + 1, bT + 1, 1, bH - 2, ST_L); px(x + w - 2, bT + 1, 1, bH - 2, ST_DK);
    rimEdge(x + w - 2, bT + 2, 1, bH - 5, 0.20);
    for (let i = 0; i < 5; i++) {                                   // the ribbed field, 4 rows only
      const rx = x + 3 + i * 4;
      px(rx, bT + 4, 2, 4, shade(ST, 0.14));                      // the rib's lit crown
      px(rx + 2, bT + 4, 1, 4, ST_D);                               // the valley beside it
    }

    /* ---- TWO STEEL BANDS, top and bottom, each with its own cast ---- */
    for (const by of [bT + 1, bT + 8]) {
      px(x + 1, by, w - 2, 2, ST_D);
      px(x + 1, by, w - 2, 1, ST_L); keyEdge(x + 2, by, 8, 1, 0.18);
      px(x + 1, by + 2, w - 2, 1, shade(ST_DK, -0.40));
      for (let i = 0; i < 3; i++) px(x + 4 + i * 7, by + 1, 1, 1, ST_HI);   // three rivets, not six
    }

    /* ---- LATCH: a plate straddling the lid line over a dark keeper ---- */
    const hx = x + Math.round(w / 2) - 2;
    px(hx, y - 4, 5, 6, ST_DK);
    px(hx, y - 4, 5, 1, ST_HI); px(hx, y - 3, 5, 2, ST_L); px(hx, y - 1, 5, 1, ST_D);
    px(hx + 2, y, 1, 2, '#151b20');                                 // the lock recess
    px(hx, y + 2, 5, 1, shade(ST_DK, -0.40));

    /* ---- SKIDS + floor line ---- */
    px(x + 1, y + h - 3, w - 2, 1, '#090c0f');
    px(x + 1, y + h - 2, 5, 1, ST_DK); px(x + w - 6, y + h - 2, 5, 1, ST_DK);
    ctx.globalAlpha = 0.34; px(x + 1, y + h - 1, w - 2, 1, '#000'); ctx.globalAlpha = 1;

    /* ---- LID: the foreshortened top plane, ribbed the other way, proud of the body ---- */
    chamf(x - 1, y - 10, w + 2, 10, EDGE, 2);
    chamf(x, y - 9, w, 8, ST, 2);
    px(x + 1, y - 9, w - 2, 1, ST_HI); keyEdge(x + 2, y - 9, 9, 1, 0.26);
    for (let i = 1; i < 4; i++) {                                   // ribs crossing the lid
      px(x + 1, y - 8 + i * 2, w - 2, 1, shade(ST, -0.20));
      px(x + 1, y - 7 + i * 2, w - 2, 1, shade(ST, 0.08));
    }
    px(x, y - 9, 1, 8, ST_L); px(x + w - 1, y - 9, 1, 8, ST_DK);
    rimEdge(x + w - 1, y - 8, 1, 6, 0.20);
    px(x + 1, y - 2, w - 2, 1, shade(ST_DK, -0.30));              // the rebate under the lip
    for (const s of [0, 1]) {                                       // lid corner caps
      const cx0 = s ? x + w - 3 : x + 1;
      px(cx0, y - 9, 2, 1, ST_L); px(cx0, y - 8, 2, 1, ST_DK);
    }
    wear(x + 2, y - 8, w - 4, 6, 4, shade(ST, -0.14));
  };

  F.fabricator = (x, y, w, h, f) => { // v4 apparel fabricator (3x2) — a framed gantry BAY, a feed line, an out-hopper
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x, y + 14, w, h - 14);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 3, y + 13, x + w + 2, y + h - 3, 2.4);
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 15, 3, 3, LINE); px(lx, y + 15, 1, 3, r.lit); px(lx + 1, y + 15, 1, 3, r.dk);
      rimEdge(lx + 2, y + 15, 1, 2, 0.16);
    }
    underAO(x + 5, y + 15, w - 10, 2);
    // OUT hopper on the plate — a 3x2 machine needs a visible in-end and out-end, not one big shape
    chamf(x + 12, y + 16, 12, 6, LINE, 1);
    px(x + 13, y + 17, 10, 4, shade(r.face, -0.18));
    px(x + 13, y + 17, 10, 1, r.face); keyEdge(x + 14, y + 17, 6, 1, 0.14);
    px(x + 13, y + 20, 10, 1, r.ao);
    px(x + 15, y + 18, 6, 2, '#d8d0c0'); px(x + 15, y + 18, 6, 1, '#ece4d6');   // folded output
    px(x + 17, y + 18, 2, 1, '#b8b0a0');
    // short south face: progress well + run/heater lamps
    chamf(x - 1, y + 9, w + 2, 7, LINE, 2);
    px(x, y + 10, w, 4, r.face);
    px(x, y + 10, w, 1, r.lit); keyEdge(x + 1, y + 10, w - 5, 1, 0.15);
    px(x, y + 11, 1, 3, shade(r.face, 0.08)); px(x + w - 1, y + 11, 1, 3, r.dk);
    rimEdge(x + w - 1, y + 11, 1, 3, 0.20);
    px(x, y + 13, w, 1, r.ao);
    inset(x + 3, y + 11, w - 14, 2, '#10161a');
    if (on) {
      const pw = 1 + Math.floor(((now / 900) % 1) * (w - 17));
      px(x + 4, y + 11, pw, 1, '#ff9d2e');
      bloom(x + 4, y + 11, pw, 1, '#ff9d2e', 0.16);
    } else px(x + 4, y + 11, 2, 1, shade('#ff9d2e', -0.66));   // parked head still reads as a bar, not a dead slot
    px(x + w - 8, y + 11, 2, 2, (blink(400) && on) ? ACC.work : '#2a3a30');   // run light (kept 400)
    px(x + w - 5, y + 11, 1, 1, blink(900) ? ACC.flow : '#33291a');           // heater light (kept 900)
    // the chamfered casing top dominates
    chamf(x - 1, y - 4, w + 2, 14, LINE, 2);
    chamf(x, y - 3, w, 12, r.top, 2);
    px(x + 2, y - 3, w - 4, 1, r.sheen); keyEdge(x + 2, y - 3, 10, 1, 0.30);
    px(x, y - 1, 1, 9, r.lit); px(x + w - 1, y - 1, 1, 9, r.dk);
    rimEdge(x + w - 1, y - 1, 1, 9, 0.20);
    px(x + 2, y + 8, w - 4, 1, shade(r.top, -0.18));
    wear(x + 2, y + 5, w - 4, 3, 3, shade(r.top, -0.10));
    px(x + 1, y + 1, 3, 5, shade(r.top, -0.26)); px(x + 1, y + 1, 3, 1, shade(r.top, 0.10)); // access hatch
    px(x + 2, y + 3, 1, 1, r.sheen);
    for (let i = 0; i < 3; i++) { px(x + w - 5, y + 1 + i * 2, 3, 1, r.ao); px(x + w - 5, y + 2 + i * 2, 3, 1, shade(r.top, 0.08)); }
    // PRINT BAY: a heavy frame around the bed, so the window reads as a machine cavity and not a sticker
    const bx = x + 6, by = y - 1, bw = w - 14, bh = 6;
    px(bx - 2, by - 2, bw + 4, bh + 4, LINE);
    px(bx - 1, by - 1, bw + 2, bh + 2, shade(r.face, -0.34));
    px(bx - 1, by - 1, bw + 2, 1, shade(r.top, 0.10));
    px(bx - 1, by - 1, 1, bh + 2, shade(r.top, 0.06)); px(bx + bw, by - 1, 1, bh + 2, shade(r.top, -0.40));
    px(bx - 1, by + bh, bw + 2, 1, shade(r.top, -0.44));
    px(bx, by, bw, bh, on ? '#20282e' : '#161d22');            // bed plate — idle keeps a little sheen, never a hole
    px(bx, by, bw, 1, shade(r.face, -0.5));                  // recess shadow at the back of the well
    px(bx, by + 1, bw, 1, shade(r.top, -0.05));              // gantry rail
    if (on) {
      const hd = bx + 1 + Math.floor((now / 120) % (bw - 3));  // moving print head (kept 120)
      px(bx, by + 3, bw, 3, shade('#ff9d2e', -0.55));        // laid-down material
      for (let i = 0; i < bw; i += 2) px(bx + i, by + 4, 1, 1, shade('#ff9d2e', -0.30));
      bloom(bx, by + 3, bw, 3, '#ff9d2e', 0.12 + 0.05 * Math.sin(now / 300 + ph));
      px(hd, by + 1, 2, 4, '#8a98a8'); px(hd, by + 1, 2, 1, '#b6c2ce');   // carriage
      px(hd, by + 5, 2, 1, '#ffd9a0');                         // molten thread at the nozzle
      bloom(hd, by + 4, 2, 2, '#ff9d2e', 0.34);
      scanl(bx, by, bw, bh, 0.14);
      spill(bx - 1, by + bh + 1, bw + 2, '#ff9d2e', 0.18, 4);  // bay heat pooling down the casing top
    } else {
      px(bx + 1, by + 3, 3, 1, '#222c34');                     // parked gantry (kept)
      px(bx + bw - 3, by + 2, 1, 1, blink(1600, ph) ? '#ff9d2e' : '#33241a'); // standby (kept 1600)
    }
    // filament spool on the west flank + the feed tube arcing into the bay — plumbing is what says "machine"
    chamf(x - 3, y + 1, 7, 7, LINE, 1);
    px(x - 2, y + 2, 5, 5, shade(r.face, -0.10)); px(x - 2, y + 2, 5, 1, r.lit);
    rimEdge(x + 2, y + 3, 1, 4, 0.18);
    px(x - 1, y + 3, 3, 3, '#c98a3a'); px(x - 1, y + 3, 3, 1, shade('#c98a3a', 0.22));
    px(x, y + 4, 1, 1, '#10161a');                             // hub
    const spin = Math.floor(now / 200) % 4;                    // rotation tell (kept 200)
    if (on) px(x - 1 + (spin % 3), y + (spin < 2 ? 3 : 5), 1, 1, shade('#c98a3a', 0.34));
    cable(x + 2, y + 3, bx + 2, by + 1, -2.2, '#2a2118');
  };

  F.vat = (x, y, w, h, f) => { // v4 wax vat (3x2) — dark basin body, LIT MENISCUS, firelight climbing the inner rim
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x, y + 15, w, h - 15);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 4, y + 14, x + w + 2, y + h - 3, 2.2);
    // candle tray on the plate — the vat's visible OUTPUT
    chamf(x + 3, y + 16, 15, 6, LINE, 1);
    px(x + 4, y + 17, 13, 4, shade(r.face, -0.18)); px(x + 4, y + 17, 13, 1, r.face);
    keyEdge(x + 5, y + 17, 8, 1, 0.14);
    px(x + 4, y + 20, 13, 1, r.ao);
    for (const c3 of [[x + 5, y + 18, 3], [x + 8, y + 17, 4], [x + 11, y + 18, 3]]) {
      px(c3[0], c3[1], 2, c3[2], '#c9a866'); px(c3[0], c3[1], 1, c3[2], '#dcc088');
      px(c3[0], c3[1], 2, 1, '#e6d0a0'); px(c3[0], c3[1] - 1, 1, 1, '#7a7266');   // wick (kept)
    }
    px(x + 14, y + 19, 2, 1, '#b89858');                       // wax drip (kept)
    // drum body — warm key down the west curve, cool sky bounce down the east
    chamf(x, y + 2, w, 15, LINE, 2);
    px(x + 1, y + 3, w - 2, 12, r.face);
    px(x + 1, y + 3, 2, 12, r.lit); keyEdge(x + 1, y + 4, 1, 9, 0.18);
    px(x + w - 3, y + 3, 2, 12, r.dk); rimEdge(x + w - 3, y + 4, 1, 9, 0.22);
    px(x + 2, y + 14, w - 4, 1, r.ao);
    px(x + 1, y + 8, w - 2, 1, shade(r.face, -0.30));        // welded hoop
    px(x + 1, y + 9, w - 2, 1, shade(r.face, 0.10));
    knurl(x + 4, y + 5, 8, 1, r.face);
    // BURNER: firelight leaks from the seam under the drum and is hottest at the pilot, not a uniform bar
    const heat = on ? 0.52 + 0.26 * Math.sin(now / 250 + ph) : 0.15;
    for (let i = 0; i < w - 6; i++) {
      const a = heat * (0.32 + 0.68 * Math.exp(-Math.abs(i - (w - 6) * 0.34) / 7));
      ctx.globalAlpha = Math.max(0, Math.min(0.85, a)); px(x + 3 + i, y + 11, 1, 1, '#ff5a2a');
    }
    ctx.globalAlpha = 1;
    bloom(x + 5, y + 11, w - 10, 1, '#ff9d2e', heat * 0.20);
    for (let i = 0; i < (w - 6) / 4; i++) px(x + 3 + i * 4, y + 13, 2, 1, i % 2 ? '#caa84a' : '#28323a'); // hazard (kept)
    px(x + w - 7, y + 10, 5, 5, LINE);                         // temp gauge (kept)
    px(x + w - 6, y + 11, 3, 3, '#1b2226'); px(x + w - 6, y + 11, 3, 1, shade(r.face, 0.14));
    px(x + w - 5 + (on ? 1 : 0), y + 12, 1, 1, on ? ACC.flow : shade(ACC.flow, -0.55));  // needle swings hot
    // the OVAL RIM + molten pool dominate: dark body below the surface, light climbing UP the far wall
    const cx2 = x + w / 2, cy2 = y + 3;
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2, 7, 0, 0, 6.2832); ctx.fillStyle = LINE; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2 - 1, 6, 0, 0, 6.2832); ctx.fillStyle = r.top; ctx.fill();
    ctx.globalAlpha = 0.85; ctx.strokeStyle = r.sheen; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.5, w / 2 - 2.5, 5, 0, Math.PI * 1.02, Math.PI * 1.98); ctx.stroke();
    ctx.globalAlpha = 0.30; ctx.strokeStyle = SKY;             // cool bounce on the near rim
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.5, w / 2 - 2.5, 5, 0, Math.PI * 0.08, Math.PI * 0.92); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2 - 3.5, 4.6, 0, 0, 6.2832); ctx.fillStyle = '#1a1108'; ctx.fill();
    ctx.globalAlpha = on ? 0.46 : 0.22; ctx.strokeStyle = '#ff9d2e'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.4, w / 2 - 4.2, 4.0, 0, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.globalAlpha = 1;                                        // ^ the pool lighting the far inner wall
    const lvl = 3 + Math.round(Math.sin(now / 900 + ph));       // wax level breathes (kept)
    const wrx = w / 2 - 4.5 - (4 - lvl) * 0.7, wry = 3.8 - (4 - lvl) * 0.4;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.5, wrx, wry, 0, 0, 6.2832); ctx.fillStyle = on ? '#e0a03c' : '#8a6a30'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.3, wrx - 1.6, wry - 1.1, 0, 0, 6.2832); ctx.fillStyle = on ? '#ffd9a0' : '#b08a4a'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2 - 1.5, cy2 - 0.2, wrx * 0.42, wry * 0.4, 0, 0, 6.2832); ctx.fillStyle = on ? '#fff0cc' : '#c8a366'; ctx.fill();
    ctx.globalAlpha = 0.8; ctx.strokeStyle = '#fff4dd'; ctx.lineWidth = 1;   // the LIT MENISCUS on the near lip
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.5, Math.max(0.6, wrx - 0.4), Math.max(0.6, wry - 0.4), 0, Math.PI * 0.10, Math.PI * 0.90); ctx.stroke();
    ctx.globalAlpha = 1;
    px(Math.round(cx2 - wrx) + 1, cy2, 1, 1, '#f0c890');        // meniscus catch (kept)
    px(x + 6 + Math.floor((now / 500) % (w - 14)), cy2 - 1, 2, 1, '#fff4dd');  // shimmer (kept)
    const stx = x + 7 + Math.floor((0.5 + 0.5 * Math.sin(now / 1300 + ph)) * (w - 15));  // stirrer sweep (kept)
    px(stx, cy2 - 4, 1, 5, '#8a98a8'); px(stx, cy2 - 4, 1, 1, '#aab8c8'); px(stx + 1, cy2 - 3, 1, 3, '#3e4a54');
    px(stx - 1, cy2 + 1, 3, 1, '#f0c890'); px(stx - 2, cy2 + 2, 5, 1, shade('#f0c890', -0.35));  // wake
    ctx.restore();
    // stirrer GANTRY bridging the basin — the paddle hangs off it instead of floating over the wax
    px(x + 4, y - 4, w - 8, 2, LINE); px(x + 5, y - 4, w - 10, 1, r.top);
    keyEdge(x + 5, y - 4, 8, 1, 0.24);
    px(x + 4, y - 3, 2, 5, LINE); px(x + w - 6, y - 3, 2, 5, LINE);
    px(x + 4, y - 3, 1, 5, r.lit); px(x + w - 5, y - 3, 1, 5, r.dk);
    px(stx, y - 3, 1, 2, '#6a7884');                            // shaft up to the rail
    glow(x + 5, y - 3, w - 10, 1, '#ff9d2e', on ? 0.30 : 0.12); // the pool lights the gantry's underside
    if (on && blink(300, ph)) { px(x + (w >> 1), y - 7, 1, 2, '#ff9d2e'); px(x + (w >> 1), y - 8, 1, 1, ACC.flow); } // flame test (kept)
    bloom(x + 5, y - 1, w - 10, 8, '#ff9d2e', (on ? 0.15 : 0.06) + 0.04 * Math.sin(now / 700 + ph));
  };

  F.easel = (x, y, w, h, f) => {
    // EASEL (3x2) — v6. The v4 version had an easel's ANATOMY (A-frame, ledge, canvas) and still read as
    // a CRT MONITOR ON A STAND, because of one decision: the canvas was a DARK WELL — inset() over
    // #170f22, with an idle ground of #1d1528. Dark rectangle in a heavy frame on legs IS a monitor;
    // that is the same shape the console and tacscreen props use, and no amount of easel joinery around
    // it can win the argument. A canvas is the LIGHTEST thing in the room — primed linen — so the ground
    // is now cream and the picture is painted in dark pigment ON it, which is the correct polarity and
    // fixes the read on its own. Three supporting changes: the frame goes to warm TIMBER (v4 used
    // RAMP.gun, i.e. the same metal as the lockers), the centre mast now rises ABOVE the canvas the way
    // a real easel's does, and the ledge carries brushes and a palette so the prop reads as in use.
    const on = !!(f && f.work), ph = (f && f.x) || 0;
    const WD = '#7a5a34', WD_LIT = '#a37c4c', WD_DK = '#432d16';
    const LIN = '#d9cfbc', LIN_LIT = '#f2e9d6', LIN_DK = '#9d9483';   // primed linen
    const cx0 = x + 8, cy0 = y - 9, cw = w - 16, ch = 18;             // the canvas face
    shadow2(x + 3, y + h - 1, w - 6);
    // ---- CENTRE MAST, rising past the canvas top. This overshoot is the single silhouette cue that
    // separates an easel from any other framed panel on a stand, and v4 stopped the mast at the canvas.
    px(x + (w >> 1) - 1, cy0 - 5, 3, h - cy0 + y + 3, LINE);
    px(x + (w >> 1), cy0 - 4, 1, h - cy0 + y + 1, WD);
    px(x + (w >> 1), cy0 - 4, 1, 4, WD_LIT); keyEdge(x + (w >> 1), cy0 - 4, 1, 3, 0.20);
    rimEdge(x + (w >> 1), cy0 + 12, 1, 6, 0.16);
    // ---- SPLAYED FRONT LEGS. Kept from v4 (the geometry was never the problem) but in timber.
    for (const pair of [[x + 10, x + 4], [x + w - 12, x + w - 6]]) {
      const tx = pair[0], fx2 = pair[1];
      for (let i = 0; i < 9; i++) px(Math.round(tx + (fx2 - tx) * (i / 8)) - 1, y + 5 + i * 2, 4, 3, LINE);
      for (let i = 0; i < 9; i++) {
        const lx = Math.round(tx + (fx2 - tx) * (i / 8));
        px(lx, y + 5 + i * 2, 1, 2, WD_LIT); px(lx + 1, y + 5 + i * 2, 1, 2, WD_DK);
      }
      px(fx2 - 1, y + h - 2, 4, 2, LINE); px(fx2, y + h - 2, 2, 1, WD);
      px(fx2 - 1, y + h - 1, 4, 1, '#0a0d10');                       // foot contact
      keyEdge(fx2, y + h - 3, 1, 2, 0.16);
    }
    cable(x + 6, y + 17, x + w - 8, y + 17, 2.6, '#2b2016');         // slack tension cord across the A
    // ---- CANVAS: a stretcher frame in timber, then PRIMED LINEN. The top edge of the stretcher is
    // drawn as a lit 1px band standing proud of the face — that reads as the canvas LEANING BACK.
    chamf(cx0 - 2, cy0 - 2, cw + 4, ch + 4, LINE, 2);
    chamf(cx0 - 1, cy0 - 1, cw + 2, ch + 2, WD, 1);
    px(cx0, cy0 - 2, cw, 1, WD_LIT); keyEdge(cx0 + 1, cy0 - 2, 7, 1, 0.26);   // the proud top edge
    px(cx0 - 1, cy0 + 1, 1, ch - 2, WD_LIT); px(cx0 + cw, cy0 + 1, 1, ch - 2, WD_DK);
    rimEdge(cx0 + cw, cy0 + 1, 1, ch - 2, 0.20);
    px(cx0 - 1, cy0 + ch, cw + 2, 1, shade(WD_DK, -0.20));         // the frame's bottom rail, in shade
    px(cx0, cy0, cw, ch, LIN);                                       // PRIMED LINEN — the light ground
    px(cx0, cy0, cw, 1, LIN_LIT);                                    // the top of the weave takes the key
    px(cx0, cy0, 1, ch, shade(LIN, 0.05)); px(cx0 + cw - 1, cy0, 1, ch, LIN_DK);
    for (let i = 0; i < 3; i++) px(cx0 + 1, cy0 + 4 + i * 5, cw - 2, 1, shade(LIN, -0.06));   // weave
    px(cx0, cy0 + ch - 1, cw, 1, shade(LIN, -0.16));               // the ledge's shadow on the linen
    // ---- THE PICTURE. Dark pigment on the light ground, in both states. Idle is a charcoal LAY-IN
    // (horizon, a figure blocked in, a couple of construction lines); working paints it in, top-down.
    // It is a PORTRAIT easel, so the lay-in is a bust: head, neck, then shoulders spreading wider than
    // the head. A first draft blocked a torso and a second "mass" beside it and the pair read as a chess
    // piece next to a bottle — on a 20px canvas the shoulder line is the only cue that says "a person".
    const PG = '#4b4034', PG2 = '#6d6152';
    px(cx0 + 7, cy0 + 3, 5, 5, PG);                                  // head
    px(cx0 + 8, cy0 + 2, 3, 1, shade(PG, -0.20));                  // crown
    px(cx0 + 8, cy0 + 8, 3, 2, shade(PG, 0.10));                   // neck
    // shoulders — TAPERED, and they must not touch the canvas edges. A first draft ran them 13px wide
    // at a constant width and the bust read as a dark BAR under a blob: a rectangle spanning the picture
    // is a horizon, not a body. Widening row by row, with linen left either side, is what makes it read.
    for (let j = 0; j < 5; j++) px(cx0 + 8 - j - 1, cy0 + 10 + j, 5 + (j + 1) * 2, 1, PG);
    px(cx0 + 6, cy0 + 10, 7, 1, PG2);                                // the lit top of the shoulder line
    px(cx0 + 6, cy0 + 12, 2, 3, shade(PG, -0.18)); px(cx0 + 11, cy0 + 12, 2, 3, shade(PG, -0.18));
    px(cx0 + 1, cy0 + 9, 5, 1, shade(LIN, -0.20));                 // the ground line, BEHIND the sitter
    px(cx0 + cw - 6, cy0 + 9, 5, 1, shade(LIN, -0.20));
    px(cx0 + 2, cy0 + 6, 3, 1, shade(LIN, -0.14));                 // two construction marks, still showing
    px(cx0 + cw - 5, cy0 + 5, 3, 1, shade(LIN, -0.14));
    if (on) {
      // THE REVEAL PAINTS THE PICTURE, IT DOES NOT ERASE IT. A first version filled every revealed row
      // edge-to-edge with ACC.lounge, so "working" replaced the portrait with a flat magenta flag and
      // the face survived only as a peach square floating in it. The reveal now lays a muted BACKDROP
      // and then re-stamps the same head/neck/shoulder geometry in painted tones over it — same shapes
      // as the lay-in, in colour, which is what finishing a canvas actually looks like.
      const BKD = '#6b4257', SKN = '#f0c69c', HAIR = '#3a2430', GRB = shade(ACC.lounge, -0.34);
      const rev = (now / 2400) % 1, rh = Math.max(1, Math.min(ch - 2, Math.floor((ch - 2) * rev) + 1));
      const done = (ry, rhh) => Math.max(0, Math.min(rhh, rh - (ry - cy0 - 1)));   // rows of a band painted
      for (let j = 0; j < rh; j++)                                   // the backdrop wash, warm at the top
        px(cx0 + 1, cy0 + 1 + j, cw - 2, 1, shade(BKD, 0.14 * (1 - j / ch)));
      let d = done(cy0 + 2, 1); if (d) px(cx0 + 8, cy0 + 2, 3, d, HAIR);            // crown
      d = done(cy0 + 3, 5); if (d) { px(cx0 + 7, cy0 + 3, 5, d, SKN);               // head
        px(cx0 + 7, cy0 + 3, 1, d, shade(SKN, -0.22)); px(cx0 + 7, cy0 + 3, 5, 1, HAIR); }
      if (rh > 5) { px(cx0 + 8, cy0 + 5, 1, 1, '#2a1a24'); px(cx0 + 10, cy0 + 5, 1, 1, '#2a1a24'); }
      d = done(cy0 + 8, 2); if (d) px(cx0 + 8, cy0 + 8, 3, d, shade(SKN, -0.16));  // neck
      for (let j = 0; j < 5; j++)                                    // shoulders, in the sitter's garment
        if (done(cy0 + 10 + j, 1)) px(cx0 + 8 - j - 1, cy0 + 10 + j, 5 + (j + 1) * 2, 1, j ? GRB : shade(GRB, 0.22));
      // the wet edge — the only bright pixel this prop ever shows, and it exists only while a row is wet
      if (rh < ch - 2) px(cx0 + 1, cy0 + 1 + rh, cw - 2, 1, blink(120, ph) ? '#ffe4f6' : ACC.lounge);
      bloom(cx0 + 1, cy0 + 1, cw - 2, rh, ACC.lounge, 0.09);
    } else {
      px(cx0 + cw - 3, cy0 + ch - 3, 1, 1, blink(1600, ph) ? shade(ACC.flow, -0.30) : '#8d8474');   // a pin
    }
    // ---- PAINT LEDGE bolted across the front legs, with the tools on it
    chamf(x + 5, y + 12, w - 10, 5, LINE, 1);
    px(x + 6, y + 13, w - 12, 3, WD); px(x + 6, y + 13, w - 12, 1, WD_LIT);
    keyEdge(x + 7, y + 13, 8, 1, 0.15);
    px(x + 6, y + 15, w - 12, 1, shade(WD_DK, -0.20));
    // TOOLS. Both of these must clear the canvas: a first pass stood the brush jar at x+7 and hooked the
    // palette at x+w-15, and since the canvas face spans cx0..cx0+cw (x+8 .. x+28) BOTH were painted
    // straight over the picture. The canvas owns the middle; the tools get the two clear side strips.
    px(x + 1, y + 8, 5, 5, '#26303a'); px(x + 1, y + 8, 5, 1, '#3d4a56');   // brush jar, west of the frame
    px(x + 1, y + 12, 5, 1, '#151c22');
    for (let i = 0; i < 3; i++) {                                    // brushes: verticals that say "in use"
      const bxx = x + 2 + i;
      px(bxx, y + 3 + i, 1, 6 - i, '#8a6a42');
      px(bxx, y + 3 + i, 1, 1, ['#c8c0b0', '#a33a3a', '#4ad9ff'][i]);
    }
    // PALETTE lying on the ledge, east of the canvas and BELOW its bottom rail
    chamf(x + w - 12, y + 11, 11, 5, LINE, 1);
    chamf(x + w - 11, y + 12, 9, 3, '#9d8a6c', 1); px(x + w - 11, y + 12, 9, 1, '#bda887');
    px(x + w - 5, y + 13, 2, 1, shade('#9d8a6c', -0.44));          // the thumb hole
    for (const dab of [[x + w - 10, ACC.lounge], [x + w - 8, ACC.data], [x + w - 6, ACC.flow]])
      px(dab[0], y + 12, 1, 1, shade(dab[1], -0.20));
    px(x + 12, y + 15, 1, 1, shade(ACC.lounge, -0.20)); px(x + 17, y + 15, 1, 1, shade(ACC.data, -0.20));
    if (on) spill(x + 8, y + 12, w - 16, ACC.lounge, 0.18, 4);       // the wet canvas throws colour down
  };

  F.beltH = (x, y, w, h) => {
    // CONVEYOR — a FLOOR-FLAT belt segment carrying work boxes between stations (walk-level deck
    // hardware, integral to the floor — no separate plate). Moving tread + hazard ends + a drive-motor
    // indicator. Bolder restyle in the RAMP/ACC language, matched to conveyor.js's live-belt look.
    const r = RAMP.steel;
    const top = y + 2, bh = h - 4;                            // belt bed sits between two rails
    // bed: dark recessed channel
    rr(x - 1, top - 1, w + 2, bh + 2, LINE);
    px(x, top, w, bh, shade(r.face, -0.3));
    px(x, top, w, 1, r.ao);
    // moving tread: diagonal cleats scrolling east (matches conveyor.js direction)
    const off = Math.floor(now / 110) % 6;
    for (let i = -1; i < w / 6 + 1; i++) {
      const cx = x + 1 + i * 6 + off;
      px(cx, top + 1, 1, bh - 2, r.lit);                     // cleat lit face
      px(cx + 1, top + 1, 1, bh - 2, r.dk);                  // cleat shadow
    }
    px(x, top + 1, w, 1, shade(r.top, -0.10));             // subtle bed sheen over the tread
    // side RAILS (raised guide walls, lit top / dark inner)
    px(x - 1, y + 1, w + 2, 2, LINE); px(x - 1, y + h - 3, w + 2, 2, LINE);
    px(x, y + 1, w, 1, r.sheen); px(x, y + 2, w, 1, r.lit);  // north rail
    px(x, y + h - 3, w, 1, r.top); px(x, y + h - 2, w, 1, r.dk); // south rail (faces us)
    for (let i = 0; i < w / 12; i++) {                       // rail bolts + roller shadows
      px(x + 2 + i * 12, y + 1, 1, 1, r.sheen);
      px(x + 8 + i * 12, y + h - 1, 2, 1, '#141a16');
    }
    // hazard ends (yellow/black chevron caps)
    px(x, y, 2, h > 6 ? 3 : 2, '#caa84a'); px(x + 1, y, 1, h > 6 ? 3 : 2, '#2a2418');
    px(x + w - 2, y, 2, h > 6 ? 3 : 2, '#caa84a'); px(x + w - 2, y, 1, h > 6 ? 3 : 2, '#2a2418');
    // drive-motor housing at the left end with a spinning green run indicator
    px(x + 1, y + h - 2, 6, 3, '#232d33'); px(x + 1, y + h - 2, 6, 1, r.lit);
    px(x + 1, y + h - 2, 1, 3, r.dk);
    px(x + 2 + (Math.floor(now / 150) % 3), y + h + 1, 1, 1, ACC.work); // drive pulse
    glow(x + 2, y + h, 4, 1, ACC.work, 0.25);
    wear(x + 1, top + 1, w - 2, bh - 2, 5, shade(r.face, -0.4));
  };

  F.intake = (x, y, w, h, f) => {
    /* v71 INBOX (2x2) — upgrade pass. The anatomy is unchanged and deliberately so: a flared HOPPER over
       a machine shoulder over a south face with the output slot marching EAST onto the belt. What changed:
       ⛔ MATERIAL. It was RAMP.steel, whose brightest stop is luma 110 — the reason every functional prop
          read flat beside the crew sprites, which reach 249. MAT.steel spans the full range, so the
          casing now has a genuine lit crown and a genuine shadow side.
       ⛔ THE MOUTH IS A LIP, NOT AN OUTLINE. A 2px rolled rim with its own highlight run is what makes
          the funnel read as an opening you could drop something into.
       ⛔ CHEVRONS POINT IN. Hazard marks on the shoulder aim at the throat — the inbox is the one prop in
          the catalog whose whole job is a direction, and it should say so without a word of UI.
       ⛔ EDGES TINTED. Same law as the rest of the pass: a pure-black ring reads as a sticker. */
    const EDGE = '#141b21';
    const r = MAT.steel, act = !!(f && f.work), ph = (f && f.x) || 0, cyc = (now / 900) % 1;

    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 6, w + 2, 6);
    deckSocket(x + w + 1, y + h - 3, act);
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    cable(x + w - 4, y + h - 9, x + w + 2, y + h - 3, 2);
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + h - 5, 3, 3, EDGE); px(lx, y + h - 5, 1, 3, r.lit); px(lx + 1, y + h - 5, 1, 3, r.dk);
      rimEdge(lx + 2, y + h - 5, 1, 2, 0.16);
    }
    underAO(x + 5, y + h - 5, w - 10, 2);

    /* ---- SOUTH FACE + the OUTPUT SLOT: a box leaves here, so its bars march EAST ---- */
    chamf(x - 1, y + h - 12, w + 2, 8, EDGE, 2);
    chamf(x, y + h - 11, w, 6, r.face, 2);
    px(x + 1, y + h - 11, w - 2, 1, r.lit); keyEdge(x + 2, y + h - 11, w - 5, 1, 0.18);
    px(x + 1, y + h - 10, w - 2, 1, r.mid);
    px(x, y + h - 9, 1, 3, r.lit); px(x + w - 1, y + h - 9, 1, 3, r.dk);
    rimEdge(x + w - 1, y + h - 9, 1, 3, 0.20);
    px(x + 1, y + h - 6, w - 2, 1, r.ao);
    inset(x + 4, y + h - 10, w - 8, 4, '#231d12');
    for (let i = 0; i < w - 10; i++)
      if ((i + Math.floor(now / 160)) % 4 === 0) px(x + 5 + i, y + h - 9, 1, 2, act ? '#ffe27a' : shade(ACC.flow, -0.5));
    if (act) bloom(x + 5, y + h - 9, w - 10, 2, ACC.flow, 0.18);

    /* ---- MACHINE SHOULDER: the top surface the hopper is bolted through ---- */
    chamf(x - 1, y + h - 20, w + 2, 10, EDGE, 2);
    chamf(x, y + h - 19, w, 8, r.top, 2);
    px(x + 2, y + h - 19, w - 4, 1, r.sheen); keyEdge(x + 2, y + h - 19, 8, 1, 0.28);
    px(x + 2, y + h - 18, w - 4, 1, r.hi);
    px(x, y + h - 17, 1, 5, r.lit); px(x + w - 1, y + h - 17, 1, 5, r.dk);
    rimEdge(x + w - 1, y + h - 17, 1, 5, 0.20);
    px(x + 2, y + h - 12, w - 4, 1, r.ao);
    wear(x + 2, y + h - 17, w - 4, 5, 4, shade(r.top, -0.10));
    for (let i = 0; i < 3; i++) {                                  // hazard chevrons aiming AT the throat
      const cx0 = x + 2 + i * 2;
      px(cx0, y + h - 15, 1, 1, '#caa84a'); px(cx0 + 1, y + h - 14, 1, 1, '#caa84a');
      px(x + w - 3 - i * 2, y + h - 15, 1, 1, '#caa84a'); px(x + w - 4 - i * 2, y + h - 14, 1, 1, '#caa84a');
    }
    for (const gx of [x + 3, x + w - 6]) {                         // neck gussets, with a lit fillet
      px(gx, y + 3, 3, 3, r.dk); px(gx, y + 3, 3, 1, r.mid); px(gx, y + 3, 1, 3, r.face);
    }

    /* ---- FLARED HOPPER: wide rolled rim, straight neck, material falling down the throat ---- */
    for (let j = 0; j < 9; j++) {
      const iw = j < 6 ? 22 - j * 2 : 12, ix = x + 1 + Math.min(j, 5), yy = y - 4 + j;
      px(ix - 1, yy, iw + 2, 1, EDGE);
      px(ix, yy, iw, 1, j === 0 ? r.sheen : j === 1 ? r.hi : r.top);
      px(ix, yy, 1, 1, r.lit); px(ix + iw - 1, yy, 1, 1, r.dk);
      if (j < 2) keyEdge(ix, yy, 8, 1, 0.30); else rimEdge(ix + iw - 1, yy, 1, 1, 0.18);
      const tw = iw - 6, tx0 = ix + 3;
      if (tw > 0) {
        px(tx0 - 1, yy, 1, 1, r.mid);                              // the rim rolling into the throat
        px(tx0, yy, tw, 1, '#150f0a');
        if (((j + Math.floor(now / 200)) % 3) === 0)
          px(tx0, yy, tw, 1, act ? '#ffe27a' : shade(ACC.flow, -0.30));
      }
    }
    if (act || cyc > 0.86) bloom(x + 4, y - 4, 16, 9, ACC.flow, act ? 0.20 + 0.06 * Math.sin(now / 300) : 0.10);
    else glow(x + 4, y - 4, 16, 9, ACC.flow, 0.05);                // never a dead black hole when idle

    /* ---- cyan SIGNAL MAST: the station is LISTENING ---- */
    const ax = x + w - 3, ping = blink(640, ph);
    px(ax, y + 2, 1, 10, r.dk); px(ax - 1, y + 2, 3, 1, r.lit); px(ax, y + 7, 1, 1, r.sheen);
    px(ax, y + 1, 1, 1, ping ? '#7df0ff' : shade(ACC.data, -0.55));
    if (ping) bloom(ax, y + 1, 1, 1, ACC.data, 0.34);
  };

  F.outbox = (x, y, w, h, f) => {
    /* v71 OUTBOX (2x2) — upgrade pass. Anatomy unchanged: an EJECTOR RAMP climbing north-east to a launch
       head, green/cyan against the inbox's amber, with the uncollected-crate stack on the out-tray.
       ⛔ MATERIAL, as with the inbox: MAT.steel instead of RAMP.steel, so the casing spans a real value
          range instead of topping out at luma 110.
       ⛔ THE RAMP NEEDS SIDE RAILS. A bare diagonal band of face colour reads as a painted stripe; two
          rails — lit on the north edge, shadowed on the south — make it a structure work rides up.
       ⛔ f.crates IS THE LEDGER, NEVER INVENTED. The stack is real uncollected while-away runs from the
          ReturnStore; the '+N' overflow is the honest remainder. Untouched on purpose. */
    const EDGE = '#141b21';
    const r = MAT.steel, act = !!(f && f.work), ph = (f && f.x) || 0, cyc = (now / 900) % 1;

    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 6, w + 2, 6);
    deckSocket(x + w + 1, y + h - 3, act);
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    cable(x + 4, y + h - 9, x + 1, y + h - 3, 2);
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + h - 5, 3, 3, EDGE); px(lx, y + h - 5, 1, 3, r.lit); px(lx + 1, y + h - 5, 1, 3, r.dk);
      rimEdge(lx + 2, y + h - 5, 1, 2, 0.16);
    }
    underAO(x + 5, y + h - 5, w - 10, 2);

    /* ---- SOUTH FACE + the chute a finished box is fed into ---- */
    chamf(x - 1, y + h - 12, w + 2, 8, EDGE, 2);
    chamf(x, y + h - 11, w, 6, r.face, 2);
    px(x + 1, y + h - 11, w - 2, 1, r.lit); keyEdge(x + 2, y + h - 11, w - 5, 1, 0.18);
    px(x + 1, y + h - 10, w - 2, 1, r.mid);
    px(x, y + h - 9, 1, 3, r.lit); px(x + w - 1, y + h - 9, 1, 3, r.dk);
    rimEdge(x + w - 1, y + h - 9, 1, 3, 0.20);
    px(x + 1, y + h - 6, w - 2, 1, r.ao);
    inset(x + 4, y + h - 10, w - 8, 4, '#08130f');
    for (let i = 0; i < w - 10; i++)
      if ((i + Math.floor(now / 150)) % 4 === 0) px(x + 5 + i, y + h - 9, 1, 2, act ? '#7df0c8' : shade(ACC.work, -0.5));
    if (act) bloom(x + 5, y + h - 9, w - 10, 2, '#5ad1b3', 0.18);

    /* ---- MACHINE SHOULDER ---- */
    chamf(x - 1, y + h - 20, w + 2, 10, EDGE, 2);
    chamf(x, y + h - 19, w, 8, r.top, 2);
    px(x + 2, y + h - 19, w - 4, 1, r.sheen); keyEdge(x + 2, y + h - 19, 8, 1, 0.28);
    px(x + 2, y + h - 18, w - 4, 1, r.hi);
    px(x, y + h - 17, 1, 5, r.lit); px(x + w - 1, y + h - 17, 1, 5, r.dk);
    rimEdge(x + w - 1, y + h - 17, 1, 5, 0.20);
    px(x + 2, y + h - 12, w - 4, 1, r.ao);
    wear(x + 2, y + h - 17, w - 4, 4, 3, shade(r.top, -0.10));

    /* ---- OUT-TRAY sunk into the west of the shoulder, with a lit sill ---- */
    chamf(x + 1, y + h - 18, 10, 6, EDGE, 1);
    px(x + 2, y + h - 17, 8, 4, '#141c1a'); px(x + 2, y + h - 17, 8, 1, '#090f0d');
    px(x + 2, y + h - 13, 8, 1, r.mid);                            // the sill the stack sits behind

    /* ---- EJECTOR RAMP climbing north-east, now with real side rails ---- */
    const st = Math.floor(now / 130);
    for (let k = 0; k < 12; k++) {
      const rx = x + 9 + k, ry = y + 11 - k;
      px(rx - 1, ry, 1, 1, EDGE); px(rx + 7, ry, 1, 1, EDGE);
      px(rx, ry, 7, 1, k % 2 ? shade(r.face, -0.06) : r.face);
      px(rx, ry, 1, 1, r.hi);                                      // north rail, catching the key
      px(rx + 1, ry, 1, 1, r.mid);
      px(rx + 6, ry, 1, 1, r.ao);                                  // south rail, in its own shade
      px(rx + 5, ry, 1, 1, r.dk);
      if ((((k - st) % 4) + 4) % 4 === 0) {                         // dispatch bars climbing the ramp
        px(rx + 2, ry, 3, 1, act ? '#7df0c8' : shade(ACC.work, -0.45));
        if (act) bloom(rx + 2, ry, 3, 1, '#5ad1b3', 0.16);
      }
    }

    /* ---- LAUNCH HEAD at the ramp's crest ---- */
    chamf(x + 15, y - 5, 9, 8, EDGE, 2);
    chamf(x + 16, y - 4, 7, 6, r.face, 2);
    px(x + 17, y - 4, 5, 1, r.sheen); keyEdge(x + 17, y - 4, 3, 1, 0.28);
    px(x + 16, y - 2, 1, 3, r.lit); px(x + 22, y - 2, 1, 3, r.dk); rimEdge(x + 22, y - 2, 1, 3, 0.20);
    inset(x + 17, y - 3, 5, 4, '#06100e');
    px(x + 18, y - 2, 3, 2, act ? '#7df0c8' : (cyc > 0.86 ? shade(ACC.work, -0.2) : '#0e1a16'));
    bloom(x + 18, y - 2, 3, 2, '#5ad1b3', act ? 0.34 + 0.10 * Math.sin(now / 260) : 0.08);
    px(x + 19, y - 7, 1, 3, r.dk); px(x + 18, y - 7, 3, 1, r.lit);   // uplink whip
    px(x + 19, y - 8, 1, 1, act ? '#7df0c8' : (blink(720, ph + 1) ? ACC.work : shade(ACC.work, -0.6)));
    if (act) bloom(x + 19, y - 8, 1, 1, '#5ad1b3', 0.34);

    /* ---- THE UNCOLLECTED-CRATE STACK (G2.3). f.crates comes from the ReturnStore ledger: real runs,
       never invented. Gentle bob, and a VT323 '+N' for the honest remainder past five. ---- */
    const crates = Math.max(0, (f && f.crates) | 0);
    if (crates > 0) {
      const shown = Math.min(crates, 5), cx = x + 5, base = y + h - 18;
      for (let i = 0; i < shown; i++) {
        const cy = base - i * 6 + Math.sin(now / 380 + i * 0.7) * 0.6;
        const bx0 = Math.round(cx - 4), by0 = Math.round(cy - 4);
        px(bx0 - 1, by0 - 1, 11, 8, '#101614');
        px(bx0, by0 + 3, 9, 3, '#2a6a56');                          // shaded front face
        px(bx0, by0, 9, 3, '#5ad1b3');                              // lit product top
        px(bx0, by0, 9, 1, '#c8f4e6');                              // top sheen
        px(bx0, by0 + 3, 9, 1, '#3d8a72');                          // the crate's own edge thickness
      }
      bloom(cx - 4, base - (shown - 1) * 6 - 4, 9, shown * 6 + 3, '#5ad1b3', 0.14);
      if (crates > 5) {
        ctx.fillStyle = '#7df0c8'; ctx.font = "7px 'VT323','Courier New',monospace";
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('+' + (crates - 5), cx, base - shown * 6 - 2);
      }
    }
  };

  F.studio = (x, y, w, h, f) => {
    /* v49 IMAGE STUDIO (2x2) — PROJECTION FIXED (2026-08-17). v48's anatomy is kept exactly (it is
       not a camera, it is a GENERATIVE PRINTER: a preview picture, CMY ink channels, a lens, and a
       slot the finished print comes out of) and so is its 30px height, which Andrew signed off. What
       was wrong is the same thing the bookshelf, the fish tank and the rack were rebuilt for:
       ⛔ IT WAS A FRONT ELEVATION. The machine had no top at all — every horizontal on it was a 1px
          line, which is the picture you get standing in front of a printer, not looking down at one.
       Two changes, no new parts:
       ⛔ THE MACHINE HAS A TOP DECK. Five rows of surface we look down onto, keyed down the WEST rail
          (a receding plane takes the key on its west rail; on the far edge it reads as a board
          STANDING against the wall), with the OUTPUT TRAY recessed into it and a finished sheet
          lying in the tray while it works. A printer's top IS a tray — this costs nothing invented.
       ⛔ THE PREVIEW PANEL IS RAKED, NOT FLAT-ON. It is a trapezoid — narrower at its far edge, wider
          at its near one — with a lit top bezel and a dark chin. That taper is the whole cue: a
          rectangle facing the camera is an elevation, a trapezoid is a plane tilted toward you. The
          picture inside is unchanged and still the hero.
       ⛔ THE PREVIEW SCREEN MUST SHOW A PICTURE, not a UI. Sky bands, a moon disc, two mountain
          silhouettes, a water line — five big shapes. Anything finer is mud at this size and, worse,
          reads as text, which is the one thing this prop must not look like it makes.
       ⛔ CMY INK CHANNELS ARE THE TELL. Nothing else in the catalog carries cyan+magenta+yellow side
          by side. ⛔ THE LENS reuses the strongbox's concentric-ring "aperture" language.
       ⛔ MAGENTA (ACC.lounge) is this capability's colour: pictures never glow the same green as text. */
    const r = EQUIPMENT, b = INSTRUMENT, br = MAT.brass, on = !!(f && f.work);
    const base = y + h;
    const P = ACC.lounge, C = ACC.data, Y2 = ACC.flow;
    const cx = x + Math.round(w / 2);
    /* the row budget: y-6..y-2 top deck · y-1..y+5 the raked panel · y+6..y+13 the front face
       (LEDs, CMY, lens) · y+14..y+17 print slot · y+18.. plinth, then the deck plate to the floor */
    const DECK = y - 6, PAN = y - 1, PANH = 7;

    shadow2(x + 2, base - 1, w - 4);
    deckPlate(x + 1, base - 4, w - 2, 4);
    deckSocket(x + w + 1, base - 3, on);

    /* ---- BODY, drawn FIRST: everything else is painted into its faces ---- */
    px(x + 1, DECK, w - 2, base - DECK - 2, r.ink);
    panelFinish(x + 2, PAN + PANH, w - 4, base - PAN - PANH - 4, r);
    px(x + 2, PAN + PANH, 1, base - PAN - PANH - 4, r.mid);
    px(x + w - 3, PAN + PANH, 1, base - PAN - PANH - 4, r.dk);

    /* ---- THE TOP DECK: 5 rows of surface, ramping far->near, keyed down the WEST rail.
            ⛔ the far row is inset 1px or its lit corner sits outside the contour and the deck reads
            as a lid laid on the machine. ---- */
    for (let j = 0; j < 5; j++) {
      const i = j ? 1 : 2;
      px(x + i, DECK + j, w - i * 2, 1, shade(r.face, -0.12 + j * 0.05));
    }
    px(x + 2, DECK + 1, 2, 4, r.mid);                                // WEST RAIL, end to end
    px(x + w - 3, DECK + 1, 1, 4, r.dk); rimEdge(x + w - 3, DECK + 1, 1, 4, 0.16);
    px(x + 2, DECK + 4, w - 4, 1, r.lit);                            // the front nosing takes the strip
    /* the OUTPUT TRAY, recessed into the deck, with a finished sheet in it while it works */
    px(x + 5, DECK + 1, w - 10, 3, r.ao);
    px(x + 5, DECK + 1, w - 10, 1, '#070a0d');                       // the recess's own far wall
    if (on) {
      px(x + 7, DECK + 2, w - 14, 2, '#8f8a7e');
      px(x + 7, DECK + 2, w - 14, 1, '#a8a294');
      px(x + 9, DECK + 3, w - 18, 1, shade(P, -0.28));
    }

    /* ---- THE RAKED PREVIEW PANEL: a trapezoid, narrow at the far edge and wide at the near one.
            That taper IS the tilt — a rectangle facing the camera is an elevation. ---- */
    const inset = (j) => j < 2 ? 3 : j < 4 ? 2 : j < 6 ? 1 : 0;
    for (let j = 0; j < PANH; j++) {
      const i = inset(j);
      px(x + i, PAN + j, w - i * 2, 1, r.ink);
    }
    px(x + inset(0) + 1, PAN, w - (inset(0) + 1) * 2, 1, on ? P : shade(P, -0.60));   // lit top bezel
    if (on) bloom(x + inset(0) + 1, PAN, w - (inset(0) + 1) * 2, 1, P, 0.14);
    const gx = x + 4, gy = PAN + 1, gw = w - 8, gh = 5;
    px(gx - 1, gy - 1, gw + 2, gh + 2, '#0a0612');
    for (const sx2 of [gx - 1, gx + gw])                             // the bezel's colour down the rake
      px(sx2, gy, 1, gh, on ? shade(P, -0.42) : shade(P, -0.72));
    if (on) {
      /* the generated picture — five big shapes, nothing finer */
      const sky = ['#8a3f8f', '#a4499b', '#c05aa6', '#d97ab4'];
      for (let j = 0; j < gh; j++) px(gx, gy + j, gw, 1, sky[Math.min(sky.length - 1, Math.floor(j * 4 / gh))]);
      const mx2 = gx + Math.round(gw * 0.42), my = gy + 1, MR = 1.8;   // the moon
      for (let dy = -MR; dy <= MR; dy++) for (let dx = -MR; dx <= MR; dx++)
        if (Math.sqrt(dx * dx + dy * dy) <= MR) px(mx2 + dx, my + dy, 1, 1, dy < 0 ? '#ffe6f6' : '#f0b8e0');
      for (let i = 0; i < gw; i++) {                                 // two mountain silhouettes
        const a = Math.abs(i - gw * 0.32), bpk = Math.abs(i - gw * 0.72);
        const ht = Math.max(0, 4 - Math.round(a * 0.9), 3 - Math.round(bpk * 0.8));
        if (ht > 0) px(gx + i, gy + gh - 1 - ht, 1, ht, i % 3 === 0 ? '#3d3570' : '#2e2857');
      }
      px(gx, gy + gh - 1, gw, 1, '#2a4d8f');                         // the water line
      px(gx + 2, gy + gh - 1, gw - 6, 1, '#4f8fd6');
      scanl(gx, gy, gw, gh, 0.14);
      bloom(gx, gy, gw, gh, P, 0.16);
      spill(x + 2, PAN + PANH, w - 4, P, 0.16, 4);                   // the rake's light falling onto the face
    } else {
      px(gx, gy, gw, gh, '#120a16');
      px(gx, gy, 5, 1, '#241528'); px(gx + 1, gy + 1, 3, 1, '#1b1020');
    }
    px(x + 1, PAN + PANH - 1, w - 2, 1, '#05070a');                  // the panel's chin, in its own shade

    /* ---- the PROJECTOR SLIT under the panel's chin ---- */
    px(cx - 3, PAN + PANH, 6, 2, b.ink);
    px(cx - 2, PAN + PANH, 4, 1, on ? shade(P, -0.20) : shade(P, -0.66));
    px(cx - 1, PAN + PANH, 2, 1, on ? '#ffd0f4' : shade(P, -0.50));
    if (on) bloom(cx - 2, PAN + PANH, 4, 1, P, 0.26);

    /* ---- STATUS LEDS: magenta, cyan, yellow ---- */
    for (let i = 0; i < 3; i++)
      px(x + 3 + i * 2, y + 7, 1, 1, on ? [P, C, Y2][i] : shade([P, C, Y2][i], -0.70));
    px(x + w - 6, y + 7, 2, 1, on ? P : shade(P, -0.70));

    /* ---- CHECKER SWATCH PANEL + CMY INK CHANNELS ---- */
    const pY = y + 9;
    px(x + 2, pY, 6, 5, r.ink);
    px(x + 3, pY, 4, 1, r.mid);                                      // the swatch panel's own lit top
    px(x + 3, pY + 1, 4, 3, b.ao);
    for (let ry = 0; ry < 3; ry++) for (let rx = 0; rx < 4; rx++)
      if ((rx + ry) % 2 === 0) px(x + 3 + rx, pY + 1 + ry, 1, 1, r.mid);   // transparency checker
    px(x + 8, pY, 6, 5, r.ink);
    px(x + 9, pY, 4, 1, r.mid);                                      // the ink bay's lit top
    for (let i = 0; i < 3; i++) {                                    // CMY ink columns
      const col = [C, P, Y2][i], ix = x + 9 + i * 2;
      px(ix, pY + 1, 1, 3, b.ao);
      const lvl = 1 + Math.floor((1 + Math.sin(now / 900 + i * 2.1)) * (on ? 0.9 : 0.4));
      px(ix, pY + 4 - lvl, 1, lvl, on ? col : shade(col, -0.62));
    }

    /* ---- THE LENS: concentric rings around a hot core ---- */
    const lx2 = x + w - 6, ly2 = y + 11, R = 3.6;
    for (let dy = -R - 1; dy <= R + 1; dy++) for (let dx = -R - 1; dx <= R + 1; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > R + 0.7) continue;
      const nl = (dx + dy * 1.1) / (R * 1.9);
      let c;
      if (d > R - 0.3) c = r.ink;
      else if (d > R - 1.3) c = nl < -0.3 ? r.lit : nl < 0.25 ? r.mid : r.dk;
      else if (d > R - 2.0) c = r.ao;
      else if (d > R - 2.9) c = nl < -0.3 ? r.mid : nl < 0.25 ? r.face : r.dk;
      else c = on ? shade(P, -0.34) : shade(P, -0.72);
      px(lx2 + dx, ly2 + dy, 1, 1, c);
    }
    px(lx2 - 1, ly2 - 1, 2, 2, on ? '#ffd0f4' : shade(P, -0.55));
    if (on) bloom(lx2 - 2, ly2 - 2, 4, 4, P, 0.32 + 0.08 * Math.sin(now / 760));

    /* ---- PRINT SLOT across the bottom, with a sheet emerging when it is working ---- */
    const oY = base - 10;
    px(x + 3, oY, w - 6, 4, r.ink);
    px(x + 4, oY + 1, w - 8, 1, r.mid);                              // lit lip above the slot
    px(x + 4, oY + 2, w - 8, 1, '#05070a');                          // the slot itself
    if (on) {
      px(x + 6, oY + 3, w - 12, 2, '#e8e2d6');                       // the print coming out
      px(x + 6, oY + 3, w - 12, 1, '#fffaf0');
      px(x + 8, oY + 4, w - 16, 1, shade(P, 0.10));
    }
    /* ---- PLINTH: magenta bars either side, then feet ---- */
    px(x + 2, base - 6, w - 4, 3, r.ink);
    px(x + 3, base - 5, w - 6, 1, r.top);
    px(x + 3, base - 5, 5, 1, on ? P : shade(P, -0.70));
    px(x + w - 8, base - 5, 5, 1, on ? P : shade(P, -0.70));
    px(x + 1, base - 3, w - 2, 1, r.mid); px(x + 2, base - 2, w - 4, 1, r.ao);
    px(x, base - 2, 4, 2, r.ink); px(x + w - 4, base - 2, 4, 2, r.ink);
    px(x + 1, base - 2, 1, 1, C); px(x + 2, base - 2, 1, 1, Y2);
    px(x + w - 3, base - 2, 2, 1, br.mid);
    if (on) spill(x + 3, base - 5, w - 6, P, 0.14, 4);
  };

  F.missionboard = (x, y, w, h, f) => {
    // MISSION BOARD (3x1) — v4 REBUILD. This prop predated the locked style law and was still drawn as a
    // flat outlined slab. It is now a WALL-HUNG briefing frame: chamfered slate carcass on two lugs, a
    // recessed cork well, a phosphor header and a rail of pinned cards. Every card stub is ONE real open
    // quest (f.pins), so the COUNT leads — the cards stay plain paper rectangles at an even pitch and the
    // header prints the number outright. f.hot = a station-gap quest is open, f.jam = a routine is backed
    // up, f.proposals = agent-pinned requisitions. Click -> QUEST LOG.
    const r = RAMP.gun, ph = (f && f.x) || 0;
    const pins = Math.max(0, (f && f.pins) | 0);
    const bt = y - 10, bh = 21;                                   // the board overdraws north of its tile
    ctx.globalAlpha = 0.18; px(x + 2, bt + 3, w, bh, '#000'); ctx.globalAlpha = 1;   // cast on the bulkhead
    for (const lx of [x + 5, x + w - 7]) {                        // wall lugs it hangs off
      px(lx, bt - 3, 2, 4, LINE); px(lx, bt - 3, 2, 1, shade(r.top, 0.20));
      rimEdge(lx + 1, bt - 2, 1, 3, 0.18);
    }
    // chamfered slate carcass — 2px corner cuts so the frame reads as machined, not as a lozenge
    chamf(x - 1, bt - 1, w + 2, bh + 2, LINE, 2);
    chamf(x, bt, w, bh, r.face, 2);
    px(x + 2, bt, w - 4, 1, r.top); keyEdge(x + 2, bt, 11, 1, 0.28);          // warm ceiling strip on the crown
    px(x, bt + 2, 1, bh - 4, r.lit); px(x + w - 1, bt + 2, 1, bh - 4, r.dk);
    rimEdge(x + w - 1, bt + 2, 1, bh - 4, 0.22);                              // cool sky bounce, shade side
    for (const rx of [x + 2, x + w - 3]) { px(rx, bt + 2, 1, 1, shade(r.top, 0.30)); px(rx, bt + bh - 3, 1, 1, r.ao); }
    // recessed cork well: y-8 .. y+6, with a marker tray shelf under it
    inset(x + 2, bt + 2, w - 4, 15, '#131a15');
    px(x + 3, bt + 3, w - 6, 13, '#182219');                                  // cork ground, warmer than the frame
    wear(x + 3, bt + 3, w - 6, 13, 6, '#1f2a20');                             // old pin holes
    px(x + 2, bt + 17, w - 4, 1, r.ao);
    px(x + 3, bt + 18, w - 6, 2, shade(r.face, 0.08));                      // marker tray
    px(x + 3, bt + 18, w - 6, 1, r.lit); keyEdge(x + 4, bt + 18, w - 9, 1, 0.13);
    px(x + 5, bt + 19, 5, 1, '#b8452e'); px(x + 12, bt + 19, 4, 1, '#caa84a');// a marker + a chalk stub in the tray
    // PHOSPHOR HEADER — the terminal face names the surface and prints the open count as a number, so the
    // board is readable even when the card rail is full (VT323, the canvas text law)
    const hc = pins > 0 ? '#7df0c8' : '#2e5a4a';
    px(x + 3, bt + 3, w - 6, 6, '#0d1712');
    px(x + 3, bt + 3, w - 6, 1, '#16261e');
    ctx.fillStyle = hc;
    ctx.font = "7px 'VT323','Courier New',monospace"; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    // "OPEN", not "MISSIONS": at 3 tiles the board is 36px and a 7px VT323 "MISSIONS" runs ~28px,
    // so the right-aligned count landed ON TOP of it. The short word leaves the number its own space.
    ctx.fillText('OPEN', x + 5, bt + 8);
    ctx.textAlign = 'right'; ctx.fillText(String(pins), x + w - 5, bt + 8);
    if (pins > 0) {
      bloom(x + 4, bt + 4, w - 8, 4, '#41ffbe', 0.12);                        // panel bloom with real falloff
      spill(x + 3, bt + 9, w - 6, '#41ffbe', 0.13, 4);                        // header light pools onto the cork
      if (blink(600, ph)) px(x + w - 4, bt + 4, 1, 1, '#c7ffe8');             // live cursor tick
    }
    scanl(x + 3, bt + 3, w - 6, 6, 0.20);
    // PINNED CARDS — one per open quest at an even 6px pitch. 5 fit; past that 4 cards + a '+N' slot, so
    // the rail never crowds into an uncountable smear.
    const cap = pins > 5 ? 4 : 5, shown = Math.min(pins, cap);
    for (let i = 0; i < shown; i++) {
      const cx = x + 3 + i * 6, tilt = U.hash('mb' + i) % 2;                  // hash-phased hang: paper, not tiles
      const cy = bt + 11 + tilt;
      px(cx, cy + 1, 5, 6, '#0a0e0c');                                        // drop shadow off the cork
      px(cx, cy, 5, 6, '#aab6a4');
      px(cx, cy, 5, 1, '#d6e0cc'); keyEdge(cx, cy, 4, 1, 0.30);               // warm key along the paper's top
      px(cx + 4, cy + 1, 1, 5, '#7d8a78'); rimEdge(cx + 4, cy + 1, 1, 5, 0.16);
      px(cx + 1, cy + 2, 3, 1, '#59654f'); px(cx + 1, cy + 4, 2, 1, '#59654f');   // scrawled brief
      px(cx + 2, cy - 1, 1, 2, '#ffaa33');                                    // the pin
      bloom(cx + 2, cy - 1, 1, 1, '#ffaa33', 0.20);
    }
    if (pins > cap) {
      ctx.fillStyle = '#ffd9a3'; ctx.font = "8px 'VT323','Courier New',monospace";
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('+' + (pins - cap), x + 3 + cap * 6 + 1, bt + 16);
    }
    if (pins === 0) {                                                         // honest empty cork — nothing claimed
      px(x + 6, bt + 12, w - 12, 1, '#202b21'); px(x + 6, bt + 14, w - 18, 1, '#1c2620');
      px(x + w - 7, bt + 12, 1, 1, blink(2200, ph) ? '#3a4a3e' : '#222d24');  // one bare pin left in the board
    }
    // BEACON: a station-gap quest is OPEN — the frame breathes gold. Slow and gentle: a state, not an event.
    if (f && f.hot) {
      const b = 0.09 + 0.07 * (0.5 + 0.5 * Math.sin(now / 420));
      bloom(x, bt, w, bh, '#e8c860', b);
      px(x + 3, bt + 1, 1, 1, blink(840, 0.5) ? '#ffd75e' : '#3a3020');       // standing-order lamp on the frame
    }
    // PROPOSAL STATE: pending autojob requisitions the agent pinned itself — amber folded-corner cards
    // fanned over the board's top-left, distinct from the grey quest pins and the red-pinned jam stub.
    if (f && f.proposals > 0) {
      const np = f.proposals | 0, showP = Math.min(np, 3);
      bloom(x + 1, bt - 3, 16, 9, '#ffc24a', 0.08 + 0.06 * (0.5 + 0.5 * Math.sin(now / 500)));
      for (let i = 0; i < showP; i++) {
        const px0 = x + 4 + i * 3, py0 = bt - 3 + i;
        px(px0, py0 + 1, 6, 5, '#0a0e0c');
        px(px0, py0, 6, 5, '#f0b84a');
        px(px0, py0, 6, 1, '#ffdc8a'); keyEdge(px0, py0, 5, 1, 0.22);
        px(px0 + 4, py0, 2, 2, '#c98f2e');                                    // folded corner = requisition
        px(px0 + 1, py0 + 2, 3, 1, '#7a5a20'); px(px0 + 1, py0 + 3, 2, 1, '#7a5a20');
        px(px0 + 2, py0 - 1, 1, 1, '#ff7a3a');                                // orange pin head
      }
      if (np > 3) {
        ctx.fillStyle = '#ffd9a3'; ctx.font = "7px 'VT323','Courier New',monospace";
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText('+' + (np - 3), x + 4 + showP * 3 + 6, bt + 2);
      }
    }
    // JAM STATE: a routine is backed up (repeatedly skipped). An amber stub pinned red over the top-right
    // + a faster amber wash — amber = "the line is jammed". Clears when the routine drains.
    if (f && f.jam) {
      const jb = 0.12 + 0.09 * (0.5 + 0.5 * Math.sin(now / 260));
      bloom(x + w - 10, bt - 2, 9, 10, '#ffae3a', jb);
      const sx = x + w - 8, sy = bt - 2;
      px(sx, sy + 1, 5, 6, '#0a0e0c');
      px(sx, sy, 5, 6, '#f0a83a');
      px(sx, sy, 5, 1, '#ffd07a'); keyEdge(sx, sy, 4, 1, 0.24);
      px(sx + 2, sy + 1, 1, 3, '#3a2410');
      px(sx + 2, sy + 4, 1, 1, blink(200) ? '#3a2410' : '#f0a83a');           // blinking "!" glyph
      px(sx + 2, sy - 1, 1, 2, '#ff5a4a');                                    // red jam pin
    }
  };

  F.trophycase = (x, y, w, h, f) => {
    // TROPHY CASE (2x2) — v4 REBUILD. Also predated the style law (flat box + inset). Now TALL 3/4: a
    // chamfered museum cabinet on a plinth, rising ~5px above its footprint, with a cold uplight washing
    // UP the glass and a warm key on its crown — the two-temperature split is what makes it read as glass
    // rather than a hole. f.trophies = REAL earned milestones, one gold cup each on an evenly-pitched
    // shelf so they stay countable; 6 visible + '+N'. EMPTY = honest dust, never a placeholder trophy.
    const won = Math.max(0, (f && f.trophies) | 0), lit = won > 0;
    const r = RAMP.steel, top = y - 5, plY = y + h - 7;
    shadow2(x + 1, y + h - 1, w - 2);                                        // floor contact
    // heavy plinth the case stands on — walnut/iron, chamfered, with a recessed toe kick
    chamf(x - 1, plY - 1, w + 2, 8, LINE, 2);
    chamf(x, plY, w, 6, '#241d15', 2);
    px(x + 1, plY, w - 2, 1, '#3d3122'); keyEdge(x + 1, plY, 7, 1, 0.20);
    px(x, plY + 2, 1, 3, '#3a2f22'); px(x + w - 1, plY + 2, 1, 3, '#120d08');
    rimEdge(x + w - 1, plY + 2, 1, 3, 0.18);
    px(x + 2, y + h - 2, w - 4, 1, '#0a0806');                               // toe-kick AO
    // cabinet carcass: dark chamfered frame, top cap we look down onto
    chamf(x - 1, top - 1, w + 2, (plY - top) + 2, LINE, 2);
    chamf(x, top, w, plY - top, '#1c1712', 2);
    chamf(x + 1, top + 1, w - 2, 3, '#2b231a', 2);                           // crown cap
    px(x + 2, top + 1, w - 4, 1, '#463a29'); keyEdge(x + 2, top + 1, 7, 1, 0.30);
    // COMMANDER JOURNEY CROWN — a permanent physical transformation, not an unlock. Each stage means one
    // distinct goal id whose final goal-arc milestone was verified. Four cells fill first; later goals deepen
    // the crown's halo in four-goal waves so long-lived stations keep changing instead of hitting a dead cap.
    const js = Math.max(0, (f && f.journeyStage) | 0), journeyShown = Math.min(4, js);
    const wave = js > 4 ? Math.floor((js - 1) / 4) : 0, waveFill = js > 4 ? ((js - 1) % 4) + 1 : 0;
    for (let i = 0; i < 4; i++) {
      const bx = x + 3 + i * 4, on = i < journeyShown, deep = wave > 0 && i < waveFill;
      px(bx, top - 1, 2, 2, on ? '#e8c860' : '#20252a');
      if (on) { px(bx, top - 1, 1, 1, deep ? '#ffffff' : '#fff0a6'); bloom(bx, top - 1, 2, 2, '#e8c860', 0.18 + Math.min(.24, wave * .06) + (deep ? .08 : 0)); }
    }
    px(x + 2, top + 4, w - 4, 1, '#0f0b07');                                 // cap front lip
    px(x, top + 3, 1, plY - top - 4, '#2e2519'); px(x + w - 1, top + 3, 1, plY - top - 4, '#0f0b07');
    rimEdge(x + w - 1, top + 3, 1, plY - top - 4, 0.20);
    rivets(x + 1, top + 5, w - 2, plY - top - 6, '#5a4a34', '#0a0806');      // corner bolts
    // the glass interior
    const gx = x + 2, gy = top + 5, gw = w - 4, gh = plY - gy - 1;
    inset(gx, gy, gw, gh, '#0b0d0e');
    px(gx + 1, gy + 1, gw - 2, 1, '#141a1e');                                // back wall catches a little light
    // eerie museum UPLIGHT — a cold wash climbing the glass off a strip in the plinth (falloff, not a sticker)
    const up = 0.13 + 0.05 * (0.5 + 0.5 * Math.sin(now / 900));
    px(gx + 1, gy + gh - 2, gw - 2, 1, lit ? '#5d7f96' : '#243138');         // the strip itself
    bloom(gx + 1, gy + gh - 3, gw - 2, 2, lit ? '#c9e6ff' : '#4a5f6e', up);
    // two shelves, 3 trophies each — fixed 6px pitch keeps the row countable at a glance
    const shelfY = [gy + 1, gy + 9];
    const shown = Math.min(won, 6);
    for (let s = 0; s < 2; s++) {
      const sy = shelfY[s];
      px(gx + 1, sy + 6, gw - 2, 1, '#2e2415');                              // shelf plank
      px(gx + 1, sy + 7, gw - 2, 1, '#100c08');                              // plank underside
      const nOn = Math.max(0, Math.min(3, shown - s * 3));
      for (let i = 0; i < 3; i++) {
        const tx = gx + 2 + i * 6, on = i < nOn;
        if (on) {
          const gc = '#f3c94a', gd = '#a8842a';
          px(tx + 1, sy + 1, 3, 2, gc);                                      // cup
          px(tx, sy + 1, 1, 1, gd); px(tx + 4, sy + 1, 1, 1, gd);            // handles
          px(tx + 1, sy + 1, 1, 2, shade(gc, 0.30));                       // lit west flank
          px(tx + 3, sy + 1, 1, 2, gd);                                      // shaded east flank
          px(tx + 2, sy + 3, 1, 2, gd);                                      // stem
          px(tx + 1, sy + 5, 3, 1, gc); px(tx + 1, sy + 5, 3, 1, shade(gc, -0.10));
          px(tx + 1, sy + 6, 3, 1, '#1a1206');                               // contact shade on the plank
          if (blink(1100, (i + s) * 0.3)) px(tx + 2, sy + 1, 1, 1, shade(gc, 0.40)); // slow glint, not a white speck
          bloom(tx + 1, sy + 1, 3, 2, gc, 0.16);
        } else if (won === 0 && s === 0 && i === 1 && blink(1700, 0)) {
          px(tx + 2, sy + 3, 1, 1, '#2a3138');                               // one dust mote: nothing earned yet
        }
      }
    }
    if (won > 6) {
      ctx.fillStyle = '#ffe6a0'; ctx.font = "8px 'VT323','Courier New',monospace";
      ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('+' + (won - 6), gx + gw - 1, gy + 7);
    }
    // engraved plaque on the plinth — phosphor-gold when won, cold-dim when the case is honestly empty
    px(x + 3, plY + 1, w - 6, 4, '#100c08');
    px(x + 3, plY + 1, w - 6, 1, '#2c2318');
    ctx.fillStyle = lit ? '#e8c860' : '#3e4650';
    ctx.font = "6px 'VT323','Courier New',monospace"; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(lit ? 'HONOURS' : 'EMPTY', x + 4, plY + 5);
    // glass: a soft diagonal sheen + a hard corner catch, so the front reads as a pane, not an open shelf
    ctx.save(); ctx.globalAlpha = 0.07; ctx.fillStyle = '#dff0ff';
    ctx.beginPath(); ctx.moveTo(gx + 1, gy + 1); ctx.lineTo(gx + 1 + (gw >> 1), gy + 1);
    ctx.lineTo(gx + 1, gy + 1 + (gh >> 1)); ctx.closePath(); ctx.fill();
    ctx.restore();
    rimEdge(gx, gy, 1, gh, 0.22);                                            // cold pane edge, west
    px(gx + gw - 1, gy + gh - 4, 1, 3, '#1b232a');
  };

  F.splitter = (x, y, w, h, f) => {
    // SPLITTER (1x1) — fans ONE stream across its lanes (load-balance = real parallelism). At 12px detail is
    // noise, so it gets a FORKED outline (two nozzles off the east face) and exactly one emissive idea: a
    // packet rides in on the trunk and leaves by alternating branches. One in, two out — that is the whole read.
    const r = RAMP.steel, on = !!(f && f.work), c = '#5ad1b3', ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const ny of [y + 2, y + 6]) {                          // the silhouette itself forks
      px(x + w - 1, ny - 1, 3, 4, LINE);
      px(x + w, ny, 2, 2, r.face); px(x + w, ny, 2, 1, r.lit);
    }
    chamf(x - 1, y + 5, w + 2, 6, LINE, 1);                     // low bolted body: short south face
    chamf(x, y + 6, w, 4, r.face, 1);
    px(x + 1, y + 6, w - 2, 1, r.lit); keyEdge(x + 2, y + 6, 5, 1, 0.16);
    px(x + 1, y + 9, w - 2, 1, r.ao);
    px(x + 2, y + 8, 1, 1, '#caa84a'); px(x + w - 3, y + 8, 1, 1, '#caa84a');   // deck-bolt hazard ticks
    chamf(x - 1, y, w + 2, 7, LINE, 1);                         // lit top
    chamf(x, y + 1, w, 5, r.top, 1);
    px(x + 1, y + 1, w - 2, 1, r.sheen); keyEdge(x + 1, y + 1, 4, 1, 0.26);
    px(x, y + 2, 1, 3, r.lit); px(x + w - 1, y + 2, 1, 3, r.dk); rimEdge(x + w - 1, y + 2, 1, 3, 0.20);
    px(x + 1, y + 5, w - 2, 1, shade(r.top, -0.18));
    // recessed lane well — casing stays steel, the identity is the light in the channel
    px(x + 1, y + 2, w - 2, 3, '#101a1e'); px(x + 1, y + 2, w - 2, 1, '#0a1216');
    const dim = shade(c, -0.55), lc = on ? shade(c, 0.22) : shade(c, -0.12);
    px(x + 1, y + 3, 5, 1, dim);                                // trunk in
    px(x + 6, y + 2, 5, 1, dim); px(x + 6, y + 4, 5, 1, dim);   // the two branches
    px(x + 6, y + 3, 1, 1, lc);                                 // split node
    // the one moving idea: a packet in on the trunk, out by alternating branch
    const per = on ? 620 : 1100, t = (now % per) / per, alt = Math.floor(now / per) % 2;
    const pxp = t < 0.5 ? x + 1 + Math.floor(t * 10) : x + 6 + Math.floor((t - 0.5) * 10);
    const pyp = t < 0.5 ? y + 3 : (alt ? y + 4 : y + 2);
    px(pxp, pyp, 2, 1, '#c8f4e6'); bloom(pxp, pyp, 2, 1, c, on ? 0.40 : 0.24);
    px(x + w, y + 2, 2, 1, alt ? dim : lc); px(x + w, y + 6, 2, 1, alt ? lc : dim);   // nozzle tips
    px(x + 2, y + 7, 1, 1, blink(360, ph) ? '#7df0c8' : shade(c, -0.55));           // routing LED
    if (on) glow(x, y + 1, w, 5, c, 0.10);
  };

  F.filter = (x, y, w, h, f) => {
    // FILTER (1x1) — the content router: reads a box's tag and sends it down a chosen lane. The only router
    // with HEIGHT: a sorting CARTRIDGE standing on the deck box, so the three junctions are told apart by
    // outline alone at 12px. One emissive idea: the cartridge window shows the route it just picked, and the
    // matching out-lane tip lights the same colour (cyan code / amber research / neutral default).
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    const ROUTE = [ACC.data, ACC.flow, '#8a9a90'], sel = Math.floor(now / (on ? 800 : 1400)) % 3, rc = ROUTE[sel];
    shadow2(x + 1, y + h - 1, w - 2);
    chamf(x - 1, y + 5, w + 2, 6, LINE, 1);
    chamf(x, y + 6, w, 4, r.face, 1);
    px(x + 1, y + 6, w - 2, 1, r.lit); keyEdge(x + 2, y + 6, 5, 1, 0.16);
    px(x + 1, y + 9, w - 2, 1, r.ao);
    px(x + 2, y + 8, 1, 1, '#caa84a'); px(x + w - 3, y + 8, 1, 1, '#caa84a');
    chamf(x - 1, y, w + 2, 7, LINE, 1);
    chamf(x, y + 1, w, 5, r.top, 1);
    px(x + 1, y + 1, w - 2, 1, r.sheen); keyEdge(x + 1, y + 1, 3, 1, 0.26);
    px(x, y + 2, 1, 3, r.lit); px(x + w - 1, y + 2, 1, 3, r.dk); rimEdge(x + w - 1, y + 2, 1, 3, 0.20);
    px(x + 1, y + 5, w - 2, 1, shade(r.top, -0.18));
    px(x + 1, y + 2, w - 2, 3, '#161020'); px(x + 1, y + 2, w - 2, 1, '#0e0a16');   // violet lane well
    px(x + 1, y + 3, 4, 1, on ? shade(ACC.mem, 0.20) : shade(ACC.mem, -0.20));  // unsorted trunk IN
    px(x + 8, y + 3, 3, 1, shade(rc, -0.15));                                     // sorted lane OUT
    for (let i = 0; i < 3; i++) {                                                   // three route tips, one lit
      const ty = y + 2 + i;
      px(x + w - 2, ty, 2, 1, i === sel ? ROUTE[i] : shade(ROUTE[i], -0.62));
      if (i === sel) bloom(x + w - 2, ty, 2, 1, ROUTE[i], on ? 0.34 : 0.20);
    }
    const pk = (now % 700) / 700;                               // a box riding in to be read
    px(x + 1 + Math.floor(pk * 4), y + 3, 1, 1, '#d8b8ff');
    // SORTING CARTRIDGE — the silhouette that names it; collar ties it to the box so it can't float
    const dx0 = x + 3, dt = y - 7;
    px(x + 2, y, 8, 2, LINE); px(x + 3, y, 6, 1, shade(r.top, 0.10)); px(x + 3, y + 1, 6, 1, r.ao); // collar
    chamf(dx0 - 1, dt - 1, 8, 10, LINE, 2);
    chamf(dx0, dt, 6, 8, r.face, 2);
    px(dx0 + 1, dt, 4, 1, r.top); keyEdge(dx0 + 1, dt, 3, 1, 0.28);
    px(dx0, dt + 2, 1, 5, r.lit); px(dx0 + 5, dt + 2, 1, 5, r.dk); rimEdge(dx0 + 5, dt + 2, 1, 5, 0.20);
    px(dx0, dt + 1, 6, 1, shade(r.face, -0.36)); px(dx0, dt + 7, 6, 1, shade(r.face, -0.36)); // clamp bands
    px(dx0 + 1, dt + 3, 4, 3, '#140b1c');                       // sight window
    px(dx0 + 1, dt + 4, 4, 1, shade(rc, on ? 0.10 : -0.30));  // the route it just picked
    px(dx0 + 1 + (Math.floor(now / 190) % 4), dt + 3, 1, 1, shade(ACC.mem, 0.35)); // tag-read scan
    bloom(dx0 + 1, dt + 3, 4, 3, ACC.mem, on ? 0.26 : 0.13);    // violet halo = "this is the filter"
    px(dx0 + 4, dt + 6, 1, 1, blink(420, ph) ? '#d8b8ff' : shade(ACC.mem, -0.5)); // sorting LED
  };

  F.merger = (x, y, w, h, f) => {
    // MERGER (1x1) — a LANE FUNNEL: several lanes converge into one, every crate rides straight on
    // (the buffer-K/map-reduce mechanic was removed 2026-07-26 — see conveyor.js chooseExit).
    // The exact silhouette INVERSE of the splitter: two horns on the west, one fat outlet east.
    const r = RAMP.steel, on = !!(f && f.work), c = '#e0a45a', ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const ny of [y + 2, y + 6]) {                          // twin intake horns, west
      px(x - 2, ny - 1, 3, 4, LINE);
      px(x - 2, ny, 2, 2, r.face); px(x - 2, ny, 2, 1, r.lit);
    }
    px(x + w - 1, y + 2, 3, 5, LINE);                           // one FAT outlet, east
    px(x + w, y + 3, 2, 3, r.face); px(x + w, y + 3, 2, 1, r.lit);
    chamf(x - 1, y + 5, w + 2, 6, LINE, 1);
    chamf(x, y + 6, w, 4, r.face, 1);
    px(x + 1, y + 6, w - 2, 1, r.lit); keyEdge(x + 2, y + 6, 5, 1, 0.16);
    px(x + 1, y + 9, w - 2, 1, r.ao);
    px(x + 2, y + 8, 1, 1, '#caa84a'); px(x + w - 3, y + 8, 1, 1, '#caa84a');
    chamf(x - 1, y, w + 2, 7, LINE, 1);
    chamf(x, y + 1, w, 5, r.top, 1);
    px(x + 1, y + 1, w - 2, 1, r.sheen); keyEdge(x + 1, y + 1, 4, 1, 0.26);
    px(x, y + 2, 1, 3, r.lit); px(x + w - 1, y + 2, 1, 3, r.dk); rimEdge(x + w - 1, y + 2, 1, 3, 0.20);
    px(x + 1, y + 5, w - 2, 1, shade(r.top, -0.18));
    px(x + 1, y + 2, w - 2, 3, '#1c150e'); px(x + 1, y + 2, w - 2, 1, '#120e08');   // lane well
    const dim = shade(c, -0.55), lc = on ? shade(c, 0.22) : shade(c, -0.12);
    px(x + 1, y + 2, 5, 1, dim); px(x + 1, y + 4, 5, 1, dim);   // two inputs converging
    px(x + 5, y + 3, 1, 1, lc);                                 // the join node
    px(x + 6, y + 3, 5, 1, dim);                                // combined out lane
    const per = on ? 900 : 1500, t = (now % per) / per;
    if (t < 0.55) {                                             // both inputs ride in...
      const p = x + 1 + Math.floor((t / 0.55) * 4);
      px(p, y + 2, 1, 1, '#ffd488'); px(p, y + 4, 1, 1, '#ffd488');
      bloom(p, y + 2, 1, 1, c, 0.26); bloom(p, y + 4, 1, 1, c, 0.26);
      px(x + 5, y + 3, 1, 1, shade(c, -0.2 + 0.4 * (t / 0.55)));   // buffer filling
    } else {                                                    // ...and ONE fatter box leaves
      const p = x + 5 + Math.floor(((t - 0.55) / 0.45) * 6);
      px(p, y + 3, 2, 1, '#ffd488'); bloom(p, y + 3, 2, 1, c, on ? 0.40 : 0.26);
    }
    px(x + w, y + 4, 2, 1, t < 0.55 ? dim : lc);                // outlet tip
    px(x + 2, y + 7, 1, 1, blink(520, ph) ? '#ffd488' : shade(c, -0.5));   // buffer LED
    if (on) glow(x, y + 1, w, 5, c, 0.10);
  };

  F.joiner = (x, y, w, h, f) => {
    // JOINER (1x1, 2026-08-21) — the real fan-in BARRIER: one crate per in-lane is HELD until every branch of
    // a run has arrived, then ONE merged crate leaves. Rebuilt from the merger's deck box (same steel, same
    // horns-west/outlet-east silhouette) with the one idea the merger lacks: a LATCH BAR across the well —
    // the two inputs pile up BEHIND it, both lamps fill, the bar drops, and a single fat crate leaves.
    const r = RAMP.steel, on = !!(f && f.work), c = '#ff8a4a', ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const ny of [y + 2, y + 6]) {                          // twin intake horns, west (the merger's)
      px(x - 2, ny - 1, 3, 4, LINE);
      px(x - 2, ny, 2, 2, r.face); px(x - 2, ny, 2, 1, r.lit);
    }
    px(x + w - 1, y + 2, 3, 5, LINE);                           // one FAT outlet, east
    px(x + w, y + 3, 2, 3, r.face); px(x + w, y + 3, 2, 1, r.lit);
    chamf(x - 1, y + 5, w + 2, 6, LINE, 1);
    chamf(x, y + 6, w, 4, r.face, 1);
    px(x + 1, y + 6, w - 2, 1, r.lit); keyEdge(x + 2, y + 6, 5, 1, 0.16);
    px(x + 1, y + 9, w - 2, 1, r.ao);
    px(x + 2, y + 8, 1, 1, '#caa84a'); px(x + w - 3, y + 8, 1, 1, '#caa84a');
    chamf(x - 1, y, w + 2, 7, LINE, 1);
    chamf(x, y + 1, w, 5, r.top, 1);
    px(x + 1, y + 1, w - 2, 1, r.sheen); keyEdge(x + 1, y + 1, 4, 1, 0.26);
    px(x, y + 2, 1, 3, r.lit); px(x + w - 1, y + 2, 1, 3, r.dk); rimEdge(x + w - 1, y + 2, 1, 3, 0.20);
    px(x + 1, y + 5, w - 2, 1, shade(r.top, -0.18));
    px(x + 1, y + 2, w - 2, 3, '#1e120c'); px(x + 1, y + 2, w - 2, 1, '#140c08');   // lane well, ember-dark
    const dim = shade(c, -0.55), lc = on ? shade(c, 0.22) : shade(c, -0.12);
    px(x + 1, y + 2, 5, 1, dim); px(x + 1, y + 4, 5, 1, dim);   // two inputs
    px(x + 7, y + 3, 4, 1, dim);                                // the single out lane
    const per = on ? 1300 : 2200, t = (now % per) / per;
    const held = t < 0.7;                                       // the barrier phase: both crates wait at the bar
    px(x + 6, y + 2, 1, 3, held ? lc : shade(c, -0.35));      // THE LATCH BAR — lit while holding, dark when dropped
    if (held) {
      const a = Math.min(1, t / 0.35), p1 = x + 1 + Math.floor(a * 4);   // crate 1 arrives first...
      px(p1, y + 2, 1, 1, '#ffc9a0'); bloom(p1, y + 2, 1, 1, c, 0.24);
      if (t > 0.3) { const b = Math.min(1, (t - 0.3) / 0.35), p2 = x + 1 + Math.floor(b * 4);   // ...crate 2 later
        px(p2, y + 4, 1, 1, '#ffc9a0'); bloom(p2, y + 4, 1, 1, c, 0.24); }
    } else {                                                    // bar down: ONE fat crate leaves
      const p = x + 7 + Math.floor(((t - 0.7) / 0.3) * 4);
      px(p, y + 3, 2, 1, '#ffc9a0'); bloom(p, y + 3, 2, 1, c, on ? 0.42 : 0.26);
    }
    px(x + w, y + 4, 2, 1, held ? dim : lc);                    // outlet tip
    px(x + 2, y + 7, 1, 1, held && blink(300, ph) ? '#ffc9a0' : shade(c, -0.5));   // WAITING lamp blinks while held
    if (on) glow(x, y + 1, w, 5, c, 0.10);
  };

  F.loop = (x, y, w, h, f) => {
    // LOOP gate (1x1, 2026-08-21) — the one legal way round: a crate re-enters the line upstream on the back
    // lane until its pass count hits the cap, then leaves on the done lane. Rebuilt from the splitter's deck
    // box (one in, two out — a gate IS a fork) with the filter's height trick: a COUNTER PILLAR standing on
    // the box whose tally lamps fill one per pass, so "how many times round" is readable from across the room.
    const r = RAMP.steel, on = !!(f && f.work), c = ACC.data, ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    px(x + w - 1, y + 1, 3, 3, LINE); px(x + w, y + 2, 2, 1, r.face);      // done nozzle, east-high
    px(x + w - 1, y + 5, 3, 3, LINE); px(x + w, y + 6, 2, 1, r.face);      // back nozzle, east-low (the return)
    chamf(x - 1, y + 5, w + 2, 6, LINE, 1);
    chamf(x, y + 6, w, 4, r.face, 1);
    px(x + 1, y + 6, w - 2, 1, r.lit); keyEdge(x + 2, y + 6, 5, 1, 0.16);
    px(x + 1, y + 9, w - 2, 1, r.ao);
    px(x + 2, y + 8, 1, 1, '#caa84a'); px(x + w - 3, y + 8, 1, 1, '#caa84a');
    chamf(x - 1, y, w + 2, 7, LINE, 1);
    chamf(x, y + 1, w, 5, r.top, 1);
    px(x + 1, y + 1, w - 2, 1, r.sheen); keyEdge(x + 1, y + 1, 4, 1, 0.26);
    px(x, y + 2, 1, 3, r.lit); px(x + w - 1, y + 2, 1, 3, r.dk); rimEdge(x + w - 1, y + 2, 1, 3, 0.20);
    px(x + 1, y + 5, w - 2, 1, shade(r.top, -0.18));
    px(x + 1, y + 2, w - 2, 3, '#0c1a20'); px(x + 1, y + 2, w - 2, 1, '#08121a');   // cold lane well
    const dim = shade(c, -0.55), lc = on ? shade(c, 0.22) : shade(c, -0.12);
    px(x + 1, y + 3, 5, 1, dim);                                // trunk in
    px(x + 6, y + 2, 5, 1, dim); px(x + 6, y + 4, 5, 1, dim);   // done (high) and back (low)
    px(x + 6, y + 3, 1, 1, lc);                                 // the gate node
    // the moving idea: a packet rides in, takes the BACK lane N times, then the DONE lane once
    const per = on ? 640 : 1100, pass = Math.floor(now / per) % 4, t = (now % per) / per, last = pass === 3;
    const pxp = t < 0.5 ? x + 1 + Math.floor(t * 10) : x + 6 + Math.floor((t - 0.5) * 10);
    const pyp = t < 0.5 ? y + 3 : (last ? y + 2 : y + 4);
    px(pxp, pyp, 2, 1, '#bfefff'); bloom(pxp, pyp, 2, 1, c, on ? 0.40 : 0.24);
    px(x + w, y + 2, 2, 1, last && t >= 0.5 ? lc : dim); px(x + w, y + 6, 2, 1, !last && t >= 0.5 ? lc : dim);   // nozzle tips
    // COUNTER PILLAR — the silhouette that names it; collar ties it to the box so it can't float
    const dx0 = x + 3, dt = y - 6;
    px(x + 2, y, 8, 2, LINE); px(x + 3, y, 6, 1, shade(r.top, 0.10)); px(x + 3, y + 1, 6, 1, r.ao);   // collar
    chamf(dx0 - 1, dt - 1, 8, 9, LINE, 2);
    chamf(dx0, dt, 6, 7, r.face, 2);
    px(dx0 + 1, dt, 4, 1, r.top); keyEdge(dx0 + 1, dt, 3, 1, 0.28);
    px(dx0, dt + 2, 1, 4, r.lit); px(dx0 + 5, dt + 2, 1, 4, r.dk); rimEdge(dx0 + 5, dt + 2, 1, 4, 0.20);
    px(dx0 + 1, dt + 2, 4, 4, '#08141a');                       // tally window
    for (let i = 0; i < 4; i++) px(dx0 + 1 + i, dt + 4, 1, 1, i <= pass ? (i === 3 ? '#bfefff' : c) : shade(c, -0.62));   // one lamp per pass
    px(dx0 + 1 + pass, dt + 3, 1, 1, blink(260, ph) ? '#bfefff' : shade(c, -0.3));   // the pass in progress
    bloom(dx0 + 1, dt + 2, 4, 4, c, on ? 0.24 : 0.12);
  };

  F.bay = (x, y, w, h, f) => {
    /* v71 BAY (2x2) — upgrade pass. Anatomy unchanged: a berth between two hazard-banded GUIDE ARMS
       carrying a gantry NAMEPLATE, so the dock reads as a berth from across the room and the bound
       agent's name sits at eye level instead of being stencilled flat on the floor.
       ⛔ MATERIAL. MAT.steel instead of RAMP.steel — this is the prop a player looks at most, and it was
          the flattest of the three for the same reason: the old ramp's brightest stop is luma 110.
       ⛔ THE ARMS NEED FEET. A post that meets the pad with no flange floats; a 5px base plate with its
          own AO is what bolts it down, and it costs two rows.
       ⛔ THE PLATE IS A BEZEL. Corner bolts and a recessed screen well, so the name reads as displayed
          rather than painted on.
       ⛔ NAMEPLATE LIT = BOUND, DIM BARS = UNASSIGNED. That is the honesty contract of this prop and it
          is untouched: f.dockName is resolved LIVE by the caller from bodies/roster and never stored on
          the prop doc, so a rename repaints next frame. */
    const EDGE = '#141b21';
    const bound = !!(f && f.agentId), act = !!(f && f.work);
    const r = MAT.steel, c = bound ? '#5ad1b3' : '#3a464a';

    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 6, w + 2, 6);
    deckSocket(x + w + 1, y + h - 3, bound);
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + h - 5, 3, 3, EDGE); px(lx, y + h - 5, 1, 3, r.lit); px(lx + 1, y + h - 5, 1, 3, r.dk);
      rimEdge(lx + 2, y + h - 5, 1, 2, 0.16);
    }
    underAO(x + 5, y + h - 5, w - 10, 2);

    /* ---- SOUTH FACE of the pad ---- */
    chamf(x - 1, y + h - 11, w + 2, 7, EDGE, 2);
    chamf(x, y + h - 10, w, 5, r.face, 2);
    px(x + 1, y + h - 10, w - 2, 1, r.lit); keyEdge(x + 2, y + h - 10, w - 5, 1, 0.18);
    px(x + 1, y + h - 9, w - 2, 1, r.mid);
    px(x, y + h - 8, 1, 3, r.lit); px(x + w - 1, y + h - 8, 1, 3, r.dk);
    rimEdge(x + w - 1, y + h - 8, 1, 3, 0.20);
    px(x + 1, y + h - 6, w - 2, 1, r.ao);
    for (let i = 0; i < 4; i++) {                                  // vent slots, with a lit sill each
      px(x + 4 + i * 4, y + h - 8, 2, 1, r.ao); px(x + 4 + i * 4, y + h - 7, 2, 1, r.dk);
    }

    /* ---- THE BERTH PAD ---- */
    chamf(x - 1, y + h - 20, w + 2, 10, EDGE, 2);
    chamf(x, y + h - 19, w, 8, r.top, 2);
    px(x + 2, y + h - 19, w - 4, 1, r.sheen); keyEdge(x + 2, y + h - 19, 8, 1, 0.28);
    px(x + 2, y + h - 18, w - 4, 1, r.hi);
    px(x, y + h - 17, 1, 5, r.lit); px(x + w - 1, y + h - 17, 1, 5, r.dk);
    rimEdge(x + w - 1, y + h - 17, 1, 5, 0.20);
    px(x + 2, y + h - 12, w - 4, 1, r.ao);
    wear(x + 2, y + h - 17, w - 4, 4, 3, shade(r.top, -0.10));

    /* ---- PAINTED BERTH BOX + centre-in chevron: work berths HERE ---- */
    const bx0 = x + 5, by0 = y + h - 17, bw = w - 10, bh = 5;
    for (let i = 0; i < bw; i += 2) { px(bx0 + i, by0, 1, 1, '#caa84a'); px(bx0 + i, by0 + bh - 1, 1, 1, '#caa84a'); }
    for (let j = 0; j < bh; j += 2) { px(bx0, by0 + j, 1, 1, '#caa84a'); px(bx0 + bw - 1, by0 + j, 1, 1, '#caa84a'); }
    px(x + (w >> 1) - 2, by0 + 1, 5, 1, c); px(x + (w >> 1), by0 + 2, 1, 2, c);
    if (act) bloom(bx0, by0, bw, bh, c, 0.22 + 0.10 * Math.sin(now / 300));

    /* ---- GUIDE ARMS: hazard-banded posts on real base flanges, docking lamp at each head ---- */
    for (let s = 0; s < 2; s++) {
      const ax = s ? x + w - 5 : x + 1;
      px(ax - 2, y + 7, 8, 2, EDGE);                               // the base flange, bolting it down
      px(ax - 1, y + 7, 6, 1, r.mid); px(ax - 1, y + 8, 6, 1, r.dk);
      underAO(ax - 1, y + 8, 6, 1);
      px(ax - 1, y - 7, 6, 15, EDGE);
      px(ax, y - 6, 4, 13, r.face);
      px(ax, y - 6, 4, 1, r.sheen); keyEdge(ax, y - 6, 4, 1, 0.28);
      px(ax, y - 5, 1, 12, r.lit); px(ax + 3, y - 5, 1, 12, r.dk); rimEdge(ax + 3, y - 5, 1, 12, 0.18);
      for (let i = 0; i < 3; i++) {                                // hazard banding, with its own shading
        px(ax, y + 1 + i * 2, 4, 1, i % 2 ? '#caa84a' : shade(r.face, -0.42));
        if (i % 2) px(ax, y + 1 + i * 2, 2, 1, '#e6c86a');         // the band's own west highlight
      }
      px(ax + 1, y - 5, 2, 2, bound ? (blink(700, s) ? '#7df0c8' : shade(c, -0.5)) : '#2a2018');
      if (bound && blink(700, s)) bloom(ax + 1, y - 5, 2, 2, c, 0.30);
    }

    /* ---- GANTRY NAMEPLATE spanning the arms — ties the two posts into one silhouette ---- */
    px(x + 4, y - 4, w - 8, 10, EDGE);
    chamf(x + 5, y - 3, w - 10, 8, r.face, 1);
    px(x + 6, y - 3, w - 12, 1, r.sheen); keyEdge(x + 6, y - 3, 6, 1, 0.26);
    px(x + 6, y - 2, w - 12, 1, r.mid);
    px(x + 5, y + 4, w - 10, 1, r.ao);
    for (const bx of [x + 6, x + w - 7]) {                         // corner bolts on the bezel
      px(bx, y - 2, 1, 1, r.hi); px(bx, y + 3, 1, 1, r.dk);
    }
    inset(x + 7, y - 1, w - 14, 5, bound ? '#0e1c16' : '#101619');
    if (bound) {
      px(x + 8, y, w - 16, 1, '#1e3a2c');
      // The readable name is painted after room lighting by drawBayNames. Keep the
      // physical display lit here; baking tiny text into this sprite erased names.
      px(x + 8, y + 2, w - 16, 1, '#5ad1b3');
      bloom(x + 8, y, w - 16, 3, c, 0.10 + (act ? 0.10 : 0));
    } else {
      px(x + 9, y, w - 18, 1, '#2a3438'); px(x + 9, y + 2, w - 22, 1, '#232c30');   // dim UNASSIGNED bars
      px(x + w - 9, y + 3, 1, 1, blink(1500) ? '#ff9d2e' : '#33241a');              // waiting-for-an-agent amber
    }
  };

  // These audited idle sprites have only discrete lamp states. Retain their exact
  // art instead of submitting hundreds of unchanged paint commands per frame.
  // Working props and live overlays still paint normally; shadows need raw art.
  function cacheIdleArt(id, state) {
    const paint=F[id], frames=new Map();
    F[id]=(x,y,w,h,f)=>{
      if ((f && f.work) || buildingShadowSilhouette || !_ink.has(id) || typeof document === 'undefined' ||
          (document.fonts && document.fonts.status !== 'loaded')) return paint(x,y,w,h,f);
      const key=JSON.stringify([x,y,w,h,!!MIRROR,CHROMA,state(f||{})]);
      let image=frames.get(key);
      if (!image) {
        image=document.createElement('canvas');image.width=w+24;image.height=h+32;
        const g=image.getContext('2d');if(!g)return paint(x,y,w,h,f);
        const previous=ctx;
        try {ctx=g;g.imageSmoothingEnabled=false;g.translate(12-x,16-y);paint(x,y,w,h,f);}
        finally {ctx=previous;}
        if(frames.size>=256)frames.clear();
        frames.set(key,image);
        if(image.addEventListener)image.addEventListener('contextlost',()=>frames.delete(key),{once:true});
      }
      const smooth=ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled=false;
      try {ctx.drawImage(image,x-12,y-16);} finally {ctx.imageSmoothingEnabled=smooth;}
    };
  }
  cacheIdleArt('bay',f=>[f.agentId,f.dockName,blink(700),blink(1500)]);
  cacheIdleArt('desk',f=>blink(1600,f.x||0));
  cacheIdleArt('desk2',()=>0);
  cacheIdleArt('plant',()=>0);

  F.boxes = (x, y, w, h) => {
    // BOXES (2x1) — the same freight family as CRATE but in FIBREBOARD, not steel: no castings, no ribs,
    // no skids. Taped flap creases, paper labels and the fabric ramp carry the material read, and the
    // varied heights + 1px offsets keep the pile from stacking into one block.
    const cw = w, floorY = y + h - 1;
    // one carton: dominant lid (depth ld) over a short face (fh), base at fb
    const carton = (bx, fb, bw, fh, ld, ramp, tint) => {
      const ty = fb - fh - ld;
      rr(bx, ty + ld, bw, fh, LINE);                                   // short front face
      px(bx + 1, ty + ld + 1, bw - 2, fh - 2, ramp.face);
      px(bx + 1, ty + ld + 1, 1, fh - 2, ramp.lit);
      px(bx + bw - 2, ty + ld + 1, 1, fh - 2, ramp.dk);
      rimEdge(bx + bw - 2, ty + ld + 1, 1, fh - 2, 0.18);              // cool bounce on the shade side
      px(bx + 1, fb - 1, bw - 2, 1, ramp.ao);                          // floor-line AO
      px(bx + (bw >> 1), ty + ld + 1, 1, fh - 2, shade(ramp.face, 0.12));   // tape seam down the face
      px(bx + 2, ty + ld + 2, 3, 2, '#d8e0d6'); px(bx + 2, ty + ld + 2, 3, 1, '#eaf2e8');  // shipping label
      px(bx + 2, ty + ld + 3, 2, 1, '#96a696');                        // barcode
      px(bx + bw - 4, ty + ld + 2, 2, 1, tint);                        // priority sticker
      rr(bx - 1, ty, bw + 2, ld + 1, LINE);                            // DOMINANT lid
      px(bx, ty + 1, bw, ld, ramp.top);
      px(bx, ty + 1, bw, 1, ramp.sheen); keyEdge(bx, ty + 1, Math.max(2, bw - 5), 1, 0.26);
      px(bx, ty + 2, 1, ld - 1, ramp.lit); px(bx + bw - 1, ty + 2, 1, ld - 1, ramp.dk);
      px(bx + (bw >> 1), ty + 1, 1, ld, shade(ramp.top, -0.20));     // flap crease
      px(bx + 1, ty + 2, bw - 2, 1, shade(ramp.top, 0.06));          // cross-tape catch
      px(bx, ty + ld, bw, 1, shade(ramp.top, -0.16));                // lid front lip
      px(bx + bw - 5, ty + 1, 3, 1, tint);                             // cargo tag on the lid
    };
    shadow2(x + 1, floorY, cw - 2);
    carton(x + 1, floorY, 13, 4, 5, RAMP.steel, ACC.data);             // big front-left carton
    carton(x + 13, floorY - 1, 10, 3, 6, RAMP.fabric, ACC.flow);       // taller back-right one, nudged east
    // small carton perched on the left lid, offset a pixel so the pile leans
    const sx = x + 3, sb = floorY - 8;
    rr(sx, sb - 4, 7, 5, LINE);
    px(sx + 1, sb - 2, 5, 2, RAMP.fabric.face); px(sx + 1, sb - 2, 1, 2, RAMP.fabric.lit);
    rimEdge(sx + 5, sb - 2, 1, 2, 0.18);
    px(sx + 1, sb - 3, 5, 2, RAMP.fabric.top); px(sx + 1, sb - 3, 5, 1, RAMP.fabric.sheen);
    keyEdge(sx + 1, sb - 3, 3, 1, 0.26);
    px(sx + 4, sb - 3, 1, 2, shade(RAMP.fabric.top, -0.18));         // flap
    px(sx + 2, sb - 3, 1, 1, ACC.alert);                               // fragile dot
    px(sx + 1, sb, 5, 1, shade(RAMP.fabric.ao, 0.15));               // contact shade on the lid below
    px(x + cw - 6, floorY, 3, 1, shade(RAMP.steel.face, -0.22));     // floor scuff
  };


  F.djbooth = (x, y, w, h, f) => {
    /* v66 DJ BOOTH (4x2) — built to Andrew's reference (2026-08-16), read top to bottom:
         raised EQ HOUSING with a bar spectrum -> charcoal body -> two PLATTERS flanking a fader
         MIXER -> plum front fascia -> dark under-shelf on two corner legs.
       ⛔ THE EQ IS A SEPARATE BOX THAT STANDS PROUD. In the reference it is its own housing sitting
          ON the body with the body's shoulders visible either side — not a stripe painted on the top.
          That step is most of why the prop reads as equipment.
       ⛔ THE PLATTERS ARE NEARLY BLACK. Their only bright marks are a magenta rim arc, a spindle dot
          and one pale tonearm tick. A lit disc would out-shout the spectrum, which is the focal point.
       ⛔ THE FASCIA IS THE ONE PLUM PLANE. A single saturated band low on the prop carries the club
          colour without lifting the body's value. */
    const EDGE = '#161d22';
    const on = !!(f && f.work), ph = (f && f.x) || 0;
    const BODY = '#2f353c', BODY_D = '#1e242a', BODY_L = '#454d56';
    const WELL = '#1a1f25', PLUM = '#5a3160', PLUM_L = '#7d4584', PLUM_D = '#33193a';
    const MAG = '#d84bb4', CYA = '#3fc6e8', VIO = '#8a4bd8';
    const base = y + h, legT = base - 6, fasT = legT - 3, bodT = fasT - 13, eqT = bodT - 6;

    shadow2(x + 2, base - 1, w - 4);

    /* ---- UNDER-SHELF + TWO CORNER LEGS ---- */
    px(x + 6, legT, w - 12, 4, '#12161a');                              // the recess between the legs
    px(x + 6, legT, w - 12, 1, '#080b0e');
    for (const lx of [x + 2, x + w - 6]) {
      px(lx, legT, 4, 6, EDGE);
      px(lx, legT, 3, 5, '#232a31'); px(lx, legT, 1, 5, '#39424b');     // lit west face
      px(lx, base - 1, 4, 1, '#080b0e');
    }
    underAO(x + 6, legT - 1, w - 12, 2);

    /* ---- FRONT FASCIA: the one saturated plane on the prop ---- */
    px(x + 1, fasT, w - 2, 3, EDGE);
    px(x + 2, fasT, w - 4, 2, PLUM);
    px(x + 2, fasT, w - 4, 1, PLUM_L); keyEdge(x + 3, fasT, 12, 1, 0.22);
    px(x + 2, fasT + 2, w - 4, 1, PLUM_D);

    /* ---- BODY: chamfered charcoal box with a recessed console well ---- */
    chamf(x - 1, bodT - 1, w + 2, fasT - bodT + 1, EDGE, 2);
    chamf(x, bodT, w, fasT - bodT, BODY, 2);
    px(x + 1, bodT, w - 2, 1, BODY_L); keyEdge(x + 2, bodT, 12, 1, 0.24);
    px(x, bodT + 1, 1, 12, BODY_L); px(x + w - 1, bodT + 1, 1, 12, BODY_D);
    rimEdge(x + w - 1, bodT + 2, 1, 10, 0.18);
    chamf(x + 2, bodT + 2, w - 4, 10, EDGE, 1);                          // the well's shadowed lip
    chamf(x + 3, bodT + 3, w - 6, 9, WELL, 1);
    px(x + 3, bodT + 3, w - 6, 1, '#0e1216');                            // occlusion under the lip

    /* ---- TWO PLATTERS. Nine rows, near-black, one magenta arc each ---- */
    const disc = [[3, 3], [1, 7], [0, 9], [0, 9], [0, 9], [0, 9], [0, 9], [1, 7], [3, 3]];
    for (const p of [x + 5, x + w - 14]) {
      disc.forEach((s, j) => px(p + s[0], bodT + 3 + j, s[1], 1, '#0e0912'));
      disc.forEach((s, j) => { if (j > 0 && j < 8) px(p + s[0] + 1, bodT + 3 + j, s[1] - 2, 1, '#241a26'); });
      px(p + 2, bodT + 4, 5, 1, shade(MAG, -0.44));                    // rim arc, north-west
      px(p + 1, bodT + 5, 1, 3, shade(MAG, -0.52));
      px(p + 4, bodT + 7, 1, 1, on ? MAG : shade(MAG, -0.30));         // the spindle
      if (on) bloom(p + 4, bodT + 7, 1, 1, MAG, 0.22);
      px(p + 6, bodT + 9, 2, 1, '#8d97a0');                              // tonearm tick, south-east
      px(p + 7, bodT + 8, 1, 1, '#5d666e');
    }

    /* ---- MIXER: LED row over three faders ---- */
    const mx = x + Math.round(w / 2) - 6;
    px(mx, bodT + 3, 12, 9, '#141920');
    px(mx, bodT + 3, 12, 1, '#242c35');
    for (let i = 0; i < 4; i++)                                          // the LED row
      px(mx + 2 + i * 3, bodT + 4, 1, 1, on ? (i & 1 ? CYA : VIO) : shade(i & 1 ? CYA : VIO, -0.55));
    for (let i = 0; i < 3; i++) {                                        // three fader slots + caps
      const fx = mx + 3 + i * 3, cap = bodT + 6 + (i === 1 ? 2 : 0);
      px(fx, bodT + 6, 1, 5, '#0a0d11');
      px(fx - 1, cap, 3, 1, MAG); px(fx - 1, cap, 3, 1, i === 1 ? MAG : shade(MAG, 0.14));
      px(fx, cap + 1, 1, 1, shade(MAG, -0.44));
    }
    px(x + w - 7, bodT + 10, 1, 1, on ? MAG : shade(MAG, -0.55));      // the two corner telltales
    px(x + w - 5, bodT + 10, 1, 1, on ? CYA : shade(CYA, -0.55));

    /* ---- EQ HOUSING: its own box, standing proud, with the body's shoulders showing either side ---- */
    const ex = x + 9, ew = w - 18;
    chamf(ex - 1, eqT - 1, ew + 2, 8, EDGE, 1);
    px(ex, eqT, ew, 6, PLUM_D);
    px(ex, eqT, ew, 1, shade(PLUM, 0.10)); keyEdge(ex + 1, eqT, 7, 1, 0.20);
    px(ex + 1, eqT + 1, ew - 2, 4, '#190f20');                           // the dark well the bars stand in
    const HTS = [3, 2, 4, 1, 3, 2, 4, 2, 3], COL = [VIO, MAG, CYA, VIO, MAG, CYA, MAG, VIO, MAG];
    for (let i = 0; i < 9; i++) {
      const bh = on ? Math.max(1, HTS[i] + (Math.floor(now / 190 + i * 2) % 3) - 1) : Math.max(1, HTS[i] - 2);
      const bxx = ex + 2 + i * 3, c = COL[i];
      px(bxx, eqT + 5 - bh, 2, bh, on ? c : shade(c, -0.50));
      px(bxx, eqT + 5 - bh, 2, 1, on ? shade(c, 0.34) : shade(c, -0.34));
    }
    if (on) { bloom(ex + 1, eqT + 1, ew - 2, 4, MAG, 0.18); spill(ex + 1, eqT + 6, ew - 2, MAG, 0.12, 3); }
    px(ex + Math.round(ew / 2) - 1, eqT - 1, 2, 1, on ? MAG : shade(MAG, -0.50));   // the pilot tick on the crown
    if (on && blink(700, ph)) px(x + 4, bodT + 1, 1, 1, shade(CYA, 0.20));
  };

  F.speaker = (x, y, w, h, f) => {   // v4 lounge speaker (1x1) — chamfered cab, cloth grille, cone throbs on f.work
    /* ⛔ EDGES SOFTENED, NOTHING ELSE — shipped geometry, shading and colour untouched. The
       universal near-black contour becomes a dark tint so the prop stops reading as a sticker
       cut out and laid on the deck. Same EDGE the couch uses, so the lounge reads as one room. */
    const EDGE = '#161d22';
    const r = RAMP.fabric, ph = (f && f.x) || 0, on = !!(f && f.work);
    shadow2(x + 2, y + h - 1, 8);
    for (const lx of [x + 2, x + 7]) {                            // stub feet, freestanding
      px(lx, y + 10, 3, 2, EDGE); px(lx, y + 10, 1, 2, r.lit); px(lx + 1, y + 10, 1, 2, r.dk);
    }
    underAO(x + 4, y + 10, 4, 1);
    // chamfered cab with a narrow lit top cap — 12px wide, so the bevel has to do the silhouette work
    chamf(x + 1, y - 3, 10, 13, EDGE, 1);
    chamf(x + 2, y - 2, 8, 11, r.face, 1);
    px(x + 2, y, 1, 8, shade(r.face, 0.10)); px(x + 9, y, 1, 8, r.dk);
    rimEdge(x + 9, y, 1, 8, 0.22);                                // cool bounce down the shade side
    px(x + 3, y - 2, 6, 2, r.top); px(x + 3, y - 2, 6, 1, r.sheen);
    keyEdge(x + 3, y - 2, 4, 1, 0.30);                            // warm cap catch
    px(x + 2, y + 8, 8, 1, r.ao);
    // grille cloth over the baffle — a weave, so the cab doesn't read as bare plastic
    for (let j = 0; j < 8; j += 2) px(x + 3, y + j, 6, 1, shade(r.face, -0.16));
    // driver: surround ring, cone, dust cap
    chamf(x + 3, y + 1, 6, 6, '#2c3641', 1);
    px(x + 4, y + 1, 4, 1, '#40495a');                            // ring catch
    chamf(x + 4, y + 2, 4, 4, '#10151b', 1);
    px(x + 5, y + 3, 2, 2, '#06090c');
    px(x + 5, y + 3, 1, 1, '#39434f');                            // soft cap catch (a white speck reads as a dead pixel)
    if (on) {
      const b = blink(170, ph);
      bloom(x + 4, y + 2, 4, 4, ACC.lounge, b ? 0.30 : 0.10);     // cone throb with falloff
      if (b) px(x + 5, y + 3, 2, 2, '#1c1220');                   // cone punched forward on the beat
      spill(x + 3, y + 8, 6, ACC.lounge, 0.16, 3);                // light pools down onto the floor
    }
    px(x + 5, y + 7, 2, 1, '#0e1216');                            // bass port
    px(x + 8, y - 1, 1, 1, on && blink(400, ph) ? ACC.lounge : (blink(2200, ph) ? '#5a2a4a' : '#3a2434')); // standby lamp, never fully dead
  };

  F.vault = (x, y, w, h, f) => {
    /* v32 VAULT (3x2) — rebuilt AGAIN for VOLUME. v31 read as a flat box with a circle painted on it,
       and the difference against the uplink dish is the whole lesson:
       ⛔ GORGEOUS COMES FROM FORM, NOT FROM DETAIL. The dish works because its bowl runs a smooth
          gradient from shadow into light across a big surface. A face filled with one flat tone and
          then decorated is flat no matter how much decoration goes on it. EVERY large surface here
          gets a gradient across its depth.
       ⛔ A DOOR MUST BE THICK. The disc is a proud plug: a lit top-left rim, a dark under-rim, a cast
          shadow onto the frame below-right, and a recessed reveal it sits inside. That thickness is
          what makes it a pressure door instead of a drawn circle. */
    const r = EQUIPMENT, br = MAT.brass, on = !!(f && f.work);
    const base = y + h, cx = x + Math.round(w / 2) - 3, cy = y + 11, R = 9;

    shadow2(x + 2, base - 1, w - 4);
    deckPlate(x, base - 4, w, 4);
    deckSocket(x + w + 1, base - 3, on);

    /* ---- CARCASS: top plane we look down on, then a face that falls away in five bands ---- */
    px(x, y - 5, w, h + 5, r.ink);
    px(x + 1, y - 4, w - 2, 3, r.lit);                             // top plane, catching the ceiling
    px(x + 2, y - 4, 9, 1, r.hi);                                  // west-biased specular
    px(x + 1, y - 1, w - 2, 1, r.mid);                             // front edge of the top
    const bands = [r.face, r.face, r.top, r.top, r.face, r.face, r.dk, r.dk];
    for (let i = 0; i < bands.length; i++)
      px(x + 1, y + i * 2, w - 2, 2, bands[i]);                    // the face, gradient across its height
    px(x + 1, y, 1, h - 1, r.mid); px(x + w - 2, y, 1, h - 1, r.ao);
    px(x + 2, base - 4, w - 4, 1, r.ao);                           // plinth shadow
    px(x + 2, base - 5, w - 4, 1, r.mid);

    /* ---- HINGE COLUMN, west: three barrels with real top/bottom shading ---- */
    captiveBolt(x + w - 5, y + 1, r); captiveBolt(x + w - 5, base - 8, r);
    for (const hy of [y + 1, y + 9, y + 16]) {
      px(x - 3, hy, 4, 5, r.ink);
      px(x - 2, hy + 1, 3, 3, r.face);
      px(x - 2, hy + 1, 3, 1, r.lit);                              // barrel crown
      px(x - 2, hy + 3, 3, 1, r.ao);                               // and its underside
    }

    /* ---- THE DOOR: a thick proud plug in a recessed reveal ---- */
    for (let dy = -R - 3; dy <= R + 3; dy++) {
      for (let dx = -R - 3; dx <= R + 3; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > R + 2.8) continue;
        const nl = (dx + dy * 1.15) / (R * 1.6);                   // -1 at top-left, +1 at bottom-right
        let c = null;
        if (d > R + 1.5) { if (dx + dy > 2) c = r.ao; }             // cast shadow, down-right only
        else if (d > R + 0.4) c = r.ao;                            // the reveal
        else if (d > R - 0.6) c = r.ink;                           // door edge
        else if (d > R - 2.4) c = nl < -0.42 ? r.hi : nl < -0.05 ? r.lit : nl < 0.4 ? r.mid : r.dk;   // thick rim
        else c = nl < -0.5 ? r.lit : nl < -0.1 ? r.mid : nl < 0.35 ? r.face : nl < 0.7 ? r.top : r.dk; // door face
        if (c) px(cx + dx, cy + dy, 1, 1, c);
      }
    }
    // BOLT RING — eight heads, each a lit crown over a dark seat
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4 + 0.39;
      const bxp = cx + Math.round(Math.cos(a) * (R - 3.6)), byp = cy + Math.round(Math.sin(a) * (R - 3.6));
      px(bxp, byp, 1, 1, br.hi); px(bxp, byp + 1, 1, 1, br.ao);
    }
    /* ---- HANDWHEEL: thick brass rim, four spokes, a hub with its own highlight ---- */
    /* ⛔ THIN RIM, OPEN CENTRE, THREE SPOKES — the same law the safe's wheel earned. A thick rim on a
       small radius leaves no hole and the whole thing renders as a brass blob; the HOLE is what makes
       it a handwheel. Four spokes at this size collide into a solid star, three stay countable. */
    const ang = now / 5200, WR = 6.2;
    for (let dy = -WR - 1; dy <= WR + 1; dy++) for (let dx = -WR - 1; dx <= WR + 1; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > WR + 0.6 || d < WR - 1.6) continue;
      const nl = (dx + dy * 1.1) / (WR * 1.9);
      px(cx + dx, cy + dy, 1, 1,
        d > WR - 0.1 ? br.ink : nl < -0.34 ? br.hi : nl < 0.02 ? br.mid : nl < 0.32 ? br.face : br.dk);
    }
    for (let k = 0; k < 3; k++) {
      const a = k * (Math.PI * 2 / 3) + ang;
      for (let t = 1; t <= WR - 1.5; t++) {
        const sxp = cx + Math.round(Math.cos(a) * t), syp = cy + Math.round(Math.sin(a) * t);
        px(sxp, syp, 1, 1, br.mid);
        if (t > 1) px(sxp, syp + 1, 1, 1, br.ao);
      }
    }
    px(cx - 1, cy - 1, 3, 3, br.ink); px(cx - 1, cy - 1, 2, 1, br.hi); px(cx, cy + 1, 1, 1, br.dk);

    /* ---- keypad + seal lamp on the frame, east ---- */
    const kx = x + w - 10;
    px(kx, y + 5, 8, 10, r.ink);
    px(kx + 1, y + 6, 6, 8, r.ao);
    px(kx + 1, y + 6, 6, 1, r.dk);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++)
      px(kx + 2 + i * 2, y + 8 + j * 2, 1, 1, blink(520, i + j * 1.7) ? shade(ACC.work, -0.05) : '#1b2a24');
    px(kx + 1, y + 12, 6, 1, blink(900) ? ACC.work : shade(ACC.work, -0.62));
    if (on) {
      bloom(kx + 1, y + 12, 6, 1, ACC.work, 0.26);
      for (let dy = -R; dy <= R; dy++) {                           // hairline of light around the door seam
        const hw = Math.round(Math.sqrt(Math.max(0, R * R - dy * dy)));
        if (hw < 1) continue;
        px(cx - hw, cy + dy, 1, 1, shade(ACC.work, -0.35));
        px(cx + hw, cy + dy, 1, 1, shade(ACC.work, -0.55));
      }
      spill(x + 2, base - 5, w - 4, ACC.work, 0.10, 3);
    }
  };

  F.ticker = (x, y, w, h, f) => {
    // TICKER (4x1) — v4. Differentiated by PROPORTION and by lit-area TEXTURE: a long letterbox marquee
    // (48x9 of glass) on two raked struts, and the crawl is drawn as a real LED DOT MATRIX rather than
    // canvas text — dots survive the 3x zoom that 7px type does not, and they read as a ticker instantly.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const bt = y - 7, bh = 11;                                      // marquee rides y-7..y+3
    shadow2(x + 4, y + h - 1, w - 8);
    // two RAKED struts + splayed pads: the family's other floor props stand plumb, this one leans
    for (const s of [-1, 1]) {
      const bx = x + (w >> 1) + s * 13;
      for (let j = 0; j < 8; j++) px(bx + s * Math.floor(j / 2), y + 3 + j, 3, 1, LINE);
      for (let j = 0; j < 8; j++) {
        px(bx + s * Math.floor(j / 2), y + 3 + j, 1, 1, s < 0 ? r.lit : shade(r.face, 0.06));
        px(bx + s * Math.floor(j / 2) + 1, y + 3 + j, 1, 1, r.dk);
      }
      chamf(bx + s * 4 - 3, y + h - 2, 9, 2, LINE, 1);
      px(bx + s * 4 - 2, y + h - 2, 7, 1, r.face); px(bx + s * 4 - 2, y + h - 1, 7, 1, r.ao);
      ctx.globalAlpha = 0.28; px(bx + s * 4 - 3, y + h, 9, 1, '#000'); ctx.globalAlpha = 1;
    }
    cable(x + (w >> 1) + 10, y + 4, x + (w >> 1) + 17, y + h - 2, 2);
    // slim chamfered housing — shallow enough that the lit band IS the silhouette
    chamf(x - 1, bt - 1, w + 2, bh + 2, LINE, 2);
    chamf(x, bt, w, bh, r.face, 2);
    px(x + 2, bt, w - 4, 1, r.top); keyEdge(x + 2, bt, 12, 1, 0.28);
    px(x, bt + 2, 1, bh - 4, r.lit); px(x + w - 1, bt + 2, 1, bh - 4, r.dk);
    rimEdge(x + w - 1, bt + 2, 1, bh - 4, 0.22);
    px(x + 2, bt + bh - 1, w - 4, 1, r.ao);
    for (const sxx of [x + 2, x + w - 3]) px(sxx, bt + 1, 1, 1, shade(r.top, 0.28));
    const gx = x + 2, gy = bt + 2, gw = w - 4, gh = 7;
    px(gx - 1, gy - 1, gw + 2, gh + 2, '#04100a');
    px(gx, gy, gw, gh, on ? '#08190e' : '#06120a');                 // never a black hole when idle
    // MATRIX CRAWL — 4-column cells (3 lit columns + 1 gap) scrolling west, with a dim phosphor trail
    // one pixel behind. Colour groups alternate so the stream reads as separate quotes, not one smear.
    const off = Math.floor(now / 90 + ph * 7);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < gw; i++) {
        const col = i + off + pass;
        if (col % 4 === 3) continue;                                // inter-glyph gap
        const cell = Math.floor(col / 4);
        if (cell % 11 > 8) continue;                                // word breaks
        const grp = Math.floor(cell / 11) % 3;
        const bits = U.hash('tkm' + cell + (col % 4)) & 31;
        const base = grp === 1 ? ACC.flow : '#9bff4a';
        const c = pass ? shade(base, -0.62) : shade(base, on ? 0 : -0.42);
        for (let j = 0; j < 5; j++) if (bits & (1 << j)) px(gx + i, gy + j, 1, 1, c);
      }
    }
    px(gx, gy + 5, gw, 1, '#0d1f10');                               // lane divider
    for (let i = 0; i < gw - 1; i += 3) {                           // lower lane: up/down move ticks
      const k = (U.hash('tkv' + i + Math.floor(now / 1400)) % 3);
      px(gx + i, gy + 6, 2, 1, k === 0 ? shade(ACC.work, on ? 0 : -0.4)
        : k === 1 ? shade(ACC.flow, on ? -0.1 : -0.5) : '#1c3a22');
    }
    scanl(gx, gy, gw, gh, on ? 0.14 : 0.22);
    bloom(gx, gy, gw, 5, '#9bff4a', (0.13 + 0.03 * Math.sin(now / 700 + ph)) * (on ? 1 : 0.6));
    spill(x + 2, bt + bh, w - 4, '#9bff4a', on ? 0.17 : 0.10, 5);   // the crawl lights the deck below it
    px(x + 2, bt + bh - 3, 1, 1, blink(700, ph) ? '#9bff4a' : '#1c2a1a');   // power LED (kept)
    for (let i = 0; i < 6; i++) px(x + w - 22 + i * 3, bt + bh - 3, 2, 1, '#0c1410');  // vent slits, east end
  };

  F.safe = (x, y, w, h, f) => {
    /* v41 STRONGBOX (1x2) — built to Andrew's reference (2026-08-16). Read top to bottom, the
       reference is a STACK OF FOUR DISTINCT PANELS on one carcass, not a door with fittings:
         cap  ->  recessed LED display  ->  louvred vent  ->  BIG concentric ring-lock  ->  indicator
       ⛔ THE LOCK IS THE HERO AND IT EATS THE WIDTH. Concentric rings around a hot glowing core, with
          four arc segments burning on the ring. A small dial on a big box is a grey locker; this one
          spans the whole carcass.
       ⛔ SIDE RAILS WITH BRACKET BLOCKS. Two vertical bars proud of the flanks, pinned at three
          points. They are what make it read as armoured rather than as a painted rectangle.
       ⛔ EACH PANEL IS RECESSED: dark well, lit lip above, contents inside. Four of those stacked is
          the whole composition — no panel repeats another's treatment.
       ⛔ Brass lives on the FEET only. */
    const r = EQUIPMENT, br = MAT.brass, on = !!(f && f.work);
    const base = y + h, top = y - 8;
    const G = ACC.work;
    const cx = x + Math.round(w / 2);

    shadow2(x + 1, base - 1, w - 2);
    deckPlate(x, base - 4, w, 4);
    deckSocket(x + w + 1, base - 3, on);

    /* ---- CAP: chamfered, proud, its own lit plane ---- */
    px(x + 1, top, w - 2, 1, r.ink);
    px(x, top + 1, w, 4, r.ink);
    px(x + 1, top + 1, w - 2, 2, r.lit);
    px(x + 2, top + 1, 4, 1, r.hi); captiveBolt(x + w - 4, top + 1, r);
    px(x + 1, top + 3, w - 2, 1, r.top);
    px(x + 1, top + 4, w - 2, 1, r.dk);

    /* ---- CARCASS ---- */
    const bTop = top + 5;
    px(x, bTop, w, base - bTop - 2, r.ink);
    panelFinish(x + 1, bTop, w - 2, base - bTop - 4, r);
    px(x + 1, bTop, 1, base - bTop - 4, r.mid);
    px(x + w - 2, bTop, 1, base - bTop - 4, r.dk);

    /* ---- SIDE RAILS: proud bars pinned at three points ---- */
    for (const rx of [x, x + w - 2]) {
      px(rx, bTop + 1, 2, base - bTop - 6, r.ink);
      px(rx, bTop + 2, 1, base - bTop - 8, rx === x ? r.mid : r.dk);
      for (const py2 of [bTop + 2, bTop + 11, base - 11]) {          // bracket blocks
        px(rx - 1, py2, 4, 3, r.ink);
        px(rx, py2 + 1, 2, 1, rx === x ? r.lit : r.face);
      }
    }

    /* ---- PANEL 1: recessed LED display ---- */
    const dY = bTop + 2;
    px(x + 3, dY, 6, 5, r.ink);
    px(x + 4, dY - 1, 4, 1, r.lit);                                  // lit lip above the well
    px(x + 4, dY + 1, 4, 3, r.ao);
    px(x + 4, dY + 1, 2, 2, on ? G : shade(G, -0.60));             // the big readout block
    for (let k = 0; k < 3; k++)
      px(x + 7, dY + 1 + k, 1, 1, blink(520, k * 1.4) ? G : shade(G, -0.68));
    if (on) bloom(x + 4, dY + 1, 4, 3, G, 0.20);

    /* ---- PANEL 2: louvred vent ---- */
    const vY = bTop + 8;
    px(x + 3, vY, 6, 6, r.ink);
    px(x + 4, vY - 1, 4, 1, r.mid);
    px(x + 4, vY + 1, 4, 4, r.ao);
    for (let k = 0; k < 2; k++) px(x + 4, vY + 1 + k * 2, 4, 1, r.dk);   // slats
    px(x + 4, vY + 2, 4, 1, r.face);

    /* ---- PANEL 3: THE RING-LOCK. Concentric rings, hot core, four burning arcs ---- */
    const ly = bTop + 18, R = 5.0;
    for (let dy = -R - 1; dy <= R + 1; dy++) for (let dx = -R - 1; dx <= R + 1; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > R + 0.7) continue;
      const nl = (dx + dy * 1.1) / (R * 1.9);
      let c;
      if (d > R - 0.3) c = r.ink;                                    // outer ring
      else if (d > R - 1.3) c = nl < -0.3 ? r.lit : nl < 0.25 ? r.mid : r.dk;
      else if (d > R - 2.0) c = r.ao;                                // the groove between rings
      else if (d > R - 3.0) c = nl < -0.3 ? r.mid : nl < 0.25 ? r.face : r.dk;
      else if (d > R - 3.7) c = r.ink;
      else c = on ? shade(G, -0.34) : shade(G, -0.72);           // the lit well
      px(cx + dx, ly + dy, 1, 1, c);
    }
    if (on) {                                                        // four arcs burning on the ring
      for (let k = 0; k < 4; k++) {
        const a = k * (Math.PI / 2) + Math.PI / 4 + now / 6000;
        for (let t = -0.34; t <= 0.34; t += 0.16) {
          const rr = R - 2.6;
          px(cx + Math.round(Math.cos(a + t) * rr), ly + Math.round(Math.sin(a + t) * rr), 1, 1, G);
        }
      }
    }
    px(cx - 1, ly - 1, 2, 2, on ? '#d6ffe8' : shade(G, -0.55));    // the hot core
    if (on) bloom(cx - 2, ly - 2, 4, 4, G, 0.34 + 0.10 * Math.sin(now / 700));

    /* ---- PANEL 4: indicator strip ---- */
    const iY = base - 8;
    px(x + 3, iY, 6, 4, r.ink);
    px(x + 4, iY - 1, 4, 1, r.mid);
    px(x + 4, iY + 1, 4, 2, r.ao);
    for (let k = 0; k < 4; k++)
      px(x + 4 + k, iY + 1, 1, 1, blink(700, k * 1.2) ? G : shade(G, -0.68));
    if (on) { bloom(x + 4, iY + 1, 4, 1, G, 0.20); spill(x + 1, base - 5, w - 2, G, 0.14, 4); }

    /* ---- BRASS FEET ---- */
    px(x + 1, base - 3, w - 2, 1, r.dk);
    px(x, base - 2, 4, 2, r.ink); px(x + w - 4, base - 2, 4, 2, r.ink);
    px(x + 1, base - 2, 2, 1, br.mid); px(x + w - 3, base - 2, 2, 1, br.mid);
    px(x + 1, base - 1, 2, 1, br.dk); px(x + w - 3, base - 1, 2, 1, br.dk);
  };

  F.goldcrate = (x, y, w, h) => {
    /* v68 GOLD CRATE (2x1) — the premium sibling of F.crate: same chest anatomy so the pair read as a
       set, but the material swaps timber for dark gunmetal banded in brass.
       ⛔ BRASS IS TRIM, NOT A SURFACE. Two bands, four corner caps and one latch — the moment brass
          covers a whole plane at this size it stops being precious and becomes a yellow box.
       ⛔ THE VALUE GAP DOES THE WORK. Near-black casket, one bright brass highlight run. That contrast
          is what makes it read as richer than the timber crate rather than merely differently coloured.
       ⛔ NO EMISSIVE. This is a container, not a machine — nothing here may claim a live state. */
    const EDGE = '#10161b';
    const MT = '#3a444d', MT_L = '#586570', MT_D = '#222a31', MT_TOP = '#48545e', MT_SHN = '#6e7c88';
    const BRS = '#8a6f2e', BRS_L = '#d4ab4a', BRS_HI = '#f0d484', BRS_D = '#4e3d18';
    const bT = y - 2, bH = 12;

    shadow2(x + 1, y + h - 1, w - 2);

    /* ---- FRONT FACE: gunmetal panels between two brass bands ---- */
    px(x, bT, w, bH, EDGE);
    px(x + 1, bT + 1, w - 2, bH - 2, MT);
    px(x + 1, bT + 1, 1, bH - 2, MT_L); px(x + w - 2, bT + 1, 1, bH - 2, MT_D);
    rimEdge(x + w - 2, bT + 2, 1, bH - 5, 0.20);
    for (let i = 1; i < 3; i++) {                                   // two recessed panels
      const sx = x + 1 + Math.round(i * (w - 2) / 3);
      px(sx, bT + 3, 1, bH - 7, MT_D); px(sx + 1, bT + 3, 1, bH - 7, MT_L);
    }
    wear(x + 3, bT + 5, w - 6, 3, 3, shade(MT, -0.20));

    /* ---- TWO BRASS BANDS, top and bottom of the face, each with one bright run ---- */
    for (const by of [bT + 1, bT + bH - 4]) {
      px(x + 1, by, w - 2, 2, BRS);
      px(x + 1, by, w - 2, 1, BRS_L); px(x + 2, by, 8, 1, BRS_HI); keyEdge(x + 2, by, 8, 1, 0.20);
      px(x + 1, by + 2, w - 2, 1, BRS_D);
      for (let i = 0; i < 4; i++) px(x + 4 + i * 6, by + 1, 1, 1, shade(BRS_HI, -0.10));   // rivets
    }

    /* ---- CORNER CAPS: brass L on every front corner ---- */
    for (const s of [0, 1]) {
      const cx0 = s ? x + w - 4 : x + 1;
      px(cx0, bT + 3, 3, 1, BRS); px(s ? cx0 + 2 : cx0, bT + 3, 1, 4, BRS);
      px(cx0, bT + 3, 2, 1, BRS_L);
      px(cx0, bT + bH - 6, 3, 1, BRS_D); px(s ? cx0 + 2 : cx0, bT + bH - 8, 1, 3, BRS_D);
    }

    /* ---- LATCH: a brass plate straddling the lid line over a dark keeper ---- */
    const hx = x + Math.round(w / 2) - 2;
    px(hx, y - 4, 5, 6, BRS_D);
    px(hx, y - 4, 5, 1, BRS_HI); px(hx, y - 3, 5, 2, BRS_L); px(hx, y - 1, 5, 1, BRS);
    px(hx + 2, y, 1, 2, '#171d22');                                 // the keyhole
    px(hx, y + 2, 5, 1, shade(BRS_D, -0.40));

    /* ---- FEET + floor line ---- */
    px(x + 1, y + h - 3, w - 2, 1, '#080b0e');
    px(x + 1, y + h - 2, 5, 1, MT_D); px(x + w - 6, y + h - 2, 5, 1, MT_D);
    px(x + 1, y + h - 2, 2, 1, BRS_D); px(x + w - 3, y + h - 2, 2, 1, BRS_D);
    ctx.globalAlpha = 0.34; px(x + 1, y + h - 1, w - 2, 1, '#000'); ctx.globalAlpha = 1;

    /* ---- LID: domed top plane with a brass spine down its crown ---- */
    chamf(x - 1, y - 10, w + 2, 10, EDGE, 2);
    chamf(x, y - 9, w, 8, MT_TOP, 2);
    px(x + 1, y - 9, w - 2, 1, MT_SHN); keyEdge(x + 2, y - 9, 9, 1, 0.24);
    px(x + 2, y - 7, w - 4, 1, BRS); px(x + 2, y - 7, 9, 1, BRS_L);           // the brass spine
    px(x + 2, y - 6, w - 4, 1, BRS_D);
    px(x + 2, y - 4, w - 4, 1, shade(MT_TOP, -0.20));                       // the lid falls toward the user
    px(x, y - 9, 1, 8, MT_L); px(x + w - 1, y - 9, 1, 8, MT_D);
    rimEdge(x + w - 1, y - 8, 1, 6, 0.20);
    px(x + 1, y - 2, w - 2, 1, '#141a1f');                                    // rebate under the lip
    for (const s of [0, 1]) {                                                 // lid corner caps
      const cx0 = s ? x + w - 3 : x + 1;
      px(cx0, y - 9, 2, 1, BRS_L); px(cx0, y - 8, 2, 1, BRS_D);
    }
  };

  F.chartwall = (x, y, w, h, f) => {
    // CHART WALL (3x1) — v4. The old version was three identical line panels on rolling posts. Now it is
    // a signage TOTEM on one cast column (a fourth distinct mount for this family) and the three panels
    // carry three DIFFERENT chart types — trace / histogram / stacked area — so the bank reads as a
    // dashboard at a glance instead of as three copies of the same squiggle.
    // ANCHOR: the bank rides low enough that its bottom third lands in the PLACED tile, and it stands on a
    // STOUT cast neck + splayed foot that live wholly inside the footprint — the sweep had a 6px stick
    // holding a 36x17 head entirely north of the tile the player clicked.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const bt = y - 9, bh = 15;                                      // head rides y-9..y+5
    const g0 = on ? 1 : 0.62;
    shadow2(x + 5, y + h - 1, w - 10);
    // splayed cast base + a STOUT tapered neck — the whole mount sits in the footprint
    chamf(x + 6, y + h - 4, w - 12, 4, LINE, 2);
    px(x + 7, y + h - 3, w - 14, 2, r.face);
    px(x + 7, y + h - 3, w - 14, 1, r.lit); keyEdge(x + 8, y + h - 3, 8, 1, 0.16);
    px(x + 7, y + h - 1, w - 14, 1, r.ao);
    for (let j = 0; j < 5; j++) {                                   // neck widens toward the foot
      const cw = 12 + (j > 1 ? 2 : 0) + (j > 3 ? 2 : 0), cx0 = x + (w >> 1) - (cw >> 1);
      px(cx0 - 1, y + 5 + j, cw + 2, 1, LINE);
      px(cx0, y + 5 + j, 1, 1, r.lit); px(cx0 + 1, y + 5 + j, cw - 2, 1, r.face); px(cx0 + cw - 1, y + 5 + j, 1, 1, r.dk);
    }
    px(x + (w >> 1) - 5, y + 8, 10, 1, shade(r.face, -0.30));     // cast seam across the neck
    rimEdge(x + (w >> 1) + 5, y + 6, 1, 4, 0.18);
    cable(x + (w >> 1) + 7, y + 7, x + (w >> 1) + 11, y + h - 2, 1.6);
    // chamfered head housing
    chamf(x - 1, bt - 1, w + 2, bh + 2, LINE, 2);
    chamf(x, bt, w, bh, r.face, 2);
    px(x + 2, bt, w - 4, 1, r.top); keyEdge(x + 2, bt, 11, 1, 0.28);
    px(x, bt + 2, 1, bh - 4, r.lit); px(x + w - 1, bt + 2, 1, bh - 4, r.dk);
    rimEdge(x + w - 1, bt + 2, 1, bh - 4, 0.22);
    px(x + 2, bt + bh - 1, w - 4, 1, r.ao);
    for (const sxx of [x + 2, x + w - 3]) { px(sxx, bt + 1, 1, 1, shade(r.top, 0.28)); px(sxx, bt + bh - 2, 1, 1, r.ao); }
    wear(x + 1, bt + 1, w - 2, bh - 2, 3, shade(r.face, -0.10));
    // THREE PANELS, THREE CHART TYPES
    const ACCS = [ACC.data, ACC.flow, ACC.mem], pw = 10, pyy = bt + 2, phh = 10;
    for (let i = 0; i < 3; i++) {
      const p0 = x + 2 + i * 11, acc = ACCS[i], lit = shade(acc, on ? 0 : -0.45);
      inset(p0, pyy, pw, phh, '#0c1218');
      px(p0 + 1, pyy + 1, pw - 2, phh - 2, on ? '#0b1620' : '#091119');   // panel ground keeps phosphor
      px(p0 + 1, pyy + 1, 4, 1, lit);                               // colour tab naming the panel (kept)
      px(p0 + 1, pyy + 2, pw - 2, 1, '#141c26');                    // header rule
      for (let gxx = 1; gxx < pw - 1; gxx += 3) px(p0 + gxx, pyy + 3, 1, phh - 4, '#131b24');  // graticule
      px(p0 + 1, pyy + 6, pw - 2, 1, '#182029');                    // mid gridline
      const bx0 = p0 + 1, bw0 = pw - 2, by0 = pyy + 3, bh0 = 6;
      if (i === 0) {                                                // TRACE — dim echo behind the live line
        ctx.save(); ctx.lineWidth = 1;
        ctx.strokeStyle = shade(acc, -0.72); ctx.beginPath();
        for (let j = 0; j < bw0; j++) {
          const yy = by0 + bh0 - 1 - (U.hash('ch0' + ((j + 3) >> 1)) % 5);
          j ? ctx.lineTo(bx0 + j, yy) : ctx.moveTo(bx0 + j, yy);
        }
        ctx.stroke();
        ctx.strokeStyle = lit; ctx.beginPath();
        for (let j = 0; j < bw0; j++) {
          const yy = by0 + bh0 - 1 - (U.hash('ch0' + (j >> 1)) % 5);
          j ? ctx.lineTo(bx0 + j, yy) : ctx.moveTo(bx0 + j, yy);
        }
        ctx.stroke(); ctx.restore();
      } else if (i === 1) {                                         // HISTOGRAM — solid bars off a baseline
        for (let j = 0; j < bw0; j += 2) {
          const v = 1 + Math.floor((1 + Math.sin(now / 340 + j * 0.9 + ph)) * (on ? 1.8 : 0.8));
          px(bx0 + j, by0 + bh0 - v, 1, v, lit);
          px(bx0 + j, by0 + bh0 - v, 1, 1, on ? shade(acc, 0.35) : shade(acc, -0.3));   // bar cap
        }
        px(bx0, by0 + bh0, bw0, 1, shade(acc, -0.55));            // baseline
      } else {                                                      // STACKED AREA — filled, not a line
        for (let j = 0; j < bw0; j++) {
          const v = 2 + (U.hash('ch2' + (j >> 1)) % 4);
          px(bx0 + j, by0 + bh0 - v, 1, v, shade(acc, on ? -0.42 : -0.68));
          px(bx0 + j, by0 + bh0 - v, 1, 1, lit);                    // the surface of the area
          px(bx0 + j, by0 + bh0 - 1, 1, 1, shade(acc, -0.6));     // darker lower band
        }
      }
      px(bx0 + bw0 - 1, by0 + (Math.floor(now / 400 + i + ph) % 4), 1, 1, on ? '#e8f4ff' : lit);  // live tick (kept)
      scanl(p0 + 1, pyy + 1, pw - 2, phh - 2, on ? 0.14 : 0.22);
      bloom(p0 + 1, pyy + 1, pw - 2, phh - 2, acc, 0.11 * g0);
      if (i < 2) px(p0 + pw, pyy + 3, 1, 5, '#121820');             // inter-panel conduit (kept)
    }
    spill(x + 3, bt + bh, w - 6, ACC.data, 0.14 * g0, 4);           // the bank lights its own column
    for (let i = 0; i < 3; i++)                                     // feed lamps on the bottom rail
      px(x + 4 + i * 11, bt + bh - 3, 2, 1, blink(850, i + ph) ? shade(ACCS[i], on ? 0 : -0.45) : '#1c2630');
  };

  F.wartable = (x, y, w, h, f) => {   // v4 WAR TABLE (5x2) — the room's centrepiece: a lit map you look DOWN on
    // The family's failure mode is seven glowing rectangles, so this one is deliberately NOT a screen: it is a
    // 60x24 horizontal SLAB whose whole top face is the emitter. Read is (1) a huge oval-cornered map well
    // sunk into a heavy chamfered top, (2) a raised rail with grab-handles running the long edges — the thing
    // officers lean on — and (3) light SPILLING off the table's front lip onto the deck, which is what sells a
    // downward-facing emitter. Alert rose is the map's contact colour (it plots threats); ACC.flow amber is the
    // reticle. f.work = a run is live -> more contacts resolve, sweep speeds up, spill doubles.
    const r = RAMP.gun, ph = (f && f.x) || 0, on = !!(f && f.work);
    const ROSE = '#ff5c7a', ROSEH = '#ffb0c0';
    const topT = y + 1, topH = h - 12;                              // top face rows; south face + legs below
    shadow2(x + 2, y + h - 1, w - 4);
    deckPlate(x + 2, y + h - 5, w - 4, 5);                          // the table is bolted, not wheeled
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 6, y + h - 8, x + w + 2, y + h - 3, 2.4);
    // FOUR chunky legs — a 60px slab on two legs reads as a shelf; four says table
    for (const lx of [x + 3, x + 17, x + w - 20, x + w - 6]) {
      px(lx, y + h - 7, 3, 6, LINE);
      px(lx, y + h - 7, 1, 6, r.lit); px(lx + 1, y + h - 7, 1, 6, r.dk);
      rimEdge(lx + 2, y + h - 6, 1, 4, 0.16);
      ctx.globalAlpha = 0.30; px(lx - 1, y + h - 1, 5, 1, '#000'); ctx.globalAlpha = 1;
    }
    underAO(x + 6, y + h - 7, w - 12, 3);
    // SOUTH FACE — short, with a recessed edge-control channel; the map light pools down it
    chamf(x - 1, y + h - 13, w + 2, 8, LINE, 2);
    px(x, y + h - 12, w, 6, r.face);
    px(x, y + h - 12, w, 1, r.lit); keyEdge(x + 2, y + h - 12, 14, 1, 0.16);   // catch under the top's overhang
    px(x, y + h - 11, 1, 5, shade(r.face, 0.08)); px(x + w - 1, y + h - 11, 1, 5, r.dk);
    rimEdge(x + w - 1, y + h - 11, 1, 5, 0.20);
    px(x, y + h - 7, w, 1, r.ao);
    // two operator stations on the face: a rose contact bank west, an amber tasking bank east (kept blinks)
    inset(x + 7, y + h - 11, 8, 3, '#241218');
    for (let i = 0; i < 3; i++) px(x + 8 + i * 2, y + h - 10, 1, 1, blink(500, i + ph) ? ROSE : '#3a2030');
    inset(x + w - 15, y + h - 11, 8, 3, '#241218');
    for (let i = 0; i < 3; i++) px(x + w - 14 + i * 2, y + h - 10, 1, 1, blink(700, i + 4 + ph) ? ACC.flow : '#3a3020');
    knurl(x + 20, y + h - 9, 18, 1, r.face);                        // machined lean-rail grip across the middle
    // THE TOP — heavy chamfer so the 60px slab has real corners, warm crown key on the back edge
    chamf(x - 1, y - 1, w + 2, topH + 3, LINE, 3);
    chamf(x, y, w, topH + 1, r.top, 3);
    px(x + 3, y, w - 6, 1, r.sheen); keyEdge(x + 3, y, 16, 1, 0.28);
    px(x, y + 2, 1, topH - 3, r.lit); px(x + w - 1, y + 2, 1, topH - 3, r.dk);
    rimEdge(x + w - 1, y + 2, 1, topH - 3, 0.20);
    px(x + 3, y + topH, w - 6, 1, shade(r.top, -0.20));           // front lip of the top
    wear(x + 2, y + 1, w - 4, topH - 2, 5, shade(r.top, -0.09));
    // RAISED EDGE RAIL along the long sides + corner grab-handles: the officers-lean-here detail
    px(x + 4, y + 1, w - 8, 1, shade(r.top, 0.16));
    for (const gx of [x + 5, x + w - 12]) {
      px(gx, y + 1, 7, 2, shade(r.top, 0.10)); px(gx, y + 1, 7, 1, r.sheen);
      px(gx + 1, y + 2, 5, 1, shade(r.top, -0.30));              // the finger gap under the handle
    }
    // MAP WELL — one big oval-cornered recess, the prop's single dominant lit shape
    const wx = x + 5, wy = topT + 2, ww = w - 10, wh = topH - 5;
    chamf(wx - 2, wy - 2, ww + 4, wh + 4, '#080407', 2);            // well surround, deeper than inset()
    chamf(wx - 1, wy - 1, ww + 2, wh + 2, shade(r.top, -0.62), 2);
    px(wx - 1, wy - 1, ww + 2, 1, shade(r.top, -0.78));           // shadow cast by the north lip INTO the well
    chamf(wx, wy, ww, wh, on ? '#1c0d14' : '#150a10', 1);           // idle map keeps chart-glass, never dead black
    // chart substrate: a sector grid + a coastline-ish landmass, so it reads as a MAP not as noise
    for (let gx = 6; gx < ww - 2; gx += 7) px(wx + gx, wy + 1, 1, wh - 2, on ? '#3a1c28' : '#2a141d');
    for (let gy = 2; gy < wh - 1; gy += 3) px(wx + 1, wy + gy, ww - 2, 1, on ? '#331823' : '#26121a');
    for (let i = 0; i < 9; i++) {                                   // one continuous landmass blob, deterministic
      const hx = U.hash('wt' + i), bx = wx + 4 + (hx % (ww - 12));
      px(bx, wy + 2 + ((hx >> 4) % Math.max(1, wh - 5)), 3 + (hx % 4), 1, on ? '#4a2432' : '#301a24');
    }
    // CONTACTS — plotted blips with expanding pulse rings; more of them resolve while a run is live
    const N = on ? 6 : 4;
    const a0 = 0.5 + 0.3 * Math.sin(now / 500);
    for (let i = 0; i < N; i++) {
      const bx = wx + 4 + i * Math.floor((ww - 8) / N), by = wy + 1 + (i % 3) * Math.max(1, Math.floor((wh - 2) / 3));
      ctx.globalAlpha = a0; px(bx, by, 2, 2, ROSE); ctx.globalAlpha = 1;
      px(bx, by, 1, 1, ROSEH);                                      // blip core
      const rad = ((now / 600 + i * 0.4) % 1) * 3;
      ctx.save();
      ctx.strokeStyle = ROSE; ctx.globalAlpha = a0 * (1 - rad / 3);
      ctx.beginPath(); ctx.arc(bx + 1, by + 1, rad + 1, 0, 6.2832); ctx.stroke();
      ctx.restore();
      if (i === 0) bloom(bx, by, 2, 2, ROSE, 0.20);
    }
    // TARGETING RETICLE stepping between contacts — amber corner brackets (kept behaviour)
    const tgt = Math.floor(now / 2400) % N;
    const tx2 = wx + 4 + tgt * Math.floor((ww - 8) / N), ty2 = wy + 1 + (tgt % 3) * Math.max(1, Math.floor((wh - 2) / 3));
    if (blink(300)) {
      px(tx2 - 2, ty2 - 1, 2, 1, ACC.flow); px(tx2 + 2, ty2 - 1, 2, 1, ACC.flow);
      px(tx2 - 2, ty2 + 2, 2, 1, ACC.flow); px(tx2 + 2, ty2 + 2, 2, 1, ACC.flow);
      bloom(tx2 - 2, ty2 - 1, 6, 4, ACC.flow, 0.14);
    }
    // RADAR SWEEP: a real leading bar with a decaying tail, not one flat translucent column
    const swx = Math.floor((now / (on ? 18 : 28)) % (ww - 1));
    for (let t = 0; t < 5; t++) {
      const cxs = swx - t;
      if (cxs >= 0) { ctx.globalAlpha = 0.30 * (1 - t / 5); px(wx + cxs, wy, 1, wh, ROSEH); }
    }
    ctx.globalAlpha = 1;
    scanl(wx, wy, ww, wh, 0.16);
    bloom(wx, wy, ww, wh, ROSE, (on ? 0.13 : 0.07) + 0.02 * Math.sin(now / 800));
    // the table's own light falling OFF the front lip onto the deck — the downward-emitter tell
    spill(x + 3, y + topH + 1, w - 6, ROSE, on ? 0.22 : 0.12, 5);
    glow(x + 4, y + h - 2, w - 8, 2, ROSE, on ? 0.14 : 0.07);
  };

  F.calwall = (x, y, w, h, f) => {   // v4 CAL WALL (6x1) — the family's ONLY backlit paper board, not another glass screen
    // 72px wide is the widest prop in the family, so uniformity is the risk: this one is differentiated by being
    // a SPLIT-FLAP schedule board — a warm amber-backlit paper grid behind a glass strip, hung on two rolling
    // A-posts. The lit shape is 14 small cells, never one rect; the week MARCHES left-to-right and the current
    // day carries a flap that ticks over. Amber (ACC.flow = scheduling) throws warm light DOWN onto the posts,
    // which is what separates it from the cold-cyan/rose screens standing beside it. f.work speeds the march.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const bT = y - 7, bH = 14;                                      // board overdraws north of its 1-tile footprint
    shadow2(x + 3, y + h - 1, w - 6);
    // TWO ROLLING A-POSTS — splayed feet + a castor, so it reads as wheeled kit, not bolted machinery
    for (const pxx of [x + 10, x + w - 12]) {
      px(pxx - 1, y + 5, 4, h - 6, LINE);
      px(pxx, y + 6, 1, h - 8, r.lit); px(pxx + 1, y + 6, 1, h - 8, r.dk);
      rimEdge(pxx + 2, y + 6, 1, h - 8, 0.18);
      chamf(pxx - 5, y + h - 4, 12, 3, LINE, 1);                    // wide T-foot
      px(pxx - 4, y + h - 3, 10, 1, r.face); px(pxx - 4, y + h - 3, 10, 1, r.lit);
      px(pxx - 4, y + h - 2, 10, 1, r.ao);
      px(pxx - 3, y + h - 1, 2, 1, '#1a1e22'); px(pxx + 3, y + h - 1, 2, 1, '#1a1e22');   // castors
      ctx.globalAlpha = 0.30; px(pxx - 5, y + h, 12, 1, '#000'); ctx.globalAlpha = 1;
      px(pxx, y + 4, 2, 2, shade(r.top, 0.16));                   // collar tying post to board (no floating)
    }
    // CARCASS — chamfered frame with a warm crown key and a cool east rim
    chamf(x - 1, bT - 1, w + 2, bH + 2, LINE, 2);
    chamf(x, bT, w, bH, r.face, 2);
    px(x + 2, bT, w - 4, 1, r.top); keyEdge(x + 2, bT, 14, 1, 0.26);
    px(x, bT + 2, 1, bH - 4, r.lit); px(x + w - 1, bT + 2, 1, bH - 4, r.dk);
    rimEdge(x + w - 1, bT + 2, 1, bH - 4, 0.22);
    px(x + 2, bT + bH - 1, w - 4, 1, r.ao);
    rivets(x + 1, bT + 1, w - 2, bH - 2, r.sheen, r.ao);
    // HEADER RAIL above the grid: a title bar of ticks, then the amber backlight bleeding out from behind
    inset(x + 2, bT + 1, w - 4, 2, '#1a150c');
    for (let i = 0; i < 8; i++) px(x + 4 + i * 3, bT + 2, 2, 1, shade(ACC.flow, on ? -0.15 : -0.45));
    bloom(x + 3, bT + 2, w - 6, 1, ACC.flow, on ? 0.14 : 0.08);
    // THE GRID — 7 columns x 2 rows of split-flap cells behind one recessed glass strip
    const gT = bT + 4, cw2 = Math.floor((w - 6) / 7), gx0 = x + 3 + (((w - 6) - 7 * cw2) >> 1);
    inset(x + 2, gT - 1, w - 4, 10, '#0e0b07');
    const prog = (now / (on ? 900 : 1400)) % 14;
    for (let i = 0; i < 7; i++) for (let j = 0; j < 2; j++) {
      const idx = i + j * 7, lit = idx < prog, wknd = i > 4;        // weekend columns stay cool (kept)
      const cx3 = gx0 + i * cw2, cy3 = gT + j * 5;
      chamf(cx3, cy3, cw2 - 1, 4, lit ? (wknd ? '#3a3446' : '#4a3f2a') : (wknd ? '#1e1e26' : '#201c16'), 1);
      px(cx3, cy3, cw2 - 1, 1, lit ? (wknd ? '#4a4458' : '#63533a') : '#2a2620');   // flap's own top edge
      px(cx3, cy3 + 2, cw2 - 1, 1, '#0d0b08');                      // the SPLIT — the hinge line across the flap
      if (lit) {
        px(cx3 + 1, cy3 + 1, Math.max(2, cw2 - 5), 1, '#ffe066');   // the booked entry
        px(cx3 + 1, cy3 + 1, 2, 1, '#fff4c0');
        px(cx3 + cw2 - 4, cy3 + 3, 2, 1, ACC.work);                 // done check, green
      } else {
        px(cx3 + 1, cy3 + 1, 2, 1, '#33301f');                      // unbooked cells keep faint print, not a hole
      }
      px(cx3 + cw2 - 4, cy3 + 1, 2, 1, '#3a352a');                  // date notch
      if (Math.floor(prog) === idx) {                               // TODAY: the flap mid-tick, ringed amber
        px(cx3, cy3, cw2 - 1, 1, '#ffe066'); px(cx3, cy3 + 3, cw2 - 1, 1, '#8a7a34');
        if (blink(400, ph)) px(cx3 + 1, cy3 + 2, Math.max(2, cw2 - 4), 1, '#fff4c0');   // the flap falling
        bloom(cx3, cy3, cw2 - 1, 4, ACC.flow, 0.22 + 0.06 * Math.sin(now / 300));
      }
    }
    scanl(x + 3, gT - 1, w - 6, 10, 0.12);                          // the glass over the paper
    px(x + 3, gT - 1, 6, 1, shade(r.face, 0.30));                 // one corner reflection on that glass
    // warm schedule light falling off the board's bottom edge onto the posts below it
    spill(x + 4, bT + bH, w - 8, ACC.flow, on ? 0.20 : 0.13, 5);
  };

  F.tube = (x, y, w, h, f) => { // v4 pneumatic tube (2x1) — glass barrel on saddles; warm crown vs cool belly
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    shadow2(x + 1, y + h - 1, w - 2);
    for (const sx2 of [x + 3, x + w - 7]) {                     // cradle stands with a saddle the glass sits in
      chamf(sx2 - 1, y + 4, 6, h - 5, LINE, 1);
      px(sx2, y + 5, 4, h - 7, r.face);
      px(sx2, y + 5, 1, h - 7, r.lit); keyEdge(sx2, y + 5, 1, 3, 0.18);
      px(sx2 + 3, y + 5, 1, h - 7, r.dk); rimEdge(sx2 + 3, y + 5, 1, 4, 0.20);
      px(sx2, y + 4, 4, 1, shade(r.top, 0.10));               // saddle lip
      px(sx2 - 1, y + h - 2, 6, 1, r.ao);
    }
    const per = on ? 520 : 800;                                 // end lights run hot while the line is live
    px(x + 4, y + 6, 2, 2, blink(per, ph) ? ACC.flow : '#2e3840');
    px(x + w - 6, y + 6, 2, 2, blink(per, 1 + ph) ? ACC.flow : '#2e3840');
    if (blink(per, ph)) bloom(x + 4, y + 6, 2, 2, ACC.flow, 0.20);
    px(x + (w >> 1) - 3, y + 5, 6, 4, LINE);                    // pressure gauge (kept wobble)
    px(x + (w >> 1) - 2, y + 6, 4, 2, '#1b2226'); px(x + (w >> 1) - 2, y + 6, 4, 1, shade(r.face, 0.14));
    px(x + (w >> 1) - 1 + Math.round(Math.sin(now / 400 + ph)), y + 7, 1, 1, ACC.flow);
    // the GLASS BARREL: dark core, a warm specular line along the crown, cool floor bounce along the belly
    chamf(x - 1, y - 4, w + 2, 10, LINE, 2);
    chamf(x, y - 3, w, 8, '#18202a', 2);
    px(x + 3, y - 3, w - 6, 1, '#33434f');
    px(x + 3, y - 2, w - 6, 1, '#5a7484'); keyEdge(x + 4, y - 2, 8, 1, 0.26);
    px(x + 2, y + 3, w - 4, 1, '#0d151b');                      // belly shadow
    rimEdge(x + 3, y + 2, w - 6, 1, 0.16);
    glow(x + 4, y - 2, 3, 4, '#dfe9f0', 0.10);                  // glass highlight (kept)
    const cyc = (now / 900 + ph * 0.13) % 1;                    // capsule whoosh (kept)
    if (cyc < 0.4) {
      const capx = x + 4 + Math.floor(cyc / 0.4 * (w - 11));
      px(capx, y - 1, 3, 2, ACC.flow); px(capx, y - 1, 3, 1, '#fff4c0');
      px(capx - 1, y - 1, 1, 2, shade(ACC.flow, -0.45)); px(capx - 2, y, 1, 1, shade(ACC.flow, -0.62)); // speed lines
      bloom(capx, y - 1, 3, 2, ACC.flow, 0.30);
      spill(capx - 2, y + 4, 7, ACC.flow, 0.16, 3);             // the capsule lights the cradle as it passes
    } else if (cyc < 0.45 && blink(80, ph)) {
      px(x + w - 8, y - 1, 2, 2, '#fff4c0'); bloom(x + w - 8, y - 1, 2, 2, ACC.flow, 0.34);   // arrival flash (kept)
    } else {
      px(x + 5, y, 2, 1, '#20303c');                            // a resting slug, so the glass is never empty
    }
    for (const end of [[x, 1], [x + w - 3, 0]]) {               // brass end fittings, lit west / shaded east
      px(end[0], y - 3, 3, 8, '#4e5a64'); px(end[0], y - 3, 3, 1, '#6e7c86'); px(end[0], y + 4, 3, 1, '#2a343c');
      if (end[1]) { px(end[0], y - 3, 1, 8, '#68757f'); keyEdge(end[0], y - 2, 1, 4, 0.20); }
      else { px(end[0] + 2, y - 3, 1, 8, '#333d45'); rimEdge(end[0] + 2, y - 2, 1, 4, 0.20); }
    }
    px(x + (w >> 1) - 1, y - 4, 2, 10, LINE);                   // centre clamp ring (kept)
    px(x + (w >> 1) - 1, y - 3, 2, 8, '#46525c'); px(x + (w >> 1) - 1, y - 3, 2, 1, '#5f6d78');
    cable(x + 2, y + 4, x + 7, y + 7, 1.6, '#141b20');          // limp feed hose off the west fitting
  };

  F.parcels = (x, y, w, h) => {
    // PARCELS (1x2) — the family's TALL entry: a leaning tower of taped parcels. Same fibreboard material
    // as BOXES (labels, tape, no castings) but stacked, so the silhouette is the point — each tier is
    // offset a bold 2px and the top one juts past the footprint. v4 adds a contact shade under every tier
    // (without it the stack reads as decals on one column) and a warm key on each lid.
    const cw = w, floorY = y + h - 1;
    shadow2(x + 1, floorY, cw - 2);
    const parcel = (bx, fb, bw, fh, ramp, tint) => {
      const ty = fb - fh;
      rr(bx, ty, bw, fh, LINE);
      px(bx + 1, ty + 2, bw - 2, fh - 3, ramp.face);                   // front face
      px(bx + 1, ty + 2, 1, fh - 3, ramp.lit);
      px(bx + bw - 2, ty + 2, 1, fh - 3, ramp.dk);
      rimEdge(bx + bw - 2, ty + 2, 1, fh - 3, 0.18);                   // cool bounce, shade side
      px(bx + 1, fb - 1, bw - 2, 1, ramp.ao);                          // base AO
      px(bx + 1, ty + 1, bw - 2, 2, ramp.top);                         // lid slab (top-bias)
      px(bx + 1, ty + 1, bw - 2, 1, ramp.sheen);
      keyEdge(bx + 1, ty + 1, Math.max(2, bw - 5), 1, 0.28);           // warm ceiling strip on the lid
      px(bx + (bw >> 1) - 1, ty + 2, 2, fh - 3, shade(ramp.face, 0.16));   // vertical tape
      px(bx + 1, ty + 4, bw - 2, 1, shade(ramp.face, -0.20));        // horizontal tape shade
      px(bx + 2, ty + 3, 3, 1, '#d8e0d6');                             // shipping label
      px(bx + bw - 4, ty + 1, 2, 1, tint);                             // colour tab on the lid
      px(bx + bw - 4, ty + 3, 2, 1, shade(tint, -0.2));              // sticker on the face
    };
    parcel(x + 0, floorY, cw + 0, 8, RAMP.steel, ACC.flow);            // base carton, full width
    px(x + 3, floorY - 8, cw - 4, 1, '#0a0e0c');                       // the tier above presses into it
    parcel(x + 2, floorY - 8, cw - 3, 7, RAMP.fabric, ACC.data);       // middle, leaning EAST
    px(x + 1, floorY - 15, cw - 5, 1, '#0a0e0c');
    parcel(x - 1, floorY - 15, cw - 4, 6, RAMP.steel, ACC.alert);      // upper, leaning WEST past the footprint
    // small crowning parcel catching the most light + a hanging manifest tag (breaks the boxy outline)
    const tb = floorY - 21, tx = x + 2;
    px(tx + 1, tb, 5, 1, '#0a0e0c');
    rr(tx, tb - 5, 7, 5, LINE);
    px(tx + 1, tb - 3, 5, 2, RAMP.fabric.face); px(tx + 1, tb - 3, 1, 2, RAMP.fabric.lit);
    rimEdge(tx + 5, tb - 3, 1, 2, 0.18);
    px(tx + 1, tb - 4, 5, 2, RAMP.fabric.top); px(tx + 1, tb - 4, 5, 1, RAMP.fabric.sheen);
    keyEdge(tx + 1, tb - 4, 3, 1, 0.28);
    px(tx + 4, tb - 3, 1, 1, ACC.work);                                // sticker
    cable(tx + 6, tb - 4, tx + 8, tb - 1, 1.2, '#6a6256');             // tag string off the top corner
    px(tx + 8, tb - 1, 2, 3, '#c9c2b0'); px(tx + 8, tb - 1, 2, 1, '#e4dcc8');   // the manifest tag itself
    px(tx + 8, tb + 1, 2, 1, '#8a8474');
    px(x + (cw >> 1), floorY - 11, 1, 1, shade('#fff4c8', -0.35));   // strap buckle — a still stack cannot glint
    px(x + (cw >> 1) - 1, floorY, 3, 1, shade(RAMP.steel.face, -0.22));                 // base scuff
  };

  F.core = (x,y,w,h,f) => {
    // Armoured memory cartridge: a faceted central chamber clamped between cooling crowns.
    const r=EQUIPMENT,b=INSTRUMENT,M=ACC.mem,on=!!(f&&f.work),base=y+h;
    shadow2(x+1,base-1,w-2);deckPlate(x,base-4,w,4);deckSocket(x+w+1,base-3,on);
    // Flared upper and lower collars establish a waist around the protected glass.
    chamf(x,y-7,12,6,b.ink,2);px(x+2,y-6,8,2,r.top);px(x+3,y-6,5,1,r.lit);
    for(let i=0;i<3;i++){px(x+2+i*3,y-4,2,2,b.ao);px(x+2+i*3,y-4,2,1,r.mid);}
    chamf(x+1,y-1,10,17,b.ink,2);
    // Broad chamber with dark edges and a narrow reflection, not a flat luminous stripe.
    px(x+3,y,6,14,shade(M,on?-0.50:-0.78));
    px(x+4,y,4,14,shade(M,on?-0.24:-0.64));
    px(x+4,y+1,1,11,on?'#b1a0cd':'#665c7b');
    px(x+7,y+1,1,12,shade(M,-0.62));
    // Three separate memory wafers float inside the chamber; movement is tied to work.
    const phase=on?Math.floor(now/400)%3:0;
    for(let k=0;k<3;k++){const yy=y+3+k*4;px(x+4,yy,4,2,shade(M,on?0.02:-0.45));px(x+4,yy,3,1,on&&k===phase?'#eddfff':shade(M,-0.16));}
    // External ribs remain metal and interrupt the silhouette beside the glass.
    for(const yy of [y+1,y+6,y+11]){
      px(x,yy,3,3,b.ink);px(x,yy,2,1,r.mid);px(x+1,yy+1,1,2,r.face);
      px(x+9,yy,3,3,b.ink);px(x+10,yy,2,1,r.face);px(x+10,yy+1,1,2,r.dk);
    }
    px(x+2,y-1,2,2,r.mid);px(x+8,y-1,2,2,r.face);
    chamf(x,y+16,12,6,b.ink,1);panelFinish(x+1,y+17,10,4,r);
    for(let i=0;i<3;i++){px(x+3+i*2,y+18,1,2,b.ao);}
    captiveBolt(x+1,base-3,r);captiveBolt(x+9,base-3,r);
    if(on){bloom(x+4,y+2,4,11,M,0.12);spill(x+3,base-3,6,M,0.12,3);}
  };
  F.shelf = (x, y, w, h, f) => {
    /* v41 STORAGE RACK (4x1) — PROJECTION FIXED and SHORTENED (2026-08-17).
       v40's vocabulary is kept exactly — asymmetric silhouette (wide well west, ONE tall emissive
       channel east), brass shoulder bands, vented plinth, bolted deck plate and floor socket — but
       two things about it were wrong:
       ⛔ IT WAS A FRONT ELEVATION. Five rows of "cap" that were all face and no top, 1px shelf
          boards, and contents whose tops were single lines: the picture you get standing in front of
          a rack. Same defect the bookshelf and the fish tank were rebuilt for — AT EYE LEVEL EVERY
          HORIZONTAL IS A 1px LINE, FROM ABOVE EVERY HORIZONTAL IS A PLANE.
       ⛔ IT WAS TOO TALL. 38 rows over a 12px-deep footprint made it the tallest thing in any room
          it landed in and it read as a wall; 26 reads as a rack.
       The contents stay STATION HARDWARE — cases, collared canisters, drive units, cartridges, all
       of them countable steel — but every one now carries a lit TOP, standing on the far edge of a
       board whose own top surface shows in front of it. ⛔ Binders were tried here and cut: coloured
       book spines turn a bolted equipment rack into library furniture, and this prop is FILES the
       capability, not files the stationery. */
    const r = EQUIPMENT, br = MAT.brass, on = !!(f && f.work);
    const base = y + h, top = base - 26;
    const G = ACC.work;
    /* the row budget: top+0..4 cap top plane · +5 cap face · +6 the well's ceiling
       +7..11 upper bay · +12..13 board top plane · +14 board edge · +15..19 lower bay
       +20..21 vented plinth · then the deck plate carries the last 4 rows to the floor */
    const CAP = top, BODY = top + 7, BRD = top + 12, LOW = top + 15, PL = top + 20;

    shadow2(x + 2, base - 1, w - 4);
    deckPlate(x + 1, base - 4, w - 2, 4);
    deckSocket(x + w + 1, base - 3, on);

    /* ---- THE CAP, as a PLANE we look down onto: 5 rows ramping far->near, keyed down the WEST rail.
            ⛔ the far row is inset 1px or its lit corner sits outside the contour and the whole cap
            reads as a lid laid on the rack. ---- */
    px(x, CAP, w, 6, r.ink);
    for (let j = 0; j < 5; j++) {
      const i = j ? 1 : 2;
      px(x + i, CAP + j, w - i * 2, 1, j === 4 ? r.mid : shade(r.face, -0.10 + j * 0.06));
    }
    px(x + 2, CAP + 1, 2, 4, r.mid);                                 // WEST RAIL, end to end
    px(x + w - 3, CAP + 1, 1, 4, r.dk); rimEdge(x + w - 3, CAP + 1, 1, 4, 0.16);
    px(x + 5, CAP + 2, w - 22, 1, shade(r.face, 0.16));            // ONE seam across the plane, not grain
    px(x + 2, CAP + 4, w - 4, 1, r.mid);                             // the front nosing takes the strip
    px(x + 1, CAP + 5, w - 2, 1, r.mid);                             // and the cap's own short FACE
    px(x + 6, CAP + 5, w - 18, 1, on ? G : shade(G, -0.62));       // indicator strip, on the face
    if (on) bloom(x + 6, CAP + 5, w - 18, 1, G, 0.20);
    px(x + 1, CAP + 6, w - 2, 1, r.ao);                              // its underside, occluding the well

    /* ---- BODY ---- */
    px(x, BODY, w, base - BODY - 4, r.ink);
    px(x + 1, BODY, w - 2, base - BODY - 5, r.face);
    px(x + 1, BODY, 1, base - BODY - 5, r.mid);
    px(x + w - 2, BODY, 1, base - BODY - 5, r.dk);
    px(x + 1, BODY, 4, 1, br.mid); px(x + w - 5, BODY, 4, 1, br.ao);   // brass shoulder bands

    /* ---- THE WELL: three walls, so it is a box and not a black rectangle ---- */
    const wX = x + 2, wW = w - 12;
    px(wX, BODY, wW, PL - BODY, r.ao);
    px(wX, BODY, wW, 1, '#0a0e11');                                  // the cap's shadow, cast down
    px(wX, BODY, 1, PL - BODY, shade(r.ao, 0.22));                 // west inner return, lit
    px(wX + wW - 1, BODY, 1, PL - BODY, shade(r.ao, -0.30));       // east inner return, in shade

    /* ---- UPPER BAY: a latched case, two collared canisters, a drive unit ---- */
    px(wX + 2, BRD - 6, 9, 6, r.ink);
    px(wX + 3, BRD - 6, 7, 1, r.lit);                                // the case's own TOP, not a line
    px(wX + 3, BRD - 5, 7, 4, r.top);
    px(wX + 3, BRD - 3, 7, 1, r.mid); px(wX + 5, BRD - 2, 3, 1, r.hi);
    for (const cxi of [wX + 13, wX + 17]) {
      px(cxi, BRD - 7, 3, 7, r.ink);
      px(cxi, BRD - 7, 3, 1, r.lit);                                 // the cap, which is what you see from above
      px(cxi + 1, BRD - 6, 1, 6, r.top);
      px(cxi + 1, BRD - 4, 1, 1, br.mid);                            // brass collar
    }
    px(wX + 22, BRD - 6, 11, 6, r.ink);
    px(wX + 23, BRD - 6, 9, 1, r.lit);                               // the drive unit's TOP
    px(wX + 23, BRD - 5, 9, 4, r.top);
    px(wX + 24, BRD - 3, 3, 1, r.hi);
    px(wX + 30, BRD - 3, 1, 1, blink(420) ? G : shade(G, -0.66));

    /* ---- THE BOARD: 2 rows of TOP SURFACE with the binders standing on its far edge ---- */
    px(wX, BRD, wW, 2, r.face);
    px(wX, BRD, wW, 1, shade(r.face, 0.10)); px(wX + 1, BRD + 1, wW - 2, 1, r.mid);
    px(wX, BRD, 1, 2, r.lit); keyEdge(wX, BRD, 1, 2, 0.16);          // keyed down the west rail again
    px(wX + wW - 1, BRD, 1, 2, r.dk);
    px(wX, BRD + 2, wW, 1, '#080b0e');                               // the board's own thickness

    /* ---- LOWER BAY: a flight case lying flat, cartridges, a comms module ---- */
    px(wX + 2, LOW + 1, 11, 4, r.ink);
    px(wX + 3, LOW + 1, 9, 2, r.top);                                // its lid, seen from above
    px(wX + 3, LOW + 1, 9, 1, r.lit);
    px(wX + 3, LOW + 3, 9, 1, r.mid);
    for (const lx of [wX + 4, wX + 10]) { px(lx, LOW + 3, 2, 2, r.mid); px(lx, LOW + 3, 2, 1, r.hi); }
    for (let k = 0; k < 3; k++) {                                    // cartridges, each with a lit top
      const cx0 = wX + 15 + k * 3;
      px(cx0, LOW, 3, 5, r.ink);
      px(cx0 + 1, LOW, 1, 1, r.lit);
      px(cx0 + 1, LOW + 1, 1, 4, k === 3 ? r.face : r.top);
    }
    px(wX + 25, PL - 5, 9, 5, r.ink);
    px(wX + 26, PL - 5, 7, 1, r.lit);                                // the module's TOP
    px(wX + 26, PL - 4, 7, 3, r.top);
    px(wX + 27, PL - 2, 5, 1, r.mid);
    px(wX + 32, PL - 4, 1, 1, blink(760) ? G : shade(G, -0.66));

    /* ---- RIGHT COLUMN: one tall glowing channel ---- */
    const chX = x + w - 8;
    px(chX, BODY, 5, PL - BODY, r.ao);
    px(chX + 2, BODY + 1, 1, PL - BODY - 2, on ? G : shade(G, -0.70));
    if (on) {
      px(chX + 2, BODY + 4, 1, 5, '#d6ffe8');
      bloom(chX + 1, BODY + 2, 3, PL - BODY - 4, G, 0.13);
      spill(x + 2, base - 5, w - 4, G, 0.12, 4);
    }
    px(chX + 1, BODY, 1, PL - BODY, r.mid);
    for (let k = 0; k < 3; k++) px(chX + 3, BODY + 3 + k * 4, 1, 2, r.dk);   // housing ticks

    /* ---- VENTED PLINTH + FEET ---- */
    px(wX, PL, 14, 4, r.ink);
    px(wX + 1, PL, 12, 1, r.mid);                                    // the plinth's own top, lit
    px(wX + 1, PL + 1, 12, 2, r.top);
    for (let ry = 0; ry < 2; ry++) for (let rx = 0; rx < 5; rx++)
      px(wX + 3 + rx * 2, PL + 1 + ry, 1, 1, r.ao);
    px(x + 1, base - 3, w - 2, 1, r.mid); px(x + 1, base - 2, w - 2, 1, r.ao);
    px(x, base - 2, 5, 2, r.ink); px(x + w - 5, base - 2, 5, 2, r.ink);
    px(x + 1, base - 2, 3, 1, r.mid); px(x + w - 4, base - 2, 3, 1, r.mid);
  };

  F.bar = (x, y, w, h, f) => {
    /* ⛔ EDGES SOFTENED, NOTHING ELSE — shipped geometry, shading and colour untouched. The
       universal near-black contour becomes a dark tint so the prop stops reading as a sticker
       cut out and laid on the deck. Same EDGE the couch uses, so the lounge reads as one room. */
    const EDGE = '#161d22';
    // BAR (4x1) — v6 detail pass. v4 had the right ANATOMY (counter, kick rail, back shelf) and read as
    // a grey service counter anyway, for three reasons, all fixed here:
    //   (1) the top was RAMP.steel, so the widest lounge prop in the game was the same material as the
    //       routers and the vault. It is timber now, with a brass nosing — the only warm big surface in
    //       the room, which is what a bar is for.
    //   (2) the back shelf stood on two 2px stubs 6px clear of the counter and read as FLOATING. It now
    //       lands on two full-height end standards with a mid rail, so it is visibly one piece of joinery.
    //   (3) the bottles were 2px blocks. A bottle is a NECK over a shoulder over a body — three rows,
    //       not one — and that is the whole difference between a bottle rack and a colour bar chart.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const WD = '#5a3f28', WD_LIT = '#7d5a3a', WD_DK = '#33230f';        // counter timber
    // BRASS, DEEP not bright. The first pass used #b8953f/#e0c06a and the nosing and the foot rail came
    // out as two full-width neon-yellow bars running the whole 48px — at that length any saturated tone
    // stops being trim and becomes a light fixture. Trim is a HIGHLIGHT on a dark metal, so the base
    // tone drops to a dim bronze and the bright value survives only in the short west-biased glint.
    const BRS = '#6b6250', BRS_LIT = '#9a917a';
    const MAROON = '#5e2233', MAROON_L = '#7d3247', MAROON_D = '#3a1420';                          // brass nosing + fittings
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 5]) {                              // end feet blocks, freestanding
      px(lx, y + 9, 3, 3, EDGE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    px(x + 4, y + 10, w - 8, 1, BRS);                                   // brass foot rail in the kick gap
    px(x + 4, y + 10, 7, 1, BRS_LIT);                                   // rail glint, west-biased
    px(x + 4, y + 11, w - 8, 1, '#2c363c');
    // ---- FRONT FACE: panelled timber. Deliberately plain and OPEN — this is the side agents walk up to.
    chamf(x - 1, y + 4, w + 2, 6, EDGE, 2);
    px(x, y + 5, w, 4, WD);
    px(x, y + 5, w, 1, WD_LIT); keyEdge(x + 1, y + 5, w - 3, 1, 0.16);
    for (let i = 0; i < 4; i++) {                                       // four recessed panels
      const pxx = x + 3 + i * 12;
      px(pxx, y + 6, 9, 2, shade(WD, -0.24));
      px(pxx, y + 6, 9, 1, shade(WD, -0.44)); px(pxx, y + 7, 9, 1, shade(WD, 0.10));
    }
    px(x + w - 1, y + 5, 1, 4, WD_DK); rimEdge(x + w - 1, y + 5, 1, 4, 0.20);
    px(x, y + 8, w, 1, shade(WD_DK, -0.34));
    bloom(x + 2, y + 8, w - 4, 1, ACC.lounge, on ? 0.28 : 0.15);   // under-counter accent — STEADY, see note
    // ---- COUNTER TOP: timber slab with a BRASS NOSING along the front lip. The nosing is the single
    // detail that says "bar" fastest, because no other prop in the catalog has a warm metal edge.
    chamf(x - 1, y - 3, w + 2, 9, EDGE, 2);
    chamf(x, y - 2, w, 7, WD, 2);
    px(x + 2, y - 2, w - 4, 1, WD_LIT); keyEdge(x + 2, y - 2, 10, 1, 0.28);
    px(x + 2, y - 1, w - 4, 1, shade(WD, 0.14));
    px(x + 2, y + 1, w - 4, 1, shade(WD, -0.10));   // the top falls away toward the user
    px(x + 2, y + 2, w - 4, 1, shade(WD, -0.22));
    for (let i = 0; i < 5; i++) px(x + 4 + i * 10, y, 5, 1, shade(WD, 0.08));   // grain along the top
    px(x, y, 1, 4, WD_LIT); px(x + w - 1, y, 1, 4, WD_DK); rimEdge(x + w - 1, y, 1, 4, 0.20);
    px(x + 1, y + 3, w - 2, 1, BRS); px(x + 1, y + 3, 9, 1, BRS_LIT);   // the brass nosing
    px(x + 1, y + 4, w - 2, 1, shade(BRS, -0.52));                    // its shadow onto the front face
    wear(x + 2, y - 1, w - 4, 4, 4, shade(WD, -0.12));
    // ---- BACK GANTRY: two end standards + a mid rail carry the shelf, so it is JOINERY, not a floater.
    const sy = y - 11, sw = 26, sxx = x + 5;
    for (const bx of [sxx, sxx + sw - 3]) {
      px(bx, sy + 5, 3, 8, EDGE);
      px(bx, sy + 5, 1, 8, shade(WD, 0.18)); px(bx + 1, sy + 5, 1, 8, WD); px(bx + 2, sy + 5, 1, 8, WD_DK);
      keyEdge(bx, sy + 6, 1, 5, 0.16); rimEdge(bx + 2, sy + 6, 1, 6, 0.18);
    }
    px(sxx + 2, sy + 9, sw - 4, 1, WD_DK); px(sxx + 2, sy + 9, 6, 1, shade(WD, 0.10));   // mid rail
    /* ---- BACK SHELF, rebuilt to Andrew's crop (2026-08-16). Same sxx/sy/sw as the shipped bar, so
       the prop's shape is untouched — only what sits inside the frame changed:
       ⛔ MUTED BOTTLES, NOT NEON. The shipped seven were saturated teal/magenta/cyan and read as a
          colour bar chart. Eight bottles in maroon, purple, rust and brown read as STOCK.
       ⛔ THREE PIXELS WIDE, WITH A CAP. At 2px a bottle is a stick; the third column carries the
          shaded flank and a 1px cap sits proud on top.
       ⛔ A PALE CHROME SHELF EDGE runs the full width under them — the one light value up here, and
          what makes the bottles read as standing ON something. ---- */
    chamf(sxx - 1, sy - 1, sw + 2, 8, EDGE, 2);
    chamf(sxx, sy, sw, 6, MAROON_D, 2);
    px(sxx + 1, sy, sw - 2, 2, MAROON);                                 // the maroon top rail
    px(sxx + 2, sy, sw - 4, 1, MAROON_L);
    px(sxx + 1, sy + 2, sw - 2, 3, '#160d12');                          // the dark well
    for (let i = 0; i < 8; i++) {
      const bc = ['#8e4356', '#6a4a8a', '#a8613a', '#7a5238', '#5f4a86', '#8e4356', '#6a4a8a', '#a8613a'][i];
      const bh2 = 2 + (i % 2), bxx = sxx + 1 + i * 3;
      px(bxx, sy + 5 - bh2, 3, bh2, shade(bc, -0.22));                // body
      px(bxx, sy + 5 - bh2, 3, 1, shade(bc, 0.30));                   // shoulder catch
      px(bxx + 2, sy + 6 - bh2, 1, bh2 - 1, shade(bc, -0.44));        // shaded flank
      px(bxx + 1, sy + 4 - bh2, 1, 1, shade(bc, 0.10));               // the cap, proud on top
    }
    px(sxx + 1, sy + 5, sw - 2, 1, '#b9c6cc');                          // PALE CHROME SHELF EDGE
    px(sxx + 1, sy + 6, sw - 2, 1, '#5d686e');
    px(sxx + 2, sy + 5, 7, 1, '#dde7ec');                               // one glint, west
    for (let i = 0; i < 4; i++)                                          // magenta blocks under the edge
      px(sxx + 4 + i * 6, sy + 7, 3, 1, on ? ACC.lounge : shade(ACC.lounge, -0.42));
    bloom(sxx + 1, sy + 2, sw - 2, 3, ACC.lounge, on ? 0.20 : 0.12);
    spill(sxx + 1, sy + 8, sw - 2, ACC.lounge, on ? 0.18 : 0.10, 4);
    px(sxx + sw - 4, sy + 1, 1, 1, '#33241a');                     // shelf pilot fitting, dark: see note
    // ---- TAP BANK: three taps on a shared plinth, rising off the back edge of the counter. SHORT and
    // in bronze, not tall and in chrome: a first pass ran them six rows of near-white up into the shelf
    // zone and they read as three lit CANDLES — the brightest thing on the prop, in front of the one
    // element (the bottle niche) that is supposed to be the light source.
    const tx = x + Math.round(w / 2) - 9;
    px(tx - 1, y - 1, 11, 2, shade(BRS, -0.34)); px(tx - 1, y - 1, 11, 1, BRS);
    for (let i = 0; i < 3; i++) {
      const tk = tx + i * 4;
      px(tk, y - 5, 1, 4, '#6c7a86'); px(tk, y - 5, 1, 2, '#96a4ae');   // the column
      px(tk, y - 6, 2, 1, BRS_LIT);                                     // the handle badge
      px(tk - 1, y - 2, 1, 1, '#7a8894');                               // spout
    }
    if ((now % 2400) < 200) px(tx + 3, y - 1, 1, 1, '#ffd9a0');         // a drip off the middle tap
    // ---- SERVICE ON THE COUNTER. Grouped west / centre / east so it reads as three stations, not litter.
    px(x + 5, y - 1, 3, 4, '#8a98a8'); px(x + 5, y - 1, 3, 1, BRS); px(x + 5, y - 1, 1, 4, '#c2ced6');  // can
    px(x + 10, y, 2, 3, '#7adfd0'); px(x + 10, y - 1, 2, 1, '#3a6a62'); px(x + 10, y, 1, 3, '#bffff2');  // bottle
    chamf(x + Math.round(w / 2) - 4, y + 1, 8, 3, '#1c2426', 1);        // bar mat
    px(x + Math.round(w / 2) - 3, y + 1, 6, 1, '#2a3436');
    for (const gx of [x + w - 14, x + w - 10]) {                        // two glasses, drying upside down
      px(gx, y - 1, 3, 4, '#93a8b4'); px(gx, y - 1, 3, 1, '#c6d6de');
      px(gx + 2, y, 1, 3, '#63757f'); px(gx, y + 3, 3, 1, '#4a585f');
    }
    px(x + w - 6, y + 1, 3, 2, '#dfe8df');                              // napkin stack
  };

  F.stool = (x, y, w, h, f) => {   // v4 gas-lift task stool — one big oval seat over a thin chrome stem
    // blocks:true, so this one IS a solid on the deck and keeps a real contact shadow. The whole read is
    // the fat seat against the thin stem: at 12px that contrast is the only thing distinguishing a stool
    // from a bollard.
    const r = RAMP.steel;
    shadow2(x + 3, y + 11, 7);                                  // real floor contact
    // splayed foot ring — an oval we look down on, so the base reads as five spokes, not a disc
    px(x + 3, y + 8, 6, 1, LINE); px(x + 2, y + 9, 8, 1, LINE); px(x + 3, y + 10, 6, 1, LINE);
    px(x + 3, y + 9, 6, 1, '#46535c');
    keyEdge(x + 3, y + 9, 3, 1, 0.24);                          // warm key on the ring's west arc
    rimEdge(x + 8, y + 9, 1, 1, 0.22);
    px(x + 3, y + 10, 2, 1, '#1a1e22'); px(x + 7, y + 10, 2, 1, '#1a1e22');   // rubber pads
    px(x + 2, y + 9, 1, 1, '#232b30'); px(x + 9, y + 9, 1, 1, '#161b1f');
    // chrome gas-lift stem. Chrome is two temperatures stacked, never a grey gradient: warm on the west
    // half, cold sky on the east, with a dark core between them.
    px(x + 4, y + 4, 4, 5, LINE);
    px(x + 5, y + 4, 1, 4, '#6d7a84'); px(x + 6, y + 4, 1, 4, '#39434b');
    keyEdge(x + 5, y + 4, 1, 4, 0.26); rimEdge(x + 6, y + 5, 1, 3, 0.28);
    px(x + 5, y + 6, 2, 1, '#7d8a94');                          // lift collar catches a hard line
    px(x + 8, y + 5, 2, 1, '#39434b'); px(x + 10, y + 5, 1, 1, '#1a1e22');   // adjust lever
    // BIG round cushioned seat — this is a top-down game, so the seat is the prop
    px(x + 3, y, 6, 1, LINE); px(x + 2, y + 1, 8, 1, LINE); px(x + 1, y + 2, 10, 2, LINE);
    px(x + 2, y + 4, 8, 1, LINE); px(x + 3, y + 5, 6, 1, LINE);
    px(x + 3, y + 1, 6, 1, '#4a8a82'); px(x + 3, y + 1, 3, 1, '#5aa89c');
    keyEdge(x + 3, y + 1, 4, 1, 0.22);                          // the crown of the pad takes the ceiling strip
    px(x + 2, y + 2, 8, 2, '#2f6a62');
    px(x + 2, y + 2, 1, 2, '#4a8a82'); px(x + 9, y + 2, 1, 2, '#26554e');
    rimEdge(x + 9, y + 2, 1, 2, 0.20);                          // cold bounce off the east flank of the pad
    px(x + 3, y + 3, 1, 1, '#26554e'); px(x + 8, y + 3, 1, 1, '#26554e');   // piping stitches (kept)
    px(x + 5, y + 2, 2, 1, shade('#2f6a62', 0.18));           // a soft crease where a body sits
    px(x + 3, y + 4, 6, 1, r.dk);                               // rounded underside rim
    px(x + 4, y + 5, 4, 1, shade(r.dk, -0.30));               // seat AO onto the stem
  };

  F.tv = (x, y, w, h, f) => {   // v4 TV (3x1) — chamfered panel on a credenza; screen faces SOUTH (its approach side)
    const r = RAMP.steel, ph = (f && f.x) || 0;
    const watched = !!(f && f.work);   // a couch-sitter is watching → the room actually catches the picture
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 5]) {                        // credenza feet, freestanding
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // credenza face: two real doors with recessed pulls, left open and uncluttered (agents walk up here)
    chamf(x - 1, y + 4, w + 2, 6, LINE, 2);
    px(x, y + 5, w, 4, r.face);
    px(x, y + 5, w, 1, r.lit); keyEdge(x + 1, y + 5, w - 3, 1, 0.16);
    for (const dx of [x + 12, x + 24]) { px(dx, y + 6, 1, 3, r.ao); px(dx + 1, y + 6, 1, 3, shade(r.face, 0.10)); }
    for (const pxx of [x + 5, x + 17, x + 29]) { px(pxx, y + 6, 2, 1, shade(r.face, -0.40)); px(pxx, y + 7, 2, 1, shade(r.face, 0.12)); }
    px(x + w - 1, y + 5, 1, 4, r.dk); rimEdge(x + w - 1, y + 5, 1, 4, 0.20);
    px(x, y + 8, w, 1, r.ao);
    // credenza top
    chamf(x - 1, y + 1, w + 2, 5, LINE, 2);
    chamf(x, y + 2, w, 3, r.top, 2);
    px(x + 2, y + 2, w - 4, 1, r.sheen); keyEdge(x + 2, y + 2, 8, 1, 0.26);
    px(x + 1, y + 4, w - 2, 1, shade(r.top, -0.16));
    // the PANEL: chamfered slab on a real pedestal foot, so it sits ON the credenza instead of hovering
    px(x + 12, y + 1, 12, 2, shade(r.top, -0.34)); px(x + 13, y + 1, 10, 1, shade(r.top, -0.12));  // foot pressed into the top
    px(x + 16, y - 1, 4, 3, shade(r.face, -0.12)); px(x + 16, y - 1, 1, 3, r.lit); px(x + 19, y - 1, 1, 3, r.dk);  // neck
    chamf(x + 2, y - 12, w - 4, 15, LINE, 2);
    chamf(x + 3, y - 11, w - 6, 13, '#12181d', 2);                // bezel
    px(x + 5, y - 11, w - 10, 1, '#26333a'); keyEdge(x + 5, y - 11, 7, 1, 0.24);   // warm catch along the crown
    px(x + 3, y - 9, 1, 9, '#1e2a30'); px(x + w - 4, y - 9, 1, 9, '#0b1013');
    rimEdge(x + w - 4, y - 9, 1, 9, 0.22);                        // cool sky bounce down the shade side
    const sx = x + 4, sy = y - 9, sw = w - 8, sh2 = 9;
    inset(sx - 1, sy - 1, sw + 2, sh2 + 2, '#06090c');            // glass well
    const mode = Math.floor(now / 4000) % 3;
    let cast = '#2a3a4a';                                          // the colour the room catches from this channel
    if (mode === 0) {                                              // static
      px(sx, sy, sw, sh2, '#101418');
      for (let i = 0; i < 30; i++) px(sx + (U.hash('tv' + i + Math.floor(now / 90)) % sw), sy + (U.hash('tw' + i + Math.floor(now / 90)) % sh2), 1, 1, '#9aa');
      px(sx, sy + (Math.floor(now / 130) % sh2), sw, 1, '#202830');   // rolling bar
      cast = '#8a9aa8';
    } else if (mode === 1) {                                       // movie: sunset over water
      for (let j = 0; j < sh2; j++) px(sx, sy + j, sw, 1, ['#2a5a7a', '#2a5a7a', '#35617c', '#41647a', '#2c4a62', '#1f3c56', '#1a3a5a', '#173350', '#142d47'][j]);
      px(sx + 3, sy + 2, 6, 2, '#e8c860'); px(sx + 4, sy + 1, 4, 1, '#f0d880');   // sun dome
      bloom(sx + 3, sy + 1, 6, 3, '#ffd9a0', 0.22);                // the sun actually blooms on the glass
      px(sx + 3, sy + 5, 6, 1, '#8a7a4a'); px(sx + 4, sy + 7, 4, 1, '#6a6038');   // water glints
      px(sx + 18, sy + 4, 8, 3, '#0e2436'); px(sx + 18, sy + 4, 8, 1, '#16344a'); // island + rim light
      cast = '#2a5a7a';
    } else {                                                       // news: anchor + headlines
      px(sx, sy, sw, sh2, '#3a1a2a');
      px(sx + 2, sy, 8, 1, '#4a2436');
      px(sx + 3, sy + 1, 5, 5, '#caa088'); px(sx + 4, sy + 2, 1, 1, '#222'); px(sx + 6, sy + 2, 1, 1, '#222');
      px(sx + 4, sy + 4, 3, 1, '#a08068');
      px(sx + 3, sy + 6, 5, 1, '#2a3a5a');                         // suit
      px(sx + 10, sy + 2, 12, 1, '#e0e0e0'); px(sx + 10, sy + 4, 9, 1, '#b0b0b0');
      px(sx + 10, sy + 2, 4, 1, '#f4f4f4');                        // headline pop
      px(sx, sy + 7, sw, 2, '#2a1220'); px(sx + 1 + (Math.floor(now / 160) % (sw - 11)), sy + 7, 10, 1, '#ff5c7a');  // ticker
      px(sx + sw - 6, sy, 4, 2, '#ff5c7a'); px(sx + sw - 5, sy, 2, 1, '#ffa8b8');  // LIVE bug
      cast = '#6a2a3a';
    }
    scanl(sx, sy, sw, sh2, watched ? 0.08 : 0.14);                 // an unwatched set reads dustier
    px(sx, sy, 6, 2, shade(cast, 0.45));                         // glass glint on the corner
    glow(sx, sy, 6, 2, '#dfe8f0', 0.07);
    bloom(sx, sy, sw, sh2, cast, watched ? 0.16 : 0.09);           // panel bloom with real falloff
    spill(sx, y + 2, sw, cast, watched ? 0.30 : 0.13, 5);          // picture light pools DOWN the credenza top
    // soundbar on the credenza + the chin badge
    px(x + 8, y + 3, w - 16, 1, '#161c22'); px(x + 8, y + 3, 1, 1, shade('#161c22', 0.5));
    for (let i = 0; i < 4; i++) px(x + 11 + i * 4, y + 3, 1, 1, watched && blink(240, i + ph) ? shade(cast, 0.4) : '#2e2e2e');
    px(x + Math.round(w / 2) - 1, y, 2, 1, '#1e262c');             // brand chip on the chin
    px(x + w - 6, y, 1, 1, watched ? '#ff6a6a' : (blink(1400, ph) ? '#ff3030' : '#3a1010'));   // standby LED
    cable(x + w - 5, y - 1, x + w - 2, y + 4, 1.6, '#0b1114');     // panel lead sagging behind the credenza
  };

  F.couch = (x, y, w, h, f) => {   // v4 sofa (5x1) — MATERIAL pass only. The BACK VIEW is locked: the sofa faces
    /* ⛔ EDGES SOFTENED, NOTHING ELSE. The shipped geometry, shading and colour are untouched — the
       only change is that the universal near-black contour (#06090c) becomes a dark tint of the
       couch's OWN blue-grey. A pure-black ring is what made it read as a sticker laid on the deck;
       everything else about this prop was already right. */
    const EDGE = '#161d22';
    const r = RAMP.fabric;         // north (the TV), so it reads as a sofa seen from behind.
    // Geometry — cap line, panel height, arm extents, cushion seams — is untouched on purpose. It USED to be
    // load-bearing: a couch seated a body and the renderer y-sorted that sitter against this silhouette.
    // Under the SEAT LAW (2026-08-04) nothing sits here any more, so the occlusion contract is gone; the
    // geometry is held only because this was a material pass, not a redraw.
    shadow2(x + 1, y + h - 1, w - 2);                             // floor contact; lounge tier stays freestanding
    // throw-pillow tops leaning on the far seat, just proud of the back line. Same 7x4 boxes as ever
    // (their columns are part of the locked occlusion silhouette) — v6 only gives them PATTERN and a
    // rounded shoulder, so they read as cushions instead of chiclets on a shelf.
    px(x + 6, y - 8, 7, 4, EDGE);
    px(x + 7, y - 7, 5, 3, '#2f6a62'); px(x + 7, y - 7, 5, 1, '#4a8a82');
    px(x + 8, y - 6, 1, 2, shade('#4a8a82', 0.16)); px(x + 10, y - 6, 1, 2, shade('#4a8a82', 0.16));   // woven stripes
    px(x + 7, y - 7, 1, 3, shade('#2f6a62', 0.18)); px(x + 11, y - 7, 1, 3, shade('#2f6a62', -0.24));
    px(x + 7, y - 7, 1, 1, EDGE); px(x + 11, y - 7, 1, 1, EDGE);   // rounded shoulders — a stuffed corner, not a card
    keyEdge(x + 8, y - 7, 3, 1, 0.20);
    px(x + w - 13, y - 8, 7, 4, EDGE);
    px(x + w - 12, y - 7, 5, 3, '#8a6a3a'); px(x + w - 12, y - 7, 5, 1, '#caa84a');
    px(x + w - 11, y - 6, 3, 1, shade('#8a6a3a', -0.20));        // a band across the amber one — the pair differ
    px(x + w - 12, y - 7, 1, 3, shade('#8a6a3a', 0.18)); px(x + w - 8, y - 7, 1, 3, shade('#8a6a3a', -0.24));
    px(x + w - 12, y - 7, 1, 1, EDGE); px(x + w - 8, y - 7, 1, 1, EDGE);
    rimEdge(x + w - 8, y - 7, 1, 3, 0.20);
    // backrest from behind: rounded lit cap + ONE tall rear panel dropping to the floor
    rr(x + 1, y - 5, w - 2, h + 5, EDGE);
    px(x + 2, y - 4, w - 4, 2, r.lit);                            // cap catches the light
    px(x + 2, y - 4, 8, 1, shade(r.lit, 0.10));
    keyEdge(x + 2, y - 4, 14, 1, 0.26);                           // warm ceiling strip along the crown
    rimEdge(x + w - 6, y - 4, 4, 1, 0.20);                        // cool sky bounce at the far end of the cap
    px(x + 2, y - 4, 1, 1, shade(r.lit, -0.14));                // cap corners rounded off — a roll, not a plank
    px(x + w - 3, y - 4, 1, 1, shade(r.lit, -0.18));
    px(x + 2, y - 3, w - 4, 1, shade(r.lit, -0.22));            // piping seam where the cap rolls into the panel
    px(x + 2, y - 2, w - 4, h, r.face);                           // rear upholstery panel
    // v6 MATERIAL: each 14px channel between the locked seams BULGES — a lit center column falling to
    // shaded edges — so the back reads as padded upholstery instead of one flat board. Geometry (cap
    // line, seam pitch, arm extents) is untouched: the sitter y-sort still matches this silhouette.
    // NO horizontal weave rows here — striped rows across lit channel bellies turned the back into a
    // louvre bank ("evenly spaced horizontals over a face = server rack", the locker law). Fabric is
    // sold by the VERTICAL roundness of each channel + sparse nap instead.
    for (let i = 0; i <= (w - 4) / 14; i++) {
      const c0 = x + 3 + i * 14, c1 = Math.min(x + 2 + (i + 1) * 14, x + w - 3);
      const cwd = c1 - c0; if (cwd < 6) continue;
      px(c0 + 2, y - 1, cwd - 4, h - 3, shade(r.face, 0.05));   // the bulge's lit belly
      px(c0 + 3, y - 1, 3, h - 4, shade(r.face, 0.10));         // west-biased crown of the bulge
      px(c0 + 4, y - 1, 1, h - 5, shade(r.face, 0.15));         // crown core — a genuine round, 3 steps
      px(c0, y - 1, 1, h - 2, shade(r.face, -0.09));            // falling into the seam shade
      px(c1 - 1, y - 1, 1, h - 2, shade(r.face, -0.09));
      px(c0 + 1, y + h - 5, cwd - 2, 1, shade(r.face, -0.04));  // upholstery settles darker toward the skirt
      const bx = c0 + (cwd >> 1);                                 // tuft button, its catch above and shade below
      px(bx, y + 1, 1, 1, shade(r.face, -0.32));
      px(bx, y, 1, 1, shade(r.face, 0.18));
      px(bx - 1, y + 2, 1, 1, shade(r.face, -0.10));            // the button pulls a little diagonal crease
      px(bx + 1, y + 2, 1, 1, shade(r.face, -0.10));
    }
    px(x + 2, y - 2, 1, h, shade(r.face, 0.10));                // lit west facet
    px(x + w - 3, y - 2, 1, h, r.dk);                             // dark east facet
    rimEdge(x + w - 3, y - 2, 1, h - 2, 0.22);                    // cool bounce down the shade flank
    for (let i = 1; i < (w - 4) / 14; i++) {                      // cushion seams (these mark the cushions — locked)
      px(x + 2 + i * 14, y - 1, 1, h - 2, r.dk);
      px(x + 3 + i * 14, y - 1, 1, h - 3, shade(r.face, 0.09)); // the catch beside each seam gives the panel depth
    }
    wear(x + 2, y - 1, w - 4, h - 2, 6, shade(r.face, -0.08));
    px(x + 2, y + h - 4, w - 4, 1, shade(r.face, -0.12));       // skirt band: the upholstery stops before the floor
    px(x + 2, y + h - 3, w - 4, 1, shade(r.face, -0.18));       // kick-line shadow near the floor
    px(x + 2, y + h - 2, w - 4, 1, r.ao);                         // floor-line ambient occlusion
    // the pillows GROUND: each casts a soft notch onto the cap it leans over (they floated before)
    px(x + 7, y - 4, 5, 1, shade(r.lit, -0.16));
    px(x + w - 12, y - 4, 5, 1, shade(r.lit, -0.16));
    // arms: rounded caps that step DOWN from the back and wrap the ends to the floor
    for (const ax of [x, x + w - 4]) {
      rr(ax - 1, y - 3, 6, h + 3, EDGE);
      px(ax, y - 2, 4, h + 1, r.face);
      px(ax, y - 2, 4, 2, r.lit); px(ax, y - 2, 3, 1, shade(r.lit, 0.10));   // arm cap
      if (ax === x) { keyEdge(ax, y - 2, 4, 1, 0.24); px(ax, y, 1, h - 2, shade(r.face, 0.10)); }
      else { rimEdge(ax + 3, y - 2, 1, h, 0.20); px(ax + 3, y, 1, h - 2, r.dk); }
      px(ax, y, 4, 1, shade(r.face, -0.20));                    // roll seam under the arm cap
      px(ax === x ? ax + 4 : ax - 1, y - 1, 1, h - 1, shade(r.face, -0.16)); // elbow crease against the panel
      px(ax + 1, y + 2, 2, h - 5, shade(r.face, 0.05));         // the arm's own soft belly
      px(ax, y + h - 2, 4, 1, r.ao);                              // arm base AO
    }
  };

  F.recliner = (x, y, w, h, f) => {
    /* 1x1 RECLINER — one seat of the couch, FACING LEFT (Andrew: "just a small couch bro like a 1
       person recliner or side couch piece"). Built out of the sofa's own vocabulary — same fabric
       ramp, same crown roll, same throw pillow — so it stands beside the couch as part of a set.
       ⛔ IT FACES WEST AT r=0, which is the entire point: every other seat in the catalog faces the
          camera. M flips it east, so one prop furnishes both sides of a room.
       ⛔ THE OUTLINE MUST OPEN. Two drafts drew it as a filled rounded box and both read as an
          appliance. A seat seen from the side is a C: the two ARMS reach further west than the
          cushion between them, and the back stands PROUD of both. Those two notches — the open
          front and the step up to the back — are the whole silhouette; the shading inside changes
          nothing until they are there.
       ⛔ THE ARMS STOP AT THE BACK. Run them the full width and they paint over the back's crown,
          which leaves a stack of horizontal bands (that was draft one).
       ⛔ THE ART OVERHANGS ITS TILE (like couch:w) — a seat is deeper than one tile. What it BLOCKS
          is still the honest 1x1. */
    const EDGE = '#161d22';
    const r = RAMP.fabric;
    const ax = x - 3, aw = w + 6;                                // drawn 3px proud each side
    const BK = ax + 11, SW = ax + 4;                             // back's crown / the cushion's west edge
    shadow2(ax + 1, y + h - 1, aw - 2);
    /* (1) THE SILHOUETTE, opened: two arms reaching west, a cushion set back between them, and the
       back standing a row above both. One ink pass — never one box per part. */
    rr(BK - 1, y - 7, 7, h + 7, EDGE);                           // the back, tallest
    rr(ax, y - 5, 13, 5, EDGE);                                  // far (north) arm, reaching west
    rr(ax, y + 3, 13, 8, EDGE);                                  // near (south) arm
    rr(SW - 1, y - 2, 8, 7, EDGE);                               // the cushion, set BACK between them
    /* (2) THE CUSHION — inset, so the deck shows between the arms and the outline notches */
    px(SW, y - 1, 7, 5, r.face);
    px(SW, y - 1, 1, 5, shade(r.face, 0.14));                  // its west lip catches the strip
    px(SW + 1, y - 1, 4, 5, shade(r.face, 0.07));              // the soft belly
    px(SW + 5, y - 1, 2, 5, shade(r.face, -0.12));             // falling into the back's shade
    px(SW + 3, y + 1, 1, 1, shade(r.face, -0.34));             // tuft button
    px(SW + 2, y + 2, 1, 1, shade(r.face, -0.14)); px(SW + 4, y + 2, 1, 1, shade(r.face, -0.14));
    px(SW, y + 3, 7, 1, shade(r.face, -0.30));                 // the cushion's own front shadow
    /* (3) THE FAR ARM — a roll, lit on top, stopping at the back */
    px(ax + 1, y - 4, 11, 2, r.lit); keyEdge(ax + 1, y - 4, 6, 1, 0.26);
    px(ax + 1, y - 2, 11, 1, shade(r.lit, -0.30));             // piping under its crown
    px(ax + 1, y - 1, 3, 1, r.face); px(ax + 1, y - 1, 1, 1, shade(r.face, 0.12));   // its west end wraps down
    /* (4) ONE THROW PILLOW, propped where the back meets the cushion */
    px(SW + 3, y - 3, 5, 6, EDGE);
    px(SW + 4, y - 2, 3, 4, '#2f6a62'); px(SW + 4, y - 2, 3, 1, '#4a8a82');
    px(SW + 4, y - 1, 1, 2, shade('#4a8a82', 0.18)); px(SW + 6, y - 1, 1, 2, shade('#2f6a62', -0.26));
    px(SW + 4, y - 2, 1, 1, EDGE); px(SW + 6, y - 2, 1, 1, EDGE);   // stuffed corners, not a card
    /* (5) THE BACK — an unbroken crown down the east side, a row above both arms */
    px(BK, y - 6, 4, h + 6, r.lit);
    keyEdge(BK, y - 6, 4, 8, 0.24);
    px(BK, y - 6, 1, h + 6, shade(r.lit, 0.10));
    px(BK + 4, y - 6, 1, h + 6, shade(r.lit, -0.32));          // piping where the crown rolls over
    px(BK + 5, y - 5, 1, h + 4, r.dk); rimEdge(BK + 5, y - 5, 1, h + 4, 0.22);
    px(BK + 1, y - 6, 2, 1, shade(r.lit, 0.16));               // the crown's own catch
    /* (6) THE NEAR ARM last, so it wraps the cushion: crown, piping, then the south face + skirt.
       ⛔ ROW y+3 IS THE SEAT LINE. Everything from here down is what a sitting body disappears
          BEHIND — see RECLINER_FRONT_Y / drawSeatFront. Move this band and the sitter's shins
          either float in front of the arm or get swallowed to the waist. */
    px(ax + 1, y + 4, 11, 2, r.lit); keyEdge(ax + 1, y + 4, 6, 1, 0.28);
    px(ax + 1, y + 6, 11, 1, shade(r.lit, -0.26));
    px(ax + 1, y + 7, aw - 3, 3, r.face);
    px(ax + 1, y + 7, 1, 3, shade(r.face, 0.12)); px(ax + aw - 3, y + 7, 1, 3, r.dk);
    px(ax + 3, y + 8, aw - 7, 1, shade(r.face, 0.06));         // the arm's soft belly
    px(ax + 1, y + 10, aw - 3, 1, shade(r.face, -0.28));       // skirt
    px(ax + 1, y + 11, aw - 3, 1, r.ao);                         // floor-line AO
  };

  /* THE SAME SEAT, FACING RIGHT — shipped as its OWN catalog entry rather than as a flip you have to
     know about (Andrew: "ship them as 2 separate props to keep it easy"). It is not a second drawing:
     it is F.recliner under the same integer mirror the orientation system uses, so the two can never
     drift apart, and px()'s LSWAP re-lights it — the warm key stays high-west where the ceiling strip
     actually is, instead of riding the furniture round. */
  const mirrorTile = (x, y, w, fn) => {
    ctx.save();
    ctx.translate(x, y); ctx.translate(w, 0); ctx.scale(-1, 1); ctx.translate(-x, -y);
    const was = MIRROR; MIRROR = true;
    try { fn(); } finally { MIRROR = was; ctx.restore(); }
  };
  F.recliner_r = (x, y, w, h, f) => mirrorTile(x, y, w, () => F.recliner(x, y, w, h, f));

  /* THE SEAT LINE, per profile seat: px below the tile's top row where the near arm starts, i.e. the
     row a body sitting in this chair has to be BEHIND. drawSeatFront clips to it. Both entries are the
     same drawing, so both are step (6)'s `y + 3` — a horizontal mirror cannot move a horizontal band. */
  const RECLINER_FRONT_Y = { recliner: 3, recliner_r: 3 };

  F.arcade = (x, y, w, h, f) => {
    /* v57 ARCADE (1x2) — built to Andrew's reference (2026-08-16), SHORTENED 2026-08-17. Read top to
         bottom: vent cap -> glowing MARQUEE -> screen flanked by MAGENTA SIDE STRIPS -> pale CONTROL
         PANEL with a ball-top stick and four buttons -> lower cabinet with coin slot and vent -> plinth
       ⛔ IT STANDS INSIDE ITS OWN FOOTPRINT. v56 hung 12px above the 1x2 tile and measured 36px tall,
          while its own sibling F.arcade2 — same footprint, same category, and usually placed right
          beside it — measures 27px. Nine pixels taller than the identical machine next to it is not a
          style, it is a bug you can see across the room. Every band below is anchored to
          `T = base - 26`, exactly the way arcade2 is, so the whole cabinet lives in its two tiles.
          ⛔ DO NOT re-express these offsets against `y`: `y` moves with the footprint but `T` is
             pinned to the FLOOR, which is what keeps the two cabinets shoulder to shoulder.
       ⛔ THE SIDE STRIPS ARE THE THING I MISSED. Two magenta bars running the full height of the
          screen bay are what make the cabinet glow from within instead of just carrying a lit sign.
          They also frame the screen, which is why it reads as a cabinet and not a monitor.
       ⛔ THE CONTROL PANEL IS PALE. It is the one light-value plane on a near-black cabinet, and that
          contrast is what makes the joystick and buttons legible at 12px wide.
       ⛔ COUNTABLE CONTROLS, 2px EACH: a ball-top stick, two magenta buttons, two amber. Four marks.
       ⛔ The screen is a GAME — rows of invaders and a ship — never text. Blocky sprites only. */
    const r = MAT.steel, b = MAT.slate, on = !!(f && f.work);
    const P = ACC.lounge, A = ACC.flow;
    const EDGE = '#161d22';
    const base = y + h, cx = x + Math.round(w / 2), T = base - 26;
    const BODY = '#2a3138', BODY_D = '#1b2126';

    shadow2(x + 1, base - 1, w - 2);

    /* ---- VENT CAP above the marquee ---- */
    px(x + 2, T, w - 4, 2, EDGE);
    px(x + 3, T, w - 6, 1, r.mid);   // one grey row, not r.lit — at 2px tall a highlight reads as a white slab

    /* ---- MARQUEE: the lit sign, proud of the cabinet, with brighter end caps ---- */
    px(x, T + 2, w, 5, EDGE);
    px(x + 1, T + 3, w - 2, 3, shade(P, -0.26));
    px(x + 1, T + 3, w - 2, 1, shade(P, 0.30));                   // lit top edge
    px(x + 1, T + 3, 1, 3, '#ffd0f4'); px(x + w - 2, T + 3, 1, 3, '#ffd0f4');   // end caps
    px(x + 3, T + 4, 2, 1, '#ffe8f8'); px(x + 7, T + 4, 2, 1, '#ffe8f8');       // two glyph blocks
    bloom(x + 1, T + 3, w - 2, 3, P, 0.26);

    /* ---- CABINET BODY ---- */
    px(x, T + 6, w, base - T - 6, EDGE);
    px(x + 1, T + 7, w - 2, base - T - 8, BODY);
    px(x + 1, T + 7, 1, base - T - 8, r.mid); px(x + w - 2, T + 7, 1, base - T - 8, BODY_D);

    /* ---- SCREEN BAY: magenta strips flanking a green CRT ---- */
    const sy = T + 8, sh = 7;
    px(x + 1, sy - 1, w - 2, sh + 2, EDGE);
    px(x + 1, sy, 1, sh, on ? P : shade(P, -0.50));               // WEST light strip
    px(x + w - 2, sy, 1, sh, on ? P : shade(P, -0.50));           // EAST light strip
    if (on) { bloom(x + 1, sy, 1, sh, P, 0.24); bloom(x + w - 2, sy, 1, sh, P, 0.24); }
    px(x + 2, sy, w - 4, sh, '#04120a');
    if (on) {
      const sc = scr((f && f.x) || 0);
      px(x + 2, sy, w - 4, sh, shade(sc, -0.78));
      const drift = Math.floor(now / 700) % 2;
      for (let ry = 0; ry < 2; ry++)                                // two rows of invaders
        for (let rx = 0; rx < 3; rx++)
          px(x + 3 + rx * 2 + drift, sy + 1 + ry * 2, 2, 1, shade(sc, 0.24));
      px(cx - 1, sy + 5, 2, 1, '#eaffe8');                          // the ship
      px(cx, sy + 4, 1, 1, '#eaffe8');
      px(x + 3, sy + 6, 4, 1, shade(sc, 0.10));                   // a ground line
      scanl(x + 2, sy, w - 4, sh, 0.20);
      bloom(x + 2, sy, w - 4, sh, sc, 0.16);
    } else {
      px(x + 3, sy + 1, 3, 1, '#16231b'); px(x + 4, sy + 2, 2, 1, '#111c15');
    }

    /* ---- CONTROL PANEL: the pale plane, stepping OUT from the cabinet ---- */
    px(x - 1, T + 15, w + 2, 4, EDGE);
    px(x, T + 16, w, 2, '#9aa7ae');                                 // the pale deck
    px(x, T + 16, w, 1, '#c2ccd2');
    px(x + 1, T + 16, 2, 2, P);                                     // ball-top joystick
    px(x + 1, T + 16, 2, 1, '#ffd0f4');
    px(x + 5, T + 16, 2, 1, P); px(x + 8, T + 16, 2, 1, P);         // two magenta buttons
    px(x + 5, T + 17, 2, 1, A); px(x + 8, T + 17, 2, 1, A);         // two amber buttons
    px(x - 1, T + 19, w + 2, 1, r.ao);                              // the shade the panel throws

    /* ---- LOWER CABINET: magenta lamp, coin slot, vent grille ---- */
    px(x + 1, T + 20, w - 2, 3, BODY);
    px(x + 1, T + 20, w - 2, 1, BODY_D);
    px(x + 2, T + 21, 2, 2, on ? P : shade(P, -0.55));            // the lamp
    if (on) bloom(x + 2, T + 21, 2, 2, P, 0.22);
    px(x + 5, T + 21, 2, 2, b.ao);                                  // coin slot
    px(x + 5, T + 21, 2, 1, r.mid);
    px(x + 5, T + 22, 1, 1, A);
    px(x + 8, T + 20, 3, 3, b.ao);                                  // vent grille
    for (let k = 0; k < 2; k++) px(x + 8, T + 20 + k * 2, 3, 1, r.dk);

    /* ---- PLINTH with magenta ticks ---- */
    px(x, base - 3, w, 3, EDGE);
    px(x + 1, base - 2, w - 2, 1, r.mid);                           // the plinth's ONE lit row
    for (let k = 0; k < 3; k++) px(x + 6 + k, base - 2, 1, 1, on ? P : shade(P, -0.60));
    px(x + 2, base - 2, 3, 1, b.ao);
    // base-1 stays EDGE: the cabinet needs a dark row ON the floor or it reads as standing on a
    // pale kick and floats. A 2-row lit plinth was the first thing wrong with the shortened version.
  };

  F.arcade2 = (x, y, w, h, f) => {
    /* v67 ARCADE II (1x2) — built to Andrew's reference (2026-08-16), read top to bottom:
         MARQUEE with teal end strips -> deep bezel over a teal CRT running a platformer -> pale CONTROL
         DECK with a ball-top stick and two buttons -> lower cabinet with a COIN DOOR -> a bright teal
         LIGHT BAR across the kick.
       ⛔ TEAL IS THE WHOLE IDENTITY. This is the sibling of F.arcade, which owns magenta. Every emissive
          here is one teal family so the two cabinets never read as the same machine in a different mood.
       ⛔ THE CONTROL DECK IS THE ONE PALE PLANE on a near-black cabinet — that contrast is what makes a
          stick and two buttons legible at 12px wide.
       ⛔ THE LIGHT BAR AT THE KICK is the reference's signature: one long bright run low on the cabinet,
          which grounds it and throws the only spill onto the deck. */
    const EDGE = '#141a1e';
    const on = !!(f && f.work), ph = (f && f.x) || 0;
    const BODY = '#2b333a', BODY_D = '#1a2025', BODY_L = '#3b454e';
    const T_LIT = '#4fdcb8', T_MID = '#2f9d86', T_DK = '#155048', SCR = '#0d2a26';
    const PALE = '#8e9aa2', PALE_L = '#b6c0c6';
    const base = y + h, T = base - 26;
    const glowT = c => on ? c : shade(c, -0.55);

    shadow2(x + 1, base - 1, w - 2);

    /* ---- MARQUEE: lit sign between two teal end strips ---- */
    px(x, T, w, 5, EDGE);
    px(x + 1, T + 1, w - 2, 3, BODY_D);
    px(x + 1, T + 1, 1, 3, glowT(T_LIT)); px(x + w - 2, T + 1, 1, 3, glowT(T_LIT));   // end strips
    px(x + 3, T + 1, w - 6, 3, glowT(T_DK));
    px(x + 3, T + 2, 3, 1, glowT(T_LIT)); px(x + 7, T + 2, 2, 1, glowT(T_LIT));       // two glyph runs
    px(x + 3, T + 3, 5, 1, glowT(T_MID));
    if (on) bloom(x + 1, T + 1, w - 2, 3, T_LIT, 0.24);
    px(x + 1, T, w - 2, 1, BODY_L);

    /* ---- CABINET BODY ---- */
    px(x, T + 5, w, base - T - 5, EDGE);
    px(x + 1, T + 6, w - 2, base - T - 7, BODY);
    px(x + 1, T + 6, 1, base - T - 7, BODY_L); px(x + w - 2, T + 6, 1, base - T - 7, BODY_D);
    rimEdge(x + w - 2, T + 7, 1, 14, 0.16);

    /* ---- SCREEN BAY: deep bezel, then the game ---- */
    px(x + 1, T + 6, w - 2, 9, EDGE);
    px(x + 2, T + 6, w - 4, 1, BODY_L);                               // bezel's lit crown
    px(x + 2, T + 7, w - 4, 7, SCR);
    if (on) {
      const drift = Math.floor(now / 620) % 3;
      px(x + 3, T + 8, 1, 1, T_MID); px(x + 5, T + 8, 1, 1, T_MID); px(x + 8, T + 8, 1, 1, T_MID);  // sky blocks
      px(x + 5 + drift, T + 10, 2, 1, T_MID);                         // a floating platform
      px(x + 4, T + 11, 1, 2, T_LIT); px(x + 3, T + 12, 3, 1, T_LIT); // the little runner
      px(x + 4, T + 10, 1, 1, T_LIT);
      px(x + 2, T + 13, w - 4, 1, T_MID);                             // the ground line
      px(x + 7, T + 12, 3, 1, shade(T_MID, 0.20));                  // a ledge it is heading for
      scanl(x + 2, T + 7, w - 4, 7, 0.20);
      bloom(x + 2, T + 7, w - 4, 7, T_LIT, 0.16);
    } else {
      px(x + 3, T + 9, 3, 1, '#15241f'); px(x + 4, T + 10, 2, 1, '#101c19');
    }

    /* ---- CONTROL DECK: the pale plane, stepping proud of the cabinet ---- */
    px(x - 1, T + 15, w + 2, 4, EDGE);
    px(x, T + 16, w, 2, PALE);
    px(x, T + 16, w, 1, PALE_L);
    px(x + 2, T + 15, 2, 2, glowT(T_LIT));                            // ball-top stick
    px(x + 2, T + 17, 2, 1, '#161c20');                               // its shaft
    px(x + 6, T + 16, 2, 1, glowT(T_LIT)); px(x + 9, T + 16, 2, 1, glowT(T_LIT));   // two buttons
    px(x - 1, T + 19, w + 2, 1, '#0d1215');                           // the shade the deck throws

    /* ---- LOWER CABINET: recessed COIN DOOR ---- */
    px(x + 3, T + 20, 6, 4, BODY_D);
    px(x + 3, T + 20, 6, 1, BODY_L);
    px(x + 4, T + 21, 2, 2, '#4a545c'); px(x + 4, T + 21, 2, 1, '#6d7981');   // the coin plate
    px(x + 7, T + 21, 1, 2, glowT(T_LIT));                                    // the return slot, lit

    /* ---- LIGHT BAR across the kick — the reference's signature ---- */
    px(x + 1, T + 25, w - 2, 2, BODY_D);
    px(x + 2, T + 25, w - 4, 1, on ? T_LIT : shade(T_LIT, -0.60));
    if (on) { bloom(x + 2, T + 25, w - 4, 1, T_LIT, 0.30); spill(x + 2, base - 1, w - 4, T_LIT, 0.18, 4); }
    px(x + 1, base - 1, w - 2, 1, '#080c0e');
    if (on && blink(900, ph)) px(x + w - 3, T + 6, 1, 1, shade(T_LIT, 0.20));
  };

  F.jukebox = (x, y, w, h, f) => {
    /* v66 JUKEBOX (1x2) — rebuilt to Andrew's reference (2026-08-16): a Wurlitzer read, top to bottom —
         chrome CROWN with a red gem -> timber-and-cream ARCH -> dark mechanism window -> cream SELECTION
         panel -> red button row -> chrome side bars -> ornate grille with a gold MEDALLION -> timber base.
       ⛔ OBJECT = CAPABILITY TRUTH (unchanged, and the whole point of this prop): a placed jukebox GRANTS
          the Spotify tools but they are INERT until Spotify is connected in TOOLSETS. So the unconnected
          machine is drawn genuinely UNPOWERED — every emissive off, the chrome cold, and its mains lead
          COILED AND UNPLUGGED on the deck beside it. f.live = Spotify really connected.
       ⛔ THE ARCH IS THREE CONCENTRIC BANDS, NOT AN OUTLINE. Timber outside, cream inside, dark rebate
          between. At 13px wide that layering is the entire reason it reads as a jukebox and not a fridge. */
    const EDGE = '#1c1410';
    const live = !!(f && f.live), ph = (f && f.x) || 0;
    const cw = 13, T = y - 3, B = y + h - 1;
    const cold = c => live ? c : shade(c, -0.42);
    const TIM = '#7a4a22', TIM_D = '#43280f', TIM_L = '#9c6a34';
    const CRM = '#c8a45e', CRM_L = '#e8cf94', CRM_D = '#8a6c38';
    const CHR = '#b0bcc2', CHR_D = '#667077';
    const RED = '#a8302a';

    shadow2(x + 1, B, cw - 2);

    /* ---- ARCH: seven rows of widening cap, painted as timber -> cream -> dark rebate ---- */
    const ARCH = [[5, 3], [4, 5], [3, 7], [2, 9], [1, 11], [1, 11], [0, 13]];
    ARCH.forEach((s, j) => px(x + s[0] - 1, T + j, s[1] + 2, 1, EDGE));
    ARCH.forEach((s, j) => {
      px(x + s[0], T + j, s[1], 1, cold(TIM));                          // the outer timber band
      if (s[1] > 4) px(x + s[0] + 1, T + j, s[1] - 2, 1, cold(CRM));    // the cream band inside it
      if (s[1] > 6) px(x + s[0] + 2, T + j, s[1] - 4, 1, cold(TIM_D));  // the dark rebate
      px(x + s[0], T + j, 1, 1, cold(TIM_L));                           // west edge takes the key
      px(x + s[0] + s[1] - 1, T + j, 1, 1, cold(TIM_D));
    });
    px(x + 5, T, 3, 1, cold(CHR)); px(x + 6, T, 1, 1, live ? '#e04a3a' : cold('#7a2a24'));   // crown + gem
    if (live) { keyEdge(x + 4, T + 1, 4, 1, 0.26); bloom(x + 5, T, 3, 1, '#e04a3a', 0.22); }

    /* ---- CABINET below the arch ---- */
    px(x - 1, T + 7, cw + 2, B - T - 6, EDGE);
    px(x, T + 7, cw, B - T - 7, cold(TIM));
    px(x, T + 7, 1, B - T - 7, cold(TIM_L));
    px(x + cw - 1, T + 7, 1, B - T - 7, cold(TIM_D));
    if (live) rimEdge(x + cw - 1, T + 8, 1, B - T - 9, 0.18);
    px(x + 1, T + 7, cw - 2, 1, cold(CRM_D));                            // cream rail under the arch

    /* ---- MECHANISM WINDOW: dark glass with the record parked behind it ---- */
    px(x + 2, T + 8, 9, 4, '#120c14');
    px(x + 2, T + 8, 9, 1, cold('#2a1e2c'));
    px(x + 4, T + 9, 5, 2, live ? '#3a2e3c' : '#211a22');                // the platter
    px(x + 6, T + 10, 1, 1, live ? '#d8564a' : '#5a2a26');               // its label
    if (live) { scanl(x + 2, T + 8, 9, 4, 0.16); bloom(x + 4, T + 9, 5, 2, '#d8564a', 0.14); }

    /* ---- SELECTION PANEL: three columns of song strips on cream ---- */
    px(x + 2, T + 13, 9, 4, cold(CRM_D));
    px(x + 2, T + 13, 9, 1, cold(CRM_L));
    for (let c = 0; c < 3; c++)
      for (let j = 0; j < 2; j++)
        px(x + 3 + c * 3, T + 14 + j * 2, 2, 1, live ? CRM_L : cold(CRM));
    for (let i = 0; i < 4; i++)                                          // the red button row
      px(x + 3 + i * 2, T + 17, 1, 1, live ? RED : cold('#5c1e1a'));

    /* ---- CHROME SIDE BARS with red tips, flanking the grille ---- */
    for (const s of [0, 1]) {
      const bx = s ? x + cw - 3 : x + 1;
      px(bx, T + 18, 2, 1, cold(CHR)); px(bx, T + 20, 2, 1, cold(CHR));
      px(s ? bx + 1 : bx, T + 19, 1, 1, live ? RED : cold('#5c1e1a'));
    }

    /* ---- GRILLE + GOLD MEDALLION: the one warm focal point low on the cabinet ---- */
    px(x + 3, T + 18, 7, 6, '#2a1a10');
    px(x + 3, T + 18, 7, 1, cold(CRM_D));
    for (let j = 0; j < 5; j += 2) px(x + 4, T + 19 + j, 5, 1, cold('#6a4a2c'));   // the fretwork
    px(x + 5, T + 20, 3, 3, cold(CHR_D));
    px(x + 6, T + 21, 1, 1, live ? '#f0b23a' : cold('#6a5220'));                   // the medallion's core
    if (live) bloom(x + 5, T + 20, 3, 3, '#f0b23a', 0.26);

    /* ---- TIMBER BASE over a chrome kick ---- */
    px(x, B - 2, cw, 2, cold(TIM_D));
    px(x, B - 2, cw, 1, cold(TIM));
    px(x + 1, B - 1, cw - 2, 1, cold(CHR_D));
    px(x + 1, B, cw - 2, 1, '#0a0906');

    /* ---- HONEST DEAD STATE: the mains lead lies coiled and unplugged on the deck ---- */
    if (!live) {
      px(x + cw, B - 1, 3, 1, '#2a2f34'); px(x + cw + 2, B - 2, 1, 1, '#2a2f34');
      px(x + cw + 2, B - 3, 2, 1, '#3d454c');
    } else {
      spill(x + 2, B, cw - 4, '#f0b23a', 0.16, 4);
    }
  };

  const WD = '#6b5030', WD_LIT = '#96723f', WD_DK = '#3d2c19';         // BED frame timber
  const QLT = '#a83a3a', QLT_LIT = '#cf5f56', QLT_DK = '#6b2020';      // the quilt
  const LIN = '#d0cabb', LIN_LIT = '#e8e1d3', LIN_DK = '#9a9384';      // linen, knocked off pure white
  /* THE QUILT, lifted out of F.bunk so it can be painted in TWO passes (2026-08-10, sleeping agents).
     A body dormant in the bed is drawn BETWEEN them: the frame + pillow go down, the sleeper is drawn on
     the mattress, then this runs again ON TOP — which is the whole trick behind "under the covers with
     its head poking out". With no sleeper F.bunk calls it inline and the bed is pixel-identical to v7.
     `occupied` adds the one thing a covered body actually shows: the swell of it under the quilt, and a
     slow breath. The hump is deliberately shallow — this is a top-down bed, not a side view. */
  const bunkQuilt = (x, y, w, h, occupied, now) => {
    const sT = y + h - 8, bx = x + 3, bw = w - 6;
    px(bx, y + 7, bw, sT - y - 7, QLT);
    px(bx, y + 7, bw, 2, QLT_LIT);                                      // turned-down fold, catching light
    px(bx, y + 7, bw, 1, shade(QLT_LIT, 0.18));
    px(bx, y + 9, bw, 1, QLT_DK);                                       // the fold's own shadow
    px(bx, y + 10, 1, sT - y - 10, shade(QLT, 0.12));
    px(bx + bw - 1, y + 10, 1, sT - y - 10, QLT_DK);
    rimEdge(bx + bw - 1, y + 10, 1, sT - y - 10, 0.18);
    for (const qx of [bx + 5, bx + bw - 6]) px(qx, y + 10, 1, sT - y - 10, shade(QLT, -0.16));  // stitching
    for (let qy = y + 12; qy < sT - 1; qy += 4) px(bx + 1, qy, bw - 2, 1, shade(QLT, -0.13));
    px(bx + 2, y + 11, 5, 1, shade(QLT_LIT, -0.22));                  // one soft crease, west-biased
    wear(bx + 2, y + 11, bw - 4, sT - y - 13, 4, shade(QLT, -0.11));
    if (!occupied) return;
    // OCCUPIED: the quilt is tented over a body. One breath cycle (~4s) moves the crown by a single
    // pixel — a sleeping body is nearly still, and anything faster reads as a machine, not a lung.
    const breath = (Math.sin((now || 0) / 2000) > 0.2) ? 1 : 0;
    const cx = bx + ((bw - 8) >> 1);
    px(cx, y + 10 - breath, 8, sT - y - 11 + breath, shade(QLT, 0.10));       // the swell itself
    px(cx, y + 10 - breath, 8, 1, shade(QLT_LIT, -0.06));                     // lit crown
    px(cx - 1, y + 11 - breath, 1, sT - y - 12, shade(QLT, -0.10));           // the shoulders' shadow, west
    px(cx + 8, y + 11 - breath, 1, sT - y - 12, QLT_DK);                        // ...and east
    px(cx + 1, sT - 3, 6, 1, shade(QLT, -0.14));                              // the fold where the feet end
  };

  F.bunk = (x, y, w, h, f) => {
    // BED (2x2) — v7, drawn FLAT, from above. v6 stood it up: a tall headboard, a tall footboard and
    // the bedding as flat frontal bands between them, so it read as a framed picture leaning against
    // the wall rather than a bed lying on the deck. Andrew rejected it outright, and the diagnosis is
    // the same one that condemned the tables — the station camera looks DOWN, so a bed is a big
    // horizontal SURFACE with a short south face and legs under it, not an elevation.
    //
    // That also happens to be the Minecraft read he asked for, which is no coincidence: that bed is
    // legible because it is a flat top plane in two blocks — WHITE pillow at the head, RED quilt over
    // the rest — inside a thin timber rim, with four stubby corner posts. No headboard at all. The
    // frame is trim, never the subject; v6 gave the frame nine rows of headboard and it ate the bed.
    //
    // The catalog id stays 'bunk': saved stations carry the type string, and retiring a type strands
    // an invisible obstacle in them (the v5 lane law). Only the LABEL is BED.
    const sT = y + h - 8, bx = x + 3, bw = w - 6;                        // south face top / bedding span
    shadow2(x + 1, y + h - 1, w - 2);
    // ---- FOUR CORNER POSTS. The south pair carries the contact; the north pair is a hint behind the
    // mattress, which is all you would see of them from above.
    for (const lx of [x + 1, x + w - 4]) {
      px(lx, y + 1, 3, 3, shade(WD, -0.30));                          // north posts, mostly hidden
      px(lx, y + h - 5, 3, 5, LINE);
      px(lx, y + h - 4, 3, 4, WD); px(lx, y + h - 4, 1, 4, WD_LIT); px(lx + 2, y + h - 4, 1, 4, WD_DK);
      keyEdge(lx, y + h - 4, 1, 3, 0.16); rimEdge(lx + 2, y + h - 4, 1, 3, 0.20);
      px(lx, y + h - 1, 3, 1, '#0a0d10');
    }
    underAO(x + 5, y + h - 3, w - 10, 2);
    // ---- THE BED, as one top plane inside a thin timber rim. Rim first, bedding painted inside it.
    px(x, y - 2, w, sT - y + 2, LINE);
    px(x + 1, y - 1, w - 2, sT - y, WD);
    px(x + 1, y - 1, w - 2, 1, WD_LIT); keyEdge(x + 2, y - 1, 10, 1, 0.24);   // the head rail, lit
    px(x + 1, y, w - 2, 1, shade(WD, 0.08));
    px(x + 1, y - 1, 1, sT - y, WD_LIT); px(x + w - 2, y - 1, 1, sT - y, WD_DK);
    rimEdge(x + w - 2, y, 1, sT - y - 1, 0.20);
    wear(x + 2, y - 1, w - 4, 3, 3, shade(WD, -0.18));
    // PILLOW at the head (north) — one block of near-white, plumped: lit crown, shaded skirt, and a
    // slept-in dent so it is not a card. Inset from the rim so the timber reads all the way round.
    // SIX rows, not seven, and the linen is knocked back off pure white. A pillow is roughly a quarter
    // of a bed; at seven rows of #dcd7c8 it took a third of the top plane and, being far and away the
    // brightest thing on the prop, read as a label stuck to the bedding rather than as bedding.
    chamf(bx, y + 1, bw, 6, LIN, 1);
    px(bx + 1, y + 1, bw - 2, 1, LIN_LIT); keyEdge(bx + 2, y + 1, 6, 1, 0.22);
    px(bx, y + 2, 1, 4, shade(LIN, 0.05)); px(bx + bw - 1, y + 2, 1, 4, LIN_DK);
    rimEdge(bx + bw - 1, y + 2, 1, 4, 0.16);
    px(bx + 4, y + 3, 9, 2, shade(LIN, -0.13));                       // the dent a head left
    px(bx + 5, y + 4, 7, 1, shade(LIN, -0.22));
    px(bx + 1, y + 6, bw - 2, 1, LIN_DK);                               // the pillow's own under-shade
    // QUILT over the rest, hem to the foot. The turned-down fold at the head is the one asymmetry.
    // SKIPPED while a body is dormant in the bed: world.js then draws the sleeper and calls drawOver()
    // to lay the quilt over it (see bunkQuilt). Empty bed = one call, exactly the old paint.
    if (!f.sleeper) bunkQuilt(x, y, w, h, false, 0);
    // ---- THE SOUTH FACE — the thickness of mattress and frame, seen edge-on under the top plane.
    // This band is what turns the plane into a solid object standing on legs. Paint the frame's face
    // FULL WIDTH first and hang the quilt over the middle of it: a first pass drew only the quilt's
    // span here, which left the outer 3px at each end as bare LINE and cut two black notches out of
    // the bottom corners of the bed.
    px(x, sT, w, 6, LINE);
    // the top plane's own outline row and this band's would otherwise stack into a 2px black gap
    // between the mattress and its face, which reads as a slot cut through the bed. One row of the
    // quilt's shade closes it, and doubles as the mattress edge's contact shadow.
    px(x + 1, sT - 1, w - 2, 1, shade(QLT_DK, -0.30));
    px(x + 1, sT + 1, w - 2, 4, WD);
    px(x + 1, sT + 1, w - 2, 1, WD_LIT); keyEdge(x + 2, sT + 1, 8, 1, 0.18);
    px(x + 1, sT + 2, 1, 3, WD_LIT); px(x + w - 2, sT + 2, 1, 3, WD_DK);
    rimEdge(x + w - 2, sT + 2, 1, 3, 0.20);
    px(bx, sT + 1, bw, 3, QLT_DK);                                      // the quilt hanging over the foot
    px(bx, sT + 1, bw, 1, shade(QLT, -0.08));
    px(bx + 1, sT + 4, bw - 2, 1, shade(QLT_DK, -0.44));              // its hem shadow on the rail
    px(x + 1, sT + 5, w - 2, 1, shade(WD_DK, -0.34));                 // floor-line AO under the rail
  };

  /* v5 RUG (4x3) — the station's biggest FLOOR DECAL. Zero rise, ever.
     The whole point of this prop is that it is IN the ground plane: no oblique body, no front face, no
     contact shadow. It's the largest walked-over surface in the game, so any 3D read here would make
     every agent that crosses it look like it is clipping through furniture.

     v4 was slate-on-slate — the same value and hue as the deck it lies on, so at station zoom it read as
     a patch of dirty floor rather than as textile. v5 fixes that with VALUE and MATERIAL, not with
     pattern: a warm oxblood wool against a cold deck, and the rug's read carried by pile and wear.

     Two rejected rounds are the reason it looks like this. The first (persian / brass / kilim) had bone
     highlights, saturated ochre and a hard bordered frame — decorative clip-art in a room whose entire
     palette is muted and matte, and it was rejected on sight. So v5 holds ONE narrow value band: nothing
     lighter than ~+8% or darker than ~-14% of its own base, no white, no second hue, no border teeth and
     no fringe ticks. The medallion is an OUTLINE at +8%, half-erased by the traffic path over it — a rug
     you notice the second time you look, which is what everything else in this station does. */
  const RUG_BASE = '#54332e', RUG_RIM = '#472b27';
  F.rug = (x, y, w, h, f) => {
    const INK = shade(RUG_BASE, -0.13), PALE = shade(RUG_BASE, 0.08);
    // the silhouette: soft corners and a bound rim. NOT a black outline — a rug has no lip to cast one,
    // and v4's near-black edge is half of why it read as a hole in the floor.
    px(x + 2, y, w - 4, h, RUG_RIM); px(x, y + 2, w, h - 4, RUG_RIM);
    px(x + 1, y + 1, 1, 1, RUG_RIM); px(x + w - 2, y + 1, 1, 1, RUG_RIM);
    px(x + 1, y + h - 2, 1, 1, RUG_RIM); px(x + w - 2, y + h - 2, 1, 1, RUG_RIM);
    rr(x + 2, y + 2, w - 4, h - 4, RUG_BASE);
    /* PILE — single-pixel fleck on a 3px stride whose phase is hashed per ROW. A regular stride (or the
       2px runs the first cut used) lines the flecks up into courses and the wool reads as brickwork.
       Integer coordinate hashing, no string keys: this is the one loop that runs over the whole 48x36
       footprint every frame, and PropSprites is already the heaviest thing in the frame. */
    for (let jy = 3; jy < h - 2; jy += 2) px(x + 2, y + jy, w - 4, 1, shade(RUG_BASE, -0.028));   // weft courses: the weave, almost subliminal
    const lit = shade(RUG_BASE, 0.035), dk = shade(RUG_BASE, -0.045);
    for (let jy = 2; jy < h - 2; jy++) {
      const phase = ((jy * 19349663) >>> 0) % 3;
      for (let ix = 2 + phase; ix < w - 2; ix += 3) {
        const n = ((ix * 73856093) ^ (jy * 2654435761)) >>> 0;
        if ((n & 7) > 1) continue;                         // ~1 pixel in 12 — grain, not polka dots
        px(x + ix, y + jy, 1, 1, (n & 8) ? lit : dk);
      }
    }
    // the ceiling strips, at a QUARTER of v4's contrast — on a decal this is the only depth cue there is,
    // and any more of it turns the rug back into a lit 3D slab.
    px(x + 3, y + 2, w - 6, 1, shade(RUG_BASE, 0.05));
    px(x + 3, y + h - 3, w - 6, 1, shade(RUG_BASE, -0.07));
    ctx.globalAlpha = 0.5; px(x + 2, y + 3, 1, h - 6, shade(RUG_BASE, 0.04)); px(x + w - 3, y + 3, 1, h - 6, shade(RUG_BASE, -0.05)); ctx.globalAlpha = 1;
    px(x + 4, y + 4, w - 8, 1, INK); px(x + 4, y + h - 5, w - 8, 1, INK);          // one quiet border line
    px(x + 4, y + 4, 1, h - 8, INK); px(x + w - 5, y + 4, 1, h - 8, INK);
    const cx = x + (w >> 1), cy = y + (h >> 1);
    ctx.globalAlpha = 0.55; px(cx - 8, cy - 4, 16, 9, shade(RUG_BASE, 0.035)); ctx.globalAlpha = 1;   // the medallion's washed field
    for (let d = 0; d <= 7; d++) {                                                 // ...and the lozenge, outline only
      const ww = 17 - d * 2, lx = cx - (ww >> 1), rx = cx + (ww >> 1) - 1;
      if (d === 7) { px(lx, cy - d, ww, 1, PALE); px(lx, cy + d, ww, 1, PALE); continue; }
      px(lx, cy - d, 1, 1, PALE); px(rx, cy - d, 1, 1, PALE);
      px(lx, cy + d, 1, 1, PALE); px(rx, cy + d, 1, 1, PALE);
    }
    px(cx - 2, cy - 1, 4, 3, PALE);
    // WEAR is what makes a rug read as lived-on, and here it also half-erases the motif on purpose.
    ctx.globalAlpha = 0.13; px(x + 4, y + (h >> 1) - 3, w - 8, 7, '#0f1113'); ctx.globalAlpha = 1;      // the walked path
    ctx.globalAlpha = 0.09; px(x + w - 17, y + 5, 12, 6, '#d8cec0'); ctx.globalAlpha = 1;               // a bleached corner
    wear(x + 4, y + 4, w - 8, h - 8, 14, shade(RUG_BASE, -0.14));
    // the frayed short ends, dithered IN the floor plane so they read as threads and never as a lip
    for (let jy = 2; jy < h - 2; jy++) if (((jy * 2654435761) >>> 0) & 1) { px(x - 1, y + jy, 1, 1, RUG_RIM); px(x + w, y + jy, 1, 1, RUG_RIM); }
  };

  /* SMALL RUG (3x3) — the RUG's discipline at a different loom.
     It keeps the three laws that stopped the 4x3's v4 reading as a patch of dirty floor — ZERO RISE (no
     oblique body, no front face, no contact shadow), ONE narrow value band (nothing past +8% / -14% of
     its own base), no white and no second hue — and changes everything that identifies it:

     - MATERIAL: a FLATWEAVE, not a pile. So the weave runs down the WARP (vertical ribs every 3px) where
       the 4x3 runs across the weft, and the surface carries slubs — 2px thread catches — instead of the
       4x3's 1-in-12 fleck. Two rugs beside each other must not share a grain.
     - MOTIF: a BANDED kilim (two chevron end-bands + a hooked centre diamond) where the 4x3 is one open
       field around a single lozenge medallion. A 36px square has no room for an open field.
     - HUE: tobacco ochre against the 4x3's oxblood. ⛔ The chroma dial caps EVERY warm hue at the same
       0.52 saturation (chromaOf, top of file), so authored saturation is not a lever between two warm
       props — HUE and VALUE are the only two that separate them, and this one is a stop lighter.
     Traffic runs the SHORT way across a mat, so the walked path is a vertical strip, not the 4x3's belt. */
  const RUGS_BASE = '#5a4526', RUGS_RIM = '#4b381f';
  F.rug_small = (x, y, w, h, f) => {
    const INK = shade(RUGS_BASE, -0.13), PALE = shade(RUGS_BASE, 0.08);
    // the bound rim: soft corners, and a tint of the wool itself — never a black outline. A rug has no
    // lip to cast one, and a near-black edge is what makes a decal read as a hole cut in the deck.
    px(x + 2, y, w - 4, h, RUGS_RIM); px(x, y + 2, w, h - 4, RUGS_RIM);
    px(x + 1, y + 1, 1, 1, RUGS_RIM); px(x + w - 2, y + 1, 1, 1, RUGS_RIM);
    px(x + 1, y + h - 2, 1, 1, RUGS_RIM); px(x + w - 2, y + h - 2, 1, 1, RUGS_RIM);
    rr(x + 2, y + 2, w - 4, h - 4, RUGS_BASE);
    for (let ix = 4; ix < w - 3; ix += 3) px(x + ix, y + 3, 1, h - 6, shade(RUGS_BASE, -0.03));   // the warp it was beaten onto
    for (let jy = 4; jy < h - 4; jy++) {                                    // slubs: thread catches, so it is cloth and not corduroy
      const n = ((jy * 2654435761) ^ 0x9e3779b9) >>> 0;
      if (n & 3) continue;
      px(x + 3 + (n % Math.max(1, w - 9)), y + jy, 2, 1, shade(RUGS_BASE, 0.04));
    }
    px(x + 3, y + 2, w - 6, 1, shade(RUGS_BASE, 0.05));                  // the ceiling strips, at a quarter of the
    px(x + 3, y + h - 3, w - 6, 1, shade(RUGS_BASE, -0.07));             // contrast a lit slab would take — on a
    ctx.globalAlpha = 0.5;                                                 // decal this is the ONLY depth cue there is
    px(x + 2, y + 3, 1, h - 6, shade(RUGS_BASE, 0.04)); px(x + w - 3, y + 3, 1, h - 6, shade(RUGS_BASE, -0.05));
    ctx.globalAlpha = 1;
    /* the two end bands. A chevron chain, PALE over INK, interlocked: one zigzag climbing the band and its
       mirror falling through it, which is the flatweave motif that costs the fewest pixels to read. */
    const chev = (by) => {
      for (let ix = 4; ix < w - 4; ix++) {
        const t = (ix - 4) % 6, d = t < 3 ? t : 6 - t;
        px(x + ix, by + d, 1, 1, PALE);
        px(x + ix, by + 4 - d, 1, 1, INK);
      }
    };
    chev(y + 4); chev(y + h - 9);
    const cx = x + (w >> 1), cy = y + (h >> 1);
    ctx.globalAlpha = 0.55; px(cx - 5, cy - 3, 11, 7, shade(RUGS_BASE, 0.035)); ctx.globalAlpha = 1;   // the diamond's washed field
    for (let d = 0; d <= 5; d++) {                                         // ...and the diamond, OUTLINE only
      const ww = 11 - d * 2, lx = cx - (ww >> 1), rx = cx + (ww >> 1);
      if (d === 5) { px(lx, cy - d, Math.max(1, ww), 1, PALE); px(lx, cy + d, Math.max(1, ww), 1, PALE); continue; }
      px(lx, cy - d, 1, 1, PALE); px(rx, cy - d, 1, 1, PALE);
      px(lx, cy + d, 1, 1, PALE); px(rx, cy + d, 1, 1, PALE);
    }
    px(cx - 7, cy, 2, 1, PALE); px(cx + 6, cy, 2, 1, PALE);                // the hooks that make it a kilim diamond
    px(cx, cy - 7, 1, 2, PALE); px(cx, cy + 6, 1, 2, PALE);
    px(cx - 1, cy - 1, 3, 3, INK);
    // WEAR — what makes a rug read as lived-on, and here it half-erases the motif on purpose.
    ctx.globalAlpha = 0.12; px(cx - 4, y + 3, 9, h - 6, '#0f1113'); ctx.globalAlpha = 1;                 // crossed the short way
    ctx.globalAlpha = 0.08; px(x + 4, y + h - 13, 8, 7, '#d8cec0'); ctx.globalAlpha = 1;                 // a bleached corner
    wear(x + 3, y + 3, w - 6, h - 6, 10, shade(RUGS_BASE, -0.14));
    // the frayed ends on the N/S edges (the 4x3 frays E/W), dithered IN the floor plane so they read as
    // threads and never as a lip.
    for (let ix = 2; ix < w - 2; ix++) if (((ix * 2654435761) >>> 0) & 1) { px(x + ix, y - 1, 1, 1, RUGS_RIM); px(x + ix, y + h, 1, 1, RUGS_RIM); }
  };

  /* LARGE RUG (5x5) — the biggest floor decal in the catalog, 60x60px, and the only prop an agent can be
     standing entirely inside. Same three laws as the other two rugs (zero rise, one narrow value band, no
     white / no second hue). What is its own:

     - MOTIF: CONCENTRIC FRAMES with corner brackets and an eight-point star, not a single medallion. At
       this size an open field is 3600px of flat wool, so the structure has to be the borders; the star is
       a lozenge outline crossed by a square outline, which is what a kilim star actually is.
     - EDGE: BOUND, not frayed. A rug this big is selvedged — a rolled 1px inner edge all the way round —
       where the small mat frays. No fringe anywhere on it.
     - GRAIN: pile fleck on a 4px stride against the 4x3's 3px, so no two rugs share a weave.
     - HUE: plum/aubergine (~336°, still inside chromaOf's warm band, so it grades like wool and not like
       cool machinery) — a stop DARKER than the oxblood 4x3, which is how a big rug stays ground.
     Two traffic paths cross it, not one: a rug you can walk around is a rug you walk over both ways. */
  const RUGL_BASE = '#3e2430', RUGL_RIM = '#331d28';
  F.rug_large = (x, y, w, h, f) => {
    const INK = shade(RUGL_BASE, -0.13), PALE = shade(RUGL_BASE, 0.08);
    px(x + 2, y, w - 4, h, RUGL_RIM); px(x, y + 2, w, h - 4, RUGL_RIM);
    px(x + 1, y + 1, 1, 1, RUGL_RIM); px(x + w - 2, y + 1, 1, 1, RUGL_RIM);
    px(x + 1, y + h - 2, 1, 1, RUGL_RIM); px(x + w - 2, y + h - 2, 1, 1, RUGL_RIM);
    rr(x + 2, y + 2, w - 4, h - 4, RUGL_BASE);
    const lit = shade(RUGL_BASE, 0.035), dk = shade(RUGL_BASE, -0.045);
    for (let jy = 3; jy < h - 3; jy++) {                                   // PILE — 4px stride, phase hashed per ROW:
      const phase = ((jy * 19349663) >>> 0) % 4;                           // a regular stride lines the fleck into
      for (let ix = 3 + phase; ix < w - 3; ix += 4) {                      // courses and the wool reads as brickwork
        const n = ((ix * 73856093) ^ (jy * 2654435761)) >>> 0;
        if ((n & 7) > 2) continue;
        px(x + ix, y + jy, 1, 1, (n & 8) ? lit : dk);
      }
    }
    px(x + 3, y + 3, w - 6, 1, shade(RUGL_BASE, -0.09));                 // the SELVEDGE: a rolled bound edge, the
    px(x + 3, y + h - 4, w - 6, 1, shade(RUGL_BASE, -0.09));             // one thing a big rug has that a mat doesn't
    px(x + 3, y + 4, 1, h - 8, shade(RUGL_BASE, -0.09)); px(x + w - 4, y + 4, 1, h - 8, shade(RUGL_BASE, -0.09));
    px(x + 4, y + 2, w - 8, 1, shade(RUGL_BASE, 0.05));                  // ceiling strips, quarter contrast
    px(x + 4, y + h - 3, w - 8, 1, shade(RUGL_BASE, -0.07));
    ctx.globalAlpha = 0.5;
    px(x + 2, y + 4, 1, h - 8, shade(RUGL_BASE, 0.04)); px(x + w - 3, y + 4, 1, h - 8, shade(RUGL_BASE, -0.05));
    ctx.globalAlpha = 1;
    const frame = (o, c) => {
      px(x + o, y + o, w - o * 2, 1, c); px(x + o, y + h - o - 1, w - o * 2, 1, c);
      px(x + o, y + o, 1, h - o * 2, c); px(x + w - o - 1, y + o, 1, h - o * 2, c);
    };
    frame(6, INK); frame(8, PALE); frame(14, INK);                         // the three quiet borders
    /* corner brackets, outline only — each is two 5px arms and a dark eye. They are what stops the space
       between the outer frames and the star reading as empty wool. */
    const bracket = (bx, by, dx, dy) => {
      for (let k = 0; k < 5; k++) { px(bx + dx * k, by, 1, 1, PALE); px(bx, by + dy * k, 1, 1, PALE); }
      px(bx + dx * 2, by + dy * 2, 1, 1, INK);
    };
    bracket(x + 16, y + 16, 1, 1); bracket(x + w - 17, y + 16, -1, 1);
    bracket(x + 16, y + h - 17, 1, -1); bracket(x + w - 17, y + h - 17, -1, -1);
    const cx = x + (w >> 1), cy = y + (h >> 1);
    ctx.globalAlpha = 0.55; px(cx - 9, cy - 9, 19, 19, shade(RUGL_BASE, 0.035)); ctx.globalAlpha = 1;  // the star's washed field
    for (let d = 0; d <= 8; d++) {                                         // the lozenge...
      const ww = 17 - d * 2, lx = cx - (ww >> 1), rx = cx + (ww >> 1);
      if (d === 8) { px(lx, cy - d, Math.max(1, ww), 1, PALE); px(lx, cy + d, Math.max(1, ww), 1, PALE); continue; }
      px(lx, cy - d, 1, 1, PALE); px(rx, cy - d, 1, 1, PALE);
      px(lx, cy + d, 1, 1, PALE); px(rx, cy + d, 1, 1, PALE);
    }
    px(cx - 6, cy - 6, 13, 1, INK); px(cx - 6, cy + 6, 13, 1, INK);        // ...crossed by the square: eight points
    px(cx - 6, cy - 6, 1, 13, INK); px(cx + 6, cy - 6, 1, 13, INK);
    px(cx - 2, cy - 2, 5, 5, shade(RUGL_BASE, 0.05)); px(cx - 1, cy - 1, 3, 3, INK);
    // WEAR — two crossing paths, and the star sits under both on purpose.
    ctx.globalAlpha = 0.12; px(x + 4, cy - 5, w - 8, 11, '#0f1113'); ctx.globalAlpha = 1;
    ctx.globalAlpha = 0.08; px(cx - 4, y + 4, 9, h - 8, '#0f1113'); ctx.globalAlpha = 1;
    ctx.globalAlpha = 0.09; px(x + w - 21, y + 7, 14, 8, '#d8cec0'); ctx.globalAlpha = 1;                // a bleached corner
    wear(x + 5, y + 5, w - 10, h - 10, 22, shade(RUGL_BASE, -0.14));
  };

  F.seatchair = (x, y, w, h, f) => {
    /* SEAT CHAIR (1x1) — the chair world.js draws at a workstation seat. NOT in the CATALOG, so the
       PLACEABLE chair prop (F.chair) keeps its shipped art untouched.
       ⛔ THIS IS F.chair's SILHOUETTE, PIXEL FOR PIXEL. Only the MATERIAL changed. Two rewrites failed
          before this: one baked the chair into the desk sprite (the sitter sorts a tile south, so the
          agent floated in front of a chair it could not sit in), and one gave it a solid 8x6 slab back
          that SWALLOWED THE SEATED AGENT'S HEAD. The shipped back is deliberately WAISTED — a narrow
          headrest bar clear of the shoulders, pinched at the lumbar — precisely so a body sitting in
          front of it still reads. That profile is load-bearing; do not 'improve' it into a slab.
       ⛔ Rows are F.chair's rows (pad y+3..y+7, column y+7..y+9, base y+10, casters y+11) because the
          sitter anchor is calibrated to them. */
    const r = RAMP.steel, s = MAT.seat;
    shadow2(x + 3, y + 10, 7);
    px(x + 2, y + 10, 8, 1, '#10161a');                          // star base — low and dark, hides under a body
    px(x + 3, y + 10, 6, 1, '#2a343c'); keyEdge(x + 3, y + 10, 3, 1, 0.16);
    px(x + 2, y + 9, 1, 1, '#242e35'); px(x + 9, y + 9, 1, 1, '#242e35');
    for (const cw of [x + 2, x + 5, x + 8]) px(cw, y + 11, 2, 1, '#1a1e22');   // casters
    px(x + 4, y + 7, 4, 3, s.ink);                               // gas-lift column
    px(x + 5, y + 7, 1, 3, '#8b959c'); px(x + 6, y + 7, 1, 3, '#5c666e');
    keyEdge(x + 5, y + 7, 1, 2, 0.20); rimEdge(x + 6, y + 7, 1, 3, 0.22);
    /* WAISTED BACK — the silhouette that lets a seated head read. */
    px(x + 4, y - 4, 4, 1, s.ink); px(x + 3, y - 3, 6, 1, s.ink);
    px(x + 2, y - 2, 8, 4, s.ink); px(x + 3, y + 2, 6, 1, s.ink);
    px(x + 4, y - 3, 4, 1, s.hi);                                // headrest bar
    keyEdge(x + 4, y - 3, 2, 1, 0.26);
    px(x + 3, y - 2, 6, 3, s.face);                              // shoulders
    px(x + 3, y - 2, 1, 3, s.lit); px(x + 8, y - 2, 1, 3, s.dk);
    rimEdge(x + 8, y - 2, 1, 3, 0.20);
    for (let j = 0; j < 3; j++) px(x + 4, y - 2 + j, 4, 1, shade(s.face, j % 2 ? -0.13 : 0.03));
    px(x + 4, y + 1, 4, 1, shade(s.face, -0.26));              // pinched lumbar
    /* SEAT PAD — silver where the shipped chair is teal. */
    px(x + 1, y + 3, 10, 5, s.ink);
    px(x + 2, y + 4, 8, 1, s.hi); px(x + 2, y + 4, 4, 1, s.sheen);
    keyEdge(x + 2, y + 4, 4, 1, 0.20);
    px(x + 2, y + 5, 8, 2, s.face);
    px(x + 2, y + 5, 1, 2, s.lit); px(x + 9, y + 5, 1, 2, s.dk);
    rimEdge(x + 9, y + 5, 1, 2, 0.18);
    px(x + 3, y + 6, 1, 1, s.dk); px(x + 8, y + 6, 1, 1, s.dk);  // seat stitches
    px(x + 2, y + 7, 8, 1, r.face); px(x + 2, y + 7, 3, 1, r.lit);
    px(x + 3, y + 8, 6, 1, r.dk);
    /* ARMRESTS last, so they read in FRONT of the pad. */
    px(x, y + 2, 2, 4, s.ink); px(x + 10, y + 2, 2, 4, s.ink);
    px(x, y + 3, 2, 1, shade(s.face, 0.14)); keyEdge(x, y + 3, 1, 1, 0.26);
    px(x, y + 4, 2, 1, shade(s.face, -0.18));
    px(x + 10, y + 3, 2, 1, shade(s.face, -0.04));
    px(x + 10, y + 4, 2, 1, s.dk); rimEdge(x + 10, y + 3, 1, 2, 0.22);
  };

  F.chair = (x, y, w, h, f) => {
    // CHAIR — the renderer draws this at EVERY agent's seat, so it appears more often than any other prop
    // on the station. It is therefore deliberately QUIET: no emissives, no accent LEDs, no bloom. Its only
    // job is to sit next to a workstation and never compete with it. v4 adds material (chrome stem, warm
    // crown / cold flank on the pad) and nothing louder.
    if (f && f.big) {   // command throne (kept branch)
      ctx.globalAlpha = 0.22; px(x + 2, y + 9, 9, 2, '#000'); ctx.globalAlpha = 1;
      chamf(x + 1, y - 1, 10, 6, '#3a1212', 2);                 // high wing back
      px(x + 2, y, 8, 4, '#5a2222'); px(x + 2, y, 8, 1, '#7a3030');
      keyEdge(x + 2, y, 4, 1, 0.24); rimEdge(x + 9, y + 1, 1, 3, 0.18);
      px(x + 3, y + 1, 1, 3, '#6a2a2a'); px(x + 8, y + 1, 1, 3, '#481a1a');  // bolster shading
      px(x + 5, y - 1, 2, 1, '#8a3a3a');                        // headrest
      px(x + 2, y + 4, 8, 6, '#3a1616');
      px(x + 3, y + 5, 6, 2, '#4e1e1e'); px(x + 3, y + 5, 6, 1, '#5e2626');  // seat cushion
      px(x + 4, y + 6, 1, 1, '#3a1414'); px(x + 7, y + 6, 1, 1, '#3a1414');  // tuft buttons
      px(x + 1, y + 4, 2, 5, '#4a1c1c'); px(x + 9, y + 4, 2, 5, '#4a1c1c');  // armrests
      px(x + 1, y + 4, 2, 1, '#5e2626'); px(x + 9, y + 4, 2, 1, '#5e2626');
      px(x + 1, y + 8, 2, 1, '#320e0e'); px(x + 9, y + 8, 2, 1, '#320e0e');
      px(x + 2, y + 8, 1, 1, '#5a1a14');                            // armrest stud, dark — a chair has no console
      px(x + 9, y + 5, 1, 2, '#1c0a0a');
      bloom(x + 9, y + 5, 1, 2, ACC.alert, 0.16);                   // steady piping glow, no fake power heartbeat
      px(x + 5, y + 2, 2, 1, '#8a6a2a'); px(x + 5, y + 2, 1, 1, '#b8924a');      // gold trim
      px(x + 5, y + 10, 2, 1, '#1c0a0a');
      return;
    }
    const r = RAMP.steel;
    shadow2(x + 3, y + 10, 7);                                  // blocks:true — a real solid, real contact
    // star base: arm bar + casters. Kept low and dark so it disappears under a seated body.
    px(x + 2, y + 10, 8, 1, '#10161a');
    px(x + 3, y + 10, 6, 1, '#2a343c'); keyEdge(x + 3, y + 10, 3, 1, 0.16);
    px(x + 2, y + 9, 1, 1, '#242e35'); px(x + 9, y + 9, 1, 1, '#242e35');   // NW/NE arm tips
    for (const cw of [x + 2, x + 5, x + 8]) px(cw, y + 11, 2, 1, '#1a1e22');   // casters
    // chrome gas-lift column: warm west / cold east, matching the stool
    px(x + 4, y + 7, 4, 3, LINE);
    px(x + 5, y + 7, 1, 3, '#54616a'); px(x + 6, y + 7, 1, 3, '#39434b');
    keyEdge(x + 5, y + 7, 1, 2, 0.20); rimEdge(x + 6, y + 7, 1, 3, 0.22);
    // BACKREST — a WAISTED mesh back, not a slab. At 12px the PROFILE is the only thing that says
    // "chair" rather than "small appliance": a headrest bar clear of the shoulders, then a pinch at
    // the lumbar. Legibility bought from silhouette costs no brightness, so the prop stays quiet.
    px(x + 4, y - 4, 4, 1, LINE); px(x + 3, y - 3, 6, 1, LINE);
    px(x + 2, y - 2, 8, 4, LINE); px(x + 3, y + 2, 6, 1, LINE);
    px(x + 4, y - 3, 4, 1, shade(r.face, 0.16));              // headrest bar
    keyEdge(x + 4, y - 3, 2, 1, 0.26);
    px(x + 3, y - 2, 6, 3, r.face);                             // shoulders — the widest span
    px(x + 3, y - 2, 1, 3, shade(r.face, 0.12)); px(x + 8, y - 2, 1, 3, r.dk);
    rimEdge(x + 8, y - 2, 1, 3, 0.20);
    for (let j = 0; j < 3; j++)                                 // mesh weave, alternating rows
      px(x + 4, y - 2 + j, 4, 1, shade(r.face, j % 2 ? -0.13 : 0.03));
    px(x + 4, y + 1, 4, 1, shade(r.face, -0.26));             // pinched waist = the lumbar read
    // seat pad, middle-south — stays visible under a seated agent
    px(x + 1, y + 3, 10, 5, LINE);
    px(x + 2, y + 4, 8, 1, '#4a8a82'); px(x + 2, y + 4, 4, 1, '#5aa89c');
    keyEdge(x + 2, y + 4, 4, 1, 0.20);
    px(x + 2, y + 5, 8, 2, '#2f6a62');
    px(x + 2, y + 5, 1, 2, '#4a8a82'); px(x + 9, y + 5, 1, 2, '#26554e');
    rimEdge(x + 9, y + 5, 1, 2, 0.18);
    px(x + 3, y + 6, 1, 1, '#26554e'); px(x + 8, y + 6, 1, 1, '#26554e');   // seat stitches (kept)
    px(x + 2, y + 7, 8, 1, r.face); px(x + 2, y + 7, 3, 1, r.lit);          // front lip
    px(x + 3, y + 8, 6, 1, r.dk);                                          // rounded skirt
    // ARMRESTS — the second tell, and the cheapest one: two nubs breaking the outline east and west,
    // riding just above the seat. Drawn last so they read as in FRONT of the pad, not sunk into it.
    px(x, y + 2, 2, 4, LINE); px(x + 10, y + 2, 2, 4, LINE);
    px(x, y + 3, 2, 1, shade(r.face, 0.14)); keyEdge(x, y + 3, 1, 1, 0.26);   // west arm takes the key
    px(x, y + 4, 2, 1, shade(r.face, -0.18));
    px(x + 10, y + 3, 2, 1, shade(r.face, -0.04));            // east arm sits in shade
    px(x + 10, y + 4, 2, 1, r.dk); rimEdge(x + 10, y + 3, 1, 2, 0.22);
  };

  /* ---- CHAIR, TURNED. The south view spends its silhouette on WIDTH (shoulders, armrests out, a
     wide pad); a chair seen from the side has none of that to spend, so the profile is carried by
     three horizontal BREAKS stacked against one vertical: a thin raked back at the tail, the seat
     plane running out from it, and the armrest bar floating above that plane on a post. Draw any of
     those as a filled block and the whole thing collapses into a lump — the gaps ARE the chair.
     Rows are held in lockstep with F.chair (pad top y+4, front lip y+7, column y+7..y+9, base y+10,
     casters y+11) so a turned chair stands at exactly the same height as an unturned one beside it.
     WEST (r=1) is this view mirrored — px()'s LSWAP re-lights it, so the key stays high-west. */
  F['chair:e'] = (x, y, w, h, f) => {
    const r = RAMP.steel;
    shadow2(x + 3, y + 10, 7);
    // star base in profile: the arms fore-and-aft read as one low bar, casters under its ends
    px(x + 2, y + 10, 8, 1, '#10161a');
    px(x + 3, y + 10, 6, 1, '#2a343c'); keyEdge(x + 3, y + 10, 3, 1, 0.16);
    px(x + 2, y + 9, 1, 1, '#242e35'); px(x + 9, y + 9, 1, 1, '#242e35');
    for (const cw of [x + 2, x + 5, x + 8]) px(cw, y + 11, 2, 1, '#1a1e22');
    // gas-lift column, west of the seat's midpoint (the seat runs east off the back)
    px(x + 4, y + 7, 4, 3, LINE);
    px(x + 5, y + 7, 1, 3, '#54616a'); px(x + 6, y + 7, 1, 3, '#39434b');
    keyEdge(x + 5, y + 7, 1, 2, 0.20); rimEdge(x + 6, y + 7, 1, 3, 0.22);
    /* THE BACK — one RAKED mass from crown to seat, silhouette first, fills after. The first draft
       stacked a proud headrest block on a thin straight post and the profile read as a CISTERN ON A
       BOWL: what says "office chair" from the side is the RAKE — the crown hangs a step further
       west every row up, and the foot tucks into the seat ink with no gap. Height stays in lockstep
       with F.chair (crown y-4, foot at the pad). */
    px(x + 3, y - 4, 4, 1, LINE);                               // crown, eased a px at each end
    px(x + 2, y - 3, 6, 1, LINE);
    px(x + 2, y - 2, 6, 2, LINE);
    px(x + 3, y + 0, 5, 2, LINE);
    px(x + 4, y + 2, 4, 1, LINE);                               // lumbar foot, tucked into the seat ink
    px(x + 3, y - 3, 4, 1, r.lit); keyEdge(x + 3, y - 3, 3, 1, 0.28);   // the crown catches the strip
    px(x + 3, y - 2, 4, 2, shade(r.face, -0.04));             // mesh, edge-on — a full slab, not a stalk
    px(x + 3, y - 2, 1, 2, shade(r.face, 0.12)); keyEdge(x + 3, y - 2, 1, 2, 0.18);
    px(x + 6, y - 2, 1, 2, r.dk); rimEdge(x + 6, y - 2, 1, 2, 0.20);
    px(x + 4, y + 0, 3, 1, shade(r.face, -0.10));             // weave row
    px(x + 4, y + 0, 1, 1, shade(r.face, 0.06)); px(x + 6, y + 0, 1, 1, shade(r.dk, 0.04));
    px(x + 4, y + 1, 3, 1, shade(r.face, -0.26));             // lumbar pinch
    /* THE FAR ARMREST, behind the seat plane. The camera looks down, so the far arm rides HIGH and
       dark and the near arm LOW and lit, with the seat plane between them — that pair of offset
       rails IS the side view. It stops a px short of the seat's front: arms never reach the knees. */
    px(x + 5, y + 1, 6, 2, LINE);
    px(x + 6, y + 1, 4, 1, shade(r.face, -0.18));
    px(x + 6, y + 2, 4, 1, shade(r.dk, -0.06));
    /* THE SEAT — its top plane running east off the back, still the biggest patch of colour, and
       its east END is the seat's FRONT: below it the profile stays OPEN down to the base, because
       the daylight under the knees is the thing that makes it furniture. */
    px(x + 3, y + 3, 9, 5, LINE);
    px(x + 4, y + 3, 7, 1, '#4a8a82'); px(x + 4, y + 3, 4, 1, '#5aa89c');
    keyEdge(x + 4, y + 3, 3, 1, 0.20);
    px(x + 4, y + 4, 7, 2, '#2f6a62');
    px(x + 4, y + 4, 1, 2, '#4a8a82'); px(x + 10, y + 4, 1, 2, '#26554e');
    rimEdge(x + 10, y + 3, 1, 3, 0.22);
    px(x + 6, y + 5, 1, 1, '#26554e'); px(x + 9, y + 5, 1, 1, '#26554e');   // seat stitches
    px(x + 4, y + 6, 7, 1, r.face); px(x + 4, y + 6, 3, 1, r.lit);          // front lip
    px(x + 5, y + 7, 5, 1, r.dk);                                           // rounded skirt
    /* THE NEAR ARMREST last, so it reads in FRONT of the pad — the LIGHT rail against the far one's
       dark, and with both drawn the profile can never collapse into one grey mass. */
    px(x + 4, y + 5, 7, 2, LINE);
    px(x + 5, y + 5, 5, 1, r.lit); keyEdge(x + 5, y + 5, 3, 1, 0.30);
    px(x + 5, y + 6, 5, 1, shade(r.face, -0.10));
    px(x + 9, y + 5, 1, 2, r.dk); rimEdge(x + 9, y + 5, 1, 2, 0.22);
  };

  /* ---- CHAIR FROM BEHIND. The one back view worth authoring in the whole catalog: a chair pushed
     up to a desk, or one with a body sitting in it, genuinely is seen from behind. It is the south
     view's silhouette with the FRONT taken away — no pad plane, no armrest tops, no stitching — so
     what is left has to be the back's outer SHELL: one continuous surface, seamed down the spine,
     with the pad's rear edge showing under it. ⛔ A back is the emptiest surface a prop owns: give it
     ONE organising shape and keep every mark touching it, or the marks read as glyphs. */
  F['chair:n'] = (x, y, w, h, f) => {
    const r = RAMP.steel;
    shadow2(x + 3, y + 10, 7);
    px(x + 2, y + 10, 8, 1, '#10161a');
    px(x + 3, y + 10, 6, 1, '#2a343c'); keyEdge(x + 3, y + 10, 3, 1, 0.16);
    px(x + 2, y + 9, 1, 1, '#242e35'); px(x + 9, y + 9, 1, 1, '#242e35');
    for (const cw of [x + 2, x + 5, x + 8]) px(cw, y + 11, 2, 1, '#1a1e22');
    px(x + 4, y + 7, 4, 3, LINE);
    px(x + 5, y + 7, 1, 3, '#54616a'); px(x + 6, y + 7, 1, 3, '#39434b');
    keyEdge(x + 5, y + 7, 1, 2, 0.20); rimEdge(x + 6, y + 7, 1, 3, 0.22);
    // the pad, seen from behind: only its rear edge and underside are left
    px(x + 1, y + 3, 10, 5, LINE);
    px(x + 2, y + 4, 8, 2, shade('#2f6a62', -0.22));           // upholstery in its own shadow
    px(x + 2, y + 4, 8, 1, shade('#4a8a82', -0.26));
    px(x + 2, y + 6, 8, 1, r.dk); px(x + 3, y + 7, 6, 1, shade(r.dk, -0.30));
    // the SHELL: same waisted outline as the front, but a solid moulded back instead of mesh
    px(x + 4, y - 4, 4, 1, LINE); px(x + 3, y - 3, 6, 1, LINE);
    px(x + 2, y - 2, 8, 4, LINE); px(x + 3, y + 2, 6, 1, LINE);
    px(x + 4, y - 3, 4, 1, shade(r.face, 0.10));               // headrest bar, dimmer than its front
    keyEdge(x + 4, y - 3, 2, 1, 0.20);
    px(x + 3, y - 2, 6, 3, shade(r.face, -0.10));
    px(x + 3, y - 2, 1, 3, shade(r.face, 0.04)); px(x + 8, y - 2, 1, 3, shade(r.dk, 0.06));
    rimEdge(x + 8, y - 2, 1, 3, 0.20);
    px(x + 5, y - 2, 2, 3, shade(r.face, -0.02));              // the shell's crowned spine
    px(x + 5, y + 1, 2, 1, shade(r.face, -0.30));
    px(x + 4, y + 1, 4, 1, shade(r.face, -0.26));              // lumbar pinch
    px(x + 4, y + 2, 4, 1, shade(r.dk, -0.10));                // the mounting bracket under it
    // armrests from behind: their far ends only, breaking the outline east and west
    px(x, y + 2, 2, 4, LINE); px(x + 10, y + 2, 2, 4, LINE);
    px(x, y + 3, 2, 1, shade(r.face, 0.06)); keyEdge(x, y + 3, 1, 1, 0.22);
    px(x, y + 4, 2, 1, shade(r.face, -0.24));
    px(x + 10, y + 3, 2, 1, shade(r.face, -0.14));
    px(x + 10, y + 4, 2, 1, r.dk); rimEdge(x + 10, y + 3, 1, 2, 0.22);
  };

  /* ============ TABLES (2026-07-26) ============
     The catalog had big hero surfaces (holotable, wartable, bar, bench) and nothing in between, so
     every small object — a plasma globe, a lava lamp, a terrarium — had to be parked on the deck,
     where it reads as litter. These three exist to be SAT ON: each carries `surface: true`, and a
     prop whose catalog row says `mount: 'surface'` may be placed on their tiles.

     THE ONE RULE THAT MAKES STACKING WORK: every table presents its top plane at the SAME height,
     SURFACE_RISE px above the floor line, so a mounted prop is drawn by shifting it up one constant
     and lands convincingly on ANY table. If you author a new table, its top face must straddle that
     plane — otherwise objects float above it or sink into it. There is no per-table offset and there
     should never be one: the moment tables disagree on height, every mounted prop needs a lookup. */
  /* THE THREE TABLES ARE DRAWN TOP-DOWN. v6 drew all three EDGE-ON — you saw the front lip of the
     top as a 3-4px band with legs under it, which is the view you get standing at eye level beside a
     table. This station is TOP-BIAS OBLIQUE: the camera looks DOWN, so a table's whole subject is its
     TOP SURFACE, drawn as a foreshortened plane, with only a short thickness and legs beneath it.
     Andrew rejected all three on exactly this ("set up as if you're looking at it at eye level, which
     you're not") and approved the crate and the bar, both of which lead with a big top plane — as do
     desk and couch. So this is v3's locked projection law, which v6 had quietly broken.

     THE LAYOUT IS FORCED, so all three share it. SURFACE_RISE pins 'top' (= y+3 at h:1) to the plane a
     mounted prop is seated on, and that plane has to be the top surface's NEAR EDGE — put it anywhere
     else and everything standing on a table floats or sinks. Working back from that:
         top-8 .. top      the top surface, 9 rows, foreshortened
         top+1 .. top+2    the top's own THICKNESS — the slab edge
         top+3 .. top+8    the legs, with BARE DECK between them
     A first attempt at this projection let the top plane run down to y+6 and drew the legs behind it,
     which left 3px leg stubs and all three tables read as solid BOXES. A table is a plane held UP;
     if you cannot see daylight under it, it is a crate. */
  F.sidetable = (x, y, w, h, f) => {
    // 1x1 SIDE TABLE — the "put ONE thing here" surface. It is a small four-legged square table, and
    // it got here by elimination: a ROUND PEDESTAL cannot be drawn at this size. A disc on a stem over
    // a foot is a GOBLET, and three passes proved it — flattening the disc, narrowing the stem and
    // shrinking the foot each helped and none of them fixed it, because the silhouette itself is the
    // problem, not its shading. Four legs at the corners is unambiguous at any size. It still reads
    // apart from the other two instantly: it is the only table that is as deep as it is wide.
    const top = y + h - 1 - SURFACE_RISE;                                  // = y+3 at h:1
    const WD = '#63513a', WD_LIT = '#8a7154', WD_DK = '#382c1f';
    shadow2(x + 2, y + h - 1, 8);
    for (const lx of [x + 2, x + w - 4]) {                                 // rear pair, behind the top
      px(lx, top - 1, 2, 5, shade(WD, -0.26)); rimEdge(lx, top - 1, 1, 4, 0.16);
    }
    for (const lx of [x + 1, x + w - 3]) {                                 // front pair
      px(lx, top + 1, 2, 7, LINE);
      px(lx, top + 1, 1, 7, WD_LIT); px(lx + 1, top + 1, 1, 7, WD_DK);
      keyEdge(lx, top + 1, 1, 5, 0.16); rimEdge(lx + 1, top + 2, 1, 5, 0.18);
      px(lx, y + h - 1, 2, 1, '#0a0d10');
    }
    px(x + 3, top + 5, w - 6, 1, WD_DK);                                   // a stretcher between the legs
    // THE TOP as a foreshortened plane with chamfered corners, near edge at 'top'
    chamf(x, top - 6, w, 9, LINE, 2);
    chamf(x + 1, top - 5, w - 2, 7, WD, 1);
    px(x + 2, top - 5, w - 4, 1, WD_LIT); keyEdge(x + 2, top - 5, 4, 1, 0.26);   // lit back edge
    px(x + 1, top - 3, 1, 4, shade(WD, 0.10)); px(x + w - 2, top - 3, 1, 4, WD_DK);
    rimEdge(x + w - 2, top - 3, 1, 4, 0.20);
    px(x + 2, top - 1, w - 4, 1, shade(WD, -0.20));                      // the near half falls off
    px(x + 3, top - 4, 5, 1, shade(WD, 0.08));                           // a little grain
    px(x + 2, top, w - 4, 1, WD_DK);                                       // the top's THICKNESS
    px(x + 2, top + 1, w - 4, 1, shade(WD_DK, -0.44));
  };

  F.loungetable = (x, y, w, h, f) => {
    // 2x1 low COFFEE TABLE — a GLASS top you look down THROUGH, over a steel frame and a real shelf.
    // Drawn top-down the glass finally earns its keep: the shelf reads THROUGH the pane, a cue no
    // edge-on 4px band could ever carry. The pane is painted at alpha over everything beneath it.
    // Keep the surround to a 1px outline: a heavy LINE border round a dark translucent field is a
    // SCREEN, and that is what the first top-down pass produced.
    const r = RAMP.steel, top = y + h - 1 - SURFACE_RISE;
    const GLS = '#4a5c6e', GLS_LIT = '#a8bccb';
    shadow2(x + 1, y + h - 1, w - 2);
    // LEGS — four, and they must read. Front pair lit, rear pair cool and thinner. Bare deck between.
    for (const lx of [x + 2, x + w - 5]) {                                 // rear pair, up behind the top
      px(lx + 1, top + 1, 2, 6, shade(r.face, -0.24)); rimEdge(lx + 1, top + 1, 1, 5, 0.16);
    }
    for (const lx of [x + 1, x + w - 4]) {                                 // front pair
      px(lx, top + 3, 3, 6, LINE);
      px(lx, top + 3, 1, 6, r.lit); px(lx + 1, top + 3, 2, 6, r.dk);
      rimEdge(lx + 2, top + 3, 1, 5, 0.18);
      px(lx, y + h - 2, 3, 1, r.ao);
      ctx.globalAlpha = 0.30; px(lx - 1, y + h - 1, 5, 1, '#000'); ctx.globalAlpha = 1;
    }
    // UNDER-SHELF spanning between the legs, seen through the glass
    px(x + 4, top - 2, w - 8, 4, shade(r.face, -0.30));
    px(x + 4, top - 2, w - 8, 1, shade(r.face, 0.10));
    px(x + 7, top - 1, 7, 1, '#5d6b63'); px(x + 7, top - 1, 4, 1, '#7a8a80');   // two datapads on it
    px(x + 8, top, 6, 1, '#4a5a66'); px(x + 8, top, 3, 1, '#647686');
    // THE PANE — translucent, so everything above survives underneath. That IS the glass.
    ctx.globalAlpha = 0.58;
    px(x + 1, top - 8, w - 2, 9, GLS);
    ctx.globalAlpha = 1;
    px(x + 1, top - 9, w - 2, 1, LINE); px(x + 1, top + 1, w - 2, 1, LINE);
    px(x, top - 8, 1, 9, LINE); px(x + w - 1, top - 8, 1, 9, LINE);
    px(x + 1, top - 8, w - 2, 1, GLS_LIT); keyEdge(x + 2, top - 8, 10, 1, 0.30);   // bright leading edge
    px(x + 1, top, w - 2, 1, shade(GLS_LIT, -0.40));                     // the near edge, dimmer
    px(x + 1, top - 7, 1, 7, shade(GLS_LIT, -0.30)); px(x + w - 2, top - 7, 1, 7, shade(GLS, -0.34));
    rimEdge(x + w - 2, top - 7, 1, 7, 0.22);
    for (let i = 0; i < 5; i++) px(x + 3 + i, top - 7 + i, 7 - i, 1, shade(GLS_LIT, -0.18 - i * 0.07));  // specular
    // the pane's own THICKNESS below the near edge
    px(x + 2, top + 2, w - 4, 1, shade(GLS, -0.44));
  };

  F.longtable = (x, y, w, h, f) => {
    // 3x1 REFECTORY table — heavy warm timber on FOUR corner legs. Drawn top-down, so the subject is
    // a broad PLANKED TABLETOP with the frame reading underneath it. The plank seams run the length
    // of the boards, which top-down means ACROSS the table — the clearest single tell that the
    // projection actually changed, since the edge-on version ran them the other way.
    // ⛔ IT HAD TWO A-FRAME TRESTLES AND THEY DO NOT SURVIVE A TURN (Andrew, 2026-08-17: "awful side
    //    angle"). Turned side-on, a pair of trestles stacks into ONE centred post and the table reads
    //    as a pedestal monolith. Four legs at the corners are the one frame that reads the same from
    //    every facing: two under the near edge, two behind the plane, daylight between them.
    const WD = '#5c4732', WD_LIT = '#7a6044', WD_DK = '#3a2c1e';
    const top = y + h - 1 - SURFACE_RISE;
    shadow2(x + 2, y + h - 1, w - 4);
    for (const lx of [x + 3, x + w - 6]) {                                 // REAR pair, up behind the top
      px(lx, top + 1, 3, 6, shade(WD, -0.30)); rimEdge(lx + 2, top + 1, 1, 5, 0.14);
    }
    for (const lx of [x + 2, x + w - 5]) {                                 // FRONT pair, under the near edge
      px(lx, top + 3, 3, 6, LINE);
      px(lx, top + 3, 1, 6, WD_LIT); px(lx + 1, top + 3, 2, 6, WD_DK);
      keyEdge(lx, top + 3, 1, 4, 0.16); rimEdge(lx + 2, top + 4, 1, 4, 0.18);
      ctx.globalAlpha = 0.30; px(lx - 1, y + h - 1, 5, 1, '#000'); ctx.globalAlpha = 1;
    }
    px(x + 5, top + 6, w - 10, 1, WD_DK);                                  // stretcher down the length
    px(x + 5, top + 6, 5, 1, shade(WD_DK, 0.16));
    px(x + 5, top + 7, w - 10, 1, shade(WD_DK, -0.40));
    // THE TABLETOP as a foreshortened plane: 9 rows deep, back edge lit, near edge falling into shade
    px(x - 1, top - 9, w + 2, 11, LINE);
    px(x, top - 8, w, 9, WD);
    px(x, top - 8, w, 1, WD_LIT); keyEdge(x + 1, top - 8, 11, 1, 0.26);
    px(x, top - 7, w, 1, shade(WD, 0.16));                               // the far half takes the key
    px(x, top - 1, w, 1, shade(WD, -0.16));                              // the near half falls off
    px(x, top, w, 1, shade(WD, -0.30));
    px(x, top - 8, 1, 9, WD_LIT); px(x + w - 1, top - 8, 1, 9, WD_DK);
    rimEdge(x + w - 1, top - 7, 1, 8, 0.20);
    for (const sy of [top - 5, top - 2]) {                                 // plank seams, running ACROSS
      px(x, sy, w, 1, shade(WD, -0.40));
      px(x, sy + 1, w, 1, shade(WD, 0.12));                              // the next board's lit lip
    }
    for (let i = 0; i < 6; i++) {                                          // grain, clamped to the top
      const gx = x + 2 + i * 7; if (gx + 4 <= x + w) px(gx, top - 7 + (i % 3) * 3, 4, 1, shade(WD, 0.08));
    }
    px(x, top + 1, w, 1, WD_DK);                                           // the top's THICKNESS, near edge
    px(x + 1, top + 2, w - 2, 1, shade(WD_DK, -0.44));
  };
  /* ---- TABLES, TURNED. A table is the one family whose footprint genuinely IS its plan: the box is
     the TOP SURFACE seen from above, so a 3×1 trestle turned really is a 1×3 one and things stand on
     it accordingly. These views are therefore drawn for the SWAPPED box (footprintAt re-tiles any
     `surface: true` prop), and the whole job is that the top plane now RECEDES instead of running
     across: it gets deep, the near edge stays pinned to the SURFACE_RISE plane so mounted props
     still land on it, and only the NEAR trestle/legs are visible — the far pair is behind the plane,
     which is exactly what a table looks like from here. Both side facings are the same picture, so
     only one is offered (SIDE_SYMMETRIC): an R key that changes nothing is the same lie as a view
     that draws nothing. */
  F['loungetable:e'] = (x, y, w, h, f) => {
    // 1×2 deep COFFEE TABLE — the glass-over-steel table, receding. Two drafts failed the same way:
    // lit at the far edge it was a NOTICEBOARD, and with the under-shelf drawn full-bleed the pane
    // was a CABINET FRONT with the datapads for shelves. Glass only reads as glass when the DECK
    // SURVIVES THROUGH IT: the shelf is an inset plate floating under the middle of the pane with
    // clear margins all round, the pane itself is a half-alpha tint, and the west rail carries the
    // key end to end the way every receding plane here is lit.
    const r = RAMP.steel, top = y + h - 1 - SURFACE_RISE;
    const GLS = '#4a5c6e', GLS_LIT = '#a8bccb';
    const D = top - (y + 1);                                               // the pane's depth in rows
    shadow2(x + 1, y + h - 1, w - 2);
    ctx.globalAlpha = 0.20; px(x + w + 1, y + 3, 2, D + 4, '#000'); ctx.globalAlpha = 1;
    for (const lx of [x + 1, x + w - 4]) {                                 // NEAR pair, under the near edge
      px(lx, top + 3, 3, 6, LINE);
      px(lx, top + 3, 1, 6, r.lit); px(lx + 1, top + 3, 2, 6, r.dk);
      rimEdge(lx + 2, top + 3, 1, 5, 0.18);
      px(lx, y + h - 2, 3, 1, r.ao);
      ctx.globalAlpha = 0.30; px(lx - 1, y + h - 1, 5, 1, '#000'); ctx.globalAlpha = 1;
    }
    // UNDER-SHELF — an inset plate under the middle of the pane, never a full-bleed interior
    px(x + 2, top - D + 6, w - 4, D - 10, shade(r.face, -0.30));
    px(x + 2, top - D + 6, w - 4, 1, shade(r.face, 0.08));
    px(x + 4, top - D + 8, 4, 2, '#5d6b63'); px(x + 4, top - D + 8, 2, 1, '#6d7d74');   // one datapad on it
    // THE PANE — a half-alpha tint a px proud of its tile each side, so deck texture rides through
    ctx.globalAlpha = 0.50;
    px(x, top - D, w, D + 1, GLS);
    ctx.globalAlpha = 1;
    px(x, top - D - 1, w, 1, LINE); px(x, top + 1, w, 1, LINE);            // eased corners for free:
    px(x - 1, top - D, 1, D + 1, LINE); px(x + w, top - D, 1, D + 1, LINE); // the rows stop a px short
    px(x + 1, top - D, w - 2, 1, shade(GLS_LIT, -0.18));                 // far edge, present but QUIET
    px(x, top - D + 1, 1, D - 1, GLS_LIT);                                 // THE WEST RAIL — lit end to end
    keyEdge(x, top - D + 1, 1, Math.min(8, D - 1), 0.30);
    px(x + w - 1, top - D + 1, 1, D - 1, shade(GLS, -0.34));
    rimEdge(x + w - 1, top - D + 3, 1, D - 3, 0.22);
    px(x + 1, top, w - 2, 1, shade(GLS_LIT, -0.40));                     // the near edge, dimmer
    for (let i = 0; i < 6; i++)                                            // the SPECULAR WEDGE — the south view's
      px(x + 1, top - D + 2 + i, 7 - i, 1, shade(GLS_LIT, -0.16 - i * 0.06));   // glass cue, swept down the lit rail
    px(x + 2, top - 5, 3, 1, shade(GLS_LIT, -0.34));                     // a second, smaller catch near the foot
    px(x + 1, top + 2, w - 2, 1, shade(GLS, -0.44));                     // the pane's own thickness
  };

  F['longtable:e'] = (x, y, w, h, f) => {
    // 1×3 deep REFECTORY table — one long PLANKED board running away from you, on the near pair of legs.
    // Same law as the coffee table above: the first pass keyEdged the far end and the board read as
    // a PLANK LEANING ON THE WALL. The receding read is carried by three things — the west rail lit
    // end to end, chamfered board ENDS (a plank is square, a tabletop is eased), and the contact
    // shadow down the east flank. The board also sits 2px proud of its tile each side: a table is
    // wider than a walk lane, and the extra width is what keeps it from reading as a floorboard.
    // ⛔ THIS FACING IS WHY THE TABLE HAS FOUR LEGS. Its two trestles projected onto each other into
    //    a single fat centred post — a pedestal, not a table. The near pair stands at the CORNERS of
    //    the near end and frames the daylight under the board; the far pair is honestly hidden behind
    //    the plane, which is what a table looks like from here.
    const WD = '#5c4732', WD_LIT = '#7a6044', WD_DK = '#3a2c1e';
    const top = y + h - 1 - SURFACE_RISE;
    const D = top - (y + 1);                                               // the tabletop's depth in rows
    shadow2(x + 1, y + h - 1, w - 2);
    ctx.globalAlpha = 0.22; px(x + w + 1, y + 3, 2, D + 5, '#000'); ctx.globalAlpha = 1;
    px(x + 5, top + 3, 2, 5, shade(WD_DK, 0.10));                        // the length stretcher, running away
    for (const lx of [x + 1, x + w - 4]) {                                 // THE NEAR PAIR, at the corners
      px(lx, top + 3, 3, 6, LINE);
      px(lx, top + 3, 1, 6, WD_LIT); px(lx + 1, top + 3, 2, 6, WD_DK);
      keyEdge(lx, top + 3, 1, 4, 0.16); rimEdge(lx + 2, top + 4, 1, 4, 0.18);
      ctx.globalAlpha = 0.30; px(lx - 1, y + h - 1, 5, 1, '#000'); ctx.globalAlpha = 1;
    }
    px(x + 3, y + h - 4, w - 6, 1, WD_DK);                                 // end rail between the near legs
    px(x + 3, y + h - 5, w - 6, 1, shade(WD_DK, 0.14));
    // THE BOARD as a long receding plane, its ends eased
    chamf(x - 2, top - D - 1, w + 4, D + 3, LINE, 2);
    chamf(x - 1, top - D, w + 2, D + 1, WD, 1);
    px(x, top - D, w, 1, shade(WD, 0.10));                               // far end — a warm lift, no key blast
    px(x - 1, top - D + 1, 1, D - 1, WD_LIT);                              // THE WEST RAIL — lit end to end
    keyEdge(x - 1, top - D + 1, 1, Math.min(9, D - 1), 0.24);
    px(x, top - D + 1, 1, D - 1, shade(WD, 0.10));                       // its board already turning away
    px(x + w, top - D + 1, 1, D - 1, WD_DK);                               // east rail in its own shade
    rimEdge(x + w, top - D + 4, 1, D - 4, 0.20);
    px(x, top - 1, w, 1, shade(WD, -0.16));                              // the near end falls off
    px(x, top, w, 1, shade(WD, -0.30));
    for (const sx of [x + 3, x + 7]) {                                     // plank seams, running the LENGTH, quiet
      px(sx, top - D + 1, 1, D, shade(WD, -0.26));
      px(sx + 1, top - D + 1, 1, D, shade(WD, 0.06));
    }
    for (let i = 0; i < 6; i++) {                                          // grain, clamped to the top
      const gy = top - D + 3 + i * 4; if (gy + 3 <= top) px(x + 1 + (i % 3) * 3, gy, 1, 3, shade(WD, 0.08));
    }
    px(x - 1, top + 1, w + 2, 1, WD_DK);                                   // the top's THICKNESS, near edge
    px(x, top + 2, w, 1, shade(WD_DK, -0.44));
  };

  /* ============ THE LOW TABLE + THE DINER SET (2026-08-17) ============
     Andrew: "a new table thats 1x3, a bit shorter like a coffee table kind of vibe, then make a
     diner style table thats 3x2 with new chairs as well."

     ⛔ A TABLE'S TOP PLANE MAY NOT MOVE. Every table in this file pins its top surface to the
        SURFACE_RISE plane so a mounted prop is lifted by ONE constant and lands on ANY of them
        (draw() has no idea WHICH table it is over). So "shorter" cannot be bought by dropping the
        top — that floats every mug placed on it. It is bought by EATING THE DAYLIGHT: the long
        table stands on four slim legs over an 8-row band of open deck, and this one fills most of
        that band with a thick slab edge, stub legs and a low shelf. Same top height, and the eye
        reads it as low and heavy because there is no air under it. */
  F.lowtable = (x, y, w, h, f) => {
    // 3x1 LOW TABLE — a long lounge coffee table: one thick oak slab, four stubby legs and a
    // magazine shelf slung between them. Its whole identity against the LONG TABLE is MASS: a
    // 3px slab edge instead of 1, chunky blocks instead of posts, and a shelf where that one has
    // open air. The TOP is left clear — things get placed on it, so built-in clutter belongs on
    // the shelf below rather than on the surface the player is meant to use.
    // ⛔ THE THICK EDGE IS A LIT PLANE, NOT A BLACK BAND. Painted flat dark it read as the shadow
    //    under a crate; a slab edge takes the ceiling strip on its top row like everything else.
    const WD = '#6f5433', WD_LIT = '#8a6a42', WD_DK = '#40301d', INK = '#241a10';
    const top = y + h - 1 - SURFACE_RISE;                                  // = y+3 at h:1 — THE shared plane
    shadow2(x + 1, y + h - 1, w - 2);
    // FOUR STUB LEGS — 4px blocks at the corners. Short and wide is the whole read; a slim post
    // under a thick slab reads as a dining table someone sawed the legs off.
    for (const lx of [x + 3, x + w - 7]) {                                 // rear pair, behind the slab
      px(lx, top + 5, 4, 4, shade(WD, -0.34)); rimEdge(lx + 3, top + 5, 1, 4, 0.14);
    }
    for (const lx of [x + 2, x + w - 6]) {                                 // front pair, under the near edge
      px(lx, top + 5, 4, 4, INK);
      px(lx + 1, top + 5, 1, 4, WD_LIT); px(lx + 2, top + 5, 2, 4, WD_DK);
      keyEdge(lx + 1, top + 5, 1, 3, 0.18); rimEdge(lx + 3, top + 6, 1, 3, 0.18);
      ctx.globalAlpha = 0.32; px(lx - 1, y + h - 1, 6, 1, '#000'); ctx.globalAlpha = 1;
    }
    // THE SHELF between them, with two magazines lying on it — the one saturated thing on the prop,
    // and the reason this table can afford to keep its top clear.
    px(x + 6, top + 5, w - 12, 3, INK);
    px(x + 7, top + 5, w - 14, 1, shade(WD, 0.06)); keyEdge(x + 7, top + 5, 6, 1, 0.18);
    px(x + 7, top + 6, w - 14, 1, shade(WD, -0.26));
    px(x + 8, top + 6, 8, 1, '#a8503a'); px(x + 8, top + 6, 4, 1, '#c96b4c');       // a red magazine
    px(x + 18, top + 6, 7, 1, '#b09044'); px(x + 18, top + 6, 3, 1, '#cfae62');     // and a tan one
    // THE SLAB — 8 rows of top plane over a 3-row edge. That edge IS the prop: it is the only
    // table here whose thickness you can read at a glance.
    chamf(x - 1, top - 8, w + 2, 13, INK, 2);
    chamf(x, top - 7, w, 10, WD, 1);
    px(x + 1, top - 7, w - 2, 1, WD_LIT); keyEdge(x + 1, top - 7, 8, 1, 0.26);      // lit far edge
    px(x, top - 6, w, 1, shade(WD, 0.16));
    px(x, top - 1, w, 1, shade(WD, -0.10));                                       // near half falls off
    px(x, top - 7, 1, 9, WD_LIT); px(x + w - 1, top - 7, 1, 9, WD_DK);
    rimEdge(x + w - 1, top - 6, 1, 8, 0.20);
    px(x + 1, top - 4, w - 2, 1, shade(WD, -0.26));                                // ONE plank seam, quiet
    px(x + 1, top - 3, w - 2, 1, shade(WD, 0.10));
    for (let i = 0; i < 7; i++) {                                                   // grain, clamped to the top
      const gx = x + 2 + i * 5; if (gx + 4 <= x + w - 1) px(gx, top - 6 + (i % 3) * 3, 4, 1, shade(WD, 0.07));
    }
    px(x, top + 1, w, 1, shade(WD, 0.02)); keyEdge(x + 1, top + 1, 8, 1, 0.20);    // THE EDGE, lit on top
    px(x, top + 2, w, 1, WD_DK);
    px(x + 1, top + 3, w - 2, 1, shade(WD_DK, -0.44));                            // its underside in shade
  };

  F['lowtable:e'] = (x, y, w, h, f) => {
    // 1x3 deep LOW TABLE — the same slab running away from you. Same three receding cues as the
    // long table: the west rail lit end to end, eased ends, and a contact shadow down the east
    // flank; the difference stays MASS — a 3px edge under the board and stub legs at the corners.
    // ⛔ A LOW TABLE TURNED IS ONE STEP FROM A DOOR. The first pass tied its two stub legs together
    //    with a solid end rail and the whole prop became an upright panel. What saves it is DAYLIGHT
    //    IN THE MIDDLE: the shelf recedes as a narrow plank with bare deck either side of it, so the
    //    base is three marks with gaps, not one wall.
    const WD = '#6f5433', WD_LIT = '#8a6a42', WD_DK = '#40301d', INK = '#241a10';
    const top = y + h - 1 - SURFACE_RISE;
    const D = top - (y + 1);
    shadow2(x + 1, y + h - 1, w - 2);
    ctx.globalAlpha = 0.22; px(x + w + 1, y + 3, 2, D + 5, '#000'); ctx.globalAlpha = 1;
    px(x + 5, top + 5, 3, 4, INK);                                                  // the shelf, receding
    px(x + 5, top + 5, 3, 1, shade(WD, -0.04)); px(x + 5, top + 6, 3, 1, '#a8503a');
    px(x + 5, top + 7, 3, 1, shade(WD, -0.30));
    for (const lx of [x + 1, x + w - 5]) {                                          // the NEAR pair of stubs
      px(lx, top + 5, 4, 4, INK);
      px(lx + 1, top + 5, 1, 4, WD_LIT); px(lx + 2, top + 5, 2, 4, WD_DK);
      keyEdge(lx + 1, top + 5, 1, 3, 0.18); rimEdge(lx + 3, top + 6, 1, 3, 0.18);
      ctx.globalAlpha = 0.32; px(lx - 1, y + h - 1, 6, 1, '#000'); ctx.globalAlpha = 1;
    }
    chamf(x - 2, top - D - 1, w + 4, D + 5, INK, 2);
    chamf(x - 1, top - D, w + 2, D + 3, WD, 1);
    px(x, top - D, w, 1, shade(WD, 0.10));                                        // far end — a warm lift
    px(x - 1, top - D + 1, 1, D - 1, WD_LIT);                                       // THE WEST RAIL
    keyEdge(x - 1, top - D + 1, 1, Math.min(9, D - 1), 0.24);
    px(x + w, top - D + 1, 1, D - 1, WD_DK);
    rimEdge(x + w, top - D + 4, 1, D - 4, 0.20);
    px(x, top - 1, w, 1, shade(WD, -0.10));
    for (const sx of [x + 4]) {                                                     // ONE plank seam, quiet
      px(sx, top - D + 1, 1, D, shade(WD, -0.26));
      px(sx + 1, top - D + 1, 1, D, shade(WD, 0.08));
    }
    px(x - 1, top + 1, w + 2, 1, shade(WD, 0.02)); keyEdge(x, top + 1, 5, 1, 0.20);   // THE EDGE, lit on top
    px(x - 1, top + 2, w + 2, 1, WD_DK);
    px(x, top + 3, w, 1, shade(WD_DK, -0.44));
  };

  /* ---- THE GLASS LOUNGE TABLE (2026-08-17, Andrew: "one more low table thats more of the lounge
     style, like a glass lounge table"). The catalog's other glass table — LOUNGE TABLE, 2x1 — is an
     office coffee table: steel legs, datapads on the shelf, a table you put a laptop on. This one is
     the living-room piece: three tiles wide, a BRASS frame instead of steel, and a shelf carrying
     magazines and a bowl rather than hardware.
     ⛔ WHAT MAKES IT LOUNGE IS THE AIR. The wooden LOW TABLE next to it reads low by MASS — a thick
        slab that eats the daylight. Glass cannot do that: a thin pane over a solid base is a display
        cabinet. It reads low by being SEEN THROUGH — the shelf and its clutter sit inside the pane's
        own rows, the frame under it is four thin posts and nothing else, and the deck runs clean
        between them.
     ⛔ GLASS IS THE WEDGE, NOT THE ALPHA (earned on the turned lounge table): over a near-black deck
        a translucent tint is just a dark panel. The diagonal specular sweep IS the glass. */
  F.glasstable = (x, y, w, h, f) => {
    const b = MAT.brass;
    const GLS = '#4a5c6e', GLS_LIT = '#a8bccb';
    const top = y + h - 1 - SURFACE_RISE;                                  // = y+3 at h:1 — the shared plane
    const WD = '#5a4430', WD_LIT = '#7a5f42';
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 4, x + w - 6]) {                                 // REAR posts, up behind the pane
      px(lx, top + 1, 2, 6, b.dk); rimEdge(lx + 1, top + 1, 1, 5, 0.14);
    }
    for (const lx of [x + 2, x + w - 5]) {                                 // FRONT posts — thin, brass, lit
      px(lx, top + 3, 3, 6, b.ink);
      px(lx, top + 3, 1, 6, b.lit); px(lx + 1, top + 3, 2, 6, b.dk);
      keyEdge(lx, top + 3, 1, 4, 0.24); rimEdge(lx + 2, top + 4, 1, 4, 0.18);
      px(lx, y + h - 2, 3, 1, b.ao);
      ctx.globalAlpha = 0.30; px(lx - 1, y + h - 1, 5, 1, '#000'); ctx.globalAlpha = 1;
    }
    px(x + 6, top + 6, w - 12, 1, b.dk);                                   // the frame's low cross rail
    /* THE SHELF, inside the pane's own rows so the glass has something to be seen THROUGH */
    px(x + 5, top - 2, w - 10, 4, '#2a2018');
    px(x + 6, top - 2, w - 12, 1, WD_LIT); keyEdge(x + 6, top - 2, 6, 1, 0.18);
    px(x + 6, top - 1, w - 12, 2, WD);
    px(x + 8, top - 1, 8, 1, '#a8503a'); px(x + 8, top - 1, 4, 1, '#c96b4c');   // magazines, stacked askew
    px(x + 9, top, 7, 1, '#b09044'); px(x + 9, top, 3, 1, '#cfae62');
    px(x + w - 13, top - 1, 5, 3, '#2f6a62');                                   // a bowl on the shelf
    px(x + w - 12, top - 1, 3, 1, '#57a89c'); px(x + w - 12, top, 3, 1, '#245852');
    /* THE PANE — translucent, so every mark above survives underneath. That IS the glass. */
    ctx.globalAlpha = 0.52;
    px(x + 1, top - 8, w - 2, 9, GLS);
    ctx.globalAlpha = 1;
    px(x + 1, top - 9, w - 2, 1, b.ink); px(x + 1, top + 1, w - 2, 1, b.ink);
    px(x, top - 8, 1, 9, b.ink); px(x + w - 1, top - 8, 1, 9, b.ink);
    px(x + 1, top - 8, w - 2, 1, GLS_LIT); keyEdge(x + 2, top - 8, 10, 1, 0.30);   // bright far edge
    px(x + 1, top - 7, 1, 7, shade(GLS_LIT, -0.28)); px(x + w - 2, top - 7, 1, 7, shade(GLS, -0.34));
    rimEdge(x + w - 2, top - 7, 1, 7, 0.22);
    for (let i = 0; i < 7; i++)                                            // THE SPECULAR WEDGE — the glass
      px(x + 3 + i, top - 7 + i, 9 - i, 1, shade(GLS_LIT, -0.14 - i * 0.06));
    px(x + w - 9, top - 4, 3, 1, shade(GLS_LIT, -0.34));                 // a second, smaller catch
    px(x + 1, top, w - 2, 1, shade(GLS_LIT, -0.42));                     // the near edge, dimmer
    px(x + 1, top + 2, w - 2, 1, b.mid);                                   // the pane's BRASS rim below it
    px(x + 2, top + 3, w - 4, 1, b.ao);
  };

  F['glasstable:e'] = (x, y, w, h, f) => {
    // 1x3 deep GLASS LOUNGE TABLE — the same pane receding. Every cue the wooden tables earned holds
    // for glass too: the WEST RAIL lit end to end (a far-edge key would stand it up like a pane of
    // glass leaning on the wall), eased ends, and a contact shadow down the east flank. The shelf
    // stays an INSET plate with clear margins — drawn full-bleed inside the pane it becomes a
    // cabinet front, which is exactly how the first turned lounge table failed.
    const b = MAT.brass;
    const GLS = '#4a5c6e', GLS_LIT = '#a8bccb';
    const WD = '#5a4430', WD_LIT = '#7a5f42';
    const top = y + h - 1 - SURFACE_RISE;
    const D = top - (y + 1);                                               // the pane's depth in rows
    shadow2(x + 1, y + h - 1, w - 2);
    ctx.globalAlpha = 0.22; px(x + w + 1, y + 3, 2, D + 5, '#000'); ctx.globalAlpha = 1;
    for (const lx of [x + 1, x + w - 4]) {                                 // the NEAR posts
      px(lx, top + 3, 3, 6, b.ink);
      px(lx, top + 3, 1, 6, b.lit); px(lx + 1, top + 3, 2, 6, b.dk);
      keyEdge(lx, top + 3, 1, 4, 0.24); rimEdge(lx + 2, top + 4, 1, 4, 0.18);
      px(lx, y + h - 2, 3, 1, b.ao);
      ctx.globalAlpha = 0.30; px(lx - 1, y + h - 1, 5, 1, '#000'); ctx.globalAlpha = 1;
    }
    px(x + 4, top + 6, w - 8, 1, b.dk);                                    // the cross rail, end-on
    /* ⛔ A FULL BRASS SURROUND TURNS A TURNED GLASS TABLE INTO A DISPLAY CABINET. Ink all four
       sides of a tall pane and the eye reads a framed case standing against the wall. The frame
       here is only where a frame really shows from above — the NEAR edge — and the pane is held a
       px inside its tile so deck runs down both flanks. */
    px(x + 3, top - D + 8, w - 6, D - 13, '#2a2018');                      // THE SHELF as a small inset plate
    px(x + 3, top - D + 8, w - 6, 1, WD_LIT); keyEdge(x + 3, top - D + 8, 4, 1, 0.18);
    px(x + 3, top - D + 9, w - 6, 2, WD);
    px(x + 4, top - D + 10, 4, 1, '#a8503a'); px(x + 4, top - D + 10, 2, 1, '#c96b4c');   // magazines
    px(x + 4, top - 9, 4, 3, '#2f6a62');                                                  // the bowl
    px(x + 5, top - 9, 2, 1, '#57a89c'); px(x + 5, top - 8, 2, 1, '#245852');
    ctx.globalAlpha = 0.52;
    px(x + 1, top - D, w - 2, D + 1, GLS);
    ctx.globalAlpha = 1;
    px(x + 1, top - D - 1, w - 2, 1, shade(GLS, -0.40));                 // the far end: glass, not frame
    px(x + 1, top - D, w - 2, 1, shade(GLS_LIT, -0.22));
    px(x, top - D + 1, 1, D, shade(GLS_LIT, -0.10));                     // THE WEST RAIL — lit end to end
    keyEdge(x, top - D + 1, 1, Math.min(9, D), 0.30);
    px(x + w - 1, top - D + 1, 1, D, shade(GLS, -0.38));
    rimEdge(x + w - 1, top - D + 3, 1, D - 3, 0.22);
    for (let i = 0; i < 6; i++)                                            // the wedge, swept down the rail
      px(x + 1, top - D + 2 + i, 7 - i, 1, shade(GLS_LIT, -0.16 - i * 0.06));
    px(x + 2, top - 6, 3, 1, shade(GLS_LIT, -0.34));
    // THE NEAR EDGE — the one place a frame reads: brass rim, its own shadow, then bare deck
    px(x + 1, top, w - 2, 1, shade(GLS_LIT, -0.42));
    px(x, top + 1, w, 1, b.mid); keyEdge(x + 1, top + 1, 5, 1, 0.24);
    px(x, top + 2, w, 1, b.dk);
    px(x + 1, top + 3, w - 2, 1, b.ao);
  };

  /* ---- THE DINER. A 3x2 six-seater with its own chair. It began as cream diner laminate with a
     chrome rim and a RED apron; Andrew rejected the red outright — "dinnertable_v2 is the only way
     to go" — against four other edge treatments (brass, teal, bistro green, walnut-and-chrome) all
     rendered side by side on a real deck. What won is the QUIETEST one: the edge is the slab's own
     timber and the PLANT is the only saturated thing on the prop. That is why the top can stay
     otherwise clear, and why this table sits with the long table and the low table instead of
     shouting over them.
     ⛔ A COOL ACCENT MUST BE AUTHORED ABOVE THE CHROMA SKIP (0.45) OR THE DIAL GREYS IT. The dial
        multiplies authored saturation by 2.6 but caps COOL hues at 0.20 — the anti-teal guard — so
        the leaf green here is picked past the threshold and passes through untouched, while a green
        chosen at a natural 0.35 would render MORE grey than it was authored. Warm hues (timber,
        terracotta) cap at 0.52 and want authoring flat. */
  const DINER_WD = '#6f5433', DINER_WD_LIT = '#8a6a42', DINER_WD_DK = '#40301d', DINER_INK = '#241a10';

  const dinerTop = (x, y, w, h, f) => {
    const WD = DINER_WD, WD_LIT = DINER_WD_LIT, WD_DK = DINER_WD_DK, INK = DINER_INK;
    const CHR = '#bcbec0', CHR_HI = '#eaecee', CHR_DK = '#63676a';
    const top = y + h - 1 - SURFACE_RISE;
    const D = 11;
    shadow2(x + 2, y + h - 1, w - 4);
    // FOUR LEGS — turned timber to match the top, with a metal foot so it does not smear into the deck
    for (const lx of [x + 4, x + w - 7]) {
      px(lx, top + 2, 3, 6, shade(WD, -0.34)); rimEdge(lx + 2, top + 2, 1, 5, 0.14);
    }
    for (const lx of [x + 3, x + w - 6]) {
      px(lx, top + 5, 3, 5, INK);
      px(lx, top + 5, 1, 5, WD_LIT); px(lx + 1, top + 5, 2, 5, WD_DK);
      keyEdge(lx, top + 5, 1, 4, 0.22);
      px(lx - 1, y + h - 2, 5, 2, INK); px(lx, y + h - 2, 3, 1, CHR_DK);
      ctx.globalAlpha = 0.32; px(lx - 2, y + h - 1, 7, 1, '#000'); ctx.globalAlpha = 1;
    }
    px(x + 8, top + 6, w - 16, 1, shade(WD, -0.40));                      // the stretcher
    // THE TOP — a rounded BUTCHER BLOCK: boards of unequal width running across, each with its own
    // value, seamed dark with a lit lip. Unequal is the whole trick — even stripes read as corrugation.
    chamf(x - 1, top - D - 1, w + 2, D + 6, INK, 3);
    chamf(x, top - D, w, D + 4, shade(WD, -0.30), 3);
    chamf(x + 1, top - D + 1, w - 2, D, WD, 2);
    const boards = [3, 2, 3, 2];
    let by = top - D + 1;
    for (let b = 0; b < boards.length; b++) {
      const bh = boards[b];
      px(x + 1, by, w - 2, bh, shade(WD, b % 2 ? 0.07 : -0.05));          // the board's own value
      px(x + 1, by, w - 2, 1, shade(WD, b % 2 ? 0.18 : 0.10));            // its lit lip
      for (let g = 0; g < 5; g++) {                                        // ring grain, sparse
        const gx = x + 3 + ((b * 7 + g * 6) % (w - 8));
        px(gx, by + (bh > 2 ? 1 : 0), 3, 1, shade(WD, b % 2 ? -0.10 : -0.16));
      }
      by += bh;
      if (by < top) px(x + 1, by - 1, w - 2, 1, shade(WD, -0.34));        // the seam between boards
    }
    px(x + 2, top - D + 1, w - 4, 1, shade(WD_LIT, 0.06)); keyEdge(x + 2, top - D + 1, 9, 1, 0.26);
    px(x + 1, top - D + 2, 1, D - 2, WD_LIT); px(x + w - 2, top - D + 2, 1, D - 2, WD_DK);
    rimEdge(x + w - 2, top - D + 3, 1, D - 4, 0.20);
    px(x + 2, top - 1, w - 4, 1, shade(WD, -0.14));
    /* THE PLANT, dead centre — the one living thing, and the reason this top needs no other dressing.
       Terracotta and leaf are both authored PAST the chroma skip so the dial hands them through. */
    const cx0 = x + Math.round(w / 2) - 2;
    const py0 = top - D + 3;
    ctx.globalAlpha = 0.26; px(cx0 + 1, py0 + 8, 4, 1, '#000'); px(cx0 + 5, py0 + 4, 1, 4, '#000'); ctx.globalAlpha = 1;
    for (const l of [[cx0, py0 + 1, 2, 2], [cx0 + 3, py0, 2, 3], [cx0 + 1, py0 - 1, 2, 3], [cx0 + 4, py0 + 2, 1, 2]])
      px(l[0], l[1], l[2], l[3], '#2f7a24');                                // the mass of leaves
    px(cx0 + 1, py0 - 1, 1, 2, '#49a336'); px(cx0 + 3, py0, 1, 2, '#49a336');   // lit leaf faces
    px(cx0 + 2, py0 + 2, 1, 2, '#1c4d17');                                  // its own shade
    px(cx0, py0 + 4, 5, 4, INK);                                            // the pot
    px(cx0 + 1, py0 + 4, 3, 3, '#a8552f'); px(cx0 + 1, py0 + 4, 3, 1, '#c96f42');
    keyEdge(cx0 + 1, py0 + 4, 2, 1, 0.24);
    px(cx0 + 3, py0 + 5, 1, 2, '#6d3419');
    // THE NEAR EDGE — the slab's own timber. No band: that was the red, and it is gone.
    px(x + 1, top, w - 2, 1, shade(WD, 0.04)); keyEdge(x + 2, top, 10, 1, 0.22);
    px(x + 1, top + 1, w - 2, 2, WD_DK);
    px(x + 2, top + 3, w - 4, 1, shade(WD_DK, -0.40));
    px(x, top - 2, 1, 6, WD_DK); px(x + w - 1, top - 2, 1, 6, WD_DK);
  };
  F.dinertable = (x, y, w, h, f) => dinerTop(x, y, w, h, f);

  F['dinertable:e'] = (x, y, w, h, f) => {
    /* 2x3 deep DINER TABLE — the same butcher block running away from you, which is how it sits
       along a wall with chairs down both long sides. The boards turn with it: across the width when
       it faces you, down the LENGTH when it is turned, because a board's direction is the one thing
       a turned tabletop cannot fake. Receding cues are the family's: the west rail lit end to end,
       eased ends, and a contact shadow down the east flank. */
    const WD = DINER_WD, WD_LIT = DINER_WD_LIT, WD_DK = DINER_WD_DK, INK = DINER_INK;
    const CHR_DK = '#63676a';
    const top = y + h - 1 - SURFACE_RISE;
    const D = top - (y + 1);
    shadow2(x + 2, y + h - 1, w - 4);
    ctx.globalAlpha = 0.22; px(x + w, y + 4, 2, D + 5, '#000'); ctx.globalAlpha = 1;
    for (const lx of [x + 3, x + w - 6]) {                                  // THE NEAR PAIR of legs
      px(lx, top + 5, 3, 5, INK);
      px(lx, top + 5, 1, 5, WD_LIT); px(lx + 1, top + 5, 2, 5, WD_DK);
      keyEdge(lx, top + 5, 1, 4, 0.22);
      px(lx - 1, y + h - 2, 5, 2, INK); px(lx, y + h - 2, 3, 1, CHR_DK);    // the metal foot
      ctx.globalAlpha = 0.32; px(lx - 2, y + h - 1, 7, 1, '#000'); ctx.globalAlpha = 1;
    }
    px(x + 6, top + 6, w - 12, 1, shade(WD, -0.40));                      // the end stretcher
    chamf(x - 1, top - D - 1, w + 2, D + 6, INK, 3);
    chamf(x, top - D, w, D + 4, shade(WD, -0.30), 3);
    chamf(x + 1, top - D + 1, w - 2, D, WD, 2);
    const boards = [5, 4, 5, 4, 5];                                         // unequal boards, down the length
    let bx = x + 1;
    for (let b = 0; b < boards.length && bx < x + w - 1; b++) {
      const bw = Math.min(boards[b], x + w - 1 - bx);
      px(bx, top - D + 1, bw, D, shade(WD, b % 2 ? 0.07 : -0.05));
      px(bx, top - D + 1, 1, D, shade(WD, b % 2 ? 0.18 : 0.10));          // each board's lit west lip
      for (let g = 0; g < 4; g++) {                                         // ring grain, sparse
        const gy = top - D + 3 + ((b * 5 + g * 7) % (D - 4));
        px(bx + (bw > 4 ? 1 : 0), gy, 1, 3, shade(WD, b % 2 ? -0.10 : -0.16));
      }
      bx += bw;
      if (bx < x + w - 1) px(bx - 1, top - D + 1, 1, D, shade(WD, -0.34));   // the seam
    }
    px(x + 2, top - D + 1, w - 4, 1, shade(WD_LIT, -0.10));               // far end, quiet
    px(x + 1, top - D + 2, 1, D - 2, WD_LIT);                               // THE WEST RAIL
    keyEdge(x + 1, top - D + 2, 1, Math.min(10, D - 2), 0.26);
    px(x + w - 2, top - D + 2, 1, D - 2, WD_DK);
    rimEdge(x + w - 2, top - D + 4, 1, D - 5, 0.20);
    px(x + 2, top - 1, w - 4, 1, shade(WD, -0.14));
    /* THE PLANT, dead centre of the turned top too */
    const cx0 = x + Math.round(w / 2) - 2, py0 = top - Math.round(D / 2) - 2;
    ctx.globalAlpha = 0.26; px(cx0 + 1, py0 + 8, 4, 1, '#000'); px(cx0 + 5, py0 + 4, 1, 4, '#000'); ctx.globalAlpha = 1;
    for (const l of [[cx0, py0 + 1, 2, 2], [cx0 + 3, py0, 2, 3], [cx0 + 1, py0 - 1, 2, 3], [cx0 + 4, py0 + 2, 1, 2]])
      px(l[0], l[1], l[2], l[3], '#2f7a24');
    px(cx0 + 1, py0 - 1, 1, 2, '#49a336'); px(cx0 + 3, py0, 1, 2, '#49a336');
    px(cx0 + 2, py0 + 2, 1, 2, '#1c4d17');
    px(cx0, py0 + 4, 5, 4, INK);
    px(cx0 + 1, py0 + 4, 3, 3, '#a8552f'); px(cx0 + 1, py0 + 4, 3, 1, '#c96f42');
    keyEdge(cx0 + 1, py0 + 4, 2, 1, 0.24);
    px(cx0 + 3, py0 + 5, 1, 2, '#6d3419');
    // the near edge — the slab's own timber, matching the shipped south view
    px(x + 1, top, w - 2, 1, shade(WD, 0.04)); keyEdge(x + 2, top, 8, 1, 0.22);
    px(x + 1, top + 1, w - 2, 2, WD_DK);
    px(x + 2, top + 3, w - 4, 1, shade(WD_DK, -0.40));
    px(x, top - 2, 1, 6, WD_DK); px(x + w - 1, top - 2, 1, 6, WD_DK);
  };

  /* ---- THE DINER CHAIR, on three authored facings. A seat that only exists facing the camera is
     useless around a table — half the chairs at a six-top face AWAY from you. West comes free by
     mirroring east. Rows are held in lockstep with F.chair (crown y-4, pad y+3..y+7, floor y+11) so
     a diner chair and an office chair standing side by side are the same height.
     ⛔ ITS SILHOUETTE IS THE GAP, not the padding: chrome legs splayed under a floating red pad,
        with real deck visible between the back and the seat. Filled in solid it is a postbox. */
  F.dinerchair = (x, y, w, h, f) => {
    /* ⛔ A BACK THAT DOES NOT TOUCH ITS SEAT IS TWO OBJECTS. The first pass left one row of deck
       between the pad and the backrest and the chair read as a red brick floating over a red brick.
       The back's foot now lands ON the seat's top row and two chrome side posts carry the eye down
       between them — a gap in a 12px chair is not "a chair's gap", it is a break in the object.
       ⛔ THE SEAT IS THE LIGHT PLANE. It faces the ceiling strip; the backrest faces the camera and
       must sit a stop or two darker, or the two masses read as one flat red card.
       The silhouette steps: narrow chrome crown -> wide padded back -> WIDER seat -> splayed legs. */
    const RED = '#a8382b', RED_LIT = '#c4513f', RED_HI = '#dd7460', RED_DK = '#5e1f18';
    const CHR = '#b6c0c5', CHR_HI = '#e8eef1', CHR_DK = '#5d666c', INK = '#20262a';
    shadow2(x + 2, y + 11, 8);
    // FOUR SPLAYED LEGS — the near pair steps 1px outward at the floor, so the base widens
    for (const lx of [x + 4, x + 7]) px(lx, y + 8, 1, 3, CHR_DK);            // rear pair, in shade
    px(x + 3, y + 10, 6, 1, CHR_DK);                                         // the rail tying them
    for (const s2 of [[x + 2, x + 1], [x + 9, x + 10]]) {                    // near pair: top x, foot x
      px(s2[0], y + 8, 2, 2, INK); px(s2[1], y + 10, 2, 2, INK);
      px(s2[0], y + 8, 1, 2, CHR); px(s2[1], y + 10, 1, 2, CHR);
    }
    keyEdge(x + 1, y + 10, 1, 2, 0.26); keyEdge(x + 2, y + 8, 1, 2, 0.26);
    // THE BACKREST — narrower than the seat, its foot ON the seat, chrome crown across the top
    px(x + 3, y - 4, 6, 1, INK);
    px(x + 4, y - 4, 4, 1, CHR_HI); keyEdge(x + 4, y - 4, 2, 1, 0.30);       // the chrome crown rail
    px(x + 2, y - 3, 8, 6, INK);
    px(x + 3, y - 3, 6, 5, RED);
    px(x + 3, y - 3, 6, 1, RED_LIT); px(x + 3, y - 3, 3, 1, RED_HI);
    px(x + 3, y - 2, 1, 4, RED_LIT); px(x + 8, y - 2, 1, 4, RED_DK);
    rimEdge(x + 8, y - 2, 1, 4, 0.20);
    px(x + 4, y - 1, 4, 1, shade(RED, -0.18));                             // the pad's tuck seam
    px(x + 3, y + 2, 6, 1, RED_DK);
    px(x + 2, y - 2, 1, 5, CHR_DK); px(x + 9, y - 2, 1, 5, CHR_DK);          // THE SIDE POSTS, back to seat
    px(x + 2, y - 2, 1, 2, CHR);
    // THE SEAT — the light plane, drawn last so it reads in front of the back's foot
    rr(x + 1, y + 3, 10, 5, INK);
    px(x + 2, y + 4, 8, 1, RED_HI); keyEdge(x + 2, y + 4, 4, 1, 0.26);
    px(x + 2, y + 5, 8, 1, RED_LIT);
    px(x + 2, y + 6, 8, 1, RED);
    px(x + 2, y + 4, 1, 3, RED_HI); px(x + 9, y + 4, 1, 3, RED_DK);
    rimEdge(x + 9, y + 4, 1, 3, 0.20);
    px(x + 3, y + 6, 1, 1, RED_DK); px(x + 8, y + 6, 1, 1, RED_DK);          // vinyl buttons
    px(x + 2, y + 7, 8, 1, CHR); px(x + 2, y + 7, 3, 1, CHR_HI);             // the chrome lip
  };

  F['dinerchair:e'] = (x, y, w, h, f) => {
    /* TURNED RIGHT. With no armrests to spend the profile on, the read is BACK -> SEAT -> LEGS as
       three marks of different weight: a thin raked slab at the tail whose foot lands on the seat,
       the seat's light plane running east off it, and daylight under both. Rows stay in lockstep
       with F.chair so a diner chair and an office chair are the same height side by side. */
    const RED = '#a8382b', RED_LIT = '#c4513f', RED_HI = '#dd7460', RED_DK = '#5e1f18';
    const CHR = '#b6c0c5', CHR_HI = '#e8eef1', CHR_DK = '#5d666c', INK = '#20262a';
    shadow2(x + 2, y + 11, 8);
    for (const lx of [x + 4, x + 7]) px(lx, y + 8, 1, 3, CHR_DK);            // far pair
    px(x + 3, y + 10, 7, 1, CHR_DK);
    for (const s2 of [[x + 2, x + 1], [x + 9, x + 10]]) {                    // near pair, splayed fore and aft
      px(s2[0], y + 8, 2, 2, INK); px(s2[1], y + 10, 2, 2, INK);
      px(s2[0], y + 8, 1, 2, CHR); px(s2[1], y + 10, 1, 2, CHR);
    }
    keyEdge(x + 1, y + 10, 1, 2, 0.26); keyEdge(x + 2, y + 8, 1, 2, 0.26);
    // THE BACK, edge-on: one raked slab, crown to seat, no gap at its foot
    px(x + 2, y - 4, 3, 1, INK); px(x + 3, y - 4, 2, 1, CHR_HI);
    px(x + 1, y - 3, 5, 6, INK);
    px(x + 2, y - 3, 3, 5, RED);
    px(x + 2, y - 3, 3, 1, RED_LIT); px(x + 2, y - 3, 1, 5, RED_LIT);
    px(x + 4, y - 2, 1, 4, RED_DK); rimEdge(x + 4, y - 2, 1, 4, 0.20);
    px(x + 2, y + 2, 3, 1, RED_DK);
    px(x + 1, y - 2, 1, 5, CHR_DK);                                          // the frame post down its back
    // THE SEAT — the light plane running east, its east end the chair's front
    rr(x + 2, y + 3, 9, 5, INK);
    px(x + 3, y + 4, 7, 1, RED_HI); keyEdge(x + 3, y + 4, 4, 1, 0.26);
    px(x + 3, y + 5, 7, 1, RED_LIT);
    px(x + 3, y + 6, 7, 1, RED);
    px(x + 3, y + 4, 1, 3, RED_HI); px(x + 9, y + 4, 1, 3, RED_DK);
    rimEdge(x + 9, y + 4, 1, 3, 0.20);
    px(x + 5, y + 6, 1, 1, RED_DK); px(x + 8, y + 6, 1, 1, RED_DK);
    px(x + 3, y + 7, 7, 1, CHR); px(x + 3, y + 7, 3, 1, CHR_HI);             // the chrome lip
  };

  F['dinerchair:n'] = (x, y, w, h, f) => {
    /* FROM BEHIND — the facing every chair pushed up to a table actually shows. The seat's light
       plane is gone (you are looking at its rear edge and underside), so the back's outer SHELL has
       to carry it: one crowned red panel, dimmer than the side you sit on, in the same chrome hoop. */
    const RED = '#a8382b', RED_LIT = '#c4513f', RED_DK = '#5e1f18';
    const CHR = '#b6c0c5', CHR_HI = '#e8eef1', CHR_DK = '#5d666c', INK = '#20262a';
    shadow2(x + 2, y + 11, 8);
    for (const lx of [x + 4, x + 7]) px(lx, y + 8, 1, 3, CHR_DK);
    px(x + 3, y + 10, 6, 1, CHR_DK);
    for (const s2 of [[x + 2, x + 1], [x + 9, x + 10]]) {
      px(s2[0], y + 8, 2, 2, INK); px(s2[1], y + 10, 2, 2, INK);
      px(s2[0], y + 8, 1, 2, CHR_DK); px(s2[1], y + 10, 1, 2, CHR_DK);
    }
    // the pad from behind: its rear edge and underside only
    rr(x + 1, y + 3, 10, 5, INK);
    px(x + 2, y + 4, 8, 2, shade(RED, -0.26));
    px(x + 2, y + 4, 8, 1, shade(RED_LIT, -0.32));
    px(x + 2, y + 6, 8, 1, RED_DK); px(x + 3, y + 7, 6, 1, CHR_DK);
    // THE SHELL — same outline as the front, one crowned surface, no buttons and no lip
    px(x + 3, y - 4, 6, 1, INK); px(x + 4, y - 4, 4, 1, CHR);
    keyEdge(x + 4, y - 4, 2, 1, 0.22);
    px(x + 2, y - 3, 8, 6, INK);
    px(x + 3, y - 3, 6, 5, shade(RED, -0.12));
    px(x + 3, y - 3, 6, 1, shade(RED_LIT, -0.20));
    px(x + 3, y - 2, 1, 4, shade(RED_LIT, -0.26)); px(x + 8, y - 2, 1, 4, RED_DK);
    rimEdge(x + 8, y - 2, 1, 4, 0.20);
    px(x + 5, y - 3, 2, 5, shade(RED, -0.02));                             // the shell's crowned spine
    px(x + 3, y + 2, 6, 1, RED_DK);
    px(x + 2, y - 2, 1, 5, CHR_DK); px(x + 9, y - 2, 1, 5, CHR_DK);          // the side posts
  };

  /* ============ TWO MORE SEATS (2026-08-17, Andrew: "make 2 more chairs with multiple angles") ============
     The catalog already had the OFFICE CHAIR (light silver, waisted mesh back, armrests, star base)
     and the DINER CHAIR (red vinyl, chrome, splayed legs). A third and fourth seat only earn their
     row if you can tell which is which at 12px ACROSS A ROOM, so these two are picked to be opposite
     in both silhouette and value structure:
       POD CHAIR   — ROUND. A deep moulded bucket on a swivel pedestal, opening toward whatever it
                     faces. Lounge furniture: soft, warm-cushioned, no hard edge on it anywhere.
     ⛔ TWO EARLIER ATTEMPTS AT A SECOND SEAT WERE CUT ON SIGHT — a hooped brass cafe chair (fragile
        at this size and furniture from the wrong planet) and a harnessed crash seat. This station's
        seating is MOULDED: a rigid shell with something soft set into it. When one design in a pair
        lands and the others do not, the survivor is the brief. */



  F.podchair = (x, y, w, h, f) => {
    /* THE POD CHAIR — one moulded shell on a swivel pedestal. It is the catalog's only seat with no
       legs and no gaps, which is exactly why it belongs: at a glance it is a MASS where every other
       chair is a frame.
       ⛔ A SHELL IS ONLY A SHELL IF YOU SEE INSIDE IT. Drawn as a filled dome it is a helmet on a
          stick. The opening — a lighter lining inset from the outer edge, with a cushion sitting in
          the bottom of it — is the entire read, and it is what changes when the prop turns. */
    const SH = '#39424a', SH_LIT = '#6c7883', SH_DK = '#222930', INK = '#151a1f';
    const IN = '#66727c', IN_DK = '#414b54';
    /* RED, not the amber it shipped with (Andrew, 2026-08-17). This is the catalog's established
       red — the diner chair's vinyl — so the two read as one accent family rather than two
       one-off hues, and it is authored past the chroma skip (s .59) so the dial hands it
       through untouched instead of grading it. */
    const CU = '#a8382b', CU_LIT = '#c4513f', CU_DK = '#5e1f18';
    shadow2(x + 2, y + 11, 8);
    px(x + 4, y + 8, 4, 3, INK);                                           // the pedestal
    px(x + 5, y + 8, 1, 3, SH_LIT); px(x + 6, y + 8, 1, 3, SH_DK);
    keyEdge(x + 5, y + 8, 1, 2, 0.22);
    px(x + 2, y + 10, 8, 2, INK);                                          // its disc foot
    px(x + 3, y + 10, 6, 1, SH); px(x + 3, y + 10, 3, 1, SH_LIT);
    px(x + 3, y + 11, 6, 1, SH_DK);
    // THE SHELL — one silhouette, painted whole before anything goes inside it
    px(x + 3, y - 5, 6, 1, INK); px(x + 2, y - 4, 8, 1, INK);
    px(x + 1, y - 3, 10, 10, INK); px(x + 2, y + 7, 8, 1, INK);
    px(x + 3, y - 4, 5, 1, SH_LIT); keyEdge(x + 3, y - 4, 3, 1, 0.30);     // its crown takes the strip
    px(x + 2, y - 3, 8, 2, SH);
    px(x + 2, y - 3, 1, 9, SH_LIT); px(x + 9, y - 3, 1, 9, SH_DK);         // west wall lit, east in shade
    rimEdge(x + 9, y - 2, 1, 8, 0.22);
    px(x + 2, y + 5, 8, 2, SH); px(x + 3, y + 6, 6, 1, SH_DK);             // the shell's lower belly
    // THE OPENING — the lining, inset, so the mass reads as hollow
    px(x + 3, y - 2, 6, 5, IN_DK);
    px(x + 3, y - 2, 6, 1, IN); px(x + 4, y - 2, 4, 1, shade(IN, 0.10));
    px(x + 3, y - 1, 1, 4, IN); px(x + 8, y - 1, 1, 4, shade(IN_DK, -0.18));
    // THE CUSHION in the bottom of it — the prop's one saturated thing
    px(x + 3, y + 2, 6, 3, CU);
    px(x + 3, y + 2, 6, 1, CU_LIT); px(x + 4, y + 2, 3, 1, shade(CU_LIT, 0.10));
    keyEdge(x + 4, y + 2, 3, 1, 0.24);
    px(x + 3, y + 3, 1, 2, CU_LIT); px(x + 8, y + 3, 1, 2, CU_DK);
    px(x + 5, y + 4, 2, 1, CU_DK);                                         // its tuck seam
  };

  F['podchair:e'] = (x, y, w, h, f) => {
    // TURNED RIGHT — and this is the facing that proves the prop: the opening swings east, so the
    // shell becomes a C. Its back is a thick mass at the tail, its crown curls forward over the
    // cushion, and the lining is only visible on the inside of that curve.
    const SH = '#39424a', SH_LIT = '#6c7883', SH_DK = '#222930', INK = '#151a1f';
    const IN = '#66727c', IN_DK = '#414b54';
    /* RED, not the amber it shipped with (Andrew, 2026-08-17). This is the catalog's established
       red — the diner chair's vinyl — so the two read as one accent family rather than two
       one-off hues, and it is authored past the chroma skip (s .59) so the dial hands it
       through untouched instead of grading it. */
    const CU = '#a8382b', CU_LIT = '#c4513f', CU_DK = '#5e1f18';
    shadow2(x + 2, y + 11, 8);
    px(x + 4, y + 8, 4, 3, INK);
    px(x + 5, y + 8, 1, 3, SH_LIT); px(x + 6, y + 8, 1, 3, SH_DK);
    keyEdge(x + 5, y + 8, 1, 2, 0.22);
    px(x + 2, y + 10, 8, 2, INK);
    px(x + 3, y + 10, 6, 1, SH); px(x + 3, y + 10, 3, 1, SH_LIT);
    px(x + 3, y + 11, 6, 1, SH_DK);
    /* THE C — outline first: a tall back at the west, a floor running east, and a crown that reaches
       back over the opening. The notch between crown and floor IS the chair. */
    px(x + 2, y - 5, 5, 1, INK);
    px(x + 1, y - 4, 7, 1, INK);
    px(x + 1, y - 3, 5, 10, INK);                                          // the back mass + its foot
    px(x + 6, y + 3, 6, 5, INK);                                           // the seat floor running east
    px(x + 2, y - 4, 4, 1, SH_LIT); keyEdge(x + 2, y - 4, 3, 1, 0.30);     // the crown
    px(x + 2, y - 3, 4, 2, SH);
    px(x + 2, y - 3, 1, 9, SH_LIT); keyEdge(x + 2, y - 3, 1, 6, 0.20);     // the back's lit west wall
    px(x + 5, y - 1, 1, 4, IN);                                            // the lining, inside the curve
    px(x + 3, y - 1, 2, 4, IN_DK);
    px(x + 2, y + 5, 9, 2, SH); px(x + 3, y + 6, 8, 1, SH_DK);             // the shell's belly, east
    px(x + 10, y + 4, 1, 3, SH_DK); rimEdge(x + 10, y + 4, 1, 3, 0.22);
    // THE CUSHION, running east out of the shell's mouth
    px(x + 4, y + 3, 7, 3, CU);
    px(x + 4, y + 3, 7, 1, CU_LIT); px(x + 5, y + 3, 3, 1, shade(CU_LIT, 0.10));
    keyEdge(x + 5, y + 3, 3, 1, 0.24);
    px(x + 4, y + 4, 1, 2, CU_LIT); px(x + 10, y + 4, 1, 2, CU_DK);
    px(x + 7, y + 5, 2, 1, CU_DK);
  };

  F['podchair:n'] = (x, y, w, h, f) => {
    // FROM BEHIND — the one seat in the catalog whose back view is genuinely dramatic: the opening
    // is gone entirely and what is left is a bare moulded dome, seamed down the spine. No lining, no
    // cushion, nothing warm. That total absence is what makes it read as turned away.
    const SH = '#39424a', SH_LIT = '#6c7883', SH_DK = '#222930', INK = '#151a1f';
    shadow2(x + 2, y + 11, 8);
    px(x + 4, y + 8, 4, 3, INK);
    px(x + 5, y + 8, 1, 3, SH_DK); px(x + 6, y + 8, 1, 3, SH_DK);
    px(x + 2, y + 10, 8, 2, INK);
    px(x + 3, y + 10, 6, 1, SH_DK); px(x + 3, y + 10, 3, 1, SH);
    px(x + 3, y + 11, 6, 1, shade(SH_DK, -0.30));
    px(x + 3, y - 5, 6, 1, INK); px(x + 2, y - 4, 8, 1, INK);
    px(x + 1, y - 3, 10, 10, INK); px(x + 2, y + 7, 8, 1, INK);
    px(x + 3, y - 4, 5, 1, SH); keyEdge(x + 3, y - 4, 3, 1, 0.22);
    px(x + 2, y - 3, 8, 9, SH_DK);                                         // the dome, unbroken
    px(x + 3, y - 3, 6, 8, shade(SH, -0.10));
    px(x + 5, y - 3, 2, 9, SH);                                            // its crowned spine
    px(x + 2, y - 3, 1, 9, shade(SH_LIT, -0.24)); px(x + 9, y - 3, 1, 9, shade(SH_DK, -0.18));
    rimEdge(x + 9, y - 2, 1, 8, 0.22);
    px(x + 2, y + 5, 8, 2, SH_DK); px(x + 3, y + 6, 6, 1, shade(SH_DK, -0.24));
    px(x + 4, y + 7, 4, 1, shade(SH_DK, -0.34));                         // where it meets the pedestal
  };

  /* ---- THE BOOTH (2026-08-17) — the one seat type the catalog had no version of at all. Every
     other place to sit is either ONE body (stool, chair, diner chair, pod, crash seat, recliner) or
     the five-tile COUCH that faces a TV. Nothing seats two at a TABLE, which is exactly what the
     new diner table and the long table are for: two booths facing each other across a 3x2 top is a
     diner, and a booth down one side of the refectory table is a mess hall.
     ⛔ A BOOTH IS A WALL WITH A SHELF, NOT A BIG CHAIR. Its back is one tall unbroken plane — that
        is what a booth IS — so the read cannot come from silhouette breaks the way a chair's does.
        It comes from the BANDS: a chrome cap rail, a tufted field with countable buttons, a lit seat
        plane, and a dark toe kick with real deck under it. Take away the toe kick and it is a crate.
     ⛔ It shares the diner chair's red on purpose. Placed together they have to read as ONE set. */
  F.booth = (x, y, w, h, f) => {
    const RED = '#a8382b', RED_LIT = '#c4513f', RED_HI = '#dd7460', RED_DK = '#5e1f18';
    const CHR = '#b6c0c5', CHR_HI = '#e8eef1', CHR_DK = '#5d666c', INK = '#20262a';
    shadow2(x + 1, y + h - 1, w - 2);
    /* THE BACK — one tall plane, capped in chrome. Drawn first and whole; the seat overlaps it. */
    px(x + 1, y - 7, w - 2, 10, INK);
    px(x + 2, y - 6, w - 4, 1, CHR_HI); keyEdge(x + 2, y - 6, 8, 1, 0.30);   // the cap rail
    px(x + 2, y - 5, w - 4, 1, CHR_DK);
    px(x + 2, y - 4, w - 4, 6, shade(RED, -0.10));
    px(x + 2, y - 4, w - 4, 1, RED); px(x + 3, y - 4, 5, 1, RED_LIT);
    px(x + 2, y - 3, 1, 5, RED_LIT); px(x + w - 3, y - 3, 1, 5, RED_DK);
    rimEdge(x + w - 3, y - 3, 1, 5, 0.20);
    for (let bx = x + 5; bx < x + w - 4; bx += 6) {                           // TUFTING — countable buttons
      px(bx, y - 2, 1, 1, RED_DK); px(bx, y - 1, 1, 1, shade(RED_LIT, -0.10));
      px(bx - 1, y - 3, 1, 1, shade(RED, 0.10)); px(bx + 1, y - 3, 1, 1, shade(RED, 0.10));
      px(bx, y + 1, 1, 2, shade(RED, -0.14));                              // the pleat under each
    }
    px(x + 2, y + 2, w - 4, 1, RED_DK);                                      // where the back meets the seat
    /* THE SEAT — the light plane, proud of the back at both ends so the bench reads as upholstered
       rather than as a panel with a ledge. */
    px(x, y + 3, w, 6, INK);
    px(x + 1, y + 4, w - 2, 2, RED_HI); keyEdge(x + 1, y + 4, 9, 1, 0.30);
    px(x + 1, y + 6, w - 2, 1, RED_LIT);
    px(x + 1, y + 7, w - 2, 1, RED);
    px(x + 1, y + 4, 1, 3, RED_HI); px(x + w - 2, y + 4, 1, 3, RED_DK);
    rimEdge(x + w - 2, y + 4, 1, 3, 0.20);
    for (let bx = x + 5; bx < x + w - 4; bx += 6) px(bx, y + 5, 1, 1, RED_DK);
    px(x + 1, y + 8, w - 2, 1, CHR); px(x + 1, y + 8, 4, 1, CHR_HI);         // the chrome trim strip
    /* THE TOE KICK — recessed, with deck under it. This is the whole difference from a crate. */
    px(x + 2, y + 9, w - 4, 2, INK);
    px(x + 3, y + 9, w - 6, 1, shade(CHR_DK, -0.20));
    px(x + 3, y + 10, w - 6, 1, shade(INK, 0.10));
    ctx.globalAlpha = 0.34; px(x + 2, y + h - 1, w - 4, 1, '#000'); ctx.globalAlpha = 1;
  };

  F['booth:e'] = (x, y, w, h, f) => {
    /* 1x2 TURNED — the bench runs away from you with its back down the WEST side. This is how a booth
       is actually placed, two of them flanking a table.
       ⛔ FROM ABOVE, THE BACK IS A CROWN — NOT A WALL. The first pass drew it as a 4px red panel
          beside the seat and the prop read as TWO PLANKS STANDING UP, because both masses were the
          same red at the same value. A west-facing surface is edge-on from this camera: what you
          actually see of the back is its TOP, a lit band running the length, with one shaded row
          where it rolls over. The seat beside it is the HORIZONTAL plane and must sit lighter. That
          value split — lit crown, dark roll, light seat — is the entire read. (Same law the turned
          COUCH earned.) */
    const RED = '#a8382b', RED_LIT = '#c4513f', RED_HI = '#dd7460', RED_DK = '#5e1f18';
    const CHR = '#b6c0c5', CHR_HI = '#e8eef1', CHR_DK = '#5d666c', INK = '#20262a';
    const NE = y + h - 5;                                                    // where the near end starts
    shadow2(x + 1, y + h - 1, w - 2);
    ctx.globalAlpha = 0.22; px(x + w, y + 2, 2, h - 5, '#000'); ctx.globalAlpha = 1;
    px(x, y - 5, w, h + 1, INK);                                             // ONE silhouette, then fills
    /* THE BACK, seen as its crown: NARROW — three px, against the seat's seven. Two red bands of
       equal width at equal value is what made the first two passes read as a pair of planks; the
       back has to be the minor mass and the seat the major one, with the shadow the back throws
       across the cushion separating them. */
    px(x + 1, y - 4, 1, h - 1, RED_HI); keyEdge(x + 1, y - 4, 1, 9, 0.26);   // its lit west lip
    px(x + 2, y - 4, 1, h - 1, CHR_DK);                                      // THE CHROME CAP, end-on —
    px(x + 2, y - 4, 1, 6, CHR);                                             // lit only where the strip
    px(x + 2, y + h - 9, 1, 4, CHR);                                         // actually reaches it. A full
    keyEdge(x + 2, y - 4, 1, 5, 0.20);                                       // bright rail is a strip light.
    px(x + 3, y - 3, 1, h - 2, RED);                                         // the crown rolling over
    px(x + 4, y - 3, 1, h - 2, RED_DK);                                      // and falling into shade
    px(x + 5, y - 2, 1, h - 3, shade(RED_DK, -0.30));                      // its shadow ON the seat
    for (let by = y + 1; by < NE - 2; by += 6) px(x + 3, by, 1, 1, RED_DK);  // tufting, down the length
    /* THE SEAT — the major mass and the light plane, running the same length */
    px(x + 6, y - 2, w - 7, h - 2, RED_LIT);
    px(x + 6, y - 2, w - 7, 1, RED_HI); keyEdge(x + 6, y - 2, 4, 1, 0.26);   // its far end takes the strip
    px(x + 6, y - 1, 1, h - 3, RED_HI);                                      // THE WEST RAIL, lit end to end
    px(x + w - 3, y - 1, 1, h - 3, RED); px(x + w - 2, y - 1, 1, h - 3, RED_DK);
    rimEdge(x + w - 2, y + 1, 1, h - 6, 0.20);
    for (let by = y + 2; by < NE - 2; by += 6) {                             // seat buttons, down the length
      px(x + 9, by, 1, 1, RED_DK); px(x + 9, by + 1, 1, 1, shade(RED_HI, -0.06));
    }
    /* THE NEAR END — the seat's front edge, its chrome trim, and the toe kick under everything */
    px(x + 1, NE, w - 2, 1, RED);
    px(x + 1, NE + 1, w - 2, 1, CHR); px(x + 1, NE + 1, 4, 1, CHR_HI);
    px(x + 2, NE + 2, w - 4, 3, INK);
    px(x + 3, NE + 2, w - 6, 1, shade(CHR_DK, -0.20));
    px(x + 3, NE + 3, w - 6, 1, shade(INK, 0.10));
    ctx.globalAlpha = 0.34; px(x + 1, y + h - 1, w - 2, 1, '#000'); ctx.globalAlpha = 1;
  };

  /* ⛔ THE BOOTH HAS NO NORTH VIEW, AND THAT IS THE HONEST ANSWER (Andrew: "just remove booth N
     entirely"). A back view was authored, corrected once for drawing cushions through a solid
     backboard, and then cut: what it left was a featureless red board — a picture nobody would ever
     deliberately place. `facings()` reads the F table directly, so deleting the function IS the
     removal; R now cycles S -> W -> E and never stops on a wall. A facing that draws nothing worth
     placing is the same lie as a facing that draws nothing at all. */

  /* ---- THE GUITAR (2026-08-17) — the last casual prop, and ELECTRIC on Andrew's call. Everything
     else built today is FURNITURE: things a room is arranged around. This is the opposite kind of
     object and that is its whole job — one crew member's belonging left standing where they put it
     down, which is what makes a lounge read as lived in rather than furnished. The station already
     had a speaker, a jukebox and a DJ booth; nobody owned an instrument.
     ⛔ AN ELECTRIC IS ITS HORNS, AN ACOUSTIC IS ITS WAIST. The acoustic draft here read as a PADLOCK
        ON A STICK until the body was painted row by row for the pinch; the electric abandons that
        shape entirely for a SOLID body with two cutaway horns reaching up either side of the neck.
        Those two notches are the silhouette, and they are also what tells the two apart at a glance,
        so the hardware inside (pickguard, pickups, bridge, knobs) is detail ON the shape, never a
        break in it.
     ⛔ AND IT IS PLUGGED IN. A jack lead sagging from the body to the deck is one curve of 1px, and
        it does more to say ELECTRIC than any amount of chrome — a limp line is the one thing a
        pixel-art prop can own that a rigid silhouette cannot. */
  F.guitar = (x, y, w, h, f) => {
    /* ⛔ A STAR BODY IS THE BEST GUITAR SILHOUETTE THIS SCALE CAN HAVE (Andrew's reference, 2026-08-17:
       a scarlet five-point star guitar). The Strat draft before it spent its whole outline on subtle
       curves that die at 12px — horns a px long, a waist a px deep — and read as a blue block. POINTS
       SURVIVE PIXELS: two side spikes, a notch cut up the middle of the lower half, and a sharp
       headstock give the eye four unmistakable angles at any size, and no shading is doing the work.
       ⛔ THE NOTCH IS INK, NOT DECK. At two px wide the gap between the lower points closes as soon
          as both sides ink themselves — which is fine and is the point: ink is this object's edge, so
          a dark wedge driven up into the body reads as the cut. Fighting for real daylight there
          would cost the points their width, and the points are the prop. */
    const BD = '#c8302a', BD_LIT = '#e8584a', BD_DK = '#6d1410', INK = '#1c0806';   // scarlet, past the skip
    const NECK = '#2a1c10', NECK_LIT = '#4a3520';
    const r = MAT.steel;
    shadow2(x + 3, y + 11, 6);
    cable(x + 8, y + 4, x + 11, y + 11, 2.2, '#0d1116');                    // THE LEAD, sagging to the deck
    // THE STAND — a thin A-frame behind the instrument
    px(x + 3, y + 6, 1, 5, r.dk); px(x + 8, y + 6, 1, 5, r.dk);
    px(x + 2, y + 10, 3, 1, r.face); px(x + 7, y + 10, 3, 1, r.face);
    px(x + 4, y + 8, 4, 1, r.dk);
    keyEdge(x + 3, y + 6, 1, 3, 0.18);
    /* THE STAR — each row inks ITSELF a px proud (a boxed outline has nothing for a point to cut
       into), then fills. Row order is top spike, side spikes, the bar, then the split lower points. */
    const body = [
      [-2, [[5, 2]]],
      [-1, [[4, 4]]],
      [0, [[0, 2], [4, 4], [10, 2]]],
      [1, [[1, 10]]],
      [2, [[2, 8]]],
      [3, [[2, 8]]],
      [4, [[2, 3], [7, 3]]],
      [5, [[1, 3], [8, 3]]],
      [6, [[1, 2], [9, 2]]],
    ];
    for (const [dy, segs] of body) for (const [sx, sw] of segs) px(x + sx - 1, y + dy, sw + 2, 1, INK);
    px(x + 4, y - 3, 4, 1, INK); px(x + 1, y + 7, 2, 1, INK); px(x + 9, y + 7, 2, 1, INK);
    for (const [dy, segs] of body) for (const [sx, sw] of segs) {
      const bx = x + sx, ry = y + dy;
      px(bx, ry, sw, 1, BD);
      px(bx, ry, 1, 1, BD_LIT); px(bx + sw - 1, ry, 1, 1, BD_DK);
      if (dy <= 1) px(bx + 1, ry, Math.max(0, sw - 2), 1, shade(BD, 0.10));   // the upper half takes the key
      if (dy >= 4) px(bx + 1, ry, Math.max(0, sw - 2), 1, shade(BD, -0.16));
    }
    keyEdge(x + 1, y + 1, 3, 1, 0.28); rimEdge(x + 10, y + 1, 1, 3, 0.20);
    /* THE HARDWARE — two black pickups, a chrome bridge, and the white STAR decals off the reference.
       Three marks and a spark; anything more at this size is litter. */
    px(x + 4, y + 1, 4, 1, '#141a22');                                      // two humbuckers, with a
    px(x + 4, y + 2, 4, 1, shade(BD, -0.20));                             // strip of body between them
    px(x + 4, y + 3, 4, 1, '#141a22');
    px(x + 4, y + 4, 3, 1, r.hi); px(x + 5, y + 4, 1, 1, r.sheen);          // the bridge, catching the strip
    px(x + 2, y + 2, 1, 1, '#f2f4f5'); px(x + 9, y + 4, 1, 1, '#f2f4f5');   // two star decals
    px(x + 8, y + 4, 1, 1, shade(BD_LIT, 0.14));                          // a knob
    /* THE NECK — dark board, sparse inlays, ending AT the joint (run to the bridge it splits the
       body in half). Props may overhang upward and that height is what carries across a room. */
    px(x + 4, y - 12, 4, 11, INK);
    px(x + 5, y - 11, 2, 10, NECK);
    px(x + 5, y - 11, 1, 10, NECK_LIT); keyEdge(x + 5, y - 11, 1, 7, 0.22);
    px(x + 6, y - 11, 1, 10, shade(NECK, -0.24)); rimEdge(x + 6, y - 9, 1, 8, 0.18);
    for (let fy = y - 9; fy < y - 2; fy += 3) px(x + 5, fy, 1, 1, '#8e959a');   // dot inlays — ONE px each:
    // two px of white every third row is a LADDER, not a fretboard.
    px(x + 5, y - 2, 2, 1, r.mid);                                          // the neck plate at the joint
    // THE HEADSTOCK — a hard point, angled, tuners down one edge. Same language as the body.
    px(x + 3, y - 15, 6, 4, INK);
    px(x + 5, y - 15, 2, 1, BD); px(x + 4, y - 14, 4, 2, BD_DK);
    px(x + 4, y - 14, 1, 2, BD);
    for (let t = 0; t < 3; t++) px(x + 8, y - 14 + t, 1, 1, t === 1 ? r.hi : r.lit);
  };

  /* ============ DETAIL-PASS PROPS (auto-generated) ============ */
  F.bridge_tacscreen = (x, y, w, h, f) => {   // v4 TAC SCREEN (2x1) — the bridge's HOODED wireframe monitor
    // The three bridge props share the room's red and must still be told apart in silhouette alone:
    //   tacscreen  = a wide board with a jutting GLARE HOOD, lit by thin VECTOR LINES (no filled panel)
    //   pylon      = a tall narrow column lit by ONE vertical slot
    //   orderqueue = a low cabinet with NO screen at all, lit by cards floating in the air above it
    // So this one leans all the way into "vector radar": the emissive area is line art on near-black glass,
    // the hood casts a hard shadow band over the top of that glass, and the red bleeds out under the hood
    // onto the bezel. f.work brightens the trace and speeds the readout crawl.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const RED = '#ff4a3d', HOT = '#ff9d8e';
    shadow2(x + 2, y + h - 1, w - 4);
    // rolling posts with splayed feet + a tie-collar so the board never floats off them
    for (const pxx of [x + 4, x + w - 6]) {
      px(pxx - 1, y + 5, 4, h - 6, LINE);
      px(pxx, y + 6, 1, h - 8, r.lit); px(pxx + 1, y + 6, 1, h - 8, r.dk);
      rimEdge(pxx + 2, y + 6, 1, h - 8, 0.18);
      chamf(pxx - 4, y + h - 4, 10, 3, LINE, 1);
      px(pxx - 3, y + h - 3, 8, 1, r.face); px(pxx - 3, y + h - 3, 8, 1, r.lit);
      px(pxx - 3, y + h - 2, 8, 1, r.ao);
      px(pxx - 2, y + h - 1, 2, 1, '#1a1e22'); px(pxx + 2, y + h - 1, 2, 1, '#1a1e22');
      ctx.globalAlpha = 0.30; px(pxx - 4, y + h, 10, 1, '#000'); ctx.globalAlpha = 1;
      px(pxx, y + 4, 2, 2, shade(r.top, 0.16));
    }
    // chamfered carcass
    chamf(x - 1, y - 6, w + 2, 14, LINE, 2);
    chamf(x, y - 5, w, 12, r.face, 2);
    px(x + 2, y - 5, w - 4, 1, r.top);
    px(x, y - 3, 1, 8, r.lit); px(x + w - 1, y - 3, 1, 8, r.dk); rimEdge(x + w - 1, y - 3, 1, 8, 0.22);
    px(x + 2, y + 6, w - 4, 1, r.ao);
    // GLARE HOOD jutting south over the glass — this prop's silhouette tell, and a hard shadow on the screen
    chamf(x - 2, y - 9, w + 4, 4, LINE, 2);
    chamf(x - 1, y - 8, w + 2, 3, r.top, 2);
    px(x + 1, y - 8, w - 2, 1, r.sheen); keyEdge(x + 1, y - 8, 7, 1, 0.30);
    px(x + 1, y - 6, w - 2, 1, shade(r.top, -0.34));              // hood's underside lip
    for (const cx4 of [x + 1, x + w - 3]) { px(cx4, y - 6, 2, 3, shade(r.face, -0.20)); px(cx4, y - 6, 1, 3, r.dk); } // hood cheeks
    // recessed glass well, hood shadow raked across its top two rows
    const sx = x + 3, sy = y - 4, sw = w - 6, sh2 = 9;
    inset(sx - 1, sy - 1, sw + 2, sh2 + 2, '#080a0c');
    px(sx, sy, sw, sh2, on ? '#100809' : '#0c0708');                // idle glass keeps a red bias, not a black hole
    ctx.globalAlpha = 0.55; px(sx, sy, sw, 2, '#000'); ctx.globalAlpha = 1;
    const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(now / 1000));  // wireframe pulse (kept)
    // STATION DECK-PLAN WIREFRAME (kept 1:1) — hull, left deck, spine, cross corridor
    ctx.save();
    ctx.globalAlpha = (on ? 0.85 : 0.45) * pulse;
    ctx.strokeStyle = RED; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(sx + 1.5, sy + 1.5, sw - 4, sh2 - 5);
    ctx.rect(sx + 3.5, sy + 3.5, Math.max(2, (sw - 8) / 2 - 1), Math.max(2, sh2 - 9));
    ctx.moveTo(sx + sw / 2, sy + 2); ctx.lineTo(sx + sw / 2, sy + sh2 - 4);
    ctx.moveTo(sx + 2, sy + sh2 / 2); ctx.lineTo(sx + sw - 3, sy + sh2 / 2);
    ctx.stroke();
    ctx.restore();
    // vertex ticks where the wireframe corners land — vector sets read as PLOTTED when the nodes show
    for (const [vx, vy] of [[sx + 1, sy + 1], [sx + sw - 3, sy + 1], [sx + 1, sy + sh2 - 4], [sx + sw - 3, sy + sh2 - 4]])
      px(vx, vy, 1, 1, blink(900, vx + ph) ? HOT : shade(RED, -0.35));
    // three scrolling tactical readout bars (kept), now with falloff instead of flat glow
    for (let r2 = 0; r2 < 3; r2++) {
      const by = sy + sh2 - 4 + r2;
      if (by > sy + sh2 - 2) break;
      const scroll = Math.floor(now / ((on ? 60 : 90) + r2 * 40)) % sw;
      const bw = 2 + (U.hash('tac' + r2) % 4);
      const bx = sx + ((scroll + r2 * 5) % Math.max(1, sw - bw - 1));
      bloom(bx, by, bw, 1, RED, (on ? 0.55 : 0.30) * pulse);
    }
    const dotOn = blink(1400);                                      // slow status dot, lower-right (kept)
    px(sx + sw - 3, sy + sh2 - 3, 2, 2, dotOn ? RED : '#3a1714');
    if (dotOn) bloom(sx + sw - 3, sy + sh2 - 3, 2, 2, RED, on ? 0.42 : 0.26);
    scanl(sx, sy, sw, sh2, 0.20);
    bloom(sx, sy, sw, sh2, RED, (on ? 0.10 : 0.05) * pulse);
    spill(x + 2, y + 7, w - 4, RED, on ? 0.16 : 0.09, 4);           // screen light running down onto the posts
  };
  F.bridge_relaystack = (x, y, w, h, f) => {
    /* v44 RELAY STACK (1x2) — the third MEMORY silhouette. Core is a sealed glass column; this is the
       OPPOSITE: an OPEN patch frame of horizontal contact combs you can see straight through.
       ⛔ COUNTABLE TEETH ARE THE WHOLE IDEA. Five combs, each a dark slot with pins you could count,
          and real deck visible between the frame's uprights. Sealed = core, open = relay; that pair
          is what stops two 1x2 violet props reading as the same object.
       ⛔ ONE PATCH LEAD hanging off the frame does more than any amount of surface detail — it is the
          only thing on the prop that is not a straight line, and the eye goes to it. */
    const r = EQUIPMENT, br = MAT.brass, on = !!(f && f.work);
    const base = y + h, top = y - 8;
    const M = ACC.mem, D = ACC.data;

    shadow2(x + 1, base - 1, w - 2);
    deckPlate(x, base - 4, w, 4);
    deckSocket(x + w + 1, base - 3, on);

    /* ---- CAP ---- */
    px(x + 1, top, w - 2, 1, r.ink);
    px(x, top + 1, w, 4, r.ink);
    px(x + 1, top + 1, w - 2, 2, r.lit);
    px(x + 2, top + 1, 4, 1, r.hi);
    px(x + 1, top + 3, w - 2, 1, r.top);
    px(x + 1, top + 4, w - 2, 1, r.dk);
    px(x + 4, top + 3, 4, 1, on ? M : shade(M, -0.62));
    if (on) bloom(x + 4, top + 3, 4, 1, M, 0.20);

    /* ---- OPEN FRAME: two uprights, deck visible between the combs ---- */
    const fTop = top + 6, fBot = base - 9;
    for (const rx of [x + 1, x + w - 3]) {
      px(rx, fTop - 1, 2, fBot - fTop + 2, r.ink);
      px(rx, fTop, 1, fBot - fTop, rx === x + 1 ? r.lit : r.dk);
      px(rx + 1, fTop, 1, fBot - fTop, rx === x + 1 ? r.face : r.ao);
    }

    /* ---- FIVE CONTACT COMBS: dark slot, countable pins, one indicator each ---- */
    for (let k = 0; k < 5; k++) {
      const cy0 = fTop + 1 + k * 3;
      px(x + 3, cy0 - 1, w - 6, 1, r.mid);                        // lit sill above the slot
      px(x + 3, cy0, w - 6, 2, r.ao);                             // the slot itself
      for (let i = 0; i < 5; i++)                                 // the pins — countable
        px(x + 4 + i, cy0, 1, 1, i % 2 ? r.lit : r.face);
      px(x + w - 4, cy0, 1, 1, blink(380 + k * 140, k) ? D : shade(D, -0.70));
      if (on) bloom(x + w - 4, cy0, 1, 1, D, 0.18);
    }

    /* ---- ONE PATCH LEAD looping off the frame — the only curve on the prop ---- */
    const lx = x + w - 3, ly = fTop + 4;
    for (let t = 0; t <= 8; t++) {
      const a = (t / 8) * Math.PI;
      px(lx + Math.round(Math.sin(a) * 3), ly + t, 1, 1, r.ink);
    }
    px(lx + 2, ly + 8, 2, 2, r.ink); px(lx + 2, ly + 8, 1, 1, on ? D : shade(D, -0.6));

    /* ---- BASE: vented, dot grid ---- */
    const vy = base - 9;
    px(x + 1, vy, w - 2, 6, r.ink);
    px(x + 2, vy + 1, w - 4, 4, r.face);
    px(x + 2, vy + 1, w - 4, 1, r.mid);
    px(x + 2, vy + 1, 1, 4, r.top); px(x + w - 3, vy + 1, 1, 4, r.dk);
    for (let ry = 0; ry < 2; ry++) for (let rx = 0; rx < 3; rx++)
      px(x + 3 + rx * 2, vy + 3 + ry, 1, 1, r.ao);
    px(x + 2, base - 3, w - 4, 1, r.ao);
    if (on) spill(x + 1, base - 5, w - 2, M, 0.12, 3);

    /* ---- BRASS FEET ---- */
    px(x, base - 2, 4, 2, r.ink); px(x + w - 4, base - 2, 4, 2, r.ink);
    px(x + 1, base - 2, 2, 1, br.mid); px(x + w - 3, base - 2, 2, 1, br.mid);
  };
  F.bridge_dispatch_pylon = (x, y, w, h, f) => {   // v4 DISPATCH PYLON (1x2) — one tall SLOT of light, nothing else
    // Deliberately the thinnest emissive in the family: a single full-height dispatch slot recessed in a
    // chamfered column, so at 3x it reads as a vertical BAR while the tacscreen reads as a rectangle and the
    // orderqueue reads as floating slabs. The slot is a real light PIPE — a hot core, a dimmer surround and
    // spill onto the banding it crosses — and orders travel UP it as brighter packets when a run is live.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const RED = '#ff4a3d', HOT = '#ff8a78';
    const cx = x + w / 2, icx = Math.floor(cx);
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 5, w + 2, 5);                          // the pylon is bolted; the boards roll
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + h - 9, x + w + 2, y + h - 3, 2);
    // splayed base shoe
    chamf(x - 2, y + h - 6, w + 4, 5, LINE, 2);
    px(x - 1, y + h - 5, w + 2, 3, r.face); px(x - 1, y + h - 5, w + 2, 1, r.lit);
    keyEdge(x, y + h - 5, w, 1, 0.16);
    px(x - 1, y + h - 3, w + 2, 1, r.ao);
    // TALL 3/4 chamfered column + a cap we look down on
    chamf(x - 1, y - 3, w + 2, h - 2, LINE, 2);
    chamf(x, y - 2, w, h - 4, r.face, 2);
    px(x, y, 1, h - 8, shade(r.face, 0.12)); px(x + w - 1, y, 1, h - 8, r.dk);
    rimEdge(x + w - 1, y + 1, 1, h - 10, 0.22);
    chamf(x - 1, y - 6, w + 2, 4, LINE, 1);
    px(x, y - 5, w, 2, r.top); px(x, y - 5, w, 1, r.sheen); keyEdge(x, y - 5, 5, 1, 0.30);
    px(x, y - 3, w, 1, shade(r.top, -0.24));                      // cap lip ties cap to column
    // two beveled bands (kept) — the slot crosses them, which is what makes it read as recessed
    for (const by of [y + 1, y + h - 10]) {
      px(x, by, w, 3, shade(r.face, 0.14));
      px(x, by, w, 1, r.lit); keyEdge(x + 1, by, w - 3, 1, 0.16);
      px(x, by + 2, w, 1, r.ao);
      px(x + 1, by + 1, 1, 1, r.sheen); px(x + w - 2, by + 1, 1, 1, r.ao);   // rivets
    }
    wear(x + 1, y + 5, w - 2, h - 17, 3, shade(r.face, -0.12));
    // CROWN: rotating scan head on a stubby mast (kept sweep behaviour), tied down so it doesn't float
    px(icx - 1, y - 8, 3, 3, LINE); px(icx - 1, y - 8, 1, 3, r.lit); px(icx + 1, y - 8, 1, 3, r.dk);
    chamf(icx - 3, y - 10, 7, 3, LINE, 1);
    px(icx - 2, y - 9, 5, 2, r.top); px(icx - 2, y - 9, 5, 1, r.sheen);
    const sweep = Math.sin(now / 1300);
    const bx2 = icx + Math.round(sweep * 3);
    px(bx2, y - 11, 1, 1, on ? HOT : RED);
    bloom(bx2, y - 11, 1, 1, RED, on ? 0.44 : 0.26);
    ctx.globalAlpha = 0.16; px(Math.min(icx, bx2), y - 11, Math.abs(bx2 - icx) || 1, 1, RED); ctx.globalAlpha = 1; // beam trace
    // THE SLOT — a light pipe down the column's centre line, with real falloff into the casing
    const slotX = icx - 1, slotY = y + 5, slotH = h - 17;
    inset(slotX - 2, slotY - 2, 6, slotH + 4, '#201210');
    px(slotX - 1, slotY - 1, 4, slotH + 2, '#12090a');              // the well behind the diffuser
    const pl = on ? 0.55 + 0.45 * Math.abs(Math.sin(now / 480)) : 0.20 + 0.06 * Math.sin(now / 1400);
    px(slotX, slotY, 2, slotH, shade(RED, on ? -0.04 : -0.34));   // idle slot stays a dim ember, never black
    px(slotX, slotY, 1, slotH, shade(RED, 0.16));                 // west edge of the pipe catches more
    bloom(slotX, slotY, 2, slotH, RED, pl * 0.55);
    for (let i = 0; i < 3; i++) {                                   // ORDERS travelling up the pipe
      const t = ((now / (on ? 520 : 1500) + i * 0.34) % 1);
      const py2 = slotY + slotH - 2 - Math.round(t * (slotH - 2));
      px(slotX, py2, 2, 1, on ? '#ffd9d2' : shade(RED, 0.10));
      bloom(slotX, py2, 2, 1, RED, (on ? 0.40 : 0.18) * (1 - t * 0.6));
    }
    if (on && blink(480)) px(slotX, slotY, 2, slotH, HOT);          // hot core when dispatching (kept)
    spill(x + 1, slotY + slotH + 1, w - 2, RED, on ? 0.20 : 0.10, 4);  // slot light pooling down the shoe
    px(x + 2, y + h - 8, 2, 1, blink(on ? 420 : 1600, ph) ? ACC.flow : '#33271a');   // dispatch-ready lamp
  };
  F.bridge_orderqueue = (x, y, w, h, f) => {   // v4 ORDER QUEUE (2x1) — the family's only prop with NO screen in it
    // Its whole emissive lives in MID-AIR: a low top-bias-oblique projector cabinet you look down on, a recessed
    // emitter trough in its top, and a stack of order-cards floating above with real perspective (the far card
    // is narrower and dimmer than the near one). Everything below the cards is dark metal, which is what makes
    // this instantly separable from the tacscreen's framed rectangle and the pylon's vertical bar.
    // f.work = orders are actually flowing -> faster cycle, brighter cone, a fourth card in the stack.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const RED = '#ff4a3d', HOT = '#ff7a6c', PAPER = '#ffd9d2';
    const cx = x + Math.floor(w / 2);
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x + 1, y + h - 4, w - 2, 4);
    deckSocket(x - 3, y + h - 3, on);
    cable(x + 2, y + 8, x - 3, y + h - 3, 2);
    for (const lx of [x + 2, x + w - 5]) {                          // stubby feet on the plate
      px(lx, y + h - 5, 3, 3, LINE); px(lx, y + h - 5, 1, 3, r.lit); px(lx + 1, y + h - 5, 1, 3, r.dk);
    }
    underAO(x + 5, y + h - 5, w - 10, 2);
    // short vented south face (kept vents + status LED)
    chamf(x - 1, y + 5, w + 2, 7, LINE, 2);
    px(x, y + 6, w, 4, r.face);
    px(x, y + 6, w, 1, r.lit); keyEdge(x + 1, y + 6, w - 3, 1, 0.15);
    px(x, y + 6, 1, 4, shade(r.face, 0.08)); px(x + w - 1, y + 6, 1, 4, r.dk);
    rimEdge(x + w - 1, y + 6, 1, 4, 0.20);
    for (let i = 0; i < (w - 8) / 6; i++) {
      px(x + 4 + i * 6, y + 7, 1, 2, r.ao); px(x + 5 + i * 6, y + 7, 1, 2, shade(r.face, 0.14));
    }
    px(x, y + 9, w, 1, r.ao);
    px(x + 2, y + 7, 1, 1, (on ? blink(420, ph) : blink(1600, ph)) ? HOT : '#3a1c1a');   // status LED (kept)
    // TOP SURFACE we look down on, with the emitter trough sunk into it
    chamf(x - 1, y - 1, w + 2, 7, LINE, 2);
    chamf(x, y, w, 6, r.top, 2);
    px(x + 2, y, w - 4, 1, r.sheen); keyEdge(x + 2, y, 7, 1, 0.28);
    px(x, y + 2, 1, 3, r.lit); px(x + w - 1, y + 2, 1, 3, r.dk); rimEdge(x + w - 1, y + 2, 1, 3, 0.20);
    px(x + 2, y + 5, w - 4, 1, shade(r.top, -0.20));
    wear(x + 2, y + 1, w - 4, 4, 3, shade(r.top, -0.10));
    const tx = x + 4, tw = w - 8;
    px(tx - 1, y, tw + 2, 4, '#141013');                            // trough surround
    px(tx, y + 1, tw, 2, '#23181a');
    px(tx, y + 1, tw, 1, shade(r.top, -0.50));                    // shadow at the back of the trough
    px(cx - 3, y + 2, 6, 1, HOT);                                   // the emitter slit itself (kept)
    bloom(cx - 3, y + 2, 6, 1, RED, 0.22 + 0.10 * Math.abs(flick(1300)));
    for (const lx of [tx + 1, tx + tw - 2]) px(lx, y + 2, 1, 1, blink(700, lx + ph) ? RED : '#3a1c1a'); // lens pilots
    // PROJECTOR CONE rising from the trough — brighter and tighter while orders flow
    const coneTop = y - 13;
    ctx.save();
    ctx.globalAlpha = (on ? 0.14 : 0.09) + 0.05 * Math.abs(flick(1300));
    ctx.fillStyle = RED;
    ctx.beginPath();
    ctx.moveTo(cx, y + 2); ctx.lineTo(x + 3, coneTop); ctx.lineTo(x + w - 3, coneTop); ctx.closePath();
    ctx.fill();
    ctx.restore();
    // THE STACK — cards floating in the cone. Perspective: the far card is narrower, dimmer and thinner.
    const PERIOD = on ? 1800 : 2600;
    const phase = (now % PERIOD) / PERIOD;
    const rise = Math.floor(phase * 3);
    const bob = Math.round(Math.sin(now / 800));
    const NC = on ? 4 : 3;
    for (let c = 0; c < NC; c++) {
      const inset2 = c;                                             // higher cards sit further away -> narrower
      const cardX = x + 4 + inset2, cardW = w - 8 - inset2 * 2;
      const cy = coneTop + 1 + (NC - 1 - c) * 5 + bob - (c === NC - 1 ? rise : 0);
      if (cy < y - 18 || cardW < 4) continue;
      let a2 = 0.88 - c * 0.14;
      if (c === NC - 1) a2 *= (1 - phase * 0.7);
      ctx.save();
      ctx.globalAlpha = Math.max(0, a2);
      px(cardX, cy, cardW, 4, RED);
      px(cardX, cy, cardW, 1, HOT);                                 // bright top edge
      px(cardX, cy + 3, cardW, 1, '#c2241a');                       // darker base edge
      px(cardX, cy + 1, 1, 2, '#ffb0a6');                           // west edge catch — gives the card thickness
      const scroll = Math.floor(now / 110);                         // the order's text scrolling across it
      for (let g = 0; g < cardW - 2; g += 2)
        if (((g + scroll + c * 3) >> 1) % 3 !== 0) px(cardX + 1 + g, cy + 1, 1, 1, PAPER);
      px(cardX + 1, cy + 2, Math.max(1, Math.floor(cardW * 0.4)), 1, '#ff9d8e');   // a priority underline
      ctx.restore();
      if (c === 0) bloom(cardX, cy, cardW, 4, RED, 0.16);           // only the NEAREST card blooms
    }
    if (phase > 0.6) {                                              // fresh card glinting up out of the slit (kept)
      const fy2 = y + 1 - Math.floor((phase - 0.6) * 8);
      bloom(cx - 3, fy2, 6, 2, HOT, 0.45 * (phase - 0.6) / 0.4);
    }
    spill(x + 3, y - 1, w - 6, RED, on ? 0.16 : 0.09, 4);           // card light falling back onto the cabinet top
  };
  F.research_corelens = (x, y, w, h, f) => { // v4 core lens (1x2) — bolted optics column; the lens is its ONLY light
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x, y + h - 1, w);
    deckPlate(x - 2, y + h - 4, w + 4, 4);                      // bolted to the deck like the rest of the bench
    deckSocket(x + w + 2, y + h - 3, on);
    cable(x + w - 2, y + h - 6, x + w + 2, y + h - 3, 1.6);
    // flared foot
    chamf(x - 1, y + h - 9, w + 2, 6, LINE, 1);
    px(x, y + h - 8, w, 4, r.face); px(x, y + h - 8, w, 1, r.lit); keyEdge(x + 1, y + h - 8, 4, 1, 0.18);
    px(x + w - 1, y + h - 7, 1, 3, r.dk); rimEdge(x + w - 1, y + h - 7, 1, 3, 0.20);
    px(x, y + h - 5, w, 1, r.ao);
    // full-height column — cylindrical read: lit west band, shaded east band, cool bounce on the shade edge
    chamf(x, y - 6, w, 22, LINE, 2);
    px(x + 1, y - 5, w - 2, 20, r.face);
    px(x + 1, y - 5, 2, 20, r.lit); keyEdge(x + 1, y - 4, 1, 10, 0.16);
    px(x + w - 3, y - 5, 2, 20, r.dk); rimEdge(x + w - 2, y - 4, 1, 14, 0.20);
    // domed cap
    chamf(x, y - 9, w, 4, LINE, 1);
    px(x + 1, y - 8, w - 2, 1, r.sheen); keyEdge(x + 1, y - 8, 4, 1, 0.28);
    px(x + 1, y - 7, w - 2, 2, r.top); px(x + 1, y - 6, w - 2, 1, shade(r.top, -0.24));
    // recessed lens housing (kept: concentric arcs, sweep, pupil spec)
    const lensTop = y - 4, lensH = 13;
    inset(x + 1, lensTop, w - 2, lensH, '#10161a');
    px(x + 1, lensTop, w - 2, 1, shade(r.face, -0.55));      // hood shadow into the top of the well
    const lcx = x + w / 2, lcy = lensTop + lensH / 2, R = (w - 5) / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(x + 2, lensTop + 1, w - 4, lensH - 2); ctx.clip();
    for (let cr = R; cr >= 1.2; cr -= 1.2) {
      const t = cr / R;
      ctx.beginPath();
      ctx.strokeStyle = shade(ACC.data, -0.48 + 0.40 * (1 - t));
      ctx.globalAlpha = (on ? 1 : 0.62) * (0.35 + 0.4 * (1 - t));
      ctx.arc(lcx, lcy, cr, 0, 6.2832); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.fillStyle = '#1f6b80'; ctx.arc(lcx, lcy, Math.max(1.5, R * 0.4), 0, 6.2832); ctx.fill();
    ctx.beginPath(); ctx.fillStyle = '#0e3540'; ctx.arc(lcx, lcy, 1, 0, 6.2832); ctx.fill();
    const sweep = (now / 2000 + ph * 0.11) % 1;                // scan sweep (kept)
    const sy2 = Math.round(lensTop + 1 + sweep * (lensH - 2));
    ctx.globalAlpha = 0.20; px(x + 2, sy2 - 3, w - 4, 4, ACC.data); ctx.globalAlpha = 1;
    px(x + 2, sy2, w - 4, 1, '#bff0ff');
    ctx.globalAlpha = 0.42; px(x + 2, sy2, w - 4, 2, ACC.data); ctx.globalAlpha = 1;
    ctx.restore();
    px(Math.round(lcx) - 1, Math.round(lcy) - 1, 1, 1, '#cdeeff');   // pupil spec (kept)
    bloom(x + 2, lensTop + 1, w - 4, lensH - 2, ACC.data, on ? 0.15 : 0.08);
    spill(x + 1, lensTop + lensH, w - 2, ACC.data, on ? 0.20 : 0.10, 4);  // lens light pools down the column
    // instrument collar + the amber hardware LEDs the whole research bench shares (kept 520)
    px(x + 1, y + 10, w - 2, 2, shade(r.face, -0.30)); px(x + 1, y + 10, w - 2, 1, shade(r.top, 0.10));
    knurl(x + 2, y + 11, w - 4, 1, r.face);
    for (let i = 0; i < 2; i++) {
      const lx2 = i ? x + w - 4 : x + 2, lit = blink(520, i);
      px(lx2, y + 13, 2, 2, lit ? '#ffb347' : '#5a3f1a');
      if (lit) bloom(lx2, y + 13, 2, 2, '#ffb347', 0.24);
    }
    px(x + 2, y + 15, w - 4, 1, r.dk); px(x + 2, y + 16, w - 4, 1, shade(r.face, 0.14)); // lower seam (kept)
    bloom(x, y + h - 6, w, 3, ACC.data, (on ? 0.14 : 0.08) + 0.04 * Math.sin(now / 600 + ph)); // floor bleed (kept)
  };
  F.research_trendpillar = (x, y, w, h, f) => { // v4 trend totem (1x2) — a hooded strip chart, same bench hardware
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x, y + h - 1, w);
    deckPlate(x - 2, y + h - 4, w + 4, 4);
    deckSocket(x + w + 2, y + h - 3, on);
    cable(x + w - 2, y + h - 6, x + w + 2, y + h - 3, 1.6);
    // pedestal foot with the vent + status LED (kept 2200)
    chamf(x - 1, y + h - 10, w + 2, 7, LINE, 1);
    px(x, y + h - 9, w, 5, r.face); px(x, y + h - 9, w, 1, r.lit); keyEdge(x + 1, y + h - 9, 4, 1, 0.18);
    px(x + w - 1, y + h - 8, 1, 4, r.dk); rimEdge(x + w - 1, y + h - 8, 1, 4, 0.20);
    px(x, y + h - 5, w, 1, r.ao);
    inset(x + 2, y + h - 7, w - 4, 3, '#10161a');
    for (let i = 0; i < 3; i++) px(x + 3 + i * 2, y + h - 6, 1, 1, shade(r.face, -0.5));  // vent slots
    px(x + 3, y + h - 6, 1, 1, blink(2200) ? ACC.work : '#1c2a22');
    if (blink(2200)) bloom(x + 3, y + h - 6, 1, 1, ACC.work, 0.26);
    // slab body, full height, chamfered cap — two temperatures down the flanks
    chamf(x, y - 7, w, 23, LINE, 2);
    px(x + 1, y - 6, w - 2, 21, r.face);
    px(x + 1, y - 6, w - 2, 1, r.sheen); keyEdge(x + 1, y - 6, 4, 1, 0.28);
    px(x + 1, y - 5, 1, 20, r.lit); px(x + w - 2, y - 5, 1, 20, r.dk);
    rimEdge(x + w - 2, y - 4, 1, 16, 0.20);
    // a real HOOD over the screen — the totem needs a brow or the display floats on a bare slab
    px(x, y - 5, w, 2, LINE); px(x + 1, y - 5, w - 2, 1, r.top); keyEdge(x + 1, y - 5, 5, 1, 0.24);
    px(x + 1, y - 3, w - 2, 1, shade(r.face, -0.5));         // the hood's shadow onto the glass
    // vertical strip display (kept: dual charts, ticker, drifting scan)
    const scX = x + 1, scW = w - 2, scY = y - 3, scH = h - 11;
    inset(scX, scY, scW, scH, '#0a1416');
    ctx.save();
    ctx.beginPath(); ctx.rect(scX + 1, scY + 1, scW - 2, scH - 2); ctx.clip();
    const gX = scX + 1, gW = scW - 2, gTop = scY + 2, gH = scH - 4;
    px(gX, gTop, gW, gH, '#08171b');                           // idle glass keeps phosphor, never a hole
    const dimA = on ? 1 : 0.45, tk = Math.floor(now / 110);
    for (let i = 0; i < gW; i++) {
      const s = U.hash('trend' + ((i + tk) % 64));
      const cy3 = gTop + gH - 2 - (i / gW) * (gH - 4) - (s % 5) + 2;
      ctx.globalAlpha = dimA;
      px(gX + i, cy3, 1, 1, ACC.data);
      if (i > 0) px(gX + i, cy3 + 1, 1, 1, shade(ACC.data, -0.45));   // the series' own shadow under it
      ctx.globalAlpha = dimA * 0.85;
      px(gX + i, gTop + gH - 1 - (i / gW) * (gH - 8) * 0.6 - (U.hash('curie' + ((i + tk) % 64)) % 3), 1, 1, '#8f7bff');
      ctx.globalAlpha = 1;
    }
    const tick = Math.floor(now / 240) % 9;                    // crawling ticker (kept)
    for (let rw = 0; rw < gH; rw += 3) {
      const yy = gTop + ((rw + tick) % gH);
      const v = U.hash('pct' + rw + (Math.floor(now / 700) % 7)) % 99;
      ctx.globalAlpha = dimA * 0.5;
      px(gX + 1, yy, 1, 1, v % 2 ? ACC.work : '#ff6a6a');
      px(gX + 3 + (v % 3), yy, 1, 1, '#3a5c50');
      px(gX + gW - 3 - (v % 2), yy, 1, 1, '#3a5c50');
      ctx.globalAlpha = 1;
    }
    const scanY = gTop + Math.floor((Math.sin(now / 600 + ph) * 0.5 + 0.5) * (gH - 1));  // drifting scan (kept)
    ctx.globalAlpha = on ? 0.22 : 0.10; px(gX, scanY, gW, 1, '#9af0ff'); ctx.globalAlpha = 1;
    scanl(gX, gTop, gW, gH, 0.16);
    ctx.restore();
    px(scX, scY, scW, 1, shade('#2a332f', 0.18));            // bezel highlights (kept)
    px(scX, scY, 1, scH, shade('#2a332f', 0.10));
    px(scX + scW - 1, scY, 1, scH, '#1a221e');
    bloom(scX + 1, scY + 1, scW - 2, scH - 2, ACC.data, on ? 0.14 : 0.07);
    spill(scX, scY + scH, scW, ACC.data, on ? 0.20 : 0.09, 4); // chart light pools down onto the pedestal
    // the bench's shared amber hardware LED, low on the slab
    px(x + 2, y + h - 12, 2, 1, blink(520, 1) ? '#ffb347' : '#5a3f1a');
  };
  F.research_samplecart = (x, y, w, h, f) => { // v4 sample cart (2x1) — freestanding trolley; the vials do the lighting
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const wx of [x + 3, x + w - 6]) {                     // caster wheels, proud of the frame
      px(wx - 1, y + h - 4, 4, 4, LINE);
      px(wx, y + h - 3, 2, 2, '#15191a'); px(wx, y + h - 3, 2, 1, '#2c3438');
      px(wx, y + h - 4, 2, 1, shade(r.face, 0.10));          // the fork the caster hangs off
    }
    // open mid shelf: dark void, corner posts, a cross-brace so the frame is a frame and not two sticks
    px(x + 2, y + 5, w - 4, 4, '#0d1318');
    for (const pxp of [x + 1, x + w - 3]) {
      px(pxp, y + 4, 2, 5, LINE); px(pxp, y + 4, 1, 5, r.lit); px(pxp + 1, y + 4, 1, 5, r.dk);
    }
    rimEdge(x + w - 2, y + 5, 1, 4, 0.18);
    cable(x + 3, y + 6, x + w - 4, y + 6, 1.4, '#141b20');     // slack lead strung under the tray
    px(x + 2, y + 8, w - 4, 1, '#2c3630');                     // shelf plank
    px(x + 4, y + 5, 6, 3, '#5a665c'); px(x + 4, y + 5, 6, 1, '#6e7a70');  // drive caddy
    px(x + 5, y + 6, 4, 1, '#222a26');                         // drive slot
    px(x + 11, y + 6, 1, 1, blink(520, ph) ? '#7dffb0' : '#1d3a2c');       // read LED (kept 520)
    if (blink(520, ph)) bloom(x + 11, y + 6, 1, 1, ACC.work, 0.26);
    // the chamfered top tray dominates
    chamf(x - 1, y - 2, w + 2, 8, LINE, 2);
    chamf(x, y - 1, w, 6, r.top, 1);
    px(x + 2, y - 1, w - 4, 1, r.sheen); keyEdge(x + 2, y - 1, 8, 1, 0.26);
    px(x, y, 1, 4, r.lit); px(x + w - 1, y, 1, 4, r.dk); rimEdge(x + w - 1, y, 1, 4, 0.20);
    px(x + 1, y + 4, w - 2, 1, shade(r.top, -0.18));
    wear(x + 2, y, w - 4, 4, 3, shade(r.top, -0.10));
    // VIAL RACK: three capped vials, each lit from the liquid inside (kept stagger pulse)
    px(x + 2, y - 1, 13, 3, '#242e28'); px(x + 3, y - 1, 11, 1, '#3c4840');
    for (let i = 0; i < 3; i++) {
      const vx = x + 4 + i * 4, lit = 0.55 + 0.35 * Math.sin(now / 760 + i * 1.7 + ph);
      px(vx - 1, y - 6, 4, 6, LINE);
      px(vx, y - 5, 2, 1, '#8a9a96'); px(vx, y - 5, 1, 1, '#a8b8b4');     // cap
      px(vx, y - 4, 2, 4, '#1c2a30');                                     // glass above the meniscus
      px(vx, y - 2, 2, 2, shade(ACC.data, -0.30 - 0.16 * (1 - lit)));   // the liquid body
      px(vx, y - 2, 2, 1, shade(ACC.data, 0.10 * lit));                 // lit meniscus
      px(vx, y - 4, 1, 3, shade(SKY, -0.30));                           // cool sky catch down the glass
      bloom(vx, y - 2, 2, 2, ACC.data, (on ? 0.16 : 0.09) + 0.10 * lit);
    }
    spill(x + 3, y + 1, 11, ACC.data, on ? 0.18 : 0.10, 3);    // the rack pools cyan onto the tray
    px(x + 17, y, 5, 3, '#cfd2c8'); px(x + 17, y, 5, 1, '#e6e8df');       // folded printout (kept)
    px(x + 18, y + 1, 3, 1, '#9aa094'); px(x + 19, y + 2, 1, 1, '#8c9286');
    // push handle jutting east
    px(x + w, y - 3, 2, 8, LINE); px(x + w, y - 2, 1, 6, r.lit); px(x + w + 1, y - 2, 1, 6, r.dk);
    px(x + w - 1, y - 4, 4, 2, LINE); px(x + w, y - 4, 3, 1, r.sheen);    // grip
    knurl(x + w, y - 4, 3, 1, r.top);
  };
  F.research_papers = (x, y, w, h, f) => { // v4 printouts (2x1) — the bench's one MATTE prop: no glow, only stacking
    const paper = '#ded9cc', hi = shade(paper, 0.16), shd = shade(paper, -0.26), ink = '#7e8484';
    const on = !!(f && f.work);
    sh(x + 2, y + h - 2, w - 4);
    ctx.globalAlpha = 0.26; px(x + 2, y + 9, w - 6, 2, '#000'); ctx.globalAlpha = 1;   // the contact shadow does the work
    // manila folder underneath (kept)
    const fold = '#bfa96f';
    px(x + 1, y + 3, 11, 8, shade(fold, -0.42));
    px(x + 1, y + 2, 11, 8, fold);
    px(x + 1, y + 2, 11, 1, shade(fold, 0.20));
    px(x + 8, y + 2, 4, 1, shade(fold, 0.28));               // raised tab
    rimEdge(x + 1, y + 9, 11, 1, 0.10);                        // cool floor bounce into the folder's shade
    // two low stacks — the rise is told by the stacked SHEET EDGES, not by a highlight
    const stack = (sx2, sy2, sw2, sh2) => {
      ctx.globalAlpha = 0.22; px(sx2 - 1, sy2 + sh2 + 1, sw2 + 2, 2, '#000'); ctx.globalAlpha = 1;
      for (let j = 0; j < 3; j++) px(sx2 + (j % 2), sy2 + sh2 + j, sw2 - (j % 2), 1, shade(paper, -0.20 - j * 0.08));
      px(sx2, sy2, sw2, sh2, paper);
      px(sx2, sy2, sw2, 1, hi); px(sx2, sy2, 1, sh2, hi);
      keyEdge(sx2, sy2, Math.max(1, sw2 - 3), 1, 0.10);        // a warm ceiling wash, matte — paper takes no sheen
      px(sx2 + sw2 - 1, sy2 + 1, 1, sh2 - 1, shd);
    };
    stack(x + 2, y + 1, 8, 5);
    stack(x + 13, y + 3, 8, 5);
    px(x + 3, y + 3, 5, 1, ink); px(x + 3, y + 5, 4, 1, ink);
    px(x + 14, y + 5, 5, 1, ink); px(x + 14, y + 7, 4, 1, '#969c9c');
    // the topmost readable sheet with its bar chart — printed INK, never an emissive
    const tx = x + 7 + (on ? 1 : 0), ty = y + 2, tw = 9, th = 9;   // a fresh sheet lands askew while printing
    ctx.globalAlpha = 0.30; px(tx - 1, ty + 2, tw + 1, th - 1, '#000'); ctx.globalAlpha = 1;
    px(tx, ty, tw, th, paper);
    px(tx, ty, tw, 1, hi); px(tx, ty, 1, th, hi);
    keyEdge(tx, ty, 6, 1, 0.12);
    px(tx + tw - 1, ty + 1, 1, th - 1, shd); px(tx, ty + th - 1, tw, 1, shd);
    px(tx + tw - 3, ty - 1, 3, 1, shade(paper, -0.30));      // curl shadow (kept)
    px(tx + tw - 3, ty, 3, 2, hi); px(tx + tw - 1, ty, 1, 1, shade(paper, 0.30)); // curled corner
    px(tx + 1, ty + 2, 6, 1, ink);
    const bars = [2, 4, 3, 5];
    for (let b = 0; b < bars.length; b++) {
      px(tx + 1 + b * 2, ty + 8 - bars[b], 1, bars[b], shade(ACC.data, -0.42));   // cyan INK, dimmer than a lamp
      px(tx + 1 + b * 2, ty + 8 - bars[b], 1, 1, shade(ACC.data, -0.14));
    }
    const k = Math.floor(now / 600) % bars.length;             // the read-head tick (kept cadence)
    px(tx + 1 + k * 2, ty + 8 - bars[k], 1, 1, on ? '#f6f2e8' : shade(ACC.data, 0.10));
    if (on) { px(tx - 2, ty + th - 2, tw + 1, 2, paper); px(tx - 2, ty + th - 2, tw + 1, 1, hi); } // sheet feeding out
  };
  F.comms_dish = (x, y, w, h, f) => {
    /* v30 UPLINK DISH (2x2) — rebuilt again, and the lesson from v29 is the whole design:
       ⛔ A DISH READS BY ITS TILT. Drawn as an upright ellipse it is a plate, or worse a grey blob —
          v29 proved that even with correct concave shading. What says "dish" is an aperture aimed
          somewhere: a circle foreshortened along a TILTED axis, so you see into the bowl.
       ⛔ RIBS ARE NOISE AT THIS SIZE. v29's six radials read as cracks. The bowl is described by its
          shading gradient and its rim, nothing else.
       ⛔ The bowl is CONCAVE, so its lighting inverts: the interior wall nearest the light sits in
          shadow and the FAR wall catches it. The bright arc lives on the rim, on the lit side only.
       The bowl is rasterised per pixel through a rotated ellipse test, so every edge lands on the
       world grid — canvas arcs antialias into mud at 24px. */
    const r = EQUIPMENT, b = INSTRUMENT, active = !!(f && f.work);
    const cx = x + Math.round(w / 2), cy = y + 9;
    const RX = 10, RY = 7, A = -0.62;                             // aperture radii + tilt (aimed up-west)
    const ca = Math.cos(A), sa = Math.sin(A);

    shadow2(x + 2, y + h - 1, w - 4);
    deckPlate(x + 3, y + h - 5, w - 6, 5);
    deckSocket(x + 2, y + h - 3, active);

    /* ---- MOUNT: geared pedestal, widest at the deck ---- */
    const bx = cx - 5, by = y + 16;
    px(bx - 2, by + 5, 14, 3, r.ink);                             // splayed foot
    px(bx - 1, by + 6, 12, 1, r.face); px(bx - 1, by + 6, 4, 1, r.mid);
    px(bx, by, 10, 6, r.ink);                                     // pedestal body
    panelFinish(bx + 1, by + 1, 8, 4, r);
    px(bx + 1, by + 1, 8, 1, r.mid);
    px(bx + 1, by + 1, 1, 4, r.top); px(bx + 8, by + 1, 1, 4, r.dk);
    px(bx + 2, by + 3, 6, 1, r.ao); px(bx + 2, by + 2, 6, 1, r.top);
    px(bx + 3, by + 3, 1, 1, active ? ACC.data : shade(ACC.data, -0.6));
    px(bx - 1, by - 2, 12, 2, r.ink);                             // azimuth gear
    px(bx, by - 1, 10, 1, r.mid);
    for (let i = 0; i < 5; i++) px(bx + 1 + i * 2, by - 2, 1, 1, r.lit);
    px(cx - 2, y + 12, 4, 5, r.ink);                              // elevation post up to the bowl
    px(cx - 1, y + 12, 1, 5, r.mid); px(cx, y + 12, 1, 5, r.face);

    /* ---- THE BOWL: one rotated ellipse, tested per pixel ---- */
    for (let dy = -RY - 3; dy <= RY + 3; dy++) {
      for (let dx = -RX - 3; dx <= RX + 3; dx++) {
        const u = (dx * ca + dy * sa) / RX;                       // along the aperture
        const v = (-dx * sa + dy * ca) / RY;                      // across it — the foreshortened axis
        const d = u * u + v * v;
        if (d > 1.14) continue;
        let c;
        if (d > 1.0) c = r.ink;                                   // hard outline
        else if (d > 0.74) {
          // RIM BAND — bright where it faces the ceiling strip, falling away on the far side
          c = v < -0.45 ? r.lit : v < 0.1 ? r.mid : v < 0.62 ? r.face : r.dk;
          if (v < -0.7 && u > -0.4 && u < 0.45) c = r.hi;         // one specular chip on the crown
        } else {
          // INTERIOR — inverted: the near wall is shadow, the far wall takes the light
          c = v < -0.25 ? r.ao : v < 0.18 ? r.dk : v < 0.58 ? r.face : r.top;
        }
        px(cx + dx, cy + dy, 1, 1, c);
      }
    }

    /* ---- FEED HORN on ONE arm off the rim — three struts turned into a scribble at this size ---- */
    const fx = cx + Math.round(-sa * RY * 0.10), fy = cy + Math.round(ca * RY * 0.10);
    const ax0 = cx + Math.round(ca * RX * 0.92), ay0 = cy + Math.round(sa * RX * 0.92);
    const steps = Math.max(Math.abs(fx - ax0), Math.abs(fy - ay0), 1);
    for (let i = 0; i <= steps; i++)
      px(Math.round(ax0 + (fx - ax0) * i / steps), Math.round(ay0 + (fy - ay0) * i / steps), 1, 1, b.ink);
    px(fx - 2, fy - 2, 4, 4, b.ink);
    px(fx - 1, fy - 1, 2, 2, b.face); px(fx - 1, fy - 1, 2, 1, b.lit);
    px(fx, fy, 1, 1, active ? '#c7f4ff' : ACC.data);
    bloom(fx, fy, 1, 1, ACC.data, (active ? 0.40 : 0.16) * (0.45 + 0.55 * Math.max(0, Math.sin(now / 750))));

    /* ---- ACTIVE: signal breaking outward along the aim ---- */
    if (active) {
      ctx.save(); ctx.lineWidth = 1; ctx.strokeStyle = ACC.data;
      for (let k = 0; k < 3; k++) {
        const t = ((now / 950) + k / 3) % 1;
        ctx.globalAlpha = 0.38 * (1 - t) * (1 - t);
        ctx.beginPath(); ctx.arc(fx, fy, 5 + t * 17, A - 1.15, A + 0.35); ctx.stroke();
      }
      ctx.restore();
    }
  };
  F.comms_inbox = (x, y, w, h, f) => {
    // INBOX (2x1, blocks:true) — v4. A real bolted intake: the family register is ARRIVAL, so the machine
    // both swallows a physical card at the front slot AND stacks the holo receipts above it. The stack used
    // to float free of the prop; twin emitter posts now project it, which is what ties it down. Kept: the
    // 2s rise/fade cycle, the three channel pips, the unread badge tick, and the f.work lift.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const cy0 = ACC.data;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + 7, x + w + 2, y + h - 3, 2.2);
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // short front face: the INTAKE SLOT with a card being drawn in, then the kept channel pips
    rr(x - 1, y + 4, w + 2, 6, LINE);
    px(x, y + 5, w, 3, r.face);
    px(x, y + 5, w, 1, r.lit); keyEdge(x + 1, y + 5, w - 3, 1, 0.15);
    px(x, y + 7, w, 1, r.ao);
    inset(x + 3, y + 5, 9, 2, '#080e0c');
    const draw0 = (now % 2600) / 2600;                            // a card is pulled IN, not pushed out
    if (draw0 < 0.45) {
      const ins = Math.round((1 - draw0 / 0.45) * 4);
      if (ins > 0) { px(x + 5, y + 6, ins + 1, 1, '#b3bcb4'); px(x + 5, y + 6, 1, 1, '#d8e0d6'); }
    }
    const alert = blink(520, 1);                                  // kept channel pips
    px(x + 13, y + 6, 2, 1, blink(900, ph) ? ACC.work : '#173026');        // mail
    px(x + 16, y + 6, 2, 1, alert ? '#ffb23a' : '#3a2c12');                // webhook
    px(x + 19, y + 6, 2, 1, blink(1300, 2 + ph) ? ACC.work : '#173026');   // platform
    if (alert) bloom(x + 16, y + 6, 2, 1, '#ff9d2e', 0.30);
    // dominant chamfered top with a recessed holo tray
    chamf(x - 1, y - 4, w + 2, 10, LINE, 2);
    chamf(x, y - 3, w, 8, r.top, 2);
    px(x + 2, y - 3, w - 4, 1, r.sheen); keyEdge(x + 2, y - 3, 8, 1, 0.28);
    px(x, y - 1, 1, 4, r.lit); px(x + w - 1, y - 1, 1, 4, r.dk);
    rimEdge(x + w - 1, y - 1, 1, 4, 0.20);
    px(x + 2, y + 4, w - 4, 1, shade(r.top, -0.18));
    wear(x + 1, y - 2, w - 2, 5, 3, shade(r.top, -0.10));
    inset(x + 3, y - 2, w - 6, 5, '#07110f');                     // glass tray
    bloom(x + 4, y - 1, w - 8, 3, cy0, on ? 0.18 : 0.10 + 0.05 * Math.sin(now / 640));
    // EMITTER POSTS — the stack read as a second floating object until these carried it
    for (const ex of [x + 3, x + w - 5]) {
      px(ex, y - 7, 2, 5, LINE); px(ex, y - 7, 1, 5, r.lit); px(ex + 1, y - 7, 1, 5, r.dk);
      px(ex, y - 8, 2, 1, shade(r.top, 0.18));
      px(ex, y - 7, 2, 1, on ? '#bff5ff' : shade(cy0, -0.45));
      bloom(ex, y - 7, 2, 1, cy0, on ? 0.34 : 0.16);
    }
    // holo receipt stack rising out of the tray (kept 2s cycle), each an envelope with a flap
    const t = (now % 2000) / 2000, cardW = 8, cardX = x + 8;
    for (let s = 0; s < 3; s++) {
      const cy = y - 3 - s * 3 - Math.round(t * (s === 0 ? 4 : 3));
      let a = (s === 0 ? 0.90 * (1 - t) : 0.82 - s * 0.22);
      if (a <= 0.05) continue;
      ctx.save(); ctx.globalAlpha = a;
      const col = s === 0 ? '#8ff0ff' : shade(cy0, -0.34);
      px(cardX, cy, cardW, 1, col); px(cardX, cy + 2, cardW, 1, col);
      px(cardX, cy, 1, 3, col); px(cardX + cardW - 1, cy, 1, 3, col);
      px(cardX + 3, cy + 1, 2, 1, shade(col, 0.30));            // flap hint
      ctx.restore();
    }
    // unread-count badge on the NE corner (kept tick)
    const cnt = (Math.floor(now / 2000) % 9) + 1, bx = x + w - 7, by = y - 6;
    px(bx, by, 5, 4, '#0a1614'); px(bx, by, 5, 1, shade(cy0, -0.55));
    const segOn = (U.hash('' + cnt) % 2) === 0;
    px(bx + 1, by + 1, 3, 1, cy0);
    px(bx + 1, by + 2, segOn ? 3 : 2, 1, shade(cy0, 0.20));
    bloom(bx + 1, by + 1, 3, 2, cy0, 0.26);
    if (on) px(cardX - 1, y - 3, 1, 1, '#dff9ff');                // kept active-use catch
  };
  F.comms_uplink = (x, y, w, h, f) => {
    /* v30 UPLINK MAST (2x2) — rebuilt. Three props grant WEB and they must differ in SILHOUETTE, not
       trim: the dish is a reflector, this is a LATTICE MAST, the beacon is a lamp stack.
       ⛔ A LATTICE ONLY READS IF YOU CAN SEE THROUGH IT. Two thin uprights, cross bracing, and real
          deck in every gap. A filled taper is a traffic cone.
       ⛔ The bracing has to be a consistent zig-zag, not random struts — the eye reads the RHYTHM as
          structure. Break the rhythm and it is scaffolding that fell over. */
    const r = EQUIPMENT, active = !!(f && f.work);
    const cx = x + Math.round(w / 2), base = y + h;

    shadow2(x + 3, base - 1, w - 6);
    deckPlate(x + 3, base - 5, w - 6, 5);
    deckSocket(x + 2, base - 3, active);

    /* ---- equipment box at the foot: this is where the electronics live ---- */
    const bx = cx - 6, by = base - 10;
    px(bx, by, 12, 8, r.ink);
    panelFinish(bx + 1, by + 1, 10, 6, r);
    px(bx + 1, by + 1, 10, 1, r.mid);                             // top plane
    px(bx + 1, by + 1, 1, 6, r.top); px(bx + 10, by + 1, 1, 6, r.dk);
    for (let i = 0; i < 3; i++) px(bx + 2, by + 3 + i, 5, 1, i % 2 ? r.dk : r.ao);   // louvres
    px(bx + 8, by + 3, 2, 2, r.ao);                               // meter window
    px(bx + 8, by + 3, 2, 1, active ? ACC.data : shade(ACC.data, -0.62));
    px(bx + 2, by + 6, 8, 1, r.dk);

    /* ---- THE MAST: two uprights with zig-zag bracing, deck visible between ---- */
    const mTop = y - 7, mBot = by;
    const legL = cx - 4, legR = cx + 3;
    for (const lx of [legL, legR]) {
      px(lx, mTop + 2, 1, mBot - mTop - 2, r.ink);
      px(lx, mTop + 2, 1, mBot - mTop - 2, lx === legL ? r.mid : r.dk);
    }
    // zig-zag bracing — one diagonal per 3 rows, alternating direction
    for (let row = 0, n = 0; mTop + 3 + row < mBot - 1; row += 3, n++) {
      const y0 = mTop + 3 + row, y1 = Math.min(y0 + 3, mBot - 1);
      const span = legR - legL;
      for (let s2 = 0; s2 <= span; s2++) {
        const t = s2 / span;
        const yy = Math.round(n % 2 ? y1 - t * (y1 - y0) : y0 + t * (y1 - y0));
        px(legL + s2, yy, 1, 1, r.face);
      }
      px(legL, y0, span + 1, 1, r.dk);                            // horizontal tie at each bay
    }

    /* ---- the ARRAY on top: stacked dipole bars, widest at the bottom ---- */
    px(cx - 1, mTop - 3, 3, 6, r.ink);
    px(cx, mTop - 3, 1, 6, r.mid);
    for (let i = 0; i < 3; i++) {
      const bw2 = 9 - i * 2, byy = mTop - 2 + i * 2;
      px(cx - (bw2 >> 1), byy, bw2, 1, r.ink);
      px(cx - (bw2 >> 1) + 1, byy, bw2 - 2, 1, i === 0 ? r.lit : r.mid);
    }
    px(cx, mTop - 4, 1, 1, active ? '#c7f4ff' : ACC.data);        // strobe at the tip
    bloom(cx, mTop - 4, 1, 1, ACC.data, (active ? 0.44 : 0.16) * (0.4 + 0.6 * Math.max(0, Math.sin(now / 620))));

    if (active) {                                                 // transmit: rings off the tip
      ctx.save(); ctx.lineWidth = 1; ctx.strokeStyle = ACC.data;
      for (let k = 0; k < 3; k++) {
        const t = ((now / 1050) + k / 3) % 1;
        ctx.globalAlpha = 0.34 * (1 - t) * (1 - t);
        ctx.beginPath(); ctx.arc(cx, mTop - 4, 3 + t * 15, -2.6, -0.5); ctx.stroke();
      }
      ctx.restore();
    }
  };
  F.comms_beacon = (x, y, w, h, f) => {
    /* v30 BEACON (1x2) — rebuilt as a FRESNEL LAMP STACK, the third WEB silhouette. Dish = a
       reflector, uplink = a lattice mast, this = a squat lighthouse: heavy base, a glass drum, a
       vented cap. Nothing about it is mast-shaped or dish-shaped.
       ⛔ THE DRUM IS THE WHOLE PROP — a fresnel lens is horizontal RIDGES, and those ridges are the
          one thing that says "lens" rather than "window". They must alternate hard: a bright ridge
          against a near-black groove, or at 12px wide it is a grey box with a light in it.
       ⛔ HEAT LIVES WHERE THE HEAT IS — the glow belongs INSIDE the drum, not washed over the casing.
          A beacon glowing through its own metal is a lamp shaped like a beacon. */
    const r = EQUIPMENT, active = !!(f && f.work);
    const cx = x + Math.round(w / 2), base = y + h;
    const G = ACC.data;

    shadow2(x + 1, base - 1, w - 2);
    deckPlate(x, base - 5, w, 5);
    deckSocket(x + w + 1, base - 3, active);

    /* ---- BASE: widest at the deck, stepped in twice ---- */
    px(x, base - 8, w, 8, r.ink);
    panelFinish(x + 1, base - 7, w - 2, 6, r);
    px(x + 1, base - 7, w - 2, 1, r.mid);
    px(x + 1, base - 7, 1, 6, r.top); px(x + w - 2, base - 7, 1, 6, r.dk);
    px(x + 2, base - 5, w - 4, 1, r.ao); px(x + 2, base - 6, w - 4, 1, r.mid);   // service seam
    px(x + 3, base - 3, 2, 1, active ? ACC.work : shade(ACC.work, -0.62));     // power lamp
    px(x + 1, base - 9, w - 2, 2, r.ink);                         // collar under the drum
    px(x + 2, base - 8, w - 4, 1, r.lit);

    /* ---- THE DRUM: a stack of fresnel ridges, hard alternating ---- */
    const dTop = y + 3, dBot = base - 9, dx0 = x + 1, dw = w - 2;
    px(dx0 - 1, dTop - 1, dw + 2, dBot - dTop + 1, r.ink);        // drum cage
    for (let yy = dTop, i = 0; yy < dBot; yy++, i++) {
      const lit = i % 2 === 0;
      if (lit) {
        px(dx0, yy, dw, 1, active ? G : shade(G, -0.66));       // the ridge itself
        px(dx0 + 1, yy, 2, 1, active ? '#d6f7ff' : shade(G, -0.42));   // west end catches hardest
      } else {
        px(dx0, yy, dw, 1, active ? shade(G, -0.72) : '#0d1418');      // the groove between ridges
      }
    }
    px(dx0, dTop, 1, dBot - dTop, r.ink);                         // cage uprights, drawn OVER the glass
    px(dx0 + dw - 1, dTop, 1, dBot - dTop, r.ink);
    if (active) {
      bloom(dx0, dTop + 1, dw, dBot - dTop - 2, G, 0.20 + 0.10 * Math.sin(now / 700));
      spill(x, dBot, w, G, 0.16, 4);                              // light pools down onto the base
    }

    /* ---- CAP: vented, and wider than the drum so the stack steps OUT at the top ---- */
    px(x, y, w, 4, r.ink);
    px(x + 1, y + 1, w - 2, 2, r.face);
    px(x + 1, y + 1, w - 2, 1, r.lit);
    px(x + 2, y + 1, 3, 1, r.hi);                                 // one specular chip
    for (let i = 0; i < 3; i++) px(x + 2 + i * 3, y + 2, 2, 1, r.ao);   // exhaust slots
    px(cx - 1, y - 2, 2, 2, r.ink); px(cx - 1, y - 2, 1, 2, r.mid);     // finial
  };
  F.connector_portal = (x,y,w,h,f) => {
    // Patch cabinet: three recessed sockets, removable plugs and a separate cable spine.
    // Connector state remains the only source for status light and activity.
    const r=EQUIPMENT,b=INSTRUMENT,base=y+h;
    const bound=!!(f&&f.bound), state=(f&&f.state)||'unbound';
    const online=bound&&state==='online', error=state==='error', fired=!!(f&&f.fired);
    const signal=error?ACC.alert:online?ACC.data:bound?shade(ACC.flow,-0.5):b.dk;
    shadow2(x+1,base-1,w-2);deckPlate(x,base-4,w,4);deckSocket(x+w+1,base-3,online);
    // Asymmetric carcass: socket bank on the left, narrower cable return on the right.
    chamf(x,y-7,9,28,b.ink,1);panelFinish(x+1,y-6,7,26,b);
    px(x+1,y-7,6,2,r.top);px(x+2,y-7,4,1,r.lit);
    px(x+9,y-3,3,24,b.ink);px(x+10,y-2,1,21,r.face);
    px(x+2,y-4,4,2,b.ao);px(x+2,y-4,3,1,signal);
    for(let k=0;k<3;k++){
      const sy=y+k*6;
      // Raised rectangular bezel surrounds a black socket, with a protruding plug body.
      px(x+1,sy,7,5,r.ink);px(x+1,sy,7,1,r.mid);px(x+2,sy+1,5,3,b.ao);
      if(bound){
        // Plug projects beyond its recessed socket and returns into the cable duct.
        px(x+3,sy+2,3,2,r.face);px(x+3,sy+2,2,1,r.mid);
        px(x+5,sy+3,2,1,r.dk);px(x+7,sy+3,3,1,b.ink);
        px(x+9,sy+3,1,3,r.dk);px(x+10,sy+4,1,2,r.mid);
      }else{
        // Empty sockets stay visibly empty until this prop is bound to a connector.
        px(x+3,sy+2,3,2,b.ao);px(x+3,sy+2,2,1,b.dk);
        px(x+4,sy+3,1,1,r.face);
      }
      px(x+2,sy+3,1,1,online?shade(ACC.data,-0.2):b.dk);
    }
    px(x+2,y+18,5,2,r.ao);px(x+2,y+18,5,1,r.face);
    captiveBolt(x+1,base-3,r);captiveBolt(x+8,base-3,r);
    if(online&&fired){px(x+2,y-4,4,1,'#dcfaff');bloom(x+2,y-4,4,1,ACC.data,0.16);}
  };  F.workbench = (x, y, w, h, f) => {
    /* v45 WORKBENCH (2x1) — TERMINAL: shell.exec + verify.run. It is the one COMPUTE-adjacent prop
       with NO chair and NO screen-on-a-stand, because you STAND at it and work with your hands.
       ⛔ NO CHAIR IS THE SILHOUETTE. Six workstations in the catalog all have a seat behind them;
          this one has an open front and a tool wall above it, and that alone separates it.
       ⛔ THE PEGBOARD IS THE HERO — a dark perforated panel with countable tools hung on it. Tools
          read by OUTLINE (a hammer head, a wrench fork, a driver shaft), never by detail.
       ⛔ o.fired / o.bad drive a pulse when shell or verify actually runs — green for a pass, red for
          a fail. The bench must never claim work the harness has not done. */
    const r = EQUIPMENT, b = INSTRUMENT, br = MAT.brass, on = !!f.work;
    const fired = f && f.fired, bad = f && f.bad;
    const G = ACC.work, R2 = ACC.alert;

    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, on);

    /* ---- legs + a lower stock shelf (no chair, so the underside is storage) ---- */
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 6, 3, 6, r.ink);
      px(lx, y + 6, 1, 6, r.face); px(lx + 1, y + 6, 1, 6, r.dk);
    }
    px(x + 3, y + 9, w - 6, 2, r.ink);
    px(x + 4, y + 9, w - 8, 1, r.mid);
    for (const bx of [x + 5, x + 12, x + 17] ) { px(bx, y + 7, 4, 2, r.ink); px(bx + 1, y + 7, 2, 1, r.face); }

    /* ---- the top: a thick worktop, scarred and lit ---- */
    chamf(x - 1, y - 3, w + 2, 9, r.ink, 2);
    px(x, y - 2, w, 2, r.top); px(x + 2, y - 2, 5, 1, r.lit);
    px(x, y, w, 2, r.top);
    px(x + 7, y, 10, 2, b.dk); // insulating service mat below the hand tools
    px(x, y + 2, w, 2, r.face);
    px(x, y + 4, w, 1, r.dk);
    px(x, y - 1, 1, 5, r.mid); px(x + w - 1, y - 1, 1, 5, r.dk);
    px(x, y + 5, w, 1, r.face);

    /* ---- PEGBOARD tool wall ---- */
    equipmentApron(x, y + 3, w, r);
    px(x + 2,y,7,1,r.dk); px(x + 3,y - 1,5,1,r.top);
    const pT = y - 15, pH = 11;
    px(x + 1, pT, w - 2, pH, r.ink);
    px(x + 2, pT + 1, w - 4, pH - 2, b.ao);
    px(x + 2, pT + 1, w - 4, 1, b.mid);                            // its lit top rail
    for (let ry = 0; ry < 2; ry++) for (let rx = 0; rx < 6; rx++)
      px(x + 3 + rx * 3, pT + 4 + ry * 3, 1, 1, b.dk);        // the perforations
    // Uprights carry the board down to the bench rather than leaving it floating.
    for (const dx of [1, w - 3]) { px(x + dx, pT + pH, 2, 3, r.ink); px(x + dx, pT + pH, 1, 3, r.face); }
    // Tools, read by silhouette with matte ochre grips.
    px(x + 3, pT + 2, 1, 5, r.mid); px(x + 2, pT + 2, 3, 1, r.lit);        // driver
    px(x + 6, pT + 2, 1, 6, r.mid); px(x + 5, pT + 2, 3, 2, r.face);       // hammer
    px(x + 10, pT + 2, 1, 5, r.mid); px(x + 9, pT + 2, 1, 2, r.lit); px(x + 11, pT + 2, 1, 2, r.lit);   // wrench fork
    px(x + 14, pT + 3, 4, 1, r.face); px(x + 14, pT + 2, 1, 3, r.mid);     // square
    px(x + 18, pT + 2, 3, 4, r.ink); px(x + 19, pT + 3, 1, 2, br.mid);     // a clamp
    px(x + 3, pT + 8, 8, 2, r.ink); px(x + 4, pT + 8, 6, 1, r.face);       // a parts tray on the rail
    px(x + 13, pT + 8, 8, 2, r.ink); px(x + 14, pT + 8, 6, 1, r.top);

    px(x + 3, pT + 5, 1, 2, '#93774d');
    px(x + 6, pT + 5, 1, 3, '#786347');
    px(x + 10, pT + 5, 1, 2, r.top);

    /* ---- ON THE TOP: a vice, a soldering iron in its stand, a test lamp ---- */
    px(x + 2, y - 4, 5, 4, r.ink);                                  // vice body
    px(x + 3, y - 3, 3, 2, r.mid); px(x + 3, y - 3, 3, 1, r.lit);
    px(x + 3, y - 4, 1, 1, br.mid);                                 // its brass screw
    px(x + 10, y - 3, 6, 3, b.ink);                                 // soldering stand
    px(x + 11, y - 2, 4, 1, b.face);
    px(x + 13, y - 5, 1, 3, r.mid); px(x + 13, y - 6, 1, 1, fired && !bad ? '#ffd0a0' : r.dk);
    px(x + 18, y - 3, 4, 3, b.ink); px(x + 19, y - 2, 2, 1, b.top);  // a meter
    px(x + 19, y - 2, 1, 1, on ? G : shade(G, -0.66));

    /* ---- TRUTHFUL PULSE: only when shell/verify really fired ---- */
    if (fired) {
      const c = bad ? R2 : G;
      px(x + 2, y + 5, w - 4, 1, c);
      bloom(x + 2, y + 3, w - 4, 3, c, 0.30);
      spill(x + 2, y + 6, w - 4, c, 0.22, 4);
    } else if (on) {
      px(x + 2, y + 5, 6, 1, shade(G, -0.30));
      bloom(x + 2, y + 5, 6, 1, G, 0.12);
    }
  };
  F.etsy_threadrack = (x, y, w, h, f) => { // v4 spool rack (2x1) — freestanding; thread stays MATTE, the feed eye tells
    const r = RAMP.gun, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 4]) {                     // stub legs
      px(lx - 1, y + 8, 4, 4, LINE);
      px(lx, y + 8, 1, 3, r.lit); px(lx + 1, y + 8, 1, 3, r.dk);
      rimEdge(lx + 1, y + 9, 1, 2, 0.16);
      px(lx, y + h - 1, 2, 1, r.ao);
    }
    underAO(x + 4, y + 8, w - 8, 2);
    cable(x + 4, y + 9, x + w - 5, y + 9, 1.6, '#171d1a');     // slack lead slung under the rack
    // short face rail: spool ends seen edge-on
    chamf(x, y + 4, w, 5, LINE, 1);
    px(x + 1, y + 5, w - 2, 3, r.face);
    px(x + 1, y + 5, w - 2, 1, r.lit); keyEdge(x + 2, y + 5, w - 6, 1, 0.15);
    px(x + w - 2, y + 6, 1, 2, r.dk); rimEdge(x + w - 2, y + 6, 1, 2, 0.20);
    px(x + 1, y + 7, w - 2, 1, r.ao);
    for (let i = 0; i < 3; i++) {
      const fx2 = x + 4 + i * 6, c = i === 1 ? '#d8cdb8' : '#e0a256';
      rr(fx2, y + 5, 3, 3, shade(c, -0.30));
      px(fx2 + 1, y + 5, 1, 1, shade(c, 0.08)); px(fx2 + 1, y + 6, 1, 1, '#141a1e');   // hub
    }
    const per = on ? 900 : 1800;                               // feed LED runs hot on a live job (kept both rates)
    px(x + w - 3, y + 6, 1, 1, blink(per) ? ACC.flow : '#28323a');
    if (blink(per)) bloom(x + w - 3, y + 6, 1, 1, ACC.flow, 0.24);
    // chamfered top tray
    chamf(x - 1, y - 3, w + 2, 8, LINE, 2);
    chamf(x, y - 2, w, 6, r.top, 1);
    px(x + 2, y - 2, w - 4, 1, r.sheen); keyEdge(x + 2, y - 2, 8, 1, 0.26);
    px(x, y - 1, 1, 4, r.lit); px(x + w - 1, y - 1, 1, 4, r.dk); rimEdge(x + w - 1, y - 1, 1, 4, 0.20);
    px(x + 1, y + 3, w - 2, 1, shade(r.top, -0.18));
    // upright spools: wound thread reads by BANDING, not by a sheen row — it is fibre, not plastic
    const cols2 = ['#e0a256', '#d8a86a', '#d8cdb8', '#c98a3a'];
    for (let i = 0; i < 4; i++) {
      const sx2 = x + 2 + i * 5, c = cols2[(i + (U.hash('threadrack') % 2)) % cols2.length];   // kept hash seed
      rr(sx2 - 1, y - 5, 6, 6, LINE);
      px(sx2, y, 4, 1, shade(c, -0.40));                     // base flange under the winding
      rr(sx2, y - 4, 4, 4, shade(c, -0.12));
      px(sx2 + 1, y - 4, 2, 1, shade(c, 0.22));
      for (let j = 0; j < 2; j++) px(sx2, y - 3 + j, 4, 1, shade(c, j ? -0.22 : 0.06));
      px(sx2 + 1, y - 3, 1, 1, '#141a1e');                     // hub hole
      px(sx2 + 3, y - 3, 1, 2, shade(c, -0.36));             // shaded east of the reel
      if (i === 1 || i === 3) px(sx2 + 1, y + 1, 1, 3, shade(c, -0.06));   // dangling tails (kept)
    }
    // a real THREAD PATH: one strand off the west spool up through a guide eye — says what the rack is FOR
    const guide = x + w - 6;
    px(guide, y - 8, 3, 3, LINE); px(guide, y - 8, 3, 1, r.top); px(guide + 1, y - 7, 1, 1, '#0e1311');
    keyEdge(guide, y - 8, 2, 1, 0.22);
    cable(x + 4, y - 3, guide + 1, y - 7, -1.8, shade('#e0a256', -0.18));
    if (on) px(x + 5 + Math.floor((now / 260 + ph) % 8), y - 4, 1, 1, shade('#e0a256', 0.24));  // the strand feeding
  };
  F.etsy_dyevat = (x, y, w, h, f) => { // v4 dye vat (2x2) — bolted bath: dark body, LIT MENISCUS, dye light up the rim
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x, y + 16, w, h - 16);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 4, y + 15, x + w + 2, y + h - 3, 2);
    // rounded drum — warm key down the west curve, cool sky bounce down the east
    chamf(x, y + 4, w, 13, LINE, 2);
    px(x + 1, y + 5, w - 2, 11, r.face);
    px(x + 1, y + 5, 2, 11, r.lit); keyEdge(x + 1, y + 6, 1, 8, 0.18);
    px(x + w - 3, y + 5, 2, 11, r.dk); rimEdge(x + w - 3, y + 6, 1, 8, 0.22);
    px(x + 2, y + 15, w - 4, 1, r.ao);
    px(x + 1, y + 10, w - 2, 1, shade(r.face, -0.28));       // drum hoop (kept)
    px(x + 1, y + 11, w - 2, 1, shade(r.face, 0.10));
    knurl(x + 3, y + 7, 7, 1, r.face);
    // the heating jacket leaks along a seam, hottest west of centre where the element sits
    const warm = on ? 0.44 + 0.18 * Math.sin(now / 400 + ph) : 0.15;
    for (let i = 0; i < w - 6; i++) {
      const a = warm * (0.28 + 0.72 * Math.exp(-Math.abs(i - (w - 6) * 0.38) / 5));
      ctx.globalAlpha = Math.max(0, Math.min(0.8, a)); px(x + 3 + i, y + 13, 1, 1, '#c9701a');
    }
    ctx.globalAlpha = 1;
    px(x + 2, y + 13, 5, 3, LINE); px(x + 3, y + 14, 3, 1, '#1b2422');    // control nub (kept)
    px(x + 4, y + 14, 1, 1, blink(900) ? ACC.work : '#16302a');
    if (blink(900) && on) bloom(x + 4, y + 14, 1, 1, ACC.work, 0.24);
    // the OVAL RIM + dye bath dominate the top
    const cx2 = x + w / 2, cy2 = y + 4;
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2, 7.5, 0, 0, 6.2832); ctx.fillStyle = LINE; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2 - 1, 6.5, 0, 0, 6.2832); ctx.fillStyle = r.top; ctx.fill();
    ctx.globalAlpha = 0.85; ctx.strokeStyle = r.sheen; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.5, w / 2 - 2.5, 5.5, 0, Math.PI * 1.02, Math.PI * 1.98); ctx.stroke();
    ctx.globalAlpha = 0.30; ctx.strokeStyle = SKY;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.5, w / 2 - 2.5, 5.5, 0, Math.PI * 0.08, Math.PI * 0.92); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2 - 3, 4.6, 0, 0, 6.2832); ctx.fillStyle = '#1c110c'; ctx.fill(); // dark body
    ctx.globalAlpha = on ? 0.44 : 0.20; ctx.strokeStyle = '#ff9d2e'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.4, w / 2 - 3.6, 4.0, 0, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.globalAlpha = 1;                                        // ^ the bath lighting the far inner wall
    // concentric dye rings core->rim (kept hues), darker at the edge so the bath has depth
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.4, w / 2 - 4, 3.8, 0, 0, 6.2832); ctx.fillStyle = on ? '#c9701a' : '#8a5016'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.4, w / 2 - 5.5, 3, 0, 0, 6.2832); ctx.fillStyle = shade(on ? '#c9701a' : '#8a5016', 0.16); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.3, w / 2 - 7, 2.2, 0, 0, 6.2832); ctx.fillStyle = on ? '#ff9d2e' : '#a8641e'; ctx.fill();
    ctx.globalAlpha = 0.75; ctx.strokeStyle = '#ffd9a0'; ctx.lineWidth = 1;   // LIT MENISCUS on the near lip
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.4, w / 2 - 4.4, 3.3, 0, Math.PI * 0.12, Math.PI * 0.88); ctx.stroke();
    const rp = now / 1400;                                      // drifting ripples (kept)
    ctx.globalAlpha = 0.5; ctx.strokeStyle = shade('#ff9d2e', 0.30);
    for (let i = 0; i < 3; i++) {
      const cr = (w / 2 - 6) * (0.35 + i * 0.22) + Math.sin(rp + i + ph) * 0.6;
      ctx.beginPath();
      ctx.ellipse(cx2, cy2 + 0.4, cr, cr * 0.4, 0, Math.PI * (0.9 + i * 0.15), Math.PI * (1.7 + i * 0.15));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const bt = (now / 2600) % 1;                                // surfacing bubble (kept)
    if (bt < 0.6) {
      const by3 = Math.round(cy2 - bt * 2);
      px(Math.round(cx2 - 3), by3, 1, 1, shade('#ff9d2e', 0.40));
      if (bt > 0.4) px(Math.round(cx2 - 3), by3, 1, 1, '#ffeccc');
    }
    ctx.restore();
    bloom(x + 4, y, w - 8, 7, '#ff9d2e', (on ? 0.14 : 0.07) + 0.04 * Math.sin(now / 800 + ph));  // pool glow (kept)
    // dip-arm over the east rim, holding a half-submerged swatch that is STAINED below the waterline
    px(x + w - 7, y - 5, 5, 3, LINE); px(x + w - 6, y - 4, 3, 1, shade('#5a665e', 0.24));
    keyEdge(x + w - 6, y - 4, 2, 1, 0.22);
    px(x + w - 6, y - 2, 2, 3, '#4a544d'); px(x + w - 6, y - 2, 1, 3, shade('#4a544d', 0.18));
    px(x + w - 8, y + 1, 3, 2, '#4a544d');
    px(x + w - 12, y + 1, 5, 2, '#e0e4de'); px(x + w - 12, y + 1, 5, 1, '#f2f4ee');   // clean cloth above
    px(x + w - 12, y + 3, 5, 1, '#d8945a'); px(x + w - 11, y + 4, 3, 1, '#c9701a');   // stained below
    glow(x + w - 12, y + 3, 5, 2, '#ff9d2e', on ? 0.20 : 0.08);
  };
  F.etsy_kiln = (x, y, w, h, f) => { // v4 kiln (2x2) — firelight LEAKS from the lid seam and door gap, never a flat disc
    const r = RAMP.gun, on = !!(f && f.work), ph = (f && f.x) || 0;
    const breath = 0.5 + 0.5 * Math.sin(now / 1000 + ph);      // breathing heat (kept 1000)
    const heat = (on ? 0.58 : 0.24) + 0.28 * breath;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x, y + 16, w, h - 16);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 4, y + 15, x + w + 2, y + h - 3, 2);
    // short front face carrying the CHARGING DOOR — a hinged plate whose gap leaks light down one edge
    chamf(x - 1, y + 10, w + 2, 7, LINE, 2);
    px(x, y + 11, w, 5, r.face);
    px(x, y + 11, w, 1, r.lit); keyEdge(x + 1, y + 11, w - 5, 1, 0.15);
    px(x + w - 1, y + 12, 1, 3, r.dk); rimEdge(x + w - 1, y + 12, 1, 3, 0.20);
    px(x, y + 15, w, 1, r.ao);
    px(x + 2, y + 11, 10, 5, shade(r.face, -0.10));          // the door plate
    px(x + 2, y + 11, 1, 5, shade(r.face, 0.16));            // hinge stile
    px(x + 11, y + 12, 1, 3, shade(r.face, -0.45));          // latch stile
    for (let i = 0; i < 3; i++) {                              // grille in the door — heat behind each slit (kept)
      px(x + 4 + i * 3, y + 14, 2, 1, '#141a17');
      glow(x + 4 + i * 3, y + 14, 2, 1, '#ff7a1a', heat * 0.26);
    }
    px(x + 5, y + 12, 3, 1, shade(r.face, 0.10)); px(x + 5, y + 13, 3, 1, shade(r.face, -0.5)); // handle
    for (let j = 0; j < 4; j++) {                              // the DOOR GAP, hottest at the top of the seam
      ctx.globalAlpha = Math.min(0.85, heat * (0.95 - j * 0.19));
      px(x + 12, y + 12 + j, 1, 1, j < 2 ? '#ffd34a' : '#ff7a1a');
      ctx.globalAlpha = 1;
    }
    bloom(x + 12, y + 12, 1, 4, '#ff7a1a', heat * 0.24);
    inset(x + w - 9, y + 12, 7, 3, '#191e1b');                 // 3-seg readout (kept, breath-tied)
    for (let s = 0; s < 3; s++) px(x + w - 8 + s * 2, y + 13, 1, 1, breath > s / 3.2 ? ACC.flow : '#28323a');
    // big refractory dome
    chamf(x - 1, y - 3, w + 2, 14, LINE, 2);
    chamf(x, y - 2, w, 12, r.top, 2);
    px(x + 2, y - 2, w - 4, 1, r.sheen); keyEdge(x + 2, y - 2, 8, 1, 0.28);
    px(x, y, 1, 8, r.lit); px(x + w - 1, y, 1, 8, r.dk); rimEdge(x + w - 1, y, 1, 8, 0.20);
    px(x + 1, y + 9, w - 2, 1, shade(r.top, -0.18));
    chamf(x + 2, y - 1, w - 4, 9, shade(r.top, 0.08), 2);    // dome step
    px(x + 3, y - 1, w - 6, 1, shade(r.top, 0.20));
    px(x + 2, y - 2, 1, 1, shade(r.top, 0.30)); px(x + w - 3, y - 2, 1, 1, shade(r.top, 0.30)); // dome bolts (kept)
    wear(x + 3, y + 4, w - 6, 4, 3, shade(r.top, -0.12));
    // the LID: a seated ring. Light escapes at the SEAM (a crescent, hottest west) and through the spy-hole.
    const cx2 = x + w / 2, cy2 = y + 4, R2 = 6;
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, R2 + 1.4, R2 * 0.72 + 1.2, 0, 0, 6.2832); ctx.fillStyle = LINE; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, R2 + 0.4, R2 * 0.72 + 0.4, 0, 0, 6.2832); ctx.fillStyle = shade(r.top, -0.20); ctx.fill();
    ctx.globalAlpha = 0.9; ctx.strokeStyle = r.sheen; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.4, R2, R2 * 0.72, 0, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.globalAlpha = 0.30; ctx.strokeStyle = SKY;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.4, R2, R2 * 0.72, 0, Math.PI * 0.10, Math.PI * 0.90); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.ellipse(cx2, cy2, R2 - 1.2, R2 * 0.72 - 1.0, 0, 0, 6.2832); ctx.fillStyle = shade(r.top, 0.06); ctx.fill();
    ctx.globalAlpha = Math.min(0.9, heat); ctx.strokeStyle = '#ff7a1a'; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.2, R2 - 0.6, R2 * 0.72 - 0.5, 0, Math.PI * 0.85, Math.PI * 2.05); ctx.stroke();
    ctx.globalAlpha = Math.min(0.8, heat * 0.7); ctx.strokeStyle = '#ffd34a';
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.2, R2 - 0.6, R2 * 0.72 - 0.5, 0, Math.PI * 1.10, Math.PI * 1.60); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.ellipse(cx2 + 1, cy2, 2.2, 1.6, 0, 0, 6.2832); ctx.fillStyle = '#2a1408'; ctx.fill();  // spy-hole
    ctx.beginPath(); ctx.ellipse(cx2 + 1, cy2, 1.6, 1.1, 0, 0, 6.2832); ctx.fillStyle = on ? '#ff7a1a' : '#8a3d10'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2 + 1, cy2, 0.8, 0.6, 0, 0, 6.2832); ctx.fillStyle = on ? '#ffd34a' : '#b0561a'; ctx.fill();
    ctx.restore();
    px(Math.round(cx2) - 5, Math.round(cy2) - 1, 3, 1, shade(r.top, 0.24));   // lid handle
    px(Math.round(cx2) - 5, Math.round(cy2), 3, 1, shade(r.top, -0.34));
    bloom(Math.round(cx2) - 5, Math.round(cy2) - 3, 10, 6, '#ff9d2e', heat * 0.20);
    spill(x + 3, y + 8, w - 6, '#ff9d2e', heat * 0.13, 3);     // seam light washing down the dome's front
    // vent stack on the west shoulder, shimmer rising off it (kept 420)
    chamf(x + 1, y - 7, 6, 6, LINE, 1);
    px(x + 2, y - 6, 4, 4, shade(r.face, 0.06)); px(x + 2, y - 6, 4, 1, r.top);
    keyEdge(x + 2, y - 6, 3, 1, 0.24);
    px(x + 5, y - 5, 1, 3, r.dk); rimEdge(x + 5, y - 5, 1, 3, 0.20);
    px(x + 3, y - 5, 2, 2, '#0e1311');                         // the flue's dark mouth
    glow(x + 3, y - 5, 2, 2, '#ff7a1a', heat * 0.30);
    if (blink(420)) px(x + 3, y - 9, 1, 1, '#6a7882');
    else if (blink(420, 0.5)) px(x + 4, y - 10, 1, 1, '#46525a');
    px(x + 4, y - 8, 1, 1, shade('#6a7882', -0.35));
  };
  F.etsy_packbot = (x, y, w, h, f) => { // v4 pack bot (2x2) — a machine with INTENT: head, shoulder, elbow, a working dip
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    const seg = (x0, y0, x1, y1, c) => { cable(x0, y0 + 1, x1, y1 + 1, 0, LINE); cable(x0, y0, x1, y1, 0, c); }; // 2px linkage
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x, y + 15, w, h - 15);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 4, y + 14, x + w + 2, y + h - 3, 2);
    // short front face: vents + the run lamp (kept 420)
    chamf(x - 1, y + 9, w + 2, 7, LINE, 2);
    px(x, y + 10, w, 5, r.face);
    px(x, y + 10, w, 1, r.lit); keyEdge(x + 1, y + 10, w - 5, 1, 0.15);
    px(x + w - 1, y + 11, 1, 3, r.dk); rimEdge(x + w - 1, y + 11, 1, 3, 0.20);
    px(x, y + 14, w, 1, r.ao);
    for (let i = 0; i < 4; i++) { px(x + w - 11 + i * 2, y + 12, 1, 2, r.ao); px(x + w - 10 + i * 2, y + 12, 1, 2, shade(r.face, 0.12)); }
    if (on) {
      px(x + 3, y + 11, 2, 2, blink(420) ? '#ffb43a' : '#28323a');
      if (blink(420)) bloom(x + 3, y + 11, 2, 2, '#ff9d2e', 0.28);
    } else {
      px(x + 3, y + 11, 2, 2, '#28323a'); px(x + 3, y + 11, 1, 1, '#36424c');
      px(x + 4, y + 12, 1, 1, blink(1800, ph) ? shade(ACC.flow, -0.25) : '#33241a');   // standby heartbeat
    }
    // top work deck
    chamf(x - 1, y - 2, w + 2, 13, LINE, 2);
    chamf(x, y - 1, w, 11, r.top, 2);
    px(x + 2, y - 1, w - 4, 1, r.sheen); keyEdge(x + 2, y - 1, 8, 1, 0.28);
    px(x, y + 1, 1, 7, r.lit); px(x + w - 1, y + 1, 1, 7, r.dk); rimEdge(x + w - 1, y + 1, 1, 7, 0.20);
    px(x + 1, y + 9, w - 2, 1, shade(r.top, -0.18));
    for (let i = 0; i < 4; i++) { px(x + 1, y + 1 + i * 2, 3, 1, shade(r.top, -0.34)); px(x + 1, y + 2 + i * 2, 3, 1, shade(r.top, 0.08)); } // feed rollers
    // the shipping case on the deck (kept: flap seam, label, barcode)
    const bx = x + 6, by2 = y, bw = 12, bh = 8;
    chamf(bx - 1, by2 - 1, bw + 2, bh + 2, LINE, 1);
    px(bx, by2, bw, bh, '#36424c');
    px(bx, by2, bw, 1, shade('#36424c', 0.24)); keyEdge(bx + 1, by2, 5, 1, 0.16);
    px(bx, by2, 1, bh, shade('#36424c', 0.10));
    px(bx + bw - 1, by2 + 1, 1, bh - 1, shade('#36424c', -0.30)); rimEdge(bx + bw - 1, by2 + 1, 1, bh - 1, 0.18);
    px(bx, by2 + bh - 1, bw, 1, shade('#36424c', -0.34));
    px(bx + (bw >> 1), by2 + 1, 1, bh - 2, '#28323a');         // half-open flap seam
    px(bx + 1, by2 + 2, (bw >> 1) - 1, 1, '#46525a');          // sealed-side catch
    px(bx + 1, by2 + 1, 5, 5, '#e08a28'); px(bx + 1, by2 + 1, 5, 1, shade('#e08a28', 0.24)); // label
    px(bx + 2, by2 + 4, 3, 1, '#1a2228'); px(bx + 2, by2 + 5, 3, 1, '#1a2228');                // barcode
    // ---- the ARM. Idle it parks raised with the head watching; working it reaches, DIPS into the case,
    // pinches shut and lifts. This is the family's one prop with agency, so the motion has to carry it.
    const cyc = on ? (now / 2400 + ph * 0.17) % 1 : 0;
    const dip = on ? Math.max(0, Math.sin(cyc * 6.2832)) : 0;             // 0 raised, 1 deep in the case
    const reach = on ? 0.35 + 0.65 * (0.5 - 0.5 * Math.cos(cyc * 6.2832)) : 0.12;
    const shX = x + w - 5, shY = y - 6;
    const elX = Math.round(shX - 5 - reach * 3), elY = Math.round(shY + 1 + dip * 2);
    const gpX = Math.round(bx + 3 + reach * 4), gpY = Math.round(shY + 3 + dip * 6);
    px(shX - 2, shY, 4, 12, LINE);                                        // mast planted in the deck
    px(shX - 1, shY + 1, 1, 10, '#5f6d64'); px(shX, shY + 1, 1, 10, '#3a423c');
    rimEdge(shX, shY + 2, 1, 8, 0.18);
    px(shX - 2, shY - 2, 5, 3, LINE); px(shX - 1, shY - 1, 3, 1, '#6e7a70'); keyEdge(shX - 1, shY - 1, 2, 1, 0.24);
    seg(shX - 1, shY + 2, elX, elY, '#5f6d64');                           // upper arm
    seg(elX, elY, gpX, gpY, '#54615a');                                   // forearm
    px(elX - 1, elY - 1, 3, 3, LINE); px(elX, elY, 1, 1, '#7d8a80');      // elbow puck
    const grip = dip > 0.72 ? 0 : 1;                                      // fingers PINCH at the bottom of the dip
    px(gpX - 3, gpY - 1, 7, 3, LINE);
    px(gpX - 2, gpY, 5, 1, shade('#6b766e', 0.12));
    px(gpX - 2 - grip, gpY + 2, 1, 2, '#8a968e'); px(gpX + 2 + grip, gpY + 2, 1, 2, '#8a968e');
    px(gpX - 2 - grip, gpY + 3, 1, 1, '#3a423c'); px(gpX + 2 + grip, gpY + 3, 1, 1, '#3a423c');
    if (on && dip > 0.72) { px(gpX - 1, gpY + 3, 3, 1, shade(ACC.work, -0.20)); bloom(gpX - 1, gpY + 3, 3, 1, ACC.work, 0.24); }
    // HEAD on the mast: a sensor pod whose EYE tracks the gripper — the tell that it is paying attention
    const hx = shX - 5, hy = shY - 6;
    chamf(hx - 1, hy - 1, 9, 7, LINE, 1);
    px(hx, hy, 7, 5, shade(r.face, 0.04)); px(hx, hy, 7, 1, r.top); keyEdge(hx, hy, 4, 1, 0.26);
    px(hx + 6, hy + 1, 1, 4, r.dk); rimEdge(hx + 6, hy + 1, 1, 4, 0.20);
    inset(hx + 1, hy + 1, 5, 3, '#0b1a1e');
    const look = on ? Math.round(-1 + reach * 2) : 0;
    px(hx + 2 + look, hy + 2, 2, 1, on ? '#9fe8ff' : shade(ACC.data, -0.55));
    if (on) bloom(hx + 2 + look, hy + 2, 2, 1, ACC.data, 0.30);
    px(hx + 3, hy - 2, 1, 2, r.face); px(hx + 3, hy - 3, 1, 1, blink(1200, ph) ? ACC.flow : '#33241a'); // status whip
    cable(hx + 7, hy + 4, shX - 1, shY + 1, 1.2, '#141b20');              // umbilical into the mast
    if (on) {
      const sweep = bx + Math.floor(((now / 900) % 1) * bw);              // scan sweep (kept 900)
      px(sweep, by2, 1, bh, '#cffcff');
      bloom(sweep - 1, by2, 3, bh, ACC.data, 0.24);
      spill(bx, by2 + bh, bw, ACC.data, 0.16, 3);                         // scan light pools onto the deck
      if (cyc > 0.78) px(bx + (bw >> 1) - 1, by2, 3, bh, shade('#d8d0c0', -0.10));   // tape laid down the seam
    }
  };
  F.gigs_thumbwall = (x, y, w, h, f) => {
    /* v68 THUMB WALL (2x1) — improved. It stays a SHALLOW wall-hung rail (agents walk in front of it,
       so it must not claim depth), but the pinned work now reads as pinned work.
       ⛔ CARDS ARE PINNED, NOT PRINTED. Each thumbnail sits at its own tiny offset with a pin head and a
          cast shadow under it. A grid of flush rectangles is a screen; a ragged grid with shadows is a
          corkboard, and that difference is the whole prop.
       ⛔ THE RAIL IS THE FRAME. A lit top rail on two brackets, a dark cork field behind, and a lower
          lip — without the lip the cards look glued to the wall.
       ⛔ ONE VIOLET STATUS LED, kept from the shipped prop: this is a memory-side surface and that is
          the accent the catalog uses for it. Nothing else here claims a live state. */
    const EDGE = '#161d22';
    const r = MAT ? MAT.steel : RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const CORK = '#3a2c1e', CORK_D = '#241a11';
    const bt = y - 4, bh = 14;

    shadow2(x + 2, y + h - 1, w - 4);

    /* ---- BRACKETS the rail hangs on ---- */
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, bt - 2, 3, 3, EDGE);
      px(lx, bt - 1, 2, 2, r.face); px(lx, bt - 1, 1, 2, r.lit);
    }

    /* ---- RAIL BODY: lit top, cork field, lower lip ---- */
    chamf(x - 1, bt - 1, w + 2, bh + 2, EDGE, 1);
    px(x, bt, w, bh, r.face);
    px(x, bt, w, 1, r.lit); keyEdge(x + 1, bt, 9, 1, 0.24);
    px(x, bt + 1, 1, bh - 1, r.lit); px(x + w - 1, bt + 1, 1, bh - 1, r.dk);
    rimEdge(x + w - 1, bt + 2, 1, bh - 4, 0.18);
    px(x + 1, bt + 2, w - 2, 9, CORK_D);                            // the cork field
    px(x + 1, bt + 2, w - 2, 1, '#0e0a06');                         // its top occlusion
    for (let i = 0; i < 8; i++) {                                   // cork speckle, sparse
      const k = U.hash('tw' + x + i);
      px(x + 2 + (k % (w - 4)), bt + 3 + ((k >>> 5) % 8), 1, 1, CORK);
    }

    /* ---- SIX PINNED CARDS, each at its own offset with a pin and a shadow ---- */
    const CARD = ['#7fb2d8', '#d8cfae', '#b98ad8', '#d8cfae', '#8ec4a8', '#d8b96a'];
    for (let i = 0; i < 6; i++) {
      const c0 = i % 3, r0 = (i / 3) | 0;
      const k = U.hash('tc' + x + i);
      const cx0 = x + 2 + c0 * 7 + (k % 2), cy0 = bt + 3 + r0 * 4 + ((k >>> 4) % 2);
      px(cx0 + 1, cy0 + 1, 5, 3, '#0d0906');                        // the card's cast shadow
      px(cx0, cy0, 5, 3, CARD[i]);
      px(cx0, cy0, 5, 1, shade(CARD[i], 0.24));                   // its lit top edge
      px(cx0 + 4, cy0 + 1, 1, 2, shade(CARD[i], -0.34));          // shaded east flank
      px(cx0 + 1, cy0 + 1, 3, 1, shade(CARD[i], -0.20));          // a line of writing on it
      px(cx0 + 2, cy0, 1, 1, i & 1 ? '#c05a4a' : '#4a8ac0');        // the pin head
    }

    /* ---- LOWER LIP + the violet status LED ---- */
    px(x + 1, bt + 11, w - 2, 1, r.mid);
    px(x + 1, bt + 12, w - 2, 1, r.dk);
    px(x + 2, bt + bh - 3, 1, 1, blink(700, ph) ? ACC.mem : '#3a2050');
    if (blink(700, ph)) bloom(x + 2, bt + bh - 3, 1, 1, ACC.mem, 0.26);
    if (on) spill(x + 2, bt + bh, w - 4, ACC.mem, 0.10, 3);
    px(x + 2, y + h - 1, w - 4, 1, '#0a0d10');
  };
  F.gigs_servercart = (x, y, w, h, f) => {
    /* v44 SERVER CART (1x1) — the third MEMORY prop, and the smallest thing in the capability set.
       ⛔ AT 1x1 EVERYTHING IS SILHOUETTE. Twelve pixels wide buys exactly THREE ideas, and they have
          to be outline ideas: a PUSH HANDLE breaking the top, COUNTABLE BLADES in the middle, and
          CASTORS breaking the bottom. Surface texture, grain and labels all cost pixels the outline
          needs and give nothing back.
       ⛔ THE HANDLE IS WHAT MAKES IT A CART. Without it this is a tiny cabinet and it duplicates the
          core; with it, it is the only wheeled thing in the family. */
    const r = EQUIPMENT, br = MAT.brass, on = !!(f && f.work);
    const base = y + h;
    const M = ACC.mem;

    shadow2(x + 2, base - 1, w - 4);
    deckPlate(x + 1, base - 3, w - 2, 3);
    deckSocket(x + w + 1, base - 3, on);

    /* ---- PUSH HANDLE: a U breaking the top outline ---- */
    px(x + 2, y - 6, 8, 2, r.ink);
    px(x + 3, y - 5, 6, 1, r.lit);
    px(x + 2, y - 4, 2, 3, r.ink); px(x + 8, y - 4, 2, 3, r.ink);
    px(x + 2, y - 4, 1, 3, r.mid); px(x + 9, y - 4, 1, 3, r.dk);

    /* ---- CHASSIS ---- */
    px(x + 1, y - 1, w - 2, 10, r.ink);
    px(x + 2, y, w - 4, 2, r.top);                                 // lit top plane
    px(x + 3, y, 3, 1, r.hi);
    panelFinish(x + 2, y + 2, w - 4, 6, r);
    px(x + 2, y + 2, 1, 6, r.mid); px(x + w - 3, y + 2, 1, 6, r.dk);

    /* ---- THREE COUNTABLE BLADES ---- */
    for (let k = 0; k < 3; k++) {
      const by = y + 3 + k * 2;
      px(x + 3, by, w - 6, 1, r.ao);                               // the reveal
      px(x + 3, by - 1, w - 6, 1, r.face);
      px(x + 3, by - 1, 2, 1, r.mid);                          // the blade face above it
      px(x + w - 5, by, 1, 1, blink(400 + k * 150, k) ? M : shade(M, -0.70));
    }
    if (on) bloom(x + w - 5, y + 3, 1, 5, M, 0.20);

    /* ---- CASTORS breaking the bottom outline ---- */
    px(x + 1, y + 9, 3, 3, r.ink); px(x + w - 4, y + 9, 3, 3, r.ink);
    px(x + 2, y + 10, 1, 1, r.mid); px(x + w - 3, y + 10, 1, 1, r.mid);
    px(x + 2, y + 11, 2, 1, br.dk); px(x + w - 4, y + 11, 2, 1, br.dk);
  };
  F.gigs_partsbin = (x, y, w, h, f) => {
    /* v68 PARTS BIN (2x1) — revamped. The old one was a flat dark tray with five colour chips in a row,
       which read as a control panel, not as storage.
       ⛔ IT HAS TO BE A TRAY YOU LOOK INTO. Four separate compartments, each a dark well with its own
          lit front sill and a divider between — the sills are what sell the depth at 24px wide.
       ⛔ COUNTABLE STOCK, NOT COLOUR CHIPS. Each bay holds 2-3 discrete parts of one kind, sitting at
          different heights. A stack you can count reads as inventory; a solid block reads as a light.
       ⛔ ONE SLANTED FRONT with a label strip. A bin's front face leans out toward you — that lean, plus
          a label, is what names the object before any contents resolve. */
    const EDGE = '#141a1f';
    const ST = '#4c565f', ST_L = '#707c85', ST_D = '#2c343b', ST_HI = '#98a3aa';
    const WELL = '#12171c';
    const bT = y - 6, bH = 14;

    shadow2(x + 1, y + h - 1, w - 2);

    /* ---- CARCASS ---- */
    chamf(x - 1, bT - 1, w + 2, bH + 2, EDGE, 1);
    px(x, bT, w, bH, ST_D);
    px(x, bT, w, 1, ST_L); keyEdge(x + 1, bT, 9, 1, 0.22);           // the rim we look over
    px(x, bT + 1, 1, bH - 1, ST_L); px(x + w - 1, bT + 1, 1, bH - 1, '#1e252b');
    rimEdge(x + w - 1, bT + 2, 1, bH - 4, 0.18);

    /* ---- FOUR COMPARTMENTS: dark well, lit front sill, divider ---- */
    const bays = [
      { c: '#4fbf7a', n: 3 },      // green clips
      { c: '#3fc0d8', n: 2 },      // cyan couplers
      { c: '#d08a3a', n: 3 },      // amber fasteners
      { c: '#a67fd8', n: 2 },      // violet cells
    ];
    for (let i = 0; i < 4; i++) {
      const bx = x + 1 + i * 6, bw = 5;
      px(bx, bT + 2, bw, 6, WELL);                                   // the well
      px(bx, bT + 2, bw, 1, '#080b0e');                              // its ceiling occlusion
      const b = bays[i];
      for (let k = 0; k < b.n; k++) {                                // countable stock, varied heights
        const px0 = bx + 1 + k * 2 - (b.n === 2 ? 0 : 1), ht = 2 + (k % 2);
        px(Math.max(bx, px0), bT + 8 - ht, 1, ht, shade(b.c, -0.24));
        px(Math.max(bx, px0), bT + 8 - ht, 1, 1, b.c);
      }
      px(bx, bT + 8, bw, 1, ST_L);                                   // the lit front sill
      px(bx, bT + 9, bw, 1, ST_D);
      if (i < 3) px(bx + bw, bT + 2, 1, 8, ST);                      // divider between bays
    }

    /* ---- SLANTED FRONT with a label strip ---- */
    px(x, bT + 10, w, 2, ST);
    px(x, bT + 10, w, 1, ST_L); keyEdge(x + 1, bT + 10, 8, 1, 0.18);
    px(x + 2, bT + 11, w - 8, 1, '#1a2026');                         // the label recess
    px(x + 3, bT + 11, 7, 1, '#8e9aa2');                             // its printed run
    px(x + w - 5, bT + 11, 2, 1, '#c9a24a');                         // the bin's colour tag
    px(x, bT + 12, w, 2, ST_D);
    px(x + 1, bT + 12, w - 2, 1, '#232a30');

    /* ---- STACKING LIP + feet ---- */
    px(x + 2, y + h - 2, 4, 1, ST_D); px(x + w - 6, y + h - 2, 4, 1, ST_D);
    underAO(x + 3, y + h - 3, w - 6, 2);
    px(x + 1, y + h - 1, w - 2, 1, '#080b0e');
    if (blink(2600, (f && f.x) || 0)) px(x + w - 3, bT + 1, 1, 1, '#5ad6ff');   // one quiet inventory tick
  };
  F.gigs_amp = (x, y, w, h, f) => {
    // AMP (1x1, blocks:true) — v4. Only 12px square, so it lives or dies on silhouette: the strap HANDLE
    // arching north off the crown is what names it as a cab before a single grille pixel resolves. The
    // movement is cone EXCURSION — the driver bulges and the purple backlight pumps on the beat, and while a
    // run is live two pressure rings break off the top. Kept: blink(360) bass throb, f.work power-lamp cycle.
    const r = RAMP.gun, ph = (f && f.x) || 0, on = !!(f && f.work);
    const beat = blink(360, ph);
    const exc = Math.max(0, Math.sin(now / 180 + ph));            // cone excursion 0..1
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 1, x + w - 3]) {                        // squat rubber feet
      px(lx, y + 9, 2, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 2, r.dk);
    }
    underAO(x + 3, y + 9, w - 6, 2);
    cable(x + w - 3, y + 8, x + w + 2, y + h - 1, 2);             // jack lead flopping onto the deck
    // strap handle — the whole read at 12px
    px(x + 3, y - 7, 6, 2, LINE); px(x + 4, y - 6, 4, 1, shade(r.top, 0.22));
    px(x + 3, y - 5, 1, 2, LINE); px(x + 8, y - 5, 1, 2, LINE);
    keyEdge(x + 4, y - 6, 3, 1, 0.26);
    // chamfered cab
    chamf(x - 1, y - 5, w + 2, 15, LINE, 2);
    chamf(x, y - 4, w, 13, r.face, 2);
    chamf(x + 1, y - 4, w - 2, 4, r.top, 2);                      // crown we look down on
    px(x + 2, y - 4, w - 4, 1, r.sheen); keyEdge(x + 2, y - 4, 5, 1, 0.30);
    px(x + 1, y - 1, w - 2, 1, shade(r.top, -0.20));            // crown front lip
    px(x, y + 1, 1, 6, r.lit); px(x + w - 1, y + 1, 1, 6, r.dk);
    rimEdge(x + w - 1, y + 1, 1, 6, 0.22);
    px(x + 1, y + 8, w - 2, 1, r.ao);
    // silver-piped grille cloth over the driver
    const gx = x + 2, gy = y + 1, gw = w - 4, gh = 6;
    px(gx - 1, gy - 1, gw + 2, gh + 2, '#8d938f');                // piping frame
    px(gx - 1, gy - 1, gw + 2, 1, '#b6bcb8'); px(gx - 1, gy - 1, 1, gh + 2, '#a4aaa6');
    rimEdge(gx + gw, gy, 1, gh, 0.22);
    inset(gx, gy, gw, gh, '#141416');
    for (let rj = 0; rj < gh; rj++) for (let c = 0; c < gw; c++)
      if (((rj + c) & 1) === 0) px(gx + c, gy + rj, 1, 1, beat ? '#3a2150' : '#232329');
    // the DRIVER itself pushing air — a lit dome that swells with the beat, not a flat backlight rect
    const rad = 1 + Math.round(exc * (beat ? 1.6 : 0.6));
    const dcx = gx + (gw >> 1), dcy = gy + (gh >> 1);
    px(dcx - rad, dcy - rad, rad * 2, rad * 2, shade(ACC.mem, -0.30));
    px(dcx - rad, dcy - rad, rad * 2, 1, shade(ACC.mem, 0.20));
    bloom(dcx - rad, dcy - rad, rad * 2, rad * 2, ACC.mem, (beat ? 0.30 : 0.14) + 0.14 * exc);
    spill(gx, gy + gh + 1, gw, ACC.mem, beat ? 0.14 : 0.06, 2);
    // pressure rings breaking off the cab while a run is live
    if (on) {
      ctx.save(); ctx.strokeStyle = ACC.mem; ctx.lineWidth = 1;
      for (let k = 0; k < 2; k++) {
        const t = ((now / 700) + k / 2) % 1;
        ctx.globalAlpha = 0.30 * (1 - t) * (1 - t);
        ctx.beginPath(); ctx.arc(dcx, y - 2, 3 + t * 11, -2.7, -0.45); ctx.stroke();
      }
      ctx.restore();
    }
    dial(x + 1, y - 4, r.top, now / 800 + ph);                    // gain
    dial(x + 5, y - 4, r.top, -now / 620 + ph);                   // tone
    const lamp = on ? blink(900, ph) : true;                      // kept: idle steady, live pulsing
    px(x + w - 3, y - 3, 1, 1, lamp ? '#ff6a4a' : '#3a1612');
    if (lamp) bloom(x + w - 3, y - 3, 1, 1, '#ff6a4a', 0.28);
  };
  F.treasury_coinsorter = (x, y, w, h, f) => {
    // COIN SORTER (2x1) — storage as MACHINE: the family shell (steel ramp, chamfered deck, hazard tick)
    // with a sorting bay milled into it. Left 2/3 = open bay where coin stacks jitter as they're counted;
    // right 1/3 = the counter tower. Wealth stays in the gold and the phosphor, never in the casing.
    // NOTE: the old counter passed U.shade an integer k (-10) — out of the -1..1 contract; fixed here.
    const cw = w, r = RAMP.steel, gold = ACC.flow, on = (f && f.work) ? 1 : 0.35;
    shadow2(x + 1, y + h - 1, cw - 2);
    // short front face
    rr(x, y + 4, cw, h - 5, LINE);
    px(x + 1, y + 5, cw - 2, h - 7, r.face);
    px(x + 1, y + 5, cw - 2, 1, r.lit); keyEdge(x + 2, y + 5, cw - 5, 1, 0.14);
    px(x + cw - 2, y + 5, 1, h - 7, r.dk); rimEdge(x + cw - 2, y + 5, 1, h - 7, 0.20);
    px(x + 2, y + h - 4, 2, 1, '#8a7434');                             // hazard tick
    px(x + 1, y + h - 3, cw - 2, 1, r.ao);
    // chamfered top deck
    chamf(x - 1, y - 3, cw + 2, 9, LINE, 2);
    chamf(x, y - 2, cw, 7, r.top, 2);
    px(x + 2, y - 2, cw - 4, 1, r.sheen); keyEdge(x + 2, y - 2, 8, 1, 0.28);
    px(x, y, 1, 4, r.lit); px(x + cw - 1, y, 1, 4, r.dk); rimEdge(x + cw - 1, y, 1, 4, 0.20);
    px(x + 1, y + 4, cw - 2, 1, shade(r.top, -0.16));                // deck front lip
    knurl(x + 2, y - 1, 8, 1, r.top);                                  // machined grip along the hopper mouth
    // LEFT 2/3: the recessed sorting bay, open so the coin stacks are visible
    const hw = Math.floor((cw - 2) * 2 / 3);
    inset(x + 1, y + 4, hw, h - 7, '#1c211e');
    px(x + 2, y + 5, hw - 2, 1, '#242e29');                            // bay back wall catches a little light
    const jit = Math.floor(now / 220) % 2, base = y + h - 4;
    const cols = [
      [x + 3, base, 3, '#c9a440'], [x + 5, base - 2, 4, '#d9b24a'],
      [x + 8, base - 1, 3, '#cfa844'], [x + 10, base - 3, 5, '#d9b24a'],
      [x + 13, base, 3, '#c9a440'], [x + 15, base - 2, 4, '#d9b24a']
    ];
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i]; if (c[0] > x + hw - 1) continue;
      const dy = (i + Math.floor(now / 220)) % 2 === jit ? 0 : -1;     // the stacks chatter as they're fed
      px(c[0], c[1] + dy, 3, c[2], '#8a6a25');
      px(c[0], c[1] + dy, 3, c[2] - 1, c[3]);
      px(c[0], c[1] + dy, 3, 1, '#f5e08a');                            // coin-edge sheen on the top piece
      px(c[0] + 2, c[1] + dy + 1, 1, c[2] - 1, '#8a6a25');             // shaded east flank of the stack
      keyEdge(c[0], c[1] + dy, 2, 1, 0.18);
    }
    bloom(x + 3, y + 5, hw - 4, h - 9, gold, 0.07);                    // faint bullion cast in the bay
    // RIGHT 1/3: the counter tower — a real readout, the machine's one bright thing
    const sx = x + 1 + hw + 1, sw = cw - hw - 3;
    px(sx, y + 4, sw, h - 7, r.face);
    px(sx, y + 4, 1, h - 7, r.lit); px(sx + sw - 1, y + 4, 1, h - 7, r.dk);
    inset(sx + 1, y + 5, sw - 2, 4, '#0c1a0c');
    px(sx + 2, y + 6, sw - 4, 2, '#0f2410');                           // idle phosphor, never a dead hole
    const dg = String(100 + Math.floor(now / 1000) % 900);
    for (let d = 0; d < 3; d++) {                                      // three counter digits ticking over
      const litd = (dg.charCodeAt(d) % 2) ? 1 : 0.6;
      px(sx + 2 + d * 2, y + 6, 1, (d % 2) ? 2 : 1, shade('#9bff4a', -0.65 * (1 - on)));
      bloom(sx + 2 + d * 2, y + 6, 1, 2, '#9bff4a', 0.16 + 0.34 * on * litd);
    }
    spill(sx + 1, y + 9, sw - 2, '#9bff4a', 0.12 * on, 3);             // counter light pools down its housing
    const led = blink(1000);
    px(sx + sw - 2, y + 6, 1, 1, led ? '#9bff4a' : '#1f3a16');
    if (led) bloom(sx + sw - 2, y + 6, 1, 1, '#9bff4a', 0.28);
    // freestanding feet + under-gap AO
    px(x + 1, y + h - 2, 2, 2, r.dk); px(x + cw - 3, y + h - 2, 2, 2, r.dk);
    px(x + 1, y + h - 2, 1, 1, r.lit); px(x + cw - 3, y + h - 2, 1, 1, r.lit);
    underAO(x + 3, y + h - 1, cw - 6, 1);
  };
  F.treasury_token_furnace = (x, y, w, h, f) => {
    /* v68 TOKEN FURNACE (1x2) — revamped. The old one was a lit green tube in a frame: it read as a
       reagent vial, not as a furnace, because it had no mass, no door and nowhere for anything to go in.
       ⛔ A FURNACE IS AN IRON BODY WITH A HOT MOUTH. Heavy cast flanks, a hinged firebox door standing
          slightly open, and the glow escaping from BEHIND it — light leaking out of a dark object reads
          hotter than any amount of bright fill.
       ⛔ THE GREEN IS KEPT. That acid glow is the treasury identity across the catalog; only the vessel
          around it changed. It is banded across the ramp now (deep core -> mid throat -> pale lick) so
          it models as fire rather than as a flat panel.
       ⛔ ROUTE IN, ROUTE OUT. A token hopper on the crown and a coin chute at the base say what the
          machine does. Both static — the harness cannot prove a throughput, so nothing here counts. */
    const EDGE = '#131a17';
    const IR = '#3b443f', IR_L = '#5a655e', IR_D = '#232a26', IR_HI = '#7d8880';
    const BRS = '#7a6534', BRS_L = '#b39a52';
    const G_D = '#2f5a14', G = '#5f9e1e', G_L = '#9bff4a', G_HI = '#d6ffb0';
    const ph = (f && f.x) || 0, hot = !!(f && f.work);
    const cw = 12, base = y + h, T = base - 26;

    shadow2(x + 1, base - 1, cw - 2);

    /* ---- FLUE + TOKEN HOPPER on the crown ---- */
    px(x + 7, T - 5, 3, 5, EDGE);
    px(x + 7, T - 4, 2, 4, IR); px(x + 7, T - 4, 1, 4, IR_L);
    px(x + 7, T - 5, 3, 1, IR_HI);
    px(x + 2, T - 3, 4, 3, EDGE);                                   // the hopper mouth
    px(x + 2, T - 2, 3, 2, IR_D); px(x + 2, T - 2, 3, 1, BRS);
    px(x + 3, T - 2, 1, 1, BRS_L);

    /* ---- BODY: cast flanks with a lit crown ---- */
    px(x - 1, T - 1, cw + 2, base - T, EDGE);
    px(x, T, cw, base - T - 1, IR);
    px(x, T, cw, 1, IR_HI); keyEdge(x + 1, T, 6, 1, 0.26);
    px(x, T + 1, 2, base - T - 2, IR_L);                            // west flank takes the key
    px(x + cw - 2, T + 1, 2, base - T - 2, IR_D);
    rimEdge(x + cw - 1, T + 2, 1, base - T - 5, 0.18);
    for (let j = 0; j < 3; j++) px(x + 2, T + 2 + j * 8, cw - 4, 1, IR_D);   // casting ribs across the body

    /* ---- FIREBOX: a dark recess, the door ajar, the glow leaking from behind it ---- */
    const fT = T + 6, fx = x + 3, fw = 6;
    px(fx - 1, fT - 1, fw + 2, 11, '#0b100d');
    px(fx, fT, fw, 9, G_D);
    px(fx, fT + 2, fw, 5, G);                                       // the throat
    px(fx + 1, fT + 3, fw - 2, 3, hot ? G_L : shade(G_L, -0.24));
    px(fx + 2, fT + 4, 2, 1, hot ? G_HI : shade(G_HI, -0.30));    // the core lick
    for (let j = 0; j < 4; j++)                                     // grate bars across the mouth
      px(fx, fT + 1 + j * 2, fw, 1, shade(G_D, -0.44));
    bloom(fx, fT, fw, 9, G_L, hot ? 0.30 : 0.20);
    if (blink(190, ph)) px(fx + (U.hash('s1' + Math.floor(now / 190)) % fw), fT - 1, 1, 1, G_HI);   // sparks up the flue
    if (blink(330, ph + 2)) px(fx + (U.hash('s2' + Math.floor(now / 330)) % fw), fT, 1, 1, G_L);
    /* the door leaf, hinged west and standing proud — its lit free edge is what casts the glow out */
    px(x + 1, fT - 1, 3, 11, EDGE);
    px(x + 1, fT, 2, 9, IR);
    px(x + 1, fT, 1, 9, IR_L);
    px(x + 3, fT, 1, 9, shade(G_L, -0.34));                       // free edge, lit by the fire
    px(x + 2, fT + 4, 1, 2, BRS_L);                                 // its handle
    spill(x + 2, fT + 10, fw + 2, G_L, hot ? 0.22 : 0.16, 4);       // firelight pooling on the deck

    /* ---- COIN CHUTE at the base, and the brass plinth band ---- */
    px(x + 2, base - 6, cw - 4, 3, IR_D);
    px(x + 2, base - 6, cw - 4, 1, IR_L);
    px(x + 4, base - 5, 4, 1, '#0b100d');                           // the chute mouth
    px(x + 4, base - 5, 2, 1, BRS);
    px(x, base - 3, cw, 1, BRS);  px(x, base - 3, 5, 1, BRS_L);     // plinth band
    px(x, base - 2, cw, 1, IR_D);
    px(x + 1, base - 1, cw - 2, 1, '#070a08');
    underAO(x + 2, base - 3, cw - 4, 2);
  };
  F.treasury_pnl_holo = (x, y, w, h, f) => {   // v4 P&L holo — FLUSH deck emitter + a taller projection with real falloff
    // blocks:false, so the puck is set INTO the deck rather than standing on it: agents cross this tile.
    // All the presence comes from the light above it, which is free — light has no collision.
    const cx = x + (w >> 1), G = '#9bff4a', GT = '#d6ffb0';
    const lensY = y + 7;
    // recessed housing: a stepped oval well cut into the plating
    const well = [[3, 6], [2, 8], [1, 10], [2, 8], [3, 6]];
    well.forEach((s, j) => px(x + s[0], lensY - 2 + j, s[1], 1, '#12181a'));
    px(x + 2, lensY - 1, 8, 1, '#232b2a'); keyEdge(x + 3, lensY - 1, 4, 1, 0.18);   // lit north rim of the well
    px(x + 2, lensY + 1, 8, 1, '#0a0f10');                      // deep south lip
    px(x + 1, lensY, 1, 1, '#2a332f'); px(x + 10, lensY, 1, 1, '#0e1312');
    rimEdge(x + 10, lensY, 1, 1, 0.20);
    px(x + 3, lensY, 6, 1, '#1d2a1a');                          // lens ring
    px(x + 4, lensY, 4, 1, G); px(x + 5, lensY, 2, 1, GT);      // hot lens core
    px(x + 3, lensY + 1, 1, 1, blink(900) ? G : '#1c2a1a');     // status dot (kept)
    // PROJECTION — taller than v3 and lit by falloff instead of one flat alpha rect. The flicker is the
    // hologram's only material: a rock-steady hologram reads as a painted-on decal.
    const base = lensY - 1, top = y - 5, span = base - top;
    const fl = 0.55 + 0.18 * flick(220) + 0.12 * flick(90, 1);
    bloom(x + 4, lensY - 1, 4, 1, G, 0.30 * fl);                // the emitter itself blooms
    ctx.save();
    ctx.globalAlpha = 0.06 * fl; ctx.fillStyle = G;             // volumetric cone widening as it rises
    ctx.beginPath(); ctx.moveTo(cx - 2, base); ctx.lineTo(cx - 6, top); ctx.lineTo(cx + 6, top); ctx.lineTo(cx + 2, base);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    // the chart: 4 bars, one of them ALIVE (kept), plus the rising trend line and the peak glint
    const grow = Math.floor((now / 520) % 4), heights = [3, 5, 7, 9];
    const bw = 2, gap = 1, startX = Math.round(cx - (4 * bw + 3 * gap) / 2);
    ctx.save();
    ctx.globalAlpha = 0.44 * fl;
    for (let b = 0; b < 4; b++) {
      let hgt = heights[b] + (b === grow ? 1 + Math.floor((now / 130) % 2) : 0);
      if (hgt > span - 1) hgt = span - 1;
      const bx = startX + b * (bw + gap), by = base - 1 - hgt;
      px(bx, by, bw, hgt, G);
      px(bx, by, bw, 1, GT);                                    // each bar cap is its brightest row
      px(bx + bw - 1, by + 1, 1, hgt - 1, shade(G, -0.35));   // shaded east face — even light has volume
    }
    ctx.restore();
    ctx.save();                                                 // interlace + one sweeping refresh band
    ctx.globalAlpha = 0.10 * fl;
    for (let sy = top + 1; sy < base; sy += 2) px(cx - 5, sy, 10, 1, G);
    ctx.restore();
    const scan = top + 1 + Math.floor((now / 240) % span);
    ctx.save(); ctx.globalAlpha = 0.24 * fl; px(cx - 5, scan, 10, 1, GT); ctx.restore();
    ctx.save();                                                 // rising trend line over the bars (kept)
    ctx.globalAlpha = 0.72 * fl;
    for (let i = 0; i < 4; i++) px(startX + i * 2, base - 4 - i * 2, 1, 1, GT);
    ctx.restore();
    const peakX = startX + 6, peakY = base - 11;                // up-arrow glint (kept)
    const glint = blink(640) ? GT : G;
    ctx.save();
    ctx.globalAlpha = 0.9 * fl;
    px(peakX, peakY, 1, 1, glint); px(peakX - 1, peakY + 1, 3, 1, glint); px(peakX, peakY + 1, 1, 2, glint);
    ctx.restore();
    if (f && f.work) bloom(cx - 4, top + 1, 8, span - 1, G, 0.09 * fl);   // kept: the books are being worked
  };
  F.war_pivotpanel = (x, y, w, h, f) => {   // v4 PIVOT PANEL (2x1) — the family's only BRIGHT-FIELD board, on one column
    // The tacscreen is also a 2x1 board on posts, so these two had to be pulled apart or the war room and the
    // bridge would read as the same prop twice. Two separations, both visible at 3x:
    //   SILHOUETTE — this one loses the twin posts for ONE heavy centre column on a wide oval foot, with a
    //                marker tray slung under the board (a thing people stand AT, not a monitor they watch).
    //   LIGHT      — its lit area is two big SOLID colour fields, bright-on-bright, where every other screen in
    //                the family is thin light on dark glass. Rose PIVOT vs periwinkle PERSEVERE, amber seam.
    // f.work = the room is actively deciding -> the seam LED drives harder and the scanline sweeps faster.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const ROSE = '#ff5c7a', ROSEL = '#ffd0d9', PERI = '#a0a8ff', PERIL = '#d4d8ff', AMB = '#ffb84d';
    const cx = x + Math.floor(w / 2);
    shadow2(x + 4, y + h - 1, w - 8);
    // WIDE OVAL FOOT + single tapered column — the silhouette tell against the bridge's twin-post boards
    chamf(cx - 8, y + h - 4, 16, 4, LINE, 3);
    chamf(cx - 7, y + h - 3, 14, 2, r.face, 2);
    px(cx - 6, y + h - 3, 12, 1, r.lit); keyEdge(cx - 5, y + h - 3, 8, 1, 0.16);
    px(cx - 6, y + h - 2, 12, 1, r.ao);
    ctx.globalAlpha = 0.30; px(cx - 8, y + h, 16, 1, '#000'); ctx.globalAlpha = 1;
    for (let j = 0; j < 5; j++) {                                   // the column tapers as it rises
      const cw3 = 6 - (j > 2 ? 1 : 0);
      px(cx - (cw3 >> 1) - 1, y + 4 + j, cw3 + 2, 1, LINE);
      px(cx - (cw3 >> 1), y + 4 + j, cw3, 1, r.face);
      px(cx - (cw3 >> 1), y + 4 + j, 1, 1, r.lit); px(cx + (cw3 >> 1) - 1, y + 4 + j, 1, 1, r.dk);
    }
    rimEdge(cx + 2, y + 5, 1, 4, 0.18);
    px(cx - 4, y + 3, 8, 2, shade(r.top, 0.14));                  // yoke collar clamping board to column
    px(cx - 4, y + 3, 8, 1, r.sheen);
    // MARKER TRAY slung under the board — the physical detail that says "people decide here"
    chamf(x + 5, y + 1, w - 10, 3, LINE, 1);
    px(x + 6, y + 2, w - 12, 1, shade(r.face, 0.10)); px(x + 6, y + 2, w - 12, 1, r.lit);
    px(x + 6, y + 3, w - 12, 1, r.ao);
    px(x + 8, y + 2, 3, 1, ROSE); px(x + 13, y + 2, 3, 1, PERI);    // two markers lying in the tray
    // chamfered carcass
    chamf(x - 1, y - 6, w + 2, 8, LINE, 2);
    chamf(x, y - 5, w, 7, r.face, 2);
    px(x + 2, y - 5, w - 4, 1, r.top); keyEdge(x + 2, y - 5, 7, 1, 0.28);
    px(x, y - 3, 1, 4, r.lit); px(x + w - 1, y - 3, 1, 4, r.dk); rimEdge(x + w - 1, y - 3, 1, 4, 0.22);
    px(x + 2, y + 1, w - 4, 1, r.ao);
    px(x + 2, y - 5, 1, 1, r.sheen); px(x + w - 3, y - 5, 1, 1, r.sheen);
    // SPLIT FACE — two solid decision fields either side of an amber seam
    const fy = y - 4, fh = 6, half = Math.floor((w - 6) / 2);
    inset(x + 2, fy - 1, w - 4, fh + 2, '#101216');
    const lx = x + 3;
    px(lx, fy, half - 1, fh, ROSE);                                 // PIVOT
    px(lx, fy, half - 1, 1, ROSEL);
    px(lx, fy + 1, 1, fh - 2, shade(ROSE, 0.22));
    px(lx, fy + fh - 1, half - 1, 1, shade(ROSE, -0.40));
    for (let i = 0; i < 5; i++) px(lx + 1 + i * 2, fy + 2, 1, 2, ROSEL);        // PIVOT ticks (kept)
    px(lx + 2, fy + 3, 1, 1, '#a8324a'); px(lx + 6, fy + 3, 1, 1, '#a8324a');
    const sx2 = lx + half;                                          // amber seam (kept)
    px(sx2, fy - 1, 1, fh + 2, AMB); px(sx2, fy - 1, 1, 1, '#ffe1a0');
    px(sx2, fy, 1, fh, shade(AMB, -0.15));
    const rx = sx2 + 1;
    px(rx, fy, half - 1, fh, PERI);                                 // PERSEVERE
    px(rx, fy, half - 1, 1, PERIL);
    px(rx + half - 2, fy + 1, 1, fh - 2, shade(PERI, -0.28));
    px(rx, fy + fh - 1, half - 1, 1, shade(PERI, -0.35));
    for (let i = 0; i < 5; i++) px(rx + 1 + i * 2, fy + 2, 1, 2, PERIL);        // PERSEVERE ticks (kept)
    px(rx + 3, fy + 3, 1, 1, '#5a64b8'); px(rx + 7, fy + 3, 1, 1, '#5a64b8');
    const sc = fy + Math.floor((now / (on ? 140 : 240)) % fh);      // drifting scanline (kept)
    glow(lx, sc, half - 1, 2, '#fff', 0.10); glow(rx, sc, half - 1, 2, '#fff', 0.10);
    // magnetic chrome puck on the PERSEVERE side (kept) — catch is a shade, never a white speck
    const pcx = rx + half - 4, pcy = fy + fh - 3;
    ctx.globalAlpha = 0.30; px(pcx - 1, pcy + 2, 4, 1, '#000'); ctx.globalAlpha = 1;
    px(pcx, pcy, 3, 2, '#c8ccd6'); px(pcx, pcy, 3, 1, '#eef0f6'); px(pcx, pcy + 1, 3, 1, '#8a8e98');
    px(pcx, pcy, 1, 1, shade('#eef0f6', 0.4));
    // pulsing seam LED (kept) — now with falloff, and the two fields wash the board's frame in their own colours
    const pulse = Math.max(0, Math.sin(now / (on ? 420 : 700)));
    bloom(sx2, fy + Math.floor(fh / 2), 1, 2, AMB, 0.25 + 0.55 * pulse);
    if (pulse > 0.6) px(sx2, fy + Math.floor(fh / 2), 1, 1, '#ffe1a0');
    bloom(lx, fy, half - 1, fh, ROSE, 0.10); bloom(rx, fy, half - 1, fh, PERI, 0.10);
    spill(x + 3, y + 2, half - 1, ROSE, on ? 0.18 : 0.11, 4);       // each half spills its OWN colour down the tray
    spill(rx, y + 2, half - 1, PERI, on ? 0.18 : 0.11, 4);
  };
  F.war_intelcab = (x, y, w, h, f) => {
    /* v40 DATA CABINET (1x2) — built to Andrew's reference (2026-08-16). The structure that reference
       has and none of mine did:
       ⛔ TWO COLUMNS, NOT ONE FACE. A wide column of stacked drive bays beside a NARROW column
          carrying one tall glowing channel. That asymmetry is the entire silhouette — every version
          I made was symmetrical and therefore generic.
       ⛔ A CHAMFERED CAP WIDER THAN THE BODY, sitting proud with its own lit top plane and one
          indicator slot. It reads as a separate casting dropped on top, not as the body's first row.
       ⛔ A VENTED PLINTH with a dot grid, and FEET the carcass stands on. Both are what stop it
          floating; the reference has them and my versions ended at a flat bottom edge.
       ⛔ The glowing channel is ONE tall unbroken run with a hot core and a dark housing — not a
          stack of little LEDs. It is the only emissive on the prop and it does all the work. */
    const r = EQUIPMENT, br = MAT.brass, on = !!(f && f.work);
    const base = y + h, top = y - 7;
    const G = ACC.work;

    shadow2(x + 1, base - 1, w - 2);
    deckPlate(x, base - 4, w, 4);
    deckSocket(x + w + 1, base - 3, on);

    /* ---- CAP: proud of the body, chamfered, its own lit top plane ---- */
    px(x, top + 1, w, 5, r.ink);
    px(x + 1, top, w - 2, 1, r.ink);                                // chamfer
    px(x + 1, top + 1, w - 2, 2, r.top);                            // the plane we look down on
    px(x + 2, top + 1, 4, 1, r.hi); captiveBolt(x + w - 4, top + 1, r);                                 // specular chip, west
    px(x + 1, top + 3, w - 2, 1, r.top);
    px(x + 1, top + 4, w - 2, 1, r.dk);
    px(x + 3, top + 3, w - 6, 1, on ? G : shade(G, -0.62));       // indicator slot in the cap
    if (on) bloom(x + 3, top + 3, w - 6, 1, G, 0.22);

    /* ---- BODY ---- */
    const bTop = top + 6;
    px(x, bTop, w, base - bTop - 2, r.ink);
    panelFinish(x + 1, bTop + 1, w - 2, base - bTop - 4, r);
    px(x + 1, bTop + 1, 1, base - bTop - 4, r.mid);                 // lit west return
    px(x + w - 2, bTop + 1, 1, base - bTop - 4, r.dk);

    /* ---- LEFT COLUMN: a recessed well holding stacked drive units ---- */
    const wellX = x + 1, wellW = 7;
    px(wellX, bTop + 2, wellW, base - bTop - 8, r.ao);              // the well the units sit in
    for (let k = 0; k < 3; k++) {
      const uy = bTop + 3 + k * 5;
      px(wellX + 1, uy, wellW - 1, 4, r.ink);                       // unit body
      px(wellX + 1, uy + 1, wellW - 2, 2, r.top);
      px(wellX + 1, uy + 1, wellW - 2, 1, r.mid);                   // its lit top plate
      px(wellX + 2, uy + 2, 2, 1, r.ao);                            // a slot on the face
      px(wellX + 2, uy + 3, 3, 1, r.face); // recessed cartridge pull
      px(wellX + wellW - 2, uy + 2, 1, 1, blink(420 + k * 160, k) ? G : shade(G, -0.66));
      if (on) bloom(wellX + wellW - 2, uy + 2, 1, 1, G, 0.20);
    }

    /* ---- RIGHT COLUMN: one tall glowing channel, dark housing, hot core ---- */
    const chX = x + w - 4;
    px(chX, bTop + 2, 3, base - bTop - 8, r.ink);
    px(chX + 1, bTop + 3, 1, base - bTop - 10, on ? G : shade(G, -0.70));
    if (on) {
      px(chX + 1, bTop + 5, 1, 4, '#d6ffe8');                       // a hotter run partway down
      bloom(chX, bTop + 3, 3, base - bTop - 10, G, 0.24);
      spill(x + 1, base - 5, w - 2, G, 0.14, 4);
    }
    px(chX, bTop + 2, 1, base - bTop - 8, r.mid);                   // the housing's lit west lip

    /* ---- VENTED PLINTH: dot grid, then the carcass's own base ---- */
    const vy = base - 8;
    px(wellX, vy, wellW, 5, r.ink);
    px(wellX + 1, vy + 1, wellW - 2, 3, r.top);
    px(wellX + 1, vy + 1, wellW - 2, 1, r.mid);
    for (let ry = 0; ry < 2; ry++) for (let rx = 0; rx < 3; rx++)
      px(wellX + 2 + rx * 2, vy + 2 + ry, 1, 1, r.ao);              // the dot grid
    px(x + 1, base - 3, w - 2, 1, r.mid);
    px(x + 1, base - 2, w - 2, 1, r.ao);

    /* ---- FEET ---- */
    px(x, base - 2, 4, 2, r.ink); px(x + w - 4, base - 2, 4, 2, r.ink);
    px(x + 1, base - 2, 2, 1, r.mid); px(x + w - 3, base - 2, 2, 1, r.mid);
    px(x + 1, bTop + 1, 3, 1, br.mid); px(x + w - 4, bTop + 1, 3, 1, br.ao);   // brass shoulder bands
  };
  F.war_threatcore = (x, y, w, h, f) => {   // v4 THREAT CORE (1x2) — a segmented LEVEL METER, not another light slot
    // Paired against bridge_dispatch_pylon this is the family's hardest read: both are 1x2 columns. They are
    // separated on the axis of their light — the pylon is ONE continuous VERTICAL bar; this is a stack of
    // discrete HORIZONTAL segments climbing bottom-up behind smoked glass, like a threat gauge filling. The
    // body is bulked out to match: an external rib CAGE, a flared foot and an orbit RING on the crown, against
    // the pylon's smooth slim column and single mast. f.work = escalated -> 5 segments lit instead of 3.
    const r = RAMP.gun, ph = (f && f.x) || 0, on = !!(f && f.work);
    const ROSE = '#ff5c7a', ROSEL = '#ffd9e2', AMB = '#ffb84d';
    const hot = on ? 1 : 0.55;
    shadow2(x + 1, y + h - 1, w - 2);
    bloom(x, y + h - 4, w, 3, ROSE, (0.10 + 0.05 * hot) + 0.04 * Math.sin(now / 900));   // floor halo (kept)
    deckPlate(x - 1, y + h - 5, w + 2, 5);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + h - 9, x + w + 2, y + h - 3, 2);
    // FLARED FOOT — wider than the pylon's shoe, so the column reads bottom-heavy
    chamf(x - 2, y + h - 7, w + 4, 4, LINE, 2);
    px(x - 1, y + h - 6, w + 2, 2, r.face); px(x - 1, y + h - 6, w + 2, 1, r.lit);
    keyEdge(x, y + h - 6, w, 1, 0.16);
    px(x - 1, y + h - 4, w + 2, 1, r.ao);
    // slim column body + a cap we look down on
    chamf(x, y - 3, w - 1, h - 4, LINE, 2);
    chamf(x + 1, y - 2, w - 3, h - 6, r.face, 2);
    px(x + 1, y, 1, h - 9, shade(r.face, 0.12)); px(x + w - 3, y, 1, h - 9, r.dk);
    rimEdge(x + w - 3, y + 1, 1, h - 11, 0.22);
    chamf(x, y - 6, w - 1, 4, LINE, 1);
    px(x + 1, y - 5, w - 3, 2, r.top); px(x + 1, y - 5, w - 3, 1, r.sheen); keyEdge(x + 1, y - 5, 4, 1, 0.30);
    px(x + 1, y - 3, w - 3, 1, shade(r.top, -0.24));              // cap lip ties the cap down
    // EXTERNAL CAGE RAILS standing proud of the column on both flanks — the bulk that separates this from the
    // pylon in silhouette. Each rail carries its OWN outline pixel on its outer edge, so bolting the cage on
    // widens the dark silhouette instead of eating it.
    const rTop = y - 1, rH = h - 12;
    px(x - 1, rTop - 1, 2, rH + 2, LINE); px(x + w - 2, rTop - 1, 2, rH + 2, LINE);
    px(x, rTop, 1, rH, shade(r.face, 0.18)); keyEdge(x, rTop, 1, 4, 0.20);       // west rail takes the key
    px(x + w - 2, rTop, 1, rH, r.dk); rimEdge(x + w - 2, rTop, 1, rH, 0.20);       // east rail takes the sky
    for (let j = 0; j < 4; j++) {                                   // cross-ties bolting the rails to the body
      const ry2 = rTop + 1 + j * 4;
      px(x, ry2, 3, 1, shade(r.face, 0.10)); px(x + w - 4, ry2, 3, 1, shade(r.face, 0.10));
      px(x, ry2 + 1, 3, 1, r.ao); px(x + w - 4, ry2 + 1, 3, 1, r.ao);
      px(x, ry2, 1, 1, r.sheen); px(x + w - 2, ry2, 1, 1, r.ao);    // tie bolts
    }
    // SMOKED-GLASS WELL with the 5-segment stack filling bottom-up (kept level behaviour)
    const gx2 = x + 3, gy2 = y, gw2 = w - 6, gh2 = 11;
    px(gx2 - 2, gy2 - 1, gw2 + 4, gh2 + 2, '#0a0b0d');              // heavy glass surround
    inset(gx2 - 1, gy2, gw2 + 2, gh2, '#0d0e10');
    const segs = 5, seglvl = on ? 5 : 3;
    const topAmber = blink(1400);                                   // slow warning loop (kept)
    for (let s = 0; s < segs; s++) {
      const sy3 = gy2 + gh2 - 2 - s * 2;
      if (s < seglvl) {
        const isTop = s === seglvl - 1;
        const col = (isTop && topAmber) ? AMB : ROSE;
        px(gx2, sy3, gw2, 1, col);
        px(gx2, sy3, 2, 1, shade(col, 0.16));                     // west-lit segment edge
        bloom(gx2, sy3, gw2, 1, col, isTop ? 0.30 : 0.16);          // each SEGMENT blooms on its own
      } else {
        px(gx2, sy3, gw2, 1, '#16171a');                            // unlit segments still visible behind glass
        px(gx2, sy3, 1, 1, '#1f2124');
      }
    }
    px(gx2 - 1, gy2, 1, gh2, shade(r.top, 0.10));                 // smoked-glass sheen down the west edge
    rimEdge(gx2 + gw2, gy2, 1, gh2, 0.20);
    scanl(gx2, gy2, gw2, gh2, 0.16);
    spill(x + 1, gy2 + gh2 + 1, w - 3, ROSE, 0.16 + 0.08 * hot, 4); // gauge light pooling down the vents
    // vent slits below the glass (kept)
    for (let v = 0; v < 3; v++) {
      const vy = gy2 + gh2 + 2 + v * 2;
      px(x + 3, vy, w - 6, 1, '#0d0e10');
      px(x + 3, vy + 1, w - 6, 1, shade(r.face, 0.12));
    }
    // CROWN: a real orbit RING with the sweep dot riding it — the pylon's crown is a flat mast head
    const hubx = x + Math.floor(w / 2), huby = y - 8;
    px(hubx - 1, huby, 2, 3, LINE); px(hubx - 1, huby, 1, 3, r.lit);
    ctx.save();
    ctx.strokeStyle = shade(r.top, -0.30); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(hubx, huby, 3, 1.4, 0, 0, 6.2832); ctx.stroke();
    ctx.restore();
    const a = now / 600;
    const dx2 = Math.round(Math.cos(a) * 3), dy2 = Math.round(Math.sin(a) * 1.4);
    px(hubx + dx2, huby + dy2, 1, 1, on ? ROSEL : ROSE);
    bloom(hubx + dx2, huby + dy2, 1, 1, ROSE, on ? 0.38 : 0.22);
    px(x + 2, y + h - 10, 1, 1, blink(on ? 500 : 1500, ph) ? AMB : '#33271a');   // arming lamp on the body
  };
  F.pub_publishpress = (x, y, w, h, f) => {
    // PUBLISH PRESS (2x2, blocks:true) — v4. Bolted machinery, and the family register made literal: the
    // PLATEN actually travels. It rides two chrome pistons down onto the heat bed on the fire pulse and lifts
    // off after, and a printed sheet feeds out of the lower slot into the catch tray between strikes. That
    // beats any amount of glow: you can see the thing work. Kept: the 1500ms press cycle, the amber->gold
    // heat bed, the three status LEDs, the steam wisp, and f.work biasing the heat hotter.
    const r = RAMP.steel, on = !!(f && f.work);
    const PER = 1500, ph = (now % PER) / PER;
    const fire = Math.max(0, Math.sin(ph * Math.PI * 2));
    const firing = ph > 0.18 && ph < 0.42;
    const heat = on ? 0.45 + 0.55 * fire : 0.18 + 0.30 * fire;
    shadow2(x + 2, y + h - 1, w - 4);
    deckPlate(x - 1, y + h - 5, w + 2, 5);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 3, y + h - 9, x + w + 2, y + h - 3, 2.2);
    // TALL 3/4 casing
    chamf(x, y + 2, w, 17, LINE, 2);
    chamf(x + 1, y + 3, w - 2, 3, r.top, 2);                      // cap
    px(x + 2, y + 3, w - 4, 1, r.sheen); keyEdge(x + 2, y + 3, 8, 1, 0.30);
    px(x + 2, y + 5, w - 4, 1, shade(r.top, -0.22));            // cap front lip
    chamf(x + 1, y + 6, w - 2, 12, r.face, 2);
    px(x + 1, y + 8, 1, 8, shade(r.face, 0.08)); px(x + w - 2, y + 8, 1, 8, r.dk);
    rimEdge(x + w - 2, y + 8, 1, 8, 0.20);
    px(x + 2, y + 18, w - 4, 1, r.ao);
    wear(x + 2, y + 7, w - 4, 10, 4, shade(r.face, -0.12));
    // PRESS THROAT
    inset(x + 3, y + 6, w - 6, 9, '#1a1410');                     // y+6..y+14, inner x+4..x+19 / y+7..y+13
    const bedY = y + 12;
    for (let i = 0; i < 2; i++) {                                 // heat bed, amber->gold up the stack
      const base = i === 0 ? '#ff8a1e' : '#ffc24a';
      px(x + 4, bedY + (1 - i), 16, 1, shade(base, -0.10 + 0.10 * i));
    }
    bloom(x + 4, bedY, 16, 2, '#ffb030', 0.14 + 0.34 * heat);
    px(x + 5, bedY, 14, 1, firing ? '#fff0b0' : '#ffcf66');       // hot core line
    // pistons + travelling platen: rest at y+7, slams to y+10 at full fire
    const platY = y + 7 + Math.round(fire * 3);
    for (const pxx of [x + 4, x + w - 6]) {
      px(pxx, y + 6, 2, platY - y - 6 + 1, '#5a625e');
      px(pxx, y + 6, 1, platY - y - 6 + 1, '#8d958f');
      px(pxx, y + 7, 1, 1, '#c6cdc7');                            // chrome catch on the rod
    }
    px(x + 4, platY, 16, 2, LINE);
    px(x + 4, platY, 16, 1, shade(r.top, 0.12)); keyEdge(x + 5, platY, 7, 1, 0.24);
    px(x + 4, platY + 1, 16, 1, shade('#ff8a1e', -0.55));       // the platen's own hot underside
    if (firing) bloom(x + 5, platY + 1, 14, 1, '#ffb030', 0.20 + 0.30 * fire);
    // stock passing through the throat between platen and bed
    px(x + 4, bedY - 1, 16, 1, firing ? '#e8ece4' : '#c4cabf');
    // OUTPUT SLOT + catch tray — the printed sheet feeds out after each strike
    px(x + 4, y + 15, w - 8, 1, r.ao);
    inset(x + 5, y + 15, w - 10, 2, '#0f1418');
    const out = ph > 0.45 ? Math.min(5, 1 + Math.floor((ph - 0.45) * 11)) : 0;
    if (out > 0) {
      px(x + 6, y + 16, w - 12, out, '#cdd2cc');
      px(x + 6, y + 16, w - 12, 1, '#e6eae4');
      for (let gx2 = 1; gx2 < w - 12; gx2 += 3) px(x + 6 + gx2, y + 17, 1, out - 1, ACC.flow);
      bloom(x + 6, y + 16, w - 12, out, ACC.flow, 0.10);
    }
    chamf(x + 3, y + h - 5, w - 6, 3, LINE, 1);                   // catch tray the sheet tucks behind
    px(x + 4, y + h - 4, w - 8, 1, shade(r.face, 0.10));
    px(x + 4, y + h - 4, w - 8, 1, r.lit); keyEdge(x + 5, y + h - 4, w - 11, 1, 0.14);
    px(x + 4, y + h - 3, w - 8, 1, r.ao);
    // status LEDs (kept timings) — gold and green only: alert red would claim a failure that has not happened
    px(x + w - 8, y + 17, 1, 1, ACC.work);
    px(x + w - 6, y + 17, 1, 1, blink(750) ? ACC.flow : '#3a3210');
    px(x + w - 4, y + 17, 1, 1, firing ? '#ff9d2e' : '#2a2014');
    if (blink(750)) bloom(x + w - 6, y + 17, 1, 1, ACC.flow, 0.28);
    // STOCK SPOOL on top, web feeding over a drum into the cap — where the paper comes from
    chamf(x + 3, y, w - 6, 4, LINE, 1);
    px(x + 4, y + 1, w - 8, 2, '#33383a'); px(x + 4, y + 1, w - 8, 1, shade('#33383a', 0.26));
    px(x + 4, y + 2, w - 8, 1, '#23272a');
    const spin = Math.floor(now / 120) % 4;
    for (const hx of [x + 4, x + w - 6]) { px(hx, y + 1, 2, 2, '#22262a'); px(hx + (spin & 1), y + 1 + (spin >> 1), 1, 1, '#4d5551'); }
    px(x + 7, y - 8, w - 14, 8, LINE);                            // the roll itself
    px(x + 8, y - 7, w - 16, 6, '#c2c7c0'); px(x + 8, y - 7, w - 16, 1, '#dfe4dc');
    keyEdge(x + 8, y - 7, 4, 1, 0.30);
    for (let i = 0; i < 3; i++) px(x + 8, y - 6 + i * 2, w - 16, 1, shade('#c2c7c0', -0.14));
    px(x + 8 + spin, y - 4, 1, 2, shade('#c2c7c0', -0.34));     // one mark so the roll reads as turning
    px(x + 9, y - 1, w - 18, 2, '#b6bbb4');                       // web running down into the cap
    px(x + 9, y - 1, 1, 2, '#d4d9d2');
    // steam wisp off the sheet on the fire pulse (kept)
    if (firing) {
      const sx2 = x + (w >> 1);
      ctx.save(); ctx.globalAlpha = 0.16 + 0.18 * fire;
      px(sx2, y + 5, 1, 2, '#d8ded6');
      px(sx2 + (blink(220) ? 1 : -1), y + 3, 1, 2, '#d8ded6');
      px(sx2, y + 1, 1, 1, '#d8ded6');
      ctx.restore();
    }
  };
  F.pub_outboundchute = (x, y, w, h, f) => {
    // OUTBOUND CHUTE (1x2, blocks:true) — v4. TALL 3/4 pneumatic column, bolted. The capsule now falls with
    // real ACCELERATION and lands: it eases in down the glass slit, the breech flashes on arrival and the
    // hopper ring recharges behind it. A fall at constant speed reads as a looping texture; a fall that
    // arrives reads as a dispatch. Kept: the ~2s drop cycle, the gold hopper ring, the barcode band.
    // The old SHIP stencil was drawn at 5px monospace from x+4 — ~12px of text on a 12px prop, so it ran off
    // the casing entirely. Replaced with painted chevrons, which are also what actually reads at this width.
    const r = RAMP.steel, on = !!(f && f.work), ph0 = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 5, w + 2, 5);
    deckSocket(x - 3, y + h - 3, on);
    cable(x + 1, y + h - 8, x - 3, y + h - 3, 2);
    // column
    chamf(x - 1, y - 4, w + 2, 23, LINE, 2);
    chamf(x, y - 3, w, 21, r.face, 2);
    px(x, y - 1, 1, 16, shade(r.face, 0.08)); px(x + w - 1, y - 1, 1, 16, r.dk);
    rimEdge(x + w - 1, y - 1, 1, 16, 0.22);
    px(x + 1, y + 17, w - 2, 1, r.ao);
    wear(x + 1, y, w - 2, 12, 4, shade(r.face, -0.12));
    // flared hopper mouth — juts 2px proud of the column so the silhouette steps
    chamf(x - 3, y - 11, w + 6, 8, LINE, 2);
    px(x - 2, y - 10, w + 4, 4, r.top); px(x - 2, y - 10, w + 4, 1, r.sheen);
    keyEdge(x - 1, y - 10, 6, 1, 0.30);
    px(x - 2, y - 9, 1, 3, r.lit); px(x + w + 1, y - 9, 1, 3, r.dk);
    rimEdge(x + w + 1, y - 9, 1, 3, 0.22);
    px(x - 1, y - 6, w + 2, 1, shade(r.top, -0.34));            // flare underside
    inset(x + 1, y - 9, w - 2, 3, '#0d100c');                     // dark throat
    const dropT = (now / (on ? 1500 : 2100)) % 1;
    const charge = dropT > 0.55 ? (dropT - 0.55) / 0.45 : 0;      // the ring recharges after each dispatch
    const ring = 0.20 + 0.55 * charge;
    px(x + 1, y - 9, w - 2, 1, shade(ACC.flow, charge > 0.5 ? 0.1 : -0.4));
    bloom(x + 1, y - 9, w - 2, 1, ACC.flow, ring);
    spill(x + 1, y - 5, w - 2, ACC.flow, ring * 0.5, 3);
    // GLASS DROP SLIT — the capsule eases in, so the fall has weight
    const sx = x + 3, sw = w - 6, sy = y - 1, sh2 = 14;
    inset(sx, sy, sw, sh2, '#0b0f0c');
    rimEdge(sx + 1, sy, 1, sh2, 0.14);                            // sky bounce on the glass
    ctx.save(); ctx.beginPath(); ctx.rect(sx + 1, sy + 1, sw - 2, sh2 - 2); ctx.clip();
    const fall = dropT < 0.55 ? (dropT / 0.55) * (dropT / 0.55) : 1.2;
    const py2 = sy + 1 + Math.round(fall * (sh2 - 3));
    if (dropT < 0.55) {
      px(sx + 1, py2, 4, 3, '#36424c'); px(sx + 1, py2, 4, 1, '#4d5962');
      px(sx + 1, py2 + 1, 1, 2, '#28323a'); px(sx + 2, py2 + 1, 2, 1, ACC.flow);   // tape strip
      if (dropT > 0.25) px(sx + 1, py2 - 2, 4, 1, shade('#36424c', -0.4));       // motion smear at speed
    }
    ctx.restore();
    px(sx, sy, 1, sh2, '#12170f'); px(sx + sw - 1, sy, 1, sh2, '#12170f');
    // BREECH — flashes as the capsule is fired away down the line
    const land = dropT > 0.50 && dropT < 0.62;
    px(x + 1, y + 13, w - 2, 1, land ? '#fff0b8' : shade(ACC.flow, -0.62));
    if (land) { bloom(x + 1, y + 13, w - 2, 1, ACC.flow, 0.42); spill(x, y + 14, w, ACC.flow, 0.22, 3); }
    // chamfered lower barrel: chevrons + barcode band (no text at 12px)
    const by = y + h - 11;
    chamf(x - 1, by, w + 2, 7, LINE, 1);
    px(x, by + 1, w, 5, shade(r.face, -0.10));
    px(x, by + 1, w, 1, r.lit); keyEdge(x + 1, by + 1, w - 3, 1, 0.16);
    px(x, by + 3, w, 1, shade(r.face, -0.38));                  // band seam
    for (let k = 0; k < 2; k++) {                                 // twin down-chevrons, marching on dispatch
      const cvy = by + 1 + k + (land ? 1 : 0);
      px(x + 3, cvy, 1, 1, '#dfe6da'); px(x + 4, cvy + 1, 2, 1, '#dfe6da'); px(x + 6, cvy, 1, 1, '#dfe6da');
    }
    for (let i = 0; i < 8; i++) px(x + 2 + i, by + 5, 1, 1, (U.hash('bc' + i + ph0) % 2) ? '#cdd6cc' : '#161a12');
    for (const rx of [x + 1, x + w - 2]) for (const ry of [y + 1, y + 11]) {
      px(rx, ry, 1, 1, shade(r.top, 0.24)); px(rx, ry + 1, 1, 1, r.ao);
    }
  };
  F.pub_mailpod = (x, y, w, h, f) => {
    // MAIL POD (2x1, blocks:true) — v4. Bolted capsule terminal with two glass bays: WEST is the loaded
    // inbound, EAST is the dispatch. The old prop just blinked a bay empty; now the capsule visibly LEAVES —
    // it streaks up the snorkel tube and off the NE shoulder, which is the whole point of the object and the
    // family's register. Kept: the 2.5s thunk cycle emptying the east bay, the twin indicators, the snorkel.
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x - 3, y + h - 3, on);
    cable(x + 2, y + 7, x - 3, y + h - 3, 2);
    for (const lx of [x + 3, x + w - 6]) {
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);
    }
    underAO(x + 6, y + 9, w - 12, 2);
    // BOLD capsule silhouette — chamfered dome over a short face
    chamf(x - 1, y - 5, w + 2, 14, LINE, 3);
    chamf(x, y - 4, w, 12, r.face, 3);
    chamf(x + 1, y - 4, w - 2, 5, r.top, 3);                      // dome we look down on
    px(x + 3, y - 4, w - 6, 1, r.sheen); keyEdge(x + 3, y - 4, 8, 1, 0.30);
    px(x + 1, y + 1, w - 2, 1, shade(r.top, -0.20));            // dome lip
    px(x, y + 2, 1, 5, r.lit); px(x + w - 1, y + 2, 1, 5, r.dk);
    rimEdge(x + w - 1, y + 2, 1, 5, 0.22);
    px(x + 1, y + 7, w - 2, 1, r.ao);
    wear(x + 2, y - 3, w - 4, 9, 4, shade(r.face, -0.12));
    seamH(x + 10, y + 2, 4, r.face);                              // centre feed seam between the bays
    // TWIN GLASS BAYS (kept thunk cycle) — west loaded, east dispatching
    const cyc = (now % 2500) / 2500, thunk = cyc < 0.09, gone = cyc < 0.42;
    const cy = y + 2;
    for (let b = 0; b < 2; b++) {
      const bx = b ? x + w - 7 : x + 6, empty = b === 1 && gone;
      inset(bx - 4, cy - 4, 8, 8, '#181e1b');
      px(bx - 3, cy - 3, 6, 6, '#22302c'); px(bx - 3, cy - 3, 6, 1, shade('#22302c', 0.30));
      if (!empty) {
        px(bx - 2, cy - 2, 4, 4, '#56646e'); px(bx - 2, cy - 2, 4, 1, '#6d7b85');
        px(bx - 1, cy - 1, 1, 2, '#28323a');
        px(bx + 1, cy - 1, 1, 2, shade('#56646e', -0.34)); rimEdge(bx + 1, cy - 1, 1, 2, 0.20);
        px(bx - 2, cy + 1, 4, 1, b ? ACC.flow : shade(ACC.data, -0.20));   // routing band
      } else {
        px(bx - 2, cy - 1, 4, 2, '#12180f');
        if (thunk) bloom(bx - 2, cy - 1, 4, 2, ACC.flow, 0.34);   // the breech flash it left behind
      }
      rimEdge(bx - 3, cy - 3, 6, 1, 0.26);                        // sky bounce off the curved glass
      px(bx - 2, cy - 2, 1, 1, shade('#dff4ff', -0.20));
    }
    // SNORKEL — a real pneumatic tube arcing off the NE shoulder, with the capsule streaking up it
    const tube = [];
    for (let i = 0; i <= 9; i++) {
      const t = i / 9;
      tube.push([Math.round(x + w - 6 + t * 8), Math.round(y - 2 - t * 7 - Math.sin(t * Math.PI) * 1.4)]);
    }
    for (let i = 0; i < tube.length; i++) {
      px(tube[i][0], tube[i][1] - 1, 2, 4, LINE);
      px(tube[i][0], tube[i][1], 2, 2, i < 5 ? '#46525a' : '#3a444c');
      px(tube[i][0], tube[i][1], 1, 1, '#6a7882');
    }
    if (gone) {                                                   // the capsule the east bay just fired
      const tt = Math.min(1, cyc / 0.42), i = Math.min(tube.length - 1, Math.floor(tt * tube.length));
      px(tube[i][0], tube[i][1], 2, 2, '#cfe6f2');
      bloom(tube[i][0], tube[i][1], 2, 2, ACC.flow, 0.34 * (1 - tt));
      if (i > 1) px(tube[i - 2][0], tube[i - 2][1], 2, 1, shade(ACC.flow, -0.34));   // trail
    }
    // indicators above each bay (kept: steady cyan-white west, gold blink east)
    px(x + 6, y - 3, 1, 1, '#dff6ff'); bloom(x + 6, y - 3, 1, 1, ACC.data, 0.30);
    const goldOn = blink(620, ph);
    px(x + w - 7, y - 3, 1, 1, goldOn ? ACC.flow : '#28323a');
    if (goldOn) bloom(x + w - 7, y - 3, 1, 1, ACC.flow, 0.34);
    if (on) spill(x + 2, y + 8, w - 4, ACC.flow, 0.16, 3);        // live dispatch washes the deck plate
  };
  F.arc_indexwall = (x, y, w, h, f) => {
    // INDEX WALL (4x1, blocks:FALSE) — v4 REBUILD. Agents walk in front of this, so the stub feet had to go:
    // it is now a SHALLOW wall-hung card index on lugs, casting onto the bulkhead, with no floor contact.
    // 48px gets HIERARCHY along its length instead of one 6x3 grid: labelled drawers west, the backlit index
    // well centre, a lookup readout east. The motion is a RETRIEVAL CARRIAGE that traverses the well, stops
    // over a column and lifts one slip lit — the archive doing its job. Kept: the silver top rail, the
    // one-slip-per-second cyan flip (it is now the slip the carriage pulled), the sweep, both status dots.
    const r = RAMP.gun, ph = (f && f.x) || 0, on = !!(f && f.work);
    const bt = y - 10, bh = 19;                                   // hangs y-10..y+8
    ctx.globalAlpha = 0.20; px(x + 2, bt + 3, w, bh, '#000'); ctx.globalAlpha = 1;
    for (const lx of [x + 6, x + Math.floor(w / 2), x + w - 8]) {
      px(lx, bt - 3, 2, 4, LINE); px(lx, bt - 3, 2, 1, shade(r.top, 0.20));
      rimEdge(lx + 1, bt - 2, 1, 3, 0.18);
    }
    chamf(x - 1, bt - 1, w + 2, bh + 2, LINE, 2);
    chamf(x, bt, w, bh, r.face, 2);
    px(x + 1, bt, w - 2, 1, '#b0b6b2');                           // kept silver top rail
    px(x + 2, bt + 1, w - 4, 1, shade(r.top, 0.16)); keyEdge(x + 2, bt, 14, 1, 0.28);
    px(x, bt + 3, 1, bh - 6, r.lit); px(x + w - 1, bt + 3, 1, bh - 6, r.dk);
    rimEdge(x + w - 1, bt + 3, 1, bh - 6, 0.22);
    px(x + 2, bt + bh - 2, w - 4, 1, shade(r.face, -0.26));
    px(x + 2, bt + bh - 1, w - 4, 1, r.ao);                       // shallow underside, not a floor line
    // WEST — three labelled drawers, shallow: 1px proud, brass pull, card-tops just visible in the middle one
    for (let d = 0; d < 3; d++) {
      const dy = bt + 5 + d * 4, open = d === 1;
      px(x + 2, dy, 13, 3, shade(r.face, open ? 0.10 : 0.02));
      px(x + 2, dy, 13, 1, r.lit); keyEdge(x + 3, dy, 8, 1, 0.14);
      px(x + 2, dy + 2, 13, 1, r.ao);
      px(x + 4, dy + 1, 5, 1, '#9aa29c');                         // label holder
      px(x + 5, dy + 1, 3, 1, shade('#9aa29c', -0.34));
      px(x + 11, dy + 1, 2, 1, '#8a8256');                        // brass pull
      if (open) { px(x + 3, dy - 1, 11, 1, '#b8c0bc'); px(x + 3, dy - 1, 11, 1, shade('#b8c0bc', -0.12)); }
    }
    // CENTRE — backlit index well
    const wx = x + 16, ww = 22, wy = bt + 4, wh = 13;
    inset(wx, wy, ww, wh, '#141a18');
    px(wx + 1, wy + 1, ww - 2, wh - 2, '#0f1614');                // never dead black: the well is lit from behind
    const cols = 6, rows = 3, land = Math.floor(now / 1000), litIdx = land % (cols * rows);
    const litC = litIdx % cols, prevC = ((land - 1 + cols * rows) % (cols * rows)) % cols;
    const tt = Math.min(1, (now % 1000) / 260);                   // the carriage travels, then lifts
    const carX = wx + 2 + Math.round((prevC + (litC - prevC) * tt) * 3);
    for (let rj = 0; rj < rows; rj++) for (let c = 0; c < cols; c++) {
      const cx = wx + 2 + c * 3, idx = rj * cols + c, flip = idx === litIdx && tt >= 1;
      const cy = wy + 2 + rj * 3 - (flip ? 1 : 0);                // the pulled slip stands proud of its file
      const sw = 2 + (U.hash('ix' + idx) % 2);
      px(cx, cy + 3, sw + 1, 1, '#0b110f');                       // slot shadow it came out of
      px(cx, cy, sw + 1, 3, flip ? '#c8f2ff' : '#aab4b0');
      px(cx, cy, sw + 1, 1, flip ? '#e8fbff' : '#c6cec9');
      px(cx, cy + 1, 1, 2, flip ? '#9fe0f2' : shade('#aab4b0', -0.24));
      if (flip) bloom(cx - 1, cy - 1, sw + 3, 5, ACC.data, 0.32);
    }
    // the carriage itself, riding a rail across the top of the well
    px(wx + 1, wy + 1, ww - 2, 1, shade(r.face, -0.44));
    px(carX, wy, 4, 3, LINE); px(carX + 1, wy + 1, 2, 1, shade(r.top, 0.22));
    px(carX + 1, wy + 2, 2, 1, tt >= 1 ? ACC.data : shade(ACC.data, -0.5));
    bloom(carX + 1, wy + 2, 2, 1, ACC.data, tt >= 1 ? 0.30 : 0.14);
    const sweep = wx + 2 + Math.floor((now / (on ? 20 : 34)) % (ww - 5));   // kept 1px query sweep
    glow(sweep, wy + 1, 1, wh - 2, '#cfe0dc', 0.34);
    scanl(wx + 1, wy + 1, ww - 2, wh - 2, 0.16);
    // EAST — lookup readout: the call number ticking over, plus the two kept status dots
    const rx0 = x + 39;
    inset(rx0, wy, 7, wh, '#0a120f');
    for (let j = 0; j < 4; j++) {
      const lw = 1 + ((U.hash('cn' + land + j) % 4));
      px(rx0 + 1, wy + 2 + j * 2, Math.min(lw + 1, 5), 1, on ? shade(ACC.data, -0.10) : shade(ACC.data, -0.52));
    }
    bloom(rx0 + 1, wy + 2, 5, 7, ACC.data, on ? 0.14 : 0.07);
    px(rx0 + 1, wy + wh - 2, 1, 1, ACC.flow);                     // kept steady amber
    bloom(rx0 + 1, wy + wh - 2, 1, 1, ACC.flow, 0.30);
    px(rx0 + 5, wy + wh - 2, 1, 1, blink(700, ph) ? '#dfe6e2' : '#3a423e');   // kept blinking silver
    wear(x + 2, bt + 2, w - 4, bh - 4, 5, shade(r.face, -0.10));
  };
  F.arc_microfiche = (x, y, w, h, f) => {
    // MICROFICHE (2x1, blocks:true) — v4. Bolted reader desk. The reels are now ASYMMETRIC — a fat feed reel
    // west, a lean take-up east — and they notch in OPPOSITE directions, so the film has a readable direction
    // of travel instead of two identical discs twitching. The frame in the viewport steps sideways with each
    // advance and the flash-scan runs across it. Kept: the 2.2s notch cycle, the advancing flicker, f.work
    // driving the lamp brighter, the engraved label plate, and the ready-LED timings.
    const r = RAMP.gun, ph = (f && f.x) || 0;
    const step = Math.floor(now / 2200), advancing = (now % 2200) < 260, lit = !!(f && f.work);
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, lit);
    cable(x + w - 2, y + 7, x + w + 2, y + h - 3, 2.2);
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // short front face with the engraved silver label plate (kept)
    rr(x - 1, y + 4, w + 2, 6, LINE);
    px(x, y + 5, w, 3, r.face);
    px(x, y + 5, w, 1, r.lit); keyEdge(x + 1, y + 5, w - 3, 1, 0.15);
    px(x, y + 7, w, 1, r.ao);
    px(x + 6, y + 6, w - 13, 1, '#adb3b0'); px(x + 6, y + 6, w - 13, 1, shade('#adb3b0', 0.10));
    for (let i = 0; i < w - 16; i += 3) px(x + 8 + i, y + 6, 2, 1, '#63676a');   // engraved text
    rimEdge(x + w - 7, y + 6, 1, 1, 0.24);
    // desk slab
    chamf(x - 1, y - 1, w + 2, 7, LINE, 2);
    chamf(x, y, w, 5, r.top, 2);
    px(x + 2, y, w - 4, 1, r.sheen); keyEdge(x + 2, y, 8, 1, 0.28);
    px(x, y + 2, 1, 2, r.lit); px(x + w - 1, y + 2, 1, 2, r.dk);
    rimEdge(x + w - 1, y + 2, 1, 2, 0.20);
    px(x + 2, y + 4, w - 4, 1, shade(r.top, -0.18));
    wear(x + 1, y + 1, w - 2, 4, 3, shade(r.top, -0.10));
    dial(x + w - 5, y + 1, r.top, now / 1100 + ph);               // focus knob on the desk
    // reader housing standing on the slab, with a HOOD shading the glass
    chamf(x + 1, y - 12, w - 2, 13, LINE, 2);
    chamf(x + 2, y - 11, w - 4, 11, r.face, 2);
    px(x + 3, y - 11, w - 6, 1, r.top); keyEdge(x + 3, y - 11, 7, 1, 0.26);
    px(x + 2, y - 9, 1, 8, shade(r.face, 0.08)); px(x + w - 3, y - 9, 1, 8, r.dk);
    rimEdge(x + w - 3, y - 9, 1, 8, 0.22);
    px(x + 3, y, w - 6, 1, r.ao);                                 // housing AO onto the slab
    // FROSTED VIEWPORT under a jutting hood
    const vx = x + 9, vy = y - 8, vw = 6, vh = 7;
    px(vx - 2, vy - 2, vw + 4, 2, LINE); px(vx - 1, vy - 2, vw + 2, 1, shade(r.top, 0.14));
    keyEdge(vx - 1, vy - 2, 4, 1, 0.24);
    px(vx - 1, vy - 1, vw + 2, 1, r.ao);                          // the hood's shadow across the glass top
    inset(vx - 1, vy, vw + 2, vh, '#2f3b39');
    const base = lit ? 0.36 : 0.15;
    const flk = advancing ? 0.16 * Math.abs(flick(70)) : 0.05 * Math.sin(now / 500);
    px(vx, vy + 1, vw, vh - 2, lit ? '#5d706d' : '#394644');      // lamp field, never a black hole
    const fx = vx + (step % 3);                                   // the document frame steps sideways
    px(fx, vy + 1, 4, vh - 2, lit ? '#c2d0cf' : '#8e9a99');
    for (let j = 0; j < 3; j++) px(fx + 1, vy + 2 + j * 2, 1 + (U.hash('mf' + step + j) % 3), 1, lit ? '#4a5654' : '#5f6a68');
    if (advancing) px(vx, vy + 1 + (step % (vh - 2)), vw, 1, '#eef6f5');
    bloom(vx, vy + 1, vw, vh - 2, '#cfe0de', base + flk);
    spill(vx - 1, vy + vh, vw + 2, '#cfe0de', lit ? 0.16 : 0.07, 3);
    // ASYMMETRIC reels — fat feed west, lean take-up east, notching opposite ways
    const ry = y - 5;
    for (let b = 0; b < 2; b++) {
      const cx = b ? x + w - 5 : x + 5, rad = b ? 2 : 3, o = (b ? -step : step) & 3;
      px(cx - rad, ry - rad, rad * 2, rad * 2, '#666c6c');
      px(cx - rad + 1, ry - rad + 1, rad * 2 - 2, rad * 2 - 2, '#98a09f');
      px(cx - rad + 1, ry - rad + 1, rad * 2 - 2, 1, shade('#98a09f', 0.22));
      rimEdge(cx + rad - 1, ry - rad + 1, 1, rad * 2 - 2, 0.22);
      if (o === 0) px(cx - rad + 1, ry, rad * 2 - 2, 1, '#d6dada');
      else if (o === 1) px(cx, ry - rad + 1, 1, rad * 2 - 2, '#d6dada');
      else if (o === 2) { px(cx - 1, ry - 1, 1, 1, '#d6dada'); px(cx + 1, ry + 1, 1, 1, '#d6dada'); }
      else { px(cx + 1, ry - 1, 1, 1, '#d6dada'); px(cx - 1, ry + 1, 1, 1, '#d6dada'); }
      px(cx, ry, 1, 1, '#454b4b');
    }
    // film threaded across the housing crown, upper strand bright as it pulls
    px(x + 7, ry - 4, w - 14, 1, advancing ? '#e4e8e8' : '#b0b6b6');
    for (let i = 0; i < w - 14; i += 2) px(x + 7 + i, ry - 4, 1, 1, shade('#b0b6b6', -0.40));   // sprocket holes
    px(x + 7, ry + 3, w - 14, 1, shade('#b0b6b6', -0.26));      // slack lower strand
    const on2 = lit ? blink(900, ph) : blink(2600, ph);           // kept ready-LED timings
    px(x + w - 5, y - 10, 1, 1, on2 ? ACC.work : '#16302a');
    if (on2) bloom(x + w - 5, y - 10, 1, 1, ACC.work, 0.34);
  };
  F.arc_floorlight = (x, y, w, h, f) => {   // v4 deck light — FLAT recessed ring; the only rise is the light itself
    // Walk-over prop: everything here sits at or below the deck plane. v4 only changes falloff — v3 stamped
    // two flat alpha rects, which read as a translucent sticker lying on the floor rather than as a lamp.
    const cx = x + (w >> 1);
    const well = [[3, 6], [2, 8], [1, 10], [1, 10], [1, 10], [1, 10], [2, 8], [3, 6]];
    well.forEach((s, j) => px(x + s[0], y + 2 + j, s[1], 1, '#171b19'));
    px(x + 3, y + 2, 6, 1, '#101413');                          // deep top lip — light never reaches in here
    px(x + 3, y + 9, 6, 1, shade('#1f2422', 0.12));           // bottom bevel catch (kept)
    const ring = [[3, 6], [2, 8], [2, 8], [2, 8], [2, 8], [3, 6]];
    ring.forEach((s, j) => px(x + s[0], y + 3 + j, s[1], 1, '#2a302d'));
    px(x + 3, y + 3, 6, 1, '#3d4a43'); keyEdge(x + 3, y + 3, 4, 1, 0.22);   // ring north arc takes the key
    px(x + 2, y + 4, 1, 4, '#333e38'); px(x + 9, y + 4, 1, 4, '#1c2220');
    rimEdge(x + 9, y + 4, 1, 4, 0.22);                          // cold bounce on the east arc
    px(x + 3, y + 4, 1, 1, '#48544c'); px(x + 8, y + 4, 1, 1, '#48544c');   // bezel bolts
    px(x + 3, y + 7, 1, 1, '#1f2622'); px(x + 8, y + 7, 1, 1, '#1f2622');
    // LENS. v4 filled the well with a 6x4 slab of neutral #dfe2e0 and two blooms, which is a white pill
    // lying on the deck — no colour to say "lamp" and no internal structure to say "lens". Two changes fix
    // it: the light is COOL (this deck's own aisle lighting, not paper), and the lens carries FRESNEL RIBS,
    // which is the one detail that reads as an optic at any size.
    // Also STEADY. It used to breathe on a 1300ms clock, and an aisle lamp has no mechanism that breathes —
    // idle is not "dead" here, it is simply a lamp that is on.
    const LENS = '#79b4cc';
    const lens = [[4, 4], [3, 6], [3, 6], [4, 4]];
    lens.forEach((s, j) => px(x + s[0], y + 4 + j, s[1], 1, shade(LENS, -0.30)));
    px(x + 3, y + 5, 6, 1, shade(LENS, 0.22)); px(x + 3, y + 6, 6, 1, shade(LENS, -0.52));  // fresnel ribs
    px(x + 4, y + 5, 2, 1, shade(LENS, 0.50));                // hot inner glint, west-biased
    bloom(x + 3, y + 4, 6, 4, LENS, 0.16);                      // real falloff onto the surrounding plating
    px(x + 4, y + 7, 4, 1, shade(LENS, -0.10));               // the lens's south face, back toward the bezel
    px(cx - 2, y + 10, 1, 1, '#56706e'); px(cx + 1, y + 10, 1, 1, '#56706e');   // aisle chevron (kept)
    px(cx - 1, y + 11, 2, 1, '#56706e');
  };
  F.arc_ladder = (x, y, w, h, f) => {   // v4 ladder — bold diagonal LEANING on the wall; feet-only floor contact
    // blocks:false, so it must not read as a solid mass parked on the deck: it leans, its footprint is two
    // rubber feet, and its shadow lives only under those feet. The diagonal is the entire silhouette.
    const r = RAMP.steel;
    ctx.globalAlpha = 0.20; px(x, y + 11, 10, 1, '#000'); ctx.globalAlpha = 1;   // feet contact only
    const foot = y + 10, rows = 18;
    const xoAt = (i) => Math.round(i * 4 / (rows - 1));         // eastward lean drift
    for (let i = 0; i < rows; i++) {                            // pass 1: rail silhouettes
      const xo = xoAt(i), yy = foot - i;
      px(x + xo, yy, 4, 1, LINE); px(x + 6 + xo, yy, 4, 1, LINE);
    }
    px(x + xoAt(rows - 1), foot - rows, 4, 1, LINE);
    px(x + 6 + xoAt(rows - 1), foot - rows, 4, 1, LINE);
    for (const i of [3, 7, 11, 15]) {                           // pass 2: rungs, sunk between the rails
      const xo = xoAt(i), yy = foot - i;
      px(x + 2 + xo, yy - 1, 8, 3, LINE);
      px(x + 3 + xo, yy, 4, 1, r.sheen);
      px(x + 3 + xo, yy, 1, 1, shade(r.sheen, 0.14));
      keyEdge(x + 3 + xo, yy, 2, 1, 0.20);                      // warm key along the tread
      px(x + 3 + xo, yy + 1, 4, 1, r.ao);                       // the rung casts its own underside shadow
    }
    for (let i = 0; i < rows; i++) {                            // pass 3: rail faces, in front of the rungs
      const xo = xoAt(i), yy = foot - i;
      px(x + 1 + xo, yy, 1, 1, r.lit); px(x + 2 + xo, yy, 1, 1, r.face);
      px(x + 7 + xo, yy, 1, 1, r.face); px(x + 8 + xo, yy, 1, 1, r.dk);
    }
    rimEdge(x + 8 + xoAt(6), foot - 12, 1, 12, 0.16);           // cold sky bounce down the east rail
    px(x + 1 + xoAt(rows - 1), foot - rows + 1, 2, 1, r.sheen);
    px(x + 7 + xoAt(rows - 1), foot - rows + 1, 2, 1, r.sheen);
    px(x + 1, foot, 2, 1, '#1a1e22'); px(x + 7, foot, 2, 1, '#1a1e22');   // rubber feet
    px(x + 7, y + 3, 1, 2, '#39434b');                          // hazard tag on a string
    px(x + 6, y + 5, 3, 3, '#caa84a'); px(x + 6, y + 5, 3, 1, '#ffd34a');
    px(x + 7, y + 6, 1, 1, '#3a3020');
    // A specular is the ceiling strip reflected in the rail. Both the ladder and the strip are bolted down, so
    // the highlight CANNOT crawl — it sat on a 700ms clock climbing 15 rungs, which read as a scanning sensor.
    bloom(x + 1 + xoAt(9), foot - 9, 1, 1, '#eaf2f2', 0.20);        // one fixed catch mid-rail
    px(x + 1 + xoAt(rows - 4), foot - rows + 4, 1, 1, '#c9d4d4');   // fixed catch near the head
  };
  F.quarters_pooltable = (x, y, w, h, f) => {
    /* ⛔ EDGES SOFTENED, NOTHING ELSE — shipped geometry, shading and colour untouched. The
       universal near-black contour becomes a dark tint so the prop stops reading as a sticker
       cut out and laid on the deck. Same EDGE the couch uses, so the lounge reads as one room. */
    const EDGE = '#161d22';
    // v4 BILLIARDS (4x2) — TOP-BIAS OBLIQUE: we look DOWN on the bed, this is never a front elevation.
    // It shares a room with F.pokertable, also 4x2 and also a felt table, so the two are separated on
    // FOUR axes at once and the first one lands before any pixel of felt reads:
    //   silhouette  a LOW PENDANT BAR hanging in the room over the bed   (poker: nothing overhead)
    //   base        four chunky square corner legs                       (poker: one turned pedestal)
    //   rail        crisp rectangular mahogany with diamond sights       (poker: padded black oval, studs)
    //   felt        green under warm tungsten                            (poker: indigo under low ambient)
    // Freestanding lounge tier throughout — no deckplate, no floor socket, no bolted language.
    const r = RAMP.steel, ph = (f && f.x) || 0;
    const wood = '#5c4030', felt = '#2f5d3a', feltLit = '#3c7048';
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 6]) {                    // four square corner legs (front pair visible)
      px(lx, y + 20, 4, 4, EDGE);
      px(lx, y + 20, 1, 4, shade(wood, 0.20)); px(lx + 1, y + 20, 2, 4, shade(wood, -0.10));
      px(lx + 3, y + 20, 1, 4, shade(wood, -0.34)); rimEdge(lx + 3, y + 20, 1, 3, 0.16);
      px(lx, y + 23, 4, 1, '#0a0d10');
    }
    underAO(x + 6, y + 20, w - 12, 3);
    // apron under the bed — routed beading, warm catch under the rail's overhang
    chamf(x - 1, y + 13, w + 2, 7, EDGE, 2);
    px(x, y + 14, w, 5, shade(wood, -0.16));
    px(x, y + 14, w, 1, shade(wood, 0.12)); keyEdge(x + 1, y + 14, w - 5, 1, 0.14);
    px(x, y + 15, 1, 4, shade(wood, 0.06)); px(x + w - 1, y + 15, 1, 4, shade(wood, -0.32));
    rimEdge(x + w - 1, y + 15, 1, 4, 0.20);
    for (let i = 0; i < 3; i++) px(x + 8 + i * 15, y + 16, 9, 1, shade(wood, -0.32));
    px(x, y + 18, w, 1, shade(wood, -0.46));
    // RECTANGULAR mahogany rail ring — chamf k=1 keeps the corners crisp; the oval read belongs to poker
    chamf(x - 1, y - 4, w + 2, 19, EDGE, 1);
    chamf(x, y - 3, w, 17, wood, 1);
    px(x + 1, y - 3, w - 2, 1, shade(wood, 0.34)); keyEdge(x + 2, y - 3, 12, 1, 0.28);
    px(x, y - 1, 1, 14, shade(wood, 0.14)); px(x + w - 1, y - 1, 1, 14, shade(wood, -0.30));
    rimEdge(x + w - 1, y - 1, 1, 14, 0.20);
    px(x + 1, y + 12, w - 2, 1, shade(wood, -0.24));        // rail front lip
    for (let i = 0; i < 6; i++) {                             // diamond sight inlays — pure billiards vocabulary
      px(x + 6 + i * 7, y - 2, 1, 1, shade(wood, 0.50));
      px(x + 6 + i * 7, y + 11, 1, 1, shade(wood, 0.34));
    }
    for (let i = 0; i < 4; i++) px(x + 4 + i * 12, y - 1, 7, 1, shade(wood, 0.10));   // grain along the rail
    // FELT BED
    inset(x + 4, y + 1, w - 8, 11, shade(felt, -0.40));
    px(x + 5, y + 2, w - 10, 9, felt);
    for (let i = 0; i < 9; i++) {                             // west-lit diagonal nap gradient (kept)
      const litw = Math.max(0, Math.floor((w - 10) * (1 - i / 9)) - i * 2);
      if (litw > 0) px(x + 5, y + 2 + i, Math.min(litw, w - 10), 1, feltLit);
    }
    px(x + 5, y + 2, w - 10, 1, shade(feltLit, 0.14));      // nap sheen along the head cushion
    px(x + 5, y + 10, w - 10, 1, shade(felt, -0.28));       // cushion shadow at the near rail
    // SIX POCKETS cut through the rail — jaw, drop and a brass ring, not a black square
    const pk = [[x + 3, y], [x + (w >> 1) - 2, y - 1], [x + w - 8, y],
                [x + 3, y + 9], [x + (w >> 1) - 2, y + 10], [x + w - 8, y + 9]];
    for (const p of pk) {
      chamf(p[0], p[1], 5, 4, '#0d1310', 1);
      px(p[0] + 1, p[1], 3, 1, shade(wood, -0.46));         // shadowed jaw
      px(p[0] + 1, p[1] + 1, 3, 2, '#04070a');                // the drop
      px(p[0], p[1] + 3, 5, 1, shade(wood, 0.20));          // brass pocket ring
    }
    // BALLS — the 8-ball still drifts on its 1400ms clock (kept)
    const drift = Math.round(Math.sin(now / 1400 + ph));
    const balls = [[x + 12, y + 4, '#e8e2d2'], [x + (w >> 1) + 1 + drift, y + 6, '#15161a'],
                   [x + w - 15, y + 4, '#a83a32'], [x + 11, y + 8, '#3a5aa8'],
                   [x + w - 13, y + 8, '#caa84a'], [x + (w >> 1) - 6, y + 8, '#3a6a8a'],
                   [x + 21, y + 3, '#4a8a4a']];
    for (const b of balls) {
      px(b[0], b[1] + 2, 3, 1, shade(felt, -0.36));         // contact shadow ON the felt
      chamf(b[0], b[1], 3, 3, b[2], 1);
      px(b[0], b[1], 2, 1, shade(b[2], 0.28));
      px(b[0], b[1], 1, 1, shade(b[2], 0.50));              // soft catch — a white speck reads as a dead pixel
      px(b[0] + 2, b[1] + 2, 1, 1, shade(b[2], -0.36));
      rimEdge(b[0] + 2, b[1] + 1, 1, 1, 0.16);
    }
    // a CUE left lying across the bed — the only line on the whole prop that isn't parallel to a rail
    for (let i = 0; i < 26; i++)
      px(x + 9 + i, y + 10 - Math.round(i * 0.3), 1, 1,
         i < 4 ? '#1c2228' : i < 8 ? '#7a6a4a' : shade('#c9a878', 0.02 + i * 0.004));
    px(x + 17, y - 2, 2, 2, '#3d6a5a'); px(x + 17, y - 2, 2, 1, '#548a76');   // chalk cube on the rail
    for (let i = 0; i < 5; i++) {                                             // triangle rack hung on the rail
      px(x + 24 + i, y - 3 + i, 1, 1, shade(wood, 0.40));
      px(x + 32 - i, y - 3 + i, 1, 1, shade(wood, 0.24));
    }
    // LOW PENDANT BAR — cords, spine, three cone shades. This is the silhouette that does the work.
    for (const cx0 of [x + 14, x + w - 15]) px(cx0, y - 17, 1, 6, '#0b1114');
    chamf(x + 8, y - 12, w - 16, 3, EDGE, 1);
    px(x + 9, y - 11, w - 18, 2, r.face); px(x + 9, y - 11, w - 18, 1, r.lit);
    keyEdge(x + 10, y - 11, 10, 1, 0.24);
    px(x + 9, y - 10, w - 18, 1, shade(r.face, -0.36));
    const pulse = 0.28 + 0.16 * (0.5 + 0.5 * Math.sin(now / 760 + ph));   // kept lamp clock
    for (let s = 0; s < 3; s++) {
      const sx0 = x + 8 + s * 14;
      for (let j = 0; j < 4; j++) {                            // cone shade, widening as it drops
        px(sx0 + 3 - j - 1, y - 9 + j, 5 + j * 2, 1, EDGE);
        px(sx0 + 3 - j, y - 9 + j, 3 + j * 2, 1, j ? shade(r.face, 0.04) : r.lit);
      }
      keyEdge(sx0 + 2, y - 9, 3, 1, 0.24);
      px(sx0 + 8, y - 7, 1, 2, r.dk); rimEdge(sx0 + 8, y - 7, 1, 2, 0.20);
      px(sx0, y - 6, 9, 1, '#ffdca6');                         // the lit mouth of the shade
      bloom(sx0, y - 6, 9, 1, KEY, 0.30);
      spill(sx0, y - 5, 9, KEY, 0.18, 4);                      // the cone of light on its way down
    }
    for (let s = 0; s < 3; s++) {                              // three warm pools landing on the felt
      const sx0 = x + 8 + s * 14;
      glow(sx0 - 1, y + 1, 11, 9, '#ffb84d', pulse * 0.28);
      glow(sx0 + 1, y + 3, 7, 5, '#ffb84d', pulse * 0.24);
    }
    for (const p of pk) glow(p[0], p[1], 5, 4, '#ffb84d', pulse * 0.30);   // pocket liners take the lamp (kept)
  };
  F.quarters_vending = (x, y, w, h, f) => {
    /* ⛔ EDGES SOFTENED, NOTHING ELSE — shipped geometry, shading and colour untouched. The
       universal near-black contour becomes a dark tint so the prop stops reading as a sticker
       cut out and laid on the deck. Same EDGE the couch uses, so the lounge reads as one room. */
    const EDGE = '#161d22';
    // v4 VENDING (1x2) — TALL 3/4, freestanding. The other backlit prop in this room is the fishtank, and
    // the two must not share a light: water is caustic and moving, chilled glass is FLAT cold fluorescent
    // behind product rows. So the interior here is a dead-even tube per shelf with the stock silhouetted
    // against it, and the only warm light on the whole machine is the header and the dispense mouth —
    // two temperatures, 20px apart, which is the strongest depth cue this narrow a prop can get.
    // f.work = the station is busy: the READY lamp burns hotter. Header/chase/ready clocks all preserved.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const cw = w + 1, cold = '#cfe9f5', amber = '#ffb84d';   // the cabinet runs a touch proud of its tile (kept)
    shadow2(x + 1, y + h - 1, cw - 2);
    cable(x + cw - 2, y + 19, x + cw, y + h - 2, 2);         // limp power lead — freestanding, so NO floor socket
    // TALL 3/4 casing: chamfered slab, warm key down the west facet, cool sky bounce down the east
    chamf(x - 1, y - 6, cw + 2, h + 5, EDGE, 2);
    chamf(x, y - 5, cw, h + 3, r.face, 2);
    px(x, y - 3, 1, h - 2, shade(r.face, 0.10)); keyEdge(x, y - 3, 1, 10, 0.12);
    px(x + cw - 1, y - 3, 1, h - 2, r.dk); rimEdge(x + cw - 1, y - 3, 1, h - 2, 0.22);
    chamf(x, y - 9, cw, 4, EDGE, 1);                         // crown cap we look down on
    px(x + 1, y - 8, cw - 2, 2, r.top); px(x + 1, y - 8, cw - 2, 1, r.sheen);
    keyEdge(x + 1, y - 8, 6, 1, 0.26);
    px(x + 1, y - 6, cw - 2, 1, shade(r.top, -0.24));
    // LIT BRAND HEADER, jutting proud — the warm half of the temperature split
    const hb = blink(1600);
    chamf(x - 2, y - 5, cw + 4, 4, EDGE, 1);
    px(x - 1, y - 4, cw + 2, 2, hb ? amber : '#8a5f28');
    px(x + 1, y - 4, 4, 1, '#ffe2b0');                       // header glint (kept)
    bloom(x - 1, y - 4, cw + 2, 2, amber, hb ? 0.30 : 0.12);
    spill(x - 1, y - 2, cw + 2, amber, 0.16, 3);             // warm wash falling onto the glass frame
    px(x - 1, y - 2, cw + 2, 1, shade('#8a5f28', -0.42));  // header underside
    // GLASS: three shelves, each on its own flat tube, stock read as SILHOUETTE not as colour
    inset(x + 2, y - 1, 8, 15, '#0b1418');
    px(x + 3, y, 6, 13, '#16323c');                          // lit back wall of the cabinet
    for (let row = 0; row < 3; row++) {
      const ry = y + row * 4;
      px(x + 3, ry, 6, 1, cold);                             // shelf tube — deliberately NOT wavering
      bloom(x + 3, ry, 6, 1, cold, 0.24);
      for (let c = 0; c < 3; c++) {
        const seed = U.hash('vend' + row + c);               // kept seed so the stock layout never reshuffles
        const base = seed % 2 === 0 ? '#7a2e2e' : '#1f5a63';
        px(x + 3 + c * 2, ry + 1, 2, 2, shade(base, -0.34));
        px(x + 3 + c * 2, ry + 1, 1, 2, shade(base, 0.12));   // cold rim on the backlit edge
        px(x + 3 + c * 2, ry + 1, 2, 1, shade(base, 0.26));   // cap glint
      }
      for (let i = 0; i < 6; i += 2)                         // delivery coil in FRONT of the row —
        px(x + 3 + i, ry + 1 + ((i >> 1) & 1), 1, 1, shade(cold, -0.38));   // this is what says vending, not shelf
      px(x + 3, ry + 3, 6, 1, '#0e2029');                    // shelf lip in its own shadow
    }
    px(x + 3, y + 12, 6, 1, '#0a1a20');                      // one sold-out slot at the bottom
    ctx.globalAlpha = 0.12; px(x + 3, y - 1, 2, 9, '#dff4ff'); px(x + 6, y - 1, 1, 5, '#dff4ff'); ctx.globalAlpha = 1;
    spill(x + 2, y + 13, 8, cold, 0.16, 3);                  // chilled glass pools cold light down the front
    // CONTROL PILLAR east: coin slot, keypad, and the READY lamp that reads f.work
    px(x + 10, y - 1, 2, 15, shade(r.face, 0.06));
    px(x + 10, y - 1, 1, 15, shade(r.face, 0.20)); px(x + 11, y - 1, 1, 15, r.dk);
    rimEdge(x + 11, y - 1, 1, 15, 0.18);
    px(x + 10, y, 2, 1, '#0d1216'); px(x + 10, y + 1, 2, 1, shade(r.face, 0.28));   // coin slot + its lit lip
    for (let i = 0; i < 4; i++) px(x + 10, y + 3 + i * 2, 2, 1, '#9aa49c');           // keypad rows
    const ready = blink(620);
    px(x + 10, y + 12, 1, 1, ready ? (on ? '#7dffb0' : ACC.work) : '#16302a');
    if (ready) bloom(x + 10, y + 12, 1, 1, ACC.work, on ? 0.34 : 0.18);
    // scrolling amber chase strip (clock kept 1:1)
    const sy = y + 14, segs = 5, off = Math.floor(now / 140) % segs;
    px(x + 2, sy, cw - 4, 2, '#241c10');
    for (let s = 0; s < segs; s++) {
      const seg = ((s + off) % 3) !== 0;
      px(x + 2 + s * 2, sy, 2, 1, seg ? amber : '#4a3a1c');
      px(x + 2 + s * 2, sy + 1, 2, 1, seg ? '#b8862f' : '#33290f');
    }
    bloom(x + 2, sy, cw - 4, 2, amber, 0.15 + 0.07 * (0.5 + 0.5 * flick(900, ph)));
    // DISPENSE MOUTH — deep, warm, and with a can actually sitting in the tray waiting to be taken
    chamf(x + 2, y + 17, cw - 4, 5, EDGE, 1);
    px(x + 3, y + 17, cw - 6, 1, shade(r.face, 0.22)); keyEdge(x + 4, y + 17, cw - 9, 1, 0.16);
    px(x + 3, y + 18, cw - 6, 3, '#0d1110');
    px(x + 3, y + 18, cw - 6, 1, shade(r.face, -0.46));    // the lip you reach under
    bloom(x + 4, y + 19, cw - 8, 1, amber, 0.15 + 0.05 * flick(1300, 1));
    px(x + 5, y + 19, 2, 2, '#7a2e2e'); px(x + 5, y + 19, 1, 2, '#a04a44'); px(x + 5, y + 19, 2, 1, '#8a98a8');
    // kick plate + feet with a real floor gap
    px(x + 1, y + 21, cw - 2, 1, r.ao);
    underAO(x + 2, y + 22, cw - 4, 1);
    px(x + 1, y + 22, 2, 2, r.dk); px(x + cw - 3, y + 22, 2, 2, r.dk);
    px(x + 1, y + 22, 1, 1, r.lit); px(x + cw - 3, y + 22, 1, 1, r.lit);
    wear(x + 1, y + 15, cw - 2, 6, 3, shade(r.face, -0.12));
  };
  F.quarters_lockerbank = (x, y, w, h, f) => {
    /* ⛔ EDGES SOFTENED, NOTHING ELSE — shipped geometry, shading and colour untouched. The
       universal near-black contour becomes a dark tint so the prop stops reading as a sticker
       cut out and laid on the deck. Same EDGE the couch uses, so the lounge reads as one room. */
    const EDGE = '#161d22';
    // LOCKER BANK (3x1) — v7. Two things had to change together, and neither is detail.
    //
    // (1) THE LINES. v6 filled the tall carcass with HORIZONTALS: a five-pair louvre stack down every
    //     door, a swage across the middle, a crown band, a wide name plate. Evenly spaced horizontals
    //     over a tall face is the signature of a SERVER RACK — the family this prop stands beside in
    //     the catalog. Lockers are read from their VERTICALS, so the horizontals are cut to one short
    //     vent at the head of each door and every door now carries a full-height HANDLE BAR.
    // (2) THE DOOR RATIO. Three doors across 36px gives each a 10x18 face — barely 1:1.8, which is a
    //     kitchen cupboard. A locker door is at least twice as tall as it is wide. FOUR doors at 8px
    //     over a 24-row bank gets to 1:3 and the prop stops arguing about what it is.
    //
    // Also gone: the crown junk (towel, helmet, ration tins) and half the spill inside the open door.
    // None of it resolved at 3x and all of it competed with the doors for the eye.
    const r = RAMP.gun;
    const dT = y - 15, dH = 24, cT = y - 20;                  // door bank top / height, crown top
    const STILE = '#121816';                                  // the deep gap between doors
    const FACE = shade(r.face, 0.26);                       // door faces sit ABOVE the carcass ramp
    const NDOOR = 4, DW = 8, PITCH = 9, OPEN = 2;             // the open one, counting from the west
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + (w >> 1) - 1, x + w - 5]) {  // three feet along the long footprint
      px(lx, y + 8, 3, 4, EDGE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 3, 0.16);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // ---- CROWN. A tall cabinet still shows a sliver of its TOP from this camera, so the crown is a
    // real foreshortened surface — but a shallow one, and BARE. Stacking gear on it added three more
    // horizontal blocks right where the eye enters the prop.
    chamf(x - 1, cT, w + 2, 6, EDGE, 2);
    px(x, cT + 1, w, 4, r.top);
    px(x, cT + 1, w, 1, r.sheen); keyEdge(x + 1, cT + 1, 10, 1, 0.28);
    px(x, cT + 2, 1, 3, r.lit); px(x + w - 1, cT + 2, 1, 3, r.dk); rimEdge(x + w - 1, cT + 2, 1, 3, 0.20);
    px(x + 1, cT + 4, w - 2, 1, shade(r.top, -0.20));       // front lip of the crown
    px(x + 6, cT + 2, 9, 1, shade(r.top, 0.10));            // one wipe mark, so the top isn't a blank
    // ---- DOOR BANK
    chamf(x - 1, dT - 1, w + 2, dH + 2, EDGE, 2);
    px(x, dT, w, dH, STILE);                                  // the carcass reads as the gaps behind
    px(x, dT, w, 1, r.lit); keyEdge(x + 1, dT, w - 5, 1, 0.16);   // catch under the crown overhang
    for (let d = 0; d < NDOOR; d++) {
      const dx = x + 1 + d * PITCH;
      if (d === OPEN) continue;                               // the open one is built separately below
      // THE DOOR — one tall panel, and its EDGES are the subject: lit west stile, dark east stile,
      // with the carcass colour providing the shadow gap either side for free.
      px(dx, dT + 1, DW, dH - 3, FACE);
      px(dx, dT + 1, DW, 1, shade(FACE, 0.26));             // the door's own top edge
      px(dx, dT + 1, 1, dH - 3, shade(FACE, 0.22)); keyEdge(dx, dT + 2, 1, dH - 6, 0.18);
      px(dx + DW - 1, dT + 1, 1, dH - 3, shade(FACE, -0.34)); rimEdge(dx + DW - 1, dT + 2, 1, dH - 6, 0.20);
      px(dx, dT + dH - 3, DW, 1, shade(FACE, -0.38));
      for (let v = 0; v < 3; v++) {                           // ONE short vent at the head of the door
        px(dx + 2, dT + 3 + v * 2, 4, 1, shade(FACE, -0.52));
        px(dx + 2, dT + 4 + v * 2, 4, 1, shade(FACE, 0.20));
      }
      // FULL-HEIGHT HANDLE BAR — the vertical that says "this pulls open", and the strongest anti-rack
      // cue available: a rack door has a latch, never a stile-length bar.
      px(dx + DW - 3, dT + 10, 2, dH - 16, '#0b100e');
      px(dx + DW - 3, dT + 10, 1, dH - 16, '#8b968f');
      px(dx + DW - 3, dT + 10, 1, 3, '#b9c3bc');              // a glint at the top of the bar
      px(dx + 1, dT + 11, 3, 3, shade(FACE, -0.30));        // a small recessed name card
      px(dx + 1, dT + 11, 3, 1, shade(FACE, -0.50));
      wear(dx + 1, dT + 3, DW - 2, dH - 8, 4, shade(FACE, -0.16));
    }
    // ---- the OPEN door — the read that separates a locker bank from a fence. Its interior is a dim
    // green-grey, not a hole: pure black at this size is a gap in the prop, not a space inside it.
    const dx1 = x + 1 + OPEN * PITCH;
    px(dx1, dT + 1, DW, dH - 3, '#161d1a');
    px(dx1 + 1, dT + 2, DW - 2, dH - 5, '#1d2622');           // the lit back panel of the cavity
    px(dx1, dT + 1, DW, 1, '#0a0f0d');
    px(dx1 + 1, dT + 9, DW - 2, 1, shade(r.face, -0.40));   // ONE shelf, barely catching light
    px(dx1 + 1, dT + 10, DW - 2, 1, '#0b100e');
    px(dx1 + 1, dT + 2, 5, 6, '#3a4632'); px(dx1 + 1, dT + 2, 5, 1, '#54644a');   // a coat on the rail
    px(dx1 + 2, dT + 3, 1, 5, shade('#3a4632', -0.34));
    px(dx1 + 1, dT + 15, 5, 4, '#2b2118'); px(dx1 + 1, dT + 15, 5, 1, '#463527'); // boots on the floor pan
    px(dx1 + 2, dT + 19, 3, 1, shade('#2b2118', -0.34));
    px(dx1 - 4, dT + 1, 4, dH - 3, EDGE);                     // the leaf, swung west across its neighbour
    px(dx1 - 3, dT + 2, 3, dH - 5, shade(FACE, 0.14));
    px(dx1 - 3, dT + 2, 3, 1, shade(FACE, 0.30)); keyEdge(dx1 - 3, dT + 2, 3, 1, 0.22);
    px(dx1 - 1, dT + 2, 1, dH - 5, shade(FACE, -0.42));     // the leaf's shaded inner face
    px(dx1 - 3, dT + 10, 1, 7, '#8b968f');                    // its handle bar, riding round with it
    ctx.globalAlpha = 0.26; px(dx1 - 6, dT + 3, 2, dH - 7, '#000'); ctx.globalAlpha = 1;   // its cast shadow
    // one amber name-tag, BACKLIT AND STEADY, and SMALL. A name plate has nothing to report, so pulsing
    // it would be the locker bank pretending to be an instrument panel — and at 7x3 with a 0.44 bloom
    // it was the brightest object on a cosmetic prop, out-shouting real telemetry elsewhere in the room.
    inset(x + 29, dT + 15, 4, 3, '#10161a');
    px(x + 30, dT + 16, 2, 1, shade('#ffb84d', -0.34));
    bloom(x + 30, dT + 16, 2, 1, '#ffb84d', 0.13);           // bloom lays 3 rings: 0.22 spread to ~6x5
    px(x + 3, dT + 19, 3, 2, '#b56a78'); px(x + 3, dT + 19, 3, 1, '#c98592');   // door 0: worn pink sticker
    px(x, y + 8, w, 1, r.ao);                                 // floor-line AO
  };
  F.quarters_minifridge = (x, y, w, h, f) => {
    /* v67 MINI-FRIDGE (1x1) — rebuilt to Andrew's reference (2026-08-16): a CLOSED upright fridge in
       brushed steel — lit top plane, freezer compartment over a dark seam, one long chrome handle down
       the main door, a small readout panel, and a RED CAN left standing on top.
       ⛔ THE CAN ON TOP IS THE SILHOUETTE. A 1-tile box is a box; one small warm object breaking the
          crown is what makes it read at a glance, and it is the only saturated mark on the prop.
       ⛔ THE SEAM IS A GAP, NOT A LINE. Two doors means a dark recess with the lower door's lit top
          edge under it — a single dark row just looks like a scratch.
       ⛔ blink(2500) is kept as the compressor cycle: the readout ticks on its beat. Nothing else here
          claims a state the harness cannot prove — this prop grants no capability. */
    const EDGE = '#161d22';
    const run = blink(2500);
    const ST = '#7f888f', ST_L = '#a8b1b7', ST_HI = '#c8d0d5', ST_D = '#565e65', ST_DK = '#333a40';
    const base = y + h, T = base - 19, fx = x + 2, fw = 9;

    shadow2(x + 2, base - 1, 8);

    /* ---- THE CAN, standing on the crown ---- */
    px(x + 7, T - 4, 3, 4, EDGE);
    px(x + 7, T - 3, 3, 3, '#a8302a'); px(x + 7, T - 3, 1, 3, '#c8564a');
    px(x + 9, T - 3, 1, 3, '#6e1c18');
    px(x + 7, T - 4, 3, 1, '#aeb8bd'); px(x + 8, T - 4, 1, 1, '#d4dbdf');   // aluminium lid
    px(x + 7, T - 2, 3, 1, shade('#a8302a', 0.22));                       // the label band

    /* ---- CARCASS ---- */
    px(fx - 1, T - 1, fw + 2, 21, EDGE);
    px(fx, T, fw, 2, ST_L);                                                 // the top plane we look down on
    px(fx, T, fw, 1, ST_HI); keyEdge(fx + 1, T, 5, 1, 0.26);
    px(fx, T + 2, fw, 17, ST);
    px(fx, T + 2, 1, 17, ST_L);                                             // lit west facet
    px(fx + fw - 1, T + 2, 1, 17, ST_D); rimEdge(fx + fw - 1, T + 3, 1, 15, 0.18);

    /* ---- FREEZER DOOR over a real seam gap ---- */
    px(fx + 1, T + 3, fw - 2, 4, shade(ST, 0.06));
    px(fx + 1, T + 3, fw - 2, 1, ST_L);
    px(fx + 5, T + 4, 3, 1, ST_DK);                                         // the readout panel
    px(fx + 5, T + 4, 1, 1, run ? '#7fd8c0' : '#3d4a4e');
    px(fx + 5, T + 5, 2, 1, ST_D);
    px(fx + 1, T + 7, fw - 2, 1, '#20262b');                                // the seam recess
    px(fx + 1, T + 8, fw - 2, 1, ST_L);                                     // lower door's lit top edge

    /* ---- MAIN DOOR + the long chrome handle ---- */
    px(fx + 1, T + 9, fw - 2, 9, shade(ST, 0.03));
    px(fx + 1, T + 17, fw - 2, 1, ST_D);
    px(fx + 2, T + 10, 1, 6, '#c2cad0'); px(fx + 2, T + 10, 1, 1, '#e2e8ec');   // the handle
    px(fx + 3, T + 11, 1, 4, '#4a5259');                                        // its shadow on the door
    wear(fx + 1, T + 9, fw - 2, 8, 3, shade(ST, -0.08));

    /* ---- KICK ---- */
    px(fx, T + 19, fw, 1, ST_DK);
    px(fx + 1, base - 1, fw - 2, 1, '#0a0d10');
    underAO(fx + 1, T + 18, fw - 2, 2);
  };

  F.airlock = (x, y, w, h, f) => {
    // AIRLOCK (1x1) — the room-seal hatch. ONE idea, no cramming: a floor-flat OCTAGONAL IRIS. At 12px
    // the silhouette is the whole read, so chamf(k=3) cuts a genuine octagon rather than rr()'s lozenge,
    // and the three states stay separable by SHAPE first, colour second:
    //   open   = blades retracted, a lit central eye        closed = blades meet on a sealed seam
    //   jammed = blades half-shut on a sparking, dark seam
    // f.door drives it live (setDoorState).
    const st = (f && f.door) || 'open';
    const sealed = st === 'closed' || st === 'jammed', jam = st === 'jammed';
    const lc = jam ? '#ff5a4a' : sealed ? '#ffb347' : ACC.work;
    const r = RAMP.steel, cx = x + (w >> 1), cy = y + (h >> 1), rad = Math.min(w, h) / 2 - 1;
    shadow2(x + 1, y + h - 1, w - 2);                                  // floor contact
    // octagonal deck collar, bolted in — warm key across the north rim, cool bounce along the south
    chamf(x - 1, y - 1, w + 2, h + 2, LINE, 3);
    chamf(x, y, w, h, shade(r.face, -0.18), 3);
    px(x + 3, y, w - 6, 1, r.lit); keyEdge(x + 3, y, w - 8, 1, 0.30);
    px(x + 3, y + h - 1, w - 6, 1, r.ao); rimEdge(x + 3, y + h - 2, w - 6, 1, 0.18);
    px(x, y + 3, 1, h - 6, r.lit); px(x + w - 1, y + 3, 1, h - 6, r.dk);
    rimEdge(x + w - 1, y + 3, 1, h - 6, 0.22);
    for (const b of [[x + 2, y + 2], [x + w - 3, y + 2]]) px(b[0], b[1], 1, 1, '#caa84a');   // hazard bolts
    for (const b of [[x + 2, y + h - 3], [x + w - 3, y + h - 3]]) px(b[0], b[1], 1, 1, '#8a7434');
    // recessed circular blade track
    for (let dy = -rad + 1; dy <= rad - 1; dy++) {
      const half = Math.floor(Math.sqrt(Math.max(0, (rad - 1) * (rad - 1) - dy * dy)));
      if (half <= 0) continue;
      px(cx - half, cy + dy, half * 2, 1, '#0c1417');
      if (dy === -rad + 1) px(cx - half, cy + dy, half * 2, 1, '#151f24');   // lit lip at the top of the well
    }
    // IRIS BLADES — machined metal, lit on their north facets and sky-cooled on the south. A jammed iris
    // sits HALF closed (its own silhouette), so the state reads before the colour does.
    const close = jam ? Math.round(rad * 0.55) : sealed ? rad - 1 : 1;
    const bc = jam ? shade(r.top, -0.42) : shade(r.top, -0.05);
    for (let dy = -rad + 1; dy <= rad - 1; dy++) {
      const half = Math.floor(Math.sqrt(Math.max(0, (rad - 1) * (rad - 1) - dy * dy)));
      if (half <= 0) continue;
      const gap = Math.max(0, half - close);
      if (gap >= half) continue;
      px(cx - half, cy + dy, half - gap, 1, bc);
      px(cx + gap, cy + dy, half - gap, 1, bc);
      if (dy < 0) { px(cx - half, cy + dy, 1, 1, shade(bc, 0.30)); keyEdge(cx + half - 1, cy + dy, 1, 1, 0.16); }
      else { px(cx - half, cy + dy, 1, 1, shade(bc, -0.40)); rimEdge(cx + half - 1, cy + dy, 1, 1, 0.20); }
    }
    px(cx - 1, cy - rad + 1, 2, (rad - 1) * 2, shade(bc, -0.5));     // spoke between the blade pairs
    if (sealed) {
      px(cx - 1, cy - rad + 2, 2, rad * 2 - 3, shade(bc, -0.55));    // the sealed seam
      px(cx - 1, cy - 1, 2, 2, shade(bc, -0.28));                    // centre boss
      px(cx - 1, cy - 1, 2, 1, shade(bc, 0.18));
      if (jam) {
        bloom(cx - 1, cy - 2, 2, 4, '#ff5a4a', 0.22 + 0.14 * Math.sin(now / 110));   // the seam glows where it binds
        if (blink(150)) { px(cx, cy - 1, 1, 1, '#ffe6c8'); px(cx + 1, cy - 2, 1, 1, '#ffd9a0'); } // jam spark
      }
    } else {
      px(cx - 1, cy - 1, 2, 2, shade(ACC.work, -0.05));              // open: the lit eye through the hatch
      bloom(cx - 1, cy - 1, 2, 2, ACC.work, 0.26 + 0.10 * Math.sin(now / 400));
    }
    // status lamp on the north lintel — the one piece of signage this prop gets
    const on = jam ? blink(170) : sealed ? blink(680) : true;
    px(cx - 2, y, 4, 2, '#0c1417');
    px(cx - 1, y, 2, 2, on ? lc : shade(lc, -0.65));
    if (on) bloom(cx - 1, y, 2, 1, lc, jam ? 0.42 : sealed ? 0.22 : 0.28);
  };

  /* ============ TABLETOP SET (2026-07-29) ============
     Small objects that live ON a table (`stack: true`), authored after the mount axis gained its third
     state. Every one of these is drawn in the ordinary footprint frame with its contact on the footprint
     BOTTOM — draw() lifts the whole origin by SURFACE_RISE when a table is under it, so none of them
     bakes a mount height and all of them are equally correct standing on bare deck.

     THE SCALE RULE THAT MAKES THEM READ: a tile is 12px and an agent is ~35px, so a mug that fills its
     tile is a mug the size of a torso. These are authored 5-9px wide, centred, sitting in the LOWER
     half of the tile — the empty margin is what says "small object", and it is also the gap that lets
     several of them sit along one LONG TABLE without merging into a single mass. They keep the v3
     projection (visible top surface, short front face) and the v4 material kit; identity is in the
     ACCENT, never in a recoloured casing. */

  F.mug = (x, y, w, h, f) => {   // enamel mug — ONE bold cylinder + a C handle; the OPEN RIM is the read
    const ph = (f && f.x) || 0;
    const EN = '#dfe6e2', EN_LIT = '#ffffff', EN_DK = '#8b9a9c', BREW = '#3a2317';
    ctx.globalAlpha = 0.24; px(x + 2, y + 11, 8, 1, '#000'); ctx.globalAlpha = 1;
    // HANDLE first so the body's outline overlaps it — a handle drawn after reads as a sticker
    px(x + 8, y + 5, 3, 1, LINE); px(x + 10, y + 6, 1, 2, LINE); px(x + 8, y + 8, 3, 1, LINE);
    px(x + 9, y + 6, 1, 2, EN); px(x + 9, y + 5, 1, 1, EN_LIT);
    // BODY: a fat cylinder filling most of the tile. Small was the mistake in v1 — at 12px a mug that
    // only 5px wide reads as a pebble; the width is what names it, the rim is what tilts the camera.
    px(x + 1, y + 3, 8, 8, LINE);
    px(x + 2, y + 4, 6, 6, EN);
    px(x + 2, y + 4, 1, 6, EN_LIT);                                // west highlight column
    px(x + 7, y + 4, 1, 6, EN_DK); rimEdge(x + 7, y + 4, 1, 6, 0.18);
    px(x + 2, y + 9, 6, 1, shade(EN_DK, -0.2));                  // base shade
    // RIM — the top surface, looked down into. This ellipse-ish band is the whole projection cue.
    px(x + 1, y + 2, 8, 2, LINE);
    px(x + 2, y + 3, 6, 1, shade(EN, 0.18));
    px(x + 3, y + 2, 4, 1, EN_LIT); keyEdge(x + 3, y + 2, 3, 1, 0.30);
    px(x + 3, y + 3, 4, 1, BREW);                                  // the coffee, seen from above
    px(x + 4, y + 3, 2, 1, shade(BREW, 0.22));                   // one catchlight on the surface
    px(x + 2, y + 6, 6, 1, '#8a3f2a');                             // chipped enamel band — the only colour
    px(x + 2, y + 7, 6, 1, shade('#8a3f2a', -0.34));
    if (blink(3000, ph + x)) { ctx.globalAlpha = 0.13; px(x + 4, y, 1, 3, '#dfe8ea'); px(x + 5, y - 1, 1, 2, '#dfe8ea'); ctx.globalAlpha = 1; }   // one thin curl, never a cloud
  };

  F.bookstack = (x, y, w, h, f) => {   // three hardbacks, offset — the STEP is the whole silhouette
    ctx.globalAlpha = 0.22; px(x + 1, y + 11, 10, 1, '#000'); ctx.globalAlpha = 1;
    // bottom -> top, each shorter and offset, so the stack reads as separate objects not one block
    const vol = (bx, by, bw, c, pages) => {
      px(bx - 1, by - 1, bw + 2, 4, LINE);
      px(bx, by, bw, 1, shade(c, 0.26));                         // the COVER's top face — what the camera sees
      px(bx, by + 1, bw, 2, c);
      px(bx, by + 2, bw, 1, shade(c, -0.34));
      px(bx, by + 1, 1, 2, shade(c, 0.14));
      px(bx + bw - 1, by + 1, 1, 2, pages);                        // page block on the fore edge
      px(bx + bw - 1, by, 1, 1, shade(pages, 0.2));
      keyEdge(bx, by, Math.max(2, bw - 3), 1, 0.18);
    };
    vol(x + 1, y + 7, 10, '#5b3a52', '#d9d2bd');                   // plum
    vol(x + 2, y + 4, 8, '#2f5a56', '#cfc8b3');                    // teal, offset east
    vol(x + 1, y + 1, 7, '#7a4a2e', '#d9d2bd');                    // tan, offset west — the overhang breaks the column
    px(x + 3, y + 2, 3, 1, shade('#c9a24a', 0.1));               // one gilt title bar, the only bright mark
  };

  F.desklamp = (x, y, w, h, f) => {   // task lamp — an OFF-AXIS "7": base east, arm over, cone hanging west
    const r = RAMP.gun, WARM = '#ffd9a0';
    ctx.globalAlpha = 0.24; px(x + 4, y + 11, 8, 1, '#000'); ctx.globalAlpha = 1;
    // The silhouette is the whole prop. v2 stacked base, upright and shade on ONE centre line, and at
    // 12px a vertical grey column with a warm pixel is a bollard, not a lamp. Pushing the base EAST and
    // the cone WEST puts real negative space under the arm — that gap is what names it from across the
    // room, and it is the same trick the crane-armed props use.
    px(x + 5, y + 9, 7, 3, LINE);                                  // weighted base, EAST
    px(x + 6, y + 9, 5, 1, shade(r.top, 0.22)); keyEdge(x + 6, y + 9, 3, 1, 0.26);
    px(x + 6, y + 10, 5, 1, r.face); px(x + 6, y + 11, 5, 1, r.ao);
    px(x + 7, y + 4, 2, 6, LINE); px(x + 7, y + 4, 1, 6, r.lit); px(x + 8, y + 5, 1, 5, r.dk);   // upright
    px(x + 2, y + 3, 6, 2, LINE);                                  // forearm reaching WEST, over open air
    px(x + 2, y + 3, 6, 1, r.lit); px(x + 3, y + 4, 5, 1, r.dk);
    px(x + 7, y + 3, 1, 1, r.sheen);                               // the elbow takes the key
    // CONE: hangs off the west end of the arm, opening DOWN — small, hard-edged, one hot mouth.
    px(x + 0, y + 5, 6, 1, LINE);
    px(x + 0, y + 6, 6, 1, LINE);
    px(x + 1, y + 5, 4, 1, r.face); px(x + 1, y + 5, 2, 1, r.sheen);
    px(x + 1, y + 6, 4, 1, shade(r.face, -0.34));                // shaded underside of the shade
    px(x + 1, y + 7, 4, 1, WARM);                                  // the mouth
    bloom(x + 1, y + 7, 4, 1, WARM, 0.62);
    spill(x + 1, y + 8, 4, WARM, 0.18, 3);                         // a hint of pool, never a wash
    cable(x + 11, y + 9, x + 9, y + 11, 1.2, '#0b1114');
  };

  F.radio = (x, y, w, h, f) => {   // valve set — a warm dial in a dark case; the only prop here with a needle
    const r = RAMP.fabric, ph = (f && f.x) || 0;
    ctx.globalAlpha = 0.22; px(x + 1, y + 11, 10, 1, '#000'); ctx.globalAlpha = 1;
    chamf(x + 1, y + 3, 10, 9, LINE, 2);
    px(x + 2, y + 4, 8, 1, shade('#4a352b', 0.30));              // the CASE TOP — walnut, lit
    keyEdge(x + 2, y + 4, 5, 1, 0.26);
    px(x + 2, y + 5, 8, 5, '#4a352b');
    px(x + 2, y + 5, 1, 5, shade('#4a352b', 0.18)); px(x + 9, y + 5, 1, 5, shade('#4a352b', -0.30));
    rimEdge(x + 9, y + 5, 1, 5, 0.20);
    px(x + 2, y + 10, 8, 1, r.ao);
    // grille cloth, west 2/3 — horizontal weave, dark
    inset(x + 3, y + 6, 4, 3, '#2b2119');
    for (let j = 0; j < 3; j += 1) px(x + 3, y + 6 + j, 4, 1, j % 2 ? '#332619' : '#241b13');
    // the DIAL: lit amber scale + a needle that drifts, which is the whole animation
    px(x + 7, y + 6, 3, 3, LINE); px(x + 7, y + 6, 3, 3, '#c98a2a');
    bloom(x + 7, y + 6, 3, 3, '#ffc45a', 0.30);
    const nx = 7 + ((Math.floor(now / 900) + ph) % 3);
    px(x + nx, y + 6, 1, 3, '#3a2410');
    if (blink(1400, ph + x)) px(x + 9, y + 10, 1, 1, ACC.flow);    // power lamp
  };

  F.toolbox = (x, y, w, h, f) => {   // open cantilever tray — you look DOWN into the compartments
    const r = RAMP.steel;
    ctx.globalAlpha = 0.22; px(x + 1, y + 11, 10, 1, '#000'); ctx.globalAlpha = 1;
    px(x + 0, y + 6, 12, 5, LINE);                                 // body
    px(x + 1, y + 7, 10, 3, r.face);
    px(x + 1, y + 7, 10, 1, r.top); keyEdge(x + 1, y + 7, 6, 1, 0.24);
    px(x + 1, y + 9, 10, 1, r.ao);
    px(x + 1, y + 8, 1, 1, r.lit); px(x + 10, y + 8, 1, 1, r.dk);
    // the OPEN tray above, cantilevered west — the overhang is the silhouette
    px(x + 0, y + 3, 9, 3, LINE);
    px(x + 1, y + 4, 7, 2, shade(r.face, -0.18));
    px(x + 1, y + 4, 7, 1, '#141c20');                             // looking into the tray
    px(x + 1, y + 4, 2, 1, ACC.flow);                              // a brass fitting
    px(x + 4, y + 4, 1, 1, '#b8452f'); px(x + 6, y + 4, 2, 1, '#7f8f97');   // a red grip + a steel shank
    px(x + 3, y + 5, 5, 1, shade(r.face, -0.34));
    // handle arching over the top — the one curved line in a boxy prop
    px(x + 2, y + 1, 5, 1, LINE); px(x + 1, y + 2, 1, 1, LINE); px(x + 7, y + 2, 1, 1, LINE);
    px(x + 3, y + 1, 3, 1, r.sheen);
    px(x + 9, y + 7, 2, 2, shade('#8a7434', 0.05));              // hazard tick on the flank
  };

  F.figurine = (x, y, w, h, f) => {   // a carved BUST on a plinth — three shapes, no limbs
    const r = RAMP.gun, ph = (f && f.x) || 0;
    const ST = '#6d6459', ST_LIT = '#8e8478', ST_DK = '#443e37';
    ctx.globalAlpha = 0.24; px(x + 2, y + 11, 8, 1, '#000'); ctx.globalAlpha = 1;
    // PLINTH — wide and squat, so the thing standing on it reads as small and precious
    px(x + 1, y + 8, 10, 4, LINE);
    px(x + 2, y + 8, 8, 1, shade(r.top, 0.20)); keyEdge(x + 2, y + 8, 4, 1, 0.26);
    px(x + 2, y + 9, 8, 2, r.face); px(x + 2, y + 10, 8, 1, shade(r.face, -0.24));
    px(x + 3, y + 10, 6, 1, shade('#c9a24a', -0.05));            // brass name plate
    // BUST — v1 tried a whole mech (legs, feet, pauldrons, head) inside 8px and resolved to mush.
    // A bust is THREE masses: a flared base, a tapering body, a domed head. That survives 12px.
    px(x + 3, y + 6, 6, 2, LINE); px(x + 4, y + 6, 4, 1, ST); px(x + 4, y + 7, 4, 1, ST_DK);   // shoulders, flared
    px(x + 4, y + 3, 4, 4, LINE);                                  // the body block
    px(x + 5, y + 4, 2, 3, ST); px(x + 5, y + 4, 1, 3, ST_LIT); px(x + 6, y + 5, 1, 2, ST_DK);
    px(x + 4, y + 1, 4, 3, LINE);                                  // head
    px(x + 5, y + 2, 2, 2, ST); px(x + 5, y + 2, 1, 1, ST_LIT); rimEdge(x + 6, y + 2, 1, 2, 0.20);
    px(x + 5, y + 3, 2, 1, blink(2400, ph + x) ? ACC.alert : shade(ACC.alert, -0.62));   // the eye band, waking
  };

  F.deskterminal = (x, y, w, h, f) => {   // a little CRT on a swivel — the one lit face in the set
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    ctx.globalAlpha = 0.22; px(x + 2, y + 11, 8, 1, '#000'); ctx.globalAlpha = 1;
    px(x + 2, y + 9, 8, 3, LINE);                                  // weighted foot, wide enough to read
    px(x + 3, y + 9, 6, 1, shade(r.top, 0.18)); keyEdge(x + 3, y + 9, 3, 1, 0.24);
    px(x + 3, y + 10, 6, 2, r.face);
    px(x + 5, y + 7, 2, 2, LINE); px(x + 5, y + 7, 1, 2, r.lit);   // stalk
    // the tube: chamfered, bulging — never a plain rectangle
    chamf(x + 0, y + 0, 12, 8, LINE, 2);
    chamf(x + 1, y + 1, 10, 6, r.face, 1);
    px(x + 1, y + 1, 10, 1, r.top); keyEdge(x + 1, y + 1, 6, 1, 0.28);
    px(x + 10, y + 2, 1, 4, r.dk); rimEdge(x + 10, y + 2, 1, 4, 0.20);
    px(x + 1, y + 6, 10, 1, r.ao);                                 // under-bezel shade
    inset(x + 2, y + 2, 8, 4, '#08120e');
    const g = on ? scr(ph) : shade(scr(ph), -0.45);
    codeRow(x + 3, y + 2, 7, 1 + ph, g, '#d9ffe8');
    codeRow(x + 3, y + 3, 7, 3 + ph, shade(g, -0.18), '#d9ffe8');
    codeRow(x + 3, y + 4, 7, 5 + ph, shade(g, -0.34), '#d9ffe8');
    if (blink(520, ph)) px(x + 3, y + 5, 2, 1, g);                 // cursor
    scanl(x + 2, y + 2, 8, 4, 0.22);
    bloom(x + 2, y + 2, 8, 4, g, on ? 0.30 : 0.13);
    cable(x + 8, y + 8, x + 11, y + 10, 1.0, '#0b1114');
  };

  F.modelship = (x, y, w, h, f) => {   // a starship on a rod — 2x1 so the HULL can be long enough to read
    // NB: w/h arrive in PIXELS (draw() multiplies the footprint by TILE before calling), so a prop
    // function never scales them again. Doing so put this whole set off-canvas until it was caught.
    const r = RAMP.steel, ph = (f && f.x) || 0, cw = w;
    const cx = x + (cw >> 1);
    ctx.globalAlpha = 0.24; px(cx - 5, y + 11, 10, 1, '#000'); ctx.globalAlpha = 1;
    px(cx - 4, y + 9, 9, 3, LINE);                                 // display base
    px(cx - 3, y + 9, 7, 1, shade(r.top, 0.18)); keyEdge(cx - 3, y + 9, 4, 1, 0.24);
    px(cx - 3, y + 10, 7, 2, r.face);
    px(cx - 2, y + 11, 5, 1, shade('#c9a24a', -0.1));            // brass plate, like the figurine's
    px(cx, y + 7, 2, 2, LINE); px(cx, y + 7, 1, 2, r.dk);          // support rod
    // HULL — a LONG lens in plan, nose EAST, spanning nearly the whole 2-tile width. v2 built a compact
    // delta centred on cx, which on a 24px footprint is a small grey clump with room to spare either
    // side; a model ship reads by being LONG. Rows are [x0, width] relative to x.
    const rows = [[8, 9], [5, 15], [3, 18], [5, 15], [8, 9]];
    rows.forEach((s, j) => px(x + s[0] - 1, y + 2 + j, s[1] + 2, 1, LINE));
    rows.forEach((s, j) => {
      const bx = x + s[0], mid = j === 2;
      px(bx, y + 2 + j, s[1], 1, j < 2 ? r.top : mid ? r.face : shade(r.face, -0.26));
      px(bx, y + 2 + j, 1, 1, r.dk);                               // blunt tail, west
      px(bx + s[1] - 1, y + 2 + j, 1, 1, r.lit);                   // the nose edge, east, takes the key
    });
    px(x + 6, y + 2, 8, 1, r.sheen); keyEdge(x + 6, y + 2, 6, 1, 0.28);      // lit spine along the top
    px(x + 5, y + 4, 15, 1, shade(r.top, 0.12));                 // centreline
    px(x + 17, y + 3, 4, 3, LINE);                                 // the drawn-out nose
    px(x + 17, y + 4, 4, 1, shade(r.top, 0.24));
    px(x + 6, y + 1, 6, 1, LINE); px(x + 7, y + 1, 4, 1, shade(r.top, -0.10));   // dorsal fin, aft
    px(x + 4, y + 7, 6, 1, LINE); px(x + 4, y + 7, 6, 1, r.dk);    // swept wing slung under, west
    const lit = blink(2200, ph + x);
    px(x + 3, y + 3, 2, 3, lit ? ACC.data : shade(ACC.data, -0.62));       // engine block, aft
    if (lit) bloom(x + 2, y + 3, 2, 3, ACC.data, 0.34);
    for (let i = 0; i < 5; i++) px(x + 7 + i * 2, y + 4, 1, 1, shade(ACC.flow, -0.15));   // porthole row
  };

  /* ============ FREESTANDING LOUNGE SET (2026-07-29) ============
     Floor pieces, not table-tops. Each one an idle agent can actually WALK TO — they carry `use`
     descriptors, which is the point of the batch: the catalog had plenty of lounge furniture and
     almost none of it was a destination. */

  F.bookshelf = (x, y, w, h, f) => {
    /* v64 BOOKSHELF (2x1) — PROJECTION FIXED (2026-08-17). v63's art was good and is kept almost
       tone for tone; what was wrong is that it was drawn as a FRONT ELEVATION — the picture you get
       standing at eye level in front of a bookcase. This station is top-down 3/4, and the tell is
       always the same: at eye level every horizontal is a 1px LINE, from above every horizontal is
       a PLANE. v63 had a 2px "crown", 1px shelf boards and books with 1px tops. So:
       ⛔ THE CASE TOP IS A PLANE, NOT A CROWN LINE. 5 rows of timber we look down onto, keyed down
          its WEST rail end to end (a receding surface takes the key on its west rail — put it on the
          far edge and the board reads as a plank STANDING against the wall). Same law the turned
          tables were rebuilt under.
       ⛔ EVERY SHELF BOARD SHOWS ITS TOP. 2 rows of lit board with the books' feet on its FAR edge,
          so the empty front strip of each board is visible in front of the row. That strip is what
          says "we are above this", and it costs two rows.
       ⛔ EVERY BOOK GETS A TOP CAP. A spine is now a short face under a 1px block of page/board seen
          from above — head-edge cream on the leaning ones, cover colour on the upright ones.
       ⛔ THINGS LYING FLAT ARE PLANES TOO. The stack shows its top COVER as a 3-row surface with the
          page edges stepping down in front of it; the plant is a splayed crown around a pot RIM.
       Kept from v63: warm back panel that falls off toward the floor, lit west / shaded east inner
       returns, 2px spines with dark voids between groups, gilt on two books a shelf only, no lamp. */
    const EDGE = '#161d22';
    const cw = w;
    const WD = '#6b4a2c', WD_LIT = '#8a6540', WD_DK = '#3a2614', WD_SHN = '#a37e52';
    const top = y + h - 20;                    // w/h are PIXELS here, never tiles
    /* the row budget, floor line at y+h-1:
       top+0..3  case top plane · +4 rail lit face · +5 rail underside
       +6..10    upper bay · +11..12 middle board top · +13 board front edge
       +14..17   lower bay · +18..19 plinth + toe */
    const TP = top, RAIL = top + 4, U0 = top + 6, BRD = top + 11, L0 = top + 14, PL = top + 18;

    shadow2(x + 1, y + h - 1, cw - 2);

    /* ---- CARCASS ---- */
    chamf(x - 1, top - 1, cw + 2, 21, '#3a2614', 2);   // contour is TIMBER, not a black ring

    /* ---- THE TOP PLANE we look down onto: 4 rows ramping far->near, keyed down the WEST rail ---- */
    // ⛔ the far row is INSET 1px to sit inside the carcass chamfer — a full-width row here leaves a
    //    bare lit corner outside the contour and the whole plane reads as a lid laid on top.
    for (let j = 0; j < 4; j++) { const i = j ? 0 : 1; px(x + i, TP + j, cw - i * 2, 1, shade(WD, -0.20 + j * 0.11)); }
    px(x + 1, TP + 1, 1, 3, WD_LIT); keyEdge(x + 1, TP + 1, 1, 3, 0.20);   // WEST RAIL — end to end, the plane cue
    px(x + cw - 2, TP + 1, 1, 3, WD_DK); rimEdge(x + cw - 2, TP + 1, 1, 3, 0.18);
    px(x + 3, TP + 2, cw - 8, 1, shade(WD, 0.02));                     // ONE long seam, not a dashed grain
    px(x + 2, TP + 3, cw - 4, 1, WD_SHN);                                // the front nosing takes the strip
    keyEdge(x + 2, TP + 3, 8, 1, 0.22);
    /* the top rail's own FACE — short, because height reads and depth does not */
    px(x, RAIL, cw, 1, WD_LIT);
    px(x, RAIL + 1, cw, 1, WD_DK);
    px(x, TP + 3, 1, 3, WD_DK); px(x + cw - 1, TP + 3, 1, 3, shade(WD_DK, -0.30));   // corner mitres

    px(x, U0, 2, 12, WD); px(x + 1, U0, 1, 12, WD_LIT);                  // west stile, inner face lit
    px(x + cw - 2, U0, 2, 12, WD_DK);                                    // east stile, falling away
    px(x + cw - 1, U0, 1, 12, shade(WD_DK, -0.32));
    rimEdge(x + cw - 1, U0 + 1, 1, 10, 0.18);

    /* ---- THE WELL, given three walls ---- */
    px(x + 2, U0, cw - 4, 12, '#241708');                                // warm back panel, never black
    px(x + 2, U0 + 7, cw - 4, 5, '#1a1006');                             // it falls off toward the floor
    px(x + 2, U0, cw - 4, 1, '#0c0703');                                 // the rail's underside, occluding
    px(x + 2, U0, 1, 12, '#40290f');                                     // west inner return, lit
    px(x + cw - 3, U0, 1, 12, '#140c05');                                // east inner return, in shade

    /* ONE BOOK, seen from above: a top cap (the plane), a short spine face under it, a shaded east
       flank. `base` is the board's FAR edge — books are pushed to the back of the shelf. */
    const spine = (bx, bw, c, bh, gilt, base) => {
      px(bx, base - bh, bw, bh, c);                                      // spine face
      px(bx, base - bh, bw, 1, shade(c, 0.34));                        // where the face turns over
      px(bx, base - bh - 1, bw, 1, shade(c, 0.16));                    // THE TOP CAP — the plane from above
      px(bx + bw - 1, base - bh, 1, bh, shade(c, -0.36));
      if (gilt) px(bx, base - bh + 2, bw, 1, '#8a6a2e');
    };
    const row = (bx, base, list) => { for (const e of list) { if (e[0]) spine(bx, e[0], e[1], e[2], e[3], base); bx += e[0] || 1; } };

    /* ---- UPPER SHELF (rows U0..U0+4): a potted plant, then five books ---- */
    px(x + 3, U0 + 3, 4, 2, '#3c4349');                                  // pot: the body...
    px(x + 3, U0 + 2, 4, 1, '#6e7982'); px(x + 4, U0 + 2, 2, 1, '#8b959d');   // ...and its RIM, seen from above
    px(x + 6, U0 + 4, 1, 1, '#262b30');
    px(x + 4, U0 + 1, 2, 1, '#79a84c');                                  // the crown splayed round the rim
    px(x + 3, U0 + 2, 1, 1, '#31552a'); px(x + 6, U0 + 2, 1, 1, '#4e7a34');
    px(x + 4, U0, 1, 1, '#4e7a34'); px(x + 6, U0 + 1, 1, 1, '#31552a');
    row(x + 8, U0 + 5, [[2, '#4a6b34', 4, 0], [0], [2, '#8a3038', 3, 1], [3, '#7d6a2a', 4, 0],
                        [0], [2, '#33518a', 3, 0], [2, '#6b4a2a', 4, 1]]);

    /* ---- MIDDLE BOARD: 2 rows of TOP SURFACE (the books stand on its far edge) + a front edge ---- */
    px(x + 2, BRD, cw - 4, 2, WD);
    px(x + 2, BRD, cw - 4, 1, shade(WD, 0.14));
    px(x + 2, BRD + 1, cw - 4, 1, WD_LIT);                               // the strip we see IN FRONT of the books
    px(x + 2, BRD, 1, 2, WD_LIT);                                        // keyed down the west rail again
    px(x + cw - 3, BRD, 1, 2, WD_DK);
    px(x + 2, BRD + 2, cw - 4, 1, '#0a0602');                            // the board's own thickness

    /* ---- LOWER SHELF (rows L0..L0+3): three books, a framed plate on a box, a stack lying flat ---- */
    row(x + 3, L0 + 4, [[2, '#2f4a7a', 3, 1], [0], [2, '#a8863c', 3, 0], [2, '#3f6b3a', 2, 0]]);
    px(x + 11, L0 + 3, 4, 1, '#463d34'); px(x + 11, L0 + 2, 4, 1, '#635a4e');   // the box it stands on, top lit
    px(x + 11, L0 + 1, 4, 1, '#4e565c'); px(x + 11, L0, 4, 1, '#6d767c');       // the plate, its frame's top edge
    px(x + 12, L0 + 1, 2, 1, '#222a30'); px(x + 12, L0 + 1, 1, 1, '#8e9aa0');
    /* the stack: a TOP COVER plane, then the page edges stepping down in front of it */
    px(x + 16, L0 + 1, 5, 2, '#6b2a32');
    px(x + 16, L0 + 1, 5, 1, '#8d3c46'); px(x + 16, L0 + 1, 1, 2, '#8d3c46');   // lit far edge + west rail
    px(x + 20, L0 + 2, 1, 1, '#4a1b21');
    for (let s = 0; s < 2; s++) {                                               // the books beneath, edges only
      const c = ['#2f4a7a', '#b8b2a0'][s];
      px(x + 16 - s, L0 + 3 + s, 5, 1, c);
      px(x + 16 - s, L0 + 3 + s, 1, 1, shade(c, 0.30));
    }

    /* ---- PLINTH ---- */
    px(x, PL, cw, 1, WD_LIT); keyEdge(x + 1, PL, 8, 1, 0.18);
    px(x, PL + 1, cw, 1, WD);
    px(x + 1, PL + 2, cw - 2, 1, WD_DK);
    wear(x, TP + 1, cw, 2, 3, shade(WD, -0.12));
    wear(x, PL, cw, 2, 3, shade(WD, -0.12));
    px(x + 1, y + h - 1, cw - 2, 1, '#0b0704');                          // toe shadow on the deck
  };

  F.beanbag = (x, y, w, h, f) => {
    /* v65 BEANBAG (1x1) — the pink pebble fixed. Same slump silhouette (it is the only prop in the
       catalog with no straight line and that is worth keeping), but rebuilt on three counts:
       ⛔ VALUE, NOT HUE. The old lit tone was #b06584 — the brightest thing in the lounge sat on a
          1-tile floor cushion. The mulberry identity is kept and the whole ramp drops into the low
          half, which is where a large soft body belongs.
       ⛔ THE DENT HAS TO BE A BOWL. A dark patch is a stain; a bowl is a dark floor, a shaded near
          wall and a FAR RIM that catches the key. Three marks, and the sack reads as sat-in.
       ⛔ THE TUCK IS WHERE IT MEETS THE DECK. Fabric under its own weight goes almost black and
          spreads — without that the sack floats no matter how well the crown is modelled. */
    const EDGE = '#2a1622';
    ctx.globalAlpha = 0.26; px(x + 1, y + 10, 11, 2, '#000'); ctx.globalAlpha = 1;
    const lit = '#8f5069', c = '#6e3a4e', dk = '#472634', deep = '#2b1420';
    const rows = [[4, 5], [3, 7], [2, 9], [1, 10], [1, 11], [0, 12], [0, 12], [0, 12], [1, 11]];
    rows.forEach((s, j) => px(x + s[0] - 1, y + 2 + j - 1, s[1] + 2, 3, EDGE));      // tinted halo, blob not box
    rows.forEach((s, j) => px(x + s[0], y + 2 + j, s[1], 1,
      j < 2 ? lit : j < 5 ? c : j < 7 ? shade(c, -0.14) : dk));                   // crown -> swell -> tuck

    /* ---- THE SITTING BOWL: far rim lit, near wall shaded, floor deep ---- */
    px(x + 4, y + 2, 4, 1, shade(lit, 0.26)); keyEdge(x + 4, y + 2, 4, 1, 0.22);  // far rim takes the key
    px(x + 4, y + 3, 4, 1, shade(c, -0.22));                                      // the bowl's near wall
    px(x + 4, y + 4, 3, 1, deep);                                                   // its floor
    px(x + 3, y + 5, 3, 1, shade(c, -0.10));                                      // crease running out of it

    /* ---- PIPING SEAM round the middle: lit on the west shoulder, lost on the east ---- */
    px(x + 1, y + 6, 5, 1, shade(c, 0.16));
    px(x + 6, y + 6, 5, 1, shade(c, -0.24));
    px(x + 1, y + 4, 1, 3, shade(lit, 0.04));                                     // west flank highlight

    /* ---- THE TUCK: fabric spreading under its own weight, and the deck line under it ---- */
    px(x + 1, y + 9, 10, 1, shade(dk, -0.24));
    px(x + 1, y + 10, 10, 1, deep);
    for (let i = 0; i < 5; i++) {                                                   // sparse nap, kept off the bowl
      const k = U.hash('bb' + x + i);
      px(x + 2 + (k % 9), y + 6 + ((k >>> 5) % 3), 1, 1, shade(c, 0.12));
    }
    px(x + 10, y + 5, 1, 1, '#8a6f34');                                             // the little brand tag
  };

  /* ============ THE COLD LAB (2026-08-17) ============
     Two props on the one recipe Andrew has kept out of everything shown so far — the CLAW MACHINE's:
       stacked BANDS (lit header -> window -> contents -> control band -> plinth),
       a WINDOW WITH CONTENTS visible in it (the contents ARE the prop; the casing is packaging),
       one saturated identity hue plus small saturated hardware,
       floor-sized, 1x2 minimum, because a small prop cannot hold a room.
     They are a deliberate pair: the pod holds something still and the incubator holds something
     that moves, so a lab with both reads as a place where one thing is being kept and another is
     being grown. */
  F.cryopod = (x, y, w, h, f) => {
    /* 1x2 CRYO POD — an upright tube with a FROSTED pane and a body-shaped shadow behind it. The
       shadow is the whole prop: an empty pod is a shower cubicle.
       ⛔ FROST IS NOT A WHITE WASH. It reads as a value gradient — clear at the middle where a hand
          would wipe it, thickening to opaque at the corners — with the silhouette behind it
          softening as the frost thickens. A flat translucent rectangle is a screen.
       ⛔ THE VITALS LAMP IS SLOW. One breath every few seconds; a fast blink reads as an alarm, and
          this pod is not in trouble. */
    const INK = '#0b1620', SHELL = '#38434c', SHELL_LIT = '#55626c', SHELL_DK = '#212a31';
    const ICE = '#8fd6f5', ICE_DK = '#3f7f9c', GLS = '#12303e';
    const br = 0.55 + 0.45 * Math.sin(now / 2600 + x);           // the occupant's slow breath
    shadow2(x + 1, y + h - 1, w - 2);
    rr(x, y - 6, w, h + 6, INK);
    /* (1) the HEADER — a lit strip and the pod's status, the only warm thing on it */
    px(x + 1, y - 5, w - 2, 4, SHELL);
    px(x + 1, y - 5, w - 2, 1, SHELL_LIT); keyEdge(x + 1, y - 5, 5, 1, 0.26);
    px(x + 2, y - 4, w - 4, 2, '#0e1c24');
    px(x + 3, y - 3, 5, 1, ICE); px(x + 9, y - 3, 1, 1, blink(2600, x) ? '#41ff8a' : '#1c4a30');
    bloom(x + 3, y - 3, 5, 1, ICE, 0.12 + 0.10 * br);
    px(x + 1, y - 1, w - 2, 1, SHELL_DK);
    /* (2) THE WELL — cold glass, and the SLEEPER behind it */
    px(x + 1, y, w - 2, 15, GLS);
    px(x + 2, y, 1, 15, shade(GLS, 0.22)); px(x + w - 3, y, 1, 15, shade(GLS, -0.24));
    px(x + 4, y + 1, 4, 4, '#1b3a48');                           // the head
    px(x + 5, y + 1, 2, 1, shade('#1b3a48', 0.30));
    px(x + 3, y + 5, 6, 8, '#17323e');                           // shoulders + torso, sinking into the dark
    px(x + 3, y + 5, 1, 8, shade('#17323e', 0.26));            // the cold light catching one side
    px(x + 8, y + 6, 1, 6, shade('#17323e', -0.30));
    px(x + 4, y + 13, 5, 2, '#122a34');
    /* (3) THE FROST — thickest at the corners, wiped clear across the middle */
    for (let i = 0; i < 5; i++) {
      ctx.globalAlpha = 0.20 - i * 0.03;
      px(x + 1, y + i, w - 2, 1, '#dff3ff'); px(x + 1, y + 14 - i, w - 2, 1, '#dff3ff');
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = 0.16; px(x + 1, y + 5, 2, 6, '#dff3ff'); px(x + w - 3, y + 5, 2, 6, '#dff3ff'); ctx.globalAlpha = 1;
    px(x + 2, y + 6, 1, 3, shade(ICE, -0.20)); px(x + w - 3, y + 8, 1, 2, shade(ICE, -0.30));   // crystals on the pane
    px(x + 1, y, w - 2, 1, shade(ICE, -0.10));                 // the pane's own top edge
    /* (4) the CONTROL BAND — a readout and two coolant valves */
    px(x + 1, y + 15, w - 2, 4, SHELL);
    px(x + 1, y + 15, w - 2, 1, SHELL_LIT);
    px(x + 2, y + 16, 5, 2, '#0e1c24');
    for (let i = 0; i < 3; i++) px(x + 3 + i, y + 17, 1, 1, i < 1 + ((now / 900 + x) % 3 | 0) ? ICE : '#1d3a46');
    px(x + 8, y + 16, 2, 2, ICE_DK); px(x + 8, y + 16, 2, 1, shade(ICE_DK, 0.28));
    /* (5) the PLINTH — pipes running into the deck, breathing cold */
    px(x + 1, y + 19, w - 2, 3, SHELL_DK);
    px(x + 1, y + 19, w - 2, 1, shade(SHELL, -0.06));
    px(x + 2, y + 20, 2, 2, '#0e1418'); px(x + 8, y + 20, 2, 2, '#0e1418');
    px(x + 1, y + 22, w - 2, 2, '#0f1418');
    spill(x + 1, y + 15, w - 2, ICE, 0.14 + 0.06 * br, 4);
    glow(x, y + 22, w, 1, ICE, 0.10);
  };

  F.incubator = (x, y, w, h, f) => {
    /* 1x2 INCUBATOR — rebuilt to Andrew's reference (2026-08-17): a LIT COLUMN of green culture on a
       heavy pedestal, with a specimen SUSPENDED in it. The first pass was a wide domed cabinet with
       eggs on a tray — a countertop appliance, not the thing in the picture.
       ⛔ THE LIGHT COMES FROM INSIDE THE LIQUID. Everything else on the prop is dark metal that the
          tank LIGHTS: the cap's underside, the pedestal's crown and the deck around its foot all
          take green spill. Paint the casing lit from the ceiling and the tank stops being a source.
       ⛔ THE SPECIMEN IS THE READ. It hangs mid-column, dark against the glow with a rim of it
          catching its edge, and it BOBS — a still shape in a lit tube is a lava lamp.
       ⛔ MOTES, NOT NOISE. A dozen deterministic drifting flecks (hash-seeded, one column each) sell
          "living culture"; random speckle over the whole tank just dirties the glass. */
    const INK = '#0a1a14', MET = '#2a3138', MET_LIT = '#49535a', MET_DK = '#161b1f';
    const GLS = '#123a2a', LIQ = '#1f7a4a', LIQ_LIT = '#3fe07a', HOT = '#b9ffcf', MOTE = '#e8ffd0';
    const t = now / 1000 + x;
    const bob = Math.round(Math.sin(t * 0.9) * 1.2);             // the specimen's slow drift
    shadow2(x + 1, y + h - 1, w - 2);
    /* (1) silhouette: feed pipe, cap, tube, pedestal */
    px(x + 4, y - 9, 4, 3, INK);
    rr(x, y - 7, w, 5, INK);
    rr(x + 1, y - 3, w - 2, 19, INK);
    rr(x - 1, y + 15, w + 2, 8, INK);
    /* (2) the FEED PIPE + CAP — metal, and lit from BELOW by the tank */
    px(x + 5, y - 9, 2, 3, MET); px(x + 5, y - 9, 1, 3, MET_LIT);
    px(x + 1, y - 6, w - 2, 3, MET);
    px(x + 1, y - 6, w - 2, 1, MET_LIT); keyEdge(x + 1, y - 6, 4, 1, 0.24);
    px(x + 2, y - 5, 1, 1, MET_LIT); px(x + w - 3, y - 5, 1, 1, MET_DK);          // collar bolts
    px(x + 1, y - 4, w - 2, 1, shade(LIQ, -0.10));                              // the cap's underside, lit green
    /* (3) THE TANK — glass walls, liquid, and a brighter core column */
    px(x + 1, y - 3, w - 2, 18, GLS);
    /* the culture, BRIGHTEST AT ITS FLOOR — the reference's light pools in the sediment and fades
       upward, which is what stops the tank reading as a backlit panel. A bright vertical core stripe
       did exactly that, and it also competed with the specimen for the eye. */
    px(x + 2, y - 1, w - 4, 16, LIQ);
    for (let i = 0; i < 5; i++) px(x + 2, y + 10 - i * 2, w - 4, 2, shade(LIQ, 0.05 + i * 0.06));
    px(x + 2, y - 1, w - 4, 1, HOT);                                              // the meniscus
    px(x + 2, y + 11, w - 4, 4, shade(LIQ_LIT, 0.04));                          // the sediment bed, glowing
    px(x + 3, y + 12, w - 6, 3, LIQ_LIT);
    px(x + 4, y + 13, w - 8, 2, HOT);
    bloom(x + 2, y + 11, w - 4, 4, HOT, 0.30);
    /* (4) THE SPECIMEN — suspended, dark against the glow, rimmed by it */
    const sy = y + 3 + bob, DARK = '#07231a';
    px(x + 4, sy, 4, 2, DARK);                                                    // the curled body: head...
    px(x + 3, sy + 2, 6, 3, DARK);                                                // ...shoulders...
    px(x + 4, sy + 5, 4, 2, DARK);                                                // ...and the curl of its tail
    px(x + 3, sy + 2, 1, 3, HOT); px(x + 4, sy, 1, 2, shade(HOT, -0.18));       // the glow rims its WEST edge
    px(x + 4, sy, 3, 1, shade(LIQ_LIT, 0.10));                                  // and lands along its crown
    px(x + 8, sy + 2, 1, 3, shade(LIQ, -0.30));                                 // its east side keeps the dark
    px(x + 5, sy + 3, 1, 1, shade(HOT, -0.30));                                 // one lit fleck inside it
    px(x + 5, sy + 7, 2, 1, shade(DARK, 0.30));                                 // a wisp trailing below
    bloom(x + 3, sy - 1, 6, 9, LIQ_LIT, 0.10);                                    // it displaces the glow around it
    /* (5) MOTES rising — one per column, each on its own loop, deterministic per station */
    for (let i = 0; i < 9; i++) {
      const k = U.hash('inc' + x + i);
      const mx = x + 2 + (k % (w - 4));
      const span = 14 + (k >>> 3) % 4;
      const my = y + 13 - Math.floor((now / (900 + (k >>> 5) % 700) + i * 1.7) % span);
      px(mx, my, 1, 1, (i % 3) ? MOTE : HOT);
    }
    /* (6) the GLASS itself — cylinder shading last, over the contents */
    px(x + 1, y - 3, 1, 18, shade(HOT, -0.36));                                 // lit west wall
    px(x + w - 2, y - 3, 1, 18, shade(GLS, 0.10));                              // shaded east wall
    rimEdge(x + w - 2, y - 2, 1, 16, 0.18);
    ctx.globalAlpha = 0.30; px(x + 3, y - 2, 1, 8, '#eafff4'); ctx.globalAlpha = 1;   // the specular streak
    ctx.globalAlpha = 0.14; px(x + w - 4, y + 2, 1, 9, '#eafff4'); ctx.globalAlpha = 1;
    bloom(x + 1, y - 3, w - 2, 18, LIQ_LIT, 0.16 + 0.05 * Math.sin(now / 620));
    /* (7) THE PEDESTAL — heavy, stepped, and lit green from above rather than from the ceiling */
    px(x + 1, y + 15, w - 2, 2, MET);
    px(x + 1, y + 15, w - 2, 1, shade(LIQ_LIT, -0.30));                         // its crown takes the tank's light
    px(x, y + 17, w, 4, MET);
    px(x, y + 17, w, 1, MET_LIT);
    px(x, y + 17, 1, 4, shade(MET_LIT, -0.10)); px(x + w - 1, y + 17, 1, 4, MET_DK);
    for (let i = 0; i < 3; i++) {                                                 // three indicator lamps
      const on = ((now / 700 + i) % 3 | 0) === i;
      px(x + 3 + i * 3, y + 19, 1, 1, on ? '#ffb347' : '#4a3a1c');
      if (on) bloom(x + 3 + i * 3, y + 19, 1, 1, '#ffb347', 0.30);
    }
    px(x - 1, y + 21, w + 2, 2, MET_DK);
    px(x, y + 21, w, 1, shade(MET, 0.10));
    px(x, y + 23, w, 1, '#0b0f12');
    spill(x - 1, y + 15, w + 2, LIQ_LIT, 0.34, 5);
    glow(x - 3, y + 21, w + 6, 3, LIQ_LIT, 0.20);                                 // the deck around its foot
    glow(x - 5, y + 22, w + 10, 2, LIQ, 0.16);                                    // and the pool reaching past it
  };

  /* ============ THE AIMED SET (2026-08-17) ============
     Three props whose whole identity is that they POINT somewhere: a telescope raking at the sky, a
     camera looking off-frame, a bench with its rack at one end. Each ships as a LEFT and a RIGHT
     entry (Andrew's rule from the recliner: two props beat a hidden gesture), and the right one is
     the left one under `mirrorV` — one drawing, two catalog rows, no drift.
     ⛔ THE DIAGONAL IS THE PROP. A telescope drawn upright is a water heater and a camera drawn
        square-on is a microwave; the tube and the lens must break the outline on the way out. */
  const mirrorV = (fn) => (x, y, w, h, f) => {
    ctx.save();
    ctx.translate(x, y); ctx.translate(w, 0); ctx.scale(-1, 1); ctx.translate(-x, -y);
    const was = MIRROR; MIRROR = true;
    try { fn(x, y, w, h, f); } finally { MIRROR = was; ctx.restore(); }
  };

  F.telescope = (x, y, w, h, f) => {
    /* 1x2 TELESCOPE — v2 (Andrew: "it looks terrible, barely even looks like a telescope"). v1 drew
       a 2px brass stripe on a stick tripod, which is a plank. A refractor is recognisable at this
       size from FIVE things, and it needs all five:
         a TUBE WITH GAUGE — 5px across, lit crown / mid / dark belly, so it is a cylinder;
         a TAPER — narrow at the eyepiece, wide at the objective, with a dark ring round the mouth;
         a FINDER SCOPE riding parallel above the tube near the eyepiece (the single clearest tell);
         an EYEPIECE STUB standing PERPENDICULAR out of the tube, plus a focuser knob;
         a FORK MOUNT with a counterweight — the thing tips about a pivot rather than being glued on.
       ⛔ The tube is drawn as perpendicular SLICES along the diagonal, so its gauge stays constant
          the whole way up; stepping a filled rect down a diagonal thins it at every corner. */
    const INK = '#241a10';
    const BRS = '#a8873f', BRS_LIT = '#dcb96f', BRS_MID = '#8d6f33', BRS_DK = '#5d4720';
    const MET = '#39434b', MET_LIT = '#5b6771', MET_DK = '#1d242a';
    shadow2(x + 1, y + h - 1, w - 2);
    /* (1) THE TRIPOD — three splayed legs off one hub, spreader, rubber feet */
    for (const [lx, dx] of [[x + 5, -1], [x + 6, 0], [x + 6, 1]]) {
      for (let i = 0; i < 10; i++) px(lx + Math.round(dx * i * 0.5), y + 12 + i, 1, 1, dx < 0 ? MET_LIT : (dx > 0 ? MET_DK : MET));
      px(lx + Math.round(dx * 5), y + 22, 2, 1, '#0d1215');
    }
    px(x + 3, y + 17, 6, 1, MET_DK); px(x + 3, y + 16, 6, 1, shade(MET, 0.12));   // the spreader
    px(x + 4, y + 9, 4, 4, INK); px(x + 5, y + 10, 2, 3, MET); px(x + 5, y + 10, 1, 3, MET_LIT);
    /* (2) THE FORK MOUNT — two prongs and a pivot bolt the tube tips about */
    px(x + 4, y + 3, 2, 7, INK); px(x + 7, y + 3, 2, 7, INK);
    px(x + 4, y + 4, 1, 6, MET_LIT); px(x + 5, y + 4, 1, 6, MET);
    px(x + 7, y + 4, 1, 6, shade(MET, -0.20)); px(x + 8, y + 4, 1, 6, MET_DK);
    px(x + 5, y + 3, 3, 1, MET_DK);
    px(x + 6, y + 3, 1, 1, shade(MET_LIT, 0.20));                                 // the pivot bolt
    /* (3) THE COUNTERWEIGHT — a short shaft down-east with a disc, so the tube reads as balanced */
    px(x + 8, y + 6, 3, 1, MET_DK);
    px(x + 10, y + 5, 3, 4, INK); px(x + 11, y + 6, 1, 2, shade(MET, 0.10)); px(x + 12, y + 6, 1, 2, MET_DK);
    /* (4) THE TUBE — perpendicular slices up the diagonal, tapering toward the objective */
    for (let i = 0; i < 15; i++) {
      const bx = x - 1 + i, by = y + 8 - i;
      const wide = i > 6;                                                           // it fattens past the mount
      const top = by - (wide ? 1 : 0);
      px(bx, top - 1, 1, 1, INK);                                                   // contour above
      px(bx, top, 1, 1, BRS_LIT);                                                   // lit crown
      px(bx, top + 1, 1, 1, BRS);
      px(bx, top + 2, 1, wide ? 2 : 1, BRS_MID);                                    // the mid band
      px(bx, top + (wide ? 4 : 3), 1, 1, BRS_DK);                                   // shaded belly
      px(bx, top + (wide ? 5 : 4), 1, 1, INK);                                      // contour below
      if (i === 5 || i === 10) { px(bx, top, 1, wide ? 5 : 4, shade(BRS_DK, 0.14)); px(bx, top, 1, 1, BRS_LIT); }   // tube rings
    }
    /* (5) THE OBJECTIVE — a dark mouth ring at the high end, cold sky caught in the glass */
    px(x + 13, y - 8, 3, 7, INK);
    px(x + 14, y - 7, 2, 5, BRS_DK); px(x + 14, y - 7, 2, 1, BRS_MID);
    px(x + 14, y - 6, 1, 3, '#bfe6ff'); px(x + 15, y - 6, 1, 3, shade('#bfe6ff', -0.40));
    bloom(x + 14, y - 6, 2, 3, '#bfe6ff', 0.22);
    /* (6) THE FINDER SCOPE — a small tube on brackets, parallel, above the eyepiece end */
    for (let i = 0; i < 6; i++) {
      const fx = x + 1 + i, fy = y + 3 - i;
      px(fx, fy - 1, 1, 1, INK); px(fx, fy, 1, 1, shade(MET_LIT, 0.10));
      px(fx, fy + 1, 1, 1, MET_DK); px(fx, fy + 2, 1, 1, INK);
    }
    px(x + 2, y + 4, 1, 2, MET); px(x + 5, y + 1, 1, 2, MET);                       // its two brackets
    /* (7) THE EYEPIECE — a stub standing PERPENDICULAR out of the low end, and a focuser knob */
    px(x - 3, y + 8, 3, 4, INK);
    px(x - 2, y + 9, 2, 1, MET_LIT); px(x - 2, y + 10, 2, 1, MET);
    px(x - 3, y + 9, 1, 2, shade(MET_LIT, 0.14));
    px(x + 1, y + 10, 2, 2, INK); px(x + 1, y + 10, 2, 1, shade(MET, 0.16));      // focuser knob
  };
  F.telescope_r = mirrorV(F.telescope);

  F.camerarig = (x, y, w, h, f) => {
    /* 1x2 CAMERA RIG — v3, the BODY redrawn (Andrew: "camera itself looks like garbage"). v2's body
       was a rounded blob with a blue square stuck on it. A broadcast camera reads from four things,
       and it needs all four at this size:
         a WEDGE body that tapers toward the lens (a plain box is a microwave),
         a STEPPED LENS BARREL — two rings narrowing to the glass, not one stub,
         the EYEPIECE hood jutting back over the operator's side,
         the CARRY HANDLE on top with DAYLIGHT UNDER IT, which is the one real outline break.
       ⛔ The tripod was never the problem — full-length splayed legs and a spreader stay as they are. */
    const INK = '#0b0e11', BODY = '#232a31', BODY_LIT = '#3f4a55', BODY_DK = '#141a1f';
    const MET = '#39434b', MET_LIT = '#5b6771', MET_DK = '#222a31';
    const hot = blink(1500, x);
    shadow2(x + 2, y + h - 1, 8);
    /* (1) THE TRIPOD — full height, splayed, spreader, rubber feet */
    for (const [lx, dx] of [[x + 5, -1], [x + 6, 0], [x + 6, 1]]) {
      for (let i = 0; i < 15; i++) {
        const px0 = lx + Math.round(dx * i * 0.42);
        px(px0, y + 8 + i, 1, 1, dx < 0 ? MET_LIT : (dx > 0 ? MET_DK : MET));
      }
      px(lx + Math.round(dx * 6), y + 22, 2, 1, '#0d1215');
    }
    px(x + 3, y + 15, 6, 1, MET_DK); px(x + 3, y + 14, 6, 1, shade(MET, 0.10));
    px(x + 5, y + 5, 2, 4, MET); px(x + 5, y + 5, 1, 4, MET_LIT);                   // centre column
    px(x + 4, y + 4, 4, 2, INK); px(x + 5, y + 4, 2, 1, MET_LIT);                   // pan head
    px(x + 9, y + 5, 3, 1, MET); px(x + 11, y + 6, 1, 2, MET_DK);                   // pan handle, out east
    /* (2) THE BODY — a WEDGE: full height at the back, stepping down toward the lens */
    px(x + 4, y - 3, 8, 8, INK);
    px(x + 2, y - 1, 3, 6, INK);
    px(x + 5, y - 2, 6, 6, BODY);
    px(x + 3, y, 2, 4, BODY);                                                       // the taper toward the lens
    px(x + 5, y - 2, 6, 1, BODY_LIT); keyEdge(x + 5, y - 2, 3, 1, 0.24);
    px(x + 3, y, 2, 1, shade(BODY_LIT, -0.14));
    px(x + 10, y - 1, 1, 5, BODY_DK); rimEdge(x + 10, y - 1, 1, 5, 0.20);
    px(x + 6, y, 3, 2, shade(BODY, 0.12));                                        // the cassette door
    px(x + 6, y, 3, 1, shade(BODY_LIT, -0.24));
    for (let i = 0; i < 3; i++) px(x + 9, y + 1 + i, 1, 1, shade(BODY_LIT, -0.16));   // vents
    /* (3) THE EYEPIECE, jutting BACK over the operator's shoulder */
    px(x + 10, y - 4, 4, 4, INK);
    px(x + 11, y - 3, 3, 2, BODY); px(x + 11, y - 3, 3, 1, BODY_LIT);
    px(x + 13, y - 2, 1, 1, shade('#7fd8ff', -0.30));
    px(x + 10, y - 5, 1, 1, hot ? '#ff3b30' : '#5a1a16');                           // the TALLY
    if (hot) bloom(x + 10, y - 5, 1, 1, '#ff3b30', 0.34);
    /* (4) THE CARRY HANDLE — daylight under it is the outline break the whole prop hangs on */
    px(x + 5, y - 6, 6, 1, INK);
    px(x + 5, y - 6, 6, 1, MET_LIT);
    px(x + 5, y - 5, 1, 2, MET); px(x + 10, y - 5, 1, 2, MET_DK);                   // its two posts
    /* (5) THE LENS — a stepped barrel narrowing to the glass, west */
    px(x, y - 1, 3, 6, INK);
    px(x + 1, y, 2, 4, shade(BODY, 0.06));                                        // the wide ring
    px(x + 1, y, 2, 1, shade(BODY_LIT, -0.10));
    px(x - 1, y + 1, 2, 3, INK);
    px(x, y + 1, 1, 2, BODY_DK);                                                    // the narrow ring
    px(x - 1, y + 1, 1, 2, '#7fd8ff'); px(x - 1, y + 1, 1, 1, '#cfefff');           // the glass
    bloom(x - 1, y + 1, 1, 2, '#7fd8ff', 0.24);
  };
  F.camerarig_r = mirrorV(F.camerarig);

  F.punchbag = (x, y, w, h, f) => {
    /* 1x2 HEAVY BAG on a floor stand — the mast stands at one side and the arm reaches OUT over the
       deck, so the bag hangs clear of the base and swings on its chain. That overhang is the whole
       silhouette: a bag hung directly over its own base is a bollard.
       ⛔ IT SWINGS, AND THE CHAIN SWINGS WITH IT. A bag drawn dead vertical reads as a punchbag
          nobody has ever hit; a 1px lean that reverses slowly is enough.
       ⛔ LEATHER IS A VALUE STACK, NOT A TEXTURE. Lit crown, a bright band under the straps, then a
          long fall to a near-black bottom where fists have worn it. */
    const INK = '#1a0f0c';
    const LTH = '#8a3a2a', LTH_LIT = '#c2604a', LTH_DK = '#4e1f16';
    const MET = '#39434b', MET_LIT = '#5b6771', MET_DK = '#1d242a';
    const sw = Math.round(Math.sin(now / 1500 + x) * 1.4);       // the bag's slow swing
    shadow2(x + 3, y + h - 1, 7);
    /* (1) THE STAND — a weighted base plate, a mast up the east side, an arm reaching west */
    /* ⛔ THE STAND HAS TO LOOK LIKE IT COULD HOLD THE BAG. v1's mast was 2px of pipe on a matchbox
       and the bag read as floating; this base is a WIDE weighted plate with a stack of ballast discs
       on it, and the mast is a proper 3px column braced back to that plate. */
    px(x + 5, y + 18, 7, 4, INK);
    px(x + 6, y + 19, 5, 2, MET); px(x + 6, y + 19, 5, 1, MET_LIT);
    px(x + 6, y + 21, 5, 1, '#0d1215');
    px(x + 7, y + 16, 4, 3, INK); px(x + 8, y + 17, 2, 2, shade(MET, -0.16));     // ballast discs
    px(x + 8, y + 16, 2, 1, shade(MET_LIT, -0.10));
    px(x + 8, y - 7, 4, 25, INK);
    px(x + 9, y - 6, 1, 24, MET_LIT); px(x + 10, y - 6, 2, 24, MET);                // the mast
    for (let i = 0; i < 4; i++) px(x + 9, y + 2 + i * 5, 3, 1, MET_DK);             // its sleeve joints
    for (let i = 0; i < 4; i++) px(x + 8 - i, y + 13 + i, 1, 1, MET);               // a brace down to the plate
    px(x + 1, y - 8, 11, 4, INK);
    px(x + 2, y - 7, 9, 1, MET_LIT); px(x + 2, y - 6, 9, 2, MET);                   // the arm
    px(x + 2, y - 5, 9, 1, shade(MET, -0.30));
    px(x + 9, y - 7, 3, 3, shade(MET_LIT, 0.10));                                 // the elbow gusset
    /* (2) THE CHAIN + SWIVEL, leaning with the bag */
    px(x + 5 + sw, y - 4, 1, 3, MET_DK);
    px(x + 5 + sw, y - 4, 1, 1, MET_LIT);
    px(x + 4 + sw, y - 1, 3, 1, MET);                                               // the ring the straps hang from
    /* (3) THE BAG — a leather cylinder, lit at the crown, worn near-black at the bottom */
    const bx = x + 1 + sw;
    rr(bx, y - 2, 8, 18, INK);                                                      // rounded: a bag has no corners
    px(bx + 1, y, 6, 2, LTH_LIT); keyEdge(bx + 1, y, 3, 1, 0.26);                   // crown
    px(bx + 1, y + 2, 6, 1, shade(LTH_LIT, -0.20));
    px(bx + 1, y + 3, 6, 7, LTH);
    px(bx + 1, y + 3, 1, 7, shade(LTH_LIT, -0.14)); px(bx + 6, y + 3, 1, 7, LTH_DK);
    rimEdge(bx + 6, y + 4, 1, 6, 0.18);
    px(bx + 1, y + 10, 6, 3, LTH_DK);                                               // the fall into shade
    px(bx + 1, y + 13, 6, 2, shade(LTH_DK, -0.34));                               // worn where the fists land
    px(bx + 2, y + 15, 4, 1, '#100a08');
    px(bx + 1, y + 6, 6, 1, shade(LTH, -0.26));                                   // a seam round its middle
    px(bx + 1, y + 7, 6, 1, shade(LTH, 0.08));
    px(bx + 3, y + 11, 2, 1, shade(LTH_DK, 0.18));                                // a scuff
    /* (4) THE STRAPS — two, from the ring down onto the crown */
    px(bx + 2, y - 1, 1, 2, MET_DK); px(bx + 5, y - 1, 1, 2, MET_DK);
    px(bx + 2, y - 1, 1, 1, MET_LIT);
  };
  F.punchbag_r = mirrorV(F.punchbag);

  F.benchpress = (x, y, w, h, f) => {
    /* 3x1 BENCH PRESS — v4, resized and re-proportioned against a BODY (Andrew: "way too short and
       the barbell is way too high, it would never make sense to look like that"). He is right on
       both, and the second one is a scale error I could have caught by measuring:
         an agent stands ~35px, so a 1.2m bench is ~25px LONG — v3's pad was 14px, half a person.
         The bar sits at the chest of someone LYING DOWN, which in this projection is barely above
         the pad — v3 put it 15px up, i.e. standing head height, which is a squat rack, not a bench.
       So the footprint grows to 3x1 and the rack shrinks to a stub: uprights ~6px proud of the pad,
       bar just above them, plates hanging either side of the bar and nearly touching the deck.
       ⛔ MEASURE A NEW PROP AGAINST THE 35px BODY BEFORE DRAWING IT. Everything else here is detail. */
    const INK = '#0e1114', PAD = '#22262b', PAD_LIT = '#3d4650';
    const MET = '#48525b', MET_LIT = '#7a8794', MET_DK = '#252c33';
    const RIM = '#b8332f', RIM_LIT = '#e0685a', DISC = '#181c20';
    shadow2(x + 3, y + h - 1, w - 6);
    /* (1) THE BENCH — long, raked toward the head (west), on a visible frame with deck between */
    for (const lx of [x + 13, x + 30]) {
      px(lx, y + 6, 3, 5, INK);
      px(lx, y + 6, 1, 5, MET_LIT); px(lx + 1, y + 6, 1, 5, MET); px(lx + 2, y + 6, 1, 5, MET_DK);
      px(lx - 1, y + 11, 5, 1, '#0d1215');
    }
    px(x + 15, y + 8, 15, 1, MET_DK); px(x + 15, y + 7, 15, 1, shade(MET, 0.14));   // the frame rail
    px(x + 9, y + 1, 25, 6, INK);
    px(x + 10, y + 2, 23, 2, PAD_LIT); keyEdge(x + 10, y + 2, 6, 1, 0.24);            // the pad's top plane
    px(x + 10, y + 4, 23, 2, PAD);
    px(x + 10, y + 6, 23, 1, shade(PAD, -0.34));                                    // its underside
    px(x + 9, y - 1, 8, 4, INK);
    px(x + 10, y, 6, 2, shade(PAD_LIT, 0.10));                                      // the HEAD, a row proud
    px(x + 10, y + 2, 6, 1, PAD);
    for (const sx of [x + 18, x + 24, x + 30]) px(sx, y + 3, 1, 1, shade(PAD_LIT, -0.26));   // stitching
    /* (2) THE RACK — a STUB, not a tower: two uprights barely clearing the pad */
    px(x + 5, y - 6, 4, 13, INK);
    px(x + 6, y - 5, 1, 12, MET_LIT); px(x + 7, y - 5, 1, 12, MET);
    px(x + 9, y - 4, 2, 10, INK); px(x + 9, y - 3, 1, 9, shade(MET, -0.28));       // the far upright, behind
    px(x + 5, y - 3, 4, 1, MET_DK);                                                   // the hook notch
    px(x + 4, y + 7, 6, 4, INK); px(x + 5, y + 8, 4, 2, MET); px(x + 5, y + 8, 4, 1, MET_LIT);
    px(x + 4, y + 11, 6, 1, '#0d1215');                                               // the rack's foot
    /* (3) THE BAR — racked in the notch, running east over the pad, low */
    px(x + 2, y - 5, 22, 2, INK);
    px(x + 3, y - 4, 20, 1, MET_LIT);
    px(x + 13, y - 4, 10, 1, MET);                                                    // dimming as it recedes
    px(x + 22, y - 4, 1, 1, MET_DK);
    /* (4) THE PLATES — discs on the bar's near and far ends, hanging LOW beside the head */
    rr(x + 8, y - 8, 5, 6, INK);
    rr(x + 9, y - 7, 3, 4, shade(DISC, 0.16));
    px(x + 10, y - 7, 1, 1, shade(RIM, -0.10));                                     // the FAR plate's crown
    rr(x + 1, y - 8, 7, 9, INK);
    rr(x + 2, y - 7, 5, 7, DISC);                                                     // the NEAR plate
    px(x + 3, y - 7, 3, 1, RIM_LIT); px(x + 3, y - 1, 3, 1, RIM);
    px(x + 2, y - 6, 1, 5, RIM); px(x + 6, y - 6, 1, 5, shade(RIM, -0.36));
    keyEdge(x + 3, y - 7, 2, 1, 0.28); rimEdge(x + 6, y - 5, 1, 3, 0.20);
    px(x + 3, y - 5, 1, 4, shade(DISC, 0.30));                                      // the lit facet on its face
    px(x + 4, y - 5, 2, 2, MET_DK); px(x + 4, y - 5, 2, 1, MET_LIT);                  // the collar at its hub
    /* (5) a spare plate leaning at the foot end — the detail that says GYM, not machine shop */
    rr(x + 33, y + 4, 4, 7, INK);
    rr(x + 34, y + 5, 2, 5, DISC); px(x + 34, y + 5, 2, 1, shade(RIM, 0.10));
    px(x + 33, y + 6, 1, 3, shade(RIM, -0.20));
  };
  F.benchpress_r = mirrorV(F.benchpress);

  F.weaponrack = (x, y, w, h, f) => {
    /* 3x1 WEAPON RACK — WALL-HUNG, arms hanging ACROSS it. v1 was dark-on-dark (a crate with sticks);
       v2 fixed the values but stood the arms upright, and a vertical barrel with its receiver tucked
       at the bottom edge is a PIPE — three of them is a plumbing manifold.
       ⛔ A WEAPON IS RECOGNISABLE IN PROFILE, NOT END-ON. Lying across the board, each one gets to
          show the shape that identifies it: long barrel, blocky receiver, magazine hanging under,
          stock raking down at the back. That is the entire difference between this and v2.
       ⛔ WALL-HUNG MEANS NO LEGS AND A SHADOW ON THE WALL — ride high, drop a standoff shadow, bolt
          at four corners, `blocks:false` so bodies walk in front of it (the chart-wall law).
       ⛔ THEY HANG AT DIFFERENT RAKES, and the bottom one is a blade — three parallel rifles would be
          a fence. ⛔ ONE LIVE THING: a charge cell breathing amber on the top arm. */
    const FRM = '#49535c', FRM_LIT = '#6d7883', FRM_DK = '#232a30';
    const WELL = '#141a1f', WELL_LIT = '#1e262c';
    const GUN = '#98a2aa', GUN_MID = '#5b656d', GUN_DK = '#262d34';
    const STK = '#8a6538', STK_LIT = '#b98d51';
    const cell = 0.55 + 0.45 * Math.sin(now / 1700 + x);
    /* (1) standoff shadow, frame, and the near-black well the arms hang in */
    ctx.globalAlpha = 0.30; px(x + 4, y - 12, w - 5, 18, '#000'); ctx.globalAlpha = 1;
    chamf(x + 1, y - 16, w - 2, 22, FRM_DK, 2);
    px(x + 2, y - 15, w - 4, 20, FRM);
    px(x + 2, y - 15, w - 4, 1, FRM_LIT); keyEdge(x + 2, y - 15, 7, 1, 0.26);
    px(x + 2, y - 15, 1, 20, shade(FRM_LIT, -0.16)); px(x + w - 3, y - 15, 1, 20, FRM_DK);
    rimEdge(x + w - 3, y - 14, 1, 18, 0.18);
    px(x + 3, y - 14, w - 6, 18, WELL);
    px(x + 3, y - 14, w - 6, 1, shade(WELL, -0.44));
    px(x + 4, y - 13, w - 8, 1, WELL_LIT);
    px(x + 3, y - 1, w - 6, 1, shade(FRM, -0.26));                               // the shelf between the two arms
    for (const [bx, by] of [[x + 2, y - 15], [x + w - 3, y - 15], [x + 2, y + 3], [x + w - 3, y + 3]]) {
      px(bx, by, 1, 1, shade(FRM_LIT, 0.24)); px(bx, by + 1, 1, 1, FRM_DK);
    }
    /* (2) THE ARMS. This prop has now failed in both directions and the useful part is WHY:
       ⛔ v5 was 1.6x oversize (a 30px rifle against a 35px body — "too big for the agents").
       ⛔ v6 was measured EXACTLY right at 18px and Andrew could no longer tell what he was looking
          at. Both are true: a 0.9m rifle at the station's ~20px/metre IS 18px, and 18px cannot hold
          the silhouette that identifies a rifle. That is the RESOLUTION CEILING this catalog keeps
          hitting, not an art failure.
       So the answer is not a third size, it is FEWER THINGS WITH MORE ROOM: one rifle and one blade
       instead of two rifles and a blade, the rifle drawn at 22px (~1.1m — a hero scale a hair over
       true, the way a game prop is allowed to be) with every part given a pixel it can be read by,
       and the parts separated by DARK so the eye can find each one against the well.
       ⛔ THE RULE THAT COMES OUT OF THIS: when a prop cannot be both true-scale and legible, cut the
          COUNT, not the size. Two objects at 22px read; three at 18px are a texture. */
    const weapon = (x0, y0) => {
      const bl = x0 + 15;                                                          // where the barrel starts
      /* stock — a solid block with a dark comb line, then daylight before the grip */
      px(x0, y0 - 3, 7, 6, GUN_DK);
      px(x0 + 1, y0 - 2, 5, 4, shade(GUN_MID, -0.06));
      px(x0 + 1, y0 - 2, 5, 1, GUN);
      px(x0 + 1, y0, 4, 1, shade(GUN_DK, 0.30));                                 // the comb
      px(x0, y0 - 2, 1, 4, shade(GUN_DK, 0.26));                                 // butt pad
      /* pistol grip, hanging clear below the receiver */
      px(x0 + 6, y0 + 3, 3, 4, GUN_DK);
      px(x0 + 7, y0 + 3, 1, 3, shade(GUN_MID, 0.06));
      /* receiver — the widest, lightest block on the weapon: this is what says "gun" */
      px(x0 + 5, y0 - 3, 9, 6, GUN_DK);
      px(x0 + 6, y0 - 2, 7, 2, GUN);
      px(x0 + 6, y0, 7, 2, GUN_MID);
      px(x0 + 9, y0 - 2, 3, 2, shade(GUN_DK, 0.40));                             // ejection port, a real hole
      px(x0 + 6, y0 - 3, 2, 1, '#cfd7dc');                                         // charging handle
      px(x0 + 7, y0 + 2, 1, 1, '#ffb347');                                         // selector
      /* magazine — long enough to read, curving forward as it drops */
      px(x0 + 9, y0 + 3, 4, 3, GUN_DK); px(x0 + 10, y0 + 6, 4, 2, GUN_DK);
      px(x0 + 10, y0 + 3, 2, 2, shade(GUN_MID, 0.04)); px(x0 + 11, y0 + 6, 2, 1, shade(GUN_MID, -0.20));
      /* handguard, then the barrel — one row, with a front sight standing off it */
      px(x0 + 13, y0 - 2, 4, 4, GUN_DK);
      px(x0 + 13, y0 - 1, 4, 2, GUN_MID);
      px(x0 + 14, y0 - 1, 1, 2, shade(GUN_DK, 0.30)); px(x0 + 16, y0 - 1, 1, 2, shade(GUN_DK, 0.30));
      px(x0 + 15, y0 - 4, 1, 2, GUN_MID);                                          // front sight post
      for (let i = 0; i < 4; i++) {
        px(bl + i, y0 - 2, 1, 1, GUN_DK);
        px(bl + i, y0 - 1, 1, 1, GUN);
        px(bl + i, y0, 1, 1, GUN_MID);
        px(bl + i, y0 + 1, 1, 1, GUN_DK);
      }
      px(bl + 4, y0 - 2, 3, 4, GUN_DK);                                            // muzzle device
      px(bl + 4, y0 - 1, 3, 1, '#cfd7dc'); px(bl + 5, y0, 2, 1, GUN_MID);
      /* the optic sits ABOVE the receiver with dark under it, so it is not read as more receiver */
      px(x0 + 6, y0 - 7, 8, 3, GUN_DK);
      px(x0 + 7, y0 - 6, 6, 1, GUN); px(x0 + 7, y0 - 5, 6, 1, GUN_MID);
      px(x0 + 13, y0 - 6, 1, 2, '#7fd8ff'); px(x0 + 13, y0 - 6, 1, 1, '#cfefff');
      px(x0 + 8, y0 - 4, 1, 1, GUN_MID); px(x0 + 12, y0 - 4, 1, 1, GUN_MID);       // its two rings
      /* the sling, drooping under the whole thing — the one curve on the prop */
      for (let i = 0; i < 11; i++) {
        const sx = x0 + 3 + i, sy = y0 + 4 + Math.round(2.2 * Math.sin((i / 10) * Math.PI));
        px(sx, sy, 1, 1, shade(GUN_DK, 0.14));
      }
    };
    /* ⛔ A 22px RIFLE NEEDS THREE TILES OF BOARD, NOT TWO. At 2x1 the muzzle came out through the
       frame — the board has to be sized from the LONGEST thing on it plus margin, not the other way
       round. 36px of board holds a 22px arm with a hand's width either side. */
    weapon(x + 7, y - 8);                                                          // ONE rifle, 22px, with room
    /* (3) the CHARGE CELL on the top arm — the one live thing on the prop */
    px(x + 27, y - 9, 2, 1, shade('#ffb347', -0.30 + 0.30 * cell));
    bloom(x + 27, y - 9, 2, 1, '#ffb347', 0.12 + 0.18 * cell);
    /* (4) a BLADE hung VERTICALLY at the east end — a third rifle would be a fence, and a blade
       across the whole board (v4) crowded both arms out of their own space */
    for (let i = 0; i < 14; i++) {                                                  // a blade, hung flat
      const bx = x + 10 + i;
      px(bx, y + 1, 1, 1, GUN_DK);
      px(bx, y + 2, 1, 1, i > 1 ? '#cfd7dc' : GUN_MID);
      px(bx, y + 3, 1, 1, i > 1 ? '#79838b' : GUN_DK);
      px(bx, y + 4, 1, 1, GUN_DK);
    }
    px(x + 24, y + 1, 2, 4, GUN_DK); px(x + 24, y + 2, 2, 1, shade('#cfd7dc', -0.20));   // its point
    px(x + 6, y + 1, 4, 4, GUN_DK); px(x + 7, y + 2, 3, 2, STK); px(x + 7, y + 2, 3, 1, STK_LIT);
    px(x + 9, y, 1, 5, shade(GUN_MID, 0.10));                                    // the guard between grip and blade
    /* (5) HOOKS the arms rest on, and spare cells clipped at the end — a rack that is USED */
    for (const hx of [x + 5, x + 30]) { px(hx, y - 6, 1, 2, FRM_LIT); px(hx, y + 1, 1, 2, FRM_LIT); }
  };
  F.weaponrack_r = mirrorV(F.weaponrack);
  /* ============ THE COLOUR SHELF (2026-08-17) ============
     Andrew's brief: the station is hard to make look good because there are too FEW props, too many
     face the same way, and almost none carry colour. These are the answer to the third and the
     hardest: each is a FLOOR-SIZED object (never a tabletop trinket) built around ONE saturated
     identity — cyan glass, racing red, plasma violet, soda orange — so a room furnished from this
     shelf stops reading as a grey machine hall.
     ⛔ COLOUR IS LOCAL, LIGHT IS NOT. A prop may own any hue it likes; it is still lit by the
        station's warm west KEY and cool east SKY, and its contour is still a dark tint of its OWN
        hue. Saturated art under the shipped lightmap is the whole trick — a prop that lights itself
        differently from the room reads as a sticker.
     ⛔ ONE SILHOUETTE, THEN FILLS. Paint the whole outline first, then interiors over it. Outlining
        each panel separately is what turned an earlier batch into cabinets. */

  /* ⛔⛔⛔ THE CLAW-MACHINE RECIPE (2026-08-17, the only one of the first four Andrew kept).
     Four props were shown; three were rejected and the CLAW MACHINE was kept, so what it does is
     now the pattern for this shelf, and the three failures say why:
       1. STACKED BANDS, not one shape. Lit sign → window → contents → control band → plinth. The
          plasma column was a single tall shape (a lamp, not an object) and the soda fountain was a
          flat front (a beige box).
       2. A WINDOW WITH CONTENTS IN IT. The prizes are what make a claw machine; the read is always
          what is INSIDE, never the casing. Every prop below has something visible behind glass.
       3. ONE SATURATED BODY HUE + small saturated hardware. Not a grey box with a colour patch.
       4. UPRIGHT AND FLOOR-SIZED (1x2 minimum). The racing seat failed partly on size — one tile
          cannot carry an identity that has to compete with a 5-tile couch across the room. */







  F.pinball = (x, y, w, h, f) => {   // 1x2 — v6 REBUILD. A pinball machine IS its playfield ("a prop is its
    /* ⛔ EDGES SOFTENED, NOTHING ELSE — shipped geometry, shading and colour untouched. The
       universal near-black contour becomes a dark tint so the prop stops reading as a sticker
       cut out and laid on the deck. Same EDGE the couch uses, so the lounge reads as one room. */
    const EDGE = '#161d22';
    // top surface"), and v5 gave the playfield 4 rows of dark glass under a 9-row backbox — the identity
    // was a sliver under a head. Now the machine is a WEDGE first: a raked 10-row playfield plane between
    // side walls, a plunger knob breaking the silhouette east, chrome legs, and the backbox sized to serve
    // the field, not outrank it. f.work = an agent is really on the sticks.
    const r = RAMP.steel, ph = (f && f.x) || 0, base = y + h;   // h is PIXELS here, never tiles
    const played = !!(f && f.work);
    shadow2(x + 1, base - 1, 11);
    // chrome legs — front pair splayed a px outward at the foot, the machine's stance
    for (const [lx, dxx] of [[x + 1, -1], [x + 10, 1]]) {
      px(lx + dxx, base - 2, 2, 2, EDGE); px(lx, base - 5, 2, 3, EDGE);
      px(lx + dxx, base - 2, 1, 2, '#8a97a0'); px(lx, base - 5, 1, 3, '#8a97a0');
      px(lx + dxx + 1, base - 2, 1, 2, '#3c464d'); px(lx + 1, base - 5, 1, 3, '#3c464d');
    }
    underAO(x + 3, base - 4, 7, 3);
    // CABINET — the wedge. Body walls rise to hold the raked field; the west wall carries the side art.
    chamf(x - 1, base - 17, 15, 13, EDGE, 1);
    px(x, base - 16, 13, 11, r.face);
    px(x, base - 16, 1, 11, r.lit); keyEdge(x, base - 16, 1, 6, 0.22);          // lit west wall
    px(x + 12, base - 16, 1, 11, r.dk); rimEdge(x + 12, base - 16, 1, 11, 0.20); // shaded east wall
    px(x, base - 9, 1, 3, ACC.lounge); px(x, base - 12, 1, 2, shade(ACC.lounge, -0.30));   // side art flash
    // PLAYFIELD — the raked plane, far edge lifted: brighter at the north, falling to the near lip
    const pf = base - 15, pw = 9, pfx = x + 2;                  // field x+2..x+10; x+11 is the shooter lane
    px(pfx - 1, pf - 1, pw + 3, 9, EDGE);
    for (let j = 0; j < 8; j++) {
      const t = j / 7;
      px(pfx, pf + j, pw, 1, shade('#1b3038', 0.30 - t * 0.52));   // rake: light falls off toward the player
    }
    px(pfx, pf - 1, pw, 1, '#4d666f');                          // far edge catches the room — the tilt's tell
    px(pfx + pw, pf - 1, 1, 9, shade(r.face, -0.34));         // shooter-lane wall
    px(pfx + pw + 1, pf, 1, 8, '#101b20');                      // the lane itself
    // rollover arcs at the head of the field — two stepped guides, pure pinball vocabulary
    px(pfx, pf, 2, 1, '#33555f'); px(pfx + 1, pf + 1, 1, 1, '#33555f');
    px(pfx + pw - 2, pf, 2, 1, '#33555f'); px(pfx + pw - 2, pf + 1, 1, 1, '#33555f');
    // pop bumpers — round caps with a lit core; they FIRE under play, breathe dim in attract
    const bump = (bx, by, c, per, k) => {
      const on = played ? blink(per, ph + k) : blink(per * 3, ph + k);
      px(bx, by, 2, 2, shade(c, on ? -0.05 : -0.55));
      px(bx, by, 1, 1, shade(c, on ? 0.38 : -0.35));
      if (on && played) bloom(bx, by, 2, 2, c, 0.30);
    };
    bump(pfx + 1, pf + 2, ACC.alert, 430, 0);
    bump(pfx + 5, pf + 1, ACC.flow, 610, 1);
    bump(pfx + 3, pf + 4, ACC.data, 790, 2);
    // slingshots + flippers at the near end — the two little levers ARE the game
    px(pfx + 1, pf + 6, 2, 1, '#9fb0b2'); px(pfx + 1, pf + 5, 1, 1, shade('#9fb0b2', -0.3));
    px(pfx + 6, pf + 6, 2, 1, '#9fb0b2'); px(pfx + 7, pf + 5, 1, 1, shade('#9fb0b2', -0.3));
    // the ball: in play it ricochets the field on a hash walk; idle it waits in the shooter lane
    if (played) {
      const bk = U.hash('pb' + (Math.floor(now / 240) + ph));
      px(pfx + 1 + (bk % (pw - 2)), pf + 1 + ((bk >>> 4) % 5), 1, 1, '#eef6f8');
    } else {
      px(pfx + pw + 1, pf + 7, 1, 1, '#b9c6cb');
    }
    // FRONT FACE under the near lip — coin door west, and the plunger knob jutting out the east flank
    px(x + 1, base - 6, 11, 1, shade(r.face, -0.42));         // near lip shadow line
    px(x + 3, base - 5, 3, 2, '#10161a'); px(x + 4, base - 4, 1, 1, '#c9a24a');   // coin door + slot glint
    px(x + 12, base - 8, 3, 2, EDGE); px(x + 13, base - 8, 2, 1, '#b8434f');      // plunger rod + red knob
    px(x + 14, base - 8, 1, 1, shade('#b8434f', 0.30));
    // BACKBOX — narrower than the cab, standing at the head: marquee, score reels, speaker dots
    px(x + 1, base - 27, 11, 11, EDGE);
    px(x + 2, base - 26, 9, 9, '#161d24');
    px(x + 2, base - 26, 9, 1, '#2c3944'); keyEdge(x + 2, base - 26, 5, 1, 0.24);
    px(x + 10, base - 25, 1, 8, '#0c1116');                     // shaded east reveal
    const hot = played || blink(1400, ph);
    px(x + 3, base - 25, 7, 2, shade(ACC.lounge, hot ? 0.05 : -0.45));          // marquee band
    px(x + 4, base - 25, 2, 1, '#ffd0ee'); px(x + 7, base - 24, 2, 1, shade(ACC.lounge, 0.30));  // title
    bloom(x + 3, base - 25, 7, 2, ACC.lounge, played ? 0.40 : hot ? 0.22 : 0.10);
    px(x + 3, base - 22, 7, 3, '#0d0a14');                      // backglass art well
    for (let i = 0; i < 4; i++) {                               // score reels — they ROLL under play
      const dg = played ? (Math.floor(now / 180) + i * 3 + ph) % 4 : 0;
      px(x + 3 + i * 2, base - 21, 1, 1, played ? ['#ffd34a', '#e8b83a', '#ffe27a', '#caa22e'][dg] : '#4a3a1a');
    }
    px(x + 3, base - 18, 1, 1, '#232d33'); px(x + 9, base - 18, 1, 1, '#232d33'); // speaker dots
    scanl(x + 3, base - 22, 7, 3, 0.16);
    px(x + 2, base - 16, 9, 1, shade(r.face, -0.30));         // neck shadow where the head meets the body
    spill(pfx, pf, pw, ACC.lounge, played ? 0.16 : 0.06, 3);    // marquee light pooling down the glass
  };

  F.steamvent = (x, y, w, h, f) => {   // FLUSH deck grate (walk-over) — all the presence is the plume above it
    const ph = (f && f.x) || 0;
    // inlaid, no rise: agents cross this tile, so nothing may stand proud of the deck. The grate fills
    // the tile — v1 drew a small dim panel that read as a smudge on the floor.
    px(x + 0, y + 3, 12, 9, '#070b0d');
    px(x + 1, y + 4, 10, 7, '#1b242a');
    px(x + 1, y + 4, 10, 1, '#33424b'); keyEdge(x + 1, y + 4, 5, 1, 0.20);
    px(x + 1, y + 10, 10, 1, '#060a0c');
    for (let i = 0; i < 5; i++) {                                            // deep bars, with a lit west lip each
      px(x + 2 + i * 2, y + 5, 1, 5, '#0a1013');
      px(x + 3 + i * 2, y + 5, 1, 5, '#25313a');
    }
    px(x + 1, y + 4, 1, 7, '#3b4a52'); px(x + 10, y + 4, 1, 7, '#111a1e');   // frame
    px(x + 1, y + 4, 1, 1, '#556770'); px(x + 10, y + 10, 1, 1, '#0a0f12');  // bolt heads
    // PLUME: a 3.4s cycle that is VENTING most of it — v1 idled dark two thirds of the time, so the
    // prop read as a dead grille whenever you looked. Still gapped, so a room of them never fogs over.
    const t = ((now / 3400) + ph * 0.37) % 1;
    if (t < 0.78) {
      const k = t / 0.78, rise = Math.round(k * 11), spreadN = 1 + Math.round(k * 3);
      const a = (k < 0.18 ? k / 0.18 : (1 - k) / 0.82) * 0.42;
      ctx.globalAlpha = a * 0.7; px(x + 4, y + 2, 4, 3, '#e8f2f4'); ctx.globalAlpha = 1;   // the throat, brightest
      for (let i = 0; i < 5; i++) {
        const yy = y + 3 - rise + i * 2;
        if (yy < y - 9) break;
        const wob = Math.round(Math.sin(now / 520 + i + ph) * 1.6);
        ctx.globalAlpha = Math.max(0, a * (1 - i * 0.19));
        px(x + 5 - spreadN + wob, yy, spreadN * 2 + 2, 2, '#cfe0e4');
        ctx.globalAlpha = 1;
      }
    }
  };

  /* ============ CATALOG — every placeable prop ============
     id        — F key (the draw fn) AND the model's prop.t
     label     — palette button text
     cat       — palette group
     w,h       — default footprint in tiles
     animated  — has a per-frame emissive accent (informational)
     blocks    — occupies its footprint tiles for pathfinding (agents route around)
     use       — OPTIONAL leisure descriptor {kind, sit, approach}: marks a prop an idle
                 agent can lounge at (couch/tv/arcade/…). world.js derives the approach
                 tile via propanchor.js; sit=true seats the agent, approach biases the side. */
  /* short Fallout-style blurbs for the hover card (functional props). Reused where the effect is identical. */
  const D_WS = 'WORKSTATION — assign an agent here and it walks over and sits to work whenever it gets a task.';
  const D_FILES = 'CAPABILITY — gives the agent in this room file access (read & write its own files).';
  const D_WEB = 'CAPABILITY — gives the agent in this room web access (live search & fetch).';
  const D_MEM = 'CAPABILITY — gives the agent in this room long-term memory AND its skill library (a notebook it recalls facts from, and where it saves & reloads reusable skills).';

  /* CATALOG is split into two TIERS for the builder palette (shown as ⚙ SYSTEMS / ✦ DECOR):
       functional — SYSTEMS: props that DO something (place · assign · wire into real workflows)
       cosmetic   — DECOR: looks only (decoration, atmosphere, leisure)
     `tier` + `cat` drive the palette grouping; `seat:true` marks an agent-assignable workstation;
     `desc` is the hover-card blurb. None of this is read by the routing/capability backend (it keys on prop.t).

     THE MOUNT AXIS (three states — worldmodel.js checkProp enforces them):
       surface: true    this prop IS a table; other props may stand on it.
       mount:'surface'  this prop REQUIRES a table (it has no business on bare deck).
       stack: true      this prop MAY stand on a table, and is equally at home on the deck.
     stack was added 2026-07-29 because only the two mount:'surface' props could ever be placed on a
     table — a mug, a plant or a stack of printouts hit OVERLAP — so tables read as unusable. What
     earns the flag is what the ART DRAWS, never the name: an object whose contact is its own base
     (mug, pot, papers, tote, speaker cab) stacks; anything that draws legs, a stand or a deckPlate
     is floor furniture and does not (arc_microfiche is a reader DESK, comms_inbox is bolted down,
     tank/monstera are explicitly floor pieces). Every prop function anchors to its footprint bottom,
     so a stacked prop needs no art change — draw() lifts the whole origin by SURFACE_RISE. */
  const CATALOG = [
    /* ===================== FUNCTIONAL ===================== */
    // WORKSTATIONS — the agent's seat. Assign ONE agent; it walks here and sits to work when tasked.
    { id: "desk", label: "DESK", cat: "workstation", tier: "functional", seat: true, w: 2, h: 1, animated: true, blocks: true, desc: D_WS },
    { id: "desk2", label: "DESK ×2", cat: "workstation", tier: "functional", seat: true, w: 2, h: 1, animated: true, blocks: true, desc: D_WS },
    { id: "console", label: "CONSOLE", cat: "workstation", tier: "functional", seat: true, w: 2, h: 1, animated: true, blocks: true, desc: D_WS },
    { id: "consoleL", label: "CONSOLE L", cat: "workstation", tier: "functional", seat: true, w: 3, h: 1, animated: true, blocks: true, desc: D_WS },
    { id: "pixelrig", label: "PIXEL RIG", cat: "workstation", tier: "functional", seat: true, w: 2, h: 1, animated: true, blocks: true, desc: D_WS },
    { id: "bench", label: "BENCH", cat: "workstation", tier: "functional", seat: true, w: 4, h: 1, animated: true, blocks: true, desc: D_WS },
    { id: "workbench", label: "WORKBENCH", cat: "workstation", tier: "functional", w: 2, h: 1, animated: true, blocks: true, desc: "WORKBENCH — grants the room's agent shell + verify, so it can run and test real code. Pair it with a workstation in the same room." },
    // WORKFLOW — how work enters, moves, routes, and leaves.
    // (id stays 'intake' — saves/routing keys never rename; INBOX is the user-facing word, mirroring OUTBOX)
    // Docks (2×2 floor machines) are SOLID: belts hook to their ring tiles (connectBelt's pathable
    // excludes every prop footprint), so nothing needs to stand ON them — agents route around.
    // The 1×1 junctions below stay blocks:false: they sit ON a belt line (belt tile underneath),
    // and belts are walkable floor machinery by contract.
    { id: "intake", label: "INBOX", cat: "workflow", tier: "functional", w: 2, h: 2, animated: true, blocks: true, desc: "Your floor is a flowchart — work arrives at the INBOX, every BAY is an agent doing one step, and the belts you draw are the order the work flows. OUTSIDE work (a DM, a routine) arrives here and drops onto a belt. Orders you give in COMMS skip it — they land straight at the agent's BAY. You don't need one for an agent to work — a BAY alone is enough; the inbox is for watching outside work ride in." },
    { id: "bay", label: "BAY", cat: "workflow", tier: "functional", w: 2, h: 2, animated: true, blocks: true, desc: "BAY — the agent dock. Click it, assign an agent — done: work for that agent lands here, no belts required. Add belts to watch work ride in from an INBOX (and finished work ride out to an OUTBOX). The props in its room become its powers." },
    { id: "filter", label: "FILTER", cat: "workflow", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "FILTER — sorts UNADDRESSED work by its content, sending each kind down a different belt lane. Work already bound to an agent rides straight home past it. Click it to set the routes." },
    { id: "merger", label: "MERGER", cat: "workflow", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "MERGER — a lane funnel: several belt lanes converge into one, and every crate rides straight on (K in, K out). It tidies the lanes — it never combines the jobs riding them; each still runs on its own. Nothing to configure." },
    { id: "splitter", label: "SPLITTER", cat: "workflow", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "SPLITTER — fans one work stream across its lanes to run several agents in parallel (load-balance)." },
    { id: "joiner", label: "JOINER", cat: "workflow", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "JOINER — the fan-in barrier. Every lane feeding it is a branch of the same job: it HOLDS each branch's result until all of them have arrived (or 10 minutes pass), then sends ONE merged crate on, each branch's output clearly labelled. Draw a SPLITTER upstream and its lanes run in parallel instead of taking turns." },
    { id: "loop", label: "LOOP", cat: "workflow", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "LOOP — the gate that makes a cycle legal. Belt its BACK lane to an upstream dock and its DONE lane onward: work goes round again (up to 5 passes by default, 20 at most), then leaves on DONE. Spend stays inside the line's dollar cap. Any cycle without a LOOP is still refused." },
    { id: "outbox", label: "OUTBOX", cat: "workflow", tier: "functional", w: 2, h: 2, animated: true, blocks: true, desc: "OUTBOX — the dispatch chute where an agent's finished reply leaves the station. Click it to read and rate every finished run waiting for you." },
    // NOTE: the old "CONVEYOR" palette prop (beltH) is retired — it was inert scenery that LOOKED like the
    // routing system and taught users the wrong model (you can't assign or route through it). Real belts are
    // laid with the BELT tool and compile into the RoutingPlan. F.beltH stays so stations that placed one
    // still render; it just can't be placed anew.
    // CAPABILITY — object = capability. Place one in a BAY's room to grant that agent a power.
    { id: "connector_portal", label: "CONNECTOR", cat: "capability", tier: "functional", w: 1, h: 2, animated: true, blocks: true, desc: "CONNECTOR — bind an MCP server here to grant the room's agent that server's live tools. Click it to bind one." },
    { id: "comms_dish", label: "DISH", cat: "capability", tier: "functional", w: 2, h: 2, animated: true, blocks: true, desc: D_WEB },
    { id: "comms_uplink", label: "UPLINK", cat: "capability", tier: "functional", w: 2, h: 2, animated: true, blocks: true, desc: D_WEB },
    { id: "comms_beacon", label: "BEACON", cat: "capability", tier: "functional", w: 1, h: 2, animated: true, blocks: true, desc: D_WEB },
    { id: "war_intelcab", label: "INTEL CAB", cat: "capability", tier: "functional", w: 1, h: 2, animated: true, blocks: true, desc: D_FILES },
    { id: "safe", label: "SAFE", cat: "capability", tier: "functional", w: 1, h: 2, animated: true, blocks: true, desc: D_FILES },
    { id: "vault", label: "VAULT", cat: "capability", tier: "functional", w: 3, h: 2, animated: true, blocks: true, desc: D_FILES },
    { id: "rack", label: "RACK", cat: "capability", tier: "functional", w: 2, h: 1, animated: true, blocks: true, desc: D_FILES },
    { id: "shelf", label: "SHELF", cat: "capability", tier: "functional", w: 4, h: 1, animated: true, blocks: true, desc: D_FILES },
    { id: "core", label: "CORE", cat: "capability", tier: "functional", w: 1, h: 2, animated: true, blocks: true, desc: D_MEM },
    { id: "gigs_servercart", label: "SERVER CART", cat: "capability", tier: "functional", w: 1, h: 1, animated: true, blocks: true, desc: D_MEM },
    { id: "bridge_relaystack", label: "RELAY STACK", cat: "capability", tier: "functional", w: 1, h: 2, animated: true, blocks: true, desc: D_MEM },
    { id: "studio", label: "STUDIO", cat: "capability", tier: "functional", w: 2, h: 2, animated: true, blocks: true, desc: "CAPABILITY — gives the agent in this room a media studio (generate & analyze images). It glows magenta while an image renders." },
    // ISOLATION — seal a room off on the floor.
    { id: "airlock", label: "AIRLOCK", cat: "isolation", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "AIRLOCK — seals a room on the floor (a staging / merge gate); the agent's body can't path in or out. Click to cycle open / sealed / jammed." },
    // COMMAND — mission surfaces (functional-but-not-capability: they grant no tools; they make the
    // station's real state readable + clickable. The workstation-model rule: functional props that aren't
    // capability objects get their own category, never mixed into cosmetics).
    { id: "missionboard", label: "MISSION BOARD", cat: "command", tier: "functional", w: 3, h: 1, animated: true, blocks: false, desc: "MISSION BOARD — the quest log made physical. Every pinned card is a real open quest; click the board to read them. It suggests, never gates." },
    { id: "trophycase", label: "TROPHY CASE", cat: "command", tier: "functional", w: 2, h: 2, animated: true, blocks: true, desc: "TROPHY CASE — the station's real achievements made permanent. Earned milestones, completed quests, and your living tools stand behind glass; click to open the case. It grants nothing — it remembers." },

    /* ===================== COSMETIC ===================== */
    // SCREENS — ops & display dressing.
    { id: "bigscreen", label: "BIG SCREEN", cat: "screens", tier: "cosmetic", w: 8, h: 1, animated: true, blocks: false },
    { id: "holotable", label: "HOLOTABLE", cat: "screens", tier: "cosmetic", w: 4, h: 2, animated: true, blocks: true },
    { id: "screens", label: "SCREENS", cat: "screens", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: false },
    { id: "tank", label: "TANK", cat: "screens", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "whiteboard", label: "WHITEBOARD", cat: "screens", tier: "cosmetic", w: 4, h: 1, animated: true, blocks: false },
    { id: "ticker", label: "TICKER", cat: "screens", tier: "cosmetic", w: 4, h: 1, animated: true, blocks: false },
    { id: "chartwall", label: "CHART WALL", cat: "screens", tier: "cosmetic", w: 3, h: 1, animated: true, blocks: false },
    { id: "wartable", label: "WAR TABLE", cat: "screens", tier: "cosmetic", w: 5, h: 2, animated: true, blocks: true },
    { id: "calwall", label: "CAL WALL", cat: "screens", tier: "cosmetic", w: 6, h: 1, animated: true, blocks: false },
    { id: "bridge_tacscreen", label: "TAC SCREEN", cat: "screens", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: false },
    { id: "bridge_dispatch_pylon", label: "DISPATCH PYLON", cat: "screens", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "bridge_orderqueue", label: "ORDER QUEUE", cat: "screens", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "war_pivotpanel", label: "PIVOT PANEL", cat: "screens", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "war_threatcore", label: "THREAT CORE", cat: "screens", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    // LAB — research & craft dressing.
    { id: "fabricator", label: "FABRICATOR", cat: "lab", tier: "cosmetic", w: 3, h: 2, animated: true, blocks: true },
    { id: "vat", label: "VAT", cat: "lab", tier: "cosmetic", w: 3, h: 2, animated: true, blocks: true },
    { id: "easel", label: "EASEL", cat: "lab", tier: "cosmetic", w: 3, h: 2, animated: true, blocks: true },
    { id: "tube", label: "TUBE", cat: "lab", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "research_corelens", label: "CORE LENS", cat: "lab", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "research_trendpillar", label: "TREND PILLAR", cat: "lab", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "research_samplecart", label: "SAMPLE CART", cat: "lab", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "research_papers", label: "PAPERS", cat: "lab", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: false, stack: true },
    { id: "etsy_threadrack", label: "THREAD RACK", cat: "lab", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "etsy_dyevat", label: "DYE VAT", cat: "lab", tier: "cosmetic", w: 2, h: 2, animated: true, blocks: true },
    { id: "etsy_kiln", label: "KILN", cat: "lab", tier: "cosmetic", w: 2, h: 2, animated: true, blocks: true },
    { id: "etsy_packbot", label: "PACK BOT", cat: "lab", tier: "cosmetic", w: 2, h: 2, animated: true, blocks: true },
    // STORAGE — crates, bins & vaults (decorative).
    { id: "rackV", label: "RACK V", cat: "storage", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "crate", label: "CRATE", cat: "storage", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "boxes", label: "BOXES", cat: "storage", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true, stack: true },
    { id: "goldcrate", label: "GOLD CRATE", cat: "storage", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    // NOTE: "PARCELS" is retired from the palette (2026-08-16, Andrew's call) — it was a stack of
    // unreadable 1-tile boxes that added nothing the CRATE does not say better. F.parcels stays so
    // stations that already placed one still render; it just can't be placed anew. Same treatment the
    // old CONVEYOR prop got — retiring the TYPE outright would strand an invisible obstacle in saves.
    { id: "gigs_partsbin", label: "PARTS BIN", cat: "storage", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true, stack: true },
    { id: "treasury_coinsorter", label: "COIN SORTER", cat: "storage", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "treasury_token_furnace", label: "TOKEN FURNACE", cat: "storage", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    // COMMS — antennas & mail dressing.
    { id: "commswall", label: "COMMS WALL", cat: "comms", tier: "cosmetic", w: 6, h: 1, animated: true, blocks: false },
    { id: "comms_inbox", label: "INBOX", cat: "comms", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "gigs_thumbwall", label: "THUMB WALL", cat: "comms", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: false },
    { id: "gigs_amp", label: "AMP", cat: "comms", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true, stack: true },
    { id: "pub_publishpress", label: "PUBLISH PRESS", cat: "comms", tier: "cosmetic", w: 2, h: 2, animated: true, blocks: true },
    { id: "pub_outboundchute", label: "OUTBOUND CHUTE", cat: "comms", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "pub_mailpod", label: "MAIL POD", cat: "comms", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "arc_indexwall", label: "INDEX WALL", cat: "comms", tier: "cosmetic", w: 4, h: 1, animated: true, blocks: false },
    { id: "arc_microfiche", label: "MICROFICHE", cat: "comms", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    // LOUNGE — morale & downtime (idle agents drift here).
    { id: "djbooth", label: "DJ BOOTH", cat: "lounge", tier: "cosmetic", w: 4, h: 2, animated: true, blocks: true, use: { kind: 'dj', sit: false, approach: 'south' } },
    { id: "speaker", label: "SPEAKER", cat: "lounge", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true, stack: true },
    { id: "bar", label: "BAR", cat: "lounge", tier: "cosmetic", w: 4, h: 1, animated: true, blocks: true, use: { kind: 'bar', sit: false, approach: 'south' } },
    { id: "tv", label: "TV", cat: "lounge", tier: "cosmetic", w: 3, h: 1, animated: true, blocks: true, use: { kind: 'tv', sit: false, approach: 'south' } },
    // SEAT LAW (2026-08-04): `sit: true` is reserved for props a body can credibly be ON — its own
    // workstation chair and the single-tile seats (STOOL/CHAIR). A couch/bed/beanbag is a place a body
    // walks to and STANDS at: the sit sprite is a chair pose, and pasting it on a mattress or a cushion
    // read as a body parked upright on the furniture. Changing `sit` here is the whole switch.
    { id: "couch", label: "COUCH", cat: "lounge", tier: "cosmetic", w: 5, h: 1, animated: true, blocks: true, use: { kind: 'couch', sit: false, approach: 'south' } },
    { id: "arcade", label: "ARCADE", cat: "lounge", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true, use: { kind: 'arcade', sit: false, approach: 'south' } },
    { id: "arcade2", label: "ARCADE II", cat: "lounge", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true, use: { kind: 'arcade', sit: false, approach: 'south' } },
    { id: "jukebox", label: "JUKEBOX", cat: "lounge", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true, use: { kind: 'juke', sit: false, approach: 'south' } },
    // BED — the sleep target: world.js planBedSleep walks a dormant agent here and powers it down
    // BESIDE the mattress. `sit: false` per the SEAT LAW above (a bed is not a chair).
    { id: "bunk", label: "BED", cat: "lounge", tier: "cosmetic", w: 2, h: 2, animated: true, blocks: true, use: { kind: 'bed', sit: false, approach: 'south' } },
    { id: "quarters_pooltable", label: "POOL TABLE", cat: "lounge", tier: "cosmetic", w: 4, h: 2, animated: true, blocks: true, use: { kind: 'pool', sit: false, approach: 'south' } },
    { id: "quarters_vending", label: "VENDING", cat: "lounge", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true, use: { kind: 'vend', sit: false, approach: 'south' } },
    { id: "quarters_lockerbank", label: "LOCKERS", cat: "lounge", tier: "cosmetic", w: 3, h: 1, animated: true, blocks: true, use: { kind: 'locker', sit: false, approach: 'south' } },
    { id: "quarters_minifridge", label: "MINIFRIDGE", cat: "lounge", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true, use: { kind: 'fridge', sit: false, approach: 'auto' } },
    // DECOR — small dressing & plain seating.
    { id: "coffee", label: "COFFEE", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false, stack: true, use: { kind: 'coffee', sit: false, approach: 'auto' } },
    { id: "plant", label: "PLANT", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false, stack: true },
    // `flat: true` = a FLOOR DECAL: deck paint with zero rise. Two consequences, both in one flag —
    // it never blocks a placement (props stand ON it, and it unrolls UNDER props already there, see
    // worldmodel checkProp) and it renders in the floor pass BENEATH every body and prop (world.js),
    // so an agent crossing a rug walks on top of it instead of vanishing behind it.
    { id: "rug", label: "RUG", cat: "decor", tier: "cosmetic", w: 4, h: 3, animated: true, blocks: false, flat: true },
    // three rugs, three looms: the 4x3 oxblood pile above, a 3x3 tobacco flatweave mat, and a 5x5 plum
    // pile with a bound selvedge. Sharing a hue OR a grain between two of them would make the pair read
    // as one prop stretched, which is the whole reason each carries its own weave (see the art notes).
    { id: "rug_small", label: "SMALL RUG", cat: "decor", tier: "cosmetic", w: 3, h: 3, animated: true, blocks: false, flat: true },
    { id: "rug_large", label: "LARGE RUG", cat: "decor", tier: "cosmetic", w: 5, h: 5, animated: true, blocks: false, flat: true },
    { id: "treasury_pnl_holo", label: "PNL HOLO", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "arc_floorlight", label: "FLOOR LIGHT", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "arc_ladder", label: "LADDER", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    // THE ONLY SITTABLE FURNITURE (SEAT LAW, see the couch row): a single-tile seat. world.js planSeat
    // claims it, walks the body to an adjacent tile, then RENDERS the body on the seat's own tile — the
    // one case where a sit pose is true, because there is a seat underneath it.
    { id: "stool", label: "STOOL", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true, use: { kind: 'seat', sit: true, approach: 'auto' } },
    { id: "chair", label: "CHAIR", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true, use: { kind: 'seat', sit: true, approach: 'auto' } },
    // TABLES (2026-07-26) — the catalog had hero surfaces and nothing in between, so every small object
    // had to be parked on the deck. `surface: true` is what a mount:"surface" / stack:true prop may be
    // placed ON. See the MOUNT AXIS note above the catalog for what those two flags mean.
    { id: "sidetable", label: "SIDE TABLE", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: false, blocks: true, surface: true },
    /* THE LOW TABLE + THE DINER SET (2026-08-17). All three are `surface: true` tables or a seat —
       nothing here moves the shared top plane, so a mug placed on any of them still lands. */
    { id: "lowtable", label: "LOW TABLE", cat: "decor", tier: "cosmetic", w: 3, h: 1, animated: false, blocks: true, surface: true },
    { id: "glasstable", label: "GLASS TABLE", cat: "decor", tier: "cosmetic", w: 3, h: 1, animated: false, blocks: true, surface: true },
    /* ⛔ THE DINER TABLE IS 3x2 AND THEREFORE NOT `surface: true`. A mounted prop is lifted by ONE
       constant off its OWN footprint bottom, so on a table two tiles deep anything placed on the far
       row would hang ~12px above the plane it is supposed to sit on. Every mount host in this catalog
       is one tile deep and prop-mount.test.js holds that line. It still TURNS — its footprint is its
       top plan — which is what PLAN_FOOTPRINT is for. Its setting (caddy, ketchup, mugs) is drawn in,
       so it reads as a laid table rather than an empty one you are forbidden to use. */
    { id: "dinertable", label: "DINER TABLE", cat: "decor", tier: "cosmetic", w: 3, h: 2, animated: false, blocks: true },
    { id: "guitar", label: "GUITAR", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: false, blocks: true },
    { id: "booth", label: "BOOTH", cat: "decor", tier: "cosmetic", w: 2, h: 1, animated: false, blocks: true, use: { kind: 'couch', sit: false, approach: 'south' } },
    { id: "dinerchair", label: "DINER CHAIR", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: false, blocks: true, use: { kind: 'seat', sit: true, approach: 'auto' } },
    { id: "podchair", label: "POD CHAIR", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: false, blocks: true, use: { kind: 'seat', sit: true, approach: 'auto' } },
    { id: "loungetable", label: "LOUNGE TABLE", cat: "decor", tier: "cosmetic", w: 2, h: 1, animated: false, blocks: true, surface: true },
    { id: "longtable", label: "LONG TABLE", cat: "decor", tier: "cosmetic", w: 3, h: 1, animated: false, blocks: true, surface: true },
    // DECOR EXPANSION (2026-07-15) — theming set. Flat paint/looms walk-over; solid bodies block.
    { id: "lavalamp", label: "LAVA LAMP", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false, mount: "surface" },
    { id: "crt_pile", label: "CRT PILE", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true, stack: true },
    { id: "cablerun", label: "CABLE RUN", cat: "decor", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: false, flat: true },
    { id: "hazardpad", label: "HAZARD PAD", cat: "decor", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: false, flat: true },
    { id: "tallplant", label: "TALL PLANT", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true },
    { id: "terrarium", label: "TERRARIUM", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true, use: { kind: 'terra', sit: false, approach: 'auto' } },
    // DECOR EXPANSION wave 2 (2026-07-15, recurated) — fun/glow set. Flat holo/paint walk-over; cabinets block.
    { id: "holopet", label: "HOLO PET", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false, use: { kind: 'pet', sit: false, approach: 'auto' } },
    { id: "plasmaglobe", label: "PLASMA GLOBE", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false, mount: "surface" },
    { id: "gachapon", label: "GACHAPON", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true, use: { kind: 'gacha', sit: false, approach: 'auto' } },
    // DECOR EXPANSION wave 3 (2026-07-15) — greenery + lounge picks.
    { id: "monstera", label: "MONSTERA", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    // TABLETOP SET (2026-07-29) — small objects for the three tables. All stack:true (a table OR the
    // deck), all h:1 and w<=3 so they fit a real table, all walkable: a mug is not an obstacle.
    { id: "mug", label: "MUG", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false, stack: true },
    { id: "bookstack", label: "BOOKS", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: false, blocks: false, stack: true },
    { id: "desklamp", label: "DESK LAMP", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false, stack: true },
    { id: "radio", label: "RADIO", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false, stack: true },
    { id: "toolbox", label: "TOOLBOX", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: false, blocks: false, stack: true },
    { id: "figurine", label: "FIGURINE", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false, stack: true },
    { id: "deskterminal", label: "TERMINAL", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false, stack: true },
    { id: "modelship", label: "MODEL SHIP", cat: "decor", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: false, stack: true },
    { id: "steamvent", label: "STEAM VENT", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "fishtank", label: "FISH TANK", cat: "lounge", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true, use: { kind: 'fish', sit: false, approach: 'south' } },
    { id: "pokertable", label: "POKER TABLE", cat: "lounge", tier: "cosmetic", w: 4, h: 2, animated: true, blocks: true, use: { kind: 'poker', sit: false, approach: 'south' } },
    // FREESTANDING LOUNGE SET (2026-07-29) — floor pieces that are DESTINATIONS, not scenery.
    { id: "bookshelf", label: "BOOKSHELF", cat: "lounge", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true, use: { kind: 'bookshelf', sit: false, approach: 'south' } },
    { id: "beanbag", label: "BEANBAG", cat: "lounge", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true, use: { kind: 'beanbag', sit: false, approach: 'auto' } },
    { id: "pinball", label: "PINBALL", cat: "lounge", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true, use: { kind: 'pinball', sit: false, approach: 'south' } },
    /* THE COLD LAB (2026-08-17) — decor built on the claw-machine recipe: a window with CONTENTS in
       it. One holds something still, the other something growing. */
    { id: "cryopod", label: "CRYO POD", cat: "decor", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "incubator", label: "INCUBATOR", cat: "decor", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    /* THE AIMED SET (2026-08-17) — props whose identity is that they POINT somewhere. Each ships as
       a LEFT and a RIGHT entry; the right one is the left one mirrored at draw time. */
    { id: "telescope", label: "TELESCOPE ›", cat: "decor", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "telescope_r", label: "TELESCOPE ‹", cat: "decor", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "camerarig", label: "CAMERA RIG ‹", cat: "decor", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "camerarig_r", label: "CAMERA RIG ›", cat: "decor", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "weaponrack", label: "WEAPON RACK ‹", cat: "decor", tier: "cosmetic", w: 3, h: 1, animated: true, blocks: false, mount: 'wall' },
    { id: "weaponrack_r", label: "WEAPON RACK ›", cat: "decor", tier: "cosmetic", w: 3, h: 1, animated: true, blocks: false, mount: 'wall' },
    { id: "punchbag", label: "HEAVY BAG ‹", cat: "decor", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true, use: { kind: 'bag', sit: false, approach: 'south' } },
    { id: "punchbag_r", label: "HEAVY BAG ›", cat: "decor", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true, use: { kind: 'bag', sit: false, approach: 'south' } },
    { id: "benchpress", label: "BENCH PRESS ‹", cat: "decor", tier: "cosmetic", w: 3, h: 1, animated: false, blocks: true, use: { kind: 'bench', sit: false, approach: 'south' } },
    { id: "benchpress_r", label: "BENCH PRESS ›", cat: "decor", tier: "cosmetic", w: 3, h: 1, animated: false, blocks: true, use: { kind: 'bench', sit: false, approach: 'south' } },
    /* THE RECLINER PAIR (2026-08-17) — one seat of the couch, shipped as two props so aiming it is a
       pick rather than a hidden gesture. The right-facing one is the left one MIRRORED at draw time,
    /* THE COLOUR SHELF (2026-08-17) — floor-sized props that each own a saturated hue, because a
       room furnished from a grey catalog cannot be made to look good by lighting alone. */
    /* THE RECLINER PAIR — one seat of the couch, shipped as two props so aiming it is a pick
       rather than a hidden gesture. The right-facing one is the left one MIRRORED at draw time,
       so the two can never drift apart. */
    /* A body DOES sit in these — but `sit` stays false, because that flag means one narrow thing: "the
       GENERIC prop path (PropAnchor.deriveAnchor) may put a sit pose here", and that is the path the
       SEAT LAW above closed on sofas and beds. A profile seat never reaches it. Its sit is owned by
       planCouchSit + world.js SIDE_SEAT, which supply a real cushion anchor and a real occlusion order. */
    { id: "recliner", label: "RECLINER ‹ LEFT", cat: "lounge", tier: "cosmetic", w: 1, h: 1, animated: false, blocks: true, use: { kind: 'couch', sit: false, approach: 'west' } },
    { id: "recliner_r", label: "RECLINER RIGHT ›", cat: "lounge", tier: "cosmetic", w: 1, h: 1, animated: false, blocks: true, use: { kind: 'couch', sit: false, approach: 'east' } },
  ];
  const BY_ID = {};
  for (const c of CATALOG) BY_ID[c.id] = c;
  const CATS = CATALOG.reduce((o, c) => { (o[c.cat] = o[c.cat] || []).push(c); return o; }, {});

  /* STARTER — the shelf of essentials pinned above the ⚙ SYSTEMS drawers (build.js renders it).
     ~30 functional entries encode only a handful of POWERS, and a beginner who skipped the tutorial
     has no way to know which matter. This is that answer: THE SAME props the tutorial kit
     requisitions (tutorial.js KIT_SPEC — files, web, terminal, memory) plus STUDIO (media — the
     power users miss). Andrew's scope call 2026-08-18: capability grants ONLY — no BAY (that is
     conveyor equipment, not a necessity) and no workstation. The shelf stays for EVERY station
     until each power is placed, then retires; a placed prop granting the same power satisfies its
     tile (a VAULT counts for the INTEL CAB slot — the shelf tracks powers, not skins). Ids, not
     labels: the palette resolves each through BY_ID so a renamed prop can never strand the shelf. */
  const STARTER = ['war_intelcab', 'comms_dish', 'workbench', 'gigs_servercart', 'studio'];

  /* The display names for the two TIERS and every CATEGORY. These live HERE, with the catalog they
     describe, because more than one consumer needs them: build.js paints them on the palette tabs and
     propsearch.js matches against them (typing "systems" or "workstations" must find what the tab says).
     They used to be private to build.js and hand-copied into the test, which is a drift waiting to
     happen — a renamed tab would leave the test asserting a label no user can see. One map, one truth.
     A category with no entry is not an error: callers fall back to the id, uppercased. */
  const TIER_LABEL = { functional: '⚙ SYSTEMS', cosmetic: '✦ DECOR' };
  const CAT_LABEL = {
    workstation: 'WORKSTATIONS', workflow: 'WORKFLOW', capability: 'CAPABILITY', isolation: 'ISOLATION',
    command: 'COMMAND',   // G1b: mission surfaces — functional-but-not-capability (MISSION BOARD)
    screens: 'SCREENS', lab: 'LAB', storage: 'STORAGE', comms: 'COMMS', lounge: 'LOUNGE', decor: 'DECOR',
  };

  const spec = id => BY_ID[id] || null;
  const has = id => !!F[id];

  /* ---- ORIENTATION eligibility + AUTHORED TURNED VIEWS ---------------------------------------
     A prop that is not a floor decal turns ONLY where a view was drawn for that facing. Views live
     in the same F table under a `:` suffix, which no catalog id can collide with:

       F['chair']       r=0  SOUTH — faces the room. Every prop has this one.
       F['chair:w']     r=1  WEST  — turned left  (its front points to the left of the screen)
       F['chair:n']     r=2  NORTH — a genuine back view
       F['chair:e']     r=3  EAST  — turned right

     A WEST view is derived from the authored EAST one by mirroring unless drawn by hand: for a true
     side view that is exactly right — a chair facing left really is a chair facing right, reflected
     — and px()'s LSWAP re-lights it so the key stays west. Props the mirror cannot reach (raw path
     ops, lettering) must have both sides drawn, or they stay south-only.

     r=2 (a BACK view) is rarely worth authoring: it is a picture nobody deliberately places — you
     do not turn a cabinet to face away from the room. It is authored where the object genuinely
     reads from behind (a chair pushed under a desk, a seat with a body in it).

     facings() reads the F table directly, so this cannot drift: adding F['bench:e'] gives the bench
     that facing and the R key picks it up with no list to update. */
  const viewKey = (id, suffix) => id + ':' + suffix;
  const hasView = (id, suffix) => !!F[viewKey(id, suffix)];

  /* DECAL TURN — props that are pure FLOOR PAINT: no object silhouette at all, so turning the
     footprint IS the correct picture and no view needs authoring. `flat: true` on the catalog row
     already marks exactly these (rug / cablerun / hazardpad), and prop-flat-decal.test.js keeps that
     flag honest, so the eligibility is READ from the catalog rather than kept as a second list that
     could drift. Junctions (filter/merger/splitter) also draw flat, and are deliberately NOT here:
     their art encodes belt-lane DIRECTION, which is real routing config edited elsewhere — turning
     the picture without turning the routes would make the sprite lie about where boxes go. */
  const isDecal = id => { const s = spec(id); return !!(s && s.flat); };

  /* ROTATION IS FOR DECOR ONLY. A `tier:'functional'` prop is the projection of a REAL capability —
     an agent walks to it, sits at it, and it grants tools — so its orientation is load-bearing
     rather than decorative, and the approach/seat/routing seams all key off its front.
     `tier:'cosmetic'` props are furnishing, so those are the ones people get to aim however they
     like. Stated here because this is the one place that decides what a facing may draw: a turned
     view added to a functional prop by a later edit is inert, not a silent behaviour change. */
  const rotatable = id => { const s = spec(id); return !!s && s.tier !== 'functional'; };

  /* which fn draws prop `id` at facing `r`, whether it must be mirrored to get there, and whether it
     is the south art under a footprint TURN. Returns null when that facing has no honest picture —
     callers fall back to south rather than painting a lie. */
  function viewAt(id, r) {
    r &= 3;
    if (!has(id)) return null;
    if (!r) return { fn: F[id], mirror: 0, turned: 0 };
    if (!rotatable(id)) return null;
    if (isDecal(id)) return { fn: F[id], mirror: 0, turned: 1 };          // decal: transform the south art
    if (r === 2) return hasView(id, 'n') ? { fn: F[viewKey(id, 'n')], mirror: 0, turned: 0 } : null;
    // the two side facings are each other's mirror, so ONE authored profile serves both — whichever
    // side was drawn wins outright, and the other is that fn flipped (px()'s LSWAP re-lights it).
    const near = r === 3 ? 'e' : 'w', far = r === 3 ? 'w' : 'e';
    if (hasView(id, near)) return { fn: F[viewKey(id, near)], mirror: 0, turned: 0 };
    if (SYM_SET[id]) return null;                                          // its two sides are one picture — offer ONE
    return (hasView(id, far) && !NOMIR_SET[id]) ? { fn: F[viewKey(id, far)], mirror: 1, turned: 0 } : null;
  }
  /* SIDE_SYMMETRIC — props whose east and west views are the SAME picture, so only the east facing is
     offered. A table has no front: turned either way it is the same board, and offering both would
     put a step in the R cycle that changes nothing — which is the same lie as a facing that draws
     nothing. (A chair is not here: its two profiles genuinely face opposite ways.) */
  const SIDE_SYMMETRIC = ['loungetable', 'longtable', 'lowtable', 'glasstable', 'dinertable'];
  const SYM_SET = SIDE_SYMMETRIC.reduce((o, id) => (o[id] = 1, o), {});

  /* NO_MIRROR — props that must NOT be flipped, and why:
       text  — mirrored lettering is unreadable.
       path  — draws through raw ctx path ops / gradients, whose fillStyle px() never sees, so the
               light correction cannot reach it. Authorable later; not claimable now.
       flow  — logistics machinery whose art reads as a DIRECTION of travel (dock mouths, lane
               arrows). Same truth rule as the junctions above. */
  const NO_MIRROR = [
    'missionboard', 'trophycase', 'calwall', 'ticker',                                   // text
    'comms_dish', 'safe', 'vault', 'studio', 'bigscreen', 'holotable', 'chartwall',      // path
    'wartable', 'bridge_tacscreen', 'bridge_orderqueue', 'war_threatcore', 'vat',
    'research_corelens', 'research_trendpillar', 'etsy_dyevat', 'etsy_kiln',
    'gigs_thumbwall', 'gigs_amp', 'pub_outboundchute', 'treasury_pnl_holo',
    'intake', 'bay', 'outbox', 'filter', 'merger', 'splitter', 'joiner', 'loop', 'beltH', // flow
  ];
  const NOMIR_SET = NO_MIRROR.reduce((o, id) => (o[id] = 1, o), {});

  /* the honest facing set for a prop. The builder offers exactly these — never an R key that
     produces broken art — and R cycles through them in order rather than blindly adding 1. */
  function facings(id) {
    const out = [];
    for (let r = 0; r < 4; r++) if (viewAt(id, r)) out.push(r);
    return out.length ? out : [0];
  }
  const canRotate = id => facings(id).length > 1;
  const canMirror = id => !!has(id) && !NOMIR_SET[id];
  /* the next facing in a prop's OWN cycle — R and shift+R walk this, so a prop with only south+east
     skips straight between them instead of stopping on facings it cannot draw. */
  function nextFacing(id, r, dir) {
    const fs = facings(id);
    const i = fs.indexOf((r | 0) & 3);
    const step = (dir | 0) < 0 ? -1 : 1;
    return fs[((i < 0 ? 0 : i) + step + fs.length) % fs.length];
  }

  /* A TURN NEVER RESIZES AN UPRIGHT PROP. Two kinds of prop genuinely re-tile, and the difference is
     whether the footprint IS the object's plan:
       DECAL  — a 4x3 rug turned really is 3x4.
       PLAN   — a table's footprint is its TOP SURFACE seen from above, so a 3x1 long table turned
                really is a 1x3 one, and things stand on it accordingly (`surface: true` marks
                exactly these, and the deep view is authored for the swapped box).
     Everything else keeps its box. Getting that wrong shipped a visible defect in the earlier
     rotation lane: `arcade` is authored 1x2, that 2 was read as DEPTH, and a quarter turn made the
     cabinet twice as wide as itself — Andrew: "it literally changes the entire height and size of
     the machine and it makes no sense." The 2 is vertical drawing room for a tall object. */
  /* PLAN_FOOTPRINT — props whose box is the object's PLAN, so turning it really does swap the tiles:
     a 5x1 sofa turned is a 1x5 sofa running along a wall. Decals and tables qualify by their catalog
     flags (`flat` / `surface`); soft furniture has no such flag and is listed here. Everything else
     keeps its box — the arcade's second tile is HEIGHT, not depth. */
  const PLAN_FOOTPRINT = ['dinertable', 'booth'];
  const PLAN_SET = PLAN_FOOTPRINT.reduce((o, id) => (o[id] = 1, o), {});
  const reTiles = id => isDecal(id) || !!PLAN_SET[id] || !!(spec(id) || {}).surface;
  function footprintAt(id, r) {
    const s = spec(id); if (!s) return null;
    // the swap is gated on an HONEST view at that facing: a prop that falls back to its south art
    // must keep its south box too, or the ghost would reserve tiles the picture never fills.
    return ((r & 1) && reTiles(id) && viewAt(id, r)) ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
  }

  /* ---- live connector state (drives the connector_portal sprite). The world layer owns the data — it polls
     /api/connectors for each bound server's state and calls a tool-call pulse when an mcp__ tool fires — and
     pushes it here, so the prop draw stays a pure function of (geometry + this map). Keyed by connectorId. */
  const connState = {};          // connectorId -> { state, toolCount, firedAt }
  const PULSE_MS = 900;          // a firing packet decays 1 -> 0 over this window
  function setConnectorState(id, state, toolCount) {
    if (!id) return; const s = connState[id] || (connState[id] = {});
    s.state = state || 'offline'; if (toolCount != null) s.toolCount = toolCount;
  }
  function pulseConnector(id) { if (!id) return; (connState[id] || (connState[id] = {})).firedAt = now; }
  function connectorFired(id) { const s = id && connState[id]; return (s && s.firedAt) ? Math.max(0, 1 - (now - s.firedAt) / PULSE_MS) : 0; }
  /* reconcile against a SUCCESSFUL /api/connectors poll: any tracked connector ABSENT from the live list was
     removed/unbound server-side, so DROP it — else its portal would keep glowing green off a stale last-known
     state until reload. Called ONLY on a good poll; a FAILED poll never clears (keep-last-known, E4/E6f). */
  function reconcileConnectors(liveIds) {
    const keep = new Set(liveIds || []);
    for (const id of Object.keys(connState)) if (!keep.has(id)) delete connState[id];
  }

  /* live WORKBENCH pulse (drives the workbench sprite). The world layer calls pulseWorkbench(ok) when a
     shell.exec / verify.result fires (ok=false => a verify FAILED, the bench flashes red). One global pulse —
     every placed workbench glows, signalling "the agent is running code right now." */
  // ROOM-SCOPED (T1 finding): a shell/verify pulse must glow only the ACTING agent's OWN workbench, not every
  // placed bench on the floor. The world layer resolves the target instance (capPropFor('workbench', agentId))
  // and passes its propId; keyed by propId so two agents' benches pulse independently. pulseWorkbench(ok) with
  // no id falls back to a GLOBAL pulse (back-compat: a single-bench floor / a caller that can't resolve a room).
  let wbFiredAt = 0, wbBad = false;                 // global fallback (no propId)
  const wbInst = {};                                // propId -> { at, bad } per-instance pulse
  function pulseWorkbench(ok, id) {
    if (id) { wbInst[id] = { at: now, bad: ok === false }; return; }
    wbFiredAt = now; wbBad = (ok === false);
  }
  // this workbench's pulse: its OWN instance pulse if it has one, else the global fallback (never both — an
  // instance that ever pulsed owns its glow and ignores the global, so a scoped pulse can't leak floor-wide).
  function workbenchFiredFor(id) {
    if (id && wbInst[id]) return { fired: Math.max(0, 1 - (now - wbInst[id].at) / PULSE_MS), bad: wbInst[id].bad };
    return { fired: wbFiredAt ? Math.max(0, 1 - (now - wbFiredAt) / PULSE_MS) : 0, bad: wbBad };
  }

  /* live JUKEBOX state (drives the jukebox sprite's dead-vs-live glow). Object=capability law: a placed
     jukebox grants the Spotify tools, but they're INERT until the user connects Spotify in TOOLSETS — so
     the sprite must read DEAD (dark, no bubble chase / no spinning disc / no lamps) when unconnected and
     only come alive (animated + gold floor glow) once /api/spotify/status reports connected:true. The
     world layer polls that endpoint and pushes the boolean here; the draw stays a pure function of it. */
  let jukeConnected = false;
  function setSpotifyConnected(on) { jukeConnected = !!on; }

  /* live CAPABILITY-PROP pulse (G0.1) — per placed INSTANCE, the connector/workbench idiom generalized:
     the world layer maps a firing tool to the prop that GRANTS it (fs->cabinet · web/browser->dish ·
     notebook/skill/recall/todo->notebook · image->studio · spotify->jukebox, via toolprops.js) and calls
     pulseProp(propId, capType); draw() overlays a bright surge in that capability's accent that decays
     1 -> 0 over PULSE_MS. Colors ride the station's semantic economy (amber=files, cyan=web/data,
     green=memory, magenta=media, gold=audio). */
  const CAP_GLOW = { cabinet: '#e8c860', dish: '#4ad9ff', notebook: '#41ff8a', studio: '#ff6ad5', jukebox: '#ffd34a' };
  const PROP_FAIL = '#ff5c5c';   // a DENIED/FAILED tool call — the workbench verify-red cue, generalized
  const propPulse = {};          // propId -> { at, cap, bad }
  // ok defaults true (the success surge). ok===false => a distinct RED failure cue (denied/errored tool call) —
  // TRUTH: a call that the gate denied or that errored never did the work, so it must NOT read as the green surge.
  function pulseProp(id, cap, ok) { if (!id) return; propPulse[id] = { at: now, cap: cap || '', bad: ok === false }; }

  // G2.3 — uncollected while-away work: the world layer feeds the ReturnStore's pending-crate count
  // here each frame; the OUTBOX sprite stacks that many banked-product crates (cap 5 + counter).
  let outboxCrates = 0;
  function setOutboxCrates(n) { outboxCrates = Math.max(0, n | 0); }

  // G1b — the MISSION BOARD's live readout: `pins` = how many quests are OPEN in the (visible) quest log,
  // `hot` = a station-gap fix-it quest is currently open (the board breathes gold). The world layer feeds
  // both from the real quest projection (throttled ~1s) — the sprite stays a pure function of its inputs.
  let missionPins = 0, missionHot = false, missionJam = false, missionProposals = 0;
  // G4 feature 2: `proposals` (4th arg) = pending autojob PROPOSAL cards the agent pinned to the board (a distinct
  // amber stub vs the quest pins + the jam stub). Optional so existing 3-arg callers are unaffected.
  function setMissionPins(open, hot, jam, proposals) { missionPins = Math.max(0, open | 0); missionHot = !!hot; missionJam = !!jam; missionProposals = Math.max(0, proposals | 0); }
  // G3b — the TROPHY CASE's live readout: how many trophies are EARNED (real completed quests + milestones).
  // The world layer feeds it from the trophy projection (throttled ~1s); the sprite stays a pure function.
  let trophyCount = 0;
  function setTrophyCount(n) { trophyCount = Math.max(0, n | 0); }
  // Journey evolution is a second, non-gating truth on the case. The uncapped stage is the distinct-goal count;
  // the crown renders later goals as deeper light waves once its four physical beacon cells are filled.
  let journeyStage = 0;
  function setJourneyStage(n) { journeyStage = Math.max(0, n | 0); }
  function propFired(id) { const s = id && propPulse[id]; return (s && s.at) ? Math.max(0, 1 - (now - s.at) / PULSE_MS) : 0; }

  /* draw one prop. f = {t, x, y, w, h} in LOCAL tile coords; `work` lights its screens.
     `live` (G0.2/G0.3, optional) carries the seated agent's TRUTHFUL activity: { heat, prog } — heat
     is real token/tool flow (0..1, ~2s decay, world.js heatFor); prog is a real published task
     fraction or null (live harness runs have none). Only ever passed for a lit assigned workstation. */
  /* THE OVERLAY PASS (2026-08-10). A prop whose art has to be split around a BODY registers here: draw()
     paints everything under the body, drawOver() paints what covers it. Exactly one prop needs it today —
     the BED, whose quilt has to lie over a sleeping agent while the pillow stays under its head — and the
     map is deliberately keyed by type so a prop with no entry costs the world layer one lookup and no
     behavior change. The world layer decides WHEN (world.js, the y-sorted item list). */
  const OVER = {
    bunk: (X, Y, W, H, o) => bunkQuilt(X, Y, W, H, true, o.now),
  };
  function hasOver(t) { return !!OVER[t]; }
  function drawOver(f) {
    const fn = OVER[f && f.t]; if (!fn) return;
    const lift = f.mount === 'surface' ? SURFACE_RISE : 0;
    fn(f.x * TILE, f.y * TILE - lift, (f.w || 1) * TILE, (f.h || 1) * TILE, { x: f.x, now });
  }
  /* SEAT-FRONT OVERLAY (stool-sit lane): ONLY the front rim of a single-tile seat's pad, redrawn by the
     world layer just IN FRONT of the body sitting on it, so the sitter's lap tucks INTO the pad instead
     of floating over it — the couch's sort-in-front trick at single-seat scale. The rows repainted here
     are byte-for-byte the same rows F.stool / F.chair already drew (sorted just BEHIND the sitter); a
     divergent copy would ghost a second seat when the body wanders mid-frame. Keep them in lockstep. */
  function drawSeatFront(f) {
    const lift = f.mount === 'surface' ? SURFACE_RISE : 0;
    const x = f.x * TILE, y = f.y * TILE - lift;
    const r = RAMP.steel;
    if (f.t === 'stool') {
      px(x + 2, y + 3, 8, 1, '#2f6a62');                          // pad south face (lower body row)
      px(x + 2, y + 3, 1, 1, '#4a8a82'); px(x + 9, y + 3, 1, 1, '#26554e');
      px(x + 3, y + 3, 1, 1, '#26554e'); px(x + 8, y + 3, 1, 1, '#26554e');   // piping stitches
      px(x + 3, y + 4, 6, 1, r.dk);                               // rounded underside rim
      px(x + 4, y + 5, 4, 1, shade(r.dk, -0.30));               // seat AO onto the stem
    } else if (f.t === 'chair') {
      px(x + 2, y + 6, 8, 1, '#2f6a62');                          // pad south row
      px(x + 3, y + 6, 1, 1, '#26554e'); px(x + 8, y + 6, 1, 1, '#26554e');   // seat stitches
      px(x + 2, y + 7, 8, 1, r.face); px(x + 2, y + 7, 3, 1, r.lit);          // front lip
      px(x + 3, y + 8, 6, 1, r.dk);                               // rounded skirt
    } else if (F[f.t] && RECLINER_FRONT_Y[f.t] != null) {
      /* A PROFILE SEAT covers its sitter with the whole near arm, not a pad rim: at this scale that arm
         IS what a person's shins disappear behind (the stool's 2-row sliver would leave the legs
         hanging in front of the chair). Rather than copy those rows — the drift the lockstep note above
         warns about — CLIP the seat's own drawing function to the band at and below its seat line and
         run it again. Same code, so the overlay can never disagree with the base about what the chair
         looks like, and a future edit to F.recliner is carried automatically.
         Known and accepted cost: the arm-crown keyEdge is a 0.28-alpha 6x1px line, so on an OCCUPIED
         seat it lands twice and reads a shade brighter. The unoccupied art is untouched. */
      const w = (f.w || 1) * TILE, h = (f.h || 1) * TILE;
      ctx.save();
      ctx.beginPath(); ctx.rect(x - TILE, y + RECLINER_FRONT_Y[f.t], w + 2 * TILE, h + TILE); ctx.clip();
      try { F[f.t](x, y, w, h, f); } finally { ctx.restore(); }
    }
  }

  function draw(f, work, live) {
    const fn = F[f.t]; if (!fn) return;
    // MOUNT LIFT. A surface-standing prop is the SAME art as a floor prop, drawn higher: every prop
    // function anchors its contact to its own footprint bottom, so lifting the origin lifts the whole
    // thing and keeps every internal offset valid. This is deliberately the only place the lift is
    // applied — a prop function must never bake its own mount height.
    const lift = f.mount === 'surface' ? SURFACE_RISE : 0;
    const X = f.x * TILE, Y = f.y * TILE - lift, W = (f.w || 1) * TILE, H = (f.h || 1) * TILE;
    const o = { x: f.x, work: !!work, agentId: f.agentId || null, dockName: f.dockName || null, door: f.door || null };
    if (live) { o.heat = +live.heat || 0; o.prog = (live.prog == null) ? null : Math.max(0, Math.min(1, +live.prog || 0)); }
    if (f.t === 'connector_portal') {                 // a bound portal rides its connector's live state
      const cid = f.connectorId || null;
      o.bound = !!cid;
      o.state = cid ? ((connState[cid] && connState[cid].state) || 'offline') : 'unbound';
      o.fired = connectorFired(cid);
    }
    if (f.t === 'workbench') { const wf = workbenchFiredFor(f.id); o.fired = wf.fired; o.bad = wf.bad; }   // shell/verify pulse (room-scoped by propId)
    if (f.t === 'bunk') o.sleeper = !!f.sleeper;      // a dormant body is IN it → hold the quilt back for drawOver
    if (f.t === 'jukebox') o.live = jukeConnected;   // dead until Spotify is connected in TOOLSETS (object=capability truth)
    if (f.t === 'outbox') o.crates = outboxCrates;   // G2.3: uncollected while-away runs stack as crates
    if (f.t === 'missionboard') { o.pins = missionPins; o.hot = missionHot; o.jam = missionJam; o.proposals = missionProposals; }   // G1b/G1c: open quests pinned + the station-gap beacon + the routine-JAM amber stub; G4: pending autojob PROPOSAL cards
    if (f.t === 'trophycase') { o.trophies = trophyCount; o.journeyStage = journeyStage; }   // earned trophies + distinct reached-goal crown beacons
    /* ORIENTATION. `r` = quarter turns clockwise (0 = south, the shipped facing), `m` = mirrored.
       Both are re-checked against what this prop's art can HONESTLY do rather than trusted from the
       record: a saved station outlives catalog changes, and a prop that lost its turned view must
       fall back to facing south, never render a lie.
       Two ways a facing gets drawn (viewAt picks): an AUTHORED view, blitted straight into the box
       it was drawn for; or, for a floor DECAL only, the south art under a footprint transform —
       exact 90° turns on integer offsets, so pixel-exact with no resampling or smoothing. */
    const want = (f.r | 0) & 3;
    const view = viewAt(f.t, want) || viewAt(f.t, 0) || { fn: fn, mirror: 0, turned: 0 };
    // the user's flip COMPOSES with the view's own (west = east mirrored): flipping a west-facing
    // prop lands back on the east art, which is correct — two mirrors cancel.
    const mir = (((canMirror(f.t) && f.m) ? 1 : 0) ^ view.mirror) & 1;
    // Only a DECAL gets the footprint transform. An authored view is already drawn for the box it
    // occupies, so it is blitted straight in — turned art must never be turned twice.
    const rot = view.turned ? want : 0;
    if (rot || mir) {
      const BW = (rot & 1) ? H : W, BH = (rot & 1) ? W : H;
      ctx.save();
      // INTEGER affines, not ctx.rotate(): cos/sin of PI/2 carry ~1e-16 error, which would put every
      // painted rect a hair off the pixel grid. transform() with exact 0/±1 keeps a quarter turn a
      // pure pixel remap — (x,y) -> (-y,x) clockwise — so turned art stays as crisp as unturned art.
      if (rot === 1) { ctx.translate(X + W, Y); ctx.transform(0, 1, -1, 0, 0, 0); }
      else if (rot === 2) { ctx.translate(X + W, Y + H); ctx.transform(-1, 0, 0, -1, 0, 0); }
      else if (rot === 3) { ctx.translate(X, Y + H); ctx.transform(0, -1, 1, 0, 0, 0); }
      else ctx.translate(X, Y);
      if (mir) { ctx.translate(BW, 0); ctx.scale(-1, 1); }
      ctx.translate(-X, -Y);                 // the fns draw at absolute coords; rebase onto the box
      MIRROR = !!mir;
      // finally, not a plain call: a throwing prop must never strand MIRROR set (it would re-light
      // every prop drawn after it this frame) or leak an unbalanced ctx state onto the world pass.
      _curId = f.t; inkBegin(f.t);
      try { view.fn(X, Y, BW, BH, o); } finally { MIRROR = false; ctx.restore(); inkEnd(); _curId = null; }
    } else {
      _curId = f.t; inkBegin(f.t);
      try { view.fn(X, Y, W, H, o); } finally { inkEnd(); _curId = null; }
    }
    /* the status overlays below stay in SCREEN space on the EFFECTIVE box: a progress bar or a
       tool-fire charge bar reads left-to-right regardless of which way its prop is turned. */
    // G0.3 ACTIVITY-HEAT WASH: real token/tool flow burns the working screens brighter + shimmers faster
    // (the monitors live in the prop's upper band); a stalled run cools back to the base work-glow in ~2s.
    if (o.work && o.heat > 0) {
      const hshim = 0.72 + 0.28 * Math.sin(now / (170 - 110 * o.heat));
      glow(X + 1, Y - 4, W - 2, Math.min(H + 4, 11), scr(o.x), (0.08 + 0.36 * o.heat) * hshim);
    }
    // G0.2 PROGRESS STRIP: drawn ONLY when a REAL fraction was published (the 'task' contract's
    // prog/dur) — a live harness run has no knowable % and never gets a bar (honesty law).
    if (o.work && o.prog != null) {
      const pw = Math.max(1, Math.round((W - 6) * o.prog));
      px(X + 2, Y - 6, W - 4, 3, '#06090c');            // strip housing above the crown
      px(X + 3, Y - 5, W - 6, 1, '#12251a');            // dark channel
      px(X + 3, Y - 5, pw, 1, '#62ff9e');               // the honest fraction
      glow(X + 3, Y - 6, pw, 3, '#62ff9e', 0.35);
    }
    // G0.1 TOOL-FIRE SURGE: this instance's tool just RESOLVED — a hot core wash + wider halo in the
    // capability accent, plus a charge bar draining shut across the crown. BOLD by design (the CRT-lab
    // law: effects read from across the room), gone in under a second. A DENIED/FAILED call surges RED
    // instead (the workbench verify-red cue) — a call the gate refused never did the work, so it must
    // never read as the green success surge (truthful-telemetry law).
    const pf = propFired(f.id);
    if (pf > 0) {
      const ps = propPulse[f.id];
      const acc = (ps && ps.bad) ? PROP_FAIL : (CAP_GLOW[(ps && ps.cap) || ''] || '#c7ffe0');
      glow(X - 1, Y - 3, W + 2, H + 4, acc, 0.10 + 0.32 * pf);               // outer halo
      glow(X + 1, Y - 1, Math.max(2, W - 2), Math.max(2, H - 2), acc, 0.28 * pf);   // hot core
      px(X, Y - 3, Math.max(1, Math.round(W * pf)), 1, acc);                 // draining charge bar
    }
  }

  /* ======================= CAST SHADOWS + EMISSIVE LIGHT (world overhaul, 2026-09-03) =======================
     Two things every prop in a shipped pixel-art game has and ours had neither of:

     1. A CAST SHADOW ON THE DECK. `shadow2` is a contact line — the 2px dark seam where the object meets the
        floor. It seats the prop but it does not give it HEIGHT. The station's key light is high and
        north-west (every prop's sheen is west-biased, every top face is north-lit), so a standing object
        throws a soft pool to its SOUTH-EAST. Painted by world.js in ONE pass over the deck (after the floor
        decals, before the y-sorted items), so a shadow lands on rugs and under neighbours and never on top of
        another prop's body. Hard-edged stepped rects, not a blur — the light idiom is dithered steps.
        A table-top object (mount:'surface') casts nothing: its shadow would fall on the table, which the
        table's own art already carries. Floor decals (flat) cast nothing: paint has no height.

     2. EMITTED LIGHT. A lit screen, a plasma core, a kiln, a desk lamp — these are light SOURCES, and until
        now they lit nothing: the lightmap only knows the ceiling fixtures. `lightOf` answers, per prop,
        "what colour, how far, how strong" and world.js paints it as an additive pool over the lightmap each
        frame (drawPropLights), so the floor and anything standing near a source takes its colour. Screens
        flicker; fire and plasma breathe; lamps hold steady. `work` gates a workstation: an idle desk's CRT is
        a dark slab (that is what the art shows), so it emits only while its agent is actually working —
        truthful telemetry, not a mood light. Values are WORLD px (TILE = 12), authored for camera scale 2. */
  const SHADOW_RGB = '8,10,24';                     // a shadow has a colour: cool, the bounce-lit unlit side
  // standing height in shadow REACH px beyond the footprint's south-east edges; footprint h>=2 adds its own
  const SHADOW_TALL = { vault: 4, core: 4, connector_portal: 3, arcade: 3, arcade2: 3, bookshelf: 3, rackV: 3, cryopod: 3,
    telescope: 2, telescope_r: 2, tallplant: 2, quarters_vending: 3, quarters_lockerbank: 3, jukebox: 3, pinball: 2, safe: 3,
    war_intelcab: 3, comms_beacon: 3, bridge_relaystack: 3, incubator: 2, fabricator: 3, vat: 3, etsy_kiln: 3, etsy_dyevat: 2,
    commswall: 3, bigscreen: 3, calwall: 2, chartwall: 2, arc_indexwall: 2, weaponrack: 2, weaponrack_r: 2, shelf: 2, rack: 2,
    war_threatcore: 3, bridge_dispatch_pylon: 3, research_corelens: 3, research_trendpillar: 3, pub_outboundchute: 3,
    punchbag: 2, punchbag_r: 2, camerarig: 2, camerarig_r: 2, treasury_token_furnace: 3, monstera: 1, tv: 2, couch: 1 };
  // Cache only silhouette geometry: work lights and animation never change the shadow.
  // A sheared, vertically compressed silhouette projects the standing sprite onto the deck.
  const shadowMasks = new Map();
  function shadowMask(f) {
    if (typeof document === 'undefined') return null;
    const key=[f.t,f.w||1,f.h||1,f.r||0,f.m||0].join('|');
    if(shadowMasks.has(key)) {
      const cached=shadowMasks.get(key),g=cached.getContext('2d');
      if(g && !(g.isContextLost && g.isContextLost()))return cached;
      shadowMasks.delete(key);
    }
    const cv=document.createElement('canvas'), W=(f.w||1)*TILE,H=(f.h||1)*TILE;
    cv.width=W+32;cv.height=H+56;
    const g=cv.getContext('2d');if(!g)return null;
    const previous=ctx, time=now, previousSilhouette=buildingShadowSilhouette;
    try {
      ctx=g;now=0;buildingShadowSilhouette=true;g.imageSmoothingEnabled=false;
      const shape={t:f.t,x:16/TILE,y:48/TILE,w:f.w||1,h:f.h||1,r:f.r||0,m:f.m||0};
      draw(shape,false,null); // first draw also resolves the own-hue outline cache
      g.clearRect(0,0,cv.width,cv.height);draw(shape,false,null);
      g.globalCompositeOperation='source-in';g.fillStyle='rgb('+SHADOW_RGB+')';g.fillRect(0,0,cv.width,cv.height);
    } finally {ctx=previous;now=time;buildingShadowSilhouette=previousSilhouette;}
    if(shadowMasks.size>=256)shadowMasks.clear();
    if(cv.addEventListener)cv.addEventListener('contextlost',()=>{if(shadowMasks.get(key)===cv)shadowMasks.delete(key);},{once:true});
    shadowMasks.set(key,cv);return cv;
  }

  /* Optional local-light response, painted immediately after the authoritative prop.
     A frozen shadow silhouette is safe only for rigid art. Live piles, quilts and
     moving effects are deliberately absent: they may remove opaque pixels at runtime.
     Screens/lamps inside these rigid casings retain their real per-frame content. */
  const LIGHT_RESPONSE_TYPES = new Set(('desk desk2 console consoleL pixelrig bench crate boxes goldcrate safe vault rack rackV shelf ' +
    'war_intelcab quarters_lockerbank quarters_minifridge bookshelf stool chair couch booth recliner recliner_r ' +
    'sidetable lowtable glasstable dinertable loungetable longtable dinerchair podchair plant bookstack toolbox').split(' '));
  const RESPONSE_LIMIT = 96, RESPONSE_PIXELS = 262144, RESPONSE_SINGLE = 65536;
  const RESPONSE_SHADE = [8,10,18];
  const lightResponses = new Map();
  let responsePixels = 0;
  const responseMetrics = { builds: 0, hits: 0, evictions: 0, failures: 0, draws: 0 };
  const responseClamp = (v,a,b) => Math.max(a,Math.min(b,v));
  function dropResponse(key) {
    const old=lightResponses.get(key);if(!old)return;
    responsePixels-=old.pixels;lightResponses.delete(key);
  }
  function invalidateLightResponse() { lightResponses.clear();responsePixels=0; }
  function lightResponseStats() {
    return Object.assign({},responseMetrics,{entries:lightResponses.size,pixels:responsePixels,bytes:responsePixels*4,maxEntries:RESPONSE_LIMIT,
      maxPixels:RESPONSE_PIXELS,maxBytes:RESPONSE_PIXELS*4,maxSinglePixels:RESPONSE_SINGLE,supportedTypes:LIGHT_RESPONSE_TYPES.size});
  }
  function responseSample(light) {
    if(!light||!Array.isArray(light.color)||light.color.length!==3||!light.color.every(Number.isFinite)||
      !Number.isFinite(light.strength)||light.strength<=0)return null;
    const strength=Math.round(responseClamp(light.strength,0,1)*8)/8;if(!strength)return null;
    const color=light.color.map(v=>Math.min(255,Math.round(responseClamp(v,0,255)/16)*16));
    const dx=Number.isFinite(light.dx)?light.dx:0,dy=Number.isFinite(light.dy)?light.dy:0;
    const direction=Math.hypot(dx,dy)>.001?((Math.round(Math.atan2(dy,dx)/(Math.PI/4))%8)+8)%8:-1;
    const angle=direction*Math.PI/4;
    return{color,strength,direction,dx:direction<0?0:Math.cos(angle),dy:direction<0?0:Math.sin(angle)};
  }
  function responseOverlay(f,light) {
    const mask=shadowMask(f);if(!mask)return null;
    const key=[f.t,f.w||1,f.h||1,f.r||0,f.m||0,light.direction,light.strength,...light.color].join('|');
    let hit=lightResponses.get(key);
    if(hit) {
      const g=hit.cv.getContext('2d');
      if(hit.mask===mask&&g&&!(g.isContextLost&&g.isContextLost())) {
        lightResponses.delete(key);lightResponses.set(key,hit);responseMetrics.hits++;return hit.cv;
      }
      dropResponse(key);
    }
    const w=mask.width,h=mask.height,pixels=w*h;
    if(pixels>RESPONSE_SINGLE)return null;
    const alpha=mask.getContext('2d').getImageData(0,0,w,h).data;
    if(alpha.length!==pixels*4)return null;
    let minX=w,minY=h,maxX=-1,maxY=-1;
    // Ignore the translucent spill already carried by old art. A physical rim
    // belongs to its opaque casing, not to a halo or a contact shadow on the deck.
    const solid=(x,y)=>x>=0&&y>=0&&x<w&&y<h&&alpha[(y*w+x)*4+3]>=250;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(solid(x,y)) {
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    }
    if(maxX<0)return null;
    const cv=document.createElement('canvas');cv.width=w;cv.height=h;
    const g=cv.getContext('2d');if(!g||!g.createImageData||!g.putImageData)return null;
    const image=g.createImageData(w,h),out=image.data;
    const cx=(minX+maxX)/2,cy=(minY+maxY)/2,rx=Math.max(1,(maxX-minX)/2),ry=Math.max(1,(maxY-minY)/2);
    const span=Math.abs(light.dx)+Math.abs(light.dy)||1,sx=Math.round(light.dx),sy=Math.round(light.dy);
    const grey=light.color.reduce((sum,v)=>sum+v,0)/3;
    const tint=light.color.map(v=>Math.round(v*.45+grey*.55));
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++) {
      if(!solid(x,y))continue;
      const facing=responseClamp(.5+(((x-cx)/rx)*light.dx+((y-cy)/ry)*light.dy)/(2*span),0,1);
      const rim=light.direction>=0&&!solid(x+sx,y+sy);
      const shadeA=light.strength*.12*Math.pow(1-facing,1.4);
      const tintA=light.strength*(.055*facing+(rim?.105:0));
      const a=tintA+shadeA*(1-tintA),i=(y*w+x)*4;
      if(!a)continue;
      for(let c=0;c<3;c++)out[i+c]=Math.round((tint[c]*tintA+RESPONSE_SHADE[c]*shadeA*(1-tintA))/a);
      out[i+3]=Math.round(a*255);
    }
    g.putImageData(image,0,0);
    while(lightResponses.size>=RESPONSE_LIMIT||responsePixels+pixels>RESPONSE_PIXELS) {
      dropResponse(lightResponses.keys().next().value);responseMetrics.evictions++;
    }
    hit={cv,mask,pixels};lightResponses.set(key,hit);responsePixels+=pixels;responseMetrics.builds++;
    if(cv.addEventListener)cv.addEventListener('contextlost',()=>{if(lightResponses.get(key)===hit)dropResponse(key);},{once:true});
    return cv;
  }
  function canLightResponse(f) {
    if(!f||!LIGHT_RESPONSE_TYPES.has(f.t)||!has(f.t)||(spec(f.t)||{}).flat||
      !Number.isFinite(f.x)||!Number.isFinite(f.y))return false;
    const w=f.w==null?1:f.w,h=f.h==null?1:f.h;
    return Number.isInteger(w)&&Number.isInteger(h)&&w>=1&&h>=1&&(w*TILE+32)*(h*TILE+56)<=RESPONSE_SINGLE;
  }
  function drawLightResponse(f,light) {
    if(!ctx||!canLightResponse(f)||(ctx.isContextLost&&ctx.isContextLost()))return false;
    const sample=responseSample(light);if(!sample)return false;
    let image;
    try {image=responseOverlay(f,sample);} catch(_) {responseMetrics.failures++;return false;}
    if(!image)return false;
    const lift=f.mount==='surface'?SURFACE_RISE:0;
    ctx.save();
    try {
      ctx.globalCompositeOperation='source-over';ctx.imageSmoothingEnabled=false;
      ctx.drawImage(image,f.x*TILE-16,f.y*TILE-48-lift);responseMetrics.draws++;
    } catch(_) {responseMetrics.failures++;return false;
    } finally {ctx.restore();}
    return true;
  }
  // Project each silhouette once. Repeating skewed translucent canvas blits for
  // the whole station stalls the GPU; a straight blit of this 4x raster retains
  // the shaped penumbra and remains sharp through the normal camera zoom range.
  const projectedShadows = new WeakMap();
  function projectedShadow(mask, h) {
    if(projectedShadows.has(mask))return projectedShadows.get(mask);
    if(typeof document==='undefined')return null;
    const layers=[{x:-15,y:-50-h,a:0.11},{x:-16,y:-48-h,a:0.26}];
    const x0=Math.floor(Math.min(...layers.map(l=>l.x-0.52*(l.y+mask.height))))-1;
    const x1=Math.ceil(Math.max(...layers.map(l=>l.x+mask.width-0.52*l.y)))+1;
    const y0=Math.floor(Math.min(...layers.map(l=>h-1-0.34*(l.y+mask.height))))-1;
    const y1=Math.ceil(Math.max(...layers.map(l=>h-1-0.34*l.y)))+1;
    const cv=document.createElement('canvas'),w=x1-x0,height=y1-y0,res=4;
    cv.width=w*res;cv.height=height*res;
    const g=cv.getContext('2d');if(!g||!g.transform)return null;
    g.imageSmoothingEnabled=false;g.transform(res,0,0,res,-x0*res,-y0*res);
    g.translate(0,h-1);g.transform(1,0,-0.52,-0.34,0,0);
    for(const l of layers){g.globalAlpha=l.a;g.drawImage(mask,l.x,l.y);}
    const projected={cv,x:x0,y:y0,w,h:height};
    projectedShadows.set(mask,projected);
    if(cv.addEventListener)cv.addEventListener('contextlost',()=>projectedShadows.delete(mask),{once:true});
    return projected;
  }

  function drawShadow(f, mounted) {
    if (!ctx) return;
    if ((mounted || f.mount) === 'surface') return;
    const s = spec(f.t); if (s && s.flat) return;
    const X = f.x * TILE, Y = f.y * TILE, W = (f.w || 1) * TILE, H = (f.h || 1) * TILE;
    const mask=shadowMask(f);
    if(mask&&ctx.transform) {
      const projected=projectedShadow(mask,H);
      if(projected&&ctx.globalAlpha===1){
        const smooth=ctx.imageSmoothingEnabled;ctx.imageSmoothingEnabled=false;
        try{ctx.drawImage(projected.cv,X+projected.x,Y+projected.y,projected.w,projected.h);}
        finally{ctx.imageSmoothingEnabled=smooth;}
        return;
      }
      const alpha=ctx.globalAlpha;
      ctx.save();
      try {
        ctx.imageSmoothingEnabled=false;
        ctx.translate(X,Y+H-1);
        // High north-west key: elevated parts reach farther east and south.
        ctx.transform(1,0,-0.52,-0.34,0,0);
        ctx.globalAlpha=alpha*0.11;ctx.drawImage(mask,-15,-48-H-2);
        ctx.globalAlpha=alpha*0.26;ctx.drawImage(mask,-16,-48-H);
      } finally {ctx.restore();}
      return;
    }
    const reach = 3 + (SHADOW_TALL[f.t] || 0) + ((f.h || 1) >= 2 ? 2 : 0);
    // three nested steps, each smaller and darker, spreading south-east from the footprint's lower half
    const steps = [[0, 0.09], [0.35, 0.11], [0.7, 0.14]];
    for (const [k, a] of steps) {
      const rx = Math.round(reach * (1 - k));
      const ox = 2 + Math.round(k * 2), oy = Math.round(H * (0.45 + 0.25 * k));
      ctx.fillStyle = 'rgba(' + SHADOW_RGB + ',' + a + ')';
      ctx.fillRect(X + ox, Y + oy, W + rx - ox, H - oy + rx);
    }
  }
  /* colour [r,g,b] · radius (world px) · strength · mode:
       'screen' flickers (phosphor), 'fire' breathes fast and ragged, 'pulse' breathes slow, 'steady' holds.
     `work: 1` = emits only while the prop is lit by real work (workstations). `y` = where the source sits
     in the footprint (0 = north edge, 1 = south) — a desk's CRT is at the back, a floor lamp's head is up. */
  const SCR_RGB = [98, 255, 158], BLUE_RGB = [110, 190, 255], AMBER_RGB = [255, 190, 110], WARM_RGB = [255, 214, 150];
  const EMIT = {
    desk: { c: SCR_RGB, r: 26, a: 0.16, m: 'screen', work: 1, y: 0.25 }, desk2: { c: SCR_RGB, r: 28, a: 0.18, m: 'screen', work: 1, y: 0.25 },
    console: { c: SCR_RGB, r: 26, a: 0.16, m: 'screen', work: 1, y: 0.25 }, consoleL: { c: SCR_RGB, r: 32, a: 0.18, m: 'screen', work: 1, y: 0.25 },
    pixelrig: { c: [255, 120, 200], r: 26, a: 0.16, m: 'screen', work: 1, y: 0.25 }, bench: { c: SCR_RGB, r: 34, a: 0.16, m: 'screen', work: 1, y: 0.25 },
    workbench: { c: [255, 200, 120], r: 22, a: 0.10, m: 'screen', work: 1, y: 0.3 },
    core: { c: [186, 110, 255], r: 32, a: 0.22, m: 'pulse', y: 0.35 }, comms_beacon: { c: [255, 200, 120], r: 30, a: 0.16, m: 'pulse', y: 0.2 },
    comms_dish: { c: [74, 217, 255], r: 22, a: 0.10, m: 'steady', y: 0.5 }, comms_uplink: { c: [74, 217, 255], r: 22, a: 0.10, m: 'steady', y: 0.5 },
    studio: { c: [255, 106, 213], r: 30, a: 0.16, m: 'pulse', y: 0.4 }, connector_portal: { c: [120, 220, 255], r: 22, a: 0.12, m: 'pulse', y: 0.35 },
    bigscreen: { c: BLUE_RGB, r: 46, a: 0.12, m: 'screen', y: 0.4 }, holotable: { c: [120, 200, 255], r: 30, a: 0.14, m: 'screen', y: 0.45 },
    screens: { c: BLUE_RGB, r: 24, a: 0.12, m: 'screen', y: 0.35 }, tank: { c: [80, 200, 220], r: 22, a: 0.12, m: 'pulse', y: 0.45 },
    ticker: { c: AMBER_RGB, r: 26, a: 0.10, m: 'screen', y: 0.35 }, chartwall: { c: BLUE_RGB, r: 26, a: 0.10, m: 'screen', y: 0.35 },
    wartable: { c: [120, 200, 255], r: 34, a: 0.12, m: 'screen', y: 0.45 }, calwall: { c: BLUE_RGB, r: 30, a: 0.10, m: 'screen', y: 0.35 },
    bridge_tacscreen: { c: BLUE_RGB, r: 24, a: 0.12, m: 'screen', y: 0.35 }, bridge_dispatch_pylon: { c: AMBER_RGB, r: 22, a: 0.12, m: 'pulse', y: 0.3 },
    bridge_orderqueue: { c: AMBER_RGB, r: 22, a: 0.10, m: 'screen', y: 0.35 }, war_pivotpanel: { c: BLUE_RGB, r: 22, a: 0.10, m: 'screen', y: 0.35 },
    war_threatcore: { c: [255, 90, 80], r: 26, a: 0.14, m: 'pulse', y: 0.3 },
    tv: { c: [140, 200, 255], r: 26, a: 0.14, m: 'screen', y: 0.4 }, arcade: { c: [255, 120, 200], r: 22, a: 0.14, m: 'screen', y: 0.3 },
    arcade2: { c: [120, 255, 200], r: 22, a: 0.14, m: 'screen', y: 0.3 }, pinball: { c: [255, 190, 90], r: 20, a: 0.12, m: 'screen', y: 0.4 },
    jukebox: { c: [255, 180, 80], r: 22, a: 0.12, m: 'pulse', y: 0.35 }, djbooth: { c: [255, 90, 190], r: 30, a: 0.12, m: 'pulse', y: 0.4 },
    fishtank: { c: [80, 200, 220], r: 22, a: 0.12, m: 'pulse', y: 0.45 }, bar: { c: AMBER_RGB, r: 24, a: 0.08, m: 'steady', y: 0.3 },
    quarters_vending: { c: [120, 220, 255], r: 20, a: 0.12, m: 'screen', y: 0.35 }, speaker: { c: [255, 120, 120], r: 10, a: 0.05, m: 'pulse', y: 0.5 },
    fabricator: { c: [255, 150, 70], r: 26, a: 0.10, m: 'fire', y: 0.45 }, vat: { c: [120, 255, 170], r: 28, a: 0.14, m: 'pulse', y: 0.45 },
    tube: { c: [120, 255, 170], r: 20, a: 0.12, m: 'pulse', y: 0.4 }, research_corelens: { c: [180, 200, 255], r: 24, a: 0.14, m: 'pulse', y: 0.3 },
    research_trendpillar: { c: [120, 200, 255], r: 20, a: 0.10, m: 'screen', y: 0.3 }, etsy_kiln: { c: [255, 120, 50], r: 28, a: 0.18, m: 'fire', y: 0.5 },
    etsy_dyevat: { c: [200, 100, 255], r: 20, a: 0.10, m: 'pulse', y: 0.5 }, easel: { c: WARM_RGB, r: 16, a: 0.05, m: 'steady', y: 0.4 },
    desklamp: { c: WARM_RGB, r: 26, a: 0.22, m: 'steady', y: 0.3 }, arc_floorlight: { c: [255, 220, 170], r: 36, a: 0.24, m: 'steady', y: 0.2 },
    lavalamp: { c: [255, 90, 140], r: 18, a: 0.14, m: 'pulse', y: 0.4 }, plasmaglobe: { c: [170, 110, 255], r: 22, a: 0.16, m: 'fire', y: 0.4 },
    holopet: { c: [120, 255, 220], r: 16, a: 0.12, m: 'pulse', y: 0.4 }, deskterminal: { c: SCR_RGB, r: 18, a: 0.10, m: 'screen', y: 0.35 },
    treasury_pnl_holo: { c: [120, 255, 180], r: 18, a: 0.12, m: 'screen', y: 0.35 }, cryopod: { c: [120, 210, 255], r: 24, a: 0.14, m: 'pulse', y: 0.4 },
    incubator: { c: [255, 170, 90], r: 20, a: 0.12, m: 'steady', y: 0.4 }, crt_pile: { c: SCR_RGB, r: 14, a: 0.06, m: 'screen', y: 0.4 },
    radio: { c: [255, 120, 80], r: 10, a: 0.06, m: 'steady', y: 0.5 }, terrarium: { c: [120, 255, 170], r: 14, a: 0.06, m: 'steady', y: 0.4 },
    bay: { c: AMBER_RGB, r: 28, a: 0.08, m: 'steady', y: 0.45 }, intake: { c: [255, 170, 80], r: 22, a: 0.08, m: 'steady', y: 0.45 },
    outbox: { c: [255, 170, 80], r: 22, a: 0.08, m: 'steady', y: 0.45 },
    missionboard: { c: WARM_RGB, r: 28, a: 0.08, m: 'steady', y: 0.3 }, trophycase: { c: [255, 214, 120], r: 24, a: 0.10, m: 'steady', y: 0.35 },
    commswall: { c: BLUE_RGB, r: 42, a: 0.10, m: 'screen', y: 0.35 }, comms_inbox: { c: AMBER_RGB, r: 16, a: 0.06, m: 'steady', y: 0.4 },
    gigs_amp: { c: [255, 120, 120], r: 14, a: 0.08, m: 'pulse', y: 0.4 }, pub_publishpress: { c: AMBER_RGB, r: 22, a: 0.08, m: 'steady', y: 0.45 },
    arc_indexwall: { c: [120, 200, 255], r: 26, a: 0.08, m: 'screen', y: 0.35 }, arc_microfiche: { c: [140, 255, 190], r: 18, a: 0.10, m: 'screen', y: 0.4 },
    gigs_thumbwall: { c: [255, 150, 200], r: 20, a: 0.08, m: 'screen', y: 0.35 }, pub_mailpod: { c: AMBER_RGB, r: 16, a: 0.06, m: 'steady', y: 0.4 },
    treasury_token_furnace: { c: [255, 130, 50], r: 26, a: 0.16, m: 'fire', y: 0.45 }, goldcrate: { c: [255, 214, 120], r: 14, a: 0.06, m: 'steady', y: 0.4 },
    gigs_servercart: { c: [120, 255, 180], r: 14, a: 0.08, m: 'screen', y: 0.4 }, bridge_relaystack: { c: [120, 200, 255], r: 20, a: 0.10, m: 'screen', y: 0.3 },
    airlock: { c: [255, 90, 70], r: 18, a: 0.10, m: 'pulse', y: 0.5 }, steamvent: { c: [255, 170, 120], r: 12, a: 0.05, m: 'fire', y: 0.5 },
  };
  /* the light a placed prop emits THIS frame, or null. `work` is the same lit flag `draw` receives. The
     modulation is deterministic on `now` + the prop's position, so two identical screens never flicker in
     lockstep; under reduced motion every mode holds steady (`still`). */
  function lightOf(f, work, still) {
    const e = EMIT[f.t]; if (!e) return null;
    if (e.work && !work) return null;
    const lift = f.mount === 'surface' ? SURFACE_RISE : 0;
    const W = (f.w || 1) * TILE, H = (f.h || 1) * TILE;
    const x = f.x * TILE + W / 2, y = f.y * TILE - lift + H * e.y;
    let k = 1;
    if (!still) {
      const seed = (f.x * 7.31 + f.y * 3.17) % 6.28;
      // Keep source animation on the sprite; its bounced light varies only a
      // little, slowly, so neighbouring pools never seem to travel across a room.
      if (e.m === 'screen') k = 0.985 + 0.01 * Math.sin(now / 900 + seed) + 0.005 * Math.sin(now / 2400 + seed * 1.7);
      else if (e.m === 'fire') k = 0.95 + 0.035 * Math.sin(now / 800 + seed) + 0.015 * Math.sin(now / 310 + seed * 2.3);
      else if (e.m === 'pulse') k = 0.98 + 0.02 * Math.sin(now / 2800 + seed);
    }
    return { x, y, r: e.r, c: e.c, a: e.a * k };
  }

  // Compact physical nameplates, painted after lighting for contrast. Geometry
  // stays in station units: zooming out shrinks the tag together with its bay.
  const bayTextLayouts = new Map();
  function drawBayNames(props, scale, dpr) {
    if (!ctx || !props.length || !(scale > 0)) return;
    const font = 7, pad = 1, h = 9;
    ctx.save();
    try {
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.font = font + "px 'VT323','Courier New',monospace";
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const p of props) {
        if (!p.agentId) continue;
        const name = String(p.dockName || String(p.agentId).replace(/^tg_/, '')).toUpperCase();
        const maxWidth = Math.max(8, (p.w || 1) * TILE - pad * 2);
        const key = name + '|' + maxWidth;
        let layout = bayTextLayouts.get(key);
        if (!layout) {
          let text = name;
          if (ctx.measureText(text).width > maxWidth) {
            const chars = Array.from(text);
            while (chars.length && ctx.measureText(chars.join('') + '…').width > maxWidth) chars.pop();
            text = chars.join('') + '…';
          }
          layout = { text, width: ctx.measureText(text).width + pad * 2 };
          if (bayTextLayouts.size >= 256) bayTextLayouts.clear();
          bayTextLayouts.set(key, layout);
        }
        const x = (p.x + (p.w || 1) / 2) * TILE;
        const anchor = p.y * TILE - (p.mount === 'surface' ? SURFACE_RISE : 0) + 1;
        const box = { x: x - layout.width / 2, y: anchor - h / 2, w: layout.width, h };
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#0b1916'; ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.strokeStyle = '#65c9ad'; ctx.lineWidth = 0.5;
        ctx.strokeRect(box.x, box.y, box.w, box.h);
        ctx.fillStyle = '#d6fff0'; ctx.shadowColor = '#5ad1b3'; ctx.shadowBlur = Math.min(scale, 2 * (dpr || 1));
        ctx.fillText(layout.text, x, anchor);
      }
    } finally { ctx.restore(); }
  }

  return {
    setCtx(c) { ctx = c; },
    setNow(t) { now = t; },
    // v13 LOCAL COLOUR knob (see CHROMA above) — live-tunable like the CRT LAB's own dials, so the
    // value is DIALLED on a real deck and copied back into the constant, never guessed.
    setChroma(k) { CHROMA = (k == null ? 1 : +k) || 1; _cboost.clear(); },
    getChroma: () => CHROMA,
    draw, drawBayNames, drawOver, hasOver, drawSeatFront, CATALOG, CATS, spec, has, TILE,
    drawShadow, lightOf, EMIT, canLightResponse, drawLightResponse, lightResponseStats, invalidateLightResponse,
    // ORIENTATION: what each prop's art can honestly do, and the box it covers once turned. The
    // builder asks BEFORE offering an R/M affordance — never an input that produces broken art.
    facings, canRotate, canMirror, nextFacing, footprintAt, viewAt, hasView, NO_MIRROR, PLAN_FOOTPRINT,
    // live connector state (the world layer feeds these; the connector_portal sprite reads them)
    setConnectorState, pulseConnector,
    // workbench pulse (the world layer feeds this off shell.exec / verify.result)
    pulseWorkbench,
    // connector reconcile: drop portals absent from a successful /api/connectors poll (stale-green fix)
    reconcileConnectors,
    // JUKEBOX live state (the world layer feeds this off /api/spotify/status — dead-vs-live glow)
    setSpotifyConnected,
    // per-instance capability-prop pulse (G0.1 — the world layer feeds this off agent.tool_call via toolprops.js)
    pulseProp,
    // G2.3 uncollected-crate stack on the OUTBOX (the world layer feeds this from ReturnStore.pendingCount)
    setOutboxCrates,
    // G1b MISSION BOARD pins + station-gap beacon (the world layer feeds these from the live quest projection)
    setMissionPins,
    // G3b TROPHY CASE earned-trophy count (the world layer feeds this from the live trophy projection)
    setTrophyCount,
    setJourneyStage,
    // tab/tier display names — shared with build.js (palette tabs) and propsearch.js (matching)
    TIER_LABEL, CAT_LABEL,
    // the STARTER shelf ids (build.js pins these above the SYSTEMS drawers; locked by prop-starter-shelf.test.js)
    STARTER,
    // exposed for tests / reuse
    _F: F,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PropSprites;
