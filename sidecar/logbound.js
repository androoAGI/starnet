/* sidecar/logbound.js — bounded boot-load + size rotation for the append-only JSONL logs (P3).

   The spend ledger, run-history and conversation transcript are append-only JSONL stores. Today each
   is read into RAM in full at boot (index.js: fs.readFileSync(FILE).split('\n')) and never rotates, so
   months of 24/7 use grow them without bound: boot latency and RSS climb until a single readFileSync
   crash-loops startup. This module bounds BOTH:

   • tailLines({fs}, file, maxBytes) — read only the LAST maxBytes of a file and return its complete
     lines (a partial leading line, sheared by the byte cut, is dropped). Missing file -> []. This keeps
     boot RAM + latency bounded regardless of how large the file on disk is.

   • rotateIfLarge({fs}, file, maxBytes) — when the live file exceeds maxBytes, rename it to <file>.1
     (replacing any prior .1), so the next append starts a fresh segment. Disk is bounded to ~2*maxBytes
     (current + one archived segment). Best-effort: a rotate failure never breaks the append.

   • loadBounded({fs}, file, maxBytes) — the boot read: the tail of the archived <file>.1 segment
     followed by the tail of the live file, together bounded to ~maxBytes of the most-recent lines.

   • appendJsonlDurable({fs}, file, entry) — append one complete JSON line, handling short writes,
     fsyncing it, and rolling a rejected partial append back to the prior byte boundary.

   The byte-tail read uses a positional fd read (open/fstat/read/close) so it never materializes the
   whole file. An fs without fstatSync/readSync (an in-memory test fs) degrades to a full readFileSync
   and an in-memory tail — still correct, just not I/O-bounded (only the real Node fs needs the bound).

   Pure injected I/O; no ambient clock/rng -> passes lint-determinism. */
'use strict';

// deps.onCut (optional): called when a read leaves older lines out (a byte cut of either file, or the combined budget), so a
// reader that must know it holds the WHOLE log (the growth fold's strict read) learns it from this one read, not a second
function cutAt(deps) { if (deps && typeof deps.onCut === 'function') deps.onCut(); }

// return the complete trailing lines of `file` within the last `maxBytes` bytes (newest-biased).
// A line straddling the byte cut at the front is dropped (it is incomplete). Missing file -> [].
function tailLines(deps, file, maxBytes) {
  const fs = deps.fs;
  const cap = (typeof maxBytes === 'number' && maxBytes > 0) ? maxBytes : (8 * 1024 * 1024);

  // Fast path: positional read of only the last `cap` bytes (never reads the whole file into RAM).
  if (typeof fs.openSync === 'function' && typeof fs.fstatSync === 'function' && typeof fs.readSync === 'function' && typeof fs.closeSync === 'function' && typeof Buffer !== 'undefined') {
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const start = size > cap ? size - cap : 0;
      if (deps.strict && start > 0) throw new Error('spend history truncated by read limit');
      const len = size - start;
      const buf = Buffer.allocUnsafe(len);
      let off = 0;
      while (off < len) {
        const n = fs.readSync(fd, buf, off, len - off, start + off);
        if (deps.strict && n <= 0 && off < len) throw new Error('incomplete spend history read');
        if (n <= 0) break;
        off += n;
      }
      let text = buf.toString('utf8', 0, off);
      if (start > 0) { cutAt(deps); const nl = text.indexOf('\n'); text = nl >= 0 ? text.slice(nl + 1) : ''; }   // drop the sheared partial first line
      return text.split('\n').filter(Boolean);
    } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      if (deps.strict) throw e;
      // fall through to the slow path on any other read error
    } finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
  }

  // Slow path (in-memory fs / no positional read): full read, then tail in memory.
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (deps.strict && (!e || e.code !== 'ENOENT')) throw e; return []; }
  if (raw == null) return [];
  let text = String(raw);
  if (deps.strict && Buffer.byteLength(text, 'utf8') > cap) throw new Error('spend history truncated by read limit');
  if (text.length > cap) { cutAt(deps); const cut = text.slice(text.length - cap); const nl = cut.indexOf('\n'); text = nl >= 0 ? cut.slice(nl + 1) : ''; }
  return text.split('\n').filter(Boolean);
}

// boot read: archived segment tail + live tail, together bounded to ~maxBytes of newest lines.
function loadBounded(deps, file, maxBytes) {
  const cap = (typeof maxBytes === 'number' && maxBytes > 0) ? maxBytes : (8 * 1024 * 1024);
  const prev = tailLines(deps, file + '.1', cap);
  const cur = tailLines(deps, file, cap);
  const all = prev.concat(cur);
  // keep only the newest lines that fit in the byte budget (cheap char-length proxy for bytes).
  let total = 0, keepFrom = all.length;
  for (let i = all.length - 1; i >= 0; i--) { total += (deps.strict ? Buffer.byteLength(all[i], 'utf8') : all[i].length) + 1; if (total > cap) break; keepFrom = i; }
  if (deps.strict && keepFrom > 0) throw new Error('spend history truncated by combined read limit');
  if (keepFrom > 0) cutAt(deps);
  return all.slice(keepFrom);
}

// when `file` exceeds maxBytes, rotate it to <file>.1 (replacing any prior archive). Returns true if
// a rotation happened. Best-effort: any failure returns false and leaves the live file in place.
function rotateIfLarge(deps, file, maxBytes) {
  const fs = deps.fs;
  const cap = (typeof maxBytes === 'number' && maxBytes > 0) ? maxBytes : (8 * 1024 * 1024);
  try {
    let size = 0;
    if (typeof fs.statSync === 'function') { try { size = fs.statSync(file).size; } catch (e) { return false; } }
    else { try { size = String(fs.readFileSync(file, 'utf8')).length; } catch (e) { return false; } }
    if (size <= cap) return false;
    try { if (typeof fs.unlinkSync === 'function') fs.unlinkSync(file + '.1'); } catch (_) {}   // renameSync onto an existing target is atomic on POSIX but fails on Windows — clear first
    fs.renameSync(file, file + '.1');
    return true;
  } catch (e) { return false; }
}

// Append exactly one JSONL row. writeSync may write fewer bytes than requested; treating any positive return
// as complete silently truncates a row while still fsyncing and reporting success. Keep writing until the
// Buffer is complete and restore the original boundary if progress stops.
//
// TORN TAIL (H2). A crash mid-append can leave the file ending in a partial row with no newline; appending straight
// after it glued the new row onto the fragment, and both became one unparsable line (readers skip it — the NEW row
// was lost while this function reported success). A lone '\n' first isolates the fragment on its own line, and the
// fsync'd row is then read back and proven to be a complete, newline-bounded, parseable LINE of the file.
function appendJsonlDurable(deps, file, entry) {
  const fs = deps.fs;
  const note = typeof deps.note === 'function' ? deps.note : () => {};
  let fd = null, start = 0, startKnown = false;
  try {
    fd = fs.openSync(file, 'a+');
    start = fs.fstatSync(fd).size;
    startKnown = true;
    const json = Buffer.from(JSON.stringify(entry) + '\n', 'utf8');
    let sep = 0;
    if (start > 0) {
      const last = Buffer.alloc(1);
      if (fs.readSync(fd, last, 0, 1, start - 1) !== 1) throw new Error('JSONL tail byte unreadable');
      if (last[0] !== 0x0a) sep = 1;
    }
    const row = sep ? Buffer.concat([Buffer.from('\n', 'utf8'), json]) : json;
    let offset = 0;
    while (offset < row.length) {
      const wrote = fs.writeSync(fd, row, offset, row.length - offset);
      if (!Number.isInteger(wrote) || wrote <= 0 || wrote > row.length - offset) throw new Error('incomplete JSONL append');
      offset += wrote;
    }
    fs.fsyncSync(fd);
    // read-back: the row starts a line (file start or a preceding '\n'), ends one, and parses on its own.
    const rowStart = start + sep;
    const lead = rowStart > 0 ? 1 : 0;
    const check = Buffer.alloc(json.length + lead);
    const got = fs.readSync(fd, check, 0, check.length, rowStart - lead);
    if (got !== check.length || (lead && check[0] !== 0x0a) || check[check.length - 1] !== 0x0a) throw new Error('JSONL append read-back is not a complete line');
    JSON.parse(check.toString('utf8', lead, check.length - 1));
  } catch (e) {
    // Windows refuses truncation through an append-open handle. Close it, restore by path, then fsync the
    // restored file before surfacing the failed append.
    if (fd != null) { try { fs.closeSync(fd); } catch (closeError) { note('jsonl.append.write-close', closeError); } fd = null; }
    if (startKnown) {
      let rollbackFd = null;
      try {
        fs.truncateSync(file, start);
        rollbackFd = fs.openSync(file, 'r+');
        fs.fsyncSync(rollbackFd);
      } catch (rollbackError) { e.rollbackError = rollbackError; }
      finally { if (rollbackFd != null) { try { fs.closeSync(rollbackFd); } catch (closeError) { note('jsonl.append.rollback-close', closeError); } } }
    }
    throw e;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (closeError) { note('jsonl.append.write-close', closeError); } }
  }
}

module.exports = { tailLines, loadBounded, rotateIfLarge, appendJsonlDurable };
