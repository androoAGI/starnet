/* node test/channels.outbox.test.js — the durable outbound retry, on the DELIVERY LEDGER (channel-delivery-ledger S2).

   The store's outbox was one queue per channel: the first failing item stopped every pass for every chat, a refusal that
   could never succeed was retried for ever, a full queue refused a FINISHED reply (held on its receipt, replayed only when
   the whole channel drained), and recovery ran whenever the queue emptied. A reply is now a delivery in its chat's FIFO
   lane in the ledger (channels/delivery-ledger.js), written in the same write that takes its message's receipt away, sent
   part by part with each landed part marked. Every case runs the REAL hub over the REAL store on an in-memory disk, with
   the ledger's timers and the hub's recover timer held by hand. Proves:
     A.  a failed reply is kept in its chat's lane, marked delayed, its try counted; its receipt left with the answer
     A2. a runId-less reply's id is never reused by a restarted process
     B.  a finished reply is NEVER refused: a chat that owes its mark of replies has its new message DEFERRED — kept, not
         run — and the recover timer runs it once the lane drains, its tool step once (was: the full outbox refused the
         reply, which was held on the receipt; that rule and outbox.json are gone)
     B2. intake receipts: idempotent, bounded per channel (another channel is never refused), and they survive a restart
     B3. the receipt exists before onInbound returns, the answer takes it away, and a crash survivor replays on 'up'
     C/D. the kept reply goes out on the adapter's next 'up', reported once as redelivered
     E.  a reply an earlier process could not send goes as soon as a hub attaches (was: only after another healthy send)
     F.  command replies are never queued
     F2. outbound-only recovery retries itself: the lane's own timer, no new inbound or poll transition
     G.  a prolonged outage reports one escalation at 5 tries, and keeps the reply
     G2. a merged batch's answer write settles every one of its receipts; when its processing throws, every bubble's
         receipt stays with the run's attempt, and recovery then settles them all with ONE notice (never a re-run)
     H.  a part that landed is never sent again (part marks; was: the stored remainder)
     H2. a fenced reply's unsent parts go exactly as first cut: balanced, never re-split or re-fenced (was: the remainder
         rebuilt from the raw splits, H2 and H3)
     H4. retryable:false is a tombstone, reported once, never retried; an aborted send is kept
     H5. a refused credential (every real transport's auth:true) keeps the reply for the re-paired hub's 'up'
     I.  recovery runs on 'up' and its own timer, never on a delivery; a stale snapshot never replays a finished message
         (was: the outbox draining triggered recovery)
     J.  a reconnected hub never replays the old hub's in-flight message (the live claim is the store's ledger's)
     K.  a chat that keeps failing never holds another chat's reply (its lane backs off alone) */
'use strict';
const A = require('./_assert.js');
const pathMod = require('path');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeChannelHub, chunkTextParts } = require('../sidecar/channels/hub.js');

function memFs() {
  const files = new Map();
  return {
    files,
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); },
    renameSync(a, b) { if (!files.has(a)) { const e = new Error('ENOENT: ' + a); e.code = 'ENOENT'; throw e; } files.set(b, files.get(a)); files.delete(a); },
    mkdirSync() {}
  };
}
function fakeTimers() {
  const list = [];
  return {
    list,
    setTimeout(fn, ms) { const t = { fn, ms, unref() {} }; list.push(t); return t; },
    clearTimeout(t) { const i = list.indexOf(t); if (i >= 0) list.splice(i, 1); },
    async fire() { const due = list.splice(0); for (const t of due) t.fn(); await settle(); }
  };
}
const settle = async (n) => { for (let i = 0; i < (n || 40); i++) await new Promise(r => setImmediate(r)); };
let clk = 1000;
const clock = { now: () => clk };
const ROOT = '/ws/channels';
function world(opts) {
  const o = opts || {};
  const fs = o.fs || memFs(), timers = o.timers || fakeTimers();
  const store = makeChannelStore({ fs, pathMod, root: ROOT, clock, timers, ledgerLimits: o.limits });
  return { fs, timers, store, ledger: store.ledger };
}
const msg = (chatId, mid, text) => ({ channel: 'telegram', chatId: String(chatId), chatType: 'dm', userId: 'u1', text: text, messageId: String(mid), ts: 1 });
const answering = (text, extra) => async (o) => { o.emit('agent.run.start', { runId: o.runId }); if (extra) extra(o); o.emit('agent.token', { delta: text }); o.emit('agent.run.end', { reason: 'done' }); };
// a hub over the world's store, its recover timer on the same hand-held timers
function mkHub(w, sendImpl, events, extra) {
  let n = 0;
  return makeChannelHub(Object.assign({
    channel: 'telegram', runOnce: answering('the result'), store: w.store, send: sendImpl,
    secrets: () => ({ key: 'k', model: 'm', configured: true }),
    emit: (name, payload) => events.push([name, payload]),
    newId: () => 'run-' + (++n) + '-' + clk, sleep: () => Promise.resolve(),
    setTimeout: w.timers.setTimeout, clearTimeout: w.timers.clearTimeout
  }, extra || {}));
}
const deliveriesOf = (w, chatId) => w.ledger.deliveries('telegram|' + chatId);
const textOf = (d) => d.parts.map(p => p.text).join('');
const ev = (events, reason) => events.filter(e => e[0] === 'channel.delivery' && (!reason || e[1].reason === reason)).map(e => e[1]);

(async () => {
  // ---- A, C, D. a failed reply is kept in its chat's lane; the next 'up' redelivers it ----
  {
    const w = world(), events = [];
    let sendOk = false;
    const hub = mkHub(w, async () => (sendOk ? { ok: true } : { ok: false, error: 'net down' }), events);
    await hub.onInbound(msg('55', 'm1', 'do the thing'));
    const q = deliveriesOf(w, '55');
    A.eq(q.length, 1, 'the failed reply is kept in its chat\'s lane');
    A.ok(/the result/.test(textOf(q[0])), 'it is that reply');
    A.ok(q[0].delayed === true && q[0].tries === 1, 'marked delayed, its failed try counted (both durable)');
    A.eq(w.ledger.pending('telegram'), [], 'its receipt left in the answer write: the message can never run again');
    A.eq(ev(events).map(e => e.ok), [false], 'the failure emitted one channel.delivery, ok:false (no lie)');
    sendOk = true;
    hub.onStatus({ state: 'up' });
    await settle();
    A.eq(deliveriesOf(w, '55'), [], 'the next up drains it');
    A.eq(ev(events, 'redelivered').map(e => e.chatId), ['55'], 'one honest redelivered event, to the right chat');
    hub.close();
  }

  // ---- A2. a runId-less reply's id is never reused by a restarted process at the same clock tick ----
  {
    const fs = memFs();
    clk = 2100;
    const first = world({ fs }).ledger.enqueue({ channel: 'telegram', chatId: 'one', parts: ['first reply'] });
    const restarted = world({ fs });
    const second = restarted.ledger.enqueue({ channel: 'telegram', chatId: 'two', parts: ['second reply'] });
    A.ok(first.id !== second.id, 'a restart at the same clock tick never reuses a delivery id (each process has its own boot)');
    A.eq(restarted.ledger.deliveries().map(d => d.chatId), ['one', 'two'], 'and both replies stand');
  }

  // ---- B. backpressure BEFORE the paid run: a finished reply is never refused ----
  {
    const w = world({ limits: { laneMaxDeliveries: 1 } }), events = [], sends = [], steps = [];
    let sendOk = false;
    const hub = mkHub(w, async (chatId, text) => { sends.push({ chatId, text, ok: sendOk }); return sendOk ? { ok: true } : { ok: false, error: 'down' }; }, events, {
      runOnce: async (o) => {
        const words = String(o.messages[o.messages.length - 1].content);
        o.emit('agent.run.start', { runId: o.runId });
        o.emit('agent.tool_call', { runId: o.runId, callId: 'c', name: 'fs_append' }); steps.push(words);
        o.emit('agent.token', { delta: 'answer to ' + words }); o.emit('agent.run.end', { reason: 'done' });
      }
    });
    await hub.onInbound(msg('bp', 'm0', 'older work'));       // its reply fails: the chat now owes its mark of one reply
    const rejected = await hub.onInbound(msg('bp', 'm5', 'new work')).then(() => false, () => true);
    A.eq(rejected, false, 'the newer message is accepted (its receipt is durable): nothing is refused');
    A.eq(steps, ['older work'], 'but it is NOT run while its chat owes the older reply (backpressure before the paid run)');
    A.eq(w.ledger.pending('telegram').map(r => [r.id, r.deferred]), [['telegram|bp|m5', true]], 'it waits, deferred, in the ledger');
    A.eq(deliveriesOf(w, 'bp').length, 1, 'the older finished reply is kept whole (never refused, never evicted)');
    sendOk = true;
    hub.onStatus({ state: 'up' });                               // the lane drains...
    await settle();
    await w.timers.fire();                                       // ...and the recover timer runs the deferred message
    const got = sends.filter(x => x.ok).map(x => x.text.replace(/^⌛[^\n]*\n/, ''));
    A.eq(got, ['answer to older work', 'answer to new work'], 'both answers land, in order');
    A.eq(steps, ['older work', 'new work'], 'each message\'s tool step ran exactly once');
    A.eq(w.ledger.pending('telegram'), [], 'nothing is left pending');
    A.ok(!sends.some(x => /restarted/.test(x.text)), 'and nothing claims a restart');
    hub.close();
  }

  // ---- B2. intake receipts: idempotent, bounded per channel, durable ----
  {
    const fs = memFs();
    const w = world({ fs, limits: { maxPendingPerChannel: 2 } });
    const m77 = { chatId: '77', chatType: 'dm', userId: 'u', text: 'work', messageId: '9' };
    w.ledger.receive({ id: 'telegram|77|9', channel: 'telegram', chatId: '77', message: m77 });
    w.ledger.receive({ id: 'telegram|77|9', channel: 'telegram', chatId: '77', message: m77 });
    A.eq(w.ledger.pending('telegram').length, 1, 'a duplicate delivery creates one durable intake receipt');
    const restarted = world({ fs, limits: { maxPendingPerChannel: 2 } });
    A.eq(restarted.ledger.pending('telegram')[0].message.text, 'work', 'unfinished intake survives a store restart');
    restarted.ledger.receive({ id: 'telegram|78|10', channel: 'telegram', chatId: '78', message: Object.assign({}, m77, { chatId: '78', messageId: '10' }) });
    A.throws(() => restarted.ledger.receive({ id: 'telegram|79|11', channel: 'telegram', chatId: '79', message: Object.assign({}, m77, { chatId: '79', messageId: '11' }) }),
      'a channel holding its cap refuses acknowledgement instead of dropping older work');
    A.notThrows(() => restarted.ledger.receive({ id: 'discord|79|11', channel: 'discord', chatId: '79', message: Object.assign({}, m77, { chatId: '79', messageId: '11' }) }), 'another channel is never refused');
    A.eq(restarted.ledger.settle(['telegram|77|9']).settled, 1, 'completion settles exactly its receipt');
  }

  // ---- B3. the receipt is durable before onInbound returns; the answer takes it; a crash survivor replays on 'up' ----
  {
    const w = world(), sends = [], events = [];
    const hub = mkHub(w, async (chatId, text) => { sends.push({ chatId, text }); return { ok: true }; }, events);
    const running = hub.onInbound(msg('80', '30', 'normal work'));
    A.eq(w.ledger.pending('telegram').length, 1, 'the admitted message is durable synchronously, before processing runs');
    await running;
    A.eq(w.ledger.pending('telegram'), [], 'its answer took the receipt away');
    hub.close();
    w.ledger.receive({ id: 'telegram|81|31', channel: 'telegram', chatId: '81', message: msg('81', '31', 'survived crash') });
    const restartedHub = mkHub(w, async (chatId, text) => { sends.push({ chatId, text }); return { ok: true }; }, events);
    restartedHub.onStatus({ state: 'up' });
    await settle();
    A.eq(w.ledger.pending('telegram'), [], 'up replays and completes unfinished intake');
    A.ok(sends.some(s => s.chatId === '81' && /the result/.test(s.text)), 'the recovered message gets its real reply');
    restartedHub.close();
  }

  // ---- E. a reply an earlier process could not send goes as soon as a hub attaches ----
  {
    const w = world(), sends = [], events = [];
    w.ledger.enqueue({ id: 'reply:r0', channel: 'telegram', chatId: '88', runId: 'r0', parts: ['stranded earlier'] });
    const hub = mkHub(w, async (chatId, text) => { sends.push({ chatId, text }); return { ok: true }; }, events);
    await settle();
    A.eq(sends, [{ chatId: '88', text: 'stranded earlier' }], 'the stranded reply reaches its chat when the hub attaches its lane');
    A.eq(ev(events, 'redelivered').length, 1, 'said as redelivered');
    A.eq(w.ledger.deliveries(), [], 'and it leaves the ledger');
    hub.close();
  }

  // ---- F. command replies are never queued ----
  {
    const w = world(), events = [];
    const hub = mkHub(w, async () => ({ ok: false, error: 'down' }), events);
    await hub.onInbound(msg('11', 'm3', '/help'));
    A.eq(w.ledger.deliveries(), [], 'a failed /command reply is not queued');
    A.eq(w.ledger.pending('telegram'), [], 'and its receipt is settled when the command resolves');
    hub.close();
  }

  // ---- F2. outbound-only recovery retries itself ----
  {
    const w = world(), events = [];
    let sendOk = false;
    const hub = mkHub(w, async () => (sendOk ? { ok: true } : { ok: false, error: 'outbound only' }), events);
    await hub.onInbound(msg('12', 'm4', 'finish this'));
    A.eq(deliveriesOf(w, '12').length, 1, 'outbound-only failure is kept');
    A.eq(w.timers.list.some(t => t.ms === 5000), true, 'its lane armed its own retry (5 s)');
    sendOk = true;
    await w.timers.fire();
    A.eq(deliveriesOf(w, '12'), [], 'the lane\'s own timer drains it, with no new message and no poll transition');
    A.eq(ev(events, 'redelivered').length, 1, 'and reports the proven redelivery');
    hub.close();
  }

  // ---- G. a prolonged outage: one escalation at 5 tries; the reply stays ----
  {
    const w = world(), events = [];
    const hub = mkHub(w, async () => ({ ok: false, error: 'still down' }), events);
    await hub.onInbound(msg('13', 'm6', 'doomed'));
    for (let i = 0; i < 8 && (deliveriesOf(w, '13')[0] || {}).tries < 5; i++) await w.timers.fire();
    A.eq(deliveriesOf(w, '13').length, 1, 'the delayed reply is retained after 5 attempts');
    const delayed = ev(events, 'redelivery-delayed');
    A.eq(delayed.map(e => e.ok), [false], 'one honest escalation event, ok:false');
    hub.close();
  }

  // ---- G2. a merged batch: one answer write settles every bubble; a throwing batch keeps every receipt ----
  {
    const w = world(), events = [];
    let tick = () => new Promise(r => setTimeout(r, 0));
    const hub = mkHub(w, async () => ({ ok: true }), events, { textBatchWaitMs: 1, sleep: () => tick() });
    const bubble = (text, mid) => msg('91', mid, text);
    await Promise.all([hub.onInbound(bubble('check the deploy', 'b1')), hub.onInbound(bubble('and the logs', 'b2'))]);
    const answerWrite = w.ledger.snapshot();
    A.eq(answerWrite.receipts, [], 'the merged run\'s answer settled BOTH bubbles\' receipts');
    A.eq(ev(events).filter(e => e.chatId === '91' && e.ok).length, 1, 'one reply for the one merged run');
    hub.close();
    // processing throws after the merged run began a tool step: every bubble keeps its receipt, with that run's attempt
    let runs = 0;
    const w2 = world(), events2 = [];
    const hub2 = mkHub(w2, async () => ({ ok: true }), events2, {
      textBatchWaitMs: 1, sleep: () => tick(),
      runOnce: async (o) => { runs++; o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.tool_call', { runId: o.runId, callId: 'c', name: 'fs_write' }); o.emit('agent.token', { delta: 'done' }); o.emit('agent.run.end', { reason: 'done' }); },
      taskIntent: { parse: () => { throw new Error('the reply could not be read'); }, strip: (t) => t }
    });
    const outcomes = await Promise.allSettled([hub2.onInbound(bubble('write the report', 'c1')), hub2.onInbound(bubble('and email it', 'c2'))]);
    A.eq(outcomes.map(o => o.status), ['rejected', 'rejected'], 'the batch failure reaches every merged bubble, loser included');
    A.eq(w2.ledger.pending('telegram').map(r => [r.id, r.attempt && r.attempt.tools]).sort(), [['telegram|91|c1', 1], ['telegram|91|c2', 1]],
      'BOTH receipts stay, each with the merged run\'s begun step');
    await w2.timers.fire();                                       // the recover timer
    A.eq(w2.ledger.pending('telegram'), [], 'recovery settles both');
    A.eq(runs, 1, 'and never runs the batch again (a step had begun)');
    A.eq(ev(events2).filter(e => e.reason === 'interrupted').length, 1, 'ONE notice for the one interrupted run');
    hub2.close();
  }

  // ---- H. a part that landed is never sent again ----
  {
    const w = world(), events = [], sends = [];
    let calls = 0;
    const hub = mkHub(w, async (chatId, text) => { calls++; sends.push(text); return calls === 3 ? { ok: false, error: 'blip' } : { ok: true }; }, events,
      { maxMessageLength: 4, runOnce: answering('AAAABBBBCCCC') });
    await hub.onInbound(msg('pp', 'p1', 'write it'));
    A.eq(deliveriesOf(w, 'pp')[0].parts.map(p => p.sent), [true, true, false], 'after a blip on the third part, the first two are marked sent');
    await w.timers.fire();
    A.eq(sends, ['AAAA', 'BBBB', 'CCCC', 'CCCC'], 'the retry sends only the unsent part — never the chunks the member already read');
    A.eq(deliveriesOf(w, 'pp'), [], 'and the reply leaves with its last mark');
    hub.close();
  }

  // ---- H2. a fenced reply's unsent parts go exactly as first cut ----
  {
    const fencedText = 'intro line\n```\ncode a\ncode b\ncode c\ncode d\n```\nclosing prose';
    const parts = chunkTextParts(fencedText, 24);
    A.ok(parts.send.length >= 3 && parts.send.join('') !== fencedText, 'fixture: the fenced text splits and the send view is decorated');
    const w = world(), events = [], sends = [];
    let calls = 0;
    const hub = mkHub(w, async (chatId, text) => { calls++; sends.push(text); return calls === 2 ? { ok: false, error: 'blip' } : { ok: true }; }, events,
      { maxMessageLength: 24, runOnce: answering(fencedText) });
    await hub.onInbound(msg('fx', 'f1', 'show me'));
    A.eq(deliveriesOf(w, 'fx')[0].tries, 1, 'one failed try');
    await w.timers.fire();
    A.eq(sends.slice(2), parts.send.slice(1), 'the unsent parts go exactly as first cut: never re-split, never re-fenced');
    for (const c of sends) A.eq((c.match(/^[ \t]{0,3}```/gm) || []).length % 2, 0, 'every part on the wire has balanced fences: ' + JSON.stringify(c));
    hub.close();
  }

  // ---- H4. retryable:false is a tombstone, reported once, never retried; an aborted send is kept ----
  {
    const w = world(), events = [], sends = [];
    const hub = mkHub(w, async (chatId) => { sends.push(chatId); return chatId === 'gone' ? { ok: false, error: 'Bad Request: chat not found', retryable: false }
      : chatId === 'abort' ? { ok: false, error: 'aborted', retryable: false } : { ok: true, messageId: 'm' }; }, events);
    const r = await hub._internals.deliver('gone', 'the finished answer', 'r-h4', 'done', 'ag');
    A.eq(r.ok, false, 'the send failed');
    A.eq(deliveriesOf(w, 'gone'), [], 'a refusal that can never succeed is NOT kept for redelivery');
    A.eq(w.ledger.tombstones('telegram').map(t => [t.runId, t.reason]), [['r-h4', 'undeliverable']], 'it is a tombstone');
    A.eq(ev(events).map(e => [e.ok, e.reason]), [[false, 'undeliverable']], 'exactly one channel.delivery says undeliverable');
    await w.timers.fire();
    A.eq(sends.filter(c => c === 'gone').length, 1, 'and it is never retried');
    await hub._internals.deliver('abort', 'answer two', 'r-h4b', 'done', 'ag');
    A.eq(deliveriesOf(w, 'abort').length, 1, 'an aborted send (our transport torn down) is still kept for redelivery');
    hub.close();
  }

  // ---- H5. a refused CREDENTIAL keeps the reply for the re-paired hub ----
  {
    const res = (status, body, headers) => ({ ok: status >= 200 && status < 300, status, async json() { return body; }, headers: { get: k => (headers || {})[k] } });
    const { makeTelegramTransport } = require('../sidecar/channels/telegram.transport.js');
    const { makeDiscordTransport } = require('../sidecar/channels/discord.transport.js');
    const { makeSlackTransport } = require('../sidecar/channels/slack.transport.js');
    const { makeMatrixTransport } = require('../sidecar/channels/matrix.transport.js');
    const { makeSignalTransport } = require('../sidecar/channels/signal.transport.js');
    const tg = (status, body) => makeTelegramTransport({ token: '1:T', fetch: async () => res(status, body) });
    // (a) the invariant: every platform's send says auth:true for a refused credential, and never for a one-chat refusal
    const cases = [
      ['telegram 401 revoked token', tg(401, { ok: false, error_code: 401, description: 'Unauthorized' }), true],
      ['telegram 404 bad token', tg(404, { ok: false, error_code: 404, description: 'Not Found' }), true],
      ['telegram 400 chat not found', tg(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }), false],
      ['telegram 403 blocked', tg(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), false],
      ['discord 401', makeDiscordTransport({ token: 'T', fetch: async () => res(401, { message: '401: Unauthorized' }) }), true],
      ['discord 403 missing access', makeDiscordTransport({ token: 'T', fetch: async () => res(403, { message: 'Missing Access' }) }), false],
      ['slack token_revoked', makeSlackTransport({ botToken: 'xoxb-1', appToken: 'xapp-2', WebSocketImpl: function () {}, fetch: async () => res(200, { ok: false, error: 'token_revoked' }) }), true],
      ['slack invalid_auth', makeSlackTransport({ botToken: 'xoxb-1', appToken: 'xapp-2', WebSocketImpl: function () {}, fetch: async () => res(200, { ok: false, error: 'invalid_auth' }) }), true],
      ['slack not_in_channel', makeSlackTransport({ botToken: 'xoxb-1', appToken: 'xapp-2', WebSocketImpl: function () {}, fetch: async () => res(200, { ok: false, error: 'not_in_channel' }) }), false],
      ['matrix 401 M_UNKNOWN_TOKEN', makeMatrixTransport({ token: 'T', homeserver: 'https://hs.test', newId: () => 't1', fetch: async () => res(401, { errcode: 'M_UNKNOWN_TOKEN' }) }), true],
      ['matrix 403 M_FORBIDDEN', makeMatrixTransport({ token: 'T', homeserver: 'https://hs.test', newId: () => 't1', fetch: async () => res(403, { errcode: 'M_FORBIDDEN' }) }), false],
      ['signal 401', makeSignalTransport({ endpoint: 'http://127.0.0.1:1', account: '+1', fetch: async () => res(401, { error: 'unauthorized' }) }), true],
      ['signal 400 bad recipient', makeSignalTransport({ endpoint: 'http://127.0.0.1:1', account: '+1', fetch: async () => res(400, { error: 'invalid recipient' }) }), false]
    ];
    for (const [name, t, auth] of cases) {
      const r = await t.send('42', 'x', {});
      A.eq([r.ok, r.retryable, r.auth === true], [false, false, auth], name + ': not ok, not retryable, auth=' + auth);
    }
    // (b) through the hub: a revoked token keeps the reply; the re-paired bot's 'up' delivers it to the same chat
    let revoked = true; const wire = [];
    const t = makeTelegramTransport({ token: '1:T', fetch: async (url, o) => {
      const body = JSON.parse(o.body || '{}'); wire.push(body.text);
      return revoked ? res(401, { ok: false, error_code: 401, description: 'Unauthorized' }) : res(200, { ok: true, result: { message_id: 7 } });
    } });
    const w = world(), events = [];
    const hub = mkHub(w, (chatId, text, o) => t.send(chatId, text, o), events);
    const r = await hub._internals.deliver('55', 'the finished answer', 'r-h5', 'done', 'ag');
    A.eq(r.ok, false, 'the send failed on the revoked token');
    A.eq(deliveriesOf(w, '55').length, 1, 'a refused credential is NOT a tombstone: the reply stays for the re-paired bot');
    A.eq(ev(events).map(e => e.reason), ['done'], 'and it is not reported as undeliverable');
    revoked = false;   // the Commander re-pairs
    hub.onStatus({ state: 'up' });
    await settle();
    A.eq(deliveriesOf(w, '55'), [], 'the re-paired channel\'s up delivers it');
    A.ok(/the finished answer$/.test(wire[wire.length - 1]), 'to the same chat, the reply itself');
    hub.close();
    // a one-chat refusal from the same real transport is still a tombstone (H4's rule stands)
    const t400 = tg(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
    const w2 = world();
    const hub2 = mkHub(w2, (chatId, text, o) => t400.send(chatId, text, o), []);
    await hub2._internals.deliver('56', 'answer', 'r-h5b', 'done', '');
    A.eq(w2.ledger.deliveries(), [], 'a chat-level refusal from the real transport is never kept');
    hub2.close();
  }

  // ---- I. recovery: on 'up' and its own timer, never on a delivery; a stale snapshot never replays a finished message ----
  // Live-caught 2026-10-20 (sweep/channels): a follow-up typed while a task was running was steered into it AND run again
  // as its own task afterwards. The follow-up's ack delivery drained the outbox, whose "capacity is back" cue called
  // recoverInbox; its snapshot held [the running task, the follow-up], it parked on the running task, and then replayed
  // the follow-up from the stale list although it had long since finished. A delivery no longer starts recovery at all,
  // and recovery re-reads each receipt (and skips a live one) before it replays it.
  {
    const w = world(), events = [], sends = [], runs = [];
    let releaseA; const gateA = new Promise(r => { releaseA = r; });
    let releaseAck; const gateAck = new Promise(r => { releaseAck = r; });
    const hub = mkHub(w, async (chatId, text) => { sends.push(text); if (/Added to the task/.test(text)) await gateAck; return { ok: true }; }, events, {
      runOnce: async (o) => {
        const last = String((o.messages[o.messages.length - 1] || {}).content || '');
        runs.push(last);
        o.emit('agent.run.start', { runId: o.runId });
        o.emit('agent.token', { delta: 'result for ' + last });
        if (/long task/.test(last)) await gateA;
        o.emit('agent.run.end', { reason: 'done' });
      },
      steerRun: () => ({ ok: true, status: 200 })
    });
    const tick = () => new Promise(r => setTimeout(r, 0));
    const a = hub.onInbound(msg('93', 'a1', 'long task'));
    for (let i = 0; i < 20 && !hub._internals.inflight.get('93'); i++) await tick();
    A.ok(!!hub._internals.inflight.get('93'), 'fixture: the long task is in flight');
    const b = hub.onInbound(msg('93', 'b1', 'also add a limerick'));
    for (let i = 0; i < 20 && !sends.some(s => /Added to the task/.test(s)); i++) await tick();
    // (review round 1) the follow-up is settled where it joined the run, before its ack goes out: a crash while the ack is
    // on the wire must not replay it as a task of its own (test/channels.decision-settle.test.js). Was: settled on resolve,
    // both receipts pending here.
    A.eq(w.ledger.pending('telegram').map(x => x.id).sort(), ['telegram|93|a1'], 'the steered follow-up has left the moment it joined the run, while its ack is still in flight; the running task stays pending');
    const recovery = hub._internals.recoverInbox();   // the recover timer firing mid-steer
    releaseAck(); await b;
    A.eq(w.ledger.pending('telegram').map(x => x.id), ['telegram|93|a1'], 'the steered follow-up stays settled once its ack is out');
    releaseA(); await a; await recovery;
    for (let i = 0; i < 20; i++) await tick();
    A.eq(runs.filter(t => /also add a limerick/.test(t)).length, 0, 'the steered follow-up never starts a run of its own');
    A.eq(sends.filter(s => /Added to the task/.test(s)).length, 1, 'and the chat hears its acknowledgement exactly once');
    A.eq(w.ledger.pending('telegram'), [], 'nothing is left pending');
    // a delivery never starts recovery: a crash survivor waits for 'up' or the recover timer, never for another reply
    w.ledger.receive({ id: 'telegram|94|z1', channel: 'telegram', chatId: '94', message: msg('94', 'z1', 'left over') });
    await hub._internals.deliver('95', 'an unrelated reply', 'r-x', 'done');
    await settle();
    A.eq(w.ledger.pending('telegram').map(x => x.id), ['telegram|94|z1'], 'a delivery in another chat does not replay a pending receipt');
    await w.timers.fire();
    A.eq(w.ledger.pending('telegram'), [], 'the recover timer does');
    hub.close();
  }

  // ---- J. a RECONNECTED hub never replays the old hub's in-flight message ----
  // startTelegram() closes the old hub and builds a new one over the SAME store while the old hub's run is still going
  // (it finishes and replies on its own). The live claim belongs to the store's ledger both hubs share.
  {
    const w = world(), events = [], sends = [], runs = [];
    let release; const gate = new Promise(r => { release = r; });
    const mk = (tag) => mkHub(w, async (chatId, text) => { sends.push(text); return { ok: true }; }, events, {
      runOnce: async (o) => { runs.push(tag); o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'answer from ' + tag }); await gate; o.emit('agent.run.end', { reason: 'done' }); },
      newId: (() => { let n = 0; return () => tag + '-run-' + (++n); })()
    });
    const tick = () => new Promise(r => setTimeout(r, 0));
    const oldHub = mk('old');
    const work = oldHub.onInbound(msg('94', 'r1', 'research this'));
    for (let i = 0; i < 20 && !runs.length; i++) await tick();
    A.eq(runs, ['old'], 'fixture: the old hub\'s run is in flight');
    oldHub.close();                                   // reconnect: stopTelegram() then a fresh hub
    const newHub = mk('new');
    newHub.onStatus({ state: 'up' });                 // the new adapter's first poll
    for (let i = 0; i < 20; i++) await tick();
    A.eq(runs, ['old'], 'the new hub does not start a second run of the in-flight message');
    release(); await work; await settle();
    A.eq(runs, ['old'], 'still exactly one run once the old one finishes');
    A.eq(sends.filter(s => /answer from/.test(s)).length, 1, 'the chat hears exactly one reply (the new hub\'s lane sends it)');
    A.eq(w.ledger.pending('telegram'), [], 'the receipt is settled by the run that owned it');
    // a genuine crash survivor (no live owner in this process) still replays on the next up
    w.ledger.receive({ id: 'telegram|94|r2', channel: 'telegram', chatId: '94', message: msg('94', 'r2', 'left over') });
    newHub.onStatus({ state: 'up' });
    for (let i = 0; i < 40 && w.ledger.pending('telegram').length; i++) await tick();
    A.eq(runs, ['old', 'new'], 'an ownerless pending receipt is still recovered');
    newHub.close();
  }

  // ---- K. a chat that keeps failing never holds another chat's reply ----
  {
    const w = world(), events = [], sends = [];
    const hub = mkHub(w, async (chatId, text) => { sends.push(chatId); return chatId === 'down' ? { ok: false, error: 'Bad Gateway', retryable: true } : { ok: true }; }, events);
    await hub.onInbound(msg('down', 'd1', 'first'));
    await hub.onInbound(msg('down', 'd2', 'second'));
    await hub.onInbound(msg('fine', 'f1', 'hello'));
    A.eq(deliveriesOf(w, 'down').length, 2, 'the failing chat keeps both its replies, in its own lane');
    A.eq(sends.filter(c => c === 'down').length, 1, 'its second reply waits behind its first (one try per backoff, not one per reply)');
    A.eq(deliveriesOf(w, 'fine'), [], 'the healthy chat\'s reply landed at once');
    A.ok(ev(events).some(e => e.chatId === 'fine' && e.ok), 'said so');
    hub.close();
  }

  A.report('channels.outbox.test');
})().catch(e => { console.error(e); process.exit(1); });
