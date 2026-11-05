/* Per-run mutable execution state.

   The run host owns policy and IO; this object owns the bookkeeping that must evolve consistently across tool
   dispatches. Keeping the counters and latches together makes their lifecycle explicit and prevents a future
   early-return or fallback path from quietly creating a second, partially updated copy. */
'use strict';

const { makeToolProgressGuard } = require('./tool-progress-guard.js');
const { ATTACHMENT_TAINT } = require('./taint.js');   // the bare attachment source: the one taint stamp that decays (taint-replay.js)
const TurnKinds = require('../frontend/app/turnkinds.js');   // QUOTES_MAX: the ONE quote capacity the rows, the journal and the run record share

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
   succeed: that read got a receipt too. A result this size arrives whole and a larger one keeps this much of its head,
   so a focused read makes progress. Off for a cap too small to spare it.
   BOUNDED PER TURN: above the fold line, with nothing left to fold, a spent budget is all that stands between the run
   and an overflow, so one turn may spend FLOOR_RESULTS_PER_TURN floors on this. A result no longer than a receipt is
   always delivered, because it costs the prompt less than the receipt would. */
const FLOOR_RESULTS_PER_TURN = 4;
const RECEIPT_SIZED_CHARS = 400;
function visibleFloorFor(cap) {
  const floor = Math.floor(cap / 60);
  return floor < 100 ? 0 : Math.min(2000, floor);
}

function makeRunExecutionState(options) {
  const opts = options || {};
  const artifacts = opts.artifacts;
  const completion = opts.completion;
  const injectedNow = typeof opts.now === 'function' ? opts.now : () => 0;
  const failures = new Map();
  let taintedBy = opts.initialTaint ? String(opts.initialTaint) : null;
  /* The first source that is NOT the bare attachment stamp (see rowTaint). taintedBy keeps its meaning (the FIRST source, for
     the refusal wording and the run record); this one exists because the attachment is the only source that decays, so it must
     never be allowed to hide a later one: a run that held the attachment and then read a page stamps its rows with the page. */
  let otherTaint = taintedBy && taintedBy !== ATTACHMENT_TAINT ? taintedBy : null;
  /* QUOTES (turn identity commit 11): the sessions this run has READ, as { id -> the epoch of the first dispatch that read it }, under
     the ONE run-wide capacity TurnKinds.QUOTES_MAX (32) that the row stamp, the journal and the run record share. Seeded with the run's
     static quotes and a continuation's journal before any tool runs, then grown by latchQuotes at each read. It never shrinks. A run
     that may hold words from a session it could not record (a relay that overflows the room, a source whose record is gone) is
     SATURATED: it carries the marker '*' from saturatedAt, the earliest of the time it was told, its earliest latched read and the
     moment it started, and every row it writes from then on is forgotten after ANY non-adopted delete stamped at or after that time. */
  const quoted = new Map();
  const startedAt = Number.isSafeInteger(opts.startedAt) && opts.startedAt >= 0 ? opts.startedAt : 0;
  let saturatedAt = null;
  let toolBytes = 0;
  let floorSpent = 0;   // characters a spent budget delivered this turn (startToolTurn)
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
    if (source) {
      const s = String(source);
      if (!taintedBy) taintedBy = s;
      if (!otherTaint && s !== ATTACHMENT_TAINT) otherTaint = s;
    }
    return taintedBy;
  }
  // The stamp DURABLE records carry (transcript rows, the run journal, a delegated worker's inherited latch): the first source that
  // is not the bare attachment stamp, else the attachment itself. Truthy exactly when taintedBy() is.
  function rowTaint() { return otherTaint || taintedBy; }

  const safeAt = v => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const quoteId = e => (typeof e === 'string' ? e : (e && typeof e === 'object' && typeof e.id === 'string' ? e.id : ''));
  const quoteAtOf = e => (e && typeof e === 'object' ? safeAt(e.at) : 0);
  // saturate(at): sticks, and only ever moves EARLIER (never later than the run's start, so a delete made after the run began counts
  // even when it precedes the saturating relay itself). Returns the saturation time.
  function saturate(at) {
    const next = Math.min(saturatedAt === null ? Infinity : saturatedAt, safeAt(at), startedAt || Infinity);
    saturatedAt = Number.isFinite(next) ? next : safeAt(at);
    return saturatedAt;
  }
  /* latchQuotes([{ id, at }]) -> the entries this call ADDED or moved earlier (what the journal must record). A stream keeps the
     EARLIEST at it was ever read at. The marker '*' saturates instead. A latch that would pass the capacity saturates rather than
     truncate: no list is ever cut. */
  function latchQuotes(entries) {
    const changed = [];
    for (const e of Array.isArray(entries) ? entries : []) {
      const id = quoteId(e), at = quoteAtOf(e);
      if (!id) continue;
      if (id === TurnKinds.SATURATED) { if (saturatedAt === null || at < saturatedAt) { saturate(at); changed.push({ id, at: saturatedAt }); } continue; }
      if (quoted.has(id)) { if (at < quoted.get(id)) { quoted.set(id, at); changed.push({ id, at }); } continue; }
      if (saturatedAt !== null) continue;   // a saturated run's stamp is the marker alone: nothing more to record
      if (quoted.size >= TurnKinds.QUOTES_MAX) { saturate(at); changed.push({ id: TurnKinds.SATURATED, at: saturatedAt }); continue; }
      quoted.set(id, at);
      changed.push({ id, at });
    }
    return changed;
  }
  // [{ id, at }] in latch order, plus { id: '*', at: saturatedAt } once saturated: exactly what TurnKinds.quoteStamp turns into a row's stamp
  function quotes() {
    const out = [];
    for (const [id, at] of quoted) out.push({ id, at });
    if (saturatedAt !== null) out.push({ id: TurnKinds.SATURATED, at: saturatedAt });
    return out;
  }
  /* quoteRoom(candidates) -> the candidate ids this run may read now: every stream it already holds, plus the first
     QUOTES_MAX-minus-latched NEW ones in candidate order. A saturated run reads anything (its stamp already covers every session). */
  function quoteRoom(candidates) {
    const list = [], seen = new Set();
    for (const c of Array.isArray(candidates) ? candidates : []) { const id = quoteId(c); if (id && id !== TurnKinds.SATURATED && !seen.has(id)) { seen.add(id); list.push(id); } }
    if (saturatedAt !== null) return list;
    let room = Math.max(0, TurnKinds.QUOTES_MAX - quoted.size);
    return list.filter(id => quoted.has(id) || room-- > 0);
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

  function floorRoom(cap) {
    return Math.max(0, FLOOR_RESULTS_PER_TURN * visibleFloorFor(cap) - floorSpent);
  }

  function arrivesWhole(chars, cap) {
    const floor = visibleFloorFor(cap);
    return chars <= Math.min(floor, RECEIPT_SIZED_CHARS) || (chars <= floor && chars <= floorRoom(cap));
  }

  function boundToolResult(result, maxBytes, messages) {
    if (!result || typeof result.content !== 'string') return result;
    const cap = Math.max(0, Number(maxBytes) || 0);
    let next = result;
    const copy = messages || {};
    const floor = visibleFloorFor(cap);
    if (toolBytes + result.content.length <= cap && toolBytes < cap) { toolBytes += result.content.length; return result; }
    if (arrivesWhole(result.content.length, cap)) {
      if (result.content.length > RECEIPT_SIZED_CHARS) floorSpent += result.content.length;
      toolBytes += result.content.length;
      return result;
    }
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
        : copy.rereadOf
        ? 'This read of the saved file ' + copy.rereadOf + ' returned ' + originalChars + ' characters, more than fit. The file is unchanged; read a narrower range of it.'
        : originalChars + ' characters / ' + originalBytes + ' UTF-8 bytes were returned, but the full output could not fit or be preserved. Narrow the command before rerunning it.')
      + ']') : '';
    const available = cap - toolBytes;
    const separator = '\n\n';
    const room = Math.max(0, available - receipt.length - separator.length * 2);
    if (toolBytes >= cap || (receipt && room < floor)) {
      const notice = receipt || copy.omitted || '[tool output omitted — per-run tool-output budget reached]';
      const headChars = Math.min(floor, floorRoom(cap));
      floorSpent += headChars;
      const shown = headChars > 0
        ? result.content.slice(0, headChars) + '\n\n[Only the first ' + headChars + ' characters are shown. Results of ' + floor + ' characters or fewer arrive whole while this turn has room, so keep further reads that small, a few per turn.]\n' + notice
        : notice;
      next = Object.assign({}, result, { content: shown, outputBounded: true });
    } else if (toolBytes + result.content.length > cap) {
      if (receipt) {
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
    if (toolBytes < cap && toolBytes + result.content.length <= cap) return false;
    return !arrivesWhole(result.content.length, cap);
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
    rowTaint,
    latchQuotes,
    saturate,
    quotes,
    quoteRoom,
    quotesSaturatedAt: () => saturatedAt,
    isSaturated: () => saturatedAt !== null,
    repeated,
    recordResult,
    boundToolResult,
    willBoundToolResult,
    resetToolBytes: () => { toolBytes = 0; },
    startToolTurn: () => { floorSpent = 0; },
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
