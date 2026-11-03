/* One durable public reply, distinct from a run's hidden execution rows. Pure over the Store owner.
   Text is already redacted by the caller; Store applies its normal persistence redaction as well. */
'use strict';
const Kinds = require('../frontend/app/turnkinds.js');
const SID = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT = /^[A-Za-z0-9_-]{1,40}$/;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
function unavailable(message) { return Object.assign(new Error(message), { code: 'TRANSCRIPT_UNVOUCHED' }); }
function write(store, input) {
  const o = input || {}, turnId = Kinds.runTurnId(o.runId), hasTaint = Object.prototype.hasOwnProperty.call(o, 'taint');
  if (!store || typeof store.view !== 'function' || typeof store.appendStrict !== 'function') throw unavailable('Delivery transcript owner is unavailable');
  if (typeof o.streamId !== 'string' || !SID.test(o.streamId) || typeof o.agentId !== 'string' || !AGENT.test(o.agentId) ||
      typeof o.runId !== 'string' || o.runId.length > 200 || !turnId || typeof o.text !== 'string' || o.text.length > Kinds.LEGACY_FINAL_CONTENT_MAX ||
      (hasTaint && o.taint !== null && typeof o.taint !== 'string') ||
      (o.existingOnly !== undefined && typeof o.existingOnly !== 'boolean')) {
    throw new Error('Invalid canonical delivery');
  }
  // Match Store's exact200-character taint stamp. Missing remains unverified; only a caller's
  // explicitly proved null/empty value may declare clean provenance.
  const taint = hasTaint ? (o.taint === null ? null : o.taint.slice(0, 200) || null) : undefined;
  // Complete is deliberate: a recent tail cannot prove that this run was never delivered. Proof
  // includes forgotten/retracted rows, so retrying publication cannot resurrect an undone delivery.
  const proof = store.view('proof', o.streamId, { sourceRunId: o.runId, complete: true });
  if (!Array.isArray(proof)) throw unavailable('Delivery transcript proof is unavailable');
  const delivered = proof.filter(row => row && row.kind === 'delivery');
  if (delivered.length) {
    const row = delivered[0];
    if (delivered.length !== 1 || row.streamId !== o.streamId || row.sourceRunId !== o.runId || row.agentId !== o.agentId ||
        row.role !== 'assistant' || row.turnId !== turnId || !positiveId(row.rowId) || row.idFrom === 'collision') {
      throw unavailable('Delivery transcript identity is ambiguous');
    }
    const recordedTaint = typeof row.taint === 'string' && row.taint ? row.taint.slice(0, 200) : row.taintKnown === true ? null : undefined;
    if (hasTaint && recordedTaint !== taint) throw unavailable('Delivery transcript provenance conflicts with the source');
    // The existing bounded identity owner disavows globally collided or missing durable ids.
    const identity = typeof store.cacheRetractions === 'function' && store.cacheRetractions(o.streamId, [row.rowId]);
    if (!identity || identity.state !== 'done') throw unavailable('Delivery transcript identity could not be proved');
    return { rowId: row.rowId, turnId: row.turnId };
  }
  // A released transport receipt or a prior session marker can only confirm its old
  // publication. Absence is unknown; it cannot authorize a new row in today's chat.
  if (o.existingOnly === true) throw unavailable('The prior delivery could not be confirmed');
  const row = store.appendStrict({ streamId: o.streamId, agentId: o.agentId, role: 'assistant', kind: 'delivery',
    content: o.text, sourceRunId: o.runId, turnId, ...(hasTaint ? { taint: taint } : {}) });
  if (!row || !positiveId(row.rowId) || row.streamId !== o.streamId || row.sourceRunId !== o.runId || row.kind !== 'delivery' || row.turnId !== turnId) {
    throw unavailable('Delivery append has no durable identity');
  }
  return { rowId: row.rowId, turnId: row.turnId };
}
module.exports = { write };
