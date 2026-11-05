'use strict';
const Kinds = require('../frontend/app/turnkinds.js');
/* THE ACCEPTED ANSWER IS THE WORKER'S WORDS, so it quotes whatever the worker (and its repair run) read (turn identity commit 11): the sessions
   named on their run records (quotes + quotesAt; the saturated ['*'] included) become the final row's stamp, and a delete of one of them takes
   the row with it. {} when neither read another session. */
function quotedBy(records) {
  const entries = [];
  for (const r of records) {
    if (!r || !Array.isArray(r.quotes)) continue;
    r.quotes.forEach((id, i) => entries.push({ id, at: Array.isArray(r.quotesAt) && Number.isSafeInteger(r.quotesAt[i]) ? r.quotesAt[i] : 0 }));
  }
  return Kinds.quoteStamp(entries);
}
// A run's accepted answer cannot predate the run: bound the lookup so finalize never re-reads a long stream's
// whole lifetime (non-coordinator workers all write to 'global').
function runSince(source) {
  const at = [source.startedAt, source.ts].map(Number).filter(v => Number.isFinite(v) && v > 0);
  return at.length ? Math.min.apply(null, at) : 0;
}
// The accepted answer is committed in full before its bounded run envelope can claim recoverable completion.
// Separate stores are append-only: a ledger failure leaves the first accepted projection available for retry.
function finalizeDispatchDelivery(deps, runId, value) {
  const { runStore, transcriptStore, redact, hash } = deps;
  const source = runStore.deliverySource(runId);
  if (!source) throw new Error('The original dispatch execution is unavailable for durable delivery.');
  const text = String(redact(String(value.text || '')));
  const final = { state: 'final', text, reason: String(value.reason || 'error'), repairRunId: String(value.repairRunId || ''),
    textLength: text.length, textSha256: hash(text) };
  const streamId = source.streamId || 'global';
  const rows = transcriptStore.view('proof', streamId, { sourceRunId: runId, dispatchState: 'final', limit: 1, strict: true, since: runSince(source) });
  const prior = rows.find(row => row.dispatchState === 'final');
  const saved = source.dispatchDelivery;
  if (prior && !require('./transcriptstore.js').isFinalDeliveryRow(prior, hash, saved)) throw new Error('The first accepted dispatch projection is incomplete or unverifiable.');
  if (prior && (prior.content !== text || prior.dispatchReason !== final.reason
      || (prior.dispatchRepairRunId != null && prior.dispatchRepairRunId !== final.repairRunId))) {
    throw new Error('The first accepted dispatch answer cannot be replaced.');
  }
  if (saved.state === 'final') {
    const same = saved.reason === final.reason && saved.repairRunId === final.repairRunId && saved.text === text.slice(0, 24000)
      && (saved.textSha256 ? saved.textLength === text.length && saved.textSha256 === final.textSha256
        : !!prior || (text.length < 24000 && saved.text === text));
    if (!same) throw new Error('The first finalized dispatch answer cannot be replaced or reconstructed from a preview.');
  }
  if (!prior) {
    const repair = final.repairRunId && runStore.latest(final.repairRunId);
    // THE ROW STAMP, not the first source: a worker that inherited its lead's bare attachment latch and then read a page or the saved
    // file has taintedBy = the attachment (which decays on replay) and rowTaintedBy = what it read (which does not). This row is the
    // only replayable row of the run, so it must carry the read. A record from before rowTaintedBy existed falls back to taintedBy.
    const written = transcriptStore.appendStrict({ streamId, agentId: source.agentId,
      role: 'assistant', sourceRunId: runId, content: text, dispatchState: 'final',
      dispatchPrompt: source.deliveryPrompt, dispatchReason: final.reason, dispatchRepairRunId: final.repairRunId,
      textLength: final.textLength, textSha256: final.textSha256, taint: source.rowTaintedBy || source.taintedBy || (repair && (repair.rowTaintedBy || repair.taintedBy)) || undefined, ...quotedBy([source, repair]) });
    if (!written || written.content !== text || written.textLength !== text.length || written.textSha256 !== final.textSha256
        || written.sourceRunId !== runId || written.streamId !== streamId) {
      throw new Error('The full accepted dispatch answer was not durably preserved.');
    }
  }
  return runStore.finalizeDelivery(runId, final);
}
// A crash between these two durable writes is repairable from the accepted projection alone.
// Never rerun the worker or infer completion from its raw transcript/24k preview.
function recoverPendingDeliveries(deps) {
  const { runStore, transcriptStore, hash } = deps;
  let recovered = 0;
  for (const source of runStore.all()) {
    if (!source.dispatchDelivery || source.dispatchDelivery.state !== 'pending') continue;
    try {
      const streamId = source.streamId || 'global';
      const prior = transcriptStore.view('proof', streamId, { sourceRunId: source.runId, dispatchState: 'final', limit: 1, strict: true, since: runSince(source) })[0];
      if (!prior) continue;
      if (!require('./transcriptstore.js').isFinalDeliveryRow(prior, hash) || !Number.isSafeInteger(prior.textLength)
          || prior.streamId !== streamId || prior.sourceRunId !== source.runId || !prior.dispatchReason) {
        throw new Error('Pending dispatch has no complete, verified accepted projection.');
      }
      runStore.finalizeDelivery(source.runId, { text: prior.content, reason: prior.dispatchReason,
        repairRunId: prior.dispatchRepairRunId || '', textLength: prior.textLength, textSha256: prior.textSha256 });
      recovered++;
    } catch (error) { if (typeof deps.onFailure === 'function') deps.onFailure(error); }
  }
  return recovered;
}
module.exports = { finalizeDispatchDelivery, recoverPendingDeliveries };
