'use strict';
const { readSidecarSource } = require('./helpers/source');
/* node test/set-key-body.test.js — POST /api/key (the desktop shell's provider-config push) never treats a body it could
   not read as an empty key (delta review 10-15).

   handleSetKey swallowed readBody's failure, so an oversized body (or a dropped upload) read as '' — the patch became
   { key: '' }, CLEARED the runtime OpenRouter key, and the shell was told 200. Now an unreadable body is refused before
   any patch is built: 413 with a sentence for a body over the cap, 400 for any other read failure, the key untouched.

   The handler is run from its own source (fnBody) with the REAL bounded body reader and fake config collaborators —
   requiring sidecar/index.js would boot a real sidecar. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { readBody } = require('../sidecar/http-body.js');

const src = readSidecarSource();
const body = A.fnBody(src, 'async function handleSetKey(req, res) {');
A.ok(body.length > 200 && body.length < 6000, 'sidecar/index.js has one bounded handleSetKey');

// the runtime provider config, as the handler sees it through its collaborators
const config = { openrouter: { key: 'sk-or-live', baseUrl: '' } };
const patches = [];
const handleSetKey = new Function('ipcTokenOk', 'readBody', 'setProviderRuntimeConfig', 'providerRuntimeKey', 'providerRuntimeBaseUrl',
  'providerHasCredential', 'providerRuntimeKeyPool', body + '\nreturn handleSetKey;')(
  () => true,
  readBody,
  (provider, patch) => { if (provider !== 'openrouter') return ''; patches.push(patch); Object.assign(config.openrouter, patch); return 'openrouter'; },
  id => config[id].key,
  id => config[id].baseUrl,
  (id, key) => !!key,
  () => []
);

(async () => {
  const server = http.createServer((req, res) => { handleSetKey(req, res).catch(e => { res.writeHead(500); res.end(String(e && e.message)); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/key';
  const post = async payload => { const r = await fetch(url, { method: 'POST', body: payload }); return { status: r.status, json: await r.json().catch(() => null) }; };
  try {
    // ---- an oversized body: refused, worded, and the key is still the one the Commander saved ----
    for (const size of [70 * 1024, 2 << 20]) {
      const r = await post(JSON.stringify({ provider: 'openrouter', key: 'sk-or-' + 'x'.repeat(size) }));
      A.eq(r.status, 413, 'a ' + size + '-byte config push is answered 413, never 200');
      A.ok(r.json && /too large to save/.test(r.json.error) && /nothing was changed/.test(r.json.error), 'the 413 says what happened in a sentence: ' + JSON.stringify(r.json));
    }
    A.eq(patches.length, 0, 'an oversized body builds no patch at all');
    A.eq(config.openrouter.key, 'sk-or-live', 'the runtime OpenRouter key survives an oversized push (it was cleared to "")');

    // ---- the same route still saves a normal push ----
    const ok = await post(JSON.stringify({ provider: 'openrouter', key: 'sk-or-next' }));
    A.eq(ok.status, 200, 'a normal config push is still saved');
    A.eq(ok.json && ok.json.configured, true, 'and reports the provider configured');
    A.eq(config.openrouter.key, 'sk-or-next', 'the new key is in use');
    A.ok(!JSON.stringify(ok.json).includes('sk-or-next'), 'the answer never echoes the key');
  } finally {
    server.closeAllConnections && server.closeAllConnections();
    await new Promise(r => server.close(r));
  }

  // ---- a body that fails to arrive (the upload is cut) is a 400, never an empty key ----
  {
    const before = patches.length, req = new EventEmitter(), out = {};
    req.headers = {};
    const res = { headersSent: false, writeHead(code) { out.code = code; this.headersSent = true; }, end(text) { out.body = text; } };
    const done = handleSetKey(req, res);
    process.nextTick(() => { req.emit('data', Buffer.from('{"provider":"openrouter","key":"sk-or-')); req.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' })); });
    await done;
    A.eq(out.code, 400, 'a cut upload is answered 400');
    A.ok(/could not be read/.test(JSON.parse(out.body).error) && /nothing was changed/.test(JSON.parse(out.body).error), 'and says nothing was changed: ' + out.body);
    A.eq(patches.length, before, 'a cut upload builds no patch');
    A.eq(config.openrouter.key, 'sk-or-next', 'and the key in use stays');
  }

  A.report('set-key-body');
})().catch(e => { console.error(e); process.exit(1); });
