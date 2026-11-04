/* node test/channels.delivery.golden.test.js — the channel delivery GOLDEN (channel-delivery-ledger, step S1).

   WHAT IT GUARDS. The hub's delivery code (deliver, the outbox flush and its timers, the durable intake claim, the
   membership backlog drop, the chunker, the route book, the steer join) and the routine delivery that lived in
   sidecar/index.js move into their own modules as PURE moves. A move is only proven pure if what the code did before it
   still does after, byte for byte. This test drives fixed scenarios through the REAL hub over the REAL channel store (one
   in-memory disk with no statSync and no linkSync, the facade the eval crash gauntlet uses too) and through the real
   deliverCronResult, and records two traces of each:
     transport  every call that leaves for the platform (send, edit, delete; for a routine also sendMedia, the session
                delivery and the 429 wait before a resend) and every channel.delivery event, in the order they happened.
                A routine call's own result (what the cron driver persists) closes each of its calls.
     store      every write the store made to a main file under channels/ (the file and its whole new content), in
                order, plus a routine's transcript rows. The .bak copy kept beside each main is left out: it repeats the
                write before it. Since the delivery ledger (S2) that is chiefly channels/delivery.json: the receipt, the
                attempt marks, the answer that takes the receipts as the reply enters its lane, and each part's mark.
   Both must equal test/fixtures/channels-delivery-golden.json exactly, compared as serialized JSON scenario by scenario.

   THE SCENARIOS. No fault: one reply, a reply split over a forum topic, a merged text batch, a choice keyboard (it rides
   the last chunk only), a streamed seed that chunk 0 replaces in place. Faults: a failed reply kept and redelivered by its
   lane's retry timer, part marks that never resend a landed chunk, a part that starts inside a code fence, an
   undeliverable reply turned into a tombstone, a refused credential kept for the re-paired hub, a membership kick that
   gives a chat's backlog up, crash replays of a receipt whose run began 0 and N tool steps, a finished reply a v1 inbox
   held (migrated at boot and sent, never re-run), backpressure that defers a chat's new message until its lane drains, a
   reconnect whose new hub must not run what the old hub is still running (the store-wide live claim), and a command
   reply that is never queued. The routine scenario runs the real
   deliverCronResult over multi-part text, a 429 on one part, a file, a refused file, a target whose channel is down, an
   origin thread, a session hand-back and a script routine: makeRoutineDelivery (sidecar/routine-delivery.js) or, on a
   tree from before S1 moved it, the same functions sliced out of sidecar/index.js (test/helpers/source.js) and run in a
   vm context over the same deps. So this one file proves the routine trace identical on both sides of that move. Since
   S4 a routine's chat target is one durable record on the outbound contract (channels/outbound.js): its chat's lane
   sends it through the station hub's attached sender, a refused part waits for the lane's retry instead of a 429 wait,
   and the cron's next ask is answered from the record.

   RE-RECORD only when a commit changes delivery on purpose, and say in that commit which scenarios changed and why:
     node test/channels.delivery.golden.test.js --update
   A pure move never re-records. Later steps of the lane state theirs: the ledger (S2) kept the transport trace of the
   no-fault scenarios (NO_FAULT below) byte-identical and re-recorded the store trace and the fault scenarios; routine
   delivery on the shared outbound contract (S4) re-recorded the routine trace: the same parts, file and note go out,
   part 3 on its lane's retry rather than after a 429 wait, and each delivery now reports its channel.delivery.
   Factory integration adds the existing steer/queue/background commands to help: only command-reply-not-queued's
   expected help chunk count changes from 15 to 20; transport/store behavior and every other trace stay identical.
   C9 canonical publication changes only the routine trace: actual history import/binding, strict canonical rows,
   ledger acknowledgement and result receipts replace per-agent legacy copies. --update-routine refuses other drift. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makePromptRegistry } = require('../sidecar/channels/prompts.js');
const { TaskIntent } = require('../frontend/app/fork.js');
const { sidecarFunctionSource } = require('./helpers/source.js');
const CanonicalHistory = require('./helpers/channel-history.js');
const HistoryPort = require('../sidecar/channels/history-port.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'channels-delivery-golden.json');
const UPDATE = process.argv.includes('--update');
const UPDATE_ROUTINE = process.argv.includes('--update-routine');
const TRACE_OUT = (process.argv.find(arg => arg.startsWith('--trace-out=')) || '').slice('--trace-out='.length);
const ROOT = '/ws/channels';
const T0 = 1761900000000;   // the station clock every scenario starts at (fixed: a trace never depends on how often it is read)
const NO_FAULT = ['success', 'multi-chunk', 'merged-batch', 'keyboard-last-chunk', 'stream-seed-edit'];

const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const parsed = (text) => { try { return JSON.parse(text); } catch (_) { return String(text); } };

/* ONE SCENARIO'S WORLD: a disk, a station clock, a scripted transport, manual timers and deterministic ids. */
function makeEnv() {
  const env = { now: T0, transport: [], store: [], hubs: [] };
  const files = new Map();
  env.disk = {
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); },
    renameSync(a, b) {
      if (!files.has(a)) { const e = new Error('ENOENT: ' + a); e.code = 'ENOENT'; throw e; }
      files.set(b, files.get(a)); files.delete(a);
      const name = path.posix.basename(b);
      if (!/\.bak$/.test(name)) env.store.push({ file: name, data: parsed(files.get(b)) });
    },
    mkdirSync() {}
  };
  // a file the disk already held when this scenario's process booted (not a write of this process: untraced)
  env.seed = (name, value) => { files.set(ROOT + '/' + name, JSON.stringify(value)); };
  env.at = (t) => { env.now = t; };
  env.makeStore = (opts) => makeChannelStore(Object.assign({ fs: env.disk, pathMod: path.posix, root: ROOT, clock: { now: () => env.now }, bootId: 'boot-golden',
    timers: { setTimeout: (fn, ms) => env.timers.set(fn, ms), clearTimeout: (t) => env.timers.clear(t) } }, opts || {}));
  const counters = {};
  env.ids = (prefix) => () => prefix + '-' + (counters[prefix] = (counters[prefix] || 0) + 1);

  // THE WIRE: every call is traced; a queued plan answers the next sends (default: accepted, with the next message id)
  const plan = [];
  let msgSeq = 0;
  env.fail = (...results) => { plan.push(...results); };
  const answer = () => {
    const r = plan.length ? plan.shift() : 'ok';
    return r === 'ok' ? { ok: true, messageId: 'm' + (++msgSeq) } : Object.assign({}, r);
  };
  env.send = (chatId, text, opts) => { env.transport.push({ op: 'send', chatId: String(chatId), text: String(text), opts: clone(opts) }); return Promise.resolve(answer()); };
  env.edit = (chatId, messageId, text, opts) => { env.transport.push({ op: 'edit', chatId: String(chatId), messageId: String(messageId), text: String(text), opts: clone(opts) }); return Promise.resolve({ ok: true }); };
  env.del = (chatId, messageId) => { env.transport.push({ op: 'delete', chatId: String(chatId), messageId: String(messageId) }); return Promise.resolve({ ok: true }); };
  env.ack = (callbackId, text) => { env.transport.push({ op: 'ack', callbackId: String(callbackId), text: text == null ? null : String(text) }); return Promise.resolve({ ok: true }); };
  env.emit = (name, payload) => { if (name === 'channel.delivery') env.transport.push({ op: 'event', name: name, payload: clone(payload) }); };

  // TIMERS: the hub's retry timer is held here and fires only when the scenario says so
  const pending = [];
  env.timers = {
    set(fn, ms) { const t = { fn: fn, ms: ms, unref() {} }; pending.push(t); return t; },
    clear(t) { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); }
  };
  env.fireTimers = async () => { const due = pending.splice(0); for (const t of due) t.fn(); await env.drain(); };
  // every chain of this world settles in microtasks; a few macrotask turns let all of them finish
  env.drain = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };

  // the scripted model: each run answers the next text (the last one repeats)
  env.says = (...texts) => {
    let i = 0;
    return async (o) => {
      const text = texts[Math.min(i++, texts.length - 1)];
      o.emit('agent.run.start', { runId: o.runId });
      o.emit('agent.token', { delta: text });
      o.emit('agent.run.end', { reason: 'done' });
    };
  };
  // a hub built the way the station builds a channel hub, minus the parts this golden does not exercise
  env.hub = (extra) => {
    if (!env.storeObj) env.storeObj = env.makeStore(env.storeOpts);
    const hub = makeChannelHub(Object.assign({
      channel: 'telegram', store: env.storeObj, send: env.send, emit: env.emit,
      secrets: () => ({ key: 'k', model: 'm', configured: true }),
      newId: env.ids('run'), now: () => env.now, sleep: () => Promise.resolve(),
      setTimeout: env.timers.set, clearTimeout: env.timers.clear,
      maxMessageLength: 80, reactionAck: false
    }, extra || {}));
    env.hubs.push(hub);
    return hub;
  };
  return env;
}

const dm = (chatId, messageId, text) => ({ channel: 'telegram', chatId: String(chatId), chatType: 'dm', userId: 'u1', userName: 'Ana', text: text, messageId: String(messageId), ts: 1 });
const group = (chatId, messageId, text, threadId) => Object.assign(dm(chatId, messageId, text), { chatType: 'group' }, threadId ? { threadId: String(threadId) } : {});
const receipt = (msg, extra) => Object.assign({ id: 'telegram|' + msg.chatId + '|' + msg.messageId, channel: 'telegram', message: msg, ts: T0 - 60000 }, extra || {});
const swallowed = (p) => Promise.resolve(p).then(() => 'resolved', (e) => 'rejected: ' + ((e && e.message) || e));

/* ---------------------------------------------------------------- the hub scenarios ---------------------------------- */
const SCENARIOS = [];
const scenario = (name, fn) => SCENARIOS.push({ name: name, fn: fn });

scenario('success', async (env) => {
  const hub = env.hub({ runOnce: env.says('Here is the answer.') });
  await hub.onInbound(dm(4242, 1, 'what is the answer?'));
});

scenario('multi-chunk', async (env) => {
  // a forum topic in a group: the thread rides every chunk, the quote only the first
  const hub = env.hub({ runOnce: env.says('First paragraph of a long answer that keeps going past one message.\nSecond paragraph, with more words to split across.\nThird paragraph closes it out.') });
  await hub.onInbound(group(-100777, 2, 'summarize the thread please', 77));
});

scenario('merged-batch', async (env) => {
  // two bubbles inside the batching window are one run over two receipts (Telegram's 350 ms)
  const hub = env.hub({ runOnce: env.says('Both parts noted.'), textBatchWaitMs: 350 });
  const a = hub.onInbound(dm(4242, 3, 'first bubble'));
  const b = hub.onInbound(dm(4242, 4, 'second bubble'));
  await Promise.all([a, b]);
});

scenario('keyboard-last-chunk', async (env) => {
  const hub = env.hub({
    runOnce: env.says('I can book it.\nTASK_QUESTION: Which venue should I book for the team dinner on Friday? || The Harbor Room | Casa Verde | The Rooftop Garden'),
    prompts: makePromptRegistry({ newId: env.ids('tok') }), answerCallback: env.ack, taskIntent: TaskIntent
  });
  await hub.onInbound(dm(4242, 5, 'book the team dinner'));
});

scenario('stream-seed-edit', async (env) => {
  const hub = env.hub({
    editMessage: env.edit, deleteMessage: env.del, streamMinChars: 20,
    runOnce: async (o) => {
      o.emit('agent.run.start', { runId: o.runId });
      o.emit('agent.token', { delta: 'Streaming the first sentence of the answer. ' });   // seeds the message
      await env.drain();                                                                  // the seed lands and names its id
      o.emit('agent.token', { delta: 'Then the rest arrives and runs past one message, so chunk zero replaces the seed in place.' });
      o.emit('agent.run.end', { reason: 'done' });
    }
  });
  await hub.onInbound(dm(4242, 6, 'stream it'));
});

scenario('fail-queue-flush', async (env) => {
  const hub = env.hub({ runOnce: env.says('The report is ready.') });
  env.fail({ ok: false, error: 'network down', retryable: true });
  await hub.onInbound(dm(4242, 7, 'make the report'));
  env.at(T0 + 5000);
  env.fail({ ok: false, error: 'network down', retryable: true });
  await env.fireTimers();   // the retry timer fires while the transport is still down: one more try counted
  env.at(T0 + 15000);
  await env.fireTimers();   // healthy again: the next timer redelivers it
});

scenario('partial-chunk-progress', async (env) => {
  const hub = env.hub({ runOnce: env.says('Part one of the long answer, which is long enough to need three messages here.\nPart two keeps going with more of the detail.\nPart three is the end.') });
  env.fail('ok', { ok: false, error: '429: Too Many Requests', retryable: true, retryAfter: 3 });
  await hub.onInbound(dm(4242, 8, 'write it all out'));
  env.at(T0 + 3000);
  env.fail('ok', { ok: false, error: '503 Service Unavailable', retryable: true });
  hub.onStatus({ state: 'up' });   // a pass that lands one chunk and fails the next keeps only the rest
  await env.drain();
  env.at(T0 + 9000);
  hub.onStatus({ state: 'up' });
  await env.drain();
});

scenario('fenced-remainder', async (env) => {
  const hub = env.hub({ runOnce: env.says('Here is the script:\n```js\nconst a = 1;\nconst b = 2;\nconsole.log(a + b);\nconst c = a * b;\nconsole.log(c);\n```\nRun it with node.') });
  env.fail('ok', { ok: false, error: 'network down', retryable: true });
  await hub.onInbound(dm(4242, 9, 'write the script'));
  env.at(T0 + 5000);
  hub.onStatus({ state: 'up' });
  await env.drain();
});

scenario('undeliverable-park', async (env) => {
  const hub = env.hub({ runOnce: env.says('This reply cannot land.') });
  env.fail({ ok: false, error: 'Bad Request: chat not found', retryable: false });
  await hub.onInbound(dm(4243, 10, 'hello?'));
  hub.onStatus({ state: 'up' });   // nothing was queued, so nothing is retried
  await env.drain();
});

scenario('auth-keep', async (env) => {
  const hub = env.hub({ runOnce: env.says('Kept for the re-paired bot.') });
  env.fail({ ok: false, error: 'Unauthorized', retryable: false, auth: true });
  await hub.onInbound(dm(4242, 11, 'check the logs'));
  hub.close();
  env.at(T0 + 60000);
  const repaired = env.hub({ runOnce: env.says('unused') });   // the re-paired hub over the same store
  repaired.onStatus({ state: 'up' });
  await env.drain();
});

scenario('membership-drop', async (env) => {
  // the third run is still working when the bot is removed from its group
  let release = null, n = 0;
  const removed = new Promise(r => { release = r; });
  const hub = env.hub({
    runOnce: async (o) => {
      const k = ++n;
      o.emit('agent.run.start', { runId: o.runId });
      if (k === 3) await removed;
      o.emit('agent.token', { delta: 'Reply number ' + k + '.' });
      o.emit('agent.run.end', { reason: 'done' });
    }
  });
  env.fail({ ok: false, error: 'network down', retryable: true }, { ok: false, error: 'network down', retryable: true });
  await hub.onInbound(group(-100500, 12, 'first'));
  await hub.onInbound(dm(4242, 13, 'second'));
  const third = hub.onInbound(group(-100500, 14, 'third'));
  await env.drain();
  hub.onMembership({ chatId: '-100500', chatType: 'group', status: 'kicked' });   // its backlog goes, the other chat's stays
  env.fail({ ok: false, error: 'network down', retryable: true });
  release();
  await third;   // its reply fails and is not queued: the chat removed us
  await hub.onInbound(group(-100500, 15, 'we are back'));   // the chat speaking clears the mark; the other chat keeps its own backoff
  await env.drain();
});

scenario('crash-replay-0-tools', async (env) => {
  const msg = dm(4242, 20, 'draft the email');
  env.seed('inbox.json', { version: 1, items: [receipt(msg, { attempt: { runId: 'dead-run-1', tools: 0, boot: 'boot-dead' } })] });
  env.seed('tg_4242.history.json', { version: 1, messages: [{ role: 'user', content: 'draft the email', ts: T0 - 60000 }] });
  const hub = env.hub({ runOnce: env.says('Draft ready.') });
  hub.onStatus({ state: 'up' });
  await env.drain();
});

scenario('crash-replay-n-tools', async (env) => {
  const msg = dm(4242, 21, 'append the audit line');
  env.seed('inbox.json', { version: 1, items: [receipt(msg, { attempt: { runId: 'dead-run-2', tools: 2, boot: 'boot-dead' } })] });
  const hub = env.hub({ runOnce: env.says('Finished the rest.') });
  hub.onStatus({ state: 'up' });
  await env.drain();
  await hub.onInbound(dm(4242, 22, 'continue'));   // the next run is told once; the one-shot note is cleared
});

scenario('held-reply-restart', async (env) => {
  // a merged batch's finished answer the full outbox refused, kept on both receipts by the process that died
  const a = dm(4242, 30, 'first half'), b = dm(4242, 31, 'second half');
  const ids = ['telegram|4242|30', 'telegram|4242|31'];
  const held = { text: 'The finished answer.', runId: 'dead-run-3', reason: 'done', agentId: 'tg_4242', ids: ids };
  const attempt = { runId: 'dead-run-3', tools: 1, boot: 'boot-dead' };
  env.seed('inbox.json', { version: 1, items: [receipt(a, { attempt: attempt, held: held }), receipt(b, { attempt: attempt, held: held })] });
  const hub = env.hub({ runOnce: env.says('must not run') });
  hub.onStatus({ state: 'up' });
  await env.drain();
});

scenario('backpressure-same-process', async (env) => {
  // a chat whose lane owes its mark of replies runs no new message: the message is kept (deferred), never its answer refused
  env.storeOpts = { ledgerLimits: { laneMaxDeliveries: 1 } };
  const hub = env.hub({ runOnce: env.says('First answer.', 'Second answer.') });
  env.fail({ ok: false, error: 'network down', retryable: true });
  await hub.onInbound(dm(4242, 32, 'one'));                                   // kept in its lane: the chat now owes one reply
  env.transport.push({ op: 'note', text: 'second inbound ' + await swallowed(hub.onInbound(dm(4242, 33, 'two'))) });   // deferred, not run
  env.at(T0 + 5000);
  hub.onStatus({ state: 'up' });   // the lane drains...
  await env.drain();
  await env.fireTimers();          // ...and the recover timer runs the deferred message, whose answer follows the first
});

scenario('reconnect-claim', async (env) => {
  // a reconnect builds a new hub over the same store while the old hub's run is still going
  let release = null;
  const finishing = new Promise(r => { release = r; });
  const runOnce = async (o) => {
    o.emit('agent.run.start', { runId: o.runId });
    o.emit('agent.token', { delta: 'One answer, from the run that owned it.' });
    await finishing;
    o.emit('agent.run.end', { reason: 'done' });
  };
  const old = env.hub({ runOnce: runOnce });
  const work = old.onInbound(dm(4242, 50, 'research this'));
  await env.drain();
  old.close();
  const fresh = env.hub({ runOnce: runOnce });
  fresh.onStatus({ state: 'up' });   // the new adapter's first poll: the store-wide claim keeps the message from running twice
  await env.drain();
  release();
  await work;
});

scenario('command-reply-not-queued', async (env) => {
  const hub = env.hub({ runOnce: env.says('unused') });
  env.fail({ ok: false, error: 'network down', retryable: true });
  await hub.onInbound(dm(4242, 40, '/help'));
});

/* ---------------------------------------------------------------- the routine scenario ------------------------------- */
/* routineDelivery(deps) -> { deliverCronResult } — the real routine delivery, over these deps: the module's factory. A tree
   from before S1 moved it (trunk a3af8dafd) has the same code in sidecar/index.js (cronReturnsToSession, cronChatTurn and
   cronChatTails, cronSendPart, cronSupersededNote, deliverCronResult): it is run in a vm context whose globals are the
   deps, Date.now and setTimeout included, so the fixture recorded there is the one the module must reproduce. */
const ROUTINE_DELIVERY = path.join(__dirname, '..', 'sidecar', 'routine-delivery.js');
const OUTBOUND = path.join(__dirname, '..', 'sidecar', 'channels', 'outbound.js');   // the one outbound contract (S4)
function routineDelivery(deps) {
  if (fs.existsSync(ROUTINE_DELIVERY)) return require(ROUTINE_DELIVERY).makeRoutineDelivery(deps);
  const names = ['cronReturnsToSession', 'cronChatTurn', 'cronSendPart', 'cronSupersededNote', 'deliverCronResult'];
  const src = names.map((n) => { const s = sidecarFunctionSource(n); if (!s) throw new Error('golden: ' + n + ' not found in the sidecar'); return s; }).join('\n');
  const ctx = vm.createContext(Object.assign({
    console: console, cronChatTails: new Map(), Date: { now: deps.now }, setTimeout: deps.setTimeout,
    failNote: require('../sidecar/failopen.js').note, RoutineMedia: require('../sidecar/routine-media.js'),
    hubChunkText: require('../sidecar/channels/hub.js').chunkText
  }, deps));
  vm.runInContext(src, ctx, { filename: 'sidecar/index.js (routine delivery slice)' });
  return { deliverCronResult: ctx.deliverCronResult };
}

scenario('routine', async (env) => {
  env.seed('chatmap.json', { version: 1, chats: {
    4242: { agentId: 'nova', channel: 'telegram', threadId: '77', lastSeen: T0 - 60000 },
    99: { agentId: 'nova', channel: 'discord', lastSeen: T0 - 60000 }
  } });
  const channelStore = env.makeStore();
  env.storeObj = channelStore;
  const plan = ['ok', 'ok', { ok: false, error: '429: Too Many Requests', retryable: true, retryAfter: 1 }];
  let msgSeq = 0;
  const adapter = {
    send(chatId, text, route) {
      env.transport.push({ op: 'send', chatId: String(chatId), text: String(text), opts: clone(route) });
      const r = plan.length ? plan.shift() : 'ok';
      return Promise.resolve(r === 'ok' ? { ok: true, messageId: 'r' + (++msgSeq) } : Object.assign({}, r));
    },
    sendMedia(chatId, item, route) {
      env.transport.push({ op: 'sendMedia', chatId: String(chatId), kind: item.kind, filename: item.filename, mime: item.mime, bytes: item.buffer.length, opts: clone(route) });
      return Promise.resolve({ ok: true, messageId: 'r' + (++msgSeq) });
    }
  };
  const read = (agentId, rel) => {
    if (rel === 'charts/today.png') return Promise.resolve({ ok: true, buffer: Buffer.from('PNG-BYTES'), name: 'today.png', mime: 'image/png' });
    if (rel === 'private/key.pem') return Promise.resolve({ ok: false, error: 'a protected file', shown: 'private/key.pem' });
    return Promise.resolve({ ok: false, notFound: true, error: 'not found' });
  };
  const channelReach = (channel) => channel === 'telegram' ? { ok: true, live: { adapter: adapter }, proven: true } : { ok: false, live: null, error: channel + ' is not connected right now (error)' };
  const channelRegistry = { get: (id) => ({ telegram: { label: 'Telegram', maxMessageLength: 220 }, discord: { label: 'Discord', maxMessageLength: 2000 } })[id] || null };
  const scrubOutbound = (t) => String(t).split('/ws/agents/').join('[workspace]/');
  const redact = (t) => String(t).replace(/sk-[A-Za-z0-9]{8,}/g, '[redacted]');
  const io = makeMemoryTranscriptIo(), append = io.appendDurable.bind(io);
  io.append = io.appendDurable = row => {
    const stored = append(row); env.store.push({ file: 'transcript:' + stored.streamId, data: clone(stored) }); return stored;
  };
  const canonical = CanonicalHistory.make(channelStore, { io, now: () => env.now, redact });
  // the lane sends a routine's words through the channel's ATTACHED sender: the station hub's own send, as in production
  const hub = channelStore.ledger && env.hub({ history: canonical.history, runOnce: env.says('unused'), send: (c, t, o) => adapter.send(c, t, o), maxMessageLength: 220 });
  const Outbound = fs.existsSync(OUTBOUND) ? require(OUTBOUND) : null;
  const channelOutbound = (Outbound && channelStore.ledger) ? Outbound.makeChannelOutbound({
    ledger: channelStore.ledger, registry: channelRegistry, reach: channelReach, chatRecord: (k) => channelStore.getChatRecord(k),
    liveChannelFor: (c) => (c === 'telegram' ? { adapter: adapter } : null), scrub: scrubOutbound, redact: redact, emit: env.emit
  }) : null;
  const deps = {
    now: () => env.now,
    setTimeout: (fn, ms) => { env.transport.push({ op: 'wait', ms: ms }); fn(); return 0; },
    channelStore: channelStore, channelOutbound: channelOutbound, channelReach: channelReach, channelRegistry: channelRegistry,
    history: canonical.history, historyContext: (channel, chatId) => {
      if (channel === 'telegram') return hub.historyContext(chatId);
      if (channel === 'discord') return canonical.history.context({ store: channelStore, channel, chatId, legacyKey: HistoryPort.keyFor(chatId, 'dc_') });
      return null;
    },
    scrubOutbound: scrubOutbound, redact: redact,
    runStore: { list: () => [] },
    egressReader: { fireReader: () => read, shownName: (paths, p) => String(p), pathsFor: () => ({}) },
    readChannelUpload: read,
    transcriptStore: Object.assign({}, canonical.transcript, {
      view: (name, ...args) => { A.eq(name, 'proof', 'routine delivery checks canonical proof'); return canonical.transcript.view(name, ...args); }
    }),
    stationBridge: { request: (name, payload) => { env.transport.push({ op: 'station', name: name, payload: clone(payload) }); return Promise.resolve({ ok: true, delivered: true }); } }
  };
  const { deliverCronResult } = routineDelivery(deps);
  const deliver = async (job, result) => {
    const r = await deliverCronResult(job, result);
    env.transport.push({ op: 'result', job: job.id, value: clone(r) });
    await env.drain();
  };
  const digest = ['Overnight, three things moved.', '', '1. The vendor shipped the patch; the notes are saved to /ws/agents/nova/notes/patch.md for review.',
    '2. The key sk-ABCDEFGH12345678 was rotated, and the old one no longer works anywhere on the station.',
    '3. Traffic held steady through the night, with one short spike just after three in the morning.', '',
    'ATTACH: charts/today.png', 'ATTACH: private/key.pem', 'MEDIA: N/A'].join('\n');
  const digestJob = { id: 'job-digest', name: 'Morning digest', agentId: 'nova', deliver: 'targets:4242,99', attachToSession: true, prompt: 'Summarize the overnight news' };
  await deliver(digestJob, { outcome: 'ok', runId: 'cron-run-1', text: digest, superseded: 2 });
  env.at(T0 + 60000);
  await deliver(digestJob, { outcome: 'ok', runId: 'cron-run-1', text: digest, superseded: 2, deliveredTargets: ['4242'] });   // the cron retry: the started target is its record's (its lane is backing off)
  await env.fireTimers();   // the lane's retry: the refused part 3, then the file, then the missed-file note
  env.at(T0 + 180000);
  await deliver(digestJob, { outcome: 'ok', runId: 'cron-run-1', text: digest, superseded: 2, deliveredTargets: ['4242'] });   // the cron asks again: answered from the record, nothing is sent
  await deliver({ id: 'job-watch', name: 'Site watch', agentId: 'nova', deliver: 'origin', origin: { channel: 'telegram', chatId: '4242', threadId: '78' } },
    { outcome: 'failed', runId: 'cron-run-2', error: 'The fetch timed out.' });
  await deliver({ id: 'job-session', name: 'Session recap', agentId: 'nova', deliver: 'local', attachToSession: true, prompt: 'Recap the plan', origin: { sessionId: 'sess-1', streamId: 'stream-1', sessionTitle: 'Planning' } },
    { outcome: 'ok', runId: 'cron-run-3', text: 'Recap done.' });
  await deliver({ id: 'job-script', name: 'Disk check', agentId: 'nova', noAgent: true, deliver: 'origin', prompt: 'df -h', origin: { channel: 'telegram', chatId: '4242' } },
    { outcome: 'ok', runId: 'cron-run-4', text: 'disk 40% used' });
  await deliver({ id: 'job-quiet', name: 'Quiet', agentId: 'nova', deliver: 'origin', origin: { channel: 'telegram', chatId: '4242' } }, { outcome: 'silent', runId: 'cron-run-5' });
  await deliver({ id: 'job-all', name: 'Fan-out', agentId: 'nova', deliver: 'all' }, { outcome: 'ok', runId: 'cron-run-6', text: 'to everyone' });
});

/* ---------------------------------------------------------------- run, record, compare ------------------------------- */
// The fixture is written one trace entry per line, so a re-record's diff reads entry by entry.
function serialize(fix) {
  const block = (traces) => '{\n' + Object.keys(traces).map(name => '  ' + JSON.stringify(name) + ': [\n'
    + traces[name].map(e => '   ' + JSON.stringify(e)).join(',\n') + '\n  ]').join(',\n') + '\n }';
  return '{\n "version": 1,\n "transport": ' + block(fix.transport) + ',\n "store": ' + block(fix.store) + '\n}\n';
}

function firstDiff(got, want) {
  const n = Math.max(got.length, want.length);
  for (let i = 0; i < n; i++) {
    const g = JSON.stringify(got[i]), w = JSON.stringify(want[i]);
    if (g !== w) return 'entry ' + i + ' of ' + n + '\n      want ' + String(w).slice(0, 600) + '\n      got  ' + String(g).slice(0, 600);
  }
  return '';
}

(async () => {
  const live = { transport: {}, store: {} };
  for (const s of SCENARIOS) {
    const env = makeEnv();
    await s.fn(env);
    await env.drain();
    for (const h of env.hubs) h.close();
    live.transport[s.name] = env.transport;
    live.store[s.name] = env.store;
  }

  if (TRACE_OUT) fs.writeFileSync(TRACE_OUT, serialize(live));
  if (UPDATE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, serialize(live));
    console.log('channels delivery golden re-recorded: ' + FIXTURE + ' (' + SCENARIOS.length + ' scenarios)');
    process.exit(0);
  }
  if (UPDATE_ROUTINE) {
    const prior = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    for (const kind of ['transport', 'store']) {
      for (const s of SCENARIOS) if (s.name !== 'routine' && JSON.stringify(live[kind][s.name]) !== JSON.stringify(prior[kind][s.name])) {
        throw new Error('Routine-only golden update refused unrelated ' + kind + ' drift: ' + s.name);
      }
      prior[kind].routine = live[kind].routine;
    }
    fs.writeFileSync(FIXTURE, serialize(prior));
    console.log('Only the routine golden was re-recorded; all other traces were byte-identical');
  }

  A.ok(fs.existsSync(FIXTURE), 'the golden fixture exists (record it with --update)');
  const fix = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  A.eq(Object.keys(fix.transport || {}), SCENARIOS.map(s => s.name), 'the fixture records the transport trace of exactly these scenarios, in order');
  A.eq(Object.keys(fix.store || {}), SCENARIOS.map(s => s.name), 'the fixture records the store trace of exactly these scenarios, in order');
  for (const kind of ['transport', 'store']) {
    for (const s of SCENARIOS) {
      const got = live[kind][s.name], want = (fix[kind] || {})[s.name] || [];
      const same = JSON.stringify(got) === JSON.stringify(want);
      A.ok(same, s.name + ': the ' + kind + ' trace is byte-identical to the golden' + (same ? '' : ' — first difference at ' + firstDiff(got, want)));
    }
  }

  // ---- each scenario still exercises what it is named for (a re-record cannot quietly capture something else) ----
  const T = live.transport, S = live.store;
  const sends = (name) => T[name].filter(e => e.op === 'send');
  const events = (name) => T[name].filter(e => e.op === 'event').map(e => e.payload);
  A.ok(NO_FAULT.every(n => T[n].every(e => e.op !== 'event' || e.payload.ok === true)), 'the no-fault scenarios deliver every reply');
  A.ok(sends('multi-chunk').length >= 3 && sends('multi-chunk').every((e, i) => e.opts && e.opts.threadId === '77' && (i === 0) === !!e.opts.replyTo),
    'multi-chunk: every chunk lands in the topic and only the first quotes the question');
  A.eq(events('merged-batch').length, 1, 'merged-batch: two bubbles get one reply');
  const kb = sends('keyboard-last-chunk');
  A.ok(kb.length >= 2 && kb.every((e, i) => (i === kb.length - 1) === !!(e.opts && e.opts.reply_markup)), 'keyboard-last-chunk: the keyboard rides the last chunk only');
  A.ok(T['stream-seed-edit'].some(e => e.op === 'edit'), 'stream-seed-edit: chunk 0 replaces the streamed seed in place');
  const ledgerWrites = (name) => S[name].filter(w => w.file === 'delivery.json').map(w => w.data);
  A.ok(ledgerWrites('fail-queue-flush').some(d => d.deliveries.length === 1 && d.deliveries[0].tries >= 1) && events('fail-queue-flush').some(p => p.reason === 'redelivered'),
    'fail-queue-flush: the failed reply is kept in its lane, then redelivered');
  const marks = ledgerWrites('partial-chunk-progress').map(d => d.deliveries.length ? d.deliveries[0].parts.filter(x => x.sent).length : -1).filter(n => n >= 0);
  A.ok(new Set(marks).size >= 3 && sends('partial-chunk-progress').filter(e => /^Part one/.test(e.text)).length === 1, 'partial-chunk-progress: each landed part is marked, and none is ever sent again');
  A.ok(sends('fenced-remainder').some(e => /^⌛ delayed reply[\s\S]*\n```\n/.test(e.text) || /^```\n/.test(e.text)), 'fenced-remainder: the redelivered remainder reopens its code block');
  A.ok(events('undeliverable-park').some(p => p.reason === 'undeliverable') && ledgerWrites('undeliverable-park').some(d => d.tombstones.some(t => t.reason === 'undeliverable'))
    && sends('undeliverable-park').length === 1, 'undeliverable-park: a tombstone, said once, never retried');
  A.ok(ledgerWrites('auth-keep').some(d => d.deliveries.length === 1 && d.deliveries[0].tries === 1) && events('auth-keep').some(p => p.reason === 'redelivered'),
    'auth-keep: a refused credential keeps the reply for the re-paired hub, which delivers it');
  const md = ledgerWrites('membership-drop');
  A.ok(events('membership-drop').some(p => p.reason === 'redelivery-gave-up') && md.length && md[md.length - 1].tombstones.some(t => t.runId === 'run-3' && t.reason === 'redelivery-gave-up')
    && !md[md.length - 1].deliveries.some(d => d.chat === 'telegram|-100500'),
    'membership-drop: the removed chat\'s backlog is given up, said once per reply, and its in-flight reply gets one send and is given up');
  A.ok(sends('crash-replay-0-tools').some(e => /^↻ StarNet restarted/.test(e.text)), 'crash-replay-0-tools: the second go is said');
  A.ok(sends('crash-replay-n-tools').some(e => /NOT run again/.test(e.text)), 'crash-replay-n-tools: an attempt that began tool steps is not run again');
  A.eq(sends('held-reply-restart').map(e => e.text), ['The finished answer.'], 'held-reply-restart: the held answer is sent once, nothing runs');
  const bp = sends('backpressure-same-process').map(e => e.text);
  A.ok(T['backpressure-same-process'].some(e => e.op === 'note' && /resolved/.test(e.text)) && bp.filter(t => /Second answer\./.test(t)).length === 1
    && bp.findIndex(t => /Second answer\./.test(t)) > bp.findIndex(t => /First answer\./.test(t)),
    'backpressure-same-process: the second message waits (deferred, not run), then runs once the lane drains, its answer after the first');
  A.eq(sends('reconnect-claim').length, 1, 'reconnect-claim: the message runs once, in the hub that owned it');
  A.ok(!ledgerWrites('command-reply-not-queued').some(d => d.deliveries.length), 'command-reply-not-queued: a command reply is never queued');
  const routineSends = T.routine.filter(e => e.op === 'send').map(e => e.text);
  const refusedPart = routineSends.find((t, i) => routineSends.indexOf(t) !== i) || '';
  A.ok(refusedPart && T.routine.some(e => e.op === 'sendMedia') && T.routine.some(e => e.op === 'station'), 'routine: a part refused with a 429 and sent again, a file and a session hand-back are exercised');
  A.ok(routineSends.filter(t => t === refusedPart).length === 2 && routineSends.filter(t => /^✦ Morning digest/.test(t)).length === 1,
    'routine: the refused part is sent again, once, and no landed part ever is (the cron\'s later asks are answered from the record)');
  A.ok(events('routine').some(p => p.reason === 'routine' && p.channel === 'telegram') && events('routine').some(p => p.ok === false && p.channel === 'discord'),
    'routine: each delivery reports its channel.delivery, a refused channel included');
  const publicRows = S.routine.filter(entry => entry.file === 'transcript:channel_telegram_4242');
  A.eq(publicRows.map(entry => [entry.data.role, entry.data.kind]), [['assistant', 'delivery']], 'routine: exactly one canonical delivery replaces the fabricated legacy user/assistant pair');
  A.ok(publicRows[0]?.data.content.includes('[redacted]') && !publicRows[0]?.data.content.includes('sk-ABCDEFGH12345678'), 'routine: canonical publication preserves the delivered credential redaction');

  A.report('channels.delivery.golden.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
