/* node test/channels.telegram.updates.test.js — N6/N7/N8 + my_chat_member: the update kinds the bot was deaf
   to, and the cheapest acknowledgement there is (2026-07-29).

   `ALLOWED_UPDATES` is a SUBSCRIPTION, not a filter. It named two kinds, so three real things were structurally
   invisible:

     · AN EDIT CHANGED NOTHING. You fix a typo and the bot goes on answering the typo.
     · A BROADCAST CHANNEL WAS SILENCE. Added as an admin, the bot never received a single post.
     · BEING BLOCKED OR KICKED WAS UNDETECTABLE. The notifier kept posting into a chat that could not receive
       it, every send failed, and every failure queued another retry.

   And one thing that was never there at all: a reaction ack — 👀 on the question while the run thinks, cleared
   when the answer lands. It costs one API call, adds nothing to scroll past, and unlike the typing bubble it is
   still there when the member comes back twenty minutes later.

   THE ONE THAT COULD HAVE BEEN A LOOP: a channel post carries no `from`, so `is_bot` cannot tell the bot's own
   post from an admin's. Unguarded, every reply becomes a new question. The guard is by message id, not sender.

   Fakes only: no network, no clock. */
'use strict';
const A = require('./_assert.js');
const { normalize } = require('../sidecar/channels/telegram.js');
const { makeChannelAdapter } = require('../sidecar/channels/adapter.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makeTelegramTransport, ALLOWED_UPDATES } = require('../sidecar/channels/telegram.transport.js');

const DM = { id: 111, type: 'private' };
const CHAN = { id: -100500, type: 'channel' };
const ME = { id: 5, username: 'andro' };

function recFetch(queue) {
  const calls = [];
  const q = (queue || []).slice();
  const impl = async (url, init) => {
    const method = String(url).split('/').pop();
    let body = init && init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) {} }
    calls.push({ method, body });
    const next = q.length ? q.shift() : { ok: true, result: { message_id: 42 } };
    return { ok: next.ok !== false, status: next.status || 200, async json() { return next; }, headers: { get: () => null } };
  };
  impl.calls = calls;
  return impl;
}

// a store with no delivery ledger of its own: the hub keeps its replies in a private, in-memory one (hub._internals.ledger)
function fakeStore() {
  const hist = new Map(), recs = new Map();
  return {
    recs,
    loadHistory: (a) => (hist.get(a) || []).slice(),
    appendTurn: (a, role, content) => { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; },
    getChatRecord: (c) => recs.get(String(c)),
    saveChatRecord: (c, patch) => { const r = Object.assign({}, recs.get(String(c)) || {}, patch); recs.set(String(c), r); return r; }
  };
}
const idGen = () => { let i = 0; return () => 'run' + (++i); };
const okRun = (sink) => async (o) => {
  if (sink) sink.last = o;
  o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
  o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' });
  o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
};

async function run() {
  // ---- A. the subscription itself ----
  {
    A.eq(ALLOWED_UPDATES.indexOf('edited_message') !== -1, true, 'edits are subscribed — an unnamed kind is never DELIVERED, not merely ignored');
    A.eq(ALLOWED_UPDATES.indexOf('channel_post') !== -1, true, 'channel posts are subscribed');
    A.eq(ALLOWED_UPDATES.indexOf('edited_channel_post') !== -1, true, 'and their edits');
    A.eq(ALLOWED_UPDATES.indexOf('my_chat_member') !== -1, true, 'so is our own membership — blocked/kicked was invisible');
    A.eq(ALLOWED_UPDATES.indexOf('message_reaction'), -1, 'we SET reactions; hearing other people\'s would be traffic with no consumer');
    const f = recFetch([{ ok: true, result: [] }]);
    await makeTelegramTransport({ fetch: f, token: '1:a' }).getUpdates({ offset: 0, timeoutSec: 1 });
    A.eq(f.calls[0].body.allowed_updates.length, ALLOWED_UPDATES.length, 'and the list actually reaches getUpdates');
  }

  // ---- B. normalize parses all four message-shaped kinds, plus membership ----
  {
    const ed = normalize({ update_id: 1, edited_message: { message_id: 9, text: 'fixed', chat: DM, from: ME } });
    A.eq(ed.message.text, 'fixed', 'an edited message parses like any other');
    A.eq(ed.message.edited, true, 'and is FLAGGED, so the policy question is answered once, downstream');
    A.eq('edited' in normalize({ update_id: 2, message: { message_id: 9, text: 'x', chat: DM, from: ME } }).message, false, 'an ordinary message carries no edited key (additive only)');

    const post = normalize({ update_id: 3, channel_post: { message_id: 3, text: 'news', chat: CHAN, sender_chat: { id: CHAN.id }, author_signature: 'Ed' } });
    A.eq(post.message.text, 'news', 'a broadcast post is heard at all — it used to be total silence');
    A.eq(post.message.channelPost, true, 'and is flagged as a post');
    A.eq(post.message.chatType, 'group', 'a channel is not a DM, so it needs the chat allowlist like any group');
    A.eq(post.message.userName, 'Ed', 'a post has no `from`, so the author_signature is the only name available — better than nobody');
    A.eq(post.message.userId, undefined, 'and there is genuinely no user id to invent');
    A.eq(normalize({ update_id: 4, edited_channel_post: { message_id: 3, text: 'fixed', chat: CHAN } }).message.edited, true, 'an edited post is both a post and an edit');

    const mem = normalize({ update_id: 5, my_chat_member: { chat: { id: -1001, type: 'supergroup' }, from: { id: 7 }, new_chat_member: { status: 'kicked' } } });
    A.eq(mem.membership.status, 'kicked', 'our own membership change parses');
    A.eq(mem.membership.chatId, -1001, 'with the chat it happened in');
    A.eq(mem.membership.byUserId, '7', 'and who did it');
    A.eq('message' in mem, false, 'it is a third shape — neither a message nor a callback, because the consumer is a store write, not a run');
    A.eq(normalize({ update_id: 6, my_chat_member: { chat: { id: -1001 } } }).message, null, 'a membership update with no status advances the offset and delivers nothing');
  }

  // ---- C. THE ECHO GUARD: the bot must never answer its own post ----
  {
    const got = [];
    const ad = makeChannelAdapter({
      transport: { getUpdates: async () => [], send: async () => ({ ok: true, messageId: '77' }) },
      normalize: (r) => r, name: 'telegram', clock: { now: () => 1 },
      allowedChats: ['-100500'], ownerUserId: '5', requireMention: false,
      onInbound: (im) => got.push(im)
    });
    await ad.send('-100500', 'my answer');
    // Telegram hands a channel post back with no `from` at all — is_bot cannot save us here.
    ad._internals.dispatch({ offset: 1, message: { chatId: -100500, chatType: 'group', text: 'my answer', messageId: '77', channelPost: true } });
    A.eq(got.length, 0, 'our OWN post, echoed back, is refused — unguarded this is not a cosmetic bug, it is an unbounded loop');
    ad._internals.dispatch({ offset: 2, message: { chatId: -100500, chatType: 'group', text: 'a real post', messageId: '78', channelPost: true } });
    A.eq(got.length, 1, 'somebody else\'s post still gets through');
    A.eq(got[0].channelPost, true, 'and is flagged as a broadcast post');

    // SUBSCRIBING TO A KIND MUST NOT OPEN A SURFACE. A channel is not a DM, so it needs the chat allowlist like
    // any group — and an empty allowlist admits no group at all. Hearing channel posts can therefore never make
    // the bot start talking somewhere the member did not put it.
    ad._internals.dispatch({ offset: 3, message: { chatId: -999999, chatType: 'group', text: 'a post from elsewhere', messageId: '1', channelPost: true } });
    A.eq(got.length, 1, 'a post from a chat that is not on the allowlist is refused — the new subscription is fail-closed');

    // the same id in a DIFFERENT chat is a different message
    const ad2 = makeChannelAdapter({
      transport: { getUpdates: async () => [], send: async () => ({ ok: true, messageId: '77' }) },
      normalize: (r) => r, name: 'telegram', clock: { now: () => 1 },
      allowedChats: ['-1', '-2'], requireMention: false, onInbound: () => { ad2hits++; }
    });
    let ad2hits = 0;
    await ad2.send('-1', 'x');
    ad2._internals.dispatch({ offset: 1, message: { chatId: -2, chatType: 'group', text: 'y', messageId: '77' } });
    A.eq(ad2hits, 1, 'the guard is keyed by chat AND id — message ids are only unique within a chat');

    // bounded: it is a recent-echo guard, not a transcript
    const { rememberSent, sentIds, MAX_SENT_IDS, wasOurs } = ad._internals;
    for (let i = 0; i < MAX_SENT_IDS + 20; i++) rememberSent('-9', 'm' + i);
    A.eq(sentIds.size <= MAX_SENT_IDS, true, 'the set is bounded');
    A.eq(wasOurs('-9', 'm' + (MAX_SENT_IDS + 19)), true, 'the most recent send is still remembered');
  }

  // ---- D. membership reaches its consumer, ungated ----
  {
    const seen = [];
    const ad = makeChannelAdapter({
      transport: { getUpdates: async () => [], send: async () => ({ ok: true }) },
      normalize: (r) => r, name: 'telegram', clock: { now: () => 7 },
      allowedChats: ['-1001'], ownerUserId: '5',
      onInbound: () => {}, onMembership: (ev) => seen.push(ev)
    });
    ad._internals.dispatch({ offset: 1, membership: { chatId: -4242, chatType: 'group', status: 'kicked', byUserId: '7' } });
    A.eq(seen.length, 1, '"you were kicked out of chat X" is reported even though that chat is not whitelisted — a chat that just removed us can hardly prove it is allowed to say so');
    A.eq(seen[0].chatId, '-4242', 'with the chat id as a string, like every other neutral field');
    A.eq(seen[0].status, 'kicked', 'and the status');
    A.eq(seen[0].ts, 7, 'stamped from the injected clock');
  }

  // ---- E. AN EDIT IS ONLY A QUESTION IF IT EDITS THE LAST THING WE HEARD ----
  {
    const sink = {};
    const runs = [];
    const hub = makeChannelHub({
      runOnce: async (o) => { runs.push(o); return okRun(sink)(o); }, store: fakeStore(),
      send: () => Promise.resolve({ ok: true, messageId: 'x' }), secrets: () => ({ key: 'k', model: 'm' }),
      classify: () => false, newId: idGen()
    });
    const msg = (extra) => Object.assign({ channel: 'telegram', chatId: '900', chatType: 'dm', userId: '5', text: 'hello', messageId: '1', ts: 1 }, extra);

    // an edit for a chat we have never heard from: we cannot tell an ancient edit from a fresh one
    await hub.onInbound(msg({ edited: true, chatId: '901' }));
    A.eq(runs.length, 0, 'an edit with no prior record starts NO run — inventing one is worse than doing nothing');

    await hub.onInbound(msg({ text: 'whats teh weather' }));
    A.eq(runs.length, 1, 'the original message runs');
    await hub.onInbound(msg({ text: 'what is the weather', edited: true }));
    A.eq(runs.length, 2, 'editing the LAST message re-runs — this is the case people actually hit');
    const turn = String(runs[1].messages[runs[1].messages.length - 1].content);
    A.ok(/what is the weather/.test(turn), 'the corrected text is what reaches the model');
    A.ok(/was edited/.test(turn) && /replacing what came before/.test(turn),
      'and it is labelled a correction — the original is already in history, and two near-identical turns read as the member saying two different things');

    await hub.onInbound(msg({ text: 'a second question', messageId: '2' }));
    A.eq(runs.length, 3, 'a new message runs');
    await hub.onInbound(msg({ text: 'tidying an old typo', messageId: '1', edited: true }));
    A.eq(runs.length, 3, 'editing an OLDER message runs nothing — that is somebody tidying history, not asking again');
  }

  // ---- F. THE REACTION ACK ----
  {
    const acks = [];
    const hub = makeChannelHub({
      runOnce: okRun({}), store: fakeStore(), send: () => Promise.resolve({ ok: true, messageId: 'x' }),
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      setReaction: (chatId, messageId, emoji) => { acks.push({ chatId, messageId, emoji }); return Promise.resolve({ ok: true }); }
    });
    await hub.onInbound({ channel: 'telegram', chatId: '900', chatType: 'dm', userId: '5', text: 'hi', messageId: '31', ts: 1 });
    await new Promise(r => setImmediate(r));   // the clear is deliberately fire-and-forget
    A.eq(acks.length, 2, 'exactly two calls: one to mark the question, one to unmark it');
    A.eq(acks[0].messageId, '31', 'the mark goes on the QUESTION, not on our own reply');
    A.eq(acks[0].emoji, hub._internals.ACK_EMOJI, 'with the fixed emoji — bots may only use Telegram\'s allowed reaction set, so this is a constant, not a setting');
    A.eq(acks[1].emoji, '', 'and is cleared when the answer lands — an ack that outlives its answer is a lie about what is running');

    // a channel that cannot react loses nothing else
    const noReact = makeChannelHub({
      runOnce: okRun({}), store: fakeStore(), send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }),
      classify: () => false, newId: idGen()
    });
    await noReact.onInbound({ channel: 'discord', chatId: '900', chatType: 'dm', userId: '5', text: 'hi', messageId: '31', ts: 1 });
    A.ok(true, 'a hub with no setReaction wired runs to completion untouched');

    // the clear must not overtake its own set, or the 👀 sticks forever on an answered question
    const order = [];
    let releaseSet = null;
    const slow = makeChannelHub({
      runOnce: okRun({}), store: fakeStore(), send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }),
      classify: () => false, newId: idGen(),
      setReaction: (c, m, emoji) => {
        if (emoji) return new Promise(res => { releaseSet = () => { order.push('set'); res({ ok: true }); }; });
        order.push('clear'); return Promise.resolve({ ok: true });
      }
    });
    await slow.onInbound({ channel: 'telegram', chatId: '900', chatType: 'dm', userId: '5', text: 'hi', messageId: '31', ts: 1 });
    A.eq(order.length, 0, 'with the set still in flight, nothing has been cleared yet');
    releaseSet();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    A.eq(order.join(','), 'set,clear', 'the clear waits for the set — otherwise it lands first and the mark is left behind forever');

    // a failed set is never "cleared" (there is nothing there to clear)
    const failed = [];
    const bad = makeChannelHub({
      runOnce: okRun({}), store: fakeStore(), send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }),
      classify: () => false, newId: idGen(),
      setReaction: (c, m, e) => { failed.push(e); return Promise.resolve({ ok: false, error: 'no permission' }); }
    });
    await bad.onInbound({ channel: 'telegram', chatId: '900', chatType: 'dm', userId: '5', text: 'hi', messageId: '31', ts: 1 });
    await new Promise(r => setImmediate(r));
    A.eq(failed.length, 1, 'a bot without the react permission tries once and never issues a pointless clear');
  }

  // ---- G. BLOCKED OR KICKED: the detection lands WITH its consumer, the delivery ledger (channel-delivery-ledger S2) ----
  // The mark lives in the ledger under '<channel>|<chatId>' (a Telegram block never touches a Discord chat with the same
  // id) and is no longer the shared chat record's `unreachable` flag. It gives the queued backlog up at once, and it never
  // stops a later attempt: a later reply gets one send, a failure then gives it up, a success clears the mark.
  {
    const store = fakeStore();
    const events = [];
    let failSend = false;
    const hub = makeChannelHub({
      runOnce: okRun({}), store,
      send: () => Promise.resolve(failSend ? { ok: false, error: 'Bad Gateway', retryable: true } : { ok: true, messageId: 'x' }),
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      emit: (name, ev) => events.push({ name, ev }),
      setTimeout: () => ({ unref() {} }), clearTimeout: () => {}   // a lane's retry never fires here
    });
    const ledger = hub._internals.ledger;
    const queued = () => ledger.deliveries().map(d => d.chatId);

    // a reply that fails while the chat is still believed reachable is kept, as before
    failSend = true;
    await hub._internals.deliver('900', 'the answer', 'r1', 'run');
    await hub._internals.deliver('901', 'another chat\'s answer', 'r2', 'run');
    A.eq(queued(), ['900', '901'], 'both undelivered replies are kept in their chats\' lanes');

    // …then chat 900 blocks us
    hub.onMembership({ channel: 'telegram', chatId: '900', chatType: 'dm', status: 'kicked', ts: 1 });
    A.ok(!!ledger.chat('telegram|900').dead, 'the chat is marked dead — a stamped fact WITH a reader, not without one');
    A.eq(store.recs.get('900'), undefined, 'and the shared chat record is not written (its old unreachable flag stays for an older build)');
    A.eq(queued(), ['901'], 'its queued backlog is given up: retrying a chat that blocked us is an API call that can only fail; no other chat is touched');
    A.eq(ledger.tombstones('telegram').map(t => [t.id, t.reason]), [['reply:r1', 'redelivery-gave-up']], 'the given-up reply is a tombstone');
    A.eq(events.filter(e => e.name === 'channel.delivery' && e.ev.reason === 'redelivery-gave-up').length, 1,
      'the drop is reported on the EXISTING delivery event — the same fact a repeatedly-failed item reports, so no new name is invented in the owned events contract');

    // a later reply still gets ONE send (the mark never stops a transport attempt); its failure gives it up, never piles retries
    const sendsBefore = events.filter(e => e.name === 'channel.delivery').length;
    await hub._internals.deliver('900', 'a later answer', 'r3', 'run');
    A.eq(queued(), ['901'], 'a failed send to a dead chat is not kept for retry');
    A.eq(events.filter(e => e.name === 'channel.delivery').slice(sendsBefore).map(e => e.ev.reason), ['redelivery-gave-up'], 'it was attempted once and given up');

    // being added/promoted is the platform saying we are back: the mark clears (a quiet chat no longer stays marked)
    hub.onMembership({ channel: 'telegram', chatId: '900', chatType: 'dm', status: 'member', ts: 1 });
    A.eq(ledger.chat('telegram|900').dead, null, 'a member/administrator/creator/restricted status clears the mark');
    hub.onMembership({ channel: 'telegram', chatId: '901', chatType: 'group', status: 'administrator', ts: 1 });
    A.eq(store.recs.get('901'), undefined, 'a promotion writes nothing to the chat record');

    // and they can come back by SPEAKING, which is proof where a my_chat_member we may never get is not
    hub.onMembership({ channel: 'telegram', chatId: '900', chatType: 'dm', status: 'kicked', ts: 1 });
    failSend = false;
    await hub.onInbound({ channel: 'telegram', chatId: '900', chatType: 'dm', userId: '5', text: 'hi again', messageId: '50', ts: 1 });
    A.eq(ledger.chat('telegram|900').dead, null, 'the chat speaking again lifts the mark — a stale one would give up this chat\'s replies forever');
  }

  // ---- H. the reaction wire shape ----
  {
    const f = recFetch();
    const t = makeTelegramTransport({ fetch: f, token: '1:a' });
    await t.setReaction('900', '31', '👀');
    A.eq(f.calls[0].method, 'setMessageReaction', 'the Bot API method');
    A.eq(JSON.stringify(f.calls[0].body.reaction), JSON.stringify([{ type: 'emoji', emoji: '👀' }]), 'a reaction is an ARRAY of typed entries, not a bare string');
    await t.setReaction('900', '31', '');
    A.eq(JSON.stringify(f.calls[1].body.reaction), '[]', 'and an empty array is how you clear');
    const f2 = recFetch([{ ok: false, error_code: 400, description: 'Bad Request: REACTION_INVALID' }]);
    const r = await makeTelegramTransport({ fetch: f2, token: '1:a' }).setReaction('900', '31', '🫠');
    A.eq(r.ok, false, 'a rejected emoji fails quietly');
    A.ok(!/\n/.test(String(r.error)), 'with a one-line reason the caller can log');
  }

  /* ---- I. A DEAD TOPIC MUST BE FORGOTTEN, NOT JUST DUCKED AROUND ------------------------------------------
     The transport already saves the message by resending to the chat root. If the hub keeps the dead thread id,
     every later send repeats that failed call and its retry. */
  {
    const sent = [];
    const hub = makeChannelHub({
      runOnce: okRun({}), store: fakeStore(),
      send: (chatId, text, opts) => {
        sent.push(opts || {});
        // first send: the transport had to drop the topic to deliver at all
        return Promise.resolve(sent.length === 1 ? { ok: true, messageId: 'm1', threadGone: true } : { ok: true, messageId: 'm2' });
      },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen()
    });
    await hub.onInbound({ channel: 'telegram', chatId: '-1001', chatType: 'group', userId: '9', text: 'hi', messageId: '5', ts: 1, threadId: '77' });
    A.eq(sent[0].threadId, '77', 'the first send aimed at the topic the member wrote in');
    await hub._internals.deliver('-1001', 'a later notification', '', 'command');
    A.eq('threadId' in (sent[1] || {}), false, 'and once the topic is reported gone it is never aimed at again');

    // a normal send must not clear anything
    const keep = [];
    const hub2 = makeChannelHub({
      runOnce: okRun({}), store: fakeStore(),
      send: (c2, t, opts) => { keep.push(opts || {}); return Promise.resolve({ ok: true, messageId: 'm' }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen()
    });
    await hub2.onInbound({ channel: 'telegram', chatId: '-1001', chatType: 'group', userId: '9', text: 'hi', messageId: '5', ts: 1, threadId: '77' });
    await hub2._internals.deliver('-1001', 'a later notification', '', 'command');
    A.eq(keep[keep.length - 1].threadId, '77', 'a healthy topic is remembered across sends, as before');
  }

  // ---- J. the status line: a bot has no presence dot, so this is the closest surface ----
  {
    const f = recFetch();
    const t = makeTelegramTransport({ fetch: f, token: '1:a' });
    await t.setShortDescription('online — the station is listening');
    A.eq(f.calls[0].method, 'setMyShortDescription', 'it writes the profile short description');
    A.eq(f.calls[0].body.short_description, 'online — the station is listening', 'with the given text');
    const f2 = recFetch();
    await makeTelegramTransport({ fetch: f2, token: '1:a' }).setShortDescription('x'.repeat(300));
    A.eq(f2.calls[0].body.short_description.length, 120, 'capped at Telegram\'s 120 characters rather than 400ing');
  }

  A.report('channels.telegram.updates');
}

run().catch(e => { console.log('FAIL: run() threw — ' + (e && e.stack || e)); process.exit(1); });
