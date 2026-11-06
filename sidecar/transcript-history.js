/* sidecar/transcript-history.js — dependency-free segmented transcript persistence.

   Closed JSONL segments are immutable. A small durable manifest records segment ranges and
   per-stream summaries; each closed segment has a durable term index. Queries load indexes and
   segment bodies one at a time, so lifetime history is retained without becoming boot-time RAM.
   The active segment is append-only + fsync'd, and appendDurable() reads the appended row back as a
   complete, newline-bounded LINE of the file before claiming success (a torn tail is isolated first).
   Legacy transcript.jsonl(.1) files are imported without deleting or rewriting the originals.

   COST PER ROW AND PER READ (perf review 2026-10-19, #4/#5). Every row used to open the segment three times (tail
   byte, append, read-back; each open is a Defender rescan of a file growing to 4 MB) and SHA-256 the whole ~1 MB
   active index, which only a manifest write ever persists. Every history read re-read and re-parsed whole segments.
   Now: ONE 'a+' handle stays open on the append-active segment (the same fsync and the same read-back proof per
   row, through that handle, after an attribute-only stat proves the handle is still the file at the path), the tail
   byte is remembered after our own proven append (re-read whenever the file size is not the size we left it at), and
   the active checksum is computed when the manifest is written. Reads answer from parses that are exact for the bytes
   they cover: the active segment's (checked against its size on every read), a byte-bounded cache of the newest
   closed segments (immutable) plus the one parsed most recently, their verified term indexes, and each stream's own
   rows of a closed segment. A recall counts its query terms in a row (countTerms) instead of splitting the row into
   every word, and a stream-scoped recall scores the stream's own cached rows without loading the segment's index. */
'use strict';

const { writeFileDurable } = require('./durable-write.js');
const { note: failNote } = require('./failopen.js');   // a new catch here is never silent (fail-open ratchet)
const crypto = require('node:crypto');
const { conversationPreview } = require('./transcriptstore.js');

const VERSION = 2;
const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_RECENT_PER_STREAM = 1200;
const PREVIEW_SEGMENTS_PER_STREAM = 4;
const TOKEN_MAX = 64;
const UNREADABLE = Object.freeze([]);   // readRows' answer for a segment it could not read (never cached as its rows)
/* UNIQUE ROWIDS ON EVERY BOOT PATH (turn-identity, A2-ID-01). Every copy of a turn is matched by (streamId, rowId), so
   no boot may mint an id it cannot prove unused: see provenFloor() below. */
const LEASE_FILE = 'rowid-lease.json';   // { v: 1, next }: the durable rowId high-water mark (never minted at or above)
const ROWID_LEASE = 1024;                // ids leased per lease write: one small fsync'd write per boot and per 1024 rows
const REPROBE_MS = 30 * 1000;            // unsafe mode re-runs its proof at most this often (on an append)
const AUDIT_MAX = 50;                    // idCollisions kept for status()
// the default clock of the re-probe when none is injected: monotonic, so a wall-clock step never delays it
function monotonicMs() { return Number(process.hrtime.bigint() / 1000000n); }
const CJK_CHAR = /^(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul})$/u;
const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function str(v) { return v == null ? '' : String(v); }
function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : Number(v) || 0; }
// Transcript content and stream ids are untrusted dictionary keys: "constructor" must never resolve to an inherited
// Object.prototype value (a JSON-loaded index made every recall containing that word throw).
function hasOwn(o, k) { return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
function nullProtoMap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return Object.create(null);
  return Object.getPrototypeOf(v) === null ? v : Object.assign(Object.create(null), v);
}
function wordTokens(v) {
  // NFKC makes compatibility spellings (for example full-width Latin/digits) search the
  // same way while Unicode properties retain words written outside ASCII. Scripts that
  // ordinarily omit spaces are indexed per character so a query can match part of a phrase.
  const normalized = str(v).normalize('NFKC').toLowerCase();
  const out = [];
  for (const word of (normalized.match(/[\p{L}\p{N}]+/gu) || [])) {
    // a word with no character from those scripts is one token: the per-character walk below rebuilds exactly it
    if (!HAS_CJK.test(word)) { out.push(word); continue; }
    let run = '';
    for (const char of word) {
      if (!CJK_CHAR.test(char)) { run += char; continue; }
      if (run) { out.push(run); run = ''; }
      out.push(char);
    }
    if (run) out.push(run);
  }
  return out.filter(t => t.length <= TOKEN_MAX);
}
function tokenize(v) { return Array.from(new Set(wordTokens(v))); }
/* HOW OFTEN EACH QUERY TERM IS A TOKEN OF A ROW, without building the row's tokens (perf review 2026-10-19, "Lifetime
   search"). A recall scored every candidate row by splitting its whole content into words (a Unicode regex match and an
   array of every word, then a map lookup per word): that was most of a recall's cost. The answer is the same count of
   the same tokens: on the same NFKC + lower-cased text, an occurrence of a term IS one of wordTokens' tokens exactly when
   wordTokens would cut there on both sides: at either end of the text, at a character that is neither a letter nor a
   number, or beside a CJK character (each of those is a token of its own, so a CJK term counts wherever it occurs).
   counts[k] receives the count for terms[k]; terms are tokenize() output (each a whole token, at most TOKEN_MAX long). */
const WORD_CHAR = /^[\p{L}\p{N}]$/u;
function asciiWordCode(c) { return (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90); }
function cutsToken(ch) { return !WORD_CHAR.test(ch) || CJK_CHAR.test(ch); }
function cutBefore(s, i) {
  if (i <= 0) return true;
  const c = s.charCodeAt(i - 1);
  if (c < 128) return !asciiWordCode(c);
  const pair = (c & 0xfc00) === 0xdc00 && i >= 2 && (s.charCodeAt(i - 2) & 0xfc00) === 0xd800;
  return cutsToken(pair ? s.slice(i - 2, i) : s[i - 1]);
}
function cutAfter(s, j) {
  if (j >= s.length) return true;
  const c = s.charCodeAt(j);
  if (c < 128) return !asciiWordCode(c);
  const pair = (c & 0xfc00) === 0xd800 && j + 1 < s.length && (s.charCodeAt(j + 1) & 0xfc00) === 0xdc00;
  return cutsToken(pair ? s.slice(j, j + 2) : s[j]);
}
function countTerms(text, terms, counts) {
  const s = str(text).normalize('NFKC').toLowerCase();
  for (let k = 0; k < terms.length; k++) {
    const t = terms[k];
    let c = 0;
    if (CJK_CHAR.test(t)) for (let at = s.indexOf(t); at >= 0; at = s.indexOf(t, at + t.length)) c++;
    else for (let at = s.indexOf(t); at >= 0; at = s.indexOf(t, at + 1)) if (cutBefore(s, at) && cutAfter(s, at + t.length)) c++;
    counts[k] = c;
  }
  return counts;
}
function segmentName(n) { return 'segment-' + String(n).padStart(6, '0') + '.jsonl'; }
function indexName(n) { return 'segment-' + String(n).padStart(6, '0') + '.index.json'; }
function clone(v) { return Object.assign({}, v); }
function publicRow(v) { const out = clone(v); delete out.legacyKey; return out; }
function indexHash(index) { return crypto.createHash('sha256').update(JSON.stringify(index)).digest('hex'); }
/* What a search hit says about the row beside its words, ONLY when the row has it (a hit of any other row is unchanged): the
   words typed beside a content that holds something else (a row of the 11-02 shape stores a file's text in the content), the
   references of the files it carried, and, for an ATTACHMENT row alone, its kind. A reader that shows the hit
   (recall_conversation) renders the Commander's words and '[attached: name]' from these, never a file's text
   (sidecar/turn-attachment.js textOf); the visibility matrix classifies a system row by its kind, and without it an attachment
   row would read as a local line and never be recalled. Other kinds stay as they were (a steer note or a deliverable row is no
   more findable by search than before; widening that is not this step's call). */
function hitExtras(row) {
  const out = {};
  if (row.kind === 'attachment') out.kind = row.kind;
  if (typeof row.typed === 'string') out.typed = row.typed;
  if (Array.isArray(row.attachments)) out.attachments = row.attachments.slice();
  return out;
}

function makeSegmentedTranscriptIo(opts) {
  const o = opts || {};
  const fs = o.fs;
  const path = o.path;
  if (!fs || !path) throw new Error('makeSegmentedTranscriptIo requires injected fs + path');
  const root = o.root;
  if (!root) throw new Error('makeSegmentedTranscriptIo requires root');
  const segmentBytes = Math.max(256, num(o.segmentBytes) || DEFAULT_SEGMENT_BYTES);
  const recentPerStream = Math.max(1, num(o.recentPerStream) || DEFAULT_RECENT_PER_STREAM);
  // RAM the read caches may hold: parsed closed segments (by their JSONL bytes: 2 segments by default, ~1.5x that in
  // heap, plus the one-slot most recent parse) and verified closed term indexes (by their JSON characters: one segment's
  // worth: a full segment's index measured ~0.4-0.55x its bytes as text and parses to ~2.4x its text, so this holds the
  // newest one or two closed indexes, at most ~10 MB of heap, and only a recall reads one). 0 turns a cache off.
  const rowsCacheBytes = o.cacheBytes != null ? Math.max(0, num(o.cacheBytes)) : segmentBytes * 2;
  const indexCacheBytes = o.indexCacheBytes != null ? Math.max(0, num(o.indexCacheBytes)) : segmentBytes;
  // ONE stream's rows of a closed segment (history's unit of work), by their approximate JSON characters: one segment's
  // worth. A conversation whose rows are sprinkled through dozens of closed segments between loop and routine traffic
  // re-read and re-parsed every one of those segments 2-4 times a run, because only the 2 newest whole segments fit the
  // parse cache; its own rows are a small fraction of them. A slice larger than 1/8 of this budget is a stream dense
  // enough that its reads end in the newest segments, which the parse cache already holds: it is not kept here.
  const sliceCacheBytes = o.sliceCacheBytes != null ? Math.max(0, num(o.sliceCacheBytes)) : segmentBytes;
  const warn = typeof o.onWarning === 'function' ? o.onWarning : function () {};
  const durableWrite = typeof o.writeDurable === 'function' ? o.writeDurable : writeFileDurable;
  const manifestFile = path.join(root, 'manifest.json');
  const legacyFiles = Array.isArray(o.legacyFiles) ? o.legacyFiles.slice() : [];
  let manifest;
  let activeIndex = null;
  let activeHashStale = false;   // the active meta's checksum lags activeIndex until the next manifest write
  let degraded = false;          // init failed: the in-memory view is not the disk's
  let unvouched = false;         // the active segment changed on disk outside this process: its counts may not be the disk's
  let appendFd = null;           // { n, fd }: the one open 'a+' handle, on the append-active segment
  let tail = null;               // { n, size, last }: the active file's size + last byte right after OUR last proven append
  let activeRows = null;         // { n, size, rows, bad }: the append-active segment's parse, exact for `size` bytes
  const closedRows = { map: new Map(), bytes: 0, budget: rowsCacheBytes };      // n -> { order, rows, bad, bytes } closed parses
  let lastClosed = null;         // { n, rows, bad, bytes }: the closed segment parsed most recently (see cacheNewest)
  const closedIndexes = { map: new Map(), bytes: 0, budget: indexCacheBytes }; // n -> { order, index, bytes } verified indexes
  const streamSlices = { map: new Map(), bytes: 0, budget: sliceCacheBytes };  // n + sid -> { order, rows, bytes }
  const verifiedIndex = new Map(); // n -> index file size:mtime + the manifest checksum it already matched
  const now = typeof o.now === 'function' ? o.now : monotonicMs;   // the unsafe-mode re-probe's clock
  const leaseFile = path.join(root, LEASE_FILE);
  let lease = 0;                 // the persisted lease's `next` (0: none parses): no id at or above it is ever minted
  let unsafe = false;            // no proven rowId floor: appendRaw refuses before minting (TRANSCRIPT_DEGRADED_UNSAFE)
  let unsafeWhy = '';
  let probedAt = 0;              // when the floor was last (re)proven while unsafe
  let idCollisions = [];         // bounded boot diagnostics: [{ kind, a, b, lo, hi }]
  let collisionRanges = [];      // authority uses every audit range, never the 50-entry diagnostic sample
  let resized = [];              // closed segments this boot found at a size their persisted meta does not record
  const staleIndexes = new Set();   // segments whose index this process built from an unreadable file
  const scans = new Map();       // n -> what a parse of segment n proved about its rowIds (noteScan)

  function warning(message) { try { warn(message); } catch (_) {} }
  function ensureRoot() { fs.mkdirSync(root, { recursive: true }); }
  function segFile(n) { return path.join(root, segmentName(n)); }
  function idxFile(n) { return path.join(root, indexName(n)); }
  function freshManifest() { return { version: VERSION, nextRowId: 1, activeSegment: 1, segments: [], legacy: [] }; }
  function saveManifest() {
    // The append-active checksum is computed once per manifest write instead of once per row: at a full segment
    // that index is ~1 MB of JSON, and only this persisted manifest ever carries the value (loadIndex returns the
    // live active index without checking it). The bytes written are the ones a per-row hash would have produced.
    if (activeHashStale && activeIndex) {
      const meta = manifest.segments.find(s => s.number === activeIndex.segment);
      if (meta) { meta.indexHash = indexHash(activeIndex); if (activeIndex.retracts) meta.retractsHash = indexHash(activeIndex.retracts); }
      activeHashStale = false;
    }
    durableWrite({ fs, path }, manifestFile, JSON.stringify(manifest));
  }
  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  }
  function parseSegmentNumber(name) {
    const m = /^segment-(\d{6})\.jsonl$/.exec(name);
    return m ? Number(m[1]) : 0;
  }
  function emptyIndex(n) {
    return { version: VERSION, segment: n, rows: 0, bytes: 0, minRowId: 0, maxRowId: 0, minTs: 0, maxTs: 0, corruptLines: 0, streams: Object.create(null), terms: Object.create(null), retracts: { v: 1, targets: [] } };
  }
  // the stream's browse preview: the latest visible prompt in this segment, with that row's own provenance
  function notePreview(stream, row) {
    const preview = conversationPreview(row);
    if (preview) {
      stream.preview = preview.replace(/\s+/g, ' ').trim().slice(0, 160);
      stream.previewTaint = row.taint || ''; stream.previewTaintKnown = row.taintKnown === true || !!row.taint;
    }
  }
  function noteIndex(index, row) {
    const id = num(row.rowId);
    const ts = num(row.ts);
    index.rows++;
    if (!index.minRowId || id < index.minRowId) index.minRowId = id;
    if (id > index.maxRowId) index.maxRowId = id;
    if (!index.minTs || (ts && ts < index.minTs)) index.minTs = ts;
    if (ts > index.maxTs) index.maxTs = ts;
    if (row.kind === 'retract' && Array.isArray(row.targets)) {
      for (const target of row.targets) if (Number.isSafeInteger(target) && target > 0)
        index.retracts.targets.push([target, row.reason === 'retry' ? 'retry' : 'undo']);
    }
    // Transcript content and stream ids are untrusted dictionary keys. Plain objects make
    // keys such as "constructor" resolve to inherited prototype values, while "__proto__"
    // can mutate the dictionary itself. Normalize both fresh and JSON-loaded indexes to
    // null-prototype maps before indexing them.
    index.streams = nullProtoMap(index.streams);
    index.terms = nullProtoMap(index.terms);
    const sid = str(row.streamId) || 'global';
    let stream = index.streams[sid];
    if (!stream) stream = index.streams[sid] = { count: 0, lastAt: 0, preview: '', previewVersion: 1 };
    stream.count++;
    if (ts >= stream.lastAt) stream.lastAt = ts;
    notePreview(stream, row);
    for (const term of tokenize(row.content)) {
      const ids = index.terms[term] || (index.terms[term] = []);
      ids.push(id);
    }
  }
  // One parse of a segment file: its rows, its unreadable non-blank lines (kept for strict reads), and its count of
  // non-empty lines (the index's corruptLines arithmetic). torn: the last unreadable line is the file's unterminated
  // final fragment (a crashed append's tail, which appendRaw never acknowledged).
  function parseSegment(buf) {
    const rows = [], bad = [];
    let nonempty = 0, torn = false;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line) nonempty++;
      if (!line.trim()) continue;
      let row = null;
      try { row = JSON.parse(line); } catch (_) { row = null; }
      if (row && typeof row === 'object' && num(row.rowId) > 0) { rows.push(row); continue; }
      bad.push(line);
      if (i === lines.length - 1) torn = true;
    }
    return { rows, bad, nonempty, bytes: buf.length, torn };
  }
  /* What one parse proves about a segment's rowIds (provenFloor's (i)): its max; its newline-terminated damaged lines
     (`damaged`: an unterminated final fragment is not one); and the ids met that are not above every id before them
     (dupLo..dupHi: trunk's degraded boot appended ids from 1 into a segment that already held them). */
  function noteScan(n, seg) {
    let max = 0, dupLo = 0, dupHi = 0;
    for (const row of seg.rows) {
      const id = num(row.rowId);
      if (id > max) { max = id; continue; }
      if (!dupLo || id < dupLo) dupLo = id;
      if (id > dupHi) dupHi = id;
    }
    const scan = { size: seg.bytes, max, damaged: seg.bad.length - (seg.torn ? 1 : 0), unreadable: false, dupLo, dupHi };
    scans.set(n, scan);
    return scan;
  }
  function readSegmentFile(n) { return parseSegment(fs.readFileSync(segFile(n))); }
  /* WHICH CLOSED PARSES STAY: the newest segments that fit the budget. A conversation reads newest-first and a
     lifetime search touches every segment, so least-recently-used would evict exactly what the next pass needs (a
     pass over one more segment than fits misses every time). Keeping the highest numbers holds what history reads
     most, and a pass larger than the cache neither empties it nor thrashes it.
     That policy alone never keeps an OLDER segment once the newest fill the budget, so readers that come back to the
     same older segment one after another (an away briefing reads every overnight routine's own cron-<runId> stream,
     several to a segment) each re-read it. So the closed segment parsed most recently is also kept, in one slot of
     its own (at most one more segment's parse; never when it alone exceeds the budget, so a budget of 0 keeps none). */
  function uncache(cache, key) {
    const prior = cache.map.get(key);
    if (prior) { cache.map.delete(key); cache.bytes -= prior.bytes; }
  }
  // entry.order: the segment number the entry was parsed from (the age "newest" is measured by)
  function cacheNewest(cache, key, entry) {
    uncache(cache, key);
    if (entry.bytes > cache.budget) return;
    while (cache.bytes + entry.bytes > cache.budget) {
      let oldestKey = null, oldest = Infinity;
      for (const [k, v] of cache.map) if (v.order < oldest) { oldest = v.order; oldestKey = k; }
      if (!(oldest < entry.order)) return;   // everything cached is as new or newer: this entry does not displace it
      uncache(cache, oldestKey);
    }
    cache.map.set(key, entry);
    cache.bytes += entry.bytes;
  }
  function rememberClosed(n, seg) {
    cacheNewest(closedRows, n, { order: n, rows: seg.rows, bad: seg.bad, bytes: seg.bytes });
    lastClosed = seg.bytes <= closedRows.budget ? { n, rows: seg.rows, bad: seg.bad, bytes: seg.bytes } : null;
  }
  function forgetIndex(n) { uncache(closedIndexes, n); verifiedIndex.delete(n); }
  function rememberIndex(n, index, bytes) { forgetIndex(n); cacheNewest(closedIndexes, n, { order: n, index, bytes }); }
  function forgetCaches() {
    activeRows = null; tail = null; lastClosed = null;
    for (const cache of [closedRows, closedIndexes, streamSlices]) { cache.map.clear(); cache.bytes = 0; }
    verifiedIndex.clear();
  }
  // The parsed rows of segment n, as { seg, fresh } (fresh: read from disk by this call). The append-active segment
  // answers from its parse while the file still has exactly the bytes that parse covers (one stat, no read); a closed
  // segment is immutable, so its parse is reused from the cache. A strict read always re-reads disk, active included.
  function segmentRows(n, strict) {
    if (manifest && n === manifest.activeSegment) {
      const size = fs.statSync(segFile(n)).size;
      if (!strict && activeRows && activeRows.n === n && activeRows.size === size) return { seg: activeRows, fresh: false };
      const seg = readSegmentFile(n);
      activeRows = { n, size: seg.bytes, rows: seg.rows, bad: seg.bad };
      return { seg: activeRows, fresh: true };
    }
    const hit = strict ? null : (closedRows.map.get(n) || (lastClosed && lastClosed.n === n ? lastClosed : null));
    if (hit) return { seg: hit, fresh: false };
    const seg = readSegmentFile(n);
    rememberClosed(n, seg);
    return { seg, fresh: true };
  }
  // strict: true fails the read on ANY unreadable line; a function fails it only on a bad line the caller
  // claims (strict(line) === true). An unreadable file always fails a strict read.
  // The returned array is the cached parse itself: callers read it, never mutate it, and copy rows they hand out.
  function readRows(n, strict) {
    let got;
    try { got = segmentRows(n, !!strict); }
    catch (e) { if (strict) throw e; warning('segment ' + n + ' unreadable: ' + ((e && e.message) || e)); return UNREADABLE; }
    const seg = got.seg, bad = seg.bad.length;
    if (bad) {
      const claimed = typeof strict === 'function' ? seg.bad.filter(line => strict(line)).length : 0;
      if (strict === true || claimed) throw new Error('segment ' + n + ' contains unreadable transcript evidence');
      if (got.fresh) warning('segment ' + n + ' isolated ' + bad + ' corrupt line(s)');
    }
    return seg.rows;
  }
  // The rows of ONE stream in segment n, in file order. A closed segment is immutable, so its slice is exact for as long
  // as the process runs; it is kept only from a parse that succeeded (an unreadable segment is tried again next read,
  // as before). The append-active segment and a strict read always come from readRows.
  function rowBytes(row) { return str(row.content).length + str(row.toolCalls).length + str(row.dispatchPrompt).length + 256; }
  function streamRowsIn(n, sid, strict) {
    const closed = n !== manifest.activeSegment, key = n + '\u0000' + sid;
    const hit = closed && !strict ? streamSlices.map.get(key) : null;
    if (hit) return hit.rows;
    const all = readRows(n, strict);
    const rows = [];
    let bytes = 0;
    for (const row of all) if (row.streamId === sid) { rows.push(row); bytes += rowBytes(row); }
    if (closed && all !== UNREADABLE && bytes <= streamSlices.budget / 8) cacheNewest(streamSlices, key, { order: n, rows, bytes });
    return rows;
  }
  function buildIndex(n) {
    const index = emptyIndex(n);
    let bytes = 0;
    try { bytes = fs.statSync(segFile(n)).size; } catch (_) { return index; }
    index.bytes = bytes;
    let seg;
    try { seg = readSegmentFile(n); }
    catch (e) {
      warning('segment ' + n + ' unreadable: ' + ((e && e.message) || e));
      // still the empty index it always was, but marked: its maxRowId 0 proves nothing (provenFloor)
      index.unreadable = true;
      scans.set(n, { size: bytes, unreadable: true });
      staleIndexes.add(n);
      return index;
    }
    noteScan(n, seg);
    if (seg.bad.length) warning('segment ' + n + ' isolated ' + seg.bad.length + ' corrupt line(s)');
    for (const row of seg.rows) noteIndex(index, row);
    index.corruptLines = Math.max(0, seg.nonempty - seg.rows.length);
    // this parse is exact for these bytes: the next read of the segment is free (only once the manifest says which
    // segment is append-active, so a closed parse is never cached for a segment that will still grow)
    if (manifest) {
      if (n === manifest.activeSegment) activeRows = { n, size: seg.bytes, rows: seg.rows, bad: seg.bad };
      else rememberClosed(n, seg);
    }
    return index;
  }
  function saveIndex(index) {
    forgetIndex(index.segment);
    durableWrite({ fs, path }, idxFile(index.segment), JSON.stringify(index));
  }
  // A closed index is immutable once its checksum matched: the newest ones that fit stay parsed, and one that does not
  // fit is re-read but never re-hashed while its file keeps the size and mtime that matched.
  function loadIndex(n, persistRepair) {
    if (activeIndex && n === manifest.activeSegment) return activeIndex;
    const cached = closedIndexes.map.get(n);
    if (cached) return cached.index;
    let index = null, text = null, sig = '';
    try { const st = fs.statSync(idxFile(n)); sig = st.size + ':' + num(st.mtimeMs); text = fs.readFileSync(idxFile(n), 'utf8'); index = JSON.parse(text); }
    catch (_) { index = null; }
    const meta = manifest.segments.find(s => s.number === n);
    const proof = sig + ':' + str(meta && meta.indexHash);
    const hashMismatch = !!(index && meta && meta.indexHash && verifiedIndex.get(n) !== proof && indexHash(index) !== meta.indexHash);
    if (!index || index.version !== VERSION || index.segment !== n || hashMismatch) {
      if (hashMismatch) warning('segment ' + n + ' index checksum mismatch; rebuilding from immutable JSONL');
      index = buildIndex(n);
      if (persistRepair) { try { saveIndex(index); } catch (e) { warning('index repair failed for segment ' + n + ': ' + ((e && e.message) || e)); } }
      upsertMeta(index);
      if (persistRepair) { try { saveManifest(); } catch (e) { warning('manifest repair failed for segment ' + n + ': ' + ((e && e.message) || e)); } }
      return index;
    }
    // a JSON-loaded index keeps Object.prototype: search, its one reader, looks terms up with hasOwn, never by bare key
    if (n !== manifest.activeSegment) rememberIndex(n, index, text.length);
    if (meta && meta.indexHash) verifiedIndex.set(n, proof);
    return index;
  }
  function metaFromIndex(index, hash) {
    return {
      number: index.segment, file: segmentName(index.segment), rows: index.rows, bytes: index.bytes,
      minRowId: index.minRowId, maxRowId: index.maxRowId, minTs: index.minTs, maxTs: index.maxTs,
      corruptLines: index.corruptLines || 0, streams: index.streams, indexHash: hash === undefined ? indexHash(index) : hash,
      ...(index.retracts && index.retracts.v === 1 ? { retracts: index.retracts, retractsHash: hash === undefined ? indexHash(index.retracts) : '' } : {}),
      ...(index.unreadable ? { unreadable: true } : {})
    };
  }
  // lazy: a per-row refresh of the active segment's summary; its checksum waits for the next saveManifest()
  function upsertMeta(index, lazy) {
    const at = manifest.segments.findIndex(s => s.number === index.segment);
    let hash;
    if (lazy) { hash = at >= 0 ? manifest.segments[at].indexHash : ''; activeHashStale = true; }
    else if (index === activeIndex) activeHashStale = false;
    const meta = metaFromIndex(index, hash);
    if (at >= 0) manifest.segments[at] = meta; else manifest.segments.push(meta);
    manifest.segments.sort((a, b) => a.number - b.number);
  }
  function rebuildManifest(old) {
    const next = freshManifest();
    const listed = listSegments();
    const numbers = listed.numbers || [];
    const built = [];
    for (const n of numbers) {
      const index = buildIndex(n);
      built.push(index);
      next.segments.push(metaFromIndex(index));
      next.nextRowId = Math.max(next.nextRowId, index.maxRowId + 1);
    }
    next.activeSegment = numbers.length ? numbers[numbers.length - 1] : 1;
    if (old && Array.isArray(old.legacy)) next.legacy = old.legacy;
    // the floor reads the index files as they stand, so the rebuilt ones are written after it
    const parsed = old && typeof old === 'object' ? old : null;
    const pf = provenFloor({ listed, metas: null, manifestNext: parsed ? num(parsed.nextRowId) : 0, activeHint: 0, blocked: blockedOf(parsed) });
    for (const index of built) {
      try { saveIndex(index); } catch (e) { warning('index rebuild write failed for segment ' + index.segment + ': ' + ((e && e.message) || e)); }
    }
    next.nextRowId = Math.max(next.nextRowId, pf.floor);
    if (parsed && Array.isArray(parsed.unprovenSegments)) next.unprovenSegments = parsed.unprovenSegments;
    settleProof(next, pf);
    return next;
  }
  function reconcileManifest(loaded) {
    const persisted = new Map((loaded.segments || []).map(s => [s.number, s]));   // as persisted: (ii)'s evidence
    const persistedNext = num(loaded.nextRowId);
    const persistedActive = num(loaded.activeSegment) || 1;
    const listed = listSegments();
    const numbers = listed.numbers || [];
    const known = new Map(persisted);
    // A roll persists the NEXT active number before its first row. If the process dies in that tiny gap,
    // there is deliberately no file yet; retain the manifest's higher pointer instead of reopening the
    // last closed segment and violating immutability.
    const active = Math.max(persistedActive, numbers.length ? numbers[numbers.length - 1] : 1);
    // Closed segment metadata stays lazy: its durable index is loaded only if a query needs it. Rebuilt: every segment
    // at or above the persisted active pointer (the append-active tail, and the stranded tail of an earlier boot that
    // appended after its last manifest save and then moved on to a newer segment), any segment absent from the
    // manifest, and any closed one no longer the size its meta records (trunk's degraded boots appended into closed
    // segments). The healthy cost is one stat per closed segment.
    resized = [];
    const sizes = new Map();
    for (const n of numbers) {
      let rebuild = n >= persistedActive || !known.has(n);
      if (!rebuild) {
        let size = -1;
        try { size = fs.statSync(segFile(n)).size; }
        catch (e) { warning('segment ' + n + ' could not be measured: ' + ((e && e.message) || e)); }
        if (size >= 0) sizes.set(n, size);
        if (size >= 0 && size !== num(known.get(n).bytes)) { rebuild = true; resized.push(n); }
      }
      if (!rebuild) continue;
      const index = buildIndex(n);
      known.set(n, metaFromIndex(index));
    }
    loaded.segments = Array.from(known.values()).sort((a, b) => a.number - b.number);
    loaded.activeSegment = active;
    loaded.nextRowId = 1;
    for (const meta of loaded.segments) loaded.nextRowId = Math.max(loaded.nextRowId, num(meta.maxRowId) + 1);
    const pf = provenFloor({ listed, sizes, metas: persisted, manifestNext: persistedNext, activeHint: persistedActive, blocked: blockedOf(loaded) });
    loaded.nextRowId = Math.max(loaded.nextRowId, pf.floor);
    settleProof(loaded, pf);
    return loaded;
  }
  // the segment numbers on disk, ascending ({ numbers: null, error } when the root cannot be listed: unsafe mode)
  function listSegments() {
    let names;
    try { names = fs.readdirSync(root); }
    catch (e) { return { numbers: null, error: str((e && e.message) || e) || 'unlisted' }; }
    return { numbers: names.map(parseSegmentNumber).filter(Boolean).sort((a, b) => a - b), error: '' };
  }
  function readLease() {
    const v = readJson(leaseFile);
    return v && v.v === 1 && Number.isSafeInteger(v.next) && v.next > 0 ? v.next : 0;
  }
  function writeLease(next) {
    durableWrite({ fs, path }, leaseFile, JSON.stringify({ v: 1, next }));
    lease = next;
  }
  function metaMapOf(m) {
    return m && typeof m === 'object' && Array.isArray(m.segments) ? new Map(m.segments.filter(s => s && typeof s === 'object').map(s => [s.number, s])) : null;
  }
  // segments a boot found unproven: the meta and index that boot rebuilt for them are no proof (ii) of anything
  function blockedOf(m) {
    const list = m && typeof m === 'object' && Array.isArray(m.unprovenSegments) ? m.unprovenSegments : [];
    return new Set(list.map(Number).filter(n => Number.isSafeInteger(n) && n > 0));
  }
  /* THE PROVEN FLOOR (turn-identity, A2-ID-01 + A2-ID-01-R): the lowest rowId no acknowledged row can hold, from the
     disk alone (never a clock, never a size). One function serves rebuildManifest, reconcileManifest, the degraded
     init and the unsafe-mode re-probe. A non-empty segment's max is PROVEN by
       (i)  the max rowId over its parsable lines, or
       (ii) for a CLOSED segment only, a persisted manifest meta or index file whose `bytes` equals the file's current
            size and whose rows > 0 (the append-active segment, the highest file or the manifest's pointer when
            higher, is proven only by (i): its index is written only at a roll or a rebuild).
     Without a lease (rowid-lease.json absent or unparsable), (i) proves only a segment with no newline-terminated
     damaged line, whatever its id order: appendRaw acknowledges a row only after reading back its newline-terminated
     bytes, so every acknowledged id still on disk is parsed. A damaged line's id is unknown, and neither a parsable
     row after it nor the order of the survivors bounds it. One unterminated final fragment is allowed: a crashed
     append's tail was never acknowledged. A complete line cut away after acknowledgement leaves nothing to detect;
     without the lease the floor then rests on the parse and the persisted manifest (the named residual, Q37).
     floor = 1 + max(every proven max, the persisted nextRowId - 1, lease.next - 1). Any non-empty segment unproven,
     or the root unlisted: ok false, and the caller enters unsafe mode. */
  function provenFloor(ctx) {
    const c = ctx || {};
    const listed = c.listed || listSegments();
    lease = readLease();
    const base = Math.max(0, num(c.manifestNext) - 1, lease - 1);
    if (!listed.numbers) return { ok: false, unlisted: listed.error || 'unlisted', numbers: [], maxListed: 0, floor: base + 1, unproven: [] };
    const numbers = listed.numbers;
    const maxListed = numbers.length ? numbers[numbers.length - 1] : 0;
    const activeN = Math.max(maxListed, num(c.activeHint));
    let top = base;
    const unproven = [];
    for (const n of numbers) {
      const p = proveSegment(n, n === activeN, c);
      if (p.empty) continue;
      if (p.proven) top = Math.max(top, p.max); else unproven.push({ n, why: p.why });
    }
    return { ok: !unproven.length, unlisted: '', numbers, maxListed, floor: top + 1, unproven };
  }
  function proveSegment(n, active, c) {
    let size = c.sizes && c.sizes.has(n) ? c.sizes.get(n) : -1;
    if (size < 0) {
      try { size = fs.statSync(segFile(n)).size; }
      catch (e) { return { proven: false, why: 'could not be measured: ' + ((e && e.message) || e) }; }
    }
    if (!size) return { empty: true };
    let scan = scans.get(n);
    const proves = s => !s.unreadable && (lease > 0 || !s.damaged);
    if (scan && !scan.unreadable && scan.size === size && proves(scan)) return { proven: true, max: scan.max };
    if (!active && !(c.blocked && c.blocked.has(n))) {
      const meta = c.metas && c.metas.get(n);
      if (meta && num(meta.bytes) === size && num(meta.rows) > 0) return { proven: true, max: num(meta.maxRowId) };
      const index = readJson(idxFile(n));
      if (index && index.segment === n && num(index.bytes) === size && num(index.rows) > 0) return { proven: true, max: num(index.maxRowId) };
    }
    if (!scan || scan.unreadable || scan.size !== size) {
      try { scan = noteScan(n, readSegmentFile(n)); }
      catch (e) { scans.set(n, { size, unreadable: true }); return { proven: false, why: 'unreadable: ' + ((e && e.message) || e) }; }
    }
    if (proves(scan)) return { proven: true, max: scan.max };
    return { proven: false, why: scan.damaged + ' damaged line(s) and no rowid lease' };
  }
  function describeUnproven(pf) {
    if (pf.unlisted) return 'the transcript root could not be listed (' + pf.unlisted + ')';
    return pf.unproven.map(u => segmentName(u.n) + ' ' + u.why).join('; ');
  }
  // a boot's verdict: unsafe mode when any segment is unproven. The unproven segments are recorded in the manifest,
  // because the meta (and, on a rebuild, the index) this boot writes for them was built from the very bytes that
  // could not prove them, and must never stand as a later boot's proof (ii).
  function settleProof(m, pf) {
    if (pf.ok) { delete m.unprovenSegments; return; }
    const blocked = blockedOf(m);
    for (const u of pf.unproven) blocked.add(u.n);
    if (blocked.size) m.unprovenSegments = Array.from(blocked).sort((a, b) => a - b);
    enterUnsafe(pf);
  }
  function enterUnsafe(pf) {
    unsafe = true;
    unsafeWhy = describeUnproven(pf);
    probedAt = num(now());
    warning('rowIds unproven: ' + unsafeWhy + '. Appends are refused (TRANSCRIPT_DEGRADED_UNSAFE) so no id is reissued; '
      + 'the proof is re-run on an append at most every ' + (REPROBE_MS / 1000) + ' s');
  }
  function unsafeError() {
    const e = new Error('transcript appends refused: rowIds unproven (' + unsafeWhy + ')');
    e.code = 'TRANSCRIPT_DEGRADED_UNSAFE';
    return e;
  }
  /* UNSAFE MODE'S WAY OUT: at most once per REPROBE_MS (the injected clock), an append re-runs provenFloor(). On success
     the io re-indexes what it could not read, opens a NEW segment above every listed one with nextRowId at or above the
     floor, leaves unsafe mode, and the append proceeds; otherwise the append is refused as before. */
  function reprobe() {
    const t = num(now());
    if (t < probedAt) probedAt = t;   // a clock that stepped back waits from its new reading
    if (t - probedAt < REPROBE_MS) return false;
    probedAt = t;
    const persisted = readJson(manifestFile);
    const blocked = blockedOf(persisted);
    for (const n of blockedOf(manifest)) blocked.add(n);
    const pf = provenFloor({ metas: metaMapOf(persisted), manifestNext: Math.max(manifest.nextRowId, persisted ? num(persisted.nextRowId) : 0), activeHint: manifest.activeSegment, blocked });
    if (!pf.ok) {
      unsafeWhy = describeUnproven(pf);
      warning('rowIds still unproven: ' + unsafeWhy + '. Appends stay refused');
      return false;
    }
    if (!degraded) {
      const listed = new Set(pf.numbers);
      for (const n of new Set([manifest.activeSegment].concat(Array.from(staleIndexes)))) {
        if (!listed.has(n)) continue;
        staleIndexes.delete(n);
        upsertMeta(buildIndex(n));
      }
    }
    closeAppend();
    activeRows = null; tail = null;
    manifest.activeSegment = Math.max(pf.maxListed + 1, manifest.activeSegment);   // above every listed file: a new one
    manifest.nextRowId = Math.max(manifest.nextRowId, pf.floor);
    activeIndex = emptyIndex(manifest.activeSegment);
    delete manifest.unprovenSegments;
    unsafe = false; unsafeWhy = '';
    warning('rowIds proven: appends resume in ' + segmentName(manifest.activeSegment) + ' (a new segment) from rowId ' + manifest.nextRowId);
    return true;
  }
  /* THE BOOT AUDIT: ids already duplicated on disk by earlier boots (trunk's degraded init reissued ids from 1, into
     closed segment-000001). Three kinds: overlapping [minRowId, maxRowId] ranges of two segments; ids met while
     (re)building one segment's index that are not above every id before them (a === b); and a closed segment whose
     size differs from its persisted meta. Kept in status().idCollisions (at most 50), with one warning. A
     duplicated id loses only its key rung downstream; the segment itself still proves its max. */
  function audit() {
    const found = [];
    const ranged = manifest.segments.filter(s => num(s.rows) > 0 && num(s.minRowId) > 0)
      .sort((a, b) => (num(a.minRowId) - num(b.minRowId)) || (a.number - b.number));
    let reach = null;   // the segment reaching the highest id so far
    for (const s of ranged) {
      if (reach && num(s.minRowId) <= num(reach.maxRowId)) {
        found.push({ kind: 'overlap', a: Math.min(reach.number, s.number), b: Math.max(reach.number, s.number),
          lo: num(s.minRowId), hi: Math.min(num(s.maxRowId), num(reach.maxRowId)) });
      }
      if (!reach || num(s.maxRowId) > num(reach.maxRowId)) reach = s;
    }
    for (const [n, scan] of scans) if (scan.dupLo) found.push({ kind: 'duplicate', a: n, b: n, lo: scan.dupLo, hi: scan.dupHi });
    for (const n of resized) {
      const meta = manifest.segments.find(s => s.number === n) || {};
      found.push({ kind: 'size', a: n, b: n, lo: num(meta.minRowId), hi: num(meta.maxRowId) });
    }
    found.sort((x, y) => (x.a - y.a) || (x.b - y.b));
    collisionRanges = found;
    idCollisions = found.slice(0, AUDIT_MAX);
    if (found.length) {
      warning('rowId audit: ' + found.length + ' id collision(s) already on disk (earlier boots reissued ids): '
        + idCollisions.slice(0, 5).map(c => c.kind + ' ' + segmentName(c.a) + (c.b !== c.a ? '/' + segmentName(c.b) : '') + ' ids ' + c.lo + '-' + c.hi).join(', ')
        + (found.length > 5 ? ', …' : ''));
    }
  }
  /* PREVIEW UPGRADE (one time). Closed segments indexed before previews carried provenance (previewVersion) have
     summaries streams() must not trust, so those conversations listed with no preview. Closed JSONL is immutable,
     so each such segment's previews are rebuilt from its own rows, ONE segment per deferred step (a big history
     never stalls boot), and persisted; an upgraded store schedules nothing on the next boot. */
  const schedule = typeof o.schedule === 'function' ? o.schedule
    : (fn, ms) => { const t = setTimeout(fn, ms); if (t && typeof t.unref === 'function') t.unref(); };
  function stalePreview(meta) {
    const s = meta && meta.streams;
    return !!(s && typeof s === 'object' && Object.keys(s).some(sid => s[sid] && s[sid].previewVersion !== 1));
  }
  function upgradedIndex(n) {
    // a predicate that claims nothing: torn lines stay isolated, but an unreadable file throws and waits for a later boot
    const rows = readRows(n, () => false);
    const index = readJson(idxFile(n));
    const meta = manifest.segments.find(s => s.number === n);
    if (!index || index.version !== VERSION || index.segment !== n || !index.streams || typeof index.streams !== 'object'
        || (meta && meta.indexHash && indexHash(index) !== meta.indexHash)) return buildIndex(n);
    const streams = Object.create(null);
    for (const sid of Object.keys(index.streams)) {
      const old = index.streams[sid] || {};
      streams[sid] = { count: num(old.count), lastAt: num(old.lastAt), preview: '', previewVersion: 1 };
    }
    for (const row of rows) { const s = streams[str(row.streamId) || 'global']; if (s) notePreview(s, row); }
    index.streams = streams;
    return index;
  }
  function upgradeStalePreviews() {
    const pending = manifest.segments.filter(m => m.number !== manifest.activeSegment && stalePreview(m)).map(m => m.number);
    const step = () => {
      const n = pending.shift();
      if (n == null) return;
      try {
        const meta = manifest.segments.find(s => s.number === n);
        if (meta && n !== manifest.activeSegment && stalePreview(meta)) {
          const index = upgradedIndex(n);
          saveIndex(index);
          upsertMeta(index);
          saveManifest();
        }
      } catch (e) { warning('preview upgrade for segment ' + n + ' deferred to a later boot: ' + ((e && e.message) || e)); }
      if (pending.length) schedule(step, 200);
    };
    if (pending.length) schedule(step, 5000);
  }
  function legacyKey(file, lineNo) { return path.basename(file) + ':' + lineNo; }
  function importedLegacyKeys() {
    const keys = new Set();
    for (const meta of manifest.segments) for (const row of readRows(meta.number)) if (row.legacyKey) keys.add(row.legacyKey);
    return keys;
  }
  function closeAppend() {
    if (!appendFd) return;
    const fd = appendFd.fd;
    appendFd = null;
    try { fs.closeSync(fd); } catch (closeError) { failNote('transcript.append.write-close', closeError); }
  }
  // the open append handle on segment n. 'a+': every write lands at the end of the file, and positional reads through
  // the same handle prove what landed — so a row costs no open (no Defender rescan) after the segment's first.
  function appendHandle(n) {
    if (appendFd && appendFd.n === n) return appendFd.fd;
    closeAppend();
    const fd = fs.openSync(segFile(n), 'a+');
    appendFd = { n, fd };
    return fd;
  }
  /* THE HANDLE MUST STILL BE THE FILE AT THE PATH. A handle outlives its directory entry: if the segment was deleted,
     quarantined or replaced, or the whole transcript folder was removed, while the sidecar ran, every write, fsync and
     read-back through the handle succeeds on an unlinked file and the row is lost at restart, after a run journal was
     retired on its proof. So every row compares the handle with an attribute-only stat of the path (no content open,
     no rescan; bigint, because an NTFS file id does not fit a double). */
  function handleIsPath(fd, file) {
    const held = fs.fstatSync(fd, { bigint: true });
    let here;
    try { here = fs.statSync(file, { bigint: true }); } catch (_) { return false; }   // gone: the caller reopens by path
    return held.nlink > 0n && here.ino === held.ino && here.dev === held.dev;
  }
  function appendRaw(entry, options) {
    const settings = options || {};
    // UNSAFE MODE: no proven floor, so refuse before an id is consumed or a byte is written (a strict writer fails
    // through its onFailure and the run journal stays the record; a fail-open row stays RAM-only)
    if (unsafe && !reprobe()) throw unsafeError();
    if (!activeIndex) activeIndex = loadIndex(manifest.activeSegment, false);
    let row = Object.assign({}, entry);
    const supplied = num(row.rowId) > 0;   // only migrateLegacy supplies one; it never lowers the counter
    // THE LEASE (A2-ID-01-R): no id at or above the persisted lease is minted or accepted until the lease is renewed
    // above it, durably, first. A failed renewal throws here: no id consumed, no byte written.
    const id = supplied ? num(row.rowId) : manifest.nextRowId;
    if (id >= lease) writeLease(Math.floor(id) + 1 + ROWID_LEASE);
    if (!supplied) row.rowId = manifest.nextRowId++;
    else manifest.nextRowId = Math.max(manifest.nextRowId, num(row.rowId) + 1);
    const encoded = Buffer.from(JSON.stringify(row) + '\n', 'utf8');
    if (activeIndex.rows > 0 && activeIndex.bytes + encoded.length > segmentBytes) {
      saveIndex(activeIndex);
      upsertMeta(activeIndex);
      closeAppend();                 // the closed segment is never written again
      activeRows = null; tail = null;
      manifest.activeSegment++;
      activeIndex = emptyIndex(manifest.activeSegment);
      saveManifest();
    }
    const n = manifest.activeSegment;
    const file = segFile(n);
    let fd = appendHandle(n);
    /* TORN TAIL (H2). A crash mid-append can leave the segment ending in a partial row with no newline. Appending
       straight after it glued the new row onto that fragment: one unparsable line, so readRows() dropped the NEW
       row too — after the read-back below had already "proven" it by parsing only its own byte range, and a run
       journal had been retired on that proof. A lone '\n' first isolates the fragment on its own line (readRows
       skips and counts it as corrupt), and the read-back now proves the row is a complete LINE of the file.
       The size comes from the open handle on every row; the remembered last byte is trusted only while the file is
       exactly the size our own last proven append left it at (anything else re-reads the byte). */
    let offset = 0, sep = 0;
    try {
      if (!handleIsPath(fd, file)) {
        // Something outside this process changed the folder (or the path cannot be checked): nothing remembered about it
        // still holds. Reopen by path, as every row once did (a missing folder throws ENOENT and the row is not
        // acknowledged; a missing file is created), read from disk again, and stop vouching for the durable counts the
        // RAM mirror trusts (the rows the old file held may be gone).
        warning('segment ' + n + ': the open handle is no longer provably the file at its path; reopening it by path');
        closeAppend();
        forgetCaches();
        unvouched = true;
        fd = appendHandle(n);
      }
      offset = fs.fstatSync(fd).size;
      if (offset > 0) {
        let last = tail && tail.n === n && tail.size === offset ? tail.last : -1;
        if (last < 0) {
          const one = Buffer.alloc(1);
          if (fs.readSync(fd, one, 0, 1, offset - 1) !== 1) throw new Error('transcript tail byte unreadable');
          last = one[0];
        }
        if (last !== 0x0a) sep = 1;
      }
    } catch (e) { closeAppend(); tail = null; throw e; }
    const bytes = sep ? Buffer.concat([Buffer.from('\n', 'utf8'), encoded]) : encoded;
    const rowStart = offset + sep;
    try {
      // writeSync may write fewer bytes than asked; any positive count used to be taken as the whole row.
      let at = 0;
      while (at < bytes.length) {
        const wrote = fs.writeSync(fd, bytes, at, bytes.length - at);
        if (!Number.isInteger(wrote) || wrote <= 0 || wrote > bytes.length - at) throw new Error('incomplete transcript append (' + at + '/' + bytes.length + ' bytes)');
        at += wrote;
      }
      fs.fsyncSync(fd);
      // Strict read-back: prove the bytes just fsync'd are a complete LINE of the file — preceded by a newline (or
      // the file start), newline-terminated — and parse as the row we assigned.
      const lead = rowStart > 0 ? 1 : 0;
      const check = Buffer.alloc(encoded.length + lead);
      const got = fs.readSync(fd, check, 0, check.length, rowStart - lead);
      if (got !== check.length) throw new Error('short transcript read-back');
      if (lead && check[0] !== 0x0a) throw new Error('transcript read-back: row does not start a line');
      if (check[check.length - 1] !== 0x0a) throw new Error('transcript read-back: row is not newline-terminated');
      const proven = JSON.parse(check.toString('utf8', lead, check.length - 1));
      if (num(proven.rowId) !== num(row.rowId)) throw new Error('transcript read-back rowId mismatch');
      row = proven;
    } catch (e) {
      // A rejected append (short/stalled write, failed fsync, failed proof) is rolled back to the prior boundary —
      // strict means all or nothing. Windows refuses truncation through an append handle, so close first. If the
      // rollback fails too, the bytes are left unterminated or unparsable and the NEXT append isolates them.
      closeAppend();
      tail = null;
      try { fs.truncateSync(file, offset); } catch (rollbackError) { failNote('transcript.append.rollback', rollbackError); }
      throw e;
    }
    tail = { n, size: rowStart + encoded.length, last: 0x0a };
    // the active parse stays exact: a torn fragment before this row (sep) was already one of its unreadable lines,
    // and a segment this append created starts as the empty parse
    if (offset === 0 && !(activeRows && activeRows.n === n)) activeRows = { n, size: 0, rows: [], bad: [] };
    if (activeRows && activeRows.n === n && activeRows.size === offset) { activeRows.rows.push(row); activeRows.size = tail.size; }
    else activeRows = null;

    activeIndex.bytes += bytes.length;
    noteIndex(activeIndex, row);
    upsertMeta(activeIndex, true);
    // The JSONL row is the source of truth. Persist the small manifest only at segment boundaries/migration;
    // init() always reconciles the active tail, so a crash after this proven append cannot lose or reuse its id.
    if (settings.saveManifest) saveManifest();
    return clone(row);   // the caller's copy: the cached parse keeps its own
  }
  function migrateLegacy() {
    const done = new Map((manifest.legacy || []).map(x => [x.file, x]));
    const pending = [];
    for (const file of legacyFiles) {
      try {
        const stat = fs.statSync(file);
        const prior = done.get(path.basename(file));
        if (!prior || prior.bytes !== stat.size || prior.mtimeMs !== num(stat.mtimeMs)) pending.push(file);
      } catch (_) {}
    }
    if (!pending.length) return;
    const existing = importedLegacyKeys();
    let changed = false;
    for (const file of pending) {
      let text, stat;
      try { text = fs.readFileSync(file, 'utf8'); stat = fs.statSync(file); } catch (_) { continue; }
      const fingerprint = { file: path.basename(file), bytes: stat.size, mtimeMs: num(stat.mtimeMs), imported: 0 };
      let lineNo = 0;
      for (const line of text.split(/\r?\n/)) {
        lineNo++;
        if (!line.trim()) continue;
        const key = legacyKey(file, lineNo);
        if (existing.has(key)) { fingerprint.imported++; continue; }
        let row;
        try { row = JSON.parse(line); } catch (_) { warning('legacy transcript isolated corrupt line ' + fingerprint.file + ':' + lineNo); continue; }
        if (!row || typeof row !== 'object') continue;
        row.legacyKey = key;
        appendRaw(row, { deferManifest: true });
        existing.add(key);
        fingerprint.imported++;
        changed = true;
      }
      done.set(fingerprint.file, fingerprint);
    }
    manifest.legacy = Array.from(done.values());
    if (changed || legacyFiles.length) saveManifest();
  }
  function init() {
    ensureRoot();
    const loaded = readJson(manifestFile);
    const valid = loaded && loaded.version === VERSION && Array.isArray(loaded.segments);
    // A valid manifest makes boot lazy: only the active tail is read. A missing/corrupt manifest is the
    // exceptional recovery path and rebuilds from every bounded segment without discarding any of them.
    manifest = valid ? reconcileManifest(loaded) : rebuildManifest(loaded);
    // Never trust a persisted index for the append-active tail: it may predate rows that were fsync'd just
    // before a crash. Rebuilding this one bounded segment prevents stale term hits, byte counts, or row ranges.
    activeIndex = buildIndex(manifest.activeSegment);
    const activeFileExists = fs.existsSync(segFile(manifest.activeSegment));
    if (activeFileExists) upsertMeta(activeIndex);
    else {
      // A new store and a crash immediately after persisting a roll pointer both legitimately have no active
      // JSONL yet. Do not advertise an empty segment until its first durable row creates the file: readers
      // would otherwise try to open the phantom path and report ordinary first boot as transcript corruption.
      const prior = manifest.segments.find(s => s.number === manifest.activeSegment);
      if (!prior || (!num(prior.rows) && !num(prior.bytes))) {
        manifest.segments = manifest.segments.filter(s => s.number !== manifest.activeSegment);
      }
    }
    // the import appends; while rowIds are unproven it waits for a later boot (it is idempotent: done files are skipped)
    if (!unsafe) migrateLegacy();
    else if (legacyFiles.length) warning('legacy transcript import deferred to a later boot: appends are refused while rowIds are unproven');
    saveManifest();
    audit();
  }
  function appendDurable(entry, options) {
    try { return appendRaw(entry, options); }
    catch (e) {
      warning('append failed: ' + ((e && e.message) || e));
      throw e;
    }
  }
  function relevantSegments(streamId, reverse) {
    const list = manifest.segments.filter(s => !streamId || hasOwn(s.streams, streamId));
    return reverse ? list.slice().reverse() : list;
  }
  function readRecent(options) {
    const perStream = Math.max(1, num(options && options.perStream) || recentPerStream);
    // A per-stream ceiling alone is not a process-memory ceiling: thousands of short
    // streams can each contribute a few rows. The store can query immutable segments
    // lazily, so callers may request only the newest global working set at boot.
    const globalLimit = Math.max(0, num(options && options.globalLimit));
    if (globalLimit > 0) {
      const counts = new Map(), out = [];
      for (const meta of manifest.segments.slice().reverse()) {
        const rows = readRows(meta.number);
        for (let i = rows.length - 1; i >= 0 && out.length < globalLimit; i--) {
          const row = rows[i], n = counts.get(row.streamId) || 0;
          if (n >= perStream) continue;
          counts.set(row.streamId, n + 1); out.push(row);
        }
        if (out.length >= globalLimit) break;
      }
      out.sort((a, b) => num(a.rowId) - num(b.rowId));
      return out.map(publicRow);
    }
    const wanted = new Set();
    const totals = new Map();
    for (const meta of manifest.segments) for (const sid of Object.keys(meta.streams || {})) wanted.add(sid);
    for (const meta of manifest.segments) for (const sid of Object.keys(meta.streams || {})) {
      totals.set(sid, (totals.get(sid) || 0) + num(meta.streams[sid].count));
    }
    const counts = new Map();
    const out = [];
    for (const meta of manifest.segments.slice().reverse()) {
      let needed = false;
      for (const sid of Object.keys(meta.streams || {})) if ((counts.get(sid) || 0) < perStream) { needed = true; break; }
      if (!needed) continue;
      const rows = readRows(meta.number);
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i], n = counts.get(row.streamId) || 0;
        if (n >= perStream) continue;
        counts.set(row.streamId, n + 1); out.push(row);
      }
      let complete = true;
      for (const sid of wanted) if ((counts.get(sid) || 0) < Math.min(perStream, totals.get(sid) || 0)) { complete = false; break; }
      if (complete) break;
    }
    out.sort((a, b) => num(a.rowId) - num(b.rowId));
    return out.map(publicRow);
  }
  // A run's rows cannot predate it: an optional `since` (ms) skips segments that ended well before it, so a
  // finalize lookup never re-reads a long stream's whole lifetime ('global'). The slack absorbs a small clock
  // step between the run's start and its rows.
  const SINCE_SLACK_MS = 60 * 60 * 1000;
  /* A VOUCHED READ (options.vouch = { claim }; turn-identity, findTurn's absence proof): the rows returned are every row
     of the stream in the segments read, or the read throws. It throws TRANSCRIPT_UNVOUCHED before reading when this
     view cannot vouch for the disk (degraded, unvouched: the states in which streamRows answers -1; or unsafe). An
     unreadable segment throws; a damaged line throws only when it names the claim. A closed segment's cached parse
     (which keeps its damaged lines) stands in for a re-read, since closed segments are immutable; the per-stream
     slice cache keeps no damaged lines and is never used. */
  function vouchedRowsIn(n, sid, claim) {
    const seg = segmentRows(n, false).seg;   // throws on an unreadable file
    for (const line of seg.bad) if (claim(line)) throw new Error('segment ' + n + ' contains unreadable transcript evidence naming the claim');
    return seg.rows.filter(row => row.streamId === sid);
  }
  function history(streamId, options) {
    const vouch = options && options.vouch && typeof options.vouch === 'object' ? options.vouch : null;
    if (vouch && (degraded || unvouched || unsafe)) {
      const e = new Error('transcript history cannot be vouched for: ' + (degraded ? 'initialization degraded' : unvouched ? 'the active segment changed outside this process' : 'rowIds unproven'));
      e.code = 'TRANSCRIPT_UNVOUCHED';
      throw e;
    }
    const limit = Math.max(1, num(options && options.limit) || 400);
    const runId = String((options && options.sourceRunId) || '');
    const since = num(options && options.since);
    // A strict lookup for ONE run fails closed only on a damaged line that names that run. A torn fragment of
    // some other row (a killed append) never names it, so it was never an accepted row of this run.
    const strict = options && options.strict ? (runId ? line => line.includes(JSON.stringify(runId)) : true) : false;
    const claims = vouch && Array.isArray(vouch.claims) ? vouch.claims : vouch ? [vouch.claim] : null;
    if (claims && (!claims.length || claims.length > 8 || claims.some(value => typeof value !== 'string' || !value))) throw new Error('invalid transcript coverage claims');
    const claim = claims ? (quoted => line => quoted.some(value => line.includes(value)))(claims.map(value => JSON.stringify(value))) : null;
    const out = [], previewBudget = options && options.previewBudget;
    let previewSegments = 0, proofSegments = 0;
    for (const meta of relevantSegments(streamId, true)) {
      if (since > 0 && num(meta.maxTs) > 0 && num(meta.maxTs) < since - SINCE_SLACK_MS) continue;
      if (Number.isSafeInteger(options && options.maxSegments) && ++proofSegments > options.maxSegments) {
        const error = new Error('transcript history exceeds its segment proof budget');
        error.code = 'TRANSCRIPT_UNVOUCHED'; throw error;
      }
      if (previewBudget) {
        if (!Number.isSafeInteger(previewBudget.remaining) || previewBudget.remaining <= 0 || previewSegments >= PREVIEW_SEGMENTS_PER_STREAM) break;
        previewBudget.remaining--; previewSegments++;
      }
      const rows = claim ? vouchedRowsIn(meta.number, streamId, claim) : streamRowsIn(meta.number, streamId, strict);
      for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) if ((!runId || rows[i].sourceRunId === runId) && (!(options && options.dispatchState) || rows[i].dispatchState === options.dispatchState)) out.push(rows[i]);
      if (out.length >= limit) break;
    }
    return out.reverse().map(publicRow);
  }
  /* A CURSOR READ (save-history-by-reference). history() answers "the newest N rows of a stream"; this answers "what came
     after the row I already hold": the rows of ONE stream with a rowId past `afterRowId`, OLDEST first, at most `limit`
     of them, so a stream of any length reads forward in pages. A segment whose newest row is not past the cursor is
     never read. { rows, more, truncated }: more = the stream holds rows past the last one returned; truncated = the read
     stopped at `maxSegments` segment visits (default 8) before the page was full, so `rows` is a short page and never a
     gap: the next call continues from its last row. A view this io cannot vouch for, or a segment it must read and
     cannot parse, throws TRANSCRIPT_UNVOUCHED instead of answering short. */
  function pageAfter(streamId, afterRowId, options) {
    const refuse = why => Object.assign(new Error('transcript cursor read cannot be vouched for: ' + why), { code: 'TRANSCRIPT_UNVOUCHED' });
    if (degraded || unvouched || unsafe) throw refuse(degraded ? 'initialization degraded' : unvouched ? 'the active segment changed outside this process' : 'rowIds unproven');
    const after = Math.max(0, Math.floor(num(afterRowId)));
    const limit = Math.max(1, Math.floor(num(options && options.limit)) || 400);
    const budget = Number.isSafeInteger(options && options.maxSegments) && options.maxSegments > 0 ? options.maxSegments : 8;
    const out = [];
    let visited = 0, more = false, truncated = false;
    for (const meta of relevantSegments(streamId, false)) {
      // wholly at or before the cursor: never read (the append-active segment's summary is refreshed lazily, so it is always read)
      if (meta.number !== manifest.activeSegment && !meta.unreadable && num(meta.maxRowId) > 0 && num(meta.maxRowId) <= after) continue;
      if (out.length >= limit) { more = true; break; }   // a full page, and the stream has a later segment
      if (visited >= budget) { more = truncated = true; break; }
      visited++;
      const rows = readRows(meta.number);
      if (rows === UNREADABLE) throw refuse('segment ' + meta.number + ' is unreadable');
      for (const row of rows) {
        if (row.streamId !== streamId || !(num(row.rowId) > after)) continue;
        // a full page ends before the next row, but a row that shares the last row's id (a collision) stays with it
        if (out.length >= limit && num(row.rowId) !== num(out[out.length - 1].rowId)) { more = true; break; }
        out.push(row);
      }
      if (more) break;
    }
    return { rows: out.map(publicRow), more, truncated };
  }
  /* A row's score is (query terms it holds) * 1000 + (their occurrences), ranked score, then ts, then rowId, newest
     first. Its rows per segment: a stream-scoped search reads that stream's own rows of a closed segment from RAM when
     history already holds them (streamRowsIn's slice: every row of the stream that holds a query term is among them,
     so no index is needed); otherwise the segment's term index names the rows holding any query term, and only a
     segment it names is read. Rows are counted with countTerms (the same counts wordTokens gives), and a row enters
     the top `limit` in the place a stable sort of every scored row would give it. */
  function search(streamId, query, options) {
    const settings = options || {};
    const limit = Math.max(1, Math.min(50, num(settings.limit) || 10));
    const terms = tokenize(query);
    if (!terms.length) return [];
    const all = settings.scope === 'all';
    // exclude(row) -> true: a row the caller may not return (a deleted session's, qa/bugs/3e926b6a). Skipped before it
    // is ranked, so it never takes one of the `limit` slots from a row that may be returned.
    const exclude = typeof settings.exclude === 'function' ? settings.exclude : null;
    const best = [];
    const counts = new Array(terms.length);
    const ranksAfter = (score, ts, rowId, b) => (b.score - score) || (num(b.ts) - ts) || (num(b.rowId) - rowId);   // > 0: b ranks first
    for (const meta of manifest.segments) {
      if (!all && !hasOwn(meta.streams, streamId)) continue;
      const n = meta.number;
      const slice = !all && n !== manifest.activeSegment ? streamSlices.map.get(n + '\u0000' + streamId) : null;
      let rows = slice ? slice.rows : null, candidates = null;
      if (!rows) {
        const index = loadIndex(n, n !== manifest.activeSegment);
        candidates = new Set();
        for (const term of terms) {
          const ids = hasOwn(index.terms, term) ? index.terms[term] : null;
          if (Array.isArray(ids)) for (const id of ids) candidates.add(num(id));
        }
        if (!candidates.size) continue;
        rows = all ? readRows(n) : streamRowsIn(n, streamId, false);
      }
      for (const row of rows) {
        if ((candidates && !candidates.has(num(row.rowId))) || (!all && row.streamId !== streamId)) continue;
        if (exclude && exclude(row)) continue;
        countTerms(row.content, terms, counts);
        let distinct = 0, freq = 0;
        for (const seen of counts) if (seen) { distinct++; freq += seen; }
        if (!distinct) continue;
        const score = distinct * 1000 + freq, ts = num(row.ts), rowId = num(row.rowId);
        if (best.length === limit && ranksAfter(score, ts, rowId, best[limit - 1]) >= 0) continue;
        let at = best.length;
        while (at > 0 && ranksAfter(score, ts, rowId, best[at - 1]) < 0) at--;
        best.splice(at, 0, Object.assign({ rowId: row.rowId, streamId: row.streamId, role: row.role, content: row.content, ts: row.ts, score, taint: row.taint || '', taintKnown: row.taintKnown === true || !!row.taint }, hitExtras(row)));
        if (best.length > limit) best.length = limit;
      }
    }
    return best.map(clone);
  }
  function streams(options) {
    const limit = Math.max(1, Math.min(100, num(options && options.limit) || 20));
    const previewChars = Math.max(1, num(options && options.previewChars) || 160);
    const by = new Map();
    for (const meta of manifest.segments) for (const sid of Object.keys(meta.streams || {})) {
      const s = meta.streams[sid];
      let dst = by.get(sid);
      if (!dst) dst = { streamId: sid, turns: 0, lastAt: 0, preview: '' };
      dst.turns += num(s.count);
      // Older closed indexes lack visibility provenance: their preview is omitted until the deferred one-time
      // upgrade (upgradeStalePreviews) rebuilds it. Never scan every conversation body merely to list threads.
      if (num(s.lastAt) >= dst.lastAt) { dst.lastAt = num(s.lastAt); if (s.previewVersion === 1 && s.preview) { dst.preview = str(s.preview).slice(0, previewChars); dst.previewTaint = s.previewTaint || ''; dst.previewTaintKnown = s.previewTaintKnown === true || !!s.previewTaint; } }
      by.set(sid, dst);
    }
    return Array.from(by.values()).sort((a, b) => (b.lastAt - a.lastAt) || (a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : 0)).slice(0, limit);
  }
  // How many durable rows the manifest records for ONE stream (every segment's summary), or -1 when this view
  // cannot vouch for the disk (initialization degraded, or the active segment changed underneath this process). The
  // store compares it with its RAM mirror.
  function streamRows(streamId) {
    if (degraded || unvouched) return -1;
    const sid = str(streamId);
    let n = 0;
    for (const meta of manifest.segments) if (hasOwn(meta.streams, sid)) n += num(meta.streams[sid] && meta.streams[sid].count);
    return n;
  }
  /* EVERY ROW ON DISK, ONCE (forget-wiring.js namedElsewhere: a deleted session's upload is removed only when no live row of any stream
     still names it). visit(row) for every parsed row of every listed segment, oldest segment first. The row is the cached parse itself:
     the visitor reads it and never keeps or changes it. Returns { doubted, unread }: the `claims` (strings, matched as a row's JSON writes
     them) this walk cannot rule out, which the caller treats as named. A damaged line (a torn or garbled row may be a live one) doubts the
     claims it names, and a listed segment that is gone for good (unread: its numbers) doubts every claim. Neither fails the walk: a closed
     segment never changes, so a refusal would come back at every pass and no delete would settle again. Throws TRANSCRIPT_UNVOUCHED, and
     the caller proves nothing, only while this view cannot vouch for the disk for now: boot degraded, the active segment changed outside
     this process (both until a restart), or a segment that cannot be read at the moment (locked, busy). */
  function eachRow(visit, claims) {
    const refuse = message => Object.assign(new Error('transcript history cannot be vouched for: ' + message), { code: 'TRANSCRIPT_UNVOUCHED' });
    if (degraded || unvouched) throw refuse(degraded ? 'initialization degraded' : 'the active segment changed outside this process');
    const asked = Array.from(new Set((Array.isArray(claims) ? claims : []).filter(c => typeof c === 'string' && c)));
    const written = asked.map(c => [c, JSON.stringify(c).slice(1, -1)]);
    const doubted = new Set(), unread = [];
    for (const meta of manifest.segments.slice()) {
      let seg;
      try { seg = segmentRows(meta.number, false).seg; }
      catch (e) {
        if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) throw refuse('segment ' + meta.number + ' cannot be read now: ' + ((e && (e.code || e.message)) || e));
        unread.push(meta.number);
        for (const c of asked) doubted.add(c);
        continue;
      }
      for (const line of seg.bad) for (const [c, w] of written) if (!doubted.has(c) && line.includes(w)) doubted.add(c);
      for (const row of seg.rows) visit(row);
    }
    return { doubted: Array.from(doubted), unread };
  }
  function readById(rowId) {
    const id = num(rowId);
    if (!id) return null;
    const meta = manifest.segments.find(s => id >= num(s.minRowId) && id <= num(s.maxRowId));
    if (!meta) return null;
    const row = readRows(meta.number).find(r => num(r.rowId) === id) || null;
    return row ? publicRow(row) : null;
  }
  // Owner-evidence proofs read each requested segment at most once and never substitute the RAM mirror.
  // An assembly may touch at most eight segments; missing, corrupt, collided or excess proofs stay absent.
  function readByIds(rowIds, options) {
    const contextOnly = options && options.retractionsOnly === true;
    const out = new Map(), groups = new Map(), wanted = new Set(), parsed = new Map(), targets = new Map();
    let complete = !(degraded || unvouched || unsafe);
    const finish = () => { Object.defineProperties(out, { proofComplete: { value: complete }, retractions: { value: targets } }); return out; };
    if (!complete) return finish();
    for (const id of Array.isArray(rowIds) ? rowIds : []) {
      if (!Number.isSafeInteger(id) || id <= 0 || (!contextOnly && collisionRanges.some(c => id >= c.lo && id <= c.hi))) continue;
      const meta = manifest.segments.find(s => id >= num(s.minRowId) && id <= num(s.maxRowId));
      if (!meta) continue;
      wanted.add(id);
      if (!groups.has(meta.number)) groups.set(meta.number, new Set());
      groups.get(meta.number).add(id);
    }
    if (!wanted.size) return finish();
    const read = number => {
      if (parsed.has(number)) return parsed.get(number);
      if (parsed.size >= 8) return null;
      let rows;
      try { rows = readRows(number, true); }
      catch (error) { warning('owner proof segment ' + number + ' unreadable: ' + ((error && error.message) || error)); rows = null; }
      parsed.set(number, rows);
      return rows;
    };
    // The active segment may hold a new retract even when none of its rows were requested. Its fresh read
    // consumes one of the same eight slots, never a ninth hidden behind the proof budget.
    if (manifest.segments.some(meta => meta.number === manifest.activeSegment)) read(manifest.activeSegment);
    if (!contextOnly) for (const number of groups.keys()) read(number);
    const add = (id, reason) => { if (wanted.has(id) && (!targets.has(id) || reason === 'undo')) targets.set(id, reason); };
    for (const meta of manifest.segments) {
      let rows = parsed.get(meta.number);
      const summary = meta.retracts;
      const vouched = !meta.unreadable && !meta.corruptLines && summary && summary.v === 1 && Array.isArray(summary.targets)
        && summary.targets.every(pair => Array.isArray(pair) && pair.length === 2 && Number.isSafeInteger(pair[0]) && pair[0] > 0 && ['undo', 'retry'].includes(pair[1]))
        && typeof meta.retractsHash === 'string' && meta.retractsHash === indexHash(summary);
      if (!parsed.has(meta.number) && vouched) { for (const [id, reason] of summary.targets) add(id, reason); continue; }
      if (!parsed.has(meta.number)) rows = read(meta.number);
      if (!rows) { complete = false; continue; }
      // Ordinary views may repair an old/missing summary from a complete fresh parse. Each call still
      // reads at most eight segments; successful closed summaries let later calls advance through old
      // histories. Remaining unknown summaries keep this read unvouched, never equivalent to no retracts.
      if (contextOnly && meta.number !== manifest.activeSegment && !vouched) {
        const summary = { v: 1, targets: [] };
        for (const row of rows) if (row.kind === 'retract' && Array.isArray(row.targets))
          for (const id of row.targets) if (Number.isSafeInteger(id) && id > 0) summary.targets.push([id, row.reason === 'retry' ? 'retry' : 'undo']);
        meta.retracts = summary; meta.retractsHash = indexHash(summary);
      }
      for (const row of rows) if (row.kind === 'retract' && Array.isArray(row.targets))
        for (const id of row.targets) if (Number.isSafeInteger(id) && id > 0) add(id, row.reason === 'retry' ? 'retry' : 'undo');
    }
    const duplicates = new Set();
    for (const rows of parsed.values()) {
      if (!rows) continue;
      for (const row of rows) if (wanted.has(row.rowId)) {
        if (out.has(row.rowId)) duplicates.add(row.rowId);
        else out.set(row.rowId, publicRow(row));
      }
    }
    for (const id of duplicates) out.delete(id);
    // No same-stream shortcut: until the write boundary enforces it, a retract anywhere can name a global id.
    // Old indexes without a complete summary cost a strict read; beyond the shared budget, absence is unknown.
    if (!complete) out.clear();
    return finish();
  }
  function around(streamId, anchor, options) {
    const win = Math.max(1, Math.min(50, num(options && options.window) || 6));
    let target = null;
    const anchorText = str(anchor);
    const idMatch = /^tx-(\d+)$/.exec(anchorText);
    if (idMatch) target = readById(Number(idMatch[1]));
    if (!target && options && options.rowId) target = readById(options.rowId);
    if (!target) {
      const stamp = num(anchor);
      let distance = Infinity;
      for (const meta of relevantSegments(streamId, false)) for (const row of readRows(meta.number)) {
        if (row.streamId !== streamId) continue;
        const d = Math.abs(num(row.ts) - stamp);
        if (d < distance) { distance = d; target = row; }
      }
    }
    if (!target || target.streamId !== streamId) return [];
    const before = [], after = [];
    let seen = false;
    for (const meta of relevantSegments(streamId, false)) for (const row of readRows(meta.number)) {
      if (row.streamId !== streamId) continue;
      if (num(row.rowId) === num(target.rowId)) { seen = true; continue; }
      if (!seen) { before.push(row); if (before.length > win) before.shift(); }
      else if (after.length < win) after.push(row);
    }
    return before.concat([target], after).map(publicRow);
  }

  try { init(); upgradeStalePreviews(); }
  catch (e) {
    closeAppend();
    forgetCaches();
    degraded = true;
    idCollisions = []; collisionRanges = [];
    unsafe = false; unsafeWhy = '';   // re-decided below, from the disk, for this boot outcome
    /* A DEGRADED BOOT NEVER REISSUES AN ID (A2-ID-01). It used to start over at rowId 1 in segment-000001, a closed and
       immutable segment, so every id it minted already named a row. Now it opens a NEW segment above every listed
       one, from the proven floor; with any segment unproven (or the root unlisted) it refuses appends instead. */
    const persisted = readJson(manifestFile);
    const okP = !!persisted && typeof persisted === 'object';
    let pf;
    try {
      pf = provenFloor({ metas: metaMapOf(persisted), manifestNext: okP ? num(persisted.nextRowId) : 0, activeHint: okP ? num(persisted.activeSegment) : 0, blocked: blockedOf(persisted) });
    } catch (proofError) {   // never silent: settleProof below warns with this reason and refuses appends
      pf = { ok: false, unlisted: 'the proof failed: ' + ((proofError && proofError.message) || proofError), numbers: [], maxListed: 0, floor: 1, unproven: [] };
    }
    manifest = { version: VERSION, nextRowId: Math.max(1, pf.floor), activeSegment: pf.maxListed + 1, segments: [], legacy: [] };
    activeIndex = emptyIndex(manifest.activeSegment);
    warning('history initialization degraded to an empty in-memory view: ' + ((e && e.message) || e)
      + (pf.ok ? '; new rows go to ' + segmentName(manifest.activeSegment) + ' (a new segment) from rowId ' + manifest.nextRowId : ''));
    settleProof(manifest, pf);
  }
  return {
    append: appendDurable,
    appendDurable,
    readAll: readRecent,
    readRecent,
    history,
    pageAfter,
    preview(streamId, options) { return history(streamId, { limit: Math.min(200, Math.max(1, num(options && options.limit) || 200)), previewBudget: options && options.budget || { remaining: 0 } }); },
    search,
    streams,
    streamRows,
    eachRow,
    around,
    readById,
    readByIds,
    retractionsFor(rowIds) { return readByIds(rowIds, { retractionsOnly: true }); },
    isCollided(rowId) { return Number.isSafeInteger(rowId) && rowId > 0 && collisionRanges.some(c => rowId >= c.lo && rowId <= c.hi); },
    // releases the open append handle (the next append reopens it); the process exit releases it too
    close() { closeAppend(); },
    // the manifest copy, plus whether boot degraded, whether appends are refused (unsafe), and the boot audit
    status() { return Object.assign(JSON.parse(JSON.stringify(manifest)), { degraded, unsafe, idCollisions: idCollisions.map(clone) }); },
    _internals: { root, manifestFile, leaseFile, segFile, idxFile, tokenize }
  };
}

/* AN IN-MEMORY IO FOR UNIT TESTS (turn-identity). It mints rowIds exactly like appendRaw (monotone from 1; a supplied
   positive rowId is kept and advances the counter) and returns the stored copy, in the segmented io's public row shape
   (a JSON round trip, no legacyKey). It has no `history`, so a store over it reads RAM, and findTurn's absence proof
   over it can only be the whole-stream RAM count (streamRows). The store's own default io stays as it is. The clock is
   accepted for parity with the store's options; a row keeps the ts its writer stamped. */
function makeMemoryTranscriptIo(opts) {   // opts: { clock } (see above)
  const stored = [];
  const idCounts = new Map();
  let nextRowId = 1;
  function appendDurable(entry) {
    let row = Object.assign({}, entry);
    if (num(row.rowId) <= 0) row.rowId = nextRowId++;
    else nextRowId = Math.max(nextRowId, num(row.rowId) + 1);
    row = JSON.parse(JSON.stringify(row));
    stored.push(row);
    idCounts.set(row.rowId, (idCounts.get(row.rowId) || 0) + 1);
    return publicRow(row);
  }
  function readRecent(options) {
    const perStream = Math.max(1, num(options && options.perStream) || DEFAULT_RECENT_PER_STREAM);
    const globalLimit = Math.max(0, num(options && options.globalLimit));
    const counts = new Map(), out = [];
    for (let i = stored.length - 1; i >= 0 && !(globalLimit > 0 && out.length >= globalLimit); i--) {
      const row = stored[i], n = counts.get(row.streamId) || 0;
      if (n >= perStream) continue;
      counts.set(row.streamId, n + 1); out.push(row);
    }
    out.sort((a, b) => num(a.rowId) - num(b.rowId));
    return out.map(publicRow);
  }
  return {
    append: appendDurable,
    appendDurable,
    readAll: readRecent,
    readRecent,
    readById(rowId) { const id = num(rowId); const row = id ? stored.find(r => num(r.rowId) === id) : null; return row ? publicRow(row) : null; },
    readByIds(rowIds) {
      const wanted = new Set((Array.isArray(rowIds) ? rowIds : []).filter(id => Number.isSafeInteger(id) && id > 0));
      const out = new Map(), duplicate = new Set(), retractions = new Map();
      for (const row of stored) if (wanted.has(row.rowId)) { if (out.has(row.rowId)) duplicate.add(row.rowId); else out.set(row.rowId, publicRow(row)); }
      for (const id of duplicate) out.delete(id);
      for (const row of stored) if (row.kind === 'retract' && Array.isArray(row.targets)) for (const id of row.targets)
        if (wanted.has(id) && (!retractions.has(id) || row.reason !== 'retry')) retractions.set(id, row.reason === 'retry' ? 'retry' : 'undo');
      Object.defineProperties(out, { proofComplete: { value: true }, retractions: { value: retractions } });
      return out;
    },
    retractionsFor(rowIds) { return this.readByIds(rowIds); },
    isCollided(rowId) { return (idCounts.get(rowId) || 0) > 1; },
    streamRows(streamId) { const sid = str(streamId); let n = 0; for (const r of stored) if (r.streamId === sid) n++; return n; },
    // every stored row once, as the segmented io's eachRow (a copy here; nothing in memory is damaged or unreadable, so nothing is doubted)
    eachRow(visit) { for (const row of stored) visit(publicRow(row)); return { doubted: [], unread: [] }; },
    // the cursor read of the segmented io (see pageAfter above), over the same rows: oldest first, past the cursor
    pageAfter(streamId, afterRowId, options) {
      const sid = str(streamId), after = Math.max(0, Math.floor(num(afterRowId))), limit = Math.max(1, Math.floor(num(options && options.limit)) || 400);
      const past = stored.filter(r => r.streamId === sid && num(r.rowId) > after).sort((a, b) => num(a.rowId) - num(b.rowId));
      return { rows: past.slice(0, limit).map(publicRow), more: past.length > limit, truncated: false };
    }
  };
}

module.exports = { makeSegmentedTranscriptIo, makeMemoryTranscriptIo, _internals: { tokenize, wordTokens, countTerms, segmentName, indexName, LEASE_FILE, ROWID_LEASE } };
