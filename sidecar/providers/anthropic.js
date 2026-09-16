/* sidecar/providers/anthropic.js - native Anthropic Messages API adapter.
   Converts the harness's OpenAI-style chat/tool transcript into Anthropic's
   messages wire, then normalizes Anthropic SSE back to HarnessEvent. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./provider.js'), require('./errorClass.js'), require('./prices.js'), require('./toolschema.js'));
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.anthropic = factory(root.SK.providers.provider, root.SK.providers.errorClass, root.SK.providers.prices, root.SK.providers.toolschema); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provider, errorClass, prices, toolschema) {
  'use strict';

  const normalizeFinish = provider.normalizeFinish;
  const classifyApiError = errorClass.classifyApiError;
  const timeouts = provider.timeouts;
  const isAbort = provider.runtime.isAbort;
  const delay = provider.runtime.abortableDelay;
  const DEFAULT_BASE = 'https://api.anthropic.com/v1';
  const ANTHROPIC_VERSION = '2023-06-01';
  const RETRY_DELAYS = [400, 1200];
  const REWARM_MIN_MS = 5 * 60 * 1000;
  const DEFAULT_CONTEXT = 200000;
  const FALLBACK_MAX_TOKENS = 32000;   // Anthropic requires max_tokens; when the model's real ceiling is unknown, cap here
                                       // (well above the old 4096 so long deliverables aren't silently truncated) — decided 2026-07-04.
  // resolve the env override once, tolerant of a garbage value (a typo must never wedge generation).
  const ENV_MAX_TOKENS = (function () {
    try {
      const raw = (typeof process !== 'undefined' && process.env) ? process.env.SKYNET_ANTHROPIC_MAX_TOKENS : '';
      const n = Number(String(raw == null ? '' : raw).trim());
      return (Number.isFinite(n) && n > 0) ? Math.floor(n) : 0;
    } catch (_) { return 0; }
  })();
  // Prompt caching is ON by default (see the breakpoint() note below for why it pays). This is the kill
  // switch: it changes what Anthropic BILLS, so there has to be a way to turn it off without a code change.
  const CACHE_OFF = (function () {
    try {
      const raw = (typeof process !== 'undefined' && process.env) ? process.env.SKYNET_ANTHROPIC_CACHE : '';
      return String(raw == null ? '' : raw).trim() === '0';
    } catch (_) { return false; }
  })();
  /* CACHE TTL (2026-07-31, Hermes-parity pass). Default stays the 5-minute tier. SKYNET_ANTHROPIC_CACHE_TTL=1h
     opts into the 1-hour tier — the right trade for human-paced COMMS conversations, where the gap between
     turns routinely exceeds 5 minutes and every reply then pays a full re-write. Costs are NOT symmetric:
     a 1h write bills 2.0x (vs 1.25x), so the break-even moves from two requests to three — which is why it
     is an operator opt-in, not the default. prices.js reads the SAME env so the spend estimate tracks the
     tier actually requested. */
  const CACHE_TTL_1H = (function () {
    try {
      const raw = (typeof process !== 'undefined' && process.env) ? process.env.SKYNET_ANTHROPIC_CACHE_TTL : '';
      return String(raw == null ? '' : raw).trim().toLowerCase() === '1h';
    } catch (_) { return false; }
  })();
  const cacheControl = () => (CACHE_TTL_1H ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' });
  // the block kinds Anthropic documents as legal carriers of cache_control (plus schema-less tool defs)
  const CACHEABLE_BLOCK = { text: 1, image: 1, tool_use: 1, tool_result: 1, document: 1 };

  /* THINKING + EFFORT (2026-07-27). Claude's headline capability, previously unreachable through this adapter:
     reasoningEfforts() returned ['none'] and buildBody emitted no thinking parameter at all, so a Commander on
     their own Anthropic key ran a NON-THINKING Claude while the SAME model reached through OpenRouter got
     `reasoning:{effort}`. Two wire contracts exist and the model decides which:

       MODERN (Claude 4.6 and everything after)  ->  thinking:{type:'adaptive'} + output_config:{effort}
       LEGACY (Claude 3.x / 4.0 / 4.1 / 4.5)     ->  thinking:{type:'enabled', budget_tokens:N}

     UNKNOWN CLAUDE MODELS DEFAULT TO MODERN, with an explicit LEGACY list — the same "default to newest" shape
     resolveMaxTokens already uses. An allowlist of modern versions goes stale the moment Anthropic ships a name
     carrying no recognizable version number, and that failure is SILENT: a new flagship quietly routed down the
     deprecated budget path, which now answers 400 on every model past 4.6.

     A NON-Claude model reached through an Anthropic-compatible baseUrl gets NOTHING. Those endpoints are third
     party and a thinking parameter they never implemented is a hard 400, not a degrade (provider-compat law). */
  const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  // Legacy manual-thinking budgets. Each must land BELOW max_tokens (the wire rejects budget >= max_tokens)
  // and at or above Anthropic's 1024 floor; applyThinking clamps both ends against the resolved ceiling.
  const LEGACY_BUDGET = { minimal: 1024, low: 4000, medium: 8000, high: 16000, xhigh: 32000, max: 32000 };
  const LEGACY_MIN_BUDGET = 1024;
  // Substring-matched in BOTH the dashed and dotted spellings: catalog ids arrive dashed, hand-typed model
  // fields and imported agent dossiers arrive dotted, and both reach this adapter.
  const LEGACY_CLAUDE = [
    'claude-3',
    'claude-opus-4-0', 'claude-opus-4.0', 'claude-opus-4-1', 'claude-opus-4.1',
    'claude-sonnet-4-0', 'claude-sonnet-4.0',
    'claude-opus-4-2025', 'claude-sonnet-4-2025',
    'claude-opus-4-5', 'claude-opus-4.5',
    'claude-sonnet-4-5', 'claude-sonnet-4.5',
    'claude-haiku-4-5', 'claude-haiku-4.5'
  ];
  // The 4.6 family predates the `xhigh` level (low/medium/high/max only) — offering it there is a 400.
  const NO_XHIGH_CLAUDE = ['claude-opus-4-6', 'claude-opus-4.6', 'claude-sonnet-4-6', 'claude-sonnet-4.6'];
  // Thinking is ALWAYS ON for these: an explicit {type:'disabled'} is refused at any effort, so 'none' is never
  // offered and the thinking key is OMITTED rather than sent disabled.
  const ALWAYS_THINKING_CLAUDE = ['claude-fable', 'claude-mythos'];

  const modelKey = (id) => String(id == null ? '' : id).toLowerCase();
  function hasAny(id, list) { const k = modelKey(id); for (const s of list) if (k.indexOf(s) >= 0) return true; return false; }
  function isClaude(id) { return modelKey(id).indexOf('claude') >= 0; }
  function alwaysThinks(id) { return hasAny(id, ALWAYS_THINKING_CLAUDE); }
  function normalizeEffort(v) {
    const k = String(v == null ? '' : v).trim().toLowerCase().replace(/[\s_-]+/g, '');
    const map = {
      off: 'none', none: 'none', no: 'none', disabled: 'none',
      min: 'minimal', minimal: 'minimal',
      low: 'low', med: 'medium', mid: 'medium', medium: 'medium', high: 'high',
      extra: 'xhigh', xtra: 'xhigh', extrahigh: 'xhigh', xhigh: 'xhigh', max: 'max'
    };
    return map[k] || 'medium';
  }
  // The levels this model actually accepts, ascending. Legacy models publish the BUDGET tiers under the same
  // vocabulary so one Commander-facing control drives both contracts.
  function effortsFor(id) {
    if (!isClaude(id)) return ['none'];
    if (hasAny(id, LEGACY_CLAUDE)) return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    const out = ['low', 'medium', 'high'];
    if (!hasAny(id, NO_XHIGH_CLAUDE)) out.push('xhigh');
    out.push('max');
    if (!alwaysThinks(id)) out.unshift('none');
    return out;
  }
  // A level this model does not publish is CLAMPED to its nearest neighbour, never dropped: asking a 4.6 model
  // for 'xhigh' means "as hard as you can", and 'max' is the honest answer. Ties resolve UPWARD (the list is
  // ascending and the comparison is <=), so 'minimal' becomes 'low' rather than silently switching thinking OFF.
  function clampEffort(want, allowed) {
    const i = EFFORT_ORDER.indexOf(want);
    if (i < 0) return allowed.indexOf('medium') >= 0 ? 'medium' : allowed[allowed.length - 1];
    let best = allowed[0], bestD = Infinity;
    for (const a of allowed) {
      const d = Math.abs(EFFORT_ORDER.indexOf(a) - i);
      if (d <= bestD) { bestD = d; best = a; }
    }
    return best;
  }

  function cleanBaseUrl(value) {
    return String(value || DEFAULT_BASE).trim().replace(/\/+$/, '');
  }
  function headerBag(key, accept) {
    const h = {
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
      'Accept': accept || 'text/event-stream'
    };
    if (key) h['x-api-key'] = key;
    return h;
  }
  function safeJson(value, fallback) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string') return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
  }
  function textFromContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const out = [];
      for (const p of content) {
        if (typeof p === 'string') { out.push(p); continue; }
        if (!p || typeof p !== 'object') continue;
        if (typeof p.text === 'string') out.push(p.text);
        else if (typeof p.content === 'string') out.push(p.content);
      }
      return out.join('');
    }
    return String(content);
  }
  function contentToTextBlocks(content) {
    const text = textFromContent(content);
    return text ? [{ type: 'text', text }] : [];
  }
  // USER ATTACHMENTS (COMMS): a user turn may carry image parts alongside its text — the run path expands a
  // Commander's attached photo into an {type:'image_url', image_url:{url}} block before this adapter sees it.
  // Anthropic's native vision shape is {type:'image', source:{type:'base64'|'url', …}}, so map image_url → that.
  // Only USER messages get this (assistant/tool turns never carry images); an unrecognized part degrades to its
  // text or is dropped — never throws.
  function anthImageBlock(url) {
    const s = String(url == null ? '' : url);
    const m = /^data:([^;,]*?)(;base64)?,([\s\S]*)$/.exec(s);
    if (m) {
      const media_type = (m[1] || 'image/png').toLowerCase();
      const data = m[2] ? (m[3] || '') : Buffer.from(decodeURIComponent(m[3] || ''), 'utf8').toString('base64');
      return { type: 'image', source: { type: 'base64', media_type, data } };
    }
    if (/^https?:\/\//i.test(s)) return { type: 'image', source: { type: 'url', url: s } };
    return null;
  }
  function userContentToBlocks(content) {
    if (content == null) return [];
    if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
    if (!Array.isArray(content)) return contentToTextBlocks(content);
    const out = [];
    for (const p of content) {
      if (typeof p === 'string') { if (p) out.push({ type: 'text', text: p }); continue; }
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'text' && typeof p.text === 'string') { if (p.text) out.push({ type: 'text', text: p.text }); continue; }
      if (p.type === 'image_url') { const b = anthImageBlock(p.image_url && (p.image_url.url != null ? p.image_url.url : p.image_url)); if (b) out.push(b); continue; }
      if (p.type === 'image' && p.source) { out.push(p); continue; }   // already a native Anthropic image block
      if (typeof p.text === 'string' && p.text) out.push({ type: 'text', text: p.text });
    }
    return out;
  }
  function appendMessage(out, role, content) {
    if (!content || !content.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      last.content = last.content.concat(content);
      return;
    }
    out.push({ role, content });
  }
  function extractLeadingSystem(messages) {
    const system = [];
    let i = 0;
    for (; i < (messages || []).length; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== 'system') break;
      const text = textFromContent(msg.content).trim();
      if (text) system.push(text);
    }
    return { system: system.join('\n\n'), rest: (messages || []).slice(i) };
  }
  function assistantToolBlocks(toolCalls) {
    const blocks = [];
    if (!Array.isArray(toolCalls)) return blocks;
    for (const tc of toolCalls) {
      const fn = (tc && tc.function) || {};
      const name = String(fn.name || '').trim();
      if (!name) continue;
      blocks.push({
        type: 'tool_use',
        id: String((tc && tc.id) || fn.call_id || ('call_' + blocks.length)),
        name,
        input: safeJson(fn.arguments, {})
      });
    }
    return blocks;
  }
  // Replay-safe thinking blocks: only the two shapes the wire defines, only when they carry the field that
  // makes them verifiable. A half-captured block is worse than none (it fails validation and ends the run),
  // so anything unrecognized is dropped rather than guessed at.
  function thinkingBlocks(reasoning) {
    if (!Array.isArray(reasoning)) return [];
    const out = [];
    for (const b of reasoning) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'thinking' && typeof b.signature === 'string' && b.signature) {
        out.push({ type: 'thinking', thinking: String(b.thinking == null ? '' : b.thinking), signature: b.signature });
        continue;
      }
      if (b.type === 'redacted_thinking' && typeof b.data === 'string' && b.data) out.push({ type: 'redacted_thinking', data: b.data });
    }
    return out;
  }
  function messagesToAnthropic(messages) {
    const picked = extractLeadingSystem(messages || []);
    const out = [];
    for (const msg of picked.rest) {
      if (!msg || typeof msg !== 'object') continue;
      const role = msg.role;
      if (role === 'tool') {
        appendMessage(out, 'user', [{
          type: 'tool_result',
          tool_use_id: String(msg.tool_call_id || msg.call_id || ''),
          content: textFromContent(msg.content)
        }]);
        continue;
      }
      if (role === 'assistant') {
        // THINKING BLOCKS RIDE FIRST, VERBATIM. When thinking is on, Anthropic signs each block and validates
        // that signature on replay — an assistant turn that thought and then called a tool must carry the
        // thinking block AHEAD of the tool_use on the next request, unedited. Dropping them is not a graceful
        // degrade: it fails the ordering/signature check and kills the turn. loop.js parks whatever this
        // adapter emitted on `msg.reasoning`, so a replay is a passthrough, never a reconstruction. Absent
        // (every other provider, every pre-thinking transcript) = byte-identical to the old behavior.
        appendMessage(out, 'assistant', thinkingBlocks(msg.reasoning)
          .concat(contentToTextBlocks(msg.content))
          .concat(assistantToolBlocks(msg.tool_calls)));
        continue;
      }
      appendMessage(out, 'user', userContentToBlocks(msg.content));
    }
    return { system: picked.system, messages: out };
  }
  function toAnthropicTools(tools) {
    if (!tools || !tools.length) return null;
    const out = [];
    for (const item of tools) {
      const fn = (item && item.function) || {};
      const name = String(fn.name || '').trim();
      if (!name) continue;
      // Anthropic tolerates extra JSON-Schema keywords, so this is normalize() not the Gemini prune:
      // it only repairs shapes the wire genuinely rejects — chiefly a `{anyOf:[X,{type:'null'}]}`
      // null-union at the root of input_schema, the standard zod/Pydantic optional-field shape that
      // arrives with third-party MCP connector tools.
      out.push({
        name,
        description: fn.description || '',
        input_schema: toolschema.normalize(fn.parameters || { type: 'object', properties: {} })
      });
    }
    return out.length ? out : null;
  }
  function normalizeUsage(u) {
    u = u || {};
    const uncached = Number(u.input_tokens || 0) || 0;
    const cacheCreate = Number(u.cache_creation_input_tokens || 0) || 0;
    const cacheRead = Number(u.cache_read_input_tokens || 0) || 0;
    const out = Number(u.output_tokens || 0) || 0;
    return {
      prompt_tokens: uncached + cacheCreate + cacheRead,
      completion_tokens: out,
      total_tokens: uncached + cacheCreate + cacheRead + out,
      // cache_creation_tokens is carried alongside cached_tokens so cost.js can price the three buckets at
      // their real rates (~0.1x read, ~1.25x write). prompt_tokens stays the TRUE total — these are a
      // breakdown OF it, never a substitute for it.
      prompt_tokens_details: { cached_tokens: cacheRead, cache_creation_tokens: cacheCreate },
      reasoning_tokens: 0
    };
  }
  function normalizeModel(m) {
    const id = (m && (m.id || m.name || m.model)) ? String(m.id || m.name || m.model) : '';
    if (!id) return null;
    return {
      id,
      name: m.display_name || m.name || id,
      context_length: Number(m.context_length || m.input_token_limit || DEFAULT_CONTEXT) || DEFAULT_CONTEXT,
      max_completion_tokens: m.max_output_tokens || m.output_token_limit || null,
      // /v1/models reports no pricing, so this comes from the dated list-rate table (prices.js) rather than
      // the wire. Same {prompt, completion} per-token shape every other adapter publishes, so listModels()
      // and priceOf() can never disagree. Unknown model -> null -> honestly 'unpriced'.
      pricing: prices.pricingBlock('anthropic', id),
      // Reasoning is now REAL on this adapter (see the THINKING + EFFORT note above), so the catalog must say
      // so — the model dock renders its effort control off exactly these three fields, and publishing an empty
      // list is what kept the control hidden while the capability sat there unused.
      supported_parameters: isClaude(id) ? ['tools', 'reasoning'] : ['tools'],
      supportsTools: true,
      supportsReasoning: isClaude(id),
      reasoningEfforts: effortsFor(id)
    };
  }

  function makeAnthropicProvider(opts) {
    opts = opts || {};
    const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('anthropic provider requires fetch (Node 18+) or opts.fetch');
    const key = opts.key || '';
    const baseUrl = cleanBaseUrl(opts.baseUrl);
    const defaultContext = Number(opts.defaultContext || DEFAULT_CONTEXT) || DEFAULT_CONTEXT;
    // The composition root already resolves this (registry profile `defaultReasoningEffort: 'medium'` for
    // anthropic) and has been handing it to this adapter since the provider seam existed — the adapter simply
    // dropped it on the floor. 'medium' is the fallback for a caller that passes nothing, matching the profile.
    const defaultEffort = normalizeEffort(opts.reasoningEffort || 'medium');
    const clock = (opts.clock && typeof opts.clock.now === 'function') ? opts.clock : null;
    let catalog = null;
    let catalogPromise = null;
    let catalogRewarmAt = 0;
    let rewarmKicked = false;

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

    // The output-token ceiling for this request. Precedence (first defined wins):
    //   explicit per-request max_tokens  →  the model's real catalog max (when the catalog is warm)  →
    //   opts.maxTokens (composition-root override)  →  SKYNET_ANTHROPIC_MAX_TOKENS env  →  32000 fallback.
    // Callers that pass max_tokens explicitly keep working unchanged; everyone else gets the model's true
    // ceiling instead of a silent 4096 truncation.
    function resolveMaxTokens(req) {
      const explicit = Number(req.max_tokens || req.maxTokens || 0);
      if (explicit > 0) return explicit;
      const m = findModel(req.model);   // hoisted decl; null until the catalog warms
      const catMax = Number(m && m.max_completion_tokens);
      if (Number.isFinite(catMax) && catMax > 0) return catMax;
      const optMax = Number(opts.maxTokens || 0);
      if (optMax > 0) return optMax;
      if (ENV_MAX_TOKENS > 0) return ENV_MAX_TOKENS;
      return FALLBACK_MAX_TOKENS;
    }

    /* PROMPT CACHING (2026-07-26). Anthropic renders a request as tools -> system -> messages and caches by
       PREFIX, so ONE breakpoint on the last system block also covers the entire tool catalogue sitting in
       front of it — which is where the bytes actually are. Measured at the wire on a fully placed floor:
       72 tools = 37.7KB = 59.7% of the request, re-sent on every turn of a run.

       What makes it work is that the prefix is stable for a run's lifetime, and that is not an accident of
       this file: loop.js resolves `tools` ONCE (loop.js:162) and re-sends the same array every turn, and
       extractLeadingSystem hoists only the LEADING system run — the mid-run <steering_note>/<loop_guard>/
       <continuation> injections land as user turns at the END, so they never shift the cached prefix.
       BEFORE ADDING ANYTHING TO THE SYSTEM PROMPT: a clock, a turn counter, or a remaining-budget line would
       be a fresh prefix every turn and would silently reduce this to a pure 1.25x surcharge.

       The second breakpoint rides the last message block, extending the cache over the conversation as it
       grows — which is where the bytes migrate late in a long run, once tool results outweigh the schemas.

       Economics: a cache READ bills ~0.1x input, a WRITE ~1.25x, so this pays from the second request on.
       A run that ends in ONE turn pays the 1.25x for nothing — the right trade when the ceiling is 40
       iterations. Under a model's minimum cacheable prefix Anthropic simply declines to cache; that is a
       silent no-op rather than an error, so there is nothing to feature-detect per model. */
    function breakpoint(blocks) {
      if (CACHE_OFF || !Array.isArray(blocks) || !blocks.length) return blocks;
      const i = blocks.length - 1;
      const last = blocks[i];
      if (!last || typeof last !== 'object') return blocks;
      // Only the documented cacheable block kinds may carry cache_control (system text, tool defs, and
      // message text/image/tool_use/tool_result/document). A THINKING block cannot — stamping one 400s the
      // request — and tool DEFINITIONS have no .type at all, which is why absence of .type passes.
      if (last.type && !CACHEABLE_BLOCK[last.type]) return blocks;
      // COPY, never stamp in place: userContentToBlocks passes native image blocks through BY REFERENCE, so
      // mutating the last block here would reach back into the CALLER's message array and persist.
      blocks[i] = Object.assign({}, last, { cache_control: cacheControl() });
      return blocks;
    }
    /* Put the model's thinking contract on the wire. Per-request `reasoningEffort` wins over the construction
       default, mirroring the openrouter adapter, so a single agent can be dialled without a new provider.
       CACHE NOTE: everything written here is a TOP-LEVEL key. Anthropic renders tools -> system -> messages
       and caches by prefix, so these keys never shift the cached prefix — but they DO invalidate it when they
       CHANGE, which is why effort is resolved once per request from a value that is stable for a run's life
       rather than recomputed per turn. */
    function applyThinking(body, req) {
      const model = body.model;
      if (!isClaude(model)) return;                        // third-party Anthropic-compatible endpoint: send nothing
      const allowed = effortsFor(model);
      const want = normalizeEffort(req.reasoningEffort || defaultEffort);
      const effort = (allowed.indexOf(want) >= 0) ? want : clampEffort(want, allowed);

      if (hasAny(model, LEGACY_CLAUDE)) {
        if (effort === 'none') return;                     // legacy has no disable switch — omitting IS the off state
        const cap = Number(body.max_tokens || 0);
        let budget = LEGACY_BUDGET[effort] || LEGACY_BUDGET.medium;
        // budget_tokens must be strictly BELOW max_tokens, and a budget that eats the whole ceiling starves the
        // answer into a truncation. Three quarters leaves the reply real room on a small-ceiling model.
        if (cap > 0) budget = Math.min(budget, Math.floor(cap * 0.75));
        if (budget < LEGACY_MIN_BUDGET) return;            // no room to think without starving the answer -> don't ask
        body.thinking = { type: 'enabled', budget_tokens: budget };
        return;
      }
      // MODERN. A disable is sent WITHOUT an effort: the wire refuses `{type:'disabled'}` above `high`, and an
      // omitted effort leaves the server default — the one value a disable is always accepted alongside.
      if (effort === 'none') { body.thinking = { type: 'disabled' }; return; }
      body.thinking = { type: 'adaptive' };
      body.output_config = Object.assign({}, body.output_config, { effort });
    }
    function buildBody(req) {
      const converted = messagesToAnthropic(req.messages || []);
      const body = {
        model: req.model,
        max_tokens: resolveMaxTokens(req),
        messages: converted.messages,
        stream: true
      };
      applyThinking(body, req);   // must run BEFORE the breakpoints: it can add top-level keys, never blocks
      const tools = toAnthropicTools(req.tools);
      if (tools) body.tools = tools;
      // One breakpoint for the whole static prefix. System is the preferred anchor because it sits AFTER the
      // tools and so caches both; with no system prompt the last tool is the only anchor that covers them.
      let systemAnchors = 1;
      if (converted.system) {
        // Two boundaries preserve both cross-run stable instructions and within-run full context.
        // Keep the exact text and system authority; only the wire blocks/cache markers change.
        const prefix = typeof req.cacheSystemPrefix === 'string' ? req.cacheSystemPrefix.trim() : '';
        const split = prefix && converted.system.startsWith(prefix) && converted.system.slice(prefix.length).trim();
        const texts = split ? [prefix, converted.system.slice(prefix.length)] : [converted.system];
        systemAnchors = texts.length;
        body.system = texts.map(text => breakpoint([{ type: 'text', text }])[0]);
      } else if (tools) breakpoint(tools);
      /* SLIDING TAIL ANCHORS: up to THREE messages (TWO with a split system) each carry a
         breakpoint — with the static-prefix anchor above, exactly the API's 4-breakpoint maximum.
         One trailing anchor was fragile for a mechanical reason: a breakpoint only looks BACK 20 content
         blocks for its predecessor, and a single agentic turn with parallel tool calls can append more
         than 20 blocks at once — the new anchor then misses the old one and the whole conversation
         re-bills as a cold write. Three sliding anchors keep every gap under the lookback window, and
         the anchors they slide off remain valid READ points as the tail grows. */
      const msgs = converted.messages;
      for (let k = Math.max(0, msgs.length - (4 - systemAnchors)); k < msgs.length; k++) {
        if (msgs[k]) breakpoint(msgs[k].content);
      }
      return body;
    }

    async function* stream(req) {
      req = req || {};
      maybeRewarmCatalog();
      const body = buildBody(req);
      let res;
      try { res = await requestWithRetry(body, req.signal); }
      catch (e) { if (isAbort(e, req.signal)) return; throw e; }
      const reader = timeouts.idleGuardedReader(res.body.getReader(), { signal: req.signal });
      const dec = new TextDecoder();
      let buf = '';
      const toolIndexOf = new Map();
      // In-flight thinking blocks, keyed by the wire's block index. A thinking block streams as
      // content_block_start -> thinking_delta* -> signature_delta -> content_block_stop, and only the
      // COMPLETED block (text + signature together) is worth handing back — an unsigned fragment fails
      // validation on replay, so it is assembled here and emitted once, at stop.
      const thinkingAt = new Map();
      let nextToolIndex = 0;
      let doneEmitted = false;
      let lastStopReason = '';
      let baseUsage = {};

      function parseLine(line) {
        const t = line.replace(/\r$/, '').trim();
        if (!t || t.charAt(0) === ':' || t.indexOf('event:') === 0) return null;
        if (t.indexOf('data:') !== 0) return null;
        const data = t.slice(5).trim();
        if (data === '[DONE]') return { done: true };
        try { return { json: JSON.parse(data) }; } catch (_) { return null; }
      }
      function* emitFrom(ev) {
        if (!ev || typeof ev !== 'object') return;
        if (ev.error) throw new Error('anthropic stream error: ' + ((ev.error && (ev.error.message || ev.error.type)) || 'unknown'));
        switch (ev.type) {
          case 'message_start':
            baseUsage = Object.assign({}, (ev.message && ev.message.usage) || {});
            if (ev.message && ev.message.usage) yield { type: 'usage', usage: normalizeUsage(ev.message.usage) };
            return;
          case 'content_block_start': {
            const block = ev.content_block || {};
            if (block.type === 'thinking') {
              thinkingAt.set(ev.index, { type: 'thinking', thinking: String(block.thinking || ''), signature: String(block.signature || '') });
              return;
            }
            if (block.type === 'redacted_thinking') {
              // Arrives whole — there are no deltas for an encrypted block.
              if (block.data) thinkingAt.set(ev.index, { type: 'redacted_thinking', data: String(block.data) });
              return;
            }
            if (block.type !== 'tool_use') return;
            const idx = nextToolIndex++;
            toolIndexOf.set(ev.index, idx);
            yield { type: 'tool_start', index: idx, id: block.id || ('call_' + idx), name: block.name || '' };
            if (block.input && Object.keys(block.input).length) yield { type: 'tool_args', index: idx, chunk: JSON.stringify(block.input) };
            return;
          }
          case 'content_block_delta': {
            const d = ev.delta || {};
            if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
              yield { type: 'text', delta: d.text };
              return;
            }
            // Reasoning NEVER becomes assistant text. The loop concatenates every 'text' event into the answer
            // it delivers, so routing a thinking_delta there would ship the model's scratchpad as the reply.
            if (d.type === 'thinking_delta' || d.type === 'signature_delta') {
              const acc = thinkingAt.get(ev.index);
              if (acc && acc.type === 'thinking') {
                if (d.type === 'thinking_delta' && typeof d.thinking === 'string') acc.thinking += d.thinking;
                else if (typeof d.signature === 'string' && d.signature) acc.signature += d.signature;
              }
              return;
            }
            if (d.type === 'input_json_delta') {
              const idx = toolIndexOf.get(ev.index);
              if (idx != null && typeof d.partial_json === 'string' && d.partial_json) yield { type: 'tool_args', index: idx, chunk: d.partial_json };
            }
            return;
          }
          case 'content_block_stop': {
            const think = thinkingAt.get(ev.index);
            if (think) {
              thinkingAt.delete(ev.index);
              // An unsigned thinking block cannot be replayed (the wire validates the signature), so it is
              // dropped here rather than handed to the loop to fail on the NEXT turn — a late, confusing error.
              if (think.type === 'redacted_thinking' || think.signature) yield { type: 'reasoning', block: think };
              return;
            }
            const idx = toolIndexOf.get(ev.index);
            if (idx != null) yield { type: 'tool_done', index: idx };
            return;
          }
          case 'message_delta': {
            const d = ev.delta || {};
            if (d.stop_reason) lastStopReason = d.stop_reason;
            if (ev.usage) yield { type: 'usage', usage: normalizeUsage(Object.assign({}, baseUsage, ev.usage)) };
            if (d.stop_reason && !doneEmitted) {
              doneEmitted = true;
              yield { type: 'done', finishReason: normalizeFinish(d.stop_reason) };
            }
            return;
          }
          case 'message_stop':
            if (!doneEmitted) {
              doneEmitted = true;
              yield { type: 'done', finishReason: normalizeFinish(lastStopReason || 'stop') };
            }
            return;
          default:
            return;
        }
      }

      try {
        let sawSentinel = false;                     // the protocol's own end-of-stream marker
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
        // whether the stream really ENDED or merely stopped arriving. A clean mid-generation FIN yields neither
        // a `message_stop` (which sets doneEmitted) nor a sentinel; the loop cannot otherwise tell that apart
        // from a finished answer, so it shipped the fragment as a completed — and $0 — delivery.
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
          res = await doFetch(baseUrl + '/messages', {
            method: 'POST',
            headers: headerBag(key),
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
        try { const j = await res.json(); detail = (j && j.error && (j.error.message || j.error.type)) || JSON.stringify(j); }
        catch (_) { try { detail = (await res.text()).slice(0, 300); } catch (_) {} }
        const err = new Error('anthropic http ' + res.status + ' - ' + detail);
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
            const res = await doFetch(baseUrl + '/models', { headers: headerBag(key, 'application/json') });
            if (!res.ok) return [];
            const j = await res.json();
            const raw = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : []);
            return raw.map(normalizeModel).filter(Boolean);
          } catch (_) { return []; }
        })();
      }
      catalog = await catalogPromise;
      if (!catalog.length) catalogPromise = null;
      return catalog;
    }
    async function listModels() { return (await loadCatalog()).map(m => Object.assign({}, m)); }
    function findModel(id) { return catalog ? catalog.find(m => m.id === id) : null; }
    function contextLimit(id) { const m = findModel(id); return (m && m.context_length) || defaultContext; }
    // Anthropic's API never reports a price, and returning null here left spentUsd at 0.00 for the whole run
    // — which silently disabled the per-run spend ceiling and the day/global pools (loop.js only stops when
    // spentUsd crosses the cap). Resolved off the dated list-rate table, independent of catalog warm state so
    // the cap works from the first turn; an unrecognized model still returns null and stays 'unpriced'.
    function priceOf(id) { return prices.priceOf('anthropic', id); }
    function supportsTools(id) { const m = findModel(id); return m ? m.supportsTools : true; }
    // Resolved from the model NAME, not the warm catalog: /v1/models publishes no capability data, and the
    // dock asks this before a catalog fetch has necessarily landed.
    function reasoningEfforts(id) { return effortsFor(id); }

    return { stream, listModels, contextLimit, priceOf, supportsTools, reasoningEfforts };
  }

  return { makeAnthropicProvider, _internals: { messagesToAnthropic, toAnthropicTools, normalizeUsage, normalizeModel, cleanBaseUrl } };
});
