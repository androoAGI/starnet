/* sidecar/channels/discord.js — the Discord platform binding for the generic channel adapter (P3.2).

   The analogue of telegram.js: it supplies ONLY the wire translation (normalize) + the limit (2000) and hands the
   rest to the transport-agnostic adapter (owner/DM admission, one-per-chat inflight, resend, SSE status). Inbound
   messages arrive over the gateway (see discord.transport.js); each raw MESSAGE_CREATE payload is mapped here.

   normalize(rawMessage) -> { offset, message } | null
     - null                         : not a real message (no id) — skip, don't advance
     - { offset, message: null }    : a bot/self message or a non-text payload — advance, deliver nothing
     - { offset, message: {...} }   : a real user message, in the adapter's neutral InboundMessage shape */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./adapter.js'), require('./discord.transport.js'));
  } else {
    root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {};
    root.SK.channels.discord = factory(root.SK.channels.adapter, root.SK.channels.discordTransport);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (adapterMod, transportMod) {
  'use strict';
  const { makeChannelAdapter } = adapterMod;
  const { makeDiscordTransport } = transportMod;

  const MAX_MESSAGE_LENGTH = 2000;          // Discord's per-message content cap

  function normalize(m) {
    if (!m || m.id == null) return null;                       // not a message -> skip without advancing
    const offset = String(m.id);
    const author = m.author || {};
    if (author.bot) return { offset, message: null };          // never act on a bot/self message
    if (typeof m.content !== 'string' || !m.content) return { offset, message: null };   // non-text -> deliver nothing
    return {
      offset,
      message: {
        chatId: String(m.channel_id),
        chatType: m.guild_id ? 'group' : 'dm',                 // a DM has no guild
        userId: String(author.id),
        userName: author.global_name || author.username || String(author.id),
        text: m.content,
        messageId: String(m.id)        // the adapter stamps ts from its injected clock
      }
    };
  }

  function makeDiscordAdapter(opts) {
    const o = opts || {};
    const transport = o.transport || makeDiscordTransport({
      fetch: o.fetch, token: o.token, connectGateway: o.connectGateway, apiBase: o.apiBase, sleep: o.sleep
    });
    return makeChannelAdapter({
      transport,
      normalize,
      name: 'discord',
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
      dropPendingOnConnect: o.dropPendingOnConnect,   // gateway pushes only post-connect, but forward it for parity/tests
      startOffset: o.startOffset
    });
  }

  return { makeDiscordAdapter, normalize, MAX_MESSAGE_LENGTH };
});
