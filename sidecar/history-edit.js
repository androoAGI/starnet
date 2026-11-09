/* sidecar/history-edit.js — THE HISTORY-EDIT RESOLVER (W1.7 context groundwork, 2026-11-08).

   The harness edits what the model has already seen: a tool.search reveal grows `tools`, a stale screen capture
   becomes a placeholder, the micro tier elides old tool results, a paid or fallback fold replaces older turns with a
   note, a length-cut reply is collapsed in place. Each edit has the same four consequences, and they live HERE, in one
   place, so a new edit path (batched ageing, cross-run replay) cannot forget one:

   1. THE THINKING AN EDIT INVALIDATES IS STRIPPED, AND NOTHING ELSE (makeRequestView). On the binding Claude models
      (providers/anthropic.js BINDING_CLAUDE) a thinking block's signature records the prefix that produced it: system,
      tools, every earlier message, every earlier block of its own turn. After an edit at message e, every block at or
      after e no longer matches. The API (drop_block) then drops the first stale block AND every later one, on every
      request: the stale block stays in history, so each new turn's valid block is dropped behind it (the cascade). The
      view diffs each outgoing request against the last one it handed out (fingerprints that leave `reasoning` out; a
      change to `tools` counts as an edit at 0) and, on a provider that binds, strips the blocks at or after the first
      changed message: exactly the set the API would drop on that request. They stay stripped (sticky, keyed by the
      reasoning array), so later requests keep the prefix the post-edit blocks were signed against. Blocks before the
      edit and every block produced after it replay intact: zero drops after an edit. One deliberate over-strip: when
      the first changed message is itself an assistant turn rewritten in place (only collapseContinuation does that),
      its own blocks go too, because whether they still bind depends on where they sat inside the turn. The transcript
      is never mutated: a stripped turn goes out as a reasoning-free copy, the same copy every request.
   2. AN ELIDED BODY KEEPS A HANDLE (elideToolResult: the ONE stub/handle builder; W1.8 cross-run replay reuses it).
      The micro tier's stub kept 240 chars and said "re-run the tool": a write-free re-run is not always possible, and a
      re-run of a command is not the same bytes. The stub now names an fs.read call that returns the elided bytes:
      the path the host already parked the full output to (registry / turn budget), the same fs.read call for an
      fs.read result, or a park of the exact body made at elision through the host parker (capCtx.parkOutput, which
      verifies its write byte for byte). Quoted words (recall of another session) are never parked: those keep the
      old wording. A body the 240-char head keeps whole is not elided at all: its stub could only add bytes.
   3. A FOLD'S OWN REQUEST WRITES NO CACHE (foldRequest). A summarizer chunk is a one-shot, toolless request whose
      prefix is never sent again, yet every chunk was anchored and paid the cache-write premium (1.25x on the Anthropic
      API, 2.0x on the claude-cli child's 1h cache) for a read that never comes. Same switch as the ledger's aux
      meter (issue #105): `neverReread`, which every adapter already honours.
   4. A CUT OUTPUT KEEPS ITS HEAD AND ITS TAIL (headTail). shell.exec, verify and MCP results over their 64k cap kept
      only the head: a build or test log ends where the error is, and that end was the part thrown away. The same 64k
      now holds the first 70% and the last 30% (the registry's clampOutput cut), with the gap marked in place.

   Pure apart from the injected parker; no clock; UMD so loop.js can load it wherever it loads. */
'use strict';
(function (root, factory) {
  const crypto = (typeof require === 'function') ? (function () { try { return require('crypto'); } catch (_) { return null; } })() : null;
  const api = factory(crypto);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).historyEdit = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nodeCrypto) {
  'use strict';

  // ---------------------------------------------------------------- 4. head + tail
  const HEAD_SHARE = 0.7;   // the registry's clampOutput and the loop's turn squeeze cut 70/30 too
  const isHigh = c => c >= 0xD800 && c <= 0xDBFF;
  const isLow = c => c >= 0xDC00 && c <= 0xDFFF;
  /* headTail(text, max, noteFor?) -> text whose kept characters total `max`: the first 70% and the last 30%, with
     noteFor(droppedChars) between them (the marker rides on top of the budget, as the head-only notes did). A text at
     or under `max` comes back unchanged. Never splits a UTF-16 surrogate pair. */
  function headTail(text, max, noteFor) {
    const s = String(text == null ? '' : text);
    const limit = Math.floor(Number(max));
    if (!(limit > 0) || s.length <= limit) return s;
    let head = Math.floor(limit * HEAD_SHARE);
    let tailFrom = s.length - (limit - head);
    if (head > 0 && isHigh(s.charCodeAt(head - 1))) head--;
    if (tailFrom < s.length && isLow(s.charCodeAt(tailFrom))) tailFrom++;
    const dropped = tailFrom - head;
    const note = typeof noteFor === 'function' ? String(noteFor(dropped))
      : '\n\n[... ' + dropped + ' characters from the middle are not shown here; the end follows ...]\n\n';
    return s.slice(0, head) + note + s.slice(tailFrom);
  }

  // ---------------------------------------------------------------- 2. elision stubs
  const ELIDED = '[tool result elided at compaction — ';
  // KEEP THE HEAD (live-proved 08-21: a bare "[elided]" marker made the model confabulate 20 of 30 file values).
  const ELIDE_HEAD = 240;
  const READ_ARGS = ['path', 'offset', 'limit', 'numbered', 'raw'];   // fs.read's own schema, in its order
  const isFsRead = name => String(name == null ? '' : name).replace(/\./g, '_') === 'fs_read';
  function isElided(m) { return !!m && m.role === 'tool' && typeof m.content === 'string' && m.content.indexOf(ELIDED) === 0; }
  function utf8Bytes(s) {
    if (typeof Buffer !== 'undefined' && Buffer.byteLength) return Buffer.byteLength(s, 'utf8');
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
      else if (isHigh(c) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) { n += 4; i++; } else n += 3;
    }
    return n;
  }
  const readCall = args => {
    const out = {};
    for (const k of READ_ARGS) if (args[k] !== undefined && args[k] !== null) out[k] = args[k];
    return 'fs.read ' + JSON.stringify(out);
  };
  function stubText(text, name, handle) {
    const head = text.length > ELIDE_HEAD ? text.slice(0, ELIDE_HEAD).replace(/\s+$/, '') + '…' : text;
    const how = !handle ? 're-run the tool for the full output'
      : handle.via === 'range' ? 'read it again with ' + handle.call
      : handle.via === 'saved' ? 'the whole result is saved: read it with ' + handle.call
      : 'the output saved before it was cut: read it with ' + handle.call;
    return ELIDED + name + ', ' + utf8Bytes(text) + ' bytes; first ' + Math.min(ELIDE_HEAD, text.length) + ' chars kept below; ' + how + ']\n' + head;
  }
  /* elideToolResult(body, o) -> Promise<{ content, handle } | null>   THE ONE STUB/HANDLE BUILDER (W1.8 reuses it).
     body: the tool message's content (a non-string is elided as its JSON, as before).
     o.name        the tool as the call named it (fs.read / fs_read get a range handle)
     o.args        the call's parsed arguments (fs.read's path/offset/limit/numbered/raw are the range handle)
     o.exact       false when the body is NOT the tool's own output (a duplicate note was appended, the turn budget cut
                   it): an fs.read range would not read it back, so a park stands in
     o.isError     an error result: its text is not what a re-read returns, so never a range
     o.parkedPath  where the host already parked this result's output before cutting it (registry, turn budget)
     o.park        async (text, meta) -> { path } | null: the host parker (capCtx.parkOutput). Omitted = no new park
                   (the micro tier's dry measurement): such a body keeps the old "re-run the tool" wording
     o.parkMeta    provenance for that park ({ quotedStreams, taintedBy }); quoted words are never parked
   null = nothing to elide (the head keeps the body whole). handle: { via: 'parked'|'range'|'saved', call, path? } —
   `call` is a ready-to-run fs.read that returns the elided bytes (a 'parked' file holds the output before it was cut,
   so it returns those bytes and the part the cut dropped). */
  async function elideToolResult(body, o) {
    o = o || {};
    const text = typeof body === 'string' ? body : JSON.stringify(body == null ? '' : body);
    if (text.length <= ELIDE_HEAD) return null;
    const name = String(o.name || 'tool');
    const pathCall = p => 'fs.read ' + JSON.stringify({ path: p });
    let handle = null;
    if (o.parkedPath) handle = { via: 'parked', path: String(o.parkedPath), call: pathCall(String(o.parkedPath)) };
    else if (o.exact !== false && o.isError !== true && isFsRead(name) && o.args && typeof o.args === 'object'
      && typeof o.args.path === 'string' && o.args.path) handle = { via: 'range', call: readCall(o.args) };
    const meta = o.parkMeta || {};
    const quoted = Array.isArray(meta.quotedStreams) && meta.quotedStreams.length > 0;
    if (!handle && !quoted && typeof o.park === 'function') {
      let p = null;
      try { p = await o.park(text, Object.assign({}, meta, { tool: name, reason: 'elided-at-compaction' })); } catch (_) { p = null; }
      if (p && p.path) handle = { via: 'saved', path: String(p.path), call: pathCall(String(p.path)) };
    }
    return { content: stubText(text, name, handle), handle };
  }

  // ---------------------------------------------------------------- 3. fold requests
  function foldRequest(req) { if (req && typeof req === 'object') req.neverReread = true; return req; }

  // ---------------------------------------------------------------- 1. the request view
  function hashOf(s) {
    if (nodeCrypto) return nodeCrypto.createHash('sha1').update(s).digest('base64');
    let a = 0x811c9dc5, b = 0x01000193 ^ s.length;   // two FNV-1a lanes (a browser copy has no crypto)
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 2246822519); }
    return (a >>> 0).toString(36) + '.' + (b >>> 0).toString(36) + '.' + s.length;
  }
  // What a message is on the wire, minus its reasoning (role, content, the calls, the result's ids), memoised per object.
  const keyMemo = (typeof WeakMap === 'function') ? new WeakMap() : null;
  function wireKey(m) {
    if (!m || typeof m !== 'object') return 'v:' + String(m);
    const len = Array.isArray(m.content) ? m.content.length : -1;
    const hit = keyMemo && keyMemo.get(m);
    if (hit && hit.content === m.content && hit.len === len && hit.calls === m.tool_calls && hit.role === m.role
      && hit.id === m.tool_call_id && hit.cid === m.call_id && hit.name === m.name) return hit.key;
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? null : m.content);
    const key = hashOf(JSON.stringify([m.role || '', m.tool_call_id || '', m.call_id || '', m.name || '', m.tool_calls || null]) + '\u0000' + content);
    if (keyMemo) keyMemo.set(m, { content: m.content, len, calls: m.tool_calls, role: m.role, id: m.tool_call_id, cid: m.call_id, name: m.name, key });
    return key;
  }
  /* makeRequestView() -> { messages(list, { tools, binds }) -> { messages, editAt, stripped } }   one per run.
     list: what the loop would send (screen captures already aged out). binds: the provider binds thinking to its
     prefix for this model (provider.bindsThinking). Returns the list ITSELF when nothing is stripped. editAt: the first
     changed message since the last view (0 = the tools changed; -1 = append-only). stripped: blocks newly stripped. */
  function makeRequestView() {
    let last = null;
    const stripped = (typeof WeakSet === 'function') ? new WeakSet() : null;
    const copies = (typeof WeakMap === 'function') ? new WeakMap() : null;
    function withoutReasoning(m) {
      const hit = copies.get(m);
      if (hit && hit.content === m.content && hit.calls === m.tool_calls) return hit.copy;
      const copy = {};
      for (const k of Object.keys(m)) if (k !== 'reasoning') copy[k] = m[k];
      for (const sym of Object.getOwnPropertySymbols(m)) {   // host identity markers ride along, as the elided copies' do
        const d = Object.getOwnPropertyDescriptor(m, sym);
        if (d && !Object.prototype.hasOwnProperty.call(copy, sym)) Object.defineProperty(copy, sym, d);
      }
      copies.set(m, { content: m.content, calls: m.tool_calls, copy });
      return copy;
    }
    function messages(list, o) {
      const src = Array.isArray(list) ? list : [];
      if (!o || o.binds !== true || !stripped || !copies) { last = null; return { messages: src, editAt: -1, stripped: 0 }; }
      const keys = src.map(wireKey);
      const tools = hashOf(JSON.stringify(o.tools || null));
      let editAt = -1;
      if (last) {
        if (last.tools !== tools) editAt = 0;
        else {
          const n = Math.min(last.keys.length, keys.length);
          for (let i = 0; i < n; i++) if (last.keys[i] !== keys[i]) { editAt = i; break; }
        }
      }
      let newly = 0;
      if (editAt >= 0) {
        for (let i = editAt; i < src.length; i++) {
          const m = src[i];
          if (m && m.role === 'assistant' && Array.isArray(m.reasoning) && m.reasoning.length && !stripped.has(m.reasoning)) { stripped.add(m.reasoning); newly++; }
        }
      }
      last = { keys, tools };
      let out = null;
      for (let i = 0; i < src.length; i++) {
        const m = src[i];
        if (m && Array.isArray(m.reasoning) && stripped.has(m.reasoning)) { if (!out) out = src.slice(); out[i] = withoutReasoning(m); }
      }
      return { messages: out || src, editAt, stripped: newly };
    }
    return { messages };
  }

  return { makeRequestView, elideToolResult, foldRequest, headTail, isElided, ELIDED, ELIDE_HEAD, HEAD_SHARE,
    _internals: { wireKey, hashOf, stubText, utf8Bytes } };
});
