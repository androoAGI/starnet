/* sidecar/attachments.js — USER ATTACHMENTS for COMMS (photos/files the Commander attaches to a message,
   like Claude Code / Codex).

   The bytes live in the agent's WORKSPACE under .attachments/ (jailed by the same resolveInside proof the
   read-only /api/file route uses). The browser's message history stores only a lightweight REFERENCE
   ({ id, name, path, mediaType, kind }) — never base64 — so localStorage/the durable save stay tiny and the
   thumbnail re-renders from /api/file after a reload. expandUserAttachments() turns those references back into
   provider-facing content blocks right before the model call: images become a base64 image_url data URL (every
   provider adapter renders it — anthropic/gemini map it to their native image block), textual files are inlined
   as fenced text. Truthful-telemetry: a missing/oversized/unreadable file degrades to a plain note, never a
   silent drop nor a claim the model can't back.

   Pure logic + injected deps ({ fsp, path, crypto, resolveInside }) so it unit-tests without a running server. */
'use strict';
const { note: failNote } = require('./failopen.js');
const { tagImageSource } = require('./providers/provider.js');
const RunPaths = require('./run-paths.js');   // the run's one placement rule (placeJail) names a saved attachment

module.exports = function makeAttachments(deps) {
  const fsp = deps.fsp;
  const path = deps.path;
  const crypto = deps.crypto;
  const resolveInside = deps.resolveInside;   // (agentId, relPath) -> { base, abs } ; throws on jail escape

  const ATTACH_DIR = '.attachments';
  const MAX_BYTES = 8 * 1024 * 1024;          // per-file upload ceiling (mirrors the image tool's MAX_IMAGE_BYTES)
  const TEXT_INLINE_MAX = 96 * 1024;          // inline at most this many bytes of a text file into the prompt
  const IMAGE_BUDGET = 12 * 1024 * 1024;      // total decoded image bytes expanded into ONE run (cost/size guard)
  // image MIME -> stored extension. Only the four types every major vision API accepts; anything else is a 'file'.
  const IMAGE_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const TEXT_EXT = new Set(['txt', 'text', 'md', 'markdown', 'rst', 'csv', 'tsv', 'json', 'jsonl', 'log', 'js',
    'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs',
    'php', 'swift', 'sh', 'bash', 'zsh', 'ps1', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'html',
    'htm', 'css', 'scss', 'less', 'sql', 'svg', 'gitignore', 'dockerfile', 'makefile']);

  function extOf(name) { return String(name || '').split('.').pop().toLowerCase(); }

  // is this a file we can safely inline as UTF-8 text for the model? extension first, then a MIME sniff.
  function looksTextual(name, mime) {
    if (TEXT_EXT.has(extOf(name))) return true;
    const m = String(mime || '').toLowerCase();
    return /^text\//.test(m) || /(json|xml|javascript|ecmascript|csv|yaml|x-sh|x-httpd)/.test(m);
  }

  // Parse a data: URL into { mime, buffer }. Tolerates the non-base64 form. Returns null on anything unparseable.
  function parseDataUrl(u) {
    const s = String(u == null ? '' : u);
    const m = /^data:([^;,]*?)(;base64)?,([\s\S]*)$/.exec(s);
    if (!m) return null;
    const mime = (m[1] || 'application/octet-stream').toLowerCase();
    try {
      const buffer = m[2] ? Buffer.from(m[3] || '', 'base64') : Buffer.from(decodeURIComponent(m[3] || ''), 'utf8');
      return { mime, buffer };
    } catch (_) { return null; }
  }

  // Save an attached file into the agent's workspace. Returns the history reference on success, or
  // { ok:false, error, code } (code = the HTTP status the route should answer). Never throws.
  async function saveAttachment(agentId, rawName, dataUrl) {
    const name = String(rawName == null ? 'file' : rawName).slice(0, 200) || 'file';
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return { ok: false, code: 400, error: 'bad or missing dataUrl' };
    if (!parsed.buffer.length) return { ok: false, code: 400, error: 'empty file' };
    if (parsed.buffer.length > MAX_BYTES) return { ok: false, code: 413, error: 'file too large' };
    const imgExt = IMAGE_MIME[parsed.mime];
    const kind = imgExt ? 'image' : 'file';
    const nameExt = extOf(name);
    const ext = imgExt || (/^[a-z0-9]{1,8}$/.test(nameExt) ? nameExt : 'bin');
    const id = crypto.randomUUID();
    const rel = ATTACH_DIR + '/' + id + '.' + ext;
    let abs;
    try { ({ abs } = await resolveInside(agentId, rel)); }
    catch (e) { return { ok: false, code: 403, error: 'forbidden' }; }
    let tmp = null;
    let activated = false;
    try {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      tmp = abs + '.' + crypto.randomUUID() + '.tmp';   // atomic tmp+rename (crash-safe; collision-resistant)
      const handle = await fsp.open(tmp, 'wx');
      try { await handle.writeFile(parsed.buffer); await handle.sync(); }
      finally { await handle.close(); }
      await fsp.rename(tmp, abs);
      activated = true;
      const actual = await fsp.readFile(abs);
      if (!Buffer.isBuffer(actual) || !actual.equals(parsed.buffer)) throw new Error('attachment read-back mismatch');
    } catch (e) {
      // A rejected upload owns both names it created. Do not leave an unverified final file for a later
      // history reference to discover, or a pre-rename temp file to accumulate forever. Only remove `abs`
      // after our rename succeeded; a collision/failing rename must never delete somebody else's target.
      if (tmp) { try { await fsp.rm(tmp, { force: true }); } catch (cleanupError) { failNote('attachments.reject-temp-cleanup', cleanupError); } }
      if (activated) { try { await fsp.rm(abs, { force: true }); } catch (cleanupError) { failNote('attachments.reject-final-cleanup', cleanupError); } }
      return { ok: false, code: 500, error: 'write failed' };
    }
    return { ok: true, id, name, path: rel, mediaType: parsed.mime, kind, size: parsed.buffer.length };
  }

  // Best-effort delete of an attachment the Commander removed before sending (avoids orphaned bytes). The path
  // must be a real .attachments/ reference; anything else is refused. Never throws; returns { ok }.
  async function removeAttachment(agentId, rel) {
    const r = String(rel || '');
    if (r.indexOf(ATTACH_DIR + '/') !== 0) return { ok: false, error: 'not an attachment path' };
    try { const { abs } = await resolveInside(agentId, r); await fsp.rm(abs, { force: true }); return { ok: true }; }
    catch (e) { return { ok: false, error: 'remove failed' }; }
  }

  // tolerant text extractor for a user turn whose content is already an array — salvages the typed text when
  // expanding attachments. The provider adapters have their own richer content mappers.
  function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const out = [];
    for (const p of content) {
      if (typeof p === 'string') out.push(p);
      else if (p && typeof p.text === 'string') out.push(p.text);
    }
    return out.join('');
  }

  // Expand each user message's attachment references into provider content blocks, just before the model call.
  // Bounded by IMAGE_BUDGET so a long photo history can't blow the request/token size. Messages without
  // attachments pass untouched (byte-identical), so this is a no-op for every existing caller.
  // opts.place(rel) (run-paths lane): names a saved attachment the way THIS run's file/shell tools resolve it — the
  // jail-relative path outside a project, the absolute path in a project run (where a relative path means the project).
  async function expandUserAttachments(messages, agentId, opts) {
    const place = opts && typeof opts.place === 'function' ? opts.place : (rel => rel);
    if (!Array.isArray(messages)) return messages;
    if (!messages.some(m => m && m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length)) return messages;
    let imageBudget = IMAGE_BUDGET;
    const out = [];
    for (const m of messages) {
      if (!m || m.role !== 'user' || !Array.isArray(m.attachments) || !m.attachments.length) { out.push(m); continue; }
      const blocks = [];
      const text = textOf(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const att of m.attachments) {
        const a = att || {};
        const name = String(a.name || 'file');
        const rel = String(a.path || '');
        let buf = null;
        let absPath = '';
        try { const { abs } = await resolveInside(agentId, rel); absPath = abs; buf = await fsp.readFile(abs); }
        catch (e) { blocks.push({ type: 'text', text: '\n[attachment "' + name + '" is no longer available]' }); continue; }
        const mime = String(a.mediaType || '').toLowerCase();
        if (a.kind === 'image' && IMAGE_MIME[mime]) {
          if (buf.length > imageBudget) { blocks.push({ type: 'text', text: '\n[image "' + name + '" omitted — over this message\'s image budget]' }); continue; }
          imageBudget -= buf.length;
          // tagged (off-wire) with its name + absolute saved path: should the model turn out not to see images, the
          // adapter's note (provider.withoutImageParts) can then say which file it was and where image_analyze reads it
          blocks.push(tagImageSource({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buf.toString('base64') } }, { name, path: absPath }));
        } else if (looksTextual(name, mime)) {
          let t = buf.toString('utf8'); let note = '';
          if (t.length > TEXT_INLINE_MAX) { t = t.slice(0, TEXT_INLINE_MAX); note = '\n…[truncated]'; }
          blocks.push({ type: 'text', text: '\n\n[Attached file: ' + name + ']\n```\n' + t + note + '\n```\n[saved in your workspace at ' + place(rel) + ']' });
        } else {
          // honest AND actionable: the bytes are real and jailed in the agent's workspace — name the path so the
          // agent can operate on the file with its tools instead of dead-ending on "can't read this".
          const what = /^video\//.test(mime) ? 'a video — you cannot watch it directly, but the file is real'
            : /^audio\//.test(mime) ? 'an audio file — you cannot listen to it directly, but the file is real'
            : 'a file type you cannot view directly';
          blocks.push({ type: 'text', text: '\n[Attached file: ' + name + ' (' + (mime || 'binary') + ') — ' + what + '; it is saved in your workspace at ' + place(rel) + ' and your file/shell tools can operate on it]' });
        }
      }
      const clone = Object.assign({}, m, { content: blocks.length ? blocks : '' });
      delete clone.attachments;
      out.push(clone);
    }
    return out;
  }

  /* expandForRun(messages, agentId, projectRoot) — the RUN HOST's expansion (run-paths review M3). runOnceCore calls it
     for every surface once the run's project root is final, so the saved file is named by the same rule the run's
     ctx.paths applies (placeJail: the jail-relative name in an unscoped run, the absolute path in a project run, where
     a relative path means the project). The COMMS page and the channel hubs used to expand before runOnce with no root
     (a line-bound channel run is project-scoped) or with one a queued coordinated turn was later re-scoped away from.
     A failed expansion strips the references, so no provider ever sees a shape it does not know.
     STORED NAMES TOO (review round 2): a channel's stored turn names a saved file by its jail-relative name
     (".attachments/<id>.<ext>", hub.js ingestMedia), and history replays as plain text. A project-scoped run reads every
     such name in a user turn as the absolute spelling (placeJail), made here and only here, so the stored text that is
     replayed to the model, in group chats too, never carries a host path, while the run's tools still reach the file.
     Unscoped, or with no such name, the messages come back untouched. */
  const SAVED_NAME = /(^|[^\w.\\/-])(\.attachments\/[0-9A-Za-z-]{8,64}\.[A-Za-z0-9]{1,8})(?![\w\\/-]|\.\w)/g;
  function placeSavedNames(m, place) {
    if (!m || m.role !== 'user') return m;
    const fix = t => String(t).replace(SAVED_NAME, (all, lead, rel) => lead + place(rel));
    if (typeof m.content === 'string') { const t = fix(m.content); return t === m.content ? m : Object.assign({}, m, { content: t }); }
    if (!Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map(b => {
      if (!b || b.type !== 'text' || typeof b.text !== 'string') return b;
      const t = fix(b.text);
      if (t === b.text) return b;
      changed = true;
      return Object.assign({}, b, { text: t });
    });
    return changed ? Object.assign({}, m, { content }) : m;
  }
  async function expandForRun(messages, agentId, projectRoot) {
    if (!Array.isArray(messages)) return messages;
    const refs = messages.some(m => m && m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length);
    const scoped = typeof projectRoot === 'string' && !!projectRoot.trim();
    const named = scoped && messages.some(m => m && m.role === 'user' && new RegExp(SAVED_NAME.source).test(textOf(m.content)));
    if (!refs && !named) return messages;
    let place;
    try {
      if (!deps.workspaces) throw new Error('attachments: no workspaces root to name the saved file against');
      place = RunPaths.makeRunPaths(RunPaths.makeResolver({ pathMod: path, root: deps.workspaces }), { agentId, projectRoot: projectRoot || '' }).placeJail;
    } catch (e) { failNote('attachments.place', e); }
    let out = messages;
    if (refs) {
      try { out = await expandUserAttachments(messages, agentId, place ? { place } : undefined); }
      catch (e) {
        failNote('attachments.expand', e);
        out = messages.map(m => { if (!m || !Array.isArray(m.attachments)) return m; const c = Object.assign({}, m); delete c.attachments; return c; });
      }
    }
    return (named && place) ? out.map(m => placeSavedNames(m, place)) : out;
  }

  return {
    MAX_BYTES, IMAGE_BUDGET, TEXT_INLINE_MAX,
    saveAttachment, removeAttachment, expandUserAttachments, expandForRun,
    _internals: { parseDataUrl, looksTextual, textOf, IMAGE_MIME }
  };
};
