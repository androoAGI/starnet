/* node test/errorclass.test.js — API error classification truth table (L3.S1).
   Pure: builds error objects shaped like the openrouter adapter / node fetch throws, asserts reason +
   action flags. The cold-catalog guard (contextLimit 0) must NOT mislabel a bare 400 as context_overflow. */
'use strict';
const A = require('./_assert.js');
const { classifyApiError, REASONS } = require('../sidecar/providers/errorClass.js');
const { friendlyError, actionButton, KINDS } = require('../frontend/app/friendlyerror.js');

// openrouter-adapter-shaped error: `new Error('openrouter http <s> — <detail>')` with .status set
function httpErr(status, detail) { return Object.assign(new Error('openrouter http ' + status + (detail ? ' — ' + detail : '')), { status: status }); }
function bodyErr(status, body) { return Object.assign(new Error('api error'), { status: status, body: body }); }
const R = (err, ctx) => classifyApiError(err, ctx || {});

// ---- A. HTTP status -> reason + headline action flags ----
{
  A.eq(R(httpErr(401)).reason, 'auth', '401 -> auth');
  A.eq(R(httpErr(401)).retryable, false, 'auth not retryable');
  A.eq(R(httpErr(401)).shouldRotateCredential, true, 'auth -> rotate credential');

  A.eq(R(httpErr(402, 'insufficient credits')).reason, 'billing', '402 out-of-credits -> billing');
  A.eq(R(httpErr(402, 'insufficient credits')).retryable, false, 'billing not retryable (no point burning attempts)');
  A.eq(R(httpErr(402, 'rate limit resets at midnight')).reason, 'rate_limit', '402 that is really a rate window -> rate_limit');

  A.eq(R(httpErr(429, 'slow down')).reason, 'rate_limit', '429 -> rate_limit');
  A.eq(R(httpErr(429)).retryable, true, 'rate_limit retryable');

  A.eq(R(httpErr(500)).reason, 'server_error', '500 -> server_error');
  A.eq(R(httpErr(500)).retryable, true, 'server_error retryable');
  A.eq(R(httpErr(500)).shouldFallback, true, 'server_error -> fallback provider');

  A.eq(R(httpErr(503, 'overloaded')).reason, 'overloaded', '503 -> overloaded');
  A.eq(R(httpErr(502)).reason, 'overloaded', '502 -> overloaded');
  A.eq(R(httpErr(504)).reason, 'timeout', '504 -> timeout');
  A.eq(R(httpErr(408)).reason, 'timeout', '408 -> timeout');

  A.eq(R(httpErr(404, 'no endpoints found for model')).reason, 'model_not_found', '404 -> model_not_found');
  A.eq(R(httpErr(404)).shouldFallback, true, 'model_not_found -> fallback');
}

// ---- A2. xAI's own shapes (live-probed 2026-09-27): a REJECTED KEY arrives as 400, an UNFUNDED team as 403 ----
{
  // the adapter's own sentence, with the provider body kept for its code (err.ownMessage), exactly as openai-compatible throws it
  const xaiErr = (status, body) => Object.assign(new Error('openai-compatible http ' + status + ' - ' + JSON.stringify(body)), { status: status, body: body, ownMessage: true });
  const badKey = xaiErr(400, { code: 'invalid-argument', error: 'Incorrect API key provided. You can obtain an API key from https://console.x.ai.' });
  A.eq(R(badKey).reason, 'auth', 'xAI bad-key 400 -> auth (was format_error: "Something went wrong")');
  A.eq(R(badKey).shouldRotateCredential, true, 'a rejected key rotates to the next pooled key');
  const broke = xaiErr(403, { code: 'The caller does not have permission to execute the specified operation', error: 'Your newly created team doesn\'t have any credits yet. You can purchase credits on https://console.x.ai/team/x.' });
  A.eq(R(broke).reason, 'billing', 'xAI no-credits 403 -> billing (was auth: "No model is connected yet")');
  A.eq(R(xaiErr(403, { error: 'Your team has either used all available credits or reached its monthly spending limit.' })).reason, 'billing', 'xAI spent-credits 403 -> billing');
  A.eq(R(xaiErr(403, { error: 'The caller does not have permission to execute the specified operation' })).reason, 'auth', 'a plain permission 403 stays auth');
  A.ok(R(new Error('An earlier run was interrupted before its spend was recorded, so the spending limits you set can’t be checked. Settle it in SETTINGS › SPENDING LIMITS.')).reason !== 'billing', 'a local spend-ledger error is not provider billing');
  A.eq(R(httpErr(400, 'Invalid value for messages[0].role')).reason, 'format_error', 'an ordinary malformed 400 is still format_error');
}

// ---- B. 400 ambiguity: context vs format, gated by the cold-catalog guard ----
{
  A.eq(R(httpErr(400, 'maximum context length is 8192 tokens')).reason, 'context_overflow', '400 w/ context message -> context_overflow');
  A.eq(R(httpErr(400, 'maximum context length is 8192 tokens')).shouldCompress, true, 'context_overflow -> compress');

  // bare 400, COLD catalog (contextLimit 0) -> must fall to format_error, NOT context_overflow
  A.eq(R(httpErr(400, 'bad request'), { contextLimit: 0, approxTokens: 999999 }).reason, 'format_error', 'cold catalog: bare 400 -> format_error (not overflow)');
  A.eq(R(httpErr(400, 'bad request')).retryable, false, 'format_error not retryable');

  // bare 400, WARM catalog + over the ratio -> context_overflow
  A.eq(R(httpErr(400, 'bad request'), { contextLimit: 8000, approxTokens: 5000 }).reason, 'context_overflow', 'warm catalog + over ratio -> context_overflow');
  // bare 400, WARM catalog + under the ratio -> format_error
  A.eq(R(httpErr(400, 'bad request'), { contextLimit: 8000, approxTokens: 100 }).reason, 'format_error', 'warm catalog + under ratio -> format_error');
}

// ---- C. structured error-code (no HTTP status) + metadata.raw unwrap ----
{
  A.eq(R(bodyErr(null, { error: { code: 'context_length_exceeded', message: 'too long' } })).reason, 'context_overflow', 'structured context_length_exceeded code');
  A.eq(R(bodyErr(null, { error: { code: 'insufficient_quota', message: 'pay up' } })).reason, 'billing', 'structured insufficient_quota -> billing');
  // a 400 that ALSO carries a structured context code is caught inside the 400 branch (status wins, code consulted)
  A.eq(R(bodyErr(400, { error: { code: 'context_length_exceeded', message: 'x' } })).reason, 'context_overflow', '400 + context code -> context_overflow');
  // metadata.raw is folded into the classified message
  const raw = R(bodyErr(429, { error: { message: 'Provider error', metadata: { raw: 'upstream said rate limited' } } }));
  A.ok(/upstream said rate limited/.test(raw.message), 'metadata.raw unwrapped into message');
}

// ---- D. content policy beats everything ----
{
  A.eq(R(httpErr(400, 'flagged by content policy')).reason, 'content_policy_blocked', 'content policy wins over a 400');
  A.eq(R(new Error('request blocked by moderation')).reason, 'content_policy_blocked', 'moderation message -> content_policy_blocked');
}

// ---- E. transport / network codes -> timeout (retryable) ----
{
  A.eq(R(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).reason, 'timeout', 'ECONNRESET -> timeout');
  A.eq(R(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })).reason, 'timeout', 'node fetch cause.code -> timeout');
  A.eq(R(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).retryable, true, 'transport timeout retryable');
}

// ---- F. unknown -> retryable; statusCode echoed; message preserved ----
{
  const u = R(new Error('something weird happened'));
  A.eq(u.reason, 'unknown', 'unrecognized -> unknown');
  A.eq(u.retryable, true, 'unknown is retryable (one more attempt is safe-ish)');
  A.eq(R(httpErr(429)).statusCode, 429, 'statusCode echoed');
  A.eq(R(httpErr(500, 'boom')).statusCode, 500, 'statusCode echoed for 5xx');
  A.ok(/boom/.test(R(httpErr(500, 'boom')).message), 'detail preserved in message');
}

// ---- G. every reason in REASONS yields a complete, well-typed verdict ----
{
  for (const k of Object.keys(REASONS)) {
    const f = REASONS[k];
    A.ok(typeof f.retryable === 'boolean' && typeof f.shouldFallback === 'boolean' && typeof f.shouldCompress === 'boolean' && typeof f.shouldRotateCredential === 'boolean', 'reason "' + k + '" has all four boolean flags');
  }
}

// ---- H6.1: server-stated wait extraction (Retry-After / reset_at), pure & clockless ----
{
  let c = R({ status: 429, headers: { 'Retry-After': '30' } });
  A.eq(c.retryAfterMs, 30000, 'Retry-After: 30 -> 30000ms relative');
  A.eq(c.resetAtMs, null, 'a relative Retry-After leaves resetAtMs null');

  c = R({ status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } });
  A.eq(c.retryAfterMs, null, 'an HTTP-date Retry-After is not a relative delay');
  A.eq(c.resetAtMs, Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'), 'HTTP-date Retry-After -> absolute resetAtMs');

  c = R({ status: 429, headers: { 'x-ratelimit-reset': '1900000000' } });
  A.eq(c.resetAtMs, 1900000000 * 1000, 'X-RateLimit-Reset epoch-seconds -> *1000 resetAtMs');

  c = R({ status: 429, message: 'Rate limit exceeded. Please try again in 1.5s.' });
  A.eq(c.retryAfterMs, 1500, '"try again in 1.5s" -> 1500ms');

  c = R({ status: 429, message: 'Too many requests, retry in 2 minutes' });
  A.eq(c.retryAfterMs, 120000, '"retry in 2 minutes" -> 120000ms');

  c = R({ status: 500, message: 'internal error' });
  A.eq(c.retryAfterMs, null, 'no hint -> retryAfterMs null');
  A.eq(c.resetAtMs, null, 'no hint -> resetAtMs null');

  c = R({ status: 429, headers: { 'retry-after': 'soon-ish' } });
  A.eq(c.reason, 'rate_limit', 'unparseable Retry-After still classifies normally');
  A.eq(c.retryAfterMs, null, 'unparseable Retry-After -> null (no crash)');
}

// ---- I. friendlyError (frontend) — the BEGINNER-FACING layer over the classifier (B5). It turns the raw
//        thrown Error / in-band error string the COMMS panel sees into { userMessage, kind, retryable, action,
//        raw }, leading with plain language and pointing non-retryable faults at the right destination. ----
const F = (err, status, opts) => friendlyError(err, status, opts);
{
  // 5xx / "sidecar HTTP 5xx" -> retryable server_error
  let v = F(new Error('sidecar HTTP 500'));
  A.eq(v.kind, 'server_error', '5xx -> server_error');
  A.eq(v.retryable, true, 'server_error retryable');
  A.eq(v.action, null, 'server_error has no deep-link action');
  A.ok(/local StarNet service hit an error/i.test(v.userMessage), 'server_error leads with the friendly headline');
  A.ok(/sidecar HTTP 500/.test(v.raw), 'raw technical text preserved for the dim sub-line');
  // 2026-07-30: this line used to assert the DEFECT (a bare 503 -> the "local StarNet service" copy). A 503
  // with no sidecar evidence in the raw is a provider-shaped failure — the local claim owes proof it never has.
  A.eq(F({ status: 503 }).kind, 'provider_server_error', 'a bare 503 status -> the PROVIDER server bucket');

  // network / transport loss -> retryable network. The KIND is unchanged by proof; only the COPY moves, because
  // the kind drives behavior (retry, no door) while the copy is the part that names a culprit.
  v = F(new Error('cannot reach the STARNET sidecar — start it with `npm start`'));
  A.eq(v.kind, 'network', 'transport loss -> network');
  A.eq(v.retryable, true, 'network retryable');
  A.eq(F(new Error('Failed to fetch')).kind, 'network', 'browser "Failed to fetch" -> network');

  /* THE COPY OWES PROOF (2026-07-29 regression guard). This block previously asserted that ANY transport loss
     leads with "Can't reach StarNet's local service" — i.e. the test was pinning the defect in place. That
     sentence tells the user to restart the app, and it was being shown for an upstream model-stream drop against
     a perfectly healthy sidecar (a real 0.7.0 user report: days lost restarting and reinstalling). The wording
     is now a function of a MEASURED /api/health probe, and the three states must stay distinguishable. */
  v = F(new Error('terminated'), null, { engineAlive: false });
  A.eq(v.kind, 'network', 'proven-dead engine is still the network kind');
  A.eq(v.engineAlive, false, 'measured verdict rides on the verdict object');
  A.ok(/Can't reach StarNet's local service/i.test(v.userMessage), 'engine proven DOWN earns the restart copy');

  v = F(new Error('terminated'), null, { engineAlive: true });
  A.eq(v.kind, 'network', 'proven-alive engine is still the network kind (retryable, no door)');
  A.eq(v.engineAlive, true, 'measured alive verdict preserved');
  A.ok(!/Can't reach StarNet's local service/i.test(v.userMessage), 'engine proven UP must NOT claim it is unreachable');
  A.ok(/reply stream/i.test(v.userMessage), 'engine proven UP names the stream instead');

  v = F(new Error('terminated'));
  A.eq(v.engineAlive, null, 'no probe -> engineAlive null (unproven, never coerced to false)');
  A.ok(!/Can't reach StarNet's local service/i.test(v.userMessage), 'unprobed transport loss must not assert the service is unreachable');
  A.ok(/connection dropped/i.test(v.userMessage), 'unprobed transport loss states only what was witnessed');

  // 429 / rate / quota -> retryable rate_limit
  v = F(new Error('sidecar HTTP 429'));
  A.eq(v.kind, 'rate_limit', '429 -> rate_limit');
  A.eq(v.retryable, true, 'rate_limit retryable');
  A.ok(/too many requests|busy/i.test(v.userMessage), 'rate_limit friendly headline');
  A.eq(F(new Error('Rate limit exceeded')).kind, 'rate_limit', '"rate limit" message -> rate_limit');

  // 401 / 403 / auth -> NOT retryable, action = settings
  v = F(new Error('sidecar HTTP 401'));
  A.eq(v.kind, 'auth', '401 -> auth');
  A.eq(v.retryable, false, 'auth not retryable');
  A.eq(v.action, 'settings', 'auth points at Settings');
  A.ok(/ChatGPT/i.test(v.userMessage) && /key/i.test(v.userMessage), 'auth friendly headline offers a fix path (add a key or sign in with ChatGPT)');
  // EL-11 FIX 2: a "sidecar HTTP 403" is OUR OWN token gate (stale X-StarNet-Token after a crash+respawn), not
  // a provider key problem — it takes the reload door, never "🔑 Add a key". Provider 403s still read as auth.
  A.eq(F(new Error('sidecar HTTP 403')).kind, 'stale_session', 'sidecar 403 -> stale_session (the station restarted)');
  A.eq(F(new Error('sidecar HTTP 403')).action, 'reload', 'stale_session offers the reload door');
  A.eq(F(new Error('invalid api key')).kind, 'auth', '"invalid api key" -> auth');

  v = F(new Error('ChatGPT sign-in needed: Not signed in to ChatGPT'));
  A.eq(v.kind, 'oauth', 'ChatGPT sign-in error -> oauth');
  A.eq(v.retryable, false, 'oauth auth is not a blind retry');
  A.eq(v.action, 'settings', 'oauth points at Settings');
  A.ok(/ChatGPT sign-in/i.test(v.userMessage), 'oauth friendly headline names ChatGPT sign-in');

  // capability denied -> NOT retryable, action = refit (the TRUE unlock: place the gear; a station quest minted on
  // this denial completes by PLACEMENT, never a SKILLS toggle). Copy names the exact power + gear.
  v = F(new Error('no web — capability is off'));
  A.eq(v.kind, 'capdenied', 'capdenied forwarded string -> capdenied');
  A.eq(v.retryable, false, 'capdenied not retryable');
  A.eq(v.action, 'refit', 'capdenied points at REFIT (place the gear), not the SKILLS list');
  A.eq(v.cap, 'web', 'capdenied parses the missing capability off the raw message');
  A.ok(/WEB ACCESS/.test(v.userMessage) && /DISH/.test(v.userMessage) && /BUILD MODE/.test(v.userMessage), 'capdenied headline names the power (WEB ACCESS), the gear (DISH), and the door (BUILD MODE)');
  A.eq(F(new Error('capdenied: terminal')).kind, 'capdenied', 'literal capdenied token -> capdenied');

  // timeout vs user-abort: a user cancel is a quiet, non-retryable "Stopped."; a real timeout is retryable.
  v = F(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }));
  A.eq(v.kind, 'user_abort', 'AbortError -> user_abort');
  A.eq(v.retryable, false, 'user_abort offers no retry chip');
  A.eq(v.action, null, 'user_abort is not actionable');
  A.eq(v.userMessage, 'Stopped.', 'user_abort is a calm cancel, not a scary error');
  v = F(new Error('sidecar HTTP 504'));
  A.eq(v.kind, 'timeout', '504 -> timeout');
  A.eq(v.retryable, true, 'timeout retryable');
  A.ok(/timed out/i.test(v.userMessage), 'timeout friendly headline');
  A.eq(F(new Error('request timed out')).kind, 'timeout', '"timed out" message -> timeout');

  // 402 billing -> Settings; 404 model-not-found -> Settings
  A.eq(F(new Error('sidecar HTTP 402')).kind, 'billing', '402 -> billing');
  A.eq(F(new Error('sidecar HTTP 402')).action, 'settings', 'billing points at Settings');
  A.eq(F(new Error('sidecar HTTP 402')).retryable, false, 'billing not retryable');
  A.eq(F(new Error('sidecar HTTP 404')).kind, 'model_not_found', '404 -> model_not_found');
  A.eq(F(new Error('sidecar HTTP 404')).action, 'settings', 'model_not_found points at Settings');

  // mid-run token death (2026-07-22): the openai-compatible adapter labels HTTP failures with the provider
  // name for device-OAuth providers, so a 401 mid-stream lands on the ⏼ RECONNECT door, never "＋ Add a key"
  // (a key field is a dead end for a keyless subscription sign-in). grok+403 stays the xAI-key door: that's
  // the allowlist yank, where RECONNECT is doomed by design.
  v = F(new Error('Grok (xAI) http 401 - invalid access token'));
  A.eq(v.kind, 'oauth', 'labeled grok mid-run 401 -> oauth reconnect class');
  A.eq(v.provider, 'grok', 'labeled grok 401 resolves the grok provider (door reads RECONNECT GROK)');
  v = F(new Error('Kimi for Coding http 401 - token expired'));
  A.eq(v.kind, 'oauth', 'labeled kimi mid-run 401 -> oauth reconnect class');
  A.eq(v.provider, 'kimi', 'labeled kimi 401 resolves the kimi provider');
  A.eq(F(new Error('Grok (xAI) http 403 - oauth not enabled for this account')).kind, 'grok_oauth_unavailable',
    'grok 403 keeps routing to the xAI API-key door (allowlist yank — reconnect is doomed)');

  // unknown / default -> friendly generic + retryable, with the raw text kept for debugging
  v = F(new Error('something weird happened'));
  A.eq(v.kind, 'unknown', 'unrecognized -> unknown');
  A.eq(v.retryable, true, 'unknown is retryable');
  A.ok(/Something went wrong/i.test(v.userMessage), 'unknown has a friendly generic headline');
  A.ok(/something weird happened/.test(v.raw), 'unknown keeps the raw text');

  // agent_busy (2026-07-07 escape): the per-agent mutex message must NEVER flatten to "Something went wrong" —
  // retain the holder (age/source), while replacing a retired global-stop instruction from older servers.
  const busyRaw = 'That agent is already running a task — one run at a time per agent (they share a workspace). The run holding it started 12 min ago (source: cron). Wait for it to finish, check ROUTINES for a recurring job on this agent, or press E-STOP to stop everything.';
  v = F(new Error(busyRaw));
  A.eq(v.kind, 'agent_busy', 'the run-mutex message classifies as agent_busy, not unknown');
  A.ok(v.userMessage.includes('started 12 min ago (source: cron)'), 'the holder age and source survive');
  A.ok(!/E-STOP|Alt\+H/.test(v.userMessage) && /open its conversation and stop the active run/.test(v.userMessage), 'busy guidance uses the available per-conversation stop');
  A.eq(v.raw, busyRaw, 'diagnostics retain the unmodified server receipt');
  A.eq(v.retryable, true, 'agent_busy is retryable (the slot frees when the holder finishes)');
  A.ok(!/Something went wrong/.test(v.userMessage), 'the generic flattening is gone');

  // robustness: a bare string and a null both classify without throwing
  A.eq(F('sidecar HTTP 500').kind, 'server_error', 'a bare string error is accepted');
  A.notThrows(() => F(null), 'null error does not throw');

  // every KIND yields a complete, well-typed verdict
  for (const k of Object.keys(KINDS)) {
    const def = KINDS[k];
    A.ok(typeof def.retryable === 'boolean' && typeof def.msg === 'string' && def.msg.length > 0, 'kind "' + k + '" has a boolean retryable + a non-empty message');
    A.ok(def.action === null || def.action === 'settings' || def.action === 'skills' || def.action === 'store' || def.action === 'refit' || def.action === 'reload' || def.action === 'toolsets' || def.action === 'budget', 'kind "' + k + '" action is null|settings|skills|store|refit|reload|toolsets|budget');
    if (def.action !== null) A.ok(!!actionButton({ kind: k, action: def.action }), 'kind "' + k + '" action "' + def.action + '" has a door');
  }
}

// ---- J. browser fallback path: re-load friendlyerror.js with the sidecar classifier UNREACHABLE (as in the
//        shipped browser, where require() / the errorClass module don't exist), forcing classifyApiError=null so
//        EVERY verdict flows through kindFromRaw. Locks the untested browser path to the same truth as delegation —
//        a future kindFromRaw edit that diverges from the classifier now fails here instead of shipping silently. ----
{
  const Module = require('module');
  const path = require('path');
  const ecPath = require.resolve('../sidecar/providers/errorClass.js');
  const fePath = require.resolve('../frontend/app/friendlyerror.js');
  const origLoad = Module._load;
  // make the errorClass require inside friendlyerror.js throw → its try/catch leaves classifyApiError = null.
  Module._load = function (request, parent, isMain) {
    const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch (_) { return request; } })();
    if (resolved === ecPath || /errorClass\.js$/.test(String(request))) throw new Error('module unavailable (browser)');
    return origLoad.apply(this, arguments);
  };
  delete require.cache[fePath];
  let friendlyErrorBrowser;
  try { friendlyErrorBrowser = require('../frontend/app/friendlyerror.js').friendlyError; }
  finally { Module._load = origLoad; delete require.cache[fePath]; }
  // re-require the normal (delegating) build so any later require sees the real module again.
  require('../frontend/app/friendlyerror.js');

  const B = (err, status) => friendlyErrorBrowser(err, status);
  A.eq(B(new Error('sidecar HTTP 500')).kind, 'server_error', 'browser: 5xx -> server_error');
  A.eq(B(new Error('cannot reach the STARNET sidecar — start it')).kind, 'network', 'browser: unreachable -> network');
  A.eq(B(new Error('Failed to fetch')).kind, 'network', 'browser: Failed to fetch -> network');
  A.eq(B(new Error('sidecar HTTP 429')).kind, 'rate_limit', 'browser: 429 -> rate_limit');
  A.eq(B(new Error('sidecar HTTP 401')).kind, 'auth', 'browser: 401 -> auth');
  A.eq(B(new Error('sidecar HTTP 400 — missing key/model')).kind, 'auth', 'browser: /api/run missing credentials -> auth, not unknown retry');
  A.eq(B(new Error('sidecar HTTP 403')).kind, 'stale_session', 'browser: sidecar 403 -> stale_session (reload, not the key door)');
  A.eq(B(new Error('forbidden token'), 403).kind, 'stale_session', 'browser: 403 + "forbidden token" body -> stale_session');
  A.eq(B(new Error('invalid api key')).kind, 'auth', 'browser: invalid api key -> auth');
  A.eq(B(new Error('ChatGPT sign-in needed: codex_not_connected')).kind, 'oauth', 'browser: ChatGPT sign-in -> oauth');
  A.eq(B(new Error('sidecar HTTP 402')).kind, 'billing', 'browser: 402 -> billing');
  A.eq(B(new Error('sidecar HTTP 404')).kind, 'model_not_found', 'browser: 404 -> model_not_found');
  A.eq(B(new Error('sidecar HTTP 504')).kind, 'timeout', 'browser: 504 -> timeout');
  A.eq(B(new Error('no web — capability is off')).kind, 'capdenied', 'browser: capdenied string -> capdenied');
  A.eq(B(Object.assign(new Error('aborted'), { name: 'AbortError' })).kind, 'user_abort', 'browser: AbortError -> user_abort');
  A.eq(B(new Error('something weird happened')).kind, 'unknown', 'browser: unrecognized -> unknown');
  // the new pre-flight misconfig mapping must hold on the browser path too (points at Settings, not a retry).
  A.eq(B(new Error('no API key set')).kind, 'auth', 'browser: "no API key set" -> auth');
  A.eq(B(new Error('no API key set')).action, 'settings', 'browser: missing key points at Settings');
  // a connected provider with no MODEL picked is its own kind: the door is the model dock, not a key or sign-in
  A.eq(B(new Error('no model selected')).kind, 'no_model', 'browser: "no model selected" -> no_model');
  A.eq(B(new Error('no model selected')).action, 'settings', 'browser: no_model is a fix-it door, not a blind retry');
  A.eq(B(new Error('sidecar HTTP 400 — no model selected — pick a model for GROK OAUTH first')).kind, 'no_model',
    'browser: the /api/run no-model guard -> no_model');
  A.eq(B(new Error('sidecar HTTP 400 — missing key/model — sign in to GROK OAUTH first - a signed-in subscription + model are required')).kind, 'oauth',
    'browser: the /api/run guard for a signed-out GROK OAUTH -> the grok sign-in class, not the key/ChatGPT door');
  A.eq(B(new Error('sidecar HTTP 400 — missing key/model — connect a XAI API key')).kind, 'auth', 'browser: keyed guard stays auth');
  // xAI (live-probed 2026-09-27): a bad key is a 400, an unfunded team a 403 naming credits
  A.eq(B(new Error('openai-compatible http 400 - {"code":"invalid-argument","error":"Incorrect API key provided. You can obtain an API key from https://console.x.ai."}')).kind, 'auth',
    'browser: xAI bad-key 400 -> auth, not an unknown retry');
  A.eq(B(new Error('openai-compatible http 403 - {"code":"The caller does not have permission to execute the specified operation","error":"Your newly created team doesn\'t have any credits yet. You can purchase credits on https://console.x.ai/team/x."}')).kind, 'billing',
    'browser: xAI no-credits 403 -> billing, not "no model connected"');
}

/* ---- a TRANSPORT status beats a policy WORD in the message ----
   The content-policy regex ran against the whole message before the status was consulted, so any retryable
   failure whose text merely CONTAINED "moderation"/"safety"/"content_filter" was rewritten as a fatal policy
   block: no retry, no failover, and agent.run.error.transient reporting false. A real policy refusal never
   arrives as 429/5xx. */
{
  const t = R(httpErr(503, 'No instances available for openai/omni-moderation-latest'));
  A.eq(t.reason, 'overloaded', 'a 503 naming a moderation MODEL is still overloaded');
  A.eq(t.retryable, true, 'and stays retryable');
  A.eq(t.shouldFallback, true, 'and can still fail over');
  A.eq(R(httpErr(429, 'rate limit exceeded on the safety-tier endpoint')).reason, 'rate_limit', 'a 429 mentioning "safety" is still a rate limit');
  A.eq(R(httpErr(500, 'content_filter pipeline crashed')).reason, 'server_error', 'a 500 naming a content_filter component is still a server error');
  A.eq(R(httpErr(408, 'safety check timed out')).reason, 'timeout', 'a 408 mentioning safety is still a timeout');
  // ...and a genuine refusal is unchanged
  A.eq(R(httpErr(400, 'your request was blocked by our content policy')).reason, 'content_policy_blocked', 'a 400 policy refusal still classifies as policy');
  A.eq(R(httpErr(403, 'flagged by moderation')).reason, 'content_policy_blocked', 'so does a 403');
  A.eq(R(new Error('the model refused: content_filter triggered')).reason, 'content_policy_blocked', 'and so does a status-less refusal');
}

/* ---- QUOTA EXHAUSTION is not a rate limit -------------------------------------------------------
   A 429 fires in step 2 (HTTP status), strictly before the step-4 message patterns, so a body saying
   "you've hit your usage limit, resets in 3 days" could never reach a terminal class: it came back
   rate_limit (retryable, shouldRotateCredential) and codex.js burned RETRY_DELAYS while loop.js burned
   MAX_STREAM_RETRIES against an allowance that resets in DAYS. Status-before-message precedence is
   deliberate, so the fix is a distinct class WITHIN the 429. */
{
  const quota = R(httpErr(429, "codex http 429 — You've hit your usage limit. Resets in 3 days"));
  A.eq(quota.reason, 'quota_exhausted', 'a spent weekly allowance is quota_exhausted, not rate_limit');
  A.eq(quota.retryable, false, 'and it is NOT retryable — every retry inside the window is doomed');
  A.eq(quota.shouldRotateCredential, true, 'another credential may have its own allowance');
  A.eq(quota.shouldFallback, true, 'and another provider can pick the work up now');
  const exactReport = R(httpErr(429, 'codex http 429 — The usage limit has been reached'));
  A.eq(exactReport.reason, 'quota_exhausted', 'Codex live wording "usage limit has been reached" is a spent allowance');
  A.eq(exactReport.retryable, false, 'Codex live exhausted wording never burns a doomed retry');
  A.eq(R(httpErr(429, 'usage_limit_reached')).reason, 'quota_exhausted', 'the structured type is recognized too');
  A.eq(R(httpErr(429, 'weekly quota exceeded for this plan')).reason, 'quota_exhausted', 'so is a weekly quota');
  A.eq(R({ status: 429, code: 'plan_limit', message: 'nope' }).reason, 'quota_exhausted', 'and an error CODE saying plan_limit');

  // ...but a SHORT-window limit stays exactly what it was. Gemini answers a per-minute limit with
  // "Quota exceeded for quota metric", which a bare /quota/ test would have swallowed.
  A.eq(R(httpErr(429, 'Quota exceeded for quota metric: generate_requests per minute')).reason, 'rate_limit',
    'a PER-MINUTE quota is still a plain rate limit');
  A.eq(R(httpErr(429, 'slow down')).reason, 'rate_limit', 'a bare 429 is unchanged');
  A.eq(R(httpErr(429, 'Rate limit exceeded, retry in 1.5s')).reason, 'rate_limit', 'so is a seconds-scale one');

  // an out-of-money account also arrives as 429 from OpenAI (insufficient_quota), and no wait fixes that
  const spent = R(httpErr(429, 'openai http 429 — insufficient_quota: You exceeded your current quota'));
  A.eq(spent.reason, 'billing', 'a 429 carrying insufficient_quota is BILLING, not a busy provider');
  A.eq(spent.retryable, false, 'and it is not retryable either');
  A.eq(R({ status: 429, code: 'insufficient_quota', message: 'x' }).reason, 'billing', 'the code form too');
}

A.report('errorclass.test');
