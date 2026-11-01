/* sidecar/channels/discord.transport.js — the Discord transport behind the generic channel adapter (P3.2).

   Discord differs from Telegram: inbound messages arrive over a WebSocket GATEWAY (push), not an HTTP long-poll.
   We bridge that to the adapter's getUpdates()/send() seam: a `connectGateway` source pushes raw MESSAGE_CREATE
   payloads into an internal BUFFER, and getUpdates() drains that buffer (parking briefly when empty, exactly like
   a long-poll). send() is a plain REST POST to the channel. `connectGateway` is INJECTED (prod supplies a real
   WebSocket client; tests supply a fake that feeds messages), so this module — like its Telegram sibling — touches
   no real network in tests and stays deterministic.

     makeDiscordTransport({ fetch, token, connectGateway?, apiBase?, clock?, sleep? }) ->
       { getUpdates({ signal }) -> raw[], send(channelId, text, opts?) -> SendResult, connect(), disconnect() }

   send() NEVER throws — a failure is a normalized { ok:false, error, retryable?, retryAfter? } so the adapter's
   one-shot resend can act (mirrors the Telegram transport contract). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.discordTransport = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const API = 'https://discord.com/api/v10';
  const DEFAULT_PARK_MS = 800;     // how long getUpdates parks when the buffer is empty before returning []

  function makeDiscordTransport(opts) {
    const o = opts || {};
    const fetchImpl = o.fetch;
    const token = String(o.token || '');
    const apiBase = o.apiBase || API;
    const connectGateway = typeof o.connectGateway === 'function' ? o.connectGateway : null;
    const parkMs = (typeof o.parkMs === 'number') ? o.parkMs : DEFAULT_PARK_MS;
    const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    if (typeof fetchImpl !== 'function') throw new Error('makeDiscordTransport: an injected fetch is required');

    const buffer = [];        // raw MESSAGE_CREATE `d` payloads, oldest-first
    let gateway = null;       // the live gateway handle (from connectGateway), if connected

    // the gateway source pushes each raw message here; getUpdates drains it.
    function onGatewayMessage(raw) { if (raw && typeof raw === 'object') buffer.push(raw); }
    // open the gateway once (idempotent). prod: a real WS identify/heartbeat loop calling onGatewayMessage; tests
    // inject a fake. No connectGateway -> ingress is inert (send still works) — honest when no WS is wired.
    function ensureGateway() { if (!gateway && connectGateway) gateway = connectGateway({ token, onMessage: onGatewayMessage }); }
    function closeGateway() { try { if (gateway && typeof gateway.close === 'function') gateway.close(); } catch (_) {} gateway = null; }

    return {
      connect() { ensureGateway(); },
      disconnect() { closeGateway(); },

      // drain the buffer the gateway filled. The adapter never calls transport.connect(), so we open the gateway
      // lazily here on the first poll, and close it when the adapter aborts. Returns immediately when there's
      // something; otherwise parks briefly (so the poll loop doesn't busy-spin), mirroring a long-poll.
      async getUpdates(args) {
        const signal = args && args.signal;
        if (signal && signal.aborted) { closeGateway(); return []; }
        ensureGateway();
        if (!buffer.length) { await sleep(parkMs); }
        if (signal && signal.aborted) { closeGateway(); return []; }
        return buffer.splice(0, buffer.length);
      },

      // POST a message to a channel. Never throws — normalized SendResult for the adapter's resend.
      async send(channelId, text, sendOpts) {
        try {
          const res = await fetchImpl(apiBase + '/channels/' + encodeURIComponent(String(channelId)) + '/messages', {
            method: 'POST',
            headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: String(text == null ? '' : text) }),
            signal: sendOpts && sendOpts.signal
          });
          if (res && res.ok) {
            let id; try { const j = await res.json(); id = j && j.id; } catch (_) {}
            return { ok: true, messageId: id != null ? String(id) : undefined };
          }
          const status = res ? res.status : 0;
          // 429 carries Retry-After; 5xx is retryable; 4xx (bad token/permission) is not.
          let retryAfter; try { retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || undefined; } catch (_) {}
          const retryable = status === 429 || (status >= 500 && status < 600);
          // auth: the bot TOKEN was refused (401) — channel-wide, kept queued for the re-paired bot (channels/hub.js deliver);
          // a 403/404 is about this one channel (no access / gone) and is not
          return { ok: false, error: 'discord http ' + status, retryable, auth: status === 401, retryAfter };
        } catch (e) {
          if (e && (e.name === 'AbortError')) return { ok: false, error: 'aborted', retryable: false };
          return { ok: false, error: String((e && e.message) || e), retryable: true };   // network blip -> resend
        }
      }
    };
  }

  return { makeDiscordTransport };
});
