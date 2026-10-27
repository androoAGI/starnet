/* node test/channels.outbox.test.js — the durable outbound-retry seam (store outbox + hub queue/flush).
   Proves: a FAILED reply is queued (only the undelivered remainder, never a /command reply), the queue is
   bounded + survives via the same atomic store, an adapter 'up' status redelivers it, a mid-session healthy
   send drains the backlog, and prolonged outages retain replies instead of silently giving up. */
'use strict';
const A = require('./_assert.js');
const pathMod = require('path');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');

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

let clk = 1000;
const clock = { now: () => clk };
const ROOT = '/ws/channels';
const mkStore = (fs, outboxLimits) => makeChannelStore({ fs: fs || memFs(), pathMod, root: ROOT, clock, outboxLimits });

// a hub over a controllable send + real store; runOnce streams one token so a real reply exists.
function mkHub(store, sendImpl, events) {
  return makeChannelHub({
    channel: 'telegram',
    runOnce: async (o) => { o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'the result' }); o.emit('agent.run.end', { reason: 'done' }); },
    store,
    send: sendImpl,
    secrets: () => ({ key: 'k', model: 'm', configured: true }),
    emit: (name, payload) => events.push([name, payload]),
    newId: (() => { let n = 0; return () => 'run-' + (++n); })(),
    sleep: () => Promise.resolve(), outboxRetryMs: 5
  });
}

(async () => {
  // ---- A. store outbox CRUD: push/load/remove/bump round-trip; missing/corrupt -> [] ----
  {
    const s = mkStore();
    A.eq(s.loadOutbox(), [], 'missing outbox -> []');
    clk = 2000;
    const it = s.pushOutbox({ channel: 'telegram', chatId: '77', text: 'queued reply', runId: 'r1', agentId: 'ag', reason: 'done' });
    A.ok(it.id && it.tries === 0 && it.ts === 2000, 'pushed item is stamped from the injected clock');
    A.eq(s.loadOutbox('telegram').length, 1, 'loadOutbox(channel) finds it');
    A.eq(s.loadOutbox('discord'), [], 'another channel sees nothing');
    const b = s.bumpOutboxTry(it.id);
    A.eq(b.tries, 1, 'bump counts a failed attempt');
    A.eq(s.loadOutbox()[0].tries, 1, 'the bump persisted');
    A.eq(s.removeOutbox(it.id), true, 'remove drops it');
    A.eq(s.loadOutbox(), [], 'outbox empty after remove');
    A.eq(s.removeOutbox('nope'), false, 'removing a missing id is a safe no-op');
  }

  // ---- A2. durable ids remain unique when a restarted process sees the same clock tick ----
  {
    const fs = memFs();
    clk = 2100;
    const firstStore = mkStore(fs);
    const first = firstStore.pushOutbox({ channel: 'telegram', chatId: 'one', text: 'first reply' });
    const restartedStore = mkStore(fs);
    const second = restartedStore.pushOutbox({ channel: 'telegram', chatId: 'two', text: 'second reply' });
    A.ok(first.id !== second.id, 'restart cannot reuse an existing durable outbox id at the same clock tick');
    A.eq(restartedStore.removeOutbox(first.id), true, 'acknowledging the first reply succeeds');
    A.eq(restartedStore.loadOutbox().map(x => x.chatId), ['two'], 'acknowledging one id preserves the other reply');
  }

  // ---- B. bounds: saturation refuses new work instead of evicting old replies; text stays bounded ----
  {
    const s = mkStore(memFs(), { maxOutbox: 3, maxOutboxChars: 20 });
    const big = s.pushOutbox({ channel: 'telegram', chatId: '1', text: 'x'.repeat(100) });
    A.ok(big.text.length < 100 && /truncated/.test(big.text), 'oversized reply is truncated with an honest marker');
    s.pushOutbox({ channel: 'telegram', chatId: '2', text: 't2' });
    s.pushOutbox({ channel: 'telegram', chatId: '3', text: 't3' });
    A.throws(() => s.pushOutbox({ channel: 'telegram', chatId: '4', text: 't4' }), 'full outbox refuses to discard an undelivered reply');
    const items = s.loadOutbox();
    A.eq(items.length, 3, 'outbox is bounded');
    A.eq(items.map(x => x.chatId), ['1', '2', '3'], 'every previously queued reply remains intact');
  }

  // ---- B2. durable inbox is idempotent, bounded, and survives a new store instance ----
  {
    const fs = memFs();
    const s = makeChannelStore({ fs, pathMod, root: ROOT, clock, inboxLimits: { maxInbox: 2 } });
    const msg = { chatId: '77', chatType: 'dm', userId: 'u', text: 'work', messageId: '9' };
    s.pushInbox({ id: 'telegram|77|9', channel: 'telegram', message: msg });
    s.pushInbox({ id: 'telegram|77|9', channel: 'telegram', message: msg });
    A.eq(s.loadInbox('telegram').length, 1, 'duplicate delivery creates one durable intake receipt');
    const restarted = makeChannelStore({ fs, pathMod, root: ROOT, clock, inboxLimits: { maxInbox: 2 } });
    A.eq(restarted.loadInbox('telegram')[0].message.text, 'work', 'unfinished intake survives a store restart');
    restarted.pushInbox({ id: 'telegram|78|10', channel: 'telegram', message: Object.assign({}, msg, { chatId: '78', messageId: '10' }) });
    A.throws(() => restarted.pushInbox({ id: 'telegram|79|11', channel: 'telegram', message: Object.assign({}, msg, { chatId: '79', messageId: '11' }) }), 'a full inbox refuses acknowledgement instead of dropping oldest work');
    A.eq(restarted.removeInbox('telegram|77|9'), true, 'completion removes exactly its receipt');
  }

  // ---- B3. hub claims before returning, clears after completion, and replays a crash survivor on poll-up ----
  {
    const store = mkStore();
    const sends = [], events = [];
    const hub = mkHub(store, async (chatId, text) => { sends.push({ chatId, text }); return { ok: true }; }, events);
    const msg = { chatId: '80', chatType: 'dm', userId: 'u', text: 'normal work', messageId: '30', ts: 1 };
    const running = hub.onInbound(msg);
    A.eq(store.loadInbox('telegram').length, 1, 'admitted message is durable synchronously before processing runs');
    await running;
    A.eq(store.loadInbox('telegram'), [], 'completed reply removes its durable intake receipt');
    hub.close();

    const crashed = { chatId: '81', chatType: 'dm', userId: 'u', text: 'survived crash', messageId: '31', ts: 2 };
    store.pushInbox({ id: 'telegram|81|31', channel: 'telegram', message: crashed });
    const restartedHub = mkHub(store, async (chatId, text) => { sends.push({ chatId, text }); return { ok: true }; }, events);
    restartedHub.onStatus({ state: 'up' });
    for (let i = 0; i < 10 && store.loadInbox('telegram').length; i++) await new Promise(r => setTimeout(r, 0));
    A.eq(store.loadInbox('telegram'), [], 'poll-up replays and completes unfinished durable intake');
    A.ok(sends.some(s => s.chatId === '81' && /the result/.test(s.text)), 'recovered intake produces its real reply');
    restartedHub.close();
  }

  // ---- C. hub queues ONLY the undelivered remainder of a failed reply ----
  {
    const events = [];
    const store = mkStore();
    // chunk limit 12 → 'the result' fits one chunk; make send fail
    let sendOk = false;
    const hub = mkHub(store, async () => (sendOk ? { ok: true } : { ok: false, error: 'net down' }), events);
    await hub.onInbound({ chatId: '55', chatType: 'dm', userId: 'u1', text: 'do the thing', messageId: 'm1', ts: 1 });
    const q = store.loadOutbox('telegram');
    A.eq(q.length, 1, 'the failed reply was queued');
    A.ok(/the result/.test(q[0].text), 'queued text carries the undelivered reply');
    A.ok(/delayed reply/.test(q[0].text), 'queued text is marked as delayed (honesty when it lands late)');
    A.eq(q[0].chatId, '55', 'queued under the right chat');
    const del = events.filter(e => e[0] === 'channel.delivery');
    A.eq(del.length, 1, 'the original failure still emitted its delivery event');
    A.eq(del[0][1].ok, false, '…as ok:false (no lie)');

    // ---- D. the adapter's next 'up' status redelivers it ----
    sendOk = true;
    hub.onStatus({ state: 'up' });
    await new Promise(r => setTimeout(r, 0));
    A.eq(store.loadOutbox('telegram'), [], 'outbox drained on the up status');
    const redeliver = events.filter(e => e[0] === 'channel.delivery' && e[1].reason === 'redelivered');
    A.eq(redeliver.length, 1, 'redelivery emitted an honest ok:true event');
    A.eq(redeliver[0][1].chatId, '55', 'redelivered to the right chat');
  }

  // ---- E. a successful NEW delivery also drains the backlog (mid-session failure, status never dropped) ----
  {
    const events = [];
    const store = mkStore();
    store.pushOutbox({ channel: 'telegram', chatId: '88', text: 'stranded earlier', runId: 'r0' });
    const hub = mkHub(store, async () => ({ ok: true }), events);
    await hub.onInbound({ chatId: '99', chatType: 'dm', userId: 'u1', text: 'hi again', messageId: 'm2', ts: 2 });
    await new Promise(r => setTimeout(r, 0));
    A.eq(store.loadOutbox('telegram'), [], 'backlog drained after a healthy send');
    A.ok(events.some(e => e[0] === 'channel.delivery' && e[1].reason === 'redelivered' && e[1].chatId === '88'), 'the stranded reply reached its chat');
  }

  // ---- F. /command replies are never queued (ephemeral by design) ----
  {
    const events = [];
    const store = mkStore();
    const hub = mkHub(store, async () => ({ ok: false, error: 'down' }), events);
    await hub.onInbound({ chatId: '11', chatType: 'dm', userId: 'u1', text: '/help', messageId: 'm3', ts: 3 });
    A.eq(store.loadOutbox('telegram'), [], 'a failed /command reply is not queued');
  }

  // ---- F2. outbound-only recovery retries itself; no new inbound or poll reconnect is required ----
  {
    const events = [];
    const store = mkStore();
    let sendOk = false;
    const hub = mkHub(store, async () => (sendOk ? { ok: true } : { ok: false, error: 'outbound only' }), events);
    await hub.onInbound({ chatId: '12', chatType: 'dm', userId: 'u1', text: 'finish this', messageId: 'm4', ts: 4 });
    A.eq(store.loadOutbox('telegram').length, 1, 'outbound-only failure is queued');
    sendOk = true;
    await new Promise(r => setTimeout(r, 20));
    A.eq(store.loadOutbox('telegram'), [], 'scheduled retry drains it without a new message or poll transition');
    A.ok(events.some(e => e[0] === 'channel.delivery' && e[1].reason === 'redelivered'), 'scheduled recovery emits the proven redelivery');
    hub.close();
  }

  // ---- G. prolonged outage: escalation is visible, but the reply remains queued until recovery ----
  {
    const events = [];
    const store = mkStore();
    store.pushOutbox({ channel: 'telegram', chatId: '13', text: 'doomed', runId: 'rX' });
    const hub = mkHub(store, async () => ({ ok: false, error: 'still down' }), events);
    const tries = hub._internals.OUTBOX_ESCALATE_TRIES;
    for (let i = 0; i < tries; i++) await hub._internals.flushOutbox();
    A.eq(store.loadOutbox('telegram').length, 1, 'the delayed reply is retained after ' + tries + ' attempts');
    const delayed = events.filter(e => e[0] === 'channel.delivery' && e[1].reason === 'redelivery-delayed');
    A.eq(delayed.length, 1, 'the prolonged delay emitted one honest escalation event');
    A.eq(delayed[0][1].ok, false, '…as ok:false');
    hub.close();
  }

  // ---- H. saturation backpressures durable intake, then replays it when old replies drain ----
  {
    const events = [];
    const store = mkStore(memFs(), { maxOutbox: 1 });
    store.pushOutbox({ channel: 'telegram', chatId: 'old', text: 'older delayed answer', runId: 'old-run' });
    let sendOk = false;
    const sends = [];
    const hub = mkHub(store, async (chatId, text) => { sends.push({ chatId, text, ok: sendOk }); return sendOk ? { ok: true } : { ok: false, error: 'down' }; }, events);
    let rejected = false;
    try { await hub.onInbound({ chatId: 'new', chatType: 'dm', userId: 'u1', text: 'new work', messageId: 'm5', ts: 5 }); }
    catch (_) { rejected = true; }
    A.ok(rejected, 'a reply that cannot enter the full outbox does not claim processing complete');
    A.eq(store.loadOutbox('telegram').map(x => x.chatId), ['old'], 'saturation preserves the older queued reply');
    A.eq(store.loadInbox('telegram').map(x => x.message.chatId), ['new'], 'the newer message remains durably pending');

    sendOk = true;
    await hub._internals.flushOutbox();
    for (let i = 0; i < 20 && store.loadInbox('telegram').length; i++) await new Promise(r => setTimeout(r, 0));
    A.eq(store.loadOutbox('telegram'), [], 'old queued reply drains after recovery');
    A.eq(store.loadInbox('telegram'), [], 'capacity recovery replays and completes the pending intake');
    A.ok(sends.some(x => x.chatId === 'new' && /the result/.test(x.text)), 'the backpressured message ultimately receives its answer');
    // a same-process replay is no restart (e5ecd6b8 review): the chat gets that answer once, and no "restarted" notice
    A.eq(sends.filter(x => x.chatId === 'new' && x.ok).map(x => x.text), ['the result'], 'the chat is sent the answer once and is never told StarNet restarted');
    hub.close();
  }

  // ---- H-tool. the same backpressure replay when the run had begun a TOOL step (e5ecd6b8 review, 2026-10-21) ----
  // The replay is no restart and the run had FINISHED: it must deliver that answer, never re-run the step, and never
  // say "StarNet restarted". The receipt's crash marker once read this as a post-crash re-delivery: the chat got
  // "⚠ StarNet restarted … NOT run again" and the finished answer was never delivered.
  {
    const events = [];
    const store = mkStore(memFs(), { maxOutbox: 1 });
    store.pushOutbox({ channel: 'telegram', chatId: 'old', text: 'older delayed answer', runId: 'old-run' });
    let sendOk = false, runs = 0;
    const sends = [], sideEffects = [];
    const hub = makeChannelHub({
      channel: 'telegram',
      runOnce: async (o) => {
        runs++;
        o.emit('agent.run.start', { runId: o.runId });
        o.emit('agent.tool_call', { runId: o.runId, callId: 'c' + runs, name: 'fs_append' }); sideEffects.push(runs);
        o.emit('agent.token', { delta: 'the result' }); o.emit('agent.run.end', { reason: 'done' });
      },
      store,
      send: async (chatId, text) => { sends.push({ chatId, text, ok: sendOk }); return sendOk ? { ok: true } : { ok: false, error: 'down' }; },
      secrets: () => ({ key: 'k', model: 'm', configured: true }),
      emit: (name, payload) => events.push([name, payload]),
      newId: (() => { let n = 0; return () => 'trun-' + (++n); })(),
      sleep: () => Promise.resolve(), outboxRetryMs: 5
    });
    let rejected = false;
    try { await hub.onInbound({ chatId: 'new', chatType: 'dm', userId: 'u1', text: 'new work', messageId: 'm6', ts: 6 }); }
    catch (_) { rejected = true; }
    A.ok(rejected, 'fixture: the finished reply could not enter the full outbox');
    A.ok(/the result/.test(((store.loadInbox('telegram')[0] || {}).held || {}).text || ''), 'the pending receipt keeps the finished answer');
    sendOk = true;
    await hub._internals.flushOutbox();
    for (let i = 0; i < 40 && store.loadInbox('telegram').length; i++) await new Promise(r => setTimeout(r, 0));
    const toNew = sends.filter(x => x.chatId === 'new' && x.ok);
    A.eq(store.loadInbox('telegram'), [], 'capacity recovery completes the pending intake');
    A.eq(runs, 1, 'the run that finished is not run again');
    A.eq(sideEffects.length, 1, 'its tool step happened exactly once');
    A.eq(toNew.map(x => x.text), ['the result'], 'the backpressured message receives its answer — and no "restarted" notice, since nothing restarted');
    A.ok(!((store.getChatRecord('new') || {}).interruptedAttempt), 'and no "earlier request was interrupted" host note is queued for the next run');
    hub.close();
  }

  // ---- G. a FAILED merged text batch keeps EVERY bubble's durable inbox receipt, not just the winner's ----
  // The debounce loser used to `return rec.done`, which resolved even when processing threw — its receipt
  // was removed as "handled" while the merged work had actually failed, so recovery replayed only the
  // winning bubble and the rest of the thought was permanently lost.
  {
    const events = [];
    const store = mkStore(memFs(), { maxOutbox: 1 });
    store.pushOutbox({ channel: 'telegram', chatId: 'old', text: 'older delayed answer', runId: 'old-run' });
    let sendOk = false;
    const sends = [];
    const hub = makeChannelHub({
      channel: 'telegram',
      runOnce: async (o) => { o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'the result' }); o.emit('agent.run.end', { reason: 'done' }); },
      store,
      send: async (chatId, text) => { sends.push({ chatId, text, ok: sendOk }); return sendOk ? { ok: true } : { ok: false, error: 'down' }; },
      secrets: () => ({ key: 'k', model: 'm', configured: true }),
      emit: (name, payload) => events.push([name, payload]),
      newId: (() => { let n = 0; return () => 'grun-' + (++n); })(),
      sleep: () => new Promise(r => setTimeout(r, 0)), outboxRetryMs: 5, textBatchWaitMs: 1
    });
    const bubble = (text, mid) => ({ chatId: '91', chatType: 'dm', userId: 'u1', text, messageId: mid, ts: 6 });
    const outcomes = await Promise.allSettled([hub.onInbound(bubble('check the deploy', 'b1')), hub.onInbound(bubble('and the logs', 'b2'))]);
    A.eq(outcomes.map(o => o.status), ['rejected', 'rejected'], 'the batch failure reaches every merged bubble, loser included');
    A.eq(store.loadInbox('telegram').map(x => x.id).sort(), ['telegram|91|b1', 'telegram|91|b2'], 'BOTH bubbles remain durably pending after the merged processing failed');

    sendOk = true;
    await hub._internals.flushOutbox();
    for (let i = 0; i < 40 && store.loadInbox('telegram').length; i++) await new Promise(r => setTimeout(r, 0));
    A.eq(store.loadInbox('telegram'), [], 'capacity recovery replays and completes every pending bubble');
    // the merged run had finished: its one answer is delivered once, not re-earned bubble by bubble
    A.eq(sends.filter(x => x.chatId === '91' && x.ok && /the result/.test(x.text)).length, 1, 'the merged batch\'s finished answer reaches the chat once after recovery');
    A.eq(events.filter(e => e[0] === 'channel.delivery' && e[1].chatId === '91' && e[1].ok).length, 1, 'one successful delivery for the one merged run');
    hub.close();
  }

  // ---- H. PARTIAL redelivery persists its progress: already-received chunks are never re-sent ----
  // A 3-chunk queued reply whose 3rd chunk hit a blip used to stay in the outbox WHOLE, so every retry
  // pass replayed chunks 1-2 at the member before failing again — the first two-thirds of the answer
  // over and over, the end never arriving until the transport healed for one full pass.
  {
    const events = [];
    const store = mkStore(memFs());
    store.pushOutbox({ channel: 'telegram', chatId: 'pp', text: 'AAAABBBBCCCC', runId: 'r-pp' });
    const sends = []; let calls = 0;
    const hub = makeChannelHub({
      channel: 'telegram',
      runOnce: async () => {},
      store,
      send: async (chatId, text) => { calls++; sends.push(text); return calls === 3 ? { ok: false, error: 'blip' } : { ok: true }; },
      secrets: () => ({ key: 'k', model: 'm', configured: true }),
      emit: (name, payload) => events.push([name, payload]),
      newId: (() => { let n = 0; return () => 'prun-' + (++n); })(),
      sleep: () => Promise.resolve(), outboxRetryMs: 5, maxMessageLength: 4
    });
    await hub._internals.flushOutbox();
    A.eq(store.loadOutbox('telegram')[0].text, 'CCCC', 'after a mid-item blip the item keeps ONLY the undelivered remainder');
    await hub._internals.flushOutbox();
    A.eq(sends, ['AAAA', 'BBBB', 'CCCC', 'CCCC'], 'the retry sends only the remainder — never the chunks the member already read');
    A.eq(store.loadOutbox('telegram'), [], 'the item completes and drains');
    hub.close();
  }

  // ---- H2. a FENCED partial remainder is rebuilt from RAW splits, and progress never counts as failure ----
  // Joining the fence-doctored send chunks baked reopenFences's synthetic ``` markers into the stored
  // text; the next pass re-fenced them — stray fence lines growing per retry on long code replies. And
  // bumpOutboxTry counted a pass that delivered real chunks toward the escalation ceiling.
  {
    const { chunkTextParts } = require('../sidecar/channels/hub.js');
    const events = [];
    const store = mkStore(memFs());
    const fencedText = 'intro line\n```\ncode a\ncode b\ncode c\ncode d\n```\nclosing prose';
    store.pushOutbox({ channel: 'telegram', chatId: 'fx', text: fencedText, runId: 'r-fx' });
    const parts = chunkTextParts(fencedText, 24);
    A.ok(parts.send.length >= 3 && parts.send.join('') !== fencedText, 'fixture: the fenced text splits and the send view is decorated');
    const sends = []; let calls = 0;
    const hub = makeChannelHub({
      channel: 'telegram', runOnce: async () => {}, store,
      send: async (chatId, text) => { calls++; sends.push(text); return calls === 2 ? { ok: false, error: 'blip' } : { ok: true }; },
      secrets: () => ({ key: 'k', model: 'm', configured: true }),
      emit: (name, payload) => events.push([name, payload]),
      newId: (() => { let n = 0; return () => 'fxrun-' + (++n); })(),
      sleep: () => Promise.resolve(), outboxRetryMs: 5, maxMessageLength: 24
    });
    await hub._internals.flushOutbox();
    const stored = store.loadOutbox('telegram')[0];
    A.eq(stored.text, parts.raw.slice(1).join(''), 'the remainder is the RAW tail of the original text — no synthetic fences baked in');
    A.eq(stored.tries, 0, 'a pass that delivered a real chunk is progress, never a counted failure');
    while (store.loadOutbox('telegram').length && calls < 40) await hub._internals.flushOutbox();
    A.eq(store.loadOutbox('telegram'), [], 'the item completes across retries');
    const fenceLines = (sends.join('\n').match(/^[ \t]{0,3}```/gm) || []).length;
    const perfectLines = (chunkTextParts(fencedText, 24).send.join('\n') + '\n' + chunkTextParts(parts.raw.slice(1).join(''), 24).send.join('\n')).match(/^[ \t]{0,3}```/gm).length;
    A.ok(fenceLines <= perfectLines, 'no fence duplication accumulates across retries (' + fenceLines + ' <= ' + perfectLines + ')');
    hub.close();
  }

  // ---- H3. deliver()'s OWN remainder (the outbox text and heldText) is rebuilt from RAW splits too ----
  // H2 fixed the flush pass; deliver() itself still joined the fence-doctored send chunks, so the FIRST queueing of a
  // long code reply baked reopenFences's synthetic ``` markers into the stored text (and into heldText, which the
  // inbox replay sends verbatim) — the redelivery then re-fenced them (qw-channels-lines quick win 20).
  {
    const { chunkTextParts } = require('../sidecar/channels/hub.js');
    const fencedText = 'intro line\n```\ncode a\ncode b\ncode c\ncode d\n```\nclosing prose';
    const parts = chunkTextParts(fencedText, 24);
    A.ok(parts.send.slice(1).join('') !== parts.raw.slice(1).join(''), 'fixture: the decorated tail differs from the raw tail');
    const mk = (store, sendImpl) => makeChannelHub({
      channel: 'telegram', runOnce: async () => {}, store, send: sendImpl,
      secrets: () => ({ key: 'k', model: 'm', configured: true }), emit: () => {},
      newId: (() => { let n = 0; return () => 'h3run-' + (++n); })(),
      sleep: () => Promise.resolve(), outboxRetryMs: 1e9, maxMessageLength: 24
    });
    // (a) the outbox item queued by deliver() carries the RAW tail under the delayed-reply header
    const store = mkStore(memFs());
    let calls = 0;
    const hub = mk(store, async () => { calls++; return calls === 1 ? { ok: true, messageId: 'm1' } : { ok: false, error: 'blip', retryable: true }; });
    const r = await hub._internals.deliver('h3', fencedText, 'r-h3', 'done', '');
    A.eq(r.ok, false, 'fixture: the second chunk failed');
    const queued = store.loadOutbox('telegram')[0];
    A.ok(!!queued, 'the undelivered remainder is queued');
    A.eq(queued.text.replace(/^⌛[^\n]*\n/, ''), parts.raw.slice(1).join(''), 'the queued remainder is the RAW tail — no synthetic fences baked in');
    hub.close();
    // (b) heldText (the outbox refused the remainder) is the RAW tail as well
    const full = mkStore(memFs());
    full.pushOutbox = () => { throw new Error('channel outbox is full'); };
    let calls2 = 0;
    const hub2 = mk(full, async () => { calls2++; return calls2 === 1 ? { ok: true, messageId: 'm1' } : { ok: false, error: 'blip', retryable: true }; });
    let held = null;
    try { await hub2._internals.deliver('h3b', fencedText, 'r-h3b', 'done', ''); } catch (e) { held = e && e.heldText; }
    A.eq(held, parts.raw.slice(1).join(''), 'heldText is the RAW tail the replay will send verbatim');
    hub2.close();
  }

  // ---- H4. a NON-RETRYABLE send failure is parked as undeliverable, never queued to retry forever ----
  // The transport says retryable:false for a 4xx (chat not found, message too long, forbidden): the same send fails
  // identically every pass. Queued anyway, it sat at the head of the outbox and every flush pass broke on it — the
  // replies queued BEHIND it never went out (quick win 22). It is said ONCE, as one channel.delivery event.
  {
    const events = [];
    const store = mkStore(memFs());
    const hub = makeChannelHub({
      channel: 'telegram', runOnce: async () => {}, store,
      send: async (chatId) => (chatId === 'gone' ? { ok: false, error: 'Bad Request: chat not found', retryable: false }
        : chatId === 'abort' ? { ok: false, error: 'aborted', retryable: false } : { ok: true, messageId: 'm' }),
      secrets: () => ({ key: 'k', model: 'm', configured: true }),
      emit: (name, payload) => events.push([name, payload]),
      newId: (() => { let n = 0; return () => 'h4run-' + (++n); })(),
      sleep: () => Promise.resolve(), outboxRetryMs: 1e9
    });
    const r = await hub._internals.deliver('gone', 'the finished answer', 'r-h4', 'done', 'ag');
    A.eq(r.ok, false, 'the send failed');
    A.eq(store.loadOutbox('telegram'), [], 'a non-retryable failure is NOT queued for redelivery');
    const dels = events.filter(e => e[0] === 'channel.delivery');
    A.eq(dels.length, 1, 'exactly one channel.delivery event');
    A.eq([dels[0][1].ok, dels[0][1].reason], [false, 'undeliverable'], 'it says the reply is undeliverable');
    // the outbox refusing would have thrown (heldText) — an undeliverable reply must not keep its inbox receipt alive either
    const full = mkStore(memFs());
    full.pushOutbox = () => { throw new Error('channel outbox is full'); };
    const hub2 = makeChannelHub({
      channel: 'telegram', runOnce: async () => {}, store: full,
      send: async () => ({ ok: false, error: 'Forbidden: bot was blocked by the user', retryable: false }),
      secrets: () => ({ key: 'k', model: 'm', configured: true }), emit: () => {},
      newId: () => 'x', sleep: () => Promise.resolve(), outboxRetryMs: 1e9
    });
    let threw = null;
    try { await hub2._internals.deliver('c', 'answer', 'r', 'done', ''); } catch (e) { threw = e; }
    A.eq(threw, null, 'an undeliverable reply never throws for a replay: replaying would fail identically');
    hub2.close();
    // an ABORTED send is the transport being torn down, not the chat refusing: it still queues
    await hub._internals.deliver('abort', 'answer two', 'r-h4b', 'done', 'ag');
    A.eq(store.loadOutbox('telegram').length, 1, 'an aborted send is still queued for redelivery');
    hub.close();
  }

  // ---- H5. a refused CREDENTIAL is the whole channel failing, not the chat: the reply stays queued for the re-pair ----
  // Review of quick win 22: every transport marks 401-class failures retryable:false, so H4's rule parked a reply that
  // failed because the bot token was revoked (BotFather /revoke, a rotated Slack token). Before QW22 that reply was
  // queued and the re-paired hub's 'up' flushed it to the same chat; parked, it was gone. Each transport now marks a
  // refused credential auth:true, and deliver() queues it. Driven through the REAL transports' send, not a hand-built result.
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
    // (b) through the hub: a revoked token keeps the reply queued; the re-paired bot's flush delivers it to the same chat
    let revoked = true; const wire = [];
    const t = makeTelegramTransport({ token: '1:T', fetch: async (url, o) => {
      const body = JSON.parse(o.body || '{}'); wire.push(body.text);
      return revoked ? res(401, { ok: false, error_code: 401, description: 'Unauthorized' }) : res(200, { ok: true, result: { message_id: 7 } });
    } });
    const events = [];
    const store = mkStore(memFs());
    const hub = makeChannelHub({
      channel: 'telegram', runOnce: async () => {}, store, send: (chatId, text, o) => t.send(chatId, text, o),
      secrets: () => ({ key: 'k', model: 'm', configured: true }),
      emit: (name, payload) => events.push([name, payload]),
      newId: () => 'h5', sleep: () => Promise.resolve(), outboxRetryMs: 1e9
    });
    const r = await hub._internals.deliver('55', 'the finished answer', 'r-h5', 'done', 'ag');
    A.eq(r.ok, false, 'the send failed on the revoked token');
    const q = store.loadOutbox('telegram');
    A.eq(q.length, 1, 'a refused credential is NOT parked: the reply stays queued for the re-paired bot');
    A.ok(/the finished answer$/.test(q[0] && q[0].text), 'the queued item is that reply');
    const del = events.filter(e => e[0] === 'channel.delivery').map(e => e[1].reason);
    A.eq(del, ['done'], 'and it is not reported as undeliverable');
    revoked = false;   // the Commander re-pairs
    await hub._internals.flushOutbox();
    A.eq(store.loadOutbox('telegram'), [], 'the flush after the re-pair delivers it');
    A.ok(/the finished answer$/.test(wire[wire.length - 1]), 'to the same chat, the reply itself');
    hub.close();
    // a one-chat refusal from the same real transport is still parked (H4's rule stands)
    const t400 = tg(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
    const store2 = mkStore(memFs());
    const hub2 = makeChannelHub({
      channel: 'telegram', runOnce: async () => {}, store: store2, send: (chatId, text, o) => t400.send(chatId, text, o),
      secrets: () => ({ key: 'k', model: 'm', configured: true }), emit: () => {},
      newId: () => 'h5b', sleep: () => Promise.resolve(), outboxRetryMs: 1e9
    });
    await hub2._internals.deliver('56', 'answer', 'r-h5b', 'done', '');
    A.eq(store2.loadOutbox('telegram'), [], 'a chat-level refusal from the real transport is still parked');
    hub2.close();
  }

  // ---- I. a STALE recovery snapshot never replays a message that completed while recovery waited ----
  // Live-caught 2026-10-20 (sweep/channels): a follow-up typed while a task was running was steered into it AND
  // run again as its own task afterwards. The follow-up's ack delivery drained the outbox, whose "capacity is back"
  // cue called recoverInbox; its snapshot held [the running task, the follow-up], it parked on the running task's
  // live promise for the whole run, and then replayed the follow-up from the stale list although it had long since
  // finished and left the inbox. Every message sent during a run (a steer, /routine add, /away …) ran twice.
  {
    const events = [], sends = [], runs = [];
    const store = mkStore(memFs());
    let releaseA; const gateA = new Promise(r => { releaseA = r; });
    let releaseAck; const gateAck = new Promise(r => { releaseAck = r; });
    const hub = makeChannelHub({
      channel: 'telegram',
      runOnce: async (o) => {
        const last = o.messages[o.messages.length - 1];
        runs.push(String((last && last.content) || ''));
        o.emit('agent.run.start', { runId: o.runId });
        o.emit('agent.token', { delta: 'result for ' + String((last && last.content) || '') });
        if (/long task/.test(String(last && last.content))) await gateA;
        o.emit('agent.run.end', { reason: 'done' });
      },
      steerRun: () => ({ ok: true, status: 200 }),
      store,
      send: async (chatId, text) => { sends.push(text); if (/Added to the task/.test(text)) await gateAck; return { ok: true }; },
      secrets: () => ({ key: 'k', model: 'm', configured: true }),
      emit: (name, payload) => events.push([name, payload]),
      newId: (() => { let n = 0; return () => 'irun-' + (++n); })(),
      sleep: () => Promise.resolve(), outboxRetryMs: 5
    });
    const tick = () => new Promise(r => setTimeout(r, 0));
    const a = hub.onInbound({ chatId: '93', chatType: 'dm', userId: 'u1', text: 'long task', messageId: 'a1', ts: 1 });
    for (let i = 0; i < 20 && !hub._internals.inflight.get('93'); i++) await tick();
    A.ok(!!hub._internals.inflight.get('93'), 'fixture: the long task is in flight');
    const b = hub.onInbound({ chatId: '93', chatType: 'dm', userId: 'u1', text: 'also add a limerick', messageId: 'b1', ts: 2 });
    for (let i = 0; i < 20 && !sends.some(s => /Added to the task/.test(s)); i++) await tick();
    A.eq(store.loadInbox('telegram').map(x => x.id).sort(), ['telegram|93|a1', 'telegram|93|b1'], 'fixture: both messages are durably pending while the steer ack is in flight');
    const recovery = hub._internals.recoverInbox();   // the outbox's "capacity is back" cue, mid-steer
    releaseAck(); await b;
    A.eq(store.loadInbox('telegram').map(x => x.id), ['telegram|93|a1'], 'the steered follow-up is done and has left the inbox');
    releaseA(); await a; await recovery;
    for (let i = 0; i < 20; i++) await tick();
    A.eq(runs.filter(t => /also add a limerick/.test(t)).length, 0, 'the steered follow-up never starts a run of its own');
    A.eq(sends.filter(s => /Added to the task/.test(s)).length, 1, 'and the chat hears its acknowledgement exactly once');
    A.eq(store.loadInbox('telegram'), [], 'nothing is left pending');
    hub.close();
  }

  // ---- J. a RECONNECTED hub never replays the old hub's in-flight message ----
  // startTelegram() closes the old hub and builds a new one over the SAME store while the old hub's run is still
  // going (it finishes and replies on its own). The new adapter's first 'up' ran recoverInbox, found that run's
  // receipt still pending, and — its in-flight map being its own — started the same message again: a second paid
  // run and a second reply. The live claim belongs to the store both hubs share.
  {
    const events = [], sends = [], runs = [];
    const store = mkStore(memFs());
    let release; const gate = new Promise(r => { release = r; });
    const mk = (tag) => makeChannelHub({
      channel: 'telegram',
      runOnce: async (o) => {
        runs.push(tag);
        o.emit('agent.run.start', { runId: o.runId });
        o.emit('agent.token', { delta: 'answer from ' + tag });
        await gate;
        o.emit('agent.run.end', { reason: 'done' });
      },
      store,
      send: async (chatId, text) => { sends.push(text); return { ok: true }; },
      secrets: () => ({ key: 'k', model: 'm', configured: true }),
      emit: (name, payload) => events.push([name, payload]),
      newId: (() => { let n = 0; return () => tag + '-run-' + (++n); })(),
      sleep: () => Promise.resolve(), outboxRetryMs: 5
    });
    const tick = () => new Promise(r => setTimeout(r, 0));
    const oldHub = mk('old');
    const work = oldHub.onInbound({ chatId: '94', chatType: 'dm', userId: 'u1', text: 'research this', messageId: 'r1', ts: 1 });
    for (let i = 0; i < 20 && !runs.length; i++) await tick();
    A.eq(runs, ['old'], 'fixture: the old hub\'s run is in flight');
    oldHub.close();                                   // reconnect: stopTelegram() then a fresh hub
    const newHub = mk('new');
    newHub.onStatus({ state: 'up' });                 // the new adapter's first poll
    for (let i = 0; i < 20; i++) await tick();
    A.eq(runs, ['old'], 'the new hub does not start a second run of the in-flight message');
    release(); await work;
    for (let i = 0; i < 20; i++) await tick();
    A.eq(runs, ['old'], 'still exactly one run once the old one finishes');
    A.eq(sends.filter(s => /answer from/.test(s)).length, 1, 'the chat hears exactly one reply');
    A.eq(store.loadInbox('telegram'), [], 'the receipt is cleared by the run that owned it');
    // a genuine crash survivor (no live owner in this process) still replays on the next up
    store.pushInbox({ id: 'telegram|94|r2', channel: 'telegram', message: { chatId: '94', chatType: 'dm', userId: 'u1', text: 'left over', messageId: 'r2', ts: 2 } });
    newHub.onStatus({ state: 'up' });
    for (let i = 0; i < 40 && store.loadInbox('telegram').length; i++) await tick();
    A.eq(runs, ['old', 'new'], 'an ownerless pending receipt is still recovered');
    newHub.close();
  }

  A.report('channels.outbox.test');
})().catch(e => { console.error(e); process.exit(1); });
