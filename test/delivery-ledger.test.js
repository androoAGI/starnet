/* node test/delivery-ledger.test.js — the channel DELIVERY LEDGER on its own (sidecar/channels/delivery-ledger.js).

   One durable record chain for every receipt, run attempt and delivery; one FIFO lane per chat; every transition one
   write. Driven here over a scripted IO (writes counted, any write or read made to fail), manual timers and a scripted
   sender, so each rule is checked exactly:
     A. receipts: written before they return, idempotent, the route rides the same write, a refused write records
        nothing, the per-channel intake cap refuses only its own channel; attempt marks (runId, tools that never go down,
        the boot, replays)
     B. answer / settle / settleRun / enqueue: the receipts leave and the reply enters its lane in ONE write; an existing
        id returns its record, somebody else's reply under the same id is kept as a new record
     C. lanes: parts in order, one write per mark, the record leaves with its last mark; a chat's retryable failure backs
        off that chat only (5 s doubling to 60 s, retryAfter honoured); FIFO behind a failed head; retryable:false is a
        tombstone reported once and never retried; auth holds the channel until kick(reset); the delayed-reply line;
        the stream seed is replaced in place; the quote and keyboard ride the first attempt only; an ephemeral send
        waits only while a part is on the wire
     D. write failure: an accepted part's mark that cannot be written is authoritative in memory (never resent), every
        lane holds while the ledger is dirty and resumes when the retry lands; holding() starts no part; a failed answer
        write keeps the reply in memory and its receipts out of recovery; an unreadable file refuses receipts, holds the
        lanes and merges what was decided meanwhile; health() names the hold
     E. backpressure: a chat that owes 20 replies (or 200,000 characters) gets its new receipts deferred, in order; a
        finished reply is never refused
     F. the dead mark: queued replies become tombstones in the marking write, a later reply still gets one send, a
        failure then gives it up, a success clears the mark
     G. release and TTL: a 'caller' record stays 'done' until released, and is pruned after 7 days; tombstones are the
        last 50 per channel within 30 days
     I. parts that are not words (S4): a record's file and note parts wait for the host's handlers, each with its own
        idempotency key; a file that cannot go is marked with its error and named in the note, an aborted upload is tried
        again; a routine's part goes as written (no delayed-reply line); a caller's one-time side effect is marked once
     J. a stamp is an edit (S6): in its chat's lane, one write with the open ask it closes, no channel.delivery; 'not
        modified' is done, a gone message leaves in silence, a refusal for good is one line, a refusal for the moment
        waits on the lane's backoff a bounded number of times and never holds the chat's replies for good; an open ask
        survives a restart and names itself to the next boot */
'use strict';
const A = require('./_assert.js');
const { makeDeliveryLedger, memoryIo, partKey, shortHash, DELAYED_HEADER, DEFAULTS } = require('../sidecar/channels/delivery-ledger.js');

const settle = async (n) => { for (let i = 0; i < (n || 30); i++) await new Promise(r => setImmediate(r)); };

function fakeIo() {
  let saved = null;
  const io = {
    writes: 0, failNext: 0, failCode: '', readFail: null,
    read() { if (io.readFail) throw io.readFail; return saved == null ? undefined : JSON.parse(saved); },
    write(doc) {
      if (io.failCode || io.failNext > 0) { if (io.failNext > 0) io.failNext--; const e = new Error((io.failCode || 'EBUSY') + ': simulated'); e.code = io.failCode || 'EBUSY'; throw e; }
      io.writes++; saved = JSON.stringify(doc);
    },
    disk() { return saved == null ? null : JSON.parse(saved); }
  };
  return io;
}
function fakeTimers() {
  const list = [];
  return {
    list,
    setTimeout(fn, ms) { const t = { fn: fn, ms: ms, unref() {} }; list.push(t); return t; },
    clearTimeout(t) { const i = list.indexOf(t); if (i >= 0) list.splice(i, 1); },
    async fire() { const due = list.splice(0); for (const t of due) t.fn(); await settle(); }
  };
}
// a channel's sender: scripted results ('ok' = accepted), every call recorded
function makeSender(extra) {
  const s = Object.assign({
    calls: [], events: [], plan: [], maxMessageLength: 100,
    send(chatId, text, opts) { s.calls.push({ op: 'send', chatId: String(chatId), text: text, opts: opts === undefined ? null : JSON.parse(JSON.stringify(opts)) }); return Promise.resolve(s.answer()); },
    editMessage(chatId, id, text, opts) { s.calls.push({ op: 'edit', chatId: String(chatId), messageId: id, text: text }); return Promise.resolve(s.editPlan && s.editPlan.length ? s.editPlan.shift() : { ok: true }); },
    deleteMessage(chatId, id) { s.calls.push({ op: 'delete', chatId: String(chatId), messageId: id }); return Promise.resolve({ ok: true }); },
    emit(name, ev) { s.events.push(Object.assign({ name: name }, ev)); },
    answer() { const r = s.plan.length ? s.plan.shift() : 'ok'; return r === 'ok' ? { ok: true, messageId: 'm' + s.calls.length } : Object.assign({}, r); }
  }, extra || {});
  return s;
}
let T = 1761900000000;
function mk(opts) {
  const o = opts || {};
  const io = o.io || fakeIo(), timers = o.timers || fakeTimers();
  const logs = [];
  const ledger = makeDeliveryLedger(Object.assign({ io, clock: { now: () => T }, timers, bootId: o.bootId || 'boot-1', log: (l) => logs.push(l) }, o.deps || {}));
  return { io, timers, ledger, logs };
}
const msg = (chatId, id, text) => ({ channel: 'telegram', chatId: String(chatId), chatType: 'dm', userId: 'u', text: text || 'hi', messageId: String(id) });
const reply = (chatId, id, parts, extra) => Object.assign({ id: id, channel: 'telegram', chatId: String(chatId), kind: 'reply', reason: 'done', runId: id.replace(/^reply:/, ''), parts: parts }, extra || {});

(async () => {
  // ---- A. receipts and attempt marks ----
  {
    const { io, ledger } = mk();
    const r = ledger.receive({ id: 'telegram|7|1', channel: 'telegram', chatId: '7', message: msg(7, 1), route: { threadId: '55' } });
    A.eq(io.writes, 1, 'a receipt is one durable write, made before receive() returns');
    A.eq(io.disk().receipts.map(x => x.id), ['telegram|7|1'], 'the receipt is on disk');
    A.eq(io.disk().chats['telegram|7'].route, { threadId: '55' }, 'the chat\'s route rides that same write');
    A.eq(r.attempt, null, 'a fresh receipt has no attempt');
    A.ok(ledger.receive({ id: 'telegram|7|1', channel: 'telegram', chatId: '7', message: msg(7, 1) }) === r && io.writes === 1, 'the same receipt again returns it, with no write (a platform redelivery)');
    io.failNext = 1;
    A.throws(() => ledger.receive({ id: 'telegram|7|2', channel: 'telegram', chatId: '7', message: msg(7, 2), route: null }), 'a receipt that cannot be written throws (the adapter does not acknowledge)');
    A.eq(ledger.pending('telegram').map(x => x.id), ['telegram|7|1'], 'and records nothing in memory either');
    A.eq(ledger.chat('telegram|7').route, { threadId: '55' }, 'its route change is undone too');
    ledger.markAttempt(['telegram|7|1'], { runId: 'run-a' });
    ledger.markAttempt(['telegram|7|1'], { tools: 3 });
    ledger.markAttempt(['telegram|7|1'], { tools: 1 });
    A.eq(io.disk().receipts[0].attempt, { runId: 'run-a', tools: 3, boot: 'boot-1', replays: 0 }, 'marks: the run, the begun steps (never down), the boot that wrote them');
    ledger.markAttempt(['telegram|7|1'], { runId: 'run-b', replay: true });
    A.eq(io.disk().receipts[0].attempt.replays, 1, 'a replay counts itself on the attempt');
    A.eq(ledger.markAttempt(['nope'], { runId: 'x' }), false, 'marking a receipt that already left is a no-op');
  }
  {
    const { ledger } = mk({ deps: { limits: { maxPendingPerChannel: 2 } } });
    ledger.receive({ id: 'telegram|1|1', channel: 'telegram', chatId: '1', message: msg(1, 1) });
    ledger.receive({ id: 'telegram|2|1', channel: 'telegram', chatId: '2', message: msg(2, 1) });
    let err = null;
    try { ledger.receive({ id: 'telegram|3|1', channel: 'telegram', chatId: '3', message: msg(3, 1) }); } catch (e) { err = e; }
    A.eq(err && err.code, 'INTAKE_FULL', 'a channel holding its cap of pending receipts refuses the next one');
    A.notThrows(() => ledger.receive({ id: 'discord|3|1', channel: 'discord', chatId: '3', message: Object.assign(msg(3, 1), { channel: 'discord' }) }), 'another channel is never refused');
  }

  // ---- B. answer, settle, settleRun, enqueue ----
  {
    const { io, ledger } = mk();
    ledger.receive({ id: 'telegram|7|1', channel: 'telegram', chatId: '7', message: msg(7, 1) });
    ledger.receive({ id: 'telegram|7|2', channel: 'telegram', chatId: '7', message: msg(7, 2) });
    const w0 = io.writes;
    const d = ledger.answer(['telegram|7|1', 'telegram|7|2'], reply(7, 'reply:r1', ['the answer']));
    A.eq(io.writes - w0, 1, 'answer: ONE write');
    A.eq([io.disk().receipts.length, io.disk().deliveries.map(x => x.id)], [0, ['reply:r1']], 'in it the receipts leave and the reply enters its lane together');
    A.eq(d.chat, 'telegram|7', 'a delivery is keyed by its chat: <channel>|<chatId>');
    A.ok(ledger.enqueue(reply(7, 'reply:r1', ['the answer'])) === d, 'enqueueing an existing id returns that record');
    const other = ledger.enqueue(reply(8, 'reply:r1', ['another chat\'s answer']));
    A.ok(other !== d && other.id !== 'reply:r1' && ledger.deliveries().length === 2, 'somebody else\'s reply under the same id is kept as its own record, never dropped');
    ledger.receive({ id: 'telegram|7|3', channel: 'telegram', chatId: '7', message: msg(7, 3) });
    ledger.receive({ id: 'telegram|7|4', channel: 'telegram', chatId: '7', message: msg(7, 4) });
    ledger.markAttempt(['telegram|7|3', 'telegram|7|4'], { runId: 'merged' });
    const w1 = io.writes;
    const s = ledger.settleRun('merged', { channel: 'telegram', notice: reply(7, 'notice:merged:interrupted', ['not run again'], { kind: 'notice', reason: 'interrupted' }) });
    A.eq(io.writes - w1, 1, 'settleRun: one write');
    A.eq([s.ids.sort(), ledger.pending('telegram').length, !!ledger.delivery('notice:merged:interrupted')], [['telegram|7|3', 'telegram|7|4'], 0, true], 'every receipt of the run settles, and the notice is enqueued in that write');
    A.eq(ledger.settle(['telegram|7|3']).settled, 0, 'settling a receipt that already left changes nothing');
  }

  // ---- C. lanes ----
  {
    const { io, ledger } = mk();
    const s = makeSender();
    ledger.attach('telegram', s);
    const d = ledger.enqueue(reply(7, 'reply:r1', ['part one', 'part two', 'part three']));
    const first = ledger.whenAttempted(d.id, null);
    const w0 = io.writes;
    await ledger.drive('telegram|7');
    A.eq(s.calls.map(c => c.text), ['part one', 'part two', 'part three'], 'parts go out in order');
    A.eq(io.writes - w0, 3, 'one write per part mark; the record leaves in the last one');
    A.eq(io.disk().deliveries, [], 'nothing is left on disk');
    A.eq(await first, { ok: true, messageId: 'm3' }, 'the first attempt resolves with the last part\'s message id');
    A.eq(s.events.map(e => [e.ok, e.reason, e.chunks]), [[true, 'done', 3]], 'one channel.delivery with the caller\'s reason');
  }
  {
    // a chat failing retryably backs off alone; the other chat's reply lands within the same drain
    const { ledger, timers } = mk();
    const s = makeSender();
    s.send = function (chatId, text, opts) {
      s.calls.push({ op: 'send', chatId: String(chatId), text: text });
      return Promise.resolve(String(chatId) === '7' && !s.healed ? { ok: false, error: 'Bad Gateway', retryable: true, retryAfter: 0 } : { ok: true, messageId: 'm' + s.calls.length });
    };
    ledger.attach('telegram', s);
    ledger.enqueue(reply(7, 'reply:a1', ['for seven, first']));
    ledger.enqueue(reply(7, 'reply:a2', ['for seven, second']));
    ledger.enqueue(reply(8, 'reply:b1', ['for eight']));
    const behind = ledger.whenAttempted('reply:a2', null);
    await Promise.all([ledger.drive('telegram|7'), ledger.drive('telegram|8')]);
    A.eq(s.calls.filter(c => c.chatId === '8').map(c => c.text), ['for eight'], 'a healthy chat is never held behind a failing one');
    A.eq(s.calls.filter(c => c.chatId === '7').map(c => c.text), ['for seven, first'], 'the failing chat tries its head once, and its second reply waits behind it (FIFO)');
    A.eq(await behind, { ok: false, queued: true, held: 'backoff', error: '' }, 'the reply behind the failed head is told it is queued, not attempted');
    A.eq(timers.list.map(t => t.ms), [5000], 'that chat\'s lane backs off 5 s');
    await timers.fire();
    A.eq(timers.list.map(t => t.ms), [10000], 'then 10 s (doubling, to 60 s)');
    s.healed = true;
    await timers.fire();
    const seven = s.calls.filter(c => c.chatId === '7').map(c => c.text);
    A.eq(seven.slice(-2), [DELAYED_HEADER + '\nfor seven, first', 'for seven, second'], 'healed: the head lands carrying the delayed-reply line, then the next, in order');
    A.eq(ledger.deliveries(), [], 'and both leave');
  }
  {
    // retryAfter is honoured, capped at 60 s
    const { ledger, timers } = mk();
    const s = makeSender({ plan: [{ ok: false, error: '429', retryable: true, retryAfter: 17 }] });
    ledger.attach('telegram', s);
    ledger.enqueue(reply(7, 'reply:r', ['x']));
    await ledger.drive('telegram|7');
    A.eq(timers.list.map(t => t.ms), [17000], 'a 429\'s retry_after sets the wait');
  }
  {
    // retryable:false: a tombstone, reported once, never retried; the chat's next reply still goes
    const { io, ledger, timers, logs } = mk();
    const s = makeSender({ plan: [{ ok: false, error: 'Bad Request: message is too long', retryable: false }] });
    ledger.attach('telegram', s);
    ledger.enqueue(reply(7, 'reply:bad', ['too long']));
    ledger.enqueue(reply(7, 'reply:good', ['fine']));
    const bad = ledger.whenAttempted('reply:bad', null);
    await ledger.drive('telegram|7');
    A.eq(await bad, { ok: false, undeliverable: true, error: 'Bad Request: message is too long' }, 'the refused reply\'s first attempt says undeliverable');
    A.eq(s.calls.map(c => c.text), ['too long', 'fine'], 'it is sent once and never again; the next reply in the chat goes on');
    A.eq(io.disk().tombstones.map(t => [t.id, t.reason]), [['reply:bad', 'undeliverable']], 'a tombstone, written as the record leaves');
    A.eq(s.events.filter(e => e.reason === 'undeliverable').length, 1, 'one channel.delivery says undeliverable');
    A.eq(logs.filter(l => /undeliverable/.test(l)).length, 1, 'one console line says so');
    A.eq(timers.list.length, 0, 'nothing is armed to retry it');
  }
  {
    // auth: the credential, not the chat — the channel's lanes hold until its next 'up' (kick with reset)
    const { ledger } = mk();
    const tg = makeSender({ plan: [{ ok: false, error: 'Unauthorized', retryable: false, auth: true }] });
    const dc = makeSender();
    ledger.attach('telegram', tg);
    ledger.attach('discord', dc);
    ledger.enqueue(reply(7, 'reply:t1', ['kept']));
    await ledger.drive('telegram|7');
    ledger.enqueue(reply(8, 'reply:t2', ['also kept']));
    ledger.enqueue({ id: 'reply:d1', channel: 'discord', chatId: '7', parts: ['discord goes'] });
    await Promise.all([ledger.drive('telegram|8'), ledger.drive('discord|7')]);
    A.eq(tg.calls.map(c => c.text), ['kept'], 'one refused credential holds every lane of that channel');
    A.eq(dc.calls.map(c => c.text), ['discord goes'], 'another channel is untouched');
    A.eq(ledger.deliveries().filter(d => d.channel === 'telegram').length, 2, 'the replies are kept, not parked');
    await ledger.kick('telegram', { reset: true });
    A.eq(tg.calls.map(c => c.text).slice(1).sort(), ['also kept', DELAYED_HEADER + '\nkept'].sort(), 'the re-paired channel\'s up delivers them');
  }
  {
    // the delayed-reply line goes on its own just before a part it does not fit under
    const { ledger, timers } = mk();
    const s = makeSender({ maxMessageLength: 80, plan: [{ ok: false, error: 'down', retryable: true }] });
    ledger.attach('telegram', s);
    ledger.enqueue(reply(7, 'reply:r', ['x'.repeat(60)]));
    await ledger.drive('telegram|7');
    await timers.fire();
    A.eq(s.calls.map(c => c.text).slice(1), [DELAYED_HEADER, 'x'.repeat(60)], 'the line goes as its own message just before the part; parts are never re-split');
    A.eq(new Set([partKey('reply:r', 0), partKey('reply:r', 'h')]).size, 2, 'the inserted line has its own part key, so the part keeps its key');
  }
  {
    // the stream seed: chunk 0 replaces it in place; a failed edit deletes the stranded partial and sends the chunk
    const { ledger } = mk();
    const s = makeSender();
    ledger.attach('telegram', s);
    ledger.enqueue(reply(7, 'reply:seeded', ['chunk zero', 'chunk one'], { seed: 'seed-1' }));
    await ledger.drive('telegram|7');
    A.eq(s.calls.map(c => c.op + ':' + c.text), ['edit:chunk zero', 'send:chunk one'], 'chunk 0 edits the seed, the rest are sent');
    const s2 = makeSender({ editPlan: [{ ok: false, error: 'Bad Request: message to edit not found' }] });
    const L2 = mk().ledger;
    L2.attach('telegram', s2);
    L2.enqueue(reply(7, 'reply:seeded', ['chunk zero'], { seed: 'seed-2' }));
    await L2.drive('telegram|7');
    A.eq(s2.calls.map(c => c.op), ['edit', 'delete', 'send'], 'a failed edit: the partial is deleted first, then the chunk is sent');
    const s3 = makeSender({ editPlan: [{ ok: false, error: 'Bad Request: message is not modified' }] });
    const L3 = mk().ledger;
    L3.attach('telegram', s3);
    L3.enqueue(reply(7, 'reply:seeded', ['same text'], { seed: 'seed-3' }));
    const r3 = L3.whenAttempted('reply:seeded', null);
    await L3.drive('telegram|7');
    A.eq([s3.calls.map(c => c.op), await r3], [['edit'], { ok: true, messageId: 'seed-3' }], '"not modified" is the final text already there: a success');
  }
  {
    // the quote and the keyboard ride the FIRST attempt only; the thread rides every part, always
    const { ledger, timers } = mk();
    const s = makeSender({ plan: ['ok', { ok: false, error: 'down', retryable: true }] });
    ledger.attach('telegram', s);
    ledger.enqueue(reply(-5, 'reply:g', ['one', 'two'], { route: { threadId: '77' } }));
    const first = ledger.whenAttempted('reply:g', { replyTo: '12', sendOpts: { reply_markup: { k: 1 } } });
    await ledger.drive('telegram|-5');
    const route = (o) => { const r = Object.assign({}, o); delete r.idempotencyKey; return r; };
    A.eq(s.calls.map(c => route(c.opts)), [{ threadId: '77', replyTo: '12' }, { reply_markup: { k: 1 }, threadId: '77' }], 'first attempt: the quote on part 0, the keyboard on the last, the thread on both');
    A.eq((await first).ok, false, 'that attempt failed');
    await timers.fire();
    A.eq(route(s.calls[2].opts), { threadId: '77' }, 'the retry carries the thread only: no hours-old quote, no keyboard whose token was retired');
    A.eq(s.calls.map(c => c.opts.idempotencyKey), [partKey('reply:g', 0), partKey('reply:g', 1), partKey('reply:g', 1)], 'every send carries its part\'s key, the same on the retry');
    A.eq(s.calls.filter(c => c.op === 'edit').length, 0, 'fixture: no seed here');
    A.eq(s.events.map(e => e.reason), ['done', 'redelivered'], 'the first attempt says its reason (ok:false), the later landing says redelivered');
  }
  {
    // an ephemeral send waits only while a part is on the wire, and never behind a lane that is backing off
    const { ledger } = mk();
    let release;
    const gate = new Promise(r => { release = r; });
    const order = [];
    const s = makeSender();
    s.send = function (chatId, text) { order.push('start:' + text); return (text === 'slow part' ? gate : Promise.resolve()).then(() => { order.push('end:' + text); return { ok: true, messageId: 'x' }; }); };
    ledger.attach('telegram', s);
    ledger.enqueue(reply(7, 'reply:slow', ['slow part', 'second part']));
    const lane = ledger.drive('telegram|7');
    await settle();
    const eph = ledger.sendEphemeral('telegram|7', () => { order.push('ephemeral'); });
    await settle();
    A.eq(order, ['start:slow part'], 'the ephemeral send waits while the durable part is on the wire');
    release();
    await lane; await eph;
    A.eq(order, ['start:slow part', 'end:slow part', 'start:second part', 'end:second part', 'ephemeral'], 'a durable reply\'s parts are never split by an ephemeral send');
    const L2 = mk();
    const s2 = makeSender({ plan: [{ ok: false, error: 'down', retryable: true }] });
    L2.ledger.attach('telegram', s2);
    L2.ledger.enqueue(reply(7, 'reply:x', ['stuck']));
    await L2.ledger.drive('telegram|7');
    let ran = false;
    await L2.ledger.sendEphemeral('telegram|7', () => { ran = true; });
    A.ok(ran, 'a lane backing off never holds an ephemeral send');
  }

  // ---- D. write failure ----
  {
    // the mark of an ACCEPTED part cannot be written: never resent in this process; every lane holds; resumes after the retry
    const { io, ledger, timers } = mk();
    const s = makeSender();
    ledger.attach('telegram', s);
    ledger.enqueue(reply(7, 'reply:big', ['p1', 'p2', 'p3']));
    ledger.enqueue(reply(8, 'reply:other', ['other chat']));
    let n = 0;
    const realSend = s.send;
    s.send = function (chatId, text, opts) { n++; if (n === 1) io.failCode = 'UPDATE_MUTATIONS_FROZEN'; return realSend(chatId, text, opts); };
    await ledger.drive('telegram|7');
    A.eq(s.calls.map(c => c.text), ['p1'], 'after the platform took p1 its mark could not be written: no further part starts');
    A.eq(ledger.health().held, true, 'the ledger is held');
    A.ok(/delivery ledger cannot be written \(UPDATE_MUTATIONS_FROZEN\); holding outbound, retrying/.test(ledger.health().detail), 'health names the hold: ' + ledger.health().detail);
    await ledger.drive('telegram|8');
    A.eq(s.calls.length, 1, 'every lane holds while the ledger is dirty, other chats included');
    A.eq(timers.list.map(t => t.ms), [1000], 'the write is retried at 1 s');
    await timers.fire();
    A.eq(timers.list.map(t => t.ms), [2000], 'still frozen: 2 s');
    io.failCode = '';
    await timers.fire();
    await settle();
    A.eq(s.calls.map(c => c.text).sort(), ['other chat', 'p1', 'p2', 'p3'], 'thawed: the lanes resume where they were, p1 is never sent twice');
    A.eq(ledger.health().held, false, 'and the hold is lifted');
  }
  {
    // holding(): the update barrier starts no part
    let hold = true;
    const { ledger, timers } = mk({ deps: { holding: () => hold } });
    const s = makeSender();
    ledger.attach('telegram', s);
    ledger.enqueue(reply(7, 'reply:r', ['x']));
    await ledger.drive('telegram|7');
    A.eq(s.calls.length, 0, 'while holding() is true no lane starts a part');
    hold = false;
    await timers.fire();
    A.eq(s.calls.length, 1, 'once the barrier lowers the lane goes');
  }
  {
    // a failed ANSWER write: the reply waits in memory, its receipts are out of recovery, the retry sends it
    const { io, ledger, timers } = mk();
    const s = makeSender();
    ledger.attach('telegram', s);
    ledger.receive({ id: 'telegram|7|1', channel: 'telegram', chatId: '7', message: msg(7, 1) });
    io.failNext = 1;
    const d = ledger.answer(['telegram|7|1'], reply(7, 'reply:held', ['the finished reply']));
    const first = ledger.whenAttempted(d.id, null);
    ledger.drive('telegram|7');
    A.eq((await first).queued, true, 'the reply cannot go before its record is durable');
    A.eq(ledger.pending('telegram'), [], 'its receipt is out of recovery (the answer stands in memory)');
    A.eq(io.disk().receipts.length, 1, 'on disk the receipt is still there, so a crash now replays it under the attempt rule');
    await timers.fire();
    await settle();
    A.eq(s.calls.map(c => c.text), ['the finished reply'], 'the retry lands the write and the reply goes once');
  }
  {
    // an unreadable file: receipts are refused, lanes hold, what was decided meanwhile is merged when it reads
    const io = fakeIo();
    const pre = mk({ io });
    pre.ledger.receive({ id: 'telegram|7|1', channel: 'telegram', chatId: '7', message: msg(7, 1) });
    io.readFail = Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    const { ledger, timers } = mk({ io });
    A.throws(() => ledger.receive({ id: 'telegram|7|2', channel: 'telegram', chatId: '7', message: msg(7, 2) }), 'an unreadable ledger refuses a receipt (never acknowledged, never written over the real file)');
    A.ok(/cannot be read \(EBUSY\)/.test(ledger.health().detail), 'health names it');
    const s = makeSender();
    ledger.attach('telegram', s);
    ledger.enqueue(reply(9, 'reply:tap', ['an answer to a tap']));
    await ledger.drive('telegram|9');
    A.eq(s.calls.length, 0, 'no lane drives over a document it could not read');
    io.readFail = null;
    await timers.fire();
    await settle();
    A.eq(ledger.pending('telegram').map(x => x.id), ['telegram|7|1'], 'read: the earlier receipt is there');
    A.eq(s.calls.map(c => c.text), ['an answer to a tap'], 'and the reply decided meanwhile was merged in and delivered');
  }

  // ---- E. backpressure ----
  {
    const { ledger } = mk({ deps: { limits: { laneMaxDeliveries: 2 } } });
    ledger.enqueue(reply(7, 'reply:1', ['one']));
    ledger.enqueue(reply(7, 'reply:2', ['two']));
    const r = ledger.receive({ id: 'telegram|7|9', channel: 'telegram', chatId: '7', message: msg(7, 9) });
    A.eq(r.deferred, true, 'a chat that owes its mark of replies gets new work deferred (kept, not run)');
    A.eq(ledger.receive({ id: 'telegram|8|1', channel: 'telegram', chatId: '8', message: msg(8, 1) }).deferred, false, 'another chat is not');
    ledger.answer([], reply(7, 'reply:3', ['three']));
    A.eq(ledger.deliveries('telegram|7').length, 3, 'a finished reply is never refused for capacity');
    const s = makeSender();
    ledger.attach('telegram', s);
    await ledger.drive('telegram|7');
    A.eq(ledger.laneFull('telegram|7'), false, 'drained: the lane is under its mark');
    A.eq(ledger.receive({ id: 'telegram|7|10', channel: 'telegram', chatId: '7', message: msg(7, 10) }).deferred, true, 'a newer receipt still waits behind the deferred one (order)');
    A.eq(ledger.undefer('telegram|7|9'), true, 'recovery takes the oldest first');
    const chars = mk({ deps: { limits: { laneMaxChars: 10 } } }).ledger;
    chars.enqueue(reply(7, 'reply:long', ['x'.repeat(12)]));
    A.eq(chars.receive({ id: 'telegram|7|1', channel: 'telegram', chatId: '7', message: msg(7, 1) }).deferred, true, 'unsent characters count toward the mark too');
    A.eq([DEFAULTS.laneMaxDeliveries, DEFAULTS.laneMaxChars, DEFAULTS.maxPendingPerChannel], [20, 200000, 200], 'the production marks');
  }

  // ---- F. the dead mark ----
  {
    const { io, ledger } = mk();
    const s = makeSender();
    ledger.enqueue(reply(7, 'reply:q1', ['queued one']));
    ledger.enqueue(reply(7, 'reply:q2', ['queued two']));
    ledger.enqueue(reply(8, 'reply:keep', ['other chat']));
    const w0 = io.writes;
    const gone = ledger.markDead('telegram|7', 'kicked');
    A.eq(io.writes - w0, 1, 'one write');
    A.eq([gone.map(t => t.id), gone.map(t => t.reason)], [['reply:q1', 'reply:q2'], ['redelivery-gave-up', 'redelivery-gave-up']], 'its queued replies become tombstones in it');
    A.eq(ledger.deliveries().map(d => d.id), ['reply:keep'], 'no other chat is touched');
    ledger.attach('telegram', s);
    await ledger.drive('telegram|8');
    s.plan = [{ ok: false, error: 'Bad Gateway', retryable: true }];
    ledger.enqueue(reply(7, 'reply:later', ['later']));
    await ledger.drive('telegram|7');
    A.eq(s.calls.filter(c => c.chatId === '7').map(c => c.text), ['later'], 'the mark never stops a transport attempt: one send');
    A.eq(io.disk().tombstones.map(t => t.id).pop(), 'reply:later', 'its failure on a dead chat gives it up instead of piling retries');
    ledger.enqueue(reply(7, 'reply:back', ['back']));
    await ledger.drive('telegram|7');
    A.eq(ledger.chat('telegram|7').dead, null, 'a reply that lands clears the mark');
    ledger.markDead('telegram|7', 'left');
    ledger.receive({ id: 'telegram|7|5', channel: 'telegram', chatId: '7', message: msg(7, 5) });
    A.eq(ledger.chat('telegram|7').dead, null, 'so does the chat speaking (it rides the receipt write)');
    ledger.markDead('telegram|7', 'kicked');
    A.eq(ledger.clearDead('telegram|7'), true, 'and an explicit clear (membership member/administrator/creator/restricted)');
  }

  // ---- G. release, TTL, bounds ----
  {
    const { ledger } = mk();
    const s = makeSender();
    ledger.attach('telegram', s);
    ledger.enqueue(reply(7, 'routine:j:r:t', ['digest'], { release: 'caller' }));
    await ledger.drive('telegram|7');
    A.eq(ledger.delivery('routine:j:r:t').state, 'done', 'a caller record stays, done, after its last part');
    A.ok(ledger.enqueue(reply(7, 'routine:j:r:t', ['digest'], { release: 'caller' })).state === 'done' && s.calls.length === 1, 'asked again it returns that record and sends nothing');
    A.eq(ledger.release('routine:j:r:t'), true, 'its caller releases it');
    A.eq(ledger.delivery('routine:j:r:t'), null, 'and it leaves');
    ledger.enqueue(reply(7, 'routine:j:r2:t', ['digest two'], { release: 'caller' }));
    await ledger.drive('telegram|7');
    T += 8 * 24 * 60 * 60 * 1000;
    ledger.enqueue(reply(7, 'reply:tick', ['tick']));
    A.eq(ledger.delivery('routine:j:r2:t'), null, 'a done record never released is pruned after 7 days');
  }
  {
    const { ledger } = mk();
    const s = makeSender();
    s.send = function (chatId, text) { s.calls.push({ text }); return Promise.resolve({ ok: false, error: 'chat not found', retryable: false }); };
    ledger.attach('telegram', s);
    for (let i = 0; i < 55; i++) ledger.enqueue(reply(7, 'reply:t' + i, ['x' + i]));
    await ledger.drive('telegram|7');
    A.eq(ledger.tombstones('telegram').length, 50, 'tombstones: the last 50 per channel');
    T += 31 * 24 * 60 * 60 * 1000;
    ledger.enqueue({ id: 'reply:d', channel: 'discord', chatId: '1', parts: ['x'] });
    A.eq(ledger.tombstones('telegram').length, 0, 'within 30 days');
  }

  // ---- I. parts that are not words (S4): a routine's files and its missed-file note ----
  {
    const { io, ledger } = mk();
    const s = makeSender();
    ledger.attach('telegram', s);
    const handled = [];
    const rec = reply(7, 'routine:j:r3:t', ['words'], { kind: 'routine', release: 'caller' });
    rec.parts = [{ n: 0, text: 'words' }, { kind: 'file', n: 1, path: 'charts/a.png', agents: ['nova'] }, { kind: 'file', n: 2, path: 'big.pdf' }, { kind: 'note', n: 3, missed: ['dropped.png'] }];
    ledger.enqueue(rec);
    await ledger.drive('telegram|7');
    A.eq(s.calls.length, 1, 'the words went; a file part waits while no handler is attached, like a lane with no sender');
    A.eq(ledger.delivery('routine:j:r3:t').parts.map(p => p.sent), [true, false, false, false], 'and nothing past the words is marked');
    ledger.attachParts({
      file: async (d, part, ctx) => { handled.push(['file', part.path, ctx.key]); return part.path === 'big.pdf' ? { ok: false, error: 'file is too large', retryable: false } : { ok: true, messageId: 'f1' }; },
      note: async (d, part) => {
        const missed = d.parts.filter(p => p.kind === 'file' && p.error).map(p => p.path).concat(part.missed);
        handled.push(['note', missed.join(',')]);
        return { ok: true, said: 'Note: ' + missed.join(', ') };
      }
    });
    await settle();
    const done = ledger.delivery('routine:j:r3:t');
    A.eq(handled.map(h => h.slice(0, 2)), [['file', 'charts/a.png'], ['file', 'big.pdf'], ['note', 'big.pdf,dropped.png']], 'attached, the handlers send the files, then the note naming what did not come');
    A.eq(handled[0][2], partKey('routine:j:r3:t', 1), 'a file part carries its own idempotency key');
    A.eq([done.state, done.parts.map(p => p.sent)], ['done', [true, true, true, true]], 'the record is done: every part marked');
    A.eq(done.parts[2].error, 'file is too large', 'a file that cannot go is marked with its error, never retried: its words already landed');
    A.eq(done.parts[3].text, 'Note: big.pdf, dropped.png', 'the note records what it said');
    A.eq(io.disk().deliveries[0].parts.map(p => p.kind), ['text', 'file', 'file', 'note'], 'the parts are durable with their kinds');
    // a file refused for the moment waits on the lane's backoff, a bounded number of times, and the words stay marked
    const retry = mk({ timers: fakeTimers() });
    const sr = makeSender();
    retry.ledger.attach('telegram', sr);
    let ups = 0;
    const said = [];
    retry.ledger.attachParts({
      file: async () => (++ups <= 2 ? { ok: false, error: '429: slow down', retryable: true, retryAfter: 7 } : { ok: true, messageId: 'f9' }),
      note: async (d) => { said.push(d.parts.filter(p => p.kind === 'file' && p.error).map(p => p.path).join(',')); return { ok: true, empty: true, said: '' }; }
    });
    const rr = reply(20, 'routine:j:r20:t', ['w'], { kind: 'routine', release: 'caller' });
    rr.parts = [{ n: 0, text: 'w' }, { kind: 'file', n: 1, path: 'a.png' }, { kind: 'note', n: 2 }];
    retry.ledger.enqueue(rr);
    await retry.ledger.drive('telegram|20');
    const rec20 = () => retry.ledger.delivery('routine:j:r20:t');
    A.eq([ups, rec20().state, rec20().parts[1].sent, rec20().parts[1].tries, retry.io.disk().deliveries[0].parts[1].tries], [1, 'queued', false, 1, 1], 'a file refused for the moment is not given up: its try is durable');
    A.eq(retry.timers.list.map(t => t.ms), [7000], 'it waits on the lane\'s backoff, honoring retry_after');
    await retry.timers.fire();
    await retry.timers.fire();
    A.eq([ups, rec20().state, rec20().parts[1].error, said, sr.calls.length], [3, 'done', undefined, [''], 1], 'it lands on a retry, the note has nothing to say, and the words went once');
    const last = mk({ timers: fakeTimers() });
    const sl = makeSender();
    last.ledger.attach('telegram', sl);
    let tried = 0, noted = '';
    last.ledger.attachParts({
      file: async () => { tried++; return { ok: false, error: '502', retryable: true }; },
      note: async (d) => { noted = d.parts.filter(p => p.kind === 'file' && p.error).map(p => p.path + ':' + p.error).join(','); return { ok: true, said: 'Note' }; }
    });
    const rl = reply(21, 'routine:j:r21:t', ['w'], { kind: 'routine', release: 'caller' });
    rl.parts = [{ n: 0, text: 'w' }, { kind: 'file', n: 1, path: 'b.png' }, { kind: 'note', n: 2 }];
    last.ledger.enqueue(rl);
    await last.ledger.drive('telegram|21');
    for (let i = 0; i < DEFAULTS.partRetries; i++) await last.timers.fire();
    A.eq([tried, noted, last.ledger.delivery('routine:j:r21:t').state, sl.calls.length], [DEFAULTS.partRetries + 1, 'b.png:502', 'done', 1], 'a refusal that lasts is told, and the record finishes: a file never holds its chat\'s lane for good');
    // an upload a shutdown cut short is tried again; a refused credential holds it as it holds the words
    const timers = fakeTimers();
    const two = mk({ timers });
    const s2 = makeSender();
    two.ledger.attach('telegram', s2);
    let tries = 0;
    two.ledger.attachParts({ file: async () => (++tries === 1 ? { ok: false, error: 'aborted', retryable: false } : { ok: true }), note: async () => ({ ok: true, empty: true, said: '' }) });
    const r2 = reply(8, 'routine:j:r4:t', ['w'], { kind: 'routine', release: 'caller' });
    r2.parts = [{ n: 0, text: 'w' }, { kind: 'file', n: 1, path: 'x.png' }];
    two.ledger.enqueue(r2);
    await two.ledger.drive('telegram|8');
    A.eq([tries, two.ledger.delivery('routine:j:r4:t').parts[1].sent], [1, false], 'an aborted upload is not marked: it is tried again');
    await timers.fire();
    A.eq([tries, two.ledger.delivery('routine:j:r4:t').state], [2, 'done'], 'and goes on the lane\'s retry');
    // a routine's parts go as written: no delayed-reply line, whatever failed before
    const three = mk({ timers: fakeTimers() });
    const s3 = makeSender();
    s3.plan = [{ ok: false, error: '502', retryable: true }];
    three.ledger.attach('telegram', s3);
    three.ledger.enqueue(reply(9, 'routine:j:r5:t', ['digest'], { kind: 'routine', release: 'caller' }));
    await three.ledger.drive('telegram|9');
    await three.timers.fire();
    A.eq(s3.calls.map(c => c.text), ['digest', 'digest'], 'a routine\'s part is resent as written (its title says what it is): no delayed-reply line');
    // a tombstone says how far its delivery got (a caller that keeps asking must never send those parts again), across a load
    const fourIo = memoryIo();
    const four = makeDeliveryLedger({ io: fourIo, clock: { now: () => 5 }, timers: fakeTimers() });
    const s4 = makeSender();
    s4.plan = ['ok', { ok: false, error: 'chat not found', retryable: false }];
    four.attach('telegram', s4);
    four.enqueue(reply(10, 'routine:j:r6:t', ['one', 'two'], { kind: 'routine', release: 'caller' }));
    await four.drive('telegram|10');
    A.eq(four.tombstones().map(t => [t.id, t.sent]), [['routine:j:r6:t', 1]], 'a tombstone counts the parts that had landed');
    const fourAgain = makeDeliveryLedger({ io: fourIo, clock: { now: () => 6 } });
    fourAgain.load();
    A.eq(fourAgain.snapshot().tombstones.map(t => t.sent), [1], 'and that survives a load');
    four.enqueue(reply(11, 'routine:j:r7:t', ['one'], { kind: 'routine', release: 'caller' }));
    s4.plan = [{ ok: false, error: 'chat not found', retryable: false }];
    await four.drive('telegram|11');
    A.eq(four.tombstones().find(t => t.id === 'routine:j:r7:t').sent, undefined, 'a delivery nothing of which landed has no such field');
    // a caller takes back a record nothing of which has gone; a part that landed, or one on the wire, keeps it
    const five = mk({ timers: fakeTimers() });
    const s5 = makeSender();
    s5.plan = [{ ok: false, error: '502', retryable: true }];
    five.ledger.attach('telegram', s5);
    five.ledger.enqueue(reply(12, 'routine:j:r8:t', ['one', 'two'], { kind: 'routine', release: 'caller' }));
    await five.ledger.drive('telegram|12');
    A.eq([five.ledger.withdraw('routine:j:r8:t'), five.ledger.delivery('routine:j:r8:t'), five.io.disk().deliveries.length], [true, null, 0], 'withdraw: a record nothing of which went leaves, durably');
    await five.timers.fire();
    A.eq(s5.calls.length, 1, 'withdraw: and its lane sends nothing more');
    s5.plan = ['ok', { ok: false, error: '502', retryable: true }];
    five.ledger.enqueue(reply(12, 'routine:j:r9:t', ['one', 'two'], { kind: 'routine', release: 'caller' }));
    await five.ledger.drive('telegram|12');
    A.eq([five.ledger.withdraw('routine:j:r9:t'), !!five.ledger.delivery('routine:j:r9:t')], [false, true], 'withdraw: a record a part of which landed stays: it finishes');
    A.eq(five.ledger.withdraw('routine:j:none'), false, 'withdraw: an unknown id is nothing to take back');
    const six = mk({ timers: fakeTimers() });
    let land;
    const s6 = makeSender({ send: () => new Promise((r) => { land = r; }) });
    six.ledger.attach('telegram', s6);
    six.ledger.enqueue(reply(13, 'routine:j:r10:t', ['one'], { kind: 'routine', release: 'caller' }));
    const going = six.ledger.drive('telegram|13');
    await settle();
    A.eq([six.ledger.onWire('routine:j:r10:t'), six.ledger.withdraw('routine:j:r10:t')], [true, false], 'withdraw: a part on the wire keeps it, though nothing has landed yet');
    land({ ok: true, messageId: 'm1' });
    await going;
    A.eq([six.ledger.onWire('routine:j:r10:t'), six.ledger.delivery('routine:j:r10:t').state], [false, 'done'], 'and it finishes');
    // a topic that is gone leaves the chat's durable route and tells the hub which topic; one the chat moved on from stays
    const seven = mk({ timers: fakeTimers() });
    const forgot = [];
    const s7 = makeSender({ forgetThread: (chatId, threadId) => forgot.push([chatId, threadId]) });
    seven.ledger.attach('telegram', s7);
    seven.ledger.receive({ id: 'telegram|14|1', channel: 'telegram', chatId: '14', message: msg(14, 1), route: { threadId: 'T1' } });
    A.eq([seven.ledger.forgetThread('telegram|14', 'OLD'), seven.ledger.chat('telegram|14').route], [false, { threadId: 'T1' }], 'a topic the chat moved on from leaves its route alone');
    const writes = seven.io.writes;
    A.eq([seven.ledger.forgetThread('telegram|14', 'T1'), seven.ledger.chat('telegram|14').route, seven.io.writes - writes, seven.io.disk().chats['telegram|14'].route], [true, null, 1, null], 'a gone topic leaves the durable route, in one write');
    A.eq(forgot, [['14', 'OLD'], ['14', 'T1']], 'and the hub is told which topic, so its book drops only that one');
    A.eq(seven.ledger.forgetThread('telegram|14', ''), false, 'no topic: nothing to forget');
    // a caller only asking how a delivery goes is told, and reports nothing: no send of its own failed
    const eight = mk({ timers: fakeTimers() });
    const s8 = makeSender();
    s8.plan = [{ ok: false, error: '502', retryable: true }];
    eight.ledger.attach('telegram', s8);
    eight.ledger.enqueue(reply(15, 'routine:j:r11:t', ['one'], { kind: 'routine', release: 'caller' }));
    const firstTry = eight.ledger.whenAttempted('routine:j:r11:t', null);
    await eight.ledger.drive('telegram|15');
    A.eq([(await firstTry).queued, s8.events.map(e => [e.ok, e.reason])], [true, [[false, 'done']]], 'a failed first attempt reports itself, once');
    const asked = eight.ledger.whenAttempted('routine:j:r11:t', { quiet: true });
    await eight.ledger.drive('telegram|15');
    A.eq([(await asked).queued, s8.events.length], [true, 1], 'an ask while the lane backs off is answered, and reports nothing');
    await eight.timers.fire();
    A.eq(s8.events.map(e => e.ok), [false, true], 'and its landing is reported, once');
    // a caller's one-time side effect is marked once
    A.eq([three.ledger.noteSession('routine:j:r5:t'), three.ledger.noteSession('routine:j:r5:t')], [true, false], 'noteSession: true the first time only');
  }

  // ---- J. a stamp is an edit (S6) ----
  const stampOf = (chat, id, text) => ({ id: id, channel: 'telegram', chatId: String(chat), reason: 'stamp', runId: 'r1', edit: { messageId: 'kb1', promptId: 'p1', text: text || 'the ask\n\n▸ stamped', strip: true } });
  const anAsk = (chat, id, extra) => Object.assign({ id: id, channel: 'telegram', chatId: String(chat), messageId: 'kb1', runId: 'r1', promptId: 'p1', text: 'the ask' }, extra || {});
  {
    const { io, ledger } = mk();
    const s = makeSender();
    ledger.attach('telegram', s);
    const w0 = io.writes;
    ledger.openAsk(anAsk(7, 'consent:r1:p1'));
    A.eq(io.writes - w0, 1, 'an open ask is one write');
    A.eq(io.disk().openAsks, [{ id: 'consent:r1:p1', chat: 'telegram|7', channel: 'telegram', chatId: '7', messageId: 'kb1', runId: 'r1', promptId: 'p1', text: 'the ask', boot: 'boot-1', at: T }], 'and it is on disk with what a restart needs to close it');
    const w1 = io.writes;
    const d = ledger.stamp(stampOf(7, 'consent:r1:p1'));
    A.eq(io.writes - w1, 1, 'the ask leaves and its stamp enters the lane in ONE write');
    A.eq([io.disk().openAsks, io.disk().deliveries.map(x => [x.id, x.kind, x.edit])], [[], [['consent:r1:p1', 'edit', { messageId: 'kb1', promptId: 'p1', text: 'the ask\n\n▸ stamped', strip: true }]]], 'the record that write left says so');
    A.eq(ledger.stamp(stampOf(7, 'consent:r1:p1')), d, 'the same stamp again returns its record');
    await ledger.drive('telegram|7');
    A.eq(s.calls, [{ op: 'edit', chatId: '7', messageId: 'kb1', text: 'the ask\n\n▸ stamped' }], 'one edit, no send');
    A.eq(s.events, [], 'it says nothing new to the chat: no channel.delivery');
    A.eq(ledger.deliveries(), [], 'and it leaves with its one edit');
  }
  {
    // one lane: a stamp goes in its turn, and the reply behind it waits for it
    const { ledger } = mk();
    const s = makeSender();
    ledger.enqueue(reply(7, 'reply:a', ['first']));
    ledger.stamp(stampOf(7, 'consent:r1:p1'));
    ledger.enqueue(reply(7, 'reply:b', ['second']));
    ledger.attach('telegram', s);
    await ledger.drive('telegram|7');
    await settle();
    A.eq(s.calls.map(c => c.op + ':' + (c.text || '').split('\n')[0]), ['send:first', 'edit:the ask', 'send:second'], 'FIFO: stamps ride the chat\'s lane in their turn');
  }
  {
    // a refusal for the moment waits on this lane's backoff, and only this lane's; 'not modified' is the edit already made
    const { ledger, timers } = mk();
    const s = makeSender();
    ledger.attach('telegram', s);
    s.editPlan = [{ ok: false, error: 'Too Many Requests: retry after 7', retryable: true, retryAfter: 7 }, { ok: false, error: 'Bad Request: message is not modified', retryable: false }];
    ledger.stamp(stampOf(7, 'consent:r1:p1'));
    await ledger.drive('telegram|7');
    A.eq(timers.list.map(t => t.ms), [7000], 'a 429 backs the lane off, honouring retry_after');
    ledger.enqueue(reply(8, 'reply:other', ['other chat']));
    await ledger.drive('telegram|8');
    A.eq(s.calls.filter(c => c.op === 'send').map(c => c.chatId), ['8'], 'no other chat waits for it');
    await timers.fire();
    A.eq(s.calls.filter(c => c.op === 'edit').length, 2, 'the lane tries again');
    A.eq([ledger.deliveries(), ledger.tombstones()], [[], []], '"message is not modified" means the edit is made: done, and no tombstone');
    A.eq(s.events.filter(e => e.reason === 'stamp' || e.chunks === 0), [], 'no channel.delivery about it');
  }
  {
    // a failure that does not say whether it would pass is tried again, like a send's
    const { ledger, timers } = mk();
    const s = makeSender();
    ledger.attach('telegram', s);
    s.editPlan = [{ ok: false, error: 'network error' }];
    ledger.stamp(stampOf(7, 'consent:r1:p1'));
    await ledger.drive('telegram|7');
    await timers.fire();
    A.eq([s.calls.length, ledger.deliveries()], [2, []], 'a failure with no verdict is retried');
  }
  {
    // a sender whose edit throws, or answers nothing (a test fake): a throw is a failure, nothing at all is an edit made
    const { ledger, timers } = mk();
    const s = makeSender();
    let thrown = 0;
    s.editMessage = () => { if (!thrown++) throw new Error('boom'); return undefined; };
    ledger.attach('telegram', s);
    ledger.stamp(stampOf(7, 'consent:r1:p1'));
    await ledger.drive('telegram|7');
    A.eq(ledger.deliveries().length, 1, 'an edit that throws is kept for a retry');
    await timers.fire();
    A.eq([thrown, ledger.deliveries()], [2, []], 'and one that answers nothing has landed');
  }
  {
    // a message that is gone, in silence; a refusal for good, one line; neither is ever retried or reported as a reply
    const { ledger, logs, timers } = mk();
    const s = makeSender();
    ledger.attach('telegram', s);
    s.editPlan = [{ ok: false, error: 'Bad Request: message to edit not found', retryable: false }, { ok: false, error: 'Bad Request: message can\'t be edited', retryable: false }];
    ledger.stamp(stampOf(7, 'consent:r1:p1'));
    await ledger.drive('telegram|7');
    A.eq([ledger.deliveries(), ledger.tombstones().map(t => [t.id, t.reason]), logs, timers.list], [[], [['consent:r1:p1', 'keyboard-gone']], [], []], 'a message that is gone leaves in silence: a tombstone, no line, no retry');
    ledger.stamp(stampOf(7, 'consent:r1:p2'));
    await ledger.drive('telegram|7');
    A.eq(ledger.tombstones().map(t => t.reason), ['keyboard-gone', 'stamp-gave-up'], 'a refusal for good is a tombstone');
    A.eq(logs.length, 1, 'said once, on the console');
    A.ok(/could not be stamped/.test(logs[0]), 'in words that are about a keyboard: ' + logs[0]);
    A.eq([s.calls.length, s.events], [2, []], 'tried once each, and no channel.delivery calls anything undeliverable');
  }
  {
    // a stamp refused on and on is given up after its bounded retries, and the reply behind it lands: no 'delayed' event
    const { ledger, logs, timers } = mk({ deps: { limits: { stampRetries: 2, escalateTries: 2 } } });
    const s = makeSender();
    ledger.attach('telegram', s);
    const fail = { ok: false, error: 'Bad Gateway', retryable: true };
    s.editPlan = [fail, fail, fail, fail];
    ledger.stamp(stampOf(7, 'consent:r1:p1'));
    ledger.enqueue(reply(7, 'reply:behind', ['the reply behind it']));
    await ledger.drive('telegram|7');
    await timers.fire();
    A.eq(s.calls.filter(c => c.op === 'send').length, 0, 'it holds the lane while it has retries left');
    await timers.fire();
    A.eq(s.calls.map(c => c.op), ['edit', 'edit', 'edit', 'send'], 'then it is given up, and the reply behind it lands');
    A.eq(ledger.tombstones().map(t => t.reason), ['stamp-gave-up'], 'a tombstone');
    A.eq(logs.length, 1, 'one console line');
    A.eq(s.events.filter(e => e.reason !== 'redelivered' && e.ok === true), [], 'and the reply reports as delayed: it did wait');
    A.eq(s.events.filter(e => /delayed|undeliverable/.test(e.reason)), [], 'no redelivery-delayed or undeliverable is about the stamp');
  }
  {
    // a refused credential holds the stamp with the channel's lanes, and does not spend its retries
    const { ledger } = mk({ deps: { limits: { stampRetries: 0 } } });
    const s = makeSender();
    ledger.attach('telegram', s);
    s.editPlan = [{ ok: false, error: 'Unauthorized', retryable: false, auth: true }];
    ledger.stamp(stampOf(7, 'consent:r1:p1'));
    await ledger.drive('telegram|7');
    A.eq([ledger.deliveries().length, ledger.tombstones()], [1, []], 'a refused credential keeps it: the bot is not this message\'s problem');
    await ledger.kick('telegram', { reset: true });
    await settle();
    A.eq(ledger.deliveries(), [], 'and the next up sends it');
  }
  {
    // a channel that cannot edit: the stamp cannot hang its lane
    const { ledger, logs } = mk();
    const s = makeSender();
    delete s.editMessage;
    ledger.attach('telegram', s);
    ledger.stamp(stampOf(7, 'consent:r1:p1'));
    await ledger.drive('telegram|7');
    A.eq([ledger.deliveries(), ledger.tombstones().map(t => t.reason), logs.length], [[], ['stamp-gave-up'], 1], 'a sender with no editMessage gives the stamp up at once');
  }
  {
    // a chat that removed this bot: its queued stamps go with its replies, and only the replies are said
    const { ledger, timers } = mk();
    const s = makeSender();
    ledger.stamp(stampOf(7, 'consent:r1:p1'));
    ledger.enqueue(reply(7, 'reply:q', ['queued']));
    const gone = ledger.markDead('telegram|7', 'kicked');
    A.eq(gone.map(t => t.id), ['reply:q'], 'markDead reports the replies, never a stamp');
    A.eq(ledger.deliveries(), [], 'and the stamp left with them');
    // ...and a stamp on a chat marked dead gets one try, like a reply
    ledger.attach('telegram', s);
    s.editPlan = [{ ok: false, error: 'Forbidden: bot was blocked by the user', retryable: true }];
    ledger.stamp(stampOf(7, 'consent:r1:p2'));
    await ledger.drive('telegram|7');
    A.eq([s.calls.length, ledger.deliveries(), timers.list], [1, [], []], 'a stamp on a dead chat is not retried');
    A.eq(s.events, [], 'and nothing is said about it');
  }
  {
    // AN OPEN ASK SURVIVES THE PROCESS AND NAMES ITSELF TO THE NEXT BOOT, on its own channel, and never to its own boot
    const io = fakeIo();
    const one = mk({ io: io, bootId: 'boot-1' }).ledger;
    one.openAsk(anAsk(7, 'consent:r1:p1'));
    one.openAsk(anAsk(8, 'consent:r2:p2', { channel: 'telegram:bot2', runId: 'r2', promptId: 'p2' }));
    A.eq(one.asksLeftOpen('telegram'), [], 'this boot\'s own asks are alive: none is left open');
    const two = mk({ io: io, bootId: 'boot-2' }).ledger;
    A.eq(two.asksLeftOpen('telegram').map(a => [a.id, a.chatId, a.messageId, a.text]), [['consent:r1:p1', '7', 'kb1', 'the ask']], 'the next boot finds what is left, with what it needs to stamp it');
    A.eq(two.asksLeftOpen('telegram:bot2').map(a => a.id), ['consent:r2:p2'], 'one channel at a time');
    two.stamp(stampOf(7, 'consent:r1:p1', 'closed'));
    A.eq(two.asksLeftOpen('telegram'), [], 'the stamp closes it');
    const three = mk({ io: io, bootId: 'boot-3' }).ledger;
    three.load();
    A.eq(three.deliveries().map(d => [d.id, d.kind, d.edit && d.edit.text]), [['consent:r1:p1', 'edit', 'closed']], 'a queued stamp survives a restart');
    T += 8 * 24 * 60 * 60 * 1000;
    three.enqueue(reply(9, 'reply:later', ['later']));
    A.eq(io.disk().openAsks, [], 'an ask left open on a channel that never came back is dropped after 7 days');
    const live = mk({ bootId: 'boot-4' }).ledger;
    live.openAsk(anAsk(7, 'consent:r3:p3'));
    T += 8 * 24 * 60 * 60 * 1000;
    live.enqueue(reply(9, 'reply:x', ['x']));
    A.eq(live.snapshot().openAsks.length, 1, 'but never one of this boot\'s');
  }
  {
    // the document read back: a stamp and an ask that are not whole are dropped, never thrown
    const io = fakeIo();
    io.write({ version: 1, receipts: [], tombstones: [], chats: {}, migrated: {},
      deliveries: [{ id: 'consent:x:y', channel: 'telegram', chatId: '7', kind: 'edit', parts: [], edit: { messageId: '', text: 'no message to edit' } }],
      openAsks: [null, 'nope', { id: 'consent:a:b' }, { id: 'consent:c:d', channel: 'telegram', chatId: '7', messageId: 'kb9', text: 5 }] });
    const { ledger } = mk({ io: io });
    A.eq(ledger.asksLeftOpen('telegram').map(a => [a.id, a.text]), [['consent:c:d', '']], 'an open ask needs its channel, chat and message; the rest is dropped');
    const s = makeSender();
    ledger.attach('telegram', s);
    await settle();
    A.eq([ledger.deliveries(), s.calls], [[], []], 'an edit with no message leaves its lane at once, with nothing sent');
  }
  {
    // write failure: an ask or a stamp that cannot be written stays in memory, nothing starts, and the retry lands it
    const { io, ledger, timers } = mk();
    const s = makeSender();
    ledger.attach('telegram', s);
    io.failCode = 'EBUSY';
    ledger.openAsk(anAsk(7, 'consent:r1:p1'));
    ledger.stamp(stampOf(7, 'consent:r1:p1'));
    await ledger.drive('telegram|7');
    A.eq(s.calls, [], 'a stamp that is not durable does not start');
    io.failCode = '';
    await timers.fire();
    await settle();
    A.eq([s.calls.length, ledger.deliveries(), io.disk().openAsks], [1, [], []], 'the retry lands it, and it goes');
  }
  {
    // ...and a lane that was waiting for the mutex looks again when it gets it: the ledger may have gone dirty meanwhile
    const { io, ledger } = mk();
    const s = makeSender();
    ledger.attach('telegram', s);
    let open = null;
    const held = ledger.sendEphemeral('telegram|7', () => new Promise((r) => { open = r; }));
    await settle();
    ledger.stamp(stampOf(7, 'consent:r1:p1'));
    const lane = ledger.drive('telegram|7');
    io.failCode = 'EBUSY';
    ledger.enqueue(reply(8, 'reply:dirty', ['a write that fails']));
    open();
    await held;
    await lane;
    await settle();
    A.eq(s.calls, [], 'a stamp already waiting for the lane starts nothing on a ledger that went dirty meanwhile');
    io.failCode = '';
  }
  {
    // read failure: an ask that opens while the file cannot be read joins what the file holds
    const io = fakeIo();
    io.write({ version: 1, receipts: [], deliveries: [], tombstones: [], chats: {}, migrated: {}, openAsks: [Object.assign(anAsk(7, 'consent:old:p'), { boot: 'boot-0', at: T })] });
    io.readFail = Object.assign(new Error('EBUSY: simulated'), { code: 'EBUSY' });
    const { ledger, timers } = mk({ io: io });
    ledger.openAsk(anAsk(8, 'consent:new:p'));
    A.eq(ledger.loaded, false, 'fixture: the file cannot be read');
    io.readFail = null;
    await timers.fire();
    A.eq(io.disk().openAsks.map(a => a.id), ['consent:old:p', 'consent:new:p'], 'both are on disk once it can');
  }

  // ---- H. helpers ----
  {
    A.ok(/^sn[0-9a-f]{16}$/.test(partKey('reply:r', 0)) && partKey('reply:r', 0).length <= 25, 'a part key fits a Discord nonce (25 characters)');
    A.eq(partKey('reply:r', 0), partKey('reply:r', 0), 'stable');
    A.ok(partKey('reply:r', 0) !== partKey('reply:r', 1), 'per part');
    A.eq(shortHash('abc').length, 16, 'the short hash is 16 hex');
    const mem = memoryIo();
    const L = makeDeliveryLedger({ io: mem, clock: { now: () => 1 } });
    L.enqueue({ id: 'reply:m', channel: 'dev', chatId: '1', parts: ['x'] });
    A.eq(mem.read().deliveries[0].id, 'reply:m', 'the memory IO keeps the same document, nothing on disk');
  }

  A.report('delivery-ledger.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
