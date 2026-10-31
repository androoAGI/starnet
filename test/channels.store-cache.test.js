/* node test/channels.store-cache.test.js — an inbound DM no longer re-reads and re-parses every channel file, and each
   mutation is ONE durable write, with the same .bak last-known-good recovery.

   The bug (perf review 10-19, channels/store.js:148): every read did readFileSync + JSON.parse of the whole file, and
   every mutation re-read the current main, re-serialized it into <file>.bak through a SECOND durable write (fsync +
   temp + rename), then wrote the main. One Telegram DM (pushInbox, chat-record reads + lastSeen save, history load,
   two appendTurn, removeInbox) cost ~20 fsyncs, 16 parses and 15 file reads (62 ms p50 here). The good main is now
   hard-linked as its .bak instead of rewritten.

   Proves through the REAL store + REAL fs + REAL writeFileDurable (the index.js wiring):
     (1) a warm DM does ZERO file reads, and every mutation is exactly one durable write (no temp is renamed onto a .bak);
         since the delivery ledger (channel-delivery-ledger S2) the DM's receipt, attempt mark, answer and part mark are
         ledger writes, and the per-DM budget is pinned at its measured seven;
     (2) the .bak still holds the previous good version after each mutation;
     (3) a file replaced behind the store's back is re-read (the stat stamp misses), and a corrupt main still
         recovers from .bak with onRecover;
     (4) mutating what a read returned never poisons the next read;
     (5) a main write that fails leaves the previous good main in place (the .bak is a link: the main never goes
         missing, nothing is lost, nothing is half-written). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');

function countingFs() {
  const c = { reads: 0, tmpToBak: 0, tmpRenames: 0, failMainWrite: null };
  c.fs = new Proxy(fs, { get(t, p) {
    if (p === 'readFileSync') return function () { c.reads++; return t.readFileSync.apply(t, arguments); };
    if (p === 'renameSync') return function (a, b) {
      if (/\.tmp$/.test(String(a))) { c.tmpRenames++; if (/\.bak$/.test(String(b))) c.tmpToBak++; }
      if (c.failMainWrite && /\.tmp$/.test(String(a)) && String(b) === c.failMainWrite) { const e = new Error('ENOSPC: simulated'); e.code = 'ENOSPC'; throw e; }
      return t.renameSync(a, b);
    };
    const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
  } });
  return c;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-chan-cache-'));
(async () => {
try {
  const c = countingFs();
  let T = 1000;
  const recovered = [];
  const store = makeChannelStore({ fs: c.fs, pathMod: path, root, clock: { now: () => ++T }, writeDurable: writeFileDurable, onRecover: (f) => recovered.push(f) });
  for (let i = 0; i < 6; i++) store.appendTurn('ultron', i % 2 ? 'assistant' : 'user', 'turn ' + i);
  store.saveChatRecord('123', { agentId: 'ultron', channel: 'telegram' });
  // the delivery ledger (channel-delivery-ledger S2) holds the receipt, the run's attempt and the reply; warm it up
  const ledger = store.ledger;
  const lane = { send: () => Promise.resolve({ ok: true, messageId: 'm1' }) };
  ledger.attach('telegram', lane);
  ledger.receive({ id: 'warm', channel: 'telegram', chatId: '123', message: { chatId: '123', text: 'warm' }, route: null });
  ledger.settle(['warm']);

  // ---- (1) one warm DM, the hub's sequence ----
  c.reads = 0; c.tmpToBak = 0; c.tmpRenames = 0;
  ledger.receive({ id: 'tg-1', channel: 'telegram', chatId: '123', message: { chatId: '123', text: 'hello' }, route: null });   // the receipt (the chat's route rides it)
  store.getChatRecord('123'); store.getChatRecord('123');
  store.saveChatRecord('123', { agentId: 'ultron', channel: 'telegram' });
  const hist = store.loadHistory('ultron');
  store.appendTurn('ultron', 'user', 'hello');
  ledger.markAttempt(['tg-1'], { runId: 'run-1' });                                               // the run starts
  store.appendTurn('ultron', 'assistant', 'hi back');
  ledger.answer(['tg-1'], { id: 'reply:run-1', channel: 'telegram', chatId: '123', parts: ['hi back'] });   // the receipt leaves as the reply enters its lane
  await ledger.drive('telegram|123');                                                               // its one part lands: the mark is the record leaving
  A.eq(c.reads, 0, 'a warm DM read no channel file from disk (was 15 reads + parses)');
  // measured: receipt, chat record, two turns, the attempt mark, the answer, the part mark. Trunk's DM was six (its
  // receipt removal is the answer here); the ledger adds ONE per reply — the part's sent mark — and one per extra part.
  A.eq(c.tmpRenames, 7, 'a one-part DM = seven durable writes (trunk six; was ten before the cache)');
  A.eq(c.tmpToBak, 0, 'no .bak was re-serialized through a second durable write');
  A.eq(hist.length, 6, 'the history read was correct');
  A.eq(JSON.parse(fs.readFileSync(path.join(root, 'delivery.json'), 'utf8')).deliveries, [], 'and the reply left the ledger with its last mark');

  // ---- (2) .bak = the previous good version ----
  const histFile = path.join(root, 'ultron.history.json');
  const main = JSON.parse(fs.readFileSync(histFile, 'utf8'));
  const bak = JSON.parse(fs.readFileSync(histFile + '.bak', 'utf8'));
  A.eq(main.messages.length, 8, 'main holds both new turns');
  A.eq(bak.messages.length, 7, '.bak holds the version before the last append');
  A.eq(bak.messages[6].content, 'hello', '.bak is exactly the previous good main');
  A.eq(store.loadHistory('ultron').map(m => m.content).slice(-2), ['hello', 'hi back'], 'the store reads back what it wrote');

  // ---- (3) an external replace is seen; a corrupt main recovers from .bak ----
  const mapFile = path.join(root, 'chatmap.json');
  const ext = { version: 1, chats: { '123': { agentId: 'cypher', channel: 'telegram' }, '999': { agentId: 'nova' } } };
  fs.writeFileSync(mapFile + '.ext', JSON.stringify(ext));
  fs.renameSync(mapFile + '.ext', mapFile);          // station recovery / a hand edit replaces the file
  A.eq(store.getChatRecord('123').agentId, 'cypher', 'a file replaced behind the store is re-read, not served stale');
  A.ok(store.getChatRecord('999'), 'and its new records are visible');
  fs.writeFileSync(histFile, '{ torn');
  const rec = store.loadHistory('ultron');
  A.eq(rec.length, 7, 'a corrupt main recovers the .bak last-known-good');
  A.ok(recovered.indexOf(histFile) >= 0, 'onRecover reports the recovery');
  fs.writeFileSync(histFile, '');
  A.eq(store.loadHistory('ultron').length, 7, 'a zero-length main recovers from .bak too');
  store.appendTurn('ultron', 'user', 'after the tear');
  A.eq(JSON.parse(fs.readFileSync(histFile + '.bak', 'utf8')).messages.length, 7, 'a torn main never clobbers the good .bak');
  A.eq(store.loadHistory('ultron').length, 8, 'the next append builds on the recovered history');

  // ---- (4) a caller mutating a returned object cannot poison the cache ----
  const r1 = store.getChatRecord('123');
  r1.agentId = 'MUTATED'; r1.hopKeys = ['x'];
  const items = ledger.snapshot().deliveries;
  items.push({ id: 'ghost', chatId: '1', text: 't' });
  A.eq(store.getChatRecord('123').agentId, 'cypher', 'a mutated record does not leak into the next read');
  A.eq(store.getChatRecord('123').hopKeys, undefined, 'nor do added fields');
  A.eq(ledger.snapshot().deliveries.length, 0, 'nor does a pushed array item (the ledger hands out a copy)');
  store.saveChatRecord('123', { streamId: undefined, model: 'm1' });
  A.ok(!('streamId' in store.getChatRecord('123')), 'a cached write reads back exactly as JSON (undefined fields absent)');

  // ---- (5) a failed main write leaves the previous good main in place ----
  const before = fs.readFileSync(mapFile, 'utf8');
  c.failMainWrite = mapFile;
  A.throws(() => store.saveChatRecord('123', { model: 'never' }), 'the failed write surfaces to the caller');
  c.failMainWrite = null;
  A.eq(fs.readFileSync(mapFile, 'utf8'), before, 'the previous good main is still in place');
  A.eq(store.getChatRecord('123').model, 'm1', 'and reads return the last committed record');
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}
A.report('channels.store-cache.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
