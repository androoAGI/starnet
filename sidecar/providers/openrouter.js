/* sidecar/providers/openrouter.js — the ONLY module that knows the OpenRouter wire format.
   Implements the LLMProvider seam (provider.js): stream(req) -> AsyncIterable<HarnessEvent>,
   plus listModels / contextLimit / priceOf. `fetch` is INJECTED (Node global fetch in the host,
   a fake Response in tests) so the same module is testable headlessly.

   SSE handling (verified against OpenRouter, June 2026): skip ':' keep-alive comments, honor the
   '[DONE]' sentinel, buffer partial reads across chunks, and accumulate tool-call argument
   fragments BY INDEX. We DO send `usage:{include:true}`: a streaming response returns token
   counts by default, but the real billed `cost` field is OPT-IN — without this flag usage.cost is
   absent, so SPEND silently reads $0 (only the token tallies move) for any model not in the warmed
   price catalog. With it, the final chunk carries the authoritative billed cost cost.js prefers. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./provider.js'), require('./errorClass.js'));
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.openrouter = factory(root.SK.providers.provider, root.SK.providers.errorClass); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provider, errorClass) {
  'use strict';

  const normalizeFinish = provider.normalizeFinish;
  const classifyApiError = errorClass.classifyApiError;
  const timeouts = provider.timeouts;
  const BASE = 'https://openrouter.ai/api/v1';

  // The OpenRouter /models catalog is key-independent, so it is shared across every per-run
  // provider instance: warmed once (see warmCatalog), it makes priceOf/contextLimit live for all
  // runs without a per-run /models round-trip. Concurrent loads dedupe on CATALOG_PROMISE.
  let CATALOG = null;
  let CATALOG_PROMISE = null;
  // Catalog re-warm throttle: a boot-time /models failure leaves CATALOG empty, which otherwise stays empty
  // forever (priceOf/contextLimit degrade silently). Kick a non-blocking re-fetch at run setup, at most once
  // per REWARM_MIN_MS so a persistently-offline catalog can't hammer /models on every run. Wall time arrives
  // via the caller-injected clock (determinism law — no ambient Date.now in backend logic); with no clock the
  // throttle degrades to "at most one kick per provider instance" (instances are per-run -> at most once/run).
  let CATALOG_REWARM_AT = 0;
  const REWARM_MIN_MS = 5 * 60 * 1000;

  function isAbort(e, signal) {
    // ONLY a real cancellation — never a loose message match, which would mask a genuine provider
    // error (whose text happens to contain "abort") as a clean, empty, "successful" turn.
    return provider.runtime.isAbort(e, signal);
  }

  const RETRY_DELAYS = [400, 1200];   // up to 2 retries (no jitter -> determinism); retryability comes from classifyApiError
  const OPENROUTER_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const REASONING_EFFORT_ORDER = OPENROUTER_REASONING_EFFORTS;
  const OFF_ONLY_EFFORTS = ['none'];
  function delay(ms, signal) {
    return provider.runtime.abortableDelay(ms, signal);
  }

  // ---- prompt caching: mark the byte-stable system prefix as cacheable for providers that honor explicit
  //      breakpoints (Anthropic via OpenRouter). Anthropic caches everything up to & including the marked block,
  //      so on every turn after the first the system prompt + tool note is a cache HIT (much cheaper input tokens;
  //      the saving surfaces as `cached_tokens` in usage, which cost.js already reconciles). A pure NO-OP for
  //      models without explicit caching — their plain-string content is returned untouched, so the wire body is
  //      byte-identical to before and other providers are unaffected. Returns a new array; never mutates the
  //      loop's messages. (The growing conversation tail is covered by the sliding anchors below — the
  //      "planned follow-up" from the first win shipped 2026-08-17.)
  //      NOTE (verified vs the OpenRouter + Anthropic docs, 2026): this is the exact accepted wire shape and never
  //      errors, but Anthropic only caches a prefix at/above a per-model MINIMUM (~1024 tokens for Opus 4.8 /
  //      Sonnet 4.6; up to 4096 for Opus 4.6/4.5 + Haiku 4.5) — below that it runs UNCACHED with no error. So a
  //      real cache HIT (cached_tokens > 0) requires the actual system prefix to clear that floor; billing stays
  //      honest either way (cost.js reads the provider's real usage.cost + cached_tokens).
  function supportsExplicitCache(model) {
    return /anthropic\/|claude/i.test(String(model || ''));
  }
  function applyCacheControl(messages, model) {
    if (!Array.isArray(messages) || !supportsExplicitCache(model)) return messages;
    let idx = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i] && messages[i].role === 'system') idx = i; else break;   // last of the LEADING system block
    }
    const out = messages.slice();
    if (idx >= 0 && typeof messages[idx].content === 'string') {
      out[idx] = { role: 'system', content: [{ type: 'text', text: messages[idx].content, cache_control: { type: 'ephemeral' } }] };
    }
    /* SLIDING TAIL ANCHORS (ported from the anthropic adapter's Hermes-parity pass). The single system anchor
       caches the static prefix, but the bytes migrate into the CONVERSATION as a run grows — tool results
       re-billed as uncached input on every turn. Mark the last three stampable messages too: with the system
       anchor that is exactly Anthropic's 4-breakpoint maximum. Three (not one) because a breakpoint only looks
       BACK 20 content blocks for its predecessor, and one wide parallel-tool turn can append more than 20
       blocks — a single trailing anchor then misses the old one and the whole tail re-bills as a cold write.
       Anchors slid off remain valid READ points. Conservative stamping: user/assistant/tool roles only (the
       leading system block already has its anchor; OpenRouter's translation of a MID-array system note is
       undocumented), non-blank text only (Anthropic 400s an empty text block), and copies — never stamps a
       caller's message or part in place. Anthropic-through-OpenRouter only (supportsExplicitCache above);
       every other upstream sees the exact prior wire shape. */
    let stamped = 0;
    for (let i = out.length - 1; i > idx && stamped < 3; i--) {
      const m = out[i];
      if (!m || m.role === 'system') continue;
      if (typeof m.content === 'string' && m.content.trim()) {
        out[i] = Object.assign({}, m, { content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] });
        stamped++;
      } else if (Array.isArray(m.content) && m.content.length) {
        const parts = m.content.slice();
        const last = parts[parts.length - 1];
        if (last && last.type === 'text' && typeof last.text === 'string' && last.text.trim()) {
          parts[parts.length - 1] = Object.assign({}, last, { cache_control: { type: 'ephemeral' } });
          out[i] = Object.assign({}, m, { content: parts });
          stamped++;
        }
      }
    }
    return out;
  }

  const repairToolPairs = provider.repairToolPairs;

  const preserveClaudeContinuations = provider.preserveClaudeContinuations;

  function normalizeReasoningEffort(value) {
    const key = String(value || 'medium').trim().toLowerCase().replace(/[\s_-]+/g, '');
    const map = {
      off: 'none', none: 'none', no: 'none', disabled: 'none',
      min: 'minimal', minimal: 'minimal',
      low: 'low',
      med: 'medium', mid: 'medium', medium: 'medium',
      high: 'high',
      extra: 'xhigh', xtra: 'xhigh', extrahigh: 'xhigh', xhigh: 'xhigh',
      max: 'max'
    };
    return map[key] || 'medium';
  }
  function modelFamily(model, meta) {
    const id = String((meta && meta.id) || model || '').toLowerCase();
    const name = String((meta && meta.name) || '').toLowerCase();
    if (/^(openai|openai-internal)\//.test(id) || /\bgpt[-\s]?\d|\bgpt\b|codex/.test(id + ' ' + name)) return 'gpt';
    if (/^anthropic\//.test(id) || /claude/.test(id + ' ' + name)) return 'anthropic';
    if (/^google\//.test(id) || /gemini/.test(id + ' ' + name)) return 'google';
    return 'other';
  }
  function normalizeEffortList(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set(), out = [];
    for (const v of list) {
      const effort = normalizeReasoningEffort(v);
      if (!seen.has(effort)) { seen.add(effort); out.push(effort); }
    }
    return out;
  }
  function modelSupportsReasoning(model, meta) {
    if (meta && meta.supportsReasoning != null) return !!meta.supportsReasoning;
    const params = meta && meta.supported_parameters;
    if (Array.isArray(params)) {
      const set = new Set(params.map(p => String(p).toLowerCase()));
      return set.has('reasoning') || set.has('reasoning_effort') || set.has('include_reasoning');
    }
    const family = modelFamily(model, meta);
    return family === 'gpt' || family === 'anthropic' || family === 'google';
  }
  function reasoningEffortsForModel(model, meta) {
    const declared = normalizeEffortList(meta && (meta.reasoningEfforts || meta.reasoning_efforts || meta.supportedReasoningEfforts || meta.supported_reasoning_efforts));
    if (declared.length) return declared;
    if (!modelSupportsReasoning(model, meta)) return OFF_ONLY_EFFORTS.slice();
    return OPENROUTER_REASONING_EFFORTS.slice();
  }
  function clampReasoningEffortForModel(model, effort, meta) {
    const allowed = reasoningEffortsForModel(model, meta);
    const normalized = normalizeReasoningEffort(effort);
    if (allowed.indexOf(normalized) >= 0) return normalized;
    const set = new Set(allowed);
    let idx = REASONING_EFFORT_ORDER.indexOf(normalized);
    if (idx < 0) idx = REASONING_EFFORT_ORDER.indexOf('medium');
    for (let i = idx; i >= 0; i--) if (set.has(REASONING_EFFORT_ORDER[i])) return REASONING_EFFORT_ORDER[i];
    for (let i = idx + 1; i < REASONING_EFFORT_ORDER.length; i++) if (set.has(REASONING_EFFORT_ORDER[i])) return REASONING_EFFORT_ORDER[i];
    return allowed[0] || 'none';
  }

  function makeOpenRouterProvider(opts) {
    opts = opts || {};
    const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('openrouter provider requires fetch (Node 18+) or opts.fetch');
    const key = opts.key;
    const baseUrl = opts.baseUrl || BASE;
    const referer = opts.referer || 'http://127.0.0.1';
    const reasoningEffort = normalizeReasoningEffort(opts.reasoningEffort || 'medium');
    const clock = (opts.clock && typeof opts.clock.now === 'function') ? opts.clock : null;   // injected wall clock (re-warm throttle); absent -> per-instance kick
    let rewarmKicked = false;   // fallback throttle when no clock: kick at most once per instance (= once per run)

    // Non-blocking catalog re-warm: if the catalog never loaded (empty), kick one throttled listModels() so a
    // later run prices/compacts correctly. Fire-and-forget — the CURRENT run never waits on it (it uses whatever
    // is warm, exactly as before). Safe to call every run; the timestamp gate bounds the /models traffic.
    function maybeRewarmCatalog() {
      if (CATALOG && CATALOG.length) return;               // already warm
      if (CATALOG_PROMISE) return;                         // a load is already in flight
      if (clock) {
        const now = clock.now();
        if (now - CATALOG_REWARM_AT < REWARM_MIN_MS) return; // time-throttled across runs
        CATALOG_REWARM_AT = now;
      } else {
        if (rewarmKicked) return;                          // no clock: at most one kick per instance (per run)
        rewarmKicked = true;
      }
      Promise.resolve().then(() => loadCatalog()).catch(() => {});
    }

    async function* stream(req) {
      maybeRewarmCatalog();
      // usage.include asks OpenRouter to return the real billed `cost` in the final usage chunk (opt-in for
      // streaming). Without it tokens still tally but usd stays 0 unless priceOf(model) resolves — so SPEND
      // reads $0 for any custom/uncatalogued slug. cost.js then takes this authoritative cost over the estimate.
      const meta = findModel(req.model);
      const allowed = reasoningEffortsForModel(req.model, meta);
      const effort = clampReasoningEffortForModel(req.model, req.reasoningEffort || reasoningEffort, meta);
      const body = { model: req.model, messages: applyCacheControl(preserveClaudeContinuations(repairToolPairs(req.messages), req.model), req.model), stream: true, usage: { include: true } };
      if (effort !== 'none' || allowed.length > 1) body.reasoning = { effort };
      if (req.tools && req.tools.length) {
        body.tools = req.tools;
        body.tool_choice = 'auto';
        /* parallel_tool_calls is deliberately OMITTED (provider default: enabled). It was forced `false` in the
           MVP "to keep the visualization linear" — a decision made BEFORE the loop grew its concurrent dispatch
           path. The loop now executes an all-read-only batch under Promise.all with call-order-preserving emits
           (loop.js), and the host's parallelSafe predicate (index.js) keeps browser/shell/mcp/consent tools
           serial — so forcing one tool per turn here only bought extra full round trips (a four-file read cost
           four prompt re-sends). Reverses docs/harness-runtime-spec.md's MVP position, dated 2026-08-17. */
      }
      let res;
      try { res = await requestWithRetry(body, req.signal); }   // retries transient 429/5xx + network errors BEFORE any token streams
      catch (e) { if (isAbort(e, req.signal)) return; throw e; }  // cancel during the POST/backoff -> end cleanly so the loop reports 'cancelled', not 'error'
      // idle watchdog: no bytes for SKYNET_PROVIDER_IDLE_MS -> cancel the reader + throw a `timeout` error (a hung
      // stream must not pin a paid run forever). A user-cancel via req.signal still surfaces as an AbortError below.
      const reader = timeouts.idleGuardedReader(res.body.getReader(), { signal: req.signal });
      const dec = new TextDecoder();
      let buf = '';
      const started = {};   // index -> true once tool_start has been emitted
      let doneEmitted = false;   // exactly one terminal event per stream (see STREAM-END TRUTH below)

      // parse ONE raw SSE line into either a control signal or its JSON payload
      function parseLine(line) {
        const t = line.replace(/\r$/, '').trim();
        if (!t || t.charAt(0) === ':') return null;          // blank / keep-alive comment
        if (t.indexOf('data:') !== 0) return null;
        const data = t.slice(5).trim();
        if (data === '[DONE]') return { done: true };
        try { return { json: JSON.parse(data) }; } catch (e) { return null; }
      }
      // one decoded chunk -> 0..n normalized HarnessEvents (shared by the loop + end-of-stream flush)
      function* emitFrom(j) {
        if (j.error) throw new Error((j.error && j.error.message) || 'openrouter stream error');
        const choice = j.choices && j.choices[0];
        if (choice && choice.delta) {
          const d = choice.delta;
          if (typeof d.content === 'string' && d.content) yield { type: 'text', delta: d.content };
          if (Array.isArray(d.tool_calls)) {
            for (const tc of d.tool_calls) {
              const idx = (tc.index != null) ? tc.index : 0;
              if (!started[idx] && (tc.id || (tc.function && tc.function.name))) {
                started[idx] = true;
                yield { type: 'tool_start', index: idx, id: tc.id || ('call_' + idx), name: (tc.function && tc.function.name) || '' };
              }
              if (tc.function && typeof tc.function.arguments === 'string' && tc.function.arguments) {
                yield { type: 'tool_args', index: idx, chunk: tc.function.arguments };
              }
            }
          }
        }
        if (j.usage) yield { type: 'usage', usage: j.usage };
        if (choice && choice.finish_reason && !doneEmitted) {
          doneEmitted = true;
          yield { type: 'done', finishReason: normalizeFinish(choice.finish_reason), truncated: false };
        }
      }

      try {
        let sawSentinel = false;                     // the `data: [DONE]` end-of-stream marker
        while (!sawSentinel) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            const p = parseLine(line);
            if (!p) continue;
            if (p.done) { sawSentinel = true; break; }
            yield* emitFrom(p.json);
          }
        }
        // flush a final line that arrived WITHOUT a trailing newline (rare: the closing usage/done chunk)
        if (!sawSentinel) {
          buf += dec.decode();
          if (buf.trim()) {
            const p = parseLine(buf);
            if (p && p.done) sawSentinel = true;
            else if (p && p.json) yield* emitFrom(p.json);
          }
        }
        // STREAM-END TRUTH (truthful-telemetry law): always emit exactly ONE terminal event, and say honestly
        // whether the stream really ENDED or merely stopped arriving. A complete response carries a
        // finish_reason, a `[DONE]` sentinel, or both; a clean mid-generation FIN carries NEITHER, and the loop
        // cannot otherwise tell it apart from a finished answer — so it shipped the fragment as a completed,
        // $0 delivery. Requiring only ONE of the two signals keeps upstreams that send just one reading complete.
        if (!doneEmitted) yield { type: 'done', finishReason: null, truncated: !sawSentinel };
      } catch (e) {
        if (isAbort(e, req.signal)) return;   // cancellation: end the stream cleanly so the loop reports 'cancelled'
        throw e;
      }
    }

    async function loadCatalog() {
      if (CATALOG && CATALOG.length) return CATALOG;   // only a NON-empty catalog is a cache hit
      if (!CATALOG_PROMISE) {
        CATALOG_PROMISE = (async () => {
          try {
            const res = await doFetch(baseUrl + '/models', {});
            const j = await res.json();
            return (j.data || []).map(m => ({
              id: m.id,
              name: m.name || m.id,
              context_length: m.context_length || 0,
              max_completion_tokens: (m.top_provider && m.top_provider.max_completion_tokens) || null,
              pricing: m.pricing,
              supported_parameters: Array.isArray(m.supported_parameters) ? m.supported_parameters.slice() : [],
              supportsTools: !!(m.supported_parameters && m.supported_parameters.indexOf('tools') >= 0),
              supportsReasoning: !!(m.supported_parameters && (m.supported_parameters.indexOf('reasoning') >= 0 || m.supported_parameters.indexOf('reasoning_effort') >= 0 || m.supported_parameters.indexOf('include_reasoning') >= 0)),
              reasoningEfforts: normalizeEffortList(m.reasoningEfforts || m.reasoning_efforts || m.supportedReasoningEfforts || m.supported_reasoning_efforts)
            }));
          } catch (e) { return []; }
        })();
      }
      CATALOG = await CATALOG_PROMISE;
      if (!CATALOG.length) CATALOG_PROMISE = null;     // empty (transient failure / no data): allow a later retry, don't pin
      return CATALOG;
    }
    async function listModels() { return (await loadCatalog()).map(m => Object.assign({}, m)); }
    function findModel(id) { return CATALOG ? CATALOG.find(m => m.id === id) : null; }
    function contextLimit(id) { const m = findModel(id); return (m && m.context_length) || 0; }
    function priceOf(id) {
      // best-effort: null until the catalog is loaded — cost.js then relies on the provider's
      // real `usage.cost` (always returned by OpenRouter), so this never blocks honest accounting.
      const m = findModel(id);
      if (!m || !m.pricing) return null;
      const i = parseFloat(m.pricing.prompt) * 1e6, o = parseFloat(m.pricing.completion) * 1e6;
      return (isFinite(i) && isFinite(o)) ? { in: i, out: o } : null;
    }
    // true/false once the catalog is warm; null = unknown (cold catalog) so callers don't false-refuse.
    function supportsTools(id) { const m = findModel(id); return m ? !!m.supportsTools : null; }
    function reasoningEfforts(id) { return reasoningEffortsForModel(id, findModel(id)); }

    // POST the chat request, retrying transient failures (429/5xx + network resets) BEFORE the stream
    // starts — safe because no tokens have been emitted yet. Aborts propagate at once. Returns an ok Response.
    async function requestWithRetry(body, signal) {
      let lowCreditHealed = false;   // one-shot: a 402 affordability refusal retries ONCE with a clamped max_tokens
      for (let attempt = 0; ; attempt++) {
        if (signal && signal.aborted) throw abortError();
        let res;
        // Fresh connect guard per attempt; disarmed the instant the fetch settles so the ceiling can't abort
        // the streaming body (a connect expiry rejects as a `timeout`, a user-cancel as AbortError).
        const guard = timeouts.connectGuard(signal);
        try {
          res = await doFetch(baseUrl + '/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + (key || ''), 'Content-Type': 'application/json', 'HTTP-Referer': referer, 'X-Title': 'STARNET' },
            body: JSON.stringify(body),
            signal: guard.signal   // caller-cancel + a disarmable connect-timeout ceiling on the POST itself
          });
        } catch (e) {
          if (isAbort(e, signal)) throw e;
          if (attempt < RETRY_DELAYS.length) { await delay(RETRY_DELAYS[attempt], signal); continue; }   // network error / connect timeout -> retry
          throw provider.runtime.markPreStreamRetriesExhausted(e);
        } finally {
          guard.disarm();
        }
        if (res.ok && res.body) return res;
        let detail = res.statusText || '';
        try { const j = await res.json(); detail = (j && j.error && j.error.message) || JSON.stringify(j); }
        catch (e) { try { detail = (await res.text()).slice(0, 300); } catch (_) {} }
        // LOW-CREDIT SELF-HEAL (402): with max_tokens unset, OpenRouter reserves the model's FULL output
        // ceiling against the account balance — a low-credit account gets "requires more credits, or fewer
        // max_tokens … can only afford N" even though the actual reply needs a fraction of N. That stranded
        // real users (WAKE preflight + every channel run dead on a funded-but-small balance). The refusal
        // names the affordable ceiling, so retry ONCE with max_tokens clamped to 90% of it (floor 1024 —
        // below that the account is genuinely broke and the honest 402 stands, credits URL included).
        if (res.status === 402 && !lowCreditHealed) {
          const m = /can only afford (\d+)/i.exec(detail);
          const afford = m ? Math.floor(Number(m[1]) * 0.9) : 0;
          const cur = Number(body.max_tokens || 0);
          if (afford >= 1024 && (!cur || afford < cur)) {
            lowCreditHealed = true;
            body = Object.assign({}, body, { max_tokens: afford });
            continue;
          }
        }
        const err = new Error('openrouter http ' + res.status + ' — ' + detail);
        err.status = res.status;
        err.headers = res.headers;   // H6.1: let classifyApiError read Retry-After / X-RateLimit-Reset off the real response
        const cls = classifyApiError(err, { model: body.model });   // single source of truth for retryability
        err.transient = cls.retryable;                              // keep the field other code reads, now classifier-derived
        if (cls.retryable && attempt < RETRY_DELAYS.length) { await delay(Math.min(60000, Math.max(RETRY_DELAYS[attempt], cls.retryAfterMs || 0)), signal); continue; }   // honor the server-stated wait, capped at 60s
        throw cls.retryable ? provider.runtime.markPreStreamRetriesExhausted(err) : err;
      }
    }

    return { stream, listModels, contextLimit, priceOf, supportsTools, reasoningEfforts };
  }

  return { makeOpenRouterProvider, applyCacheControl, _internals: { normalizeReasoningEffort, reasoningEffortsForModel, clampReasoningEffortForModel, repairToolPairs } };
});
