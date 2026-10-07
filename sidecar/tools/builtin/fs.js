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
      const scoped = !!(ctx && typeof ctx.projectRoot === 'string' && ctx.projectRoot.trim());
      return '\n[location: ' + abs + (scoped ? '' : ' (your private workspace, not a project folder)') + ']';
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

    async function workspaceRoot(agentId) {
      if (environment && typeof environment.ensureWorkspace === 'function') return environment.ensureWorkspace(safeAgentId(agentId || 'agent'));
      const dir = P.join(ROOT, safeAgentId(agentId || 'agent'));
      await fsp.mkdir(dir, { recursive: true });
      return dir;
    }
    function pathInside(abs, base) {
      let a = P.resolve(abs), b = P.resolve(base);
      if (P.sep === '\\') { a = a.toLowerCase(); b = b.toLowerCase(); }
      return a === b || a.indexOf(b + P.sep) === 0;
    }
    async function realpathOrSelf(p) {
      try { return await fsp.realpath(p); } catch (_) { return p; }
    }
    async function realpathExisting(p) {
      try { return await fsp.realpath(p); }
      catch (e) { throw new Error('cannot resolve filesystem path (possibly a dangling symlink): ' + p + ': ' + ((e && e.message) || e)); }
    }
    async function deepestExisting(abs, base) {
      let cur = abs;
      for (;;) {
        try { await fsp.lstat(cur); return cur; }
        catch (e) {
          if (!e || e.code !== 'ENOENT') throw e;
          const parent = P.dirname(cur);
          if (!parent || parent === cur) return base;
          cur = parent;
        }
      }
    }
    async function checkpointResolvedRoot(base, opts) {
      const ctx = opts && opts.ctx;
      if (!ctx || typeof ctx.checkpointMutation !== 'function' || (opts && opts.scope) !== 'write') return;
      try { await ctx.checkpointMutation(base, 'fs mutation', { resolvedRoot: true }); } catch (_) {}
    }
    // Resolve a path and PROVE it is reachable. A relative path in a host-validated project session is rooted
    // at that exact project, not at the agent's private deliverables workspace. It still passes through the
    // same path-trust guard as an absolute project path and gets a second symlink-containment proof, so a
    // model cannot manufacture ctx.projectRoot or escape it through a link. Unscoped relative paths retain the
    // historic per-agent jail. Absolute paths always use pathTrust. opts.scope ('read' | 'write') is threaded
    // to the guard so writes can stay consent-gated; opts.ctx is passed through.
    async function resolveInside(agentId, rel, opts) {
      opts = opts || {};
      rel = String(rel == null ? '' : rel);
      if (rel.indexOf('\0') >= 0) throw new Error('illegal path: ' + rel);
      // Absolute on EITHER platform: posix "/abs", win32 "C:\..." AND UNC "\\server\share" (host
      // P.isAbsolute alone misses UNC when running on Linux). Routed to path-trust when wired, else illegal.
      const isAbs = P.win32.isAbsolute(rel) || P.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel);
      if (isAbs) {
        if (!pathTrust) throw new Error('illegal path: ' + rel);
        const resolved = await pathTrust(rel, { scope: opts.scope === 'write' ? 'write' : 'read', agentId: agentId, ctx: opts.ctx });
        await checkpointResolvedRoot(resolved && resolved.base, opts);
        return resolved;
      }
      if (/(^|[\\/])\.\.([\\/]|$)/.test(rel)) throw new Error('illegal path: ' + rel);
      const projectRoot = opts.ctx && typeof opts.ctx.projectRoot === 'string'
        ? String(opts.ctx.projectRoot).trim() : '';
      if (projectRoot) {
        if (!pathTrust) throw new Error('project-relative path requires the project trust guard');
        const base = P.resolve(projectRoot);
        const abs = P.resolve(base, rel || '.');
        if (!pathInside(abs, base)) throw new Error('path escapes project root');
        // Selecting a relative base is not authority: re-run the station grant and protected-file floor for
        // every resolved target, just as an explicit absolute path would.
        await pathTrust(abs, { scope: opts.scope === 'write' ? 'write' : 'read', agentId: agentId, ctx: opts.ctx });
        const baseReal = await realpathExisting(base);
        const existing = await deepestExisting(abs, base);
        const existingReal = await realpathExisting(existing);
        if (!pathInside(existingReal, baseReal)) throw new Error('path escapes project root via symlink');
        await checkpointResolvedRoot(base, opts);
        return { base, abs };
      }
      const base = await workspaceRoot(agentId);
      const abs = P.resolve(base, rel || '.');
      if (!pathInside(abs, base)) throw new Error('path escapes workspace');
      const baseReal = await realpathExisting(base);
      const existing = await deepestExisting(abs, base);
      const existingReal = await realpathExisting(existing);
      if (!pathInside(existingReal, baseReal)) throw new Error('path escapes workspace via symlink');
      await checkpointResolvedRoot(base, opts);
      return { base, abs };
    }

    async function beginEditDiagnostics(aid, files, ctx) {
      if (!editDiagnostics) return null;
      try { return await editDiagnostics.beginEdit({ agentId: aid, files, signal: ctx && ctx.signal }); }
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
    async function finishEditDiagnostics(ticket, result, ctx) {
      if (!editDiagnostics || !ticket) return result;
      let delta;
      if (ticket.failedAtBaseline) {
        delta = { status: 'unavailable', reason: ticket.failedAtBaseline, added: [], removed: [], addedCount: 0, removedCount: 0 };
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

       SCOPED TO fs.write ON PURPOSE, after tracing what each writer actually does:
         · fs.append reads the file and appends to what it FINDS, so a concurrent change survives.
         · fs.edit reads fresh and replaces an exact `find`; a drifted file either still matches (the edit
           lands on the NEW text, which is right) or misses and errors honestly.
         · fs.patch validates every hunk's context against current content before writing anything.
       All three are read-modify-write inside ONE call and cannot clobber. fs.write is the only writer that
       replaces a whole file with content composed from a read that may now be old — so it is the only one
       that needs a stamp, and guarding the others would only manufacture false refusals.

       A file this agent never read has no stamp and is never refused: writing a file you did not read is
       "create it", not "clobber it". One refusal per drift — the stamp is dropped so the required re-read
       re-arms it, and the agent can never be stuck in a loop it has no way to satisfy. */
    const readStamps = new Map();   // agentId \0 abs -> the mtime this agent last SAW
    const stampKey = (aid, abs) => String(aid) + '\0' + (P.sep === '\\' ? String(abs).toLowerCase() : String(abs));
    async function mtimeOf(abs) { try { const st = await fsp.stat(abs); return Number(st.mtimeMs || 0) || 0; } catch (_) { return 0; } }
    async function stampSeen(aid, abs) {
      const m = await mtimeOf(abs);
      if (m) readStamps.set(stampKey(aid, abs), m); else readStamps.delete(stampKey(aid, abs));
    }
    async function assertFresh(aid, abs, rel) {
      const key = stampKey(aid, abs);
      const seen = readStamps.get(key);
      if (!seen) return;                          // never read here -> nothing to be stale against
      const now = await mtimeOf(abs);
      if (!now || now <= seen) return;            // deleted since, or untouched since we looked
      readStamps.delete(key);                     // one refusal per drift; the re-read below re-arms it
      const error = new Error('stale write refused: ' + rel + ' changed on disk after you read it — someone else (another agent, or the Commander) edited it. Read it again and re-apply your change on top of the current content, or use fs.edit/fs.patch so your change merges instead of replacing the file.');
      error.precondition = { code: 'fresh_read_required', requiredTool: 'fs.read', requiredState: 'current_file_observed' };
      throw error;
    }

    const writeTool = {
      name: 'fs.write', capability: 'cabinet', scope: 'write', requiresConsent: true, timeoutMs: 10000,
      description: 'Write a UTF-8 text file into the current project folder when this session is project-scoped, otherwise into your private workspace. This is where your deliverables (reports, notes, code) are saved.',
      schema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const { abs, base } = await resolveInside(aid, args.path, { scope: 'write', ctx });
        const data = Buffer.from(String(args.content), 'utf8');
        if (data.length > WRITE_BYTES) throw new Error('file too large (' + data.length + ' > ' + WRITE_BYTES + ' bytes)');
        await assertFresh(aid, abs, args.path);   // refuse to overwrite a file that moved under us
        let beforeBytes = null;
        try { beforeBytes = await fsp.readFile(abs); } catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
        const diagnosticTicket = await beginEditDiagnostics(aid, [{ abs, base, rel: String(args.path), text: beforeBytes ? beforeBytes.toString('utf8') : '' }], ctx);
        await fsp.mkdir(P.dirname(abs), { recursive: true });
        const receipt = await verifiedMutation({ operation: 'write', path: args.path, abs, expected: data, initial: beforeBytes, mutate: () => fsp.writeFile(abs, data) });
        await stampSeen(aid, abs);                // our own write is the new baseline, so a rewrite never self-trips
        emitDeliverable(ctx, aid, args.path);
        return finishEditDiagnostics(diagnosticTicket,
          { content: 'Wrote ' + args.path + ' (' + data.length + ' bytes).\n' + receiptLine(receipt) + locationLine(args.path, abs, ctx), summary: 'wrote ' + args.path + ' (' + kb(data.length) + ')', mutationReceipt: receipt, receipt }, ctx);
      }
    };

    const readTool = {
      name: 'fs.read', capability: 'cabinet', scope: 'read', requiresConsent: false, timeoutMs: 10000,
      description: 'Read a file from the current project folder when this session is project-scoped, otherwise from your private workspace. Text files come back as text; for large text use offset and limit to page character ranges without rerunning the command that produced the file. For source code pass { "numbered": true }: every line is prefixed "<line number><TAB>" (cat -n style) so you can cite exact lines, and offset/limit then mean the 1-based START LINE and the NUMBER OF LINES (e.g. offset:120, limit:40). Without "numbered" (or with "raw": true) the text is returned exactly as stored. Word (.docx), Excel (.xlsx) and Jupyter (.ipynb) files are extracted to readable text automatically; PNG/JPEG/GIF/WEBP images are shown to you as actual pixels so you can look at them directly.',
      schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' }, numbered: { type: 'boolean' }, raw: { type: 'boolean' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const { abs } = await resolveInside(aid, args.path, { scope: 'read', ctx });
        let raw;
        try { raw = await fsp.readFile(abs); }
        catch (e) { if (e && e.code === 'ENOENT') throw new Error('no such file: ' + args.path); throw e; }
        await stampSeen(aid, abs);   // what this agent believes the file says, as of now (see the stale-write guard)

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
            if (rows.length && chars + row.length + 1 > READ_RETURN) { capped = true; break; }
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
        const limit = Math.min(READ_RETURN, requested);
        const end = Math.min(txt.length, offset + limit);
        let out = txt.slice(offset, end);
        if (end < txt.length) out += '\n[showing characters ' + offset + '-' + end + ' of ' + txt.length
          + '; next: fs.read {"path":' + JSON.stringify(String(args.path)) + ',"offset":' + end + ',"limit":' + limit + '}]';
        else if (offset > 0) out += '\n[showing characters ' + offset + '-' + end + ' of ' + txt.length + '; end of file]';
        return { content: out, summary: kb(Buffer.byteLength(txt)) + ' read; characters ' + offset + '-' + end + ' of ' + txt.length };
      }
    };

    // recursive directory walk -> relative paths (dirs end with '/'), bounded so a huge tree can't flood the prompt
    async function walk(absDir, prefix, out, limit) {
      if (out.length >= limit) return;
      let entries;
      try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
      catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
      for (const ent of entries) {
        if (out.length >= limit) { out.push('…[truncated]'); return; }
        const rel = prefix ? (prefix + '/' + ent.name) : ent.name;
        if (ent.isDirectory()) { out.push(rel + '/'); await walk(P.join(absDir, ent.name), rel, out, limit); }
        else out.push(rel);
      }
    }

    const listTool = {
      name: 'fs.list', capability: 'cabinet', scope: 'read', requiresConsent: false, timeoutMs: 8000,
      description: 'List files in your workspace. Pass { "recursive": true } to see the whole tree (directories end with "/"); optional "path" lists one subdirectory.',
      schema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } } },
      run: async (args, ctx) => {
        const { abs } = await resolveInside((ctx && ctx.agentId) || 'agent', (args && args.path) || '.', { scope: 'read', ctx });
        if (args && args.recursive) {
          const out = []; await walk(abs, '', out, 500);
          return { content: out.length ? out.join('\n') : '(empty)', summary: out.length + ' entr' + (out.length === 1 ? 'y' : 'ies') };
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
        let existingBytes = null;
        try { existingBytes = await fsp.readFile(abs); } catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
        const existing = existingBytes ? existingBytes.toString('utf8') : '';
        const combined = existing + String(args.content);
        const bytes = Buffer.byteLength(combined, 'utf8');
        if (bytes > WRITE_BYTES) throw new Error('file too large after append (' + bytes + ' > ' + WRITE_BYTES + ' bytes)');
        const diagnosticTicket = await beginEditDiagnostics(aid, [{ abs, base, rel: String(args.path), text: existing }], ctx);
        await fsp.mkdir(P.dirname(abs), { recursive: true });
        const expected = Buffer.from(combined, 'utf8');
        const receipt = await verifiedMutation({ operation: 'append', path: args.path, abs, expected, initial: existingBytes, mutate: () => fsp.writeFile(abs, expected) });
        await stampSeen(aid, abs);   // our own append is the new baseline — a later fs.write must not read as a third-party race
        emitDeliverable(ctx, aid, args.path);
        const added = Buffer.byteLength(String(args.content), 'utf8');
        return finishEditDiagnostics(diagnosticTicket,
          { content: 'Appended to ' + args.path + ' (+' + added + ' bytes, now ' + bytes + ').\n' + receiptLine(receipt) + locationLine(args.path, abs, ctx), summary: 'appended ' + args.path + ' (+' + kb(added) + ')', mutationReceipt: receipt, receipt }, ctx);
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
      description: 'Edit a workspace file by exact text replacement of "find" with "replace". "find" must match EXACTLY ONE place in the file — if it matches more than once the edit is refused and the count is reported; include more surrounding lines to make it unique, or pass { "replace_all": true } to change every occurrence, or { "expected_count": N } to assert exactly N replacements. Requires that you fs.read the file first (in this run). Prefer fs.patch for multi-line source edits.',
      schema: { type: 'object', required: ['path', 'find', 'replace'], properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, replace_all: { type: 'boolean' }, expected_count: { type: 'number' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const { abs, base } = await resolveInside(aid, args.path, { scope: 'write', ctx });
        let initialBytes;
        try { initialBytes = await fsp.readFile(abs); }
        catch (e) { if (e && e.code === 'ENOENT') throw new Error('no such file: ' + args.path); throw e; }
        assertObserved(aid, abs, args.path);
        const txt = initialBytes.toString('utf8');
        const find = String(args.find);
        if (!find) throw new Error('"find" must be a non-empty string');
        if (txt.indexOf(find) < 0) throw new Error('"find" text not found in ' + args.path + ' — read the file and match it exactly');
        const count = txt.split(find).length - 1;
        /* UNIQUENESS. Replacing EVERY occurrence silently was the audit's top finding: a "find" like `return x;`
           rewrote five functions when the model meant one, and the result line said "5 replacements" only after
           the damage. Exactly-one-match keeps the historic path; more than one must be asked for explicitly. */
        const replaceAll = args.replace_all === true;
        const expectedCount = args.expected_count == null ? null : Math.floor(Number(args.expected_count));
        if (expectedCount != null && (!(expectedCount >= 1) || !isFinite(expectedCount))) throw new Error('"expected_count" must be a positive integer');
        if (expectedCount != null && count !== expectedCount) throw new Error('"find" matches ' + count + ' place' + (count === 1 ? '' : 's') + ' in ' + args.path + ' but expected_count is ' + expectedCount + ' — nothing was changed. Re-read the file and adjust "find" or expected_count.');
        if (count > 1 && !replaceAll && expectedCount == null) throw new Error('"find" matches ' + count + ' places in ' + args.path + ' — nothing was changed. Include more surrounding text so "find" is unique to the ONE place you mean, or pass { "replace_all": true } to change all ' + count + ', or { "expected_count": ' + count + ' } to confirm that count.');
        const next = txt.split(find).join(String(args.replace));
        const bytes = Buffer.byteLength(next, 'utf8');
        if (bytes > WRITE_BYTES) throw new Error('file too large after edit (' + bytes + ' > ' + WRITE_BYTES + ' bytes)');
        const diagnosticTicket = await beginEditDiagnostics(aid, [{ abs, base, rel: String(args.path), text: txt }], ctx);
        const expected = Buffer.from(next, 'utf8');
        const receipt = await verifiedMutation({ operation: 'edit', path: args.path, abs, expected, initial: initialBytes, mutate: () => fsp.writeFile(abs, expected) });
        await stampSeen(aid, abs);   // our own edit is the new baseline: read -> edit -> write used to refuse with a FABRICATED "someone else edited it" story
        emitDeliverable(ctx, aid, args.path);
        return finishEditDiagnostics(diagnosticTicket,
          { content: 'Edited ' + args.path + ' (' + count + ' replacement' + (count === 1 ? '' : 's') + ').\n' + receiptLine(receipt), summary: 'edited ' + args.path + ' (' + count + 'x)', mutationReceipt: receipt, receipt }, ctx);
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
          try { content = await fsp.readFile(key, 'utf8'); exists = true; }
          catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
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
            for (const hunk of op.hunks) {
              const oldText = hunkOldText(hunk);
              const newText = hunkNewText(hunk);
              const res = fuzzyFindAndReplace(current, oldText, newText);
              if (!res.ok) throw new Error('UPDATE ' + op.path + ': ' + res.error);
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
            await stampSeen(aid, plan.abs);   // our own patch is the new baseline for the stale-write guard (deletes drop the stamp)
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
    const SEARCH_MAX_FILE_BYTES = 512 * 1024, SEARCH_MAX_FILES = 20000, SEARCH_MAX_FILES_CEILING = 100000, SEARCH_LINE_CHARS = 500, SEARCH_DENSIFY_MIN = 5;
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
    // Longest line handed to a MODEL-SUPPLIED regex, and the wall-clock ceiling for the whole content scan.
    const SEARCH_MATCH_CHARS = 2000, SEARCH_TIME_BUDGET_MS = 8000;

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
    async function collectFiles(absDir, prefix, acc, stats, baseReal, ignoreStack) {
      const maxFiles = stats.maxFiles || SEARCH_MAX_FILES;
      if (stats.files >= maxFiles) { stats.truncated = true; return; }
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
        if (ent.name.charAt(0) === '.') continue;                 // hidden (matches ripgrep's default)
        const rel = prefix ? (prefix + '/' + ent.name) : ent.name;
        const abs = P.join(absDir, ent.name);
        // a link (or a Windows junction) must PROVE it still lands inside the jail before we read or descend
        if (typeof ent.isSymbolicLink === 'function' && ent.isSymbolicLink()) {
          if (baseReal && !pathInside(await realpathOrSelf(abs), baseReal)) { stats.skippedLinks = (stats.skippedLinks || 0) + 1; continue; }
        }
        let isDir = ent.isDirectory(), st = null;
        if (!isDir) {
          try { st = await fsp.stat(abs); } catch (e) { continue; }
          isDir = !!(st.isDirectory && st.isDirectory());          // an in-jail symlinked DIRECTORY reads as a file in readdir
        }
        if (stack.length && gitignored(stack, rel, isDir)) { stats.ignored = (stats.ignored || 0) + 1; continue; }
        if (isDir) { if (ent.name !== 'node_modules') await collectFiles(abs, rel, acc, stats, baseReal, stack); continue; }
        stats.files++; acc.push({ rel, abs, mtimeMs: st.mtimeMs || 0 });
      }
    }
    // `note` (optional) carries an honest reason the result set is partial for a reason OTHER than paging —
    // today, the scan hitting its wall-clock budget. Never silently truncate.
    function searchHint(truncated, offset, limit, total, note) {
      return (note || '') + (truncated ? ('\n\n[truncated — ' + total + '+ results shown so far; pass offset=' + (offset + limit) + ' for the next page, or narrow with file_glob / a more specific query]') : '');
    }
    function clipLine(s) { s = redact(String(s == null ? '' : s)).replace(/\s+$/, ''); return s.length > SEARCH_LINE_CHARS ? s.slice(0, SEARCH_LINE_CHARS) + '…' : s; }

    const searchTool = {
      name: 'fs.search', capability: 'cabinet', scope: 'read', requiresConsent: false, timeoutMs: 20000,
      description: 'Search your workspace — use this instead of grep/find/ls. Two modes via "target":\n• target:"content" (default) — find TEXT inside files. Substring by default; { "regex": true } treats "query" as a regex, { "ignoreCase": true } ignores case. "file_glob" limits which files are searched (e.g. "*.md"); "context" adds N lines around each hit; "output_mode" is "content" (matching lines, default), "files_only" (just the file paths), or "count" (matches per file).\n• target:"files" — find FILES by glob ("query" like "*.md" or "report"); newest first.\nResults are paths relative to your workspace (ready for fs.read). Use "limit"/"offset" to page; a truncation hint tells you the next offset. Hidden entries, node_modules and anything matched by .gitignore files are skipped (pass { "gitignore": false } to search ignored files too); "max_files" raises the scan cap for a big tree.',
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
        args = args || {};
        const q = String(args.query != null ? args.query : '');
        if (!q) throw new Error('"query" must be a non-empty string');
        const { base, abs } = await resolveInside((ctx && ctx.agentId) || 'agent', args.path || '.', { scope: 'read', ctx });
        const startPrefix = P.relative(base, abs).split(P.sep).join('/');     // '' when searching from the root
        const ic = !!args.ignoreCase;
        const limit = Math.max(1, Math.min(1000, Number(args.limit) || 50));
        const offset = Math.max(0, Number(args.offset) || 0);
        const target = ({ grep: 'content', find: 'files' })[args.target] || args.target || 'content';
        const cx = Math.max(0, Math.min(10, Number(args.context) || 0));
        const maxFiles = Math.max(1, Math.min(SEARCH_MAX_FILES_CEILING, Math.floor(Number(args.max_files)) || SEARCH_MAX_FILES));
        const stats = { files: 0, truncated: false, maxFiles, gitignore: args.gitignore !== false };
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
        async function walkAll() { const all = []; await collectFiles(abs, startPrefix, all, stats, baseReal, ancestors); return all; }
        const rg = await rgBinary();
        const rgCommon = ['--no-require-git', '--no-messages', '--max-filesize', String(SEARCH_MAX_FILE_BYTES), '-g', '!node_modules', '--sort', 'path'];
        if (!stats.gitignore) rgCommon.push('--no-ignore');
        const rgRel = (p) => { const n = String(p).replace(/\\/g, '/').replace(/^\.\//, ''); return startPrefix ? startPrefix + '/' + n : n; };

        // ---- target 'files': glob over names, newest first ----
        if (target === 'files') {
          const hasSlash = q.indexOf('/') >= 0;
          const re = globToRe((!hasSlash && q.charAt(0) !== '*') ? ('*' + q) : q, ic);   // bare name -> suffix match (rg --files -g *name)
          const nameOf = (rel) => hasSlash ? rel : rel.split('/').pop();
          let hits = null;
          if (rg) {
            const rels = [];
            const r = await runRg(rg, rgCommon.concat(['--files']), abs, (line) => { rels.push(line); if (rels.length >= maxFiles) { stats.truncated = true; return false; } }, SEARCH_TIME_BUDGET_MS, signal);
            if (r.ok) {
              stats.files = rels.length; stats.engine = 'rg';
              if (r.timedOut) stats.truncated = true;
              hits = [];
              for (const p of rels) {
                const rel = rgRel(p);
                if (!re.test(nameOf(rel))) continue;
                let st; try { st = await fsp.stat(P.join(base, rel)); } catch (_) { continue; }
                hits.push({ rel, mtimeMs: st.mtimeMs || 0 });
              }
            }
          }
          if (!hits) { const all = await walkAll(); stats.engine = 'walk'; hits = all.filter(f => re.test(nameOf(f.rel))); }
          hits.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));   // newest first; path tiebreak = determinism
          const total = hits.length, page = hits.slice(offset, offset + limit);
          if (!page.length) return { content: '(no files matching ' + q + ')', summary: '0 files' };
          const truncated = stats.truncated || total > offset + limit;
          return { content: page.map(f => f.rel).join('\n') + searchHint(truncated, offset, limit, total),
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
          }, SEARCH_TIME_BUDGET_MS, signal);
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
             and the timer can fire. A partial answer that SAYS it is partial beats a frozen process. */
          let expired = false;
          const budgetTimer = setTimeout(() => { expired = true; }, SEARCH_TIME_BUDGET_MS);
          if (budgetTimer && typeof budgetTimer.unref === 'function') budgetTimer.unref();
          for (const f of candidates) {
            if (expired) { timedOut = true; stats.truncated = true; break; }
            let buf; try { buf = await fsp.readFile(f.abs); } catch (e) { continue; }
            if (buf.length > SEARCH_MAX_FILE_BYTES || buf.indexOf(0) >= 0) continue;   // skip oversized / binary
            const lines = buf.toString('utf8').split(/\r?\n/), idxs = [];
            for (let i = 0; i < lines.length; i++) if (matcher(lines[i])) idxs.push(i);
            if (idxs.length) { fileHits.push({ rel: f.rel, idxs, lines, maxIdx: lines.length - 1 }); totalMatches += idxs.length; }
          }
          clearTimeout(budgetTimer);
        }
        if (timedOut) stats.timedOutNote = '\n\n[search stopped at the ' + Math.round(SEARCH_TIME_BUDGET_MS / 1000) +
          's budget — these are the matches found so far; narrow with file_glob or a more specific query]';

        const omode = args.output_mode || 'content';
        if (omode === 'count') {
          if (!fileHits.length) return { content: '(no matches for ' + q + ')', summary: '0 matches' };
          const total = fileHits.length, page = fileHits.slice(offset, offset + limit);
          const truncated = stats.truncated || total > offset + limit;
          return { content: page.map(h => h.rel + ': ' + h.idxs.length).join('\n') + searchHint(truncated, offset, limit, total, stats.timedOutNote),
                   summary: totalMatches + ' match' + (totalMatches === 1 ? '' : 'es') + ' across ' + total + ' file(s)', engine: stats.engine };
        }
        if (omode === 'files_only') {
          if (!fileHits.length) return { content: '(no matches for ' + q + ')', summary: '0 files' };
          const total = fileHits.length, page = fileHits.slice(offset, offset + limit);
          const truncated = stats.truncated || total > offset + limit;
          return { content: page.map(h => h.rel).join('\n') + searchHint(truncated, offset, limit, total, stats.timedOutNote),
                   summary: total + ' file' + (total === 1 ? '' : 's') + ' with matches', engine: stats.engine };
        }

        // content (default): page on the flat match list (file-ordered), render with optional context
        const flat = [];
        for (let fi = 0; fi < fileHits.length; fi++) for (const idx of fileHits[fi].idxs) flat.push({ fi, idx });
        const total = flat.length;
        if (!total) return { content: '(no matches for ' + q + ')', summary: '0 matches in ' + stats.files + ' file(s) scanned', engine: stats.engine };
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
      }
    };

    return {
      writeTool, readTool, listTool, appendTool, editTool, patchTool, searchTool,
      _internals: { resolveInside, outputPlacement, workspaceRoot, safeAgentId, walk, collectFiles, globToRe, pathInside, parsePatch, fuzzyFindAndReplace, parseGitignore, gitignored, rgBinary },
      register(reg) { [writeTool, readTool, listTool, appendTool, editTool, patchTool, searchTool].forEach(t => reg.register(t)); return reg; }
    };
  }

  return { makeFsTools };
});
