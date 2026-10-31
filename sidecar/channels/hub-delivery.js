/* sidecar/channels/hub-delivery.js — a channel hub's DELIVERY: how its replies reach the chat, and how the messages it
   was handed are held until they are answered.

   Moved out of channels/hub.js (channel-delivery-ledger, S1) as a pure move: the same code in the same order, so every
   send, channel.delivery event and store write is the same (test/channels.delivery.golden.test.js pins both traces).
   One per hub, built by makeChannelHub over the hub's own seams:

     makeHubDelivery(ctx) -> { deliver, flushOutbox, scheduleOutboxRetry, kickOutbox, close, onInbound, inboxId,
                               withInbox, inboxIdsOf, recoverInbox, activeInbox, dropBacklog, notModified,
                               OUTBOX_ESCALATE_TRIES }
       ctx = { channel, store, send, editMessage, deleteMessage, scrubHostPaths, maxMessageLength, routeOpts,
               forgetThread, emit, routeInbound, setTimeout?, clearTimeout?, outboxRetryMs?, outboxRetryMaxMs? }
       deliver(chatId, text, runId, reason, agentId?, sendOpts?, seedId?) -> { ok, messageId, text }
                       chunk a reply (channels/chunk.js), send it on the chat's route, keep an undelivered remainder
                       in the store's outbox; throws (err.heldText) when the outbox refuses it
       flushOutbox / scheduleOutboxRetry / kickOutbox / close
                       the outbox's redelivery pass and its retry timer, stopped with the hub
       onInbound(msg, intake) -> the processing promise: the message's durable receipt is written before this returns
                       (the adapter acknowledges only then), and removed when routeInbound resolves
       recoverInbox()  replay the receipts no live run owns; dropBacklog(chatId) gives up a removed chat's queued replies

   Pure like the hub: every dependency is injected (no fs, no clock), and a failure it swallows is reported (failopen). */
'use strict';

const { note: failNote, swallow } = require('../failopen.js');
const { chunkTextParts, remainderOf } = require('./chunk.js');

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
  if (!store || typeof send !== 'function' || typeof routeInbound !== 'function' || typeof scrubHostPaths !== 'function'
      || typeof routeOpts !== 'function' || typeof forgetThread !== 'function' || typeof emit !== 'function') {
    throw new Error('makeHubDelivery: store, send, scrubHostPaths, routeOpts, forgetThread, emit and routeInbound are required');
  }
  // Durable replies must recover even when polling never drops. A separate outbound-only outage used to leave
  // the outbox parked forever unless another message happened to send successfully. The timer is injected for
  // deterministic tests, unref'd in production, and explicitly closed with the hub lifecycle.
  const setTimer = typeof c.setTimeout === 'function' ? c.setTimeout : setTimeout;
  const clearTimer = typeof c.clearTimeout === 'function' ? c.clearTimeout : clearTimeout;
  const outboxRetryMs = Number.isFinite(c.outboxRetryMs) ? Math.max(1, Number(c.outboxRetryMs)) : 5000;
  const outboxRetryMaxMs = Number.isFinite(c.outboxRetryMaxMs) ? Math.max(outboxRetryMs, Number(c.outboxRetryMaxMs)) : 60000;
  const notModified = (e) => /not modified/i.test(String(e || ''));

  // agentId (optional, last arg) names WHICH roster agent produced this reply, so the floor can pulse the RIGHT
  // agent's dish on a multi-agent station. Passed only for a real RUN reply (onInbound); administrative command
  // replies (/agents, /model…) omit it — no agent "produced" them, so the floor should not attribute a dish.
  // sendOpts (optional) rides ONLY on the FINAL chunk — a keyboard must land under the last thing the user
  // reads, and Telegram would otherwise render one set of buttons per chunk of a long reply. Returns the final
  // chunk's messageId too, which is what a keyboard needs in order to be edited/stripped once it is tapped.
  async function deliver(chatId, text, runId, reason, agentId, sendOpts, seedId) {
    // `send` is what goes on the wire; remainderOf(parts, at) rebuilds any undelivered REMAINDER from `raw` (see chunkTextParts — joining the
    // fence-doctored chunks bakes synthetic ``` markers into the stored text, re-fenced on every redelivery). The host
    // path scrub runs on the WHOLE text first: chunked, a path cut at the boundary would go out as two halves.
    const parts = chunkTextParts(scrubHostPaths(text), maxMessageLength);
    const chunks = parts.send;
    let ok = true, failedAt = -1, messageId = '', lastFail = null;
    // A message the stream already put in the chat. Chunk 0 REPLACES it rather than being sent again — that
    // replacement is the whole difference between "streamed" and "streamed, then repeated".
    let seed = (seedId && editMessage) ? String(seedId) : '';
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      // The route rides EVERY chunk (all of a split reply belongs in one topic) while the quote and the
      // keyboard each ride exactly one: the quote the first chunk, the keyboard the last. A fresh object every
      // time — the caller's sendOpts is theirs and must not grow a stale reply id.
      const rt = routeOpts(chatId, i === 0);
      const terminal = (last && sendOpts) ? sendOpts : null;
      const opts = (rt || terminal) ? Object.assign({}, terminal || {}, rt || {}) : undefined;
      let r;
      if (i === 0 && seed) {
        // Replace the streamed partial with the finished chunk. "message is not modified" means the text we
        // streamed was already the final text — a success wearing a 400.
        try { r = await editMessage(chatId, seed, chunks[0], opts || {}); } catch (e) { r = { ok: false, error: (e && e.message) || 'editMessage threw' }; }
        if (r && r.ok === false && notModified(r.error)) r = { ok: true, messageId: seed };
        if (!r || r.ok === false) {
          /* The partial is stranded: we cannot update it and we are about to send the real answer. Remove it
             first, or the member reads half an answer immediately above the whole one. The delete is
             best-effort — if it fails too, delivering the reply still matters more than the duplicate. */
          try { await deleteMessage(chatId, seed); } catch (e) { failNote('channels.hub.seed.delete', e); }
          seed = '';
          try { r = await send(chatId, chunks[0], opts); } catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
        } else if (!r.messageId) {
          r = { ok: true, messageId: seed };   // an edit answers with no id of its own; it is still that message
        }
      } else {
        try { r = await send(chatId, chunks[i], opts); } catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
      }
      if (r && r.threadGone) forgetThread(chatId);   // the topic is gone; stop aiming at it
      if (!r || r.ok === false) { ok = false; failedAt = i; lastFail = r || null; break; }
      if (last && r.messageId) messageId = String(r.messageId);
    }
    /* UNDELIVERABLE (quick win 22): the transport said this send can NEVER succeed (retryable:false — a 4xx such as
       "chat not found", "message is too long", "bot was blocked"). Queued, it failed identically on every flush and,
       sitting at the head of the outbox, stopped every pass before the replies queued behind it; held for an inbox
       replay, it would re-run the message only to fail again. It is parked: said once, never retried. An ABORTED
       send is our own transport being torn down, not the chat refusing — that one still queues. So does a refused
       CREDENTIAL (auth:true — every transport marks a 401 / revoked token): it is the whole channel failing, not this
       chat, every chat fails alike until the Commander re-pairs, and the re-paired hub's 'up' flushes the outbox to
       the same chats. Parking it would drop the one reply the outbox can still save (review of quick win 22). */
    const undeliverable = !ok && !!lastFail && lastFail.retryable === false && lastFail.auth !== true && String(lastFail.error || '') !== 'aborted';
    // DURABLE OUTBOX: a reply that failed to send used to be recorded (channel.delivery ok:false) and then
    // LOST — the agent did the work and the Commander never saw the result. Queue the undelivered remainder
    // (only the chunks that did NOT go out) in the store's bounded outbox; flushOutbox redelivers it when the
    // transport is proven healthy again (next successful delivery, or the adapter's next 'up' status). Command
    // replies (/help, /agents…) are ephemeral and stay fire-and-forget — a stale command menu hours later is
    // noise, not a lost result. Guarded on pushOutbox so hubs built over older/test stores behave as before.
    // 'prompt' joins 'command' as ephemeral: a permission ask whose keyboard failed to send is answered by the
    // host's fail-closed timer within seconds — redelivering that dead question hours later would invite a tap
    // on a run that ended long ago.
    // …unless the chat is KNOWN unreachable. Queueing for a chat that blocked us is not resilience, it is a
    // pile of retries that can only ever fail — and every one of them is an API call. See onMembership (hub.js).
    // Read the record only on the failure path: this runs on every delivered message, and the happy path must
    // not pay a store read to answer a question that only matters when a send has already failed.
    let unreachable = false;
    if (!ok) {
      try { const r0 = typeof store.getChatRecord === 'function' ? store.getChatRecord(String(chatId)) : null; unreachable = !!(r0 && r0.unreachable); } catch (e) { failNote('channels.hub.unreachable.read', e); }
    }
    if (!ok && unreachable) {
      try { console.error('[' + channel + '] reply for chat ' + chatId + ' NOT queued — this chat has blocked or removed the bot'); } catch (e) { failNote('channels.hub.console', e); }
    } else if (undeliverable) {
      try { console.error('[' + channel + '] reply for chat ' + chatId + ' is undeliverable and was NOT queued: ' + String(lastFail.error || 'refused').slice(0, 200)); } catch (e) { failNote('channels.hub.console', e); }
    }
    const mustPersistFailure = !ok && !unreachable && !undeliverable && reason !== 'command' && reason !== 'prompt' && typeof store.pushOutbox === 'function';
    let failurePersisted = false;
    let failurePersistError = null;
    if (mustPersistFailure) {
      try {
        const remainder = '⌛ delayed reply — the channel was unreachable when this was first sent:\n' + remainderOf(parts, failedAt);
        store.pushOutbox({ channel: channel, chatId: String(chatId), text: remainder, runId: runId || '', agentId: agentId ? String(agentId) : '', reason: reason || '' });
        failurePersisted = true;
        scheduleOutboxRetry();
      } catch (e) { failurePersistError = e; }
    }
    const ev = { channel, chatId: String(chatId), runId: runId || '', ok, chunks: chunks.length, reason: undeliverable ? 'undeliverable' : (reason || '') };
    if (agentId) ev.agentId = String(agentId);   // additive/optional — attribute the dish to the acting agent
    try { emit('channel.delivery', ev); } catch (e) { failNote('channels.hub.delivery.emit', e); }
    if (ok) { try { kickOutbox(); } catch (e) { failNote('channels.hub.outbox.kick', e); } }   // a proven-healthy send is the cue to drain any backlog
    // The adapter acknowledged this message only after its durable INBOX receipt existed. If the failed answer
    // cannot enter the outbox, reject processing so that receipt remains and replays once capacity returns.
    // `heldText` is the remainder the outbox refused: processInbound keeps it on that receipt (deliverHeld), so the
    // replay sends this finished answer instead of running the message a second time.
    if (mustPersistFailure && !failurePersisted) {
      const err = new Error('failed reply could not be persisted: ' + ((failurePersistError && failurePersistError.message) || 'outbox unavailable'));
      err.heldText = remainderOf(parts, failedAt);
      throw err;
    }
    // `text` is the FINAL chunk's text — the one a keyboard was attached to, and therefore the exact string a
    // later editMessage must rebuild on top of when it stamps the chosen answer in place.
    return { ok: ok, messageId: messageId, text: chunks.length ? chunks[chunks.length - 1] : '' };
  }

  // ---- durable-outbox flush: redeliver queued replies once the transport is healthy ----------------------
  // Triggered by (a) the adapter reporting 'up' (reconnect/restart recovery) and (b) any successful deliver
  // (covers a mid-session send failure while the poll status never dropped). One pass at a time; a failed
  // redelivery bumps the item's try-count and STOPS the pass (transport clearly still shaky) — the item is
  // Retained until delivery succeeds or Telegram proves the chat unreachable. At five failures we emit one
  // escalation event, but keep retrying at the capped cadence — a two-minute outage must not become message loss.
  const OUTBOX_ESCALATE_TRIES = 5;
  let flushing = false;
  let outboxTimer = null;
  let closed = false;
  function pendingOutbox() {
    try { return typeof store.loadOutbox === 'function' ? (store.loadOutbox(channel) || []) : []; }
    catch (e) { failNote('channels.hub.outbox.load', e); return []; }
  }
  function scheduleOutboxRetry() {
    if (closed || outboxTimer || typeof store.loadOutbox !== 'function') return;
    const items = pendingOutbox();
    if (!items.length) return;
    const tries = Math.max(0, Number(items[0] && items[0].tries) || 0);
    const delay = Math.min(outboxRetryMs * Math.pow(2, Math.min(tries, 8)), outboxRetryMaxMs);
    outboxTimer = setTimer(() => {
      outboxTimer = null;
      Promise.resolve(flushOutbox()).catch(swallow('channels.hub.outbox.flush'));
    }, delay);
    if (outboxTimer && typeof outboxTimer.unref === 'function') outboxTimer.unref();
  }
  function kickOutbox() {
    if (closed) return;
    if (outboxTimer) { try { clearTimer(outboxTimer); } catch (e) { failNote('channels.hub.outbox.timer', e); } outboxTimer = null; }
    const p = flushOutbox();
    if (p && typeof p.catch === 'function') p.catch(swallow('channels.hub.outbox.flush'));
  }
  async function flushOutbox() {
    if (closed || flushing || typeof store.loadOutbox !== 'function') return;
    flushing = true;
    try {
      const items = store.loadOutbox(channel);
      for (const it of items) {
        // A chat that blocked us cannot be redelivered to. onMembership already drops its backlog, but a flush
        // racing that drop would otherwise spend a failed send per item and then stop the whole pass.
        let dead = false;
        try { const r0 = typeof store.getChatRecord === 'function' ? store.getChatRecord(String(it.chatId)) : null; dead = !!(r0 && r0.unreachable); } catch (e) { failNote('channels.hub.unreachable.read', e); }
        if (dead) { try { store.removeOutbox(it.id); } catch (e) { failNote('channels.hub.outbox.remove', e); } continue; }
        const parts = chunkTextParts(scrubHostPaths(it.text), maxMessageLength);   // whole text first, as deliver() does
        const chunks = parts.send;
        let ok = true, sentUpTo = 0;
        for (let ci = 0; ci < chunks.length; ci++) {
          let r;
          // Thread only, never the quote: a delayed reply still belongs in its topic, but the message it was
          // answering is hours old and quoting it now would read as a bot talking to the past.
          try { r = await send(it.chatId, chunks[ci], routeOpts(it.chatId, false) || undefined); } catch (e) { r = { ok: false }; }
          if (!r || r.ok === false) { ok = false; break; }
          sentUpTo = ci + 1;
        }
        if (ok) {
          try { store.removeOutbox(it.id); } catch (e) { failNote('channels.hub.outbox.remove', e); }
          const ev = { channel, chatId: String(it.chatId), runId: it.runId || '', ok: true, chunks: chunks.length, reason: 'redelivered' };
          if (it.agentId) ev.agentId = String(it.agentId);
          try { emit('channel.delivery', ev); } catch (e) { failNote('channels.hub.delivery.emit', e); }
          continue;
        }
        // PROGRESS: chunks the member already received must never be re-sent — a flaky transport used to
        // replay the first two-thirds of a long answer on every retry pass. The remainder is rebuilt from
        // the RAW (undecorated) splits: joining the fence-doctored send chunks baked reopenFences's
        // synthetic ``` markers into the stored text, which the next pass re-fenced — stray fence lines
        // growing per retry on every long code-bearing reply.
        if (sentUpTo > 0 && typeof store.replaceOutboxText === 'function') {
          try { store.replaceOutboxText(it.id, remainderOf(parts, sentUpTo)); } catch (e) { failNote('channels.hub.outbox.progress', e); }
        }
        // A pass that delivered real chunks is PROGRESS, not another failed attempt — it must not count
        // toward the escalation ceiling, or a long message advancing one chunk per pass reads as failing.
        let bumped = null;
        if (sentUpTo === 0) {
          try { bumped = (typeof store.bumpOutboxTry === 'function') ? store.bumpOutboxTry(it.id) : null; } catch (e) { failNote('channels.hub.outbox.bump', e); }
        }
        if (bumped && bumped.tries === OUTBOX_ESCALATE_TRIES) {
          try { emit('channel.delivery', { channel, chatId: String(it.chatId), runId: it.runId || '', ok: false, chunks: 0, reason: 'redelivery-delayed' }); } catch (e) { failNote('channels.hub.delivery.emit', e); }
          try { console.error('[' + channel + '] outbox item for chat ' + it.chatId + ' still delayed after ' + OUTBOX_ESCALATE_TRIES + ' attempts; retained for retry'); } catch (e) { failNote('channels.hub.console', e); }
        }
        break;   // transport still unhealthy — end this pass; the next healthy cue retries
      }
    } finally {
      flushing = false;
      if (pendingOutbox().length) scheduleOutboxRetry();
      else {
        // Capacity is back. Replay intake deliberately held when a saturated outbox could not accept its reply.
        try { const p = recoverInbox(); if (p && typeof p.catch === 'function') p.catch(swallow('channels.hub.inbox.recover')); } catch (e) { failNote('channels.hub.inbox.recover', e); }
      }
    }
  }

  function close() {
    closed = true;
    if (outboxTimer) { try { clearTimer(outboxTimer); } catch (e) { failNote('channels.hub.outbox.timer', e); } outboxTimer = null; }
  }

  const activeInbox = new Map();   // durable inbox id -> the one live processing promise (dedupes restart races)
  function inboxId(msg) {
    if (!msg || msg.messageId == null || String(msg.messageId) === '') return '';
    return channel + '|' + String(msg.chatId) + '|' + String(msg.messageId) + (msg.edited ? '|edited' : '');
  }
  function onInbound(msg, intake) {
    const id = inboxId(msg);
    // Older/test stores retain the original behavior. Production's store claim is synchronous and durable,
    // so returning from this function is the exact point the adapter may safely advance Telegram's offset.
    if (!id || typeof store.pushInbox !== 'function' || typeof store.removeInbox !== 'function') return routeInbound(msg, intake);
    // this hub's own claim first, then the store's: a hub this one REPLACED (a reconnect) may still be running it
    const shared = typeof store.liveInbox === 'function' && typeof store.holdInbox === 'function';
    const live = activeInbox.get(id) || (shared ? store.liveInbox(id) : null);
    if (live) {
      if (intake && typeof intake.onAccepted === 'function') { try { intake.onAccepted({ id, durable: true, duplicate: true }); } catch (e) { failNote('channels.hub.intake.accepted', e); } }
      return live;
    }
    const receipt = store.pushInbox({ id: id, channel: channel, message: msg });   // throws synchronously -> adapter does NOT ack
    if (intake && typeof intake.onAccepted === 'function') { try { intake.onAccepted({ id, durable: true }); } catch (e) { failNote('channels.hub.intake.accepted', e); } }
    // A receipt that already carries an attempt is a RE-DELIVERY of work whose run had started — from recoverInbox,
    // or Telegram handing the same update over again. processInbound decides what that may do (attemptOf, heldOf).
    const routed = withInbox(intake, [id], attemptOf(receipt), heldOf(receipt));
    const running = Promise.resolve().then(() => routeInbound(msg, routed)).then((value) => {
      store.removeInbox(id);   // reply delivered OR its undelivered remainder is now durable in the outbox
      return value;
    }).finally(() => { activeInbox.delete(id); });
    activeInbox.set(id, running);
    if (shared) store.holdInbox(id, running);
    return running;
  }

  /* RECOVERY KNOWS HOW FAR THE RUN GOT (e5ecd6b8, 2026-10-21). The `recovered` flag had no reader: a crash after the
     run had appended a line to a file replayed the whole message as a second identical user turn, the line went in
     twice, and the chat was told "Appended one line". The durable receipt now carries an attempt marker
     (store.markInbox: the run's id once it starts, a count of the tool steps it began), and a re-delivered receipt
     is handled by what that proves, the same split the station's own run recovery makes (COMMS continues a run only
     when nothing uncertain happened, and asks first otherwise):
       no attempt              -> never reached a run: replay it as before
       attempt, 0 tool steps   -> nothing could have happened: run it again, said so, without a second copy of the turn
       attempt, N tool steps   -> something may already be done: do NOT run it again; tell the chat, and leave the next
                                  run in this chat a one-shot note (interruptedAttempt) so a "continue" finishes only
                                  what is left
     The intake copy carries every receipt this message stands for (a merged text batch or album is one run over several
     receipts), so the marker lands on all of them.
     ONLY A REAL RESTART GETS THE CRASH RULE (review, 2026-10-21). A receipt also comes back inside the SAME process:
     the full outbox refused a finished reply (flushOutbox -> recoverInbox replays it once capacity returns), or
     processing threw. Taking that for a crash told the chat "StarNet restarted" when nothing restarted, and — with a
     tool step counted — never delivered the answer the run had finished. So the attempt carries the store's bootId:
     an attempt from THIS process is no restart and replays as before; and a finished reply the outbox refused is kept
     on the receipt (held) and delivered by the replay, whatever process it lands in, without running anything. */
  function attemptOf(receipt) {
    const a = receipt && receipt.attempt;
    if (!a || typeof a !== 'object' || !String(a.runId || '')) return null;
    const here = (store && store.bootId != null) ? String(store.bootId) : '';
    if (here && String(a.boot || '') === here) return null;   // this process left it pending: not a restart
    return { runId: String(a.runId), tools: Math.max(0, Math.floor(Number(a.tools) || 0)) };
  }
  function heldOf(receipt) {
    const h = receipt && receipt.held;
    if (!h || typeof h !== 'object' || typeof h.text !== 'string') return null;
    return { text: h.text, runId: String(h.runId || ''), reason: String(h.reason || ''), agentId: String(h.agentId || ''),
      ids: Array.isArray(h.ids) ? h.ids.filter(x => typeof x === 'string' && x) : [] };
  }
  function withInbox(intake, ids, prior, held) {
    const out = Object.assign({}, intake || {}, { inboxIds: ids.slice() });
    if (prior) out.priorAttempt = prior;
    else delete out.priorAttempt;
    if (held) out.heldReply = held;
    else delete out.heldReply;
    return out;
  }
  function inboxIdsOf(intake) {
    return (intake && Array.isArray(intake.inboxIds)) ? intake.inboxIds.filter(x => typeof x === 'string' && x) : [];
  }

  let recoveringInbox = false;
  async function recoverInbox() {
    if (closed || recoveringInbox || typeof store.loadInbox !== 'function') return;
    recoveringInbox = true;
    try {
      const items = store.loadInbox(channel) || [];
      for (const it of items) {
        if (closed || !it || !it.message) break;
        /* THE SNAPSHOT GOES STALE WHILE WE AWAIT. A live item's onInbound hands back its RUNNING promise, so this
           loop can park behind a whole run while a later item (a follow-up steered into that run, a /routine add
           typed meanwhile) finishes on its own path and leaves the inbox — replaying it from this list then ran it
           a second time (2026-10-20). Replay only what is still durably pending right now. */
        let pending = true;
        try { pending = (store.loadInbox(channel) || []).some(x => x && x.id === it.id); } catch (e) { failNote('channels.hub.inbox.load', e); pending = true; }
        if (!pending) continue;
        try { await onInbound(it.message, { recovered: true }); }
        catch (e) { try { console.error('[' + channel + '] durable inbox recovery failed for ' + String(it.id || '') + ':', (e && e.message) || e); } catch (ce) { failNote('channels.hub.console', ce); } break; }
      }
    } finally { recoveringInbox = false; }
  }

  // A chat that removed this bot (onMembership): its queued replies are given up now, each said once.
  function dropBacklog(chatId) {
    if (typeof store.loadOutbox !== 'function' || typeof store.removeOutbox !== 'function') return;
    let items = [];
    try { items = store.loadOutbox(channel) || []; } catch (e) { failNote('channels.hub.outbox.load', e); items = []; }
    for (const it of items) {
      if (String(it.chatId) !== chatId) continue;
      try { store.removeOutbox(it.id); } catch (e) { failNote('channels.hub.outbox.remove', e); }
      try { emit('channel.delivery', { channel, chatId: chatId, runId: it.runId || '', ok: false, chunks: 0, reason: 'redelivery-gave-up' }); } catch (e) { failNote('channels.hub.delivery.emit', e); }
    }
  }

  return { deliver, flushOutbox, scheduleOutboxRetry, kickOutbox, close, onInbound, inboxId, withInbox, inboxIdsOf, recoverInbox,
    activeInbox, dropBacklog, notModified, OUTBOX_ESCALATE_TRIES };
}

module.exports = { makeHubDelivery };
