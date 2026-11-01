/* node test/oauth-status.e2e.test.js — the dead-subscription-token honesty seam for the device-OAuth
   providers (Grok + Kimi), over real sockets. The exact mirror of codex-status.e2e.test.js: the same
   escape (a refresh token consumed elsewhere while Settings kept claiming SIGNED IN) must be impossible here.

   Boots the ACTUAL sidecar against an isolated workspace whose <id>/tokens.json is pre-seeded, and proves at
   the HTTP surface, for BOTH providers:
     · a persisted DEAD marker -> GET /api/auth/<id>/status = { connected:false, expired:true, reason } —
       RESTART STAYS HONEST, connected NEVER reads true while known-dead.
     · no token material rides the status payload.
     · POST /api/auth/<id>/logout clears everything -> { connected:false, expired:false } and restart stays disconnected.
     · a healthy envelope (no marker) still reads connected:true — the good path is untouched.
   Zero network beyond localhost; no model spend. */
'use strict';

const A = require('./_assert.js');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) { settled = true; try { child.kill(); } catch (_) {} if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}
function kill(child) { return new Promise(r => { try { child.on('exit', () => r()); child.kill(); } catch (_) { r(); } setTimeout(r, 3000); }); }

// a JWT access token far in the future (so no refresh is ever attempted on a status read) + a long opaque refresh
const ACCESS = 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE5MDAwMDAwMDB9.ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3Q';
const REFRESH = 'rf-oauth-e2e-test-refresh-token-abcdefghijklmnopqrstuvwxyz-0123456789';

function seedTokens(ws, id, envelope) {
  const dir = path.join(ws, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify(envelope));
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-oauthstat-ws-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1' };

  // ===== boot 1: a persisted DEAD marker for BOTH providers =====
  const deadMarker = { reason: 'This sign-in expired — sign in again.', code: 'invalid_grant', at: '2026-07-16T06:00:00.000Z' };
  seedTokens(ws, 'grok', { access_token: ACCESS, refresh_token: REFRESH, expires_at: 1900000000000, last_refresh: '2026-07-16T01:00:00.000Z', authDead: deadMarker });
  seedTokens(ws, 'kimi', { access_token: ACCESS, refresh_token: REFRESH, expires_at: 1900000000000, last_refresh: '2026-07-16T01:00:00.000Z', device_id: 'kimi-dev-e2e', authDead: deadMarker });

  let { child, port } = await boot(await allocatePort(), env, 20);
  let B = 'http://' + HOST + ':' + port;
  try {
    let token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    for (const id of ['grok', 'kimi']) {
      const statusUrl = B + '/api/auth/' + id + '/status';
      const raw = await (await fetch(statusUrl, { headers })).text();
      const s = JSON.parse(raw);
      A.eq(s.connected, false, id + ': a persisted dead marker NEVER claims connected (restart honesty)');
      A.eq(s.expired, true, id + ': status reports expired:true for the dead sign-in');
      A.ok(s.reason && /sign in again/i.test(s.reason), id + ': status carries the human reason');
      A.eq(s.expiredAt, '2026-07-16T06:00:00.000Z', id + ': status carries when the token died');
      A.ok(raw.indexOf(ACCESS) === -1 && raw.indexOf(REFRESH) === -1, id + ': no token material rides the status payload');
    }

    // ===== DISCONNECT: logout clears tokens AND the dead state, and removes the file =====
    for (const id of ['grok', 'kimi']) {
      const lo = await (await fetch(B + '/api/auth/' + id + '/logout', { method: 'POST', headers })).json();
      A.eq(lo.connected, false, id + ': logout answers connected:false');
      const s = await (await fetch(B + '/api/auth/' + id + '/status', { headers })).json();
      A.eq(s.connected, false, id + ': after logout not connected');
      A.eq(s.expired, false, id + ': after logout the dead state was cleared with the credentials');
      A.eq(fs.existsSync(path.join(ws, id, 'tokens.json')), false, id + ': logout removed the token file');
    }

    // ===== boot 2: logout survives a REAL sidecar restart — neither resilient copy can resurrect it =====
    await kill(child);
    ({ child, port } = await boot(port, env, 20));
    B = 'http://' + HOST + ':' + port;
    token = await bootToken(B, B);
    let headers2 = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    for (const id of ['grok', 'kimi']) {
      const s = await (await fetch(B + '/api/auth/' + id + '/status', { headers: headers2 })).json();
      A.eq(s.connected, false, id + ': logout remains disconnected after a real sidecar restart');
      A.eq(s.expired, false, id + ': restart cannot recover the old dead credential from .bak');
    }

    // ===== boot 3: a HEALTHY envelope (no marker) still reads connected — the good path is untouched =====
    await kill(child);
    seedTokens(ws, 'grok', { access_token: ACCESS, refresh_token: REFRESH, expires_at: 1900000000000, last_refresh: '2026-07-16T01:00:00.000Z' });
    seedTokens(ws, 'kimi', { access_token: ACCESS, refresh_token: REFRESH, expires_at: 1900000000000, last_refresh: '2026-07-16T01:00:00.000Z', device_id: 'kimi-dev-e2e' });
    ({ child, port } = await boot(port, env, 20));
    B = 'http://' + HOST + ':' + port;
    token = await bootToken(B, B);
    headers2 = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    for (const id of ['grok', 'kimi']) {
      const s = await (await fetch(B + '/api/auth/' + id + '/status', { headers: headers2 })).json();
      A.eq(s.connected, true, id + ': a healthy persisted sign-in still reads connected:true');
      A.eq(s.expired, false, id + ': a healthy sign-in is not expired');
    }
  } finally {
    await kill(child);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('oauth-status.e2e.test');
})().catch(e => { console.error('oauth-status.e2e.test FAILED:', e); process.exit(1); });
