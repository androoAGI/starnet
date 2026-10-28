/* bin/lib/camfeed.js — the station camera locked on the agent in COMMS, made of ASCII. A small furnished room drawn from the
   app's own art (the agent's real skin with its walk / sit / type frames; its desk and chair, a lounge couch, a coffee corner,
   a bank of wall screens and a whiteboard, a rack and a console), the camera easing after the agent the way the station's
   camera lock does. Each frame is put on StarNet's palette (lit reds on the wordmark's ramp, the rest on the station's warm
   greys) and turned into ASCII: every 3 × 6 px cell becomes the glyph whose shape matches its bright pixels (bin/lib/ascii-glyphs.js),
   drawn in their colour on black — pure ASCII, no picture under it. Kept dark and fading into the panel's black at its edges,
   so it sits in the CREW panel rather than on it (LOOK).

   What the agent does follows its real state:
     idle        it goes about the room: coffee, the couch, the wall screens, the whiteboard, the rack, the console — a few
                 seconds at each, never the same place twice running
     working     it walks to its desk, sits on its chair and types; its monitor's red light falls on it and the floor round it
     needs you   it sits at its desk, still; the monitor's light turns amber and pulses
     done        it stands by its desk a moment (its light green), then goes back about the room
     stopped     it sits at its desk in the dark
   A thin rim in the state's colour picks the agent out while it works, asks, finishes or stops; idle it has none.
   makeCamFeed() → { setSkin(id, set), hasSkin(id), frame(id, key, now, still, box) → { key, sixel } | null, needs(id) → asset
   paths it still lacks, add(path, png) }. frame() returns null until the agent's sprites are in (the card stays empty
   meanwhile). Pure apart from the per-agent walk it keeps; no I/O (the dashboard fetches the assets and hands them in). */
'use strict';

const png = require('./png.js');
const G = require('./ascii-glyphs.js');
const { encodeSixel } = require('./sixel.js');

// ---- the palette: StarNet's ramps, and a lookup from any colour to its nearest entry --------------------------------
const RAMPS = {
  red: [[40, 2, 8], [70, 4, 14], [118, 8, 22], [170, 14, 32], [215, 24, 44], [255, 46, 62], [255, 104, 116], [255, 176, 184]],
  grey: [[12, 12, 12], [30, 22, 25], [52, 40, 44], [80, 64, 68], [127, 102, 107], [170, 156, 160], [217, 210, 212], [255, 255, 255]],
  amber: [[60, 36, 6], [110, 66, 10], [170, 104, 18], [220, 140, 30], [255, 180, 58], [255, 214, 140]],
  green: [[10, 50, 30], [20, 100, 60], [40, 160, 100], [93, 255, 168], [180, 255, 214]]
};
const ramp = (R, t) => { const x = Math.max(0, Math.min(1, t)) * (R.length - 1), i = Math.floor(x), f = x - i, a = R[i], b = R[Math.min(R.length - 1, i + 1)]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; };
const PALETTE = [];
const fillPalette = () => { PALETTE.length = 0; for (const R of Object.values(RAMPS)) for (let i = 0; i < 24; i++) PALETTE.push(ramp(R, i / 23).map(Math.round)); };
fillPalette();
let LUT = null;   // 32×32×32 → palette index, built once (again after a theme change)
// the accent: what lit screens and the working rim glow in — red unless the terminal's /theme picks another
let ACCENT_RIM = [255, 70, 84], ACCENT_GEN = 0;
function setAccent(rampSteps, rim, trim) {
  RAMPS.red.splice(0, RAMPS.red.length, ...rampSteps.map(c => c.slice()));
  if (rim) ACCENT_RIM = rim.slice();
  if (trim && !USER_LOOK.trim) LOOK.trim = trim.slice();   // the wall's trim line takes the accent too
  fillPalette();
  LUT = null;
  ACCENT_GEN++;
}
function nearest(r, g, b) {
  if (!LUT) {
    LUT = new Uint8Array(32 * 32 * 32);
    for (let i = 0; i < LUT.length; i++) {
      const rr = ((i >> 10) & 31) * 8 + 4, gg = ((i >> 5) & 31) * 8 + 4, bb = (i & 31) * 8 + 4;
      let best = 0, bd = Infinity;
      PALETTE.forEach(([pr, pg, pb], k) => { const d = (rr - pr) ** 2 + (gg - pg) ** 2 + (bb - pb) ** 2; if (d < bd) { bd = d; best = k; } });
      LUT[i] = best;
    }
  }
  return LUT[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
}

/* THE LOOK: dark pure ASCII, so the feed sits IN the panel rather than on it — lit characters on black (no picture under
   them), only real light (screens, LEDs) on the red ramp, everything else in deep warm greys, the agent a little brighter
   than its room, and the whole fading into the panel's own black at its edges. Overridable (STARNET_FEED_LOOK as JSON) for tuning. */
const USER_LOOK = (() => { try { return JSON.parse(process.env.STARNET_FEED_LOOK || '{}') || {}; } catch (_) { return {}; } })();
const LOOK = Object.assign({
  wall: [15, 11, 12], trim: [60, 15, 21], floorLine: [18, 13, 14],
  redStrict: 2.0, redGamma: 1.15, redMax: 0.75,
  greyFloor: 0.04, bgScale: 0.55, bgGamma: 1.05, agentFloor: 0.16, agentScale: 0.9, agentGamma: 0.55,
  under: 0, skip: 0.14, liftBase: 96, liftSpan: 80, liftMax: 1.45,   // under 0: nothing but the lit characters on black
  vigX: 0.2, vigY: 0.24, rimK: 0.6
}, USER_LOOK);

// ---- glyphs ------------------------------------------------------------------------------------------------------
const CW = G.cw, CH = G.ch;
const COV = {};
for (const [c, b64] of Object.entries(G.glyphs)) COV[c] = Uint8Array.from(Buffer.from(b64, 'base64'));
const SHAPES = [...G.shapes].map(c => ({ c, cov: COV[c], mask: Uint8Array.from(COV[c], v => v > 100 ? 1 : 0) }));
const DENSE = G.dense;

// ---- the room (world px at the reference zoom, an image 160 px tall) ----------------------------------------------------
const REF_H = 160, Z0 = 1.5;
const WALL = 60;
const DESK = { x: 300, y: 70 };
const SEAT = { x: 372, y: 198 };
const MONITOR = { x: 382, y: 92, r: 210 };   // the desk monitor: its light falls on everything within r
// [furniture, x, y] (top-left, world px). The couch is a lounge on the left; the screens and whiteboard hang on the back wall
// lit: a light source — its bright pixels glow on StarNet's red, as the station's screens do; the rest are surfaces (greys)
const PROPS = [['screens', 150, -6, 'lit'], ['whiteboard', 480, -14], ['couch', -380, 118], ['coffee', 30, 120], ['crate', -26, 146],
  ['plant', 232, 94], ['rack', 560, 96, 'lit'], ['console', 720, 52, 'lit'], ['boxes', 800, 140]];
// where it goes when idle: where it stands (feet), how it holds itself there, how long
const SPOTS = [
  { name: 'coffee', at: [66, 202], pose: 'standN', dwell: [3500, 6500] },
  { name: 'couch', at: [-200, 214], pose: 'sitS', dwell: [6000, 11000], over: 'couch' },
  { name: 'screens', at: [292, 188], pose: 'standN', dwell: [3000, 5000] },
  { name: 'whiteboard', at: [600, 186], pose: 'standN', dwell: [3500, 6000] },
  { name: 'rack', at: [632, 204], pose: 'standN', dwell: [3000, 5000] },
  { name: 'console', at: [756, 202], pose: 'standN', dwell: [3000, 5500] }
];
const SPEED = 70;   // world px a second
const FURNITURE = ['desk', 'chair'].concat(PROPS.map(q => q[0]));

function rnd(seed) { let s = 9; for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// the frames a skin set needs (the first that exists of each list is used)
const POSES = {
  stand: [['rot_south']],
  standN: [['rot_north', 'rot_south']],
  sitS: [['sit_south_4', 'rot_south']],
  walkE: [1, 2, 3, 4, 5, 6].map(n => ['walk_east_' + n, 'rot_east', 'rot_south']),
  walkW: [1, 2, 3, 4, 5, 6].map(n => ['walk_west_' + n, 'rot_west', 'rot_south']),
  type: [1, 2, 3, 4].map(n => ['type_north_' + n, 'sit_north_4', 'rot_north', 'rot_south'])
};

/* THE LOOK, finished: each cell of the picture becomes the glyph whose shape matches its bright pixels, drawn in their colour
   on black; the edges fade into the panel's black (vig: [x, y] fractions, the feed's own by default; skip: how dark a cell
   stays empty, the feed's own by default); then StarNet's palette
   and Sixel. col: r,g,b per pixel; light: 0..1 per pixel. Shared by the camera feed and the FLOOR (bin/lib/floor.js). */
function asciiSixel(col, light, W, H, vig, skip) {
  // ---- ASCII: under-layer dimmed, the matched glyph over it in its cell's bright colour ----
  const out = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) for (let q = 0; q < 3; q++) out[i * 3 + q] = 12 + (col[i * 3 + q] - 12) * LOOK.under;
  const cols = Math.floor(W / CW), rows = Math.floor(H / CH);
  const mask = new Uint8Array(CW * CH);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let sum = 0;
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) sum += light[(r * CH + y) * W + c * CW + x];
    const mean = sum / (CW * CH);
    if (mean < (skip == null ? LOOK.skip : skip)) continue;
    let bn = 0, dn = 0; const bc = [0, 0, 0], dc = [0, 0, 0];
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
      const i = (r * CH + y) * W + c * CW + x, j = y * CW + x;
      if (light[i] > mean) { mask[j] = 1; bn++; bc[0] += col[i * 3]; bc[1] += col[i * 3 + 1]; bc[2] += col[i * 3 + 2]; }
      else { mask[j] = 0; dn++; dc[0] += col[i * 3]; dc[1] += col[i * 3 + 1]; dc[2] += col[i * 3 + 2]; }
    }
    const bA = bn ? bc.map(v => v / bn) : dc.map(v => v / dn), dA = dn ? dc.map(v => v / dn) : bA;
    let gl;
    if ((Math.max(...bA) - Math.max(...dA)) / 255 < 0.1) gl = COV[DENSE[Math.max(1, Math.min(DENSE.length - 1, Math.round(mean * (DENSE.length - 1))))]];
    else { let bd = Infinity; for (const sh of SHAPES) { let d = 0; for (let j = 0; j < mask.length; j++) if (sh.mask[j] !== mask[j]) d++; if (d < bd) { bd = d; gl = sh.cov; } } }
    const mx = Math.max(bA[0], bA[1], bA[2], 1), lift = Math.min(LOOK.liftMax, Math.max(1, (LOOK.liftBase + LOOK.liftSpan * mean) / mx));
    const gc = bA.map(v => Math.min(255, v * lift));
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
      const a = gl[y * CW + x] / 255; if (!a) continue;
      const i = (r * CH + y) * W + c * CW + x;
      for (let q = 0; q < 3; q++) out[i * 3 + q] = out[i * 3 + q] * (1 - a) + gc[q] * a;
    }
  }
  // the edges fade into the panel's own black: no box, the picture just gets darker toward its border
  const ex = Math.max(1, W * (vig ? vig[0] : LOOK.vigX)), ey = Math.max(1, H * (vig ? vig[1] : LOOK.vigY));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = Math.min(1, Math.min(x + 0.5, W - 0.5 - x) / ex, Math.min(y + 0.5, H - 0.5 - y) / ey);
    v = v * v * (3 - 2 * v);
    if (v >= 1) continue;
    const i = (y * W + x) * 3;
    for (let q = 0; q < 3; q++) out[i + q] = 12 + (out[i + q] - 12) * v;
  }
  const idx = new Int16Array(W * H);
  for (let i = 0; i < W * H; i++) idx[i] = nearest(Math.round(out[i * 3]), Math.round(out[i * 3 + 1]), Math.round(out[i * 3 + 2]));
  return encodeSixel(idx, W, H, PALETTE);
}

function makeCamFeed() {
  const assets = new Map();     // path -> decoded image | null (missing)
  const skins = new Map();      // agent id -> sprite set
  const sims = new Map();       // agent id -> its walk
  const scaled = new Map();     // path@zoom -> { w, h, px }
  const frames = new Map();     // render key -> { key, sixel } (recent)
  let gen = ACCENT_GEN;

  const spritePath = (set, name) => '/assets/sprites/' + set + '/' + name + '.png';
  const furnPath = n => '/assets/furniture/' + n + '.png';
  function setSkin(id, set) { if (set && skins.get(id) !== set) skins.set(id, set); }
  function add(path, buf) { let img = null; if (buf) { try { img = png.decode(buf); } catch (_) { img = null; } } assets.set(path, img); }
  // what this agent's feed still lacks: its pose frames (every fallback, so the first present one is known) and the room
  function needs(id) {
    const set = skins.get(id);
    if (!set) return [];
    const want = FURNITURE.map(furnPath);
    for (const list of Object.values(POSES)) for (const alts of list) for (const n of alts) want.push(spritePath(set, n));
    return [...new Set(want)].filter(p => !assets.has(p));
  }
  function pose(set, kind, i) {
    const alts = POSES[kind][i % POSES[kind].length];
    for (const n of alts) { const a = assets.get(spritePath(set, n)); if (a) return { path: spritePath(set, n), img: a }; }
    return null;
  }
  function scale(path, img, z) {
    const k = path + '@' + z.toFixed(3);
    if (scaled.has(k)) return scaled.get(k);
    const w = Math.max(1, Math.round(img.width * z)), h = Math.max(1, Math.round(img.height * z));
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = (Math.min(img.height - 1, Math.floor(y / z)) * img.width + Math.min(img.width - 1, Math.floor(x / z))) * 4, d = (y * w + x) * 4;
      px[d] = img.data[s]; px[d + 1] = img.data[s + 1]; px[d + 2] = img.data[s + 2]; px[d + 3] = img.data[s + 3];
    }
    const v = { w, h, px };
    if (scaled.size > 400) scaled.clear();
    scaled.set(k, v);
    return v;
  }

  // the walk: where its state puts the agent, a step at a time
  function sim(id, key, now) {
    let s = sims.get(id);
    if (!s) {
      const r = rnd(id), first = Math.floor(r() * SPOTS.length);
      s = { x: SPOTS[first].at[0], y: SPOTS[first].at[1], tx: SPOTS[first].at[0], ty: SPOTS[first].at[1], last: now, rand: r, key, since: now, dir: 1, camX: null, camY: null, spot: first, dwellUntil: now + 2500, arrived: true };
      sims.set(id, s);
    }
    if (s.key !== key) { s.key = key; s.since = now; if (key === 'done') s.spot = null; }
    const dt = Math.min(0.25, Math.max(0, (now - s.last) / 1000));
    s.last = now;
    const atDesk = key === 'working' || key === 'needs' || key === 'stopped';
    if (atDesk) { s.tx = SEAT.x; s.ty = SEAT.y; s.spot = null; }
    else if (s.sat) { s.sat = false; s.tx = s.x - 26; s.ty = s.y + 4; s.spot = null; s.dwellUntil = now + (key === 'done' ? 2600 : 600); s.arrived = false; }   // it stands up first
    else if (s.arrived && now > s.dwellUntil) {
      // the next place: any but the one it is at
      let n = Math.floor(s.rand() * SPOTS.length);
      if (n === s.spot) n = (n + 1 + Math.floor(s.rand() * (SPOTS.length - 1))) % SPOTS.length;
      s.spot = n; s.tx = SPOTS[n].at[0]; s.ty = SPOTS[n].at[1]; s.arrived = false;
    }
    const dx = s.tx - s.x, dy = s.ty - s.y, dist = Math.hypot(dx, dy);
    if (dist > 0.5) { const m = Math.min(dist, SPEED * dt); s.x += dx / dist * m; s.y += dy / dist * m; if (Math.abs(dx) > 0.5) s.dir = dx > 0 ? 1 : -1; }
    s.walking = dist > 1;
    if (!s.walking && !s.arrived && !atDesk) {
      s.arrived = true;
      const sp = s.spot != null ? SPOTS[s.spot] : null;
      if (sp) s.dwellUntil = now + sp.dwell[0] + s.rand() * (sp.dwell[1] - sp.dwell[0]);
    }
    s.sat = atDesk && dist <= 1;
    s.at = !s.walking && !atDesk && s.spot != null ? SPOTS[s.spot] : null;   // where it is spending its time, if anywhere
    // the camera eases after the agent (its chest)
    const cx = s.x, cy = s.y - 60, ease = 1 - Math.exp(-dt / 0.28);
    if (s.camX == null) { s.camX = cx; s.camY = cy; } else { s.camX += (cx - s.camX) * ease; s.camY += (cy - s.camY) * ease; }
    return s;
  }

  /* frame(id, key, now, still, { cellW, cellH, cols, rows }) → { key, sixel } | null */
  function frame(id, key, now, still, box) {
    const set = skins.get(id);
    if (!set || needs(id).length) return null;
    const s = sim(id, key, still ? 0 : now);
    const W = box.cols * box.cellW, H = box.rows * box.cellH;
    const k = H / REF_H, Z = Z0 * k;
    const t = still ? 0 : now;
    // the agent's pose
    let p;
    if (s.sat) p = pose(set, 'type', key === 'working' && !still ? Math.floor(t / 160) : 0);
    else if (s.walking && !still) p = pose(set, s.dir > 0 ? 'walkE' : 'walkW', Math.floor(t / 100));
    else if (s.at) p = pose(set, s.at.pose, 0) || pose(set, 'stand', 0);
    else p = pose(set, 'stand', 0);
    if (!p) return null;
    const rimKey = key === 'working' ? 'w' : key === 'needs' ? (still || Math.floor(t / 450) % 2 === 0 ? 'n' : 'n2') : key === 'stopped' ? 's' : (key === 'done' && t - s.since < 6000) ? 'd' : 'i';
    const camX = Math.round(s.camX * k), camY = Math.round(s.camY * k);
    const ox = Math.round(W / 2 - camX), oy = Math.round(H / 2 - camY);
    const rk = [p.path, Math.round(s.x), Math.round(s.y), camX, camY, rimKey, W, H].join('|');
    if (gen !== ACCENT_GEN) { frames.clear(); gen = ACCENT_GEN; }   // a /theme change redraws every frame
    if (frames.has(rk)) return frames.get(rk);

    // ---- compose the room ----
    const buf = new Uint8Array(W * H * 4);
    const agent = new Uint8Array(W * H);   // what each pixel belongs to: 0 the room, 1 the agent, 2 a light source, 3 a surface
    const fill = (x0, y0, x1, y1, c) => { for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) { const i = (y * W + x) * 4; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255; } };
    fill(0, 0, W, H, [12, 12, 12]);
    const wy = Math.round(WALL * k) + oy;
    fill(0, 0, W, wy, LOOK.wall);
    fill(0, wy, W, wy + Math.max(1, Math.round(2 * k)), LOOK.trim);
    for (let y = wy + Math.round(18 * k); y < H; y += Math.max(6, Math.round(24 * k))) fill(0, y, W, y + 1, LOOK.floorLine);
    const blit = (img, left, top, kind) => {
      for (let y = 0; y < img.h; y++) {
        const yy = top + y; if (yy < 0 || yy >= H) continue;
        for (let x = 0; x < img.w; x++) {
          const xx = left + x; if (xx < 0 || xx >= W) continue;
          const si = (y * img.w + x) * 4; if (img.px[si + 3] < 128) continue;
          const di = (yy * W + xx) * 4; buf[di] = img.px[si]; buf[di + 1] = img.px[si + 1]; buf[di + 2] = img.px[si + 2];
          agent[yy * W + xx] = kind;
        }
      }
    };
    const layers = [];
    const deskImg = scale(furnPath('desk'), assets.get(furnPath('desk')), Z);
    layers.push({ y: DESK.y + deskImg.h / k - 8, draw: () => blit(deskImg, Math.round(DESK.x * k) + ox, Math.round(DESK.y * k) + oy, 3) });
    const chairImg = scale(furnPath('chair'), assets.get(furnPath('chair')), Z);
    layers.push({ y: SEAT.y - 1, draw: () => blit(chairImg, Math.round(SEAT.x * k - chairImg.w / 2) + ox, Math.round(SEAT.y * k - chairImg.h + 8 * k) + oy, 3) });
    for (const [n, x, y, lit] of PROPS) { const im = scale(furnPath(n), assets.get(furnPath(n)), Z); layers.push({ y: y + im.h / k, draw: () => blit(im, Math.round(x * k) + ox, Math.round(y * k) + oy, lit ? 2 : 3) }); }
    const ag = scale(p.path, p.img, Z);
    const onCouch = s.at && s.at.over === 'couch';
    layers.push({ y: onCouch ? 1e6 : s.y, draw: () => blit(ag, Math.round(s.x * k - ag.w / 2) + ox, Math.round(s.y * k - ag.h + 23 * Z) + oy, 1) });
    layers.sort((a, b) => a.y - b.y).forEach(l => l.draw());

    // ---- the desk monitor's light: it falls on the floor, the desk and whoever is near, in its state's colour ----
    const glow = { w: [96, 14, 20], n: [96, 64, 10], n2: [40, 26, 4], s: [0, 0, 0], d: [16, 70, 36], i: [34, 6, 8] }[rimKey];
    const lightAt = new Float32Array(W * H);   // how much of the monitor's light reaches each pixel (0..1)
    if (glow[0] + glow[1] + glow[2] > 0) {
      const mx = Math.round(MONITOR.x * k) + ox, my = Math.round(MONITOR.y * k) + oy, R = MONITOR.r * k;
      for (let y = Math.max(0, Math.floor(my - R)); y < Math.min(H, Math.ceil(my + R)); y++) for (let x = Math.max(0, Math.floor(mx - R)); x < Math.min(W, Math.ceil(mx + R)); x++) {
        const d = Math.hypot(x - mx, (y - my) * 1.4) / R; if (d >= 1) continue;
        lightAt[y * W + x] = (1 - d) * (1 - d);
      }
    }
    // ---- StarNet palette + the agent's rim (none while idle) ----
    const RIM = rimKey === 'i' ? null : ({ w: ACCENT_RIM, n: [255, 180, 58], n2: [150, 96, 20], s: [70, 52, 56], d: [93, 255, 168] }[rimKey]).map(v => v * LOOK.rimK);
    const col = new Float32Array(W * H * 3), light = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const r = buf[i * 4], g = buf[i * 4 + 1], b = buf[i * 4 + 2];
      const x = i % W, y = (i / W) | 0;
      const inA = agent[i] === 1;   // the agent itself
      const rim = RIM && !inA && ((x > 0 && agent[i - 1] === 1) || (x < W - 1 && agent[i + 1] === 1) || (y > 0 && agent[i - W] === 1) || (y < H - 1 && agent[i + W] === 1));
      let c;
      const kind = agent[i], mxc = Math.max(r, g, b), mnc = Math.min(r, g, b), lum = (0.3 * r + 0.59 * g + 0.11 * b) / 255;
      if (rim) c = RIM;
      // a light source's lit pixels (its screens, its LEDs, whatever their colour in the art) glow on the station's red
      else if (kind === 2 && mxc > 110 && mxc - mnc > 50) c = ramp(RAMPS.red, Math.pow(mxc / 255, LOOK.redGamma) * LOOK.redMax);
      // the agent keeps its own reds; everything else — surfaces, the room, the rest of the agent — is the station's greys
      else if (kind === 1 && r > 70 && r > g * LOOK.redStrict && r > b * 1.6) c = ramp(RAMPS.red, Math.pow(mxc / 255, LOOK.redGamma) * LOOK.redMax * 0.9);
      else c = inA ? ramp(RAMPS.grey, LOOK.agentFloor + LOOK.agentScale * Math.pow(lum, LOOK.agentGamma)) : ramp(RAMPS.grey, LOOK.greyFloor + LOOK.bgScale * Math.pow(lum, LOOK.bgGamma));
      // the monitor's light, in its state's colour, on the things it falls on (never the empty floor: a wash there bands)
      const la = kind ? lightAt[i] * 1.6 : 0;
      if (la > 0 && !rim) c = [Math.min(255, c[0] + glow[0] * la), Math.min(255, c[1] + glow[1] * la), Math.min(255, c[2] + glow[2] * la)];
      if (key === 'stopped' && inA) c = c.map(v => v * 0.45);
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      light[i] = Math.max(c[0], c[1], c[2]) / 255;
    }

    const res = { key: rk, sixel: asciiSixel(col, light, W, H) };
    if (frames.size > 48) frames.clear();
    frames.set(rk, res);
    return res;
  }
  // asset / scaledOf: the FLOOR draws from the same store (one fetch of each sprite and piece of furniture)
  return { setSkin, hasSkin: id => skins.has(id), skinOf: id => skins.get(id), add, needs, frame, sim, asset: p => assets.get(p), hasAsset: p => assets.has(p), scaledOf: (p, z) => scale(p, assets.get(p), z) };
}

/* DATA.SKINS from the app's data-shim.js (the station serves it): skin id → sprite set; '' → the default skin's set */
function parseSkins(js) {
  const out = {};
  const block = /DATA\.SKINS\s*=\s*\{([\s\S]*?)\n\};/.exec(String(js || ''));
  if (!block) return out;
  for (const m of block[1].matchAll(/^\s*([A-Za-z0-9_]+)\s*:\s*(\{.*\})\s*,?\s*$/gm)) {
    let v = null;
    try { v = JSON.parse(m[2]); } catch (_) { v = null; }
    if (v && typeof v.set === 'string' && /^[A-Za-z0-9_-]+$/.test(v.set)) out[m[1]] = v.set;
  }
  const def = /DATA\.DEFAULT_SKIN\s*=\s*'([A-Za-z0-9_]+)'/.exec(String(js || ''));
  if (def && out[def[1]]) out[''] = out[def[1]];
  return out;
}
// the set the station draws for an agent: the app's own rule (assets.js setForBody)
function setFor(agentId, skin, skins) {
  if (agentId === 'ULTRON') return skins.ultron || 'ultron';
  return skins[skin] || skins[''] || '';
}

module.exports = { makeCamFeed, parseSkins, setFor, setAccent, PALETTE, POSES, FURNITURE, RAMPS, ramp, LOOK, asciiSixel, accentRim: () => ACCENT_RIM.slice(), accentGen: () => ACCENT_GEN };
