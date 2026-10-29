/* node test/run-wire.routine-pair.test.js — a routine never stores a provider without a model (run-wire-resolver lane).

   An older routine form stamped the station's provider onto a routine with no model of its own (bug a496d1c7), and
   routine.create/manage could pass a provider alone; the fire path then ran the agent's model on that provider, field by
   field. index.js pairCronJobWires normalises every load and every write through the one resolver (sidecar/run-wire.js
   pairSavedWire):
     - a bare PROVIDER names no model, so it is cleared and the routine follows its agent;
     - a bare MODEL is left exactly as it is — no provider is stamped on it. Each run borrows the provider at run time (its
       agent's, else the station's), so the routine follows a station provider switch, as it did before the lane, and a
       boot with an empty or lost roster can never freeze it on the environment's provider;
     - NOTHING IS LOST: wireMigration { at, was, now, reason, previous } keeps what the record held, and earlier notes ride
       on WHOLE in `previous` (newest first, bounded), and each routine's change is logged once;
     - deterministic and idempotent: a second pass changes nothing; a script-only routine is left alone.
   The function runs from its own source over a fake roster; the load / write / boot-persist call sites are locked, and
   GET /api/cron's readout (routineWireRow) runs from its own source too. */
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
  normalizeProviderId: p => (['openrouter', 'codex', 'anthropic', 'starnet'].indexOf(String(p || '').toLowerCase()) >= 0 ? String(p).toLowerCase() : ''),
  registryProviderUsesCodex: p => p === 'codex', CODEX_DEFAULT_MODEL: 'gpt-codex-default',
  providerRuntimeKey: (id) => (id === 'openrouter' ? 'sk-or' : ''), ENV: () => '',
  cronWirePairNoted: new Set(), CRON_WIRE_NOTES_KEPT: 5, console: { warn: (m) => warned.push(String(m)) }
};
const src = ['runWireEnv', 'runWireFor', 'routineWireOf', 'cronWireFor', 'routineWireRow', 'pairCronJobWires'].map(n => sidecarFunctionSource(n));
A.ok(src.every(s => s.length > 20), 'fixture: the resolver, the readout and pairCronJobWires are declared in the sidecar');
const api = new Function(...Object.keys(deps), src.join('\n') + "\nreturn { pairCronJobWires, cronWireFor, routineWireRow: typeof routineWireRow === 'function' ? routineWireRow : () => 'absent' };")(...Object.values(deps));
A.ok(/^const CRON_WIRE_NOTES_KEPT = 5;$/m.test(readSidecarSource()), 'fixture: the note history bound is declared');

const olderNotes = [1, 2, 3, 4, 5, 6].map(i => ({ at: '2026-01-0' + i + 'T00:00:00.000Z', was: { provider: 'p' + i, model: null }, now: { provider: null, model: null }, reason: 'r' + i }));
const jobs = [
  { id: 'j-model', name: 'bare model', agentId: 'scout', model: 'routine/model', provider: null },
  { id: 'j-prov', name: 'stamped provider', agentId: 'scout', model: null, provider: 'openrouter' },
  { id: 'j-pair', name: 'whole pair', agentId: 'smith', model: 'x/y', provider: 'openrouter' },
  { id: 'j-none', name: 'follows agent', agentId: 'smith', model: null, provider: null },
  { id: 'j-script', name: 'script only', agentId: 'scout', model: null, provider: 'openrouter', noAgent: true },
  { id: 'j-again', name: 'migrated before', agentId: 'smith', model: null, provider: 'codex',
    wireMigration: Object.assign({}, olderNotes[0], { previous: olderNotes.slice(1) }) },
  { id: 'j-old-shape', name: 'older note shape', agentId: 'smith', model: '', provider: 'anthropic',
    wireMigration: { at: '2025-12-01T00:00:00.000Z', was: { provider: 'codex', model: null }, now: { provider: null, model: null }, reason: 'old', previous: { at: '2025-11-01T00:00:00.000Z', was: { provider: 'x', model: null } } } }
];
// what each routine RAN before the migration (the run-time rule over the half pair)
const ranBefore = Object.fromEntries(jobs.map(j => { const w = api.cronWireFor(j); return [j.id, [w.provider, w.model]]; }));

const r = api.pairCronJobWires(jobs);
const by = id => r.jobs.find(j => j.id === id);
A.eq(r.changed, 3, 'three provider-only routines cleared (a stamped provider, two re-migrated ones); nothing else changed');
A.eq(by('j-model'), jobs[0], 'a bare model is left exactly as it is: same object, no provider stamped, no migration note');
A.eq([by('j-prov').provider, by('j-prov').model], [null, null], 'a bare provider is cleared: the routine follows its agent');
A.eq(by('j-pair'), jobs[2], 'a whole pair is untouched (same object)');
A.eq(by('j-none'), jobs[3], 'no pair at all is untouched');
A.eq(by('j-script'), jobs[4], 'a script-only routine never calls a model and is left alone');

// nothing lost
A.eq(by('j-prov').wireMigration.was, { provider: 'openrouter', model: null }, 'the note keeps the cleared provider');
A.eq(by('j-prov').wireMigration.now, { provider: null, model: null }, '...and what the record holds now');
A.ok(/not a pin/.test(by('j-prov').wireMigration.reason), 'the note says why: ' + by('j-prov').wireMigration.reason);
A.ok(/^\d{4}-\d\d-\d\dT/.test(by('j-prov').wireMigration.at), 'and when');
A.ok(!('previous' in by('j-prov').wireMigration), 'a first note carries no history');
{
  const prev = by('j-again').wireMigration.previous;
  A.eq(prev.length, 5, 'earlier notes ride on, bounded to the last 5');
  A.eq(prev[0], olderNotes[0], 'the last note rides on WHOLE (at, was, now, reason), its own history lifted out beside it');
  A.eq(prev.slice(1), olderNotes.slice(1, 5), '...followed by the ones it carried, newest first; the oldest drops off');
  A.eq(by('j-old-shape').wireMigration.previous, [
    { at: '2025-12-01T00:00:00.000Z', was: { provider: 'codex', model: null }, now: { provider: null, model: null }, reason: 'old' },
    { at: '2025-11-01T00:00:00.000Z', was: { provider: 'x', model: null } }
  ], 'a note whose history was a single object reads as a one-entry history');
}

// the tuple a bare model ran is the tuple it keeps; a cleared provider runs its agent's pair
const ranAfter = Object.fromEntries(r.jobs.map(j => { const w = api.cronWireFor(j); return [j.id, [w.provider, w.model]]; }));
A.eq(ranAfter['j-model'], ranBefore['j-model'], 'the bare-model routine runs exactly what it ran before');
A.eq(ranAfter['j-model'], ['codex', 'routine/model'], '...its model on the provider its agent follows (the station\'s)');
A.eq(ranAfter['j-prov'], ['codex', 'gpt-5.5'], 'the cleared routine runs its agent\'s pair (the station default)');
A.eq(ranBefore['j-prov'], ['codex', 'gpt-5.5'], '...which the run-time rule already ran (a provider alone was never a pin)');

// THE STATION SWITCHES PROVIDER: a bare-model routine follows it, exactly as before the lane
{
  const saved = roster.get('agent');
  roster.set('agent', Object.assign({}, saved, { provider: 'starnet' }));
  try {
    const reloaded = api.pairCronJobWires(r.jobs);   // the next load after the switch
    A.eq(reloaded.changed, 0, 'the switch rewrites no routine');
    const w = api.cronWireFor(reloaded.jobs.find(j => j.id === 'j-model'));
    A.eq([w.provider, w.model, w.source, w.providerSource], ['starnet', 'routine/model', 'routine', 'station'],
      'after the station switches provider, the bare-model routine runs its model on the NEW provider');
  } finally { roster.set('agent', saved); }
}
// a boot with an EMPTY or lost roster stamps nothing either (the env provider is never frozen onto a routine)
{
  const kept = [...roster]; roster.clear();
  try {
    const boot = api.pairCronJobWires([{ id: 'j-boot', agentId: 'scout', model: 'routine/model', provider: null }]);
    A.eq([boot.changed, boot.jobs[0].provider], [0, null], 'an empty roster at boot pairs nothing onto a bare model');
  } finally { for (const [k, v] of kept) roster.set(k, v); }
}

// logged once per routine, idempotent, deterministic
A.eq(warned.length, 3, 'each changed routine is logged: ' + warned.join(' / '));
A.ok(warned.every(w => /^\[run-wire\] routine j-/.test(w) && /half a pair/.test(w)), 'the log line names the routine and what changed');
A.ok(!warned.some(w => /j-model/.test(w)), 'a bare-model routine is never logged as a migration');
const again = api.pairCronJobWires(r.jobs);
A.eq(again.changed, 0, 'a second pass changes nothing (idempotent)');
A.eq(again.jobs, r.jobs, '...and returns the same records');
A.eq(warned.length, 3, 'and logs nothing more');
A.eq(api.pairCronJobWires(undefined).jobs, undefined, 'a non-list is handed back untouched, never replaced with []');

// GET /api/cron's readout: the pair each routine's next run uses, and null for a script-only routine
A.eq(api.routineWireRow(jobs[0]), { provider: 'codex', model: 'routine/model', source: 'routine' }, 'the readout names the pair a bare-model routine runs');
A.eq(api.routineWireRow(jobs[3]), { provider: 'openrouter', model: 'anthropic/claude-x', source: 'agent' }, '...and the agent pair a pair-less one follows');
A.eq(api.routineWireRow(jobs[4]), null, 'a script-only routine shows no pair: it never calls a model');

// the call sites: every load, every write, and the boot persist
{
  const all = readSidecarSource();
  const load = sidecarTopLevelFunction('loadCronJobs');
  A.ok(/const wires = pairCronJobWires\(repaired\.jobs\);[\s\S]{0,120}repaired\.jobs = wires\.jobs;\s*return repaired\.jobs;/.test(load), 'every cron.jobs.json load normalises the routines (boot and each withCronWrite re-read)');
  const write = sidecarTopLevelFunction('withCronWrite');
  A.ok(/cronJobs = pairCronJobWires\(mutate\(loadCronJobs\(\)\)\)\.jobs;/.test(write), 'every write normalises before it persists');
  A.ok(/if \(cronWiresPairedOnLoad && !cronToolsetsRepairedOnLoad\) \{\s*try \{ saveCronJobs\(\);/.test(all), 'the boot load persists the clearing once');
  const snap = sidecarTopLevelFunction('cronStateSnapshot');
  A.ok(/\{ wire: routineWireRow\(j\) \}/.test(snap), 'GET /api/cron shows each routine\'s resolved wire (routineWireRow)');
}

A.report('run-wire.routine-pair: a routine never stores a provider without a model, and a bare model follows its station');
