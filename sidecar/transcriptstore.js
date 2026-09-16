/* sidecar/transcriptstore.js — durable per-workstream conversation transcript (P0.1).

   The spend ledger records the COST of a run; runstore.js records the OUTCOME (one line per finished
   run). NEITHER keeps WHAT was said: `runstore.js`'s own header notes "the full message log is discarded
   once the SSE stream closes." So a sidecar restart wipes the agent's memory of the actual dialogue — the
   single most jarring day-to-day regression vs a production-class agent (which resumes its transcript). This
   module closes that: an append-only, per-stream conversation log on the sidecar's own disk (the app-data
   WORKSPACES dir that survives a browser wipe), so a restart can reload the recent dialogue per workstream.

   Same discipline as its siblings (runstore/ledger): PURE given an injected `io` (readAll/append — the host
   owns the fsync'd disk append) and `clock`. No ambient time/IO, so it passes lint-determinism and tests
   headlessly with an in-memory io. A missing/corrupt store -> empty history (fail-open; a run is NEVER
   crashed by an unreadable transcript). Content is run through the injected `redact` on write so a
   secret-shaped token can't be laundered into a durable file (consistent with the SSE/NDJSON redaction).

   It lives under <root>/transcript-history-v2/ — a SIBLING of the fs jail (<root>/<agentId>/), so the
   agent's own fs.* tools can neither read nor corrupt the record of its own conversations. Legacy
   transcript.jsonl(.1) inputs remain in place after import. It holds no key (those are stored separately).

     makeTranscriptStore({ io, clock, redact?, limit? }) -> {
       append({ streamId, agentId, role, content }) -> entry,   // stamps ts, redacts content, appends, returns it
       history(streamId, { limit }?) -> entry[],   // CHRONOLOGICAL (oldest-first) for replay; last `limit` of that stream
       all() -> entry[],   count() -> int
     } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).transcriptstore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('./failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };

  const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;   // same workstream grammar index.js validates streamId against
  // Sets, not object literals: `({a:1})['constructor']` is truthy, so an object-literal allowlist
  // silently admits every Object.prototype key — and these keys come off persisted/model-supplied data.
  const ROLES = new Set(['user', 'assistant', 'tool', 'system']);
  const DEFAULT_LIMIT = 400;        // a sane cap so history() never returns an unbounded transcript
  const CONTENT_MAX = 200000;       // per-turn guard against a pathological payload bloating the file
  const RAM_ROWS_MAX = 3000;        // global ceiling across many short streams; disk keeps lifetime truth
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function str(v) { return v == null ? '' : String(v); }

  // an OpenAI-format message's content is either a plain string or a multimodal parts array
  function flattenContent(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(p => (p && typeof p.text === 'string') ? p.text : '').join(' ');
    return '';
  }

  /* H1.1 BOUNDARY MARKER — why this is not just an integer.

     appendTurns() takes a POSITIONAL `fromIndex`, which is only sound while the loop's messages array grows
     MONOTONICALLY. It does not: on compaction loop.js REBUILDS that array in place and SHORTER (older turns
     fold into a single summary note). A boundary captured before the loop then points PAST the new end, the
     append loop runs zero times, and the run's ENTIRE dialogue is dropped with no error and no log line.
     It fails worst exactly where the transcript matters most — long, resumed sessions, which are both the
     likeliest to compact and the ones whose history recall_conversation is meant to search.

     A per-message marker survives the fold, because compaction reuses the same message OBJECTS in the prefix
     and kept tail rather than cloning them. Symbol-keyed and non-enumerable, so it is invisible to
     JSON.stringify — it never reaches disk, and never rides out to a provider on the wire. */
  const PERSISTED = Symbol('skynet.transcript.persisted');

  // Mark messages as already-recorded. The host calls this on the prompt BEFORE the loop runs, so whatever the
  // loop appends afterwards is exactly that run's new dialogue. Returns how many were newly marked.
  function markPersisted(messages) {
    if (!Array.isArray(messages)) return 0;
    let n = 0;
    for (const m of messages) {
      if (!m || typeof m !== 'object' || m[PERSISTED]) continue;
      try { Object.defineProperty(m, PERSISTED, { value: true, enumerable: false, configurable: true, writable: true }); n++; }
      catch (_) { /* frozen/sealed message: it just stays eligible — a duplicate row beats a lost transcript */ }
    }
    return n;
  }

  function makeTranscriptStore(opts) {
    opts = opts || {};
    const io = opts.io || { readAll() { return []; }, append() {} };
    const clock = opts.clock || { now() { return 0; } };
    const redact = typeof opts.redact === 'function' ? opts.redact : (s) => s;
    const cap = num(opts.limit) || DEFAULT_LIMIT;
    // PER-STREAM RAM ceiling: history()/reconstruct() read at most `cap` (≤400) turns of ONE stream. Keep ~3x
    // headroom per stream so one chatty workstream can't evict another stream's turns below its own query
    // horizon (the fairness the plan calls for). Bound is PER streamId, not global, so N idle streams keep their
    // recent history while a firehose stream self-trims. Disk keeps the full append-only segmented history;
    // the host adapter loads only recent rows here and answers lifetime recall lazily from per-segment indexes.
    const ramPerStream = num(opts.ramPerStream) > 0 ? num(opts.ramPerStream) : Math.max(cap * 3, 1200);
    const ramMax = num(opts.ramMax) > 0 ? num(opts.ramMax) : RAM_ROWS_MAX;

    // in-memory mirror loaded once; append keeps RAM + disk in lockstep so history() is O(n) over RAM.
    let rows = [];
    try {
      const raw = typeof io.readRecent === 'function' ? io.readRecent({ perStream: ramPerStream, globalLimit: ramMax }) : io.readAll();
      if (Array.isArray(raw)) rows = raw.filter(r => r && typeof r === 'object');
    }
    catch (e) { rows = []; }
    // trim the boot load per-stream too, so a huge bounded-boot load of one stream can't start us over the cap.
    trimStreamRam();   // no arg => sweep every over-cap stream once
    trimGlobalRam();

    function trimGlobalRam() {
      if (rows.length > ramMax) rows.splice(0, rows.length - ramMax);
    }

    // drop the OLDEST rows of `streamId` when that stream exceeds ramPerStream. Splices only that stream's rows,
    // so other streams are untouched (per-stream fairness). Called after each append for the appended stream; the
    // boot-time call (streamId undefined) sweeps every over-cap stream once.
    function trimStreamRam(streamId) {
      const streams = streamId == null ? Array.from(new Set(rows.map(r => r.streamId))) : [streamId];
      for (const sid of streams) {
        const idxs = [];
        for (let i = 0; i < rows.length; i++) if (rows[i].streamId === sid) idxs.push(i);
        const over = idxs.length - ramPerStream;
        if (over <= 0) continue;
        const drop = new Set(idxs.slice(0, over));   // the oldest `over` rows of this stream
        rows = rows.filter((_, i) => !drop.has(i));
      }
    }

    // a bad/missing streamId collapses to 'global' — exactly index.js's rule (bad streamId -> the global stream).
    function normStream(v) { const s = str(v); return SID_RE.test(s) ? s : 'global'; }
    function tokenize(s) {
      const normalized = str(s).normalize('NFKC').toLowerCase();
      const cjk = /^(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul})$/u;
      const out = [];
      for (const word of (normalized.match(/[\p{L}\p{N}]+/gu) || [])) {
        let run = '';
        for (const char of word) {
          if (!cjk.test(char)) { run += char; continue; }
          if (run) { out.push(run); run = ''; }
          out.push(char);
        }
        if (run) out.push(run);
      }
      return out;
    }

    // H1.3: keyword recall over the transcript — the substrate for the agent-callable recall_conversation tool,
    // so it can find weeks-old dialogue no longer in context. Lightweight BM25-ish: rank a row by how many
    // DISTINCT query terms it contains (primary), then total term frequency, then recency. Dependency-free + pure.
    //
    // SCOPE (parity with the reference harness, whose session search spans every session, not just the open one):
    // o.scope === 'all' searches EVERY workstream; anything else keeps the historical single-stream behaviour, so
    // the existing call shape search(streamId, q, {limit}) is byte-for-byte unchanged. Every hit now carries its
    // OWN streamId — without it a cross-stream result is unattributable, and the agent would quote another
    // workstream's decision as if it belonged to this one.
    function search(streamId, query, o) {
      o = o || {};
      const limit = num(o.limit) > 0 ? Math.min(num(o.limit), 50) : 10;
      const terms = Array.from(new Set(tokenize(query)));
      if (!terms.length) return [];
      const all = o.scope === 'all';
      const want = normStream(streamId);
      if (typeof io.search === 'function') {
        try { return io.search(want, query, { limit: limit, scope: all ? 'all' : 'stream' }) || []; } catch (e) { failNote('transcript.io', e); }
      }
      const scored = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!all && r.streamId !== want) continue;
        const tf = {}; for (const t of tokenize(r.content)) tf[t] = (tf[t] || 0) + 1;
        let distinct = 0, freq = 0;
        for (const t of terms) { if (tf[t]) { distinct++; freq += tf[t]; } }
        if (distinct) scored.push({ idx: i, streamId: r.streamId, role: r.role, content: r.content, ts: r.ts, score: distinct * 1000 + freq });
      }
      scored.sort((a, b) => (b.score - a.score) || (b.ts - a.ts) || (b.idx - a.idx));
      return scored.slice(0, limit).map(x => ({ streamId: x.streamId, role: x.role, content: x.content, ts: x.ts, score: x.score }));
    }

    // BROWSE (reference-harness parity: "list recent sessions"): every workstream present in the transcript, with its
    // turn count, last-activity stamp, and the most recent USER line as a preview — so an agent that does not know
    // WHICH workstream holds an answer can look before it searches. Newest-active first; deterministic tiebreak by
    // id so two streams stamped in the same millisecond never reorder between calls.
    function streams(o) {
      o = o || {};
      const limit = num(o.limit) > 0 ? Math.min(num(o.limit), 100) : 20;
      const previewMax = num(o.previewChars) > 0 ? num(o.previewChars) : 160;
      if (typeof io.streams === 'function') {
        try { return io.streams({ limit: limit, previewChars: previewMax }) || []; } catch (e) { failNote('transcript.io', e); }
      }
      const by = new Map();
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        let e = by.get(r.streamId);
        if (!e) { e = { streamId: r.streamId, turns: 0, lastAt: 0, preview: '' }; by.set(r.streamId, e); }
        e.turns++;
        if (r.ts >= e.lastAt) e.lastAt = r.ts;
        // last USER line wins the preview — the assistant's reply is the answer, the user's line is the topic.
        if (r.role === 'user' && r.content) e.preview = str(r.content).replace(/\s+/g, ' ').trim().slice(0, previewMax);
      }
      const out = Array.from(by.values());
      out.sort((a, b) => (b.lastAt - a.lastAt) || (a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : 0));
      return out.slice(0, limit);
    }

    // SCROLL (reference-harness parity: anchored drill-down): the window of turns around a point in ONE stream, so a
    // search hit can be READ IN CONTEXT instead of as an isolated line. Anchored on a TIMESTAMP rather than a row
    // index or a synthetic id — ts is the only anchor that stays valid after trimStreamRam() splices older rows out
    // from under us, which is exactly when a drill-down is most likely to be attempted.
    function around(streamId, ts, o) {
      o = o || {};
      const win = num(o.window) > 0 ? Math.min(num(o.window), 50) : 6;
      const want = normStream(streamId);
      const at = num(ts);
      if (typeof io.around === 'function') {
        try { return io.around(want, ts, { window: win, rowId: o.rowId }) || []; } catch (e) { failNote('transcript.io', e); }
      }
      const mine = [];
      for (let i = 0; i < rows.length; i++) { if (rows[i].streamId === want) mine.push(rows[i]); }
      if (!mine.length) return [];
      // the row closest to the anchor (mine is append-ordered, so ties resolve to the earliest match — stable).
      let anchor = 0, best = Infinity;
      for (let i = 0; i < mine.length; i++) {
        const d = Math.abs(num(mine[i].ts) - at);
        if (d < best) { best = d; anchor = i; }
      }
      const from = Math.max(0, anchor - win);
      const to = Math.min(mine.length, anchor + win + 1);
      return mine.slice(from, to).map(r => Object.assign({}, r));
    }

    function buildEntry(e) {
      e = e || {};
      let content = str(e.content).slice(0, CONTENT_MAX);
      try { content = str(redact(content)).slice(0, CONTENT_MAX); } catch (e) { failNote('transcript.redact', e); }
      const entry = {
        streamId: normStream(e.streamId),
        agentId: str(e.agentId),
        role: ROLES.has(e.role) ? e.role : 'user',     // clamp to the known enum
        content: content,
        ts: num(e.ts) || clock.now()
      };
      // H1.1: optional structured fields so a RESUME can rebuild the EXACT OpenAI-format turn — an assistant's
      // tool_calls and a tool result's tool_call_id. Redacted like content; absent fields => byte-identical to before.
      if (e.toolCalls != null) {
        let tc = '';
        try { tc = str(redact(typeof e.toolCalls === 'string' ? e.toolCalls : JSON.stringify(e.toolCalls))).slice(0, CONTENT_MAX); } catch (e) { failNote('transcript.redact', e); }
        if (tc) entry.toolCalls = tc;
      }
      if (e.toolCallId != null) { const id = str(e.toolCallId).slice(0, 200); if (id) entry.toolCallId = id; }
      // Recovery provenance is deliberately an opaque run id, never tool arguments. It lets boot reconciliation
      // prove that a journal's final rows already reached durable transcript storage before retiring the journal.
      if (e.sourceRunId != null) { const id = str(e.sourceRunId).slice(0, 200); if (id) entry.sourceRunId = id; }
      return entry;
    }

    function persistEntry(entry, strict) {
      let stored = entry;
      try {
        const writer = strict && typeof io.appendDurable === 'function' ? io.appendDurable : io.append;
        const persisted = writer.call(io, entry);
        if (persisted && typeof persisted === 'object') stored = persisted;
      } catch (e) {
        if (strict) throw e;
        /* ordinary transcript writes remain fail-open; recovery-owned finalization uses appendStrict below */
      }
      rows.push(stored);
      trimStreamRam(stored.streamId);   // bound THIS stream's RAM only (per-stream fairness; disk keeps full log)
      trimGlobalRam();                  // and bound the aggregate across thousands of short streams
      return stored;
    }

    function append(e) { return persistEntry(buildEntry(e), false); }
    function appendStrict(e) { return persistEntry(buildEntry(e), true); }

    // H1.1: append a SLICE of an OpenAI-format messages array (a run's new turns) as full transcript rows —
    // user / assistant (with tool_calls) / tool (with tool_call_id). Skips injected 'system' fences (recall,
    // loop-guard, compaction) so the transcript stays the real dialogue. Returns the count appended. PURE +
    // testable: the host passes result.messages + the pre-loop boundary index.
    function appendTurns(streamId, agentId, messages, fromIndex) {
      if (!Array.isArray(messages)) return 0;
      let n = 0;
      for (let i = Math.max(0, num(fromIndex)); i < messages.length; i++) {
        const m = messages[i];
        if (!m || !ROLES.has(m.role) || m.role === 'system') continue;
        append({ streamId: streamId, agentId: agentId, role: m.role, content: flattenContent(m.content), toolCalls: m.tool_calls, toolCallId: m.tool_call_id });
        n++;
      }
      return n;
    }

    // H1.1, compaction-safe: append every message NOT yet carrying the persisted marker, marking as it goes.
    // This is the boundary appendTurns' positional `fromIndex` could not express — see PERSISTED above. Same row
    // shape and same skip rule (injected 'system' fences are not dialogue), so the durable file is unchanged;
    // only WHICH messages are considered new differs. Idempotent: appending the same array twice writes once,
    // which also makes it safe to drain mid-run (at a compaction) and again at run end.
    function appendNew(streamId, agentId, messages) {
      if (!Array.isArray(messages)) return 0;
      let n = 0;
      for (const m of messages) {
        if (!m || typeof m !== 'object' || m[PERSISTED]) continue;
        markPersisted([m]);                                    // mark BEFORE the role filter so fences aren't re-checked
        if (!ROLES.has(m.role) || m.role === 'system') continue;
        append({ streamId: streamId, agentId: agentId, role: m.role, content: flattenContent(m.content), toolCalls: m.tool_calls, toolCallId: m.tool_call_id });
        n++;
      }
      return n;
    }

    // Recovery-owned drain: every visible row must be fsync'd/read-back proven before its message receives the
    // PERSISTED marker. A failure throws and leaves the remaining messages eligible; the run journal stays the
    // source of truth instead of being marked committed optimistically.
    function appendNewStrict(streamId, agentId, messages, opts) {
      if (!Array.isArray(messages)) return 0;
      opts = opts || {};
      let n = 0;
      for (const m of messages) {
        if (!m || typeof m !== 'object' || m[PERSISTED]) continue;
        if (!ROLES.has(m.role) || m.role === 'system') { markPersisted([m]); continue; }
        appendStrict({ streamId: streamId, agentId: agentId, role: m.role, content: flattenContent(m.content), toolCalls: m.tool_calls, toolCallId: m.tool_call_id, sourceRunId: opts.sourceRunId });
        markPersisted([m]);
        n++;
      }
      return n;
    }

    // the recent dialogue for ONE workstream, oldest-first (ready to replay back into COMMS). We keep the LAST
    // `limit` turns of that stream (the most recent), then return them in chronological order.
    function history(streamId, o) {
      o = o || {};
      const limit = num(o.limit) > 0 ? num(o.limit) : cap;
      const want = normStream(streamId);
      const sourceRunId = String(o.sourceRunId || '');
      // Segmented hosts retain lifetime rows outside the bounded RAM working set. Ask the
      // durable index/segments first so an old, idle conversation still resumes exactly.
      if (typeof io.history === 'function') {
        try {
          const found = io.history(want, { limit, sourceRunId });
          if (Array.isArray(found)) return found.map(r => Object.assign({}, r));
        } catch (e) { failNote('transcript.io', e); }
      }
      const out = [];
      for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
        if (rows[i].streamId === want && (!sourceRunId || rows[i].sourceRunId === sourceRunId)) out.push(Object.assign({}, rows[i]));
      }
      out.reverse();   // newest-first scan -> chronological for replay
      return out;
    }

    // H1.2: rebuild the recent dialogue for a stream as an OpenAI-format messages array, so a fresh run (empty
    // browser history) can RESUME exact prior state. Pairing-safe: a tool message needs its assistant tool_call,
    // so we drop a leading orphaned 'tool' (truncated-slice start) and strip tool_calls off a trailing assistant
    // whose results got cut — keeping the array valid for the provider.
    function reconstruct(streamId, o) {
      const rows = history(streamId, o);   // chronological, capped
      const out = [];
      for (const r of rows) {
        if (r.role === 'user') out.push({ role: 'user', content: r.content });
        else if (r.role === 'assistant') {
          const m = { role: 'assistant', content: r.content || '' };
          if (r.toolCalls) { try { const tc = JSON.parse(r.toolCalls); if (Array.isArray(tc) && tc.length) m.tool_calls = tc; } catch (_) {} }
          out.push(m);
        } else if (r.role === 'tool') {
          out.push({ role: 'tool', content: r.content, tool_call_id: str(r.toolCallId) });
        }
      }
      while (out.length && out[0].role === 'tool') out.shift();                 // orphaned tool at a truncated start
      const last = out[out.length - 1];
      if (last && last.role === 'assistant' && last.tool_calls) delete last.tool_calls;   // results cut off the end
      return out;
    }

    return {
      append, appendStrict, appendTurns, appendNew, appendNewStrict, markPersisted, history, reconstruct, search, streams, around,
      all() { return rows.map(r => Object.assign({}, r)); },
      count() { return rows.length; },
      _internals: { normStream, SID_RE }
    };
  }

  return { makeTranscriptStore, markPersisted, _internals: { SID_RE, ROLES, PERSISTED, flattenContent } };
});
