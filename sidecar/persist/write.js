/* sidecar/persist/write.js — writeAtomic: the ONE crash-safe "replace a small file atomically AND durably" primitive.
   (Moved here from durable-write.js, which re-exports it as writeFileDurable; every importer is unchanged.)

   The store-of-record problem (G4.2): a plain temp-write -> rename is ATOMIC (a reader never sees a half-written file)
   but NOT DURABLE: on a hard crash or power loss between the write and the OS flushing it, the rename can be lost OR
   the file can land zero-length. For the cron jobs file that means a routine whose nextRunAt was just
   ADVANCED-BEFORE-RUN reverts to its old due time on restart and DOUBLE-FIRES. So the temp file's bytes are fsynced
   BEFORE the rename (on disk before the directory entry flips), then the containing DIRECTORY is fsynced after the
   rename, best effort (so the rename itself is durable on POSIX).

   writeAtomic({ fs, path, randomTmpId?, mode?, pid? }, file, data) -> void   (throws on a real write/rename failure)
     fs   : an fs facade. The DURABLE path needs openSync/writeSync/fsyncSync/closeSync/renameSync; an fs without
            fsyncSync (an in-memory test fs) degrades to writeFileSync -> renameSync (still atomic, not power-loss durable).
     path : node:path (dirname/basename/join), for the directory fsync and the temp sweeper.
     randomTmpId : optional () -> string nonce; defaults to crypto.randomBytes hex. With the pid, two concurrent writers
            (or two writes by this process) never collide on one temp: <file>.<pid>.<nonce>.tmp.
     mode : the new file's mode; defaults to 0o600 (owner read/write). Every caller is a private sidecar store and several
            hold credentials (codex/grok/kimi tokens, channels/secrets.json, connectors/servicekeys.json, the connector
            vault without an OS key). Without it the temp took 0o666 & ~umask (typically 0644, readable by every local
            user on Linux/macOS) and the rename carried that onto the store. Windows honours only the read-only bit.
     pid  : the writer's pid stamped into the temp name; defaults to process.pid (a test stands in for another process).

   NO TEMP IS EVER LEFT BY A FAILED WRITE (bug 75558694): any failure after the temp exists (a short write, a failed
   fsync, a rename refused by a lock) unlinks the temp before the error is rethrown. A temp that cannot be unlinked is
   noted (failNote 'persist.temp'), never silent, and the sweeper below removes it later.

   THE TEMP SWEEPER (a crash leaves a temp no failure path can remove): after a successful write, once per target per
   process, the target's own temps go when
     - an own-grammar temp's pid is dead (process.kill(pid, 0); EPERM counts as alive, as update-preparation does), or
     - a legacy temp (<file>.<n>.tmp, <file>.tmp-<pid>-<now>-<seq>, <file>.repair-<hex>) has an mtime more than
       STALE_MS older than the file just written: the filesystem's own clock, never this process's (lint-determinism).
   One readdir per directory per process (only temp-shaped names are kept from it). Capability-guarded: a facade without
   readdirSync, lstatSync/statSync or unlinkSync is never swept. It never touches another file's temps (the .bak's
   included), any live writer's temp regardless of age, a .bak or a forensic copy. Failures are noted, never thrown.

   Determinism: pure injected I/O. No ambient clock and no rng of its own: the nonce comes from an injected
   randomTmpId, defaulting to node:crypto through a lazy require. */
'use strict';

const names = require('./names.js');
const { note: failNote } = require('../failopen.js');

const STALE_MS = 10 * 60 * 1000;

let swept = new Set();             // targets already swept in this process
let dirTemps = new Map();          // directory -> temp-shaped names from its one readdir (consumed per target)
let dirSyncUnsupported = new WeakSet();   // fs facades whose directory fsync failed EPERM/EISDIR once (Windows)

function defaultNonce() {
  // lazy + guarded: never let nonce minting throw, and never read the ambient clock/rng banned by the lint.
  try { return require('node:crypto').randomBytes(6).toString('hex'); }
  catch (_) { try { return require('crypto').randomBytes(6).toString('hex'); } catch (__) { return 'x'; } }
}

function removeTemp(fs, tmp) {
  if (typeof fs.unlinkSync !== 'function') return;   // a facade that cannot unlink keeps what it wrote
  try { fs.unlinkSync(tmp); }
  catch (e) { if (!e || e.code !== 'ENOENT') failNote('persist.temp', e); }
}

function closeFd(fs, fd) {
  try { fs.closeSync(fd); } catch (e) { failNote('persist.close', e); }
}

// best-effort POSIX directory fsync so the RENAME itself is durable. Windows cannot fsync a directory (EPERM; some
// builds refuse the open with EISDIR): there the temp fsync + atomic rename are the durability, and the refusal is
// remembered per fs so the process stops paying an open and a failed fsync on every write.
// strict is for a forensic copy whose source is about to be removed: unknown flush failures must keep that source.
function syncDir(fs, pathMod, file, strict) {
  if (!pathMod || typeof pathMod.dirname !== 'function' || dirSyncUnsupported.has(fs)) return;
  let dfd = null;
  try {
    dfd = fs.openSync(pathMod.dirname(file), 'r');
    fs.fsyncSync(dfd);
  } catch (e) {
    const code = e && e.code;
    if (code === 'EPERM' || code === 'EISDIR') dirSyncUnsupported.add(fs);
    else if (strict) throw e;
    else if (code !== 'ENOENT' && code !== 'ENOTDIR') failNote('persist.dirsync', e);   // a facade with no directories
  } finally {
    if (dfd != null) closeFd(fs, dfd);
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;   // not a pid we can ask about: only staleness may remove it
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }   // EPERM: alive, owned by someone else
}

function mtimeOf(fs, p) {
  const st = typeof fs.lstatSync === 'function' ? fs.lstatSync(p) : fs.statSync(p);
  return Number(st && st.mtimeMs);
}

/* sweep({ fs, path }, file) — remove the dead or stale temps of exactly `file` (see THE TEMP SWEEPER above). Runs once
   per file per process; returns the temps it removed. writeAtomic calls it after every successful write. */
function sweep(deps, file) {
  const fs = deps && deps.fs;
  const pathMod = deps && deps.path;
  const target = String(file);
  if (!fs || swept.has(target)) return [];
  // capability guard: an fs facade without a directory listing, a stat or an unlink is never swept (nor marked)
  if (!pathMod || typeof pathMod.dirname !== 'function' || typeof pathMod.basename !== 'function' || typeof pathMod.join !== 'function') return [];
  if (typeof fs.readdirSync !== 'function' || typeof fs.unlinkSync !== 'function') return [];
  if (typeof fs.lstatSync !== 'function' && typeof fs.statSync !== 'function') return [];
  swept.add(target);   // once per target per process, whatever the sweep below finds or fails at
  const dir = pathMod.dirname(target);
  const base = pathMod.basename(target);
  let temps = dirTemps.get(dir);
  if (!temps) {
    try { temps = fs.readdirSync(dir).map(String).filter(n => names.TEMP_SHAPE.test(n)); }
    catch (e) { failNote('persist.sweep.readdir', e); temps = []; }
    dirTemps.set(dir, temps);
  }
  const mine = temps.filter(n => names.isTempOf(base, n));
  if (!mine.length) return [];
  dirTemps.set(dir, temps.filter(n => mine.indexOf(n) < 0));   // consumed: this target is never swept again here
  let fileMtime = NaN;
  try { fileMtime = mtimeOf(fs, target); } catch (e) { failNote('persist.sweep.stat', e); }
  const removed = [];
  for (const name of mine) {
    const p = pathMod.join(dir, name);
    const t = names.tempOf(base, name);
    // An old mtime does not prove a writer died: a paused process may still finish this temp. Own-grammar temps
    // have a PID, so liveness wins over age; the time fallback is only for legacy names without a usable owner.
    if (t && t.kind === 'own' && pidAlive(t.pid)) continue;
    let gone = !!(t && t.kind === 'own');
    if (!gone) {
      let tmpMtime = NaN;
      try { tmpMtime = mtimeOf(fs, p); }
      catch (e) { if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) failNote('persist.sweep.stat', e); }
      gone = Number.isFinite(tmpMtime) && Number.isFinite(fileMtime) && tmpMtime < fileMtime - STALE_MS;
    }
    if (!gone) continue;
    try { fs.unlinkSync(p); removed.push(p); }
    catch (e) { if (!e || e.code !== 'ENOENT') failNote('persist.sweep.unlink', e); }
  }
  return removed;
}

function writeAtomic(deps, file, data) {
  const d = deps || {};
  const fs = d.fs;
  const pathMod = d.path;
  if (!fs || typeof fs.renameSync !== 'function') throw new Error('writeFileDurable: an injected fs with renameSync is required');
  const nonce = (typeof d.randomTmpId === 'function' ? d.randomTmpId() : defaultNonce());
  const pid = Number.isInteger(d.pid) && d.pid > 0 ? d.pid : process.pid;
  // per-PID + random suffix: two concurrent writers (or a CRUD save racing an advance) pick DISTINCT temp names, so
  // neither truncates the other's in-flight temp before its own rename.
  const tmp = names.tempFor(file, pid, nonce);
  const mode = Number.isInteger(d.mode) ? d.mode : 0o600;

  const canFsync = typeof fs.openSync === 'function' && typeof fs.writeSync === 'function'
    && typeof fs.fsyncSync === 'function' && typeof fs.closeSync === 'function';

  let tmpExists = false;
  try {
    if (canFsync) {
      // DURABLE: write the full bytes to the temp fd, fsync the fd (bytes hit stable storage) BEFORE the rename, then
      // close. fsync precedes rename so the rename can never expose an un-flushed / zero-length file.
      let fd = null;
      try {
        fd = fs.openSync(tmp, 'w', mode);
        tmpExists = true;
        // writeSync may make partial progress (disk pressure, interrupted/network filesystems, injected faults). A
        // single unchecked call could fsync + rename a JSON prefix as the authoritative store. Write a Buffer so offsets
        // are byte-accurate for non-ASCII data, and refuse zero/invalid progress.
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        let offset = 0;
        while (offset < bytes.length) {
          let wrote = fs.writeSync(fd, bytes, offset, bytes.length - offset);
          // A few long-standing in-memory fs facades omit writeSync's numeric return. Node's real fs always returns a
          // byte count: only null/undefined is read as a completed requested write. Numeric short writes retry or fail.
          if (wrote == null) wrote = bytes.length - offset;
          if (!Number.isInteger(wrote) || wrote <= 0 || wrote > bytes.length - offset) {
            const e = new Error('writeFileDurable: short write made no valid progress (' + wrote + '/' + (bytes.length - offset) + ' bytes)');
            e.code = 'ESHORTWRITE';
            throw e;
          }
          offset += wrote;
        }
        fs.fsyncSync(fd);                    // <-- durability barrier, strictly BEFORE the rename below
      } finally {
        if (fd != null) closeFd(fs, fd);
      }
    } else {
      // in-memory / test fs without fsync: still atomic (temp + rename), just not power-loss durable. A throwing write
      // may still have created the temp.
      tmpExists = true;
      fs.writeFileSync(tmp, data, { mode });
    }
    fs.renameSync(tmp, file);               // atomic replace of the real path (never seen half-written)
  } catch (e) {
    if (tmpExists) removeTemp(fs, tmp);
    throw e;
  }

  if (canFsync) syncDir(fs, pathMod, file);
  try { sweep(d, file); } catch (e) { failNote('persist.sweep', e); }
}

// test-only: forget every per-process memo (a fresh process). Rows that share no folder need not call it.
function _resetForTests() {
  swept = new Set();
  dirTemps = new Map();
  dirSyncUnsupported = new WeakSet();
}

module.exports = { writeAtomic, sweep, syncDir, pidAlive, STALE_MS, _resetForTests };
