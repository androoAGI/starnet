/* node test/channels.transport-idempotency.test.js — a part's idempotency key reaches the wire, and every resend of that
   part carries the same key (channel-delivery-ledger S2).

   A part the platform accepted while its response was lost (or while the process died before its sent mark) is sent
   again: on Telegram, Slack and Signal that is the boundary the delivery property names (one extra copy of exactly that
   part). Discord and Matrix can do better, and did not: Discord's POST carried only {content} (discord.transport.js), and
   Matrix minted a fresh txnId on every call (matrix.transport.js), so even the adapter's own bounded resend could post the
   same message twice. Every durable part now carries sendOpts.idempotencyKey (the ledger's partKey: a short hash of the
   delivery id and the part, the same in every attempt and every process), and adapter.send mints one for an ephemeral
   send that has none, so its own resend reuses it. Real adapters and transports over a recording fetch. Proves:
     A. Discord: the key goes as nonce with enforce_nonce:true, and the adapter's resend reuses it
     B. Matrix: the key is the PUT's txnId, and the adapter's resend reuses it
     C. an ephemeral send without a key gets a minted one (it fits a Discord nonce), which its resend reuses; two sends
        never share one
     D. Telegram, Slack and Signal requests are byte-identical to a send without the key
     E. through the real hub and its delivery ledger: a durable part keeps ONE key across the ledger's own retries */
'use strict';
const A = require('./_assert.js');
const { makeDiscordAdapter } = require('../sidecar/channels/discord.js');
const { makeMatrixAdapter } = require('../sidecar/channels/matrix.js');
const { makeTelegramAdapter } = require('../sidecar/channels/telegram.js');
const { makeSlackAdapter } = require('../sidecar/channels/slack.js');
const { makeSignalAdapter } = require('../sidecar/channels/signal.js');

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, async json() { return body; }, async text() { return JSON.stringify(body); }, headers: { get: () => null } });
// a recording fetch: answers each call from the plan (default: ok), and keeps every request's url and body
function recFetch(plan, okBody) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body != null ? String(init.body) : '' });
    const r = plan.length ? plan.shift() : 200;
    return res(r, r === 200 ? okBody : { message: 'server error', errcode: 'M_UNKNOWN' });
  };
  return { fetch, calls };
}
const quiet = { clock: { now: () => 1761900000000 }, sleep: () => Promise.resolve() };

(async () => {
  // ---- A. Discord: nonce + enforce_nonce, reused by the adapter's resend ----
  {
    const f = recFetch([503], { id: '9001' });
    const ad = makeDiscordAdapter(Object.assign({ fetch: f.fetch, token: 'T', connectGateway: () => ({ close() {} }) }, quiet));
    const r = await ad.send('chan-1', 'part one', { idempotencyKey: 'snabc123' });
    const posts = f.calls.filter(c => c.method === 'POST').map(c => JSON.parse(c.body));
    A.eq(r.ok, true, 'A: the resend landed');
    A.eq(posts.length, 2, 'A: a 503, then the adapter\'s one bounded resend');
    A.eq(posts.map(b => [b.nonce, b.enforce_nonce]), [['snabc123', true], ['snabc123', true]], 'A: both attempts carry the key as nonce, with enforce_nonce');
    A.eq(posts[0].content, 'part one', 'A: the content is unchanged');
  }

  // ---- B. Matrix: the key is the txnId, reused by the resend ----
  {
    let minted = 0;
    const f = recFetch([502], { event_id: '$e1' });
    const ad = makeMatrixAdapter(Object.assign({ fetch: f.fetch, token: 'T', homeserver: 'https://hs.test', newId: () => 'fresh-' + (++minted) }, quiet));
    await ad.send('!room:hs.test', 'part one', { idempotencyKey: 'snabc123' });
    const puts = f.calls.filter(c => c.method === 'PUT').map(c => c.url.split('/').pop());
    A.eq(puts, ['snabc123', 'snabc123'], 'B: the PUT\'s txnId is the key, in the first attempt and the resend (was a fresh id per call)');
  }

  // ---- C. an ephemeral send mints one key, which its resend reuses; two sends never share one ----
  {
    const f = recFetch([503], { id: '9002' });
    const ad = makeDiscordAdapter(Object.assign({ fetch: f.fetch, token: 'T', connectGateway: () => ({ close() {} }) }, quiet));
    await ad.send('chan-1', 'a command reply');
    await ad.send('chan-1', 'another reply');
    const nonces = f.calls.filter(c => c.method === 'POST').map(c => JSON.parse(c.body).nonce);
    A.eq(nonces.length, 3, 'C: fixture: three POSTs (a resend, then a second send)');
    A.ok(!!nonces[0] && nonces[0] === nonces[1], 'C: the minted key rides the first attempt and the resend alike');
    A.ok(nonces[2] && nonces[2] !== nonces[0], 'C: a second send gets a key of its own');
    A.ok(nonces.every(n => typeof n === 'string' && n.length <= 25), 'C: a minted key fits a Discord nonce (25 characters)');
    let minted = 0;
    const m = recFetch([502], { event_id: '$e2' });
    const mx = makeMatrixAdapter(Object.assign({ fetch: m.fetch, token: 'T', homeserver: 'https://hs.test', newId: () => 'fresh-' + (++minted) }, quiet));
    await mx.send('!room:hs.test', 'a command reply');
    const txns = m.calls.filter(c => c.method === 'PUT').map(c => c.url.split('/').pop());
    A.ok(txns.length === 2 && txns[0] === txns[1], 'C: Matrix: the resend PUTs the same txnId (' + txns.join(', ') + ')');
  }

  // ---- D. Telegram, Slack and Signal requests are byte-identical with and without a key ----
  {
    const tgWith = recFetch([], { ok: true, result: { message_id: 7 } }), tgWithout = recFetch([], { ok: true, result: { message_id: 7 } });
    await makeTelegramAdapter(Object.assign({ fetch: tgWith.fetch, token: '1:T' }, quiet)).send('42', 'hello', { idempotencyKey: 'snabc123', threadId: '9' });
    await makeTelegramAdapter(Object.assign({ fetch: tgWithout.fetch, token: '1:T' }, quiet)).send('42', 'hello', { threadId: '9' });
    A.eq(tgWith.calls.map(c => c.body), tgWithout.calls.map(c => c.body), 'D: Telegram: the Bot API request is byte-identical (the key is not a Bot API field)');
    const slWith = recFetch([], { ok: true, ts: '1.2' }), slWithout = recFetch([], { ok: true, ts: '1.2' });
    await makeSlackAdapter(Object.assign({ fetch: slWith.fetch, botToken: 'xoxb-1', appToken: 'xapp-2', WebSocketImpl: function () {} }, quiet)).send('C1', 'hello', { idempotencyKey: 'snabc123' });
    await makeSlackAdapter(Object.assign({ fetch: slWithout.fetch, botToken: 'xoxb-1', appToken: 'xapp-2', WebSocketImpl: function () {} }, quiet)).send('C1', 'hello');
    A.eq(slWith.calls.map(c => c.body), slWithout.calls.map(c => c.body), 'D: Slack: byte-identical');
    const sgWith = recFetch([], { timestamp: 5 }), sgWithout = recFetch([], { timestamp: 5 });
    await makeSignalAdapter(Object.assign({ fetch: sgWith.fetch, endpoint: 'http://127.0.0.1:1', account: '+1' }, quiet)).send('+2', 'hello', { idempotencyKey: 'snabc123' });
    await makeSignalAdapter(Object.assign({ fetch: sgWithout.fetch, endpoint: 'http://127.0.0.1:1', account: '+1' }, quiet)).send('+2', 'hello');
    A.eq(sgWith.calls.map(c => c.body), sgWithout.calls.map(c => c.body), 'D: Signal: byte-identical');
  }

  // ---- E. through the real hub and its ledger: one key per durable part, across the ledger's own retries ----
  {
    let Ledger = null;
    try { Ledger = require('../sidecar/channels/delivery-ledger.js'); } catch (_) { Ledger = null; }
    A.ok(!!Ledger, 'E: the delivery ledger exists (channels/delivery-ledger.js)');
    if (Ledger) {
      const { makeChannelHub } = require('../sidecar/channels/hub.js');
      const timers = []; const keys = [];
      let fails = 2;
      const hub = makeChannelHub({
        channel: 'discord', runOnce: async () => {}, store: { loadHistory: () => [], appendTurn: () => [], getChatRecord: () => null },
        send: async (chatId, text, opts) => { keys.push(opts && opts.idempotencyKey); return fails-- > 0 ? { ok: false, error: 'Bad Gateway', retryable: true } : { ok: true, messageId: 'm' }; },
        secrets: () => ({}), classify: () => false, newId: () => 'x', maxMessageLength: 2000,
        setTimeout: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; }, clearTimeout: () => {}
      });
      await hub._internals.deliver('chan-9', 'the durable reply', 'run-77', 'done');
      for (let i = 0; i < 4 && keys.length < 3; i++) { const due = timers.splice(0); for (const t of due) t.fn(); for (let j = 0; j < 30; j++) await new Promise(r => setImmediate(r)); }
      A.eq(keys.length, 3, 'E: fixture: two failed attempts and the landing');
      A.eq(new Set(keys).size, 1, 'E: one key across every attempt of the part');
      A.eq(keys[0], Ledger.partKey('reply:run-77', 0), 'E: the ledger\'s partKey of the delivery and the part: the same in every process');
      hub.close();
    }
  }

  A.report('channels.transport-idempotency.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
