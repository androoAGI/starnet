/* sidecar/channels/telegram.js — Telegram as the first concrete channel (C2).

   Composes the two pure pieces into a ready adapter: the generic transport-agnostic pipeline
   (channels/adapter.js) + the Bot API fetch transport (channels/telegram.transport.js) + a Telegram-specific
   `normalize(update)` that turns a raw Bot API Update into the adapter's neutral shape. This is the analogue of
   a platform subclass in the reference harness: it supplies ONLY the wire translation (normalize) and the limits (4096), and
   inherits the loop/offset/admission/onInbound/send/backoff from the generic adapter.

     makeTelegramAdapter({ fetch, token, apiBase?, allowedChats?, onInbound, onCallback?, onStatus?, clock,
                           pollTimeoutSec?, backoffMs?, sleep?, startOffset? }) -> adapter

   `normalize` maps the update kinds we admit:
     • a TEXT message   -> { offset, message }   (chat.type 'private' => 'dm', else 'group')
     • a MEDIA message  -> { offset, message }   with message.media = [{ kind, fileId, name, mime, size }] and
       message.text = the caption (may be ''). Photos pick the LARGEST size; videos/animations/video notes also
       carry their server-generated preview thumbnail as an extra { kind:'photo' } item so a vision model can SEE
       a frame of the clip even though no provider ingests raw video. Static stickers ride as webp photos.
     • a NON-FILE user payload (location/venue/contact/poll/dice/story, and animated/video stickers) ->
       { offset, message } whose text is a DESCRIPTOR line (describeOf) — see below.
     • a callback_query -> { offset, callback }  (inline-keyboard taps, used by consent in C6)
     • anything else (a service message: joins/leaves/pins/title changes) -> { offset, message:null }
       (advance the offset, deliver nothing)
   It is pure and exported standalone so the parse is unit-tested without any transport. Downloading the actual
   bytes is the transport's getFile (driven by the hub); normalize only names WHAT arrived.

   TWO ADDITIONS (2026-07-29), both closing "the bot ignored me" gaps against the reference harness:

   1. SILENT DROPS (describeOf). A location, a contact card, a poll, a dice roll or an ANIMATED sticker used to
      fall through to `message:null` — the offset advanced and the member got NOTHING BACK AT ALL, which reads
      exactly like a dead bot. None of those carry bytes any provider ingests, but every one of them carries
      meaning, so they now arrive as a bracketed descriptor line the model can answer. The list is an explicit
      ALLOWLIST of *user content*: a service message (someone joined, a pin, a title change) must stay silent,
      or the bot starts replying to the group's own furniture.

   2. REPLY CONTEXT (replyOf). `reply_to_message` was never read, so the single most natural Telegram gesture —
      long-press a photo or a message, hit Reply, ask "what is this?" — reached the model as three bare words
      with the referent missing. The quoted message's text AND its media now ride on `msg.replyTo`; the hub
      quotes the one and ingests the other. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./adapter.js'), require('./telegram.transport.js'));
  } else {
    root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {};
    root.SK.channels.telegram = factory(root.SK.channels.adapter, root.SK.channels.telegramTransport);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (adapterMod, transportMod) {
  'use strict';

  const { makeChannelAdapter } = adapterMod;
  const { makeTelegramTransport } = transportMod;

  const MAX_MESSAGE_LENGTH = 4096;   // Bot API hard limit, in UTF-16 code units == JS String.length (no utf16_len port)

  // Collect the media payloads of one Bot API Message into neutral { kind, fileId, name, mime, size } items.
  // `kind` is what the HUB acts on: 'photo' (viewable image), 'video'/'audio'/'document' (saved to the workspace
  // as files). A clip's preview thumbnail rides as its OWN 'photo' item (name marks it as a frame) so the model
  // gets real pixels from the clip. Pure; unknown/absent fields degrade to '' / 0, never throw.
  function mediaOf(m) {
    const items = [];
    const push = function (kind, f, name, mime) {
      if (!f || f.file_id == null) return;
      items.push({ kind: kind, fileId: String(f.file_id), name: String(name || 'file'),
                   mime: String(mime || ''), size: Number(f.file_size) || 0 });
    };
    const thumbOf = function (o) { return o && (o.thumbnail || o.thumb); };   // Bot API 6.x renamed thumb -> thumbnail
    if (Array.isArray(m.photo) && m.photo.length) {
      push('photo', m.photo[m.photo.length - 1], 'photo.jpg', 'image/jpeg');   // sizes are ordered small -> large
    }
    if (m.video) {
      push('video', m.video, m.video.file_name || 'video.mp4', m.video.mime_type || 'video/mp4');
      push('photo', thumbOf(m.video), 'video-preview-frame.jpg', 'image/jpeg');
    }
    if (m.animation) {
      push('video', m.animation, m.animation.file_name || 'animation.mp4', m.animation.mime_type || 'video/mp4');
      push('photo', thumbOf(m.animation), 'animation-preview-frame.jpg', 'image/jpeg');
    }
    if (m.video_note) {
      push('video', m.video_note, 'video-note.mp4', 'video/mp4');
      push('photo', thumbOf(m.video_note), 'video-note-preview-frame.jpg', 'image/jpeg');
    }
    // A VOICE NOTE is marked explicitly rather than sniffed from the filename: the hub transcribes voice and
    // must NOT burn an STT call on a music file the member happened to forward. `voice:true` is the flag; a
    // plain audio upload below deliberately does not carry it.
    if (m.voice) { push('audio', m.voice, 'voice-message.ogg', m.voice.mime_type || 'audio/ogg'); items[items.length - 1].voice = true; }
    if (m.audio) push('audio', m.audio, m.audio.file_name || 'audio.mp3', m.audio.mime_type || 'audio/mpeg');
    if (m.document) push('document', m.document, m.document.file_name || 'file', m.document.mime_type || '');
    if (m.sticker && !m.sticker.is_animated && !m.sticker.is_video) push('photo', m.sticker, 'sticker.webp', 'image/webp');
    return items;
  }

  // Describe a user payload that carries no ingestible bytes but DOES carry meaning, as one bracketed line the
  // model can answer. Returns '' for anything not on the list — which is the point: this is an ALLOWLIST of user
  // content, so Telegram's service messages (new_chat_members, left_chat_member, pinned_message, new_chat_title,
  // …) keep falling through to message:null and the bot stays quiet about the group's own housekeeping. Pure;
  // every field is optional on the wire, so every read degrades to a shorter sentence rather than throwing.
  function describeOf(m) {
    if (!m || typeof m !== 'object') return '';
    const trim = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 120);
    if (m.venue) {
      const v = m.venue, loc = v.location || {};
      const where = [trim(v.title, 80), trim(v.address, 120)].filter(Boolean).join(' — ');
      const at = (loc.latitude != null && loc.longitude != null) ? (' (' + loc.latitude + ', ' + loc.longitude + ')') : '';
      return '[the user shared a place: ' + (where || 'unnamed') + at + ']';
    }
    if (m.location) {
      const loc = m.location;
      const live = Number(loc.live_period) > 0 ? 'live ' : '';
      if (loc.latitude == null || loc.longitude == null) return '[the user shared a ' + live + 'location]';
      return '[the user shared a ' + live + 'location: ' + loc.latitude + ', ' + loc.longitude + ']';
    }
    if (m.contact) {
      const c = m.contact;
      const who = [trim(c.first_name, 60), trim(c.last_name, 60)].filter(Boolean).join(' ');
      const num = trim(c.phone_number, 40);
      return '[the user shared a contact card' + (who ? ': ' + who : '') + (num ? ' ' + num : '') + ']';
    }
    if (m.poll) {
      const p = m.poll;
      const opts = (Array.isArray(p.options) ? p.options : []).slice(0, 10).map(x => trim(x && x.text, 60)).filter(Boolean);
      return '[the user shared a poll: "' + trim(p.question, 200) + '"' + (opts.length ? ' — options: ' + opts.join(' / ') : '') + ']';
    }
    if (m.dice) {
      const d = m.dice;
      return '[the user rolled ' + trim(d.emoji, 8) + (d.value != null ? ' and got ' + d.value : '') + ']';
    }
    if (m.story) return '[the user shared a story — its contents are not readable through the Bot API]';
    if (m.sticker) {
      // A STATIC sticker also rides as a webp photo (mediaOf), so this line is the label on pixels the model can
      // already see. An animated/video sticker (.tgs/.webm) has no frame any provider ingests, and used to be
      // dropped whole — its emoji is the only meaning available, and it is better than silence.
      const s = m.sticker, e = trim(s.emoji, 8), set = trim(s.set_name, 60);
      const kind = (s.is_animated || s.is_video) ? 'an animated sticker' : 'a sticker';
      return '[the user sent ' + kind + (e ? ': ' + e : '') + (set ? ' (from the "' + set + '" pack)' : '') + ']';
    }
    return '';
  }

  // The message this one is REPLYING TO, as neutral context: { text, userName?, fromBot?, media? }. Returns null
  // when there is no reply, when the target carries nothing we can show, or in the two cases where Telegram sets
  // reply_to_message for a reason that is NOT a reply:
  //   • inside a forum topic EVERY message carries reply_to_message = the topic's own creation message, so
  //     quoting it would staple a phantom "in reply to" onto every single group turn;
  //   • the same shape appears on the service message that opened the topic.
  // Media on the quoted message rides through so the hub can ingest the actual photo the member long-pressed.
  /* FORWARD PROVENANCE (2026-09-23 security audit). A forward arrives with the OWNER's from.id, so without this
     flag a stranger's text the Commander forwarded ("is this legit?") ran as the Commander's own directive with
     owner trust. Bot API 7+ sends forward_origin; older payloads carry the forward_* family. Any of them means
     the words were authored by someone else — the hub turns that into an untrusted-content taint. */
  function isForwarded(m) {
    return !!(m && (m.forward_origin || m.forward_date || m.forward_from || m.forward_from_chat || m.forward_sender_name));
  }

  function replyOf(m) {
    const rt = m && m.reply_to_message;
    if (!rt || typeof rt !== 'object') return null;
    if (rt.forum_topic_created) return null;
    if (m.is_topic_message && rt.message_id != null && m.message_thread_id != null
        && Number(rt.message_id) === Number(m.message_thread_id)) return null;
    const from = rt.from || {};
    const text = typeof rt.text === 'string' ? rt.text
      : (typeof rt.caption === 'string' ? rt.caption : (describeOf(rt) || ''));
    const media = mediaOf(rt);
    if (!text && !media.length) return null;   // a reply to a service message quotes nothing
    const out = { text: text };
    if (isForwarded(rt)) out.forwarded = true;   // quoting a forward re-injects a third party's words
    const who = from.username || from.first_name;
    if (who) out.userName = String(who);
    if (from.is_bot) out.fromBot = true;
    if (media.length) out.media = media;
    return out;
  }

  /* Who this message ADDRESSES, as raw platform facts — the policy decision lives in the generic adapter, which
     is the piece that knows our own @username.

     Returns lowercased usernames without the '@'. Two entity kinds count:
       • 'mention'      — "@thebot look at this"; the username is a SLICE of the text, by UTF-16 offset/length,
                          which is what Telegram's offsets are measured in and what JS String indexes natively.
       • 'text_mention' — a mention of a user with no @username (a link entity carrying `user`); matched by id
                          elsewhere, but its username is captured here when it has one.
     A `/cmd@thebot` suffix is ALSO an addressing form and is captured, so a command aimed at another bot in the
     same group can be told apart from one aimed at us. */
  function mentionsOf(m) {
    const out = [];
    const text = typeof m.text === 'string' ? m.text : (typeof m.caption === 'string' ? m.caption : '');
    const ents = (Array.isArray(m.entities) && m.entities.length) ? m.entities
      : (Array.isArray(m.caption_entities) ? m.caption_entities : []);
    for (const e of ents) {
      if (!e) continue;
      if (e.type === 'mention') {
        const raw = text.slice(Number(e.offset) || 0, (Number(e.offset) || 0) + (Number(e.length) || 0));
        const name = String(raw).replace(/^@/, '').trim().toLowerCase();
        if (name) out.push(name);
      } else if (e.type === 'text_mention' && e.user && e.user.username) {
        out.push(String(e.user.username).trim().toLowerCase());
      }
    }
    // '/status@thebot' — the command's own @suffix, which Telegram does NOT emit as a mention entity
    const cmd = /^\/[A-Za-z0-9_]+@([A-Za-z0-9_]+)/.exec(String(text || ''));
    if (cmd) out.push(String(cmd[1]).toLowerCase());
    return out;
  }

  /* Is there anything in this Message a member could expect an answer to? Text (even empty), ingestible bytes,
     or a describable payload. Shared by every message-shaped update kind so a photo in a channel post and a
     photo in a DM are admitted by the SAME rule. */
  function hasContent(m) {
    return !!m && (typeof m.text === 'string' || mediaOf(m).length > 0 || !!describeOf(m));
  }

  function normalize(u) {
    if (!u || typeof u.update_id !== 'number') return null;   // not a real update -> skip without advancing
    const offset = u.update_id;
    /* FOUR message-shaped update kinds, ONE parse. Telegram delivers the same Message object under four
       different keys, and reading only `message` is why an edit changed nothing and a broadcast channel was
       silence. `edited` and `channelPost` ride out as flags rather than as separate shapes, so the policy
       question ("should an edit re-run?", "who sent a post with no `from`?") is answered once, downstream,
       instead of four times here. */
    const msgSrc = u.message ? { m: u.message, edited: false, post: false }
      : u.edited_message ? { m: u.edited_message, edited: true, post: false }
      : u.channel_post ? { m: u.channel_post, edited: false, post: true }
      : u.edited_channel_post ? { m: u.edited_channel_post, edited: true, post: true }
      : null;
    /* my_chat_member — OUR OWN membership changed: we were added, promoted, blocked or kicked. Being blocked was
       invisible before, so the notifier kept posting into a chat that could never receive it. Reported as a
       neutral third shape (neither a message nor a callback) because the consumer is a store update, not a run. */
    if (u.my_chat_member) {
      const mc = u.my_chat_member;
      const chat = mc.chat || {};
      const nw = mc.new_chat_member || {};
      if (chat.id == null || !nw.status) return { offset: offset, message: null };
      return { offset: offset, membership: {
        chatId: chat.id,
        chatType: chat.type === 'private' ? 'dm' : 'group',
        status: String(nw.status),                                  // 'member'|'administrator'|'left'|'kicked'|'restricted'|'creator'
        byUserId: (mc.from && mc.from.id) == null ? '' : String(mc.from.id)
      } };
    }
    if (msgSrc && hasContent(msgSrc.m)) {
      const m = msgSrc.m;
      const chat = m.chat || {};
      /* A CHANNEL POST HAS NO `from`. The author is the channel itself (`sender_chat`), optionally with an
         `author_signature`. Reading `from` blindly would leave userId/userName empty on every broadcast post —
         and, worse, would make the is_bot check silently vacuous on the one surface where the bot can hear its
         own voice. That echo is stopped by message-id in adapter.js, not here. */
      const from = m.from || {};
      const media = mediaOf(m);
      // A descriptor never overwrites real text: it is the text for a payload that HAS none (a bare location, an
      // animated sticker), and the label under a static sticker's pixels.
      const written = typeof m.text === 'string' ? m.text : (typeof m.caption === 'string' ? m.caption : '');
      const msg = {
        chatId: chat.id,
        chatType: chat.type === 'private' ? 'dm' : 'group',
        userId: from.id,
        userName: from.username || from.first_name || m.author_signature || undefined,
        text: written || describeOf(m) || '',
        messageId: m.message_id
      };
      if (msgSrc.edited) msg.edited = true;         // the hub decides whether a correction earns a fresh run
      /* WHEN it was edited (channel-delivery-ledger S3): the hub keys an edit's durable receipt by it, so a second
         correction of one message is a new message, never taken for Telegram handing the first one over again. */
      if (msgSrc.edited && Number.isFinite(m.edit_date)) msg.editDate = m.edit_date;
      if (isForwarded(m)) msg.forwarded = true;     // third-party words under the owner's id — the hub taints the run
      if (msgSrc.post) msg.channelPost = true;      // a broadcast post: no human sender, and it can echo back to us
      if (from.is_bot) msg.fromBot = true;                       // another BOT is talking — the adapter drops these
      /* WHICH FORUM TOPIC this arrived in, so the answer can go back to it. Read ONLY for a real topic message:
         in a plain supergroup Telegram also sets message_thread_id on a reply chain, and echoing that back as a
         thread would aim the reply at a "topic" the chat does not have. Everything downstream is neutral — the
         hub stores it per chat and hands it back as `threadId`; only telegram.transport.js knows the Bot API
         name. Absent here (a DM, a non-forum group) the outbound path is byte-identical to before. */
      if (m.is_topic_message && m.message_thread_id != null) msg.threadId = String(m.message_thread_id);
      const mentions = mentionsOf(m);
      if (mentions.length) msg.mentions = mentions;              // who this message addresses (adapter decides)
      const replyTo = replyOf(m);
      if (replyTo) msg.replyTo = replyTo;   // additive — a non-reply keeps the exact old shape
      if (media.length) msg.media = media;   // additive — text-only messages keep the exact old shape
      // album marker: N messages of one album share media_group_id; the hub debounce-merges them into ONE turn
      if (media.length && m.media_group_id != null) msg.mediaGroupId = String(m.media_group_id);
      return { offset: offset, message: msg };
    }
    if (u.callback_query) {
      const cq = u.callback_query;
      const chat = (cq.message && cq.message.chat) || {};
      return { offset: offset, callback: {
        chatId: chat.id,
        userId: cq.from && cq.from.id,
        data: cq.data,
        callbackId: cq.id,
        messageId: cq.message && cq.message.message_id
      } };
    }
    return { offset: offset, message: null };   // non-text/other update: advance past it, deliver nothing
  }

  function makeTelegramAdapter(opts) {
    const o = opts || {};
    const transport = makeTelegramTransport({ fetch: o.fetch, token: o.token, apiBase: o.apiBase, requestTimeoutMs: o.requestTimeoutMs });
    return makeChannelAdapter({
      transport: transport,
      normalize: normalize,
      name: 'telegram',
      maxMessageLength: MAX_MESSAGE_LENGTH,
      allowedChats: o.allowedChats,
      onInbound: o.onInbound,
      onCallback: o.onCallback,
      onStatus: o.onStatus,
      onDelivery: o.onDelivery,
      clock: o.clock,
      pollTimeoutSec: o.pollTimeoutSec,
      backoffMs: o.backoffMs,
      sleep: o.sleep,
      startOffset: o.startOffset,
      ownerUserId: o.ownerUserId,
      onOwnerClaim: o.onOwnerClaim,
      ownerAdmission: o.ownerAdmission,
      // GROUP DISCIPLINE — see adapter.js. botUsername is what makes "was I addressed?" answerable at all; the
      // composition root learns it from getMe() at connect. Without it the mention gate deliberately admits
      // everything rather than silencing a room we cannot prove we were not addressed in.
      botUsername: o.botUsername,
      requireMention: o.requireMention,
      // Wake words, observe-only and our own membership changes were all passed by index.js and silently DROPPED
      // here until 2026-10-19 — calling the bot by name, /mention observe and "you were kicked" did nothing.
      mentionPatterns: o.mentionPatterns,
      observeUnmentioned: o.observeUnmentioned,
      onMembership: o.onMembership,
      // the "I was offline" notices leave through the host's one outbound contract when it wires one (adapter.js sendNotice)
      sendNotice: o.sendNotice,
      ignoreBots: o.ignoreBots,
      allowedUsers: o.allowedUsers,
      dropPendingOnConnect: o.dropPendingOnConnect !== false   // Telegram default: discard offline backlog on connect
    });
  }

  return { makeTelegramAdapter, normalize, mediaOf, describeOf, replyOf, mentionsOf, MAX_MESSAGE_LENGTH };
});
