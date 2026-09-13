'use strict';
const path = require('node:path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '../..');
const masters = process.argv[2];
if (!masters) throw new Error('Pass the imagegen master directory.');
async function cutout(filename, threshold = 145) {
  const { data, info } = await sharp(path.join(masters, filename))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  // The generator supplied an opaque checkerboard matte. Remove only connected
  // light background, leaving the dark frame and its interior details intact.
  if (!data.some((v, i) => i % 4 === 3 && v === 0)) {
    const seen = new Uint8Array(w * h), queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    const visit = i => {
      if (i < 0 || i >= w * h || seen[i]) return;
      if (Math.min(data[i*4], data[i*4+1], data[i*4+2]) < threshold) return;
      seen[i] = 1; queue[tail++] = i;
    };
    for (let x = 0; x < w; x++) { visit(x); visit((h-1)*w+x); }
    for (let y = 0; y < h; y++) { visit(y*w); visit(y*w+w-1); }
    while (head < tail) {
      const i = queue[head++], x = i % w;
      if (x) visit(i-1); if (x < w-1) visit(i+1); visit(i-w); visit(i+w);
    }
    for (let i = 0; i < seen.length; i++) if (seen[i]) data[i*4+3] = 0;
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}
(async () => {
  const out = path.join(root, 'frontend/assets/industrial');
  await sharp(path.join(masters, 'exec-9b5d6de4-b21a-49ea-8850-015d9541e410.png'))
    .resize({ width: 1024 }).png().toFile(path.join(out, 'wall.png'));
  await sharp(await cutout('exec-05dda522-d8d3-4b11-bda9-2c13aa0e57cb.png'))
    .trim({ background: '#00000000', threshold: 1 }).resize({ width: 1024 })
    .png().toFile(path.join(out, 'workstation.png'));
  await sharp(path.join(masters, 'exec-b45bdc91-97e4-4d33-8709-7f19ea87be0f.png'))
    .trim({ background: '#00000000', threshold: 1 }).resize({ width: 768 })
    .png().toFile(path.join(out, 'workstation-compact.png'));
  const atlas = await cutout('exec-a36a183f-06b1-49cc-9236-39e52d7c9de0.png');
  const meta = await sharp(atlas).metadata();
  for (const [i, facing] of ['s', 'e', 'n'].entries()) {
    const left = Math.floor(i * meta.width / 3), right = Math.floor((i + 1) * meta.width / 3);
    const cell = await sharp(atlas).extract({ left, top: 0, width: right - left, height: meta.height }).png().toBuffer();
    await sharp(cell).trim({ background: '#00000000', threshold: 1 }).resize({ height: 512 })
      .png().toFile(path.join(out, 'chair-' + facing + '.png'));
  }
})();
