/* node test/apiauth.test.js — the loopback API auth/guard logic (sidecar/apiauth.js). Pure unit test, no
   server boot. Proves the HARDENED posture: every /api route requires the per-launch token (GET data routes
   INCLUDED) except a documented header-less set; tokens are constant-time compared; origin/host gating holds. */
'use strict';
const A = require('./_assert.js');
const auth = require('../sidecar/apiauth.js');

const PORT = 8787;
const TOK = 'a'.repeat(64);
const req = (method, url, headers) => ({ method, url, headers: headers || {} });

// ---- requiresApiToken: every data route now needs the token (the C2 hole: GETs used to be exempt) ----
A.eq(auth.requiresApiToken(req('GET', '/api/budget/status')), true, 'GET data route requires token');
A.eq(auth.requiresApiToken(req('GET', '/api/transcript?agent=x')), true, 'GET transcript (with query) requires token');
A.eq(auth.requiresApiToken(req('GET', '/api/notebook?agent=x')), true, 'GET notebook requires token');
A.eq(auth.requiresApiToken(req('GET', '/api/file?agent=a&path=p')), true, 'GET file requires token');
A.eq(auth.requiresApiToken(req('GET', '/api/memory/records?agent=x')), true, 'GET memory records requires token');
A.eq(auth.requiresApiToken(req('GET', '/api/runs')), true, 'GET runs requires token');
A.eq(auth.requiresApiToken(req('POST', '/api/run')), true, 'POST run requires token');
A.eq(auth.requiresApiToken(req('POST', '/api/save')), true, 'POST save now requires token (was exempt)');
A.eq(auth.requiresApiToken(req('GET', '/api/save?slot=1')), true, 'GET save now requires token (was exempt)');
A.eq(auth.requiresApiToken(req('POST', '/api/session')), true, 'POST session now requires token (no token vending)');

// ---- the documented header-less exempt set (routes that cannot carry the custom header) ----
A.eq(auth.requiresApiToken(req('POST', '/api/key')), false, 'key push exempt (own IPC_TOKEN guard)');
A.eq(auth.requiresApiToken(req('GET', '/api/health')), false, 'health probe exempt');
A.eq(auth.requiresApiToken(req('GET', '/api/spotify/callback?code=abc')), false, 'spotify OAuth redirect exempt');
A.eq(auth.requiresApiToken(req('GET', '/api/connectors/oauth/callback?code=abc&state=xyz')), false, 'connector OAuth redirect exempt (state is the CSRF fence)');
A.eq(auth.requiresApiToken(req('GET', '/api/channels/events')), true, 'SSE is GATED (header, or a single-use SSE ticket) — no longer exempt');
A.eq(auth.requiresApiToken(req('OPTIONS', '/api/run')), false, 'CORS preflight exempt');
// non-/api requests never need a token (static assets / app shell)
A.eq(auth.requiresApiToken(req('GET', '/index.html')), false, 'static asset needs no token');
A.eq(auth.requiresApiToken(req('GET', '/')), false, 'root needs no token');

// ---- apiTokenOk: custom-header path, exact + constant-time ----
A.eq(auth.apiTokenOk(req('POST', '/api/run', { 'x-starnet-token': TOK }), TOK), true, 'correct header token accepted');
A.eq(auth.apiTokenOk(req('POST', '/api/run', { 'x-skynet-token': TOK }), TOK), true, 'legacy header name accepted');
A.eq(auth.apiTokenOk(req('POST', '/api/run', { 'x-starnet-token': 'b'.repeat(64) }), TOK), false, 'wrong token rejected');
A.eq(auth.apiTokenOk(req('POST', '/api/run', { 'x-starnet-token': 'a'.repeat(63) }), TOK), false, 'length mismatch rejected (no throw)');
A.eq(auth.apiTokenOk(req('POST', '/api/run', {}), TOK), false, 'missing header rejected');
A.eq(auth.apiTokenOk(req('POST', '/api/run', { 'x-starnet-token': TOK }), ''), false, 'empty server token rejects everything');

// ---- the master token in a QUERY STRING is refused everywhere (2026-09-25: URLs leak) ----
A.eq(typeof auth.queryTokenOk, 'undefined', 'no query-token acceptor is exported any more');
A.eq(typeof auth.queryTokenRoute, 'undefined', 'no query-token route matrix is exported any more');
const T = require('../sidecar/apitickets.js');
const NOW = 1.8e12;
const G = () => T.replayGuard();
for (const u of ['/api/file?agent=a&path=p&token=' + TOK, '/api/channels/events?token=' + TOK, '/api/save?token=' + TOK]) {
  const m = u.indexOf('/api/save') === 0 ? 'POST' : 'GET';
  A.eq(auth.ticketOk(req(m, u), TOK, NOW, G()), false, 'master token as ?token= is NOT a credential: ' + m + ' ' + u.split('?')[0]);
  A.eq(auth.ticketOk(req(m, u.replace('token=', 'ticket=')), TOK, NOW, G()), false, 'master token smuggled as ?ticket= is refused too: ' + u.split('?')[0]);
}

// ---- ticketOk: the ONLY header-less credential, scoped to exactly the request's resource ----
const fileT = T.mint(TOK, 'file', T.scopeFile('a', 'dir/p q.md'), { now: NOW });
const fileUrl = '/api/file?agent=a&path=' + encodeURIComponent('dir/p q.md') + '&ticket=' + encodeURIComponent(fileT);
A.eq(auth.ticketOk(req('GET', fileUrl), TOK, NOW, G()), true, 'file ticket opens its own file (GET)');
A.eq(auth.ticketOk(req('HEAD', fileUrl), TOK, NOW, G()), true, 'file ticket opens its own file (HEAD)');
A.eq(auth.ticketOk(req('GET', fileUrl), TOK, NOW + 60000, G()), true, 'file ticket reusable within its life (video Range re-reads)');
A.eq(auth.ticketOk(req('GET', fileUrl.replace('p%20q.md', 'other.md')), TOK, NOW, G()), false, 'file ticket does NOT open a different file');
A.eq(auth.ticketOk(req('GET', fileUrl.replace('agent=a', 'agent=b')), TOK, NOW, G()), false, 'file ticket does NOT open another agent\'s file');
A.eq(auth.ticketOk(req('POST', fileUrl), TOK, NOW, G()), false, 'file ticket is not a POST credential');
A.eq(auth.ticketOk(req('GET', '/api/transcript?agent=a&ticket=' + encodeURIComponent(fileT)), TOK, NOW, G()), false, 'a ticket on any other route grants nothing');
A.eq(auth.ticketOk(req('GET', '/api/runs?ticket=' + encodeURIComponent(fileT)), TOK, NOW, G()), false, 'a ticket on /api/runs grants nothing');
A.eq(auth.ticketOk(req('GET', fileUrl), TOK, NOW + T.KINDS.file.maxTtlMs + 1, G()), false, 'file ticket EXPIRES (5 min)');
A.eq(auth.ticketOk(req('GET', fileUrl), 'b'.repeat(64), NOW, G()), false, 'a ticket from another launch (other key) is refused');
const sseT = T.mint(TOK, 'sse', T.SCOPE_SSE, { now: NOW });
const sg = G();
A.eq(auth.ticketOk(req('GET', '/api/channels/events?cursor=x&ticket=' + encodeURIComponent(sseT)), TOK, NOW, sg), true, 'SSE ticket connects once');
A.eq(auth.ticketOk(req('GET', '/api/channels/events?cursor=x&ticket=' + encodeURIComponent(sseT)), TOK, NOW, sg), false, 'SSE ticket is SINGLE-USE (replay refused)');
A.eq(auth.ticketOk(req('POST', '/api/save?ticket=' + encodeURIComponent(sseT)), TOK, NOW, G()), false, 'an SSE ticket is not a save ticket');
const saveT = T.mint(TOK, 'save', T.SCOPE_SAVE, { now: NOW });
const vg = G();
A.eq(auth.ticketOk(req('POST', '/api/save?ticket=' + encodeURIComponent(saveT)), TOK, NOW, vg), true, 'save ticket authorizes one beacon');
A.eq(auth.ticketOk(req('POST', '/api/save?ticket=' + encodeURIComponent(saveT)), TOK, NOW, vg), false, 'save ticket is SINGLE-USE');
A.eq(auth.ticketOk(req('GET', '/api/save?ticket=' + encodeURIComponent(saveT)), TOK, NOW, G()), false, 'save ticket cannot READ the save');
A.eq(auth.ticketOk(req('POST', '/api/save/recovery-ack?ticket=' + encodeURIComponent(saveT)), TOK, NOW, G()), false, 'save sibling routes are not ticketable (exact path)');
A.eq(auth.ticketOk(null, TOK, NOW, G()), false, 'no request -> false, no throw');

// ---- isAllowedApiOrigin: foreign sites rejected; absent allowed (token gates those) ----
A.eq(auth.isAllowedApiOrigin('', PORT), true, 'absent origin allowed (token is the fence for header-less callers)');
A.eq(auth.isAllowedApiOrigin('http://127.0.0.1:' + PORT, PORT), true, 'loopback origin allowed');
A.eq(auth.isAllowedApiOrigin('http://localhost:' + PORT, PORT), true, 'localhost origin allowed');
A.eq(auth.isAllowedApiOrigin('tauri://localhost', PORT), true, 'desktop (tauri) origin allowed');
A.eq(auth.isAllowedApiOrigin('https://evil.example', PORT), false, 'foreign web origin rejected');
A.eq(auth.isAllowedApiOrigin('null', PORT), false, 'null/sandboxed origin rejected');
A.eq(auth.isAllowedApiOrigin('http://127.0.0.1:1234', PORT), false, 'wrong-port loopback origin rejected');

// ---- #62: a PORT-FORWARDED page is same-origin with the server it reaches (Origin == its own loopback Host) ----
A.eq(auth.isAllowedApiOrigin('http://localhost:9000', PORT, 'localhost:9000'), true, 'ssh -L 9000 tunnel: Origin matches the request Host -> allowed');
A.eq(auth.isAllowedApiOrigin('http://127.0.0.1:9000', PORT, '127.0.0.1:9000'), true, 'tunnel on 127.0.0.1 allowed');
A.eq(auth.isAllowedApiOrigin('http://[::1]:9000', PORT, '[::1]:9000'), true, 'tunnel on ipv6 loopback allowed');
A.eq(auth.isAllowedApiOrigin('http://localhost:3000', PORT, 'localhost:' + PORT), false, 'ANOTHER local site calling the station (Origin != Host) stays refused');
A.eq(auth.isAllowedApiOrigin('http://127.0.0.1:1234', PORT, '127.0.0.1:' + PORT), false, 'wrong-port loopback origin still rejected when Host is the station');
A.eq(auth.isAllowedApiOrigin('http://evil.example:9000', PORT, 'evil.example:9000'), false, 'a rebinding attacker (non-loopback Host) is refused even when Origin == Host');
A.eq(auth.isAllowedApiOrigin('http://user@localhost:9000', PORT, 'localhost:9000'), false, 'a non-serialized origin (userinfo) never matches');
A.eq(auth.isAllowedApiOrigin('http://localhost:9000/x', PORT, 'localhost:9000'), false, 'an origin with a path never matches');
A.eq(auth.isAllowedApiOrigin('file://localhost:9000', PORT, 'localhost:9000'), false, 'non-http schemes never match');

// ---- isAllowedHost: DNS-rebinding defense ----
A.eq(auth.isAllowedHost('127.0.0.1:' + PORT), true, 'loopback host allowed');
A.eq(auth.isAllowedHost('localhost:' + PORT), true, 'localhost host allowed');
A.eq(auth.isAllowedHost('[::1]:' + PORT), true, 'ipv6 loopback host allowed');
A.eq(auth.isAllowedHost('evil.example'), false, 'foreign host rejected (rebinding defense)');
A.eq(auth.isAllowedHost('169.254.169.254'), false, 'cloud-metadata host rejected');

// ---- constant-time compare never throws on odd input ----
A.eq(auth.constTimeEq(null, TOK), false, 'null vs token -> false, no throw');
A.eq(auth.constTimeEq(TOK, TOK), true, 'equal strings compare true');
A.eq(auth.constTimeEq('x', 'yy'), false, 'unequal-length -> false');

A.report('apiauth.test');
