/* sidecar/proctree.js — OS process-table snapshot + OWNED-descendant walk (h2 process supervision, 2026-09-22).

   Why this exists. Two process-lifecycle claims used to rest on nothing:
     1. The boot sweep (procledger.js) recorded only a background command's cmd.exe WRAPPER. When the sidecar is
        force-killed, that wrapper dies with it (its stdin pipe breaks) while the command it launched — the dev
        server, the watcher — keeps running with ParentProcessId pointing at the dead wrapper. The sweep saw the
        wrapper gone, counted it "gone", and never looked at the survivors.
     2. shell.bg.kill answered {ok:true} the instant taskkill was LAUNCHED — before it ran, whether or not it worked.

   Both need the same two primitives: a bounded, fail-safe snapshot of the process table, and a walk that returns
   only processes provably descended from a process WE started.

   THE IDENTITY RULE (what makes a walk safe to kill from). Windows keeps ParentProcessId on an orphan, but a PID is
   reused once its process object is gone, so "ppid == our dead wrapper's pid" alone can name a stranger. A process
   C is counted as a child of our recorded root R only when
       C.ppid == R.pid  AND  floor <= C.created <= ceiling
   where floor = R's creation time (a child is never older than its parent) and ceiling = the last moment R was
   PROVABLY still holding its PID (our live spawn handle, or an exact identity probe, observed it then). Between
   those two instants no other process could own R.pid, so any process whose parent was R.pid and that was created
   in that window is R's child — even if R is dead now. Deeper levels hang off LIVE nodes: a live node holds its PID,
   so a process with ppid == node.pid created at/after node.created is its child. Anything outside the window is left
   alone, and a missing/unknown creation time is never guessed at.

   FAIL SAFE. The snapshot runs with a hard timeout; any failure (timeout, CIM denied, unparsable output, or a table
   that does not even contain THIS process — the canary) REJECTS. Callers must treat a rejection as "unknown" and
   kill nothing on its basis.

     makeWin32ProcessTable(execFile, { timeoutMs?, selfPid?, exe? }) -> () => Promise<[{ pid, ppid, created }]>
     ownedTree(rows, { pid, floor, ceiling?, protect? }) -> [{ pid, ppid, created }]   (descendants, root excluded)
     survivorsOf(rows, targets) -> [{ pid, ppid, created }]   targets still present with the SAME creation time
     confirmGone({ snapshot, targets, attempts?, pollMs?, sleep? }) -> Promise<{ gone, unknown, survivors, error? }> */
'use strict';

const MAX_TREE = 512;   // a runaway fork tree must not turn one walk into an unbounded kill list

// One CIM pass over every process: pid, parent pid, creation time in epoch ms (the same conversion procledger.js
// uses to pin identity, so a pinned `created` and a table `created` compare exactly). A process without a
// CreationDate (Idle/System) reports 0 and is never matched.
const WIN_TABLE_SCRIPT = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | ForEach-Object { $c = 0; "
  + "if ($_.CreationDate) { $c = [int64]([datetimeoffset]$_.CreationDate).ToUnixTimeMilliseconds() }; "
  + "[pscustomobject]@{ p = [int64]$_.ProcessId; q = [int64]$_.ParentProcessId; c = $c } } | ConvertTo-Json -Compress";

function parseTable(text) {
  let raw = JSON.parse(String(text == null ? '' : text).trim() || '[]');
  if (!Array.isArray(raw)) raw = [raw];
  const rows = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const pid = Number(r.p), ppid = Number(r.q), created = Number(r.c);
    if (!(pid > 0)) continue;
    rows.push({ pid, ppid: ppid > 0 ? ppid : 0, created: created > 0 ? created : 0 });
  }
  if (!rows.length) throw new Error('process table query returned no rows');
  return rows;
}

// one snapshot is bounded by this (callers size their own budgets from it — see shellbg.killBudgetMs)
const DEFAULT_TABLE_TIMEOUT_MS = 15000;

function makePosixProcessTable(execFile, opts) {
  opts = opts || {};
  if (typeof execFile !== 'function') throw new Error('makePosixProcessTable requires execFile');
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TABLE_TIMEOUT_MS;
  const selfPid = opts.selfPid != null ? Number(opts.selfPid) : ((typeof process !== 'undefined' && Number(process.pid)) || 0);
  return function snapshot() {
    return new Promise((resolve, reject) => {
      const done = (err, stdout) => {
        if (err) return reject(new Error('process table query failed: ' + String((err && err.message) || err).slice(0, 300)));
        const rows = [];
        for (const line of String(stdout || '').split('\n')) {
          const m = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(line);
          if (m) {
            const pid = Number(m[1]), ppid = Number(m[2]), created = Date.parse(m[3]);
            if (pid > 0) rows.push({ pid, ppid: ppid > 0 ? ppid : 0, created: Number.isNaN(created) ? 0 : created });
          }
        }
        if (!rows.length) return reject(new Error('process table query returned no rows'));
        if (selfPid > 0 && !rows.some(r => r.pid === selfPid)) return reject(new Error('process table has no row for this process — refusing to trust it'));
        resolve(rows);
      };
      try {
        execFile('ps', ['-A', '-o', 'pid=,ppid=,lstart='],
          { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, done);
      } catch (e) { reject(e); }
    });
  };
}

function makeWin32ProcessTable(execFile, opts) {
  opts = opts || {};
  if (typeof execFile !== 'function') throw new Error('makeWin32ProcessTable requires execFile');
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TABLE_TIMEOUT_MS;
  const selfPid = opts.selfPid != null ? Number(opts.selfPid) : ((typeof process !== 'undefined' && Number(process.pid)) || 0);
  const exe = opts.exe || ((typeof process !== 'undefined' && process.env && process.env.SystemRoot)
    ? process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : 'powershell.exe');
  return function snapshot() {
    return new Promise((resolve, reject) => {
      const done = (err, stdout) => {
        if (err) return reject(new Error('process table query failed: ' + String((err && err.message) || err).slice(0, 300)));
        let rows;
        try { rows = parseTable(stdout); } catch (e) { return reject(new Error('process table unreadable: ' + ((e && e.message) || e))); }
        // THE CANARY: a healthy table always contains the process that asked. Without it, an empty or partial
        // answer would read as "everything is dead" — the one conclusion a reaper must never draw from bad data.
        if (selfPid > 0 && !rows.some(r => r.pid === selfPid)) return reject(new Error('process table has no row for this process — refusing to trust it'));
        resolve(rows);
      };
      try {
        execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', WIN_TABLE_SCRIPT],
          { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, done);
      } catch (e) { reject(e); }
    });
  };
}

function ownedTree(rows, spec) {
  spec = spec || {};
  const pid = Number(spec.pid);
  const floor = Number(spec.floor);
  const ceiling = (spec.ceiling == null) ? Infinity : Number(spec.ceiling);
  if (!(pid > 0) || !(floor > 0) || !(ceiling >= floor) || !Array.isArray(rows)) return [];
  const protect = new Set((spec.protect || []).map(Number).filter(n => n > 0));
  const kids = new Map();
  for (const r of rows) {
    if (!r || !(r.pid > 0)) continue;
    const a = kids.get(r.ppid);
    if (a) a.push(r); else kids.set(r.ppid, [r]);
  }
  const out = [], seen = new Set([pid]), queue = [];
  const take = (c) => { seen.add(c.pid); out.push(c); queue.push(c); };
  for (const c of (kids.get(pid) || [])) {
    if (seen.has(c.pid) || protect.has(c.pid) || !(c.created > 0)) continue;
    if (c.created < floor || c.created > ceiling) continue;   // outside the window R provably held its PID
    take(c);
  }
  while (queue.length && out.length < MAX_TREE) {
    const n = queue.shift();
    for (const c of (kids.get(n.pid) || [])) {
      if (out.length >= MAX_TREE) break;
      if (seen.has(c.pid) || protect.has(c.pid) || !(c.created > 0)) continue;
      if (c.created < n.created) continue;   // older than the live parent -> a previous holder's child, not ours
      take(c);
    }
  }
  return out;
}

// Targets still present with the SAME creation time (a recycled PID is a different process and is not a survivor),
// plus anything a survivor spawned since the target list was taken.
function survivorsOf(rows, targets) {
  const want = new Map();
  for (const t of (targets || [])) if (t && Number(t.pid) > 0 && Number(t.created) > 0) want.set(Number(t.pid), Number(t.created));
  const out = [], seen = new Set();
  for (const r of (rows || [])) {
    if (want.has(r.pid) && want.get(r.pid) === r.created && !seen.has(r.pid)) { seen.add(r.pid); out.push(r); }
  }
  for (const s of out.slice()) {
    for (const d of ownedTree(rows, { pid: s.pid, floor: s.created })) if (!seen.has(d.pid)) { seen.add(d.pid); out.push(d); }
  }
  return out;
}

const defaultSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Bounded confirmation poll: re-snapshot until none of the targets is alive or the attempts run out. A snapshot
// failure returns unknown:true — the caller reports "unverified", never "gone".
async function confirmGone(o) {
  o = o || {};
  const attempts = Math.max(1, Number(o.attempts) || 16);
  const pollMs = o.pollMs == null ? 250 : Math.max(0, Number(o.pollMs) || 0);
  const sleep = typeof o.sleep === 'function' ? o.sleep : defaultSleep;
  let survivors = [];
  for (let i = 0; i < attempts; i++) {
    let rows;
    try { rows = await o.snapshot(); }
    catch (e) { return { gone: false, unknown: true, survivors: survivors, error: String((e && e.message) || e) }; }
    survivors = survivorsOf(rows, o.targets);
    if (!survivors.length) return { gone: true, unknown: false, survivors: [] };
    if (i < attempts - 1 && pollMs > 0) await sleep(pollMs);
  }
  return { gone: false, unknown: false, survivors: survivors };
}

module.exports = { makeWin32ProcessTable, makePosixProcessTable, ownedTree, survivorsOf, confirmGone, DEFAULT_TABLE_TIMEOUT_MS, _internals: { parseTable, WIN_TABLE_SCRIPT, MAX_TREE } };
