/* One durable public reply, distinct from a run's hidden execution rows. Pure over the Store owner.
   Text is already redacted by the caller; Store applies its normal persistence redaction as well. */
'use strict';
const Kinds = require('../frontend/app/turnkinds.js');
const SID = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT = /^[A-Za-z0-9_-]{1,40}$/;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
function unavailable(message) { return Object.assign(new Error(message), { code: 'TRANSCRIPT_UNVOUCHED' }); }
/* THE SESSIONS A RUN HAS READ, as the stamp for a row that carries its words elsewhere (turn identity commit 11). A routine's reply is delivered
   into a session or a chat; if the routine run recalled or read another session, the delivered copy quotes it too, so a delete of that session
   takes the delivery with it. The run's rows in the source stream (a routine's is 'cron-' + runId) each carry the latch as it stood when they
   were drained, and a latch only grows (a saturation sticks), so the union of the run's stamps is its whole latch. write() reads them through
   the complete proof view (a recent tail cannot prove the run read nothing); this folds them. {} when no row of the run quotes anything. */
function quotesOfRun(proof, runId) {
  const entries = [];
  for (const row of proof) {
    if (!row || row.sourceRunId !== runId || !Array.isArray(row.quotes)) continue;
    row.quotes.forEach((id, i) => entries.push({ id, at: Array.isArray(row.quotesAt) && Number.isSafeInteger(row.quotesAt[i]) ? row.quotesAt[i] : 0 }));
  }
  return Kinds.quoteStamp(entries);
}
function write(store, input) {
  const o = input || {}, turnId = Kinds.runTurnId(o.runId), hasTaint = Object.prototype.hasOwnProperty.call(o, 'taint');
  if (!store || typeof store.view !== 'function' || typeof store.appendStrict !== 'function') throw unavailable('Delivery transcript owner is unavailable');
  if (typeof o.streamId !== 'string' || !SID.test(o.streamId) || typeof o.agentId !== 'string' || !AGENT.test(o.agentId) ||
      typeof o.runId !== 'string' || o.runId.length > 200 || !turnId || typeof o.text !== 'string' || o.text.length > Kinds.LEGACY_FINAL_CONTENT_MAX ||
      (hasTaint && o.taint !== null && typeof o.taint !== 'string') ||
      (o.sourceStream !== undefined && (typeof o.sourceStream !== 'string' || !SID.test(o.sourceStream))) ||
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
  // the delivered words are the routine run's: they quote whatever it read (none when sourceStream is not given or the run read nothing)
  let stamp = {};
  if (o.sourceStream !== undefined) {
    const own = store.view('proof', o.sourceStream, { sourceRunId: o.runId, complete: true });
    if (!Array.isArray(own)) throw unavailable('The routine run\'s own rows are unavailable');
    stamp = quotesOfRun(own, o.runId);
  }
  const row = store.appendStrict({ streamId: o.streamId, agentId: o.agentId, role: 'assistant', kind: 'delivery',
    content: o.text, sourceRunId: o.runId, turnId, ...stamp, ...(hasTaint ? { taint: taint } : {}) });
  if (!row || !positiveId(row.rowId) || row.streamId !== o.streamId || row.sourceRunId !== o.runId || row.kind !== 'delivery' || row.turnId !== turnId) {
    throw unavailable('Delivery append has no durable identity');
  }
  return { rowId: row.rowId, turnId: row.turnId };
}

/* A RUN'S FILES AS ROWS OF THEIR OWN (turn identity, commit 10). One strict kind:'deliverable' row per file or image the run
   wrote, so a reload, a cache or save wipe, or a phone finds the same openable chip from the station's transcript alone.

   The address is exact or there is no row. `path` is what the run wrote, byte for byte (relative, at most 260 characters, no
   '..', no NUL, no drive or UNC). The one conversion is an absolute path that lies lexically inside the run's own projectRoot,
   stored relative to it with `root` named. A record the collector cut at 260 (cut:true), an absolute path anywhere else, a
   failed or unknown record never becomes a row and is returned in `skipped` with a short cause: no path is ever shortened,
   guessed or derived from content. Nothing here grants anything: /api/file still re-proves the jail, the blessed root and the
   protected-file floor every time a chip is opened, and no permission or hash is invented from the extension.

   Strict and idempotent per exact (stream, run, path): the complete proof view is read first (a recent tail cannot prove a
   file was never written), an existing row is returned as it is (an undone one stays undone), and a proof or append failure
   throws, never a success. A throw after some rows landed carries them in error.rows; the retry writes only the rest.
   input: { streamId, agentId, runId, turnId?, root?, artifacts, note?, taint?, quotes? }: agentId is the writing agent, whose own folder
   the relative paths live in; root the run's blessed project folder or ''; note the run's deliverable_note { title, main } (it
   names only the file `main` proves; every other row is named by its basename); taint as in write() (absent = unverified,
   an explicit null = proved clean); quotes the run's latch, execution.quotes() ([{ id, at }]: the sessions it read), stamped on every
   row it writes (a file named from a session's words leaves recall, display and replay with that session; none when the run read
   nothing). Returns { rows: [{ rowId, turnId, path, media, existed }], skipped: [{ path, why }] }. */
const FILE_ROWS_MAX = 50;      // artifacts.js MAX_ENTRIES
const basenameOf = p => String(p).split(/[\\/]/).pop() || String(p);
// the part of an absolute path below `root`, by whole path segments (no fs, no realpath), or null. A Windows root (drive letter)
// compares case-insensitively with either separator; a POSIX root exactly, with '/' only. '.' and '..' anywhere refuse the path.
function belowRoot(abs, root) {
  const win = /^[A-Za-z]:/.test(root), split = s => (win ? s.split(/[\\/]+/) : s.split(/\/+/));
  const fold = s => (win ? s.toLowerCase() : s);
  const base = split(root), target = split(abs);
  while (base.length && base[base.length - 1] === '') base.pop();
  if (!base.length || target.length <= base.length || target.some(s => s === '.' || s === '..')) return null;
  for (let i = 0; i < base.length; i++) if (fold(base[i]) !== fold(target[i])) return null;
  const rest = target.slice(base.length);
  return rest.some(s => s === '') ? null : rest.join('/');
}
// one artifact record -> { path, kind } (the exact address to publish) or { why } (why not). A 'message' record is not a file.
function fileCandidate(a, root) {
  if (!a || typeof a !== 'object') return { why: 'unknown' };
  if (a.kind === 'message') return { quiet: true };
  if (a.kind !== 'file' && a.kind !== 'image') return { why: 'unknown', path: a.path };
  if (a.ok === false || a.failed === true || a.isError === true || a.error) return { why: 'failed', path: a.path };
  if (a.cut === true) return { why: 'cut', path: a.path };
  const problem = Kinds.deliverablePathProblem(a.path);
  if (!problem) return { path: a.path, kind: a.kind, source: a.path };
  if ((problem === 'absolute' || problem === 'drive') && root) {
    const rel = belowRoot(a.path, root);
    if (rel === null) return { why: 'outside-root', path: a.path };
    const bad = Kinds.deliverablePathProblem(rel);
    return bad ? { why: bad, path: a.path } : { path: rel, kind: a.kind, source: a.path };
  }
  return { why: problem, path: a.path };
}
function fileRows(store, input) {
  const o = input || {}, hasTaint = Object.prototype.hasOwnProperty.call(o, 'taint'), root = o.root == null ? '' : o.root;
  const turnId = Kinds.isTurnId(o.turnId) ? o.turnId : Kinds.runTurnId(o.runId);
  if (!store || typeof store.view !== 'function' || typeof store.appendStrict !== 'function') throw unavailable('File-row transcript owner is unavailable');
  if (typeof o.streamId !== 'string' || !SID.test(o.streamId) || typeof o.agentId !== 'string' || !AGENT.test(o.agentId) ||
      typeof o.runId !== 'string' || !o.runId || o.runId.length > 200 || !turnId || !Array.isArray(o.artifacts) ||
      Kinds.deliverableRootProblem(root) || (hasTaint && o.taint !== null && typeof o.taint !== 'string') ||
      (o.quotes !== undefined && !Array.isArray(o.quotes)) ||
      (o.note != null && typeof o.note !== 'object')) {
    throw new Error('Invalid canonical file rows');
  }
  const taint = hasTaint ? (o.taint === null ? null : o.taint.slice(0, 200) || null) : undefined;
  const stamp = Kinds.quoteStamp(o.quotes);   // {} when the run read no other session
  const note = o.note || {}, main = typeof note.main === 'string' ? note.main : '', title = typeof note.title === 'string' ? note.title : '';
  const skipped = [], wanted = [], seen = new Set();
  for (const a of o.artifacts) {
    const c = fileCandidate(a, root);
    if (c.quiet) continue;
    if (c.why) { skipped.push({ path: typeof c.path === 'string' ? c.path.slice(0, 300) : '', why: c.why }); continue; }
    if (seen.has(c.path)) continue;             // one row per exact path, whichever tool wrote it
    seen.add(c.path);
    if (wanted.length >= FILE_ROWS_MAX) { skipped.push({ path: c.path, why: 'capacity' }); continue; }
    wanted.push(c);
  }
  if (!wanted.length) return { rows: [], skipped };
  // Complete is deliberate: a recent tail cannot prove a file was never written. Proof includes undone rows, so a retry
  // cannot resurrect a file the Commander removed from the thread.
  const proof = store.view('proof', o.streamId, { sourceRunId: o.runId, complete: true });
  if (!Array.isArray(proof)) throw unavailable('File-row transcript proof is unavailable');
  const held = new Map();
  for (const row of proof) {
    if (!row || row.kind !== 'deliverable' || row.sourceRunId !== o.runId || !row.deliverable || typeof row.deliverable.path !== 'string') continue;
    held.set(row.deliverable.path, (held.get(row.deliverable.path) || []).concat([row]));
  }
  const existing = new Map();
  for (const c of wanted) {
    const rows = held.get(c.path);
    if (!rows) continue;
    const row = rows[0], d = row.deliverable;
    if (rows.length !== 1 || row.streamId !== o.streamId || row.agentId !== o.agentId || row.role !== 'system' || row.turnId !== turnId ||
        !positiveId(row.rowId) || row.idFrom === 'collision' || d.workspace !== o.agentId || (d.root || '') !== root) {
      throw unavailable('File-row transcript identity is ambiguous');
    }
    const recordedTaint = typeof row.taint === 'string' && row.taint ? row.taint.slice(0, 200) : row.taintKnown === true ? null : undefined;
    if (hasTaint && recordedTaint !== taint) throw unavailable('File-row transcript provenance conflicts with the source');
    existing.set(c.path, row);
  }
  if (existing.size) {
    // The existing bounded identity owner disavows globally collided or missing durable ids (one batched proof).
    const identity = typeof store.cacheRetractions === 'function' && store.cacheRetractions(o.streamId, [...existing.values()].map(row => row.rowId));
    if (!identity || identity.state !== 'done') throw unavailable('File-row transcript identity could not be proved');
  }
  const rows = [];
  try {
    for (const c of wanted) {
      const prior = existing.get(c.path);
      const media = Kinds.mediaKindOf(c.path), shown = Kinds.DELIVERABLE_MEDIA.indexOf(media) >= 0 ? media : 'file';
      if (prior) { rows.push({ rowId: prior.rowId, turnId: prior.turnId, path: c.path, media: prior.deliverable.media, existed: true }); continue; }
      const field = Kinds.deliverableFields({ path: c.path, media: shown, workspace: o.agentId, root,
        name: main && (main === c.path || main === c.source) && title ? title : basenameOf(c.path), artifactId: Kinds.artifactIdOf(c.kind, c.path) });
      if (!field) { skipped.push({ path: c.path.slice(0, 300), why: 'unrepresentable' }); continue; }
      const row = store.appendStrict({ streamId: o.streamId, agentId: o.agentId, role: 'system', kind: 'deliverable',
        content: (shown === 'file' ? 'saved ' : 'made ') + (field.name || 'file'), sourceRunId: o.runId, turnId,
        deliverable: field, ...stamp, ...(hasTaint ? { taint: taint } : {}) });
      if (!row || !positiveId(row.rowId) || row.streamId !== o.streamId || row.sourceRunId !== o.runId || row.kind !== 'deliverable' ||
          row.turnId !== turnId || !row.deliverable || row.deliverable.path !== c.path) {
        throw unavailable('File-row append has no durable identity');
      }
      rows.push({ rowId: row.rowId, turnId: row.turnId, path: c.path, media: row.deliverable.media, existed: false });
    }
  } catch (error) {
    error.rows = rows; error.skipped = skipped;   // what landed before the failure: a retry writes only the rest
    throw error;
  }
  return { rows, skipped };
}
module.exports = { write, fileRows };
