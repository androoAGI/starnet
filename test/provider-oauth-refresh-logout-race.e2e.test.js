'use strict';
/* node test/provider-oauth-refresh-logout-race.e2e.test.js — a subscription token refresh that is still in flight
   when the Commander signs out must never sign the station back in.

   refreshCodexTokensOnce / refreshOAuthTokensOnce / an extra account's refresh awaited the token endpoint and then
   merged the response into whatever the store held NOW and saved it: a logout that landed during the await was
   undone (Object.assign({}, null, next) written over the signed-out tombstone — still signed in after a restart),
   and a failed refresh stamped a dead marker over it (Settings: SIGN-IN EXPIRED after an explicit sign-out).
   The MCP connector refresh already kept the rule this proves: a refresh belongs to the grant that started it.

   Boots the actual sidecar with a preload that holds each token-endpoint call until released (no network), and
   drives the real HTTP routes: ChatGPT (success), Grok (success), Kimi (failure branch), a removed extra Kimi
   account, and an extra Kimi account signed in AGAIN while its old grant was refreshing (the late response must
   not merge over the new sign-in); then restarts to prove the sign-outs are durable. */
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const jwt = claims => 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.c2ln';
const EXPIRED = jwt({ exp: 1 });
const GONE = 'a1b2c3d4e5f6';    // extra Kimi account #1 (oldest): removed mid-refresh
const AGAIN = 'b2c3d4e5f6a1';   // extra Kimi account #2: signed in again mid-refresh

function seed(ws) {
  const put = (rel, obj) => { const f = path.join(ws, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); };
  put('codex/tokens.json', { access_token: EXPIRED, refresh_token: 'R_CODEX', last_refresh: '2026-01-01T00:00:00Z', auth_mode: 'chatgpt' });
  put('grok/tokens.json', { access_token: 'grok-old', refresh_token: 'R_GROK', expires_at: 1, last_refresh: '2026-01-01T00:00:00.000Z' });
  put('kimi/tokens.json', { access_token: 'kimi-old', refresh_token: 'R_FAIL_KIMI', expires_at: 1, last_refresh: '2026-01-01T00:00:00.000Z', device_id: 'kimi-dev-race' });
  put('.secrets/accounts/kimi/' + GONE + '/account.json', { id: GONE, seq: 1 });
  put('.secrets/accounts/kimi/' + GONE + '/tokens.json', { access_token: 'kimi-gone-old', refresh_token: 'R_GONE', expires_at: 1, last_refresh: '2026-01-01T00:00:00.000Z', device_id: 'kimi-gone-dev' });
  put('.secrets/accounts/kimi/' + AGAIN + '/account.json', { id: AGAIN, seq: 2 });
  put('.secrets/accounts/kimi/' + AGAIN + '/tokens.json', { access_token: 'kimi-again-old', refresh_token: 'R_AGAIN', expires_at: 1, last_refresh: '2026-01-01T00:00:00.000Z', device_id: 'kimi-again-dev' });
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return undefined; } };
const signedOut = raw => raw === undefined || raw === null || (typeof raw === 'object' && !raw.access_token && !raw.refresh_token);

(async () => {
  const preload = path.join(__dirname, 'fixtures', 'provider-oauth-refresh-logout-preload.cjs').replace(/\\/g, '/');
  const fixture = SidecarFixture.create({
    prefix: 'starnet-provider-refresh-logout-', timeoutMs: 30000,
    env: { DEFAULT_MODEL: 'replay', OPENROUTER_KEY: '', NODE_OPTIONS: '--require=' + JSON.stringify(preload) }
  });
  const ws = fixture.workspace;
  seed(ws);
  const waitFor = async (rt, label) => {
    const f = path.join(ws, 'started-' + rt); const until = Date.now() + 15000;
    while (!fs.existsSync(f) && Date.now() < until) await sleep(25);
    A.ok(fs.existsSync(f), label + ': the refresh is in flight at the token endpoint');
  };
  const release = rt => fs.writeFileSync(path.join(ws, 'release-' + rt), '1');
  // a refresh in flight, a sign-out during it, then the late response
  async function race(rt, label, modelsRoute, signOut) {
    const listing = fixture.json('GET', modelsRoute);
    await waitFor(rt, label);
    const out = await signOut();
    A.eq(out.status, 200, label + ': the sign-out lands while the refresh is held');
    release(rt);
    const r = await listing;
    A.eq(r.status, 200, label + ': the held request settles (200-always route)');
    await sleep(150);
    return r;
  }
  try {
    await fixture.start();
    A.ok(!fs.readdirSync(ws).some(n => n.indexOf('started-') === 0), 'boot itself refreshes nothing (every refresh below is test-driven)');

    // ---- 1. ChatGPT primary: a SUCCESSFUL late refresh must not undo the logout ----
    const c = await race('R_CODEX', 'chatgpt', '/api/auth/codex/models', () => fixture.json('POST', '/api/auth/codex/logout', {}));
    A.ok(c.body && c.body.code === 'codex_not_connected', 'chatgpt: the late refresh answers "not connected", never the old grant (code=' + (c.body && c.body.code) + ')');
    let st = await fixture.json('GET', '/api/auth/codex/status');
    A.eq(st.body.connected, false, 'chatgpt: still signed out after the late refresh response');
    const codexFile = readJson(path.join(ws, 'codex', 'tokens.json'));
    A.ok(codexFile && codexFile.signedOut === true && !codexFile.access_token && !codexFile.refresh_token, 'chatgpt: the signed-out tombstone is still what is on disk (got ' + JSON.stringify(codexFile && Object.keys(codexFile)) + ')');

    // ---- 2. Grok primary: same rule through the device-OAuth keeper ----
    await race('R_GROK', 'grok', '/api/auth/grok/models', () => fixture.json('POST', '/api/auth/grok/logout', {}));
    st = await fixture.json('GET', '/api/auth/grok/status');
    A.eq(st.body.connected, false, 'grok: still signed out after the late refresh response');
    A.ok(signedOut(readJson(path.join(ws, 'grok', 'tokens.json'))), 'grok: no credential was written back to grok/tokens.json');

    // ---- 3. Kimi primary: a FAILED late refresh must not stamp a dead marker over the sign-out ----
    await race('R_FAIL_KIMI', 'kimi', '/api/auth/kimi/models', () => fixture.json('POST', '/api/auth/kimi/logout', {}));
    st = await fixture.json('GET', '/api/auth/kimi/status');
    A.eq(st.body.connected, false, 'kimi: signed out');
    A.eq(st.body.expired, false, 'kimi: an explicit sign-out is not reported as SIGN-IN EXPIRED');
    const kimiFile = readJson(path.join(ws, 'kimi', 'tokens.json'));
    A.ok(kimiFile === undefined || kimiFile === null, 'kimi: nothing was written back to kimi/tokens.json (got ' + JSON.stringify(kimiFile) + ')');

    // ---- 4. the oldest extra Kimi account removed while its refresh is in flight (the primary is signed out by
    //         step 3, so the chain opens on it). Regression guard: on trunk the late save already fails because the
    //         folder is gone (no mkdir), so this arm passes with or without the refresh guard. ----
    const goneDir = path.join(ws, '.secrets', 'accounts', 'kimi', GONE);
    await race('R_GONE', 'removed account', '/api/auth/kimi/models', () => fixture.json('POST', '/api/auth/kimi/remove', { account: GONE }));
    A.ok(!fs.existsSync(path.join(goneDir, 'tokens.json')), 'removed account: no tokens.json secret is written back into the removed account');
    const accts = await fixture.json('GET', '/api/auth/kimi/accounts');
    A.ok(!JSON.stringify(accts.body || {}).includes(GONE), 'removed account: it stays removed');

    // ---- 5. the next extra Kimi account is signed in AGAIN while its old grant is refreshing: the new sign-in wins ----
    const againFile = path.join(ws, '.secrets', 'accounts', 'kimi', AGAIN, 'tokens.json');
    await race('R_AGAIN', 're-signed account', '/api/auth/kimi/models', async () => {
      const start = await fixture.json('POST', '/api/auth/kimi/account-start', { account: AGAIN });
      A.eq(start.status, 200, 're-signed account: a new device sign-in starts for the same account');
      return fixture.json('POST', '/api/auth/kimi/account-poll', { login_id: start.body && start.body.login_id });
    });
    const again = readJson(againFile) || {};
    A.eq(again.refresh_token, 'R_NEWSIGNIN', 're-signed account: the NEW sign-in\'s refresh token is what is saved (got ' + again.refresh_token + ')');
    A.eq(again.access_token, 'NEWSIGNIN_ACCESS', 're-signed account: the old grant\'s late refresh did not merge over the new access token');

    // ---- 6. restart: every sign-out is durable ----
    await fixture.restart();
    st = await fixture.json('GET', '/api/auth/codex/status');
    A.eq(st.body.connected, false, 'restart: ChatGPT stays signed out');
    st = await fixture.json('GET', '/api/auth/grok/status');
    A.eq(st.body.connected, false, 'restart: Grok stays signed out');
    st = await fixture.json('GET', '/api/auth/kimi/status');
    A.ok(st.body.connected === false && st.body.expired === false, 'restart: Kimi stays signed out (not expired)');
  } finally {
    await fixture.dispose();
  }
  A.report('provider-oauth-refresh-logout-race.e2e.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
