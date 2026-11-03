/* node test/channels.intake-handover.test.js — every message a platform hands the station gets a durable receipt (and its
   run), even when the receipt could not be written at the moment it arrived (channel-delivery-ledger, review round 1).

   THE HOLE. The ledger's intake contract says a receipt that cannot be written throws, "the adapter then does not
   acknowledge, and the platform keeps the update". That is true of Telegram alone: its getUpdates hands back everything
   from the unacknowledged offset. Every other transport has consumed an update before the adapter dispatches it —
   Discord's gateway buffer is spliced, Slack acks the socket envelope on arrival, Matrix advances `since`, signal-cli's
   receive drains its queue — and the poll loop broke out of the batch on the refusal and dropped that update and every
   one behind it. A transient EBUSY on delivery.json (an antivirus scan, an indexer), a full channel intake or an unread
   ledger lost the Commander's messages with no reply and no notice, while the console said they were "NOT acknowledged".

   THE INVARIANT, over the class: a transport that consumes what it hands over, behind the generic adapter's poll loop. Two
   real ones, each built the way index.js builds it (wireChannel over the REAL channel store and its delivery ledger, the
   REAL adapter poll loop and transport) with fakes only at the platform: Discord (a fake gateway pushing MESSAGE_CREATE
   payloads, a fake REST) and Signal (a fake signal-cli REST whose receive drains its queue). One refused receipt write in
   the middle of a batch — and, on Discord, a channel intake that is full — and every message the platform handed over
   still gets exactly one receipt, one run and one reply, in the order it was sent, and nothing is left pending.

   RED at f52f308db: the refused message and the one behind it in the same batch never run (runs: 1, 0, 0, 1). */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeChannelRegistry, wireChannel } = require('../sidecar/channels/registry.js');
const HostPathScrub = require('../sidecar/host-path-scrub.js');

const fast = (ms) => new Promise((r) => setTimeout(r, Math.min(Number(ms) || 0, 2)));   // the poll's park and backoff, shortened
async function until(pred, ms) { const end = Date.now() + (ms || 4000); while (Date.now() < end) { if (pred()) return true; await new Promise(r => setTimeout(r, 5)); } return pred(); }

/* ONE STATION over an in-memory disk that can refuse the next receipt write(s) (EBUSY), with one wired channel */
function makeStation(kind, limits) {
  const files = new Map();
  const st = { refuse: 0, runs: [], sends: [], kind: kind };
  const err = (code, p) => Object.assign(new Error(code + ': ' + p), { code: code });
  const fs = {
    readFileSync(p) { if (!files.has(p)) throw err('ENOENT', p); return files.get(p); },
    writeFileSync(p, d) { files.set(p, String(d)); },
    renameSync(a, b) {
      // the file a receipt is written to: the delivery ledger (a tree from before it: the v1 inbox)
      if (st.refuse > 0 && /(delivery|inbox)\.json$/.test(b)) { st.refuse--; throw err('EBUSY', b); }
      if (!files.has(a)) throw err('ENOENT', a);
      files.set(b, files.get(a)); files.delete(a);
    },
    mkdirSync() {}
  };
  st.store = makeChannelStore({ fs: fs, pathMod: path.posix, root: '/ws/channels', clock: { now: () => Date.now() }, ledgerLimits: limits || {} });
  let ids = 0;
  const hub = {
    store: st.store, persona: 'p', classify: () => true, redact: (x) => x, emit: () => {}, newId: () => 'run-' + kind + '-' + (++ids), now: () => Date.now(),
    secrets: () => ({ key: 'k', model: 'm', provider: 'openrouter', configured: true }), roster: () => [], runSlash: async () => ({ ok: true, text: 'ok' }), userCommandNames: () => [],
    runOnce: async (o) => {
      const words = String((o.messages[o.messages.length - 1] || {}).content || '');
      st.runs.push(words);
      o.emit('agent.run.start', { runId: o.runId, agentId: 'a', trigger: 'event', model: 'm' });
      o.emit('agent.token', { runId: o.runId, agentId: 'a', delta: 'ANSWER to ' + words });
      o.emit('agent.run.end', { runId: o.runId, agentId: 'a', reason: 'done', turns: 1, usd: 0 });
    }
  };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, async json() { return body; }, async text() { return JSON.stringify(body); } });
  const reg = makeChannelRegistry();
  let sent = 7000;
  if (kind === 'discord') {
    let onMessage = null;
    st.wired = wireChannel(reg.get('discord'), {
      outbound: HostPathScrub.makeHostPathScrub({ fixed: ['/ws/agents'] }), hub: hub,
      adapter: {
        token: 'D', clock: { now: () => Date.now() }, ownerUserId: 'd-owner', sleep: fast,
        fetch: async (url, init) => { if (init && init.method === 'POST') { st.sends.push(JSON.parse(String(init.body || '{}')).content); return res(200, { id: String(++sent) }); } return res(200, {}); },
        connectGateway: (g) => { onMessage = g.onMessage; return { close() {} }; }
      }
    });
    st.chats = ['4242', '4343'];   // two DM channels of the owner's
    // the gateway hands each message over once (MESSAGE_CREATE); getUpdates drains what it buffered
    st.push = (batch) => { for (const [id, text, chat] of batch) onMessage({ id: String(id), channel_id: chat || '4242', author: { id: 'd-owner', username: 'ana' }, content: text }); };
  } else {
    const queue = [];
    const OWNER = '+15550001111';
    st.wired = wireChannel(reg.get('signal'), {
      outbound: HostPathScrub.makeHostPathScrub({ fixed: ['/ws/agents'] }), hub: hub,
      adapter: {
        endpoint: 'http://signal.test', account: '+15559990000', clock: { now: () => Date.now() }, ownerUserId: OWNER, sleep: fast, pollTimeoutSec: 1,
        fetch: async (url, init) => {
          if (/\/v1\/receive\//.test(String(url))) {
            if (!queue.length) await new Promise(r => setTimeout(r, 5));
            return res(200, queue.splice(0, queue.length));   // signal-cli's receive drains the queue it hands over
          }
          if (/\/v2\/send$/.test(String(url))) { st.sends.push(JSON.parse(String(init.body || '{}')).message); return res(200, { timestamp: ++sent }); }
          return res(200, {});
        }
      }
    });
    st.chats = [OWNER];
    st.push = (batch) => { for (const [id, text] of batch) queue.push({ envelope: { sourceNumber: OWNER, sourceName: 'Ana', timestamp: id, dataMessage: { message: text, timestamp: id } } }); };
  }
  st.ran = (t) => st.runs.filter(w => w.indexOf(t) >= 0).length;
  st.answered = (t) => st.sends.filter(s => String(s).indexOf('ANSWER to ' + t) >= 0).length;
  st.close = () => { try { st.wired.hub.close(); } catch (_) {} try { st.wired.adapter.disconnect(); } catch (_) {} try { if (st.store.ledger) st.store.ledger.close(); } catch (_) {} };
  return st;
}

async function scenario(label, kind, opts) {
  const st = makeStation(kind, opts.limits);
  try {
    await st.wired.adapter.connect();
    st.push([[9001, 'first message']]);
    A.ok(await until(() => st.answered('first message') === 1), label + ': the first message is answered');
    opts.refuse(st);
    // one batch: the refused one, and one behind it (on Discord in the owner's other DM: in one chat the newer message would
    // supersede the older one's run, by design); Signal's receive has one chat, the owner's: the refused one alone
    if (kind === 'discord') st.push([[9002, 'second message', '4242'], [9003, 'third message', '4343']]);
    else { st.push([[9002, 'second message']]); await until(() => false, 150); st.push([[9003, 'third message']]); }
    await until(() => false, 150);
    if (opts.release) opts.release(st);
    st.push([[9004, 'fourth message']]);
    const all = ['first', 'second', 'third', 'fourth'];
    await until(() => all.every(t => st.answered(t + ' message') === 1), 6000);
    A.eq(all.map(t => st.ran(t + ' message')), [1, 1, 1, 1], label + ': every message the platform handed over ran exactly once (was: the refused one and the one behind it in its batch, never)');
    A.eq(all.map(t => st.answered(t + ' message')), [1, 1, 1, 1], label + ': and was answered exactly once');
    const order = st.runs.map(w => all.findIndex(t => w.indexOf(t + ' message') >= 0)).filter(i => i >= 0);
    A.eq(order, [0, 1, 2, 3], label + ': in the order it was sent');
    // what is still pending for its chats: the ledger's receipts (a tree from before it: the v1 inbox)
    const left = () => (st.store.ledger ? st.store.ledger.pending(kind) : st.store.loadInbox(kind)).filter(r => st.chats.indexOf(String(r.chatId || (r.message && r.message.chatId))) >= 0).map(r => r.id);
    await until(() => left().length === 0, 2000);
    A.eq(left(), [], label + ': and no receipt of its chats is left pending');
  } finally { st.close(); }
}

(async () => {
  // a receipt write refused once (EBUSY on the delivery.json rename): the platform does not hand the update over again
  await scenario('Discord, one refused receipt write', 'discord', { refuse: (st) => { st.refuse = 1; } });
  await scenario('Signal, one refused receipt write', 'signal', { refuse: (st) => { st.refuse = 1; } });
  // the channel's intake is full: another Discord chat holds the two receipts the channel may have pending, then lets go
  await scenario('Discord, a full channel intake', 'discord', {
    limits: { maxPendingPerChannel: 2 },
    refuse: (st) => {
      if (!st.store.ledger) { A.ok(false, 'Discord, a full channel intake: this tree has no delivery ledger'); return; }
      for (const id of ['1', '2']) st.store.ledger.receive({ id: 'discord|555|' + id, channel: 'discord', chatId: '555', message: { chatId: '555', chatType: 'dm', userId: 'x', text: 'parked ' + id, messageId: id } });
    },
    release: (st) => { if (st.store.ledger) st.store.ledger.settle(['discord|555|1', 'discord|555|2']); }
  });
  A.report('channels.intake-handover.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
