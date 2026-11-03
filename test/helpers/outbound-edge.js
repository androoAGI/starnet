'use strict';
/* test/helpers/outbound-edge.js — the network edge of a sidecar under test: loopback passes, nothing else leaves this
   machine, and everything that tried to is on record. Loaded only through NODE_OPTIONS (--require), like
   test/helpers/env-probe.js and test/_skill_exchange_fetch_fixture.js, by test/credential-store.openrouter-consumers.e2e.test.js.

   WHY. web_search's keyless engines and a voice leg that dials a provider's public host would otherwise reach the real
   Mojeek, DuckDuckGo and openrouter.ai from a test: the keyless engines must fail so the chain reaches its OpenRouter rung,
   and at trunk the proof that a key went to the wrong host IS that dial. Here it is answered 503, and the host, the path
   and the credential header are recorded, one JSON line per request, in the file STARNET_TEST_EDGE_OUT names. Its first
   line says the edge is up ({ edge: 'ready', pid }), so a test can refuse to go on without it.

   WHERE IT SITS. Two seams cover every HTTP dial the sidecar makes through undici:
     1. undici's global dispatcher (globalThis[Symbol.for('undici.globalDispatcher.1')]), which Node 22's fetch and the repo's
        undici 6.28.1 share: a fetch with no dispatcher of its own, web search among them.
     2. undici.Agent.prototype.dispatch: a fetch that names a dispatcher of its own. media-service.js hands every voice leg a
        keep-alive Agent (voiceFetchOpts), so a global dispatcher alone would never see STT or TTS, and those legs would dial
        the real host. An Agent built later, or from `import('undici')`, shares this prototype.
   What it does not see, because no station under this preload arms it: the Edge voice's websocket (SKYNET_EDGE_TTS=0), the
   channel proxy (https.request, sidecar/channels/proxy-fetch.js) and the mail connectors' sockets. Keep them off, or
   give them a seam here first. */
const fs = require('fs');
const undici = require('undici');

const OUT = String(process.env.STARNET_TEST_EDGE_OUT || '');
const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|localhost|\[::1\]|::1)$/i;
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key'];

// a dispatch's headers are an object, a flat [name, value, ...] list or a raw 'name: value\r\n' string, by caller
function headerMap(headers) {
  const out = {};
  const put = (name, value) => { out[String(name).toLowerCase()] = String(value); };
  if (Array.isArray(headers)) for (let i = 0; i + 1 < headers.length; i += 2) put(headers[i], headers[i + 1]);
  else if (typeof headers === 'string') for (const line of headers.split('\r\n')) { const at = line.indexOf(':'); if (at > 0) put(line.slice(0, at), line.slice(at + 1).trim()); }
  else if (headers && typeof headers === 'object') for (const name of Object.keys(headers)) put(name, headers[name]);
  return out;
}
function record(origin, opts) {
  if (!OUT) return;
  const headers = headerMap(opts.headers);
  const credentials = CREDENTIAL_HEADERS.map(name => headers[name]).filter(Boolean);
  // one appendFileSync of one line: several processes may share the file, and a line is never torn by another's
  fs.appendFileSync(OUT, JSON.stringify({ host: origin.host, method: String(opts.method || ''), path: String(opts.path || ''), authorization: headers.authorization || '', credentials }) + '\n');
}
function answer(handler) {
  const body = Buffer.from('outbound-edge: this test station has no network');
  const headers = [Buffer.from('content-type'), Buffer.from('text/plain'), Buffer.from('content-length'), Buffer.from(String(body.length))];
  try {
    handler.onConnect(() => {});
    if (handler.onResponseStarted) handler.onResponseStarted();
    handler.onHeaders(503, headers, () => {}, 'Service Unavailable');
    handler.onData(body);
    handler.onComplete([]);
  } catch (e) { handler.onError(e); }
}

const realDispatch = undici.Agent.prototype.dispatch;
undici.Agent.prototype.dispatch = function edgeDispatch(opts, handler) {
  const origin = new URL(String(opts.origin));
  if (LOOPBACK.test(origin.hostname)) return realDispatch.call(this, opts, handler);
  record(origin, opts);
  setImmediate(answer, handler);
  return true;
};
undici.setGlobalDispatcher(new undici.Agent());
if (OUT) fs.appendFileSync(OUT, JSON.stringify({ edge: 'ready', pid: process.pid }) + '\n');
