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
const UserText = require('../frontend/app/usertext.js');   // the one flattener of a message's text parts (DIRECTIVE policy)
const { cleanName, cleanMime } = require('./attachment-name.js');   // the ONE rule for a sender-chosen name and media type that a note echoes

/* WHICH ATTACHMENTS' BYTES A RUN RE-SENDS (attachment-rows-and-taint, S1).
   The browser keeps every sent turn's references, so each run used to re-read and re-send every attachment of the whole
   history, oldest first against the image budget: the NEWEST picture was the one dropped, and a screenshot ten turns old
   rode along (and kept the run tainted) on every later turn. Bytes now go out only for the newest RESEND_K attachments of
   the newest RESEND_TURNS user turns (the attaching turn and one follow-up). The current directive's newest attachment is
   exempt from the count and the byte budget, and the budget is spent newest first. Every other reference becomes a
   one-line marker that names the saved file and the tools that open it, and is not even read. TAINT FOLLOWS THESE BYTES:
   expandUserAttachments reports what it actually read and sent under RESENT (one entry per reference), so a later step can
   latch on bytes in context instead of on a reference merely being present in the history. */
const RESEND_K = 4;
const RESEND_TURNS = 2;
const RESEND_IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;   // the picture types expandOne sends as image blocks
const RESENT = Symbol.for('starnet.attachments.resent');   // off-wire (never enumerable): the report on an expansion's result array

const hasRefs = m => !!(m && m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length);
// a user message that counts as a turn: the very rule TurnDirective.capture applies to find the current directive
const isTurn = m => !!(m && m.role === 'user' && (UserText.flatten(m.content, UserText.DIRECTIVE) != null || (Array.isArray(m.attachments) && m.attachments.length)));

/* selectResend(messages) — pure. The references whose bytes go on the wire, NEWEST FIRST (the order the byte budget is
   spent in): [{ m: message index, a: attachment index, age: user turns back (0 = the current directive), exempt }].
   Walks the user turns newest to oldest and each turn's references last to first (the last one staged is the newest).
   `exempt` marks the current directive's newest attachment: never cut by the count or the budget. A budget miss does not
   free a place for an older reference, so what is sent never depends on file sizes except through the budget itself. */
function selectResend(messages) {
  const picks = [];
  if (!Array.isArray(messages)) return picks;
  let age = 0;
  for (let m = messages.length - 1; m >= 0 && age < RESEND_TURNS; m--) {
    const msg = messages[m];
    if (!isTurn(msg)) continue;
    const refs = Array.isArray(msg.attachments) ? msg.attachments : [];
    // the current directive's newest IMAGE is exempt too: K counts every kind, so an image staged before K other files must not be the one cut
    let img = -1;
    if (age === 0) for (let a = refs.length - 1; a >= 0 && img < 0; a--) { const x = refs[a] || {}; if (x.kind === 'image' && RESEND_IMAGE_MIME.test(String(x.mediaType || '').toLowerCase())) img = a; }
    for (let a = refs.length - 1; a >= 0; a--) {
      const exempt = age === 0 && (picks.length === 0 || a === img);
      if (exempt || picks.length < RESEND_K) picks.push({ m, a, age, exempt });
    }
    age++;
  }
  return picks;
}

// the report an expansion carried (see RESENT); [] for anything that has none
function resentOf(messages) {
  const r = messages ? messages[RESENT] : null;
  return Array.isArray(r) ? r : [];
}
function carryReport(to, report) { Object.defineProperty(to, RESENT, { value: report, enumerable: false }); return to; }

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
  // is the file still there? (the forget registry counts a removal only when there was a file to remove, so a second pass reports nothing)
  async function hasAttachment(agentId, rel) {
    const r = String(rel || '');
    if (r.indexOf(ATTACH_DIR + '/') !== 0) return false;
    try { const { abs } = await resolveInside(agentId, r); await fsp.stat(abs); return true; }
    catch (e) { return false; }
  }

  // tolerant text extractor for a user turn whose content is already an array — salvages the typed text when
  // expanding attachments. The provider adapters have their own richer content mappers.
  function textOf(content) {
    const t = UserText.flatten(content, UserText.DIRECTIVE);
    return t == null ? '' : t;   // an unknown shape salvages nothing
  }

  const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
  // a sender-chosen NAME goes into bracketed host text through the one rule (attachment-name.js): one line, no bracket or angle bracket,
  // nothing hidden, 120 code points. Every echo below uses it: the markers, the header, the binary note and the tag the adapter's note reads
  const noteName = cleanName;
  // only a real saved attachment is NAMED in a note: a reference outside .attachments/ (or climbing out of it) is never echoed
  const namable = rel => /^\.attachments\/[^\u0000-\u001f\u007f\[\]\\]+$/.test(rel) && !/(^|\/)\.\.(\/|$)/.test(rel);
  const entryOf = a => ({ id: String(a.id || ''), name: String(a.name || 'file'), mediaType: String(a.mediaType || '').toLowerCase(),
    kind: String(a.kind || ''), path: String(a.path || ''), size: null, sha256: null, bytes: false });

  // Expand each user message's attachment references into provider content blocks, just before the model call.
  // WHICH references carry bytes is selectResend's call (the newest RESEND_K of the newest RESEND_TURNS user turns); every
  // other reference becomes a marker naming the saved file and the tools that open it, and is not even read. The image
  // budget (IMAGE_BUDGET, decoded bytes for the whole run) is spent NEWEST first, so a long photo history can never crowd out
  // the picture just sent. Messages without attachments pass untouched (byte-identical), so this is a no-op for every
  // existing caller.
  // The result array carries, off-wire under RESENT, the report of what was read and sent: one entry per reference in
  // document order, { id, name, mediaType, kind, path, size, sha256, bytes }. size and sha256 are those of the buffer this
  // call read (null when it read nothing: a marker, an unreadable file); bytes is true only for an image_url block or an
  // inlined text block, never for a note, a marker or a binary-only file.
  // opts.place(rel) (run-paths lane): names a saved attachment the way THIS run's file/shell tools resolve it — the
  // jail-relative path outside a project, the absolute path in a project run (where a relative path means the project).
  async function expandUserAttachments(messages, agentId, opts) {
    const place = opts && typeof opts.place === 'function' ? opts.place : (rel => rel);
    if (!Array.isArray(messages)) return messages;
    if (!messages.some(hasRefs)) return messages;
    let imageBudget = IMAGE_BUDGET;

    // a reference that is not re-sent: the marker, with nothing read
    function markerOf(att, now) {
      const entry = entryOf(att || {});
      const text = namable(entry.path)
        ? '\n[' + (now ? 'attached just now but not shown (over the per-turn limit)' : 'attached earlier') + ': ' + noteName(entry.name) + ' - saved at ' + place(entry.path) + '; open it with fs.read / image_analyze]'
        : '\n[attachment "' + noteName(entry.name) + '" is no longer available]';
      return { block: { type: 'text', text }, entry };
    }
    // a reference that is re-sent: read it, spend the budget, and say what was put on the wire
    async function expandOne(att, exempt) {
      const a = att || {};
      const entry = entryOf(a);
      const name = entry.name, rel = entry.path, mime = entry.mediaType;
      let buf = null;
      let absPath = '';
      try { const { abs } = await resolveInside(agentId, rel); absPath = abs; buf = await fsp.readFile(abs); }
      catch (e) { return { block: { type: 'text', text: '\n[attachment "' + noteName(name) + '" is no longer available]' }, entry }; }
      entry.size = buf.length;
      entry.sha256 = sha256(buf);
      if (a.kind === 'image' && IMAGE_MIME[mime]) {
        if (!exempt && buf.length > imageBudget) {
          return { block: { type: 'text', text: '\n[image "' + noteName(name) + '" omitted - over the image budget]' + (namable(rel) ? ' [saved at ' + place(rel) + '; open it with image_analyze]' : '') }, entry };
        }
        imageBudget -= buf.length;
        entry.bytes = true;
        // tagged (off-wire) with its name + absolute saved path: should the model turn out not to see images, the
        // adapter's note (provider.withoutImageParts) can then say which file it was and where image_analyze reads it
        return { block: tagImageSource({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buf.toString('base64') } }, { name: noteName(name), path: absPath }), entry };
      }
      if (looksTextual(name, mime)) {
        let t = buf.toString('utf8'); let note = '';
        if (t.length > TEXT_INLINE_MAX) { t = t.slice(0, TEXT_INLINE_MAX); note = '\n…[truncated]'; }
        entry.bytes = true;
        return { block: { type: 'text', text: '\n\n[Attached file: ' + noteName(name) + ']\n```\n' + t + note + '\n```\n' + (namable(rel) ? '[saved in your workspace at ' + place(rel) + ']' : '') }, entry };
      }
      // honest AND actionable: the bytes are real and jailed in the agent's workspace — name the path so the
      // agent can operate on the file with its tools instead of dead-ending on "can't read this".
      const what = /^video\//.test(mime) ? 'a video — you cannot watch it directly, but the file is real'
        : /^audio\//.test(mime) ? 'an audio file — you cannot listen to it directly, but the file is real'
        : 'a file type you cannot view directly';
      // The NAME and the media type are the sender's words, not the host's: the name goes through the one rule, the type only as a plain
      // token (else "binary"), the path only for a real saved attachment. A file that sends no bytes leaves the run clean, so this note is
      // where its name meets a model that is not locked: it must hold the bound every other note holds.
      return { block: { type: 'text', text: '\n[Attached file: ' + noteName(name) + ' (' + (cleanMime(mime) || 'binary') + ') — ' + what + (namable(rel) ? '; it is saved in your workspace at ' + place(rel) + ' and your file/shell tools can operate on it' : '') + ']' }, entry };
    }

    // 1. read and spend the budget NEWEST first
    const done = new Map();
    let cur = -1;   // the current directive's message index: a miss there was attached in THIS turn, not earlier
    for (let m = messages.length - 1; m >= 0 && cur < 0; m--) if (isTurn(messages[m])) cur = m;
    for (const p of selectResend(messages)) done.set(p.m + ':' + p.a, await expandOne(messages[p.m].attachments[p.a], p.exempt));
    // 2. assemble in message order
    const report = [];
    const out = messages.map((m, mi) => {
      if (!hasRefs(m)) return m;
      const blocks = [];
      const text = textOf(m.content);
      if (text) blocks.push({ type: 'text', text });
      m.attachments.forEach((att, ai) => {
        const r = done.get(mi + ':' + ai) || markerOf(att, mi === cur);
        blocks.push(r.block);
        report.push(r.entry);
      });
      const clone = Object.assign({}, m, { content: blocks.length ? blocks : '' });
      delete clone.attachments;
      return clone;
    });
    return carryReport(out, report);
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
     Unscoped, or with no such name, the messages come back untouched.
     THE REPORT (RESENT) rides through every branch: the expansion's own, carried onto the rewritten copy a project run
     makes, and an EMPTY one when the expansion failed (the references are stripped, nothing was sent, and a guess would
     be worse than nothing). Messages with no references come back as they are, with no report; resentOf() reads [] then. */
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
    const refs = messages.some(hasRefs);
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
        out = carryReport(messages.map(m => { if (!m || !Array.isArray(m.attachments)) return m; const c = Object.assign({}, m); delete c.attachments; return c; }), []);
      }
    }
    if (!(named && place)) return out;
    const placed = out.map(m => placeSavedNames(m, place));
    return Array.isArray(out[RESENT]) ? carryReport(placed, out[RESENT]) : placed;
  }

  return {
    MAX_BYTES, IMAGE_BUDGET, TEXT_INLINE_MAX, RESEND_K, RESEND_TURNS, RESENT,
    saveAttachment, removeAttachment, hasAttachment, expandUserAttachments, expandForRun, selectResend, resentOf,
    _internals: { parseDataUrl, looksTextual, textOf, IMAGE_MIME }
  };
};
// the policy and its names ride on the factory too, so a caller with no instance (a test, a decision note) reads one number
Object.assign(module.exports, { RESEND_K, RESEND_TURNS, RESENT, selectResend, resentOf });
