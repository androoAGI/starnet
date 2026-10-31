/* Relay ingress admission — what a signed /api/channels/webhook/<channel> body may claim.

   The HMAC (webhook-auth.js) proves the body came from the holder of STARNET_CHANNEL_WEBHOOK_SECRET and the
   nonce inbox makes it at-most-once. It does NOT prove WHO on the platform wrote the message: the secret is one
   station-wide operator secret, not scoped to a user. So a signed body's `userId` is a relay CLAIM, and before
   this module the route handed it straight to hub.onInbound — skipping the adapter's owner gate and group
   allowlist that every polled message crosses, and letting the body set host verdict fields (directReply,
   observeOnly) that only the adapter may mint.

   This binds a relay message to the SAME admission the live adapter applies to a polled one:
     - only platform message fields are copied (never directReply/observeOnly or any other host verdict);
     - a DM is admitted only from the adapter's already-paired owner (a relay can never CLAIM ownership);
     - a group message must pass the adapter's own admission (allowlist, bots, allowedUsers, mention gate).
   The hub then derives owner authority from the adapter's paired owner exactly as for a polled message.
   A channel with no adapter admission (the DEV_MODE dev hub, every inbound already the Commander) passes through
   the field whitelist only. Pure: no fs, no network. */
'use strict';

// editDate rides with `edited`: the hub keys an edit's durable receipt by when it was made, so a relayed second correction
// of one message is a new message, not a duplicate of the first (channel-delivery-ledger S3). A tap is never a relay field.
const MESSAGE_FIELDS = ['chatId', 'userId', 'userName', 'text', 'media', 'chatType', 'messageId', 'replyTo',
  'threadId', 'edited', 'editDate', 'mediaGroupId', 'forwarded', 'fromBot'];

function pickMessage(raw) {
  const out = {};
  for (const k of MESSAGE_FIELDS) if (raw && Object.prototype.hasOwnProperty.call(raw, k)) out[k] = raw[k];
  out.chatId = String(out.chatId == null ? '' : out.chatId);
  out.userId = String(out.userId == null ? '' : out.userId);
  out.chatType = out.chatType === 'group' ? 'group' : 'dm';
  return out;
}

// -> { ok:true, message } | { ok:false, code, error }
function admitRelayMessage(raw, adapter) {
  if (!raw || typeof raw !== 'object') return { ok: false, code: 400, error: 'message payload is incomplete' };
  const m = pickMessage(raw);
  if (!m.chatId || (!m.text && !(Array.isArray(m.media) && m.media.length))) return { ok: false, code: 400, error: 'message payload is incomplete' };
  const internals = adapter && adapter._internals;
  // No adapter admission to bind to: only the DEV_MODE dev hub (liveChannelFor gates it), an owner surface.
  if (!internals || typeof internals.admission !== 'function') {
    return adapter && adapter.ownerSurface === true ? { ok: true, message: m } : { ok: false, code: 403, error: 'this channel cannot verify relay senders' };
  }
  let verdict = 'drop';
  try { verdict = internals.admission(m); } catch (_) { verdict = 'drop'; }
  if (m.chatType === 'dm') {
    const owner = String(internals.owner || '');
    // Never claims: an unpaired channel admits no relay DM at all (pairing happens on the platform itself).
    if (!owner || m.userId !== owner || verdict !== 'run') return { ok: false, code: 403, error: 'relay sender is not the paired owner' };
    return { ok: true, message: m };
  }
  if (verdict === 'run') return { ok: true, message: m };
  if (verdict === 'observe') return { ok: true, message: Object.assign(m, { observeOnly: true }) };
  return { ok: false, code: 403, error: 'relay chat is not admitted on this channel' };
}

module.exports = { admitRelayMessage, pickMessage, MESSAGE_FIELDS };
