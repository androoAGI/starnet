/* Run the actual workshop/focus persistence seams with a real RunTable. Faults enter at the filesystem boundary. */
'use strict';
const vm = require('node:vm');
const path = require('node:path');
const A = require('./_assert.js');
const { sidecarFunctionSource } = require('./helpers/source');
const RunTable = require('../sidecar/run-table.js');
const RunOutcome = require('../frontend/app/runoutcome.js');
const nightfocus = require('../sidecar/nightfocus.js');
const { writeJsonResilient } = require('../sidecar/durable-store.js');
const names = ['runWorkshopShift', 'resolveNightFocus', 'saveNightFocusState', 'saveResilient', 'awayBuildStopped'];
const source = names.map(name => {
  const text = sidecarFunctionSource(name);
  A.ok(text.length > 60 && text.length < 14000, name + ': bounded actual source located');
  return text;
}).join('\n');

async function check(mode, suppliedSignal) {
  const table = RunTable.makeRunTable({ now: () => 1 });
  const notes = [], releases = [], settles = [], drops = [];
  let calls = 0, writes = 0, reads = 0, finishScan, enteredScan;
  const scanEntered = new Promise(resolve => { enteredScan = resolve; });
  const scan = new Promise(resolve => { finishScan = resolve; });
  const controller = new AbortController();
  const fs = { readFileSync() {
    reads++;
    throw Object.assign(new Error(mode === 'read-fault' ? 'focus unreadable' : 'absent'), { code: mode === 'read-fault' ? 'EACCES' : 'ENOENT' });
  } };
  const ctx = {
    console, Date, Object, String, AbortController, crypto: { randomUUID: () => 'workshop-proof' },
    runTable: table, RunOutcome, nightfocus, writeJsonResilient, fs, path,
    NIGHTFOCUS_STATE_FILE: path.resolve('fixture-nightfocus.json'), nightFocusState: nightfocus.fresh(Date.now()),
    writeFileDurable() { writes++; if (mode === 'write-fault') throw new Error('focus durable write failed'); },
    reconcileNightFocusAuthority() {}, nightFocusInputs: () => ({ now: Date.now(), goal: { text: 'Build the requested change' } }),
    workshopOf: () => true, isRunLive: id => table.ownerLive(id),
    workshopStore: {
      claimNext: async () => ({ id: 'item', title: 'Build it' }),
      releaseClaim: async (id, runId, opts) => { releases.push({ id, runId, failed: opts && opts.failed }); return null; },
      setLastShift: async (id, info) => { notes.push(info); }
    },
    cronModelFor: () => 'fixture', cronProviderFor: () => 'fixture', cronKeyFor: () => 'fixture', cronHasCredential: () => true,
    currentInitiative: () => null,
    resolveProjectPatchTarget: async () => {
      if (mode === 'scan-fault') throw new Error('scan boundary fault');
      if (mode === 'held-stop') { enteredScan(); await scan; }
      return {};
    },
    workshopPrompt: () => { if (mode === 'prompt-fault') throw new Error('prompt boundary fault'); return 'build'; },
    placeCronWorkitem() {}, cronSystemFor: () => '', router: { stationFor: () => null },
    runOnce: async o => { calls++; if (mode === 'core-fault') throw new Error('core boundary fault'); return { reason: o.signal.aborted ? 'cancelled' : 'done' }; },
    dropSteer: id => drops.push(id), settleCronWorkitem: (id, reason) => settles.push(reason),
    validateWorkshopManifest: async () => null, swallow: () => () => {}
  };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  const pending = ctx.runWorkshopShift('agent', suppliedSignal ? { signal: controller.signal } : {});
  if (mode === 'held-stop') {
    await scanEntered;
    A.eq(table.size(), 1, 'held scan remains admitted');
    A.eq(table.groupBusy('agent'), true, 'held scan still blocks the group');
    if (suppliedSignal) controller.abort();
    else A.eq(table.stop('workshop-proof', 'test'), true, 'held local scan is reachable through its owned stop');
    A.eq(table.size(), 1, 'abort does not claim physical work already released');
    finishScan();
  }
  let result, error;
  try { result = await pending; } catch (e) { error = e; }
  const label = mode + (suppliedSignal ? '/supplied' : '/local');
  A.eq(error && error.message, undefined, label + ': setup failure follows the existing failed-shift result path');
  A.eq(table.size(), 0, label + ': admission released on every exit');
  A.eq(table.groupBusy('agent'), false, label + ': no stale group blocker');
  A.eq(table.owned('workshop-proof'), false, label + ': no stranded owner');
  const setupFault = ['read-fault', 'write-fault', 'scan-fault', 'prompt-fault'].includes(mode);
  A.eq(calls, setupFault ? 0 : 1, label + ': setup failure never launches the model');
  const reason = mode === 'held-stop' ? 'stopped' : mode === 'success' ? 'no-manifest' : 'run-failed';
  A.eq(result && result.reason, reason, label + ': truthful shift outcome');
  A.eq(releases, [{ id: 'agent', runId: 'workshop-proof', failed: mode !== 'held-stop' }], label + ': backlog claim released with existing failure/stop semantics');
  A.eq(notes.map(n => n.reason), [reason], label + ': last shift records the actual outcome');
  A.eq(drops, ['workshop-proof'], label + ': steering cleanup runs once');
  A.eq(settles.length, 1, label + ': work-item cleanup runs once');
  if (mode === 'read-fault') A.ok(reads > 0 && writes === 0, 'real resilient store refuses unreadable focus before writing');
  if (mode === 'write-fault') A.eq(writes, 1, 'real focus resolver reached the failing durable write');
}

(async () => {
  for (const mode of ['read-fault', 'write-fault', 'scan-fault', 'prompt-fault', 'core-fault', 'success', 'held-stop']) await check(mode, false);
  await check('held-stop', true);
  A.report('run-table-workshop-admission');
})().catch(e => { A.ok(false, e.stack); A.report('run-table-workshop-admission'); });
