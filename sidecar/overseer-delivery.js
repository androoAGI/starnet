'use strict';
// Publish a successful review from its complete durable execution, never from the run's bounded preview.
// The review keeps its original run id until this strict write succeeds, including after a restart.
const TurnDelivery = require('./turn-delivery.js');
const TurnKinds = require('../frontend/app/turnkinds.js');
const RunOutcome = require('../frontend/app/runoutcome.js');
const { DELIVERY_TEXT_MAX } = require('./runstore.js');
function publish(deps, review, run) {
  if (!run || !RunOutcome.ofRow(run).ok || run.runId !== review.reviewRunId ||
      run.streamId !== review.parentStreamId || run.agentId !== review.agentId) {
    throw new Error('The completed review does not prove its original conversation and agent.');
  }
  const store = deps.transcriptStore;
  const rows = store.view('proof', review.parentStreamId, { sourceRunId: run.runId, complete: true });
  if (!Array.isArray(rows)) throw new Error('The complete review transcript is unavailable.');
  const provenance = row => row.taint ? { taint: row.taint } : row.taintKnown === true ? { taint: null } : {};
  const prior = rows.find(row => row && row.kind === 'delivery');
  // A previously published row remains the only answer, even after an undo or session deletion.
  // The shared writer proves its identity and returns it without appending or reviving any bytes.
  if (prior) return TurnDelivery.write(store, { streamId: run.streamId, agentId: run.agentId, runId: run.runId,
    text: prior.content, ...provenance(prior) });
  // Delivery rows belong to publication; the last execution row must itself be the finished prose answer.
  const execution = rows.filter(row => row && row.kind !== 'delivery' && row.kind !== 'retract');
  const final = execution[execution.length - 1];
  if (!final || final.kind !== 'station' || final.role !== 'assistant' || final.toolCalls ||
      final.streamId !== run.streamId || final.agentId !== run.agentId || final.sourceRunId !== run.runId ||
      final.turnId !== TurnKinds.runTurnId(run.runId) || final.idFrom === 'collision' ||
      !Number.isSafeInteger(final.rowId) || final.rowId <= 0 || typeof final.content !== 'string' ||
      !final.content.trim() || final.content.length >= TurnKinds.LEGACY_FINAL_CONTENT_MAX) {
    throw new Error('The complete final review answer is not durably proven.');
  }
  const identity = store.cacheRetractions(run.streamId, [final.rowId]);
  if (!identity || identity.state !== 'done' || !Array.isArray(identity.retracted) || typeof store.isForgotten !== 'function') {
    throw new Error('The final review row identity is unavailable.');
  }
  if (identity.retracted.includes(final.rowId) || store.isForgotten(final)) {
    throw Object.assign(new Error('The review answer was removed before publication.'), { code: 'REVIEW_REMOVED' });
  }
  const text = String(deps.redact(final.content)).trim();
  const savedPreview = String(run.deliveryText || '');
  const preview = String(deps.redact(savedPreview)).trim();
  if (!preview || (savedPreview.length < DELIVERY_TEXT_MAX ? text !== preview : !text.startsWith(preview))) {
    throw new Error('The final review answer disagrees with its saved outcome.');
  }
  return TurnDelivery.write(store, { streamId: run.streamId, agentId: run.agentId, runId: run.runId, text, ...provenance(final) });
}
module.exports = { publish };
