/* sidecar/channels/signal.transport.js — the ONLY network-touching piece of the Signal channel.

   Signal has no public bot HTTP API — the standard self-hosted bridge is the signal-cli REST API
   (github.com/bbernhard/signal-cli-rest-api, run in MODE=native or MODE=normal next to the sidecar — in json-rpc
   mode its receive endpoint is websocket-only, so this HTTP poll gets a 400 and stops). This transport is a
   thin fetch wrapper over that local endpoint, exposing the exact seam the generic adapter drives:

     getUpdates({ timeoutSec, signal }) -> Promise<raw[]>   // GET /v1/receive/<account> (long-poll via ?timeout=);
        each raw is a signal-cli envelope object (the injected `normalize` in signal.js parses it); THROWS on
        error so the adapter's poll loop governs backoff — a 400/401 (unknown/unregistered account) is thrown
        with `.fatal=true` so the loop stops for good.
     send(chatId, text, opts?) -> Promise<SendResult>       // POST /v2/send; NEVER throws — always a normalized
        { ok, messageId?, error?, retryable? } so the adapter's one-shot resend can act.

   The endpoint URL + account number live in closure and appear only in request URLs/bodies to that endpoint —
   never on an event, the bus, or a log. `fetch` is INJECTED (index.js passes globalThis.fetch; tests pass a
   fake), so this module touches no real network under test and stays deterministic (no clock/rng/Date). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.signalTransport = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function makeSignalTransport(opts) {
    const o = opts || {};
    const fetchImpl = o.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('makeSignalTransport: an injected fetch is required');
    const BASE = String(o.endpoint || '').replace(/\/+$/, '');
    if (!BASE) throw new Error('makeSignalTransport: a signal-cli REST endpoint URL is required');
    const account = String(o.account || '').trim();
    if (!account) throw new Error('makeSignalTransport: the registered account number is required');

    return {
      async getUpdates(args) {
        const a = args || {};
        // signal-cli's receive drains the queued envelopes; ?timeout= parks like a long-poll (seconds).
        const url = BASE + '/v1/receive/' + encodeURIComponent(account) + '?timeout=' + Math.max(1, Math.min(a.timeoutSec || 1, 300));
        const res = await fetchImpl(url, { method: 'GET', signal: a.signal });
        let data = null;
        try { data = await res.json(); } catch (e) {}
        if (res && res.ok) return Array.isArray(data) ? data : [];
        const code = (res && res.status) || 0;
        // A 400 from a bridge in json-rpc mode looks like any other 400; name the one fix that is in the user's hands.
        const hint = code === 400 ? ' — if the bridge runs with MODE=json-rpc, restart it with MODE=native (json-rpc cannot be polled)' : '';
        const err = new Error('signal receive failed: ' + code + ((data && data.error) ? ' ' + data.error : '') + hint);
        err.code = code;
        // 400/401/404: unknown/unregistered account or wrong endpoint path — polling again can't fix it.
        if (code === 400 || code === 401 || code === 404) err.fatal = true;
        throw err;
      },

      // never throws: a network/abort/HTTP error becomes a SendResult so the adapter's bounded resend can run.
      async send(chatId, text, sendOpts) {
        const o2 = sendOpts || {};
        const id = String(chatId);
        const body = { message: String(text == null ? '' : text), number: account, recipients: [id] };
        try {
          const res = await fetchImpl(BASE + '/v2/send', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: o2.signal
          });
          let data = null;
          try { data = await res.json(); } catch (e) {}
          if (res && res.ok) return { ok: true, messageId: String((data && data.timestamp) != null ? data.timestamp : '') };
          const code = (res && res.status) || 0;
          // auth: the bridge refused the ACCOUNT (401/404, as getUpdates' fatal rule) — channel-wide, kept queued for the
          // re-paired account (channels/hub.js deliver); a 400 is about this one recipient and is not
          return { ok: false, error: (data && data.error) || ('http ' + code), retryable: code === 429 || code >= 500, auth: code === 401 || code === 404 };
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.aborted)) return { ok: false, error: 'aborted', retryable: false };
          return { ok: false, error: (e && e.message) || 'network error', retryable: true };
        }
      }
    };
  }

  return { makeSignalTransport };
});
