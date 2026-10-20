'use strict';

/* Local lab asset optimisation only. StarNet's original artwork is not MIT
   licensed (see NOTICE.md); these derivatives stay in this working copy and are
   never published. Lossless stays for art with transparency, q92 for opaque
   photographic textures. Idempotent: an up-to-date .webp is left alone. */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '../frontend/assets/industrial');
const propsDir = path.join(root, 'projection-correction');
const floorIds = 'spine alloy plate panel tile tread soft grate hex plank turf diamond resin ceramic cargo runner treadway meshway basalt parquet rubber slotted terrazzo octile'.split(' ');
const wallIds = 'bulkhead courses service plating ribbed panelled pipework viewport wainscot hedge braced machinery insulation'.split(' ');
const floorRev = new Set(['basalt', 'rubber', 'soft']);
const wallRev = new Set(['bulkhead', 'courses', 'panelled', 'pipework', 'ribbed', 'service']);
const names = ['floor', 'wall', 'shell', 'workstation', 'workstation-compact', 'chair-s', 'chair-e', 'chair-n',
  'tactical-table', 'console-bank', 'equipment-bay', 'deck-perimeter',
  ...floorIds.map(id => 'remaster/floors/' + id + (floorRev.has(id) ? '-v2' : '')),
  ...wallIds.map(id => 'remaster/walls/' + id + (wallRev.has(id) ? '-v3' : '')),
  'remaster/shell', 'remaster/crown', 'remaster/workstation-e', 'remaster/workstation-n',
  'remaster/workstation-compact-n', 'calibration/crate'];
const shells = ['monocoque', 'timber', 'clapboard', 'shingle', 'brick', 'stone', 'stucco', 'curtain', 'hedge', 'thermal', 'heatsink', 'truss', 'louver', 'ceramic'].map(id => 'shell-' + id);
const surfaces = ['flightdeck', 'lunar', 'maggrid', 'habitat'].map(id => 'floor-' + id)
  .concat(['pressure', 'radiator', 'utility', 'acoustic'].map(id => 'wall-' + id));
const artName = name => (name === 'remaster/shell' || shells.includes(name)) ? name + '-v2' : name;

async function convert(rel, base = root) {
  const source = path.join(base, rel + '.png');
  const target = path.join(base, rel + '.webp');
  if (!fs.existsSync(source)) return { rel, missing: true };
  const stat = fs.statSync(source);
  if (fs.existsSync(target) && fs.statSync(target).mtimeMs >= stat.mtimeMs) return { rel, skipped: true };
  const meta = await sharp(source).metadata();
  // q95 keeps transparency soft edges close to the PNG; textures are opaque.
  const options = meta.hasAlpha
    ? (base === propsDir ? { quality: 95, effort: 5, alphaQuality: 100 } : { lossless: true, effort: 5 })
    : { quality: 92, effort: 5, alphaQuality: 100 };
  const out = await sharp(source).webp(options).toBuffer();
  const temp = target + '.tmp-' + process.pid;
  fs.writeFileSync(temp, out);
  fs.renameSync(temp, target);
  return { rel, png: stat.size, webp: out.length, alpha: !!meta.hasAlpha };
}

(async () => {
  const rows = [];
  for (const name of [...names, ...shells, ...surfaces]) rows.push(await convert(artName(name)));
  // Projection-correction props (the default remaster set): 190 PNGs, ~87 MB.
  for (const file of fs.readdirSync(propsDir).filter(f => f.endsWith('.png'))) rows.push(await convert(file.slice(0, -4), propsDir));
  const made = rows.filter(r => r.webp);
  const png = made.reduce((n, r) => n + r.png, 0), webp = made.reduce((n, r) => n + r.webp, 0);
  console.log(JSON.stringify({ files: rows.length, written: made.length, skipped: rows.filter(r => r.skipped).length,
    missing: rows.filter(r => r.missing).map(r => r.rel), pngMB: +(png / 1048576).toFixed(1), webpMB: +(webp / 1048576).toFixed(1) }));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
