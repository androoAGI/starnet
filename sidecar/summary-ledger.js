/* sidecar/summary-ledger.js — A FOLD'S SUMMARY, KEPT (context-budget-and-fold, step 2, 2026-11-04).

   THE BURN. A fold lives only in the run's message array. The page re-sends the same long chat every turn, so every send
   past the fold line summarized the same range again: probe against the real sidecar on a 32k mock, 14 sends past the
   line = 14 paid summarizer calls and 14 different note texts. The free earlier-conversation note (earlier-conversation.js)
   survives between runs because it is rebuilt from the transcript; a PAID summary never did.

   THIS FILE is where a paid summary survives. One file per stream under a dot-prefixed directory (an agent named
   "summaries" must not be able to collide with it: agent ids never start with a dot), one record per (stream, agent):

     { v, streamId, agentId,
       fromRowId, toRowId, rows,   the claim: the canonical rows [first .. toRowId] of the stream's model-replay view (a
                                   PREFIX of it, rows long), never more than the fold actually summarized
       digest,                     sha256 over those rows (rowId, role, content, tool calls): the proof the claim is still
                                   true. A forgotten, retracted or edited row, or an id that now names other bytes, changes it
       noteBody, noteSha,          the EXACT <conversation_summary> text the loop built (redacted, capped) and its sha256
       modelKey, windowTokens,     the route and the window the fold was sized for: a model or window change drops it
       ownerVoice,                 whose words these are (a guest or group run's summary never reaches an owner run)
       taint, quoted,              what the summary carries (outside content; quoted material): latched again on reuse
       quotes, quotesAt,           the streams the covered rows read (TurnKinds.quoteStamp): a delete of one of them forgets this
       runId, runStartedAt, createdAt }

   WHAT MAKES A RECORD USABLE is validate(record, ctx) — every cause below drops it, none is advisory:
     shape · owner (agent/stream) · model · window · voice · forgotten (the stream was deleted at or after the run began) ·
     quote-forgotten · note (noteSha) · rows (no canonical view to prove it against) · digest (the claim no longer holds).
   An unprovable record is simply not used: the cost is one more fold, never lost dialogue, and the free earlier note
   stays the fallback.

   PRIVACY (orchestrator contract G2, batch4-contract.md). The body is verbatim user words in a model's paraphrase, so:
     (a) the digest is taken over the model-replay view by the HOST (index.js canonicalRows): the proof/raw views still hold
         forgotten rows, a digest over them would never change on a forget;
     (b) put() REFUSES once the stream was deleted at or after the run began, inside the per-stream lock, so a fold that
         finishes after the delete cannot leave an orphan the purge never revisits;
     (c) purge() also drops a record whose covered rows READ a deleted stream (quote-forget), not only the deleted stream's own;
     (d) the registry shape is {name, sourceOf, forget}: turn-identity's forget registry takes this object as one register()
         line (forget-wiring.js); until it lands the host calls forget() beside observeDeletedSessions;
     (e) .summaries is dot-prefixed.
   durable-store keeps a .bak (and forensic .corrupt-n copies) beside every file: removeFiles() takes every sibling with it,
   so a forgotten summary is not left in a last-known-good copy.

   Pure over an injected fs/path/clock/redact (the in-memory fs of test/summary-reuse.test.js drives it). Every swallow is a
   failNote. Nothing here throws into a run: put() answers a typed refusal, get() answers null. */
'use strict';
const crypto = require('node:crypto');
const { makeDurableJsonStore } = require('./durable-store.js');
const { note: failNote } = require('./failopen.js');

const NAME = 'conversation-summary';
const VERSION = 1;
const DIR_NAME = '.summaries';
const STREAM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_RE = /^[A-Za-z0-9_-]{1,40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const OPEN = '<conversation_summary>\n';
const CLOSE = '\n</conversation_summary>';
const SEP = '\u001f';
const LIMITS = Object.freeze({
  noteChars: 120000,        // one stored note body (the loop's note is bounded far below: ~24k user section + the summary)
  fileBytes: 768 * 1024,    // one stream's file, every agent's record
  agents: 6,                // records kept per stream
  files: 400,               // streams kept; the oldest file goes first
  quotes: 32,               // TurnKinds.QUOTES_MAX
  rows: 100000
});

const sha = text => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const posInt = v => Number.isSafeInteger(v) && v > 0;
const str = v => v == null ? '' : String(v);

// the text a canonical row stands for in the digest: its stored content, or the JSON of a parts array
function contentOf(row) {
  const c = row && row.content;
  return typeof c === 'string' ? c : JSON.stringify(c == null ? '' : c);
}
/* digestOf(rows) — sha256 over the rows in order: id, role, content, tool calls. The unit separator and the newline
   keep two rows from merging into one (a row ending where the next begins cannot reproduce another split). */
function digestOf(rows) {
  const h = crypto.createHash('sha256');
  for (const r of Array.isArray(rows) ? rows : []) {
    h.update(str(r && r.rowId) + SEP + str(r && r.role) + SEP + contentOf(r) + SEP + str(r && r.toolCalls) + '\n', 'utf8');
  }
  return h.digest('hex');
}

/* claimOf(rows, end) — the claim for the first `end` canonical rows: null when it cannot be one (an empty prefix, an
   id that is not a durable row id, ids that do not strictly rise). */
function claimOf(rows, end) {
  const list = Array.isArray(rows) ? rows : [];
  const n = Math.floor(Number(end));
  if (!(n > 0) || n > list.length || n > LIMITS.rows) return null;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const id = list[i] && list[i].rowId;
    if (!posInt(id) || id <= prev) return null;
    prev = id;
  }
  return { fromRowId: list[0].rowId, toRowId: list[n - 1].rowId, rows: n, digest: digestOf(list.slice(0, n)) };
}

/* quoteUnion(rows) — { quotes, quotesAt } of the covered rows, the shape TurnKinds.quoteStamp gives one row: each stream
   once at its EARLIEST read epoch, more than QUOTES_MAX distinct streams or any saturated marker = ['*'] at the earliest
   epoch seen. {} when no row read another stream. */
function quoteUnion(rows) {
  const first = new Map();
  let saturated = false, minAt = Infinity;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !Array.isArray(r.quotes)) continue;
    for (let i = 0; i < r.quotes.length; i++) {
      const id = str(r.quotes[i]);
      const at = Array.isArray(r.quotesAt) && Number.isFinite(Number(r.quotesAt[i])) ? Math.max(0, Math.floor(Number(r.quotesAt[i]))) : 0;
      minAt = Math.min(minAt, at);
      if (id === '*') { saturated = true; continue; }
      if (!STREAM_RE.test(id)) { saturated = true; continue; }
      first.set(id, first.has(id) ? Math.min(first.get(id), at) : at);
    }
  }
  if (!first.size && !saturated) return {};
  if (saturated || first.size > LIMITS.quotes) return { quotes: ['*'], quotesAt: [Number.isFinite(minAt) ? minAt : 0] };
  const ids = Array.from(first.keys()).sort();
  return { quotes: ids, quotesAt: ids.map(id => first.get(id)) };
}

/* forgottenReason(record, ctx) — 'forgotten' | 'quote-forgotten' | null.
   ctx.deletedAt(streamId) -> ms (0 = never deleted): the session tombstone ledger. A delete forgets everything the stream
   held at or before its stamp, so a record is dead when the stream was deleted at or after the run that wrote it BEGAN
   (that run read only what the delete then forgot). A run that began after the delete read only what was said since.
   ctx.deletedSince(at) -> bool answers the saturated '*' stamp: was ANY stream deleted at or after that epoch. */
function forgottenReason(record, ctx) {
  const c = ctx || {};
  const deletedAt = typeof c.deletedAt === 'function' ? c.deletedAt : () => 0;
  const del = num(deletedAt(record.streamId));
  if (del > 0 && del >= num(record.runStartedAt)) return 'forgotten';
  const quotes = Array.isArray(record.quotes) ? record.quotes : [];
  for (let i = 0; i < quotes.length; i++) {
    const at = num(Array.isArray(record.quotesAt) ? record.quotesAt[i] : 0);
    if (quotes[i] === '*') { if (typeof c.deletedSince === 'function' && c.deletedSince(at)) return 'quote-forgotten'; continue; }
    const d = num(deletedAt(quotes[i]));
    if (d > 0 && at <= d) return 'quote-forgotten';
  }
  return null;
}

// the shape every stored record must have; nothing is trusted from disk
function shapeOk(r) {
  if (!r || typeof r !== 'object' || r.v !== VERSION) return false;
  if (!STREAM_RE.test(str(r.streamId)) || !AGENT_RE.test(str(r.agentId))) return false;
  if (!posInt(r.fromRowId) || !posInt(r.toRowId) || r.toRowId < r.fromRowId || !posInt(r.rows) || r.rows > LIMITS.rows) return false;
  if (!HEX64.test(str(r.digest)) || !HEX64.test(str(r.noteSha))) return false;
  if (typeof r.noteBody !== 'string' || r.noteBody.length > LIMITS.noteChars || r.noteBody.indexOf(OPEN) !== 0 || !r.noteBody.endsWith(CLOSE)) return false;
  if (typeof r.modelKey !== 'string' || !r.modelKey || r.modelKey.length > 200) return false;
  if (!posInt(r.windowTokens) || typeof r.ownerVoice !== 'boolean' || typeof r.quoted !== 'boolean') return false;
  if (r.taint !== null && !(typeof r.taint === 'string' && r.taint.length <= 400)) return false;
  if (!Array.isArray(r.quotes) || r.quotes.length > LIMITS.quotes || !Array.isArray(r.quotesAt) || r.quotesAt.length !== r.quotes.length) return false;
  if (!r.quotes.every(q => q === '*' || STREAM_RE.test(str(q))) || !r.quotesAt.every(a => Number.isSafeInteger(a) && a >= 0)) return false;
  if (typeof r.runId !== 'string' || r.runId.length > 200 || !posInt(r.runStartedAt) || !posInt(r.createdAt)) return false;
  return true;
}

/* validate(record, ctx) -> { ok: true } | { ok: false, reason }. ctx: { agentId, streamId, modelKey, windowTokens,
   ownerVoice, rows (the stream's canonical model-replay rows, oldest first), deletedAt(), deletedSince() }. Every check
   is its own statement and its own reason: test/summary-reuse.test.js removes each one and watches its test fail. */
function validate(record, ctx) {
  const c = ctx || {};
  const refuse = reason => ({ ok: false, reason });
  if (!shapeOk(record)) return refuse('shape');
  if (record.agentId !== c.agentId || record.streamId !== c.streamId) return refuse('owner');
  if (record.modelKey !== c.modelKey) return refuse('model');
  if (record.windowTokens !== c.windowTokens) return refuse('window');
  if (record.ownerVoice !== c.ownerVoice) return refuse('voice');
  const forgotten = forgottenReason(record, c);
  if (forgotten) return refuse(forgotten);
  if (sha(record.noteBody) !== record.noteSha) return refuse('note');
  if (!Array.isArray(c.rows)) return refuse('rows');
  if (!c.rows.length || c.rows.length < record.rows || c.rows[0].rowId !== record.fromRowId || !c.rows[record.rows - 1] || c.rows[record.rows - 1].rowId !== record.toRowId) return refuse('digest');
  if (digestOf(c.rows.slice(0, record.rows)) !== record.digest) return refuse('digest');
  return { ok: true };
}

function fileShapeOk(f, streamId) {
  return !!f && typeof f === 'object' && f.v === VERSION && f.streamId === streamId && !!f.records && typeof f.records === 'object' && !Array.isArray(f.records);
}

/* makeSummaryLedger({ fs, path, dir, now, redact?, deletedAt?, deletedSince?, writeDurable?, onIssue? }) -> the ledger.
   dir is the dot-prefixed directory (index.js: WORKSPACES/.summaries). */
function makeSummaryLedger(deps) {
  const d = deps || {};
  const fs = d.fs, pathMod = d.path;
  if (!fs || !pathMod || !d.dir || typeof d.now !== 'function') throw new Error('makeSummaryLedger: fs, path, dir and now are required');
  const now = d.now;   // injected: the backend takes no ambient clock (lint-determinism)
  const dir = d.dir;
  const L = Object.assign({}, LIMITS, d.limits || {});   // a test lowers a cap to reach it; the host passes none
  const redact = typeof d.redact === 'function' ? d.redact : t => t;
  const deletedAt = typeof d.deletedAt === 'function' ? d.deletedAt : () => 0;
  const deletedSince = typeof d.deletedSince === 'function' ? d.deletedSince : () => false;
  const base = name => name + '.json';
  const fileFor = streamId => {
    if (!STREAM_RE.test(str(streamId))) throw new Error('summary ledger: not a stream id');
    return pathMod.join(dir, base(streamId));
  };
  const store = makeDurableJsonStore({ fs, path: pathMod, fileFor, writeDurable: d.writeDurable });

  /* every file this stream's summary can be in: the main, its .bak last-known-good, forensic copies, temps. Stream ids hold
     no dot, so `<id>.json` plus a dot is exactly this stream's family. */
  function familyOf(streamId) {
    const main = base(streamId);
    let names = [];
    try { names = fs.readdirSync(dir).map(String); }
    catch (e) { if (!e || e.code !== 'ENOENT') failNote('summary-ledger.list', e); return []; }
    return names.filter(n => n === main || n.startsWith(main + '.'));
  }
  // removeFiles(streamId) -> files removed. Sync, so a delete is forgotten the moment it returns; a file that will not
  // go is noted (and counted as not removed), never swallowed.
  function removeFiles(streamId) {
    if (!STREAM_RE.test(str(streamId))) return 0;
    let n = 0;
    for (const name of familyOf(streamId)) {
      try { fs.unlinkSync(pathMod.join(dir, name)); n++; }
      catch (e) { if (!e || e.code !== 'ENOENT') failNote('summary-ledger.unlink', e); }
    }
    return n;
  }
  function streamsOnDisk() {
    let names = [];
    try { names = fs.readdirSync(dir).map(String); }
    catch (e) { if (!e || e.code !== 'ENOENT') failNote('summary-ledger.list', e); return []; }
    // a stream with only a sibling left (a .bak, a forensic copy, a temp) is listed too: purge() takes the orphan with it
    const out = new Set();
    for (const n of names) { const m = /^([A-Za-z0-9_-]{1,64})\.json(?:\..+)?$/.exec(n); if (m) out.add(m[1]); }
    return Array.from(out);
  }
  function readFile(streamId) {
    if (!STREAM_RE.test(str(streamId))) return null;
    let f;
    try { f = store.get(streamId); }
    catch (e) { failNote('summary-ledger.read', e); return null; }
    return fileShapeOk(f, streamId) ? f : null;
  }
  function get(streamId, agentId) {
    const f = readFile(streamId);
    const r = f && AGENT_RE.test(str(agentId)) ? f.records[agentId] : null;
    return shapeOk(r) && r.streamId === streamId && r.agentId === agentId ? r : null;
  }
  const bytesOf = v => Buffer.byteLength(JSON.stringify(v), 'utf8');

  /* put(input) -> Promise<{ ok: true, record } | { ok: false, reason }>. Never throws. reasons: invalid · tombstoned ·
     too-large · unreadable · write-failed · read-back. The record is on disk, fsynced and READ BACK equal before ok. */
  function put(input) {
    const i = input || {};
    const refuse = (reason, error) => { if (error) failNote('summary-ledger.put.' + reason, error); return { ok: false, reason }; };
    if (!STREAM_RE.test(str(i.streamId)) || !AGENT_RE.test(str(i.agentId)) || typeof i.noteBody !== 'string') return Promise.resolve(refuse('invalid'));
    let outcome = null, written = null;
    const attempt = () => store.update(i.streamId, cur => {
      // inside the stream's lock and with no await before the write: a delete cannot land between this check and the write
      const del = num(deletedAt(i.streamId));
      if (del > 0 && del >= num(i.runStartedAt)) { outcome = 'tombstoned'; return undefined; }
      const body = redact(i.noteBody);
      if (typeof body !== 'string' || body.length > L.noteChars) { outcome = 'too-large'; return undefined; }
      const record = {
        v: VERSION, streamId: i.streamId, agentId: i.agentId,
        fromRowId: i.fromRowId, toRowId: i.toRowId, rows: i.rows, digest: i.digest,
        noteBody: body, noteSha: sha(body),
        modelKey: i.modelKey, windowTokens: i.windowTokens, ownerVoice: i.ownerVoice,
        taint: i.taint == null ? null : String(i.taint).slice(0, 400), quoted: i.quoted === true,
        quotes: Array.isArray(i.quotes) ? i.quotes.slice() : [], quotesAt: Array.isArray(i.quotesAt) ? i.quotesAt.slice() : [],
        runId: str(i.runId).slice(0, 200), runStartedAt: i.runStartedAt, createdAt: Math.max(1, num(now()))
      };
      if (!shapeOk(record)) { outcome = 'invalid'; return undefined; }
      const records = fileShapeOk(cur, i.streamId) ? Object.assign({}, cur.records) : {};
      records[i.agentId] = record;
      // caps: the new record always stays; the oldest of the others go first
      const others = () => Object.keys(records).filter(a => a !== i.agentId).sort((a, b) => num(records[a] && records[a].createdAt) - num(records[b] && records[b].createdAt));
      while (Object.keys(records).length > L.agents && others().length) delete records[others()[0]];
      let next = { v: VERSION, streamId: i.streamId, records };
      while (bytesOf(next) > L.fileBytes && others().length) { delete records[others()[0]]; next = { v: VERSION, streamId: i.streamId, records }; }
      if (bytesOf(next) > L.fileBytes) { outcome = 'too-large'; return undefined; }
      written = record;
      return next;
    });
    return (async () => {
      try {
        try { await attempt(); }
        catch (e) {
          // a corrupt file is derived data: start it over once. An unreadable one (locked) is left alone.
          if (e && e.code === 'ESTORE_CORRUPT') { removeFiles(i.streamId); outcome = null; written = null; await attempt(); }
          else throw e;
        }
      } catch (e) {
        return refuse(e && e.code === 'ESTORE_UNREADABLE' ? 'unreadable' : 'write-failed', e);
      }
      if (outcome) return { ok: false, reason: outcome };
      if (!written) return refuse('write-failed');
      // READ BACK what reached the disk: the same record, byte for byte where it matters
      let back = null;
      try { const r = store.readKey(i.streamId); back = (r.status === 'ok' || r.status === 'recovered') ? r.value : null; }
      catch (e) { removeFiles(i.streamId); return refuse('read-back', e); }
      const got = fileShapeOk(back, i.streamId) ? back.records[i.agentId] : null;
      if (!got || got.noteSha !== written.noteSha || got.digest !== written.digest || got.toRowId !== written.toRowId || got.createdAt !== written.createdAt || got.noteBody !== written.noteBody) {
        removeFiles(i.streamId);
        return refuse('read-back');
      }
      try { evict(i.streamId); } catch (e) { failNote('summary-ledger.evict', e); }
      return { ok: true, record: written };
    })();
  }

  // past the file cap the oldest streams' files go (never the one just written)
  function evict(keepStreamId) {
    const ids = streamsOnDisk();
    if (ids.length <= L.files) return 0;
    const aged = ids.filter(id => id !== keepStreamId).map(id => {
      let at = 0;
      try { at = num(fs.statSync(pathMod.join(dir, base(id))).mtimeMs); } catch (e) { if (!e || e.code !== 'ENOENT') failNote('summary-ledger.stat', e); }
      return { id, at };
    }).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    let removed = 0;
    for (const e of aged.slice(0, ids.length - L.files)) removed += removeFiles(e.id) ? 1 : 0;
    return removed;
  }

  // drop(streamId[, agentId]) -> Promise<boolean>: one agent's record, or the stream's whole family when no agent is named
  async function drop(streamId, agentId) {
    if (!STREAM_RE.test(str(streamId))) return false;
    if (agentId == null) return removeFiles(streamId) > 0;
    if (!AGENT_RE.test(str(agentId))) return false;
    let emptied = false, had = false;
    try {
      await store.update(streamId, cur => {
        if (!fileShapeOk(cur, streamId) || !cur.records[agentId]) return undefined;
        had = true;
        const records = Object.assign({}, cur.records);
        delete records[agentId];
        if (!Object.keys(records).length) { emptied = true; return undefined; }
        return { v: VERSION, streamId, records };
      });
    } catch (e) { failNote('summary-ledger.drop', e); removeFiles(streamId); return true; }
    if (emptied) removeFiles(streamId);
    return had;
  }

  /* purge({ deletedAt, deletedSince }) -> { files, records }: the sweep every fresh delete and every boot runs. A stream's
     file goes whole when it is the deleted stream's own, and when any record in it covers rows that read a deleted
     stream (quote-forget): recomputing one stream's summary is a fold; keeping a forgotten word is a breach. */
  function purge(preds) {
    const p = Object.assign({ deletedAt, deletedSince }, preds || {});
    const out = { files: 0, records: 0 };
    for (const id of streamsOnDisk()) {
      const f = readFile(id);
      if (!f) { out.files += removeFiles(id) ? 1 : 0; continue; }   // unreadable, corrupt or foreign-shaped: derived data, gone
      const agents = Object.keys(f.records);
      let n = 0;
      for (const agent of agents) {
        const r = f.records[agent];
        if (!shapeOk(r) || forgottenReason(r, p)) n++;
      }
      if (n || !agents.length) { removeFiles(id); out.files++; out.records += n; }
    }
    return out;
  }

  // the registry's two functions (turn-identity S4: register({ name, sourceOf, forget })): where a record came from, and
  // forgetting by a scope { streams: Map<streamId, deletedAt> } the way the registry calls it
  function sourceOf(streamId) {
    const f = readFile(streamId);
    if (!f) return [];
    return Object.keys(f.records).map(a => f.records[a]).filter(shapeOk).map(r => ({
      streamId: r.streamId, agentId: r.agentId, rowIds: [r.fromRowId, r.toRowId], quotes: r.quotes.slice(), quotesAt: r.quotesAt.slice() }));
  }
  function forget(scope) {
    const streams = scope && scope.streams instanceof Map ? scope.streams : new Map(Object.entries((scope && scope.streams) || {}));
    if (!streams.size) return { files: 0, records: 0 };
    return purge({ deletedAt: id => num(streams.get(id)), deletedSince: at => Array.from(streams.values()).some(t => num(t) >= at) });
  }

  return { name: NAME, dir, put, get, drop, purge, sourceOf, forget, removeFiles, streams: streamsOnDisk, fileFor, store };
}

module.exports = {
  NAME, VERSION, DIR_NAME, LIMITS, OPEN, CLOSE,
  makeSummaryLedger, validate, digestOf, claimOf, quoteUnion, forgottenReason, shapeOk,
  _internals: { sha, contentOf, fileShapeOk, STREAM_RE, AGENT_RE }
};
