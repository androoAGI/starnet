/* sidecar/channels/telegram.transport.js — the ONLY network-touching piece of the Telegram channel (C2).

   A thin fetch wrapper over the Telegram Bot API (https://api.telegram.org/bot<token>/<method>), exposing the
   exact two methods the generic adapter (channels/adapter.js) drives:

     getUpdates({ offset, timeoutSec, signal }) -> Promise<Update[]>   // long-poll; returns the RAW Update[]
        (the injected `normalize` in telegram.js parses each one); THROWS on error so the adapter's poll loop
        governs backoff — a 401/404 (bad/closed token) is thrown with `.fatal=true` so the loop stops for good.
     send(chatId, text, opts?) -> Promise<SendResult>                  // sendMessage; NEVER throws — always a
        normalized { ok, messageId?, error?, retryable?, retryAfter? } so the adapter's one-shot resend can act.

   The bot token is held in closure and appears ONLY in the URL path — never on an event, the bus, or a log.
   `fetch` is INJECTED (index.js passes globalThis.fetch; tests pass a fake), so this module touches no real
   network under test and stays the lone ambient-I/O edge of the channel. Deterministic: no clock/rng/Date. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./telegram.format.js'));
  else {
    root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {};
    root.SK.channels.telegramTransport = factory(root.SK.channels.telegramFormat);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fmt) {
  'use strict';

  /* WHAT TELEGRAM IS ALLOWED TO SEND US. This list is a SUBSCRIPTION, not a filter: an update kind that is not
     named here is never delivered at all, so anything missing is a kind the bot is structurally deaf to.

     'edited_message'      — a member fixing a typo used to change nothing; we answered the typo.
     'channel_post' + its edit — added to a broadcast channel, the bot was completely deaf. There is no `from`
                             on a channel post, so the echo guard in adapter.js (not an is_bot check) is what
                             stops the bot answering its own posts.
     'my_chat_member'      — being blocked or kicked. Subscribed together with its consumer (the chat is marked
                             unreachable and its queued backlog is dropped); a detected fact with no reader is
                             one of this project's named bug classes.
     Deliberately still absent: 'message_reaction' (we SET reactions, we do not need to hear other people's),
     'poll'/'poll_answer', 'chat_member', 'chat_join_request' — each would be traffic with no consumer. */
  const ALLOWED_UPDATES = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query', 'my_chat_member'];
  const DEFAULT_API_BASE = 'https://api.telegram.org';
  // Every Bot API request except getUpdates has a bounded wall-clock. A half-open outbound socket used to
  // leave getMe/connect or a completed reply pending forever while the independent poller still showed green.
  // getUpdates supplies its own longer poll deadline from adapter.js and explicitly opts out below.
  const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

  // ---- outbound media limits + method table (Bot API facts, not our policy) ----
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;   // Bot API upload ceiling for a bot (photos are lower; Telegram re-encodes)
  const MAX_CAPTION_LENGTH = 1024;             // a media caption is 1024, NOT the 4096 a message body gets
  const MAX_ALBUM_ITEMS = 10;
  // kind -> the method that makes Telegram render it that way, and the form field it expects the bytes under.
  const MEDIA_METHODS = {
    photo:     { method: 'sendPhoto',     field: 'photo' },
    document:  { method: 'sendDocument',  field: 'document' },
    video:     { method: 'sendVideo',     field: 'video' },
    audio:     { method: 'sendAudio',     field: 'audio' },
    voice:     { method: 'sendVoice',     field: 'voice' },
    animation: { method: 'sendAnimation', field: 'animation' }
  };

  function makeTelegramTransport(opts) {
    const o = opts || {};
    const fetchImpl = o.fetch;
    const token = o.token;
    const requestTimeoutMs = Number(o.requestTimeoutMs) > 0 ? Number(o.requestTimeoutMs) : DEFAULT_REQUEST_TIMEOUT_MS;
    if (typeof fetchImpl !== 'function') throw new Error('makeTelegramTransport: an injected fetch is required');
    if (!token || typeof token !== 'string') throw new Error('makeTelegramTransport: a bot token is required');
    const BASE = (o.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '') + '/bot' + token;   // token only ever here

    /* THE BOT TOKEN LIVES IN THE URL, AND FETCH PUTS THE URL IN ITS ERROR MESSAGE.
       Node's undici renders a transport failure as "request to https://api.telegram.org/bot<TOKEN>/sendMessage
       failed, reason: …". Every catch in this file used to pass `e.message` straight out — into console.error,
       and into the `error` field of a SendResult that the hub emits on `channel.delivery` and surfaces in the
       panel. One DNS blip was therefore enough to print a live bot token into a log the member might paste into
       a bug report. Redact at the one place that knows the secret: here.

       Two rules, belt and suspenders: strike THIS token wherever it appears (it can also arrive inside a
       description echoed back), and strike anything shaped like a Bot API token in a /bot<...>/ path — a proxy
       or a self-hosted api server may name a DIFFERENT token in its error text, and a redactor that only knows
       its own secret would sail straight past it. */
    const TOKEN_RE = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    function redact(s) {
      let out = String(s == null ? '' : s);
      if (token) out = out.replace(TOKEN_RE, '<redacted-bot-token>');
      // any surviving /bot<digits>:<secret> path segment (another token, or a partially-rewritten one)
      out = out.replace(/\/bot\d{5,}:[A-Za-z0-9_-]{10,}/g, '/bot<redacted-bot-token>');
      return out;
    }
    // every error string leaving this module goes through here — never `e.message` raw.
    // Undici's top-level message is often only "fetch failed"; the useful reason lives in `.cause`. Surface a
    // small, token-safe diagnosis so an outage says ECONNRESET/ENOTFOUND/etc. instead of an unactionable slogan.
    // Never retain the raw cause object: it may itself contain the token-bearing request URL.
    function errOf(e, fallback) {
      const base = redact((e && e.message) || fallback || 'error');
      const cause = e && e.cause;
      if (!cause) return base;
      const code = redact(cause.code || cause.name || '');
      const host = redact(cause.hostname || cause.address || '');
      const detail = [code, host].filter(Boolean).join(' ');
      return detail && base.indexOf(detail) < 0 ? (base + ' (' + detail + ')') : base;
    }

    /* ---- ROUTE: answering WHERE the question was asked ------------------------------------------------------
       The hub speaks a NEUTRAL route — { threadId, replyTo } — because it drives five platforms and may not know
       Telegram's field names. This file is the only place that does, so the translation lives here and nowhere
       else. Two Bot API fields:

         message_thread_id     — the forum topic. Without it every answer in a forum supergroup lands in General
                                 instead of the topic the member asked in: not missing polish, a message
                                 delivered to the WRONG PLACE.
         reply_to_message_id   — quotes the message we are answering, so a reply in a busy group is attached to
                                 its question instead of floating loose.

       allow_sending_without_reply rides with the quote ON PURPOSE. If the quoted message is deleted between the
       question and the answer, Telegram answers 400 "message to be replied not found" and THE REPLY IS LOST.
       The floor is delivery: never trade the answer for the decoration. */
    const ROUTE_KEYS = { threadId: 1, replyTo: 1 };
    function applyRoute(payload, o2) {
      const t = Number((o2 && o2.threadId) || 0);
      if (Number.isFinite(t) && t > 0) payload.message_thread_id = t;
      const r = Number((o2 && o2.replyTo) || 0);
      if (Number.isFinite(r) && r > 0) {
        payload.reply_to_message_id = r;
        payload.allow_sending_without_reply = true;
      }
      return payload;
    }
    // A topic can be closed, deleted, or simply never have existed on this chat (a stale binding). Telegram says
    // so in prose, not in a code, so match the prose — and the caller then RESENDS to the chat root. General is
    // the wrong room; silence is worse.
    function isThreadError(desc) {
      return /message thread not found|thread not found|topic_closed|topic_deleted|topic is closed|topic was deleted/i.test(String(desc || ''));
    }

    // one Bot API call -> { res, data }. data.ok distinguishes success ({result}) from error ({error_code,description}).
    function requestSignal(signal, deadlineMs) {
      const ms = deadlineMs === 0 ? 0 : (Number(deadlineMs) > 0 ? Number(deadlineMs) : requestTimeoutMs);
      if (!ms || typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return signal;
      const deadline = AbortSignal.timeout(ms);
      const composable = signal && typeof signal.addEventListener === 'function';
      return composable && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, deadline]) : (signal || deadline);
    }

    async function call(method, payload, signal, deadlineMs) {
      let res;
      try {
        res = await fetchImpl(BASE + '/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload || {}),
          signal: requestSignal(signal, deadlineMs)
        });
      } catch (e) {
        const safe = new Error(errOf(e, 'network error'));
        safe.name = (e && e.name) || 'Error';
        if (e && e.aborted) safe.aborted = true;
        throw safe;
      }
      let data;
      try { data = await res.json(); }
      catch (e) { data = { ok: false, error_code: (res && res.status) || 0, description: 'non-JSON response' }; }
      return { res: res, data: data };
    }

    /* MULTIPART — the one thing sendMessage never needed and every send*-media method does.
       The Bot API takes file uploads as multipart/form-data ONLY; this transport was JSON-only, which is the
       real reason the agent could receive a file and never send one back. Hand-rolled on purpose: one small
       encoder over Buffer.concat beats a dependency for a format this fixed. Deterministic — the boundary is
       derived from a caller-supplied counter, never from a clock or rng, so a test can assert the exact bytes.

       fields: { name: scalar }  (numbers/strings/booleans; objects are JSON-stringified, which is exactly what
                                  the Bot API wants for reply_markup and the sendMediaGroup `media` array)
       files:  [{ field, filename, contentType, buffer }] */
    let partSeq = 0;
    function encodeMultipart(fields, files, seq) {
      const boundary = '----StarNetFormBoundary' + String(seq == null ? (++partSeq) : seq).padStart(12, '0');
      const chunks = [];
      const push = (s) => chunks.push(Buffer.from(String(s), 'utf8'));
      for (const k in (fields || {})) {
        if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
        const v = fields[k];
        if (v === undefined || v === null) continue;
        const body = (typeof v === 'object') ? JSON.stringify(v) : String(v);
        push('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + body + '\r\n');
      }
      for (const f of (files || [])) {
        if (!f || !f.buffer) continue;
        // a quote or newline in a filename would break the header out of its own field — strip, don't escape
        const fname = String(f.filename || 'file').replace(/[\r\n"\\]/g, '_').slice(0, 200);
        push('--' + boundary + '\r\nContent-Disposition: form-data; name="' + f.field + '"; filename="' + fname
          + '"\r\nContent-Type: ' + (f.contentType || 'application/octet-stream') + '\r\n\r\n');
        chunks.push(Buffer.isBuffer(f.buffer) ? f.buffer : Buffer.from(f.buffer));
        push('\r\n');
      }
      push('--' + boundary + '--\r\n');
      return { boundary: boundary, body: Buffer.concat(chunks) };
    }

    // one multipart Bot API call. Same { res, data } contract as call(), so every caller reads results identically.
    async function callMultipart(method, fields, files, signal, deadlineMs) {
      const { boundary, body } = encodeMultipart(fields, files);
      const res = await fetchImpl(BASE + '/' + method, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=' + boundary },
        body: body,
        signal: requestSignal(signal, deadlineMs)
      });
      let data;
      try { data = await res.json(); }
      catch (e) { data = { ok: false, error_code: (res && res.status) || 0, description: 'non-JSON response' }; }
      return { res: res, data: data };
    }

    return {
      // best-effort: drop any webhook this bot token may still have set (a prior tutorial/curl/another tool),
      // which would otherwise make every getUpdates fail with 409. Never throws — a failure just means no webhook.
      async deleteWebhook() {
        try { await call('deleteWebhook', { drop_pending_updates: false }); } catch (_) {}
      },

      // getMe — validate a token and learn WHO this bot is ({ id, username, name }) BEFORE anything is persisted.
      // The multi-bot connect flow keys each bot instance by the stable numeric id (usernames can be renamed) and
      // uses the username as the card label. NEVER throws — { ok:false, error } lets the route answer a clean 400.
      async getMe() {
        try {
          const { data, res } = await call('getMe', {});
          if (data && data.ok && data.result && data.result.id != null) {
            /* seesAllGroupMessages — Telegram's PRIVACY MODE, and the single most consequential fact about what
               this bot can hear. Default ON, which means that in a group Telegram delivers us only slash
               commands, @username mentions, and replies to our own messages. Ordinary chatter never arrives,
               and neither does "Agent OS, do X" — the bot's NAME is not an @mention. Two features depend on it
               (wake words and observe-unmentioned), so the flag has to travel with the identity, or the product
               ends up promising to follow a room it is not being sent. */
            const out = { ok: true, id: String(data.result.id), username: String(data.result.username || ''), name: String(data.result.first_name || '') };
            // Only when the server actually told us. A missing field is UNKNOWN, not "privacy is on" — claiming
            // a limitation we cannot prove is the same failure as hiding one, pointed the other way. Absent here
            // means the whole key is absent, and every reader downstream treats that as "say nothing".
            if (typeof data.result.can_read_all_group_messages === 'boolean') out.seesAllGroupMessages = data.result.can_read_all_group_messages;
            return out;
          }
          const code = (data && data.error_code) || (res && res.status) || 0;
          return { ok: false, error: redact((data && data.description) || ('http ' + code)) };
        } catch (e) {
          return { ok: false, error: errOf(e, 'network error') };
        }
      },

      /* getChat â€” resolve a numeric chat id (or a public @channel/@supergroup username) through the Bot API.
         Telegram bots cannot resolve an arbitrary person's @username, so reject that shape honestly instead of
         pretending a value is a contactable chat. This is a lookup helper only; outbound delivery remains
         known-targets-only in the channel tool layer. */
      async chatInfo(chatId) {
        const id = String(chatId == null ? '' : chatId).trim();
        if (!/^-?\d+$/.test(id) && !/^@[A-Za-z0-9_]{5,}$/.test(id)) {
          return { ok: false, id: id, error: 'Telegram can look up numeric chat ids and public @channel usernames, not arbitrary user handles' };
        }
        try {
          const { data, res } = await call('getChat', { chat_id: id });
          if (data && data.ok && data.result) {
            const c = data.result;
            return { ok: true, id: String(c.id == null ? id : c.id), type: String(c.type || ''),
              name: String(c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '') };
          }
          const code = (data && data.error_code) || (res && res.status) || 0;
          return { ok: false, id: id, error: redact((data && data.description) || ('http ' + code)) };
        } catch (e) {
          return { ok: false, id: id, error: errOf(e, 'network error') };
        }
      },

      async getUpdates(args) {
        const a = args || {};
        const { data, res } = await call('getUpdates', {
          offset: a.offset, timeout: a.timeoutSec, allowed_updates: ALLOWED_UPDATES
        }, a.signal, 0);   // the adapter owns the long-poll deadline (poll timeout + slack)
        if (data && data.ok) return Array.isArray(data.result) ? data.result : [];
        const code = (data && data.error_code) || (res && res.status) || 0;
        const desc = redact((data && data.description) || '');
        const err = new Error('telegram getUpdates failed: ' + code + ' ' + desc);
        err.code = code;
        if (code === 401 || code === 404) err.fatal = true;   // invalid/unknown token -> stop polling for good
        // 409: another poller or a webhook holds this token RIGHT NOW. Unlike a 401 this is not a verdict on the
        // token — Telegram throws one-off 409s during webhook-delete races and restart overlaps, and even a real
        // second instance can be closed a minute later. So it is CONFLICT, not fatal: the adapter keeps the loop
        // alive on a slow re-probe cadence (state 'error' until a poll succeeds) instead of killing the channel —
        // a dead-forever channel over one transient 409 also took channel.send down with it (connected=false).
        if (code === 409 || /terminated by other getupdates|another.*instance|webhook is active/i.test(desc)) {
          err.conflict = true;
          err.message = 'another instance or a webhook is using this bot token — stop the other poller (I will keep re-checking and reconnect on my own once it stops)';
        }
        throw err;
      },

      // Download ONE file the user sent the bot (photo/video/voice/document bytes). Two-step Bot API dance:
      // getFile(file_id) -> result.file_path, then GET <apiBase>/file/bot<token>/<file_path>. NEVER throws —
      // always { ok, buffer?, error? } so the hub's per-item degrade stays a note, not a crashed inbound.
      // maxBytes (caller-supplied) refuses oversized bodies BEFORE buffering them (content-length when present,
      // else a post-read length check). The token appears only in the URL, same as every other call here.
      async getFile(fileId, opts2) {
        const o3 = opts2 || {};
        try {
          const { data } = await call('getFile', { file_id: String(fileId) }, o3.signal);
          if (!data || !data.ok || !data.result || !data.result.file_path) {
            return { ok: false, error: redact((data && data.description) || 'getFile failed') };
          }
          const url = (o.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '') + '/file/bot' + token + '/' + String(data.result.file_path);
          const res = await fetchImpl(url, { method: 'GET', signal: requestSignal(o3.signal) });
          if (!res || !res.ok) return { ok: false, error: 'file download failed: http ' + ((res && res.status) || 0) };
          const max = Number(o3.maxBytes) > 0 ? Number(o3.maxBytes) : Infinity;
          const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
          if (len > max) return { ok: false, error: 'file too large (' + len + ' bytes)' };
          const ab = await res.arrayBuffer();
          const buffer = Buffer.from(ab);
          if (buffer.length > max) return { ok: false, error: 'file too large (' + buffer.length + ' bytes)' };
          if (!buffer.length) return { ok: false, error: 'empty file' };
          return { ok: true, buffer: buffer };
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.aborted)) return { ok: false, error: 'aborted' };
          return { ok: false, error: errOf(e, 'network error') };
        }
      },

      // sendChatAction — the "typing…" bubble (ref-parity). Telegram shows it for ~5s per call; the hub's
      // keep-alive loop refreshes it while a run is in flight. NEVER throws — always { ok, error?, retryable?,
      // retryAfter? } (same normalized shape as send) so the hub's loop can back off on 429 or stop on a hard
      // error. Purely cosmetic: a failure here must never affect the real reply path.
      async sendChatAction(chatId, action, actionOpts) {
        try {
          // Route the bubble too: in a forum a "typing…" raised on the chat root is visible in General while the
          // member waits in their topic. Only the thread matters here — a chat action cannot quote a message.
          const payload = applyRoute({ chat_id: chatId, action: action || 'typing' }, { threadId: actionOpts && actionOpts.threadId });
          const { data, res } = await call('sendChatAction', payload);
          if (data && data.ok) return { ok: true };
          const code = (data && data.error_code) || (res && res.status) || 0;
          const retryAfter = data && data.parameters && data.parameters.retry_after;
          return { ok: false, error: redact((data && data.description) || ('http ' + code)), retryable: code === 429 || code >= 500, retryAfter: retryAfter };
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.aborted)) return { ok: false, error: 'aborted', retryable: false };
          return { ok: false, error: errOf(e, 'network error'), retryable: true };
        }
      },

      // answerCallbackQuery — MANDATORY after every inline-keyboard tap. Telegram spins a loading indicator on the
      // button until this lands (and gives up after ~15s showing a client-side error), so an unanswered tap reads
      // as "the bot is broken" even when the decision was recorded fine. `text` (optional) pops a small toast.
      // NEVER throws — a failed ack is cosmetic and must not abort the decision it is acknowledging.
      async answerCallback(callbackId, text) {
        try {
          const payload = { callback_query_id: String(callbackId) };
          if (text) payload.text = String(text).slice(0, 200);   // Bot API caps the toast at 200 chars
          const { data, res } = await call('answerCallbackQuery', payload);
          if (data && data.ok) return { ok: true };
          const code = (data && data.error_code) || (res && res.status) || 0;
          return { ok: false, error: redact((data && data.description) || ('http ' + code)) };
        } catch (e) {
          return { ok: false, error: errOf(e, 'network error') };
        }
      },

      // editMessageText — rewrite a message we already sent, and (by omitting reply_markup) STRIP its keyboard.
      // This is how a resolved prompt stops being tappable: the buttons are replaced by the decision they made,
      // in place, so the transcript reads as a record instead of a dead control. NEVER throws.
      // Telegram answers 400 "message is not modified" when the text is byte-identical — harmless and reported
      // as-is; callers treat any failure as cosmetic (the decision is already recorded server-side).
      async editMessage(chatId, messageId, text, editOpts) {
        const o2 = editOpts || {};
        const raw = text == null ? '' : String(text);
        const payload = { chat_id: chatId, message_id: messageId, text: raw };
        for (const k in o2) if (k !== 'signal' && Object.prototype.hasOwnProperty.call(o2, k)) payload[k] = o2[k];
        // Same markdown->HTML treatment as send(). Without it a consent card that was DELIVERED formatted would
        // be rewritten into raw `**syntax**` the instant its button was tapped — the exact leak send() fixes,
        // showing up at the one moment the member is looking straight at the message.
        let formatted = false;
        if (!payload.parse_mode && raw) {
          try {
            const f = fmt.toTelegramHtml(raw);
            if (f && f.converted) { payload.text = f.html; payload.parse_mode = 'HTML'; formatted = true; }
          } catch (_) { /* never cost the stamp over formatting */ }
        }
        try {
          let { data, res } = await call('editMessageText', payload, o2.signal);
          if (!(data && data.ok) && formatted && fmt.isParseError(data && data.description)) {
            const plain = { chat_id: chatId, message_id: messageId, text: fmt.toPlainText(raw) };
            for (const k in o2) if (k !== 'signal' && Object.prototype.hasOwnProperty.call(o2, k)) plain[k] = o2[k];
            delete plain.parse_mode;
            ({ data, res } = await call('editMessageText', plain, o2.signal));
          }
          if (data && data.ok) return { ok: true };
          const code = (data && data.error_code) || (res && res.status) || 0;
          return { ok: false, error: redact((data && data.description) || ('http ' + code)) };
        } catch (e) {
          return { ok: false, error: errOf(e, 'network error') };
        }
      },

      // setMyCommands — publish the bot's command list so Telegram's blue "/" menu offers the SAME commands the
      // hub actually implements. Called once per connect from the hub's own command table (one source of truth),
      // so the menu can never drift from what `/help` claims or what parseCommand accepts. NEVER throws — an
      // empty menu is a cosmetic loss, never a reason to fail a connect.
      async setCommands(list, commandOpts) {
        try {
          const commands = (Array.isArray(list) ? list : [])
            .filter(c => c && c.command)
            .map(c => ({ command: String(c.command).toLowerCase().slice(0, 32), description: String(c.description || '').slice(0, 256) }))
            .slice(0, 100);   // Bot API hard cap
          const o2 = commandOpts || {};
          const payload = { commands: commands };
          // Telegram's default scope covers DMs, but an explicit all-group scope makes the same command menu
          // available in supergroups and forum topics even when a prior BotFather configuration was narrower.
          const scope = o2.scope;
          const scopeTypes = ['default', 'all_private_chats', 'all_group_chats', 'all_chat_administrators', 'chat', 'chat_administrators'];
          if (scope && scopeTypes.indexOf(String(scope.type || '')) !== -1) {
            payload.scope = { type: String(scope.type) };
            if ((payload.scope.type === 'chat' || payload.scope.type === 'chat_administrators') && scope.chatId != null) payload.scope.chat_id = String(scope.chatId);
          }
          if (o2.languageCode) payload.language_code = String(o2.languageCode).slice(0, 16);
          const { data, res } = await call('setMyCommands', payload);
          if (data && data.ok) return { ok: true, count: commands.length };
          const code = (data && data.error_code) || (res && res.status) || 0;
          return { ok: false, error: redact((data && data.description) || ('http ' + code)) };
        } catch (e) {
          return { ok: false, error: errOf(e, 'network error') };
        }
      },

      /* setShortDescription — the line under the bot's name in its profile. A Telegram BOT has no presence dot
         (that is a user-account feature), so this is the closest thing to "the station is up". Off by default,
         exactly as in the reference harness, and for a good reason: it rewrites a PUBLIC profile field that the
         member may have written themselves, so it is opt-in or nothing. Capped at Telegram's 120 characters.
         NEVER throws — a status line is the least important thing this channel does. */
      async setShortDescription(text) {
        try {
          const { data, res } = await call('setMyShortDescription', { short_description: String(text == null ? '' : text).slice(0, 120) });
          if (data && data.ok) return { ok: true };
          const code = (data && data.error_code) || (res && res.status) || 0;
          return { ok: false, error: redact((data && data.description) || ('http ' + code)) };
        } catch (e) {
          return { ok: false, error: errOf(e, 'network error') };
        }
      },

      /* deleteMessage — remove a message WE sent. Exactly one caller: live streaming, when the partially-written
         reply can no longer be updated in place (the edit failed, or the run was superseded before it finished).
         Leaving a half-written answer above the real one is worse than any tidiness argument for keeping it.
         NEVER throws; a failed delete is logged nowhere and costs nothing — Telegram also refuses after 48h,
         which is far outside the seconds this is used within. */
      async deleteMessage(chatId, messageId) {
        try {
          const { data, res } = await call('deleteMessage', { chat_id: chatId, message_id: messageId });
          if (data && data.ok) return { ok: true };
          const code = (data && data.error_code) || (res && res.status) || 0;
          return { ok: false, error: redact((data && data.description) || ('http ' + code)) };
        } catch (e) {
          return { ok: false, error: errOf(e, 'network error') };
        }
      },

      /* setMessageReaction — the cheapest possible "I heard you": one API call, no message, no chunking, and
         nothing for the member to scroll past. A 👀 goes on the question while the run is thinking and is
         cleared when the answer lands, so the acknowledgement never outlives the thing it acknowledges.

         `emoji` empty/absent CLEARS every reaction we set. Bots may only use emoji from Telegram's fixed
         reaction set — an unlisted one is a 400, which is why the choice lives in the hub as a constant rather
         than being configurable prose. NEVER throws, and every caller treats a failure as nothing: a bot without
         the react permission simply shows no tick, and the reply is unaffected. */
      async setReaction(chatId, messageId, emoji) {
        try {
          const reaction = emoji ? [{ type: 'emoji', emoji: String(emoji) }] : [];
          const { data, res } = await call('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction: reaction });
          if (data && data.ok) return { ok: true };
          const code = (data && data.error_code) || (res && res.status) || 0;
          return { ok: false, error: redact((data && data.description) || ('http ' + code)), retryable: code === 429 || code >= 500 };
        } catch (e) {
          return { ok: false, error: errOf(e, 'network error'), retryable: true };
        }
      },

      /* ---- OUTBOUND MEDIA -------------------------------------------------------------------------------
         Until now the agent could RECEIVE a file and could not send one back: it would generate an image or
         write a report and then describe it in prose. These are the Bot API's upload methods, all multipart.

         sendMedia(chatId, item, opts?) — ONE file.
           item = { kind, buffer, filename?, mime?, caption? }
           kind picks the method, and the method decides how Telegram RENDERS it: 'photo' shows inline (and is
           re-encoded/compressed by Telegram), 'document' keeps the exact bytes and the filename, 'voice' is the
           round push-to-play bubble (opus/ogg only), 'audio' is a music player row, 'video'/'animation' play
           inline. An unknown kind degrades to 'document' — the one method that can carry ANY bytes, so a new
           kind never becomes a failed send.
         sendMediaGroup(chatId, items, opts?) — 2..10 photos/videos as ONE album (Telegram's own limits).

         Both NEVER throw and return the same normalized SendResult shape as send(), so the adapter's bounded
         resend and the hub's degrade path read them identically. */
      async sendMedia(chatId, item, mediaOpts) {
        const it = item || {}, o2 = mediaOpts || {};
        const buf = it.buffer;
        if (!buf || !buf.length) return { ok: false, error: 'no bytes to send', retryable: false };
        if (buf.length > MAX_UPLOAD_BYTES) {
          return { ok: false, error: 'file is too large for Telegram (' + Math.round(buf.length / (1024 * 1024)) + 'MB > 50MB)', retryable: false };
        }
        const spec = MEDIA_METHODS[String(it.kind || '').toLowerCase()] || MEDIA_METHODS.document;
        const fields = { chat_id: chatId };
        for (const k in o2) if (k !== 'signal' && !ROUTE_KEYS[k] && Object.prototype.hasOwnProperty.call(o2, k)) fields[k] = o2[k];
        applyRoute(fields, o2);   // a file answers in the topic that asked for it, same as the words do
        // The caption rides the SAME markdown->HTML converter as send(), with the same plain-text floor: a
        // caption is the one piece of prose on a media send and would otherwise show raw `**bold**`.
        let formatted = false;
        const rawCap = it.caption == null ? '' : String(it.caption);
        if (rawCap) {
          fields.caption = rawCap.slice(0, MAX_CAPTION_LENGTH);
          if (!fields.parse_mode) {
            try {
              const f = fmt.toTelegramHtml(fields.caption);
              if (f && f.converted) { fields.caption = f.html; fields.parse_mode = 'HTML'; formatted = true; }
            } catch (_) { /* a formatter fault must never cost the file */ }
          }
        }
        const file = [{ field: spec.field, filename: String(it.filename || spec.field), contentType: String(it.mime || '') || 'application/octet-stream', buffer: buf }];
        try {
          let { data, res } = await callMultipart(spec.method, fields, file, o2.signal);
          if (!(data && data.ok) && formatted && fmt.isParseError(data && data.description)) {
            const plain = Object.assign({}, fields, { caption: fmt.toPlainText(rawCap).slice(0, MAX_CAPTION_LENGTH) });
            delete plain.parse_mode;
            ({ data, res } = await callMultipart(spec.method, plain, file, o2.signal));
          }
          if (data && data.ok) return { ok: true, messageId: String((data.result && data.result.message_id) != null ? data.result.message_id : '') };
          const code = (data && data.error_code) || (res && res.status) || 0;
          const retryAfter = data && data.parameters && data.parameters.retry_after;
          return { ok: false, error: redact((data && data.description) || ('http ' + code)), retryable: code === 429 || code >= 500, retryAfter: retryAfter };
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.aborted)) return { ok: false, error: 'aborted', retryable: false };
          return { ok: false, error: errOf(e, 'network error'), retryable: true };
        }
      },

      async sendMediaGroup(chatId, items, groupOpts) {
        const list = (Array.isArray(items) ? items : []).filter(x => x && x.buffer && x.buffer.length);
        if (list.length < 2) return { ok: false, error: 'an album needs at least 2 items', retryable: false };
        const use = list.slice(0, MAX_ALBUM_ITEMS);
        const o2 = groupOpts || {};
        const total = use.reduce((n, x) => n + x.buffer.length, 0);
        if (total > MAX_UPLOAD_BYTES) return { ok: false, error: 'album is too large for Telegram (' + Math.round(total / (1024 * 1024)) + 'MB > 50MB)', retryable: false };
        // Each item is described in a JSON `media` array and its bytes attach under a generated field name that
        // the description points at with attach://<field> — that indirection IS the Bot API's album contract.
        const files = [], media = [];
        use.forEach((it, i) => {
          const field = 'file' + i;
          const kind = String(it.kind || '').toLowerCase();
          const type = (kind === 'video' || kind === 'audio' || kind === 'document') ? kind : 'photo';
          const entry = { type: type, media: 'attach://' + field };
          if (i === 0 && it.caption) entry.caption = String(it.caption).slice(0, MAX_CAPTION_LENGTH);   // Telegram shows only the FIRST caption
          media.push(entry);
          files.push({ field: field, filename: String(it.filename || field), contentType: String(it.mime || '') || 'application/octet-stream', buffer: it.buffer });
        });
        const fields = { chat_id: chatId, media: media };
        for (const k in o2) if (k !== 'signal' && !ROUTE_KEYS[k] && Object.prototype.hasOwnProperty.call(o2, k)) fields[k] = o2[k];
        applyRoute(fields, o2);
        try {
          const { data, res } = await callMultipart('sendMediaGroup', fields, files, o2.signal);
          if (data && data.ok) {
            const arr = Array.isArray(data.result) ? data.result : [];
            return { ok: true, messageId: String((arr[0] && arr[0].message_id) != null ? arr[0].message_id : ''), count: arr.length };
          }
          const code = (data && data.error_code) || (res && res.status) || 0;
          const retryAfter = data && data.parameters && data.parameters.retry_after;
          return { ok: false, error: redact((data && data.description) || ('http ' + code)), retryable: code === 429 || code >= 500, retryAfter: retryAfter };
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.aborted)) return { ok: false, error: 'aborted', retryable: false };
          return { ok: false, error: errOf(e, 'network error'), retryable: true };
        }
      },

      /* never throws: a network/abort/HTTP error becomes a SendResult so the adapter's bounded resend can run.

         MARKDOWN -> HTML (2026-07-28). Replies used to go out as plain text with no `parse_mode`, so an LLM's
         ordinary markdown landed on the phone as raw syntax — literal `**bold**`, backticks, `## headings`.
         channels/telegram.format.js converts the balanced subset it can prove is safe. A caller that sets its
         OWN parse_mode is left completely alone.

         THE FALLBACK IS THE POINT. A malformed entity string is a 400 and the message is LOST, which would be
         a far worse bug than the raw syntax we started with. So a parse rejection resends ONCE without
         parse_mode, stripped of the markdown punctuation — the floor is exactly the old behaviour, minus the
         syntax noise. Only entity errors are retried: a 403 (blocked) or "chat not found" fails identically
         the second time and must not be sent twice. */
      async send(chatId, text, sendOpts) {
        const o2 = sendOpts || {};
        const raw = text == null ? '' : String(text);
        const payload = { chat_id: chatId, text: raw };
        for (const k in o2) if (k !== 'signal' && !ROUTE_KEYS[k] && Object.prototype.hasOwnProperty.call(o2, k)) payload[k] = o2[k];
        applyRoute(payload, o2);
        let formatted = false;
        if (!payload.parse_mode && raw) {
          try {
            const f = fmt.toTelegramHtml(raw);
            if (f && f.converted) { payload.text = f.html; payload.parse_mode = 'HTML'; formatted = true; }
          } catch (_) { /* a formatter fault must never cost the message — send it as-is */ }
        }
        try {
          let sent = payload;                                   // the payload that produced the CURRENT result
          let { data, res } = await call('sendMessage', sent, o2.signal);
          if (!(data && data.ok) && formatted && fmt.isParseError(data && data.description)) {
            const plain = { chat_id: chatId, text: fmt.toPlainText(raw) };
            for (const k in o2) if (k !== 'signal' && !ROUTE_KEYS[k] && Object.prototype.hasOwnProperty.call(o2, k)) plain[k] = o2[k];
            delete plain.parse_mode;
            applyRoute(plain, o2);
            sent = plain;
            ({ data, res } = await call('sendMessage', sent, o2.signal));
          }
          // The topic we were told to answer in is gone (closed/deleted/never existed). Resend to the chat root
          // rather than lose the reply. Runs AFTER the entity fallback and rebuilds from `sent`, so a message that
          // already fell back to plain text does not silently get its markdown syntax back on the way to General.
          let threadGone = false;
          if (!(data && data.ok) && sent.message_thread_id != null && isThreadError(data && data.description)) {
            const rootward = Object.assign({}, sent);
            delete rootward.message_thread_id;
            threadGone = true;
            ({ data, res } = await call('sendMessage', rootward, o2.signal));
          }
          if (data && data.ok) {
            const out = { ok: true, messageId: String((data.result && data.result.message_id) != null ? data.result.message_id : '') };
            /* Tell the caller the topic is GONE, not merely that this one send had to duck around it. Without
               this the hub keeps the dead thread id and every later send pays the same failed call plus retry —
               the delivery is saved but the binding stays stale forever. Additive: a caller that ignores the
               flag behaves exactly as before. */
            if (threadGone) out.threadGone = true;
            return out;
          }
          const code = (data && data.error_code) || (res && res.status) || 0;
          const retryAfter = data && data.parameters && data.parameters.retry_after;
          return { ok: false, error: redact((data && data.description) || ('http ' + code)), retryable: code === 429 || code >= 500, retryAfter: retryAfter };
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.aborted)) return { ok: false, error: 'aborted', retryable: false };
          return { ok: false, error: errOf(e, 'network error'), retryable: true };   // transient transport failure
        }
      }
    };
  }

  return { makeTelegramTransport, ALLOWED_UPDATES, DEFAULT_API_BASE, DEFAULT_REQUEST_TIMEOUT_MS, MAX_UPLOAD_BYTES, MAX_CAPTION_LENGTH, MAX_ALBUM_ITEMS, MEDIA_METHODS };
});
