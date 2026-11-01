/* sidecar/channels/slack.transport.js — the ONLY network-touching piece of the Slack channel.

   Slack differs from Telegram the same way Discord does: inbound messages arrive over a push socket, not an
   HTTP long-poll. Slack's local-first path is SOCKET MODE — no public webhook URL needed: an app-level token
   (xapp-…) opens a WebSocket via apps.connections.open, event envelopes arrive over it (each must be ACKed by
   envelope_id), and sends are plain REST chat.postMessage calls with the bot token (xoxb-…).

   We bridge that push to the adapter's getUpdates()/send() seam exactly like discord.transport.js: the socket
   fills an internal BUFFER, getUpdates() drains it (parking briefly when empty), and a dropped socket simply
   reopens lazily on the next poll (the poll cadence IS the backoff). A fatal auth failure (invalid_auth /
   not_allowed_token_type on apps.connections.open) is remembered and THROWN from the next getUpdates with
   `.fatal=true`, so the adapter's loop stops for good with an honest error status.

     makeSlackTransport({ fetch, botToken, appToken, WebSocketImpl, apiBase?, sleep?, parkMs? }) ->
       { getUpdates({ signal }) -> raw[], send(channelId, text, opts?) -> SendResult, connect(), disconnect() }

   Both tokens live in closure and appear only in Authorization headers to slack.com — never on an event, the
   bus, or a log. `fetch` + `WebSocketImpl` are INJECTED (index.js passes the globals; tests pass fakes), so this
   module touches no real network under test and stays deterministic (no clock/rng/Date). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.slackTransport = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const API = 'https://slack.com/api';
  const DEFAULT_PARK_MS = 800;   // how long getUpdates parks when the buffer is empty before returning []
  const FATAL_OPEN_ERRORS = ['invalid_auth', 'not_allowed_token_type', 'forbidden', 'account_inactive', 'token_revoked'];
  // chat.postMessage errors that refuse the BOT TOKEN itself (every channel alike), not the one channel it was aimed at
  const SEND_AUTH_ERRORS = ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'missing_scope', 'not_allowed_token_type'];

  function makeSlackTransport(opts) {
    const o = opts || {};
    const fetchImpl = o.fetch;
    const botToken = String(o.botToken || '');
    const appToken = String(o.appToken || '');
    const WebSocketImpl = o.WebSocketImpl;
    const apiBase = o.apiBase || API;
    const parkMs = (typeof o.parkMs === 'number') ? o.parkMs : DEFAULT_PARK_MS;
    const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    if (typeof fetchImpl !== 'function') throw new Error('makeSlackTransport: an injected fetch is required');
    if (!botToken) throw new Error('makeSlackTransport: a bot token (xoxb-…) is required');
    if (!appToken) throw new Error('makeSlackTransport: an app-level token (xapp-…) is required');
    if (typeof WebSocketImpl !== 'function') throw new Error('makeSlackTransport: WebSocket is unavailable (Node >= 21, or inject WebSocketImpl)');

    const buffer = [];      // raw Slack event payloads (envelope.payload.event), oldest-first
    let ws = null;          // the live socket, if open
    let opening = false;    // an apps.connections.open round-trip is in flight
    let stopped = false;    // caller asked us to shut down for good
    let fatalError = null;  // a non-recoverable auth failure — thrown from the next getUpdates
    let everOpened = false; // has apps.connections.open EVER succeeded (real transport proof)? — honest connect gate

    function closeSocket() { try { if (ws && typeof ws.close === 'function') ws.close(); } catch (_) {} ws = null; }

    async function openGateway() {
      if (ws || opening || stopped || fatalError) return;
      opening = true;
      try {
        const res = await fetchImpl(apiBase + '/apps.connections.open', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + appToken, 'content-type': 'application/x-www-form-urlencoded' }
        });
        let data = null;
        try { data = await res.json(); } catch (e) {}
        if (!res || !res.ok || !data || data.ok !== true || !data.url) {
          const why = (data && data.error) || ('http ' + ((res && res.status) || 0));
          if (data && FATAL_OPEN_ERRORS.indexOf(String(data.error)) >= 0) {
            const err = new Error('slack socket-mode open refused: ' + why + ' — check the app-level token (xapp-…) has connections:write');
            err.fatal = true;
            fatalError = err;
          }
          return;   // transient open failure -> next poll retries (poll cadence is the backoff)
        }
        const sock = new WebSocketImpl(data.url);
        everOpened = true;   // apps.connections.open succeeded with a real socket URL — the app-level token is proven
        sock.onmessage = (ev) => {
          let msg = null;
          try { msg = JSON.parse(String(ev && ev.data)); } catch (e) { return; }
          if (!msg) return;
          // every envelope must be ACKed promptly or Slack redelivers, then drops the connection.
          if (msg.envelope_id) { try { sock.send(JSON.stringify({ envelope_id: msg.envelope_id })); } catch (_) {} }
          if (msg.type === 'events_api' && msg.payload && msg.payload.event) buffer.push(msg.payload.event);
          else if (msg.type === 'disconnect') { try { sock.close(); } catch (_) {} }   // Slack asks us to refresh -> lazy reopen
        };
        sock.onclose = () => { if (ws === sock) ws = null; };
        sock.onerror = () => { try { sock.close(); } catch (_) {} if (ws === sock) ws = null; };
        ws = sock;
      } catch (e) {
        // network blip on the open call -> stay disconnected; the next poll retries
      } finally {
        opening = false;
      }
    }

    return {
      connect() { return openGateway(); },
      disconnect() { stopped = true; closeSocket(); },

      // drain the buffer the socket filled; open the socket lazily on the first poll (mirrors discord.transport).
      async getUpdates(args) {
        const signal = args && args.signal;
        if (signal && signal.aborted) { stopped = true; closeSocket(); return []; }
        if (fatalError) throw fatalError;
        await openGateway();
        if (fatalError) throw fatalError;
        // Events the socket buffered before dropping still get delivered — never stranded behind a reconnect.
        if (buffer.length) return buffer.splice(0, buffer.length);
        // HONEST CONNECT + HONEST RECONNECT: an empty poll does NOT prove the channel is up — there may simply be
        // no live socket right now, either because apps.connections.open has never succeeded (bad first open) or
        // because the socket DROPPED and the reopen above failed transiently. Both used to fall through to a
        // "successful" [] return, so the adapter kept the panel CONNECTED on a dead socket forever. Surface a
        // transient (non-fatal) error instead: the adapter reports down/connecting and backs off, and the next
        // poll's openGateway() keeps retrying until the socket is genuinely back.
        if (!ws) throw new Error(everOpened ? 'slack socket lost — reconnecting' : 'slack socket not open yet — retrying');
        if (!buffer.length) { await sleep(parkMs); }
        if (signal && signal.aborted) { stopped = true; closeSocket(); return []; }
        return buffer.splice(0, buffer.length);
      },

      // POST chat.postMessage. Never throws — normalized SendResult for the adapter's bounded resend.
      async send(channelId, text, sendOpts) {
        try {
          const res = await fetchImpl(apiBase + '/chat.postMessage', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + botToken, 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ channel: String(channelId), text: String(text == null ? '' : text) }),
            signal: sendOpts && sendOpts.signal
          });
          let data = null;
          try { data = await res.json(); } catch (e) {}
          if (res && res.ok && data && data.ok === true) return { ok: true, messageId: String((data.ts != null ? data.ts : (data.message && data.message.ts)) || '') };
          const status = res ? res.status : 0;
          const slackErr = (data && data.error) || '';
          let retryAfter; try { retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || undefined; } catch (_) {}
          const retryable = status === 429 || status >= 500 || slackErr === 'ratelimited';
          // auth: the bot TOKEN was refused or lacks a scope — channel-wide, kept queued for the re-paired app (channels/hub.js
          // deliver); not_in_channel / channel_not_found / is_archived are about this one channel and are not
          const auth = status === 401 || SEND_AUTH_ERRORS.indexOf(slackErr) >= 0;
          return { ok: false, error: slackErr || ('slack http ' + status), retryable, auth, retryAfter };
        } catch (e) {
          if (e && (e.name === 'AbortError')) return { ok: false, error: 'aborted', retryable: false };
          return { ok: false, error: String((e && e.message) || e), retryable: true };   // network blip -> resend
        }
      },

      _internals: { buffer, get ws() { return ws; }, get fatalError() { return fatalError; } }
    };
  }

  return { makeSlackTransport, FATAL_OPEN_ERRORS };
});
