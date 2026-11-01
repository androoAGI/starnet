/* Per-run mutable execution state.

   The run host owns policy and IO; this object owns the bookkeeping that must evolve consistently across tool
   dispatches. Keeping the counters and latches together makes their lifecycle explicit and prevents a future
   early-return or fallback path from quietly creating a second, partially updated copy. */
'use strict';

const { makeToolProgressGuard } = require('./tool-progress-guard.js');

/* WINDOW-SCALED PER-RUN TOOL-OUTPUT CAP. The cap exists so a few big reads can't blow the context window, but
   it must sit ABOVE the compaction threshold in bytes: compaction (0.65 × window tokens) is the one event that
   folds those bytes out of the prompt and re-arms this budget (resetToolBytes rides agent.compact). A flat cap
   below the threshold deadlocks — the budget exhausts, every later tool returns a receipt, and the fold that
   would free it can never fire because the prompt stops growing. 2.6 bytes per context token = 0.65 × 4
   (tokens ≈ bytes/4), i.e. exactly the threshold in bytes; system prompt + assistant turns push the real prompt
   over the threshold before tool bytes alone reach the cap. `floorBytes` (the legacy 120KB) still binds when
   the window is tiny or unknown. Pure so the invariant is unit-testable.

   The sizing alone does not hold that invariant: the budget charges bytes the prompt never carries (the per-turn
   squeeze cuts AFTER the charge) and real text can run past 4 characters per token. So the host also re-arms the
   budget before each model call while the measured prompt is under the fold line (loop.js onPromptMeasured). */
function toolBytesCapFor(contextLimit, floorBytes) {
  const floor = Math.max(0, Math.floor(Number(floorBytes) || 0));
  const limit = Math.max(0, Math.floor(Number(contextLimit) || 0));
  return Math.max(floor, Math.ceil(limit * 2.6));
}

/* THE FLOOR AN EXHAUSTED BUDGET STILL DELIVERS. A receipt runs ~330 characters, so replacing a 14-byte read with one
   grew the prompt to hide the answer, and the receipt's own "read the saved file in focused ranges" could never
   succeed: that read got a receipt too. A result this size always arrives whole and a larger one keeps this much of
   its head, so a focused read always makes progress. Scaled down with the cap so a small pinned cap stays meaningful. */
function visibleFloorFor(cap) {
  return Math.min(2000, Math.floor(cap / 60));
}

function makeRunExecutionState(options) {
  const opts = options || {};
  const artifacts = opts.artifacts;
  const completion = opts.completion;
  const injectedNow = typeof opts.now === 'function' ? opts.now : () => 0;
  const failures = new Map();
  let taintedBy = opts.initialTaint ? String(opts.initialTaint) : null;
  let toolBytes = 0;
  let toolsOk = 0;
  let toolCallsStarted = 0;
  const toolTrace = [];
  const toolTraceById = new Map();
  let checkpointTurn = 0;
  let journalStarted = false;
  let journalFailure = null;
  let failureStage = '';
  let failureCode = '';
  const toolBoundaries = new Map();
  const recoveryAttempts = [];
  // Successful tool results are not automatically progress. Ordinary model calls and code-mode nested calls
  // share this one per-run evidence ledger through the central dispatch seam.
  const progress = opts.progressGuard || makeToolProgressGuard(opts.progressLimits);

  function latchTaint(source) {
    if (!taintedBy && source) taintedBy = String(source);
    return taintedBy;
  }

  function repeated(signature, maxRepeat) {
    return (failures.get(String(signature)) || 0) > Math.max(0, Number(maxRepeat) || 0);
  }

  function recordResult(signature, result, internal) {
    const key = String(signature);
    if (result && result.isError) failures.set(key, (failures.get(key) || 0) + 1);
    else failures.delete(key);
    if (result && !result.isError && !internal) toolsOk++;
  }

  function boundToolResult(result, maxBytes, messages) {
    if (!result || typeof result.content !== 'string') return result;
    const cap = Math.max(0, Number(maxBytes) || 0);
    let next = result;
    const copy = messages || {};
    const floor = visibleFloorFor(cap);
    if (result.content.length <= floor) { toolBytes += result.content.length; return result; }
    const originalChars = Number.isFinite(Number(result.outputChars))
      ? Math.max(0, Math.floor(Number(result.outputChars))) : result.content.length;
    const originalBytes = Number.isFinite(Number(result.outputBytes))
      ? Math.max(0, Math.floor(Number(result.outputBytes))) : Buffer.byteLength(result.content, 'utf8');
    const summary = String(result.summary || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const parkedPath = String(result.parkedPath || '').trim();
    // outputElided (registry): the parked file is the command's kept head + tail, not its full output.
    const captureDropped = Number(result.outputElided) > 0 ? Number(result.outputElided) : 0;
    const receipt = (summary || parkedPath) ? ('[Tool result receipt' + (summary ? ': ' + summary : '') + '. '
      + (parkedPath && captureDropped
        ? 'The kept first and last parts of this output (' + originalChars + ' characters / ' + originalBytes + ' UTF-8 bytes; the command\'s own capture had already dropped '
          + captureDropped + ' characters from its middle) were saved to ' + parkedPath + ' because this run reached its context allowance. The tool already completed; '
          + 'read the saved file in focused ranges, and rerun with narrower output only if you need the dropped middle.'
        : parkedPath
        ? 'The full ' + originalChars + '-character / ' + originalBytes + '-byte UTF-8 output was saved to ' + parkedPath
          + ' because this run reached its context allowance. The tool already completed; do not rerun it merely to recover output. Read the saved file in focused ranges.'
        : originalChars + ' characters / ' + originalBytes + ' UTF-8 bytes were returned, but the full output could not fit or be preserved. Narrow the command before rerunning it.')
      + ']') : '';
    if (toolBytes >= cap) {
      const notice = receipt || copy.omitted || '[tool output omitted — per-run tool-output budget reached]';
      const shown = floor > 0
        ? result.content.slice(0, floor) + '\n\n[Only the first ' + floor + ' characters are shown. Results of ' + floor + ' characters or fewer always arrive whole, so keep any further reads that small.]\n' + notice
        : notice;
      next = Object.assign({}, result, { content: shown, outputBounded: true });
    } else if (toolBytes + result.content.length > cap) {
      const available = cap - toolBytes;
      if (receipt) {
        const separator = '\n\n';
        const room = Math.max(0, available - receipt.length - separator.length * 2);
        const head = Math.floor(room * 0.6);
        const tail = room - head;
        const preview = room > 0
          ? result.content.slice(0, head) + separator + receipt + separator + result.content.slice(result.content.length - tail)
          : receipt;
        next = Object.assign({}, result, { content: preview, outputBounded: true });
      } else {
        next = Object.assign({}, result, { content: result.content.slice(0, available) + (copy.truncatedSuffix || '\n…[truncated — per-run tool-output budget reached]'), outputBounded: true });
      }
    }
    toolBytes += next.content.length;
    return next;
  }

  function willBoundToolResult(result, maxBytes) {
    if (!result || typeof result.content !== 'string') return false;
    const cap = Math.max(0, Number(maxBytes) || 0);
    if (result.content.length <= visibleFloorFor(cap)) return false;
    return toolBytes >= cap || toolBytes + result.content.length > cap;
  }

  function observeArtifact(event) {
    if (artifacts && typeof artifacts.observe === 'function') artifacts.observe(event);
  }

  function artifactList() {
    return artifacts && typeof artifacts.list === 'function' ? artifacts.list() : [];
  }

  function observeCompletion(event) {
    if (completion && typeof completion.observe === 'function') completion.observe(event);
  }

  function completionEvidence() {
    return completion && typeof completion.snapshot === 'function'
      ? completion.snapshot()
      : { schemaVersion: 'starnet.completion-evidence.v1', completionVerdict: 'not_assessed', effectVerdict: 'no_observed_effects', effects: [], evidence: [] };
  }

  async function assessCompletion(input) {
    return completion && typeof completion.assess === 'function'
      ? completion.assess(input || {})
      : completionEvidence();
  }

  function consumeToolCall(maxCalls) {
    const cap = Math.floor(Number(maxCalls) || 0);
    if (cap > 0 && toolCallsStarted >= cap) return false;
    toolCallsStarted++;
    return true;
  }

  function observeToolEvent(name, payload, atMs) {
    const at = Number.isFinite(Number(atMs)) ? Number(atMs) : Number(injectedNow()) || 0;
    if (name === 'agent.tool_call' && payload && payload.callId && toolTrace.length < 200) {
      const rec = { callId: String(payload.callId), name: String(payload.name || 'unknown'), startedAt: at };
      toolTrace.push(rec);
      toolTraceById.set(rec.callId, rec);
    } else if (name === 'agent.tool_result' && payload && payload.callId) {
      const rec = toolTraceById.get(String(payload.callId));
      if (!rec) return;
      rec.ok = !!payload.ok;
      rec.isError = !!payload.isError;
      rec.ms = Math.max(0, Number(payload.ms) || 0);
      rec.endedAt = rec.startedAt + rec.ms;
      rec.summary = String(payload.summary || '').slice(0, 240);
    }
  }

  function toolTraceList() {
    return toolTrace.map(rec => Object.assign({}, rec));
  }

  function recordFailure(stage, code) {
    if (!failureStage && stage) failureStage = String(stage).slice(0, 80);
    if (!failureCode && code) failureCode = String(code).slice(0, 80);
  }

  function markToolPrepared(info) {
    info = info || {};
    const callId = String(info.callId || '');
    if (!callId) return;
    toolBoundaries.set(callId, {
      callId, name: String(info.name || '').slice(0, 80), mutating: info.mutating !== false,
      state: 'prepared'
    });
  }

  function markToolDispatched(callId) {
    const rec = toolBoundaries.get(String(callId || ''));
    if (rec) rec.state = 'dispatched';
  }

  function markToolSettled(callId) {
    const rec = toolBoundaries.get(String(callId || ''));
    if (rec) rec.state = 'settled';
  }

  function uncertainMutations() {
    return Array.from(toolBoundaries.values())
      .filter(rec => rec.state === 'dispatched' && rec.mutating)
      .slice(0, 200)
      .map(rec => Object.assign({}, rec));
  }

  function recordRecoveryAttempt(row) {
    if (recoveryAttempts.length >= 100 || !row || typeof row !== 'object') return;
    recoveryAttempts.push({
      sequence: Math.max(0, Number(row.sequence) || recoveryAttempts.length + 1),
      stage: String(row.stage || '').slice(0, 80), action: String(row.action || '').slice(0, 40),
      reason: String(row.reason || '').slice(0, 80), attempt: Math.max(0, Number(row.attempt) || 0),
      model: String(row.model || '').slice(0, 80), delayMs: Math.max(0, Number(row.delayMs) || 0)
    });
  }

  function beforeProgress(call, tool) {
    return progress.before(call || {}, tool || null);
  }

  function observeProgress(call, result, tool) {
    return progress.after(call || {}, result || {}, tool || null);
  }

  function failJournal(error, meta) {
    meta = meta || {};
    if (!journalFailure) journalFailure = String((error && error.message) || error || 'unknown journal failure').slice(0, 500);
    const beforeDispatch = meta.beforeDispatch === true;
    recordFailure(meta.stage || (beforeDispatch ? 'tool_dispatch_persist' : 'tool_result_persist'), 'recovery-journal-failed');
    return {
      ok: false,
      isError: true,
      summary: 'recovery-journal-failed',
      content: beforeDispatch
        ? 'The tool was not started because its durable dispatch boundary could not be recorded. I stopped before the action rather than risk an untracked side effect.'
        : 'The tool returned, but its durable recovery result could not be recorded. The outcome requires review; do not repeat the action or claim completion.',
      control: {
        final: true,
        reason: 'error',
        text: beforeDispatch
          ? 'I stopped before the tool ran because I could not durably record its dispatch boundary.'
          : 'I stopped because the durable recovery boundary failed after a tool call. That tool outcome requires review, so I cannot safely claim the task completed.'
      }
    };
  }

  return {
    taintedBy: () => taintedBy,
    latchTaint,
    repeated,
    recordResult,
    boundToolResult,
    willBoundToolResult,
    resetToolBytes: () => { toolBytes = 0; },
    toolBytes: () => toolBytes,
    toolsOk: () => toolsOk,
    consumeToolCall,
    toolCallsStarted: () => toolCallsStarted,
    observeToolEvent,
    toolTraceList,
    checkpointTurn: () => checkpointTurn,
    advanceCheckpoint: () => { checkpointTurn++; return checkpointTurn; },
    journalStarted: () => journalStarted,
    startJournal: () => { journalStarted = true; },
    journalFailed: () => !!journalFailure,
    journalFailure: () => journalFailure,
    failureStage: () => failureStage,
    failureCode: () => failureCode,
    recordFailure,
    markToolPrepared,
    markToolDispatched,
    markToolSettled,
    uncertainMutations,
    recordRecoveryAttempt,
    recoveryAttempts: () => recoveryAttempts.map(row => Object.assign({}, row)),
    beforeProgress,
    observeProgress,
    progressSnapshot: () => progress.snapshot(),
    failJournal,
    observeCompletion,
    assessCompletion,
    completionEvidence,
    observeArtifact,
    artifactList
  };
}

module.exports = { makeRunExecutionState, toolBytesCapFor };
