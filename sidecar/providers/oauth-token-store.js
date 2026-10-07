/* sidecar/providers/oauth-token-store.js — generic verified persistence for the RFC 8628 device-OAuth
   providers (Grok / Kimi). The parameterized sibling of codex-token-store.js: pure path/load/save
   orchestration, ambient fs injected by index.js. These providers are BRAND NEW, so — unlike codex — there
   is NO legacy-workspace migration scan to do; a fresh install simply has no tokens yet.

   Envelope shape: { access_token, refresh_token, expires_at?, last_refresh?, device_id?, token_type?, authDead? }
     · expires_at  — ms epoch, computed from expires_in at persist time; drives the freshness check across a restart.
     · device_id   — Kimi's stable per-install X-Msh-Device-Id, minted once and kept WITH the tokens.
     · region      — Kimi only: 'global' (kimi.ai) or 'cn' (kimi.com) — the deployment the sign-in was minted in.
                     Absent on pre-#70 envelopes, which read as 'cn' (providers/kimi-region.js).
     · authDead    — the honest dead-token marker (see oauth-auth-state via the reused codex-auth-state module). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.oauthTokenStore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function validTokens(raw) {
    return !!(raw && typeof raw === 'object'
      && typeof raw.access_token === 'string'
      && raw.access_token.trim());
  }

  // Load the tokens for one provider. opts.file is the resolved tokens.json path; opts.load is index.js's
  // resilient reader (falls back to the .bak last-known-good). Returns the envelope or null.
  function loadTokens(opts) {
    opts = opts || {};
    const load = opts.load;
    if (typeof load !== 'function') throw new Error('loadTokens requires opts.load');
    let raw; try { raw = load(opts.file, opts.tag || 'oauth'); } catch (_) { raw = null; }
    return validTokens(raw) ? raw : (raw && typeof raw === 'object' ? raw : null);
  }

  // Persist device-OAuth tokens with READ-BACK PROOF, then RETRY ONCE — identical durability posture to
  // persistCodexTokensVerified. A silently-failed write of a ROTATED refresh_token means a restart reloads the
  // old (now-dead) token and forces a re-sign-in, so a swallowed write error is a real credential-durability
  // hazard. Writes, reads the file BACK, confirms the intended access_token AND (when present) refresh_token are
  // on disk; on mismatch/throw it retries once; still-unproven => { ok:false } so the caller can surface an
  // HONEST persist-failure signal while keeping the rotated tokens live in memory (truth-telemetry law).
  //
  //   opts.save(obj)  -> void (may throw)   persist the token object
  //   opts.load()     -> obj|undefined      read the token object back from disk (resilient reader)
  //   opts.tokens                            the token object being persisted
  // Returns { ok, attempts, verified, error }.
  function persistTokensVerified(opts) {
    opts = opts || {};
    const tokens = opts.tokens || {};
    const save = opts.save, load = opts.load;
    if (typeof save !== 'function' || typeof load !== 'function') {
      return { ok: false, attempts: 0, verified: false, error: 'persistTokensVerified requires save+load' };
    }
    const wantRefresh = String(tokens.refresh_token || '');
    const wantAccess = String(tokens.access_token || '');
    function onDisk() {
      let raw; try { raw = load(); } catch (_) { return false; }
      if (!raw || typeof raw !== 'object') return false;
      if (wantAccess && String(raw.access_token || '') !== wantAccess) return false;
      if (wantRefresh && String(raw.refresh_token || '') !== wantRefresh) return false;
      return true;
    }
    let lastErr = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { save(tokens); } catch (e) { lastErr = (e && e.message) || String(e); }
      if (onDisk()) return { ok: true, attempts: attempt, verified: true, error: '' };
      if (!lastErr) lastErr = 'read-back did not find the intended tokens on disk';
    }
    return { ok: false, attempts: 2, verified: false, error: lastErr };
  }

  return { validTokens, loadTokens, persistTokensVerified };
});
