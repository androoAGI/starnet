// New sets require full motion coverage. Explicitly approved release sets retain their original contract.
const fs = require('node:fs');
const path = require('node:path');
const catalog = JSON.parse(fs.readFileSync('frontend/agent-demo/catalog.json')).skins;
const sprites = JSON.parse(fs.readFileSync('frontend/agent-demo/manifest.json')).sprites;
const directions = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
const required = Object.fromEntries([
  ...directions.map(dir => ['rot.' + dir, 1]),
  ...directions.map(dir => ['walk.' + dir, 8]),
  ...['south', 'east', 'north', 'west'].map(dir => ['sit.' + dir, 1]),
  ['type.north', 4]
]);
const rows = catalog.map(skin => {
  const gaps = [];
  let contract = required;
  if (skin.id === 'pikachu' && skin.acceptedExisting && skin.approvedRelease === 'v0.11.2') {
    const release = JSON.parse(require('node:child_process').execFileSync('git', ['show', 'v0.11.2:frontend/assets/sprites/manifest.json'], {encoding:'utf8'})).sprites;
    contract = Object.fromEntries(Object.entries(release).filter(([key]) => key.startsWith('pikachu.')).map(([key, files]) => [key.slice(8), files.length]));
    for (const [key, files] of Object.entries(release).filter(([key]) => key.startsWith('pikachu.'))) {
      if (JSON.stringify(sprites[key]) !== JSON.stringify(files)) throw Error('Approved Pikachu release track changed: ' + key);
      for (const file of files) {
        const original = require('node:child_process').execFileSync('git', ['show', 'v0.11.2:frontend/assets/sprites/' + file]);
        for (const root of ['frontend', 'website/app']) if (!fs.readFileSync(root + '/assets/sprites/' + file).equals(original)) throw Error('Approved release asset changed: ' + file);
      }
    }
  }
  for (const [track, expected] of Object.entries(contract)) {
    const files = sprites[skin.renderSet + '.' + track] || [];
    const available = files.filter(file => fs.existsSync(path.resolve('frontend/assets/sprites', file))).length;
    if (available < expected) gaps.push({track, expected, available, missing: expected - available});
  }
  return {id: skin.id, name: skin.name, complete: gaps.length === 0, approvedRelease: skin.acceptedExisting ? skin.approvedRelease : undefined, gaps};
});
const result = {
  scope: '37 selected skins (completed Station Minion retained; unfinished duplicate excluded): full new-style motion contract, except user-approved Pikachu v0.11.2 release set verified byte-for-byte; file coverage, not a claim of visual perfection',
  ready: rows.every(row => row.complete),
  completeSets: rows.filter(row => row.complete).length,
  totalSets: rows.length,
  missingFrames: rows.reduce((sum, row) => sum + row.gaps.reduce((n, gap) => n + gap.missing, 0), 0),
  rows
};
fs.writeFileSync(path.join(__dirname, 'completion-audit.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({...result, rows: rows.filter(row => !row.complete)}, null, 2));
process.exitCode = result.ready ? 0 : 1;
