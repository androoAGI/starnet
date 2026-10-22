#!/usr/bin/env node
/* sidecar/mcp/serve.js — the Agent OS MCP messaging-bridge server (stdio composition root).

   Launched by an MCP client to OBSERVE and MESSAGE a running Agent OS station:
     { "mcpServers": { "starnet": { "command": "npm", "args": ["run", "-s", "mcp:serve"] } } }

   This is the ambient I/O edge for the pure core in bridge-core.js. It:
     - speaks newline-delimited JSON-RPC 2.0 on stdin/stdout, logging ONLY to stderr;
     - proxies every tool over loopback HTTP to the RUNNING sidecar (default 127.0.0.1:8787) with the
       per-launch API token on the x-starnet-token header — it never reads/writes store files itself
       (one sidecar owner per workspace is a hard invariant);
     - discovers the token out-of-band the same way the browser does: GET / and scrape
       window.__STARNET_API_TOKEN__ (also honors STARNET_TOKEN / STARNET_API_TOKEN / SKYNET_API_TOKEN
       env and --token= / --port= / --host= flags);
     - subscribes to the sidecar's SSE feed (GET /api/channels/events, token on the x-starnet-token header — a Node
       client can set headers, and the sidecar refuses the master token in a URL) to fill the event queue.

   The server itself always boots and lists tools even when the sidecar is down; tools then return a
   structured "start Agent OS" error (truthful telemetry). */
'use strict';

const http = require('http');
const core = require('./bridge-core.js');

// ---- config: flags win over env; env over defaults --------------------------------------------
function readConfig(argv, env) {
  const cfg = { host: '127.0.0.1', port: 8787, token: '' };
  const envPort = env.STARNET_PORT || env.SKYNET_PORT;
  if (envPort && /^\d+$/.test(String(envPort))) cfg.port = Number(envPort);
  const envHost = env.STARNET_HOST || env.SKYNET_HOST;
  if (envHost) cfg.host = String(envHost);
  cfg.token = String(env.STARNET_TOKEN || env.STARNET_API_TOKEN || env.SKYNET_API_TOKEN || '');
  for (const a of (argv || [])) {
    let m;
    if ((m = /^--port=(\d+)$/.exec(a))) cfg.port = Number(m[1]);
    else if ((m = /^--host=(.+)$/.exec(a))) cfg.host = m[1];
    else if ((m = /^--token=(.*)$/.exec(a))) cfg.token = m[1];
  }
  return cfg;
}

const CFG = readConfig(process.argv.slice(2), process.env);
const BASE_LABEL = 'http://' + CFG.host + ':' + CFG.port;

function log() { try { process.stderr.write('[mcp:serve] ' + Array.prototype.join.call(arguments, ' ') + '\n'); } catch (_) {} }

// ---- token discovery: explicit wins; else scrape the served page once (browser-identical) ------
// ⛔ THE STATION'S API TOKEN IS PER-LAUNCH, SO A SCRAPED ONE GOES STALE. Agent OS is a desktop app: the
// Commander closes and reopens it constantly, and every launch mints a NEW token. This bridge is started once
// by the MCP client and lives for that client's whole session, so a token cached for the process lifetime meant
// the FIRST station restart killed every tool ("/api/... returned HTTP 401") and the SSE feed (a silent
// reconnect loop re-presenting the same dead token) until the user knew to restart their MCP client — which
// nothing on either side tells them to do. An explicitly supplied token (--token= / env) is the operator's
// choice and is never invalidated: re-scraping would silently override what they configured.
const TOKEN_IS_EXPLICIT = !!CFG.token;
let cachedToken = CFG.token || '';
let tokenPromise = null;
// Drop a scraped token that the station has stopped honouring, so the next call re-scrapes the live one.
function invalidateToken(why) {
  if (TOKEN_IS_EXPLICIT || !cachedToken) return false;
  log('token rejected (' + why + ') — re-discovering; the station was probably restarted');
  cachedToken = '';
  return true;
}
function discoverToken() {
  if (cachedToken) return Promise.resolve(cachedToken);
  if (tokenPromise) return tokenPromise;
  tokenPromise = rawRequest('GET', '/', null, /* withToken */ false).then(res => {
    tokenPromise = null;
    if (res.ok && res.status === 200 && typeof res.text === 'string') {
      const m = res.text.match(/window\.__STARNET_API_TOKEN__=("(?:\\.|[^"])*")/);
      if (m) { try { cachedToken = String(JSON.parse(m[1]) || ''); } catch (_) {} }
    }
    return cachedToken;
  }).catch(() => { tokenPromise = null; return cachedToken; });
  return tokenPromise;
}

// ---- low-level loopback request (no token) -----------------------------------------------------
function rawRequest(method, path, body, withToken, token) {
  return new Promise(resolve => {
    let payload = null;
    const headers = { 'Origin': BASE_LABEL, 'Accept': 'application/json, text/plain, */*' };
    if (withToken && token) headers['x-starnet-token'] = token;
    if (body != null) { payload = Buffer.from(JSON.stringify(body), 'utf8'); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    let req;
    try {
      req = http.request({ host: CFG.host, port: CFG.port, method: method, path: path, headers: headers }, res => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          const ct = String(res.headers['content-type'] || '');
          if (ct.indexOf('application/json') >= 0) { try { json = JSON.parse(text || 'null'); } catch (_) { json = null; } }
          else { try { json = JSON.parse(text); } catch (_) { json = null; } }   // best-effort parse for handlers that omit the header
          resolve({ ok: true, status: res.statusCode, json: json, text: text });
        });
      });
    } catch (e) { return resolve({ ok: false, error: (e && e.message) || String(e) }); }
    req.on('error', e => resolve({ ok: false, error: (e && e.message) || String(e) }));
    req.setTimeout(30000, () => { try { req.destroy(new Error('request timed out')); } catch (_) {} });
    if (payload != null) req.write(payload);
    req.end();
  });
}

// ---- the injected callSidecar the core proxies through -----------------------------------------
async function callSidecar(method, path, body) {
  const token = await discoverToken();
  const res = await rawRequest(method, path, body == null ? null : body, true, token);
  // ONE re-auth retry on a rejected token: the station restarted and minted a new one (see invalidateToken).
  // Bounded to a single extra round-trip, and only when the token was scraped and actually changed — a genuine
  // 401 (no token available at all) still surfaces to the caller as the honest HTTP status it is.
  if (res && res.ok && (res.status === 401 || res.status === 403) && invalidateToken('HTTP ' + res.status)) {
    const fresh = await discoverToken();
    if (fresh && fresh !== token) {
      try { if (sseActive) { sseActive = false; } } catch (_) {}   // let the feed reconnect with the live token
      startSse().catch(() => {});
      return await rawRequest(method, path, body == null ? null : body, true, fresh);
    }
  }
  return res;   // { ok, status, json, text } | { ok:false, error }
}

// ---- the SSE subscription that fills the event queue -------------------------------------------
const queue = core.makeEventQueue({ cap: 1000 });
let sseActive = false;
let sseReconnectTimer = null;

async function startSse() {
  if (sseActive) return;
  const token = await discoverToken();
  if (!token) { scheduleSseReconnect(); return; }         // sidecar likely down — retry later
  sseActive = true;
  let buf = '';
  let req;
  const path = '/api/channels/events';
  try {
    req = http.request({ host: CFG.host, port: CFG.port, method: 'GET', path: path, headers: { 'Origin': BASE_LABEL, 'Accept': 'text/event-stream', 'x-starnet-token': token } }, res => {
      // A 401/403 here means the token this feed presented is dead (station restarted): drop it so the reconnect
      // re-scrapes, instead of re-presenting the same rejected token every 3s forever.
      if (res.statusCode !== 200) { log('SSE feed status', res.statusCode); if (res.statusCode === 401 || res.statusCode === 403) invalidateToken('SSE ' + res.statusCode); res.resume(); sseActive = false; scheduleSseReconnect(); return; }
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line || line[0] === ':') continue;               // blank / SSE comment
          if (line.indexOf('data:') === 0) {
            const raw = line.slice(5).trim();
            if (!raw) continue;
            let obj = null; try { obj = JSON.parse(raw); } catch (_) { continue; }
            if (obj && obj.name) { try { queue.push(obj.name, obj.payload); } catch (_) {} }
          }
        }
      });
      const drop = () => { if (sseActive) { sseActive = false; scheduleSseReconnect(); } };
      res.on('end', drop); res.on('close', drop); res.on('error', drop);
    });
  } catch (e) { log('SSE connect threw', (e && e.message) || e); sseActive = false; scheduleSseReconnect(); return; }
  req.on('error', e => { log('SSE request error', (e && e.message) || e); sseActive = false; scheduleSseReconnect(); });
  req.end();
}
function scheduleSseReconnect() {
  if (sseReconnectTimer) return;
  sseReconnectTimer = setTimeout(() => { sseReconnectTimer = null; startSse().catch(() => {}); }, 3000);
  if (sseReconnectTimer && typeof sseReconnectTimer.unref === 'function') sseReconnectTimer.unref();
}

// ---- the bridge + stdio JSON-RPC loop ----------------------------------------------------------
const bridge = core.makeBridge({ callSidecar: callSidecar, queue: queue, baseLabel: BASE_LABEL });

function writeMessage(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (e) { log('stdout write failed', (e && e.message) || e); }
}

let inbuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  inbuf += chunk;
  let nl;
  while ((nl = inbuf.indexOf('\n')) >= 0) {
    const line = inbuf.slice(0, nl).replace(/\r$/, '');
    inbuf = inbuf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg = null;
    try { msg = JSON.parse(line); }
    catch (_) { writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    // dispatch async; JSON-RPC responses are id-correlated so ordering across concurrent calls is safe.
    Promise.resolve().then(() => bridge.handleRpc(msg)).then(resp => {
      if (resp) writeMessage(resp);
      // once the client has initialized, warm the token + SSE feed so events flow (non-blocking, never fatal).
      if (msg && msg.method === 'initialize') startSse().catch(() => {});
    }).catch(e => {
      log('handleRpc threw', (e && e.stack) || e);
      if (msg && msg.id != null) writeMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'internal error' } });
    });
  }
});
process.stdin.on('end', () => { process.exit(0); });
process.stdin.on('close', () => { process.exit(0); });

log('Agent OS MCP bridge ready on stdio → proxying ' + BASE_LABEL + (cachedToken ? ' (token from env/flag)' : ' (token via page scrape)'));

module.exports = { readConfig, _internals: { discoverToken, callSidecar, queue } };
