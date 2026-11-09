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
      change to `tools` counts as an edit at 0) and, on a provider that binds, deletes the blocks at or after the first
      changed message from their turns: exactly the set the API would drop on that request. The deletion is in place,
      as a failover's model swap deletes foreign blocks (loop.js): a stale block can never bind again, and the run
      journal snapshots the turn without it, so a recovered run does not put back a block the edit had invalidated
      (the API would drop it and every block after it for the rest of that run). Blocks before the edit and every
      block produced after it replay intact: zero drops after an edit. One deliberate over-strip: when the first
      changed message is itself an assistant turn rewritten in place (only collapseContinuation does that), its own
      blocks go too, because whether they still bind depends on where they sat inside the turn.
      A BLOCK THE VIEW CANNOT PROVE GOES. "Valid" is only ever proven against a request this view handed out, so a
      run's first binding request proves no block it replays. A run that starts with blocks is in practice a recovered
      one (index.js o.recovery: a journal checkpoint, verbatim; the transcript store and the page keep no thinking),
      and its blocks were minted under a prefix it does not rebuild: the tools a tool.search reveal grew (reveals are
      not re-applied), the system prompt in another shape (a recovery sends it as one block, with no cache prefix), and
      any edit between the checkpoint and the request (the recovered run's own preflight compaction). So every
      replayed block goes on that request — removing them all is always valid, the API's own strip-every-block
      recovery — and every block from then on is the view's own and replays intact.
      THE BACKSTOP (view.unbound): an edit the view never saw (made below it, on the wire) still reaches the API, which
      reports it as prefix_binding_mismatch drops. Those blocks go too, in place, from the turn of the first dropped
      one through the newest, with the response's own (whether a block made on a request that dropped its predecessors
      chains to them is not documented): a cause the view misses costs one request's reasoning, not the rest of the run.
   2. AN ELIDED BODY KEEPS A HANDLE (elideToolResult: the ONE stub/handle builder; W1.8 cross-run replay reuses it).
      The micro tier's stub kept 240 chars and said "re-run the tool": a write-free re-run is not always possible, and a
      re-run of a command is not the same bytes. The stub now names a saved file that gives the elided bytes back: the
      file the host already parked the full output to before cutting it (registry / turn budget), or a park of the
      exact body made at elision through the host parker (capCtx.parkOutput, which verifies its write byte for byte).
      Never the source again: the same fs.read returns what the file says NOW (the usual coding flow edits a file after
      reading it), and fs.read's page is sized to the window live (ctx.outputMax), so the same call can return fewer
      characters after a fallback. A park is written once and never rewritten: the named fs.read call, and past one
      page the next: calls fs.read's own trailer names, give the elided body back byte for byte. Quoted words (recall
      of another session) are never parked, nor is a body a UTF-8 file cannot hold as it is (a lone surrogate): those
      keep the old wording. A body the 240-char head keeps whole is not elided at all: its stub could only add bytes.
   3. A FOLD'S OWN REQUEST WRITES NO CACHE (foldRequest). A summarizer chunk is a one-shot, toolless request whose
      prefix is never sent again, yet every chunk was anchored and paid the cache-write premium (1.25x on the Anthropic
      API, 2.0x on the claude-cli child's 1h cache) for a read that never comes. Same switch as the ledger's aux
      meter (issue #105): `neverReread`, which every adapter already honours.
   4. A CUT OUTPUT KEEPS ITS HEAD AND ITS TAIL (headTail). shell.exec, verify and MCP results over their 64k cap kept
      only the head: a build or test log ends where the error is, and that end was the part thrown away. The same 64k
      now holds the first 70% and the last 30%, with the gap marked in place. This is THE 70/30 cut: the registry's
      clampOutput and the loop's turn squeeze cut through it too, so none of those cuts splits a surrogate pair.
   5. OLD RESULTS AND SUCCESSFUL WRITE ARGUMENTS AGE IN BATCHES, IN THE REQUEST VIEW ONLY (makeAgeing, W2.1). Off unless
      the host turns it on (STARNET_BATCHED_AGEING). One more edit kind through 1. and 2.: see BATCHED AGEING below.

   Pure apart from the injected parker and the request view's in-place strip (1.); no clock; UMD so loop.js can load it
   wherever it loads. */
'use strict';
(function (root, factory) {
  const crypto = (typeof require === 'function') ? (function () { try { return require('crypto'); } catch (_) { return null; } })() : null;
  const api = factory(crypto);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).historyEdit = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nodeCrypto) {
  'use strict';

  // ---------------------------------------------------------------- 4. head + tail
  const HEAD_SHARE = 0.7;   // the registry's clampOutput and the loop's turn squeeze cut through headTail as well
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
  function isElided(m) { return !!m && m.role === 'tool' && typeof m.content === 'string' && m.content.indexOf(ELIDED) === 0; }
  // a lone surrogate has no UTF-8 form: a file would hand back U+FFFD in its place, so such a body is never parked
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const wellFormed = s => (typeof s.isWellFormed === 'function' ? s.isWellFormed() : !LONE.test(s));
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
  const pathCall = p => 'fs.read ' + JSON.stringify({ path: p });
  function stubText(text, name, handle) {
    const head = text.length > ELIDE_HEAD ? text.slice(0, ELIDE_HEAD).replace(/\s+$/, '') + '…' : text;
    const how = !handle ? 're-run the tool for the full output'
      : handle.via === 'saved' ? 'the whole result is saved: read it with ' + handle.call
      : 'the output saved before it was cut: read it with ' + handle.call;
    return ELIDED + name + ', ' + utf8Bytes(text) + ' bytes; first ' + Math.min(ELIDE_HEAD, text.length) + ' chars kept below; ' + how + ']\n' + head;
  }
  /* elideToolResult(body, o) -> Promise<{ content, handle } | null>   THE ONE STUB/HANDLE BUILDER (W1.8 reuses it).
     body: the tool message's content (a non-string is elided as its JSON, as before).
     o.name        the tool as the call named it (named in the stub and handed to the parker)
     o.parkedPath  where the host already parked this result's output before cutting it (registry, turn budget)
     o.park        async (text, meta) -> { path } | null: the host parker (capCtx.parkOutput). Omitted = no new park:
                   such a body keeps the old "re-run the tool" wording
     o.parkMeta    provenance for that park ({ quotedStreams, taintedBy }); quoted words are never parked
   null = nothing to elide (the head keeps the body whole). handle: { via: 'parked'|'saved', path, call } — `call` is a
   ready-to-run fs.read of a file the host writes once and never rewrites; the source a result came from is never the
   handle (it can change, and fs.read's page follows the live window). 'saved': the file holds the exact elided body,
   read back byte for byte (past one fs.read page, by the next: calls fs.read's own trailer names). 'parked': the file
   holds the output as the host saved it before cutting it, so it returns the elided bytes' source and the part the cut
   dropped. */
  async function elideToolResult(body, o) {
    o = o || {};
    const text = typeof body === 'string' ? body : JSON.stringify(body == null ? '' : body);
    if (text.length <= ELIDE_HEAD) return null;
    const name = String(o.name || 'tool');
    let handle = null;
    if (o.parkedPath) handle = { via: 'parked', path: String(o.parkedPath), call: pathCall(String(o.parkedPath)) };
    const meta = o.parkMeta || {};
    const quoted = Array.isArray(meta.quotedStreams) && meta.quotedStreams.length > 0;
    if (!handle && !quoted && typeof o.park === 'function' && wellFormed(text)) {
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
  // Deletes the thinking of every assistant turn at or after `from`, in place (text and calls stay); returns how many.
  // ownerOf(m): the message an aged copy stands in for (5.), whose thinking goes too, so the strip stays durable.
  function stripFrom(list, from, ownerOf) {
    let n = 0;
    for (let i = Math.max(0, from); i < list.length; i++) {
      const m = list[i];
      if (m && m.role === 'assistant' && Array.isArray(m.reasoning) && m.reasoning.length) {
        delete m.reasoning; n++;
        const owner = ownerOf ? ownerOf(m) : null;
        if (owner && owner !== m) delete owner.reasoning;
      }
    }
    return n;
  }
  /* makeRequestView() -> { messages(list, { tools, binds }) -> { messages, editAt, stripped, unproven } }   one per run.
     list: what the loop would send (screen captures already aged out); its assistant turns are the loop's own message
     objects. binds: the provider binds thinking to its prefix for this model (provider.bindsThinking). On a binding
     request the blocks an edit invalidated are DELETED from their turns, in place (see 1. above), and the list itself
     is returned. editAt: the first message whose prefix changed since the last view (0 = the tools changed, or there is
     no last view; -1 = append-only). unproven: there was no last view (the run's first binding request, or the first
     after a stretch that did not bind), so no replayed block was proven and every one went. stripped: the turns whose
     blocks this call deleted.
     unbound(list, first) -> the turns whose blocks it deleted: the backstop (1. above). `first` is the first block the
     API dropped for prefix_binding_mismatch (its signature; a redacted block's data); the blocks go from the turn that
     holds it through the newest, or all of them when no turn does. Thinking is not part of a wire key, so the view's
     baseline is untouched: the next request is append-only and replays what is left.
     opts.ownerOf(copy) -> the message an aged copy in `list` stands in for (makeAgeing originalOf): a strip deletes
     that original's blocks too. */
  function makeRequestView(opts) {
    const ownerOf = opts && typeof opts.ownerOf === 'function' ? opts.ownerOf : null;
    let last = null;
    function messages(list, o) {
      const src = Array.isArray(list) ? list : [];
      if (!o || o.binds !== true) { last = null; return { messages: src, editAt: -1, stripped: 0, unproven: false }; }
      const keys = src.map(wireKey);
      const tools = hashOf(JSON.stringify(o.tools || null));
      const unproven = !last;
      let editAt = -1;
      if (unproven || last.tools !== tools) editAt = 0;
      else {
        const n = Math.min(last.keys.length, keys.length);
        for (let i = 0; i < n; i++) if (last.keys[i] !== keys[i]) { editAt = i; break; }
      }
      const stripped = editAt >= 0 ? stripFrom(src, editAt, ownerOf) : 0;
      last = { keys, tools };
      return { messages: src, editAt, stripped, unproven };
    }
    function unbound(list, first) {
      const src = Array.isArray(list) ? list : [];
      const holds = m => m && m.role === 'assistant' && Array.isArray(m.reasoning)
        && m.reasoning.some(b => b && (b.signature === first || b.data === first));
      const at = first ? src.findIndex(holds) : -1;
      return stripFrom(src, Math.max(0, at));
    }
    return { messages, unbound };
  }

  // ---------------------------------------------------------------- 5. batched ageing
  /* BATCHED AGEING (W2.1, cost audit 2026-11-08). A long run sends every old tool result and every file it wrote on
     every request; at cache-read prices that is most of its input bill. Ageing one result per turn changed the prefix on
     every request and re-wrote the cache from there each time (measured: +28% to +175%), so old bodies age in BATCHES,
     only when a batch pays for itself, and only in what is SENT:
       · the newest AGE_KEEP_TURNS tool turns always ride whole (measured: 4 beat 6 and 8);
       · a batch waits until the tool turns behind them hold AGE_BATCH_CHARS characters a stub would free, across at least
         AGE_MIN_TURNS tool turns, so two requests in a row never both change the prefix;
       · a run projected at AGE_SHORT_RUN requests or fewer is never aged (the measured break-even): the projection is
         the requests made so far plus as many again (a run tends to last about as long again as it has run), never past
         the run's turn ceiling;
       · THE PAYBACK: a batch ages only when  R x F x r  >  T x (w - r).  R: the projected remaining requests; F: what the
         batch takes out of every later request; T: the request from the first aged message to its end, the part the
         next request writes instead of reading (all of it on a provider that holds the run's history); r and w: the
         route's cache read and write price in fresh-input units (the cost engine's cacheRates, W1.13). F and T by the
         loop's own ruler. An unpriced route (a sign-in, a local model) has nothing to weigh and never ages; a priced one
         that publishes no cache rates is weighed at AGE_ASSUMED_RATES.
     WHAT AGES: a tool result, through elideToolResult (2.: the micro tier's stub, wording and handle); and the long
     string arguments of a write that SUCCEEDED (WRITE_ARGS), as an ARG_ELIDED stub naming a saved copy of the exact
     argument. Only a body a handle covers ages, and only when its stub at least halves it: words quoted from another
     session, a body this run did not produce (a resumed history), a body no UTF-8 file can hold and a park that failed
     ride whole, and are never tried again.
     IN THE VIEW ONLY: `messages` is never touched. view(list) swaps each aged message for its copy (the list itself
     while nothing has aged, so a run that never ages sends byte-identical requests); the transcript, the run journal and
     every fold keep the full bodies. A copy is made once and reused, so the prefix stays cached between batches; it
     mirrors its original's thinking as it is now (a failover or the backstop strips the original), and the request
     view (1.) strips the thinking a batch unbinds from the copy AND its original (originalOf). */
  const AGE_KEEP_TURNS = 4;
  const AGE_BATCH_CHARS = 60000;
  const AGE_MIN_TURNS = 2;
  const AGE_SHORT_RUN = 24;
  const AGE_ASSUMED_RATES = Object.freeze({ read: 0.10, write: 1.25 });   // Anthropic's 5-minute tier: the cached routes' usual write premium
  // the writes whose long string arguments age once the call succeeded (wire names), and which arguments
  const WRITE_ARGS = Object.freeze({ fs_write: ['content'], fs_append: ['content'], fs_edit: ['find', 'replace'], fs_patch: ['patch'] });
  const ARG_ELIDED = '[argument elided at compaction — ';
  // a handle as long as the host's usual one (index.js parkOutput: .output/<tool>-<run id>-<seq>.txt): a stub is priced
  // before its park, which only the batch itself makes
  const STAND_IN = { via: 'saved', call: pathCall('.output/' + 'x'.repeat(48) + '.txt') };
  const wireName = n => String(n == null ? '' : n).replace(/\./g, '_').toLowerCase();
  function argStubText(text, call) { return ARG_ELIDED + utf8Bytes(text) + ' bytes; the whole argument is saved: read it with ' + call + ']'; }
  // one message's characters on the wire (content and call arguments): the ruler when the loop has none
  function charsOf(m) {
    if (!m || typeof m !== 'object') return 0;
    let n = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content == null ? '' : m.content).length;
    if (Array.isArray(m.tool_calls)) for (const c of m.tool_calls) n += String((c && c.function && c.function.arguments) || '').length;
    return n;
  }
  /* A copy STANDS IN for its original, so it inherits the original's host-attached identity markers: non-enumerable own
     symbol keys (a turn kind, transcriptstore.js's persisted marker), which Object.assign does not copy. */
  function inheritMarkers(from, to) {
    if (!from || !to || from === to || typeof from !== 'object' || typeof to !== 'object') return to;
    for (const sym of Object.getOwnPropertySymbols(from)) {
      const d = Object.getOwnPropertyDescriptor(from, sym);
      if (d && !d.enumerable && !Object.prototype.hasOwnProperty.call(to, sym)) Object.defineProperty(to, sym, d);
    }
    return to;
  }
  /* makeAgeing({ originOf }) -> { plan, view, agedOf, originalOf }   one per run.
     originOf(toolMessage) -> { parkedPath, parkMeta, ok } | null: what the loop knows of a result it produced (null: a
       body this run did not produce, which never ages).
     plan(list, ctx) -> Promise<batch | null>   before a request: ages a batch when one is due and pays (see above).
       list: what the request would carry before ageing (screen captures already aged out: the loop's own messages);
       ctx: { requests (made so far), maxIters, rates() -> { read, write, published } | null (the cost engine's
       cacheRates), measure(message) -> its size by the loop's ruler, holdsHistory, park (the host parker) }.
       batch: { editAt (the first aged message), results, args, freedChars, requests, remaining, read, write, assumed,
       freed, suffix, saving, rewrite } — the payback's numbers, for the diagnostics line.
     view(list) -> list with each aged message swapped for its copy; the list itself while nothing has aged.
     agedOf(original) -> its aged copy, or null (the micro tier folds an aged result into the same stub, no second park).
     originalOf(copy) -> the original an aged copy stands in for, or null (the request view's ownerOf). */
  function makeAgeing(o) {
    o = o || {};
    const originOf = typeof o.originOf === 'function' ? o.originOf : () => null;
    const aged = (typeof WeakMap === 'function') ? new WeakMap() : null;     // original -> its aged copy
    const owners = (typeof WeakMap === 'function') ? new WeakMap() : null;   // aged copy -> its original
    const never = (typeof WeakSet === 'function') ? new WeakSet() : null;    // originals that can never age
    let any = false;
    if (!aged || !owners || !never) return { plan: async () => null, view: list => list, agedOf: () => null, originalOf: () => null };
    const quoted = meta => !!meta && Array.isArray(meta.quotedStreams) && meta.quotedStreams.length > 0;
    // what one message would become, priced with a stand-in handle (nothing is parked), or null: it can never age
    function candidate(m, names, results, park) {
      if (typeof park !== 'function') return null;
      if (m.role === 'tool') {
        if (isElided(m)) return null;   // the micro tier's stub already
        const origin = originOf(m);
        if (!origin) return null;
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content);
        if (text.length <= ELIDE_HEAD) return null;
        const parkedPath = origin.parkedPath ? String(origin.parkedPath) : null;
        if (!parkedPath && (quoted(origin.parkMeta) || !wellFormed(text))) return null;
        const est = stubText(text, String(names.get(m.tool_call_id) || 'tool'), parkedPath ? { via: 'parked', call: pathCall(parkedPath) } : STAND_IN);
        if (est.length * 2 > text.length) return null;
        return { kind: 'result', msg: m, name: String(names.get(m.tool_call_id) || 'tool'), text, origin, est: Object.assign({}, m, { content: est }) };
      }
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) return null;
      const calls = [];
      const estCalls = m.tool_calls.slice();
      m.tool_calls.forEach((c, k) => {
        const fields = (c && c.function) ? WRITE_ARGS[wireName(c.function.name)] : null;
        if (!fields) return;
        const res = results.get(c.id);
        const ro = res ? originOf(res) : null;
        if (!ro || ro.ok !== true) return;   // a write that failed changed nothing: its arguments are the record of what was tried
        let args = null;
        try { args = JSON.parse(String(c.function.arguments || '')); } catch (_) { return; }
        if (!args || typeof args !== 'object' || Array.isArray(args)) return;
        const take = [];
        const estArgs = Object.assign({}, args);
        for (const f of fields) {
          const v = args[f];
          if (typeof v !== 'string' || !wellFormed(v)) continue;
          const s = argStubText(v, STAND_IN.call);
          if (s.length * 2 > v.length) continue;
          take.push(f); estArgs[f] = s;
        }
        if (!take.length) return;
        calls.push({ k, call: c, args, fields: take, meta: (ro.parkMeta && ro.parkMeta.taintedBy) ? { taintedBy: ro.parkMeta.taintedBy } : {} });
        estCalls[k] = Object.assign({}, c, { function: Object.assign({}, c.function, { arguments: JSON.stringify(estArgs) }) });
      });
      return calls.length ? { kind: 'args', msg: m, calls, est: Object.assign({}, m, { tool_calls: estCalls }) } : null;
    }
    // the messages a batch would age now: every one behind the newest AGE_KEEP_TURNS tool turns not aged yet
    function pending(list, park) {
      const turns = [];
      for (let i = 0; i < list.length; i++) { const m = list[i]; if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) turns.push(i); }
      if (turns.length <= AGE_KEEP_TURNS) return null;
      const end = turns[turns.length - AGE_KEEP_TURNS];
      const names = new Map(), results = new Map();
      for (const m of list) {
        if (!m || typeof m !== 'object') continue;
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) if (c && c.id != null) names.set(c.id, (c.function && c.function.name) || 'tool');
        if (m.role === 'tool' && m.tool_call_id != null) results.set(m.tool_call_id, m);
      }
      const items = [];
      const spanned = new Set();
      let turn = -1, freedChars = 0;
      for (let i = turns[0]; i < end; i++) {
        if (i === turns[turn + 1]) turn++;
        const m = list[i];
        if (!m || typeof m !== 'object' || aged.has(m) || never.has(m)) continue;
        const it = candidate(m, names, results, park);
        if (!it) { never.add(m); continue; }
        it.at = i;
        items.push(it); spanned.add(turn); freedChars += charsOf(m) - charsOf(it.est);
      }
      return { items, turns: spanned.size, freedChars };
    }
    async function plan(list, ctx) {
      ctx = ctx || {};
      if (!Array.isArray(list)) return null;
      const park = typeof ctx.park === 'function' ? ctx.park : null;
      const p = pending(list, park);
      if (!p || !p.items.length || p.freedChars < AGE_BATCH_CHARS || p.turns < AGE_MIN_TURNS) return null;
      // THE PROJECTION: as many requests again as the run has made, never past its turn ceiling
      const n = Math.max(0, Math.floor(Number(ctx.requests) || 0));
      const cap = Number(ctx.maxIters);
      const remaining = Math.min(n, (cap > 0 && isFinite(cap)) ? Math.max(0, Math.floor(cap) - n) : Infinity);
      if (n + remaining <= AGE_SHORT_RUN) return null;
      // THE ROUTE'S RATES
      let rates = null;
      try { rates = typeof ctx.rates === 'function' ? ctx.rates() : null; } catch (_) { rates = null; }
      if (!rates || typeof rates !== 'object') return null;
      const assumed = rates.published === false;
      const r = assumed ? AGE_ASSUMED_RATES.read : Number(rates.read);
      const w = assumed ? AGE_ASSUMED_RATES.write : Number(rates.write);
      if (!(r >= 0) || !(w >= 0)) return null;
      // THE PAYBACK, by the loop's ruler (characters when it has none)
      const size = m => {
        let v = 0;
        try { v = Number(typeof ctx.measure === 'function' ? ctx.measure(m) : charsOf(m)); } catch (_) { v = charsOf(m); }
        return v > 0 ? v : 0;
      };
      const est = new Map(p.items.map(it => [it.msg, it.est]));
      let freed = 0, suffix = 0;
      for (const it of p.items) freed += size(it.msg) - size(it.est);
      for (let i = ctx.holdsHistory ? 0 : p.items[0].at; i < list.length; i++) { const m = list[i]; suffix += size(est.get(m) || aged.get(m) || m); }
      const saving = remaining * freed * r, rewrite = suffix * (w - r);
      if (!(freed > 0) || !(saving > rewrite)) return null;
      // THE BATCH: each body parked (or its registry park named), then its copy swapped in from the next request on
      let editAt = -1, results = 0, args = 0, freedChars = 0;
      for (const it of p.items) {
        let copy = null;
        if (it.kind === 'result') {
          const st = await elideToolResult(it.msg.content, { name: it.name, parkedPath: it.origin.parkedPath, parkMeta: it.origin.parkMeta, park });
          if (st && st.handle) { copy = Object.assign({}, it.msg, { content: st.content }); results++; }
        } else {
          const calls = it.msg.tool_calls.slice();
          let took = 0;
          for (const c of it.calls) {
            const next = Object.assign({}, c.args);
            let saved = 0;
            for (const f of c.fields) {
              let at = null;
              try { at = await park(c.args[f], Object.assign({}, c.meta, { tool: String((c.call.function && c.call.function.name) || 'tool'), reason: 'argument-elided-at-compaction' })); } catch (_) { at = null; }
              if (!at || !at.path) continue;
              next[f] = argStubText(c.args[f], pathCall(String(at.path)));
              saved++;
            }
            if (!saved) continue;
            calls[c.k] = Object.assign({}, c.call, { function: Object.assign({}, c.call.function, { arguments: JSON.stringify(next) }) });
            took += saved;
          }
          if (took) { copy = Object.assign({}, it.msg, { tool_calls: calls }); args += took; }
        }
        if (!copy) { never.add(it.msg); continue; }
        inheritMarkers(it.msg, copy);
        aged.set(it.msg, copy); owners.set(copy, it.msg);
        freedChars += charsOf(it.msg) - charsOf(copy);
        if (editAt < 0) editAt = it.at;
      }
      if (editAt < 0) return null;
      any = true;
      return { editAt, results, args, freedChars, requests: n, remaining, read: r, write: w, assumed, freed, suffix, saving, rewrite };
    }
    function view(list) {
      if (!any || !Array.isArray(list)) return list;
      let out = null;
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        const c = (m && typeof m === 'object') ? aged.get(m) : null;
        if (!c) continue;
        if (m.role === 'assistant') {   // the copy carries its original's thinking as it is now
          if (Object.prototype.hasOwnProperty.call(m, 'reasoning')) { if (c.reasoning !== m.reasoning) c.reasoning = m.reasoning; }
          else if (Object.prototype.hasOwnProperty.call(c, 'reasoning')) delete c.reasoning;
        }
        if (!out) out = list.slice();
        out[i] = c;
      }
      return out || list;
    }
    return {
      plan, view,
      agedOf: m => (m && typeof m === 'object' && aged.get(m)) || null,
      originalOf: c => (c && typeof c === 'object' && owners.get(c)) || null
    };
  }

  return { makeRequestView, elideToolResult, foldRequest, headTail, isElided, makeAgeing, inheritMarkers, ELIDED, ELIDE_HEAD, HEAD_SHARE, ARG_ELIDED,
    AGEING: { KEEP_TURNS: AGE_KEEP_TURNS, BATCH_CHARS: AGE_BATCH_CHARS, MIN_TURNS: AGE_MIN_TURNS, SHORT_RUN: AGE_SHORT_RUN, ASSUMED_RATES: AGE_ASSUMED_RATES, WRITE_ARGS },
    _internals: { wireKey, hashOf, stubText, utf8Bytes, stripFrom, argStubText, charsOf } };
});
