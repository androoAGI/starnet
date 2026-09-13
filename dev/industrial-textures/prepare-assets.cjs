'use strict';
// Package the imagegen masters into the game. The workstation generator returned
// an opaque transparency matte; remove only its connected light background.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '../..');
const input = process.argv[2];
if (!input) throw new Error('Pass the directory containing the four imagegen masters.');
const files = {
  floor: 'exec-c8e0fddc-26c5-4a55-9731-f3848b234328.png',
  wall: 'exec-601872c7-3076-40af-9088-8bbe1d2d3eb2.png',
  shell: 'exec-49758ab7-d3f8-48b8-b68c-0036139d9511.png',
  workstation: 'exec-b73a7026-3c5c-488a-9212-3ec60f8c2521.png'
};
(async () => {
  const out = path.join(root, 'frontend/assets/industrial');
  fs.mkdirSync(out, { recursive: true });
  for (const [name, file] of Object.entries(files)) {
    const source = path.join(input, file);
    if (name !== 'workstation') {
      await sharp(source).resize({ width: name === 'wall' ? 1024 : 768 }).png().toFile(path.join(out, name + '.png'));
      continue;
    }
    const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info, seen = new Uint8Array(w * h), queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    const visit = i => {
      if (i < 0 || i >= w * h || seen[i]) return;
      const p = i * 4;
      if (Math.min(data[p], data[p + 1], data[p + 2]) < 145) return;
      seen[i] = 1; queue[tail++] = i;
    };
    for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1); }
    while (head < tail) {
      const i = queue[head++], x = i % w;
      if (x) visit(i - 1); if (x < w - 1) visit(i + 1); visit(i - w); visit(i + w);
    }
    let left = w, top = h, right = 0, bottom = 0;
    for (let i = 0; i < w * h; i++) {
      if (seen[i]) { data[i * 4 + 3] = 0; continue; }
      const x = i % w, y = Math.floor(i / w);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    await sharp(data, { raw: { width: w, height: h, channels: 4 } })
      .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
      .resize({ width: 768 }).png().toFile(path.join(out, name + '.png'));
    console.log(JSON.stringify({ name, removedMattePixels: tail, bounds: [left, top, right, bottom] }));
  }
})();
