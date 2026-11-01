/* sidecar/channels/signal.js — the Signal platform binding for the generic channel adapter.

   The analogue of telegram.js/discord.js: it supplies ONLY the wire translation (normalize) + the limit and
   hands the rest to the transport-agnostic adapter (owner/DM admission, resend, status). Raw updates are
   signal-cli REST envelopes (see signal.transport.js).

   DM-only first cut: group messages (envelope…dataMessage.groupInfo) deliver nothing — same shape the Telegram
   MVP shipped with. The owner trust-on-first-use gate applies to every DM, exactly like the other channels.

   normalize(envelope, { account }?) -> { message } | null
     - null                : not a data message (receipt/typing/other sync/group) — deliver nothing
     - { message: {...} }  : a real other-user DM, in the adapter's neutral InboundMessage shape, OR a Note to Self:
                             when the bridge is LINKED to the user's own number (the QR flow, no second number
                             needed), what they type in Note to Self reaches signal-cli only as a sync transcript
                             (syncMessage.sentMessage addressed to the account itself). Dropping every sync made the
                             guide's own "link" option a dead end — even the pair code vanished. A transcript to
                             ANYONE ELSE is the user's private conversation and is never delivered. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./adapter.js'), require('./signal.transport.js'));
  } else {
    root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {};
    root.SK.channels.signal = factory(root.SK.channels.adapter, root.SK.channels.signalTransport);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (adapterMod, transportMod) {
  'use strict';
  const { makeChannelAdapter } = adapterMod;
  const { makeSignalTransport } = transportMod;

  const MAX_MESSAGE_LENGTH = 4096;   // Signal accepts long texts; chat-sized chunks read better

  function normalize(raw, opts) {
    const env = raw && raw.envelope;
    if (!env) return null;
    const sent = env.syncMessage && env.syncMessage.sentMessage;
    if (sent) {
      const self = String((raw && raw.account) || (opts && opts.account) || '').trim();
      const dest = String(sent.destinationNumber || sent.destination || '').trim();
      if (!self || dest !== self) return null;                                  // the user's chat with someone else
      if (sent.groupInfo || typeof sent.message !== 'string' || !sent.message) return null;
      return {
        message: {
          chatId: self,                                   // replies go back into Note to Self
          chatType: 'dm',
          userId: self,
          userName: String(env.sourceName || 'Note to Self'),
          text: sent.message,
          messageId: String(sent.timestamp != null ? sent.timestamp : (env.timestamp != null ? env.timestamp : ''))
        }
      };
    }
    const dm = env.dataMessage;
    if (!dm || typeof dm.message !== 'string' || !dm.message) return null;   // receipts/typing/sync -> nothing
    if (dm.groupInfo) return null;                                            // DM-only first cut
    const source = env.sourceNumber || env.source || env.sourceUuid || '';
    if (!source) return null;
    return {
      message: {
        chatId: String(source),                       // replies go straight back to the sender's number
        chatType: 'dm',
        userId: String(source),
        userName: String(env.sourceName || source),
        text: dm.message,
        messageId: String(dm.timestamp != null ? dm.timestamp : (env.timestamp != null ? env.timestamp : ''))
      }
    };
  }

  function makeSignalAdapter(opts) {
    const o = opts || {};
    const transport = o.transport || makeSignalTransport({ fetch: o.fetch, endpoint: o.endpoint, account: o.account });
    return makeChannelAdapter({
      transport,
      normalize: raw => normalize(raw, { account: o.account }),
      name: 'signal',
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
      pollTimeoutSec: o.pollTimeoutSec != null ? o.pollTimeoutSec : 30,   // signal-cli receive ?timeout= window
      startOffset: o.startOffset
      // dropPendingOnConnect stays OFF: signal-cli's receive drains a bounded local queue, and there is no
      // offset:-1 style confirm-and-discard on this API — replay of a short offline queue is the honest behavior.
    });
  }

  return { makeSignalAdapter, normalize, MAX_MESSAGE_LENGTH };
});
