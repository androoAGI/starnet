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
     · index.js: an operator env var outranks the page copy; the copy lives under .secrets/ and is redacted.
     · (credential-store lane, S7) CUSTOM needs a base URL, so an env key with none hides nothing: the page copy's whole pair
       runs, the env key never reaches the page copy's endpoint or backups, and a refusal says what is really missing.
   The resolution itself lives in sidecar/credential-store.js (credential-store lane, S1): the sections below run index.js's
   own one-line providerRuntimeKey / providerRuntimeKeyPool / providerRuntimeBaseUrl over a REAL store built from the same
   stubs (test/helpers/credential-store-sandbox.js), so every assertion is the one it was. */
'use strict';
const { readSidecarSource, sidecarFunctionSource, sidecarSourceFiles, functionSourceIn } = require('./helpers/source');
const { installStore } = require('./helpers/credential-store-sandbox.js');
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
  for (const kind of ['key', 'baseUrl', 'codex', 'oauth', 'starnet', 'unpaired', 'other']) A.ok(EC.credentialError({ label: 'X', kind }).indexOf('SETTINGS → AI & MODELS') >= 0, kind + ' names the real settings page');
  // (credential-store lane, S7, decision 5) an env key with no endpoint: never "no base URL is saved" beside one that is
  const P3C = { id: 'custom', label: 'CUSTOM', kind: 'unpaired', env: 'CUSTOM_OPENAI_KEY', baseUrlEnv: 'CUSTOM_OPENAI_BASE_URL', what: 'this routine', keylessUrl: true };
  A.eq(EC.credentialError(P3C), 'CUSTOM_OPENAI_KEY is set in the environment that starts StarNet, but no CUSTOM base URL goes with it: the URL saved under SETTINGS → AI & MODELS was saved without a key, and an environment key is never sent to a URL saved in the page. Save the key next to that URL in Settings, or set CUSTOM_OPENAI_BASE_URL.',
    'P3c: the sentence names the env key as the half with no endpoint, why the saved URL is not its to use, and both exits (decision 5, word for word)');
  A.eq(EC.credentialError(Object.assign({}, P3C, { keylessUrl: false })), 'CUSTOM_OPENAI_KEY is set in the environment that starts StarNet, but no CUSTOM base URL goes with it: set CUSTOM_OPENAI_BASE_URL, or save the key next to the URL under SETTINGS → AI & MODELS',
    'no URL saved anywhere: the same head and both exits, never "set it under Settings" alone, which would lead to the state above');
  A.ok(!/undefined/.test(EC.credentialError({ label: 'X', kind: 'unpaired', env: 'X_KEY' })) && !/undefined/.test(EC.credentialError({ label: 'X', kind: 'unpaired', env: 'X_KEY', keylessUrl: true })),
    'a provider with no URL variable names only the exit it has');
  A.eq(EC.unpairedExits({ baseUrlEnv: 'CUSTOM_OPENAI_BASE_URL' }), 'set CUSTOM_OPENAI_BASE_URL, or save the key next to the URL under SETTINGS → AI & MODELS', 'the exits, for a surface that words its own refusal');
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
  const raw = readSidecarSource();
  const fn = name => { const s = sidecarFunctionSource(name); A.ok(s.length > 20, 'index.js has ' + name); return s; };
  const code = ['providerRuntimeKey', 'providerRuntimeKeyPool', 'providerRuntimeBaseUrl'].map(fn).join('\n');
  const PROFILES = {
    custom: { keyEnv: ['CUSTOM_OPENAI_API_KEY'], baseUrlEnv: ['CUSTOM_OPENAI_BASE_URL'], baseUrl: '', requiresBaseUrl: true },
    openrouter: { keyEnv: ['OPENROUTER_API_KEY'], baseUrlEnv: [], baseUrl: 'https://openrouter.ai/api/v1' }
  };
  function resolvers(o) {
    const env = o.env || {};
    const scope = {
      String, Array, Set, Object,
      runtimeKeys: Object.assign({}, o.runtime), runtimeKeyPools: {}, runtimeBaseUrls: Object.assign({}, o.runtimeBase), runtimeKey: '',
      engineKeys: EC.makeEngineKeys({ load: () => ({ version: 1, providers: o.page || {} }) }),
      normalizeProvider: p => String(p || 'openrouter'), registryProviderUsesCodex: () => false, resolveCreditsConfig: () => ({}),
      getProviderProfile: id => PROFILES[id] || null,
      envFirst: names => { for (const n of (names || [])) if (env[n]) return env[n]; return ''; },
      ENV: () => ''
    };
    installStore(scope);   // the credStore index.js's one-liners ask, over these same stubs
    return vm.runInNewContext(code + '\n({ providerRuntimeKey, providerRuntimeKeyPool, providerRuntimeBaseUrl, credStore })', scope);
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
    A.eq(r.providerRuntimeBaseUrl('custom', 'https://explicit.example/v1', KX, KX), 'https://explicit.example/v1', 'an explicit per-run endpoint still wins with the caller\'s own key');
  }
  // the operator's env KEY outranks the page copy while it can run — and never rides the page copy's endpoint or backups
  {
    const r = resolvers({ page: { custom: { key: KP, keyPool: ['spare-1'], baseUrl: UP, rev: 'a1' } }, env: { CUSTOM_OPENAI_API_KEY: KE, CUSTOM_OPENAI_BASE_URL: UE } });
    A.eq(r.providerRuntimeKey('custom', ''), KE, 'the env key with an endpoint wins');
    A.eq(r.providerRuntimeBaseUrl('custom', ''), UE, 'at the operator\'s URL');
    A.eq(r.providerRuntimeKeyPool('custom'), [], 'never rotated onto the page copy\'s backups');
  }
  // (credential-store lane, S7, golden delta D3, probe P3b) CUSTOM needs a base URL: with none for the env key, the station's own
  // choice is the page copy's WHOLE pair, so a gate and the run it admits agree. The env key itself never moves to that endpoint.
  {
    const r = resolvers({ page: { custom: { key: KP, keyPool: ['spare-1'], baseUrl: UP, rev: 'a1' } }, env: { CUSTOM_OPENAI_API_KEY: KE } });
    A.eq([r.providerRuntimeKey('custom', ''), r.providerRuntimeBaseUrl('custom', ''), r.providerRuntimeKeyPool('custom')], [KP, UP, ['spare-1']], 'P3b: the page copy\'s key, its endpoint and its backups, whole');
    A.eq(r.providerRuntimeBaseUrl('custom', '', KE), '', 'the env key handed back as the run key is never sent to the page copy\'s endpoint');
    A.eq(r.providerRuntimeBaseUrl('custom', '', undefined, KE), '', '...nor as the caller\'s key with no run key (a hub\'s secrets(), the fallback loop, the catalog)');
    A.eq(r.providerRuntimeBaseUrl('custom', '', undefined, KX), '', '...nor a key no layer holds: at trunk this shape read the page copy against the STATION\'s key');
    A.eq(r.providerRuntimeKey('custom', KE), KE, 'an explicit key is never swapped, even for a pair that could run');
    A.eq(r.providerRuntimeKeyPool('custom', undefined, KE), [], 'and the env key never rotates onto the page copy\'s backups');
  }
  // a keyless page endpoint (a local server): under the operator's URL, over the profile default — never for an env key
  {
    A.eq(resolvers({ page: { custom: { baseUrl: UL, rev: 'a1' } } }).providerRuntimeBaseUrl('custom', ''), UL, 'a keyless page endpoint is used');
    A.eq(resolvers({ page: { custom: { baseUrl: UL, rev: 'a1' } }, env: { CUSTOM_OPENAI_BASE_URL: UE } }).providerRuntimeBaseUrl('custom', ''), UE, 'the operator\'s URL outranks a keyless page endpoint');
    A.eq(resolvers({ page: { custom: { baseUrl: UL, rev: 'a1' } }, env: { CUSTOM_OPENAI_API_KEY: KE } }).providerRuntimeBaseUrl('custom', ''), '', 'an env key never goes to a keyless page endpoint');
    A.eq(resolvers({ page: { custom: { baseUrl: UL, rev: 'a1' } }, env: { CUSTOM_OPENAI_API_KEY: KE } }).providerRuntimeKey('custom', ''), KE, 'and a keyless page endpoint replaces no key (S7, D4): the env key stays the choice, refused');
  }
  // a page key with no endpoint of its own follows the same order chat does (operator URL > profile default)
  A.eq(resolvers({ page: { openrouter: { key: KP, rev: 'a1' } } }).providerRuntimeBaseUrl('openrouter', ''), 'https://openrouter.ai/api/v1', 'no page endpoint = the profile default');
  // (review r3) handleRun resolves the run's endpoint for the run's OWN key: a body key that is not the page copy's
  // (another page, a script) never rides the page copy's saved endpoint. handleRun's own key and endpoint lines, executed
  // in the order they are written, over the real resolvers.
  {
    const at = raw.indexOf('\nasync function handleRun(');
    const run = at < 0 ? '' : raw.slice(at, raw.indexOf('\n}\n', at));
    const keyLine = (/\n  const key = providerRuntimeKey\(runProvider, [^\n]+;/.exec(run) || [])[0] || '';
    const baseLine = (/\n  const baseUrl = providerRuntimeBaseUrl\(runProvider, [^\n]+;/.exec(run) || [])[0] || '';
    A.ok(!!(keyLine && baseLine), "fixture: handleRun's key and endpoint lines are found");
    const ordered = run.indexOf(keyLine) < run.indexOf(baseLine) ? keyLine + baseLine : baseLine + keyLine;
    const r = resolvers({ page: { openrouter: { key: KP, baseUrl: UP, rev: 'a1' } } });
    const hr = b => new Function('body', 'runProvider', 'bodyCredential', 'providerRuntimeKey', 'providerRuntimeBaseUrl', ordered + '\nreturn { key, baseUrl };')(
      b, 'openrouter', true, r.providerRuntimeKey, r.providerRuntimeBaseUrl);
    A.eq(hr({ key: KX }), { key: KX, baseUrl: 'https://openrouter.ai/api/v1' }, "a body key that is not the page copy's never rides the page copy's endpoint");
    A.eq(hr({ key: KP }), { key: KP, baseUrl: UP }, "...the page copy's own key does");
    A.eq(hr({}), { key: KP, baseUrl: UP }, "...and so does a run on the station's own key (the page copy)");
    A.eq(hr({ key: KX, baseUrl: 'https://explicit.example/v1' }), { key: KX, baseUrl: 'https://explicit.example/v1' }, "a body's own endpoint still rides its own key");
  }
  // (review r3) a SUBSCRIPTION sign-in's OAuth bearer (ChatGPT, Grok, Kimi) never follows a per-run endpoint — an
  // /api/run body's, a channel snapshot's — as the managed StarNet credential never does; the Commander's own still applies
  {
    PROFILES.codex = { authType: 'oauth_device_code', keyEnv: [], baseUrlEnv: [], baseUrl: '' };
    PROFILES.kimi = { authType: 'oauth_device_code', keyEnv: [], baseUrlEnv: ['KIMI_BASE_URL'], baseUrl: 'https://api.kimi.example/v1' };
    const evil = 'https://third-party.example/v1';
    A.eq(resolvers({}).providerRuntimeBaseUrl('codex', evil), '', "a per-run endpoint never carries the ChatGPT sign-in's bearer");
    A.eq(resolvers({}).providerRuntimeBaseUrl('kimi', evil), 'https://api.kimi.example/v1', "...nor a device sign-in's: the profile endpoint");
    A.eq(resolvers({ env: { KIMI_BASE_URL: UE } }).providerRuntimeBaseUrl('kimi', evil), UE, "the Commander's own endpoint (env) still applies");
    A.eq(resolvers({}).providerRuntimeBaseUrl('custom', evil), evil, 'a key provider keeps its per-run endpoint');
  }
  // (review r4, M3) a STATION-HELD API key — the desktop keychain's runtime push, an operator env key, the page copy — never
  // follows a per-run endpoint the caller names: that endpoint rides only the caller's own key, or a keyless run. Otherwise
  // the provider's configured endpoint serves. handleRun's own key and endpoint lines, executed over the real resolvers.
  {
    const evil = 'https://collector.example/v1';
    const at = raw.indexOf('\nasync function handleRun(');
    const run = at < 0 ? '' : raw.slice(at, raw.indexOf('\n}\n', at));
    const keyLine = (/\n  const key = providerRuntimeKey\(runProvider, [^\n]+;/.exec(run) || [])[0] || '';
    const baseLine = (/\n  const baseUrl = providerRuntimeBaseUrl\(runProvider, [^\n]+;/.exec(run) || [])[0] || '';
    const ordered = run.indexOf(keyLine) < run.indexOf(baseLine) ? keyLine + baseLine : baseLine + keyLine;
    const hr = (r, prov, b) => new Function('body', 'runProvider', 'bodyCredential', 'providerRuntimeKey', 'providerRuntimeBaseUrl', ordered + '\nreturn { key, baseUrl };')(
      b, prov, true, r.providerRuntimeKey, r.providerRuntimeBaseUrl);
    // the probe's body: a provider + an endpoint and NO key (r4-key-follows-endpoint.js)
    const keychain = resolvers({ runtime: { openrouter: 'sk-or-KEYCHAIN' } });
    A.eq(hr(keychain, 'openrouter', { provider: 'openrouter', baseUrl: evil }), { key: 'sk-or-KEYCHAIN', baseUrl: 'https://openrouter.ai/api/v1' },
      "the keychain's key is never sent to an endpoint the body names: the provider's configured one serves");
    A.eq(hr(resolvers({ env: { OPENROUTER_API_KEY: KE } }), 'openrouter', { provider: 'openrouter', baseUrl: evil }).baseUrl, 'https://openrouter.ai/api/v1', '...nor an operator env key');
    A.eq(hr(resolvers({ page: { openrouter: { key: KP, baseUrl: UP, rev: 'a1' } } }), 'openrouter', { baseUrl: evil }), { key: KP, baseUrl: UP }, "...nor the page copy's key: it keeps its own saved endpoint");
    A.eq(keychain.providerRuntimeBaseUrl('openrouter', evil, 'sk-or-KEYCHAIN'), 'https://openrouter.ai/api/v1', 'the rule is the resolver\'s: a run key the caller did not pass ignores the per-run endpoint');
    // the other direction: the caller's OWN key rides its own endpoint; a keyless run (a local server) keeps its endpoint
    A.eq(hr(keychain, 'openrouter', { provider: 'openrouter', key: KX, baseUrl: evil }), { key: KX, baseUrl: evil }, "a body's own key still rides the body's own endpoint");
    A.eq(hr(resolvers({}), 'custom', { provider: 'custom', baseUrl: UL }), { key: '', baseUrl: UL }, 'a keyless custom run keeps its per-run endpoint');
    A.eq(keychain.providerRuntimeBaseUrl('openrouter', evil, KX, KX), evil, '...and the resolver honours a caller key that is the run key');
    // THE DESKTOP PAGE'S CUSTOM ENDPOINT: the keychain holds the CUSTOM key and the window handed the station its endpoint
    // (#137, runtimeBaseUrls); a COMMS run sends the endpoint and no key (the WebView never sees it). It runs there, and a
    // body naming any other host gets the station's endpoint for that key, never the key at that host.
    const desk = resolvers({ runtime: { custom: 'sk-custom-keychain' }, runtimeBase: { custom: UP } });
    A.eq(hr(desk, 'custom', { provider: 'custom', baseUrl: UP }), { key: 'sk-custom-keychain', baseUrl: UP }, "the desktop's CUSTOM run reaches its own saved endpoint with its keychain key");
    A.eq(hr(desk, 'custom', { provider: 'custom', baseUrl: evil }), { key: 'sk-custom-keychain', baseUrl: UP }, '...and the keychain key never goes to another host the body names');
    // the BROWSER page's custom endpoint: the page copy is ONE credential (its key + the endpoint it was saved with), so the
    // page's run sending that endpoint runs there; review r7 (m2): the page copy's key is STATION-HELD like the keychain's,
    // so an endpoint it was not saved with is ignored when a RECORD hands it back. Review r8 (F4): a key that arrived in THIS
    // /api/run body is the caller's own — the page copy can lag the page's last change (its push failed) — so the endpoint
    // sent beside it rides with it; a body with no key keeps the copy's endpoint
    A.eq(hr(resolvers({ page: { custom: { key: KP, baseUrl: UP, rev: 'a1' } } }), 'custom', { provider: 'custom', key: KP, baseUrl: UP }), { key: KP, baseUrl: UP }, "a browser page's own CUSTOM key runs on the endpoint saved with it");
    A.eq(hr(resolvers({ page: { custom: { key: KP, baseUrl: UP, rev: 'a1' } } }), 'custom', { provider: 'custom', key: KP, baseUrl: UL }), { key: KP, baseUrl: UL }, "...and a run that sends that key with a newer endpoint runs on the one it sent (r8 F4)");
    A.eq(hr(resolvers({ page: { custom: { key: KP, baseUrl: UP, rev: 'a1' } } }), 'custom', { provider: 'custom', baseUrl: UL }), { key: KP, baseUrl: UP }, "...while a run that sends no key never moves the page copy's key elsewhere");
    A.eq(resolvers({ page: { custom: { key: KP, baseUrl: UP, rev: 'a1' } } }).providerRuntimeBaseUrl('custom', UL, KP, KP), UP, '...nor does a record or a channel body handing the page key back');
    // every surface that takes an endpoint from a caller (a channel's record or connect body, a provider check, a model
    // list, a run's fallback) says whose key that is, so the resolver can apply the rule
    const callers = (raw.match(/providerRuntimeBaseUrl\([^;]*/g) || []).filter(c => !/^providerRuntimeBaseUrl\([^,]+,\s*''(\s*,\s*[A-Za-z]+)?\)/.test(c) &&!/^providerRuntimeBaseUrl\(provider, explicitBaseUrl/.test(c));
    // (RCR-001) the boot auto-starts and channelFollowsReady resolve through stationHubRunConfig, no copy of their own, and
    // (credential-store S8) the three hubs' per-message reads are one resolve; provider-readiness also
    // folds validate/probe into verifyProviderPair, leaving ten distinct per-run endpoint call sites.
    A.ok(callers.length >= 10, 'fixture: the per-run endpoint call sites are found (' + callers.length + ')');
    A.eq(callers.filter(c => { let d = 0, args = 1; for (const ch of c.slice('providerRuntimeBaseUrl('.length)) { if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) { if (!d) break; d--; } else if (ch === ',' && !d) args++; } return args < 4; }), [],
      'every providerRuntimeBaseUrl call that passes a per-run endpoint also passes the caller\'s own key');
  }
  // (review r8, F4) runOnceCore re-resolves the pair handleRun hands it: its own key and endpoint lines, executed. The body's
  // key rides its endpoint there too (handleRun's keyInRequest), and only there.
  {
    const at = raw.indexOf('\nasync function runOnceCore(');
    const core = at < 0 ? '' : raw.slice(at, raw.indexOf('\n}\n', at));
    const lines = (/\n  const runKey = providerRuntimeKey\(providerId, [^\n]+;\n  const baseUrl = providerRuntimeBaseUrl\(providerId, [^\n]+;/.exec(core) || [])[0] || '';
    A.ok(!!lines, "fixture: runOnceCore's key and endpoint lines are found");
    const r = resolvers({ page: { custom: { key: KP, baseUrl: UP, rev: 'a1' } } });
    const rc = (o, callerCredential) => new Function('o', 'key', 'providerId', 'callerCredential', 'providerRuntimeKey', 'providerRuntimeBaseUrl', lines + '\nreturn { runKey, baseUrl };')(
      o, o.key, 'custom', callerCredential !== false, r.providerRuntimeKey, r.providerRuntimeBaseUrl);
    A.eq(rc({ key: KP, baseUrl: UL, keyInRequest: true }), { runKey: KP, baseUrl: UL }, "F4: the run host keeps the endpoint /api/run's body sent beside its key");
    A.eq(rc({ key: KP, baseUrl: UL }), { runKey: KP, baseUrl: UP }, '...any other caller handing the page key back gets the endpoint the copy was saved with');
    A.eq(rc({ key: KP, baseUrl: UL, keyInRequest: true }, false), { runKey: KP, baseUrl: UP }, '...and a caller pair passed over for another provider never rides');
    // (credential-store lane, S4) ...and the backup keys its rotation takes: runOnceCore's own key, endpoint, watch and pool
    // lines, executed. The page copy's backups ride only a run on the page key that the station resolves or a caller hands
    // back; a key sent in this request takes only a pool sent with it; a pool sent with no key of its own rides nothing.
    const watch = (/\n  const runKeyWatch = [^\n]+;/.exec(core) || [])[0] || '';
    const opens = core.indexOf('primaryProfile.credentialPool) {\n');
    const poolLines = opens > 0 ? ((/\n    const pool = providerRuntimeKeyPool\([\s\S]*?;\n/.exec(core.slice(opens)) || [''])[0]) : '';
    A.ok(!!watch && /const pool = providerRuntimeKeyPool\(providerId, /.test(poolLines), "fixture: runOnceCore's watch and rotation pool lines are found");
    const rp = resolvers({ page: { custom: { key: KP, keyPool: ['spare-1'], baseUrl: UP, rev: 'a1' } } });
    const pool = (o, callerCredential) => new Function('o', 'key', 'providerId', 'callerCredential', 'providerRuntimeKey', 'providerRuntimeBaseUrl', 'providerRuntimeKeyPool', 'credStore',
      lines + watch + poolLines + '\nreturn pool;')(o, o.key, 'custom', callerCredential !== false, rp.providerRuntimeKey, rp.providerRuntimeBaseUrl, rp.providerRuntimeKeyPool, rp.credStore);
    A.eq([pool({}), pool({ key: KP })], [['spare-1'], ['spare-1']], 'S4: a run on the page copy\'s key, the station\'s own or handed back by a record or a gate, rotates on the copy\'s backups');
    A.eq(pool({ key: KP, baseUrl: UL }), ['spare-1'], '...a record naming another endpoint beside it too: the page key goes to its own endpoint (UP), with its own backups');
    A.eq(pool({ key: KP, keyInRequest: true }), [], 'S4: the page key sent in this request takes no station pool: only a pool sent with it');
    A.eq(pool({ key: KP, keyInRequest: true, keyPool: ['own-1'] }), ['own-1'], '...which it does take');
    A.eq(pool({ key: KX, keyInRequest: true }), [], 'another page\'s key never rotates onto this copy\'s backups');
    A.eq(pool({ key: KP, keyPool: ['own-1'] }), ['spare-1'], 'S4: a pool sent with no key of its own rides nothing; the station\'s key keeps its own backups');
    A.eq(pool({ key: KX, keyInRequest: true, keyPool: ['own-1'] }, false), ['spare-1'], 'a caller passed over for another provider brings no pool: the run is on the station\'s key, with its backups');
  }
}

/* ---------- index.js wiring ---------- */
{
  const src = readSidecarSource().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const body = name => { const i = src.indexOf('function ' + name + '('); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };
  // (credential-store lane, S1) the order moved into the store, and index.js's providerRuntimeKey asks it. (S7) it is one list, the
  // layers in key order, which key() reads through the station's choice
  const storeText = sidecarSourceFiles().find(f => f.rel === 'sidecar/credential-store.js').text;
  A.ok(/layer\('keychain', [\s\S]*layer\('environment', [\s\S]*layer\('page', /.test(functionSourceIn(storeText, 'layersOf')) && /for \(const l of layersOf\(id\)\)/.test(functionSourceIn(storeText, 'stationChoice'))
    && /String\(explicitKey \|\| ''\)\.trim\(\) \|\| stationChoice\(id\)\.key/.test(functionSourceIn(storeText, 'key'))
    && /return credStore\.key\(provider, explicitKey\);/.test(body('providerRuntimeKey')), 'providerRuntimeKey: explicit > runtime push > operator env > the page copy');
  // (S7) the gate checks the key it is handed with the endpoint for THAT key, the pair the run goes out on
  A.ok(/return providerHasCredential\(provider, key, providerRuntimeBaseUrl\(provider, '', key\)\);/.test(body('cronHasCredential')), 'cronHasCredential resolves the endpoint for the key it checks');
  // (run-wire-resolver lane) the caller's key and endpoint ride only the provider the caller named (callerCredential)
  A.ok(/const runKey = providerRuntimeKey\(providerId, callerCredential \? key : ''\);\s*const baseUrl = providerRuntimeBaseUrl\(providerId, callerCredential \? \(o\.baseUrl \|\| o\.base_url \|\| ''\) : '', runKey, callerCredential \? key : '', callerCredential && o\.keyInRequest === true\);/.test(src), 'the run path resolves its endpoint for ITS key (a page copy\'s endpoint rides only the page key; a caller\'s endpoint only the caller\'s key)');
  // (run-wire-resolver lane) ...and the caller's backup keys only when its key rides (callerCredential): a pool never crosses;
  // (review r4, M3) and the station's pool never rotates onto an endpoint the caller named; (credential-store lane, S4) and the
  // caller's pool rides only a key it sent in this request (runKeyWatch.sentByCaller), executed above
  A.ok(/providerRuntimeKeyPool\(providerId, runKeyWatch\.sentByCaller \? \(Array\.isArray\(o\.keyPool\) \? o\.keyPool : \[\]\) : \(baseUrl !== providerRuntimeBaseUrl\(providerId, '', runKey\) \? \[\] : undefined\), runKey\)/.test(src), 'and its backup keys for ITS key, never the station\'s onto a caller\'s endpoint');
  /* POST /api/run, RUN (run-wire-resolver lane): a body that names a model and NO provider runs it on the provider its agent
     resolves to — and the body's key, endpoint and key pool (a page's OpenRouter copy) must never ride a provider it
     borrowed. A provider-less body always meant OpenRouter, so they still serve a run that lands there. handleRun's own
     lines, executed: the provider, the credential rule, the endpoint, the key and the pool it hands runOnce. */
  {
    const run = body('handleRun');
    const line = re => (re.exec(run) || [])[0] || '';
    // in the order handleRun writes them (the endpoint is resolved for the key, so the key comes first)
    const lines = [line(/\n  const runProvider = [^\n]+;/), line(/\n  const bodyCredential = [^\n]+;/),
      line(/\n  const baseUrl = providerRuntimeBaseUrl\(runProvider, [^\n]+;/), line(/\n  const key = providerRuntimeKey\(runProvider, [^\n]+;/)]
      .sort((a, b) => run.indexOf(a) - run.indexOf(b));
    const pool = (/\n      key, keyPool: ([^\n]+?), model, system:/.exec(run) || [])[1] || 'undefined';
    A.ok(lines.every(Boolean), 'fixture: handleRun\'s provider / endpoint / key lines are found');
    const handle = (agentProvider, b) => new Function('body', 'provider', 'model', 'agentId', 'normalizeProvider', 'runWireFor', 'providerRuntimeKey', 'providerRuntimeBaseUrl',
      lines.join('\n') + '\nreturn { runProvider, key, baseUrl, keyPool: (' + pool + ') };')(
      b, b.provider, b.model, 'scout', p => String(p || '') || 'openrouter', () => ({ provider: agentProvider }),
      (id, explicit) => String(explicit || '') || ('server-key-for-' + id), (id, explicit) => String(explicit || '') || ('server-url-for-' + id));
    const page = { model: 'x/y', key: 'sk-or-page', baseUrl: 'http://page.example/v1', keyPool: ['sk-or-backup'] };
    const borrowed = handle('codex', page);
    A.eq([borrowed.runProvider, borrowed.key, borrowed.baseUrl, borrowed.keyPool], ['codex', 'server-key-for-codex', 'server-url-for-codex', undefined],
      'a provider-less body\'s key, endpoint and pool never ride a provider the run borrowed');
    const legacy = handle('openrouter', page);
    A.eq([legacy.runProvider, legacy.key, legacy.baseUrl, legacy.keyPool], ['openrouter', 'sk-or-page', 'http://page.example/v1', ['sk-or-backup']],
      '...and still serve a run that lands on OpenRouter, the provider a provider-less body always meant');
    const named = handle('codex', Object.assign({ provider: 'anthropic' }, page));
    A.eq([named.runProvider, named.key], ['anthropic', 'sk-or-page'], 'a body that NAMES its provider brings its own key for it');
    const effortLine = line(/\n  const reasoningEffort = [^\n]+;/);
    const effortOf = b => new Function('body', 'runProvider', 'resolveReasoningEffort', effortLine + '\nreturn reasoningEffort;')(b, 'openrouter', (p, v) => v || 'provider-default');
    A.eq([effortOf({}), effortOf({ reasoningEffort: 'low' })], [undefined, 'low'],
      'handleRun hands runOnce only the body\'s own effort pick: the rest is resolved WITH the pair the run uses (the one effort rule)');
  }
  A.ok(/const ENGINE_KEYS_FILE = path\.join\(WORKSPACES, '\.secrets', 'provider-keys\.json'\);/.test(src), 'the copy lives in the protected .secrets/ sibling of the fs jail');
  A.ok(/load: \(\) => DESKTOP_SHELL \? undefined :/.test(src) && /if \(DESKTOP_SHELL\) return json\(409/.test(body('handleEngineKeySet')), 'the desktop app (OS keychain) never reads or writes the plaintext copy');
  A.ok(/persist: \(envelope\) => saveCredentialRemovalVerified\(ENGINE_KEYS_FILE, envelope, null, 'engine-keys'\)/.test(src), 'main AND .bak are written and read back (a replaced key never lingers in .bak)');
  // (context-key-redact r3: each computed part is read in its own try — secretPart — so one throwing getter cannot blind the list.
  // credential-store lane S5: the page copy is held through the store's secretValues, beside every other layer's values)
  A.ok(/\{ values: secretPart\('providerCredentials', \(\) => credStore\.secretValues\(/.test(body('stationSecretValues')), 'the page copy is a known secret for redaction');
  {
    const G = require('./helpers/credential-store-sandbox.js');
    const api = G.wiredImpl()({ env: {}, page: { groq: { key: 'gsk-page-copy-0123456789', keyPool: ['gsk-page-backup-0123456789'], rev: 'r1' } }, pushes: [] });
    const held = G.heldValues(api);
    A.ok(['gsk-page-copy-0123456789', 'gsk-page-backup-0123456789'].every(v => held.known().includes(v) && Array.from(held.childEnv.values()).includes(v)),
      '...and its key and backups are in index.js\'s redaction list and its helper-environment list, as at trunk');
  }
  A.ok(/\{ m: 'POST', exact: '\/api\/providers\/engine-key', h: handleEngineKeySet \}/.test(src), 'the route is an ordinary /api/* POST (token + Host + Origin gate)');
  A.ok(!/TOKEN_EXEMPT[^\n]*engine-key/.test(fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'apiauth.js'), 'utf8')), 'and it is NOT token-exempt');
  const h = body('handleEngineKeySet');
  A.ok(!/\.key\b[^\n]*json\(200/.test(h) && /engineKeyPresence\(id\)/.test(h), 'the answer is presence only');
  A.ok(/\{ boot: body\.boot === true, ifRev: typeof body\.ifRev === 'string' \? body\.ifRev : '' \}/.test(h), 'a page boot hand-over is marked, with the revision that page last saw');
  A.ok(/r\.held \? 'the station could not delete its copy of this ' \+ label \+ ' connection \(its log has the reason\) — routines and other unattended runs will KEEP using it until a retry succeeds'/.test(h), 'a failed REMOVE says the station keeps using its copy (never "chat still works")');
  A.ok(/if \(r\.stale\) return json\(200, Object\.assign\(\{ ok: true, provider: id, applied: false, stale: true, changed: false \}, engineKeyPresence\(id\)\)\);/.test(h), 'a stale boot hand-over is answered without the current revision');
  A.ok(/verify: \(envelope\) => bothCopiesHold\(ENGINE_KEYS_FILE, envelope\)/.test(src) && /\[file, file \+ '\.bak'\]\.every/.test(body('bothCopiesHold')), 'an unchanged push re-checks both copies on disk');
  A.ok(/credentialError: \(provider\) => engineCredentialError\(provider, 'this scheduled routine'\)/.test(src), 'the scheduled fire says the shared sentence');
  A.ok(/return engineCredentialError\(provider, what \|\| 'this routine'\);/.test(body('cronCredentialError')), 'Run Now / quest refresh say the shared sentence');
  // (S7) index.js's own sentence, executed over a real station: what the store says is missing, and the variable the key is really in
  {
    const G = require('./helpers/credential-store-sandbox.js');
    const said = sc => G.wiredImpl()(Object.assign({ pushes: [] }, sc)).refusal('custom', 'this routine');
    const keyless = { custom: { baseUrl: 'http://page-llm/v1', rev: 'r1' } };
    A.ok(/^CUSTOM_OPENAI_KEY is set in the environment/.test(said({ env: { CUSTOM_OPENAI_KEY: 'k' }, page: keyless })) && /was saved without a key/.test(said({ env: { CUSTOM_OPENAI_KEY: 'k' }, page: keyless })), 'P3c: the unpaired sentence, naming the keyless URL');
    A.ok(/^OPENAI_COMPATIBLE_KEY is set in the environment/.test(said({ env: { OPENAI_COMPATIBLE_KEY: 'k' } })) && !/saved without a key/.test(said({ env: { OPENAI_COMPATIBLE_KEY: 'k' } })), 'an env key with no URL anywhere: it names the variable the key is in, not the first of the provider\'s names');
    A.ok(/^STARNET_CUSTOM_OPENAI_KEY is set in the environment/.test(said({ env: { STARNET_CUSTOM_OPENAI_KEY: 'k' } })), '...the branded spelling too');
    A.eq(said({ env: {} }), 'no CUSTOM base URL is saved on this station for this routine — set it under SETTINGS → AI & MODELS, or set CUSTOM_OPENAI_BASE_URL in the environment that starts StarNet', 'no key at all: the sentence it always was: that is what is missing');
    A.eq(said({ env: {}, page: { custom: { key: 'k', rev: 'r1' } } }), said({ env: {} }), 'a page key with no URL: the same, and saving the URL beside it pairs them');
    A.eq(said({ env: {}, kept: { on: true }, pushes: [['custom', { key: 'k' }]] }), said({ env: {} }), 'the desktop keychain\'s key with no endpoint: the same (#137): a URL saved in Settings is the keychain\'s own, and rides it');
  }
}

/* ---------- pre-update backups never carry the copy ---------- */
A.eq(recovery._internals.classifyPolicy('.secrets/provider-keys.json').action, 'skip', 'station-recovery skips .secrets/provider-keys.json');
A.eq(recovery._internals.classifyPolicy('.secrets/provider-keys.json.bak').action, 'skip', '…and its .bak');

A.report('engine-credential.test');
