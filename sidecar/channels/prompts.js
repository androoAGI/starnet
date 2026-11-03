/* sidecar/channels/prompts.js — the pending-BUTTON registry behind every inline keyboard (C6).

   ONE bounded, channel-agnostic map from a short opaque token to "what a tap on this button MEANS". It is the
   piece that makes inline keyboards possible at all: Telegram caps `callback_data` at 64 BYTES, so the payload
   (a full option string, a runId+promptId pair) can never ride on the button. Instead the button carries
   `<kind>:<token>:<idx>` (~13 bytes) and the meaning is looked up here.

     makePromptRegistry({ newId, max? }) -> {
       create({ kind, chatId, chatType, options, meta }) -> entry   // entry.token is the callback key
       attach(token, messageId)          // remember WHICH message to edit once a button is tapped
       peek(token)                       // what a tap MEANS, without spending it (a tap is made durable first)
       take(token)                       // SINGLE-USE pop: a second tap on the same button finds nothing
       peekChat(chatId, kind)            // the live prompt for a chat (typed-answer coercion reads this)
       dropChat(chatId)                  // a superseding message invalidates this chat's stale buttons
       data(token, idx) / parse(data)    // the callback_data codec
       size()
     }

   Two deliberate departures from the reference harness, both of which are live bugs there:
     · BOUNDED. The reference keeps four per-adapter dicts that are only ever emptied when a button is actually
       tapped — an ignored prompt leaks forever. Here `max` (default 200) evicts oldest-first (Map preserves
       insertion order), so an abandoned keyboard costs one bounded slot and then goes.
     · RESOLVED BY TOKEN, NEVER FIFO. The reference resolves an approval by popping queue[0] for the session, so
       with two concurrent prompts, tapping the SECOND one answers the FIRST. Every lookup here is by the token
       the tapped button itself carried, so concurrent prompts can never cross-resolve.

   Tokens come from the INJECTED `newId` (never a counter): a counter would restart at 1 after a sidecar restart
   and a stale button from the previous process would then resolve a BRAND NEW prompt. Pure + deterministic —
   no clock, no rng, no I/O. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.prompts = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_MAX = 200;
  // one char per kind keeps callback_data short; the map is the single source of truth for both directions.
  const KIND_CODE = { choice: 'q', consent: 'c' };
  const CODE_KIND = { q: 'choice', c: 'consent' };
  // Telegram's hard cap. We never approach it (a token is 12 chars), but parse() refuses anything longer so a
  // future caller can't silently ship a keyboard whose buttons Telegram rejects at send time.
  const MAX_CALLBACK_BYTES = 64;
  const TOKEN_CHARS = 12;

  function makePromptRegistry(opts) {
    const o = opts || {};
    const newId = typeof o.newId === 'function' ? o.newId : null;
    if (!newId) throw new Error('makePromptRegistry: an injected newId is required');
    const max = Number.isFinite(o.max) ? Math.max(1, o.max | 0) : DEFAULT_MAX;
    const byToken = new Map();   // token -> entry (insertion-ordered → oldest-first eviction)

    // a token must be unguessable-ish and NEVER recycled across restarts (see header). Strip separators so the
    // codec's ':' split stays unambiguous, and retry on the (vanishingly unlikely) live collision.
    function mintToken() {
      for (let i = 0; i < 5; i++) {
        const t = String(newId()).replace(/[^A-Za-z0-9]/g, '').slice(0, TOKEN_CHARS);
        if (t && !byToken.has(t)) return t;
      }
      return null;
    }

    function create(spec) {
      const s = spec || {};
      const kind = KIND_CODE[s.kind] ? s.kind : 'choice';
      // label   = what the BUTTON reads (short; Telegram truncates on narrow phones)
      // value   = what the tap MEANS downstream (the full option text, or a consent decision like 'once')
      // display = what the resolved message is STAMPED with (defaults to label; choices stamp their full text,
      //           which the button label had to truncate)
      const options = (Array.isArray(s.options) ? s.options : [])
        .map(x => (x && typeof x === 'object')
          ? { label: String(x.label == null ? '' : x.label), value: String(x.value == null ? '' : x.value), display: String(x.display == null ? (x.label == null ? '' : x.label) : x.display) }
          : { label: String(x == null ? '' : x), value: String(x == null ? '' : x), display: String(x == null ? '' : x) })
        .filter(x => x.label && x.value);
      if (!options.length) return null;
      const token = mintToken();
      if (!token) return null;
      // evict oldest FIRST so the new entry is never the one dropped by its own insert.
      while (byToken.size >= max) {
        const oldest = byToken.keys().next();
        if (oldest.done) break;
        byToken.delete(oldest.value);
      }
      const entry = {
        token: token,
        kind: kind,
        chatId: String(s.chatId == null ? '' : s.chatId),
        chatType: s.chatType === 'group' ? 'group' : 'dm',
        options: options,
        messageId: '',
        meta: s.meta && typeof s.meta === 'object' ? s.meta : {}
      };
      byToken.set(token, entry);
      return entry;
    }

    // The keyboard is SENT before Telegram tells us its message_id, so the id is stitched on afterwards. Without
    // it a tap can still resolve — it just can't strip the spent buttons off the original message.
    function attach(token, messageId) {
      const e = byToken.get(String(token || ''));
      if (!e) return false;
      e.messageId = messageId == null ? '' : String(messageId);
      return true;
    }

    /* NON-CONSUMING, by token (channel-delivery-ledger S3). A choice tap is written to the delivery ledger as a durable
       receipt BEFORE its token is spent: a tap whose receipt cannot be written is not acknowledged, the platform hands it
       over again, and this must still find the token then. The hub takes it (below) once the receipt is durable. */
    function peek(token) {
      return byToken.get(String(token || '')) || null;
    }

    // SINGLE-USE by design: a double-tap (or a tap racing a typed answer) finds nothing and is reported to the
    // user as already-resolved instead of running the decision twice.
    function take(token) {
      const t = String(token || '');
      const e = byToken.get(t);
      if (!e) return null;
      byToken.delete(t);
      return e;
    }

    // the newest live prompt of a kind for one chat — typed-answer coercion ("2") and supersede cleanup read this.
    function peekChat(chatId, kind) {
      const cid = String(chatId == null ? '' : chatId);
      let found = null;
      for (const e of byToken.values()) {
        if (e.chatId !== cid) continue;
        if (kind && e.kind !== kind) continue;
        found = e;   // keep walking: insertion order means the LAST match is the newest
      }
      return found;
    }

    // a new inbound supersedes this chat's run, so its outstanding buttons are stale — drop them rather than let
    // a late tap answer a question the conversation has already moved past.
    function dropChat(chatId, kind) {
      const cid = String(chatId == null ? '' : chatId);
      const dead = [];
      for (const [t, e] of byToken) if (e.chatId === cid && (!kind || e.kind === kind)) dead.push(t);
      for (const t of dead) byToken.delete(t);
      return dead.length;
    }

    function data(token, idx) {
      const e = byToken.get(String(token || ''));
      const code = e ? KIND_CODE[e.kind] : KIND_CODE.choice;
      return code + ':' + String(token) + ':' + String(idx | 0);
    }

    // tolerant of anything a client (or a stale keyboard from an older build) can send: never throws, returns
    // null for every shape we don't recognize.
    function parse(raw) {
      const s = String(raw == null ? '' : raw);
      if (!s || s.length > MAX_CALLBACK_BYTES) return null;
      const parts = s.split(':');
      if (parts.length !== 3) return null;
      const kind = CODE_KIND[parts[0]];
      if (!kind) return null;
      if (!/^[A-Za-z0-9]{1,32}$/.test(parts[1])) return null;
      if (!/^\d{1,3}$/.test(parts[2])) return null;
      return { kind: kind, token: parts[1], idx: Number(parts[2]) };
    }

    return { create, attach, peek, take, peekChat, dropChat, data, parse, size: () => byToken.size };
  }

  return { makePromptRegistry, KIND_CODE, CODE_KIND, MAX_CALLBACK_BYTES, DEFAULT_MAX };
});
