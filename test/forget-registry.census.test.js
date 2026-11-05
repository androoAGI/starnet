/* node test/forget-registry.census.test.js - EVERY DURABLE STORE IS PURGED BY A DELETE OR KEPT ON PURPOSE (turn identity commit 12;
   qa/bugs/3e926b6a, 31042fab, 6e750350).

   A deleted session's words used to survive in whichever store nobody remembered: the interests histogram, a verdict packet, a task brief, a
   golden, the attachment files. The forget registry (sidecar/forget-registry.js, wired by sidecar/forget-wiring.js) is the one list of the stores
   that hold words derived from a session; this census is what keeps that list true. It reads the WHOLE sidecar as text and finds every durable
   store the sidecar writes:

     - each saveResilient(<NAME>_FILE ...)                                  key: the constant (INTERESTS_FILE)
     - each makeDurableJsonStore( / makeDomainStore( call                    key: the const in index.js (awayBriefingStore), the file elsewhere
     - each memory-store key prefix (notebook:, pending:, declined: ...)     key: memory:<prefix>

   and requires a row for each in forget-wiring.js's STORES table: a registered entry that purges it, or an exemption with the reason it is kept
   (Q4: routines the Commander created, delivered workspace files, learned skill files; Q5: the declined list; settings, secrets, counters). A NEW
   store with no row fails here, so it chooses before it ships; a row whose store is gone fails too, so the table stays a map of what exists. The
   wiring is then built for real (stub stores) to prove that every row names an entry that is registered, that every exemption is registered with
   its reason, and that every entry has a source and a forget. */
'use strict';
const A = require('./_assert.js');
const { sidecarSourceFiles } = require('./helpers/source.js');
const ForgetRegistry = require('../sidecar/forget-registry.js');
const Wiring = require('../sidecar/forget-wiring.js');

const lineOf = (text, at) => text.slice(0, at).split('\n').length;

// discover(files) -> Map(key -> [where])
function discover(files) {
  const keys = new Map();
  const add = (key, where) => { if (!keys.has(key)) keys.set(key, []); keys.get(key).push(where); };
  for (const f of files) {
    const base = f.rel.split('/').pop();
    for (const m of f.text.matchAll(/saveResilient\(\s*([A-Z][A-Z0-9_]*_FILE)\b/g)) add(m[1], f.rel + ':' + lineOf(f.text, m.index));
    if (f.rel === 'sidecar/durable-store.js' || f.rel === 'sidecar/domain-store.js') continue;   // the definitions
    for (const m of f.text.matchAll(/(makeDurableJsonStore|makeDomainStore)\(\s*\{/g)) {
      const before = f.text.slice(Math.max(0, m.index - 120), m.index);
      const named = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:require\([^)]*\)\.)?$/.exec(before);
      add(f.rel === 'sidecar/index.js' && named ? named[1] : base, f.rel + ':' + lineOf(f.text, m.index));
    }
    if (f.rel === 'sidecar/memory-store.js') for (const m of f.text.matchAll(/k\.indexOf\('([a-z]+):'\) === 0/g)) add('memory:' + m[1], f.rel + ':' + lineOf(f.text, m.index));
  }
  return keys;
}

const files = sidecarSourceFiles();
const found = discover(files);
const rows = new Map(Wiring.STORES.map(r => [r[0], r]));
A.eq(rows.size, Wiring.STORES.length, 'no store has two rows in the table');
A.ok(found.size >= 60, 'the scanner sees the sidecar\'s durable stores (' + found.size + ' found)');

const unlisted = Array.from(found.keys()).filter(k => !rows.has(k)).map(k => k + ' (' + found.get(k)[0] + ')');
A.eq(unlisted, [], 'every durable store the sidecar writes has a row in forget-wiring.js STORES: purged by an entry or kept with a reason');
const stale = Array.from(rows.keys()).filter(k => !found.has(k));
A.eq(stale, [], 'every row of the table still names a store that exists (a moved or removed store is re-reviewed)');

// the wiring, built for real over stub stores: nothing here calls a store, it only registers
const registry = ForgetRegistry.make({});
const stub = new Proxy({}, { get: () => () => ({}) });
Wiring.wireForgetRegistry(registry, stub);
const entries = registry.names(), exempts = registry.exemptions();
A.ok(entries.length >= 19, 'the registry holds the entries (' + entries.length + ': ' + entries.join(', ') + ')');
for (const row of Wiring.STORES) {
  if (row[1] === 'entry') A.ok(entries.indexOf(row[2]) >= 0, row[0] + ' is purged by a registered entry: ' + row[2]);
  else A.ok(typeof exempts[row[2] || row[0]] === 'string' && exempts[row[2] || row[0]].length >= 16, row[0] + ' is exempt, with a reason');
}
const named = new Set(Wiring.STORES.filter(r => r[1] === 'entry').map(r => r[2]).concat(Object.keys(Wiring.UNKEYED_ENTRIES)));
A.eq(entries.filter(n => !named.has(n)), [], 'every registered entry covers a store of the table (or one no pattern can see, named with its reason)');
for (const n of entries) {
  const e = registry.entry(n);
  A.ok(e && typeof e.sourceOf === 'function' && typeof e.forget === 'function', n + ' records a source and forgets');
}
for (const name of ['cron-jobs', 'turn-identity-mode', 'turn-identity-soak', 'declined', 'delivered-workspace-files', 'learned-skill-files', 'run-journal'])
  A.ok(typeof exempts[name] === 'string', 'the named exemption ' + name + ' is registered with its reason');
A.ok(/Q4/.test(exempts['cron-jobs']) && /Q5/.test(exempts.declined) && /Q4/.test(exempts['delivered-workspace-files']) && /Q4/.test(exempts['learned-skill-files']), 'the Q4 and Q5 exemptions name their decision');
A.ok(entries.indexOf('commander-dossier') >= 0 && entries.indexOf('commander-posture') >= 0 && !exempts.DOSSIER_FILE && !exempts.AUTONOMY_POSTURE_FILE, 'the dossier block and the posture beliefs are registered entries (commit 14), no longer exempt');

// the host builds ONE registry and ONE wiring block, and a pass runs through them
const indexJs = files.find(f => f.rel === 'sidecar/index.js').text;
A.eq((indexJs.match(/ForgetRegistry\.make\(/g) || []).length, 1, 'index.js builds one registry');
A.eq((indexJs.match(/wireForgetRegistry\(forgetRegistry,/g) || []).length, 1, '...and one wiring block');
A.ok(/forgetRegistry\.forgetAll\(SessionTombstones\.deletedScope\(todo, runStore\.all\(\)\)\)/.test(indexJs), 'a purge pass is one forgetAll over the scope the ledger and the run history make');
A.ok(/sessionTombstones\.repurge\(ForgetRegistry\.VERSION\)/.test(indexJs), 'boot re-opens the stamps purged before this registry version');

// fixtures: the census catches a new store, a moved one and a store that ships with no choice
{
  const withNew = files.concat([{ rel: 'sidecar/new-feature.js', text: "const NEW_THING_FILE = 'x';\nsaveResilient(NEW_THING_FILE, { v: 1 });\nconst s = makeDurableJsonStore({ fs });\n" }]);
  const missing = Array.from(discover(withNew).keys()).filter(k => !rows.has(k));
  A.eq(missing.sort(), ['NEW_THING_FILE', 'new-feature.js'], 'a NEW store with no row is found (a save constant and a durable store)');
  const without = files.filter(f => f.rel !== 'sidecar/overseer.js');
  A.ok(Array.from(rows.keys()).filter(k => !discover(without).has(k)).indexOf('overseer.js') >= 0, 'a row whose store file is gone is reported stale');
  const memory = files.map(f => f.rel === 'sidecar/memory-store.js' ? { rel: f.rel, text: f.text.replace("if (k.indexOf('todo:') === 0)", "if (k.indexOf('todo:') === 0) return 1; if (k.indexOf('notesx:') === 0)") } : f);
  A.ok(discover(memory).has('memory:notesx'), 'a new memory-store key prefix is a store of its own');
}

A.report('forget-registry.census');
