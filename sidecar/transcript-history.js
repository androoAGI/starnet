/* sidecar/transcript-history.js — dependency-free segmented transcript persistence.

   Closed JSONL segments are immutable. A small durable manifest records segment ranges and
   per-stream summaries; each closed segment has a durable term index. Queries load indexes and
   segment bodies one at a time, so lifetime history is retained without becoming boot-time RAM.
   The active segment is append-only + fsync'd, and appendDurable() reads the exact appended byte
   range back before claiming success. Legacy transcript.jsonl(.1) files are imported without
   deleting or rewriting the originals. */
'use strict';

const { writeFileDurable } = require('./durable-write.js');
const crypto = require('node:crypto');

const VERSION = 2;
const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_RECENT_PER_STREAM = 1200;
const TOKEN_MAX = 64;

function str(v) { return v == null ? '' : String(v); }
function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : Number(v) || 0; }
function wordTokens(v) {
  // NFKC makes compatibility spellings (for example full-width Latin/digits) search the
  // same way while Unicode properties retain words written outside ASCII. Scripts that
  // ordinarily omit spaces are indexed per character so a query can match part of a phrase.
  const normalized = str(v).normalize('NFKC').toLowerCase();
  const cjk = /^(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul})$/u;
  const out = [];
  for (const word of (normalized.match(/[\p{L}\p{N}]+/gu) || [])) {
    let run = '';
    for (const char of word) {
      if (!cjk.test(char)) { run += char; continue; }
      if (run) { out.push(run); run = ''; }
      out.push(char);
    }
    if (run) out.push(run);
  }
  return out.filter(t => t.length <= TOKEN_MAX);
}
function tokenize(v) { return Array.from(new Set(wordTokens(v))); }
function segmentName(n) { return 'segment-' + String(n).padStart(6, '0') + '.jsonl'; }
function indexName(n) { return 'segment-' + String(n).padStart(6, '0') + '.index.json'; }
function clone(v) { return Object.assign({}, v); }
function publicRow(v) { const out = clone(v); delete out.legacyKey; return out; }
function indexHash(index) { return crypto.createHash('sha256').update(JSON.stringify(index)).digest('hex'); }

function makeSegmentedTranscriptIo(opts) {
  const o = opts || {};
  const fs = o.fs;
  const path = o.path;
  if (!fs || !path) throw new Error('makeSegmentedTranscriptIo requires injected fs + path');
  const root = o.root;
  if (!root) throw new Error('makeSegmentedTranscriptIo requires root');
  const segmentBytes = Math.max(256, num(o.segmentBytes) || DEFAULT_SEGMENT_BYTES);
  const recentPerStream = Math.max(1, num(o.recentPerStream) || DEFAULT_RECENT_PER_STREAM);
  const warn = typeof o.onWarning === 'function' ? o.onWarning : function () {};
  const durableWrite = typeof o.writeDurable === 'function' ? o.writeDurable : writeFileDurable;
  const manifestFile = path.join(root, 'manifest.json');
  const legacyFiles = Array.isArray(o.legacyFiles) ? o.legacyFiles.slice() : [];
  let manifest;
  let activeIndex = null;

  function warning(message) { try { warn(message); } catch (_) {} }
  function ensureRoot() { fs.mkdirSync(root, { recursive: true }); }
  function segFile(n) { return path.join(root, segmentName(n)); }
  function idxFile(n) { return path.join(root, indexName(n)); }
  function freshManifest() { return { version: VERSION, nextRowId: 1, activeSegment: 1, segments: [], legacy: [] }; }
  function saveManifest() {
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
    return { version: VERSION, segment: n, rows: 0, bytes: 0, minRowId: 0, maxRowId: 0, minTs: 0, maxTs: 0, corruptLines: 0, streams: Object.create(null), terms: Object.create(null) };
  }
  function noteIndex(index, row) {
    const id = num(row.rowId);
    const ts = num(row.ts);
    index.rows++;
    if (!index.minRowId || id < index.minRowId) index.minRowId = id;
    if (id > index.maxRowId) index.maxRowId = id;
    if (!index.minTs || (ts && ts < index.minTs)) index.minTs = ts;
    if (ts > index.maxTs) index.maxTs = ts;
    // Transcript content and stream ids are untrusted dictionary keys. Plain objects make
    // keys such as "constructor" resolve to inherited prototype values, while "__proto__"
    // can mutate the dictionary itself. Normalize both fresh and JSON-loaded indexes to
    // null-prototype maps before indexing them.
    if (!index.streams || typeof index.streams !== 'object' || Array.isArray(index.streams)) index.streams = Object.create(null);
    else if (Object.getPrototypeOf(index.streams) !== null) index.streams = Object.assign(Object.create(null), index.streams);
    if (!index.terms || typeof index.terms !== 'object' || Array.isArray(index.terms)) index.terms = Object.create(null);
    else if (Object.getPrototypeOf(index.terms) !== null) index.terms = Object.assign(Object.create(null), index.terms);
    const sid = str(row.streamId) || 'global';
    let stream = index.streams[sid];
    if (!stream) stream = index.streams[sid] = { count: 0, lastAt: 0, preview: '' };
    stream.count++;
    if (ts >= stream.lastAt) stream.lastAt = ts;
    if (row.role === 'user' && row.content) stream.preview = str(row.content).replace(/\s+/g, ' ').trim().slice(0, 160);
    for (const term of tokenize(row.content)) {
      const ids = index.terms[term] || (index.terms[term] = []);
      ids.push(id);
    }
  }
  function readRows(n) {
    const file = segFile(n);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) { warning('segment ' + n + ' unreadable: ' + ((e && e.message) || e)); return []; }
    const rows = [];
    let bad = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object' && num(row.rowId) > 0) rows.push(row);
        else bad++;
      } catch (_) { bad++; }
    }
    if (bad) warning('segment ' + n + ' isolated ' + bad + ' corrupt line(s)');
    return rows;
  }
  function buildIndex(n) {
    const index = emptyIndex(n);
    let bytes = 0;
    try { bytes = fs.statSync(segFile(n)).size; } catch (_) { return index; }
    index.bytes = bytes;
    const rows = readRows(n);
    for (const row of rows) noteIndex(index, row);
    const nonempty = (() => {
      try { return fs.readFileSync(segFile(n), 'utf8').split(/\r?\n/).filter(Boolean).length; } catch (_) { return 0; }
    })();
    index.corruptLines = Math.max(0, nonempty - rows.length);
    return index;
  }
  function saveIndex(index) {
    durableWrite({ fs, path }, idxFile(index.segment), JSON.stringify(index));
  }
  function loadIndex(n, persistRepair) {
    if (activeIndex && n === manifest.activeSegment) return activeIndex;
    let index = readJson(idxFile(n));
    const meta = manifest.segments.find(s => s.number === n);
    const hashMismatch = !!(index && meta && meta.indexHash && indexHash(index) !== meta.indexHash);
    if (!index || index.version !== VERSION || index.segment !== n || hashMismatch) {
      if (hashMismatch) warning('segment ' + n + ' index checksum mismatch; rebuilding from immutable JSONL');
      index = buildIndex(n);
      if (persistRepair) { try { saveIndex(index); } catch (e) { warning('index repair failed for segment ' + n + ': ' + ((e && e.message) || e)); } }
      upsertMeta(index);
      if (persistRepair) { try { saveManifest(); } catch (e) { warning('manifest repair failed for segment ' + n + ': ' + ((e && e.message) || e)); } }
    }
    return index;
  }
  function metaFromIndex(index) {
    return {
      number: index.segment, file: segmentName(index.segment), rows: index.rows, bytes: index.bytes,
      minRowId: index.minRowId, maxRowId: index.maxRowId, minTs: index.minTs, maxTs: index.maxTs,
      corruptLines: index.corruptLines || 0, streams: index.streams, indexHash: indexHash(index)
    };
  }
  function upsertMeta(index) {
    const meta = metaFromIndex(index);
    const at = manifest.segments.findIndex(s => s.number === index.segment);
    if (at >= 0) manifest.segments[at] = meta; else manifest.segments.push(meta);
    manifest.segments.sort((a, b) => a.number - b.number);
  }
  function rebuildManifest(old) {
    const next = freshManifest();
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) {}
    const numbers = names.map(parseSegmentNumber).filter(Boolean).sort((a, b) => a - b);
    for (const n of numbers) {
      const index = buildIndex(n);
      try { saveIndex(index); } catch (e) { warning('index rebuild write failed for segment ' + n + ': ' + ((e && e.message) || e)); }
      next.segments.push(metaFromIndex(index));
      next.nextRowId = Math.max(next.nextRowId, index.maxRowId + 1);
    }
    next.activeSegment = numbers.length ? numbers[numbers.length - 1] : 1;
    if (old && Array.isArray(old.legacy)) next.legacy = old.legacy;
    return next;
  }
  function reconcileManifest(loaded) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) {}
    const numbers = names.map(parseSegmentNumber).filter(Boolean).sort((a, b) => a - b);
    const known = new Map((loaded.segments || []).map(s => [s.number, s]));
    // A roll persists the NEXT active number before its first row. If the process dies in that tiny gap,
    // there is deliberately no file yet; retain the manifest's higher pointer instead of reopening the
    // last closed segment and violating immutability.
    const active = Math.max(num(loaded.activeSegment) || 1, numbers.length ? numbers[numbers.length - 1] : 1);
    // Closed segment metadata stays lazy: its durable index is loaded only if a query needs it.
    // Rebuild only the append-active tail and any segment absent from the manifest.
    for (const n of numbers) {
      if (n !== active && known.has(n)) continue;
      const index = buildIndex(n);
      known.set(n, metaFromIndex(index));
    }
    loaded.segments = Array.from(known.values()).sort((a, b) => a.number - b.number);
    loaded.activeSegment = active;
    loaded.nextRowId = 1;
    for (const meta of loaded.segments) loaded.nextRowId = Math.max(loaded.nextRowId, num(meta.maxRowId) + 1);
    return loaded;
  }
  function legacyKey(file, lineNo) { return path.basename(file) + ':' + lineNo; }
  function importedLegacyKeys() {
    const keys = new Set();
    for (const meta of manifest.segments) for (const row of readRows(meta.number)) if (row.legacyKey) keys.add(row.legacyKey);
    return keys;
  }
  function appendRaw(entry, options) {
    const settings = options || {};
    if (!activeIndex) activeIndex = loadIndex(manifest.activeSegment, false);
    let row = Object.assign({}, entry);
    if (num(row.rowId) <= 0) row.rowId = manifest.nextRowId++;
    else manifest.nextRowId = Math.max(manifest.nextRowId, num(row.rowId) + 1);
    const encoded = Buffer.from(JSON.stringify(row) + '\n', 'utf8');
    if (activeIndex.rows > 0 && activeIndex.bytes + encoded.length > segmentBytes) {
      saveIndex(activeIndex);
      upsertMeta(activeIndex);
      manifest.activeSegment++;
      activeIndex = emptyIndex(manifest.activeSegment);
      saveManifest();
    }
    const file = segFile(manifest.activeSegment);
    let offset = 0;
    try { offset = fs.statSync(file).size; } catch (_) {}
    let fd = null;
    try {
      fd = fs.openSync(file, 'a');
      fs.writeSync(fd, encoded);
      fs.fsyncSync(fd);
    } finally { if (fd != null) try { fs.closeSync(fd); } catch (_) {} }

    // Strict read-back: prove the exact bytes just fsync'd parse as the row we assigned.
    let checkFd = null;
    try {
      const check = Buffer.alloc(encoded.length);
      checkFd = fs.openSync(file, 'r');
      const got = fs.readSync(checkFd, check, 0, check.length, offset);
      if (got !== encoded.length) throw new Error('short transcript read-back');
      const proven = JSON.parse(check.toString('utf8').trim());
      if (num(proven.rowId) !== num(row.rowId)) throw new Error('transcript read-back rowId mismatch');
      row = proven;
    } finally { if (checkFd != null) try { fs.closeSync(checkFd); } catch (_) {} }

    activeIndex.bytes += encoded.length;
    noteIndex(activeIndex, row);
    upsertMeta(activeIndex);
    // The JSONL row is the source of truth. Persist the small manifest only at segment boundaries/migration;
    // init() always reconciles the active tail, so a crash after this proven append cannot lose or reuse its id.
    if (settings.saveManifest) saveManifest();
    return row;
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
    migrateLegacy();
    saveManifest();
  }
  function appendDurable(entry, options) {
    try { return appendRaw(entry, options); }
    catch (e) {
      warning('append failed: ' + ((e && e.message) || e));
      throw e;
    }
  }
  function relevantSegments(streamId, reverse) {
    const list = manifest.segments.filter(s => !streamId || (s.streams && s.streams[streamId]));
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
  function history(streamId, options) {
    const limit = Math.max(1, num(options && options.limit) || 400);
    const runId = String((options && options.sourceRunId) || '');
    const out = [];
    for (const meta of relevantSegments(streamId, true)) {
      const rows = readRows(meta.number);
      for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) if (rows[i].streamId === streamId && (!runId || rows[i].sourceRunId === runId)) out.push(rows[i]);
      if (out.length >= limit) break;
    }
    return out.reverse().map(publicRow);
  }
  function search(streamId, query, options) {
    const settings = options || {};
    const limit = Math.max(1, Math.min(50, num(settings.limit) || 10));
    const terms = tokenize(query);
    if (!terms.length) return [];
    const all = settings.scope === 'all';
    const best = [];
    for (const meta of manifest.segments) {
      if (!all && !(meta.streams && meta.streams[streamId])) continue;
      const index = loadIndex(meta.number, meta.number !== manifest.activeSegment);
      const candidates = new Set();
      for (const term of terms) for (const id of (index.terms[term] || [])) candidates.add(num(id));
      if (!candidates.size) continue;
      for (const row of readRows(meta.number)) {
        if (!candidates.has(num(row.rowId)) || (!all && row.streamId !== streamId)) continue;
        const tf = {};
        for (const t of wordTokens(row.content)) tf[t] = (tf[t] || 0) + 1;
        let distinct = 0, freq = 0;
        for (const term of terms) if (tf[term]) { distinct++; freq += tf[term]; }
        if (!distinct) continue;
        best.push({ rowId: row.rowId, streamId: row.streamId, role: row.role, content: row.content, ts: row.ts, score: distinct * 1000 + freq });
        best.sort((a, b) => (b.score - a.score) || (num(b.ts) - num(a.ts)) || (num(b.rowId) - num(a.rowId)));
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
      if (num(s.lastAt) >= dst.lastAt) { dst.lastAt = num(s.lastAt); if (s.preview) dst.preview = str(s.preview).slice(0, previewChars); }
      by.set(sid, dst);
    }
    return Array.from(by.values()).sort((a, b) => (b.lastAt - a.lastAt) || (a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : 0)).slice(0, limit);
  }
  function readById(rowId) {
    const id = num(rowId);
    if (!id) return null;
    const meta = manifest.segments.find(s => id >= num(s.minRowId) && id <= num(s.maxRowId));
    if (!meta) return null;
    const row = readRows(meta.number).find(r => num(r.rowId) === id) || null;
    return row ? publicRow(row) : null;
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

  try { init(); }
  catch (e) {
    warning('history initialization degraded to an empty in-memory view: ' + ((e && e.message) || e));
    manifest = freshManifest();
    activeIndex = emptyIndex(manifest.activeSegment);
  }
  return {
    append: appendDurable,
    appendDurable,
    readAll: readRecent,
    readRecent,
    history,
    search,
    streams,
    around,
    readById,
    status() { return JSON.parse(JSON.stringify(manifest)); },
    _internals: { root, manifestFile, segFile, idxFile, tokenize }
  };
}

module.exports = { makeSegmentedTranscriptIo, _internals: { tokenize, segmentName, indexName } };
