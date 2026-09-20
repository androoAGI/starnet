/* sidecar/providers/gemini.js - native Google Gemini GenerateContent adapter.
   Keeps the harness transcript/tool seam stable while speaking Gemini's
   contents/tools/functionCall wire. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./provider.js'), require('./errorClass.js'), require('./prices.js'), require('./toolschema.js'));
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.gemini = factory(root.SK.providers.provider, root.SK.providers.errorClass, root.SK.providers.prices, root.SK.providers.toolschema); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provider, errorClass, prices, toolschema) {
  'use strict';

  const classifyApiError = errorClass.classifyApiError;
  const timeouts = provider.timeouts;
  const isAbort = provider.runtime.isAbort;
  const delay = provider.runtime.abortableDelay;
  const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const RETRY_DELAYS = [400, 1200];
  const REWARM_MIN_MS = 5 * 60 * 1000;

  function cleanBaseUrl(value) {
    return String(value || DEFAULT_BASE).trim().replace(/\/+$/, '');
  }
  function headerBag(key, accept) {
    const h = { 'Content-Type': 'application/json', 'Accept': accept || 'text/event-stream' };
    if (key) h['x-goog-api-key'] = key;
    return h;
  }
  function modelPath(id) {
    const s = String(id || '').trim();
    if (!s) return 'models/gemini-pro';
    return s.indexOf('/') >= 0 ? s.replace(/^\/+/, '') : ('models/' + s);
  }
  function stripModelPrefix(id) {
    return String(id || '').replace(/^models\//, '');
  }
  function safeJson(value, fallback) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string') return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
  }
  function responseObject(content) {
    const parsed = safeJson(content, null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return { content: String(content == null ? '' : content) };
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
  function contentToParts(content) {
    const text = textFromContent(content);
    return text ? [{ text }] : [];
  }
  // USER ATTACHMENTS (COMMS): a user turn may carry image parts alongside its text — the run path expands a
  // Commander's attached photo into an {type:'image_url', image_url:{url}} block before this adapter sees it.
  // Gemini's inline-image shape is {inlineData:{mimeType, data(base64, no data: prefix)}}, so map image_url → that.
  // Only USER messages get this; an unrecognized part degrades to its text or is dropped — never throws.
  function geminiInlineData(url) {
    const m = /^data:([^;,]*?)(;base64)?,([\s\S]*)$/.exec(String(url == null ? '' : url));
    if (!m) return null;
    const mimeType = (m[1] || 'image/png').toLowerCase();
    const data = m[2] ? (m[3] || '') : Buffer.from(decodeURIComponent(m[3] || ''), 'utf8').toString('base64');
    return { inlineData: { mimeType, data } };
  }
  function userContentToParts(content) {
    if (content == null) return [];
    if (typeof content === 'string') return content ? [{ text: content }] : [];
    if (!Array.isArray(content)) return contentToParts(content);
    const out = [];
    for (const p of content) {
      if (typeof p === 'string') { if (p) out.push({ text: p }); continue; }
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'text' && typeof p.text === 'string') { if (p.text) out.push({ text: p.text }); continue; }
      if (p.type === 'image_url') { const d = geminiInlineData(p.image_url && (p.image_url.url != null ? p.image_url.url : p.image_url)); if (d) out.push(d); continue; }
      if (p.inlineData) { out.push(p); continue; }   // already a native Gemini inline-data part
      if (typeof p.text === 'string' && p.text) out.push({ text: p.text });
    }
    return out;
  }
  function appendContent(out, role, parts) {
    if (!parts || !parts.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.parts)) {
      last.parts = last.parts.concat(parts);
      return;
    }
    out.push({ role, parts });
  }
  function extractLeadingSystem(messages) {
    const system = [];
    let i = 0;
    for (; i < (messages || []).length; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== 'system') break;
      const text = textFromContent(msg.content).trim();
      if (text) system.push({ text });
    }
    return { systemInstruction: system.length ? { parts: system } : null, rest: (messages || []).slice(i) };
  }
  // THOUGHT SIGNATURES (Gemini 3 wire law). A functionCall part arrives with an opaque `thoughtSignature`
  // that the NEXT request must echo on that same functionCall part when the history replays — omit it and
  // every tool round-trip 400s ("Function call is missing a thought_signature"), which kills the run on its
  // FIRST internal tool call. The loop already round-trips opaque adapter blocks via msg.reasoning (built
  // for Anthropic's signed thinking, stripped on provider/model switch), so the signature rides there keyed
  // by the harness call id — never as a new field on tool_calls, which openai-compatible ships verbatim.
  function toolSignaturesOf(reasoning) {
    const map = Object.create(null);
    if (!Array.isArray(reasoning)) return map;
    for (const b of reasoning) {
      if (b && b.type === 'gemini_tool_signature' && b.callId && typeof b.signature === 'string' && b.signature) {
        map[String(b.callId)] = b.signature;
      }
    }
    return map;
  }
  function messagesToGemini(messages) {
    const picked = extractLeadingSystem(messages || []);
    const contents = [];
    const callNames = Object.create(null);
    for (const msg of picked.rest) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role === 'tool') {
        const callId = String(msg.tool_call_id || msg.call_id || '');
        const name = callNames[callId] || msg.name || callId || 'tool';
        appendContent(contents, 'user', [{ functionResponse: { name, response: responseObject(msg.content) } }]);
        continue;
      }
      if (msg.role === 'assistant') {
        const parts = contentToParts(msg.content);
        const signatures = toolSignaturesOf(msg.reasoning);
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const fn = (tc && tc.function) || {};
            const name = String(fn.name || '').trim();
            if (!name) continue;
            const callId = String((tc && tc.id) || fn.call_id || '');
            if (callId) callNames[callId] = name;
            const part = { functionCall: { name, args: safeJson(fn.arguments, {}) } };
            if (callId && signatures[callId]) part.thoughtSignature = signatures[callId];
            parts.push(part);
          }
        }
        appendContent(contents, 'model', parts);
        continue;
      }
      appendContent(contents, 'user', userContentToParts(msg.content));
    }
    return { systemInstruction: picked.systemInstruction, contents };
  }
  function toGeminiTools(tools) {
    if (!tools || !tools.length) return null;
    const declarations = [];
    for (const item of tools) {
      const fn = (item && item.function) || {};
      const name = String(fn.name || '').trim();
      if (!name) continue;
      // A third-party MCP `inputSchema` reaches here verbatim (mcp/translate.js passes it through and
      // registry.wireFormat() hands it straight over). Gemini's Schema is an OpenAPI-3.0 subset and
      // answers an unknown field — `$schema`, `additionalProperties`, `$ref`, `oneOf` … — with a 400
      // on EVERY turn, so one zod-authored connector would take out every Gemini run. Prune to the
      // documented field set here, at the wire seam that owns the constraint.
      const decl = { name, description: fn.description || '' };
      const params = toolschema.forGemini(fn.parameters || {});
      if (!toolschema.isEmptyObjectSchema(params)) decl.parameters = params;
      declarations.push(decl);
    }
    return declarations.length ? [{ functionDeclarations: declarations }] : null;
  }
  function normalizeUsage(u) {
    u = u || {};
    const prompt = Number(u.promptTokenCount || 0) || 0;
    const out = Number(u.candidatesTokenCount || u.outputTokenCount || 0) || 0;
    const total = Number(u.totalTokenCount || 0) || (prompt + out);
    return {
      prompt_tokens: prompt,
      completion_tokens: out,
      total_tokens: total,
      prompt_tokens_details: { cached_tokens: Number(u.cachedContentTokenCount || 0) || 0 },
      reasoning_tokens: Number(u.thoughtsTokenCount || 0) || 0
    };
  }
  function finishFor(reason, sawToolCall) {
    const r = String(reason || '').trim().toUpperCase();
    if (sawToolCall && (!r || r === 'STOP')) return 'tool_calls';
    if (!r || r === 'STOP') return 'stop';
    if (r === 'MAX_TOKENS') return 'length';
    if (/SAFETY|RECITATION|BLOCKLIST|PROHIBITED|SPII/.test(r)) return 'content_filter';
    return 'error';
  }
  /* The 2.5 family is the one that speaks `thinkingBudget`; everything newer speaks `thinkingLevel`. Matched
     on the version rather than a model allowlist so a new 2.5-series name still routes correctly. */
  const LEGACY_GEMINI_RE = /gemini[-_ ]?2\.?5/;
  // Every value sits under the smallest documented cap in the 2.5 family (flash / flash-lite cap at 24576),
  // so one table is safe across all of them rather than needing a per-model ceiling.
  const LEGACY_BUDGET = { none: 0, minimal: 512, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 24576 };
  const MODERN_LEVEL = { none: 'MINIMAL', minimal: 'MINIMAL', low: 'LOW', medium: 'MEDIUM', high: 'HIGH', xhigh: 'HIGH', max: 'HIGH' };
  function normalizeGeminiEffort(v) {
    const k = String(v == null ? '' : v).trim().toLowerCase().replace(/[\s_-]+/g, '');
    const map = { off: 'none', none: 'none', no: 'none', disabled: 'none', min: 'minimal', minimal: 'minimal',
      low: 'low', med: 'medium', mid: 'medium', medium: 'medium', high: 'high',
      extra: 'xhigh', xtra: 'xhigh', extrahigh: 'xhigh', xhigh: 'xhigh', max: 'max' };
    return map[k] || 'medium';
  }
  // What a given model actually accepts. The 2.5 contract can genuinely switch thinking OFF; the modern one
  // cannot, so 'none' is not offered there — a control that silently does nothing is worse than no control.
  function geminiEffortsFor(id) {
    const model = String(id || '').toLowerCase();
    if (model.indexOf('gemini') < 0) return ['none'];
    if (LEGACY_GEMINI_RE.test(model)) return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    return ['minimal', 'low', 'medium', 'high'];
  }

  function normalizeModel(m) {
    const raw = (m && (m.name || m.id || m.model)) ? String(m.name || m.id || m.model) : '';
    const id = stripModelPrefix(raw);
    if (!id) return null;
    const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods.slice() : [];
    const canGenerate = !methods.length || methods.indexOf('generateContent') >= 0 || methods.indexOf('streamGenerateContent') >= 0;
    return {
      id,
      name: m.displayName || m.name || id,
      context_length: Number(m.inputTokenLimit || m.context_length || 0) || 0,
      max_completion_tokens: Number(m.outputTokenLimit || m.max_completion_tokens || 0) || null,
      // /v1beta/models reports no pricing, so this comes from the dated list-rate table (prices.js) rather
      // than the wire. Same {prompt, completion} per-token shape every other adapter publishes, so
      // listModels() and priceOf() can never disagree. Unknown model -> null -> honestly 'unpriced'.
      pricing: prices.pricingBlock('gemini', id),
      // Reasoning is real on this adapter now, so the catalog must say so — the model dock renders its effort
      // control off exactly these fields, and an empty list is what kept the control hidden.
      supported_parameters: canGenerate ? ['tools', 'reasoning'] : [],
      supportsTools: canGenerate ? true : null,
      supportsReasoning: String(id || '').toLowerCase().indexOf('gemini') >= 0,
      reasoningEfforts: geminiEffortsFor(id)
    };
  }

  function makeGeminiProvider(opts) {
    opts = opts || {};
    const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('gemini provider requires fetch (Node 18+) or opts.fetch');
    const key = opts.key || '';
    const baseUrl = cleanBaseUrl(opts.baseUrl);
    const defaultContext = Number(opts.defaultContext || 0) || 0;
    // The composition root has resolved this and handed it here since the seam existed; the adapter ignored it.
    const defaultEffort = normalizeGeminiEffort(opts.reasoningEffort || 'medium');
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

    /* THINKING (2026-07-27). Like the Anthropic adapter, this one published `['none']` and sent no thinking
       parameter at all, so a Commander on their own Gemini key ran a NON-THINKING Gemini. Two contracts, and
       the model decides which — sending BOTH to a Gemini 3 model is a documented error:

         MODERN (Gemini 3 and later)  ->  thinkingConfig.thinkingLevel: MINIMAL|LOW|MEDIUM|HIGH
         LEGACY (Gemini 2.5 family)   ->  thinkingConfig.thinkingBudget: <tokens>   (0 = off, -1 = automatic)

       Same "default to newest" shape used for Anthropic, and for the same reason: an allowlist of modern
       versions goes stale the moment a name ships without a recognized number, and the failure is silent.

       `includeThoughts` is deliberately NEVER set. We do not want the scratchpad on the wire — and its `false`
       default is documented as silently ignored on some models, which is why the reader filters thought parts
       regardless (see the stream loop). */
    function applyThinking(body, req) {
      const model = String(req.model || '').toLowerCase();
      if (model.indexOf('gemini') < 0) return;            // a non-Gemini model on a Gemini-shaped endpoint
      const want = normalizeGeminiEffort(req.reasoningEffort || defaultEffort);
      const cfg = {};
      if (LEGACY_GEMINI_RE.test(model)) {
        const budget = LEGACY_BUDGET[want];
        if (budget == null) return;
        cfg.thinkingBudget = budget;                       // 0 disables on the 2.5 family
      } else {
        // No level means "off" on this contract — MINIMAL is the floor, and some Gemini 3 models refuse to
        // stop thinking at all, so asking for none honestly means asking for as little as the model allows.
        cfg.thinkingLevel = MODERN_LEVEL[want] || 'MEDIUM';
      }
      body.generationConfig = Object.assign({}, body.generationConfig, { thinkingConfig: cfg });
    }
    function buildBody(req) {
      const converted = messagesToGemini(req.messages || []);
      const body = { contents: converted.contents };
      if (converted.systemInstruction) body.systemInstruction = converted.systemInstruction;
      const tools = toGeminiTools(req.tools);
      if (tools) body.tools = tools;
      applyThinking(body, req);
      return body;
    }

    async function* stream(req) {
      req = req || {};
      maybeRewarmCatalog();
      const body = buildBody(req);
      let res;
      try { res = await requestWithRetry(req.model, body, req.signal); }
      catch (e) { if (isAbort(e, req.signal)) return; throw e; }
      const reader = timeouts.idleGuardedReader(res.body.getReader(), { signal: req.signal, firstByteMs: timeouts.firstByteMs() });
      const dec = new TextDecoder();
      let buf = '';
      const toolIndexOf = new Map();
      const argsSentFor = new Set();   // dense tool indices we've already emitted nonempty args for (dup-call guard)
      let dupToolSeq = 0;              // disambiguates a repeated ci:pi:name that is actually a NEW call
      let nextToolIndex = 0;
      let sawToolCall = false;
      let doneEmitted = false;

      function parseLine(line) {
        const t = line.replace(/\r$/, '').trim();
        if (!t || t.charAt(0) === ':' || t.indexOf('event:') === 0) return null;
        if (t.indexOf('data:') !== 0) return null;
        const data = t.slice(5).trim();
        if (data === '[DONE]') return { done: true };
        try { return { json: JSON.parse(data) }; } catch (_) { return null; }
      }
      function* emitFrom(j) {
        if (!j || typeof j !== 'object') return;
        if (j.error) throw new Error('gemini stream error: ' + ((j.error && (j.error.message || j.error.status || j.error.code)) || 'unknown'));
        const candidates = Array.isArray(j.candidates) ? j.candidates : [];
        let usageEmittedForFrame = false;   // usage rides the done-carrying frame; emit it exactly once, BEFORE done
        for (let ci = 0; ci < candidates.length; ci++) {
          const c = candidates[ci] || {};
          const parts = (((c.content || {}).parts) || []);
          for (let pi = 0; pi < parts.length; pi++) {
            const part = parts[pi] || {};
            /* A THOUGHT PART IS NOT THE ANSWER. Gemini marks reasoning with `thought: true` on a part that
               ALSO carries `text`, so the old unconditional branch below shipped the model's scratchpad to the
               Commander as its reply. This was reachable before any thinking parameter existed here: the
               `includeThoughts: false` default is documented as silently ignored on some models, so the only
               safe posture is to filter at the READER rather than trust the request. Emitted as `reasoning`
               (the loop parks it, never concatenating it into the answer) so nothing is lost either. */
            if (part.thought === true) {
              if (typeof part.text === 'string' && part.text) yield { type: 'reasoning', block: { type: 'gemini_thought', text: part.text } };
              continue;
            }
            if (typeof part.text === 'string' && part.text) yield { type: 'text', delta: part.text };
            if (part.functionCall) {
              // Gemini normally delivers each functionCall WHOLE (complete args) in a single part, so ci:pi:name
              // uniquely maps a call. But if the same ci:pi:name recurs in a LATER SSE frame carrying its OWN
              // nonempty args, that is a SECOND, distinct tool call — reusing the index would make the consumer
              // concatenate two whole JSON objects ({"a":1}{"b":2}) into invalid args. So: if a key repeats AND we
              // already emitted nonempty args for it, treat the recurrence as a NEW call (suffix a counter to force
              // a fresh key + index + tool_start). Empty-arg recurrences keep the original mapping (no corruption risk).
              const argsStr = part.functionCall.args != null ? JSON.stringify(part.functionCall.args || {}) : '';
              const hasArgs = argsStr && argsStr !== '{}';
              let keyOf = ci + ':' + pi + ':' + (part.functionCall.name || nextToolIndex);
              if (toolIndexOf.has(keyOf) && argsSentFor.has(toolIndexOf.get(keyOf)) && hasArgs) {
                keyOf = keyOf + '#' + (++dupToolSeq);   // a distinct repeat call -> its own index, never arg-concatenated
              }
              let idx = toolIndexOf.get(keyOf);
              if (idx == null) {
                idx = nextToolIndex++;
                toolIndexOf.set(keyOf, idx);
                sawToolCall = true;
                yield { type: 'tool_start', index: idx, id: part.functionCall.id || ('call_' + idx), name: part.functionCall.name || '' };
              }
              // The part's thoughtSignature MUST come back on this call's functionCall part next turn (Gemini 3
              // rejects the whole request without it). Parked as an opaque reasoning block keyed by the same call
              // id tool_start published; messagesToGemini() reattaches it on replay.
              if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
                yield { type: 'reasoning', block: { type: 'gemini_tool_signature', callId: part.functionCall.id || ('call_' + idx), signature: part.thoughtSignature } };
              }
              if (part.functionCall.args != null) { yield { type: 'tool_args', index: idx, chunk: argsStr }; if (hasArgs) argsSentFor.add(idx); }
              yield { type: 'tool_done', index: idx };
            }
          }
          if (c.finishReason && !doneEmitted) {
            // USAGE BEFORE DONE (adapter contract): Gemini's final frame carries finishReason and
            // usageMetadata together, and every other adapter (anthropic/codex/openrouter) yields usage
            // first. Emitting done first lost the tokens on any consumer that breaks at done (auxVisionCall)
            // — a Gemini-only silent under-bill.
            if (j.usageMetadata) { yield { type: 'usage', usage: normalizeUsage(j.usageMetadata) }; usageEmittedForFrame = true; }
            doneEmitted = true;
            yield { type: 'done', finishReason: finishFor(c.finishReason, sawToolCall) };
          }
        }
        if (j.usageMetadata && !usageEmittedForFrame) yield { type: 'usage', usage: normalizeUsage(j.usageMetadata) };
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
        // a candidate finishReason (which sets doneEmitted) nor a sentinel; the loop cannot otherwise tell that
        // apart from a finished answer, so it shipped the fragment as a completed — and $0 — delivery.
        if (!doneEmitted) yield { type: 'done', finishReason: null, truncated: !sawSentinel };
      } catch (e) {
        if (isAbort(e, req.signal)) return;
        throw e;
      }
    }

    async function requestWithRetry(model, body, signal) {
      for (let attempt = 0; ; attempt++) {
        if (signal && signal.aborted) throw abortError();
        let res;
        // Fresh connect guard per attempt; disarmed the instant the fetch settles so the ceiling can't abort
        // the streaming body (a connect expiry rejects as a `timeout`, a user-cancel as AbortError).
        const guard = timeouts.connectGuard(signal);
        try {
          res = await doFetch(baseUrl + '/' + modelPath(model) + ':streamGenerateContent?alt=sse', {
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
        try { const j = await res.json(); detail = (j && j.error && (j.error.message || j.error.status || j.error.code)) || JSON.stringify(j); }
        catch (_) { try { detail = (await res.text()).slice(0, 300); } catch (_) {} }
        const err = new Error('gemini http ' + res.status + ' - ' + detail);
        err.status = res.status;
        err.headers = res.headers;
        const cls = classifyApiError(err, { model });
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
            const raw = Array.isArray(j.models) ? j.models : (Array.isArray(j.data) ? j.data : []);
            return raw.map(normalizeModel).filter(Boolean);
          } catch (_) { return []; }
        })();
      }
      catalog = await catalogPromise;
      if (!catalog.length) catalogPromise = null;
      return catalog;
    }
    async function listModels() { return (await loadCatalog()).map(m => Object.assign({}, m)); }
    function findModel(id) {
      const clean = stripModelPrefix(id);
      return catalog ? catalog.find(m => m.id === clean || m.id === id) : null;
    }
    function contextLimit(id) { const m = findModel(id); return (m && m.context_length) || defaultContext; }
    // Gemini's API never reports a price, and returning null here left spentUsd at 0.00 for the whole run —
    // which silently disabled the per-run spend ceiling and the day/global pools (loop.js only stops when
    // spentUsd crosses the cap). Resolved off the dated list-rate table, independent of catalog warm state so
    // the cap works from the first turn; an unrecognized model still returns null and stays 'unpriced'.
    function priceOf(id) { return prices.priceOf('gemini', id); }
    function supportsTools(id) { const m = findModel(id); return m ? m.supportsTools : true; }
    // Resolved from the model NAME: /v1beta/models publishes no capability data, and the dock asks before a
    // catalog fetch has necessarily landed.
    function reasoningEfforts(id) { return geminiEffortsFor(id); }

    return { stream, listModels, contextLimit, priceOf, supportsTools, reasoningEfforts };
  }

  return { makeGeminiProvider, _internals: { messagesToGemini, toGeminiTools, normalizeUsage, normalizeModel, modelPath, cleanBaseUrl, finishFor } };
});
