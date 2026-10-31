/* sidecar/providers/errorClass.js — API error classification -> failover actions (derived from the reference harness, L3.S1).

   Today the loop carries a single `err.transient` bit: a 429/5xx retries, everything else is fatal. That
   burns paid attempts on never-succeed failures (402 out-of-credits, 400 malformed) and tells the user
   nothing useful. This pure classifier maps any provider error to a reason + the action it implies.

   classifyApiError(err, { provider, model, approxTokens, liveApproxTokens, contextLimit, numMessages })
     -> { reason, retryable, shouldRotateCredential, shouldFallback, shouldCompress, statusCode, unsupportedPart, message }

   Reasons: auth · billing · rate_limit · quota_exhausted · overloaded · server_error · timeout ·
            context_overflow · output_cap · call_too_expensive · model_not_found · content_policy_blocked ·
            format_error · tls_certificate · local_memory · local_timeout · local_error · endpoint_mismatch ·
            template_refusal · unreachable · unknown.

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
    /* The StarNet credit relay priced this call's PROMPT ALONE over its per-call ceiling ($10 by default at starnet-cloud
       b5582dd, configurable there: HTTP 400 `call_too_expensive`, "This request could cost more than the $10.00 StarNet
       allows for one call"). The copy quotes the relay's own number, never this one. The same
       prompt on the same model is refused identically, so no resend. A configured fallback is a different model at its
       own price and may fit, so it is worth taking. No fold: shortening the conversation is the Commander's call, not a
       silent summary. As format_error it read "Something went wrong — try again" (GitHub #53 follow-up, 2026-10-27). */
    call_too_expensive:     { retryable: false, shouldRotateCredential: false, shouldFallback: true,  shouldCompress: false },
    model_not_found:       { retryable: false, shouldRotateCredential: false, shouldFallback: true,  shouldCompress: false },
    content_policy_blocked: { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    format_error:           { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    /* A TLS CERTIFICATE the machine does not trust (expired, self-signed, a corporate proxy re-signing HTTPS).
       Waiting never fixes a certificate, so no retry — but a DIFFERENT provider is a different host and may
       well verify, so a configured fallback is still worth taking. */
    tls_certificate:        { retryable: false, shouldRotateCredential: false, shouldFallback: true,  shouldCompress: false },
    /* A local failure: an adapter-proven Ollama allocation failure, or a TypeError/ReferenceError/SyntaxError/RangeError thrown by harness code with no HTTP status
       and no transport code. These were `unknown` (retryable), so one null dereference in an adapter replayed
       the same crash through the whole ~106s ladder before the user saw the real message. Deterministic code
       fails deterministically — fail fast, verbatim. */
    local_error:            { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    /* An adapter-proven local allocation failure (Ollama out of memory). Resending repeats the allocation, so no
       retry; a configured fallback OFF that local runtime may take over (the loop skips same-runtime entries). */
    local_memory:           { retryable: false, shouldRotateCredential: false, shouldFallback: true,  shouldCompress: false },
    /* An adapter-proven LOADED, SILENT local model (#99): Ollama's native chat sent nothing for the whole connect ceiling
       while /api/ps listed the model at every read and no other StarNet call was open on that server. A resend aborts
       Ollama mid-request and repeats the same prompt on the same model, so no retry. No fallback either, exactly as
       `timeout`: the turn ends with the adapter's placement sentence. A model NOT listed stays `timeout`. */
    local_timeout:          { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    /* An adapter-proven WRONG SERVER behind the provider's URL (GH#111: the OLLAMA card pointed at LM Studio, which
       answers Ollama's /api/chat with a 200 "Unexpected endpoint or method"). The configuration is wrong, so a resend
       repeats it, and the adapter's own sentence (which server, which card speaks to it) is the fix. No fallback
       either: a failover would finish every run on another model and the misconfiguration would never be shown. */
    endpoint_mismatch:      { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    /* The model's CHAT TEMPLATE refused the conversation's shape (#102: Ollama /v1 answered HTTP 500 "Jinja Exception:
       System message must be at the beginning"; Gemma's "System role not supported"; "Conversation roles must
       alternate"). It is not the server having a bad moment: the same body is refused identically, so the 500 was
       resent as server_error for nothing and the Commander read "try again". The adapter resends ONCE in the strictest
       shape (provider.projectRoles 'chat-nosystem') and remembers it for that endpoint + model; this class is what is
       left after that. Another model has another template, so a configured fallback is still worth taking. */
    template_refusal:       { retryable: false, shouldRotateCredential: false, shouldFallback: true,  shouldCompress: false },
    /* NOTHING ANSWERED at the provider's address (bug 8873fd77, GH#111): the connection was refused (ECONNREFUSED — the
       server is not running, e.g. Ollama or LM Studio not started) or the name did not resolve (ENOTFOUND / EAI_AGAIN).
       These used to ride `timeout` through the whole ~106 s ladder, the retry line said "(timeout)" and the end read a
       bare "fetch failed". ONE retry covers a blip (`retryBudget`, read by the adapters' pre-stream ladders and by
       recovery-policy), then the turn ends naming the host and what to check. No fallback, exactly as `timeout` before
       it (review 2026-10-27): a local server that is simply not started must not send the conversation to a cloud
       fallback, nor to another model on the same dead server; whether it should is Andrew's call. The one-retry budget is
       for an address on this computer or this network only (unreachableIsLocal): a public host keeps the ladder. */
    unreachable:            { retryable: true,  shouldRotateCredential: false, shouldFallback: false, shouldCompress: false, retryBudget: 1 },
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
  const NO_CREDIT_RE = /(?:doesn'?t|does not) have any credits|purchase (?:more )?credits|used all (?:of )?(?:its |your )?available credits|(?:reached|exceeded|hit) (?:its |your |the |their )?(?:monthly )?spending limit|insufficient[_ ]?(?:credit|funds|balance)|out of credits?|credit balance is too low|key limit exceeded/;

  const REGION_REFUSAL_RE = /unsupported_country_region_territory|country,? region,? or territory not supported|not available in your (?:country|region)/;
  /* A MODEL THIS ChatGPT ACCOUNT MAY NOT RUN (2026-10-27 report: four gpt-6-astra runs on a ChatGPT sign-in). The Codex
     backend answers 400 "The '<model>' model is not supported when using Codex with a ChatGPT account." when the signed-in
     account has no access to that model, and its own /models list can name a model the account cannot run (openai/codex
     access_programs.rs: "Discovery metadata does not grant access; inference still enforces authorization"). As
     format_error it reached the user as "Something went wrong — try again" with a RETRY chip, and every retry was refused
     the same way. The model is unavailable to this account: no resend, the model dock is the fix, and a configured
     fallback may answer (model_not_found). Mirrored in frontend/app/friendlyerror.js — keep the two in step. */
  const ACCOUNT_MODEL_REFUSED_RE = /model is not supported when using codex with a chatgpt account/;
  /* A MODEL THAT CANNOT SEE IMAGES was sent one (2026-10-23, StarNet Cloud logs: OpenRouter 404 "No endpoints found
     that support image input", 14 managed completions in two bursts). Resending the same request repeats the refusal,
     so it is never retryable; another model may see images, so a configured fallback is still worth taking
     (model_not_found). The adapters (openrouter.js, openai-compatible.js) also remember the model as text-only, so the
     NEXT request to it goes without the image. Mirrored in frontend/app/friendlyerror.js — keep the two in step.
     Vendor wordings: OpenRouter/StarNet "no endpoints found that support image input"; DeepSeek "unknown variant
     `image_url`"; OpenAI's own text-only models (o1-mini, o3-mini, gpt-3.5-turbo, whose /v1/models states no
     modalities, so the image is sent) 400 "Invalid content type. image_url is only supported by certain models." */
  const IMAGE_INPUT_REFUSED_RE = /no endpoints found that support image input|(?:does not|doesn'?t|cannot|can'?t) (?:support|accept|take|handle) (?:image|vision)|image input (?:is )?(?:not supported|unsupported)|(?:images?|vision) (?:input )?(?:is |are )?not supported (?:by|for|on) (?:this|the) model|unknown variant `image_url`|image_url is only supported by certain models/;
  function isImageInputRefusal(text) { return IMAGE_INPUT_REFUSED_RE.test(String(text || '').toLowerCase()); }
  const IMAGE_INPUT_FIX = ' — this model cannot take image input: pick a vision model in the COMMS model dock (or remove the image), then send again.';
  /* A 403 THAT NAMES THE UPSTREAM PROVIDER is that provider refusing THIS request, never our credential (xai-403-1023:
     26 managed completions answered 403 "provider xAI · Provider returned error", and a StarNet-credits user, who has no
     key, was told the provider rejected the API key). A router that rejects OUR key answers 401 and names no provider;
     once it names the upstream (the adapter's err.upstreamProvider, error.provider, error.metadata.provider_name, the
     "[…; provider X]" fact the openai-compatible adapter writes, or OpenRouter's own "Provider returned error" wrapper),
     our key got through and the upstream turned the request down. */
  const UPSTREAM_NAMED_RE = /provider returned error|[\[;] ?provider [^\];]+\]/;
  function namesUpstream(err, low) {
    if (err && typeof err.upstreamProvider === 'string' && err.upstreamProvider) return true;
    const body = extractBody(err);
    const e = body && (body.error || body);
    if (e && typeof e === 'object' && (e.provider || (e.metadata && (e.metadata.provider_name || e.metadata.provider)))) return true;
    return UPSTREAM_NAMED_RE.test(low);
  }
  /* A model_not_found about a PART OF THIS REQUEST, not the model: OpenRouter's capability routing answers 404 "No
     endpoints found that support image input" (a tool screenshot sent to a model that cannot read images — 14 in the
     xai-403-1023 cloud log), "… that support tool use", "… that can handle the requested parameters". The same model
     answers a request without that part. Never set for "No endpoints found for <model>", "matching your data policy",
     "No allowed providers", a region or an upstream 403: those refuse every request to that model. Surfaced as the
     classification's `unsupportedPart` fact (the failure review keys on it: its plain text request has no such part). */
  const UNSUPPORTED_PART_RE = /no endpoints found that (?:support|can handle)\b/;
  // the StarNet credit relay's per-call ceiling refusal (starnet-cloud src/app.js THE CREDIT RESERVATION)
  const CALL_TOO_EXPENSIVE_RE = /could cost more than the \$\d+(?:\.\d+)? starnet allows for one call/;
  function isCallTooExpensive(code, low) {
    return String(code || '').toLowerCase() === 'call_too_expensive' || CALL_TOO_EXPENSIVE_RE.test(low);
  }
  const TOOL_GEN_FAILED_RE = /tool_use_failed|failed to call a function|tool call validation failed/;
  function classify400(low, code, ctx) {
    const c = String(code || '').toLowerCase();
    if (REJECTED_KEY_RE.test(low)) return 'auth';
    /* Anthropic refuses an empty wallet with HTTP 400 invalid_request_error "Your credit balance is too low to
       access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." That read as
       format_error and reached the user as "Something went wrong — try again" (2026-10-07 report, three runs). */
    if (NO_CREDIT_RE.test(low)) return 'billing';
    if (/context_length|context_window|max.*token/.test(c)) return 'context_overflow';
    if (/content_policy|moderation/.test(c)) return 'content_policy_blocked';
    /* Groq answers a tool call the MODEL wrote badly (gpt-oss-120b, Llama) with HTTP 400 `tool_use_failed` — "Failed to
       call a function. Please adjust your prompt." / "Tool call validation failed". The request was fine, the sampled
       generation was not, so the same body resent re-samples and usually lands. As format_error it ended the run at
       zero tokens (2026-10-08 report: gpt-oss-120b on Groq, intermittent provider_stream / format_error). */
    if (/tool_use_failed/.test(c) || TOOL_GEN_FAILED_RE.test(low)) return 'unknown';
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
  /* A NAMED CAUSE BEATS BOTH SIZES (quick win 16, 2026-10-27; email E28, the base64-summarizer credit burn). The run-
     start size used to be checked first and unconditionally, so a run whose OPENING prompt was already over 0.4·window
     (a big pasted document, a screenshot-heavy conversation) read EVERY later 400 as an overflow — "invalid image data"
     too: a destructive fold (a paid summarization call) and a retry of the same bad image, then the run died on the
     same 400. A 400 that says what is wrong with the request is believed, whichever size is large. */
  function overRatio(low, ctx) {
    const limit = Number(ctx && ctx.contextLimit) || 0;
    if (!(limit > 0)) return false;
    if (NAMED_CAUSE_RE.test(low)) return false;
    return (Number(ctx.approxTokens) || 0) > 0.4 * limit || (Number(ctx.liveApproxTokens) || 0) > 0.4 * limit;
  }

  /* A CHAT-TEMPLATE REFUSAL (REASONS.template_refusal): a model's CHAT TEMPLATE refused the conversation's ROLE SHAPE.
     Narrowed on review (2026-10-27) to what proves both halves — a role-shape wording AND a template behind it:
       · the role wordings only chat templates raise: Qwen-family Jinja ("System message must be at the beginning"),
         Gemma ("System role not supported"), the Hugging Face Llama-2 / Mistral / Gemma templates ("Conversation roles
         must alternate user/assistant/…", "After the optional system message, conversation roles must alternate");
       · any role-order wording when the text also names the template engine: LM Studio ("Error rendering prompt with
         jinja template: …"), llama.cpp ("Jinja Exception: …"), raise_exception.
     NOT a template, so NOT this class: a hosted API's own role validator — Anthropic ("messages: roles must alternate
     between "user" and "assistant""), Mistral / mistral_common ("Unexpected role 'user' after role 'tool'", "Expected
     last role User or Tool") — which keeps format_error, its own words first and no chat-template advice; and a template
     ENGINE failure that names no role shape ("default chat template is no longer allowed", "Unknown StringValue filter:
     safe", "chat template does not support tool calls"), which is not StarNet's conversation shape and keeps the class
     it had. */
  const TEMPLATE_ROLE_RE = /system message must be at the beginning|system role (?:is )?not supported|conversation roles must alternate/;
  const ROLE_ORDER_RE = /roles must alternate|unexpected role '?(?:system|user|assistant|tool)'? after role|expected last role/;
  const TEMPLATE_ENGINE_RE = /jinja|chat template|raise_exception|(?:render|rendering|apply|applying) (?:the )?(?:prompt with (?:the )?)?(?:jinja |chat )?template/;
  function templateRefusalLow(low) { return TEMPLATE_ROLE_RE.test(low) || (ROLE_ORDER_RE.test(low) && TEMPLATE_ENGINE_RE.test(low)); }
  function isTemplateRefusal(text) { return templateRefusalLow(String(text || '').toLowerCase()); }
  /* NAME THE TEMPLATE (#102) — and name it FIRST. The customer's diagnostics clamp each error to 300 characters
     (diagnostics.js MSG_MAX) and Ollama's Jinja exception arrives as a ~350-character JSON blob ("While executing
     CallExpression at line 106 …"), so a note appended after it never reached the report the Commander pastes. The
     sentence keeps the adapter's "<label> http <status>" lead (what the page routes on), then says whose template, on
     which host, refused what, with the template's own words; the full provider text rides last, in brackets. With no
     role words to quote (TEMPLATE_SAID_RE found none) the provider's own text leads instead, so the 300 characters a
     report keeps always hold the evidence. Updating the model is advice only for a server on this computer or this
     network; a hosted endpoint's template is its operator's. */
  const TEMPLATE_SAID_RE = /(system message must be at the beginning|(?:after the optional system message, )?conversation roles must alternate[^"'\\\n.]{0,60}|roles must alternate[^"'\\\n.]{0,60}|system role (?:is )?not supported|unexpected role '?[a-z]+'? after role '?[a-z]+'?|expected last role[^"'\\\n.]{0,60})/i;
  function templateRefusalText(text, low, err, ctx) {
    const original = String(text == null ? '' : text);
    const lead = (/^(.{1,80}?\bhttp \d{3})\b\s*[-—:]?\s*/i.exec(original) || [])[1] || '';
    const said = ((TEMPLATE_SAID_RE.exec(original) || [])[1] || '').trim();
    const model = String((ctx && ctx.model) || '').trim();
    const host = refusalHost(err);
    const naming = 'the chat template of ' + (model ? 'the model ' + model : 'this model') + (host ? ' on ' + host : '') + ' refused the conversation StarNet sent';
    const why = ' — StarNet sends one system message first, then user and assistant turns in turn, ending on a user turn'
      + (err && err.templateRetried ? ', and the same conversation with no system message at all was refused too' : '');
    const scope = hostScope(host);
    const fix = '. That template is stricter than the model\'s own chat format: '
      + (scope === 'loopback' || scope === 'private' ? 'update the model on that server (a newer build usually fixes its template), or pick' : 'pick')
      + ' another model in the COMMS model dock.';
    if (!said) return original + ' — ' + naming + why + fix;
    return (lead ? lead + ' — ' : '') + naming + ' ("' + said + '")' + why + fix + ' [' + original + ']';
  }
  // the host a refusal came from: the hostname the adapter stamped (provider.js stampRequestHost — never a URL)
  function refusalHost(err) { return (err && typeof err.requestHost === 'string' && err.requestHost) || ''; }
  /* WHERE A HOST IS, from its name alone: 'loopback' (this computer), 'private' (this network: an RFC 1918 / link-local /
     CGNAT / ULA address, a .local / .lan / .internal / .home name, or a bare name with no dot — a LAN machine or a
     container service), 'public' for anything else, '' when there is no host. Only what the name proves: a public
     name that resolves to a LAN address still reads 'public'. */
  function hostScope(host) {
    // a port comes off "name:port" and "[v6]:port" only: a bare IPv6 address keeps its last group (undici names a refused
    // [::1] as address '::1', which the old strip read as ':' — public)
    const raw = String(host || '').trim().toLowerCase();
    const h = /^\[/.test(raw) ? raw.replace(/^\[([^\]]*)\](?::\d+)?$/, '$1') : raw.split(':').length === 2 ? raw.replace(/:\d+$/, '') : raw;
    if (!h) return '';
    if (h === 'localhost' || /\.localhost$/.test(h) || /^127(?:\.\d+){3}$/.test(h) || h === '::1' || h === '0.0.0.0' || h === '::') return 'loopback';
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)
      || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe80:/.test(h)
      || /\.(?:local|lan|internal|home|home\.arpa)$/.test(h) || (h.indexOf('.') < 0 && h.indexOf(':') < 0)) return 'private';
    return 'public';
  }
  /* REASONS.unreachable — what nothing answering at that address means, in words the Commander can act on, and only
     what the harness can prove (review 2026-10-27). The host and port come from the transport cause (undici:
     cause.hostname for a name that did not resolve, cause.address + cause.port for a refused connection), else the
     hostname the adapter stamped. A refused connection on THIS computer means nothing is listening on that port; on
     this network the server there is not running or refused it; anywhere else a firewall, proxy or VPN can refuse a
     connection as well as a stopped server can, so it says "refused" and points at the network, never "start Ollama". */
  function unreachableHost(err) {
    const cause = (err && err.cause) || {};
    return String(cause.hostname || cause.address || cause.host || refusalHost(err) || '').trim();
  }
  function unreachableNote(err) {
    const code = String(transportCode(err) || '').toUpperCase();
    const cause = (err && err.cause) || {};
    const name = unreachableHost(err);
    let host = name;
    const port = Number(cause.port) > 0 ? String(cause.port) : '';
    if (host && port && host.indexOf(':') < 0) host += ':' + port;
    const where = host || 'the provider\'s address';
    if (code === 'ECONNREFUSED') {
      const scope = hostScope(name);
      if (scope === 'loopback') return 'nothing is listening at ' + where + ' on this computer (the connection was refused) — start the server that should answer there (Ollama, LM Studio …) or correct its address in SETTINGS → AI & MODELS, then send again';
      if (scope === 'private') return 'the connection to ' + where + ' was refused — the server there is not running or not accepting connections: start it, or correct its address in SETTINGS → AI & MODELS, then send again';
      return 'the connection to ' + where + ' was refused — a firewall, proxy or VPN on this network can do that as well as a stopped server: check this computer\'s network and the address in SETTINGS → AI & MODELS, then send again';
    }
    if (code === 'EAI_AGAIN') return 'the name ' + (host || 'of the provider\'s server') + ' could not be looked up just now (EAI_AGAIN, a temporary DNS failure) — check this computer\'s network, then send again';
    return 'the name ' + (host || 'of the provider\'s server') + ' did not resolve (' + code + ') — check the address in SETTINGS → AI & MODELS and this computer\'s network, then send again';
  }
  /* ONE RETRY, BUT NOT A HASTY ONE, FOR A NAME LOOKUP (review 2026-10-27). unreachable makes one retry (retryBudget). A
     refused connection retries at the ladder's first rung; a name that did not resolve — what a Wi-Fi drop, a VPN
     reconnect or a DNS hiccup looks like for a second or two (Windows reports an offline lookup as ENOTFOUND) — waits
     this long first, so that one retry outlasts a blip instead of landing inside it. Read by every adapter's pre-stream
     ladder and by recovery-policy (provider.runtime.retryDelay, the classification's retryDelayMs). */
  const DNS_RETRY_DELAY_MS = 4000;
  /* …AND ONLY FOR AN ADDRESS ON THIS COMPUTER OR THIS NETWORK (0.14.2 release review, B5). The one retry is for what the class
     fixed: a local server (Ollama, LM Studio, a machine on the LAN) that is not started, where a ladder only delays the
     sentence that names it. A PUBLIC host that does not answer is what a Wi-Fi drop, a VPN reconnect or sleep/wake looks
     like for a while, and a reply cut mid-stream reconnects with the network still down, so one retry ended hosted-model
     tasks in about half a second. A public host, or one the error does not name, keeps the ladder it rode as `timeout` in
     0.14.1 (retryBudget and retryDelayMs null; no fallback, as timeout); the sentence naming the address stays either way. */
  function unreachableIsLocal(err) {
    const scope = hostScope(unreachableHost(err));
    return scope === 'loopback' || scope === 'private';
  }

  /* A 429 is not always "wait a few seconds". A ChatGPT-subscription user who has burned their WEEKLY quota
     gets a 429 whose body says exactly that and whose reset is days away — so the honest class is a spent
     allowance, not a rate limit. Status-before-message precedence is deliberate (see the note in pickReason),
     so this is a distinct class WITHIN the 429 rather than a reordering: only a long or absolute reset window,
     or an explicit usage-limit type, qualifies. Gemini answers a PER-MINUTE limit with "Quota exceeded for
     quota metric", and that must stay rate_limit — hence the short-window veto. */
  const QUOTA_EXHAUSTED_RE = /usage[_ ]?limit(?:[_ ]?(?:has|is)(?:[_ ]?been)?)?[_ ]?reached|hit (?:your|the) (?:usage|weekly|monthly|plan|daily) limit|(?:weekly|monthly|daily) (?:quota|limit)|resets? in \s*\d+\s*(?:day|hour|week)|resets? (?:on|at) \d|quota (?:will )?reset(?:s)? (?:in|on|at)/;
  const SHORT_WINDOW_RE = /per[- ]?(?:minute|second)|quota metric|\brpm\b|\btpm\b|requests per/;
  /* OpenRouter's FREE-MODEL DAILY CAP ("Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free
     model requests per day") resets the next UTC day. Its own text says "requests per day", which the short-window veto
     above reads as a per-minute limit — so it is named outright, ahead of the veto (sweep/providers 2026-10-20). */
  const DAILY_FREE_CAP_RE = /free-models-per-day/;
  function isQuotaExhausted(low) { return DAILY_FREE_CAP_RE.test(low) || (QUOTA_EXHAUSTED_RE.test(low) && !SHORT_WINDOW_RE.test(low)); }

  function pickReason(status, code, low, err, ctx) {
    // 0. errors that never reached an API: a certificate the machine rejects, or a crash in our own code. First,
    //    because neither carries a status or a body — so no later rule can be describing the provider's intent.
    if (!status && isTlsFailure(err, low)) return 'tls_certificate';
    // The Ollama adapter proves the runtime and an explicit failed allocation, even when it returns 500.
    if (err && err.localModelMemory === true) return 'local_memory';
    // The Ollama adapter proved the model sat loaded through a whole silent connect ceiling (openai-compatible.js).
    if (err && err.localModelTimeout === true) return 'local_timeout';
    // The adapter proved the URL answers as a different kind of server (openai-compatible.js notOllamaError).
    if (err && err.endpointMismatch === true) return 'endpoint_mismatch';
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
    // 1a. an image sent to a model that cannot see it: whatever status carried it (OpenRouter 404, a vendor 400),
    //     the same request is refused again — never a malformed request to fold or a key to rotate
    //     (a 401 is always our credential: it stays auth whatever its text says)
    if (!transportStatus && status !== 401 && IMAGE_INPUT_REFUSED_RE.test(low)) return 'model_not_found';
    // 1a'. a ChatGPT account the Codex backend will not serve this model to: the same request is refused again
    if (!transportStatus && status !== 401 && ACCOUNT_MODEL_REFUSED_RE.test(low)) return 'model_not_found';
    // 1b. OUTPUT cap — BEFORE the overflow patterns, whose `maximum.*tokens` matches this refusal's wording and
    //     used to fold history for nothing, retry the identical max_tokens, and kill the run.
    if ((!status || status === 400 || status === 422) && parseOutputCap(low) > 0) return 'output_cap';
    // 1c. the StarNet relay's per-call price ceiling — a 400 that is neither malformed nor an overflow
    if ((!status || status === 400) && isCallTooExpensive(code, low)) return 'call_too_expensive';
    // 1d. the model's chat template refused the conversation's shape — whatever status carried it: Ollama's /v1 sends
    //     its Jinja exception as a 500 (#102), LM Studio as a 400. Never our credential (401/403) and never a busy
    //     moment (429). A hosted API's own role validator is not a template (templateRefusalLow): it stays format_error.
    if (status !== 401 && status !== 403 && status !== 429 && templateRefusalLow(low)) return 'template_refusal';
    // 2. HTTP status
    if (status) {
      // a 403 the UPSTREAM gave for this region (OpenAI behind OpenRouter: unsupported_country_region_territory) is the
      // model being unavailable here — the key is fine, and another model/provider may answer (shouldFallback)
      if (status === 403 && REGION_REFUSAL_RE.test(low)) return 'model_not_found';
      // an upstream provider's 403 (namesUpstream): a safety wording was content_policy_blocked above; anything else is
      // this model unavailable for this request — no resend, a configured fallback may answer, no credential rotation
      if (status === 403 && !NO_CREDIT_RE.test(low) && namesUpstream(err, low)) return 'model_not_found';
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
    // 5. transport — nothing answering at the address (refused, or a name that did not resolve) is `unreachable`;
    //    a connection that was made and then dropped or stalled stays `timeout`
    if (/^(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN)$/i.test(String(transportCode(err) || ''))) return 'unreachable';
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
    const localUnreachable = reason === 'unreachable' && unreachableIsLocal(err);   // one retry here; a public host: the ladder
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
    } else if (reason === 'model_not_found' && IMAGE_INPUT_REFUSED_RE.test(low)) {
      // the provider's words stay first (the UI routes on the adapter label + status); the fix rides after them
      text += IMAGE_INPUT_FIX;
    } else if (reason === 'template_refusal') {
      text = templateRefusalText(text, low, err, ctx);
    } else if (reason === 'unreachable') {
      text += ' — ' + unreachableNote(err);
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
      // model_not_found only: the model cannot take a PART of this request (image input, tool use, a parameter) —
      // a request without that part still reaches it (UNSUPPORTED_PART_RE). False for every other verdict.
      unsupportedPart: reason === 'model_not_found' && UNSUPPORTED_PART_RE.test(low),
      // the most re-sends this class is worth, when it is fewer than a ladder's (unreachable at a local address: 1); null = the
      // ladder's own
      retryBudget: typeof f.retryBudget === 'number' && (reason !== 'unreachable' || localUnreachable) ? f.retryBudget : null,
      // unreachable at a local address only: a name that did not resolve waits DNS_RETRY_DELAY_MS before its one retry (a blip
      // outlasted); null = the ladder's own rung
      retryDelayMs: localUnreachable && /^(?:ENOTFOUND|EAI_AGAIN)$/i.test(String(transportCode(err) || '')) ? DNS_RETRY_DELAY_MS : null,
      // `reason` above was already picked from the RAW message, so annotating here cannot move the verdict — it
      // only makes the text a human can act on ("fetch failed" -> "fetch failed (ENOTFOUND api.openai.com)").
      // This is the message the loop emits as agent.run.error, which is what lands in the diagnostics ring.
      message: text
    };
  }

  return { classifyApiError, REASONS, transportDetail, annotateTransport, isImageInputRefusal, isTemplateRefusal,
    _internals: { extractStatus, extractCode, extractMessage, classify400, pickReason, extractRetryAfter, transportCode, parseOutputCap, isTlsFailure, isLocalError, overRatio, unreachableNote, unreachableIsLocal, hostScope, templateRefusalText } };
});
