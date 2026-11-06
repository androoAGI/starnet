/* sidecar/steer-buffer.js — per-run LIVE STEERING buffers (POST /api/run/steer -> the loop's steer drain).

   Extracted from index.js (h1 audit 2026-09-22) so the endpoint's promise is testable without a sidecar. The UI
   answers a 200 with "Steering the live run — it will fold your note in on its next step", so a 200 must only ever
   be given for a note the loop can still read. Two gaps made that a lie:
     1. a note that arrived while the model streamed its FINAL (tool-free) answer sat in the buffer and was dropped
        at teardown with a console line — the loop now drains once more before ending (loop.js, steer extension);
     2. a note that arrived after the loop's last drain but before the host's teardown still got a 200. The loop now
        CLOSES the buffer as it ends (close(), wired as runAgentLoop's o.steerClose): anything still pending comes
        back to the loop, which says in the transcript that it was not applied, and every later POST gets an honest
        409 {ok:false, applied:false} — the frontend's /steer then falls back to queueing the note for the next run.

   WHICH NOTES A RUN READ (0.13.5 live walk, 2026-10-14). A SEND NOW note was accepted (200) mid hand-off, a page reload
   cancelled the run, and nothing could say afterwards whether the run had read it: the page's list lived in its memory,
   the durable transcript skips the loop's <steering_note> system messages, and drop() forgot the run. A note posted
   with the page's own noteId is now tracked per run — pending → 'applied' when the loop drains it (drained = folded
   into the next model call, the moment its '[steering]' echo streams) or 'unapplied' when close()/drop() hand it back
   unread. The ledger outlives drop() (bounded: maxLedger runs, maxNotesPerRun each) and index.js copies it into the
   run's durable record (runstore steerNotes), so GET /api/run/steer can answer after the run is gone and after a
   restart (steerNoteStatus). A note without an id (/steer, a channel steer, a background-exit wake) is untracked and
   keeps the exact old shape; a retried POST of a tracked id is never buffered — or folded — twice.

   makeSteerBuffers({ maxPending?, maxNoteChars?, maxClosed? }) -> {
     post(runId, text, live, noteId?) -> { status, body },   // live = the run is still registered in-flight by the host
     drain(runId) -> string[],                       // the per-iteration drain as texts (unchanged semantics)
     drainNotes(runId) -> [{ text, noteId }] (a full message: { text, attachments, id, wire, noteId }),        // the same drain with each note's id kept ('' = none): the loop's (index.js drainSteer)
     close(runId) -> string[],                       // the loop's end: returns never-applied notes; later posts get 409
     drop(runId) -> string[],                        // host teardown: forget the run; returns leftovers (host logs the count)
     pending(runId) -> number, isClosed(runId) -> bool,
     status(runId) -> null | { ended, notes: { noteId: 'pending'|'applied'|'unapplied' } },
     ledgerOf(runId) -> [{ id, applied }]            // what the run record keeps
   }
   steerNoteStatus(runId, { live, memory, record }) -> the GET /api/run/steer body (memory, else the record, else none) */
'use strict';
const SteeringMessage = require('../frontend/app/steering-message.js');

function makeSteerBuffers(opts) {
  opts = opts || {};
  const maxPending = Number(opts.maxPending) > 0 ? Math.floor(Number(opts.maxPending)) : 8;
  const maxNoteChars = Number(opts.maxNoteChars) > 0 ? Math.floor(Number(opts.maxNoteChars)) : 2000;
  // closed ids are forgotten at drop(); the cap only bounds runs whose host path never tears down through drop()
  const maxClosed = Number(opts.maxClosed) > 0 ? Math.floor(Number(opts.maxClosed)) : 256;
  const maxLedger = Number(opts.maxLedger) > 0 ? Math.floor(Number(opts.maxLedger)) : 256;
  const maxNotesPerRun = Number(opts.maxNotesPerRun) > 0 ? Math.floor(Number(opts.maxNotesPerRun)) : 32;
  const buffers = new Map();   // runId -> [{ text, id }] pending notes (id '' = untracked)
  const closed = new Set();    // runIds whose loop has ended: a note can no longer be applied
  const ledger = new Map();    // runId -> { ended, notes: Map(noteId -> 'pending'|'applied'|'unapplied') } — tracked notes only

  function cleanId(v) { const s = String(v == null ? '' : v); return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : ''; }
  function track(runId, id) {
    let e = ledger.get(runId);
    if (!e) {
      e = { ended: false, notes: new Map() };
      ledger.set(runId, e);
      while (ledger.size > maxLedger) ledger.delete(ledger.keys().next().value);
    }
    e.notes.set(id, 'pending');
    while (e.notes.size > maxNotesPerRun) e.notes.delete(e.notes.keys().next().value);
  }
  // a buffered batch leaves the buffer: drained = read; closed/dropped = never read. Only a still-pending id moves.
  function settle(runId, batch, state, ended) {
    const e = ledger.get(runId);
    if (!e) return;
    for (const n of batch) if (n.id && e.notes.get(n.id) === 'pending') e.notes.set(n.id, state);
    if (ended) e.ended = true;
  }
  const texts = batch => batch.map(n => n.text);

  function post(runId, text, live, noteId, message) {
    runId = String(runId || '');
    const structured = message === undefined ? null : SteeringMessage.normalize(message);
    if (message !== undefined && !structured) return { status: 400, body: { error: 'invalid mid-run message (100,000 characters and 16 attachments maximum)' } };
    if (structured && cleanId(noteId)) structured.id = cleanId(noteId);
    text = structured ? SteeringMessage.encode(structured) : String(text == null ? '' : text).trim();
    if (!text) return { status: 400, body: { error: 'empty steering note' } };
    const priorId = cleanId(noteId);
    const prior = priorId && ledger.get(runId);
    // A retried full message may arrive after the run closed. Its applied receipt still wins.
    if (structured && prior && prior.notes.get(priorId) === 'applied') return { status: 200, body: { ok: true, pending: 0, noteId: priorId, duplicate: true, applied: true } };
    if (!runId || !live) return { status: 404, body: { error: 'no in-flight run for that id' } };
    if (closed.has(runId)) {
      return { status: 409, body: { ok: false, applied: false, error: 'the run has already finished its work — this steering note was not applied; send it as a new message' } };
    }
    const id = cleanId(noteId);
    const buf = buffers.get(runId) || [];
    // the same tracked note again (a page retrying its POST): it is already the run's — never buffered or folded twice
    if (id && ledger.has(runId) && ledger.get(runId).notes.has(id)) return { status: 200, body: { ok: true, pending: buf.length, noteId: id, duplicate: true } };
    if (buf.length >= maxPending) return { status: 429, body: { error: 'steer buffer full', pending: buf.length } };
    buf.push({ text: structured ? { ...structured, wire: text } : text.slice(0, maxNoteChars), id: id });   // clamp a single note so one steer can't blow up the prompt
    buffers.set(runId, buf);
    if (id) track(runId, id);
    return { status: 200, body: id ? { ok: true, pending: buf.length, noteId: id } : { ok: true, pending: buf.length } };
  }

  function drain(runId) {
    const b = buffers.get(runId);
    if (!b || !b.length) return [];
    buffers.set(runId, []);
    settle(runId, b, 'applied', false);   // the loop folds every drained note into its next model call (loop.js foldSteerNotes)
    return texts(b);
  }

  // drain() with each note's own id kept: [{ text, noteId }] ('' for a note posted without one). The same drain in every other
  // respect: what leaves the buffer is settled 'applied' in the ledger, once. The loop tags the row its folded note becomes with the
  // id (loop.js foldSteerNotes), so the transcript's steer row and the page's SEND NOW line are one note.
  function drainNotes(runId) {
    const b = buffers.get(runId);
    if (!b || !b.length) return [];
    buffers.set(runId, []);
    settle(runId, b, 'applied', false);
    return b.map(n => (n.text && typeof n.text === 'object' ? Object.assign({}, n.text, { noteId: n.id }) : { text: n.text, noteId: n.id }));   // a full mid-run message (steering-message.js) keeps its attachments and wire; the loop reads its page id from noteId
  }

  function close(runId) {
    runId = String(runId || '');
    const b = buffers.get(runId) || [];
    buffers.delete(runId);
    closed.add(runId);
    while (closed.size > maxClosed) closed.delete(closed.values().next().value);
    settle(runId, b, 'unapplied', true);
    return texts(b);
  }

  // Teardown: forget the run. Returns any never-drained notes so the host can log the count (index.js dropSteer). With
  // close() wired this is non-empty only for a run whose loop never started or never closed.
  function drop(runId) {
    const b = buffers.get(runId) || [];
    buffers.delete(runId);
    closed.delete(String(runId || ''));
    settle(String(runId || ''), b, 'unapplied', true);   // the ledger outlives the teardown (bounded): a page can still ask
    return texts(b);
  }

  function pending(runId) { const b = buffers.get(runId); return b ? b.length : 0; }
  function isClosed(runId) { return closed.has(String(runId || '')); }
  function status(runId) {
    const e = ledger.get(String(runId || ''));
    if (!e) return null;
    const notes = {};
    for (const [id, state] of e.notes) notes[id] = state;
    return { ended: e.ended || closed.has(String(runId || '')), notes: notes };
  }
  function ledgerOf(runId) {
    const e = ledger.get(String(runId || ''));
    return e ? Array.from(e.notes, ([id, state]) => ({ id: id, applied: state === 'applied' })) : [];
  }

  return { post, drain, drainNotes, close, drop, pending, isClosed, status, ledgerOf };
}

/* GET /api/run/steer?runId= — which of the page's tracked notes the run read. THIS process's ledger answers first; a
   run it no longer holds (a restart, an evicted entry) is answered by its durable record (runstore steerNotes: a
   recorded run is over, and a note missing from its ledger is one the station never took); with neither the station
   says so (source 'none') — never a guess either way. live = the host still has the run in flight. */
function steerNoteStatus(runId, o) {
  o = o || {};
  const live = !!o.live;
  if (o.memory) return { runId: runId, live: live, ended: !!o.memory.ended, source: 'memory', notes: Object.assign({}, o.memory.notes) };
  // a run killed mid-flight is recorded on the next boot by the recovery path ('interrupted') with no ledger: that row cannot
  // say which notes the run read, so it is "no record" — never "the station never took it"
  if (o.record && o.record.reason === 'interrupted' && !Array.isArray(o.record.steerNotes)) return { runId: runId, live: live, ended: true, source: 'none', notes: {} };
  if (o.record) {
    const notes = {};
    for (const n of Array.isArray(o.record.steerNotes) ? o.record.steerNotes : []) if (n && n.id) notes[String(n.id)] = n.applied === true ? 'applied' : 'unapplied';
    return { runId: runId, live: live, ended: true, source: 'record', notes: notes };
  }
  return { runId: runId, live: live, ended: false, source: 'none', notes: {} };
}

module.exports = { makeSteerBuffers, steerNoteStatus };
