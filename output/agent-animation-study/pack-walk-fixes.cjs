// Stage corrected loops for visual inspection; --activate explicitly selects them.
const fs = require('fs'), path = require('path'), sharp = require('sharp');
const base = 'output/agent-animation-study/approved-motion';
(async () => {
  const jobFile = process.argv.find(a=>a.startsWith('--jobs='))?.slice(7) || 'walk-fixes.json';
  const jobs = JSON.parse(fs.readFileSync(base + '/' + jobFile));
  for (const j of jobs.filter(j => j.done)) {
    const dir = `${base}/walk-fixes/${j.id}/${j.dir}/${j.job}`;
    fs.mkdirSync(dir, { recursive: true });
    const url = j.result.match(/https:\/\/api\.pixellab\.ai\/mcp\/images\/[^\s]+\/download\?index=0/)?.[0];
    if (!url) throw Error('Missing verified URL: ' + j.job);
    const layers = [];
    for (let i = 0; i < 9; i++) {
      const raw = `${dir}/raw-${i}.png`, packed = `${dir}/${i}.png`;
      if (!fs.existsSync(raw)) {
        const r = await fetch(url.replace('index=0', 'index=' + i));
        if (!r.ok) throw Error('Download ' + r.status);
        fs.writeFileSync(raw, Buffer.from(await r.arrayBuffer()));
      }
      const m = await sharp(raw).metadata();
      if (m.width > 144 || m.height > 144) throw Error('Oversize frame');
      await sharp({create:{width:144,height:144,channels:4,background:'#00000000'}})
        .composite([{input:raw,left:Math.round((144-m.width)/2),top:24-Math.round((m.height-96)/2)}]).png().toFile(packed);
      layers.push({input:packed,left:i*144,top:0});
    }
    await sharp({create:{width:1296,height:144,channels:4,background:'#273237'}}).composite(layers).png()
      .toFile(`${base}/walk-fixes/${j.id}-${j.dir}.png`);
    if (process.argv.includes('--activate') && j.approved) {
      for (const root of ['frontend','website/app']) for (let i=0;i<9;i++) {
        fs.copyFileSync(`${dir}/${i}.png`,`${root}/assets/agent-demo/approved-motion/${j.id}/walk_${j.dir}_${i}.png`);
      }
    }
  }
  console.log('Staged ' + jobs.filter(j=>j.done).length + ' corrected loops');
})();
