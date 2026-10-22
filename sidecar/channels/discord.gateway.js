/* sidecar/channels/discord.gateway.js — the REAL Discord gateway v10 WebSocket client (P2-E).

   discord.transport.js bridges inbound over an INJECTED `connectGateway({ token, onMessage }) -> { close() }`
   source. Until now the only real injection was a fake in tests, so ingress was inert (send worked; receive
   didn't). This module is that missing default: a standard Discord gateway v10 client that turns a bot token +
   the injected onMessage(raw) callback into a live push of raw MESSAGE_CREATE `d` payloads — exactly the shape
   discord.js normalize() already parses.

   The flow (Discord gateway v10):
     1. GET {apiBase}/gateway/bot (Bot auth) -> the wss:// URL.
     2. Open the WS. Wait for op 10 HELLO -> heartbeat_interval.
     3. Heartbeat every interval (first beat jittered) with op 1 { d: last_seq }. Track ACKs (op 11); a missed
        ACK means a zombied connection -> reconnect.
     4. IDENTIFY (op 2) with the token + intents (GUILDS | DIRECT_MESSAGES). The channel is DM-only, and Discord
        delivers DM text WITHOUT the privileged MESSAGE_CONTENT intent, so we never ask for it: forgetting that
        portal toggle used to kill the connection (close 4014) for nothing (2026-10-11 user report).
     5. On READY (dispatch): record session_id, resume_gateway_url, and our own bot user id (to ignore self).
     6. On every dispatch: bump last_seq. On MESSAGE_CREATE: skip our own author.id, else onMessage(d).
     7. op 7 RECONNECT / op 9 INVALID_SESSION -> reconnect; RESUME (op 6) with session_id + seq when the session
        is resumable, else a fresh IDENTIFY. Exponential backoff (capped, jittered) on unexpected drops.

   Everything ambient is INJECTED so this is unit-testable with a fake WS + fake timers and touches no real
   network under test: { token, onMessage, fetch?, WebSocketImpl?, apiBase?, gatewayUrl?, setTimeoutImpl?,
   clearTimeoutImpl?, now?, random?, onState?, intents?, log? }. In production, sidecar/index.js injects nothing
   extra — the defaults resolve to Node's global fetch + global WebSocket (Node >= 21 / 22). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.discordGateway = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const API = 'https://discord.com/api/v10';
  const GATEWAY_VERSION = 10;

  // gateway opcodes we handle
  const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };
  // intents bitfield: GUILDS(1<<0) | GUILD_MESSAGES(1<<9) | MESSAGE_CONTENT(1<<15) | DIRECT_MESSAGES(1<<12)
  const INTENT = { GUILDS: 1 << 0, GUILD_MESSAGES: 1 << 9, DIRECT_MESSAGES: 1 << 12, MESSAGE_CONTENT: 1 << 15 };
  const DEFAULT_INTENTS = INTENT.GUILDS | INTENT.DIRECT_MESSAGES;

  const BACKOFF_BASE_MS = 1000;      // first reconnect delay
  const BACKOFF_MAX_MS = 30000;      // cap
  // resumable close codes: anything NOT in this "do-not-resume" set is treated as resumable.
  const NON_RESUMABLE_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);   // auth/intents/sharding = fatal-ish
  const FATAL_CLOSE = new Set([4004, 4013, 4014]);   // bad token / invalid or disallowed intents — stop for good
  // What the user can actually do about each fatal close, in their words (the panel shows this detail verbatim).
  const FATAL_DETAIL = {
    4004: 'Discord rejected the bot token (4004). In the Developer Portal open your app, Bot, Reset Token, and paste the new token.',
    4013: 'Discord refused the requested intents as invalid (4013). This is a Agent OS bug; please report it.',
    4014: 'Discord refused a privileged intent (4014). Turn it on under Bot, Privileged Gateway Intents in the Developer Portal.'
  };

  function makeDiscordGateway(opts) {
    const o = opts || {};
    const token = String(o.token || '');
    const onMessage = typeof o.onMessage === 'function' ? o.onMessage : function () {};
    const onState = typeof o.onState === 'function' ? o.onState : function () {};
    const fetchImpl = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    const WebSocketImpl = o.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    const setTimeoutImpl = o.setTimeoutImpl || ((typeof setTimeout !== 'undefined') ? setTimeout : null);
    const clearTimeoutImpl = o.clearTimeoutImpl || ((typeof clearTimeout !== 'undefined') ? clearTimeout : null);
    // time/rng arrive INJECTED (the host — the composition root — supplies real ones; tests supply deterministic
    // fakes). Benign, non-ambient fallbacks keep the module pure: a fixed clock and a jitter-free rng. The host
    // ALWAYS injects real ones, so backoff/heartbeat jitter is live in production.
    const now = o.now || (() => 0);
    const random = (typeof o.random === 'function') ? o.random : (() => 0.5);
    const apiBase = o.apiBase || API;
    const intents = (typeof o.intents === 'number') ? o.intents : DEFAULT_INTENTS;
    const staticGatewayUrl = o.gatewayUrl || null;     // tests can skip the GET /gateway/bot round-trip
    const log = o.log || function () {};
    if (!token) throw new Error('makeDiscordGateway: a bot token is required');
    if (typeof fetchImpl !== 'function') throw new Error('makeDiscordGateway: fetch is unavailable (inject WebSocketImpl/fetch)');
    if (typeof WebSocketImpl !== 'function') throw new Error('makeDiscordGateway: WebSocket is unavailable (Node >= 21, or inject WebSocketImpl)');

    // --- session/connection state, reset per (re)connect ---
    let ws = null;
    let closed = false;             // caller asked us to shut down for good
    let hbTimer = null;             // periodic heartbeat timer
    let hbFirst = null;             // one-shot jittered first-beat timer
    let reconnectTimer = null;
    let lastSeq = null;             // s from the last dispatch — sent with heartbeats + RESUME
    let sessionId = null;           // from READY — enables RESUME
    let resumeUrl = null;           // resume_gateway_url from READY
    let botUserId = null;           // our own user.id — ignore our own MESSAGE_CREATE
    let heartbeatInterval = 0;
    let awaitingAck = false;        // set on each beat, cleared on ACK; a beat with it still set = zombie -> reconnect
    let backoffAttempt = 0;         // exponential backoff counter, reset on a clean READY
    let identifiedThisConn = false; // whether we've sent IDENTIFY/RESUME on the current socket

    function setState(state, detail) { try { onState({ state, detail: detail || '' }); } catch (_) {} }

    function clearTimers() {
      if (hbTimer != null) {
        // hbTimer is an interval handle from setInterval2 ({ cancelled, t }) — cancel the loop AND its pending timer.
        try { hbTimer.cancelled = true; if (hbTimer.t != null) clearTimeoutImpl(hbTimer.t); } catch (_) {}
        hbTimer = null;
      }
      if (hbFirst != null) { try { clearTimeoutImpl(hbFirst); } catch (_) {} hbFirst = null; }
    }

    function safeSend(obj) {
      try { if (ws && ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(obj)); }
      catch (e) { log('send failed: ' + ((e && e.message) || e)); }
    }

    function sendHeartbeat() {
      // if the previous beat was never ACKed, the connection is a zombie — drop and reconnect (resume).
      if (awaitingAck) { log('heartbeat not ACKed — zombie connection, reconnecting'); return reconnect(true, true); }
      awaitingAck = true;
      safeSend({ op: OP.HEARTBEAT, d: lastSeq });
    }

    function startHeartbeat(intervalMs) {
      heartbeatInterval = intervalMs;
      clearTimers();
      awaitingAck = false;
      // first beat after interval * jitter (Discord guidance), then every interval.
      const firstDelay = Math.floor(intervalMs * random());
      hbFirst = setTimeoutImpl(function () {
        hbFirst = null;
        sendHeartbeat();
        hbTimer = setInterval2(sendHeartbeat, intervalMs);
      }, firstDelay);
    }

    // setInterval built from the injected setTimeout so tests only need to fake ONE timer primitive.
    function setInterval2(fn, ms) {
      let handle = { cancelled: false };
      const tick = () => {
        if (handle.cancelled || closed) return;
        try { fn(); } catch (_) {}
        if (!handle.cancelled && !closed) handle.t = setTimeoutImpl(tick, ms);
      };
      handle.t = setTimeoutImpl(tick, ms);
      // return something clearTimeoutImpl can accept: we intercept in clearTimers via cancelled flag.
      handle.__isInterval = true;
      return handle;
    }

    function identify() {
      identifiedThisConn = true;
      safeSend({
        op: OP.IDENTIFY,
        d: {
          token: token,
          intents: intents,
          properties: { os: process.platform || 'linux', browser: 'starnet', device: 'starnet' }
        }
      });
    }

    function resume() {
      identifiedThisConn = true;
      safeSend({ op: OP.RESUME, d: { token: token, session_id: sessionId, seq: lastSeq } });
    }

    function handleDispatch(payload) {
      if (payload.s != null) lastSeq = payload.s;
      const t = payload.t;
      const d = payload.d || {};
      if (t === 'READY') {
        sessionId = d.session_id || null;
        resumeUrl = d.resume_gateway_url || null;
        botUserId = (d.user && d.user.id != null) ? String(d.user.id) : botUserId;
        backoffAttempt = 0;
        immediateStreak = 0; guidedStreak = 0;   // a real READY proves the reconnect path healthy again
        setState('up', '');
        log('READY — session ' + (sessionId ? sessionId.slice(0, 6) + '…' : '?') + ', bot ' + (botUserId || '?'));
        return;
      }
      if (t === 'RESUMED') { immediateStreak = 0; guidedStreak = 0; setState('up', ''); log('RESUMED'); return; }
      if (t === 'MESSAGE_CREATE') {
        // never act on our own messages (avoids the bot talking to itself).
        const author = d.author || {};
        if (botUserId && String(author.id) === botUserId) return;
        try { onMessage(d); } catch (e) { log('onMessage threw: ' + ((e && e.message) || e)); }
      }
      // other dispatch events (TYPING_START, GUILD_CREATE, …) are ignored — normalize() only wants MESSAGE_CREATE.
    }

    function handleFrame(raw) {
      let payload;
      try { payload = JSON.parse(typeof raw === 'string' ? raw : String(raw)); }
      catch (_) { return; }
      switch (payload.op) {
        case OP.DISPATCH: return handleDispatch(payload);
        case OP.HELLO: {
          const iv = (payload.d && payload.d.heartbeat_interval) || 41250;
          startHeartbeat(iv);
          // resume if we have a live session; otherwise identify fresh.
          if (sessionId && lastSeq != null) resume(); else identify();
          return;
        }
        case OP.HEARTBEAT: return sendHeartbeat();   // server asked for an immediate beat
        case OP.HEARTBEAT_ACK: { awaitingAck = false; return; }
        case OP.RECONNECT: { log('op 7 reconnect requested'); return reconnect(true, true); }
        case OP.INVALID_SESSION: {
          // d === true means the session is resumable; false means start fresh.
          const resumable = payload.d === true;
          log('op 9 invalid session (resumable=' + resumable + ')');
          // Discord's own guidance: wait 1-5s before re-identifying after op 9. The old immediate
          // reconnect made a persistently invalid session (identify rate-limit, unresumable) a ZERO-DELAY
          // ws+REST loop — each iteration also hitting GET /gateway/bot — which ends in a CloudFlare ban.
          return reconnect(resumable, true, 1000 + Math.floor(random() * 4000));
        }
        default: return;
      }
    }

    // The ONE reconnect entry point. Tears down the current socket + timers and schedules exactly one reconnect
    // (idempotent — guarded by `reconnecting`). `immediate` skips backoff (op 7 / op 9 / zombie: reconnect now);
    // otherwise an exponential-backoff delay is used (an unexpected drop). `canResume` keeps session_id+seq so the
    // next HELLO RESUMEs; false clears them so it IDENTIFYs fresh.
    let reconnecting = false;
    let immediateStreak = 0;   // consecutive 0ms (op 7/zombie) reconnects without an intervening READY/RESUMED
    let guidedStreak = 0;      // consecutive fixed-delay (op 9) reconnects without an intervening READY/RESUMED
    function reconnect(canResume, immediate, fixedDelayMs) {
      if (closed || reconnecting) return;
      reconnecting = true;
      clearTimers();
      const sock = ws; ws = null; identifiedThisConn = false;
      if (sock) { try { sock.__dead = true; } catch (_) {} try { sock.onclose = null; sock.onmessage = null; sock.onerror = null; sock.onopen = null; } catch (_) {} try { sock.close(); } catch (_) {} }
      if (!canResume) { sessionId = null; lastSeq = null; }
      // `immediate` skips backoff for the FIRST couple of attempts only: op 7 / a zombie heartbeat wants a
      // fast resume, but if the server keeps bouncing us before READY ever lands, an unconditional 0ms was
      // a reconnect storm with no ceiling (backoffAttempt was neither read nor bumped on this path).
      // A fixed delay (op 9's guided 1-5s wait) gets the same escalation: without it a persistently
      // invalid session was a flat 1-5s IDENTIFY loop forever — a slower ban, not no ban. After a few
      // consecutive no-READY attempts the exponential backoff takes over (floored at the guided wait).
      const delay = fixedDelayMs != null
        ? (guidedStreak++ < 3 ? fixedDelayMs : Math.max(fixedDelayMs, backoffDelay()))
        : immediate ? (immediateStreak++ < 2 ? 0 : backoffDelay())
        : backoffDelay();
      if (delay > 0) setState('reconnecting', 'retry in ' + Math.round(delay / 1000) + 's');
      reconnectTimer = setTimeoutImpl(function () { reconnectTimer = null; reconnecting = false; openConnection(); }, delay);
    }

    function backoffDelay() {
      const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, backoffAttempt));
      backoffAttempt++;
      return Math.floor(exp * (0.5 + 0.5 * random()));   // jitter in [0.5x, 1x]
    }

    async function resolveGatewayUrl() {
      // prefer the resume URL from a prior READY, then a statically injected url, else GET /gateway/bot.
      if (resumeUrl && sessionId) return withVersion(resumeUrl);
      if (staticGatewayUrl) return withVersion(staticGatewayUrl);
      const res = await fetchImpl(apiBase + '/gateway/bot', { headers: { 'Authorization': 'Bot ' + token } });
      if (!res || !res.ok) {
        const status = res ? res.status : 0;
        if (status === 401 || status === 403) { const e = new Error('discord gateway auth failed (' + status + ')'); e.fatal = true; throw e; }
        throw new Error('GET /gateway/bot failed: ' + status);
      }
      const j = await res.json();
      return withVersion((j && j.url) || 'wss://gateway.discord.gg');
    }

    function withVersion(url) {
      const sep = url.indexOf('?') === -1 ? '?' : '&';
      if (/[?&]v=/.test(url)) return url;
      return url + sep + 'v=' + GATEWAY_VERSION + '&encoding=json';
    }

    async function openConnection() {
      if (closed) return;
      let url;
      try { url = await resolveGatewayUrl(); }
      catch (e) {
        if (e && e.fatal) { setState('error', (e && e.message) || 'auth failed'); log('fatal: ' + e.message); closed = true; return; }
        setState('error', (e && e.message) || 'gateway url failed');
        return reconnect(true, false);   // transient: back off and retry (keep any session)
      }
      let sock;
      try { sock = new WebSocketImpl(url); }
      catch (e) { setState('error', 'ws open failed'); return reconnect(true, false); }
      ws = sock;
      identifiedThisConn = false;
      setState('connecting', '');

      const onOpen = () => { log('ws open'); };
      const onMsg = (ev) => handleFrame(ev && ev.data != null ? ev.data : ev);
      const onErr = () => { log('ws error'); /* close will follow; let onClose drive reconnect */ };
      const onClose = (ev) => {
        if (sock.__dead) return;   // we already tore this socket down via reconnect()/close() — ignore its late close
        const code = (ev && (ev.code != null ? ev.code : ev)) || 1006;
        clearTimers();
        if (ws === sock) ws = null;
        if (closed) { setState('down', ''); return; }
        if (FATAL_CLOSE.has(code)) { setState('error', FATAL_DETAIL[code] || ('gateway closed ' + code)); log('fatal close ' + code); closed = true; return; }
        const resumable = !NON_RESUMABLE_CLOSE.has(code);
        log('ws closed ' + code + ' (resumable=' + resumable + ')');
        setState('down', 'reconnecting (' + code + ')');
        reconnect(resumable, false);   // unexpected drop -> backoff reconnect (RESUME when resumable)
      };

      // support both addEventListener (browser/global WS) and .on (node ws lib) shapes.
      if (typeof sock.addEventListener === 'function') {
        sock.addEventListener('open', onOpen);
        sock.addEventListener('message', onMsg);
        sock.addEventListener('error', onErr);
        sock.addEventListener('close', onClose);
      } else {
        sock.onopen = onOpen; sock.onmessage = onMsg; sock.onerror = onErr; sock.onclose = onClose;
      }
    }

    // kick it off immediately (backoffAttempt 0 -> no delay).
    setState('connecting', '');
    openConnection();

    return {
      // the connectGateway contract: transport calls close() on disconnect/abort.
      close() {
        closed = true;
        clearTimers();
        if (reconnectTimer != null) { try { clearTimeoutImpl(reconnectTimer); } catch (_) {} reconnectTimer = null; }
        const sock = ws; ws = null;
        if (sock) { try { sock.__dead = true; sock.onclose = null; } catch (_) {} try { sock.close(1000, 'client shutdown'); } catch (_) {} }
        setState('down', '');
      },
      // introspection for tests/status (never exposes the token).
      _state() { return { sessionId, lastSeq, botUserId, heartbeatInterval, awaitingAck, closed, backoffAttempt, connected: !!ws }; }
    };
  }

  // a factory that adapts makeDiscordGateway to the transport's connectGateway({ token, onMessage }) seam,
  // pre-binding any host deps (WebSocketImpl/fetch/onState/log). This is what sidecar/index.js injects.
  function makeConnectGateway(hostDeps) {
    const h = hostDeps || {};
    return function connectGateway(args) {
      const a = args || {};
      return makeDiscordGateway(Object.assign({}, h, { token: a.token, onMessage: a.onMessage }));
    };
  }

  return { makeDiscordGateway, makeConnectGateway, OP, INTENT, DEFAULT_INTENTS, _internals: { NON_RESUMABLE_CLOSE, FATAL_CLOSE } };
});
