/* sidecar/channels/matrix.transport.js — the ONLY network-touching piece of the Matrix channel.

   A thin fetch wrapper over the Matrix Client-Server API (any homeserver — matrix.org, a self-hosted Synapse,
   Conduit…), exposing the exact seam the generic adapter (channels/adapter.js) drives:

     getUpdates({ timeoutSec, signal }) -> Promise<raw[]>   // /sync long-poll; each raw = { roomId, event, selfId }
        (the injected `normalize` in matrix.js parses each one); THROWS on error so the adapter's poll loop
        governs backoff — a 401 (M_UNKNOWN_TOKEN / bad access token) is thrown with `.fatal=true`.
     send(roomId, text, opts?) -> Promise<SendResult>       // PUT m.room.message; NEVER throws — always a
        normalized { ok, messageId?, error?, retryable?, retryAfter? } so the adapter's one-shot resend can act.

   Backlog discipline (the Telegram drop-pending analogue): the FIRST sync runs with timeout=0 and its result is
   DISCARDED — only the `next_batch` token is kept — so a restart never replays hours of stale room history and
   autonomously runs stale directives. From then on `since` advances per poll (Matrix's own offset).

   Self-identity: on the first poll we resolve `/account/whoami` once and annotate every raw update with selfId so
   the pure normalize (matrix.js) can drop the agent's OWN messages without this module knowing the message shape.

   The access token is held in closure and appears ONLY in the Authorization header — never on an event, the bus,
   or a log. `fetch` and `newId` (txn ids for idempotent sends) are INJECTED, so this module touches no real
   network under test and stays deterministic (no clock/rng/Date). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.matrixTransport = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const API = '/_matrix/client/v3';

  function makeMatrixTransport(opts) {
    const o = opts || {};
    const fetchImpl = o.fetch;
    const token = o.token;
    const newId = o.newId;
    if (typeof fetchImpl !== 'function') throw new Error('makeMatrixTransport: an injected fetch is required');
    if (!token || typeof token !== 'string') throw new Error('makeMatrixTransport: an access token is required');
    if (typeof newId !== 'function') throw new Error('makeMatrixTransport: an injected newId (txn ids) is required');
    const BASE = String(o.homeserver || '').replace(/\/+$/, '');
    if (!BASE) throw new Error('makeMatrixTransport: a homeserver URL is required');
    const HEADERS = { 'Authorization': 'Bearer ' + token, 'content-type': 'application/json' };

    let since = '';        // Matrix's own resume token — advances per successful sync
    let selfId = '';       // resolved once via /whoami; annotated onto every raw update
    let primed = false;    // has the discard-backlog initial sync run?

    async function call(method, url, body, signal) {
      const res = await fetchImpl(url, { method: method, headers: HEADERS, body: body != null ? JSON.stringify(body) : undefined, signal: signal });
      let data;
      try { data = await res.json(); } catch (e) { data = null; }
      return { res: res, data: data };
    }

    function syncError(res, data) {
      const code = (res && res.status) || 0;
      const errcode = (data && data.errcode) || '';
      const err = new Error('matrix sync failed: ' + code + (errcode ? ' ' + errcode : '') + ((data && data.error) ? ' ' + data.error : ''));
      err.code = code;
      if (code === 401 || code === 403 || errcode === 'M_UNKNOWN_TOKEN') err.fatal = true;   // bad/expired access token -> stop for good
      return err;
    }

    // flatten one /sync response into raw updates: every m.room.* timeline event of every joined room.
    function flatten(data) {
      const out = [];
      const rooms = (data && data.rooms && data.rooms.join) || {};
      for (const roomId of Object.keys(rooms)) {
        const events = (rooms[roomId] && rooms[roomId].timeline && rooms[roomId].timeline.events) || [];
        for (const ev of events) out.push({ roomId: roomId, event: ev, selfId: selfId });
      }
      return out;
    }

    return {
      async getUpdates(args) {
        const a = args || {};
        // resolve our own user id once, so normalize can drop the agent's own echoes.
        if (!selfId) {
          const { res, data } = await call('GET', BASE + API + '/account/whoami', null, a.signal);
          if (!res || !res.ok) throw syncError(res, data);
          selfId = String((data && data.user_id) || '');
        }
        // first sync: timeout=0, DISCARD the backlog, keep only the resume token (drop-pending semantics).
        if (!primed) {
          const { res, data } = await call('GET', BASE + API + '/sync?timeout=0', null, a.signal);
          if (!res || !res.ok) throw syncError(res, data);
          since = String((data && data.next_batch) || '');
          primed = true;
          return [];
        }
        const timeoutMs = Math.max(0, (a.timeoutSec || 0) * 1000);
        const url = BASE + API + '/sync?timeout=' + timeoutMs + (since ? '&since=' + encodeURIComponent(since) : '');
        const { res, data } = await call('GET', url, null, a.signal);
        if (!res || !res.ok) throw syncError(res, data);
        since = String((data && data.next_batch) || since);
        return flatten(data);
      },

      // never throws: a network/abort/HTTP error becomes a SendResult so the adapter's bounded resend can run.
      async send(roomId, text, sendOpts) {
        const o2 = sendOpts || {};
        const url = BASE + API + '/rooms/' + encodeURIComponent(String(roomId)) + '/send/m.room.message/' + encodeURIComponent(newId());
        try {
          const { res, data } = await call('PUT', url, { msgtype: 'm.text', body: String(text == null ? '' : text) }, o2.signal);
          if (res && res.ok) return { ok: true, messageId: String((data && data.event_id) || '') };
          const code = (res && res.status) || 0;
          const retryAfterMs = data && (data.retry_after_ms != null ? data.retry_after_ms : null);
          return {
            ok: false,
            error: (data && (data.errcode || data.error)) || ('http ' + code),
            retryable: code === 429 || code >= 500,
            // auth: the ACCESS TOKEN was refused — channel-wide, kept queued for the re-paired account (channels/hub.js deliver);
            // a 403 M_FORBIDDEN is about this one room and is not
            auth: code === 401 || !!(data && (data.errcode === 'M_UNKNOWN_TOKEN' || data.errcode === 'M_MISSING_TOKEN')),
            retryAfter: retryAfterMs != null ? Math.ceil(Number(retryAfterMs) / 1000) : undefined
          };
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.aborted)) return { ok: false, error: 'aborted', retryable: false };
          return { ok: false, error: (e && e.message) || 'network error', retryable: true };
        }
      },

      _internals: { get since() { return since; }, get selfId() { return selfId; } }
    };
  }

  return { makeMatrixTransport };
});
