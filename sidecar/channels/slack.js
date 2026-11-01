/* sidecar/channels/slack.js — the Slack platform binding for the generic channel adapter.

   The analogue of telegram.js/discord.js: it supplies ONLY the wire translation (normalize) + the limit and
   hands the rest to the transport-agnostic adapter (owner/DM admission, resend, status). Inbound events arrive
   over the Socket Mode WebSocket (see slack.transport.js); each raw `message` event payload is mapped here.

   Slack needs TWO tokens (bot xoxb-… for REST sends, app-level xapp-… for the socket). The host stores them as
   ONE combined secret string; parseSlackTokens() splits it by prefix in either order, so the keychain/secrets
   machinery keeps treating "the token" as a single opaque value.

   normalize(event) -> { message } | null
     - null                : not a user text message (bot echo/edited/join/etc.) — deliver nothing
     - { message: {...} }  : a real user message, in the adapter's neutral InboundMessage shape */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./adapter.js'), require('./slack.transport.js'));
  } else {
    root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {};
    root.SK.channels.slack = factory(root.SK.channels.adapter, root.SK.channels.slackTransport);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (adapterMod, transportMod) {
  'use strict';
  const { makeChannelAdapter } = adapterMod;
  const { makeSlackTransport } = transportMod;

  const MAX_MESSAGE_LENGTH = 4000;   // Slack's documented per-message text recommendation/cap

  // split the ONE stored secret into the two Slack tokens by prefix, any order/separator (space/newline/comma).
  function parseSlackTokens(combined) {
    const parts = String(combined || '').split(/[\s,]+/).filter(Boolean);
    let botToken = '', appToken = '';
    for (const p of parts) {
      if (/^xoxb-/.test(p)) botToken = p;
      else if (/^xapp-/.test(p)) appToken = p;
    }
    return { botToken, appToken };
  }

  function normalize(ev) {
    if (!ev || ev.type !== 'message') return null;                 // reactions/app_mention/etc. -> nothing
    if (ev.bot_id || ev.subtype) return null;                      // never act on a bot/self/edited/system message
    if (typeof ev.text !== 'string' || !ev.text) return null;      // non-text -> deliver nothing
    if (!ev.channel || !ev.user) return null;
    return {
      message: {
        chatId: String(ev.channel),
        chatType: ev.channel_type === 'im' ? 'dm' : 'group',       // DMs owner-gated; channels need the allowlist
        userId: String(ev.user),
        userName: String(ev.user),
        text: ev.text,
        messageId: String(ev.ts || '')     // the adapter stamps ts from its injected clock
      }
    };
  }

  function makeSlackAdapter(opts) {
    const o = opts || {};
    const tokens = (o.botToken || o.appToken) ? { botToken: o.botToken, appToken: o.appToken } : parseSlackTokens(o.token);
    const transport = o.transport || makeSlackTransport({
      fetch: o.fetch, botToken: tokens.botToken, appToken: tokens.appToken,
      WebSocketImpl: o.WebSocketImpl, apiBase: o.apiBase, sleep: o.sleep, parkMs: o.parkMs
    });
    return makeChannelAdapter({
      transport,
      normalize,
      name: 'slack',
      maxMessageLength: MAX_MESSAGE_LENGTH,
      allowedChats: o.allowedChats,
      ownerUserId: o.ownerUserId,
      onOwnerClaim: o.onOwnerClaim,
      ownerAdmission: o.ownerAdmission,   // one-time pairing code (index.js channelOwnerAdmission)
      onInbound: o.onInbound,
      onCallback: o.onCallback,
      onStatus: o.onStatus,
      onMembership: o.onMembership,   // our own membership changed (blocked/kicked) — the hub stops retrying that chat
      onDelivery: o.onDelivery,       // per-send outcome (delivery health), separate from poll health
      clock: o.clock,
      sleep: o.sleep,
      dropPendingOnConnect: o.dropPendingOnConnect,   // socket pushes only post-connect; forwarded for parity/tests
      startOffset: o.startOffset
    });
  }

  return { makeSlackAdapter, normalize, parseSlackTokens, MAX_MESSAGE_LENGTH };
});
