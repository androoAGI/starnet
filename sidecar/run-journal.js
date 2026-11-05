/* sidecar/run-journal.js — durable, append-only active-run recovery journal.
 *
 * A finished transcript is not enough when the process dies between a tool dispatch and runOnce's
 * final transcript drain.  This journal records provider-valid message checkpoints plus tool intent/result
 * boundaries.  Recovery is deliberately conservative: an intent without a durable result is never replayed.
 *
 * Checkpoints are DELTAS (2026-09-22, journal-linear-growth).  A run checkpoint used to re-serialize every message
 * the run had created so far, so an 80-turn run wrote ~82x its own content (131 MB at 20 KB/turn).  Now:
 *   checkpoint        a full snapshot of the run-created messages (phase 'initial' stays the separate base prompt)
 *   checkpoint_delta  { from, messages } — only the messages appended since the last journaled state
 * checkpointMessages() tracks the exact message OBJECTS it already journaled plus a leaf signature of each, and
 * writes a fresh snapshot whenever the loop REWROTE its working array (a compaction fold, micro elision, a
 * continuation collapse, an in-place content edit) — i.e. whenever the journaled objects are no longer an unchanged
 * prefix of the current list.  Reconstruction (last snapshot + later deltas) therefore equals what the old
 * every-checkpoint-is-a-snapshot scheme recorded, and a journal made only of legacy snapshots analyzes unchanged.
 *
 * Damage classes (2026-09-22): a final record torn by power loss (it does not parse, and nothing follows it) is the
 * ordinary crash signature — under the fsync contract that record never became durable, so the valid hash-chained
 * prefix is exactly as trustworthy as an intact journal.  It is cut off with a `.torn-*` forensic copy and stays
 * resolvable/continuable.  Anything else (a bad record with records after it, a complete-but-invalid record, a
 * record glued after torn bytes) remains forensic-only with its `.corrupt-*` copy, exactly as before.
 */
'use strict';

const fsDefault = require('fs');
const pathDefault = require('path');
const crypto = require('crypto');
// failopen.note — the tagged SYNC swallow: a fail-open catch must never be invisible.
const { note: failNote } = require('./failopen.js');
// the quarantine, the repair temp's name and its sweep, and the evidence names are persist's (one grammar)
const persist = require('./persist/index.js');
// the bare attachment source, the one taint stamp that decays: analyze() must not let it hide a later source (taint-replay.js)
const { ATTACHMENT_TAINT } = require('./taint.js');
// the quote capacity and the one forget rule (frontend/app/turnkinds.js, the module the page and the store share)
const TurnKinds = require('../frontend/app/turnkinds.js');

const VERSION = 1;
const MAX_STRING = 200000;
// cloneSafe keeps at most this many array elements; a checkpoint list longer than this is split across records so
// no run-created message is ever silently truncated out of the recovery copy.
const MAX_ARRAY = 1000;
// New callers stamp prepared intents with this marker. Its presence proves the caller also owns the separate
// durable `tool_dispatch` boundary. Legacy intents have no such proof and must remain fail-closed: before this
// protocol existed, an intent was written immediately before registry.dispatch and could already represent an
// attempted side effect.
const DISPATCH_BOUNDARY_MODEL = 'prepared-dispatch-v1';

function stable(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}

function hashRecord(r) {
  return crypto.createHash('sha256').update(stable({
    v: r.v, runId: r.runId, seq: r.seq, ts: r.ts, type: r.type,
    payload: r.payload, prev: r.prev
  })).digest('hex');
}

function isSecretKey(key) {
  const norm = String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return /^(?:password|passwd|passphrase|token|secret|api_key|authorization|cookie|credentials?|private_key)$/.test(norm)
    || /(?:^|_)(?:password|passwd|passphrase|token|secret|api_key|authorization|cookie|credentials?|private_key)(?:_|$)/.test(norm);
}
/* A 'quotes' RECORD (turn identity commit 11): the sessions a run has read, { streams: [{ id, at }], saturatedAt? }. A stream id is a
   workstream id (validated, never a secret), so it is NOT run through the redactor that rewrites long token-shaped strings: a redacted
   id would fail OPEN (a recovery that no longer recognises a deleted session). Anything that is not a valid id or time is dropped. */
const QUOTE_SID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isTime = v => Number.isSafeInteger(v) && v >= 0;
function quotesPayload(payload) {
  const out = {}, streams = [];
  for (const e of Array.isArray(payload && payload.streams) ? payload.streams : []) {
    const id = e && typeof e.id === 'string' ? e.id : '';
    if (!QUOTE_SID_RE.test(id) || streams.length >= TurnKinds.QUOTES_MAX) continue;
    streams.push({ id, at: isTime(e.at) ? e.at : 0 });
  }
  if (streams.length) out.streams = streams;
  if (payload && isTime(payload.saturatedAt)) out.saturatedAt = payload.saturatedAt;
  return out;
}
/* The ONE forget verdict of a journal's quotes: the state analyze() derived (quotes [{ id, at }], quotesSaturatedAt) against the
   deleted-session ledger, by the same rule as a row's stamp (TurnKinds.quotesForgotten). A recovery continuation replays this run's
   context, tool results included, so it is refused once any of it came from a session deleted since the read. */
function quotesForgotten(state, deletedAt, latestDeleteAt) {
  if (!state) return false;
  const stamp = TurnKinds.quoteStamp(state.quotes);
  if (isTime(state.quotesSaturatedAt)) { stamp.quotes = ['*']; stamp.quotesAt = [state.quotesSaturatedAt]; }
  return TurnKinds.quotesForgotten(stamp, deletedAt, latestDeleteAt);
}

function cloneSafe(value, redact, depth, key) {
  if (depth > 20) return '[depth limit]';
  // Credential containers are as sensitive as credential scalars. Check the key before branching on value type.
  if (key && isSecretKey(key)) return '[redacted]';
  if (typeof value === 'string') {
    // Tool arguments/results commonly arrive as serialized JSON. Scrub credential-shaped fields inside that
    // envelope instead of trusting a value-pattern redactor to recognize an otherwise ordinary secret.
    if (key === 'argsRaw' || key === 'content') {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object') return JSON.stringify(cloneSafe(parsed, redact, depth + 1, key));
      } catch (_) {}
    }
    let out = value.slice(0, MAX_STRING);
    try { out = String(redact(out)); } catch (_) {}
    return out.slice(0, MAX_STRING);
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map(v => cloneSafe(v, redact, depth + 1, key));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).slice(0, 200)) out[k] = cloneSafe(value[k], redact, depth + 1, k);
    return out;
  }
  return String(value);
}

// Leaf signature of one message: every primitive leaf in key order plus private structure sentinels (objects no
// primitive can equal). An untouched message keeps the very same string references, so comparing two signatures
// is O(nodes), not O(bytes). Equal signatures => identical cloneSafe output; any in-place edit changes a leaf.
const SIG_OBJ = {}, SIG_ARR = {}, SIG_END = {}, SIG_DEEP = {};
function leafSignature(value, out, depth) {
  if (value === null || typeof value !== 'object') { out.push(value); return out; }
  // cloneSafe stops serializing at its depth limit (a message sits two levels below the payload root), so nothing
  // deeper can change the journaled bytes; the reference still pins identity conservatively.
  if (depth > 20) { out.push(SIG_DEEP, value); return out; }
  if (Array.isArray(value)) {
    out.push(SIG_ARR, value.length);
    for (let i = 0; i < value.length; i++) leafSignature(value[i], out, depth + 1);
  } else {
    const keys = Object.keys(value);
    out.push(SIG_OBJ, keys.length);
    for (const k of keys) { out.push(k); leafSignature(value[k], out, depth + 1); }
  }
  out.push(SIG_END);
  return out;
}
function sameSignature(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

function runFileName(runId) {
  return crypto.createHash('sha256').update(String(runId || '')).digest('hex') + '.jsonl';
}

function writeAll(fs, fd, data) {
  const buf = Buffer.from(data, 'utf8');
  let at = 0;
  while (at < buf.length) {
    const n = fs.writeSync(fd, buf, at, buf.length - at, null);
    if (!(n > 0)) throw new Error('run journal short write');
    at += n;
  }
}
function closeNoted(fs, fd, tag) { try { fs.closeSync(fd); } catch (e) { failNote(tag, e); } }
// The same owned, flushed copy as every forensic store: a failed open must never delete someone else's evidence.
function copyEvidence(fs, from, to) {
  const copied = persist.copyExclusive(fs, from, to);
  if (copied === true) return;
  if (copied === 'taken') throw Object.assign(new Error('run journal evidence already exists: ' + to), { code: 'EEXIST' });
  throw copied.error;
}
// Windows may reject a replace-existing rename: rewrite the active file in place instead, so its discoverable pathname
// is kept throughout; the evidence copy made first lets the next boot recover even if power fails during this rewrite
function rewriteInPlace(fs, filePath, body) {
  let active = null;
  try {
    active = fs.openSync(filePath, 'r+');
    const bytes = Buffer.from(body, 'utf8');
    let at = 0;
    while (at < bytes.length) {
      const n = fs.writeSync(active, bytes, at, bytes.length - at, at);
      if (!(n > 0)) throw new Error('run journal repair short write');
      at += n;
    }
    fs.ftruncateSync(active, bytes.length); fs.fsyncSync(active);
  } finally { if (active != null) closeNoted(fs, active, 'run-journal.repair.close'); }
}

function makeFsIo(opts) {
  const fs = opts.fs || fsDefault;
  const path = opts.path || pathDefault;
  const dir = String(opts.dir || '');
  if (!dir) throw new Error('run journal directory is required');
  fs.mkdirSync(dir, { recursive: true });

  function file(runId) { return path.join(dir, runFileName(runId)); }
  function append(runId, line, fresh) {
    const target = file(runId);
    let fd = null;
    try {
      fd = fs.openSync(target, fresh ? 'wx' : 'a');
      writeAll(fs, fd, line + '\n');
      fs.fsyncSync(fd);
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
    }
  }
  return {
    create(runId, line) { append(runId, line, true); },
    append(runId, line) { append(runId, line, false); },
    read(runId) { return fs.readFileSync(file(runId), 'utf8'); },
    fileOf(runId) { return file(runId); },
    // Durable damage evidence left by an earlier repair of this journal: a `.corrupt*` sibling (forensic) or a
    // `.torn-*` sibling (a torn tail was cut off; still actionable). Repair temps (persist's `.<pid>.<nonce>.tmp`, the
    // legacy `.repair-*`) are not evidence.
    evidence(filePath) {
      const prefix = path.basename(filePath) + '.';
      const out = { corrupt: false, torn: false };
      for (const n of fs.readdirSync(path.dirname(filePath))) {
        if (n.indexOf(prefix) !== 0) continue;
        const rest = n.slice(prefix.length);
        if (rest.indexOf('corrupt') === 0) out.corrupt = true;
        else if (rest.indexOf('torn-') === 0) out.torn = true;
      }
      return out;
    },
    list() { return fs.readdirSync(dir).filter(n => /^[a-f0-9]{64}\.jsonl$/.test(n)).map(n => path.join(dir, n)); },
    /* ONE directory read for a whole recovery page (perf review 10-19): the journal files plus every journal's damage
       evidence. evidence() above re-read the whole directory once per journal (and the host's forensic mark once more),
       so a 100-row page over a directory of thousands of journals did ~200 full listings. The evidence rule is the
       same one evidence() applies, over the same names. */
    snapshot() {
      const names = fs.readdirSync(dir);
      const files = [], sib = new Map();
      for (const n of names) {
        if (/^[a-f0-9]{64}\.jsonl$/.test(n)) { files.push(path.join(dir, n)); continue; }
        const m = /^([a-f0-9]{64}\.jsonl)\.(.*)$/.exec(n);
        if (!m) continue;
        const e = sib.get(m[1]) || { corrupt: false, torn: false };
        if (m[2].indexOf('corrupt') === 0) e.corrupt = true;
        else if (m[2].indexOf('torn-') === 0) e.torn = true;
        sib.set(m[1], e);
      }
      return { files, evidence: (filePath) => { const e = sib.get(path.basename(filePath)); return e ? { corrupt: e.corrupt, torn: e.torn } : { corrupt: false, torn: false }; } };
    },
    // the first non-blank line of a journal (its begin record), read in bounded chunks; null = none within maxBytes
    readHead(filePath, maxBytes) {
      const cap = Math.max(4096, Number(maxBytes) || (8 << 20));
      let fd = null, held = Buffer.alloc(0), eof = false;
      try {
        fd = fs.openSync(filePath, 'r');
        let pos = 0;
        while (pos < cap) {
          const buf = Buffer.alloc(pos ? 65536 : 4096);   // a begin record is usually well under 4 KB
          const n = fs.readSync(fd, buf, 0, buf.length, pos);
          if (!(n > 0)) { eof = true; break; }
          pos += n;
          // bytes, not text: a multi-byte character split across two reads must not decode as U+FFFD
          held = Buffer.concat([held, buf.subarray(0, n)]);
          for (let nl = held.indexOf(10); nl >= 0; nl = held.indexOf(10)) {
            const line = held.toString('utf8', 0, nl).replace(/\r$/, '');
            held = held.subarray(nl + 1);
            if (line.trim()) return line;
          }
        }
        const last = held.toString('utf8').trim();
        return eof && last ? last : null;   // a single unterminated line at EOF is still the whole first record
      } finally { if (fd != null) { try { fs.closeSync(fd); } catch (e) { failNote('run-journal.head.close', e); } } }
    },
    readFile(filePath) { return fs.readFileSync(filePath, 'utf8'); },
    // A valid final record whose '\n' never landed: terminate it in place (fsync'd) so the next append starts a
    // new line instead of gluing two records into one unparseable line. Nothing is rewritten or discarded.
    terminate(filePath) {
      let fd = null;
      try { fd = fs.openSync(filePath, 'a'); writeAll(fs, fd, '\n'); fs.fsyncSync(fd); }
      finally { if (fd != null) { try { fs.closeSync(fd); } catch (e) { failNote('run-journal.terminate.close', e); } } }
    },
    remove(runId) {
      const target = file(runId);
      try { fs.unlinkSync(target); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
      // A torn-tail copy held only the never-durable bytes of a record cut off by a crash; once the run it belongs
      // to is settled and retired, it is retired with it. `.corrupt*` forensic copies are never touched here.
      try {
        const prefix = path.basename(target) + '.torn-';
        for (const n of fs.readdirSync(dir)) if (n.indexOf(prefix) === 0) fs.unlinkSync(path.join(dir, n));
      } catch (e) { failNote('run-journal.remove.torn-copy', e); }
    },
    // A journal with no valid record moves to the first free <journal>.corrupt-<n> (persist: a second incident never
    // replaces the first copy). null when it could not be moved: it stays where it was, and the next pass tries again.
    quarantine(filePath) {
      const moved = persist.moveAside({ fs }, filePath, persist.names.LABELS.CORRUPT);
      if (moved.ok) return moved.to;
      if (!moved.absent) failNote('run-journal.quarantine', moved.error);
      return null;
    },
    repair(filePath, records, kind) {
      const nonce = crypto.randomBytes(5).toString('hex');
      // The sibling's NAME is the durable damage class: `.torn-r*` (only the final record was cut off; the journal
      // stays actionable) vs `.corrupt-r*` (forensic-only); the letter keeps it from ever reading as a numbered
      // quarantine (persist names). It is written before the active file is replaced, so a crash mid-repair can never
      // leave an actionable journal whose damage evidence says otherwise.
      const backup = persist.names.evidenceFor(filePath, kind, nonce);
      // persist's temp grammar (<journal>.<pid>.<nonce>.tmp): every failure below removes it, and a crashed repair's
      // temp goes once its writer is dead (persist.sweep, after this attempt)
      const tmp = persist.names.tempFor(filePath, process.pid, nonce);
      const body = records.map(r => JSON.stringify(r)).join('\n') + '\n';
      let pending = false;   // this repair's temp is on disk
      try {
        let fd = null;
        try { fd = fs.openSync(tmp, 'wx', 0o600); pending = true; writeAll(fs, fd, body); fs.fsyncSync(fd); }
        finally { if (fd != null) closeNoted(fs, fd, 'run-journal.repair.close'); }
        copyEvidence(fs, filePath, backup);   // preserve the forensic original without removing the active path
        try {
          fs.renameSync(tmp, filePath);        // atomic replacement on platforms that support replace-existing
          pending = false;
        } catch (renameError) {
          rewriteInPlace(fs, filePath, body);
        }
      } finally {
        if (pending) { try { fs.unlinkSync(tmp); } catch (e) { if (!e || e.code !== 'ENOENT') failNote('run-journal.repair.temp', e); } }
        try { persist.sweep({ fs, path }, filePath); } catch (e) { failNote('run-journal.repair.sweep', e); }
      }
      return backup;
    }
  };
}

// True when some suffix of an unparseable line is itself a complete journal record: bytes were appended after a
// torn record without repairing it first, so a record its writer believed durable would be lost by a tail cut.
function hasGluedRecord(line) {
  for (let at = line.indexOf('{"v":', 1); at > 0; at = line.indexOf('{"v":', at + 1)) {
    let r;
    try { r = JSON.parse(line.slice(at)); } catch (_) { continue; }   // not a record boundary: keep scanning
    if (r && r.v === VERSION && typeof r.hash === 'string' && typeof r.seq === 'number') return true;
  }
  return false;
}

/* damage: 'none' | 'torn_tail' (the LAST non-empty line does not parse and carries no glued record — the only
   damage a crash mid-append produces) | 'corrupt' (anything else: an unparseable line with records after it, a
   parseable record that fails version/sequence/chain/hash, glued records). `unterminated`: the file is intact but
   its final record's newline never landed. */
function parseRecords(raw) {
  const records = [];
  let prev = '', corrupt = false, damage = 'none';
  const text = String(raw || '');
  const lines = text.split(/\r?\n/);
  let lastLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) { lastLine = i; break; }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) {
      corrupt = true;
      damage = (i === lastLine && !hasGluedRecord(line)) ? 'torn_tail' : 'corrupt';
      break;
    }
    if (!r || r.v !== VERSION || r.seq !== records.length + 1 || r.prev !== prev || r.hash !== hashRecord(r)) {
      corrupt = true; damage = 'corrupt'; break;
    }
    records.push(r); prev = r.hash;
  }
  return { records, corrupt, damage, unterminated: !corrupt && records.length > 0 && !/\n$/.test(text) };
}

function analyze(records, corrupt, damage) {
  const first = records[0] || null;
  const last = records[records.length - 1] || null;
  const intents = new Map();
  const dispatched = new Map();
  const completed = [];
  const recoveryAttempts = [];
  let baseCheckpoint = null;
  let latestCheckpoint = null;
  let runCreated = null;        // reconstructed run-created messages: last snapshot + every later delta
  let deltaMismatch = false;    // a delta that does not extend exactly the reconstructed list (never written by us)
  let resolution = null;
  let finishPayload = null;
  let continuation = null;
  let taintedBy = '';           // first durable taint latch (a 'taint' record) — see makeRunJournal.taint
  let otherTaint = '';          // the first one that is not the bare attachment stamp (taint.js ATTACHMENT_TAINT), which must not hide a later source
  const quoted = new Map();     // streamId -> the earliest read epoch (the 'quotes' records)
  let quotesSaturatedAt = null; // set once a 'quotes' record says the run could not record everything it read
  for (const r of records) {
    if (r.type === 'taint' && r.payload && r.payload.source) {
      const source = String(r.payload.source).slice(0, 200);
      if (!taintedBy) taintedBy = source;
      if (!otherTaint && source !== ATTACHMENT_TAINT) otherTaint = source;
    }
    if (r.type === 'quotes' && r.payload) {
      for (const e of Array.isArray(r.payload.streams) ? r.payload.streams : []) {
        const id = e && typeof e.id === 'string' && QUOTE_SID_RE.test(e.id) ? e.id : '', at = e && isTime(e.at) ? e.at : 0;
        if (id && (!quoted.has(id) || at < quoted.get(id))) quoted.set(id, at);
      }
      if (isTime(r.payload.saturatedAt)) quotesSaturatedAt = quotesSaturatedAt === null ? r.payload.saturatedAt : Math.min(quotesSaturatedAt, r.payload.saturatedAt);
    }
    if (r.type === 'checkpoint') {
      if (r.payload && r.payload.phase === 'initial' && !baseCheckpoint) baseCheckpoint = r.payload;
      else {
        latestCheckpoint = r.payload;
        runCreated = Array.isArray(r.payload && r.payload.messages) ? r.payload.messages.slice() : [];
      }
    }
    if (r.type === 'checkpoint_delta' && r.payload) {
      const current = runCreated || [];
      if (Number(r.payload.from) !== current.length) deltaMismatch = true;
      else {
        for (const m of (Array.isArray(r.payload.messages) ? r.payload.messages : [])) current.push(m);
        runCreated = current;
        latestCheckpoint = r.payload;
      }
    }
    if (r.type === 'tool_intent' && r.payload && r.payload.callId) intents.set(String(r.payload.callId), r.payload);
    if (r.type === 'tool_dispatch' && r.payload && r.payload.callId) dispatched.set(String(r.payload.callId), r.payload);
    if (r.type === 'tool_result' && r.payload && r.payload.callId) {
      const callId = String(r.payload.callId);
      if (intents.has(callId)) completed.push({ intent: intents.get(callId), dispatch: dispatched.get(callId) || null, result: r.payload });
      intents.delete(callId);
      dispatched.delete(callId);
    }
    if (r.type === 'recovery_attempt' && r.payload) recoveryAttempts.push(r.payload);
    if (r.type === 'resolution' && r.payload) resolution = r.payload;
    if (r.type === 'finish') finishPayload = r.payload || {};
    if (r.type === 'continuation_ready' && r.payload) continuation = Object.assign({ state: 'ready' }, r.payload);
    if (r.type === 'continuation_start' && r.payload && continuation) continuation = Object.assign({}, continuation, r.payload, { state: 'started' });
    if (r.type === 'continuation_finish' && r.payload && continuation) continuation = Object.assign({}, continuation, r.payload, { state: 'finished' });
  }
  // There are now two durable pre-result boundaries:
  //   prepared (`tool_intent`)   — registry gates still run; the tool definitely has not started
  //   dispatched (`tool_dispatch`) — written at the registry's last pre-run seam; the tool may have started
  // Only prepared intents carrying DISPATCH_BOUNDARY_MODEL receive the new safe classification. Old journals
  // remain conservative because their unmatched intent may already have crossed into tool.run. Dispatched reads
  // are replayable; dispatched mutations are review-required. A dispatch record with no intent is malformed
  // evidence, so it is treated as uncertain unless it explicitly proves the tool was read-only.
  const pendingIds = new Set(Array.from(intents.keys()).concat(Array.from(dispatched.keys())));
  const replayableReads = [];
  const replayablePrepared = [];
  const uncertain = [];
  for (const callId of pendingIds) {
    const intent = intents.get(callId) || null;
    const dispatch = dispatched.get(callId) || null;
    const pending = Object.assign({}, intent || {}, dispatch || {}, { callId });
    if (dispatch) {
      if (pending.mutating === false) replayableReads.push(pending);
      else uncertain.push(pending);
    } else if (intent && intent.boundaryModel === DISPATCH_BOUNDARY_MODEL) {
      replayablePrepared.push(pending);
    } else if (pending.mutating === false) {
      replayableReads.push(pending);
    } else {
      uncertain.push(pending);
    }
  }
  // more than the capacity can only be a saturated run: never a cut list
  if (quoted.size > TurnKinds.QUOTES_MAX) {
    const earliest = Math.min(...quoted.values());
    quotesSaturatedAt = quotesSaturatedAt === null ? earliest : Math.min(quotesSaturatedAt, earliest);
    quoted.clear();
  }
  const terminal = finishPayload !== null;
  const transcriptAck = !!(terminal && finishPayload.transcriptAck === true);
  if (latestCheckpoint) {
    // The latest phase/turn with the reconstructed message list (a delta's `from` is bookkeeping, not state).
    const rest = Object.assign({}, latestCheckpoint);
    delete rest.from;
    latestCheckpoint = Object.assign(rest, { messages: runCreated || [] });
  }
  let checkpoint = latestCheckpoint || baseCheckpoint || (first && first.type === 'begin' ? first.payload : {});
  if (baseCheckpoint && latestCheckpoint) {
    checkpoint = Object.assign({}, latestCheckpoint, {
      messages: (Array.isArray(baseCheckpoint.messages) ? baseCheckpoint.messages : [])
        .concat(Array.isArray(latestCheckpoint.messages) ? latestCheckpoint.messages : [])
    });
  }
  const uncertainIds = uncertain.map(x => String(x.callId || '')).sort();
  const resolutionIds = resolution && Array.isArray(resolution.outcomes)
    ? resolution.outcomes.map(x => String((x && x.callId) || '')).sort() : [];
  const resolutionValid = !!(resolution && uncertainIds.length && stable(uncertainIds) === stable(resolutionIds)
    && resolution.outcomes.every(x => x && /^(?:happened|did_not_happen|unknown)$/.test(String(x.outcome || ''))));
  // Explicit damage verdict. `corrupt` keeps its historical meaning (the parse stopped early); `forensic` is what
  // blocks in-app action: any damage except a lone torn final record, or a delta chain we did not write.
  const damageClass = deltaMismatch ? 'corrupt' : (corrupt ? (damage === 'torn_tail' ? 'torn_tail' : 'corrupt') : 'none');
  const forensic = damageClass === 'corrupt';
  const status = resolutionValid ? 'resolved' : (uncertain.length ? 'needs_review' : (terminal ? (transcriptAck ? 'finished' : 'awaiting_commit') : 'resumable'));
  const exposedContinuation = (resolutionValid || !uncertain.length) ? continuation : null;
  // A source journal is settled once its continuation finished AND that continuation's own transcript
  // acknowledgement was durably recorded first (the same order finishAndRetire uses for an ordinary run).
  const continuationSettled = !!(exposedContinuation && exposedContinuation.state === 'finished'
    && exposedContinuation.transcriptAck === true);
  const begun = first && first.type === 'begin' && first.payload && first.payload.initialTaint ? String(first.payload.initialTaint).slice(0, 200) : '';   // the taint the run STARTED with
  return {
    runId: first ? first.runId : '', records: records.length, corrupt: !!corrupt || deltaMismatch, terminal,
    damage: damageClass, forensic,
    // A terminal run event cannot prove what happened inside a tool that returned no durable result. The intent
    // remains review-required even if the loop caught an exception and cleanly emitted run.end afterward.
    status,
    // Retirement: an ordinary finished run, or a settled continuation source. Never forensic, never unresolved.
    retirable: !forensic && (status === 'finished'
      || (continuationSettled && (status === 'resolved' || status === 'resumable'))),
    meta: first && first.type === 'begin' ? first.payload : {},
    // UNTRUSTED-CONTENT TAINT the run carried (begin meta's initialTaint, else its first mid-run latch). A recovery
    // continuation replays this run's context, so it must start with the same taint (index.js replayedTaint). The bare
    // attachment stamp never hides a later source: a run that began holding an attachment and then read a page reports the
    // page (index.js latchRunTaint journals it), so the continuation's rows carry a stamp that does not decay.
    taintedBy: (begun !== ATTACHMENT_TAINT && begun) || otherTaint || begun || taintedBy || null,
    // THE SESSIONS THIS RUN READ ('quotes' records, written before the tool_result record they cover): [{ id, at }] and, once the run
    // could not record everything it read, the time it saturated. A continuation seeds its latch from these; a delete since refuses it.
    quotes: Array.from(quoted, ([id, at]) => ({ id, at })), quotesSaturatedAt,
    firstTs: first ? Number(first.ts) || 0 : 0, lastTs: last ? Number(last.ts) || 0 : 0,
    uncertain, replayableReads, replayablePrepared, completed, recoveryAttempts,
    baseCheckpoint: baseCheckpoint || {}, deltaCheckpoint: latestCheckpoint || {},
    checkpoint: checkpoint || {}, finish: finishPayload,
    resolution: resolutionValid ? resolution : null,
    // Automatic continuation exists only on uncertainty-free journals. Reviewed continuation remains bound to
    // a valid operator resolution. Never expose a continuation record alongside unresolved uncertainty.
    continuation: exposedContinuation
  };
}

function resolutionError(message) {
  const e = new Error(message); e.code = 'RUN_RESOLUTION_CONFLICT'; return e;
}

function makeRunJournal(opts) {
  opts = opts || {};
  const io = opts.io || makeFsIo(opts);
  // The ambient host injects real time. A pure caller that omits it gets a deterministic zero stamp.
  const now = opts.clock && typeof opts.clock.now === 'function' ? () => opts.clock.now() : () => 0;
  const redact = typeof opts.redact === 'function' ? opts.redact : s => s;
  const live = new Map();
  // Runs THIS instance began and has not yet recorded a finish for. One sidecar owns a journal directory, so an
  // unfinished journal outside this set belongs to a process that is gone: it is interrupted, not in flight.
  const owned = new Set();
  // Delta bookkeeping per active run: the exact message objects already journaled and their leaf signatures.
  const trackers = new Map();

  // A journal written by an earlier process (never recovered in this one) must be made append-safe before the
  // first new record: derive the chain position from disk, cut a torn tail, terminate an unterminated final line.
  // Appending blind used to restart the chain at seq 1 (or glue onto torn bytes), destroying the journal.
  function adopt(runId) {
    let raw;
    try { raw = io.read(runId); }
    catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
    if (raw == null || raw === '') return;
    const file = typeof io.fileOf === 'function' ? io.fileOf(runId) : runId;
    const state = recoverFile(file, raw);
    if (state.repairError) throw new Error('run journal is not append-safe: ' + state.repairError);
    if (state.quarantinedTo) throw new Error('run journal had no valid record and was quarantined');
    if (state.runId !== runId) throw new Error('run journal identity does not match its file');
  }

  function record(runId, type, payload, fresh) {
    runId = String(runId || '');
    if (!runId) throw new Error('run journal runId is required');
    if (!fresh && !live.has(runId)) adopt(runId);
    const prior = live.get(runId) || { seq: 0, hash: '' };
    const r = { v: VERSION, runId, seq: prior.seq + 1, ts: now(), type, payload: type === 'quotes' ? quotesPayload(payload) : cloneSafe(payload || {}, redact, 0), prev: prior.hash };
    r.hash = hashRecord(r);
    const line = JSON.stringify(r);
    if (fresh) io.create(runId, line); else io.append(runId, line);
    live.set(runId, { seq: r.seq, hash: r.hash });
    if (type === 'begin') owned.add(runId);
    if (type === 'finish') { owned.delete(runId); trackers.delete(runId); }
    return r;
  }

  // Journal the run-created message list as a delta whenever the previously journaled objects are still an
  // unchanged prefix of it; otherwise (the loop rewrote its working array) as a full snapshot. Lists longer than
  // MAX_ARRAY are chunked so cloneSafe's array bound never drops a message.
  function checkpointMessages(runId, payload) {
    runId = String(runId || '');
    payload = payload || {};
    const list = Array.isArray(payload.messages) ? payload.messages.slice() : [];
    const head = Object.assign({}, payload);
    delete head.messages; delete head.from;
    const sigs = list.map(m => leafSignature(m, [], 0));
    const t = trackers.get(runId);
    let from = -1;
    if (t && t.objs.length <= list.length) {
      from = t.objs.length;
      for (let i = 0; i < t.objs.length; i++) {
        if (list[i] !== t.objs[i] || !sameSignature(sigs[i], t.sigs[i])) { from = -1; break; }
      }
    }
    // Any failure part-way leaves the on-disk reconstruction unknown to the tracker: drop it so the next
    // checkpoint re-anchors with a full snapshot instead of a delta whose `from` would not match.
    trackers.delete(runId);
    let last = null;
    let at = from;
    if (from < 0) {
      last = record(runId, 'checkpoint', Object.assign({}, head, { messages: list.slice(0, MAX_ARRAY) }));
      at = Math.min(MAX_ARRAY, list.length);
    }
    while (last === null || at < list.length) {
      last = record(runId, 'checkpoint_delta', Object.assign({}, head, { from: at, messages: list.slice(at, at + MAX_ARRAY) }));
      at = Math.min(at + MAX_ARRAY, list.length);
    }
    trackers.set(runId, { objs: list, sigs });
    return last;
  }

  // A repaired journal parses clean, but the damage it had is durable in its sibling's name. Mid-file damage stays
  // forensic across every later inspect (and so never resolves, continues, or retires); a cut torn tail does not.
  function withEvidence(state, file, evidenceOf) {
    const read = typeof evidenceOf === 'function' ? evidenceOf : (typeof io.evidence === 'function' ? io.evidence : null);
    if (!state || !file || !read) return state;
    let ev;
    try { ev = read(file); }
    catch (e) { failNote('run-journal.evidence', e); ev = { corrupt: true, torn: false }; }   // unprovable: fail closed
    // the damage evidence of THIS file is now folded in (`forensic` covers a `.corrupt*` sibling): a host need not
    // list the directory again to learn it. Non-enumerable, so no serialized or compared state changes shape.
    Object.defineProperty(state, 'evidenceSeen', { value: true, enumerable: false, configurable: true });
    if (ev.corrupt) {
      state.forensic = true; state.retirable = false; state.damage = 'corrupt';
    } else if (ev.torn && state.damage === 'none') {
      state.damage = 'torn_tail';
    }
    return state;
  }

  function inspect(runId) {
    const p = parseRecords(io.read(runId));
    return withEvidence(analyze(p.records, p.corrupt, p.damage), typeof io.fileOf === 'function' ? io.fileOf(runId) : null);
  }

  /* HEADS (perf review 10-19): a journal's begin record — its first record — names the conversation and agent it
     belongs to, and it never changes (appends, repairs and continuations keep record 1). Kept per file name, from
     every full parse and from a bounded first-line read, so a recovery listing for ONE conversation parses only that
     conversation's journals instead of a hash-ordered first page that missed it once there were >100 journals. */
  const heads = new Map();   // journal file basename -> { streamId, agentId } exactly as the recovery DTO derives them
  const baseOf = (file) => String(file || '').split(/[\\/]/).pop();
  function headFromMeta(meta) {
    meta = meta || {};
    return { streamId: String(meta.streamId || 'global'), agentId: String(meta.agentId || '') };
  }
  function headOf(file) {
    const base = baseOf(file);
    if (heads.has(base)) return heads.get(base);
    if (typeof io.readHead !== 'function') return null;
    let line = null;
    try { line = io.readHead(file); } catch (e) { if (!e || e.code !== 'ENOENT') failNote('run-journal.head', e); return null; }
    if (line == null) return null;   // unknown: the caller parses the whole journal and decides from it
    let r = null;
    try { r = JSON.parse(line); } catch (_) { r = null; }
    // exactly parseRecords' first-record rule + analyze's meta rule: anything else analyzes to meta {}
    const valid = r && r.v === VERSION && r.seq === 1 && r.prev === '' && r.hash === hashRecord(r);
    const h = headFromMeta(valid && r.type === 'begin' ? r.payload : {});
    heads.set(base, h);
    return h;
  }
  /* A journal that cannot be READ right now (EBUSY/EACCES/EPERM: an antivirus scan or another process holds it, or it
     is gone since it was listed) is not damage, so it is never repaired or moved aside: persist's errno policy, where
     unreadable is never empty and never corrupt. It gets no live entry and keeps its cached head, and it carries no
     identity, so the boot walk skips it and the next walk or listing reads it again. Every route that acts on a journal
     refuses one with a repairError (resolve, continue, adopt), so it is listed for nothing until it reads. */
  function unreadableState(file, err) {
    const state = analyze([], false, 'none');
    state.file = file;
    state.unreadable = true;
    state.readError = String((err && err.code) || (err && err.message) || err);
    state.repairError = 'run journal could not be read (' + state.readError + '); left in place and read again on the next pass';
    return state;
  }
  function recoverFile(file, rawText, evidenceOf) {
    let raw = rawText;
    if (raw == null) {
      try { raw = io.readFile(file); }
      catch (e) { return unreadableState(file, e); }
    }
    let parsed;
    try { parsed = parseRecords(raw); }
    catch (_) { parsed = { records: [], corrupt: true, damage: 'corrupt' }; }
    const state = analyze(parsed.records, parsed.corrupt, parsed.damage);
    state.file = file;
    heads.set(baseOf(file), headFromMeta(state.meta));
    try {
      if (parsed.corrupt && parsed.records.length && typeof io.repair === 'function') {
        state.repairedFrom = io.repair(file, parsed.records, parsed.damage === 'torn_tail' ? 'torn' : 'corrupt');
      } else if (parsed.corrupt && !parsed.records.length && typeof io.quarantine === 'function') {
        state.quarantinedTo = io.quarantine(file);
      } else if (parsed.unterminated && typeof io.terminate === 'function') {
        io.terminate(file);
      }
    } catch (e) { state.repairError = String((e && e.message) || e); }
    if (state.runId && parsed.records.length && !state.repairError) {
      const last = parsed.records[parsed.records.length - 1];
      live.set(state.runId, { seq: last.seq, hash: last.hash });
    }
    if (state.quarantinedTo) heads.delete(baseOf(file));
    return state.quarantinedTo ? state : withEvidence(state, file, evidenceOf);
  }

  return {
    begin(meta) { return record(meta && meta.runId, 'begin', meta, true); },
    checkpoint(runId, payload) { return record(runId, 'checkpoint', payload); },
    recoveryAttempt(runId, payload) { return record(runId, 'recovery_attempt', payload); },
    toolIntent(runId, payload) { return record(runId, 'tool_intent', payload); },
    toolDispatch(runId, payload) { return record(runId, 'tool_dispatch', payload); },
    toolResult(runId, payload) { return record(runId, 'tool_result', payload); },
    // the run's taint latched mid-run (untrusted content entered its context); additive record type
    taint(runId, payload) { return record(runId, 'taint', payload); },
    // the sessions this run has read ({ streams: [{ id, at }], saturatedAt? }); written BEFORE the tool_result record it covers, so a journal
    // that holds a read's result always holds its quote (additive record type, index.js latchRunQuotes)
    quotes(runId, payload) { return record(runId, 'quotes', payload); },
    finish(runId, payload) { return record(runId, 'finish', payload); },
    resolve(runId, payload) {
      payload = payload || {};
      const state = inspect(runId);
      const normalized = {
        resolutionId: String(payload.resolutionId || ''),
        operator: String(payload.operator || 'local'),
        resolvedAt: Number(payload.resolvedAt || now()),
        outcomes: (Array.isArray(payload.outcomes) ? payload.outcomes : []).map(x => ({
          callId: String((x && x.callId) || ''), outcome: String((x && x.outcome) || '')
        })),
        note: String(payload.note || '').slice(0, 500)
      };
      if (!normalized.resolutionId) throw resolutionError('resolutionId is required');
      if (state.resolution) {
        const existing = state.resolution;
        const sameDecision = existing.resolutionId === normalized.resolutionId
          && stable(existing.outcomes || []) === stable(normalized.outcomes)
          && String(existing.note || '') === normalized.note;
        if (sameDecision) return state;
        throw resolutionError('run already has a different durable resolution');
      }
      // A lone torn final record is not forensic (see header): its valid prefix resolves like an intact journal.
      if (state.status !== 'needs_review' || state.forensic) throw resolutionError('run is not safely resolvable');
      const expected = state.uncertain.map(x => String(x.callId || '')).sort();
      const actual = normalized.outcomes.map(x => x.callId).sort();
      if (!expected.length || stable(expected) !== stable(actual)
        || new Set(actual).size !== actual.length
        || normalized.outcomes.some(x => !/^(?:happened|did_not_happen|unknown)$/.test(x.outcome))) {
        throw resolutionError('resolution must account for every uncertain call exactly once');
      }
      record(runId, 'resolution', normalized);
      return inspect(runId);
    },
    prepareContinuation(runId, payload) {
      payload = payload || {};
      const state = inspect(runId);
      const continuationId = String(payload.continuationId || '');
      if (!continuationId) throw resolutionError('continuationId is required');
      if (state.continuation) {
        if (state.continuation.continuationId === continuationId) return state;
        throw resolutionError('run already has a different durable continuation');
      }
      const mode = payload.mode === 'automatic' ? 'automatic' : 'reviewed';
      const reviewed = state.status === 'resolved' && !!state.resolution;
      const automatic = mode === 'automatic' && state.status === 'resumable' && !state.uncertain.length;
      if ((!reviewed && !automatic) || state.forensic) throw resolutionError('run is not safely continuable');
      record(runId, 'continuation_ready', {
        continuationId,
        mode,
        operator: String(payload.operator || 'local'),
        preparedAt: Number(payload.preparedAt || now()),
        blockedFingerprints: (Array.isArray(payload.blockedFingerprints) ? payload.blockedFingerprints : []).map(String).sort(),
        context: String(payload.context || '').slice(0, 4000)
      });
      return inspect(runId);
    },
    startContinuation(runId, payload) {
      payload = payload || {};
      const state = inspect(runId);
      const continuationId = String(payload.continuationId || '');
      const continuedRunId = String(payload.continuedRunId || '');
      if (!state.continuation || state.continuation.continuationId !== continuationId) throw resolutionError('continuation was not durably prepared');
      if (state.continuation.state !== 'ready') {
        if (state.continuation.continuedRunId === continuedRunId) return state;
        throw resolutionError('continuation already started');
      }
      if (!continuedRunId) throw resolutionError('continuedRunId is required');
      record(runId, 'continuation_start', { continuationId, continuedRunId, startedAt: Number(payload.startedAt || now()) });
      return inspect(runId);
    },
    finishContinuation(runId, payload) {
      payload = payload || {};
      const state = inspect(runId);
      const continuationId = String(payload.continuationId || '');
      const continuedRunId = String(payload.continuedRunId || '');
      if (!state.continuation || state.continuation.continuationId !== continuationId
        || state.continuation.continuedRunId !== continuedRunId) throw resolutionError('continuation identity does not match');
      if (state.continuation.state === 'finished') return state;
      if (state.continuation.state !== 'started') throw resolutionError('continuation has not started');
      record(runId, 'continuation_finish', {
        continuationId, continuedRunId, finishedAt: Number(payload.finishedAt || now()),
        reason: String(payload.reason || 'unknown'),
        // true only when the host proved the continued run's own transcript acknowledgement was durably recorded
        // first — the one fact that makes this source journal redundant and retirable.
        transcriptAck: payload.transcriptAck === true
      });
      return inspect(runId);
    },
    finishAndRetire(runId, payload) {
      record(runId, 'finish', payload);
      const state = inspect(runId);
      if (!state.retirable) return { retired: false, state };
      const retired = this.remove(runId);
      return { retired: !!retired, state };
    },
    // Retirement is a safety boundary, not a raw unlink. A terminal record does not settle an unmatched tool
    // intent: that journal is the only durable evidence that a side effect may have happened, so ordinary host
    // teardown must retain it for review. Corrupt/unreadable journals also fail closed and remain recoverable.
    // A continuation SOURCE retires once its continuation finished with a durable transcript acknowledgement
    // (analyze().retirable); forensic and unresolved-review journals never do.
    remove(runId) {
      let state;
      try { state = inspect(runId); } catch (_) { return false; }
      if (!state || !state.retirable) return false;
      live.delete(String(runId || ''));
      trackers.delete(String(runId || ''));
      owned.delete(String(runId || ''));
      io.remove(runId);
      return true;
    },
    inspect,
    checkpointMessages,
    // Begun by this instance and not yet finished: a live run of this process, never "interrupted".
    isOwned(runId) { return owned.has(String(runId || '')); },
    // The journal files present right now (sorted, unparsed). A host captures this before it can start a run, so
    // every file in it provably belongs to an earlier process.
    listFiles() { return io.list().sort(); },
    recoverFile(file) { return recoverFile(file); },
    // read (and keep) one journal's head without parsing it — a boot walk warms the journals it does not parse
    warmHead(file) { return headOf(file); },
    recoverAll() {
      return io.list().sort().map(file => recoverFile(file));
    },
    // Lazy/paged recovery preserves every journal while preventing thousands of failed runs
    // from blocking process startup or producing one unbounded API response. Stable filename
    // ordering makes offset pagination deterministic; no file is deleted here.
    // options.streamId / options.agentId (optional, additive): only that conversation's (and agent's) journals —
    // matched on the begin record exactly as the recovery DTO derives streamId/agentId — so the caller's run is
    // found however many other journals sort ahead of it. Without them the listing is unchanged.
    recoverPage(options) {
      options = options || {};
      const snap = typeof io.snapshot === 'function' ? io.snapshot() : null;
      let files = (snap ? snap.files : io.list()).sort();
      if (snap) { const present = new Set(files.map(baseOf)); for (const k of heads.keys()) if (!present.has(k)) heads.delete(k); }
      const stream = options.streamId != null ? String(options.streamId) : null;
      const agent = options.agentId != null ? String(options.agentId) : null;
      const matches = (h) => (stream == null || h.streamId === stream) && (agent == null || h.agentId === agent);
      const filtered = stream != null || agent != null;
      if (filtered) files = files.filter(file => { const h = headOf(file); return !h || matches(h); });
      const offset = Math.max(0, Number(options.offset) || 0);
      const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
      let rows = files.slice(offset, offset + limit).map(file => recoverFile(file, null, snap ? snap.evidence : null));
      if (filtered) rows = rows.filter(r => r && matches(headFromMeta(r.meta)));   // a head too long to pre-read decides here
      return { rows, total: files.length, offset, limit };
    },
    _internals: { parseRecords, analyze, hashRecord, runFileName, cloneSafe, writeAll, leafSignature, sameSignature }
  };
}

module.exports = { makeRunJournal, makeFsIo, DISPATCH_BOUNDARY_MODEL, quotesForgotten, _internals: { parseRecords, analyze, hashRecord, runFileName, cloneSafe, writeAll, leafSignature, sameSignature } };
