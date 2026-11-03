'use strict';
const A = require('./_assert.js');
const Store = require('../sidecar/transcriptstore.js');
const D = require('../sidecar/turn-directive.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const T = 'turn_retract_001';
function fixture(failWrite) {
  const io = makeMemoryTranscriptIo(), write = io.appendDurable;
  io.appendDurable = entry => { if (failWrite && entry.kind === 'retract') throw new Error('injected strict retract failure'); return write(entry); };
  const store = Store.makeTranscriptStore({ io, clock: { now: () => 10 } });
  const add = extra => store.appendStrict(Object.assign({ streamId: 's', agentId: 'agent', role: 'user', content: 'ask',
    kind: 'turn', turnId: T, sourceRunId: 'old-run', taint: null }, extra));
  const directive = add({ directive: true }), answer = add({ role: 'assistant', content: 'OLD_ATTEMPT' });
  return { io, store, add, directive, answer };
}
{
  const f = fixture();
  const first = f.store.retract({ streamId: 's', turnId: T, directiveRowId: f.directive.rowId, agentId: 'agent', runId: 'new-run', reason: 'retry' });
  A.eq(first.state, 'done', 'retry strictly appends a proved target set');
  A.eq(first.targets, [f.answer.rowId], 'retry preserves the original directive');
  const raw = f.store.view('proof', 's', { limit: 20 });
  A.eq(raw.find(row => row.kind === 'retract').reason, 'retry', 'the persisted reason survives the actual row builder');
  A.eq(raw.filter(row => row.kind !== 'retract').map(row => row.content), ['ask', 'OLD_ATTEMPT'], 'supersession never rewrites original rows');
  A.eq(f.store.view('display', 's', { limit: 20 }).map(row => row.content), ['ask', 'OLD_ATTEMPT'], 'Q8 default keeps prior narration visible');
  A.eq(f.store.view('model-replay', 's', { shape: 'prose', limit: 20 }).map(row => row.content), ['ask'], 'the old attempt cannot enter replay');
  A.eq(f.store.view('recall', 's', { limit: 20 }).map(row => row.content), ['ask'], 'the old attempt cannot enter recall');
  A.eq(f.store.retract({ streamId: 's', turnId: T, reason: 'retry' }).targets, [], 'repeated retry without new output writes no redundant retract');
  f.add({ role: 'assistant', content: 'NEW_ATTEMPT', sourceRunId: 'new-run' });
  const undone = f.store.retract({ streamId: 's', turnId: T, reason: 'undo' });
  A.eq(undone.targets.length, 3, 'undo upgrades prior retry targets and removes the full turn');
  A.eq(f.store.view('display', 's', { limit: 20 }), [], 'undo hides every attempt in display');
  A.eq(f.store.findTurn('s', T, { turnRowId: f.directive.rowId }).state, 'unknown', 'a named old directive cannot evade its later undo');
  A.eq(f.store.retract({ streamId: 's', turnId: T, reason: 'undo' }).targets, [], 'undo is idempotent');
}
{
  const f = fixture(), before = f.store.count();
  A.eq(f.store.retract({ streamId: 'other', rowIds: [f.answer.rowId], reason: 'undo' }).state, 'unknown', 'another stream cannot retract a row');
  A.eq(f.store.retract({ streamId: 's', rowIds: [0, f.answer.rowId], reason: 'undo' }).state, 'invalid', 'one invalid target rejects the whole request');
  A.eq(f.store.retract({ streamId: 's', turnId: T, rowIds: [f.answer.rowId], reason: 'undo' }).state, 'invalid', 'mixed selectors are rejected');
  A.eq(f.store.retract({ streamId: 's', turnId: T, directiveRowId: f.answer.rowId, reason: 'retry' }).state, 'unknown', 'retry must name the actual original directive');
  A.eq(f.store.count(), before, 'invalid or unproven requests never append a partial retract');
  for (let i = 0; i < 500; i++) f.add({ role: 'assistant', content: 'extra ' + i });
  const full = f.store.count();
  A.eq(f.store.retract({ streamId: 's', turnId: T, reason: 'retry' }).state, 'unknown', 'more than 500 targets is not silently clipped');
  A.eq(f.store.count(), full, 'capacity refusal has no mutation');
}
{
  const f = fixture();
  for (let i = 0; i < 499; i++) f.add({ role: 'assistant', content: 'old target ' + i });
  A.eq(f.store.retract({ streamId: 's', turnId: T, reason: 'retry' }).targets.length, 500, 'the maximum one-row target batch is accepted');
  const next = f.add({ role: 'assistant', content: 'NEXT_ATTEMPT', sourceRunId: 'next-run' });
  A.eq(f.store.retract({ streamId: 's', turnId: T, reason: 'retry' }).targets, [next.rowId], 'already retracted attempts do not exhaust a later retry target batch');
}
{
  const f = fixture(true), before = f.store.count(), failures = [], keys = [];
  const found = f.store.findTurn('s', T);
  const opts = { found, streamId: 's', agentId: 'agent', runId: 'new-run-001', retryOf: T,
    directive: D.capture([{ role: 'user', content: 'ask' }]), latestUserText: () => 'ask',
    rekey: key => keys.push(key), onRetractFailure: error => failures.push(error.message) };
  A.eq(D.reuse(f.store, opts), null, 'a failed strict append is reported without throwing from reuse');
  A.eq(failures, ['injected strict retract failure'], 'the host receives the real persistence failure');
  A.eq(keys, [], 'persistence failure never invents a new turn');
  A.eq(f.store.count(), before, 'failed append leaves the original durable rows intact');
  failures.length = 0;
  A.eq(D.reuse(f.store, Object.assign({}, opts, { retryOf: undefined })).rowId, f.directive.rowId, 'idempotent resend needs no retract write');
  A.eq(failures, [], 'resend does not touch the failing retract writer');
  A.eq(D.reuse(f.store, Object.assign({}, opts, { directive: D.capture([{ role: 'user', content: 'different' }]), latestUserText: () => 'different' })), null, 'different input does not reuse');
  A.eq(failures, [], 'different input never attempts the failing writer');
  A.eq(keys.length, 1, 'input conflict still rekeys normally');
}
A.report('turn-retract');
