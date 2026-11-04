/* sidecar/channels/delivery-ledger.js — the channel DELIVERY LEDGER: one durable record chain for every message a
   channel hub was handed and every reply it owes (channel-delivery-ledger, S2).

   WHY ONE LEDGER. The intake receipts (inbox.json) and the failed replies (outbox.json) were two files with no link
   between them, written separately: a receipt left only after deliver() returned, so a reply on the wire still had a
   live receipt, and a crash or one refused write in that gap ran the message again (tool steps included). The outbox
   was one queue per channel that a single failing chat blocked for every other chat, and it retried a refusal that
   could never succeed for ever. Here every transition is ONE synchronous durable write of one document, and the
   reply a message earned enters its chat's lane in the same write that takes the message's receipt away.

     makeDeliveryLedger({ io, clock, timers?, bootId, limits?, holding?, log?, beforeDrive?, onHealth? }) -> ledger
       io       = { read() -> doc | undefined (THROWS when the file cannot be read: EBUSY, EPERM), write(doc) (throws) }
       holding  = () -> true while the update barrier is up: no lane starts a part then (the process may die any moment)

   RECORDS (the document is channels/delivery.json, version 1)
     receipts    [{ id, channel, chatId, message, ts, attempt: { runId, tools, boot, replays } | null, deferred }]
     deliveries  [{ id, chat, channel, chatId, kind, reason, runId, agentId, receiptIds, route: { threadId } | null, seed,
                    parts: [{ kind:'text', n, raw?, text, sent, messageId }
                          | { kind:'file', n, path, agents?, root?, workdir?, caption?, sent, error?, unread?, refused?, rule?,
                              notFound?, reason?, shown?, tries?, messageId }
                          | { kind:'note', n, missed, unreadable?, refused?, sent, text?, error?, tries? }], text?, delayed, state: 'queued' | 'done',
                    release: 'auto' | 'caller', tries, nextAt, lastError, ts, doneAt?,
                    edit: { messageId, promptId, text, strip } | null, sessionTurns }]
     tombstones  [{ id, chat, runId, reason, error, at, sent? }]     reported once, in the write that made them; sent: how
                                                                     many of its parts had landed when it was given up
     chats       { '<channel>|<chatId>': { route, dead: { at, status } | null } }
     openAsks    [{ id, chat, channel, chatId, messageId, runId, promptId, text, boot, at }]
                                                                     a consent keyboard that landed and is not answered yet
     migrated    { inbox: [{ id, ts, h }], outbox: [{ id, ts }] }    what the v1 migration already took (importV1)
   A chat key is '<channel>|<chatId>' for every channel and bot ('telegram:<botId>|<chatId>'), so all delivery state is
   per channel. Keyboards and quotes are never persisted: they ride a delivery's FIRST attempt in this process only.

   TRANSITIONS (each one write; the in-memory state is the truth of this process)
     receive(entry)            a message's receipt, before the adapter acknowledges it (its chat's route rides the same
                               write). THROWS when it cannot be written or the channel holds maxPendingPerChannel
                               receipts: the adapter then does not acknowledge, and the update is kept — by the
                               platform where it redelivers from an offset (Telegram), else by the adapter, which hands
                               it over again first on its next pass (channels/adapter.js keep).
                               A chat whose lane owes laneMaxDeliveries replies or laneMaxChars unsent characters gets
                               its new receipts deferred: kept, not run (backpressure before the paid run) — never a
                               message that starts no run (entry.deferrable false), and never counted against the
                               channel's cap; past deferredPerChat waiting, one is not kept ({ overflow }), said once.
     markAttempt(ids, patch, opts?)  how far the message's run got: { runId } at its start (replay: replays+1), { tools }
                               before each tool step; opts.undo takes a mark that could not be written back
     answer(ids, delivery)     the receipts leave and the reply enters its chat's lane in the SAME write
     enqueue(delivery)         a durable delivery that answers no receipt (an existing id returns that record)
     settle(ids, { notice })   the receipts end with no durable reply (or with this notice, in the same write)
     settleRun(runId, ...)     every receipt one run stands for (a merged batch) settles in one write
     markDead / clearDead      a chat removed this bot: its queued replies become tombstones in that write
     forgetThread(chat, thread)  that topic is gone: the chat's durable route (and the hub's) stops aiming at it
     release(id)               a 'caller' record leaves once its caller has recorded the outcome (pruned after 7 days)
     withdraw(id)              a queued record nothing of which has gone leaves: its caller replaced it
     noteSession(id, proof?)   legacy side-effect marker, or verified canonical row acknowledgement after publication
     publication(id)           fresh durable proof of one fully done history-bound delivery; never a RAM-only claim
     openAsk(ask)              a consent keyboard landed with its ask still open
     stamp(delivery)           the keyboard's stamp enters its chat's lane and the open ask leaves, in the SAME write

   PARTS THAT ARE NOT WORDS (channel-delivery-ledger S4: a routine's files and its missed-file note). A 'file' part names
   a file, read again when it is sent; a 'note' part says which files did not come. Neither is the ledger's to send:
   attachParts({ file, note }) hands them to the host's own handler (channels/outbound.js), each (d, part, ctx) ->
   SendResult. A lane whose next part has no handler attached waits, like a lane with no sender. A part the platform
   refused for the moment (retryable) waits on the lane's backoff like a refused word, partRetries times: nothing else
   of the record goes out again, which is what a mark per part is for. One that cannot go (the file cannot be read, the
   channel carries no files, a refusal for good, a refusal that lasted) is not the delivery's failure, because its words
   already landed: it is marked sent with its error, never tried again, and the note names it, so a file can never hold
   its chat's lane for good. A refused credential or an upload a shutdown cut short holds it, as it holds the words.
   A 'caller' record (a routine's: release 'caller') stays 'done' after its last part until its caller releases it, so
   a caller that asks again after a crash is answered from the record and sends nothing.

   A STAMP IS AN EDIT (channel-delivery-ledger S6). A keyboard that stops meaning anything is rewritten in place, its
   buttons gone: 'consent:<runId>:<promptId>' when its ask settled, whoever settled it, and 'choice:<token>' when a choice
   was tapped. A stamp is a delivery with no parts and an edit, in its chat's lane like any durable record, so it survives
   a crash and a refusal for the moment. It says nothing new to the chat, so it emits no channel.delivery. An edit is
   idempotent: one the platform already made (its answer lost, or the process gone before the record left) comes back
   'message is not modified', which is that one edit landing. A message that is gone ('message to edit not found') leaves
   in silence, with a tombstone no one is told about, and a refusal for good is one console line. A refusal for the moment
   waits on the lane's backoff, stampRetries times, and is then given up the same way: a stamp changes nothing but how a
   message reads, so it may delay the replies behind it and never holds them for good.
   A KEYBOARD A CRASH LEFT OPEN. The ask's waiter and the tap registry die with the process, so nothing would ever stamp
   those buttons. openAsk writes the ask down in the continuation that saw the keyboard land, and stamp takes it away in
   the write that enqueues its stamp; asksLeftOpen then names what a process that is gone left open (hub-delivery.js).

   LANES. One FIFO lane per chat drives its durable deliveries through the channel's attached sender (attach): a lane
   sends the head's next unsent part and writes the sent mark in the continuation that saw the platform accept it.
   A retryable failure backs that lane off (5 s doubling to 60 s, honoring retryAfter) and no other; a refused
   credential (auth) holds the channel's lanes until its next 'up' (kick); a refusal that can never succeed
   (retryable:false) turns the delivery into a tombstone at once and is never retried. sendEphemeral(chat, fn) is the
   lane's mutex for a send that is not durable (a command reply, a keyboard): it waits only while a part is on the wire.

   WRITE FAILURE (EBUSY, EPERM, ENOSPC, UPDATE_MUTATIONS_FROZEN). A failed write leaves the change in memory, where it
   stays authoritative in this process: an accepted part is never sent again here. The ledger is DIRTY until a retry
   (1 s doubling to 30 s) lands it, and while it is dirty, unread, or holding() is true no lane starts a part, so no
   part ever goes out whose record is not durable. A receipt write is the exception: it is undone and thrown.

   Pure: the clock, the timers and the IO are injected (lint-determinism), and every failure it swallows is reported. */
'use strict';

const { note: failNote, swallow } = require('../failopen.js');
const Publication = require('./history-publication.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULTS = Object.freeze({
  maxPendingPerChannel: 200,      // intake: receipts being worked on per channel (a full channel stops acknowledging; others
                                  // never), a chat's deferred ones not counted: one chat's backlog never shuts another out
  laneMaxDeliveries: 20,          // backpressure: undelivered durable deliveries one chat may owe before its new work waits
  laneMaxChars: 200000,           // ...or unsent characters
  deferredPerChat: 50,            // ...and the messages it may keep waiting meanwhile: past that one is not kept, said once
  tombstonesPerChannel: 50,       // the last 50 per channel...
  tombstoneTtlMs: 30 * DAY_MS,    // ...for 30 days
  doneTtlMs: 7 * DAY_MS,          // a 'caller' record its caller never released
  backoffMs: 5000,                // a lane's retry: 5 s doubling...
  backoffMaxMs: 60000,            // ...to 60 s
  persistRetryMs: 1000,           // a failed write: retried at 1 s doubling...
  persistRetryMaxMs: 30000,       // ...to 30 s
  holdPollMs: 1000,               // how often a lane held by the update barrier looks again
  partRetries: 4,                 // a file or note refused for the moment: tried again this often on the lane's backoff, then told
  stampRetries: 8,                // a stamp refused for the moment: about 5 minutes of the lane's backoff, then left
  escalateTries: 5,               // one 'redelivery-delayed' event when a delivery has failed this often
  migratedMax: 500                // the v1 items importV1 remembers having taken
});
// the line a reply that could not go out at once carries when it finally lands (rides its first unsent part when it fits)
const DELAYED_HEADER = '⌛ delayed reply — the channel was unreachable when this was first sent:';
// what a chat is told, once per spell, when a message it sent was not kept (receive: OVERFLOW)
const OVERFLOW_NOTICE = (n) => '⚠ Not every message you sent here while StarNet could not deliver this chat\'s replies was kept: it holds '
  + n + ' waiting messages per chat, and the ones after that were dropped. Send again what still needs doing once the replies above have arrived.';

const chatKeyOf = (channel, chatId) => String(channel) + '|' + String(chatId);
const codeOf = (e) => String((e && (e.code || e.name)) || 'error').slice(0, 40);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, max) => String(v == null ? '' : v).slice(0, max || 400);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/* A short stable hash (two FNV-1a lanes, 16 hex): the migration's message fingerprint, and the idempotency key of a part. */
function shortHash(text) {
  const s = String(text == null ? '' : text);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  const hex = (n) => ('00000000' + n.toString(16)).slice(-8);
  return hex(h1) + hex(h2);
}
// one part's idempotency key: stable across attempts and processes, at most 25 characters (a Discord nonce's limit)
function partKey(deliveryId, n) { return 'sn' + shortHash(String(deliveryId) + '#' + String(n)); }

function emptyDoc() {
  return { version: 1, receipts: [], deliveries: [], tombstones: [], chats: {}, openAsks: [], migrated: { inbox: [], outbox: [] } };
}

// ---- the document read back from disk: well-formed records only (a hand-corrupted row is dropped, never thrown) ----
function cleanAttempt(a) {
  if (!a || typeof a !== 'object' || !String(a.runId || '')) return null;
  return { runId: str(a.runId, 200), tools: Math.max(0, Math.floor(Number(a.tools) || 0)), boot: str(a.boot, 200),
    replays: Math.max(0, Math.floor(Number(a.replays) || 0)) };
}
function cleanReceipt(r) {
  if (!r || typeof r.id !== 'string' || !r.id || typeof r.channel !== 'string' || !r.message || typeof r.message !== 'object') return null;
  const chatId = String(r.chatId != null ? r.chatId : r.message.chatId);
  if (!chatId || chatId === 'undefined') return null;
  const out = { id: r.id, channel: r.channel, chatId: chatId, message: r.message, ts: Number(r.ts) || 0, attempt: cleanAttempt(r.attempt), deferred: r.deferred === true };
  const a = r.editAdmission;
  if (r.message.edited === true && a && a.v === 1 && (a.state === 'superseded' || (a.state === 'accepted' && !out.deferred))) {
    out.editAdmission = { v: 1, state: a.state };
  }
  return out;
}
// a part that is not words (S4): a file read again when it is sent, or the note naming the files that did not come
function filePart(p, n) {
  if (!p || typeof p.path !== 'string' || !p.path) return null;
  const out = { kind: 'file', n: n, path: str(p.path, 1000), sent: p.sent === true, messageId: str(p.messageId, 200) };
  if (Array.isArray(p.agents)) out.agents = p.agents.filter(a => typeof a === 'string' && a).slice(0, 16).map(a => str(a, 80));
  if (typeof p.root === 'string') out.root = str(p.root, 1000);
  if (typeof p.workdir === 'string' && p.workdir) out.workdir = str(p.workdir, 1000);
  if (typeof p.caption === 'string' && p.caption) out.caption = str(p.caption, 1024);
  if (p.error) out.error = str(p.error, 240);
  if (p.error && p.unread === true) {
    // it could not be read when its turn came: never "saved" (the note), and the note says what the reader knew of it
    out.unread = true;
    Object.assign(out, missOf(p));
  }
  if (Number(p.tries) > 0) out.tries = Math.floor(Number(p.tries));
  return out;
}
/* What the reader knew of a file that did not come (routine-media.js readOne, comms.js missedNote): refused (with `rule` when a
   send rule said no, and its chat-safe `reason`), or notFound; neither is unread, which claims nothing. `shown` is the reader's
   chat-safe name. Only the flags that are set are kept. */
function missOf(m) {
  const out = {};
  if (!m || typeof m !== 'object') return out;
  if (m.refused === true) {
    out.refused = true;
    if (m.rule === true) out.rule = true;
    if (typeof m.reason === 'string' && m.reason) out.reason = str(m.reason, 300);
  } else if (m.notFound === true) out.notFound = true;
  if (typeof m.shown === 'string' && m.shown) out.shown = str(m.shown, 1000);
  return out;
}
const pathList = (v) => arr(v).filter(x => typeof x === 'string' && x).slice(0, 16).map(x => str(x, 1000));
// the names the reader refused at the plan, each with what it said (refusedFileLine / unsentFileLine words them)
const refusedList = (v) => arr(v).filter(x => x && typeof x.path === 'string' && x.path).slice(0, 16)
  .map(x => Object.assign({ path: str(x.path, 1000) }, missOf(Object.assign({}, x, { refused: true }))));
function notePart(p, n) {
  // missed: files a caller knew would not come and are on the station (over the cap); unreadable: names the reader could not
  // read (said to be unread); refused: names the reader refused, with its reason (0.14.2: never "saved", never "not found")
  const out = { kind: 'note', n: n, missed: pathList(p && p.missed), sent: !!(p && p.sent === true) };
  const unreadable = pathList(p && p.unreadable);
  if (unreadable.length) out.unreadable = unreadable;
  const refused = refusedList(p && p.refused);
  if (refused.length) out.refused = refused;
  if (p && typeof p.text === 'string') out.text = str(p.text, 4000);
  if (p && p.error) out.error = str(p.error, 240);
  if (p && Number(p.tries) > 0) out.tries = Math.floor(Number(p.tries));
  return out;
}
function cleanPart(p, i) {
  if (!p || typeof p !== 'object') return null;
  const n = p.n != null ? p.n : i;
  if (p.kind === 'file') return filePart(p, n);
  if (p.kind === 'note') return notePart(p, n);
  if (typeof p.text !== 'string') return null;
  const out = { kind: 'text', n: n, text: p.text, sent: p.sent === true, messageId: str(p.messageId, 200) };
  if (typeof p.raw === 'string') out.raw = p.raw;
  return out;
}
// what a stamp rewrites the message to; strip: its buttons go with the edit (an edit that names no reply_markup)
function cleanEdit(e) {
  if (!e || typeof e !== 'object' || !str(e.messageId, 200) || typeof e.text !== 'string') return null;
  return { messageId: str(e.messageId, 200), promptId: str(e.promptId, 200), text: e.text, strip: e.strip !== false };
}
function cleanAsk(a) {
  if (!a || typeof a.id !== 'string' || !a.id || typeof a.channel !== 'string' || a.chatId == null || !str(a.messageId, 200)) return null;
  return { id: a.id, chat: chatKeyOf(a.channel, a.chatId), channel: a.channel, chatId: String(a.chatId), messageId: str(a.messageId, 200),
    runId: str(a.runId, 200), promptId: str(a.promptId, 200), text: typeof a.text === 'string' ? a.text : '', boot: str(a.boot, 200), at: Number(a.at) || 0 };
}
function cleanDelivery(d) {
  // Validate publication authority before ordinary legacy normalization can truncate
  // an identity or drop a malformed part. Unknown metadata holds the original file.
  if (Publication.hasMetadata(d)) Publication.record(d);
  if (!d || typeof d.id !== 'string' || !d.id || typeof d.channel !== 'string' || d.chatId == null) return null;
  const parts = [];
  for (let i = 0; i < arr(d.parts).length; i++) { const p = cleanPart(d.parts[i], i); if (p) parts.push(p); }
  const out = {
    id: d.id, chat: chatKeyOf(d.channel, d.chatId), channel: d.channel, chatId: String(d.chatId), kind: str(d.kind || 'reply', 40),
    reason: str(d.reason, 60), runId: str(d.runId, 200), agentId: str(d.agentId, 80),
    receiptIds: arr(d.receiptIds).filter(x => typeof x === 'string').slice(0, 50),
    route: (d.route && d.route.threadId) ? { threadId: String(d.route.threadId) } : null,
    seed: str(d.seed, 200), parts: parts, delayed: d.delayed === true, state: d.state === 'done' ? 'done' : 'queued',
    release: d.release === 'caller' ? 'caller' : 'auto', tries: Math.max(0, Math.floor(Number(d.tries) || 0)),
    nextAt: Number(d.nextAt) || 0, lastError: str(d.lastError, 240), ts: Number(d.ts) || 0,
    edit: cleanEdit(d.edit), sessionTurns: d.sessionTurns != null ? d.sessionTurns : null
  };
  if (typeof d.text === 'string') out.text = d.text;            // a migrated v1 reply: cut at its first send
  if (d.headerSent === true) out.headerSent = true;
  if (d.state === 'done') out.doneAt = Number(d.doneAt) || 0;
  if (Publication.owns(d, 'historyDestination')) out.historyDestination = Publication.destination(d.historyDestination);
  return out;
}
function normalizeDoc(raw) {
  const doc = emptyDoc();
  if (!raw || typeof raw !== 'object') return doc;
  const seenR = new Set(), seenD = new Set();
  const publicationIds = new Set();
  if (arr(raw.deliveries).some(Publication.hasMetadata) && raw.version !== 1) Publication.refuse('The delivery publication document version is unknown');
  for (const r of arr(raw.receipts)) { const x = cleanReceipt(r); if (x && !seenR.has(x.id)) { seenR.add(x.id); doc.receipts.push(x); } }
  for (const d of arr(raw.deliveries)) {
    const x = cleanDelivery(d);
    if (x && seenD.has(x.id) && (publicationIds.has(x.id) || Publication.hasMetadata(d))) Publication.refuse('The saved delivery publication identity is duplicated');
    if (x && !seenD.has(x.id)) { seenD.add(x.id); doc.deliveries.push(x); if (Publication.hasMetadata(d)) publicationIds.add(x.id); }
  }
  for (const t of arr(raw.tombstones)) {
    if (!t || typeof t.id !== 'string' || typeof t.chat !== 'string') continue;
    const x = { id: t.id, chat: t.chat, runId: str(t.runId, 200), reason: str(t.reason, 60), error: str(t.error, 240), at: Number(t.at) || 0 };
    if (Number(t.sent) > 0) x.sent = Math.floor(Number(t.sent));
    doc.tombstones.push(x);
  }
  if (raw.chats && typeof raw.chats === 'object') {
    for (const k of Object.keys(raw.chats)) {
      const c = raw.chats[k] || {};
      doc.chats[k] = { route: (c.route && c.route.threadId) ? { threadId: String(c.route.threadId) } : null,
        dead: (c.dead && typeof c.dead === 'object') ? { at: Number(c.dead.at) || 0, status: str(c.dead.status, 40) } : null };
    }
  }
  doc.openAsks = arr(raw.openAsks).map(cleanAsk).filter(Boolean);
  const m = raw.migrated || {};
  doc.migrated = {
    inbox: arr(m.inbox).filter(x => x && typeof x.id === 'string').map(x => ({ id: x.id, ts: Number(x.ts) || 0, h: str(x.h, 40) })),
    outbox: arr(m.outbox).filter(x => x && typeof x.id === 'string').map(x => ({ id: x.id, ts: Number(x.ts) || 0 }))
  };
  return doc;
}

/* An IO that keeps the document in memory: the same ledger code, nothing on disk. A one-job hub's ledger (its job record
   is its durability) and a hub built over a test store with no ledger of its own use it. */
function memoryIo() {
  let saved = null;
  const read = () => (saved == null ? undefined : JSON.parse(saved));
  return { read, readConfirmed: read, write: (doc) => { saved = JSON.stringify(doc); } };
}

function makeDeliveryLedger(deps) {
  const d0 = deps || {};
  const io = d0.io;
  if (!io || typeof io.read !== 'function' || typeof io.write !== 'function') throw new Error('makeDeliveryLedger: io { read, write } is required');
  const clock = d0.clock;
  if (!clock || typeof clock.now !== 'function') throw new Error('makeDeliveryLedger: an injected clock is required');
  const now = () => Number(clock.now()) || 0;
  const setTimer = (d0.timers && typeof d0.timers.setTimeout === 'function') ? d0.timers.setTimeout : setTimeout;
  const clearTimer = (d0.timers && typeof d0.timers.clearTimeout === 'function') ? d0.timers.clearTimeout : clearTimeout;
  const limits = Object.assign({}, DEFAULTS, d0.limits || {});
  const bootId = (d0.bootId != null && String(d0.bootId)) ? String(d0.bootId).slice(0, 200) : 'boot';
  const log = typeof d0.log === 'function' ? d0.log : (line) => console.error(line);
  const holding = () => { if (typeof d0.holding !== 'function') return false; try { return d0.holding() === true; } catch (e) { failNote('channels.ledger.holding', e); return false; } };

  let doc = emptyDoc();
  let loaded = false;
  let loadError = null;
  let dirty = false;
  let writeError = null;
  let closed = false;
  let seq = 0;
  let persistTimer = null, persistDelay = 0;
  let loadTimer = null, loadDelay = 0;
  let holdTimer = null;
  const touchedWhileUnread = new Set();   // chats a transition changed before the document could be read (merged on load)
  const issues = new Map();               // tag -> detail (a pending v1 migration says so on the health line)
  const lanes = new Map();                // chat -> lane
  const senders = new Map();              // channel -> the attached sender
  const partHandlers = {};                // part kind ('file', 'note') -> the host's handler (attachParts)
  const authHeld = new Set();             // channels whose credential was refused, until their next 'up'
  const waiters = new Map();              // delivery id -> { resolve, extras } — a delivery's FIRST attempt in this process
  const claims = new Map();               // receipt id -> the live processing promise (a reconnect's new hub never re-runs it)
  let lastHealth = '';

  function unref(t) { if (t && typeof t.unref === 'function') t.unref(); return t; }
  function arm(fn, ms) { return unref(setTimer(fn, Math.max(0, ms))); }

  // ---- health: what the channel status delivery line says about this ledger --------------------------------------
  function health() {
    if (!loaded && loadError) return { state: 'held', held: true, code: codeOf(loadError), detail: 'delivery ledger cannot be read (' + codeOf(loadError) + '); holding outbound, retrying', at: now() };
    if (dirty) return { state: 'held', held: true, code: codeOf(writeError), detail: 'delivery ledger cannot be written (' + codeOf(writeError) + '); holding outbound, retrying', at: now() };
    for (const [, detail] of issues) return { state: 'degraded', held: false, code: '', detail: detail, at: now() };
    return { state: 'ok', held: false, code: '', detail: '', at: 0 };
  }
  function healthChanged() {
    const h = health();
    const sig = h.state + '|' + h.detail;
    if (sig === lastHealth) return;
    lastHealth = sig;
    if (typeof d0.onHealth === 'function') { try { d0.onHealth(h); } catch (e) { failNote('channels.ledger.onHealth', e); } }
  }
  function setIssue(tag, detail) {
    if (detail) issues.set(String(tag), String(detail)); else issues.delete(String(tag));
    healthChanged();
  }

  // ---- load: read the document once; a busy file is retried, and nothing is written over what could not be read -----
  function load() {
    if (loaded) return true;
    if (closed) return false;
    let disk;
    try { disk = normalizeDoc(io.read()); }
    catch (e) {
      loadError = e;
      failNote('channels.ledger.read', e);
      if (!loadTimer) {
        loadDelay = loadDelay ? Math.min(loadDelay * 2, limits.persistRetryMaxMs) : limits.persistRetryMs;
        loadTimer = arm(() => { loadTimer = null; if (load()) kickAll(); }, loadDelay);
      }
      healthChanged();
      return false;
    }
    // what was decided while the file could not be read (deliveries enqueued, chats marked) joins what it holds
    const ids = new Set(disk.deliveries.map(x => x.id));
    for (const d of doc.deliveries) if (!ids.has(d.id)) disk.deliveries.push(d);
    const tids = new Set(disk.tombstones.map(x => x.id));
    for (const t of doc.tombstones) if (!tids.has(t.id)) disk.tombstones.push(t);
    const aids = new Set(disk.openAsks.map(x => x.id));
    for (const a of doc.openAsks) if (!aids.has(a.id)) disk.openAsks.push(a);
    for (const k of touchedWhileUnread) disk.chats[k] = Object.assign({ route: null, dead: null }, disk.chats[k] || {}, doc.chats[k] || {});
    const hadChanges = dirty;
    doc = disk;
    loaded = true; loadError = null; loadDelay = 0; touchedWhileUnread.clear();
    if (loadTimer) { clearTimer(loadTimer); loadTimer = null; }
    prune();
    if (hadChanges) commit('load-merge'); else healthChanged();
    return true;
  }

  // ---- persist: ONE write of the whole document ------------------------------------------------------------------
  function serialize() {
    return { version: 1, receipts: doc.receipts, deliveries: doc.deliveries, tombstones: doc.tombstones, chats: doc.chats, openAsks: doc.openAsks, migrated: doc.migrated };
  }
  function commit(tag) {
    if (closed) return false;
    if (!loaded) { dirty = true; healthChanged(); return false; }   // nothing is written over a document that was never read
    prune();
    try { io.write(serialize()); }
    catch (e) {
      const wasDirty = dirty;
      dirty = true; writeError = e;
      failNote('channels.ledger.write.' + tag, e);
      if (!wasDirty) { try { log('[channels] delivery ledger cannot be written (' + codeOf(e) + '); holding outbound, retrying'); } catch (le) { failNote('channels.ledger.log', le); } }
      schedulePersist();
      healthChanged();
      return false;
    }
    const wasDirty = dirty;
    dirty = false; writeError = null; persistDelay = 0;
    if (persistTimer) { clearTimer(persistTimer); persistTimer = null; }
    if (wasDirty) { healthChanged(); kickAll(); }
    return true;
  }
  function schedulePersist() {
    if (persistTimer || closed) return;
    persistDelay = persistDelay ? Math.min(persistDelay * 2, limits.persistRetryMaxMs) : limits.persistRetryMs;
    persistTimer = arm(() => { persistTimer = null; if (dirty) commit('retry'); }, persistDelay);
  }
  // bounded lists: tombstones (last N per channel, TTL), 'caller' records never released, and an ask a process that is gone
  // left open on a channel that never came back (a live ask settles within minutes, so this never reaches one)
  function prune() {
    const t = now();
    if (doc.tombstones.length) {
      const byChannel = new Map();
      const kept = [];
      for (let i = doc.tombstones.length - 1; i >= 0; i--) {
        const x = doc.tombstones[i];
        if (t && x.at && t - x.at > limits.tombstoneTtlMs) continue;
        const ch = x.chat.slice(0, x.chat.lastIndexOf('|'));
        const n = byChannel.get(ch) || 0;
        if (n >= limits.tombstonesPerChannel) continue;
        byChannel.set(ch, n + 1);
        kept.push(x);
      }
      if (kept.length !== doc.tombstones.length) doc.tombstones = kept.reverse();
    }
    if (t) doc.deliveries = doc.deliveries.filter(d => !(d.state === 'done' && !Publication.hasMetadata(d) && d.doneAt && t - d.doneAt > limits.doneTtlMs));
    if (t && doc.openAsks.length) doc.openAsks = doc.openAsks.filter(a => a.boot === bootId || !a.at || t - a.at <= limits.doneTtlMs);
  }
  function ready() { return loaded || load(); }

  // ---- lookups -------------------------------------------------------------------------------------------------
  const receiptById = (id) => doc.receipts.find(r => r.id === id) || null;
  const deliveryById = (id) => doc.deliveries.find(d => d.id === id) || null;
  const queuedIn = (chat) => doc.deliveries.filter(d => d.chat === chat && d.state === 'queued');
  const onWire = (d) => { const l = lanes.get(d.chat); return !!(l && l.current === d.id); };   // its lane is in its attempt
  function unsentChars(d) {
    if (!d.parts.length && typeof d.text === 'string') return d.text.length;
    let n = 0;
    for (const p of d.parts) if (!p.sent && p.kind === 'text') n += p.text.length;
    return n;
  }
  // BACKPRESSURE: a chat that owes too many replies runs no new work until they drain. Never a refusal of a finished reply.
  function laneFull(chat) {
    const q = queuedIn(chat);
    if (q.length >= limits.laneMaxDeliveries) return true;
    let chars = 0;
    for (const d of q) chars += unsentChars(d);
    return chars >= limits.laneMaxChars;
  }
  const hasDeferred = (chat) => doc.receipts.some(r => r.deferred && chatKeyOf(r.channel, r.chatId) === chat);
  function chatRec(chat) {
    if (!doc.chats[chat]) doc.chats[chat] = { route: null, dead: null };
    if (!loaded) touchedWhileUnread.add(chat);
    return doc.chats[chat];
  }

  /* A TOPIC THAT IS GONE (a send answered threadGone: the transport saved the message by resending it to the chat root). The
     chat's durable route stops aiming at it, and so does the hub's route book, or every later send repeats that failed call
     and its retry. A topic the chat has moved on from leaves its route alone. True when the durable route changed. */
  function forgetRoute(chat, threadId) {
    const c = doc.chats[chat];
    const had = !!(c && c.route && c.route.threadId === String(threadId));
    if (had) c.route = null;
    const cut = chat.lastIndexOf('|');
    const sender = senders.get(chat.slice(0, cut));
    if (sender && typeof sender.forgetThread === 'function') {
      try { sender.forgetThread(chat.slice(cut + 1), String(threadId)); } catch (e) { failNote('channels.ledger.forgetThread', e); }
    }
    return had;
  }

  // ---- records ---------------------------------------------------------------------------------------------------
  function newDelivery(input) {
    const x = input || {};
    const channel = String(x.channel || '');
    const chatId = String(x.chatId == null ? '' : x.chatId);
    if (!channel || !chatId) throw new Error('delivery ledger: a delivery needs its channel and chatId');
    const parts = [];
    const src = arr(x.parts);
    for (let i = 0; i < src.length; i++) {
      const p = src[i];
      const n = (p && p.n != null) ? p.n : i;
      if (p && p.kind === 'file') { const f = filePart(Object.assign({}, p, { sent: false, error: '' }), n); if (f) parts.push(f); continue; }
      if (p && p.kind === 'note') { parts.push(notePart({ missed: p.missed, unreadable: p.unreadable, refused: p.refused }, n)); continue; }
      const text = typeof p === 'string' ? p : String((p && p.text) || '');
      const part = { kind: 'text', n: n, text: text, sent: false, messageId: '' };
      if (p && typeof p.raw === 'string' && p.raw !== text) part.raw = p.raw;
      parts.push(part);
    }
    const rec = {
      id: String(x.id || ('msg:' + bootId + ':' + (++seq))), chat: chatKeyOf(channel, chatId), channel: channel, chatId: chatId,
      kind: str(x.kind || 'reply', 40), reason: str(x.reason, 60), runId: str(x.runId, 200), agentId: str(x.agentId, 80),
      receiptIds: arr(x.receiptIds).filter(i => typeof i === 'string' && i).slice(0, 50),
      route: (x.route && x.route.threadId) ? { threadId: String(x.route.threadId) } : null,
      seed: str(x.seed, 200), parts: parts, delayed: x.delayed === true, state: 'queued',
      release: x.release === 'caller' ? 'caller' : 'auto', tries: Math.max(0, Math.floor(Number(x.tries) || 0)),
      nextAt: 0, lastError: '', ts: Number(x.ts) || now(), edit: cleanEdit(x.edit), sessionTurns: null
    };
    if (!parts.length && typeof x.text === 'string') rec.text = x.text;
    if (Publication.owns(x, 'historyDestination')) {
      // Raw binding fields must already be valid; String()/slice above grants no authority.
      Publication.binding(x);
      rec.historyDestination = Publication.destination(x.historyDestination);
      Publication.record(rec);
    }
    return rec;
  }
  const deliveryText = (d) => (typeof d.text === 'string' && !d.parts.length) ? d.text : d.parts.map(p => (p.kind === 'file' ? '\u0000file:' + p.path : (p.kind === 'note' ? '' : p.text))).join('');
  // an existing id returns that record — unless it is somebody else's reply under the same id, which is never dropped
  function placeDelivery(rec) {
    const existing = deliveryById(rec.id);
    if (existing) {
      if (Publication.hasMetadata(existing) || Publication.hasMetadata(rec)) {
        Publication.record(existing); Publication.record(rec);
        if (['id', 'channel', 'chatId', 'runId', 'agentId'].some(k => existing[k] !== rec[k]) ||
            !Publication.same(existing.historyDestination, rec.historyDestination) || deliveryText(existing) !== deliveryText(rec)) {
          Publication.refuse('The existing delivery has a different saved destination or result');
        }
        return existing;
      }
      if (existing.chat === rec.chat && deliveryText(existing) === deliveryText(rec)) return existing;
      failNote('channels.ledger.idCollision', new Error('delivery id ' + rec.id + ' already names another reply'));
      rec.id = rec.id + '~' + bootId + ':' + (++seq);
    }
    doc.deliveries.push(rec);
    return rec;
  }
  function readPublication(d, allowMarkerChange) {
    if (typeof io.readConfirmed !== 'function') Publication.refuse('The delivery publication reader is unavailable');
    const raw = io.readConfirmed();
    const saved = raw && raw.version === 1 && Array.isArray(raw.deliveries) ? raw.deliveries.filter(row => row && row.id === d.id) : [];
    const expected = saved.length === 1 && allowMarkerChange ? Object.assign({}, d, { sessionTurns: saved[0].sessionTurns }) : d;
    if (saved.length !== 1 || !Publication.same(saved[0], expected)) Publication.refuse('The saved delivery publication could not be read back');
    Publication.record(saved[0]);
    return saved[0];
  }
  function confirmedPublication(d) {
    const saved = readPublication(d);
    return Publication.acknowledgement(saved.sessionTurns, saved);
  }
  function removeReceipts(ids) {
    const want = new Set(arr(ids));
    const before = doc.receipts.length;
    doc.receipts = doc.receipts.filter(r => !want.has(r.id));
    return before - doc.receipts.length;
  }
  function removeDelivery(id) { doc.deliveries = doc.deliveries.filter(d => d.id !== id); }
  function tombstoneOf(d, reason, error) {
    removeDelivery(d.id);
    const t = { id: d.id, chat: d.chat, runId: d.runId, reason: str(reason, 60), error: str(error, 240), at: now() };
    // what had already landed: a caller that keeps asking must never send those parts again (routine-delivery.js)
    const sent = d.parts.filter(p => p.sent).length;
    if (sent) t.sent = sent;
    doc.tombstones.push(t);
    return t;
  }

  // ---- first attempts: deliver() waits for its own reply's first attempt in this process -------------------------
  function resolveWaiter(id, outcome) {
    const w = waiters.get(id);
    if (!w) return false;
    waiters.delete(id);
    try { w.resolve(outcome); } catch (e) { failNote('channels.ledger.waiter', e); }
    return true;
  }
  function eventFor(d, ok, reason) {
    // chunks: the reply's own parts (the delayed-reply line, when it went on its own, is not one of them); a file that
    // could not go and a note with nothing to say are not either
    const counted = (p) => p.n !== 'h' && !(p.kind === 'file' && p.error) && !(p.kind === 'note' && !p.text);
    const ev = { channel: d.channel, chatId: d.chatId, runId: d.runId || '', ok: !!ok, chunks: d.parts.filter(counted).length, reason: reason };
    if (d.agentId) ev.agentId = d.agentId;
    return ev;
  }
  function emitVia(sender, ev) {
    if (!sender || typeof sender.emit !== 'function') return;
    try { sender.emit('channel.delivery', ev); } catch (e) { failNote('channels.ledger.emit', e); }
  }
  // the chat's lane cannot go on now: every reply still waiting for its first attempt is told so (it stays queued), and
  // that failed attempt is reported once. A caller only asking how a delivery is going (whenAttempted with quiet: true) is
  // told too, and reports nothing: no send of its own failed.
  function releaseWaiters(chat, why) {
    for (const d of queuedIn(chat)) {
      const w = waiters.get(d.id);
      if (!w) continue;
      if (!(w.extras && w.extras.quiet)) emitVia(senders.get(d.channel), eventFor(d, false, d.reason));
      resolveWaiter(d.id, { ok: false, queued: true, held: why || '', error: d.lastError || '' });
    }
  }

  // ---- lanes ----------------------------------------------------------------------------------------------------
  function laneOf(chat) {
    let l = lanes.get(chat);
    if (!l) { l = { chat: chat, running: null, again: false, timer: null, fails: 0, tail: Promise.resolve(), holders: 0, current: '' }; lanes.set(chat, l); }
    return l;
  }
  function forgetIdle(l) {
    if (l.running || l.timer || l.holders > 0) return;
    if (queuedIn(l.chat).length) return;
    lanes.delete(l.chat);
  }
  // the lane's mutex: one part on the wire per chat at a time, whoever sends it
  function lock(l) {
    let release;
    const gate = new Promise((r) => { release = r; });
    const before = l.tail;
    l.tail = before.then(() => gate);
    l.holders++;
    return before.then(() => () => { l.holders--; release(); forgetIdle(l); });
  }
  function blockOf(l, head) {
    if (closed) return 'closed';
    if (!loaded) return 'unread';
    if (dirty) return 'dirty';
    if (holding()) return 'holding';
    if (authHeld.has(head.channel)) return 'auth';
    if (l.timer) return 'backoff';
    if (!senders.get(head.channel)) return 'no-sender';
    return '';
  }
  function armHoldPoll() {
    if (holdTimer || closed) return;
    holdTimer = arm(() => { holdTimer = null; if (holding()) armHoldPoll(); else kickAll(); }, limits.holdPollMs);
  }
  function drive(chat) {
    const l = laneOf(String(chat));
    if (l.running) { l.again = true; return l.running; }
    l.running = (async () => {
      try {
        do { l.again = false; await runLane(l); } while (l.again && !closed);
      } catch (e) { failNote('channels.ledger.lane', e); }
      finally { l.running = null; forgetIdle(l); }
    })();
    return l.running;
  }
  function kick(channel, opts) {
    const ch = String(channel);
    if (opts && opts.reset) {
      authHeld.delete(ch);
      for (const l of lanes.values()) {
        if (l.chat.slice(0, l.chat.lastIndexOf('|')) !== ch) continue;
        l.fails = 0;
        if (l.timer) { clearTimer(l.timer); l.timer = null; }
      }
    }
    const chats = new Set();
    for (const d of doc.deliveries) if (d.channel === ch && d.state === 'queued') chats.add(d.chat);
    return Promise.all(Array.from(chats).map(c => drive(c)));
  }
  function kickAll() {
    const chats = new Set();
    for (const d of doc.deliveries) if (d.state === 'queued') chats.add(d.chat);
    for (const c of chats) drive(c).catch(swallow('channels.ledger.kick'));
  }

  async function runLane(l) {
    if (typeof d0.beforeDrive === 'function') { try { d0.beforeDrive(); } catch (e) { failNote('channels.ledger.beforeDrive', e); } }
    for (;;) {
      if (!ready()) { releaseWaiters(l.chat, 'unread'); return; }
      const head = queuedIn(l.chat)[0];
      if (!head) return;
      const why = blockOf(l, head);
      if (why) { if (why === 'holding') armHoldPoll(); releaseWaiters(l.chat, why); return; }
      const release = await lock(l);
      let next;
      try { l.current = head.id; next = await attempt(l, head); }
      finally { l.current = ''; release(); }
      if (next !== 'continue') return;
    }
  }

  // the first unsent part of a migrated reply is cut here, with the attached channel's own limit
  function cutIfNeeded(d, sender) {
    if (d.parts.length || typeof d.text !== 'string') return true;
    let cut = null;
    try { cut = typeof sender.cut === 'function' ? sender.cut(d.text) : null; } catch (e) { failNote('channels.ledger.cut', e); cut = null; }
    if (!Array.isArray(cut) || !cut.length) cut = d.text ? [{ text: d.text }] : [];
    d.parts = cut.map((c, i) => { const p = { kind: 'text', n: i, text: String(c.text), sent: false, messageId: '' }; if (typeof c.raw === 'string' && c.raw !== p.text) p.raw = c.raw; return p; });
    delete d.text;
    return commit('cut');   // write-ahead: the parts are durable before the first of them goes out
  }
  // A DELAYED reply says so once: the header rides its first unsent part when it fits, else goes just before it. A routine's
  // result is not a reply to anyone's message (its title says what it is, and the ROUTINES panel when it landed), so its
  // parts go as written; nor is a part that is not words ever prefixed.
  function markDelayed(d, sender) {
    if (d.delayed || d.kind === 'routine') return;
    d.delayed = true;
    const i = d.parts.findIndex(p => !p.sent);
    if (i < 0 || d.parts[i].kind !== 'text') return;
    const max = Number(sender && sender.maxMessageLength) || 4096;
    const p = d.parts[i];
    if (DELAYED_HEADER.length + 1 + p.text.length <= max) {
      p.text = DELAYED_HEADER + '\n' + p.text;
      if (typeof p.raw === 'string') p.raw = DELAYED_HEADER + '\n' + p.raw;
    } else if (DELAYED_HEADER.length <= max) {
      d.parts.splice(i, 0, { kind: 'text', n: 'h', text: DELAYED_HEADER, sent: false, messageId: '' });
    }   // (a channel whose whole limit is shorter than the line cannot carry it at all)
  }
  function partOpts(d, i, extras) {
    const first = d.parts.findIndex(p => p.kind === 'text');
    const route = {};
    if (d.route && d.route.threadId) route.threadId = d.route.threadId;
    if (extras && extras.replyTo && i === first) route.replyTo = extras.replyTo;
    const last = i === d.parts.length - 1;
    const terminal = (last && extras && extras.sendOpts) ? extras.sendOpts : null;
    const hasRoute = !!(route.threadId || route.replyTo);
    return (hasRoute || terminal) ? Object.assign({}, terminal || {}, hasRoute ? route : {}) : undefined;
  }
  const notModified = (e) => /not modified/i.test(String(e || ''));
  const messageGone = (e) => /message to edit not found/i.test(String(e || ''));
  async function sendPart(sender, d, i, opts) {
    const part = d.parts[i];
    if (i === 0 && d.seed && typeof sender.editMessage === 'function') {
      // chunk 0 REPLACES the streamed seed; "message is not modified" is a success wearing a 400
      let r;
      try { r = await sender.editMessage(d.chatId, d.seed, part.text, opts || {}); } catch (e) { r = { ok: false, error: (e && e.message) || 'editMessage threw' }; }
      if (r && r.ok === false && notModified(r.error)) r = { ok: true, messageId: d.seed };
      if (r && r.ok !== false) return r.messageId ? r : Object.assign({}, r, { ok: true, messageId: d.seed });
      // the partial is stranded: remove it first, then send the real chunk
      if (typeof sender.deleteMessage === 'function') {
        try { await sender.deleteMessage(d.chatId, d.seed); } catch (e) { failNote('channels.hub.seed.delete', e); }
      }
      d.seed = '';
    }
    // ONE IDEMPOTENCY KEY PER PART, the same in every attempt and every process: a resend of a part the platform already
    // took (its answer lost, or the process gone before the mark) is deduped where the platform honours a key (Discord's
    // nonce, Matrix's txnId); Telegram, Slack and Signal ignore it. Never on the seed edit above: an edit is not a post.
    const keyed = Object.assign({}, opts || {}, { idempotencyKey: partKey(d.id, part.n) });
    try { return await sender.send(d.chatId, part.text, keyed); }
    catch (e) { return { ok: false, error: (e && e.message) || 'send threw' }; }
  }
  // one delivery's attempt: its unsent parts in order, each mark written as the platform accepts it
  async function attempt(l, d) {
    const w = waiters.get(d.id);
    const extras = w ? w.extras : null;
    let lastId = '';
    for (;;) {
      if (deliveryById(d.id) !== d || d.state !== 'queued') return 'continue';   // given up or released meanwhile
      const sender = senders.get(d.channel);
      if (!sender) { releaseWaiters(l.chat, 'no-sender'); return 'stop'; }
      if (!loaded || dirty || holding()) { if (holding()) armHoldPoll(); releaseWaiters(l.chat, dirty ? 'dirty' : 'holding'); return 'stop'; }
      if (d.edit) return stampAttempt(l, d, sender);
      if (!cutIfNeeded(d, sender)) { releaseWaiters(l.chat, 'dirty'); return 'stop'; }
      const i = d.parts.findIndex(p => !p.sent);
      if (i < 0) { finish(d, sender, lastId); return 'continue'; }
      const part = d.parts[i];
      let r;
      if (part.kind === 'text') r = await sendPart(sender, d, i, partOpts(d, i, extras));
      else {
        // a file or a missed-file note: the host's handler sends it (attachParts); none attached yet -> the lane waits
        const handler = partHandlers[part.kind];
        if (typeof handler !== 'function') { releaseWaiters(l.chat, 'no-handler'); return 'stop'; }
        try { r = await handler(d, part, { sender: sender, opts: partOpts(d, i, extras), key: partKey(d.id, part.n) }); }
        catch (e) { r = { ok: false, retryable: false, error: (e && e.message) || (part.kind + ' part failed') }; }
      }
      if (r && r.threadGone) {   // the topic is gone; stop aiming at it (the next write below carries the durable route)
        if (d.route) forgetRoute(d.chat, d.route.threadId);
        d.route = null;
      }
      if (deliveryById(d.id) !== d) return 'continue';   // the chat removed this bot while that part was on the wire
      const landed = !!(r && r.ok !== false);
      // A FILE OR A NOTE THAT CANNOT GO is not the delivery's failure (its words already landed): it is marked with its
      // error and never tried again, and the note names it. A refused credential holds it, as it holds the words, an upload
      // cut short by a shutdown ('aborted') is tried again like any part that never reached the platform, and a refusal for
      // the moment waits on the lane's backoff, a bounded number of times: the chat's replies queue behind this file.
      const held = !!(r && (r.auth === true || String(r.error || '') === 'aborted'));
      const again = !landed && !held && part.kind !== 'text' && !!r && r.retryable === true && (part.tries || 0) < limits.partRetries;
      if (again) part.tries = (part.tries || 0) + 1;
      if (landed || (part.kind !== 'text' && !held && !again)) {
        part.sent = true;
        if (!landed) {
          part.error = str((r && r.error) || 'not sent', 240);
          // could not be read: the note says what the reader knew of it (channels/outbound.js hands it over as r.missed)
          if (r && r.unreadable === true) { part.unread = true; Object.assign(part, missOf(r.missed)); }
        }
        else {
          if (r.messageId) { part.messageId = String(r.messageId); lastId = part.messageId; }
          if (part.kind === 'note') part.text = str(r.said, 4000);
          if (!r.empty) {                              // a note with nothing to say sent nothing, and proves nothing
            l.fails = 0;
            d.lastError = '';
            const c = doc.chats[d.chat];
            if (c && c.dead) c.dead = null;            // a reply that lands proves the chat takes our messages again
          }
        }
        if (d.parts.every(p => p.sent)) { finish(d, sender, lastId); return 'continue'; }
        commit('mark');                                // the sent mark, in the continuation that saw the platform accept it
        continue;
      }
      return failed(l, d, sender, r || { ok: false, error: 'send failed' });
    }
  }
  // A stamp: one edit, no route (the message is where it is), and no reply_markup, which is what strips the buttons
  async function stampAttempt(l, d, sender) {
    let r;
    try {
      r = typeof sender.editMessage === 'function' ? await sender.editMessage(d.chatId, d.edit.messageId, d.edit.text, {})
        : { ok: false, retryable: false, error: 'this channel cannot edit a message' };
    } catch (e) { r = { ok: false, error: (e && e.message) || 'editMessage threw' }; }
    if (deliveryById(d.id) !== d) return 'continue';   // the chat removed this bot while it was on the wire
    if (r && r.ok === false && !notModified(r.error)) return failed(l, d, sender, r);
    l.fails = 0;
    finish(d, sender, '');
    return 'continue';
  }
  function finish(d, sender, lastId) {
    if (d.release === 'caller') { d.state = 'done'; d.doneAt = now(); }
    else removeDelivery(d.id);
    commit('done');                                    // the last mark and the record leaving: one write
    const fresh = resolveWaiter(d.id, { ok: true, messageId: lastId || lastMessageIdOf(d) });
    if (!d.edit) emitVia(sender, eventFor(d, true, fresh ? d.reason : 'redelivered'));
  }
  function lastMessageIdOf(d) { for (let i = d.parts.length - 1; i >= 0; i--) if (d.parts[i].messageId) return d.parts[i].messageId; return ''; }
  function failed(l, d, sender, r) {
    const error = String(r.error || 'send failed').slice(0, 240);
    const auth = r.auth === true;
    const aborted = error === 'aborted';
    const permanent = r.retryable === false && !auth && !aborted;
    const c = doc.chats[d.chat];
    const dead = !!(c && c.dead);
    if (d.edit && !auth && !aborted && (permanent || dead || messageGone(error) || d.tries >= limits.stampRetries)) return stampLost(d, error);
    if (permanent || (dead && !auth && !aborted)) {
      // UNDELIVERABLE: the platform said this send can never succeed (or the chat removed us): a tombstone, said once
      const reason = permanent ? 'undeliverable' : 'redelivery-gave-up';
      tombstoneOf(d, reason, error);
      commit('tombstone');
      try { log('[' + d.channel + '] reply for chat ' + d.chatId + ' is ' + (permanent ? 'undeliverable' : 'given up (the chat removed this bot)') + ' and will not be retried: ' + error.slice(0, 200)); } catch (e) { failNote('channels.ledger.log', e); }
      emitVia(sender, eventFor(d, false, reason));
      resolveWaiter(d.id, { ok: false, undeliverable: true, error: error });
      return 'continue';
    }
    d.tries = Math.min(1000000, d.tries + 1);
    d.lastError = error;
    markDelayed(d, sender);
    if (auth) {
      authHeld.add(d.channel);   // the credential, not this chat: every lane of the channel holds until its next 'up'
    } else {
      const base = Math.min(limits.backoffMs * Math.pow(2, Math.min(l.fails, 8)), limits.backoffMaxMs);
      const wait = Math.max(base, Number(r.retryAfter) > 0 ? Math.min(Number(r.retryAfter) * 1000, limits.backoffMaxMs) : 0);
      l.fails++;
      d.nextAt = now() + wait;
      if (l.timer) clearTimer(l.timer);
      l.timer = arm(() => { l.timer = null; drive(l.chat).catch(swallow('channels.ledger.retry')); }, wait);
    }
    commit('retry');
    if (d.tries === limits.escalateTries && !d.edit) {
      emitVia(sender, eventFor(d, false, 'redelivery-delayed'));
      try { log('[' + d.channel + '] reply for chat ' + d.chatId + ' still delayed after ' + d.tries + ' attempts; kept for retry'); } catch (e) { failNote('channels.ledger.log', e); }
    }
    releaseWaiters(l.chat, auth ? 'auth' : 'backoff');
    return 'stop';
  }
  // A stamp that cannot land: its keyboard stays as it is, which costs no one anything (the decision was applied whatever
  // the message says), so no channel.delivery, and a message that is gone is not worth a line either
  function stampLost(d, error) {
    const gone = messageGone(error);
    tombstoneOf(d, gone ? 'keyboard-gone' : 'stamp-gave-up', error);
    commit('tombstone');
    if (!gone) { try { log('[' + d.channel + '] the keyboard in chat ' + d.chatId + ' could not be stamped, and is left as it is: ' + error.slice(0, 200)); } catch (e) { failNote('channels.ledger.log', e); } }
    resolveWaiter(d.id, { ok: false, undeliverable: true, error: error });
    return 'continue';
  }

  /* A CHAT THAT KEEPS NO MORE WAITING MESSAGES (receive): the message is acknowledged and not kept, and the chat is told
     once per spell, in a notice queued behind the replies it is owed (none is added while one is still queued). The notice
     is written like a receipt: when it cannot be, nothing is recorded and the throw keeps the update unacknowledged. */
  function overflow(id, channel, chatId, chat) {
    const out = { id: id, channel: channel, chatId: chatId, overflow: true, notice: null };
    if (doc.deliveries.some(d => d.chat === chat && d.state === 'queued' && d.id.indexOf('notice:overflow:') === 0)) return out;
    const c = doc.chats[chat];
    const placed = placeDelivery(newDelivery({ id: 'notice:overflow:' + chat + ':' + now(), channel: channel, chatId: chatId, kind: 'notice', reason: 'overflow',
      route: c && c.route ? c.route : null, parts: [OVERFLOW_NOTICE(limits.deferredPerChat)] }));
    const wasDirty = dirty;
    try { io.write(serialize()); }
    catch (err) { removeDelivery(placed.id); failNote('channels.ledger.write.overflow', err); throw err; }
    dirty = false; writeError = null; persistDelay = 0;
    if (wasDirty) { if (persistTimer) { clearTimer(persistTimer); persistTimer = null; } healthChanged(); kickAll(); }
    try { log('[' + channel + '] chat ' + chatId + ' keeps ' + limits.deferredPerChat + ' waiting messages while its replies cannot be delivered: newer ones are not kept, and the chat is told'); } catch (e) { failNote('channels.ledger.log', e); }
    out.notice = placed;
    return out;
  }

  // ---- the ledger ---------------------------------------------------------------------------------------------------
  // Admission belongs to the receipt, not its adapter-supplied message. A later admitted edit
  // invalidates earlier pending edits of that exact message in the same durable transaction.
  function acceptEdit(record) {
    const previous = [];
    for (const row of doc.receipts) {
      if (!row.message || row.message.edited !== true || row.channel !== record.channel || row.chatId !== record.chatId ||
          String(row.message.messageId || '') !== String(record.message.messageId || '')) continue;
      previous.push([row, row.editAdmission]);
      row.editAdmission = { v: 1, state: row === record ? 'accepted' : 'superseded' };
    }
    return () => { for (const [row, prior] of previous) { if (prior === undefined) delete row.editAdmission; else row.editAdmission = prior; } };
  }
  const ledger = {
    bootId: bootId,
    limits: limits,
    load: load,
    health: health,
    setIssue: setIssue,
    get loaded() { return loaded; },
    get dirty() { return dirty || (!loaded && !!loadError); },

    // ---- intake ----
    receive(entry) {
      const e = entry || {};
      const id = String(e.id || '');
      const message = e.message;
      if (!id || !message || typeof message !== 'object') throw new Error('bad channel receipt');
      if (!ready()) throw Object.assign(new Error('delivery ledger cannot be read (' + codeOf(loadError) + '); refusing to acknowledge'), { code: 'LEDGER_UNREAD' });
      const existing = receiptById(id);
      if (existing) return existing;   // a platform redelivery or a recovery: idempotent at the intake edge
      const channel = String(e.channel || '');
      const chatId = String(e.chatId != null ? e.chatId : message.chatId);
      const chat = chatKeyOf(channel, chatId);
      /* BACKPRESSURE, per chat (review round 1). A message that may start a run waits (deferred) while its chat owes too
         much, and behind any of its chat's messages already waiting; one that starts no run (entry.deferrable === false:
         a command, a stop, an overheard line) is never held back. The channel's cap counts only the receipts being worked
         on: a chat's waiting ones are its own, so one chat whose sends keep failing while it keeps talking can never shut
         the channel's intake on every other chat. A chat that already keeps deferredPerChat waiting messages keeps no more:
         the message is acknowledged and not kept, and the chat is told so once per spell, behind the replies it is owed. */
      const deferred = e.deferrable !== false && (laneFull(chat) || hasDeferred(chat));
      if (!deferred && doc.receipts.filter(r => r.channel === channel && !r.deferred).length >= limits.maxPendingPerChannel) {
        throw Object.assign(new Error('channel inbox is full; refusing to acknowledge more work'), { code: 'INTAKE_FULL' });
      }
      if (deferred && doc.receipts.filter(r => r.deferred && chatKeyOf(r.channel, r.chatId) === chat).length >= limits.deferredPerChat) return overflow(id, channel, chatId, chat);
      const r = { id: id, channel: channel, chatId: chatId, message: clone(message), ts: now(), attempt: null, deferred: deferred };
      const before = doc.chats[chat] ? clone(doc.chats[chat]) : undefined;
      if (e.route !== undefined || (doc.chats[chat] && doc.chats[chat].dead)) {
        const c = chatRec(chat);
        if (e.route !== undefined) c.route = (e.route && e.route.threadId) ? { threadId: String(e.route.threadId) } : null;
        c.dead = null;   // the chat speaking is proof it takes our messages again
      }
      doc.receipts.push(r);
      const undoEdit = !deferred && message.edited === true && e.editCurrent === true ? acceptEdit(r) : null;
      const wasDirty = dirty;
      prune();
      // A RECEIPT THAT CANNOT BE WRITTEN RECORDS NOTHING: it is undone and thrown, so the adapter does not acknowledge
      try { io.write(serialize()); }
      catch (err) {
        if (undoEdit) undoEdit();
        removeReceipts([id]);
        if (before === undefined) delete doc.chats[chat]; else doc.chats[chat] = before;
        failNote('channels.ledger.write.receipt', err);
        throw err;
      }
      dirty = false; writeError = null; persistDelay = 0;
      if (wasDirty) { if (persistTimer) { clearTimer(persistTimer); persistTimer = null; } healthChanged(); kickAll(); }
      return r;
    },
    admitEdit(id) {
      if (!ready() || dirty) return false;
      const row = receiptById(String(id));
      if (!row || row.deferred || !row.message || row.message.edited !== true) return false;
      const state = row.editAdmission;
      if (state && state.v === 1 && state.state === 'superseded') return false;
      if (state && state.v === 1 && state.state === 'accepted') return true;
      const undo = acceptEdit(row);
      if (commit('editAdmission')) return true;
      undo(); // a failed write cannot invalidate an older accepted edit in memory either
      return false;
    },
    markAttempt(ids, patch, opts) {
      const p = patch || {};
      let changed = false;
      const was = [];
      for (const id of arr(ids)) {
        const r = receiptById(String(id));
        if (!r) continue;
        const prev = r.attempt || { runId: '', tools: 0, boot: '', replays: 0 };
        const next = { runId: prev.runId, tools: prev.tools, boot: bootId, replays: prev.replays || 0 };
        if (p.runId != null && String(p.runId)) next.runId = str(p.runId, 200);
        if (p.tools != null) next.tools = Math.max(next.tools, Math.min(1000000, Math.max(0, Math.floor(Number(p.tools) || 0))));
        if (p.replay === true) next.replays = Math.min(1000, next.replays + 1);
        was.push([r, r.attempt]);
        r.attempt = next;
        changed = true;
      }
      // opts.undo: a mark that could not be written is taken back, so memory says what the disk says (the hub's tool-step
      // mark: that step never goes; its run is stopped before it is dispatched)
      if (changed && !commit('attempt') && opts && opts.undo === true) for (const [r, a] of was) r.attempt = a;
      return changed;
    },
    receipt(id) { return ready() ? receiptById(String(id)) : null; },
    pending(channel) { return ready() ? doc.receipts.filter(r => !channel || r.channel === String(channel)).slice() : []; },
    undefer(id) { const r = receiptById(String(id)); if (r && r.deferred) { r.deferred = false; return true; } return false; },
    laneFull(chat) { return ready() ? laneFull(String(chat)) : false; },

    // ---- replies ----
    answer(receiptIds, delivery) {
      ready();
      const rec = placeDelivery(newDelivery(delivery));
      removeReceipts(receiptIds);
      commit('answer');   // the receipts leave and the reply enters its lane in the SAME write
      return rec;
    },
    enqueue(delivery) {
      const readable = ready();
      if (Publication.hasMetadata(delivery) && !readable) Publication.refuse('The saved delivery ledger is unavailable');
      const rec = newDelivery(delivery);
      const placed = placeDelivery(rec);
      if (placed === rec) commit('enqueue');
      return placed;
    },
    // durable: the settle is on the disk (or there was nothing to settle). opts.undo: a settle that could not be written is
    // taken back (its receipts stay pending), for a caller that acts only once the settle is kept (hub.js: a command)
    settle(receiptIds, opts) {
      if (!ready() && !(opts && opts.notice)) return { settled: 0, notice: null, durable: false };
      const before = doc.receipts;
      const n = removeReceipts(receiptIds);
      const notice = (opts && opts.notice) ? placeDelivery(newDelivery(opts.notice)) : null;
      const durable = (n || notice) ? commit('settle') : true;
      if (!durable && opts && opts.undo === true) {
        doc.receipts = before;   // removeReceipts built a new array: the old one is untouched, in its order
        if (notice) removeDelivery(notice.id);
        return { settled: 0, notice: null, durable: false };
      }
      return { settled: n, notice: notice, durable: durable };
    },
    settleRun(runId, opts) {
      ready();
      const o = opts || {};
      const ids = doc.receipts.filter(r => r.attempt && r.attempt.runId === String(runId) && (!o.channel || r.channel === String(o.channel))).map(r => r.id);
      for (const id of arr(o.ids)) if (ids.indexOf(id) < 0) ids.push(id);
      return Object.assign({ ids: ids }, ledger.settle(ids, { notice: o.notice }));
    },
    delivery(id) { return deliveryById(String(id)); },
    publication(id) {
      if (!ready() || dirty) Publication.refuse('The delivery completion has not been saved');
      const d = deliveryById(String(id));
      if (!d || d.state !== 'done') Publication.refuse('The delivery is not complete');
      return clone(readPublication(d));
    },
    deliveries(chat) { return doc.deliveries.filter(d => !chat || d.chat === String(chat)).slice(); },
    tombstones(channel) { return doc.tombstones.filter(t => !channel || t.chat.slice(0, t.chat.lastIndexOf('|')) === String(channel)).slice(); },
    release(id, publication) {
      if (publication !== undefined && (!ready() || dirty)) Publication.refuse('The publication release cannot be confirmed');
      const d = deliveryById(String(id));
      if (!d && publication !== undefined) {
        const proof = Publication.receipt(publication);
        if (proof.deliveryId !== id || typeof io.readConfirmed !== 'function') Publication.refuse('The released delivery identity is unproven');
        const saved = io.readConfirmed();
        if (!saved || saved.version !== 1 || !Array.isArray(saved.deliveries) || !Array.isArray(saved.tombstones) ||
            saved.deliveries.some(row => !row || row.id === id) || saved.tombstones.some(row => !row || row.id === id)) {
          Publication.refuse('The saved delivery release could not be confirmed');
        }
        normalizeDoc(saved); // reject unknown publication schemas even in otherwise well-shaped documents
        return true; // the caller already re-proved the persisted cron receipt's exact canonical row
      }
      if (!d || d.state !== 'done') return false;
      if (Publication.hasMetadata(d)) {
        if (dirty) Publication.refuse('The publication acknowledgement is not confirmed');
        const destination = Publication.record(d);
        const receipt = Publication.receipt(publication, { jobId: destination.jobId, targets: [destination.target], runId: d.runId, agentId: d.agentId });
        const ack = Publication.acknowledgement(d.sessionTurns, d);
        if (receipt.deliveryId !== d.id || ['channel', 'chatId', 'runId', 'agentId'].some(k => receipt[k] !== d[k]) ||
            ['streamId', 'rowId', 'turnId'].some(k => receipt[k] !== ack[k])) Publication.refuse('The recorded routine result does not cover this publication');
        confirmedPublication(d);
        // Its caller has already confirmed the cron receipt. A failed removal cannot
        // silently erase the only retryable record from the running process.
        const before = doc.deliveries;
        removeDelivery(d.id);
        if (!commit('release-publication')) { doc.deliveries = before; Publication.refuse('The published delivery release could not be saved'); }
        return true;
      }
      removeDelivery(d.id);
      commit('release');
      return true;
    },
    // A caller takes back a queued record nothing of which has gone (a routine's newer result replaced it): true when it
    // left. A part that landed, or one on the wire now, keeps the record: it finishes.
    withdraw(id) {
      const d = deliveryById(String(id));
      if (!d || d.state !== 'queued' || d.parts.some(p => p.sent) || onWire(d)) return false;
      removeDelivery(d.id);
      commit('withdraw');
      resolveWaiter(d.id, { ok: false, queued: false, gone: true });
      return true;
    },
    onWire(id) { const d = deliveryById(String(id)); return !!d && onWire(d); },

    // ---- keyboards (a stamp is a delivery that edits; see A STAMP IS AN EDIT above) ----
    openAsk(ask) {
      ready();
      const rec = cleanAsk(Object.assign({}, ask, { boot: bootId, at: now() }));
      if (!rec) return null;
      doc.openAsks = doc.openAsks.filter(a => a.id !== rec.id).concat([rec]);
      commit('ask');
      return rec;
    },
    stamp(delivery) {
      ready();
      const rec = newDelivery(Object.assign({}, delivery, { kind: 'edit' }));
      doc.openAsks = doc.openAsks.filter(a => a.id !== rec.id);
      const placed = placeDelivery(rec);
      commit('stamp');   // the open ask leaves and its stamp enters the lane in the SAME write
      return placed;
    },
    // the asks a process that is gone left open on this channel (its keyboards are still live on the platform)
    asksLeftOpen(channel) { return ready() ? doc.openAsks.filter(a => a.channel === String(channel) && a.boot !== bootId).map(a => Object.assign({}, a)) : []; },
    // The legacy overload marks its one-time side effect before execution. The v2 overload
    // accepts only a canonical identity already returned by the writer, then confirms its
    // acknowledgement through the primary file before the caller may record/release it.
    noteSession(id, proof) {
      if (proof !== undefined && !ready()) Publication.refuse('The saved delivery ledger is unavailable');
      const d = deliveryById(String(id));
      if (proof !== undefined) {
        if (!d || d.state !== 'done' || typeof io.readConfirmed !== 'function') Publication.refuse('The completed delivery could not be confirmed');
        Publication.record(d);
        if (!proof || Object.keys(proof).sort().join(',') !== 'rowId,streamId,turnId') Publication.refuse('The canonical publication proof is malformed');
        const prior = d.sessionTurns && Publication.owns(d.sessionTurns, 'v') ? Publication.acknowledgement(d.sessionTurns, d) : null;
        const ack = Publication.acknowledgement({ v: 2, at: prior ? prior.at : now(), streamId: proof.streamId, rowId: proof.rowId, turnId: proof.turnId }, d);
        if (prior && !Publication.same(prior, ack)) Publication.refuse('The canonical publication identity changed');
        const saved = readPublication(d, true);
        if (saved.sessionTurns && Publication.owns(saved.sessionTurns, 'v') &&
            !Publication.same(Publication.acknowledgement(saved.sessionTurns, saved), ack)) Publication.refuse('The saved canonical publication identity changed');
        d.sessionTurns = ack;
        if (!commit('session-publication')) Publication.refuse('The publication acknowledgement could not be saved');
        // Never confirm from the in-memory marker, stat cache, or a recovered backup.
        // A landed write with a lost acknowledgement is re-proved on the next call.
        return confirmedPublication(d);
      }
      if (d && Publication.hasMetadata(d)) Publication.refuse('A canonical publication proof is required before acknowledgement');
      if (!d || d.sessionTurns) return false;
      d.sessionTurns = { at: now() };
      commit('session');
      return true;
    },

    // ---- chats ----
    chat(chat) { const c = doc.chats[String(chat)]; return c ? clone(c) : { route: null, dead: null }; },
    forgetThread(chat, threadId) {
      if (threadId == null || threadId === '') return false;
      const changed = forgetRoute(String(chat), threadId);
      if (changed) commit('route');
      return changed;
    },
    markDead(chat, status) {
      ready();
      const key = String(chat);
      chatRec(key).dead = { at: now(), status: str(status, 40) };
      const l = lanes.get(key);
      const gone = [];
      for (const d of queuedIn(key)) {
        if (l && l.current === d.id) continue;   // the part on the wire finishes; its next failure gives it up
        const t = tombstoneOf(d, 'redelivery-gave-up', 'chat ' + str(status, 40));
        if (!d.edit) gone.push(t);               // (a stamp is no reply: nothing is said about it)
        resolveWaiter(d.id, { ok: false, undeliverable: true, error: 'chat ' + str(status, 40) });
      }
      // the backoff those replies armed goes with them: the chat's next reply gets its one send at once
      if (l && !l.current) { l.fails = 0; if (l.timer) { clearTimer(l.timer); l.timer = null; } }
      commit('dead');
      return gone;
    },
    clearDead(chat) {
      const c = doc.chats[String(chat)];
      if (!c || !c.dead) return false;
      c.dead = null;
      commit('alive');
      return true;
    },

    // ---- lanes ----
    attach(channel, sender) {
      const ch = String(channel);
      if (!sender || typeof sender.send !== 'function') throw new Error('delivery ledger: a sender needs send()');
      senders.set(ch, sender);
      kick(ch).catch(swallow('channels.ledger.attach'));
      return function detach() { if (senders.get(ch) === sender) senders.delete(ch); };
    },
    // the host's senders of the parts that are not words ({ file, note }: channels/outbound.js); a lane that waited for
    // one goes on now
    attachParts(handlers) {
      for (const k of ['file', 'note']) if (handlers && typeof handlers[k] === 'function') partHandlers[k] = handlers[k];
      kickAll();
    },
    drive(chat) { return drive(String(chat)); },
    kick: kick,
    kickAll: kickAll,
    whenAttempted(id, extras) {
      const key = String(id);
      const d = deliveryById(key);
      if (!d) return Promise.resolve({ ok: false, queued: false, gone: true });
      if (d.state === 'done') return Promise.resolve({ ok: true, messageId: lastMessageIdOf(d) });
      const prior = waiters.get(key);
      if (prior) return prior.promise;
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      waiters.set(key, { resolve: resolve, promise: promise, extras: extras || null });
      return promise;
    },
    async sendEphemeral(chat, fn) {
      const l = laneOf(String(chat));
      const release = await lock(l);
      try { return await fn(); }
      finally { release(); }
    },

    // ---- the live claim: a receipt being processed in THIS process (store-wide, so a reconnect's new hub never re-runs it)
    liveClaim(id) { return claims.get(String(id)) || null; },
    holdClaim(id, promise) {
      const key = String(id);
      claims.set(key, promise);
      const done = () => { if (claims.get(key) === promise) claims.delete(key); };
      Promise.resolve(promise).then(done, done);
      return promise;
    },

    /* ---- the v1 migration's import (store.js migrateV1): each v1 item becomes exactly one record, in ONE write ----
       inbox items -> receipts (same id, message, attempt); an item carrying a held answer -> one 'reply:<runId>' delivery
       that settles every receipt it answered; outbox items -> queued deliveries (same id; text kept whole with its
       '⌛ delayed reply' line, cut at its first send; ahead of anything newer in its chat). An item already taken —
       (id, ts, hash) in the ledger or in migrated.* — is skipped; a known id with another ts or hash is a new item. */
    importV1(v1) {
      if (!ready()) return { changed: false, persisted: false, error: loadError };
      const inbox = arr(v1 && v1.inbox), outbox = arr(v1 && v1.outbox);
      const mIn = doc.migrated.inbox, mOut = doc.migrated.outbox;
      let changed = false;
      const taken = { receipts: 0, deliveries: 0, settled: 0, skipped: 0 };
      // the v1 inbox items this import has not taken yet: (id, ts, message hash) in neither migrated.inbox nor the receipts
      const fresh = [];
      for (const it of inbox) {
        if (!it || typeof it.id !== 'string' || !it.message || typeof it.message !== 'object') continue;
        const ts = Number(it.ts) || 0;
        const h = shortHash(JSON.stringify(it.message));
        if (mIn.some(x => x.id === it.id && x.ts === ts && x.h === h)) { taken.skipped++; continue; }
        const live = receiptById(it.id);
        if (live && live.ts === ts && shortHash(JSON.stringify(live.message)) === h) { taken.skipped++; continue; }
        fresh.push({ it: it, ts: ts, h: h, live: live });
      }
      // a held answer (a FINISHED reply the full v1 outbox refused) is one delivery for every receipt its run answered
      const heldAnswers = new Map();   // delivery id -> { it, ids }
      const answered = new Set();
      for (const f of fresh) {
        const held = f.it.held;
        if (!held || typeof held !== 'object' || typeof held.text !== 'string') continue;
        const did = 'reply:' + (str(held.runId, 200) || ('v1:' + f.it.id));
        const g = heldAnswers.get(did) || { it: f.it, ids: [] };
        const ids = arr(held.ids).filter(x => typeof x === 'string' && x);
        if (ids.indexOf(f.it.id) < 0) ids.push(f.it.id);
        for (const x of ids) { if (g.ids.indexOf(x) < 0) g.ids.push(x); answered.add(x); }
        heldAnswers.set(did, g);
      }
      for (const f of fresh) {
        changed = true;
        mIn.push({ id: f.it.id, ts: f.ts, h: f.h });
        if (answered.has(f.it.id)) { taken.settled++; continue; }   // its finished answer is sent; nothing re-runs
        const chatId = String(f.it.message.chatId);
        if (!chatId || chatId === 'undefined') continue;
        const id = f.live ? f.it.id + '#' + f.ts : f.it.id;   // an older build reused a v1 edit id (no edit date): both are kept
        doc.receipts.push({ id: id, channel: String(f.it.channel || ''), chatId: chatId, message: f.it.message, ts: f.ts,
          attempt: cleanAttempt(f.it.attempt), deferred: false });
        taken.receipts++;
      }
      for (const [did, g] of heldAnswers) {
        removeReceipts(g.ids);   // a receipt an earlier import took is answered by this same reply
        if (deliveryById(did)) continue;
        const it = g.it;
        const rec = newDelivery({ id: did, channel: String(it.channel || ''), chatId: String(it.message.chatId), kind: 'reply',
          reason: it.held.reason || 'done', runId: it.held.runId, agentId: it.held.agentId, receiptIds: g.ids, text: it.held.text,
          ts: Number(it.ts) || now() });
        insertByTs(rec);
        taken.deliveries++;
      }
      for (const it of outbox) {
        if (!it || typeof it.id !== 'string' || typeof it.chatId !== 'string' || typeof it.text !== 'string') continue;
        const ts = Number(it.ts) || 0;
        if (mOut.some(x => x.id === it.id && x.ts === ts)) { taken.skipped++; continue; }
        const live = deliveryById(it.id);
        if (live && live.ts === ts) { taken.skipped++; continue; }
        changed = true;
        mOut.push({ id: it.id, ts: ts });
        const rec = newDelivery({ id: live ? it.id + '#' + ts : it.id, channel: String(it.channel || ''), chatId: it.chatId, kind: 'reply',
          reason: it.reason, runId: it.runId, agentId: it.agentId, text: it.text, delayed: true, tries: it.tries, ts: ts || now() });
        insertByTs(rec);
        taken.deliveries++;
      }
      if (!changed) return Object.assign({ changed: false, persisted: !dirty, error: dirty ? writeError : null }, taken);
      if (mIn.length > limits.migratedMax) doc.migrated.inbox = mIn.slice(-limits.migratedMax);
      if (mOut.length > limits.migratedMax) doc.migrated.outbox = mOut.slice(-limits.migratedMax);
      const persisted = commit('migrate');
      return Object.assign({ changed: true, persisted: persisted, error: persisted ? null : writeError }, taken);
    },
    // was this v1 item taken? (the migration verifies the document it read back before it empties the v1 files)
    tookV1(doc2, kind, item) {
      const d = normalizeDoc(doc2);
      const ts = Number(item && item.ts) || 0;
      if (kind === 'outbox') return d.migrated.outbox.some(x => x.id === item.id && x.ts === ts) || d.deliveries.some(x => x.id === item.id && x.ts === ts);
      const h = shortHash(JSON.stringify(item && item.message));
      return d.migrated.inbox.some(x => x.id === item.id && x.ts === ts && x.h === h)
        || d.receipts.some(x => x.id === item.id && x.ts === ts && shortHash(JSON.stringify(x.message)) === h);
    },
    // write what is in memory now (the migration asks before it reads the document back); true once it is durable
    // opts.probe: write even when nothing is pending, so the answer is the disk's now (a caller about to act on a decision
    // it can settle only afterwards: hub.js before a steer)
    flush(opts) { if (!ready()) return false; return (dirty || (opts && opts.probe === true)) ? commit('flush') : true; },

    snapshot() { return clone(serialize()); },
    close() {
      closed = true;
      for (const l of lanes.values()) if (l.timer) { clearTimer(l.timer); l.timer = null; }
      for (const t of [persistTimer, loadTimer, holdTimer]) if (t) clearTimer(t);
      persistTimer = loadTimer = holdTimer = null;
      for (const id of Array.from(waiters.keys())) resolveWaiter(id, { ok: false, queued: true, held: 'closed' });
      senders.clear();
    }
  };
  // a migrated reply joins its chat's lane by its original time, ahead of anything newer
  function insertByTs(rec) {
    const at = doc.deliveries.findIndex(d => d.chat === rec.chat && d.state === 'queued' && (Number(d.ts) || 0) > rec.ts);
    if (at < 0) doc.deliveries.push(rec); else doc.deliveries.splice(at, 0, rec);
  }
  return ledger;
}

module.exports = { makeDeliveryLedger, memoryIo, shortHash, partKey, chatKeyOf, normalizeDoc, DEFAULTS, DELAYED_HEADER, OVERFLOW_NOTICE };
