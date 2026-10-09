/* sidecar/providers/codex-auth.js — the ONLY module that knows the OpenAI Codex OAuth wire.

   Replicates the device-code login OpenAI's own Codex CLI uses (faithful port of the reference
   CLI's auth flow `_codex_device_code_login` / `refresh_codex_oauth_pure`), so a STARNET user can
   run agents off a personal ChatGPT subscription instead of paying per-token API. No client secret —
   the Codex CLI's PUBLIC client_id + a PKCE code_verifier minted server-side by the device-auth flow.

   The flow has three legs, kept as separate primitives so the browser can drive it without holding a
   long HTTP connection open (start → show code → poll on an interval → exchange + persist):
     1. startDeviceLogin()  POST /api/accounts/deviceauth/usercode  -> { user_code, device_auth_id }
        user opens auth.openai.com/codex/device and enters user_code
     2. pollDeviceLogin()   POST /api/accounts/deviceauth/token     -> { authorization_code, code_verifier } | { pending }
     3. exchangeCode()      POST /oauth/token (authorization_code)  -> { access_token, refresh_token }
   Later, refreshTokens() trades a refresh_token for a fresh access_token before each run when the JWT
   `exp` is within the skew window. `fetch` is INJECTED so the same module is testable headlessly.

   Caveat: leans on OpenAI's consumer Codex backend + the Codex CLI's client_id — subject to OpenAI's
   terms; the endpoints can change. Everything provider-specific is contained behind this boundary. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.codexAuth = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- literal constants (must match OpenAI's Codex CLI exactly; see the reference CLI's auth flow) ----
  const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';     // Codex CLI's public client
  const CODEX_ISSUER = 'https://auth.openai.com';
  const CODEX_OAUTH_TOKEN_URL = CODEX_ISSUER + '/oauth/token';
  const CODEX_DEVICE_VERIFY_URL = CODEX_ISSUER + '/codex/device';   // the URL the user opens
  const CODEX_REDIRECT_URI = CODEX_ISSUER + '/deviceauth/callback';
  const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';   // inference endpoint
  const REFRESH_SKEW_SECONDS = 120;                                 // refresh when exp is within 2min
  const POLL_MIN_INTERVAL_S = 3;                                    // floor on the device poll cadence
  const DEVICE_LOGIN_TIMEOUT_S = 15 * 60;                           // give up after 15 minutes

  function pickFetch(opts) {
    const f = (opts && opts.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('codex-auth requires fetch (Node 18+) or opts.fetch');
    return f;
  }

  // Every OAuth leg is a short JSON POST — none should hang the sidecar. Cap each fetch with a connect timeout
  // (env SKYNET_PROVIDER_CONNECT_MS, default 30s). Returns undefined on old platforms (no AbortSignal.timeout),
  // which leaves the fetch un-timed rather than erroring — the same graceful degrade the stream adapters use.
  function authTimeoutSignal() {
    try {
      const v = (typeof process !== 'undefined' && process.env && process.env.SKYNET_PROVIDER_CONNECT_MS);
      const n = v != null && String(v).trim() !== '' ? parseInt(v, 10) : NaN;
      const ms = (isFinite(n) && n > 0) ? n : 30000;
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
    } catch (_) {}
    return undefined;
  }

  // A failure the caller can branch on: `relogin` => the stored refresh token is dead, ask the user to
  // sign in again; otherwise it's transient (quota/network) and the existing credentials still stand.
  function authError(message, code, relogin) {
    const e = new Error(message);
    e.provider = 'openai-codex';
    e.code = code || 'codex_auth_error';
    e.reloginRequired = !!relogin;
    return e;
  }

  // ---- JWT helpers: the access_token is a JWT; its `exp` claim drives the refresh decision ----
  function decodeJwtClaims(token) {
    if (typeof token !== 'string' || (token.match(/\./g) || []).length !== 2) return {};
    let payload = token.split('.')[1] || '';
    payload += '='.repeat((4 - (payload.length % 4)) % 4);          // restore base64url padding
    try {
      const json = Buffer.from(payload, 'base64').toString('utf8');
      const claims = JSON.parse(json);
      return (claims && typeof claims === 'object') ? claims : {};
    } catch (e) { return {}; }
  }
  // True when the token is missing/opaque-without-exp is treated as NOT expiring (return false), matching
  // the reference harness: only a present, numeric exp within the skew window forces a refresh. `nowMs` is INJECTED by the
  // caller (the composition root) — when it's absent we fail SAFE (return true => refresh) rather than read
  // an ambient clock here, keeping this backend module deterministic (see test/lint-determinism.js).
  function accessTokenIsExpiring(token, skewSeconds, nowMs) {
    if (typeof nowMs !== 'number') return true;
    const claims = decodeJwtClaims(token);
    const exp = claims.exp;
    if (typeof exp !== 'number') return false;
    return exp <= (nowMs / 1000) + Math.max(0, skewSeconds == null ? REFRESH_SKEW_SECONDS : skewSeconds);
  }

  // ---- leg 1: request a device/user code ----
  async function startDeviceLogin(opts) {
    const doFetch = pickFetch(opts);
    let resp;
    try {
      resp = await doFetch(CODEX_ISSUER + '/api/accounts/deviceauth/usercode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
        signal: authTimeoutSignal()
      });
    } catch (e) {
      throw authError('Failed to request device code: ' + ((e && e.message) || e), 'device_code_request_failed');
    }
    if (resp.status !== 200) throw authError('Device code request returned status ' + resp.status + '.', 'device_code_request_error');
    let data; try { data = await resp.json(); } catch (e) { data = {}; }
    const user_code = data.user_code || '';
    const device_auth_id = data.device_auth_id || '';
    const interval = Math.max(POLL_MIN_INTERVAL_S, parseInt(data.interval, 10) || 5);
    if (!user_code || !device_auth_id) throw authError('Device code response missing required fields.', 'device_code_incomplete');
    return { user_code, device_auth_id, interval, verification_uri: CODEX_DEVICE_VERIFY_URL, expires_in: DEVICE_LOGIN_TIMEOUT_S };
  }

  // ---- leg 2: poll ONCE for the authorization code. 403/404 => the user hasn't finished yet (pending). ----
  async function pollDeviceLogin(opts) {
    const doFetch = pickFetch(opts);
    const device_auth_id = opts.device_auth_id, user_code = opts.user_code;
    let resp;
    try {
      resp = await doFetch(CODEX_ISSUER + '/api/accounts/deviceauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id, user_code }),
        signal: authTimeoutSignal()
      });
    } catch (e) {
      throw authError('Device auth polling failed: ' + ((e && e.message) || e), 'device_code_poll_failed');
    }
    if (resp.status === 200) {
      let body; try { body = await resp.json(); } catch (e) { body = {}; }
      const authorization_code = body.authorization_code || '';
      const code_verifier = body.code_verifier || '';
      if (!authorization_code || !code_verifier) throw authError('Device auth response missing authorization_code or code_verifier.', 'device_code_incomplete_exchange');
      return { pending: false, authorization_code, code_verifier };
    }
    if (resp.status === 403 || resp.status === 404) return { pending: true };
    throw authError('Device auth polling returned status ' + resp.status + '.', 'device_code_poll_error');
  }

  // ---- leg 3: exchange the authorization code (+ server-minted code_verifier) for tokens ----
  async function exchangeCode(opts) {
    const doFetch = pickFetch(opts);
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: opts.authorization_code,
      redirect_uri: CODEX_REDIRECT_URI,
      client_id: CODEX_OAUTH_CLIENT_ID,
      code_verifier: opts.code_verifier
    });
    let resp;
    try {
      resp = await doFetch(CODEX_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: authTimeoutSignal()
      });
    } catch (e) {
      throw authError('Token exchange failed: ' + ((e && e.message) || e), 'token_exchange_failed');
    }
    if (resp.status !== 200) throw authError('Token exchange returned status ' + resp.status + '.', 'token_exchange_error');
    let tokens; try { tokens = await resp.json(); } catch (e) { tokens = {}; }
    const access_token = tokens.access_token || '';
    const refresh_token = tokens.refresh_token || '';
    if (!access_token) throw authError('Token exchange did not return an access_token.', 'token_exchange_no_access_token');
    return {
      access_token, refresh_token,
      base_url: DEFAULT_CODEX_BASE_URL,
      last_refresh: isoNow(opts.now),
      auth_mode: 'chatgpt',
      source: 'device-code'
    };
  }

  // ---- token refresh: trade the refresh_token for a fresh access_token (mirrors refresh_codex_oauth_pure) ----
  async function refreshTokens(opts) {
    const doFetch = pickFetch(opts);
    const refresh_token = opts.refresh_token;
    if (typeof refresh_token !== 'string' || !refresh_token.trim()) {
      throw authError('Codex auth is missing refresh_token. Sign in with ChatGPT again.', 'codex_auth_missing_refresh_token', true);
    }
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh_token, client_id: CODEX_OAUTH_CLIENT_ID });
    let resp;
    try {
      resp = await doFetch(CODEX_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: form.toString(),
        signal: authTimeoutSignal()
      });
    } catch (e) {
      throw authError('Codex token refresh failed: ' + ((e && e.message) || e), 'codex_refresh_failed', false);
    }

    if (resp.status === 429) {
      // Quota exhausted on the token endpoint — the refresh token is still valid, so re-auth would not help.
      // Classify distinctly so the UI says "retry later" instead of a misleading "sign in again".
      throw authError('Codex provider quota exhausted (429). Credentials are still valid; retry after the limit resets.', 'codex_rate_limited', false);
    }
    if (resp.status !== 200) {
      let code = 'codex_refresh_failed', message = 'Codex token refresh failed with status ' + resp.status + '.', relogin = false;
      try {
        const err = await resp.json();
        const errObj = err && err.error;
        if (errObj && typeof errObj === 'object') {                       // OpenAI shape: { error: { code/type, message } }
          const nested = errObj.code || errObj.type;
          if (typeof nested === 'string' && nested.trim()) code = nested.trim();
          if (typeof errObj.message === 'string' && errObj.message.trim()) message = 'Codex token refresh failed: ' + errObj.message.trim();
        } else if (typeof errObj === 'string' && errObj.trim()) {         // OAuth spec shape: { error, error_description }
          code = errObj.trim();
          const desc = err.error_description || err.message;
          if (typeof desc === 'string' && desc.trim()) message = 'Codex token refresh failed: ' + desc.trim();
        }
      } catch (e) { /* keep the status-based default */ }
      if (code === 'invalid_grant' || code === 'invalid_token' || code === 'invalid_request') relogin = true;
      if (code === 'refresh_token_reused') {
        // #92: no Codex CLI needed — StarNet's own device-code sign-in mints fresh tokens. A copied station
        // folder carries the single-use refresh token too, so name that cause alongside the CLI/editor.
        message = 'Codex refresh token was already consumed by another client (the Codex CLI, the VS Code extension, '
          + 'or a copy of this station on another computer). Sign in with ChatGPT again: ⏼ RECONNECT on the ChatGPT card '
          + 'in SETTINGS › AI & MODELS.';
        relogin = true;
      }
      if ((resp.status === 401 || resp.status === 403) && !relogin) relogin = true;   // a 401/403 always means dead refresh token
      throw authError(message, code, relogin);
    }

    let payload; try { payload = await resp.json(); } catch (e) {
      throw authError('Codex token refresh returned invalid JSON.', 'codex_refresh_invalid_json', true);
    }
    const refreshed = payload.access_token;
    if (typeof refreshed !== 'string' || !refreshed.trim()) {
      throw authError('Codex token refresh response was missing access_token.', 'codex_refresh_missing_access_token', true);
    }
    const next = payload.refresh_token;
    return {
      access_token: refreshed.trim(),
      refresh_token: (typeof next === 'string' && next.trim()) ? next.trim() : refresh_token.trim(),
      last_refresh: isoNow(opts.now)
    };
  }

  // `nowMs` is INJECTED by the caller; absent => last_refresh is left blank (unknown) rather than reading
  // an ambient clock in this deterministic backend module. The composition root always passes a real time.
  function isoNow(nowMs) {
    if (typeof nowMs !== 'number') return '';
    return new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');   // …:56Z (drop millis), matching the reference harness' format
  }

  return {
    startDeviceLogin, pollDeviceLogin, exchangeCode, refreshTokens,
    decodeJwtClaims, accessTokenIsExpiring,
    CODEX_OAUTH_CLIENT_ID, CODEX_ISSUER, CODEX_OAUTH_TOKEN_URL, CODEX_DEVICE_VERIFY_URL,
    CODEX_REDIRECT_URI, DEFAULT_CODEX_BASE_URL, REFRESH_SKEW_SECONDS
  };
});
