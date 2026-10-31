/* node test/credential-store.golden.test.js — the credential store is index.js's credential resolution, MOVED: every
   station of the golden resolves exactly as trunk did (credential-store lane, step S1; family B1, credential sources),
   except the rows a later step changes, each a named delta row (D1, step S2: the desktop shell's spawn keys, section 6;
   D2, step S4: a key pool rides only its own layer's key, section 7).

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
   4. IT BITES. Three mutations each move named rows: the pools unbound again (step S4 undone: R1 and R6 come back), an env
      key read before the keychain's (step S2's D1 direction), and an index.js wrapper that drops the in-request mark.
   5. index.js holds no keychain state and no resolver body of its own, and the module is pure.

   PINNED AS TRUNK HAS THEM, until the step that changes each as a named golden delta (D1 S2, D2 S4, D3 and D4 S7):
     P3b  layers "custom K:- E:k P:ku": the station's own choice is the env key with NO endpoint, beside a saved page pair.
   ...and until step S4, whose delta D2 now holds them with trunk's values (section 7):
     R1   layers "custom K:- E:p P:kup": the operator's env KEY_POOL rode the page key, at the page endpoint;
     R6   layers "custom K:up E:- P:-": the pushed pool rode a body key no layer holds.

   6. THE DESKTOP SHELL (step S2, golden delta D1). The shell table holds the shell's spawn shapes under its marker
      (STARNET_DESKTOP_SHELL=1): each key and key pool in both spellings with one value, beside a user's own exports, then
      the shell's REMOVE, rotation or cleared pool. index.js now adopts those pairs into the keychain layer at its top and
      deletes them from the environment (adoptSpawnCredentials). Trunk ignores the marker, and the same stations WITHOUT it
      resolve exactly as trunk did (the capture on a3af8dafd checked every row), so the rows the marker changes are the
      lane's change, and each is listed in deltas.D1 with trunk's value and why: a keychain key outranks a bare OS export
      (R5, decision 4); a REMOVE, a rotation or a cleared pool reaches the spawn copy (doneMeans 1). The names-table rows
      R5 and "shell spawn only, then REMOVE" and the openrouter "env:shell push:remove" rows have no marker: they are a
      headless operator's both-spellings export, which keeps behaving as at trunk. D1 is checked under the pool rule in
      force when S2 landed (the store with S4 undone), because S4 then moved the pools of some shell rows, on both sides.

   7. A KEY POOL RIDES ONLY ITS OWN LAYER'S KEY (step S4, golden delta D2). At trunk the keychain pool and the env KEY_POOL
      rode ANY run key: a refused page key rotated onto the operator's env pool at the page's endpoint (probe R1), a body key
      onto the keychain pool (R6), a keyless run or another layer's key onto either. Now each pool rides only its own
      layer's key (the store's keyPool), a key a caller sent in this request gets only a pool sent with it (runOnceCore's
      key-pool line, which the golden's runs follow), and a pool whose layer holds no key is unused (the keychain pool after
      the shell's REMOVE). deltas.D2 lists every row that moves, with the pools its runs had before S4. Only pools move, and
      with both halves undone (M1) exactly those rows come back, so D2 is the whole change. */
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
A.eq(d0.length, 0, 'index.js\'s adoption, store construction and one-line functions reproduce all ' + total + ' rows (trunk\'s, with the D1 rows of section 6 and the D2 rows of section 7): an EMPTY diff' + (d0.length ? ' (' + d0.length + '):\n  ' + d0.slice(0, 4).join('\n  ') : ''));

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
// D2 (step S4, section 7): the two crossings trunk had are bound now; D2 keeps trunk's pools beside them
const wasOf = (label, run) => ((((fixture.deltas || {}).D2 || {}).rows || {})[label] || { was: {} }).was[run];
A.eq([field('layers', 'custom K:- E:p P:ku', 'st'), wasOf('layers / custom K:- E:p P:ku', 'st')], ['pg@pg[]', 'en.p'],
  'D2 (R1): a routine on the page key never rotates onto the operator\'s env KEY_POOL at the page endpoint (trunk: pg@pg[en.p])');
A.eq([field('layers', 'custom K:- E:p P:kup', 'pg'), wasOf('layers / custom K:- E:p P:kup', 'pg')], ['pg@pg[pg.p]', 'en.p'],
  'D2 (R1): ...and with backups of its own the page key rotates on them, which the env pool displaced at trunk');
A.eq([field('layers', 'custom K:up E:- P:-', 'fo'), wasOf('layers / custom K:up E:- P:-', 'fo')], ['fo@kc[]', 'kc.p'],
  'D2 (R6): a body key no layer holds never rotates onto the keychain pool (trunk: fo@kc[kc.p])');
A.eq(field('layers', 'custom K:kp E:- P:-', 'st'), 'kc@-[kc.p]', 'the keychain key still rotates on the keychain pool');
A.eq(field('layers', 'custom K:- E:kp P:-', 'st'), 'en@-[en.p]', '...and the env key on the env KEY_POOL');
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
// M1, step S4 undone: trunk's pool rule (the keychain pool, else the env KEY_POOL, for ANY run key; the page pool only for
// the page key) in place of the binding, and runOnceCore's key-pool line as it was (a key sent in this request with no pool
// took the station's pool for it). Sections 6 and 7 use it as the pool rule in force before S4.
const unbound = mutate('const layer = inUse ? layersOf(id).find(l => l.keys.includes(inUse) && l.pool.length) : null;',
  "const layer = layersOf(id).find(l => l.pool.length && (l.name !== 'page' || l.keys.includes(inUse)));", 'pool binding');
const unboundRows = G.goldenRows(G.wiredImpl({ store: unbound }), { poolLineBefore: true });
const d1 = G.diffRows(fixture.tables, unboundRows);
A.ok(d1.some(x => x.startsWith('layers / custom K:up E:- P:-:')) && d1.some(x => x.startsWith('layers / custom K:- E:p P:kup:')),
  'M1: unbinding the pools moves R6 and R1 back (' + d1.length + ' rows)');
A.ok(G.diffRows(fixture.tables, G.goldenRows(G.wiredImpl({ store: unbound }))).length < d1.length,
  'M1: ...and the store\'s binding alone is not all of it: runOnceCore\'s line keeps a body key off the station\'s pool too');
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
// (under the pool rule in force when S2 landed: the store with S4 undone, M1. S4 moved the pools of some shell rows on both
// sides of the marker; section 7 names those rows, and where D1 lists one too, D2 takes it from D1's value.)
{
  const D1 = (fixture.deltas || {}).D1 || {};
  A.eq([D1.step, D1.trunkCapturedOn], ['S2', 'a3af8dafd0be808b1abb52ec330d99152278c162'], 'fixture: delta D1 is step S2\'s, its trunk values captured on the lane base');
  // the same stations without the marker resolve as trunk did (the capture compared every row with trunkImpl)
  const unmarked = G.goldenRows(G.wiredImpl({ store: unbound }), { only: ['shell'], unmarked: true, poolLineBefore: true }).shell;
  const marked = unboundRows.shell;
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

// ---- 7. D2: a key pool rides only its own layer's key; every row that moves is named, with the pools it had ----
{
  const D2 = (fixture.deltas || {}).D2 || {};
  const rows = D2.rows || {};
  A.eq([D2.step, Object.keys(D2.reasons || {}).sort()], ['S4', ['R1', 'R6', 'own', 'sent']], 'fixture: delta D2 is step S4\'s, with its reasons');
  const RUN = /^([^=\s]+)=([^@\s]*)@(\S*)\[([^\]]*)\]$/;
  const runsOf = row => new Map(String(row || '').split(' ').map(t => RUN.exec(t)).filter(Boolean).map(x => [x[1], x]));
  // a row as it was before S4: the pools of the runs its was map names, every other character as it is now
  const before = (row, was) => row.split(' ').map(t => { const x = RUN.exec(t); return x && Object.prototype.hasOwnProperty.call(was, x[1]) ? x[1] + '=' + x[2] + '@' + x[3] + '[' + was[x[1]] + ']' : t; }).join(' ');
  const reverted = JSON.parse(JSON.stringify(fixture.tables));
  const bad = [];
  for (const [label, r] of Object.entries(rows)) {
    const at = label.indexOf(' / '), t = label.slice(0, at), l = label.slice(at + 3);
    const row = (fixture.tables[t] || {})[l];
    const was = (r && r.was) || {};
    const runs = runsOf(row);
    if (typeof row !== 'string') { bad.push(label + ': not a row of the golden'); continue; }
    if (!Object.keys(was).length) bad.push(label + ': names no run');
    for (const [run, pool] of Object.entries(was)) {
      if (!runs.has(run)) bad.push(label + ': ' + run + ' is not a run of the row');
      else if (runs.get(run)[4] === pool) bad.push(label + ': ' + run + '\'s pool did not move');
      // a binding only takes backup keys away from a key that is not their layer's: it never hands a run a pool it had none of
      if (!pool) bad.push(label + ': ' + run + ' had no pool before');
    }
    const why = Array.isArray(r && r.why) ? r.why : [];
    if (!why.length || why.some(w => !(D2.reasons || {})[w]) || !why.some(w => w === 'R1' || w === 'R6' || w === 'sent')) bad.push(label + ': why names a crossing it closed: ' + JSON.stringify(why));
    reverted[t][l] = before(row, was);
  }
  A.eq(bad, [], 'every D2 row is a golden row whose named runs had a pool before S4 and another now, and says which crossing it closed');
  // the whole change: the store with S4 undone gives exactly the D2 rows back, with their old pools, and every other row as is
  const dz = G.diffRows(reverted, unboundRows);
  A.eq(dz.length, 0, 'D2 is the whole of S4: with the binding undone every D2 row has its old pools back and no other row moves (' +
    Object.keys(rows).length + ' rows)' + (dz.length ? ':\n  ' + dz.slice(0, 4).join('\n  ') : ''));
  A.ok(Object.keys(rows).length >= 600, 'fixture: S4 moves the pools of many stations (' + Object.keys(rows).length + ')');
  // the probes' crossings are D2 rows
  A.eq([(rows['layers / custom K:- E:p P:ku'] || {}).why, (rows['layers / custom K:up E:- P:-'] || {}).why], [['R1'], ['R6']], 'R1 and R6 are D2 rows');
  A.eq((rows['accounts / grok unlinked page'] || {}).was, { 'pg+u': 'pg.p1' }, 'a body key the page copy also holds takes no station pool when it sent none (runOnceCore\'s line)');
  // where D1 lists a shell row too, D2 takes it from D1's value: the deltas chain
  const both = Object.keys(rows).filter(label => ((fixture.deltas.D1 || {}).rows || {})[label]);
  A.ok(both.length > 0 && both.every(label => fixture.deltas.D1.rows[label].now === reverted.shell[label.replace(/^shell \/ /, '')]),
    'a shell row both deltas list goes trunk -> D1 -> D2: D2\'s old pools are D1\'s value (' + both.length + ' rows)');
  A.ok(both.includes('shell / anthropic pair+pool push:remove') && fixture.tables.shell['anthropic pair+pool push:remove'].startsWith('st=-@def[] '),
    'the keychain pool the shell keeps after its REMOVE is unused (S2 still rotated a keyless run onto it)');
}

A.report('credential-store.golden');
