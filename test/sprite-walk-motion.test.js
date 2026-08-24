/* Every shipped walk cycle must (a) be drawn on the same build as its own idle, and (b) actually
   re-pose the body rather than repeat the standing pose.

   Both defects reached players. Skeleton's walk came back from the 8-direction rebuild rendered
   28-38% larger than its rotations — assemble8 foot-anchors each frame independently, so the
   frames all sit on the floor line and only the SIZE betrays it. Pikachu's walk came back as six
   near-copies of the standing pose, because the walk template needs legs to swing and its feet
   never separate; in the world that reads as a body shimmering in place while it slides.

   ⛔ WHAT THIS DOES NOT CATCH: a walk cycle that is six copies of the standing pose. Three
   candidate measures were built and every one of them was thrown away for failing against real
   art — raw frame-to-frame churn (the dud produced MORE change than the real walk it replaced,
   5288 px vs 1752, because unstructured outline noise touches every edge at once); head-top lift
   and foot-band spread (both fail correct art — a stride leaves the head where it is, and
   pikachu's legs alternate IN PLACE without parting); and the density of change in the lower body
   over the upper (promising on the masters at dud 0.76x vs real 1.16-2.96x, but it PASSES the
   original dud and inverts entirely through the live renderer, where the dud reads 1.07x and a
   healthy capybara 0.97x). Pikachu's dead walk shipped and was caught by a human watching it, not
   by a number. Do not add a motion threshold here without first proving it FAILS ec7bc352's
   pikachu and PASSES all 38 sets. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const A = require('./_assert.js');

const ROOT = path.join(__dirname, '..', 'frontend', 'assets', 'sprites');
/* assemble8's place() pins every frame's content bottom to the foot line, so a healthy walk track
   has ZERO variation in frame bottom — 36 of the 38 sets measure exactly 0. The two that don't are
   the legacy 4-frame sets that predate the 8-direction pipeline. */
const BOTTOM_SPREAD_OK = 1;
const LEGACY_BOTTOM_SPREAD = { ultron: 3 };   // 4-frame set, hand-assembled before place()
const DIRS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];

/* Minimal PNG reader. The whole sprite roster is 8-bit RGBA, non-interlaced (colour type 6,
   bit depth 8, interlace 0) — asserted per file below rather than assumed, so a future asset
   in another format fails loudly instead of being silently mis-measured. */
function decodePng(buf, label) {
  A.ok(buf.readUInt32BE(0) === 0x89504e47, label + ' is a PNG');
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  A.ok(buf[24] === 8 && buf[25] === 6 && buf[28] === 0,
    `${label} is 8-bit RGBA non-interlaced (got depth ${buf[24]}, colour ${buf[25]}, interlace ${buf[28]})`);
  const idat = [];
  for (let off = 8; off + 8 <= buf.length;) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
    if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4, data = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error(`${label} row ${y} uses unknown PNG filter ${filter}`);
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? data[y * stride + x - 4] : 0;
      const b = y > 0 ? data[(y - 1) * stride + x] : 0;
      const c = (x >= 4 && y > 0) ? data[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      data[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, data };
}

function load(p) { return decodePng(fs.readFileSync(p), path.basename(p)); }
function alphaBox(im) {
  let top = -1, bot = -1;
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    if (im.data[(y * im.width + x) * 4 + 3] > 0) { if (top < 0) top = y; bot = y; break; }
  }
  return top < 0 ? null : { top, bot, h: bot - top + 1 };
}

const sets = fs.readdirSync(ROOT).filter(d => !d.startsWith('_') &&
  fs.statSync(path.join(ROOT, d)).isDirectory());
A.ok(sets.length >= 30, `found ${sets.length} sprite sets — the roster should be ~36`);

let checkedBuild = 0;
for (const set of sets) {
  const dir = path.join(ROOT, set);
  const has = f => fs.existsSync(path.join(dir, f));
  for (const d of DIRS) {
    if (!has(`rot_${d}.png`) || !has(`walk_${d}_0.png`)) continue;
    const frames = [];
    for (let i = 0; i < 16 && has(`walk_${d}_${i}.png`); i++) frames.push(load(path.join(dir, `walk_${d}_${i}.png`)));
    // FEET STAY ON THE FLOOR LINE. assemble8's place() pins every frame's content bottom to
    // FOOT_Y, and drawBody measures a set's foot padding from an IDLE frame — so a walk frame
    // whose content stops short of that line renders as a body hovering above its own contact
    // shadow. A synthesised "bob" that lifts the whole body reads exactly as floating, which is
    // how it was caught; the real walk it replaced keeps all six frames planted.
    const bottoms = frames.map(f => alphaBox(f).bot);
    const spread = Math.max(...bottoms) - Math.min(...bottoms);
    const allow = LEGACY_BOTTOM_SPREAD[set] != null ? LEGACY_BOTTOM_SPREAD[set] : BOTTOM_SPREAD_OK;
    A.ok(spread <= allow,
      `${set}.walk.${d} lifts off the floor line — frame bottoms span ${spread}px ` +
      `(${[...new Set(bottoms)].sort().join('/')}), so the body floats above its contact shadow`);

    const idleH = alphaBox(load(path.join(dir, `rot_${d}.png`))).h;
    const maxH = Math.max(...frames.map(f => alphaBox(f).h));
    const ratio = maxH / idleH;
    // The band is wide on purpose: it is a BUILD check, not a pose check, and a walk legitimately
    // raises a body a little. Skeleton's regression sat at 1.28-1.38, far outside anything real.
    A.ok(ratio >= 0.85 && ratio <= 1.25,
      `${set}.walk.${d} is drawn at ${ratio.toFixed(3)}x its own idle height — outside 0.85..1.25, ` +
      `so the body changes build the moment it steps (see fit_walk_to_idle.py)`);
    checkedBuild++;
  }
}

A.ok(checkedBuild > 250, `the audit covered the roster's walk tracks (${checkedBuild} directions)`);
A.report('sprite-walk-motion.test');
