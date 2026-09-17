// Print every walk_*.png under the two asset roots that neither manifest references.
const fs = require('fs'), path = require('path');
const reach = new Set();
for (const file of ['frontend/assets/sprites/manifest.json', 'frontend/agent-demo/manifest.json'])
  for (const list of Object.values(JSON.parse(fs.readFileSync(file)).sprites))
    for (const p of list) reach.add(path.resolve('frontend/assets/sprites', p));
for (const root of ['frontend/assets/sprites', 'frontend/assets/agent-demo/approved-motion'])
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir))
      if (/^walk_.*\.png$/.test(f) && !reach.has(path.resolve(dir, f))) console.log(path.posix.join(root, d, f));
  }
