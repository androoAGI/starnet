/* sidecar/tools/builtin/browser-orphans.js — find and end ONLY the station's own orphaned Chromium (#61).

   THE FAILURE (v0.12.5, Windows, during an Etsy research run): the station-owned Chrome on
   workspaces/.browser-profile outlived the sidecar that started it (a crash, a guardian respawn, START FRESH and
   RESTART all end the sidecar with TerminateProcess, which no handler can see). The orphan kept its DevTools port
   and kept pointing at a network proxy that had died with its parent — so every page it loaded failed — and it
   still held the profile, so every new launch handed off to it and "exited before CDP ownership". The agent had
   no supported way out: a shell kill was (rightly) refused, and nothing in StarNet would end it.

   THE RULES THIS MODULE KEEPS:
     · Identity is the --user-data-dir on the command line, compared EXACTLY (normalized), never a prefix and never
       the executable name: the Commander's own Chrome/Edge — same binary, other profile — can never match.
     · A process on that profile that descends from THIS sidecar (the browser it launched, and its helpers) is
       ours and alive: never touched here. Only processes whose ancestry does not reach this sidecar are orphans.
     · Kills are CONFIRMED by listing again. A survivor is reported, never assumed gone.
     · Profile locks are removed only once no process at all runs on the profile.
     · A failed/timed-out process listing kills nothing and says so.

   Pure where it matters: the process lister, killer, clock and fs are injected, so the tests drive a fake process
   table and a fake profile directory. makeProcessLister/makeKiller build the real ones. */
'use strict';

const P = require('node:path');
const { note: failNote } = require('../../failopen.js');

// The files a running Chromium leaves in its user-data-dir to claim it. SingletonLock/Socket/Cookie are POSIX
// symlinks naming the owner; `lockfile` is the Windows equivalent; DevToolsActivePort names a debugging port
// that, once the owner is gone, points at nothing (or worse, at a stranger who reused it).
const LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile', 'DevToolsActivePort'];

/* The --user-data-dir value from a raw command line. Handles every shape Node's spawn and the OS produce:
   `--user-data-dir=C:\x y\p` inside a quoted argument ("--user-data-dir=C:\x y\p"), a quoted value
   (--user-data-dir="C:\x y\p"), and an unquoted POSIX path (stops at the next ` --` flag). */
function profileArg(cmdline) {
  const s = String(cmdline || '');
  const m = /--user-data-dir=("([^"]*)"|'([^']*)'|(.*?))(?="|\s+--|\s+[a-z]+:|\s*$)/i.exec(s);
  if (!m) return null;
  const v = m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);
  return v ? v.trim() : null;
}

function normDir(dir, platform) {
  let s = String(dir || '').trim().replace(/\\/g, '/').replace(/^\/\/\?\//, '').replace(/\/+$/, '');
  if ((platform || process.platform) === 'win32' || (platform || process.platform) === 'darwin') s = s.toLowerCase();
  return s;
}
function sameDir(a, b, platform) { const x = normDir(a, platform); return !!x && x === normDir(b, platform); }

/* Every process whose --user-data-dir IS this profile. `browser` marks the browser process itself (Chromium's
   helpers carry --type=renderer/gpu-process/utility/crashpad-handler…). */
function profileProcesses(rows, profileDir, platform) {
  return (Array.isArray(rows) ? rows : [])
    .filter(r => r && Number(r.pid) > 0 && sameDir(profileArg(r.cmd), profileDir, platform))
    .map(r => ({ pid: Number(r.pid), ppid: Number(r.ppid) || 0, cmd: String(r.cmd || ''), browser: !/\s--type=/.test(' ' + String(r.cmd || '')) }));
}

/* Split the profile's processes into OURS (descended from selfPid through the full process table) and ORPHANS
   (everything else). The walk uses the WHOLE table, not only the profile rows, so a browser started through an
   intermediate process of ours still counts as ours. A ppid cycle or a very deep chain stops the walk (not ours). */
function classify(rows, profileDir, opts) {
  opts = opts || {};
  const selfPid = Number(opts.selfPid) || process.pid;
  const parentOf = new Map();
  for (const r of (Array.isArray(rows) ? rows : [])) if (r && Number(r.pid) > 0) parentOf.set(Number(r.pid), Number(r.ppid) || 0);
  function descendsFromSelf(pid) {
    let cur = pid;
    for (let hops = 0; hops < 64; hops++) {
      const parent = parentOf.get(cur);
      if (!parent) return false;
      if (parent === selfPid) return true;
      if (parent === cur) return false;
      cur = parent;
    }
    return false;
  }
  const procs = profileProcesses(rows, profileDir, opts.platform);
  const ours = [], orphans = [];
  for (const p of procs) (descendsFromSelf(p.pid) ? ours : orphans).push(p);
  return { procs, ours, orphans };
}

function defaultExecFile() {
  return require('../../child-env.js').guardChildProcess(require('node:child_process')).execFile;
}

/* The real process table: [{ pid, ppid, cmd }]. Windows asks CIM only for processes that carry a user-data-dir
   (cheap, and it is the only population this module may act on). POSIX lists everything with ps. Rejects on a
   failed/timed-out query — the caller then kills nothing. */
function makeProcessLister(o) {
  o = o || {};
  const platform = o.platform || process.platform;
  const execFile = o.execFile || defaultExecFile();
  const timeout = o.timeoutMs || 15000;
  if (platform === 'win32') {
    const script = "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%user-data-dir%'\" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; cmd = $_.CommandLine } } | ConvertTo-Json -Compress";
    const exe = process.env.SystemRoot ? P.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
    return () => new Promise((resolve, reject) => {
      execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        try {
          const text = String(stdout || '').trim();
          let rows = text ? JSON.parse(text) : [];
          if (!Array.isArray(rows)) rows = [rows];
          resolve(rows.map(r => ({ pid: Number(r && r.pid), ppid: Number(r && r.ppid) || 0, cmd: String((r && r.cmd) || '') })));
        } catch (e) { reject(e); }
      });
    });
  }
  return () => new Promise((resolve, reject) => {
    execFile('ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const rows = [];
      for (const line of String(stdout || '').split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
      }
      resolve(rows);
    });
  });
}

function makeKiller(o) {
  o = o || {};
  const platform = o.platform || process.platform;
  const execFile = o.execFile || defaultExecFile();
  if (platform === 'win32') {
    return pid => new Promise(resolve => {
      execFile('taskkill', ['/T', '/F', '/PID', String(Number(pid))], { windowsHide: true, timeout: 10000 }, () => resolve());
    });
  }
  return pid => { try { process.kill(Number(pid), 'SIGKILL'); } catch (e) { failNote('browser.orphans.kill', e); } return Promise.resolve(); };
}

/* Remove the profile's lock files. Only call when NO process runs on the profile (sweep() enforces it). lstat +
   unlink, so a SingletonLock symlink is removed itself and its (dangling) target is never followed. */
function clearStaleLocks(profileDir, fs) {
  fs = fs || require('node:fs');
  const removed = [], failed = [];
  for (const name of LOCK_FILES) {
    const file = P.join(String(profileDir || ''), name);
    let present = false;
    try { fs.lstatSync(file); present = true; } catch (_) { present = false; }
    if (!present) continue;
    try { fs.unlinkSync(file); removed.push(name); }
    catch (e) { failed.push({ name, error: String((e && e.code) || (e && e.message) || e) }); }
  }
  return { removed, failed };
}

/* Is anything holding this profile? Cheap file checks only (no process listing) so a launch can skip the sweep
   when the profile is plainly free: Windows `lockfile` that cannot be deleted, or a POSIX SingletonLock whose
   owner pid (same host) is alive. Returns { held, how }. */
function profileHeld(profileDir, o) {
  o = o || {};
  const fs = o.fs || require('node:fs');
  const platform = o.platform || process.platform;
  if (platform === 'win32') {
    const lock = P.join(String(profileDir || ''), 'lockfile');
    try { fs.lstatSync(lock); } catch (_) { return { held: false, how: 'no lockfile' }; }
    // A running Chromium keeps `lockfile` open without delete sharing: unlinking a free one is harmless (Chrome
    // recreates it), and EBUSY/EPERM is the proof that a process still holds the profile.
    try { fs.unlinkSync(lock); return { held: false, how: 'stale lockfile removed' }; }
    catch (e) { return /^(EBUSY|EPERM|EACCES)$/.test(String((e && e.code) || '')) ? { held: true, how: 'lockfile in use' } : { held: false, how: 'lockfile unreadable' }; }
  }
  let target;
  try { target = String((o.readlink || fs.readlinkSync)(P.join(String(profileDir || ''), 'SingletonLock'))); } catch (_) { return { held: false, how: 'no SingletonLock' }; }
  const m = /^(.*)-(\d+)$/.exec(target);
  if (!m) return { held: false, how: 'unrecognised SingletonLock' };
  if (m[1] !== (o.hostname || require('node:os').hostname())) return { held: false, how: 'lock from another host' };
  try { (o.alive || (p => process.kill(p, 0)))(Number(m[2])); return { held: true, how: 'SingletonLock owner pid ' + m[2] + ' alive' }; }
  catch (_) { return { held: false, how: 'SingletonLock owner gone' }; }
}

/* THE SWEEP. List → end every ORPHAN on this profile (browser roots first; helpers die with them) → list again to
   confirm → clear the locks if nothing at all remains on the profile. Never touches a process descended from this
   sidecar. Returns a receipt the caller can show verbatim:
     { ok, listed, found, killed:[pid], survivors:[pid], ours:[pid], locks:{removed,failed}, error }
   ok means: no orphan remains on the profile (it may still be held by a live browser of OURS — `ours`). */
async function sweep(o) {
  o = o || {};
  const profileDir = String(o.profileDir || '');
  const platform = o.platform || process.platform;
  const selfPid = Number(o.selfPid) || process.pid;
  const list = o.listProcesses || makeProcessLister({ platform, execFile: o.execFile });
  const kill = o.kill || makeKiller({ platform, execFile: o.execFile });
  const wait = o.sleep || (ms => new Promise(r => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); }));
  const receipt = { ok: false, listed: false, found: 0, killed: [], survivors: [], ours: [], locks: { removed: [], failed: [] }, error: null };
  if (!profileDir) { receipt.error = 'no profile directory'; return receipt; }
  let before;
  try { before = classify(await list(), profileDir, { selfPid, platform }); receipt.listed = true; }
  catch (e) { receipt.error = 'could not list processes: ' + String((e && e.message) || e); return receipt; }
  receipt.found = before.orphans.length;
  receipt.ours = before.ours.map(p => p.pid);
  const roots = before.orphans.filter(p => p.browser).concat(before.orphans.filter(p => !p.browser));
  for (const p of roots) {
    try { await kill(p.pid); } catch (e) { failNote('browser.orphans.kill', e); /* confirmed below */ }
  }
  let after = before;
  if (roots.length) {
    const attempts = Number(o.confirmAttempts) > 0 ? Number(o.confirmAttempts) : 6;
    for (let i = 0; i < attempts; i++) {
      await wait(i === 0 ? 300 : 500);
      try { after = classify(await list(), profileDir, { selfPid, platform }); }
      catch (e) { receipt.error = 'could not confirm the browser ended: ' + String((e && e.message) || e); return receipt; }
      const left = new Set(after.orphans.map(p => p.pid));
      if (!roots.some(p => left.has(p.pid))) break;
    }
    const left = new Set(after.orphans.map(p => p.pid));
    receipt.killed = roots.filter(p => !left.has(p.pid)).map(p => p.pid);
    receipt.survivors = after.orphans.map(p => p.pid);
  }
  receipt.ours = after.ours.map(p => p.pid);
  if (!after.procs.length) receipt.locks = clearStaleLocks(profileDir, o.fs);
  receipt.ok = receipt.survivors.length === 0;
  return receipt;
}

/* One line for an agent or a panel: what actually happened, nothing more. */
function describeSweep(r) {
  if (!r) return 'no sweep ran';
  if (r.error) return 'nothing was ended: ' + r.error;
  const bits = [];
  bits.push(r.found ? ('ended ' + r.killed.length + ' of ' + r.found + ' orphaned station-browser process' + (r.found === 1 ? '' : 'es')) : 'no orphaned station browser was running');
  if (r.survivors.length) bits.push(r.survivors.length + ' still running (pid ' + r.survivors.join(', ') + ')');
  if (r.locks && r.locks.removed.length) bits.push('cleared stale profile lock' + (r.locks.removed.length === 1 ? '' : 's') + ' (' + r.locks.removed.join(', ') + ')');
  if (r.locks && r.locks.failed.length) bits.push('could not clear ' + r.locks.failed.map(f => f.name).join(', '));
  return bits.join('; ');
}

module.exports = { LOCK_FILES, profileArg, sameDir, normDir, profileProcesses, classify, makeProcessLister, makeKiller, clearStaleLocks, profileHeld, sweep, describeSweep };
