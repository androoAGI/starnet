/* sidecar/tools/builtin/fs.js — the CABINET capability: fs.read / fs.write / fs.list /
   fs.append / fs.edit / fs.search, jailed to <root>/<agentId>/. The path guard is the
   security spine: every model- or user-supplied path is resolved and PROVEN to stay inside
   the agent's workspace before any I/O. Node-only (node:path + node:fs/promises injected for
   testability). Matches the notebook.js / web.js tool shape.

   makeFsTools({ fsp, pathMod, root, limits }) -> { writeTool, readTool, listTool, register(reg) }
     fsp     : node:fs/promises (injectable)
     pathMod : node:path        (injectable)
     root    : absolute path to .../workspaces
     limits  : { writeBytes=1<<20, readReturn=200_000 } */
'use strict';
const { note: failNote } = require('../../failopen');
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).fs = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const { parsePatch, hunkOldText, hunkNewText, addText } = require('./patchparse.js');
  const { fuzzyFindAndReplace } = require('./fuzzymatch.js');
  const crypto = require('node:crypto');
  const { assertWorkspaceId } = require('../../workspace-reserved.js');
  const RunPaths = require('../../run-paths.js');

  /* ONE WRITER PER FILE, PROCESS-WIDE (2026-10-20, lost-update fix). Every fs mutation is read -> (await the LSP
     baseline, up to ~10 s) -> writeFile of a whole file computed from that read. makeFsTools is built PER RUN
     (index.js), and team.dispatch runs its workers with Promise.all, so two runs editing one project file
     interleaved: the later writer rewrote the file from its stale read and erased the other's change, and BOTH
     receipts said read-back-verified (each read back its own bytes). fs.append lost a line 10 runs out of 10.
     The tails live HERE, at factory scope, so the lead, its workers and any other agent in this process share
     them; per-instance state could not serialize two runs. Keys are taken in sorted order, so a multi-file
     fs.patch and a single-file writer can never deadlock. A caller holds a key only for re-read + write +
     read-back (milliseconds), never across the LSP baseline or a consent prompt, so a queued call never burns
     its own timeoutMs waiting. SCOPE: in-process only. A shell-side writer or an external editor is not locked,
     but its window shrinks from the LSP baseline (seconds) to one readFile -> writeFile (milliseconds). Keys
     are lexical paths, so two symlinked spellings of one file do not share a lock. */
  const MUTATION_TAILS = new Map();
  function mutationAbortError() { const e = new Error('fs mutation aborted'); e.name = 'AbortError'; return e; }
  function waitTurn(prev, signal) {
    if (!signal || typeof signal.addEventListener !== 'function') return prev;
    if (signal.aborted) return Promise.reject(mutationAbortError());
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(mutationAbortError());
      signal.addEventListener('abort', onAbort, { once: true });
      prev.then(() => { signal.removeEventListener('abort', onAbort); resolve(); });
    });
  }
  async function withFileLocks(keys, signal, fn) {
    const sorted = Array.from(new Set((keys || []).map(String))).sort();
    const releases = [];
    try {
      for (const k of sorted) {
        const prev = MUTATION_TAILS.get(k) || Promise.resolve();
        let release;
        const gate = new Promise((r) => { release = r; });
        const tail = prev.then(() => gate);   // the next caller waits for the holder AND for us, even if we leave early
        MUTATION_TAILS.set(k, tail);
        /* The entry is dropped only once `tail` itself has SETTLED (the holder ahead of us has let go AND so have
           we), never at our own release: a waiter aborted while still queued releases early, and deleting the entry
           then let the next caller start on Promise.resolve() beside the holder that was still writing. */
        releases.push(() => { release(); tail.then(() => { if (MUTATION_TAILS.get(k) === tail) MUTATION_TAILS.delete(k); }); });
        await waitTurn(prev, signal);
        if (signal && signal.aborted) throw mutationAbortError();   // a cancelled tool must not turn into a late write
      }
      return await fn();
    } finally {
      for (let i = releases.length - 1; i >= 0; i--) releases[i]();
    }
  }

  function safeAgentId(id) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id || '')) throw new Error('bad agentId');
    // An id equal to a station-owned directory (codex/, channels/, connectors/, plugins/ …) would make that
    // credential/code directory this agent's private jail — refuse it (sidecar/workspace-reserved.js).
    return assertWorkspaceId(id);
  }
  function kb(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }
  function emitDeliverable(ctx, aid, pathStr) {
    if (!ctx || typeof ctx.emit !== 'function') return;
    const d = { id: 'file_' + String(pathStr).replace(/[^A-Za-z0-9_.-]/g, '_'), agentId: aid, kind: 'file', title: String(pathStr) };
    if (ctx.room) d.room = ctx.room;
    ctx.emit('deliverable', d);
  }

  function makeFsTools(deps) {
    deps = deps || {};
    const fsp = deps.fsp, P = deps.pathMod, ROOT = deps.root, environment = deps.environment || null;
    if (!fsp || !P || (!ROOT && !environment)) throw new Error('fs.js requires { fsp, pathMod, root } or { fsp, pathMod, environment }');
    const WRITE_BYTES = (deps.limits && deps.limits.writeBytes) || (1 << 20);
    const READ_RETURN = (deps.limits && deps.limits.readReturn) || 200000;
    const redact = deps.redact || ((s) => s);   // §5.6: scrub secrets out of any surfaced search line (optional, default identity)
    // NS-5 CONVERSATIONAL PATH TRUST (optional): the ONE sanctioned way an fs call may reference a path
    // OUTSIDE the agent jail. Injected async guard(absPath, { scope, agentId, ctx }) -> { base, abs } | throws.
    // Wired only for the run registry (index.js). UNWIRED (the /api/file jail helper, tests) means the
    // historic behavior — every absolute path is illegal — so those surfaces stay locked to the jail.
    const pathTrust = typeof deps.pathTrust === 'function' ? deps.pathTrust : null;
    // OPTIONAL document-to-text for fs.read (.docx / .xlsx / .ipynb). Unwired = the historic behavior, where
    // those files decode as UTF-8 noise. index.js wires it with zlib.inflateRawSync.
    const docExtract = (deps.docExtract && typeof deps.docExtract.sniff === 'function') ? deps.docExtract : null;
    const imageWire = (deps.imageWire && typeof deps.imageWire.sniff === 'function') ? deps.imageWire : null;
    // Optional host-owned LSP provider. The fs tools own the mutation boundary, so they are the only place
    // that can guarantee a diagnostic baseline was captured before bytes changed. Unwired callers (the
    // route jail helper and focused fs tests) keep the historic byte-identical path.
    const editDiagnostics = deps.editDiagnostics
      && typeof deps.editDiagnostics.beginEdit === 'function'
      && typeof deps.editDiagnostics.finishEdit === 'function'
      ? deps.editDiagnostics : null;

    function sha256(data) {
      return data == null ? null : crypto.createHash('sha256').update(data).digest('hex');
    }
    function sameBytes(a, b) {
      if (a == null || b == null) return a == null && b == null;
      return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
    }
    async function readBytesOrMissing(abs) {
      try { return await fsp.readFile(abs); }
      catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
    }
    async function readUtf8OrMissing(abs) {
      try { return await fsp.readFile(abs, 'utf8'); }
      catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
    }
    function receiptLine(receipt) {
      return '[mutation receipt: ' + receipt.state + '; attempted ' + receipt.attemptedBytes + ' bytes; written '
        + receipt.writtenBytes + '; verified ' + receipt.verifiedBytes + '; sha256 ' + (receipt.sha256 || 'deleted') + ']';
    }
    /* WHERE THE BYTES WENT (issue #60). A relative path lands in the project folder when the session is project-
       scoped and in the agent's PRIVATE workspace otherwise. The receipt proved the bytes but never said which of
       the two, so a "verified" write into the private workspace read as a write into the project the shell was
       looking at, and the agent reported files as saved that the shell then found MISSING. Name the location. */
    function locationLine(rel, abs, ctx) {
      const r = String(rel == null ? '' : rel);
      if (P.win32.isAbsolute(r) || P.posix.isAbsolute(r) || /^[A-Za-z]:/.test(r)) return '';
      const scoped = !!RunPaths.rootOf(ctx);   // the run's own path decision (ctx.paths), never a second reading of ctx
      // the private case names the way into a project, like outputPlacement (#77): the bare fact left the agent stuck
      return '\n[location: ' + abs + (scoped ? '' : ' (your private workspace, not a project folder; a shell working in a project '
        + 'will not find it here. To write into a project folder, give "path" as an absolute path inside it, or work from a '
        + 'conversation scoped to that project)') + ']';
    }
    /* WHERE A PRODUCED FILE LANDED (issue #77) — locationLine's counterpart for the tools that MAKE a file
       (image_generate, voice_generate). `resolved` is resolveInside's { base, abs }. Returns the sentence that
       names the absolute location and the viewer URL that really opens it: a file in a trusted project opens
       through /api/file?project=, a private one through ?agent=. The private case also says how to export,
       because no other agent (a lead included) can read another agent's private workspace: path trust denies
       it. A bare "saved thumb.png" read as "handed over", and the lead then found "no such file". */
    async function outputPlacement(agentId, resolved) {
      const aid = safeAgentId(agentId || 'agent');
      const abs = resolved && resolved.abs, base = resolved && resolved.base;
      const enc = encodeURIComponent;
      const rel = (root) => P.relative(root, abs).split(P.sep).join('/');
      const ws = await workspaceRoot(aid);
      const wsReal = await realpathOrSelf(ws);
      if (pathInside(abs, ws) || pathInside(abs, wsReal)) {
        const r = pathInside(abs, ws) ? rel(ws) : rel(wsReal);
        return {
          abs, private: true, viewer: '/api/file?agent=' + enc(aid) + '&path=' + enc(r),
          line: 'Saved at: ' + abs + ' (your PRIVATE workspace, not a project folder: other agents, including a lead you report to, cannot read it there). '
            + 'To save into a trusted project folder instead, give "path" as an absolute path inside that project, or work from a conversation scoped to the project, where a relative "path" lands in the project folder.'
        };
      }
      if (base && !(resolved && resolved.unrestrictedHost)) {
        const r = rel(base);
        return {
          abs, private: false, viewer: '/api/file?agent=' + enc(aid) + '&path=' + enc(r) + '&project=' + enc(base),
          line: 'Saved at: ' + abs + ' (project folder ' + base + '; any agent working in this project reads it as "' + r + '").'
        };
      }
      return { abs, private: false, viewer: '', line: 'Saved at: ' + abs + '.' };
    }
    function receiptError(message, receipt) {
      const error = new Error(message + ' ' + receiptLine(receipt));
      error.mutationReceipt = receipt;
      // Alias retained for callers that use the shorter generic receipt field.
      error.receipt = receipt;
      return error;
    }
    async function verifiedMutation(spec) {
      const expected = spec.expected == null ? null : Buffer.from(spec.expected);
      const initial = spec.initial == null ? null : Buffer.from(spec.initial);
      const receipt = {
        operation: String(spec.operation), path: String(spec.path), state: 'attempted',
        phases: ['attempted'], attemptedBytes: expected ? expected.length : 0,
        writtenBytes: 0, verifiedBytes: 0, sha256: sha256(expected), actualSha256: null
      };
      try {
        await spec.mutate();
        receipt.state = 'written';
        receipt.phases.push('written');
        receipt.writtenBytes = expected ? expected.length : 0;
        const actual = await readBytesOrMissing(spec.abs);
        receipt.actualSha256 = sha256(actual);
        if (!sameBytes(actual, expected)) throw new Error('read-back bytes differ from the intended mutation');
        receipt.state = 'read-back-verified';
        receipt.phases.push('read-back-verified');
        receipt.verifiedBytes = expected ? expected.length : 0;
        return receipt;
      } catch (cause) {
        let actual = null, inspectFailed = null;
        try { actual = await readBytesOrMissing(spec.abs); } catch (e) { inspectFailed = e; }
        receipt.actualSha256 = inspectFailed ? null : sha256(actual);
        if (!inspectFailed && sameBytes(actual, expected)) {
          receipt.state = 'read-back-verified';
          if (receipt.phases.indexOf('written') < 0) receipt.phases.push('written');
          if (receipt.phases.indexOf('read-back-verified') < 0) receipt.phases.push('read-back-verified');
          receipt.writtenBytes = expected ? expected.length : 0;
          receipt.verifiedBytes = expected ? expected.length : 0;
          return receipt;
        }
        receipt.state = !inspectFailed && !sameBytes(actual, initial) ? 'partially-applied' : 'failed';
        receipt.phases.push(receipt.state);
        receipt.writtenBytes = actual ? actual.length : 0;
        throw receiptError('filesystem mutation ' + receipt.state + ' for ' + spec.path + ': ' + ((cause && cause.message) || cause), receipt);
      }
    }

    /* ONE RESOLVER (run-paths lane, 2026-10-28). The containment proof lives in sidecar/run-paths.js, unchanged, and a
       relative path is decided by the RUN's path object (ctx.paths) — the same object every other tool reads — so fs.*,
       shell, terminal, verify, media and browser.upload cannot disagree about which folder a relative path means. A
       resolver built WITHOUT the trust guard (the /api/file jail helper, the one-off route registry, tests) never
       borrows a run's authority: it stays on the legacy jail, where an absolute or project path is refused as before. */
    const resolver = RunPaths.makeResolver({ fsp, pathMod: P, root: ROOT, environment, pathTrust });
    const workspaceRoot = resolver.workspaceRoot, pathInside = resolver.pathInside;
    async function realpathOrSelf(p) {
      try { return await fsp.realpath(p); } catch (_) { return p; }
    }
    // Resolve a path and PROVE it is reachable (run-paths.js resolveFor). opts.scope ('read' | 'write') is threaded
    // to the guard so writes can stay consent-gated; opts.ctx is passed through.
    async function resolveInside(agentId, rel, opts) {
      opts = opts || {};
      if (!pathTrust) return resolver.resolveFor(agentId, rel, Object.assign({}, opts, { projectRoot: RunPaths.rootOf(opts.ctx) }));
      return RunPaths.pathsFor(opts.ctx, resolver, agentId || 'agent').resolve(rel, opts);
    }

    async function beginEditDiagnostics(aid, files, ctx) {
      if (!editDiagnostics) return null;
      // a language server that executes the project (rust-analyzer, typescript-language-server) starts only for a WATCHED run — never from an
      // unattended run's file write, which would turn write authority into code execution (2026-10-10)
      try { return await editDiagnostics.beginEdit({ agentId: aid, files, signal: ctx && ctx.signal, allowProjectExecution: !!(ctx && ctx.surface === 'interactive') }); }
      catch (e) {
        // The new baseline wait must not turn an already-cancelled tool into a late file mutation. Other LSP
        // failures degrade honestly; cancellation keeps the ordinary registry abort semantics.
        if (e && e.name === 'AbortError') throw e;
        return { failedAtBaseline: String((e && e.message) || e), items: [], unavailable: [], unsupported: [] };
      }
    }
    function diagnosticLine(d) {
      const where = String(d.file || '?') + ':' + String(d.line || 1) + ':' + String(d.col || 1);
      return where + (d.code ? ' [' + d.code + ']' : '') + ' ' + String(d.message || 'diagnostic');
    }
    /* RE-SYNC AN ABANDONED TICKET (2026-10-21). beginEdit sent the language server the PRE-edit text as an open
       document; finishEdit is the only call that sends it the bytes now on disk. A drifted edit (another run wrote
       the file during the baseline) or a refusal under the file lock used to skip it, and an open document
       overrides disk for TypeScript/pyright/rust-analyzer: later diagnostics on OTHER files were computed against a
       file that matched neither run's write. This still finishes the ticket so the server re-reads disk; the
       caller discards the delta (it would include the other run's change). */
    async function resyncDiagnostics(ticket, ctx) {
      if (!editDiagnostics || !ticket || ticket.failedAtBaseline || !(ticket.items && ticket.items.length)) return;
      try { await editDiagnostics.finishEdit(ticket, { signal: ctx && ctx.signal }); }
      catch (e) { if (!(e && e.name === 'AbortError')) failNote('fs.lsp.resync', e); }
    }
    // a refusal (or any failure) after the baseline: re-sync the server, then fail exactly as before
    const resyncThenThrow = (ticket, ctx) => async (e) => { await resyncDiagnostics(ticket, ctx); throw e; };
    async function finishEditDiagnostics(ticket, result, ctx) {
      if (!editDiagnostics || !ticket) return result;
      let delta;
      if (ticket.failedAtBaseline) {
        delta = { status: 'unavailable', reason: ticket.failedAtBaseline, added: [], removed: [], addedCount: 0, removedCount: 0 };
      } else if (ticket.drifted) {
        await resyncDiagnostics(ticket, ctx);
        delta = { status: 'unavailable', reason: ticket.drifted, added: [], removed: [], addedCount: 0, removedCount: 0 };
      } else {
        try { delta = await editDiagnostics.finishEdit(ticket, { signal: ctx && ctx.signal }); }
        catch (e) { delta = { status: 'unavailable', reason: String((e && e.message) || e), added: [], removed: [], addedCount: 0, removedCount: 0 }; }
      }
      result.diagnostics = delta;
      if (delta.status === 'available' || delta.status === 'partial') {
        const rows = (delta.added || []).slice(0, 12).map(diagnosticLine);
        let note = delta.addedCount
          ? 'LSP: ' + delta.addedCount + ' new diagnostic' + (delta.addedCount === 1 ? '' : 's') + '\n' + rows.join('\n')
          : 'LSP: no new diagnostics';
        if (delta.removedCount) note += '\nLSP: ' + delta.removedCount + ' pre-existing diagnostic' + (delta.removedCount === 1 ? '' : 's') + ' cleared';
        if (delta.status === 'partial') note += '\nLSP: some edited files were not confirmed; run verify.run for the full project check';
        result.content += '\n\n[' + note + ']';
        try {
          if (ctx && typeof ctx.emit === 'function') ctx.emit('verify.result', {
            agentId: (ctx && ctx.agentId) || 'agent', runId: ctx.runId || '', tool: 'language server',
            passed: delta.addedCount === 0, added: delta.addedCount, removed: delta.removedCount,
            summary: delta.addedCount ? delta.addedCount + ' new language-server diagnostic(s)' : 'no new language-server diagnostics'
          });
        } catch (_) {}
      } else {
        const why = String(delta.reason || (delta.status === 'unsupported'
          ? 'no detected language server supports this file type'
          : 'language-server diagnostics were unavailable'));
        result.content += '\n\n[LSP unavailable: ' + why + '. Run verify.run for project-level proof.]';
      }
      return result;
    }

    /* STALE-WRITE GUARD (2026-07-27). A delegated worker, a second agent, or the Commander's own editor can
       change a file between the moment this agent READ it and the moment it writes back. Nothing here noticed,
       so the write silently reverted the other change — the classic lost update, and the harder kind to spot
       because both sides believe they succeeded.

       THE STAMP WAS SCOPED TO fs.write (superseded: see READ-VERSION CHECK below), after tracing what each writer does:
         · fs.append appends to what it FINDS on disk.
         · fs.edit replaces an exact `find`; a drifted file either still matches (the edit lands on the NEW
           text, which is right) or misses and errors honestly.
         · fs.patch validates every hunk's context against current content before writing anything.
       fs.write is the only writer that replaces a whole file with content composed from a read that may now be
       old — so it is the only one that needs a stamp, and stamping the others would only manufacture false
       refusals.

       CORRECTION (2026-10-20): the note above once said all three "cannot clobber" because each is
       read-modify-write inside ONE call. Across CONCURRENT calls that was false: each awaits the LSP baseline
       between its read and its write, so two runs interleaved and the later one rewrote the file from its stale
       read (reproduced 20/20, both receipts "verified"). Every writer now re-reads the file under the
       process-wide per-file lock (withFileLocks above) right before it writes, and works from THOSE bytes: an
       edit or append re-applies onto them, a patch whose source moved refuses before writing anything, and an
       fs.write over a file this agent read refuses with the error below.

       A file this agent never read has no stamp and is never refused: writing a file you did not read is
       "create it", not "clobber it". One refusal per drift — the stamp is dropped so the required re-read
       re-arms it, and the agent can never be stuck in a loop it has no way to satisfy.

       READ-VERSION CHECK (2026-10-21). The re-read under the lock only covered a writer that landed WHILE a call
       was in flight. One that landed BETWEEN this agent's fs.read and its fs.edit / fs.append / fs.patch went
       unnoticed: the call worked on bytes the agent never saw, said read-back-verified, and re-stamped the file
       as observed, so the agent's next fs.write from its old read erased the other change. The stamp is now the
       sha256 of the bytes this run last read or wrote (an mtime missed same-tick writes and older-stamped copies,
       and refused a touch that changed nothing), and every mutation of a file it has a stamp for refuses BEFORE
       writing when the disk holds other bytes. fs.write keeps its stale-write error and its one-refusal drop;
       fs.edit / fs.append / fs.patch keep the stamp, so a blind retry is refused again with the same true reason
       (dropping it would make fs.edit claim "you have not read" a file it did read) until fs.read re-arms it.
       A missing file (deleted since) is not a refusal, as before. In-flight drift keeps its re-read behaviour.

       APPEND REFUSES ONLY FOR A RUN THAT READ THE FILE (2026-10-21). Every append stamped the merged file, so two runs
       that never read a shared log could not take turns: each one's next append, after the other's line, was refused
       as "changed since you last read or wrote it". fs.append now refuses only when this run fs.read the file (its
       text may build on what it read); otherwise it appends onto the current bytes, as trunk did. Its stamp moves
       only when it knew every byte it went on after (a missing file, the bytes of its stamp, or a first touch);
       otherwise the stamp keeps what the run did see and records `drift`, and so does an fs.edit / fs.append whose
       bytes another writer changed while it was in flight. fs.write / fs.edit / fs.patch still refuse on every
       stamp, and a refusal over a drifted stamp says what really happened: this run wrote the file last, on top of
       another writer's changes it has not read. */
    // agentId \0 abs -> { hash, read, drift }: hash = sha256 of the bytes this agent last SAW (read or wrote); read =
    // it fs.read the file this run (its own later writes keep the flag); drift = { op, inFlight } once its op landed on
    // another writer's bytes it never saw (see APPEND REFUSES ONLY ... above)
    const readStamps = new Map();
    const stampKey = (aid, abs) => String(aid) + '\0' + (P.sep === '\\' ? String(abs).toLowerCase() : String(abs));
    // the process-wide mutation lock key for one file (same case rule as pathInside / stampKey)
    const lockKey = (abs) => (P.sep === '\\' ? P.resolve(String(abs)).toLowerCase() : P.resolve(String(abs)));
    const DRIFT_REASON = 'the file changed on disk while this edit was in flight (another writer), so a before/after diagnostic comparison would include their change';
    // `seen` = the bytes this agent now knows the file holds (null = gone: drop the stamp); `hash` = their sha256,
    // precomputed; `fromRead` = it saw them through fs.read
    function stampSeen(aid, abs, seen, hash, fromRead) {
      const key = stampKey(aid, abs), h = hash || sha256(seen), prev = readStamps.get(key);
      if (h) readStamps.set(key, { hash: h, read: !!(fromRead || (prev && prev.read)), drift: null });
      else readStamps.delete(key);
    }
    // this agent's fs.edit / fs.append landed on another writer's bytes: the stamp keeps the bytes it saw, and says how
    function markDrift(aid, abs, op, inFlight) {
      const key = stampKey(aid, abs), st = readStamps.get(key);
      if (st) readStamps.set(key, Object.assign({}, st, { drift: { op, inFlight: !!inFlight } }));
    }
    // this agent's stamp when it has one for the file and `bytes` (what is on disk now) are not what it last saw; else null
    function changedSinceSeen(aid, abs, bytes) {
      const seen = readStamps.get(stampKey(aid, abs));
      return seen && bytes != null && sha256(bytes) !== seen.hash ? seen : null;
    }
    // why a drifted stamp's file holds bytes this agent never saw (its own op wrote the file last)
    function unseenChanges(rel, drift) {
      return rel + ' holds another writer\'s changes that you have not read: they landed '
        + (drift.inFlight ? 'while an earlier ' + drift.op + ' of yours on it was in flight, and that ' + drift.op + ' was applied on top of them'
          : 'before an earlier ' + drift.op + ' of yours on it, and that ' + drift.op + ' went on after them');
    }
    function staleWriteError(rel, drift) {
      const error = new Error(drift
        ? 'stale write refused: ' + unseenChanges(rel, drift) + '. This write would erase them, so nothing was written. fs.read it again and re-apply your change on top of the current content.'
        : 'stale write refused: ' + rel + ' changed on disk after you read it — someone else (another agent, or the Commander) edited it. Read it again and re-apply your change on top of the current content, or use fs.edit/fs.patch so your change merges instead of replacing the file.');
      error.precondition = { code: 'fresh_read_required', requiredTool: 'fs.read', requiredState: 'current_file_observed' };
      return error;
    }
    // fs.edit / fs.append / fs.patch over a file whose bytes moved since this agent last read or wrote it (`st` = its stamp)
    function changedSinceReadError(what, rel, st) {
      const error = new Error(what + ' refused: ' + (st && st.drift ? unseenChanges(rel, st.drift)
        : rel + ' changed on disk since you last read or wrote it (something else changed it: another agent, the Commander, or a process such as a shell command)')
        + ' — nothing was written. fs.read it again and redo your change against the current content.');
      error.precondition = { code: 'fresh_read_required', requiredTool: 'fs.read', requiredState: 'current_file_observed' };
      return error;
    }
    function assertFresh(aid, abs, rel, bytes) {
      const moved = changedSinceSeen(aid, abs, bytes);
      if (!moved) return;                       // never read here, deleted since, or still the bytes we saw
      readStamps.delete(stampKey(aid, abs));    // one refusal per drift; the re-read below re-arms it
      throw staleWriteError(rel, moved.drift);
    }
    // the drifted call's own result names the drift (the LSP line says so only when a language server is attached)
    const driftNote = (op, rel, what) => '\n[another writer changed ' + rel + ' while this ' + op + ' was in flight: ' + what + ', which you have not read. fs.read it before you rewrite or edit it.]';

    const writeTool = {
      name: 'fs.write', capability: 'cabinet', scope: 'write', requiresConsent: true, timeoutMs: 10000,
      description: 'Write a UTF-8 text file into the current project folder when this session is project-scoped, otherwise into your private workspace. This is where your deliverables (reports, notes, code) are saved.',
      schema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const { abs, base } = await resolveInside(aid, args.path, { scope: 'write', ctx });
        const data = Buffer.from(String(args.content), 'utf8');
        if (data.length > WRITE_BYTES) throw new Error('file too large (' + data.length + ' > ' + WRITE_BYTES + ' bytes)');
        const signal = ctx && ctx.signal, lk = lockKey(abs);
        // the stamp check and the read both run UNDER the lock: checked before it, a write still landing from
        // another run (it holds the lock) passed the check, and this write then replaced it. The read can never
        // be a torn half-file from a concurrent truncating writeFile either.
        const beforeBytes = await withFileLocks([lk], signal, async () => {
          const b = await readBytesOrMissing(abs);
          assertFresh(aid, abs, args.path, b);   // refuse to overwrite a file that moved under us
          return b;
        });
        const diagnosticTicket = await beginEditDiagnostics(aid, [{ abs, base, rel: String(args.path), text: beforeBytes ? beforeBytes.toString('utf8') : '' }], ctx);
        await fsp.mkdir(P.dirname(abs), { recursive: true });
        const receipt = await withFileLocks([lk], signal, async () => {
          // re-check under the lock: the LSP baseline above can take seconds, and another run may have written since
          const current = await readBytesOrMissing(abs);
          assertFresh(aid, abs, args.path, current);
          let initial = beforeBytes;
          if (!sameBytes(current, beforeBytes)) {
            const key = stampKey(aid, abs);
            // this agent READ the file and composed its content from that read: replacing their change is the lost update
            if (readStamps.has(key)) { readStamps.delete(key); throw staleWriteError(args.path); }
            initial = current;
            if (diagnosticTicket) diagnosticTicket.drifted = DRIFT_REASON;
          }
          const r = await verifiedMutation({ operation: 'write', path: args.path, abs, expected: data, initial, mutate: () => fsp.writeFile(abs, data) });
          stampSeen(aid, abs, data);                // our own write is the new baseline, so a rewrite never self-trips
          return r;
        }).catch(resyncThenThrow(diagnosticTicket, ctx));
        emitDeliverable(ctx, aid, args.path);
        return finishEditDiagnostics(diagnosticTicket,
          { content: 'Wrote ' + args.path + ' (' + data.length + ' bytes).\n' + receiptLine(receipt) + locationLine(args.path, abs, ctx), summary: 'wrote ' + args.path + ' (' + kb(data.length) + ')', mutationReceipt: receipt, receipt }, ctx);
      }
    };

    /* LARGE TEXT PAGES WITHOUT THE WHOLE FILE (2026-10-20). fs.read read the whole file into a Buffer, decoded ALL of
       it to a string and (numbered) split all of it into lines on EVERY call, to return one ~24k page: on a 40 MB
       parked output that was ~90-180 ms of blocking CPU and ~240 MB of transient heap per page, so following
       "next" through it cost minutes and hitched the whole station (above ~512M characters it threw). A plain
       UTF-8 file above readStreamMinBytes (default 4 MiB) now gets ONE async index pass — a checkpoint per 1 MiB
       chunk { byte, unit, line } plus the totals — cached per file (size + mtime key, so any edit invalidates it),
       and each page streams from the nearest checkpoint. Output is byte-identical to the whole-file path (same
       decoder: Buffer utf8, BOM kept; same trailers; same summary). A document or image (head sniff), a file that
       is not valid UTF-8, or an fsp without open() keeps the historic path exactly. */
    const READ_STREAM_MIN = (deps.limits && deps.limits.readStreamMinBytes != null && Number(deps.limits.readStreamMinBytes) >= 0)
      ? Number(deps.limits.readStreamMinBytes) : 4 * 1024 * 1024;
    const READ_CHUNK = 1024 * 1024, READ_HEAD = 64 * 1024;
    const isUtf8 = (() => { try { const f = require('node:buffer').isUtf8; return typeof f === 'function' ? f : null; } catch (_) { return null; } })();
    const readIndexCache = new Map();   // abs|size|mtimeMs -> index, least recently used first (8 kept)
    function readPageMax(ctx) {
      let v = ctx ? ctx.outputMax : null;
      if (typeof v === 'function') { try { v = v(); } catch (_) { v = null; } }
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n > 0 ? Math.max(2000, Math.min(READ_RETURN, n - 600)) : READ_RETURN;   // headroom: trailer + fence
    }
    // the usable length of buf[0..n): trimmed back (at most 3 bytes) so it never ends inside a UTF-8 character
    function utf8Cut(buf, n, atEof) {
      if (atEof || n === 0) return n;
      let i = n - 1, back = 0;
      while (back < 3 && i >= 0 && (buf[i] & 0xC0) === 0x80) { i--; back++; }
      if (i < 0) return n;
      const lead = buf[i], need = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
      return (n - i) < need ? i : n;
    }
    function readAbortError() { const e = new Error('fs.read aborted'); e.name = 'AbortError'; return e; }
    /* one pass over the file: checkpoints + totals + the sha256 of the bytes (the read-version stamp), or null when it
       is not valid UTF-8 (or changed size under us). It stops at the next chunk once `signal` aborts (a cancelled run,
       or the registry's tool timeout): this pass is the one part of a large read that scales with the whole file, and
       it used to run to the end of the file after the call had already been given up on. */
    async function buildReadIndex(fh, size, buf, signal) {
      const cps = [], hash = crypto.createHash('sha256');
      let byte = 0, unit = 0, line = 0, lastByte = -1;
      while (byte < size) {
        if (signal && signal.aborted) throw readAbortError();
        const { bytesRead } = await fh.read(buf, 0, Math.min(READ_CHUNK, size - byte), byte);
        if (!bytesRead) break;
        const n = utf8Cut(buf, bytesRead, byte + bytesRead >= size);
        if (n === 0) return null;
        const piece = buf.subarray(0, n);
        if (!isUtf8(piece)) return null;
        cps.push({ byte, unit, line });
        hash.update(piece);
        unit += piece.toString('utf8').length;
        for (let at = piece.indexOf(10); at >= 0; at = piece.indexOf(10, at + 1)) line++;
        lastByte = piece[n - 1];
        byte += n;
      }
      if (byte !== size) return null;
      return { size, totalUnits: unit, newlines: line, endsWithNl: lastByte === 10, cps, sha256: hash.digest('hex') };
    }
    // decoded text from checkpoint cp to the indexed end, chunk by chunk; fn(str) returns false to stop
    async function streamReadText(fh, idx, cp, buf, fn) {
      let byte = cp.byte;
      while (byte < idx.size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(READ_CHUNK, idx.size - byte), byte);
        if (!bytesRead) break;
        const n = utf8Cut(buf, bytesRead, byte + bytesRead >= idx.size);
        if (n === 0) break;
        if (fn(buf.toString('utf8', 0, n)) === false) return;
        byte += n;
      }
    }
    // the historic page, computed from the index instead of the whole decoded file (same args, same output)
    async function largeTextPage(args, fh, idx, buf, pageMax) {
      const total = idx.totalUnits;
      if (args.numbered === true && args.raw !== true) {
        const totalLines = idx.newlines + (idx.endsWithNl ? 0 : 1);
        const startLine = Math.max(1, Math.floor(Number(args.offset) || 1));
        const requestedLines = args.limit == null ? totalLines : Math.floor(Number(args.limit) || 0);
        if (requestedLines <= 0) throw new Error('limit must be a positive number');
        if (startLine > totalLines) {
          return { content: '[offset ' + startLine + ' is past the end: ' + args.path + ' has ' + totalLines + ' line' + (totalLines === 1 ? '' : 's') + ']', summary: totalLines + ' lines; nothing at line ' + startLine };
        }
        // a checkpoint sits mid-line, so start from one whose line is BEFORE the first wanted line (byte 0 is a line start)
        let cp = idx.cps[0];
        for (const c of idx.cps) { if (c.line < startLine - 1) cp = c; else break; }
        const rows = [];
        let chars = 0, endLine = startLine - 1, capped = false, li = cp.line, carry = '', stop = false;
        const take = (lineText) => {
          if (li >= startLine - 1 && li < totalLines) {
            if (rows.length >= requestedLines) { stop = true; return; }
            const row = (li + 1) + '\t' + lineText.replace(/\r$/, '');
            if (rows.length && chars + row.length + 1 > pageMax) { capped = true; stop = true; return; }
            rows.push(row); chars += row.length + 1; endLine = li + 1;
          }
          li++;
        };
        await streamReadText(fh, idx, cp, buf, (s) => {
          let from = 0, nl;
          while ((nl = s.indexOf('\n', from)) >= 0) {
            take(carry + s.slice(from, nl)); carry = ''; from = nl + 1;
            if (stop) return false;
          }
          carry += s.slice(from);
        });
        if (!stop && li < totalLines) take(carry);   // the last line, when the file does not end with a newline
        let out = rows.join('\n');
        const more = endLine < totalLines;
        if (more) out += '\n[showing lines ' + startLine + '-' + endLine + ' of ' + totalLines + (capped ? ' (output cap)' : '')
          + '; next: fs.read {"path":' + JSON.stringify(String(args.path)) + ',"numbered":true,"offset":' + (endLine + 1) + ',"limit":' + Math.min(requestedLines, Math.max(1, endLine - startLine + 1)) + '}]';
        else if (startLine > 1) out += '\n[showing lines ' + startLine + '-' + endLine + ' of ' + totalLines + '; end of file]';
        return { content: out, summary: kb(idx.size) + ' read; lines ' + startLine + '-' + endLine + ' of ' + totalLines };
      }
      const offset = Math.min(total, Math.max(0, Math.floor(Number(args.offset) || 0)));
      const requested = args.limit == null ? READ_RETURN : Math.floor(Number(args.limit) || 0);
      if (requested <= 0) throw new Error('limit must be a positive number');
      const limit = Math.min(READ_RETURN, requested, pageMax);
      const end = Math.min(total, offset + limit);
      let cp = idx.cps[0];
      for (const c of idx.cps) { if (c.unit <= offset) cp = c; else break; }
      let at = cp.unit, out = '';
      if (end > offset) {
        await streamReadText(fh, idx, cp, buf, (s) => {
          const a = Math.max(0, offset - at), b = Math.min(s.length, end - at);
          if (b > a) out += s.slice(a, b);
          at += s.length;
          return at < end;
        });
      }
      if (end < total) out += '\n[showing characters ' + offset + '-' + end + ' of ' + total
        + (limit < Math.min(READ_RETURN, requested) ? ' (page sized to fit this model\'s context window)' : '')
        + '; next: fs.read {"path":' + JSON.stringify(String(args.path)) + ',"offset":' + end + ',"limit":' + limit + '}]';
      else if (offset > 0) out += '\n[showing characters ' + offset + '-' + end + ' of ' + total + '; end of file]';
      return { content: out, summary: kb(idx.size) + ' read; characters ' + offset + '-' + end + ' of ' + total };
    }
    // the large-file path, or null = use the historic whole-file path (small file, document, image, not UTF-8)
    async function readLargeText(aid, abs, args, ctx) {
      if (!isUtf8 || typeof fsp.open !== 'function' || !(READ_STREAM_MIN < Infinity)) return null;
      let st;
      try { st = await fsp.stat(abs); }
      catch (e) { if (e && e.code === 'ENOENT') throw new Error('no such file: ' + args.path); return null; }
      if (!st || typeof st.isFile !== 'function' || !st.isFile() || !(Number(st.size) > READ_STREAM_MIN)) return null;
      const size = Number(st.size);
      const fh = await fsp.open(abs, 'r');
      try {
        const buf = Buffer.allocUnsafe(READ_CHUNK);
        const { bytesRead } = await fh.read(buf, 0, Math.min(READ_HEAD, size), 0);
        const head = Buffer.from(buf.subarray(0, bytesRead));
        if (docExtract && docExtract.sniff(args.path, head)) return null;
        if (imageWire && imageWire.sniff(args.path, head)) return null;
        const key = abs + '|' + size + '|' + Number(st.mtimeMs || 0);
        let idx = readIndexCache.get(key);
        if (idx) readIndexCache.delete(key);
        else idx = await buildReadIndex(fh, size, buf, ctx && ctx.signal);
        if (!idx) return null;
        readIndexCache.set(key, idx);
        while (readIndexCache.size > 8) readIndexCache.delete(readIndexCache.keys().next().value);
        stampSeen(aid, abs, null, idx.sha256, true);   // what this agent believes the file says, as of now (see the stale-write guard)
        return await largeTextPage(args, fh, idx, buf, readPageMax(ctx));
      } finally {
        await fh.close();
      }
    }

    const readTool = {
      name: 'fs.read', capability: 'cabinet', scope: 'read', requiresConsent: false, timeoutMs: 10000,
      description: 'Read a file by its full path, or by a path relative to the project folder (in a project session) or else your private workspace. Text comes back as text; page large text with offset and limit (character ranges) instead of rerunning the command that produced it. For source code pass numbered:true: each line is prefixed "<line number><TAB>" (cat -n style) so you can cite exact lines, and offset/limit then mean the 1-based START LINE and the NUMBER OF LINES (e.g. offset:120, limit:40). Without numbered (or with raw:true) the text is returned exactly as stored. Word (.docx), Excel (.xlsx) and Jupyter (.ipynb) files are extracted to readable text; PNG/JPEG/GIF/WEBP images are shown to you as actual pixels.',
      schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' }, numbered: { type: 'boolean' }, raw: { type: 'boolean' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const { abs } = await resolveInside(aid, args.path, { scope: 'read', ctx });
        const large = await readLargeText(aid, abs, args, ctx);   // a big plain-text file pages without the whole-file decode
        if (large) return large;
        let raw;
        try { raw = await fsp.readFile(abs); }
        catch (e) { if (e && e.code === 'ENOENT') throw new Error('no such file: ' + args.path); throw e; }
        stampSeen(aid, abs, raw, null, true);   // what this agent believes the file says, as of now (see the stale-write guard)

        /* DOCUMENTS. Decoding a .docx as UTF-8 produced binary noise: the agent could see the file existed and
           had no way to read it, on exactly the formats a Commander keeps real work in. A malformed or
           mislabelled document falls THROUGH to the plain text path rather than failing the read — a file
           someone named .docx that is really text must still be readable. */
        const kind = docExtract ? docExtract.sniff(args.path, raw) : null;
        if (kind) {
          try {
            const text = docExtract.extract(raw, kind, { maxChars: READ_RETURN });
            if (text) return { content: text, summary: kind + ' → ' + kb(Buffer.byteLength(text)) + ' of text' };
          } catch (_) { /* fall through to the plain read below */ }
        }

        /* IMAGES. Same shape as documents, same reason: the bytes are unreadable as UTF-8, so without
           this the agent could see a screenshot existed and had no way to look at it — including the
           output of its OWN image_generate call. image_analyze routes the picture to a SEPARATE vision
           model and returns prose, which steers the driving model off a description of the pixels
           instead of the pixels. Here they ride the `images` channel into the conversation itself.
           Sniffed by magic bytes, so a mislabelled file falls through to the plain read below. */
        if (imageWire) {
          const img = imageWire.sniff(args.path, raw);
          if (img) {
            const wire = imageWire.toWire(raw, img);
            const desc = imageWire.describe(img, args.path);
            return {
              content: desc + (wire.note ? '\n' + wire.note : (wire.images ? '' : '')),
              summary: img.ext + ' ' + (img.width && img.height ? img.width + '×' + img.height : kb(img.bytes)),
              images: wire.images
            };
          }
        }

        const txt = raw.toString('utf8');
        /* ONE PAGE FITS ONE RESULT (2026-10-12, live A/B proof of the Publisher report). A page was capped only by
           READ_RETURN (200k), but the registry then cut any result over the run's window-scaled budget (ctx.outputMax,
           as low as 8k) out of the MIDDLE — while the trailer below still said "next: offset <end of the whole page>".
           Paging a parked 1.4 MB API response with limit 100000 under a 27k budget lost 73k characters per call, and
           following "next" skipped them for good. A page is now sized to what the model will actually see, so "next"
           is always contiguous. No budget passed (a direct call, a test) = READ_RETURN exactly as before. */
        const pageMax = readPageMax(ctx);
        /* NUMBERED (2026-09-02, coding-tools lane). Line-cited reads are how a coding agent anchors an fs.edit or
           a diagnostic ("main.js:214"). Opt-in, because ~25 test files and the output-parking read-back path
           consume the plain default and a numbered default would change what they parse; `raw: true` is the
           explicit spelling of the plain path. Line semantics for offset/limit here match the reference
           harness's Read tool (1-based start line + line count). Line numbers are never clipped: a cap hit
           mid-page ends the page on a whole line and the trailer says which line to continue from. */
        if (args.numbered === true && args.raw !== true) {
          const lines = txt.split('\n');
          if (lines.length && lines[lines.length - 1] === '' && txt.length) lines.pop();   // a trailing newline is not an extra empty line
          const totalLines = lines.length;
          const startLine = Math.max(1, Math.floor(Number(args.offset) || 1));
          const requestedLines = args.limit == null ? totalLines : Math.floor(Number(args.limit) || 0);
          if (requestedLines <= 0) throw new Error('limit must be a positive number');
          if (startLine > totalLines) {
            return { content: '[offset ' + startLine + ' is past the end: ' + args.path + ' has ' + totalLines + ' line' + (totalLines === 1 ? '' : 's') + ']', summary: totalLines + ' lines; nothing at line ' + startLine };
          }
          const rows = [];
          let chars = 0, endLine = startLine - 1, capped = false;
          for (let i = startLine - 1; i < totalLines && rows.length < requestedLines; i++) {
            const row = (i + 1) + '\t' + lines[i].replace(/\r$/, '');
            if (rows.length && chars + row.length + 1 > pageMax) { capped = true; break; }
            rows.push(row); chars += row.length + 1; endLine = i + 1;
          }
          let out = rows.join('\n');
          const more = endLine < totalLines;
          if (more) out += '\n[showing lines ' + startLine + '-' + endLine + ' of ' + totalLines + (capped ? ' (output cap)' : '')
            + '; next: fs.read {"path":' + JSON.stringify(String(args.path)) + ',"numbered":true,"offset":' + (endLine + 1) + ',"limit":' + Math.min(requestedLines, Math.max(1, endLine - startLine + 1)) + '}]';
          else if (startLine > 1) out += '\n[showing lines ' + startLine + '-' + endLine + ' of ' + totalLines + '; end of file]';
          return { content: out, summary: kb(Buffer.byteLength(txt)) + ' read; lines ' + startLine + '-' + endLine + ' of ' + totalLines };
        }
        const offset = Math.min(txt.length, Math.max(0, Math.floor(Number(args.offset) || 0)));
        const requested = args.limit == null ? READ_RETURN : Math.floor(Number(args.limit) || 0);
        if (requested <= 0) throw new Error('limit must be a positive number');
        const limit = Math.min(READ_RETURN, requested, pageMax);
        const end = Math.min(txt.length, offset + limit);
        let out = txt.slice(offset, end);
        if (end < txt.length) out += '\n[showing characters ' + offset + '-' + end + ' of ' + txt.length
          + (limit < Math.min(READ_RETURN, requested) ? ' (page sized to fit this model\'s context window)' : '')
          + '; next: fs.read {"path":' + JSON.stringify(String(args.path)) + ',"offset":' + end + ',"limit":' + limit + '}]';
        else if (offset > 0) out += '\n[showing characters ' + offset + '-' + end + ' of ' + txt.length + '; end of file]';
        return { content: out, summary: kb(Buffer.byteLength(txt)) + ' read; characters ' + offset + '-' + end + ' of ' + txt.length };
      }
    };

    /* recursive directory walk -> relative paths (dirs end with '/'), bounded so a huge tree can't flood the prompt.
       NOT EXPANDED (token-burn audit 2026-10-17): VCS internals, dependency trees, build/tool caches and a browser profile's
       cache folders. One recursive listing on a real station was 58 KB, 85-93% of it .git / node_modules / a Chrome test
       profile, and it rode every later call of the run (~1.5M tokens) while pushing the real files past the cap. Each such
       folder is still LISTED, marked, so the model knows it exists and how to look inside — never silently hidden. */
    const LIST_NOT_EXPANDED = new Set(['.git', '.hg', '.svn', 'node_modules', 'bower_components', '__pycache__', '.venv', 'venv',
      '.cache', '.next', '.nuxt', '.turbo', '.parcel-cache', '.gradle', '.pytest_cache', '.mypy_cache',
      'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
      'Service Worker', 'IndexedDB', 'blob_storage', 'Crashpad']);
    const LIST_MAX_CHARS = 16000;
    // `hintBase` = the path the CALLER listed, so a not-expanded hint names a path that resolves where the folder really is
    async function walk(absDir, prefix, out, limit, budget, hintBase) {
      let entries;
      try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
      catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
      // at the cap already: anything this folder holds is dropped, and the listing must say so
      if (out.length >= limit || budget.chars >= LIST_MAX_CHARS) { if (entries.length) budget.truncated = true; return; }
      for (const ent of entries) {
        if (out.length >= limit || budget.chars >= LIST_MAX_CHARS) { budget.truncated = true; return; }
        const rel = prefix ? (prefix + '/' + ent.name) : ent.name;
        let line = rel;
        if (ent.isDirectory() && LIST_NOT_EXPANDED.has(ent.name)) {
          const hint = hintBase ? (P.isAbsolute(hintBase) ? P.join(hintBase, rel) : hintBase.replace(/\\/g, '/') + '/' + rel) : rel;
          line = rel + '/  [not expanded — fs.list {"path":' + JSON.stringify(hint) + '} to look inside]';
        } else if (ent.isDirectory()) line = rel + '/';
        out.push(line); budget.chars += line.length + 1;
        if (ent.isDirectory() && !LIST_NOT_EXPANDED.has(ent.name)) await walk(P.join(absDir, ent.name), rel, out, limit, budget, hintBase);
      }
    }

    const listTool = {
      name: 'fs.list', capability: 'cabinet', scope: 'read', requiresConsent: false, timeoutMs: 8000,
      description: 'List files in your workspace. recursive:true shows the whole tree (directories end with /); path lists one folder, full paths too.',
      schema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } } },
      run: async (args, ctx) => {
        const { abs } = await resolveInside((ctx && ctx.agentId) || 'agent', (args && args.path) || '.', { scope: 'read', ctx });
        if (args && args.recursive) {
          const listed = (args && args.path && String(args.path).trim() !== '.') ? String(args.path).trim().replace(/[\\/]+$/, '') : '';
          const out = [], budget = { chars: 0, truncated: false }; await walk(abs, '', out, 500, budget, listed);
          if (budget.truncated) out.push('…[truncated at ' + out.length + ' entries — list one subdirectory with fs.list {"path":"<dir>","recursive":true}, or find files with fs.search]');
          return { content: out.length ? out.join('\n') : '(empty)', summary: out.length + ' entr' + (out.length === 1 ? 'y' : 'ies') + (budget.truncated ? ' (truncated)' : '') };
        }
        let names;
        try { names = await fsp.readdir(abs); }
        catch (e) { if (e && e.code === 'ENOENT') return { content: '(empty)', summary: '0 files' }; throw e; }
        return { content: names.length ? names.join('\n') : '(empty)', summary: names.length + ' file(s)' };
      }
    };

    const appendTool = {
      name: 'fs.append', capability: 'cabinet', scope: 'write', requiresConsent: true, timeoutMs: 10000,
      description: 'Append UTF-8 text to a workspace file (creates it if missing) WITHOUT rewriting what is already there. Use this to add to a file you are building up.',
      schema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const { abs, base } = await resolveInside(aid, args.path, { scope: 'write', ctx });
        const signal = ctx && ctx.signal, lk = lockKey(abs);
        const existingBytes = await withFileLocks([lk], signal, () => readBytesOrMissing(abs));   // never a torn read
        // a file this run READ that has changed since: its text may build on bytes it never saw (read-version check).
        // A run that only wrote or appended it appends onto the current bytes, as trunk did.
        const moved = changedSinceSeen(aid, abs, existingBytes);
        if (moved && moved.read) throw changedSinceReadError('append', args.path, moved);
        const existing = existingBytes ? existingBytes.toString('utf8') : '';
        const combined = existing + String(args.content);
        let bytes = Buffer.byteLength(combined, 'utf8');
        if (bytes > WRITE_BYTES) throw new Error('file too large after append (' + bytes + ' > ' + WRITE_BYTES + ' bytes)');
        const diagnosticTicket = await beginEditDiagnostics(aid, [{ abs, base, rel: String(args.path), text: existing }], ctx);
        await fsp.mkdir(P.dirname(abs), { recursive: true });
        let drifted = false;
        const receipt = await withFileLocks([lk], signal, async () => {
          // re-read under the lock and append to what is there NOW: another run's line written during our LSP
          // baseline used to be erased by a whole-file write composed from the older read
          const current = await readBytesOrMissing(abs);
          let initial = existingBytes, all = combined;
          if (!sameBytes(current, existingBytes)) {
            all = (current ? current.toString('utf8') : '') + String(args.content);
            bytes = Buffer.byteLength(all, 'utf8');
            if (bytes > WRITE_BYTES) throw new Error('file too large after append (' + bytes + ' > ' + WRITE_BYTES + ' bytes)');
            initial = current; drifted = true;
            if (diagnosticTicket) diagnosticTicket.drifted = DRIFT_REASON;
          }
          const expected = Buffer.from(all, 'utf8');
          const r = await verifiedMutation({ operation: 'append', path: args.path, abs, expected, initial, mutate: () => fsp.writeFile(abs, expected) });
          // our own append is the new baseline — a later fs.write must not read as a third-party race — when this
          // agent knew every byte it went on after: a missing file, the bytes of its stamp, or (no stamp, no drift)
          // a first touch, as trunk. Otherwise the file holds another writer's bytes it never saw: the stamp keeps
          // what it saw and records the drift, so its next fs.write / fs.edit is refused, saying so, until it reads
          const st = readStamps.get(stampKey(aid, abs));
          if (initial == null || (st ? sha256(initial) === st.hash : !drifted)) stampSeen(aid, abs, expected);
          else markDrift(aid, abs, 'fs.append', drifted);
          return r;
        }).catch(resyncThenThrow(diagnosticTicket, ctx));
        emitDeliverable(ctx, aid, args.path);
        const added = Buffer.byteLength(String(args.content), 'utf8');
        return finishEditDiagnostics(diagnosticTicket,
          { content: 'Appended to ' + args.path + ' (+' + added + ' bytes, now ' + bytes + ').\n' + receiptLine(receipt) + locationLine(args.path, abs, ctx)
              + (drifted ? driftNote('fs.append', args.path, 'your text went on after their changes') : ''),
            summary: 'appended ' + args.path + ' (+' + kb(added) + ')', mutationReceipt: receipt, receipt }, ctx);
      }
    };

    /* READ-BEFORE-EDIT (2026-09-02, coding-tools lane). fs.edit used to accept a "find" the agent had never seen:
       a guessed snippet against a file it never opened this run, or a file it read before someone else's
       change. The stamp ledger already records every file this agent observed (fs.read / its own writes), so
       an edit against a file with NO stamp is refused with the same machine-readable precondition the
       stale-write guard uses — the loop tells the model exactly which tool satisfies it. Cheap: one Map lookup.
       A file this agent WROTE (fs.write / fs.append / fs.patch / a prior fs.edit) is stamped too, so
       create-then-edit never trips. */
    function assertObserved(aid, abs, rel) {
      if (readStamps.has(stampKey(aid, abs))) return;
      const error = new Error('edit refused: you have not read ' + rel + ' in this run — fs.read it first so your "find" matches the current content exactly.');
      error.precondition = { code: 'read_before_edit', requiredTool: 'fs.read', requiredState: 'current_file_observed' };
      throw error;
    }

    const editTool = {
      name: 'fs.edit', capability: 'cabinet', scope: 'write', requiresConsent: true, timeoutMs: 10000,
      description: 'Edit a workspace file by exact text replacement of find with replace. find must match EXACTLY ONE place in the file; if it matches more, the edit is refused and the count reported: include more surrounding lines to make it unique, or pass replace_all:true to change every occurrence, or expected_count:N to assert exactly N replacements. Requires that you fs.read the file first (in this run). Prefer fs.patch for multi-line source edits.',
      schema: { type: 'object', required: ['path', 'find', 'replace'], properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, replace_all: { type: 'boolean' }, expected_count: { type: 'number' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const { abs, base } = await resolveInside(aid, args.path, { scope: 'write', ctx });
        const signal = ctx && ctx.signal, lk = lockKey(abs);
        // read under the lock: a concurrent truncating writeFile once produced a false '"find" text not found'
        const initialBytes = await withFileLocks([lk], signal, () => readBytesOrMissing(abs));
        if (initialBytes == null) throw new Error('no such file: ' + args.path);
        assertObserved(aid, abs, args.path);
        // observed, but the file has changed since: "find" would land on bytes the agent never saw (read-version check)
        const moved = changedSinceSeen(aid, abs, initialBytes);
        if (moved) throw changedSinceReadError('edit', args.path, moved);
        const txt = initialBytes.toString('utf8');
        const find = String(args.find);
        if (!find) throw new Error('"find" must be a non-empty string');
        /* UNIQUENESS. Replacing EVERY occurrence silently was the audit's top finding: a "find" like `return x;`
           rewrote five functions when the model meant one, and the result line said "5 replacements" only after
           the damage. Exactly-one-match keeps the historic path; more than one must be asked for explicitly. */
        const replaceAll = args.replace_all === true;
        const expectedCount = args.expected_count == null ? null : Math.floor(Number(args.expected_count));
        // the whole match/count/size verdict for one version of the file — run on the first read, and again on the
        // bytes found under the lock when another writer changed the file in between (same errors either way)
        function planEdit(text) {
          if (text.indexOf(find) < 0) throw new Error('"find" text not found in ' + args.path + ' — read the file and match it exactly');
          const count = text.split(find).length - 1;
          if (expectedCount != null && (!(expectedCount >= 1) || !isFinite(expectedCount))) throw new Error('"expected_count" must be a positive integer');
          if (expectedCount != null && count !== expectedCount) throw new Error('"find" matches ' + count + ' place' + (count === 1 ? '' : 's') + ' in ' + args.path + ' but expected_count is ' + expectedCount + ' — nothing was changed. Re-read the file and adjust "find" or expected_count.');
          if (count > 1 && !replaceAll && expectedCount == null) throw new Error('"find" matches ' + count + ' places in ' + args.path + ' — nothing was changed. Include more surrounding text so "find" is unique to the ONE place you mean, or pass { "replace_all": true } to change all ' + count + ', or { "expected_count": ' + count + ' } to confirm that count.');
          const next = text.split(find).join(String(args.replace));
          const bytes = Buffer.byteLength(next, 'utf8');
          if (bytes > WRITE_BYTES) throw new Error('file too large after edit (' + bytes + ' > ' + WRITE_BYTES + ' bytes)');
          return { next, count };
        }
        let plan = planEdit(txt);
        // the baseline stays OUTSIDE the lock: it can take ~10 s, and queued edits would time out behind it
        const diagnosticTicket = await beginEditDiagnostics(aid, [{ abs, base, rel: String(args.path), text: txt }], ctx);
        let drifted = false;
        const receipt = await withFileLocks([lk], signal, async () => {
          const current = await readBytesOrMissing(abs);
          if (current == null) throw new Error('no such file: ' + args.path);
          let initial = initialBytes;
          if (!sameBytes(current, initialBytes)) {
            // another writer landed during the baseline: the edit lands on THEIR text (a vanished or now-ambiguous
            // "find" refuses with the ordinary errors), never on the stale read that would erase their change
            plan = planEdit(current.toString('utf8'));
            initial = current; drifted = true;
            if (diagnosticTicket) diagnosticTicket.drifted = DRIFT_REASON;
          }
          const expected = Buffer.from(plan.next, 'utf8');
          const r = await verifiedMutation({ operation: 'edit', path: args.path, abs, expected, initial, mutate: () => fsp.writeFile(abs, expected) });
          // our own edit is the new baseline: read -> edit -> write used to refuse with a FABRICATED "someone else
          // edited it" story. NOT after a drift: the agent never saw the other writer's bytes now in the file, so
          // its old stamp stays (marked drifted) and a later fs.write from its stale view is refused until it reads the file again
          if (!drifted) stampSeen(aid, abs, expected);
          else markDrift(aid, abs, 'fs.edit', true);
          return r;
        }).catch(resyncThenThrow(diagnosticTicket, ctx));
        const count = plan.count;
        emitDeliverable(ctx, aid, args.path);
        return finishEditDiagnostics(diagnosticTicket,
          { content: 'Edited ' + args.path + ' (' + count + ' replacement' + (count === 1 ? '' : 's') + ').\n' + receiptLine(receipt)
              + (drifted ? driftNote('fs.edit', args.path, 'your replacement was applied to their version') : ''),
            summary: 'edited ' + args.path + ' (' + count + 'x)', mutationReceipt: receipt, receipt }, ctx);
      }
    };

    const patchTool = {
      name: 'fs.patch', capability: 'cabinet', scope: 'write', requiresConsent: true, timeoutMs: 15000,
      description: 'Apply a V4A multi-hunk patch inside your workspace. Prefer this for multi-line source edits instead of temporary patch scripts or shell-quoted rewrites. Validates every path and hunk before writing, so a failed hunk leaves files unchanged.',
      schema: { type: 'object', required: ['patch'], properties: { patch: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const parsed = parsePatch(args && args.patch);
        if (!parsed.ok) throw new Error(parsed.error);

        const plans = new Map(); // abs -> { rel, abs, exists, content, touched }
        async function planFor(rel) {
          const resolved = await resolveInside(aid, rel, { scope: 'write', ctx });
          const key = resolved.abs;
          if (plans.has(key)) return plans.get(key);
          let content = null, exists = false;
          // under the per-file lock so a concurrent writer's truncating writeFile is never read half-written
          const bytes = await withFileLocks([lockKey(key)], ctx && ctx.signal, readBytesOrMissing.bind(null, key));
          // a file this agent read that has changed since: hunks would match bytes it never saw (read-version check)
          const moved = changedSinceSeen(aid, key, bytes);
          if (moved) throw changedSinceReadError('fs.patch', String(rel), moved);
          content = bytes == null ? null : bytes.toString('utf8');
          exists = content != null;
          const plan = { rel: String(rel), abs: key, base: resolved.base, exists, content, initialContent: content, touched: false };
          plans.set(key, plan);
          return plan;
        }
        function assertSize(rel, content) {
          const bytes = Buffer.byteLength(String(content), 'utf8');
          if (bytes > WRITE_BYTES) throw new Error('file too large after patch for ' + rel + ' (' + bytes + ' > ' + WRITE_BYTES + ' bytes)');
        }
        function requireExists(plan, op) {
          if (!plan.exists || plan.content == null) throw new Error(op + ' target does not exist: ' + plan.rel);
        }
        function requireMissing(plan, op) {
          if (plan.exists || plan.content != null) throw new Error(op + ' target already exists: ' + plan.rel);
        }

        for (const op of parsed.operations) {
          if (op.type === 'add') {
            const plan = await planFor(op.path);
            requireMissing(plan, 'ADD');
            const next = addText(op);
            assertSize(op.path, next);
            plan.content = next;
            plan.exists = true;
            plan.touched = true;
          } else if (op.type === 'delete') {
            const plan = await planFor(op.path);
            requireExists(plan, 'DELETE');
            plan.content = null;
            plan.exists = false;
            plan.touched = true;
          } else if (op.type === 'move') {
            const src = await planFor(op.path);
            const dst = await planFor(op.newPath);
            requireExists(src, 'MOVE');
            if (src.abs !== dst.abs) requireMissing(dst, 'MOVE');
            dst.content = src.content;
            dst.exists = true;
            dst.touched = true;
            if (src.abs !== dst.abs) {
              src.content = null;
              src.exists = false;
              src.touched = true;
            }
          } else if (op.type === 'update') {
            const plan = await planFor(op.path);
            requireExists(plan, 'UPDATE');
            let current = plan.content;
            for (let h = 0; h < op.hunks.length; h++) {
              const hunk = op.hunks[h];
              const oldText = hunkOldText(hunk);
              const newText = hunkNewText(hunk);
              const res = fuzzyFindAndReplace(current, oldText, newText);
              // name the hunk: in a multi-hunk update the model must know WHICH one to re-copy from the file
              if (!res.ok) {
                const where = 'UPDATE ' + op.path + ' (hunk ' + (h + 1) + '/' + op.hunks.length + '): ';
                // Hunks match the text as earlier hunks left it, not the file on disk. When this hunk
                // matches the disk file but not that text, "fs.read and copy verbatim" would repeat
                // the same refusal: name the earlier hunk as the cause instead.
                const staleAfterEarlierHunk = /^Could not find a match/.test(res.error)
                  && typeof plan.initialContent === 'string' && current !== plan.initialContent
                  && fuzzyFindAndReplace(plan.initialContent, oldText, newText).ok;
                if (staleAfterEarlierHunk) {
                  throw new Error(where + 'Could not find a match for patch hunk: an earlier hunk in this patch already changed these lines. Write this hunk against the text as the earlier hunks leave it, or merge the overlapping hunks into one.');
                }
                throw new Error(where + res.error);
              }
              current = res.content;
            }
            assertSize(op.path, current);
            if (op.newPath) {
              const dst = await planFor(op.newPath);
              if (plan.abs !== dst.abs) requireMissing(dst, 'MOVE');
              dst.content = current;
              dst.exists = true;
              dst.touched = true;
              if (plan.abs !== dst.abs) {
                plan.content = null;
                plan.exists = false;
                plan.touched = true;
              } else {
                plan.content = current;
                plan.touched = true;
              }
            } else {
              plan.content = current;
              plan.touched = true;
            }
          } else {
            throw new Error('unsupported patch operation: ' + op.type);
          }
        }

        const touched = Array.from(plans.values()).filter(p => p.touched);
        const diagnosticTicket = await beginEditDiagnostics(aid,
          touched.map(plan => ({ abs: plan.abs, base: plan.base, rel: plan.rel, text: plan.initialContent == null ? '' : plan.initialContent })), ctx);
        // every touched file, locked together (sorted keys inside withFileLocks: no deadlock with a one-file writer)
        const patchReceipt = await withFileLocks(touched.map(plan => lockKey(plan.abs)), ctx && ctx.signal, async () => {
          /* The hunks were matched against the reads above; the baseline then waited, and another run may have
             written one of these files since. Writing now would rebuild it from the old read and erase that change,
             so a moved source refuses BEFORE any byte is written. Re-running the same patch re-matches by context,
             but a re-run over a file this agent has a read stamp for is refused by the read-version check (the stamp
             still holds the pre-drift bytes) until fs.read re-arms it, so the advice names those files to read first. */
          const drifted = [];
          for (const plan of touched) {
            if (await readUtf8OrMissing(plan.abs) !== plan.initialContent) drifted.push(plan);
          }
          if (drifted.length) {
            const stamped = drifted.filter(plan => readStamps.has(stampKey(aid, plan.abs)));
            const next = stamped.length ? 'fs.read ' + stamped.map(plan => plan.rel).join(', ') + ' again, then re-run the fs.patch' : 'Re-run the same fs.patch';
            throw new Error('fs.patch refused: ' + drifted.map(plan => plan.rel).join(', ') + ' changed on disk while this patch was being prepared (another agent or process wrote '
              + (drifted.length === 1 ? 'it' : 'them') + ') — nothing was written. ' + next + '; its hunks match by context.');
          }
          const patchReceipt = {
            operation: 'patch', path: touched.map(p => p.rel).join(', '), state: 'attempted', phases: ['attempted'],
            attemptedBytes: touched.reduce((n, p) => n + (p.content == null ? 0 : Buffer.byteLength(p.content, 'utf8')), 0), writtenBytes: 0, verifiedBytes: 0, sha256: null, files: []
          };
          try {
            // Apply destinations/updated files before deletes. In particular, a move must never
            // remove the last source copy until its destination was written and read back exactly.
            const ordered = touched.filter(plan => plan.content != null)
              .concat(touched.filter(plan => plan.content == null));
            for (const plan of ordered) {
              const expected = plan.content == null ? null : Buffer.from(plan.content, 'utf8');
              const initial = plan.initialContent == null ? null : Buffer.from(plan.initialContent, 'utf8');
              if (expected) await fsp.mkdir(P.dirname(plan.abs), { recursive: true });
              const fileReceipt = await verifiedMutation({
                operation: expected ? 'patch-write' : 'patch-delete', path: plan.rel, abs: plan.abs,
                expected, initial, mutate: () => expected ? fsp.writeFile(plan.abs, expected) : fsp.rm(plan.abs, { force: true })
              });
              stampSeen(aid, plan.abs, expected);   // our own patch is the new baseline for the stale-write guard (deletes drop the stamp)
              patchReceipt.files.push(fileReceipt);
            }
            patchReceipt.state = 'read-back-verified';
            patchReceipt.phases.push('written', 'read-back-verified');
            patchReceipt.writtenBytes = patchReceipt.files.reduce((n, r) => n + r.writtenBytes, 0);
            patchReceipt.verifiedBytes = patchReceipt.files.reduce((n, r) => n + r.verifiedBytes, 0);
          } catch (cause) {
            patchReceipt.files = [];
            let expectedCount = 0, initialCount = 0;
            for (const plan of touched) {
              const expected = plan.content == null ? null : Buffer.from(plan.content, 'utf8');
              const initial = plan.initialContent == null ? null : Buffer.from(plan.initialContent, 'utf8');
              let actual = null, unreadable = false;
              try { actual = await readBytesOrMissing(plan.abs); } catch (_) { unreadable = true; }
              const state = !unreadable && sameBytes(actual, expected) ? 'read-back-verified'
                : (!unreadable && sameBytes(actual, initial) ? 'failed' : 'partially-applied');
              if (state === 'read-back-verified') expectedCount++;
              if (state === 'failed') initialCount++;
              patchReceipt.files.push({
                operation: expected ? 'patch-write' : 'patch-delete', path: plan.rel, state,
                phases: ['attempted', state], attemptedBytes: expected ? expected.length : 0,
                writtenBytes: actual ? actual.length : 0, verifiedBytes: state === 'read-back-verified' && expected ? expected.length : 0,
                sha256: sha256(expected), actualSha256: unreadable ? null : sha256(actual)
              });
            }
            patchReceipt.state = expectedCount === touched.length ? 'read-back-verified'
              : (initialCount === touched.length ? 'failed' : 'partially-applied');
            patchReceipt.phases.push(patchReceipt.state);
            patchReceipt.writtenBytes = patchReceipt.files.reduce((n, r) => n + r.writtenBytes, 0);
            patchReceipt.verifiedBytes = patchReceipt.files.reduce((n, r) => n + r.verifiedBytes, 0);
            throw receiptError('filesystem patch ' + patchReceipt.state + ': ' + ((cause && cause.message) || cause), patchReceipt);
          }
          return patchReceipt;
        }).catch(resyncThenThrow(diagnosticTicket, ctx));
        for (const plan of touched) if (plan.content != null) emitDeliverable(ctx, aid, plan.rel);
        return finishEditDiagnostics(diagnosticTicket, {
          content: 'Applied patch: ' + touched.length + ' file' + (touched.length === 1 ? '' : 's') + ' changed.\n' + receiptLine(patchReceipt),
          summary: 'patched ' + touched.length + ' file' + (touched.length === 1 ? '' : 's'),
          mutationReceipt: patchReceipt,
          receipt: patchReceipt
        }, ctx);
      }
    };

    // fs.search — a ripgrep-grade content/file search over the agent's workspace, in PURE Node (no `rg`
    // dependency, so it runs on a clean machine — our "bundle Node, no system deps" rule). Mirrors the
    // polished behaviour of a grep+find+ls replacement: target 'content' (grep) | 'files' (find/ls by glob,
    // newest-first); output_mode 'content'|'files_only'|'count'; file_glob filter; context lines; limit/offset
    // paging with an actionable next-offset hint; path-grouped ("densified") output above a few matches.
    // Jailed + bounded like every fs.* tool: skips hidden entries (rg default) + node_modules, oversized +
    // binary files, caps files scanned; redacts secrets out of every surfaced line (§5.6).
    // SEARCH_MAX_FILES 4000 -> 20000 (2026-09-02): with .gitignore pruning the walk no longer burns the cap on
    // build output, and 4000 was under one mid-sized project's source count. Per-call override: `max_files`.
    /* A FILE TOO BIG TO SEARCH MUST NEVER READ AS "NO MATCHES" (2026-10-12, live A/B proof of the Publisher report). The
       per-file cap was 512 KB and both engines skipped a bigger file without a word, so fs.search "Oceania" over a parked
       1.4 MB API response answered "(no matches for Oceania)" — a confident false negative on exactly the files every
       output-cap note tells the model to search. Folder scans now cover 8 MB per file, a file named as `path` 64 MB, and
       anything still skipped is NAMED in the result instead of vanishing (the walker knows; rg's --max-filesize is silent,
       so a >8 MB file inside a folder scan on the rg engine is the one remaining unnamed skip). */
    const SEARCH_MAX_FILE_BYTES = 8 * 1024 * 1024, SEARCH_NAMED_FILE_BYTES = 64 * 1024 * 1024, SEARCH_MAX_FILES = 20000, SEARCH_MAX_FILES_CEILING = 100000, SEARCH_LINE_CHARS = 500, SEARCH_DENSIFY_MIN = 5;
    const SEARCH_MAX_MATCHES = 20000;   // rg path: stop draining after this many matching lines (JS path is bounded by files + time)

    /* RIPGREP, WHEN THE MACHINE HAS IT (2026-09-02). The pure-JS walker stays the guaranteed path (bundle Node,
       no system deps), but a developer box with `rg` on PATH gets ripgrep's speed and its .gitignore engine for
       the same call, same output. Detection is injected: deps.rg = an explicit binary path, or false to force
       the walker; otherwise, when a spawn is injected, ONE `rg --version` probe decides for the process
       lifetime. No spawn (the route jail helper, focused tests) means no rg — the historic behaviour exactly.
       Same jail: rg runs with cwd pinned to the resolved search dir, never follows symlinks (its default), skips
       hidden + node_modules like the walker, and is KILLED at the same wall-clock budget. Any rg failure
       (regex dialect it rejects, spawn error, exit 2) falls back to the walker — rg is an accelerator, never a
       new failure mode. */
    const spawnFn = typeof deps.spawn === 'function' ? deps.spawn : null;
    let rgProbe = null;
    function rgBinary() {
      if (deps.rg === false || (!spawnFn)) return Promise.resolve(null);
      if (typeof deps.rg === 'string' && deps.rg) return Promise.resolve(deps.rg);
      if (rgProbe) return rgProbe;
      rgProbe = new Promise((resolve) => {
        let child;
        try { child = spawnFn('rg', ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
        catch (_) { return resolve(null); }
        let settled = false;
        const done = (ok) => { if (!settled) { settled = true; resolve(ok ? 'rg' : null); } };
        child.on('error', () => done(false));
        child.on('close', (code) => done(code === 0));
        if (child.stdout) child.stdout.on('data', () => {});
        const t = setTimeout(() => { try { child.kill(); } catch (e) { failNote('fs.search.rg.probe.kill', e); } done(false); }, 3000);
        if (t && typeof t.unref === 'function') t.unref();
      });
      return rgProbe;
    }
    // Run rg with cwd = absDir, drain stdout line by line into onLine, kill at the budget. Resolves
    // { ok, code, timedOut, stopped } — ok=false means "fall back to the walker".
    function runRg(bin, argv, absDir, onLine, budgetMs, signal) {
      return new Promise((resolve) => {
        // an already-cancelled run spawns nothing (its abort event fired before we could listen for it);
        // the caller sees its clock aborted and throws
        if (signal && signal.aborted) return resolve({ ok: false, aborted: true });
        let child;
        try { child = spawnFn(bin, argv, { cwd: absDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (_) { return resolve({ ok: false }); }
        let settled = false, timedOut = false, stopped = false, buf = '', stderr = '';
        const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
        const stop = () => { stopped = true; try { child.kill(); } catch (e) { failNote('fs.search.rg.stop.kill', e); } };
        const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch (e) { failNote('fs.search.rg.budget.kill', e); } }, budgetMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
        if (signal) { try { signal.addEventListener('abort', stop, { once: true }); } catch (e) { failNote('fs.search.rg.abort.listen', e); } }
        const feed = (chunk) => {
          if (stopped || timedOut) return;
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (line && onLine(line) === false) { stop(); return; }
          }
        };
        child.stdout.setEncoding('utf8'); child.stdout.on('data', feed);
        child.stderr.setEncoding('utf8'); child.stderr.on('data', (s) => { if (stderr.length < 4000) stderr += s; });
        child.on('error', () => finish({ ok: false }));
        child.on('close', (code) => {
          if (buf && !stopped && !timedOut) { const line = buf; buf = ''; onLine(line); }
          // rg: 0 = matches, 1 = no matches, 2 = error (bad regex, unreadable root). A kill we ordered is fine.
          const ok = timedOut || stopped || code === 0 || code === 1;
          finish({ ok, code, timedOut, stopped, stderr });
        });
      });
    }
    // Longest line handed to a MODEL-SUPPLIED regex, and the wall-clock ceiling for the whole search (walk included).
    const SEARCH_MATCH_CHARS = 2000, SEARCH_TIME_BUDGET_MS = 8000;
    const SEARCH_BUDGET_MS = (deps.limits && Number(deps.limits.searchBudgetMs) > 0) ? Number(deps.limits.searchBudgetMs) : SEARCH_TIME_BUDGET_MS;

    /* CATASTROPHIC-BACKTRACKING FLOOR (measured 2026-07-26).
       `fs.search { regex: true }` compiles the MODEL's string and runs it synchronously over every line of
       every candidate file. StarNet is ONE process — UI, API, SSE bus and every agent run — and a
       backtracking blow-up pegs the event loop, so a single call froze the entire station indefinitely:
       `(a|a)+$` against a 41-character line never returned, and the tool's own timeoutMs could not help
       (registry withTimeout REJECTS the promise; it cannot stop synchronous work). Only killing the process
       recovered. This needs no adversary — `(\s+)+$` or `(.*)*foo` are patterns a model writes by accident
       when searching code.

       Two bounds, and one honest limit. (1) refuse the shapes that actually blow up: an unbounded quantifier
       applied to a group whose body itself contains an unbounded quantifier, or an alternation with
       overlapping branches. (2) cap the input any one match sees, since blow-up scales with input length.
       LIMIT: this is a heuristic, exactly like shell.js's command floor — a determined pattern outside these
       shapes can still be slow. The durable fix is to run the match off the main loop (a worker with
       terminate(), the same "killable child" posture shell.exec already uses); until then the floor catches
       the realistic cases and the time budget below bounds everything polynomial. */
    const UNBOUNDED_Q = /[+*]|\{\d+,\}/;
    function groupBodies(src) {
      const out = [];
      for (let i = 0; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] !== '(') continue;
        let depth = 1, j = i + 1;
        for (; j < src.length && depth > 0; j++) {
          if (src[j] === '\\') { j++; continue; }
          if (src[j] === '(') depth++;
          else if (src[j] === ')') depth--;
        }
        if (depth !== 0) break;                                   // unbalanced — the RegExp ctor will reject it
        const body = src.slice(i + 1, j - 1);
        const after = src.slice(j);                               // what follows the closing paren
        if (/^(?:[+*]|\{\d+,\})/.test(after)) out.push(body);     // this group is under an unbounded quantifier
      }
      return out;
    }
    function catastrophicRegex(src) {
      for (const body of groupBodies(String(src))) {
        const inner = body.replace(/^\?[:=!<][a-zA-Z]*/, '');     // drop a (?: (?= (?! (?<= prefix
        if (UNBOUNDED_Q.test(inner)) return 'a repeated group that itself repeats';
        const alts = inner.split('|');
        if (alts.length > 1) {
          for (let a = 0; a < alts.length; a++) for (let b = a + 1; b < alts.length; b++) {
            const x = alts[a], y = alts[b];
            if (x && y && (x === y || x.indexOf(y) === 0 || y.indexOf(x) === 0)) return 'a repeated group whose alternatives overlap';
          }
        }
      }
      return null;
    }

    // glob -> RegExp over a whole string. `*` = any run except '/', `**` = any run, `?` = one non-'/'.
    function globToRe(glob, ic) {
      const g = String(glob); let re = '';
      for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === '*') { if (g[i + 1] === '*') { re += '.*'; i++; } else { re += '[^/]*'; } }
        else if (c === '?') { re += '[^/]'; }
        else if ('\\^$.|+()[]{}'.indexOf(c) >= 0) { re += '\\' + c; }
        else { re += c; }
      }
      return new RegExp('^' + re + '$', ic ? 'i' : '');
    }
    /* recursive file walk -> acc of { rel, abs, mtimeMs }; rel is workspace-root-relative (feeds fs.read).
       Skips hidden entries + node_modules; never leaves the jailed base; bounded by SEARCH_MAX_FILES.

       SYMLINKS ARE RE-PROVEN HERE. resolveInside's realpath proof only covers the path the CALLER named —
       it says nothing about what the walk then reaches. So fs.read correctly refused a symlink pointing at
       ~/.ssh/id_rsa while fs.search happily grepped its CONTENTS and printed the matching line: the same
       jail, enforced on one tool and not its sibling. A link is cheap to check and rare, so only links pay
       the realpath (an ordinary file costs nothing extra); one that resolves outside is skipped entirely. */
    /* .GITIGNORE AWARENESS (2026-09-02, coding-tools lane). The walker read EVERY non-hidden file, so on a real
       project `dist/`, `build/`, `coverage/`, `.venv`-style outputs and vendored trees ate the file cap and the
       8s budget before the source was reached, and a search for a symbol came back "truncated" from a bundle.
       Small matcher, no dependency: the rules git itself documents — `#` comments, `!` negation, a trailing `/`
       means directories only, a pattern containing a slash (other than trailing) is anchored to ITS
       .gitignore's directory, one without a slash matches a basename at any depth, `*` never crosses `/`,
       `**` does, `?` is one char, `[...]` classes pass through. Last matching rule wins. Nested .gitignore
       files are honoured for their own subtree. An ignored directory is pruned (never descended), which is
       also what git does — a `!` cannot re-include inside an ignored parent. */
    function gitignoreGlobToRe(glob) {
      let re = '';
      for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
          if (glob[i + 1] === '*') {
            i++;
            if (glob[i + 1] === '/') { re += '(?:.*/)?'; i++; }   // `**/` = zero or more directories
            else re += '.*';                                        // trailing `/**` or a bare `**`
          } else re += '[^/]*';
        }
        else if (c === '?') re += '[^/]';
        else if (c === '[') {                                       // pass a character class through (git supports them)
          const close = glob.indexOf(']', i + 1);
          if (close < 0) { re += '\\['; continue; }
          let body = glob.slice(i + 1, close);
          if (body[0] === '!') body = '^' + body.slice(1);
          re += '[' + body.replace(/\\/g, '\\\\') + ']'; i = close;
        }
        else if (c === '\\' && i + 1 < glob.length) { i++; re += glob[i].replace(/[\\^$.|+()[\]{}*?]/g, '\\$&'); }
        else if ('\\^$.|+(){}'.indexOf(c) >= 0) re += '\\' + c;
        else re += c;
      }
      return new RegExp('^' + re + '$');
    }
    function parseGitignore(text) {
      const rules = [];
      for (let raw of String(text == null ? '' : text).split(/\r?\n/)) {
        if (!raw || raw[0] === '#') continue;
        let line = raw.replace(/(?<!\\)\s+$/, '');                // trailing spaces are ignored unless escaped
        if (!line) continue;
        let negate = false;
        if (line[0] === '!') { negate = true; line = line.slice(1); }
        else if (line.indexOf('\\!') === 0 || line.indexOf('\\#') === 0) line = line.slice(1);
        let dirOnly = false;
        if (line.length > 1 && line[line.length - 1] === '/') { dirOnly = true; line = line.slice(0, -1); }
        // `**/foo` == `foo` (a basename at any depth). `**/foo/bar` is NOT `foo/bar`: stripping it made the rule
        // anchored to the .gitignore's directory; kept whole it is a path rule whose leading `**/` matches any depth.
        if (line.indexOf('**/') === 0 && line.indexOf('/', 3) < 0) line = line.slice(3);
        let anchored = line.indexOf('/') >= 0;
        if (line[0] === '/') line = line.slice(1);
        if (!line) continue;
        rules.push({ re: gitignoreGlobToRe(line), negate, dirOnly, anchored });
      }
      return rules;
    }
    // stack entry: { baseRel, rules } — baseRel is the workspace-relative dir the .gitignore lives in ('' = root).
    function gitignored(stack, rel, isDir) {
      let ignored = false;
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      for (const layer of stack) {
        if (!layer.rules.length) continue;
        const under = layer.baseRel ? rel.slice(layer.baseRel.length + 1) : rel;
        for (const r of layer.rules) {
          if (r.dirOnly && !isDir) continue;
          if (r.anchored ? r.re.test(under) : r.re.test(name)) ignored = !r.negate;
        }
      }
      return ignored;
    }
    async function gitignoreLayer(absDir, baseRel) {
      let text = null;
      try { text = await fsp.readFile(P.join(absDir, '.gitignore'), 'utf8'); } catch (_) { return null; }
      const rules = parseGitignore(text);
      return rules.length ? { baseRel, rules } : null;
    }
    /* THE WALK IS BUDGETED AND STOPPABLE (2026-10-20). The walker awaited one fsp.stat per file, in sequence, while
       it built the list — 2.7-9.7 s for 6,000 files where the readdir-only walk took 21-67 ms — and the 8 s budget
       timer was armed only AFTER the walk returned, so a 20k-file tree reached the 20 s tool timeout. Nothing
       checked ctx.signal either: a search with an already-aborted signal still ran ~15 s and answered "(no
       matches)". Now a plain file costs no stat here (readdir already says it is a file; size and mtime are
       taken where they are needed: the content scan's own stat, or a target:"files" hit), the run's ONE clock
       (stats.clock, see searchClock) is checked at every directory and entry, an expiry ends the walk as a
       truncated, timed-out walk, and an abort throws. A FIFO / socket / device entry is skipped outright:
       readFile on a FIFO blocks forever on POSIX. */
    async function collectFiles(absDir, prefix, acc, stats, baseReal, ignoreStack) {
      const maxFiles = stats.maxFiles || SEARCH_MAX_FILES;
      if (stats.files >= maxFiles) { stats.truncated = true; return; }
      if (walkStopped(stats)) return;
      let entries;
      try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
      catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      let stack = ignoreStack || [];
      if (stats.gitignore !== false) {
        const layer = await gitignoreLayer(absDir, prefix);
        if (layer) stack = stack.concat([layer]);
      }
      for (const ent of entries) {
        if (stats.files >= maxFiles) { stats.truncated = true; return; }
        if (walkStopped(stats)) return;
        if (ent.name.charAt(0) === '.') continue;                 // hidden (matches ripgrep's default)
        const rel = prefix ? (prefix + '/' + ent.name) : ent.name;
        const abs = P.join(absDir, ent.name);
        const isLink = typeof ent.isSymbolicLink === 'function' && ent.isSymbolicLink();
        // a link (or a Windows junction) must PROVE it still lands inside the jail before we read or descend
        if (isLink) {
          if (baseReal && !pathInside(await realpathOrSelf(abs), baseReal)) { stats.skippedLinks = (stats.skippedLinks || 0) + 1; continue; }
        }
        let isDir = ent.isDirectory(), st = null;
        const plainFile = !isLink && !isDir && typeof ent.isFile === 'function' && ent.isFile();
        if (!isDir && !plainFile) {
          if (!isLink && specialEntry(ent)) continue;                // FIFO / socket / device: never read
          try { st = await fsp.stat(abs); } catch (e) { continue; }
          isDir = !!(st.isDirectory && st.isDirectory());          // an in-jail symlinked DIRECTORY reads as a file in readdir
          if (!isDir && specialEntry(st)) continue;                  // a link to a FIFO / socket / device
        }
        if (stack.length && gitignored(stack, rel, isDir)) { stats.ignored = (stats.ignored || 0) + 1; continue; }
        if (isDir) { if (ent.name !== 'node_modules') await collectFiles(abs, rel, acc, stats, baseReal, stack); continue; }
        stats.files++;
        acc.push(st ? { rel, abs, mtimeMs: st.mtimeMs || 0, size: Number(st.size) || 0 } : { rel, abs, mtimeMs: null, size: null });
      }
    }
    function specialEntry(x) {
      return ['isFIFO', 'isSocket', 'isBlockDevice', 'isCharacterDevice'].some((m) => typeof x[m] === 'function' && x[m]());
    }
    function searchAbortError() { const e = new Error('fs.search aborted'); e.name = 'AbortError'; return e; }
    function budgetNote(clock) {
      return '\n\n[search stopped at the ' + Math.round(clock.budgetMs / 1000) +
        's budget — these are the matches found so far; narrow with file_glob or a more specific query]';
    }
    // the walk's view of the run clock: an abort throws, an expiry marks the walk cut (truncated + timed out)
    function walkStopped(stats) {
      const clock = stats && stats.clock;
      if (!clock) return false;
      if (clock.aborted) throw searchAbortError();
      if (clock.expired) { stats.truncated = true; stats.timedOut = true; return true; }
      return false;
    }
    /* ONE DEADLINE PER SEARCH: a TIMER plus the run's abort signal, never a clock read (the determinism law; see
       the content-scan note below). The abort listener is live from the top of the call; the TIMER starts at
       clock.start(), right before the first walk or rg spawn, so a consent card for a new folder (resolveInside
       waits on the Commander) or the one-time rg probe never spends the search budget. It covers the walk and
       the content scan. disarm() runs in the caller's finally. */
    function searchClock(signal, budgetMs) {
      const clock = { expired: false, aborted: false, budgetMs };
      let timer = null;
      clock.start = () => {
        if (timer) return;
        timer = setTimeout(() => { clock.expired = true; }, budgetMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
      };
      const onAbort = () => { clock.aborted = true; };
      const listens = !!(signal && typeof signal.addEventListener === 'function');
      if (signal && signal.aborted) clock.aborted = true;
      else if (listens) signal.addEventListener('abort', onAbort, { once: true });
      clock.disarm = () => {
        if (timer) clearTimeout(timer);
        if (listens && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      };
      return clock;
    }
    /* Run start(item) for items IN ORDER with at most `width` in flight, handing each result to each(item, result)
       (awaited) in item order. stop() is asked before every launch and after every result (it throws on abort).
       Returns true when it stopped with work left. start() must never reject. */
    async function inOrderWindow(items, width, start, each, stop) {
      const q = [];
      let i = 0;
      const top = () => { while (q.length < width && i < items.length && !stop()) { q.push([items[i], start(items[i])]); i++; } };
      top();
      while (q.length) {
        const [item, p] = q.shift();
        const result = await p;
        await each(item, result);
        if (stop()) return q.length > 0 || i < items.length;
        top();
      }
      return i < items.length;
    }
    // `note` (optional) carries an honest reason the result set is partial for a reason OTHER than paging —
    // today, the scan hitting its wall-clock budget. Never silently truncate.
    function searchHint(truncated, offset, limit, total, note) {
      return (note || '') + (truncated ? ('\n\n[truncated — ' + total + '+ results shown so far; pass offset=' + (offset + limit) + ' for the next page, or narrow with file_glob / a more specific query]') : '');
    }
    function clipLine(s) { s = redact(String(s == null ? '' : s)).replace(/\s+$/, ''); return s.length > SEARCH_LINE_CHARS ? s.slice(0, SEARCH_LINE_CHARS) + '…' : s; }

    const searchTool = {
      name: 'fs.search', capability: 'cabinet', scope: 'read', requiresConsent: false, timeoutMs: 20000,
      description: 'Search your workspace; use this instead of grep/find/ls. Two modes via target:\n• target:content (default) finds TEXT inside files. Substring by default; regex:true treats query as a regex, ignoreCase:true ignores case. file_glob limits which files are searched (e.g. *.md); context adds N lines around each hit; output_mode is content (matching lines, default), files_only (just the paths) or count (matches per file).\n• target:files finds FILES by glob (query like *.md or report); newest first.\nResults are paths relative to your workspace (ready for fs.read). Page with limit/offset; a truncation hint gives the next offset. Hidden entries, node_modules and anything .gitignore matches are skipped (gitignore:false searches ignored files too); max_files raises the scan cap for a big tree.',
      schema: { type: 'object', required: ['query'], properties: {
        query: { type: 'string' },
        target: { type: 'string', enum: ['content', 'files'] },
        path: { type: 'string' }, file_glob: { type: 'string' },
        output_mode: { type: 'string', enum: ['content', 'files_only', 'count'] },
        context: { type: 'number' }, regex: { type: 'boolean' }, ignoreCase: { type: 'boolean' },
        limit: { type: 'number' }, offset: { type: 'number' },
        gitignore: { type: 'boolean' }, max_files: { type: 'number' }
      } },
      run: async (args, ctx) => {
        // ONE deadline for the whole search: abort live from here, the timer started before anything walks (see searchClock); always disarmed
        const clock = searchClock(ctx && ctx.signal, SEARCH_BUDGET_MS);
        try { return await searchRun(args, ctx, clock); } finally { clock.disarm(); }
        // the historic run() body, unchanged in place except that it now reads the run's one clock
        async function searchRun(args, ctx, clock) {
        args = args || {};
        const q = String(args.query != null ? args.query : '');
        if (!q) throw new Error('"query" must be a non-empty string');
        const resolved = await resolveInside((ctx && ctx.agentId) || 'agent', args.path || '.', { scope: 'read', ctx });
        const base = resolved.base;
        let abs = resolved.abs;
        /* A FILE as `path` searches just that file. Every clamp note says "THE FULL OUTPUT WAS SAVED to <file> — read
           that file … or search it", yet a file path died here with ENOTDIR, so the advertised search never worked.
           Root the scan at the file's own folder and admit only that name: narrower than the folder the jail
           already allows, and naming the file is consent to search it even when a .gitignore would skip it. */
        let onlyName = null;
        /* A missing path is an ordinary answer, not a swallowed failure: a named one says it does not exist (a bare
           "no matches" read as "the text is not there"), and the workspace root not existing yet stays an empty
           folder search. Only an unexpected stat failure is a fail-open trace; that path stays a folder search. */
        let missing = false;
        const startStat = await fsp.stat(abs).catch((e) => {
          if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) missing = true;
          else failNote('fs.search.start.stat', e);
          return null;
        });
        if (missing && P.relative(base, abs) !== '') return { content: '(no such path: ' + String(args.path) + ')', summary: 'path not found' };
        if (startStat && startStat.isFile()) { onlyName = P.basename(abs); abs = P.dirname(abs); }
        const onlyRel = onlyName ? P.relative(base, resolved.abs).split(P.sep).join('/') : null;
        const startPrefix = P.relative(base, abs).split(P.sep).join('/');     // '' when searching from the root
        const ic = !!args.ignoreCase;
        const limit = Math.max(1, Math.min(1000, Number(args.limit) || 50));
        const offset = Math.max(0, Number(args.offset) || 0);
        const target = ({ grep: 'content', find: 'files' })[args.target] || args.target || 'content';
        const cx = Math.max(0, Math.min(10, Number(args.context) || 0));
        const maxFiles = Math.max(1, Math.min(SEARCH_MAX_FILES_CEILING, Math.floor(Number(args.max_files)) || SEARCH_MAX_FILES));
        const stats = { files: 0, truncated: false, maxFiles, gitignore: args.gitignore !== false && !onlyName, skippedLarge: [], clock };
        const maxBytes = onlyName ? SEARCH_NAMED_FILE_BYTES : SEARCH_MAX_FILE_BYTES;
        if (onlyName && startStat && startStat.size > maxBytes) stats.skippedLarge.push(P.relative(base, P.join(abs, onlyName)).split(P.sep).join('/'));
        const signal = ctx && ctx.signal;

        // .gitignore layers ABOVE the start dir still bind (a `path` of "src/x" is inside the root's rules);
        // the start dir's own file and everything below are picked up by collectFiles itself.
        const ancestors = [];
        if (stats.gitignore) {
          const segs = startPrefix ? startPrefix.split('/') : [];
          let dirAbs = base, dirRel = '';
          for (let i = 0; i <= segs.length - 1; i++) {
            const layer = await gitignoreLayer(dirAbs, dirRel);
            if (layer) ancestors.push(layer);
            dirRel = dirRel ? dirRel + '/' + segs[i] : segs[i];
            dirAbs = P.join(dirAbs, segs[i]);
          }
        }
        const baseReal = await realpathOrSelf(base);
        async function walkAll() {
          // The named file already passed resolveInside. Do not enumerate its parent: same-name descendants
          // are different files, and unrelated siblings must not consume this one-file scan's budget.
          // `size` like collectFiles' entries: the walker skips an over-cap file BEFORE readFile, never after.
          if (onlyName) { stats.files = 1; return [{ rel: onlyRel, abs: resolved.abs, mtimeMs: startStat.mtimeMs || 0, size: Number(startStat.size) || 0 }]; }
          const all = []; await collectFiles(abs, startPrefix, all, stats, baseReal, ancestors); return all;
        }
        const rg = await rgBinary();
        const rgCommon = ['--no-require-git', '--no-messages', '--max-filesize', String(maxBytes), '-g', '!node_modules', '--sort', 'path'];
        if (!stats.gitignore) rgCommon.push('--no-ignore');
        const rgRel = (p) => { const n = String(p).replace(/\\/g, '/').replace(/^\.\//, ''); return startPrefix ? startPrefix + '/' + n : n; };
        // the budget starts HERE, after the path is resolved (a consent card may have waited on the Commander) and
        // rg is known; a search cancelled during that wait stops before it walks or spawns anything
        if (clock.aborted) throw searchAbortError();
        clock.start();

        // ---- target 'files': glob over names, newest first ----
        if (target === 'files') {
          const hasSlash = q.indexOf('/') >= 0;
          const re = globToRe((!hasSlash && q.charAt(0) !== '*') ? ('*' + q) : q, ic);   // bare name -> suffix match (rg --files -g *name)
          const nameOf = (rel) => hasSlash ? rel : rel.split('/').pop();
          const wanted = (rel) => (!onlyName || rel === onlyRel) && re.test(nameOf(rel));
          /* newest-first needs an mtime, so only the glob HITS are stat'ed (the walk no longer stats every file), 16
             at a time, in path order. A hit that cannot be stat'ed is dropped, as before. The stats are NOT under
             the budget: they are bounded by the hits already found (trunk stat'ed every file with no budget at
             all), and stopping them on an expired clock threw away every name a cut walk or rg had found and
             answered "(no files matching …)". An abort still stops them. */
          async function stampHits(list) {
            const out = [];
            await inOrderWindow(list, 16,
              (f) => (f.mtimeMs != null ? Promise.resolve(f.mtimeMs) : fsp.stat(f.abs).then((st) => st.mtimeMs || 0, () => null)),
              (f, m) => { if (m != null) out.push({ rel: f.rel, mtimeMs: m }); },
              () => { if (clock.aborted) throw searchAbortError(); return false; });
            return out;
          }
          let hits = null;
          if (rg) {
            const rels = [];
            const r = await runRg(rg, rgCommon.concat(['--files'], onlyName ? ['--', onlyName] : []), abs, (line) => { rels.push(line); if (!onlyName && rels.length >= maxFiles) { stats.truncated = true; return false; } }, clock.budgetMs, signal);
            if (clock.aborted) throw searchAbortError();   // a cancelled rg listing is not "(no files matching …)"
            if (r.ok) {
              stats.files = rels.length; stats.engine = 'rg';
              if (r.timedOut) { stats.truncated = true; stats.timedOut = true; }   // killed at the budget: the note says so
              const wantedRels = [];
              for (const p of rels) { const rel = rgRel(p); if (wanted(rel)) wantedRels.push({ rel, abs: P.join(base, rel), mtimeMs: null }); }
              hits = await stampHits(wantedRels);
            }
          }
          if (!hits) { const all = await walkAll(); stats.engine = 'walk'; hits = await stampHits(all.filter(f => wanted(f.rel))); }
          hits.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));   // newest first; path tiebreak = determinism
          const total = hits.length, page = hits.slice(offset, offset + limit);
          // a listing the clock cut short says so; "(no files matching)" from a cut walk would be a false negative
          const filesNote = stats.timedOut ? budgetNote(clock) : '';
          if (!page.length) return { content: '(no files matching ' + q + ')' + filesNote, summary: '0 files' };
          const truncated = stats.truncated || total > offset + limit;
          return { content: page.map(f => f.rel).join('\n') + searchHint(truncated, offset, limit, total, filesNote || undefined),
                   summary: total + ' file' + (total === 1 ? '' : 's') + ' matched' + (truncated ? ' (showing ' + page.length + ')' : ''), engine: stats.engine };
        }

        // ---- target 'content': grep ----
        let matcher;
        if (args.regex) {
          const risk = catastrophicRegex(q);
          if (risk) throw new Error('that regex can backtrack catastrophically (' + risk + ') and would stall the station — ' +
            'rewrite it without nesting one repeat inside another (e.g. "\\s+" instead of "(\\s+)+"), or drop "regex" and search for a plain substring');
          let re; try { re = new RegExp(q, ic ? 'i' : ''); } catch (e) { throw new Error('invalid regex: ' + ((e && e.message) || e)); }
          // blow-up scales with input length, so a model-supplied pattern never sees a whole long line
          matcher = (line) => re.test(line.length > SEARCH_MATCH_CHARS ? line.slice(0, SEARCH_MATCH_CHARS) : line);
        } else if (ic) { const n = q.toLowerCase(); matcher = (line) => line.toLowerCase().indexOf(n) >= 0; }
        else { matcher = (line) => line.indexOf(q) >= 0; }

        // file_glob was built from the FULL pattern but tested against the BASENAME only, so any path-shaped
        // glob (e.g. "src/" + star + ".js") matched nothing and returned a clean "0 matches" — indistinguishable
        // from "the text isn't there". Match on the same rule target:'files' already uses: a pattern containing
        // a slash is a PATH pattern, everything else is a name pattern.
        let globRe = null, globPath = false;
        if (args.file_glob) {
          let fg = String(args.file_glob);
          globPath = fg.indexOf('/') >= 0;
          if (!globPath && fg.charAt(0) !== '*') fg = '*' + fg;
          globRe = globToRe(fg, ic);
        }
        if (onlyName) { globRe = new RegExp('^' + onlyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'); globPath = false; }

        let fileHits = null;   // [{ rel, idxs:[lineIdx…], lines: string[] | { [idx]: text }, maxIdx }]
        let totalMatches = 0, timedOut = false;

        // ---- rg engine: one JSON stream, same jail, same budget, same shape ----
        if (rg) {
          const argv = rgCommon.concat(['--json']);
          if (!args.regex) argv.push('-F');
          if (ic) argv.push('-i');
          if (cx) argv.push('-C', String(cx));
          /* file_glob is NOT handed to rg as -g. rg matches -g relative to its cwd (the scoped `path`), so a path glob
             meant something else once `path` was set, and an rg -g glob OVERRIDES ignore rules, so a glob could reach
             .gitignored files the walker skips. Both engines now apply the same globRe in JS: a path glob against the
             WORKSPACE-relative path (the base every result path uses), a name glob against the basename. */
          argv.push('-e', q);
          if (onlyName) argv.push('--', onlyName);
          const byFile = new Map();   // rel -> hit
          let searched = null;
          const r = await runRg(rg, argv, abs, (line) => {
            let msg; try { msg = JSON.parse(line); } catch (_) { return; }
            const d = msg && msg.data;
            if (!d) return;
            if (msg.type === 'summary') { if (d.stats && typeof d.stats.searches === 'number') searched = d.stats.searches; return; }
            if (msg.type !== 'match' && msg.type !== 'context') return;
            if (!d.path || typeof d.path.text !== 'string' || !d.lines || typeof d.lines.text !== 'string') return;
            const rel = rgRel(d.path.text), idx = Number(d.line_number) - 1;
            if (onlyRel && rel !== onlyRel) return;
            if (!(idx >= 0)) return;
            if (globRe && !globRe.test(globPath ? rel : rel.split('/').pop())) return;
            let h = byFile.get(rel);
            if (!h) { h = { rel, idxs: [], lines: {}, maxIdx: 0 }; byFile.set(rel, h); }
            h.lines[idx] = d.lines.text.replace(/\r?\n$/, '');
            if (idx > h.maxIdx) h.maxIdx = idx;
            if (msg.type === 'match') {
              h.idxs.push(idx); totalMatches++;
              if (totalMatches >= SEARCH_MAX_MATCHES) { stats.truncated = true; return false; }
            }
          }, clock.budgetMs, signal);
          if (clock.aborted) throw searchAbortError();
          if (r.ok) {
            stats.engine = 'rg';
            fileHits = Array.from(byFile.values());
            for (const h of fileHits) h.idxs.sort((a, b) => a - b);
            fileHits.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
            stats.files = searched != null ? searched : fileHits.length;
            if (r.timedOut) { timedOut = true; stats.truncated = true; }
          } else { totalMatches = 0; }   // rg refused (dialect / spawn) -> the walker answers instead
        }

        // ---- pure-JS walker (the guaranteed path) ----
        if (!fileHits) {
          stats.engine = 'walk';
          const all = await walkAll();
          const candidates = all.filter(f => !globRe || globRe.test(globPath ? f.rel : f.rel.split('/').pop()))
            .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));   // path order = deterministic, rg-like grouping
          fileHits = [];
          /* Ceiling for the whole scan. The pattern floor above catches the exponential shapes; this bounds
             everything merely SLOW (a polynomial pattern over a large tree), so fs.search can never be the
             reason the station stops answering. A TIMER, not a clock read — the determinism law bans ambient
             time in backend logic, and browser.js's waitForSettle already sets this precedent. It works here
             because the check sits between files, with an `await fsp.readFile` in between, so the loop turns
             and the timer can fire. A partial answer that SAYS it is partial beats a frozen process.
             The timer is now the run's ONE clock (searchClock), armed before the walk, so a slow walk counts
             against the same 8 s, and an abort stops the scan. Files are read through an ordered window of 16
             (stat -> size cap -> readFile), consumed in path order: sequential stat+read of 6,000 small files took
             33-68 s against 3-9 s windowed, with the same results in the same order. Only a file up to 1 MiB is
             PREFETCHED; a bigger one is read when its turn comes, so the window holds at most ~16 MiB of file
             bytes plus the one large file being searched.
             A FLOOR: the first SCAN_FLOOR candidates are searched even once the clock has expired. A walk that spent
             the whole budget otherwise left the scan nothing — it read not one of the files the walk had found and
             answered "(no matches)" for text sitting in the first of them (trunk, whose walk was unbudgeted, found it).
             stats.scanned counts the files actually read and searched, for the summary of a cut scan. */
          if (stats.timedOut) timedOut = true;   // the walk itself ran out of budget
          const PREFETCH_MAX = 1024 * 1024, SCAN_FLOOR = 16;
          let reached = 0;
          stats.scanned = 0;
          const readOrSkip = (abs) => fsp.readFile(abs).then((buf) => ({ buf }), () => ({ skip: true }));
          const cut = await inOrderWindow(candidates, 16, async (f) => {
            let size = f.size;
            if (size == null) {
              try { size = Number((await fsp.stat(f.abs)).size) || 0; } catch (e) { return { skip: true }; }
              // an abort that landed during the stat: no read starts after it (the search is already rejecting)
              if (clock.aborted) return { skip: true };
            }
            if (size > maxBytes) return { large: true };
            return size > PREFETCH_MAX ? { later: true } : readOrSkip(f.abs);
          }, async (f, res) => {
            reached++;
            if (res.large) { stats.skippedLarge.push(f.rel); return; }   // named below, never a silent miss
            if (res.later) res = clock.aborted ? { skip: true } : await readOrSkip(f.abs);
            if (res.skip) return;
            const buf = res.buf;
            if (buf.length > maxBytes) { stats.skippedLarge.push(f.rel); return; }
            stats.scanned++;
            if (buf.indexOf(0) >= 0) return;   // binary
            const lines = buf.toString('utf8').split(/\r?\n/), idxs = [];
            for (let i = 0; i < lines.length; i++) if (matcher(lines[i])) idxs.push(i);
            if (idxs.length) { fileHits.push({ rel: f.rel, idxs, lines, maxIdx: lines.length - 1 }); totalMatches += idxs.length; }
          }, () => {
            if (clock.aborted) throw searchAbortError();
            return clock.expired && reached >= SCAN_FLOOR;
          });
          // a cut scan's summary says how many of the candidates it searched (the walk count is not files scanned)
          if (cut) { timedOut = true; stats.truncated = true; stats.scanOf = candidates.length; }
        }
        if (timedOut) stats.timedOutNote = budgetNote(clock);
        if (stats.skippedLarge.length) stats.timedOutNote = (stats.timedOutNote || '') + '\n\n[NOT searched — over the '
          + Math.round(maxBytes / (1024 * 1024)) + ' MB per-file search limit: ' + stats.skippedLarge.slice(0, 10).join(', ')
          + (stats.skippedLarge.length > 10 ? ' and ' + (stats.skippedLarge.length - 10) + ' more' : '')
          + (onlyName ? '. Read it in ranges with fs.read instead.' : '. Name one as "path" to search it (up to ' + Math.round(SEARCH_NAMED_FILE_BYTES / (1024 * 1024)) + ' MB).') + ']';
        // A miss carries the same notes as a hit: "(no matches)" from a search that stopped early or skipped files is a false negative.
        const missNote = stats.timedOutNote || '';

        const omode = args.output_mode || 'content';
        if (omode === 'count') {
          if (!fileHits.length) return { content: '(no matches for ' + q + ')' + missNote, summary: '0 matches' };
          const total = fileHits.length, page = fileHits.slice(offset, offset + limit);
          const truncated = stats.truncated || total > offset + limit;
          return { content: page.map(h => h.rel + ': ' + h.idxs.length).join('\n') + searchHint(truncated, offset, limit, total, stats.timedOutNote),
                   summary: totalMatches + ' match' + (totalMatches === 1 ? '' : 'es') + ' across ' + total + ' file(s)', engine: stats.engine };
        }
        if (omode === 'files_only') {
          if (!fileHits.length) return { content: '(no matches for ' + q + ')' + missNote, summary: '0 files' };
          const total = fileHits.length, page = fileHits.slice(offset, offset + limit);
          const truncated = stats.truncated || total > offset + limit;
          return { content: page.map(h => h.rel).join('\n') + searchHint(truncated, offset, limit, total, stats.timedOutNote),
                   summary: total + ' file' + (total === 1 ? '' : 's') + ' with matches', engine: stats.engine };
        }

        // content (default): page on the flat match list (file-ordered), render with optional context
        const flat = [];
        for (let fi = 0; fi < fileHits.length; fi++) for (const idx of fileHits[fi].idxs) flat.push({ fi, idx });
        const total = flat.length;
        const scannedCount = stats.scanOf != null ? stats.scanned + ' of ' + stats.scanOf : stats.files;
        if (!total) return { content: '(no matches for ' + q + ')' + missNote, summary: '0 matches in ' + scannedCount + ' file(s) scanned' + (stats.skippedLarge.length ? ', ' + stats.skippedLarge.length + ' too large' : ''), engine: stats.engine };
        const pageRefs = flat.slice(offset, offset + limit);
        const truncated = stats.truncated || total > offset + limit;
        let body;
        if (pageRefs.length < SEARCH_DENSIFY_MIN && cx === 0) {
          // few matches, no context: flat "path:line: text" rows (path on each line is convenient when small)
          body = pageRefs.map(r => { const h = fileHits[r.fi]; return h.rel + ':' + (r.idx + 1) + ': ' + clipLine(h.lines[r.idx]); }).join('\n');
        } else {
          // densified: file path once, then "  <line>: match" / "  <line>- context" rows ('--' marks a gap)
          const lines = [];
          let gi = 0;
          while (gi < pageRefs.length) {
            const fi = pageRefs[gi].fi, h = fileHits[fi], here = [];
            while (gi < pageRefs.length && pageRefs[gi].fi === fi) { here.push(pageRefs[gi].idx); gi++; }
            const matchSet = new Set(here), show = new Set();
            for (const i of here) for (let k = Math.max(0, i - cx); k <= Math.min(h.maxIdx, i + cx); k++) if (h.lines[k] !== undefined) show.add(k);
            const ordered = Array.from(show).sort((a, b) => a - b);
            lines.push(h.rel);
            let prev = -1;
            for (const k of ordered) {
              if (prev >= 0 && k > prev + 1) lines.push('  --');
              lines.push('  ' + (k + 1) + (matchSet.has(k) ? ': ' : '- ') + clipLine(h.lines[k]));
              prev = k;
            }
          }
          body = lines.join('\n');
        }
        return { content: body + searchHint(truncated, offset, limit, total, stats.timedOutNote),
                 summary: total + ' match' + (total === 1 ? '' : 'es') + ' in ' + fileHits.length + ' file(s)' + (truncated ? ' (showing ' + pageRefs.length + ')' : ''), engine: stats.engine };
        }   // searchRun
      }
    };

    return {
      writeTool, readTool, listTool, appendTool, editTool, patchTool, searchTool,
      _internals: { resolveInside, outputPlacement, workspaceRoot, safeAgentId, walk, collectFiles, globToRe, pathInside, parsePatch, fuzzyFindAndReplace, parseGitignore, gitignored, rgBinary, withFileLocks, lockKey },
      register(reg) { [writeTool, readTool, listTool, appendTool, editTool, patchTool, searchTool].forEach(t => reg.register(t)); return reg; }
    };
  }

  return { makeFsTools };
});
