/* Canonical, binary-safe Open Agent Skill package primitives.

   A package is a standard skill folder transported as a bounded manifest. SKILL.md is
   mandatory; support files may only live in the four Open Agent Skills disclosure
   directories. Digests cover paths and exact bytes, independent of JSON key ordering. */
'use strict';

const crypto = require('node:crypto');

const FORMAT = 'open-agent-skill-package/v1';
const SUPPORT_DIRS = new Set(['references', 'templates', 'scripts', 'assets']);
const DEFAULT_MAX_FILES = 64;
const DEFAULT_MAX_FILE_BYTES = 256000;
const DEFAULT_MAX_PACKAGE_BYTES = 1024 * 1024;

// A license or notice file at the package root travels with the skill: MIT and Apache-2.0 both require the notice
// to go wherever the work goes, and dropping it made a faithful redistribution impossible.
const ROOT_FILES = /^(?:LICENSE|NOTICE|COPYING)(?:\.(?:md|txt))?$/;

function str(v) { return v == null ? '' : String(v); }
function safePath(raw) {
  let p = str(raw).trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!p || p.length > 240 || /^[A-Za-z]:/.test(p) || p.split('/').includes('..') || /[\x00-\x1F]/.test(p)) return null;
  if (p === 'SKILL.md' || ROOT_FILES.test(p)) return p;
  const root = p.split('/')[0];
  return SUPPORT_DIRS.has(root) && p !== root ? p : null;
}
function asBuffer(file) {
  if (!file || typeof file !== 'object') throw new Error('package file is invalid');
  if (Buffer.isBuffer(file.bytes)) return Buffer.from(file.bytes);
  if (file.encoding === 'base64') {
    const raw = str(file.content);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) throw new Error('package file has invalid base64 content');
    return Buffer.from(raw, 'base64');
  }
  return Buffer.from(str(file.content), 'utf8');
}
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonicalize(files, opts) {
  opts = opts || {};
  const maxFiles = opts.maxFiles > 0 ? opts.maxFiles : DEFAULT_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes > 0 ? opts.maxFileBytes : DEFAULT_MAX_FILE_BYTES;
  const maxPackageBytes = opts.maxPackageBytes > 0 ? opts.maxPackageBytes : DEFAULT_MAX_PACKAGE_BYTES;
  if (!Array.isArray(files) || !files.length) throw new Error('package has no files');
  if (files.length > maxFiles) throw new Error('package has more than ' + maxFiles + ' files');
  const seen = new Set(); let total = 0;
  const normalized = files.map(file => {
    const path = safePath(file && file.path);
    if (!path) throw new Error('unsafe or unsupported package path: ' + str(file && file.path));
    if (seen.has(path)) throw new Error('duplicate package path: ' + path);
    seen.add(path);
    const bytes = asBuffer(file);
    if (bytes.length > maxFileBytes) throw new Error(path + ' is larger than ' + maxFileBytes + ' bytes');
    total += bytes.length;
    return { path, bytes };
  }).sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  if (!seen.has('SKILL.md')) throw new Error('package is missing SKILL.md');
  if (total > maxPackageBytes) throw new Error('package is larger than ' + maxPackageBytes + ' bytes');
  const h = crypto.createHash('sha256');
  h.update(Buffer.from('Agent OS skill package\0v1\0'));
  for (const file of normalized) {
    const pathBytes = Buffer.from(file.path, 'utf8');
    const lengths = Buffer.alloc(12);
    lengths.writeUInt32BE(pathBytes.length, 0);
    lengths.writeBigUInt64BE(BigInt(file.bytes.length), 4);
    h.update(lengths); h.update(pathBytes); h.update(file.bytes);
  }
  const manifest = normalized.map(file => ({
    path: file.path, encoding: 'base64', content: file.bytes.toString('base64'),
    bytes: file.bytes.length, sha256: sha(file.bytes)
  }));
  return { format: FORMAT, digest: h.digest('hex'), bytes: total, files: manifest };
}
function fromEnvelope(input, opts) {
  const envelope = typeof input === 'string' ? JSON.parse(input) : input;
  if (!envelope || envelope.format !== FORMAT) throw new Error('unsupported skill package format');
  const pkg = canonicalize(envelope.files, opts);
  if (envelope.digest && str(envelope.digest) !== pkg.digest) throw new Error('skill package digest does not match its files');
  pkg.metadata = envelope.metadata && typeof envelope.metadata === 'object' ? JSON.parse(JSON.stringify(envelope.metadata)) : {};
  return pkg;
}
function toEnvelope(pkg, metadata) {
  const checked = fromEnvelope(pkg);
  return JSON.stringify({
    format: FORMAT, digest: checked.digest, bytes: checked.bytes,
    metadata: metadata && typeof metadata === 'object' ? metadata : (checked.metadata || {}), files: checked.files
  }, null, 2) + '\n';
}
function fileBuffer(pkg, path) {
  const checked = fromEnvelope(pkg);
  const file = checked.files.find(f => f.path === path);
  return file ? Buffer.from(file.content, 'base64') : null;
}

module.exports = {
  FORMAT, SUPPORT_DIRS, DEFAULT_MAX_FILES, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_PACKAGE_BYTES,
  safePath, canonicalize, fromEnvelope, toEnvelope, fileBuffer
};
