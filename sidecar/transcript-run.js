/* sidecar/transcript-run.js — ONE run's writer onto the durable conversation transcript (H2 durable transcript).

   WHY THIS EXISTS. runOnce used to write a run's dialogue to transcriptstore.js only at RUN END (plus whatever a
   mid-run compaction drain happened to fold). A hard kill between a tool's side effect and run end left the
   transcript without the turn that caused it — or without even the user's prompt — and a recovery continuation
   then marked the whole recovered prompt "already persisted", so those turns never reached the transcript at all
   (audit 2026-09-22: killed after fs_write + auto-continue → transcript `user → "Continued and finished."`, the
   executed write missing). The reference harness persists the user row before the first model call, the
   assistant tool-call turn before any tool runs, and tool results as they land. This module gives runOnce that
   discipline at the loop's EXISTING durable boundaries:

     start(messages)   — before the first model call: the directive (triggering user text), then any recovered turns
                         a continuation still owes the transcript (see reconcile below)
     checkpoint(c)     — loop.js saveCheckpoint → index.js onCheckpoint, AFTER the run journal's checkpoint: the
                         'assistant' boundary (before tools dispatch) and the 'tool_results' boundary
     drain(messages)   — the compaction tiers' STRICT pre-fold drain, and run end (both may throw)

   ORDER IS THE INVARIANT. Every message row goes through transcriptstore's appendNewStrict, which walks the working
   set in order, fsync/read-back proves each row, and stops at the first failure — leaving that message and every
   later one WITHOUT the persisted marker. The directive is always written before any message row. So a failed
   write can never leave a hole: the transcript is an in-order prefix of the run's dialogue, and the next boundary
   (or run end) resumes from the first missing row. Nothing is ever written twice: the marker rides the message
   objects (and the micro tier carries it onto elided copies), so run end appends only what is left.

   FAILURE POLICY — the same as the compaction drain's. A transcript write that fails MID-RUN does not kill the run
   and does not discard or reorder dialogue: the rows stay pending (in RAM, and in the run journal, which is written
   FIRST at every boundary and is only retired after run end proves every row durable). checkpoint() and start()
   report it through onFailure (index.js: failNote → the /api/diagnostics failopen tally + a warn line) and retry at
   the next boundary. Run end is strict: a throw there leaves the journal un-retired, i.e. discoverable.

   TEXT-ONLY TURNS WAIT for the next boundary that dispatches or records tools. At an 'assistant' boundary whose
   newest turn carries no tool calls nothing is written: that turn is either the final answer (run end writes it
   moments later) or a finishReason:'length' partial that loop.js may still merge with its continuation parts
   (collapseContinuation rewrites the FIRST part's content and deletes the rest) — writing it now would freeze a
   fragment. A kill in that window loses nothing: the journal checkpoint holds the turn and a continuation's
   reconcile writes it.

   RECOVERY CONTINUATIONS. adoptRecovery() marks the source run's initial prompt persisted, then transcriptstore's
   markRecorded() marks every recovered turn the source run's own rows already prove durable. What stays unmarked
   is genuinely missing (a kill between journal and transcript, a journaled-but-uncheckpointed tool result, the
   recovery planner's pairing results) and start() appends it, after the directive when the source never wrote one.

   TURN IDENTITY (turn-identity commit 1; nothing in production passes these yet, and without them every row written is
   byte-identical to before):
     turnId      a string, or a function read at EACH write; a valid turnId (TurnKinds.isTurnId) is stamped on the
                 directive row (with directive: true) and on every row the run writes
     stamp       true: every drained row gets a kind (kindOf below), and the directive kind defaults to
                 directiveKind || 'turn'
     rowKind     'station' | 'hop': the kind of the run's assistant and tool rows (else 'turn')
     directiveKind, line   the directive's default kind; 'lineId@dockId', passed through to every row
     quotes      an array, or a function read at EACH drain, of [{id, at}] (a bare string is {id, at: 0}): the streams
                 this run has read so far, stamped on each drained row as quotes + quotesAt (TurnKinds.quoteStamp)
   setDirective({ text, typed, attachments, kind, attachmentRows, labelOnly }) writes text as the content and the rest on the directive
   row (labelOnly decides its stamp, below); directiveRow() is { rowId, turnId, text } once the directive is proven durable.

   ATTACHMENT ROWS (attachment-rows-and-taint, S3; sidecar/turn-attachment.js). attachmentRows are the files the directive's turn
   carried, as turn-attachment items. The directive row holds the Commander's words only, so each file is recorded beside it as
   a role-system, kind 'attachment' row, written right after the directive (same turnId and sourceRunId). They are provenance,
   never dialogue, so a failure to write them is reported through onFailure and the rows stay pending for the next boundary: the
   directive is never rewritten, nothing is thrown, and the run is never blocked. Only the run that wrote the directive (or one
   handed the files of a directive it reuses, setAttachments) writes them, and every append is checked against the turn's LIVE
   rows, so a retry (which retracts the old rows) writes each file once and a resend or a continuation writes none twice.
   The directive row's own taint is the run's NON-attachment taint: the bare attachment stamp is what the attachment rows carry,
   and the Commander's typed words are not bytes (a directive stamped only with the attachment source is written clean). A brief
   another agent wrote (`from`) is that agent's text, produced while it held the bytes, and keeps the stamp. A directive that says
   it is only the label of its files (setDirective's labelOnly: no typed words, so the row holds the files' NAMES, a third party's
   text) is never written clean, even by a run that sent no bytes: it carries the run's source, else the bare attachment stamp.

   Pure: no clock, no randomness, no I/O of its own — every write is the injected store's. */
'use strict';

const TurnKinds = require('../frontend/app/turnkinds.js');
const TurnAttachment = require('./turn-attachment.js');
const { ATTACHMENT_TAINT } = require('./taint.js');
const ROW_KINDS = new Set(['station', 'hop']);

function makeRunTranscript(opts) {
  const o = opts || {};
  const store = o.store;
  if (!store || typeof store.appendStrict !== 'function' || typeof store.appendNewStrict !== 'function') {
    throw new Error('makeRunTranscript requires a transcript store with appendStrict/appendNewStrict');
  }
  const streamId = o.streamId;
  const agentId = o.agentId;
  const runId = o.runId;
  const dispatchState = o.dispatchState === 'pending' || o.dispatchState === 'internal' ? o.dispatchState : undefined;
  const onFailure = typeof o.onFailure === 'function' ? o.onFailure : function () {};
  // a delegated worker's directive was written by the agent that dispatched it, never typed by the Commander
  const from = o.from ? String(o.from) : '';
  // the run's CURRENT taint source (null = clean), read at each write: a row written after untrusted content
  // entered the run carries it, so a later replay of that row restores the taint (transcriptstore.taintOf)
  const taintNow = typeof o.taint === 'function' ? function () { try { return o.taint() || null; } catch (e) { onFailure('taint', e); return null; } } : function () { return null; };
  let directive = '';
  let directiveWritten = false;
  /* HOLD FOR A PASTED KEY (keys.save, 2026-10-25). On a run whose Commander message holds a key-shaped string the
     directive row would reach disk before the model could save that key to KEYS — raw, in a segment that is never
     rewritten. While o.hold() is true, start() and every boundary write nothing; the first boundary after it turns
     false (the host flips it when keys.save SUCCEEDS, so the store's redaction can name the key) drains everything in
     its usual order: directive, then each turn. Not "the first tool batch": a real model's first batch is often a
     Task Brief step, with the save a turn later (live run 2026-10-25). The strict drain (compaction, run end) always
     writes, held or not. A crash while held leaves those rows only in the run journal — the state a failed start()
     already leaves, which a recovery continuation appends. */
  const holding = typeof o.hold === 'function' ? function () { try { return !!o.hold(); } catch (e) { onFailure('hold', e); return false; } } : function () { return false; };
  // turn identity (see the header): read at each write, so a re-key before the directive write reaches the directive
  const stamp = o.stamp === true;
  const rowKind = ROW_KINDS.has(o.rowKind) ? o.rowKind : undefined;
  const directiveKind = TurnKinds.isKind(o.directiveKind) ? o.directiveKind : undefined;
  const line = typeof o.line === 'string' && o.line ? o.line : undefined;
  function turnIdNow() {
    const v = typeof o.turnId === 'function' ? o.turnId() : o.turnId;
    return TurnKinds.isTurnId(v) ? v : undefined;
  }
  function quotesNow() {
    if (o.quotes == null) return {};
    return TurnKinds.quoteStamp(typeof o.quotes === 'function' ? o.quotes() : o.quotes);
  }
  // the kind of a drained row: its tag; else 'station' for a user row (the directive is written by writeDirective, so
  // any user row a run drains is the station's own: a loop capture turn, a repair prompt, a recovered loop turn); else
  // the run's row kind (TurnKinds.messageKind: the run-end appendNew stamps by the same rule)
  function kindOf(m) { return TurnKinds.messageKind(m, rowKind); }
  let directiveExtra = null;   // { typed, attachments, kind } from setDirective({ … })
  let directiveLabelOnly = false;   // setDirective({ labelOnly }): the directive's words are only the label of its files (turn-directive.js labelOnly)
  let directiveStored = null;  // the row appendStrict proved for the directive
  let attachmentItems = [];    // the turn-attachment items still owed a row (setDirective's attachmentRows / setAttachments)
  let attachmentTurn = null;   // the turn a REUSED directive's files are recorded under (setAttachments); null = this run's own turn

  // the directive row's turn fields ({} with none of the new opts: the row is the trunk row)
  function directiveFields() {
    const out = {};
    const turnId = turnIdNow();
    if (turnId) { out.turnId = turnId; out.directive = true; }
    const extra = directiveExtra || {};
    const kind = extra.kind !== undefined ? extra.kind : (stamp ? (directiveKind || 'turn') : undefined);
    if (kind !== undefined) out.kind = kind;
    if (extra.typed !== undefined) out.typed = extra.typed;
    if (extra.attachments !== undefined) out.attachments = extra.attachments;
    if (line) out.line = line;
    return out;
  }
  // a drain's turn stamps, read at the drain ({} with none of the new opts)
  function drainStamps() {
    const out = {};
    const turnId = turnIdNow();
    if (turnId) out.turnId = turnId;
    if (line) out.line = line;
    const quoted = quotesNow();
    if (quoted.quotes) { out.quotes = quoted.quotes; out.quotesAt = quoted.quotesAt; }
    if (stamp) out.kindOf = kindOf;
    return out;
  }

  // the directive's taint: the run's own source unless that is the bare attachment stamp, which belongs to the attachment rows —
  // the directive holds the Commander's typed words, not the file's bytes (see ATTACHMENT ROWS above). A directive another agent
  // wrote (`from`: a lead's brief to its worker) is model-written text, produced while the lead held the bytes: it keeps the stamp.
  // A directive with NO typed words holds only the label of the files, built from their names, which are a third party's text and not
  // the Commander's words at all: it is never written clean, whatever the run held (a file that sent no bytes leaves the run
  // untainted), so it is never a clean owner row. The bare stamp is enough: it decays on replay as every attachment stamp does.
  function directiveTaint() {
    const t = taintNow();
    if (from) return t;
    if (directiveLabelOnly) return t || ATTACHMENT_TAINT;
    return t === ATTACHMENT_TAINT ? null : t;
  }
  // the attachment rows still owed, written AFTER the directive: never throws (onFailure + retried at the next boundary)
  function writeAttachments() {
    if (!attachmentItems.length) return;
    let result;
    try {
      result = TurnAttachment.write(store, { items: attachmentItems, streamId, agentId, turnId: attachmentTurn || turnIdNow(), runId, dispatchState, taint: taintNow() || ATTACHMENT_TAINT });
    } catch (e) { onFailure('attachment', e); return; }
    const done = new Set(result.done);
    attachmentItems = attachmentItems.filter(item => !done.has(TurnAttachment.keyOf(item)));
    if (result.failure) onFailure('attachment', result.failure);
  }
  function writeDirective() {
    if (!directiveWritten && directive) {
      directiveStored = store.appendStrict(Object.assign({ streamId: streamId, agentId: agentId, role: 'user', content: directive, sourceRunId: runId, dispatchState, taint: directiveTaint(), from: from || undefined }, directiveFields()));
      directiveWritten = true;
    }
    writeAttachments();
  }

  // STRICT: directive first, then every message not yet carrying the persisted marker. Throws on the first
  // unproven row (the compaction tiers rely on that: a failed drain leaves the history unfolded).
  function drain(messages) {
    writeDirective();
    return Array.isArray(messages) ? store.appendNewStrict(streamId, agentId, messages, Object.assign({ sourceRunId: runId, dispatchState, taint: taintNow() }, drainStamps())) : 0;
  }

  function waitsForNextBoundary(phase, messages) {
    if (phase !== 'assistant') return false;
    const tail = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
    return !(tail && tail.role === 'assistant' && Array.isArray(tail.tool_calls) && tail.tool_calls.length > 0);
  }

  return {
    // the triggering user text, captured by the host before the loop can add user-role turns of its own; or
    // { text, typed, attachments, kind, attachmentRows, labelOnly }: the content, plus the typed words, attachment refs and kind of its row,
    // the turn-attachment items to record beside it (see ATTACHMENT ROWS in the header), and whether the words are only the files' label
    setDirective(text) {
      if (text && typeof text === 'object') {
        directive = text.text == null ? '' : String(text.text);
        directiveExtra = { typed: text.typed, attachments: text.attachments, kind: text.kind };
        directiveLabelOnly = text.labelOnly === true;
        attachmentItems = Array.isArray(text.attachmentRows) ? text.attachmentRows.slice() : [];
        attachmentTurn = null;
        return;
      }
      directive = text == null ? '' : String(text);
      directiveExtra = null;
      directiveLabelOnly = false;
      attachmentItems = [];
      attachmentTurn = null;
    },
    // the files of a directive this run REUSES (a retry answers the turn's existing directive and has no directive of its own to
    // write): their attachment rows are owed like a new directive's, under that directive's turn (the run's own turn when none is
    // named), and written once, checked against the turn's live rows
    setAttachments(items, turnId) {
      attachmentItems = Array.isArray(items) ? items.slice() : [];
      attachmentTurn = TurnKinds.isTurnId(turnId) ? turnId : null;
    },
    // { rowId, turnId, text } of the directive once its row is proven durable; null before that (held, not yet
    // written) or when the store kept no rowId (a store without a durable io)
    directiveRow() {
      const r = directiveStored;
      if (!r || typeof r !== 'object' || !(Number(r.rowId) > 0)) return null;
      return { rowId: r.rowId, turnId: r.turnId || null, text: r.typed != null ? r.typed : r.content };
    },
    // run end's fallback: the host's end-of-run title, used only when no directive was captured pre-loop
    fallbackDirective(text) { if (!directive && text) directive = String(text); },
    // the directive is already durable (a continuation whose source run wrote it)
    markDirectiveWritten() { directiveWritten = true; },
    directiveWritten() { return directiveWritten; },
    /* A recovery continuation adopts its SOURCE run's transcript state. `messages` is the continuation prompt, `base`
       the length of the source's initial prompt at its head (recoveryBase), `rows` the source run's own transcript
       rows. The initial prompt is recorded by definition (restored history was written by earlier runs, the
       directive by the source); every later recovered turn is recorded only if a source row proves it
       (store.markRecorded — by identity), and start() appends the rest. The source writes its directive before any
       other row, so ANY source row — or a source that was itself a continuation — means the directive is durable. */
    adoptRecovery(messages, r) {
      const info = r || {};
      const base = Math.max(0, Math.floor(Number(info.base) || 0));
      const rows = Array.isArray(info.rows) ? info.rows : [];
      store.markPersisted(messages.slice(0, base));
      store.markRecorded(messages.slice(base), rows);
      if (rows.length > 0 || info.sourceWasContinuation) directiveWritten = true;
    },
    drain,
    // before the first model call. Never throws: a failure is reported and retried at the next boundary.
    start(messages) {
      if (holding()) return 0;
      try { return drain(messages); }
      catch (e) { onFailure('start', e); return 0; }
    },
    // a loop durable boundary ({ phase, messages } — loop.js saveCheckpoint's payload). Never throws.
    checkpoint(c) {
      const cp = c || {};
      if (holding()) return 0;
      if (waitsForNextBoundary(cp.phase, cp.messages)) return 0;
      try { return drain(cp.messages); }
      catch (e) { onFailure('checkpoint', e); return 0; }
    }
  };
}

/* How many leading messages of a continuation prompt are its source run's initial prompt? The recovery planner
   (run-recovery.js) builds the prompt from the journal's checkpoint = base checkpoint messages + the latest delta,
   so the base is a byte-identical prefix. 0 = unknown (no base, or a prompt that does not start with it) — the host
   then keeps the conservative rule and marks the whole prompt recorded rather than guess. */
function recoveryBase(journalState, messages) {
  const base = journalState && journalState.baseCheckpoint && Array.isArray(journalState.baseCheckpoint.messages)
    ? journalState.baseCheckpoint.messages : null;
  if (!base || !base.length || !Array.isArray(messages) || base.length > messages.length) return 0;
  return JSON.stringify(messages.slice(0, base.length)) === JSON.stringify(base) ? base.length : 0;
}

module.exports = { makeRunTranscript, recoveryBase };
