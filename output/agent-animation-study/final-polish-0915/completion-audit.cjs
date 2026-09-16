// Release readiness is strict: retained art and runtime fallbacks do not fill missing poses.
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
  for (const [track, expected] of Object.entries(required)) {
    const files = sprites[skin.renderSet + '.' + track] || [];
    const available = files.filter(file => fs.existsSync(path.resolve('frontend/assets/sprites', file))).length;
    if (available < expected) gaps.push({track, expected, available, missing: expected - available});
  }
  return {id: skin.id, name: skin.name, complete: gaps.length === 0, gaps};
});
const result = {
  scope: '38 skins, each with 8 standing views, 64 walking frames, 4 sitting views and 4 north-facing typing frames; file coverage, not a claim of visual perfection',
  ready: rows.every(row => row.complete),
  completeSets: rows.filter(row => row.complete).length,
  totalSets: rows.length,
  missingFrames: rows.reduce((sum, row) => sum + row.gaps.reduce((n, gap) => n + gap.missing, 0), 0),
  rows
};
fs.writeFileSync(path.join(__dirname, 'completion-audit.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({...result, rows: rows.filter(row => !row.complete)}, null, 2));
process.exitCode = result.ready ? 0 : 1;
