/* sidecar/persist/replace.js — replaceJson: the ONE "replace a JSON store, keeping a last-known-good" policy.
   (durable-store writeJsonResilient, savestore's writeAtomic and channels/store's writeJsonAtomic all call it.)

   replaceJson({ fs, path, writeDurable? }, file, value, { prior?, seen? }) -> { backup, text }, or throws:
     ESTORE_UNREADABLE  the main is unreadable, or the main is missing or bad and the .bak is unreadable: the only
                        authority is inaccessible, so nothing is replaced (cause: the errno)
     ESTORE_CORRUPT     the main is present but bad and its bytes could not be kept: bytes untouched
     ESTORE_UNSEEN      a blind write over a file this process could not read, and its bytes could not be kept
     <errno>            the write itself failed (writeAtomic leaves no temp behind)
   On success: backup = how the .bak was refreshed ('link' | 'copy' | 'failed', or null when the main was not good, so
   the .bak was left alone), text = the exact text written (a caller's cache keeps it; a 'link' .bak IS the old main).

   In order:
   1. What is on disk: the main is read (and the .bak when the main is not good). prior = { status, raw? } from the
      caller's own read moments before, with no await in between (a read-modify-write store's memo or stat cache), skips
      that read when it settles the question ('ok', or 'absent'). An 'ok' prior without its raw (a memo of this process's
      own last write, a stat-cache hit) reads the main only when a .bak must be copied (no hard links).
   2. D2, bytes nobody read: when this process's read of the file came back unreadable (read.js marks it) and the caller
      is a BLIND writer (no prior, not seen: a full-state store saving the memory it built from that failed load), every
      present copy (main, .bak) is kept as <file>.unseen-<n> / <file>.bak.unseen-<n> first, byte-exact.
   3. A present-but-bad main is kept as <file>.corrupt-<n> before it is replaced (never dropped, bug 34c58f4f).
   4. D1, the last-known-good: a good main becomes the .bak by hard link (unlink-then-link: two metadata operations for
      bytes that were made durable when they were written as the main) or, without hard links, by a durable copy. A .bak
      that cannot be refreshed is noted (failNote 'persist.bak') and never blocks the main write: the main replace is
      atomic either way, and refusing lost the user's write while the old .bak was already gone.
   5. The replace itself through the injected writer (index.js passes its update-frozen writer), then the unread mark is
      cleared and the .bak's own dead/stale temps are swept. */
'use strict';

const { writeAtomic, sweep } = require('./write.js');
const read = require('./read.js');
const { preserve } = require('./quarantine.js');
const { note: failNote } = require('../failopen.js');

// a link refusal that only means "no hard links here" (FAT/exFAT, a facade, a cross-device path): copy, quietly
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EISDIR']);

function refusal(code, message, cause, file) {
  const error = new Error(message + ' (' + file + ')');
  error.code = code;
  error.cause = cause;
  error.file = file;
  return error;
}

function linkAsBackup(fs, file) {
  if (typeof fs.linkSync !== 'function' || typeof fs.unlinkSync !== 'function') return false;
  const bak = file + '.bak';
  try {
    try { fs.unlinkSync(bak); } catch (e) { if (!read.isAbsentError(e)) throw e; }
    fs.linkSync(file, bak);
    return true;
  } catch (e) {
    // the main is untouched either way; the copy below makes the .bak instead
    if (!e || !NO_LINK.has(e.code)) failNote('persist.bak.link', e);
    return false;
  }
}

// 'link' | 'copy' | 'failed' (noted: D1, never blocks the main write)
function refreshBackup(fs, pathMod, wd, file, raw) {
  if (linkAsBackup(fs, file)) return 'link';
  try {
    wd({ fs: fs, path: pathMod }, file + '.bak', raw != null ? raw : fs.readFileSync(file, 'utf8'));
    return 'copy';
  } catch (e) { failNote('persist.bak', e); return 'failed'; }
}

function replaceJson(deps, file, value, opts) {
  const fs = deps.fs;
  const pathMod = deps.path;
  const wd = (typeof deps.writeDurable === 'function') ? deps.writeDurable : writeAtomic;
  const o = opts || {};
  const prior = (o.prior && typeof o.prior === 'object') ? o.prior : null;
  const data = JSON.stringify(value);

  // 1. what is on disk now
  let main;
  if (prior && prior.status === 'ok') main = { kind: 'ok', raw: prior.raw };   // raw unknown: read only for a .bak copy
  else if (prior && prior.status === 'absent') main = { kind: 'absent' };
  else main = read.readOne(fs, file, true);
  if (main.kind === 'unreadable') throw refusal('ESTORE_UNREADABLE', 'persist: refusing to replace unreadable state', main.err, file);
  let bak = null;
  if (main.kind !== 'ok') {
    bak = (prior && prior.status === 'absent') ? { kind: 'absent' } : read.readOne(fs, file + '.bak');
    if (bak.kind === 'unreadable') throw refusal('ESTORE_UNREADABLE', 'persist: refusing to replace unreadable state', bak.err, file + '.bak');
  }

  // 2. D2: a blind writer never replaces bytes this process could not read without keeping them
  if (!prior && !o.seen && read.isUnread(file)) {
    const copies = [];
    if (main.kind === 'ok') copies.push(file);   // a bad main is kept as .corrupt-<n> below
    if (!bak || bak.kind !== 'absent') copies.push(file + '.bak');
    for (const copy of copies) {
      const kept = preserve({ fs: fs }, copy, 'unseen');
      if (kept.ok) console.warn('[persist] kept ' + copy + ' as ' + kept.to + ': this process could not read it before this write replaced it.');
      else if (!kept.absent) throw refusal('ESTORE_UNSEEN', 'persist: could not keep bytes this process never read', kept.error, copy);
    }
  }

  // 3. a present-but-bad main is kept before it is replaced
  if (read.isBad(main.kind)) {
    const kept = preserve({ fs: fs }, file, 'corrupt');
    if (!kept.ok && !kept.absent) throw refusal('ESTORE_CORRUPT', 'persist: refusing to replace bad bytes that could not be kept', kept.error, file);
  }

  // 4. D1: the good main becomes the .bak; a .bak that cannot be refreshed never blocks the write
  const backup = main.kind === 'ok' ? refreshBackup(fs, pathMod, wd, file, main.raw) : null;

  // 5. the replace
  wd({ fs: fs, path: pathMod }, file, data);
  read.clearUnread(file);
  try { sweep({ fs: fs, path: pathMod }, file + '.bak'); } catch (e) { failNote('persist.sweep', e); }
  return { backup: backup, text: data };
}

module.exports = { replaceJson, refreshBackup, linkAsBackup, NO_LINK };
