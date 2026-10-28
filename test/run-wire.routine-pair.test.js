/* node test/run-wire.routine-pair.test.js — routines store their {provider, model} WHOLE (run-wire-resolver lane).

   A routine saved with HALF a pair ran a tuple the fire path assembled field by field: a bare model ran on whatever
   provider its agent's row happened to carry, and a bare provider (an older routine form stamped the station's provider —
   bug a496d1c7) ran the agent's model on that provider. index.js pairCronJobWires normalises every load and every write
   through the one resolver (sidecar/run-wire.js pairSavedWire):
     - a bare model is paired with the provider it has been running on, so the tuple it ran is the tuple it keeps;
     - a bare provider names no model, so it is cleared and the routine follows its agent;
     - NOTHING IS LOST: wireMigration { at, was, now, reason } keeps what the record held (an earlier note rides on as
       `previous`), and each routine's change is logged once;
     - deterministic and idempotent: a second pass changes nothing; a script-only routine is left alone.
   The function runs from its own source over a fake roster; the load / write / boot-persist call sites are locked. */
'use strict';
const A = require('./_assert.js');
const { sidecarFunctionSource, sidecarTopLevelFunction, readSidecarSource } = require('./helpers/source.js');
const RunWire = require('../sidecar/run-wire.js');

const roster = new Map(Object.entries({
  agent: { model: 'gpt-5.5', provider: 'codex', reasoningEffort: 'high' },
  scout: { model: null, provider: '' },
  smith: { model: 'anthropic/claude-x', provider: 'openrouter' }
}));
const warned = [];
const deps = {
  agentRoster: roster, RunWire, codexTokens: { access_token: 't' },
  normalizeProviderId: p => (['openrouter', 'codex', 'anthropic'].indexOf(String(p || '').toLowerCase()) >= 0 ? String(p).toLowerCase() : ''),
  registryProviderUsesCodex: p => p === 'codex', CODEX_DEFAULT_MODEL: 'gpt-codex-default',
  providerRuntimeKey: (id) => (id === 'openrouter' ? 'sk-or' : ''), ENV: () => '',
  cronWirePairNoted: new Set(), console: { warn: (m) => warned.push(String(m)) }
};
const src = ['runWireEnv', 'runWireFor', 'routineWireOf', 'cronWireFor', 'pairCronJobWires'].map(n => sidecarFunctionSource(n));
A.ok(src.every(s => s.length > 20), 'fixture: the resolver and pairCronJobWires are declared in the sidecar');
const api = new Function(...Object.keys(deps), src.join('\n') + '\nreturn { pairCronJobWires, cronWireFor };')(...Object.values(deps));

const jobs = [
  { id: 'j-model', name: 'bare model', agentId: 'scout', model: 'routine/model', provider: null },
  { id: 'j-prov', name: 'stamped provider', agentId: 'scout', model: null, provider: 'openrouter' },
  { id: 'j-pair', name: 'whole pair', agentId: 'smith', model: 'x/y', provider: 'openrouter' },
  { id: 'j-none', name: 'follows agent', agentId: 'smith', model: null, provider: null },
  { id: 'j-script', name: 'script only', agentId: 'scout', model: null, provider: 'openrouter', noAgent: true },
  { id: 'j-again', name: 'migrated before', agentId: 'smith', model: 'old/model', provider: null, wireMigration: { at: '2026-01-01T00:00:00.000Z', was: { provider: 'codex', model: null } } }
];
// what each routine RAN before the migration (the run-time rule over the half pair)
const ranBefore = Object.fromEntries(jobs.map(j => { const w = api.cronWireFor(j); return [j.id, [w.provider, w.model]]; }));

const r = api.pairCronJobWires(jobs);
const by = id => r.jobs.find(j => j.id === id);
A.eq(r.changed, 3, 'three half pairs normalised (bare model, stamped provider, a re-migrated bare model)');
A.eq([by('j-model').provider, by('j-model').model], ['codex', 'routine/model'], 'a bare model is paired with the provider it ran on (the station default the agent follows)');
A.eq([by('j-prov').provider, by('j-prov').model], [null, null], 'a bare provider is cleared: the routine follows its agent');
A.eq(by('j-pair'), jobs[2], 'a whole pair is untouched (same object)');
A.eq(by('j-none'), jobs[3], 'no pair at all is untouched');
A.eq(by('j-script'), jobs[4], 'a script-only routine never calls a model and is left alone');

// nothing lost
A.eq(by('j-model').wireMigration.was, { provider: null, model: 'routine/model' }, 'the note keeps what the record held');
A.eq(by('j-prov').wireMigration.was, { provider: 'openrouter', model: null }, '...including the cleared provider');
A.eq(by('j-prov').wireMigration.now, { provider: null, model: null }, '...and what it holds now');
A.ok(/not a pin/.test(by('j-prov').wireMigration.reason) && /paired with codex/.test(by('j-model').wireMigration.reason), 'each note says why: ' + by('j-model').wireMigration.reason);
A.ok(/^\d{4}-\d\d-\d\dT/.test(by('j-model').wireMigration.at), 'and when');
A.eq(by('j-again').wireMigration.previous, { at: '2026-01-01T00:00:00.000Z', was: { provider: 'codex', model: null } }, 'an earlier migration note rides on as `previous`');

// the tuple a bare model ran is the tuple it keeps; a cleared provider runs its agent's pair
const ranAfter = Object.fromEntries(r.jobs.map(j => { const w = api.cronWireFor(j); return [j.id, [w.provider, w.model]]; }));
A.eq(ranAfter['j-model'], ranBefore['j-model'], 'the paired routine runs exactly what it ran before');
A.eq(ranAfter['j-prov'], ['codex', 'gpt-5.5'], 'the cleared routine runs its agent\'s pair (the station default)');
A.eq(ranBefore['j-prov'], ['codex', 'gpt-5.5'], '...which the run-time rule already ran (a provider alone was never a pin)');

// logged once per routine, idempotent, deterministic
A.eq(warned.length, 3, 'each changed routine is logged: ' + warned.join(' / '));
A.ok(warned.every(w => /^\[run-wire\] routine j-/.test(w) && /half a pair/.test(w)), 'the log line names the routine and what changed');
const again = api.pairCronJobWires(r.jobs);
A.eq(again.changed, 0, 'a second pass changes nothing (idempotent)');
A.eq(again.jobs, r.jobs, '...and returns the same records');
A.eq(warned.length, 3, 'and logs nothing more');
A.eq(api.pairCronJobWires(undefined).jobs, undefined, 'a non-list is handed back untouched, never replaced with []');

// the call sites: every load, every write, and the boot persist
{
  const all = readSidecarSource();
  const load = sidecarTopLevelFunction('loadCronJobs');
  A.ok(/const wires = pairCronJobWires\(repaired\.jobs\);[\s\S]{0,120}repaired\.jobs = wires\.jobs;\s*return repaired\.jobs;/.test(load), 'every cron.jobs.json load pairs the routines (boot and each withCronWrite re-read)');
  const write = sidecarTopLevelFunction('withCronWrite');
  A.ok(/cronJobs = pairCronJobWires\(mutate\(loadCronJobs\(\)\)\)\.jobs;/.test(write), 'every write stores the pair whole before it persists');
  A.ok(/if \(cronWiresPairedOnLoad && !cronToolsetsRepairedOnLoad\) \{\s*try \{ saveCronJobs\(\);/.test(all), 'the boot load persists the pairing once');
  const snap = sidecarTopLevelFunction('cronStateSnapshot');
  A.ok(/const w = cronWireFor\(j\);[\s\S]{0,200}\{ wire \}/.test(snap), 'GET /api/cron shows each routine\'s resolved wire');
}

A.report('run-wire.routine-pair: routines store their pair whole, losing nothing');
