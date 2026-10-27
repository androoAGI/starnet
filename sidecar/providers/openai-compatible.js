/* sidecar/providers/openai-compatible.js - generic OpenAI-compatible chat/completions adapter.
   Used for OpenAI API, local Ollama/vLLM/LM Studio, and user-supplied custom /v1 endpoints.
   It implements the same LLMProvider seam as OpenRouter and Codex. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./provider.js'), require('./errorClass.js'), require('./prices.js'), require('./toolschema.js'), require('./ollama-native.js'));
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.openaiCompatible = factory(root.SK.providers.provider, root.SK.providers.errorClass, root.SK.providers.prices, root.SK.providers.toolschema, root.SK.providers.ollamaNative); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provider, errorClass, prices, toolschema, ollamaNative) {
  'use strict';

  const normalizeFinish = provider.normalizeFinish;
  const { note: failNote } = (typeof require === 'function') ? require('../failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };
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
  const DROPPABLE_PARAMS = ['stream_options', 'parallel_tool_calls', 'tool_choice', 'reasoning_effort', 'max_tokens'];
  // A provider may name a param in its OWN spelling. xAI refuses an effort a model cannot take with "Model
  // grok-4-1-fast does not support parameter reasoningEffort." (camelCase) or "Invalid reasoning effort" (spaced);
  // matching only the snake_case name let that 400 kill the run instead of retrying without the optional field.
  const PARAM_ALIASES = { reasoning_effort: ['reasoningeffort', 'reasoning effort', 'reasoning.effort'] };
  function paramNamed(text, param) {
    if (text.indexOf(param) >= 0) return true;
    return (PARAM_ALIASES[param] || []).some(alias => text.indexOf(alias) >= 0);
  }
  // The chat-completions wire accepts this effort scale; StarNet's wider scale (xhigh/max) clamps into it.
  const WIRE_EFFORTS = ['minimal', 'low', 'medium', 'high'];
  function wireEffort(value) {
    const v = String(value || '').trim().toLowerCase();
    if (!v || v === 'none' || v === 'off') return '';
    if (v === 'xhigh' || v === 'max' || v === 'extrahigh') return 'high';
    if (v === 'min') return 'minimal';
    return WIRE_EFFORTS.indexOf(v) >= 0 ? v : 'medium';
  }
  /* PROVIDER-DECLARED EFFORTS (2026-09-27, Grok user report: "none of my grok models have reasoning on").
     Some catalogs state exactly which reasoning levels each model takes: xAI's /v1/models carries
     `capabilities.reasoning_effort` (e.g. ["low","medium","high","xhigh"]) and `capabilities.default_reasoning_effort`.
     That list, not the generic wire scale above, is the truth for that model. It can include xhigh (which
     wireEffort folds to high) and it can omit OFF (grok-4.5+ cannot stop reasoning). A model whose entry declares
     capabilities but no levels has no dial at all: sending the param there is a 400. A catalog that says nothing
     about a model keeps the generic behaviour. */
  const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  function canonicalEffort(value) {
    const v = String(value == null ? '' : value).trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (!v) return '';
    if (v === 'off' || v === 'no' || v === 'disabled') return 'none';
    if (v === 'min') return 'minimal';
    if (v === 'med' || v === 'mid') return 'medium';
    if (v === 'extra' || v === 'xtra' || v === 'extrahigh') return 'xhigh';
    return EFFORT_ORDER.indexOf(v) >= 0 ? v : '';   // a level StarNet has no name for is dropped, never coerced
  }
  function declaredEffortList(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const v of raw) { const e = canonicalEffort(v); if (e && out.indexOf(e) < 0) out.push(e); }
    return out.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  }
  // Send a level the model DECLARED. The request itself when it is one. Past either end of the model's range: that
  // end (max on a model topping out at xhigh -> xhigh). Inside the range but not a level of it: the model's own
  // declared default when it has one — the way vendors map it themselves (DeepSeek: medium -> high, xhigh -> high)
  // — else the nearest weaker level. OFF the model does not offer is omitted (its own default applies) rather than
  // replaced by an invented level; a model whose ONLY declared value is 'none' gets 'none' explicitly (gpt-5.6 with
  // tools on Chat Completions: omitting it means its default, medium, and that 400s). '' = send nothing.
  function clampToDeclared(requested, declared, defaultLevel) {
    const want = canonicalEffort(requested);
    if (!want || !declared || !declared.length) return '';
    if (declared.indexOf(want) >= 0) return want;
    const levels = declared.filter(e => e !== 'none').map(e => EFFORT_ORDER.indexOf(e));
    if (want !== 'none' && levels.length) {
      const at = EFFORT_ORDER.indexOf(want), lo = Math.min.apply(null, levels), hi = Math.max.apply(null, levels);
      if (at < lo) return EFFORT_ORDER[lo];
      if (at > hi) return EFFORT_ORDER[hi];
      const def = canonicalEffort(defaultLevel);
      if (def && def !== 'none' && declared.indexOf(def) >= 0) return def;
      for (let i = at - 1; i >= lo; i--) if (declared.indexOf(EFFORT_ORDER[i]) >= 0) return EFFORT_ORDER[i];
    }
    return (declared.length === 1 && declared[0] === 'none') ? 'none' : '';
  }
  /* OpenAI names what a model DOES take when it refuses a level: "Unsupported value: 'reasoning_effort' does not
     support 'minimal' with this model. Supported values are: 'low', 'medium', and 'high'." That sentence is the
     endpoint's own truth, newer than any table, so it is learned (see learnedByEndpoint) and the request resent. */
  function supportedEffortsFrom(detail) {
    const text = String(detail || '');
    if (!/reasoning[_ .]?effort/i.test(text)) return null;
    const m = text.match(/supported values are:?\s*([^.\n]*)/i);
    if (!m) return null;
    const list = declaredEffortList((m[1].match(/'[^']+'|"[^"]+"/g) || []).map(s => s.slice(1, -1)));
    return (list && list.length) ? list : null;
  }
  // "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function
  // tools, use /v1/responses or set reasoning_effort to 'none'." With tools on this wire that model takes ONLY none,
  // and the refusal comes even when no effort was sent (its default is medium).
  function toolsForceNone(detail) {
    return /function tools with reasoning[_ ]effort are not supported/i.test(String(detail || ''));
  }
  // Declared levels outlive one adapter instance. A run builds a fresh provider, and its first request leaves
  // before that instance's own catalog arrives. The catalog the model dock already loaded from the SAME endpoint
  // is what lets that first request send the declared level instead of guessing. Capability facts only
  // (endpoint -> model id -> levels): no key or token is ever stored here. The newest catalog load wins.
  const declaredByEndpoint = new Map();
  function rememberDeclared(endpoint, models) {
    const byId = new Map();
    for (const m of models) {
      if (m && m.reasoningEffortsDeclared) byId.set(m.id, { levels: m.reasoningEfforts.slice(), defaultLevel: m.defaultReasoningLevel || null });
    }
    declaredByEndpoint.set(endpoint, byId);   // a fresh load REPLACES the endpoint's facts (nothing stale survives)
  }
  function recallDeclared(endpoint, id) {
    const byId = declaredByEndpoint.get(endpoint);
    const hit = byId && byId.get(String(id || ''));
    return hit ? { levels: hit.levels.slice(), defaultLevel: hit.defaultLevel } : null;
  }
  // The largest window each Ollama model has been run at in this PROCESS (endpoint -> model -> num_ctx). A run builds
  // a fresh provider, so a per-instance record forgot it between runs: a greeting after a task reloaded the model at
  // 8k and the next task reloaded it back to 32k, seconds each way. Every distinct num_ctx is a reload, so a model
  // never steps down here once it has run larger.
  const ollamaWindows = new Map();
  function ollamaWindow(endpoint, model) { const m = ollamaWindows.get(endpoint); return (m && m.get(String(model || ''))) || 0; }
  function noteOllamaWindow(endpoint, model, numCtx) {
    let m = ollamaWindows.get(endpoint);
    if (!m) { m = new Map(); ollamaWindows.set(endpoint, m); }
    const id = String(model || '');
    if (numCtx > (m.get(id) || 0)) m.set(id, numCtx);
  }
  // ...except when holding that window is what is hurting: a model /api/ps shows spilling to the CPU is let back down
  // to a smaller window (a 4B model kept at 64k for 16 h sat 50% on the CPU and timed out on a 17k prompt, 10-25).
  function lowerOllamaWindow(endpoint, model, numCtx) {
    const m = ollamaWindows.get(endpoint);
    const id = String(model || '');
    if (m && numCtx < (m.get(id) || 0)) m.set(id, numCtx);
  }
  // The window Ollama's own exceed_context_size refusal proved a task needs, per model (endpoint -> model -> num_ctx).
  // The step-down sizes from the chars/4 estimate, which a dense prompt (digit-heavy logs, CJK) beats: without this
  // record every task turn stepped down, was refused and resized back up — two reloads and a lost KV cache a turn.
  const ollamaProven = new Map();
  function provenOllamaWindow(endpoint, model) { const m = ollamaProven.get(endpoint); return (m && m.get(String(model || ''))) || 0; }
  function noteProvenOllamaWindow(endpoint, model, numCtx) {
    let m = ollamaProven.get(endpoint);
    if (!m) { m = new Map(); ollamaProven.set(endpoint, m); }
    const id = String(model || '');
    if (numCtx > (m.get(id) || 0)) m.set(id, numCtx);
  }
  /* The native Ollama calls this PROCESS has open, per server (native root -> Set of { background }): open from the moment
     a stream starts until it ends. A local Ollama often serves one request at a time, and the host's own background calls
     (quest refresh at boot, post-task reflection) run with no Commander watching; a Commander turn's wait note says how
     many are open there (#99, live: the boot quest call was still open when the first "hello" went out). */
  const ollamaOpen = new Map();
  function openOllamaCall(endpoint, entry) {
    let calls = ollamaOpen.get(endpoint);
    if (!calls) { calls = new Set(); ollamaOpen.set(endpoint, calls); }
    calls.add(entry);
    return () => { calls.delete(entry); };
  }
  function otherOllamaCalls(endpoint, self) {
    let n = 0, background = 0;
    for (const e of ollamaOpen.get(endpoint) || []) if (e !== self) { n++; if (e.background) background++; }
    return { n, background };
  }
  // What an endpoint TOLD us at request time outranks every catalog and table, and a catalog reload never erases it.
  const learnedByEndpoint = new Map();   // endpoint -> Map(modelId -> levels)
  function rememberLearned(endpoint, id, levels) {
    let byId = learnedByEndpoint.get(endpoint);
    if (!byId) { byId = new Map(); learnedByEndpoint.set(endpoint, byId); }
    byId.set(String(id || ''), levels.slice());
  }
  function recallLearned(endpoint, id) {
    const byId = learnedByEndpoint.get(endpoint);
    const hit = byId && byId.get(String(id || ''));
    return hit ? hit.slice() : null;
  }
  // Models this endpoint has been SEEN streaming reasoning_content for (DeepSeek thinking mode). Proof a model
  // thinks even when its catalog entry declares nothing (the legacy deepseek-reasoner alias).
  const reasoningEmitters = new Map();   // endpoint -> Set(modelId)
  function noteEmitter(endpoint, id) {
    let ids = reasoningEmitters.get(endpoint);
    if (!ids) { ids = new Set(); reasoningEmitters.set(endpoint, ids); }
    ids.add(String(id || ''));
  }
  function emitsReasoning(endpoint, id) {
    const ids = reasoningEmitters.get(endpoint);
    return !!(ids && ids.has(String(id || '')));
  }
  /* REASONING_CONTENT RIDES BACK (DeepSeek thinking mode, api-docs.deepseek.com/guides/thinking_mode, 2026-09).
     "For requests carrying the tools parameter, the reasoning_content must be fully passed back to the API in all
     subsequent requests — even for turns where the model did not perform a tool call", else 400 "The
     reasoning_content in the thinking mode must be passed back to the API". Every StarNet run carries tools, so a
     V4 model thinking by default (high) failed on its second request. The adapter parks each turn's text as an
     opaque { type:'reasoning_content' } block on the turn (provider.js contract) and hands it back here. A turn
     with no captured text (history the page kept, a sidecar restart) gets '' — the shape the fix other harnesses
     shipped (Hermes, OpenCode). StarNet's own `reasoning` parking field never rides the wire. */
  function reasoningTextOf(blocks) {
    if (!Array.isArray(blocks)) return null;
    let text = null;
    for (const b of blocks) if (b && b.type === 'reasoning_content' && typeof b.text === 'string') text = (text || '') + b.text;
    return text;
  }
  function replayReasoningContent(messages, thinking, withTools) {
    if (!Array.isArray(messages)) return messages;
    let changed = false;
    const out = messages.map(msg => {
      if (!msg || msg.role !== 'assistant') return msg;
      const text = reasoningTextOf(msg.reasoning);
      const owed = thinking && (text != null || withTools);
      if (msg.reasoning === undefined && !owed && msg.reasoning_content === undefined) return msg;
      const copy = Object.assign({}, msg);   // never mutate the durable transcript
      delete copy.reasoning;
      if (!thinking) delete copy.reasoning_content;
      else if (owed && copy.reasoning_content == null) copy.reasoning_content = text != null ? text : '';
      changed = true;
      return copy;
    });
    return changed ? out : messages;
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
  // The redactor and the error-body reader are shared with every adapter (provider.js runtime).
  const safeErrorField = provider.runtime.safeErrorField;
  function responseHeader(res, names) {
    if (!res || !res.headers || typeof res.headers.get !== 'function') return '';
    for (const name of names) {
      const value = safeErrorField(res.headers.get(name), 120);
      if (value) return value;
    }
    return '';
  }
  async function responseErrorDetail(res, signal, url) {
    // Error headers disarm the connect guard too. An unfinished error body must retain the same idle watchdog and
    // caller cancellation as a successful stream, including local loads: provider.runtime.readErrorBody does both,
    // reads at most MAX_ERR_BODY (500 characters are kept, so a proxy's endless HTML page is cut off).
    const eb = await provider.runtime.readErrorBody(res, { signal, url, tag: 'providers.openai_compatible' });
    const data = eb.parsed ? eb.data : null;
    const text = eb.text;
    const bodyStalled = eb.stalled;
    const e = data && data.error;
    const message = safeErrorField((e && e.message) || (data && data.message) || text || res.statusText || ('HTTP ' + res.status), 500)
      + (bodyStalled ? ' (error body did not finish)' : '');
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
    return { detail: (facts.length ? '[' + facts.join('; ') + '] ' : '') + message, type, code, providerName, requestId, body: (data && typeof data === 'object') ? data : null };
  }
  /* The window a /models row REPORTS, under each spelling a server uses: context_length (OpenRouter, the managed proxy,
     Kimi), context_window (Groq, DeepSeek), max_context_window, max_model_len (vLLM/SGLang: the window it SERVES),
     max_input_tokens, max_context_length (Mistral). LM Studio's own rows carry max_context_length too, but there it is
     the model's trained maximum, not the window LM Studio loaded it at (often 4096): such a row reads only its
     loaded_context_length, and an unloaded model stays unknown. llama.cpp's meta.n_ctx_train is a trained maximum as
     well, so it is never read. 0 = the row reports no window; a window is never invented here. */
  function reportedWindow(m) {
    const lmStudio = m.loaded_context_length != null || ('state' in m && ('quantization' in m || 'arch' in m || 'compatibility_type' in m));
    const n = Number(m.context_length || m.context_window || m.max_context_window || m.max_model_len || m.max_input_tokens
      || (lmStudio ? m.loaded_context_length : m.max_context_length) || 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  function normalizeModel(m) {
    const id = (m && (m.id || m.name || m.model)) ? String(m.id || m.name || m.model) : '';
    if (!id) return null;
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters.slice() : [];
    // Declared levels: StarNet's own non-empty `reasoningEfforts` (static rosters, the managed proxy), else a
    // vendor block — xAI `capabilities.reasoning_effort` / `default_reasoning_effort`, DeepSeek
    // `effort.supported_levels` / `default_level` (api-docs.deepseek.com, GET /models). An xAI entry that carries
    // capabilities but no levels is a DECLARED "no dial" ([]). An empty StarNet list keeps its old meaning (unknown).
    const caps = (m.capabilities && typeof m.capabilities === 'object' && !Array.isArray(m.capabilities)) ? m.capabilities : null;
    // Only an xAI-shaped block declares the dial: one that names reasoning levels, xAI's empty no-dial `{}`, or an
    // xAI-owned entry. Other vendors publish capability blocks too (Mistral: completion_chat, function_calling, ...)
    // that say nothing about reasoning; reading those as "no dial" silently dropped their reasoning_effort.
    const capsDeclare = !!caps && ('reasoning_effort' in caps || 'default_reasoning_effort' in caps
      || Object.keys(caps).length === 0 || String(m.owned_by || '').toLowerCase() === 'xai');
    const effortBlock = (m.effort && typeof m.effort === 'object' && Array.isArray(m.effort.supported_levels)) ? m.effort : null;
    const own = declaredEffortList(m.reasoningEfforts);
    const declared = (own && own.length) ? own
      : capsDeclare ? (declaredEffortList(caps.reasoning_effort) || [])
      : effortBlock ? declaredEffortList(effortBlock.supported_levels)
      : null;
    const defaultLevel = canonicalEffort(m.defaultReasoningLevel || (caps && caps.default_reasoning_effort) || (effortBlock && effortBlock.default_level));
    return {
      id,
      name: m.name || id,
      context_length: reportedWindow(m),
      // an OpenRouter-shaped list (the StarNet proxy relays OpenRouter's) names it under top_provider
      max_completion_tokens: Number(m.max_completion_tokens || m.max_output_tokens || (m.top_provider && m.top_provider.max_completion_tokens) || 0) || null,
      pricing: m.pricing || null,
      supported_parameters: params,
      supportsTools: typeof m.supportsTools === 'boolean' ? m.supportsTools : (params.length ? params.indexOf('tools') >= 0 : null),
      // A declared dial proves the model reasons. No dial proves nothing either way (a model can reason with no
      // dial), so that stays null. Unknown is never flattened to false.
      supportsReasoning: typeof m.supportsReasoning === 'boolean' ? m.supportsReasoning : ((declared && declared.some(e => e !== 'none')) ? true : null),
      reasoningEfforts: declared ? declared : (Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts.slice() : []),
      reasoningEffortsDeclared: !!declared,
      defaultReasoningLevel: (defaultLevel && declared && declared.indexOf(defaultLevel) >= 0) ? defaultLevel : null,
      // image input as the row states it (the StarNet managed list relays OpenRouter's architecture.input_modalities);
      // null when the row says nothing, which is every vendor /v1/models list — those keep sending images as before
      supportsImages: provider.imageInputOf(m)
    };
  }

  /* One tool-call slot's accumulated argument text, and the one question the stream asks of it: would it JSON.parse
     yet? (callIndex below arbitrates a name-echoing delta by it.) That question used to be a JSON.parse of the WHOLE
     accumulated string on every delta: quadratic, on the sidecar's main thread — a 100 KB fs_write in 16-char deltas
     parsed ~330 M characters. The tracker follows bracket depth and string state per byte as it arrives, so an
     object or array that is provably still open (depth > 0, or inside a string) answers false without parsing; only
     a top-level close runs JSON.parse, memoised by length. Text that does not open with '{' or '[' keeps the old
     parse-every-time answer. The answer is exactly the old one: anything that parses and opens with '{' or '[' ends at
     depth 0 outside a string. */
  function makeArgsTracker() {
    let acc = '', mode = '', depth = 0, inStr = false, esc = false, memoLen = -1, memo = false;
    function feed(chunk) {
      const s = String(chunk || '');
      acc += s;
      if (mode === 'legacy') return;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (!mode) {
          if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;   // JSON's own whitespace
          if (ch !== '{' && ch !== '[') { mode = 'legacy'; return; }
          mode = 'struct';
        }
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') depth--;
      }
    }
    function complete() {
      if (!acc) return false;
      if (mode === 'struct' && (depth !== 0 || inStr)) return false;   // provably not parseable yet: no O(n) parse
      if (memoLen !== acc.length) {
        memoLen = acc.length;
        try { JSON.parse(acc); memo = true; } catch (_) { memo = false; }
      }
      return memo;
    }
    return { feed, complete };
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
    // Prompt-cache breakpoints for an endpoint that relays to a cache_control-honoring backend (the managed proxy ->
    // OpenRouter): (messages, model, cacheSystemPrefix) -> messages. Absent = the body is byte-identical to before.
    const cacheControl = typeof opts.cacheControl === 'function' ? opts.cacheControl : null;
    // OUTPUT CEILING (2026-09-15, issue #17): this adapter never capped output, so an endpoint with no ceiling of
    // its own (Ollama) ran to end-of-sequence — a 3B local model typed for ten minutes. Off unless the PROFILE opts
    // in (factory: profile.maxOutputTokens) or the caller passes max_tokens explicitly; hosted endpoints that
    // reject the legacy param name still self-heal through DROPPABLE_PARAMS.
    const configuredMaxTokens = Number(opts.maxTokens);
    const maxTokens = Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0 ? Math.floor(configuredMaxTokens) : 0;
    const configuredChatTokens = Number(opts.maxChatTokens);
    const maxChatTokens = Number.isFinite(configuredChatTokens) && configuredChatTokens > 0 ? Math.floor(configuredChatTokens) : 0;
    // Error identity: HTTP failures name the PROVIDER when the factory supplies a label. A raw
    // "openai-compatible http 401" mid-run carried no provider identity, so the frontend's recovery
    // classifier couldn't route a dead grok/kimi sign-in to its ⏼ RECONNECT door — users got the
    // keyed-provider "＋ Add a key" door for a keyless subscription sign-in.
    const errLabel = String(opts.label || 'openai-compatible');
    // false = this endpoint's own ids may be vendor/model (CUSTOM, Ollama): no routed-catalog hint on a refused model (#126)
    const routedIdHint = opts.routedIdHint !== false;
    const profileSupportsTools = (typeof opts.supportsTools === 'boolean') ? opts.supportsTools : null;
    /* PRICE FAMILY (2026-08-21). OpenAI's /v1/models — and every vendor that clones it — carries NO pricing
       block, so priceOf() returned null on openai/xai/groq/mistral/deepseek/together/fireworks and cost.js
       priced every turn at $0: the per-run spend cap could never fire on any of them. The registry profile
       names the prices.js table to fall back to (null for ollama/custom/perplexity — genuinely unpriced, and
       the run stays honestly 'unpriced' there). Catalog pricing, when an endpoint DOES publish it, still wins. */
    const priceFamily = (typeof opts.priceFamily === 'string' && opts.priceFamily.trim()) ? opts.priceFamily.trim() : null;
    /* RUN ATTRIBUTION (2026-09-29). A profile that names a runIdHeader (only `starnet`: our own proxy) gets the
       harness run id of the calling run (req.runId) on every chat request, so the cloud ledger can tie each
       debit to the run that spent it. Off for every other profile: a run id is never sent to a third party. */
    const runIdHeader = (typeof opts.runIdHeader === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(opts.runIdHeader)) ? opts.runIdHeader : '';
    function requestHeaders(req) {
      if (!runIdHeader || !req || req.runId == null) return opts.headers;
      const runId = String(req.runId).replace(/[^\x21-\x7e]/g, '').slice(0, 128);   // a header value: printable ASCII only
      if (!runId) return opts.headers;
      return Object.assign({}, opts.headers || {}, { [runIdHeader]: runId });
    }
    const listPrices =(prices && typeof prices.priceOf === 'function') ? prices : null;
    const defaultEffort = String(opts.reasoningEffort || '');
    /* PROFILE-DOCUMENTED LEVELS (registry `reasoningModels`) for endpoints whose catalog publishes none — OpenAI's
       /v1/models carries only id/created/owned_by. First match wins; a model no rule matches stays unknown. A
       catalog declaration, when the endpoint makes one, still wins, and so does what the endpoint says at request
       time (learnedByEndpoint). */
    const reasoningRules = (Array.isArray(opts.reasoningModels) ? opts.reasoningModels : []).map(r => {
      if (!r || !r.match) return null;
      let re; try { re = r.match instanceof RegExp ? r.match : new RegExp(String(r.match), 'i'); } catch (_) { return null; }
      return { re, efforts: declaredEffortList(r.efforts) || [], defaultLevel: canonicalEffort(r.default),
        supportsReasoning: typeof r.supportsReasoning === 'boolean' ? r.supportsReasoning : null,
        note: (typeof r.note === 'string' && r.note) ? r.note : null };
    }).filter(Boolean);
    function ruleFor(id) { const s = String(id || ''); return reasoningRules.find(r => r.re.test(s)) || null; }
    // OFF that an endpoint documents OUTSIDE its declared lists: DeepSeek's catalog lists low/high/max, and its API
    // reference adds that reasoning_effort 'none' disables thinking. Only 'none' is meaningful here.
    const offEffort = canonicalEffort(opts.reasoningOffEffort) === 'none' ? 'none' : '';
    function withOff(list) { return (offEffort && list.length && list.indexOf(offEffort) < 0) ? [offEffort].concat(list) : list; }
    // Opt-in (registry `replayReasoningContent`): capture streamed reasoning_content and hand it back next request.
    const replayReasoning = opts.replayReasoningContent === true;
    function declare(m) {
      if (!m) return m;
      if (!m.reasoningEffortsDeclared) {
        const r = ruleFor(m.id);
        if (r) {
          m.reasoningEfforts = r.efforts.slice();
          m.reasoningEffortsDeclared = true;
          if (r.defaultLevel && r.efforts.indexOf(r.defaultLevel) >= 0) m.defaultReasoningLevel = r.defaultLevel;
          if (r.supportsReasoning !== null) m.supportsReasoning = r.supportsReasoning;
          else if (m.supportsReasoning == null && r.efforts.some(e => e !== 'none')) m.supportsReasoning = true;
          if (r.note) m.reasoningNote = r.note;
        }
      }
      if (m.reasoningEffortsDeclared) m.reasoningEfforts = withOff(m.reasoningEfforts);
      return m;
    }
    // Static catalog fallback for endpoints with no usable /models (e.g. Perplexity, whose
    // /v1/models lists Agent-API models, not its chat-completions roster). Used only when the
    // live endpoint yields nothing — a real catalog always wins.
    const staticModels = Array.isArray(opts.staticModels) ? opts.staticModels.map(normalizeModel).filter(Boolean).map(declare) : [];
    const droppedParams = new Map();   // model -> Set(param) learned from unsupported-param 400s
    /* OLLAMA NATIVE WIRE (profile `nativeOllama`, see ollama-native.js for the measured why). Chat goes to the
       server's own /api/chat with a window sized to the request; /v1/models stays the catalog. `nativeWire` turns
       off for this instance if the endpoint turns out to have no /api/chat (a proxy that only speaks /v1), and the
       run continues on the /v1 wire exactly as before. */
    let nativeWire = opts.nativeOllama === true && !!ollamaNative;
    const nativeBase = nativeWire ? ollamaNative.nativeRoot(baseUrl) : '';
    // Where the Ollama server runs, for its user-facing copy: loopback is "this computer", anything else is named.
    const ollamaHost = opts.nativeOllama === true ? provider.runtime.requestHostOf(baseUrl) : '';
    const ollamaIsLoopback = !ollamaHost || /^(?:localhost|.+\.localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[?::1\]?)$/i.test(ollamaHost);
    /* NOT AN OLLAMA SERVER (GH#111). LM Studio answers a route it does not serve with HTTP 200 and ONE JSON object,
       {"error":"Unexpected endpoint or method. (POST /api/chat)"}, so an OLLAMA card pointed at LM Studio read that 200
       as the native stream: a compact body surfaced the bare sentence (an `unknown` error, retried), a pretty-printed one
       an empty reply. Those words as the FIRST native object prove the URL is not Ollama (Ollama never answers its own
       route that way): the native wire goes off for this instance and the run is told which server it reached and which
       card speaks to it. Content-type is never consulted (Ollama proxies vary). Terminal, not retried: errorClass reads
       `endpointMismatch` as its own reason, so no retry ladder re-sends the turn into a silent /v1 success and hides
       the misconfiguration. That sentence is for the OLLAMA card only: a CUSTOM card that merely BORROWED the native
       wire on its URL's look (opts.nativeOllamaBorrowed) is already the right card, so wireStream re-asks /v1 instead. */
    const NOT_OLLAMA_RE = /unexpected endpoint or method/i;
    const NATIVE_LEFTOVER_MAX = 65536;   // bounded: only an error body that never parsed line by line is ever re-read
    const nativeBorrowed = opts.nativeOllamaBorrowed === true;
    /* host[:port] of the configured URL as a URL parser reads it (the port is what tells 1234 from 11434). URL.host never
       carries userinfo, even a password with a raw "@", so no credential reaches COMMS, history or pasted diagnostics. */
    const endpointHostPort = (() => { try { return new URL(String(baseUrl || '')).host || ''; } catch (_) { return ''; } })();
    function nativeErrorText(j) {
      if (!j || !j.error) return '';
      if (typeof j.error === 'string') return j.error;
      return String(j.error.message || j.error.code || '');
    }
    function notOllamaError(detail) {
      const err = new Error('The OLLAMA card\'s URL' + (endpointHostPort ? ' (' + endpointHostPort + ')' : '') + ' is not an Ollama server: '
        + 'it answered Ollama\'s chat request the way LM Studio does. Add that server under SETTINGS → AI & MODELS → CUSTOM '
        + 'with its /v1 URL instead. [' + detail + ']');
      err.ownMessage = true;
      err.endpointMismatch = true;
      err.body = { error: { message: detail } };
      return err;
    }
    const pinnedCtx = Math.max(0, Math.floor(Number(opts.numCtx) || 0));
    const ctxCeiling = Math.max(0, Math.floor(Number(opts.maxCtx) || 0)) || (ollamaNative ? ollamaNative.DEFAULT_MAX_CTX : 0);
    const modelFacts = new Map();      // model -> Promise<{ contextLength, supportsTools, supportsReasoning }>
    const knownFacts = new Map();      // model -> the settled facts, for the synchronous contextLimit()/supportsTools()
    /* SHARED CATALOG (providers/catalog-cache.js, attached by the factory). Without it this instance keeps its own list
       exactly as before. With it, the list this endpoint last answered for this credential (any instance: the model
       dock, an earlier run) and the windows any instance saw there answer this instance synchronously: a run is sized
       from the model's real window instead of a cold guess, and a fresh adapter no longer re-fetches /models (nor, on
       native Ollama, one /api/show per installed model) on its first stream. */
    const catalogCache = (opts.catalogCache && typeof opts.catalogCache.bind === 'function') ? opts.catalogCache : null;
    const shared = catalogCache ? catalogCache.bind({ scope: opts.catalogScope, endpoint: baseUrl, fetchList: sharedList }) : null;
    let adoptedVersion = 0;
    // The /api/show facts this process holds for a model, however old (synchronous): this instance's own read, else
    // the one another instance made of the same server.
    function heldFacts(model) {
      const id = String(model || '');
      const own = knownFacts.get(id);
      if (own) return own;
      const hit = (catalogCache && nativeBase) ? catalogCache.factOf('ollama-show', nativeBase, id) : null;
      return hit ? hit.value : null;
    }
    function factsFor(model) {
      const id = String(model || '');
      if (!nativeWire || !id) return Promise.resolve(null);
      if (!modelFacts.has(id)) {
        // the same server's facts another instance read inside the TTL: no second /api/show
        const held = catalogCache ? catalogCache.factOf('ollama-show', nativeBase, id) : null;
        if (held && !held.stale && held.value) {
          knownFacts.set(id, held.value);
          modelFacts.set(id, Promise.resolve(held.value));
          return modelFacts.get(id);
        }
        modelFacts.set(id, (async () => {
          const guard = timeouts.connectGuard(null, 5000);
          try {
            const res = await doFetch(nativeBase + '/api/show', { method: 'POST', headers: headerBag(key, opts.headers), body: JSON.stringify({ model: id }), signal: guard.signal });
            if (!res.ok) return null;
            return ollamaNative.showFacts(await res.json());
          } catch (_) { return null; }
          finally { guard.disarm(); }
        })().then(f => {
          if (f) { knownFacts.set(id, f); if (catalogCache) catalogCache.noteFact('ollama-show', nativeBase, id, f); }
          else modelFacts.delete(id);
          return f;
        }));
      }
      return modelFacts.get(id);
    }
    // /api/ps (what is loaded, where, at what window), or null when it cannot be read within 3s.
    async function ollamaStatus() {
      const guard = timeouts.connectGuard(null, 3000);
      try {
        const res = await doFetch(nativeBase + '/api/ps', { headers: headerBag(key, opts.headers), signal: guard.signal });
        return res.ok ? await res.json() : null;
      } catch (_) { return null; }
      finally { guard.disarm(); }
    }
    /* WAIT TRUTH (#99, reported on a 6 GB GTX 1660: COMMS sat on Working for 45-712 s until the user cancelled). Ollama
       sends no headers until its first token, so a model load or a long prompt read is one silent pending /api/chat. The
       placement facts below used to surface only in the error thrown at the 300 s connect ceiling — which the ladder
       retries, so the user cancelled first and never saw them. Now, once a native request has gone `waitNoteMs`
       unanswered, /api/ps is read (then again every 3x that) and the facts go to the caller as they change. */
    const waitNoteMs = Math.max(0, Math.floor(Number(opts.waitNoteMs) || 0));
    function waitProbe(body, onWait, self) {
      const promptTokens = ollamaNative.estimateTokens(body);
      const server = ollamaIsLoopback ? 'Ollama' : 'Ollama at ' + ollamaHost;
      let timer = null, stopped = false, last = '', missing = false;
      const arm = ms => { timer = setTimeout(read, ms); if (timer && typeof timer.unref === 'function') timer.unref(); };
      async function read() {
        timer = null;
        const ps = await ollamaStatus();
        if (ps && !ollamaNative.psRow(ps, body.model)) missing = true;   // a read that did not list the model (see sawMissing)
        if (stopped) return;
        const others = otherOllamaCalls(nativeBase, self);
        const note = ollamaNative.placementFacts(ps, body.model, promptTokens, server)
          + (others.n ? ' · ' + others.n + ' other StarNet call' + (others.n === 1 ? '' : 's') + ' still open there'
            + (others.background === others.n ? ' (background)' : others.background ? ' (' + others.background + ' background)' : '') : '');
        if (note !== last) { last = note; onWait({ phase: 'connect', note }); }
        arm(waitNoteMs * 3);
      }
      arm(waitNoteMs);
      return {
        stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
        // true once any read of this attempt answered without the model listed: it may have been loading during the wait
        sawMissing() { return missing; }
      };
    }
    // The window this model actually gets here: a pinned size, else min(its trained maximum, the ceiling).
    function usableWindow(modelMax) {
      if (pinnedCtx) return pinnedCtx;
      return modelMax > 0 ? Math.min(modelMax, ctxCeiling) : 0;
    }
    function applyFacts(m, f) {
      if (!m || !f) return;
      const win = usableWindow(f.contextLength);
      if (win) m.context_length = win;
      if (typeof f.supportsTools === 'boolean') m.supportsTools = f.supportsTools;
      if (f.supportsReasoning === true && m.supportsReasoning == null) m.supportsReasoning = true;
    }
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
        if (paramNamed(text, p)) { delete body[p]; rememberDrop(body.model, p); return p; }
      }
      return null;
    }

    // Non-blocking catalog re-warm: an empty catalog (boot-time /models failure) otherwise stays empty forever.
    // Throttled by the injected clock; no clock -> at most one kick per instance (determinism law: no Date.now).
    function maybeRewarmCatalog() {
      // a shared list: adopt the newest, and let the cache kick ONE background load when it is missing or past its TTL
      if (shared && shared.shared) { adoptShared(); shared.ensure(); return; }
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

    // A tool advertised under sanitized property keys gets its args mapped back to the declared names before
    // the loop sees them; with no such tool this is the raw stream itself.
    function stream(req) { return toolschema.withRestoredArgKeys(countedOllamaCall(wireStream(req), req), req && req.tools); }
    // Each native Ollama stream is one open call on its server (see ollamaOpen) until it ends, however it ends.
    const openCalls = new WeakMap();   // req -> its ollamaOpen entry, so its own wait note never counts itself
    async function* countedOllamaCall(inner, req) {
      if (!nativeWire || !req || typeof req !== 'object') { yield* inner; return; }
      const entry = { background: !(req.tools && req.tools.length) && typeof req.isTask !== 'boolean' };
      openCalls.set(req, entry);
      const close = openOllamaCall(nativeBase, entry);
      try { yield* inner; } finally { close(); }
    }

    /* A CUSTOM card's BORROWED native wire (GH#111 review): its URL only looked like Ollama, so a server that answers the
       native chat as a different server (notOllamaError, thrown on the FIRST native object, before this turn yielded
       anything) is StarNet's own wrong guess, and CUSTOM is already the card that speaks to it. nativeWire is off by
       then; the same turn goes once on the /v1 wire, the way the 404 path does, and a /v1 failure reports itself.
       Every other route streams wireStreamOnce untouched. */
    async function* wireStream(req) {
      if (!nativeBorrowed || !nativeWire) { yield* wireStreamOnce(req); return; }
      let yielded = false;
      try {
        for await (const ev of wireStreamOnce(req)) { if (ev.type !== 'waiting') yielded = true; yield ev; }   // a wait note is not the turn's output
      } catch (e) {
        if (yielded || nativeWire || !e || e.endpointMismatch !== true) throw e;
        failNote('providers.openai_compatible.custom_not_ollama', 'the CUSTOM endpoint at ' + endpointHostPort + ' looked like Ollama but is not (' + (e.body && e.body.error && e.body.error.message) + '): the turn moves to its /v1 wire');
        yield* wireStreamOnce(req);
      }
    }

    async function* wireStreamOnce(req) {
      req = req || {};
      maybeRewarmCatalog();
      const dropped = droppedParams.get(String(req.model || ''));
      const skip = p => !!(dropped && dropped.has(p));
      // A model the catalog (or its own earlier refusal) calls text-only gets each image as a short note instead: the
      // managed route answers an image to such a model with 404 "No endpoints found that support image input". Unknown
      // capability (every vendor list that states none) keeps them, exactly as before.
      const sent = supportsImages(req.model) === false ? provider.withoutImageParts(req.messages || [], req.model) : (req.messages || []);
      // ONE pre-send normalization (provider.js prepareWireMessages) — for this wire, exactly repairToolPairs.
      const prepared = provider.prepareWireMessages(sent, 'chat');
      // ONE role projection (provider.projectRoles): the Ollama profile (native wire and its /v1 fallback alike) and every
      // non-Claude model get the strict 'chat' shape — one leading system message, the host notes and the loop's mid-run
      // host messages as fenced user-side text, alternating turns ending on a user or tool turn (#102-class refusals); a
      // Claude model keeps its continuation placement ('native'). A template this endpoint + model proved has no system
      // role (requestWithRetry, template_refusal) gets 'chat-nosystem'.
      const policy = provider.systemlessTemplate(baseUrl, req.model) ? 'chat-nosystem'
        : (opts.nativeOllama === true ? 'chat' : provider.chatRolePolicy(req.model));
      const messages = provider.projectRoles(prepared, policy);
      const body = { model: req.model, messages, stream: true };
      if (includeUsage && !skip('stream_options')) body.stream_options = { include_usage: true };
      const explicitMax = Math.floor(Number(req.max_tokens || req.maxTokens || 0)) || 0;
      // Only the host's explicit casual-turn classification selects this cap. No-tool auxiliary
      // calls (summaries, reviews) and real tasks must never inherit the small-talk allowance.
      const defaultCap = req.isTask === false && maxChatTokens > 0
        ? Math.min(maxTokens || maxChatTokens, maxChatTokens) : maxTokens;
      const outputCap = Number.isFinite(explicitMax) && explicitMax > 0 ? explicitMax : defaultCap;
      if (outputCap > 0 && !skip('max_tokens')) body.max_tokens = outputCap;
      if (req.tools && req.tools.length) {
        // Grammar-safe property keys on every tool, and the Moonshot dialect on a Kimi route (a strict 400 on the
        // whole request otherwise). A well-formed catalog on any other route is req.tools itself, byte-identical.
        body.tools = toolschema.wireTools(req.tools, { moonshot: toolschema.isMoonshotRoute(req.model, baseUrl) });
        if (!skip('tool_choice')) body.tool_choice = 'auto';
        /* parallel_tool_calls is deliberately OMITTED (endpoint default: enabled). Forcing `false` predates the
           loop's concurrent dispatch path and cost one full round trip per tool on every multi-read turn; the
           host's parallelSafe predicate already keeps mutating/stateful tools serial. Omitting the param also
           means an endpoint that 400s on it never sees it ('parallel_tool_calls' stays in DROPPABLE_PARAMS only
           for saved drop-state from older builds). */
      }
      // reasoning_effort: a model whose catalog DECLARES its levels gets one of those levels, or nothing when it
      // declares no dial. Otherwise the param goes on the wire only when the model provably reasons (catalog) or
      // the provider profile documents it, and effort 'none' means omit it entirely.
      const requestedEffort = req.reasoningEffort || defaultEffort;
      const known = findModel(req.model);
      const declaration = declarationFor(req.model);
      const declared = declaration ? declaration.levels : null;
      if (declared) {
        const pick = clampToDeclared(requestedEffort, declared, declaration.defaultLevel);
        if (pick && !skip('reasoning_effort')) body.reasoning_effort = pick;
      } else {
        const effort = wireEffort(requestedEffort);
        if (effort && !skip('reasoning_effort')) {
          const modelReasons = !!(known && (known.supportsReasoning === true || (Array.isArray(known.reasoningEfforts) && known.reasoningEfforts.length)));
          if (modelReasons || sendReasoningEffort) body.reasoning_effort = effort;
        }
      }
      if (replayReasoning) {
        // THINKING is on unless this request turns it off ('none'): an omitted effort means the endpoint default
        // (DeepSeek V4: thinking at high). Only a model KNOWN to think owes the field — one that declares levels,
        // or one this endpoint has been seen streaming reasoning_content for.
        const thinking = body.reasoning_effort !== 'none'
          && ((declared && declared.some(e => e !== 'none')) || emitsReasoning(baseUrl, req.model));
        body.messages = replayReasoningContent(body.messages, thinking, !!body.tools);
      }
      // Strict Chat Completions endpoints (Mistral: 422 extra_forbidden) reject StarNet's own bookkeeping keys on a
      // message (ts, streamId, agentId, the `reasoning` parking field) — only Chat Completions message keys leave.
      body.messages = provider.chatWireMessages(body.messages);
      if (cacheControl) body.messages = cacheControl(body.messages, req.model, req.cacheSystemPrefix);
      // OLLAMA NATIVE: size the window to THIS request before it leaves (the model's trained maximum is one local
      // /api/show, cached per model). requestWithRetry resizes once more if Ollama counts more tokens than estimated.
      let wire = null;
      if (nativeWire) {
        const facts = await factsFor(req.model);
        const modelMax = (facts && facts.contextLength) || 0;
        const need = ollamaNative.estimateTokens(body) + (Number(body.max_tokens) || 0);
        // First use of this model in this process: if Ollama already holds it loaded at a usable window (StarNet was
        // restarted inside the keep-alive, or the Commander loaded it larger), keep that window rather than reload.
        // A TASK (it carries tools: the long prompt that times out) keeps a window bigger than it needs only while the model
        // fits the GPU: one /api/ps shows spilling to the CPU is not adopted, and a held one steps back down to the
        // smallest rung that holds the prompt. A greeting or background call rides what is held (its prompt is short, so a
        // spill costs it little, and stepping down for it would reload the model twice: down now, up for the next task).
        if (!pinnedCtx) {
          const held = ollamaWindow(nativeBase, req.model);
          const task = !!(req.tools && req.tools.length);
          // ...never below a window Ollama has already refused to fit a task in (it counts tokens; the estimate guesses)
          const fits = task ? Math.max(ollamaNative.pickNumCtx(need, { ceiling: ctxCeiling, modelMax }), provenOllamaWindow(nativeBase, req.model)) : Infinity;
          if (!held) {
            const ps = await ollamaStatus();
            const loaded = ollamaNative.loadedWindow(ps, req.model);
            if (loaded > 0 && loaded <= (usableWindow(modelMax) || ctxCeiling)
              && !(loaded > fits && ollamaNative.spillsToCpu(ps, req.model))) noteOllamaWindow(nativeBase, req.model, loaded);
          } else if (held > fits && ollamaNative.spillsToCpu(await ollamaStatus(), req.model)) {
            lowerOllamaWindow(nativeBase, req.model, fits);
          }
        }
        /* BACKGROUND CALLS DO NOT THINK (measured on qwen3:8b, 2026-09-30). After a task the host fires its own
           housekeeping calls (reflection, profile update): no tools, and not a Commander turn (isTask is unset; a
           greeting is isTask:false, a task carries tools). Ollama serves one request at a time, and each of those
           spent 12-24s producing 2-3k characters of thinking for a few characters of output, so the Commander's
           next "hello" waited 26s behind them. Only a model Ollama says can think is told not to, and only here:
           Commander turns and tasks keep the model's own default. */
        const background = !(req.tools && req.tools.length) && typeof req.isTask !== 'boolean';
        // A background call that chose no effort of its own must not inherit the run's default (a CUSTOM endpoint on
        // Ollama carries CUSTOM's 'medium', which maps to think:true). An explicit aux effort still rides.
        if (background && !req.reasoningEffort && facts && facts.supportsReasoning === true) delete body.reasoning_effort;
        /* REASONING OFF IS SAID OUT LOUD (#116). wireEffort folds 'none' to "send nothing" (the /v1 wire's off), so with
           Reasoning OFF — Ollama's own default — the native body carried no `think` and qwen3 thought on every Commander
           turn and task (slow on a CPU). Native Ollama's off is think:false, told only to a model that can think. */
        const reasoningOff = canonicalEffort(requestedEffort) === 'none';
        const think =((background || reasoningOff) && facts && facts.supportsReasoning === true) ? false : undefined;
        wire = { native: true, modelMax, think, openCall: openCalls.get(req) || null, numCtx: ollamaNative.pickNumCtx(need, { pinned: pinnedCtx, ceiling: ctxCeiling, modelMax, floor: ollamaWindow(nativeBase, req.model) }) };
      }
      // WAIT TRUTH (#99): while the native request is unanswered, its probe's notes are yielded as { type:'waiting' }
      // events (not stream output: the loop shows them on the wait line). A note still queued when the answer lands is
      // stale and dropped; once one was shown, the stream opening says so, so the line stops naming a pending request.
      const waits = [];
      let wake = null;
      const rouse = () => { if (wake) { const f = wake; wake = null; f(); } };
      const onWait = (wire && wire.native && waitNoteMs > 0) ? w => { waits.push(w); rouse(); } : null;
      const pending = requestWithRetry(body, req.signal, provider.runtime.preStreamRetries(req, RETRY_DELAYS.length), requestHeaders(req), wire, onWait);
      let noted = false;
      if (onWait) {
        let settled = false;
        pending.then(() => { settled = true; rouse(); }, () => { settled = true; rouse(); });
        while (!settled) {
          if (waits.length) { noted = true; yield Object.assign({ type: 'waiting' }, waits.shift()); continue; }
          await new Promise(r => { wake = r; });
        }
      }
      let res;
      try { res = await pending; }
      catch (e) { if (isAbort(e, req.signal)) return; throw e; }
      if (noted) yield { type: 'waiting', phase: 'streaming', note: '' };
      // Native NDJSON is translated into the chat-completions chunk shape, so everything below parses one format.
      const translate = (wire && wire.native) ? ollamaNative.makeChunkTranslator() : null;
      const reader = timeouts.idleGuardedReader(res.body.getReader(), { signal: req.signal, url: res.url || baseUrl });
      const dec = new TextDecoder();
      let buf = '';
      const started = {};
      // Index bookkeeping for servers that omit tool_calls[].index (every non-streamed choice.message,
      // and some streaming servers, e.g. Mistral). Collapsing them all to 0 concatenated the argument
      // strings of PARALLEL calls into one corrupt call; assign instead a stable index per call id —
      // or the next free slot when the id is also absent.
      const idxById = {};
      const lastIdxByName = {};   // name -> the most recent slot opened for that name (id/index-less servers)
      const argsTrack = {};       // idx -> makeArgsTracker(): accumulated raw args, so completeness can arbitrate name repeats
      let nextIdx = 0;
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
          if (prior != null && !(argsTrack[prior] && argsTrack[prior].complete())) return prior;
          const idx = nextIdx++;
          lastIdxByName[fn.name] = idx;
          return idx;
        }
        // a bare argument chunk (no name either) continues the current slot
        return nextIdx > 0 ? nextIdx - 1 : 0;
      }
      let doneEmitted = false;   // exactly one terminal event per stream (see STREAM-END TRUTH below)
      // Native body text that parsed as no object, kept only until the first object parses (see nativeLeftover).
      let nativeObjects = 0;
      let nativeUnparsed = '';

      // One native NDJSON object. The FIRST one may prove the URL is not Ollama at all (notOllamaError).
      function nativeObject(j) {
        if (!j || typeof j !== 'object') return null;
        if (!nativeObjects++) {
          const detail = nativeErrorText(j);
          if (detail && NOT_OLLAMA_RE.test(detail)) { nativeWire = false; throw notOllamaError(detail); }
        }
        const chunk = translate(j);
        return chunk ? { json: chunk, last: j.done === true } : null;
      }
      /* A native body that never parsed line by line: a server that pretty-prints ONE JSON object over several lines
         (LM Studio's 200 "no such route", GH#111) read as nothing, then a cut stream with an EMPTY reply. Read as one
         document it is that object, so an {error} there is thrown, never an empty success. A body that is not JSON
         stays exactly as before. */
      function nativeLeftover() {
        if (!translate || nativeObjects || !nativeUnparsed.trim()) return null;
        let j;
        try { j = JSON.parse(nativeUnparsed); } catch (_) { return null; }
        return nativeObject(j);
      }

      function parseLine(line) {
        const t = line.replace(/\r$/, '').trim();
        if (translate) {
          // one JSON object per line; the object with done:true is the whole stream's end (Ollama sends no [DONE])
          if (!t) return null;
          let j;
          try { j = JSON.parse(t); } catch (_) { j = undefined; }
          if (!j || typeof j !== 'object') {
            if (!nativeObjects && nativeUnparsed.length < NATIVE_LEFTOVER_MAX) nativeUnparsed += line + '\n';
            return null;
          }
          return nativeObject(j);
        }
        if (!t || t.charAt(0) === ':') return null;
        if (t.indexOf('data:') !== 0) return null;
        const data = t.slice(5).trim();
        if (data === '[DONE]') return { done: true };
        try { return { json: JSON.parse(data) }; } catch (_) { return null; }
      }
      // This turn's reasoning_content (replayReasoning endpoints only), parked on the turn as ONE block just before
      // the terminal event, so the next request can hand it back (see replayReasoningContent).
      let reasoningText = '';
      let reasoningSeen = false;   // this stream already said reasoning is streaming (emitFrom)
      function* flushReasoning() {
        if (!replayReasoning || !reasoningText) return;
        noteEmitter(baseUrl, req.model);
        const block = { type: 'reasoning_content', text: reasoningText };
        reasoningText = '';
        yield { type: 'reasoning', block };
      }
      function* emitFrom(j) {
        if (j.error) {
          const err = new Error((j.error && (j.error.message || j.error.code)) || 'provider stream error');
          err.body = j;   // the structured error (code/type) — errorClass reads it
          err.ownMessage = true;
          throw localMemoryError(err);
        }
        if (j.usage) yield { type: 'usage', usage: j.usage };
        const choice = j.choices && j.choices[0];
        if (!choice) return;
        const d = choice.delta || choice.message || {};
        if (replayReasoning && typeof d.reasoning_content === 'string' && d.reasoning_content) reasoningText += d.reasoning_content;
        /* REASONING IS STREAM OUTPUT (80de2a75 review). A reasoning model (deepseek-reasoner, OpenRouter's reasoning
           models, Ollama thinking) streams reasoning (billed output) for seconds or minutes before any answer text, and
           nothing here showed it: a Stop in that phase looked like a Stop before the first byte, a known $0 run. The
           first reasoning chunk says so once as a blockless { type:'reasoning' } (the loop parks only a block). */
        if (!reasoningSeen && ((typeof d.reasoning_content === 'string' && d.reasoning_content) || (typeof d.reasoning === 'string' && d.reasoning)
          || (Array.isArray(d.reasoning_details) && d.reasoning_details.length))) { reasoningSeen = true; yield { type: 'reasoning' }; }
        if (typeof d.content === 'string' && d.content) yield { type: 'text', delta: d.content };
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const idx = callIndex(tc);
            const fn = tc.function || {};
            if (!started[idx] && (tc.id || fn.name)) {
              started[idx] = true;
              yield { type: 'tool_start', index: idx, id: tc.id || ('call_' + idx), name: fn.name || '' };
            }
            if (typeof fn.arguments === 'string' && fn.arguments) { (argsTrack[idx] || (argsTrack[idx] = makeArgsTracker())).feed(fn.arguments); yield { type: 'tool_args', index: idx, chunk: fn.arguments }; }
          }
        }
        if (choice.finish_reason && !doneEmitted) {
          yield* flushReasoning();
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
            if (p.last) { sawSentinel = true; break; }
          }
        }
        if (!sawSentinel) {
          buf += dec.decode();
          if (buf.trim()) {
            const p = parseLine(buf);
            if (p && p.done) sawSentinel = true;
            else if (p && p.json) { yield* emitFrom(p.json); if (p.last) sawSentinel = true; }
          }
          const whole = nativeLeftover();
          if (whole) { yield* emitFrom(whole.json); if (whole.last) sawSentinel = true; }
        }
        // STREAM-END TRUTH (truthful-telemetry law): always emit exactly ONE terminal event, and say honestly
        // whether the stream really ENDED or merely stopped arriving. A complete response carries a
        // finish_reason, a `[DONE]` sentinel, or both; a clean mid-generation FIN carries NEITHER, and the loop
        // cannot otherwise tell it apart from a finished answer — so it shipped the fragment as a completed,
        // $0 delivery. Requiring only ONE of the two signals keeps this correct for the local OpenAI-compatible
        // servers (Ollama, LM Studio) that send a finish_reason but omit the sentinel.
        if (!doneEmitted) { yield* flushReasoning(); yield { type: 'done', finishReason: null, truncated: !sawSentinel }; }
      } catch (e) {
        if (isAbort(e, req.signal)) return;
        throw e;
      }
    }

    // Local allocation failure is not a busy server. Repeating it can starve the station renderer too.
    // Keep this scoped to the Ollama profile (including its compatible-wire fallback), not hosted 5xx.
    function localMemoryError(err) {
      if (opts.nativeOllama !== true || !err || (err.status && err.status !== 500)) return err;
      const detail = String(err.message || '');
      if (!/out[- ]of[- ]memory|failed to allocate (?:CUDA\d* buffer|buffer for kv cache)|model requires more (?:system )?memory/i.test(detail)) return err;
      err.localModelMemory = true;
      err.ownMessage = true;
      err.message = ollamaIsLoopback
        ? 'Local model ran out of memory. Close other local models or memory-heavy apps, or choose a smaller model from the model picker in COMMS before trying again. [' + detail + ']'
        : 'The model server at ' + ollamaHost + ' ran out of memory. Free memory on that machine, or choose a smaller model from the model picker in COMMS before trying again. [' + detail + ']';
      return err;
    }

    async function requestWithRetry(body, signal, maxRetries, wireHeaders, wire, onWait) {
      // maxRetries: the loop may LOWER this ladder (req.preStreamRetries = 0 once it owns the pacing — provider.js).
      // `waited` is the backoff actually spent; the exhaustion marker reports it so the loop counts it, not repeats it.
      const retries = (maxRetries == null) ? RETRY_DELAYS.length : maxRetries;
      let waited = 0;
      let healedEffort = false, healedReasoning = false, healedTemplate = false;   // each request self-heals each of these at most once
      for (let attempt = 0; ; attempt++) {
        if (signal && signal.aborted) throw abortError();
        let res;
        // Fresh connect guard per attempt; disarmed the instant the fetch settles so the ceiling can't abort
        // the streaming body (a connect expiry rejects as a `timeout`, a user-cancel as AbortError).
        const guard = timeouts.connectGuard(signal, connectTimeoutMs);
        const native = !!(wire && wire.native && nativeWire);
        if (wire) wire.native = native;
        const probe = (native && onWait) ? waitProbe(body, onWait, wire.openCall) : null;   // WAIT TRUTH (#99): one per attempt
        try {
          res = await doFetch(native ? nativeBase + '/api/chat' : baseUrl + chatPath, {
            method: 'POST',
            headers: headerBag(key, wireHeaders === undefined ? opts.headers : wireHeaders),
            body: JSON.stringify(native ? ollamaNative.toNativeRequest(body, { numCtx: wire.numCtx, think: wire.think }) : body),
            signal: guard.signal
          });
        } catch (e) {
          if (isAbort(e, signal)) throw e;
          provider.runtime.stampRequestHost(e, native ? nativeBase : baseUrl);   // a TLS/socket cause names no host: say which one we dialled
          // Local Ollama silent past the connect ceiling: say where the model actually runs (one /api/ps read).
          // Appended, so the message still reads "timed out".
          if (native && e && e.timeout && e.phase === 'connect' && !e.ollamaPlacement) {
            e.ollamaPlacement = true;
            const ps = await ollamaStatus();
            e.message += ' — ' + ollamaNative.placementNote(ps, body.model, ollamaNative.estimateTokens(body), ollamaIsLoopback ? 'on this computer' : 'at ' + ollamaHost);
            /* NO RE-SEND OF A LOADED MODEL'S SILENCE (#99 follow-up). Every re-send aborts Ollama mid-request and sends the
               same prompt to the same model, so a CPU-spilled model that needs longer than the ceiling to answer a task
               prompt got 7 sends and never finished. When /api/ps listed the model at every read of this attempt and no
               other StarNet call is open on that server (none of ours it could have queued behind), the turn ends now
               on errorClass `local_timeout` with the placement above. Still re-sent: a model missing from any read (a
               load may have eaten the wait, or hung), an unreadable status, another StarNet call open there. */
            if (ollamaNative.psRow(ps, body.model) && !(probe && probe.sawMissing()) && !otherOllamaCalls(nativeBase, wire.openCall).n) e.localModelTimeout = true;
          }
          // a TLS rejection, a crash in our own request code or a loaded model's silence (above) cannot heal by re-sending:
          // fail fast, unmarked
          const failure = classifyApiError(e, { model: body.model });   // unreachable: one retry (its retryBudget), then name the host
          if (!failure.retryable) throw e;
          if (attempt < provider.runtime.retryLimit(failure, retries)) { waited += RETRY_DELAYS[attempt]; await delay(RETRY_DELAYS[attempt], signal); continue; }
          throw provider.runtime.markPreStreamRetriesExhausted(e, { attempts: attempt + 1, waitedMs: waited });
        } finally {
          guard.disarm();
          if (probe) probe.stop();
        }
        if (res.ok && res.body) {
          if (native) noteOllamaWindow(nativeBase, body.model, wire.numCtx);
          if (healedTemplate) provider.noteSystemlessTemplate(baseUrl, body.model);   // proven: this template takes no system role
          return res;
        }
        const upstreamError = await responseErrorDetail(res, signal, native ? nativeBase + '/api/chat' : baseUrl + chatPath);
        let detail = upstreamError.detail;
        if (native) {
          // No /api/chat behind this URL (a proxy that only forwards /v1): the /v1 wire, for the rest of this
          // instance. Ollama's own 404 for an unpulled model names the model and is a real error, not this.
          if (res.status === 404 && !/model\b[^]*\bnot found/i.test(String(detail))) { nativeWire = false; attempt--; continue; }
          // truncate:false refused a prompt bigger than the window: step up to one that holds it (plus the output
          // allowance) and resend. At the model's usable maximum there is no bigger window, so the refusal goes on
          // as-is — its wording classifies as context_overflow and the loop's reactive compaction takes it from there.
          const over = ollamaNative.exceedFrom(detail);
          if (over && !pinnedCtx) {
            const next = ollamaNative.pickNumCtx(over.promptTokens + (Number(body.max_tokens) || 0), { ceiling: ctxCeiling, modelMax: wire.modelMax, floor: wire.numCtx + 1 });
            if (next > wire.numCtx) { noteProvenOllamaWindow(nativeBase, body.model, next); wire.numCtx = next; attempt--; continue; }
          }
          // A model without a thinking mode refuses `think`; the request means the same without it.
          if (body.reasoning_effort !== undefined && /does not support thinking/i.test(String(detail))) {
            delete body.reasoning_effort; rememberDrop(body.model, 'reasoning_effort'); attempt--; continue;
          }
        }
        /* THE MODEL'S CHAT TEMPLATE REFUSED THE SHAPE (errorClass template_refusal, #102). The 'chat' projection already
           sends what a strict template asks for, so what is left is a template with no system role at all (Gemma: "System
           role not supported"). Resend ONCE with the system message folded into the first user turn, the way such a
           template folds it itself (projectRoles 'chat-nosystem'); when that goes through, this endpoint + model keeps
           that shape (above). A refusal of that too goes on as template_refusal, naming the template — never resent as a
           server error. */
        if (!healedTemplate && errorClass.isTemplateRefusal(detail) && Array.isArray(body.messages) && body.messages.some(m => m && m.role === 'system')) {
          healedTemplate = true;
          body.messages = provider.projectRoles(body.messages, 'chat-nosystem');
          attempt--; continue;
        }
        // The endpoint NAMED the levels this model takes (or, for gpt-5.6 with tools on Chat Completions, that only
        // 'none' works): learn them for the model and resend a level it accepts. Checked BEFORE the generic drop
        // below, which would otherwise delete the param and silently run the model at its own default instead.
        if (!healedEffort && (res.status === 400 || res.status === 422)) {
          const onlyNone = toolsForceNone(detail);
          const supported = onlyNone ? ['none'] : (body.reasoning_effort !== undefined ? supportedEffortsFrom(detail) : null);
          if (supported) {
            healedEffort = true;
            rememberLearned(baseUrl, body.model, supported);
            const next = onlyNone ? 'none' : clampToDeclared(body.reasoning_effort, supported);
            if (next) body.reasoning_effort = next; else delete body.reasoning_effort;
            attempt--; continue;
          }
        }
        // DeepSeek thinking mode refused a history without reasoning_content (a turn this process never saw, e.g.
        // after a restart): hand every assistant turn its field and resend, and remember the model thinks.
        if (replayReasoning && !healedReasoning && res.status === 400 && /reasoning_content/i.test(detail) && /passed back/i.test(detail)) {
          healedReasoning = true;
          noteEmitter(baseUrl, body.model);
          body.messages = replayReasoningContent(body.messages, true, true);
          attempt--; continue;
        }
        // Compatibility self-heal: providers behind the "OpenAI-compatible" label reject different optional
        // params. Strip the named param and retry immediately (remembered per model, so later turns in the
        // run never pay the extra round-trip). Does not consume a transient-retry attempt.
        if (dropUnsupportedParam(body, res.status, detail)) { attempt--; continue; }
        // A vendor API rejecting a slash-prefixed id as an unknown/invalid model means a ROUTED-catalog id
        // (StarNet managed / OpenRouter, e.g. "openai/gpt-…") reached a direct vendor endpoint. Without this
        // line the user sees only the vendor's bare "invalid model ID" and has no path back (2026-08-25
        // stranded-user incident) — name the mismatch and the fix. Slash-native catalogs (together, fireworks,
        // groq) are safe: their ids resolve on their own endpoints, so this only fires on a real mismatch.
        // An endpoint the Commander runs or names (CUSTOM: Hive, LiteLLM, vLLM…; Ollama) serves vendor/model ids NATIVELY:
        // there that line was false and sent a Hive user to switch providers (#126). It names the id that was sent instead.
        if ((res.status === 400 || res.status === 404)
          && /invalid model|is not a valid model|model .*(does not exist|not found)/i.test(String(detail))) {
          const sent = String(body.model || '');
          if (routedIdHint && sent.indexOf('/') > 0) {
            detail += ' — "' + sent + '" is a routed-catalog model id (vendor/model), but this provider calls the vendor API directly. Switch the provider in the model picker (STARNET or OPENROUTER for routed ids), or pick a model from this provider\'s own catalog.';
          } else if (!routedIdHint && sent && String(detail).indexOf(sent) < 0) {
            detail += ' — the endpoint did not accept the model id "' + sent + '"; check the exact id in your endpoint\'s model list.';
          }
        }
        // the model refused image input: text-only for this process, so the next request to it goes without the image
        if (errorClass.isImageInputRefusal(detail)) provider.noteImageRefusal(baseUrl, body.model);
        const err = new Error(errLabel + ' http ' + res.status + ' - ' + detail);
        err.status = res.status;
        err.headers = res.headers;
        err.requestId = upstreamError.requestId;
        err.providerCode = upstreamError.code;
        err.upstreamProvider = upstreamError.providerName;
        /* KEEP THE PROVIDER'S ERROR BODY (same law as codex.js): errorClass reads error.code/type off it (an OpenAI
           429 carrying code 'insufficient_quota' is an empty wallet, not a busy moment). The message stays this
           adapter's own sentence — label + status, which the UI routes on ("Kimi For Coding http 401"); err.ownMessage tells
           errorClass so. */
        if (upstreamError.body) { err.body = upstreamError.body; err.ownMessage = true; }
        localMemoryError(err);
        if (errorClass.isTemplateRefusal(detail)) {
          // the template_refusal sentence names the host and says whether the systemless shape was refused too
          provider.runtime.stampRequestHost(err, native ? nativeBase : baseUrl);
          err.templateRetried = healedTemplate || !(Array.isArray(body.messages) && body.messages.some(m => m && m.role === 'system'));
        }
        const cls = classifyApiError(err, { model: body.model });
        err.transient = cls.retryable;
        if (cls.retryable && attempt < retries) { const wait = Math.min(60000, Math.max(RETRY_DELAYS[attempt], cls.retryAfterMs || 0)); waited += wait; await delay(wait, signal); continue; }
        throw cls.retryable ? provider.runtime.markPreStreamRetriesExhausted(err, { attempts: attempt + 1, waitedMs: waited }) : err;
      }
    }

    // ONE live read of the endpoint's /models: its rows normalized, not yet this instance's (no profile rules, no Ollama
    // facts). null = no usable answer; [] = the endpoint answered with no models.
    async function fetchList() {
      try {
        // Extra wire headers (e.g. kimi's X-Msh-* device signature) must ride the /models probe too, or the
        // catalog endpoint rejects it and the connect screen is needlessly empty. Auth header layers on top.
        const catHeaders = Object.assign({}, opts.headers || {});
        if (key) catHeaders.Authorization = 'Bearer ' + key;
        const res = await doFetch(baseUrl + modelsPath, { headers: catHeaders });
        if (!res.ok) return null;
        const j = await res.json();
        const raw = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : []);
        return raw.map(normalizeModel).filter(Boolean);
      } catch (_) { return null; }
    }
    async function sharedList() { return (await fetchList()) || []; }   // the cache's background load
    // This instance's copy of a list (a shared list is never mutated): the profile's documented levels and, on the
    // native Ollama wire, each model's served window from the /api/show facts this process already holds.
    function ownRows(list) {
      const out = list.map(m => declare(Object.assign({}, m, {
        supported_parameters: Array.isArray(m.supported_parameters) ? m.supported_parameters.slice() : [],
        reasoningEfforts: Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts.slice() : []
      })));
      if (nativeWire) for (const m of out) applyFacts(m, heldFacts(m.id));
      return out;
    }
    // The newest list this credential's endpoint answered (to any instance) becomes this instance's catalog. Synchronous.
    function adoptShared() {
      if (!shared || !shared.shared) return;
      const hit = shared.peek();
      if (!hit || hit.version === adoptedVersion) return;
      adoptedVersion = hit.version;
      catalog = ownRows(hit.models);
      rememberDeclared(baseUrl, catalog);
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
            const raw = await fetchList();
            if (!raw) return [];
            const version = shared ? shared.share(raw) : 0;   // a live list: kept for this credential, its windows noted
            const list = ownRows(raw);
            // Ollama's /v1/models says nothing but ids. Its /api/show states each model's trained window and whether
            // it takes tools or thinks — one local call per installed model (shared for the TTL), so the picker, the
            // compaction threshold and the up-front "this model can't run tasks" check all read the server's own facts.
            if (nativeWire) await Promise.all(list.map(m => factsFor(m.id).then(f => applyFacts(m, f))));
            rememberDeclared(baseUrl, list);   // live catalog only; the static fallback roster never feeds the memo
            if (version) adoptedVersion = version;
            return list;
          } catch (e) { failNote('providers.openai_compatible.catalog', e); return []; }
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
        // what the endpoint said at request time outranks the catalog/table, so the picker shows it too
        const learned = recallLearned(baseUrl, copy.id);
        if (learned) {
          copy.reasoningEfforts = learned;
          copy.reasoningEffortsDeclared = true;
          if (copy.defaultReasoningLevel && learned.indexOf(copy.defaultReasoningLevel) < 0) copy.defaultReasoningLevel = null;
          if (copy.supportsReasoning == null && learned.some(e => e !== 'none')) copy.supportsReasoning = true;
        }
        if (!copy.pricing && priceFamily && listPrices && typeof listPrices.pricingBlock === 'function') copy.pricing = listPrices.pricingBlock(priceFamily, copy.id);
        return copy;
      });
    }
    function findModel(id) {
      adoptShared();
      const m = catalog ? catalog.find(x => x.id === id) : null;
      // a warm list without this id: a model released after the list loaded. One throttled refresh can find it.
      if (!m && id && shared && catalog && catalog.length) shared.ensure({ miss: true });
      return m;
    }
    /* Learn this model's window before a run is built (catalog-cache.js runWindow bounds the wait). Native Ollama: the
       served window from one /api/show (shared for the TTL). Otherwise this credential's shared list, or ONE deduped
       load of it; an OAuth instance (no list scope) loads its own list unless its endpoint answered inside the TTL
       (then every window it publishes is already noted). Resolves to the catalog it has. */
    async function warmCatalog(model) {
      if (nativeWire && model) {
        const f = await factsFor(model);
        if (f && usableWindow(f.contextLength)) { maybeRewarmCatalog(); return catalog || []; }
      }
      adoptShared();
      if (catalog && catalog.length) { maybeRewarmCatalog(); return catalog; }
      if (shared && shared.shared) {
        if (shared.inBackoff()) return catalog || [];
        await shared.load();
        adoptShared();
        return catalog || [];
      }
      if (shared && shared.seen()) return catalog || [];
      return loadCatalog();
    }
    // The levels a model accepts (+ its declared default), most authoritative first: what the endpoint TOLD us
    // (learned) > this instance's catalog (vendor block or profile rule) > the same endpoint's catalog another
    // instance loaded (memo) > the profile rule by id. null = nothing declared anywhere (generic behaviour).
    function declarationFor(id) {
      const m = findModel(id);
      const learned = recallLearned(baseUrl, id);
      if (learned) {
        const def = m && m.defaultReasoningLevel;
        return { levels: learned, defaultLevel: (def && learned.indexOf(def) >= 0) ? def : null };
      }
      if (m) return m.reasoningEffortsDeclared ? { levels: m.reasoningEfforts, defaultLevel: m.defaultReasoningLevel || null } : null;
      const memo = recallDeclared(baseUrl, id);
      if (memo) return memo;
      const r = ruleFor(id);
      return r ? { levels: withOff(r.efforts.slice()), defaultLevel: r.defaultLevel || null } : null;
    }
    function declaredFor(id) { const d = declarationFor(id); return d ? d.levels : null; }
    // The model's window, FIRST known source wins and none is invented: its catalog row; the window this instance would
    // serve it at (native Ollama: /api/show's trained maximum under this instance's pin and ceiling, read before the
    // catalog warmed); what this endpoint last reported for it (inside the TTL) to any instance under any key; an
    // explicit default; 0.
    function contextLimit(id) {
      const m = findModel(id);
      if (m && m.context_length) return m.context_length;
      const f = nativeWire ? heldFacts(id) : null;
      const served = f ? usableWindow(f.contextLength) : 0;
      if (served) return served;
      return (shared && shared.windowFact(id)) || defaultContext;
    }
    // the most output one call can bill (provider.js outputLimit): the catalog's max output for the model, or the
    // max_tokens this profile sends (profile.maxOutputTokens), whichever is lower; 0 = neither is known
    function outputLimit(id) {
      const m = findModel(id);
      const cat = Math.floor(Number(m && m.max_completion_tokens) || 0);
      return (cat > 0 && maxTokens > 0) ? Math.min(cat, maxTokens) : (cat > 0 ? cat : maxTokens);
    }
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
      const f = nativeWire ? knownFacts.get(String(id || '')) : null;
      if (f && typeof f.supportsTools === 'boolean') return f.supportsTools;
      return profileSupportsTools;
    }
    // Image input: false once this model refused an image on this endpoint, else the catalog row's word, else null —
    // unknown, and an unknown model is sent images exactly as before.
    function supportsImages(id) {
      if (provider.refusedImages(baseUrl, id)) return false;
      const m = findModel(id);
      return (m && typeof m.supportsImages === 'boolean') ? m.supportsImages : null;
    }
    function reasoningEfforts(id) {
      const m = findModel(id);
      // declared levels are exact; a declared "no dial" offers only 'none' (= send nothing)
      const declared = declaredFor(id);
      if (declared) return declared.length ? declared.slice() : ['none'];
      if (m && Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length) return m.reasoningEfforts.slice();
      if ((m && m.supportsReasoning === true) || sendReasoningEffort) return ['none'].concat(WIRE_EFFORTS);
      return ['none'];
    }

    // localRuntime names the Ollama server this instance talks to, so the loop never fails a local out-of-memory
    // over to another model on the same server.
    return { stream, listModels, warmCatalog, contextLimit, outputLimit, priceOf, supportsTools, supportsImages, reasoningEfforts, localRuntime: nativeBase || undefined };
  }

  return { makeOpenAICompatibleProvider, _internals: { normalizeModel, reportedWindow, cleanBaseUrl, responseErrorDetail, safeErrorField, makeArgsTracker, clampToDeclared, canonicalEffort, paramNamed, supportedEffortsFrom, toolsForceNone, replayReasoningContent } };
});
