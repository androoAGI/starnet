/* node test/channels.telegram.threads.test.js — N1/N2: answering WHERE the question was asked (2026-07-29).

   Two facts arrived with every inbound message and were both discarded:

     · WHICH FORUM TOPIC it came from. `message_thread_id` was read in exactly one place — to suppress the
       phantom-quote trap in replyOf — and never sent back. So in a forum supergroup every answer landed in
       **General instead of the topic the member was sitting in**. That is the last remaining case of this
       channel delivering a message to the WRONG PLACE rather than merely doing less than the reference harness does.
     · WHICH MESSAGE it was. A reply in a busy group floated loose from its question.

   The seam is the plan's capability seam turned inside out: the hub speaks a NEUTRAL route
   ({ threadId, replyTo }) and only telegram.transport.js knows the Bot API's names, so Discord/Slack/
   Matrix/Signal — none of which read unknown send opts — are byte-identical.

   Fakes only: no network, no clock. */
'use strict';
const A = require('./_assert.js');
const { normalize } = require('../sidecar/channels/telegram.js');
const { makeChannelAdapter } = require('../sidecar/channels/adapter.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makeTelegramTransport } = require('../sidecar/channels/telegram.transport.js');

const FORUM = { id: -1001, type: 'supergroup' };
const GROUP = { id: -1002, type: 'supergroup' };
const DM = { id: 111, type: 'private' };
const ME = { id: 5, username: 'andro' };

// a fetch that records every call and answers from a queue of {ok, body} (or a default success)
function recFetch(queue) {
  const calls = [];
  const q = (queue || []).slice();
  const impl = async (url, init) => {
    const method = String(url).split('/').pop();
    let body = init && init.body;
    const ct = String((init && init.headers && init.headers['content-type']) || '');
    const isMultipart = /multipart\/form-data/.test(ct);
    if (!isMultipart && typeof body === 'string') { try { body = JSON.parse(body); } catch (_) {} }
    else if (isMultipart) body = Buffer.isBuffer(body) ? body.toString('latin1') : String(body);
    calls.push({ method, body, multipart: isMultipart });
    const next = q.length ? q.shift() : { ok: true, result: { message_id: 42 } };
    return { ok: next.ok !== false, status: next.status || 200, async json() { return next; }, headers: { get: () => null } };
  };
  impl.calls = calls;
  return impl;
}

function fakeStore() {
  const hist = new Map();
  return {
    loadHistory: (a) => (hist.get(a) || []).slice(),
    appendTurn: (a, role, content) => { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; },
    getChatRecord: () => null, saveChatRecord: () => {}
  };
}
const idGen = () => { let i = 0; return () => 'run' + (++i); };
const okRun = (sink) => async (o) => {
  if (sink) sink.last = o;
  o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
  o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: (sink && sink.reply) || 'ok' });
  o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
};

async function run() {
  // ---- A. normalize: the topic id is read, and ONLY for a real topic message ----
  {
    const forum = normalize({ update_id: 1, message: { message_id: 9, text: 'hi', chat: FORUM, from: ME, is_topic_message: true, message_thread_id: 77 } });
    A.eq(forum.message.threadId, '77', 'a forum topic message carries its topic id');
    A.eq(typeof forum.message.threadId, 'string', 'as a string — the neutral shape never assumes a numeric id');

    // A PLAIN SUPERGROUP ALSO SETS message_thread_id on a reply chain. Echoing that back would aim the answer at
    // a "topic" the chat does not have, which is a 400 in exchange for nothing.
    const chain = normalize({ update_id: 2, message: { message_id: 9, text: 'hi', chat: GROUP, from: ME, message_thread_id: 44 } });
    A.eq('threadId' in chain.message, false, 'a non-forum reply chain contributes NO threadId (is_topic_message is the gate)');
    const dm = normalize({ update_id: 3, message: { message_id: 9, text: 'hi', chat: DM, from: ME } });
    A.eq('threadId' in dm.message, false, 'a DM carries no threadId key at all (additive only)');
  }

  // ---- B. the adapter carries it through, still neutral ----
  {
    const got = [];
    const ad = makeChannelAdapter({
      transport: { getUpdates: async () => [], send: async () => ({ ok: true }) },
      normalize: (r) => r, name: 'telegram', clock: { now: () => 1 },
      allowedChats: ['-1001'], ownerUserId: '5', requireMention: false,
      onInbound: (im) => got.push(im)
    });
    ad._internals.dispatch({ offset: 1, message: { chatId: -1001, chatType: 'group', userId: '9', text: 'a', messageId: '1', threadId: '77' } });
    ad._internals.dispatch({ offset: 2, message: { chatId: -1001, chatType: 'group', userId: '9', text: 'b', messageId: '2' } });
    A.eq(got.length, 2, 'both messages are admitted');
    A.eq(got[0].threadId, '77', 'threadId rides onto the neutral inbound event');
    A.eq('threadId' in got[1], false, 'and is absent when the platform did not set one');
  }

  // ---- C. the transport translates the neutral route into Bot API fields ----
  {
    const f = recFetch();
    const t = makeTelegramTransport({ fetch: f, token: '123:abc' });
    const r = await t.send('-1001', 'here you go', { threadId: '77', replyTo: '9' });
    A.eq(r.ok, true, 'the send succeeds');
    const p = f.calls[0].body;
    A.eq(p.message_thread_id, 77, 'threadId becomes message_thread_id — a NUMBER, which is what the Bot API wants');
    A.eq(p.reply_to_message_id, 9, 'replyTo becomes reply_to_message_id');
    A.eq(p.allow_sending_without_reply, true,
      'and rides with allow_sending_without_reply: if the quoted message was deleted meanwhile, Telegram 400s and THE REPLY IS LOST — never trade the answer for the decoration');
    A.eq('threadId' in p, false, 'the neutral key does not leak onto the wire');
    A.eq('replyTo' in p, false, 'nor does the other one');

    // no route at all -> byte-identical to before this change
    const f2 = recFetch();
    await makeTelegramTransport({ fetch: f2, token: '123:abc' }).send('111', 'hi', {});
    A.eq('message_thread_id' in f2.calls[0].body, false, 'no route in = no route on the wire');
    A.eq('allow_sending_without_reply' in f2.calls[0].body, false, 'and no stray reply flag either');
  }

  // ---- C2. a dead topic must cost the decoration, never the message ----
  {
    const f = recFetch([
      { ok: false, error_code: 400, description: 'Bad Request: message thread not found' },
      { ok: true, result: { message_id: 43 } }
    ]);
    const t = makeTelegramTransport({ fetch: f, token: '123:abc' });
    const r = await t.send('-1001', 'the answer', { threadId: '77' });
    A.eq(r.ok, true, 'a closed/deleted topic does not lose the reply');
    A.eq(f.calls.length, 2, 'exactly one retry — bounded, not a loop');
    A.eq(f.calls[0].body.message_thread_id, 77, 'the first attempt aimed at the topic');
    A.eq('message_thread_id' in f.calls[1].body, false, 'the retry drops the topic and lands on the chat root');
    A.eq(r.threadGone, true,
      'and the result SAYS the topic is gone — saving this one message is not enough; without the flag the hub keeps the dead binding and every later send repeats the failed call and its retry');
    const fOk = recFetch();
    A.eq('threadGone' in (await makeTelegramTransport({ fetch: fOk, token: '123:abc' }).send('-1001', 'x', { threadId: '77' })), false,
      'a healthy send never claims the topic is gone');

    // a DIFFERENT 400 must not trigger the retry — resending a "chat not found" fails identically twice
    const f2 = recFetch([{ ok: false, error_code: 400, description: 'Bad Request: chat not found' }]);
    const r2 = await makeTelegramTransport({ fetch: f2, token: '123:abc' }).send('-1001', 'x', { threadId: '77' });
    A.eq(r2.ok, false, 'an unrelated 400 still fails');
    A.eq(f2.calls.length, 1, 'and is NOT retried');
  }

  // ---- C3. the entity fallback and the thread fallback compose in the right order ----
  {
    // markdown -> HTML is attempted first; its plain-text retry must KEEP the topic, and a thread failure after
    // that must not resurrect the markdown syntax the first fallback already stripped.
    const f = recFetch([
      { ok: false, error_code: 400, description: "Bad Request: can't parse entities: unexpected end tag" },
      { ok: false, error_code: 400, description: 'Bad Request: message thread not found' },
      { ok: true, result: { message_id: 44 } }
    ]);
    const t = makeTelegramTransport({ fetch: f, token: '123:abc' });
    const r = await t.send('-1001', 'read **this** now', { threadId: '77' });
    A.eq(r.ok, true, 'both fallbacks in sequence still deliver');
    A.eq(f.calls.length, 3, 'three attempts: formatted+topic, plain+topic, plain+root');
    A.eq(f.calls[1].body.message_thread_id, 77, 'the plain-text retry KEEPS the topic — it was not the topic that failed');
    A.eq('parse_mode' in f.calls[2].body, false, 'and the root-ward retry stays plain');
    A.eq(f.calls[2].body.text, f.calls[1].body.text, 'it resends the SAME text — the markdown syntax does not come back');
  }

  // ---- C4. a file answers in the topic that asked for it, and so does the typing bubble ----
  {
    const f = recFetch();
    const t = makeTelegramTransport({ fetch: f, token: '123:abc' });
    await t.sendMedia('-1001', { kind: 'photo', buffer: Buffer.from('PNGDATA'), filename: 'a.png', mime: 'image/png' }, { threadId: '77', replyTo: '9' });
    const body = f.calls[0].body;
    A.eq(f.calls[0].multipart, true, 'media still goes as multipart');
    A.ok(/name="message_thread_id"\r\n\r\n77/.test(body), 'the multipart form carries the topic');
    A.ok(/name="reply_to_message_id"\r\n\r\n9/.test(body), 'and the quote');
    A.ok(!/name="threadId"/.test(body), 'the neutral key is not written into the form');

    const f2 = recFetch();
    await makeTelegramTransport({ fetch: f2, token: '123:abc' }).sendChatAction('-1001', 'typing', { threadId: '77' });
    A.eq(f2.calls[0].body.message_thread_id, 77, 'the typing bubble is raised IN the topic, not in General where the member is not looking');
    A.eq('reply_to_message_id' in f2.calls[0].body, false, 'a chat action cannot quote a message, and does not pretend to');
  }

  // ---- D. the hub remembers the route per chat and hands it back on every send ----
  {
    const sent = [];
    const send = (chatId, text, opts) => { sent.push({ chatId, text, opts }); return Promise.resolve({ ok: true, messageId: 'm' + sent.length }); };
    const sink = { reply: 'x'.repeat(5000) };   // long enough to force TWO chunks
    const hub = makeChannelHub({
      runOnce: okRun(sink), store: fakeStore(), send, secrets: () => ({ key: 'k', model: 'm' }),
      classify: () => false, newId: idGen(), maxMessageLength: 4096
    });

    await hub.onInbound({ channel: 'telegram', chatId: '-1001', chatType: 'group', userId: '9', userName: 'Ana', text: 'check the logs', messageId: '31', ts: 1, threadId: '77' });
    A.ok(sent.length >= 2, 'the long reply was chunked');
    A.eq(sent.every(s => s.opts && s.opts.threadId === '77'), true, 'EVERY chunk lands in the topic — half an answer in the wrong room is worse than none');
    A.eq(sent[0].opts.replyTo, '31', 'the FIRST chunk quotes the question');
    A.eq(sent.slice(1).every(s => !s.opts.replyTo), true, 'and no later chunk repeats the quote');

    // the quote is spent; a LATER message into the same chat still lands in the topic but must not reach back
    // and reply to an old message (a routine firing hours later would read as a bot talking to the past).
    sent.length = 0;
    await hub._internals.deliver('-1001', 'a routine finished', '', 'command');
    A.eq(sent[0].opts.threadId, '77', 'a later send still knows the topic');
    A.eq(!!sent[0].opts.replyTo, false, 'but the quote was consumed by the answer it belonged to');
  }

  // ---- D2. a DM and a plain group are each left exactly as they were ----
  {
    const sent = [];
    const send = (chatId, text, opts) => { sent.push({ chatId, opts }); return Promise.resolve({ ok: true }); };
    const hub = makeChannelHub({ runOnce: okRun({}), store: fakeStore(), send, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen() });

    await hub.onInbound({ channel: 'telegram', chatId: '777', chatType: 'dm', userId: '5', text: 'hi', messageId: '4', ts: 1 });
    // a durable reply's part carries its idempotency key (channel-delivery-ledger S2), never a route: no topic, no quote
    A.eq(Object.keys(sent[0].opts || {}).filter(k => k !== 'idempotencyKey'), [], 'a DM carries NO route opts at all — one human in the room, a quote every turn is noise');

    sent.length = 0;
    await hub.onInbound({ channel: 'telegram', chatId: '-1002', chatType: 'group', userId: '9', text: 'hi', messageId: '5', ts: 1 });
    A.eq(sent[0].opts.replyTo, '5', 'a plain group still gets the quote');
    A.eq('threadId' in sent[0].opts, false, 'without inventing a topic it does not have');
  }

  // ---- D3. the route must not vandalise the caller's own send opts ----
  {
    const sent = [];
    const send = (chatId, text, opts) => { sent.push(opts); return Promise.resolve({ ok: true, messageId: 'm1' }); };
    const hub = makeChannelHub({ runOnce: okRun({}), store: fakeStore(), send, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen() });
    hub._internals.noteRoute({ chatId: '-1001', chatType: 'group', messageId: '31', threadId: '77' });
    const keyboard = { reply_markup: { inline_keyboard: [] } };
    await hub._internals.deliver('-1001', 'pick one', 'r1', 'prompt', '', keyboard);
    A.eq(sent[0].reply_markup, keyboard.reply_markup, 'the keyboard still rides');
    A.eq(sent[0].threadId, '77', 'alongside the route');
    A.eq(Object.keys(keyboard).length, 1, "and the caller's object was not mutated — a shared opts object must never grow a stale reply id");
  }

  // ---- D4. the route table is bounded ----
  {
    const hub = makeChannelHub({ runOnce: okRun({}), store: fakeStore(), send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen() });
    const { noteRoute, routes, MAX_ROUTES } = hub._internals;
    for (let i = 0; i < MAX_ROUTES + 50; i++) noteRoute({ chatId: 'c' + i, chatType: 'group', messageId: '1', threadId: '9' });
    A.eq(routes.size, MAX_ROUTES, 'chatIds are unbounded, so the table is not — the oldest are evicted');
    A.eq(routes.has('c' + (MAX_ROUTES + 49)), true, 'the most recent chat survives');
    A.eq(routes.has('c0'), false, 'the oldest was dropped');
  }

  A.report('channels.telegram.threads');
}

run().catch(e => { console.log('FAIL: run() threw — ' + (e && e.stack || e)); process.exit(1); });
