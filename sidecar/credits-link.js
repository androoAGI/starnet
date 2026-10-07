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
    // fail-open noter (failopen.js note): best-effort failures are allowed to fail but must be COUNTED.
    const note = (typeof deps.note === 'function') ? deps.note : function () {};
    const file = (P && DIR) ? P.join(DIR, 'credits.json') : '';
    // Unlink tombstone: written by clearSaved(), removed by persist() (a fresh link). It is what stops the
    // boot self-heal from resurrecting a link the Commander deliberately severed — the OS keychain can still
    // hold the old token after an unlink (the shell's clear is a separate call that can fail), and a heal
    // that trusts the keychain alone would quietly re-link the station against their explicit choice.
    const tombstone = (P && DIR) ? P.join(DIR, 'credits.unlinked.json') : '';
    const requestTimeoutMs = (typeof deps.requestTimeoutMs === 'number' && isFinite(deps.requestTimeoutMs) && deps.requestTimeoutMs > 0)
      ? Math.floor(deps.requestTimeoutMs) : 8000;

    // code -> { pollSecret, at }. The pollSecret is the secret half of the pairing; it never leaves the sidecar.
    const pending = new Map();
    // Network completions belong to the link attempt that started them. Explicit unlink or a newer
    // pairing invalidates them immediately; disk mutations are serialized independently of network I/O.
    let generation = 0;
    let lastTransition = null;
    let recovering = false;
    // Boot self-heal retry (issue #76, 2026-10-06): the heal used to be ONE-SHOT at boot, so a cloud that was slow
    // or down at that moment left a paid, keychain-authorized station looking unlinked for the whole session —
    // hours — even after the cloud recovered. A TRANSIENT refusal (unreachable / 5xx / 429) now arms a retry the
    // host can take on the next credits read, at most once per healRetryMs. Definitive refusals never re-arm.
    const healRetryMs = (typeof deps.healRetryMs === 'number' && isFinite(deps.healRetryMs) && deps.healRetryMs >= 0)
      ? Math.floor(deps.healRetryMs) : 30000;
    let healInflight = null, healRetryArmed = false, lastHealAt = 0;
    function transition(state) { lastTransition = { state, at: now() }; }
    let mutation = Promise.resolve();
    function mutate(fn) {
      const next = mutation.then(fn, fn);
      mutation = next.catch(error => { note('credits.link.mutation', error); });
      return next;
    }

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
      const ticket = ++generation;
      transition('pairing_started');
      pending.clear();
      const j = await postJson('/v1/link/start', { deviceName: str(deviceName) || 'StarNet Station' });
      if (ticket !== generation) return { ok: false, error: 'superseded' };
      const code = str(j.code);
      if (!code) return { ok: false, error: 'no_code' };
      pending.set(code, { pollSecret: str(j.pollSecret), at: now(), generation: ticket });
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
      const j = p.confirmation || await postJson('/v1/link/poll', { code, pollSecret: p.pollSecret });
      if (p.generation !== generation || pending.get(code) !== p) return { status: 'superseded' };
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
        // The cloud hands out the token once. Retain it server-side if local persistence fails so a
        // retry can finish the same handoff instead of asking the cloud for an already-consumed token.
        p.confirmation = j;
        await persist(rec, p.generation);
        if (p.generation !== generation) return { status: 'superseded' };
        unlinked = false;   // a fresh link overrides an earlier unlink in this process
        transition('pairing_saved');
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

    function persist(rec, ticket = generation) { return mutate(async () => {
      if (ticket !== generation) return null;
      if (!file) throw new Error('no dir');
      await fsp.mkdir(DIR, { recursive: true });
      const tmp = file + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(rec), { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(tmp, file);
      try { await fsp.chmod(file, 0o600); } catch (_) {}   // best-effort tighten (no-op on Windows)
      // a fresh link overrides an earlier unlink; a missing tombstone is the normal case, not a failure
      if (tombstone) { try { await fsp.unlink(tombstone); } catch (e) { if (!e || e.code !== 'ENOENT') { note('credits.link.tombstone.remove', e); throw e; } } }
      if (ticket === generation) sessionToken = str(rec && rec.deviceToken).trim() || sessionToken;
      return rec;
    }); }

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
        if (tombstone && fs.existsSync(tombstone)) return null;
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
      // Capture the live token BEFORE forgetting it: unlink must also kill the credential CLOUD-side
      // (POST /v1/link/revoke), or any stale copy — the keychain after a failed shell clear, a backup —
      // keeps spending forever. Best-effort by contract: an offline unlink still unlinks locally.
      const dying = str((loadSavedSync() || {}).deviceToken || sessionToken || envToken).trim();
      ++generation; pending.clear();
      transition('unlink_requested');
      unlinked = true; sessionToken = '';   // an unlink forgets the live token too — nothing may outlive the user's choice
      const result = await mutate(async () => {
        if (!file) return { ok: true, removed: false };
        let tombstoneError = null;
        if (tombstone) {
          try {
            await fsp.mkdir(DIR, { recursive: true });
            await fsp.writeFile(tombstone, JSON.stringify({ unlinkedAt: now() }), { encoding: 'utf8', mode: 0o600 });
          } catch (e) { tombstoneError = e; note('credits.link.tombstone.write', e); }
        }
        let removed = false, unlinkError = null;
        try { await fsp.unlink(file); removed = true; }
        catch (e) { if (!e || e.code !== 'ENOENT') unlinkError = e; }
        const failure = tombstoneError || unlinkError;
        return failure ? { ok: false, removed, error: failure.message || String(failure) } : { ok: true, removed };
      });
      if (dying && configured() && doFetch) {
        try {
          const ctl = typeof AbortController === 'function' ? new AbortController() : null;
          const timer = ctl ? setTimeout(() => ctl.abort(), requestTimeoutMs) : null;
          try {
            await doFetch(cloudUrl + '/v1/link/revoke', {
              method: 'POST', headers: { 'Authorization': 'Bearer ' + dying }, signal: ctl ? ctl.signal : undefined
            });
          } finally { if (timer) clearTimeout(timer); }
        } catch (e) { note('credits.link.remote-revoke', e); }   // best-effort — the local unlink below is the guaranteed half
      }
      if (unlinked) transition(result.ok ? 'unlinked' : 'unlink_failed');
      return result;
    }

    /* BOOT SELF-HEAL (2026-08-25 stranded-user incident). A reinstall (or workspace reset) deletes
       credits.json but the device token survives in the OS keychain and is injected back as envToken —
       leaving a station that IS authorized but LOOKS unlinked: empty model catalog, refused runs, and a
       Commander with paid credit staring at "not linked". Rebuild the record from the one surviving half:
       ask the cloud /v1/whoami who this token belongs to, and persist the answer.

       Refuses unless EVERY guard passes — this must never resurrect a severed link:
         · configured() (a cloud URL exists) and an envToken to try;
         · no saved record (a live link needs no heal) and no in-process unlink;
         · no unlink tombstone on disk (the Commander's explicit choice outranks the keychain);
         · the cloud ACCEPTS the token (a revoked/unknown token 401s and heals nothing).
       Best-effort by contract: any failure returns { healed:false, reason } and the station simply stays
       honestly unlinked, exactly as before this existed. */
    async function healFromEnvInner() {
      if (!configured() || !doFetch) return { healed: false, reason: 'not_configured' };
      if (!envToken) return { healed: false, reason: 'no_env_token' };
      if (unlinked) return { healed: false, reason: 'unlinked_this_session' };
      if (loadSavedSync()) return { healed: false, reason: 'already_linked' };
      if (tombstone && fs && fs.existsSync(tombstone)) return { healed: false, reason: 'unlink_tombstone' };
      const ticket = generation;
      let r;
      let j;
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), requestTimeoutMs) : null;
      try {
        r = await doFetch(cloudUrl + '/v1/whoami', { headers: { 'Authorization': 'Bearer ' + envToken, 'Accept': 'application/json' }, signal: ctl ? ctl.signal : undefined });
        if (!r || !r.ok) {
          const status = Number(r && r.status) || 0;
          // 5xx / 429 / no status = the cloud is degraded, not a verdict on this token: worth asking again later.
          return { healed: false, reason: status === 401 ? 'token_revoked' : ('whoami http ' + (r && r.status)),
            retryable: status !== 401 && (status === 0 || status === 429 || status >= 500) };
        }
        j = (await r.json()) || {};
      } catch (e) {
        return { healed: false, reason: 'unreachable', retryable: true, error: (e && e.message) || String(e) };
      } finally { if (timer) clearTimeout(timer); }
      if (ticket !== generation) return { healed: false, reason: 'superseded' };
      const accountId = str(j.accountId).trim();
      if (!accountId) return { healed: false, reason: 'no_account_in_reply' };
      const rec = { url: cloudUrl, deviceToken: envToken, accountId, linkedAt: now() };
      try { await persist(rec, ticket); } catch (e) { return { healed: false, reason: 'persist_failed', error: (e && e.message) || String(e) }; }
      if (ticket !== generation) return { healed: false, reason: 'superseded' };
      unlinked = false;
      transition('keychain_recovered');
      return { healed: true, accountId };
    }

    function healFromEnv() {
      if (healInflight) return healInflight;   // boot + a credits read may ask at once: one whoami, one answer
      recovering = true;
      healInflight = (async () => {
        try {
          const r = await healFromEnvInner();
          lastHealAt = now();
          healRetryArmed = !!(r && !r.healed && r.retryable);
          return r;
        } finally { recovering = false; healInflight = null; }
      })();
      return healInflight;
    }
    // True when the last heal failed TRANSIENTLY and the retry spacing has elapsed. Every other guard (a link now
    // exists, an unlink happened, a tombstone appeared) is re-checked by healFromEnvInner itself on the retry.
    function healRetryDue() {
      return healRetryArmed && !healInflight && !unlinked && (now() - lastHealAt) >= healRetryMs;
    }

    // Only observable shape leaves this module. An injected/session token does not prove the OS
    // keychain still holds it; diagnostics must not turn that inference into a durability claim.
    function diagnosticState() {
      const saved = loadSavedSync();
      let fileToken = false, explicitlyUnlinked = unlinked;
      try { explicitlyUnlinked = explicitlyUnlinked || !!(tombstone && fs.existsSync(tombstone)); }
      catch (error) { note('credits.link.diagnostics.tombstone', error); }
      try { fileToken = !!str(JSON.parse(fs.readFileSync(file, 'utf8')).deviceToken).trim(); }
      catch (error) { if (!error || error.code !== 'ENOENT') note('credits.link.diagnostics.record', error); }
      return {
        state: explicitlyUnlinked ? 'unlinked' : pending.size ? 'pairing' : saved ? 'saved' : recovering ? 'recovering' : 'missing',
        credential: explicitlyUnlinked ? 'none' : fileToken ? 'file' : envToken ? 'injected' : sessionToken ? 'session' : 'none',
        pendingCount: pending.size,
        lastTransition: lastTransition ? { ...lastTransition } : null,
        linkedAt: saved ? saved.linkedAt || null : null
      };
    }

    return {
      configured, cloudUrl: () => cloudUrl, start, poll, persist, loadSavedSync, hasSaved, tokenAtRest, clearSaved, healFromEnv, healRetryDue, diagnosticState,
      _internals: { file, tombstone, pending }
    };
  }

  return { makeCreditsLink };
});
