/* sidecar/credits-link.js — device pairing client for StarNet Cloud + the durable link-config store.

   Slice 2 of the subscriptions plan: turn a static CREDITS_ACCOUNT env var into a real, user-driven LINK
   STATION flow. This module owns two things and NOTHING else (no billing, no admission — that stays in
   credits.js / billing.js):

     1. The cloud device-linking HTTP dance (mirrors the codex device-code shape):
          POST {cloud}/v1/link/start { deviceName } -> { code:"STAR-XXXX", verifyUrl, pollSecret, expiresAt }
          POST {cloud}/v1/link/poll  { code, pollSecret } ->
              { status:'pending' } | { status:'confirmed', deviceToken, accountId } | { status:'expired'|'consumed' }
        The `pollSecret` is a SECRET: it is held in memory keyed by code and NEVER returned to the frontend
        or persisted. Only the sidecar polls the cloud with it.

     2. Durable link config at WORKSPACES/.secrets/credits.json (same posture as spotify.json — atomic
        tmp+rename, 0600) so a linked station survives a sidecar restart. The record is
          { url, deviceToken?, accountId, linkedAt }
        and is read back at boot (loadSavedSync) to construct the live credits adapter. deviceToken is a
        re-issuable bearer credential (relinking mints a new one), so unlink deleting the file is safe
        under the secret-durability law.

        WHERE THE TOKEN ACTUALLY LIVES (desktop vs bare):
        The device token is a bearer credential that SPENDS MONEY, so on the desktop it belongs in the OS
        keychain, not in a file. The desktop adopts it: Rust reads credits.json, stores the token under
        keychain account "credits:device", strips `deviceToken` from the file, and injects it back at every
        sidecar spawn as STARNET_CREDITS_TOKEN. So `deviceToken` in the file is TRANSIENT on desktop —
        present between the link and the adoption moments later, absent afterwards.
        Precedence in loadSavedSync: file token (fresh link, pre-adoption) -> this process's freshly linked
        session token -> injected env token (adopted at launch). The session token MUST beat envToken after a
        relink: envToken is frozen at process launch and can still be the revoked account's old keychain token.
        A bare/dev sidecar has no keychain and no injector, so the file keeps the token exactly as before —
        this is additive and never breaks a non-desktop deploy.

   HONESTY LAW: when STARNET_CLOUD_URL is unset, configured() is false — start() refuses, the /api/credits/*
   link routes 404, and the STORE shows no LINK card. Pure/injected IO (fetch, fs, fsp, path, clock) so the
   whole flow is unit-testable offline (see test/credits-link.test.js). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).creditsLink = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function str(v) { return v == null ? '' : String(v); }
  function trimSlash(u) { return str(u).replace(/\/+$/, ''); }

  /* deps: {
       cloudUrl,                 // STARNET_CLOUD_URL (empty => inert, everything 404s)
       fetch, fsp, fs, pathMod,  // injected IO
       dir,                      // WORKSPACES/.secrets — where credits.json lives
       now,                      // () => ms wall clock
       envToken                  // STARNET_CREDITS_TOKEN — desktop-injected from the OS keychain (see header)
     } */
  function makeCreditsLink(deps) {
    deps = deps || {};
    const cloudUrl = trimSlash(deps.cloudUrl);
    const envToken = str(deps.envToken).trim();
    const doFetch = deps.fetch || (typeof fetch === 'function' ? fetch : null);
    const fsp = deps.fsp;
    const fs = deps.fs;
    const P = deps.pathMod;
    const DIR = deps.dir;
    const now = deps.now || (() => 0);   // host (index.js) injects the wall clock; default is inert (determinism law)
    const file = (P && DIR) ? P.join(DIR, 'credits.json') : '';
    const requestTimeoutMs = (typeof deps.requestTimeoutMs === 'number' && isFinite(deps.requestTimeoutMs) && deps.requestTimeoutMs > 0)
      ? Math.floor(deps.requestTimeoutMs) : 8000;

    // code -> { pollSecret, at }. The pollSecret is the secret half of the pairing; it never leaves the sidecar.
    const pending = new Map();

    function configured() { return !!cloudUrl; }

    async function postJson(pathName, payload) {
      if (!doFetch) throw new Error('no fetch');
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      let timer = null;
      if (ctl) timer = setTimeout(() => ctl.abort(), requestTimeoutMs);
      let r;
      try {
        r = await doFetch(cloudUrl + pathName, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
          signal: ctl ? ctl.signal : undefined
        });
        // Fetch resolves when headers arrive. Keep the same bound armed through body consumption or a
        // peer can send headers and strand link/start or link/poll forever on a stalled JSON body.
        const body = (r && typeof r.json === 'function') ? await r.json().catch(error => {
          if (error && error.name === 'AbortError') throw error;
          return {};
        }) : {};
        if (!r || !r.ok) { const e = new Error('link POST ' + pathName + ' failed'); e.status = r && r.status; e.body = body; throw e; }
        return body || {};
      } finally { if (timer) clearTimeout(timer); }
    }

    // Ask the cloud for a fresh pairing code. Stashes the pollSecret in memory; returns only the public bits.
    async function start(deviceName) {
      if (!configured()) return { ok: false, error: 'not_configured' };
      const j = await postJson('/v1/link/start', { deviceName: str(deviceName) || 'StarNet Station' });
      const code = str(j.code);
      if (!code) return { ok: false, error: 'no_code' };
      pending.set(code, { pollSecret: str(j.pollSecret), at: now() });
      for (const [k, v] of pending) { if (!v || (now() - v.at) > 15 * 60 * 1000) pending.delete(k); }   // prune stale
      return { ok: true, code, verifyUrl: str(j.verifyUrl), expiresAt: j.expiresAt || 0 };
    }

    // Poll the cloud ONCE for this code. On 'confirmed' persists the device token and returns the record so the
    // host can rebuild the live credits adapter. 'unknown' = we hold no pollSecret for this code (never started
    // here, or already resolved) — the frontend should restart the flow.
    async function poll(code) {
      if (!configured()) return { status: 'not_configured' };
      code = str(code);
      const p = pending.get(code);
      if (!p) return { status: 'unknown' };
      const j = await postJson('/v1/link/poll', { code, pollSecret: p.pollSecret });
      const status = str(j.status) || 'pending';
      if (status === 'confirmed') {
        const deviceToken = str(j.deviceToken).trim();
        const accountId = str(j.accountId).trim();
        // A confirmation is an identity handoff, not merely a status word. Persisting a token without the
        // account it belongs to would let later balance calls fall back to a different/default account.
        if (!deviceToken || !accountId) {
          pending.delete(code);
          return { status: 'invalid', error: 'invalid_confirmation' };
        }
        const rec = { url: cloudUrl, deviceToken, accountId, linkedAt: now() };
        await persist(rec);
        unlinked = false;   // a fresh link overrides an earlier unlink in this process
        pending.delete(code);
        return { status: 'confirmed', accountId: rec.accountId, record: rec };
      }
      if (status === 'expired' || status === 'consumed') pending.delete(code);
      return { status };
    }

    // The token THIS process linked (or last read from the file). On desktop the shell adopts a fresh link
    // within seconds — it moves deviceToken into the OS keychain and STRIPS it from the file — but the
    // running sidecar was spawned BEFORE the link, so its envToken is empty. Without this memory the very
    // next request resolved no token and no base URL: model catalog "offline", WAKE refused, until a full
    // app restart re-spawned the sidecar with STARNET_CREDITS_TOKEN (2026-08-22, the first-run reports).
    // Cleared by an unlink; replaced by a fresh link. The keychain copy is the durable home; this is only
    // the live process keeping what it already proved.
    let sessionToken = '';

    async function persist(rec) {
      if (!file) throw new Error('no dir');
      sessionToken = str(rec && rec.deviceToken).trim() || sessionToken;
      await fsp.mkdir(DIR, { recursive: true });
      const tmp = file + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(rec), { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(tmp, file);
      try { await fsp.chmod(file, 0o600); } catch (_) {}   // best-effort tighten (no-op on Windows)
      return rec;
    }

    // Unlink within this process must win over a token the desktop injected at spawn: process.env still
    // holds it after the keychain entry is deleted, so without this the station would look linked until
    // the next restart. Set by clearSaved(), cleared by a fresh link.
    let unlinked = false;

    // Synchronous read for boot-time credits construction (the credits adapter must be built at require-time,
    // before the event loop turns). Returns null when there is no valid linked record.
    //
    // The token comes from the file when it is there (a link that has not been adopted yet) and otherwise
    // from the desktop's keychain injection. The non-secret fields ALWAYS come from the file — adoption only
    // removes `deviceToken`, so url/accountId/linkedAt survive it.
    function loadSavedSync() {
      if (!file || !fs || unlinked) return null;
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const j = JSON.parse(raw);
        const fileToken = str(j && j.deviceToken).trim();
        if (fileToken) sessionToken = fileToken;   // pre-adoption read: remember it before the shell strips the file
        // A newly linked token belongs to the account in THIS file. envToken was captured when the sidecar
        // launched and may still be the old/revoked keychain token during a same-process relink. Once we have
        // proved a fresh file token, remember it and keep it authoritative after the shell strips the file.
        const token = fileToken || sessionToken || envToken;
        if (j && j.url && token) {
          return { url: trimSlash(j.url), deviceToken: token, accountId: str(j.accountId), linkedAt: j.linkedAt || 0 };
        }
      } catch (_) {}
      return null;
    }

    function hasSaved() { return !!loadSavedSync(); }

    // True once the token is out of the file and living in the keychain — what the desktop's adopt step
    // achieves. Reported by /api/credits so the STORE can tell the truth about where the secret sits.
    function tokenAtRest() {
      if (!file || !fs) return 'none';
      let onDisk = false;
      try { onDisk = !!str(JSON.parse(fs.readFileSync(file, 'utf8')).deviceToken).trim(); } catch (_) { onDisk = false; }
      if (onDisk) return 'file';
      if ((envToken || sessionToken) && hasSaved()) return 'keychain';
      return 'none';
    }

    // Unlink: delete the persisted device token. Safe under the secret-durability law — the token is re-issuable
    // (relinking mints a new one). ENOENT is a success (already inert).
    //
    // Deletes the FILE half only. The keychain half is the desktop's to remove (harness_clear_credits_token),
    // because only the shell can reach the OS credential store — so the UI must call BOTH. Marking `unlinked`
    // here means the running sidecar stops honouring the injected token immediately either way.
    async function clearSaved() {
      unlinked = true; sessionToken = '';   // an unlink forgets the live token too — nothing may outlive the user's choice
      if (!file) return { ok: true, removed: false };
      try { await fsp.unlink(file); return { ok: true, removed: true }; }
      catch (e) { if (e && e.code === 'ENOENT') return { ok: true, removed: false }; return { ok: false, error: (e && e.message) || String(e) }; }
    }

    return {
      configured, cloudUrl: () => cloudUrl, start, poll, persist, loadSavedSync, hasSaved, tokenAtRest, clearSaved,
      _internals: { file, pending }
    };
  }

  return { makeCreditsLink };
});
