/* sidecar/providers/errorClass.js — API error classification -> failover actions (derived from the reference harness, L3.S1).

   Today the loop carries a single `err.transient` bit: a 429/5xx retries, everything else is fatal. That
   burns paid attempts on never-succeed failures (402 out-of-credits, 400 malformed) and tells the user
   nothing useful. This pure classifier maps any provider error to a reason + the action it implies.

   classifyApiError(err, { provider, model, approxTokens, liveApproxTokens, contextLimit, numMessages })
     -> { reason, retryable, shouldRotateCredential, shouldFallback, shouldCompress, statusCode, message }

   Reasons: auth · billing · rate_limit · quota_exhausted · overloaded · server_error · timeout ·
            context_overflow · output_cap · model_not_found · content_policy_blocked · format_error ·
            tls_certificate · local_error · unknown.

   Priority pipeline: content/policy -> HTTP status (code+message consulted inside the ambiguous 400 branch)
   -> structured error-code (for errors with no HTTP status) -> message patterns -> transport -> a
   context-overflow RATIO heuristic -> unknown. The ratio (approxTokens > 0.4·contextLimit) only fires when
   contextLimit > 0, so a cold /models catalog (contextLimit === 0) never mis-labels a bare 400 as overflow.

   Pure: inspects only `err` and the context bag — no clock, no rng, no IO. Wiring (producer seam in
   openrouter.js, honest `transient` in loop.js) is L3.S2/S3; this commit ships the classifier + test only. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.errorClass = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // reason -> the recovery it implies. retryable = worth another attempt on the SAME credential/model after
  // backoff; the *should* flags are advisory hints a future failover layer consumes (no consumer yet — L3.S3
  // records them inert). Default-deny posture: only genuinely transient classes are retryable.
  const REASONS = {
    auth:                   { retryable: false, shouldRotateCredential: true,  shouldFallback: false, shouldCompress: false },
    billing:                { retryable: false, shouldRotateCredential: true,  shouldFallback: false, shouldCompress: false },
    rate_limit:             { retryable: true,  shouldRotateCredential: true,  shouldFallback: false, shouldCompress: false },
    /* A SPENT ALLOWANCE, not a busy moment. A ChatGPT-subscription (Codex) weekly quota resets in DAYS, so a
       retry is doomed by construction: retryable:false stops codex.js burning RETRY_DELAYS and loop.js burning
       MAX_STREAM_RETRIES against an exhausted meter. Rotating may help (another credential has its own
       allowance) and so may falling back (a different provider entirely) — unlike `billing`, which is one
       account being out of money and which a fallback would not fix either way. */
    quota_exhausted:        { retryable: false, shouldRotateCredential: true,  shouldFallback: true,  shouldCompress: false },
    overloaded:             { retryable: true,  shouldRotateCredential: false, shouldFallback: true,  shouldCompress: false },
    server_error:           { retryable: true,  shouldRotateCredential: false, shouldFallback: true,  shouldCompress: false },
    timeout:                { retryable: true,  shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    context_overflow:       { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: true  },
    /* The REQUESTED OUTPUT budget exceeds what the model may emit ("max_tokens: 128000 > 64000, which is the
       maximum allowed number of output tokens for claude-…"). Not an overflow: the prompt is fine, so folding
       history buys nothing and a retry with the same max_tokens is refused identically. The verdict carries the
       parsed `allowedMaxTokens`; the loop retries the SAME turn once with the output budget lowered to it
       (recovery-policy `lower_output`). retryable:false keeps every adapter from re-sending the doomed body. */
    output_cap:             { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    model_not_found:        { retryable: false, shouldRotateCredential: false, shouldFallback: true,  shouldCompress: false },
    content_policy_blocked: { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    format_error:           { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    /* A TLS CERTIFICATE the machine does not trust (expired, self-signed, a corporate proxy re-signing HTTPS).
       Waiting never fixes a certificate, so no retry — but a DIFFERENT provider is a different host and may
       well verify, so a configured fallback is still worth taking. */
    tls_certificate:        { retryable: false, shouldRotateCredential: false, shouldFallback: true,  shouldCompress: false },
    /* OUR OWN BUG: a TypeError/ReferenceError/SyntaxError/RangeError thrown by harness code with no HTTP status
       and no transport code. These were `unknown` (retryable), so one null dereference in an adapter replayed
       the same crash through the whole ~106s ladder before the user saw the real message. Deterministic code
       fails deterministically — fail fast, verbatim. */
    local_error:            { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    unknown:                { retryable: true,  shouldRotateCredential: false, shouldFallback: false, shouldCompress: false }
  };

  function extractStatus(err) {
    if (!err) return null;
    const s = err.status || err.statusCode || (err.response && err.response.status);
    if (typeof s === 'number' && s >= 100) return s;
    const m = String(err.message || '').match(/\b(?:http|status)\s+(\d{3})\b/i);
    return m ? Number(m[1]) : null;
  }
  function extractBody(err) {
    if (!err) return null;
    return err.body || err.error || (err.response && (err.response.data || err.response.body)) || null;
  }
  function extractCode(body, err) {
    const e = body && (body.error || body);
    /* Providers name the machine-readable error in different fields (2026-09-22): OpenAI a string `code` (plus
       `type`), Anthropic ONLY `type` ('overloaded_error', 'rate_limit_error'), Gemini a numeric `code` beside the
       canonical `status` string ('RESOURCE_EXHAUSTED'). A string code wins; else the typed name; else the status.
       (Anthropic's envelope type 'error' names nothing.) With none of them, the original read below is unchanged. */
    const named = !e ? null
      : (typeof e.code === 'string' && e.code) ? e.code
      : (typeof e.type === 'string' && e.type && e.type !== 'error') ? e.type
      : (typeof e.status === 'string' && e.status) ? e.status : null;
    if (named) return named;
    const c = (e && e.code) || (err && err.code);
    // node transport codes (ECONNRESET…) are numeric-ish strings handled separately; only return API codes here
    return (typeof c === 'string' && !/^E[A-Z]/.test(c)) ? c : (typeof c === 'number' ? null : (c || null));
  }
  function extractMessage(err, body) {
    /* An adapter that composed its own sentence around the provider's error ('<label> http 429 — <detail>') marks it
       `ownMessage`: the body rides along for its CODE and must not replace that sentence. The label + status are
       what the UI routes on (frontend friendlyerror.js: /(grok|kimi).*http 40[13]/ -> the RECONNECT door), and
       the adapter already redacted what it quoted. */
    if (err && err.ownMessage && err.message) return String(err.message);
    const e = body && (body.error || body);
    const parts = [];
    if (e && e.message) parts.push(String(e.message));
    if (e && e.metadata && e.metadata.raw) parts.push(String(e.metadata.raw));   // OpenRouter wraps the upstream error here
    if (!parts.length && err && err.message) parts.push(String(err.message));
    return parts.join(' — ') || (err ? String(err) : 'unknown error');
  }
  function transportCode(err) {
    return (err && (err.code || err.errno || (err.cause && err.cause.code))) || '';
  }

  /* WHY THIS EXISTS (2026-07-29). A real user's diagnostics report carried five entries reading exactly
     `fetch failed` — and nothing else. That is undici's ENTIRE message for any failed outbound fetch: the useful
     part (ENOTFOUND / ECONNREFUSED / EAI_AGAIN / UND_ERR_CONNECT_TIMEOUT, plus the hostname) lives on `err.cause`
     and was being dropped on the floor by extractMessage's `err.message` fallback. We could not tell DNS failure
     from a refused connection from a TLS/proxy interception, so we could not tell the user what to fix.

     PURE by contract: reads only the error object (no env, no clock, no I/O) so it stays safe to unit-test and
     safe to call from the loop. Returns '' when there is nothing to add, so callers can append unconditionally. */
  function transportDetail(err) {
    const code = String(transportCode(err) || '').trim();
    const cause = (err && err.cause) || null;
    // undici's DNS failures carry the hostname directly; other causes often name it only in their message.
    let host = (cause && (cause.hostname || cause.host)) || '';
    if (!host && cause && cause.message) {
      const m = String(cause.message).match(/(?:^|\s)([a-z0-9-]+(?:\.[a-z0-9-]+){1,})(?::\d+)?(?:\s|$)/i);
      if (m) host = m[1];
    }
    // TLS-alert and socket causes name no host at all — fall back to the hostname the adapter / tool stamped on the
    // error (provider.js stampRequestHost: hostname only, never a URL). LAST, so a cause's own host keeps priority.
    if (!host && err && typeof err.requestHost === 'string') host = err.requestHost;
    host = String(host || '').trim();
    if (!code && !host) return '';
    return code && host ? code + ' ' + host : (code || host);
  }
  /* Append the transport detail to a message ONLY when the message is too bare to be actionable. Deliberately
     conservative: a provider that already sent a real error sentence keeps its own words verbatim (we must never
     bury an upstream explanation under plumbing), and we never double-append a code the message already names.
     NOTE the ORDER of the caller in classifyApiError: `reason` is picked from the RAW message BEFORE this runs,
     so enriching the text can never move a verdict. Keep it that way. */
  function annotateTransport(message, err) {
    const msg = String(message == null ? '' : message);
    const detail = transportDetail(err);
    if (!detail) return msg;
    if (msg.toLowerCase().indexOf(detail.toLowerCase()) >= 0) return msg;
    // only bare transport-shaped messages get annotated — undici's "fetch failed" is the case that mattered.
    if (!/^\s*(?:typeerror:\s*)?(?:fetch failed|failed to fetch|terminated|socket hang up|other side closed|premature close|network(?:error| error)?)\s*$/i.test(msg)) return msg;
    return msg + ' (' + detail + ')';
  }

  // H6.1: surface how long the server says to wait, so a rate-limited credential cools for exactly that long
  // (instead of a blind fixed cooldown). PURE — no clock: a RELATIVE hint (Retry-After: 30, "try again in 1.5s")
  // becomes `retryAfterMs`; an ABSOLUTE hint (HTTP-date, X-RateLimit-Reset epoch, "resets at <epoch>") becomes
  // `resetAtMs` and the consumer (with its injected clock) turns it into a delay. Either/both may be null.
  function extractHeaders(err) { return (err && (err.headers || (err.response && err.response.headers))) || null; }
  function headerGet(headers, name) {
    if (!headers) return null;
    const lname = name.toLowerCase();
    if (typeof headers.get === 'function') { const v = headers.get(name); if (v != null) return v; }
    for (const k in headers) { if (String(k).toLowerCase() === lname) return headers[k]; }
    return null;
  }
  function extractRetryAfter(err, body, message) {
    let retryAfterMs = null, resetAtMs = null;
    const headers = extractHeaders(err);
    const e = body && (body.error || body);
    // 1. Retry-After: bare integer = delta-seconds; otherwise an HTTP-date (absolute).
    const ra = headerGet(headers, 'retry-after') || (e && (e.retry_after != null ? e.retry_after : (body && body.retry_after)));
    if (ra != null && String(ra).trim() !== '') {
      const s = String(ra).trim();
      if (/^\d+(\.\d+)?$/.test(s)) retryAfterMs = Math.round(parseFloat(s) * 1000);
      else { const t = Date.parse(s); if (!isNaN(t)) resetAtMs = t; }
    }
    // 2. X-RateLimit-Reset header: epoch seconds or ms (a small delta-seconds value is ambiguous -> skip).
    const xr = headerGet(headers, 'x-ratelimit-reset') || headerGet(headers, 'x-ratelimit-reset-requests') || headerGet(headers, 'x-ratelimit-reset-tokens');
    if (resetAtMs == null && xr != null && /^\d+(\.\d+)?$/.test(String(xr).trim())) {
      const n = parseFloat(xr);
      if (n > 1e12) resetAtMs = Math.round(n);            // already epoch-ms
      else if (n > 1e9) resetAtMs = Math.round(n * 1000); // epoch-seconds
    }
    // 3. message text: "(try again|retry|resets|available) in <n><unit>"
    if (retryAfterMs == null) {
      const m = String(message || '').toLowerCase().match(/(?:try again|retry|resets?|available|wait)\s+(?:in\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)\b/);
      if (m) { const v = parseFloat(m[1]); const u = m[2]; retryAfterMs = /^ms|^milli/.test(u) ? Math.round(v) : /^m/.test(u) ? Math.round(v * 60000) : Math.round(v * 1000); }
    }
    // 4. message text: "resets at <epoch>" (10–13 digit unix time)
    if (resetAtMs == null) {
      const m = String(message || '').toLowerCase().match(/resets?\s+at\s+(\d{10,13})/);
      if (m) { const n = Number(m[1]); resetAtMs = n > 1e12 ? n : n * 1000; }
    }
    return { retryAfterMs, resetAtMs };
  }

  /* CONTEXT-OVERFLOW PHRASINGS (2026-09-22, Hermes audit). The old pattern only knew the OpenAI shape and read
     `maximum.*tokens` left-to-right, so the providers that put the number FIRST fell through to format_error
     (fatal) and a run that had simply grown too big died instead of folding:
       Anthropic   "prompt is too long: 215000 tokens > 200000 maximum"
       Anthropic   "input length and `max_tokens` exceed context limit: 197000 + 21333 > 200000"
       Bedrock     "Input is too long for requested model."
       llama.cpp   "the request exceeds the available context size, try increasing it"
       generic     "… exceeds the context window …"
     `maximum.*tokens` stays for the phrasings it always caught (Gemini's "exceeds the maximum number of tokens
     allowed"); the OUTPUT-cap refusal it used to swallow is split off first (parseOutputCap, below). */
  const OVERFLOW_RE = /context length|maximum context|context window|context size|context limit|too many tokens|reduce the length|prompt is too long|prompt too long|input is too long|input too long|payload too large|exceeds? (?:the )?(?:available |maximum |model'?s? )?context|tokens? > \d+ maximum|maximum.*tokens/;

  /* The OUTPUT-cap refusal: the prompt is fine, the requested max_tokens is above what the model may emit. Returns
     the ceiling the provider NAMED (> 0) or 0 when the text is not one of these refusals. Only phrasings that
     state the number qualify — a cap we cannot read is not something the loop can act on, so it stays with the
     ordinary 400 handling.
       Anthropic  "max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-…"
       OpenAI     "max_tokens is too large: 200000. This model supports at most 16384 completion tokens, …"
       Groq-like  "`max_tokens` must be less than or equal to `8192`, …"
       DeepSeek   "Invalid max_tokens value, the valid range of max_tokens is [1, 8192]" */
  function parseOutputCap(message) {
    const s = String(message || '');
    const m = s.match(/max_tokens`?\s*:?\s*\d+\s*>\s*(\d+)\s*,?\s*which is the maximum allowed number of output tokens/i)
      || s.match(/supports at most (\d+) (?:completion|output) tokens/i)
      || s.match(/max(?:imum)?[_ ](?:completion[_ ]|output[_ ]|new[_ ])?tokens`?\s*(?:must be|should be|is limited to)\s*(?:less than or equal to|<=|at most|no (?:more|greater) than)\s*`?(\d+)/i)
      || s.match(/valid range of max_tokens is \[\s*\d+\s*,\s*(\d+)\s*\]/i);
    const n = m ? parseInt(m[1], 10) : 0;
    return (isFinite(n) && n > 0) ? n : 0;
  }

  /* TLS CERTIFICATE failures. undici wraps them as `TypeError: fetch failed` with the OpenSSL code on err.cause,
     which no pattern knew — so a machine behind an HTTPS-inspecting proxy (or a self-hosted endpoint with a
     self-signed cert) spent every retry rung on a failure that cannot heal by waiting, then showed the user a
     bare "fetch failed". */
  const TLS_CODE_RE = /^(?:CERT_|ERR_TLS_CERT|UNABLE_TO_(?:VERIFY_LEAF_SIGNATURE|GET_ISSUER_CERT)|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_SSL_CERTIFICATE)/;
  const TLS_TEXT_RE = /certificate verify failed|unable to verify the first certificate|self[- ]signed certificate|certificate has expired|unable to get (?:local )?issuer certificate|certificate is not yet valid|hostname\/ip does not match certificate/;
  function isTlsFailure(err, low) {
    const codes = [err && err.code, err && err.cause && err.cause.code].map(c => String(c || ''));
    if (codes.some(c => TLS_CODE_RE.test(c))) return true;
    const causeMsg = String((err && err.cause && err.cause.message) || '').toLowerCase();
    return TLS_TEXT_RE.test(low) || TLS_TEXT_RE.test(causeMsg);
  }

  /* A programming error thrown by HARNESS code (see REASONS.local_error). Transport failures ride the same JS
     error classes and must stay retryable: undici reports a dropped socket as `TypeError: fetch failed` /
     `TypeError: terminated`, browsers as `TypeError: Failed to fetch` — any transport code on the error or its
     cause, or a bare transport phrasing, disqualifies. An HTTP status or an API error body means the provider
     answered, which is never "our bug". */
  const LOCAL_ERROR_NAMES = { TypeError: 1, ReferenceError: 1, SyntaxError: 1, RangeError: 1 };
  const TRANSPORT_TEXT_RE = /fetch failed|failed to fetch|load failed|network ?error|network request failed|terminated|socket hang up|other side closed|premature close|econn|etimedout|enotfound|eai_again|epipe|und_err/;
  function isLocalError(err, status, body, low) {
    if (!err || typeof err !== 'object' || status || body) return false;
    if (LOCAL_ERROR_NAMES[String(err.name || '')] !== 1) return false;
    if (transportCode(err)) return false;
    return !TRANSPORT_TEXT_RE.test(low);
  }

  /* A rejected CREDENTIAL does not always arrive as 401. xAI answers a bad key with HTTP 400
     {"code":"invalid-argument","error":"Incorrect API key provided…"} (live-probed 2026-09-27), which read as a
     malformed request (format_error) and reached the user as "Something went wrong — try again". */
  const REJECTED_KEY_RE = /incorrect api key|invalid api key|api key (?:is )?(?:invalid|not valid|incorrect)|invalid x-api-key/;
  /* An account with NO MONEY is not a bad key. xAI refuses a team without prepaid credits with 403 ("Your newly
     created team doesn't have any credits yet. You can purchase credits on https://console.x.ai/…") or
     "…has either used all available credits or reached its monthly spending limit". The plain status read called
     that `auth`, and the user was told no model was connected. */
  const NO_CREDIT_RE = /(?:doesn'?t|does not) have any credits|purchase (?:more )?credits|used all (?:of )?(?:its |your )?available credits|(?:reached|exceeded|hit) (?:its |your |the |their )?(?:monthly )?spending limit|insufficient[_ ]?(?:credit|funds|balance)|out of credits?/;

  function classify400(low, code, ctx) {
    const c = String(code || '').toLowerCase();
    if (REJECTED_KEY_RE.test(low)) return 'auth';
    if (/context_length|context_window|max.*token/.test(c)) return 'context_overflow';
    if (/content_policy|moderation/.test(c)) return 'content_policy_blocked';
    if (OVERFLOW_RE.test(low)) return 'context_overflow';
    // ratio heuristic ONLY with a known limit — a cold catalog (contextLimit 0) falls to format_error
    if (overRatio(low, ctx)) return 'context_overflow';
    return 'format_error';
  }

  /* THE OVERFLOW RATIO, TWO SIZES. ctx.approxTokens is the prompt size at RUN START (the heuristic's original
     input). ctx.liveApproxTokens is the prompt's CURRENT size (loop.js currentApproxTokens) — without it a run that
     grew past the window mid-way could never be recognized by the ratio. But on a long run the live figure sits
     above 0.4·window for EVERY later request, so an unrelated 400 ("invalid base64", a bad tool schema) was read as
     an overflow: a destructive fold and a wrong failureCode. So the live size only speaks for a 400 whose text names
     no specific cause of its own (NAMED_CAUSE_RE); a 400 that says what is wrong with the request is believed. */
  const NAMED_CAUSE_RE = /base64|image|media[ _]?type|mime|schema|json|parse|invalid[_ ]type|tool_use|tool_result|tool_call|function|parameter|argument|field|property|enum|encoding|utf-?8|unsupported|not supported|role|messages?\.\d|content\.\d/;
  function overRatio(low, ctx) {
    const limit = Number(ctx && ctx.contextLimit) || 0;
    if (!(limit > 0)) return false;
    if ((Number(ctx.approxTokens) || 0) > 0.4 * limit) return true;
    return (Number(ctx.liveApproxTokens) || 0) > 0.4 * limit && !NAMED_CAUSE_RE.test(low);
  }

  /* A 429 is not always "wait a few seconds". A ChatGPT-subscription user who has burned their WEEKLY quota
     gets a 429 whose body says exactly that and whose reset is days away — so the honest class is a spent
     allowance, not a rate limit. Status-before-message precedence is deliberate (see the note in pickReason),
     so this is a distinct class WITHIN the 429 rather than a reordering: only a long or absolute reset window,
     or an explicit usage-limit type, qualifies. Gemini answers a PER-MINUTE limit with "Quota exceeded for
     quota metric", and that must stay rate_limit — hence the short-window veto. */
  const QUOTA_EXHAUSTED_RE = /usage[_ ]?limit(?:[_ ]?(?:has|is)(?:[_ ]?been)?)?[_ ]?reached|hit (?:your|the) (?:usage|weekly|monthly|plan|daily) limit|(?:weekly|monthly|daily) (?:quota|limit)|resets? in \s*\d+\s*(?:day|hour|week)|resets? (?:on|at) \d|quota (?:will )?reset(?:s)? (?:in|on|at)/;
  const SHORT_WINDOW_RE = /per[- ]?(?:minute|second)|quota metric|\brpm\b|\btpm\b|requests per/;
  function isQuotaExhausted(low) { return QUOTA_EXHAUSTED_RE.test(low) && !SHORT_WINDOW_RE.test(low); }

  function pickReason(status, code, low, err, ctx) {
    // 0. errors that never reached an API: a certificate the machine rejects, or a crash in our own code. First,
    //    because neither carries a status or a body — so no later rule can be describing the provider's intent.
    if (!status && isTlsFailure(err, low)) return 'tls_certificate';
    if (isLocalError(err, status, extractBody(err), low)) return 'local_error';
    /* 1. content / policy (most specific intent) — but a TRANSPORT status wins over a text match.
       This ran against the whole message before the status was consulted, so any retryable failure whose
       text merely CONTAINED one of these words was rewritten as a fatal policy block: a 503 naming
       `openai/omni-moderation-latest`, a 429 on a "safety" tier, a 500 from a content_filter component.
       The classifier then reported retryable:false / shouldFallback:false and the loop killed the run
       instead of retrying or failing over — and agent.run.error.transient lied about why. A real policy
       refusal never arrives as 429/5xx; it comes as 400/403/422 or with no status at all. */
    const transportStatus = status === 429 || (status >= 500 && status < 600) || status === 408;
    if (!transportStatus && /content[ _]?policy|moderation|flagged|safety|content_filter/.test(low)) return 'content_policy_blocked';
    // 1b. OUTPUT cap — BEFORE the overflow patterns, whose `maximum.*tokens` matches this refusal's wording and
    //     used to fold history for nothing, retry the identical max_tokens, and kill the run.
    if ((!status || status === 400 || status === 422) && parseOutputCap(low) > 0) return 'output_cap';
    // 2. HTTP status
    if (status) {
      if (status === 401 || status === 403) return NO_CREDIT_RE.test(low) ? 'billing' : 'auth';
      if (status === 402) return /(resets? at|retry[- ]?after|rate limit)/.test(low) ? 'rate_limit' : 'billing';
      if (status === 404) return 'model_not_found';
      if (status === 408) return 'timeout';
      if (status === 429) {
        /* A 429 can carry a TERMINAL body, and neither of these clears by waiting: a spent subscription
           allowance, or an account with no money left — OpenAI answers `insufficient_quota` with 429, not 402,
           so the plain status read burned every retry slot against a wallet that needs topping up. */
        const c429 = String(code || '').toLowerCase();
        if (isQuotaExhausted(low) || /usage_limit_reached|quota_exhausted|plan_limit/.test(c429)) return 'quota_exhausted';
        if (/insufficient[_ ]?quota|exceeded your current quota|out of credit|add credits|payment required/.test(low)
          || /insufficient[_ ]?quota/.test(c429)) return 'billing';
        return 'rate_limit';
      }
      if (status === 500) return 'server_error';
      // 529 is Anthropic's "Overloaded" — only the message pattern caught it, so a bare 529 was `unknown`.
      if (status === 502 || status === 503 || status === 529) return 'overloaded';
      if (status === 504) return 'timeout';
      // 413 Payload Too Large IS the request being too big for the endpoint, whatever the body says (Anthropic:
      // "Request exceeds the maximum allowed number of bytes"; many gateways send no body at all). Folding
      // history is the only recovery that can change the answer, so it takes the compress path.
      if (status === 413) return 'context_overflow';
      if (status === 400 || status === 422) return classify400(low, code, ctx);
      // Any other 5xx (Cloudflare 520–524, a proxy's 507…) is still the server's fault and transient. 501 Not
      // Implemented and 505 are deterministic refusals of the request shape — left to the patterns below.
      if (status > 500 && status < 600 && status !== 501 && status !== 505) return 'server_error';
    }
    // 3. structured error-code (errors that arrive with no HTTP status)
    if (code) {
      const c = String(code).toLowerCase();
      if (/context_length|context_window|max.*token/.test(c)) return 'context_overflow';
      if (/usage_limit_reached|quota_exhausted|plan_limit/.test(c)) return 'quota_exhausted';
      if (/insufficient_quota|insufficient_credit|billing|payment/.test(c)) return 'billing';
      if (/rate_limit/.test(c)) return 'rate_limit';
      // Gemini's canonical status for BOTH a per-minute limit and a spent daily allowance: the message decides
      // which. (Its prose — 'Resource has been exhausted (e.g. check quota).' — used to fall to the bare /quota/
      // billing pattern below and fail a mid-stream rate limit as an empty wallet.)
      if (c === 'resource_exhausted') return isQuotaExhausted(low) ? 'quota_exhausted' : 'rate_limit';
      if (/overloaded/.test(c)) return 'overloaded';   // Anthropic's typed 'overloaded_error' (arrives mid-stream too)
      if (/model_not_found|unknown_model|no_endpoints/.test(c)) return 'model_not_found';
      if (/content_policy|moderation/.test(c)) return 'content_policy_blocked';
      if (/invalid_api_key|authentication|unauthorized/.test(c)) return 'auth';
    }
    // 4. message patterns
    if (OVERFLOW_RE.test(low)) return 'context_overflow';
    if (isQuotaExhausted(low)) return 'quota_exhausted';
    if (/insufficient|not enough credit|out of credit|quota|payment required|add credits/.test(low)) return 'billing';
    if (/rate limit|too many requests/.test(low)) return 'rate_limit';
    if (/overloaded|over capacity|temporarily unavailable|try again later/.test(low)) return 'overloaded';
    if (/no endpoints|model not found|not a valid model|unknown model|no allowed providers/.test(low)) return 'model_not_found';
    if (/unauthorized|invalid api key|no auth credentials|authentication/.test(low)) return 'auth';
    if (/timed out|timeout/.test(low)) return 'timeout';
    // 5. transport
    if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED|UND_ERR/i.test(transportCode(err))) return 'timeout';
    // 6. ratio heuristic (only with a known limit)
    if (overRatio(low, ctx)) return 'context_overflow';
    // 7. unknown — one retry is safe-ish
    return 'unknown';
  }

  function classifyApiError(err, ctx) {
    ctx = ctx || {};
    const status = extractStatus(err);
    const body = extractBody(err);
    const code = extractCode(body, err);
    const message = extractMessage(err, body);
    const low = String(message).toLowerCase();
    const reason = pickReason(status, code, low, err, ctx);
    const f = REASONS[reason] || REASONS.unknown;
    const wait = extractRetryAfter(err, body, message);
    let text = annotateTransport(message, err);
    if (reason === 'local_error') {
      // name the class so "Cannot read properties of undefined" reads as the crash it is, not a provider refusal
      const name = String((err && err.name) || 'Error');
      if (text.indexOf(name) !== 0) text = name + ': ' + text;
    } else if (reason === 'tls_certificate') {
      text = 'TLS certificate verification failed' + (transportDetail(err) ? ' (' + transportDetail(err) + ')' : '')
        + ' — this machine does not trust the provider\'s certificate. Behind a corporate proxy or an antivirus HTTPS scanner, '
        + 'point NODE_EXTRA_CA_CERTS at its root certificate and restart StarNet; for a self-hosted endpoint, give it a valid certificate. ['
        + message + ']';
    }
    return {
      reason,
      retryable: f.retryable,
      shouldRotateCredential: f.shouldRotateCredential,
      shouldFallback: f.shouldFallback,
      shouldCompress: f.shouldCompress,
      statusCode: status || null,
      retryAfterMs: wait.retryAfterMs,   // H6.1: server-stated delay (relative ms), or null
      resetAtMs: wait.resetAtMs,         // H6.1: server-stated absolute reset (epoch ms), or null
      // output_cap only: the output ceiling the provider named; the loop retries the turn with max_tokens at it.
      allowedMaxTokens: reason === 'output_cap' ? parseOutputCap(low) : null,
      // `reason` above was already picked from the RAW message, so annotating here cannot move the verdict — it
      // only makes the text a human can act on ("fetch failed" -> "fetch failed (ENOTFOUND api.openai.com)").
      // This is the message the loop emits as agent.run.error, which is what lands in the diagnostics ring.
      message: text
    };
  }

  return { classifyApiError, REASONS, transportDetail, annotateTransport,
    _internals: { extractStatus, extractCode, extractMessage, classify400, pickReason, extractRetryAfter, transportCode, parseOutputCap, isTlsFailure, isLocalError } };
});
