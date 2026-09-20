/* sidecar/mcp/manager.js — the connector MANAGER: the host-side singleton that owns configured MCP
   connectors, keeps a client warm per connector, caches each server's tools/list, and projects those
   tools into registry tool defs on demand. Mirrors the Telegram channel's lifecycle (configure / status /
   remove) so index.js wires it the same way. All I/O arrives injected — makeTransport (the network edge),
   makeClient (the JSON-RPC client), makeToolDef (the translator) — so the manager's logic is unit-testable
   with fakes and stays free of ambient time/randomness (clock injected).

   makeConnectorManager({ makeTransport, makeClient?, makeToolDef?, clock?, timeoutMs?, onEvent? }) -> {
     configure(id, { transport?, url?, token?, command?, args?, cwd?, env?, agentId?, label?, enabled? }) -> Promise<{ ok, state, toolCount, error? }>,
     remove(id) -> Promise, refresh(id) -> Promise<...>, close() -> Promise,
     status(id) -> summary | null, list() -> summary[],            // summaries NEVER include the token
     has(id), ids(),
     toolDefsFor(id) -> registry tool def[],                        // cached tools of ONE connector
     toolDefsForObjects(objects) -> registry tool def[],            // per-agent: defs for the room's connector objects
     call(id, toolName, args) -> Promise<{ content, isError }>
   }
   A placed connector object is { objectType:'connector', connectorId } (or { binding:{ connectorId } }). */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./client.js'), require('./translate.js'));
  } else {
    root.SK = root.SK || {}; root.SK.mcp = root.SK.mcp || {};
    root.SK.mcp.manager = factory(root.SK.mcp.client, root.SK.mcp.translate);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (clientMod, translateMod) {
  'use strict';

  function connectorIdOf(obj) {
    if (!obj || obj.objectType !== 'connector') return null;
    const id = obj.connectorId || (obj.binding && obj.binding.connectorId);
    return id ? String(id) : null;
  }

  function makeConnectorManager(deps) {
    deps = deps || {};
    const makeTransport = deps.makeTransport;
    if (typeof makeTransport !== 'function') throw new Error('makeConnectorManager: makeTransport is required (the network edge)');
    const makeClient = deps.makeClient || (clientMod && clientMod.makeMcpClient);
    const makeToolDef = deps.makeToolDef || (translateMod && translateMod.makeMcpToolDef);
    // Injected like makeToolDef, and OPTIONAL: a host (or a test) that passes neither simply gets the historic
    // tools-only projection rather than a crash.
    const makeAuxDefs = ('makeAuxDefs' in deps) ? deps.makeAuxDefs : (translateMod && translateMod.connectorAuxDefs);
    const clock = deps.clock || { now: () => 0 };
    const timeoutMs = deps.timeoutMs || 30000;
    const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : function () {};
    // AUTO-RECONNECT deps (injected so the manager stays timer/rng-free for tests + determinism lint). When absent
    // the reconnect scheduler is INERT (setTimeoutImpl null -> no reconnect armed), so existing callers are unchanged.
    const setTimeoutImpl = typeof deps.setTimeoutImpl === 'function' ? deps.setTimeoutImpl : null;
    const clearTimeoutImpl = typeof deps.clearTimeoutImpl === 'function' ? deps.clearTimeoutImpl : function () {};
    // jitter source: injected random() in [0,1); default is a fixed 0.5 (no Math.random literal here — the host
    // injects the real rng, keeping this module deterministic under lint).
    const random = typeof deps.random === 'function' ? deps.random : function () { return 0.5; };
    const schemaCache = deps.schemaCache || null;
    const fingerprintConfig = typeof deps.fingerprintConfig === 'function' ? deps.fingerprintConfig : function () { return ''; };
    const validateConfig = typeof deps.validateConfig === 'function' ? deps.validateConfig : function () { return ''; };
    const STDIO_IDLE_MS = Math.max(0, Number(deps.stdioIdleMs) || 15 * 60 * 1000);
    const STDIO_MAX_LIFETIME_MS = Math.max(0, Number(deps.stdioMaxLifetimeMs) || 6 * 60 * 60 * 1000);
    const RECONNECT_BASE_MS = Math.max(250, Number(deps.reconnectBaseMs) || 1000);
    const RECONNECT_MAX_MS = Math.max(RECONNECT_BASE_MS, Number(deps.reconnectMaxMs) || 60000);
    const RECONNECT_MAX_ATTEMPTS = Math.max(0, deps.reconnectMaxAttempts == null ? 8 : Number(deps.reconnectMaxAttempts));

    const conns = new Map();   // id -> { id, transportKind, url, token, ..., state, detail, tools[], client, transport, ts, reconnectAttempt, reconnectTimer, connecting }

    function normalizeTransport(cfg, prev) {
      const raw = cfg.transport || (prev && prev.transportKind) || (cfg.command || (prev && prev.command) ? 'stdio' : 'http');
      const t = String(raw || 'http').toLowerCase();
      if (t !== 'http' && t !== 'stdio') throw new Error('connector transport must be "http" or "stdio"');
      return t;
    }
    function normalizeArgs(args, prev) {
      if (!('args' in (args || {}))) return prev && Array.isArray(prev.args) ? prev.args.slice() : [];
      if (!Array.isArray(args.args)) throw new Error('connector stdio args must be an array');
      return args.args.map(a => String(a == null ? '' : a));
    }
    function normalizeEnv(cfg, prev) {
      if (!('env' in (cfg || {}))) return prev && prev.env && typeof prev.env === 'object' ? Object.assign({}, prev.env) : {};
      if (!cfg.env || typeof cfg.env !== 'object' || Array.isArray(cfg.env)) throw new Error('connector stdio env must be an object');
      const out = {};
      for (const k of Object.keys(cfg.env)) out[k] = String(cfg.env[k] == null ? '' : cfg.env[k]);
      return out;
    }
    // ADDITIVE: extra HTTP request headers (e.g. a custom auth scheme the bearer token can't express).
    // Same object-of-strings shape + carry-forward-when-absent contract as env.
    function normalizeHeaders(cfg, prev) {
      if (!('headers' in (cfg || {}))) return prev && prev.headers && typeof prev.headers === 'object' ? Object.assign({}, prev.headers) : {};
      if (!cfg.headers || typeof cfg.headers !== 'object' || Array.isArray(cfg.headers)) throw new Error('connector http headers must be an object');
      const out = {};
      for (const k of Object.keys(cfg.headers)) out[String(k)] = String(cfg.headers[k] == null ? '' : cfg.headers[k]);
      return out;
    }
    // ADDITIVE: an optional per-connector handshake/call timeout. Absent -> carry prev -> fall back to the
    // manager-global default; clamped to a sane range so a typo can't wedge a run forever or hang instantly.
    function normalizeTimeout(cfg, prev) {
      if (!cfg || cfg.timeoutMs == null) return (prev && prev.timeoutMs) || timeoutMs;
      const n = Number(cfg.timeoutMs);
      if (!isFinite(n) || n <= 0) return (prev && prev.timeoutMs) || timeoutMs;
      return Math.max(1000, Math.min(600000, Math.round(n)));
    }
    function redactEnv(env) {
      const out = {};
      const keys = Object.keys(env || {}).sort();
      for (const k of keys) out[k] = /TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH|BEARER|CREDENTIAL|COOKIE/i.test(k) ? '<redacted>' : '<set>';
      return out;
    }
    const SECRET_ARG = /(?:token|key|secret|password|passwd|auth|bearer|credential|cookie)/i;
    function safeUrl(raw) {
      try {
        const u = new URL(String(raw || ''));
        if (u.username) u.username = '<redacted>';
        if (u.password) u.password = '<redacted>';
        for (const k of Array.from(u.searchParams.keys())) if (SECRET_ARG.test(k)) u.searchParams.set(k, '<redacted>');
        u.hash = '';
        return u.href;
      } catch (_) { return '<configured-url>'; }
    }
    function redactArgs(args) {
      const out = [], src = Array.isArray(args) ? args : [];
      let redactNext = false;
      for (const raw of src) {
        const value = String(raw == null ? '' : raw);
        if (redactNext) { out.push('<redacted>'); redactNext = false; continue; }
        const eq = value.match(/^(--?[^=]+)=(.*)$/);
        if (eq && SECRET_ARG.test(eq[1])) { out.push(eq[1] + '=<redacted>'); continue; }
        if (/^--?/.test(value) && SECRET_ARG.test(value)) { out.push(value); redactNext = true; continue; }
        out.push(/^https?:\/\//i.test(value) ? safeUrl(value) : value);
      }
      return out;
    }

    function setState(c, state, detail) {
      c.state = state; c.detail = detail || ''; c.ts = clock.now();
      try { onEvent({ type: 'connector.state', connectorId: c.id, state: state, detail: c.detail, toolCount: (c.tools || []).length }); } catch (e) {}
    }
    function configIssue(c) {
      if (!c || !c.enabled) return '';
      if (Array.isArray(c.missingFields) && c.missingFields.length) {
        return 'connector configuration is incomplete; re-enter: ' + c.missingFields.join(', ');
      }
      try { return String(validateConfig(c) || ''); } catch (_) { return 'connector runtime ownership could not be verified'; }
    }
    function closeResources(client, transport, reason) {
      if (client) { try {
        if (reason === 'reconnect' && typeof client.drainAndClose === 'function') client.drainAndClose(reason);
        else client.close(reason || 'reconfigured');
      } catch (_) {} }
      else if (transport && typeof transport.close === 'function') { try { transport.close(); } catch (_) {} }
    }
    function teardown(c) {
      if (c && c.reconnectTimer != null) { try { clearTimeoutImpl(c.reconnectTimer); } catch (_) {} c.reconnectTimer = null; }
      if (c && c.connecting) { closeResources(c.connecting.client, c.connecting.transport, 'superseded'); c.connecting = null; }
      if (c && c.client) closeResources(c.client, c.transport, 'reconfigured');
      if (c) { c.client = null; c.transport = null; }
    }

    function cacheRecord(c) {
      if (!schemaCache || !c.cacheFingerprint || typeof schemaCache.save !== 'function') return;
      try {
        const saved = schemaCache.save(c.id, {
          version: 1, fingerprint: c.cacheFingerprint, cachedAt: clock.now(),
          tools: c.tools || [], resources: c.resources || [], prompts: c.prompts || []
        });
        c.cacheState = saved === false ? 'write-error' : 'current';
      } catch (e) {
        c.cacheState = 'write-error';
        try { onEvent({ type: 'connector.partial', connectorId: c.id, what: 'schema-cache', detail: 'schema cache write failed' }); } catch (_) {}
      }
    }

    function loadCached(c) {
      if (!schemaCache || !c.cacheFingerprint || typeof schemaCache.load !== 'function') return false;
      let cached = null;
      try { cached = schemaCache.load(c.id); } catch (_) {}
      if (!cached || cached.fingerprint !== c.cacheFingerprint) {
        c.cacheState = cached ? 'invalidated' : 'absent';
        if (cached && typeof schemaCache.remove === 'function') { try { schemaCache.remove(c.id); } catch (_) {} }
        return false;
      }
      c.tools = Array.isArray(cached.tools) ? cached.tools : [];
      c.resources = Array.isArray(cached.resources) ? cached.resources : [];
      c.prompts = Array.isArray(cached.prompts) ? cached.prompts : [];
      c.cacheState = 'current';
      c.cachedAt = Number(cached.cachedAt) || 0;
      return true;
    }

    // the connector's ID for THIS live connection — bumped on every (re)connect so a death callback from an OLD
    // transport (a torn-down connection) is ignored (it can't flip a freshly-reconnected connector back to error).
    function bumpEpoch(c) { c._epoch = (c._epoch || 0) + 1; return c._epoch; }

    // TRANSPORT DEATH: the stdio child exited / the HTTP endpoint keeps failing. The transport calls this via its
    // onError hook. Flip the connector to 'error' (honest status — the UI was previously stuck on 'up' forever)
    // and, if reconnect is wired + within the attempt cap, schedule a bounded-backoff reconnect. Guarded by epoch
    // so a stale callback from a superseded transport does nothing.
    function onTransportDeath(c, epoch, reason) {
      if (!conns.get(c.id) || c._epoch !== epoch) return;      // stale connection or removed connector -> ignore
      if (c.state === 'error' && c.reconnectTimer != null) return;   // already handling this death
      c.tools = [];
      // keep c.transport reference so teardown can close the client; mark not-up.
      setState(c, 'error', reason || 'connector transport closed');
      scheduleReconnect(c);
    }

    function reconnectDelay(c) {
      const attempt = c.reconnectAttempt || 0;
      const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempt));
      c.reconnectAttempt = attempt + 1;
      return Math.floor(exp * (0.5 + 0.5 * random()));         // jitter in [0.5x, 1x]
    }

    function scheduleReconnect(c) {
      if (!setTimeoutImpl) return;                              // reconnect not wired -> honest error state only
      if (!c.enabled) return;                                   // a disabled connector never auto-reconnects
      if (c.reconnectTimer != null) return;                     // already scheduled
      if ((c.reconnectAttempt || 0) >= RECONNECT_MAX_ATTEMPTS) { setState(c, 'error', (c.detail || 'connector down') + ' (giving up after ' + RECONNECT_MAX_ATTEMPTS + ' reconnect attempts)'); return; }
      const delay = reconnectDelay(c);
      c.reconnectTimer = setTimeoutImpl(function () {
        c.reconnectTimer = null;
        if (!conns.get(c.id) || !c.enabled) return;
        connect(c).catch(() => {});                             // connect() re-arms scheduleReconnect on failure
      }, delay);
    }

    async function connect(c) {
      if (c.reconnectTimer != null) { try { clearTimeoutImpl(c.reconnectTimer); } catch (_) {} c.reconnectTimer = null; }
      if (c.connecting) { closeResources(c.connecting.client, c.connecting.transport, 'superseded'); c.connecting = null; }
      // DRAIN, DON'T KILL. A reconnect used to close the old client immediately, which REJECTED every sibling
      // call still in flight on it ("mcp client closed: reconnect") — so when two calls hit an expired session
      // together, the first one's recovery turned the second's honest 404/401 into an unrelated failure. The old
      // connection is detached now and drains outstanding requests after this attempt settles; a sibling's reply arrives as what
      // the server actually said, and that sibling joins the shared reconnect on its own.
      const drained = c.client ? { client: c.client, transport: c.transport } : null;
      c.client = null; c.transport = null;
      const epoch = bumpEpoch(c);
      const isCurrent = () => conns.get(c.id) === c && c._epoch === epoch;
      const attempt = { epoch: epoch, transport: null, client: null };
      c.connecting = attempt;
      setState(c, 'connecting');
      try {
        const connTimeout = c.timeoutMs || timeoutMs;
        // oauth connectors carry a tokenProvider() rather than a frozen token, so EVERY (re)connect — the initial
        // connect, a manual Reload, and bounded auto-reconnect — fetches a FRESH bearer (refreshing if near expiry).
        // A provider throw falls back to the static token; an empty result connects tokenless so an expired/signed-out
        // connector surfaces an HONEST 401/error (visible + reloadable), never a crash or a silently-frozen stale token.
        let liveToken = c.token;
        if (typeof c.tokenProvider === 'function') { const got = await resolveToken(c, false); if (got.token != null) liveToken = got.token; }
        if (!isCurrent()) { if (drained) closeResources(drained.client, drained.transport, 'reconnect'); return { ok: false, state: 'down', toolCount: 0, superseded: true }; }
        attempt.transport = makeTransport({
          id: c.id,
          transport: c.transportKind,
          url: c.url,
          token: liveToken,
          headers: c.headers,
          command: c.command,
          args: c.args,
          cwd: c.cwd,
          env: c.env,
          agentId: c.agentId,
          timeoutMs: connTimeout,
          // DEATH HOOK: the transport reports child-exit / repeated failure here. Bound to THIS epoch so a stale
          // callback from a torn-down transport can't flip a reconnected connector back to error.
          onError: (e) => {
            try { if (isCurrent() && c.client === attempt.client) onTransportDeath(c, epoch, (e && e.message) || String(e)); } catch (_) {}
          }
        });
        attempt.client = makeClient({ transport: attempt.transport, timeoutMs: connTimeout });
        await attempt.client.initialize();
        /* TOOLS ARE NOT MANDATORY. This used to be an unconditional `listTools()`, which meant a server that
           publishes only RESOURCES or only PROMPTS answered "method not found", the throw fell into the catch
           below, and the connector died in an `error` state. A perfectly healthy document server looked
           broken — the precise symptom this whole lane exists to fix, hidden one line above the fix.
           The rule is capability-driven, with one deliberate legacy allowance: a server that declared NOTHING
           at all is still probed for tools (older servers under-report), and a probe failure there costs zero
           tools rather than the connector. A server that DID declare capabilities is taken at its word. */
        const declared = attempt.client.serverCapabilities || {};
        const declaredAnything = !!Object.keys(declared).length;
        let tools = [];
        if (!declaredAnything) {
          try { tools = await attempt.client.listTools() || []; }
          catch (_) { tools = []; }
        } else if (typeof attempt.client.supports === 'function' && attempt.client.supports('tools')) {
          tools = await attempt.client.listTools() || [];
        } else {
          tools = [];
        }
        /* RESOURCES + PROMPTS. Cached on connect exactly like tools, and asked for ONLY when the server's own
           initialize response declared the capability — probing a server that never claimed `resources` earns
           a protocol error, not an empty list, and that error is indistinguishable from a broken connector.
           A LIST FAILURE IS NOT A CONNECT FAILURE: a server whose tools work but whose resources/list throws
           must still come up `up` with its tools usable. Losing the whole connector over a secondary
           primitive would be a worse outcome than the one this feature exists to fix. */
        let resources = [];
        let prompts = [];
        if (typeof attempt.client.supports === 'function' && attempt.client.supports('resources')) {
          try {
            const [res, tpl] = [await attempt.client.listResources() || [], await attempt.client.listResourceTemplates() || []];
            resources = res.concat(tpl.map(t => Object.assign({}, t, { isTemplate: true })));
          } catch (e) { if (isCurrent()) try { onEvent({ type: 'connector.partial', connectorId: c.id, what: 'resources', detail: (e && e.message) || String(e) }); } catch (_) {} }
        }
        if (typeof attempt.client.supports === 'function' && attempt.client.supports('prompts')) {
          try { prompts = await attempt.client.listPrompts() || []; }
          catch (e) { if (isCurrent()) try { onEvent({ type: 'connector.partial', connectorId: c.id, what: 'prompts', detail: (e && e.message) || String(e) }); } catch (_) {} }
        }
        if (!isCurrent()) {
          closeResources(attempt.client, attempt.transport, 'superseded');
          if (drained) closeResources(drained.client, drained.transport, 'reconnect');
          return { ok: false, state: 'down', toolCount: 0, superseded: true };
        }
        c.connecting = null;
        c.transport = attempt.transport;
        c.client = attempt.client;
        c.tools = tools;
        c.resources = resources;
        c.prompts = prompts;
        c.startedAt = clock.now();
        c.lastUsedAt = c.startedAt;
        cacheRecord(c);
        c.reconnectAttempt = 0;                                 // a clean connect resets the backoff ladder
        c.authRequired = false;                                 // the server accepted this credential — auth truth restored
        c._callFails = 0;
        setState(c, 'up');
        if (drained) closeResources(drained.client, drained.transport, 'reconnect');
        return { ok: true, state: 'up', toolCount: tools.length, resourceCount: resources.length, promptCount: prompts.length };
      } catch (e) {
        if (drained) closeResources(drained.client, drained.transport, 'reconnect');
        closeResources(attempt.client, attempt.transport, 'connect failed');
        if (!isCurrent()) return { ok: false, state: 'down', toolCount: 0, superseded: true };
        if (c.connecting === attempt) c.connecting = null;
        c.tools = []; c.resources = []; c.prompts = [];
        if (AUTH_401.test((e && e.message) || '')) {
          // THE SERVER IS THE AUTHORITY ON AUTH: a 401 handshake means this credential is dead, and backoff
          // cannot mint a new one — reconnect-hammering a 401 just burns the attempt cap (the reported Wix/Gmail
          // failure mode). Honest terminal state; sign-in / a token edit reconfigures and recovers.
          c.authRequired = true;
          setState(c, 'error', authDetail(c));
          return { ok: false, state: 'error', toolCount: 0, error: c.detail, authRequired: true };
        }
        setState(c, 'error', (e && e.message) || String(e));
        scheduleReconnect(c);                                   // a failed (re)connect backs off and retries (bounded)
        return { ok: false, state: 'error', toolCount: 0, error: c.detail };
      }
    }

    async function configure(id, cfg, options) {
      id = String(id || '').trim();
      if (!id) throw new Error('configure: connector id is required');
      cfg = cfg || {};
      options = options || {};
      const prev = conns.get(id);
      if (prev) teardown(prev);
      const transportKind = normalizeTransport(cfg, prev);
      const c = {
        id: id,
        transportKind: transportKind,
        url: String(cfg.url || (prev && prev.url) || ''),
        token: ('token' in cfg) ? (cfg.token || '') : (prev ? prev.token : ''),
        command: String(cfg.command || (prev && prev.command) || ''),
        args: normalizeArgs(cfg, prev),
        cwd: String(cfg.cwd || (prev && prev.cwd) || ''),
        env: normalizeEnv(cfg, prev),
        // Stdio servers execute in one named agent's isolated environment. The binding is durable and
        // public (not a secret), so status can explain exactly whose Safe Cell owns the child.
        agentId: String(cfg.agentId || (prev && prev.agentId) || ''),
        headers: normalizeHeaders(cfg, prev),
        timeoutMs: normalizeTimeout(cfg, prev),
        label: String(cfg.label || (prev && prev.label) || id),
        enabled: cfg.enabled !== false,
        missingFields: Array.isArray(cfg.missingFields)
          ? Array.from(new Set(cfg.missingFields.filter(x => typeof x === 'string')))
          : (prev && Array.isArray(prev.missingFields) ? prev.missingFields.slice() : []),
        // oauth connectors pass a tokenProvider() instead of a frozen token (see connect); carried across reconfigure
        // so a benign toggle/re-warm keeps refreshing the bearer.
        tokenProvider: Object.prototype.hasOwnProperty.call(cfg, 'tokenProvider')
          ? (typeof cfg.tokenProvider === 'function' ? cfg.tokenProvider : null)
          : (prev ? prev.tokenProvider : null),
        state: 'down', detail: '', tools: [], client: null, transport: null, connecting: null, ts: clock.now(),
        reconnectAttempt: 0, reconnectTimer: null, _epoch: 0,
        cacheFingerprint: transportKind === 'stdio' ? String(fingerprintConfig({
          transport: transportKind, command: String(cfg.command || (prev && prev.command) || ''),
          args: normalizeArgs(cfg, prev), cwd: String(cfg.cwd || (prev && prev.cwd) || ''),
          env: normalizeEnv(cfg, prev), agentId: String(cfg.agentId || (prev && prev.agentId) || ''),
          package: String(cfg.package || '')
        }) || '') : '',
        cacheState: 'disabled', cachedAt: 0, startedAt: null, lastUsedAt: null, lazyConnectPromise: null
      };
      conns.set(id, c);
      if (transportKind === 'http' && !c.url) { setState(c, 'error', 'no server URL configured'); return { ok: false, state: 'error', toolCount: 0, error: c.detail }; }
      if (transportKind === 'stdio' && !c.command) { setState(c, 'error', 'no stdio command configured'); return { ok: false, state: 'error', toolCount: 0, error: c.detail }; }
      if (!c.enabled) { setState(c, 'down'); return { ok: true, state: 'down', toolCount: 0 }; }
      const issue = configIssue(c);
      if (issue) { setState(c, 'error', issue); return { ok: false, state: 'error', toolCount: 0, error: issue }; }
      if (transportKind === 'stdio' && options.deferConnect === true) {
        const projected = loadCached(c);
        setState(c, projected ? 'cached' : 'down', projected ? 'schemas projected from verified disk cache; process stopped' : 'no current schema cache; reload to discover tools');
        return { ok: true, state: c.state, toolCount: c.tools.length, cached: projected };
      }
      return connect(c);
    }

    function refresh(id) {
      const c = conns.get(String(id));
      if (!c) return Promise.resolve({ ok: false, state: 'down', toolCount: 0, error: 'unknown connector' });
      if (!c.enabled || (c.transportKind === 'http' && !c.url) || (c.transportKind === 'stdio' && !c.command)) return Promise.resolve({ ok: false, state: c.state, toolCount: 0 });
      return connect(c);
    }

    function remove(id) {
      const c = conns.get(String(id));
      if (c) {
        teardown(c); conns.delete(c.id);
        if (schemaCache && typeof schemaCache.remove === 'function') { try { schemaCache.remove(c.id); } catch (_) {} }
        try { onEvent({ type: 'connector.removed', connectorId: c.id }); } catch (e) {}
      }
      return Promise.resolve({ ok: true });
    }

    // a summary safe to log / return over HTTP: the token is NEVER included (only whether one is set).
    function summary(c) {
      const issue = configIssue(c);
      const out = {
        id: c.id,
        label: c.label,
        transport: c.transportKind,
        enabled: c.enabled,
        missingFields: c.missingFields.slice(),
        state: issue ? 'error' : c.state,
        detail: issue || c.detail,
        hasToken: !!(c.token || c.tokenProvider),
        oauth: !!c.tokenProvider,                        // the panel renders oauth connectors distinctly (re-auth via sign-in, not an http edit)
        authRequired: !issue && !!c.authRequired,        // the server rejected the credential (HTTP 401) — render "sign in again", not "down"
        timeoutMs: c.timeoutMs || timeoutMs,
        toolCount: issue ? 0 : (c.tools || []).length,
        // Surfaced so the connector panel can say what a server ACTUALLY offers. A server with 0 tools and 40
        // resources used to render as an empty connector, which reads as broken rather than as "this one
        // serves documents, not actions".
        resourceCount: issue ? 0 : (c.resources || []).length,
        promptCount: issue ? 0 : (c.prompts || []).length,
        tools: issue ? [] : (c.tools || []).map(t => t.name)
      };
      if (c.transportKind === 'stdio') {
        out.command = c.command;
        out.args = redactArgs(c.args);
        out.agentId = c.agentId;
        // A full cwd leaks usernames and the location/name of another workspace. The panel only needs to know
        // whether a custom working directory exists; the raw path remains server-side for process launch.
        out.hasCwd = !!c.cwd;
        out.env = redactEnv(c.env);
        out.hasEnv = Object.keys(c.env || {}).length > 0;
        out.schemaCache = c.cacheState;
        out.processState = c.client && c.state === 'up' ? 'running' : 'stopped';
        out.startedAt = c.startedAt;
        out.lastUsedAt = c.lastUsedAt;
      } else {
        out.url = safeUrl(c.url);
        out.headers = redactEnv(c.headers);            // header VALUES are never echoed — key + set/redacted only
        out.hasHeaders = Object.keys(c.headers || {}).length > 0;
      }
      return out;
    }
    function status(id) { const c = conns.get(String(id)); return c ? summary(c) : null; }
    function list() { const out = []; for (const c of conns.values()) out.push(summary(c)); return out; }
    function has(id) { return conns.has(String(id)); }
    function ids() { return Array.from(conns.keys()); }

    // consecutive call failures that flip an HTTP connector to 'error' (its transport reports per-call failures as
    // JSON-RPC errors, not transport death, so a vanished HTTP endpoint would otherwise stay 'up' forever). stdio
    // gets death detection from the child-exit hook, so this net is only meaningful for http; 0 disables it.
    const CALL_FAIL_LIMIT = Math.max(0, deps.callFailLimit == null ? 3 : Number(deps.callFailLimit));

    /* AUTH TRUTH (2026-08-26). A per-call HTTP 401 used to be an ordinary failure: invisible to status until
       CALL_FAIL_LIMIT consecutive misses, and even then labelled "connector unreachable" — so an expired Gmail
       bearer kept the panel on 'up' with a full tool list while every real call died. The 401 shape is the ONE
       transport-authored error the client preserves verbatim (safeRpcError), so it is matchable here, and it
       means exactly one thing: the server rejected the credential. That truth outranks the local expiry clock. */
    const AUTH_401 = /^connector HTTP 401\b/;
    function authDetail(c) {
      return c.tokenProvider
        ? 'reauthentication required — the server rejected this connector\'s sign-in (HTTP 401); sign in again'
        : 'authentication rejected (HTTP 401) — update this connector\'s token';
    }
    function markAuthRequired(c) {
      bumpEpoch(c);                                             // stale death callbacks from this connection are void
      teardown(c);                                              // clears the reconnect timer + closes client/transport
      c.tools = []; c.resources = []; c.prompts = [];
      c.authRequired = true;
      setState(c, 'error', authDetail(c));
      // deliberately NO scheduleReconnect: backoff cannot mint a credential. Sign-in (reconfigure) or a manual
      // Reload with a fixed token recovers — connect() clears authRequired on the next accepted handshake.
    }
    function lifecycleExpired(c) {
      if (!c || c.transportKind !== 'stdio' || !c.client) return false;
      const now = clock.now();
      return (STDIO_IDLE_MS > 0 && c.lastUsedAt != null && now - c.lastUsedAt >= STDIO_IDLE_MS)
        || (STDIO_MAX_LIFETIME_MS > 0 && c.startedAt != null && now - c.startedAt >= STDIO_MAX_LIFETIME_MS);
    }

    function recycle(c, reason) {
      if (!c || c.transportKind !== 'stdio' || !c.client) return false;
      bumpEpoch(c);
      closeResources(c.client, c.transport, reason || 'stdio lifecycle recycle');
      c.client = null; c.transport = null; c.startedAt = null; c.lastUsedAt = null;
      setState(c, (c.tools || []).length || (c.resources || []).length || (c.prompts || []).length ? 'cached' : 'down', reason || 'stdio process recycled');
      return true;
    }

    /* SINGLE-FLIGHT (RE)CONNECT (2026-09-04, GitHub #5 residue). Two tool calls that 401 together used to each
       `await connect(c)`: the second connect SUPERSEDED the first (closing its half-built client), caller A woke
       to state 'connecting', fell through to markAuthRequired, and that teardown killed B's attempt too — a
       freshly refreshed, perfectly VALID grant was reported as "reauthentication required". Every caller that
       wants "make this connector live again" now joins the ONE in-flight connect and reads its shared result. */
    function sharedConnect(c) {
      if (c.lazyConnectPromise) return c.lazyConnectPromise;
      const work = connect(c);
      c.lazyConnectPromise = work;
      work.then(() => { if (c.lazyConnectPromise === work) c.lazyConnectPromise = null; },
                () => { if (c.lazyConnectPromise === work) c.lazyConnectPromise = null; });
      return work;
    }

    /* TOKEN PROVIDER OUTCOME. The host's provider may hand back a plain string (legacy) or a typed outcome
       `{ token, refreshError: { kind: 'invalid_grant'|'network'|'other', message } }` — the host never throws
       for a failed refresh, it returns the freshest token it still has. A throw (any) is normalised to `other`
       with a null token so connect() falls back to the static token exactly as before. Kind matters in the
       401 call path: only `invalid_grant` is the server saying the GRANT is dead; a network miss keeps the old
       token and backs off, it is NOT a reauth prompt. */
    async function resolveToken(c, force) {
      if (typeof c.tokenProvider !== 'function') return { token: null, refreshError: null };
      try {
        const got = await c.tokenProvider(force === true);
        if (got != null && typeof got === 'object') {
          const err = got.refreshError && typeof got.refreshError === 'object' ? got.refreshError : null;
          return { token: got.token == null ? null : String(got.token), refreshError: err ? { kind: String(err.kind || 'other'), message: String(err.message || '') } : null };
        }
        return { token: got == null ? null : String(got), refreshError: null };
      } catch (e) {
        const kind = (e && (e.code === 'invalid_grant' || e.kind === 'invalid_grant')) ? 'invalid_grant' : ((e && (e.code === 'network' || e.kind === 'network')) ? 'network' : 'other');
        return { token: null, refreshError: { kind: kind, message: (e && e.message) || String(e) } };
      }
    }

    async function ensureLive(c) {
      if (c.client && c.state === 'up' && !lifecycleExpired(c)) return c;
      if (c.client) recycle(c, 'stdio lifecycle recycle');
      if (c.lazyConnectPromise) { await c.lazyConnectPromise; return c; }
      const result = await sharedConnect(c);
      if (!result || !result.ok) throw new Error((result && result.error) || 'connector failed to start');
      return c;
    }

    /* connector_required (beginner seam Lane 1): a tool call that needs a connector which is not wired is
       reported STRUCTURALLY as well as thrown. The throw is unchanged (the model still needs the error text);
       the event rides the RUN's own emit (ctx.emit — the tool-dispatch context, so it carries runId and lands
       on the /api/run stream -> U.bus) and the manager's onEvent (host log). Reason is the same string the
       error carries, so the chip and the narration never disagree. */
    function notConnected(id, toolName, ctx) {
      const reason = 'connector "' + id + '" is not connected';
      const ev = { runId: String((ctx && ctx.runId) || ''), connectorId: String(id), kind: 'mcp', reason: reason, toolName: String(toolName || '') };
      const err = new Error(reason);
      // a reporting failure must never change the error the model sees — but it is not swallowed either: it is
      // pinned on the thrown error (telemetryLost) so a host/test can prove the chip's event was NOT delivered.
      const lost = [];
      try { onEvent(Object.assign({ type: 'connector_required' }, ev)); } catch (e) { lost.push('onEvent: ' + ((e && e.message) || e)); }
      if (ctx && typeof ctx.emit === 'function') { try { ctx.emit('connector_required', ev); } catch (e) { lost.push('emit: ' + ((e && e.message) || e)); } }
      if (lost.length) err.telemetryLost = lost;
      return err;
    }

    async function call(id, toolName, args, ctx) {
      const c = conns.get(String(id));
      if (!c) throw notConnected(id, toolName, ctx);
      const issue = configIssue(c); if (issue) throw new Error(issue);
      if (c.transportKind === 'stdio') await ensureLive(c);
      if (!c.client || c.state !== 'up') throw notConnected(id, toolName, ctx);
      if (!(c.tools || []).some(t => t && t.name === toolName)) throw new Error('connector tool "' + toolName + '" is no longer published by the current server');
      c.lastUsedAt = clock.now();
      if (c.transportKind !== 'http') return c.client.callTool(toolName, args || {});
      return httpCall(c, toolName, args, false);
    }

    /* The http call path with auth truth. A 401 gets ONE forced-fresh-token reconnect + retry (the bearer may
       simply have expired mid-session — tokenProvider(true) refreshes on the server's word, not the local
       clock); a second 401 is a dead credential and flips the connector to the honest reauth state instead of
       counting toward "unreachable". Non-401 failures keep the consecutive-failure net unchanged. */
    const SESSION_404 = /^connector HTTP 404\b/;
    function toolStillPublished(c, toolName) {
      if (!(c.tools || []).some(t => t && t.name === toolName)) throw new Error('connector tool "' + toolName + '" is no longer published by the current server');
    }
    async function httpCall(c, toolName, args, isRetry) {
      const epochAtCall = c._epoch;
      try {
        const r = await c.client.callTool(toolName, args || {});
        c._callFails = 0;
        return r;
      } catch (e) {
        const msg = (e && e.message) || '';
        if (AUTH_401.test(msg)) {
          const reauthError = () => new Error('connector "' + c.id + '" needs reauthentication — the server rejected its credential (HTTP 401); sign in to it again');
          const reconnectedSince = () => c._epoch !== epochAtCall && c.client && c.state === 'up';
          if (isRetry || typeof c.tokenProvider !== 'function') { markAuthRequired(c); throw reauthError(); }
          // ANOTHER caller already reconnected this connector since our call left (the epoch moved and it is up
          // again): our 401 was answered by the OLD bearer. Retry on the live connection — no second refresh
          // (OAuth 2.1 rotates refresh tokens; a needless rotation is how the loser used to lose).
          if (reconnectedSince()) { toolStillPublished(c, toolName); return httpCall(c, toolName, args, true); }
          const got = await resolveToken(c, true);
          const kind = got.refreshError && got.refreshError.kind;
          if (kind === 'invalid_grant') { markAuthRequired(c); throw reauthError(); }   // the AS said the GRANT is dead
          if (kind) {
            // the refresh could not REACH the authorization server (or failed for a non-grant reason): the grant is
            // not known dead, so this is an outage, not a reauth prompt. Honest error + bounded backoff; the
            // reconnect timer re-runs the refresh on its next attempt.
            bumpEpoch(c); teardown(c); c.tools = []; c.resources = []; c.prompts = [];
            setState(c, 'error', 'sign-in refresh failed (' + kind + ') — the server rejected the current token and the refresh could not complete; retrying');
            scheduleReconnect(c);
            throw new Error('connector "' + c.id + '" could not refresh its sign-in (' + kind + '); retrying shortly');
          }
          if (reconnectedSince()) { toolStillPublished(c, toolName); return httpCall(c, toolName, args, true); }
          const r = await sharedConnect(c);
          if (c.client && c.state === 'up') {
            // the fresh credential was ACCEPTED — this is not an auth outage. Retry once; a vanished tool is its
            // own honest error, not a reauth prompt.
            toolStillPublished(c, toolName);
            return httpCall(c, toolName, args, true);
          }
          // the SHARED reconnect settled somewhere other than up. Only ITS OWN 401 handshake is auth truth; a
          // superseded attempt (a concurrent Reload/configure) or a plain connect failure already recorded its
          // honest state and must not be rewritten as "reauthentication required".
          if ((r && r.authRequired) || c.authRequired) { markAuthRequired(c); throw reauthError(); }
          throw e;
        }
        /* SESSION EXPIRY. A streamable-HTTP server answers a request carrying a stale `Mcp-Session-Id` with HTTP
           404 and the spec's remedy is: start a new session (re-initialize). Counting that toward the
           consecutive-failure net flipped a healthy connector to "unreachable" after three idle-expired calls.
           ONE re-initialize (a fresh transport = no session id) + retry; a second 404 is a real miss and falls
           through to the ordinary failure accounting below. */
        if (SESSION_404.test(msg) && !isRetry) {
          const failsBefore = c._callFails || 0;
          if (!(c._epoch !== epochAtCall && c.client && c.state === 'up')) await sharedConnect(c);
          if (c.client && c.state === 'up') {
            c._callFails = failsBefore;   // a re-initialize is not a successful CALL — a persistent 404 still accrues
            toolStillPublished(c, toolName);
            return httpCall(c, toolName, args, true);
          }
          throw e;
        }
        if (CALL_FAIL_LIMIT > 0) {
          c._callFails = (c._callFails || 0) + 1;
          if (c._callFails >= CALL_FAIL_LIMIT && c.state === 'up') { onTransportDeath(c, c._epoch, 'connector unreachable (' + c._callFails + ' consecutive call failures)'); }
        }
        throw e;
      }
    }

    // READ-ONLY tool lookup for the host's typed connector read-back (task-postconditions): the raw published
    // tool + whether the server self-declares readOnlyHint. Null when the connector is not up or the tool is
    // not published. Never executes anything.
    function toolInfo(id, toolName) {
      const c = conns.get(String(id));
      if (!c || configIssue(c) || (c.state !== 'up' && c.state !== 'cached')) return null;
      const t = (c.tools || []).find(x => x && x.name === String(toolName));
      if (!t) return null;
      return { name: t.name, readOnlyHint: !!(t.annotations && t.annotations.readOnlyHint === true), state: c.state };
    }
    function toolDefsFor(id) {
      const c = conns.get(String(id));
      if (!c || configIssue(c) || (c.state !== 'up' && c.state !== 'cached')) return [];
      const bound = (toolName, args, ctx) => call(c.id, toolName, args, ctx);   // ctx rides through for connector_required
      const defs = (c.tools || []).map(t => makeToolDef({ connectorId: c.id, label: c.label, mcpTool: t, call: bound, localProcess: c.transportKind === 'stdio' }));
      /* The resources/prompts tools are projected ONLY for a server that actually publishes them, so a
         tools-only connector's catalogue is byte-identical to before — nobody pays schema bytes for a
         primitive their server does not serve. They ride the same projection as tools, which is why they
         need no new registration site: index.js already registers whatever this returns, unions the names
         into the resolved grant set, and marks them network + consent-gated. */
      if (makeAuxDefs) {
        // THE SERVER'S OWN TOOL WINS THE NAME. A server that publishes a tool literally named
        // 'resources'/'prompts' AND the matching capability collided with these host-authored browse
        // tools on the fixed name mcp__<id>__resources — and registry.register is last-write-wins, so
        // appending the aux def OVERWROTE the real tool (while the per-agent path, first-wins, kept it:
        // the two projections disagreed). Skip an aux def whose name a real tool already claimed.
        const claimed = {};
        for (const d of defs) claimed[d.name] = true;
        for (const d of makeAuxDefs({
          connectorId: c.id, label: c.label,
          listResources: (c.resources || []).length ? (() => Promise.resolve(c.resources)) : null,
          readResource: (c.resources || []).length ? ((uri) => readResource(c.id, uri)) : null,
          listPrompts: (c.prompts || []).length ? (() => Promise.resolve(c.prompts)) : null,
          getPrompt: (c.prompts || []).length ? ((n, a) => getPrompt(c.id, n, a)) : null
        })) { if (!claimed[d.name]) defs.push(d); }
      }
      return defs;
    }

    // PER-AGENT projection: given the objects placed in ONE agent's room, return the tool defs for every
    // connector object found there, de-duplicated by wire name (two portals to the same connector collapse).
    function toolDefsForObjects(objects) {
      const out = [], seen = {};
      for (const obj of (objects || [])) {
        const cid = connectorIdOf(obj);
        if (!cid || !conns.has(cid)) continue;
        for (const def of toolDefsFor(cid)) { if (seen[def.name]) continue; seen[def.name] = true; out.push(def); }
      }
      return out;
    }

    async function close() {
      for (const c of conns.values()) teardown(c);
      conns.clear();
    }

    function sweepLifecycle() {
      let recycled = 0;
      for (const c of conns.values()) {
        const issue = configIssue(c);
        if (issue && c.transportKind === 'stdio') {
          if (c.client && recycle(c, 'stdio process stopped because its Safe Cell ownership is no longer valid')) recycled++;
          setState(c, 'error', issue);
        } else if (lifecycleExpired(c) && recycle(c, 'stdio process recycled by lifecycle limit')) recycled++;
      }
      return { recycled: recycled };
    }

    /* The RESOURCES + PROMPTS read path. Served from the connect-time cache for lists (so a listing costs no
       round trip and cannot hang a turn) and live for the two fetches, because a resource's CONTENT is the
       thing that changes between reads — caching that would hand the agent a stale document and call it
       current. An unknown/down connector is an honest error, never an empty list that reads as "nothing here". */
    const upConn = (id) => {
      const c = conns.get(String(id));
      if (!c) throw new Error('unknown connector: ' + id);
      if (!c.client || c.state !== 'up') throw new Error('connector ' + c.id + ' is ' + (c.state || 'down') + (c.detail ? ' (' + c.detail + ')' : ''));
      return c;
    };
    const resourcesFor = (id) => (conns.get(String(id)) || {}).resources || [];
    const promptsFor = (id) => (conns.get(String(id)) || {}).prompts || [];
    const readResource = async (id, uri) => {
      const c = conns.get(String(id)); if (!c) return upConn(id);
      if (c.transportKind === 'stdio') await ensureLive(c);
      const current = (c.resources || []).some(r => r && (r.uri === uri || (r.uriTemplate && String(uri).indexOf(String(r.uriTemplate).split('{')[0]) === 0)));
      if (!current) throw new Error('connector resource is no longer published by the current server');
      return upConn(id).client.readResource(uri);
    };
    const getPrompt = async (id, name, args) => {
      const c = conns.get(String(id)); if (!c) return upConn(id);
      if (c.transportKind === 'stdio') await ensureLive(c);
      if (!(c.prompts || []).some(p => p && p.name === name)) throw new Error('connector prompt is no longer published by the current server');
      return upConn(id).client.getPrompt(name, args);
    };

    return { configure, remove, refresh, close, status, list, has, ids, toolDefsFor, toolDefsForObjects, toolInfo, call, resourcesFor, promptsFor, readResource, getPrompt, sweepLifecycle, _internals: { connectorIdOf } };
  }

  return { makeConnectorManager, _internals: { connectorIdOf } };
});
