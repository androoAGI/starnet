/* sidecar/mcp/client.js — a transport-agnostic Model Context Protocol (MCP) client.
   Pure JSON-RPC 2.0 over an INJECTED duplex transport, so the protocol layer is fully
   unit-testable with a fake transport and carries no ambient I/O — the real HTTP/stdio edge
   lives in the transport (the host's composition root). Deterministic: request ids are a
   monotonic counter, never random, and wall-clock time only enters via the optional
   injected request timeout (setTimeout), never via Date.now/new Date().

   makeMcpClient({ transport, timeoutMs?, protocolVersion?, capabilities?, clientInfo?, onError? }) -> {
     initialize() -> Promise<{ protocolVersion, capabilities, serverInfo }>,
     listTools()  -> Promise<tool[]>,             // follows tools/list nextCursor pagination
     callTool(name, args, { signal? }?) -> Promise<{ content, isError }>,   // an abort rejects at once + notifications/cancelled
     listResources() / listResourceTemplates() / readResource(uri),   // the RESOURCES primitive
     listPrompts() / getPrompt(name, args),                            // the PROMPTS primitive
     supports('resources'|'prompts'|'tools') -> bool,                  // from the server's initialize response
     request(method, params) -> Promise<result>,  // low-level JSON-RPC request (id-correlated)
     notify(method, params)  -> Promise<void>,     // fire-and-forget notification (no id)
     onNotification(method, cb) -> unsubscribe,
     receive(msg),                                 // push an inbound message (if transport has no onMessage)
     close(reason?), isClosed()
   }

   transport contract:
     send(message) -> Promise            // serialize + write ONE JSON-RPC message
     onMessage(cb)?                       // register inbound handler (else the caller pushes via client.receive)
     close()?                             // best-effort teardown */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.mcp = root.SK.mcp || {}).client = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // failopen.note — the tagged swallow: a best-effort cancel notification that fails is counted, never invisible.
  const { note: failNote } = (typeof require === 'function') ? require('../failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };

  const JSONRPC = '2.0';
  const LOCAL_ERROR = Symbol.for('starnet.mcp.localTransportError');   // set by transport.http/stdio failTo
  const DEFAULT_PROTOCOL = '2025-06-18';   // MCP revision; the server's echoed version wins after initialize
  const MAX_PAGES = 100;                   // a misbehaving server that always returns a cursor can't spin forever

  // JSON-RPC error.message/data are remote-controlled. Only the tightly-shaped HTTP status emitted by our own
  // transport is safe to retain; arbitrary server prose can contain credentials or prompt injection and must
  // not flow into connector status, logs, or model-visible tool errors.
  function safeRpcError(error) {
    const code = error && error.code;
    const raw = String((error && error.message) || '');
    if (/^connector HTTP \d{3}(?: — [a-z0-9_.-]{1,64})?$/i.test(raw)) return raw;
    if (raw === 'connector HTTP redirect refused — update the configured endpoint directly') return raw;
    // Text our OWN transport wrote (DNS miss, refused connection, non-JSON body, child exit). The marker is a
    // Symbol, which no JSON a server sends can produce, so remote prose can never ride this branch.
    if (error && error[LOCAL_ERROR] === true) return raw.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 300);
    return 'connector JSON-RPC error' + (code != null ? ' (' + String(code).slice(0, 24) + ')' : '');
  }

  function makeMcpClient(deps) {
    deps = deps || {};
    const transport = deps.transport;
    if (!transport || typeof transport.send !== 'function') throw new Error('makeMcpClient: transport.send is required');
    const timeoutMs = deps.timeoutMs || 0;
    const clientInfo = deps.clientInfo || { name: 'starnet-harness', version: '0' };
    const capabilities = deps.capabilities || {};
    const onError = typeof deps.onError === 'function' ? deps.onError : function () {};
    let protocolVersion = deps.protocolVersion || DEFAULT_PROTOCOL;

    let nextId = 0;
    const pending = new Map();          // id -> { resolve, reject, timer }
    const notifHandlers = new Map();    // method -> cb[]
    let closed = false;
    let drainReason = null;

    function settle(id, apply) {
      const p = pending.get(id);
      if (!p) return;                   // already settled / timed out / unknown id -> ignore
      pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      if (p.detach) p.detach();
      apply(p);
      if (drainReason !== null && pending.size === 0) close(drainReason);
    }

    // route ONE inbound JSON-RPC message: response -> pending; notification -> handlers; server request -> reject.
    function receive(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.id != null && (('result' in msg) || ('error' in msg))) {        // a response correlates by id
        if ('error' in msg && msg.error) {
          const e = new Error(safeRpcError(msg.error));
          e.code = msg.error && msg.error.code;
          settle(msg.id, p => p.reject(e));
        } else {
          settle(msg.id, p => p.resolve(msg.result));
        }
        return;
      }
      if (msg.method && msg.id == null) {                                      // a notification (no id)
        const hs = notifHandlers.get(msg.method) || [];
        for (const h of hs) { try { h(msg.params); } catch (err) { onError(err); } }
        return;
      }
      if (msg.method && msg.id != null) {                                      // a server -> client REQUEST
        // we implement no server-initiated methods yet (sampling/elicitation/roots) — answer politely so a
        // capable server isn't left hanging on an unanswered id.
        try { transport.send({ jsonrpc: JSONRPC, id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } }); }
        catch (err) { onError(err); }
      }
    }
    if (typeof transport.onMessage === 'function') transport.onMessage(receive);

    /* opts.signal (optional): the caller's cancellation. An already-aborted signal never sends; an abort mid-flight
       rejects the pending request AT ONCE (the run's STOP must not wait out a slow server) and tells the server
       with the protocol's `notifications/cancelled` for that request id, best-effort. The request may already
       have taken effect server-side — the rejection says "cancelled", never "did not happen". */
    function request(method, params, opts) {
      if (closed || drainReason !== null) return Promise.reject(new Error('mcp client closed'));
      const signal = opts && opts.signal;
      if (signal && signal.aborted) return Promise.reject(Object.assign(new Error('mcp request cancelled before it was sent: ' + method), { cancelled: true, sent: false }));
      const id = ++nextId;
      const msg = { jsonrpc: JSONRPC, id, method };
      if (params !== undefined) msg.params = params;
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, timer: null, detach: null };
        if (timeoutMs > 0) {
          // __timeout + timeoutMs: the registry reads this exactly like its own timer (effect-unknown wording for a
          // non-read tool), so a connector call that outlived the client's budget is never reported as a plain failure.
          entry.timer = setTimeout(() => { settle(id, p => p.reject(Object.assign(new Error('mcp request timed out: ' + method), { __timeout: true, timeoutMs: timeoutMs }))); }, timeoutMs);
          if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();   // never keep the host alive
        }
        if (signal && typeof signal.addEventListener === 'function') {
          const onAbort = () => {
            if (!pending.has(id)) return;
            settle(id, p => p.reject(Object.assign(new Error('mcp request cancelled: ' + method), { cancelled: true, sent: true, effectUnknown: true })));
            notify('notifications/cancelled', { requestId: id, reason: 'cancelled by the StarNet host (run stopped)' })
              .catch(err => { failNote('mcp.client.cancelNotify', err); onError(err); });
          };
          signal.addEventListener('abort', onAbort, { once: true });
          entry.detach = () => { try { signal.removeEventListener('abort', onAbort); } catch (err) { failNote('mcp.client.abortDetach', err); } };
        }
        pending.set(id, entry);
        // send on a microtask so a synchronous transport that echoes inside send() still finds the pending entry
        Promise.resolve().then(() => transport.send(msg)).catch(err => {
          settle(id, p => p.reject(err instanceof Error ? err : new Error(String(err))));
        });
      });
    }

    function notify(method, params) {
      if (closed) return Promise.reject(new Error('mcp client closed'));
      const msg = { jsonrpc: JSONRPC, method };
      if (params !== undefined) msg.params = params;
      return Promise.resolve().then(() => transport.send(msg));
    }

    function onNotification(method, cb) {
      const hs = notifHandlers.get(method) || [];
      hs.push(cb); notifHandlers.set(method, hs);
      return function unsubscribe() { const cur = notifHandlers.get(method) || []; const i = cur.indexOf(cb); if (i >= 0) cur.splice(i, 1); };
    }

    let serverCaps = {};
    async function initialize() {
      const result = await request('initialize', { protocolVersion: protocolVersion, capabilities: capabilities, clientInfo: clientInfo });
      if (result && result.protocolVersion) protocolVersion = result.protocolVersion;
      // REMEMBER WHAT THE SERVER SAID IT CAN DO. Without this the host has to probe blind and treat a
      // "method not found" as the answer — which is indistinguishable from a server that is simply broken,
      // and it costs a round trip per capability on every connect.
      serverCaps = (result && result.capabilities && typeof result.capabilities === 'object') ? result.capabilities : {};
      await notify('notifications/initialized');
      return result || {};
    }
    // Declared support, per the server's own initialize response. A server that never declared a capability
    // must not be asked for it: the request would be a protocol error, not a graceful empty list.
    const supports = (what) => !!(serverCaps && serverCaps[what]);

    /* Every MCP list endpoint is the same cursor-paginated shape, so it is written once. MAX_PAGES is the
       guard against a server that always hands back a cursor. */
    async function listPaged(method, key) {
      const out = [];
      let cursor;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await request(method, cursor ? { cursor } : {});
        const items = (res && Array.isArray(res[key])) ? res[key] : [];
        for (const t of items) out.push(t);
        cursor = res && res.nextCursor;
        if (!cursor) break;
      }
      return out;
    }

    const listTools = () => listPaged('tools/list', 'tools');
    function callTool(name, args, opts) {
      return request('tools/call', { name: name, arguments: args || {} }, opts);
    }

    /* RESOURCES AND PROMPTS (2026-07-27). This client spoke `tools/list` and `tools/call` and nothing else,
       which meant StarNet saw only a THIRD of what a connected MCP server actually offers. A server whose
       whole point is exposing documents (resources) or reusable prompt templates (prompts) connected fine,
       reported zero tools, and looked broken. These are not extras — they are two of the protocol's three
       primitives, and the reference harness has spoken all three for a long time.

       `resources/templates/list` is included with the plain list because a server that publishes only
       parameterised URIs (`db://{table}/rows`) would otherwise read as having no resources at all. */
    const listResources = () => listPaged('resources/list', 'resources');
    const listResourceTemplates = () => listPaged('resources/templates/list', 'resourceTemplates');
    const readResource = (uri) => request('resources/read', { uri: String(uri) });
    const listPrompts = () => listPaged('prompts/list', 'prompts');
    // `arguments` is omitted entirely when empty: a server that declares no arguments can reject an
    // unexpected empty object, and the spec treats the field as optional.
    function getPrompt(name, args) {
      const p = { name: String(name) };
      if (args && typeof args === 'object' && Object.keys(args).length) p.arguments = args;
      return request('prompts/get', p);
    }

    function close(reason) {
      if (closed) return;
      closed = true;
      const err = new Error('mcp client closed' + (reason ? ': ' + reason : ''));
      for (const p of pending.values()) { if (p.timer) clearTimeout(p.timer); if (p.detach) p.detach(); try { p.reject(err); } catch (e) {} }
      pending.clear();
      if (typeof transport.close === 'function') { try { transport.close(); } catch (e) { onError(e); } }
    }

    // A replacement session may be ready before every old request has received its response.
    // Let those responses (or their existing timeouts) settle before closing their transport.
    function drainAndClose(reason) {
      if (closed) return;
      drainReason = reason || 'reconnect';
      if (pending.size === 0) close(drainReason);
    }

    return {
      initialize, listTools, callTool,
      listResources, listResourceTemplates, readResource, listPrompts, getPrompt, supports,
      request, notify, onNotification, receive, close, drainAndClose,
      isClosed: function () { return closed; },
      get protocolVersion() { return protocolVersion; },
      get serverCapabilities() { return serverCaps; }
    };
  }

  return { makeMcpClient, _internals: { safeRpcError } };
});
