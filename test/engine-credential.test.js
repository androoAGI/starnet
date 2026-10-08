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
const vm = require('vm');
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
  let fail = false, disk = null, revs = 0;
  // `disk` is what the files hold: persist() lands there; verify() compares against it (a deleted file = null)
  const store = EC.makeEngineKeys({
    load: () => undefined, newRev: () => 'r' + (++revs),
    persist: env => { writes.push(JSON.parse(JSON.stringify(env))); if (fail) return false; disk = JSON.stringify(env); return true; },
    verify: env => disk === JSON.stringify(env)
  });
  A.eq(store.get('openrouter'), null, 'empty store');
  A.eq(store.revOf('openrouter'), '', 'no revision for a provider the station holds nothing for');
  const r1 = store.put('openrouter', { key: KEY, keyPool: ['alt1'] });
  A.eq(r1, { ok: true, changed: true, applied: true }, 'a save that persisted is adopted');
  A.eq(store.get('openrouter'), { key: KEY, keyPool: ['alt1'] }, 'the station now holds the page copy');
  A.eq(store.revOf('openrouter'), 'r1', 'each adopted change gets a new revision');
  A.eq(writes[0], { version: 1, providers: { openrouter: { key: KEY, keyPool: ['alt1'], rev: 'r1' } } }, 'the envelope written is versioned, one record per provider');
  A.eq(store.put('openrouter', { key: KEY, keyPool: ['alt1'] }), { ok: true, changed: false, applied: true }, 'the same config again (every page boot) writes nothing');
  A.eq(writes.length, 1, 'an unchanged push is not a disk write while the disk still holds it');
  A.eq(store.revOf('openrouter'), 'r1', 'and keeps its revision');
  A.eq(store.secretValues().sort(), [KEY, 'alt1'].sort(), 'every held key and backup is listed for known-value redaction');

  // an unchanged push re-proves the disk: a file deleted behind the station's back is rewritten, not answered "saved"
  disk = null;
  A.eq(store.put('openrouter', { key: KEY, keyPool: ['alt1'] }), { ok: true, changed: false, applied: true }, 'an unchanged push over a lost file still succeeds…');
  A.eq(writes.length, 2, '…because it rewrote the file');
  A.eq(disk, JSON.stringify(writes[0]), 'with exactly what the station runs on');
  disk = null; fail = true;
  const lost = store.put('openrouter', { key: KEY, keyPool: ['alt1'] });
  A.ok(lost.ok === false && lost.error === 'persist', 'an unchanged push over a lost file that cannot be rewritten is a failure, never "saved"');
  fail = false; store.put('openrouter', { key: KEY, keyPool: ['alt1'] });

  // THE WRITE-FAILURE PATH (merge-ritual rule 7): a save the disk did not prove is NOT adopted, and says so
  fail = true;
  const before = writes.length;
  const r2 = store.put('openrouter', { key: 'sk-or-v1-new' });
  A.ok(r2.ok === false && r2.removing === false, 'a save whose read-back failed reports ok:false (and that it was a save)');
  A.eq(store.get('openrouter').key, KEY, 'the unproven key is not adopted: the station keeps running on exactly what is on disk');
  A.eq(writes.length - before, 2, 'a failed write is followed by one put-it-back write…');
  A.eq(writes[writes.length - 1].providers.openrouter.key, KEY, '…of what the station still runs on (a half-landed write must not load next boot)');
  const r3 = store.put('openrouter', { key: '' });
  A.ok(r3.ok === false && r3.removing === true && r3.held === true, 'a REMOVE whose write failed reports ok:false, that it was a removal, and that the station still holds the copy (the route words it differently)');
  A.eq(store.get('openrouter').key, KEY, 'an unproven removal leaves the old key in place (it would come back after a restart otherwise)');
  const throwing = EC.makeEngineKeys({ load: () => undefined, persist: () => { throw new Error('EACCES'); } });
  A.eq(throwing.put('anthropic', { key: 'sk-ant-x' }).ok, false, 'a persist that throws is a failed save, never a crash');
  A.eq(throwing.get('anthropic'), null, 'and nothing was adopted');
  const nothingHeld = throwing.put('anthropic', { key: '' });
  A.ok(nothingHeld.ok === false && nothingHeld.removing === true && nothingHeld.held === false, 'a failed REMOVE of a provider the station holds nothing for says so (no copy is in use)');

  fail = false;
  A.eq(store.put('openrouter', { key: '' }), { ok: true, changed: true, applied: true }, 'a proven REMOVE');
  A.eq(store.get('openrouter'), null, 'REMOVE clears the station copy');
  const tomb = writes[writes.length - 1].providers.openrouter;
  A.ok(tomb && tomb.removed === true && !tomb.key && !tomb.keyPool && /^r\d+$/.test(tomb.rev), 'the file keeps only a key-less tombstone: ' + JSON.stringify(tomb));
  A.eq(store.secretValues(), [], 'a tombstone is no secret');
  A.eq(store.put('openrouter', { key: '' }), { ok: true, changed: false, applied: true }, 'a second REMOVE changes nothing');
  A.ok(store.put('Open Router!', { key: KEY }).invalid, 'a malformed provider id is refused before any write');
}

/* ---------- a page BOOT never puts back what another page rotated or removed ---------- */
{
  let revs = 0;
  const store = EC.makeEngineKeys({ load: () => undefined, persist: () => true, newRev: () => 'b' + (++revs) });
  const OLD = 'sk-or-v1-old-page-key', NEW = 'sk-or-v1-rotated-key';
  // first boot after the upgrade: the station holds nothing, so the first page to boot hands its key over
  A.eq(store.put('openrouter', { key: OLD }, { boot: true, ifRev: '' }), { ok: true, changed: true, applied: true }, 'a boot hand-over fills an empty station');
  const seen = store.revOf('openrouter');
  // a second origin (127.0.0.1 vs localhost — separate localStorage) boots holding a different key it never saved here
  A.eq(store.put('openrouter', { key: 'sk-or-v1-other-origin' }, { boot: true, ifRev: '' }), { ok: true, changed: false, applied: false, stale: true }, 'another page\'s boot cannot replace a key it never saw');
  A.eq(store.get('openrouter').key, OLD, 'the station keeps the first page\'s key');
  // the Commander rotates the key in page B (explicit save = last write wins)
  A.eq(store.put('openrouter', { key: NEW }).applied, true, 'an explicit save always applies');
  // page A (still holding OLD, last saw `seen`) boots again: OLD must not come back
  A.eq(store.put('openrouter', { key: OLD }, { boot: true, ifRev: seen }).stale, true, 'a boot from the page that last saw an older revision is stale');
  A.eq(store.get('openrouter').key, NEW, 'THE ROTATED KEY SURVIVES the older page\'s boot');
  // the page that made the change retries it at boot (its last save failed): it still holds the current revision
  const cur = store.revOf('openrouter');
  A.eq(store.put('openrouter', { key: NEW, keyPool: ['spare'] }, { boot: true, ifRev: cur }).changed, true, 'a boot retry from the page that holds the current revision applies');
  // REMOVE in one page; another page that still holds the key boots: the removal stands
  store.put('openrouter', { key: '' });
  A.eq(store.put('openrouter', { key: NEW }, { boot: true, ifRev: cur }).stale, true, 'a boot cannot resurrect a key removed since (the tombstone has a newer revision)');
  A.eq(store.get('openrouter'), null, 'the removal stands');
  // a pending REMOVE retried at boot by the page that removed it applies; one superseded by a newer save does not
  store.put('anthropic', { key: 'sk-ant-1' });
  const a1 = store.revOf('anthropic');
  A.eq(store.put('anthropic', { key: '' }, { boot: true, ifRev: a1 }).changed, true, 'the page\'s failed REMOVE, retried at boot, applies');
  A.eq(store.get('anthropic'), null, 'and the key is gone');
  store.put('mistral', { key: 'sk-m-1' });
  const m1 = store.revOf('mistral');
  store.put('mistral', { key: 'sk-m-2' });   // another page saved a new key after this page's REMOVE failed
  A.eq(store.put('mistral', { key: '' }, { boot: true, ifRev: m1 }).stale, true, 'a pending REMOVE never deletes a key saved after it');
  A.eq(store.get('mistral').key, 'sk-m-2', 'the newer key stays');
}
{
  const loaded = EC.makeEngineKeys({ load: () => ({ version: 1, providers: { openrouter: { key: KEY }, groq: { key: 'gsk-x', rev: 'abc123' }, xai: { rev: 'd1', removed: true }, custom: { baseUrl: 'javascript:alert(1)' }, 'bad id': { key: 'x' }, anthropic: 'nope' } }) });
  A.eq(loaded.get('openrouter'), { key: KEY }, 'a saved record loads at boot');
  A.eq(loaded.revOf('openrouter'), '0', 'a record with no revision loads as rev 0 (no page holds it, so no boot push matches it)');
  A.eq(loaded.revOf('groq'), 'abc123', 'a revision round-trips');
  A.ok(loaded.get('xai') === null && loaded.revOf('xai') === 'd1', 'a tombstone loads as "nothing saved", with its revision');
  A.eq(loaded.get('custom'), null, 'a record with a bad URL never loads');
  A.eq(loaded.get('anthropic'), null, 'a non-object record never loads');
  A.eq(EC.makeEngineKeys({ load: () => { throw new Error('torn'); } }).get('openrouter'), null, 'an unreadable file loads as nothing saved');
}
A.ok(!EC.normalizeInput({ key: KEY, baseUrl: 'https://user:tok@proxy.example/v1' }).ok, 'a base URL carrying a user name / password is refused (it would be answered back as an endpoint)');
A.ok(EC.normalizeInput({ key: KEY, baseUrl: 'https://proxy.example/v1' }).ok, 'a plain endpoint is fine');

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

/* ---------- the page copy is ONE credential: its endpoint + backups ride only its own key (index.js, executed) ---------- */
{
  const raw = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  const fn = name => { const i = raw.indexOf('\nfunction ' + name + '('); A.ok(i >= 0, 'index.js has ' + name); return i < 0 ? '' : raw.slice(i, raw.indexOf('\n}\n', i) + 3); };
  const code = ['providerRuntimeKey', 'providerOperatorKey', 'providerRuntimeKeyPool', 'providerFallbackKeyPool', 'pageCopyRidesWith', 'providerRuntimeBaseUrl'].map(fn).join('\n');
  const PROFILES = {
    custom: { keyEnv: ['CUSTOM_OPENAI_API_KEY'], baseUrlEnv: ['CUSTOM_OPENAI_BASE_URL'], baseUrl: '' },
    openrouter: { keyEnv: ['OPENROUTER_API_KEY'], baseUrlEnv: [], baseUrl: 'https://openrouter.ai/api/v1' }
  };
  function resolvers(o) {
    const env = o.env || {};
    const scope = {
      String, Array, Set, Object,
      runtimeKeys: {}, runtimeKeyPools: {}, runtimeBaseUrls: {}, runtimeKey: '',
      engineKeys: EC.makeEngineKeys({ load: () => ({ version: 1, providers: o.page || {} }) }),
      normalizeProvider: p => String(p || 'openrouter'), registryProviderUsesCodex: () => false, resolveCreditsConfig: () => ({}),
      getProviderProfile: id => PROFILES[id] || null,
      envFirst: names => { for (const n of (names || [])) if (env[n]) return env[n]; return ''; },
      ENV: () => ''
    };
    return vm.runInNewContext(code + '\n({ providerRuntimeKey, providerRuntimeKeyPool, providerRuntimeBaseUrl })', scope);
  }
  const KP = 'sk-page-key', KX = 'sk-other-page-key', KE = 'sk-operator-env-key';
  const UP = 'https://page-endpoint.example/v1', UE = 'https://operator-endpoint.example/v1', UL = 'http://127.0.0.1:1234/v1';
  // the page copy with an endpoint + backups; the operator set only a base URL
  {
    const r = resolvers({ page: { custom: { key: KP, keyPool: ['spare-1'], baseUrl: UP, rev: 'a1' } }, env: { CUSTOM_OPENAI_BASE_URL: UE } });
    A.eq(r.providerRuntimeKey('custom', ''), KP, 'an unattended run uses the page key');
    A.eq(r.providerRuntimeBaseUrl('custom', ''), UP, 'and sends it to the endpoint it was saved with, not the operator\'s URL');
    A.eq(r.providerRuntimeKeyPool('custom'), ['spare-1'], 'with its own backups');
    // an interactive run from ANOTHER page (its own per-run key, no backups of its own, no endpoint in the body)
    A.eq(r.providerRuntimeKeyPool('custom', undefined, KX), [], 'another page\'s key never rotates onto this page copy\'s backup keys');
    A.eq(r.providerRuntimeBaseUrl('custom', '', KX), UE, 'nor is it sent to this page copy\'s endpoint');
    A.eq(r.providerRuntimeKeyPool('custom', undefined, KP), ['spare-1'], 'a run on the page key itself keeps its backups');
    A.eq(r.providerRuntimeBaseUrl('custom', '', KP), UP, 'and its endpoint');
    A.eq(r.providerRuntimeBaseUrl('custom', 'https://explicit.example/v1', KX), 'https://explicit.example/v1', 'an explicit per-run endpoint still wins');
  }
  // the operator's env KEY outranks the page copy — and never rides the page copy's endpoint or backups
  {
    const r = resolvers({ page: { custom: { key: KP, keyPool: ['spare-1'], baseUrl: UP, rev: 'a1' } }, env: { CUSTOM_OPENAI_API_KEY: KE } });
    A.eq(r.providerRuntimeKey('custom', ''), KE, 'the env key wins');
    A.eq(r.providerRuntimeBaseUrl('custom', ''), '', 'the env key is never sent to the page copy\'s endpoint (no env URL = none)');
    A.eq(r.providerRuntimeKeyPool('custom'), [], 'nor rotated onto the page copy\'s backups');
  }
  // a keyless page endpoint (a local server): under the operator's URL, over the profile default — never for an env key
  {
    A.eq(resolvers({ page: { custom: { baseUrl: UL, rev: 'a1' } } }).providerRuntimeBaseUrl('custom', ''), UL, 'a keyless page endpoint is used');
    A.eq(resolvers({ page: { custom: { baseUrl: UL, rev: 'a1' } }, env: { CUSTOM_OPENAI_BASE_URL: UE } }).providerRuntimeBaseUrl('custom', ''), UE, 'the operator\'s URL outranks a keyless page endpoint');
    A.eq(resolvers({ page: { custom: { baseUrl: UL, rev: 'a1' } }, env: { CUSTOM_OPENAI_API_KEY: KE } }).providerRuntimeBaseUrl('custom', ''), '', 'an env key never goes to a keyless page endpoint');
  }
  // a page key with no endpoint of its own follows the same order chat does (operator URL > profile default)
  A.eq(resolvers({ page: { openrouter: { key: KP, rev: 'a1' } } }).providerRuntimeBaseUrl('openrouter', ''), 'https://openrouter.ai/api/v1', 'no page endpoint = the profile default');
}

/* ---------- index.js wiring ---------- */
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const body = name => { const i = src.indexOf('function ' + name + '('); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };
  A.ok(/return operator \|\| String\(\(engineKeys\.get\(id\) \|\| \{\}\)\.key \|\| ''\);/.test(body('providerRuntimeKey')), 'providerRuntimeKey: explicit > runtime push > operator env > the page copy');
  A.ok(/const runKey = providerRuntimeKey\(providerId, key\);\s*const baseUrl = providerRuntimeBaseUrl\(providerId, o\.baseUrl \|\| o\.base_url \|\| '', runKey\);/.test(src), 'the run path resolves its endpoint for ITS key (a page copy\'s endpoint rides only the page key)');
  A.ok(/providerRuntimeKeyPool\(providerId, Array\.isArray\(o\.keyPool\) \? o\.keyPool : undefined, runKey\)/.test(src), 'and its backup keys for ITS key');
  A.ok(/const ENGINE_KEYS_FILE = path\.join\(WORKSPACES, '\.secrets', 'provider-keys\.json'\);/.test(src), 'the copy lives in the protected .secrets/ sibling of the fs jail');
  A.ok(/load: \(\) => DESKTOP_SHELL \? undefined :/.test(src) && /if \(DESKTOP_SHELL\) return json\(409/.test(body('handleEngineKeySet')), 'the desktop app (OS keychain) never reads or writes the plaintext copy');
  A.ok(/persist: \(envelope\) => saveCredentialRemovalVerified\(ENGINE_KEYS_FILE, envelope, null, 'engine-keys'\)/.test(src), 'main AND .bak are written and read back (a replaced key never lingers in .bak)');
  A.ok(/\{ values: engineKeys\.secretValues\(\) \}/.test(body('stationSecretValues')), 'the page copy is a known secret for redaction');
  A.ok(/\{ m: 'POST', exact: '\/api\/providers\/engine-key', h: handleEngineKeySet \}/.test(src), 'the route is an ordinary /api/* POST (token + Host + Origin gate)');
  A.ok(!/TOKEN_EXEMPT[^\n]*engine-key/.test(fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'apiauth.js'), 'utf8')), 'and it is NOT token-exempt');
  const h = body('handleEngineKeySet');
  A.ok(!/\.key\b[^\n]*json\(200/.test(h) && /engineKeyPresence\(id\)/.test(h), 'the answer is presence only');
  A.ok(/\{ boot: body\.boot === true, ifRev: typeof body\.ifRev === 'string' \? body\.ifRev : '' \}/.test(h), 'a page boot hand-over is marked, with the revision that page last saw');
  A.ok(/r\.held \? 'the station could not delete its copy of this ' \+ label \+ ' connection \(its log has the reason\) — routines and other unattended runs will KEEP using it until a retry succeeds'/.test(h), 'a failed REMOVE says the station keeps using its copy (never "chat still works")');
  A.ok(/if \(r\.stale\) return json\(200, Object\.assign\(\{ ok: true, provider: id, applied: false, stale: true, changed: false \}, engineKeyPresence\(id\)\)\);/.test(h), 'a stale boot hand-over is answered without the current revision');
  A.ok(/verify: \(envelope\) => \{[\s\S]{0,200}\[ENGINE_KEYS_FILE, ENGINE_KEYS_FILE \+ '\.bak'\]\.every/.test(src), 'an unchanged push re-checks both copies on disk');
  A.ok(/credentialError: \(provider\) => engineCredentialError\(provider, 'this scheduled routine'\)/.test(src), 'the scheduled fire says the shared sentence');
  A.ok(/return engineCredentialError\(provider, what \|\| 'this routine'\);/.test(body('cronCredentialError')), 'Run Now / quest refresh say the shared sentence');
}

/* ---------- pre-update backups never carry the copy ---------- */
A.eq(recovery._internals.classifyPolicy('.secrets/provider-keys.json').action, 'skip', 'station-recovery skips .secrets/provider-keys.json');
A.eq(recovery._internals.classifyPolicy('.secrets/provider-keys.json.bak').action, 'skip', '…and its .bak');

A.report('engine-credential.test');
