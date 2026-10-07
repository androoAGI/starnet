/* sidecar/providers/provider.js — the LLMProvider interface (the transport seam).
   Every provider (replay, openrouter, later tauri-sidecar) implements:

     stream(req) -> AsyncIterable<HarnessEvent>
       req = { model, messages, tools, signal, stream:true, ... }
       HarnessEvent =
         | { type:'text',       delta }
         | { type:'tool_start', index, id, name }
         | { type:'tool_args',  index, chunk }   // argument STRING fragment
         | { type:'tool_done',  index }
         | { type:'reasoning',  block }          // OPTIONAL, one per COMPLETED provider-native reasoning block.
         |     `block` is OPAQUE to the loop: it parks the blocks on the assistant turn (`msg.reasoning`) and
         |     hands them back to the same adapter on the next request. This exists because signed thinking
         |     blocks must be replayed VERBATIM beside that turn's tool_calls or the provider rejects the turn.
         |     Reasoning is NEVER a 'text' event — the loop concatenates those into the delivered answer.
         | { type:'usage',      usage }          // prompt_tokens, completion_tokens, total_tokens,
         |                                       //   prompt_tokens_details.cached_tokens, reasoning_tokens, cost
         | { type:'done',       finishReason, truncated? }   // finishReason normalized via normalizeFinish()
         |     Adapters emit EXACTLY ONE 'done' per stream, and it is REQUIRED even when the upstream never
         |     stated a finish reason (finishReason: null) — the loop cannot distinguish a finished answer from
         |     a body that died in transit without it. `truncated: true` means the stream ended with NO terminal
         |     signal of any kind (no end-of-stream sentinel AND no finish reason), i.e. a clean mid-generation
         |     FIN; the loop retries such a turn and then fails it rather than shipping a fragment as a
         |     completed, $0 delivery. Omitted/false = the stream genuinely ended. An adapter that cannot tell
         |     must report false (never guess true) — a false positive costs a full re-generation.
     listModels()     -> [{ id, context_length, max_completion_tokens, pricing, supportsTools }]
     contextLimit(id) -> number
     priceOf(id)      -> { in, out } | null      // per-million USD

   This module is the shared contract + a finish-reason normalizer used by adapters. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.providers = root.SK.providers || {}).provider = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EVENT_TYPES = ['text', 'tool_start', 'tool_args', 'tool_done', 'reasoning', 'usage', 'done'];
  const FINISH = ['tool_calls', 'stop', 'length', 'content_filter', 'error'];

  function normalizeFinish(r) {
    if (!r) return 'stop';
    if (r === 'tool_calls' || r === 'tool_use' || r === 'function_call') return 'tool_calls';
    if (r === 'length' || r === 'max_tokens') return 'length';
    if (r === 'content_filter') return 'content_filter';
    if (r === 'stop' || r === 'end_turn' || r === 'stop_sequence') return 'stop';
    return 'error';
  }

  // ---- shared stream-timeout plumbing (every adapter uses this so the logic isn't copy-pasted 5×) ----
  //
  // Two independent timeouts protect a run from hanging on paid spend:
  //   · CONNECT — a ceiling on the POST/fetch itself (headers not received). Env SKYNET_PROVIDER_CONNECT_MS,
  //     default 30s. Implemented by connectGuard(): a manual AbortController whose timer is DISARMED the moment
  //     response headers arrive, so this ceiling can never abort a healthy streaming body. (A fetch `signal`
  //     governs the ENTIRE response, so a bare AbortSignal.timeout kept ticking past headers and killed any
  //     turn that streamed longer than the ceiling — the 2026-07-07 codex incident. The body is the idle
  //     watchdog's job, not this timer's.)
  //   · IDLE    — a resettable watchdog around each reader.read(): if no bytes arrive for this long the reader
  //     is cancelled and a `timeout`-classified error is thrown. Env SKYNET_PROVIDER_IDLE_MS, default 300s.
  //     (Generous: once the connect guard is disarmed the idle watchdog is the body's ONLY ceiling, and a
  //     deep-reasoning turn can stay byte-silent for a while — a healthy run must not be killed mid-flight.)
  //
  // CRITICAL invariant: a user-cancel (the original signal aborts) must classify as abort/cancelled, NOT
  // timeout. connectGuard keeps the user's signal as a distinct input and, on a user-cancel, aborts its
  // controller with a NAMED AbortError; on a connect expiry it aborts with a plain Error whose message
  // contains "timed out" (errorClass.pickReason -> 'timeout'). Node/undici rejects fetch with the abort
  // REASON object, so the adapter sees exactly that error. Adapters' isAbort() keys off the original signal +
  // AbortError name only, so a connect-timeout is NEVER seen as a cancel (it retries like a transient network
  // error), and a user-cancel is NEVER seen as a timeout. The idle watchdog upholds the same split downstream.
  function envInt(name, dflt) {
    try {
      const v = (typeof process !== 'undefined' && process.env && process.env[name]);
      const n = v != null && String(v).trim() !== '' ? parseInt(v, 10) : NaN;
      return (isFinite(n) && n > 0) ? n : dflt;
    } catch (_) { return dflt; }
  }
  function connectMs() { return envInt('SKYNET_PROVIDER_CONNECT_MS', 30000); }
  function idleMs() { return envInt('SKYNET_PROVIDER_IDLE_MS', 300000); }

  // DEPRECATED for streaming fetches — new code MUST use connectGuard() instead. This merges the caller's
  // signal with a NON-disarmable AbortSignal.timeout: because a fetch signal governs the whole response, the
  // timeout keeps ticking after headers arrive and aborts a healthy streaming body (that killed a real >30s
  // codex turn on 2026-07-07). Kept only for non-streaming callers/tests that reference it.
  function connectSignal(signal, ms) {
    const timeoutMs = (ms != null && ms > 0) ? ms : connectMs();
    try {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' && typeof AbortSignal.any === 'function') {
        const parts = [AbortSignal.timeout(timeoutMs)];
        if (signal) parts.unshift(signal);
        return AbortSignal.any(parts);
      }
    } catch (_) {}
    return signal;
  }

  // Connect-phase guard: a manual AbortController whose timer is DISARMED the moment response headers arrive
  // (the adapter calls guard.disarm() in a finally around the fetch). Until then it enforces the connect
  // ceiling; after that the streaming body is protected only by the idle watchdog — so a slow-but-alive turn
  // can stream for as long as it keeps producing bytes.
  //   · guard.signal — pass this to fetch().
  //   · guard.disarm() — call once the fetch settles (headers arrived OR it rejected); idempotent.
  // Reasons (undici rejects fetch with the abort reason object): a connect expiry -> timeoutError() (name
  // 'Error', message "…timed out…", classifies as `timeout`, retryable); a user-cancel on the caller signal
  // -> makeAbortError() (name 'AbortError', so adapters' isAbort() treats it as a clean cancel). Degrades to
  // the caller's signal unchanged when AbortController is unavailable (older runtimes).
  function connectGuard(signal, ms) {
    const timeoutMs = (ms != null && ms > 0) ? ms : connectMs();
    if (typeof AbortController === 'undefined') return { signal: signal, disarm: function () {} };
    const ctrl = new AbortController();
    let timer = setTimeout(function () {
      timer = null;
      try { ctrl.abort(timeoutError(timeoutMs, 'connect')); } catch (_) { ctrl.abort(); }
    }, timeoutMs);
    let onAbort = null;
    if (signal) {
      onAbort = function () {
        if (timer) { clearTimeout(timer); timer = null; }
        try { ctrl.abort(makeAbortError()); } catch (_) { ctrl.abort(); }
      };
      if (signal.aborted) onAbort();
      else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    }
    return {
      signal: ctrl.signal,
      disarm: function () {
        if (timer) { clearTimeout(timer); timer = null; }
        if (onAbort && signal && typeof signal.removeEventListener === 'function') { signal.removeEventListener('abort', onAbort); onAbort = null; }
      }
    };
  }

  function timeoutError(ms, phase) {
    // message MUST contain "timed out" so errorClass.pickReason lands this on the `timeout` class (retryable,
    // no credential rotation). `phase` distinguishes connect vs idle for logs/telemetry.
    const e = new Error('provider stream ' + (phase || 'idle') + ' timed out after ' + ms + 'ms with no bytes received');
    e.code = 'PROVIDER_STREAM_TIMEOUT';
    e.timeout = true;
    e.phase = phase || 'idle';
    return e;
  }
  function makeAbortError() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }

  // Shared pre-stream retry primitives. Adapter-local copies left abort listeners attached after successful
  // delays, so repeated retries accumulated stale listeners on the run signal. Cleanup is symmetric here.
  function isAbort(error, signal) {
    return !!((signal && signal.aborted) || (error && error.name === 'AbortError'));
  }
  // A provider adapter owns the cheap pre-stream retry ladder because it can safely repeat a request before
  // any response bytes reach the loop. Once that ladder is exhausted, the loop must not unknowingly run the
  // whole adapter ladder again: OpenRouter's 3 attempts multiplied by the loop's 5 attempts into 15 identical
  // requests and ~24s of silent "working" against an immediately-broken API. Mid-stream failures never carry
  // this marker, so the loop keeps its separate recovery ladder for a stream that actually started.
  //
  // 2026-09-22 (Hermes audit): "surface the failure" turned a 4x503 blip into a dead single-provider run 1.6s in.
  // The marker now also says HOW MUCH of the ladder the adapter spent — `meta.attempts` requests and
  // `meta.waitedMs` of backoff — and the loop (recovery-policy preStreamSpend) counts exactly that against its
  // own rungs and patience, then continues the ladder for transient classes. Continuation, not multiplication.
  function markPreStreamRetriesExhausted(error, meta) {
    const e = (error && typeof error === 'object') ? error : new Error(String(error || 'provider request failed'));
    try {
      e.preStreamRetriesExhausted = true;
      if (meta && Number(meta.attempts) >= 1) e.preStreamAttempts = Math.floor(Number(meta.attempts));
      if (meta && Number(meta.waitedMs) >= 0) e.preStreamWaitMs = Math.floor(Number(meta.waitedMs));
    } catch (_) {}
    return e;
  }
  /* A TLS-handshake or socket failure names no destination: undici's cause for ERR_SSL_TLSV1_ALERT_DECODE_ERROR or
     UND_ERR_SOCKET carries no hostname, so a customer's diagnostics read "fetch failed (ERR_SSL_…)" and nobody
     could tell WHICH service broke (macOS report, 2026-10-07). The adapter knows the URL it dialled: stamp its
     HOSTNAME (never the URL — keys ride query strings and user:pass@ base URLs) so errorClass can name it. A host
     the cause already carries still wins there; an abort is a cancel, not a destination fault, and stays bare. */
  function requestHostOf(url) {
    if (!url) return '';
    try { return new URL(String(url)).hostname || ''; } catch (_) { return ''; }
  }
  function stampRequestHost(error, url) {
    if (!error || typeof error !== 'object' || error.requestHost || isAbort(error)) return error;
    const host = requestHostOf(url);
    if (host) { try { error.requestHost = host; } catch (_) { return error; } }
    return error;
  }
  /* How many pre-stream retries THIS request may make. Adapters default to their own ladder (RETRY_DELAYS); the
     loop sends req.preStreamRetries = 0 once its ladder owns the turn's pacing, so every rung it sleeps is exactly
     ONE request instead of one request plus the adapter's two quick re-sends. A request can only LOWER the
     adapter's budget, never raise it. */
  function preStreamRetries(req, dflt) {
    const d = Math.max(0, Math.floor(Number(dflt) || 0));
    const raw = req && req.preStreamRetries;
    if (raw == null || raw === '') return d;
    const n = Number(raw);
    return (isFinite(n) && n >= 0) ? Math.min(d, Math.floor(n)) : d;
  }
  function abortableDelay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(makeAbortError());
      let settled = false;
      let timer = null;
      function cleanup() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      }
      function finish(fn, value) {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      }
      function onAbort() { finish(reject, makeAbortError()); }
      timer = setTimeout(() => finish(resolve), Math.max(0, Number(ms) || 0));
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Wrap a WHATWG stream reader with a per-read idle watchdog. Each read() races a timer (reset every read);
  // on expiry the reader is cancelled and a `timeout` error is thrown. A user-cancel resolves as an AbortError
  // so the loop reports 'cancelled'. Returns a reader-shaped object exposing read()/cancel().
  function idleGuardedReader(reader, opts) {
    opts = opts || {};
    const ms = (opts.idleMs != null && opts.idleMs > 0) ? opts.idleMs : idleMs();
    const signal = opts.signal || null;
    let cancelled = false;
    async function read() {
      if (signal && signal.aborted) { try { await reader.cancel(); } catch (_) {} throw makeAbortError(); }
      let timer = null;
      let onAbort = null;
      const guard = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          cancelled = true;
          // REJECT FIRST, cancel SECOND (order is load-bearing). A WHATWG reader's cancel() settles the pending
          // read() as {done:true} SYNCHRONOUSLY, so cancel-before-reject let Promise.race adopt a clean
          // end-of-stream and the timeout error was LOST — a hung provider stream ended as a successful 'done'
          // run with tokens:0 (the 2026-07-08 stranded-user escape; night-shift beats inherited it and burned
          // leash reporting success). Rejecting first guarantees the guard settles before cancel can resolve
          // the read, so the watchdog genuinely errors the stream.
          reject(timeoutError(ms, 'idle'));
          try { const p = reader.cancel(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_) {}
        }, ms);
        // NOTE: deliberately NOT unref'd. The watchdog must be able to fire even when the stalled read() is the
        // only pending work — unref'ing would let the process exit instead of timing out (and would also break
        // deterministic unit testing of the watchdog). The timer is always cleared in the finally below.
        if (signal && typeof signal.addEventListener === 'function') {
          // same ordering law as the watchdog: reject BEFORE cancel, or a user-cancel resolves {done:true} and
          // the run ends 'done' instead of 'cancelled'.
          onAbort = () => {
            reject(makeAbortError());
            try { const p = reader.cancel(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_) {}
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      try {
        const r = await Promise.race([reader.read(), guard]);
        // belt-and-braces: even if some reader settles its read() ahead of the guard's rejection, a fired
        // watchdog must NEVER surface as a clean end-of-stream — the timeout always wins.
        if (cancelled) throw timeoutError(ms, 'idle');
        if (signal && signal.aborted) throw makeAbortError();
        return r;
      } catch (e) {
        // a socket dropped mid-response ("terminated", cause UND_ERR_SOCKET) surfaces HERE, not in the
        // adapter's fetch catch — name the destination host on it too (opts.url; hostname only, see stampRequestHost)
        throw stampRequestHost(e, opts.url);
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort && signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      }
    }
    function cancel(reason) { return reader.cancel ? reader.cancel(reason) : undefined; }
    return { read, cancel, get _cancelledByTimeout() { return cancelled; } };
  }

  const timeouts = { envInt, connectMs, idleMs, connectSignal, connectGuard, idleGuardedReader, timeoutError, makeAbortError };
  const runtime = { isAbort, abortableDelay, markPreStreamRetriesExhausted, preStreamRetries, stampRequestHost };

  function recoveredToolContent(callId, content) {
    let body;
    if (typeof content === 'string') body = content;
    else if (content == null) body = '';
    else {
      try { body = JSON.stringify(content); }
      catch (_) { body = String(content); }
    }
    return '[recovered tool result' + (callId ? ' ' + callId : '') + ' — its originating call is not in this transcript]\n' + body;
  }

  function repairToolPairs(messages) {
    /* Chat Completions backends (direct and managed) reject the whole request when a replayed transcript contains
       a `tool` message with no matching assistant `tool_calls` entry, or an assistant call reaches the next
       conversational message without a result. That turns one interrupted persistence/recovery seam into a
       permanent 400 because every retry replays the same malformed history. Repair only malformed pairs:
         · orphaned/duplicate results become plainly labeled user text, preserving their information;
         · unanswered calls receive a synthetic tool result before the next conversational message;
         · missing/duplicate ids inside one assistant batch are deterministically minted.
       A well-formed transcript returns by identity so its request bytes remain unchanged.

       A CALL THAT HAS A REAL RESULT IS NEVER LABELLED "interrupted" (2026-09-22, Hermes audit Step 2). Two
       malformed shapes used to do exactly that — an invitation to REPEAT a write that already happened:
         · a legacy batch that reused one id twice: the second call was re-minted, and its real result (the
           second result carrying the reused id) became "recovered" text while the minted call got the stub.
           The re-minted id now remembers the id it replaced, so that second result pairs with it;
         · a real result stranded AFTER an intervening message (an injected note, a user line persisted ahead
           of a late result): it is hoisted up beside its call, ahead of that message. The lookahead never
           crosses the next assistant message — a later result carrying the same id belongs to a later call. */
    if (!Array.isArray(messages) || !messages.length) return messages;
    const out = [];
    const open = new Map();       // call id -> true, insertion order preserves the assistant's call order
    const aliases = new Map();    // id reused inside the open batch -> minted ids standing in for its repeats
    const consumed = new Set();   // indexes of results already hoisted beside their call
    let changed = false;
    let minted = 0;

    function mintId() {
      let id;
      do { id = 'call_local_' + (++minted); } while (open.has(id));
      return id;
    }
    // The open call a result answers: its own id, else a minted stand-in for a repeat of that id.
    function openTarget(callId) {
      if (!callId) return '';
      if (open.has(callId)) return callId;
      const alt = aliases.get(callId);
      if (alt) for (const id of alt) if (open.has(id)) return id;
      return '';
    }
    function pushResult(msg, target) {
      if (msg.tool_call_id === target && msg.call_id == null) out.push(msg);
      else {
        const normalized = Object.assign({}, msg, { tool_call_id: target });
        delete normalized.call_id;
        out.push(normalized);
        changed = true;
      }
      open.delete(target);
    }
    // Results for the open batch that sit past `at` but before the next assistant turn.
    function hoistStranded(at) {
      for (let j = at + 1; j < messages.length && open.size; j++) {
        const m = messages[j];
        if (m && typeof m === 'object' && m.role === 'assistant') break;
        if (consumed.has(j) || !m || typeof m !== 'object' || m.role !== 'tool') continue;
        const target = openTarget(String(m.tool_call_id || m.call_id || ''));
        if (!target) continue;
        consumed.add(j);
        pushResult(m, target);
        changed = true;
      }
    }
    function closeInterrupted(at) {
      if (!open.size) return;
      if (at < messages.length && !(messages[at] && messages[at].role === 'assistant')) hoistStranded(at);
      for (const callId of open.keys()) {
        out.push({
          role: 'tool',
          tool_call_id: callId,
          content: '[interrupted — this call produced no recorded result. Reissue it if it is still needed.]'
        });
        changed = true;
      }
      open.clear();
      aliases.clear();
    }

    for (let i = 0; i < messages.length; i++) {
      if (consumed.has(i)) continue;   // already hoisted beside its call
      const msg = messages[i];
      if (!msg || typeof msg !== 'object') {
        closeInterrupted(i);
        out.push(msg);
        continue;
      }
      if (msg.role === 'tool') {
        const callId = String(msg.tool_call_id || msg.call_id || '');
        const target = openTarget(callId);
        if (target) pushResult(msg, target);
        else {
          // A user message cannot split an outstanding assistant tool-call batch, so close it first.
          closeInterrupted(i);
          out.push({ role: 'user', content: recoveredToolContent(callId, msg.content) });
          changed = true;
        }
        continue;
      }

      // Chat Completions requires every result directly after its assistant call batch.
      closeInterrupted(i);
      aliases.clear();
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        let calls = msg.tool_calls;
        let callsChanged = false;
        calls = calls.map(tc => {
          if (!tc || typeof tc !== 'object') return tc;
          let callId = String(tc.id || (tc.function && tc.function.call_id) || '');
          if (!callId || open.has(callId)) {
            const reused = callId;
            callId = mintId();
            if (reused) { if (!aliases.has(reused)) aliases.set(reused, []); aliases.get(reused).push(callId); }
            callsChanged = true;
          }
          open.set(callId, true);
          if (tc.id === callId) return tc;
          callsChanged = true;
          return Object.assign({}, tc, { id: callId });
        });
        if (callsChanged) {
          out.push(Object.assign({}, msg, { tool_calls: calls }));
          changed = true;
        } else out.push(msg);
      } else out.push(msg);
    }
    closeInterrupted(messages.length);
    return changed ? out : messages;
  }

  /* ---- WIRE SANITATION (2026-09-22, Hermes audit Step 2) -------------------------------------------------
     ONE pre-send normalization every adapter applies before it builds its wire body. Before this, tool-pair
     repair lived in the two Chat Completions adapters only: after a run ended at the tool boundary the unpaired
     call rode into the Anthropic body as a `tool_use` with no `tool_result`, and into the Gemini body as a
     `functionCall` followed by user text. And ids minted by another provider (Kimi's `functions.read_file:0`)
     reached Anthropic, whose grammar is ^[a-zA-Z0-9_-]+$ (<= 64), unchanged after a fallback.

       prepareWireMessages(messages, target) -> messages
         target 'chat' | 'codex' | 'gemini' : repairToolPairs only (Chat Completions and Responses carry the ids
                                              verbatim; Gemini's wire carries no call ids — it pairs by position)
         target 'anthropic'                 : repairToolPairs + remapToolCallIds(ANTHROPIC_TOOL_ID)

     Never mutates the caller's array or messages. A well-formed transcript with grammar-valid, unique ids
     returns by IDENTITY, so its request bytes are unchanged. */
  const ANTHROPIC_TOOL_ID = { re: /^[a-zA-Z0-9_-]{1,64}$/, bad: /[^a-zA-Z0-9_-]/g, max: 64, empty: 'toolu_local' };
  const WIRE_TARGETS = { chat: {}, codex: {}, gemini: {}, anthropic: { idGrammar: ANTHROPIC_TOOL_ID } };

  /* Rewrite call ids into a target's grammar. Deterministic (same transcript -> same ids) and collision-free
     across the WHOLE request: a valid id that is unique keeps its bytes; an invalid one is rewritten
     (bad characters -> '_', clipped); anything that would collide — with an id already assigned, or with a
     valid id the transcript already carries — takes a numeric suffix. Each batch's results are rewritten
     with the SAME mapping as their calls (after repairToolPairs every result sits directly after its batch). */
  function remapToolCallIds(messages, grammar) {
    if (!Array.isArray(messages) || !messages.length || !grammar) return messages;
    const reserved = new Set();   // grammar-valid ids present anywhere: a rewrite must never land on one
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) { const id = tc && tc.id != null ? String(tc.id) : ''; if (grammar.re.test(id)) reserved.add(id); }
      }
    }
    const used = new Set();
    let batch = new Map();        // raw id -> wire id for the most recent assistant batch
    let changed = false;
    function assign(raw) {
      if (grammar.re.test(raw) && !used.has(raw)) { used.add(raw); return raw; }
      const base = String(raw).replace(grammar.bad, '_').slice(0, grammar.max) || grammar.empty;
      let id = base;
      for (let n = 2; used.has(id) || (id !== raw && reserved.has(id)) || !grammar.re.test(id); n++) {
        const sfx = '_' + n;
        id = base.slice(0, grammar.max - sfx.length) + sfx;
      }
      used.add(id);
      return id;
    }
    const out = messages.map(m => {
      if (!m || typeof m !== 'object') return m;
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        batch = new Map();
        let callsChanged = false;
        const calls = m.tool_calls.map(tc => {
          if (!tc || typeof tc !== 'object') return tc;
          const raw = String(tc.id == null ? '' : tc.id);
          const id = assign(raw);
          if (!batch.has(raw)) batch.set(raw, id);
          if (id === tc.id) return tc;
          callsChanged = true;
          return Object.assign({}, tc, { id });
        });
        if (!callsChanged) return m;
        changed = true;
        return Object.assign({}, m, { tool_calls: calls });
      }
      if (m.role === 'tool') {
        const raw = String(m.tool_call_id == null ? '' : m.tool_call_id);
        const id = batch.get(raw);
        if (id == null || id === m.tool_call_id) return m;
        changed = true;
        return Object.assign({}, m, { tool_call_id: id });
      }
      return m;
    });
    return changed ? out : messages;
  }

  function prepareWireMessages(messages, target) {
    if (!Array.isArray(messages)) return messages;
    const spec = WIRE_TARGETS[target] || WIRE_TARGETS.chat;
    let out = repairToolPairs(messages);
    if (spec.idGrammar) out = remapToolCallIds(out, spec.idGrammar);
    return out;
  }

  // Claude has one leading system block. Keep later host reminders in the
  // conversation, as the native Anthropic adapter does, so gateways cannot hoist
  // them and turn the preceding assistant answer into unsupported prefill.
  function preserveClaudeContinuations(messages, model) {
    if (!Array.isArray(messages) || !/anthropic\/|claude/i.test(String(model || ''))) return messages;
    let leading = true;
    return messages.map(message => {
      if (!message || message.role !== 'system') leading = false;
      return !leading && message && message.role === 'system'
        ? Object.assign({}, message, { role: 'user' }) : message;
    });
  }

  return { EVENT_TYPES, FINISH, normalizeFinish, timeouts, runtime, repairToolPairs, preserveClaudeContinuations,
    prepareWireMessages, remapToolCallIds, ANTHROPIC_TOOL_ID };
});
