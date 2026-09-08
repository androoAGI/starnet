/* STARNET — stationbake.js : the GENERALIZED station bake.

   v7's world.js / render.js bake the gorgeous procedural station art (floors, tilted
   walls, rounded-corner hull arcs, lit pools, hull extrusion, lightmap) — but each was
   wired to a single hardcoded room (world.js) or the fixed v7 MAP (render.js). This module
   lifts that exact bake VOCABULARY to an ARBITRARY set of rooms + corridors, driven purely
   by the geometry object WorldModel.projectGeometry() emits.

   StationBake.bake(geo) -> { baseCv, lightCv, W, H, origin, flickers }
     baseCv  — floors + walls + hull + room lighting (blit first, under entities)
     lightCv — baked darkness with light pools carved out (blit last, over entities)
     flickers — lamp positions for the per-frame shimmer (drawGlows)

   Depends only on the global `U` (util.js: U.hash, U.shade) and the DOM canvas API. */
'use strict';

const StationBake = (() => {
  const nextSurfaces = () => typeof WorldSurface !== 'undefined' &&
    (typeof WorldRenderer === 'undefined' || WorldRenderer.enabled());
  let wallFixtures = [];
  /* palette + geometry knobs — verbatim from v7 world.js/render.js */
  const pad = 7;
  const NFACE = 9, FACEW = 4;
  // `wallDk` used to live here too — a fourth wall tone that was in fact the SHELL, painted over the
  // hull plate on every exterior edge. It moved to the hull palette as `edge` (2026-08-06); nothing
  // outside a room is a wall tone any more.
  const wallTop = '#4a463a', wallFace = '#2b2820', hullC = '#191712';
  const wallCap = '#7c7258';   // the lit TOP surface of a tall wall — bright on purpose: it survives the ambient bake and defines wall height at any zoom

  /* PER-ROOM WALL PALETTE. The four constants above used to paint every wall in the station one
     colour — a cobalt bridge and a rust foundry had identical brown-grey walls. The interior
     faces are derived per room now, from that room's wall hue (which itself defaults to the
     room's FLOOR hue, so a station is varied the moment it's built). The HULL tones went per-room
     too — first the skirt (2026-08-05), then the exterior edge and corner rim that the wall pass
     was still painting from constants (2026-08-06). Nothing outside a room is global now.

     TONE SEPARATION IS THE WHOLE JOB. A wall face at only -0.15 off the deck's own base reads as
     the SAME surface as the floor — same value, same plate rhythm — so the room looks like one
     continuous field with an arbitrary seam across it rather than a floor with walls around it.
     Walls are vertical, they face away from the ceiling lamps, and they must sit clearly DARKER
     than the deck they enclose. */
  /* ================= HUE-SHIFTED SHADING (world overhaul, 2026-09-03) =================
     Every interior mark in this bake used to step off its base through U.shade, which lerps toward
     white or black: a darker step is the SAME hue with less light, a lighter step the same hue washed
     grey. That is how a spreadsheet shades a cell, and it is why the deck read as one brown field with
     lines on it. A painted surface does not do that — shadow travels COOL (toward blue-violet) and gains
     saturation as it deepens; light travels WARM (toward yellow) and thins. Every pixel-art game you
     would pay $40 for hue-shifts its ramps; it is the single most recognisable mark of the craft.
     So the interior painters (deck materials, wall recipes, side faces, corner crowns) shade through
     this instead. LIGHTNESS IS EXACTLY U.shade's — only the hue rotates toward the pole and the
     saturation nudges — so every tone relationship the bake was tuned on survives; the rotation is
     capped per step (`darkRot`/`lightRot` at |f| = 1) and scales with the step, so a -0.03 plate tone
     barely moves and a -0.62 floor-contact seam goes distinctly cool. A neutral (s < 0.02) picks up the
     pole's tint from nothing, which is what puts blue in a grey deck's shadows.
     THE HULL DOES NOT USE THIS. Its ramp is hand-tuned in `hullPal` and pinned by the hull test, and it
     hangs outside the ambient plate where a cool cast would read as a colour change, not a shadow.
     Cached per (hex, f): the painters call this millions of times across a bake. */
  const HUE = { darkTo: 250, darkRot: 40, darkSat: 0.22, lightTo: 50, lightRot: 30, lightSat: 0.10 };
  const _shadeCache = new Map();
  const _hsl = (r, g, b) => {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  };
  const _rgb = (h, s, l) => {
    if (s <= 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
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
      let h = hsl[1] < 0.02 ? to : hsl[0] * 360, s = hsl[1] < 0.02 ? 0 : hsl[1];
      const d = ((to - h + 540) % 360) - 180;                        // signed shortest way round to the pole
      h += Math.max(-cap, Math.min(cap, d));
      s = Math.max(0, Math.min(1, s + (dark ? amt * HUE.darkSat : -amt * HUE.lightSat) * (hsl[1] < 0.02 ? 0.5 : 1)));
      const c = _rgb(((h % 360) + 360) % 360 / 360, s, l);
      out = '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1);
    } else {
      out = '#' + ((1 << 24) | (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)).toString(16).slice(1);
    }
    if (_shadeCache.size > 20000) _shadeCache.clear();
    _shadeCache.set(key, out);
    return out;
  }

  const WALL_TONE = { face: -0.32, top: -0.10, cap: 0.30 };   // cap back at the shipped +0.30 (2026-09-05, Andrew with a 0.10.13 frame: "there is no wall line") — the bright crown IS how a top-down view reads a wall; the exterior's darkness lives in HULL_EXPOSURE, never here
  let wallPalCache = null;
  function wallPal(z) {
    let p = wallPalCache && wallPalCache.get(z);
    if (p) return p;
    const base = (G && G.wallBaseOf && G.wallBaseOf(z)) || '#3a3b41';
    p = { base, face: shade(base, WALL_TONE.face), top: shade(base, WALL_TONE.top), cap: shade(base, WALL_TONE.cap) };
    if (!wallPalCache) wallPalCache = new Map();
    wallPalCache.set(z, p);
    return p;
  }
  // FALLBACK ONLY, like MAT_BY_KIND below: projected geometry always carries wallMatOf, so this
  // default is not what you see in game. WorldModel.wallMatOfRoom is the authority — change both.
  const wallMatOf = z => {
    const m = G && G.wallMatOf ? G.wallMatOf(z) : null;
    return WALL_RECIPES[m] ? m : 'bulkhead';
  };

  /* live-tunable WALL HEIGHT — same contract as LIGHT below: the CRT LAB writes these and
     re-bakes. Height only ever extrudes OUTSIDE the floor footprint (up-screen above north
     edges, down-screen below the hull, sideways past e/w edges), so no walkable tile is ever
     covered and nothing y-sorted against agents changes.
       up     = how far a room's north wall face rises above the floor seam (px)
       corUp  = same for corridors (lower → corridors read as tunnels, rooms as halls). It must
                stay LOWER than `up` — that difference IS the tunnel read — but it may not be 0:
                at 0 the north face falls to the legacy short-wall branch, which paints no lit
                crown at all, so a hallway with an exposed north end had the one surface that
                defines a wall's height simply missing (2026-07-28).
       skirt  = hull extrusion depth below the station silhouette (the south wall seen outside)
       side   = width of the e/w wall-top band beyond the floor edge. PINNED TO `pad`: the hull
                plate, its rounded corners and its riveted rim all stop exactly `pad` out, so a
                wider band is a slab of wall sticking out past the station's own silhouette. It
                did not show while the band was near-black, and it showed the instant the band
                got a lit crown.
       capH   = thickness of the lit cap that crowns a tall wall
       sideCap= width of the LIT TOP SURFACE on the walls that are not extruded (e/w/s and the
                corner arcs). CAPPED AT pad-1 BY CONTRACT: buildLightMap's ambient plate covers
                each footprint plus exactly `pad`, so a crown wider than that hangs OUTSIDE the
                mask and renders at its raw baked tone against the starfield — a blazing line
                down the sides while the north crown sits under 0.77 ambient. */
  const WALL = { up: 30, corUp: 30, skirt: 40, side: 7, capH: 4, sideCap: 5, hullLit: 0.70, hullVoid: 0.34 };   // hullLit/hullVoid = the exterior's exposure at the deck line / at the skirt's foot (2026-09-06, the shell fade — see the EXTERIOR EXPOSURE note)   // corUp 16→30, skirt 32→40 (2026-09-05, Andrew: the south wall read shorter than the north, hallways "way shorter" than rooms — a hallway is the room's construction now, and the skirt matches the north face's visible height)   // up 22→30, corUp 12→16 (2026-09-03, depth pass): a room is a box you are inside, and height is the only cue a top-down view has for it   // up 9→14 (2026-07-24): the wall materials need surface to live on · corUp 0→8 (2026-07-28): a hallway stands too, just lower than a hall · up 14→22, corUp 8→12, capH 3→4 (2026-08-08): at 14 the standing face was ~1/8 of a room's frame against 130+px of deck, so the room read as a TRAY seen from above rather than a box you are inside. Height is the only cue a top-down view has for "interior"; the ratio of visible WALL to visible FLOOR is what sells it, and that ratio scales with `up`. 22 is inside the range 'Towering' (32) already exercised, and corUp rises with it so the hallway↔hall difference is preserved
  /* VIEWPORT holes punched by the wall pass this bake. buildLightMap cuts the ambient mask over
     them — without that the sky behind a window renders at the interior's 23% and reads as a
     black pane. Reset per bake alongside the wall palette cache. */
  let viewportRects = [];
  /* THE CORNER CROWN'S ACTUAL REACH, recorded BY THE PAINTER — chamfer key → (column → topmost
     painted bake-pixel row). buildLightMap's chamfer erase needs to know how far up the art goes so
     the ambient mask stops exactly there; deriving that a second time is precisely what drifted
     before (see the note in buildLightMap). Same per-bake-state contract as viewportRects/lampPos,
     and keyed on absolute bake-pixel coords, so a chunk bake records the same numbers as the
     monolithic one.

     KEYED PER CHAMFER, NOT PER COLUMN. It was one flat column→row map, which is indistinguishable
     from correct on a one-room station because no two chamfers can share a bake column there. Put a
     second room above or below another and they do: the mask pass then ran from a FAR-AWAY corner's
     reach down to THIS corner's tile, laying a tall 1px column of ambient over bare space — a
     scattered shadow line hanging in the starfield (Andrew, on his own multi-room station). 148
     leaked pixels on a stacked layout, 0 on the seed. LEAK-CHECK CORNER WORK ON A MULTI-ROOM
     STATION; the single-room case cannot exercise this at all. */
  let crownReach = null;

  /* EVERY RECT THE CROWN PAINTS, recorded by the painter for buildLightMap to cut the ambient back
     over (same per-bake contract as viewportRects/lampPos, absolute bake-pixel coords, so chunk and
     monolithic bakes record identically).

     WHY THE CROWN NEEDS ITS OWN CUT AT ALL. The hull SKIRT hangs in void and is deliberately left
     OUTSIDE the ambient plate, so it renders at its raw baked tones — its top lip `#3f3a2c` reads
     luma 58 flat. The wall's crown is interior and takes the full 0.77 ambient, which at the dark
     end of a room drops it to 38. So the station's hull was BRIGHTER than the lit top surface of
     the wall inside it, and the corners nearest the skirt were where that inversion showed worst.
     Brightening the baked tone cannot fix it: through 0.77 ambient even a pure white crown tops out
     near luma 62, barely at the skirt. The ambient itself has to give over the crown.
     Which is also the honest reading — a crown is the one interior surface that faces the ceiling
     lamps square-on. It is cut MULTIPLICATIVELY, so the crown still darkens away from the lamps
     like everything else; it just never falls under the shell outside it. */
  let crownRects = [];
  let cornerFaceRects = [];
  let doorOcclusion = [];   // solid entrance surfaces, kept for the entity depth pass
  const crown = (b, x, y, w, h, color) => {
    b.fillStyle = color; b.fillRect(x, y, w, h);
    if (w > 0 && h > 0) crownRects.push([x, y, w, h]);
  };

  /* live-tunable lighting — the CRT LAB (crtlab.js, dev-gated) writes these and calls
     World.rebake() to re-run the bake. These ARE the shipped defaults.
       ambient  = how dark the unlit station is (0=fully lit · 1=black)
       pool     = how brightly the ceiling lamps carve their light pools back out
       room/corridor/door = baseline lift inside each space type
       floor    = warmth of the additive light pool painted on the floor
       pitch    = TILES BETWEEN CEILING LAMPS, on BOTH axes. This was a bare `/ 7` on the room's
                  WIDTH only, which meant a room got exactly one ROW of lamps, pinned a tile and a
                  half below its north wall. A lamp's carve reaches `rad * 1.4` ≈ 84px ≈ 7 tiles,
                  so every room deeper than ~7 tiles had its whole southern half sitting at raw
                  0.77 ambient — an unlit tray with a lit strip along the top edge, which is the
                  "the lamps emit nothing" read. Rooms are not 7 tiles deep any more, so the lamp
                  grid has to run DOWN the room as well as across it. Row 0 stays exactly where it
                  was (it is the row the wall-mounted flood hardware is drawn for); the rest are
                  spread from there to the south end at this pitch.

                  WHY 8 AND NOT 7. Both light the whole deck; the difference is whether there is a
                  TROUGH between pools at all, which is the thing that makes a floor read as MODELLED
                  BY LIGHT rather than washed. Measured on an 18x14 hab: pitch 7 lays a 3x3 grid and
                  gives peak 73 / trough 47, which is an evenly lit warehouse; pitch 8 lays 2x2 and
                  gives peak 56 / trough 31 — distinct pools with real dark between them, which is
                  the station's own idiom (cf. the 'Dark + pools' preset). It is the shallow end of
                  the distinct-pools family: 9 and 10 render IDENTICALLY on a room this size, because
                  both the row and column counts are rounded tile divisions and only step at integer
                  boundaries. What 8 is NOT is the old failure — that trough sat at 17.5 and kept
                  falling to black with no recovery; 31 is a dip between two lamps. */
  /* DULLED 2026-08-15 (Andrew: "the station is a bit too bright with the lighting… slightly dull
     it"). The four CUT strengths came down and the ambient plate went up one notch; the additive
     warm floor pool (`floor`) and the fixture grid (`pitch`) are untouched, because those are what
     put light ON the deck — dimming them flattens the modelling instead of dimming the room.
     WHICH KNOB ACTUALLY MOVES THE PICTURE, measured on the seeded hab (npm run shoot --only ingame,
     mean luma over the deck rect): `ambient` alone is nearly inert — 0.77 → 0.84 moved the deck
     29.3 → 28.8 (-1.8%), because the room cut already takes 60% of the plate back out and what is
     left is a near-black film. The CUTS are the lever: pool/room/corridor/door at the values below
     read 26.2 (-10.7%), p95 58.1 → 52.6, with the lamp pools' shape intact. `ambient` still earns
     its bump — it deepens the troughs the cuts don't reach (p5 9.1 → 7.9), which is the contrast
     half of "duller"; 0.82 is the CRT LAB's own 'Dark + pools' value, not a new number.
     THE CROWN LAW STILL HOLDS at these values (checked, don't assume): the wall's lit top reads
     59.6 against the hull skirt's 11.1 — the skirt hangs outside the ambient plate so it never
     moved, and a deeper plate is exactly what could have put the crown back UNDER it. */
  /*   falloff  = shape of EVERY light pool's edge (see falloffAt): 0 = the old dead-linear ramp,
                  1 = the physical curve a lamp hung over a deck actually lands.
       cool     = how far the SHADOW tint travels from the old warm-black toward cold blue. Light
                  has a colour temperature; the absence of it does too, and the two must differ or
                  the room is one grey field at two brightnesses.
       warm     = alpha of the warm film painted back INSIDE each pool. The cut alone only removes
                  darkness — it cannot put light ON anything. This is the pass that lands lamplight
                  on the crew, the props and the crates standing in the pool, not just on the deck
                  the base layer already baked. Kept LOW: the film rides lightCv, which blits OVER
                  the entities, so past ~0.1 it washes a body standing in its own room's light.
       spill    = cold starlight falling in through every viewport pane. The one light in the
                  station that is not a lamp, and the only source of real colour contrast.
       reach    = multiplier on every pool's radius (base pool AND cut AND film together). At 1 a
                  room's pools are islands on a dark deck; past ~1.4 neighbours merge into a wash. */
  /* 2026-09-02 (world glow-up, measured on a furnished 18x12 lounge + the stock hab at zoom 2,
     full CRT frame): the pre-09-02 room sat at mean luma 31 with 2% of the deck lit and mean
     chroma 12 — one dim field, no texture readable. The four CUT strengths, `floor`, `warm` and
     `reach` together take it to mean 44 / 7% lit / chroma 22 with the SAME crushed-black floor:
     contrast and colour, not a global lift (ambient itself moved 0.82 -> 0.80 only). A/B the whole
     thing with the CRT LAB's "Light: pre-09-02" preset before relitigating any single value. */
  const LIGHT = { ambient: 0.82, ambR: 7, ambG: 5, ambB: 3, pool: 0.85, room: 0.46, corridor: 0.34, door: 0.4, floor: 0.24, crown: 0.45, pitch: 8, reach: 1.3, falloff: 0.85, cool: 0.45, warm: 0.16, spill: 0.7 };   // floor 0.26→0.3, warm 0.14→0.3 (2026-09-03 overhaul: the film is what puts light ON the deck under a lamp; measured lounge sd 28.8→35+, crushed 4%→2%) · crown = how far the ambient gives way over a wall's lit top surface (0 = off, the old inversion)
  const POOL_RGB = '246,224,188';   // warm-neutral tungsten — the deck pools (locked by simulation-lighting.test.js)
  const LAMP_RGB = '255,192,104';   // the film's tungsten — a touch more saturated than the deck pool, it sits ON things
  const STAR_RGB = '150,186,255';   // the sky through the glass
  /* Warm area-light colour by room kind. These are virtual samples for baked
     surface light and steady glow, not visible ceiling fixtures. Screens and
     viewport spill provide cooler accents against the golden room illumination. */
  const LAMP_RGB_BY_KIND = { lab: '250,213,160', bridge: '246,213,172', factory: '255,178,88', storage: '250,204,140', quarters: '255,188,96', corridor: '255,207,145' };
  const lampRgbOf = z => {
    if (G && G.isCorridor && G.isCorridor(z)) return LAMP_RGB_BY_KIND.corridor;
    const k = (G && G.kindOf) ? G.kindOf(z) : null;
    return LAMP_RGB_BY_KIND[k] || LAMP_RGB;
  };
  const COLD_AMB = [4, 8, 19];      // the tint the shadow travels TO at cool:1

  /* ---------- THE FALLOFF CURVE ----------
     Every pool in the station was a 3-stop gradient through (0,1) (0.55,0.45) (1,0) — three
     COLLINEAR points, i.e. exactly `1 - t`. A linear ramp is the one falloff no real light source
     has, and it is why the deck read as an airbrushed wash: half of a linear ramp's travel sits
     above 50%, so a room ends up uniformly grey with no pool visible inside it.
     A fixture hung at height h over a flat deck lands E(r) = h³/(h²+r²)^(3/2) on it — a broad
     bright plateau under the lamp, a fast shoulder, then a long dim tail. Written in pool-radius
     units (h = H_OVER_R·R, t = r/R) and re-normalized so the rim still reaches exactly 0, that is
     the curve below. Sampled at 8 fixed offsets so it stays a plain multi-stop gradient: portable
     to the headless canvas mock (which only fakes createRadialGradient) and keyed on nothing but
     `t`, so a chunk bake emits a byte-identical stop list to the monolithic one — the parity
     stationbake.chunk.test.js asserts. LIGHT.falloff mixes linear↔physical. */
  const FALL_T = [0, 0.12, 0.25, 0.38, 0.5, 0.65, 0.8, 1];
  const H_OVER_R = 0.55;
  const E_RIM = Math.pow(1 + 1 / (H_OVER_R * H_OVER_R), -1.5);
  function falloffAt(t) {
    const u = t / H_OVER_R;
    const phys = (Math.pow(1 + u * u, -1.5) - E_RIM) / (1 - E_RIM);
    const k = Math.max(0, Math.min(1, LIGHT.falloff));
    return (1 - t) * (1 - k) + phys * k;
  }
  /* paint `rgb` into a radial gradient along that curve. One helper for the lightmap's cuts, the
     warm film, the window spill and the base layer's additive floor pools — so the light a surface
     receives and the darkness it keeps are shaped by the SAME curve. They used to disagree (the
     floor pool bent at 0.6→0.32 while the cut ran dead straight), which is a soft double edge on
     every pool rim. */
  function falloffStops(g, rgb, a) {
    for (const t of FALL_T) g.addColorStop(t, 'rgba(' + rgb + ',' + (a * falloffAt(t)).toFixed(4) + ')');
  }

  /* live-tunable DEPTH FX — the CRT LAB writes these and re-bakes (same contract as LIGHT/WALL).
     Pure top-down 2D cosmetics that make the deck read a touch more 3D — never imply agent/run
     state. Baked once at bake-time, so free at runtime.
       wallShadow = strength of the soft south-cast shadow the standing north wall throws onto
                    the floor at its base (0 = off, matches the pre-depth look), and the extra
                    e/w wall-base shade so every wall foot sits in a little shadow.
       sheen      = strength of the faint vertical reflection streak baked on the floor under
                    each ceiling-light pool (polished deck read; 0 = off).
       cornerAO   = pooled darkening where two wall feet MEET (concave floor corners). The
                    linear wallShadow bands merely overlap there; this adds the radial-ish
                    corner pool that sells the room as a 3D box (0 = off).
       dither     = ordered-dither quantization of the light map's smooth alpha falloff into
                    hard stepped levels broken by a 4x4 Bayer pattern, so LIGHT reads in the
                    same chunky pixel idiom as the geometry (0 = off = smooth gradients).
       floorWear  = density/strength of hash-keyed wear on the deck — scuffs, worn patches,
                    drag marks, corridor traffic lanes (0 = off = the pristine floor).
       floorDetail= amplitude of the V2 floor-material pass (deck plates, seams, rivets,
                    per-kind recipes, perimeter trim). Scales every U.shade delta the floor
                    draws, so 0 = a flat unadorned deck, 1 = shipped, >1 = overdriven. */
  /*   deckSeam   = how hard the JOINT between deck plates/boards reads. The v3 grout was a -0.30
                    step with a +0.07 catch-light immediately beside it, repeated at every plate
                    boundary — a high-contrast 2px edge on a 24px pitch, which reads as a GRID OF
                    SEPARATION LINES cutting the deck into blocks instead of a quiet laid surface
                    (Andrew 2026-07-24: "there seems to be this separation line, can we remove that
                    so it blends?"). The joint still has to exist or a plate deck is a flat field,
                    so it gets its own knob rather than being deleted. Scales ONLY the seam/bevel
                    steps — per-plate tone, material dressing and wear are untouched.
                    0 = a genuinely seamless deck · 1 = the old hard v3 grid. */
  const DEPTH = { wallShadow: 0.5, sheen: 0.14, cornerAO: 0.55, dither: 0.12, floorWear: 0.55, floorDetail: 1, wallDetail: 1, deckSeam: 0.38, poolAlbedo: 1, edgeAO: 1, southFoot: 0 };   // dither 0.15 was Andrew's 07-13 dial; 0.45 (2026-09-03 overhaul) makes the light read in the same stepped pixel idiom as the geometry now that the pools have real shape

  /* ============================ THE EXTERIOR SHELL (HULL SKINS) ============================
     Everything you see of a room from OUTSIDE: the plate surrounding its footprint, the texture
     over that plate, the framed rim, the rounded corner arcs, and the SKIRT — the tall face
     extruded below the station's silhouette, which is what actually reads at a glance.

     Until 2026-08-05 all five came from the five constants above, so every room of every station
     wore the identical dark riveted shell (Andrew, circling exactly those edges: "the outer walls
     are not customizable"). They are per room now. WorldModel.hullMatOfRoom/hullStyleOfRoom are the
     authority; what is here is the PAINT, plus the fallback for geometry arriving without either.

     ---- THERE IS NO "NO SKIN" CASE ANY MORE (2026-08-06) ----
     `G.hullBaseOf` may still answer null, and that means "the shell's own tone" — the hue below,
     which every room that has never been re-clad carries. It used to mean something stronger: a
     whole PARALLEL PALETTE of literal pre-axis constants, kept so that stations already built
     stayed pixel-identical. That property turned out to be the defect Andrew reported — "the
     default still has the previous default mixed in ... make sure the previous shell walls are
     100% gone". A room on the old constants is not a room wearing the STATION skin: it cannot be
     re-toned, it does not answer to the material catalog, and beside a re-clad neighbour it reads
     as a different material entirely.
     So the constants are gone and the default is now an ordinary skin: the STATION material at
     STATION_TONE. What kept the look is that STATION carries its OWN palette ramp (`pal` below,
     the hand-tuned pre-axis ladder re-expressed as ratios of whatever hue the room holds) instead
     of the shared derivation — the same freedom every material already had over its bands, veins
     and dressing. The shell you always had is now a skin you can re-colour. */
  const STATION_TONE = hullC;
  /* ---- THE VACUUM CLAMP: why a hull hue cannot be used at face value ----
     Every other surface in this bake is painted UNDER the ambient mask, which multiplies it down by
     0.77 before you ever see it. The hull is the one surface deliberately left OUTSIDE that mask —
     the skirt hangs in void and renders at its raw baked tones. So the FLOOR_STYLES palette, whose
     hues were chosen to sit in a dark substrate band *once ambient has taken them down*, renders
     roughly four times brighter out there than the same hue does inside the room.

     Measured on the shipped bake, down the middle of a south wall: the station's own shell tops out
     at luma 37, TIMBER at 51, STONE at 55, BRICK at 58 — and brick's mortar spiked to 86, brighter
     than the lit wall crown (79) and the brightest thing on the whole exterior. That is exactly the
     "doesn't look right, needs to be more cohesive" read (Andrew, 2026-08-05): a building glowing
     harder than the station it is bolted to.

     So a chosen hue is clamped into the shell's own value band before anything derives from it.
     Scaling all three channels by one factor preserves the hue exactly — it is a pure exposure
     change, which is the honest model for "this surface gets no light". The floor lifts near-black
     hues (ONYX) so a shell never goes pure void, and the cap is what keeps BONE from painting a
     blazing white building — the same standing law that killed light mode three times. */
  const HULL_LUMA_CAP = 28, HULL_LUMA_FLOOR = 13;
  /* ...EXCEPT AT THE BRIGHT POLE. The clamp above exists to stop a hue picked as a FLOOR SUBSTRATE
     from accidentally glowing when it is used on the one surface ambient never touches. But BONE and
     WHITE are not accidents — they are the palette's deliberate bright end, and nobody lands on them
     by mistake. Flattening them to 28 alongside RUST and COBALT does not make the station cohesive,
     it just makes the palette lie: you pick WHITE and get another dark grey wall.
     So a hue that is already unambiguously bright (luma over the pole) clamps to its own, much
     higher ceiling instead. A white building then really is the brightest thing outside — above the
     lit wall crown at 79, below the ceiling lamps at 127 — which is exactly what a whitewashed wall
     looks like at night, and it stays strictly OPT-IN: you have to go and choose it. */
  const HULL_BRIGHT_POLE = 150, HULL_BRIGHT_CAP = 85;
  const vacuum = hex => {
    const n = parseInt(String(hex).slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    if (l < 1) return '#0d0d0d';
    const cap = l > HULL_BRIGHT_POLE ? HULL_BRIGHT_CAP : HULL_LUMA_CAP;
    const k = l > cap ? cap / l : (l < HULL_LUMA_FLOOR ? HULL_LUMA_FLOOR / l : 1);
    if (k === 1) return hex;
    const c = v => Math.max(0, Math.min(255, Math.round(v * k)));
    return '#' + ((1 << 24) | (c(r) << 16) | (c(g) << 8) | c(b)).toString(16).slice(1);
  };

  /* A PURE EXPOSURE STEP — every channel scaled by one factor, so the hue survives untouched and
     only the amount of light on the surface changes. `U.shade` lerps toward WHITE on a lift, which
     desaturates: it is right for a mark sitting ON a surface (a catch-light really is whiter) and
     wrong for restating the SAME material at a different brightness, which is what a shell ramp is.
     Ceiling: nothing on the exterior may out-shine the lit wall crown by much — see the vacuum note
     — so a lift is scaled back if it would carry the result past it. */
  const HULL_LIFT_CEIL = 115;
  const lift = (hex, k) => {
    const n = parseInt(String(hex).slice(1), 16);
    let r = ((n >> 16) & 255) * k, g = ((n >> 8) & 255) * k, b = (n & 255) * k;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    if (l > HULL_LIFT_CEIL) { const s = HULL_LIFT_CEIL / l; r *= s; g *= s; b *= s; }
    const c = v => Math.max(0, Math.min(255, Math.round(v)));
    return '#' + ((1 << 24) | (c(r) << 16) | (c(g) << 8) | c(b)).toString(16).slice(1);
  };

  /* THE STATION SHELL'S OWN LADDER. These ratios ARE the pre-axis constants: measured off them
     channel by channel against the shell tone they were drawn at, so STATION at STATION_TONE
     reproduces the shipped shell to within a few units per channel — and STATION at any OTHER hue
     is the same shell in that colour, which is the thing the literal constants could never be.
     Multiplicative, not U.shade, precisely so a re-coloured station hull stays the colour you
     picked instead of drifting grey as it climbs (see `lift`). */
  const hullStationPal = raw => {
    const base = vacuum(raw);
    return {
      base,
      seam: lift(base, 1.35), rim: lift(base, 1.56), bolt: lift(base, 1.87),
      arc:  lift(base, 1.56), lit: lift(base, 2.50), dk: lift(base, 0.43),
      edge: lift(base, 1.16),
      bands: [0.43, 0.62, 0.85, 1.20, 1.63, 2.50].map(k => lift(base, k))
    };
  };

  /* A DERIVED SHELL. Same discipline as WALL_TONE: every mark is a U.shade off the room's one hue,
     so any material renders in any colour coherently. The skirt ramp darkens DOWNWARD (away from
     the deck lights, into the void) — that gradient is what gives the station its height, and a
     material that flattens it reads as a sticker rather than a standing wall. */
  const derivedHullPal = raw => {
    const base = vacuum(raw);
    return {
      base,
      seam: U.shade(base, -0.26),
      rim:  U.shade(base, 0.12),
      bolt: U.shade(base, 0.30),
      arc:  U.shade(base, -0.14),
      lit:  U.shade(base, 0.24),
      dk:   U.shade(base, -0.58),
      /* THE EDGE — the top-down ring of shell between a wall's lit crown and the void, on the north,
         east and west. It is the ONLY part of the exterior you see on three of a room's four sides
         (the plate's dressing sits under it and the skirt only hangs on the south), so while the
         wall pass painted it from a module constant a hull skin could not reach three quarters of
         the station. See the note on `edge` in bakeWalls. */
      edge: U.shade(base, 0.02),
      bands: [U.shade(base, -0.74), U.shade(base, -0.64), U.shade(base, -0.50), U.shade(base, -0.32), U.shade(base, -0.12), U.shade(base, 0.14)]
    };
  };
  /* A MATERIAL MAY OWN ITS PALETTE, not just its texture. `HULL_RECIPES[m].pal` is optional and
     defaults to the shared derivation; only STATION supplies one, because its ladder predates the
     axis and is the one every other skin was tuned to sit beside. Resolved through the recipe so
     there is exactly ONE path from (room → hue → paint) — the parallel legacy table is what let a
     pre-existing room fall outside the catalog entirely. */
  /* EXTERIOR EXPOSURE (2026-09-03, Andrew: "look how dark outer space is, then everything else is as
     bright as hell… the outer shell needs a major lighting fix, it's WAY too bright"). The shell hangs
     outside the ambient plate by design, so every skin rendered at its raw authored tone — brighter than
     the lit deck inside it. Nothing lights a hull in vacuum but starlight, so every hull palette, in every
     skin, is scaled by one exposure factor here: hue kept, only the light on it changes. The hull look-lock
     test scales its expected tones by the same constant. */
  /* ...AND THE LIGHT ON IT FADES (2026-09-06, Andrew, with a frame of the default hab: "the shell lighting might
     be just a tad bit too pitch black dark, i think it should have a fade and a bit more brightness but not too
     much"). The flat 0.4 (0.6 "not close", 0.25 "basically pitch black", 2026-09-03) put every stop of the skirt
     ramp within ~20 units of black, so the 40px wall read as a cut-out DARKER than the nebula behind it — a hole,
     not a surface. The light on a hull is not flat: the deck's own light spills over the crown onto the plate
     ring and the top of the skirt and falls away toward the void. So the exposure is two poles now —
     `WALL.hullLit` at the deck line (the plate ring, its rim, bolts and seams, every skin's hshade lift, and the
     top of the skirt) fading to `WALL.hullVoid` at the skirt's foot — stepped per ramp stop, the same six hard
     bands the skirt always had (see fadeBands). Both are crtlab dials under WALL HEIGHT; the hull look-lock reads
     them back through HULL_EXPOSURE / hullRampExposure.
     THE DIAL, measured on the seeded hab down the middle of the south wall (base+light bake, luma): the flat 0.4
     skirt read top-3 rows 21 / upper body 11 / lower body 7 / foot 5 (mean 9.6) under a crown of ~120 and a lit
     deck of ~45. lit .70 / void .34 reads 33 / 15 / 8.5 / 4.6 (mean 12.8) — the top of the wall visibly catches
     the room's light and the foot stays as dark as it was. lit .62 / void .28 barely moved the body (13.9) and
     .76 / .38 (mean 13.7) was already drifting toward the flat 0.6 he called "not close"; the fade is what buys
     the brightness at the top without lifting the whole slab. */
  const hullLit = () => Math.max(0.05, Math.min(1.5, +WALL.hullLit || 0.4));
  const hullVoid = () => Math.max(0, Math.min(hullLit(), +WALL.hullVoid || 0));
  // a hull tone shaded at draw time: darkening as usual, but any LIFT is scaled by the exposure too, so a
  // skin's own highlights (mortar, crests, rivets) cannot climb back out of the dark the palette was put in
  const hshade = (hex, f) => U.shade(hex, f > 0 ? f * hullLit() : f);
  // a pure exposure step on a hex tone — every channel by one factor, hue untouched
  const scaleHex = (hex, k) => {
    const n = parseInt(hex.slice(1), 16);
    const c = v => Math.max(0, Math.min(255, Math.round(v * k)));
    return '#' + ((1 << 24) | (c((n >> 16) & 255) << 16) | (c((n >> 8) & 255) << 8) | c(n & 255)).toString(16).slice(1);
  };
  const exposeHex = hex => scaleHex(hex, hullLit());
  const expose = v => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) ? exposeHex(v)
    : Array.isArray(v) ? v.map(expose)
    : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expose(x)]))
    : v;
  const hullPalOf = (matId, raw) => {
    const r = HULL_RECIPES[matId];
    return expose((r && r.pal ? r.pal : derivedHullPal)(raw || STATION_TONE));
  };
  let hullPalCache = null;
  function hullPal(z) {
    let p = hullPalCache && hullPalCache.get(z);
    if (p) return p;
    p = hullPalOf(hullMatOf(z), (G && G.hullBaseOf) ? G.hullBaseOf(z) : null);
    if (!hullPalCache) hullPalCache = new Map();
    hullPalCache.set(z, p);
    return p;
  }
  // FALLBACK ONLY, exactly like wallMatOf: projected geometry always carries hullMatOf.
  // WorldModel.hullMatOfRoom is the authority — change both.
  const hullMatOf = z => {
    const m = (G && G.hullMatOf) ? G.hullMatOf(z) : null;
    return HULL_RECIPES[m] ? m : 'station';
  };
  // two footprints share a skirt only if they share a SKIN — see the group note in bakeHullExtrusion
  const hullKeyOf = z => { const p = hullPal(z); return hullMatOf(z) + '|' + p.base; };
  /* THE SHELL'S OWN EDGE, per room. Every site that used to reach for the module-level `wallDk`
     while painting something OUTSIDE a room now asks here instead. `wallDk` is still the wall's
     own dark step (it is a WALL tone) — what moved is the exterior band, which was never the
     wall's to paint. */
  const hullEdge = z => hullPal(z).edge;

  /* SKIRT BANDS. Each entry is [dy, colour]: the silhouette stamped `dy` px down-screen, painted in
     the order given. A stamp OWNS the rows between its own dy and the next (smaller) one, so a list
     descending from `skirt` to 1 paints the skirt bottom-up.

     BANDS ARE DEPTH, VEINS ARE MATERIAL — and that split is the second thing this file learned.
     The first cut emitted one band PER COURSE, so a log wall was 18 stamps and a brick wall 14. It
     was slow (every entry is a full-canvas silhouette composite, per group, per chunk) and, worse,
     it looked wrong: neighbouring stamps sit at neighbouring points on the same ramp, so the
     "shadow under a log" and the log above it came out ~0.1 apart in shade and the whole wall read
     as a flat brown band with faint lines in it. Rendered side by side, TIMBER and STUCCO were the
     same picture. A course line has to be a HARD local contrast — light crest, dark undercut —
     which the ramp fundamentally cannot express because the ramp's job is the opposite: a smooth
     fall into the void. So the ramp stays six stops and every material's texture moved to `veins`,
     one source-atop pass with real pixel control. Keep new materials on that side of the line. */
  const RAMP_T = [0, 0.12, 0.32, 0.55, 0.82, 1];
  const rampStops = skirt => [skirt, skirt - 1, Math.max(3, Math.round(skirt * 0.72)), Math.max(2, Math.round(skirt * 0.45)), 3, 1];
  // six stops from `lo` at the bottom of the wall to `hi` at the deck line
  const ramp6 = (pal, skirt, lo, hi) => rampStops(skirt).map((dy, i) => [dy, U.shade(pal.base, lo + (hi - lo) * RAMP_T[i])]);
  // the shell's own gradient — `station` keeps its six literal tones so the legacy look is exact
  const rampBands = (pal, skirt) => rampStops(skirt).map((dy, i) => [dy, pal.bands[i]]);
  /* THE FADE — the exposure read down the skirt. A stamp at dy owns the rows between its own dy and the next
     (smaller) one, so its light is read at the middle of that span: 0 at the deck line, 1 at the skirt's foot.
     The palette is already exposed at hullLit, so each band is scaled DOWN toward hullVoid — the top band is
     untouched and the plate ring above it never fades. Linear in depth: light spilling over an edge falls off
     evenly, and the ramp's own ladder already puts the hard steps where the eye reads them. Applied at both
     sites that stamp a band list (the bake and the REFIT chip) so the chip shows the wall it promises. */
  const hullFadeK = (mid, skirt) => {
    const lit = hullLit(), dark = hullVoid();
    const d = skirt > 0 ? Math.max(0, Math.min(1, mid / skirt)) : 0;
    return (dark + (lit - dark) * (1 - d)) / lit;
  };
  const bandMid = (bands, i, skirt) => (Math.min(bands[i][0], skirt) + (i + 1 < bands.length ? bands[i + 1][0] : 0)) / 2;
  const fadeBands = (bands, skirt) => bands.map(([dy, c], i) =>
    [dy, (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) ? scaleHex(c, hullFadeK(bandMid(bands, i, skirt), skirt)) : c]);
  // the six effective exposures down the ladder, foot first — what the hull look-lock scales its expected ramp by
  const hullRampExposure = skirt => { const st = rampStops(skirt).map(dy => [dy]); return st.map((_, i) => hullLit() * hullFadeK(bandMid(st, i, skirt), skirt)); };

  /* THE COURSED-WALL VEIN. Every masonry-ish shell is the same three decisions — how tall a course
     is, how wide a unit is, and whether the joint reads LIGHT (mortar between bricks) or DARK (the
     undercut below an overhanging board or shingle) — so they share one painter and differ only in
     those numbers. Getting BRICK and SHINGLE to stop looking like each other is exactly a matter of
     picking opposite answers: brick is a LIGHT grid, shingle is a DARK layered overhang.
     Everything is phase-locked to ABSOLUTE world coords (that is what vx/vy are for), so two
     adjacent buildings in the same skin share coursing, and a chunk bake lands identically to a
     monolithic one. */
  /* WALK THE WALL IN RUNS OF EQUAL HEIGHT. `topOf[x]` is the canvas row where this column's skirt
     begins (see skirtTops). Along a straight edge it is constant, so the whole wall is one rect;
     it only steps where the hull curves. Calling back per RUN rather than per column keeps a flat
     wall at a handful of fills while still letting a corner staircase down one pixel at a time. */
  /* `flat` is the wall top to assume when there is no geometry to follow — the headless canvas mock
     has no getImageData, and a palette chip has no hull at all.
     IT MUST BE WORLD-ANCHORED, NOT ZERO. Passing 0 anchors the courses to CANVAS row 0, and a chunk
     canvas starts at a different world row than the monolithic one, so the same wall came out with
     its coursing shifted between the two bake paths — 69738 pixels of chunk-parity failure the
     moment the default shell grew a texture. Callers pass `courseAt(vy, pitch) - vy`, which is the
     same absolute phase-lock the pre-contour code used. */
  const runsOf = (topOf, w, flat) => {
    if (!topOf) return [[0, w, flat || 0]];
    const out = [];
    let x0 = 0;
    while (x0 < w) {
      const t = topOf[x0];
      let x1 = x0 + 1;
      while (x1 < w && topOf[x1] === t) x1 += 1;
      if (t >= 0) out.push([x0, x1 - x0, t]);
      x0 = x1;
    }
    return out;
  };
  const wallRuns = (topOf, w, cb, flat) => { for (const r of runsOf(topOf, w, flat)) cb(r[0], r[1], r[2]); };

  /* ONE COURSE, DRAWN AS A CONNECTED CONTOUR OF THE WALL TOP.

     THE BRIDGE BETWEEN RUNS IS THE WHOLE THING (2026-08-05, Andrew, circling the bare strip at a
     corner: "do you see how it doesn't continue? it just cuts off at the corner. what I am looking
     for is perfect continuation with the proper curve"). Drawing a flat rect per run is the easy
     half and it is NOT a curve — it is a staircase of disconnected dashes, because between two runs
     the course jumps a row with nothing joining them. Filling that step with a one-pixel column is
     what turns the dashes into a line that sweeps round the arc.

     A previous pass tried to hide the staircase by simply not drawing courses on narrow runs. That
     is what left the bare vertical band Andrew circled — the cladding visibly quitting at the
     corner. There is no width below which a course should vanish; it just has to be CONNECTED.
     Runs that are not touching (`nx[0] !== rx + rw`) are a genuine gap in the wall — a doorway, a
     neighbouring footprint — and must NOT be bridged, or the line leaps across open space. */
  const courseLine = (px, runs, k, ch, off, thick) => {
    for (let i = 0; i < runs.length; i++) {
      const rx = runs[i][0], rw = runs[i][1];
      const y = runs[i][2] + k * ch + off;
      px(rx, y, rw, thick);
      const nx = runs[i + 1];
      if (!nx || nx[0] !== rx + rw) continue;
      const y2 = nx[2] + k * ch + off;
      const a = Math.min(y, y2), b = Math.max(y, y2);
      px(rx + rw - 1, a, 1, (b - a) + thick);
    }
  };

  /* THE SHARED PANEL JOINT — a faint vertical shadow every 28px, on EVERY shell, run after the
     material's own veins. It was the station shell's private detail; making it common is what ties
     the family together, because underneath the cladding it is all still one station, and a row of
     buildings that share one structural rhythm reads as a street rather than as swatches parked next
     to each other. Kept well under the material's own contrast so it never competes with the
     coursing — station keeps its original 0.35 (parity), everything else gets a whisper. */
  const SHARED_SEAM = 0.16;
  const panelSeam = (fg, w, h, vx, alpha) => {
    if (!alpha) return;
    fg.fillStyle = 'rgba(0,0,0,' + alpha + ')';
    for (let x = 5 - (vx % 28); x < w; x += 28) fg.fillRect(x, 0, 1, h);
  };

  const coursedVein = (fg, w, h, vx, vy, o, topOf) => {
    const px = boxed(fg, 0, 0, w, h);
    const bedH = o.bedH || 1, from = o.jointFrom || 0, run = o.ch - from - bedH;
    const rows = Math.ceil(h / o.ch) + 2;
    const runs = runsOf(topOf, w, courseAt(vy, o.ch) - vy);
    for (let k = 0; k < rows; k++) {
      if (o.crest) { fg.fillStyle = o.crest; courseLine(px, runs, k, o.ch, 0, 1); }
      if (o.bed) { fg.fillStyle = o.bed; courseLine(px, runs, k, o.ch, o.ch - bedH, bedH); }
      if (o.joint && o.uw > 1 && run > 0) {
        fg.fillStyle = o.joint;
        // the stagger is keyed on the course's index DOWN THE WALL, so it stays consistent around
        // a corner; the joint's x stays keyed on ABSOLUTE world coords, so two buildings in the
        // same skin still line up and a chunk bake lands identically to a monolithic one.
        const off = (k & 1) ? (o.uw >> 1) : 0;
        for (const r of runs) {
          const y = r[2] + k * o.ch + from;
          for (let wx = courseAt(vx + r[0] - off, o.uw) + off; wx < vx + r[0] + r[1]; wx += o.uw) px(wx - vx, y, 1, run);
        }
      }
    }
  };

  /* live-tunable CORNER PROFILE — the exponent of the superellipse every rounded corner in the
     station is cut from (see eachCornerRow, which is the ONE raster all of them share):

         n = 2    a quarter CIRCLE — a fillet. What shipped through 2026-08-07.
         n = 1    a straight 45° CHAMFER — a cut corner.
         n > 2    squarer, tending to a right angle as n → ∞.

     Why it became a knob. Every void-exposed room corner got the same 1-tile fillet, on all four
     corners, at one radius — and a rectangle whose four corners are identical arcs is the silhouette
     of a bathtub or a phone screen, not of something fabricated and bolted together. A chamfer is
     the shape a real panelled hull takes at a corner, and it costs nothing extra to raster: the
     crossing walk is already row-by-row, so only the CROSSING FUNCTION changes and every concentric
     layer keyed off it — hull silhouette erase, hull rim, ambient-mask cut, interior wall curve —
     follows automatically and stays concentric per-pixel.

     n === 2 keeps the ORIGINAL expression verbatim rather than the general form, so the shipped
     look is bit-identical and not merely algebraically equal (the general form differs in the last
     float bits, and these values go straight into Math.round — a 1px corner shift is exactly the
     kind of silent regression this file's whole raster discipline exists to prevent). */
  const SHAPE = { cornerN: 1 };   // 1 = 45° chamfer (2026-08-08) · 2 = the legacy circular fillet

  /* THE CORNER PROFILE LIVES HERE, AND NOWHERE ELSE (2026-08-13).
     `reach(rad, a)` is how far the corner's edge stands out from the centre line at distance `a`
     along it — the ONE crossing function the note above promises every concentric layer follows.
     It did not: `bakeCornerCrown` was a SECOND PAINTER drawing the same corner from its own
     hardcoded `sqrt(r² - a²)`, so the knob moved the deck cut and the hull rim while the crown ring
     and the inner boundary the wall face stops on both stayed circular. Between a chamfered deck cut
     and a circular face limit lies a lens of tile — widest at exactly 45°, tapering to nothing at
     both ends — that the deck cut had already filled with the room's HULL tone and nothing ever
     painted over. That is the black wedge Andrew circled at the bottom corners: "i cant stand how
     the edge of the shell is showing on the bottom left and right sides".
     Same law the lane that introduced the knob wrote down after the silhouette outline fooled it:
     ⛔ WHEN A SHAPE KNOB LOOKS INERT, FIND THE SECOND PAINTER DRAWING THAT EDGE FROM ITS OWN MATHS.
     n === 2 keeps the original sqrt verbatim — see the SHAPE note. */
  const cornerExp = () => Math.max(0.35, +SHAPE.cornerN || 2);
  const cornerReach = (rad, a) => {
    const n = cornerExp();
    return n === 2 ? Math.sqrt(rad * rad - a * a) : rad * Math.pow(1 - Math.pow(a / rad, n), 1 / n);
  };
  /* ...and its inverse question: which of the profile's nested outlines does (dx, dy) sit on? This
     is the radius for a circle and |dx| + |dy| for a 45° chamfer — the measure that makes "depth in
     from the edge" mean the same thing at 45° as it does on the straight run. */
  const cornerNorm = (dx, dy) => {
    const n = cornerExp(), adx = Math.abs(dx), ady = Math.abs(dy);
    return n === 2 ? Math.sqrt(dx * dx + dy * dy) : Math.pow(Math.pow(adx, n) + Math.pow(ady, n), 1 / n);
  };

  const CORNER = {
    tl: { cx: 1, cy: 1, a0: Math.PI, a1: 1.5 * Math.PI },
    tr: { cx: 0, cy: 1, a0: 1.5 * Math.PI, a1: 2 * Math.PI },
    bl: { cx: 1, cy: 0, a0: 0.5 * Math.PI, a1: Math.PI },
    br: { cx: 0, cy: 0, a0: 0, a1: 0.5 * Math.PI }
  };

  /* per-bake state (a bake runs synchronously start→finish, so module locals are safe) */
  const CHUNK_PX = 384;
  // walls reach outside the footprint — invalidate that far too. Takes the MAX of both rises: it
  // read WALL.up only, which was safe purely because corUp happened to be smaller. That is a
  // coincidence, not an invariant, and a crtlab preset can invert it in one slider drag (the
  // shipped 'Towering' preset sets corUp 15) — a corUp above up would then under-invalidate on a
  // chunk bake and leave a stale strip of wall behind.
  const dirtyPadPx = () => pad + Math.max(WALL.skirt, Math.max(WALL.up, WALL.corUp) + WALL.capH + 8) + 48;
  let G, T, HR, W, H, VX, VY, CW, CH, lampPos, edges, chamferAt, extN, openJoins;
  const h2 = (x, y, s) => U.hash(x + ',' + y + ',' + (s || ''));

  /* ---------- THE ONE ROUNDED-CORNER RASTER ----------
     Every curve in the station is a quarter circle at a tile corner, and they must all agree to the
     pixel or the corner reads as misaligned. This is the single source: walk the corner's pixel
     ROWS and hand back the integer x at which the curve crosses. A quarter circle crosses each row
     exactly once, so the walk is complete and gap-free — no fractional rects, no stroked arcs, no
     anti-aliasing against the deck's hard pixels. Sampling at the row's CENTRE (py + 0.5) and
     rounding is the shared convention: the hull silhouette erase, the hull rim, the ambient-mask
     cut and the room's interior curve all use it, so concentric curves stay concentric per-pixel.
     Keyed on bake-pixel coords, so chunk↔monolithic parity holds. */
  function eachCornerRow(kind, ax, ay, rad, fn) {
    const A = CORNER[kind];
    const ox = Math.round(A.cx ? ax - rad : ax), oy = Math.round(A.cy ? ay - rad : ay);
    const r = Math.round(rad);
    // how far the profile reaches out from the corner's centre line at vertical distance `ady` —
    // the shared crossing function, so this walk and bakeCornerCrown's cannot drift apart again.
    const reach = (ady) => cornerReach(r, ady);
    for (let py = oy; py < oy + r; py++) {
      const ady = Math.abs(py + 0.5 - ay);
      const ex = ady >= r ? null : (A.cx ? Math.round(ax - reach(ady))
                                         : Math.round(ax + reach(ady)));
      fn(py, ex, ox, ox + r, A);
    }
  }
  /* cut the hull's rounded corner. Was a clip('evenodd') + fill, which anti-aliased the station's
     whole silhouette — the soft outer fuzz that survived the interior-curve fix. */
  function eraseSpandrel(g, kind, ax, ay, rad) {
    g.save();
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    eachCornerRow(kind, ax, ay, rad, (py, ex, ox, oxEnd, A) => {
      if (ex == null) { g.fillRect(ox, py, oxEnd - ox, 1); return; }        // row wholly outside the disc
      if (A.cx) { if (ex > ox) g.fillRect(ox, py, ex - ox, 1); }
      else if (ex + 1 < oxEnd) g.fillRect(ex + 1, py, oxEnd - ex - 1, 1);
    });
    g.restore();
  }
  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }
  function translatedContext(c) {
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.translate(-VX, -VY);
    return g;
  }

  /* ---------- A THRESHOLD IS A HOLE IN A WALL ----------
     Andrew 2026-08-05, drawing a red line down two abutting rooms AND across a hallway mouth: "when
     you place multiple rooms, or a hallway, the floors do appear to not blend properly. there is
     always a border that shows."

     That border is a contract drift, not a taste problem. `bakeThreshold` paints a recessed metal
     track plus a lit lip across every edge flagged `door` — correct for a DOORWAY, and written when
     a door was a hand-placed opening in a wall. The foundation then made doors AUTOMATIC: worldmodel
     opens a threshold at EVERY orthogonally adjacent tile pair of two different zones, so `door`
     quietly came to mean "the whole shared boundary". Two HAB rooms pushed together — same kind,
     same hue, same deck material, one continuous room to the eye — got a 4px bar of #3a352c painted
     down the entire join, measured at 98 luma against a 48-luma deck. Twice the brightness of the
     floor it divides. That bar IS the border he circled, and the deck's pale door guide ticks ran
     the same full length underneath it for the same reason.

     The distinction the bake was missing is architectural: a doorway is a GAP IN A WALL. If the
     seam LINE an opening sits on carries wall on BOTH sides of the gap, you are looking through a
     doorway and the sill belongs there (a 3-tile hallway mouth punched through a room's south wall
     keeps its threshold exactly as before). If the line simply runs out at both ends — nothing but
     void past the opening — there is no wall for it to be a hole in, and the two decks are one
     floor: paint nothing and let them meet.

     Classified once per bake straight off the zone grid, keyed on world tile coords so a chunked
     bake and a monolithic bake can never disagree. */
  // 0 = the seam line has run out here (void/void, or the same zone on both sides — no seam at all)
  // 1 = an OPEN seam (two zones, passable)   2 = WALL (one side void, or a sealed seam)
  function seamClass(g, ax, ay, bx, by) {
    const idx = g.idx, COLS = g.COLS, ROWS = g.ROWS, zg = g.zoneGrid;
    const at = (x, y) => (x < 0 || y < 0 || x >= COLS || y >= ROWS) ? null : zg[idx(x, y)];
    const za = at(ax, ay), zb = at(bx, by);
    if (za === zb) return 0;                                   // covers void/void and interior alike
    if (za == null || zb == null) return 2;
    return (g.canStep(ax, ay, bx, by) || g.canStep(bx, by, ax, ay)) ? 1 : 2;
  }
  /* ---- and a doorway is a MINORITY OF THE WALL IT PIERCES ----
     "Capped by wall at both ends" alone is NOT the definition, and shipping it that way put the
     border straight back (Andrew, 2026-08-05, red circle round the seam in his own station: "this
     does not look blended in the slightest"). His geometry is why:

         r1  HAB       x0..17, y0..10
         r8  CORRIDOR  x3..4,  y11..18
         r9  HAB       x5..16, y11..18

     The seam under r1 is one contiguous OPEN run x3..16 — the corridor and the room below are
     side by side, so nothing breaks it — and it happens to be capped by 3 tiles of wall at x0..2
     and 1 tile at x17. Both ends walled, so the cap test alone called a FOURTEEN-tile opening a
     doorway and dressed every tile of it. That is a room's whole face, not a door.

     The missing half is scale, and it needs no magic number: an opening is a doorway when it is
     SHORTER THAN THE WALL IT INTERRUPTS. 14 tiles of gap against 4 of wall is not a hole in a wall,
     it is two rooms that meet. 3 tiles of hallway mouth against 10 of a room's south wall is.
     Measured off the seam line itself, so it scales with the station and never needs tuning. */
  const wallRunFrom = (seg, from, d, lo, hi) => { let n = 0; for (let c = from; c >= lo && c <= hi; c += d) { if (seg(c) !== 2) break; n++; } return n; };

  /* every open seam that is NOT a doorway, as 'x,y,side' for the tile on each side of it. Runs are
     walked whole — doorway-ness is a property of the RUN, not of one tile in it, so a 14-tile join
     resolves once and identically for all 14. */
  function classifyJoins(g) {
    const open = new Set(), COLS = g.COLS, ROWS = g.ROWS;
    const doorway = (seg, a, b, hi) => {
      const wLo = wallRunFrom(seg, a - 1, -1, 0, hi), wHi = wallRunFrom(seg, b + 1, 1, 0, hi);
      return wLo > 0 && wHi > 0 && (b - a + 1) < wLo + wHi;   // jambs on both sides, and narrower than them
    };
    for (let y = 1; y < ROWS; y++) {                                    // horizontal seams: row y-1 | row y
      const seg = c => seamClass(g, c, y - 1, c, y);
      for (let x = 0; x < COLS; x++) {
        if (seg(x) !== 1) continue;
        let x2 = x; while (x2 + 1 < COLS && seg(x2 + 1) === 1) x2++;
        if (!doorway(seg, x, x2, COLS - 1)) {
          for (let c = x; c <= x2; c++) { open.add(c + ',' + (y - 1) + ',s'); open.add(c + ',' + y + ',n'); }
        }
        x = x2;
      }
    }
    for (let x = 1; x < COLS; x++) {                                    // vertical seams: col x-1 | col x
      const seg = c => seamClass(g, x - 1, c, x, c);
      for (let y = 0; y < ROWS; y++) {
        if (seg(y) !== 1) continue;
        let y2 = y; while (y2 + 1 < ROWS && seg(y2 + 1) === 1) y2++;
        if (!doorway(seg, y, y2, ROWS - 1)) {
          for (let c = y; c <= y2; c++) { open.add((x - 1) + ',' + c + ',e'); open.add(x + ',' + c + ',w'); }
        }
        y = y2;
      }
    }
    return open;
  }
  const isOpenJoin = (x, y, side) => openJoins.has(x + ',' + y + ',' + side);
  /* the same question asked of a `doorDefs` pair, for the two LIGHT passes that walk it. worldmodel
     emits every pair +x/+y ordered, so the owning tile is always the first one. Both passes exist to
     make a DOORWAY read (a gloss dab on the sill, a spill so the spaces past it look connected); run
     down an open join they became a chain of dabs and a bright ambient trough tracing the boundary —
     the same border, drawn in light instead of paint. Two rooms open to each other need no help
     reading as connected: they already are. */
  /* ---- and a sill only belongs where the FLOOR CHANGES (Andrew 2026-08-10) ----
     Three red circles on his own station, all on threshold dressing: two real corridor mouths and a
     5-tile room|room join the minority rule had called a doorway (5 tiles of opening against a
     6-tile jamb — walled both ends, "shorter than the wall", dressed end to end). Every floor in
     that station is the same walnut plank, so to the eye there is ONE deck and every mark on it is
     a separation line. The architectural test (a doorway is a hole in a wall) answers where an
     opening IS; it cannot answer whether the floor through it needs a threshold. That is a property
     of the two DECKS: a transition strip belongs where the surface changes — walnut meeting sterile
     tile — and is exactly the line Andrew keeps circling when the same deck continues through.
     So all four dressing passes (track+lip, guide ticks, sheen dab, door light cut) now also skip
     any doorway whose two sides bake the identical deck — same material, same base colour at the
     facing tiles (floorPaint overrides included). Different decks keep their sill: the material
     change already draws a boundary there, and the threshold explains it. */
  const deckContinues = (x1, y1, x2, y2) => {
    const z1 = G.zoneGrid[G.idx(x1, y1)], z2 = G.zoneGrid[G.idx(x2, y2)];
    if (z1 == null || z2 == null) return false;
    return matOf(z1) === matOf(z2) && G.baseColorOf(z1, x1, y1) === G.baseColorOf(z2, x2, y2);
  };
  const pairIsSill = (x1, y1, x2, y2) => !isOpenJoin(x1, y1, x2 > x1 ? 'e' : 's') && !deckContinues(x1, y1, x2, y2);

  /* derive the wall edges from the zone grid (generalizes world.js's single-room IIFE).
     a boundary edge is where a zone tile faces a different/void neighbour; chamfer tiles
     are skipped (the curved pass handles them); door adjacencies become threshold edges. */
  function buildEdges() {
    edges = [];
    const G_ = G, idx = G.idx, COLS = G.COLS, ROWS = G.ROWS, zg = G.zoneGrid;
    const dirs = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };
    openJoins = classifyJoins(G);
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const z = zg[idx(x, y)];
      if (z == null) continue;
      if (chamferAt[x + ',' + y]) continue;
      const room = !G_.isCorridor(z);
      for (const side in dirs) {
        const [dx, dy] = dirs[side];
        const nx = x + dx, ny = y + dy;
        const nz = (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) ? null : zg[idx(nx, ny)];
        if (nz === z) continue;                       // interior — no edge
        const door = nz != null && (G_.canStep(x, y, nx, ny) || G_.canStep(nx, ny, x, y));
        // open = passable AND not a doorway: the decks simply continue, so NOTHING is painted here
        edges.push({ x, y, z, side, room, door, open: door && isOpenJoin(x, y, side), exterior: nz == null });   // z = the zone this wall belongs to (its room owns the wall palette)
        if (side === 'n' && nz == null) extN.add(x + ',' + y);   // tiles with a TALL north face (lamp fixtures mount on it)
      }
    }
  }

  /* ---------- floor passes (per-tile base colour → paint tool just works) ----------

     V2 FLOOR MATERIALS. The deck is the biggest surface on screen, so it carries a real
     material vocabulary instead of the old uniform 1-tile grid. The two axes are separate
     by contract: room KIND picks the material RECIPE, the per-tile base colour (floor style
     + deck paint overrides) stays the HUE — every mark below derives from THIS tile's own
     base via U.shade, so a painted tile renders its material in its painted colour. All
     marks are keyed on world tile coords (chunk↔monolithic parity) and painted as opaque
     hard-stepped pixels (the station idiom; headless-mock safe). Recipes:
       plate (HAB/default)     — 2×2 deck plates: shared per-plate tone, dark seam + catch-
                                 light, corner rivets, brushed hairline grain.
       panel (BRIDGE)          — long 4×1 panel strips with longitudinal grain, no rivets:
                                 a finished command-deck read.
       tile  (LAB)             — clean 2×2 gloss checker on dark grout, sparse specular
                                 ticks, no grime/stains.
       tread (FOUNDRY/STORAGE) — heavy plate + stamped tread ticks, weld lines, rivets.
       soft  (QUARTERS)        — wide 3×2 low-contrast plates with warm matted lifts.
     Every room also gets a PERIMETER TRIM COURSE (a darker border course where floor meets
     wall, catch-lit on its room-facing edge) and pale guide ticks across door thresholds.
     DEPTH.floorDetail scales every delta the material draws; DEPTH.floorWear rides on top.

     V4 adds four decks that deliberately DON'T read as the old station — the material axis is
     user-chosen now (WorldModel.FLOOR_MATERIALS → REFIT ▧ SURFACE), not just a per-kind default:
       grate — open catwalk mesh: top-lit bars over a dark void, substructure glimpsed below.
       hex   — honeycomb cells on an offset lattice: advanced-tech, nothing else here is non-rectilinear.
       plank — staggered wood boards: per-board tone, grain hairlines, occasional knot.
       turf  — hydroponic growth: pure blade scatter, NO lattice at all. The absence of a grid
               is the whole point; it is what separates a grown surface from a built one.

     V5 replaces `plate` as the HAB default with `spine` (see the note above deckSpine). `plate` is
     NOT deleted — it stays in the palette as the classic, so a station that preferred the old deck
     can still choose it, and no existing station loses a look it was built with. Every room carries
     `floorMat: null` (inherit), so the swap reaches stations built before it existed — which is the
     point: the default deck is the one surface every player sees and it had aged. */
  // FALLBACK ONLY — projected geometry always carries matOf, so this map is not what you see in
  // game. WorldModel.ROOM_KINDS[kind].mat is the authority; keep the two in step.
  const MAT_BY_KIND = { hab: 'spine', corridor: 'spine', bridge: 'panel', lab: 'tile', factory: 'tread', storage: 'tread', quarters: 'soft' };
  const MAT_PITCH = { alloy: [4, 3], plate: [2, 2], panel: [4, 1], tile: [2, 2], tread: [2, 2], soft: [3, 2], grate: [1, 1], hex: [1, 1], plank: [5, 1], turf: [1, 1], spine: [4, 3], diamond: [1, 1], resin: [4, 4], ceramic: [3, 3], cargo: [3, 2], runner: [2, 2], treadway: [3, 2], meshway: [3, 3] };
  const MAT_NO_WEAR = { tile: 1, grate: 1, turf: 1, ceramic: 1, resin: 1 };   // gloss, open mesh, growth, and a poured or glazed floor take no boot scuffs   // gloss, open mesh and growth don't take boot scuffs
  // the room's deck material — the model's per-room choice when it has one, else the kind default
  // (a station built before the material axis existed has none, and bakes exactly as it always did).
  const matOf = z => {
    const m = G.matOf ? G.matOf(z) : null;
    return (m && MAT_PITCH[m]) ? m : (MAT_BY_KIND[(G.kindOf && G.kindOf(z)) || 'hab'] || 'plate');
  };
  /* cheap deterministic per-PIXEL hash. h2 hashes a string, which is fine at ~5 marks per tile but
     not at the ~25 turf needs. Keyed on bake-pixel coords (the same space the Bayer dither uses),
     so a pixel resolves identically no matter which chunk viewport bakes it. */
  /* VIVID LIGHTEN — for the GROWTH materials only (turf, hedge).
     U.shade lerps toward WHITE, so every lightening step desaturates: fern lightened by +0.4 goes
     from saturation 0.43 to 0.11 — a grass blade lifted far enough to read as a highlight stops
     being green and turns silver. That is why capping the lift only made the lawn duller instead of
     greener (Andrew 2026-07-25: "grass is too white, I want Terraria grass").
     This pushes the colour's DOMINANT channel hard and the others barely, so the ramp gains
     lightness while GAINING saturation. Every built surface keeps U.shade — plating should wash
     toward the light. Growth must not. Negative f falls through to U.shade: darkening toward black
     already preserves hue. */
  const vivid = (hex, f) => {
    if (f <= 0) return shade(hex, f);
    const n = parseInt(String(hex).slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const mx = Math.max(r, g, b) || 1;
    const lift = c => { const s = c / mx; return Math.min(255, c + (255 - c) * f * s * s); };
    return '#' + ((1 << 24) | (Math.round(lift(r)) << 16) | (Math.round(lift(g)) << 8) | Math.round(lift(b))).toString(16).slice(1);
  };

  const hp = (a, c, k) => {
    let n = (Math.imul(a | 0, 374761393) + Math.imul(c | 0, 668265263) + Math.imul(k | 0, 1442695041)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return (n ^ (n >>> 16)) >>> 0;
  };

  /* ---------- per-tile deck painters — one per material ----------
     Each paints ONE tile in that tile's own base colour. bakeDeck AND the REFIT palette
     sampler both go through paintDeck, so the swatch a Commander clicks is drawn by the exact
     code that bakes the station — a deck preview here can never drift from the deck they get. */

  /* ================= THE DECK CRAFT HELPERS (2026-09-03 polish pass) =================
     Same three moves the SPINE deck was rebuilt on, factored for every other recipe:
       plateGrade — a slow diagonal light across a WHOLE plate (lit at its north-west corner, falling to
         the south-east), quantized to four hard steps. It reads at plate scale rather than tile scale,
         which is the difference between a surface and a swatch, and it costs no extra marks.
       deckBolt   — hardware with four parts: countersunk well, domed head lit north-west, the shadow it
         casts, and a pin. Every deck here was drawing 2px squares.
     Both take the tile's local plate coords so a plate spanning several tiles grades continuously. */
  function plateGrade(b, base, X, Y, lx, ly, PW, PH, body, fd) {
    const k = Math.max(0, fd);
    if (k <= 0.001) return;
    const span = PW * T + PH * T;
    for (let j = 0; j < T; j += 2) for (let i = 0; i < T; i += 2) {
      const u = ((lx * T + i) + (ly * T + j)) / span;
      const step = Math.round((0.5 - u) * 3) / 3;
      if (step) { b.fillStyle = shade(base, (body + step * 0.026) * k); b.fillRect(X + i, Y + j, 2, 2); }
    }
  }
  function deckBolt(b, base, bx, by, body, fd) {
    const sh = d => shade(base, (body + d) * Math.max(0, fd));
    b.fillStyle = sh(-0.28); b.fillRect(bx - 1, by - 1, 5, 5);
    b.fillStyle = sh(0.12); b.fillRect(bx, by, 3, 3);
    b.fillStyle = sh(0.32); b.fillRect(bx, by, 2, 1); b.fillRect(bx, by, 1, 2);
    b.fillStyle = sh(-0.32); b.fillRect(bx + 2, by + 1, 1, 2); b.fillRect(bx + 1, by + 2, 2, 1);
    b.fillStyle = sh(-0.14); b.fillRect(bx + 1, by + 1, 1, 1);
  }

  function deckSlab(b, mat, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => shade(base, d * fd);
    const PW = MAT_PITCH[mat][0], PH = MAT_PITCH[mat][1];
    px(X, Y, T, T, base);
    // V3 SLAB TILES — the tile texture itself is dimensional now, not a flat fill with
    // lines drawn on it: each plate renders as a slab — dark GROUT at the plate boundary,
    // a lit BEVEL along the slab's top/left, a shaded bevel along its bottom/right, and a
    // 2-step body shade down the slab (upper course a hair lighter). The dimension comes
    // from edge placement, not contrast, so the deck stays a quiet background surface.
    const pxc = Math.floor(x / PW), pyc = Math.floor(y / PH);
    /* Per-plate tone is keyed on WORLD plate coords only, never the zone id. The lattice already
       continues across a zone join (pxc/pyc are world-anchored); keying the tone on z re-rolled it
       at the boundary, so a plate straddling two same-deck rooms changed tone exactly on the seam —
       a full-length aligned step the eye reads as a border even at ±0.03. Same rule in every deck
       painter below. */
    const pn = h2(pxc, pyc, ':pl');
    const lx = x % PW, ly = y % PH;
    const checker = mat === 'tile' ? ((pxc + pyc) % 2 ? 0.022 : -0.016) : 0;
    const body = ((pn % 5) - 2) * 0.014 + checker;
    const step = PH > 1 ? (ly === 0 ? 0.016 : -0.012) : 0;   // slab body: light upper course → dark lower
    px(X, Y, T, T, sh(body + step));
    plateGrade(b, base, X, Y, lx, ly, PW, PH, body + step, fd);   // the plate's own diagonal light
    // the plate JOINT rides DEPTH.deckSeam — see the knob's note. The body tone above is NOT scaled
    // by it, so softening the seam blends the plates together without flattening the deck.
    const sk = Math.max(0, DEPTH.deckSeam);
    // the joint is a two-step bevel ladder now (the SPINE polish): dark channel, lit lip inside it
    if (lx === 0) { px(X, Y, 1, T, sh(-0.40 * sk)); px(X + 1, Y, 1, T, sh(body + 0.16 * sk)); px(X + 2, Y, 1, T, sh(body + 0.05 * sk)); }
    if (ly === 0) { px(X, Y, T, 1, sh(-0.40 * sk)); px(X, Y + 1, T, 1, sh(body + 0.16 * sk)); px(X, Y + 2, T, 1, sh(body + 0.05 * sk)); }
    if (lx === PW - 1) { px(X + T - 1, Y, 1, T, sh(body - 0.22 * sk)); px(X + T - 2, Y, 1, T, sh(body - 0.08 * sk)); }
    if (ly === PH - 1) { px(X, Y + T - 1, T, 1, sh(body - 0.22 * sk)); px(X, Y + T - 2, T, 1, sh(body - 0.08 * sk)); }
    // material dressing — rivets on alternating plate joints only
    if ((mat === 'plate' || mat === 'tread') && lx === 0 && ly === 0 && (pxc + pyc) % 2 === 0) {
      // ONE bolt, inside this tile only: a painter may never paint outside its own tile (the plate's
      // other fixings belong to the tiles that own those corners) — locked by stationbake.materials.test.js
      deckBolt(b, base, X + 4, Y + 4, body, fd);
    }
    if (mat === 'tread') {
      if (n % 2 === 0) {                                           // stamped tread ticks on half the tiles
        px(X + 2 + (n % 3), Y + 4, 3, 1, sh(-0.14));
        px(X + 5 + (n % 3), Y + 8, 3, 1, sh(-0.14));
      }
      if (y % (PH * 3) === 0) px(X, Y, T, 1, sh(-0.35));           // weld line every 3rd plate row
    } else if (mat === 'tile' && pn % 7 === 0) {
      px(X + T - 5, Y + 2, 2, 1, sh(0.20));                        // specular tick on a gloss tile
    } else if (mat === 'soft' && pn % 3 === 0) {
      px(X + 1, Y + 1, T - 2, T - 2, sh(0.035));                   // warm matted lift on some plates
    }
    // sparse one-off features (v1 survivors, now material-aware: labs/bridge stay clean)
    if (mat === 'plate' || mat === 'tread' || mat === 'soft') {
      if (n % 19 === 3 && mat !== 'soft') {
        px(X + 2, Y + 2, T - 4, T - 4, sh(-0.25));                 // recessed vent hatch
        for (let i = 0; i < 3; i++) px(X + 3, Y + 4 + i * 3, T - 6, 1, sh(-0.5));
      } else if (n % 23 === 5) {
        px(X + 2, Y + 2, T - 4, T - 4, sh(-0.12));                 // access panel
        b.strokeStyle = sh(-0.4); b.lineWidth = 1; b.strokeRect(X + 2.5, Y + 2.5, T - 5, T - 5);
        px(X + T / 2 - 2, Y + T / 2, 4, 1, sh(-0.5));
      } else if (n % 31 === 7) {
        b.fillStyle = 'rgba(0,0,0,' + (0.13 * fd).toFixed(3) + ')';                // old oil stain
        b.beginPath(); b.ellipse(X + (n % 8), Y + (n % 6) + 3, 5, 3, 0, 0, 7); b.fill();
      }
    }
  }

  /* GRATE — open catwalk mesh. A 4px lattice of top-lit bars over a dark void, so the read comes
     from the HOLES: this is the one deck that sits darker than its own base. Heavier structural
     beams every third tile keep long runs from turning into flat noise. */
  function deckGrate(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => shade(base, d * fd);
    px(X, Y, T, T, base);
    px(X, Y, T, T, sh(-0.50));                                        // the void between the bars
    if (n % 3 === 0) px(X, Y + 4 + (n % 5), T, 1, sh(-0.34));          // a strut on the deck far below
    for (let i = 0; i < T; i += 4) { px(X + i, Y, 2, T, sh(-0.04)); px(X + i, Y, 1, T, sh(0.09)); }   // vertical bars + lit west edge
    for (let j = 0; j < T; j += 4) { px(X, Y + j, T, 2, sh(0.02)); px(X, Y + j, T, 1, sh(0.15)); }    // horizontals woven over + lit north edge
    if (x % 3 === 0) { px(X, Y, 2, T, sh(-0.18)); px(X, Y, 1, T, sh(0.05)); }   // structural beam
    if (y % 3 === 0) { px(X, Y, T, 2, sh(-0.14)); px(X, Y, T, 1, sh(0.11)); }
  }

  /* HEX — honeycomb. Two 12×6 cells per tile on a half-cell-offset lattice: flat top and bottom,
     diagonal shoulders, short side walls. Everything else on the station is rectilinear, so the
     non-square lattice alone is what makes this read as a different technology. */
  /* HEX polished 2026-09-03: each cell takes a lit north-west arc and a shaded south-east one, so the
     honeycomb reads as embossed rather than drawn. */
  function deckHex(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => shade(base, d * fd);
    px(X, Y, T, T, base);
    for (let row = 0; row < 2; row++) {
      const cy = Y + row * 6, off = row ? 6 : 0, cx = X + off - (off ? 12 : 0);
      // two passes so the offset row's half-cells at both tile edges are drawn
      for (let c = 0; c < (off ? 2 : 1); c++) {
        const ox0 = cx + c * 12;
        const cn = h2(Math.floor((ox0 - X) / 12) + x * 2, y * 2 + row, ':hx');
        const body = ((cn % 5) - 2) * 0.016;
        px(Math.max(X, ox0 + 2), cy + 1, Math.min(8, X + T - Math.max(X, ox0 + 2)), 4, sh(body));   // cell body
        px(Math.max(X, ox0 + 2), cy, Math.min(8, X + T - Math.max(X, ox0 + 2)), 1, sh(-0.30));      // flat top grout
        px(Math.max(X, ox0 + 2), cy + 1, Math.min(8, X + T - Math.max(X, ox0 + 2)), 1, sh(body + 0.11));  // catch-light under it
        // diagonal shoulders + side walls (clipped to the tile by the guards)
        const dot = (dx, dy, col) => { const ax = ox0 + dx; if (ax >= X && ax < X + T) px(ax, cy + dy, 1, 1, col); };
        dot(1, 1, sh(-0.30)); dot(10, 1, sh(-0.30));
        dot(0, 2, sh(-0.30)); dot(11, 2, sh(-0.30));
        dot(0, 3, sh(-0.26)); dot(11, 3, sh(-0.26));
        dot(1, 4, sh(-0.22)); dot(10, 4, sh(-0.22));
        px(Math.max(X, ox0 + 2), cy + 5, Math.min(8, X + T - Math.max(X, ox0 + 2)), 1, sh(body - 0.16));  // shaded flat bottom
      }
    }
  }

  /* PLANK — laid wood boards, 5 tiles long and one tile deep, staggered every third row so end
     seams never line up (the tell of real flooring). Per-board tone, grain hairlines along the
     run, and the occasional knot. Warm, and the only deck that reads as CARPENTRY. */
  function deckPlank(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => shade(base, d * fd);
    const PWp = MAT_PITCH.plank[0];
    const stagger = (y % 3) * 2;
    const rel = ((x - stagger) % PWp + PWp) % PWp;              // safe mod: x-stagger can go negative
    const pn = h2(Math.floor((x - stagger) / PWp), y, ':pk');
    const body = ((pn % 7) - 3) * 0.045;                         // per-BOARD tone (whole board, not per tile)
    const sk = Math.max(0, DEPTH.deckSeam);                      // board joints ride the same knob
    px(X, Y, T, T, base);
    px(X, Y, T, T, sh(body));
    /* THE BOARD'S OWN LIGHT — a board is not flat: it crowns slightly, so the light falls off toward
       both edges. Three steps down its 12px width reads as a milled board rather than a stripe. */
    px(X, Y + 2, T, 5, sh(body + 0.035));
    px(X, Y + 7, T, 3, sh(body - 0.030));
    px(X, Y, T, 1, sh(body + 0.20 * sk));                        // lit top edge of the board
    px(X, Y + 1, T, 1, sh(body + 0.08 * sk));                    // its falloff
    px(X, Y + T - 2, T, 1, sh(body - 0.14 * sk));                // shadow into the gap
    px(X, Y + T - 1, T, 1, sh(body - 0.55 * sk));                // the gap between boards
    if (rel === 0) { px(X, Y, 1, T, sh(body - 0.50 * sk)); px(X + 1, Y, 1, T, sh(body + 0.10 * sk)); }   // butt-end seam
    px(X, Y + 3 + (n % 3), T, 1, sh(body - 0.10));               // grain hairlines running with the board
    px(X, Y + 7 + (n % 3), T, 1, sh(body - 0.08));
    if (n % 3 === 0) px(X, Y + 5, T, 1, sh(body + 0.05));
    if (n % 17 === 4) {                                          // knot — a dark eye with the grain bending round it
      const kx = X + 3 + (n % 4);
      px(kx, Y + 4, 4, 3, sh(body - 0.30));
      px(kx + 1, Y + 5, 2, 1, sh(body - 0.46));
      px(kx - 1, Y + 3, 6, 1, sh(body - 0.10)); px(kx - 1, Y + 7, 6, 1, sh(body - 0.10));
      px(kx, Y + 4, 1, 1, sh(body + 0.10));
    } else if (n % 23 === 7) {                                   // a countersunk floor screw in the board
      px(X + 5, Y + 5, 3, 3, sh(body - 0.24)); px(X + 6, Y + 6, 1, 1, sh(body + 0.16));
    }
  }

  /* TURF — hydroponic growth. Pure blade scatter with low-frequency clumping and NO lattice of any
     kind: no grout, no bevels, no seams. That absence is the entire design — every other deck here
     is a built surface, and the only way to read "grown" at 12px is to remove the grid. */
  function deckTurf(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => shade(base, d * fd);
    const clump = h2(x >> 1, y >> 1, ':cl');                 // 2×2-tile patches read denser/sparser
    const cl = ((clump % 5) - 2) * 0.018;
    /* v3 (2026-07-25, matched against a real grass reference). v2 gave every blade an INDEPENDENT
       random tone off a 5-step ramp, and that is the whole reason it read as static rather than as
       grass: with no correlation between neighbours, no pixel belongs to the pixel beside it, so the
       eye finds noise where it wants tufts. Real grass is CLUMPED — a patch of blades catches the
       light together, and the gaps between patches fall into shadow together.
       So tone is no longer random per blade. It comes from a two-octave value FIELD sampled on
       ABSOLUTE bake-pixel coords: a coarse octave (~8px) that mottles the lawn at tuft scale, and a
       mid octave (~3px) that breaks each tuft into strands. Neighbouring pixels sample almost the
       same field value, so they share a tone and read as one clump — and because the field is keyed
       on absolute coords rather than position-in-tile, tufts continue straight across tile borders
       and chunk↔monolithic parity still holds. */
    /* SHEARED cells. Sampling the field on plain axis-aligned blocks made the lawn a quilt of
       squares — the clumps were the right size but the wrong SHAPE, because every cell boundary
       lined up with its neighbours in both axes. Offsetting x by a function of y staggers the
       boundaries so clump edges break up and stop reading as a grid. */
    const oct = (ax, ay, size, salt) => {                        // -1..1, constant within a sheared cell
      const sx = ax + Math.floor(ay / size) * ((size >> 1) + 1);
      const r = hp(Math.floor(sx / size) * size, Math.floor(ay / size) * size, salt);
      return ((r % 7) - 3) / 3;
    };
    /* Every lift goes through vivid(), never U.shade — U.shade lerps toward WHITE, so the brightest
       blades come out the greyest pixels on the deck ("the grass is too white"). The value range is
       deliberately TIGHT: a dark understory under bright blades reads as confetti. Saturation does
       the separating, not value. */
    /* AMPLITUDE IS LOW ON PURPOSE (±0.13, not ±0.20). At the wider spread the lawn read as
       camouflage blotches: the clumps were legible but they no longer belonged to one surface. The
       reference is a cohesive mid-olive field whose tufts are a STEP off each other, and a mid-tone
       has to dominate for the whole thing to read as one lawn. */
    px(X, Y, T, T, vivid(base, (cl + 0.06) * fd));               // the MAT — a cohesive field, not a void
    for (let cy = 0; cy < T; cy += 2) for (let cx = 0; cx < T; cx += 2) {
      const ax = X + cx, ay = Y + cy;
      const v = 0.56 * oct(ax, ay, 6, 'g1') + 0.44 * oct(ax, ay, 2, 'g2');   // 6px tufts, 2px strands
      const tone = cl + 0.10 + 0.13 * v;
      px(ax, ay, 2, 2, vivid(base, tone * fd));                  // tuft body: 2×2 so a clump has area
      const r = hp(ax, ay, 7);
      // strands ON the tuft, one step off ITS OWN tone (not off a global ramp) so a blade always
      // belongs to the clump it sits in. Mixed orientation — grass is matted, not a picket fence.
      const bx = cx + (r & 1), by = cy + ((r >>> 2) & 1);
      if (by < T && (r >>> 4) % 7 !== 0) {                       // denser than v2: strands are the texture
        const lit = vivid(base, (tone + 0.10) * fd);
        if (((r >>> 7) & 3) === 0) px(X + bx, Y + by, Math.min(2, T - bx), 1, lit);  // lying flat
        else px(X + bx, Y + by, 1, Math.min(2 + ((r >>> 9) & 1), T - by), lit);      // standing
      }
      if (v < -0.62) px(X + bx, Y + by, 1, 1, vivid(base, (cl - 0.09) * fd));   // shadow deep in a gap
    }
    for (let i = 0; i < 2; i++) {                                // taller blades breaking the canopy
      const r = hp(X, Y, 90 + i);
      const by = (r >>> 6) % (T - 3);
      px(X + (r % T), Y + by, 1, 4, vivid(base, (cl + 0.26) * fd));
    }
    /* DRY BLADES — the one legitimate U.shade LIFT on this deck. The law is "never use U.shade to
       lighten anything that must keep its hue", and a dead blade is precisely the thing that must
       LOSE its hue: bleached straw is desaturated and lighter, which is exactly the direction
       U.shade travels. Sparse — a couple of flecks per few tiles, or the lawn reads as dying. */
    if ((clump % 3) === 0) {
      const r = hp(X, Y, 71);
      px(X + (r % T), Y + ((r >>> 6) % T), 1, 1 + ((r >>> 12) & 1), shade(base, (0.30 + cl) * fd));
    }
    if ((clump % 7) === 0) { const r = hp(X, Y, 99); px(X + (r % T), Y + ((r >>> 6) % T), 1, 1, vivid(base, (cl + 0.48) * fd)); }   // seed head
  }

  /* ---------- SPINE · the deck that replaces `plate` as the hab default (2026-07-25) ----------
     `plate` was a uniform 24px grid of identical slabs with random specks dropped on it. Two things
     dated it: EVERY MODULE WAS THE SAME SIZE, which reads as bathroom tile rather than engineering,
     and its detail was scattered at random instead of composed — a hatch means nothing when it
     could be anywhere. SPINE fixes both: big STAGGERED 4×3 plates (so no module lines up with its
     neighbour above), each read as a discrete bolted panel — recess inside the joint, four corner
     fixings, brushed grain — under a heavier TRANSVERSE structural seam every third band. That
     seam is the hierarchy: one strong line, then joints, then surface grain.

     NO LONGITUDINAL SERVICE CHANNEL. The first cut ran a recessed trench (dark inner wall, lit lip,
     grating ticks) every 6 tiles, and it was the design's centrepiece — it gave the deck direction.
     Andrew cut it on sight: at station scale a room shows only two or three of them, so they don't
     read as a rhythm, they read as two black bars ruled across the floor. Do not reintroduce a
     full-height vertical line here without looking at a whole room first — the trench looked
     correct in every close-up and wrong in every wide shot, which is the trap this deck sets. */
  /* SPINE — the station's DEFAULT deck, polished 2026-09-03 (Andrew: "keep the essence but make it way
     nicer"). THE ESSENCE, restored: 4x3 BOLTED PANELS, brushed grain running with the panel, a recess
     just inside each panel's own edge, four corner fixings, and no transverse line anywhere. The 2x2
     diamond-crosshatch cut that briefly replaced this was a different floor wearing the same name.

     WHAT "NICER" IS HERE, and it is all edge work rather than more marks:
       · a proper BEVEL LADDER on the joint — dark channel, then a lit lip inside the north/west edges
         and a shaded lip inside the south/east. Two steps per side instead of one, so a panel reads as
         a thick plate set into the deck rather than a rectangle with a line round it;
       · BRUSHED GRAIN with direction and variance — pairs of hairlines (one lighter, one darker, 1px
         apart) on a 3px pitch, their phase keyed per panel, which is what a rolled steel sheet does
         under a raking light. The old single-tone comb read as corduroy;
       · per-panel tone spread widened, plus a slow diagonal LIGHT GRADE across each panel (lit at the
         north-west corner, falling to the south-east) — the single biggest "this is a surface, not a
         swatch" cue, and it is free;
       · BOLTS rebuilt as real hardware: a countersunk well, a domed head lit north-west, a shadow
         south-east and a 1px pin. They were three flat pixels;
       · sparse, hash-keyed CHARACTER at panel scale — a weld bead along one joint in nine, a small
         inspection plate, a scuff worn through to bright metal. Never more than one per panel.
     Every mark is opaque and stepped (no washes), world-keyed (chunk-parity safe), and scaled by
     floorDetail; the joint stays on DEPTH.deckSeam so a soft deck stays soft. */
  function deckSpine(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => shade(base, d * fd);
    const sk = Math.max(0, DEPTH.deckSeam);
    const PW = 4, PH = 3;
    const band = Math.floor(y / PH), off = (band % 2) * 2;            // courses stagger by half a panel
    const pcx = Math.floor((x - off) / PW), pcy = band;
    const lx = ((x - off) % PW + PW) % PW, ly = ((y % PH) + PH) % PH;
    const pn = h2(pcx, pcy, ':sp');
    const body = ((pn % 7) - 3) * 0.022;                              // per-panel tone, wider spread than before
    px(X, Y, T, T, sh(body));

    /* THE PANEL'S OWN LIGHT — a slow diagonal grade, lit at the panel's north-west corner and falling
       toward the south-east, quantized to four steps so it stays in the pixel idiom. u runs 0..1 across
       the whole panel, not the tile, which is why it reads at panel scale instead of tiling. */
    const uSpan = PW * T + PH * T;
    for (let j = 0; j < T; j += 2) for (let i = 0; i < T; i += 2) {
      const u = ((lx * T + i) + (ly * T + j)) / uSpan;                // 0 at the NW corner, 1 at the SE
      const step = Math.round((0.5 - u) * 3) / 3;                     // -1, -1/3, +1/3, +1 · four hard steps
      if (step) px(X + i, Y + j, 2, 2, sh(body + step * 0.028));
    }

    /* BRUSHED GRAIN — hairline PAIRS with the panel's own phase, so neighbouring panels do not comb in
       lockstep. Lighter line over darker: that pairing is what reads as a rolled finish. */
    const ph = pn % 3;
    for (let i = ph; i < T; i += 3) {
      px(X, Y + i, T, 1, sh(body - 0.030));
      if (i + 1 < T) px(X, Y + i + 1, T, 1, sh(body + 0.038));
    }

    /* THE PANEL RECESS — a shadow line just inside the panel's own outer edges (not the joint), which is
       what makes a plate look SET IN rather than laid on. */
    if (lx === 0) px(X + 3, Y, 1, T, sh(body - 0.13));
    if (lx === PW - 1) px(X + T - 4, Y, 1, T, sh(body - 0.13));
    if (ly === 0) px(X, Y + 3, T, 1, sh(body - 0.13));
    if (ly === PH - 1) px(X, Y + T - 4, T, 1, sh(body - 0.13));

    /* THE JOINT — a two-step bevel ladder per side. North/west: dark channel then a LIT lip. South/east:
       a shaded lip so the neighbouring panel's channel has something to sit against. */
    if (lx === 0) { px(X, Y, 2, T, sh(-0.50 * sk)); px(X + 2, Y, 1, T, sh(body + 0.20 * sk)); }
    if (ly === 0) { px(X, Y, T, 2, sh(-0.50 * sk)); px(X, Y + 2, T, 1, sh(body + 0.20 * sk)); }
    if (lx === PW - 1) px(X + T - 1, Y, 1, T, sh(body - 0.26 * sk));
    if (ly === PH - 1) px(X, Y + T - 1, T, 1, sh(body - 0.26 * sk));

    /* BOLTS — countersunk well, domed head lit north-west, cast shadow south-east, pin. Four per panel. */
    const bolt = (bx, by) => {
      px(bx - 1, by - 1, 5, 5, sh(body - 0.30));                      // the countersunk well
      px(bx, by, 3, 3, sh(body + 0.12));                              // the head
      px(bx, by, 2, 1, sh(body + 0.34)); px(bx, by, 1, 2, sh(body + 0.34));   // its lit north-west
      px(bx + 2, by + 1, 1, 2, sh(body - 0.34)); px(bx + 1, by + 2, 2, 1, sh(body - 0.34));   // shaded south-east
      px(bx + 1, by + 1, 1, 1, sh(body - 0.16));                      // the pin
    };
    if (ly === 0 && lx === 0) bolt(X + 5, Y + 5);
    if (ly === 0 && lx === PW - 1) bolt(X + T - 7, Y + 5);
    if (ly === PH - 1 && lx === 0) bolt(X + 5, Y + T - 7);
    if (ly === PH - 1 && lx === PW - 1) bolt(X + T - 7, Y + T - 7);

    /* CHARACTER — at most one per panel, so the deck has incident without turning to noise. */
    const k = pn % 9;
    if (k === 0 && ly === 0) {                                        // weld bead along this panel's north joint
      for (let i = (pn % 2); i < T; i += 4) { px(X + i, Y + 2, 3, 1, sh(body + 0.16)); px(X + i + 1, Y + 3, 2, 1, sh(body - 0.20)); }
    } else if (k === 3 && lx === 1 && ly === 1) {                     // inspection plate with two fixings
      px(X + 1, Y + 1, T - 2, T - 3, sh(body - 0.16));
      px(X + 1, Y + 1, T - 2, 1, sh(body + 0.18)); px(X + 1, Y + 1, 1, T - 3, sh(body + 0.18));
      px(X + T - 2, Y + 2, 1, T - 4, sh(body - 0.30)); px(X + 2, Y + T - 3, T - 3, 1, sh(body - 0.30));
      px(X + 3, Y + 4, 1, 1, sh(body + 0.30)); px(X + T - 5, Y + T - 6, 1, 1, sh(body + 0.30));
    } else if (k === 6 && lx === 2 && ly === 1) {                     // a scuff worn through to bright metal
      px(X + 2, Y + 5, 6, 1, sh(body + 0.20)); px(X + 4, Y + 6, 5, 1, sh(body + 0.14)); px(X + 3, Y + 7, 3, 1, sh(body + 0.10));
    }
  }

  /* ---------- THE CORRIDOR DECK CANDIDATES (2026-07-28) ----------
     Andrew, after the hallway deck was moved onto the room material: "it doesnt really look good in
     my opinion, make a new tile set for the hallway to better match". A hallway sharing the rooms'
     deck exactly is correct about CONTINUITY and wrong about CHARACTER — spine's 4×3 panels are
     sized for a room's span, and in a 3-tile passage you only ever see a sliver of one.

     All three are AXIS-NEUTRAL on purpose. A corridor can run either way, `paintDeck` is not told
     which, and the REFIT palette samples the same function for its chip — a recipe that assumed
     "along the walk" would be wrong half the time in game and always wrong in the swatch. Direction
     is not the job of the deck here; it was tried as a full-length channel and deleted twice
     (SPINE's service trench, then the old corridor's gutters).
     Each one carries ONE idea, per the wall lane's finding that a second element competes with the
     first rather than supporting it. */

  /* RUNNER — spine's own vocabulary at a corridor's scale: bolted panels, brushed grain, four
     corner fixings, and the heavier transverse seam. The only change is PITCH, 4×3 → 2×2, because
     plate size follows span — a narrow passage is decked in narrower plates, which is true of real
     structures and is why this reads as the same station rather than a different one. The most
     conservative of the three: it matches by speaking the identical language. */
  function deckRunner(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => shade(base, d * fd);
    const sk = Math.max(0, DEPTH.deckSeam);
    const band = Math.floor(y / 2), off = (band % 2);
    const pcx = Math.floor((x - off) / 2);
    const lx = ((x - off) % 2 + 2) % 2, ly = ((y % 2) + 2) % 2;
    const pn = h2(pcx, band, ':rn');
    const body = ((pn % 5) - 2) * 0.03;
    px(X, Y, T, T, sh(body));
    for (let i = 1; i < T; i += 3) px(X, Y + i, T, 1, sh(body + ((i & 1) ? 0.024 : -0.018)));   // brushed grain
    if (lx === 0) px(X + 2, Y, 1, T, sh(body - 0.16));                                          // panel recess
    if (lx === 1) px(X + T - 3, Y, 1, T, sh(body - 0.16));
    if (ly === 0) px(X, Y + 2, T, 1, sh(body - 0.16));
    if (ly === 1) px(X, Y + T - 3, T, 1, sh(body - 0.16));
    if (lx === 0) { px(X, Y, 1, T, sh(-0.45 * sk)); px(X + 1, Y, 1, T, sh(body + 0.12 * sk)); }  // plate joint
    if (ly === 0) { px(X, Y, T, 1, sh(-0.45 * sk)); px(X, Y + 1, T, 1, sh(body + 0.12 * sk)); }
    const bolt = (bx, by) => { px(bx, by, 2, 2, sh(0.22)); px(bx, by, 1, 1, sh(0.40)); px(bx + 1, by + 1, 1, 1, sh(-0.35)); };
    if (ly === 0 && lx === 0) bolt(X + 3, Y + 3);
    if (ly === 0 && lx === 1) bolt(X + T - 5, Y + 3);
    if (ly === 1 && lx === 0) bolt(X + 3, Y + T - 5);
    if (ly === 1 && lx === 1) bolt(X + T - 5, Y + T - 5);
    if (((y % 6) + 6) % 6 === 0) { px(X, Y, T, 1, sh(-0.32)); px(X, Y + 1, T, 1, sh(0.09)); }    // transverse structural seam
  }

  /* TREADWAY — raised anti-slip DIAMOND plate, the surface real gangways and service passages are
     actually floored in. A lattice of small lozenges, each lit on its up-screen face and shaded
     below, so the deck reads as textured-for-grip rather than panelled. The one deck in the catalog
     whose marks are not axis-aligned, which is exactly what stops it reading as another grid: the
     diamonds sit on absolute bake-pixel coords (not tile-local), so the lattice crosses tile
     borders unbroken and a chunk bake lands identically to a monolithic one. */
  function deckTreadway(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    // every stud is clipped to THIS tile: the lattice is absolute, the painting is per-tile
    const pxc = (a, c, w, h, col) => {
      const a0 = Math.max(X, a), a1 = Math.min(X + T, a + w);
      const c0 = Math.max(Y, c), c1 = Math.min(Y + T, c + h);
      if (a1 <= a0 || c1 <= c0) return;
      b.fillStyle = col; b.fillRect(a0, c0, a1 - a0, c1 - c0);
    };
    const sh = d => shade(base, d * fd);
    const sk = Math.max(0, DEPTH.deckSeam);
    const pcx = Math.floor(x / 3), pcy = Math.floor(y / 2);
    const pn = h2(pcx, pcy, ':tw');
    const body = ((pn % 5) - 2) * 0.011;
    px(X, Y, T, T, sh(body));
    const lit = sh(body + 0.20), dim = sh(body - 0.20);
    /* THE MARK IS A BAR, NOT A DOT. Real chequer (durbar) plate is raised TEARDROPS laid in
       alternating diagonal pairs — the alternation is the whole reason it reads as a manufactured
       anti-slip surface instead of a field of studs. A round-ish lozenge on a lattice came out as a
       repeating glyph, which is the same failure mode as any mark that has a silhouette of its own:
       the eye reads the shape, not the surface. Each bar here is 3px long with a 1px rise across it,
       lit along the top and shaded along the bottom, and the lean flips on (row + col) parity. */
    const P = 5;
    const r0 = Math.floor(Y / P), r1 = Math.floor((Y + T - 1) / P);
    for (let r = r0; r <= r1; r++) {
      const cy = r * P, ox = (((r % 2) + 2) % 2) ? 2 : 0;
      const c0 = Math.floor((X - ox) / P), c1 = Math.floor((X + T - 1 - ox) / P);
      for (let c = c0; c <= c1; c++) {
        const cx = c * P + ox;
        if (((r + c) & 1) === 0) {          // leans up to the right
          pxc(cx, cy + 1, 2, 1, lit);  pxc(cx + 2, cy, 1, 1, lit);
          pxc(cx, cy + 2, 2, 1, dim);  pxc(cx + 2, cy + 1, 1, 1, dim);
        } else {                             // leans up to the left
          pxc(cx, cy, 1, 1, lit);      pxc(cx + 1, cy + 1, 2, 1, lit);
          pxc(cx, cy + 1, 1, 1, dim);  pxc(cx + 1, cy + 2, 2, 1, dim);
        }
      }
    }
    if (x % 3 === 0) px(X, Y, 1, T, sh(-0.24 * sk));                                             // plate joint
    if (y % 2 === 0) px(X, Y, T, 1, sh(-0.24 * sk));
    px(X, Y, T, T, 'rgba(0,0,0,' + (0.04 * fd).toFixed(3) + ')');                                // knock the stud contrast back a touch
    if (pn % 6 === 0) { px(X + 2, Y + 2, 2, 2, sh(0.14)); px(X + 3, Y + 3, 1, 1, sh(-0.20)); }    // occasional fixing
  }

  /* MESHWAY — a solid deck PERFORATED for drainage: a regular field of small dark holes, each with
     a catch-lit upper rim, punched through a plain plate. Its ancestor is GRATE, but where grate is
     an open catwalk that reads from its voids, this is a floor you could set a crate on — the holes
     are a detail on a surface, not the surface itself. The busiest of the three; kept honest by
     having no plate dressing at all beyond the joints, so the perforation is the only idea. */
  function deckMeshway(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const pxc = (a, c, w, h, col) => {
      const a0 = Math.max(X, a), a1 = Math.min(X + T, a + w);
      const c0 = Math.max(Y, c), c1 = Math.min(Y + T, c + h);
      if (a1 <= a0 || c1 <= c0) return;
      b.fillStyle = col; b.fillRect(a0, c0, a1 - a0, c1 - c0);
    };
    const sh = d => shade(base, d * fd);
    const sk = Math.max(0, DEPTH.deckSeam);
    const pcx = Math.floor(x / 3), pcy = Math.floor(y / 3);
    const pn = h2(pcx, pcy, ':mw');
    const body = ((pn % 5) - 2) * 0.012;
    px(X, Y, T, T, sh(body));
    px(X, Y + 1, T, 1, sh(body + 0.05));                                                          // faint rolled grain
    const hole = sh(body - 0.44), rim = sh(body + 0.16);
    const P = 4;                                                                                  // perforation lattice, absolute coords
    const r0 = Math.floor(Y / P), r1 = Math.floor((Y + T - 1) / P);
    const c0 = Math.floor(X / P), c1 = Math.floor((X + T - 1) / P);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const hx = c * P + 1, hy = r * P + 1;
      pxc(hx, hy - 1, 2, 1, rim);                                                                 // catch-lit upper rim
      pxc(hx, hy, 2, 2, hole);
    }
    if (x % 3 === 0) { px(X, Y, 1, T, sh(-0.28 * sk)); px(X + 1, Y, 1, T, sh(body + 0.06 * sk)); }
    if (y % 3 === 0) { px(X, Y, T, 1, sh(-0.28 * sk)); px(X, Y + 1, T, 1, sh(body + 0.06 * sk)); }
  }


  /* ============ NEW DECKS (2026-09-03) — four surfaces the station did not have ============
     Each carries ONE idea (the wall lane's law: a second element competes with the first rather than
     supporting it), each is axis-neutral (a corridor can run either way and the REFIT swatch samples
     the same painter), and each is keyed on WORLD tile coords so it survives a chunk boundary and a
     room join without re-rolling. */

  /* DIAMOND — rolled tread plate, the raised-lozenge sheet of every workshop and cargo lift. The read
     is the LOZENGE: two short diagonal bars per cell in alternating directions, each with a lit crest
     and the shadow it casts. No plate seams at all — this is stock sheet, and a joint drawn on top of
     the pattern is exactly what turns it into noise. */
  function deckDiamond(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => shade(base, d * fd);
    px(X, Y, T, T, sh(((h2(Math.floor(x / 3), Math.floor(y / 3), ':dm') % 5) - 2) * 0.012));
    for (let cy = 0; cy < T; cy += 6) for (let cx = 0; cx < T; cx += 6) {
      const gx = X + cx, gy = Y + cy;
      const up = ((((x * T + cx) / 6) | 0) + (((y * T + cy) / 6) | 0)) % 2 === 0;   // alternating lozenge direction
      for (let i = 0; i < 4; i++) {
        const ox = gx + 1 + i, oy = up ? gy + 4 - i : gy + 1 + i;
        px(ox, oy, 1, 2, sh(0.16));          // the raised bar
        px(ox, oy - 1, 1, 1, sh(0.30));      // its lit crest
        px(ox, oy + 2, 1, 1, sh(-0.34));     // the shadow it casts
      }
    }
  }

  /* RESIN — a poured, seamless floor with inlaid metal strips. The opposite of every other deck here:
     no tiles, no bolts, no lattice. The read comes from the pour itself (soft mottling) plus two
     bright strips inlaid every 4 tiles, which is what a lab or a clean passage actually looks like. */
  function deckResin(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => shade(base, d * fd);
    px(X, Y, T, T, sh(0.04));
    for (let j = 0; j < T; j += 2) for (let i = 0; i < T; i += 2) {           // the pour's soft mottle
      const v = (hp(X + i, Y + j, 0x5e51) & 255) / 255;
      if (v > 0.72) px(X + i, Y + j, 2, 2, sh(0.075));
      else if (v < 0.22) px(X + i, Y + j, 2, 2, sh(-0.055));
    }
    const strip = (sx, sy, w, h) => { px(sx, sy, w, h, sh(0.34)); px(sx, sy, w, 1, sh(0.5)); px(sx, sy + h - 1, w, 1, sh(-0.2)); };
    if (((x % 4) + 4) % 4 === 0) { px(X, Y, 1, T, sh(-0.22)); strip(X + 1, Y, 2, T); }   // inlaid strip, north-south
    if (((y % 4) + 4) % 4 === 0) { px(X, Y, T, 1, sh(-0.22)); strip(X, Y + 1, T, 2); }   // and east-west
  }

  /* CERAMIC — big gloss tiles with a PALE grout and a specular catch. Where TILE is a 2x2 utility
     surface, this is a 3x3 architectural one, and its joint is the only one in the catalog that runs
     LIGHTER than its body — which is what reads as a finished room rather than a machine deck. */
  function deckCeramic(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => shade(base, d * fd);
    const P = 3, cx0 = Math.floor(x / P), cy0 = Math.floor(y / P);
    const lx = ((x % P) + P) % P, ly = ((y % P) + P) % P;
    const tn = h2(cx0, cy0, ':cr');
    const body = ((tn % 7) - 3) * 0.016 + ((cx0 + cy0) % 2 ? 0.022 : -0.018);   // a quiet checker between tiles
    px(X, Y, T, T, sh(body));
    const sk = Math.max(0, DEPTH.deckSeam);
    if (lx === 0) { px(X, Y, 2, T, sh(0.20 * sk)); px(X + 2, Y, 1, T, sh(body - 0.16 * sk)); }   // pale grout + the tile's shaded edge
    if (ly === 0) { px(X, Y, T, 2, sh(0.20 * sk)); px(X, Y + 2, T, 1, sh(body - 0.16 * sk)); }
    if (lx === 0 && ly === 0) { px(X + 3, Y + 3, 5, 1, sh(body + 0.26)); px(X + 3, Y + 4, 3, 1, sh(body + 0.14)); }   // the gloss catch, north-west
    if (tn % 11 === 3) px(X + 4 + (tn % 4), Y + 7, 3, 1, sh(body - 0.14));      // a hairline crack in one tile in eleven
  }

  /* CARGO — the heaviest deck in the catalog: 3x2 structural slabs, a deep channel between them, a
     lifting eye at each slab corner and a painted load line down every third slab. Sized for a hold,
     and the one deck that still reads from across the station. */
  function deckCargo(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => shade(base, d * fd);
    const PW = 3, PH = 2;
    const cx0 = Math.floor(x / PW), cy0 = Math.floor(y / PH);
    const lx = ((x % PW) + PW) % PW, ly = ((y % PH) + PH) % PH;
    const pn = h2(cx0, cy0, ':cg');
    const body = ((pn % 5) - 2) * 0.026;
    const sk = Math.max(0.4, DEPTH.deckSeam);
    px(X, Y, T, T, sh(body));
    for (let j = 2; j < T; j += 4) px(X, Y + j, T, 1, sh(body - 0.05));         // rolled grain across the slab
    if (lx === 0) { px(X, Y, 3, T, sh(-0.62 * sk)); px(X + 3, Y, 1, T, sh(body + 0.22 * sk)); }   // deep channel + lit lip
    if (ly === 0) { px(X, Y, T, 3, sh(-0.62 * sk)); px(X, Y + 3, T, 1, sh(body + 0.22 * sk)); }
    if (lx === PW - 1) px(X + T - 1, Y, 1, T, sh(body - 0.3 * sk));
    if (ly === PH - 1) px(X, Y + T - 1, T, 1, sh(body - 0.3 * sk));
    if (lx === 0 && ly === 0) {                                                 // lifting eye at the slab corner
      px(X + 5, Y + 5, 5, 5, sh(-0.34)); px(X + 6, Y + 6, 3, 3, sh(-0.62));
      px(X + 5, Y + 5, 5, 1, sh(0.22)); px(X + 5, Y + 5, 1, 5, sh(0.22));
    }
    if (pn % 3 === 0 && ly === 0 && lx === 1) {                                 // painted load line
      px(X, Y + 6, T, 2, 'rgba(214,178,52,0.5)'); px(X, Y + 6, T, 1, 'rgba(232,206,120,0.45)');
    }
  }

  // Large matte plates: most pixels belong to the quiet top surface. Recesses and
  // captive fixings stay on the plate perimeter, readable at the normal station zoom.
  // Every mark is tile-local and world-keyed, including negative world coordinates.
  function deckAlloy(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, d) => { b.fillStyle = shade(base, d * fd); b.fillRect(a, c, w, h); };
    const lx = ((x % 4) + 4) % 4, ly = ((y % 3) + 3) % 3;
    const panel = hp(Math.floor(x / 4), Math.floor(y / 3), 8201);
    const body = 0.075 + ((panel % 3) - 1) * 0.006;
    px(X, Y, T, T, body);
    // A shallow stepped fall across the broad face, not repeated brushed-metal stripes.
    px(X, Y, T, T, body + (1 - ly) * 0.009);
    const seam = Math.max(0, DEPTH.deckSeam);
    if (lx === 0) { px(X, Y, 1, T, -0.15 * seam); px(X + 1, Y, 1, T, body + 0.05 * seam); }
    if (ly === 0) { px(X, Y, T, 1, -0.15 * seam); px(X, Y + 1, T, 1, body + 0.05 * seam); }
    if (lx === 3) px(X + T - 1, Y, 1, T, body - 0.035 * seam);
    if (ly === 2) px(X, Y + T - 1, T, 1, body - 0.035 * seam);
    if (lx === 0 && ly === 0 && panel % 2 === 0) {
      px(X + 4, Y + 4, 3, 2, body - 0.15); px(X + 4, Y + 4, 2, 1, body + 0.055);
    }
    if (lx === 3 && ly === 2 && panel % 3 === 0) {
      px(X + 4, Y + 7, 5, 1, body - 0.06); px(X + 8, Y + 5, 1, 2, body - 0.06);
    }
  }

  function paintDeckRecipe(b, mat, base, x, y, X, Y, z, n, fd) {
    if (mat === 'alloy') return deckAlloy(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'runner') return deckRunner(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'treadway') return deckTreadway(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'meshway') return deckMeshway(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'spine') return deckSpine(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'grate') return deckGrate(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'hex') return deckHex(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'plank') return deckPlank(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'turf') return deckTurf(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'diamond') return deckDiamond(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'resin') return deckResin(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'ceramic') return deckCeramic(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'cargo') return deckCargo(b, base, x, y, X, Y, z, n, fd);
    return deckSlab(b, mat, base, x, y, X, Y, z, n, fd);
  }

  // Finish belongs to the material, not to the room. Keep it inside the tile and
  // anchored to world coordinates so refit swatches and chunked decks agree.
  function paintDeck(b, mat, base, x, y, X, Y, z, n, fd) {
    if (nextSurfaces()) {
      const origin = G && G.origin || { tx: 0, ty: 0 };
      WorldSurface.paintFloorTile(b, mat, base, X, Y, T, x + origin.tx, y + origin.ty, { detail: fd });
      return;
    }
    paintDeckRecipe(b, mat, base, x, y, X, Y, z, n, fd);
    if (fd <= 0 || mat === 'alloy' || mat === 'turf' || mat === 'plank' || mat === 'grate' || mat === 'meshway' || mat === 'soft') return;
    const seed = hp(x, y, 317), yy = Y + 3 + seed % 5;
    // Sparse flush inspection hatches on engineered metal decks. One per 8x6
    // tile bay; furniture still owns the visual hierarchy. Local, world-keyed
    // pixels keep negative coordinates, refit swatches and chunks consistent.
    if (['spine','plate','panel','cargo'].includes(mat) && ((x%8)+8)%8===1 && ((y%6)+6)%6===1) {
      const sh=d=>shade(base,d*fd);
      b.fillStyle=sh(-0.30);b.fillRect(X+3,Y+3,7,6);
      b.fillStyle=sh(-0.07);b.fillRect(X+4,Y+4,5,4);
      b.fillStyle=sh(0.12);b.fillRect(X+4,Y+8,5,1);
      b.fillStyle=sh(-0.40);b.fillRect(X+7,Y+5,1,2);
      b.fillStyle=sh(0.18);b.fillRect(X+6,Y+5,1,1);
      return;
    }
    if (mat === 'ceramic' || mat === 'resin' || mat === 'tile') {
      // Broad, quiet glaze instead of scratches on hygienic surfaces.
      if (seed % 7 === 0) {
        b.fillStyle = 'rgba(186,212,231,' + (0.035 * fd).toFixed(4) + ')';
        b.fillRect(X + 2, yy, 7, 2);
      }
    } else if (seed % 4 === 0) {
      // Paired machining stroke: a recessed line and the lip that catches light.
      b.fillStyle = 'rgba(4,9,16,' + (0.12 * fd).toFixed(4) + ')';
      b.fillRect(X + 3, yy, 5, 1);
      b.fillStyle = 'rgba(170,192,211,' + (0.045 * fd).toFixed(4) + ')';
      b.fillRect(X + 3, yy - 1, 3, 1);
    }
  }

  /* THE ONE DECK PAINTER — every walkable tile in the station, room or corridor, comes through
     here (2026-07-28). It used to be rooms only, and `bakeCorridorFloor` was a wholly separate,
     PRE-V2 painter that hand-rolled a slab-tread look and never called `matOf`/`paintDeck` at all.
     So a corridor's declared material was DEAD ART: `ROOM_KINDS.corridor.mat` is 'spine', set to
     match `hab` precisely so "a corridor doesn't read as a different floor through the doorway"
     (worldmodel.js), and the bake threw it away — spine, plate, grate, turf and plank all baked
     byte-identical corridor pixels. That is the whole of Andrew's "the hallway floor seems very
     outdated": it was not a dated recipe, it was NO recipe, frozen before the material axis existed.
     A user could even paint a hallway from REFIT and watch nothing happen, which is the truthful-
     telemetry law failing in the art layer.
     LAW: one surface class, one painter. A second painter for "the same thing but narrower" does
     not stay in sync — it silently stops receiving every improvement the first one gets. */
  /* smooth value noise in [-0.5, 0.5] on a 4-tile lattice, keyed on world tile coords (see bakeDeck) */
  const LF_PITCH = 4;
  const lfv = (cx, cy) => (hp(cx, cy, 0x1f1f) & 0xffff) / 65535;
  function lowFreq(x, y) {
    const cx = Math.floor(x / LF_PITCH), cy = Math.floor(y / LF_PITCH);
    let tx = (x - cx * LF_PITCH) / LF_PITCH, ty = (y - cy * LF_PITCH) / LF_PITCH;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const a = lfv(cx, cy), b2 = lfv(cx + 1, cy), c = lfv(cx, cy + 1), d = lfv(cx + 1, cy + 1);
    return (a + (b2 - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty - 0.5;
  }
  function bakeDeck(b, r, tiles = r) {
    const px = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x, y, w, h); };
    const fd = Math.max(0, DEPTH.floorDetail);
    const mat = matOf(r.z);
    const zg = G.zoneGrid, idx = G.idx, COLS = G.COLS, ROWS = G.ROWS;
    const zAt = (x, y) => (x < 0 || y < 0 || x >= COLS || y >= ROWS) ? null : zg[idx(x, y)];
    const doorTo = (x, y, nx, ny) => { const nz = zAt(nx, ny); return nz != null && nz !== r.z && (G.canStep(x, y, nx, ny) || G.canStep(nx, ny, x, y)); };
    const wallTo = (x, y, nx, ny) => zAt(nx, ny) !== r.z && !doorTo(x, y, nx, ny);
    // Local repairs retain the room's material and wear geometry while painting
    // only their intersecting tiles, rather than rebuilding the entire room.
    const x1 = Math.max(r.x1, tiles.x1), x2 = Math.min(r.x2, tiles.x2);
    const y1 = Math.max(r.y1, tiles.y1), y2 = Math.min(r.y2, tiles.y2);
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
      /* LOW-FREQUENCY TONE — a painted floor is never one flat swatch. Smooth value noise on a 4-tile
         lattice (bilinear, smoothstepped) drifts the base tone ±5% across the room, so plates a few
         tiles apart sit at slightly different values and the deck reads as a SURFACE with light and
         history on it rather than a fill. World-tile keyed like every other mark (chunk parity), never
         zone keyed (a re-roll at a room join would draw the seam the deck painters were fixed to hide).
         Rides floorDetail, so 0 is still the flat unadorned deck. */
      const base = nextSurfaces() ? G.baseColorOf(r.z, x, y) : shade(G.baseColorOf(r.z, x, y), lowFreq(x, y) * 0.05 * fd);
      const X = x * T, Y = y * T, n = h2(x, y, r.z);
      const sh = d => shade(base, d * fd);
      paintDeck(b, mat, base, x, y, X, Y, r.z, n, fd);
      if (mat === 'alloy') {
        // A darker painted inset is a recessed finish within the same walkable deck.
        // Edge pixels follow real paint boundaries, never a room-id or camera overlay.
        const raw = G.baseColorOf(r.z, x, y);
        const luma = hex => { const c = parseInt(hex.slice(1), 16); return ((c >> 16) & 255) * .299 + ((c >> 8) & 255) * .587 + (c & 255) * .114; };
        const inset = (nx, ny) => zAt(nx, ny) === r.z && luma(G.baseColorOf(r.z, nx, ny)) > luma(raw) + 5;
        if (inset(x, y - 1)) px(X, Y, T, 2, sh(-0.22));
        if (inset(x - 1, y)) px(X, Y, 2, T, sh(-0.22));
        if (inset(x, y + 1)) { px(X, Y + T - 2, T, 1, sh(-0.2)); px(X, Y + T - 1, T, 1, sh(0.16)); }
        if (inset(x + 1, y)) { px(X + T - 2, Y, 1, T, sh(-0.2)); px(X + T - 1, Y, 1, T, sh(0.16)); }
      }
      // FLOOR WEAR — a lived-in deck: hash-keyed scuffs, drag marks, worn-pale patches and
      // grime films over the plates above. Same idiom (opaque-ish 1px marks, deterministic on
      // the tile hash); DEPTH.floorWear scales alpha, 0 = the pristine pre-wear floor exactly.
      // Wear follows the central circulation lane; storage edges stay quieter.
      // Geometry-derived dressing, not a claim about recorded foot traffic.
      const lane = Math.abs(x - (r.x1 + r.x2) / 2) <= 1.5;
      const wear = nextSurfaces() ? 0 : Math.max(0, DEPTH.floorWear) * (lane ? 1 : 0.35) * (mat === 'alloy' ? 0.18 : 1);
      if (wear > 0.001 && !MAT_NO_WEAR[mat]) {
        const wa = a => (a * wear).toFixed(3);
        if (n % 9 === 1) px(X + (n % 6), Y + 3 + (n % 8), 4 + (n % 3), 1, 'rgba(0,0,0,' + wa(0.18) + ')');          // boot scuff streak
        else if (n % 11 === 6) px(X + 3 + (n % 8), Y + (n % 5), 1, 3 + (n % 3), 'rgba(0,0,0,' + wa(0.15) + ')');    // vertical scrape
        else if (n % 17 === 8) {                                                                                     // parallel drag marks (something heavy moved)
          px(X + 2, Y + 5 + (n % 4), 6 + (n % 4), 1, 'rgba(0,0,0,' + wa(0.14) + ')');
          px(X + 2, Y + 7 + (n % 4), 6 + (n % 4), 1, 'rgba(0,0,0,' + wa(0.14) + ')');
        } else if (n % 27 === 4) px(X + 2, Y + 2, T - 4, T - 4, 'rgba(255,244,220,' + wa(0.05) + ')');               // worn-pale patch (foot polish)
        if (n % 13 === 9) px(X, Y, T, T, 'rgba(0,0,0,' + wa(0.06) + ')');                                            // grime film over the whole plate
      }
      // PERIMETER TRIM COURSE — the border course where floor meets wall reads as a distinct
      // laid material band, catch-lit on its room-facing edge; doors get pale guide ticks.
      // Painted LAST so it re-tones the whole tile over the plate work above.
      const wN = wallTo(x, y, x, y - 1), wS = wallTo(x, y, x, y + 1), wW = wallTo(x, y, x - 1, y), wE = wallTo(x, y, x + 1, y);
      if (wN || wS || wW || wE) {
        /* The catch-lit room-facing edge is drawn BEFORE the trim's darkening, and rides
           DEPTH.deckSeam. Two bugs here, both showing as a bright 1px column running the room's
           ENTIRE length one tile inside each side wall (Andrew 2026-07-24: "the line that divides
           the left and right side wall"):
             1. it was an OPAQUE fill derived from the raw `base`, so it punched straight through the
                trim's own 6% darkening AND through the plate work — the column reset to base tone
                and therefore read brighter than the deck no matter how small the delta got;
             2. at a flat 0.06 the delta was +20 luminance on top of that.
           Painting it first and letting the trim overlay darken it too keeps it a gentle LIFT
           relative to the border course it belongs to, instead of a hole punched through it. */
        const tk = 'rgba(255,246,224,' + (Math.max(0, DEPTH.deckSeam) * 0.05 * fd).toFixed(3) + ')';
        if (wN && !wS) px(X, Y + T - 1, T, 1, tk);
        if (wS && !wN) px(X, Y, T, 1, tk);
        if (wW && !wE) px(X + T - 1, Y, 1, T, tk);
        if (wE && !wW) px(X, Y, 1, T, tk);
        px(X, Y, T, T, 'rgba(6,7,10,' + (0.06 * fd).toFixed(3) + ')');
      }
      /* THRESHOLD GUIDE TICKS — pale marks in the floor where you step THROUGH a doorway. They
         read as a threshold only while the opening is one: on an open join (two rooms simply
         abutting) they ran the full length of the boundary and became a dashed border line, the
         same drift bakeThreshold had. Same test, same answer — a doorway is a hole in a wall. */
      const sillTo = (nx, ny, side) => doorTo(x, y, nx, ny) && !isOpenJoin(x, y, side) && !deckContinues(x, y, nx, ny);
      const dN = sillTo(x, y - 1, 'n'), dS = sillTo(x, y + 1, 's'), dW = sillTo(x - 1, y, 'w'), dE = sillTo(x + 1, y, 'e');
      if (dN || dS || dW || dE) {
        b.fillStyle = sh(0.13);
        for (let i = 2; i < T - 2; i += 5) {
          if (dN) b.fillRect(X + i, Y + 1, 2, 1);
          if (dS) b.fillRect(X + i, Y + T - 2, 2, 1);
          if (dW) b.fillRect(X + 1, Y + i, 1, 2);
          if (dE) b.fillRect(X + T - 2, Y + i, 1, 2);
        }
      }
    }
  }

  /* A CORRIDOR IS THE STATION'S DECK PLUS EXACTLY ONE IDEA — the tracks the crew wears into it.
     Everything else the old corridor painter drew (a hard tread seam on every tile row, rib bands
     on a 7px pitch, staggered chevrons, and a full-length gutter hugging each long wall) was a
     second visual system competing with the deck material underneath it, and every one of those
     marks ran the corridor's WHOLE length. That is the mark the SPINE deck's service channel was
     deleted for: a full-run trench reads as a system in a close-up and as an arbitrary bar in the
     space itself. The wall lane taught the same thing from the other side — of three candidates
     for a 23px wall face, the EMPTY bay beat both busy ones, because a second element between the
     columns competes with them instead of supporting them.
     So the traffic lanes stay and the rest goes. They earn it by being the one mark that is TRUE
     of a corridor and not of a room: a hallway is a thing people walk down, and foot-polish down
     the middle is that fact rendered. They also ride DEPTH.floorWear, so they are wear, not
     decoration, and they vanish with the rest of the wear at 0. */
  function bakeCorridorFloor(b, r, tiles = r) {
    bakeDeck(b, r, tiles);
    const wear = Math.max(0, DEPTH.floorWear);
    if (wear <= 0.001) return;
    const vertical = (r.y2 - r.y1) > (r.x2 - r.x1);
    const x1 = r.x1 * T, y1 = r.y1 * T, rw = (r.x2 - r.x1 + 1) * T, rh = (r.y2 - r.y1 + 1) * T;
    const lane = 'rgba(255,244,220,' + (0.05 * wear).toFixed(3) + ')';
    const grime = 'rgba(0,0,0,' + (0.10 * wear).toFixed(3) + ')';
    if (vertical) {
      const cx = Math.round(x1 + rw / 2);
      b.fillStyle = lane; b.fillRect(cx - 4, y1 + 2, 2, rh - 4); b.fillRect(cx + 2, y1 + 2, 2, rh - 4);
      b.fillStyle = grime; b.fillRect(cx - 5, y1 + 2, 1, rh - 4); b.fillRect(cx + 4, y1 + 2, 1, rh - 4);
    } else {
      const cy = Math.round(y1 + rh / 2);
      b.fillStyle = lane; b.fillRect(x1 + 2, cy - 4, rw - 4, 2); b.fillRect(x1 + 2, cy + 2, rw - 4, 2);
      b.fillStyle = grime; b.fillRect(x1 + 2, cy - 5, rw - 4, 1); b.fillRect(x1 + 2, cy + 4, rw - 4, 1);
    }
  }

  /* World II has a separate spatial light map. Its architectural floor shade is
     therefore ONE bounded field: overlapping wall feet and corners select the
     strongest coverage, rather than multiplying three dark bands into black.
     Pixel rows retain the native grid; the falloff is sampled in world pixels,
     so neither tile edges nor cropped bake viewports restart the profile. */
  function wallFloorShadow(geo, wallEdges, viewport, options = {}) {
    const t=geo.TILE||12,v=viewport||{x:0,y:0,w:geo.W,h:geo.H};
    const width=Math.max(0,Math.ceil(v.w)),height=Math.max(0,Math.ceil(v.h));
    const field=new Uint8Array(width*height),at=geo.idx||((x,y)=>y*geo.COLS+x);
    const finite=(v,f)=>Number.isFinite(v)?v:f;
    const edge=Math.max(0,finite(options.edgeAO,DEPTH.edgeAO)),cast=Math.max(0,finite(options.wallShadow,DEPTH.wallShadow));
    const corner=Math.max(0,finite(options.cornerAO,DEPTH.cornerAO)),south=Math.max(0,finite(options.southFoot,DEPTH.southFoot));
    const wallUp=Math.max(0,finite(options.wallUp,WALL.up)),corUp=Math.max(0,finite(options.corUp,WALL.corUp));
    const sides=new Map(),clampAlpha=a=>Math.round(Math.max(0,Math.min(.34,a))*255);
    const put=(x,y,w,h,zone,alphaAt)=>{
      const x0=Math.max(0,Math.floor(x-v.x)),y0=Math.max(0,Math.floor(y-v.y));
      const x1=Math.min(width,Math.ceil(x+w-v.x)),y1=Math.min(height,Math.ceil(y+h-v.y));
      for(let yy=y0;yy<y1;yy++)for(let xx=x0;xx<x1;xx++) {
        const px=xx+v.x,py=yy+v.y,tx=Math.floor(px/t),ty=Math.floor(py/t);
        if(tx<0||ty<0||tx>=geo.COLS||ty>=geo.ROWS||geo.zoneGrid[at(tx,ty)]!==zone)continue;
        const a=clampAlpha(alphaAt(px-x+.5,py-y+.5)),i=yy*width+xx;
        if(a>field[i])field[i]=a;
      }
    };
    const ease=(distance,reach)=>Math.pow(Math.max(0,1-distance/reach),1.7);
    for(const e of wallEdges||[]) {
      if(e.door||e.open)continue;
      const x=e.x*t,y=e.y*t,key=e.x+','+e.y;
      let pair=sides.get(key);if(!pair)sides.set(key,pair={...e,n:false,s:false,w:false,e:false});pair[e.side]=true;
      if(e.side==='n') {
        const reach=Math.max(5,Math.round((e.room?wallUp:corUp)*.46)),peak=Math.max(edge*.18,cast*.50);
        put(x,y+(e.room?NFACE:5),t,reach,e.z,(_,dy)=>peak*ease(dy,reach));
      } else if(e.side==='w') {
        const reach=e.room?6:4,peak=Math.max(edge*.14,cast*.24);
        put(x,y,reach,t,e.z,dx=>peak*ease(dx,reach));
      } else if(e.side==='e') {
        const reach=e.room?3:2,peak=Math.max(edge*.09,cast*.18);
        put(x+t-reach,y,reach,t,e.z,dx=>peak*ease(reach-dx,reach));
      } else if(e.side==='s'&&south>.001) {
        const reach=e.room?4:3,peak=Math.max(edge*.14,cast*.20)*south;
        put(x,y+t-reach,t,reach,e.z,(_,dy)=>peak*ease(reach-dy,reach));
      }
    }
    if(corner>.001)for(const pair of sides.values()) {
      const x=pair.x*t,y=pair.y*t,reach=Math.max(3,Math.round(t*.55));
      const putCorner=(ax,ay,right,down)=>put(right?ax-reach:ax,down?ay-reach:ay,reach,reach,pair.z,(dx,dy)=>{
        const distance=Math.hypot(right?reach-dx:dx,down?reach-dy:dy);
        return corner*.58*ease(distance,reach);
      });
      if(pair.n&&pair.w)putCorner(x,y+(pair.room?NFACE:5),false,false);
      if(pair.n&&pair.e)putCorner(x+t,y+(pair.room?NFACE:5),true,false);
      if(south>.001&&pair.s&&pair.w)putCorner(x,y+t,false,true);
      if(south>.001&&pair.s&&pair.e)putCorner(x+t,y+t,true,true);
    }
    return{alpha:field,width,height,x:v.x,y:v.y};
  }
  function bakeWorldIIFloorShadow(b) {
    if(Math.max(DEPTH.edgeAO,DEPTH.wallShadow,DEPTH.cornerAO)<=.001)return;
    const field=wallFloorShadow(G,edges,{x:VX,y:VY,w:CW,h:CH});
    for(let y=0;y<field.height;y++)for(let x=0;x<field.width;) {
      const alpha=field.alpha[y*field.width+x];if(!alpha){x++;continue;}
      let end=x+1;while(end<field.width&&field.alpha[y*field.width+end]===alpha)end++;
      b.fillStyle='rgba(6,7,10,'+(alpha/255).toFixed(4)+')';b.fillRect(VX+x,VY+y,end-x,1);x=end;
    }
  }
  function bakeEdgeAO(b) {
    if(nextSurfaces()){bakeWorldIIFloorShadow(b);return;}
    // base edge AO — the short shade band hugging every wall foot (verbatim legacy look).
    // DEPTH.edgeAO scales the pass (1 = the shipped band, 0 = off) so it can be dialled in the
    // CRT LAB like every other depth cue; it used to be the one hardcoded band in the bake, which
    // made "which pass owns this dark line at the wall?" unanswerable without editing the source.
    const ea = Math.max(0, DEPTH.edgeAO);
    if (ea > 0.001) {
      b.fillStyle = 'rgba(0,0,0,' + (0.25 * ea).toFixed(3) + ')';
      for (const e of edges) {
        if (e.door) continue;
        const X = e.x * T, Y = e.y * T, d = e.room ? 8 : 4, ds = e.room ? 5 : 3;
        if (e.side === 'n') b.fillRect(X, Y, T, d);
        // the SOUTH band belongs to DEPTH.southFoot, which owns every dark mark at that edge —
        // it is the same black rule, and leaving half of it here is what made turning the other
        // half off look like it had done nothing.
        else if (e.side === 's') { if (DEPTH.southFoot > 0.001) b.fillRect(X, Y + T - ds, T, ds); }
        else if (e.side === 'w') b.fillRect(X, Y, ds, T);
        else b.fillRect(X + T - ds, Y, ds, T);
      }
    }
    bakeWallCastShadow(b);
    bakeCornerAO(b);
  }

  /* CORNER AO — where two wall feet MEET, the linear bands above only overlap in a square;
     real light pools extra darkness INTO a concave corner. Painted as 3 nested opaque-alpha
     squares anchored at the corner point (hard 1px transitions — the station's pixel idiom,
     same reasoning as bakeWallCastShadow), largest faintest → smallest darkest, so the corner
     reads as a pooled radial-ish falloff at any zoom. Cool-black to sit with the edge AO tone.
     Only same-tile side pairs (a room's corner tile carries both edges); door seams never
     count as walls. DEPTH.cornerAO scales the whole pass; 0 = off = the pre-AO look. */
  function bakeCornerAO(b) {
    const s = Math.max(0, DEPTH.cornerAO);
    if (s <= 0.001) return;
    const cool = a => 'rgba(6,7,10,' + a.toFixed(3) + ')';
    const sides = new Map();   // 'x,y' -> which sides of this tile carry a solid (non-door) wall
    for (const e of edges) {
      if (e.door) continue;
      const k = e.x + ',' + e.y;
      let sd = sides.get(k);
      if (!sd) sides.set(k, sd = { n: false, s: false, w: false, e: false, room: e.room });
      sd[e.side] = true;
    }
    const R = [Math.round(T * 0.6), Math.round(T * 0.42), Math.round(T * 0.24)];
    const A = [0.26, 0.34, 0.42];
    for (const [k, sd] of sides) {
      const both = (sd.n || sd.s) && (sd.w || sd.e);
      if (!both) continue;
      const cx = k.indexOf(','), x = +k.slice(0, cx), y = +k.slice(cx + 1);
      const X = x * T, Y = y * T;
      const topY = Y + (sd.room ? NFACE : 5);   // floor starts below the north face (matches bakeWallCastShadow's seam)
      const put = (ax, ay, right, down) => {    // corner point + which way the squares grow
        for (let i = 0; i < R.length; i++) {
          const r = R[i], a = s * A[i];
          if (a < 0.004 || r < 2) continue;
          b.fillStyle = cool(a);
          b.fillRect(right ? ax - r : ax, down ? ay - r : ay, r, r);
        }
      };
      if (sd.n && sd.w) put(X, topY, false, false);
      if (sd.n && sd.e) put(X + T, topY, true, false);
      if (sd.s && sd.w) put(X, Y + T, false, true);
      if (sd.s && sd.e) put(X + T, Y + T, true, true);
    }
  }

  /* the big 3D cue: the STANDING north wall shades the floor at its base, as if the ceiling light
     rakes over it. A soft vertical gradient cast SOUTH (down-screen) from each north wall's floor
     seam, plus a touch more shade at the e/w wall feet so every wall foot sits in shadow. Cool-black
     to match the existing edge AO tone. Baked onto the floor at the same stage as edge AO, INSIDE the
     floor footprint only (never onto the hull skirt, which the ambient mask deliberately excludes). */
  function bakeWallCastShadow(b) {
    const s = Math.max(0, DEPTH.wallShadow);
    if (s <= 0.001) return;
    // Painted as STEPPED opaque-alpha bands (hard 1px transitions), not a smooth gradient — this
    // matches the station's own pixel idiom (see bakeDeck / bakeTallNorthFace: no low-alpha
    // washes) AND keeps the bake portable to the headless canvas mock (no createLinearGradient).
    // Cool-black to sit with the existing edge AO tone. Alpha falls off south of the seam.
    const cool = a => 'rgba(6,7,10,' + a.toFixed(3) + ')';
    for (const e of edges) {
      if (e.door) continue;
      const X = e.x * T, Y = e.y * T;
      if (e.side === 'n') {
        // the floor seam of a tall north face sits inFace px below the tile top; the legacy short
        // wall (up:0) contacts the floor at the same inFace line, so seed the cast there either way.
        const inFace = e.room ? NFACE : 5;
        const seam = Y + inFace;
        const h = Math.max(6, Math.round((e.room ? WALL.up : WALL.corUp) * 0.55));                       // rooms throw a taller floor shadow than corridors
        // 4 bands easing 1 → 0 in alpha over the shadow height (raised-cosine-ish falloff, discretized)
        const bands = 4, prof = [0.76, 0.48, 0.25, 0.10];
        const bh = Math.max(1, Math.round(h / bands));
        for (let i = 0; i < bands; i++) {
          const a = s * 0.92 * prof[i]; if (a < 0.004) continue;
          b.fillStyle = cool(a); b.fillRect(X, seam + i * bh, T, bh);
        }
        // A tight occlusion seam anchors the wall; the longer cast above supplies its height.
        b.fillStyle=cool(s*0.95);b.fillRect(X,seam,T,1);
        // Structural uprights project narrow fingers beyond the broad wall shadow.
        if (e.room && ((e.x % 2)+2)%2===0) {
          b.fillStyle=cool(s*0.25);b.fillRect(X+3,seam+2,3,Math.min(T-2,h));
        }
      } else if (e.side === 'w') {
        // deepen the west wall foot: two inward bands so the wall base reads shaded (steps in x)
        const w = e.room ? 9 : 5, bw = 2;
        b.fillStyle = cool(s * 0.5); b.fillRect(X, Y, bw, T);
        b.fillStyle = cool(s * 0.22); b.fillRect(X + bw, Y, w - bw, T);
      } else if (e.side === 'e') {
        const w = e.room ? 3 : 2, bw = 1;
        b.fillStyle = cool(s * 0.40); b.fillRect(X + T - bw, Y, bw, T);
        b.fillStyle = cool(s * 0.12); b.fillRect(X + T - w, Y, w - bw, T);
      }
    }
  }

  /* the TALL north wall: the interior face a viewer sees when looking at the far side of a
     room. It keeps the classic NFACE px of floor-contact face BELOW the seam (unchanged, so
     props/agents hugging the top row still read right) and rises WALL.up px ABOVE it — over
     void/hull only, never over walkable floor — crowned by a lit cap + dark hull lip. */
  function bakeTallNorthFace(b, e, X, Y) {
    const room = e.room;
    const up = Math.max(0, Math.round(room ? WALL.up : WALL.corUp));
    const inFace = room ? NFACE : 5;

    // up === 0 → the EXACT legacy short wall (verbatim from the pre-tall-wall bake): a dark
    // hull cap band above the seam, the plain face + rib, the floor-contact line, the seam
    // hairline. NOTHING SHIPPED TAKES THIS PATH ANY MORE — it is reachable only from the crtlab
    // 'Flat (old)' preset. Corridors used to live here at corUp:0, which is why they had no lit
    // crown: this branch paints none, and a wall with no crown does not read as a wall at all.
    if (up === 0) {
      const cap = room ? 4 : 2;                                        // legacy NCAP (rooms) / 2 (corridors)
      b.fillStyle = hullEdge(e.z); b.fillRect(X, Y - cap, T, cap);
      b.fillStyle = wallFace; b.fillRect(X, Y, T, inFace);
      b.fillStyle = 'rgba(0,0,0,0.25)'; b.fillRect(X + 5, Y, 1, inFace);
      b.fillStyle = wallTop; b.fillRect(X, Y + inFace, T, 1);
      b.fillStyle = 'rgba(255,255,255,0.05)'; b.fillRect(X, Y, T, 1);
      return;
    }

    // up > 0 → a standing interior face, painted in the STATION'S OWN PIXEL IDIOM: opaque colours
    // stepped via U.shade (hard 1px transitions), grain that matches the floor's at 3x, and NO
    // low-alpha full-width washes (those read as blur next to the hard floor steps). The FACE
    // itself is per-material (WALL_RECIPES); the crown, hull lip and floor-contact line are
    // common to every material because they define the wall's silhouette and height.
    const pal = wallPal(e.z);
    const capH = Math.max(2, Math.round(WALL.capH));
    const h = up + inFace, topY = Y - up;              // all integer already (up/capH rounded, T/inFace int)
    const n = h2(e.x, e.y, 'nwall');
    // dark hull lip above the crown (the old NCAP band, pushed up with the wall) — the SHELL seen
    // from outside, so it takes the room's own hull skin rather than a module constant.
    b.fillStyle = hullEdge(e.z); b.fillRect(X, topY - capH - 2, T, 2);
    // lit crown — opaque cap band, 1px lighter top edge, 1px darker seam beneath. Kept BRIGHT:
    // after the ambient bake this continuous line defines the wall height at any zoom.
    crown(b, X, topY - capH, T, capH, pal.cap);
    crown(b, X, topY - capH, T, 1, shade(pal.cap, 0.30));                          // 1px lighter top edge
    b.fillStyle = shade(pal.cap, -0.45); b.fillRect(X, topY - 1, T, 1);            // 1px darker seam beneath
    // THE FACE — per material
    const nextWall = nextSurfaces() && WorldSurface.paintWallTile(b, wallMatOf(e.z), pal.base,
      X, topY, T, h, e.x, { detail: DEPTH.wallDetail });
    if (!nextWall) (WALL_RECIPES[wallMatOf(e.z)] || WALL_RECIPES.plating)(b, pal, X, topY, h, e, n, room, Y + inFace);
    /* THE SEGMENT FRAME (2026-09-03, from the reference): a wall is built of panels, and each panel has a
       thick bevelled edge — lit on top and the west, shaded on the east — that catches the ceiling light
       and separates it from its neighbour. Two tiles per segment. Painted over the recipe so every material
       reads as panels bolted to the frame; `wallDetail` scales it. */
    if (!nextWall && DEPTH.wallDetail > 0.001) {   // generation II owns its panel framing
      const seg = ((e.x % 2) + 2) % 2, wd = Math.max(0, DEPTH.wallDetail);
      const fr = shade(pal.face, 0.22 * wd), fd2 = shade(pal.face, -0.45 * wd), fx = shade(pal.face, -0.62 * wd);
      b.fillStyle = fr; b.fillRect(X, topY + 2, T, 1);                                 // lit top rail of the panel
      if (seg === 0) { b.fillStyle = fx; b.fillRect(X, topY + 2, 1, h - 2); b.fillStyle = fr; b.fillRect(X + 1, topY + 3, 1, h - 4); }   // west edge: dark seam + lit bevel
      else { b.fillStyle = fd2; b.fillRect(X + T - 2, topY + 3, 1, h - 4); b.fillStyle = fx; b.fillRect(X + T - 1, topY + 2, 1, h - 2); }  // east edge: shaded bevel + dark seam
      b.fillStyle = fx; b.fillRect(X, topY + 3 + Math.round((h - 4) * 0.55), T, 1);   // the panel's mid seam
    }
    // FLOOR-CONTACT SEAM. This used to be a LIGHT line (wallTop), which is exactly backwards: a
    // highlight at the junction fuses the wall into the deck. Where a vertical surface meets a
    // horizontal one, no light reaches — it is the darkest line in the room, and it is what tells
    // the eye "the floor stops here".
    b.fillStyle = shade(pal.base, -0.62); b.fillRect(X, Y + inFace, T, 1);
  }

  /* ---------- WALL RECIPES — one per material, each painting ONE tile's interior face ----------
     Signature: (b, pal, X, topY, h, e, n, room, footY). `pal` is the room's derived wall palette,
     `h` the full face height, `footY` the floor-contact row. Every mark is opaque and stepped off
     `pal.face`, deterministic on the tile hash / bake-pixel coords, and scaled by DEPTH.wallDetail
     so 0 gives a flat unadorned face. A recipe owns the face ONLY — never the crown or the foot. */
  const wallDet = () => Math.max(0, DEPTH.wallDetail);

  /* the foot every recipe shares — a graded skirt of shadow pooling where the wall meets the deck.
     Deliberately NOT scaled all the way out by wallDetail: even a "flat" wall must stay seated on
     the floor, and this band is what seats it. Three hard steps, darkest at the contact line. */
  /* ================= THE WALL CRAFT HELPERS (2026-09-03 polish pass) =================
     The three moves that carried the SPINE deck's polish, factored so every recipe gets them and none
     of them has to re-derive the maths:

       faceGrade — A STANDING FACE IS LIT FROM ABOVE. Every recipe painted its face one flat tone top to
         bottom, which is a poster of a wall; a real one takes the ceiling light on its upper third and
         falls away toward the floor. Four hard steps (never a wash — the pixel idiom), lightest at the
         crown, so the wall gains a vertical read at zero mark cost. This is the single biggest of the
         three: it is what makes a 30px face look like a surface in a lit room.
       hairPair — GRAIN IS A PAIR, NOT A LINE. A lighter hairline directly over a darker one is what a
         rolled or brushed surface does under a raking light; a single-tone comb reads as corduroy.
       rivetAt — HARDWARE HAS FOUR PARTS: a countersunk well, a domed head lit north-west, the shadow it
         casts south-east, and a pin. Every recipe here was drawing 1px dots and calling them fixings. */
  function faceGrade(b, tone, X, topY, h, wd) {
    const k = Math.max(0, wd);
    if (k <= 0.001 || h < 6) return;
    const steps = [[0.00, 0.14], [0.26, 0.05], [0.55, -0.03], [0.78, -0.10]];
    for (let i = 0; i < steps.length; i++) {
      const y0 = topY + Math.round(h * steps[i][0]);
      const y1 = topY + (i + 1 < steps.length ? Math.round(h * steps[i + 1][0]) : h);
      if (y1 <= y0) continue;
      b.fillStyle = shade(tone, steps[i][1] * k); b.fillRect(X, y0, T, y1 - y0);
    }
  }
  function hairPair(b, tone, X, y, wd, amt) {
    const a = (amt == null ? 1 : amt) * Math.max(0, wd);
    b.fillStyle = shade(tone, -0.05 * a); b.fillRect(X, y, T, 1);
    b.fillStyle = shade(tone, 0.055 * a); b.fillRect(X, y + 1, T, 1);
  }
  function rivetAt(b, tone, x, y, wd) {
    const k = Math.max(0, wd);
    b.fillStyle = shade(tone, -0.26 * k); b.fillRect(x - 1, y - 1, 4, 4);   // countersunk well
    b.fillStyle = shade(tone, 0.10 * k); b.fillRect(x, y, 2, 2);            // the head
    b.fillStyle = shade(tone, 0.30 * k); b.fillRect(x, y, 1, 1);            // lit north-west crown
    b.fillStyle = shade(tone, -0.30 * k); b.fillRect(x + 1, y + 1, 1, 1);   // its south-east shadow
  }

  function wallFoot(b, tone, X, footY, wd) {
    b.fillStyle = shade(tone, -0.16 - 0.08 * wd); b.fillRect(X, footY - 4, T, 4);
    b.fillStyle = shade(tone, -0.30 - 0.10 * wd); b.fillRect(X, footY - 2, T, 2);
    b.fillStyle = shade(tone, -0.46 - 0.12 * wd); b.fillRect(X, footY - 1, T, 1);
  }

  /* PLATING — the classic standing metal, but no longer starved: the weld line, vent panels and
     conduit drops that used to be gated behind the up>=18 CRT-lab preset (i.e. never rendered in
     the shipped game) now run at any height, plus a mid-height bumper rail that gives a long wall
     a horizon instead of one flat tone. */
  function wallPlating(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const plate = shade(pal.face, ((n % 4) - 1.5) * 0.03 * wd);
    b.fillStyle = plate; b.fillRect(X, topY, T, h);
    faceGrade(b, plate, X, topY, h, wd);                                            // the ceiling's light down the face
    for (let i = 3 + (n % 3); i < h - 4; i += 5) hairPair(b, plate, X, topY + i, wd, 0.8);   // rolled-plate grain
    b.fillStyle = shade(plate, 0.16 * wd); b.fillRect(X, topY, T, 1);               // 1px bright course edge
    wallFoot(b, plate, X, footY, wd);
    // the plate seam gets a bevel ladder like the deck's: dark channel, lit lip beside it
    b.fillStyle = shade(pal.face, -0.42 * wd); b.fillRect(X, topY, 1, h);
    b.fillStyle = shade(plate, 0.16 * wd); b.fillRect(X + 1, topY, 1, h);
    // BUMPER RAIL — a hard horizontal band ~58% down, lit on top. This is the single biggest
    // legibility win on a tall wall: it gives the eye a line to read height against.
    const rail = topY + Math.round(h * 0.58);
    b.fillStyle = shade(plate, -0.26 * wd); b.fillRect(X, rail, T, 2);
    b.fillStyle = shade(plate, 0.14 * wd); b.fillRect(X, rail, T, 1);
    rivetAt(b, plate, X + 3, topY + 3, wd);                                         // real fixings, top and bottom of the plate
    rivetAt(b, plate, X + 3, footY - 6, wd);
    if (h >= 14) {
      b.fillStyle = shade(pal.face, -0.30 * wd); b.fillRect(X, topY + ((h * 0.28) | 0), T, 1);      // weld line
      if (room && n % 9 === 0) {                                                     // recessed vent panel
        b.fillStyle = shade(pal.face, -0.55 * wd); b.fillRect(X + 6, topY + 3, 5, 6);
        b.fillStyle = shade(pal.face, -0.72 * wd);
        for (let i = 0; i < 3; i++) b.fillRect(X + 7, topY + 4 + i * 2, 3, 1);
      } else if (n % 11 === 3) {                                                     // pale conduit drop
        b.fillStyle = shade(pal.face, 0.20 * wd); b.fillRect(X + 2, topY + 2, 1, h - 6);
      }
    }
  }

  /* RIBBED — vertical structural ribs on a 4px pitch, each a lit column beside a deep channel.
     The strongest vertical rhythm of any recipe; reads as engine-room / pressure bulkhead. */
  function wallRibbed(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const body = shade(pal.face, ((n % 3) - 1) * 0.02 * wd);
    b.fillStyle = body; b.fillRect(X, topY, T, h);
    faceGrade(b, body, X, topY, h, wd);
    /* A RIB IS ROUND. Four tones across its 4px pitch instead of three — deep channel, lit crest,
       the crest's own falloff, then the shaded flank — so the section reads as a half-round
       extrusion rather than a stripe. */
    for (let i = 0; i < T; i += 4) {
      b.fillStyle = shade(body, -0.40 * wd); b.fillRect(X + i, topY, 1, h);        // deep channel
      b.fillStyle = shade(body, 0.22 * wd); b.fillRect(X + i + 1, topY, 1, h);     // lit crest
      b.fillStyle = shade(body, 0.06 * wd); b.fillRect(X + i + 2, topY, 1, h);     // crest falloff
      b.fillStyle = shade(body, -0.16 * wd); b.fillRect(X + i + 3, topY, 1, h);    // shaded flank
    }
    if (h >= 20) for (let rx = 1; rx < T; rx += 4) rivetAt(b, body, X + rx, topY + Math.round(h * 0.20), wd);   // a fixing row across the ribs
    // top and bottom rails cap the ribs so they don't float
    b.fillStyle = shade(body, 0.12 * wd); b.fillRect(X, topY, T, 2);
    b.fillStyle = shade(body, 0.20 * wd); b.fillRect(X, topY, T, 1);
    const rail = topY + Math.round(h * 0.62);
    b.fillStyle = shade(body, -0.28 * wd); b.fillRect(X, rail, T, 2);
    b.fillStyle = shade(body, 0.10 * wd); b.fillRect(X, rail, T, 1);
    wallFoot(b, body, X, footY, wd);
  }

  /* PANEL — one large recessed panel per tile: inset border, lit inner top-left bevel, shaded
     bottom-right. The finished command-deck read; deliberately the calmest recipe. */
  function wallPanelled(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const body = shade(pal.face, ((n % 3) - 1) * 0.018 * wd);
    b.fillStyle = body; b.fillRect(X, topY, T, h);
    faceGrade(b, body, X, topY, h, wd);
    b.fillStyle = shade(body, -0.38 * wd); b.fillRect(X, topY, 1, h);              // tile seam
    b.fillStyle = shade(body, 0.14 * wd); b.fillRect(X + 1, topY, 1, h);           // its lit lip
    const pTop = topY + 2, pH = Math.max(4, h - 6);
    b.fillStyle = shade(body, -0.20 * wd); b.fillRect(X + 2, pTop, T - 4, pH);     // recess
    b.fillStyle = shade(body, 0.06 * wd); b.fillRect(X + 3, pTop + 1, T - 6, pH - 2);
    b.fillStyle = shade(body, 0.18 * wd); b.fillRect(X + 3, pTop + 1, T - 6, 1);   // lit inner top
    b.fillStyle = shade(body, 0.14 * wd); b.fillRect(X + 3, pTop + 1, 1, pH - 2);  // lit inner left
    b.fillStyle = shade(body, -0.24 * wd); b.fillRect(X + T - 4, pTop + 1, 1, pH - 2);
    b.fillStyle = shade(body, -0.24 * wd); b.fillRect(X + 3, pTop + pH - 2, T - 6, 1);
    b.fillStyle = shade(body, 0.22 * wd); b.fillRect(X, topY, T, 1);               // trim line along the run
    rivetAt(b, body, X + 4, pTop + 2, wd); rivetAt(b, body, X + T - 6, pTop + pH - 5, wd);   // the panel's own fixings
    wallFoot(b, body, X, footY, wd);
  }

  /* VIEWPORT — the only recipe that does not paint a wall: it CUTS one. The glass band is cleared
     to transparent so the live drifting starfield behind the station shows through the hole (see
     buildLightMap, which also punches the ambient mask here or the sky would render at 23%).
     Baked stars would be a lie — the real sky is already back there, and it moves. */
  function wallViewport(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const body = shade(pal.face, ((n % 3) - 1) * 0.02 * wd);
    b.fillStyle = body; b.fillRect(X, topY, T, h);
    const gTop = topY + 3, gH = Math.max(3, h - 9);
    b.clearRect(X + 1, gTop, T - 1, gH);                     // THE HOLE — 1px left mullion kept per tile
    viewportRects.push({ x: X + 1, y: gTop, w: T - 1, h: gH });
    // Transparent cold glass: the actual sky stays visible behind a restrained edge catch.
    b.fillStyle = 'rgba(92,145,167,0.035)'; b.fillRect(X+1,gTop,T-1,gH);
    b.fillStyle = 'rgba(163,199,211,0.10)'; b.fillRect(X+1,gTop,1,gH);
    b.fillStyle = 'rgba(163,199,211,0.07)'; b.fillRect(X+2,gTop,T-3,1);
    // frame: bright sill under the glass, shaded head above, mullion at the tile seam
    b.fillStyle = shade(body, -0.40 * wd); b.fillRect(X, gTop - 1, T, 1);          // head shadow
    b.fillStyle = shade(body, 0.26 * wd); b.fillRect(X, gTop + gH, T, 2);          // lit sill
    b.fillStyle = shade(body, 0.34 * wd); b.fillRect(X, gTop + gH, T, 1);
    b.fillStyle = shade(body, 0.10 * wd); b.fillRect(X, gTop, 1, gH);              // mullion
    wallFoot(b, body, X, footY, wd);
  }

  /* PIPEWORK — plating overrun with conduit: vertical pipe runs with a lit highlight column, a
     horizontal cable tray, and the occasional valve block. The utility/engine-room read. */
  function wallPipework(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const body = shade(pal.face, ((n % 4) - 1.5) * 0.025 * wd);
    b.fillStyle = body; b.fillRect(X, topY, T, h);
    faceGrade(b, body, X, topY, h, wd);
    b.fillStyle = shade(body, -0.30 * wd); b.fillRect(X, topY, 1, h);
    /* A PIPE IS A CYLINDER: dark contact shadow, body, a hot specular column one pixel off the lit
       edge, then the terminator — plus RINGED COUPLINGS down its length, which is the detail the
       reference art carries and the thing that says "pipe" rather than "stripe". */
    const pipe = (px, w) => {
      b.fillStyle = shade(body, -0.40 * wd); b.fillRect(X + px, topY, w, h);       // shadow side / contact
      b.fillStyle = shade(body, -0.10 * wd); b.fillRect(X + px + 1, topY, w - 1, h);
      b.fillStyle = shade(body, 0.30 * wd); b.fillRect(X + px + 1, topY, 1, h);    // specular column
      b.fillStyle = shade(body, -0.52 * wd); b.fillRect(X + px + w - 1, topY, 1, h);   // terminator
      for (let cy = topY + 5 + (n % 5); cy < topY + h - 3; cy += 11) {             // couplings
        b.fillStyle = shade(body, 0.16 * wd); b.fillRect(X + px - 1, cy, w + 2, 2);
        b.fillStyle = shade(body, -0.34 * wd); b.fillRect(X + px - 1, cy + 2, w + 2, 1);
      }
    };
    pipe(2 + (n % 2), 3);
    if (n % 3 !== 0) pipe(8, 2);
    const tray = topY + Math.round(h * 0.66);                                        // horizontal cable tray
    b.fillStyle = shade(body, -0.38 * wd); b.fillRect(X, tray, T, 3);
    b.fillStyle = shade(body, 0.16 * wd); b.fillRect(X, tray, T, 1);
    if (n % 7 === 2) {                                                               // valve block
      b.fillStyle = shade(body, 0.10 * wd); b.fillRect(X + 1 + (n % 2), topY + 4, 5, 4);
      b.fillStyle = shade(body, -0.44 * wd); b.fillRect(X + 2 + (n % 2), topY + 5, 3, 1);
    }
    wallFoot(b, body, X, footY, wd);
  }

  /* WAINSCOT — timber panelling to the chair rail, plain wall above. The warm habitat recipe; the
     board pitch is 3px so it reads as narrower boards than the PLANK floor's, which stops a
     wainscot wall above a plank deck from looking like one continuous surface. */
  function wallWainscot(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const upper = shade(pal.face, 0.10 * wd);
    b.fillStyle = upper; b.fillRect(X, topY, T, h);                                  // plain plaster above
    faceGrade(b, upper, X, topY, h, wd * 0.7);                                       // plaster takes the light too
    b.fillStyle = shade(upper, -0.08 * wd); b.fillRect(X, topY, 1, h);
    const railY = topY + Math.round(h * 0.42);
    const boardTop = railY + 2;
    b.fillStyle = shade(pal.face, -0.10 * wd); b.fillRect(X, boardTop, T, footY - boardTop);
    for (let i = 0; i < T; i += 3) {                                                 // vertical boards
      const bn = h2(e.x * 4 + i, e.y, 'wsc');
      b.fillStyle = shade(pal.face, (((bn % 5) - 2) * 0.020 - 0.10) * wd); b.fillRect(X + i, boardTop, 3, footY - boardTop);
      b.fillStyle = shade(pal.face, -0.36 * wd); b.fillRect(X + i, boardTop, 1, footY - boardTop);      // board seam
      b.fillStyle = shade(pal.face, 0.04 * wd); b.fillRect(X + i + 1, boardTop, 1, footY - boardTop);   // lit face
      if (bn % 4 === 0) b.fillStyle = shade(pal.face, -0.18 * wd), b.fillRect(X + i + 1, boardTop + 2 + (bn % 4), 1, 2);  // grain fleck
    }
    // THE CHAIR RAIL IS MOULDING, not a line: a lit top edge, a body, and the shadow it throws on
    // the boards under it — three steps is what turns a stripe into a piece of trim.
    b.fillStyle = shade(pal.face, 0.32 * wd); b.fillRect(X, railY - 1, T, 1);      // lit top edge
    b.fillStyle = shade(pal.face, 0.10 * wd); b.fillRect(X, railY, T, 1);          // the moulding face
    b.fillStyle = shade(pal.face, -0.40 * wd); b.fillRect(X, railY + 1, T, 1);     // its shadow on the boards
    wallFoot(b, pal.face, X, footY, wd);
  }

  /* HEDGE — a living wall. Same principle as the TURF deck: NO lattice, no seams, no bevels; the
     read comes from dense blade scatter alone, darker toward the base where light doesn't reach. */
  function wallHedge(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    // foliage lifts go through vivid() for the same reason the TURF deck's do: U.shade would take
    // the lit leaves toward white and the hedge would read as a grey bush.
    const body = shade(pal.base, -0.34 * wd);
    b.fillStyle = body; b.fillRect(X, topY, T, h);
    const LEAF = [shade(pal.base, -0.20 * wd), vivid(pal.base, 0.10 * wd), vivid(pal.base, 0.30 * wd), vivid(pal.base, 0.50 * wd)];
    const leaves = Math.max(8, Math.round(T * h / 6));
    for (let i = 0; i < leaves; i++) {
      const r = hp(X, topY, i);
      const ly = (r >>> 5) % h;
      // darker toward the base, where light doesn't reach into the foliage
      const k = 1 - 0.45 * (ly / Math.max(1, h));
      b.fillStyle = shade(LEAF[(r >>> 11) & 3], -(1 - k) * 0.5);
      b.fillRect(X + (r % T), topY + ly, 1, Math.min(1 + ((r >>> 14) % 2), h - ly));
    }
    b.fillStyle = vivid(pal.base, 0.62 * wd); b.fillRect(X + (hp(X, topY, 91) % T), topY, 1, 2);   // lit crown sprig
    wallFoot(b, body, X, footY, wd);
  }

  /* ---------- BASE-WALL CANDIDATES (2026-07-25) ----------
     `plating` is dated in exactly the ways `plate` was, plus one of its own:
       1. ONE SEAM PER TILE. A 24px cell repeated the length of the room, every cell the same
          width — the wall reads as bathroom tile, not as a built bulkhead.
       2. FEATURES PLACED AT RANDOM. The rivet, the vent panel and the conduit drop are all
          `n % k` on the tile hash, so they land wherever and mean nothing.
       3. NO DEPTH. Every mark is painted ON one flat plane. Nothing is in front of anything
          else, so a 23px-tall face has no structure to read — one rail carries the whole wall.
     The fixes are the deck's: rhythm at a WIDER interval than the tile, features on a LOGIC, and
     a hierarchy — structure first, then panel, then rail, then grain. All three keep the crown,
     the foot and the contact seam untouched (a recipe owns the face only) and scale by wallDetail.

     Vertical budget is tight: h = WALL.up + NFACE = 23px, of which the bottom 4 are the foot
     shadow. Detail finer than ~3px does not survive the ambient bake — go coarse. */

  /* A · BULKHEAD — a raised STANCHION every 3 tiles instead of a seam every tile, with one wide
     recessed infill panel spanning the bay between them. The stanchion is the wall's structure:
     it carries the fixings (a bolt at head and foot, nowhere else), and the bumper rail BREAKS at
     it, so the rail reads as segments held between columns rather than a stripe painted over
     everything. Gives the wall the vertical rhythm the SPINE deck deliberately lacks. */
  /* the pilaster every BULKHEAD variant shares: a raised column standing in front of the infill.
     It STARTS BELOW THE CROWN and stays dimmer than it — drawn from topY with a bright edge it
     read as a fence post standing ON the wall top at room scale, because the crown is the
     brightest continuous line in the room and anything vertical touching it joins it. */
  function wallPilaster(b, sh, X, topY, footY, w, bolts) {
    const px = (a, c, wd_, ht, col) => { b.fillStyle = col; b.fillRect(a, c, wd_, ht); };
    const sy = topY + 2, ht = footY - sy;
    px(X, sy, w, ht, sh(0.05));                                                        // column body, in front
    px(X, sy, 1, ht, sh(-0.32));                                                       // its cast shadow
    px(X + w - 1, sy, 1, ht, sh(0.11));                                                // its lit edge
    if (bolts) {
      const bolt = (by) => { px(X + 1, by, 2, 2, sh(0.13)); px(X + 2, by + 1, 1, 1, sh(-0.24)); };
      bolt(sy + 2); bolt(footY - 8);                                                   // head and foot only
    }
  }

  /* BULKHEAD — the base wall since 2026-07-25, replacing `plating`. A slim pilaster every 2 tiles
     and NOTHING between them: the bay is left flush, the rail runs unbroken, and the rhythm of the
     columns alone carries the wall.

     Three versions were built and Andrew picked this one. The other two put work INTO the bay — a
     framed recess in one, two riveted courses in the other — and both lost to the empty bay. That
     is the lesson worth keeping: on a face only 23px tall with a bright crown above it and a
     shadowed foot below, the wall has room for ONE idea. Adding a second thing between the columns
     competes with the columns instead of supporting them. If you are tempted to dress this bay,
     render a whole room first and compare it against this. */
  function wallBulkhead(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const px = (a, c, w, ht, col) => { b.fillStyle = col; b.fillRect(a, c, w, ht); };
    const bay = Math.floor(e.x / 2), tx = ((e.x % 2) + 2) % 2;      // tx 0 = the pilaster tile
    const body = shade(pal.face, ((h2(bay, e.y, 'bht') % 5) - 2) * 0.014 * wd);
    const sh = d => shade(body, d * wd);
    /* THE FACE HAS A LIGHT ON IT (2026-09-03 depth pass). One flat tone top to bottom is a poster of a wall;
       a standing face is lit from the ceiling and falls off toward the floor. Three hard steps — the pixel
       idiom, never a wash — top third lifted, middle at body, lower third shaded, then the foot. */
    const t1 = topY + Math.round(h * 0.34), t2 = topY + Math.round(h * 0.66);
    px(X, topY, T, t1 - topY, sh(0.09));
    px(X, t1, T, t2 - t1, body);
    px(X, t2, T, footY - t2, sh(-0.07));
    wallFoot(b, body, X, footY, wd);                                                  // seated first, marks over it
    px(X, topY + 1, T, 1, sh(0.16));                                                  // a single lit line under the crown
    // CABLE TRAY — a conduit run just under the crown, clipped every tile: the one detail a station wall
    // always has, and the horizontal that reads the wall's length
    px(X, topY + 4, T, 2, sh(-0.30)); px(X, topY + 4, T, 1, sh(0.06)); px(X + 5, topY + 3, 2, 4, sh(-0.42));
    const rail = topY + Math.round(h * 0.62);
    px(X, rail, T, 2, sh(-0.22));
    px(X, rail, T, 1, sh(0.11));
    if (tx === 0) wallPilaster(b, sh, X, topY, footY, 3, false);
    else if (h >= 20) {
      const k = h2(e.x, e.y, 'bkd') % 6;
      if (k === 0) {                                                                  // recessed vent panel
        px(X + 3, topY + 9, 7, 7, sh(-0.5)); px(X + 3, topY + 9, 7, 1, sh(-0.62));
        for (let i = 0; i < 3; i++) {
          px(X + 4, topY + 11 + i * 2, 5, 1, sh(-0.24));
          px(X + 4, topY + 10 + i * 2, 4, 1, sh(0.05)); // louvre upper edges
        }
        px(X+3,topY+15,1,1,sh(0.16));px(X+9,topY+10,1,1,sh(-0.28));
      } else if (k === 1) {                                                           // conduit drop with a junction box
        px(X + 4, topY + 6, 1, footY - topY - 10, sh(-0.36)); px(X + 5, topY + 6, 1, footY - topY - 10, sh(0.05));
        px(X + 3, topY + 12, 4, 3, sh(-0.2)); px(X + 4, topY + 13, 1, 1, sh(0.3));
      } else if (k === 2) {                                                           // an access panel with a status lamp
        px(X + 2, rail - 9, 8, 6, sh(-0.35)); // gasket around a service door
        px(X + 3, rail - 8, 6, 4, sh(-0.10));
        px(X + 3, rail - 4, 6, 1, sh(0.12));
        px(X + 7, rail - 7, 1, 2, sh(-0.48));px(X + 8, rail - 7, 1, 1, sh(0.18));
        px(X + 3, rail - 7, 2, 1, sh(0.06));
      }
    }
  }

  /* B · COURSES — riveted hull plating, all horizontal: three stacked courses, each with a lit top
     lip over a shadowed underside, and vertical butt joints every 4 tiles STAGGERED course to
     course so no joint runs the full height. Rivets march along each lip on a fixed 6px pitch —
     a row of fixings, not a sprinkle. The calm option; it never competes with a prop. */
  function wallCourses(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const px = (a, c, w, ht, col) => { b.fillStyle = col; b.fillRect(a, c, w, ht); };
    const usable = (footY - 4) - topY;
    const cuts = [0, Math.round(usable * 0.36), Math.round(usable * 0.70)];
    for (let ci = 0; ci < cuts.length; ci++) {
      const y0 = topY + cuts[ci], y1 = topY + (ci + 1 < cuts.length ? cuts[ci + 1] : usable);
      const cn = h2(Math.floor((e.x - ci * 2) / 4), ci, 'crs');
      const body = shade(pal.face, (((cn % 5) - 2) * 0.018 - ci * 0.035) * wd);     // lower courses darker
      const sh = d => shade(body, d * wd);
      px(X, y0, T, y1 - y0, body);
      faceGrade(b, body, X, y0, y1 - y0, wd * 0.55);                                  // each course takes its own light
      px(X, y0, T, 1, sh(0.20));                                                      // lit course lip
      px(X, y0 + 1, T, 1, sh(0.07));                                                  // its falloff
      px(X, y1 - 2, T, 1, sh(-0.18));                                                 // the underside's own step
      px(X, y1 - 1, T, 1, sh(-0.34));                                                 // shadowed underside
      if ((((e.x - ci * 2) % 4) + 4) % 4 === 0) {                                     // staggered butt joint
        px(X, y0, 1, y1 - y0, sh(-0.34));
        px(X + 1, y0, 1, y1 - y0, sh(0.09));
      }
      // rivet row on the lip. Pitch 8 not 6 and lift 0.15 not 0.22: at room scale a tighter,
      // brighter row stops reading as fixings and starts reading as perforation.
      for (let rx = 4; rx < T; rx += 8) rivetAt(b, body, X + rx, y0 + 3, wd * 0.8);
    }
    wallFoot(b, pal.face, X, footY, wd);
  }

  /* C · SERVICE — big calm panels carrying ONE composed horizontal service run: a conduit at a
     fixed height with brackets every 2 tiles and a junction box every 4th, so a feature appears
     because a run passes through, never because a hash said so. The wall equivalent of the deck's
     original idea, kept HORIZONTAL — a run along the wall's length is one line the whole room
     shares, which is what the vertical trenches on the deck failed to be. */
  function wallService(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const px = (a, c, w, ht, col) => { b.fillStyle = col; b.fillRect(a, c, w, ht); };
    const pan = Math.floor(e.x / 4), lx = ((e.x % 4) + 4) % 4;
    const body = shade(pal.face, ((h2(pan, e.y, 'svc') % 5) - 2) * 0.015 * wd);
    const sh = d => shade(body, d * wd);
    px(X, topY, T, h, body);
    faceGrade(b, body, X, topY, h, wd);
    for (let i = 4; i < h - 5; i += 5) hairPair(b, body, X, topY + i, wd, 0.7);        // grain, paired
    if (lx === 0) { px(X, topY, 1, h, sh(-0.40)); px(X + 1, topY, 1, h, sh(0.14)); }   // panel joint every 4 tiles
    if (lx === 0 && h >= 20) { rivetAt(b, body, X + 3, topY + 4, wd); rivetAt(b, body, X + 3, footY - 7, wd); }
    const run = topY + Math.round(h * 0.34);                                          // THE SERVICE RUN
    px(X, run, T, 3, sh(-0.20));
    px(X, run, T, 1, sh(-0.34));                                                      // its shadowed top
    px(X, run + 2, T, 1, sh(0.15));                                                   // catch-lit underside
    if (lx % 2 === 0) { px(X + 5, run - 1, 2, 5, sh(-0.28)); px(X + 5, run - 1, 2, 1, sh(0.12)); }  // bracket
    if (lx === 2 && room) {                                                            // junction box ON the run
      px(X + 9, run - 2, 7, 7, sh(0.04));                                              // 7x7, not 8x9: a 23px
      px(X + 9, run - 2, 7, 1, sh(0.16));                                              // face cannot carry a
      px(X + 9, run + 4, 7, 1, sh(-0.32));                                             // box a third of its height
      px(X + 11, run + 1, 3, 1, sh(-0.24));
    }
    const rail = topY + Math.round(h * 0.72);                                          // bumper rail, kept
    px(X, rail, T, 2, sh(-0.22));
    px(X, rail, T, 1, sh(0.12));
    wallFoot(b, body, X, footY, wd);
  }

  const WALL_RECIPES = {
    plating: wallPlating, ribbed: wallRibbed, panelled: wallPanelled,
    viewport: wallViewport, pipework: wallPipework, wainscot: wallWainscot, hedge: wallHedge,
    bulkhead: wallBulkhead, courses: wallCourses, service: wallService
  };

  /* ---------------- THE SIDE FACE — the same inner face, seen foreshortened ----------------
     Read the ladder bakeWalls documents for an e/w edge, outward from the deck:

         contact seam · INNER FACE · dark under-seam · CROWN · lit outer edge · hull

     The CROWN is the wall's top surface and is rightly plain — you do not see coursing looking down
     at a wall's cap. But the band inside it is not the crown: it is the wall's own INNER FACE, the
     identical surface `bakeTallNorthFace` hands to WALL_RECIPES, just foreshortened to `FACEW` px
     because you are looking down its length instead of square at it. It was painted as one flat
     `pal.face` fill plus a single rib line, so three of a room's four walls carried the room's HUE
     (that part was already right) but none of its MATERIAL — RIBBED, COURSES and WAINSCOT all met
     the north wall's corner as the same blank strip.

     I argued this surface should stay plain and was wrong; Andrew pushed back and the ladder above
     is why he was right. What is true is only that it cannot be the north recipe run sideways —
     4px of depth cannot hold a squashed 23px face, and squashing one produces mush. So the edge is
     AUTHORED per material instead: a depth ramp that gives the face thickness, plus the material's
     own rhythm along the wall's length. Same discipline as the hull's `dress`/`veins` split.

     COORDINATES ARE (depth, along), never (x, y) — `put` maps them per side. `d` is 0 at the wall's
     TOP edge (the crown side) and grows toward the floor contact; `a` runs along the wall's length.
     That is what lets one painter serve west, east, south and an interior north seam, each of which
     points its depth axis a different way. */
  /* ================= THE FACE STRIP — the straight wall's OWN pixels, sampled =================
     2026-08-05, Andrew on the corner: "the textures are completely different, they do not blend
     whatsoever, its literally entirely different set of graphics ... it should literally appear like
     its the wall, but just continuing on."

     He is right and the cause was architectural, not a tuning miss. The corner and the side band were
     painted from WALL_EDGES — a hand-authored vocabulary meant to RESEMBLE each recipe. An imitation
     never converges: the straight wall is `wallRibbed`'s actual tones and structure, the corner was
     my approximation of them, and two different pictures meeting at a seam is exactly what you see.

     So the curved and foreshortened surfaces no longer imitate anything. The recipe is rendered ONCE
     into an offscreen strip a few tiles wide, and every other surface SAMPLES it:
       · the straight north face  — the recipe, drawn directly (unchanged);
       · the tall corner face     — strip rows 0..len, sampled along the ARC;
       · the foreshortened side   — strip rows 0..fw, sampled along the wall.
     All three are then literally the same graphics, differing only in how much of the face's depth
     is visible and where the along-axis runs. That is what "the wall, just continuing on" means.

     ONE STRIP PER (MATERIAL, HUE, HEIGHT) — NOT PER TILE. The first cut anchored each strip on the
     tile that asked for it, so every wall edge allocated a canvas and a getImageData and the bake ran
     5-7x slower (51ms -> 291ms on an eight-room station, measured). The tile origin only decides
     WHICH tile's hash supplies the scatter detail — rivets, wear specks — while everything
     structural (ribs, courses, plate seams, rails) is T-periodic and therefore identical in every
     tile. The arc's own anchor `ax` is a tile boundary, so sampling still lands rib-aligned with the
     straight wall it joins. A fixed origin costs nothing visible and gives back the whole regression.

     `viewportRects` is saved and restored: wallViewport CUTS glass and records the hole, and a strip
     render must never inject phantom windows into the live bake (same guard sampleWall uses). */
  const STRIP_TILES = 4;
  let stripCache = null;
  function faceStrip(matId, pal, h) {
    const key = matId + '|' + pal.base + '|' + h;
    const tx0 = 0, ty = 0;
    if (stripCache && stripCache.has(key)) return stripCache.get(key);
    let strip = null;
    const prevRects = viewportRects;
    try {
      const w = STRIP_TILES * T;
      const cv = canvas(w, h);
      const g = cv.getContext('2d');
      if (typeof g.getImageData === 'function') {
        g.imageSmoothingEnabled = false;
        viewportRects = [];
        const recipe = WALL_RECIPES[matId] || WALL_RECIPES.plating;
        for (let i = 0; i < STRIP_TILES; i++) {
          const tx = tx0 + i;
          if (!(nextSurfaces() && WorldSurface.paintWallTile(g, matId, pal.base, i * T, 0, T, h, tx, { detail: DEPTH.wallDetail })))
            recipe(g, pal, i * T, 0, h, { x: tx, y: ty, z: null }, h2(tx, ty, 'nwall'), true, h);
        }
        // Curved/side faces are solid structure, not additional windows. Glass
        // edge tints carry low alpha; reading their RGB as opaque paint made
        // these faces bright cyan. Composite them over their own wall metal
        // before sampling, while the straight window keeps its real sky hole.
        if (matId === 'viewport') {
          g.globalCompositeOperation = 'destination-over';
          g.fillStyle = pal.face; g.fillRect(0, 0, w, h);
          g.globalCompositeOperation = 'source-over';
        }
        const img = g.getImageData(0, 0, w, h);
        strip = { d: img.data, w, h, x0: tx0 * T };
      }
    } catch (err) { strip = null; }
    finally { viewportRects = prevRects; }
    if (!stripCache) stripCache = new Map();
    stripCache.set(key, strip);
    return strip;
  }
  /* sample the strip at a WORLD along-coordinate and a depth row. Returns null where the recipe left
     the pixel transparent — VIEWPORT's glass — so a hole stays a hole instead of becoming grey. */
  function stripAt(strip, alongWorld, row) {
    // callers hand in already-quantized addresses (see faceMap) — never round again here, or a
    // polar address gets quantized twice and beats against itself
    const sx = (((Math.floor(alongWorld) - strip.x0) % strip.w) + strip.w) % strip.w;
    const sy = Math.max(0, Math.min(strip.h - 1, Math.floor(row)));
    const i = ((sy * strip.w + sx) << 2), d = strip.d;
    return d[i + 3] ? 'rgb(' + d[i] + ',' + d[i + 1] + ',' + d[i + 2] + ')' : null;
  }

  /* `runs` are depths in PIXELS, for the ~4px foreshortened side band. `deepRuns` are FRACTIONS of
     the face depth, for the tall curving corner face, which runs ~23px at the top of the arc and a
     couple at its foot — a rail pinned to an absolute depth would slide off the wall as it narrows.
     `grain` is a concentric pitch for the materials whose straight recipe carries horizontal grain.
     Every value below is read off the material's own recipe, so the corner continues what the
     straight wall is already doing rather than inventing a second vocabulary. */
  const WALL_EDGES = {
    bulkhead:  { pitch: 12, joint: -0.30, deepRuns: [[0.34, -0.16]] },
    courses:   { pitch: 6,  joint: -0.34, grain: 6 },
    service:   { pitch: 12, joint: -0.26, runs: [[1, 0.16]], grain: 5 },    // the conduit that rides the wall
    plating:   { pitch: 12, joint: -0.30, runs: [[0, 0.14]], deepRuns: [[0.55, -0.26], [0.60, 0.14]] },
    ribbed:    { pitch: 4,  joint: -0.36, litNext: 0.16, deepRuns: [[0.72, -0.28]] },   // the tightest rhythm in the set
    panelled:  { pitch: 12, joint: -0.32, runs: [[1, -0.18]], deepRuns: [[0.28, -0.20], [0.78, -0.20]] },
    viewport:  { pitch: 12, joint: -0.20, glass: true },                    // dark cool glazing
    pipework:  { pitch: 6,  joint: -0.24, runs: [[1, 0.12], [2, -0.20]], deepRuns: [[0.44, 0.14]] },
    wainscot:  { pitch: 12, joint: -0.28, runs: [[2, 0.20]], deepRuns: [[0.62, 0.20], [0.68, -0.24]] },  // the dado rail
    hedge:     { pitch: 0,  speck: true }
  };

  /* Paint one side face. `w`×`h` is the strip in bake pixels; `axis` says which way depth runs and
     `dir` which end of it is the wall's TOP:
       axis 'x' → depth along x (west/east)      axis 'y' → depth along y (south / interior north)
       dir  +1  → depth grows with the coord     dir  -1  → depth grows against it
     Marks along the wall are phase-locked to ABSOLUTE world coords so a joint runs unbroken across
     tile boundaries — the old per-tile `Y + 5` rib restarted at every tile, which is invisible at
     pitch 12 and would have been a picket fence at RIBBED's pitch 4. */
  function bakeSideFace(b, pal, matId, x, y, w, h, axis, dir, strip) {
    const ed = WALL_EDGES[matId] || WALL_EDGES.bulkhead;
    const depth = axis === 'x' ? w : h, len = axis === 'x' ? h : w;
    if (depth <= 0 || len <= 0) return;
    if (strip) {
      /* THE WALL'S OWN PIXELS AGAIN — rows 0..depth of the same strip the tall face and the corner
         use, so a side wall is the top few rows of the very material the north wall shows, and the
         three surfaces cannot drift apart. Depth 0 is the row just under the crown either way. */
      const put = (d, a, color) => {
        b.fillStyle = color;
        const dd = dir > 0 ? d : depth - 1 - d;
        if (axis === 'x') b.fillRect(x + dd, y + a, 1, 1); else b.fillRect(x + a, y + dd, 1, 1);
      };
      const o = axis === 'x' ? y : x;
      for (let a = 0; a < len; a++) for (let d = 0; d < depth; d++) {
        const c = stripAt(strip, o + a, d);
        if (c !== null) put(d, a, c);
      }
      return;
    }
    const put = (d, a, n, color) => {
      b.fillStyle = color;
      const dd = dir > 0 ? d : depth - 1 - d;
      if (axis === 'x') b.fillRect(x + dd, y + a, 1, n);
      else b.fillRect(x + a, y + dd, n, 1);
    };
    const a0 = axis === 'x' ? y : x;                       // this strip's absolute along-origin
    /* the depth ramp: lightest at the top edge where the ceiling light lands, falling to the floor
       contact. This is what makes 4px read as a surface with thickness instead of a stripe. */
    const base = ed.glass ? shade(pal.base, -0.55) : pal.face;
    for (let d = 0; d < depth; d++) {
      const t = depth === 1 ? 0 : d / (depth - 1);
      put(d, 0, len, shade(base, 0.12 - 0.38 * t));
    }
    if (ed.speck) {                                        // foliage: no rhythm at all, just density
      for (let a = 0; a < len; a++) for (let d = 0; d < depth; d++) {
        const r = h2(a0 + a, d, 'wedge');
        if (r % 3 === 0) put(d, a, 1, shade(base, 0.18));
        else if (r % 5 === 0) put(d, a, 1, shade(base, -0.26));
      }
      return;
    }
    for (const [d, lift] of (ed.runs || [])) {             // continuous lines running the wall's length
      if (d < depth) put(d, 0, len, shade(base, lift));
    }
    if (ed.pitch > 0) {                                    // the material's rhythm, across the depth
      const first = a0 - ((a0 % ed.pitch) + ed.pitch) % ed.pitch;
      for (let wa = first; wa < a0 + len; wa += ed.pitch) {
        const a = wa - a0;
        if (a < 0) continue;
        for (let d = 0; d < depth; d++) put(d, a, 1, shade(base, ed.joint));
        if (ed.litNext && a + 1 < len) for (let d = 0; d < depth; d++) put(d, a + 1, 1, shade(base, ed.litNext));
      }
    }
  }

  /* ---------------- HULL RECIPES — the materials of the exterior shell ----------------
     Contract, deliberately mirroring WALL_RECIPES so the two axes stay learnable together:

       dress(b, pal, x, y, w, h)     the texture over ONE footprint's hull plate. The caller clips to
                                     that rect AND sets source-atop, so a mark can never land on a
                                     spandrel the corner pass erased. Key every mark on ABSOLUTE bake
                                     coords — a mark keyed on its offset within the rect renders
                                     differently in a chunk bake than a monolithic one, which is the
                                     one bug this whole module's parity test exists to catch.
       rim(b, pal, x1, y1, x2, y2)   the frame around that footprint (source-atop, same reason).
       bands(pal, skirt)             the skirt's DEPTH ramp — six stops, no texture. See ramp6.
       veins(fg, pal, w, h, vx, vy, topOf)
                                     optional pass over the FINISHED skirt (source-atop, canvas-local
                                     coords; add vx/vy to key marks on world coords). `topOf[x]` is
                                     the row that column's wall starts at — index rows from it, via
                                     coursedVein/wallRuns, and the material FOLLOWS the hull's
                                     rounded corners instead of being sliced by them (see skirtTops).

     WHERE TO SPEND THE DETAIL: the plate ring is `pad` = 7px read from straight above; the skirt is
     32px and faces the camera. The skirt IS the material — it is the surface in Andrew's screenshot
     with a circle round it. A recipe that dresses the ring beautifully and leaves the skirt a flat
     ramp has skinned the part nobody looks at. */

  // shared: a hard 1px horizontal course line, phase-locked to ABSOLUTE y so neighbouring footprints
  // of the same material read as one continuous course rather than two walls that nearly line up
  const courseAt = (y, pitch) => y - ((y % pitch) + pitch) % pitch;
  /* A CLAMPED FILL. Every recipe paints on a grid, and a grid's last cell always half-hangs off the
     box it was asked to fill. In the bake a clip absorbs that — but the REFIT palette chip has no
     clip, so an unclamped recipe bleeds its texture over the chip's edge and, on the skirt, paints a
     row below the wall's own bottom. Cheap to get right; caught three recipes at once. */
  const boxed = (b, x0, y0, x1, y1) => (x, y, w, h) => {
    const ax = Math.max(x0, x), ay = Math.max(y0, y), bx = Math.min(x1, x + w), by = Math.min(y1, y + h);
    if (bx > ax && by > ay) b.fillRect(ax, ay, bx - ax, by - ay);
  };

  // armour-plate pitch. Deliberately more than double BRICK's course: at this scale plate SIZE is
  // what separates an engineered hull from masonry, and 11 fits three strakes in the 32px skirt.
  const STRAKE = 11;
  const hullStation = {
    // the shell's own ladder rather than the shared derivation — see hullStationPal. This is what
    // let the pre-axis constants retire without every built station changing appearance.
    pal: hullStationPal,
    // the panel seam grid — the shipped shell, phase-locked to the same world grid it always used
    // (lines at x = 5 + 28k, y = 9 + 26k), so a re-clad station and an untouched one still align.
    dress(b, pal, x, y, w, h) {
      b.strokeStyle = pal.seam; b.lineWidth = 1;
      for (let gx = 5 + Math.ceil((x - 5) / 28) * 28; gx < x + w; gx += 28) { b.beginPath(); b.moveTo(gx + .5, y); b.lineTo(gx + .5, y + h); b.stroke(); }
      for (let gy = 9 + Math.ceil((y - 9) / 26) * 26; gy < y + h; gy += 26) { b.beginPath(); b.moveTo(x, gy + .5); b.lineTo(x + w, gy + .5); b.stroke(); }
    },
    rim(b, pal, x1, y1, x2, y2) {
      b.lineWidth = 2;
      b.strokeStyle = pal.rim; b.strokeRect(x1 + 1, y1 + 1, x2 - x1 - 2, y2 - y1 - 2);
      b.fillStyle = pal.bolt;
      for (let x = x1 + 6; x < x2; x += 18) { b.fillRect(x, y1 + 2, 2, 2); b.fillRect(x, y2 - 4, 2, 2); }
      for (let y = y1 + 6; y < y2; y += 18) { b.fillRect(x1 + 2, y, 2, 2); b.fillRect(x2 - 4, y, 2, 2); }
    },
    bands: rampBands,
    // the shell's panel joint is the SHARED pass every material gets (see panelSeam); station keeps
    // the 0.35 it always had, so the family's structural beat is literally the station's own
    seam: 0.35,
    /* THE STATION SHELL, REBUILT (2026-08-05, Andrew: "its very old and needs an upgrade anyways").
       It was the v7 hull verbatim — a smooth six-stop ramp with one vertical seam and nothing else.
       No structure at all, which is exactly why, sat next to nine designed materials, it read as the
       empty slot rather than as the default everyone starts on.

       What it is now: ARMOUR STRAKES. Wide horizontal plates, deliberately at an 11px pitch — more
       than double BRICK's 5 — because the thing that separates engineering from masonry at this
       scale is plate SIZE. Each strake takes a thin catch-light along its top edge, a hard shadow
       beneath where the plate above it overhangs, and a row of rivets on the lip. The rivets are the
       identity, and they are also the promise the plate ring's rim has always made and the skirt
       never kept: the hull is bolted together.

       THE PALETTE IS UNCHANGED. Only structure is added, so a hued station shell still derives
       exactly as before, AUTO is still the shell's own grey, and the ramp underneath — the thing
       that gives the station its height — is the same six stops it always was. This is the one
       deliberate break of the axis's pixel-parity property, taken on Andrew's call; everything
       BELOW the veins pass still matches the pre-axis bake byte for byte. */
    veins(fg, pal, w, h, vx, vy, topOf) {
      coursedVein(fg, w, h, vx, vy, {
        ch: STRAKE,
        crest: 'rgba(172,195,222,0.055)',      // the sky-catch along a plate's top edge
        bed: 'rgba(0,0,0,0.40)', bedH: 2      // the shadow the plate above throws down onto it
      }, topOf);
      const px = boxed(fg, 0, 0, w, h);
      const runs = runsOf(topOf, w, courseAt(vy, STRAKE) - vy);
      // RIVETS along each strake's lip. Keyed on ABSOLUTE x (pitch 7) so two adjacent rooms wearing
      // the station shell share one rivet line, and so a chunk bake lands them identically.
      for (let k = 0; k < Math.ceil(h / STRAKE) + 2; k++) {
        for (const r of runs) {
          const y = r[2] + k * STRAKE + 2;
          for (let wx = courseAt(vx + r[0], 7); wx < vx + r[0] + r[1]; wx += 7) {
            if (wx < vx + r[0]) continue;
            fg.fillStyle = 'rgba(182,204,228,0.065)'; px(wx - vx, y, 1, 1);
            fg.fillStyle = 'rgba(0,0,0,0.28)'; px(wx - vx, y + 1, 1, 1);
          }
        }
      }
      // Recessed service covers belong to the armour, with a dark reveal and a small
      // cold edge reflection. World-anchored placement keeps chunk seams invisible.
      for (const run of runs) {
        for (let wx = courseAt(vx + run[0], 56); wx < vx + run[0] + run[1]; wx += 56) {
          if (wx < vx + run[0] || wx + 13 > vx + run[0] + run[1]) continue;
          const xx = wx - vx + 3, yy = run[2] + 4;
          fg.fillStyle = 'rgba(0,0,0,0.32)'; px(xx, yy, 10, 5);
          fg.fillStyle = 'rgba(156,180,209,0.055)'; px(xx + 1, yy + 1, 8, 1);
          fg.fillStyle = 'rgba(0,0,0,0.42)'; px(xx + 7, yy + 2, 2, 1);
          // Pressure-door seam and captive fasteners in the same unlit armour tones.
          fg.fillStyle='rgba(0,0,0,0.24)';px(xx+1,yy+4,8,1);
          fg.fillStyle='rgba(153,178,198,0.07)';px(xx+1,yy+1,1,1);px(xx+8,yy+3,1,1);
          fg.fillStyle='rgba(0,0,0,0.30)';px(xx+4,yy+2,1,2);
        }
      }
      // the panel joint's LIT edge — one plate butts against the next and you see the near plate's
      // own edge beside the dark seam. panelSeam paints that seam at x = 5 + 28k, so this sits at 6.
      fg.fillStyle = 'rgba(174,195,220,0.04)';
      for (let x = 6 - (vx % 28); x < w; x += 28) px(x, 0, 1, h);
    }
  };

  /* TIMBER — stacked log courses. The Stardew cabin, and the material this whole axis was asked for.
     A log reads from three rows and no more: a lit crest where it catches the sky, its own body, and
     a hard dark line where the next log below it is shadowed. Give it a gradient and it turns to
     plastic tubing — logs are matte. */
  const LOG = 6;
  const hullTimber = {
    dress(b, pal, x, y, w, h) {
      for (let gy = courseAt(y, LOG); gy < y + h; gy += LOG) {
        if (gy >= y) { b.fillStyle = pal.lit; b.fillRect(x, gy, w, 1); }
        const under = gy + LOG - 1;
        if (under >= y && under < y + h) { b.fillStyle = pal.dk; b.fillRect(x, under, w, 1); }
      }
      // knots — sparse, so a log has grain without turning into polka dots
      for (let gy = courseAt(y, LOG) + 2; gy < y + h; gy += LOG) {
        for (let gx = courseAt(x, 23); gx < x + w; gx += 23) {
          if (gx < x || gy < y) continue;
          if (h2(gx, gy, 'knot') % 3) continue;
          b.fillStyle = pal.seam; b.fillRect(gx, gy, 2, 2);
        }
      }
    },
    // notched log ENDS at the corners — the one detail that says "cabin" rather than "wooden box"
    rim(b, pal, x1, y1, x2, y2) {
      const px = boxed(b, x1, y1, x2, y2);
      b.lineWidth = 1; b.strokeStyle = pal.dk;
      b.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1);
      for (const cx of [x1, x2 - 5]) {
        for (let gy = y1 + 2; gy < y2 - 2; gy += LOG) {
          b.fillStyle = pal.lit; px(cx, gy, 5, LOG - 2);
          b.fillStyle = pal.seam; px(cx + 1, gy + 1, 3, LOG - 4);
        }
      }
    },
    bands: (pal, skirt) => ramp6(pal, skirt, -0.62, 0.16),
    // a log reads from a lit crest and a HARD undercut, nothing else. The undercut carries most of
    // the weight — take it out and the wall goes back to being a flat brown band.
    veins(fg, pal, w, h, vx, vy, topOf) {
      coursedVein(fg, w, h, vx, vy, { ch: LOG, crest: 'rgba(255,240,214,0.18)', bed: 'rgba(0,0,0,0.52)', bedH: 2 }, topOf);
      const px = boxed(fg, 0, 0, w, h);
      fg.fillStyle = 'rgba(0,0,0,0.40)';
      wallRuns(topOf, w, (rx, rw, top) => {          // knots ride their own log, so they turn the corner too
        for (let k = 0; k < Math.ceil(h / LOG) + 2; k++) {
          const y = top + k * LOG + 2;
          if (y > h) break;
          for (let wx = courseAt(vx + rx, 19); wx < vx + rx + rw; wx += 19)
            if (h2(wx, k, 'knotv') % 3 === 0) px(wx - vx, y, 2, 2);
        }
      }, courseAt(vy, LOG) - vy);
    }
  };

  /* CLAPBOARD — lapped siding. Same three-row logic as TIMBER at a tighter pitch, but the shadow is
     the point: a lap board overhangs the one below it, so the dark line sits UNDER the lip, not
     between two equal bodies. Tighter pitch also means it reads as a HOUSE next to a cabin. */
  const LAP = 4;
  const hullClapboard = {
    dress(b, pal, x, y, w, h) {
      for (let gy = courseAt(y, LAP); gy < y + h; gy += LAP) {
        const lip = gy + LAP - 1;
        if (gy >= y) { b.fillStyle = pal.lit; b.fillRect(x, gy, w, 1); }
        if (lip >= y && lip < y + h) { b.fillStyle = pal.seam; b.fillRect(x, lip, w, 1); }
      }
    },
    // corner trim boards — the vertical batten a clapboard wall always ends on
    rim(b, pal, x1, y1, x2, y2) {
      b.fillStyle = pal.lit; b.fillRect(x1 + 1, y1 + 1, 3, y2 - y1 - 2); b.fillRect(x2 - 4, y1 + 1, 3, y2 - y1 - 2);
      b.fillStyle = pal.seam; b.fillRect(x1 + 4, y1 + 1, 1, y2 - y1 - 2); b.fillRect(x2 - 5, y1 + 1, 1, y2 - y1 - 2);
      b.fillStyle = pal.dk; b.fillRect(x1, y1, x2 - x1, 1); b.fillRect(x1, y2 - 1, x2 - x1, 1);
    },
    bands: (pal, skirt) => ramp6(pal, skirt, -0.56, 0.20),
    // tighter pitch than TIMBER and a thinner shadow: a board is a plank, not a log
    veins(fg, pal, w, h, vx, vy, topOf) {
      coursedVein(fg, w, h, vx, vy, { ch: LAP, crest: 'rgba(255,250,238,0.20)', bed: 'rgba(0,0,0,0.44)' }, topOf);
    }
  };

  /* SHINGLE — a pitched roof read from above, which is what a top-down house actually shows you.
     Its identity is the STAGGER: every other course offset by half a shingle. A grid of unstaggered
     rectangles is tile, not shingle, and the eye knows immediately. */
  const SHG = 7, SHW = 11;   // course pitch × tab width — sized so a tab reads square-ish, not as a stripe
  // one 1px vertical split per shingle, staggered every other course. Spans are clipped to the
  // requested box at BOTH ends — a course starting above y0 still owns only the rows inside it.
  const shingleSplits = (paint, x0, x1, y0, y1) => {
    for (let gy = courseAt(y0, SHG); gy < y1; gy += SHG) {
      const row = Math.floor(gy / SHG), off = (row & 1) ? (SHW >> 1) : 0;
      const sy = Math.max(gy, y0), sh = Math.min(gy + SHG, y1) - sy;
      if (sh <= 0) continue;
      for (let gx = courseAt(x0 - off, SHW) + off; gx < x1; gx += SHW) {
        if (gx < x0) continue;
        paint(gx, sy, 1, sh);
      }
    }
  };
  const hullShingle = {
    dress(b, pal, x, y, w, h) {
      for (let gy = courseAt(y, SHG); gy < y + h; gy += SHG) {
        if (gy >= y) { b.fillStyle = pal.lit; b.fillRect(x, gy, w, 1); }
        const under = gy + SHG - 1;
        if (under >= y && under < y + h) { b.fillStyle = pal.dk; b.fillRect(x, under, w, 1); }
      }
      b.fillStyle = pal.dk;
      shingleSplits((sx, sy, sw, sh) => b.fillRect(sx, sy, sw, sh), x, x + w, y, y + h);
    },
    rim(b, pal, x1, y1, x2, y2) {
      // the ridge cap + the eave: a roof's two ends, and the only straight lines on it
      b.fillStyle = pal.lit; b.fillRect(x1, y1, x2 - x1, 2);
      b.fillStyle = pal.dk; b.fillRect(x1, y2 - 2, x2 - x1, 2);
      b.fillStyle = pal.rim; b.fillRect(x1, y1, 2, y2 - y1); b.fillRect(x2 - 2, y1, 2, y2 - y1);
    },
    bands: (pal, skirt) => ramp6(pal, skirt, -0.62, 0.12),
    /* SHINGLE vs BRICK is decided here, and it is worth stating plainly because the first pass got
       it wrong and the two were the same picture: a brick wall is a LIGHT grid on a flat plane; a
       shingle wall is a stack of OVERHANGING layers. So this one takes a fat 2px black undercut
       under every course, wide tabs, and splits that stop short of the course above (a shingle's
       split does not run through the one it laps over) — and no light horizontal line at all. */
    veins(fg, pal, w, h, vx, vy, topOf) {
      /* THE SPLIT HAS TO RUN NEARLY THE FULL COURSE or this is just dark CLAPBOARD — which is what
         it was at jointFrom 2 on a 5px course, leaving a 2px nub of a joint nobody could see. The
         stagger is the only thing separating a shingle roof from a lapped wall, so it gets the tall
         run and the wide tab; the course pitch grew with it so the tabs stay square-ish. */
      coursedVein(fg, w, h, vx, vy, {
        ch: SHG, uw: SHW, bedH: 2, bed: 'rgba(0,0,0,0.60)',
        joint: 'rgba(0,0,0,0.55)', jointFrom: 0,
        crest: 'rgba(255,248,228,0.12)'   // the sliver of sky each tab catches — layers, not a grid
      }, topOf);
    }
  };

  /* BRICK — the townhouse. Bond pattern: 11px stretchers on a 5px course, every other course offset
     by half. Mortar is a LIGHT line on a dark brick, never the other way round; inverting that is the
     classic tell of a brick texture drawn from memory. */
  const BRK = 5, BRW = 11;
  const brickJoints = (paint, x0, x1, y0, y1) => {
    for (let gy = courseAt(y0, BRK); gy < y1; gy += BRK) {
      const row = Math.floor(gy / BRK), off = (row & 1) ? (BRW >> 1) : 0;
      const sy = Math.max(gy, y0), sh = Math.min(gy + BRK, y1) - sy;
      if (sh <= 0) continue;
      for (let gx = courseAt(x0 - off, BRW) + off; gx < x1; gx += BRW) {
        if (gx < x0) continue;
        paint(gx, sy, 1, sh);
      }
    }
  };
  const hullBrick = {
    dress(b, pal, x, y, w, h) {
      for (let gy = courseAt(y, BRK); gy < y + h; gy += BRK) {
        const m = gy + BRK - 1;
        if (m >= y && m < y + h) { b.fillStyle = pal.rim; b.fillRect(x, m, w, 1); }   // mortar bed
      }
      b.fillStyle = pal.rim;
      brickJoints((sx, sy, sw, sh) => b.fillRect(sx, sy, sw, sh), x, x + w, y, y + h);
      // per-brick tone jitter — a wall of identical bricks reads as printed paper
      for (let gy = courseAt(y, BRK); gy < y + h; gy += BRK) {
        const row = Math.floor(gy / BRK), off = (row & 1) ? (BRW >> 1) : 0;
        for (let gx = courseAt(x - off, BRW) + off; gx < x + w; gx += BRW) {
          if (gx < x || gy < y || h2(gx, gy, 'brk') % 4) continue;
          b.fillStyle = hshade(pal.base, (h2(gx, gy, 'bt') % 2) ? 0.10 : -0.16);
          b.fillRect(gx + 1, gy, Math.min(BRW - 1, x + w - gx - 1), Math.min(BRK - 1, y + h - gy));
        }
      }
    },
    rim(b, pal, x1, y1, x2, y2) {
      // a soldier course framing the footprint — the header band a brick wall is capped with
      b.fillStyle = pal.rim; b.strokeStyle = pal.rim; b.lineWidth = 1;
      b.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1);
      b.fillStyle = pal.lit;
      for (let x = x1 + 2; x < x2 - 1; x += 4) { b.fillRect(x, y1 + 1, 1, 2); b.fillRect(x, y2 - 3, 1, 2); }
    },
    bands: (pal, skirt) => ramp6(pal, skirt, -0.60, 0.18),
    // a LIGHT grid, flat: mortar reads lighter than the brick at every depth down the wall, and
    // there is deliberately no shadow band — that is SHINGLE's move, and it is what separates them
    veins(fg, pal, w, h, vx, vy, topOf) {
      coursedVein(fg, w, h, vx, vy, {
        ch: BRK, uw: BRW, bedH: 1,
        bed: 'rgba(255,238,214,0.17)', joint: 'rgba(255,238,214,0.13)'
      }, topOf);
    }
  };

  /* STONE — rubble masonry, the cottage/keep. The opposite discipline to BRICK: NOTHING lines up.
     Course height varies, joints land where the hash says, and that irregularity is the entire read.
     Any regular pitch that survives here turns it back into brick. */
  const hullStone = {
    dress(b, pal, x, y, w, h) {
      const px = boxed(b, x, y, x + w, y + h);
      for (let gy = courseAt(y, 6); gy < y + h; gy += 6) {
        const m = gy + 5;
        if (m >= y && m < y + h) { b.fillStyle = pal.dk; px(x, m, w, 1); }
        for (let gx = courseAt(x, 8); gx < x + w; gx += 8) {
          const r = h2(gx, gy, 'stn');
          if (r % 3) { b.fillStyle = pal.dk; px(gx + (r % 5), gy, 1, 5); }
          if (r % 7 === 0) { b.fillStyle = pal.lit; px(gx + 1, gy + 1, 2, 1); }   // a caught highlight
        }
      }
    },
    rim(b, pal, x1, y1, x2, y2) {
      // dressed quoins — the squared corner stones a rubble wall is always finished with
      b.fillStyle = pal.dk; b.strokeStyle = pal.dk; b.lineWidth = 1;
      b.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1);
      for (const [qx, qy] of [[x1 + 1, y1 + 1], [x2 - 7, y1 + 1], [x1 + 1, y2 - 7], [x2 - 7, y2 - 7]]) {
        b.fillStyle = pal.lit; b.fillRect(qx, qy, 6, 6);
        b.fillStyle = pal.rim; b.fillRect(qx + 1, qy + 1, 4, 4);
      }
    },
    bands: (pal, skirt) => ramp6(pal, skirt, -0.64, 0.14),
    /* NOTHING LINES UP — that is the whole material, and the first pass failed it by stepping a
       fixed 6×8 grid, which is just brick with the mortar turned off. The bed line now wobbles
       inside its course and the joints jitter inside their cell.
       THE JITTER MUST BE A PURE FUNCTION OF ABSOLUTE COORDS, never an accumulation: a `wy += ch`
       walk with a hashed ch starts from a different place in every chunk and the whole wall
       desynchronises across chunk seams. Fixed pitch, hashed OFFSET — parity-safe irregularity. */
    veins(fg, pal, w, h, vx, vy, topOf) {
      const px = boxed(fg, 0, 0, w, h);
      const runs = runsOf(topOf, w, courseAt(vy, 7) - vy);
      for (let k = 0; k < Math.ceil(h / 7) + 2; k++) {
        const drop = h2(0, k, 'stnh') % 3;                   // the bed wanders 0..2 inside its course
        fg.fillStyle = 'rgba(0,0,0,0.46)'; courseLine(px, runs, k, 7, 6 - drop, 1);
        for (const rr of runs) {
          const yTop = rr[2] + k * 7;
          for (let wx = courseAt(vx + rr[0], 9); wx < vx + rr[0] + rr[1]; wx += 9) {
            const r = h2(wx, k, 'stnj');
            if (r % 5 === 0) continue;                       // not every cell carries a joint
            fg.fillStyle = 'rgba(0,0,0,0.44)'; px(wx - vx + (r % 7), yTop, 1, 6 - drop);
            if (r % 4 === 0) { fg.fillStyle = 'rgba(255,250,240,0.10)'; px(wx - vx + 2, yTop + 1, 3, 1); }
          }
        }
      }
    }
  };

  /* STUCCO — rendered plaster. The one material whose identity is the ABSENCE of pattern: a broad
     flat field, a mottle too faint to count as texture, and crisp quoins at the corners doing all the
     structural talking. Resist adding coursing here; the moment it has courses it is just pale brick. */
  const hullStucco = {
    dress(b, pal, x, y, w, h) {
      for (let gy = y; gy < y + h; gy += 2) for (let gx = courseAt(x, 3); gx < x + w; gx += 3) {
        if (gx < x) continue;
        const r = h2(gx, gy, 'stc');
        if (r % 5) continue;
        b.fillStyle = (r % 2) ? hshade(pal.base, 0.07) : hshade(pal.base, -0.09);
        b.fillRect(gx, gy, 2, 1);
      }
    },
    rim(b, pal, x1, y1, x2, y2) {
      b.fillStyle = pal.lit; b.fillRect(x1, y1, x2 - x1, 2);            // the sunlit render lip
      b.fillStyle = pal.seam; b.fillRect(x1, y2 - 2, x2 - x1, 2);
      for (const [qx, qy] of [[x1 + 1, y1 + 1], [x2 - 6, y1 + 1], [x1 + 1, y2 - 8], [x2 - 6, y2 - 8]]) {
        b.fillStyle = pal.lit; b.fillRect(qx, qy, 5, 7);
        b.fillStyle = pal.rim; b.fillRect(qx + 1, qy + 1, 3, 5);
      }
    },
    // the one shell that is ONLY its ramp — no veins at all. That is the material, not an omission.
    bands: (pal, skirt) => ramp6(pal, skirt, -0.66, 0.26),
    veins: null
  };

  /* CURTAIN — a glass curtain wall. The tower, and the reason a mixed station can read as a CITY:
     put one of these beside two cabins and the skyline does the storytelling. Vertical mullions on a
     tight pitch are the whole material — glass itself is just the dark gap between them. */
  const hullCurtain = {
    dress(b, pal, x, y, w, h) {
      b.fillStyle = hshade(pal.base, -0.34); b.fillRect(x, y, w, h);
      for (let gx = courseAt(x, 6); gx < x + w; gx += 6) {
        if (gx < x) continue;
        b.fillStyle = pal.rim; b.fillRect(gx, y, 1, h);
      }
      for (let gy = courseAt(y, 10); gy < y + h; gy += 10) {
        if (gy < y) continue;
        b.fillStyle = pal.lit; b.fillRect(x, gy, w, 1);       // the spandrel band between floors
      }
    },
    rim(b, pal, x1, y1, x2, y2) {
      b.fillStyle = pal.lit; b.lineWidth = 1; b.strokeStyle = pal.lit;
      b.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1);
      b.fillStyle = pal.rim; b.fillRect(x1 + 2, y1 + 2, 2, y2 - y1 - 4); b.fillRect(x2 - 4, y1 + 2, 2, y2 - y1 - 4);
    },
    bands: (pal, skirt) => ramp6(pal, skirt, -0.76, 0.10),
    veins(fg, pal, w, h, vx) {
      const px = boxed(fg, 0, 0, w, h);
      // mullions catch what light there is — the ONE place a hull material paints brighter than base
      fg.fillStyle = 'rgba(210,224,255,0.15)';
      for (let x = 6 - (vx % 6); x < w; x += 6) px(x, 0, 1, h);
      fg.fillStyle = 'rgba(0,0,0,0.30)';
      for (let x = 3 - (vx % 6); x < w; x += 6) px(x, 0, 2, h);
    }
  };

  /* HEDGE — a clipped garden wall. Pairs with the interior HEDGE wall material, so a room can be
     green inside and out. Foliage is the one shell with no straight lines at all: the silhouette
     still has to be the footprint (the station's geometry is not negotiable), so all the irregularity
     has to live in the speckle. */
  const hullHedge = {
    dress(b, pal, x, y, w, h) {
      const px = boxed(b, x, y, x + w, y + h);
      for (let gy = y; gy < y + h; gy++) for (let gx = courseAt(x, 2); gx < x + w; gx += 2) {
        const r = h2(gx, gy, 'hdg');
        if (r % 3 === 0) { b.fillStyle = hshade(pal.base, 0.16); px(gx, gy, 1, 1); }
        else if (r % 5 === 0) { b.fillStyle = hshade(pal.base, -0.30); px(gx, gy, 2, 1); }
      }
    },
    rim(b, pal, x1, y1, x2, y2) {
      b.fillStyle = hshade(pal.base, 0.26); b.fillRect(x1, y1, x2 - x1, 2);   // the clipped top catches the light
      b.fillStyle = hshade(pal.base, -0.44); b.fillRect(x1, y2 - 2, x2 - x1, 2);
    },
    bands: (pal, skirt) => ramp6(pal, skirt, -0.70, 0.20),
    veins(fg, pal, w, h, vx, vy) {
      const px = boxed(fg, 0, 0, w, h);
      for (let gy = 0; gy < h; gy++) for (let gx = 0; gx < w; gx += 2) {
        const r = h2(gx + vx, gy + vy, 'hdgv');
        if (r % 4 === 0) { fg.fillStyle = 'rgba(0,0,0,0.34)'; px(gx, gy, 2, 1); }
        else if (r % 11 === 0) { fg.fillStyle = 'rgba(190,255,190,0.07)'; px(gx, gy, 1, 1); }
      }
    }
  };

  // Broad structural panels use the existing six silhouette stamps. The quiet middle
  // of the ramp removes the stacked-strake read without adding canvas work per frame.
  const hullMonocoque = {
    pal(raw) {
      const p = hullStationPal(raw);
      p.bands = [0.40, 0.54, 0.93, 1.08, 1.28, 2.05].map(k => lift(p.base, k));
      p.edge = lift(p.base, 1.05); p.rim = lift(p.base, 1.35); p.arc = lift(p.base, 1.45);
      return p;
    },
    bands: rampBands,
    seam: 0,
    dress(b, p, x, y, w, h) {
      b.fillStyle = p.seam;
      for (let wx = Math.ceil(x / 48) * 48; wx < x + w; wx += 48) b.fillRect(wx, y, 1, h);
    },
    rim(b, p, x1, y1, x2, y2) {
      b.strokeStyle = p.rim; b.lineWidth = 1;
      b.strokeRect(x1 + 1.5, y1 + 1.5, x2 - x1 - 3, y2 - y1 - 3);
      b.fillStyle = p.bolt;
      for (let x = x1 + 12; x < x2 - 8; x += 48) { b.fillRect(x, y1 + 2, 2, 1); b.fillRect(x, y2 - 3, 2, 1); }
    },
    veins(g, p, w, h, vx, vy, topOf) {
      const px = boxed(g, 0, 0, w, h);
      for (const run of runsOf(topOf, w, 0)) {
        const top = run[2];
        g.fillStyle = 'rgba(0,0,0,0.28)'; px(run[0], top + 3, run[1], 2);
        g.fillStyle = 'rgba(172,196,220,0.075)'; px(run[0], top + 5, run[1], 1);
        for (let wx = Math.ceil((vx + run[0]) / 48) * 48; wx < vx + run[0] + run[1]; wx += 48) {
          const x = wx - vx;
          g.fillStyle = 'rgba(0,0,0,0.42)'; px(x, top + 6, 2, Math.max(1, WALL.skirt - 10));
          g.fillStyle = 'rgba(164,188,214,0.065)'; px(x + 2, top + 6, 1, Math.max(1, WALL.skirt - 10));
          if (x + 35 >= run[0] + run[1]) continue;
          // A single recessed maintenance latch per large panel; no blinking decoration.
          g.fillStyle = 'rgba(0,0,0,0.30)'; px(x + 25, top + 10, 10, 9);
          g.fillStyle = 'rgba(164,188,214,0.065)'; px(x + 26, top + 11, 8, 1);
          g.fillStyle = 'rgba(0,0,0,0.45)'; px(x + 32, top + 13, 1, 3);
        }
      }
    }
  };
  const HULL_RECIPES = {
    station: hullStation, monocoque: hullMonocoque, timber: hullTimber, clapboard: hullClapboard, shingle: hullShingle,
    brick: hullBrick, stone: hullStone, stucco: hullStucco, curtain: hullCurtain, hedge: hullHedge
  };

  /* how wide the LIT TOP SURFACE is on a wall that is not extruded up-screen. Hard-clamped to
     pad-1 — past that the crown falls outside the ambient plate and burns against the starfield
     (see the WALL.sideCap note).

     ONE RING, ONE WIDTH — CORRIDORS INCLUDED (2026-07-28, Andrew on a vertical hallway between two
     rooms: "can we add walls properly to the hallways?"). This used to shrink to 0.6 for corridors
     "the same way corUp < up", and the two are NOT the same knob. `corUp` is how far a wall is
     STOOD UP, a real style choice: a lower corridor reads as a tunnel, a taller room as a hall.
     `sideCap` is how WIDE that wall's top surface is — i.e. how thick the bulkhead is — and a
     hallway's bulkhead is the same slab of station as the room's it connects. Shrinking it bought
     no tunnel read at all; it just made the one surface that DEFINES a wall from directly above
     three pixels of near-nothing, so a hallway read as a dark slot you look through while the rooms
     either side had obvious standing walls. Worse, the ring visibly STEPPED 5→3 at every junction,
     which is the same "the crown stops here" failure the corners had. A wall's height may differ
     between space types; its top surface may not. */
  const sideCapW = () => Math.max(2, Math.min(pad - 1, Math.round(WALL.sideCap)));

  /* WHERE A CORNER ARC'S CENTRE SITS. Bottom corners: the chamfer's own centre — the outline is
     the plain quarter circle and this is a no-op. Top corners: moved UP so the arc's topmost point
     lands on the straight north wall's outline, i.e. `centre = thatLine + HR`. DERIVED, not tuned,
     and derived at BOTH ends at once — the arc's leftmost point is then at `ax - HR = X - pad`,
     which is exactly the e/w wall's outer edge. Circle tangents there are vertical and at the top
     horizontal, so the arc leaves one straight wall and meets the other with no kink at either end,
     for any WALL.up. Clamped at `ay`: a wall with no rise keeps the plain flat corner rather than
     inventing a lift below it (reachable via the crtlab 'Flat (old)' preset; corridors sat here
     while corUp was 0, though they carry no chamfers of their own either way). */
  const cornerArcCy = (kind, ay, Y, HR, room) => {
    if (kind !== 'tl' && kind !== 'tr') return ay;
    const up = Math.round(room ? WALL.up : WALL.corUp);
    if (up <= 0) return ay;
    return Math.min(ay, Y - up - Math.max(2, Math.round(WALL.capH)) - 2 + HR);
  };

  /* THE CROWN-WIDTH EASE. A wall's top surface is `capW` wide where it is read from directly above
     (every e/w/s straight) and `capH` where it has been stood up and is read as a face (the north
     straight); around a chamfer it crosses between the two. It used to ease to NOTHING and dim out,
     because at the side end there was no side crown to hand off to — a cap kept at full thickness
     over a wall receded to zero read as a bright bar ruled across the corner ("the thick diagonal
     lines", 2026-07-25). Now the ease runs INTO that crown. The law both halves of that history
     teach: the cap must never be wider than the surface it crowns at either end of the arc. */
  const crownEase = (tt, capW, capFar) => Math.max(1, Math.round(capW + (capFar - capW) * tt));

  /* WHAT THE CROWN NARROWS TO AT THE FAR END OF A CORNER ARC — i.e. the width of whatever straight
     wall waits there. Only a TOP corner ends on an extruded wall, whose crown is genuinely
     foreshortened to capH; a BOTTOM corner joins two walls that are both read from straight above,
     so both ends are capW and the ring must hold ONE width the whole way round.
     It taper-pinched to capH at the bottom two for a while, which put a 5 -> 3 -> 5 waist at exactly
     the corner — the ring visibly thinning right where the eye is following it round (Andrew:
     "lets perfect the corners on the bottom"). A constant-width band is what reads as a turn. */
  const cornerCapFar = (kind, capW, capH) => (kind === 'tl' || kind === 'tr') ? capH : capW;

  /* ---------- THE NEARER WALL OWNS THE VOID IT STANDS IN (2026-08-13) ----------
     Where two footprints sit a tile or two apart, BOTH of them extrude into the sliver between: a
     corner's shell hangs `pad` past its own tile, and the room to the SOUTH stands its tall north
     face up into the very same pixels. Every straight wall is painted before every chamfer, so the
     corner — which is the FARTHER of the two — was flattening the nearer wall's face under a bright
     crown bar that then stopped dead at the deck. Andrew circled exactly that: "the wall texture as
     it curves doesnt connect to the next wall ... it just continues on and gets cut off", and
     circled it a second time one room over, because that room has the shape on BOTH sides.

     This is the depth law the chamfer/chamfer paint order already follows (2026-08-11: "south paints
     last, same as prop y-sort"), extended to the case it never covered — a corner against a STRAIGHT
     wall. Nothing is left unpainted by the clip: the nearer wall has already drawn those rows in
     full, which is precisely why it may keep them.

     `nearerNorthTop` answers, for a tile column, the first bake row owned by a tall north face SOUTH
     of row `ccy` — Infinity when there is none, which is the overwhelmingly common case and costs
     one Map miss. */
  let extNByCol = null;
  const northClaimTop = (tx, ty) => {
    const z = G.zoneGrid[G.idx(tx, ty)];
    const up = Math.max(0, Math.round(G.isCorridor(z) ? WALL.corUp : WALL.up));
    // up === 0 is the legacy short-wall branch: it stands nothing up, it only caps the seam.
    if (up <= 0) return ty * T - (G.isCorridor(z) ? 2 : 4);
    return ty * T - up - Math.max(2, Math.round(WALL.capH)) - 2;   // the dark hull lip above the crown
  };
  function nearerNorthTop(tx, ccy) {
    if (!extNByCol) {
      extNByCol = new Map();
      for (const k of extN) {
        const i = k.indexOf(','), x = +k.slice(0, i), y = +k.slice(i + 1);
        const a = extNByCol.get(x); if (a) a.push(y); else extNByCol.set(x, [y]);
      }
      for (const a of extNByCol.values()) a.sort((p, q) => p - q);
    }
    const a = extNByCol.get(tx);
    if (!a) return Infinity;
    for (const ty of a) if (ty > ccy) return northClaimTop(tx, ty);
    return Infinity;
  }

  /* THE CORNER'S SHARE OF THE CROWN RING. On the straights the wall's lit top surface is a rect;
     around a chamfer it is the band just inside the station's own outline, and without it the ring
     broke at all four corners — which is exactly the "cuts off as if there's only a back wall"
     read, because the two TOP corners are where the eye follows the bright line and loses it.

     ---- THE OUTLINE IS ONE CIRCLE, AND A TOP CORNER LIFTS IT RIGIDLY (2026-07-27) ----
     Two rounds of this were wrong, and both failures are worth keeping because both are easy to
     walk back into.

     ROUND 1 — TWO PROFILES. The flat ring followed the hull curve while a separate column sweep
     rose 0 → WALL.up across only the DECK curve's columns, and the hull reaches `pad` further out
     than that sweep ever began. The outline stepped inward where the sweep started, then kinked
     onto a much steeper staircase. Two curves meeting at an angle is not a corner, it is a notch.

     ROUND 2 — ONE PROFILE, BUT SHEARED. Displacing the ring by a per-column EASED amount is a
     shear, and a sheared circle is not a circle: its curvature piles up where the ease is steepest.
     Andrew, tracing the arc he wanted over a screenshot: "it needs to perfectly curve at the top
     left and the top right the same way it does on the bottom." An ease cannot do that, however
     smooth the easing function is. LAW: NEVER EASE THE OUTLINE ITSELF.

     What is actually true: the wall's top surface is the footprint ring translated up-screen by the
     wall's height, and a RIGID TRANSLATION PRESERVES A CIRCLE. So the outer boundary here is the
     same radius-HR quarter circle the bottom corners use, with its centre moved up to `cy` — and
     the region it vacates is simply wall FACE, which is what standing the wall up exposes.

     `cy` is DERIVED so both ends land tangentially, which is what makes the join invisible:
       · centre y = (the straight north wall's outline top) + HR, so the arc's topmost point sits
         exactly on that line with a HORIZONTAL tangent;
       · the arc's leftmost point is then at ax - HR = X - pad, which IS the e/w wall's outer edge,
         with a VERTICAL tangent — so it leaves the side wall without a kink.
     Below that leftmost point the outline is simply the vertical run at ax - HR, which is how the
     ring crosses the chamfer tile and reaches the straight side wall underneath.

     Only the LADDER WIDTH eases (crownEase, capW → capH), never the boundary: a top surface really
     is foreshortened where you see it edge-on. Bottom corners pass cy = ay and are unchanged. */
  /* ONE SLICE OF THE CORNER'S TALL FACE — the back wall, curving.

     THE CORNER FACE IS THE SAME SURFACE AS THE STRAIGHT NORTH FACE (2026-08-05, Andrew: "it should
     look like the actual WALL on the back wall, it should look like that wall is curving"). At a top
     corner the lifted crown ring vacates a region, and that region is the north wall's own face
     coming round the bend — `bakeTallNorthFace` hands the straight version to WALL_RECIPES, while
     this one was a flat `pal.face` fill. So the back wall visibly curved and went blank doing it.

     THE MAPPING IS THE WHOLE TRICK, and it is the same one the hull's contour uses: DEPTH IS
     MEASURED INWARD FROM THE CROWN. On the straight wall that measure is height down the face; round
     the arc it is distance in from the wall's top. Under it the two families of mark transform
     correctly and automatically:
       · DOWN-wall marks (the lit top course, WAINSCOT's dado rail, SERVICE's grain) are constant
         depth — so they become CONCENTRIC bands that bend with the wall;
       · ALONG-wall marks (RIBBED's ribs, PLATING's plate seams) are constant along-position — so
         they become RADIAL SPOKES, spaced by ARC LENGTH so they neither bunch nor stretch.
     `deepRuns` are FRACTIONS of the face depth, not pixels: the face is ~23px deep at the top of the
     arc and a couple of px at its foot, and a rail pinned to an absolute depth would slide off the
     wall as it narrows. */
  function cornerFaceSlice(put, pal, ed, strip, map, alongWorld, horiz, fixed, d0, len, step, s) {
    if (len <= 0) return;
    const base = ed.glass ? U.shade(pal.base, -0.55) : pal.face;
    const spoke = !strip && ed.pitch > 0 && (((Math.round(s) % ed.pitch) + ed.pitch) % ed.pitch) === 0;
    for (let i = 0; i < len; i++) {
      let c;
      if (strip) {
        /* THE WALL'S OWN PIXELS, addressed in POLAR rather than per-slice.
           Taking (along, depth) from the SLICE meant the whole run shared one along-value and the
           depth ran with the slice index — fine on its own, but the two duals point those axes
           different ways, so at the 45° handoff the texture flipped orientation and stepped. Andrew
           circled exactly that seam. Computing both from the pixel's own radius and angle makes the
           mapping rotationally exact and identical either side of the handoff, so there is nothing
           left for the duals to disagree about. */
        const px0 = d0 + step * i;
        const m = map(horiz ? px0 : fixed, horiz ? fixed : px0);
        c = stripAt(strip, m.a, m.d);
        if (c === null) {
          /* A WINDOW DOES NOT TURN A CORNER (2026-08-13).
             A null sample means the strip is transparent there, and on a VIEWPORT wall that is the
             glass itself. Sampling it round the bend punched the window through the corner and the
             starfield showed where the structure should be — Andrew's "fill in the textures". A
             corner is where the hull turns; it is solid by construction, and the flat run is the
             only place a window belongs. So the corner never leaves a hole: it falls back to the
             wall's OWN face ladder — pal.face, not the glass tone `base` carries — which is what the
             headless path paints, so the strip's marks now sit ON a wall rather than instead of one.
             This is also what the old code accidentally did: its depth clamped to 0, i.e. the solid
             row above the glass. Same intent, minus the flat slab. */
          const tt = len <= 1 ? 0 : i / (len - 1);
          c = U.shade(pal.face, 0.14 - 0.34 * tt);
        }
      } else {
        // headless fallback (no getImageData): the authored approximation, kept so both bake paths
        // still agree with each other and the mock renders something deterministic.
        const t = len <= 1 ? 0 : i / (len - 1);
        c = U.shade(base, 0.14 - 0.34 * t);
        for (const [f, lift] of (ed.deepRuns || [])) if (Math.round(f * (len - 1)) === i) c = U.shade(base, lift);
        if (ed.grain && i > 1 && i % ed.grain === 0) c = U.shade(base, -0.12);
        if (spoke) c = U.shade(base, ed.joint == null ? -0.30 : ed.joint);
        else if (ed.speck && h2(fixed, i, 'wedge') % 3 === 0) c = U.shade(base, 0.16);
      }
      const px = d0 + step * i;
      if (horiz) put(px, fixed, 1, 1, c); else put(fixed, px, 1, 1, c);
    }
  }

  // `shellEdge` is the owning room's exterior tone — the single pixel of shell outside the ring,
  // the arc's counterpart of the straight walls' outer hull band (see the note in bakeWalls).
  function bakeCornerCrown(b, pal, ed, strip, kind, X, Y, ax, ay, Rc, HR, capW, capFar, cy, record, shellEdge) {
    const A = CORNER[kind];
    const outX = A.cx ? -1 : 1, outY = A.cy ? -1 : 1;      // which way is "away from the room"
    // the ring may hang past the tile into the VOID (that is where every wall's height lives) but
    // never into the tile behind it, which is this room's own walkable floor.
    /* HALF-OPEN VS INCLUSIVE — the one-pixel jog. A footprint plate spans [c - pad, c + pad), so its
       LAST painted row/column is `c + pad - 1`, while the circle crossing `round(centre + HR)` is
       the first pixel PAST the art. On the -ve side (west/north) `centre - HR` already lands on the
       first painted pixel and the two agree; on the +ve side (east/south) the ring sat one pixel
       proud of the plate and its whole ladder shifted with it, so a bottom corner met the south
       straight's crown one row low. The hull rim walk has always carried the same `ex - 1`
       correction — the ring simply did not. Keep them together. */
    const xLo = outX < 0 ? Math.round(ax - HR) : X, xHi = outX < 0 ? X + T : Math.round(ax + HR);
    const yLo = outY < 0 ? Math.round(cy - HR) : Y, yHi = outY < 0 ? Y + T : Math.round(cy + HR);
    const lit = shade(pal.cap, 0.30), seam = shade(pal.cap, -0.45);
    const ccy = Math.round(Y / T);
    const put = (x, y, w, h, c, interior = false) => {
      const x0 = Math.max(xLo, x), x1 = Math.min(xHi, x + w);
      const y0 = Math.max(yLo, y), y1 = Math.min(yHi, y + h);
      if (x1 <= x0 || y1 <= y0) return;
      /* A NEARER WALL OWNS THE VOID IT STANDS IN — see nearerNorthTop. Columns sharing a limit are
         filled as one rect, so the common case (nothing standing south of this corner) is the single
         fillRect it always was, and crownRects/record only ever record pixels actually painted —
         a mask that disagrees with the painter is the leaked-ambient class of bug. */
      for (let cx0 = x0; cx0 < x1; ) {
        const lim = nearerNorthTop(Math.floor(cx0 / T), ccy);
        let cx1 = cx0 + 1;
        while (cx1 < x1 && nearerNorthTop(Math.floor(cx1 / T), ccy) === lim) cx1++;
        const yEnd = Math.min(y1, lim);
        if (yEnd > y0) {
          b.fillStyle = c; b.fillRect(cx0, y0, cx1 - cx0, yEnd - y0);
          // Record the face AFTER clipping to the silhouette and nearer walls.
          // A raised corner is an interior wall, even above the floor footprint.
          if (interior) cornerFaceRects.push([cx0, y0, cx1 - cx0, yEnd - y0]);
          // the ring's crown tones join the straights' in the ambient cut — a corner that stayed
          // under full ambient beside a lifted straight would be the same inversion, just localised.
          if (c === pal.cap || c === lit) crownRects.push([cx0, y0, cx1 - cx0, yEnd - y0]);
          if (record) for (let ix = cx0; ix < cx1; ix++) { const p = record.get(ix); if (p === undefined || y0 < p) record.set(ix, y0); }
        }
        cx0 = cx1;
      }
    };
    const putFace = (x, y, w, h, c) => put(x, y, w, h, c, true);
    /* the 45° split between the two duals — where the profile's own reach equals the distance along
       it, i.e. rad·2^(-1/n). At n = 2 that is the circle's HR/√2, written verbatim; at n = 1 (the
       shipped chamfer) it is HR/2, and using the circle's split there handed a slab of the chamfer
       to the wrong walk. */
    const K = cornerExp() === 2 ? HR * Math.SQRT1_2 : HR * Math.pow(2, -1 / cornerExp());
    /* arc length of a point on the ring, measured from the corner's horizontal. Both duals feed the
       SAME measure, so the pattern runs unbroken across the 45° handoff between them. */
    const sOf = (px, py) => HR * Math.atan2(Math.abs(py + 0.5 - cy), Math.abs(px + 0.5 - ax));
    /* ...and the WORLD along-coordinate that arc length corresponds to. The arc's north end sits at
       x = ax and is where the straight north wall takes over, so alongWorld is anchored there and
       walks outward by arc length — which is what carries the wall's pattern round the bend at its
       true spacing and lands it in phase with the straight wall it leaves. */
    const arcEnd = HR * Math.PI / 2;
    const alongOf = (px, py) => ax + outX * (arcEnd - sOf(px, py));
    /* POLAR ADDRESS of any face pixel: how far round the arc it sits (which is the along-coordinate
       the straight wall would have there) and how far in from the crown (which is its depth down the
       face). `capW` is the crown's own width; the face begins one seam row inside it. Both fall
       straight out of the pixel's radius and angle, so the row walk and the column walk agree
       exactly where they overlap. */
    const faceMap = (px, py) => {
      const dx = px + 0.5 - ax, dy = py + 0.5 - cy;
      const ang = Math.atan2(Math.abs(dy), Math.abs(dx));
      const r = cornerNorm(dx, dy);
      const w = crownEase(Math.min(1, (HR * ang) / arcEnd), capW, capFar);
      /* DEPTH IS MEASURED IN THE PROFILE'S OWN NORM (cornerNorm), not as a Euclidean radius: the
         face's concentric bands have to run PARALLEL to the edge they hang off, and on a chamfer a
         circle's radius crosses that edge at every angle but 0 and 90. Identical at n = 2.
         ALONG IS THE PIXEL'S OWN WORLD X — the BACK WALL'S axis — not arc length.
         Arc length is the truer surface coordinate and it is what the hull's skirt uses, but here it
         aliases badly: `a = HR·ang` makes the marks RADIAL, so they converge as the radius falls and
         at the inner edge a 4px material (RIBBED) lands ~2.5px apart and beats into a checkerboard.
         World x advances exactly one unit per pixel at every depth, so it cannot beat — and at the
         north join it IS the back wall's own coordinate, which makes that seam literally disappear.
         The cost is the far end of the arc, where the pattern foreshortens instead of holding its
         spacing; that reads as the wall turning away from you, and it is the end Andrew explicitly
         deprioritised ("focus on blending with the back wall mainly").
         Depth stays radial: it is what carries the courses and rails round as concentric bands. */
      return { a: px, d: Math.max(0, Math.floor((HR - 2 - w) - r)) };
    };
    /* the DECK's own curve is the inner limit for the face fill — everything from the ladder down
       to it is wall face. Same centre and rounding convention as the deck cut itself, so the face
       stops exactly where the floor starts. */
    const deckXAt = py => {
      const ady = Math.abs(py + 0.5 - ay);
      if (ady >= Rc) return null;
      const d = cornerReach(Rc, ady);
      return outX < 0 ? Math.round(ax - d) : Math.round(ax + d);
    };
    const deckYAt = ix => {
      const adx = Math.abs(ix + 0.5 - ax);
      if (adx >= Rc) return null;
      const d = cornerReach(Rc, adx);
      return outY < 0 ? Math.round(ay - d) : Math.round(ay + d);
    };
    // ROW dual — the steep stretch (and the vertical run below it), where the ring hands off to
    // the e/w wall. A row walk lays a HORIZONTAL span, which is ACROSS the outline only here.
    for (let py = yLo; py < yHi; py++) {
      const t = outY < 0 ? cy - (py + 0.5) : (py + 0.5) - cy;    // distance along the lift axis
      if (t >= HR) continue;                                      // past the top of the arc
      if (t > K) continue;                                        // shallow — the column dual owns it
      // below the arc's widest point the outline is simply the straight run at the e/w wall's edge
      const off = t <= 0 ? HR : cornerReach(HR, t);
      const ex = outX < 0 ? Math.round(ax - off) : Math.round(ax + off) - 1;   // -1: see the half-open note above
      const w = crownEase(Math.max(0, t) / HR, capW, capFar);
      const dx = deckXAt(py), inner = dx == null ? (outX < 0 ? X + T : X - 1) : dx;
      /* THE ARC'S DEPTH MEASURE ENDS WITH THE ARC (2026-08-13).
         Past the centre line the outline is the constant straight-run `off`, but faceMap kept
         measuring depth RADIALLY from the lifted centre `cy` — so outline and measure disagree by
         exactly |dy|, and the first |dy| pixels of every such row fall outside the profile and clamp
         to depth 0. Clamped pixels all sample the SAME top row of the strip, so the run came out as
         flat fill widening as |dy| grows: a solid wedge hanging under the curve. That is the
         "triangle flap" Andrew circled — not a surface, but the depth measure running off the end of
         its own profile.
         Dropping the face outright is wrong too (it punches a hole: nothing else paints these rows,
         which are the lifted ramp ABOVE the wall's own tiles). What they actually are is the e/w
         STRAIGHT wall, so they take that wall's addressing — along = world y, depth = rows under the
         crown, capped at FACEW — which is exactly what bakeSideFace samples. The ring's tail is then
         the same material, at the same depth, as the wall it runs into. */
      const onArc = t > 0;
      const fs = outX < 0 ? ex + 2 + w : ex - 2 - w;                       // depth 0: the row just inside the crown
      const room = outX < 0 ? inner - fs : (ex - 1 - w) - inner;
      const len = Math.max(0, onArc ? room : Math.min(room, FACEW));
      const map = onArc ? faceMap : ((px) => ({ a: py, d: Math.abs(px - fs) }));
      if (outX < 0) {
        put(ex, py, 1, 1, shellEdge);                                             // the shell's own edge
        put(ex + 1, py, w, 1, pal.cap); put(ex + 1, py, 1, 1, lit);            // the lit top surface
        // face, down to the deck — depth 0 sits just inside the crown, so the material curves with it
        cornerFaceSlice(putFace, pal, ed, strip, map, alongOf(ex, py), true, py, fs, len, 1, sOf(ex, py));
        put(ex + 1 + w, py, 1, 1, seam);
      } else {
        // the lit edge is the crown's OUTERMOST row, i.e. ex - 1 here — putting it on `ex` paints
        // over the shell edge and rules a near-white line along the station's own silhouette.
        put(ex, py, 1, 1, shellEdge);
        put(ex - w, py, w, 1, pal.cap); put(ex - 1, py, 1, 1, lit);
        cornerFaceSlice(putFace, pal, ed, strip, map, alongOf(ex, py), true, py, fs, len, -1, sOf(ex, py));
        put(ex - 1 - w, py, 1, 1, seam);
      }
    }
    // COLUMN dual — the shallow stretch, where the ring hands off to the n/s wall.
    for (let ix = xLo; ix < xHi; ix++) {
      const adx = Math.abs(ix + 0.5 - ax);
      if (adx >= K) continue;                                     // steep — the row dual owns it
      const s = cornerReach(HR, adx);
      const ey = outY < 0 ? Math.round(cy - s) : Math.round(cy + s) - 1;       // -1: see the half-open note above
      const w = crownEase(s / HR, capW, capFar);
      const dy = deckYAt(ix), inner = dy == null ? (outY < 0 ? Y + T : Y - 1) : dy;
      /* A STANDING FACE IS ADDRESSED LIKE A STANDING FACE (2026-08-13).
         On a TOP corner the arc's centre is LIFTED clear of the tile (cornerArcCy), so walking down
         this column moves AWAY from that centre: the polar radius grows, and faceMap's depth —
         (HR-2-w) - r — therefore SHRINKS the further down the wall you go, peaking at the centre row
         and clamping to 0 below it. The face is 22px tall and the ring's profile only 13px deep, so
         most of every column came out as one repeated strip row: the big flat triangle.
         Depth down a standing face is not a radius, it is a ROW COUNT — the same thing
         bakeTallNorthFace shows on the wall right beside it. Addressing it that way (along = world x,
         depth = rows under the crown) is what makes the corner and the wall one continuous surface.
         Bottom corners keep the polar measure: cy === ay there, the face is short, and the concentric
         bands are the whole point of the curve. */
      const fsY = outY < 0 ? ey + 2 + w : ey - 2 - w;
      const cMap = cy === ay ? faceMap : ((px, py) => ({ a: px, d: Math.abs(py - fsY) }));
      if (outY < 0) {
        put(ix, ey, 1, 1, shellEdge);
        put(ix, ey + 1, 1, w, pal.cap); put(ix, ey + 1, 1, 1, lit);
        cornerFaceSlice(putFace, pal, ed, strip, cMap, alongOf(ix, ey), false, ix, ey + 2 + w, Math.max(0, inner - (ey + 2 + w)), 1, sOf(ix, ey));
        put(ix, ey + 1 + w, 1, 1, seam);
      } else {
        put(ix, ey, 1, 1, shellEdge);
        put(ix, ey - w, 1, w, pal.cap); put(ix, ey - 1, 1, 1, lit);   // outermost crown row, not the shell edge
        cornerFaceSlice(putFace, pal, ed, strip, cMap, alongOf(ix, ey), false, ix, ey - 2 - w, Math.max(0, (ey - 1 - w) - inner), -1, sOf(ix, ey));
        put(ix, ey - 1 - w, 1, 1, seam);
      }
    }
  }

  function bakeWalls(b) {
    for (const e of edges) {
      const X = e.x * T, Y = e.y * T;
      // a doorway gets its sill; an OPEN JOIN gets nothing at all — see "A THRESHOLD IS A HOLE IN
      // A WALL". Painting a track down a seam with no wall on it is what put a bar between two
      // rooms that are one space.
      if (e.door) {
        // same-deck doorways carry no track either — the floor continues through (see deckContinues)
        const dx = e.side === 'w' ? -1 : e.side === 'e' ? 1 : 0, dy = e.side === 'n' ? -1 : e.side === 's' ? 1 : 0;
        if (!e.open && !deckContinues(e.x, e.y, e.x + dx, e.y + dy)) bakeThreshold(b, e, X, Y);
        continue;
      }
      const fw = e.room ? FACEW : 2, out = e.room ? 4 : 2, face = e.room ? NFACE : 5;
      const dep = fw + 1;
      // the SIDE faces (s/w/e) and interior seams carry the room's own wall tone too — otherwise a
      // cobalt room's tall north wall would meet three brown-grey walls at its corners. As of
      // 2026-08-05 they carry its MATERIAL as well, via bakeSideFace — see the ladder note there.
      const pal = wallPal(e.z), wallFace = pal.face, wallTop = pal.top, mat = wallMatOf(e.z);
      /* THE BAND OUTSIDE THE CROWN IS THE SHELL, NOT THE WALL (2026-08-06). Every exterior edge
         below used to fill it with the module constant `wallDk`, and that band is `pad` wide by
         contract — exactly the width of the hull plate. So it covered the plate, its dressing and
         its rim on the north, east and west, and a room's chosen skin survived only on the SOUTH,
         where the skirt hangs below the silhouette and no wall band reaches. Diffing an un-clad
         bake against a TIMBER one showed it exactly: 4882 changed pixels, every one of them in the
         47 rows at the bottom of the room, and not one anywhere else.
         That is what Andrew was looking at — "there is still the previous textures present on some
         shells, and there is also no way to change it". There was not: three sides of every room on
         every station were painted from a constant no menu could reach. */
      const shellEdge = hullEdge(e.z);
      // the same strip the tall face and the corner sample — one picture across all three surfaces
      const eStrip = faceStrip(mat, pal, Math.max(0, Math.round(e.room ? WALL.up : WALL.corUp)) + face);
      /* A SIDE WALL IS SEEN AS ITS TOP SURFACE, and that surface is a BAND, not a line.
         THE CROWN IS A RING, NOT A BACK WALL (2026-07-27, Andrew, tracing the missing left edge in
         a screenshot: "it seems to cut off as if there's only a back wall ... on the left and right
         side there doesn't really feel like there's a real wall there"). Only the north wall is
         extruded up-screen, so it is the only one whose HEIGHT you can read directly; every other
         wall is seen from straight above and is read ENTIRELY by its lit top surface. That surface
         used to be 3px of `shade(base,-0.22)` — DARKER than the deck it encloses — fronting 9px
         of global near-black hull, so the bright crown that defines a wall at any zoom simply
         STOPPED at the two top corners and the e/w sides read as "the floor ends here".
         The fix is not more contrast, it is the SAME LADDER bakeTallNorthFace paints, read outward
         instead of upward, so one continuous top surface runs the whole silhouette:
             contact seam (darkest) · inner face · dark under-seam · CROWN · lit outer edge · hull
         Nothing spikes above its neighbours — the -0.22 crest's original complaint (a bright 1px
         divider column, 2026-07-24) is avoided because the crown is a WIDE band with its highlight
         on the outer edge, where the hull is, not stranded in the middle of the wall. */
      const crownLit = shade(pal.cap, 0.30), crownSeam = shade(pal.cap, -0.45);
      const cw = sideCapW();
      // walls only extrude OUTSIDE the tile when the neighbour is void. Interior boundaries
      // (a non-door seam to another zone) draw the face only, so the wall never smears onto
      // an adjacent room/corridor floor (v7 render.js parity).
      if (e.side === 'n') {
        if (e.exterior) { bakeTallNorthFace(b, e, X, Y); continue; }
        // interior north seam: depth runs DOWN from the tile's top edge (the wall's top is up-screen)
        bakeSideFace(b, pal, mat, X, Y, T, face, 'y', 1, eStrip);
        b.fillStyle = wallTop; b.fillRect(X, Y + face, T, 1);
        b.fillStyle = 'rgba(255,255,255,0.05)'; b.fillRect(X, Y, T, 1);
      } else if (e.side === 's') {
        // the south wall is seen as its TOP surface plus the shadow it drops onto the deck in
        // front of it — same contact-seam law as the north face, mirrored. Its top surface can
        // only ever hang SOUTH of the tile: extruding it toward the viewer like the north wall
        // would bury the walkable row in front of it.
        /* ...AND THE CONTACT SHADOW IS NOW A DIAL, DEFAULTING OFF (2026-08-10). Andrew, circling the
           foot of a room and then again after the deck's transverse seam was cut: "remove the black
           line on the bottom". This band is it — `FACEW` rows of -0.62..-0.46 running the full width
           of every room, the darkest thing on the deck, and the ONE dark cue here that no DEPTH dial
           could reach. At the station's zoom it does not read as a shadow pooling under a wall, it
           reads as a black rule drawn across the bottom of the room, with the lit crown right under
           it making the contrast worse. The crown already separates deck from shell — it is a bright
           band against a dark one, which is all the seating the edge needs.
           `DEPTH.southFoot` keeps the old band one slider away (1 = the shipped sliver). */
        const sf = Math.max(0, DEPTH.southFoot);
        if (sf > 0.001) b.fillStyle = shade(pal.base, -0.62 * sf), b.fillRect(X, Y + T - dep, T, 1);
        /* THE SOUTH WALL HAS NO VISIBLE INNER FACE (2026-08-05, Andrew: "we need to remove the wall
           on the bottom it doesnt make sense to be there due to the angle").
           The camera sits above and SOUTH. That is what lets you see the north wall's inner face at
           all, and by the same geometry it is what forbids the south wall's: that face points north,
           away from you. All you can see of the south wall is its TOP — the crown hanging below the
           tile — and its OUTER face, which is the hull skirt.
           This is the standard open-box convention and it is now consistent: north, east and west
           show their inner faces, the wall nearest the camera is cut away. The sliver inside the tile
           is therefore a CONTACT SHADOW, not a surface — darkest where the deck meets the wall's
           base, easing as it approaches the crown. It always was a flat dark sliver; giving it the
           material made it start asserting a face that cannot be there, which is what showed. */
        if (sf > 0.001) {
          const rows = Math.max(1, Math.round(fw * Math.min(1, sf)));
          for (let i = 0; i < rows; i++) {
            b.fillStyle = shade(pal.base, (-0.62 + 0.16 * (rows <= 1 ? 1 : i / (rows - 1))) * Math.min(1, sf));
            b.fillRect(X, Y + T - rows + i, T, 1);
          }
        }
        if (e.exterior) {
          b.fillStyle = shellEdge; b.fillRect(X, Y + T, T, Math.max(out, cw + 2));   // outer hull band
          crown(b, X, Y + T + 1, T, cw, pal.cap);                                 // the wall's LIT TOP SURFACE
          crown(b, X, Y + T + cw, T, 1, crownLit);                                // lit outer edge
          b.fillStyle = crownSeam; b.fillRect(X, Y + T, T, 1);                    // dark seam under the crown
        } else {
          b.fillStyle = shade(pal.base, -0.22); b.fillRect(X, Y + T - fw, T, 2);   // interior seam keeps the quiet crest
        }
      } else if (e.side === 'w') {
        b.fillStyle = shade(pal.base, -0.62); b.fillRect(X + fw, Y, 1, T);      // contact seam onto the deck
        bakeSideFace(b, pal, mat, X, Y, fw, T, 'x', 1, eStrip);        // west: crown is to the LEFT, so depth grows with x
        if (e.exterior) {
          const side = Math.max(out, cw + 2, Math.round(WALL.side));   // the hull band under the crown — one width, corridors included (see sideCapW)
          b.fillStyle = shellEdge; b.fillRect(X - side, Y, side, T);       // outer hull band — the ROOM'S shell
          b.fillStyle = 'rgba(0,0,0,0.35)'; b.fillRect(X - side, Y, 1, T);
          crown(b, X - 1 - cw, Y, cw, T, pal.cap);                         // the wall's LIT TOP SURFACE
          crown(b, X - 1 - cw, Y, 1, T, crownLit);                         // lit outer edge
          b.fillStyle = crownSeam; b.fillRect(X - 1, Y, 1, T);             // dark seam under the crown
        }
      } else {
        b.fillStyle = shade(pal.base, -0.62); b.fillRect(X + T - dep, Y, 1, T);
        bakeSideFace(b, pal, mat, X + T - fw, Y, fw, T, 'x', -1, eStrip);   // east: crown is to the RIGHT — depth reversed
        if (e.exterior) {
          const side = Math.max(out, cw + 2, Math.round(WALL.side));   // the hull band under the crown — one width, corridors included (see sideCapW)
          b.fillStyle = shellEdge; b.fillRect(X + T, Y, side, T);
          b.fillStyle = 'rgba(0,0,0,0.35)'; b.fillRect(X + T + side - 1, Y, 1, T);
          crown(b, X + T + 1, Y, cw, T, pal.cap);
          crown(b, X + T + cw, Y, 1, T, crownLit);
          b.fillStyle = crownSeam; b.fillRect(X + T, Y, 1, T);
        }
      }
    }
  }

  // A north-facing room wall rises above the deck. Its corridor opening needs
  // two splayed return faces down that full height, not the corridor's short
  // side rails carried straight through the wall. Derive runs from real doors.
  function bakeCorridorMouths(b) {
    const rows = new Map();
    for (const e of edges) {
      if (e.side !== 'n' || !e.room || !e.door || e.open) continue;
      const other = G.zoneGrid[G.idx(e.x, e.y - 1)];
      if (!G.isCorridor(other)) continue;
      const key = e.z + ',' + e.y;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(e);
    }
    for (const row of rows.values()) {
      row.sort((a, b) => a.x - b.x);
      for (let i = 0; i < row.length;) {
        const first = row[i]; let last = first;
        while (++i < row.length && row[i].x === last.x + 1) last = row[i];
        const x0 = first.x * T, x1 = (last.x + 1) * T, Y = first.y * T;
        const up = Math.max(0, Math.round(WALL.up)); if (up < 4) continue;
        const top = Y - up, foot = Y + NFACE, capH = Math.max(2, Math.round(WALL.capH));
        const reach = Math.min(6, Math.max(1, Math.floor((x1 - x0 - 8) / 2)));
        const pal = wallPal(first.z);
        const occlusion = { x: x0 - T * 2, y: top - capH, w: x1 - x0 + T * 4, h: foot - top + capH + 1, sortY: foot + 0.5, rects: [] };
        // Include the solid wall shoulders too: hiding an arm behind the jamb
        // must not leave it visible again on the wall immediately beside it.
        for (const e of edges) {
          if (e.z !== first.z || e.y !== first.y || e.side !== 'n' || e.door) continue;
          const x = e.x * T;
          if (x < occlusion.x || x >= occlusion.x + occlusion.w) continue;
          const y = e.exterior ? top - capH : Y;
          occlusion.rects.push([x, y, T, foot - y + 1]);
        }
        // The room face now owns the old corridor crown pixels beside the
        // opening. Leaving those crown records behind makes dark vertical bars
        // in the lighting mask even after the wall art painted over the rails.
        const lx = x0 - sideCapW() - 2, rx = x1 + sideCapW() + 2;
        crownRects = crownRects.flatMap(([x, y, w, h]) => {
          const ax = Math.max(x, lx), ay = Math.max(y, top), bx = Math.min(x + w, rx), by = Math.min(y + h, foot + 1);
          if (ax >= bx || ay >= by) return [[x, y, w, h]];
          const keep = [];
          if (y < ay) keep.push([x, y, w, ay - y]);
          if (by < y + h) keep.push([x, by, w, y + h - by]);
          if (x < ax) keep.push([x, ay, ax - x, by - ay]);
          if (bx < x + w) keep.push([bx, ay, x + w - bx, by - ay]);
          return keep;
        });
        // Repaint only the open throat from its original deck recipes. This
        // removes the short corridor rail ends without flattening either wall.
        b.save(); b.beginPath(); b.rect(x0, top - capH, x1 - x0, foot - top + capH + 1); b.clip();
        const tiles = { x1: first.x, x2: last.x, y1: Math.floor((top - capH) / T), y2: Math.floor(foot / T) };
        for (const r of G.allRects) {
          if ((r.x2 + 1) * T <= x0 || r.x1 * T >= x1 || (r.y2 + 1) * T <= top - capH || r.y1 * T > foot) continue;
          (G.isCorridor(r.z) ? bakeCorridorFloor : bakeDeck)(b, r, tiles);
        }
        b.restore();
        for (let side = 0; side < 2; side++) {
          const edge = side ? x1 : x0;
          for (let y = top; y <= foot; y++) {
            const t = (y - top) / (foot - top), w = 1 + Math.round(reach * (1 - t));
            const x = side ? edge - w : edge;
            occlusion.rects.push([x, y, w, 1]);
            b.fillStyle = shade(pal.face, (side ? 0.08 : -0.18) - 0.16 * t); b.fillRect(x, y, w, 1);
            const inner = side ? x : edge + w - 1;
            b.fillStyle = shade(pal.base, -0.65); b.fillRect(inner, y, 1, 1);
            if (w > 2) { b.fillStyle = shade(pal.face, side ? 0.22 : -0.03); b.fillRect(side ? inner + 1 : inner - 1, y, 1, 1); }
          }
          // The crown ends turn into the opening; never bridge over its centre.
          for (let k = 0; k < capH; k++) {
            const w = 1 + Math.round(reach * (k + 1) / capH), x = side ? edge - w : edge;
            occlusion.rects.push([x, top - capH + k, w, 1]);
            crown(b, x, top - capH + k, w, 1, pal.cap);
            crown(b, side ? x : edge + w - 1, top - capH + k, 1, 1, shade(pal.cap, 0.30));
          }
          b.fillStyle = shade(pal.cap, -0.45); b.fillRect(side ? edge - reach - 1 : edge, top - 1, reach + 1, 1);
        }
        doorOcclusion.push(occlusion);
      }
    }
  }

  /* a doorway threshold: a recessed metal track + lit lip across the open seam */
  function bakeThreshold(b, e, X, Y) {
    const track = '#3a352c', lip = 'rgba(255,236,196,0.18)';
    // hazard chevrons on the sill (2026-09-03 depth pass) — 3px yellow / 3px black, low alpha so the deck shows through
    const hz = (x, y, w, h, along) => { for (let i = 0; i < (along ? w : h); i += 3) { b.fillStyle = ((i / 3) & 1) ? 'rgba(20,18,12,0.55)' : 'rgba(214,178,52,0.45)'; if (along) b.fillRect(x + i, y, Math.min(3, w - i), h); else b.fillRect(x, y + i, w, Math.min(3, h - i)); } };
    if (e.side === 'n') hz(X, Y + 2, T, 2, true); else if (e.side === 's') hz(X, Y + T - 4, T, 2, true); else if (e.side === 'w') hz(X + 2, Y, 2, T, false); else hz(X + T - 4, Y, 2, T, false);
    if (e.side === 'n') { b.fillStyle = track; b.fillRect(X, Y - 1, T, 2); b.fillStyle = lip; b.fillRect(X, Y, T, 1); }
    else if (e.side === 's') { b.fillStyle = track; b.fillRect(X, Y + T - 1, T, 2); b.fillStyle = lip; b.fillRect(X, Y + T - 1, T, 1); }
    else if (e.side === 'w') { b.fillStyle = track; b.fillRect(X - 1, Y, 2, T); b.fillStyle = lip; b.fillRect(X, Y, 1, T); }
    else { b.fillStyle = track; b.fillRect(X + T - 1, Y, 2, T); b.fillStyle = lip; b.fillRect(X + T - 1, Y, 1, T); }
  }

  /* a vertical reflection streak on the polished deck under a ceiling light. `cx,cy` = streak
     centre, `w` ≈ its half-width. Rendered as a warm-neutral radial gradient painted into a
     TALL-NARROW rect (height ≈ 2.6×width) so the round falloff is clipped into a vertical lens —
     reads as a glossy floor highlight, not fog. Caller supplies the 'lighter' composite. Uses only
     createRadialGradient + fillRect (portable to the headless canvas mock; no scale/ellipse). */
  function bakeSheen(b, cx, cy, w) {
    const s = Math.max(0, DEPTH.sheen);
    if (s <= 0.001 || w < 2) return;
    const halfW = Math.max(2, w);
    // Build the vertical lens from THREE stacked circular radial dabs (top / mid / bright core),
    // spanning ≈2.6×width tall — no scale()/ellipse() so it bakes identically in the headless mock.
    const a0 = s * 0.5;
    const dab = (dy, rad, a) => {
      if (a < 0.004) return;
      const g = b.createRadialGradient(cx, cy + dy, 0.5, cx, cy + dy, rad);
      g.addColorStop(0, 'rgba(252,244,224,' + a.toFixed(3) + ')');
      g.addColorStop(0.6, 'rgba(252,244,224,' + (a * 0.3).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(252,244,224,0)');
      b.fillStyle = g; b.fillRect(cx - rad, cy + dy - rad, rad * 2, rad * 2);
    };
    dab(0, halfW, a0);                       // bright core
    dab(-halfW * 1.1, halfW * 0.72, a0 * 0.55);  // upper taper
    dab(halfW * 1.1, halfW * 0.72, a0 * 0.55);   // lower taper
  }

  /* ---- THE POOL IS CLIPPED TO THE FLOOR, NOT TO THE ROOM (2026-08-05) ----
     Deleting every painted mark on an open seam was necessary and not sufficient. Andrew, on the
     first cut: "this does not look blended in the slightest ... i dont want to see this line in the
     middle." The second cause is LIGHT. The warm floor pool was `fillRect`ed from the room's own
     top-left corner, so the gradient — whose brightest part sits just below the fixture, ~19px down
     — got a HARD horizontal cut at the rect edge. Inside an ordinary room that cut is invisible: it
     hides under the north wall. Across an OPEN JOIN there is no wall to hide it, so the last row of
     one room (its light long since fallen off) met the first row of the next (its pool at full
     strength) with a ~30 luma step in 2px. That is a line, drawn in light instead of paint.

     Two rooms open to each other are ONE space and the light has to carry across. So the pool is
     bounded by two intersected clips instead of a rect:
       1. the station's floor union — light lands on DECK, never on void or the hull skirt (this is
          the guard the old per-rect clamp was really providing, and it does the job properly: a
          neighbour narrower than this room can no longer catch spill on its missing corners);
       2. this room's footprint, GROWN by the pool radius across whichever sides carry an open join.
     At a walled edge nothing grows and the bake is unchanged. */

  /* Virtual lighting samples span both room axes. Their restrained illumination
     cuts supply local depth over the diffuse fill; colour and sheen have their
     own gain so even coverage does not require pale, colourless lighting. */
  /* ---- LIGHT LANDS ON A SURFACE, IT IS NOT A SURFACE (2026-08-10) ----
     Andrew, circling the lit band at the foot of a default HULL-floor room: "not a fan of how this
     lighting is on top of this black dark area — it makes it look unrealistic."

     He is describing a real modelling error, and the measurement backs him. In a room small enough
     that ONE lamp carve covers the whole deck (a 9x7 hab: room cut r≈5.6 tiles, lamp cuts r≈7.8),
     the multiplicative light map is SATURATED everywhere — set LIGHT.floor to 0 and the floor goes
     flat, which means the additive warm pool was carrying essentially all of the visible modelling
     on that deck. An additive wash is a constant: it adds the same warmth to a plate face and to
     the near-black seam beside it, so it VEILS the material instead of revealing it. Over a dark
     deck that reads exactly as reported — a warm decal floating on black.

     Real diffuse light does not add, it SCALES: reflected light is albedo × illumination, so the
     bright parts of a material gain more than its dark parts and the pattern comes UP under the
     lamp. So the pool is now painted to its own layer and its alpha modulated by the deck already
     under it before it composites. Seams stay seams, plate faces catch the light, and the pool's
     shape is unchanged — it is the same lamp, finally landing on a surface.

     `DEPTH.poolAlbedo` is the mix (0 = the old flat wash, 1 = fully albedo-scaled), live-tunable
     in the CRT LAB like every other constant here. The gain is normalised at REF so a mid deck
     bakes near its shipped strength and only the dark/bright extremes move. */
  const POOL_REF = 96;
  function additiveFloorPass(b, draw) {
    if (nextSurfaces()) {
      // Collect the same fixture anchors, without baking a second illumination system
      // into the albedo. The new light compositor models these sources after entities.
      const sourcePlate = canvas(1, 1);
      draw(sourcePlate.getContext('2d'));
      return;
    }
    const k = Math.max(0, Math.min(1, DEPTH.poolAlbedo));
    if (k <= 0.001) { draw(b); return; }
    const layer = canvas(CW, CH);
    const lg = translatedContext(layer);
    draw(lg);
    // scale the layer's alpha by the albedo already painted underneath it
    if (typeof b.getImageData === 'function' && typeof lg.getImageData === 'function') {
      const dst = b.getImageData(0, 0, CW, CH).data;
      const img = lg.getImageData(0, 0, CW, CH);
      const src = img.data;
      for (let i = 3; i < src.length; i += 4) {
        const a = src[i];
        if (!a) continue;
        const luma = (dst[i - 3] * 299 + dst[i - 2] * 587 + dst[i - 1] * 114) / 1000;
        const g = Math.max(0.18, Math.min(1.25, 0.35 + 0.65 * (luma / POOL_REF)));
        src[i] = Math.round(a * (1 + k * (g - 1)));
      }
      lg.putImageData(img, 0, 0);
    }
    b.save();
    b.globalCompositeOperation = 'lighter';
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.drawImage(layer, 0, 0);
    b.restore();
  }

  // Room coverage comes from the diffuse area fill. Fixtures add restrained local
  // highlights, distributed across BOTH axes instead of stretching two central spots.
  const ROOM_FIXTURE_GAIN = 0.22;
  // Colour and material reflection are independent of the coverage cut. Reducing
  // all three by the same gain drained the warmth from the evenly lit deck.
  const ROOM_COLOUR_GAIN = 0.8;
  const lampCols = r => Math.max(1, Math.ceil((r.x2 - r.x1 + 1) / Math.max(3, LIGHT.pitch)));
  function lampRows(Y, RH) {
    const rows = Math.max(1, Math.ceil(RH / (T * Math.max(3, LIGHT.pitch))));
    return { rows, y0: Y + RH / rows * 0.5, step: RH / rows };
  }

  /* the ADDITIVE half of the room lighting — every warm floor pool + its sheen, drawn to whatever
     context `additiveFloorPass` hands it (the albedo layer when DEPTH.poolAlbedo is on, `b`
     directly when it is off). Kept in its own function so the pass can never disagree with it. */
  function bakeRoomPools(b) {
    b.globalCompositeOperation = 'lighter';
    const openSide = (r, side) => {
      if (side === 'n' || side === 's') { const y = side === 'n' ? r.y1 : r.y2; for (let x = r.x1; x <= r.x2; x++) if (isOpenJoin(x, y, side)) return true; }
      else { const x = side === 'w' ? r.x1 : r.x2; for (let y = r.y1; y <= r.y2; y++) if (isOpenJoin(x, y, side)) return true; }
      return false;
    };
    for (const r of G.allRects) {
      if (G.isCorridor(r.z)) continue;
      const X = r.x1 * T, Y = r.y1 * T, RW = (r.x2 - r.x1 + 1) * T, RH = (r.y2 - r.y1 + 1) * T;
      const count = lampCols(r);
      const { rows, y0, step } = lampRows(Y, RH);
      const rad = Math.max(RW / count, RH / rows) * 0.75 * Math.max(0.5, LIGHT.reach || 1);
      const gN = openSide(r, 'n') ? rad : 0, gS = openSide(r, 's') ? rad : 0;
      const gW = openSide(r, 'w') ? rad : 0, gE = openSide(r, 'e') ? rad : 0;
      b.save();
      b.beginPath();
      for (const q of G.allRects) b.rect(q.x1 * T, q.y1 * T, (q.x2 - q.x1 + 1) * T, (q.y2 - q.y1 + 1) * T);
      b.clip();
      b.beginPath(); b.rect(X - gW, Y - gN, RW + gW + gE, RH + gN + gS); b.clip();
      for (let j = 0; j < rows; j++) for (let i = 0; i < count; i++) {
        const lx = X + RW * (i + 0.5) / count, ly = y0 + step * j;
        const gw = b.createRadialGradient(lx, ly, 1, lx, ly, rad * 0.7);
        // Warm-neutral rather than near-white: keeps the shipped pool strength/contrast while
        // taking the clinical edge off the deck and lowering peak luminance a small amount.
        falloffStops(gw, POOL_RGB, LIGHT.floor * ROOM_FIXTURE_GAIN);
        b.fillStyle = gw; b.fillRect(lx - rad * 0.7, ly - rad * 0.7, rad * 1.4, rad * 1.4);
        // FLOOR SHEEN (Slice 2): a faint vertical reflection streak on the deck below the pool, as if
        // the polished plating catches the ceiling light. Narrow (≈40% pool width), taller than wide,
        // additive + very low alpha, warm-neutral like the pool. Drawn under the same 'lighter' pass.
        b.save(); b.globalAlpha = ROOM_COLOUR_GAIN;
        bakeSheen(b, lx, ly + T * 0.9, rad * 0.34); b.restore();
        lampPos.push({ x: lx, y: ly, r: rad * 1.4, rgb: lampRgbOf(r.z), gain: ROOM_FIXTURE_GAIN });
      }
      b.restore();
    }
    // tiny sheen under each doorway light spill (the threshold catches a little floor gloss too)
    for (const [x1, y1, x2, y2] of (G.doorDefs || [])) {
      if (!pairIsSill(x1, y1, x2, y2)) continue;
      bakeSheen(b, (x1 + x2 + 1) / 2 * T, (y1 + y2 + 1) / 2 * T + T * 0.4, T * 0.4);
    }
    b.globalCompositeOperation = 'source-over';
  }

  // Virtual bounce samples light the surfaces without drawing ceiling hardware.
  function bakeRoomLighting(b) {
    additiveFloorPass(b, bakeRoomPools);
    b.globalCompositeOperation = 'source-over';
  }

  /* corridor light samples + wall cable run — feeds lampPos for the lightmap carve.

     LIGHT THE HALLWAY LIKE A ROOM (2026-07-29). Three rounds of corridor DECK work all failed for
     the same reason, and it was never the deck. With the IDENTICAL material laid in both, a room's
     floor is modelled by light across a 58-luma low-frequency spread peaking at 79, and a corridor's
     across 35 peaking at 58 — it never gets a lit area at all. `bakeRoomLighting` skips corridors
     outright, so they got no warm floor pool and no sheen; this function substituted ONE cold
     `rgba(220,230,236,0.10)` dab, half a room's alpha and the wrong colour temperature (measured
     deck warmth R-B: room 7.9, corridor 3.8).
     A floor lit by a flat wash has nothing but its pattern to show, which is exactly why a quiet
     deck (spine) read as a blank card and a busy one (meshway/treadway) read as wallpaper. The
     texture was being asked to do the light's job.
     LAW: if a surface looks wrong everywhere you put it, measure the LIGHT on it before redrawing
     it. Corridors stay DIMMER than rooms — that is the tunnel-vs-hall read and it is deliberate —
     but dim is a level, not an absence of modelling. */
  /* the corridor's ADDITIVE half, split out for the same reason as bakeRoomPools — see the
     albedo note above additiveFloorPass. (The pool loop now runs across ALL corridors before the
     hardware loop instead of interleaving per corridor; the only pixels that can differ are a
     neighbouring passage's fixture cap sitting inside this pool's unclipped square, which the
     wash no longer paints over.) */
  function bakeCorridorPools(b) {
    for (const r of G.allRects) {
      if (!G.isCorridor(r.z)) continue;
      const vertical = (r.y2 - r.y1) > (r.x2 - r.x1);
      const cx = (r.x1 + r.x2 + 1) / 2 * T, cy = (r.y1 + r.y2 + 1) / 2 * T;
      const cross = (vertical ? (r.x2 - r.x1 + 1) : (r.y2 - r.y1 + 1)) * T;
      b.globalCompositeOperation = 'lighter';
      // the room's own floor pool, sized to the passage: warm, at LIGHT.floor, with the polished
      // sheen streak under it. Radius follows the CROSS span so the pool fills the hallway's width
      // and falls off along its length — which is what puts light and shade down a corridor.
      const rad = Math.min(60, Math.max(22, cross * 0.85)) * Math.max(0.5, LIGHT.reach || 1);
      const pool = (lx, ly) => {
        const g = b.createRadialGradient(lx, ly, 1, lx, ly, rad * 0.7);
        falloffStops(g, POOL_RGB, LIGHT.floor);
        b.fillStyle = g; b.fillRect(lx - rad * 0.7, ly - rad * 0.7, rad * 1.4, rad * 1.4);
        bakeSheen(b, lx, ly + T * 0.9, rad * 0.34);
        lampPos.push({ x: lx, y: ly, r: rad * 1.4, rgb: lampRgbOf(r.z) });
      };
      /* A WALL WASH PER FIXTURE WAS TRIED HERE AND REMOVED (2026-07-29) — keep the result, it is
         not obvious. The theory was that a corridor's pool is centred on the passage and sized to
         its narrow cross span, so nothing reaches the flanking walls; the fix was an extra clipped
         cut on each long wall under every fixture. MEASURED, it did the exact opposite of its
         intent. The wall already peaks AT the fixtures (luma 24.6 / 23.8) and dips between them
         (14.4) — the rhythm was never missing. Because the lightmap cut is MULTIPLICATIVE
         (destination-out), a second cut can only remove what ambient is LEFT, and the least is left
         exactly where a fixture already cut it: the wash added +1.1 at the fixtures and +4.4 in the
         dark middle. It was a fill light, and it flattened the wall it was meant to model.
         LAW: on a multiplicative light mask you cannot add a HIGHLIGHT, only lift a SHADOW. To make
         a surface read brighter, raise the surface's own tone or its lamp's reach — do not stack
         another cut where one already landed. The real defect was the wall's TONE (see
         worldmodel's wallStyleOfRoom). */
      if (vertical) for (let y = r.y1 + 1; y <= r.y2; y += 4) pool(cx, (y + 0.5) * T);
      else for (let x = r.x1 + 1; x <= r.x2; x += 4) pool((x + 0.5) * T, cy);
      b.globalCompositeOperation = 'source-over';
    }
  }

  function bakeCorridorDressing(b) {
    additiveFloorPass(b, bakeCorridorPools);
    for (const r of G.allRects) {
      if (!G.isCorridor(r.z)) continue;
      const vertical = (r.y2 - r.y1) > (r.x2 - r.x1);
      const cx = (r.x1 + r.x2 + 1) / 2 * T, cy = (r.y1 + r.y2 + 1) / 2 * T;
      b.globalCompositeOperation = 'source-over';
      /* THE CABLE RUN HANGS ON A WALL (2026-08-05). It is conduit — "a coloured cable run on the
         wall side" — and it was pinned to the corridor's first row/column unconditionally. Lay a
         hallway along a room's face and that flank is not a wall at all but an OPEN JOIN, so a 1px
         #a3402e line at luma 91 got painted straight down the boundary between the two decks: the
         brightest thing for 70px in either direction, and one more border where the floors are meant
         to meet. Take whichever flank actually carries wall; if neither does — a passage open on
         both long sides — there is nothing to hang it on, so it doesn't run. */
      const openFlank = (fx, fy, n, dx, dy, side) => { for (let i = 0; i < n; i++) if (isOpenJoin(fx + dx * i, fy + dy * i, side)) return true; return false; };
      const span = (vertical ? (r.y2 - r.y1) : (r.x2 - r.x1)) + 1;
      const lo = vertical ? !openFlank(r.x1, r.y1, span, 0, 1, 'w') : !openFlank(r.x1, r.y1, span, 1, 0, 'n');
      const hi = vertical ? !openFlank(r.x2, r.y1, span, 0, 1, 'e') : !openFlank(r.x1, r.y2, span, 1, 0, 's');
      if (lo || hi) {
        b.fillStyle = '#a3402e';
        if (vertical) b.fillRect(lo ? r.x1 * T + 2 : (r.x2 + 1) * T - 3, r.y1 * T + 2, 1, (r.y2 - r.y1 + 1) * T - 4);
        else b.fillRect(r.x1 * T + 2, lo ? r.y1 * T + 2 : (r.y2 + 1) * T - 3, (r.x2 - r.x1 + 1) * T - 4, 1);
      }
    }
  }

  /* THE SKIRT — the tall exterior wall seen from outside, and the surface that carries a hull skin.
     It renders at its RAW baked tones: the ambient mask deliberately stops at the floor line, so
     whatever a recipe paints here is what you see, unlit and unmediated.

     ---- ONE SKIRT PER SKIN, NOT ONE PER STATION (2026-08-05) ----
     This was a single silhouette over every footprint at once, which is correct while the shell is
     one material: adjacent rooms merge into one unbroken wall with no seam between them, and that
     merge is exactly what made a station read as ONE building. It is also what has to give for a
     station to read as SEVERAL. Footprints are grouped by hull KEY (material + hue) and each group
     stamps its own silhouette, so same-skin neighbours still merge — the old behaviour survives
     untouched for any station wearing one skin — while a timber cabin beside a brick house each get
     their own wall and their own corner. That boundary between two skirts IS the street.

     Groups composite `destination-over` in G.allRects order, i.e. under everything already painted,
     so a neighbour's skirt can never cover a plate that is already down; between two skirts meeting
     in open void, first-drawn wins, deterministically. Grouping reads only room ids and never the
     viewport, so a chunk bake groups identically to a monolithic one (chunk-parity, the property
     stationbake.chunk.test.js exists to defend). */
  /* PER-COLUMN WALL TOP — for each canvas column, the row where this group's exterior wall begins
     (one past the silhouette's lowest opaque pixel), or -1 where the group has no wall at all.

     THIS IS WHAT MAKES A MATERIAL TURN A CORNER (2026-08-05, Andrew: "any way they can curve around
     the edges so it makes a bit more sense?"). The skirt's own DEPTH ramp already follows the hull —
     it is the silhouette stamped downward, so it curves for free, and that is why the untextured
     station shell always looked right at a rounded corner. The veins did not: they were ruled in
     flat absolute rows and then clipped by the curve, so every log course and brick bed ended at a
     different x and the corner read as a RAGGED STAIRCASE of sliced units beside a wall that curved
     perfectly. Measuring each course down from its own column's wall top instead bends the whole
     texture with the hull, and the wall runs out into the corner the way masonry actually does.

     Falls back to null where pixels can't be read back (the headless canvas mock), exactly like
     ditherLight — coursed materials then paint flat absolute rows, which is what they did before,
     so both bake paths still agree with each other and chunk parity is unaffected. */
  function skirtTops(sil, w, h) {
    const g = sil.getContext('2d');
    if (typeof g.getImageData !== 'function') return null;
    let img;
    try { img = g.getImageData(0, 0, w, h); } catch (e) { return null; }
    const d = img.data, out = new Int32Array(w);
    for (let x = 0; x < w; x++) {
      let last = -1;
      for (let y = h - 1; y >= 0; y--) if (d[((y * w + x) << 2) + 3]) { last = y; break; }
      out[x] = last < 0 ? -1 : last + 1;
    }
    return out;
  }

  function bakeHullExtrusion(b) {
    const skirt = Math.max(4, Math.round(WALL.skirt));
    // vertical working margin: a footprint whose bottom edge sits just ABOVE this viewport
    // must still drop its skirt INTO it (and one ending just below must not lose its lip),
    // so the silhouette canvases are taller than the viewport by the full skirt reach.
    const M = skirt + 4, CH2 = CH + M * 2;
    const groups = new Map();
    for (const r of G.allRects) {
      const k = hullKeyOf(r.z);
      let grp = groups.get(k);
      if (!grp) { grp = { z: r.z, rects: [] }; groups.set(k, grp); }
      grp.rects.push(r);
    }
    const tmp = canvas(CW, CH2);
    const tg = tmp.getContext('2d');
    const list = [...groups.values()];
    const stampRect = (g, r) => g.fillRect(r.x1 * T - pad, r.y1 * T - pad, (r.x2 - r.x1 + 1) * T + pad * 2, (r.y2 - r.y1 + 1) * T + pad * 2);
    const eraseAllChamfers = g => { for (const [ccx, ccy, kind] of G.chamfers) { const A = CORNER[kind]; eraseSpandrel(g, kind, (ccx + A.cx) * T, (ccy + A.cy) * T, HR); } };
    /* which chamfers are a rect's OWN — the four corners it can legitimately round off itself */
    const ownChamfers = r => G.chamfers.filter(([cx, cy, k]) =>
      cx === (k === 'tr' || k === 'br' ? r.x2 : r.x1) && cy === (k === 'bl' || k === 'br' ? r.y2 : r.y1));
    const silOf = grp => {
      const sil = canvas(CW, CH2);
      const g = sil.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.translate(-VX, -(VY - M));
      g.fillStyle = '#fff';
      for (const r of grp.rects) stampRect(g, r);
      /* THE CORNER ERASE RUNS OVER *ALL* CHAMFERS, NOT THIS GROUP'S. A chamfer is cut from the
         station's silhouette, and a neighbouring room's rounded corner takes a bite out of the void
         this group's skirt would otherwise fill. Filtering to the group's own chamfers put a square
         shoulder of skirt back into every corner a differently-clad neighbour had rounded. */
      eraseAllChamfers(g);
      /* ...BUT A CHAMFER MAY ONLY ROUND AWAY VOID, NEVER ANOTHER FOOTPRINT'S OWN PLATE RING
         (2026-08-16, Andrew, drawing a yellow line down the missing corner: "here i drew a literal
         yellow line to show u where its supposed to be extended to connect. do not reshape it, it
         still needs to be at the exact angle, but just perfectly connected").

         Two rooms side by side whose south edges differ by one tile: the lower room's inner bottom
         corner is chamfered, and the erase above — correctly running over ALL chamfers — takes that
         45° bite out of the UPPER room's plate ring too. The skirt is this silhouette extruded
         downward, so the bite rides the whole way down and the upper run's wall ends one tile short
         with its coursing sliced at a hard edge. That short corner is what he drew the line on.

         The line the erase must not cross is ownership: a corner rounds off the room it belongs to.
         Where the wedge is VOID it still gets cut (that is the 2026-08-06 case above, and the skirt
         hanging into a neighbour's rounded corner is void, covered by no rect). Where it lands on a
         DIFFERENT footprint's plate ring, that ring is structure, and structure is not somebody
         else's corner to round. Restoring exactly that — each rect re-stamped minus only its OWN
         corners — extends the upper wall down to meet the chamfer at the same angle it always had.

         Built per rect on a scratch and unioned, because the erase is order-dependent: stamping
         every rect first and then cutting would let one rect's corner eat a neighbour that overlaps
         it. Keyed on world tile coords like everything else here, so chunk↔monolithic parity holds. */
      const keep = canvas(CW, CH2), kg = keep.getContext('2d');
      kg.imageSmoothingEnabled = false;
      for (const r of grp.rects) {
        const one = canvas(CW, CH2), og = one.getContext('2d');
        og.imageSmoothingEnabled = false;
        og.save(); og.translate(-VX, -(VY - M)); og.fillStyle = '#fff'; stampRect(og, r);
        for (const [ccx, ccy, kind] of ownChamfers(r)) { const A = CORNER[kind]; eraseSpandrel(og, kind, (ccx + A.cx) * T, (ccy + A.cy) * T, HR); }
        og.restore();
        kg.drawImage(one, 0, 0);
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(keep, 0, 0);
      return sil;
    };
    const sils = list.map(silOf);

    /* ============ WHO OWNS A SKIRT PIXEL? THE NEAREST FOOTPRINT ABOVE IT ============
       (2026-08-06, Andrew: "if you change multiple shells it will break the whole texture system
       and start glitching out other different separate room textures ... sometimes they half
       render".)

       Each group used to be composited straight onto the base with `destination-over`, which means
       THE FIRST GROUP DRAWN WINS every pixel the others also want — and the draw order is just the
       order rooms happen to sit in `G.allRects`. Skirts overlap constantly: a footprint's plate ring
       reaches `pad` past its floor and its skirt hangs `skirt` px further, so any room within ~39px
       of another (which on a real station is most of them) contends for the same void.

       The result was a room's skirt appearing in the strip its neighbour's skirt did not happen to
       cover and stopping dead at the boundary — a HALF-RENDERED wall that looks like the material
       failed to apply, and which changes shape when ANOTHER room is re-clad, because re-cladding
       moves rooms between groups and so reorders the draw. Nothing was stale and nothing reverted;
       two materials were fighting over the same pixels and the winner was arbitrary.

       Ownership is not a draw order, it is a fact about the geometry: a skirt is the wall you see
       hanging below a footprint, so a pixel belongs to the footprint DIRECTLY ABOVE IT, and where
       two are above it, to the NEARER one. One downward scan per column settles it exactly.
       Cheap, and it makes the group masks disjoint, so composite order stops mattering at all.

       ⛔⛔ OWNERSHIP IS PER FOOTPRINT, NOT PER GROUP — AND THE VEINS PASS NEEDS IT THAT WAY.
       (2026-08-06, Andrew, with the decisive repro: "it works perfectly fine, unless u place
       something in front of the shell, then it will glitch and destroy the texture".)
       `skirtTops` answers ONE row per column: the row below the LOWEST silhouette pixel there. That
       is the whole truth only while a column holds a single footprint. Put a second room SOUTH of
       the first — "in front of" it — and both are in the same column, so the answer jumps to the
       southern room's underside and the northern room's skirt has its courses, rivets and bricks
       anchored somewhere below the room in front of it. Its BANDS still stamp (those come from the
       silhouette itself), which is why the wall keeps its shape and loses its material: it goes flat
       the instant you build in front of it, and comes back if you delete what you built.
       So the raster is keyed per RECT, and the veins pass runs once PER FOOTPRINT with that
       footprint's own skirt top, masked to the pixels it owns. Bands and the panel seam stay
       per-group: a ramp is stamped from the silhouette and a seam is a vertical line, and neither
       has anything to anchor to a column. */
    const rects = G.allRects;
    let own = null, tops = null;
    {
      const idxCv = canvas(CW, CH2), ig = idxCv.getContext('2d');
      ig.imageSmoothingEnabled = false;
      ig.save();
      ig.translate(-VX, -(VY - M));
      const idxOf = i => { const n = i + 1; return 'rgb(' + (n & 255) + ',' + ((n >> 8) & 255) + ',0)'; };   // 0 = "no footprint"; 16 bits is far past MAX rects
      rects.forEach((r, i) => {
        ig.fillStyle = idxOf(i);
        ig.fillRect(r.x1 * T - pad, r.y1 * T - pad, (r.x2 - r.x1 + 1) * T + pad * 2, (r.y2 - r.y1 + 1) * T + pad * 2);
      });
      // the same all-chamfers erase the silhouettes take, so ownership follows the rounded corners
      for (const [ccx, ccy, kind] of G.chamfers) { const A = CORNER[kind]; eraseSpandrel(ig, kind, (ccx + A.cx) * T, (ccy + A.cy) * T, HR); }
      ig.restore();
      /* ...and the SAME own-corners-only restore the silhouette takes (see the note there). The
         ownership raster is what `maskTo` cuts every group back to, so a plate ring the silhouette
         keeps but ownership dropped would be masked straight back out and the corner would stay
         short. The two rasters must agree pixel for pixel or the fix is invisible. */
      rects.forEach((r, i) => {
        const one = canvas(CW, CH2), og = one.getContext('2d');
        og.imageSmoothingEnabled = false;
        og.save(); og.translate(-VX, -(VY - M));
        og.fillStyle = idxOf(i);
        og.fillRect(r.x1 * T - pad, r.y1 * T - pad, (r.x2 - r.x1 + 1) * T + pad * 2, (r.y2 - r.y1 + 1) * T + pad * 2);
        for (const [ccx, ccy, kind] of ownChamfers(r)) { const A = CORNER[kind]; eraseSpandrel(og, kind, (ccx + A.cx) * T, (ccy + A.cy) * T, HR); }
        og.restore();
        ig.drawImage(one, 0, 0);
      });
      let img = null;
      try { img = ig.getImageData(0, 0, CW, CH2); } catch (e) { img = null; }
      if (img) {
        const d = img.data;
        own = new Uint16Array(CW * CH2);
        for (let x = 0; x < CW; x++) {
          let last = 0, lastY = -1e9;
          for (let y = 0; y < CH2; y++) {
            const i = ((y * CW) + x) << 2;
            if (d[i + 3]) { last = d[i] | (d[i + 1] << 8); lastY = y; }
            else if (last && y - lastY <= skirt) own[y * CW + x] = last;
          }
        }
        // ...and each footprint's own skirt top per column, in one pass over the ownership map
        tops = rects.map(() => new Int32Array(CW).fill(-1));
        for (let x = 0; x < CW; x++) {
          for (let y = 0; y < CH2; y++) {
            const n = own[y * CW + x];
            if (n && tops[n - 1][x] < 0) tops[n - 1][x] = y;
          }
        }
      }
    }
    // rect index -> its group's index, so a group can be masked to the union of its footprints
    const groupOfRect = new Int32Array(rects.length).fill(-1);
    list.forEach((grp, gi) => { for (const r of grp.rects) { const i = rects.indexOf(r); if (i >= 0) groupOfRect[i] = gi; } });
    const maskTo = (ctx, keep) => {   // cut ctx back to the pixels `keep(rectIndex)` accepts
      const mask = tg.createImageData(CW, CH2), md = mask.data;
      for (let p = 0, q = 3; p < own.length; p++, q += 4) { const n = own[p]; if (n && keep(n - 1)) md[q] = 255; }
      tg.globalCompositeOperation = 'source-over';
      tg.clearRect(0, 0, CW, CH2); tg.putImageData(mask, 0, 0);
      ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(tmp, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    };

    list.forEach((grp, gi) => {
      const pal = hullPal(grp.z);
      const recipe = HULL_RECIPES[hullMatOf(grp.z)] || hullStation;
      const sil = sils[gi];
      const f = canvas(CW, CH2);
      const fg = f.getContext('2d');
      const stamp = (dy, c) => {
        tg.globalCompositeOperation = 'source-over';
        tg.clearRect(0, 0, CW, CH2); tg.drawImage(sil, 0, dy);
        tg.globalCompositeOperation = 'source-in'; tg.fillStyle = c; tg.fillRect(0, 0, CW, CH2);
        tg.globalCompositeOperation = 'source-over'; fg.drawImage(tmp, 0, 0);
      };
      for (const [dy, c] of fadeBands((recipe.bands || rampBands)(pal, skirt), skirt)) stamp(dy, c);
      fg.globalCompositeOperation = 'destination-out'; fg.drawImage(sil, 0, 0);
      fg.globalCompositeOperation = 'source-over';
      /* cut this group back to the pixels it actually owns. Without it the group that drew first
         kept every contested pixel — see the ownership note above. Built as a mask and applied with
         destination-in so the band ramp underneath is untouched. */
      if (own) maskTo(fg, i => groupOfRect[i] === gi);

      if (recipe.veins || recipe.seam) {
        /* THE VEINS RUN PER FOOTPRINT. Each one is anchored to ITS OWN skirt top and clipped to the
           pixels it owns, so a room standing in front of another can no longer drag its neighbour's
           coursing down with it. Rendered to a scratch layer and folded in source-atop, because the
           marks must land only where this group's skirt already is. */
        const marks = canvas(CW, CH2), mg = marks.getContext('2d');
        mg.imageSmoothingEnabled = false;
        if (recipe.veins && own && tops) {
          for (let i = 0; i < rects.length; i++) {
            if (groupOfRect[i] !== gi) continue;
            const one = canvas(CW, CH2), og = one.getContext('2d');
            og.imageSmoothingEnabled = false;
            // world-coord keying: the canvas' top-left is world (VX, VY - M), so a recipe adding
            // these offsets gets marks that land on the same world pixel in every chunk showing them
            recipe.veins(og, pal, CW, CH2, VX, VY - M, tops[i]);
            maskTo(og, k => k === i);
            mg.drawImage(one, 0, 0);
          }
        } else if (recipe.veins) {
          // headless / no getImageData: the pre-ownership behaviour, one anchor for the whole group
          recipe.veins(mg, pal, CW, CH2, VX, VY - M, skirtTops(sil, CW, CH2));
        }
        panelSeam(mg, CW, CH2, VX, recipe.seam == null ? SHARED_SEAM : recipe.seam);
        fg.globalCompositeOperation = 'source-atop';
        fg.drawImage(marks, 0, 0);
        fg.globalCompositeOperation = 'source-over';
      }
      b.globalCompositeOperation = 'destination-over';
      b.drawImage(f, VX, VY - M);
      b.globalCompositeOperation = 'source-over';
    });
  }

  /* ---------- INTERSTITIAL SHADOW ----------
     (2026-08-11, Andrew circling two wall junctions: "the overlap of walls is terrible now. we
     need to fix this and make sure its layered correctly".)

     On a station whose footprints sit 1–2 tiles apart (every pre-snap save does), the void
     slivers BETWEEN hulls are where all the exterior dressing collides: one room's skirt hangs
     32px down, the neighbour's north face and corner arc rise to meet it, and a chamfer's
     silhouette erase bites the skirt diagonally. None of that is a draw-order bug — the nearer
     wall correctly paints over the farther one. What made the junctions read as BROKEN is the
     pixels none of them own: raw transparent void inside the sliver, where the space backdrop
     shines through a gap that the eye reads as a hole punched in the wall.

     So: any void pixel enclosed between hull silhouettes within GAP — vertically OR
     horizontally — is an alley the camera cannot see the sky through, and it fills with flat
     near-black shadow, composited UNDER everything already painted. The skirts, arcs and crowns
     then read as layered walls standing in front of a dark shaft, which is exactly what the
     geometry says they are. Open concave coastline (a run unbounded on either side, or wider
     than the window) keeps its backdrop.

     ---- AN ALLEY IS A SLIVER, NOT A CHANNEL YOU COULD HAVE WALKED DOWN (2026-08-17) ----
     ⛔⛔⛔ Andrew, circling the void between two rooms after building a hallway between them and
     deleting it: "it went black where i circled." Nothing was stale — the delete bakes
     pixel-identical to never having built the hallway (0 of 582,336 px differ, measured). This
     pass was painting the hole. `GAP` alone admitted every footprint gap from 2 to 7 floor
     tiles; `MIN_HALL` is 2, so EVERY deleted hallway landed inside the alley window and came
     back as a flat #0c0b09 slab with no stars behind it.

     The root shape this pass was built for was measured at the time and written down:
     footprints **1–2 tiles apart**. Wider than that is not exterior dressing colliding in a
     sliver, it is a genuine opening between two modules, and the backdrop belongs in it. So
     `GAP` still says which void a hull can BOUND, and `NARROW` now says which of it is close
     enough to be an alley at all. See NARROW for why the second test needs its own silhouette.

     Chunk parity: the silhouette canvas carries a margin of the full window + pad, so a
     footprint just outside a chunk's viewport still bounds runs inside it; contexts that cannot
     read pixels back (the headless canvas mock) skip the pass on BOTH bake paths, exactly like
     ditherLight. Both scans read that same margin and NARROW < GAP, so the added test is bounded
     identically and chunk↔monolithic parity is unaffected. */
  function bakeInterstitialShadow(b) {
    // capability check on a 1px canvas BEFORE the real allocation: the chunk test's canvas mock
    // counts every allocation against its chunk-size bound, and this pass skips under the mock
    // anyway — it must skip before allocating, not after.
    if (typeof canvas(1, 1).getContext('2d').getImageData !== 'function') return;
    const GAP = T * 5 + pad * 2;   // how far apart two hulls can be and still bound an alley run
    const M = GAP + pad;
    const w = CW + 2 * M, h = CH + 2 * M;
    const sil = canvas(w, h);
    const g = sil.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.translate(-(VX - M), -(VY - M));
    g.fillStyle = '#fff';
    // stamped as wide as the DRAWN facade, not the footprint: the e/w hull band's outer edge is
    // x*T - WALL.side (see the exterior side band in bakeWalls) while the silhouette's is
    // x*T - pad, and without the difference an alley MOUTH on the station's coastline kept its
    // jagged gap between the two rooms' side bands while the alley behind it filled.
    const sw = Math.max(0, Math.round(WALL.side) - pad);
    for (const r of G.allRects) g.fillRect(r.x1 * T - pad - sw, r.y1 * T - pad, (r.x2 - r.x1 + 1) * T + pad * 2 + sw * 2, (r.y2 - r.y1 + 1) * T + pad * 2);
    /* READ THE SQUARE SILHOUETTE FIRST — it is what says how far apart two hulls really are.
       See NARROW below: the chamfer erase that follows removes silhouette, so a run measured
       after it can be tens of px longer than the footprint gap that produced it. */
    let sq;
    try { sq = g.getImageData(0, 0, w, h).data; } catch (e) { return; }
    // the same all-chamfers erase the skirt silhouettes take, so the shadow's bounds follow the
    // rounded corners and the fill reaches into the wedge the erase cut out of a neighbour's skirt
    for (const [ccx, ccy, kind] of G.chamfers) { const A = CORNER[kind]; eraseSpandrel(g, kind, (ccx + A.cx) * T, (ccy + A.cy) * T, HR); }
    let img;
    try { img = g.getImageData(0, 0, w, h); } catch (e) { return; }
    const d = img.data;
    /* runs of void bounded on both sides within `win`, marked into `out`; `src` is the alpha
       source (square or rounded silhouette) the bounds are measured against. */
    const scanRuns = (src, win, out) => {
      for (let x = 0; x < w; x++) {                        // vertical: bounded above AND below
        let last = -1;
        for (let y = 0; y < h; y++) {
          if (!src[(((y * w) + x) << 2) + 3]) continue;
          if (last >= 0 && y - last > 1 && y - last - 1 <= win) for (let k = last + 1; k < y; k++) out[k * w + x] = 1;
          last = y;
        }
      }
      for (let y = 0; y < h; y++) {                        // horizontal: bounded left AND right
        let last = -1;
        const row = y * w;
        for (let x = 0; x < w; x++) {
          if (!src[((row + x) << 2) + 3]) continue;
          if (last >= 0 && x - last > 1 && x - last - 1 <= win) for (let k = last + 1; k < x; k++) out[row + k] = 1;
          last = x;
        }
      }
    };
    /* ⛔⛔⛔ NARROWNESS IS MEASURED ON THE **SQUARE** SILHOUETTE. This is the whole fix, and the
       first two attempts died on it. A gap of Gs floor tiles leaves a void run of `G*T - 2*pad`
       px — G=2 → 10, G=3 → 22 — so a window anywhere in [10, 21] separates the 1–2 tile root
       shape from a walkable channel. But measured on the ROUNDED silhouette those numbers are a
       fiction: `eraseSpandrel` cuts radius HR out of every chamfer, so rows through a corner in
       a genuine 2-tile sliver run 10 + up to 2*HR px and fall straight out of the window. Doing
       exactly that opened a star-lit crack down the middle of the 08-11 junction — the very
       "hole punched in the wall" this pass exists to close. The square stamp is the footprint
       geometry with nothing rounded away, so it answers the question actually being asked.
       (The other blind alley, for the record: requiring BOTH axes to bound a pixel. The 08-11
       junction's sliver is itself a channel open to space at top and bottom — just a narrow
       one — so an AND rule erases it even harder. Enclosure is not the discriminator; WIDTH is.) */
    const NARROW = T + pad;
    const mark = new Uint8Array(w * h), narrow = new Uint8Array(w * h);
    scanRuns(d, GAP, mark);          // the alley candidates, exactly as before
    scanRuns(sq, NARROW, narrow);    // ...of which only the genuinely narrow ones survive
    for (let p = 0, q = 3; p < mark.length; p++, q += 4) {
      if (!mark[p]) continue;
      // a chamfer wedge is opaque in the square stamp and void in the rounded one: it is a corner
      // bitten out of a hull that `mark` already vouched for as enclosed, so it keeps its backing
      // (a coastline chamfer is not enclosed, never enters `mark`, and so still shows sky).
      if (!narrow[p] && !sq[q]) mark[p] = 0;
    }
    const out = canvas(CW, CH), og = out.getContext('2d');
    const oi = og.createImageData(CW, CH), od = oi.data;
    for (let y = 0; y < CH; y++) {
      const src = (y + M) * w + M;
      for (let x = 0; x < CW; x++) {
        if (!mark[src + x]) continue;
        const q = ((y * CW) + x) << 2;
        od[q] = 12; od[q + 1] = 11; od[q + 2] = 9; od[q + 3] = 255;
      }
    }
    og.putImageData(oi, 0, 0);
    b.globalCompositeOperation = 'destination-over';
    b.drawImage(out, VX, VY);
    b.globalCompositeOperation = 'source-over';
  }

  /* ORDERED DITHER — the light map is the one surface still painted in smooth alpha falloff,
     which reads soft/"digital" against the hard-stepped floors and walls. This pass quantizes
     its alpha into a few hard levels and breaks each transition with a 4x4 Bayer checker, so
     the LIGHTING speaks the same chunky pixel dialect as the geometry. Rules that keep the
     chunk cache honest (stationbake.chunk.test.js asserts chunk↔monolithic pixel parity):
       - the Bayer threshold is keyed on WORLD pixel coords (canvas-local + VX/VY), so a pixel
         dithers identically no matter which chunk viewport bakes it;
       - contexts that can't read pixels back (the headless canvas mock) skip the pass — both
         bake paths skip together, so parity holds there too.
     DEPTH.dither = mix between the smooth original and the fully dithered result (0 = off). */
  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  function ditherLight(L, w, h) {
    const k = Math.max(0, Math.min(1, DEPTH.dither));
    if (k <= 0.001) return;
    if (typeof L.getImageData !== 'function' || typeof L.putImageData !== 'function') return;
    const img = L.getImageData(0, 0, w, h);
    const d = img.data;
    const STEPS = 5;   // alpha quantized to 6 hard values (0, 51, 102 … 255)
    for (let y = 0; y < h; y++) {
      const row = ((y + VY) & 3) << 2;
      for (let x = 0; x < w; x++) {
        const i = ((y * w + x) << 2) + 3;
        const a = d[i];
        if (!a || a === 255) continue;
        const t = (BAYER4[row | ((x + VX) & 3)] + 0.5) / 16;
        const q = Math.min(STEPS, Math.floor((a / 255) * STEPS + t)) * (255 / STEPS);
        d[i] = Math.round(a + (q - a) * k);
      }
    }
    L.putImageData(img, 0, 0);
  }

  // Surfaces which may receive interior illumination. Hull skirts and crowns
  // deliberately have no coverage. Use the same pixel corner cuts as the art.
  function interiorReceiver() {
    const cv = canvas(CW, CH), b = translatedContext(cv);
    b.fillStyle = '#fff';
    for (const r of G.allRects) b.fillRect(r.x1*T, r.y1*T, (r.x2-r.x1+1)*T, (r.y2-r.y1+1)*T);
    for (const [x, y, kind] of G.chamfers) {
      const a = CORNER[kind];
      eraseSpandrel(b, kind, (x+a.cx)*T, (y+a.cy)*T, T);
    }
    // The visible north wall FACE is inside; its cap above topY is outside.
    for (const e of edges) if (e.side === 'n' && !e.door && !e.open) {
      const up = Math.max(0, Math.round(e.room ? WALL.up : WALL.corUp));
      b.fillRect(e.x*T, e.y*T-up, T, up+(e.room ? NFACE : 5));
    }
    // A raised corner face extends above and outside its floor tile. Reuse the
    // painter's clipped spans so it receives the same light as the straight wall.
    for (const [x,y,w,h] of cornerFaceRects) b.fillRect(x,y,w,h);
    b.globalCompositeOperation = 'destination-out';
    for (const [x,y,w,h] of crownRects) b.fillRect(x,y,w,h);
    b.globalCompositeOperation = 'source-over';
    return cv;
  }

  function buildLightMap() {
    const lightCv = canvas(CW, CH);
    const L = translatedContext(lightCv);
    // darker ambient: the station leans on its OWN lights (the lamp cuts below punch brighter
    // pools out of this). Built as an opaque MASK drawn once at LIGHT.ambient alpha, so the
    // per-rect fills UNION instead of stacking — overlapping footprints (and the new tall-wall
    // reach above/below them) never double-darken.
    const capH = Math.max(2, Math.round(WALL.capH));
    // up-reach must never exceed the pixels the wall art actually paints — anything past the
    // wall's top edge darkens BARE SPACE, which reads as a floating shadow band above rooms
    // on the colored SpaceBG (invisible back when space was pure black). The tall face tops
    // out at topY - capH - 2 (lip) above the floor line; the legacy up:0 short wall at its
    // NCAP band (4 rooms / 2 corridors). Both sit above the pad-wide hull plate, so the extra
    // strip spans the footprint width ONLY (no horizontal pad — the pad wings would hang in space).
    const upReach = r => {
      const up = Math.max(0, Math.round(G.isCorridor(r.z) ? WALL.corUp : WALL.up));
      return up > 0 ? up + capH + 2 : (G.isCorridor(r.z) ? 2 : 4);
    };
    // the raised north faces sit under the ambient like the rest of the interior (lamp cuts
    // give them life); the hull SKIRT below stays OUTSIDE the mask — it hangs in void where
    // no lamp reaches, so it renders at its baked tones (else it fades to nothing).
    const mask = canvas(CW, CH);
    const mg = mask.getContext('2d');
    mg.imageSmoothingEnabled = false;
    mg.translate(-VX, -VY);
    /* SHADOW HAS A COLOUR. The plate was rgb(7,5,3) — a WARM black, the same hue family as the
       tungsten it stands in for, so lit and unlit differed only in brightness and the whole room
       read as one grey field at two exposures. Real unlit interior is filled by cold bounce, and
       the film's alpha already tracks the darkness, so tinting the plate cold puts the blue
       exactly where the shadow is deepest and nowhere else — no haze pass, no per-pixel work. */
    const coolK = Math.max(0, Math.min(1, LIGHT.cool));
    const mixc = (warm, cold) => Math.round(warm + (cold - warm) * coolK);
    mg.fillStyle = 'rgb(' + mixc(LIGHT.ambR, COLD_AMB[0]) + ',' + mixc(LIGHT.ambG, COLD_AMB[1]) + ',' + mixc(LIGHT.ambB, COLD_AMB[2]) + ')';
    for (const r of G.allRects) {
      const u = upReach(r);
      const RW = (r.x2 - r.x1 + 1) * T, RH = (r.y2 - r.y1 + 1) * T;
      // footprint + pad matches the opaque hull plate; the wall-height strip above spans the
      // footprint width only (the wall face paints per-tile, exactly X..X+T)
      mg.fillRect(r.x1 * T - pad, r.y1 * T - pad, RW + pad * 2, RH + pad * 2);
      if (u > pad) mg.fillRect(r.x1 * T, r.y1 * T - u, RW, u);
    }
    for (const [ccx, ccy, kind] of G.chamfers) { const A = CORNER[kind]; eraseSpandrel(mg, kind, (ccx + A.cx) * T, (ccy + A.cy) * T, T + pad); }
    /* ...and above a TOP corner the raised strip has to follow the wall's EASED top instead of
       staying square. eraseSpandrel above only cuts the corner out of the FOOTPRINT plate; the
       wall-height strip kept its square corner while the ring it stands for eases down around the
       chamfer, so ambient mask was left lying over bare space — a shadow hanging outside the hull,
       invisible against pure black but plain against the SpaceBG starfield. Same law as the
       straight wall top: the mask must never cover pixels the art doesn't paint.
       THE REACH IS READ BACK FROM THE PAINTER (`crownReach`), never recomputed. A mask edge
       derived a second time to match the art is exactly what drifted before, and it drifts again
       the moment the corner's shape changes — as it just did. Erase only ABOVE the art: the crown
       itself belongs under the ambient like the rest of the interior. */
    if (WALL.up > 0) {
      const upC = Math.round(WALL.up);
      mg.save();
      mg.globalCompositeOperation = 'destination-out';
      mg.fillStyle = '#000';
      for (const [ccx, ccy, kind] of G.chamfers) {
        if (kind !== 'tl' && kind !== 'tr') continue;
        const stripTop = ccy * T - (upC + capH + 2), X0 = ccx * T;
        const rm = crownReach.get(ccx + ',' + ccy);
        for (let ix = X0; ix < X0 + T; ix++) {
          const reach = rm && rm.get(ix);
          const artTop = reach === undefined || reach === null ? ccy * T : reach;   // no ring here → the footprint plate is the top
          if (artTop > stripTop) mg.fillRect(ix, stripTop, 1, artTop - stripTop);
        }
      }
      mg.restore();
      /* ...and the other half of the same law: the corner ring reaches a full `pad` FURTHER OUT
         than the straight north wall's strip does (the strip spans the footprint width only), so
         those columns had lit crown standing OUTSIDE the ambient plate — which renders at its raw
         baked tone against the starfield, the blazing-line failure the WALL.sideCap note describes.
         Add mask over exactly what the painter recorded, so cover and art are the same shape. */
      for (const [ccx, ccy, kind] of G.chamfers) {
        if (kind !== 'tl' && kind !== 'tr') continue;
        const X0 = kind === 'tl' ? ccx * T - pad : ccx * T, X1 = X0 + T + pad, bottom = ccy * T + T;
        const rm = crownReach.get(ccx + ',' + ccy);
        if (!rm) continue;
        for (let ix = X0; ix < X1; ix++) {
          const reach = rm.get(ix);
          if (reach === undefined || reach >= bottom) continue;
          mg.fillRect(ix, reach, 1, bottom - reach);
        }
      }
    }
    L.globalAlpha = LIGHT.ambient;
    L.drawImage(mask, VX, VY);
    L.globalAlpha = 1;
    L.globalCompositeOperation = 'destination-out';
    const cut = (x, y, r, a) => {
      const g = L.createRadialGradient(x, y, 1, x, y, r);
      falloffStops(g, '0,0,0', a);
      L.fillStyle = g; L.fillRect(x - r, y - r, r * 2, r * 2);
    };
    // One opaque union, composited once: overlapping rectangles in an expanded/L-shaped
    // room must not stack brightness. Include the raised north wall in the same fill so
    // there is no horizontal lighting cutoff where wall meets floor. The receiver mask
    // below still confines all light to actual interior surfaces, including chamfers.
    const roomCoverage = canvas(CW, CH), R = translatedContext(roomCoverage);
    R.fillStyle = '#000';
    for (const r of G.allRects) {
      if (G.isCorridor(r.z)) continue;
      R.fillRect(r.x1 * T, r.y1 * T - WALL.up - WALL.capH,
        (r.x2 - r.x1 + 1) * T, (r.y2 - r.y1 + 1) * T + WALL.up + WALL.capH);
    }
    L.globalAlpha = Math.max(0, Math.min(1, LIGHT.room));
    L.drawImage(roomCoverage, VX, VY); L.globalAlpha = 1;
    for (const r of G.allRects) {
      const X = r.x1 * T, Y = r.y1 * T, RW = (r.x2 - r.x1 + 1) * T, RH = (r.y2 - r.y1 + 1) * T;
      /* ONE CUT PER LAMP, ALONG THE LONG AXIS — for corridors too. A corridor used to take a single
         radial cut spanning its ENTIRE run, which is a uniform wash by construction: the longer the
         hallway, the flatter it got. A room's rhythm comes from several overlapping pools, and that
         rhythm is most of why its floor reads as lit. Same formula either way, resolved on the
         space's own long/cross axes rather than assuming width-is-long — a vertical corridor is the
         case that assumption gets wrong, and it is the commonest shape on a real station.
         `LIGHT.corridor` controls passage fill independently of the room's local fixtures. */
      const cor = G.isCorridor(r.z);
      if (!cor) continue;
      const vert = RH > RW;
      const along = vert ? RH : RW, cross = vert ? RW : RH;
      const n = Math.max(1, Math.round(along / (cross * 1.4)));
      const rad = Math.max(cross * 0.78, along / n * 0.62);
      const lift = cor ? LIGHT.corridor : LIGHT.room;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        // rooms keep their established 0.42-down-the-height placement; a corridor is lit from its
        // centre line, because a passage has no far wall to throw the pool against.
        if (vert) cut(X + RW * (cor ? 0.5 : 0.42), Y + RH * t, rad, lift);
        else cut(X + RW * t, Y + RH * (cor ? 0.5 : 0.42), rad, lift);
      }
    }
    /* THE CROWN CUT — a flat, hard-edged pull on the ambient over every rect the crown painted, so
       the wall's lit top surface always reads ABOVE the hull skirt outside it (the skirt hangs in
       void, deliberately outside the ambient plate, so it renders at a flat luma 58 and used to
       out-shine a 38 crown at the dark end of a room). MULTIPLICATIVE by construction — it is one
       more destination-out on the same layer — so the crown still falls off away from the lamps
       exactly like every other surface; it just never falls under the shell. Hard-edged, not a
       gradient: it stands for a surface, not a light source. */
    if (LIGHT.crown > 0.001) {
      L.fillStyle = 'rgba(0,0,0,' + Math.min(1, LIGHT.crown).toFixed(3) + ')';
      for (const [x, y, w, h] of crownRects) L.fillRect(x, y, w, h);
    }
    for (const l of lampPos) cut(l.x, l.y, l.r, LIGHT.pool * (l.gain == null ? 1 : l.gain));
    // doorway light spill so corridors and rooms read as connected — DOORWAYS only (see pairIsSill)
    for (const [x1, y1, x2, y2] of G.doorDefs) {
      if (!pairIsSill(x1, y1, x2, y2)) continue;
      cut((x1 + x2 + 1) / 2 * T, (y1 + y2 + 1) / 2 * T, T * 1.6, LIGHT.door);
    }
    /* ...then the two passes that put light ON things rather than taking darkness away. Both run
       BEFORE the glass clear below, so neither can lay film over a pane and dull the real sky.
       ANY FILM MUST CLIP TO THE SAME SHAPE THE AMBIENT PLATE COVERS: a lamp sits under a room's
       top edge and its dab reaches r in every direction, so an unclipped pass hangs a haze in the
       starfield above every room. The plate MASK is that shape by construction — the films are
       painted on a scratch layer and keyed through it (destination-in), so cover and art can never
       drift apart. */
    {
      const w = Math.max(0, LIGHT.warm), sp = Math.max(0, LIGHT.spill);
      if ((w > 0.001 && lampPos.length) || (sp > 0.001 && viewportRects.length)) {
        const film = canvas(CW, CH);
        const F = translatedContext(film);
        /* THE WARM FILM — what the cuts cannot do. `destination-out` only REMOVES darkness: at a
           pool's centre the light layer goes fully transparent and the scene below shows through at
           its raw baked tone. Nothing in the station ever had light PUT on it — an agent standing
           directly under a fixture rendered exactly as an agent standing in a doorway, only less
           dim. TIGHTER THAN THE CUT (0.6×) ON PURPOSE: at the cut's full radius neighbouring
           fixtures' films overlap across the whole deck and the pass stops being pools and becomes
           a haze that lifts the entire room. Darkness may reach far and stay believable; a
           highlight may not. */
        if (w > 0.001) for (const l of lampPos) {
          const r = l.r * 0.6;
          const g = F.createRadialGradient(l.x, l.y, 1, l.x, l.y, r);
          falloffStops(g, l.rgb || LAMP_RGB, w * (l.gain == null ? 1 : ROOM_COLOUR_GAIN));
          F.fillStyle = g; F.fillRect(l.x - r, l.y - r, r * 2, r * 2);
        }
        /* VIEWPORT SPILL — the sky is a light source. A pane cut through the north wall opens onto
           real (moving) starlight, and that light used to stop dead at the glass: the pane read at
           full brightness and the deck 4px below it sat at the room's ambient, which is the read
           of a PAINTING of space, not a window onto it. South of the pane only (north is hull):
           the ambient gives way, and what lands there is COLD. That colour against the tungsten
           pools is most of why the station reads as lit rather than dimmed. */
        if (sp > 0.001) for (const v of viewportRects) {
          const cx = v.x + v.w / 2, cy = v.y + v.h, r = Math.max(T * 2.2, v.w * 3.4);
          const g1 = L.createRadialGradient(cx, cy, 1, cx, cy, r);
          falloffStops(g1, '0,0,0', sp * 0.5);
          L.fillStyle = g1; L.fillRect(cx - r, cy, r * 2, r);   // still destination-out here: the room side of the glass loses darkness
          const g2 = F.createRadialGradient(cx, cy, 1, cx, cy, r);
          falloffStops(g2, STAR_RGB, sp * 0.13);
          F.fillStyle = g2; F.fillRect(cx - r, cy, r * 2, r);
        }
        F.globalCompositeOperation = 'destination-in';
        F.drawImage(mask, VX, VY);
        L.globalCompositeOperation = 'source-over';
        L.drawImage(film, VX, VY);
        L.globalCompositeOperation = 'destination-out';
      }
    }
    // Preserve the original lighting exactly on interior pixels. Outside them,
    // retain only the fixed ambient exposure: lamps cannot brighten the shell.
    const interiorCv = interiorReceiver();
    const exterior = canvas(CW, CH), E = exterior.getContext('2d');
    E.globalAlpha = LIGHT.ambient; E.drawImage(mask, 0, 0); E.globalAlpha = 1;
    E.globalCompositeOperation = 'destination-out'; E.drawImage(interiorCv, 0, 0);
    L.globalCompositeOperation = 'destination-in'; L.drawImage(interiorCv, VX, VY);
    L.globalCompositeOperation = 'source-over'; L.drawImage(exterior, VX, VY);

    // VIEWPORT GLASS — clear the ambient mask fully over every window the wall pass cut, so the
    // live starfield behind the hole reads at its own brightness instead of the interior's 23%.
    // A hard-edged fill, not a gradient: the frame around it is a hard pixel edge too.
    L.globalCompositeOperation = 'destination-out';
    L.fillStyle = 'rgba(0,0,0,1)';
    for (const v of viewportRects) L.fillRect(v.x, v.y, v.w, v.h);
    L.globalCompositeOperation = 'source-over';
    ditherLight(L, lightCv.width, lightCv.height);
    const flickers = [];
    for (let i = 0; i < lampPos.length; i += 2) flickers.push(lampPos[i]);
    return { lightCv, interiorCv, flickers, lamps: lampPos.slice() };   // lamps = all virtual light samples; no ceiling hardware is rendered
  }

  function buildBase() {
    const baseCv = canvas(CW, CH);
    const b = translatedContext(baseCv);

    /* THE EXTERIOR SHELL, PER FOOTPRINT (2026-08-05). Every pass below used to run once for the whole
       station off a single constant; each is now driven by the owning room's HULL_RECIPES entry.
       THE PASS ORDER IS UNCHANGED AND MUST STAY THAT WAY — plates, then the corner erase, then
       corridor plates, then dressing, then rims — because the erase is what rounds the corners and
       anything painted after it has to be source-atop to respect them. */
    const plateRect = r => [r.x1 * T - pad, r.y1 * T - pad, (r.x2 - r.x1 + 1) * T + pad * 2, (r.y2 - r.y1 + 1) * T + pad * 2];
    const plate = r => { const [x, y, w, h] = plateRect(r); b.fillStyle = hullPal(r.z).base; b.fillRect(x, y, w, h); };

    // hull plate behind ROOMS first (notches between distant rooms show stars)
    for (const r of G.allRects) if (!G.isCorridor(r.z)) plate(r);

    /* CORNERS PAINT IN DEPTH ORDER, NOT CREATION ORDER (2026-08-11, Andrew circling two wall
       junctions: "the overlap of walls is terrible now"). G.chamfers comes back in doc.order, so
       when two rooms' corners contend for the same pixels — which happens at every alley between
       near-adjacent footprints — the OLDER room's arc, rim and coursing painted over the newer
       one's regardless of which wall is nearer the camera. Same law the props follow: the surface
       further down-screen is nearer and paints later. Sorted by the corner point's row, so a
       southern room's corner correctly overlaps the northern neighbour it stands in front of. */
    const chamfersByDepth = [...G.chamfers].sort((a, b) => ((a[1] + CORNER[a[2]].cy) - (b[1] + CORNER[b[2]].cy)) || (a[0] - b[0]));

    // chamfer hull spandrel erase + curved rim — BEFORE corridor connectors, so a corridor kissing a
    // room's rounded corner keeps its hull (v7 render.js ordering: corridors drawn after the erase)
    for (const [ccx, ccy, kind] of chamfersByDepth) {
      const A = CORNER[kind], ax = (ccx + A.cx) * T, ay = (ccy + A.cy) * T;
      eraseSpandrel(b, kind, ax, ay, HR);
      /* THE RIM HAS TO FOLLOW THE SAME PROFILE THE ERASE CUT (2026-08-08). This was the file's
         last surviving stroked `arc()`, and it survived precisely because a circle looks the same
         from both sides — the erase and the stroke agreed by coincidence, not by construction. The
         moment SHAPE.cornerN could bend the profile they stopped agreeing, and the first render of
         the chamfer came back looking IDENTICAL to the fillet: the cut had changed, but the bright
         2px rim drawn over it — which IS the silhouette to the eye — was still a quarter circle.
         Rastered now as a CONNECTED CONTOUR off the one shared walk: a 2px mark at each row's
         crossing, plus the horizontal run back to the previous row's crossing so the shallow part
         of the curve cannot break into dashes. Same rule the hull's courseLine walk states — there
         is no width below which a course should vanish, it just has to be CONNECTED — and it drops
         the last anti-aliased edge on a silhouette every other layer rasters to hard pixels.
         The tone belongs to the room the corner was cut from, same as the interior chamfer pass, or
         a clad room reverts to shell-grey at its corners. */
      b.fillStyle = hullPal(G.zoneGrid[G.idx(ccx, ccy)]).arc;
      let prevX = null;
      eachCornerRow(kind, ax, ay, HR - 2, (py, ex) => {
        if (ex == null) { prevX = null; return; }
        const x = A.cx ? ex : ex - 1;                       // 2px band lying just inside the cut
        b.fillRect(x, py, 2, 2);
        if (prevX != null && Math.abs(x - prevX) > 1) {
          const lo = Math.min(x, prevX), hi = Math.max(x, prevX);
          b.fillRect(lo, py, hi - lo + 2, 2);
        }
        prevX = x;
      });
    }

    // hull plate behind CORRIDORS (connectors stay intact through the corner erase)
    for (const r of G.allRects) if (G.isCorridor(r.z)) plate(r);

    /* the material's own texture over each footprint's plate. SOURCE-ATOP *and* clipped: atop keeps a
       mark off the spandrels the corner pass just erased (paint them and every rounded corner grows a
       square shoulder back), and the clip keeps one room's texture out of a neighbour's plate where
       their pads overlap. Recipes phase-lock their marks to absolute coords, so two adjacent rooms
       wearing the same skin still read as one continuous wall. */
    b.globalCompositeOperation = 'source-atop';
    for (const r of G.allRects) {
      const recipe = HULL_RECIPES[hullMatOf(r.z)] || hullStation;
      if (!recipe.dress) continue;
      const [x, y, w, h] = plateRect(r);
      b.save(); b.beginPath(); b.rect(x, y, w, h); b.clip();
      recipe.dress(b, hullPal(r.z), x, y, w, h);
      b.restore();
    }
    b.globalCompositeOperation = 'source-over';

    // riveted rim + bolts PER footprint — each room/corridor frames itself, so the void between
    // distant (or mid-build, not-yet-connected) rooms stays open instead of one rim crossing space.
    // SOURCE-ATOP like the dressing above: the rim is a rectangle, but the hull it frames has had
    // its rounded corners erased by the chamfer pass. Painting it unclipped left the rim's square
    // corner (and its bolts) hanging in empty space beside every rounded corner — the little
    // detached "ladder" fragments. Clipping to existing hull pixels is the whole fix.
    b.globalCompositeOperation = 'source-atop';
    b.lineWidth = 2;
    for (const r of G.allRects) {
      const [x, y, w, h] = plateRect(r);
      const recipe = HULL_RECIPES[hullMatOf(r.z)] || hullStation;
      (recipe.rim || hullStation.rim)(b, hullPal(r.z), x, y, x + w, y + h);
    }
    b.globalCompositeOperation = 'source-over';

    // floors
    for (const r of G.allRects) (G.isCorridor(r.z) ? bakeCorridorFloor : bakeDeck)(b, r);
    bakeEdgeAO(b);
    bakeCorridorDressing(b);
    bakeWalls(b);
    bakeCorridorMouths(b);

    /* The chamfer pass runs BEFORE bakeRoomLighting (2026-07-25). It used to run after, which made
       a rounded corner the only surface in the room the ceiling lights never touched — the corner
       read as a dark blob beside a lit wall, and no amount of geometric alignment fixes that,
       because the mismatch is tonal. Lighting the corner with everything else is what actually
       makes it connect. */
    // chamfer floor-cut + curved interior wall pass — depth order, same as the rim pass above
    for (const [ccx, ccy, kind] of chamfersByDepth) {
      const X = ccx * T, Y = ccy * T, A = CORNER[kind], ax = X + A.cx * T, ay = Y + A.cy * T;
      // a rounded corner belongs to the room it was cut from — take that room's wall palette so a
      // coloured room's corner arc doesn't revert to the old universal brown-grey.
      const cPal = wallPal(G.zoneGrid[G.idx(ccx, ccy)]);
      // ...and the SHELL it is cut out of, for the rows this pass has to fill back with hull
      const cHull = hullPal(G.zoneGrid[G.idx(ccx, ccy)]).base;
      /* ONE INTEGER CURVE, SHARED BY EVERY LAYER (2026-07-24). This corner used to be six
         anti-aliased arc() strokes at six different radii (T+2.25, T-2.5, T-5.5, HR-2, T-5..T)
         plus a clip()+fill at radius T for the deck cut — so the deck ended on one curve, the wall
         face sat on another and the crown on a third, and every one of them was AA'd against the
         deck's hard 1px pixels. That is the ragged, unaligned corner.
         Now: a single radius Rc is rasterized into exact per-ROW integer spans. A quarter circle
         crosses each pixel row exactly once, so the spans are complete and gap-free, and the deck
         cut, the wall face band and the outer dark band are all cut from that same edge — the deck
         stops exactly where the wall starts. The face band TAPERS from the side wall's thickness at
         the side end of the arc to the north wall's NFACE at the north end, so the corner flows
         into whichever straight wall it meets instead of stepping. */
      const Rc = T;                                  // THE chamfer radius — every layer uses this one
      const sgnX = A.cx ? -1 : 1, sgnY = A.cy ? -1 : 1;
      /* A NEARER WALL OWNS THE VOID IT STANDS IN — the same law bakeCornerCrown's `put` follows, and
         the corner ART needs it too. A room's tall north face rises `up + capH + 2` = 28px, MORE than
         the 24px a two-tile alley gives it, so it reaches up into the tile of the room behind. When
         that tile is a chamfer, this pass painted its deck cut, face band and foot straight over the
         nearer wall's crown — a dark diagonal bite out of the one bright line that says the wall has
         height. Measured: dropping the chamfer restored the crown ladder exactly. South is nearer, so
         south keeps those rows. `clamp` routes through here, so this covers the whole pass. */
      const fill = (x, y, w, h, c) => {
        if (w <= 0 || h <= 0) return;
        for (let cx0 = x; cx0 < x + w; ) {
          const lim = nearerNorthTop(Math.floor(cx0 / T), ccy);
          let cx1 = cx0 + 1;
          while (cx1 < x + w && nearerNorthTop(Math.floor(cx1 / T), ccy) === lim) cx1++;
          const yEnd = Math.min(y + h, lim);
          if (yEnd > y) { b.fillStyle = c; b.fillRect(cx0, y, cx1 - cx0, yEnd - y); }
          cx0 = cx1;
        }
      };
      const outerBand = U.shade(cPal.base, -0.62);   // the same contact-seam tone the straight walls use
      /* THE CORNER CARRIES THE MATERIAL ROUND THE CURVE (2026-08-05, Andrew on a zoomed room corner:
         "notice how it cuts off ... we fixed this for the outer shell now lets do it for the walls").
         The face band here was ONE FLAT `cPal.face` fill. That matched while the straight faces were
         flat too — but the moment they became a graded band carrying the material's rhythm, a flat
         patch at the corner is a seam you cannot unsee, which is exactly the defect this pass had
         been quietly free of before. Same lesson the hull's courseLine taught one layer out: a
         texture has to FOLLOW the curve, and the corner is where the eye checks.
         `cEd` is the corner room's own edge recipe; `arcS` is arc length accumulated ALONG the curve
         by the row walk (ds = hypot(1, Δedge)), so the rhythm keeps a constant spacing round the
         bend instead of stretching with the rows. It is seeded from the first row's world Y, which
         is what phase-locks it to the side wall it leaves — the far end meets the north wall on a cut,
         which is what real coursing does at a corner and what the hull does too. */
      const cEd = WALL_EDGES[wallMatOf(G.zoneGrid[G.idx(ccx, ccy)])] || WALL_EDGES.bulkhead;
      let arcS = null, arcPrev = 0;
      /* A CORNER MEETS THE WALL THAT IS ACTUALLY DRAWN (2026-08-10). `vFace` is how deep the face
         band is at the n/s end of the arc, and on a BOTTOM corner it was hardcoded to FACEW — the
         south wall's nominal thickness. But the south wall has no visible inner face (see the note
         in bakeWalls), so on a straight south tile those rows are DECK. The corner painted them
         solid wall tone, which is the dark block Andrew circled: "there is areas where the literal
         wall is creeping through the interior." It reads as a chunk of wall sitting a tile inside
         the room because that is exactly what it is.
         Taking the south wall's REAL drawn depth (`FACEW * southFoot`, 0 by default) makes the
         inner ellipse reach the tile's own bottom edge, so the face tapers to nothing at the south
         end and the deck runs to the same row it does on the tile next door. At southFoot 1 the
         old geometry comes back unchanged. Same law as the straight walls: one wall, one
         convention — a corner may not assert a surface its own straight run does not have. */
      const sFoot = Math.max(0, Math.min(1, DEPTH.southFoot));
      const vFace = sgnY < 0 ? NFACE : Math.round(FACEW * sFoot);
      // how much of the corner's foot dressing survives at a given point along the arc: full where
      // it leaves the side wall, tapering to the south wall's own (absent) foot at the other end.
      const footAt = ady => sgnY < 0 ? 1 : Math.max(0, Math.min(1, sFoot + (1 - sFoot) * (1 - ady / Rc)));
      const aIn = Math.max(1, Rc - FACEW), bIn = Math.max(1, Rc - vFace);
      eachCornerRow(kind, ax, ay, Rc, (py, edge) => {
        const ady = Math.abs(py + 0.5 - ay);
        if (edge == null) { fill(X, py, T, 1, cHull); return; }       // row lies wholly outside the curve
        /* THE INNER BOUNDARY IS AN ELLIPSE, NOT A CIRCLE — this is the whole reason corners never
           quite met their walls. The deck's edge at a rounded corner has to land on TWO straight
           walls: x = Xroom + FACEW on the side wall (4px) and y = Yroom + NFACE on the north wall
           (9px). At T=12 those sit 8 and 3 from the corner's centre, so NO single radius can touch
           both — a concentric circle, however finely rasterized, is guaranteed to miss one of them,
           and it was missing the north wall by 2px (Andrew drew the line: 2026-07-25).
           Semi-axes Rc-FACEW and Rc-<the n/s wall's own depth> make it meet both dead on, and the
           face thickness then tapers from the side wall's to the north wall's entirely on its own —
           no hand-tuned taper term, which is what the old `faceW` guess was. */
        /* Rows the ellipse doesn't reach carry no inner boundary at all: the face runs to the tile
           edge and there is NO contact seam. Forcing the inner x to the centre instead put it exactly
           on the tile boundary and painted the seam tone there every such row — a dark 1px stripe
           down the handoff column, drawn OVER the straight wall's face. Everything is clamped to the
           chamfer's own tile now, so no layer can reach into its neighbour. */
        /* the inner boundary takes SHAPE.cornerN too, or the face band would be the difference
           between a chamfered outer edge and a still-elliptical inner one — a wall that fattens
           through the middle of the cut. Same n === 2 verbatim-sqrt rule as eachCornerRow. */
        const ty = ady / bIn;
        const hasInner = ty < 1;
        const cn = Math.max(0.35, +SHAPE.cornerN || 2);
        const dxIn = !hasInner ? 0
                   : cn === 2 ? aIn * Math.sqrt(1 - ty * ty)
                              : aIn * Math.pow(1 - Math.pow(ty, cn), 1 / cn);
        const inner = hasInner ? (sgnX < 0 ? Math.round(ax - dxIn) : Math.round(ax + dxIn))
                               : (sgnX < 0 ? X + T : X);
        const clamp = (x0, x1, c) => fill(Math.max(X, x0), py, Math.min(X + T, x1) - Math.max(X, x0), 1, c);
        if (sgnX < 0) clamp(X, edge, cHull); else clamp(edge + 1, X + T, cHull);      // 1. cut the deck
        if (sgnX < 0) clamp(edge - 3, edge, outerBand); else clamp(edge + 1, edge + 4, outerBand);
        /* 2. the face: BODY, then a shadowed foot where it meets the deck. Deliberately NO lit top
           course in here — the straight wall's lit course sits 14px higher, up in the crown, so its
           in-tile face is body+foot too. Painting a course at the tile's outer edge instead put a
           lum-65 band against a lum-32 wall (the ellipse's b semi-axis is only 3px, so most rows
           never reach it and fell into the "outer sliver" case, which lit the WHOLE run). The lit
           top belongs to the crown raster on the tall side and to the crest band on the side wall. */
        const lo = Math.min(edge, inner), hi = Math.max(edge, inner);
        /* the band, graded across its DEPTH exactly as bakeSideFace grades a straight one: depth 0
           sits at `edge` (the outer/crown side) and grows toward the deck contact, whichever way the
           corner faces. Identical ramp constants, so the corner and the straight it joins are the
           same surface at the join row. */
        if (arcS === null) { arcS = py; arcPrev = edge; }
        else { arcS += Math.hypot(1, edge - arcPrev); arcPrev = edge; }
        const cBase = cEd.glass ? U.shade(cPal.base, -0.55) : cPal.face;
        const bw = hi + 1 - lo;
        const onMark = cEd.pitch > 0 && ((Math.round(arcS) % cEd.pitch) + cEd.pitch) % cEd.pitch === 0;
        for (let ix = lo; ix <= hi; ix++) {
          const d = sgnX < 0 ? ix - lo : hi - ix;
          const t = bw <= 1 ? 0 : d / (bw - 1);
          let c = U.shade(cBase, 0.12 - 0.38 * t);
          for (const [rd, lift] of (cEd.runs || [])) if (rd === d) c = U.shade(cBase, lift);   // runs bend round too
          if (onMark) c = U.shade(cBase, cEd.joint);
          else if (cEd.speck && h2(ix, py, 'wedge') % 3 === 0) c = U.shade(cBase, 0.18);
          clamp(ix, ix + 1, c);
        }
        if (hasInner) {
          // the foot mirrors wallFoot's depth AND grading exactly (4px / 2px / 1px, -0.24 / -0.40 /
          // -0.58). A 2px flat foot against the straight wall's graded 4px one left the corner ~9
          // luminance brighter than the wall it joins, which reads as a mismatch even once the
          // geometry lines up.
          const ff = footAt(ady);
          for (const [d0, k] of [[4, -0.24], [2, -0.40], [1, -0.58]]) {
            const d = Math.round(d0 * ff);
            if (d <= 0) continue;
            if (sgnX < 0) clamp(Math.max(lo, inner - d), inner, U.shade(cPal.face, k));
            else clamp(inner + 1, Math.min(hi + 1, inner + 1 + d), U.shade(cPal.face, k));
          }
          clamp(inner, inner + 1, outerBand);                                        // contact seam onto the deck
        }
      });
      /* The inner boundary is nearly HORIZONTAL where it meets the north/south wall and nearly
         VERTICAL where it meets the side wall. A per-ROW walk lays exactly one seam pixel per row,
         which is right on the steep stretch but leaves the shallow one sparse — so against the
         straight wall the deck appeared to start a row early and the contact line broke up. Walk the
         COLUMNS as well and lay the seam at the ellipse's y: the contact line is then continuous the
         whole way round and terminates on both straight walls' own seams. Same row/column duality
         the crown needed. */
      for (let ix = X; ix < X + T; ix++) {
        const adx = Math.abs(ix + 0.5 - ax);
        if (adx >= aIn) continue;
        const dy = bIn * Math.sqrt(1 - (adx / aIn) * (adx / aIn));
        const py = sgnY < 0 ? Math.round(ay - dy) : Math.round(ay + dy);
        if (py < Y || py >= Y + T) continue;
        // same graded foot as the row pass, so the shallow stretch is shaded like the steep one —
        // and tapering the same way, or the column walk would put back the wall block the row walk
        // just stopped drawing (this is the SHALLOW stretch, i.e. the south end, so it carries most
        // of it).
        const ff = footAt(Math.abs(py + 0.5 - ay));
        if (ff > 0.001) {
          for (const [d0, k] of [[4, -0.24], [2, -0.40], [1, -0.58]]) {
            for (let j = 1; j <= Math.round(d0 * ff); j++) {
              const fy = sgnY < 0 ? py - j : py + j;
              if (fy >= Y && fy < Y + T) fill(ix, fy, 1, 1, U.shade(cPal.face, k));
            }
          }
          fill(ix, py, 1, 1, outerBand);
        }
      }
      const cZone = G.zoneGrid[G.idx(ccx, ccy)];
      const cRoom = !G.isCorridor(cZone);
      const cCy = cornerArcCy(kind, ay, Y, HR, cRoom);   // the outline circle's centre — lifted on a top corner
      // HULL RIM — the outer silhouette's own curve (HR), concentric with the interior one and now
      // rasterized off the SAME row walk, so the two curves stay a fixed pixel distance apart all
      // the way round instead of one being a crisp staircase beside a soft anti-aliased stroke.
      // It rides the SAME centre as the ring: left at ay on a lifted corner it would rule a rim
      // straight across the middle of the standing wall face.
      eachCornerRow(kind, ax, cCy, HR, (py, ex) => {
        if (ex == null) return;
        // the rim belongs to the room the corner was cut from — the same rule the straight rim pass
        // follows. It was the literal pre-axis constant, so a clad room reverted to shell-grey here.
        fill(A.cx ? ex : ex - 1, py, 2, 1, hullPal(cZone).rim);
      });

      /* THE CROWN RING carries the wall's lit top surface around the arc, so the bright line that
         defines a wall does not die at the corners — and on a TOP corner the SAME circle, centred
         higher, is also what stands the wall up. One profile, one radius, no ease on the outline. */
      const cCapW = sideCapW();
      let reach = null;
      if (kind === 'tl' || kind === 'tr') crownReach.set(ccx + ',' + ccy, reach = new Map());
      /* the strip is rendered at the SAME face height the straight north wall uses, and anchored two
         tiles back from the corner so the recipe's per-tile hash variation lines up with the wall the
         corner is joining instead of restarting at the arc. */
      const cMat = wallMatOf(cZone);
      const cUp = Math.max(0, Math.round(cRoom ? WALL.up : WALL.corUp));
      const cStrip = faceStrip(cMat, cPal, cUp + (cRoom ? NFACE : 5));
      bakeCornerCrown(b, cPal, cEd, cStrip, kind, X, Y, ax, ay, Rc, HR, cCapW,
                      cornerCapFar(kind, cCapW, Math.max(2, Math.round(WALL.capH))), cCy, reach,
                      hullEdge(cZone));
    }

    bakeRoomLighting(b);   // after the chamfers, so a rounded corner is lit like every other surface
    if (nextSurfaces() && WorldSurface.paintFixtures) wallFixtures = WorldSurface.paintFixtures(b, G,
      { wallUp: WALL.up, corUp: WALL.corUp, viewport: { x: VX, y: VY, w: CW, h: CH } });

    // faint room name plates (the v7 floor-code stencil, generalized)
    b.font = "7px 'VT323','Courier New',monospace"; b.fillStyle = 'rgba(255,255,255,0.07)'; b.textAlign = 'left';
    for (const id of G.ROOM_IDS) {
      const z = G.zones[id]; if (!z) continue;
      const nm = (G.nameOf(id) || '').toUpperCase();
      if (nm) b.fillText(nm, (z.x2 - 2) * T - 4, (z.y2 + 1) * T - 4);
    }

    bakeHullExtrusion(b);
    bakeInterstitialShadow(b);   // after the skirts: it only claims pixels no wall painted
    b.setTransform(1, 0, 0, 1, 0, 0);
    return baseCv;
  }

  /* ---------- public ---------- */
  function setBakeState(geo, viewport) {
    // belt-and-suspenders: never allocate gigabytes for a malformed/oversized imported geometry
    // (the model's MAX_SPAN normally keeps this far below the ceiling).
    if (geo.W * geo.H > 16e6) {
      return false;
    }
    G = geo; T = geo.TILE; HR = T + pad; W = geo.W; H = geo.H;
    wallPalCache = null;   // per-room wall palettes are derived from THIS geometry — never reuse across bakes
    hullPalCache = null;   // ...and so are the per-room exterior shells
    stripCache = null;     // ...and the rendered face strips the curved surfaces sample
    viewportRects = [];    // ...and so are the window holes the wall pass punches
    crownRects = [];       // ...and the crown rects the ambient cut reads back
    cornerFaceRects = [];  // actual curved wall pixels, shared with the light receiver
    doorOcclusion = [];
    crownReach = new Map();   // ...and the corner crown's measured reach, which the mask erase reads back
    VX = viewport ? viewport.x : 0; VY = viewport ? viewport.y : 0;
    CW = viewport ? viewport.w : W; CH = viewport ? viewport.h : H;
    lampPos = []; wallFixtures = []; chamferAt = {}; extN = new Set();
    extNByCol = null;   // ...and the tall-north-face column index the corner ring's depth clip reads
    for (const [cx, cy, k] of geo.chamfers) chamferAt[cx + ',' + cy] = k;
    buildEdges();
    return true;
  }

  function blankBake(geo) {
    const blank = canvas(1, 1);
    return { baseCv: blank, lightCv: blank, doorOccluders: [], W: geo.W, H: geo.H, origin: geo.origin, flickers: [], lamps: [] };
  }

  // Copy the final, already lit wall art once. Transparent glass and the open
  // throat stay transparent; the renderer only depth-sorts these small sprites.
  function buildDoorOccluders(baseCv) {
    return doorOcclusion.filter(d => d.x < VX + CW && d.x + d.w > VX && d.y < VY + CH && d.y + d.h > VY).map(d => {
      const image = canvas(d.w, d.h), b = image.getContext('2d');
      b.beginPath();
      for (const [x, y, w, h] of d.rects) b.rect(x - d.x, y - d.y, w, h);
      b.clip(); b.drawImage(baseCv, VX - d.x, VY - d.y);
      // Glass is translucent decoration, not an opaque barrier. Its tint is
      // already in the base; copying it again would darken the empty station.
      for (const v of viewportRects) b.clearRect(v.x - d.x, v.y - d.y, v.w, v.h);
      return { x: d.x, y: d.y, w: d.w, h: d.h, sortY: d.sortY, image };
    });
  }

  // Build the clip during the bake, so the frame loop never reads surface pixels.
  function interiorLightPath(cv) {
    if (typeof Path2D === 'undefined') return null;
    const pixels=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
    const path=new Path2D();
    let active=new Map();
    for(let y=0;y<=cv.height;y++) {
      const next=new Map();
      if(y<cv.height)for(let x=0;x<cv.width;) {
        if(!pixels[(y*cv.width+x)*4+3]){x++;continue;}
        const start=x;while(x<cv.width&&pixels[(y*cv.width+x)*4+3])x++;
        const key=start+','+x,prior=active.get(key);
        next.set(key,prior||{x:start,y,w:x-start});active.delete(key);
      }
      for(const r of active.values())path.rect(r.x,r.y,r.w,y-r.y);
      active=next;
    }
    return path;
  }

  // Navigation fixtures sit in the flat front armour panels. Keep them well
  // clear of corner bevels, corridor mouths, panel seams and the wall crown.
  // Validate the entire housing since neighbouring rooms can hide a panel.
  function hullNavLights(baseCv, interiorCv) {
    const result = [];
    if (!baseCv.getContext('2d').getImageData) return result;
    const base = baseCv.getContext('2d').getImageData(0,0,CW,CH).data;
    const inside = interiorCv.getContext('2d').getImageData(0,0,CW,CH).data;
    const skirt = Math.max(4,Math.round(WALL.skirt));
    const onShell = (x,y) => {
      for(let yy=y-2;yy<=y+2;yy++)for(let xx=x-2;xx<=x+2;xx++) {
        const px=xx-VX, py=yy-VY;
        if(px<0||py<0||px>=CW||py>=CH)return false;
        const i=(py*CW+px)*4+3;
        if(base[i]<250||inside[i]>0)return false;
        const tx=Math.floor(xx/T),ty=Math.floor(yy/T);
        if(tx>=0&&ty>=0&&tx<G.COLS&&ty<G.ROWS&&G.zoneGrid[G.idx(tx,ty)]!=null)return false;
      }
      return true;
    };
    // Adjacent room rectangles can form one continuous facade; do not double
    // the lamps merely because the builder split that room into two shapes.
    const fronts=[];
    for(const r of G.allRects.filter(r=>!G.isCorridor(r.z)).slice().sort((a,b)=>a.y2-b.y2||a.x1-b.x1)){
      const previous=fronts[fronts.length-1];
      if(previous&&previous.y2===r.y2&&r.x1<=previous.x2+1)previous.x2=Math.max(previous.x2,r.x2);
      else fronts.push({x1:r.x1,x2:r.x2,y2:r.y2});
    }
    for(const r of fronts) {
      if(skirt<24)continue;
      const left=(r.x1+1)*T+8,right=r.x2*T-8;
      if(right-left<10)continue;
      // Centre the housing between the strake's rivet lip and its lower seam.
      const y=(r.y2+1)*T+pad+STRAKE+6;
      const centres=[];
      for(let x=19+Math.ceil((left-19)/28)*28;x<=right;x+=28)if(onShell(x,y))centres.push(x);
      const targets=right-left>=100?[left+(right-left)*0.25,left+(right-left)*0.75]:[(left+right)/2];
      for(let i=0;i<targets.length;i++){
        const x=centres.slice().sort((a,b)=>Math.abs(a-targets[i])-Math.abs(b-targets[i]))
          .find(x=>!result.some(l=>Math.hypot(l.x-x,l.y-y)<36));
        if(x==null)continue;
        result.push({x,y,red:targets.length>1&&i===0,phase:((x*37+y*61)%100+100)%100/100});
      }
    }
    return result;
  }

  function bakeViewport(geo, viewport) {
    if (!setBakeState(geo, viewport)) return blankBake(geo);
    const baseCv = buildBase();
    const { lightCv, interiorCv, flickers, lamps } = buildLightMap();
    const navLights = hullNavLights(baseCv, interiorCv), interiorPath = interiorLightPath(interiorCv);
    const doorOccluders = buildDoorOccluders(baseCv);
    return { baseCv, lightCv, interiorCv, interiorPath, navLights, doorOccluders, W: geo.W, H: geo.H, origin: geo.origin, flickers, lamps, wallFixtures, viewport: viewport || { x: 0, y: 0, w: geo.W, h: geo.H } };
  }

  function bake(geo) {
    return bakeViewport(geo, null);
  }

  const chunkKey = (cx, cy) => cx + ',' + cy;
  function chunkGrid(geo) {
    return {
      cols: Math.max(1, Math.ceil(geo.W / CHUNK_PX)),
      rows: Math.max(1, Math.ceil(geo.H / CHUNK_PX)),
      chunkPx: CHUNK_PX
    };
  }
  function chunkViewport(geo, cx, cy) {
    const x = cx * CHUNK_PX, y = cy * CHUNK_PX;
    return { x, y, w: Math.min(CHUNK_PX, geo.W - x), h: Math.min(CHUNK_PX, geo.H - y) };
  }
  function dirtyRectToLocalPx(geo, r) {
    const t = geo.TILE;
    return {
      x1: Math.max(0, (r.x1 - geo.origin.tx) * t - dirtyPadPx()),
      y1: Math.max(0, (r.y1 - geo.origin.ty) * t - dirtyPadPx()),
      x2: Math.min(geo.W, (r.x2 + 1 - geo.origin.tx) * t + dirtyPadPx()),
      y2: Math.min(geo.H, (r.y2 + 1 - geo.origin.ty) * t + dirtyPadPx())
    };
  }
  function dirtyChunks(geo, dirtyRects) {
    const grid = chunkGrid(geo);
    if (!dirtyRects || !dirtyRects.length) {
      const all = [];
      for (let cy = 0; cy < grid.rows; cy++) for (let cx = 0; cx < grid.cols; cx++) all.push({ cx, cy, key: chunkKey(cx, cy) });
      return all;
    }
    const seen = new Set(), out = [];
    for (const r of dirtyRects) {
      const px = dirtyRectToLocalPx(geo, r);
      const x0 = Math.max(0, Math.floor(px.x1 / CHUNK_PX));
      const y0 = Math.max(0, Math.floor(px.y1 / CHUNK_PX));
      const x1 = Math.min(grid.cols - 1, Math.floor(Math.max(0, px.x2 - 1) / CHUNK_PX));
      const y1 = Math.min(grid.rows - 1, Math.floor(Math.max(0, px.y2 - 1) / CHUNK_PX));
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
        const key = chunkKey(cx, cy);
        if (!seen.has(key)) { seen.add(key); out.push({ cx, cy, key }); }
      }
    }
    return out;
  }
  function rectIntersectsChunk(r, c) {
    if (!r) return true;
    return c.x < r.x + r.w && c.x + c.w > r.x && c.y < r.y + r.h && c.y + c.h > r.y;
  }
  function chunkRefsForRect(geo, rect) {
    const grid = chunkGrid(geo);
    if (!rect) return null;
    const x0 = Math.max(0, Math.floor(rect.x / CHUNK_PX));
    const y0 = Math.max(0, Math.floor(rect.y / CHUNK_PX));
    const x1 = Math.min(grid.cols - 1, Math.floor(Math.max(0, rect.x + rect.w - 1) / CHUNK_PX));
    const y1 = Math.min(grid.rows - 1, Math.floor(Math.max(0, rect.y + rect.h - 1) / CHUNK_PX));
    const out = [];
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) out.push({ cx, cy, key: chunkKey(cx, cy) });
    return out;
  }
  function visibleChunks(baked, rect) {
    if (!baked || !baked.chunked) return [];
    return baked.chunks.filter(c => rectIntersectsChunk(rect, c));
  }
  function expectedChunkKeysForRect(baked, rect) {
    if (!baked || !baked.chunked || !rect) return [];
    const cols = Math.max(1, Math.ceil(baked.W / CHUNK_PX));
    const rows = Math.max(1, Math.ceil(baked.H / CHUNK_PX));
    const x0 = Math.max(0, Math.floor(rect.x / CHUNK_PX));
    const y0 = Math.max(0, Math.floor(rect.y / CHUNK_PX));
    const x1 = Math.min(cols - 1, Math.floor(Math.max(0, rect.x + rect.w - 1) / CHUNK_PX));
    const y1 = Math.min(rows - 1, Math.floor(Math.max(0, rect.y + rect.h - 1) / CHUNK_PX));
    const keys = [];
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) keys.push(chunkKey(cx, cy));
    return keys;
  }
  function missingVisibleChunks(baked, rect) {
    if (!baked || !baked.chunked || !rect) return [];
    return expectedChunkKeysForRect(baked, rect).filter(k => !baked.chunkMap.has(k));
  }
  function sameChunkFrame(prev, geo) {
    return !!(prev && prev.chunked && prev.W === geo.W && prev.H === geo.H && prev.origin &&
      prev.origin.tx === geo.origin.tx && prev.origin.ty === geo.origin.ty && prev.chunkPx === CHUNK_PX);
  }
  function bakeChunk(geo, cx, cy, usedAt) {
    const viewport = chunkViewport(geo, cx, cy);
    const baked = bakeViewport(geo, viewport);
    return { key: chunkKey(cx, cy), cx, cy, x: viewport.x, y: viewport.y, w: viewport.w, h: viewport.h,
      baseCv: baked.baseCv, lightCv: baked.lightCv, interiorCv: baked.interiorCv,
      flickers: baked.flickers, lamps: baked.lamps || [], wallFixtures: baked.wallFixtures || [], usedAt: usedAt || 0 };
  }
  function pruneChunkMap(chunkMap, maxRetainedChunks, requiredKeys) {
    if (!maxRetainedChunks || chunkMap.size <= maxRetainedChunks) return { evicted: 0 };
    const required = requiredKeys || new Set();
    const victims = Array.from(chunkMap.values()).filter(c => !required.has(c.key))
      .sort((a, b) => (a.usedAt || 0) - (b.usedAt || 0));
    let evicted = 0;
    while (chunkMap.size > maxRetainedChunks && victims.length) {
      const c = victims.shift();
      chunkMap.delete(c.key);
      evicted++;
    }
    return { evicted };
  }
  function uniqueFlickers(chunks, field) {
    const seen = new Set(), out = [];
    for (const c of chunks) for (const f of (c[field || 'flickers'] || [])) {
      const key = Math.round(f.x * 1000) + ',' + Math.round(f.y * 1000) + ',' + Math.round(f.r * 1000);
      if (!seen.has(key)) { seen.add(key); out.push(f); }
    }
    return out;
  }
  function bakeIncremental(geo, previous, dirtyRects, opts) {
    opts = opts || {};
    const reuse = sameChunkFrame(previous, geo);
    const generation = reuse ? (previous.generation || 0) + 1 : 1;
    const chunkMap = reuse ? new Map(previous.chunkMap) : new Map();
    const visible = chunkRefsForRect(geo, opts.visibleRect);
    const visibleKeys = new Set((visible || []).map(c => c.key));
    let dirty = (reuse && opts.onlyMissingVisible) ? [] : (reuse ? dirtyChunks(geo, dirtyRects) : dirtyChunks(geo, []));
    if (!reuse && visible) dirty = dirty.filter(d => visibleKeys.has(d.key));
    for (const d of dirty) chunkMap.set(d.key, bakeChunk(geo, d.cx, d.cy, generation));
    const requiredKeys = new Set(dirty.map(d => d.key));
    let visibleBaked = 0;
    for (const v of (visible || [])) {
      requiredKeys.add(v.key);
      const existing = chunkMap.get(v.key);
      if (existing) existing.usedAt = generation;
      else {
        chunkMap.set(v.key, bakeChunk(geo, v.cx, v.cy, generation));
        visibleBaked++;
      }
    }
    const pruned = pruneChunkMap(chunkMap, opts.maxRetainedChunks, requiredKeys);
    const chunks = Array.from(chunkMap.values()).sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
    return {
      chunked: true, chunks, chunkMap, chunkPx: CHUNK_PX, generation,
      W: geo.W, H: geo.H, origin: geo.origin, flickers: uniqueFlickers(chunks), lamps: uniqueFlickers(chunks, 'lamps'),
      wallFixtures: uniqueFlickers(chunks, 'wallFixtures'),
      stats: { chunkCount: chunks.length, rebakedChunks: dirty.length + visibleBaked, reusedChunks: reuse ? Math.max(0, chunks.length - dirty.length - visibleBaked) : 0,
        dirtyChunks: dirty.map(d => d.key), visibleChunks: visible ? Array.from(visibleKeys) : null,
        evictedChunks: pruned.evicted, fullReset: !reuse }
    };
  }

  function drawBase(ctx, baked, ox, oy, visibleRect) {
    if (baked && baked.chunked) for (const c of visibleChunks(baked, visibleRect)) ctx.drawImage(c.baseCv, ox + c.x, oy + c.y);
    else if (baked && baked.baseCv) ctx.drawImage(baked.baseCv, ox, oy);
  }
  function drawLight(ctx, baked, ox, oy, visibleRect) {
    if (baked && baked.chunked) for (const c of visibleChunks(baked, visibleRect)) ctx.drawImage(c.lightCv, ox + c.x, oy + c.y);
    else if (baked && baked.lightCv) ctx.drawImage(baked.lightCv, ox, oy);
  }

  /* MATERIAL SAMPLE — paint a small patch of one deck material into any 2D context using the very
     same per-tile painters the station bake uses. The REFIT palette draws its swatches through
     this, so a preview can never drift from the deck it promises. `T` is per-bake module state,
     so it's saved and restored around the sample (a palette redraw must not disturb a live bake). */
  function sampleMaterial(ctx, matId, base, cols, rows, tile) {
    const mat = MAT_PITCH[matId] ? matId : 'plate';
    const fd = Math.max(0, DEPTH.floorDetail);
    const prevT = T;
    T = tile || 12;
    try {
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++)
        paintDeck(ctx, mat, base, x, y, x * T, y * T, 'sample', h2(x, y, 'sample'), fd);
    } finally { T = prevT; }
  }

  /* WALL SAMPLE — the wall counterpart of sampleMaterial, painting a strip of interior face
     through the real WALL_RECIPES. VIEWPORT is the special case: it clears its glass to
     transparent, so the sample lays a few stars behind first — which is honest, because a real
     viewport shows the real (moving) sky through exactly that hole. `viewportRects` is saved and
     restored so drawing a palette chip can never inject phantom windows into a live bake. */
  function sampleWall(ctx, matId, base, cols, height, tile) {
    const recipe = WALL_RECIPES[matId] || WALL_RECIPES.plating;
    const prevT = T, prevRects = viewportRects;
    T = tile || 12;
    viewportRects = [];
    const h = Math.max(6, height || 24);
    try {
      const pal = { base, face: U.shade(base, WALL_TONE.face), top: U.shade(base, WALL_TONE.top), cap: U.shade(base, WALL_TONE.cap) };
      if (matId === 'viewport') {                       // the sky the glass will reveal
        ctx.fillStyle = '#05060c'; ctx.fillRect(0, 0, cols * T, h);
        for (let i = 0; i < cols * 4; i++) {
          const r = hp(i * 7, 3, 5);
          ctx.fillStyle = (r % 5) ? 'rgba(200,214,255,0.75)' : 'rgba(255,236,200,0.9)';
          ctx.fillRect(r % (cols * T), (r >>> 8) % h, 1, 1);
        }
      }
      for (let i = 0; i < cols; i++) {
        if (!(nextSurfaces() && WorldSurface.paintWallTile(ctx, matId, pal.base, i * T, 0, T, h, i, { detail: DEPTH.wallDetail })))
          recipe(ctx, pal, i * T, 0, h, { x: i, y: 0, z: 'sample' }, h2(i, 0, 'sample'), true, h);
      }
    } finally { T = prevT; viewportRects = prevRects; }
  }

  /* HULL SAMPLE — the exterior counterpart of sampleWall, and the one that has to work hardest,
     because a hull's identity is split across two surfaces that never touch: the plate ring seen
     from above and the skirt seen face-on. A chip showing only the ring would promise the wrong
     material entirely (TIMBER's ring and CLAPBOARD's are near-identical; their skirts are not).
     So the chip paints BOTH, stacked: the dressed plate on top, its rim, then the real band ramp
     below it — the same recipe output the station bakes, never a hand-drawn mock.
     `base` may be null, which is the honest way to ask for the shell's own tone. */
  function sampleHull(ctx, matId, base, cols, height, tile) {
    const recipe = HULL_RECIPES[matId] || hullStation;
    const prevT = T;
    T = tile || 12;
    try {
      const pal = hullPalOf(HULL_RECIPES[matId] ? matId : 'station', base);
      const w = cols * T, h = Math.max(12, height || 30);
      const ringH = Math.max(6, Math.min(12, Math.round(h * 0.38)));
      ctx.fillStyle = pal.base; ctx.fillRect(0, 0, w, ringH);
      if (recipe.dress) recipe.dress(ctx, pal, 0, 0, w, ringH);
      if (recipe.rim) recipe.rim(ctx, pal, 0, 0, w, ringH);
      /* the skirt, resolved from the SAME band list the bake stamps. A band at dy owns the rows
         between its own dy and the next smaller one, so painting them in order — each as a rect
         from the ring down to its dy — reproduces the stack exactly (see the SKIRT BANDS note). */
      const skirtH = h - ringH;
      const bands = fadeBands((recipe.bands || rampBands)(pal, skirtH), skirtH);
      for (const [dy, c] of bands) {
        const d = Math.max(1, Math.min(skirtH, Math.round(dy)));
        ctx.fillStyle = c; ctx.fillRect(0, ringH, w, d);
      }
      // veins belong to the skirt ONLY — in the bake they are source-atop on the skirt canvas and
      // cannot reach the plate. Unclipped here they'd streak the ring with the skirt's rhythm.
      if (recipe.veins) {
        ctx.save(); ctx.beginPath(); ctx.rect(0, ringH, w, skirtH); ctx.clip(); ctx.translate(0, ringH);
        recipe.veins(ctx, pal, w, skirtH, 0, 0);
        ctx.restore();
      }
    } finally { T = prevT; }
  }

  /* THE SEAM LAW, readable without a canvas — the exact classifier every paint pass consults, so a
     test of it cannot drift from what the bake actually does. Returns the 'x,y,side' keys of every
     OPEN JOIN (two decks that simply meet); anything passable and absent from this set is a real
     doorway and keeps its sill, track, guide ticks and light spill. */
  const seamOpenJoins = geo => [...classifyJoins(geo)].sort();

  return { bake, bakeIncremental, dirtyChunks, visibleChunks, missingVisibleChunks, drawBase, drawLight, sampleMaterial, sampleWall, sampleHull, seamOpenJoins, wallFloorShadow, CHUNK_PX, LIGHT, WALL, DEPTH, SHAPE, get HULL_EXPOSURE() { return hullLit(); }, hullRampExposure };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = StationBake;
