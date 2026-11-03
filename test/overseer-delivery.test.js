'use strict';
const A = require('./_assert.js');
const Store = require('../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const { DELIVERY_TEXT_MAX } = require('../sidecar/runstore.js');
const Kinds = require('../frontend/app/turnkinds.js');
const Delivery = require('../sidecar/overseer-delivery.js');
const review = { reviewRunId: 'saved-review', parentStreamId: 'home', agentId: 'agent' };
const redact = text => text.replace(/RAW_SECRET/g, '[redacted]');
function setup(text, changes) {
  const io = makeMemoryTranscriptIo();
  let stamp = 100, forgottenAt = 0;
  const store = Store.makeTranscriptStore({ io, clock: { now: () => ++stamp }, redact, deletedAt: () => forgottenAt });
  const run = { runId: review.reviewRunId, streamId: 'home', agentId: 'agent', reason: 'done', deliveryText: text.trim().slice(0, DELIVERY_TEXT_MAX) };
  store.appendStrict({ streamId: 'home', agentId: 'agent', sourceRunId: run.runId, turnId: Kinds.runTurnId(run.runId),
    kind: 'station', role: 'assistant', content: text, taint: 'untrusted worker', ...changes });
  const publish = () => Delivery.publish({ transcriptStore: store, redact }, review, run);
  return { store, run, publish, forget: () => { forgottenAt = stamp; } };
}
function refused(fn) { try { fn(); return false; } catch (_) { return true; } }
{
  const text = 'Reviewed findings: RAW_SECRET ' + 'complete finding '.repeat(2400) + 'END OF COMPLETE ANSWER';
  const f = setup(text); f.publish();
  const publicRows = f.store.view('model-replay', 'home', { shape: 'pairs' });
  A.eq(publicRows, [{ role: 'assistant', content: redact(text) }], 'publish the full durable review beyond the run preview cap');
  const rows = f.store.view('proof', 'home', { complete: true });
  A.eq(Store.rowTaint(rows.find(row => row.kind === 'delivery')), 'untrusted worker', 'publication retains the actual execution provenance');
  A.eq(f.publish(), { rowId: rows[1].rowId, turnId: rows[1].turnId }, 'lost acknowledgement reuses the first durable delivery identity');
  A.eq(f.store.view('proof', 'home', { complete: true }), rows, 'publication retry never duplicates or edits durable history');
}
for (const change of [{ streamId: 'other' }, { agentId: 'other' }, { reason: 'interrupted' }, { runId: 'other' },
  { deliveryText: 'Reviewed' }, { deliveryText: 'Different answer' }, { deliveryText: '' }]) {
  const f = setup('Reviewed findings in full'); Object.assign(f.run, change);
  A.ok(refused(f.publish), 'refuse mismatched or incomplete run proof ' + JSON.stringify(change));
  A.eq(f.store.view('proof', 'home', { complete: true }).length, 1, 'refused run proof leaves the execution prefix unchanged');
}
for (const change of [{ toolCalls: '[]' }, { kind: 'turn' }, { turnId: 'different' }, { content: 'Changed answer' },
  { content: 'x'.repeat(Kinds.LEGACY_FINAL_CONTENT_MAX) }]) {
  const f = setup('Reviewed findings in full', change);
  A.ok(refused(f.publish), 'refuse an unproven final prose row: ' + Object.keys(change)[0]);
}
{
  const f = setup('Reviewed findings in full');
  f.store.appendStrict({ streamId: 'home', agentId: 'agent', sourceRunId: review.reviewRunId, turnId: Kinds.runTurnId(review.reviewRunId), kind: 'station', role: 'tool', content: 'later tool result' });
  A.ok(refused(f.publish), 'never borrow an earlier answer when later execution has not produced a final prose row');
}
for (const removal of ['undo', 'forget']) {
  const f = setup('Reviewed findings in full');
  if (removal === 'undo') {
    const source = f.store.view('proof', 'home', { complete: true })[0];
    A.eq(f.store.retract({ streamId: 'home', rowIds: [source.rowId], reason: 'undo' }).state, 'done', 'the source undo is durably accepted');
  } else f.forget();
  A.ok(refused(f.publish), removal + ' before publication cannot authorize a fresh public row');
  A.eq(f.store.view('proof', 'home', { complete: true }).filter(row => row.kind === 'delivery').length, 0, removal + ' preserves absence of any public delivery');
}
{
  const f = setup('Reviewed findings in full');
  const first = f.publish();
  A.eq(f.store.retract({ streamId: 'home', rowIds: [first.rowId], reason: 'undo' }).state, 'done', 'undo of the public delivery is durable');
  f.forget();
  const before = f.store.view('proof', 'home', { complete: true });
  A.eq(f.publish(), first, 'reconciliation acknowledges the existing undone/forgotten publication');
  A.eq(f.store.view('proof', 'home', { complete: true }), before, 'acknowledging a removed public answer cannot append a new answer');
  A.eq(f.store.view('model-replay', 'home', { shape: 'pairs' }), [], 'the removed answer stays absent from canonical replay');
}
A.report('overseer-delivery');
