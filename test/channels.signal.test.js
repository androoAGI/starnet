/* node test/channels.signal.test.js — the Signal channel: signal-cli REST transport (receive long-poll + send)
   and binding (normalize + owner gate through the generic adapter). No real network — injected fake fetch. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const { makeSignalTransport } = require('../sidecar/channels/signal.transport.js');
const { makeSignalAdapter, normalize, MAX_MESSAGE_LENGTH } = require('../sidecar/channels/signal.js');
const fs = require('fs');
const path = require('path');

const tick = () => new Promise(r => setTimeout(r, 0));
const jres = (status, body) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });
const envOf = (over, dmOver) => ({ envelope: Object.assign({ sourceNumber: '+15550001111', sourceName: 'Alice', timestamp: 111, dataMessage: Object.assign({ message: 'hi', timestamp: 111 }, dmOver || {}) }, over || {}) });

(async () => {
  // ---- PU-06: Signal is tokenless, so its destructive action removes endpoint/account configuration. ----
  {
    const idx = readSidecarSource();
    const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'windows', 'messaging.js'), 'utf8');
    const disconnect = (idx.split('async function handleGenericChannelDisconnect')[1] || '').split('/* ----------------------- Codex')[0];
    A.ok(/id\s*===\s*'signal'[\s\S]*delete\s+next\.endpoint[\s\S]*delete\s+next\.account/.test(disconnect), 'Signal purge removes its endpoint and account configuration');
    A.ok(/removedConfiguration/.test(disconnect), 'Signal removal response reports a separately proven configuration-removal bit');
    A.ok(/REMOVE CONFIGURATION/.test(ui), 'Signal card names its destructive action REMOVE CONFIGURATION');
    A.ok(/configuration removed/.test(ui), 'Signal success copy names configuration removal, never token deletion');
    A.ok(!/c\.id\s*===\s*'signal'[\s\S]{0,400}stored token was purged/.test(ui), 'Signal-specific action never claims a token was purged');
  }

  // ---- A. normalize: envelope -> neutral InboundMessage ----
  {
    const m = normalize(envOf());
    A.eq(m.message, { chatId: '+15550001111', chatType: 'dm', userId: '+15550001111', userName: 'Alice', text: 'hi', messageId: '111' }, 'a DM envelope normalizes to the neutral shape');
    A.eq(normalize({ envelope: { sourceNumber: '+1555', receiptMessage: { isDelivery: true } } }), null, 'a receipt delivers nothing');
    A.eq(normalize(envOf({}, { groupInfo: { groupId: 'g' } })), null, 'group messages deliver nothing (DM-only first cut)');
    A.eq(normalize(envOf({}, { message: '' })), null, 'an empty text delivers nothing');
    A.eq(normalize(null), null, 'malformed raw -> null');
    A.eq(MAX_MESSAGE_LENGTH, 4096, 'declared chunking limit');
  }

  // ---- A2. Note to Self: a bridge LINKED to the user's own number only sees what they type there as a sync
  //          transcript addressed to the account itself (2026-10-11: the guide's link option was a dead end). ----
  {
    const ME = '+15557770000';
    const sync = (dest, msg, extra) => ({ account: ME, envelope: Object.assign({ sourceNumber: ME, sourceName: 'Me', timestamp: 500,
      syncMessage: { sentMessage: Object.assign({ destinationNumber: dest, destination: dest, message: msg, timestamp: 501 }, extra || {}) } }) });
    const n = normalize(sync(ME, 'pair ABCDE-FGHIJ'));
    A.eq(n && n.message, { chatId: ME, chatType: 'dm', userId: ME, userName: 'Me', text: 'pair ABCDE-FGHIJ', messageId: '501' }, 'Note to Self normalizes to a DM from (and back to) the account');
    A.eq(normalize(sync('+15550001111', 'private chat with a friend')), null, 'a transcript of the user talking to SOMEONE ELSE is never delivered');
    A.eq(normalize(sync(ME, 'x', { groupInfo: { groupId: 'g' } })), null, 'a group transcript is never delivered');
    A.eq(normalize(sync(ME, '')), null, 'an empty Note to Self delivers nothing');
    const noAccount = sync(ME, 'hi'); delete noAccount.account;
    A.eq(normalize(noAccount), null, 'without knowing the account, a sync is never trusted');
    A.eq(normalize(noAccount, { account: ME }).message.text, 'hi', 'the configured account number identifies Note to Self');
    A.eq(normalize({ account: ME, envelope: { sourceNumber: ME, syncMessage: { readMessages: [{ timestamp: 1 }] } } }), null, 'other sync traffic (read receipts) delivers nothing');

    // end to end: the owner IS the account; the reply goes back to Note to Self and its echo is refused.
    const sent = [];
    const seq = [[sync(ME, 'what is on my calendar')]];
    const inbound = [];
    const transport = {
      getUpdates: async () => seq.length ? seq.shift() : (await new Promise(r => setTimeout(() => r([]), 1))),
      send: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true, messageId: '777' }; }
    };
    const ad = makeSignalAdapter({ transport, account: ME, clock: { now: () => 9 }, ownerUserId: ME, onInbound: m => inbound.push(m), sleep: () => Promise.resolve() });
    await ad.connect();
    for (let i = 0; i < 20 && inbound.length < 1; i++) await tick();
    A.eq(inbound.length, 1, 'a Note to Self from the paired owner reaches the run host');
    A.eq(inbound[0].chatId, ME, 'its reply is addressed to Note to Self');
    await ad.send(ME, 'You have two meetings.');
    A.eq(sent[0] && sent[0].chatId, ME, 'the reply is sent to the account itself');
    seq.push([sync(ME, 'You have two meetings.', { timestamp: 777 })]);
    for (let i = 0; i < 20; i++) await tick();
    await ad.disconnect();
    A.eq(inbound.length, 1, 'the echo of our own reply (same timestamp) is refused, never a new turn');
  }

  // ---- B. transport: receive URL shape, send body shape, error classes ----
  {
    const calls = [];
    const fakeFetch = async (url, opts) => {
      calls.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body });
      if (/\/v1\/receive\//.test(url)) return jres(200, [envOf()]);
      if (/\/v2\/send$/.test(url)) return jres(201, { timestamp: 999 });
      return jres(404, { error: 'nope' });
    };
    const t = makeSignalTransport({ fetch: fakeFetch, endpoint: 'http://127.0.0.1:8080/', account: '+15559990000' });
    const ups = await t.getUpdates({ timeoutSec: 30 });
    A.eq(ups.length, 1, 'receive yields the queued envelopes');
    A.ok(/\/v1\/receive\/%2B15559990000\?timeout=30$/.test(calls[0].url), 'receive long-polls the encoded account with ?timeout=');
    const sr = await t.send('+15550001111', 'hello', {});
    A.eq(sr, { ok: true, messageId: '999' }, 'send returns the timestamp as the message id');
    const post = calls[calls.length - 1];
    A.eq(post.method, 'POST', 'send POSTs /v2/send');
    A.eq(JSON.parse(post.body), { message: 'hello', number: '+15559990000', recipients: ['+15550001111'] }, 'send body carries message + account + recipient');

    const t400 = makeSignalTransport({ fetch: async () => jres(400, { error: 'account not registered' }), endpoint: 'http://x', account: '+1' });
    let err = null; try { await t400.getUpdates({}); } catch (e) { err = e; }
    A.ok(err && err.fatal === true, 'a 400 (unknown account) receive is FATAL — stop polling for good');
    A.ok(/MODE=native/.test(err.message), 'the fatal 400 names the json-rpc mode fix the user can make');

    const t500 = makeSignalTransport({ fetch: async () => jres(500, { error: 'boom' }), endpoint: 'http://x', account: '+1' });
    const r5 = await t500.send('+2', 'x', {});
    A.eq(r5.ok, false, '5xx send fails'); A.eq(r5.retryable, true, '5xx send is retryable');

    const tNet = makeSignalTransport({ fetch: async () => { throw new Error('ECONNREFUSED'); }, endpoint: 'http://x', account: '+1' });
    const rn = await tNet.send('+2', 'x', {});
    A.eq(rn.ok, false, 'network send failure is normalized (never throws)');
    A.eq(rn.retryable, true, 'network send failure is retryable');
    let e2 = null; try { await tNet.getUpdates({}); } catch (e) { e2 = e; }
    A.ok(e2 && !e2.fatal, 'a network receive throw is transient (adapter backs off, not stops)');
  }

  // ---- C. binding end-to-end: adapter + fake transport honors normalize + owner trust-on-first-use ----
  {
    const seq = [[
      envOf({ sourceNumber: '+19998887777', sourceName: 'Stranger' }, { message: 'steal it' }),
      envOf({}, { message: 'owner msg' })
    ]];
    const inbound = [];
    const transport = {
      getUpdates: async () => seq.length ? seq.shift() : (await new Promise(r => setTimeout(() => r([]), 1))),
      send: async () => ({ ok: true })
    };
    const ad = makeSignalAdapter({ transport, clock: { now: () => 9 }, ownerUserId: '+15550001111', onInbound: m => inbound.push(m), sleep: () => Promise.resolve() });
    A.eq(ad.name, 'signal', 'adapter carries the channel name');
    await ad.connect();
    for (let i = 0; i < 20 && inbound.length < 1; i++) await tick();
    await ad.disconnect();
    A.eq(inbound.length, 1, 'preset owner: the stranger\'s DM never reached onInbound');
    A.eq(inbound[0].text, 'owner msg', 'the owner\'s message flowed through');
    A.eq(inbound[0].channel, 'signal', 'inbound is stamped with the channel');
  }

  A.report('channels.signal.test');
})().catch(e => { console.error(e); process.exit(1); });
