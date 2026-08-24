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
  const DEFAULT_BASE = 'https://api.openai.com/v1';
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

  function cleanBaseUrl(value) {
    return String(value || DEFAULT_BASE).trim().replace(/\/+$/, '');
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
    const chatPath = cleanPath(opts.chatPath, '/chat/completions');
    const modelsPath = cleanPath(opts.modelsPath, '/models');
    // Usage reporting defaults ON: streams must report token usage so cost accounting and
    // context compaction work. Callers may opt out with an explicit includeUsage: false.
    const includeUsage = opts.includeUsage !== false;
    const defaultContext = Number(opts.defaultContext || 0) || 0;
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
      const body = { model: req.model, messages: req.messages || [], stream: true };
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
            const idx = tc.index != null ? tc.index : 0;
            const fn = tc.function || {};
            if (!started[idx] && (tc.id || fn.name)) {
              started[idx] = true;
              yield { type: 'tool_start', index: idx, id: tc.id || ('call_' + idx), name: fn.name || '' };
            }
            if (typeof fn.arguments === 'string' && fn.arguments) yield { type: 'tool_args', index: idx, chunk: fn.arguments };
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
        const guard = timeouts.connectGuard(signal);
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
        let detail = res.statusText || '';
        try { const j = await res.json(); detail = (j && j.error && (j.error.message || j.error.code)) || JSON.stringify(j); }
        catch (_) { try { detail = (await res.text()).slice(0, 300); } catch (_) {} }
        // Compatibility self-heal: providers behind the "OpenAI-compatible" label reject different optional
        // params. Strip the named param and retry immediately (remembered per model, so later turns in the
        // run never pay the extra round-trip). Does not consume a transient-retry attempt.
        if (dropUnsupportedParam(body, res.status, detail)) { attempt--; continue; }
        const err = new Error(errLabel + ' http ' + res.status + ' - ' + detail);
        err.status = res.status;
        err.headers = res.headers;
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

  return { makeOpenAICompatibleProvider, _internals: { normalizeModel, cleanBaseUrl } };
});
