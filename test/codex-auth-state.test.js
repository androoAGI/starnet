/* test/codex-auth-state.test.js — the ESCAPE (2026-07-08): Andrew's ChatGPT refresh token was consumed
   by another client, the run errored correctly, but /api/auth/codex/status kept answering connected:true
   and Settings kept showing "● SIGNED IN". These units pin the honest state machine:
     1. a relogin-class refresh failure (refresh_token_reused / invalid_grant / 401) produces a DEAD marker;
        transient failures (quota, network) never do.
     2. status flips to { connected:false, expired:true, reason } while known-dead — connected NEVER reads
        true while a dead marker stands, even with tokens still present.
     3. the marker survives a JSON round-trip of the tokens envelope (restart honesty).
     4. a successful refresh / completed device sign-in clears it and status reads connected again.
     5. the reason string never carries token material. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const S = require('../sidecar/providers/codex-auth-state.js');
const codexAuth = require('../sidecar/providers/codex-auth.js');

function reloginErr(code, message) {
  const e = new Error(message || 'Codex refresh token was already consumed by another client (e.g. the Codex CLI or VS Code extension). Sign in with ChatGPT again.');
  e.code = code || 'refresh_token_reused';
  e.reloginRequired = true;
  return e;
}
const TOKENS = { access_token: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjF9.c2lnbmF0dXJlLXNpZ25hdHVyZQ', refresh_token: 'rf-secret-1234567890abcdefghijklmnopqrstuvwxyz', last_refresh: '2026-07-08T01:02:03.000Z', auth_mode: 'device' };

// ---- 1. only relogin-class failures mark dead ----
{
  const m = S.deadMarkerFromError(reloginErr(), '2026-07-08T09:00:00.000Z');
  A.ok(m, 'a reloginRequired refresh failure produces a dead marker');
  A.eq(m.code, 'refresh_token_reused', 'the marker keeps the classifier code');
  A.eq(m.at, '2026-07-08T09:00:00.000Z', 'the marker is timestamped');
  A.ok(/sign in with chatgpt again/i.test(m.reason), 'the marker carries the human reason');

  const transient = new Error('Codex token refresh failed: fetch failed');
  transient.code = 'codex_refresh_failed'; transient.reloginRequired = false;
  A.eq(S.deadMarkerFromError(transient, 'now'), null, 'a transient (network) failure never marks the sign-in dead');
  const quota = new Error('quota'); quota.code = 'codex_quota_exceeded'; quota.reloginRequired = false;
  A.eq(S.deadMarkerFromError(quota, 'now'), null, 'a quota failure never marks the sign-in dead');
  A.eq(S.deadMarkerFromError(null, 'now'), null, 'null error never throws / never marks');
}

(async () => {
  // ---- the real classifier feeds this seam: codex-auth authError(relogin=true) marks dead ----
  // reach the real error factory through refreshTokens' missing-refresh-token guard (a genuine relogin-class error)
  let realErr = null;
  await codexAuth.refreshTokens({ fetch: () => { throw new Error('unreachable'); }, refresh_token: '' }).catch(e => { realErr = e; });
  A.ok(realErr && realErr.reloginRequired === true, 'codex-auth missing-refresh-token error is relogin-class');
  A.ok(S.deadMarkerFromError(realErr, 'now'), 'the real codex-auth relogin error produces a dead marker');
  runRest();
})().catch(e => { console.error(e); process.exit(1); });

function runRest() {
  // ---- 2. status truth: connected NEVER true while known-dead ----
  const marker = S.deadMarkerFromError(reloginErr(), '2026-07-08T09:00:00.000Z');
  const deadStatus = S.statusPayload({ tokens: S.withDeadMarker(TOKENS, marker), dead: marker, persistError: '' });
  A.eq(deadStatus.connected, false, 'connected reads FALSE while the token is known-dead (tokens still on disk)');
  A.eq(deadStatus.expired, true, 'expired reads TRUE while known-dead');
  A.ok(deadStatus.reason && /sign in/i.test(deadStatus.reason), 'the status carries the human reason');
  A.eq(deadStatus.expiredAt, '2026-07-08T09:00:00.000Z', 'the status carries when it died');

  // ---- 5. no token material in the payload ----
  const raw = JSON.stringify(deadStatus);
  A.ok(raw.indexOf(TOKENS.access_token) === -1, 'the access token never rides the status payload');
  A.ok(raw.indexOf(TOKENS.refresh_token) === -1, 'the refresh token never rides the status payload');
  const leaky = S.deadMarkerFromError(reloginErr('invalid_grant', 'refresh failed for ' + TOKENS.access_token), 'now');
  A.ok(leaky.reason.indexOf(TOKENS.access_token) === -1, 'a JWT embedded in an error message is scrubbed from the reason');

  // ---- 3. restart honesty: the marker survives a JSON round-trip of the envelope ----
  const persisted = JSON.parse(JSON.stringify(S.withDeadMarker(TOKENS, marker)));
  const reloaded = S.deadFromTokens(persisted);
  A.ok(reloaded, 'the dead marker survives persist + reload (restart stays honest)');
  A.eq(reloaded.code, 'refresh_token_reused', 'the reloaded marker keeps its code');
  const rebooted = S.statusPayload({ tokens: persisted, dead: reloaded, persistError: '' });
  A.eq(rebooted.connected, false, 'after a restart, status still refuses to claim connected');
  A.eq(rebooted.expired, true, 'after a restart, status still reports expired');

  // ---- 4. a successful refresh / completed sign-in clears it ----
  const healed = S.withoutDeadMarker(S.withDeadMarker(TOKENS, marker));
  A.eq(S.deadFromTokens(healed), null, 'a successful refresh strips the marker from the envelope');
  const healthyStatus = S.statusPayload({ tokens: healed, dead: null, persistError: '' });
  A.eq(healthyStatus.connected, true, 'with tokens present and no dead marker, connected reads true');
  A.eq(healthyStatus.expired, false, 'healthy status is not expired');
  A.eq(healthyStatus.reason, '', 'healthy status carries no reason');

  // fresh device sign-in (a brand-new envelope) is clean by construction
  const fresh = S.statusPayload({ tokens: { access_token: 'a.b.c', last_refresh: 'x' }, dead: null });
  A.eq(fresh.connected, true, 'a completed device sign-in reads connected');

  // no tokens at all -> plainly not connected, not expired
  const none = S.statusPayload({ tokens: null, dead: null });
  A.eq(none.connected, false, 'no tokens -> not connected');
  A.eq(none.expired, false, 'no tokens -> not expired (nothing died; it was never signed in)');

  // deadFromTokens rejects junk shapes
  A.eq(S.deadFromTokens({ access_token: 'x', authDead: 'yes' }), null, 'a non-object marker is rejected');
  A.eq(S.deadFromTokens({ access_token: 'x', authDead: { reason: '' } }), null, 'an empty reason is rejected');

  // #92: a marker saved by 0.13.1 told the user to run the Codex CLI; it reads back pointing at the in-app RECONNECT
  const legacy = S.deadFromTokens({ access_token: 'x', authDead: { reason: 'Codex refresh token was already consumed by another client (e.g. the Codex CLI or VS Code extension). Run `codex` in your terminal to mint fresh tokens, then sign in with ChatGPT again.', code: 'refresh_token_reused', at: 't' } });
  A.ok(legacy && !/run `codex`/i.test(legacy.reason), 'a legacy marker no longer tells the user to install/run the Codex CLI');
  A.ok(legacy && /RECONNECT/.test(legacy.reason) && /AI & MODELS/.test(legacy.reason), 'a legacy marker names the in-app RECONNECT door');
  A.eq(legacy && legacy.code, 'refresh_token_reused', 'the legacy marker keeps its code');
  const other = S.deadFromTokens({ access_token: 'x', authDead: { reason: 'Codex token refresh failed: nope', code: 'invalid_grant', at: 't' } });
  A.eq(other.reason, 'Codex token refresh failed: nope', 'any other stored reason reads back unchanged');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'sidecar', 'providers', 'codex-auth.js'), 'utf8');
  A.ok(!/Run `codex` in your terminal/.test(src), 'the live refresh_token_reused message never sends a desktop user to the Codex CLI');

  A.report('codex-auth-state');
}
