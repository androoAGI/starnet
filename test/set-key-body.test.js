'use strict';
const { readSidecarSource } = require('./helpers/source');
/* node test/set-key-body.test.js — POST /api/key (the desktop shell's provider-config push) never treats a body it could
   not read as an empty key (delta review 10-15).

   handleSetKey swallowed readBody's failure, so an oversized body (or a dropped upload) read as '' — the patch became
   { key: '' }, CLEARED the runtime OpenRouter key, and the shell was told 200. Now an unreadable body is refused before
   any patch is built: 413 with a sentence for a body over the cap, 400 for any other read failure, the key untouched.

   The handler is run from its own source (fnBody) with the REAL bounded body reader and fake config collaborators —
   requiring sidecar/index.js would boot a real sidecar.

   Credential-store lane S2: the answer is the store's, read after the push (engineKeyPresence): configured, and where the
   provider's key now comes from — credentialSource, and envName when an environment variable still serves after a REMOVE,
   which the store also says in one log line. Never a value. The real handler runs over the real store for those rows.
   S4: alternateCount is the push's own answer, the size of the pool the shell pushed. A pool rides only its own layer's
   key now, so that pool may wait unused for a keychain key (a pool pushed first, or the slot the shell keeps after a
   REMOVE); the answer still counts it, and never counts an env KEY_POOL, which is the environment's, not the push's. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { readBody } = require('../sidecar/http-body.js');
const { sandboxStore } = require('./helpers/credential-store-sandbox.js');

const src = readSidecarSource();
const body = A.fnBody(src, 'async function handleSetKey(req, res) {');
A.ok(body.length > 200 && body.length < 6000, 'sidecar/index.js has one bounded handleSetKey');

// the runtime provider config, as the handler sees it through its collaborators
const config = { openrouter: { key: 'sk-or-live', baseUrl: '' } };
const patches = [];
const handleSetKey = new Function('ipcTokenOk', 'readBody', 'setProviderRuntimeConfig', 'engineKeyPresence', body + '\nreturn handleSetKey;')(
  () => true,
  readBody,
  (provider, patch) => { if (provider !== 'openrouter') return ''; patches.push(patch); Object.assign(config.openrouter, patch); return 'openrouter'; },
  id => ({ unattendedReady: !!config[id].key, credentialSource: config[id].key ? 'keychain' : 'none', envName: null })
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

  // ---- review r8 (F6): an endpoint the station could not keep on disk is said — in the answer and in its log ----
  // The REAL setProviderRuntimeConfig behind the REAL handleSetKey; only the disk write of the kept endpoints is faked.
  // (credential-store lane, S1) setProviderRuntimeConfig is index.js's one line over the credential store, and the store is
  // the real one (test/helpers/credential-store-sandbox.js) on a station whose shell pushes its provider config.
  const cfgSrc = A.fnBody(src, 'function setProviderRuntimeConfig(');
  const presSrc = A.fnBody(src, 'function engineKeyPresence(');
  A.ok(/^function engineKeyPresence\(id\) \{ return credStore\.presence\(id\); \}$/.test(presSrc), 'sidecar/index.js has one engineKeyPresence, and it is the store\'s presence');
  const push = async (h, payload) => {
    const req = new EventEmitter(), out = {};
    req.headers = {};
    const res = { headersSent: false, writeHead(code) { out.code = code; this.headersSent = true; }, end(text) { out.body = text; } };
    const done = h(req, res);
    process.nextTick(() => { req.emit('data', Buffer.from(payload)); req.emit('end'); });
    await done;
    return { code: out.code, json: JSON.parse(out.body || 'null') };
  };
  // the REAL handleSetKey over the REAL store: index.js's own one-liners for the push and the presence it answers with
  const realHandler = store => new Function('ipcTokenOk', 'readBody', 'credStore',
    cfgSrc + '\n' + presSrc + '\n' + body + '\nreturn handleSetKey;')(() => true, readBody, store);
  {
    A.ok(/^function setProviderRuntimeConfig\(provider, patch, report\) \{ return credStore\.push\(provider, patch, report\); \}$/.test(cfgSrc), 'sidecar/index.js has one setProviderRuntimeConfig, and it is the store\'s push');
    const warns = [];
    const make = diskOk => realHandler(sandboxStore({ normalizeProviderIdFromRegistry: p => (String(p) === 'anthropic' ? 'anthropic' : ''), getProviderProfile: id => ({ id }),
      SHELL_PUSHES_PROVIDER_CONFIG: true, saveKeptEndpoints: () => diskOk, console: { warn: m => warns.push(String(m)), log() {} } }));
    const lost = await push(make(false), JSON.stringify({ provider: 'anthropic', baseUrl: 'https://gw.example/v1' }));
    A.eq([lost.code, lost.json && lost.json.ok, lost.json && lost.json.endpointPersisted], [200, true, false], 'an endpoint push whose disk write failed answers endpointPersisted:false: ' + JSON.stringify(lost.json));
    A.ok(warns.some(w => /^\[desktop-endpoints\] the anthropic endpoint is in use now but was NOT saved to disk/.test(w)), '...and says so in the log: ' + JSON.stringify(warns));
    warns.length = 0;
    const kept = await push(make(true), JSON.stringify({ provider: 'anthropic', baseUrl: 'https://gw.example/v1' }));
    A.ok(kept.code === 200 && kept.json && !('endpointPersisted' in kept.json) && warns.length === 0, 'a kept endpoint answers as before, and logs nothing: ' + JSON.stringify(kept.json));
    const keyOnly = await push(make(false), JSON.stringify({ provider: 'anthropic', key: 'sk-ant-next' }));
    A.ok(keyOnly.code === 200 && keyOnly.json && !('endpointPersisted' in keyOnly.json), 'a push that moves no endpoint says nothing about one: ' + JSON.stringify(keyOnly.json));
  }

  // ---- S2: the answer says whether the provider can still run, and from which layer, after a REMOVE or a rotation ----
  {
    const KC = 'sk-ant-keychain-key-0123456789', OS = 'sk-ant-os-export-key-0123456789', NEXT = 'sk-ant-rotated-key-0123456789';
    const station = env => {
      const warns = [];
      const first = names => (names || []).find(n => String(env[n] || '').trim()) || '';
      const store = sandboxStore({ runtimeKeys: { anthropic: KC }, envFirst: names => String(env[first(names)] || '').trim(), envFirstName: first,
        providerHasCredential: (id, k) => !!String(k || '').trim(), console: { warn: m => warns.push(String(m)), log() {} } });
      return { h: realHandler(store), warns };
    };
    // a desktop station whose keychain key sits beside the user's own bare export (decision 4)
    const both = station({ ANTHROPIC_API_KEY: OS });
    const removed = await push(both.h, JSON.stringify({ provider: 'anthropic', key: '' }));
    A.eq(removed.json && [removed.code, removed.json.configured, removed.json.credentialSource, removed.json.envName], [200, true, 'environment', 'ANTHROPIC_API_KEY'],
      'a REMOVE that leaves the user\'s env key serving answers configured, from the environment, and names the variable: ' + JSON.stringify(removed.json));
    A.eq(both.warns.length, 1, 'the store says it in one log line');
    A.ok(/ANTHROPIC_API_KEY still holds one/.test(both.warns[0] || '') && /unset it in the environment that starts StarNet/.test(both.warns[0] || ''), '...naming the variable and the exit: ' + both.warns[0]);
    A.ok(![JSON.stringify(removed.json)].concat(both.warns).some(t => t.includes(KC) || t.includes(OS)), 'neither the answer nor the log carries a key');
    // a station with no env key: the REMOVE leaves nothing, and says so
    const alone = station({});
    const gone = await push(alone.h, JSON.stringify({ provider: 'anthropic', key: '' }));
    A.eq(gone.json && [gone.json.configured, gone.json.credentialSource, gone.json.envName], [false, 'none', null], 'a REMOVE with nothing behind it answers configured:false, from nowhere: ' + JSON.stringify(gone.json));
    A.eq(alone.warns.length, 0, '...and logs no environment line');
    const rotated = await push(alone.h, JSON.stringify({ provider: 'anthropic', key: NEXT }));
    A.eq(rotated.json && [rotated.json.configured, rotated.json.credentialSource, rotated.json.envName], [true, 'keychain', null], 'a rotation answers configured, from the keychain: ' + JSON.stringify(rotated.json));
    A.ok(!JSON.stringify(rotated.json).includes(NEXT), '...and never echoes the key');
  }

  // ---- S4: alternateCount is the size of the pool the shell pushed, ridden or not; never the environment's pool ----
  {
    const ready = { providerHasCredential: (id, k) => !!String(k || '').trim() };
    const envPool = k => (k === 'KEY_POOL_ANTHROPIC' ? 'env-pool-1,env-pool-2' : undefined);
    const h = realHandler(sandboxStore(Object.assign({ ENV: envPool }, ready)));
    const pooled = await push(h, JSON.stringify({ provider: 'anthropic', keyPool: ['kc-pool-1', 'kc-pool-2', 'kc-pool-3'] }));
    A.eq(pooled.json && [pooled.json.alternateCount, pooled.json.configured], [3, false], 'S4: a pool pushed before any keychain key answers its size, unused until a key comes: ' + JSON.stringify(pooled.json));
    const keyed = await push(h, JSON.stringify({ provider: 'anthropic', key: 'sk-ant-kc' }));
    A.eq(keyed.json && [keyed.json.alternateCount, keyed.json.configured], [3, true], '...a key push answers the same pool, which the keychain key now rides');
    const removed = await push(h, JSON.stringify({ provider: 'anthropic', key: '' }));
    A.eq(removed.json && [removed.json.alternateCount, removed.json.configured], [3, false], '...a REMOVE leaves the slot the shell keeps, and says the provider cannot run');
    const cleared = await push(h, JSON.stringify({ provider: 'anthropic', keyPool: [] }));
    A.eq(cleared.json && cleared.json.alternateCount, 0, '...and a cleared pool answers 0');
    A.ok(![pooled, keyed, removed, cleared].some(x => /kc-pool|env-pool|sk-ant-kc/.test(JSON.stringify(x.json))), '...never echoing a key or a backup key');
    // the operator's env KEY_POOL is the environment's: it never counts as the push's (trunk counted it when the shell pushed none)
    const env = realHandler(sandboxStore(Object.assign({ ENV: envPool, envFirst: names => ((names || []).includes('ANTHROPIC_API_KEY') ? 'sk-ant-env' : '') }, ready)));
    const own = await push(env, JSON.stringify({ provider: 'anthropic', key: 'sk-ant-kc' }));
    A.eq(own.json && own.json.alternateCount, 0, 'S4: an env KEY_POOL is never counted as the push\'s pool: ' + JSON.stringify(own.json));
  }

  A.report('set-key-body');
})().catch(e => { console.error(e); process.exit(1); });
