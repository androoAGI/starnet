/* sidecar/backupfile.js — #134: a STATION BACKUP the desktop app can say WHERE it saved.

   A WebView `<a download>` lands wherever the shell's download handler puts it (macOS: ~/Downloads, silently), and
   the page is never told — so "✓ exported" was a claim about a file nobody could find. On the desktop the sidecar
   is on the same machine, so it writes the file itself into a folder it can NAME (the Commander's Downloads folder,
   the same one sidecar/browser-view.js hands their browser downloads to; home when there is none), reads it back
   as proof, and returns the exact path for the line to show.

   Never clobbers: an existing backup of the same day keeps its bytes and the new one gets "-2", "-3", ….
   Never takes a path from the caller: the folder is derived here from the home dir. No clock reads: `now` is
   injected by the composition root (lint-determinism). The envelope itself (and its secret redaction) is
   configexport.js's job — this module only lands the finished text on disk. */
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_SUFFIX = 99;

// the file name of a station backup made on the given day (the same name the page hands a browser download)
function stationBackupBase(now) {
  return 'starnet-station-' + new Date(Number(now)).toISOString().slice(0, 10);
}

// Downloads when it is a real folder, else the home dir itself (a minimal Linux account has no Downloads)
function defaultExportDir(home, fsImpl) {
  const f = fsImpl || fs;
  const root = String(home || '.');
  const dl = path.join(root, 'Downloads');
  try { return f.statSync(dl).isDirectory() ? dl : root; } catch (e) { return root; }   // not there / unreadable: home
}

function describeWriteError(e, dir) {
  const code = e && e.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'the folder ' + dir + ' is not there';
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied for ' + dir;
  if (code === 'ENOSPC') return 'the disk holding ' + dir + ' is full';
  if (code === 'EROFS') return dir + ' is read-only';
  return 'could not write into ' + dir + ' (' + (code || (e && e.message) || 'unknown error') + ')';
}

// Only the descriptor obtained by this call proves creation. A failed exclusive open
// owns nothing. Keep the descriptor until cleanup/readback so a replaced name cannot
// recycle its inode and be mistaken for the file we created.
function dropPartial(f, full, owned) {
  if (!owned) return false;
  try {
    const current = f.lstatSync(full);
    if (!current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) return false;
    f.unlinkSync(full); return true;
  } catch (e) { return !!(e && e.code === 'ENOENT'); }
}

/* Write `text` as <dir>/<base>.json (or <base>-N.json when taken). Exclusive create, then a read-back: ok only
   when the bytes on disk are exactly the bytes exported. -> { ok, path, file, dir, bytes } | { ok:false, error, dir } */
function saveExportFile(text, opts) {
  const o = opts || {};
  const f = o.fs || fs;
  const dir = String(o.dir || '');
  const base = String(o.base || 'starnet-station');
  const body = String(text == null ? '' : text);
  if (!dir) return { ok: false, error: 'no folder to save into', dir };
  for (let i = 1; i <= MAX_SUFFIX; i++) {
    const file = base + (i === 1 ? '' : '-' + i) + '.json';
    const full = path.join(dir, file);
    let fd;
    try { fd = f.openSync(full, 'wx'); }
    catch (e) {
      if (e && e.code === 'EEXIST') continue;
      return { ok: false, error: describeWriteError(e, dir), dir };
    }
    let owned = null, error = null;
    try {
      owned = f.fstatSync(fd);
      f.writeFileSync(fd, body, { encoding: 'utf8' });
      const back = f.readFileSync(full, 'utf8');
      const current = f.lstatSync(full);
      if (back !== body || !current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) {
        error = 'the file written to ' + dir + ' did not read back intact';
      }
    } catch (e) { error = describeWriteError(e, dir); }
    const cleaned = error ? dropPartial(f, full, owned) : true;
    try { f.closeSync(fd); } catch (e) { error = error || describeWriteError(e, dir); }
    if (error) {
      return { ok: false, error: error + (cleaned ? '' : '; cleanup could not be confirmed at ' + full), dir };
    }
    return { ok: true, path: full, file, dir, bytes: Buffer.byteLength(body, 'utf8') };
  }
  return { ok: false, error: 'too many station backups from that day already in ' + dir, dir };
}

// the desktop EXPORT STATION: today's name, in the Commander's Downloads (or home)
function saveStationExport(text, opts) {
  const o = opts || {};
  const dir = defaultExportDir(o.home, o.fs);
  return saveExportFile(text, { dir, base: stationBackupBase(o.now), fs: o.fs });
}

module.exports = { stationBackupBase, defaultExportDir, saveExportFile, saveStationExport, describeWriteError };
