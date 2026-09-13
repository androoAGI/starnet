import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const root = new URL('../frontend/assets/sprites/bear/', import.meta.url);
let changed = 0;
for (let frame = 0; frame < 8; frame++) {
  const file = new URL('walk_north-west_' + frame + '.png', root);
  const before = await sharp(await fs.readFile(file)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const pixels = Buffer.from(before.data); let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] === 116 && pixels[i+1] === 186 && pixels[i+2] === 180 && pixels[i+3] > 100) {
      // Existing mid-shadow fur tone from this exact character's walking palette.
      pixels[i] = 169; pixels[i+1] = 100; pixels[i+2] = 74; count++;
    }
  }
  if (count) {
    const png = await sharp(pixels,{raw:{width:before.info.width,height:before.info.height,channels:4}}).png().toBuffer();
    const after = await sharp(png).ensureAlpha().raw().toBuffer();
    assert.deepEqual(after,pixels,'PNG round-trip preserves every edited and untouched pixel');
    for(let i=3;i<pixels.length;i+=4) assert.equal(after[i],before.data[i],'alpha unchanged');
    await fs.writeFile(file,png);
  }
  console.log(file.pathname.split('/').pop()+': '+count+' pixels'); changed+=count;
}
console.log('Repaired '+changed+' pixels; poses, dimensions and transparency preserved.');
