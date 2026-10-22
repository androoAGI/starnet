/* frontend/app/apiticket.js — mint SCOPED, SHORT-LIVED URL tickets so the MASTER API token never rides a URL.
   The wire format, scopes and lifetimes are defined (and verified) by sidecar/apitickets.js; read its header first.

   Surfaces that cannot attach the X-Agent OS-Token header — a link/tab open of a workspace file, a workshop tool
   opened in a tab, the SSE bridge (EventSource) and the unload save beacon — get a ticket that names exactly ONE
   resource and dies within minutes. Every fetch() keeps the header (harness.js); nothing here replaces it.

   Minting is SYNCHRONOUS on purpose (a pure-JS HMAC-SHA256 below — WebCrypto is promise-only): an href must be
   right at click time, a beacon fires inside pagehide, and a tab opened after an await is popup-blocked. The key is
   the per-launch token the page already holds; test/apitickets.test.js proves this file mints byte-identical
   tickets to the Node verifier. */
(function (root) {
  'use strict';
  const DOMAIN = 'starnet-ticket-v1';
  const KINDS = { file: { method: 'GET', ttl: 5 * 60 * 1000 }, run: { method: 'GET', ttl: 10 * 60 * 1000 },
    view: { method: 'GET', ttl: 10 * 60 * 1000 },
    sse: { method: 'GET', ttl: 2 * 60 * 1000 }, save: { method: 'POST', ttl: 2 * 60 * 1000 },
    plugin: { method: 'GET', ttl: 12 * 60 * 60 * 1000 } };

  // ---- SHA-256 / HMAC (FIPS 180-4 / RFC 2104), bytes in, bytes out ----
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(bytes) {
    const len = bytes.length, bitLenHi = Math.floor(len / 0x20000000), bitLenLo = (len << 3) >>> 0;
    const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(bytes); padded[len] = 0x80;
    const n = padded.length;
    padded[n - 8] = (bitLenHi >>> 24) & 255; padded[n - 7] = (bitLenHi >>> 16) & 255; padded[n - 6] = (bitLenHi >>> 8) & 255; padded[n - 5] = bitLenHi & 255;
    padded[n - 4] = (bitLenLo >>> 24) & 255; padded[n - 3] = (bitLenLo >>> 16) & 255; padded[n - 2] = (bitLenLo >>> 8) & 255; padded[n - 1] = bitLenLo & 255;
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    for (let off = 0; off < n; off += 64) {
      for (let i = 0; i < 16; i++) { const j = off + i * 4; W[i] = (padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]; }
      for (let i = 16; i < 64; i++) {
        const a = W[i - 15], b = W[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) { out[i * 4] = H[i] >>> 24; out[i * 4 + 1] = (H[i] >>> 16) & 255; out[i * 4 + 2] = (H[i] >>> 8) & 255; out[i * 4 + 3] = H[i] & 255; }
    return out;
  }
  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(s));
    const b = unescape(encodeURIComponent(String(s))), out = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }
  function hmacSha256(keyBytes, msgBytes) {
    let key = keyBytes.length > 64 ? sha256(keyBytes) : keyBytes;
    const k = new Uint8Array(64); k.set(key);
    const inner = new Uint8Array(64 + msgBytes.length), outer = new Uint8Array(64 + 32);
    for (let i = 0; i < 64; i++) { inner[i] = k[i] ^ 0x36; outer[i] = k[i] ^ 0x5c; }
    inner.set(msgBytes, 64);
    outer.set(sha256(inner), 64);
    return sha256(outer);
  }
  function b64url(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomHex(n) {
    const b = new Uint8Array(n);
    const c = root && (root.crypto || root.msCrypto);
    if (!c || !c.getRandomValues) throw new Error('no CSPRNG for ticket nonce');
    c.getRandomValues(b);
    let s = ''; for (let i = 0; i < n; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }

  // ---- ticket mint (mirrors sidecar/apitickets.js mint) ----
  const scopeFile = (agent, relPath) => 'file\n' + String(agent || 'agent') + '\n' + String(relPath || '');
  const scopeRun = (agent, runId) => 'run\n' + String(agent || '') + '\n' + String(runId || '');
  const scopeView = (agent, dir) => 'view\n' + String(agent || '') + '\n' + String(dir || '');
  const scopePlugin = (id, digest) => 'plugin\n' + String(id || '') + '\n' + String(digest || '');
  const scopeDraft = (id, digest) => 'draft\n' + String(id || '') + '\n' + String(digest || '');
  const scopeApp = (id, digest) => 'app\n' + String(id || '') + '\n' + String(digest || '');
  const SCOPE_SSE = 'sse\n/api/channels/events', SCOPE_SAVE = 'save\n/api/save';
  function mintWith(key, kind, scope, now, nonce) {
    const k = KINDS[kind];
    if (!k || !key) return '';
    const exp = Math.floor(now + k.ttl);
    const msg = DOMAIN + '\n' + k.method + '\n' + scope + '\n' + exp + '\n' + nonce;
    return 'st1.' + exp.toString(36) + '.' + nonce + '.' + b64url(hmacSha256(utf8(key), utf8(msg)));
  }
  function key() { try { return (root && root.__STARNET_API_TOKEN__) ? String(root.__STARNET_API_TOKEN__) : ''; } catch (_) { return ''; } }
  function base() { try { return (root && root.__STARNET_API__) ? String(root.__STARNET_API__) : ''; } catch (_) { return ''; } }
  function mint(kind, scope) { const k = key(); if (!k) return ''; try { return mintWith(k, kind, scope, Date.now(), randomHex(16)); } catch (_) { return ''; } }

  // ---- URL builders: every one returns a URL that carries NO master token ----
  // Desktop: the page runs on the Tauri origin and only window.fetch is rewritten to the sidecar, so a URL a
  // native load/tab/beacon uses must carry the absolute loopback base (window.__STARNET_API__); browser: ''.
  function fileUrl(agentId, relPath) {
    const agent = agentId || 'agent', p = String(relPath || '');
    const t = mint('file', scopeFile(agent, p));
    return base() + '/api/file?agent=' + encodeURIComponent(agent) + '&path=' + encodeURIComponent(p) + (t ? '&ticket=' + encodeURIComponent(t) : '');
  }
  function runUrl(agentId, runId, relPath) {
    const agent = agentId || 'agent', rid = String(runId || '');
    const t = mint('run', scopeRun(agent, rid));
    if (!t) return '';
    const parts = String(relPath || '').split('/').map(encodeURIComponent).join('/');
    return base() + '/workshop-run/~t/' + t + '/' + encodeURIComponent(agent) + '/' + encodeURIComponent(rid) + '/' + parts;
  }
  // The BROWSER window's in-app view of a workspace web page: the ticket covers the page's FOLDER (so its relative
  // assets load) and the folder rides the path as ONE encoded segment ('~' = the workspace root). See
  // sidecar/apitickets.js splitViewTicket.
  function viewUrl(agentId, relPath) {
    const agent = agentId || 'agent';
    if (/[\\/]$/.test(String(relPath || ''))) return '';   // a folder is never a page
    const parts = String(relPath || '').replace(/\\/g, '/').split('/').filter(s => s && s !== '.');
    const file = parts.pop() || '';
    const dir = parts.join('/');
    const t = mint('view', scopeView(agent, dir));
    if (!t || !file) return '';
    return base() + '/view/~t/' + t + '/' + encodeURIComponent(agent) + '/' + (dir ? encodeURIComponent(dir) : '~') + '/' + encodeURIComponent(file);
  }
  // A plugin window's iframe URL: ONE approved plugin at ONE code digest (the sidecar's /plugin-ui/ route).
  function pluginUrl(id, digest, relPath) {
    const pid = String(id || ''), dg = String(digest || '');
    const t = mint('plugin', scopePlugin(pid, dg));
    if (!t) return '';
    const parts = String(relPath || '').split('/').map(encodeURIComponent).join('/');
    return base() + '/plugin-ui/~t/' + t + '/' + encodeURIComponent(pid) + '/' + encodeURIComponent(dg) + '/' + parts;
  }
  // A plugin DRAFT's preview window (the sidecar's /plugin-draft/ route): a draft-scoped ticket at the draft's digest.
  function draftUrl(id, digest, relPath) {
    const pid = String(id || ''), dg = String(digest || '');
    const t = mint('plugin', scopeDraft(pid, dg));
    if (!t) return '';
    const parts = String(relPath || '').split('/').map(encodeURIComponent).join('/');
    return base() + '/plugin-draft/~t/' + t + '/' + encodeURIComponent(pid) + '/' + encodeURIComponent(dg) + '/' + parts;
  }
  // An APP's window (the sidecar's /app-ui/ route): an app-scoped ticket at the app's current digest.
  function appUrl(id, digest, relPath) {
    const pid = String(id || ''), dg = String(digest || '');
    const t = mint('plugin', scopeApp(pid, dg));
    if (!t) return '';
    const parts = String(relPath || '').split('/').map(encodeURIComponent).join('/');
    return base() + '/app-ui/~t/' + t + '/' + encodeURIComponent(pid) + '/' + encodeURIComponent(dg) + '/' + parts;
  }
  function sseUrl(query) {
    const t = mint('sse', SCOPE_SSE);
    const q = String(query || '');
    return base() + '/api/channels/events?' + (q ? q + '&' : '') + (t ? 'ticket=' + encodeURIComponent(t) : '');
  }
  function saveBeaconUrl() {
    const t = mint('save', SCOPE_SAVE);
    return base() + '/api/save' + (t ? '?ticket=' + encodeURIComponent(t) : '');
  }
  /* sign(url): turn a SERVER-built open URL (a deliverable's openUrl: '/api/file?agent=&path=' or
     '/workshop-run/<agent>/<runId>/<path>') into a ticketed, absolute-on-desktop URL. Any other URL comes back
     unchanged (never guess a scope). A stray legacy ?token= is stripped — it must never ride a URL again. */
  function sign(url) {
    const raw = String(url || '');
    if (!raw || raw.charAt(0) !== '/') return raw;
    let u;
    try { u = new URL(raw, 'http://127.0.0.1'); } catch (_) { return raw; }
    u.searchParams.delete('token');
    // a project-scoped file keeps its project (the server resolves the path inside it; the ticket scope is agent+path)
    if (u.pathname === '/api/file') { const project = u.searchParams.get('project'); return fileUrl(u.searchParams.get('agent') || 'agent', u.searchParams.get('path') || '') + (project ? '&project=' + encodeURIComponent(project) : ''); }
    const m = /^\/workshop-run\/([^/]+)\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (m && m[1] !== '~t') {
      let agent, rid, rel;
      try { agent = decodeURIComponent(m[1]); rid = decodeURIComponent(m[2]); rel = m[3].split('/').map(decodeURIComponent).join('/'); } catch (_) { return raw; }
      return runUrl(agent, rid, rel);
    }
    return base() + u.pathname + u.search;
  }

  // Reuse the byte-tested digest for content verification when WebCrypto is unavailable.
  const sha256Text = text => Array.from(sha256(utf8(String(text))), b => b.toString(16).padStart(2, '0')).join('');

  const api = { fileUrl, runUrl, viewUrl, pluginUrl, draftUrl, appUrl, sseUrl, saveBeaconUrl, sign, mint, sha256Text,
    _test: { sha256, hmacSha256, utf8, b64url, mintWith, scopeFile, scopeRun, scopeView, scopePlugin, scopeDraft, scopeApp, SCOPE_SSE, SCOPE_SAVE, KINDS } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ApiTicket = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
