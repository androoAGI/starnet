/* sidecar/mcp/transport.http.js — the MCP "Streamable HTTP" client transport (the I/O edge).
   POSTs one JSON-RPC message per send(); the POST's response carries the reply, either as a single
   application/json body OR a text/event-stream (SSE) of one-or-more messages — both are parsed and
   handed back to the client via onMessage(). A server-assigned `Mcp-Session-Id` (from initialize) is
   captured and echoed on every later request. fetch is injected so the transport is testable headless.

   makeHttpTransport({ url, token?, headers?, fetchImpl?, timeoutMs?, protocolVersion?, onError? }) -> transport
     transport = { send(message)->Promise, onMessage(cb), close(), }

   SECURITY: the Commander configures the server URL deliberately (unlike web_fetch, where the MODEL
   picks the URL), so loopback IS allowed — local MCP servers are common. The one guard: refuse http://
   for a NON-local host, so a bearer token is never sent in cleartext over the network. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.mcp = root.SK.mcp || {}).transportHttp = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const JSONRPC = '2.0';
  const LOCAL_ERROR = Symbol.for('starnet.mcp.localTransportError');   // read by client.js safeRpcError

  // Node's fetch rejects with a bare "fetch failed"; the reason (DNS miss, refused, TLS) lives on e.cause.
  // Only the error CODE and our own wording are kept — never response text — so this stays transport-authored.
  function requestFailure(e) {
    if (e && e.name === 'AbortError') return 'timed out or was cancelled';
    const code = String((e && e.cause && e.cause.code) || (e && e.code) || '');
    const why = {
      ENOTFOUND: 'the server name did not resolve (check the URL, or your internet connection)',
      EAI_AGAIN: 'DNS lookup failed (check your internet connection)',
      ECONNREFUSED: 'the server refused the connection (is it running at that address?)',
      ECONNRESET: 'the connection was reset by the server',
      ETIMEDOUT: 'the connection timed out',
      UND_ERR_CONNECT_TIMEOUT: 'the connection timed out',
      CERT_HAS_EXPIRED: 'the server TLS certificate has expired',
      DEPTH_ZERO_SELF_SIGNED_CERT: 'the server uses a self-signed TLS certificate',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the server TLS certificate could not be verified'
    }[code];
    if (why) return why + ' [' + code + ']';
    const msg = String((e && e.message) || e || 'unknown error');
    return /^[A-Z][A-Z0-9_]{2,40}$/.test(code) ? msg + ' [' + code + ']' : msg;
  }

  /* `/^127\./` was UNANCHORED, so it matched the public hostname `127.0.0.1.evil.com` — and this predicate is
     the module's ONE guard ("refuse http:// for a non-local host, so a bearer token is never sent in
     cleartext"). A connector URL of http://127.0.0.1.evil.com/mcp therefore shipped the Commander's OAuth
     bearer over plaintext HTTP to whoever owns that domain. An IPv4 loopback literal is four numeric octets
     and nothing else; anything with a trailing label is a NAME. Also folds the FQDN root label so
     `localhost.` classifies the same as `localhost`, and recognizes the IPv4-mapped IPv6 form Node renders
     for [::ffff:127.0.0.1]. */
  function isLoopback(host) {
    host = String(host).toLowerCase();
    if (host.charAt(0) === '[') host = host.slice(1, -1);
    else host = host.replace(/\.+$/, '');
    if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true;
    const m = host.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);   // a LITERAL v4, whole-string
    return !!m && Number(m[1]) === 127;
  }

  function assertUrl(raw) {
    let u;
    try { u = new URL(raw); } catch (e) { throw new Error('invalid connector URL: ' + raw); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('connector URL must be http(s): ' + raw);
    let h = u.hostname.toLowerCase();
    if (h.charAt(0) === '[') h = h.slice(1, -1);
    if (u.protocol === 'http:' && !isLoopback(h))
      throw new Error('refusing http:// for a non-local connector (' + h + ') — use https so the auth token is not sent in cleartext');
    return u;
  }

  // parse an SSE body into the JSON-RPC messages carried on its `data:` lines (multiple data: lines in
  // one event are joined; non-JSON keepalive/comment lines are skipped).
  function parseSse(text) {
    const out = [];
    const events = String(text).split(/\r?\n\r?\n/);
    for (const ev of events) {
      const dataLines = [];
      for (const line of ev.split(/\r?\n/)) { const m = line.match(/^data:\s?(.*)$/); if (m) dataLines.push(m[1]); }
      if (!dataLines.length) continue;
      const payload = dataLines.join('\n').trim();
      if (!payload) continue;
      try { out.push(JSON.parse(payload)); } catch (e) { /* keepalive / non-JSON event — skip */ }
    }
    return out;
  }

  // A remote error body is attacker-controlled and may echo an Authorization header, OAuth code, or arbitrary
  // prompt-injection text. Preserve only the protocol's short machine-readable error slug; never reflect the
  // free-form description/body into JSON-RPC errors, logs, connector status, or the model's tool result.
  function safeErrorDetail(raw) {
    let value = '';
    try { const j = JSON.parse(String(raw || '')); value = j && j.error; } catch (_) {}
    return (typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value)) ? value : '';
  }

  function makeHttpTransport(deps) {
    deps = deps || {};
    const u = assertUrl(deps.url);
    const doFetch = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('mcp http transport requires global fetch (Node 18+) or deps.fetchImpl');
    const token = deps.token || '';
    const extraHeaders = deps.headers || {};
    const timeoutMs = deps.timeoutMs || 30000;
    const onError = typeof deps.onError === 'function' ? deps.onError : function () {};
    let onMsg = null, sessionId = deps.sessionId || null, protocolVersion = deps.protocolVersion || null, closed = false;

    function headers() {
      const h = Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }, extraHeaders);
      if (token) h['Authorization'] = 'Bearer ' + token;
      if (sessionId) h['Mcp-Session-Id'] = sessionId;
      if (protocolVersion) h['MCP-Protocol-Version'] = protocolVersion;
      return h;
    }
    function withTimeout(fn) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      if (t && typeof t.unref === 'function') t.unref();
      return Promise.resolve(fn(ctrl.signal)).finally(() => clearTimeout(t));
    }
    function deliver(msg) { if (onMsg) { try { onMsg(msg); } catch (e) { onError(e); } } }
    // a transport-level failure on a REQUEST is turned into a JSON-RPC error response so the client's pending
    // promise rejects promptly (instead of hanging until its timeout); for a notification there is no id to fail.
    // LOCAL_ERROR marks text WE wrote (a symbol: no JSON body a server sends can carry it), so the client may show
    // it instead of masking it like remote-authored error prose — "DNS lookup failed" beats "JSON-RPC error (-32000)".
    function failTo(id, message) { if (id != null) deliver({ jsonrpc: JSONRPC, id, error: { code: -32000, message: message, [LOCAL_ERROR]: true } }); else onError(new Error(message)); }

    async function send(message) {
      const id = message && message.id;
      if (closed) return failTo(id, 'connector transport closed');
      if (message && message.method === 'initialize' && protocolVersion == null && message.params && message.params.protocolVersion) {
        protocolVersion = message.params.protocolVersion;   // pin the negotiated version onto later request headers
      }
      let res;
      try { res = await withTimeout(signal => doFetch(u.href, { method: 'POST', headers: headers(), body: JSON.stringify(message), signal, redirect: 'manual' })); }
      catch (e) { return failTo(id, 'connector request failed: ' + requestFailure(e)); }

      const status = res.status;
      if (status >= 300 && status < 400) return failTo(id, 'connector HTTP redirect refused — update the configured endpoint directly');
      if (status === 202 || status === 204) return;                         // accepted notification / no body
      if (status < 200 || status >= 300) {
        let detail = ''; try { detail = safeErrorDetail(await res.text()); } catch (e) {}
        return failTo(id, 'connector HTTP ' + status + (detail ? ' — ' + detail : ''));
      }
      try { const sid = res.headers && res.headers.get && res.headers.get('mcp-session-id'); if (sid) sessionId = sid; } catch (e) {}
      const ct = ((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
      if (/text\/event-stream/.test(ct)) return readSse(res, id);
      let body = ''; try { body = await res.text(); } catch (e) { return failTo(id, 'connector response read failed'); }
      if (!body.trim()) { /* empty body — a notification ack, nothing to route */ }
      else { try { deliver(JSON.parse(body)); } catch (e) { failTo(id, 'connector returned a non-JSON body'); } }
    }

    /* SSE bodies are parsed INCREMENTALLY. This used to be `await res.text()` + parseSse, which only works
       when the server closes the stream after replying. A streamable-HTTP server (Wix) delivers the JSON-RPC
       response event and then HOLDS THE POST STREAM OPEN for keepalives/progress notifications — buffering to
       stream-close therefore never resolves, and every request dies on the client's timeout even though the
       reply arrived within milliseconds. The reply, not the stream close, is the unit of completion: deliver
       each complete event as its chunk lands, and once THIS request's response has been routed, cancel the
       rest of the stream. */
    async function readSse(res, id) {
      const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
      if (!reader) {                     // no streamable body (test fakes / fetch shims) — buffered fallback
        let body = ''; try { body = await res.text(); } catch (e) { return failTo(id, 'connector response read failed'); }
        for (const m of parseSse(body)) deliver(m);
        return;
      }
      let answered = false, buf = '';
      const route = (m) => {
        if (id != null && m && m.id != null && String(m.id) === String(id) && (('result' in m) || ('error' in m))) answered = true;
        deliver(m);
      };
      const drainComplete = () => {       // deliver every COMPLETE (blank-line-terminated) event in the buffer
        for (;;) {
          const b = buf.match(/\r?\n\r?\n/);
          if (!b) return;
          const ev = buf.slice(0, b.index);
          buf = buf.slice(b.index + b[0].length);
          for (const m of parseSse(ev + '\n\n')) route(m);
        }
      };
      // best-effort cancel: a cancel failure only means the already-answered (or already-dead) stream keeps
      // draining until the server drops it; the failure is handed back as a value for any caller that cares.
      const tryCancel = () => { try { return reader.cancel(); } catch (e) { return e; } };
      // the stream read gets the same ceiling as the fetch; on expiry the reader is cancelled and the caller
      // fails promptly below instead of hanging on the client's own timer.
      const t = setTimeout(tryCancel, timeoutMs);
      if (t && typeof t.unref === 'function') t.unref();
      try {
        const dec = new TextDecoder();
        for (;;) {
          let step;
          try { step = await reader.read(); } catch (e) { break; }     // cancelled / network drop -> treat as end
          if (step.done) break;
          buf += dec.decode(step.value, { stream: true });
          drainComplete();
          if (answered) { tryCancel(); break; }                        // reply routed — the rest is keepalive
        }
        if (!answered && buf.trim()) { for (const m of parseSse(buf)) route(m); buf = ''; }   // unterminated final event
      } finally { clearTimeout(t); }
      if (id != null && !answered) failTo(id, 'connector response stream ended without a reply');
    }

    function onMessage(cb) { onMsg = cb; }
    function close() {
      if (closed) return;
      closed = true;
      if (sessionId) { try { Promise.resolve(doFetch(u.href, { method: 'DELETE', headers: headers(), redirect: 'manual' })).catch(() => {}); } catch (e) {} }   // best-effort MCP session teardown
    }

    return { send, onMessage, close };
  }

  return { makeHttpTransport, _internals: { parseSse, assertUrl, isLoopback, safeErrorDetail } };
});
