/* Run the actual workshop/focus persistence seams with a real RunTable. Faults enter at the filesystem boundary. */
'use strict';
const vm = require('node:vm');
const path = require('node:path');
const A = require('./_assert.js');
const { sidecarFunctionSource } = require('./helpers/source');
const RunTable = require('../sidecar/run-table.js');
const RunOutcome = require('../frontend/app/runoutcome.js');
const nightfocus = require('../sidecar/nightfocus.js');
const Persist = require('../sidecar/persist/index.js');
const { holdOf, heldWhy } = require('../sidecar/routing/saved-hold.js');
const names = ['runWorkshopShift', 'resolveNightFocus', 'saveNightFocusState', 'awayBuildStopped', 'awayBuildRoom'];
const source = names.map(name => {
  const text = sidecarFunctionSource(name);
  A.ok(text.length > 60 && text.length < 14000, name + ': bounded actual source located');
  return text;
}).join('\n');

async function check(mode, suppliedSignal) {
  const table = RunTable.makeRunTable({ now: () => 1 });
  const notes = [], releases = [], settles = [], drops = [];
  let calls = 0, writes = 0, reads = 0, claims = 0, finishScan, enteredScan;
  // a saved floor that cannot be proved right now: held at the entry gate, or going held between the gate and the room read
  const hold = { status: 'corrupt', why: heldWhy('corrupt') };
  const heldError = Object.assign(new Error('Saved routing authority is held: corrupt'), { held: true, status: 'corrupt', why: hold.why });
  const scanEntered = new Promise(resolve => { enteredScan = resolve; });
  const scan = new Promise(resolve => { finishScan = resolve; });
  const controller = new AbortController();
  const fs = { readFileSync() {
    reads++;
    throw Object.assign(new Error(mode === 'read-fault' ? 'focus unreadable' : 'absent'), { code: mode === 'read-fault' ? 'EACCES' : 'ENOENT' });
  } };
  const ctx = {
    console, Date, Object, String, AbortController, crypto: { randomUUID: () => 'workshop-proof' },
    runTable: table, RunOutcome, nightfocus, fs, path,
    NIGHTFOCUS_STATE_FILE: path.resolve('fixture-nightfocus.json'), nightFocusState: nightfocus.fresh(Date.now()),
    writeFileDurable() { writes++; if (mode === 'write-fault') throw new Error('focus durable write failed'); },
    reconcileNightFocusAuthority() {}, nightFocusInputs: () => ({ now: Date.now(), goal: { text: 'Build the requested change' } }),
    workshopOf: () => true, isRunLive: id => table.ownerLive(id),
    routingHold: () => (mode === 'held' ? hold : null), holdOf,
    workshopStore: {
      claimNext: async () => { claims++; return { id: 'item', title: 'Build it' }; },
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
    admit: { stationFor: () => { if (mode === 'held-midway') throw heldError; return null; } },
    runOnce: async o => { calls++; if (mode === 'core-fault') throw new Error('core boundary fault'); return { reason: o.signal.aborted ? 'cancelled' : 'done' }; },
    dropSteer: id => drops.push(id), settleCronWorkitem: (id, reason) => settles.push(reason),
    validateWorkshopManifest: async () => null, swallow: () => () => {}
  };
  ctx.saveResilient = Persist.host({ fs, path, writeDurable: ctx.writeFileDurable }).saveResilient;
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
  if (mode === 'held' || mode === 'held-midway') {
    // INVARIANT held-is-no-failed-build: a shift on a saved floor that cannot be proved right now is REFUSED before it claims anything, so no attempt is counted
    // and nothing parks (read inside the run, the typed hold landed in `threw` and was released as a failed build: two of them parked the item)
    A.eq(error && error.message, undefined, label + ': refused through the result, not thrown');
    A.eq([result && result.fired, result && result.reason, result && result.why], [false, 'routing-held', hold.why], label + ': the shift is held, in the hold\'s own words');
    A.eq([claims, calls, releases.length, table.size(), drops.length, settles.length, table.groupBusy('agent')], [0, 0, 0, 0, 0, 0, false], label + ': nothing claimed, admitted, run or released: no attempt is counted');
    A.eq(notes.map(n => n.reason), ['routing-held'], label + ': the away card\'s last shift says held, not broken');
    return;
  }
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
  await check('held', false);
  await check('held-midway', false);
  A.report('run-table-workshop-admission');
})().catch(e => { A.ok(false, e.stack); A.report('run-table-workshop-admission'); });
