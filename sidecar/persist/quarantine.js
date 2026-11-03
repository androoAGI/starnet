/* sidecar/persist/quarantine.js — keeping bytes aside: the ONE implementation of a forensic copy.

   moveAside({ fs }, file, label) -> { ok: true, to } | { ok: false, error, absent? }
     Puts the file's bytes at the first free <file>.<label>-<n> (n from 1) and removes the original name. A hard link
     then an unlink: EEXIST steps to the next n, so a second incident (after a restart too) never replaces the first
     copy (bug e862d9ff). Any other link refusal (FAT/exFAT have no hard links; EPERM, ENOTSUP, ENOSYS, EXDEV, EINVAL,
     EISDIR) falls back to an existence check plus a rename. A link whose source could not then be unlinked (a lock) is
     undone, so a failed move leaves the file exactly where it was. It never names a destination that does not exist.
   preserve({ fs }, file, label, { copyOnly }) -> same shape
     Keeps the source and adds the first free <file>.<label>-<n>: a hard link, else (or with copyOnly, for a file later
     appended in place, where a shared inode would change the copy) a COPYFILE_EXCL copy. A failed copy removes its own
     partial file. A facade without copyFileSync copies through readFileSync + an exclusive writeFileSync.
   Labels: 'corrupt' (bad bytes) and 'unseen' (bytes this process never read). absent:true = the source is gone. */
'use strict';

const names = require('./names.js');
const { isAbsentError } = require('./read.js');
const { note: failNote } = require('../failopen.js');

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
        link = false;   // no hard links here: an existence check plus a rename, from this n on
      }
      if (linked) {
        try { fs.unlinkSync(file); return { ok: true, to: to }; }
        catch (e) {
          // two names for the bytes and the original could not be dropped: undo the link, so nothing moved
          try { fs.unlinkSync(to); } catch (u) { failNote('persist.quarantine.undo', u); }
          return { ok: false, error: e };
        }
      }
    }
    if (taken(fs, to)) continue;
    try { fs.renameSync(file, to); return { ok: true, to: to }; }
    catch (e) { return isAbsentError(e) ? { ok: false, absent: true, error: e } : { ok: false, error: e }; }
  }
  return noFreeName(file, label);
}

// one exclusive copy attempt: true | 'taken' | { ok: false, ... }
function copyExclusive(fs, from, to) {
  if (typeof fs.copyFileSync === 'function') {
    const EXCL = (fs.constants && fs.constants.COPYFILE_EXCL) || 1;
    try { fs.copyFileSync(from, to, EXCL); return true; }
    catch (e) {
      if (e && e.code === 'EEXIST') return 'taken';
      if (isAbsentError(e) && !taken(fs, from)) return { ok: false, absent: true, error: e };
      // EXCL proves the destination did not exist before this call: whatever is there now is this copy's partial file
      if (typeof fs.unlinkSync === 'function') {
        try { fs.unlinkSync(to); } catch (u) { if (!isAbsentError(u)) failNote('persist.preserve.partial', u); }
      }
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

module.exports = { moveAside, preserve, taken };
