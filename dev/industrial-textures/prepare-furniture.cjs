'use strict';
// Package generated alpha sprites; no recolouring or silhouette painting.
const path = require('node:path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '../..');
const masters = process.argv[2];
if (!masters) throw new Error('Pass the imagegen master directory.');
const output = path.join(root, 'frontend/assets/industrial');
(async () => {
  const chair = path.join(masters, 'exec-c867a961-40bb-47d4-81fd-7308ca8925ad.png');
  const meta = await sharp(chair).metadata();
  for (const [i, facing] of ['s', 'e', 'n'].entries()) {
    const cell = await sharp(chair).extract({ left: i * 627, top: 0, width: 627, height: meta.height }).png().toBuffer();
    await sharp(cell).trim({ background: '#00000000', threshold: 1 }).resize({ height: 512 })
      .png().toFile(path.join(output, 'chair-' + facing + '.png'));
  }
  await sharp(path.join(masters, 'exec-b45bdc91-97e4-4d33-8709-7f19ea87be0f.png'))
    .trim({ background: '#00000000', threshold: 1 }).resize({ width: 768 })
    .png().toFile(path.join(output, 'workstation.png'));
})();
