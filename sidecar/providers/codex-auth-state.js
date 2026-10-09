/* sidecar/providers/codex-auth-state.js — the HONEST dead-token state for the ChatGPT (Codex) OAuth
   connection. Pure functions only (index.js composes them with its ambient token store), so the
   escape-class transition — "refresh token consumed by another client, yet Settings still says
   SIGNED IN" — is unit-testable without a network.

   The contract:
     • A refresh failure whose error carries `reloginRequired` (invalid_grant / refresh_token_reused /
       401/403 — codex-auth.js already classifies these) marks the sign-in DEAD. Transient failures
       (quota, network) never do — the stored credentials still stand.
     • The marker is embedded IN the tokens envelope (`authDead`) so the SAME durable file that makes
       "signed in" survive a restart also makes "sign-in expired" survive one. Restart stays honest.
     • statusPayload() is the single truth shape for GET /api/auth/codex/status:
       `connected` is true ONLY when tokens are present AND not known-dead. Booleans/strings only —
       never token material (the reason string comes from codex-auth's static messages).
     • Any successful refresh or completed device sign-in clears the marker (withoutDeadMarker /
       a fresh envelope). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.codexAuthState = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_REASON_CHARS = 400;   // status payloads stay small + human; a reason is a sentence, not a dump

  // Never let anything token-shaped ride the reason string (defense in depth — codex-auth messages are
  // static text, but the status endpoint's law is "booleans/strings only, NEVER token material").
  function scrubReason(s) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    // JWTs (eyJ… base64url triplets) and long opaque secrets get elided wholesale.
    s = s.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]');
    s = s.replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/g, '[token]');
    s = s.replace(/[A-Za-z0-9_-]{40,}/g, '[secret]');
    return s.slice(0, MAX_REASON_CHARS);
  }

  // err -> {reason, code, at} when the failure means the stored refresh token is DEAD (re-sign-in is the
  // only cure); null for transient failures (quota / network / 5xx) where the credentials still stand.
  function deadMarkerFromError(err, atIso) {
    if (!err || !err.reloginRequired) return null;
    return {
      reason: scrubReason((err && err.message) || 'ChatGPT sign-in expired — sign in again.'),
      code: String((err && err.code) || 'codex_relogin_required'),
      at: String(atIso || '')
    };
  }

  // read a persisted marker back off a loaded tokens envelope (restart honesty); shape-validated.
  function deadFromTokens(tokens) {
    const d = tokens && typeof tokens === 'object' ? tokens.authDead : null;
    if (!d || typeof d !== 'object') return null;
    if (typeof d.reason !== 'string' || !d.reason.trim()) return null;
    // #92: a marker saved by 0.13.1 and older told the user to run the Codex CLI — StarNet's own sign-in is the
    // cure, so a stored reason carrying that advice is read back with the current wording.
    const reason = /run `codex` in your terminal/i.test(d.reason)
      ? 'Codex refresh token was already consumed by another client (the Codex CLI, the VS Code extension, or a copy of '
        + 'this station on another computer). Sign in with ChatGPT again: ⏼ RECONNECT on the ChatGPT card in SETTINGS › AI & MODELS.'
      : d.reason;
    return { reason: scrubReason(reason), code: String(d.code || 'codex_relogin_required'), at: String(d.at || '') };
  }

  // envelope + marker -> a NEW envelope carrying the marker (tokens kept — the user may still want to
  // inspect/logout; the status payload is what stops claiming "connected").
  function withDeadMarker(tokens, marker) {
    const base = (tokens && typeof tokens === 'object') ? tokens : {};
    return Object.assign({}, base, { authDead: { reason: String(marker.reason || ''), code: String(marker.code || ''), at: String(marker.at || '') } });
  }

  // strip the marker (successful refresh / completed sign-in) -> a NEW envelope without authDead.
  function withoutDeadMarker(tokens) {
    if (!tokens || typeof tokens !== 'object') return tokens;
    if (!('authDead' in tokens)) return tokens;
    const out = Object.assign({}, tokens);
    delete out.authDead;
    return out;
  }

  // THE status truth shape. connected is true ONLY when tokens are present AND not known-dead —
  // never both connected:true and expired:true.
  function statusPayload(opts) {
    opts = opts || {};
    const tokens = opts.tokens;
    const dead = opts.dead || null;
    const hasTokens = !!(tokens && typeof tokens === 'object' && typeof tokens.access_token === 'string' && tokens.access_token.trim());
    return {
      connected: hasTokens && !dead,
      expired: !!dead,
      reason: dead ? scrubReason(dead.reason || '') : '',
      expiredAt: dead ? String(dead.at || '') : '',
      last_refresh: (tokens && tokens.last_refresh) || '',
      persistError: String(opts.persistError || '')
    };
  }

  return { deadMarkerFromError, deadFromTokens, withDeadMarker, withoutDeadMarker, statusPayload, scrubReason };
});
