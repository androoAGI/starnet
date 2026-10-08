/* node test/routine-toolsets.test.js — a routine's enabledToolsets has ONE reader, and a list saved before 0.13.2 heals.

   #58: before 0.13.2 the toolset field was only pattern-filtered, so the TOOLSETS label 'WEB & BROWSER' was stored as
   [] and a tool name ('web_request') as an unknown family — both mean "freebies only", and the routine fired with no
   web tools. Create/update were fixed, but every fire path reads the STORED list raw, no UI or routine.manage edits
   toolsets, and cron.jobs.json was never migrated — so an upgrader's routine stayed broken (A3). Locks:
     · strict(): the create/update contract (labels/tool names/case -> family; unknown REFUSED; [] -> null) — and
       naming only freebies keeps those freebie ids, so a stored [] can only be a list that lost its entries
     · lenient(): the same rules for a list already on disk, dropping (and reporting) an unknown entry, never throwing
     · healJobs(): repairs every stored routine, notes a dropped entry on the routine's row, and is idempotent
     · index.js routes create/update/routine.manage AND every cron.jobs.json load through this one module.
   The live proof (a legacy [] routine fires WITH web tools after a restart) is test/routine-keys.e2e.test.js. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');
const { toolsetRows, toggleableCaps } = require('../sidecar/capability/toolsets.js');
const { TOOLSET_FREEBIES, enforceEnabledToolsets } = require('../sidecar/inputpolicy.js');
const { makeRoutineToolsets } = require('../sidecar/routine-toolsets.js');

const T = makeRoutineToolsets({ capRegistry: CAP_REGISTRY, toolsetRows, toggleableCaps, freebies: TOOLSET_FREEBIES });
const J = v => JSON.stringify(v);

/* ---------- strict(): the create/update contract (same cases test/cron.api.test.js drives over HTTP) ---------- */
A.eq(T.strict(null), null, 'no list -> no restriction');
A.eq(T.strict([]), null, 'an empty list is NO restriction, never "restrict to nothing"');
A.eq(J(T.strict(['Web & Browser'])), '["web"]', 'the TOOLSETS console label maps to its family');
A.eq(J(T.strict(['web_request'])), '["web"]', 'a tool name maps to its family');
A.eq(J(T.strict(['Web'])), '["web"]', 'a family id in any case is that family');
A.eq(J(T.strict(['web', 'cabinet'])), '["web","cabinet"]', 'valid family ids are stored unchanged');
A.eq(J(T.strict(['web', 'todo'])), '["web"]', 'a computer freebie beside a real family adds nothing');
A.eq(J(T.strict(['mcp:github'])), '["connectors"]', 'a connector tool maps to the connectors family');
let threw = '';
try { T.strict(['nonsense']); } catch (e) { threw = e.message; }
A.ok(/unknown toolset "nonsense"/.test(threw) && /\bweb\b/.test(threw), 'an unknown entry is refused by name with the valid ids: ' + threw);
threw = '';
try { T.strict('web'); } catch (e) { threw = e.message; }
A.ok(/must be a list/.test(threw), 'a non-list is refused');
// naming ONLY freebies keeps them (freebies-only, as before) — but never stores [], which now means "lost its entries"
const freeOnly = T.strict(['todo']);
A.ok(Array.isArray(freeOnly) && freeOnly.length === 1 && TOOLSET_FREEBIES.has(freeOnly[0]), 'a freebies-only list stores the freebie family: ' + J(freeOnly));
{
  // and it still enforces exactly as [] did: the computer freebies, nothing else
  const registry = { get: n => ({ 'web.request': { capability: 'web' }, 'todo.write': { capability: freeOnly[0] }, 'fs.read': { capability: 'cabinet' } })[n] || null };
  const resolved = { tools: ['web.request', 'todo.write', 'fs.read'] };
  A.eq(J(enforceEnabledToolsets(resolved, registry, freeOnly).tools), J(enforceEnabledToolsets(resolved, registry, []).tools), 'freebie ids restrict exactly like the old [] (freebies only)');
}

/* ---------- lenient(): a list already on disk never throws, drops what it cannot place ---------- */
A.eq(J(T.lenient([])), J({ list: null, dropped: [] }), 'a stored [] (the broken WEB & BROWSER save) heals to no restriction');
A.eq(J(T.lenient(['WEB & BROWSER'])), J({ list: ['web'], dropped: [] }), 'a stored console label heals to its family');
A.eq(J(T.lenient(['web_request'])), J({ list: ['web'], dropped: [] }), 'a stored tool name heals to its family');
A.eq(J(T.lenient(['bogus'])), J({ list: null, dropped: ['bogus'] }), 'a list of only unknown entries heals to no restriction and reports them');
A.eq(J(T.lenient(['web', 'bogus'])), J({ list: ['web'], dropped: ['bogus'] }), 'an unknown entry beside a real one is dropped, the real one kept');
A.eq(J(T.lenient(['todo'])), J({ list: freeOnly, dropped: [] }), 'an old freebies-only list stays freebies-only (never widened)');
A.eq(J(T.lenient(null)), J({ list: null, dropped: [] }), 'no list stays no list');
A.eq(J(T.lenient('web')), J({ list: null, dropped: [] }), 'a non-list reads as null — exactly what the fire paths already did');

/* ---------- idempotent: whatever strict() stores, a later load leaves alone ---------- */
for (const input of [['Web & Browser'], ['web', 'cabinet'], ['todo'], ['mcp:x'], ['compute'], ['WEB', 'web_fetch', 'todo']]) {
  const stored = T.strict(input);
  A.eq(J(T.lenient(stored).list), J(stored), 'a load leaves the stored ' + J(stored) + ' (from ' + J(input) + ') unchanged');
}

/* ---------- healJobs(): the load-time repair over cron.jobs.json ---------- */
{
  const jobs = [
    { id: 'empty', enabledToolsets: [] },
    { id: 'label', enabledToolsets: ['WEB & BROWSER'] },
    { id: 'tool', enabledToolsets: ['web_request'] },
    { id: 'unknown', enabledToolsets: ['bogus'] },
    { id: 'failing', enabledToolsets: ['nope'], lastError: 'provider HTTP 500' },
    { id: 'fine', enabledToolsets: ['web'] },
    { id: 'none', enabledToolsets: null },
    { id: 'legacyNoField' }
  ];
  const r = T.healJobs(jobs);
  const by = id => r.jobs.find(j => j.id === id);
  A.eq(by('empty').enabledToolsets, null, '[] heals to null');
  A.eq(J(by('label').enabledToolsets), '["web"]', 'label heals to web');
  A.eq(J(by('tool').enabledToolsets), '["web"]', 'tool name heals to web');
  A.eq(by('unknown').enabledToolsets, null, 'an all-unknown list heals to null');
  A.ok(/dropped unknown entry "bogus"/.test(by('unknown').lastError) && /full station tools/.test(by('unknown').lastError), 'the dropped entry is named on the routine row: ' + by('unknown').lastError);
  A.eq(by('failing').lastError, 'provider HTTP 500', 'a real failure on the row is never overwritten by the repair note');
  A.ok(by('fine') === jobs[5] && by('none') === jobs[6] && by('legacyNoField') === jobs[7], 'routines that need nothing are returned untouched (same object)');
  A.eq(r.healed.map(h => h.id).join(','), 'empty,label,tool,unknown,failing', 'healed names exactly the routines that changed');
  A.ok(jobs[0].enabledToolsets.length === 0, 'the input array is not mutated');
  A.eq(T.healJobs(r.jobs).healed.length, 0, 'a second load finds nothing to repair (idempotent)');
}

/* ---------- index.js reads every list through this module ---------- */
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  A.ok(/function cronToolsetList\(v\) \{ return routineToolsets\.strict\(v\); \}/.test(src), 'create/update/routine.manage validate through routineToolsets.strict');
  A.ok(!/let cronToolsetIndex/.test(src), 'no second copy of the toolset rules is left in index.js');
  const load = src.slice(src.indexOf('function loadCronJobs()'), src.indexOf('function loadCronJobs()') + 2400);
  A.ok(/routineToolsets\.healJobs\(loaded\)/.test(load) && /return repaired\.jobs;/.test(load), 'every cron.jobs.json load (boot + each withCronWrite re-read) returns the repaired routines');
  A.ok(/if \(cronToolsetsRepairedOnLoad\) \{\s*try \{ saveCronJobs\(\);/.test(src), 'the boot load persists a repair once');
}

A.report('routine-toolsets.test');
