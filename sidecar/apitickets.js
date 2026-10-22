/* sidecar/apitickets.js — SCOPED, SHORT-LIVED URL CAPABILITIES ("tickets") that replace the master API token in
   every URL the app builds (2026-09-25 security lane, audit 09-23 open item "master token in URLs").

   WHY: a few browser surfaces cannot attach the X-Agent OS-Token header — a link/tab navigation (/api/file,
   /workshop-run/), EventSource (/api/channels/events) and the unload beacon (POST /api/save). They used to carry
   the MASTER per-launch token as ?token=…, and URLs leak: OS-browser history (desktop hands file/tool links to the
   default browser), Referer, copied links, screenshots, request logs. A leaked master token drives the whole API.

   WHAT: a ticket is an HMAC over (method, scope, expiry, nonce) keyed by the per-launch API token. The scope is the
   ONE resource the URL names — derived by the VERIFIER from the request itself, never read from the ticket — so a
   ticket for one file cannot read another file, cannot open a different run, cannot touch any other route, and
   dies at its expiry (the server caps the lifetime per kind, whatever expiry the minter asked for). Mutating/stream
   kinds (save beacon, SSE connect) are single-use.

   WHO MINTS: the page already holds the master token (it is injected, and it rides the header on every fetch), so
   the page mints tickets itself, SYNCHRONOUSLY (frontend/app/apiticket.js — a pure-JS HMAC-SHA256 that
   test/apitickets.test.js proves byte-identical to this module). Synchronous matters: a link's href, a beacon at
   pagehide and a tab opened inside a click gesture cannot wait on a round-trip. A sidecar mint endpoint would add
   no security (anyone holding the master token could call it) and would break those synchronous call sites.
   Node callers (tests, QA scripts) mint with mint() below.

   Wire format:  st1.<exp base36 ms>.<nonce hex 16-64>.<base64url HMAC-SHA256>
   MAC message:  "starnet-ticket-v1\n" + METHOD + "\n" + scope + "\n" + exp + "\n" + nonce

   Pure: no ambient clock (callers pass `now`), no module state except what a caller creates via replayGuard(). */
'use strict';
const nodeCrypto = require('node:crypto');

const DOMAIN = 'starnet-ticket-v1';
const SKEW_MS = 30 * 1000;   // same machine, but page and sidecar read the clock at different moments
// Per-kind lifetime CAP (server-enforced) + whether the ticket may be presented once only.
const KINDS = Object.freeze({
  file: Object.freeze({ method: 'GET', maxTtlMs: 5 * 60 * 1000, once: false }),    // link/tab open of ONE workspace file
  run: Object.freeze({ method: 'GET', maxTtlMs: 10 * 60 * 1000, once: false }),    // ONE workshop run dir (page + its relative assets)
  view: Object.freeze({ method: 'GET', maxTtlMs: 10 * 60 * 1000, once: false }),   // ONE workspace folder rendered in the BROWSER window (page + its relative assets)
  sse: Object.freeze({ method: 'GET', maxTtlMs: 2 * 60 * 1000, once: true }),      // one EventSource CONNECT (a live stream outlives it)
  save: Object.freeze({ method: 'POST', maxTtlMs: 2 * 60 * 1000, once: true }),    // one unload beacon
  // ONE approved plugin's UI files at ONE exact code digest (a plugin window's iframe + its relative assets). Long
  // enough to outlive a working session with the window open (lazy assets load late); an edit to the plugin
  // changes its digest, so every ticket for the old code dies with it.
  plugin: Object.freeze({ method: 'GET', maxTtlMs: 12 * 60 * 60 * 1000, once: false })
});

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function scopeFile(agent, relPath) { return 'file\n' + String(agent || 'agent') + '\n' + String(relPath || ''); }
function scopeRun(agent, runId) { return 'run\n' + String(agent || '') + '\n' + String(runId || ''); }
function scopeView(agent, dir) { return 'view\n' + String(agent || '') + '\n' + String(dir || ''); }
function scopePlugin(id, digest) { return 'plugin\n' + String(id || '') + '\n' + String(digest || ''); }
// a plugin DRAFT's preview window (/plugin-draft/): same kind, a different scope, so a draft ticket can never open an
// installed plugin's files or the other way round
function scopeDraft(id, digest) { return 'draft\n' + String(id || '') + '\n' + String(digest || ''); }
// an APP's window (/app-ui/): its own scope, so an app ticket opens that app's page and nothing else
function scopeApp(id, digest) { return 'app\n' + String(id || '') + '\n' + String(digest || ''); }
const SCOPE_SSE = 'sse\n/api/channels/events';
const SCOPE_SAVE = 'save\n/api/save';

function message(method, scope, exp, nonce) { return DOMAIN + '\n' + method + '\n' + scope + '\n' + exp + '\n' + nonce; }
function macOf(key, method, scope, exp, nonce) {
  return b64url(nodeCrypto.createHmac('sha256', Buffer.from(String(key), 'utf8')).update(message(method, scope, exp, nonce), 'utf8').digest());
}

/* mint(key, kind, scope, { now, ttlMs?, nonce? }) -> ticket string. `now` is REQUIRED (purity). */
function mint(key, kind, scope, opts) {
  const k = KINDS[kind];
  if (!k) throw new Error('unknown ticket kind: ' + kind);
  if (!key) throw new Error('no ticket key');
  const o = opts || {};
  if (!Number.isFinite(o.now)) throw new Error('mint needs opts.now');
  const ttl = Math.min(Number.isFinite(o.ttlMs) ? o.ttlMs : k.maxTtlMs, k.maxTtlMs);
  const exp = Math.floor(o.now + ttl);
  const nonce = o.nonce ? String(o.nonce) : nodeCrypto.randomBytes(16).toString('hex');
  return 'st1.' + exp.toString(36) + '.' + nonce + '.' + macOf(key, k.method, scope, exp, nonce);
}

function parse(ticket) {
  const m = /^st1\.([0-9a-z]{1,12})\.([0-9a-f]{16,64})\.([A-Za-z0-9_-]{43})$/.exec(String(ticket || ''));
  if (!m) return null;
  const exp = parseInt(m[1], 36);
  if (!Number.isSafeInteger(exp)) return null;
  return { exp: exp, nonce: m[2], mac: m[3] };
}

/* A single-use registry: nonce -> exp, pruned as entries expire. Bounded so a flood can't grow it without limit
   (when full, the oldest entries go first — they are also the nearest to expiring). */
function replayGuard(limit) {
  const max = Number.isFinite(limit) ? limit : 4096;
  const seen = new Map();
  return {
    // true = first presentation (now recorded); false = replay
    take(nonce, exp, now) {
      for (const [n, e] of seen) { if (e < now) seen.delete(n); else break; }
      if (seen.has(nonce)) return false;
      while (seen.size >= max) seen.delete(seen.keys().next().value);
      seen.set(nonce, exp);
      return true;
    },
    size() { return seen.size; }
  };
}

/* verify(key, ticket, kind, scope, { now, guard? }) -> { ok, reason } */
function verify(key, ticket, kind, scope, opts) {
  const k = KINDS[kind];
  const o = opts || {};
  if (!k || !key) return { ok: false, reason: 'unconfigured' };
  const t = parse(ticket);
  if (!t) return { ok: false, reason: 'malformed' };
  const now = Number(o.now);
  if (!Number.isFinite(now)) return { ok: false, reason: 'no clock' };
  if (t.exp <= now) return { ok: false, reason: 'expired' };
  if (t.exp - now > k.maxTtlMs + SKEW_MS) return { ok: false, reason: 'lifetime over cap' };
  const want = macOf(key, k.method, scope, t.exp, t.nonce);
  let same = false;
  try { same = nodeCrypto.timingSafeEqual(Buffer.from(want), Buffer.from(t.mac)); } catch (_) { same = false; }
  if (!same) return { ok: false, reason: 'bad signature' };
  if (k.once) {
    if (!o.guard) return { ok: false, reason: 'no replay guard' };
    if (!o.guard.take(t.nonce, t.exp, now)) return { ok: false, reason: 'replayed' };
  }
  return { ok: true, reason: '' };
}

// ---- request → (kind, scope, ticket): the verifier derives the scope from the REQUEST, never from the ticket ----
function queryParams(url) {
  const u = String(url || ''); const i = u.indexOf('?');
  try { return new URLSearchParams(i < 0 ? '' : u.slice(i + 1)); } catch (_) { return new URLSearchParams(''); }
}
function pathOf(url) { const u = String(url || ''); const i = u.indexOf('?'); return i < 0 ? u : u.slice(0, i); }

/* The /api/* routes that accept a ?ticket= (each for exactly one method family and one kind). Anything else: null. */
function apiTicketClaim(req) {
  const m = req && req.method;
  const p = pathOf(req && req.url);
  const q = queryParams(req && req.url);
  const ticket = q.get('ticket') || '';
  if ((m === 'GET' || m === 'HEAD') && p === '/api/file') return { kind: 'file', scope: scopeFile(q.get('agent') || 'agent', q.get('path') || ''), ticket };
  if (m === 'GET' && p === '/api/channels/events') return { kind: 'sse', scope: SCOPE_SSE, ticket };
  if (m === 'POST' && p === '/api/save') return { kind: 'save', scope: SCOPE_SAVE, ticket };
  return null;
}

/* /workshop-run/~t/<ticket>/<agentId>/<runId>/<path...> — the ticket rides the PATH (not the query) so a served
   page's RELATIVE assets (./app.js, style.css) inherit it; a '../' out of the run dir lands on a different
   <agent>/<runId> and fails the MAC. Returns { ticket, rest } where rest = '<agentId>/<runId>/<path...>' (raw,
   still percent-encoded), or null when the url has no ticket segment. */
const RUN_PREFIX = '/workshop-run/';
function splitRunTicket(rawPath) {
  const p = String(rawPath || '');
  if (p.indexOf(RUN_PREFIX + '~t/') !== 0) return null;
  const tail = p.slice(RUN_PREFIX.length + 3);
  const slash = tail.indexOf('/');
  if (slash <= 0) return null;
  return { ticket: tail.slice(0, slash), rest: tail.slice(slash + 1) };
}

/* /plugin-ui/~t/<ticket>/<pluginId>/<digest>/<path...> — the run ticket's idea again: the ticket rides the PATH so a
   plugin page's relative assets inherit it, and the verifier derives (id, digest) from the path, never the ticket.
   Returns { ticket, rest } where rest = '<pluginId>/<digest>/<path...>' (raw), or null. */
const PLUGIN_PREFIX = '/plugin-ui/';
function splitPrefixTicket(prefix, rawPath) {
  const p = String(rawPath || '');
  if (p.indexOf(prefix + '~t/') !== 0) return null;
  const tail = p.slice(prefix.length + 3);
  const slash = tail.indexOf('/');
  if (slash <= 0) return null;
  return { ticket: tail.slice(0, slash), rest: tail.slice(slash + 1) };
}
function splitPluginTicket(rawPath) { return splitPrefixTicket(PLUGIN_PREFIX, rawPath); }
/* /view/~t/<ticket>/<agentId>/<dir>/<path...> — the BROWSER window's in-app view of a workspace web page. <dir> is
   ONE percent-encoded segment naming the folder the ticket covers ('~' = the workspace root), so the page's
   relative assets (./style.css, img/a.png) stay under the same ticketed prefix, while a '../' out of the folder
   changes <dir> and fails the MAC. A view url has NO unticketed form. */
const VIEW_PREFIX = '/view/';
function splitViewTicket(rawPath) { return splitPrefixTicket(VIEW_PREFIX, rawPath); }

module.exports = {
  KINDS, SKEW_MS, mint, verify, parse, replayGuard, apiTicketClaim, splitRunTicket, splitViewTicket, splitPluginTicket, splitPrefixTicket,
  scopeFile, scopeRun, scopeView, scopePlugin, scopeDraft, scopeApp, SCOPE_SSE, SCOPE_SAVE, message
};
