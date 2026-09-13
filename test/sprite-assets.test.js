'use strict';

const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const root = path.join(__dirname, '..', 'frontend', 'assets', 'sprites');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const sprites = manifest && manifest.sprites;
A.ok(sprites && typeof sprites === 'object' && !Array.isArray(sprites), 'sprite manifest has a keyed sprites map');

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, out);
    else out.push(path.relative(root, absolute).replace(/\\/g, '/'));
  }
  return out;
}

const files = new Set(walk(root, []));
const referenced = new Set();
for (const [key, frames] of Object.entries(sprites || {})) {
  A.ok(Array.isArray(frames) && frames.length > 0, key + ' declares at least one frame');
  for (const frame of frames || []) {
    const rel = String(frame || '').replace(/\\/g, '/');
    A.ok(rel && !rel.startsWith('/') && !rel.split('/').includes('..'), key + ' frame stays inside the sprite root');
    A.ok(rel.endsWith('.png'), key + ' frame is a PNG');
    A.ok(files.has(rel), key + ' frame exists: ' + rel);
    A.ok(!referenced.has(rel), key + ' does not alias an already-owned frame: ' + rel);
    referenced.add(rel);
  }
}

const orphaned = Array.from(files).filter(file => file.endsWith('.png') && !referenced.has(file));
A.eq(orphaned, [], 'every shipped sprite PNG is reachable from the canonical manifest');
A.ok(referenced.size > 3000, 'the audit covered the complete generated sprite set');
const palette = require('node:child_process').spawnSync(process.execPath, ['dev/check-bear-palette.mjs'], {
  cwd: path.join(__dirname, '..'), encoding: 'utf8'
});
A.eq(palette.status, 0, 'sprite palette regression: ' + (palette.stderr || palette.stdout));
A.report('sprite-assets.test');
