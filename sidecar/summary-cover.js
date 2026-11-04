/* sidecar/summary-cover.js — WHICH ROWS A FOLD'S NOTE STANDS FOR (context-budget-and-fold, step 2). Pure, no IO.

   A stored summary is only as good as its claim: "this note covers the stream's canonical rows [0 .. end)". A claim that
   says more than the fold summarized drops live dialogue the next time the record is used; one that says less only costs
   a little duplicated text. So everything here errs toward less, and answers "no claim" for anything it cannot prove.

   EXCHANGES. The canonical rows (the model-replay view, oldest first) fall into exchanges: a user row and everything up to
   the next user row (its tool rows, its reply). A fold cuts the working messages wherever the context planner says, often
   in the middle of an exchange. The claim is SNAPPED DOWN to the opening user row of the exchange the cut falls in, so a
   claim only ever covers whole exchanges the fold really summarized, and what follows the snap stays in the window.

   TAGS. The host tags each window message at assembly with the row it stands on and the user row that opens its exchange
   ({ streamId, rowId, openRowId }, turn-view.js tag): by the durable ids the assembly carries, or, for a window the client
   kept, by the same keyed match the earlier-conversation note uses (earlier-conversation.js align). A message nothing
   places stays untagged: a HOLE. A summary note carries the coverage it stands for (tagNote): the free earlier note the
   rows before the window, a stored summary its record, a fold its own claim.

   claimFold() reads the slice a fold summarized and answers { ok, end } or the reason there is no claim:
     · the slice starts exactly where the previous note's coverage ends (no gap: every user row between is in the slice);
     · every dialogue message it summarized is placed (a run's own tool turns have no row yet: no claim, never a half-run
       presented as history), and it stops at the exchange holding the first thing NOT summarized (the tail's first message,
       or a turn the fold pinned verbatim at the head);
     · rows that left the view since the tags were set (a forget, a retract) are 'row-gone', never guessed around.
   substitution() is the other direction: given a valid record and the run's window, which window messages the stored note
   replaces (those of exchanges that start before the claim's end) and whether the note may be used at all (the window must
   open at or before the claim's end: one that opens after it would leave a gap the note does not cover, and the free
   earlier note stays). */
'use strict';
const TurnView = require('./turn-view.js');
const EarlierConversation = require('./earlier-conversation.js');   // taintOf: the one rule for "these rows carry outside content"
const { ATTACHMENT_TAINT, rowStoresAttachmentText } = require('./taint.js');   // the bare attachment stamp (the one that decays) and the test for "this message holds a file's text"

const COVER = Symbol('starnet.summary.cover');

// a note's coverage: { source: 'earlier' | 'record' | 'fold', rows, toRowId, taint, quoted }
function tagNote(note, cover) {
  if (note && typeof note === 'object' && cover) Object.defineProperty(note, COVER, { value: Object.freeze(Object.assign({}, cover)), enumerable: false, configurable: true, writable: true });
  return note;
}
function coverOf(note) { return note && typeof note === 'object' && note[COVER] || null; }

/* tagWindow(window, alignment, rows, streamId) -> how many messages were tagged. alignment is earlier-conversation.js
   align(rows, window): { cut, index }. A message is tagged only when the exchange it belongs to is known. */
function tagWindow(window, alignment, rows, streamId) {
  const list = Array.isArray(rows) ? rows : [];
  const win = Array.isArray(window) ? window : [];
  if (!alignment || !(alignment.cut >= 0) || !Array.isArray(alignment.index)) return 0;
  // the question row the window's opening continues: a window that starts on an assistant reply (or mid-exchange) belongs
  // to the nearest user row before its first row
  let open = -1;
  for (let k = Math.min(alignment.cut, list.length) - 1; k >= 0; k--) if (list[k] && list[k].role === 'user') { open = k; break; }
  let tagged = 0;
  for (let k = 0; k < win.length; k++) {
    const m = win[k];
    if (!m || typeof m !== 'object' || m.role === 'system') continue;
    const at = alignment.index[k];
    const row = at >= 0 ? list[at] : null;
    if (m.role === 'user') {
      if (row && row.role === 'user') open = at;   // a Commander message placed on its row opens its exchange
      else if (!row) open = -1;                    // a user message nothing places: which exchange it opens is unknown, and so is the rest of it
      // a user-role message on a non-user row (a steering note) belongs to the exchange it interrupts
    }
    if (open < 0 || !list[open]) continue;
    TurnView.tag(m, { streamId, rowId: row ? row.rowId : null, openRowId: list[open].rowId });
    tagged++;
  }
  return tagged;
}

/* claimFold({ streamId, rows, older, kept, tailHead, prevNote, startRows }) -> { ok: true, end, prefix, progress } or
   { ok: false, reason }.
     rows      the canonical model-replay rows, read fresh
     older     the messages the fold summarized
     kept      messages taken out of the slice and left verbatim at the head (the pinned turn)
     tailHead  the first non-system message that stays after the note
     prevNote  the summary note the fold merged onto (null when none)
     startRows the rows already out of the window when there is no previous note (the run-start cut)
   end is a count of rows: the claim is rows [0, end). progress is false when the fold added nothing to what the previous
   note already covered (end is then that coverage, and nothing new is worth a record). */
function claimFold(i) {
  const refuse = reason => ({ ok: false, reason });
  const rows = Array.isArray(i && i.rows) ? i.rows : [];
  const older = Array.isArray(i && i.older) ? i.older : [];
  const at = new Map();
  rows.forEach((r, k) => { if (r && Number.isSafeInteger(r.rowId)) at.set(r.rowId, k); });
  const tagFor = m => { const t = TurnView.tagOf(m); return t && t.streamId === i.streamId ? t : null; };
  // 1. what is already covered before the slice begins
  let prefix;
  if (i.prevNote) {
    const c = coverOf(i.prevNote);
    if (!c || !(c.rows >= 0)) return refuse('prev-note-untagged');
    prefix = c.rows;
    if (prefix > rows.length || (prefix > 0 && rows[prefix - 1].rowId !== c.toRowId)) return refuse('prev-coverage-moved');
  } else {
    prefix = Math.max(0, Math.floor(Number(i.startRows)) || 0);
    if (prefix > rows.length) return refuse('start-beyond-rows');
  }
  // 2. the slice: every dialogue message must be placed, in order. One that is not (the run's own request, its tool calls and
  //    results: no row exists for them yet) is summarized INTO the note but stands on no row, so a record would claim less than
  //    the note says and the next run would meet a half-finished run's progress as history: no claim
  let lastOpen = -1;
  const opens = new Set();
  for (const m of older) {
    if (!m || m.role === 'system') continue;
    const t = tagFor(m);
    if (!t) return refuse('unplaced-in-slice');
    const o = at.get(t.openRowId);
    if (o === undefined) return refuse('row-gone');
    if (o < lastOpen) return refuse('order');
    if (t.rowId != null && at.get(t.rowId) === undefined) return refuse('row-gone');
    lastOpen = o;
    opens.add(o);
  }
  // 3. where the claim stops: the exchange holding the first thing that was NOT summarized
  let end;
  const head = i.tailHead ? tagFor(i.tailHead) : null;
  if (head) {
    const h = at.get(head.openRowId);
    if (h === undefined) return refuse('row-gone');
    if (h < lastOpen) return refuse('order');
    end = h;
  } else end = lastOpen;   // the tail starts on something unplaced (the run's request): the exchange before it may continue into it
  for (const k of Array.isArray(i.kept) ? i.kept : []) {
    const t = tagFor(k);
    if (!t) return refuse('kept-untagged');
    const o = at.get(t.openRowId);
    if (o === undefined) return refuse('row-gone');
    end = Math.min(end, o);
  }
  if (!(end >= 0)) return refuse('nothing-placed');
  if (end <= prefix) return { ok: true, end: prefix, prefix, progress: false };
  // 4. no skipped exchange: every Commander row the claim spans past the previous coverage was in the slice
  for (let u = prefix; u < end; u++) if (rows[u] && rows[u].role === 'user' && !opens.has(u)) return refuse('gap');
  if (rows[end] && rows[end].role !== 'user') return refuse('boundary-not-user-row');
  return { ok: true, end, prefix, progress: true };
}

/* substitution({ window, alignment, rows, record }) -> { ok: true, drop: [window indexes], end } or { ok: false, reason }.
   The stored note covers rows [0, record.rows). It replaces the window messages of every exchange that starts before that
   end; messages of later exchanges, and any message nothing placed, stay exactly as the client sent them. */
function substitution(i) {
  const refuse = reason => ({ ok: false, reason });
  const rows = Array.isArray(i && i.rows) ? i.rows : [];
  const win = Array.isArray(i && i.window) ? i.window : [];
  const end = i && i.record ? i.record.rows : 0;
  if (!(end > 0) || end > rows.length) return refuse('claim-beyond-rows');
  const alignment = i.alignment;
  if (!alignment || !(alignment.cut >= 0)) return refuse('window-unplaced');
  if (alignment.cut > end) return refuse('window-after');   // the page's window opens after the claim: a gap the note does not cover
  const at = new Map();
  rows.forEach((r, k) => { if (r && Number.isSafeInteger(r.rowId)) at.set(r.rowId, k); });
  const drop = [];
  let last = -1;
  for (let k = 0; k < win.length; k++) {
    const t = TurnView.tagOf(win[k]);
    if (!t || t.streamId !== i.streamId) continue;
    const o = at.get(t.openRowId);
    if (o === undefined) return refuse('row-gone');
    if (o < last) return refuse('order');
    last = o;
    if (o < end) drop.push(k);
  }
  return { ok: true, drop, end };
}

/* serve({ msgs, window, drop, earlier, record }) -> { msgs, note, taint, quoted }: the run's messages with the stored note
   in place of what it covers. The window messages named by drop and the free earlier note give way; the stored note, byte for
   byte, takes the earlier note's place (right after the leading system messages) and is tagged with its coverage so a fold in
   this run merges onto it. taint and quoted are what the host must latch: a summary of content that read the outside world,
   or of quoted material, is not clean just because the run that reads it now did nothing wrong. */
function serve(i) {
  const gone = new Set((Array.isArray(i.drop) ? i.drop : []).map(k => i.window[k]));
  if (i.earlier) gone.add(i.earlier);
  const msgs = i.msgs.filter(m => !gone.has(m));
  let lead = 0;
  while (lead < msgs.length && msgs[lead] && msgs[lead].role === 'system') lead++;
  const r = i.record;
  const note = tagNote({ role: 'system', content: r.noteBody }, { source: 'record', rows: r.rows, toRowId: r.toRowId, taint: r.taint, quoted: r.quoted });
  msgs.splice(lead, 0, note);
  return { msgs, note, taint: r.taint || null, quoted: r.quoted === true };
}

/* THE STAMP A KEPT SUMMARY CARRIES (A10, 2026-11-04). The ledger stores the stamp UNWRAPPED: the source itself, never the sentence a latch
   put it in ('earlier conversation carried content from X', 'kept summary carried content from X'), so a summary of a summary does not
   grow a prefix per fold and the bare attachment source stays recognizable. Three kinds:
     - a fold whose messages held the attachment's BYTES (the expanded user message: its file text, or its picture) gets BYTES_TAINT. It is
       not the bare source, so it never decays: the summary carries the file's words, and a run that serves it is latched for good;
     - a fold over a model's own replies written while the bytes were in front of it gets the bare ATTACHMENT_TAINT. The bytes are not in
       the summary, so serving it latches nothing (index.js: `served.taint !== ATTACHMENT_TAINT`), the same decay a transcript row has;
     - any other source (a page, a connector, a tool result) is kept as it is and latches on every serve, whatever else the run holds. */
const BYTES_TAINT = ATTACHMENT_TAINT + ' (file text kept in a summary)';
const WRAPPED = /^(?:(?:earlier conversation|kept summary) carried content from )+/;
const unwrap = t => (typeof t === 'string' && t ? t.replace(WRAPPED, '').trim() : '') || null;
/* heldBytes(msgs) -> do these working messages hold an attachment's bytes? A user message whose file text rides in it (the "[Attached file: "
   header attachments.js writes, as a string or in a text block) or that carries a picture part. Pure. */
function heldBytes(msgs) {
  for (const m of Array.isArray(msgs) ? msgs : []) {
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') { if (rowStoresAttachmentText({ role: 'user', content: m.content })) return true; continue; }
    if (Array.isArray(m.content) && m.content.some(b => b && (b.type === 'image_url' || (typeof b.text === 'string' && rowStoresAttachmentText({ role: 'user', content: b.text }))))) return true;
  }
  return false;
}
/* stampOf(taint) -> the stamp a note carries for a taint the host already holds: the bare source on a note means "its bytes are not in
   it", so a taint that reached a note by way of a row that renders file text (earlier-conversation taintOf answers the bare source ONLY for
   that row) is BYTES_TAINT. Anything else is unwrapped and kept. */
const stampOf = t => t === ATTACHMENT_TAINT ? BYTES_TAINT : unwrap(t);

/* taintOfFold({ covered, prevCover, runTaint, heldBytes }) -> the stamp a new record must keep, or null: the first source that is not the
   bare attachment among a covered row that carries one, the one the previous note already carried (a summary of a summary never
   launders it) and the one this run had latched when the fold built the note (its own tool results are summarized into it); else
   BYTES_TAINT when the folded messages held the attachment's bytes; else the bare attachment when only a model's replies written under
   it were folded; else null. runTaint is the run's ROW stamp (execution.rowTaint()): the first non-attachment source, not the first. */
function taintOfFold(i) {
  const cands = [stampOf(EarlierConversation.taintOf(i.covered)), unwrap(i.prevCover && i.prevCover.taint), unwrap(i.runTaint)].filter(Boolean);
  const other = cands.find(t => t !== ATTACHMENT_TAINT);
  if (other) return other;
  if (i.heldBytes === true) return BYTES_TAINT;
  return cands.length ? ATTACHMENT_TAINT : null;
}

module.exports = { tagNote, coverOf, tagWindow, claimFold, substitution, serve, taintOfFold, heldBytes, stampOf, BYTES_TAINT, COVER };
