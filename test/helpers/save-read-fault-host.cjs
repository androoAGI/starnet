'use strict';
// Test-only host: fail reads of an exact save path while retaining the real bytes on disk.
const fs = require('node:fs');
const path = require('node:path');
const read = fs.readFileSync.bind(fs);
const root = process.env.SKYNET_WORKSPACES;
const control = path.join(root, 'save-read-fault.json');
fs.readFileSync = function (file, ...args) {
  let fault;
  try { fault = JSON.parse(read(control, 'utf8')); } catch (_) {}
  if (fault && path.resolve(String(file)) === path.join(root, fault.file)) {
    const error = new Error('Injected temporary save read failure');
    error.code = 'EACCES';
    throw error;
  }
  return read(file, ...args);
};
require('../../sidecar/index.js');
