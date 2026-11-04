'use strict';
/* Boot recovery precedes the live-set declaration in the actual composition root. Proof has no visibility dependencies. */
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
let Store = require('../sidecar/transcriptstore.js'), View = require('../sidecar/turn-view.js');
if (process.env.TURN_PROOF_BOOT_CONTROL) {
  function load(file, saved, view) {
    const filename = require.resolve('../sidecar/' + file), loaded = new Module(filename, module);
    loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    if (view) { const original = loaded.require.bind(loaded); loaded.require = id => id === './turn-view.js' ? view : original(id); }
    loaded._compile(fs.readFileSync(path.join(process.env.TURN_PROOF_BOOT_CONTROL, saved), 'utf8'), filename); return loaded.exports;
  }
  View = load('turn-view.js', 'turn-identity-c6-view-pre-proof-boot.js.txt');
  Store = load('transcriptstore.js', 'turn-identity-c6-store-pre-proof-boot.js.txt', View);
}
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeRunStore } = require('../sidecar/runstore.js');
const { recoverPendingDeliveries } = require('../sidecar/dispatch-delivery.js');
const source = require('./helpers/source.js').readSidecarIndex();
A.ok(source.indexOf('dispatchDeliveryStore.recoverPendingDeliveries(dispatchDeliveryDeps)') < source.indexOf('const transcriptLiveRuns = new Set()'),
  'the actual composition root recovers accepted deliveries before initializing the live-set binding');
function boot() {
  const errors = [], io = makeMemoryTranscriptIo();
  const store = Store.makeTranscriptStore({ io, hash, clock: { now: () => 100 }, live: () => transcriptLiveRuns,
    runOf() { throw new Error('proof consulted run visibility'); }, quotedMaterial() { throw new Error('proof consulted quote visibility'); } });
  const text = 'durable accepted answer';
  const row = store.appendStrict({ streamId: 's', agentId: 'agent', sourceRunId: 'accepted', role: 'assistant', content: text,
    dispatchState: 'final', dispatchPrompt: 'accepted prompt', dispatchReason: 'done', textLength: text.length, textSha256: hash(text) });
  const runStore = makeRunStore({ io: { readAll: () => [], append() {} }, clock: { now: () => 50 } });
  runStore.record({ runId: 'accepted', agentId: 'agent', streamId: 's', reason: 'done', startedAt: 50, dispatchDelivery: { state: 'pending' } });
  const recovered = recoverPendingDeliveries({ runStore, transcriptStore: store, hash, onFailure: error => errors.push(error.message) });
  A.eq(recovered, 1, 'actual recovery consumes accepted proof while the live-set binding is still uninitialized');
  A.eq(errors, [], 'proof has no early visibility-owner access');
  A.eq(runStore.latest('accepted').dispatchDelivery.state, 'final', 'boot settles the pending envelope from its durable accepted row');
  A.eq(runStore.latest('accepted').dispatchDelivery.textSha256, hash(text), 'recovered envelope retains exact accepted bytes');
  const transcriptLiveRuns = new Set(['accepted']);
  let liveRows, direct, calls = 0;
  A.notThrows(() => { liveRows = store.view('proof', 's'); }, 'proof does not ask the run-visibility owner after live-set initialization either');
  A.eq(liveRows && liveRows.map(item => item.rowId), [row.rowId], 'proof remains available while the row is live');
  A.notThrows(() => { direct = View.project('proof', [row], { runOf() { calls++; throw new Error('classification should not run'); },
    forgotten() { calls++; return true; }, live: new Set(['accepted']) }, {}); }, 'pure proof does not invoke classification owners');
  A.eq(direct && direct.map(item => item.rowId), [row.rowId], 'the pure proof projection preserves durable evidence without visibility filters');
  A.eq(calls, 0, 'proof skips classification as well as visibility predicates');
}
boot();
A.report('proof-view.boot');
