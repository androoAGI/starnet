/* node test/provider.oauth-device.test.js — the generic RFC 8628 device-code wire (oauth-device.js), fed
   canned HTTP responses through an injected recording fetch, parameterized over BOTH provider configs:
     · Grok  — form-encoded, referrer + scope on the device leg, 403-is-allowlist (never relogin).
     · Kimi  — JSON-encoded, X-Msh-* headers on every leg, half-life refresh, 403-is-relogin.
   Asserts exact endpoints, encodings, client_ids, grant_type strings, the pending/slow_down/denied/expired
   classification, refresh rotation + relogin classification, the freshness check, and that NO token material
   ever appears in an error message. Zero network. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { makeDeviceOAuth } = require('../sidecar/providers/oauth-device.js');

const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
function recordingFetch(handler) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init: init || {} }); return handler(url, init || {}, calls.length - 1); };
  f.calls = calls;
  return f;
}
function formObj(init) { const o = {}; for (const [k, v] of new URLSearchParams(init.body)) o[k] = v; return o; }
function jsonBody(init) { try { return JSON.parse(init.body); } catch (e) { return {}; } }
function jwt(claims) {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b64({ alg: 'none' }) + '.' + b64(claims) + '.' + 'sig';
}

const GROK = {
  providerId: 'grok',
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  deviceUrl: 'https://auth.x.ai/oauth2/device/code',
  tokenUrl: 'https://auth.x.ai/oauth2/token',
  scope: 'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write',
  deviceExtraBody: { referrer: 'starnet' },
  encoding: 'form',
  refreshSkewSeconds: 120,
  forbiddenIsAllowlist: true
};
const KIMI = {
  providerId: 'kimi',
  clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
  deviceUrl: 'https://auth.kimi.com/api/oauth/device_authorization',
  tokenUrl: 'https://auth.kimi.com/api/oauth/token',
  encoding: 'form',   // live-proven 2026-07-17: auth.kimi.com 400s JSON; kimi-cli requests(data=) is form-encoded
  refreshSkewSeconds: 300,
  halfLifeRefresh: true,
  headers: { 'X-Msh-Platform': 'kimi_cli', 'X-Msh-Version': '1.0.0', 'X-Msh-Device-Id': 'dev-uuid-123' }
};

(async () => {
  // ============================ GROK (form-encoded) ============================
  {
    const grok = makeDeviceOAuth(GROK);

    // A. startDeviceLogin: form-encoded POST to the device endpoint with client_id + scope + referrer
    {
      // LIVE-CAPTURED shape (2026-07-28). The invented `accounts.x.ai/device` this fixture used to carry was
      // the WRONG PATH — the real one is /oauth2/device. A fixture that invents the destination proves the
      // request wire and NOTHING about where we send the user; that is exactly how the kimi code-less-page
      // bug survived a green gate. Keep these values pinned to what the issuer actually returns.
      const f = recordingFetch(() => json({ device_code: 'dc_grok', user_code: 'ABCD-1234', verification_uri: 'https://accounts.x.ai/oauth2/device', verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-1234', interval: 5, expires_in: 1800 }));
      const r = await grok.startDeviceLogin({ fetch: f });
      A.eq(f.calls[0].url, 'https://auth.x.ai/oauth2/device/code', 'grok device endpoint');
      A.eq(f.calls[0].init.method, 'POST', 'grok device is POST');
      A.eq(f.calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded', 'grok device leg is form-encoded');
      const body = formObj(f.calls[0].init);
      A.eq(body.client_id, 'b1a00492-073a-47ea-816f-4c329264a828', 'grok sends its public client_id');
      A.eq(body.referrer, 'starnet', 'grok sends referrer=starnet on the device leg');
      A.ok(body.scope && body.scope.indexOf('offline_access') >= 0, 'grok sends the offline_access scope');
      A.eq(r.device_code, 'dc_grok', 'returns the opaque device_code (kept server-side by the host)');
      A.eq(r.user_code, 'ABCD-1234', 'returns user_code');
      A.eq(r.verification_uri, 'https://accounts.x.ai/oauth2/device', 'returns verification_uri');
      A.eq(r.verification_uri_complete, 'https://accounts.x.ai/oauth2/device?user_code=ABCD-1234', 'returns verification_uri_complete — the URL the browser must OPEN');
    }

    // B. poll classification: authorization_pending / slow_down / access_denied / expired_token / success
    {
      const pend = recordingFetch(() => json({ error: 'authorization_pending' }, 400));
      A.eq((await grok.pollDeviceLogin({ fetch: pend, device_code: 'dc_grok' })).pending, true, 'authorization_pending => pending');

      const slow = recordingFetch(() => json({ error: 'slow_down' }, 400));
      const sr = await grok.pollDeviceLogin({ fetch: slow, device_code: 'dc_grok', interval: 5 });
      A.eq(sr.pending, true, 'slow_down => pending');
      A.eq(sr.interval, 10, 'slow_down bumps the interval by 5s');

      const denied = recordingFetch(() => json({ error: 'access_denied' }, 400));
      let code = '';
      try { await grok.pollDeviceLogin({ fetch: denied, device_code: 'dc_grok' }); } catch (e) { code = e.code; }
      A.eq(code, 'access_denied', 'access_denied is terminal');

      const expired = recordingFetch(() => json({ error: 'expired_token' }, 400));
      code = '';
      try { await grok.pollDeviceLogin({ fetch: expired, device_code: 'dc_grok' }); } catch (e) { code = e.code; }
      A.eq(code, 'expired_token', 'expired_token is terminal');

      const s500 = recordingFetch(() => json({}, 503));
      A.eq((await grok.pollDeviceLogin({ fetch: s500, device_code: 'dc_grok' })).pending, true, 'a 5xx during poll keeps polling');

      const done = recordingFetch(() => json({ access_token: 'at_grok', refresh_token: 'rt_grok', expires_in: 3600, token_type: 'Bearer' }));
      const dr = await grok.pollDeviceLogin({ fetch: done, device_code: 'dc_grok', now: 1_000_000 });
      A.eq(done.calls[0].url, 'https://auth.x.ai/oauth2/token', 'grok poll hits the token endpoint');
      const pf = formObj(done.calls[0].init);
      A.eq(pf.grant_type, 'urn:ietf:params:oauth:grant-type:device_code', 'grok poll grant_type is the device-code grant');
      A.eq(pf.device_code, 'dc_grok', 'grok poll sends the device_code');
      A.eq(pf.client_id, 'b1a00492-073a-47ea-816f-4c329264a828', 'grok poll sends client_id');
      A.eq(dr.access_token, 'at_grok', 'success returns access_token');
      A.eq(dr.refresh_token, 'rt_grok', 'success returns refresh_token');
      A.eq(dr.expires_at, 1_000_000 + 3600 * 1000, 'success computes expires_at from expires_in');
    }

    // C. refresh: rotation + keep-old, grant_type; classification (invalid_grant/401 relogin, 429 rate-limit)
    {
      const keep = recordingFetch(() => json({ access_token: 'at2' }));   // no new refresh
      const r1 = await grok.refreshTokens({ fetch: keep, refresh_token: 'rt_old', now: 0 });
      const rf = formObj(keep.calls[0].init);
      A.eq(rf.grant_type, 'refresh_token', 'grant_type=refresh_token');
      A.eq(rf.refresh_token, 'rt_old', 'sends the refresh_token');
      A.eq(r1.access_token, 'at2', 'new access_token applied');
      A.eq(r1.refresh_token, 'rt_old', 'old refresh_token retained when none returned');

      const rot = recordingFetch(() => json({ access_token: 'at3', refresh_token: 'rt_new' }));
      A.eq((await grok.refreshTokens({ fetch: rot, refresh_token: 'rt_old', now: 0 })).refresh_token, 'rt_new', 'rotated refresh_token applied when returned');

      const bad = recordingFetch(() => json({ error: 'invalid_grant', error_description: 'expired' }, 400));
      let relogin = null, code = '';
      try { await grok.refreshTokens({ fetch: bad, refresh_token: 'rt' }); } catch (e) { relogin = e.reloginRequired; code = e.code; }
      A.eq(code, 'invalid_grant', 'surfaces the OAuth error code');
      A.eq(relogin, true, 'invalid_grant forces relogin');

      const un = recordingFetch(() => json({ error: 'nope' }, 401));
      relogin = null;
      try { await grok.refreshTokens({ fetch: un, refresh_token: 'rt' }); } catch (e) { relogin = e.reloginRequired; }
      A.eq(relogin, true, '401 always forces relogin');

      // RFC 6749 §5.2: invalid_request is a malformed-REQUEST verdict (a provider tightened a field, or our
      // encoder dropped one), never a credential verdict — marking the sign-in dead put the user in an
      // unbreakable reconnect loop (new token, same malformed request, dead again).
      const malformed = recordingFetch(() => json({ error: 'invalid_request', error_description: 'missing parameter' }, 400));
      relogin = null; code = '';
      try { await grok.refreshTokens({ fetch: malformed, refresh_token: 'rt' }); } catch (e) { relogin = e.reloginRequired; code = e.code; }
      A.eq(code, 'invalid_request', 'surfaces invalid_request as its own code');
      A.eq(relogin, false, 'invalid_request never kills the sign-in (the credential was not judged)');

      const rl = recordingFetch(() => json({ error: 'rate' }, 429));
      relogin = null; code = '';
      try { await grok.refreshTokens({ fetch: rl, refresh_token: 'rt' }); } catch (e) { relogin = e.reloginRequired; code = e.code; }
      A.eq(code, 'oauth_rate_limited', '429 => rate limited');
      A.eq(relogin, false, '429 does NOT force relogin');
    }

    // C2. GROK-SPECIFIC: a 403 on the token endpoint is an ACCOUNT ALLOWLIST rejection, NOT a dead token.
    {
      const forbid = recordingFetch(() => json({ error: 'forbidden' }, 403));
      let relogin = null, code = '', message = '';
      try { await grok.refreshTokens({ fetch: forbid, refresh_token: 'rt' }); } catch (e) { relogin = e.reloginRequired; code = e.code; message = e.message; }
      A.eq(code, 'xai_oauth_forbidden', 'grok 403 is the allowlist code');
      A.eq(relogin, false, 'grok 403 does NOT mark the token dead (re-sign-in would not help)');
      A.ok(/api key/i.test(message), 'grok 403 steers the user to the API-key provider');
    }

    // D. freshness (skew-based): grok refreshes within 120s of expires_at
    {
      const now = 1_000_000;
      A.eq(grok.accessTokenIsExpiring({ access_token: 'x', expires_at: now + 600_000 }, now), false, 'grok token 10min out is fresh');
      A.eq(grok.accessTokenIsExpiring({ access_token: 'x', expires_at: now + 60_000 }, now), true, 'grok token 60s out is expiring (inside 120s skew)');
      // JWT exp fallback when there is no expires_at
      A.eq(grok.accessTokenIsExpiring({ access_token: jwt({ exp: (now / 1000) + 600 }) }, now), false, 'grok falls back to JWT exp (fresh)');
      A.eq(grok.accessTokenIsExpiring({ access_token: jwt({ exp: (now / 1000) + 30 }) }, now), true, 'grok falls back to JWT exp (stale)');
    }

    // E. no token material in error messages
    {
      const SECRET = 'rt-super-secret-refresh-abcdefghijklmnopqrstuvwxyz';
      const f = recordingFetch(() => json({ error: 'invalid_grant' }, 400));
      let message = '';
      try { await grok.refreshTokens({ fetch: f, refresh_token: SECRET }); } catch (e) { message = e.message || ''; }
      A.ok(message.indexOf(SECRET) === -1, 'the refresh_token never appears in a refresh error message');
      let missMsg = '';
      try { await grok.refreshTokens({ fetch: async () => json({}), refresh_token: '' }); } catch (e) { missMsg = e.message; }
      A.ok(missMsg.indexOf(SECRET) === -1 && /sign in/i.test(missMsg), 'missing-refresh error is clean + relogin-worded');
    }
  }

  // ============================ KIMI (form-encoded + X-Msh headers) ============================
  {
    const kimi = makeDeviceOAuth(KIMI);

    // A. startDeviceLogin: form POST with client_id, X-Msh-* headers present, NO scope/referrer
    {
      // LIVE-CAPTURED shape (2026-07-28). This fixture used to invent `auth.kimi.com/device` — wrong HOST and
      // wrong path — and omit verification_uri_complete entirely, which is why a fully green gate never noticed
      // that the app was opening a code-less page. The real bare URL is a code CONSUMER: it renders
      // "Missing user_code parameter" without ?user_code=, so only the _complete form can finish a sign-in.
      const f = recordingFetch(() => json({ device_code: 'dc_kimi', user_code: 'WXYZ-9', verification_uri: 'https://www.kimi.com/code/authorize_device', verification_uri_complete: 'https://www.kimi.com/code/authorize_device?user_code=WXYZ-9', interval: 5, expires_in: 1800 }));
      const r = await kimi.startDeviceLogin({ fetch: f });
      A.eq(f.calls[0].url, 'https://auth.kimi.com/api/oauth/device_authorization', 'kimi device endpoint');
      A.eq(f.calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded', 'kimi device leg is form-encoded (live-proven; JSON gets a 400)');
      A.eq(f.calls[0].init.headers['X-Msh-Platform'], 'kimi_cli', 'kimi sends X-Msh-Platform on the device leg');
      A.eq(f.calls[0].init.headers['X-Msh-Device-Id'], 'dev-uuid-123', 'kimi sends the stable X-Msh-Device-Id');
      const body = formObj(f.calls[0].init);
      A.eq(body.client_id, '17e5f671-d194-4dfb-9706-5516cb48c098', 'kimi sends its public client_id');
      A.eq(body.scope, undefined, 'kimi sends no scope');
      A.eq(body.referrer, undefined, 'kimi sends no referrer');
      A.eq(r.device_code, 'dc_kimi', 'returns device_code');
      A.eq(r.user_code, 'WXYZ-9', 'returns user_code');
      A.eq(r.verification_uri, 'https://www.kimi.com/code/authorize_device', 'returns the bare verification_uri (DISPLAY only — it cannot accept a typed code)');
      A.eq(r.verification_uri_complete, 'https://www.kimi.com/code/authorize_device?user_code=WXYZ-9', 'RETURNS verification_uri_complete — dropping it is what broke kimi sign-in');
    }

    // B. poll: form grant body carries the device-code grant + client_id + X-Msh headers
    {
      const done = recordingFetch(() => json({ access_token: 'at_kimi', refresh_token: 'rt_kimi', expires_in: 900 }));
      const dr = await kimi.pollDeviceLogin({ fetch: done, device_code: 'dc_kimi', now: 2_000_000 });
      A.eq(done.calls[0].url, 'https://auth.kimi.com/api/oauth/token', 'kimi poll hits the token endpoint');
      A.eq(done.calls[0].init.headers['X-Msh-Platform'], 'kimi_cli', 'kimi poll carries X-Msh headers');
      const pb = formObj(done.calls[0].init);
      A.eq(pb.grant_type, 'urn:ietf:params:oauth:grant-type:device_code', 'kimi poll grant_type is the device-code grant');
      A.eq(pb.device_code, 'dc_kimi', 'kimi poll sends the device_code');
      A.eq(pb.client_id, '17e5f671-d194-4dfb-9706-5516cb48c098', 'kimi poll sends client_id');
      A.eq(dr.access_token, 'at_kimi', 'kimi success returns access_token');
      A.eq(dr.expires_at, 2_000_000 + 900 * 1000, 'kimi computes expires_at from expires_in');
    }

    // C. KIMI-SPECIFIC: a 403 on the token endpoint IS relogin (no allowlist exception for kimi)
    {
      const forbid = recordingFetch(() => json({ error: 'forbidden' }, 403));
      let relogin = null;
      try { await kimi.refreshTokens({ fetch: forbid, refresh_token: 'rt' }); } catch (e) { relogin = e.reloginRequired; }
      A.eq(relogin, true, 'kimi 403 forces relogin (dead refresh token)');
    }

    // D. freshness (half-life): kimi refreshes once past 50% of the token lifetime
    {
      const issuedMs = 1_000_000;                      // last_refresh
      const lifetimeMs = 900 * 1000;                   // 15 min
      const expAt = issuedMs + lifetimeMs;
      const env = { access_token: 'x', expires_at: expAt, last_refresh: new Date(issuedMs).toISOString() };
      A.eq(kimi.accessTokenIsExpiring(env, issuedMs + 200_000), false, 'kimi at ~22% of life is still fresh');
      A.eq(kimi.accessTokenIsExpiring(env, issuedMs + 500_000), true, 'kimi past 50% of life refreshes');
    }

    // E. opaque token with no expiry hint => refresh before every run (fail safe)
    {
      A.eq(kimi.accessTokenIsExpiring({ access_token: 'opaque-no-exp' }, 5_000_000), true, 'kimi opaque token with no expiry hint fails safe (refresh)');
      A.eq(kimi.accessTokenIsExpiring({ access_token: 'x' }, 'not-a-number'), true, 'absent now => fail safe (refresh)');
    }
  }

  // Logout is credential deletion, not a best-effort cache clear. Both resilient copies must be sanitized
  // before live state is dropped or the route reports success; otherwise a failed unlink returns 200 and the
  // refresh token comes back from tokens.json (or its .bak) on the next sidecar boot.
  {
    const indexSource = readSidecarSource();
    const removalBody = A.fnBody(indexSource, 'function saveCredentialRemovalVerified(file, value, proof, tag)');
    const clearBody = A.fnBody(indexSource, 'function clearOAuthTokens(id)');
    const logoutBody = A.fnBody(indexSource, 'function handleOAuthLogout(req, res, id)');
    const mainWrite = removalBody.indexOf("writeFileDurable({ fs: fs, path: path }, file, data)");
    const backupWrite = removalBody.indexOf("writeFileDurable({ fs: fs, path: path }, file + '.bak', data)");
    A.ok(mainWrite >= 0 && backupWrite >= 0 && mainWrite < backupWrite,
      'credential removal commits the authoritative main copy before its recovery copy, so a crash cannot resurrect the secret');
    A.ok(/saveCredentialRemovalVerified\([\s\S]*entry\.file[\s\S]*null/.test(clearBody),
      'oauth logout sanitizes both resilient token copies with verified credential removal');
    A.ok(clearBody.indexOf('saveCredentialRemovalVerified') < clearBody.indexOf('unlinkSync'),
      'oauth logout sanitizes credential-bearing copies before any best-effort file removal');
    A.ok(/if\s*\(!clearOAuthTokens\(id\)\)[\s\S]*json\(500/.test(logoutBody),
      'oauth logout reports a durable removal failure instead of false success');
    A.ok(logoutBody.indexOf('clearOAuthTokens(id)') < logoutBody.indexOf('entry.tokens = null'),
      'oauth logout keeps the live credential until durable removal succeeds');
  }

  A.report('provider.oauth-device.test');
})().catch(e => { console.error('provider.oauth-device.test FAILED:', e); process.exit(1); });
