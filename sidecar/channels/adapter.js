/* sidecar/channels/adapter.js — the generic, transport-agnostic messaging-channel adapter (C1).

   The reference harness attaches an agent to ANY messaging platform through one transport-agnostic base
   class (`BasePlatformAdapter`) that owns the inbound poll/normalize/admission pipeline and a `send`, and
   translates the wire format into two normalized shapes — inbound `MessageEvent`, outbound `SendResult`.
   The agent runtime is reached through a single injected message-handler callback; the base imports no
   LLM/agent SDK. We re-derive the SMALLEST honest version of that shape for our Node sidecar:

     makeChannelAdapter({ transport, normalize, name, maxMessageLength, allowedChats,
                          onInbound, onCallback?, onStatus?, clock, pollTimeoutSec?, backoffMs?, sleep? })
       -> { name, MAX_MESSAGE_LENGTH, connect(), disconnect(), send(chatId,text,opts?), chatInfo(chatId) }

   The adapter is PURE and platform-agnostic: it owns the long-poll loop, offset tracking, the DM/allowlist
   admission gate, the timestamp stamp (from the injected clock), and the `onInbound(InboundMessage)` push
   to the runtime — it knows nothing of the loop/provider/agent (the runtime-agnostic half of the reference
   harness's contract). All wire I/O lives behind the injected `transport` (a thin fetch wrapper supplied by the
   composition root); every test injects a FAKE transport, so no test ever hits the network. The
   PLATFORM-SPECIFIC parse of a raw update is the injected `normalize(rawUpdate)` (Telegram supplies it in
   C2), keeping `transport` a dumb HTTPS shim.

   Normalized shapes (plain objects, no classes — Node, not Python dataclasses):
     InboundMessage = { channel, chatId, chatType:'dm'|'group', userId, userName?, text, messageId, ts }
     SendResult     = { ok, messageId?, error?, retryable? }

   Deterministic: no Date.now / Math.random / new Date() — `ts` comes from clock.now(); backoff is a fixed
   ladder with NO jitter; `sleep` is injected so tests advance instantly. Chunking the reply to the 4096
   limit is the HUB's job (C5), not the adapter's — `send` emits exactly one message. This commit ships the
   pure module + its fake-transport test only; the real Telegram transport (C2) and the run-host wiring (C5)
   come later. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.adapter = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_BACKOFF = [1000, 2000, 5000, 15000, 30000];   // fixed exponential ladder, capped, NO jitter (determinism)
  const DEFAULT_POLL_TIMEOUT_SEC = 50;                        // long-poll: a quiet getUpdates parks this long server-side

  // a poll error whose .fatal is set (e.g. a 401 invalid-token) stops the loop for good rather than backing off.
  const isFatal = (e) => !!(e && e.fatal);
  // a poll error whose .conflict is set (Telegram 409: another poller/webhook holds the token) is a LIVE contest,
  // not a verdict on the token — the loop stays alive on a slow re-probe cadence and recovers by itself the
  // moment the other consumer stops. Killing the channel here (the old behaviour) also froze channel.send,
  // because `connected` derives from poll state — one transient 409 took BOTH directions down until a restart.
  const isConflict = (e) => !!(e && e.conflict);
  const DEFAULT_CONFLICT_RETRY_MS = 60000;   // slow enough not to fight the other poller, fast enough to self-heal
  // One failed poll proves only that ONE request failed. Keep the last proven health while we immediately retry;
  // report `down` only after a second consecutive failure. This removes false disconnects from momentary DNS/TLS
  // blips without hiding a sustained outage, and the loop still retries forever on the existing capped ladder.
  const DEFAULT_DOWN_AFTER_FAILURES = 2;
  const isAbort = (e) => !!(e && (e.name === 'AbortError' || e.aborted));

  function normalizeAllowed(allowedChats) {
    const s = new Set();
    if (Array.isArray(allowedChats)) for (const c of allowedChats) s.add(String(c));
    else if (allowedChats && typeof allowedChats.forEach === 'function') allowedChats.forEach(c => s.add(String(c)));
    return s;
  }

  function makeChannelAdapter(opts) {
    const o = opts || {};
    const transport = o.transport;
    const normalize = o.normalize;
    if (!transport || typeof transport.getUpdates !== 'function' || typeof transport.send !== 'function')
      throw new Error('makeChannelAdapter: transport must provide getUpdates() and send()');
    if (typeof normalize !== 'function') throw new Error('makeChannelAdapter: normalize(rawUpdate) is required');
    const clock = o.clock;
    if (!clock || typeof clock.now !== 'function') throw new Error('makeChannelAdapter: an injected clock is required');

    const name = o.name || 'channel';
    const MAX_MESSAGE_LENGTH = o.maxMessageLength || 4096;
    const allowed = normalizeAllowed(o.allowedChats);
    const onInbound = typeof o.onInbound === 'function' ? o.onInbound : function () {};
    const onCallback = typeof o.onCallback === 'function' ? o.onCallback : null;   // C6: inline-keyboard taps
    const onStatus = typeof o.onStatus === 'function' ? o.onStatus : null;         // channel.connect telemetry
    // Delivery health is intentionally separate from poll health: a bot can still receive updates while Telegram
    // refuses outbound sends (blocked chat, an outbound-only proxy fault, or a transient API outage).
    const onDelivery = typeof o.onDelivery === 'function' ? o.onDelivery : null;
    const onMembership = typeof o.onMembership === 'function' ? o.onMembership : null;   // we were added/blocked/kicked
    const pollTimeoutSec = o.pollTimeoutSec || DEFAULT_POLL_TIMEOUT_SEC;
    const backoff = Array.isArray(o.backoffMs) && o.backoffMs.length ? o.backoffMs.slice() : DEFAULT_BACKOFF.slice();
    const conflictRetryMs = Number(o.conflictRetryMs) > 0 ? Number(o.conflictRetryMs) : DEFAULT_CONFLICT_RETRY_MS;
    const downAfterFailures = Number(o.downAfterFailures) > 0 ? Math.floor(Number(o.downAfterFailures)) : DEFAULT_DOWN_AFTER_FAILURES;
    const sleep = typeof o.sleep === 'function' ? o.sleep : (ms => new Promise(r => setTimeout(r, ms)));
    const dropPending = o.dropPendingOnConnect === true;   // generic default OFF; the Telegram layer turns it on

    // owner-only admission for DMs (trust-on-first-use): the FIRST direct message claims ownership; every later
    // DM from a DIFFERENT user is dropped BEFORE onInbound — i.e. before any model key is spent or memory is read.
    // A preset ownerUserId (restored from saved config) skips the claim. Empty string == unclaimed. Group access
    // stays governed by allowedChats, independently.
    let owner = o.ownerUserId ? String(o.ownerUserId) : '';
    const onOwnerClaim = typeof o.onOwnerClaim === 'function' ? o.onOwnerClaim : null;
    // Optional explicit-enrollment hook. Absent it, existing adapters retain TOFU behavior.
    // It receives (message, userId) and returns true or { allow, consume, reply }.
    const ownerAdmission = typeof o.ownerAdmission === 'function' ? o.ownerAdmission : null;
    // Chats whose offline backlog we discarded while the owner was still UNCLAIMED (a fresh install, or any
    // first contact). We cannot apologise at connect: claiming ownership from stale backlog is exactly the
    // anti-stale-directive behaviour we preserve, and answering a chat we have NOT yet proven is the owner
    // would break owner-only silence toward a stranger who found a discoverable bot. So the notice waits here
    // until that chat proves it IS the owner by sending a live message. Bounded — a flood of stranger DMs
    // while the bot was down must not grow this without limit.
    const deferredOfflineNotice = new Set();
    const MAX_DEFERRED_NOTICE = 50;
    // ONE wording for both paths. It deliberately states NO count: getUpdates({offset:-1}) returns only the
    // LAST pending update, yet advancing past it discards every earlier one too — so a tally of what we could
    // SEE would under-report what we actually DROPPED, and "1 message arrived" when three did is exactly the
    // kind of confident-but-wrong claim this project treats as a defect.
    const OFFLINE_NOTICE = 'I was offline — anything you sent while I was away was not processed. Please resend whatever still matters.';
    function ownerDecision(userId, message) {
      const uid = String(userId == null ? '' : userId);
      if (owner) return { ok: uid === owner, claimed: false, consume: false, reply: '' };
      if (!uid) return { ok: false, claimed: false, consume: false, reply: '' };
      let decision = true; // preserve trust-on-first-use for adapter callers that have not opted in
      if (ownerAdmission) {
        try { decision = ownerAdmission(message || {}, uid); } catch (_) { decision = false; }
      }
      if (decision !== true && !(decision && decision.allow === true)) return { ok: false, claimed: false, consume: false, reply: '' };
      owner = uid;
      if (onOwnerClaim) { try { onOwnerClaim(uid); } catch (_) {} }
      return {
        ok: true,
        claimed: true,
        consume: !!(decision && decision.consume),
        reply: decision && typeof decision.reply === 'string' ? decision.reply : ''
      };
    }
    function ownerOk(userId, message) { return ownerDecision(userId, message).ok; }

    /* GROUP DISCIPLINE (2026-07-29). We used to answer EVERY message in a whitelisted group, and never checked
       whether the sender was a bot. In a room with any traffic that is a model call per message — the member
       pays for a conversation they are not in — and two Agent OS bots in one group would answer each other
       forever. Three gates, each independently disableable, all no-ops for a DM:

         ignoreBots     (default ON)  — a message from another bot never runs. This one is not a preference:
                                        bot-to-bot is an unbounded spend loop with no human in it.
         requireMention (default ON)  — in a GROUP, run only when the message addresses us: an @mention of our
                                        username, a reply to one of OUR messages, or a slash command that is
                                        either bare or @-suffixed with our name. A group message that addresses
                                        nobody is somebody else's conversation.
         allowedUsers   (default off) — when set, only these user ids run, ON TOP of the existing owner gate for
                                        DMs and the chat allowlist for groups. It NARROWS, it never widens.

       A DM is untouched: it is already owner-only, and requiring the Commander to @-mention a bot in their own
       private chat would be absurd. */
    /* botUsername may be a STRING or a FUNCTION. The station bot learns its own @name from getMe() at connect,
       which resolves AFTER the adapter is constructed — a string captured here would be '' forever and the
       mention gate would sit permanently dormant (a flag with no reader, the exact bug class this project
       keeps re-finding). Reading it lazily means the gate arms the moment the name is known. */
    const botUsernameFn = (typeof o.botUsername === 'function') ? o.botUsername : () => o.botUsername;
    const botUsernameNow = () => String(botUsernameFn() || '').replace(/^@/, '').trim().toLowerCase();
    /* requireMention takes the SAME string-or-function treatment, for a different reason: the member has to be
       able to change their mind. It shipped as a hardcoded default with no command, no route and no UI, which
       meant a room that wanted free response had no way back — a behaviour change with no escape hatch. As a
       function of chatId it reads the chat's own saved setting on every message, so `/mention off` takes effect
       on the next one. Anything other than an explicit `false` keeps the safe default (ON). */
    const requireMentionFn = (typeof o.requireMention === 'function') ? o.requireMention : () => o.requireMention;
    const requireMentionFor = (chatId) => {
      let v;
      try { v = requireMentionFn(String(chatId)); } catch (_) { v = undefined; }   // a store hiccup must not open the room
      return v !== false;
    };
    const ignoreBots = o.ignoreBots !== false;
    const allowedUsers = normalizeAllowed(o.allowedUsers);

    /* WAKE WORDS. `@thebot` is how you address a bot; "Agent OS, check the logs" is how you address a person, and
       it is what people actually type. Without this the most natural way to call the agent by the name the member
       gave it does nothing at all.

       Deliberately LITERAL strings, not the reference harness's regexes: a regex arriving from a config field is
       a ReDoS surface pointed at the poll loop, and a member who mistypes one gets a gate that silently matches
       nothing. Matched case-insensitively at a WORD BOUNDARY (so "Ana" does not fire inside "banana"), and
       anything under three characters is refused — a two-letter agent name would trigger on half the room.
       Read through a function for the same reason botUsername is: the names are learned after construction.

       Failure mode is deliberately the safe one: this only ever WIDENS what counts as being addressed, so a bad
       pattern costs an extra run, never a silenced room. */
    const MIN_WAKE_WORD = 3;
    const mentionPatternsFn = (typeof o.mentionPatterns === 'function') ? o.mentionPatterns : () => o.mentionPatterns;
    const isWordChar = (c) => !!c && /[\p{L}\p{N}_]/u.test(c);
    function wakeWords() {
      let raw;
      try { raw = mentionPatternsFn(); } catch (_) { raw = null; }
      const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      const out = [];
      for (const p of list) {
        const s = String(p == null ? '' : p).trim().toLowerCase();
        if (s.length >= MIN_WAKE_WORD && out.indexOf(s) === -1) out.push(s);
      }
      return out;
    }
    function namedUs(text) {
      const t = String(text == null ? '' : text).toLowerCase();
      if (!t) return false;
      for (const w of wakeWords()) {
        for (let i = t.indexOf(w); i !== -1; i = t.indexOf(w, i + 1)) {
          if (!isWordChar(i === 0 ? '' : t[i - 1]) && !isWordChar(t[i + w.length] || '')) return true;
        }
      }
      return false;
    }

    /* OBSERVE-UNMENTIONED. The mention gate bought spend safety and paid for it in amnesia: an unmentioned group
       message was dropped whole, so when the bot was finally addressed it had no idea what the room had been
       discussing and could not honour "summarise that" or "what do you think of Ana's idea". Observing keeps the
       chatter in the transcript while still dispatching only when addressed — zero model calls for the messages
       it merely hears. Default OFF (as in the reference harness): storing every message a room sends is a real
       decision about the member's data, not a default they should discover afterwards. */
    const observeUnmentionedFn = (typeof o.observeUnmentioned === 'function') ? o.observeUnmentioned : () => o.observeUnmentioned;
    const observeUnmentionedFor = (chatId) => {
      try { return observeUnmentionedFn(String(chatId)) === true; } catch (_) { return false; }
    };

    // Does this group message address US? (Only meaningful when botUsername is known.)
    function addressesUs(m) {
      if (namedUs(m.text)) return true;   // called by name — works even before getMe answers
      const botUsername = botUsernameNow();
      if (!botUsername) return true;   // we don't know our own name — never silence the room over that
      const mentions = Array.isArray(m.mentions) ? m.mentions : [];
      if (mentions.indexOf(botUsername) !== -1) return true;
      // a reply to one of OUR messages is an address, and it is how a thread of follow-ups stays natural
      if (m.replyTo && String(m.replyTo.userName || '').trim().toLowerCase() === botUsername) return true;
      // a slash command with NO @suffix is aimed at whatever bot is listening; with a suffix it is aimed by name
      // (and that name landed in `mentions` above, so a command for a DIFFERENT bot has already failed the check)
      const t = String(m.text == null ? '' : m.text);
      if (/^\/[A-Za-z0-9_]+(\s|$)/.test(t)) return true;
      return false;
    }

    /* ECHO GUARD — the bot must never answer itself.
       In a group Telegram simply does not deliver our own messages back, so `is_bot` on the sender was enough.
       A BROADCAST CHANNEL has no sender to check: a channel post carries no `from` at all, and a post the bot
       itself made arrives looking exactly like one an admin made. Left unguarded that is not a cosmetic bug, it
       is an unbounded loop — every reply becomes a new question. So we remember the message ids WE created and
       refuse them on the way back in. Platform-agnostic on purpose: any future transport that echoes is covered
       by the same net. Bounded and FIFO — this is a recent-echo guard, not a transcript. */
    const MAX_SENT_IDS = 400;
    const sentIds = new Set();   // 'chatId|messageId'
    function rememberSent(chatId, messageId) {
      if (messageId == null || messageId === '') return;
      const k = String(chatId) + '|' + String(messageId);
      sentIds.delete(k); sentIds.add(k);
      while (sentIds.size > MAX_SENT_IDS) { const f = sentIds.values().next().value; sentIds.delete(f); }
    }
    const wasOurs = (chatId, messageId) =>
      messageId != null && messageId !== '' && sentIds.has(String(chatId) + '|' + String(messageId));

    /* THREE verdicts, not two. 'drop' is silence, 'run' is a real turn, and 'observe' is the middle ground the
       mention gate created a need for: heard and remembered, but never dispatched. Kept as one function so the
       order of the gates can only be read one way — an echo, a bot and a non-allowlisted chat are refused before
       anything is stored, so observing can never become a way around admission. */
    function admission(m) {
      if (wasOurs(m.chatId, m.messageId)) return 'drop';               // our own post, echoed back to us
      if (ignoreBots && m.fromBot) return 'drop';                      // never answer another bot, in any chat
      if (allowedUsers.size && !allowedUsers.has(String(m.userId == null ? '' : m.userId))) return 'drop';
      if (m.chatType === 'dm') return 'run';
      if (!allowed.has(String(m.chatId))) return 'drop';
      if (!requireMentionFor(m.chatId)) return 'run';
      if (addressesUs(m)) return 'run';
      return observeUnmentionedFor(m.chatId) ? 'observe' : 'drop';
    }
    // DM-only first cut: a direct message is always admitted; a group/channel message only if whitelisted.
    function admitted(m) { return admission(m) === 'run'; }

    let started = false, stopped = false, down = false, confirmed = false, transientFailures = 0;
    let offset = Number.isFinite(o.startOffset) ? o.startOffset : 0;   // next update id to fetch from
    let ac = null;          // aborts the in-flight getUpdates on disconnect
    let loopDone = null;    // resolves when the poll loop has fully exited

    // HONEST CONNECT: `confirmed` stays false until the FIRST successful poll round-trip — only then do we assert
    // 'up'. Before that the channel is genuinely just 'connecting' (the composition root reports that state), so the
    // panel never claims CONNECTED on an unproven token. After the first success, statusUp/statusDown track live
    // transport health; a single failed request keeps the last proof, while a sustained outage emits down then up.
    function statusUp() {
      transientFailures = 0;
      if (!confirmed) { confirmed = true; down = false; onStatus && onStatus({ state: 'up' }); return; }
      if (down) { down = false; onStatus && onStatus({ state: 'up' }); }
    }
    function statusDown(detail) { if (!down) { down = true; onStatus && onStatus({ state: 'down', detail: detail }); } }
    // A token conflict is reported as 'error' (the panel's actionable state), but through the same `down` latch:
    // emitted once per outage, and BECAUSE `down` is set, the first successful re-probe emits a real 'up' —
    // recovery is announced, never silent.
    function statusConflict(detail) { if (!down) { down = true; onStatus && onStatus({ state: 'error', detail: detail }); } }

    function dispatch(raw) {
      let n;
      try { n = normalize(raw); }
      catch (e) {
        /* A malformed update must be SKIPPED — which means getting past it, not just declining to handle it.
           Returning here without advancing left `offset` pinned to the bad update, and since getUpdates keeps
           returning everything at-or-after `offset` until a higher one confirms it, the poll loop would re-fetch
           and re-throw on the same update forever: a hot spin against the Bot API with the channel permanently
           deaf to every message behind it. Advance past it from the RAW id (the only field we still trust) so
           one unparseable update costs one dropped message instead of the whole channel. */
        const bad = raw && raw.update_id;
        if (Number.isFinite(bad)) offset = Math.max(offset, bad + 1);
        try { console.error('[' + name + '] unparseable update ' + String(bad) + ' skipped:', (e && e.message) || e); } catch (_) {}
        return;
      }
      if (!n) return;                                       // non-text / uninteresting update
      // Offset acknowledgement happens only AFTER an admitted message has synchronously reached the hub's
      // durable inbox seam. If that write throws, dispatch throws and the poll loop retries this exact update;
      // Telegram is never told we consumed work that exists only in RAM.
      const acknowledge = () => { if (Number.isFinite(n.offset)) offset = Math.max(offset, n.offset + 1); };
      if (n.message) {
        const m = n.message;
        const verdict = admission(m);
        if (verdict === 'drop') { acknowledge(); return; }
        let own = null;
        if (m.chatType === 'dm') {
          own = ownerDecision(m.userId, m);
          if (!own.ok) { acknowledge(); return; }   // a non-owner DM never reaches the run host
          // Enrollment is an authentication exchange, not an agent instruction. Route its acknowledgement through
          // the hub as a direct reply: it gets the same durable inbox/outbox guarantees as a model answer while the
          // pairing code stays out of transcript/history. A repeated /pair from the owner is consumed too, so a
          // crash after owner persistence but before acknowledgement can never leak the code into the model.
          // Slack/Discord panels show the slash-less "pair XXXXX-XXXXX" (Slack intercepts "/pair"); consume only
          // that exact code SHAPE so an ordinary "pair these two files" from the owner still reaches the agent.
          const pairText = String(m.text || '');
          const pairCommand = /^\/pair(?:\s|$)/i.test(pairText) || /^pair\s+[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}\s*$/i.test(pairText);
          if ((own.claimed && own.consume) || pairCommand) {
            onInbound({
              channel: name, chatId: String(m.chatId), chatType: 'dm', userId: String(m.userId || ''),
              userName: m.userName, text: '', messageId: m.messageId == null ? '' : String(m.messageId),
              ts: clock.now(), directReply: own.reply || 'Owner is already paired. Send a normal message to run the agent.'
            });
            acknowledge();
            return;
          }
        }
        // This chat had backlog discarded while the owner was unclaimed, and has now PROVEN it is the owner by
        // getting admitted. Pay the deferred apology before its reply — otherwise the Commander's first
        // impression of a bot that was simply switched off is silence, which is what a broken bot looks like.
        // Detached + best-effort by design: the notice must never delay or block the real message.
        if (deferredOfflineNotice.delete(String(m.chatId))) {
          Promise.resolve()
            .then(() => transport.send(String(m.chatId), OFFLINE_NOTICE, {}))
            .catch(e => { try { console.error('[' + name + '] deferred offline-notice failed for chat ' + m.chatId + ':', (e && e.message) || e); } catch (_) {} });
        }
        const im = {
          channel: name,
          chatId: String(m.chatId),
          chatType: m.chatType === 'group' ? 'group' : 'dm',
          userId: m.userId == null ? '' : String(m.userId),
          userName: m.userName,
          text: m.text == null ? '' : String(m.text),
          messageId: m.messageId == null ? '' : String(m.messageId),
          ts: clock.now()
        };
        // media rides through untouched (additive): [{ kind, fileId, name, mime, size }] from the platform's
        // normalize. The hub downloads the bytes via this adapter's getFile and turns them into attachments.
        // mediaGroupId marks one album part; the hub debounce-merges parts sharing it into a single turn.
        if (Array.isArray(m.media) && m.media.length) im.media = m.media;
        if (m.mediaGroupId != null && m.mediaGroupId !== '') im.mediaGroupId = String(m.mediaGroupId);
        // replyTo ({ text, userName?, fromBot?, media? }) rides through untouched, same additive contract as
        // media: the platform's normalize decides whether this message quotes an earlier one, the hub decides
        // how to render it. A platform that never sets it is byte-identical to before.
        if (m.replyTo && typeof m.replyTo === 'object') im.replyTo = m.replyTo;
        // threadId names the sub-conversation this arrived in (a Telegram forum topic today; a Discord thread
        // later). Neutral and additive: the hub remembers it per chat and hands it straight back on every send,
        // and a platform whose normalize never sets it behaves exactly as before.
        if (m.threadId != null && m.threadId !== '') im.threadId = String(m.threadId);
        // Both additive flags, both POLICY questions the hub answers: is a correction worth a fresh run, and is
        // this a broadcast post rather than a person talking. A platform that sets neither behaves as before.
        if (m.edited) im.edited = true;
        if (m.channelPost) im.channelPost = true;
        // A FORWARD is a third party's words under the owner's id — the hub taints its run and never parses it as a
        // command. This rebuild used to drop the flag, so a forwarded message ran as the owner's own order (2026-10-10).
        if (m.forwarded) im.forwarded = true;
        // OBSERVE-ONLY: heard, to be remembered, never dispatched. The hub files it in the transcript and returns
        // before a single model call. Additive — a platform that never observes sends the exact old shape.
        if (verdict === 'observe') im.observeOnly = true;
        if (Array.isArray(m.mentions) && m.mentions.length) im.mentions = m.mentions.slice();
        onInbound(im);   // production hub durably claims synchronously; a failed claim throws before acknowledgement
        acknowledge();
      } else if (n.callback && onCallback) {
        /* Only the owner's taps act — and an UNCLAIMED owner is not a licence, it is the absence of one.
           `!owner ||` made this fail OPEN, and ownership is claimed on the DM path alone (a group message
           never calls ownerOk), so a bot reachable only in a whitelisted group had owner === '' forever and
           ANY member's tap counted — including approve/deny on the /approvals keyboards. A callback can
           never be the trust-on-first-use moment either: the keyboard is on a message WE sent, so it proves
           nothing about who is talking. Fail closed, exactly like the empty-userId DM case. */
        if (owner && String(n.callback.userId) === owner) onCallback(n.callback);
        acknowledge();
      } else if (n.membership && onMembership) {
        /* OUR OWN membership changed. Not admission-gated and not owner-gated: "you were kicked out of chat X"
           is true regardless of who did it, and a chat that has just removed us can hardly prove it is allowed
           to say so. The consumer decides what it means; this is only the wire fact. */
        onMembership({
          channel: name,
          chatId: String(n.membership.chatId),
          chatType: n.membership.chatType === 'group' ? 'group' : 'dm',
          status: String(n.membership.status || ''),
          byUserId: String(n.membership.byUserId || ''),
          ts: clock.now()
        });
        acknowledge();
      } else acknowledge();
    }

    // Client-side long-poll deadline: getUpdates parks server-side for pollTimeoutSec; a half-open socket can leave
    // the fetch hanging FAR past that (no bytes ever arrive). Race the poll against a hard wall-clock =
    // pollTimeoutSec*1000 + 15s slack so a stall aborts in seconds, not the ~5min default socket timeout. The
    // disconnect abort (ac.signal) still wins — we compose both so either fires; a deadline-fire is NOT a disconnect
    // (we distinguish by ac.signal.aborted below) so it just backs off and re-polls. Degrades gracefully on old
    // platforms without AbortSignal.any/timeout (then only ac.signal governs, as before).
    const POLL_DEADLINE_MS = pollTimeoutSec * 1000 + 15000;
    function pollSignal() {
      if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return ac.signal;
      const deadline = AbortSignal.timeout(POLL_DEADLINE_MS);
      return (typeof AbortSignal.any === 'function') ? AbortSignal.any([ac.signal, deadline]) : deadline;
    }

    async function loop() {
      let attempt = 0;
      while (!stopped) {
        let raw;
        try {
          raw = await transport.getUpdates({ offset: offset, timeoutSec: pollTimeoutSec, signal: pollSignal() });
        } catch (e) {
          // Only a REAL disconnect (stopped / the disconnect signal aborted) exits the loop. A deadline-timeout
          // abort has stopped=false and ac.signal.aborted=false, so it falls through to backoff+retry (a stalled
          // poll must recover, not kill the channel).
          if (stopped || (ac && ac.signal && ac.signal.aborted)) break;
          if (isFatal(e)) { onStatus && onStatus({ state: 'error', detail: (e && e.message) || 'fatal' }); break; }
          // token conflict (Telegram 409): stay alive on a slow cadence and self-heal when the other poller stops.
          if (isConflict(e)) {
            statusConflict((e && e.message) || 'token conflict');
            await sleep(conflictRetryMs);
            attempt = 0;   // a conflict is its own ladder — the transient backoff restarts clean afterwards
            continue;
          }
          transientFailures++;
          if (transientFailures >= downAfterFailures) statusDown((e && e.message) || 'poll error');
          await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
          attempt++;
          continue;
        }
        attempt = 0;
        statusUp();
        const updates = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.updates) ? raw.updates : []);
        let intakeFailed = null;
        for (let i = 0; i < updates.length; i++) {
          if (stopped) break;
          try { dispatch(updates[i]); }
          catch (e) { intakeFailed = e; break; }
        }
        if (intakeFailed && !stopped) {
          statusDown('durable intake failed: ' + ((intakeFailed && intakeFailed.message) || 'storage error'));
          try { console.error('[' + name + '] update was NOT acknowledged because durable intake failed:', (intakeFailed && intakeFailed.message) || intakeFailed); } catch (_) {}
          await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
          attempt++;
        }
      }
    }

    return {
      name: name,
      MAX_MESSAGE_LENGTH: MAX_MESSAGE_LENGTH,

      // start the inbound long-poll loop; resolves once listening (the loop runs detached until disconnect()).
      // dropPendingOnConnect (default true): before the first real poll, prime the offset past everything already
      // buffered server-side (getUpdates offset:-1 returns only the last pending update) and DISCARD that backlog,
      // so a restart never replays hours of stale DMs and autonomously runs stale directives. Skipped when an
      // explicit startOffset was given (the caller pinned a resume point).
      connect() {
        if (started) return Promise.resolve();
        started = true; stopped = false;
        ac = new AbortController();
        loopDone = (async () => {
          // proactively clear any stale webhook on this token so getUpdates can't 409 forever (Telegram-only;
          // guarded so generic transports/fakes without the method are unaffected).
          if (typeof transport.deleteWebhook === 'function') { try { await transport.deleteWebhook(); } catch (_) {} }
          if (dropPending && !Number.isFinite(o.startOffset)) {
            try {
              const raw = await transport.getUpdates({ offset: -1, timeoutSec: 0, signal: ac.signal });
              const ups = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.updates) ? raw.updates : []);
              // Count the backlog we're about to DISCARD and remember which chat(s) it came from, so we can post a
              // one-line "I was offline" notice per chat (honesty: the message arrived and was NOT processed). We
              // only count messages that WOULD have been admitted (owner DM / whitelisted group) — a stranger's DM
              // or an off-list group was never going to run, so its drop needs no apology and no key spend.
              const droppedByChat = new Map();   // chatId -> count of admitted-but-discarded backlog messages
              for (const ru of ups) {
                let n; try { n = normalize(ru); } catch (_) {}
                if (n && Number.isFinite(n.offset)) offset = Math.max(offset, n.offset + 1);
                // Pure admission peek — must NOT mutate owner state. ownerOk() claims ownership as a side effect,
                // so we can't call it here (that would let a STALE backlog DM claim the account). A DM counts only
                // when the owner is already known and matches; if the owner is still unclaimed we discard silently
                // (claiming from stale backlog is exactly the anti-stale-directive behavior we're preserving).
                const m = n && n.message;
                const admit = m && (m.chatType === 'dm'
                  ? (!!owner && String(m.userId == null ? '' : m.userId) === owner)
                  : allowed.has(String(m.chatId)));
                if (admit) {
                  const cid = String(m.chatId);
                  droppedByChat.set(cid, (droppedByChat.get(cid) || 0) + 1);
                } else if (m && m.chatType === 'dm' && !owner && deferredOfflineNotice.size < MAX_DEFERRED_NOTICE) {
                  // Owner still unclaimed, so we cannot tell yet whether this is the Commander or a stranger.
                  // DEFER the apology rather than drop it: this is the first-run case where someone messages a
                  // bot that is not running, and answering with nothing at all reads as a broken bot.
                  deferredOfflineNotice.add(String(m.chatId));
                }
              }
              // the next poll uses `offset` (= last backlog id + 1), which confirms+discards the backlog; we did NOT dispatch it.
              // Best-effort notice: never throw (a failed notice must not stop connect); the loop below still starts.
              for (const cid of droppedByChat.keys()) {
                if (stopped) break;
                try { await transport.send(cid, OFFLINE_NOTICE, {}); }
                catch (e) { try { console.error('[' + name + '] offline-notice send failed for chat ' + cid + ':', (e && e.message) || e); } catch (_) {} }
              }
            } catch (e) { if (stopped || isAbort(e)) return; /* fatal/transient handled by the loop below */ }
          }
          if (!stopped) await loop();
        })();
        return Promise.resolve();
      },

      // stop the loop and abort the in-flight getUpdates; resolves once the loop has fully exited.
      async disconnect() {
        stopped = true;
        try { if (ac) ac.abort(); } catch (_) {}
        try { await loopDone; } catch (_) {}
        started = false;
      },

      // send ONE message (the hub chunks long replies to MAX_MESSAGE_LENGTH before calling this). A transport
      // result with { ok:false, retryable:true } gets exactly ONE bounded resend (the reference harness's bounded-resend, minimal),
      // and on a 429 we WAIT out the server's retry_after (capped) first, so the resend lands after the flood window
      // instead of bouncing instantly into it.
      async send(chatId, text, sendOpts) {
        const t = text == null ? '' : String(text);
        let r = await transport.send(String(chatId), t, sendOpts || {});
        let attempts = 1;
        if (r && r.ok === false && r.retryable) {
          const waitMs = Math.min((Number(r.retryAfter) > 0 ? Number(r.retryAfter) : 1) * 1000, 30000);
          await sleep(waitMs);
          r = await transport.send(String(chatId), t, sendOpts || {});
          attempts++;
        }
        if (r && r.ok) rememberSent(chatId, r.messageId);   // so a channel echoing this back is not taken for input
        if (onDelivery) {
          try {
            onDelivery({ ok: !!(r && r.ok), chatId: String(chatId), attempts: attempts,
              detail: r && r.ok ? '' : String((r && r.error) || 'send failed').slice(0, 240) });
          } catch (_) {}
        }
        return r;
      },

      // Fire one "typing…" chat-action (transport-optional, like getFile): { ok, error?, retryable?, retryAfter? },
      // never throws. A transport without sendChatAction answers ok:false NON-retryable, so the hub's keep-alive
      // loop stops after one probe instead of hammering a channel that can't show typing at all.
      // actionOpts (optional) carries the same neutral route as send() — a typing bubble raised in the wrong
      // forum topic is visible to the room, so it must follow the question exactly like the answer does.
      chatAction(chatId, actionOpts) {
        if (typeof transport.sendChatAction !== 'function') return Promise.resolve({ ok: false, error: 'typing not supported on this channel', retryable: false });
        try { return Promise.resolve(transport.sendChatAction(String(chatId), undefined, actionOpts || undefined)); }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'sendChatAction threw', retryable: false }); }
      },

      // ---- inline-keyboard round-trip (C6) ---------------------------------------------------------------
      // All three are transport-OPTIONAL and follow the chatAction/getFile pattern exactly: a channel whose
      // transport lacks the method answers { ok:false, error } instead of throwing, and the hub then falls back
      // to its numbered-text rendering. That fallback is what keeps Discord/Slack/Matrix/Signal working unchanged
      // while Telegram gets real buttons.

      // Acknowledge one inline-keyboard tap (kills the button's spinner; optional toast text).
      answerCallback(callbackId, text) {
        if (typeof transport.answerCallback !== 'function') return Promise.resolve({ ok: false, error: 'inline keyboards not supported on this channel' });
        try { return Promise.resolve(transport.answerCallback(String(callbackId), text)); }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'answerCallback threw' }); }
      },

      // Rewrite an already-sent message (and strip its keyboard by omitting reply_markup from opts).
      editMessage(chatId, messageId, text, editOpts) {
        if (typeof transport.editMessage !== 'function') return Promise.resolve({ ok: false, error: 'message editing not supported on this channel' });
        try { return Promise.resolve(transport.editMessage(String(chatId), String(messageId), text == null ? '' : String(text), editOpts || {})); }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'editMessage threw' }); }
      },

      // Publish the bot's slash-command menu (one-shot, at connect).
      setCommands(list, commandOpts) {
        if (typeof transport.setCommands !== 'function') return Promise.resolve({ ok: false, error: 'command menus not supported on this channel' });
        try { return Promise.resolve(transport.setCommands(list, commandOpts || {})); }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'setCommands threw' }); }
      },

      // The bot's profile status line. Transport-optional; opt-in at the composition root.
      setShortDescription(text) {
        if (typeof transport.setShortDescription !== 'function') return Promise.resolve({ ok: false, error: 'status lines are not supported on this channel' });
        try { return Promise.resolve(transport.setShortDescription(text)); }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'setShortDescription threw' }); }
      },

      // Remove a message we sent. Only the streaming path uses it, and only to clear a partial reply it can no
      // longer finish in place. Transport-optional like the rest.
      deleteMessage(chatId, messageId) {
        if (typeof transport.deleteMessage !== 'function') return Promise.resolve({ ok: false, error: 'deleting messages is not supported on this channel' });
        try { return Promise.resolve(transport.deleteMessage(String(chatId), String(messageId))); }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'deleteMessage threw' }); }
      },

      // React to a message instead of replying to it — the cheapest acknowledgement there is. Transport-optional
      // like every other capability here; a channel that cannot react simply shows nothing.
      setReaction(chatId, messageId, emoji) {
        if (typeof transport.setReaction !== 'function') return Promise.resolve({ ok: false, error: 'reactions not supported on this channel', retryable: false });
        try { return Promise.resolve(transport.setReaction(String(chatId), String(messageId), emoji || '')); }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'setReaction threw', retryable: false }); }
      },

      // ---- OUTBOUND MEDIA (transport-optional, same probe-and-degrade contract) ---------------------------
      // A channel whose transport cannot upload answers { ok:false, error } and the hub falls back to naming
      // the file's workspace path in text. That fallback is the whole reason this is a capability method and
      // not a hard dependency: Discord/Slack/Matrix/Signal keep working untouched until they grow their own.
      sendMedia(chatId, item, mediaOpts) {
        if (typeof transport.sendMedia !== 'function') return Promise.resolve({ ok: false, error: 'sending files is not supported on this channel', retryable: false });
        try {
          return Promise.resolve(transport.sendMedia(String(chatId), item, mediaOpts || {}))
            .then(r => { if (r && r.ok) rememberSent(chatId, r.messageId); return r; });
        }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'sendMedia threw', retryable: false }); }
      },

      sendMediaGroup(chatId, items, groupOpts) {
        if (typeof transport.sendMediaGroup !== 'function') return Promise.resolve({ ok: false, error: 'albums are not supported on this channel', retryable: false });
        try {
          return Promise.resolve(transport.sendMediaGroup(String(chatId), items, groupOpts || {}))
            .then(r => { if (r && r.ok) rememberSent(chatId, r.messageId); return r; });
        }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'sendMediaGroup threw', retryable: false }); }
      },

      // Download one media file's bytes (transport-optional): { ok, buffer?, error? }, never throws. A transport
      // without getFile answers honestly instead of pretending — the hub's note then says media isn't supported.
      getFile(fileId, opts2) {
        if (typeof transport.getFile !== 'function') return Promise.resolve({ ok: false, error: 'media download not supported on this channel' });
        try { return Promise.resolve(transport.getFile(fileId, opts2)); }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'getFile threw' }); }
      },

      // minimal identity (the reference harness's chat-info lookup -> {name,type}); transports may override with a richer lookup.
      chatInfo(chatId) {
        if (typeof transport.chatInfo === 'function') return transport.chatInfo(String(chatId));
        return { id: String(chatId), type: allowed.has(String(chatId)) ? 'group' : 'dm' };
      },

      _internals: { admitted, admission, ownerOk, ownerDecision, normalizeAllowed, dispatch, isFatal, isConflict, isAbort, DEFAULT_BACKOFF, DEFAULT_CONFLICT_RETRY_MS, rememberSent, wasOurs, sentIds, MAX_SENT_IDS, wakeWords, namedUs, MIN_WAKE_WORD, get offset() { return offset; }, get owner() { return owner; } }
    };
  }

  return { makeChannelAdapter, normalizeAllowed, _internals: { isFatal, isConflict, isAbort, DEFAULT_BACKOFF, DEFAULT_POLL_TIMEOUT_SEC, DEFAULT_CONFLICT_RETRY_MS } };
});
