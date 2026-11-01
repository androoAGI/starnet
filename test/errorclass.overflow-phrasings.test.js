/* node test/errorclass.overflow-phrasings.test.js — the provider-error truth table the 2026-09-22 Hermes audit
   found wrong (F1). Pure: hand-built error objects shaped like each adapter's throw, no network.
     · every real context-overflow phrasing (Anthropic, Bedrock, llama.cpp, "context window") and a bare 413
       -> context_overflow (the compress-and-retry path);
     · the OUTPUT-cap refusal -> output_cap carrying the allowed ceiling, and NOT an overflow;
     · our own TypeError/ReferenceError/SyntaxError/RangeError -> non-retryable (a bug fails fast);
     · a TLS certificate failure -> non-retryable with an actionable message;
     · a bare 529 -> overloaded;
     · the classes that were already right stay right (spot-checks). */
'use strict';
const A = require('./_assert.js');
const { classifyApiError, REASONS } = require('../sidecar/providers/errorClass.js');

const R = (err, ctx) => classifyApiError(err, ctx || {});
// adapter-shaped HTTP failure: `new Error('<label> http <status> - <detail>')` with .status set
const httpErr = (status, detail, label) => Object.assign(new Error((label || 'anthropic') + ' http ' + status + ' - ' + (detail || '')), { status });
// Anthropic's native error body, the way a caller holding the parsed JSON would see it
const anthropicBody = (status, message) => Object.assign(new Error('api error'), { status, body: { type: 'error', error: { type: 'invalid_request_error', message } } });

// ---- A. context-overflow phrasings the old `maximum.*tokens` pattern could not read ----
{
  const phrasings = [
    ['anthropic', 'prompt is too long: 215000 tokens > 200000 maximum'],
    ['anthropic (input + max_tokens)', 'input length and `max_tokens` exceed context limit: 197000 + 21333 > 200000, decrease input length or `max_tokens` and try again'],
    ['bedrock', 'Input is too long for requested model.'],
    ['llama.cpp', 'the request exceeds the available context size, try increasing it'],
    ['llama.cpp (short)', 'context size exceeded'],
    ['generic', 'This request exceeds the context window of the selected model'],
    ['openai (unchanged)', "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens."],
    ['gemini (unchanged)', 'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).']
  ];
  for (const [who, msg] of phrasings) {
    // a realistic, SMALL approxTokens against a warm 200k window: the ratio heuristic can NOT be what fires here
    const ctx = { approxTokens: 5000, contextLimit: 200000 };
    const v400 = R(httpErr(400, msg), ctx);
    A.eq(v400.reason, 'context_overflow', who + ' 400 -> context_overflow');
    A.eq(v400.shouldCompress, true, who + ' overflow -> shouldCompress');
    A.eq(v400.retryable, false, who + ' overflow is not a blind retry');
    A.eq(R(new Error(msg), ctx).reason, 'context_overflow', who + ' with NO status (mid-stream text) -> context_overflow');
  }
  // the parsed Anthropic body shape (message lives on body.error.message, not err.message)
  A.eq(R(anthropicBody(400, 'prompt is too long: 215000 tokens > 200000 maximum')).reason, 'context_overflow', 'Anthropic error BODY -> context_overflow');

  // a BARE 413 is the request being too big for the endpoint -> compress path, whatever (or whether) the body says
  const bare413 = Object.assign(new Error('openai-compatible http 413 - '), { status: 413 });
  A.eq(R(bare413).reason, 'context_overflow', 'bare 413 -> context_overflow');
  A.eq(R(bare413).shouldCompress, true, 'bare 413 -> shouldCompress');
  A.eq(R(httpErr(413, 'Request exceeds the maximum allowed number of bytes.')).reason, 'context_overflow', 'Anthropic 413 request_too_large -> context_overflow');
  A.eq(R({ status: 413 }).reason, 'context_overflow', 'status-only 413 object -> context_overflow');
  // 413 status wins over a policy-looking word in a gateway page? No: content policy is intent, and it still wins
  // for a non-transport status — keep the precedence the policy table documents.
  A.eq(R(httpErr(400, 'Your request was flagged by our content policy')).reason, 'content_policy_blocked', 'content_policy stays intact');
}

// ---- B. the OUTPUT cap is its own class, never an overflow ----
{
  const anth = httpErr(400, 'max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-sonnet-4-5-20250929');
  const v = R(anth, { approxTokens: 5000, contextLimit: 200000 });
  A.eq(v.reason, 'output_cap', 'Anthropic output-cap refusal -> output_cap');
  A.eq(v.allowedMaxTokens, 64000, 'the allowed ceiling is parsed off the refusal');
  A.eq(v.shouldCompress, false, 'output_cap does NOT fold history');
  A.eq(v.retryable, false, 'output_cap is not re-sent unchanged by an adapter');
  A.ok(v.reason !== 'context_overflow', 'the `maximum.*tokens` wording no longer mislabels it as an overflow');
  A.eq(R(anthropicBody(400, 'max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-opus-4-1')).allowedMaxTokens, 64000, 'parsed from the Anthropic error BODY too');
  A.eq(R(new Error('max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-x')).reason, 'output_cap', 'no-status output cap -> output_cap');
  const oai = R(httpErr(400, 'max_tokens is too large: 200000. This model supports at most 16384 completion tokens, whereas you provided 200000.', 'openai'));
  A.eq([oai.reason, oai.allowedMaxTokens], ['output_cap', 16384], 'OpenAI "supports at most N completion tokens" -> output_cap 16384');
  const groq = R(httpErr(400, '`max_tokens` must be less than or equal to `8192`, the maximum value for `max_tokens` is less than the `context_window` for this model', 'groq'));
  A.eq([groq.reason, groq.allowedMaxTokens], ['output_cap', 8192], 'a "must be less than or equal to N" cap mentioning context_window is still output_cap');
  const ds = R(httpErr(400, 'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]', 'deepseek'));
  A.eq([ds.reason, ds.allowedMaxTokens], ['output_cap', 8192], 'DeepSeek valid-range refusal -> output_cap 8192');
  // not every class carries the field — it is null elsewhere, never a guessed number
  A.eq(R(httpErr(400, 'prompt is too long: 215000 tokens > 200000 maximum')).allowedMaxTokens, null, 'overflow carries no allowedMaxTokens');
  // a cap phrasing with no readable number is not actionable -> ordinary 400 handling
  A.eq(R(httpErr(400, 'max_tokens is too large for this model')).reason, 'format_error', 'an unnumbered cap complaint is not output_cap');
}

// ---- C. our own programming errors fail fast; transport TypeErrors stay retryable ----
{
  for (const e of [new TypeError("Cannot read properties of undefined (reading 'choices')"), new ReferenceError('usage is not defined'),
    new SyntaxError('Unexpected token } in JSON at position 12'), new RangeError('Invalid string length')]) {
    const v = R(e);
    A.eq(v.reason, 'local_error', e.name + ' -> local_error');
    A.eq(v.retryable, false, e.name + ' is NOT retryable (no 7 attempts over ~106s for a bug)');
    A.eq(v.shouldFallback, false, e.name + ' does not burn the fallback chain');
    A.ok(v.message.indexOf(e.name + ': ') === 0 && v.message.indexOf(e.message) > 0, e.name + ' keeps the real message, named: ' + v.message);
  }
  // undici/browser transport failures are TypeErrors too — they must stay transient
  A.eq(R(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })).reason, 'timeout', 'TypeError fetch failed + ECONNRESET cause stays timeout');
  A.eq(R(new TypeError('fetch failed')).retryable, true, 'a bare TypeError: fetch failed stays retryable');
  A.eq(R(new TypeError('terminated')).retryable, true, "undici's mid-body TypeError: terminated stays retryable");
  A.eq(R(new TypeError('Failed to fetch')).retryable, true, "the browser's TypeError: Failed to fetch stays retryable");
  A.eq(R(Object.assign(new TypeError('boom'), { code: 'UND_ERR_SOCKET' })).retryable, true, 'a TypeError carrying a transport code stays retryable');
  // a TypeError that somehow carries an HTTP status is the provider answering, not our bug
  A.ok(R(Object.assign(new TypeError('x'), { status: 503 })).reason === 'overloaded', 'a status-bearing TypeError classifies by its status');
  // a plain Error with an unrecognized message is still the safe-ish `unknown` retry
  A.eq(R(new Error('something weird happened')).reason, 'unknown', 'plain Error unknown is unchanged');
}

// ---- D. TLS certificate failures: non-retryable, actionable ----
{
  const undiciTls = (code, msg) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(msg || code), { code, host: 'api.example.com' }) });
  for (const code of ['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    const v = R(undiciTls(code));
    A.eq(v.reason, 'tls_certificate', code + ' -> tls_certificate');
    A.eq(v.retryable, false, code + ' is not retried (waiting never fixes a certificate)');
    A.ok(v.message.indexOf(code) >= 0, code + ' is named in the message');
  }
  const direct = R(Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }));
  A.eq(direct.reason, 'tls_certificate', 'a node https error with the code directly on it -> tls_certificate');
  const text = R(new Error('SSL: certificate verify failed: self-signed certificate in certificate chain'));
  A.eq(text.reason, 'tls_certificate', 'a "certificate verify failed" message with no code -> tls_certificate');
  A.ok(/NODE_EXTRA_CA_CERTS/.test(text.message) && /certificate/.test(text.message), 'the message tells the user what to do: ' + text.message.slice(0, 120));
  A.ok(/certificate verify failed/.test(text.message), 'the original text is preserved inside the actionable message');
  A.eq(text.shouldFallback, true, 'a configured fallback (a different host) may still verify');
  // a certificate complaint that came back AS an HTTP status is the upstream's problem, not this machine's
  A.eq(R(httpErr(502, 'upstream certificate verify failed', 'openrouter')).reason, 'overloaded', 'a 502 about an upstream cert stays a transient 502');
}

// ---- E. 529 and the other 5xx ----
{
  A.eq(R(Object.assign(new Error('anthropic http 529 - '), { status: 529 })).reason, 'overloaded', 'bare 529 -> overloaded');
  A.eq(R({ status: 529 }).retryable, true, '529 is retryable');
  A.eq(R({ status: 529 }).shouldFallback, true, '529 may fail over like any overload');
  A.eq(R(httpErr(529, 'Overloaded')).reason, 'overloaded', '529 with text -> overloaded (unchanged)');
  A.eq(R({ status: 520 }).reason, 'server_error', 'a Cloudflare 520 is a transient server_error, not unknown');
  A.eq(R({ status: 501 }).reason, 'unknown', '501 Not Implemented is NOT promoted to a transient server error');
}

// ---- F. the classes that were already right stay right ----
{
  A.eq(R(httpErr(429, 'slow down', 'openai')).reason, 'rate_limit', '429 -> rate_limit');
  A.eq(R(httpErr(429, 'slow down', 'openai')).retryable, true, 'rate_limit retryable');
  A.eq(R(httpErr(401, 'invalid x-api-key')).reason, 'auth', '401 -> auth');
  A.eq(R(httpErr(403)).retryable, false, 'auth not retryable');
  A.eq(R(httpErr(402, 'insufficient credits', 'openrouter')).reason, 'billing', '402 -> billing');
  A.eq(R(httpErr(429, 'You exceeded your current quota, please check your plan and billing details.', 'openai')).reason, 'billing', 'insufficient_quota 429 -> billing');
  A.eq(R(httpErr(429, 'The usage limit has been reached. Your limit resets in 3 days.', 'codex')).reason, 'quota_exhausted', 'weekly usage limit -> quota_exhausted');
  A.eq(R(httpErr(400, 'bad request'), { contextLimit: 0, approxTokens: 999999 }).reason, 'format_error', 'cold catalog bare 400 stays format_error');
  A.eq(R(httpErr(400, 'bad request'), { contextLimit: 8000, approxTokens: 5000 }).reason, 'context_overflow', 'warm-catalog ratio heuristic still fires');
  A.eq(R(httpErr(503, 'overloaded')).reason, 'overloaded', '503 -> overloaded');
  A.eq(R(httpErr(504)).reason, 'timeout', '504 -> timeout');
  // the per-minute veto is a real word boundary again (it had decayed into literal backspace bytes, so a
  // "tpm limit … resets in 2 hours" 429 was misread as a DAYS-long spent allowance and never retried)
  A.eq(R(httpErr(429, 'tpm limit reached, resets in 2 hours', 'openai')).reason, 'rate_limit', 'a TPM window with an hours-long reset is still rate_limit');
  A.eq(R(httpErr(429, 'rpm limit reached, resets in 2 hours', 'openai')).reason, 'rate_limit', 'an RPM window with an hours-long reset is still rate_limit');
  for (const k of ['output_cap', 'tls_certificate', 'local_error']) {
    const f = REASONS[k];
    A.ok(f && typeof f.retryable === 'boolean' && typeof f.shouldFallback === 'boolean' && typeof f.shouldCompress === 'boolean' && typeof f.shouldRotateCredential === 'boolean', 'new reason "' + k + '" has all four boolean flags');
    A.eq(f.retryable, false, 'new reason "' + k + '" is never a blind retry');
  }
}

// ---- C. the LIVE prompt size only speaks for a 400 that names no cause of its own ----
{
  // a long run (90k live of a 200k window, started at 2k): an unrelated 400 is NOT an overflow
  const live = { approxTokens: 2000, liveApproxTokens: 90000, contextLimit: 200000 };
  A.eq(R(httpErr(400, 'messages.3.content.0.image.source.base64: invalid base64 data'), live).reason, 'format_error', 'invalid base64 at 90k/200k live -> format_error, not overflow');
  A.eq(R(httpErr(400, 'tools.2.input_schema: JSON schema is invalid'), live).reason, 'format_error', 'a bad tool schema at 90k/200k live -> format_error');
  A.eq(R(httpErr(400, 'invalid base64'), live).shouldCompress, false, 'a named-cause 400 never takes the destructive fold');
  // a genuine overflow phrasing is still an overflow at any size
  A.eq(R(httpErr(400, 'prompt is too long: 215000 tokens > 200000 maximum'), live).reason, 'context_overflow', 'overflow wording at 90k live -> context_overflow');
  // a bare/unrecognizable 400 on a grown run is still recognized by the live ratio
  A.eq(R(httpErr(400, 'invalid request'), live).reason, 'context_overflow', 'a cause-less 400 on a grown run -> context_overflow (live ratio)');
  A.eq(R(httpErr(400, 'invalid request'), { approxTokens: 2000, liveApproxTokens: 50000, contextLimit: 200000 }).reason, 'format_error', 'under 0.4 live -> format_error');
  // QUICK WIN 16 (email E28, the base64-summarizer credit burn): a named cause beats the RUN-START size too. A run that
  // opened over 0.4 of the window read "invalid image data" as an overflow: a paid fold, the same bad image resent, and
  // the run died on the same 400 anyway.
  const bigStart = { approxTokens: 90000, contextLimit: 200000 };
  A.eq(R(httpErr(400, 'invalid base64'), bigStart).reason, 'format_error', 'run-start ratio: a named cause (invalid base64) is believed');
  A.eq(R(httpErr(400, 'invalid image data'), bigStart).reason, 'format_error', 'run-start ratio: invalid image data stays format_error');
  A.eq(R(httpErr(400, 'invalid image data'), bigStart).shouldCompress, false, 'run-start ratio: no destructive fold for a named cause');
  A.eq(R(httpErr(400, 'messages.4.content.1.image.source: invalid image data'), { approxTokens: 90000, liveApproxTokens: 95000, contextLimit: 200000 }).reason, 'format_error', 'both sizes large: the named cause still wins');
  // ...and a cause-less 400 on a run that STARTED large is still recognized by the run-start ratio
  A.eq(R(httpErr(400, 'invalid request'), bigStart).reason, 'context_overflow', 'run-start ratio: a cause-less 400 -> context_overflow');
  A.eq(R(Object.assign(new Error('bad request body'), {}), bigStart).reason, 'context_overflow', 'run-start ratio: a statusless cause-less error -> context_overflow');
  A.eq(R(httpErr(400, 'invalid request'), { approxTokens: 2000, liveApproxTokens: 999999, contextLimit: 0 }).reason, 'format_error', 'cold catalog: live size never fires the ratio');
}

A.report('errorclass.overflow-phrasings.test');
