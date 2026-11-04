'use strict';
/* Private two-owner adoption. A retained actual entry becomes a saved cursor,
   never an invocation permission. Both persistence owners remain the existing
   LineJobs/line-spend owners; no run, retry executor or publication lives here. */
const { isDeepStrictEqual } = require('node:util');
const C = require('./line-continuation.js');
const J = require('./linejobs.js');
function makeEntryAdoption(o) {
  const { read, write, requireAccounting, note, receiptProof, chain, authority } = o || {};
  if (![read, write, requireAccounting, note, receiptProof].every(f => typeof f === 'function')) throw new Error('entry adoption requires its existing canonical owners');
  function fresh(id, revision, expected) {
    const state = read(), job = J.get(state, id);
    if (!job) throw new Error('entry adoption has no canonical job');
    const entry = C.adoptableEntry(job.entryAdmission, job), enrollment = requireAccounting(state);
    if (!Number.isSafeInteger(revision) || revision < 1 || entry.revision !== revision) throw new Error('entry adoption revision changed');
    if (!enrollment || enrollment.state !== 'confirmed' || enrollment.ledgerId !== entry.ledgerId) throw new Error('entry adoption enrollment is not confirmed');
    if (expected && !isDeepStrictEqual(entry, expected)) throw new Error('entry adoption evidence changed');
    return { state, job, entry };
  }
  function initialize(current, phase) {
    // The trusted composition-root adapter is synchronous/read-only. Missing,
    // promises, serialized flags and any non-true result refuse. Production is
    // deliberately null until the shared saved-floor authority contract exists.
    if (typeof authority !== 'function' || authority({ phase, job: current.job, entry: current.entry }) !== true) {
      throw new Error('entry adoption has no fresh current saved ownership');
    }
    if (!chain || typeof chain.initializeEntry !== 'function') throw new Error('entry adoption has no existing chain initializer');
    return C.seedEntryContinuation(current.entry, current.job, chain.initializeEntry(current.entry));
  }
  function adopt(id, revision) {
    let current = fresh(id, revision);
    const entry = current.entry, next = initialize(current, 'before-ledger');
    current = fresh(id, revision, entry);
    // Validate the whole mutation before touching even a zero-dollar receipt.
    const prior = J.adoptEntry(current.state, id, revision, next);
    const observed = entry.observation, expectedReceipt = { jobId: id, runId: entry.binding.entryRunId,
      day: Math.floor(observed.endedAt / 86400000), usd: observed.usd };
    const observedRun = { jobId: id, runId: entry.binding.entryRunId, endedAt: observed.endedAt };
    function prove() {
      const proof = receiptProof(entry.binding.lineId, observed.usd, observedRun, entry.ledgerId);
      if (!proof || proof.confirmed !== true || !isDeepStrictEqual(proof.receipt, expectedReceipt)) throw new Error('entry adoption original-day receipt is unconfirmed');
    }
    if (!prior.replayed) {
      const noted = note(entry.binding.lineId, observed.usd, observedRun);
      if (!noted || noted.confirmed !== true || !isDeepStrictEqual(noted.receipt, expectedReceipt)) throw new Error('entry adoption original-day receipt is unconfirmed');
    }
    prove(); // A saved pair must never recreate its disappeared receipt via note.
    current = fresh(id, revision, entry);
    if (!isDeepStrictEqual(initialize(current, 'before-job-write'), next)) throw new Error('entry adoption current initializer changed');
    prove();
    let replayed = false, storageError = null;
    try {
      write(state => {
        const job = J.get(state, id), enrollment = requireAccounting(state);
        if (!job || !enrollment || enrollment.state !== 'confirmed' || enrollment.ledgerId !== entry.ledgerId
          || !isDeepStrictEqual(C.adoptableEntry(job.entryAdmission, job), entry)) throw new Error('entry adoption authority changed before canonical write');
        prove();
        const result = J.adoptEntry(state, id, revision, next);
        replayed = result.replayed;
        return result.replayed ? null : result;
      });
    } catch (error) { storageError = error; }
    // Even a returned readback can be a different valid cursor. Re-prove the
    // exact intended pair, including after a landed write whose ACK was lost.
    let accepted;
    try {
      accepted = fresh(id, revision, entry);
      const pair = C.demandEntryPair(accepted.entry, accepted.job.continuation, accepted.job);
      if (!isDeepStrictEqual(pair.continuation, next)) throw new Error('entry adoption canonical readback changed');
      prove();
    } catch (error) {
      if (storageError) error.storageError = storageError;
      throw error;
    }
    return { confirmed: true, replayed, job: accepted.job, entry: accepted.entry,
      continuation: next, receipt: expectedReceipt, storageError };
  }
  return { adopt };
}
module.exports = { makeEntryAdoption };
