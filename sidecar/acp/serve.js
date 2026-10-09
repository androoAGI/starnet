#!/usr/bin/env node
/* sidecar/acp/serve.js — StarNet's ACP (Agent Client Protocol) agent: the stdio composition root.

   This is what makes StarNet reachable FROM AN EDITOR. An ACP client (Zed, Neovim, any ACP-speaking editor)
   spawns this process and talks JSON-RPC 2.0 over stdin/stdout; it drives real StarNet agent runs against the
   running station, streams the answer and every tool call back into the editor's UI, and hands the station's
   consent prompts to the editor as native approve/reject cards.

   Register it with the client, e.g.:
     { "agent_servers": { "StarNet": { "command": "npm", "args": ["run", "-s", "acp:serve"] } } }
   (or `node sidecar/acp/serve.js`, with --port=/--host=/--token= or STARNET_PORT/STARNET_TOKEN.)

   ── THE SHAPE (identical to sidecar/mcp/serve.js on purpose) ─────────────────────────────────────────────────
   Ambient I/O lives HERE; every decision lives in the pure core (./core.js). This file:
     - speaks newline-delimited JSON-RPC on stdin/stdout, logging ONLY to stderr (stdout is the protocol);
     - proxies to the RUNNING sidecar over loopback HTTP with the per-launch API token, discovered the same way
       the browser does (GET / and scrape window.__STARNET_API_TOKEN__), honouring STARNET_TOKEN and --token=;
     - streams POST /api/run's NDJSON and feeds each event to the core;
     - correlates the core's OUTBOUND requests (session/request_permission) with the client's responses.

   ONE SIDECAR OWNER PER WORKSPACE is a hard invariant, so nothing here reads or writes a store file. If the
   station is not running, every method answers with a structured "start StarNet" error — never a fabricated one.

   ── WHY IT RIDES /api/run AND NOT /v1 ───────────────────────────────────────────────────────────────────────
   The OpenAI-compatible surface (/v1) can run an agent, but its wire only carries text: an editor integration
   lives or dies on the live tool-call list and the mid-run permission card, and those are events. /api/run
   streams the real thing (agent.tool_call / agent.tool_result / permission.prompt / agent.run.end), and it is
   fenced by the token this process already holds — so ACP adds no new auth surface and no new RCE reachability.

   ── CAPABILITIES AN EDITOR SESSION GETS ─────────────────────────────────────────────────────────────────────
   A coding session is granted the coding office: computer, cabinet (files), workbench (shell + verify), dish
   (web/browser), notebook (memory). Every mutation still walks the station's full consent ladder — which is
   exactly what surfaces in the editor as an approve/reject card. The session's cwd rides as `projectRoot`, so
   the station's folder-trust prompt asks the editor to bless the folder the first time a file tool touches it. */
'use strict';

const http = require('http');
const nodeCrypto = require('node:crypto');
const core = require('./core.js');

// ---- config: flags win over env; env over defaults ---------------------------------------------
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

// stderr ONLY. A single byte of logging on stdout corrupts the protocol stream and the editor drops the agent.
function log() { try { process.stderr.write('[acp] ' + Array.prototype.join.call(arguments, ' ') + '\n'); } catch (_) {} }

// ---- token discovery: explicit wins; else scrape the served page once (browser-identical) ------
// ⛔ THE STATION'S API TOKEN IS PER-LAUNCH, SO A SCRAPED ONE GOES STALE (same defect as sidecar/mcp/serve.js).
// An editor spawns this agent once and keeps it for the whole editing session, while StarNet is a desktop app the
// Commander closes and reopens — every launch mints a NEW token. A token cached for the process lifetime meant the
// first station restart broke every prompt until the editor itself was restarted. An EXPLICIT token (--token= /
// env) is the operator's choice and is never invalidated.
const TOKEN_IS_EXPLICIT = !!CFG.token;
let cachedToken = CFG.token || '';
let tokenPromise = null;
function invalidateToken(why) {
  if (TOKEN_IS_EXPLICIT || !cachedToken) return false;
  log('token rejected (' + why + ') — re-discovering; the station was probably restarted');
  cachedToken = '';
  return true;
}
function discoverToken() {
  if (cachedToken) return Promise.resolve(cachedToken);
  if (tokenPromise) return tokenPromise;
  tokenPromise = rawRequest('GET', '/', null, false, '').then(res => {
    tokenPromise = null;
    if (res.ok && res.status === 200 && typeof res.text === 'string') {
      const m = res.text.match(/window\.__STARNET_API_TOKEN__=("(?:\\.|[^"])*")/);
      if (m) { try { cachedToken = String(JSON.parse(m[1]) || ''); } catch (_) {} }
    }
    return cachedToken;
  }).catch(() => { tokenPromise = null; return cachedToken; });
  return tokenPromise;
}

// ---- low-level loopback request ----------------------------------------------------------------
function rawRequest(method, path, body, withToken, token) {
  return new Promise(resolve => {
    let payload = null;
    const headers = { 'Origin': BASE_LABEL, 'Accept': 'application/json, text/plain, */*' };
    if (withToken && token) headers['x-starnet-token'] = token;
    if (body != null) {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    let req;
    try {
      req = http.request({ host: CFG.host, port: CFG.port, method: method, path: path, headers: headers }, res => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text || 'null'); } catch (_) { json = null; }
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

async function callSidecar(method, path, body) {
  const token = await discoverToken();
  const res = await rawRequest(method, path, body == null ? null : body, true, token);
  // ONE re-auth retry on a rejected token: the station restarted and minted a new one (see invalidateToken).
  if (res && res.ok && (res.status === 401 || res.status === 403) && invalidateToken('HTTP ' + res.status)) {
    const fresh = await discoverToken();
    if (fresh && fresh !== token) return rawRequest(method, path, body == null ? null : body, true, fresh);
  }
  return res;
}

/* ---- openRun: POST /api/run and stream its NDJSON into the core -------------------------------

   /api/run needs an explicit model (the browser always knows which one the Commander picked), so the model +
   provider come from GET /api/runtime/agent — the sidecar's OWN headless resolution, never a guess here. A
   station with no key or no model configured is reported as such rather than producing a bare 400.

   The run is cancellable: `onCancel` hands the core a closure that POSTs /api/cancel, which is what
   session/cancel needs (an ACP client's Esc). */
function openRun(opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    discoverToken().then(async (token) => {
      if (!token) return reject(new Error('StarNet is not running (or its API token could not be read) at ' + BASE_LABEL + ' — start StarNet and try again'));

      let info = await rawRequest('GET', '/api/runtime/agent', null, true, token);
      // A rejected token means the station restarted. Re-scrape the live one and retry ONCE, rather than telling
      // the Commander to restart their editor — closing and reopening StarNet should not cost them that.
      if (info.ok && (info.status === 401 || info.status === 403) && invalidateToken('HTTP ' + info.status)) {
        const fresh = await discoverToken();
        if (fresh && fresh !== token) { token = fresh; info = await rawRequest('GET', '/api/runtime/agent', null, true, token); }
      }
      if (!info.ok) return reject(new Error('StarNet is not reachable at ' + BASE_LABEL + ': ' + (info.error || 'connection failed')));
      if (info.status === 401 || info.status === 403) return reject(new Error('StarNet rejected this bridge\'s API token — restart the editor so it re-reads the station token'));
      const rt = info.json || {};
      if (!rt.configured) {
        return reject(new Error('StarNet has no runnable model configured'
          + (rt.model ? '' : ' (no default model set)')
          + ' — open the station and set a provider key + model first'));
      }

      const body = {
        model: rt.model,
        provider: rt.provider || 'openrouter',
        agentId: 'agent',
        isTask: true,   // an editor prompt is task work: without it /api/run offers the model NO tools (issue #96)
        messages: (o.messages || []).map(m => ({ role: m.role, content: String(m.content == null ? '' : m.content) })),
        // the coding office: files + shell + web + memory, every mutation still consent-gated (which is what
        // the editor renders as an approve/reject card).
        placed: [
          { objectType: 'computer' }, { objectType: 'cabinet' },
          { objectType: 'workbench' }, { objectType: 'dish' }, { objectType: 'notebook' }
        ]
      };
      // the editor's cwd is the project scope. The station injects the folder line only while that root holds a
      // standing path grant, and its folder-trust prompt rides the same permission channel — so the FIRST file
      // tool asks the editor to bless it, and nothing here asserts access the grant layer cannot prove.
      if (o.cwd) body.projectRoot = String(o.cwd);

      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      let req;
      let settled = false;
      const finish = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
      /* PER-RUN state, deliberately closure-local and NOT module-level. `runId` was a module global, which
         means two sessions prompting at once would both write it and a session/cancel could abort the OTHER
         session's run. The core enforces one turn per SESSION, not one turn per process, so this must be
         per-invocation. `cancelRequested` is what keeps a deliberate cancel from being reported as a failure. */
      let runId = '';
      let cancelRequested = false;
      let graceTimer = null;

      try {
        req = http.request({
          host: CFG.host, port: CFG.port, method: 'POST', path: '/api/run',
          headers: {
            'Origin': BASE_LABEL, 'Content-Type': 'application/json',
            'Content-Length': payload.length, 'x-starnet-token': token, 'Accept': 'application/x-ndjson'
          }
        }, res => {
          if (res.statusCode !== 200) {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => finish(reject, new Error('StarNet refused the run (HTTP ' + res.statusCode + '): ' + Buffer.concat(chunks).toString('utf8').slice(0, 300))));
            return;
          }
          res.setEncoding('utf8');
          let buf = '', reason = 'done', sawEnd = false;
          res.on('data', chunk => {
            buf += chunk;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).replace(/\r$/, '');
              buf = buf.slice(nl + 1);
              if (!line.trim()) continue;                      // the hold-open keep-alive blank line
              let ev = null; try { ev = JSON.parse(line); } catch (_) { continue; }
              if (!ev || !ev.name) continue;
              // capture the runId locally — POST /api/cancel needs it, and it must belong to THIS run
              if (ev.name === 'agent.run.start') runId = String((ev.payload && ev.payload.runId) || '');
              if (ev.name === 'agent.run.end') { sawEnd = true; reason = String((ev.payload && ev.payload.reason) || 'done'); }
              if (ev.name === 'agent.run.error') reason = 'error';
              try { if (typeof o.onEvent === 'function') o.onEvent(ev.name, ev.payload); } catch (e) { log('onEvent threw:', (e && e.message) || e); }
            }
          });
          /* A stream that ENDS WITHOUT agent.run.end did not finish. Reporting 'done' there would tell the
             editor the turn completed successfully — the exact class of lie this project forbids.
             But 'error' is equally wrong for a DELIBERATE cancel: it made the core append "the run failed
             inside StarNet — check the station log", so pressing Esc told the user their work had crashed.
             So the fallback splits on intent: cancelled if the user asked, error only if it really dropped. */
          const settleReason = () => (sawEnd ? reason : (cancelRequested ? 'cancelled' : 'error'));
          const done = () => { if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; } finish(resolve, { reason: settleReason() }); };
          res.on('end', done);
          res.on('close', done);
          res.on('error', e => {
            if (cancelRequested) return done();          // our own destroy, not a transport failure
            finish(reject, e instanceof Error ? e : new Error(String(e)));
          });
        });
      } catch (e) { return finish(reject, e instanceof Error ? e : new Error(String(e))); }

      req.on('error', e => {
        // A cancel destroys the socket on purpose; that surfaces here as ECONNRESET/aborted. Treating it as a
        // transport failure is what produced "could not complete this turn: aborted" on a user-requested stop.
        if (cancelRequested) return finish(resolve, { reason: 'cancelled' });
        finish(reject, new Error('StarNet run stream failed: ' + ((e && e.message) || e)));
      });
      if (typeof o.onCancel === 'function') {
        /* GRACEFUL FIRST. POST /api/cancel is the stop the station understands: it aborts the run's controller,
           which emits agent.run.end{reason:'cancelled'} and closes the stream properly — so spend stops AND the
           editor gets the real terminal reason. Destroying the socket immediately (the first cut) raced ahead of
           that every time, so the turn always settled as a failure. The destroy is now only a FALLBACK, in case
           the station never settles; leaving it out entirely would risk a socket held open forever. */
        o.onCancel(() => {
          if (cancelRequested) return;
          cancelRequested = true;
          callSidecar('POST', '/api/cancel', { runId: runId }).catch(() => {});
          graceTimer = setTimeout(() => { graceTimer = null; try { req.destroy(); } catch (_) {} }, CANCEL_GRACE_MS);
          if (typeof graceTimer.unref === 'function') graceTimer.unref();
        });
      }
      req.write(payload);
      req.end();
    }).catch(e => reject(e instanceof Error ? e : new Error(String(e))));
  });
}

/* How long a cancelled run gets to settle itself through POST /api/cancel before the socket is destroyed as a
   fallback. Long enough for the station to abort the loop and emit agent.run.end{reason:'cancelled'} (which is
   what makes the editor show a real cancel), short enough that a wedged stream is not held forever. */
const CANCEL_GRACE_MS = 5000;

// ---- stdio JSON-RPC: framing, outbound requests, and the pending map --------------------------

function writeMessage(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); }
  catch (e) { log('stdout write failed:', (e && e.message) || e); }
}

let outboundId = 0;
const pending = new Map();   // our outbound request id -> { resolve, reject, timer }

/* request(method, params) — an AGENT->CLIENT call (session/request_permission). ACP is bidirectional, so this
   process is both a server and a client on the same pipe: we write a request with our own id and resolve it
   when a response carrying that id comes back on stdin.

   Bounded by a timeout that REJECTS: the core treats a rejected permission request as a deny (fail-closed), so
   a client that never answers cannot hold a billable run open forever. */
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = 'acp_req_' + (++outboundId);
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(method + ' timed out'));
    }, 10 * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    pending.set(id, { resolve, reject, timer });
    writeMessage({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
  });
}

function notify(method, params) {
  writeMessage({ jsonrpc: '2.0', method: method, params: params || {} });
}

const agent = core.makeAcpCore({
  callSidecar: callSidecar,
  // openRun captures its own runId off agent.run.start (closure-local, so concurrent sessions cannot cancel
  // each other's run) — the core needs no wrapper here.
  openRun: openRun,
  notify: notify,
  request: request,
  // crypto.randomUUID, not Math.random/Date.now: the determinism lint scans all of sidecar/ and exempts only
  // the one documented composition root (index.js), and a uuid is the idiom the rest of the sidecar mints ids
  // with anyway. The core takes `newId` injected, so it stays pure either way.
  newId: () => nodeCrypto.randomUUID(),
  version: () => process.env.npm_package_version || 'dev',
  log: log
});

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

    // A RESPONSE to one of our own outbound requests: settle it here and never hand it to the core.
    if (msg && msg.method === undefined && msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(String((msg.error && msg.error.message) || 'client error')));
      else p.resolve(msg.result);
      continue;
    }

    // Dispatch async and DO NOT await: session/prompt runs for minutes, and a client may legitimately send
    // session/cancel on the same pipe while it is in flight. Responses are id-correlated, so out-of-order
    // completion is safe by construction.
    Promise.resolve().then(() => agent.handleRpc(msg)).then(resp => {
      if (resp) writeMessage(resp);
    }).catch(e => {
      log('handleRpc threw:', (e && e.stack) || e);
      if (msg && msg.id != null) writeMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'internal error' } });
    });
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

log('StarNet ACP agent ready on stdio → ' + BASE_LABEL + (cachedToken ? ' (token from env/flag)' : ' (token via page scrape)'));

module.exports = { readConfig, _internals: { discoverToken, callSidecar, openRun } };
