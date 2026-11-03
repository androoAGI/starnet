'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), vm = require('node:vm');
const Store = require('../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const Merge = require('../frontend/app/turnmerge.js');
const Dual = require('../sidecar/turn-dual.js');
const { makeRemoteHost } = require('../sidecar/remote/host.js');
const source = fs.readFileSync(require.resolve('../frontend/app/chat.js'), 'utf8');
const reconcile = A.fnBody(source, 'async function reconcileServerHistory(');
A.ok(reconcile.length > 1000 && reconcile.length < 14000, 'fixture lifts the bounded actual desktop reconciliation function');
const T = 'cached_undo_001', dual = Dual.make({ now: () => 10, hash: value => value });
function fixture() {
  const io = makeMemoryTranscriptIo();
  const store = Store.makeTranscriptStore({ io, clock: { now: () => 10 } });
  const first = store.appendStrict({ streamId: 's', agentId: 'agent', sourceRunId: 'old-run', role: 'user', content: 'UNDO_SENTINEL', turnId: T, directive: true });
  const last = store.appendStrict({ streamId: 's', agentId: 'agent', sourceRunId: 'old-run', role: 'assistant', content: 'OLD_ANSWER', turnId: T });
  const local = [first, last, { streamId: 'foreign', rowId: first.rowId, role: 'user', content: 'FOREIGN_COPY' }];
  store.retract({ streamId: 's', turnId: T, reason: 'undo' });
  return { store, io, local, first, last };
}
function page(f, deferProof) {
  const ws = { id: 's', history: f.local.slice() }, historyLoads = new WeakMap(), calls = [], notes = [];
  const read = { history: ws.history }, context = vm.createContext({ Date, AbortController, setTimeout, clearTimeout,
    Channels: { isBusy: () => false }, Workstreams: { get: () => ws }, historyLoads, activeWs: null, historyPinSeq: 1,
    App: { persist() {} }, TurnMerge: Merge, stationModes: {}, placeSteerNotes: rows => rows,
    noteContinuity: (_ws, note) => notes.push(note), redactAsk: rows => rows, redactedTexts: async () => new Map(),
    fetch: async (url, options) => {
      calls.push(url);
      if (url.startsWith('/api/transcript?')) return { ok: true, json: async () => dual.project('s', f.store.view('display', 's', { limit: 200 })) };
      if (deferProof) await deferProof();
      const body = JSON.parse(options.body), proof = f.store.cacheRetractions(body.streamId, body.rowIds);
      return { ok: proof.state === 'done', json: async () => ({ streamId: 's', retracted: proof.retracted }) };
    } });
  historyLoads.set(ws, read);
  vm.runInContext(reconcile + '\nthis.reconcile = reconcileServerHistory;', context);
  return { ws, read, historyLoads, calls, notes, run: () => context.reconcile(ws, 1, read) };
}
(async () => {
  const f = fixture(), proof = f.store.cacheRetractions('s', [f.first.rowId, f.last.rowId, f.first.rowId]);
  A.eq(proof, { state: 'done', retracted: [f.first.rowId, f.last.rowId] }, 'cache proof deduplicates identities and returns no stored text');
  A.eq(f.store.cacheRetractions('wrong', [f.first.rowId]).state, 'unknown', 'wrong-stream cache IDs have no removal authority');
  A.eq(f.store.cacheRetractions('s', [999999]).state, 'unknown', 'missing durable IDs are unknown, never an empty retract set');
  A.eq(f.store.cacheRetractions('s', [0]).state, 'invalid', 'malformed IDs are rejected');
  A.eq(f.store.cacheRetractions('s', Array(2001).fill(f.first.rowId)).state, 'invalid', 'oversized input is rejected before deduplication');
  const p = page(f);
  A.eq(await p.run(), true, 'the actual page completes its bounded cache proof');
  A.eq(p.calls.filter(url => url === '/api/turn-identity/retractions').length, 1, 'one cache proof call serves the assembly');
  A.eq(p.ws.history.map(row => row.content), ['FOREIGN_COPY'], 'a stale desktop cache cannot resurrect undone rows; foreign copy is preserved');
  const host = makeRemoteHost({ now: () => 10, deskSessions: () => [{ id: 's', history: f.local }], transcript: f.store,
    turnDual: dual, turnProjection: (stream, turns) => dual.project(stream, turns), redact: value => value });
  A.eq((await host.thread({ streamId: 's', limit: 100 })).map(row => row.content), ['FOREIGN_COPY'], 'the actual phone uses the same affirmative cache authority');
  let batchCalls = 0, batchSize = 0;
  const clean = f.store.appendStrict({ streamId: 'other', role: 'user', content: 'OTHER_PREVIEW' });
  const listingStore = Object.assign({}, f.store, { cacheRetractionsBatch: requests => { batchCalls++; batchSize = requests.length; return f.store.cacheRetractionsBatch(requests); } });
  const listing = makeRemoteHost({ now: () => 10, roster: () => [], transcript: listingStore,
    deskSessions: () => [{ id: 's', title: 'old', history: f.local }, { id: 'other', title: 'other', history: [clean] }], redact: value => value });
  const summaries = await listing.threads({ limit: 10 });
  A.eq([batchCalls, batchSize], [1, 3], 'two desktop streams share one cache proof assembly with only their unique owned IDs');
  A.eq(summaries.find(row => row.streamId === 's').preview, 'FOREIGN_COPY', 'thread-list preview cannot revive an undone cached question');
  A.eq(summaries.find(row => row.streamId === 'other').preview, 'OTHER_PREVIEW', 'request order and another stream preview are preserved');
  A.eq(f.store.cacheRetractionsBatch([{ streamId: 's', rowId: clean.rowId }, { streamId: 'other', rowId: clean.rowId }]).state,
    'invalid', 'one row ID cannot carry authority for two streams in a batch');
  let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const late = page(f, async () => { reached(); await gate; });
  const pending = late.run(); await waiting;
  late.historyLoads.set(late.ws, { history: late.ws.history });
  release();
  A.eq(await pending, false, 'a superseded load cannot publish after its delayed cache proof');
  A.eq(late.ws.history, f.local, 'the stale load leaves the replacement cache untouched');
  const missing = page(Object.assign({}, f, { local: [{ streamId: 's', rowId: 99999, role: 'user', content: 'UNPROVEN' }] }));
  A.eq(await missing.run(), false, 'unknown authority refuses reconciliation');
  A.eq(missing.ws.history.map(row => row.content), ['UNPROVEN'], 'unknown authority never silently claims removal or replaces cache');
  A.eq(missing.read.serverFailed, true, 'send readiness can distinguish proof failure from successful empty history');
  const retry = Store.makeTranscriptStore({ io: makeMemoryTranscriptIo(), clock: { now: () => 10 } });
  const d = retry.appendStrict({ streamId: 's', role: 'user', content: 'ask', turnId: T, directive: true });
  const answer = retry.appendStrict({ streamId: 's', role: 'assistant', content: 'attempt', turnId: T });
  retry.retract({ streamId: 's', turnId: T, reason: 'retry' });
  A.eq(retry.cacheRetractions('s', [d.rowId, answer.rowId]).retracted, [], 'Q8 retry narration is never advertised as a display removal');
  f.io.appendDurable({ streamId: 's', rowId: f.first.rowId, role: 'user', content: 'collision' });
  A.eq(f.store.cacheRetractions('s', [f.first.rowId]).state, 'unknown', 'a collided cache key has no authority');
  A.report('turn-retract.cache');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
