/* sidecar/backupfile.js — desktop exports the app can say WHERE it saved.

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
const EXPORT_EXTENSIONS = Object.freeze(['json', 'txt', 'md']);
const MAX_EXPORT_BODY = 16 << 20;

// A caller supplies a label, never a path. Windows separators/ADS/device names and
// trailing dots are normalized even when the host is another operating system.
function exportSaveName(name, ext) {
  let base = typeof name === 'string' ? name : '';
  base = base.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '-').trim();
  if (base.toLowerCase().endsWith('.' + ext)) base = base.slice(0, -(ext.length + 1));
  base = base.replace(/^[. ]+|[. ]+$/g, '').slice(0, 100).replace(/[. ]+$/g, '');
  if (!base) base = 'starnet-export';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = 'starnet-' + base;
  return base;
}

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

/* Write `text` as <dir>/<base>.<ext> (or <base>-N.<ext> when taken). Exclusive create, then a read-back: ok only
   when the bytes on disk are exactly the bytes exported. -> { ok, path, file, dir, bytes } | { ok:false, error, dir } */
function saveExportFile(text, opts) {
  const o = opts || {};
  const f = o.fs || fs;
  const dir = String(o.dir || '');
  const ext = o.ext === undefined ? 'json' : o.ext;
  if (!EXPORT_EXTENSIONS.includes(ext)) return { ok: false, error: 'choose a json, txt or md export', dir };
  const base = exportSaveName(o.base || 'starnet-station', ext);
  const body = String(text == null ? '' : text);
  if (!dir) return { ok: false, error: 'no folder to save into', dir };
  for (let i = 1; i <= MAX_SUFFIX; i++) {
    const file = base + (i === 1 ? '' : '-' + i) + '.' + ext;
    const full = path.join(dir, file);
    let fd;
    try { fd = f.openSync(full, 'wx'); }
    catch (e) {
      if (e && e.code === 'EEXIST') continue;
      return { ok: false, error: describeWriteError(e, dir), dir };
    }
    let owned = null, error = null, readingBack = false;
    try {
      owned = f.fstatSync(fd);
      f.writeFileSync(fd, body, { encoding: 'utf8' });
      readingBack = true;
      const back = f.readFileSync(full, 'utf8');
      const current = f.lstatSync(full);
      if (back !== body || !current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) {
        error = 'the file written to ' + dir + ' did not read back intact';
      }
    } catch (e) { error = readingBack ? 'the file written to ' + dir + ' could not be read back (' + (e.code || e.message || 'unknown error') + ')' : describeWriteError(e, dir); }
    const cleaned = error ? dropPartial(f, full, owned) : true;
    try { f.closeSync(fd); } catch (e) { error = error || describeWriteError(e, dir); }
    if (error) {
      return { ok: false, error: error + (cleaned ? '' : '; cleanup could not be confirmed at ' + full), dir };
    }
    return { ok: true, path: full, file, dir, bytes: Buffer.byteLength(body, 'utf8') };
  }
  return { ok: false, error: 'too many exports with that name already in ' + dir, dir };
}

// The launch-token/origin gate belongs to the existing host router. This handler
// only accepts text plus a label/allowed extension and derives the destination.
function makeExportSaveHandler(o) {
  return async function handleExportSave(req, res) {
    let body;
    try { body = JSON.parse(await o.readBody(req, MAX_EXPORT_BODY)); }
    catch (e) { return o.fail(res, e && e.tooLarge ? 413 : 400, e && e.tooLarge ? 'too_large' : 'bad_json', e && e.tooLarge ? 'the export request exceeds 16 MiB' : 'the export request is not valid JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.text !== 'string'
      || typeof body.name !== 'string' || !EXPORT_EXTENSIONS.includes(body.ext)) {
      return o.fail(res, 400, 'bad_request', 'an export needs text, a name and a json, txt or md extension');
    }
    const dir = defaultExportDir(o.home(), o.fs);
    const saved = saveExportFile(body.text, { dir, base: body.name, ext: body.ext, fs: o.fs });
    if (!saved.ok) return o.fail(res, 500, 'station_error', saved.error, { dir: saved.dir });
    return o.json(res, 200, saved);
  };
}

// the desktop EXPORT STATION: today's name, in the Commander's Downloads (or home)
function saveStationExport(text, opts) {
  const o = opts || {};
  const dir = defaultExportDir(o.home, o.fs);
  return saveExportFile(text, { dir, base: stationBackupBase(o.now), fs: o.fs });
}

module.exports = { stationBackupBase, defaultExportDir, saveExportFile, saveStationExport, describeWriteError,
  exportSaveName, makeExportSaveHandler, EXPORT_EXTENSIONS, MAX_EXPORT_BODY };
