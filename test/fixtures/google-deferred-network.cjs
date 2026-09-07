'use strict';
const fs = require('node:fs');
const path = require('node:path');
const original = globalThis.fetch;
globalThis.fetch = (raw, options) => {
  if (/(googleapis\.com|accounts\.google\.com)/.test(String(raw))) {
    fs.writeFileSync(path.join(process.env.STARNET_WORKSPACES || process.env.SKYNET_WORKSPACES, 'google-network-attempt'), 'blocked fixture call');
    throw new Error('Deferred Google connector attempted a network request');
  }
  return original(raw, options);
};
