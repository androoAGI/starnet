'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(process.argv[2]);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'PACKAGE-SHA256.json'), 'utf8'));
for (const [file, expected] of Object.entries(manifest)) {
  if (path.isAbsolute(file) || file.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid package manifest');
  const target = path.join(root, file);
  if (!fs.lstatSync(target).isFile()) throw new Error('Invalid package file: ' + file);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  if (actual !== expected) throw new Error('Package checksum mismatch: ' + file);
}
console.log('Server package checksums verified.');
