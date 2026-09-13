'use strict';
const path = require('node:path');
const sharp = require('sharp');
const out = path.resolve(__dirname, '../../frontend/assets/industrial');
const masters = process.argv[2];
if (!masters) throw new Error('Pass the imagegen master directory.');
const assets = {
  'tactical-table': 'exec-ffbbbbee-8728-4078-ba97-e1fda77faea0.png',
  'console-bank': 'exec-2d34c7dd-9680-4811-8428-7584f046501c.png',
  'equipment-bay': 'exec-72d97b04-4203-4ef0-9b83-6eac6d15cc71.png',
  'deck-perimeter': 'exec-e537f3fb-4612-4b30-a037-8314de2208f6.png'
};
(async () => {
  for (const [name, master] of Object.entries(assets)) {
    const input = sharp(path.join(masters, master));
    const stats = await input.stats();
    if (!stats.channels[3] || stats.channels[3].min !== 0) throw new Error(name + ' needs genuine alpha');
    await input.trim({ background: '#00000000', threshold: 1 }).resize({ width: 1024 })
      .png().toFile(path.join(out, name + '.png'));
    console.log(name + ': transparent master packaged');
  }
})();
