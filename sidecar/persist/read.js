/* sidecar/persist/read.js — readTagged: the ONE tagged read of a JSON store file and its <file>.bak.
   (Moved here from durable-store.js readOne/readJsonResilient, which now delegate.)

   readOne(fs, file, keepRaw) -> { kind, value?, raw?, err? }   one file:
     'ok'         read and parsed
     'absent'     ENOENT or ENOTDIR: there is no such file
     'unreadable' ANY other errno (EBUSY/EACCES/EPERM/EMFILE/EIO: on Windows a file held open by antivirus or another
                  process reads as one of these): the file is present but cannot be read right now. NEVER empty and NEVER
                  corrupt: conflating it with either is the silent-data-wipe hazard (bug 34c58f4f).
     'empty'      zero-length (a torn write)
     'corrupt'    present, read, unparseable

   readTagged({ fs }, file) -> { status, value, err?, problemFile?, main, bak? }
     'ok'         main parsed                          (value = main)
     'recovered'  main missing or bad, .bak parsed     (value = the .bak's)
     'absent'     neither main nor .bak exists         (a brand-new store: the ONLY state that loads empty)
     'corrupt'    main present-but-bad with no usable .bak, or main absent with a bad .bak; problemFile names the file
                  holding the forensic bytes
     'unreadable' the main, or (when the main is missing or bad) the sole .bak, could not be read; problemFile names the
                  .bak in the second case. Never recovered from a stale .bak (that would roll back live data).
   main / bak are the per-file kinds above (bak is absent from the result when the .bak was not read), so the caller's
   read policy can tell a present-but-bad copy (isBad) from a missing one.

   readTagged({ fs }, file, { text: true }) -> { status, value, err?, main }   the same errno policy for a file that is
     not one JSON value (an append journal, whose own replay judges every line): the file alone (no .bak), no parse, and
     zero-length is just ''. 'ok' (value = the text) | 'absent' | 'unreadable' (never empty; it marks the file unread).

   THE UNREAD MARK: an 'unreadable' result marks the file as unread in this process; only a successful replace of that
   file (replace.js) clears it. A writer that never read the file and replaces it while it is marked (a full-state store
   whose boot load was locked) first keeps every present copy as <file>.unseen-<n> (decision D2). */
'use strict';

let unread = new Set();

function isAbsentError(e) { return !!e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'); }
// a present copy whose bytes are not a value: what the read policy moves aside and a replace keeps first
function isBad(kind) { return kind === 'empty' || kind === 'corrupt'; }

function readOne(fs, file, keepRaw) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return isAbsentError(e) ? { kind: 'absent' } : { kind: 'unreadable', err: e }; }
  if (raw == null || String(raw).length === 0) return { kind: 'empty' };   // zero-length = torn write
  let value;
  try { value = JSON.parse(raw); }
  catch (e) { return { kind: 'corrupt', err: e }; }
  return keepRaw ? { kind: 'ok', value: value, raw: raw } : { kind: 'ok', value: value };
}

function readText(fs, file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (isAbsentError(e)) return { value: undefined, status: 'absent', main: 'absent' };
    unread.add(String(file));
    return { value: undefined, status: 'unreadable', err: e, main: 'unreadable' };
  }
  return { value: raw == null ? '' : String(raw), status: 'ok', main: 'ok' };
}

function readTagged(deps, file, opts) {
  const fs = deps.fs;
  if (opts && opts.text) return readText(fs, file);
  const m = readOne(fs, file);
  if (m.kind === 'ok') return { value: m.value, status: 'ok', main: 'ok' };
  if (m.kind === 'unreadable') {
    unread.add(String(file));
    return { value: undefined, status: 'unreadable', err: m.err, main: 'unreadable' };
  }
  const b = readOne(fs, file + '.bak');
  if (b.kind === 'ok') return { value: b.value, status: 'recovered', main: m.kind, bak: 'ok' };
  if (m.kind === 'absent' && b.kind === 'absent') return { value: undefined, status: 'absent', main: 'absent', bak: 'absent' };
  if (b.kind === 'unreadable') {
    unread.add(String(file));
    return { value: undefined, status: 'unreadable', err: b.err, problemFile: file + '.bak', main: m.kind, bak: 'unreadable' };
  }
  // main present-but-bad and no usable .bak, or no main and a bad .bak: unrecoverable, never silently empty. When the
  // main is absent the forensic bytes live in the BACKUP: carry that exact path so a host quarantine never keeps trying
  // to move the missing main while the bad backup pins this store corrupt forever.
  return { value: undefined, status: 'corrupt', problemFile: m.kind === 'absent' ? file + '.bak' : file, main: m.kind, bak: b.kind };
}

// the present-but-bad copies of a tagged read, main first: what the one read policy moves aside
function badCopies(file, r) {
  const out = [];
  if (r && isBad(r.main)) out.push(String(file));
  if (r && isBad(r.bak)) out.push(file + '.bak');
  return out;
}

function isUnread(file) { return unread.has(String(file)); }
function clearUnread(file) { unread.delete(String(file)); }
function _resetForTests() { unread = new Set(); }

module.exports = { readOne, readTagged, badCopies, isBad, isAbsentError, isUnread, clearUnread, _resetForTests };
