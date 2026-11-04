/* sidecar/artifacts.js — the per-run ARTIFACTS collector (work-visibility slice 1).

   The app does real work but the finished run leaves no compact record of WHAT it produced — the runstore
   row says "done, 7 turns, $0.04" and nothing else. This module folds the run's tool observations into a
   small deliverables ledger ({kind, path?, target?, bytes?} records) that runOnce hands to runStore.record()
   at run end, so the RUNS panel / end-of-run recap can honestly answer "what did this run make?".

   What it detects (from REAL tool result shapes — see sidecar/tools/builtin/fs.js + image.js):
     fs.write / fs.append / fs.edit  -> { kind:'file',  path, bytes? }   (path = args.path; bytes where knowable)
     fs.patch                        -> { kind:'file',  path } per written file (paths parsed from the V4A
                                        envelope headers args.patch carries — the tool result names no paths)
     image_generate                  -> { kind:'image', path }           (path parsed from the tool's own
                                        "image → <rel>" summary — the SAVED path, not the requested one)
     mcp__<server>__<send-ish tool>  -> { kind:'message', target:<server> }  (an MCP connector is the only
                                        in-run path that can send to a channel today; the Telegram/Discord hub
                                        delivers the REPLY after runOnce returns, outside any tool call)
   target/path are display labels only: NEVER message content, NEVER chat ids — nothing secret/PII enters
   the ledger. Failed calls (result.ok === false / isError) produce nothing. Unknown tools are ignored.
   Repeated writes to the same path dedupe (last bytes win). Capped: max 50 records, strings cut at 260. A file or image
   path cut at 260 marks its record cut:true (absent otherwise): the label is then a prefix of what was written, and
   nothing may publish it as the path (turn-identity deliverable rows skip it). runstore.js does not persist the flag.

   PURE (matches runstore.js): no ambient time/rng/IO — this passes lint-determinism and tests headlessly.

   makeArtifactCollector({ maxEntries?, maxChars? }) -> {
     observe({ toolName, args, result }),   // fold one FINISHED tool call into the ledger (never throws)
     add({ kind, path?, target?, bytes? }), // host-side explicit note (same sanitize/dedupe/caps)
     list() -> artifact[],                  // cloned, insertion-ordered
     count() -> int
   } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).artifacts = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_ENTRIES = 50;    // a run that writes 500 files still records a bounded ledger
  const STR_MAX = 260;       // classic MAX_PATH — a path/target label is display data, not a blob

  // UTF-8 byte length without Buffer (pure; matches Buffer.byteLength(s, 'utf8') for well-formed strings).
  function utf8Len(s) {
    s = String(s == null ? '' : s);
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.codePointAt(i);
      if (c > 0xffff) i++;                                   // astral pair consumes two UTF-16 units
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    }
    return n;
  }

  // V4A patch envelope -> the workspace-relative paths the patch WROTE. Mirrors patchparse.js's header
  // grammar (Add/Update/Delete/Move) without importing the full parser: fs.patch's result names no paths
  // ("Applied patch: N files changed."), so the envelope is the only place they surface. A Delete writes
  // nothing; an Update followed by "Move to:" lands at the destination path.
  function patchWrites(patch) {
    const lines = String(patch == null ? '' : patch).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let lastUpdate = -1;   // index in `out` of the most recent Update File (a "Move to:" renames it)
    for (const line of lines) {
      let m;
      if ((m = /^\*\*\*\s*Add File:\s*(.+?)\s*$/.exec(line))) { out.push(m[1]); lastUpdate = -1; }
      else if ((m = /^\*\*\*\s*Update File:\s*(.+?)\s*$/.exec(line))) { out.push(m[1]); lastUpdate = out.length - 1; }
      else if ((m = /^\*\*\*\s*Move to:\s*(.+?)\s*$/.exec(line))) { if (lastUpdate >= 0) { out[lastUpdate] = m[1]; lastUpdate = -1; } }
      else if ((m = /^\*\*\*\s*Move File:\s*(.+?)\s*->\s*(.+?)\s*$/.exec(line))) { out.push(m[2]); lastUpdate = -1; }
      else if (/^\*\*\*\s*Delete File:/.test(line)) { lastUpdate = -1; }
    }
    return out;
  }

  // image_generate reports the SAVED path in its own result ("image → <rel>" summary; args.path may be empty
  // or extension-less — the tool picks the real name). Summary first, content sentence as the fallback.
  function imagePathFrom(result) {
    let m = /^image → (.+)$/.exec(String((result && result.summary) || ''));
    if (m) return m[1];
    m = /^Generated and saved (.+?) \(/.exec(String((result && result.content) || ''));
    return m ? m[1] : '';
  }

  // Conservative MCP channel-send match: a send-ish VERB and a message-ish NOUN in the tool segment (or a
  // bare "send"), e.g. mcp__slack__post_message / mcp__telegram__sendMessage / mcp__gmail__send_email.
  // The target is the SERVER label from the tool name only — args (recipients, chat ids, content) never enter.
  function mcpMessageTarget(toolName) {
    const m = /^mcp__(.+?)__(.+)$/.exec(String(toolName == null ? '' : toolName));
    if (!m) return '';
    const rest = m[2];
    const verb = /(^|[^a-z])(send|post|publish|reply|notify)/i.test(rest);
    const noun = /(message|msg|chat|channel|dm|email|mail|webhook|notification|sms|text|tweet)/i.test(rest);
    return ((verb && noun) || /^send$/i.test(rest)) ? m[1] : '';
  }

  function makeArtifactCollector(opts) {
    opts = opts || {};
    const cap = (typeof opts.maxEntries === 'number' && opts.maxEntries > 0) ? opts.maxEntries : MAX_ENTRIES;
    const strMax = (typeof opts.maxChars === 'number' && opts.maxChars > 0) ? opts.maxChars : STR_MAX;
    const rows = [];
    const byKey = new Map();   // kind + '\u0000' + (path|target) -> row (dedupe: last write wins)

    function capStr(s) { return String(s == null ? '' : s).slice(0, strMax); }

    function upsert(kind, keyVal, fields) {
      const key = kind + '\u0000' + keyVal;
      const prior = byKey.get(key);
      if (prior) { Object.assign(prior, fields); return prior; }   // repeat write to the same path: keep LAST bytes
      if (rows.length >= cap) return null;                          // full — a monster run stays bounded
      const rec = Object.assign({ kind }, fields);
      rows.push(rec); byKey.set(key, rec);
      return rec;
    }

    function addFile(kind, path, bytes) {
      const p = capStr(path);
      if (!p) return;
      const fields = { path: p };
      if (String(path).length > strMax) fields.cut = true;   // a prefix of the written path, never the path itself
      if (typeof bytes === 'number' && isFinite(bytes) && bytes >= 0) fields.bytes = Math.floor(bytes);
      upsert(kind, p, fields);
    }
    function addMessage(target) {
      const t = capStr(target);
      if (!t) return;
      upsert('message', t, { target: t });
    }

    // fold one finished tool call in. Only SUCCESSFUL calls count (a denied/failed tool produced nothing);
    // any unknown tool is ignored. Never throws — the caller wraps it anyway, belt and suspenders.
    function observe(ob) {
      try {
        ob = ob || {};
        const r = ob.result;
        if (!r || r.ok === false || r.isError) return;
        const name = String(ob.toolName || ob.name || '');
        const args = (ob.args && typeof ob.args === 'object') ? ob.args : {};
        if (name === 'fs.write') return addFile('file', args.path, utf8Len(args.content));
        if (name === 'fs.append') {
          const m = /now (\d+)\)/.exec(String(r.content || ''));   // "Appended to p (+N bytes, now M)." -> M = the file's real size
          return addFile('file', args.path, m ? Number(m[1]) : undefined);
        }
        if (name === 'fs.edit') return addFile('file', args.path, undefined);
        if (name === 'fs.patch') { for (const p of patchWrites(args.patch)) addFile('file', p, undefined); return; }
        if (name === 'image_generate') { const p = imagePathFrom(r); if (p) addFile('image', p, undefined); return; }
        const target = mcpMessageTarget(name);
        if (target) return addMessage(target);
      } catch (_) { /* a collector hiccup must never break a run */ }
    }

    // host-side explicit note (e.g. a future channel-delivery seam) — same sanitize/dedupe/caps as observe.
    function add(art) {
      try {
        art = art || {};
        if (art.kind === 'file' || art.kind === 'image') return addFile(art.kind, art.path, art.bytes);
        if (art.kind === 'message') return addMessage(art.target);
      } catch (_) {}
    }

    return {
      observe, add,
      list() { return rows.map(r => Object.assign({}, r)); },
      count() { return rows.length; }
    };
  }

  return { makeArtifactCollector, _internals: { utf8Len, patchWrites, mcpMessageTarget, imagePathFrom, MAX_ENTRIES, STR_MAX } };
});
