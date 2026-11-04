/* sidecar/channels/hub-delivery.js — a channel hub's DELIVERY: how its replies reach the chat, and how the messages it
   was handed are held until they are answered.

   Moved out of channels/hub.js (channel-delivery-ledger, S1), then rebuilt on the DELIVERY LEDGER (S2,
   channels/delivery-ledger.js). One per hub, built by makeChannelHub over the hub's own seams:

     makeHubDelivery(ctx) -> { deliver, onInbound, receive, inboxId, withInbox, inboxIdsOf, recoverInbox, activeInbox, markAttempt,
                               held, settleNow, writable, settleWithNotice, stamp, askOpened, dropBacklog, chatBack, up, drain, close,
                               notModified, ledger }
       ctx = { channel, store, send, editMessage, deleteMessage, scrubHostPaths, maxMessageLength, routeOpts, forgetThread,
               emit, routeInbound, deferrable?, now?, setTimeout?, clearTimeout?, recoverMs? }

   THE LEDGER is the store's (store.ledger: one per save directory, shared by every hub over that store and every
   makeBotScopedStore view of it). A one-job hub's store answers its own in-memory ledger (channels/fire-store.js), and a
   hub over a store with no ledger at all (a test's fake) gets a private in-memory one for its replies — the same code,
   nothing on disk — while its intake writes no receipts, as a store without them never did.
   This hub attaches its send, editMessage and deleteMessage as its channel's sender when it is built and detaches on
   close, so a reconnect's new hub takes over the same lanes.

     deliver(chatId, text, runId, reason, agentId?, sendOpts?, seedId?, { receiptIds?, id?, kind? }?) -> { ok, messageId, text }
                       A durable reply is chunked once (channels/chunk.js), written to the ledger — answering its receipts in
                       the same write when it names them — and sent by the chat's lane; this resolves with its FIRST
                       attempt: ok, or still queued (it goes later, in order), or undeliverable. A command reply and a
                       keyboard ('command', 'prompt') are ephemeral: sent now, never queued, inside the lane's mutex only
                       while their parts are on the wire.
       onInbound(msg, intake) -> the processing promise: the message's receipt is durable before this returns (the
                       adapter acknowledges only then), and settled when routeInbound resolves — whatever ended it
       receive(msg, intake?) -> { id, start() } | null   the same in two steps, for a choice tap: the receipt is durable
                       when this returns (it throws when it cannot be written), start() then processes it; null = no receipt
       recoverInbox()  replay the receipts no live run owns, each under its own id: on 'up' (up()) and on a 30 s timer,
                       never on a delivery
       stamp(chatId, { id, messageId, text, runId?, promptId? }) -> the delivery   a keyboard's edit, durable when this
                       returns and sent by the chat's lane; it closes the open ask of that id in the same write
       askOpened(chatId, { id, messageId, text, runId, promptId })   a consent keyboard landed with its ask still open
       dropBacklog(chatId, status) / chatBack(chatId)   the chat removed this bot / it is back

   Pure like the hub: every dependency is injected (no fs, no clock), and a failure it swallows is reported (failopen). */
'use strict';

const { note: failNote, swallow } = require('../failopen.js');
const { chunkTextParts } = require('./chunk.js');
const Ledger = require('./delivery-ledger.js');

// a reply that is not durable: a command's answer is stale hours later, and a permission keyboard's ask is answered by the
// host's fail-closed timer within seconds — neither is queued; everything else a hub sends is a durable delivery
const EPHEMERAL = Object.freeze({ command: 1, prompt: 1 });
// what a keyboard says when a restart found it unanswered: the ask died with its process, and nothing ran on it
const RESTARTED_STAMP = '▸ StarNet restarted — not answered; the action did not run';

function makeHubDelivery(ctx) {
  const c = ctx || {};
  const channel = c.channel;
  const store = c.store;
  const send = c.send;                         // the hub's send: the host-path scrub already wraps it
  const editMessage = c.editMessage;           // null when the channel cannot edit (then no stream seed is ever replaced)
  const deleteMessage = c.deleteMessage;
  const scrubHostPaths = c.scrubHostPaths;
  const maxMessageLength = c.maxMessageLength;
  const routeOpts = c.routeOpts;               // the hub's route book (channels/routes.js)
  const forgetThread = c.forgetThread;
  const emit = c.emit;
  const routeInbound = c.routeInbound;         // how the hub processes a message once its receipt is durable
  // deferrable(msg) -> false for a message that starts no run (a command, a stop, an overheard line…): backpressure never
  // holds it back (hub.js deferrable). Absent: every message may be held, as before.
  const deferrable = (msg) => {
    if (typeof c.deferrable !== 'function') return true;
    try { return c.deferrable(msg) !== false; } catch (e) { failNote('channels.hub.deferrable', e); return true; }
  };
  if (!store || typeof send !== 'function' || typeof routeInbound !== 'function' || typeof scrubHostPaths !== 'function'
      || typeof routeOpts !== 'function' || typeof forgetThread !== 'function' || typeof emit !== 'function') {
    throw new Error('makeHubDelivery: store, send, scrubHostPaths, routeOpts, forgetThread, emit and routeInbound are required');
  }
  // The recover timer is injected for deterministic tests, unref'd in production, and closed with the hub.
  const setTimer = typeof c.setTimeout === 'function' ? c.setTimeout : setTimeout;
  const clearTimer = typeof c.clearTimeout === 'function' ? c.clearTimeout : clearTimeout;
  const recoverMs = Number.isFinite(c.recoverMs) ? Math.max(1, Number(c.recoverMs)) : 30000;
  const notModified = (e) => /not modified/i.test(String(e || ''));
  const chatKey = (chatId) => Ledger.chatKeyOf(channel, chatId);

  // the store's ledger; a store without one (a test's fake) gets this hub's own, in memory
  let tick = 0;
  const ownLedger = !(store.ledger && typeof store.ledger.receive === 'function');
  const ledger = ownLedger ? Ledger.makeDeliveryLedger({
    io: Ledger.memoryIo(), bootId: 'hub:' + channel,
    clock: { now: () => (typeof c.now === 'function' ? (Number(c.now()) || 0) : ++tick) },
    timers: { setTimeout: setTimer, clearTimeout: clearTimer }
  }) : store.ledger;
  // this hub sends its channel's lanes: the scrubbed send, the stream seed's edit and delete, and its events
  const detach = ledger.attach(channel, {
    send: (chatId, text, opts) => send(chatId, text, opts),
    editMessage: editMessage || undefined,
    deleteMessage: deleteMessage || undefined,
    emit: (name, payload) => emit(name, payload),
    forgetThread: (chatId, threadId) => forgetThread(chatId, threadId),
    maxMessageLength: maxMessageLength,
    // a reply written before its first send (a migrated v1 reply) is cut here: the WHOLE text scrubbed, then chunked
    cut: (text) => { const p = chunkTextParts(scrubHostPaths(text), maxMessageLength); return p.send.map((t, i) => ({ text: t, raw: p.raw[i] })); }
  });

  // agentId (optional) names WHICH roster agent produced this reply, so the floor can pulse the RIGHT agent's dish on a
  // multi-agent station. Passed only for a real RUN reply; administrative command replies omit it. sendOpts (optional)
  // rides ONLY on the FINAL chunk — a keyboard must land under the last thing the user reads — and only on the reply's
  // first attempt in this process (a keyboard is never persisted: its tap registry dies with the process). Returns the
  // final chunk's messageId and text too, which a keyboard needs to be stamped in place once it is tapped.
  async function deliver(chatId, text, runId, reason, agentId, sendOpts, seedId, extra) {
    if (EPHEMERAL[reason]) return deliverNow(chatId, text, runId, reason, agentId, sendOpts, seedId);
    const x = extra || {};
    // The host path scrub runs on the WHOLE text first: chunked, a path cut at the boundary would go out as two halves.
    const parts = chunkTextParts(scrubHostPaths(text), maxMessageLength);
    // the route: the topic rides every part (durable), the quote only the first part of this first attempt
    const rt = routeOpts(chatId, true);
    const rec = {
      id: x.id || (runId ? 'reply:' + runId : undefined), channel: channel, chatId: String(chatId), kind: x.kind || 'reply',
      reason: reason || '', runId: runId || '', agentId: agentId ? String(agentId) : '',
      route: (rt && rt.threadId) ? { threadId: rt.threadId } : null,
      // a message the stream already put in the chat: chunk 0 REPLACES it rather than being sent again
      seed: (seedId && editMessage) ? String(seedId) : '',
      parts: parts.send.map((t, i) => ({ n: i, text: t, raw: parts.raw[i] }))
    };
    const ids = Array.isArray(x.receiptIds) ? x.receiptIds.filter(i => typeof i === 'string' && i) : [];
    // ONE WRITE: the receipts this reply answers leave as it enters the chat's lane, so a message whose reply exists can
    // never run again
    const d = ids.length ? ledger.answer(ids, rec) : ledger.enqueue(rec);
    const first = ledger.whenAttempted(d.id, { replyTo: (rt && rt.replyTo) || '', sendOpts: sendOpts || null });
    ledger.drive(d.chat).catch(swallow('channels.hub.lane'));
    const out = await first;
    return { ok: !!out.ok, messageId: out.messageId || '', text: parts.send.length ? parts.send[parts.send.length - 1] : '', queued: !!out.queued, undeliverable: !!out.undeliverable };
  }

  // AN EPHEMERAL SEND: now, once, never queued (a failed /help hours later is noise). It holds the chat's lane mutex while
  // its parts are on the wire, so it never splits a durable reply's parts, and never waits behind a lane backing off.
  function deliverNow(chatId, text, runId, reason, agentId, sendOpts, seedId) {
    return ledger.sendEphemeral(chatKey(chatId), async () => {
      const parts = chunkTextParts(scrubHostPaths(text), maxMessageLength);
      const chunks = parts.send;
      let ok = true, messageId = '', lastFail = null;
      let seed = (seedId && editMessage) ? String(seedId) : '';
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        const rt = routeOpts(chatId, i === 0);
        const terminal = (last && sendOpts) ? sendOpts : null;
        const opts = (rt || terminal) ? Object.assign({}, terminal || {}, rt || {}) : undefined;
        let r;
        if (i === 0 && seed) {
          try { r = await editMessage(chatId, seed, chunks[0], opts || {}); } catch (e) { r = { ok: false, error: (e && e.message) || 'editMessage threw' }; }
          if (r && r.ok === false && notModified(r.error)) r = { ok: true, messageId: seed };
          if (!r || r.ok === false) {
            try { await deleteMessage(chatId, seed); } catch (e) { failNote('channels.hub.seed.delete', e); }
            seed = '';
            try { r = await send(chatId, chunks[0], opts); } catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
          } else if (!r.messageId) {
            r = { ok: true, messageId: seed };
          }
        } else {
          try { r = await send(chatId, chunks[i], opts); } catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
        }
        if (r && r.threadGone) ledger.forgetThread(chatKey(chatId), opts && opts.threadId);   // the topic is gone; stop aiming at it
        if (!r || r.ok === false) { ok = false; lastFail = r || null; break; }
        if (last && r.messageId) messageId = String(r.messageId);
      }
      const undeliverable = !ok && !!lastFail && lastFail.retryable === false && lastFail.auth !== true && String(lastFail.error || '') !== 'aborted';
      if (undeliverable) {
        try { console.error('[' + channel + '] ' + (reason || 'reply') + ' for chat ' + chatId + ' is undeliverable: ' + String(lastFail.error || 'refused').slice(0, 200)); } catch (e) { failNote('channels.hub.console', e); }
      }
      const ev = { channel, chatId: String(chatId), runId: runId || '', ok, chunks: chunks.length, reason: undeliverable ? 'undeliverable' : (reason || '') };
      if (agentId) ev.agentId = String(agentId);
      try { emit('channel.delivery', ev); } catch (e) { failNote('channels.hub.delivery.emit', e); }
      return { ok: ok, messageId: messageId, text: chunks.length ? chunks[chunks.length - 1] : '' };
    });
  }

  /* A NOTICE THAT ENDS A RUN'S RECEIPTS (the attempt rule, hub.js reportInterruptedAttempt): every receipt of that run is
     settled and the notice enters the chat's lane in ONE write. Its id ('notice:<runId>:<kind>') is the dedupe: a merged
     batch's receipts get one notice, and a notice already queued is never queued twice. */
  async function settleWithNotice(chatId, text, runId, kind, reason, agentId, receiptIds) {
    const parts = chunkTextParts(scrubHostPaths(text), maxMessageLength);
    const rt = routeOpts(chatId, true);
    const notice = {
      id: 'notice:' + runId + ':' + kind, channel: channel, chatId: String(chatId), kind: 'notice', reason: reason || kind,
      runId: runId || '', agentId: agentId ? String(agentId) : '', route: (rt && rt.threadId) ? { threadId: rt.threadId } : null,
      parts: parts.send.map((t, i) => ({ n: i, text: t, raw: parts.raw[i] }))
    };
    const r = ledger.settleRun(runId, { channel: channel, ids: receiptIds, notice: notice });
    const first = ledger.whenAttempted(r.notice.id, { replyTo: (rt && rt.replyTo) || '', sendOpts: null });
    ledger.drive(r.notice.chat).catch(swallow('channels.hub.lane'));
    const out = await first;
    return { ok: !!out.ok, messageId: out.messageId || '' };
  }

  /* A KEYBOARD'S STAMP, on the delivery ledger (channels/delivery-ledger.js, A STAMP IS AN EDIT): durable before this returns,
     then sent by the chat's lane, retried there, and it closes the open ask of the same id in that one write. */
  function stamp(chatId, s) {
    const d = ledger.stamp({ id: s.id, channel: channel, chatId: String(chatId), reason: 'stamp', runId: s.runId || '',
      edit: { messageId: String(s.messageId), promptId: s.promptId || '', text: scrubHostPaths(s.text), strip: true } });
    ledger.drive(d.chat).catch(swallow('channels.hub.lane'));
    return d;
  }
  // A consent keyboard landed and nobody has answered it yet: if this process dies first, the next one closes it (below)
  function askOpened(chatId, a) {
    ledger.openAsk({ id: a.id, channel: channel, chatId: String(chatId), messageId: String(a.messageId), runId: a.runId || '',
      promptId: a.promptId || '', text: scrubHostPaths(a.text) });
  }
  // THE KEYBOARDS A CRASH LEFT OPEN. Their asks and their tap registry died with that process, and the run never got an
  // answer, so each is stamped with what happened, whatever the attempt rule then does with the message that started it.
  function closeLeftAsks() {
    for (const a of ledger.asksLeftOpen(channel)) {
      try { stamp(a.chatId, { id: a.id, messageId: a.messageId, runId: a.runId, promptId: a.promptId, text: a.text + '\n\n' + RESTARTED_STAMP }); }
      catch (e) { failNote('channels.hub.consent.leftOpen', e); }
    }
  }

  let closed = false;
  const activeInbox = new Map();   // durable inbox id -> the one live processing promise (dedupes restart races)
  // one segment of a receipt id: a finite number, or a short string with no separator or space ('' when it is neither)
  function segment(v, max) {
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    const s = typeof v === 'string' ? v : '';
    return (s && s.length <= (max || 64) && !/[|\s]/.test(s)) ? s : '';
  }
  /* A RECEIPT'S ID is what the platform repeats when it hands the same update over again:
     '<channel>|<chatId>|<messageId>' (channel-delivery-ledger S3 adds the two below).
       · An EDIT adds when it was made, '|edited@<editDate>': two corrections of one message are two messages, so the
         second is never taken for a redelivery of the first. An edit with no date (a v1 receipt the migration kept, a
         relay that sends none) keeps the v1 '|edited'.
       · A CHOICE TAP has no platform message of its own. Its synthetic message keeps messageId '', so it never sets a
         quote or an edit anchor, and carries the tap itself ({ callbackId, messageId: the keyboard's message }), which
         keys its receipt: '<channel>|<chatId>|<keyboard message>|cb:<callbackId>'.
     A message with neither (a one-job fire) keeps no receipt. */
  function inboxId(msg) {
    if (!msg) return '';
    const head = channel + '|' + String(msg.chatId) + '|';
    if (msg.tap && typeof msg.tap === 'object') {
      const cb = segment(msg.tap.callbackId, 200);
      return cb ? head + segment(msg.tap.messageId) + '|cb:' + cb : '';
    }
    if (msg.messageId == null || String(msg.messageId) === '') return '';
    if (!msg.edited) return head + String(msg.messageId);
    const at = segment(msg.editDate, 40);
    return head + String(msg.messageId) + (at ? '|edited@' + at : '|edited');
  }
  function accepted(intake, info) {
    if (intake && typeof intake.onAccepted === 'function') { try { intake.onAccepted(info); } catch (e) { failNote('channels.hub.intake.accepted', e); } }
  }
  /* THE INTAKE, in two steps. receive() makes the message durable: its receipt is written before receive returns (it
     THROWS when the receipt cannot be written, and the adapter then acknowledges nothing), and from that moment the
     receipt is claimed live in this process, so recovery never replays it while it waits to start. start() then processes
     it under that receipt, which settles when routeInbound resolves. onInbound takes both steps at once; a choice tap takes
     them on either side of spending its button and answering the tap (hub.js onCallback). Recovery gives the id: a receipt
     replays under its OWN id, whatever its message would be keyed by now. null: the message keeps no receipt. */
  function receive(msg, intake, givenId) {
    const id = givenId || inboxId(msg);
    // a message with no receipt id (a one-job fire) keeps no receipt; and a store with no ledger of its own (a test's
    // fake) keeps the old intake, as it always did: its hub's private ledger carries replies, never receipts
    if (!id || ownLedger) return null;
    // this hub's own claim first, then the ledger's: a hub this one REPLACED (a reconnect) may still be running it
    const live = activeInbox.get(id) || ledger.liveClaim(id);
    if (live) { accepted(intake, { id, durable: true, duplicate: true }); return { id: id, start: () => live }; }
    // the topic it arrived in rides the receipt's write as the chat's durable route; a tap names no topic of its own, so
    // the one the chat was last heard in stays
    const threadId = (msg.threadId == null || msg.threadId === '') ? '' : String(msg.threadId);
    const route = msg.tap ? undefined : (threadId ? { threadId: threadId } : null);
    // durable BEFORE this returns (the adapter acknowledges only then); it throws synchronously -> no acknowledgement. A
    // message that starts no run is never held back (deferrable: false); one that may is, when its chat owes too much
    const editCurrent = msg.edited === true && typeof c.editIsCurrent === 'function' && c.editIsCurrent(msg) === true;
    const receipt = ledger.receive({ id: id, channel: channel, chatId: String(msg.chatId), message: msg, route: route, deferrable: deferrable(msg), editCurrent });
    accepted(intake, { id, durable: true });
    // OVERFLOW: this chat already holds its whole share of kept messages while its replies cannot get out. The message was
    // not kept, and the chat is told so once, behind the replies it is owed (delivery-ledger.js receive).
    if (receipt.overflow) { if (receipt.notice) ledger.drive(receipt.notice.chat).catch(swallow('channels.hub.lane')); return { id: id, start: () => Promise.resolve() }; }
    // BACKPRESSURE BEFORE THE PAID RUN: this chat still owes too many replies. The message is kept (deferred) and the
    // recover timer runs it, in order, once the chat's lane is under its mark — no finished reply is ever refused.
    if (receipt.deferred) return { id: id, start: () => Promise.resolve() };
    // A receipt that already carries an attempt is a RE-DELIVERY of work whose run had started — from recoverInbox, or the
    // platform handing the same update over again. processInbound applies the attempt rule (attemptOf).
    const routed = Object.assign(withInbox(intake, [id], attemptOf(receipt)), Number.isSafeInteger(receipt && receipt.ts) ? { inboxAt: receipt.ts } : {});   // the durable receipt's original station time survives recovery
    let go = null;
    const gate = new Promise((resolve) => { go = resolve; });
    // A redelivery cannot replace the payload whose receipt was accepted. In particular an
    // equal-id/text edit must not swap its media, quote, provenance or admission-only flags.
    const running = gate.then(() => routeInbound(receipt.message, routed)).then((value) => {
      // SETTLE ON RESOLVE: a message that ended with no durable reply (a steer ack, a command, an observed line, an edit
      // of an older message, a stop) leaves here; one that was answered already left in its answer's write
      ledger.settle([id]);
      return value;
    }).finally(() => { activeInbox.delete(id); });
    activeInbox.set(id, running);
    ledger.holdClaim(id, running);
    return { id: id, start: () => { go(); return running; } };
  }
  function onInbound(msg, intake) {
    const received = receive(msg, intake, '');
    return received ? received.start() : routeInbound(msg, intake);
  }

  /* THE ATTEMPT RULE (e5ecd6b8, 2026-10-21; one rule since channel-delivery-ledger S2). The receipt carries how far its
     message's run got (markAttempt: the run's id when it starts, a count of the tool steps it began, replays), and a
     re-delivered receipt is handled by what that proves, WHICHEVER boot left it:
       no attempt              -> never reached a run: replay it
       attempt, 0 tool steps   -> nothing could have happened: run it again ONCE (replays); a second failure settles it
                                  with a notice that it was not finished and was not run again
       attempt, N tool steps   -> something may already be done: never run again; one notice, in the write that settles
                                  every receipt of that run, and a one-shot note for the chat's next run
     `restart` says whether the attempt was left by an earlier process (a crash, an update) or by this one (processing
     threw): the notice says which. Answered work never comes back here — its receipts left with its reply. */
  function attemptOf(receipt) {
    const a = receipt && receipt.attempt;
    if (!a || typeof a !== 'object' || !String(a.runId || '')) return null;
    return { runId: String(a.runId), tools: Math.max(0, Math.floor(Number(a.tools) || 0)), replays: Math.max(0, Math.floor(Number(a.replays) || 0)),
      restart: String(a.boot || '') !== String(ledger.bootId) };
  }
  function withInbox(intake, ids, prior) {
    const out = Object.assign({}, intake || {}, { inboxIds: ids.slice() });
    if (prior) out.priorAttempt = prior;
    else delete out.priorAttempt;
    return out;
  }
  function inboxIdsOf(intake) {
    return (intake && Array.isArray(intake.inboxIds)) ? intake.inboxIds.filter(x => typeof x === 'string' && x) : [];
  }
  function editReceipt(msg, intake) {
    const ids = inboxIdsOf(intake);
    if (ownLedger || !msg || msg.edited !== true || ids.length !== 1) return null;
    const row = ledger.receipt(ids[0]), saved = row && row.message;
    if (!row || row.channel !== channel || row.chatId !== String(msg.chatId) || !saved || saved.edited !== true ||
        inboxId(saved) !== inboxId(msg) || JSON.stringify(saved) !== JSON.stringify(msg)) return null;
    return row;
  }
  function editState(msg, intake) {
    const row = editReceipt(msg, intake), a = row && row.editAdmission;
    return a && a.v === 1 && (a.state === 'superseded' || (a.state === 'accepted' && !row.deferred)) ? a.state : null;
  }
  function admitEdit(msg, intake) {
    if (ownLedger || !inboxIdsOf(intake).length) return true;
    const row = editReceipt(msg, intake);
    return !!row && ledger.admitEdit(row.id) === true;
  }
  function editReady(msg, intake) {
    return ownLedger || !inboxIdsOf(intake).length || editState(msg, intake) === 'accepted';
  }
  /* THE MARKS ARE WRITE-AHEAD (review round 1). A mark that never reached the disk protects nothing across a crash: the next
     boot read the receipt's older attempt, replayed the message and ran its tool step again. So markAttempt answers true
     only when the mark is on disk (or there was nothing to mark), and the hub starts a run, or lets a tool step go, only
     then (hub.js LEDGER_HELD). opts.undo takes back a mark that could not be written (a tool step that is then never
     dispatched). */
  function markAttempt(ids, patch, opts) {
    if (!ids || !ids.length) return true;
    const changed = ledger.markAttempt(ids, patch, opts);
    return !changed || !ledger.dirty;
  }
  // the ledger cannot be written right now: nothing that runs may start (its marks could not be kept)
  function held() { return !!ledger.dirty; }
  /* A DECISION IS SETTLED WHERE IT IS MADE (review round 1). A message that ends with no reply of its own — a follow-up
     steered into the working run, a command, a stop — settled only when routeInbound resolved, after its ack had been on the
     wire (up to ~30 s with the adapter's resend): a crash in that window replayed it as a new message, so a follow-up ran
     as a task of its own, a "/routine rm 2" removed a second routine, a stop stopped what came after. The hub settles these
     receipts at the decision instead, before the side effect where running it twice would do harm (a command: at most
     once) and before the ack; the settle on resolve then finds nothing left. */
  // true once the settle is on the disk; opts.undo leaves the receipts pending when it is not (the caller then holds)
  function settleNow(ids, opts) { return (ids && ids.length) ? ledger.settle(ids, opts).durable !== false : true; }
  // the disk takes a write right now (a probe write when nothing is pending): before a decision settled only afterwards
  function writable() { return ledger.flush({ probe: true }) === true; }

  let recovering = false;
  async function recoverInbox() {
    if (closed || recovering) return;
    // nothing replays over a ledger that is not durable: a receipt whose answer waits in memory for a failed write is
    // gone from it already, and a replay's own marks must reach the disk before its first tool step
    if (!ledger.loaded && !ledger.load()) return;
    if (ledger.dirty) return;
    closeLeftAsks();
    recovering = true;
    try {
      const waiting = new Set();   // chats whose deferred work stays, in order, behind a lane still over its mark
      for (const it of ledger.pending(channel)) {
        if (closed) break;
        // asked again before EACH replay: a replay starts a run, and its marks must reach the disk (a write that began
        // failing during an earlier replay holds the rest for the next pass)
        if (ledger.dirty) break;
        const chat = chatKey(it.chatId);
        if (waiting.has(chat)) continue;
        /* THE SNAPSHOT GOES STALE WHILE WE AWAIT. A follow-up steered into a run, or a /routine add typed meanwhile, can
           finish on its own path and leave while an earlier replay runs — replaying it from this list ran it a second time
           (2026-10-20). Replay only what is still pending right now, and never what a live run in this process owns. */
        const cur = ledger.receipt(it.id);
        if (!cur || activeInbox.get(it.id) || ledger.liveClaim(it.id)) continue;
        if (cur.deferred) {
          if (ledger.laneFull(chat)) { waiting.add(chat); continue; }
          ledger.undefer(it.id);
        }
        // under its OWN id: a tap's message, a v1 edit and a v1 id the migration had to rename would not key back to it
        try { const replay = receive(cur.message, { recovered: true }, it.id); if (replay) await replay.start(); }
        catch (e) {
          // a replay held by a ledger that cannot be written (LEDGER_HELD) stays pending, quietly: the hold is on the status line
          if (!(e && e.code === 'LEDGER_HELD')) { try { console.error('[' + channel + '] durable inbox recovery failed for ' + String(it.id || '') + ':', (e && e.message) || e); } catch (ce) { failNote('channels.hub.console', ce); } }
          break;
        }
      }
    } finally { recovering = false; }
  }
  // Recovery's own clock: a message left pending (processing threw, a deferred message whose chat drained) is replayed
  // within recoverMs even when the channel never reports another 'up'.
  let recoverTimer = null;
  function armRecover() {
    if (closed || recoverTimer) return;
    recoverTimer = setTimer(() => {
      recoverTimer = null;
      Promise.resolve().then(recoverInbox).catch(swallow('channels.hub.inbox.recover')).then(armRecover);
    }, recoverMs);
    if (recoverTimer && typeof recoverTimer.unref === 'function') recoverTimer.unref();
  }
  armRecover();

  // An 'up': the transport just proved a round-trip. Every lane of this channel retries now (its backoff reset; a
  // refused credential's hold lifted for the re-paired bot), and pending receipts replay.
  function up() {
    if (closed) return;
    ledger.kick(channel, { reset: true }).catch(swallow('channels.hub.lane.kick'));
    try { const p = recoverInbox(); if (p && typeof p.catch === 'function') p.catch(swallow('channels.hub.inbox.recover')); } catch (e) { failNote('channels.hub.inbox.recover', e); }
  }
  // drive every lane of this channel now (tests, and a caller that knows the transport is back)
  function drain() { return ledger.kick(channel); }

  // A chat that removed this bot (onMembership): it is marked dead and its queued replies are given up now, each said once.
  function dropBacklog(chatId, status) {
    const gone = ledger.markDead(chatKey(chatId), status || 'kicked');
    for (const t of gone) {
      try { emit('channel.delivery', { channel, chatId: String(chatId), runId: t.runId || '', ok: false, chunks: 0, reason: 'redelivery-gave-up' }); } catch (e) { failNote('channels.hub.delivery.emit', e); }
    }
    return gone.length;
  }
  // ...and it is back (it spoke, or the platform says the bot is a member again)
  function chatBack(chatId) { return ledger.clearDead(chatKey(chatId)); }

  function close() {
    closed = true;
    if (recoverTimer) { try { clearTimer(recoverTimer); } catch (e) { failNote('channels.hub.recover.timer', e); } recoverTimer = null; }
    detach();
    if (ownLedger) ledger.close();
  }

  return { deliver, onInbound, receive, inboxId, withInbox, inboxIdsOf, recoverInbox, activeInbox, markAttempt, held, settleNow, writable, settleWithNotice,
    stamp, askOpened, dropBacklog, chatBack, up, drain, close, notModified, ledger, editState, admitEdit, editReady };
}

module.exports = { makeHubDelivery, EPHEMERAL, RESTARTED_STAMP };
