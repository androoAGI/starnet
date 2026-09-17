// Pack a PixelLab skeleton-template walk (walking-8-frames, 8 directions) into the production
// 144px approved_<set> masters — same scale and foot anchor as that set's standing rotation.
//
//   node output/agent-animation-study/walk-cycle-fix/pack-template-walk.cjs <setId> [--group=<name>]
//
// Input:  output/agent-animation-study/walk-cycle-fix/<setId>/character.txt — the verbatim
//         get_character() output, which lists rotation URLs and the animation group's frame URLs.
// Output: frontend/assets/sprites/approved_<setId>/walk_<dir>_1..8.png (production)
//         frontend/assets/agent-demo/approved-motion/<setId>/walk_<dir>_1..8.png (review demo; frame 0 kept)
//         output/agent-animation-study/walk-cycle-fix/<setId>/{raw,contact.png,report.json}
//
// Transform (per direction), matching prepare-catalog-refs.cjs so the walk keeps the standing build:
//   the 96px PixelLab rotation's alpha>100 box is (l,t,w0,h); s = 76/h; wr = round(w0*s);
//   the rotation master places that box at (24+floor((96-wr)/2), 36). Every walk frame of that
//   direction is scaled by the SAME s and offset so the character's canvas origin lands where the
//   rotation's did — no per-frame fit, so the natural stride/bob of the template survives.
const fs = require('fs'), path = require('path'), sharp = require('sharp');
const DIRS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
const setId = process.argv[2];
if (!/^[a-z_]+$/.test(setId || '')) throw Error('usage: pack-template-walk.cjs <setId> [--group=name]');
const groupArg = (process.argv.find(a => a.startsWith('--group=')) || '').slice(8) || 'walk-cycle-fix-0917';
const base = path.join('output/agent-animation-study/walk-cycle-fix', setId);
const raw = path.join(base, 'raw'); fs.mkdirSync(raw, { recursive: true });

// --- frame URLs: either the verbatim get_character() text, or the compact walk.json ----------
//   walk.json = { charId, rotT, anims: { <dir>: [<animationId>, <t>] } }  — the PixelLab CDN layout is
//   <cdn>/<charId>/rotations/<dir>.png?t=<rotT> and <cdn>/<charId>/animations/<animId>/<dir>/<i>.png?t=<t>
const CDN = 'https://backblaze.pixellab.ai/file/pixellab-characters/1ff7d2cf-cfe6-44f9-9533-9eea41eb05cb/';
const rotUrls = {}, walkUrls = {};
if (fs.existsSync(path.join(base, 'walk.json'))) {
  const j = JSON.parse(fs.readFileSync(path.join(base, 'walk.json'), 'utf8'));
  for (const d of DIRS) {
    rotUrls[d] = `${CDN}${j.charId}/rotations/${d}.png?t=${j.rotT}`;
    const [anim, t] = j.anims[d] || [];
    if (!anim) throw Error('walk.json missing ' + d);
    walkUrls[d] = Array.from({ length: 8 }, (_, i) => `${CDN}${j.charId}/animations/${anim}/${d}/${i}.png?t=${t}`);
  }
} else {
  const detail = fs.readFileSync(path.join(base, 'character.txt'), 'utf8');
  const rotSection = detail.split('rotations:\n')[1]?.split('\n\n')[0];
  if (!rotSection) throw Error('no rotations section');
  for (const m of rotSection.matchAll(/^  ([a-z-]+): (https:\/\/\S+)/gm)) rotUrls[m[1]] = m[2];
  const animBlocks = detail.split(/\n  (?=[\w-]+ — \d+ dir)/).slice(1);
  const block = animBlocks.find(b => b.startsWith(groupArg + ' —'));
  if (!block) throw Error('animation group not found: ' + groupArg + ' (have: ' + animBlocks.map(b => b.split(' —')[0]).join(', ') + ')');
  if (!/\[type=walking-8-frames\]/.test(block)) throw Error(groupArg + ' is not a walking-8-frames template group');
  for (const m of block.matchAll(/^    ([a-z-]+): (.+)$/gm)) {
    const urls = m[2].split(',').map(s => s.trim()).filter(Boolean);
    if (urls.length !== 8) throw Error(m[1] + ' has ' + urls.length + ' frames');
    walkUrls[m[1]] = urls;
  }
}
for (const d of DIRS) { if (!rotUrls[d]) throw Error('missing rotation ' + d); if (!walkUrls[d]) throw Error('missing walk ' + d); }

async function download(url, file) {
  if (fs.existsSync(file)) return;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw Error('download ' + r.status + ' ' + url);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}
async function box(file, thr = 100) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let l = info.width, t = info.height, r = -1, b = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++)
    if (data[(y * info.width + x) * 4 + 3] > thr) { l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y); }
  if (r < l) throw Error('empty ' + file);
  return { l, t, w: r - l + 1, h: b - t + 1, foot: b + 1, clipped: l <= 0 || t <= 0 || r >= info.width - 1 || b >= info.height - 1, cw: info.width, ch: info.height };
}

// --- glitch detection -------------------------------------------------------------------------
// Template generation occasionally returns one frame whose HEAD is drawn facing the wrong way
// (alien south frame 7 came back with the back of the skull). Two tests on the head crop (top 20
// rows of the body, 36px wide, centred on the skull):
//   facing:  the head must be closer to THIS direction's rotation than to the OPPOSITE direction's;
//   outlier: its mean distance to the other seven heads must not exceed 1.9x the cycle's median.
// A flagged frame is rebuilt from the opposite-phase frame (i+4): mirrored for south/north (that
// swaps the legs back), used as-is for side/diagonal views where the silhouette matches. Up to
// four repairs are accepted when every source frame is itself clean (vaultboy south had three
// whole-body facing flips); more than that means the track is junk — regenerate it.
const OPP = { south: 'north', north: 'south', east: 'west', west: 'east', 'south-east': 'north-west', 'north-west': 'south-east', 'north-east': 'south-west', 'south-west': 'north-east' };
const HEAD_H = 20, HEAD_W = 36, OUTLIER = 1.9;
async function headCrop(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, A = (x, y) => data[(y * W + x) * 4 + 3] > 100;
  let top = -1;
  for (let y = 0; y < info.height && top < 0; y++) for (let x = 0; x < W; x++) if (A(x, y)) { top = y; break; }
  let l = W, r = -1;
  for (let y = top; y < Math.min(top + 12, info.height); y++) for (let x = 0; x < W; x++) if (A(x, y)) { l = Math.min(l, x); r = Math.max(r, x); }
  const cx = Math.round((l + r) / 2), x0 = cx - HEAD_W / 2;
  const rgb = new Float64Array(HEAD_H * HEAD_W * 3), mask = new Uint8Array(HEAD_H * HEAD_W);
  for (let y = 0; y < HEAD_H; y++) for (let x = 0; x < HEAD_W; x++) {
    const sx = x0 + x, sy = top + y;
    if (sx < 0 || sx >= W || sy >= info.height || !A(sx, sy)) continue;
    const k = (y * HEAD_W + x); mask[k] = 1;
    for (let c = 0; c < 3; c++) rgb[k * 3 + c] = data[(sy * W + sx) * 4 + c];
  }
  return { rgb, mask };
}
function headDist(a, b) {
  let sum = 0, n = 0;
  for (let k = 0; k < a.mask.length; k++) if (a.mask[k] || b.mask[k]) {
    n++; for (let c = 0; c < 3; c++) sum += Math.abs(a.rgb[k * 3 + c] - b.rgb[k * 3 + c]);
  }
  return n ? sum / n : 0;
}

(async () => {
  const prod = path.join('frontend/assets/sprites', 'approved_' + setId);
  const demo = path.join('frontend/assets/agent-demo/approved-motion', setId);
  if (!fs.existsSync(path.join(prod, 'rot_south.png'))) throw Error('no production set ' + prod);
  const report = { setId, group: groupArg, repairs: [], directions: {} };
  const masters = {};   // d -> [buffer x8]
  const rotMasters = {}; // d -> buffer (the PixelLab rotation, packed with the same transform)
  const transforms = {};
  // pass 1: download + pack everything in memory
  for (const d of DIRS) {
    const rotFile = path.join(raw, 'rot_' + d + '.png');
    await download(rotUrls[d], rotFile);
    const rb = await box(rotFile);
    if (rb.cw !== 96 || rb.ch !== 96) throw Error('rotation canvas ' + rb.cw + 'x' + rb.ch);
    const s = 76 / rb.h, wr = Math.round(rb.w * s);
    const left0 = 24 + Math.floor((96 - wr) / 2) - Math.round(rb.l * s);
    const top0 = 36 - Math.round(rb.t * s);
    const N = Math.round(96 * s);
    transforms[d] = { s, rb };
    const pack = async (file) => {
      const m = await sharp(file).metadata();
      if (m.width !== 96 || m.height !== 96) throw Error('frame canvas ' + m.width + 'x' + m.height + ' ' + file);
      let img = sharp(file).ensureAlpha();
      if (N !== 96) img = img.resize(N, N);            // same kernel as the rotation refs (sharp default)
      let buf = await img.png().toBuffer();
      let left = left0, top = top0, w = N, h = N, ex = 0, ey = 0;   // clamp into the 144 master
      if (left < 0) { ex = -left; w += left; left = 0; }
      if (top < 0) { ey = -top; h += top; top = 0; }
      if (left + w > 144) w = 144 - left;
      if (top + h > 144) h = 144 - top;
      if (ex || ey || w !== N || h !== N) buf = await sharp(buf).extract({ left: ex, top: ey, width: w, height: h }).png().toBuffer();
      return sharp({ create: { width: 144, height: 144, channels: 4, background: '#00000000' } }).composite([{ input: buf, left, top }]).png().toBuffer();
    };
    rotMasters[d] = await pack(rotFile);
    masters[d] = [];
    for (let i = 0; i < 8; i++) {
      const f = path.join(raw, `walk_${d}_${i}.png`);
      await download(walkUrls[d][i], f);
      masters[d].push(await pack(f));
    }
  }
  // palette scrub: walk.json may declare  "scrub": ["grey", "red"]  — the capybara template kept inventing
  // grey hip equipment and a red drape (twice), colours its brown/tan palette never uses. Any pixel matching
  // a named rule is cleared to transparent before the checks run. Rules are deliberately narrow.
  {
    const scrub = fs.existsSync(path.join(base, 'walk.json')) ? (JSON.parse(fs.readFileSync(path.join(base, 'walk.json'), 'utf8')).scrub || []) : [];
    const RULES = {
      grey: (r, g, b) => Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && Math.abs(r - b) < 14 && r > 95 && r < 225,
      red: (r, g, b) => r > 120 && g < 0.55 * r && b < 0.55 * r,
    };
    if (scrub.includes('palette')) {
      // palette lock: every opaque colour in the eight PixelLab rotations is the allowed set; a walk pixel
      // farther than 48 RGB units from all of them is not this character's paint.
      const pal = [];
      for (const d of DIRS) { const A = await sharp(rotMasters[d]).ensureAlpha().raw().toBuffer(); for (let k = 0; k < A.length; k += 4) if (A[k + 3] > 100) pal.push([A[k], A[k + 1], A[k + 2]]); }
      const q = new Map(); for (const [r, g, b] of pal) q.set(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3), [r, g, b]);
      const cols = [...q.values()];
      RULES.palette = (r, g, b) => { for (const [pr, pg, pb] of cols) { if (Math.abs(r - pr) + Math.abs(g - pg) + Math.abs(b - pb) < 48) return false; } return true; };
    }
    if (scrub.length) {
      const tests = scrub.map(n => { if (!RULES[n]) throw Error('unknown scrub rule ' + n); return RULES[n]; });
      let cleared = 0;
      for (const d of DIRS) masters[d] = await Promise.all(masters[d].map(async (buf) => {
        const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        for (let k = 0; k < data.length; k += 4) if (data[k + 3] > 0 && tests.some(t => t(data[k], data[k + 1], data[k + 2]))) { data[k + 3] = 0; cleared++; }
        return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
      }));
      report.scrub = { rules: scrub, pixelsCleared: cleared };
      console.log(`  SCRUB ${setId}: cleared ${cleared} off-palette pixels (${scrub.join(', ')}) across 64 frames`);
    }
  }
  // mirror fallback: walk.json may declare  "mirror": { "north-west": "north-east" }  — the template kept
  // losing the xenomorph's tail on north-west twice in a row, while north-east was fine. A horizontal flip of
  // the opposite-hand track is a legitimate view of the same walk (left/right swap only), so the packed
  // north-east masters are flopped into north-west after pass 1.
  {
    const mirror = fs.existsSync(path.join(base, 'walk.json')) ? (JSON.parse(fs.readFileSync(path.join(base, 'walk.json'), 'utf8')).mirror || {}) : {};
    for (const [dst, src] of Object.entries(mirror)) {
      if (!masters[src]) throw Error('mirror source missing: ' + src);
      masters[dst] = await Promise.all(masters[src].map(b => sharp(b).flop().png().toBuffer()));
      report.repairs.push({ dir: dst, mirroredTrackFrom: src });
      console.log(`  MIRROR ${setId} ${dst} ← ${src} flipped horizontally (template could not hold the design on ${dst})`);
    }
  }
  // identity guard: the PixelLab character must BE the production set (android's catalog record pointed at
  // a cream '19px industrial android' while production ships the grey pixel-cadet family — a walk from the
  // wrong character packs cleanly and only the colour betrays it). Compare the packed east rotation to
  // production's; anything above 90 mean RGB units over the union alpha is a different character.
  {
    // Mean body colour (over alpha>100), not per-pixel difference: a one-pixel misalignment of thin bones
    // scored the matching skeleton at 121 per pixel, while the wrong (cream vs grey) android scored 246.
    const meanRGB = async (a) => { const A = await sharp(a).ensureAlpha().raw().toBuffer(); let n = 0, s = [0, 0, 0]; for (let k = 0; k < A.length; k += 4) if (A[k + 3] > 100) { n++; for (let c = 0; c < 3; c++) s[c] += A[k + c]; } return s.map(v => n ? v / n : 0); };
    const mA = await meanRGB(rotMasters.east), mB = await meanRGB(path.join(prod, 'rot_east.png'));
    const dEast = mA.reduce((acc, v, c) => acc + Math.abs(v - mB[c]), 0);
    console.log(`${setId} identity check: mean body colour, PixelLab east rotation vs production rot_east = ${dEast.toFixed(1)} (sum of |ΔR|+|ΔG|+|ΔB|; matching sets are small, a different character is large)`);
    if (dEast > 60 && !process.argv.includes('--force')) throw Error('character mismatch: PixelLab rotation does not match production art (' + dEast.toFixed(1) + '); wrong character id?');
  }
  // per-direction colour drift: blank_red's north-east track came back desaturated pink across all eight
  // frames (no single frame stands out, so the head-outlier test cannot see it). Compare each direction's
  // mean walk colour with its own rotation's; a shift above 60 units marks (alien north-east measures 48 and looks right) the whole track for regeneration.
  {
    const meanRGB = async (a) => { const A = await sharp(a).ensureAlpha().raw().toBuffer(); let n = 0, s = [0, 0, 0]; for (let k = 0; k < A.length; k += 4) if (A[k + 3] > 100) { n++; for (let c = 0; c < 3; c++) s[c] += A[k + c]; } return s.map(v => n ? v / n : 0); };
    const drift = [];
    for (const d of DIRS) {
      const r = await meanRGB(rotMasters[d]);
      const ms = await Promise.all(masters[d].map(meanRGB));
      const m = [0, 1, 2].map(c => ms.reduce((a, v) => a + v[c], 0) / ms.length);
      const dd = m.reduce((a, v, c) => a + Math.abs(v - r[c]), 0);
      // silhouette mass: xenomorph's north-west track came back as a round-headed humanoid with no tail —
      // right colours, half the pixels. Mean alpha area of the track vs its rotation must stay within 0.55..1.5 (hard) and is warned below 0.72; good sets measure 0.78-1.13, ultrondroid 0.60-0.66 (chunky rotation, slimmer template).
      const area = async (a) => { const A = await sharp(a).ensureAlpha().raw().toBuffer(); let n = 0; for (let k = 3; k < A.length; k += 4) if (A[k] > 100) n++; return n; };
      const ra = await area(rotMasters[d]), wa = (await Promise.all(masters[d].map(area))).reduce((a, v) => a + v, 0) / 8;
      const ar = wa / ra;
      report.directions[d] = { colourDrift: +dd.toFixed(1), areaRatio: +ar.toFixed(3) };
      if (dd > 60) drift.push(`${d} (colour ${dd.toFixed(0)})`);
      if (ar < 0.55 || ar > 1.5) drift.push(`${d} (area x${ar.toFixed(2)})`);
      else if (ar < 0.72) console.log(`  WARN ${setId} ${d}: template slimmed the build to x${ar.toFixed(2)} of the rotation's pixel mass (review the contact sheet)`);
    }
    if (drift.length && !process.argv.includes('--force')) throw Error('colour drift vs rotation in: ' + drift.join(', ') + ' — regenerate those directions');
  }
  // pass 2: flag + repair glitched frames
  const rotHeads = {};
  for (const d of DIRS) rotHeads[d] = await headCrop(rotMasters[d]);
  for (const d of DIRS) {
    const heads = [];
    for (const b of masters[d]) heads.push(await headCrop(b));
    const flags = [];
    const toOthers = heads.map((h, i) => heads.reduce((acc, o, j) => i === j ? acc : acc + headDist(h, o), 0) / 7);
    const med = [...toOthers].sort((a, b) => a - b)[4];
    for (let i = 0; i < 8; i++) {
      const same = headDist(heads[i], rotHeads[d]), opp = headDist(heads[i], rotHeads[OPP[d]]);
      const score = toOthers[i] / med;
      const why = [];
      // clear margin only: a faceless cadet's front and back heads differ by ~10-30 units, real flips by 2x / 60+ units
      if (same > opp * 1.3 && same - opp > 40) why.push(`faces ${OPP[d]} (d_same ${same.toFixed(0)} > d_opp ${opp.toFixed(0)})`);
      if (score >= OUTLIER) why.push(`head outlier x${score.toFixed(2)}`);
      if (why.length) flags.push({ i, why });
    }
    // manual override from walk.json  "badFrames": { "south": [4,5,6,7] }  — for flips the head metrics miss
    // (morpheus is bald: his skull reads the same from front and back, so four south frames turned around unseen)
    {
      const manual = fs.existsSync(path.join(base, 'walk.json')) ? ((JSON.parse(fs.readFileSync(path.join(base, 'walk.json'), 'utf8')).badFrames || {})[d] || []) : [];
      for (const i of manual) if (!flags.some(f => f.i === i)) flags.push({ i, why: ['marked bad in walk.json'] });
    }
    if (flags.length > 4) throw Error(`${d}: ${flags.length} glitched frames — regenerate this direction: ` + JSON.stringify(flags));
    for (const fl of flags) {
      const src = (fl.i + 4) % 8;
      if (flags.some(o => o.i === src)) throw Error(`${d}: frames ${fl.i} and ${src} both glitched — regenerate this direction`);
      const mirror = d === 'south' || d === 'north';
      masters[d][fl.i] = mirror ? await sharp(masters[d][src]).flop().png().toBuffer() : Buffer.from(masters[d][src]);
      report.repairs.push({ dir: d, frame: fl.i, from: src, mirrored: mirror, why: fl.why });
      console.log(`  REPAIR ${setId} ${d} frame ${fl.i} ← frame ${src}${mirror ? ' (mirrored)' : ''}: ${fl.why.join('; ')}`);
    }
  }
  // pass 3: measure, install, report
  fs.mkdirSync(prod, { recursive: true }); fs.mkdirSync(demo, { recursive: true });
  for (const d of DIRS) {
    const frames = [];
    for (let i = 0; i < 8; i++) {
      const out = masters[d][i];
      const tmp = path.join(raw, `master_${d}_${i}.png`); fs.writeFileSync(tmp, out);
      const b = await box(tmp);
      frames.push({ i, height: b.h, width: b.w, foot: b.foot, clipped: b.clipped });
      // install: production 1..8 and the review demo 1..8 (demo frame 0 = its input reference, untouched)
      fs.writeFileSync(path.join(prod, `walk_${d}_${i + 1}.png`), out);
      fs.writeFileSync(path.join(demo, `walk_${d}_${i + 1}.png`), out);
    }
    const prodRot = await box(path.join(prod, 'rot_' + d + '.png'));
    const { s, rb } = transforms[d];
    report.directions[d] = { ...report.directions[d], scale: +s.toFixed(4), rotBox: rb, standingHeight: prodRot.h, standingFoot: prodRot.foot, frames };
    const hs = frames.map(f => f.height);
    const ratio = Math.max(...hs) / prodRot.h;
    const bad = frames.filter(f => f.clipped);
    console.log(`${setId} ${d.padEnd(10)} s=${s.toFixed(3)} walk h ${Math.min(...hs)}..${Math.max(...hs)} (idle ${prodRot.h}, max ratio ${ratio.toFixed(3)}) foot ${Math.min(...frames.map(f => f.foot))}..${Math.max(...frames.map(f => f.foot))}${bad.length ? '  CLIPPED ' + bad.map(f => f.i) : ''}`);
    if (ratio > 1.25 || ratio < 0.85) throw Error('build ratio out of band ' + d);
    if (bad.length) throw Error('clipped frames ' + d);
  }
  // contact sheet: one row per direction — production rotation then the eight frames, cropped to the
  // body (master x 16..128, y 24..120) at 2x nearest
  const Z = 2, CW = 112, CH = 96, cw = CW * Z, ch = CH * Z;
  const crop = async (input) => sharp(input).extract({ left: 16, top: 24, width: CW, height: CH }).resize(cw, ch, { kernel: 'nearest' }).png().toBuffer();
  const comps = [];
  for (let r = 0; r < DIRS.length; r++) {
    const d = DIRS[r];
    comps.push({ input: await crop(path.join(prod, 'rot_' + d + '.png')), left: 0, top: r * ch });
    for (let i = 0; i < 8; i++) comps.push({ input: await crop(masters[d][i]), left: (i + 1) * cw, top: r * ch });
  }
  await sharp({ create: { width: cw * 9, height: ch * 8, channels: 4, background: '#282830ff' } }).composite(comps).png().toFile(path.join(base, 'contact.png'));
  fs.writeFileSync(path.join(base, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('packed', setId, '→', prod, '+ demo; repairs:', report.repairs.length, '; contact:', path.join(base, 'contact.png'));
})().catch(e => { console.error(e); process.exit(1); });
