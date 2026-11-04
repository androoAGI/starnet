/* sidecar/channels/outbound.js — ChannelOutbound: the ONE contract for every message the station sends to a chat outside a
   hub's own reply (channel-delivery-ledger, S4).

   WHY ONE CONTRACT. Five send paths left the station on their own terms: a routine's delivery (its own chunker call,
   its own 429 wait stacked on the adapter's resend, its own in-memory FIFO that hub replies did not share, and no
   per-part progress, so a retry resent every part that had landed), channel.send (a second chunker that never reopened
   a code fence, the limit minus 100, no topic), the notifier, the step-in nudge and the loop notice (one unchunked line
   each, no topic, no channel.delivery), and the two "I was offline" notices (straight onto the transport, past
   everything). Each copy of "how long may a message be", "which topic", "is the channel there" and "did it land" was a
   place to disagree (bugs 3a9d5e4a, a199ee3c, c0beb187). This module is the one answer:

     makeChannelOutbound({ ledger, registry, reach, chatRecord, liveChannelFor, scrub, redact, emit, log? }) -> outbound
       outbound.send(target, text, opts) -> Promise<{ ok, error, parts, sent, files?, id?, queued?, undeliverable?, refused? }>
         target  a chat-map key ('4242', '<botId>|<chatId>': chatRecord resolves it) or { channel, chatId }
         opts    { durable?, deliveryId?, kind?, release?, reason, runId?, agentId?, route?, originRunId?, maxParts?,
                   media?, note? }
       outbound.resolve(target) -> { ok, channel, chatId, chat, threadId } | { ok: false, error }
       outbound.provide(kind, { read(d, part), note(d, { failed, unreadable }) })   how a durable record of that kind reads
                                                                    its files again and words its missed-file note
                                                                    (routine-delivery.js: comms.js missedNote, the one wording)

   WHAT EVERY SEND DOES, in this order, before any transport call:
     1. RESOLVE the target to its chat ('<channel>|<chatId>', the delivery ledger's key) and route. An EXPLICIT route
        wins: opts.route (a routine's origin or target thread), else the thread of the run named by opts.originRunId (the
        topic its message came from, read off that run's pending receipt), else the chat's DURABLE route (the topic the
        hub last heard it in, kept in the ledger). General only when the chat has none. A topic the transport finds gone
        (it saved the message at the chat root) leaves the durable route, so no later send pays that failed call again.
     2. REACH: channelReach in ATTEMPT mode (channels/reach.js): a 'connecting' channel may be tried, a 'down' whose cause
        is the durable intake may be tried (intake backpressure is not a transport outage), 'down' and 'error' are
        refused here. A CLAIM (channel.targets, the routine preflight) asks reach bare, elsewhere; never here.
     3. SCRUB the WHOLE text (the host-path scrub over the secret redaction), THEN chunk it at the channel descriptor's
        maxMessageLength with the one chunker (channels/chunk.js): Telegram 4096, Discord 2000. A path cut at a part
        boundary would go out in halves. opts.maxParts refuses a text that needs more parts, before any part is sent.
     4. SEND. durable: one record in the delivery ledger — its text parts, then each file (read again when it is sent),
        then the missed-file note — driven by the chat's FIFO lane like a hub reply, each part's mark written as the
        platform takes it; the call resolves with its FIRST attempt (ok, still queued, or undeliverable). Not durable
        (channel.send, the notifier, a nudge, a loop notice, an offline notice): sent now, once, never queued, holding the
        chat's lane mutex while its parts are on the wire (so they never split a durable reply's parts, and never wait
        behind a lane that is backing off).
     5. REPORT exactly one channel.delivery per send to a chat (a durable record's lane reports it: its first attempt's
        failure, if any, and its landing, as for a hub reply; a send refused before any transport call reports it too; a
        target that names no chat has none to report about), its reason the path's
        own: 'routine', 'tool', 'notify', 'nudge', 'loop', 'note', 'offline' — and 'undeliverable' for a refusal that can
        never succeed (a free string: shared/events.js is unchanged).

   Lanes send a durable record's words through the channel's ATTACHED sender (the hub's own send: hub-delivery.js
   attaches it); this module adds the live adapter's sendMedia for its file parts and words its note (attachParts).
   Pure: every dependency is injected (no fs, no clock, no timers), and every failure it swallows is reported. */
'use strict';

const { note: failNote, swallow } = require('../failopen.js');
const { chunkTextParts } = require('./chunk.js');
const { chatKeyOf } = require('./delivery-ledger.js');

// a channel with no descriptor (the DEV capture): Discord's 2000 is the lowest real ceiling, and 1900 stays under it
const FALLBACK_MAX = 1900;

function makeChannelOutbound(deps) {
  const d = deps || {};
  const ledger = d.ledger, registry = d.registry, reach = d.reach, chatRecord = d.chatRecord, liveChannelFor = d.liveChannelFor;
  const scrub = d.scrub, redact = d.redact, emit = d.emit;
  const need = { ledger, registry, reach, chatRecord, liveChannelFor, scrub, redact, emit };
  const missing = Object.keys(need).filter(k => !need[k]);
  if (missing.length) throw new Error('makeChannelOutbound: missing ' + missing.join(', '));
  if (typeof ledger.sendEphemeral !== 'function' || typeof ledger.enqueue !== 'function') throw new Error('makeChannelOutbound: the ledger must be a delivery ledger');
  const log = typeof d.log === 'function' ? d.log : (line) => console.error(line);
  const kinds = new Map();   // a durable record's kind -> { read(d, part), note(d, { failed, unreadable }) }

  const clean = (text) => scrub(redact(String(text == null ? '' : text)));
  function limitFor(channel) {
    let desc = null;
    try { desc = registry.get(String(channel || '').split(':')[0]); } catch (e) { failNote('channels.outbound.registry', e); desc = null; }
    const n = Number(desc && desc.maxMessageLength);
    return n > 200 ? n : FALLBACK_MAX;
  }

  // ---- 1. the target and its route --------------------------------------------------------------------------------
  function resolve(target) {
    if (target && typeof target === 'object') {
      const channel = String(target.channel || '');
      const chatId = target.chatId == null ? '' : String(target.chatId);
      if (!channel || !chatId) return { ok: false, error: 'unknown chat target' };
      return { ok: true, channel: channel, chatId: chatId, chat: chatKeyOf(channel, chatId), threadId: target.threadId ? String(target.threadId) : '' };
    }
    let rec = null;
    try { rec = chatRecord(String(target)) || null; } catch (e) { failNote('channels.outbound.chatRecord', e); rec = null; }
    if (!rec) return { ok: false, error: 'unknown chat target' };
    const channel = String(rec.channel || 'telegram');
    const chatId = String(rec.chatId || target);
    return { ok: true, channel: channel, chatId: chatId, chat: chatKeyOf(channel, chatId), threadId: rec.threadId ? String(rec.threadId) : '' };
  }
  function routeFor(chat, o) {
    if (o.route && o.route.threadId) return { threadId: String(o.route.threadId) };
    if (o.originRunId) {
      // the topic the run's own message came from: its receipt is pending in the ledger while the run works
      let pending = [];
      try { pending = ledger.pending(); } catch (e) { failNote('channels.outbound.pending', e); pending = []; }
      const r = pending.find(x => x.attempt && x.attempt.runId === String(o.originRunId) && chatKeyOf(x.channel, x.chatId) === chat);
      const t = r && r.message && r.message.threadId;
      if (t != null && t !== '') return { threadId: String(t) };
    }
    let c = null;
    try { c = ledger.chat(chat); } catch (e) { failNote('channels.outbound.route', e); c = null; }
    return (c && c.route && c.route.threadId) ? { threadId: String(c.route.threadId) } : null;
  }

  // ---- 5. the one channel.delivery a send reports (a durable record's lane reports its own) ------------------------
  function report(t, o, ok, chunks, reason) {
    const ev = { channel: t.channel, chatId: t.chatId, runId: String(o.runId || ''), ok: !!ok, chunks: Math.max(0, chunks | 0), reason: String(reason || o.reason || '') };
    if (o.agentId) ev.agentId = String(o.agentId);
    try { emit('channel.delivery', ev); } catch (e) { failNote('channels.outbound.emit', e); }
  }
  const undeliverable = (r) => !!r && r.ok === false && r.retryable === false && r.auth !== true && String(r.error || '') !== 'aborted';

  async function send(target, text, opts) {
    const o = opts || {};
    // a target that names no chat has no chat to report about: its caller is told
    const t = resolve(target);
    if (!t.ok) return { ok: false, error: t.error, refused: 'target', parts: 0, sent: 0 };
    // 2. REACH, in attempt mode: a channel known to be down or errored is refused before any transport call
    let gate = null;
    try { gate = reach(t.channel, { attempt: true }); } catch (e) { failNote('channels.outbound.reach', e); gate = null; }
    if (!gate || !gate.ok) { report(t, o, false, 0); return { ok: false, error: (gate && gate.error) || t.channel + ' is not connected', refused: 'reach', parts: 0, sent: 0 }; }
    // 3. the WHOLE text scrubbed, THEN chunked at the descriptor's limit
    const body = clean(text);
    const cut = body ? chunkTextParts(body, limitFor(t.channel)) : { send: [], raw: [] };
    const media = Array.isArray(o.media) ? o.media.filter(Boolean) : (o.media ? [o.media] : []);
    const maxParts = Number(o.maxParts) > 0 ? Math.floor(Number(o.maxParts)) : 0;
    if (maxParts && cut.send.length > maxParts) { report(t, o, false, 0); return { ok: false, error: 'too many parts', refused: 'too-many-parts', parts: cut.send.length, maxParts: maxParts, sent: 0 }; }
    if (!cut.send.length && !media.length) { report(t, o, false, 0); return { ok: false, error: 'nothing to send', refused: 'empty', parts: 0, sent: 0 }; }
    const route = routeFor(t.chat, o);
    return o.durable === true ? sendDurable(t, o, cut, media, route) : sendNow(t, o, cut, media, route, gate.live);
  }

  // ---- 4a. durable: one record, driven by the chat's lane -----------------------------------------------------------
  async function sendDurable(t, o, cut, media, route) {
    const parts = cut.send.map((s, i) => ({ n: i, text: s, raw: cut.raw[i] }));
    let n = parts.length;
    for (const f of media) if (f && typeof f.path === 'string' && f.path) parts.push({ kind: 'file', n: n++, path: f.path, agents: f.agents, root: f.root, workdir: f.workdir, caption: f.caption });
    // the missed-file note: the files a caller already knew would not come (on the station, or names its reader refused,
    // each with what the reader said), and every file part that does not go
    if (o.note) parts.push({ kind: 'note', n: n++, missed: Array.isArray(o.note.missed) ? o.note.missed : [], unreadable: Array.isArray(o.note.unreadable) ? o.note.unreadable : [],
      refused: Array.isArray(o.note.refused) ? o.note.refused : [] });
    const rec = {
      id: o.deliveryId || undefined, channel: t.channel, chatId: t.chatId, kind: o.kind || 'notice', reason: String(o.reason || ''),
      runId: String(o.runId || ''), agentId: o.agentId ? String(o.agentId) : '', route: route, parts: parts, release: o.release === 'caller' ? 'caller' : 'auto'
    };
    if (Object.prototype.hasOwnProperty.call(o, 'historyDestination')) rec.historyDestination = o.historyDestination;
    let placed;
    try { placed = ledger.enqueue(rec); }
    catch (e) { failNote('channels.outbound.enqueue', e); report(t, o, false, 0); return { ok: false, error: (e && e.message) || 'could not be queued', parts: cut.send.length, sent: 0 }; }
    const first = ledger.whenAttempted(placed.id, null);
    ledger.drive(placed.chat).catch(swallow('channels.outbound.lane'));
    const out = (await first) || {};
    return { ok: !!out.ok, error: out.ok ? '' : String(out.error || (out.held ? 'held: ' + out.held : 'queued')), id: placed.id, queued: !!out.queued,
      undeliverable: !!out.undeliverable, parts: cut.send.length, sent: out.ok ? cut.send.length : 0, messageId: out.messageId || '' };
  }

  // ---- 4b. not durable: now, once, inside the chat's lane mutex -----------------------------------------------------
  function sendNow(t, o, cut, media, route, live) {
    const adapter = live && live.adapter;
    return ledger.sendEphemeral(t.chat, async () => {
      let sent = 0, files = 0, lastFail = null, messageId = '';
      let aim = route;   // a topic the transport finds gone is not aimed at again, by this send's next part or any later send
      const opts = () => (aim ? { threadId: aim.threadId } : undefined);
      const heard = (r) => { if (r && r.threadGone && aim) { ledger.forgetThread(t.chat, aim.threadId); aim = null; } };
      for (let i = 0; i < cut.send.length; i++) {
        let r;
        try { r = await adapter.send(t.chatId, cut.send[i], opts()); }
        catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
        heard(r);
        if (!r || r.ok === false) { lastFail = r || { ok: false, error: 'send failed' }; break; }
        sent++;
        if (r.messageId) messageId = String(r.messageId);
      }
      // a file goes only after every word landed (channel.send's law: an upload that fails never swallows the message)
      for (const item of (lastFail ? [] : media)) {
        let r;
        if (!adapter || typeof adapter.sendMedia !== 'function') r = { ok: false, error: t.channel + ' cannot carry files', retryable: false };
        else {
          try { r = await adapter.sendMedia(t.chatId, item, opts()); }
          catch (e) { r = { ok: false, error: (e && e.message) || 'upload threw' }; }
        }
        heard(r);
        if (!r || r.ok === false) { lastFail = r || { ok: false, error: 'upload failed' }; break; }
        files++;
        if (r.messageId) messageId = String(r.messageId);
      }
      const ok = !lastFail;
      const never = undeliverable(lastFail);
      if (never) {
        try { log('[' + t.channel + '] ' + (o.reason || 'send') + ' for chat ' + t.chatId + ' is undeliverable: ' + String(lastFail.error || 'refused').slice(0, 200)); } catch (e) { failNote('channels.outbound.log', e); }
      }
      report(t, o, ok, sent + files, never ? 'undeliverable' : o.reason);
      return { ok: ok, error: ok ? '' : String((lastFail && lastFail.error) || 'send failed'), parts: cut.send.length, sent: sent, files: files,
        undeliverable: never, retryable: !!(lastFail && lastFail.retryable), messageId: messageId };
    });
  }

  // ---- a durable record's parts that are not words: its files (the live adapter's sendMedia) and its note ---------
  ledger.attachParts({
    async file(rec, part, ctx) {
      const kind = kinds.get(rec.kind);
      if (!kind || typeof kind.read !== 'function') return { ok: false, retryable: false, error: 'attaching files is not wired on this host' };
      let live = null;
      try { live = liveChannelFor(rec.channel) || null; } catch (e) { failNote('channels.outbound.live', e); live = null; }
      const adapter = live && live.adapter;
      if (!adapter || typeof adapter.sendMedia !== 'function') return { ok: false, retryable: false, error: rec.channel + ' cannot carry files' };
      let item = null;
      try { item = await kind.read(rec, part); } catch (e) { item = { ok: false, error: (e && e.message) || 'read threw', unread: true }; }
      // unreadable: the note must never say this file is on the station (comms.js missedNote, c0beb187), and says only what the
      // reader knew of it (missed, kept on the part by the ledger): refused with its reason, not found, or nothing (0.14.2 review)
      if (!item || item.ok === false || !item.buffer) {
        const known = item && item.refused === true ? { refused: true, rule: item.rule === true, reason: String(item.error || ''), shown: String(item.shown || '') }
          : item && item.notFound === true ? { notFound: true } : {};
        return { ok: false, retryable: false, unreadable: true, missed: known, error: 'could not be read from the workspace (' + String((item && item.error) || 'not found') + ')' };
      }
      const up = { kind: item.kind, buffer: item.buffer, filename: item.filename, mime: item.mime || '' };
      if (part.caption) up.caption = clean(part.caption);
      try { return await adapter.sendMedia(rec.chatId, up, Object.assign({}, ctx.opts || {}, { idempotencyKey: ctx.key })); }
      catch (e) { return { ok: false, error: (e && e.message) || 'upload threw' }; }
    },
    async note(rec, part, ctx) {
      const kind = kinds.get(rec.kind);
      /* the files that did not come, in the two kinds the one wording tells apart (comms.js missedNote): `failed` was read
         and did not go (its upload refused, or over the cap: the caller's part.missed), and is on the station;
         `unreadable` could not be read when its turn came, or the reader refused its name (part.unreadable, part.refused),
         and is not. Each unreadable one carries what the reader said of it, so the note words it the 0.14.2 way: a refusal
         with its reason, a name not found, or a file it never read */
      const failed = [], unreadable = [];
      const readerSaid = (p) => { const o = { path: p.path }; for (const k of ['refused', 'rule', 'notFound', 'reason', 'shown']) if (p[k] !== undefined) o[k] = p[k]; if (!o.refused && !o.notFound) o.unread = true; return o; };
      for (const p of rec.parts) if (p.kind === 'file' && p.error) { if (p.unread) unreadable.push(readerSaid(p)); else failed.push(p.path); }
      const missed = { failed: failed.concat(part.missed || []),
        unreadable: unreadable.concat(part.unreadable || [], (part.refused || []).map(x => Object.assign({}, x, { refused: true }))) };
      let text = '';
      try { text = ((missed.failed.length || missed.unreadable.length) && kind && typeof kind.note === 'function') ? String(kind.note(rec, missed) || '') : ''; }
      catch (e) { failNote('channels.outbound.note', e); text = ''; }
      if (!text) return { ok: true, empty: true, said: '' };
      const said = clean(text);
      let r;
      try { r = await ctx.sender.send(rec.chatId, said, Object.assign({}, ctx.opts || {}, { idempotencyKey: ctx.key })); }
      catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
      return (r && r.ok !== false) ? Object.assign({}, r, { said: said }) : r;
    }
  });

  return {
    send: send,
    resolve: resolve,
    provide(kind, fns) { if (kind && fns) { kinds.set(String(kind), fns); ledger.kickAll(); } }
  };
}

module.exports = { makeChannelOutbound };
