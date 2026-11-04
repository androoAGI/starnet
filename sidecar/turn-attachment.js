/* sidecar/turn-attachment.js — ONE DURABLE ROW PER ATTACHMENT, AND NONE OF THE FILE'S TEXT (attachment-rows-and-taint, S3).

   THE PROBLEM. The directive row of a turn is the Commander's voice. It used to hold the turn's EXPANDED text instead: the
   typed words and the file's bytes in one string (index.js wrote latestUserText of the expanded messages). A third party's
   document was then stored as the Commander's own words: the earlier-conversation note quoted it "verbatim, still holds",
   recall returned it as a Commander message, and the stamp it carried re-tainted every later run that replayed the row.

   THE SHAPE NOW. The directive row holds the words (the typed text, else the label of what was attached, which is the files'
   NAMES and carries the attachment stamp: it is not the Commander's words) and keeps the attachment REFERENCES it always kept,
   for the thumbnails and for the server's own re-expansion. Every name this module writes or shows goes through the one rule
   (attachment-name.js). The attachment itself is recorded beside it, one row per file, written by this module right after the
   directive:

     { role: 'system', kind: 'attachment', content: '[attached: notes.txt]', turnId, sourceRunId, taint,
       attachment: { id, name, mime, path, size?, sha256? } }

   Role 'system' (TurnKinds.SYSTEM_KINDS) so an older build skips the row instead of replaying it as a user turn; the visibility
   matrix gives it recall and proof only (no model replay, no owner evidence, no display), so it adds no UI surface and no
   prompt text. size and sha256 are those of the bytes the run read (the attachments.js report, attachments.resentOf); a row
   whose bytes were not read (a marker, an unreadable file, a carried turn the station never ran) simply omits them. The taint
   stamp is the run's own (the bare attachment source unless the run met another one first), and it decays like every other
   attachment stamp (taint-replay.js): the row is provenance, not bytes.

   WHO WRITES THEM. transcript-run.js, after the directive row, strict, retried at the next boundary when the append fails, and
   never rewriting the directive; turn-window.js for a carried turn (a turn the page holds and the station never saw).

   IDEMPOTENT PER (turnId, attachment id), AGAINST THE LIVE ROWS. A retry RETRACTS every row after the directive, its attachment
   rows included (transcriptstore.retract), so a check against the proof view would see them and skip the rewrite, and a check
   against the stream's recent rows would miss older ones. write() asks store.findTurn: its rows are the turn's LIVE rows. A
   retry therefore writes each attachment once, and a resend or a recovery continuation of a turn that still has its rows
   writes nothing.

   Pure given the store it is handed. */
'use strict';
const Kinds = require('../frontend/app/turnkinds.js');
const { ATTACHMENT_TAINT } = require('./taint.js');
const { note: failNote } = require('./failopen.js');
const { cleanName, cleanMime } = require('./attachment-name.js');

const KIND = 'attachment';
const ATTACH_MAX = 16;                                   // transcriptstore.attachmentRefs' capacity
const SHA256_RE = /^[a-f0-9]{64}$/;
const PATH_RE = /^\.attachments\/[^\u0000-\u001f\u007f\\]+$/;
const NOTE_MAX = 8;                                      // names shown in a one-line note

const str = v => (v == null ? '' : String(v));
// a sender-chosen NAME goes into bracketed text a model reads, and into the words a stored turn is read back as: the ONE rule
// (attachment-name.js) that attachments.js applies to every note too: one line, no bracket or angle bracket, nothing hidden, 120 code points
const clean = name => cleanName(name);

/* fieldOf(a, redact) — the validated `attachment` object of an attachment row, or null when `a` names no saved attachment. The
   path must sit under .attachments/ (the folder attachments.js saves into) and may not climb out of it; every string is bounded;
   size is a non-negative safe integer and sha256 64 lowercase hex characters, else left out. redact (the store's) runs on the
   name, which is free text: a name that cannot be redacted is stored as 'file', never raw. Never throws. */
function fieldOf(a, redact) {
  if (!a || typeof a !== 'object') return null;
  const path = typeof a.path === 'string' ? a.path.slice(0, 300) : '';
  if (!PATH_RE.test(path) || /(^|\/)\.\.(\/|$)/.test(path)) return null;
  const out = {};
  const id = typeof a.id === 'string' ? a.id.slice(0, 64) : '';
  if (id) out.id = id;
  let name = clean(a.name);
  if (typeof redact === 'function') {
    try { name = clean(redact(name)); }
    catch (e) { failNote('turn.attachment.redact', e); name = 'file'; }
  }
  out.name = name;
  const mime = cleanMime(a.mime);   // a plain type/subtype token or nothing: the sender's free text is never kept as the file's type
  if (mime) out.mime = mime;
  out.path = path;
  if (Number.isSafeInteger(a.size) && a.size >= 0) out.size = a.size;
  if (typeof a.sha256 === 'string' && SHA256_RE.test(a.sha256)) out.sha256 = a.sha256;
  return out;
}

// the key a turn's attachment rows are deduped by: the attachment id, else its saved path
const keyOf = item => str(item && (item.id || item.path));
const marker = item => '[attached: ' + clean(item && item.name) + ']';

// the report entry for a reference: the newest one with the same id and path whose bytes were actually read
function readOf(report, ref) {
  const list = Array.isArray(report) ? report : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e && typeof e === 'object' && str(e.path) === str(ref.path) && str(e.id) === str(ref.id) && Number.isSafeInteger(e.size)) return e;
  }
  return null;
}

/* rowsFor(refs, report) — the attachment rows a turn owes, as items { id, name, mime, path, size?, sha256? }, in the order of
   its references. refs are the directive's references (TurnDirective.capture's) or a carried turn's posted ones; report is
   attachments.resentOf's, joined by id and path for size and sha256 (never taken from the client). Duplicates and references that
   fail fieldOf are dropped; at most ATTACH_MAX. [] for none. */
function rowsFor(refs, report) {
  const out = [], seen = new Set();
  for (const ref of (Array.isArray(refs) ? refs : [])) {
    if (out.length >= ATTACH_MAX) break;
    if (!ref || typeof ref !== 'object') continue;
    const read = readOf(report, ref);
    const item = fieldOf({ id: ref.id, name: ref.name, mime: ref.mediaType != null ? ref.mediaType : ref.mime, path: ref.path,
      size: read ? read.size : undefined, sha256: read ? read.sha256 : undefined });
    if (!item) continue;
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// the keys of the turn's LIVE attachment rows (findTurn applies retractions). An unreadable or unplaceable turn answers none.
function liveKeys(store, streamId, turnId) {
  const keys = new Set();
  if (!store || typeof store.findTurn !== 'function') return keys;
  let found = null;
  try { found = store.findTurn(streamId, turnId, {}); }
  catch (e) { failNote('turn.attachment.live', e); return keys; }
  if (found && found.state === 'found' && Array.isArray(found.rows)) {
    for (const r of found.rows) if (r && r.kind === KIND && r.attachment && typeof r.attachment === 'object') keys.add(keyOf(r.attachment));
  }
  return keys;
}

/* write(store, ctx) — append the attachment rows of one turn that are not live yet.
   ctx: { items, streamId, agentId, turnId, runId, taint, dispatchState }. taint is the stamp to carry (the run's own); the bare
   attachment source when absent. Returns { done, failure }: done = the keys now live (already there, or written by this call), in
   order; failure = the error of the first append that failed (the rest were not attempted, so the order holds), else null.
   Never throws: the caller keeps what is not done and retries it at its next boundary. A turn that cannot be named (no valid
   turnId) has nothing to hang rows on and nothing to dedupe against: its rows are reported done and not written. */
function write(store, ctx) {
  const c = ctx || {};
  const items = Array.isArray(c.items) ? c.items : [];
  const result = { done: [], failure: null };
  if (!items.length) return result;
  if (!store || typeof store.appendStrict !== 'function') { result.failure = new Error('turn-attachment: the transcript store cannot append'); return result; }
  if (!Kinds.isTurnId(c.turnId)) { result.done = items.map(keyOf); return result; }
  const streamId = typeof c.streamId === 'string' && c.streamId ? c.streamId : 'global';
  const live = liveKeys(store, streamId, c.turnId);
  for (const item of items) {
    const key = keyOf(item);
    if (live.has(key)) { result.done.push(key); continue; }
    try {
      store.appendStrict(Object.assign({ streamId, agentId: c.agentId, role: 'system', kind: KIND, content: marker(item), attachment: item,
        taint: c.taint || ATTACHMENT_TAINT, turnId: c.turnId, sourceRunId: c.runId }, c.dispatchState ? { dispatchState: c.dispatchState } : null));   // every write stamps its taint (recall.test.js)
    } catch (e) { result.failure = e; break; }
    live.add(key);
    result.done.push(key);
  }
  return result;
}

/* THE LABEL OF A TURN SENT WITH NO WORDS. A turn that carries files and not a word is stored as '[file: name]' / '[image: name]' per
   file, joined ', ' (at most LABEL_MAX): the one string TurnDirective.capture gives such a turn as its wording, built from the names
   (a third party's text) through the one rule. It is not the Commander's words, and a reader that shows the files (noteOf) must not
   show them a second time as if they had been said: wordsOf below knows the label by building it again from the row's own references. */
const LABEL_MAX = 600;
const labelWith = (refs, nameOf) => (Array.isArray(refs) ? refs : []).filter(a => a && typeof a === 'object')
  .map(a => '[' + (a.kind === 'image' ? 'image' : 'file') + ': ' + nameOf(a.name) + ']').join(', ').slice(0, LABEL_MAX);
const labelOf = refs => labelWith(refs, clean);
// the label as builds before the one rule wrote it, the names raw: a row stored by one of them may still hold it as its words
const rawLabelOf = refs => labelWith(refs, name => String(name || 'file'));

/* THE READERS. A row that kept its attachment references stands for words plus files. wordsOf is the Commander's words of a
   user row: the typed words of a row whose content holds something else (the 11-02 shape stored the file's text in the content
   and the words in `typed`), else the content; NONE for a row whose words are only the label of its files (a turn sent with no
   words has none to give). noteOf is one '[attached: name]' per reference of a user row, the form every reader shows a file in;
   textOf joins them. A row that keeps no references reads exactly as its content (byte for byte). */
function wordsOf(row) {
  if (!row || typeof row !== 'object') return '';
  const withFiles = row.role === 'user' && Array.isArray(row.attachments) && row.attachments.length > 0;
  const words = withFiles && typeof row.typed === 'string' && row.typed ? row.typed : str(row.content);
  return withFiles && (words === labelOf(row.attachments) || words === rawLabelOf(row.attachments)) ? '' : words;
}
function noteOf(row) {
  if (!row || typeof row !== 'object' || row.role !== 'user' || !Array.isArray(row.attachments) || !row.attachments.length) return '';
  const refs = row.attachments.filter(a => a && typeof a === 'object');
  if (!refs.length) return '';
  const shown = refs.slice(0, NOTE_MAX).map(a => '[attached: ' + clean(a.name) + ']');
  if (refs.length > NOTE_MAX) shown.push('[+' + (refs.length - NOTE_MAX) + ' more attached]');
  return shown.join(' ');
}
function textOf(row) {
  const words = wordsOf(row), note = noteOf(row);
  return note ? (words ? words + ' ' : '') + note : words;
}

module.exports = { KIND, ATTACH_MAX, LABEL_MAX, fieldOf, rowsFor, keyOf, marker, write, labelOf, wordsOf, noteOf, textOf };
