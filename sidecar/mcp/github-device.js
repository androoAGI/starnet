'use strict';
// Public application identifier, registered by androoAGI. Device flow never ships a client secret.
const CLIENT_ID = 'Ov23livVcHfqh3CtI3wo';
const TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const oauth = require('./oauth.js');

function createDeviceFlow({ fetchImpl, complete, snapshot, now = Date.now, clientId = CLIENT_ID }) {
  const attempts = new Map();
  function cancel(attemptId, id) {
    let cancelled = false;
    for (const [key, a] of attempts) {
      if ((attemptId ? key === attemptId : a.id === id) && (!id || a.id === id)) {
        a.controller.abort(); attempts.delete(key); cancelled = true;
      }
    }
    return cancelled;
  }
  function prune() {
    for (const [key, a] of attempts) if (now() >= a.expiresAt) cancel(key);
  }
  async function request(url, params, a) {
    return oauth.withDeadline({ signal: a.controller.signal, timeoutMs: 15000, deadlineAt: a.expiresAt, now }, async signal => {
      const res = await fetchImpl(url, { method: 'POST', redirect: 'error', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString() });
      if (!res.ok) throw new Error('GitHub sign-in request failed (HTTP ' + res.status + '). Try again.');
      return res.json();
    }, 'GitHub sign-in');
  }
  async function start(attemptId, id, signal) {
    prune();
    if (attempts.has(attemptId)) throw new Error('This sign-in attempt is already running.');
    cancel('', id);
    if (attempts.size >= 8) throw new Error('Too many sign-in attempts. Try again later.');
    const a = { id, controller: new AbortController(), original: snapshot(id), expiresAt: now() + 60000 };
    const abort = () => cancel(attemptId, id);
    attempts.set(attemptId, a);
    if (signal) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }
    try {
      const j = await request('https://github.com/login/device/code', { client_id: clientId, scope: 'repo read:org' }, a);
      if (!j.device_code || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(j.user_code || '') || j.verification_uri !== 'https://github.com/login/device' || !(j.expires_in > 0)) {
        throw new Error('GitHub could not start device sign-in. Try again.');
      }
      if (attempts.get(attemptId) !== a) throw new Error('Sign-in cancelled.');
      a.deviceCode = j.device_code;
      a.expiresAt = now() + Math.min(Number(j.expires_in), 900) * 1000;
      a.interval = Math.max(Number(j.interval) || 5, 5) * 1000;
      a.nextPoll = now() + a.interval;
      return { url: j.verification_uri, userCode: j.user_code, expiresIn: Math.floor((a.expiresAt - now()) / 1000), attemptId, deviceFlow: true };
    } catch (e) { cancel(attemptId, id); throw e; }
    finally { if (signal) signal.removeEventListener('abort', abort); }
  }
  async function poll(attemptId) {
    prune();
    const a = attempts.get(attemptId);
    if (!a) return { state: 'error', error: 'Sign-in expired or was cancelled. Sign in again.' };
    if (a.result) return a.result;
    if (a.flight) return a.flight;
    if (now() < a.nextPoll) return { state: 'pending' };
    const active = () => attempts.get(attemptId) === a && !a.controller.signal.aborted && now() < a.expiresAt && snapshot(a.id) === a.original;
    a.flight = (async () => {
      try {
        if (!active()) throw new Error('This connection changed while sign-in was open. Your current settings were kept.');
        a.nextPoll = now() + a.interval;
        const j = await request(TOKEN_ENDPOINT, { client_id: clientId, device_code: a.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, a);
        if (j.error === 'authorization_pending') return { state: 'pending' };
        if (j.error === 'slow_down') { a.interval += 5000; a.nextPoll = now() + a.interval; return { state: 'pending' }; }
        if (j.error || !j.access_token) throw new Error(j.error === 'access_denied' ? 'GitHub sign-in was declined.' : 'GitHub sign-in expired or failed. Sign in again.');
        const scopes = String(j.scope || '').split(/[ ,]+/);
        if (!scopes.includes('repo') || !scopes.includes('read:org')) throw new Error('GitHub did not grant the requested repository and organization access. Sign in again.');
        const account = await oauth.withDeadline({ signal: a.controller.signal, timeoutMs: 15000, deadlineAt: a.expiresAt, now }, async signal => {
          const res = await fetchImpl('https://api.github.com/user', { redirect: 'error', signal,
            headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + j.access_token } });
          if (!res.ok) throw new Error('Could not verify the signed-in GitHub account. Try again.');
          const u = await res.json();
          if (!Number.isSafeInteger(u.id) || !/^[a-zA-Z0-9-]{1,39}$/.test(u.login || '')) throw new Error('GitHub returned an invalid account.');
          return { issuer: 'https://github.com', subject: String(u.id), login: u.login, verifiedAt: now() };
        }, 'GitHub account check');
        if (!active()) throw new Error('This connection changed while sign-in was open. Your current settings were kept.');
        const tokens = oauth.tokensFromResponse(j, now(), '');
        // GitHub may issue non-expiring tokens; they require no refresh until a real 401.
        if (!j.expires_in) tokens.expiresAt = Number.MAX_SAFE_INTEGER;
        const grant = Object.assign(tokens, { clientId, clientSecret: '', tokenEndpointAuthMethod: 'none',
          tokenEndpoint: TOKEN_ENDPOINT, authorizationServer: 'https://github.com', resource: '', account, at: now() });
        a.result = await complete(a.id, grant, active);
        a.deviceCode = '';
        return a.result;
      } catch (e) {
        // No provider bodies or tokens are surfaced to the browser.
        a.result = { state: 'error', error: a.controller.signal.aborted ? 'Sign-in cancelled.' :
          (/^(GitHub|Could not verify|This connection)/.test(e.message || '') ? e.message : 'GitHub sign-in failed. Please try again.') };
        a.deviceCode = '';
        return a.result;
      } finally { a.flight = null; }
    })();
    return a.flight;
  }
  return { start, poll, cancel };
}
module.exports = { createDeviceFlow, CLIENT_ID, TOKEN_ENDPOINT };
