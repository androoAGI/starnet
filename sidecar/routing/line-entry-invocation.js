/* Private bridge from one freshly saved intent to one genuine host invocation.
   No routing authority, public entry point, walker, booking or replay executor. */
'use strict';
const C = require('./line-continuation.js');
const Verdict = require('./verdict.js');
const RunOutcome = require('../../frontend/app/runoutcome.js');
const { isDeepStrictEqual } = require('node:util');
const copy = value => JSON.parse(JSON.stringify(value));
function refusal(message, cause) {
  const e = new Error(message); e.code = 'ELINE_ENTRY_INVOCATION';
  if (cause) e.cause = cause;
  return e;
}
function makeEntryInvocation(deps) {
  const d = deps || {};
  if (typeof d.prepare !== 'function' || typeof d.checkpoint !== 'function' || typeof d.run !== 'function') throw new Error('entry invocation requires its existing job and run owners');
  const marker = Symbol('host line entry invocation');
  function context(o) { return o && o[marker] || null; }
  function identity(o, receipt) {
    const b = receipt.binding, last = Array.isArray(o.messages) && o.messages[o.messages.length - 1];
    if (o.runId !== b.entryRunId || o.workitemId !== b.workitemId || o.agentId !== b.entryNode.agentId ||
        (o.dockId || null) !== b.entryNode.dockId || (o.streamId || '') !== b.streamId || o.lineId !== b.lineId ||
        !last || last.role !== 'user' || last.content !== receipt.input.text) throw refusal('The invocation does not match its saved entry');
  }
  function ceiling(options, receipt) {
    const original = receipt.limits.maxUsd, current = options.ceilingUsd;
    if (!(original > 0) || receipt.limits.maxUsdPerDay === 0 ||
        (current !== undefined && (typeof current !== 'number' || !Number.isFinite(current) || current <= 0))) throw refusal('The entry has no remaining permitted dollar ceiling');
    options.ceilingUsd = current === undefined ? original : Math.min(original, current);
    // Existing billing clamps a positive dollar ceiling to at least one cent.
    // This private adapter may refuse an unsupported bound, never widen it.
    if (options.ceilingUsd < 0.01) throw refusal('The saved entry ceiling is below the supported host dollar bound');
  }
  async function authority(receipt, options, phase) {
    if (typeof d.authority !== 'function') throw refusal('Saved entry authority is unavailable');
    if (options.signal && options.signal.aborted) throw refusal('The entry was stopped before invocation');
    // This private injected owner is deliberately not wired to a posted routing plan.
    if (await d.authority({ receipt: copy(receipt), options, phase }) !== true) throw refusal('Current saved entry authority refused');
    if (options.signal && options.signal.aborted) throw refusal('The entry was stopped before invocation');
    ceiling(options, receipt);
  }
  function saved(id, request) {
    const result = d.prepare(id, request);
    if (!result || !result.job || !result.receipt || typeof result.replayed !== 'boolean') throw refusal('The saved entry could not be confirmed');
    return Object.assign({}, result, { receipt: C.demandEntry(result.receipt, result.job) });
  }
  async function enter(options) {
    const cap = context(options);
    if (!cap || cap.closed || cap.entered || cap.entering) throw refusal('The private entry invocation is unavailable or already used');
    cap.entering = true; // consumed before the fresh authority await, including a refused attempt
    identity(options, cap.receipt);
    await authority(cap.receipt, options, 'dequeue');
    identity(options, cap.receipt);
    const current = saved(cap.id, cap.request);
    if (current.receipt.state !== 'intent' || current.receipt.revision !== cap.receipt.revision) throw refusal('The entry changed before invocation');
    cap.entered = true;
  }
  function observeOwned(options, facts) {
    const cap = context(options);
    if (!cap) return null;
    if (cap.closed || !cap.entered || cap.observed) throw refusal('The entry observation has no live owning invocation');
    identity(options, cap.receipt);
    const f = facts || {}, b = cap.receipt.binding;
    if (f.runId !== b.entryRunId || f.workitemId !== b.workitemId || f.agentId !== b.entryNode.agentId ||
        (f.streamId || '') !== b.streamId || f.lineId !== b.lineId || (f.dockId || null) !== b.entryNode.dockId) throw refusal('The terminal evidence belongs to another entry');
    if (typeof f.text !== 'string' || typeof f.usageMissing !== 'boolean' || typeof f.unpriced !== 'boolean' || !RunOutcome.isOutcome(f.outcome) ||
        !Number.isSafeInteger(f.endedAt) || f.endedAt < cap.receipt.at || typeof f.usd !== 'number' || !Number.isFinite(f.usd) || f.usd < 0) throw refusal('The actual entry terminal evidence is incomplete');
    cap.terminal = { outcome: f.outcome, usd: f.usd, usageMissing: f.usageMissing, unpriced: f.unpriced === true, endedAt: f.endedAt, text: f.text };
    if (f.unpriced === true) throw refusal('The entry cost is unpriced and cannot be observed as a complete dollar amount');
    if (!Array.isArray(f.artifacts) || f.artifacts.length) throw refusal('File-bearing entry observation is not supported by this private adapter');
    if (f.taint != null && typeof f.taint !== 'string') throw refusal('The actual entry taint is unproven');
    const taints = cap.receipt.restriction.taints.slice();
    if (f.taint && !taints.includes(f.taint)) taints.push(f.taint);
    const product = { text: f.text, draft: cap.receipt.input.text, verdict: Verdict.parseVerdict(f.text), files: [],
      producer: { kind: 'run', runId: b.entryRunId }, taints };
    const current = saved(cap.id, cap.request);
    const next = Object.assign(copy(cap.receipt), { revision: current.receipt.revision + 1, state: 'observed', observation: {
      endedAt: f.endedAt, usd: f.usd, usageMissing: f.usageMissing, outcome: f.outcome, product, files: [], outputDigest: C.entryOutputDigest(product)
    } });
    const checked = C.demandEntry(next, current.job); // full bounds/negative authority before the writer
    // Retain the actual invocation's exact evidence BEFORE a write may land.
    // A valid receipt for this binding alone cannot acknowledge different work.
    cap.expectedObservation = checked;
    const result = d.checkpoint(cap.id, current.receipt.revision, next);
    if (!result || !result.job || !result.receipt) throw refusal('The actual entry observation was not acknowledged');
    const observed = C.demandEntry(result.receipt, result.job);
    if (!isDeepStrictEqual(observed, checked)) throw refusal('The actual entry observation readback changed');
    cap.observed = observed;
    return result;
  }
  function observe(options, facts) {
    try { return observeOwned(options, facts); }
    catch (error) { const cap = context(options); if (cap) cap.observationFailure = error; throw error; }
  }
  async function execute(id, request, options) {
    const checked = C.demandEntry(request);
    if (checked.state !== 'intent' || checked.revision !== 1 || checked.files.length || checked.input.fileRefs.length) throw refusal('This private entry adapter requires its original text-only intent');
    const input = options || {};
    if (!Array.isArray(input.messages) || !input.messages.length || input.messages.some(m => !m || typeof m.role !== 'string' || typeof m.content !== 'string')) throw refusal('This private entry adapter requires text-only messages');
    const own = Object.assign({}, input, { messages: input.messages.map(m => ({ role: m.role, content: m.content })) });
    identity(own, checked);
    ceiling(own, checked);
    await authority(checked, own, 'prepare');
    const prepared = saved(id, checked);
    if (prepared.replayed || prepared.receipt.state !== 'intent') return { invoked: false, confirmed: true, receipt: prepared.receipt,
      usageStatus: prepared.receipt.state === 'observed' && !prepared.receipt.observation.usageMissing ? 'observed' : 'unresolved' };
    const cap = { id, request: checked, receipt: prepared.receipt, entering: false, entered: false, observed: null, closed: false };
    own[marker] = cap;
    let result = null, executionError = null, observationError = null, receipt = prepared.receipt, confirmed = false;
    try { result = await d.run(own); }
    catch (error) {
      if (error === cap.observationFailure) observationError = error;
      else executionError = error;
      if (cap.executionFailure) executionError = cap.executionFailure;
    }
    finally {
      cap.closed = true;
      // A landed observation with a lost ACK is read first. Never overwrite it
      // with uncertainty, infer it from history, or invoke the run a second time.
      try {
        const fresh = saved(id, checked);
        receipt = fresh.receipt;
        if (receipt.state === 'intent') {
          if (!isDeepStrictEqual(receipt, cap.receipt)) throw refusal('The original entry intent changed before uncertainty could be recorded');
          const next = Object.assign(copy(receipt), { revision: receipt.revision + 1, state: 'uncertain' });
          const expected = C.demandEntry(next, fresh.job);
          try {
            const uncertain = d.checkpoint(id, receipt.revision, next);
            if (!uncertain || !uncertain.job || !uncertain.receipt) throw refusal('The uncertain entry was not acknowledged');
            receipt = C.demandEntry(uncertain.receipt, uncertain.job);
            if (!isDeepStrictEqual(receipt, expected)) throw refusal('The uncertain entry readback changed');
          } catch (error) {
            if (!observationError) observationError = error;
            // Lost ACK recovery is read-only and exact. Never repeat the write
            // from a cached snapshot or accept another valid terminal receipt.
            receipt = saved(id, checked).receipt;
            if (!isDeepStrictEqual(receipt, expected)) throw refusal('The uncertain entry could not be confirmed exactly');
          }
        } else if (receipt.state !== 'observed' || !cap.expectedObservation || !isDeepStrictEqual(receipt, cap.expectedObservation)) {
          throw refusal('The actual entry observation could not be confirmed exactly');
        }
        confirmed = true;
      } catch (error) { if (!observationError) observationError = error; }
    }
    return { invoked: true, confirmed, receipt, result, executionError, observationError, terminalEvidence: cap.terminal || null,
      usageStatus: confirmed && receipt.state === 'observed' && !receipt.observation.usageMissing ? 'observed' : 'unresolved' };
  }
  return { execute, has: options => !!context(options), enter, observe,
    noteError(options, error) { const cap = context(options); if (cap && !cap.executionFailure) cap.executionFailure = error; } };
}
module.exports = { makeEntryInvocation };
