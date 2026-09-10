/* sidecar/mcp/oauth.js — a GENERIC OAuth 2.1 client for remote MCP connectors (the MCP Authorization spec:
   RFC 9728 protected-resource metadata + RFC 8414 AS metadata + RFC 7591 dynamic client registration + PKCE
   authorization-code, RFC 8707 resource indicator). Verified against the real Notion / Linear / Sentry MCP
   servers, which all implement it identically: an unauthenticated request 401s with
   `WWW-Authenticate: Bearer ... resource_metadata="<url>"`, the PRM lists an `authorization_servers[0]`, and
   its AS metadata exposes authorization/token/registration endpoints with S256 PKCE. ONE flow drives them all —
   no preconfigured per-provider client credentials: the AS dynamically registers either a public PKCE client or,
   where its metadata requires one, a per-install confidential client whose issued secret stays in protected state.

   PURE + injected: every network call takes an injected `fetchImpl`; the current time is an injected `now`; the
   random PKCE bytes are injected by the composition root (sidecar/index.js owns crypto.randomBytes). node:crypto
   is used only for the deterministic SHA-256 of the PKCE challenge, never for randomness here — so this module is
   reproducible and passes lint-determinism, exactly like spotify/pkce.js.

   The flow, end to end (the routes layer in index.js orchestrates it):
     1. discover(serverUrl[, wwwAuthenticate]) -> { authorizationServer, authorizationEndpoint, tokenEndpoint,
        registrationEndpoint, codeChallengeMethods, resource }
     2. registerClient(registrationEndpoint, redirectUri) -> { clientId, clientSecret, tokenEndpointAuthMethod }
     3. makeVerifier(randomBytes) + challengeOf(verifier); buildAuthorizeUrl(...) -> open in the browser
     4. exchangeCode(tokenEndpoint, code, redirectUri, client credentials, verifier, resource, now) -> tokens
     5. refreshTokens(tokenEndpoint, refreshToken, client credentials, now) -> tokens   (when needsRefresh) */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('node:crypto'));
  else { root.SK = root.SK || {}; (root.SK.mcp = root.SK.mcp || {}).oauth = factory(null); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nodeCrypto) {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 15000;
  const MAX_TIMEOUT_MS = 60000;

  /* One deadline primitive for EVERY OAuth network leg. `deadlineAt` is the whole-flow ceiling; `timeoutMs`
     is the per-leg ceiling. An external AbortSignal (user CANCEL / connector removal / request disconnect)
     is composed without AbortSignal.any so the shipped Node floor and injected tests behave identically. */
  async function withDeadline(opts, fn, label) {
    opts = opts || {};
    const external = opts.signal;
    // Whole-flow callers inject a clock alongside deadlineAt. A leg-only timeout needs no wall clock.
    const now = typeof opts.now === 'function' ? opts.now : () => 0;
    const setTimer = opts.setTimeoutImpl || setTimeout;
    const clearTimer = opts.clearTimeoutImpl || clearTimeout;
    let ms = Number(opts.timeoutMs);
    if (!isFinite(ms) || ms <= 0) ms = DEFAULT_TIMEOUT_MS;
    ms = Math.min(ms, MAX_TIMEOUT_MS);
    if (Number(opts.deadlineAt) > 0) ms = Math.min(ms, Math.max(0, Number(opts.deadlineAt) - now()));
    if (ms <= 0) throw new Error((label || 'oauth request') + ' timed out');
    const ctrl = new AbortController();
    let timedOut = false;
    const cancel = () => ctrl.abort();
    if (external && external.aborted) throw new Error((label || 'oauth request') + ' cancelled');
    if (external && typeof external.addEventListener === 'function') external.addEventListener('abort', cancel, { once: true });
    const timer = setTimer(() => { timedOut = true; ctrl.abort(); }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    try { return await fn(ctrl.signal); }
    catch (e) {
      if (timedOut) throw new Error((label || 'oauth request') + ' timed out after ' + ms + 'ms');
      if ((external && external.aborted) || ctrl.signal.aborted) throw new Error((label || 'oauth request') + ' cancelled');
      throw e;
    } finally {
      clearTimer(timer);
      if (external && typeof external.removeEventListener === 'function') external.removeEventListener('abort', cancel);
    }
  }

  function base64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // PKCE verifier := base64url(random bytes) (43–128 chars). Bytes are INJECTED (ambient randomness stays in index.js).
  function makeVerifier(randomBytes) {
    if (!randomBytes || !randomBytes.length) throw new Error('makeVerifier needs random bytes');
    const v = base64url(randomBytes);
    if (v.length < 43) throw new Error('verifier too short — supply >= 32 random bytes');
    return v.slice(0, 128);
  }
  // challenge := base64url(SHA256(verifier)) (the S256 method every probed server supports).
  function challengeOf(verifier) {
    if (!nodeCrypto) throw new Error('challengeOf requires node:crypto');
    return base64url(nodeCrypto.createHash('sha256').update(String(verifier)).digest());
  }

  // Parse an RFC 9728 pointer out of a `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="…"` header.
  function parseWwwAuthenticate(header) {
    const h = String(header || '');
    const out = {};
    const rm = h.match(/resource_metadata\s*=\s*"([^"]+)"/i); if (rm) out.resourceMetadata = rm[1];
    const rl = h.match(/realm\s*=\s*"([^"]+)"/i); if (rl) out.realm = rl[1];
    const er = h.match(/error\s*=\s*"([^"]+)"/i); if (er) out.error = er[1];
    return out;
  }

  // SSRF hardening: the discovery/registration/token URLs come partly from a server-supplied WWW-Authenticate
  // pointer + PRM body, so require https and refuse any endpoint on an internal host (loopback / link-local /
  // private / cloud-metadata) by its literal hostname. redirect:'manual' turns any 3xx into a non-2xx the callers
  // already reject, so a metadata URL can't 302-bounce the fetch to an internal target. (Literal-host guard; if OAuth
  // is ever opened to user-provided — non-catalog — server URLs, add DNS-resolution guarding like tools/web.js.)
  /* Four gaps, all reachable because these URLs come partly from a SERVER-supplied WWW-Authenticate pointer
     and PRM body, and the token endpoint is where the authorization code is redeemed:
       · a trailing-dot FQDN (`localhost.`) missed every NAME rule — WHATWG only strips the root label for IP
         literals, so the name kept it;
       · the IPv4-mapped IPv6 form ([::ffff:127.0.0.1], which Node renders as ::ffff:7f00:1) matched nothing;
       · `.local` / `.internal` / the cloud-metadata names were absent, though 169.254.169.254 was covered;
       · CGNAT 100.64.0.0/10 was absent.
     The v4 patterns were also unanchored, so `10.example.com` classified as internal — harmless (fail-closed)
     but wrong. An IPv4 literal is now matched whole-string and its octets compared numerically. */
  function assertSafeUrl(raw, label) {
    let u; try { u = new URL(raw); } catch (e) { throw new Error((label || 'oauth') + ': invalid url ' + raw); }
    if (u.protocol !== 'https:') throw new Error((label || 'oauth') + ': url must be https (' + raw + ')');
    let h = u.hostname.toLowerCase();
    if (h.charAt(0) === '[') h = h.slice(1, -1); else h = h.replace(/\.+$/, '');
    const v4 = h.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    let privateV4 = false;
    if (v4) {
      const a = Number(v4[1]), b = Number(v4[2]);
      privateV4 = a === 0 || a === 127 || a === 10 || (a === 192 && b === 168) || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || a > 255 || b > 255;
    }
    const internalName = h === 'localhost' || h === '0.0.0.0' || h.endsWith('.localhost') || h.endsWith('.local')
      || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.intranet') || h.endsWith('.home')
      || h.endsWith('.corp') || h === 'metadata.goog' || h.endsWith('.metadata.goog') || h.indexOf('.') < 0;
    const internalV6 = h === '::1' || h === '::' || /^::ffff:/i.test(h) || /^fe[89ab][0-9a-f]:/i.test(h) || /^f[cd][0-9a-f]{2}:/i.test(h);
    if (privateV4 || internalName || internalV6) throw new Error((label || 'oauth') + ': refusing an endpoint on an internal host (' + h + ')');
    return u;
  }

  async function getJson(fetchImpl, url, label, net) {
    assertSafeUrl(url, label);
    try { return await withDeadline(net, async signal => {
      const res = await fetchImpl(url, { headers: { 'Accept': 'application/json', 'MCP-Protocol-Version': '2025-06-18' }, redirect: 'manual', signal });
      if (!res || res.status < 200 || res.status >= 300) throw new Error((label || 'fetch') + ' HTTP ' + (res && res.status));
      try { return await res.json(); } catch (e) { throw new Error((label || 'fetch') + ' returned non-JSON'); }
    }, label); }
    catch (e) { throw new Error((label || 'fetch') + ' failed: ' + ((e && e.message) || e)); }
  }

  // The default RFC 9728 metadata URL when the server didn't hand one over: origin + /.well-known/oauth-protected-
  // resource + the resource path (path-suffixed, matching what Notion/Linear/Sentry actually serve).
  function defaultResourceMetadataUrl(serverUrl) {
    const u = new URL(serverUrl);
    const path = u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : '';
    return u.origin + '/.well-known/oauth-protected-resource' + path;
  }
  function asMetadataUrls(authServer) {
    const u = new URL(String(authServer));
    const path = u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : '';
    const base = u.origin + path;
    // RFC 8414 inserts the well-known segment between the authority and an issuer path. This matters for
    // providers such as monday.com, whose protected-resource metadata advertises
    // `https://auth.monday.com/mcp`: its metadata lives at
    // `https://auth.monday.com/.well-known/oauth-authorization-server/mcp`, not below `/mcp/.well-known/`.
    // OIDC discovery keeps its established issuer-relative form as the compatibility fallback.
    return [u.origin + '/.well-known/oauth-authorization-server' + path, base + '/.well-known/openid-configuration'];
  }

  function chooseTokenEndpointAuthMethod(methods) {
    const supported = Array.isArray(methods) ? methods.map(String) : [];
    // Prefer a public PKCE client. A few hosted MCP providers require a dynamically-issued confidential client.
    if (!supported.length || supported.indexOf('none') >= 0) return 'none';
    if (supported.indexOf('client_secret_post') >= 0) return 'client_secret_post';
    if (supported.indexOf('client_secret_basic') >= 0) return 'client_secret_basic';
    throw new Error('authorization server requires an unsupported token endpoint authentication method');
  }

  // DISCOVERY: server URL (+ optional WWW-Authenticate header) -> the AS endpoints the flow needs.
  async function discover(opts) {
    opts = opts || {};
    const fetchImpl = opts.fetchImpl; if (typeof fetchImpl !== 'function') throw new Error('discover: fetchImpl required');
    const serverUrl = String(opts.serverUrl || ''); if (!serverUrl) throw new Error('discover: serverUrl required');
    const parsed = parseWwwAuthenticate(opts.wwwAuthenticate);
    const prmUrl = parsed.resourceMetadata || defaultResourceMetadataUrl(serverUrl);
    const prm = await getJson(fetchImpl, prmUrl, 'protected-resource metadata', opts);
    const servers = prm.authorization_servers || (prm.authorization_server ? [prm.authorization_server] : []);
    if (!servers.length) throw new Error('no authorization_servers in resource metadata');
    const authServer = String(servers[0]);
    let asMeta = null, lastErr = null;
    for (const asUrl of asMetadataUrls(authServer)) {
      try { asMeta = await getJson(fetchImpl, asUrl, 'authorization-server metadata', opts); break; } catch (e) { lastErr = e; }
    }
    if (!asMeta) throw lastErr || new Error('no authorization-server metadata');
    if (!asMeta.authorization_endpoint || !asMeta.token_endpoint) throw new Error('authorization-server metadata missing endpoints');
    return {
      authorizationServer: authServer,
      authorizationEndpoint: String(asMeta.authorization_endpoint),
      tokenEndpoint: String(asMeta.token_endpoint),
      registrationEndpoint: asMeta.registration_endpoint ? String(asMeta.registration_endpoint) : '',
      codeChallengeMethods: Array.isArray(asMeta.code_challenge_methods_supported) ? asMeta.code_challenge_methods_supported : ['S256'],
      tokenEndpointAuthMethods: Array.isArray(asMeta.token_endpoint_auth_methods_supported) ? asMeta.token_endpoint_auth_methods_supported : [],
      scopesSupported: Array.isArray(asMeta.scopes_supported) ? asMeta.scopes_supported : null,
      // The protected resource, not the authorization server, is authoritative for the scopes this MCP server
      // needs. Base44 advertises `app:mcp offline` here; omitting them produces a valid-looking consent URL whose
      // token is unusable for the MCP resource.
      resourceScopes: Array.isArray(prm.scopes_supported) ? prm.scopes_supported.map(String) : null,
      resource: serverUrl,                 // RFC 8707 resource indicator = the canonical MCP server URL
      resourceMetadataUrl: prmUrl
    };
  }

  // RFC 7591 DYNAMIC CLIENT REGISTRATION: mint a PKCE client bound to our loopback redirect. Prefer public
  // clients, but retain a provider-issued secret when AS metadata requires confidential token authentication.
  async function registerClient(opts) {
    opts = opts || {};
    const fetchImpl = opts.fetchImpl; if (typeof fetchImpl !== 'function') throw new Error('registerClient: fetchImpl required');
    if (!opts.registrationEndpoint) throw new Error('registerClient: registrationEndpoint required (server has no dynamic registration)');
    if (!opts.redirectUri) throw new Error('registerClient: redirectUri required');
    const requestedAuthMethod = ['none', 'client_secret_post', 'client_secret_basic'].indexOf(String(opts.tokenEndpointAuthMethod || '')) >= 0
      ? String(opts.tokenEndpointAuthMethod) : 'none';
    const body = {
      client_name: opts.clientName || 'StarNet',
      redirect_uris: [opts.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: requestedAuthMethod,
      application_type: 'native'
    };
    assertSafeUrl(opts.registrationEndpoint, 'client registration');
    try { return await withDeadline(opts, async signal => {
      const res = await fetchImpl(opts.registrationEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body), redirect: 'manual', signal });
      if (!res || res.status < 200 || res.status >= 300) {
        let d = '';
        try {
          const j = JSON.parse(await res.text());
          if (j && typeof j.error === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(j.error)) d = j.error;
        } catch (_) {}
        throw new Error('client registration HTTP ' + (res && res.status) + (d ? ' — ' + d : ''));
      }
      let j; try { j = await res.json(); } catch (e) { throw new Error('client registration returned non-JSON'); }
      if (!j.client_id) throw new Error('client registration response had no client_id');
      const responseMethod = ['none', 'client_secret_post', 'client_secret_basic'].indexOf(String(j.token_endpoint_auth_method || '')) >= 0
        ? String(j.token_endpoint_auth_method) : requestedAuthMethod;
      const clientSecret = responseMethod === 'none' ? '' : (j.client_secret ? String(j.client_secret) : '');
      if (responseMethod !== 'none' && !clientSecret) throw new Error('client registration response had no client_secret for ' + responseMethod);
      return { clientId: String(j.client_id), clientSecret, tokenEndpointAuthMethod: responseMethod, raw: j };
    }, 'client registration'); }
    catch (e) { throw new Error('client registration failed: ' + ((e && e.message) || e)); }
  }

  function buildAuthorizeUrl(o) {
    o = o || {};
    if (!o.authorizationEndpoint) throw new Error('buildAuthorizeUrl needs authorizationEndpoint');
    if (!o.clientId) throw new Error('buildAuthorizeUrl needs clientId');
    if (!o.redirectUri) throw new Error('buildAuthorizeUrl needs redirectUri');
    if (!o.challenge) throw new Error('buildAuthorizeUrl needs a PKCE challenge');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: o.clientId,
      redirect_uri: o.redirectUri,
      code_challenge: o.challenge,
      code_challenge_method: 'S256',
      state: o.state || ''
    });
    if (o.resource) q.set('resource', o.resource);               // RFC 8707 — bind the token to this MCP server
    const scope = Array.isArray(o.scope) ? o.scope.join(' ') : (o.scope || '');
    if (scope) q.set('scope', scope);
    // provider-specific authorize params from catalog staticOauth (e.g. Google's access_type=offline +
    // prompt=consent, without which no refresh token is ever issued). Reserved params can't be overridden.
    if (o.extraParams && typeof o.extraParams === 'object') {
      for (const k of Object.keys(o.extraParams)) {
        if (!q.has(k)) q.set(k, String(o.extraParams[k]));
      }
    }
    const sep = o.authorizationEndpoint.indexOf('?') >= 0 ? '&' : '?';
    return o.authorizationEndpoint + sep + q.toString();
  }

  function tokensFromResponse(resp, fetchedAtMs, priorRefresh) {
    resp = resp || {};
    const expiresInMs = (Number(resp.expires_in) || 3600) * 1000;
    return {
      accessToken: resp.access_token || '',
      refreshToken: resp.refresh_token || priorRefresh || '',
      expiresAt: fetchedAtMs + expiresInMs,
      scope: resp.scope || '',
      tokenType: resp.token_type || 'Bearer'
    };
  }
  // refresh a bit early (skew) so a token never expires mid-request. `now` injected.
  function needsRefresh(expiresAt, now, skewMs) {
    if (!expiresAt) return true;
    return now >= (expiresAt - (skewMs == null ? 60000 : skewMs));
  }

  function formEncode(value) {
    return new URLSearchParams({ v: String(value == null ? '' : value) }).toString().slice(2);
  }

  function authenticateTokenRequest(params, opts) {
    const method = String((opts && opts.tokenEndpointAuthMethod) || 'none');
    const secret = String((opts && opts.clientSecret) || '');
    const headers = {};
    if (['none', 'client_secret_post', 'client_secret_basic'].indexOf(method) < 0) {
      throw new Error('unsupported token endpoint authentication method');
    }
    if (method === 'client_secret_post') {
      if (!secret) throw new Error('token request needs a client secret');
      params.client_secret = secret;
    } else if (method === 'client_secret_basic') {
      if (!secret) throw new Error('token request needs a client secret');
      headers.Authorization = 'Basic ' + Buffer.from(formEncode(params.client_id) + ':' + formEncode(secret)).toString('base64');
      delete params.client_id;
    }
    return headers;
  }

  async function postForm(fetchImpl, tokenEndpoint, params, label, net) {
    assertSafeUrl(tokenEndpoint, label);
    const authHeaders = authenticateTokenRequest(params, net);
    try { return await withDeadline(net, async signal => {
      const res = await fetchImpl(tokenEndpoint, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, authHeaders), body: new URLSearchParams(params).toString(), redirect: 'manual', signal });
      if (!res || res.status < 200 || res.status >= 300) {
        // Token endpoints may echo submitted fields in a free-form error body. Keep a bounded OAuth error code
        // only; descriptions and raw bodies never enter logs, connector status, or model-visible tool results.
        let d = '';
        try {
          const j = JSON.parse(await res.text());
          if (j && typeof j.error === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(j.error)) d = j.error;
        } catch (_) {}
        throw new Error((label || 'token request') + ' HTTP ' + (res && res.status) + (d ? ' — ' + d : ''));
      }
      try { return await res.json(); } catch (e) { throw new Error((label || 'token request') + ' returned non-JSON'); }
    }, label); }
    catch (e) { throw new Error((label || 'token request') + ' failed: ' + ((e && e.message) || e)); }
  }

  async function exchangeCode(o) {
    o = o || {};
    if (!o.fetchImpl) throw new Error('exchangeCode: fetchImpl required');
    const params = {
      grant_type: 'authorization_code',
      code: o.code || '',
      redirect_uri: o.redirectUri || '',
      client_id: o.clientId || '',
      code_verifier: o.verifier || ''
    };
    if (o.resource) params.resource = o.resource;
    const json = await postForm(o.fetchImpl, o.tokenEndpoint, params, 'code exchange', o);
    return tokensFromResponse(json, o.now || 0, '');
  }

  async function refreshTokens(o) {
    o = o || {};
    if (!o.fetchImpl) throw new Error('refreshTokens: fetchImpl required');
    const params = { grant_type: 'refresh_token', refresh_token: o.refreshToken || '', client_id: o.clientId || '' };
    if (o.resource) params.resource = o.resource;
    const json = await postForm(o.fetchImpl, o.tokenEndpoint, params, 'token refresh', o);
    if (json.error || !json.access_token) throw new Error('token refresh failed: ' +
      (/^[a-z0-9_.-]{1,64}$/i.test(json.error || '') ? json.error : 'missing access_token'));
    return tokensFromResponse(json, o.now || 0, o.refreshToken || '');   // keep the old refresh_token if the AS omits a new one
  }

  return {
    base64url, makeVerifier, challengeOf, parseWwwAuthenticate,
    defaultResourceMetadataUrl, discover, registerClient, buildAuthorizeUrl,
    exchangeCode, refreshTokens, tokensFromResponse, needsRefresh, withDeadline, chooseTokenEndpointAuthMethod,
    DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS,
    _internals: { asMetadataUrls, getJson, postForm, authenticateTokenRequest }
  };
});
