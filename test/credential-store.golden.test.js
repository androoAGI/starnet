/* node test/credential-store.golden.test.js — the credential store is index.js's credential resolution, MOVED: every
   station of the golden resolves exactly as trunk did (credential-store lane, step S1; family B1, credential sources),
   except the rows a later step changes, each a named delta row (D1, step S2: the desktop shell's spawn keys, section 6).

   WHAT MOVED. sidecar/credential-store.js holds every API-key provider's key, key pool and endpoint by layer: the desktop
   shell's push (runtimeKeys, runtimeKeyPools, runtimeBaseUrls), the legacy OpenRouter alias, the operator's environment,
   the page copy (engine-credential.js, injected) and StarNet's linked account. Trunk's resolution came with it unchanged:
   providerRuntimeKey, providerOperatorKey, providerRuntimeKeyPool, providerFallbackKeyPool, pageCopyRidesWith,
   providerRuntimeBaseUrl, the kept desktop endpoints (#137: keptEndpointProvider, desktopEndpointsHeld, the boot load,
   saveDesktopEndpoints, providerEndpointNotHandedOver), the shell's push (setProviderRuntimeConfig), engine-key presence
   and the channel station-key rule (channelKeyIsStationHeld, channelEndpointIsForeign). index.js keeps one-line functions
   with the names its callers use, and its runtimeKey alias is the store's keychain OpenRouter key, kept current by onAlias.

   WHAT IS LOCKED
   1. THE GOLDEN. test/fixtures/credential-store-golden.json was captured on 0bd96b943 (the trunk this lane rebased on; the
      lane base a3af8dafd gives the same tables, captured from its own checkout) by goldenRows(trunkImpl): trunk's own
      functions, cut from that tree's index.js text and run over its registry and engine-credential.js
      (test/helpers/credential-store-sandbox.js). Nothing in it was written by hand. Six tables, 1271 stations: every
      combination of the three station layers (key, endpoint, backup keys each) for a keyed cloud provider, CUSTOM and a
      keyless local one; OpenRouter's alias and its two bare names under a push, a removal and the page copy; which
      spelling of each env name is read first; StarNet's linked account and the sign-ins beside junk in every layer; the
      desktop's kept endpoints over every shape of saved file; and what the shell's push accepts. A seventh, the shell
      table (208 stations, step S2), was captured the same way at a3af8dafd and holds this lane's rows (section 6). A row records the key,
      the endpoint AND the backup keys of each run shape (resolved as runOnceCore resolves the pair it is handed),
      engine-key presence, which keys count as station-held, and for the desktop what is read and written.
   2. THE MOVE REPRODUCES EVERY ROW through the wiring production uses: index.js's adoption statement, its own store
      construction block and its one-line functions, lifted through test/helpers/source.js and run over the module
      (wiredImpl). An empty diff is the whole claim: a non-empty row is a change the code made, not a policy.
   3. THE SANDBOX the fourteen lifted-source tests now build their credStore with (sandboxStore) reproduces it too.
   4. IT BITES. Three mutations each move named rows: a pushed pool bound to its own key (the direction of step S4), an env
      key read before the keychain's (step S2's D1 direction), and an index.js wrapper that drops the in-request mark.
   5. index.js holds no keychain state and no resolver body of its own, and the module is pure.

   PINNED AS TRUNK HAS THEM, until the step that changes each as a named golden delta (D1 S2, D2 S4, D3 and D4 S7):
     R1   layers "custom K:- E:p P:kup": the operator's env KEY_POOL rides the page key, at the page endpoint;
     R6   layers "custom K:up E:- P:-": the pushed pool rides a body key no layer holds;
     P3b  layers "custom K:- E:k P:ku": the station's own choice is the env key with NO endpoint, beside a saved page pair.

   6. THE DESKTOP SHELL (step S2, golden delta D1). The shell table holds the shell's spawn shapes under its marker
      (STARNET_DESKTOP_SHELL=1): each key and key pool in both spellings with one value, beside a user's own exports, then
      the shell's REMOVE, rotation or cleared pool. index.js now adopts those pairs into the keychain layer at its top and
      deletes them from the environment (adoptSpawnCredentials). Trunk ignores the marker, and the same stations WITHOUT it
      resolve exactly as trunk did (the capture on a3af8dafd checked every row), so the rows the marker changes are the
      lane's change, and each is listed in deltas.D1 with trunk's value and why: a keychain key outranks a bare OS export
      (R5, decision 4); a REMOVE, a rotation or a cleared pool reaches the spawn copy (doneMeans 1). The names-table rows
      R5 and "shell spawn only, then REMOVE" and the openrouter "env:shell push:remove" rows have no marker: they are a
      headless operator's both-spellings export, which keeps behaving as at trunk. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const G = require('./helpers/credential-store-sandbox.js');
const { readSidecarIndex } = require('./helpers/source.js');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'credential-store-golden.json'), 'utf8'));

// ---- 1. the golden ----
A.eq(fixture.capturedOn, '0bd96b9435c983a777c3318b2fbea30f29e697aa', 'the golden was captured on the trunk this lane rebased on');
A.eq(fixture.sameAt, ['a3af8dafd0be808b1abb52ec330d99152278c162'], '...and the lane base gives the same tables');
A.ok(/trunkImpl/.test(fixture.method), 'it was captured by running trunk\'s own functions: ' + fixture.method);
A.eq(Object.keys(fixture.tables), G.TABLES, 'it holds every table the helper defines, in order');
A.eq(Object.keys(fixture.tables).map(t => Object.keys(fixture.tables[t]).length), Object.keys(fixture.tables).map(t => fixture.counts[t]), 'its counts are its rows');
const total = Object.values(fixture.counts).reduce((a, b) => a + b, 0);
A.ok(total >= 1200, 'the golden covers every station the tables define (' + total + ')');

// ---- 2. the move: index.js's own wiring over the store reproduces every row ----
const wired = G.goldenRows(G.wiredImpl());
const d0 = G.diffRows(fixture.tables, wired);
A.eq(d0.length, 0, 'index.js\'s adoption, store construction and one-line functions reproduce all ' + total + ' rows (trunk\'s, and the D1 rows of section 6): an EMPTY diff' + (d0.length ? ' (' + d0.length + '):\n  ' + d0.slice(0, 4).join('\n  ') : ''));

// ---- 3. the sandbox the lifted-source tests use ----
const sand = G.goldenRows(G.sandboxImpl());
const ds = G.diffRows(fixture.tables, sand);
A.eq(ds.length, 0, 'the sandbox store (test/helpers/credential-store-sandbox.js sandboxStore) reproduces them too' + (ds.length ? ':\n  ' + ds.slice(0, 4).join('\n  ') : ''));

// ---- the rows a later step changes, named so a reader sees what the empty diff holds ----
const field = (table, label, name) => {
  const row = fixture.tables[table][label];
  A.ok(typeof row === 'string', 'fixture: the golden has the row ' + table + ' / ' + label);
  return (new RegExp('(?:^| )' + name.replace(/[.+]/g, '\\$&') + '=(\\S+)').exec(row || '') || [])[1];
};
A.eq(field('layers', 'custom K:- E:p P:kup', 'pg'), 'pg@pg[en.p]', 'R1: the env KEY_POOL rides the page key at the page endpoint');
A.eq(field('layers', 'custom K:- E:p P:kup', 'st'), 'pg@pg[en.p]', 'R1: ...on the station\'s own choice too (a routine)');
A.eq(field('layers', 'custom K:up E:- P:-', 'fo'), 'fo@kc[kc.p]', 'R6: the pushed pool rides a body key no layer holds');
A.eq(field('layers', 'custom K:- E:k P:ku', 'st'), 'en@-[]', 'P3b: the env CUSTOM key wins with no endpoint, beside a saved page pair');
A.eq(field('layers', 'custom K:- E:- P:ku', 'st'), 'pg@pg[]', 'P3a: the page pair alone runs whole');
A.eq(field('names', 'anthropic R5 shell STARNET_+SKYNET_=kc ANTHROPIC_API_KEY=os', 'st'), 'os@def[]', 'no marker (a headless both-spellings export): the bare name is read first, as at trunk');
A.eq(field('names', 'anthropic shell spawn only, then the shell pushes REMOVE', 'st'), 'kc@def[]', 'no marker: a push REMOVE leaves an operator\'s env key serving, as at trunk (headless env keys are never deleted)');
A.eq(field('openrouter', 'openrouter env:shell push:remove page:-', 'st'), 'br@def[]', 'no marker: ...OpenRouter\'s too, read back through the env');
A.eq(field('openrouter', 'openrouter env:shell push:remove page:-', 'alias'), '-', '...while the alias itself is cleared');
// ...and the same shapes under the desktop shell's marker: the S2 change (delta D1)
A.eq(field('shell', 'anthropic pair+bare push:-', 'st'), 'kc@def[]', 'D1 (R5 under the marker): the shell\'s key, adopted into the keychain, outranks a bare OS ANTHROPIC_API_KEY');
A.eq(field('shell', 'anthropic pair+bare push:remove', 'st'), 'os@def[]', 'D1: after the shell\'s REMOVE the user\'s own bare export serves (decision 4)');
A.eq(field('shell', 'anthropic pair push:remove', 'st'), '-@def[]', 'doneMeans-1: under the marker the shell\'s REMOVE leaves no key serving');
A.eq(field('shell', 'anthropic pair push:remove', 'pres'), 'none/-0-/no', '...and presence says so at once');
A.eq(field('shell', 'openrouter pair push:remove', 'st'), '-@def[]', 'doneMeans-1: ...OpenRouter\'s too');
A.eq(field('shell', 'anthropic pair push:rotate', 'held'), 'kc2', 'a rotation leaves the old key held nowhere');
A.eq(field('shell', 'anthropic pair+pool push:pool cleared', 'st'), 'kc@def[]', 'a pool the shell cleared stays cleared (its spawn copy came back at trunk)');
A.eq(field('shell', 'anthropic single STARNET_ push:remove', 'st'), 'br@def[]', 'one spelling is the user\'s own export: it stays in the env layer and survives a REMOVE');
A.eq(field('shell', 'anthropic split push:remove', 'st'), 'br@def[]', 'two values are the user\'s own exports too');
A.eq(field('openrouter', 'openrouter env:STARNET push:- page:-', 'pres'), 'environment/-0-/ready', 'a headless STARNET_OPENROUTER_KEY seeds the keychain layer at boot, and presence calls it the environment');
A.eq(field('layers', 'anthropic K:- E:- P:kup', 'pg+u'), 'pg@ex[]', 'F4: the page key sent in THIS request rides the endpoint sent beside it');
A.eq(field('layers', 'anthropic K:- E:- P:kup', 'pg+u.rec'), 'pg@pg[pg.p]', '...a record handing the same key back keeps the endpoint it was saved with');

// ---- 4. the golden bites ----
const src = G.storeSource();
const mutate = (from, to, label) => {
  A.ok(src.split(from).length === 2, 'fixture: the ' + label + ' mutation anchor occurs once in the store');
  return G.loadStoreFrom(src.replace(from, to));
};
// M1, S4's direction: the pushed pool rides only the keychain's own key
const m1 = mutate(': (own(pools, id)\n          ? pools[id]',
  ': (own(pools, id) && String(runKey === undefined ? key(id, \'\') : (runKey || \'\')).trim() === String(keys[id] || \'\').trim()\n          ? pools[id]', 'pool');
const d1 = G.diffRows(fixture.tables, G.goldenRows(G.wiredImpl({ store: m1 })));
A.ok(d1.some(x => x.startsWith('layers / custom K:up E:- P:-:')), 'M1: binding the pushed pool to its own key moves R6 (' + d1.length + ' rows)');
A.ok(!d1.some(x => x.startsWith('layers / custom K:- E:p P:kup:')), 'M1: ...and only the pushed pool\'s rows: R1 (the env pool) stays');
// M2, step S2's D1 direction: the operator's env key read before the keychain's
const m2 = mutate("const runtime = String(keys[id] || '').trim();\n      if (runtime) return runtime;\n      const operator = operatorKey(id);",
  "const early = operatorKey(id);\n      if (early) return early;\n      const runtime = String(keys[id] || '').trim();\n      if (runtime) return runtime;\n      const operator = operatorKey(id);", 'key order');
const d2 = G.diffRows(fixture.tables, G.goldenRows(G.wiredImpl({ store: m2 })));
A.ok(d2.some(x => x.startsWith('layers / anthropic K:k E:k P:-:')), 'M2: reading the env key before the keychain\'s moves the rows that hold both (' + d2.length + ' rows)');
// M3: index.js's providerRuntimeBaseUrl drops its fifth argument (whether the key came in this request)
let anchored = false;
const d3 = G.diffRows(fixture.tables, G.goldenRows(G.wiredImpl({ transform: t => {
  const from = 'return credStore.baseUrl(provider, explicitBaseUrl, runKey, callerKey, inRequest);';
  anchored = t.split(from).length === 2;
  return t.replace(from, 'return credStore.baseUrl(provider, explicitBaseUrl, runKey, callerKey);');
} })));
A.ok(anchored, 'fixture: the M3 anchor is index.js\'s providerRuntimeBaseUrl');
A.ok(d3.some(x => x.startsWith('layers / anthropic K:- E:- P:kup:') && /pg\+u=pg@pg/.test(x)), 'M3: a wrapper that drops the in-request mark moves the F4 rows (' + d3.length + ' rows)');

// ---- 5. index.js keeps no credential state or resolver body of its own; the store is pure ----
{
  // the one place this test reads index.js as it stands: it pins what index.js itself declares
  const idx = readSidecarIndex();
  for (const state of ['runtimeKeys', 'runtimeKeyPools', 'runtimeBaseUrls', 'desktopEndpointsOnDisk']) {
    A.ok(!new RegExp('(?:const|let|var)\\s+' + state + '\\b').test(idx), 'index.js no longer holds ' + state + ' (the store does)');
  }
  for (const gone of ['providerOperatorKey', 'providerFallbackKeyPool', 'pageCopyRidesWith', 'keptEndpointProvider', 'saveDesktopEndpoints', 'loadDesktopEndpoints']) {
    A.ok(!new RegExp('function\\s+' + gone + '\\s*\\(').test(idx), 'index.js no longer declares ' + gone + ' (the store\'s ' + gone + ' has no caller left in index.js)');
  }
  const ONE_LINERS = {
    providerRuntimeKey: 'credStore.key(provider, explicitKey)',
    providerRuntimeKeyPool: 'credStore.keyPool(provider, explicitPool, runKey)',
    providerRuntimeBaseUrl: 'credStore.baseUrl(provider, explicitBaseUrl, runKey, callerKey, inRequest)',
    setProviderRuntimeConfig: 'credStore.push(provider, patch, report)',
    engineKeyPresence: 'credStore.presence(id)',
    channelKeyIsStationHeld: 'credStore.stationHeld(provider, key)',
    channelEndpointIsForeign: 'credStore.endpointIsForeign(provider, key, baseUrl)',
    providerEndpointNotHandedOver: 'credStore.endpointNotHandedOver(id)',
    desktopEndpointsHeld: 'credStore.keptEndpoints()'
  };
  for (const [name, call] of Object.entries(ONE_LINERS)) {
    const m = new RegExp('\\nfunction ' + name + '\\(([^)]*)\\) \\{ return ([^\\n]*); \\}\\n').exec(idx);
    A.eq(m && m[2], call, name + ' is one line that asks the store');
  }
  A.eq((idx.match(/credentialStore\.makeCredentialStore\(/g) || []).length, 1, 'index.js builds ONE store');
  A.ok(/\n\}\);\ncredStore\.loadKeptEndpoints\(\);\n/.test(idx), '...and reads the kept endpoints back right after building it, at boot');
  A.ok(/\nlet runtimeKey = '';\n/.test(idx) && /onAlias: \(key\) => \{ runtimeKey = key; \},/.test(idx), 'the runtimeKey alias is the store\'s keychain OpenRouter key, kept current by onAlias');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  A.ok(!/\brequire\s*\(/.test(code) && !/\bprocess\./.test(code) && !/\bDate\.now\b|\bMath\.random\b|\bnew Date\(/.test(code),
    'the store is pure: no require, no process, no clock (index.js injects them)');
  A.ok(!/\bcatch\b/.test(code), 'and it swallows nothing: no catch at all');
}

// ---- 6. D1: every row the desktop shell's marker changes is named, with trunk's value ----
{
  const D1 = (fixture.deltas || {}).D1 || {};
  A.eq([D1.step, D1.trunkCapturedOn], ['S2', 'a3af8dafd0be808b1abb52ec330d99152278c162'], 'fixture: delta D1 is step S2\'s, its trunk values captured on the lane base');
  // the same stations without the marker resolve as trunk did (the capture compared every row with trunkImpl)
  const unmarked = G.goldenRows(G.wiredImpl(), { only: ['shell'], unmarked: true }).shell;
  const marked = fixture.tables.shell;
  const changed = Object.keys(marked).filter(l => marked[l] !== unmarked[l]).map(l => 'shell / ' + l).sort();
  A.eq(changed, Object.keys(D1.rows || {}).sort(), 'the rows the marker changes are exactly the rows deltas.D1 lists (' + changed.length + ')');
  for (const [label, r] of Object.entries(D1.rows || {})) {
    const l = label.replace(/^shell \/ /, '');
    if (r.trunk !== unmarked[l] || r.now !== marked[l]) A.ok(false, 'D1 ' + label + ': the recorded trunk and now values are the rows (trunk ' + r.trunk + ' / unmarked ' + unmarked[l] + '; now ' + r.now + ' / ' + marked[l] + ')');
    if (!/doneMeans 1|decision 4|stays cleared|residual|environment layer/.test(String(r.why || ''))) A.ok(false, 'D1 ' + label + ' says why: ' + r.why);
  }
  A.ok(changed.length >= 40, 'fixture: the shell table exercises the marker (' + changed.length + ' rows change)');
  A.ok(Object.keys(marked).filter(l => / push:-$/.test(l) && !changed.includes('shell / ' + l)).length >= 30, '...and most stations with no push resolve as at trunk under it');
}

A.report('credential-store.golden');
