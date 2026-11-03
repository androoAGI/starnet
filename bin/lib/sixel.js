/* bin/lib/sixel.js — the REAL StarNet wordmark as a terminal image (Sixel), sized to the terminal's own cells.

   The master (bin/lib/logo-image.js) is the brand wordmark's light, one channel. logoSixel() scales it to fit `rows`
   text rows of `cellH` pixels (and no wider than `maxCols` cells), colors it on a red ramp (the glow fades to deep red,
   the brightest core runs hot), leaves every unlit pixel transparent, and encodes it as a DCS Sixel string. Pure: no
   I/O, no dependencies beyond node:zlib, so test/cli-dashboard.test.js decodes the output and checks it against the
   master. Terminals that draw Sixel: Windows Terminal ≥ 1.22, WezTerm, iTerm2, foot, mlterm, VS Code (with images on). */
'use strict';

const zlib = require('node:zlib');

let MASTER = null;
function master() {
  if (!MASTER) {
    const m = require('./logo-image.js');
    MASTER = { w: m.width, h: m.height, px: zlib.inflateSync(Buffer.from(m.light, 'base64')) };
  }
  return MASTER;
}

// area-average resample of the light channel to w×h
function resample(src, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy0 = y * src.h / h, sy1 = (y + 1) * src.h / h;
    for (let x = 0; x < w; x++) {
      const sx0 = x * src.w / w, sx1 = (x + 1) * src.w / w;
      let s = 0, n = 0;
      for (let yy = Math.floor(sy0); yy < Math.min(src.h, Math.ceil(sy1)); yy++) {
        const wy = Math.min(yy + 1, sy1) - Math.max(yy, sy0);
        for (let xx = Math.floor(sx0); xx < Math.min(src.w, Math.ceil(sx1)); xx++) {
          const wx = Math.min(xx + 1, sx1) - Math.max(xx, sx0);
          s += src.px[yy * src.w + xx] * wx * wy; n += wx * wy;
        }
      }
      out[y * w + x] = n ? s / n / 255 : 0;
    }
  }
  return out;
}

// the red ramp, dim glow → the brand red → a hot core (sRGB 0-255)
const RAMP = [[70, 4, 14], [118, 8, 22], [170, 14, 32], [215, 24, 44], [255, 46, 62], [255, 104, 116], [255, 176, 184]];
const FLOOR = 0.07;   // below this a pixel is background (transparent)

/* logoSixel({ cellW, cellH, rows, maxCols, scale }) → { sixel, cols, rows, width, height } or null when it cannot fit.
   scale (0..1, default 1) draws the wordmark that much smaller inside its rows, centred top to bottom; the image keeps the
   rows' full height (transparent above and below), so whatever is laid out beside it stays where it was. */
function logoSixel(opts) {
  const o = opts || {};
  const cellW = Math.max(4, o.cellW | 0), cellH = Math.max(8, o.cellH | 0);
  const s = o.scale > 0 && o.scale < 1 ? o.scale : 1;
  const src = master();
  let rows = Math.max(1, o.rows | 0);
  let box, height, width, cols;
  for (;;) {
    box = rows * cellH - 2;                                  // a hair under the rows, so it never touches the next one
    height = Math.round(box * s);
    width = Math.round(height * src.w / src.h);
    cols = Math.ceil(width / cellW);
    if (!o.maxCols || cols <= o.maxCols || rows === 1) break;
    rows--;
  }
  if (o.maxCols && cols > o.maxCols) return null;
  const light = resample(src, width, height);
  const top = Math.round((box - height) / 2);
  const idx = new Int16Array(width * box).fill(-1);
  for (let i = 0; i < light.length; i++) {
    const v = light[i];
    if (v < FLOOR) continue;
    idx[i + top * width] = Math.min(RAMP.length - 1, Math.floor((v - FLOOR) / (1 - FLOOR) * RAMP.length));
  }
  return { sixel: encodeSixel(idx, width, box, RAMP), cols, rows, width, height: box };
}

/* encodeSixel(idx, width, height, palette, { fill }) → a DCS Sixel string. idx: one palette index per pixel, -1 = no pixel.
   Without fill the unset pixels stay transparent (P2=1: whatever the terminal drew there shows through); with fill they are
   painted the terminal's background (P2=0), so a frame drawn over the last one replaces it whole. */
function encodeSixel(idx, width, height, palette, opts) {
  const fill = !!(opts && opts.fill);
  // DCS P1=0 (aspect from the raster attributes), P2 (1 = transparent, 0 = background fill), q
  let s = '\x1bP0;' + (fill ? 0 : 1) + ';0q"1;1;' + width + ';' + height;
  palette.forEach(([r, g, b], i) => { s += '#' + i + ';2;' + Math.round(r * 100 / 255) + ';' + Math.round(g * 100 / 255) + ';' + Math.round(b * 100 / 255); });
  // one pass over each band's pixels sorts them by colour (a pass per palette colour over every pixel cost a whole room
  // 240 ms); then only the colours the band uses are written, in palette order
  const bits = new Uint8Array(palette.length * width), seen = new Uint8Array(palette.length);
  const used = [];
  for (let band = 0; band < height; band += 6) {
    used.length = 0;
    const rows = Math.min(6, height - band);
    for (let k = 0; k < rows; k++) {
      const row = (band + k) * width, bit = 1 << k;
      for (let x = 0; x < width; x++) {
        const c = idx[row + x];
        if (c < 0 || c >= palette.length) continue;
        if (!seen[c]) { seen[c] = 1; used.push(c); }
        bits[c * width + x] |= bit;
      }
    }
    used.sort((a, b) => a - b);
    let first = true;
    for (const c of used) {
      // the sixel column codes for this color in this band, run-length encoded
      let line = '', run = 0, prev = -1;
      const at = c * width;
      const flush = () => { if (run === 0) return; const ch = String.fromCharCode(63 + prev); line += run > 3 ? '!' + run + ch : ch.repeat(run); run = 0; };
      for (let x = 0; x < width; x++) {
        const b = bits[at + x];
        if (b === prev) run++; else { flush(); prev = b; run = 1; }
      }
      if (prev !== 0) flush();   // a trailing run of empty columns is dropped
      s += (first ? '' : '$') + '#' + c + line;
      first = false;
      bits.fill(0, at, at + width);
      seen[c] = 0;
    }
    s += '-';
  }
  return s + '\x1b\\';
}

/* decodeSixel(str) → { width, height, px: Int8Array of color indexes (-1 = transparent) } — for the tests */
function decodeSixel(str) {
  const m = /"1;1;(\d+);(\d+)/.exec(str);
  const width = Number(m[1]), height = Number(m[2]);
  const px = new Int16Array(width * height).fill(-1);
  const body = str.slice(str.indexOf(m[0]) + m[0].length, str.lastIndexOf('\x1b\\'));
  let x = 0, band = 0, color = 0, i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '#') {
      const mm = /^#(\d+)(;2;\d+;\d+;\d+)?/.exec(body.slice(i));
      if (!mm[2]) color = Number(mm[1]);
      i += mm[0].length; continue;
    }
    if (c === '$') { x = 0; i++; continue; }
    if (c === '-') { x = 0; band += 6; i++; continue; }
    let rep = 1;
    if (c === '!') { const mm = /^!(\d+)/.exec(body.slice(i)); rep = Number(mm[1]); i += mm[0].length; }
    const bits = body.charCodeAt(i) - 63;
    for (let r = 0; r < rep; r++, x++) for (let k = 0; k < 6; k++) if (bits & (1 << k)) { const y = band + k; if (y < height && x < width) px[y * width + x] = color; }
    i++;
  }
  return { width, height, px };
}

/* brailleLogo() → the same REAL wordmark as braille dots (2×4 a cell, 3 rows × 45 columns), for terminals that cannot
   draw images. Sampling the master onto so few dots smudged it (a level stroke between two dot rows lit both, uprights
   stepped unevenly, the star blurred), so the logo is DRAWN here, dot by dot: every upright leans exactly as the wordmark
   does (one dot right per two rows up, the pairs aligned to the braille cells, so each repeats the same pattern down the
   logo), every level stroke is one dot row, the A's left leg and the N's diagonal keep their own angles, and the A carries
   a four-point star. It was drawn at 4 rows and taken to 3 by its structure, never resampled: one row out of each
   multi-row band (an outline row is never dropped), a share of every stroke's inside and bar's length out of its columns
   (an outline column never), the star stood back upright where it was. '#' is a lit dot. */
const LOGO_DOTS = [
  '....#########.###########..######.......########.......###......####.##########.#########.',
  '...#........#.#.........#..#....#.......#.......#......#.#......#..#.#........#.#.......#.',
  '..#........#.#.........#..#.....#......#.........#....#...#....#..#.#........#.#.......#..',
  '..#...######..####..####.#.......#.....#..#####....#..#....#...#..#.#..#######.####..###..',
  '.#...#..........#..#....#...#...#.....#..#....#...#..#.....#..#..#.#..#..........#..#.....',
  '.#...######.....#..#....#...#....#....#..#....#....#.#......#.#..#.#..#####......#..#.....',
  '#.........#....#..#...#....#.#..#....#..######...#..#..#...#.#..#.#......#......#..#......',
  '..######...#...#..#...#...#...#..#...#......#####...#..#.#......#.#..####.......#..#......',
  '......#....#..#..#...#.....#.#...#..#..###...#.....#..#..#.....#.#...#.........#..#.......',
  '.######....#..#..#..#.......#.....#.#..#...#...#...#..#....#...#.#...######....#..#.......',
  '#........#...#..#..#....#...#....#.#..#...#...#...#..#....#...#.#........#....#..#........',
  '##########...####...#####.....#########.....#####.####......###.##########....####........'
];
const BRAILLE_DOT = [[1, 8], [2, 16], [4, 32], [64, 128]];
let brailleLines = null;
function brailleLogo() {
  if (brailleLines) return brailleLines;
  brailleLines = [];
  for (let cy = 0; cy < LOGO_DOTS.length / 4; cy++) {
    let s = '';
    for (let cx = 0; cx < LOGO_DOTS[0].length / 2; cx++) {
      let bits = 0;
      for (let k = 0; k < 4; k++) for (let c = 0; c < 2; c++) if (LOGO_DOTS[cy * 4 + k][cx * 2 + c] === '#') bits |= BRAILLE_DOT[k][c];
      s += bits ? String.fromCharCode(0x2800 + bits) : ' ';
    }
    brailleLines.push(s.replace(/\s+$/, ''));
  }
  return brailleLines;
}

/* What the terminal said to the startup probe (CSI 16 t, CSI 14 t, DA1):
   { sixel: DA1 lists attribute 4, cellW/cellH: from the cell-size reply, else the window's pixel size ÷ its cells,
     replied: the terminal answered DA1 at all }. */
function parseTermReplies(buf, cols, rows) {
  const s = String(buf || '');
  const da = /\x1b\[\?([\d;]*)c/.exec(s);
  const out = { sixel: !!(da && da[1].split(';').indexOf('4') >= 0), cellW: 0, cellH: 0, replied: !!da };
  const cell = /\x1b\[6;(\d+);(\d+)t/.exec(s);
  if (cell) { out.cellH = Number(cell[1]); out.cellW = Number(cell[2]); }
  else {
    const win = /\x1b\[4;(\d+);(\d+)t/.exec(s);
    if (win && cols > 0 && rows > 0) { out.cellH = Math.floor(Number(win[1]) / rows); out.cellW = Math.floor(Number(win[2]) / cols); }
  }
  if (!(out.cellW >= 4 && out.cellH >= 8)) { out.cellW = 0; out.cellH = 0; }   // a nonsense size draws no image
  return out;
}

module.exports = { logoSixel, encodeSixel, brailleLogo, decodeSixel, parseTermReplies, RAMP };
