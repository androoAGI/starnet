/* sidecar/providers/codex.js — the ONLY module that knows the OpenAI Codex (ChatGPT-subscription) wire.
   Implements the LLMProvider seam (provider.js): stream(req) -> AsyncIterable<HarnessEvent>, plus
   listModels / contextLimit / priceOf / supportsTools. `fetch` is INJECTED (Node global in the host, a
   fake Response in tests).

   IMPORTANT — this is a DIFFERENT wire than openrouter.js. Inference goes to OpenAI's *Responses* API
   (chatgpt.com/backend-api/codex/responses), not chat/completions. So two things differ:
     · REQUEST: chat-style `messages` are converted to Responses `input[]` items — the system prompt is
       lifted into `instructions`, user/assistant turns become typed-content messages (input_text /
       output_text), assistant tool calls become `function_call` items, and tool results become
       `function_call_output` items. Tools are the Responses function-tool schema.
     · STREAM: the SSE event types are `response.output_text.delta`, `response.function_call_arguments.*`,
       `response.output_item.added/done`, `response.completed`, `response.failed` — NOT `choices[].delta`.
   We normalize both back to the SAME HarnessEvent stream the proven loop already consumes, so nothing
   downstream of the provider seam changes.

   Auth is an OAuth access_token (a JWT), passed as `Authorization: Bearer …` — there is no API key. The
   token's freshness (refresh before expiry) is the sidecar's job; this module uses what it's given, with
   ONE recovery seam: on an HTTP 401 the SERVER is the authority on expiry — the sidecar's local-clock
   check can pass while the token is dead (clock skew, an exp claim we couldn't read), which stranded a
   real user in a "token is expired" loop that Settings still called VERIFIED (2026-08-10). So when the
   caller injects opts.renewToken (async, returns a fresh access_token), a 401 triggers ONE renew+retry
   before the error is surfaced. No renewToken injected = byte-identical to the old behavior. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./provider.js'), require('./errorClass.js'));
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.codex = factory(root.SK.providers.provider, root.SK.providers.errorClass); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provider, errorClass) {
  'use strict';

  const normalizeFinish = provider.normalizeFinish;
  const classifyApiError = errorClass.classifyApiError;
  const timeouts = provider.timeouts;
  const isAbort = provider.runtime.isAbort;
  const delay = provider.runtime.abortableDelay;
  const BASE = 'https://chatgpt.com/backend-api/codex';

  // The ChatGPT-account Codex backend exposes its OWN model list (DIFFERENT from the public OpenAI API
  // catalog) and the lineup drifts — slugs like gpt-5.1-codex* that the Codex CLI's public catalog still
  // lists are 400-rejected by the OAuth backend ("model is not supported when using Codex with a ChatGPT
  // account"). So the real list is DISCOVERED live (listModels -> GET /models, per the reference harness' codex model discovery); this
  // static list is only the OFFLINE FALLBACK (curated to the slugs verified accepted as of 2026-05/06). All
  // Codex models are tool-capable; a subscription is flat-rate, so per-token price is null (cost = $0).
  const CLIENT_VERSION = '1.0.0';   // chatgpt.com/backend-api/codex/models?client_version=…
  // The ChatGPT-account Codex backend accepts EXACTLY these slugs (verified live 2026-07-02); every model
  // exposes the four reasoning levels low/medium/high/xhigh (no 'none', no 'minimal'). The Codex CLI's
  // "Fast mode" is just the 'low' level surfaced as a variant — there is no separate fast slug.
  const CODEX_EFFORT_LIST = ['low', 'medium', 'high', 'xhigh'];
  const STATIC_MODELS = [
    { id: 'gpt-5.5',             displayName: 'GPT-5.5',             context_length: 272000, max_completion_tokens: 128000, supportsTools: true, reasoningEfforts: CODEX_EFFORT_LIST.slice(), defaultReasoningLevel: 'medium' },
    { id: 'gpt-5.4',             displayName: 'GPT-5.4',             context_length: 272000, max_completion_tokens: 128000, supportsTools: true, reasoningEfforts: CODEX_EFFORT_LIST.slice(), defaultReasoningLevel: 'medium' },
    { id: 'gpt-5.4-mini',        displayName: 'GPT-5.4 mini',        context_length: 272000, max_completion_tokens: 128000, supportsTools: true, reasoningEfforts: CODEX_EFFORT_LIST.slice(), defaultReasoningLevel: 'medium' },
    { id: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3 Codex Spark', context_length: 272000, max_completion_tokens: 128000, supportsTools: true, reasoningEfforts: CODEX_EFFORT_LIST.slice(), defaultReasoningLevel: 'high' }
  ];
  const DEFAULT_MODEL = 'gpt-5.5';

  const RETRY_DELAYS = [400, 1200];   // up to 2 pre-stream retries (no jitter -> determinism)

  // ---- request building: chat messages -> Responses input items --------------------------------------

  // Multimodal-safe text part. Responses rejects input_text inside an assistant message and output_text
  // inside a user message, so the part type follows the role.
  function textPart(role, text) { return { type: role === 'assistant' ? 'output_text' : 'input_text', text: String(text == null ? '' : text) }; }

  function contentToParts(content, role) {
    if (content == null) return [];
    if (typeof content === 'string') return content ? [textPart(role, content)] : [];
    if (Array.isArray(content)) {
      const out = [];
      for (const p of content) {
        if (typeof p === 'string') { if (p) out.push(textPart(role, p)); continue; }
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') { out.push(textPart(role, p.text || '')); continue; }
        if (p.type === 'image_url' || p.type === 'input_image') {
          const url = (p.image_url && (p.image_url.url || p.image_url)) || p.url || '';
          if (url) out.push({ type: 'input_image', image_url: url });
        }
      }
      return out;
    }
    return [textPart(role, String(content))];
  }

  // Lift the leading system message into `instructions`; return { instructions, rest }.
  function extractInstructions(messages) {
    let instructions = '';
    let rest = messages || [];
    if (rest.length && rest[0] && rest[0].role === 'system') {
      instructions = String(rest[0].content == null ? '' : rest[0].content).trim();
      rest = rest.slice(1);
    }
    return { instructions, rest };
  }

  function messagesToInput(messages) {
    /* TOOL-PAIR REPAIR (2026-08-25). The Responses backend 400-rejects the WHOLE request when the replayed
       transcript contains a function_call_output with no matching function_call ("No tool call found for
       function call output with call_id …") — or a function_call with no output. A restart/resume/compaction
       seam that loses one side of a tool pair therefore doesn't just lose a message: it bricks the chat
       PERMANENTLY, because every later turn replays the same orphan and dies on the same 400 (the reported
       Telegram loop). Enforce the invariant here, at the only module that knows this wire's rule:
         · an orphaned or duplicate tool result is downgraded to a plain user message — content preserved,
           truthfully labeled as recovered, impossible to 400;
         · a tool call whose result never made it into the transcript gets a synthesized "no result recorded"
           output spliced directly after it, so the model reissues the call instead of the request dying.
       A well-formed transcript passes through byte-identical. */
    const input = [];
    const open = new Map();      // call_id -> index in `input` of its function_call item (awaiting its output)
    const answered = new Set();  // call_ids already paired in this request
    let minted = 0;              // deterministic ids for assistant tool_calls that arrived with none
    for (const msg of (messages || [])) {
      if (!msg || typeof msg !== 'object') continue;
      const role = msg.role;
      if (role === 'system') { input.push({ role: 'user', content: contentToParts(msg.content, 'user') }); continue; }
      if (role === 'tool') {
        // a chat tool-result message -> a Responses function_call_output item (iff its call is in this request)
        const callId = String(msg.tool_call_id || msg.call_id || '');
        const body = String(msg.content == null ? '' : msg.content);
        if (callId && open.has(callId)) {
          input.push({ type: 'function_call_output', call_id: callId, output: body });
          open.delete(callId); answered.add(callId);
        } else {
          // orphan (its call was lost from the transcript) or duplicate: keep the information, drop the pairing
          input.push({ role: 'user', content: [textPart('user', '[recovered tool result' + (callId ? ' ' + callId : '') + ' — its originating call is not in this transcript]\n' + body)] });
        }
        continue;
      }
      if (role === 'assistant') {
        const parts = contentToParts(msg.content, 'assistant');
        if (parts.length) input.push({ role: 'assistant', content: parts });
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const fn = (tc && tc.function) || {};
            const callId = String(tc.id || fn.call_id || '') || ('call_local_' + (++minted));
            input.push({
              type: 'function_call',
              call_id: callId,
              name: fn.name || '',
              arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {})
            });
            if (!answered.has(callId)) open.set(callId, input.length - 1);
          }
        }
        continue;
      }
      // default: user (or any other) role -> a user message
      input.push({ role: 'user', content: contentToParts(msg.content, role === 'assistant' ? 'assistant' : 'user') });
    }
    // calls that never got a result: pair each in place so the request is valid and the model may reissue it
    const unpaired = Array.from(open.entries()).sort((a, b) => b[1] - a[1]);   // descending, so splices don't shift earlier positions
    for (const [callId, pos] of unpaired) {
      input.splice(pos + 1, 0, { type: 'function_call_output', call_id: callId, output: '[interrupted — this call produced no recorded result. Reissue it if it is still needed.]' });
    }
    return input;
  }

  function toResponsesTools(tools) {
    if (!tools || !tools.length) return null;
    const out = [];
    for (const item of tools) {
      const fn = (item && item.function) || {};
      const name = fn.name;
      if (typeof name !== 'string' || !name.trim()) continue;
      out.push({ type: 'function', name: name, description: fn.description || '', strict: false, parameters: fn.parameters || { type: 'object', properties: {} } });
    }
    return out.length ? out : null;
  }
  const DEFAULT_REASONING_EFFORT = 'low';
  function normalizeCodexReasoningEffort(value) {
    const key = String(value || DEFAULT_REASONING_EFFORT).trim().toLowerCase().replace(/[\s_-]+/g, '');
    const map = {
      off: 'none', none: 'none', no: 'none', disabled: 'none',
      min: 'low', minimal: 'low',
      low: 'low',
      med: 'medium', mid: 'medium', medium: 'medium',
      high: 'high',
      extra: 'xhigh', xtra: 'xhigh', extrahigh: 'xhigh', xhigh: 'xhigh', max: 'xhigh'
    };
    return map[key] || DEFAULT_REASONING_EFFORT;
  }

  function makeCodexProvider(opts) {
    opts = opts || {};
    const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('codex provider requires fetch (Node 18+) or opts.fetch');
    let token = opts.token || '';   // mutable: a 401-triggered renew swaps in the fresh access_token
    const renew = (typeof opts.renewToken === 'function') ? opts.renewToken : null;
    const baseUrl = (opts.baseUrl || BASE).replace(/\/$/, '');
    const normalizeEffort = typeof opts.normalizeReasoningEffort === 'function' ? opts.normalizeReasoningEffort : normalizeCodexReasoningEffort;
    const reasoningEffort = normalizeEffort(opts.reasoningEffort || DEFAULT_REASONING_EFFORT);

    function buildBody(req) {
      const { instructions, rest } = extractInstructions(req.messages || []);
      const effort = normalizeEffort(req.reasoningEffort || reasoningEffort);
      const body = {
        model: req.model || DEFAULT_MODEL,
        instructions: instructions || 'You are a helpful assistant.',
        input: messagesToInput(rest),
        store: false,
        stream: true,
        reasoning: { effort, summary: 'auto' }
      };
      // Ask the backend to echo encrypted reasoning so multi-turn chains stay coherent when thinking is enabled.
      if (effort !== 'none') body.include = ['reasoning.encrypted_content'];
      const tools = toResponsesTools(req.tools);
      if (tools) { body.tools = tools; body.tool_choice = 'auto'; body.parallel_tool_calls = true; }
      return body;
    }

    async function* stream(req) {
      const body = buildBody(req);
      let res;
      try { res = await requestWithRetry(body, req.signal); }
      catch (e) { if (isAbort(e, req.signal)) return; throw e; }
      const reader = timeouts.idleGuardedReader(res.body.getReader(), { signal: req.signal, firstByteMs: timeouts.firstByteMs() });
      const dec = new TextDecoder();
      let buf = '';

      // Responses streams function calls as discrete output items addressed by `output_index`. Map each
      // index we've seen to a small, dense tool index for the HarnessEvent stream (and remember which
      // were function_call items so we can emit tool_done + compute the finish reason).
      const toolIndexOf = new Map();   // output_index -> harness tool index
      const itemKind = new Map();      // output_index -> 'function_call' | 'message' | 'reasoning'
      const argsLen = new Map();       // output_index -> chars of tool-args already emitted (de-dupe across arg shapes)
      let nextToolIndex = 0;
      let sawToolCall = false;
      let doneEmitted = false;         // exactly one terminal event per stream (see STREAM-END TRUTH below)

      // parse ONE raw SSE line -> a control signal or a JSON event payload. Responses SSE puts the event
      // name on both an `event:` line AND inside `data.type`; we switch on `data.type`.
      function parseLine(line) {
        const t = line.replace(/\r$/, '').trim();
        if (!t || t.charAt(0) === ':') return null;
        if (t.indexOf('data:') !== 0) return null;        // ignore `event:` lines; the type is in the data
        const data = t.slice(5).trim();
        if (data === '[DONE]') return { done: true };
        try { return { json: JSON.parse(data) }; } catch (e) { return null; }
      }

      function* emitFrom(ev) {
        const type = ev && ev.type;
        if (!type) return;
        switch (type) {
          case 'response.output_text.delta':
            if (typeof ev.delta === 'string' && ev.delta) yield { type: 'text', delta: ev.delta };
            return;
          case 'response.output_item.added': {
            const item = ev.item || {};
            const oi = ev.output_index;
            itemKind.set(oi, item.type);
            if (item.type === 'function_call') {
              sawToolCall = true;
              const idx = nextToolIndex++;
              toolIndexOf.set(oi, idx);
              argsLen.set(oi, 0);
              yield { type: 'tool_start', index: idx, id: item.call_id || item.id || ('call_' + idx), name: item.name || '' };
              if (typeof item.arguments === 'string' && item.arguments) { yield { type: 'tool_args', index: idx, chunk: item.arguments }; argsLen.set(oi, item.arguments.length); }
            }
            return;
          }
          case 'response.function_call_arguments.delta': {
            const oi = ev.output_index, idx = toolIndexOf.get(oi);
            if (idx != null && typeof ev.delta === 'string' && ev.delta) { yield { type: 'tool_args', index: idx, chunk: ev.delta }; argsLen.set(oi, (argsLen.get(oi) || 0) + ev.delta.length); }
            return;
          }
          case 'response.function_call_arguments.done': {
            // Some models (e.g. gpt-5.3-codex-spark) SKIP the streaming `.delta` events and deliver the
            // complete arguments only in this terminal event. Emit them iff no fragments were seen — otherwise
            // this is just a stream terminator and re-emitting would duplicate the JSON (-> broken tool call).
            const oi = ev.output_index, idx = toolIndexOf.get(oi);
            if (idx != null && (argsLen.get(oi) || 0) === 0 && typeof ev.arguments === 'string' && ev.arguments) { yield { type: 'tool_args', index: idx, chunk: ev.arguments }; argsLen.set(oi, ev.arguments.length); }
            return;
          }
          case 'response.output_item.done': {
            const oi = ev.output_index;
            if (itemKind.get(oi) === 'function_call' && toolIndexOf.has(oi)) {
              const idx = toolIndexOf.get(oi), item = ev.item || {};
              // last-resort fallback: if NOTHING delivered the args (no inline, no delta, no args.done), take
              // them off the completed item so a tool never dispatches with empty arguments.
              if ((argsLen.get(oi) || 0) === 0 && typeof item.arguments === 'string' && item.arguments) { yield { type: 'tool_args', index: idx, chunk: item.arguments }; argsLen.set(oi, item.arguments.length); }
              yield { type: 'tool_done', index: idx };
            }
            return;
          }
          case 'response.completed': {
            const r = ev.response || {};
            if (r.usage) yield { type: 'usage', usage: normalizeUsage(r.usage) };
            doneEmitted = true;
            yield { type: 'done', finishReason: finishFor(r), truncated: false };
            return;
          }
          case 'response.incomplete': {
            const r = ev.response || {};
            if (r.usage) yield { type: 'usage', usage: normalizeUsage(r.usage) };
            const reason = (r.incomplete_details && r.incomplete_details.reason) || '';
            doneEmitted = true;
            // an explicit `response.incomplete` is the SERVER stating it stopped early — a known, reported stop
            // (surfaced as finishReason 'length'), not a stream that died in transit.
            yield { type: 'done', finishReason: /max_output_tokens|length/.test(reason) ? 'length' : normalizeFinish('stop'), truncated: false };
            return;
          }
          case 'response.failed': {
            const err = (ev.response && ev.response.error) || ev.error || {};
            throw new Error('codex stream failed: ' + (err.message || err.code || 'unknown'));
          }
          case 'error':
            throw new Error('codex stream error: ' + ((ev.error && ev.error.message) || ev.message || 'unknown'));
          default:
            return;   // reasoning summaries, content_part.*, created/in_progress — ignored for the harness stream
        }
      }

      function finishFor(r) {
        if (r && r.status === 'incomplete') {
          const reason = (r.incomplete_details && r.incomplete_details.reason) || '';
          if (/max_output_tokens|length/.test(reason)) return 'length';
        }
        return sawToolCall ? 'tool_calls' : 'stop';
      }

      try {
        let sawSentinel = false;                     // the `data: [DONE]` end-of-stream marker
        while (!sawSentinel) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const lineStr = buf.slice(0, nl); buf = buf.slice(nl + 1);
            const p = parseLine(lineStr);
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
        // whether the stream really ENDED or merely stopped arriving. A finished Responses stream carries
        // `response.completed`/`response.incomplete` (both set doneEmitted) and/or the `[DONE]` sentinel; a
        // clean mid-generation FIN carries NEITHER, and the loop cannot otherwise tell it apart from a
        // finished answer — so it shipped the fragment as a completed, $0 delivery.
        if (!doneEmitted) yield { type: 'done', finishReason: null, truncated: !sawSentinel };
      } catch (e) {
        if (isAbort(e, req.signal)) return;
        throw e;
      }
    }

    // POST the responses request, retrying transient failures (429/5xx + network) BEFORE the stream starts.
    // A 401 additionally gets ONE renew+retry through opts.renewToken (see the header comment): the server's
    // "expired" verdict wins over the sidecar's local expiry check. The renew does not consume a transient
    // retry slot — it is a different recovery (new credential, not "wait and hope").
    async function requestWithRetry(body, signal) {
      let renewed = false;
      for (let attempt = 0; ; attempt++) {
        if (signal && signal.aborted) throw abortError();
        let res;
        // Fresh connect guard per attempt; disarmed the instant the fetch settles so the ceiling can't abort
        // the streaming body (a connect expiry rejects as a `timeout`, a user-cancel as AbortError).
        const guard = timeouts.connectGuard(signal);
        try {
          res = await doFetch(baseUrl + '/responses', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'OpenAI-Beta': 'responses=experimental',
              'originator': 'codex_cli_rs'
            },
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
        catch (e) { try { detail = (await res.text()).slice(0, 300); } catch (_) {} }
        const err = new Error('codex http ' + res.status + ' — ' + detail);
        err.status = res.status;
        err.headers = res.headers;
        if (res.status === 401 && renew && !renewed) {
          renewed = true;
          try {
            const fresh = await renew(token);
            if (fresh && typeof fresh === 'string') { token = fresh; continue; }
          } catch (renewErr) {
            // A relogin-class renew failure ("Sign in with ChatGPT again") is MORE actionable than the raw
            // 401 — surface it. A transient renew failure (network blip) keeps the honest original 401.
            if (renewErr && renewErr.reloginRequired) throw renewErr;
          }
        }
        const cls = classifyApiError(err, { model: body.model });
        err.transient = cls.retryable;
        if (cls.retryable && attempt < RETRY_DELAYS.length) { await delay(Math.min(60000, Math.max(RETRY_DELAYS[attempt], cls.retryAfterMs || 0)), signal); continue; }
        throw cls.retryable ? provider.runtime.markPreStreamRetriesExhausted(err) : err;
      }
    }

    function findModel(id) { return STATIC_MODELS.find(m => m.id === id) || null; }

    // The ACCOUNT's real model list — what the Codex backend will actually accept (the whole point: a slug
    // missing here is the one that 400s). GET /models with the bearer token; entries are { slug, visibility,
    // priority, … }. Skip hidden ones, sort by priority (the backend's recommended order), fall back to the
    // curated STATIC_MODELS when offline / no token. Mirrors the reference harness' codex model-fetch flow.
    async function listModels() {
      try {
        let res = await doFetch(baseUrl + '/models?client_version=' + CLIENT_VERSION, {
          headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
        });
        // Same 401 recovery seam as requestWithRetry: the server outranks the local expiry check. One renew,
        // one retry; any renew failure just falls through to the curated fallback below (renew errors are
        // surfaced by the RUN path — the catalog must keep its fail-open contract).
        if (res && res.status === 401 && renew) {
          try { const fresh = await renew(token); if (fresh && typeof fresh === 'string') { token = fresh; res = await doFetch(baseUrl + '/models?client_version=' + CLIENT_VERSION, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } }); } }
          catch (_) { /* fall through to the curated fallback */ }
        }
        if (res.ok) {
          const j = await res.json();
          const entries = (j && Array.isArray(j.models)) ? j.models : [];
          const out = [];
          for (const it of entries) {
            if (!it || typeof it.slug !== 'string' || !it.slug.trim()) continue;
            const vis = String(it.visibility || '').toLowerCase();
            if (vis === 'hide' || vis === 'hidden') continue;   // backend marks slugs it won't serve to this account
            // Carry the backend's own reasoning-level semantics through so the model dock can render the
            // exact chips (and their descriptions) the account is allowed, not a hardcoded guess.
            const levels = Array.isArray(it.supported_reasoning_levels) ? it.supported_reasoning_levels : [];
            const efforts = [];
            const effortDescriptions = {};
            for (const lv of levels) {
              const eff = lv && typeof lv.effort === 'string' ? lv.effort.trim().toLowerCase() : '';
              if (!eff || efforts.indexOf(eff) >= 0) continue;
              efforts.push(eff);
              if (lv.description) effortDescriptions[eff] = String(lv.description);
            }
            out.push({
              id: it.slug.trim(),
              displayName: it.display_name || undefined,
              description: it.description || undefined,
              context_length: it.context_window || it.max_context_window || 272000,
              max_completion_tokens: it.max_output_tokens || null,
              supportsTools: true, pricing: null,
              reasoningEfforts: efforts.length ? efforts : CODEX_EFFORT_LIST.slice(),
              defaultReasoningLevel: it.default_reasoning_level ? String(it.default_reasoning_level).trim().toLowerCase() : 'medium',
              reasoningLevelDescriptions: Object.keys(effortDescriptions).length ? effortDescriptions : undefined,
              _rank: (typeof it.priority === 'number') ? it.priority : 10000
            });
          }
          out.sort((a, b) => (a._rank - b._rank) || a.id.localeCompare(b.id));
          if (out.length) return out.map(({ _rank, ...m }) => m);
        }
      } catch (e) { /* offline / no token -> curated fallback below */ }
      // `fallback: true` is the honesty marker (2026-08-10): these entries prove NOTHING about the account —
      // the live fetch failed. The provider probe reads it so Settings can no longer print VERIFIED off a
      // hardcoded list, and the model dock can label the catalog offline.
      return STATIC_MODELS.map(m => Object.assign({}, m, { pricing: null, fallback: true }));
    }
    function contextLimit(id) { const m = findModel(id); return (m && m.context_length) || 272000; }   // sane default for an unlisted Codex model
    function priceOf() { return null; }                  // flat-rate subscription -> no per-token price
    function supportsTools(id) { const m = findModel(id); return m ? !!m.supportsTools : true; }   // Codex models are tool-capable; never false-refuse
    // Which reasoning levels a codex model exposes — the static entry's list, or the four-level default.
    function reasoningEfforts(id) { const m = findModel(id); return (m && Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length) ? m.reasoningEfforts.slice() : CODEX_EFFORT_LIST.slice(); }

    return { stream, listModels, contextLimit, priceOf, supportsTools, reasoningEfforts };
  }

  // Responses usage uses input_tokens/output_tokens; remap to the prompt_tokens/completion_tokens shape
  // the cost engine + context gauge read. A subscription is flat-rate, so cost is recorded as 0.
  function normalizeUsage(u) {
    u = u || {};
    const inDetails = u.input_tokens_details || {};
    const outDetails = u.output_tokens_details || {};
    return {
      prompt_tokens: u.input_tokens || 0,
      completion_tokens: u.output_tokens || 0,
      total_tokens: u.total_tokens || ((u.input_tokens || 0) + (u.output_tokens || 0)),
      reasoning_tokens: outDetails.reasoning_tokens || 0,
      prompt_tokens_details: { cached_tokens: inDetails.cached_tokens || 0 },
      cost: 0
    };
  }

  return { makeCodexProvider, STATIC_MODELS, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, _internals: { messagesToInput, extractInstructions, toResponsesTools, normalizeUsage, normalizeCodexReasoningEffort } };
});
