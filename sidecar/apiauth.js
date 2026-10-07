/* sidecar/apiauth.js — the PURE auth/guard logic for the loopback HTTP API, factored out of index.js so
   it is unit-testable (index.js self-boots a server and cannot be required by a test). index.js keeps the
   thin res-writing wrappers (applyApiCors / rejectApi / rejectBadApiToken) and delegates the decisions here.

   THREAT MODEL (read before changing):
   - PRIMARY (defended): a malicious WEBSITE the user visits must not drive the agent or read its data via
     fetch()/EventSource to the loopback port. Three layers stop it: (a) the Host pin defeats DNS-rebinding;
     (b) the Origin allow-list rejects foreign origins; (c) a per-launch secret token is REQUIRED on every
     API call — as a custom header. Browser surfaces that cannot set a header (link/tab opens, EventSource, the
     unload beacon) present a SCOPED, SHORT-LIVED ticket instead (./apitickets.js) — never the master token; the
     master token in a query string is refused everywhere (2026-09-25: URLs leak into history/Referer/logs). A custom header cannot be set cross-origin without a CORS preflight the server refuses,
     and cross-origin reads of our page/responses are opaque, so a site can neither forge nor steal it.
   - RESIDUAL (accepted, documented): a process running as the SAME OS user can read the token (it is injected
     into the served page), the keychain, and the data files. That is inherent to a single-user loopback app —
     an OS-trust problem, not an app-layer one. We raise the bar (no free token vending; token on every route)
     but make no claim to stop same-user malware.

   All functions are pure (no ambient clock/rng). timingSafeEqual is deterministic, so this passes lint-determinism. */
'use strict';
const nodeCrypto = require('node:crypto');
const apitickets = require('./apitickets.js');

// the desktop (Tauri) build serves the bundled UI from a custom-scheme origin, not the loopback http origin.
const TAURI_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'app://localhost']);
function loopbackOrigins(port) { return new Set(['http://127.0.0.1:' + port, 'http://localhost:' + port]); }

// Is this Origin one of ours? Absent Origin is allowed HERE because same-origin GETs and non-browser clients
// omit it — but those callers are still gated by requiresApiToken (the token, not the origin, is their fence).
// `host` (the request's Host header) admits a PORT-FORWARDED page — see isSameLoopbackOrigin. Omitted = the
// strict station-port-only answer.
function isAllowedApiOrigin(origin, port, host) {
  if (!origin) return true;
  if (origin === 'null') return false;                 // file:/sandboxed origins are never the app
  return loopbackOrigins(port).has(origin) || TAURI_ORIGINS.has(origin) || isSameLoopbackOrigin(origin, host);
}
/* A page reached through a port forward (`ssh -L 9000:127.0.0.1:8787`, a container port map) is SAME-ORIGIN with
   the server it talks to, just not on the station's own port: the browser addresses localhost:9000, so it sends
   Host: localhost:9000 AND Origin: http://localhost:9000. Pinning the Origin to the station's port refused every
   such POST with a bare 403 while GETs (no Origin) still worked — a valid OpenRouter key read "not verified" with
   nothing logged anywhere (#62). Admit exactly that pair: the Origin's host:port must EQUAL the request's own Host,
   and that Host must already be loopback. A foreign page cannot produce it (its Origin is its own site, never the
   Host it is calling), a DNS-rebinding attacker's Host fails the Host pin, and the per-launch token still fences
   every route — this restores the same-origin case only, never a cross-origin one. */
function isSameLoopbackOrigin(origin, host) {
  if (!host || !isAllowedHost(host)) return false;
  let u; try { u = new URL(String(origin)); } catch (_) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.origin !== String(origin)) return false;       // a bare serialized origin only (no path/userinfo tricks)
  return u.host === String(host).toLowerCase().trim();
}
// Host must be loopback — this is the DNS-rebinding defense (a rebinding attacker's forged Host fails here).
function isAllowedHost(host) {
  let h = String(host || '').toLowerCase().trim();
  const br = h.match(/^\[([^\]]+)\](?::\d+)?$/);                              // [ipv6] or [ipv6]:port
  if (br) h = br[1];
  else if ((h.match(/:/g) || []).length === 1) h = h.replace(/:\d+$/, '');   // host:port (single colon = ipv4/name)
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

// the path portion of a request url, query stripped (so '/api/x?y=z' matches '/api/x').
function pathOf(url) { const u = String(url || ''); const i = u.indexOf('?'); return i < 0 ? u : u.slice(0, i); }

/* Does this request require the custom-header token? YES for every /api/* route — GET data routes included —
   EXCEPT a small set that provably cannot carry the header:
     /api/key              : guarded by its OWN per-launch IPC_TOKEN (the desktop key push)
     /api/channels/token   : guarded by its OWN per-launch IPC_TOKEN (the desktop channel-token push)
     /api/health           : liveness probe
     /api/spotify/callback : an OAuth redirect — a top-level browser navigation, no place to put a header
     /api/connectors/oauth/callback : same — the MCP-connector OAuth redirect; the CSRF `state` param (matched
                             against the in-memory pending map) is its fence, exactly like the Spotify callback
   NOT exempt, but header-less: GET/HEAD /api/file (link/tab open), GET /api/channels/events (EventSource) and
   POST /api/save (unload beacon) may present a ?ticket= scoped to exactly that request — see ticketOk below. */
const TOKEN_EXEMPT = new Set(['/api/key', '/api/channels/token', '/api/health', '/api/spotify/callback', '/api/connectors/oauth/callback']);
function requiresApiToken(req) {
  if (!req || req.method === 'OPTIONS') return false;
  const p = pathOf(req.url);
  if (p.indexOf('/api/') !== 0 && p !== '/api') return false;   // static assets / non-api never need a token
  return !TOKEN_EXEMPT.has(p);
}

function headerToken(req) {
  const h = (req && req.headers) || {};
  return String(h['x-starnet-token'] || h['x-skynet-token'] || '');   // dual-accept the legacy header name
}
// constant-time compare; false on any length mismatch / empty (never throws).
function constTimeEq(a, b) {
  a = String(a == null ? '' : a); b = String(b == null ? '' : b);
  if (!a || !b || a.length !== b.length) return false;
  try { return nodeCrypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (_) { return false; }
}
function apiTokenOk(req, token) { return constTimeEq(headerToken(req), token); }     // header path (fetch)

/* The header-less escape hatch: a ?ticket= minted for EXACTLY this request's resource (apitickets.apiTicketClaim
   derives kind + scope from method/path/query; the ticket itself carries no scope). Only three request shapes can
   claim one — GET/HEAD /api/file, GET /api/channels/events, POST /api/save — everything else is header-only.
   `now` and the single-use `guard` are injected (pure). */
function ticketOk(req, token, now, guard) {
  const claim = apitickets.apiTicketClaim(req);
  if (!claim || !claim.ticket) return false;
  return apitickets.verify(token, claim.ticket, claim.kind, claim.scope, { now: now, guard: guard }).ok;
}

module.exports = {
  isAllowedApiOrigin, isSameLoopbackOrigin, isAllowedHost, requiresApiToken, apiTokenOk, ticketOk,
  headerToken, constTimeEq, pathOf, loopbackOrigins, TAURI_ORIGINS, TOKEN_EXEMPT
};
