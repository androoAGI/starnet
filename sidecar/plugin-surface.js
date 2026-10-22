/* sidecar/plugin-surface.js — what a plugin's WINDOW touches on the sidecar (plugin extensions phase 1, 2026-09-29).

   A plugin screen is the plugin's own HTML, opened inside a real Agent OS window (frontend/app/pluginhost.js). This
   module serves those files and the plugin's private key/value store. It is deliberately the SAME shape as
   /workshop-run/ (the one other place the station runs pages it did not write):

     GET /plugin-ui/~t/<ticket>/<pluginId>/<digest>/<path...>

   · TICKET in the PATH (apitickets kind 'plugin', scope = id + digest): relative assets inherit it; the verifier
     derives the scope from the path, never from the ticket.
   · DIGEST in the PATH, re-proven on every request against the approval (plugins.js approvedRecord): a file is
     served only while the Commander's approval covers the exact bytes on disk. Edit one character and the open
     window's next request is refused with 410 — the edited code is not running until it is approved again.
   · OPAQUE ORIGIN: every response carries `Content-Security-Policy: sandbox allow-scripts …` WITHOUT
     allow-same-origin. The page runs, but it can never read the app's DOM, the injected API token, or call /api/*
     with credentials. Everything it may do to the station goes through the host bridge, where the host names the
     plugin (the page never gets to say which plugin it is).
   · THE KIT: every HTML page is served with starnet-kit.css + starnet-kit.js injected at the top of <head> —
     the glass tokens and components, and the `starnet` bridge. The CSS sits in `@layer starnet`, so anything the
     author writes wins: the kit is the default look, never a cage.

   Pure: fs/path/clock/apitickets/loader are injected; no ambient state beyond what a factory call creates. */
'use strict';
const { note } = require('./failopen.js');   // a failed stream teardown is noted, never silently dropped

const PREFIX = '/plugin-ui/';
const KIT_FILES = Object.freeze({
  '_starnet/kit.css': 'plugin-kit/kit.css',
  '_starnet/kit.js': 'plugin-kit/kit.js',
  '_starnet/vt323.woff2': 'assets/fonts/vt323.woff2'
});
const DIGEST_RX = /^[0-9a-f]{64}$/;
const HTML_RX = /\.html?$/i;

// The frame's sandbox. allow-scripts: plugins are apps. allow-forms: their own forms submit (preventDefault or
// not). allow-popups(+escape): a link opens a real browser tab, not a crippled sandboxed one. allow-downloads: an
// export button works. NEVER allow-same-origin (that single flag would hand the page the station's token) and
// never allow-top-navigation (a plugin must not navigate the station away).
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';

// ONE path rule for plugins (sidecar/plugins.js): no streams (':'), no Windows aliases, no escapes.
const { relPathOk } = require('./plugins.js')._internals;

/* injectKit(html, rel) -> html with the kit's two tags first in <head>. Paths are RELATIVE to the page (one '../'
   per folder it sits in), so they carry the page's own ticket and resolve inside the same approved plugin. */
function injectKit(html, rel) {
  const depth = String(rel || '').split('/').length - 1;
  const up = depth > 0 ? '../'.repeat(depth) : '';
  const tags = '<link rel="stylesheet" href="' + up + '_starnet/kit.css">' +
    '<script src="' + up + '_starnet/kit.js"></script>';
  const s = String(html || '');
  const head = /<head(\s[^>]*)?>/i.exec(s);
  if (head) return s.slice(0, head.index + head[0].length) + tags + s.slice(head.index + head[0].length);
  const htmlTag = /<html(\s[^>]*)?>/i.exec(s);
  if (htmlTag) return s.slice(0, htmlTag.index + htmlTag[0].length) + '<head>' + tags + '</head>' + s.slice(htmlTag.index + htmlTag[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(s);
  if (doctype) return s.slice(0, doctype[0].length) + '<head>' + tags + '</head>' + s.slice(doctype[0].length);
  return '<head>' + tags + '</head>' + s;
}

/* makePluginUiServer({ fs, fsp, path, frontendDir, loader, apitickets, apiKey, tokenOk, mime, frameAncestors, now })
   -> async handler(req, res). tokenOk(req) lets a header-authenticated fetch (tests, QA) read without a ticket. */
function makePluginUiServer(deps) {
  const { fs, fsp, path: P, frontendDir, loader, apitickets, mime } = deps;
  const apiKey = deps.apiKey;
  const tokenOk = typeof deps.tokenOk === 'function' ? deps.tokenOk : () => false;
  if (typeof deps.now !== 'function') throw new Error('plugin ui server requires an injected clock { now }');
  const now = deps.now;
  const ancestors = typeof deps.frameAncestors === 'function' ? deps.frameAncestors : () => deps.frameAncestors || "'self'";
  // The same server serves a plugin DRAFT's preview (/plugin-draft/, phase 4): a different prefix, ticket scope and
  // record resolver (the draft folder's live digest), the same sandbox, kit and jail.
  const prefix = deps.prefix || PREFIX;
  const scopeFor = typeof deps.scopeFor === 'function' ? deps.scopeFor : (id, digest) => apitickets.scopePlugin(id, digest);
  const resolve = typeof deps.resolve === 'function' ? deps.resolve : (id) => loader.approvedRecord(id);
  const goneMsg = deps.goneMessage || 'this plugin was changed or turned off — approve it again in ABILITIES → EXTENSIONS';
  // A DRAFT is locked down harder than an installed plugin (deps.sandbox / deps.extraCsp): its code was written by an
  // agent and never approved, so its page may draw and run but never reach the network, post a form or open a popup
  // — a preview must not be a way to send what the agent read to someone else.
  const sandbox = deps.sandbox || SANDBOX;
  const extraCsp = typeof deps.extraCsp === 'function' ? deps.extraCsp : () => '';

  // A refusal lands INSIDE a station window: a tiny dark page that says why, never a white browser text page.
  function fail(res, code, msg) {
    const body = '<!doctype html><meta charset="utf-8"><style>html{background:transparent;color-scheme:dark}' +
      'body{margin:0;padding:16px;color:#eec88f;font:17px/1.35 "VT323",ui-monospace,monospace;letter-spacing:.4px}</style>' +
      '<p>' + String(msg).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]) + '</p>';
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors " + ancestors() });
    res.end(body);
  }

  return async function servePluginUi(req, res) {
    const reqPath = String(req.url || '').split('?')[0];
    const ticketed = apitickets.splitPrefixTicket(prefix, reqPath);
    if (!ticketed && !tokenOk(req)) return fail(res, 403, 'forbidden token');
    const tail = ticketed ? ticketed.rest : reqPath.slice(prefix.length);
    const parts = tail.split('/');
    if (parts.length < 3) return fail(res, 404, 'not found');
    let id, digest, rel;
    try {
      id = decodeURIComponent(parts[0]);
      digest = decodeURIComponent(parts[1]);
      rel = parts.slice(2).map(decodeURIComponent).join('/');
    } catch (_) { return fail(res, 400, 'bad path'); }
    if (!DIGEST_RX.test(digest)) return fail(res, 404, 'not found');
    if (ticketed) {
      const v = apitickets.verify(apiKey, ticketed.ticket, 'plugin', scopeFor(id, digest), { now: now() });
      if (!v.ok) return fail(res, 403, 'forbidden ticket');
    }
    // THE APPROVAL IS RE-PROVEN HERE, per request (rate-limited in the loader). A plugin that was turned off,
    // deleted, or edited since approval is gone — 410 tells the window to say so instead of showing stale code.
    let rec = null;
    try { rec = await resolve(id); } catch (_) { rec = null; }
    if (!rec || rec.digest !== digest) return fail(res, 410, goneMsg);

    let abs;
    const kit = Object.prototype.hasOwnProperty.call(KIT_FILES, rel) ? KIT_FILES[rel] : null;
    if (kit) abs = P.join(frontendDir, kit);
    else {
      if (!relPathOk(rel)) return fail(res, 403, 'forbidden');
      abs = P.join(rec.dir, rel);
      const back = P.relative(rec.dir, abs);
      if (!back || back.split(P.sep)[0] === '..' || P.isAbsolute(back)) return fail(res, 403, 'forbidden');
    }
    let st;
    try { st = await fsp.lstat(abs); } catch (_) { return fail(res, 404, 'not found'); }
    if (st.isSymbolicLink() || !st.isFile()) return fail(res, 404, 'not found');
    // A junction swapped into a FOLDER along the path (lstat sees only the last segment) must not serve a file from
    // outside the plugin: the real path of what we are about to read has to sit inside the real plugin folder.
    if (!kit) {
      let real, root;
      try { real = await fsp.realpath(abs); root = await fsp.realpath(rec.dir); } catch (_) { return fail(res, 404, 'not found'); }
      const back = P.relative(root, real);
      if (!back || back.split(P.sep)[0] === '..' || P.isAbsolute(back)) return fail(res, 403, 'forbidden');
    }
    const ext = P.extname(abs).toLowerCase();
    const headers = {
      'Content-Type': (ext === '.mjs' ? 'text/javascript; charset=utf-8' : (mime[ext] || 'application/octet-stream')),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': sandbox + extraCsp() + '; frame-ancestors ' + ancestors(),
      // The page is an opaque origin, so its own module scripts / fetch('./data.json') are cross-origin reads of
      // these very files. They are the plugin's approved static files, reachable only with a ticket for them.
      'Access-Control-Allow-Origin': '*',
      'Referrer-Policy': 'no-referrer'
    };
    if (!kit && HTML_RX.test(rel)) {
      let html;
      try { html = await fsp.readFile(abs, 'utf8'); } catch (_) { return fail(res, 404, 'not found'); }
      const out = Buffer.from(injectKit(html, rel), 'utf8');
      headers['Content-Length'] = out.length;
      res.writeHead(200, headers);
      return res.end(req.method === 'HEAD' ? undefined : out);
    }
    if (req.method === 'HEAD') { headers['Content-Length'] = st.size; res.writeHead(200, headers); return res.end(); }
    res.writeHead(200, headers);
    const stream = fs.createReadStream(abs);
    stream.on('error', () => { try { res.destroy(); } catch (e) { note('plugins.ui.stream-destroy', e); } });
    req.on('close', () => { try { stream.destroy(); } catch (e) { note('plugins.ui.req-close', e); } });
    stream.pipe(res);
  };
}

/* ---- the plugin's private store ------------------------------------------------------------------------------
   One JSON object per plugin (<workspaces>/plugin-data/<id>.json) through the station's durable store (fsync,
   .bak recovery, per-key lock). Reached only through the host bridge, which names the plugin itself. Bounded so a
   runaway plugin cannot fill the disk through the station. */
const STORE_KEY_RX = /^[A-Za-z0-9_.:-]{1,128}$/;
const STORE_MAX_VALUE = 256 * 1024;
const STORE_MAX_TOTAL = 4 * 1024 * 1024;
const STORE_MAX_KEYS = 1000;

function makePluginStore(deps) {
  const store = deps.store;   // makeDurableJsonStore keyed by plugin id
  async function op(id, verb, key, value) {
    if (verb === 'clear') { store.set(id, {}); return { ok: true, value: null }; }   // the owner (an app/plugin) is being deleted
    if (verb === 'keys') {
      const cur = store.get(id);
      return { ok: true, value: cur && typeof cur === 'object' ? Object.keys(cur) : [] };
    }
    if (!STORE_KEY_RX.test(String(key || ''))) return { ok: false, error: 'a store key is 1-128 letters, numbers, _ . : or -' };
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return { ok: false, error: 'that store key name is reserved' };
    if (verb === 'get') {
      const cur = store.get(id);
      const v = cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, key) ? cur[key] : null;
      return { ok: true, value: v };
    }
    if (verb === 'set') {
      let text;
      try { text = JSON.stringify(value === undefined ? null : value); } catch (_) { return { ok: false, error: 'that value cannot be stored (not JSON)' }; }
      if (text.length > STORE_MAX_VALUE) return { ok: false, error: 'that value is over 256 KB' };
      let err = null;
      await store.update(id, (cur) => {
        const next = Object.assign(Object.create(null), cur && typeof cur === 'object' ? cur : {});
        if (!Object.prototype.hasOwnProperty.call(next, key) && Object.keys(next).length >= STORE_MAX_KEYS) { err = 'this plugin already stores ' + STORE_MAX_KEYS + ' keys'; return undefined; }
        next[key] = JSON.parse(text);
        if (JSON.stringify(next).length > STORE_MAX_TOTAL) { err = 'this plugin\'s store would pass 4 MB'; return undefined; }
        return Object.assign({}, next);
      });
      return err ? { ok: false, error: err } : { ok: true, value: null };
    }
    if (verb === 'delete') {
      await store.update(id, (cur) => {
        if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
        const next = Object.assign({}, cur); delete next[key]; return next;
      });
      return { ok: true, value: null };
    }
    return { ok: false, error: 'unknown store operation' };
  }
  return { op };
}

module.exports = { makePluginUiServer, makePluginStore, injectKit, relPathOk, KIT_FILES, SANDBOX, PREFIX };
