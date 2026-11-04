/* sidecar/shellbg.js — background / long-running shell processes (H2.2).

   shell.exec is synchronous: it blocks until the command finishes, so the agent literally cannot start a dev
   server (or any long-running process) and keep working. This is the manager behind `shell.exec background:true`
   + the shell.bg.status / shell.bg.kill tools: it spawns a DETACHED child, returns a handle immediately, streams
   output into a bounded ring buffer, and announces a `shell.bg.exit` event when the process ends — even after
   the originating run's stream has closed (the host wires onExit to the durable SSE bus, chanEmit).

   It is a SINGLETON (module-level in index.js), NOT per-run: a backgrounded dev server must survive the run that
   started it so a LATER run can use it. Per-agent concurrency is capped; children are unref'd so they never block
   the sidecar from exiting, and killAll() reaps everything on shutdown / E-STOP.

   Local-first only — same fs jail + cwd as shell.exec; no docker/ssh/modal. PURE deps (spawn/clock/redact/onExit
   injected) so it is headless-testable with a fake spawn and determinism-clean (ms via the injected clock).

   TWO-WAY, AND READABLE PAST THE TAIL (2026-07-29). For a long time this was start/status/kill only, which
   made a background process write-only in both directions:
     - No STDIN. The agent could start `npm create vite@latest` or a `python` REPL and then had no way to
       answer a single prompt — the process sat wedged until it was killed. write/submit/closeStdin fix that.
     - No PAGING. `status` returned the last 2000 characters of a 16KB ring, so a stack trace 500 lines up
       the log was simply unreachable; the agent's only recourse was to re-run the command in the foreground
       and hope it failed the same way. read() pages and searches by LINE, and says so when the ring has
       dropped output rather than pretending line 1 is the beginning.

   SUPERVISED, NOT FIRE-AND-FORGET (h2 process supervision, 2026-09-22):
     - kill() is a CLAIM ONLY WITH PROOF. It used to answer {ok:true} the moment taskkill was launched (13 ms, with
       the whole tree still alive; and when taskkill failed, the fallback child.kill() reached only cmd.exe). It now
       snapshots the owned tree, kills it, and re-reads the process table until every target is gone (Windows), or
       until the process group is empty (POSIX). The answer is verified / incomplete (+ surviving PIDs) /
       unverified (the table could not be read). rec.killed is set ONLY on a verified kill, and the ledger receipt
       is released only then — an unconfirmed kill keeps the receipt so the next boot's sweep can finish the job.
     - wait() lets the agent block on a process with a timeout: running (the timeout passed — not an error) /
       exited (code + tail) / cancelled.
     - An exit the agent is NOT waiting on and did not ask for produces an onExitNotice — the host pushes it into
       the owning agent's live run (index.js, through the steer buffer), so a crashed dev server wakes the agent
       instead of sitting silent until it happens to look.
     - Finished records are capped (maxFinished, default 64, oldest dropped); running ones are never dropped.

     makeShellBg({ spawn, clock?, redact?, onExit?, onExitNotice?, maxPerAgent?, maxFinished?, ringBytes?, isWin?, spill?, spillWriter?, maxSpillBytes?,
                   ledger?, processTable?, signalProcess?, killVerify? }) ->
       { start({agentId,cmd,cwd,isWin?}), status(agentId,bgId?), read(agentId,bgId,opts?),
         write(agentId,bgId,{input,submit?}), closeStdin(agentId,bgId), wait(agentId,bgId,{timeoutMs?,signal?}),
         kill(agentId,bgId) -> Promise, killAll(agentId?), count(agentId), touchLedger(), killBudgetMs } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).shellbg = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WIN = (typeof process !== 'undefined' && process.platform) === 'win32';
  const { StringDecoder } = require('node:string_decoder');
  const { note: bgFailNote } = require('./failopen.js');
  const { ownedTree, confirmGone, DEFAULT_TABLE_TIMEOUT_MS } = require('./proctree.js');

  const DEFAULT_WAIT_MS = 30000;
  const MAX_WAIT_MS = 600000;          // same ceiling as a foreground shell.exec
  const START_TOLERANCE_MS = 1000;     // see procledger.js: startedAt is stamped just after spawn returns
  const DEFAULT_VERIFY_ATTEMPTS = 16, DEFAULT_VERIFY_POLL_MS = 250, DEFAULT_TASKKILL_MS = 10000;

  /* The WORST-CASE wall time of one verified kill (killWin with a pre-kill snapshot, the longer path): snapshot +
     taskkill + root-exit wait + confirm (one slow table read + its polls) + second-pass taskkill + second confirm.
     shell.bg.kill sizes its registry timeout from this, so the backstop never cuts off the proof it waits for. */
  function killBudgetMs(o) {
    o = o || {};
    const attempts = Number(o.attempts) > 0 ? Math.floor(Number(o.attempts)) : DEFAULT_VERIFY_ATTEMPTS;
    const pollMs = o.pollMs != null ? Math.max(0, Number(o.pollMs) || 0) : DEFAULT_VERIFY_POLL_MS;
    const taskkillMs = Number(o.taskkillMs) > 0 ? Number(o.taskkillMs) : DEFAULT_TASKKILL_MS;
    const tableMs = Number(o.tableMs) > 0 ? Number(o.tableMs) : (DEFAULT_TABLE_TIMEOUT_MS || 15000);
    const confirm = tableMs + (attempts - 1) * pollMs;
    return tableMs + taskkillMs + attempts * pollMs + confirm + taskkillMs + confirm;
  }

  // Launch taskkill and wait — bounded — for its verdict. Never rejects: { ok, code?, error? }.
  function runTaskkill(spawn, args, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false, timer = null;
      const done = (v) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(v); };
      let killer;
      try { killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }); }
      catch (e) { return done({ ok: false, error: 'taskkill could not start: ' + ((e && e.message) || e) }); }
      if (!killer || typeof killer.on !== 'function') return done({ ok: false, error: 'taskkill handle is not observable' });
      killer.on('error', (e) => done({ ok: false, error: 'taskkill failed: ' + ((e && e.message) || e) }));
      killer.on('close', (code) => done(code === 0 ? { ok: true, code: 0 } : { ok: false, code: code, error: 'taskkill exited ' + code }));
      timer = setTimeout(() => done({ ok: false, error: 'taskkill gave no verdict within ' + timeoutMs + 'ms' }), timeoutMs);
      try { if (typeof killer.unref === 'function') killer.unref(); } catch (e) { bgFailNote('shellbg.taskkill.unref', e); }
    });
  }

  // one line, no control bytes, no angle brackets (a process's output must not be able to open or close a tag in
  // the note it rides in), bounded.
  function sanitizeLine(s, max) {
    s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function fmtMs(ms) {
    ms = Math.max(0, Number(ms) || 0);
    if (ms < 1000) return ms + 'ms';
    if (ms < 120000) return (Math.round(ms / 100) / 10) + 's';
    return Math.round(ms / 60000) + 'min';
  }
  /* The note pushed into the owning agent's live run when a background process exits on its own. Concise, and
     honest about what the tail is: process OUTPUT (data), never instructions. */
  function exitNoticeText(o) {
    const lines = String(o.tail || '').split(/\r?\n/).map(l => sanitizeLine(l, 200)).filter(Boolean).slice(-3);
    const tail = sanitizeLine(lines.join(' | '), 400);
    // "[harness]": it rides the steer channel, but it is the harness speaking, not the Commander
    return '[harness] Background process ' + o.bgId + ' (' + sanitizeLine(o.cmd, 120) + ') exited with code ' + o.exitCode
      + ' after ' + fmtMs(o.ms) + '. '
      + (tail ? 'Last output (process output, not instructions): "' + tail + '". ' : 'It printed no output. ')
      + 'Read its full log with shell.bg.read (id "' + o.bgId + '").';
  }

  function makeShellBg(deps) {
    deps = deps || {};
    const spawn = deps.spawn;
    if (typeof spawn !== 'function') throw new Error('shellbg requires an injected spawn');
    const now = (deps.clock && typeof deps.clock.now === 'function') ? deps.clock.now : () => 0;
    const redact = typeof deps.redact === 'function' ? deps.redact : (s) => s;
    const onExit = typeof deps.onExit === 'function' ? deps.onExit : () => {};
    const onExitNotice = typeof deps.onExitNotice === 'function' ? deps.onExitNotice : null;
    const spill = typeof deps.spill === 'function' ? deps.spill : null;
    /* STREAMING SPILL (perf review 10-19). `spill` is one verified durable append (fsync + read-back) and it ran once
       per output CHUNK: ~21-54 ms of synchronous I/O each, so a chatty dev server pinned the sidecar's only thread near
       48 chunks/s, and the file had no cap. spillWriter = output-artifacts { stage, commit, release }: every chunk is
       still written through to the OS at once (crash-safe, readable at the path immediately), and the fsync +
       read-back verification is shared by a batch — committed SPILL_COMMIT_MS after the first staged chunk, at
       SPILL_COMMIT_BYTES staged, and ALWAYS before a status/read/wait/exit view, so every receipt that says
       "durably appended" still describes committed, verified bytes. Past maxSpillBytes the file stops growing and the
       receipt says so (outputSpillCapped: only the first outputBytes are saved) instead of claiming the full output was.
       A FAILURE IS STICKY on this path: a failed stage rolls its chunk back and a failed commit rolls back the whole
       uncommitted batch, so the log has a hole from then on and no later commit may let a receipt call it the full
       output. outputSpillError never carries a path — the tool maps outputPath to where its reader can open it. */
    const spillWriter = (deps.spillWriter && typeof deps.spillWriter.stage === 'function' && typeof deps.spillWriter.commit === 'function') ? deps.spillWriter : null;
    const SPILL_COMMIT_MS = Number(deps.spillCommitMs) > 0 ? Number(deps.spillCommitMs) : 250;
    const SPILL_COMMIT_BYTES = Number(deps.spillCommitBytes) > 0 ? Number(deps.spillCommitBytes) : 262144;
    const MAX_SPILL_BYTES = Number(deps.maxSpillBytes) > 0 ? Math.floor(Number(deps.maxSpillBytes)) : 64 * 1024 * 1024;
    const newId = typeof deps.newId === 'function' ? deps.newId : null;
    const isWinDefault = (deps.isWin != null) ? deps.isWin : WIN;
    const MAX = deps.maxPerAgent || 5;
    const MAX_FINISHED = Number(deps.maxFinished) > 0 ? Math.floor(Number(deps.maxFinished)) : 64;
    /* 16KB held about 200 lines of a dev server — the ring lapped before the agent got back to look, so the
       compile error that killed the run had already scrolled off. Paging is worthless over a buffer that
       small, so the ring and the paging landed together. 256KB x 5 procs/agent is a bounded ~1.25MB. */
    const RING = deps.ringBytes || 262144;
    const READ_LINES = deps.readLines || 200;      // default page size; the model can ask for more
    // persistent PID ledger (procledger.js): killAll() only reaps on a GRACEFUL stop; a force-killed sidecar
    // (desktop shell TerminateProcess) runs no handlers, so recorded children are swept at the NEXT boot.
    const ledger = (deps.ledger && typeof deps.ledger.record === 'function') ? deps.ledger : null;
    // Kill verification. processTable: () => Promise<[{pid, ppid, created}]> (proctree.makeWin32ProcessTable in
    // production; injected in tests). Without one, Windows can observe only the root's own exit, and says so.
    const processTable = typeof deps.processTable === 'function' ? deps.processTable : null;
    const signalProcess = typeof deps.signalProcess === 'function' ? deps.signalProcess
      : ((pid, sig) => process.kill(pid, sig));
    const KV = deps.killVerify || {};
    const VERIFY_ATTEMPTS = Number(KV.attempts) > 0 ? Math.floor(Number(KV.attempts)) : DEFAULT_VERIFY_ATTEMPTS;
    const VERIFY_POLL_MS = KV.pollMs != null ? Math.max(0, Number(KV.pollMs) || 0) : DEFAULT_VERIFY_POLL_MS;
    const TASKKILL_MS = Number(KV.taskkillMs) > 0 ? Number(KV.taskkillMs) : DEFAULT_TASKKILL_MS;
    // this instance's own worst case (KV.tableMs: the injected process table's per-read bound, if not the default)
    const KILL_BUDGET_MS = killBudgetMs({ attempts: VERIFY_ATTEMPTS, pollMs: VERIFY_POLL_MS, taskkillMs: TASKKILL_MS, tableMs: KV.tableMs });
    const sleep = typeof KV.sleep === 'function' ? KV.sleep : ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
    const selfPid = (typeof process !== 'undefined' && Number(process.pid)) || 0;
    // a poll step always yields to the EVENT LOOP (a macrotask): the exit it waits for arrives as a process event,
    // which a microtask-only yield would starve until the budget ran out
    const yieldPoll = () => (VERIFY_POLL_MS > 0 ? sleep(VERIFY_POLL_MS) : new Promise(resolve => setImmediate(resolve)));

    const procs = new Map();   // bgId -> rec
    let seq = 0;

    /* An UNSETTLED kill: one whose verdict landed as "incomplete" or "unverified". It was not proven, so the record
       stays retryable (kill() and killAll() run it again) instead of joining a stale verdict forever. */
    function killUnsettled(p) { return p.killState === 'incomplete' || p.killState === 'unverified'; }
    // Holds a cap slot: a running proc nobody has asked to kill, or an unsettled kill whose tree is still known to be
    // alive (root still running, or named survivors). A kill IN FLIGHT ('pending') frees its slot immediately — its
    // 'close' just hasn't fired yet — but a kill that FAILED must not free a slot for a tree that is still running.
    function holdsSlot(p) {
      if (p.killState === 'pending' || p.killState === 'verified') return false;
      if (!p.killRequested) return !!p.running;
      return killUnsettled(p) && (!!p.running || (Array.isArray(p.survivors) && p.survivors.length > 0));
    }
    function count(agentId) { let n = 0; for (const p of procs.values()) if (p.agentId === agentId && holdsSlot(p)) n++; return n; }
    function spillEntry(r, text) { return { agentId: r.agentId, kind: 'shell-bg', id: r.bgId, text: text }; }
    // the first failure stays: bytes were lost there, so the log is not the full output any more (see STREAMING SPILL)
    function spillFailed(r, e) { if (!r.outputSpillError) r.outputSpillError = String((e && e.message) || e || 'output spill failed').slice(0, 300); }
    // make every staged chunk durable + verified (one fsync for the batch). Cheap no-op when nothing is staged.
    function commitSpill(r) {
      if (r.spillTimer) { clearTimeout(r.spillTimer); r.spillTimer = null; }
      if (!spillWriter || !r.spillDirty) return;
      r.spillDirty = false;
      try {
        const saved = spillWriter.commit(spillEntry(r));
        if (saved && saved.path) { r.outputPath = String(saved.path); r.outputBytes = Math.max(0, Number(saved.bytes) || 0); }
      } catch (e) { spillFailed(r, e); }
      r.spillStaged = r.outputBytes;
    }
    /* The receipt facts view() and read() share. verified = the WHOLE output is durably saved at outputPath; capped =
       only its first outputBytes are (the log hit its cap; nothing was lost before that); error = why the log is not the
       full output. A capped log's error names the cap but no path, so a reader that knows nothing of `capped` still
       reads the truth and never a path it cannot open. */
    function spillFacts(r) {
      const capped = !!r.spillCapped;
      return {
        outputPath: r.outputPath || null, outputBytes: r.outputBytes || 0,
        outputSpillVerified: !!r.outputPath && !r.outputSpillError && !capped,
        outputSpillError: r.outputSpillError || (capped ? 'the durable log stopped at its ' + MAX_SPILL_BYTES + '-byte cap (' + (r.outputBytes || 0) + ' bytes saved); later output is only in the memory ring' : null),
        outputSpillCapped: capped && !!r.outputPath && !r.outputSpillError
      };
    }
    function spillChunk(r, s) {
      if (!spillWriter) {
        try {
          const saved = spill(spillEntry(r, s));
          if (saved && saved.path) { r.outputPath = String(saved.path); r.outputBytes = Math.max(0, Number(saved.bytes) || r.outputBytes); r.outputSpillError = ''; }
        } catch (e) { r.outputSpillError = String((e && e.message) || e || 'output spill failed').slice(0, 300); }
        return;
      }
      if (r.spillCapped) return;
      if (r.spillStaged + Buffer.byteLength(s, 'utf8') > MAX_SPILL_BYTES) {
        commitSpill(r);
        r.spillCapped = true;
        return;
      }
      try {
        const st = spillWriter.stage(spillEntry(r, s));
        if (st && st.path) { r.outputPath = String(st.path); r.spillStaged = Math.max(0, Number(st.bytes) || 0); r.spillDirty = true; }
      } catch (e) { spillFailed(r, e); }
      if (!r.spillDirty) return;
      if (r.spillStaged - r.outputBytes >= SPILL_COMMIT_BYTES) commitSpill(r);
      else if (!r.spillTimer) {
        r.spillTimer = setTimeout(() => { r.spillTimer = null; commitSpill(r); }, SPILL_COMMIT_MS);
        try { if (r.spillTimer && typeof r.spillTimer.unref === 'function') r.spillTimer.unref(); } catch (e) { bgFailNote('shellbg.spill.unref', e); }
      }
    }
    function view(r) {
      commitSpill(r);
      return {
        bgId: r.bgId, pid: r.child && r.child.pid || null, cmd: r.cmd, running: r.running, exitCode: r.exitCode, killed: r.killed,
        killState: r.killState || null, survivors: r.survivors ? r.survivors.slice() : [],
        ms: Math.max(0, (r.endedAt != null ? r.endedAt : now()) - r.startedAt),
        tail: r.out.slice(-2000), ...spillFacts(r)
      };
    }

    /* FINISHED RECORDS ARE BOUNDED. Every record used to live forever (up to 256KB of output each), so a long
       session that started many short background jobs grew without limit. Running records are never touched;
       finished ones beyond MAX_FINISHED go, oldest exit first. A record whose kill is still being confirmed stays
       until the verdict lands, so status can report it; one whose kill left named survivors stays too (it still holds a
       cap slot and killAll must be able to retry it). */
    function pruneFinished() {
      const done = [];
      for (const r of procs.values()) if (!r.running && r.killState !== 'pending' && !holdsSlot(r)) done.push(r);
      if (done.length <= MAX_FINISHED) return 0;
      done.sort((a, b) => (Number(a.endedAt) || 0) - (Number(b.endedAt) || 0));
      const drop = done.slice(0, done.length - MAX_FINISHED);
      for (const r of drop) { procs.delete(r.bgId); r.out = ''; }
      return drop.length;
    }

    function releaseReceipt(rec) {
      if (!ledger || !rec.pid || rec.receiptReleased) return;
      rec.receiptReleased = true;
      try { ledger.release(rec.pid); } catch (e) { bgFailNote('shellbg.ledger.release', e); }
    }

    function start(o) {
      o = o || {};
      const agentId = String(o.agentId || 'agent');
      const cmd = String(o.cmd || '').trim();
      const isWin = (o.isWin != null) ? o.isWin : isWinDefault;
      if (!cmd) return { ok: false, error: 'empty command' };
      if (count(agentId) >= MAX) return { ok: false, error: 'too many background processes (max ' + MAX + ') — kill one with shell.bg.kill first' };
      let child;
      // detached on POSIX so the child leads its own group (clean tree-kill); windowsHide everywhere. unref so a
      // live bg child never keeps the sidecar process alive on its own.
      try {
        /* Environment backends may own the shell boundary themselves (Docker uses `docker exec`, for
           example). Accept an argv-form child without changing the long-standing local shell path. Exact
           argv keeps the backend command out of a host shell and therefore avoids a second quoting/parser
           boundary around agent-authored text. */
        if (o.file && Array.isArray(o.args)) {
          child = spawn(String(o.file), o.args.map(String), Object.assign({}, o.spawnOptions || {}, {
            cwd: o.cwd,
            shell: false,
            windowsHide: true,
            detached: !isWin,
            env: o.env
          }));
        } else {
          child = spawn(cmd, { cwd: o.cwd, shell: true, windowsHide: true, detached: !isWin, env: o.env });
        }
      }
      catch (e) { return { ok: false, error: 'could not start: ' + ((e && e.message) || e) }; }
      try { if (typeof child.unref === 'function') child.unref(); } catch (_) {}
      const bgId = newId ? 'bg_' + String(newId()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : 'bg_' + (++seq);
      const pid = Number(child && child.pid) > 0 ? Number(child.pid) : 0;
      const rec = { bgId, agentId, cmd, child, pid, isWin, out: '', running: true, exitCode: null, killed: false, startedAt: now(), endedAt: null, dropped: 0, stdinClosed: false, outputPath: null, outputBytes: 0, outputSpillError: '',
        spillStaged: 0, spillDirty: false, spillTimer: null, spillCapped: false,
        killRequested: false, killState: null, killPromise: null, survivors: null, survivorRows: null, exitSeen: false, exitAt: null, rootCreated: 0, waiters: [], receiptReleased: false };
      // record a REDACTED command to the on-disk ledger — a backgrounded command can carry a secret on its argv
      // (e.g. curl -H "Authorization: Bearer …"), and proc-ledger.json persists across sessions. Exact OS identity
      // below means boot cleanup never needs the plaintext command to recognize this child.
      try {
        if (ledger && pid) {
          ledger.record({ pid: pid, cmd: redact(cmd), kind: 'shell.bg' });
          // Exact (pid, OS creation time) identity lets boot sweep reap secret-bearing commands without ever
          // persisting their plaintext argv. Best-effort/fail-closed: an unpinned entry falls back to cmd matching.
          // The creation time also floors the orphan window if this root dies before its tree does.
          if (typeof ledger.pinIdentity === 'function') {
            Promise.resolve(ledger.pinIdentity(pid)).then((created) => { if (Number(created) > 0) rec.rootCreated = Number(created); },
              (e) => bgFailNote('shellbg.ledger.pin', e));
          }
        }
      } catch (e) { bgFailNote('shellbg.ledger.record', e); }
      // per-stream StringDecoder (same fix as shell.js/environment.js): a multi-byte UTF-8 character
      // straddling a pipe chunk boundary must not persist as U+FFFD — this path also SPILLS the corrupt
      // text to the durable output file before the model ever pages it.
      const mkDec = () => { const dec = new StringDecoder('utf8'); return (buf) => append(typeof buf === 'string' ? buf : dec.write(buf)); };
      const append = (text) => {
        let s = ''; try { s = redact(String(text)); } catch (_) { s = String(text); }
        if ((spillWriter || spill) && s) spillChunk(rec, s);
        rec.out += s;
        if (rec.out.length > RING) {
          let cut = rec.out.length - RING;
          /* Snap the cut FORWARD to a line boundary. A ring that lands mid-line makes the first line of every
             page a fragment, and a fragment reads as a real line to anything counting them — so line 1 of a
             paged read would be a lie in a way the caller cannot detect. Bounded scan: if the next newline is
             absurdly far (one enormous line), keep the raw cut rather than discarding the whole buffer. */
          const nl = rec.out.indexOf('\n', cut);
          if (nl >= 0 && nl - cut < 4096) cut = nl + 1;
          rec.dropped += cut;
          rec.out = rec.out.slice(cut);
        }
      };
      if (child.stdout && child.stdout.on) child.stdout.on('data', mkDec());
      if (child.stderr && child.stderr.on) child.stderr.on('data', mkDec());
      // The ROOT's exit (process gone; stdio may still be held open by a grandchild). From here on the PID may be
      // reused by a stranger, so the ledger's orphan window is frozen at this instant.
      const markExit = () => {
        if (rec.exitSeen) return;
        rec.exitSeen = true; rec.exitAt = now();
        try { if (ledger && pid && typeof ledger.markExited === 'function') ledger.markExited(pid); } catch (e) { bgFailNote('shellbg.ledger.markExited', e); }
      };
      const settle = (code) => {
        if (!rec.running) return;
        markExit();
        rec.running = false; rec.endedAt = now();
        rec.exitCode = (typeof code === 'number') ? code : -1;
        // 'close' = every stdio stream has ended: commit the last batch and drop the writer's bookkeeping
        commitSpill(rec);
        if (spillWriter && typeof spillWriter.release === 'function') { try { spillWriter.release(spillEntry(rec)); } catch (e) { bgFailNote('shellbg.spill.release', e); } }
        // a natural exit ends ownership; a requested kill releases the receipt only once the kill is CONFIRMED
        if (!rec.killRequested) releaseReceipt(rec);
        // shell.bg.exit keeps its contract: `killed` = the harness ended it (not "the whole tree is proven gone")
        try { onExit({ agentId, bgId, exitCode: rec.exitCode, ms: Math.max(0, rec.endedAt - rec.startedAt), killed: rec.killRequested }); } catch (e) { bgFailNote('shellbg.onExit', e); }
        const awaited = rec.waiters.length > 0;
        const waiters = rec.waiters.splice(0);
        for (const w of waiters) { try { w(); } catch (e) { bgFailNote('shellbg.waiter', e); } }
        // WAKE the owner — but not for an exit it asked for (kill) or is already blocked on (wait): those
        // callers get the result directly, and a second copy in the transcript is noise.
        if (onExitNotice && !rec.killRequested && !awaited) {
          try {
            const ms = Math.max(0, rec.endedAt - rec.startedAt);
            onExitNotice({ agentId, bgId, exitCode: rec.exitCode, ms, text: exitNoticeText({ bgId, cmd: redact(cmd), exitCode: rec.exitCode, ms, tail: rec.out.slice(-4000) }) });
          } catch (e) { bgFailNote('shellbg.onExitNotice', e); }
        }
        pruneFinished();
      };
      if (child.on) {
        child.on('exit', markExit);
        child.on('close', settle);
        // Node emits `error` for failures other than spawn (for example a failed kill/send) while a child with
        // a real PID may still be alive. `close` is the process-lifecycle truth and releases the durable receipt.
        child.on('error', () => { if (!(Number(child.pid) > 0)) settle(-1); });
      }
      procs.set(bgId, rec);
      return { ok: true, bgId, max: MAX };
    }

    function status(agentId, bgId) {
      agentId = String(agentId || 'agent');
      if (bgId) { const r = procs.get(String(bgId)); return (r && r.agentId === agentId) ? view(r) : null; }
      const out = []; for (const r of procs.values()) if (r.agentId === agentId) out.push(view(r));
      return out;
    }

    // ownership is the ONE gate on every by-id operation: an agent may only touch a process it started.
    function own(agentId, bgId) {
      const r = procs.get(String(bgId));
      return (r && r.agentId === String(agentId || 'agent')) ? r : null;
    }

    /* PAGED / SEARCHABLE OUTPUT. `offset` is 0-based over the lines currently held; NEGATIVE counts back
       from the end (-50 = the last 50 lines), which is what "show me the end of the log" actually means and
       saves a round trip to learn totalLines first. `grep` filters to matching lines, keeping each line's
       real number so the caller can page around a hit.

       `dropped` is reported, never hidden: once the ring laps, line 1 is NOT the first line the process
       printed, and a reader that assumes otherwise draws wrong conclusions about where a failure began. */
    function read(agentId, bgId, opts) {
      opts = opts || {};
      const r = own(agentId, bgId);
      if (!r) return { ok: false, error: 'no such background process' };
      commitSpill(r);
      const all = r.out === '' ? [] : r.out.split('\n');
      // a trailing newline yields a final '' that is not a line the process wrote
      if (all.length && all[all.length - 1] === '') all.pop();

      const limit = Math.max(1, Math.min(2000, Number(opts.limit) || READ_LINES));
      const needle = (opts.grep == null || opts.grep === '') ? null : String(opts.grep).toLowerCase();

      let numbered;
      if (needle) {
        numbered = [];
        for (let i = 0; i < all.length; i++) if (all[i].toLowerCase().indexOf(needle) >= 0) numbered.push([i + 1, all[i]]);
      } else {
        numbered = new Array(all.length);
        for (let i = 0; i < all.length; i++) numbered[i] = [i + 1, all[i]];
      }

      let off = Number(opts.offset);
      if (!Number.isFinite(off)) off = needle ? 0 : Math.max(0, numbered.length - limit);   // no offset -> the END, like tail
      if (off < 0) off = Math.max(0, numbered.length + off);
      if (off > numbered.length) off = numbered.length;
      const page = numbered.slice(off, off + limit);

      return {
        ok: true, bgId: r.bgId, running: r.running, exitCode: r.exitCode, killed: r.killed, cmd: r.cmd,
        lines: page.map(x => x[1]), firstLineNo: page.length ? page[0][0] : 0, lineNos: page.map(x => x[0]),
        offset: off, returned: page.length,
        totalLines: all.length, matchedLines: needle ? numbered.length : null, grep: opts.grep || null,
        droppedBytes: r.dropped, truncatedStart: r.dropped > 0, ...spillFacts(r)
      };
    }

    /* STDIN. Without this a background process is write-only: an installer that asks one question, or any
       REPL, wedges forever and the only move left is to kill it. `submit` appends the newline, because the
       overwhelmingly common case is answering a prompt and a payload without it just sits in the pipe
       looking like nothing happened. */
    function write(agentId, bgId, o) {
      o = o || {};
      const r = own(agentId, bgId);
      if (!r) return { ok: false, error: 'no such background process' };
      if (!r.running) return { ok: false, error: 'process ' + r.bgId + ' has already exited (' + r.exitCode + ') — nothing is listening on its stdin' };
      if (r.stdinClosed) return { ok: false, error: 'stdin for ' + r.bgId + ' was already closed with eof' };
      const stdin = r.child && r.child.stdin;
      if (!stdin || typeof stdin.write !== 'function') return { ok: false, error: 'this process has no writable stdin' };
      const data = String(o.input == null ? '' : o.input) + (o.submit === false ? '' : '\n');
      try { stdin.write(data); }
      catch (e) { return { ok: false, error: 'write failed: ' + ((e && e.message) || e) }; }
      return { ok: true, bytes: data.length };
    }

    // EOF. Distinct from kill: many commands (a pipe consumer, an interactive prompt reading to EOF) only
    // do their work once stdin CLOSES, so killing them instead of closing destroys the result.
    function closeStdin(agentId, bgId) {
      const r = own(agentId, bgId);
      if (!r) return { ok: false, error: 'no such background process' };
      if (r.stdinClosed) return { ok: true, alreadyClosed: true };
      const stdin = r.child && r.child.stdin;
      if (!stdin || typeof stdin.end !== 'function') return { ok: false, error: 'this process has no writable stdin' };
      try { stdin.end(); } catch (e) { return { ok: false, error: 'close failed: ' + ((e && e.message) || e) }; }
      r.stdinClosed = true;
      return { ok: true };
    }

    /* WAIT. The agent's only way to learn a background job finished used to be polling shell.bg.status, turn after
       paid turn. wait() blocks (bounded) until the process exits: 'exited' (code + tail) — or 'running' when the
       timeout passes first, which is an ANSWER ("still going"), not an error — or 'cancelled' when the run is. */
    function wait(agentId, bgId, o) {
      o = o || {};
      const r = own(agentId, bgId);
      if (!r) return Promise.resolve({ ok: false, error: 'no such background process' });
      const req = Number(o.timeoutMs);
      const timeoutMs = Number.isFinite(req) ? Math.max(0, Math.min(MAX_WAIT_MS, req)) : DEFAULT_WAIT_MS;
      const t0 = now();
      const result = (state) => Object.assign(view(r), { ok: true, state: state, timedOut: state === 'running', waitedMs: Math.max(0, now() - t0), timeoutMs: timeoutMs });
      if (!r.running) return Promise.resolve(result('exited'));
      const sig = o.signal;
      if (sig && sig.aborted) return Promise.resolve(result('cancelled'));
      return new Promise((resolve) => {
        let done = false, timer = null;
        const finish = (state) => {
          if (done) return; done = true;
          if (timer) clearTimeout(timer);
          const i = r.waiters.indexOf(onExitSeen); if (i >= 0) r.waiters.splice(i, 1);
          if (sig) { try { sig.removeEventListener('abort', onAbort); } catch (e) { bgFailNote('shellbg.wait.abort', e); } }
          resolve(result(state));
        };
        const onExitSeen = () => finish('exited');
        const onAbort = () => finish('cancelled');
        r.waiters.push(onExitSeen);
        timer = setTimeout(() => finish(r.running ? 'running' : 'exited'), timeoutMs);
        if (sig) { try { sig.addEventListener('abort', onAbort, { once: true }); } catch (e) { bgFailNote('shellbg.wait.abort', e); } }
      });
    }

    // resolves true once the ROOT's exit has been observed (its handle is the one authority on the root's
    // liveness), false if it has not within the budget.
    function waitRootExit(r, attempts) {
      return (async () => {
        for (let i = 0; i < attempts; i++) {
          if (r.exitSeen || !r.running) return true;
          await yieldPoll();
        }
        return !!(r.exitSeen || !r.running);
      })();
    }

    /* WINDOWS: snapshot (agent kill only) -> taskkill /T /F -> confirm from the table -> second pass on survivors.
       The root's own liveness comes from its handle (exit event); descendants come from the table, matched by
       exact (pid, creation time). */
    async function killWin(r, snapshotFirst) {
      const pid = r.pid;
      let targets = null, tableErr = '';
      const readTree = async (rows) => {
        const rootRow = (!r.exitSeen) ? rows.find(x => x.pid === pid) : null;
        if (rootRow && rootRow.created > 0) {
          if (!(r.rootCreated > 0)) r.rootCreated = rootRow.created;
          return ownedTree(rows, { pid, floor: rootRow.created, protect: [selfPid] });
        }
        // the root is already gone: its orphans are bounded by [root created, root exit observed] (see proctree.js)
        const floor = r.rootCreated > 0 ? r.rootCreated : (r.startedAt > 0 ? r.startedAt - START_TOLERANCE_MS : 0);
        const ceiling = r.exitAt > 0 ? r.exitAt : now();
        return ownedTree(rows, { pid, floor, ceiling, protect: [selfPid] });
      };
      if (snapshotFirst && processTable) {
        try { targets = await readTree(await processTable()); }
        catch (e) { tableErr = String((e && e.message) || e); bgFailNote('shellbg.kill.snapshot', e); }
      }
      /* Once the root's exit has been OBSERVED its PID may already belong to a stranger (a RETRY of an unsettled kill
         lands here), so it is never named to taskkill again: its orphans are reached only through the second pass,
         by the (pid, creation) identity the table re-proves. */
      const tk = r.exitSeen ? { ok: true, skipped: true }
        : await runTaskkill(spawn, ['/pid', String(pid), '/T', '/F'], TASKKILL_MS);
      if (!tk.ok) {
        // taskkill could not take the tree: at least stop the root we hold, then let the table say what survived
        try { if (r.child && typeof r.child.kill === 'function') r.child.kill(); } catch (e) { bgFailNote('shellbg.kill.fallback', e); }
      }
      if (!targets && processTable && !tableErr) {
        // no pre-kill snapshot (killAll must not delay the kill): read the orphan window after the fact
        try { targets = await readTree(await processTable()); }
        catch (e) { tableErr = String((e && e.message) || e); bgFailNote('shellbg.kill.snapshot', e); }
      }
      if (targets && Array.isArray(r.survivorRows) && r.survivorRows.length) {
        // a RETRY: the survivors an earlier pass named are targets by their exact identity — an orphan whose parent
        // died is unreachable from the root's tree walk, and missing it would pass the retry as a false 'verified'
        const have = new Set(targets.map(t => t.pid));
        for (const s of r.survivorRows) if (s && s.pid > 0 && s.created > 0 && s.pid !== pid && !have.has(s.pid)) { targets.push(s); have.add(s.pid); }
      }
      const rootGone = await waitRootExit(r, VERIFY_ATTEMPTS);
      const tkNote = tk.ok ? '' : ' (taskkill: ' + (tk.error || ('exit ' + tk.code)) + ')';
      if (!targets) {
        return { ok: false, unverified: true, rootExited: rootGone, survivors: rootGone ? [] : [pid],
          error: 'the kill was sent but the process tree could not be confirmed gone — ' + (tableErr || 'no process table is available') + tkNote };
      }
      let res = targets.length ? await confirmGone({ snapshot: processTable, targets, attempts: VERIFY_ATTEMPTS, pollMs: VERIFY_POLL_MS, sleep })
        : { gone: true, unknown: false, survivors: [] };
      if (!res.unknown && res.survivors.length) {
        // a second pass by the identity the table just re-proved: orphans of an already-dead root are outside
        // taskkill's /T tree, and a taskkill that failed outright reached none of them
        const args = ['/F', '/T'];
        for (const s of res.survivors) args.push('/pid', String(s.pid));
        await runTaskkill(spawn, args, TASKKILL_MS);
        res = await confirmGone({ snapshot: processTable, targets: res.survivors, attempts: VERIFY_ATTEMPTS, pollMs: VERIFY_POLL_MS, sleep });
      }
      if (res.unknown) {
        return { ok: false, unverified: true, rootExited: rootGone, survivors: rootGone ? [] : [pid],
          error: 'the kill was sent but the process table could not be re-read to confirm it (' + res.error + ')' + tkNote };
      }
      const survivors = res.survivors.map(s => s.pid);
      if (!rootGone && survivors.indexOf(pid) < 0) survivors.unshift(pid);
      if (survivors.length) {
        return { ok: false, incomplete: true, survivors, survivorRows: res.survivors,
          error: 'the kill did not complete: ' + survivors.length + ' process(es) still running (PIDs ' + survivors.join(', ') + ')' + tkNote };
      }
      return { ok: true, verified: true, killedPids: [pid].concat(targets.map(t => t.pid)) };
    }

    /* POSIX: the child leads its own process group (detached), so the GROUP is the tree. SIGKILL the group, then
       confirm with signal 0 that no member is left (ESRCH). A group that cannot be signalled falls back to the
       leader, and then only the leader's exit can be observed — reported as unverified, not as success. */
    async function killPosix(r) {
      const pid = r.pid;
      let groupKilled = false;
      try { signalProcess(-pid, 'SIGKILL'); groupKilled = true; }
      catch (e) { bgFailNote('shellbg.killTree.group', e); }   // no group (not detached / already gone) -> leader fallback below
      if (!groupKilled && !r.exitSeen) {
        // (a leader whose exit was already observed is never signalled by bare PID: that PID may be a stranger's now)
        try { if (r.child && typeof r.child.kill === 'function') r.child.kill('SIGKILL'); } catch (e) { bgFailNote('shellbg.kill.leader', e); }
        try { signalProcess(pid, 'SIGKILL'); } catch (e) { bgFailNote('shellbg.kill.leaderpid', e); }
      }
      const rootGone = await waitRootExit(r, VERIFY_ATTEMPTS);
      if (!groupKilled) {
        return rootGone ? { ok: false, unverified: true, rootExited: true, survivors: [], error: 'the process had no process group, so only its own exit could be confirmed — its children were not verified' }
          : { ok: false, incomplete: true, survivors: [pid], error: 'the kill did not complete: process ' + pid + ' is still running' };
      }
      let groupAlive = true;
      for (let i = 0; i < VERIFY_ATTEMPTS; i++) {
        try { signalProcess(-pid, 0); groupAlive = true; }
        catch (e) { groupAlive = !!(e && e.code === 'EPERM'); }
        if (!groupAlive) break;
        await yieldPoll();
      }
      if (groupAlive || !rootGone) return { ok: false, incomplete: true, survivors: [pid], error: 'the kill did not complete: process group ' + pid + ' still has running members' };
      return { ok: true, verified: true, killedPids: [pid] };
    }

    /* One kill IN FLIGHT per record: a second request joins it. The record is marked killed ONLY on proof, and the
       durable receipt is released only then; an unconfirmed kill keeps it for the next boot's sweep. A verified
       verdict is final (later requests get it back); an incomplete/unverified one clears killPromise so the NEXT
       request — the agent retrying, E-STOP, shutdown — runs the kill again instead of re-reading a stale failure.
       killRequested stays set: the harness did ask for this exit, so the root's close must not release the receipt. */
    function startKill(r, snapshotFirst) {
      if (r.killPromise) return r.killPromise;
      r.killRequested = true; r.killState = 'pending';
      if (!r.pid) {
        r.killState = 'unverified';
        r.killPromise = Promise.resolve({ ok: false, unverified: true, survivors: [], error: 'the process has no PID to kill' });
        return r.killPromise;
      }
      const work = r.isWin ? killWin(r, snapshotFirst) : killPosix(r);
      r.killPromise = work.then((res) => {
        r.killState = res.verified ? 'verified' : (res.incomplete ? 'incomplete' : 'unverified');
        r.survivors = res.survivors || [];
        r.survivorRows = Array.isArray(res.survivorRows) ? res.survivorRows.map(x => ({ pid: x.pid, ppid: x.ppid, created: x.created })) : [];
        if (res.verified) { r.killed = true; releaseReceipt(r); }
        else if (ledger && typeof ledger.record === 'function' && Array.isArray(res.survivorRows)) {
          // exact receipts for the survivors, so a sweep can kill them by identity even if the root is long gone
          for (const s of res.survivorRows) {
            if (s.pid === r.pid || !(s.created > 0)) continue;
            try { ledger.record({ pid: s.pid, cmd: 'survivor of ' + redact(r.cmd), kind: 'shell.bg.survivor', created: s.created }); } catch (e) { bgFailNote('shellbg.ledger.survivor', e); }
          }
        }
        if (!res.verified) r.killPromise = null;   // unsettled: the next request retries (see above)
        return Object.assign({ bgId: r.bgId }, res);
      }, (e) => {
        bgFailNote('shellbg.kill', e);
        r.killState = 'unverified';
        r.killPromise = null;
        return { ok: false, unverified: true, bgId: r.bgId, survivors: [], error: 'kill failed: ' + ((e && e.message) || e) };
      });
      return r.killPromise;
    }

    function kill(agentId, bgId) {
      const r = own(agentId, bgId);
      if (!r) return Promise.resolve({ ok: false, error: 'no such background process' });
      if (!r.running && !r.killRequested) return Promise.resolve({ ok: true, alreadyExited: true, bgId: r.bgId });
      return startKill(r, true);
    }

    // reap: an agent's procs (signal abort) or everything (sidecar shutdown / E-STOP). Synchronous count; the kill
    // starts IMMEDIATELY (no pre-kill snapshot — shutdown has a 3s deadline) and is confirmed afterwards. A record
    // whose earlier kill was NOT proven (incomplete/unverified) is tried again — E-STOP must not skip a tree that
    // survived the agent's own shell.bg.kill. A kill already in flight is joined, not restarted or counted.
    function killAll(agentId) {
      let n = 0;
      for (const r of procs.values()) {
        if (agentId != null && r.agentId !== String(agentId)) continue;
        if (r.killState === 'pending' || r.killState === 'verified') continue;
        if ((r.running && !r.killRequested) || (killUnsettled(r) && !r.killPromise)) { startKill(r, false); n++; }
      }
      return n;
    }

    // Vouch for every child whose exit has not been observed: its handle is still open, so its PID is still its
    // own. Advances the ledger's orphan-window ceiling (procledger.touch). The host calls this on a slow timer.
    function touchLedger() {
      if (!ledger || typeof ledger.touch !== 'function') return 0;
      const pids = [];
      for (const r of procs.values()) if (r.running && !r.exitSeen && r.pid) pids.push(r.pid);
      if (!pids.length) return 0;
      try { return ledger.touch(pids) || 0; } catch (e) { bgFailNote('shellbg.ledger.touch', e); return 0; }
    }

    return { start, status, read, write, closeStdin, wait, kill, killAll, count, touchLedger, killBudgetMs: KILL_BUDGET_MS, _internals: { procs, view, own, pruneFinished, exitNoticeText } };
  }

  /* makeBgExitWaker({ steer, liveRuns?, runs?, runsMeta?, log? }) -> (notice) => { delivered, runId?, status?, reason? }
     The host side of the wake (index.js wires it as onExitNotice). `runs` is the host's in-flight map (has(runId)),
     `runsMeta` maps runId -> { agentId, startedAt }, `steer` is sidecar/steer-buffer.js. The note goes to the most
     recently started LIVE run of the owning agent whose steer buffer is still open — one run, never a fan-out —
     through steer.post, so it inherits every promise the steer endpoint makes (bounded, clamped, and an honest
     409 once the loop has closed its buffer). No live run: nothing is posted (the COMMS line is the signal). */
  function makeBgExitWaker(deps) {
    deps = deps || {};
    const steer = deps.steer, runs = deps.runs, runsMeta = deps.runsMeta;
    const liveRuns = typeof deps.liveRuns === 'function' ? deps.liveRuns : null;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    function liveRunFor(agentId) {
      let best = null, bestAt = -1;
      // The host projects eligible owner entries from its one run table at the instant of the wake.
      // Older injected callers can still supply their existing registries. No second registry is stored here.
      const candidates = liveRuns ? (liveRuns() || []).map(r => [r.runId, r]) : runsMeta;
      if (!candidates || typeof candidates[Symbol.iterator] !== 'function') return null;
      for (const [runId, meta] of candidates) {
        if (!meta || String(meta.agentId || '') !== String(agentId || '')) continue;
        if (!liveRuns && (!runs || typeof runs.has !== 'function' || !runs.has(runId))) continue;
        if (steer && typeof steer.isClosed === 'function' && steer.isClosed(runId)) continue;
        const at = Number(meta.startedAt) || 0;
        if (at >= bestAt) { best = runId; bestAt = at; }
      }
      return best;
    }
    function wake(n) {
      if (!n || !n.text || !steer || typeof steer.post !== 'function') return { delivered: false, reason: 'unwired' };
      const runId = liveRunFor(n.agentId);
      if (!runId) return { delivered: false, reason: 'no-live-run' };
      const out = steer.post(runId, n.text, true) || {};
      if (out.status !== 200) log('[shell-bg] exit note for ' + n.bgId + ' not delivered to run ' + runId + ' (' + out.status + ')');
      return { delivered: out.status === 200, runId: runId, status: out.status };
    }
    wake.liveRunFor = liveRunFor;
    return wake;
  }

  return { makeShellBg, makeBgExitWaker, exitNoticeText, killBudgetMs, _internals: { runTaskkill, sanitizeLine } };
});
