/* sidecar/persist/quarantine.js — keeping bytes aside: the ONE implementation of a forensic copy.

   moveAside({ fs }, file, label) -> { ok: true, to } | { ok: false, error, absent? }
     Puts the file's bytes at the first free <file>.<label>-<n> (n from 1) and removes the original name. A hard link
     then an unlink: EEXIST steps to the next n, so a second incident (after a restart too) never replaces the first
     copy (bug e862d9ff). Any other link refusal (FAT/exFAT have no hard links; EPERM, ENOTSUP, ENOSYS, EXDEV, EINVAL,
     EISDIR) falls back to an exclusive copy then unlink. Checking existence before rename would overwrite a forensic
     copy another writer created between the two calls. A link or copy whose source could not then be unlinked (a lock)
     is undone, so a failed move leaves the file exactly where it was. It never names a destination that does not exist.
   preserve({ fs }, file, label, { copyOnly }) -> same shape
     Keeps the source and adds the first free <file>.<label>-<n>: a hard link, else (or with copyOnly, for a file later
     appended in place, where a shared inode would change the copy) an exclusively opened, flushed copy. A failed copy
     removes only a destination this call opened. Minimal test facades use their exclusive copy/write primitive and
     own its failure cleanup; an error alone never proves a destination belongs to this call.
   Labels: 'corrupt' (bad bytes) and 'unseen' (bytes this process never read). absent:true = the source is gone. */
'use strict';

const names = require('./names.js');
const { isAbsentError } = require('./read.js');
const { note: failNote } = require('../failopen.js');
const { syncDir } = require('./write.js');
const path = require('node:path');

const MAX_N = 100000;

function taken(fs, p) {
  if (typeof fs.existsSync === 'function') return fs.existsSync(p);
  try {
    if (typeof fs.lstatSync === 'function') fs.lstatSync(p);
    else fs.readFileSync(p);
    return true;
  } catch (e) { return !isAbsentError(e); }
}

function noFreeName(file, label) { return { ok: false, error: new Error('persist: no free ' + label + ' name beside ' + file) }; }

function finishMove(fs, file, to) {
  try {
    // The hard-link path also needs its new directory entry flushed before the original name can disappear.
    if (typeof fs.openSync === 'function' && typeof fs.fsyncSync === 'function' && typeof fs.closeSync === 'function') syncDir(fs, path, to, true);
    fs.unlinkSync(file); return { ok: true, to: to };
  }
  catch (e) {
    // We created this destination; undo it when the original cannot be dropped.
    try { fs.unlinkSync(to); } catch (u) { failNote('persist.quarantine.undo', u); }
    return { ok: false, error: e };
  }
}

function moveAside(deps, file, label) {
  const fs = deps.fs;
  let link = typeof fs.linkSync === 'function' && typeof fs.unlinkSync === 'function';
  for (let n = 1; n <= MAX_N; n++) {
    const to = names.forensicName(file, label, n);
    if (link) {
      let linked = false;
      try { fs.linkSync(file, to); linked = true; }
      catch (e) {
        if (e && e.code === 'EEXIST') continue;
        if (isAbsentError(e)) return { ok: false, absent: true, error: e };
        link = false;   // no hard links here: an exclusive copy, from this n on
      }
      if (linked) return finishMove(fs, file, to);
    }
    const copied = copyExclusive(fs, file, to);
    if (copied === 'taken') continue;
    if (copied === true) return finishMove(fs, file, to);
    return copied;
  }
  return noFreeName(file, label);
}

// one exclusive copy attempt: true | 'taken' | { ok: false, ... }
function copyExclusive(fs, from, to) {
  // Read before creating the destination: a source read failure has no destination to clean up.
  if (typeof fs.openSync === 'function' && typeof fs.writeSync === 'function' && typeof fs.closeSync === 'function') {
    let fd = null, owned = false;
    try {
      const raw = fs.readFileSync(from);
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
      const mode = typeof fs.statSync === 'function' ? fs.statSync(from).mode & 0o777 : 0o600;
      fd = fs.openSync(to, 'wx', mode);
      owned = true;
      let offset = 0;
      while (offset < bytes.length) {
        let wrote = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (wrote == null) wrote = bytes.length - offset;   // legacy in-memory fs facade
        if (!Number.isInteger(wrote) || wrote <= 0 || wrote > bytes.length - offset) {
          const e = new Error('persist: forensic copy made no valid write progress');
          e.code = 'ESHORTWRITE';
          throw e;
        }
        offset += wrote;
      }
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
      fs.closeSync(fd); fd = null;
      // Flush copied bytes and the new name before any caller can replace or remove the original.
      if (typeof fs.fsyncSync === 'function') syncDir(fs, path, to, true);
      return true;
    } catch (e) {
      if (fd != null) { try { fs.closeSync(fd); } catch (u) { failNote('persist.close', u); } }
      if (owned && typeof fs.unlinkSync === 'function') {
        try { fs.unlinkSync(to); } catch (u) { if (!isAbsentError(u)) failNote('persist.preserve.partial', u); }
      }
      if (!owned && e && e.code === 'EEXIST') return 'taken';
      if (!owned && isAbsentError(e) && !taken(fs, from)) return { ok: false, absent: true, error: e };
      return { ok: false, error: e };
    }
  }
  if (typeof fs.copyFileSync === 'function') {
    const EXCL = (fs.constants && fs.constants.COPYFILE_EXCL) || 1;
    try { fs.copyFileSync(from, to, EXCL); return true; }
    catch (e) {
      if (e && e.code === 'EEXIST') return 'taken';
      if (isAbsentError(e) && !taken(fs, from)) return { ok: false, absent: true, error: e };
      // No successful exclusive open was observed. This may be somebody else's destination; never delete it.
      return { ok: false, error: e };
    }
  }
  if (typeof fs.readFileSync !== 'function' || typeof fs.writeFileSync !== 'function') return { ok: false, error: new Error('persist: this fs cannot copy') };
  if (taken(fs, to)) return 'taken';
  let bytes;
  try { bytes = fs.readFileSync(from); }
  catch (e) { return isAbsentError(e) ? { ok: false, absent: true, error: e } : { ok: false, error: e }; }
  try { fs.writeFileSync(to, bytes, { flag: 'wx' }); return true; }
  catch (e) { return (e && e.code === 'EEXIST') ? 'taken' : { ok: false, error: e }; }
}

function preserve(deps, file, label, opts) {
  const fs = deps.fs;
  let link = !(opts && opts.copyOnly) && typeof fs.linkSync === 'function';
  for (let n = 1; n <= MAX_N; n++) {
    const to = names.forensicName(file, label, n);
    if (link) {
      try { fs.linkSync(file, to); return { ok: true, to: to }; }
      catch (e) {
        if (e && e.code === 'EEXIST') continue;
        if (isAbsentError(e)) return { ok: false, absent: true, error: e };
        link = false;   // no hard links here: an exclusive copy, from this n on
      }
    }
    const r = copyExclusive(fs, file, to);
    if (r === 'taken') continue;
    if (r === true) return { ok: true, to: to };
    return r;
  }
  return noFreeName(file, label);
}

module.exports = { moveAside, preserve, copyExclusive, taken };
