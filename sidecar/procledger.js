/* sidecar/procledger.js — persistent ledger of agent-spawned OS processes (mouse-confinement incident, 2026-07-12).

   gracefulShutdown reaps children on SIGINT/SIGTERM — but a FORCE-kill (desktop shell dying, TerminateProcess,
   crash) runs no handlers, and detached/unref'd children (dev servers, CDP browsers) orphan silently. The
   2026-07-12 incident: a smoke-test Edge + vite outlived Agent OS entirely, kept playing game audio, and the
   game's cursor confinement was left stuck on the user's desktop.

   This ledger closes the gap ACROSS process death: every long-lived child is recorded to a JSON file the moment
   it spawns and released when it exits. On the NEXT sidecar boot, sweep() reads what the previous life left
   behind, re-probes each PID, and uses exact (PID, OS creation-time) identity wherever the OS probe supplies it.
   Unpinned/legacy entries fall back to command matching; a recycled PID is dropped, never killed.

   PURE deps (fs/clock/probe/kill injected) so it is headless-testable; real win32/posix probes are built from
   an injected execFile only when not supplied.

   ORPHANS OF A DEAD ROOT (h2 process supervision, 2026-09-22). A force-killed sidecar takes a background command's
   cmd.exe wrapper with it (its stdin pipe breaks), but the command the wrapper launched keeps running with its
   ParentProcessId pointing at the dead wrapper. The sweep used to see the wrapper gone and count it "gone". Every
   receipt now carries seenAt (the last instant the recording process PROVABLY still held its PID — spawn, identity
   pin, or a touch() from an owner holding the live spawn handle) and exitedAt (when its exit was observed). On
   Windows the sweep takes one bounded process-table snapshot and walks the receipt's owned tree with
   proctree.ownedTree: a child counts only if its creation time falls inside [root created, root last-held], the
   window in which no other process could have owned that PID. A failed/timed-out table query kills nothing and is
   reported (treeQueryFailed); kills are CONFIRMED by re-snapshotting, and a survivor gets an exact (pid, creation)
   receipt of its own so the next boot retries it.

     makeProcLedger({ fs, pathMod, file, clock, isWin?, execFile?, probe?, killTree?, processTable?, log? }) ->
       { record({pid,cmd,kind?,created?,pin?}), pinIdentity(pid), release(pid), touch(pids), markExited(pid, at?),
         sweep() -> Promise<summary>, list(), _internals } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).procledger = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WIN = (typeof process !== 'undefined' && process.platform) === 'win32';
  const MAX_ENTRIES = 100;
  const { makeWin32ProcessTable, ownedTree, confirmGone } = require('./proctree.js');
  const { note: trackFailNote } = require('./failopen.js');
  // An unpinned receipt's floor: startedAt is stamped just AFTER spawn returns, so the root (and a child it launched
  // at once) can be created slightly before it. Pinned receipts use the exact creation time instead.
  const START_TOLERANCE_MS = 1000;
  // A receipt whose root is gone but whose orphan check could not run (table query failed) is retried at this many
  // boots, then dropped — a host where CIM is permanently denied must not accumulate receipts forever.
  const MAX_TREE_RETRIES = 3;

  // normalize for the reuse-guard match: collapse whitespace, strip quoting, lowercase.
  function normCmd(s) { return String(s == null ? '' : s).replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  // A recycled PID must not be killed: every token of the recorded command must still appear in the live
  // command line. Token-wise (not one containment) because spawn argv reorders around what we record —
  // a shell:true child runs as `cmd.exe /d /s /c "<recorded cmd>"` (tokens stay adjacent), while a browser
  // records `exePath --user-data-dir=<unique>` whose two tokens are separated by other flags. The unique
  // token (profile dir, workspace path) is what makes PID reuse by an unrelated same-exe process not match.
  function cmdMatches(recordedCmd, liveCmdline) {
    const tokens = normCmd(recordedCmd).split(' ').filter(Boolean).slice(0, 8);
    if (!tokens.length) return false;
    const live = normCmd(liveCmdline);
    return tokens.every(t => live.indexOf(t) >= 0);
  }

  // A probe returns Map<pid, { cmd, created }> — created is the process's start time in epoch ms (null if the
  // platform can't report it). created is the SECOND half of the PID-reuse guard: even if a recycled PID's
  // command line coincidentally matches, a process created AFTER we recorded the entry is provably not ours.
  function makeWin32Probe(execFile) {
    return (pids) => new Promise((resolve, reject) => {
      if (!pids.length) return resolve(new Map());
      const filter = pids.map(p => 'ProcessId=' + Number(p)).join(' OR ');
      // CreationDate → epoch ms so the sweep can compare it to the recorded startedAt (also epoch ms).
      const script = 'Get-CimInstance Win32_Process -Filter "' + filter + '" | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId; CommandLine = $_.CommandLine; CreatedMs = [int64]([datetimeoffset]$_.CreationDate).ToUnixTimeMilliseconds() } } | ConvertTo-Json -Compress';
      const exe = process.env.SystemRoot ? process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : 'powershell.exe';
      execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000, windowsHide: true }, (err, stdout) => {
        const parse = (text, identityOnly) => {
          const out = new Map();
          let rows = JSON.parse(String(text || '').trim() || '[]');
          if (!Array.isArray(rows)) rows = [rows];
          for (const r of rows) if (r && r.ProcessId != null) out.set(Number(r.ProcessId), { cmd: String(r.CommandLine || ''), created: Number(r.CreatedMs) || null, identityOnly: !!identityOnly });
          return out;
        };
        if (err) {
          // CIM is denied on some managed Windows hosts. Get-Process still exposes an exact start time,
          // which is sufficient for PINNED receipts. Mark it identityOnly so an older unpinned receipt is
          // retained for a later richer probe rather than laundered into "reused" and forgotten.
          const ids = pids.map(Number).join(',');
          const fallback = '$ids=@(' + ids + '); Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ ProcessId=$_.Id; CommandLine=""; CreatedMs=[int64]([datetimeoffset]$_.StartTime).ToUnixTimeMilliseconds() } } | ConvertTo-Json -Compress';
          return execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', fallback], { encoding: 'utf8', timeout: 15000, windowsHide: true }, (fallbackErr, fallbackOut) => {
            if (fallbackErr) return reject(fallbackErr);
            try { resolve(parse(fallbackOut, true)); } catch (e) { reject(e); }
          });
        }
        try {
          resolve(parse(stdout, false));
        } catch (e) { reject(e); }
      });
    });
  }
  function makePosixProbe(execFile) {
    return (pids) => new Promise((resolve) => {
      if (!pids.length) return resolve(new Map());
      execFile('ps', ['-o', 'pid=,command=', '-p', pids.map(Number).join(',')], { encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
        const out = new Map();
        if (err) return resolve(out);
        for (const line of String(stdout || '').split('\n')) {
          const m = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (m) out.set(Number(m[1]), { cmd: m[2], created: null });   // posix start-time parsing is fiddly; fall back to cmd-match only
        }
        resolve(out);
      });
    });
  }
  function makeKillTree(execFile, isWin) {
    return (pid) => new Promise((resolve, reject) => {
      if (isWin) {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }, (err) => err ? reject(err) : resolve());
      } else {
        try { process.kill(-Number(pid), 'SIGKILL'); resolve(); }
        catch (_) {
          try { process.kill(Number(pid), 'SIGKILL'); resolve(); }
          catch (e) { reject(e); }
        }
      }
    });
  }

  function makeProcLedger(deps) {
    deps = deps || {};
    const fs = deps.fs;
    const P = deps.pathMod;
    const file = deps.file;
    if (!fs || !P || !file) throw new Error('procledger requires fs, pathMod, file');
    const now = (deps.clock && typeof deps.clock.now === 'function') ? deps.clock.now : () => 0;
    const isWin = (deps.isWin != null) ? deps.isWin : WIN;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const execFile = deps.execFile || ((typeof require === 'function') ? require('./child-env.js').guardChildProcess(require('node:child_process')).execFile : null);
    const probe = deps.probe || (isWin ? makeWin32Probe(execFile) : makePosixProbe(execFile));
    const killTree = deps.killTree || makeKillTree(execFile, isWin);
    /* The owned-tree walk needs the WHOLE process table (Windows). Real only in production wiring: a caller that
       injects its own probe/killTree (every unit test) gets no real table unless it injects one too, so a fake
       ledger can never read — let alone kill from — the host's real process list. */
    const processTable = (deps.processTable !== undefined)
      ? (typeof deps.processTable === 'function' ? deps.processTable : null)
      : ((deps.probe || deps.killTree || !isWin || typeof execFile !== 'function') ? null : makeWin32ProcessTable(execFile));
    const confirmOpts = deps.confirm || {};
    // never walk into (or kill) ourselves or the process that launched us
    const protectPids = Array.isArray(deps.protectPids) ? deps.protectPids.map(Number)
      : [(typeof process !== 'undefined' && Number(process.pid)) || 0, (typeof process !== 'undefined' && Number(process.ppid)) || 0];

    let live = [];    // entries recorded by THIS process life
    let stale = [];   // entries a previous life left behind (consumed by sweep)
    const pinning = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      stale = (raw && Array.isArray(raw.procs) ? raw.procs : []).filter(r => r && Number(r.pid) > 0 && r.cmd);
    } catch (_) { stale = []; }

    function save() {
      let lastError;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          fs.mkdirSync(P.dirname(file), { recursive: true });
          const tmp = file + '.' + (typeof process !== 'undefined' ? process.pid : 'p') + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify({ procs: stale.concat(live) }));
          fs.renameSync(tmp, file);
          return true;
        } catch (e) { lastError = e; }
      }
      log('[proc-ledger] persist failed after retry: ' + ((lastError && lastError.message) || lastError || 'unknown error'));
      return false;
    }

    function record(o) {
      o = o || {};
      const pid = Number(o.pid);
      if (!(pid > 0)) return null;
      // cmd may already be redacted by the caller. Plaintext argv is not durable identity: pinIdentity() records
      // the kernel-reported creation time after spawn, making (pid, created) the exact identity instead.
      // seenAt: the caller holds the just-spawned child's handle, so the PID is provably ours right now.
      const t = now();
      const exact = Number(o.created) > 0 ? Number(o.created) : null;
      const entry = { pid, cmd: String(o.cmd || '').slice(0, 400), kind: String(o.kind || 'proc'), startedAt: t, created: exact, seenAt: t };
      live = live.filter(r => r.pid !== pid).concat([entry]);
      if (live.length > MAX_ENTRIES) prunePressure();
      save();
      // All callers (including browser children) get exact identity unless they supplied it (created) or defer it
      // (pin:false — the foreground shell pins only commands that outlive a short grace, see environment.js).
      // Callers may also await pinIdentity(pid); concurrent requests dedupe onto the same probe below.
      if (o.pin !== false && !exact) Promise.resolve(pinIdentity(pid)).catch(() => {});
      return entry;
    }

    /* CAP PRESSURE: slice(-MAX_ENTRIES) evicted from the FRONT — the earliest-recorded receipts, which are
       exactly the long-lived children (the dev server from the top of the session) whose receipt the boot
       sweep NEEDS after a force-kill — while retaining the tail's short-lived churn. Under pressure we now
       probe the oldest receipts and drop only the PROVABLY-DEAD ones; a hard 4x ceiling (with a log) is the
       last-resort bound so a runaway spawner still cannot grow the file forever. An empty probe result is
       ambiguous on POSIX (ps failure resolves empty) — prune nothing then; the hard ceiling backstops. */
    let pruning = false, lastPruneAt = 0;
    function prunePressure() {
      if (live.length > MAX_ENTRIES * 4) {
        log('[proc-ledger] over hard ceiling (' + live.length + '); dropping oldest receipts');
        live = live.slice(-(MAX_ENTRIES * 4));
      }
      if (pruning || live.length <= MAX_ENTRIES) return;
      // ONE probe attempt per 30s: record() runs on every spawn, and each probe is a real subprocess
      // (PowerShell on Windows) — an over-cap session must not pay one per shell command. (Inert under
      // an injected zero clock, so tests drive the prune deterministically.)
      const t = now();
      if (t && lastPruneAt && t - lastPruneAt < 30000) return;
      pruning = true; lastPruneAt = t;
      const candidates = live.slice(0, (live.length - MAX_ENTRIES) + 10).map(r => Number(r.pid));
      /* THE CANARY: an empty probe result used to be treated as ambiguous, but an all-dead oldest window
         is the NORMAL steady state — so the prune was a permanent no-op and the hard ceiling front-dropped
         exactly the long-lived receipt the fix protects. Probing our own pid alongside disambiguates:
         a healthy probe always finds the canary, so canary-present + candidate-absent = provably dead;
         canary absent = the probe itself is broken -> prune nothing. */
      const selfPid = (typeof process !== 'undefined' && Number(process.pid)) || 0;
      Promise.resolve(probe(selfPid ? candidates.concat([selfPid]) : candidates)).then((found) => {
        if (!found || (selfPid && !found.has(selfPid))) return;   // broken probe — never launder live receipts into "dead"
        const gone = new Set(candidates.filter(p => !found.has(p)));
        if (gone.size) { live = live.filter(r => !gone.has(Number(r.pid))); save(); }
      }).catch((e) => { log('[proc-ledger] pressure prune failed: ' + ((e && e.message) || e)); }).finally(() => { pruning = false; });
    }

    // Pin the exact OS identity after spawn without persisting the real command line (which can contain secrets).
    // Failure is deliberately safe: the entry remains unpinned and sweep() falls back to the legacy cmd guard.
    async function pinIdentity(pid) {
      pid = Number(pid);
      const entry = live.find(r => r.pid === pid);
      if (!entry) return null;
      if (Number(entry.created) > 0) return Number(entry.created);
      if (pinning.has(pid)) return pinning.get(pid);
      const work = (async () => {
        let alive;
        try { alive = await probe([pid]); } catch (_) { return null; }
        const info = alive && alive.get ? alive.get(pid) : null;
        const created = (info && typeof info === 'object') ? Number(info.created) : NaN;
        if (!(created > 0) || live.indexOf(entry) < 0) return null;
        // record() runs after spawn. A later creation time means the PID already recycled during the probe.
        if (Number(entry.startedAt) > 0 && created > Number(entry.startedAt)) return null;
        entry.created = created;
        // the probe just observed (pid, created) alive: the PID was provably ours at this instant
        const seen = now();
        if (seen > 0 && !entry.exited) entry.seenAt = Math.max(Number(entry.seenAt) || 0, seen);
        save();
        return created;
      })();
      pinning.set(pid, work);
      try { return await work; } finally { if (pinning.get(pid) === work) pinning.delete(pid); }
    }

    function release(pid) {
      pid = Number(pid);
      const before = live.length + stale.length;
      live = live.filter(r => r.pid !== pid);
      stale = stale.filter(r => r.pid !== pid);
      if (live.length + stale.length !== before) save();
    }

    /* touch(pids): an owner that still holds a child's live spawn handle (its exit has not been observed) vouches
       that the PID is still that child's — Windows never reuses a PID while a handle to the process is open. This
       advances seenAt, the ceiling of the orphan window, so children a long-running command starts LATER (a
       watcher's workers, the second half of `a && b`) are still provably ours after a crash. One save per call. */
    function touch(pids) {
      const want = new Set((Array.isArray(pids) ? pids : [pids]).map(Number).filter(p => p > 0));
      const t = now();
      if (!want.size || !(t > 0)) return 0;
      let n = 0;
      for (const e of live) if (want.has(e.pid) && !e.exited) { e.seenAt = Math.max(Number(e.seenAt) || 0, t); n++; }
      if (n) save();
      return n;
    }

    /* markExited(pid, at?): the owner observed the root exit but is KEEPING the receipt (a kill it could not confirm).
       Freezes the orphan window at the exit — after this instant the PID may belong to a stranger. at (optional):
       the instant the exit was OBSERVED, when the stamp is written later than that (trackChild defers it). */
    function markExited(pid, at) {
      pid = Number(pid);
      const e = live.find(r => r.pid === pid);
      if (!e || e.exited) return false;
      e.exited = true;
      const t = Number(at) > 0 ? Number(at) : now();
      if (t > 0) e.exitedAt = t;
      save();
      return true;
    }

    // The window in which a receipt's root provably held its PID; null = unbounded (legacy receipt) -> never walked.
    function orphanWindow(r) {
      const ceiling = Number(r.exitedAt) > 0 ? Number(r.exitedAt) : Number(r.seenAt);
      const floor = Number(r.created) > 0 ? Number(r.created) : (Number(r.startedAt) > 0 ? Number(r.startedAt) - START_TOLERANCE_MS : 0);
      if (!(ceiling > 0) || !(floor > 0) || ceiling < floor) return null;
      return { floor, ceiling };
    }

    // Boot-time orphan sweep: reap what the previous sidecar life spawned and could not reap because it was
    // force-killed. Only kills a PID whose exact identity (or, for a legacy receipt, live command line) still
    // matches — and, on Windows, the owned descendants of a root that has already exited (see orphanWindow).
    // summary: examined/killed/gone/reused/uncertain/killFailed/probeFailed as before, plus
    //   orphaned (receipts whose root had exited but left live descendants), orphansKilled (such descendants
    //   confirmed dead), survived (+ survivors: [{pid, created}]) — processes still alive after the kill was
    //   re-checked; treeQueryFailed — the table query failed, so no orphan was examined or killed on its basis;
    //   treeUnverified — receipts whose outcome could not be confirmed from the table.
    async function sweep() {
      const entries = stale.slice();
      const summary = { examined: entries.length, killed: 0, reused: 0, gone: 0, uncertain: 0, killFailed: 0, probeFailed: false,
        orphaned: 0, orphansKilled: 0, survived: 0, survivors: [], treeQueryFailed: false, treeUnverified: 0 };
      if (!entries.length) { save(); return summary; }
      let alive;
      try { alive = await probe(entries.map(r => r.pid)); }
      catch (e) {
        // A failed OS probe proves NOTHING about liveness. Keep every prior-life receipt intact so the next boot
        // can retry; treating an empty fallback map as "all gone" permanently orphaned owned children.
        summary.probeFailed = true;
        log('[proc-ledger] boot sweep probe failed — retained ' + entries.length + ' ownership receipt(s) for retry (' + ((e && e.message) || e) + ')');
        return summary;
      }
      // One bounded snapshot of the whole table for the owned-tree walk. FAIL SAFE: a failure/timeout here means no
      // orphan of an exited root is examined or killed this boot — never "assume they are gone".
      let rows = null;
      if (processTable) {
        try { rows = await processTable(); }
        catch (e) {
          summary.treeQueryFailed = true;
          log('[proc-ledger] boot sweep: process-table query failed — orphans of exited roots were NOT examined and nothing was killed on that basis (' + ((e && e.message) || e) + ')');
        }
      }
      stale = [];
      const checks = [];   // { entry, targets, orphan } — every process a kill below must be CONFIRMED gone
      for (const r of entries) {
        const info = alive.get(Number(r.pid));
        // verdict on the ROOT: 'dead' (no process holds the pid), 'reused' (a stranger holds it — never killed),
        // 'uncertain' (cannot tell; retained), or 'ours' (alive and proven ours — killed below)
        let verdict = 'dead';
        // tolerate both probe shapes: the string form (older/injected probes) and the {cmd, created} form.
        const liveCmd = info == null ? '' : ((typeof info === 'string') ? info : (info && info.cmd) || '');
        const created = (info != null && typeof info === 'object') ? info.created : null;
        const pinnedCreated = Number(r.created);
        if (info != null) {
          verdict = 'ours';
          if (pinnedCreated > 0) {
            // Exact identity wins over argv: the stored command may be redacted. Missing or +1ms-different creation
            // time is a recycled/uncertain PID and is NEVER killed.
            if (!(Number(created) > 0) || Number(created) !== pinnedCreated) verdict = 'reused';
          } else if (info && typeof info === 'object' && info.identityOnly) verdict = 'uncertain';
          else if (!cmdMatches(r.cmd, liveCmd)) verdict = 'reused';   // legacy/unpinned entry
          // record() happens after spawn, so even 1ms newer than startedAt is not our original child.
          else if (created != null && Number(r.startedAt) > 0 && Number(created) > Number(r.startedAt)) verdict = 'reused';
        }
        if (verdict === 'uncertain') { summary.uncertain++; stale.push(r); continue; }
        if (verdict !== 'ours') {
          // Our root is gone (dead, or its PID now belongs to a stranger) — its descendants may not be.
          if (verdict === 'reused') summary.reused++;
          const notOrphaned = () => { if (verdict === 'dead') summary.gone++; };
          if (!processTable) { notOrphaned(); continue; }
          const win = orphanWindow(r);
          // a legacy receipt with no liveness stamp cannot bound PID reuse: its children are never guessed at
          if (!win) { notOrphaned(); continue; }
          if (!rows) {
            r.treeRetries = (Number(r.treeRetries) || 0) + 1;
            summary.treeUnverified++;
            if (r.treeRetries < MAX_TREE_RETRIES) stale.push(r);
            else log('[proc-ledger] gave up checking exited ' + r.kind + ' pid=' + r.pid + ' for orphans after ' + r.treeRetries + ' failed process-table queries');
            continue;
          }
          const orphans = ownedTree(rows, { pid: r.pid, floor: win.floor, ceiling: win.ceiling, protect: protectPids });
          if (!orphans.length) { notOrphaned(); continue; }
          summary.orphaned++;
          log('[proc-ledger] ' + r.kind + ' pid=' + r.pid + ' had exited but left ' + orphans.length + ' live descendant(s) (' + orphans.map(o => o.pid).join(',') + ') — reaping them');
          let failed = false;
          // kill each orphaned subtree from its top (a direct child of the dead root); taskkill /T takes the rest
          for (const top of orphans.filter(o => o.ppid === Number(r.pid))) {
            try { await killTree(top.pid); }
            catch (e) { failed = true; log('[proc-ledger] orphan reap failed for pid=' + top.pid + ' (' + ((e && e.message) || e) + ')'); }
          }
          if (failed) summary.killFailed++;
          checks.push({ entry: r, targets: orphans, orphan: true });
          continue;
        }
        // Proven ours and alive: capture its live tree BEFORE the kill, so the kill can be confirmed afterwards.
        let tree = null;
        const rootCreated = pinnedCreated > 0 ? pinnedCreated : Number(created);
        if (rows && rootCreated > 0) {
          const rootRow = rows.find(x => x.pid === Number(r.pid) && x.created === rootCreated);
          if (rootRow) tree = [rootRow].concat(ownedTree(rows, { pid: r.pid, floor: rootCreated, protect: protectPids }));
        }
        try {
          await killTree(r.pid); summary.killed++;
          log('[proc-ledger] reaped orphan ' + r.kind + ' pid=' + r.pid + ' (' + String(r.cmd).slice(0, 80) + ')');
          if (tree) checks.push({ entry: r, targets: tree, orphan: false });
          else if (processTable) summary.treeUnverified++;
        }
        catch (e) {
          // A failed kill proves the orphan was not reaped. Retain its ownership receipt so a later boot can
          // retry instead of permanently forgetting the process after one transient taskkill/permission error.
          summary.killFailed++; stale.push(r);
          log('[proc-ledger] orphan reap failed — retained ' + r.kind + ' pid=' + r.pid + ' for retry (' + ((e && e.message) || e) + ')');
        }
      }
      // CONFIRM: a kill is a claim until the table says the processes are gone.
      if (checks.length && processTable) {
        const all = [];
        for (const c of checks) for (const t of c.targets) all.push(t);
        const res = await confirmGone({ snapshot: processTable, targets: all, attempts: confirmOpts.attempts, pollMs: confirmOpts.pollMs, sleep: confirmOpts.sleep });
        if (res.unknown) {
          // could not look: keep every receipt involved so the next boot re-checks (its window is unchanged)
          summary.treeUnverified += checks.length;
          for (const c of checks) if (stale.indexOf(c.entry) < 0) stale.push(c.entry);
          log('[proc-ledger] boot sweep could not confirm the reaped process trees are gone (' + res.error + ') — receipts retained');
        } else {
          const survived = new Set(res.survivors.map(s => s.pid));
          for (const c of checks) if (c.orphan) summary.orphansKilled += c.targets.filter(t => !survived.has(t.pid)).length;
          summary.survived = res.survivors.length;
          summary.survivors = res.survivors.map(s => ({ pid: s.pid, created: s.created }));
          if (res.survivors.length) {
            log('[proc-ledger] ' + res.survivors.length + ' process(es) SURVIVED the boot sweep: ' + res.survivors.map(s => s.pid).join(',') + ' — exact receipts retained for the next boot');
            // An exact (pid, creation) receipt per survivor: the next boot kills it by identity, not by ancestry.
            const seen = now();
            for (const s of res.survivors) {
              if (stale.some(x => Number(x.pid) === s.pid)) continue;
              const owner = checks.find(c => c.targets.some(t => t.pid === s.pid)) || checks[0];
              stale.push({ pid: s.pid, cmd: 'survivor of ' + String(owner.entry.cmd || owner.entry.kind).slice(0, 360), kind: String(owner.entry.kind || 'proc') + '.survivor',
                startedAt: s.created, created: s.created, seenAt: seen > 0 ? seen : s.created });
            }
          }
        }
      }
      save();
      return summary;
    }

    function list() { return stale.concat(live).map(r => Object.assign({}, r)); }

    return { record, pinIdentity, release, touch, markExited, sweep, list, now, _internals: { save, cmdMatches, normCmd, orphanWindow } };
  }

  /* FOREGROUND RECEIPTS (h2 process supervision, 2026-09-22). shell.exec's foreground child was never in the ledger,
     so a sidecar crash mid-command (a 10-minute test run, a build) left an orphan the next boot could not know about.
     trackChild(ledger, pid, { cmd, kind?, pinAfterMs?, touchMs? }) records the child the moment it spawns and
     returns { exited(), done() }: exited() freezes the orphan window when the ROOT exits (stdio may still be held
     by a grandchild), done() releases the receipt when the command is fully over.
     Pinning (a PowerShell probe on Windows) is DEFERRED: most commands finish in well under pinAfterMs (3s) and must
     not pay a probe each; one that outlives it is pinned then, and touched every touchMs while its handle is held
     so children it starts later stay inside the provable window. A receipt that never got pinned still falls back
     to the (redacted) command-line match at the next boot. Every timer is unref'd. */
  /* TODO(posix-fg-receipts): on POSIX a foreground receipt gets NO identity pin and NO orphan walk.
     makePosixProbe returns created:null (start-time parsing not implemented), so pinIdentity() never pins and the
     next boot's sweep falls back to matching the REDACTED command line; and processTable is Windows-only, so the
     descendants of a POSIX root that already exited are never walked (only a still-live group leader is killed by
     makeKillTree's -pid). Closing it needs a POSIX start-time source (ps -o lstart= / /proc/<pid>/stat field 22)
     for the pin, plus a POSIX process table (pid, ppid, start) so ownedTree/orphanWindow can run there too. */
  function trackChild(ledger, pid, o) {
    o = o || {};
    pid = Number(pid);
    const inert = { exited() {}, done() {} };
    if (!ledger || typeof ledger.record !== 'function' || !(pid > 0)) return inert;
    try { ledger.record({ pid, cmd: String(o.cmd || ''), kind: String(o.kind || 'shell.fg'), pin: false }); }
    catch (e) { trackFailNote('procledger.track.record', e); return inert; }
    let pinTimer = null, touchTimer = null, exitTimer = null, exitedFlag = false, finished = false;
    const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; };
    const stopTimers = () => {
      if (pinTimer) { clearTimeout(pinTimer); pinTimer = null; }
      if (touchTimer) { clearInterval(touchTimer); touchTimer = null; }
    };
    // The exit stamp only WIDENS the window (exitedAt >= the last vouched seenAt), so it can wait: a command whose
    // stdio closes right after its exit (the normal case) releases first and never pays the extra ledger write.
    const exitStampMs = o.exitStampMs != null ? Math.max(0, Number(o.exitStampMs) || 0) : 1000;
    const pinAfter = o.pinAfterMs != null ? Math.max(0, Number(o.pinAfterMs) || 0) : 3000;
    const touchEvery = o.touchMs != null ? Math.max(0, Number(o.touchMs) || 0) : 60000;
    if (typeof ledger.pinIdentity === 'function') {
      pinTimer = unref(setTimeout(() => {
        pinTimer = null;
        if (exitedFlag || finished) return;
        Promise.resolve(ledger.pinIdentity(pid)).then(null, (e) => trackFailNote('procledger.track.pin', e));
        if (touchEvery > 0 && typeof ledger.touch === 'function') {
          touchTimer = unref(setInterval(() => {
            if (exitedFlag || finished) return;
            try { ledger.touch([pid]); } catch (e) { trackFailNote('procledger.track.touch', e); }
          }, touchEvery));
        }
      }, pinAfter));
    }
    return {
      exited() {
        if (exitedFlag || finished) return;
        exitedFlag = true; stopTimers();   // no touch after the exit: the PID may be a stranger's from here on
        // the exit instant is captured NOW, not when the deferred stamp fires: stamping at write time put exitedAt
        // up to exitStampMs past the real exit, widening the orphan window into a span the PID was not ours
        const at = (typeof ledger.now === 'function') ? Number(ledger.now()) || 0 : 0;
        const stamp = () => {
          exitTimer = null;
          if (finished) return;
          try { if (typeof ledger.markExited === 'function') ledger.markExited(pid, at); } catch (e) { trackFailNote('procledger.track.exited', e); }
        };
        if (exitStampMs > 0) exitTimer = unref(setTimeout(stamp, exitStampMs)); else stamp();
      },
      done() {
        if (finished) return;
        finished = true; stopTimers();
        if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
        try { if (typeof ledger.release === 'function') ledger.release(pid); } catch (e) { trackFailNote('procledger.track.release', e); }
      }
    };
  }

  return { makeProcLedger, trackChild, _internals: { normCmd, cmdMatches, makeWin32Probe, makePosixProbe, makeKillTree } };
});
