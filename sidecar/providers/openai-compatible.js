/* sidecar/providers/openai-compatible.js - generic OpenAI-compatible chat/completions adapter.
   Used for OpenAI API, local Ollama/vLLM/LM Studio, and user-supplied custom /v1 endpoints.
   It implements the same LLMProvider seam as OpenRouter and Codex. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./provider.js'), require('./errorClass.js'), require('./prices.js'));
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.openaiCompatible = factory(root.SK.providers.provider, root.SK.providers.errorClass, root.SK.providers.prices); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provider, errorClass, prices) {
  'use strict';

  const normalizeFinish = provider.normalizeFinish;
  const classifyApiError = errorClass.classifyApiError;
  const timeouts = provider.timeouts;
  const isAbort = provider.runtime.isAbort;
  const delay = provider.runtime.abortableDelay;
  const RETRY_DELAYS = [400, 1200];
  const REWARM_MIN_MS = 5 * 60 * 1000;
  // Optional request params that "OpenAI-compatible" providers disagree on. When a provider 400s and its
  // error text names one of these, we drop it and retry — the request still means the same thing without
  // them. `tools` is deliberately NOT in this list: silently removing tools would let a task run proceed
  // without the capability it needs (the run must fail honestly instead).
  const DROPPABLE_PARAMS = ['stream_options', 'parallel_tool_calls', 'tool_choice', 'reasoning_effort'];
  // The chat-completions wire accepts this effort scale; StarNet's wider scale (xhigh/max) clamps into it.
  const WIRE_EFFORTS = ['minimal', 'low', 'medium', 'high'];
  function wireEffort(value) {
    const v = String(value || '').trim().toLowerCase();
    if (!v || v === 'none' || v === 'off') return '';
    if (v === 'xhigh' || v === 'max' || v === 'extrahigh') return 'high';
    if (v === 'min') return 'minimal';
    return WIRE_EFFORTS.indexOf(v) >= 0 ? v : 'medium';
  }

  // NO default endpoint. This adapter used to fall back to https://api.openai.com/v1 on an empty baseUrl,
  // which meant a provider whose baseUrl resolves dynamically (starnet: the linked cloud URL) silently sent
  // its runs — bearer credential and all — to OpenAI's API the moment the link failed to resolve, and the
  // user got OpenAI's "invalid model ID" for a catalog id that was never meant for that endpoint
  // (2026-08-25 stranded-user incident). An endpointless provider must refuse loudly, never reroute.
  function cleanBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }
  function cleanPath(value, fallback) {
    const path = String(value || fallback || '').trim();
    if (!path) return '';
    return path.charAt(0) === '/' ? path : '/' + path;
  }
  function headerBag(key, extra) {
    const h = Object.assign({ 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }, extra || {});
    if (key) h.Authorization = 'Bearer ' + key;
    return h;
  }
  function safeErrorField(value, limit) {
    if (value == null || (typeof value === 'object' && typeof value !== 'number')) return '';
    return String(value)
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk|api)[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
      .replace(/[\r\n\t\0-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, limit || 300);
  }
  function responseHeader(res, names) {
    if (!res || !res.headers || typeof res.headers.get !== 'function') return '';
    for (const name of names) {
      const value = safeErrorField(res.headers.get(name), 120);
      if (value) return value;
    }
    return '';
  }
  async function responseErrorDetail(res) {
    let data = null;
    let text = '';
    try {
      text = typeof res.text === 'function' ? await res.text() : '';
      if (text) { try { data = JSON.parse(text); } catch (_) { data = null; } }
    } catch (_) { text = ''; data = null; }
    if (!data && !text && typeof res.json === 'function') {
      try { data = await res.json(); } catch (_) { data = null; }
    }
    const e = data && data.error;
    const message = safeErrorField((e && e.message) || (data && data.message) || text || res.statusText || ('HTTP ' + res.status), 500);
    const type = safeErrorField(e && e.type, 80);
    const code = safeErrorField(e && e.code, 80);
    // OpenRouter places provider identity in metadata; raw metadata is deliberately ignored because it may
    // contain provider payloads or user content. The managed proxy promotes only this allowlisted field.
    const providerName = safeErrorField((e && e.provider) || (e && e.metadata && (e.metadata.provider_name || e.metadata.provider)), 100);
    const requestId = safeErrorField(
      (e && (e.request_id || e.requestId)) || (data && (data.request_id || data.requestId)) ||
      responseHeader(res, ['x-starnet-request-id', 'x-request-id', 'x-openrouter-request-id', 'request-id']),
      120
    );
    const upstreamRequestId = safeErrorField(e && e.upstream_request_id, 120);
    const facts = [];
    if (requestId) facts.push('request ' + requestId);
    if (upstreamRequestId) facts.push('upstream ' + upstreamRequestId);
    if (type) facts.push('type ' + type);
    if (code) facts.push('code ' + code);
    if (providerName) facts.push('provider ' + providerName);
    // Diagnostics deliberately clamps messages. Put correlation before the free-text detail so a
    // verbose upstream error cannot truncate the only identifiers support can trace.
    return { detail: (facts.length ? '[' + facts.join('; ') + '] ' : '') + message, type, code, providerName, requestId };
  }
  function normalizeModel(m) {
    const id = (m && (m.id || m.name || m.model)) ? String(m.id || m.name || m.model) : '';
    if (!id) return null;
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters.slice() : [];
    return {
      id,
      name: m.name || id,
      context_length: Number(m.context_length || m.context_window || m.max_context_window || 0) || 0,
      max_completion_tokens: Number(m.max_completion_tokens || m.max_output_tokens || 0) || null,
      pricing: m.pricing || null,
      supported_parameters: params,
      // supported_parameters without 'tools' is unknown (null), not false — many catalogs omit the flag.
      supportsTools: typeof m.supportsTools === 'boolean' ? m.supportsTools : (params.indexOf('tools') >= 0 ? true : null),
      supportsReasoning: typeof m.supportsReasoning === 'boolean' ? m.supportsReasoning : null,
      reasoningEfforts: Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts.slice() : []
    };
  }

  function makeOpenAICompatibleProvider(opts) {
    opts = opts || {};
    const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('openai-compatible provider requires fetch (Node 18+) or opts.fetch');
    const key = opts.key || '';
    const baseUrl = cleanBaseUrl(opts.baseUrl);
    if (!baseUrl) throw new Error((opts.label || 'openai-compatible') + ' provider has no endpoint configured (empty base URL)');
    const chatPath = cleanPath(opts.chatPath, '/chat/completions');
    const modelsPath = cleanPath(opts.modelsPath, '/models');
    // Usage reporting defaults ON: streams must report token usage so cost accounting and
    // context compaction work. Callers may opt out with an explicit includeUsage: false.
    const includeUsage = opts.includeUsage !== false;
    const defaultContext = Number(opts.defaultContext || 0) || 0;
    const configuredConnectMs = Number(opts.connectTimeoutMs);
    const connectTimeoutMs = Number.isFinite(configuredConnectMs) && configuredConnectMs > 0
      ? Math.floor(configuredConnectMs)
      : undefined;
    const clock = (opts.clock && typeof opts.clock.now === 'function') ? opts.clock : null;
    // Provider-profile hints (registry): whether this endpoint documents the `reasoning_effort` chat
    // param, and a tool-capability fallback for catalogs that carry no capability metadata (most raw
    // /models responses). Both stay null/off unless the profile asserts them — capability claims must
    // come from somewhere provable, never be assumed.
    const sendReasoningEffort = opts.sendReasoningEffort === true;
    // Error identity: HTTP failures name the PROVIDER when the factory supplies a label. A raw
    // "openai-compatible http 401" mid-run carried no provider identity, so the frontend's recovery
    // classifier couldn't route a dead grok/kimi sign-in to its ⏼ RECONNECT door — users got the
    // keyed-provider "＋ Add a key" door for a keyless subscription sign-in.
    const errLabel = String(opts.label || 'openai-compatible');
    const profileSupportsTools = (typeof opts.supportsTools === 'boolean') ? opts.supportsTools : null;
    /* PRICE FAMILY (2026-08-21). OpenAI's /v1/models — and every vendor that clones it — carries NO pricing
       block, so priceOf() returned null on openai/xai/groq/mistral/deepseek/together/fireworks and cost.js
       priced every turn at $0: the per-run spend cap could never fire on any of them. The registry profile
       names the prices.js table to fall back to (null for ollama/custom/perplexity — genuinely unpriced, and
       the run stays honestly 'unpriced' there). Catalog pricing, when an endpoint DOES publish it, still wins. */
    const priceFamily = (typeof opts.priceFamily === 'string' && opts.priceFamily.trim()) ? opts.priceFamily.trim() : null;
    const listPrices = (prices && typeof prices.priceOf === 'function') ? prices : null;
    const defaultEffort = String(opts.reasoningEffort || '');
    // Static catalog fallback for endpoints with no usable /models (e.g. Perplexity, whose
    // /v1/models lists Agent-API models, not its chat-completions roster). Used only when the
    // live endpoint yields nothing — a real catalog always wins.
    const staticModels = Array.isArray(opts.staticModels) ? opts.staticModels.map(normalizeModel).filter(Boolean) : [];
    const droppedParams = new Map();   // model -> Set(param) learned from unsupported-param 400s
    let catalog = null;
    let catalogPromise = null;
    let catalogRewarmAt = 0;
    let rewarmKicked = false;

    function rememberDrop(model, param) {
      const key = String(model || '');
      let set = droppedParams.get(key);
      if (!set) { set = new Set(); droppedParams.set(key, set); }
      set.add(param);
    }
    // A 4xx whose error text names an optional param we sent -> remove it from the body and signal a
    // retry. One param per pass; terminates because each pass deletes a body field.
    function dropUnsupportedParam(body, status, detail) {
      if (status !== 400 && status !== 422) return null;
      const text = String(detail || '').toLowerCase();
      for (const p of DROPPABLE_PARAMS) {
        if (body[p] === undefined) continue;
        if (text.indexOf(p) >= 0) { delete body[p]; rememberDrop(body.model, p); return p; }
      }
      return null;
    }

    // Non-blocking catalog re-warm: an empty catalog (boot-time /models failure) otherwise stays empty forever.
    // Throttled by the injected clock; no clock -> at most one kick per instance (determinism law: no Date.now).
    function maybeRewarmCatalog() {
      if (catalog && catalog.length) return;
      if (catalogPromise) return;
      if (clock) {
        const now = clock.now();
        if (now - catalogRewarmAt < REWARM_MIN_MS) return;
        catalogRewarmAt = now;
      } else {
        if (rewarmKicked) return;
        rewarmKicked = true;
      }
      Promise.resolve().then(() => loadCatalog()).catch(() => {});
    }

    async function* stream(req) {
      req = req || {};
      maybeRewarmCatalog();
      const dropped = droppedParams.get(String(req.model || ''));
      const skip = p => !!(dropped && dropped.has(p));
      const body = { model: req.model, messages: provider.preserveClaudeContinuations(provider.repairToolPairs(req.messages || []), req.model), stream: true };
      if (includeUsage && !skip('stream_options')) body.stream_options = { include_usage: true };
      if (req.tools && req.tools.length) {
        body.tools = req.tools;
        if (!skip('tool_choice')) body.tool_choice = 'auto';
        /* parallel_tool_calls is deliberately OMITTED (endpoint default: enabled). Forcing `false` predates the
           loop's concurrent dispatch path and cost one full round trip per tool on every multi-read turn; the
           host's parallelSafe predicate already keeps mutating/stateful tools serial. Omitting the param also
           means an endpoint that 400s on it never sees it ('parallel_tool_calls' stays in DROPPABLE_PARAMS only
           for saved drop-state from older builds). */
      }
      // reasoning_effort goes on the wire only when the model provably reasons (catalog) or the provider
      // profile documents the param; effort 'none' means omit it entirely.
      const effort = wireEffort(req.reasoningEffort || defaultEffort);
      if (effort && !skip('reasoning_effort')) {
        const m = findModel(req.model);
        const modelReasons = !!(m && (m.supportsReasoning === true || (Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length)));
        if (modelReasons || sendReasoningEffort) body.reasoning_effort = effort;
      }
      let res;
      try { res = await requestWithRetry(body, req.signal); }
      catch (e) { if (isAbort(e, req.signal)) return; throw e; }
      const reader = timeouts.idleGuardedReader(res.body.getReader(), { signal: req.signal });
      const dec = new TextDecoder();
      let buf = '';
      const started = {};
      // Index bookkeeping for servers that omit tool_calls[].index (every non-streamed choice.message,
      // and some streaming servers, e.g. Mistral). Collapsing them all to 0 concatenated the argument
      // strings of PARALLEL calls into one corrupt call; assign instead a stable index per call id —
      // or the next free slot when the id is also absent.
      const idxById = {};
      const lastIdxByName = {};   // name -> the most recent slot opened for that name (id/index-less servers)
      const argsAcc = {};         // idx -> accumulated raw args, so completeness can arbitrate name repeats
      let nextIdx = 0;
      const argsComplete = (s) => { if (!s) return false; try { JSON.parse(s); return true; } catch (_) { return false; } };
      function callIndex(tc) {
        if (tc.index != null) { if (tc.index >= nextIdx) nextIdx = tc.index + 1; return tc.index; }
        const id = tc.id ? String(tc.id) : '';
        if (id) { if (idxById[id] == null) idxById[id] = nextIdx++; return idxById[id]; }
        const fn = tc.function || {};
        if (fn.name) {
          /* An id/index-less delta bearing a NAME is ambiguous between "a new call" and "a continuation
             that echoes the name on every delta" (several vLLM/Ollama/LiteLLM builds do the latter —
             review pass: treating every name as a new call split ONE call into N invalid fragments).
             Arbitrate by the current same-name slot's ARGS: still-incomplete JSON -> this delta continues
             it; complete (or no prior slot) -> a genuinely new call opens its own slot. */
          const prior = lastIdxByName[fn.name];
          if (prior != null && !argsComplete(argsAcc[prior])) return prior;
          const idx = nextIdx++;
          lastIdxByName[fn.name] = idx;
          return idx;
        }
        // a bare argument chunk (no name either) continues the current slot
        return nextIdx > 0 ? nextIdx - 1 : 0;
      }
      let doneEmitted = false;   // exactly one terminal event per stream (see STREAM-END TRUTH below)

      function parseLine(line) {
        const t = line.replace(/\r$/, '').trim();
        if (!t || t.charAt(0) === ':') return null;
        if (t.indexOf('data:') !== 0) return null;
        const data = t.slice(5).trim();
        if (data === '[DONE]') return { done: true };
        try { return { json: JSON.parse(data) }; } catch (_) { return null; }
      }
      function* emitFrom(j) {
        if (j.error) throw new Error((j.error && (j.error.message || j.error.code)) || 'provider stream error');
        if (j.usage) yield { type: 'usage', usage: j.usage };
        const choice = j.choices && j.choices[0];
        if (!choice) return;
        const d = choice.delta || choice.message || {};
        if (typeof d.content === 'string' && d.content) yield { type: 'text', delta: d.content };
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const idx = callIndex(tc);
            const fn = tc.function || {};
            if (!started[idx] && (tc.id || fn.name)) {
              started[idx] = true;
              yield { type: 'tool_start', index: idx, id: tc.id || ('call_' + idx), name: fn.name || '' };
            }
            if (typeof fn.arguments === 'string' && fn.arguments) { argsAcc[idx] = (argsAcc[idx] || '') + fn.arguments; yield { type: 'tool_args', index: idx, chunk: fn.arguments }; }
          }
        }
        if (choice.finish_reason && !doneEmitted) {
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
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            const p = parseLine(line);
            if (!p) continue;
            if (p.done) { sawSentinel = true; break; }
            yield* emitFrom(p.json);
          }
        }
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
        // $0 delivery. Requiring only ONE of the two signals keeps this correct for the local OpenAI-compatible
        // servers (Ollama, LM Studio) that send a finish_reason but omit the sentinel.
        if (!doneEmitted) yield { type: 'done', finishReason: null, truncated: !sawSentinel };
      } catch (e) {
        if (isAbort(e, req.signal)) return;
        throw e;
      }
    }

    async function requestWithRetry(body, signal) {
      for (let attempt = 0; ; attempt++) {
        if (signal && signal.aborted) throw abortError();
        let res;
        // Fresh connect guard per attempt; disarmed the instant the fetch settles so the ceiling can't abort
        // the streaming body (a connect expiry rejects as a `timeout`, a user-cancel as AbortError).
        const guard = timeouts.connectGuard(signal, connectTimeoutMs);
        try {
          res = await doFetch(baseUrl + chatPath, {
            method: 'POST',
            headers: headerBag(key, opts.headers),
            body: JSON.stringify(body),
            signal: guard.signal
          });
        } catch (e) {
          if (isAbort(e, signal)) throw e;
          if (attempt < RETRY_DELAYS.length) { await delay(RETRY_DELAYS[attempt], signal); continue; }
          throw provider.runtime.markPreStreamRetriesExhausted(e);
        } finally {
          guard.disarm();
        }
        if (res.ok && res.body) return res;
        const upstreamError = await responseErrorDetail(res);
        let detail = upstreamError.detail;
        // Compatibility self-heal: providers behind the "OpenAI-compatible" label reject different optional
        // params. Strip the named param and retry immediately (remembered per model, so later turns in the
        // run never pay the extra round-trip). Does not consume a transient-retry attempt.
        if (dropUnsupportedParam(body, res.status, detail)) { attempt--; continue; }
        // A vendor API rejecting a slash-prefixed id as an unknown/invalid model means a ROUTED-catalog id
        // (StarNet managed / OpenRouter, e.g. "openai/gpt-…") reached a direct vendor endpoint. Without this
        // line the user sees only the vendor's bare "invalid model ID" and has no path back (2026-08-25
        // stranded-user incident) — name the mismatch and the fix. Slash-native catalogs (together, fireworks,
        // groq) are safe: their ids resolve on their own endpoints, so this only fires on a real mismatch.
        if ((res.status === 400 || res.status === 404)
          && /invalid model|is not a valid model|model .*(does not exist|not found)/i.test(String(detail))
          && String(body.model || '').indexOf('/') > 0) {
          detail += ' — "' + body.model + '" is a routed-catalog model id (vendor/model), but this provider calls the vendor API directly. Switch the provider in the model picker (STARNET or OPENROUTER for routed ids), or pick a model from this provider\'s own catalog.';
        }
        const err = new Error(errLabel + ' http ' + res.status + ' - ' + detail);
        err.status = res.status;
        err.headers = res.headers;
        err.requestId = upstreamError.requestId;
        err.providerCode = upstreamError.code;
        err.upstreamProvider = upstreamError.providerName;
        const cls = classifyApiError(err, { model: body.model });
        err.transient = cls.retryable;
        if (cls.retryable && attempt < RETRY_DELAYS.length) { await delay(Math.min(60000, Math.max(RETRY_DELAYS[attempt], cls.retryAfterMs || 0)), signal); continue; }
        throw cls.retryable ? provider.runtime.markPreStreamRetriesExhausted(err) : err;
      }
    }

    async function loadCatalog() {
      // ONLY a NON-EMPTY catalog is a cache hit. A failed boot probe stores [], which is TRUTHY — so this
      // returned the empty array forever and maybeRewarmCatalog(), added precisely because "an empty catalog
      // stays empty forever", could never re-fetch through it. One offline launch then permanently zeroed
      // priceOf() (every turn 'unpriced' -> the ledger records $0 and the day/global caps never fire) and
      // contextLimit() (no auto-compaction threshold). openrouter.js has always had this guard.
      if (catalog && catalog.length) return catalog;
      if (!catalogPromise) {
        catalogPromise = (async () => {
          try {
            // Extra wire headers (e.g. kimi's X-Msh-* device signature) must ride the /models probe too, or the
            // catalog endpoint rejects it and the connect screen is needlessly empty. Auth header layers on top.
            const catHeaders = Object.assign({}, opts.headers || {});
            if (key) catHeaders.Authorization = 'Bearer ' + key;
            const res = await doFetch(baseUrl + modelsPath, { headers: catHeaders });
            if (!res.ok) return [];
            const j = await res.json();
            const raw = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : []);
            return raw.map(normalizeModel).filter(Boolean);
          } catch (_) { return []; }
        })();
      }
      catalog = await catalogPromise;
      if (!catalog.length) {
        catalogPromise = null;
        if (staticModels.length) catalog = staticModels.slice();
      }
      return catalog;
    }
    // A model the wire left unpriced gets the list-rate pricing block the same way anthropic.js publishes it,
    // so the connect screen and priceOf() can never disagree about what a turn will cost.
    async function listModels() {
      return (await loadCatalog()).map(m => {
        const copy = Object.assign({}, m);
        if (!copy.pricing && priceFamily && listPrices && typeof listPrices.pricingBlock === 'function') copy.pricing = listPrices.pricingBlock(priceFamily, copy.id);
        return copy;
      });
    }
    function findModel(id) { return catalog ? catalog.find(m => m.id === id) : null; }
    function contextLimit(id) { const m = findModel(id); return (m && m.context_length) || defaultContext; }
    function catalogPriceOf(id) {
      const m = findModel(id);
      if (!m || !m.pricing) return null;
      const i = parseFloat(m.pricing.prompt) * 1e6, o = parseFloat(m.pricing.completion) * 1e6;
      return (isFinite(i) && isFinite(o)) ? { in: i, out: o } : null;
    }
    // catalog pricing (the wire said so) -> list-rate table for the profile's family -> null (honest 'unpriced')
    function priceOf(id) {
      const fromCatalog = catalogPriceOf(id);
      if (fromCatalog) return fromCatalog;
      if (priceFamily && listPrices) return listPrices.priceOf(priceFamily, id);
      return null;
    }
    // Catalog capability wins when it exists; otherwise fall back to the provider profile's assertion
    // (e.g. Perplexity documents no function calling). null = genuinely unknown, never a guess.
    function supportsTools(id) {
      const m = findModel(id);
      if (m && typeof m.supportsTools === 'boolean') return m.supportsTools;
      return profileSupportsTools;
    }
    function reasoningEfforts(id) {
      const m = findModel(id);
      if (m && Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length) return m.reasoningEfforts.slice();
      if ((m && m.supportsReasoning === true) || sendReasoningEffort) return ['none'].concat(WIRE_EFFORTS);
      return ['none'];
    }

    return { stream, listModels, contextLimit, priceOf, supportsTools, reasoningEfforts };
  }

  return { makeOpenAICompatibleProvider, _internals: { normalizeModel, cleanBaseUrl, responseErrorDetail, safeErrorField } };
});
