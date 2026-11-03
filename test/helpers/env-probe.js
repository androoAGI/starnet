'use strict';
/* test/helpers/env-probe.js — what a booted sidecar's own process.env holds, for a test that must prove a key is NOT there.
   Loaded only through NODE_OPTIONS (--require) by test/credential-store.remove-rotate.e2e.test.js, like
   test/_skill_exchange_fetch_fixture.js for skill-exchange.http.

   The test hands it SHA-256 digests of the keys it cares about (STARNET_TEST_ENV_PROBE_SHA256, comma-separated) and a file
   (STARNET_TEST_ENV_PROBE_OUT). Right after the sidecar's own synchronous boot (index.js has run its top, so the desktop
   shell's keys have been adopted by then) and then every 100 ms, it writes the names of the environment variables whose
   trimmed value has one of those digests, and every STARNET_/SKYNET_ name present. Never a value. Only the sidecar entry
   point writes: a helper process that inherits NODE_OPTIONS loads this file and does nothing. */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const out = String(process.env.STARNET_TEST_ENV_PROBE_OUT || '');
const wanted = new Set(String(process.env.STARNET_TEST_ENV_PROBE_SHA256 || '').split(',').map(s => s.trim()).filter(Boolean));
const entry = String(process.argv[1] || '').split(path.sep).join('/');

if (out && /\/sidecar\/index\.js$/.test(entry)) {
  const digest = v => crypto.createHash('sha256').update(String(v).trim(), 'utf8').digest('hex');
  const write = () => {
    const holders = {};
    for (const name of Object.keys(process.env)) {
      const d = digest(process.env[name]);
      if (wanted.has(d)) (holders[d] = holders[d] || []).push(name);
    }
    for (const d of Object.keys(holders)) holders[d].sort();
    const branded = Object.keys(process.env).filter(n => /^(?:STARNET|SKYNET)_/i.test(n)).sort();
    const tmp = out + '.' + process.pid + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), pid: process.pid, holders, branded })); fs.renameSync(tmp, out); }
    catch (e) { process.stderr.write('[env-probe] could not write ' + out + ': ' + ((e && e.message) || e) + '\n'); }
  };
  setImmediate(write);
  const timer = setInterval(write, 100);
  if (timer.unref) timer.unref();
}
