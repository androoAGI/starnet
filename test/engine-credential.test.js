/* node test/engine-credential.test.js — the station keeps its OWN copy of a key saved in a browser page, and every
   unattended surface says ONE sentence when it has no credential (#89).

   Reported (Linux, 0.13.1): OpenRouter chat works, but a scheduled routine says 'provider "openrouter" has no usable
   credential' / 'connect a OpenRouter API key to run this scheduled routine'. Root cause: in the browser build the
   key lives only in the page's localStorage and rides each /api/run body; a run with no page attached resolves its
   key on the station, which never had it. Locks (pure — the live proof is test/routine-keys.e2e.test.js):
     · the store normalizes the page's config, adopts a change ONLY after persist() proves it (a failed save — and a
       failed REMOVE — leaves the old state live and says so), never loads a malformed record, lists its secrets for
       redaction
     · credentialError(): one sentence per credential shape, naming SETTINGS → AI & MODELS and the env var
     · the night-shift report's no-provider phrase carries the same remedy verbatim
     · the scheduled fire's blocked-config reason is the injected sentence (the same one Run Now says)
     · index.js: an operator env var outranks the page copy; the copy lives under .secrets/ and is redacted. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const EC = require('../sidecar/engine-credential.js');
const NR = require('../frontend/app/nightreport.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');
const recovery = require('../sidecar/station-recovery.js');

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

/* ---------- normalizeInput: the page's config, cleaned ---------- */
A.eq(EC.normalizeInput({ key: '  sk-or-v1-abc\n def​ ' }).record, { key: 'sk-or-v1-abcdef' }, 'a wrapped / zero-width-laced key is cleaned (same as the sidecar cleanProviderKey)');
A.eq(EC.normalizeInput({ key: KEY, keyPool: ['b1', 'b1', ' b2 ', ''] }).record, { key: KEY, keyPool: ['b1', 'b2'] }, 'backup keys are cleaned and deduped');
A.eq(EC.normalizeInput({ baseUrl: 'http://127.0.0.1:1234/v1' }).record, { baseUrl: 'http://127.0.0.1:1234/v1' }, 'a keyless endpoint is a config of its own');
A.eq(EC.normalizeInput({ key: '', keyPool: [], baseUrl: '' }), { ok: true, record: null }, 'an all-empty config is REMOVE');
A.ok(!EC.normalizeInput({ key: KEY, baseUrl: 'file:///etc/passwd' }).ok, 'a non-http(s) base URL is refused');
A.ok(!EC.normalizeInput({ key: 'x'.repeat(5000) }).ok, 'an absurd key is refused');

/* ---------- the store: adopt only what persisted ---------- */
{
  const writes = [];
  let fail = false;
  const store = EC.makeEngineKeys({ load: () => undefined, persist: env => { if (fail) return false; writes.push(JSON.parse(JSON.stringify(env))); return true; } });
  A.eq(store.get('openrouter'), null, 'empty store');
  const r1 = store.put('openrouter', { key: KEY, keyPool: ['alt1'] });
  A.eq(r1, { ok: true, changed: true }, 'a save that persisted is adopted');
  A.eq(store.get('openrouter'), { key: KEY, keyPool: ['alt1'] }, 'the station now holds the page copy');
  A.eq(writes[0], { version: 1, providers: { openrouter: { key: KEY, keyPool: ['alt1'] } } }, 'the envelope written is versioned, one record per provider');
  A.eq(store.put('openrouter', { key: KEY, keyPool: ['alt1'] }), { ok: true, changed: false }, 'the same config again (every page boot) writes nothing');
  A.eq(writes.length, 1, 'an unchanged push is not a disk write');
  A.eq(store.secretValues().sort(), [KEY, 'alt1'].sort(), 'every held key and backup is listed for known-value redaction');

  // THE WRITE-FAILURE PATH (merge-ritual rule 7): a save the disk did not prove is NOT adopted, and says so
  fail = true;
  const r2 = store.put('openrouter', { key: 'sk-or-v1-new' });
  A.eq(r2.ok, false, 'a save whose read-back failed reports ok:false');
  A.eq(store.get('openrouter').key, KEY, 'the unproven key is not adopted: the station keeps running on exactly what is on disk');
  const r3 = store.put('openrouter', { key: '' });
  A.eq(r3.ok, false, 'a REMOVE whose write failed reports ok:false');
  A.eq(store.get('openrouter').key, KEY, 'an unproven removal leaves the old key in place (it would come back after a restart otherwise)');
  const throwing = EC.makeEngineKeys({ load: () => undefined, persist: () => { throw new Error('EACCES'); } });
  A.eq(throwing.put('anthropic', { key: 'sk-ant-x' }).ok, false, 'a persist that throws is a failed save, never a crash');
  A.eq(throwing.get('anthropic'), null, 'and nothing was adopted');

  fail = false;
  A.eq(store.put('openrouter', { key: '' }), { ok: true, changed: true }, 'a proven REMOVE');
  A.eq(store.get('openrouter'), null, 'REMOVE clears the station copy');
  A.eq(writes[writes.length - 1], { version: 1, providers: {} }, 'and the file no longer carries the key');
  A.ok(store.put('Open Router!', { key: KEY }).invalid, 'a malformed provider id is refused before any write');
}
{
  const loaded = EC.makeEngineKeys({ load: () => ({ version: 1, providers: { openrouter: { key: KEY }, custom: { baseUrl: 'javascript:alert(1)' }, 'bad id': { key: 'x' }, anthropic: 'nope' } }) });
  A.eq(loaded.get('openrouter'), { key: KEY }, 'a saved record loads at boot');
  A.eq(loaded.get('custom'), null, 'a record with a bad URL never loads');
  A.eq(loaded.get('anthropic'), null, 'a non-object record never loads');
  A.eq(EC.makeEngineKeys({ load: () => { throw new Error('torn'); } }).get('openrouter'), null, 'an unreadable file loads as nothing saved');
}

/* ---------- credentialError: ONE sentence, real ways out ---------- */
{
  const key = EC.credentialError({ id: 'openrouter', label: 'OpenRouter', kind: 'key', env: 'OPENROUTER_API_KEY', what: 'this scheduled routine' });
  A.eq(key, 'no OpenRouter API key is saved on this station for this scheduled routine — connect or re-save it under SETTINGS → AI & MODELS, or set OPENROUTER_API_KEY in the environment that starts StarNet', 'the key sentence');
  A.ok(!/connect an? .+? api key\b/i.test(key), 'not the interactive "connect a X API key" shape the chat error ladder maps to "no key connected yet"');
  A.ok(/base URL/.test(EC.credentialError({ label: 'Custom', kind: 'baseUrl', baseUrlEnv: 'CUSTOM_OPENAI_BASE_URL' })) && /CUSTOM_OPENAI_BASE_URL/.test(EC.credentialError({ label: 'Custom', kind: 'baseUrl', baseUrlEnv: 'CUSTOM_OPENAI_BASE_URL' })), 'an endpoint provider names its base URL and env var');
  A.ok(/ChatGPT is not signed in/.test(EC.credentialError({ kind: 'codex' })), 'ChatGPT names the sign-in');
  A.ok(/not linked to a StarNet account/.test(EC.credentialError({ kind: 'starnet' })), 'managed credits name the link');
  for (const kind of ['key', 'baseUrl', 'codex', 'oauth', 'starnet', 'other']) A.ok(EC.credentialError({ label: 'X', kind }).indexOf('SETTINGS → AI & MODELS') >= 0, kind + ' names the real settings page');
}

/* ---------- the night-shift report says the provider-less form, verbatim ---------- */
A.ok(NR.bindingPhrase('no-provider').indexOf(EC.UNATTENDED_REMEDY) >= 0, 'nightreport no-provider phrase carries the shared remedy: ' + NR.bindingPhrase('no-provider'));

/* ---------- the scheduled fire's blocked-config reason IS the injected sentence ---------- */
{
  const T0 = 1700000000000;
  let now = T0;
  const job = cronStore.makeJob({ id: 'j1', prompt: 'do j1', agentId: 'agent', schedule: cron.parseSchedule('every 1m', T0) }, { id: 'j1', now: T0 });
  let store = [job];
  const events = [];
  const SENTENCE = 'no OpenRouter API key is saved on this station for this scheduled routine — test';
  const driver = makeCronDriver({
    getJobs: () => store, setJobs: j => { store = j; return true; },
    runOnce: () => Promise.resolve(), emit: (n, p) => events.push({ n, p }), newId: () => 'r1', newAbort: () => new AbortController(), now: () => now,
    getKey: () => '', hasCredential: () => false, credentialError: (provider) => provider === 'openrouter' ? SENTENCE : 'wrong provider',
    defaultModel: 'test/model', persona: 'P', deliverResult: () => ({ ok: true })
  });
  now = T0 + 60000;
  driver.applyTick(now);
  const blocked = cronStore.getJob(store, 'j1');
  A.eq(blocked.blockedConfig && blocked.blockedConfig.reason, SENTENCE, 'the routine row carries the station\'s one sentence');
  A.eq(blocked.lastError, SENTENCE, 'lastError (what ROUTINES shows) is that sentence');
  const bare = makeCronDriver({ getJobs: () => [job], setJobs: () => true, runOnce: () => Promise.resolve(), newId: () => 'r', newAbort: () => new AbortController(), now: () => now, getKey: () => '', hasCredential: () => false, defaultModel: 'm', persona: 'P' });
  A.ok(bare && typeof bare.applyTick === 'function', 'a host that injects no credentialError still builds a driver (the shared builder is its fallback)');
}

/* ---------- index.js wiring ---------- */
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const body = name => { const i = src.indexOf('function ' + name + '('); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };
  A.ok(/return operator \|\| String\(\(engineKeys\.get\(id\) \|\| \{\}\)\.key \|\| ''\);/.test(body('providerRuntimeKey')), 'providerRuntimeKey: explicit > runtime push > operator env > the page copy');
  A.ok(/envFirst\(profile && profile\.baseUrlEnv\) \|\| String\(\(engineKeys\.get\(id\) \|\| \{\}\)\.baseUrl \|\| ''\) \|\| \(profile && profile\.baseUrl\)/.test(body('providerRuntimeBaseUrl')), 'providerRuntimeBaseUrl: operator env > the page endpoint > the profile default');
  A.ok(/!providerOperatorKey\(id\)/.test(body('providerFallbackKeyPool')), 'the page backups ride only while the page key is the one in use');
  A.ok(/const ENGINE_KEYS_FILE = path\.join\(WORKSPACES, '\.secrets', 'provider-keys\.json'\);/.test(src), 'the copy lives in the protected .secrets/ sibling of the fs jail');
  A.ok(/load: \(\) => DESKTOP_SHELL \? undefined :/.test(src) && /if \(DESKTOP_SHELL\) return json\(409/.test(body('handleEngineKeySet')), 'the desktop app (OS keychain) never reads or writes the plaintext copy');
  A.ok(/persist: \(envelope\) => saveCredentialRemovalVerified\(ENGINE_KEYS_FILE, envelope, null, 'engine-keys'\)/.test(src), 'main AND .bak are written and read back (a replaced key never lingers in .bak)');
  A.ok(/\{ values: engineKeys\.secretValues\(\) \}/.test(body('stationSecretValues')), 'the page copy is a known secret for redaction');
  A.ok(/\{ m: 'POST', exact: '\/api\/providers\/engine-key', h: handleEngineKeySet \}/.test(src), 'the route is an ordinary /api/* POST (token + Host + Origin gate)');
  A.ok(!/TOKEN_EXEMPT[^\n]*engine-key/.test(fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'apiauth.js'), 'utf8')), 'and it is NOT token-exempt');
  const h = body('handleEngineKeySet');
  A.ok(!/\.key\b[^\n]*json\(200/.test(h) && /engineKeyPresence\(id\)/.test(h), 'the answer is presence only');
  A.ok(/credentialError: \(provider\) => engineCredentialError\(provider, 'this scheduled routine'\)/.test(src), 'the scheduled fire says the shared sentence');
  A.ok(/return engineCredentialError\(provider, what \|\| 'this routine'\);/.test(body('cronCredentialError')), 'Run Now / quest refresh say the shared sentence');
}

/* ---------- pre-update backups never carry the copy ---------- */
A.eq(recovery._internals.classifyPolicy('.secrets/provider-keys.json').action, 'skip', 'station-recovery skips .secrets/provider-keys.json');
A.eq(recovery._internals.classifyPolicy('.secrets/provider-keys.json.bak').action, 'skip', '…and its .bak');

A.report('engine-credential.test');
